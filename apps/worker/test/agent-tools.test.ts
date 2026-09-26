import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  RAISE_ISSUE_BLOCKING_INSTRUCTION,
  REVIEW_ROUND_LIMIT_INSTRUCTION,
  type ExecutionState,
  type TaskState,
} from "@orchestra/core";
import {
  agentWorkers,
  executions,
  listActiveExecutionIds,
  projects,
  taskLeases,
  tasks,
  transition,
  type Db,
  type Tx,
} from "@orchestra/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  ASSIGNED_TOOLS,
  authenticate,
  createAgentToolsServer,
  createExecutionRegistry,
  createLiveExecution,
  issueToken,
  LEASE_TTL_MS,
  revokeToken,
  type AgentToolsServer,
  type ExecutionRegistry,
} from "../src/agent-tools/index.js";
import {
  invokeTool,
  type ErasedToolDefinition,
} from "../src/agent-tools/invoke.js";
import { TOOL_DEFINITIONS } from "../src/agent-tools/tools/index.js";
import type { LogFields, Logger } from "../src/logger.js";
import { startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * design.md §8 agent-tools MCP server, exercised end to end: a real
 * Postgres, the real HTTP server on an ephemeral port, and the SDK's own
 * MCP client. Reads go through drizzle's relational query API on the `Db`
 * handle, because `apps/**` may not import drizzle-orm (eslint boundary).
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

/** Every lease is seeded here, so any renewal moves it forward. */
const STALE_LEASE = new Date("2026-01-01T00:00:00.000Z");

let testDb: TestDb;
let db: Db;
let registry: ExecutionRegistry;
let server: AgentToolsServer;
let workerId: string;
const issuedTokens: string[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  const [worker] = await db
    .insert(agentWorkers)
    .values({
      host: "agent-tools-host",
      capabilities: ["node"],
      maxConcurrent: 4,
      workspaceRoot: "/tmp/orchestra",
    })
    .returning({ id: agentWorkers.id });
  workerId = worker!.id;

  registry = createExecutionRegistry();
  server = createAgentToolsServer({
    db,
    registry,
    logger,
    now: () => new Date(),
  });
  await server.start(0, "127.0.0.1");
});

afterEach(async () => {
  while (clients.length > 0) {
    await clients.pop()!.close().catch(() => {});
  }
});

afterAll(async () => {
  await server?.stop();
  await testDb?.stop();
});

// ---------------------------------------------------------------- seeding

interface Seeded {
  projectId: string;
  taskId: string;
  executionId: string;
  token: string;
}

interface SeedOptions {
  role?: "spec" | "implementation";
  taskState: TaskState;
  executionState?: ExecutionState;
  maxReviewRounds?: number;
}

let seq = 0;

async function seed(options: SeedOptions): Promise<Seeded> {
  const n = ++seq;
  const [project] = await db
    .insert(projects)
    .values({
      key: `AT${n}`,
      name: `agent tools ${n}`,
      jiraJql: `project = AT${n}`,
      ...(options.maxReviewRounds === undefined
        ? {}
        : { maxReviewRounds: options.maxReviewRounds }),
    })
    .returning({ id: projects.id });
  const when = new Date("2026-01-01T00:00:00.000Z");
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      jiraKey: `AT-${n}`,
      jiraSummary: `task ${n}`,
      jiraPriority: 3,
      jiraCreatedAt: when,
      jiraSyncedAt: when,
      state: options.taskState,
    })
    .returning({ id: tasks.id });
  const [execution] = await db
    .insert(executions)
    .values({
      taskId: task!.id,
      role: options.role ?? "implementation",
      attempt: 1,
      state: options.executionState ?? "RUNNING",
      runtime: "codex",
      model: "gpt-5-codex",
    })
    .returning({ id: executions.id });
  await db.insert(taskLeases).values({
    taskId: task!.id,
    executionId: execution!.id,
    workerId,
    expiresAt: STALE_LEASE,
  });
  const token = await db.transaction((tx) => issueToken(tx, execution!.id));
  issuedTokens.push(token);
  return {
    projectId: project!.id,
    taskId: task!.id,
    executionId: execution!.id,
    token,
  };
}

// ------------------------------------------------------------------ reads

const getTask = (id: string) =>
  db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) });
const getExecution = (id: string) =>
  db.query.executions.findFirst({ where: (t, { eq }) => eq(t.id, id) });
const getLease = (executionId: string) =>
  db.query.taskLeases.findFirst({
    where: (t, { eq }) => eq(t.executionId, executionId),
  });
const eventsFor = (taskId: string) =>
  db.query.executionEvents.findMany({
    where: (t, { eq }) => eq(t.taskId, taskId),
    orderBy: (t, { asc }) => [asc(t.id)],
  });

/** Every row a tool could write for this task, for "writes nothing" checks. */
async function snapshot(s: Seeded) {
  const [
    events,
    issueRows,
    notificationRows,
    reviewRows,
    prRows,
    revisionRows,
    usageRows,
  ] =
    await Promise.all([
      eventsFor(s.taskId),
      db.query.issues.findMany({ where: (t, { eq }) => eq(t.taskId, s.taskId) }),
      db.query.notifications.findMany({
        where: (t, { eq }) => eq(t.taskId, s.taskId),
      }),
      db.query.reviewResults.findMany({
        where: (t, { eq }) => eq(t.executionId, s.executionId),
      }),
      db.query.pullRequests.findMany({
        where: (t, { eq }) => eq(t.taskId, s.taskId),
      }),
      db.query.specificationRevisions.findMany({
        where: (t, { eq }) => eq(t.taskId, s.taskId),
      }),
      db.query.executionUsage.findMany({
        where: (t, { eq }) => eq(t.executionId, s.executionId),
      }),
    ]);
  const task = await getTask(s.taskId);
  const execution = await getExecution(s.executionId);
  const lease = await getLease(s.executionId);
  return {
    events: events.length,
    issues: issueRows.length,
    notifications: notificationRows.length,
    reviews: reviewRows.length,
    pullRequests: prRows.length,
    revisions: revisionRows.map((r) => JSON.stringify(r.content)),
    usage: usageRows.length,
    totals: [
      execution!.inputTokens,
      execution!.cachedInputTokens,
      execution!.outputTokens,
      execution!.costUsd,
    ],
    taskState: task!.state,
    needsHumanReason: task!.needsHumanReason,
    executionState: execution!.state,
    reviewRounds: execution!.reviewRounds,
    tokenHash: execution!.toolsTokenHash,
    leaseExpiresAt: lease!.expiresAt.getTime(),
  };
}

// ------------------------------------------------------------- mcp client

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "agent-tools-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

type CallResult =
  | { isError: false; data: Record<string, unknown> }
  | { isError: true; code?: string; message: string };

async function callOn(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const text =
    (result.content as Array<{ type: string; text?: string }> | undefined)?.[0]
      ?.text ?? "";
  if (result.isError) {
    try {
      const parsed = JSON.parse(text) as {
        error: { code: string; message: string };
      };
      return { isError: true, ...parsed.error };
    } catch {
      return { isError: true, message: text };
    }
  }
  return {
    isError: false,
    data: result.structuredContent as Record<string, unknown>,
  };
}

async function call(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  return callOn(await connect(token), name, args);
}

function expectOk(result: CallResult): Record<string, unknown> {
  if (result.isError) {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.data;
}

/**
 * AC8: one agent.tool_call row per successful call. The lease moves
 * forward only while the execution is still ASSIGNED or RUNNING, so a tool
 * that ends the execution passes `leaseRenewed: false` (design.md §6.4).
 */
async function expectRecorded(
  s: Seeded,
  tool: string,
  before: number,
  { leaseRenewed = true }: { leaseRenewed?: boolean } = {},
) {
  const events = (await eventsFor(s.taskId)).filter(
    (e) => e.type === "agent.tool_call",
  );
  const calls = events.filter(
    (e) => (e.payload as { tool: string }).tool === tool,
  );
  expect(calls).toHaveLength(1);
  const payload = calls[0]!.payload as {
    tool: string;
    ok: boolean;
    input: unknown;
  };
  expect(payload.ok).toBe(true);
  expect(calls[0]!.executionId).toBe(s.executionId);
  expect(JSON.stringify(payload)).not.toContain(s.token);

  const lease = await getLease(s.executionId);
  if (!leaseRenewed) {
    expect(lease!.expiresAt.getTime()).toBe(before);
    return;
  }
  expect(lease!.expiresAt.getTime()).toBeGreaterThan(before);
  expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now() + LEASE_TTL_MS - 60_000);
}

// ------------------------------------------------------------- fixtures

const RAISE_ARGS = {
  type: "DECISION_REQUIRED",
  severity: "blocking",
  blocking: true,
  title: "Which cache?",
  description: "The spec does not say which cache to use.",
  question: "Redis or in-process?",
  options: [
    { id: "redis", description: "Redis", tradeoff: "new dependency" },
    { id: "memory", description: "In-process", tradeoff: "per-host only" },
  ],
  recommended_option: "memory",
};

const specContent = (objective: string) => ({
  repository: "orchestra",
  objective,
  scope: ["api"],
  out_of_scope: [],
  requirements: ["r1"],
  acceptance_criteria: ["a1"],
  validation: ["v1"],
  constraints: [],
  dependencies: [],
});

/** One valid call per tool, used by the auth and role matrices. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  raise_issue: { ...RAISE_ARGS, blocking: false, severity: "info" },
  report_review_started: { round: 1 },
  report_review_result: { round: 1, verdict: "clean", findings: [] },
  report_usage: {
    kind: "review",
    round: 1,
    model: "gpt-5-codex",
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 30,
    cost_usd: 0.25,
  },
  report_pr_created: {
    url: "https://github.com/goopter/x/pull/1",
    number: 1,
    head_sha: "abc",
  },
  report_complete: { summary: "done" },
  report_failed: { reason: "stuck", detail: "cannot build" },
  propose_spec: specContent("o"),
  note: { text: "hello" },
};

// ================================================================== AC2

describe("tokens (design.md §8)", () => {
  it("issueToken returns a 43-char base64url token and stores its sha256 hex", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });

    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const execution = await getExecution(s.executionId);
    expect(execution!.toolsTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(execution!.toolsTokenHash).toBe(
      createHash("sha256").update(s.token).digest("hex"),
    );
    expect(execution!.toolsTokenHash).not.toContain(s.token);
  });

  it("authenticate accepts the token while RUNNING and returns execution, task and project", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });

    const ctx = await authenticate(db, s.token);

    expect(ctx?.execution.id).toBe(s.executionId);
    expect(ctx?.task.id).toBe(s.taskId);
    expect(ctx?.project.id).toBe(s.projectId);
  });

  it("authenticate rejects after revokeToken", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    await db.transaction((tx) => revokeToken(tx, s.executionId));

    expect(await authenticate(db, s.token)).toBeNull();
    expect((await getExecution(s.executionId))!.toolsTokenHash).toBeNull();
  });

  it("authenticate rejects a wrong or empty token", async () => {
    await seed({ taskState: "IMPLEMENTING" });

    expect(await authenticate(db, "x".repeat(43))).toBeNull();
    expect(await authenticate(db, "")).toBeNull();
  });

  it("authenticate rejects when the execution is COMPLETED", async () => {
    const s = await seed({
      taskState: "CI_RUNNING",
      executionState: "COMPLETED",
    });

    expect(await authenticate(db, s.token)).toBeNull();
    expect(await authenticate(db, s.token, "note")).toBeNull();
  });

  it("while ASSIGNED only raise_issue and note authenticate", async () => {
    const s = await seed({
      taskState: "IMPLEMENTING",
      executionState: "ASSIGNED",
    });

    expect([...ASSIGNED_TOOLS].sort()).toEqual(["note", "raise_issue"]);
    expect(await authenticate(db, s.token)).toBeNull();
    expect(await authenticate(db, s.token, "note")).not.toBeNull();
    expect(await authenticate(db, s.token, "raise_issue")).not.toBeNull();
    expect(await authenticate(db, s.token, "report_failed")).toBeNull();
    expect(await authenticate(db, s.token, "report_pr_created")).toBeNull();
  });
});

// ================================================================== AC3

describe("HTTP gate", () => {
  it("rejects a request with no bearer token with 401 and never echoes a token", async () => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects an unknown bearer token with 401", async () => {
    await expect(connect("not-a-real-token")).rejects.toThrow(/401|UNAUTHORIZED/);
  });

  it("lists exactly the nine tools with their core schemas", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    const client = await connect(s.token);

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "note",
      "propose_spec",
      "raise_issue",
      "report_complete",
      "report_failed",
      "report_pr_created",
      "report_review_result",
      "report_review_started",
      "report_usage",
    ]);
    const raise = tools.find((t) => t.name === "raise_issue")!;
    expect(raise.inputSchema.required).toEqual(
      expect.arrayContaining(["type", "severity", "blocking", "title", "description"]),
    );
    expect(raise.outputSchema).toBeDefined();
  });
});

describe("auth errors write nothing (AC3)", () => {
  for (const tool of Object.keys(VALID_ARGS)) {
    it(`${tool} with a revoked token returns an auth error and writes nothing`, async () => {
      const role = tool === "report_complete" || tool === "propose_spec"
        ? "spec"
        : "implementation";
      const s = await seed({
        role,
        taskState: role === "spec" ? "SPEC_IN_PROGRESS" : "REVIEWING",
      });
      const client = await connect(s.token);
      await db.transaction((tx) => revokeToken(tx, s.executionId));
      const before = await snapshot(s);

      await expect(callOn(client, tool, VALID_ARGS[tool]!)).rejects.toThrow(
        /401|UNAUTHORIZED/,
      );

      expect(await snapshot(s)).toEqual(before);
    });
  }

  it("a token whose execution is no longer RUNNING gets UNAUTHORIZED as a tool error", async () => {
    // The hash is normally nulled when the execution leaves RUNNING; this
    // covers a runner that forgot to revoke.
    const s = await seed({
      taskState: "CI_RUNNING",
      executionState: "COMPLETED",
    });
    const before = await snapshot(s);

    const result = await call(s.token, "note", { text: "late" });

    expect(result).toMatchObject({ isError: true, code: "UNAUTHORIZED" });
    expect(await snapshot(s)).toEqual(before);
  });
});

describe("re-authorisation inside the tool transaction", () => {
  // The execution leaves RUNNING and the token is revoked after the
  // pre-check passed but before the tool's transaction starts. The tool
  // must re-check under a row lock and write nothing.
  for (const tool of ["note", "raise_issue"] as const) {
    it(`${tool} authenticated while RUNNING, revoked before its transaction: UNAUTHORIZED, writes nothing`, async () => {
      const s = await seed({ taskState: "IMPLEMENTING" });
      const def = TOOL_DEFINITIONS.find((d) => d.name === tool)!;
      let afterRevoke: Awaited<ReturnType<typeof snapshot>> | undefined;

      const result = await invokeTool(
        def as unknown as ErasedToolDefinition,
        VALID_ARGS[tool]!,
        s.token,
        {
          db,
          registry,
          logger,
          now: () => new Date(),
          afterAuthenticate: async () => {
            await db.transaction(async (tx) => {
              await transition(tx, {
                entity: "execution",
                id: s.executionId,
                trigger: "execution.completed",
                actor: { kind: "system" },
                set: { endedAt: new Date() },
              });
              await revokeToken(tx, s.executionId);
            });
            afterRevoke = await snapshot(s);
          },
        },
      );

      expect(afterRevoke).toBeDefined();
      expect(afterRevoke!.executionState).toBe("COMPLETED");
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(text)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
      expect(await snapshot(s)).toEqual(afterRevoke);
    });
  }
});

// ------------------------------------------- lock order against cancel

/**
 * The api cancel route, statement for statement (apps/api/src/routes/
 * tasks.ts `POST /tasks/:id/cancel`): task -> CANCELLED, then every active
 * execution -> CANCELLED, in one transaction. It locks the task row first,
 * then the execution rows. `pause` runs between the two, holding the task
 * lock.
 */
async function cancelLikeApi(
  tx: Tx,
  taskId: string,
  pause?: () => Promise<void>,
): Promise<void> {
  const actor = { kind: "user" as const };
  await transition(tx, {
    entity: "task",
    id: taskId,
    trigger: "task.cancelled",
    actor,
  });
  await pause?.();
  for (const executionId of await listActiveExecutionIds(tx, taskId)) {
    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.cancelled",
      actor,
    });
  }
}

/** Backends in this database currently blocked on a lock. */
async function lockWaiters(): Promise<number> {
  const [row] = await db.$client<{ n: number }[]>`
    select count(distinct l.pid)::int as n
    from pg_locks l
    join pg_stat_activity a on a.pid = l.pid
    where not l.granted and a.datname = current_database()
  `;
  return row!.n;
}

function untilLockWaiters(n: number): Promise<true> {
  return waitFor(async () => ((await lockWaiters()) >= n ? true : undefined), {
    everyMs: 10,
    what: `${n} backend(s) blocked on a lock`,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Postgres SQLSTATE of an error, unwrapping drizzle's query error. */
function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

/**
 * `db` for the tool side of a race: identical, except that it remembers
 * the SQLSTATE of every transaction that throws, so a tool INTERNAL can be
 * traced to its cause (40P01 is a deadlock).
 */
function recordingDb(failures: string[]): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return async (...args: Parameters<Db["transaction"]>) => {
        try {
          return await target.transaction(...args);
        } catch (err) {
          failures.push(sqlState(err) ?? "no sqlstate");
          throw err;
        }
      };
    },
  });
}

/**
 * What each side of the race ended with, in one comparable value. A
 * deadlock shows up as `cancel: "error 40P01"` or as `tool: "INTERNAL
 * (40P01)"`.
 */
function describeRace(
  toolResult: Awaited<ReturnType<typeof invokeTool>>,
  toolFailures: string[],
  cancel: PromiseSettledResult<void>,
) {
  let tool: string;
  if (toolResult.isError) {
    const text = (toolResult.content as Array<{ text: string }>)[0]!.text;
    const code = (JSON.parse(text) as { error: { code: string } }).error.code;
    // Only Postgres SQLSTATEs (five characters), not a TransitionError's code.
    const causes = toolFailures.filter((f) => /^[0-9A-Z]{5}$/.test(f));
    tool = causes.length > 0 ? `${code} (${causes.join(", ")})` : code;
  } else {
    tool = "ok";
  }
  return {
    tool,
    cancel:
      cancel.status === "fulfilled"
        ? "ok"
        : `error ${sqlState(cancel.reason) ?? String(cancel.reason)}`,
  };
}

/**
 * `firstInsert` is the table of the tool's first insert. The tool-first
 * case parks the tool there, after its explicit locks and before any
 * foreign-key check could lock the task on its behalf.
 */
const RACE_TOOLS: Array<{
  tool: "note" | "report_pr_created";
  taskState: TaskState;
  effect: string;
  firstInsert: "execution_events" | "pull_requests";
}> = [
  {
    tool: "note",
    taskState: "IMPLEMENTING",
    effect: "agent.note",
    firstInsert: "execution_events",
  },
  {
    tool: "report_pr_created",
    taskState: "REVIEWING",
    effect: "pull_request.created",
    firstInsert: "pull_requests",
  },
];

describe("lock order: agent tool vs api cancel (design.md §5, §8)", () => {
  for (const { tool, taskState, effect, firstInsert } of RACE_TOOLS) {
    it(`${tool}: cancel holds the task lock first -> cancel commits, tool gets UNAUTHORIZED and writes nothing`, async () => {
      const s = await seed({ taskState });
      const def = TOOL_DEFINITIONS.find((d) => d.name === tool)!;
      const taskLocked = deferred();
      const release = deferred();
      let cancel: Promise<void> | undefined;
      const toolFailures: string[] = [];

      const toolCall = invokeTool(
        def as unknown as ErasedToolDefinition,
        VALID_ARGS[tool]!,
        s.token,
        {
          db: recordingDb(toolFailures),
          registry,
          logger,
          now: () => new Date(),
          // Authenticated while RUNNING. Before the tool's transaction
          // opens, the cancel takes the task row lock and holds it.
          afterAuthenticate: async () => {
            cancel = db.transaction((tx) =>
              cancelLikeApi(tx, s.taskId, async () => {
                taskLocked.resolve();
                await release.promise;
              }),
            );
            await Promise.race([taskLocked.promise, cancel]);
          },
        },
      );

      // The tool's transaction is now blocked behind the cancel's task
      // lock. Only then let the cancel go on to lock the execution.
      await untilLockWaiters(1);
      release.resolve();

      const [toolResult, cancelResult] = await Promise.all([
        toolCall,
        Promise.allSettled([cancel!]).then(([r]) => r!),
      ]);

      expect(describeRace(toolResult, toolFailures, cancelResult)).toEqual({
        tool: "UNAUTHORIZED",
        cancel: "ok",
      });
      expect((await getTask(s.taskId))!.state).toBe("CANCELLED");
      expect((await getExecution(s.executionId))!.state).toBe("CANCELLED");
      const types = (await eventsFor(s.taskId)).map((e) => e.type);
      expect(types).not.toContain(effect);
      expect(types).not.toContain("agent.tool_call");
      expect(
        await db.query.pullRequests.findMany({
          where: (t, { eq }) => eq(t.taskId, s.taskId),
        }),
      ).toHaveLength(0);
      expect((await getLease(s.executionId))!.expiresAt.getTime()).toBe(
        STALE_LEASE.getTime(),
      );
    });

    it(`${tool}: tool holds its locks first -> tool commits, then cancel succeeds`, async () => {
      const s = await seed({ taskState });
      const def = TOOL_DEFINITIONS.find((d) => d.name === tool)!;

      // Park the tool mid-transaction: it takes its row locks, then waits
      // on this table lock at its first insert.
      const held = deferred();
      const release = deferred();
      const blocker = db.$client.begin(async (sql) => {
        await sql`lock table ${sql(firstInsert)} in share mode`;
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const toolFailures: string[] = [];

      const toolCall = invokeTool(
        def as unknown as ErasedToolDefinition,
        VALID_ARGS[tool]!,
        s.token,
        { db: recordingDb(toolFailures), registry, logger, now: () => new Date() },
      );
      await untilLockWaiters(1);

      const cancel = db.transaction((tx) => cancelLikeApi(tx, s.taskId));
      await untilLockWaiters(2);
      release.resolve();
      await blocker;

      const [toolResult, cancelResult] = await Promise.all([
        toolCall,
        Promise.allSettled([cancel]).then(([r]) => r!),
      ]);

      expect(describeRace(toolResult, toolFailures, cancelResult)).toEqual({
        tool: "ok",
        cancel: "ok",
      });
      expect((await getTask(s.taskId))!.state).toBe("CANCELLED");
      expect((await getExecution(s.executionId))!.state).toBe(
        tool === "note" ? "CANCELLED" : "COMPLETED",
      );
      const types = (await eventsFor(s.taskId)).map((e) => e.type);
      expect(types).toContain(effect);
    });
  }

  it("record() for a failed call while cancel holds the task lock -> both commit, no deadlock", async () => {
    // record()'s event insert runs one foreign-key check per referenced
    // row, in constraint creation order. Migration 0000 creates the task
    // constraint first, so on the committed schema that check alone locks
    // the task before the execution. Recreate the task constraint so its
    // check runs last, as a later migration could, leaving record()'s
    // explicit locks as the only thing that keeps the order.
    await recreateEventForeignKey("task_id");
    onTestFinished(() => recreateEventForeignKey("execution_id"));

    // REVIEWING has no review.started edge, so the call fails with
    // ILLEGAL_TRANSITION and record() runs with ok:false.
    const s = await seed({ taskState: "REVIEWING" });
    const def = TOOL_DEFINITIONS.find((d) => d.name === "report_review_started")!;
    const taskLocked = deferred();
    const release = deferred();
    let cancel: Promise<void> | undefined;
    const toolFailures: string[] = [];

    // renewLease runs right before record()'s transaction. After renewing,
    // the cancel takes the task row lock and holds it.
    const base = createLiveExecution(
      { executionId: s.executionId, taskId: s.taskId, role: "implementation" },
      { db, now: () => new Date() },
    );
    const liveRegistry = createExecutionRegistry();
    liveRegistry.set({
      ...base,
      renewLease: async () => {
        await base.renewLease();
        cancel = db.transaction((tx) =>
          cancelLikeApi(tx, s.taskId, async () => {
            taskLocked.resolve();
            await release.promise;
          }),
        );
        await Promise.race([taskLocked.promise, cancel]);
      },
    });

    const toolCall = invokeTool(
      def as unknown as ErasedToolDefinition,
      { round: 1 },
      s.token,
      {
        db: recordingDb(toolFailures),
        registry: liveRegistry,
        logger,
        now: () => new Date(),
      },
    );

    // record()'s transaction is now blocked behind the cancel's task lock.
    // Only then let the cancel go on to lock the execution.
    await untilLockWaiters(1);
    release.resolve();

    const [toolResult, cancelResult] = await Promise.all([
      toolCall,
      Promise.allSettled([cancel!]).then(([r]) => r!),
    ]);

    expect(describeRace(toolResult, toolFailures, cancelResult)).toEqual({
      tool: "ILLEGAL_TRANSITION",
      cancel: "ok",
    });
    expect((await getTask(s.taskId))!.state).toBe("CANCELLED");
    expect((await getExecution(s.executionId))!.state).toBe("CANCELLED");
    const calls = (await eventsFor(s.taskId)).filter(
      (e) => e.type === "agent.tool_call",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toMatchObject({
      tool: "report_review_started",
      ok: false,
      error: "ILLEGAL_TRANSITION",
    });
  });
});

/**
 * Drops and re-adds one of `execution_events`' foreign keys, unchanged.
 * The re-added constraint gets a newer trigger, so its check now runs
 * after the other one's on insert.
 */
async function recreateEventForeignKey(
  column: "task_id" | "execution_id",
): Promise<void> {
  const target = column === "task_id" ? "tasks" : "executions";
  const name = `execution_events_${column}_${target}_id_fk`;
  await db.$client.unsafe(
    `alter table execution_events drop constraint ${name}, ` +
      `add constraint ${name} foreign key (${column}) references ${target}(id)`,
  );
}

// ------------------------------------------ lease after a failed call

describe("lease renewal after a failed call (design.md §6.4, §8)", () => {
  it("a failed call on an execution cancelled before renewal leaves the lease alone and still records ok:false", async () => {
    // REVIEWING has no review.started edge, so the call fails with
    // ILLEGAL_TRANSITION. The cancel commits between the rollback and the
    // lease renewal.
    const s = await seed({ taskState: "REVIEWING" });
    const base = createLiveExecution(
      { executionId: s.executionId, taskId: s.taskId, role: "implementation" },
      { db, now: () => new Date() },
    );
    registry.set({
      ...base,
      renewLease: async () => {
        await db.transaction((tx) => cancelLikeApi(tx, s.taskId));
        await base.renewLease();
      },
    });

    const result = await call(s.token, "report_review_started", { round: 1 });

    expect(result).toMatchObject({ isError: true, code: "ILLEGAL_TRANSITION" });
    expect((await getExecution(s.executionId))!.state).toBe("CANCELLED");
    expect((await getLease(s.executionId))!.expiresAt.getTime()).toBe(
      STALE_LEASE.getTime(),
    );
    const calls = (await eventsFor(s.taskId)).filter(
      (e) => e.type === "agent.tool_call",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toMatchObject({
      tool: "report_review_started",
      ok: false,
      error: "ILLEGAL_TRANSITION",
    });
    registry.delete(s.executionId);
  });
});

describe("role checks write nothing (AC3)", () => {
  const wrongRole: Array<[string, "spec" | "implementation", TaskState]> = [
    ["report_review_started", "spec", "SPEC_IN_PROGRESS"],
    ["report_review_result", "spec", "SPEC_IN_PROGRESS"],
    ["report_usage", "spec", "SPEC_IN_PROGRESS"],
    ["report_pr_created", "spec", "SPEC_IN_PROGRESS"],
    ["report_complete", "implementation", "IMPLEMENTING"],
    ["propose_spec", "implementation", "IMPLEMENTING"],
  ];

  for (const [tool, role, taskState] of wrongRole) {
    it(`${tool} from a ${role} execution returns FORBIDDEN and writes nothing`, async () => {
      const s = await seed({ role, taskState });
      const before = await snapshot(s);

      const result = await call(s.token, tool, VALID_ARGS[tool]!);

      expect(result).toMatchObject({ isError: true, code: "FORBIDDEN" });
      expect(await snapshot(s)).toEqual(before);
    });
  }
});

// ============================================================= AC3 + AC4

describe("raise_issue", () => {
  it("blocking: inserts issue, event and notification, sets blockingPending, returns the stop instruction", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    registry.set(
      createLiveExecution(
        { executionId: s.executionId, taskId: s.taskId, role: "implementation" },
        { db, now: () => new Date() },
      ),
    );
    const before = await snapshot(s);

    const data = expectOk(await call(s.token, "raise_issue", RAISE_ARGS));

    expect(data.instruction).toBe(RAISE_ISSUE_BLOCKING_INSTRUCTION);
    expect(data.instruction).toBe(
      "Stop now. End your turn without further work. You will be resumed with the answer.",
    );
    expect(registry.get(s.executionId)!.blockingPending).toBe(true);

    const issue = await db.query.issues.findFirst({
      where: (t, { eq }) => eq(t.id, data.issue_id as string),
    });
    expect(issue).toMatchObject({
      taskId: s.taskId,
      executionId: s.executionId,
      type: "DECISION_REQUIRED",
      severity: "blocking",
      blocking: true,
      title: "Which cache?",
      question: "Redis or in-process?",
      suggestedOptions: RAISE_ARGS.options,
      recommendedOption: "memory",
      status: "OPEN",
    });
    const notifications = await db.query.notifications.findMany({
      where: (t, { eq }) => eq(t.issueId, issue!.id),
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      userId: null,
      taskId: s.taskId,
      kind: "issue_raised",
      title: "Which cache?",
    });
    const created = (await eventsFor(s.taskId)).filter(
      (e) => e.type === "issue.created",
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ issue_id: issue!.id });
    // A blocking issue does not change the task (design.md §5.3).
    expect((await getTask(s.taskId))!.state).toBe("IMPLEMENTING");

    await expectRecorded(s, "raise_issue", before.leaseExpiresAt);
    registry.delete(s.executionId);
  });

  it("non-blocking: records the issue and does not set blockingPending", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    registry.set(
      createLiveExecution(
        { executionId: s.executionId, taskId: s.taskId, role: "implementation" },
        { db, now: () => new Date() },
      ),
    );

    const data = expectOk(
      await call(s.token, "raise_issue", {
        ...RAISE_ARGS,
        blocking: false,
        severity: "warning",
      }),
    );

    expect(data.instruction).not.toBe(RAISE_ISSUE_BLOCKING_INSTRUCTION);
    expect(registry.get(s.executionId)!.blockingPending).toBe(false);
    const issue = await db.query.issues.findFirst({
      where: (t, { eq }) => eq(t.id, data.issue_id as string),
    });
    expect(issue).toMatchObject({ blocking: false, status: "OPEN" });
    registry.delete(s.executionId);
  });

  it("is allowed from a spec execution and while ASSIGNED", async () => {
    const spec = await seed({ role: "spec", taskState: "SPEC_IN_PROGRESS" });
    expectOk(await call(spec.token, "raise_issue", VALID_ARGS.raise_issue!));

    const assigned = await seed({
      taskState: "IMPLEMENTING",
      executionState: "ASSIGNED",
    });
    expectOk(await call(assigned.token, "raise_issue", VALID_ARGS.raise_issue!));
  });

  it("an input that embeds the token is redacted before it is stored", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });

    const data = expectOk(
      await call(s.token, "raise_issue", {
        ...VALID_ARGS.raise_issue,
        description: `my token is ${s.token}`,
      }),
    );

    const issue = await db.query.issues.findFirst({
      where: (t, { eq }) => eq(t.id, data.issue_id as string),
    });
    expect(issue!.description).not.toContain(s.token);
    for (const event of await eventsFor(s.taskId)) {
      expect(JSON.stringify(event.payload)).not.toContain(s.token);
    }
  });
});

// ================================================================= AC3

describe("report_review_started", () => {
  it("moves the task IMPLEMENTING -> REVIEWING and writes review.started", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    const before = await snapshot(s);

    expectOk(await call(s.token, "report_review_started", { round: 1 }));

    expect((await getTask(s.taskId))!.state).toBe("REVIEWING");
    const events = await eventsFor(s.taskId);
    expect(events.find((e) => e.type === "review.started")!.payload).toMatchObject({
      round: 1,
    });
    expect(
      events.find((e) => e.type === "task.state_changed")!.payload,
    ).toMatchObject({
      from: "IMPLEMENTING",
      to: "REVIEWING",
      trigger: "review.started",
      actor: { kind: "agent" },
    });
    await expectRecorded(s, "report_review_started", before.leaseExpiresAt);
  });

  it("returns ILLEGAL_TRANSITION from the wrong task state and rolls the event back", async () => {
    const s = await seed({ taskState: "REVIEWING" });

    const result = await call(s.token, "report_review_started", { round: 1 });

    expect(result).toMatchObject({ isError: true, code: "ILLEGAL_TRANSITION" });
    const events = await eventsFor(s.taskId);
    expect(events.filter((e) => e.type === "review.started")).toHaveLength(0);
    const recorded = events.filter((e) => e.type === "agent.tool_call");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      tool: "report_review_started",
      ok: false,
      error: "ILLEGAL_TRANSITION",
    });
    // The execution is still RUNNING, so the failed call renews the lease.
    expect((await getExecution(s.executionId))!.state).toBe("RUNNING");
    expect((await getLease(s.executionId))!.expiresAt.getTime()).toBeGreaterThan(
      STALE_LEASE.getTime(),
    );
  });
});

// ================================================================= AC5

describe("report_review_result", () => {
  it("findings: inserts review_results, moves REVIEWING -> IMPLEMENTING, increments review_rounds", async () => {
    const s = await seed({ taskState: "REVIEWING" });
    const before = await snapshot(s);
    const findings = [
      { severity: "warning", file: "a.ts", line: 3, description: "d", action: "fix" },
    ];

    const data = expectOk(
      await call(s.token, "report_review_result", {
        round: 1,
        verdict: "findings",
        findings,
      }),
    );

    expect(data.ok).toBe(true);
    expect(data.instruction).toBeUndefined();
    expect((await getTask(s.taskId))!.state).toBe("IMPLEMENTING");
    expect((await getExecution(s.executionId))!.reviewRounds).toBe(1);
    const reviews = await db.query.reviewResults.findMany({
      where: (t, { eq }) => eq(t.executionId, s.executionId),
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      round: 1,
      verdict: "findings",
      findings,
      reviewerRuntime: "codex",
    });
    const result = (await eventsFor(s.taskId)).find(
      (e) => e.type === "review.result",
    );
    expect(result!.payload).toMatchObject({
      round: 1,
      verdict: "findings",
      review_result_id: reviews[0]!.id,
    });
    await expectRecorded(s, "report_review_result", before.leaseExpiresAt);
  });

  it("clean: records the result and leaves task and execution state alone", async () => {
    const s = await seed({ taskState: "REVIEWING" });

    const data = expectOk(
      await call(s.token, "report_review_result", {
        round: 2,
        verdict: "clean",
        findings: [],
      }),
    );

    expect(data.instruction).toBeUndefined();
    const task = await getTask(s.taskId);
    const execution = await getExecution(s.executionId);
    expect(task!.state).toBe("REVIEWING");
    expect(execution!.state).toBe("RUNNING");
    expect(execution!.reviewRounds).toBe(0);
    expect(
      await db.query.reviewResults.findMany({
        where: (t, { eq }) => eq(t.executionId, s.executionId),
      }),
    ).toHaveLength(1);
  });

  it("ask_user: no transition, instructs the agent to call raise_issue", async () => {
    const s = await seed({ taskState: "REVIEWING" });

    const data = expectOk(
      await call(s.token, "report_review_result", {
        round: 1,
        verdict: "ask_user",
        findings: [{ severity: "blocking", description: "?", action: "ask" }],
      }),
    );

    expect(data.instruction).toMatch(/raise_issue/);
    expect((await getTask(s.taskId))!.state).toBe("REVIEWING");
  });

  it("round > max_review_rounds: returns the stop instruction and moves the task to NEEDS_HUMAN", async () => {
    const s = await seed({ taskState: "REVIEWING", maxReviewRounds: 2 });
    const before = await snapshot(s);

    const data = expectOk(
      await call(s.token, "report_review_result", {
        round: 3,
        verdict: "findings",
        findings: [{ severity: "warning", description: "d", action: "a" }],
      }),
    );

    expect(data.instruction).toBe(REVIEW_ROUND_LIMIT_INSTRUCTION);
    const task = await getTask(s.taskId);
    expect(task!.state).toBe("NEEDS_HUMAN");
    expect(task!.needsHumanReason).toMatch(/review round limit/i);
    // The limit, not the findings edge, decides: no review_rounds++.
    expect((await getExecution(s.executionId))!.reviewRounds).toBe(0);
    expect(
      (await eventsFor(s.taskId)).find((e) => e.type === "task.state_changed")!
        .payload,
    ).toMatchObject({ to: "NEEDS_HUMAN", trigger: "task.escalated" });
    await expectRecorded(s, "report_review_result", before.leaseExpiresAt);
  });

  it("round == max_review_rounds is still within the limit", async () => {
    const s = await seed({ taskState: "REVIEWING", maxReviewRounds: 2 });

    const data = expectOk(
      await call(s.token, "report_review_result", {
        round: 2,
        verdict: "findings",
        findings: [],
      }),
    );

    expect(data.instruction).toBeUndefined();
    expect((await getTask(s.taskId))!.state).toBe("IMPLEMENTING");
  });
});

describe("report_review_result usage_id (design.md §9.7, §9.8)", () => {
  async function reportUsage(s: Seeded): Promise<string> {
    const data = expectOk(
      await call(s.token, "report_usage", VALID_ARGS.report_usage!),
    );
    return data.usage_id as string;
  }

  it("stores the usage_id on the review_results row", async () => {
    const s = await seed({ taskState: "REVIEWING" });
    const usageId = await reportUsage(s);

    expectOk(
      await call(s.token, "report_review_result", {
        round: 1,
        verdict: "clean",
        findings: [],
        usage_id: usageId,
      }),
    );

    const [review] = await db.query.reviewResults.findMany({
      where: (t, { eq }) => eq(t.executionId, s.executionId),
    });
    expect(review!.usageId).toBe(usageId);
  });

  it("without usage_id stores null", async () => {
    const s = await seed({ taskState: "REVIEWING" });

    expectOk(await call(s.token, "report_review_result", VALID_ARGS.report_review_result!));

    const [review] = await db.query.reviewResults.findMany({
      where: (t, { eq }) => eq(t.executionId, s.executionId),
    });
    expect(review!.usageId).toBeNull();
  });

  it("a usage_id from another execution is a tool error and writes nothing", async () => {
    const other = await seed({ taskState: "REVIEWING" });
    const foreign = await reportUsage(other);
    const s = await seed({ taskState: "REVIEWING" });
    const before = await snapshot(s);

    const result = await call(s.token, "report_review_result", {
      round: 1,
      verdict: "findings",
      findings: [{ severity: "warning", description: "d", action: "a" }],
      usage_id: foreign,
    });

    expect(result.isError).toBe(true);
    const after = await snapshot(s);
    // Only the failed call's own agent.tool_call record and lease renewal.
    expect({ ...after, events: before.events, leaseExpiresAt: 0 }).toEqual({
      ...before,
      leaseExpiresAt: 0,
    });
    const calls = (await eventsFor(s.taskId)).filter(
      (e) => e.type === "agent.tool_call",
    );
    expect(calls.map((e) => (e.payload as { ok: boolean }).ok)).toEqual([false]);
  });

  for (const [label, usageId] of [
    ["an unknown uuid", "00000000-0000-4000-8000-000000000000"],
    ["a non-uuid string", "not-a-uuid"],
  ] as const) {
    it(`${label} as usage_id is a tool error and writes nothing`, async () => {
      const s = await seed({ taskState: "REVIEWING" });
      const before = await snapshot(s);

      const result = await call(s.token, "report_review_result", {
        round: 1,
        verdict: "clean",
        findings: [],
        usage_id: usageId,
      });

      expect(result.isError).toBe(true);
      const after = await snapshot(s);
      expect({ ...after, events: before.events, leaseExpiresAt: 0 }).toEqual({
        ...before,
        leaseExpiresAt: 0,
      });
    });
  }
});

describe("report_usage (design.md §9.7)", () => {
  it("inserts execution_usage with the execution's runtime, adds to the totals, writes usage.recorded", async () => {
    const s = await seed({ taskState: "REVIEWING" });
    const before = await snapshot(s);

    const data = expectOk(
      await call(s.token, "report_usage", VALID_ARGS.report_usage!),
    );

    expect(typeof data.usage_id).toBe("string");
    const rows = await db.query.executionUsage.findMany({
      where: (t, { eq }) => eq(t.executionId, s.executionId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: data.usage_id,
      kind: "review",
      round: 1,
      // seed() creates codex executions; the runtime comes from the row,
      // not the caller.
      runtime: "codex",
      model: "gpt-5-codex",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
    });
    expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.25, 6);

    const execution = await getExecution(s.executionId);
    expect(execution).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
    });
    expect(Number(execution!.costUsd)).toBeCloseTo(0.25, 6);

    const recorded = (await eventsFor(s.taskId)).filter(
      (e) => e.type === "usage.recorded",
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.executionId).toBe(s.executionId);
    expect(recorded[0]!.payload).toEqual({
      usage_id: data.usage_id,
      kind: "review",
      round: 1,
      model: "gpt-5-codex",
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 30,
      cost_usd: 0.25,
    });
    // No state change.
    expect((await getTask(s.taskId))!.state).toBe("REVIEWING");
    await expectRecorded(s, "report_usage", before.leaseExpiresAt);
  });

  it("accumulates the executions totals across calls and stores a missing round as null", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });

    expectOk(await call(s.token, "report_usage", VALID_ARGS.report_usage!));
    const { round, ...noRound } = VALID_ARGS.report_usage!;
    void round;
    const second = expectOk(
      await call(s.token, "report_usage", {
        ...noRound,
        kind: "main",
        input_tokens: 1,
        cached_input_tokens: 2,
        output_tokens: 3,
        cost_usd: 0.5,
      }),
    );

    const execution = await getExecution(s.executionId);
    expect(execution).toMatchObject({
      inputTokens: 101,
      cachedInputTokens: 22,
      outputTokens: 33,
    });
    expect(Number(execution!.costUsd)).toBeCloseTo(0.75, 6);
    const row = await db.query.executionUsage.findFirst({
      where: (t, { eq }) => eq(t.id, second.usage_id as string),
    });
    expect(row).toMatchObject({ kind: "main", round: null });
  });

  it("an invalid input writes nothing", async () => {
    const s = await seed({ taskState: "REVIEWING" });
    const before = await snapshot(s);

    const result = await call(s.token, "report_usage", {
      ...VALID_ARGS.report_usage!,
      input_tokens: -1,
    });

    expect(result.isError).toBe(true);
    expect(await snapshot(s)).toEqual(before);
  });
});

// ================================================================= AC6

describe("report_pr_created", () => {
  it("inserts the PR, moves task to CI_RUNNING and execution to COMPLETED, and revokes the token", async () => {
    const s = await seed({ taskState: "REVIEWING" });
    const before = await snapshot(s);
    const client = await connect(s.token);

    expectOk(
      await callOn(client, "report_pr_created", {
        url: "https://github.com/goopter/orchestra/pull/42",
        number: 42,
        head_sha: "deadbeef",
      }),
    );

    const prs = await db.query.pullRequests.findMany({
      where: (t, { eq }) => eq(t.taskId, s.taskId),
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      executionId: s.executionId,
      number: 42,
      url: "https://github.com/goopter/orchestra/pull/42",
      headSha: "deadbeef",
      state: "open",
      ciState: "pending",
    });
    expect(prs[0]!.lastPolledAt).toBeInstanceOf(Date);
    expect((await getTask(s.taskId))!.state).toBe("CI_RUNNING");
    const execution = await getExecution(s.executionId);
    expect(execution!.state).toBe("COMPLETED");
    expect(execution!.endedAt).toBeInstanceOf(Date);
    expect(execution!.toolsTokenHash).toBeNull();
    const types = (await eventsFor(s.taskId)).map((e) => e.type);
    expect(types).toContain("pull_request.created");
    expect(types).toContain("execution.completed");
    // The execution is COMPLETED, so the lease is not renewed.
    await expectRecorded(s, "report_pr_created", before.leaseExpiresAt, {
      leaseRenewed: false,
    });

    // A following call fails auth, on the same client and on a new one.
    await expect(callOn(client, "note", { text: "after" })).rejects.toThrow(
      /401|UNAUTHORIZED/,
    );
    await expect(connect(s.token)).rejects.toThrow(/401|UNAUTHORIZED/);
  });

  it("GOT.39 C17: a second call for the same task updates the PR row in place, leaving exactly one", async () => {
    const s = await seed({ taskState: "REVIEWING" });
    expectOk(
      await call(s.token, "report_pr_created", {
        url: "https://github.com/goopter/orchestra/pull/42",
        number: 42,
        head_sha: "sha-one",
      }),
    );
    const [first] = await db.query.pullRequests.findMany({
      where: (t, { eq }) => eq(t.taskId, s.taskId),
    });
    // CI failed and the poller recorded it.
    await db.$client.unsafe(
      "update pull_requests set ci_state = 'failed', ci_detail = '{\"x\":1}'::jsonb, last_polled_at = '2026-01-01T00:00:00Z' where id = $1",
      [first!.id],
    );

    // The CI-failure resume, then the agent's next review round.
    const actor = { kind: "worker" as const };
    await db.transaction(async (tx) => {
      await transition(tx, { entity: "task", id: s.taskId, trigger: "ci.failed", actor });
      await transition(tx, {
        entity: "execution",
        id: s.executionId,
        trigger: "resume_with_ci_failure",
        actor,
      });
      await transition(tx, { entity: "task", id: s.taskId, trigger: "review.started", actor });
    });
    const token = await db.transaction((tx) => issueToken(tx, s.executionId));
    issuedTokens.push(token);

    expectOk(
      await call(token, "report_pr_created", {
        url: "https://github.com/goopter/orchestra/pull/42",
        number: 42,
        head_sha: "sha-two",
      }),
    );

    const prs = await db.query.pullRequests.findMany({
      where: (t, { eq }) => eq(t.taskId, s.taskId),
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      id: first!.id,
      executionId: s.executionId,
      number: 42,
      url: "https://github.com/goopter/orchestra/pull/42",
      headSha: "sha-two",
      state: "open",
      ciState: "pending",
      ciDetail: null,
    });
    expect(prs[0]!.lastPolledAt.getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );
    expect((await getTask(s.taskId))!.state).toBe("CI_RUNNING");
    const execution = await getExecution(s.executionId);
    expect(execution!.state).toBe("COMPLETED");
    expect(execution!.toolsTokenHash).toBeNull();
    const created = (await eventsFor(s.taskId)).filter(
      (e) => e.type === "pull_request.created",
    );
    expect(created.map((e) => (e.payload as { head_sha: string }).head_sha)).toEqual([
      "sha-one",
      "sha-two",
    ]);
    expect(created.map((e) => (e.payload as { pull_request_id: string }).pull_request_id)).toEqual([
      first!.id,
      first!.id,
    ]);
  });

  it("GOT.39 F4 (C22): reporting a new PR over a closed or merged row reopens it, clears merged_at, and takes the new number and sha", async () => {
    const s = await seed({ taskState: "REVIEWING" });
    expectOk(
      await call(s.token, "report_pr_created", {
        url: "https://github.com/goopter/orchestra/pull/42",
        number: 42,
        head_sha: "sha-old",
      }),
    );
    const [first] = await db.query.pullRequests.findMany({
      where: (t, { eq }) => eq(t.taskId, s.taskId),
    });
    // The old PR was closed (merged_at set too, to prove it is cleared).
    await db.$client.unsafe(
      "update pull_requests set state = 'closed', merged_at = '2026-01-01T00:00:00Z' where id = $1",
      [first!.id],
    );

    // The task goes round again and its session reaches report_pr_created.
    await db.$client.unsafe("update tasks set state = 'REVIEWING' where id = $1", [s.taskId]);
    await db.$client.unsafe(
      "update executions set state = 'RUNNING', ended_at = null where id = $1",
      [s.executionId],
    );
    const token = await db.transaction((tx) => issueToken(tx, s.executionId));
    issuedTokens.push(token);

    expectOk(
      await call(token, "report_pr_created", {
        url: "https://github.com/goopter/orchestra/pull/43",
        number: 43,
        head_sha: "sha-new",
      }),
    );

    const prs = await db.query.pullRequests.findMany({
      where: (t, { eq }) => eq(t.taskId, s.taskId),
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      id: first!.id,
      number: 43,
      url: "https://github.com/goopter/orchestra/pull/43",
      headSha: "sha-new",
      state: "open",
      mergedAt: null,
      ciState: "pending",
    });
    expect((await getTask(s.taskId))!.state).toBe("CI_RUNNING");
  });
});

// ================================================================= AC3

describe("report_complete", () => {
  it("records an agent.note with the summary and changes no state", async () => {
    const s = await seed({ role: "spec", taskState: "SPEC_IN_PROGRESS" });
    const before = await snapshot(s);

    expectOk(await call(s.token, "report_complete", { summary: "spec ready" }));

    const note = (await eventsFor(s.taskId)).find((e) => e.type === "agent.note");
    expect(note!.payload).toMatchObject({ text: "spec ready", tool: "report_complete" });
    expect(note!.executionId).toBe(s.executionId);
    expect((await getTask(s.taskId))!.state).toBe("SPEC_IN_PROGRESS");
    expect((await getExecution(s.executionId))!.state).toBe("RUNNING");
    await expectRecorded(s, "report_complete", before.leaseExpiresAt);
  });
});

describe("report_failed", () => {
  it("implementation: execution FAILED with agent_gave_up, task NEEDS_HUMAN, token revoked", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    const before = await snapshot(s);

    expectOk(
      await call(s.token, "report_failed", {
        reason: "blocked by flaky infra",
        detail: "npm install times out",
      }),
    );

    const execution = await getExecution(s.executionId);
    expect(execution).toMatchObject({
      state: "FAILED",
      endReason: "agent_gave_up",
      toolsTokenHash: null,
    });
    expect(execution!.endDetail).toContain("blocked by flaky infra");
    expect(execution!.endDetail).toContain("npm install times out");
    expect(execution!.endedAt).toBeInstanceOf(Date);
    const task = await getTask(s.taskId);
    expect(task!.state).toBe("NEEDS_HUMAN");
    expect(task!.needsHumanReason).toContain("blocked by flaky infra");
    // The execution is FAILED, so the lease is not renewed.
    await expectRecorded(s, "report_failed", before.leaseExpiresAt, {
      leaseRenewed: false,
    });
  });

  it("also escalates from REVIEWING", async () => {
    const s = await seed({ taskState: "REVIEWING" });
    expectOk(await call(s.token, "report_failed", VALID_ARGS.report_failed!));
    expect((await getTask(s.taskId))!.state).toBe("NEEDS_HUMAN");
  });

  it("after the review limit already escalated, fails the execution and leaves NEEDS_HUMAN", async () => {
    const s = await seed({ taskState: "REVIEWING", maxReviewRounds: 1 });
    expectOk(
      await call(s.token, "report_review_result", {
        round: 2,
        verdict: "findings",
        findings: [],
      }),
    );

    expectOk(await call(s.token, "report_failed", VALID_ARGS.report_failed!));

    expect((await getTask(s.taskId))!.state).toBe("NEEDS_HUMAN");
    expect((await getExecution(s.executionId))!.state).toBe("FAILED");
  });

  it("spec: execution FAILED, task stays SPEC_IN_PROGRESS (no NEEDS_HUMAN edge in §5.1)", async () => {
    const s = await seed({ role: "spec", taskState: "SPEC_IN_PROGRESS" });

    expectOk(await call(s.token, "report_failed", VALID_ARGS.report_failed!));

    expect((await getExecution(s.executionId))).toMatchObject({
      state: "FAILED",
      endReason: "agent_gave_up",
      toolsTokenHash: null,
    });
    expect((await getTask(s.taskId))!.state).toBe("SPEC_IN_PROGRESS");
  });

  it("while ASSIGNED returns UNAUTHORIZED and writes nothing: core has no ASSIGNED -> FAILED edge", async () => {
    const s = await seed({
      taskState: "IMPLEMENTING",
      executionState: "ASSIGNED",
    });
    const before = await snapshot(s);

    const result = await call(s.token, "report_failed", VALID_ARGS.report_failed!);

    expect(result).toMatchObject({ isError: true, code: "UNAUTHORIZED" });
    // No agent.tool_call row, lease not renewed, no state change.
    expect(await snapshot(s)).toEqual(before);
  });
});

// ================================================================= AC7

describe("propose_spec", () => {
  it("twice upserts a single draft revision holding the second content", async () => {
    const s = await seed({ role: "spec", taskState: "SPEC_IN_PROGRESS" });
    const before = await snapshot(s);

    expectOk(await call(s.token, "propose_spec", specContent("first")));
    expectOk(await call(s.token, "propose_spec", specContent("second")));

    const revisions = await db.query.specificationRevisions.findMany({
      where: (t, { eq }) => eq(t.taskId, s.taskId),
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      status: "draft",
      version: 1,
      createdBy: null,
      content: specContent("second"),
    });
    const proposed = (await eventsFor(s.taskId)).filter(
      (e) => e.type === "spec.proposed",
    );
    expect(proposed).toHaveLength(2);
    expect(proposed[1]!.payload).toMatchObject({
      revision_id: revisions[0]!.id,
      version: 1,
    });

    const calls = (await eventsFor(s.taskId)).filter(
      (e) => e.type === "agent.tool_call",
    );
    expect(calls).toHaveLength(2);
    const lease = await getLease(s.executionId);
    expect(lease!.expiresAt.getTime()).toBeGreaterThan(before.leaseExpiresAt);
  });

  it("an invalid spec returns a validation error and writes nothing", async () => {
    const s = await seed({ role: "spec", taskState: "SPEC_IN_PROGRESS" });
    const before = await snapshot(s);

    const result = await call(s.token, "propose_spec", {
      ...specContent("bad"),
      scope: "not a list",
      objective: undefined,
    });

    expect(result.isError).toBe(true);
    expect((result as { message: string }).message).toMatch(/validation/i);
    expect((result as { message: string }).message).toMatch(/scope/);
    expect((result as { message: string }).message).toMatch(/objective/);
    expect(await snapshot(s)).toEqual(before);
  });
});

// ================================================================= AC3

describe("note", () => {
  it("writes agent.note with the text from either role and while ASSIGNED", async () => {
    for (const opts of [
      { role: "implementation" as const, taskState: "IMPLEMENTING" as const },
      { role: "spec" as const, taskState: "SPEC_IN_PROGRESS" as const },
      {
        role: "implementation" as const,
        taskState: "IMPLEMENTING" as const,
        executionState: "ASSIGNED" as const,
      },
    ]) {
      const s = await seed(opts);
      const before = await snapshot(s);

      expectOk(await call(s.token, "note", { text: "tests are slow here" }));

      const note = (await eventsFor(s.taskId)).find((e) => e.type === "agent.note");
      expect(note!.payload).toMatchObject({ text: "tests are slow here" });
      expect(note!.executionId).toBe(s.executionId);
      await expectRecorded(s, "note", before.leaseExpiresAt);
    }
  });
});

// ================================================================= AC8

describe("lease renewal and registry", () => {
  it("uses the registered LiveExecution.renewLease when the execution is live", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    let renewed = 0;
    registry.set({
      ...createLiveExecution(
        { executionId: s.executionId, taskId: s.taskId, role: "implementation" },
        { db, now: () => new Date() },
      ),
      renewLease: async () => void (renewed += 1),
    });

    expectOk(await call(s.token, "note", { text: "x" }));

    expect(renewed).toBe(1);
    registry.delete(s.executionId);
  });

  it("the default LiveExecution.renewLease pushes expires_at to now + 5 min", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    const fixed = new Date("2026-06-01T12:00:00.000Z");
    const live = createLiveExecution(
      { executionId: s.executionId, taskId: s.taskId, role: "implementation" },
      { db, now: () => fixed },
    );

    await live.renewLease();

    expect((await getLease(s.executionId))!.expiresAt.getTime()).toBe(
      fixed.getTime() + 5 * 60 * 1000,
    );
    expect(live.blockingPending).toBe(false);
  });

  it("serves an execution missing from the registry, renews through the db and warns", async () => {
    const s = await seed({ taskState: "IMPLEMENTING" });
    const before = await snapshot(s);
    const warnsBefore = records.filter((r) => r.level === "warn").length;

    expectOk(await call(s.token, "note", { text: "unregistered" }));

    await expectRecorded(s, "note", before.leaseExpiresAt);
    const warns = records.filter((r) => r.level === "warn").slice(warnsBefore);
    expect(
      warns.some((r) => r.fields.executionId === s.executionId),
    ).toBe(true);
  });
});

describe("token hygiene", () => {
  it("no log record and no event payload ever contains an issued token", async () => {
    const logged = JSON.stringify(records);
    const events = await db.query.executionEvents.findMany();
    const stored = JSON.stringify(
      events.map((e) => e.payload),
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(issuedTokens.length).toBeGreaterThan(10);
    for (const token of issuedTokens) {
      expect(logged).not.toContain(token);
      expect(stored).not.toContain(token);
    }
  });
});
