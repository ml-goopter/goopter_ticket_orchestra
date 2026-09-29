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
import { createRunner, type Runner } from "../src/runner/index.js";
import { claimNextTask } from "../src/scheduler/index.js";
import { WorktreeManager } from "../src/worktrees/index.js";
import { SEED_SPEC, seedWorkerRow, startTestDb, type TestDb } from "./harness.js";

/**
 * GOT.94, design.md §6.5 and §9.5: a new implementation execution claimed
 * from READY (a human retry from NEEDS_HUMAN, or a reopened cancelled task)
 * starts its working branch from the task's pushed remote branch when one
 * exists, else from the default branch, so its own later push is a
 * fast-forward. Real Postgres, a real local git remote, a real worktree
 * manager, and a scripted adapter that commits and pushes as an agent does.
 */

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const HOST = "got94-host";
const NOW = new Date("2026-09-29T10:00:00.000Z");
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

/** Exit status and stderr of a git command that may fail. */
function tryGit(cwd: string, ...args: string[]): { ok: boolean; stderr: string } {
  try {
    execFileSync("git", [...GIT_FLAGS, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stderr: "" };
  } catch (err) {
    return { ok: false, stderr: String((err as { stderr?: unknown }).stderr ?? err) };
  }
}

let testDb: TestDb;
let db: Db;
let root: string;
let remote: string;
let workerId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "got94-")));
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

/** A READY task with an approved revision whose repository is the local remote. */
async function seedReadyTask(): Promise<{ taskId: string; jiraKey: string }> {
  const n = ++seq;
  const [project] = await db
    .insert(projects)
    .values({ key: `NEB${n}`, name: `new execution ${n}`, jiraJql: `project = NEB${n}` })
    .returning({ id: projects.id });
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: `neb-repo-${n}`,
      gitUrl: remote,
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: "claude-opus-test",
      maxConcurrentWorktrees: 4,
      setupCommand: null,
    })
    .returning({ id: repositories.id });
  const jiraKey = `NEB-${n}`;
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey,
      jiraSummary: `New execution ${n}`,
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
  return { taskId: task!.id, jiraKey };
}

async function claim(): Promise<{ executionId: string; taskId: string }> {
  const claimed = await claimNextTask({ db, workerId, runtimes: ["claude"], now: new Date() });
  if (!claimed) throw new Error("claim returned nothing");
  return { executionId: claimed.executionId, taskId: claimed.taskId };
}

type Script = (req: StartRequest) => Promise<void>;

/** A runner on `manager` whose adapter runs `script` in the session's cwd. */
function makeRunner(manager: WorktreeManager, script: Script): Runner {
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
    worktrees: manager,
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

/** Commits `file` in the worktree at `cwd` and returns the new HEAD. */
async function commit(cwd: string, file: string): Promise<string> {
  await fs.writeFile(path.join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

/** What `report_pr_created` does to the execution (§8). */
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
      transition(tx, {
        entity: "task",
        id: taskId,
        trigger,
        actor: { kind: "user" },
      }),
    );
  }
}

const remoteTip = (branch: string): string =>
  git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);

/**
 * Runs a first execution of the READY task that commits and pushes
 * `first.txt` on its working branch, as an agent does before a PR.
 */
async function firstExecutionPushes(manager: WorktreeManager, taskId: string) {
  const first = await claim();
  expect(first.taskId).toBe(taskId);
  let pushed: { head: string; branch: string } | undefined;
  const runner = makeRunner(manager, async (req) => {
    const head = await commit(req.cwd, "first.txt");
    git(req.cwd, "push", "-q", "origin", "HEAD");
    pushed = { head, branch: git(req.cwd, "branch", "--show-current") };
    await completeExecution(first.executionId);
  });
  await runner.start(first);
  expect(pushed).toBeDefined();
  expect(remoteTip(pushed!.branch)).toBe(pushed!.head);
  return { first, ...pushed! };
}

interface SecondRun {
  executionId: string;
  during: { head: string; branch: string; log: string[] };
  push: { ok: boolean; stderr: string };
  head: string;
}

/** Claims the task's next execution and runs it: it commits `second.txt` and pushes. */
async function secondExecutionPushes(manager: WorktreeManager): Promise<SecondRun> {
  const next = await claim();
  let result: Omit<SecondRun, "executionId"> | undefined;
  const runner = makeRunner(manager, async (req) => {
    const during = {
      head: git(req.cwd, "rev-parse", "HEAD"),
      branch: git(req.cwd, "branch", "--show-current"),
      log: git(req.cwd, "log", "--format=%s").split("\n"),
    };
    const head = await commit(req.cwd, "second.txt");
    // Plain push, as the agent does: never forced (§9.2).
    const push = tryGit(req.cwd, "push", "-q", "origin", "HEAD");
    result = { during, push, head };
    await completeExecution(next.executionId);
  });
  await runner.start(next);
  expect(result).toBeDefined();
  return { executionId: next.executionId, ...result! };
}

describe("new implementation execution start point (GOT.94, §6.5, §9.5)", () => {
  it("human retry from NEEDS_HUMAN starts from the pushed task branch, keeps its commits, and pushes fast-forward", async () => {
    const manager = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const { taskId } = await seedReadyTask();
    const first = await firstExecutionPushes(manager, taskId);
    // The PR is closed unmerged, or a limit is hit: NEEDS_HUMAN, then the
    // user retries (§5.1, §12.2 POST /tasks/:id/retry).
    await moveTask(taskId, "task.escalated", "human.retry");

    const second = await secondExecutionPushes(manager);

    expect(second.executionId).not.toBe(first.first.executionId);
    expect(second.push).toEqual({ ok: true, stderr: "" });
    expect(second.during.head).toBe(first.head);
    expect(second.during.branch).toBe(first.branch);
    expect(second.during.log).toContain("first.txt");
    expect(remoteTip(first.branch)).toBe(second.head);
    expect(git(remote, "rev-parse", `${second.head}^`)).toBe(first.head);
  });

  it("a reopened cancelled task on another host starts from the pushed task branch and pushes fast-forward", async () => {
    const firstHost = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const { taskId } = await seedReadyTask();
    const first = await firstExecutionPushes(firstHost, taskId);
    // Cancelled, then reopened with its approved spec and promoted (§5.1,
    // §6.2): a new READY execution with no retry_of.
    await moveTask(taskId, "task.cancelled", "task.reopened.spec_approved", "dependency.satisfied");

    // A worker with its own workspace: no bare clone, no local branch.
    const otherHost = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const second = await secondExecutionPushes(otherHost);

    expect(second.during.head).toBe(first.head);
    expect(second.during.branch).toBe(first.branch);
    expect(second.during.log).toContain("first.txt");
    expect(second.push).toEqual({ ok: true, stderr: "" });
    expect(remoteTip(first.branch)).toBe(second.head);
    expect(git(remote, "rev-parse", `${second.head}^`)).toBe(first.head);
  });

  it("with no remote task branch, starts from the default branch untracked, as a first start does", async () => {
    const manager = new WorktreeManager({ workspaceRoot: path.join(root, `ws-${++seq}`) });
    const { taskId, jiraKey } = await seedReadyTask();
    const mainTip = git(remote, "rev-parse", "refs/heads/main");

    const run = await secondExecutionPushes(manager);

    expect(run.during.head).toBe(mainTip);
    expect(run.during.branch).toBe(`agent/${jiraKey}-${taskId.slice(0, 8)}`);
    const row = await db.query.executions.findFirst({
      where: (e, { eq }) => eq(e.id, run.executionId),
    });
    const upstream = tryGit(row!.worktreePath!, "rev-parse", "--abbrev-ref", "@{upstream}");
    expect(upstream.ok).toBe(false);
    expect(run.push).toEqual({ ok: true, stderr: "" });
    expect(remoteTip(run.during.branch)).toBe(run.head);
  });
});
