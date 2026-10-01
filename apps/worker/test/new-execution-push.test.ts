import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import type { Trigger } from "@orchestra/core";
import { projects, repositories, specificationRevisions, tasks, transition, type Db } from "@orchestra/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionRegistry } from "../src/agent-tools/index.js";
import type { Logger } from "../src/logger.js";
import { createRunner, type Runner, type RunnerDeps } from "../src/runner/index.js";
import { claimNextTask } from "../src/scheduler/index.js";
import { WorktreeManager } from "../src/worktrees/index.js";
import type { PushIfAheadInput } from "../src/worktrees/manager.js";
import { SEED_SPEC, seedWorkerRow, startTestDb, type TestDb } from "./harness.js";

/**
 * GOT.95, design.md §9.5 (C27) and §12.2: a new implementation execution
 * claimed from READY (a human retry from NEEDS_HUMAN, or a reopened
 * cancelled task) pushes the task's latest earlier implementation
 * execution's local branch first when that execution ran on this host, the
 * same as an automatic retry, so its unpushed commits are not left on the
 * old worktree's detached HEAD. Real Postgres, a real local git remote, a
 * real worktree manager behind a recording wrapper, and a scripted adapter.
 */

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const HOST = "got95-host";
const OTHER_HOST = "got95-other-host";
const NOW = new Date("2026-10-01T10:00:00.000Z");
const GIT_FLAGS = [
  "-c",
  "user.name=Orchestra Test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...GIT_FLAGS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

let testDb: TestDb;
let db: Db;
let root: string;
let remote: string;
let workerId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "got95-")));
  remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, seed);
  git(seed, "checkout", "-q", "-B", "main");
  await fs.writeFile(path.join(seed, "README.md"), "one");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "push", "-q", "origin", "main:main");
});

afterAll(async () => {
  await testDb?.stop();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

const runners: Runner[] = [];

beforeEach(async () => {
  await db.$client.unsafe(
    "truncate table task_leases, projects, agent_workers, audit_events, users restart identity cascade",
  );
  workerId = await seedWorkerRow(db, { host: HOST, workspaceRoot: root });
});

afterEach(async () => {
  for (const r of runners.splice(0)) await r.shutdown(2000);
});

let seq = 0;

interface Seeded {
  taskId: string;
  repositoryName: string;
}

/** A READY task with an approved revision whose repository is the local remote. */
async function seedReadyTask(): Promise<Seeded> {
  const n = ++seq;
  const [project] = await db
    .insert(projects)
    .values({ key: `NEP${n}`, name: `new execution push ${n}`, jiraJql: `project = NEP${n}` })
    .returning({ id: projects.id });
  const repositoryName = `nep-repo-${n}`;
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: repositoryName,
      gitUrl: remote,
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: "claude-opus-test",
      maxConcurrentWorktrees: 4,
      setupCommand: null,
    })
    .returning({ id: repositories.id });
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey: `NEP-${n}`,
      jiraSummary: `New execution push ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "READY",
    })
    .returning({ id: tasks.id });
  const [revision] = await db
    .insert(specificationRevisions)
    .values({ taskId: task!.id, version: 2, status: "approved", content: SEED_SPEC })
    .returning({ id: specificationRevisions.id });
  await db.$client.unsafe("update tasks set approved_revision_id = $1 where id = $2", [
    revision!.id,
    task!.id,
  ]);
  return { taskId: task!.id, repositoryName };
}

async function claim(): Promise<{ executionId: string; taskId: string }> {
  const claimed = await claimNextTask({ db, workerId, runtimes: ["claude"], now: new Date() });
  if (!claimed) throw new Error("claim returned nothing");
  return { executionId: claimed.executionId, taskId: claimed.taskId };
}

/**
 * Fails when another transaction holds the task row or any of its execution
 * rows: the worktree manager must never run inside a row-locking
 * transaction (docs/build-order.md lock order).
 */
async function assertRowsUnlocked(taskId: string): Promise<void> {
  await db.$client.begin(async (sql) => {
    await sql`select id from tasks where id = ${taskId} for update nowait`;
    await sql`select id from executions where task_id = ${taskId} for update nowait`;
  });
}

interface Recording {
  worktrees: RunnerDeps["worktrees"];
  calls: string[];
  pushed: PushIfAheadInput[];
}

/** Delegates to `manager` and records the prepare and push calls in order. */
function recording(manager: WorktreeManager, taskId: string, failPush = false): Recording {
  const calls: string[] = [];
  const pushed: PushIfAheadInput[] = [];
  return {
    calls,
    pushed,
    worktrees: {
      async prepareImplementation(input) {
        calls.push("prepareImplementation");
        return manager.prepareImplementation(input);
      },
      prepareSpec: (input) => manager.prepareSpec(input),
      remove: (worktreePath, options) => manager.remove(worktreePath, options),
      async pushIfAhead(input) {
        calls.push("pushIfAhead");
        pushed.push(input);
        await assertRowsUnlocked(taskId);
        if (failPush) throw new Error("remote unreachable");
        return manager.pushIfAhead(input);
      },
    },
  };
}

type Script = (req: StartRequest) => Promise<void>;

function makeRunner(worktrees: RunnerDeps["worktrees"], script: Script): Runner {
  const adapter: AgentAdapter = {
    runtime: "claude",
    start(req: StartRequest): AsyncIterable<AgentEvent> {
      return (async function* () {
        yield { type: "session", sessionId: `sess-${path.basename(req.cwd)}` } as AgentEvent;
        await script(req);
        yield { type: "turn_done", finalText: "done" } as AgentEvent;
      })();
    },
    resume(_req: ResumeRequest): AsyncIterable<AgentEvent> {
      throw new Error("not used");
    },
    canResume: async () => false,
  };
  const runner = createRunner({
    db,
    registry: createExecutionRegistry(),
    logger,
    workerId,
    host: HOST,
    worktrees,
    adapters: { claude: adapter },
    pricing: {},
    toolsUrl: () => "http://127.0.0.1:4999/mcp",
    quietTimeoutMs: 10_000,
    basePath: "/usr/bin:/bin",
    timings: { leaseRenewMs: 100, blockingGraceMs: 400, blockingPollMs: 50 },
  });
  runners.push(runner);
  return runner;
}

async function commit(cwd: string, file: string): Promise<string> {
  await fs.writeFile(path.join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

async function completeExecution(executionId: string): Promise<void> {
  await db.transaction((tx) =>
    transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.completed",
      actor: { kind: "agent", id: executionId },
      set: { endedAt: new Date() },
    }),
  );
}

async function moveTask(taskId: string, ...triggers: Trigger[]): Promise<void> {
  for (const trigger of triggers) {
    await db.transaction((tx) =>
      transition(tx, { entity: "task", id: taskId, trigger, actor: { kind: "user" } }),
    );
  }
}

const remoteTip = (branch: string): string =>
  git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);

interface FirstRun {
  executionId: string;
  branch: string;
  pushedHead: string;
  unpushedHead: string;
}

/**
 * Runs the task's first execution: it commits and pushes `first.txt`, then
 * commits `unpushed.txt` and ends without pushing it.
 */
async function firstExecutionLeavesUnpushed(manager: WorktreeManager, taskId: string): Promise<FirstRun> {
  const first = await claim();
  expect(first.taskId).toBe(taskId);
  let result: Omit<FirstRun, "executionId"> | undefined;
  const runner = makeRunner(manager, async (req) => {
    const pushedHead = await commit(req.cwd, "first.txt");
    git(req.cwd, "push", "-q", "origin", "HEAD");
    const unpushedHead = await commit(req.cwd, "unpushed.txt");
    result = { branch: git(req.cwd, "branch", "--show-current"), pushedHead, unpushedHead };
    await completeExecution(first.executionId);
  });
  await runner.start(first);
  expect(result).toBeDefined();
  expect(remoteTip(result!.branch)).toBe(result!.pushedHead);
  return { executionId: first.executionId, ...result! };
}

interface NextRun {
  executionId: string;
  head: string;
  remoteTipAtStart: string;
}

/** Claims the task's next execution and runs it on `worktrees`, recording where it started. */
async function nextExecution(worktrees: RunnerDeps["worktrees"], branch: string | null): Promise<NextRun> {
  const next = await claim();
  let seen: Omit<NextRun, "executionId"> | undefined;
  const runner = makeRunner(worktrees, async (req) => {
    seen = {
      head: git(req.cwd, "rev-parse", "HEAD"),
      remoteTipAtStart: branch ? remoteTip(branch) : "",
    };
    await completeExecution(next.executionId);
  });
  await runner.start(next);
  expect(seen).toBeDefined();
  return { executionId: next.executionId, ...seen! };
}

describe("new implementation execution pushes the earlier branch first (GOT.95, C27)", () => {
  it("human retry from NEEDS_HUMAN pushes the earlier execution's unpushed commit before preparing", async () => {
    const manager = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const s = await seedReadyTask();
    const first = await firstExecutionLeavesUnpushed(manager, s.taskId);
    await moveTask(s.taskId, "task.escalated", "human.retry");

    const rec = recording(manager, s.taskId);
    const second = await nextExecution(rec.worktrees, first.branch);

    expect(rec.calls).toEqual(["pushIfAhead", "prepareImplementation"]);
    expect(rec.pushed).toEqual([
      { repositoryName: s.repositoryName, branch: first.branch, defaultBranch: "main" },
    ]);
    expect(second.remoteTipAtStart).toBe(first.unpushedHead);
    expect(second.head).toBe(first.unpushedHead);
  });

  it("reopen from CANCELLED pushes the earlier execution's unpushed commit before preparing", async () => {
    const manager = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const s = await seedReadyTask();
    const first = await firstExecutionLeavesUnpushed(manager, s.taskId);
    await moveTask(s.taskId, "task.cancelled", "task.reopened.spec_approved", "dependency.satisfied");

    const rec = recording(manager, s.taskId);
    const second = await nextExecution(rec.worktrees, first.branch);

    expect(rec.calls).toEqual(["pushIfAhead", "prepareImplementation"]);
    expect(rec.pushed).toEqual([
      { repositoryName: s.repositoryName, branch: first.branch, defaultBranch: "main" },
    ]);
    expect(second.remoteTipAtStart).toBe(first.unpushedHead);
    expect(second.head).toBe(first.unpushedHead);
  });

  it("a push failure is logged and the new execution still prepares and runs", async () => {
    const manager = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const s = await seedReadyTask();
    const first = await firstExecutionLeavesUnpushed(manager, s.taskId);
    await moveTask(s.taskId, "task.escalated", "human.retry");

    const rec = recording(manager, s.taskId, true);
    const second = await nextExecution(rec.worktrees, first.branch);

    expect(rec.calls).toEqual(["pushIfAhead", "prepareImplementation"]);
    expect(second.remoteTipAtStart).toBe(first.pushedHead);
    expect(second.head).toBe(first.pushedHead);
  });

  it.each([
    ["another host", OTHER_HOST],
    ["no host (released from a dead host)", null],
  ])("does not push when the earlier execution ran on %s", async (_label, earlierHost) => {
    const manager = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const s = await seedReadyTask();
    const first = await firstExecutionLeavesUnpushed(manager, s.taskId);
    await db.$client.unsafe("update executions set host = $1 where id = $2", [
      earlierHost,
      first.executionId,
    ]);
    await moveTask(s.taskId, "task.escalated", "human.retry");

    const rec = recording(manager, s.taskId);
    const second = await nextExecution(rec.worktrees, first.branch);

    expect(rec.calls).toEqual(["prepareImplementation"]);
    expect(remoteTip(first.branch)).toBe(first.pushedHead);
    expect(second.head).toBe(first.pushedHead);
  });

  it("does not push when the earlier execution has no branch", async () => {
    const manager = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const s = await seedReadyTask();
    const first = await firstExecutionLeavesUnpushed(manager, s.taskId);
    await db.$client.unsafe("update executions set branch = null where id = $1", [first.executionId]);
    await moveTask(s.taskId, "task.escalated", "human.retry");

    const rec = recording(manager, s.taskId);
    await nextExecution(rec.worktrees, first.branch);

    expect(rec.calls).toEqual(["prepareImplementation"]);
    expect(remoteTip(first.branch)).toBe(first.pushedHead);
  });

  it("does not push on a task's first implementation execution, even with an earlier spec execution here", async () => {
    const manager = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const s = await seedReadyTask();
    await db.$client.unsafe(
      `insert into executions (task_id, role, attempt, state, runtime, model, host, branch)
       values ($1, 'spec', 1, 'COMPLETED', 'claude', 'claude-opus-test', $2, 'spec/some-branch')`,
      [s.taskId, HOST],
    );

    const rec = recording(manager, s.taskId);
    await nextExecution(rec.worktrees, null);

    expect(rec.calls).toEqual(["prepareImplementation"]);
  });
});
