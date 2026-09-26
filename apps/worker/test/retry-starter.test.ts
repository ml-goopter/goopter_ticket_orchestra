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
import type { EndReason, TaskState } from "@orchestra/core";
import {
  executionUsage,
  lockExecutionForTool,
  lockTaskForTool,
  taskLeases,
  transition,
  type Db,
} from "@orchestra/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createExecutionRegistry } from "../src/agent-tools/index.js";
import { LEASE_TTL_MS } from "../src/agent-tools/lease.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  PROTOCOL_VIOLATION_DETAIL,
  claimNextRetry,
  createRunner,
  runFailurePolicy,
  runRetryStarter,
  startRetryStarter,
  type Runner,
  type StartOptions,
} from "../src/runner/index.js";
import type { ClaimedExecution } from "../src/scheduler/index.js";
import { sweepWorktrees, type WorktreeOps } from "../src/sweeper/index.js";
import type { PrepareImplementationInput } from "../src/worktrees/index.js";
import type { PushIfAheadInput } from "../src/worktrees/manager.js";
import {
  seedExecutionRow,
  seedTaskRow,
  seedWorkerRow,
  startTestDb,
  waitFor,
  type TestDb,
} from "./harness.js";

/**
 * design.md §9.5 retry starter (C25, C27): QUEUED retries with no host are
 * taken after their backoff by a worker with a free slot, pinned to it, and
 * resumed or started fresh by the runner. Real Postgres, fake adapter,
 * fake worktree manager, fake clock.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "retry-host-a";
const OTHER_HOST = "retry-host-b";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const SECOND = 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

let testDb: TestDb;
let db: Db;
let workRoot: string;
let runner: Runner | undefined;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "got43-starter-"));
});

afterAll(async () => {
  await testDb?.stop();
  await fs.rm(workRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  records.length = 0;
  await db.$client.unsafe(
    "truncate table projects, agent_workers, audit_events, users restart identity cascade",
  );
});

afterEach(async () => {
  await runner?.shutdown(2000);
  runner = undefined;
});

// ------------------------------------------------------------------ reads

const raw = <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  db.$client.unsafe(text, params as never[]) as unknown as Promise<T[]>;
const executionRow = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const leaseOf = async (taskId: string) =>
  db.query.taskLeases.findFirst({ where: (l, { eq }) => eq(l.taskId, taskId) });
const eventTypes = async (executionId: string) =>
  (
    await db.query.executionEvents.findMany({
      where: (e, { eq }) => eq(e.executionId, executionId),
      orderBy: (e, { asc }) => [asc(e.id)],
    })
  ).map((e) => e.type);

// ---------------------------------------------------------------- seeding

interface Seeded {
  taskId: string;
  jiraKey: string;
  repositoryName: string;
  failedId: string;
  retryId: string;
  workerId: string;
  previousWorktree: string;
  branch: string;
}

/**
 * A task with a failed attempt 1 on `previousHost` and the retry the
 * policy queued for it at NOW.
 */
async function seedRetry(
  options: {
    previousHost?: string;
    endReason?: EndReason;
    endDetail?: string;
    taskState?: TaskState;
    maxConcurrent?: number;
    requiredCapability?: string | null;
    createWorktree?: boolean;
  } = {},
): Promise<Seeded> {
  const previousHost = options.previousHost ?? HOST;
  const workerId = await seedWorkerRow(db, {
    host: HOST,
    maxConcurrent: options.maxConcurrent ?? 2,
    workspaceRoot: workRoot,
  });
  const previousWorker = await seedWorkerRow(db, { host: previousHost, workspaceRoot: workRoot });
  // IMPLEMENTING while the policy runs; `taskState` is applied afterwards.
  const t = await seedTaskRow(db, {
    taskState: "IMPLEMENTING",
    requiredCapability: options.requiredCapability ?? null,
  });
  const branch = `agent/${t.jiraKey}-abcdef12`;
  const failedPlaceholder = await seedExecutionRow(db, {
    taskId: t.taskId,
    state: "RUNNING",
    attempt: 1,
    specRevisionId: t.revisionId,
    workerId: previousWorker,
    host: previousHost,
    sessionId: "sess-prev",
    branch,
  });
  const previousWorktree = path.join(workRoot, "work", failedPlaceholder);
  await raw("update executions set worktree_path = $1 where id = $2", [
    previousWorktree,
    failedPlaceholder,
  ]);
  if (options.createWorktree !== false) {
    await fs.mkdir(previousWorktree, { recursive: true });
  }
  const endReason = options.endReason ?? "process_crash";
  const endDetail =
    options.endDetail ??
    (endReason === "protocol_violation" ? PROTOCOL_VIOLATION_DETAIL : "spawn failed");
  const actor = { kind: "worker" as const, id: previousWorker };
  const outcome = await db.transaction(async (tx) => {
    await lockTaskForTool(tx, t.taskId);
    await lockExecutionForTool(tx, failedPlaceholder);
    await transition(tx, {
      entity: "execution",
      id: failedPlaceholder,
      trigger: "execution.failed",
      actor,
      set: { endReason, endDetail, endedAt: NOW },
    });
    return runFailurePolicy(tx, {
      executionId: failedPlaceholder,
      endReason,
      endDetail,
      actor,
      now: NOW,
    });
  });
  if (outcome.kind !== "retry") throw new Error(`expected a retry, got ${outcome.kind}`);
  if (options.taskState && options.taskState !== "IMPLEMENTING") {
    await raw("update tasks set state = $1 where id = $2", [options.taskState, t.taskId]);
  }
  return {
    taskId: t.taskId,
    jiraKey: t.jiraKey,
    repositoryName: t.repositoryName,
    failedId: failedPlaceholder,
    retryId: outcome.executionId,
    workerId,
    previousWorktree,
    branch,
  };
}

/** Occupies one slot on `host`: a RUNNING execution of another task. */
async function occupySlot(host: string): Promise<void> {
  const workerId = await seedWorkerRow(db, { host, workspaceRoot: workRoot });
  const t = await seedTaskRow(db);
  await seedExecutionRow(db, { taskId: t.taskId, state: "RUNNING", host, workerId });
}

// --------------------------------------------------------- fake runner

function spyRunner() {
  const calls: Array<{ claim: ClaimedExecution; options: StartOptions | undefined }> = [];
  return {
    calls,
    runner: {
      start: async (claim: ClaimedExecution, options?: StartOptions) => {
        calls.push({ claim, options });
      },
    },
  };
}

// ------------------------------------------------------ fake adapter

class FakeAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  canResumeResult = true;
  readonly canResumeCalls: Array<{ sessionId: string; cwd: string }> = [];
  script: (executionId: string) => AsyncGenerator<AgentEvent> = async function* () {};

  constructor(private readonly executionIdFor: () => string) {}

  start(req: StartRequest): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    return this.script(this.executionIdFor());
  }

  resume(req: ResumeRequest): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    return this.script(this.executionIdFor());
  }

  async canResume(sessionId: string, cwd: string): Promise<boolean> {
    this.canResumeCalls.push({ sessionId, cwd });
    return this.canResumeResult;
  }
}

/** What `report_pr_created` does to the execution (§8). */
async function completeViaTool(executionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.completed",
      actor: { kind: "agent", id: executionId },
      set: { endedAt: new Date() },
    });
  });
}

/**
 * Fails when another transaction holds the task or execution row: the
 * worktree manager must never run inside a row-locking transaction.
 */
async function assertRowsUnlocked(taskId: string, executionId: string): Promise<void> {
  await db.$client.begin(async (sql) => {
    await sql`select id from tasks where id = ${taskId} for update nowait`;
    await sql`select id from executions where id = ${executionId} for update nowait`;
  });
}

function makeRealRunner(s: Seeded) {
  const calls: string[] = [];
  const pushed: PushIfAheadInput[] = [];
  const prepared: PrepareImplementationInput[] = [];
  const adapter = new FakeAdapter(() => s.retryId);
  runner = createRunner({
    db,
    registry: createExecutionRegistry(),
    logger,
    workerId: s.workerId,
    host: HOST,
    worktrees: {
      async prepareImplementation(input) {
        calls.push("prepareImplementation");
        prepared.push(input);
        await assertRowsUnlocked(s.taskId, input.executionId);
        const worktreePath = path.join(workRoot, "work", input.executionId);
        await fs.mkdir(worktreePath, { recursive: true });
        return {
          worktreePath,
          branch: `agent/${input.task.jiraKey}-abcdef12`,
          startPoint: "remote_branch",
        };
      },
      prepareSpec: () => Promise.reject(new Error("not expected")),
      remove: async () => ({ branchDeleted: false }),
      async pushIfAhead(input) {
        calls.push("pushIfAhead");
        pushed.push(input);
        await assertRowsUnlocked(s.taskId, s.retryId);
        return { pushed: true, ahead: 2, tip: "abc" };
      },
    },
    adapters: { claude: adapter },
    toolsUrl: () => "http://127.0.0.1:4999/mcp",
    quietTimeoutMs: 10_000,
    timings: { leaseRenewMs: 100, blockingGraceMs: 400, blockingPollMs: 50 },
  });
  adapter.script = async function* (executionId) {
    yield { type: "session", sessionId: "sess-new" };
    await completeViaTool(executionId);
    yield { type: "turn_done", finalText: "PR opened" };
  };
  return { adapter, calls, pushed, prepared, runner };
}

const starterOptions = (
  s: { workerId: string },
  target: { start: Runner["start"] },
  now: Date,
) => ({
  db,
  runner: target,
  workerId: s.workerId,
  runtimes: ["claude"] as const,
  logger,
  now: () => now,
});

// ------------------------------------------------------------------ tests

describe("retry starter claim (C25, AC7)", () => {
  it("does nothing before not_before", async () => {
    const s = await seedRetry();
    const spy = spyRunner();

    const taken = await runRetryStarter(starterOptions(s, spy.runner, at(30 * SECOND - 1)));

    expect(taken).toEqual([]);
    expect(spy.calls).toHaveLength(0);
    const row = await executionRow(s.retryId);
    expect(row).toMatchObject({ state: "QUEUED", host: null, workerId: null });
  });

  it("after not_before, pins the row here, replaces the lease, moves it to ASSIGNED, and hands it to the runner", async () => {
    const s = await seedRetry();
    const spy = spyRunner();
    const now = at(30 * SECOND);

    const taken = await runRetryStarter(starterOptions(s, spy.runner, now));

    expect(taken.map((c) => c.executionId)).toEqual([s.retryId]);
    const row = await executionRow(s.retryId);
    expect(row).toMatchObject({ state: "ASSIGNED", host: HOST, workerId: s.workerId });
    expect(await eventTypes(s.retryId)).toEqual(["execution.queued", "execution.assigned"]);
    const lease = await leaseOf(s.taskId);
    expect(lease).toMatchObject({ executionId: s.retryId, workerId: s.workerId });
    expect(lease!.expiresAt.toISOString()).toBe(new Date(now.getTime() + LEASE_TTL_MS).toISOString());
    expect(spy.calls).toEqual([
      {
        claim: { executionId: s.retryId, taskId: s.taskId },
        options: { retry: { previousExecutionId: s.failedId } },
      },
    ]);
    // C31: the retry took over the failed attempt's worktree on this host.
    expect(row).toMatchObject({ worktreePath: s.previousWorktree, branch: s.branch });
    expect((await executionRow(s.failedId)).worktreePath).toBeNull();
  });

  it("leaves the worktree with the failed row when it is on another host, evicted, or gone", async () => {
    const remote = await seedRetry({ previousHost: OTHER_HOST, maxConcurrent: 4 });
    const gone = await seedRetry({ createWorktree: false });
    const evicted = await seedRetry();
    await raw("update executions set worktree_evicted_at = $1 where id = $2", [
      NOW.toISOString(),
      evicted.failedId,
    ]);
    const spy = spyRunner();

    const taken = await runRetryStarter(starterOptions(remote, spy.runner, at(30 * SECOND)));

    expect(taken).toHaveLength(3);
    for (const s of [remote, gone, evicted]) {
      expect((await executionRow(s.retryId)).worktreePath).toBeNull();
      expect((await executionRow(s.failedId)).worktreePath).toBe(s.previousWorktree);
    }
  });

  it("replaces a lease the failed attempt left behind", async () => {
    const s = await seedRetry();
    await db.insert(taskLeases).values({
      taskId: s.taskId,
      executionId: s.failedId,
      workerId: s.workerId,
      acquiredAt: NOW,
      expiresAt: at(-SECOND),
    });
    const spy = spyRunner();

    await runRetryStarter(starterOptions(s, spy.runner, at(30 * SECOND)));

    const leases = await raw("select id from task_leases where task_id = $1", [s.taskId]);
    expect(leases).toHaveLength(1);
    expect((await leaseOf(s.taskId))!.executionId).toBe(s.retryId);
  });

  it("passes the protocol nudge from the execution.queued payload", async () => {
    const s = await seedRetry({ endReason: "protocol_violation" });
    const spy = spyRunner();

    await runRetryStarter(starterOptions(s, spy.runner, NOW));

    expect(spy.calls[0]!.options).toEqual({
      retry: {
        previousExecutionId: s.failedId,
        nudge: { missingToolCall: "report_pr_created, report_failed, or a blocking raise_issue" },
      },
    });
  });

  it("does not start when the worker has no free slot", async () => {
    const s = await seedRetry({ maxConcurrent: 1 });
    await occupySlot(HOST);
    const spy = spyRunner();

    expect(await runRetryStarter(starterOptions(s, spy.runner, at(60 * SECOND)))).toEqual([]);
    expect(spy.calls).toHaveLength(0);
    expect((await executionRow(s.retryId)).state).toBe("QUEUED");
  });

  it("skips a task that is not IMPLEMENTING or REVIEWING, an undetected runtime, and a missing capability", async () => {
    const needsHuman = await seedRetry({ taskState: "NEEDS_HUMAN" });
    const capability = await seedRetry({ requiredCapability: "gpu" });
    const spy = spyRunner();
    const later = at(60 * SECOND);

    // NEEDS_HUMAN and the gpu repository are both skipped by a claude worker
    // with no capabilities.
    expect(await runRetryStarter(starterOptions(needsHuman, spy.runner, later))).toEqual([]);
    // A worker without claude skips everything, including the eligible row
    // once the capability is dropped.
    await raw("update repositories set required_capability = null");
    expect(
      await runRetryStarter({ ...starterOptions(capability, spy.runner, later), runtimes: ["codex"] }),
    ).toEqual([]);
    expect(spy.calls).toHaveLength(0);
    expect((await executionRow(capability.retryId)).state).toBe("QUEUED");
    expect((await executionRow(needsHuman.retryId)).state).toBe("QUEUED");
    // With claude detected, only the IMPLEMENTING task's retry is taken.
    const taken = await runRetryStarter(starterOptions(capability, spy.runner, later));
    expect(taken.map((c) => c.executionId)).toEqual([capability.retryId]);
  });

  it("takes a REVIEWING task's retry", async () => {
    const s = await seedRetry({ taskState: "REVIEWING" });
    const spy = spyRunner();
    expect(await runRetryStarter(starterOptions(s, spy.runner, at(30 * SECOND)))).toHaveLength(1);
  });

  it("two workers cannot both take the same row (SKIP LOCKED)", async () => {
    const s = await seedRetry();
    const other = await seedWorkerRow(db, { host: OTHER_HOST, maxConcurrent: 2, workspaceRoot: workRoot });
    const now = at(30 * SECOND);

    const results = await Promise.all([
      claimNextRetry({ db, workerId: s.workerId, runtimes: ["claude"], now }),
      claimNextRetry({ db, workerId: other, runtimes: ["claude"], now }),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const row = await executionRow(s.retryId);
    expect(row.state).toBe("ASSIGNED");
    expect(await eventTypes(s.retryId)).toEqual(["execution.queued", "execution.assigned"]);
  });

  it("skips a row whose task another transaction holds, without blocking", async () => {
    const s = await seedRetry();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.$client.begin(async (sql) => {
      await sql`select id from tasks where id = ${s.taskId} for update`;
      locked();
      await held;
    });
    await isLocked;

    try {
      const claimed = await claimNextRetry({
        db,
        workerId: s.workerId,
        runtimes: ["claude"],
        now: at(30 * SECOND),
      });
      expect(claimed).toBeNull();
    } finally {
      release();
      await holder;
    }
    expect((await executionRow(s.retryId)).state).toBe("QUEUED");
  });
});

describe("retry start in the runner (C25, C27, AC7, AC8)", () => {
  it("canResume on this host: resumes the failed session in its worktree with the infrastructure header", async () => {
    const s = await seedRetry();
    await db.insert(executionUsage).values({
      executionId: s.failedId,
      kind: "main",
      runtime: "claude",
      model: "claude-opus-test",
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      costUsd: "0.5",
    });
    const h = makeRealRunner(s);

    const [claim] = await runRetryStarter(starterOptions(s, h.runner, at(30 * SECOND)));
    expect(claim).toBeDefined();
    await waitFor(async () =>
      (await executionRow(s.retryId)).state === "COMPLETED" ? true : undefined,
    );

    expect(h.adapter.canResumeCalls).toEqual([{ sessionId: "sess-prev", cwd: s.previousWorktree }]);
    expect(h.adapter.starts).toHaveLength(0);
    expect(h.adapter.resumes).toHaveLength(1);
    const req = h.adapter.resumes[0]!;
    expect(req.cwd).toBe(s.previousWorktree);
    expect(req.sessionId).toBe("sess-prev");
    expect(req.prompt).toContain("## Retry after an infrastructure failure");
    expect(req.prompt).toContain("process_crash");
    expect(req.usageBaseline).toEqual({
      "claude-opus-test": { input: 10, cached: 2, output: 5, costUsd: 0.5 },
    });
    expect(h.calls).toEqual([]);

    const row = await executionRow(s.retryId);
    expect(row.worktreePath).toBe(s.previousWorktree);
    expect(row.branch).toBe(s.branch);
    expect(row.startedAt).not.toBeNull();
    const failed = await executionRow(s.failedId);
    expect(failed.worktreePath).toBeNull();

    // C31: sweeper rule two on the failed row, aged 25 h, removes nothing.
    const removed: string[] = [];
    const ops: WorktreeOps = {
      withRepositoryLock: (_name, fn) =>
        fn({
          remove: async (worktreePath) => {
            removed.push(worktreePath);
            return { branchDeleted: false };
          },
        }),
      pushIfAhead: async () => ({ pushed: false, ahead: 0, reason: "not_ahead", tip: null }),
    };
    await sweepWorktrees(
      {
        db,
        host: HOST,
        workspaceRoot: workRoot,
        diskHighWaterPct: 101,
        now: new Date(failed.endedAt!.getTime() + 25 * 60 * 60 * 1000),
        logger,
      },
      { worktrees: ops, diskUsage: async () => 0 },
    );
    expect(removed).toEqual([]);
    await expect(fs.stat(s.previousWorktree)).resolves.toBeTruthy();
    expect(await eventTypes(s.retryId)).toEqual(
      expect.arrayContaining(["execution.queued", "execution.assigned", "execution.started", "execution.completed"]),
    );
  });

  it("a protocol retry resumes with the nudge prompt", async () => {
    const s = await seedRetry({ endReason: "protocol_violation" });
    const h = makeRealRunner(s);

    await runRetryStarter(starterOptions(s, h.runner, NOW));
    await waitFor(async () => (h.adapter.resumes.length > 0 ? true : undefined));

    const prompt = h.adapter.resumes[0]!.prompt;
    expect(prompt).toContain("## Protocol reminder");
    expect(prompt).toContain("report_pr_created, report_failed, or a blocking raise_issue");
  });

  it("canResume false with a local worktree holding an unpushed commit: fresh session in that worktree, commit kept, nothing prepared (C32)", async () => {
    const s = await seedRetry();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: s.previousWorktree, encoding: "utf8" }).trim();
    git("init", "--quiet", "-b", "work");
    await fs.writeFile(path.join(s.previousWorktree, "receipt.txt"), "locale\n");
    git("add", "receipt.txt");
    git("-c", "user.name=agent", "-c", "user.email=agent@example.com", "commit", "--quiet", "-m", "unpushed work");
    const tip = git("rev-parse", "HEAD");
    const h = makeRealRunner(s);
    h.adapter.canResumeResult = false;

    await runRetryStarter(starterOptions(s, h.runner, at(30 * SECOND)));
    await waitFor(async () =>
      (await executionRow(s.retryId)).state === "COMPLETED" ? true : undefined,
    );

    expect(h.adapter.canResumeCalls).toEqual([{ sessionId: "sess-prev", cwd: s.previousWorktree }]);
    expect(h.calls).toEqual([]);
    expect(h.adapter.resumes).toHaveLength(0);
    const req = h.adapter.starts[0]!;
    expect(req.cwd).toBe(s.previousWorktree);
    expect(req.prompt.startsWith("## Retry of attempt 1")).toBe(true);
    expect(req.prompt).toContain("process_crash");
    expect(req.prompt).toContain("same worktree");
    expect(req.prompt).toContain("## Approved specification (revision 2)");
    expect(git("rev-parse", "HEAD")).toBe(tip);
    expect(git("log", "-1", "--format=%s")).toBe("unpushed work");

    const row = await executionRow(s.retryId);
    expect(row.worktreePath).toBe(s.previousWorktree);
    expect(row.branch).toBe(s.branch);
    expect(row.sessionId).toBe("sess-new");
    expect((await executionRow(s.failedId)).worktreePath).toBeNull();
    expect(await eventTypes(s.retryId)).not.toContain("worktree.prepared");
  });

  it("a failed attempt from another host: no push, fresh from the remote branch", async () => {
    const s = await seedRetry({ previousHost: OTHER_HOST });
    const h = makeRealRunner(s);

    await runRetryStarter(starterOptions(s, h.runner, at(30 * SECOND)));
    await waitFor(async () => (h.adapter.starts.length > 0 ? true : undefined));

    expect(h.adapter.canResumeCalls).toHaveLength(0);
    expect(h.calls).toEqual(["prepareImplementation"]);
    expect(h.prepared[0]).toMatchObject({
      executionId: s.retryId,
      resumeFromRemote: true,
      fallbackToDefaultBranch: true,
    });
    expect(h.adapter.starts[0]!.prompt).toContain("what that attempt pushed");
  });

  it("a worktree that is gone on this host: fresh start after the push", async () => {
    const s = await seedRetry({ createWorktree: false });
    const h = makeRealRunner(s);

    await runRetryStarter(starterOptions(s, h.runner, at(30 * SECOND)));
    await waitFor(async () => (h.adapter.starts.length > 0 ? true : undefined));

    expect(h.adapter.canResumeCalls).toHaveLength(0);
    expect(h.calls).toEqual(["pushIfAhead", "prepareImplementation"]);
    expect(h.pushed).toEqual([
      { repositoryName: s.repositoryName, branch: s.branch, defaultBranch: "main" },
    ]);
    expect(h.prepared[0]).toMatchObject({ resumeFromRemote: true, fallbackToDefaultBranch: true });
    expect((await executionRow(s.retryId)).worktreePath).toBe(path.join(workRoot, "work", s.retryId));
  });
});

describe("startRetryStarter loop (C25)", () => {
  it("runs on its interval, starts a due retry, and stops cleanly", async () => {
    const s = await seedRetry();
    const spy = spyRunner();

    const stop = startRetryStarter({
      ...starterOptions(s, spy.runner, at(30 * SECOND)),
      intervalMs: 20,
    });
    try {
      await waitFor(async () => (spy.calls.length > 0 ? true : undefined), { timeoutMs: 5000 });
    } finally {
      await stop();
    }
    expect(spy.calls).toHaveLength(1);
    expect((await executionRow(s.retryId)).state).toBe("ASSIGNED");
  });
});
