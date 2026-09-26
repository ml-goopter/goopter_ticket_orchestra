import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionState, TaskState } from "@orchestra/core";
import {
  executionEvents,
  executions,
  lockTaskForTool,
  projects,
  repositories,
  tasks,
  transition,
  type Db,
} from "@orchestra/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  WORKTREE_SWEEPER_EVERY_TICKS,
  createDefaultPhases,
} from "../src/phases/index.js";
import {
  createWorktreeSweeperPhase,
  type WorktreeOps,
  type WorktreeSweeperOptions,
} from "../src/sweeper/index.js";
import type { TickContext } from "../src/tick.js";
import {
  WorktreeManager,
  workingBranchName,
} from "../src/worktrees/manager.js";
import * as runModule from "../src/worktrees/run.js";
import { sleep, startTestDb, type TestDb } from "./harness.js";

/**
 * design.md §6.6 worktree sweeper against a real Postgres and real git: a
 * local bare repository stands in for the remote, and each test gets a
 * fresh workspace root. The phase's `now` is the fake clock and disk usage
 * is injected, so nothing depends on the wall clock or the host's disk.
 */

const TEST_GIT_FLAGS = [
  "-c",
  "user.name=Orchestra Test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...TEST_GIT_FLAGS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const NOW = new Date("2026-09-24T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

const HOST = "sweep-host";
const OTHER_HOST = "other-host";
const REPO_NAME = "sample_repo";

let testDb: TestDb;
let db: Db;
let tmp: string;
let remote: string;
let workspaceRoot: string;
let manager: WorktreeManager;
let workspaceSeq = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  tmp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-wt-sweeper-")),
  );
  remote = path.join(tmp, "remote.git");
  const seed = path.join(tmp, "seed");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "clone", "-q", remote, seed);
  git(seed, "checkout", "-q", "-B", "main");
  await fs.writeFile(path.join(seed, "README.md"), "one");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "push", "-q", "origin", "main:main");
});

afterAll(async () => {
  await testDb?.stop();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  records.length = 0;
  await raw(
    "truncate table projects, agent_workers, audit_events restart identity cascade",
  );
  workspaceRoot = path.join(tmp, `workspace-${++workspaceSeq}`);
  manager = new WorktreeManager({ workspaceRoot });
});

// ---------------------------------------------------------------- helpers

function raw(text: string, params: unknown[] = []): Promise<unknown[]> {
  return db.$client.unsafe(text, params as never[]) as unknown as Promise<
    unknown[]
  >;
}

let seq = 0;

interface Seeded {
  taskId: string;
  executionId: string;
  branch: string;
  worktreePath: string;
}

async function seedTask(state: TaskState): Promise<{ id: string; jiraKey: string }> {
  const n = ++seq;
  const [project] = await db
    .insert(projects)
    .values({ key: `WTS${n}`, name: `wt sweep ${n}`, jiraJql: `project = WTS${n}` })
    .returning({ id: projects.id });
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: REPO_NAME,
      gitUrl: remote,
      defaultBranch: "main",
      defaultRuntime: "claude",
    })
    .returning({ id: repositories.id });
  const jiraKey = `WTS-${n}`;
  const [row] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repository!.id,
      jiraKey,
      jiraSummary: `task ${n}`,
      jiraPriority: 3,
      jiraCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
      jiraSyncedAt: NOW,
      state,
    })
    .returning({ id: tasks.id });
  return { id: row!.id, jiraKey };
}

async function insertExecution(options: {
  taskId: string;
  state: ExecutionState;
  host?: string | null;
  startedAt?: Date;
  endedAt?: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(executions)
    .values({
      taskId: options.taskId,
      role: "implementation",
      attempt: 1,
      state: options.state,
      runtime: "claude",
      model: "claude-opus",
      host: options.host === undefined ? HOST : options.host,
      startedAt: options.startedAt ?? at(-30 * DAY),
      endedAt: options.endedAt ?? null,
      createdAt: at(-30 * DAY),
    })
    .returning({ id: executions.id });
  return row!.id;
}

/**
 * A task in `taskState` with one execution in `state` whose worktree was
 * really prepared under this test's workspace root.
 */
async function seedWithWorktree(options: {
  taskState: TaskState;
  state: ExecutionState;
  host?: string | null;
  startedAt?: Date;
  endedAt?: Date | null;
  /** Newest `execution_events.created_at` for the execution. */
  lastEventAt?: Date;
}): Promise<Seeded> {
  const task = await seedTask(options.taskState);
  const executionId = await insertExecution({ ...options, taskId: task.id });
  const prepared = await manager.prepareImplementation({
    executionId,
    repository: {
      name: REPO_NAME,
      gitUrl: remote,
      defaultBranch: "main",
      setupCommand: null,
    },
    task: { id: task.id, jiraKey: task.jiraKey, jiraSummary: "summary" },
    spec: {
      version: 1,
      content: {
        repository: REPO_NAME,
        objective: "o",
        scope: ["a"],
        out_of_scope: ["b"],
        requirements: ["c"],
        acceptance_criteria: ["d"],
        validation: ["e"],
        constraints: ["f"],
        dependencies: [],
      },
    },
    decisions: [],
    runtime: "claude",
  });
  await raw(
    "update executions set worktree_path = $1, branch = $2 where id = $3",
    [prepared.worktreePath, prepared.branch, executionId],
  );
  if (options.lastEventAt) {
    await db.insert(executionEvents).values({
      taskId: task.id,
      executionId,
      type: "execution.waiting",
      payload: {},
      createdAt: options.lastEventAt,
    });
  }
  expect(prepared.branch).toBe(workingBranchName(task.jiraKey, task.id));
  return {
    taskId: task.id,
    executionId,
    branch: prepared.branch!,
    worktreePath: prepared.worktreePath,
  };
}

function commitIn(worktreePath: string, file: string): string {
  execFileSync("sh", ["-c", `printf x > "$1"`, "sh", file], { cwd: worktreePath });
  git(worktreePath, "add", file);
  git(worktreePath, "commit", "-q", "-m", `commit ${file}`);
  return git(worktreePath, "rev-parse", "HEAD");
}

const bareClone = (): string => path.join(workspaceRoot, "repos", `${REPO_NAME}.git`);
const localBranchExists = (branch: string): boolean =>
  gitOk(bareClone(), "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
const remoteTip = (branch: string): string | null =>
  gitOk(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)
    ? git(remote, "rev-parse", `refs/heads/${branch}`)
    : null;

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const evictedEvents = (executionId: string) =>
  db.query.executionEvents.findMany({
    where: (t, { and, eq }) =>
      and(eq(t.executionId, executionId), eq(t.type, "worktree.evicted")),
  });

/** Worktree was removed by rule one or two (C7). */
async function expectRemoved(s: Seeded): Promise<void> {
  expect(existsSync(s.worktreePath)).toBe(false);
  expect(localBranchExists(s.branch)).toBe(false);
  const row = await execution(s.executionId);
  expect(row.worktreePath).toBeNull();
  expect(row.branch).toBe(s.branch);
  expect(row.worktreeEvictedAt).toBeNull();
  expect(await evictedEvents(s.executionId)).toEqual([]);
}

/** Worktree, local branch and row are exactly as seeded. */
async function expectUntouched(s: Seeded): Promise<void> {
  expect(existsSync(s.worktreePath)).toBe(true);
  expect(localBranchExists(s.branch)).toBe(true);
  const row = await execution(s.executionId);
  expect(row.worktreePath).toBe(s.worktreePath);
  expect(row.worktreeEvictedAt).toBeNull();
  expect(await evictedEvents(s.executionId)).toEqual([]);
}

/** Worktree was evicted by rule three. */
async function expectEvicted(s: Seeded, pushed: boolean): Promise<void> {
  expect(existsSync(s.worktreePath)).toBe(false);
  expect(localBranchExists(s.branch)).toBe(false);
  const row = await execution(s.executionId);
  expect(row.worktreeEvictedAt).toEqual(NOW);
  expect(row.worktreePath).toBe(s.worktreePath);
  expect(row.branch).toBe(s.branch);
  const events = await evictedEvents(s.executionId);
  expect(events).toHaveLength(1);
  expect(events[0]!.taskId).toBe(s.taskId);
  expect(events[0]!.payload).toEqual({
    execution_id: s.executionId,
    branch: s.branch,
    pushed,
  });
}

/**
 * Wraps the real manager, recording every removal in order and letting a
 * test fail one or react to it. Removals are recorded by the worktree's
 * directory name, which is the id of the execution that created it (C33:
 * the sweeper passes the recorded `worktree_path`).
 */
function recordingOps(
  hooks: {
    onRemove?: (executionId: string) => void;
    /** Runs before the real push; may block or throw. */
    onPush?: (branch: string) => Promise<void>;
    /** Runs after the real push returns. */
    afterPush?: (branch: string) => Promise<void>;
  } = {},
  target: WorktreeManager = manager,
): WorktreeOps & { removed: string[]; pushes: string[] } {
  const removed: string[] = [];
  const pushes: string[] = [];
  return {
    removed,
    pushes,
    withRepositoryLock(repositoryName, fn) {
      return target.withRepositoryLock(repositoryName, (repo) =>
        fn({
          async remove(worktreePath, options) {
            const executionId = path.basename(worktreePath);
            hooks.onRemove?.(executionId);
            const result = await repo.remove(worktreePath, options);
            if (result.tipMoved !== true) removed.push(executionId);
            return result;
          },
        }),
      );
    },
    async pushIfAhead(input) {
      await hooks.onPush?.(input.branch);
      const result = await target.pushIfAhead(input);
      await hooks.afterPush?.(input.branch);
      if (result.pushed) pushes.push(input.branch);
      return result;
    },
  };
}

function config(highWaterPct = 85) {
  return loadConfig({
    DATABASE_URL: "postgres://localhost/unused",
    WORKER_HOST: HOST,
    WORKER_WORKSPACE_ROOT: workspaceRoot,
    WORKER_DISK_HIGH_WATER_PCT: String(highWaterPct),
  });
}

function ctx(highWaterPct = 85): TickContext {
  return {
    db,
    workerId: "w-sweeper",
    config: config(highWaterPct),
    now: NOW,
    tick: WORKTREE_SWEEPER_EVERY_TICKS,
    logger,
  };
}

/** Runs the phase with disk usage well below the high-water mark. */
async function sweep(options: WorktreeSweeperOptions = {}): Promise<void> {
  await createWorktreeSweeperPhase({
    diskUsage: async () => 10,
    ...options,
  }).run(ctx());
}

/**
 * GOT.43 C31/C33: a retry execution that took over the failed attempt's
 * worktree, so its `worktree_path` is `work/<failed id>`. The failed row's
 * path is cleared. `work/<retry id>` holds an unrelated decoy directory.
 */
async function seedReusedWorktree(options: {
  taskState: TaskState;
  state: ExecutionState;
  endedAt?: Date | null;
  lastEventAt?: Date;
}): Promise<Seeded & { failedId: string; decoy: string }> {
  const original = await seedWithWorktree({
    taskState: options.taskState,
    state: "FAILED",
    endedAt: at(-40 * DAY),
  });
  const retryId = await insertExecution({
    taskId: original.taskId,
    state: options.state,
    endedAt: options.endedAt ?? null,
  });
  await raw("update executions set worktree_path = null where id = $1", [original.executionId]);
  await raw("update executions set worktree_path = $1, branch = $2 where id = $3", [
    original.worktreePath,
    original.branch,
    retryId,
  ]);
  if (options.lastEventAt) {
    await db.insert(executionEvents).values({
      taskId: original.taskId,
      executionId: retryId,
      type: "execution.waiting",
      payload: {},
      createdAt: options.lastEventAt,
    });
  }
  const decoy = path.join(workspaceRoot, "work", retryId);
  await fs.mkdir(decoy, { recursive: true });
  await fs.writeFile(path.join(decoy, "keep.txt"), "not a worktree");
  return {
    taskId: original.taskId,
    executionId: retryId,
    branch: original.branch,
    worktreePath: original.worktreePath,
    failedId: original.executionId,
    decoy,
  };
}

// ------------------------------------------------------------------ tests

describe("recorded worktree_path (GOT.43 C33)", () => {
  it("rule one removes a retry's worktree at its recorded work/<failed id>, never work/<retry id>", async () => {
    const s = await seedReusedWorktree({
      taskState: "DONE",
      state: "COMPLETED",
      endedAt: at(-25 * HOUR),
    });
    expect(path.basename(s.worktreePath)).toBe(s.failedId);

    await sweep();

    await expectRemoved(s);
    expect(existsSync(path.join(s.decoy, "keep.txt"))).toBe(true);
    expect((await execution(s.failedId)).worktreePath).toBeNull();
  });

  it("rule three evicts a retry's worktree at its recorded work/<failed id>, never work/<retry id>", async () => {
    const s = await seedReusedWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-15 * DAY),
    });

    await sweep();

    await expectEvicted(s, false);
    expect(existsSync(path.join(s.decoy, "keep.txt"))).toBe(true);
  });
});

describe("rule one: task DONE or CANCELLED, ended over 24 h ago (§6.6)", () => {
  it("AC1: removes the worktree and local branch and clears worktree_path", async () => {
    const done = await seedWithWorktree({
      taskState: "DONE",
      state: "COMPLETED",
      endedAt: at(-25 * HOUR),
    });
    const cancelled = await seedWithWorktree({
      taskState: "CANCELLED",
      state: "CANCELLED",
      endedAt: at(-25 * HOUR),
    });

    await sweep();

    await expectRemoved(done);
    await expectRemoved(cancelled);
  });

  it("AC1: leaves one that ended 23 h ago", async () => {
    const recent = await seedWithWorktree({
      taskState: "DONE",
      state: "COMPLETED",
      endedAt: at(-23 * HOUR),
    });
    await sweep();
    await expectUntouched(recent);
  });

  it("AC1: leaves one whose worktree is on another host", async () => {
    const elsewhere = await seedWithWorktree({
      taskState: "DONE",
      state: "COMPLETED",
      host: OTHER_HOST,
      endedAt: at(-25 * HOUR),
    });
    await sweep();
    await expectUntouched(elsewhere);
  });

  it("does not select it again once worktree_path is cleared", async () => {
    const done = await seedWithWorktree({
      taskState: "DONE",
      state: "COMPLETED",
      endedAt: at(-25 * HOUR),
    });
    await sweep();
    const ops = recordingOps();
    await sweep({ worktrees: ops });
    expect(ops.removed).toEqual([]);
    await expectRemoved(done);
  });
});

describe("rule two: FAILED, no retry pending, ended over 24 h ago (§6.6, C8)", () => {
  it("AC2: removes a failed execution with no live sibling on a task that is not READY", async () => {
    const failed = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-25 * HOUR),
    });
    await sweep();
    await expectRemoved(failed);
  });

  it("AC2: leaves one whose task has a QUEUED execution", async () => {
    const failed = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-25 * HOUR),
    });
    await insertExecution({ taskId: failed.taskId, state: "QUEUED", host: null });
    await sweep();
    await expectUntouched(failed);
  });

  it("AC2: leaves one whose task is READY", async () => {
    const failed = await seedWithWorktree({
      taskState: "READY",
      state: "FAILED",
      endedAt: at(-25 * HOUR),
    });
    await sweep();
    await expectUntouched(failed);
  });

  it("leaves one that ended 23 h ago", async () => {
    const failed = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-23 * HOUR),
    });
    await sweep();
    await expectUntouched(failed);
  });

  it("F4: leaves one whose task has a WAITING_FOR_USER or an ASSIGNED execution", async () => {
    const withWaiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-25 * HOUR),
    });
    await insertExecution({ taskId: withWaiting.taskId, state: "WAITING_FOR_USER" });
    const withAssigned = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-25 * HOUR),
    });
    await insertExecution({ taskId: withAssigned.taskId, state: "ASSIGNED" });

    await sweep();

    await expectUntouched(withWaiting);
    await expectUntouched(withAssigned);
  });

  it("F1 (C13): leaves a FAILED execution of a NEEDS_HUMAN task to rule three, keeping its local commit", async () => {
    const failed = await seedWithWorktree({
      taskState: "NEEDS_HUMAN",
      state: "FAILED",
      endedAt: at(-25 * HOUR),
    });
    commitIn(failed.worktreePath, "unpushed.txt");

    await sweep();

    await expectUntouched(failed);
    expect(remoteTip(failed.branch)).toBeNull();
  });

  it("F1 (C13): pushes and evicts a FAILED execution of a NEEDS_HUMAN task idle 15 days", async () => {
    const failed = await seedWithWorktree({
      taskState: "NEEDS_HUMAN",
      state: "FAILED",
      endedAt: at(-15 * DAY),
    });
    const head = commitIn(failed.worktreePath, "unpushed.txt");

    await sweep();

    expect(remoteTip(failed.branch)).toBe(head);
    await expectEvicted(failed, true);
  });
});

describe("rule three: WAITING_FOR_USER or NEEDS_HUMAN, idle over 14 days (§6.6)", () => {
  it("AC3: pushes a branch that is ahead, removes the worktree, stamps worktree_evicted_at", async () => {
    const waiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-15 * DAY),
    });
    const head = commitIn(waiting.worktreePath, "work.txt");

    await sweep();

    expect(remoteTip(waiting.branch)).toBe(head);
    await expectEvicted(waiting, true);
  });

  it("AC3: evicts without pushing when nothing is ahead", async () => {
    const waiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-15 * DAY),
    });
    const ops = recordingOps();

    await sweep({ worktrees: ops });

    expect(ops.pushes).toEqual([]);
    expect(remoteTip(waiting.branch)).toBeNull();
    await expectEvicted(waiting, false);
  });

  it("AC3: leaves one idle 13 days, measured from its newest event", async () => {
    const waiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      startedAt: at(-20 * DAY),
      lastEventAt: at(-13 * DAY),
    });
    await sweep();
    await expectUntouched(waiting);
  });

  it("AC3: evicts a COMPLETED execution of a NEEDS_HUMAN task idle 15 days", async () => {
    const completed = await seedWithWorktree({
      taskState: "NEEDS_HUMAN",
      state: "COMPLETED",
      endedAt: at(-15 * DAY),
    });
    await sweep();
    await expectEvicted(completed, false);
  });

  it("never evicts a RUNNING execution of a NEEDS_HUMAN task", async () => {
    const running = await seedWithWorktree({
      taskState: "NEEDS_HUMAN",
      state: "RUNNING",
      startedAt: at(-20 * DAY),
    });
    await sweep();
    await expectUntouched(running);
  });

  it("keeps the worktree when the remote branch diverged, and pushes nothing", async () => {
    const waiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-15 * DAY),
    });
    commitIn(waiting.worktreePath, "first.txt");
    await manager.pushIfAhead({
      repositoryName: REPO_NAME,
      branch: waiting.branch,
      defaultBranch: "main",
    });
    commitIn(waiting.worktreePath, "local.txt");
    const other = path.join(tmp, `other-${waiting.executionId}`);
    git(tmp, "clone", "-q", "-b", waiting.branch, remote, other);
    const remoteOnly = commitIn(other, "remote.txt");
    git(other, "push", "-q", "origin", waiting.branch);

    await sweep();

    expect(remoteTip(waiting.branch)).toBe(remoteOnly);
    await expectUntouched(waiting);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ executionId: waiting.executionId }),
      }),
    );
  });
});

describe("rule four: disk usage above the high-water mark (§6.6)", () => {
  /** Two rule-three-class and two rule-two-class candidates, all young. */
  async function seedDiskCandidates() {
    const waitingOld = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-3 * DAY),
    });
    const waitingNew = await seedWithWorktree({
      taskState: "NEEDS_HUMAN",
      state: "COMPLETED",
      endedAt: at(-1 * DAY),
    });
    const failedOld = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-2 * HOUR),
    });
    const failedNew = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-1 * HOUR),
    });
    const running = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "RUNNING",
      startedAt: at(-40 * DAY),
    });
    const assigned = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "ASSIGNED",
      startedAt: at(-40 * DAY),
    });
    return { waitingOld, waitingNew, failedOld, failedNew, running, assigned };
  }

  it("AC4: evicts rule-three-class oldest first, then rule-two-class, until below the threshold", async () => {
    const s = await seedDiskCandidates();
    let usage = 95;
    const ops = recordingOps({ onRemove: () => void (usage -= 4) });

    await createWorktreeSweeperPhase({
      worktrees: ops,
      diskUsage: async () => usage,
    }).run(ctx(85));

    // 95 -> 91 -> 87 -> 83: three evictions, then below 85.
    expect(ops.removed).toEqual([
      s.waitingOld.executionId,
      s.waitingNew.executionId,
      s.failedOld.executionId,
    ]);
    await expectEvicted(s.waitingOld, false);
    await expectEvicted(s.waitingNew, false);
    await expectRemoved(s.failedOld);
    await expectUntouched(s.failedNew);
    await expectUntouched(s.running);
    await expectUntouched(s.assigned);
  });

  it("AC4: never evicts live executions, even when usage stays high", async () => {
    const s = await seedDiskCandidates();
    const ops = recordingOps();

    await createWorktreeSweeperPhase({
      worktrees: ops,
      diskUsage: async () => 99,
    }).run(ctx(85));

    expect(ops.removed).toEqual([
      s.waitingOld.executionId,
      s.waitingNew.executionId,
      s.failedOld.executionId,
      s.failedNew.executionId,
    ]);
    await expectUntouched(s.running);
    await expectUntouched(s.assigned);
  });

  it("AC4: does nothing extra when usage is below the threshold", async () => {
    const s = await seedDiskCandidates();
    const ops = recordingOps();

    await createWorktreeSweeperPhase({
      worktrees: ops,
      diskUsage: async () => 50,
    }).run(ctx(85));

    expect(ops.removed).toEqual([]);
    for (const seeded of Object.values(s)) await expectUntouched(seeded);
  });
});

describe("failure isolation (§6.6)", () => {
  it("AC5: a removal that throws is logged and the next candidate still runs", async () => {
    const first = await seedWithWorktree({
      taskState: "DONE",
      state: "COMPLETED",
      endedAt: at(-30 * HOUR),
    });
    const second = await seedWithWorktree({
      taskState: "DONE",
      state: "COMPLETED",
      endedAt: at(-25 * HOUR),
    });
    const ops = recordingOps({
      onRemove: (id) => {
        if (id === first.executionId) throw new Error("rm exploded");
      },
    });

    await sweep({ worktrees: ops });

    expect(ops.removed).toEqual([second.executionId]);
    await expectRemoved(second);
    await expectUntouched(first);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          executionId: first.executionId,
          err: "rm exploded",
        }),
      }),
    );
  });

  it("F4: a push that throws keeps the worktree and is logged", async () => {
    const waiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-15 * DAY),
    });
    commitIn(waiting.worktreePath, "work.txt");
    const ops = recordingOps({
      onPush: async () => {
        throw new Error("push exploded");
      },
    });

    await sweep({ worktrees: ops });

    expect(ops.removed).toEqual([]);
    await expectUntouched(waiting);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          executionId: waiting.executionId,
          err: "push exploded",
        }),
      }),
    );
  });

  it("F4: a disk usage probe that throws is logged and rule four is skipped", async () => {
    const failedYoung = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-1 * HOUR),
    });
    const ops = recordingOps();

    await createWorktreeSweeperPhase({
      worktrees: ops,
      diskUsage: async () => {
        throw new Error("statfs exploded");
      },
    }).run(ctx(85));

    expect(ops.removed).toEqual([]);
    await expectUntouched(failedYoung);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({ err: "statfs exploded" }),
      }),
    );
  });
});

describe("git network calls run outside the row locks (F2)", () => {
  it("a pending push holds no task or execution lock, and the re-check keeps a worktree resumed meanwhile", async () => {
    const waiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-15 * DAY),
    });
    const head = commitIn(waiting.worktreePath, "work.txt");
    let entered!: () => void;
    const inPush = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ops = recordingOps({
      onPush: async () => {
        entered();
        await gate;
      },
    });

    const sweeping = sweep({ worktrees: ops });
    await inPush;
    // A resume moves the execution while the push is still pending.
    const moved = db.transaction(async (tx) => {
      await lockTaskForTool(tx, waiting.taskId);
      await transition(tx, {
        entity: "execution",
        id: waiting.executionId,
        trigger: "execution.resumed",
        actor: { kind: "worker", id: "w-other" },
      });
    });
    const outcome = await Promise.race([
      moved.then(() => "moved" as const),
      sleep(3_000).then(() => "blocked" as const),
    ]);
    release();
    await sweeping;
    await moved;

    expect(outcome).toBe("moved");
    // The push ran; the eviction did not, because the row is now RUNNING.
    expect(remoteTip(waiting.branch)).toBe(head);
    expect(ops.removed).toEqual([]);
    await expectUntouched(waiting);
    expect((await execution(waiting.executionId)).state).toBe("RUNNING");
  });

  it("keeps the worktree when the branch tip moved after the push", async () => {
    const waiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-15 * DAY),
    });
    const pushedHead = commitIn(waiting.worktreePath, "work.txt");
    let late = "";
    const ops = recordingOps({
      afterPush: async () => {
        late = commitIn(waiting.worktreePath, "late.txt");
      },
    });

    await sweep({ worktrees: ops });

    expect(remoteTip(waiting.branch)).toBe(pushedHead);
    expect(ops.removed).toEqual([]);
    await expectUntouched(waiting);
    expect(git(waiting.worktreePath, "rev-parse", "HEAD")).toBe(late);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ executionId: waiting.executionId }),
      }),
    );
  });

  it("round 2 F2: a sweeper waiting for the repository lock holds no task lock", async () => {
    const failed = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "FAILED",
      endedAt: at(-30 * HOUR),
    });
    // A fetch that stays pending until released holds the repository lock.
    const realRunGit = runModule.runGit;
    let entered!: () => void;
    const inFetch = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi
      .spyOn(runModule, "runGit")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "fetch") {
          entered();
          await gate;
        }
        return realRunGit(cwd, args, options);
      });

    try {
      const holder = manager.pushIfAhead({
        repositoryName: REPO_NAME,
        branch: failed.branch,
        defaultBranch: "main",
      });
      await inFetch;
      const sweeping = sweep({ worktrees: manager });
      // Long enough for the sweeper to list its candidates and reach the lock.
      await sleep(500);
      const moved = db.transaction(async (tx) => {
        await lockTaskForTool(tx, failed.taskId);
        await transition(tx, {
          entity: "task",
          id: failed.taskId,
          trigger: "task.cancelled",
          actor: { kind: "user" },
        });
      });
      const outcome = await Promise.race([
        moved.then(() => "moved" as const),
        sleep(3_000).then(() => "blocked" as const),
      ]);
      release();
      await holder;
      await sweeping;
      await moved;

      expect(outcome).toBe("moved");
      expect((await db.query.tasks.findFirst({
        where: (t, { eq }) => eq(t.id, failed.taskId),
      }))!.state).toBe("CANCELLED");
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("a push that exceeds the network timeout fails with a git error and keeps the worktree", async () => {
    const waiting = await seedWithWorktree({
      taskState: "IMPLEMENTING",
      state: "WAITING_FOR_USER",
      lastEventAt: at(-15 * DAY),
    });
    commitIn(waiting.worktreePath, "work.txt");
    const hook = path.join(remote, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const slow = new WorktreeManager({ workspaceRoot, networkTimeoutMs: 500 });
    const started = Date.now();
    try {
      await sweep({ worktrees: recordingOps({}, slow) });
    } finally {
      await fs.rm(hook, { force: true });
    }

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(remoteTip(waiting.branch)).toBeNull();
    await expectUntouched(waiting);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          executionId: waiting.executionId,
          err: expect.stringMatching(/git push .*timed out/),
        }),
      }),
    );
  });
});

describe("registration (§6.6)", () => {
  it("AC7: the registry's worktree_sweeper runs every 720 ticks and sweeps", async () => {
    const done = await seedWithWorktree({
      taskState: "DONE",
      state: "COMPLETED",
      endedAt: at(-25 * HOUR),
    });
    const phase = createDefaultPhases(
      {},
      { worktrees: recordingOps(), diskUsage: async () => 10 },
    ).find((p) => p.name === "worktree_sweeper")!;

    expect(phase.every).toBe(720);
    await phase.run(ctx());

    await expectRemoved(done);
    expect(records.map((r) => r.msg)).not.toContain("phase not implemented yet");
  });
});
