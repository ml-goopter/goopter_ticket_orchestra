import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import { EndReason, type EndReason as EndReasonT } from "@orchestra/core";
import {
  lockExecutionForTool,
  lockTaskForTool,
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
import type { LogFields, Logger } from "../src/logger.js";
import {
  INFRA_RETRY_BACKOFF_BASE_MS,
  PROTOCOL_VIOLATION_DETAIL,
  classifyFailure,
  createRunner,
  infraRetryBackoffMs,
  runFailurePolicy,
  type FailureClassification,
  type Runner,
} from "../src/runner/index.js";
import { claimNextTask } from "../src/scheduler/index.js";
import { SetupFailedError } from "../src/worktrees/index.js";
import {
  seedExecutionRow,
  seedTaskRow,
  seedWorkerRow,
  startTestDb,
  type SeededTask,
  type TestDb,
} from "./harness.js";

/**
 * design.md §9.5 failure classification and retry policy, §6.5 retry
 * creation, against a real Postgres. The policy's `now` is a fake clock.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "retry-policy-host";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const SECOND = 1000;
const worker = { kind: "worker" as const, id: "00000000-0000-0000-0000-000000000001" };

let testDb: TestDb;
let db: Db;
let workRoot: string;
let runner: Runner | undefined;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "got43-policy-"));
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
const taskRow = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const executionsOf = (taskId: string) =>
  db.query.executions.findMany({
    where: (e, { eq }) => eq(e.taskId, taskId),
    orderBy: (e, { asc }) => [asc(e.attempt), asc(e.createdAt)],
  });
const notificationsOf = (taskId: string) =>
  db.query.notifications.findMany({ where: (n, { eq }) => eq(n.taskId, taskId) });
const eventsOf = (executionId: string) =>
  db.query.executionEvents.findMany({
    where: (e, { eq }) => eq(e.executionId, executionId),
    orderBy: (e, { asc }) => [asc(e.id)],
  });

/** Every row count a "nothing" branch must leave unchanged. */
async function writeCounts(taskId: string) {
  const [counts] = await raw<{
    executions: string;
    events: string;
    notifications: string;
    audit: string;
  }>(
    `select
       (select count(*) from executions where task_id = $1)::text as executions,
       (select count(*) from execution_events where task_id = $1)::text as events,
       (select count(*) from notifications where task_id = $1)::text as notifications,
       (select count(*) from audit_events)::text as audit`,
    [taskId],
  );
  const t = await taskRow(taskId);
  return { ...counts!, state: t.state, reason: t.needsHumanReason };
}

// ---------------------------------------------------------------- helpers

/**
 * What the runner's `endFailed` does: task, then execution locked, the
 * FAILED transition, then the policy in the same transaction.
 */
async function failAndApply(
  s: { taskId: string; executionId: string },
  endReason: EndReasonT,
  endDetail: string,
  now: Date = NOW,
) {
  return db.transaction(async (tx) => {
    await lockTaskForTool(tx, s.taskId);
    await lockExecutionForTool(tx, s.executionId);
    await transition(tx, {
      entity: "execution",
      id: s.executionId,
      trigger: "execution.failed",
      actor: worker,
      set: { endReason, endDetail, endedAt: now },
    });
    return runFailurePolicy(tx, {
      executionId: s.executionId,
      endReason,
      endDetail,
      actor: worker,
      now,
      logger,
    });
  });
}

async function seedRunning(
  options: Parameters<typeof seedTaskRow>[1] & {
    attempt?: number;
    infraRetriesUsed?: number;
    role?: "spec" | "implementation";
  } = {},
): Promise<SeededTask & { executionId: string; workerId: string }> {
  const workerId = await seedWorkerRow(db, { host: HOST });
  const t = await seedTaskRow(db, options);
  const executionId = await seedExecutionRow(db, {
    taskId: t.taskId,
    state: "RUNNING",
    role: options.role ?? "implementation",
    attempt: options.attempt ?? 1,
    specRevisionId: t.revisionId,
    workerId,
    host: HOST,
    sessionId: "sess-prev",
    branch: `agent/${t.jiraKey}-abcdef12`,
    worktreePath: path.join(workRoot, "work", "prev"),
    infraRetriesUsed: options.infraRetriesUsed ?? 0,
  });
  return { ...t, executionId, workerId };
}

const retryOf = async (taskId: string, failedId: string) =>
  (await executionsOf(taskId)).filter((e) => e.id !== failedId);

// ------------------------------------------------------ classification

describe("classifyFailure (§9.5, AC1)", () => {
  const retriable = JSON.stringify({ message: "rate limited", retriable: true });
  const terminal = JSON.stringify({ message: "not logged in", retriable: false });

  const EXPECTED: Record<EndReasonT, Array<[string | null, FailureClassification]>> = {
    adapter_error: [
      [retriable, { class: "infrastructure", action: "retry" }],
      [terminal, { class: "infrastructure", action: "escalate" }],
      // Not the runner's JSON: classified by the adapter error patterns.
      ["claude adapter not available", { class: "infrastructure", action: "retry" }],
      ["authentication_failed", { class: "infrastructure", action: "escalate" }],
    ],
    process_crash: [["spawn failed", { class: "infrastructure", action: "retry" }]],
    lease_expired: [["lease expired", { class: "infrastructure", action: "retry" }]],
    agent_hung: [["no agent event", { class: "infrastructure", action: "retry" }]],
    setup_failed: [["npm ERR!", { class: "infrastructure", action: "retry" }]],
    protocol_violation: [[PROTOCOL_VIOLATION_DETAIL, { class: "protocol", action: "nudge" }]],
    agent_gave_up: [["stuck: detail", { class: "business", action: "escalate" }]],
    budget_exceeded: [[null, { class: "business", action: "escalate" }]],
    cancelled: [[null, { class: "user", action: "none" }]],
  };

  it("has a row for every EndReason value in core's enum", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(EndReason).sort());
  });

  for (const [reason, rows] of Object.entries(EXPECTED)) {
    for (const [detail, expected] of rows) {
      it(`${reason} ${detail ?? "(no detail)"} -> ${expected.class}/${expected.action}`, () => {
        expect(classifyFailure(reason as EndReasonT, detail)).toEqual(expected);
      });
    }
  }

  it("backs off 30 s * 2^n, n the infrastructure retries already used", () => {
    expect(INFRA_RETRY_BACKOFF_BASE_MS).toBe(30 * SECOND);
    expect([0, 1, 2, 3].map(infraRetryBackoffMs)).toEqual([
      30 * SECOND,
      60 * SECOND,
      120 * SECOND,
      240 * SECOND,
    ]);
  });
});

// ------------------------------------------------------ infrastructure

describe("infrastructure retry below the limit (AC2)", () => {
  it("inserts a QUEUED retry row, writes execution.queued and execution_failed, leaves the task", async () => {
    const s = await seedRunning({ attempt: 1 });
    const failed = await executionRow(s.executionId);

    const outcome = await failAndApply(s, "process_crash", "spawn failed");

    const [retry] = await retryOf(s.taskId, s.executionId);
    expect(retry).toBeDefined();
    expect(outcome).toMatchObject({ kind: "retry", executionId: retry!.id });
    expect(retry).toMatchObject({
      state: "QUEUED",
      role: "implementation",
      attempt: 2,
      host: null,
      workerId: null,
      infraRetriesUsed: 1,
      runtime: failed.runtime,
      model: failed.model,
      specRevisionId: s.revisionId,
      branch: failed.branch,
      sessionId: "sess-prev",
      worktreePath: null,
      endReason: null,
    });

    const events = await eventsOf(retry!.id);
    expect(events.map((e) => e.type)).toEqual(["execution.queued"]);
    expect(events[0]!.payload).toEqual({
      attempt: 2,
      retry_of: s.executionId,
      not_before: new Date(NOW.getTime() + 30 * SECOND).toISOString(),
    });

    const notes = await notificationsOf(s.taskId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "execution_failed", userId: null });
    expect(notes[0]!.title).toContain(s.jiraKey);
    expect(notes[0]!.title).toContain("process_crash");
    expect(notes[0]!.title).toContain("attempt 2");

    const t = await taskRow(s.taskId);
    expect(t.state).toBe("IMPLEMENTING");
    expect(t.needsHumanReason).toBeNull();
    expect(await raw("select id from audit_events where entity_id = $1", [s.taskId])).toHaveLength(0);
  });

  it("honours 30 s * 2^n with n retries already used, and keeps REVIEWING", async () => {
    const s = await seedRunning({ attempt: 3, infraRetriesUsed: 2, taskState: "REVIEWING" });

    await failAndApply(s, "adapter_error", JSON.stringify({ message: "overloaded", retriable: true }));

    const [retry] = await retryOf(s.taskId, s.executionId);
    expect(retry).toMatchObject({ attempt: 4, infraRetriesUsed: 3, state: "QUEUED" });
    const [queued] = await eventsOf(retry!.id);
    expect(queued!.payload).toMatchObject({
      not_before: new Date(NOW.getTime() + 120 * SECOND).toISOString(),
    });
    expect((await taskRow(s.taskId)).state).toBe("REVIEWING");
  });

  for (const reason of ["lease_expired", "agent_hung", "setup_failed"] as const) {
    it(`${reason} is retried`, async () => {
      const s = await seedRunning();
      await failAndApply(s, reason, "detail");
      expect(await retryOf(s.taskId, s.executionId)).toHaveLength(1);
    });
  }
});

describe("infrastructure at the limit and terminal (AC3)", () => {
  it("at max_infra_retries escalates with the exhausted reason and inserts no row", async () => {
    const s = await seedRunning({ attempt: 4, infraRetriesUsed: 3, maxInfraRetries: 3 });

    const outcome = await failAndApply(s, "agent_hung", "no agent event for 1200000 ms");

    expect(outcome).toMatchObject({ kind: "escalated", taskMoved: true });
    expect(await retryOf(s.taskId, s.executionId)).toHaveLength(0);
    const t = await taskRow(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toMatch(/^infrastructure retries exhausted \(3\)/);
    expect(t.needsHumanReason).toContain("agent_hung");
    const notes = await notificationsOf(s.taskId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "needs_human", userId: null });
    expect(notes[0]!.title).toContain(s.jiraKey);
    expect(notes[0]!.title).toContain("infrastructure retries exhausted");
    const [audit] = await raw<{ trigger: string; to_state: string }>(
      "select trigger, to_state from audit_events where entity_id = $1",
      [s.taskId],
    );
    expect(audit).toEqual({ trigger: "task.escalated", to_state: "NEEDS_HUMAN" });
  });

  it("max_infra_retries 0 escalates the first failure", async () => {
    const s = await seedRunning({ maxInfraRetries: 0 });
    await failAndApply(s, "process_crash", "boom");
    expect((await taskRow(s.taskId)).needsHumanReason).toMatch(
      /^infrastructure retries exhausted \(0\)/,
    );
    expect(await retryOf(s.taskId, s.executionId)).toHaveLength(0);
  });

  it("a non-retriable adapter error escalates immediately with its message", async () => {
    const s = await seedRunning({ taskState: "REVIEWING" });

    await failAndApply(s, "adapter_error", JSON.stringify({ message: "not logged in", retriable: false }));

    const t = await taskRow(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toContain("adapter_error");
    expect(t.needsHumanReason).toContain("not logged in");
    expect(await retryOf(s.taskId, s.executionId)).toHaveLength(0);
    expect((await notificationsOf(s.taskId)).map((n) => n.kind)).toEqual(["needs_human"]);
  });

  it("a spec execution in SPEC_IN_PROGRESS: no task move, a needs_human notification and a log line", async () => {
    const s = await seedRunning({ taskState: "SPEC_IN_PROGRESS", role: "spec" });

    const outcome = await failAndApply(s, "adapter_error", JSON.stringify({ message: "not logged in", retriable: false }));

    expect(outcome).toMatchObject({ kind: "escalated", taskMoved: false });
    const t = await taskRow(s.taskId);
    expect(t.state).toBe("SPEC_IN_PROGRESS");
    expect(t.needsHumanReason).toBeNull();
    expect((await notificationsOf(s.taskId)).map((n) => n.kind)).toEqual(["needs_human"]);
    expect(records.some((r) => r.level === "warn" && r.fields.taskId === s.taskId)).toBe(true);
    expect(await raw("select id from audit_events where entity_id = $1", [s.taskId])).toHaveLength(0);
  });

  it("a retriable failure of a spec execution is not retried: the starter never runs spec rows", async () => {
    const s = await seedRunning({ taskState: "SPEC_IN_PROGRESS", role: "spec" });
    await failAndApply(s, "process_crash", "boom");
    expect(await retryOf(s.taskId, s.executionId)).toHaveLength(0);
    expect((await notificationsOf(s.taskId)).map((n) => n.kind)).toEqual(["needs_human"]);
  });
});

// ------------------------------------------------------------- protocol

describe("protocol retries (C26, AC4)", () => {
  it("retries with the nudge marker up to max_protocol_retries, then escalates", async () => {
    const s = await seedRunning({ maxProtocolRetries: 2 });

    // First violation: 1 <= 2.
    const first = await failAndApply(s, "protocol_violation", PROTOCOL_VIOLATION_DETAIL);
    expect(first).toMatchObject({ kind: "retry" });
    const [r1] = await retryOf(s.taskId, s.executionId);
    expect(r1).toMatchObject({ attempt: 2, infraRetriesUsed: 0, state: "QUEUED", sessionId: "sess-prev" });
    const [q1] = await eventsOf(r1!.id);
    expect(q1!.payload).toEqual({
      attempt: 2,
      retry_of: s.executionId,
      not_before: NOW.toISOString(),
      nudge: {
        kind: "protocol_nudge",
        missing_tool_call: "report_pr_created, report_failed, or a blocking raise_issue",
      },
    });
    expect((await notificationsOf(s.taskId)).map((n) => n.kind)).toEqual(["execution_failed"]);

    // Second violation: 2 <= 2.
    await raw("update executions set state = 'RUNNING' where id = $1", [r1!.id]);
    await failAndApply({ taskId: s.taskId, executionId: r1!.id }, "protocol_violation", PROTOCOL_VIOLATION_DETAIL);
    const all = await executionsOf(s.taskId);
    expect(all).toHaveLength(3);
    const r2 = all[2]!;
    expect(r2.attempt).toBe(3);
    expect(((await eventsOf(r2.id))[0]!.payload as { nudge: unknown }).nudge).toBeDefined();

    // Third violation: 3 > 2.
    await raw("update executions set state = 'RUNNING' where id = $1", [r2.id]);
    const third = await failAndApply(
      { taskId: s.taskId, executionId: r2.id },
      "protocol_violation",
      PROTOCOL_VIOLATION_DETAIL,
    );
    expect(third).toMatchObject({ kind: "escalated", taskMoved: true });
    expect(await executionsOf(s.taskId)).toHaveLength(3);
    const t = await taskRow(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toMatch(/^protocol retries exhausted \(2\)/);
    expect((await notificationsOf(s.taskId)).map((n) => n.kind).sort()).toEqual([
      "execution_failed",
      "execution_failed",
      "needs_human",
    ]);
  });

  it("an infrastructure retry does not count against protocol retries, nor protocol against infrastructure", async () => {
    const s = await seedRunning({ maxProtocolRetries: 1, infraRetriesUsed: 1 });
    await seedExecutionRow(db, {
      taskId: s.taskId,
      state: "FAILED",
      attempt: 0,
      endReason: "process_crash",
    });

    await failAndApply(s, "protocol_violation", PROTOCOL_VIOLATION_DETAIL);

    const [retry] = (await retryOf(s.taskId, s.executionId)).filter((e) => e.state === "QUEUED");
    expect(retry).toMatchObject({ attempt: 2, infraRetriesUsed: 1 });
  });
});

// ------------------------------------------------- business and user

describe("business, user, and a task already NEEDS_HUMAN (AC5)", () => {
  it("agent_gave_up after report_failed escalated: no writes", async () => {
    const s = await seedRunning({ taskState: "NEEDS_HUMAN", needsHumanReason: "Agent gave up: stuck" });
    const before = await writeCounts(s.taskId);

    // What report_failed wrote before the policy runs.
    const outcome = await db.transaction(async (tx) => {
      await lockTaskForTool(tx, s.taskId);
      await lockExecutionForTool(tx, s.executionId);
      await transition(tx, {
        entity: "execution",
        id: s.executionId,
        trigger: "execution.failed",
        actor: worker,
        set: { endReason: "agent_gave_up", endDetail: "stuck: detail", endedAt: NOW },
      });
      return runFailurePolicy(tx, {
        executionId: s.executionId,
        endReason: "agent_gave_up",
        endDetail: "stuck: detail",
        actor: worker,
        now: NOW,
        logger,
      });
    });

    expect(outcome).toEqual({ kind: "none" });
    const after = await writeCounts(s.taskId);
    // Only the tool's own execution.failed event and audit row.
    expect(after).toEqual({
      ...before,
      events: String(Number(before.events) + 1),
      audit: String(Number(before.audit) + 1),
    });
    expect((await taskRow(s.taskId)).needsHumanReason).toBe("Agent gave up: stuck");
  });

  it("cancelled: nothing", async () => {
    const s = await seedRunning();
    const before = await writeCounts(s.taskId);
    const outcome = await db.transaction((tx) =>
      runFailurePolicy(tx, {
        executionId: s.executionId,
        endReason: "cancelled",
        endDetail: null,
        actor: worker,
        now: NOW,
        logger,
      }),
    );
    expect(outcome).toEqual({ kind: "none" });
    expect(await writeCounts(s.taskId)).toEqual(before);
  });

  it("a retriable failure on a task already NEEDS_HUMAN leaves it alone", async () => {
    const s = await seedRunning({
      taskState: "NEEDS_HUMAN",
      needsHumanReason: "Review round limit exceeded: round 4 > max_review_rounds 3",
    });
    const before = await writeCounts(s.taskId);

    const outcome = await failAndApply(s, "protocol_violation", PROTOCOL_VIOLATION_DETAIL);

    expect(outcome).toEqual({ kind: "none" });
    const after = await writeCounts(s.taskId);
    expect(after.executions).toBe(before.executions);
    expect(after.notifications).toBe(before.notifications);
    expect(after.reason).toBe(before.reason);
    expect(after.state).toBe("NEEDS_HUMAN");
  });

  it("a NEEDS_HUMAN task with no reason gets one, and nothing else", async () => {
    const s = await seedRunning({ taskState: "NEEDS_HUMAN" });

    const outcome = await failAndApply(s, "agent_gave_up", "stuck: detail");

    expect(outcome).toEqual({ kind: "reason_set" });
    expect((await taskRow(s.taskId)).needsHumanReason).toContain("agent_gave_up");
    expect(await retryOf(s.taskId, s.executionId)).toHaveLength(0);
    expect(await notificationsOf(s.taskId)).toHaveLength(0);
  });
});

// ------------------------------------------------ wired into the runner

class FakeAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];
  script: () => AsyncGenerator<AgentEvent> = async function* () {};

  start(req: StartRequest): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    return this.script();
  }

  resume(_req: ResumeRequest): AsyncIterable<AgentEvent> {
    return this.script();
  }

  async canResume(): Promise<boolean> {
    return false;
  }
}

function makeRunner(workerId: string, prepareError?: Error) {
  const adapter = new FakeAdapter();
  runner = createRunner({
    db,
    registry: createExecutionRegistry(),
    logger,
    workerId,
    host: HOST,
    worktrees: {
      async prepareImplementation(input) {
        if (prepareError) throw prepareError;
        const worktreePath = path.join(workRoot, "work", input.executionId);
        await fs.mkdir(worktreePath, { recursive: true });
        return { worktreePath, branch: `agent/${input.task.jiraKey}-abcdef12` };
      },
      prepareSpec: () => Promise.reject(new Error("not expected")),
      remove: async () => ({ branchDeleted: false }),
    },
    adapters: { claude: adapter },
    toolsUrl: () => "http://127.0.0.1:4999/mcp",
    quietTimeoutMs: 10_000,
    now: () => NOW,
    timings: { leaseRenewMs: 100, blockingGraceMs: 400, blockingPollMs: 50 },
  });
  return { adapter, runner };
}

async function seedClaimed() {
  const workerId = await seedWorkerRow(db, { host: HOST, workspaceRoot: workRoot });
  const t = await seedTaskRow(db, { taskState: "READY" });
  const claim = await claimNextTask({ db, workerId, runtimes: ["claude"], now: new Date() });
  if (!claim) throw new Error("claim returned nothing");
  return { ...t, workerId, executionId: claim.executionId };
}

describe("runner hook (§9.5, contract 4)", () => {
  it("setup_failed in endFailed queues a retry in the same transaction", async () => {
    const s = await seedClaimed();
    const h = makeRunner(s.workerId, new SetupFailedError(1, null, "npm ERR! boom"));

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect((await executionRow(s.executionId)).endReason).toBe("setup_failed");
    const [retry] = await retryOf(s.taskId, s.executionId);
    expect(retry).toMatchObject({ state: "QUEUED", attempt: 2, infraRetriesUsed: 1, host: null });
    const [queued] = await eventsOf(retry!.id);
    expect(queued!.payload).toMatchObject({
      not_before: new Date(NOW.getTime() + 30 * SECOND).toISOString(),
    });
    // The retry's execution.queued commits with the FAILED transition.
    const [failedAudit] = await raw<{ xmin: string }>(
      "select xmin::text from audit_events where entity_id = $1 and to_state = 'FAILED'",
      [s.executionId],
    );
    const [retryRow] = await raw<{ xmin: string }>("select xmin::text from executions where id = $1", [retry!.id]);
    expect(retryRow!.xmin).toBe(failedAudit!.xmin);
    expect((await taskRow(s.taskId)).state).toBe("IMPLEMENTING");
  });

  it("protocol_violation after the turn queues a nudge retry", async () => {
    const s = await seedClaimed();
    const h = makeRunner(s.workerId);
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-p" };
      yield { type: "turn_done", finalText: "done, I think" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect((await executionRow(s.executionId)).endReason).toBe("protocol_violation");
    const [retry] = await retryOf(s.taskId, s.executionId);
    expect(retry).toMatchObject({ state: "QUEUED", sessionId: "sess-p", infraRetriesUsed: 0 });
    const [queued] = await eventsOf(retry!.id);
    expect(queued!.payload).toMatchObject({ nudge: { kind: "protocol_nudge" } });
  });

  it("a non-retriable adapter error escalates the task", async () => {
    const s = await seedClaimed();
    const h = makeRunner(s.workerId);
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-a" };
      yield { type: "error", message: "not logged in", retriable: false };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const t = await taskRow(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toContain("not logged in");
    expect(await retryOf(s.taskId, s.executionId)).toHaveLength(0);
  });
});
