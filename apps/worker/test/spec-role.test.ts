import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import type { CommandType, SpecContent } from "@orchestra/core";
import {
  agentWorkers,
  executions,
  hasPendingSpecSessionStart,
  insertExecutionCommand,
  lockTaskExecutionIds,
  lockTaskForSpec,
  projects,
  repositories,
  specificationRevisions,
  tasks,
  transition,
  type Db,
} from "@orchestra/db";
import { systemPromptFor, type TicketContext } from "@orchestra/prompts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentToolsServer,
  createExecutionRegistry,
  type AgentToolsServer,
  type ExecutionRegistry,
} from "../src/agent-tools/index.js";
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  createCommandHandlers,
  createConsumeCommandsPhase,
  createRunner,
  registerSpecHandlers,
  type Runner,
} from "../src/runner/index.js";
import { createWorktreeSweeperPhase } from "../src/sweeper/index.js";
import type { TickContext } from "../src/tick.js";
import { WorktreeManager, type PrepareSpecInput } from "../src/worktrees/index.js";
import { sleep, startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * GOT.37: the spec role end to end (design.md §5.2, §8, §9.1, §9.3, §12.3,
 * D8). A real Postgres, the real agent-tools server in-process, the real
 * worktree manager on a local git remote, and a fake adapter whose turns
 * are scripted per call.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "spec-role-host";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const SENT_BACK_TEXT = "The specification was sent back for changes.";

const DRAFT: SpecContent = {
  repository: "a-spec",
  objective: "First draft objective",
  scope: ["receipts"],
  out_of_scope: ["email"],
  requirements: ["device locale"],
  acceptance_criteria: ["receipt uses locale"],
  validation: ["unit test"],
  constraints: ["no new deps"],
  dependencies: [],
};
const PROPOSED: SpecContent = { ...DRAFT, objective: "Proposed objective from the agent" };

const TICKET: TicketContext = {
  key: "SPR-1",
  summary: "Receipt language",
  description: "TICKET BODY: receipts ignore the device language",
  comments: [{ author: "pm@example.com", createdAt: "2026-09-20", body: "COMMENT BODY" }],
};

const GIT_FLAGS = ["-c", "user.name=Orchestra Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
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
let workspaceRoot: string;
let registry: ExecutionRegistry;
let server: AgentToolsServer;
let workerId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "got37-spec-")));
  remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, seed);
  git(seed, "checkout", "-q", "-B", "main");
  await fs.writeFile(path.join(seed, "README.md"), "receipts");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "push", "-q", "origin", "main:main");

  registry = createExecutionRegistry();
  server = createAgentToolsServer({ db, registry, logger, now: () => new Date() });
  await server.start(0, "127.0.0.1");
});

afterAll(async () => {
  await server?.stop();
  await testDb?.stop();
  await fs.rm(root, { recursive: true, force: true });
});

const runners: Runner[] = [];
const clients: Client[] = [];
let workspaceSeq = 0;

beforeEach(async () => {
  records.length = 0;
  await db.$client.unsafe(
    "truncate table projects, agent_workers, audit_events restart identity cascade",
  );
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: root })
    .returning({ id: agentWorkers.id });
  workerId = worker!.id;
  workspaceRoot = path.join(root, `workspace-${++workspaceSeq}`);
});

afterEach(async () => {
  while (runners.length > 0) await runners.pop()!.shutdown(2000);
  while (clients.length > 0) await clients.pop()!.close().catch(() => {});
  await db.$client.unsafe("drop trigger if exists got37_fault on execution_commands");
  await db.$client.unsafe("drop function if exists got37_fault()");
});

// ---------------------------------------------------------------- seeding

let seq = 0;

interface SeededSpecTask {
  projectId: string;
  taskId: string;
  repositoryIds: Record<string, string>;
}

/**
 * A SPEC_IN_PROGRESS task. Its project has `repos` (default: b-spec, then
 * a-spec, so name order differs from insert order); the task has none
 * unless `taskRepository` names one (C41).
 */
async function seedSpecTask(
  options: { repos?: string[]; taskRepository?: string; draft?: SpecContent | null } = {},
): Promise<SeededSpecTask> {
  const n = ++seq;
  const [project] = await db
    .insert(projects)
    .values({ key: `SPR${n}`, name: `spec ${n}`, jiraJql: `project = SPR${n}` })
    .returning({ id: projects.id });
  const repositoryIds: Record<string, string> = {};
  for (const name of options.repos ?? ["b-spec", "a-spec"]) {
    const [repo] = await db
      .insert(repositories)
      .values({
        projectId: project!.id,
        name,
        gitUrl: remote,
        defaultBranch: "main",
        defaultRuntime: "claude",
        maxConcurrentWorktrees: 4,
      })
      .returning({ id: repositories.id });
    repositoryIds[name] = repo!.id;
  }
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: options.taskRepository ? repositoryIds[options.taskRepository]! : null,
      jiraKey: `SPR-${n}`,
      jiraSummary: `Receipt language ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "SPEC_IN_PROGRESS",
    })
    .returning({ id: tasks.id });
  const draft = options.draft === undefined ? DRAFT : options.draft;
  if (draft) {
    await db
      .insert(specificationRevisions)
      .values({ taskId: task!.id, version: 1, status: "draft", content: draft });
  }
  return { projectId: project!.id, taskId: task!.id, repositoryIds };
}

async function enqueue(
  taskId: string,
  type: CommandType,
  executionId: string | null,
  payload: unknown = {},
): Promise<string> {
  const { id } = await db.transaction((tx) =>
    insertExecutionCommand(tx, { taskId, executionId, type, payload, createdBy: null, now: new Date() }),
  );
  return id;
}

// ------------------------------------------------------------------ reads

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const executionsOf = (taskId: string) =>
  db.query.executions.findMany({
    where: (e, { eq }) => eq(e.taskId, taskId),
    orderBy: (e, { asc }) => [asc(e.createdAt)],
  });
const task = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const command = async (id: string) =>
  (await db.query.executionCommands.findFirst({ where: (c, { eq }) => eq(c.id, id) }))!;
const revisionsOf = (taskId: string) =>
  db.query.specificationRevisions.findMany({ where: (r, { eq }) => eq(r.taskId, taskId) });
const eventsOf = (taskId: string) =>
  db.query.executionEvents.findMany({
    where: (e, { eq }) => eq(e.taskId, taskId),
    orderBy: (e, { asc }) => [asc(e.id)],
  });
async function auditOf(entityId: string): Promise<string[]> {
  const rows = await db.$client.unsafe<{ trigger: string; from_state: string; to_state: string }[]>(
    "select trigger, from_state, to_state from audit_events where entity_id = $1 order by id",
    [entityId],
  );
  return rows.map((r) => `${r.from_state} -(${r.trigger})-> ${r.to_state}`);
}
async function openTransactions(): Promise<number> {
  const [row] = await db.$client.unsafe<{ n: number }[]>(
    "select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()",
  );
  return row!.n;
}

// ------------------------------------------------------------ fake agent

async function callTool(
  req: StartRequest | ResumeRequest,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = new Client({ name: "spec-role-agent", version: "0.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(req.mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${req.mcp.token}` } },
    }),
  );
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    throw new Error(`${name} failed: ${text}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

type Script = (
  req: StartRequest | ResumeRequest,
  signal: AbortSignal,
) => AsyncGenerator<AgentEvent>;

/** A turn that replies with `text` and ends. */
const reply = (text: string): Script =>
  async function* () {
    yield { type: "text", delta: text };
    yield { type: "turn_done", finalText: text };
  };

class ScriptedAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  readonly signals: AbortSignal[] = [];
  readonly errors: string[] = [];
  startScript: Script = async function* () {
    yield { type: "session", sessionId: "sess-spec" };
    yield { type: "turn_done", finalText: "" };
  };
  /** One script per resume, in order. */
  resumeScripts: Script[] = [];

  start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    this.signals.push(signal);
    return this.startScript(req, signal);
  }

  resume(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    this.signals.push(signal);
    const script = this.resumeScripts.shift();
    if (!script) throw new Error("no resume script left");
    return script(req, signal);
  }

  resumable = true;

  async canResume(): Promise<boolean> {
    return this.resumable;
  }
}

interface Harness {
  runner: Runner;
  adapter: ScriptedAdapter;
  prepared: Array<{ input: PrepareSpecInput; openTransactions: number }>;
}

interface HarnessOptions {
  host?: string;
  workerId?: string;
  flushMs?: number;
  blockingPollMs?: number;
  beforeTokenIssue?: (executionId: string) => Promise<void>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const adapter = new ScriptedAdapter();
  const manager = new WorktreeManager({ workspaceRoot });
  const prepared: Harness["prepared"] = [];
  const runner = createRunner({
    db,
    registry,
    logger,
    workerId: options.workerId ?? workerId,
    host: options.host ?? HOST,
    worktrees: {
      prepareImplementation: () => Promise.reject(new Error("not expected")),
      async prepareSpec(input) {
        // AC7: no transaction, so no row lock, is open while git runs.
        prepared.push({ input, openTransactions: await openTransactions() });
        return manager.prepareSpec(input);
      },
      remove: (p, o) => manager.remove(p, o),
    },
    adapters: { claude: adapter },
    toolsUrl: () => server.url,
    fetchTicket: async (key) => ({ ...TICKET, key }),
    quietTimeoutMs: 20_000,
    basePath: "/usr/bin:/bin",
    timings: {
      leaseRenewMs: 60_000,
      blockingPollMs: options.blockingPollMs ?? 50,
      ...(options.flushMs !== undefined ? { flushMs: options.flushMs } : {}),
    },
    ...(options.beforeTokenIssue ? { hooks: { beforeTokenIssue: options.beforeTokenIssue } } : {}),
  });
  runners.push(runner);
  return { runner, adapter, prepared };
}

function tickContext(host: string = HOST, worker: string = workerId): TickContext {
  return {
    db,
    workerId: worker,
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/unused",
      WORKER_HOST: host,
      WORKER_WORKSPACE_ROOT: workspaceRoot,
    }),
    now: new Date(),
    tick: 1,
    logger,
  };
}

async function consume(r: Runner, host: string = HOST, worker: string = workerId): Promise<void> {
  const handlers = createCommandHandlers();
  registerSpecHandlers(handlers, r);
  await createConsumeCommandsPhase(handlers).run(tickContext(host, worker));
}

async function sweep(): Promise<void> {
  await createWorktreeSweeperPhase({ diskUsage: async () => 10 }).run(tickContext());
}

const idle = (r: Runner, executionId: string) =>
  waitFor(async () => (r.isLive(executionId) ? undefined : true), {
    what: "the turn to end",
  });

// -------------------------------------------- the api's writes (§12.3)

const USER = { kind: "user" as const };

/** POST /spec/request-review's writes, in the route's order. */
async function requestReview(taskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockTaskForSpec(tx, taskId);
    expect(await hasPendingSpecSessionStart(tx, taskId)).toBe(false);
    await transition(tx, { entity: "task", id: taskId, trigger: "spec.review_requested", actor: USER });
    for (const id of await lockTaskExecutionIds(tx, taskId, "spec", ["RUNNING"])) {
      await transition(tx, {
        entity: "execution",
        id,
        trigger: "execution.completed",
        actor: USER,
        set: { endedAt: new Date(), toolsTokenHash: null },
      });
    }
  });
}

/** POST /spec/send-back's writes (C45). */
async function sendBack(taskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, { entity: "task", id: taskId, trigger: "spec.sent_back", actor: USER });
    const completed = await lockTaskExecutionIds(tx, taskId, "spec", ["COMPLETED"]);
    await insertExecutionCommand(tx, {
      taskId,
      executionId: completed[completed.length - 1]!,
      type: "send_message",
      payload: { text: SENT_BACK_TEXT, system: "sent_back" },
      createdBy: null,
      now: new Date(),
    });
  });
}

// ------------------------------------------------------------------ tests

describe("spec role end to end (GOT.37)", () => {
  it("start, propose_spec, chat, a live turn, request-review mid-turn, send-back, approval and the sweep", async () => {
    const s = await seedSpecTask();
    const h = makeHarness();
    let during: { state: string; token: string | null } | undefined;
    let proposed: Record<string, unknown> | undefined;
    h.adapter.startScript = async function* (req) {
      yield { type: "session", sessionId: "sess-spec" };
      const [row] = await executionsOf(s.taskId);
      yield { type: "tool_call", name: "mcp__orchestra__propose_spec", input: PROPOSED };
      try {
        proposed = await callTool(req, "propose_spec", PROPOSED as unknown as Record<string, unknown>);
      } catch (err) {
        h.adapter.errors.push(err instanceof Error ? err.message : String(err));
      }
      const current = await execution(row!.id);
      during = { state: current.state, token: current.toolsTokenHash };
      yield { type: "text", delta: "Drafted a first specification." };
      yield { type: "turn_done", finalText: "Drafted a first specification." };
    };

    // ---- AC1: start_spec_session -> ASSIGNED -> RUNNING.
    const startId = await enqueue(s.taskId, "start_spec_session", null);
    await consume(h.runner);
    const [created] = await executionsOf(s.taskId);
    expect(created).toBeDefined();
    const id = created!.id;
    await idle(h.runner, id);

    expect(h.adapter.errors).toEqual([]);
    expect((await command(startId)).completedAt).not.toBeNull();
    let row = await execution(id);
    expect(row).toMatchObject({
      role: "spec",
      attempt: 1,
      runtime: "claude",
      model: "default",
      specRevisionId: null,
      host: HOST,
      workerId,
      sessionId: "sess-spec",
      state: "RUNNING",
      toolsTokenHash: null,
      branch: null,
      worktreePath: path.join(workspaceRoot, "work", id),
    });
    expect(await auditOf(id)).toEqual([
      "QUEUED -(execution.assigned)-> ASSIGNED",
      "ASSIGNED -(execution.started)-> RUNNING",
    ]);

    // C41: no task repository, so the project's first by name.
    expect(h.prepared).toHaveLength(1);
    expect(h.prepared[0]!.input).toMatchObject({
      executionId: id,
      repository: { name: "a-spec", gitUrl: remote, defaultBranch: "main" },
    });
    expect(h.prepared[0]!.openTransactions).toBe(0);
    // §9.1: read-only worktree detached at the default branch.
    expect(git(row.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(row.worktreePath!, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));

    const start = h.adapter.starts[0]!;
    expect(start.allowedTools).toBe("spec");
    expect(start.systemPrompt).toBe(systemPromptFor("spec"));
    expect(start.model).toBeUndefined();
    expect(start.cwd).toBe(row.worktreePath);
    expect(start.mcp.url).toBe(server.url);
    expect(start.prompt).toContain("## Ticket");
    expect(start.prompt).toContain(`${(await task(s.taskId)).jiraKey}: ${TICKET.summary}`);
    expect(start.prompt).toContain(TICKET.description);
    expect(start.prompt).toContain("COMMENT BODY");
    expect(start.prompt).toContain("## Draft specification (revision 1)");
    expect(start.prompt).toContain(DRAFT.objective);
    expect(start.prompt).not.toContain("## Approved specification");
    expect(start.prompt).toContain("## Repository\nName: a-spec");

    // ---- AC2: propose_spec through the real tool; the turn ends RUNNING, token revoked.
    expect(proposed).toEqual({ ok: true });
    expect(during).toEqual({ state: "RUNNING", token: expect.any(String) });
    const revisions = await revisionsOf(s.taskId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ status: "draft", version: 1, content: PROPOSED });
    const proposedEvents = (await eventsOf(s.taskId)).filter((e) => e.type === "spec.proposed");
    expect(proposedEvents).toHaveLength(1);
    expect(proposedEvents[0]).toMatchObject({
      executionId: id,
      payload: { revision_id: revisions[0]!.id, version: 1 },
    });
    expect(registry.get(id)).toBeUndefined();

    // ---- AC3: two chat turns resume the session in place.
    for (const [n, text] of [[1, "Which printers?"], [2, "Also the kiosk."]] as const) {
      h.adapter.resumeScripts.push(reply(`answer ${n}`));
      const cmd = await enqueue(s.taskId, "send_message", id, { text });
      await consume(h.runner);
      await idle(h.runner, id);
      expect((await command(cmd)).completedAt).not.toBeNull();
      const resumed = h.adapter.resumes[n - 1]!;
      expect(resumed.prompt).toBe(`## Message from the user\n${text}`);
      expect(resumed.sessionId).toBe("sess-spec");
      expect(resumed.allowedTools).toBe("spec");
      expect(resumed.cwd).toBe(row.worktreePath);
      row = await execution(id);
      expect(row.state).toBe("RUNNING");
      expect(row.toolsTokenHash).toBeNull();
    }
    expect(h.adapter.resumes).toHaveLength(2);
    expect(await auditOf(id)).toHaveLength(2);
    // C43: the user's chat text is not an execution event.
    const payloads = JSON.stringify((await eventsOf(s.taskId)).map((e) => e.payload));
    expect(payloads).not.toContain("Which printers?");
    expect(payloads).toContain("answer 1");

    // ---- AC3: a message while a turn is in flight is left unclaimed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.adapter.resumeScripts.push(async function* () {
      await gate;
      yield { type: "turn_done", finalText: "" };
    });
    await enqueue(s.taskId, "send_message", id, { text: "third" });
    await consume(h.runner);
    expect(h.runner.isLive(id)).toBe(true);
    h.adapter.resumeScripts.push(reply("answer 4"));
    const queued = await enqueue(s.taskId, "send_message", id, { text: "fourth" });
    await consume(h.runner);
    expect(await command(queued)).toMatchObject({ claimedAt: null, completedAt: null });
    expect(h.adapter.resumes).toHaveLength(3);
    release();
    await idle(h.runner, id);
    await consume(h.runner);
    await idle(h.runner, id);
    expect((await command(queued)).completedAt).not.toBeNull();
    expect(h.adapter.resumes).toHaveLength(4);
    expect(h.adapter.resumes[3]!.prompt).toBe("## Message from the user\nfourth");

    // ---- AC4: request-review while a turn is in flight aborts the session.
    h.adapter.resumeScripts.push(async function* (_req, signal) {
      await aborted(signal);
    });
    await enqueue(s.taskId, "send_message", id, { text: "one more thing" });
    await consume(h.runner);
    await waitFor(async () => ((await execution(id)).toolsTokenHash ? true : undefined), {
      what: "the in-flight turn's token",
    });
    await requestReview(s.taskId);
    const afterReview = {
      events: (await eventsOf(s.taskId)).length,
      audit: await auditOf(id),
      row: await execution(id),
    };
    await idle(h.runner, id);
    expect(h.adapter.signals[h.adapter.signals.length - 1]!.aborted).toBe(true);
    expect(records).toContainEqual(
      expect.objectContaining({ msg: "spec execution left RUNNING, aborting the session" }),
    );
    row = await execution(id);
    expect(row.state).toBe("COMPLETED");
    expect(row).toEqual(afterReview.row);
    expect((await eventsOf(s.taskId)).length).toBe(afterReview.events);
    expect(await auditOf(id)).toEqual(afterReview.audit);
    expect((await task(s.taskId)).state).toBe("SPEC_REVIEW");

    // ---- AC6: nothing is swept while the task is in SPEC_REVIEW.
    await sweep();
    expect(existsSync(row.worktreePath!)).toBe(true);
    expect((await execution(id)).worktreePath).toBe(row.worktreePath);

    // ---- AC5: send-back enqueues; the handler moves COMPLETED -> RUNNING and resumes.
    h.adapter.resumeScripts.push(reply("What should change?"));
    await sendBack(s.taskId);
    await consume(h.runner);
    await idle(h.runner, id);
    const sentBack = h.adapter.resumes[h.adapter.resumes.length - 1]!;
    expect(sentBack.prompt.startsWith(`## Specification sent back\n${SENT_BACK_TEXT}`)).toBe(true);
    expect(sentBack.prompt).toContain("### Current draft (revision 1)");
    expect(sentBack.prompt).toContain(PROPOSED.objective);
    expect(sentBack.sessionId).toBe("sess-spec");
    row = await execution(id);
    expect(row.state).toBe("RUNNING");
    expect(row.endedAt).toBeNull();
    expect((await auditOf(id)).slice(-1)).toEqual(["COMPLETED -(execution.resumed)-> RUNNING"]);
    expect((await task(s.taskId)).state).toBe("SPEC_IN_PROGRESS");

    // ---- AC6: review again, approve, sweep: the spec worktree is removed.
    await requestReview(s.taskId);
    await db.transaction((tx) =>
      transition(tx, { entity: "task", id: s.taskId, trigger: "spec.approved", actor: USER }),
    );
    await sweep();
    expect(existsSync(row.worktreePath!)).toBe(false);
    row = await execution(id);
    expect(row.state).toBe("COMPLETED");
    expect(row.worktreePath).toBeNull();
  });
});

describe("start_spec_session (GOT.37 AC1, AC7)", () => {
  it("uses the task's repository when it has one, and prompts with no draft section when there is none", async () => {
    const s = await seedSpecTask({ taskRepository: "b-spec", draft: null });
    const h = makeHarness();
    await enqueue(s.taskId, "start_spec_session", null);
    await consume(h.runner);
    const [created] = await executionsOf(s.taskId);
    await idle(h.runner, created!.id);
    expect(h.prepared[0]!.input.repository.name).toBe("b-spec");
    expect(h.adapter.starts[0]!.prompt).toContain("## No specification yet");
    expect((await execution(created!.id)).state).toBe("RUNNING");
  });

  it("creating the execution and completing the command are one transaction: a fault leaves neither", async () => {
    const s = await seedSpecTask();
    const h = makeHarness();
    await db.$client.unsafe(`
      create function got37_fault() returns trigger language plpgsql as $$
      begin
        if new.completed_at is not null and old.completed_at is null then
          raise exception 'injected fault';
        end if;
        return new;
      end $$`);
    await db.$client.unsafe(
      "create trigger got37_fault before update on execution_commands for each row execute function got37_fault()",
    );
    const startId = await enqueue(s.taskId, "start_spec_session", null);
    await consume(h.runner);

    expect(await executionsOf(s.taskId)).toEqual([]);
    const cmd = await command(startId);
    expect(cmd.completedAt).toBeNull();
    expect(cmd.claimedAt).not.toBeNull();
    expect(h.adapter.starts).toEqual([]);
    expect(h.prepared).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "command handler failed",
        // Drizzle wraps the trigger's exception in a "Failed query" error.
        fields: expect.objectContaining({
          err: expect.stringContaining('update "execution_commands" set "completed_at"'),
        }),
      }),
    );
  });

  it("skips with a live spec execution and writes nothing else", async () => {
    const s = await seedSpecTask();
    const h = makeHarness();
    const [existing] = await db
      .insert(executions)
      .values({
        taskId: s.taskId,
        role: "spec",
        attempt: 1,
        state: "RUNNING",
        runtime: "claude",
        model: "default",
        host: HOST,
        workerId,
      })
      .returning({ id: executions.id });
    const startId = await enqueue(s.taskId, "start_spec_session", null);
    await consume(h.runner);

    expect((await executionsOf(s.taskId)).map((e) => e.id)).toEqual([existing!.id]);
    expect((await command(startId)).completedAt).not.toBeNull();
    expect(h.adapter.starts).toEqual([]);
    expect(await eventsOf(s.taskId)).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "command skipped",
        fields: expect.objectContaining({ reason: "task already has a live spec execution" }),
      }),
    );
  });

  it("skips when the project has no repository, logs at error and writes no notification", async () => {
    const s = await seedSpecTask({ repos: [] });
    const h = makeHarness();
    const startId = await enqueue(s.taskId, "start_spec_session", null);
    await consume(h.runner);

    expect(await executionsOf(s.taskId)).toEqual([]);
    expect((await command(startId)).completedAt).not.toBeNull();
    expect(h.adapter.starts).toEqual([]);
    expect(await db.query.notifications.findMany()).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", msg: "start_spec_session: cannot start" }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        msg: "command skipped",
        fields: expect.objectContaining({ reason: "project has no repository" }),
      }),
    );
  });
});

describe("send_message guards (GOT.37 AC3)", () => {
  it("skips a send_message on an implementation execution", async () => {
    const s = await seedSpecTask();
    const h = makeHarness();
    const [impl] = await db
      .insert(executions)
      .values({
        taskId: s.taskId,
        role: "implementation",
        attempt: 1,
        state: "WAITING_FOR_USER",
        runtime: "claude",
        model: "default",
        host: HOST,
        workerId,
        sessionId: "sess-impl",
        worktreePath: path.join(workspaceRoot, "work", "x"),
      })
      .returning({ id: executions.id });
    const cmd = await enqueue(s.taskId, "send_message", impl!.id, { text: "hi" });
    await consume(h.runner);

    expect((await command(cmd)).completedAt).not.toBeNull();
    expect(h.adapter.resumes).toEqual([]);
    expect((await execution(impl!.id)).state).toBe("WAITING_FOR_USER");
    expect(records).toContainEqual(
      expect.objectContaining({
        msg: "command skipped",
        fields: expect.objectContaining({ reason: "not a spec execution" }),
      }),
    );
  });

  it("skips a plain message to a COMPLETED spec execution (request-review won the race)", async () => {
    const s = await seedSpecTask();
    const h = makeHarness();
    const [spec] = await db
      .insert(executions)
      .values({
        taskId: s.taskId,
        role: "spec",
        attempt: 1,
        state: "COMPLETED",
        runtime: "claude",
        model: "default",
        host: HOST,
        workerId,
        sessionId: "sess-spec",
        worktreePath: path.join(workspaceRoot, "work", "y"),
      })
      .returning({ id: executions.id });
    const cmd = await enqueue(s.taskId, "send_message", spec!.id, { text: "late" });
    await consume(h.runner);

    expect((await command(cmd)).completedAt).not.toBeNull();
    expect(h.adapter.resumes).toEqual([]);
    expect((await execution(spec!.id)).state).toBe("COMPLETED");
  });

  it("refuses a send-back resume once the task has left SPEC_IN_PROGRESS, writing nothing", async () => {
    const s = await seedSpecTask();
    const h = makeHarness();
    await db.$client.unsafe("update tasks set state = 'SPEC_REVIEW' where id = $1", [s.taskId]);
    const [spec] = await db
      .insert(executions)
      .values({
        taskId: s.taskId,
        role: "spec",
        attempt: 1,
        state: "COMPLETED",
        runtime: "claude",
        model: "default",
        host: HOST,
        workerId,
        sessionId: "sess-spec",
        worktreePath: path.join(workspaceRoot, "work", "z"),
      })
      .returning({ id: executions.id });
    const cmd = await enqueue(s.taskId, "send_message", spec!.id, {
      text: SENT_BACK_TEXT,
      system: "sent_back",
    });
    await consume(h.runner);

    expect((await command(cmd)).completedAt).not.toBeNull();
    expect(h.adapter.resumes).toEqual([]);
    expect((await execution(spec!.id)).state).toBe("COMPLETED");
    expect(await auditOf(spec!.id)).toEqual([]);
  });
});

// ------------------------------------------------- review round 1 (F1-F4)

/** A spec execution pinned to HOST with a session and a recorded worktree. */
async function seedSpecExecution(
  taskId: string,
  state: "RUNNING" | "COMPLETED",
  options: { attempt?: number; worktreePath?: string | null; host?: string; worker?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(executions)
    .values({
      taskId,
      role: "spec",
      attempt: options.attempt ?? 1,
      state,
      runtime: "claude",
      model: "default",
      host: options.host ?? HOST,
      workerId: options.worker ?? workerId,
      sessionId: "sess-spec",
      worktreePath:
        options.worktreePath === undefined
          ? path.join(workspaceRoot, "work", `seeded-${++seq}`)
          : options.worktreePath,
      startedAt: NOW,
      endedAt: state === "COMPLETED" ? NOW : null,
    })
    .returning({ id: executions.id });
  return row!.id;
}

const skipReasons = () =>
  records.filter((r) => r.msg === "command skipped").map((r) => r.fields.reason);

describe("review round 1 (GOT.37 F1-F4)", () => {
  it("F1: a start processed on another worker before the send-back resume is skipped; the sent-back session is the only live one", async () => {
    const s = await seedSpecTask();
    const id = await seedSpecExecution(s.taskId, "COMPLETED");
    await db.$client.unsafe("update tasks set state = 'SPEC_REVIEW' where id = $1", [s.taskId]);
    await sendBack(s.taskId);
    // A restart enqueued after the send-back committed.
    const startId = await enqueue(s.taskId, "start_spec_session", null);

    const OTHER = "spec-role-other-host";
    const [other] = await db
      .insert(agentWorkers)
      .values({ host: OTHER, capabilities: [], maxConcurrent: 4, workspaceRoot: root })
      .returning({ id: agentWorkers.id });
    const o = makeHarness({ host: OTHER, workerId: other!.id });
    // The send_message is pinned to HOST, so OTHER claims only the start.
    await consume(o.runner, OTHER, other!.id);
    expect((await command(startId)).completedAt).not.toBeNull();
    expect(skipReasons()).toContain("a sent-back spec session is about to resume");
    expect(o.adapter.starts).toEqual([]);

    const h = makeHarness();
    h.adapter.resumeScripts.push(reply("What should change?"));
    await consume(h.runner);
    await idle(h.runner, id);

    const rows = await executionsOf(s.taskId);
    expect(rows.map((r) => [r.id, r.state])).toEqual([[id, "RUNNING"]]);
    expect(h.adapter.resumes).toHaveLength(1);
  });

  it("F1: the send-back resume refuses when the task already has another live spec execution", async () => {
    const s = await seedSpecTask();
    const completed = await seedSpecExecution(s.taskId, "COMPLETED");
    const running = await seedSpecExecution(s.taskId, "RUNNING", { attempt: 2 });
    const cmd = await enqueue(s.taskId, "send_message", completed, {
      text: SENT_BACK_TEXT,
      system: "sent_back",
    });
    const h = makeHarness();
    h.adapter.resumeScripts.push(reply("unexpected"));
    await consume(h.runner);

    expect((await command(cmd)).completedAt).not.toBeNull();
    expect(skipReasons()).toContain("task already has another live spec execution");
    expect(h.adapter.resumes).toEqual([]);
    expect((await execution(completed)).state).toBe("COMPLETED");
    expect((await execution(running)).state).toBe("RUNNING");
    expect(await auditOf(completed)).toEqual([]);
  });

  it("F2: text buffered before a request-review abort is dropped; the COMPLETED execution gets no further events", async () => {
    const s = await seedSpecTask();
    const id = await seedSpecExecution(s.taskId, "RUNNING");
    // A long flush window keeps the text buffered until the stop.
    const h = makeHarness({ flushMs: 60_000 });
    let textConsumed = false;
    h.adapter.resumeScripts.push(async function* (_req, signal) {
      yield { type: "text", delta: "partial answer" };
      // Reached once the runner asks for the next event, after the text.
      textConsumed = true;
      await aborted(signal);
    });
    await enqueue(s.taskId, "send_message", id, { text: "one more thing" });
    await consume(h.runner);
    await waitFor(async () => (textConsumed ? true : undefined), { what: "the text event" });

    await requestReview(s.taskId);
    const before = await eventsOf(s.taskId);
    await idle(h.runner, id);

    expect(h.adapter.signals[0]!.aborted).toBe(true);
    const after = await eventsOf(s.taskId);
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after.map((e) => e.payload))).not.toContain("partial answer");
    expect((await execution(id)).state).toBe("COMPLETED");
  });

  it.each([
    ["NO_SESSION: C46 removed the worktree", { worktreePath: null, resumable: true }],
    ["CANNOT_RESUME: the session store is gone", { worktreePath: undefined, resumable: false }],
  ] as const)("F3: %s -> the send-back is skipped with an error log, not left claimed", async (_label, opts) => {
    const s = await seedSpecTask();
    const id = await seedSpecExecution(s.taskId, "COMPLETED", { worktreePath: opts.worktreePath });
    const cmd = await enqueue(s.taskId, "send_message", id, {
      text: SENT_BACK_TEXT,
      system: "sent_back",
    });
    const h = makeHarness();
    h.adapter.resumable = opts.resumable;
    await consume(h.runner);

    expect((await command(cmd)).completedAt).not.toBeNull();
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", msg: "send_message: spec session cannot be resumed" }),
    );
    expect(records.some((r) => r.msg === "command handler failed")).toBe(false);
    expect(h.adapter.resumes).toEqual([]);
    expect((await execution(id)).state).toBe("COMPLETED");
  });

  it("F4: request-review committing between the resume and the token issue leaves no token and opens no session", async () => {
    const s = await seedSpecTask();
    const id = await seedSpecExecution(s.taskId, "RUNNING");
    let fired = false;
    const h = makeHarness({
      async beforeTokenIssue() {
        if (fired) return;
        fired = true;
        await requestReview(s.taskId);
      },
    });
    h.adapter.resumeScripts.push(reply("unexpected"));
    const cmd = await enqueue(s.taskId, "send_message", id, { text: "hello" });
    await consume(h.runner);
    await idle(h.runner, id);

    expect(fired).toBe(true);
    expect((await command(cmd)).completedAt).not.toBeNull();
    const row = await execution(id);
    expect(row.state).toBe("COMPLETED");
    expect(row.toolsTokenHash).toBeNull();
    expect(h.adapter.resumes).toEqual([]);
    expect(await auditOf(id)).toEqual(["RUNNING -(execution.completed)-> COMPLETED"]);
    expect(records).toContainEqual(
      expect.objectContaining({ msg: "execution is no longer live, not opening the session" }),
    );
  });
});

describe("review round 2 (GOT.37 F5)", () => {
  it("F5: an event emitted after request-review commits, before the poll notices, is not written and aborts the session", async () => {
    const s = await seedSpecTask();
    const id = await seedSpecExecution(s.taskId, "RUNNING");
    // The C44 poll never fires within this test: only the write gate can stop it.
    const h = makeHarness({ blockingPollMs: 60_000 });
    let before: number | undefined;
    h.adapter.resumeScripts.push(async function* (_req, signal) {
      await requestReview(s.taskId);
      before = (await eventsOf(s.taskId)).length;
      yield { type: "tool_call", name: "Read", input: { file_path: "README.md" } };
      await Promise.race([aborted(signal), sleep(1_000)]);
      yield { type: "turn_done", finalText: "" };
    });
    await enqueue(s.taskId, "send_message", id, { text: "look again" });
    await consume(h.runner);
    await idle(h.runner, id);

    expect(before).toBeDefined();
    const after = await eventsOf(s.taskId);
    expect(after).toHaveLength(before!);
    expect(after.some((e) => e.type === "agent.tool_call")).toBe(false);
    expect(h.adapter.signals[0]!.aborted).toBe(true);
    expect(records).toContainEqual(
      expect.objectContaining({ msg: "spec execution left RUNNING, event dropped, aborting the session" }),
    );
    const row = await execution(id);
    expect(row.state).toBe("COMPLETED");
    expect(row.toolsTokenHash).toBeNull();
  });
});
