import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import type { Runtime } from "@orchestra/core";
import {
  agentWorkers,
  appendEvent,
  executionCommands,
  executionUsage,
  executions,
  issues,
  lockTaskForTool,
  projects,
  repositories,
  specificationRevisions,
  taskDecisions,
  tasks,
  transition,
  users,
  type Db,
} from "@orchestra/db";
import {
  IMPLEMENTATION_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES,
} from "@orchestra/prompts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createExecutionRegistry,
  hashToken,
  type ExecutionRegistry,
} from "../src/agent-tools/index.js";
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import { createDefaultPhases } from "../src/phases/index.js";
import {
  DEFAULT_REVIEW_WRAPPER_BIN,
  PROTOCOL_VIOLATION_DETAIL,
  ResumeError,
  createCommandHandlers,
  createRunner,
  registerCancelHandler,
  type Runner,
  type RunnerDeps,
} from "../src/runner/index.js";
import { claimNextTask } from "../src/scheduler/index.js";
import type { TickContext } from "../src/tick.js";
import {
  SetupFailedError,
  type PrepareImplementationInput,
} from "../src/worktrees/index.js";
import { sleep, startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * design.md §9.1-§9.4 and §8 blocking handling, against a real Postgres
 * with a scripted fake adapter and a fake worktree manager.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "runner-host";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const TOOLS_URL = "http://127.0.0.1:4999/mcp";
const BASE_PATH = "/usr/bin:/bin";

const SPEC = {
  repository: "repo",
  objective: "Make receipts print in the device language",
  scope: ["receipt printer"],
  out_of_scope: ["email receipts"],
  requirements: ["use device locale"],
  acceptance_criteria: ["receipt uses locale"],
  validation: ["unit test"],
  constraints: ["no new deps"],
  dependencies: [],
};

let testDb: TestDb;
let db: Db;
let workRoot: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "got31-runner-"));
});

afterAll(async () => {
  await testDb?.stop();
  await fs.rm(workRoot, { recursive: true, force: true });
});

let runner: Runner | undefined;

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

// ---------------------------------------------------------------- seeding

let seq = 0;

interface Seeded {
  workerId: string;
  taskId: string;
  executionId: string;
}

async function seedClaimed(
  options: { runtime?: Runtime; model?: string | null } = {},
): Promise<Seeded> {
  const n = ++seq;
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: workRoot })
    .onConflictDoNothing()
    .returning({ id: agentWorkers.id });
  const workerId =
    worker?.id ??
    (await db.query.agentWorkers.findFirst({ where: (w, { eq }) => eq(w.host, HOST) }))!.id;
  const [project] = await db
    .insert(projects)
    .values({ key: `RUN${n}`, name: `runner ${n}`, jiraJql: `project = RUN${n}` })
    .returning({ id: projects.id });
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: `repo-${n}`,
      gitUrl: `git@example.com:repo-${n}.git`,
      defaultBranch: "main",
      defaultRuntime: options.runtime ?? "claude",
      defaultModel: options.model === undefined ? "claude-opus-test" : options.model,
      maxConcurrentWorktrees: 4,
      setupCommand: "npm ci",
    })
    .returning({ id: repositories.id });
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey: `RUN-${n}`,
      jiraSummary: `Receipt language ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "READY",
    })
    .returning({ id: tasks.id });
  const [revision] = await db
    .insert(specificationRevisions)
    .values({ taskId: task!.id, version: 2, status: "approved", content: SPEC })
    .returning({ id: specificationRevisions.id });
  await db.$client.unsafe("update tasks set approved_revision_id = $1 where id = $2", [
    revision!.id,
    task!.id,
  ]);

  const claim = await claimNextTask({
    db,
    workerId,
    runtimes: [options.runtime ?? "claude"],
    now: new Date(),
  });
  if (!claim) throw new Error("claim returned nothing");
  return { workerId, taskId: claim.taskId, executionId: claim.executionId };
}

async function seedDecision(s: Seeded, text: string): Promise<void> {
  const [user] = await db
    .insert(users)
    .values({ email: `pm${++seq}@example.com`, passwordHash: "x", displayName: "PM" })
    .returning({ id: users.id });
  const [issue] = await db
    .insert(issues)
    .values({
      taskId: s.taskId,
      executionId: s.executionId,
      type: "QUESTION",
      severity: "info",
      blocking: false,
      title: "language?",
      description: "which language",
      status: "RESOLVED",
    })
    .returning({ id: issues.id });
  await db.insert(taskDecisions).values({
    taskId: s.taskId,
    issueId: issue!.id,
    decision: text,
    decidedBy: user!.id,
    decidedAt: NOW,
  });
}

// ------------------------------------------------------------------ reads

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const task = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const eventsFor = (executionId: string) =>
  db.query.executionEvents.findMany({
    where: (e, { eq }) => eq(e.executionId, executionId),
    orderBy: (e, { asc }) => [asc(e.id)],
  });
const eventTypes = async (executionId: string) =>
  (await eventsFor(executionId)).map((e) => e.type);
const leaseExpiry = async (executionId: string): Promise<Date | null> => {
  const [row] = await db.$client.unsafe<{ expires_at: Date }[]>(
    "select expires_at from task_leases where execution_id = $1",
    [executionId],
  );
  return row ? new Date(row.expires_at) : null;
};
/** Everything a refused resume must leave untouched. */
const writeSnapshot = async (executionId: string) => {
  const [audit] = await db.$client.unsafe<{ n: string }[]>(
    "select count(*)::text as n from audit_events where entity_id = $1",
    [executionId],
  );
  return {
    execution: await execution(executionId),
    lease: await leaseExpiry(executionId),
    events: (await eventsFor(executionId)).length,
    audit: audit!.n,
  };
};

// ------------------------------------------------------------ fake agent

interface ScriptApi {
  token: string;
  signal: AbortSignal;
  executionId: string;
}

type Script = (api: ScriptApi) => AsyncGenerator<AgentEvent>;

class FakeAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  readonly signals: AbortSignal[] = [];
  canResumeResult = true;
  /** Runs inside `canResume`: after resume loads its context, before its transaction. */
  onCanResume?: () => Promise<void>;
  script: Script = async function* () {};

  constructor(private readonly executionIdFor: (cwd: string) => string) {}

  start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    this.signals.push(signal);
    return this.script({ token: req.mcp.token, signal, executionId: this.executionIdFor(req.cwd) });
  }

  resume(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    this.signals.push(signal);
    return this.script({ token: req.mcp.token, signal, executionId: this.executionIdFor(req.cwd) });
  }

  async canResume(): Promise<boolean> {
    await this.onCanResume?.();
    return this.canResumeResult;
  }
}

/** Resolves when `signal` aborts. A hung agent that honours cancel. */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** What `report_pr_created` does to the execution (§8). */
async function completeViaTool(executionId: string): Promise<void> {
  const row = await execution(executionId);
  await db.transaction(async (tx) => {
    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.completed",
      actor: { kind: "agent", id: executionId },
      set: { endedAt: new Date() },
    });
    void row;
  });
}

/** What `POST /tasks/:id/cancel` does. */
async function cancelViaApi(taskId: string, executionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, { entity: "task", id: taskId, trigger: "task.cancelled", actor: { kind: "user" } });
    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.cancelled",
      actor: { kind: "user" },
    });
  });
}

// ------------------------------------------------------------- the runner

interface Harness {
  adapter: FakeAdapter;
  registry: ExecutionRegistry;
  prepared: PrepareImplementationInput[];
  runner: Runner;
}

function makeRunner(
  options: {
    prepareError?: Error;
    noMistakes?: boolean;
    quietTimeoutMs?: number;
    leaseRenewMs?: number;
    adapters?: RunnerDeps["adapters"];
    /** Runs inside `prepareImplementation`, before it returns. */
    onPrepare?: (input: PrepareImplementationInput) => Promise<void>;
    workerId: string;
  },
): Harness {
  const registry = createExecutionRegistry();
  const prepared: PrepareImplementationInput[] = [];
  const adapter = new FakeAdapter((cwd) => path.basename(cwd));
  const created = createRunner({
    db,
    registry,
    logger,
    workerId: options.workerId,
    host: HOST,
    worktrees: {
      async prepareImplementation(input) {
        prepared.push(input);
        if (options.prepareError) throw options.prepareError;
        await options.onPrepare?.(input);
        const worktreePath = path.join(workRoot, "work", input.executionId);
        await fs.mkdir(worktreePath, { recursive: true });
        if (options.noMistakes) {
          await fs.mkdir(path.join(worktreePath, ".no-mistakes"), { recursive: true });
        }
        return { worktreePath, branch: `agent/${input.task.jiraKey}-abcdef12` };
      },
    },
    adapters: options.adapters ?? { claude: adapter },
    toolsUrl: () => TOOLS_URL,
    githubToken: "gh-token",
    quietTimeoutMs: options.quietTimeoutMs ?? 10_000,
    basePath: BASE_PATH,
    timings: { leaseRenewMs: options.leaseRenewMs ?? 100, blockingGraceMs: 400, blockingPollMs: 50 },
  });
  runner = created;
  return { adapter, registry, prepared, runner: created };
}

async function expectCleanedUp(h: Harness, executionId: string): Promise<void> {
  const row = await execution(executionId);
  expect(row.toolsTokenHash).toBeNull();
  expect(h.registry.get(executionId)).toBeUndefined();
  expect(h.runner.isLive(executionId)).toBe(false);
}

// ------------------------------------------------------------------ tests

describe("runner start (design.md §9.1, §9.3)", () => {
  it("prepares the worktree, issues a token, moves ASSIGNED -> RUNNING on session, and leaves a tool-set COMPLETED alone", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    const seen: { hashDuringRun?: string | null; entryDuringRun?: boolean } = {};
    h.adapter.script = async function* ({ token, executionId }) {
      yield { type: "session", sessionId: "sess-1" };
      seen.hashDuringRun = (await execution(executionId)).toolsTokenHash;
      seen.entryDuringRun = h.registry.get(executionId) !== undefined;
      expect(seen.hashDuringRun).toBe(hashToken(token));
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "PR opened" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("COMPLETED");
    expect(row.sessionId).toBe("sess-1");
    expect(row.startedAt).not.toBeNull();
    expect(row.endedAt).not.toBeNull();
    expect(row.worktreePath).toBe(path.join(workRoot, "work", s.executionId));
    expect(row.branch).toMatch(/^agent\/RUN-\d+-abcdef12$/);
    expect(row.host).toBe(HOST);
    expect(seen.entryDuringRun).toBe(true);

    const types = await eventTypes(s.executionId);
    expect(types.filter((t) => t === "execution.started")).toHaveLength(1);
    expect(types.indexOf("worktree.prepared")).toBeLessThan(types.indexOf("execution.started"));
    expect(types).toContain("execution.completed");
    expect(types).not.toContain("execution.failed");

    expect(h.prepared[0]!.spec).toEqual({ version: 2, content: SPEC });
    expect(h.prepared[0]!.reviewCommand).toBeNull();
    expect(h.prepared[0]!.runtime).toBe("claude");
    await expectCleanedUp(h, s.executionId);
  });

  it("setup failure ends FAILED setup_failed with the output tail and never starts a session", async () => {
    const s = await seedClaimed();
    const h = makeRunner({
      workerId: s.workerId,
      prepareError: new SetupFailedError(1, null, "npm ERR! boom"),
    });

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("setup_failed");
    expect(row.endDetail).toContain("setup command failed (exit 1)");
    expect(row.endDetail).toContain("npm ERR! boom");
    expect(row.endedAt).not.toBeNull();
    expect(h.adapter.starts).toHaveLength(0);
    expect(await eventTypes(s.executionId)).toContain("execution.failed");
    // Q10: the task is not touched.
    expect((await task(s.taskId)).state).toBe("IMPLEMENTING");
    await expectCleanedUp(h, s.executionId);
  });

  it("renews the lease while the worktree is being prepared (§6.4)", async () => {
    const s = await seedClaimed();
    let during: { before: Date | null; after: Date | null } | undefined;
    const h = makeRunner({
      workerId: s.workerId,
      leaseRenewMs: 100,
      // A slow fetch or setup_command: several renewal periods long.
      onPrepare: async () => {
        const before = await leaseExpiry(s.executionId);
        await sleep(450);
        during = { before, after: await leaseExpiry(s.executionId) };
      },
    });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-lp" };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect(during!.before).not.toBeNull();
    expect(during!.after!.getTime()).toBeGreaterThan(during!.before!.getTime());
    expect((await execution(s.executionId)).state).toBe("COMPLETED");
    await expectCleanedUp(h, s.executionId);
  });

  it("a runtime with no adapter ends FAILED adapter_error before any worktree work", async () => {
    const s = await seedClaimed({ runtime: "codex" });
    const h = makeRunner({ workerId: s.workerId });

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("adapter_error");
    expect(row.endDetail).toBe("codex adapter not available");
    expect(h.prepared).toHaveLength(0);
    await expectCleanedUp(h, s.executionId);
  });
});

describe("event loop (design.md §9.3)", () => {
  it("batches text into agent.message.delta at 200 ms, writes agent.message, tool calls and usage", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-2" };
      yield { type: "text", delta: "Hel" };
      yield { type: "text", delta: "lo " };
      await sleep(350);
      yield { type: "text", delta: "world" };
      yield { type: "tool_call", name: "Bash", input: { command: "npm test" } };
      yield { type: "tool_call", name: "mcp__orchestra__note", input: { text: "hi" } };
      yield { type: "tool_result", name: "Bash", ok: true };
      yield { type: "usage", model: "claude-opus-test", input: 100, cached: 20, output: 50, costUsd: 0.25 };
      yield { type: "usage", model: "claude-haiku-test", input: 10, cached: 0, output: 5 };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "Hello world" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const events = await eventsFor(s.executionId);
    const deltas = events.filter((e) => e.type === "agent.message.delta");
    expect(deltas.map((e) => (e.payload as { text: string }).text)).toEqual(["Hello ", "world"]);
    const messages = events.filter((e) => e.type === "agent.message");
    expect(messages.map((e) => e.payload)).toEqual([{ text: "Hello world" }]);

    const toolCalls = events.filter((e) => e.type === "agent.tool_call");
    expect(toolCalls.map((e) => e.payload)).toEqual([
      { name: "Bash", input: { command: "npm test" } },
    ]);

    const usage = await db.query.executionUsage.findMany({
      where: (u, { eq }) => eq(u.executionId, s.executionId),
      orderBy: (u, { asc }) => [asc(u.recordedAt), asc(u.model)],
    });
    expect(usage.map((u) => [u.kind, u.round, u.runtime, u.model, u.inputTokens, u.cachedInputTokens, u.outputTokens, Number(u.costUsd)])).toEqual([
      ["main", null, "claude", "claude-opus-test", 100, 20, 50, 0.25],
      ["main", null, "claude", "claude-haiku-test", 10, 0, 5, 0],
    ]);
    const row = await execution(s.executionId);
    expect([row.inputTokens, row.cachedInputTokens, row.outputTokens, Number(row.costUsd)]).toEqual([110, 20, 55, 0.25]);
    const recorded = events.filter((e) => e.type === "usage.recorded");
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.payload).toMatchObject({ kind: "main", model: "claude-opus-test", input_tokens: 100 });
    await expectCleanedUp(h, s.executionId);
  });

  it("writes buffered text before the next non-text event, so rows keep the adapter's order", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-o" };
      yield { type: "text", delta: "Hello " };
      yield { type: "tool_call", name: "Bash", input: { command: "ls" } };
      yield { type: "text", delta: "world" };
      yield { type: "turn_done", finalText: "Hello world" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const agentRows = (await eventsFor(s.executionId))
      .filter((e) => ["agent.message.delta", "agent.tool_call", "agent.message"].includes(e.type))
      .map((e) => [e.type, e.payload]);
    expect(agentRows).toEqual([
      ["agent.message.delta", { text: "Hello " }],
      ["agent.tool_call", { name: "Bash", input: { command: "ls" } }],
      ["agent.message.delta", { text: "world" }],
      ["agent.message", { text: "Hello world" }],
    ]);
  });

  it("writes buffered text before an orchestra tool call, so it lands before what the tool writes", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-o2" };
      yield { type: "text", delta: "Opening the PR" };
      yield { type: "tool_call", name: "mcp__orchestra__report_pr_created", input: {} };
      // The tool runs after the call event and writes execution.completed.
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "Opening the PR" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const types = await eventTypes(s.executionId);
    expect(types.indexOf("agent.message.delta")).toBeGreaterThan(-1);
    expect(types.indexOf("agent.message.delta")).toBeLessThan(types.indexOf("execution.completed"));
    expect(types).not.toContain("agent.tool_call");
  });

  it("an orchestra tool call waits for a delta the 200 ms timer already sent, so the tool's event lands after it", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    // A test transaction holds the task row, so the timer's delta write
    // stays queued behind the lock. If the runner lets the tool run before
    // that write lands, the tool's agent.note is written inside the holding
    // transaction and gets the lower id. Otherwise the lock is released
    // after a grace period and the tool writes its note once it runs.
    let toolRan!: () => void;
    const ran = new Promise<void>((resolve) => (toolRan = resolve));
    let noteWritten = false;
    const note = { taskId: s.taskId, executionId: s.executionId, type: "agent.note" as const, payload: { text: "noted" } };
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-o3" };
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => (locked = resolve));
      const holder = db.transaction(async (tx) => {
        await lockTaskForTool(tx, s.taskId);
        locked();
        const toolFirst = await Promise.race([
          ran.then(() => true),
          sleep(700).then(() => false),
        ]);
        if (toolFirst) {
          await appendEvent(tx, note);
          noteWritten = true;
        }
      });
      await lockHeld;
      yield { type: "text", delta: "Noting" };
      // The 200 ms timer empties the buffer; its write waits on the lock.
      await sleep(350);
      yield { type: "tool_call", name: "mcp__orchestra__note", input: { text: "noted" } };
      toolRan();
      await holder;
      if (!noteWritten) await db.transaction((tx) => appendEvent(tx, note));
      await completeViaTool(s.executionId);
      yield { type: "turn_done", finalText: "Noting" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const events = await eventsFor(s.executionId);
    const delta = events.find((e) => e.type === "agent.message.delta");
    const noteRow = events.find((e) => e.type === "agent.note");
    expect(delta?.payload).toEqual({ text: "Noting" });
    expect(noteRow).toBeDefined();
    expect(delta!.id).toBeLessThan(noteRow!.id);
  });

  it("resets the quiet timer on every event (§9.4)", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, quietTimeoutMs: 300 });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-qt" };
      // 8 x 100 ms: every gap is under the timeout, the span is well over it.
      for (let i = 0; i < 8; i++) {
        await sleep(100);
        yield { type: "text", delta: "." };
      }
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "........" };
    };

    const started = Date.now();
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    const row = await execution(s.executionId);
    expect(row.state).toBe("COMPLETED");
    expect(row.endReason).toBeNull();
    expect(h.adapter.signals[0]!.aborted).toBe(false);
    expect(await eventTypes(s.executionId)).not.toContain("execution.failed");
  });

  it("an iterator that throws ends FAILED process_crash with the token redacted from end_detail and logs", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    let seenToken = "";
    h.adapter.script = async function* ({ token }) {
      seenToken = token;
      yield { type: "session", sessionId: "sess-th" };
      throw new Error(`spawn failed with ORCHESTRA_TOKEN=${token}`);
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect(seenToken).not.toBe("");
    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("process_crash");
    expect(row.endDetail).toContain("spawn failed with ORCHESTRA_TOKEN=");
    expect(row.endDetail).not.toContain(seenToken);
    expect(JSON.stringify(records)).not.toContain(seenToken);
    await expectCleanedUp(h, s.executionId);
  });

  it("an adapter error ends FAILED adapter_error with retriable in end_detail", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-3" };
      yield { type: "error", message: "rate limited", retriable: true };
      yield { type: "turn_done", finalText: "never read" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("adapter_error");
    expect(JSON.parse(row.endDetail!)).toEqual({ message: "rate limited", retriable: true });
    expect((await task(s.taskId)).state).toBe("IMPLEMENTING");
    await expectCleanedUp(h, s.executionId);
  });

  it("an adapter error before the session event ends FAILED from ASSIGNED", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* () {
      yield { type: "error", message: "not logged in", retriable: false };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.startedAt).toBeNull();
    expect(JSON.parse(row.endDetail!)).toEqual({ message: "not logged in", retriable: false });
    await expectCleanedUp(h, s.executionId);
  });
});

describe("after the turn (design.md §9.3, §8)", () => {
  it("blocking issue pending -> WAITING_FOR_USER with execution.waiting", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-4" };
      // What a blocking raise_issue does (§8).
      h.registry.get(executionId)!.blockingPending = true;
      yield { type: "turn_done", finalText: "stopping" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("WAITING_FOR_USER");
    expect(row.endedAt).toBeNull();
    expect(await eventTypes(s.executionId)).toContain("execution.waiting");
    await expectCleanedUp(h, s.executionId);
  });

  it("turn ended with no terminal call -> FAILED protocol_violation, task untouched", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-5" };
      yield { type: "turn_done", finalText: "done, I think" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("protocol_violation");
    expect(row.endDetail).toBe(PROTOCOL_VIOLATION_DETAIL);
    expect((await task(s.taskId)).state).toBe("IMPLEMENTING");
    await expectCleanedUp(h, s.executionId);
  });

  it("a spec session stays RUNNING after its turn", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    // A spec execution paused between turns on this host.
    const [spec] = await db
      .insert(executions)
      .values({
        taskId: s.taskId,
        role: "spec",
        attempt: 1,
        state: "WAITING_FOR_USER",
        runtime: "claude",
        model: "default",
        host: HOST,
        sessionId: "spec-sess",
        worktreePath: path.join(workRoot, "work", "spec-x"),
      })
      .returning({ id: executions.id });
    h.adapter.script = async function* () {
      yield { type: "text", delta: "Here is a draft" };
      yield { type: "turn_done", finalText: "Here is a draft" };
    };

    const { done } = await h.runner.resume({ executionId: spec!.id, prompt: "## Message from the user\nhi" });
    await done;

    const row = await execution(spec!.id);
    expect(row.state).toBe("RUNNING");
    expect(h.adapter.resumes[0]!.allowedTools).toBe("spec");
    expect(h.adapter.resumes[0]!.model).toBeUndefined();
    await expectCleanedUp(h, spec!.id);
  });

  it("no turn_done within the blocking grace period: aborts and still moves to WAITING_FOR_USER", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId, signal }) {
      yield { type: "session", sessionId: "sess-6" };
      h.registry.get(executionId)!.blockingPending = true;
      await aborted(signal);
    };

    const started = Date.now();
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(h.adapter.signals[0]!.aborted).toBe(true);
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    await expectCleanedUp(h, s.executionId);
  });

  it("no event within the quiet timeout -> aborted, FAILED agent_hung", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, quietTimeoutMs: 300 });
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-7" };
      // Ignores the abort: a truly hung agent.
      await new Promise(() => {});
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(h.adapter.signals[0]!.aborted).toBe(true);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("agent_hung");
    await expectCleanedUp(h, s.executionId);
  });
});

describe("cancellation (Q8, §6.4)", () => {
  it("a cancel command aborts the live session; the api's CANCELLED stands and the token is revoked", async () => {
    const s = await seedClaimed();
    // Renewal far out, so only the command can abort this run.
    const h = makeRunner({ workerId: s.workerId, leaseRenewMs: 60_000 });
    let sessionUp!: () => void;
    const up = new Promise<void>((r) => (sessionUp = r));
    h.adapter.script = async function* ({ signal }) {
      yield { type: "session", sessionId: "sess-8" };
      sessionUp();
      await aborted(signal);
    };
    const run = h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await up;
    await waitFor(async () =>
      (await execution(s.executionId)).state === "RUNNING" ? true : undefined,
    );

    await cancelViaApi(s.taskId, s.executionId);
    const [cmd] = await db
      .insert(executionCommands)
      .values({ taskId: s.taskId, executionId: s.executionId, type: "cancel", payload: {} })
      .returning({ id: executionCommands.id });
    const commands = createCommandHandlers();
    registerCancelHandler(commands, h.runner);
    const config = loadConfig({ DATABASE_URL: "postgres://x/y", WORKER_HOST: HOST });
    const ctx: TickContext = { db, workerId: s.workerId, config, now: new Date(), tick: 1, logger };
    await createDefaultPhases({ commands }).find((p) => p.name === "consume_commands")!.run(ctx);
    await run;

    expect(h.adapter.signals[0]!.aborted).toBe(true);
    expect(records.some((r) => r.msg === "cancel aborted live session")).toBe(true);
    const row = await execution(s.executionId);
    expect(row.state).toBe("CANCELLED");
    expect(row.endReason).toBeNull();
    expect(row.endedAt).not.toBeNull();
    expect(await eventTypes(s.executionId)).not.toContain("execution.failed");
    const command = await db.query.executionCommands.findFirst({ where: (c, { eq }) => eq(c.id, cmd!.id) });
    expect(command!.completedAt).not.toBeNull();
    await expectCleanedUp(h, s.executionId);
  });

  it("a lease renewal that returns null aborts the session without changing state", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    let sessionUp!: () => void;
    const up = new Promise<void>((r) => (sessionUp = r));
    h.adapter.script = async function* ({ signal }) {
      yield { type: "session", sessionId: "sess-9" };
      sessionUp();
      await aborted(signal);
    };
    const run = h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await up;
    await waitFor(async () =>
      (await execution(s.executionId)).state === "RUNNING" ? true : undefined,
    );

    await cancelViaApi(s.taskId, s.executionId);
    await run;

    expect(h.adapter.signals[0]!.aborted).toBe(true);
    const row = await execution(s.executionId);
    expect(row.state).toBe("CANCELLED");
    expect(row.endReason).toBeNull();
    expect((await task(s.taskId)).state).toBe("CANCELLED");
    await expectCleanedUp(h, s.executionId);
  });
});

describe("resume primitive (§9.3, §9.7)", () => {
  async function waitingExecution(
    options: { leaseRenewMs?: number } = {},
  ): Promise<{ s: Seeded; h: Harness; firstToken: string }> {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, ...options });
    let firstToken = "";
    h.adapter.script = async function* ({ executionId, token }) {
      firstToken = token;
      yield { type: "session", sessionId: "sess-r" };
      yield { type: "usage", model: "claude-opus-test", input: 100, cached: 10, output: 40, costUsd: 0.5 };
      h.registry.get(executionId)!.blockingPending = true;
      yield { type: "turn_done", finalText: "waiting" };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    // A review-round row belongs to another session and stays out of the baseline.
    await db.insert(executionUsage).values({
      executionId: s.executionId,
      kind: "review",
      round: 1,
      runtime: "claude",
      model: "claude-opus-test",
      inputTokens: 999,
      cachedInputTokens: 0,
      outputTokens: 999,
      costUsd: "9",
    });
    return { s, h, firstToken };
  }

  it("canResume false rejects with a typed error and changes nothing", async () => {
    const { s, h } = await waitingExecution();
    h.adapter.canResumeResult = false;
    const before = (await eventsFor(s.executionId)).length;

    const err = await h.runner
      .resume({ executionId: s.executionId, prompt: "answer" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResumeError);
    expect((err as ResumeError).code).toBe("CANNOT_RESUME");
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    expect(await eventsFor(s.executionId)).toHaveLength(before);
    expect(h.adapter.resumes).toHaveLength(0);
    expect(h.runner.isLive(s.executionId)).toBe(false);
  });

  it("canResume true -> RUNNING with execution.resumed, a fresh token, the usage baseline, and the loop runs", async () => {
    const { s, h, firstToken } = await waitingExecution();
    let secondToken = "";
    let stateDuringRun = "";
    h.adapter.script = async function* ({ executionId, token }) {
      secondToken = token;
      stateDuringRun = (await execution(executionId)).state;
      expect((await execution(executionId)).toolsTokenHash).toBe(hashToken(token));
      yield { type: "usage", model: "claude-opus-test", input: 30, cached: 0, output: 10, costUsd: 0.1 };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    const { done } = await h.runner.resume({ executionId: s.executionId, prompt: "## Answer to your issue x\nuse locale" });
    expect(h.runner.isLive(s.executionId)).toBe(true);
    await done;

    expect(stateDuringRun).toBe("RUNNING");
    expect(secondToken).not.toBe("");
    expect(secondToken).not.toBe(firstToken);
    const req = h.adapter.resumes[0]!;
    expect(req.sessionId).toBe("sess-r");
    expect(req.prompt).toContain("use locale");
    expect(req.usageBaseline).toEqual({
      "claude-opus-test": { input: 100, cached: 10, output: 40, costUsd: 0.5 },
    });
    expect(req.cwd).toBe(path.join(workRoot, "work", s.executionId));

    const types = await eventTypes(s.executionId);
    expect(types).toContain("execution.resumed");
    const usage = await db.query.executionUsage.findMany({
      where: (u, { eq }) => eq(u.executionId, s.executionId),
    });
    expect(usage.filter((u) => u.kind === "resume").map((u) => u.inputTokens)).toEqual([30]);
    expect((await execution(s.executionId)).state).toBe("COMPLETED");
    await expectCleanedUp(h, s.executionId);
  });

  it("renews a stale lease in the same transaction that moves the execution to RUNNING (§6.4)", async () => {
    // Renewal far out, so only the resume transaction can touch the lease.
    const { s, h } = await waitingExecution({ leaseRenewMs: 60_000 });
    await db.$client.unsafe(
      "update task_leases set expires_at = now() - interval '1 minute' where execution_id = $1",
      [s.executionId],
    );
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    h.adapter.script = async function* ({ executionId }) {
      await hold;
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    const { done } = await h.runner.resume({ executionId: s.executionId, prompt: "answer" });
    const [row] = await db.$client.unsafe<{ expires_at: Date; lease_xmin: string; resumed_xmin: string }[]>(
      `select l.expires_at, l.xmin::text as lease_xmin,
              (select e.xmin::text from execution_events e
                where e.execution_id = l.execution_id and e.type = 'execution.resumed') as resumed_xmin
         from task_leases l where l.execution_id = $1`,
      [s.executionId],
    );
    release();
    await done;

    expect(new Date(row!.expires_at).getTime()).toBeGreaterThan(Date.now());
    // Written by the transaction that wrote execution.resumed, not a later renewal.
    expect(row!.lease_xmin).toBe(row!.resumed_xmin);
    expect((await execution(s.executionId)).state).toBe("COMPLETED");
  });

  it("resumes a COMPLETED execution on the CI back edge, clearing ended_at", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-ci" };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "PR opened" };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    const completed = await execution(s.executionId);
    expect(completed.state).toBe("COMPLETED");
    expect(completed.endedAt).not.toBeNull();

    let during: { state: string; endedAt: Date | null } | undefined;
    h.adapter.script = async function* ({ executionId }) {
      const row = await execution(executionId);
      during = { state: row.state, endedAt: row.endedAt };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "CI fixed" };
    };
    const { done } = await h.runner.resume({ executionId: s.executionId, prompt: "## CI failed\nfix it" });
    await done;

    expect(during).toEqual({ state: "RUNNING", endedAt: null });
    expect(h.adapter.resumes[0]!.sessionId).toBe("sess-ci");
    const audit = await db.$client.unsafe<{ trigger: string }[]>(
      "select trigger from audit_events where entity_id = $1 and from_state = 'COMPLETED' and to_state = 'RUNNING'",
      [s.executionId],
    );
    expect(audit.map((a) => a.trigger)).toEqual(["resume_with_ci_failure"]);
    expect(await eventTypes(s.executionId)).toContain("execution.resumed");
    expect((await execution(s.executionId)).state).toBe("COMPLETED");
    await expectCleanedUp(h, s.executionId);
  });

  it("refuses a resume while a run is already live for the execution, writing nothing", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, leaseRenewMs: 60_000 });
    let sessionUp!: () => void;
    const up = new Promise<void>((r) => (sessionUp = r));
    h.adapter.script = async function* ({ signal }) {
      yield { type: "session", sessionId: "sess-al" };
      sessionUp();
      await aborted(signal);
    };
    const run = h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await up;
    await waitFor(async () =>
      (await execution(s.executionId)).state === "RUNNING" ? true : undefined,
    );
    const before = await writeSnapshot(s.executionId);

    const err = await h.runner
      .resume({ executionId: s.executionId, prompt: "answer" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResumeError);
    expect((err as ResumeError).code).toBe("ALREADY_LIVE");
    expect(await writeSnapshot(s.executionId)).toEqual(before);
    expect(h.adapter.resumes).toHaveLength(0);
    // The live run is untouched by the refusal.
    expect(h.runner.isLive(s.executionId)).toBe(true);
    expect(h.adapter.signals[0]!.aborted).toBe(false);

    h.runner.abort(s.executionId);
    await run;
  });

  it("refuses a resume of an execution pinned to another host, writing nothing", async () => {
    const { s, h } = await waitingExecution();
    await db.$client.unsafe("update executions set host = 'other-host' where id = $1", [s.executionId]);
    const before = await writeSnapshot(s.executionId);

    const err = await h.runner
      .resume({ executionId: s.executionId, prompt: "answer" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResumeError);
    expect((err as ResumeError).code).toBe("OTHER_HOST");
    expect(await writeSnapshot(s.executionId)).toEqual(before);
    expect(h.adapter.resumes).toHaveLength(0);
    expect(h.runner.isLive(s.executionId)).toBe(false);
  });

  it("refuses a resume whose execution the dead-host release unpinned after the context loaded (§6.1)", async () => {
    const { s, h } = await waitingExecution();
    let before: Awaited<ReturnType<typeof writeSnapshot>> | undefined;
    h.adapter.onCanResume = async () => {
      // The sweeper's release commits between the context load and the lock.
      await db.$client.unsafe(
        "update executions set host = null, worker_id = null where id = $1",
        [s.executionId],
      );
      before = await writeSnapshot(s.executionId);
    };

    const err = await h.runner
      .resume({ executionId: s.executionId, prompt: "answer" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResumeError);
    expect((err as ResumeError).code).toBe("OTHER_HOST");
    const row = await execution(s.executionId);
    expect(row.state).toBe("WAITING_FOR_USER");
    expect(row.host).toBeNull();
    expect(row.toolsTokenHash).toBeNull();
    expect(await eventTypes(s.executionId)).not.toContain("execution.resumed");
    expect(await writeSnapshot(s.executionId)).toEqual(before);
    expect(h.adapter.resumes).toHaveLength(0);
    expect(h.runner.isLive(s.executionId)).toBe(false);
  });

  it("refuses a resume whose worker_id was cleared after the context loaded, host unchanged", async () => {
    const { s, h } = await waitingExecution();
    let before: Awaited<ReturnType<typeof writeSnapshot>> | undefined;
    h.adapter.onCanResume = async () => {
      await db.$client.unsafe("update executions set worker_id = null where id = $1", [s.executionId]);
      before = await writeSnapshot(s.executionId);
    };

    const err = await h.runner
      .resume({ executionId: s.executionId, prompt: "answer" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResumeError);
    expect((err as ResumeError).code).toBe("OTHER_HOST");
    const row = await execution(s.executionId);
    expect(row.state).toBe("WAITING_FOR_USER");
    expect(row.workerId).toBeNull();
    expect(row.toolsTokenHash).toBeNull();
    expect(await eventTypes(s.executionId)).not.toContain("execution.resumed");
    expect(await writeSnapshot(s.executionId)).toEqual(before);
    expect(h.adapter.resumes).toHaveLength(0);
    expect(h.runner.isLive(s.executionId)).toBe(false);
  });

  it("refuses a resume of an execution in a non-resumable state, writing nothing", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-nr" };
      yield { type: "turn_done", finalText: "no terminal call" };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    expect((await execution(s.executionId)).state).toBe("FAILED");
    const before = await writeSnapshot(s.executionId);

    const err = await h.runner
      .resume({ executionId: s.executionId, prompt: "answer" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResumeError);
    expect((err as ResumeError).code).toBe("NOT_RESUMABLE_STATE");
    expect(await writeSnapshot(s.executionId)).toEqual(before);
    expect(h.adapter.resumes).toHaveLength(0);
    expect(h.runner.isLive(s.executionId)).toBe(false);
  });
});

describe("prompts and request (§9.2, AC10)", () => {
  it("builds the prompt from spec and decisions, picks the system prompt, model and PATH, and never stores the token", async () => {
    const s = await seedClaimed({ model: null });
    await seedDecision(s, "Receipt language is device-local");
    const h = makeRunner({ workerId: s.workerId, noMistakes: true });
    h.adapter.script = async function* ({ token, executionId }) {
      yield { type: "session", sessionId: "sess-p" };
      yield { type: "text", delta: `my token is ${token}` };
      yield { type: "tool_call", name: "Bash", input: { command: `echo ${token}` } };
      yield { type: "error", message: `auth failed for ${token}`, retriable: false };
      void executionId;
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const req = h.adapter.starts[0]!;
    expect(req.prompt).toContain("## Approved specification (revision 2)");
    expect(req.prompt).toContain(SPEC.objective);
    expect(req.prompt).toContain("Receipt language is device-local");
    expect(req.prompt).toMatch(/## Ticket\nRUN-\d+: Receipt language/);
    expect(req.prompt).toContain("Setup command: npm ci");
    expect(req.systemPrompt).toBe(IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES);
    expect(req.model).toBeUndefined();
    expect(req.allowedTools).toBe("implementation");
    expect(req.maxBudgetUsd).toBeUndefined();
    expect(req.mcp.url).toBe(TOOLS_URL);
    expect(req.env.PATH).toBe(`${DEFAULT_REVIEW_WRAPPER_BIN}${path.delimiter}${BASE_PATH}`);
    expect(DEFAULT_REVIEW_WRAPPER_BIN.endsWith(path.join("packages", "review-wrapper", "bin"))).toBe(true);
    await expect(fs.stat(path.join(DEFAULT_REVIEW_WRAPPER_BIN, "orchestra-review.js"))).resolves.toBeTruthy();
    expect(req.env.ORCHESTRA_URL).toBe(TOOLS_URL);
    expect(req.env.ORCHESTRA_TOKEN).toBe(req.mcp.token);
    expect(req.env.GITHUB_TOKEN).toBe("gh-token");
    expect(h.prepared[0]!.decisions[0]!.decision).toBe("Receipt language is device-local");

    const token = req.mcp.token;
    const leaks = await db.$client.unsafe(
      "select id from execution_events where payload::text like $1",
      [`%${token}%`],
    );
    expect(leaks).toHaveLength(0);
    const row = await execution(s.executionId);
    expect(row.endDetail ?? "").not.toContain(token);
    expect((await eventTypes(s.executionId))).toContain("agent.message.delta");
  });

  it("without .no-mistakes uses the standard prompt and passes a configured model", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-q" };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect(h.adapter.starts[0]!.systemPrompt).toBe(IMPLEMENTATION_SYSTEM_PROMPT);
    expect(h.adapter.starts[0]!.model).toBe("claude-opus-test");
  });
});

describe("wiring (AC9, §6.3 hand-off)", () => {
  it("a claim in the default claim phase starts the runner", async () => {
    const n = ++seq;
    const [worker] = await db
      .insert(agentWorkers)
      .values({ host: HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: workRoot })
      .returning({ id: agentWorkers.id });
    const [project] = await db
      .insert(projects)
      .values({ key: `WIRE${n}`, name: "wire", jiraJql: "x" })
      .returning({ id: projects.id });
    const [repo] = await db
      .insert(repositories)
      .values({ projectId: project!.id, name: `wire-${n}`, gitUrl: "git@x:y.git", defaultBranch: "main", defaultRuntime: "claude" })
      .returning({ id: repositories.id });
    const [t] = await db
      .insert(tasks)
      .values({ projectId: project!.id, repositoryId: repo!.id, jiraKey: `WIRE-${n}`, jiraSummary: "wire", jiraPriority: 1, jiraCreatedAt: NOW, jiraSyncedAt: NOW, state: "READY" })
      .returning({ id: tasks.id });
    const [rev] = await db
      .insert(specificationRevisions)
      .values({ taskId: t!.id, version: 1, status: "approved", content: SPEC })
      .returning({ id: specificationRevisions.id });
    await db.$client.unsafe("update tasks set approved_revision_id = $1 where id = $2", [rev!.id, t!.id]);

    const h = makeRunner({ workerId: worker!.id });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-w" };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "ok" };
    };
    const config = loadConfig({ DATABASE_URL: "postgres://x/y", WORKER_HOST: HOST });
    const ctx: TickContext = { db, workerId: worker!.id, config, now: new Date(), tick: 1, logger };
    const claim = createDefaultPhases({ runtimes: ["claude"], onClaimed: h.runner.onClaimed }).find(
      (p) => p.name === "claim",
    )!;

    await claim.run(ctx);

    const started = await waitFor(async () => {
      const rows = await db.query.executions.findMany({ where: (e, { eq }) => eq(e.taskId, t!.id) });
      return rows[0]?.state === "COMPLETED" ? rows[0] : undefined;
    });
    expect(h.adapter.starts).toHaveLength(1);
    expect(started.sessionId).toBe("sess-w");
    // Repository with no model: executions.model is 'default', so no model is passed.
    expect(h.adapter.starts[0]!.model).toBeUndefined();
  });
});

describe("shutdown (§15.2)", () => {
  it("aborts every live run and waits for its finally block", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    let sessionUp!: () => void;
    const up = new Promise<void>((r) => (sessionUp = r));
    h.adapter.script = async function* ({ signal }) {
      yield { type: "session", sessionId: "sess-s" };
      sessionUp();
      await aborted(signal);
    };
    void h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await up;

    await h.runner.shutdown(5000);

    expect(h.adapter.signals[0]!.aborted).toBe(true);
    // No state change on shutdown: the lease sweeper owns what happens next.
    expect((await execution(s.executionId)).state).toBe("RUNNING");
    await expectCleanedUp(h, s.executionId);
  });
});
