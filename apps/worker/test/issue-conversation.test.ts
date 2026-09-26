import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import type { CommandType, ExecutionState } from "@orchestra/core";
import {
  agentWorkers,
  executionCommands,
  executions,
  issues,
  projects,
  repositories,
  specificationRevisions,
  taskDecisions,
  taskLeases,
  tasks,
  transition,
  users,
  type Db,
  type ExecutionCommandRow,
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
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  createCommandHandlers,
  createConsumeCommandsPhase,
  createIssueMessageHandler,
  createRunner,
  registerIssueHandlers,
  registerSpecHandlers,
  specMessagePrompt,
  type CommandHandlers,
  type Runner,
  type RunnerDeps,
} from "../src/runner/index.js";
import type { TickContext } from "../src/tick.js";
import { WorktreeManager } from "../src/worktrees/index.js";
import { startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * GOT.47: issue conversation (`send_message` on an implementation
 * execution, design.md §9.3, §10.2), `resume_with_decision` (§10.3),
 * `resume_with_revision` (§10.4) and the fresh-session fallback for an
 * execution released from a dead host (C21, D5, §6.1), against a real
 * Postgres with a fake adapter.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "issue-host-a";
const OTHER_HOST = "issue-host-b";
const NOW = new Date("2026-09-25T10:00:00.000Z");

const SPEC_V1 = {
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
const SPEC_V2 = { ...SPEC_V1, objective: "Make receipts print in the store language" };

let testDb: TestDb;
let db: Db;
let workRoot: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "got47-issue-"));
});

afterAll(async () => {
  await testDb?.stop();
  await fs.rm(workRoot, { recursive: true, force: true });
});

const runners: Runner[] = [];

beforeEach(async () => {
  records.length = 0;
  await db.$client.unsafe(
    "truncate table projects, agent_workers, users, audit_events restart identity cascade",
  );
});

afterEach(async () => {
  while (runners.length > 0) await runners.pop()!.shutdown(2000);
});

// ---------------------------------------------------------------- seeding

let seq = 0;

interface Seeded {
  n: number;
  workerId: string;
  otherWorkerId: string;
  userId: string;
  taskId: string;
  jiraKey: string;
  executionId: string;
  issueId: string;
  revisionId: string;
  worktreePath: string;
  branch: string;
}

/**
 * A task IMPLEMENTING whose implementation execution is WAITING_FOR_USER on
 * `HOST` after a blocking `raise_issue`: a session, a worktree, a branch,
 * the approved revision 1 and the OPEN blocking issue.
 */
async function seedWaiting(
  options: {
    host?: string | null;
    sessionId?: string | null;
    worktree?: "present" | "missing" | "none";
    role?: "implementation" | "spec";
    state?: ExecutionState;
  } = {},
): Promise<Seeded> {
  const n = ++seq;
  const spec = options.role === "spec";
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: workRoot })
    .returning({ id: agentWorkers.id });
  const [other] = await db
    .insert(agentWorkers)
    .values({ host: OTHER_HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: workRoot })
    .returning({ id: agentWorkers.id });
  const [user] = await db
    .insert(users)
    .values({ email: `user${n}@example.com`, passwordHash: "x", displayName: `User ${n}` })
    .returning({ id: users.id });
  const [project] = await db
    .insert(projects)
    .values({ key: `ISS${n}`, name: `issue ${n}`, jiraJql: `project = ISS${n}` })
    .returning({ id: projects.id });
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "repo",
      gitUrl: `git@example.com:repo-${n}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
      testCommand: "pnpm test",
    })
    .returning({ id: repositories.id });
  const jiraKey = `ISS-${n}`;
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey,
      jiraSummary: `receipt language ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: spec ? "SPEC_IN_PROGRESS" : "IMPLEMENTING",
    })
    .returning({ id: tasks.id });
  const [revision] = await db
    .insert(specificationRevisions)
    .values({ taskId: task!.id, version: 1, status: "approved", content: SPEC_V1 })
    .returning({ id: specificationRevisions.id });
  await db.$client.unsafe("update tasks set approved_revision_id = $2 where id = $1", [
    task!.id,
    revision!.id,
  ]);

  // `<workspace root>/work/<segment>`, the path the worktree manager records.
  const worktreePath = path.join(workRoot, "work", `exec-${n}`);
  const worktree = options.worktree ?? "present";
  if (worktree === "present") await fs.mkdir(worktreePath, { recursive: true });
  const host = options.host === undefined ? HOST : options.host;
  const branch = `agent/${jiraKey}-abcdef12`;
  const [execution] = await db
    .insert(executions)
    .values({
      taskId: task!.id,
      role: spec ? "spec" : "implementation",
      attempt: 1,
      state: options.state ?? "WAITING_FOR_USER",
      runtime: "claude",
      model: "default",
      specRevisionId: spec ? null : revision!.id,
      workerId: host === HOST ? worker!.id : host === OTHER_HOST ? other!.id : null,
      host,
      worktreePath: worktree === "none" ? null : worktreePath,
      branch: spec ? null : branch,
      sessionId: options.sessionId === undefined ? `sess-${n}` : options.sessionId,
      startedAt: NOW,
    })
    .returning({ id: executions.id });
  if (!spec) await db.insert(taskLeases).values({
    taskId: task!.id,
    executionId: execution!.id,
    workerId: worker!.id,
    expiresAt: NOW,
  });
  const [issue] = await db
    .insert(issues)
    .values({
      taskId: task!.id,
      executionId: execution!.id,
      type: "QUESTION",
      severity: "blocking",
      blocking: true,
      title: "Which language?",
      description: "Device or store language?",
      question: "Which language should receipts use?",
      status: "OPEN",
    })
    .returning({ id: issues.id });
  return {
    n,
    workerId: worker!.id,
    otherWorkerId: other!.id,
    userId: user!.id,
    taskId: task!.id,
    jiraKey,
    executionId: execution!.id,
    issueId: issue!.id,
    revisionId: revision!.id,
    worktreePath,
    branch,
  };
}

async function enqueue(
  s: Seeded,
  type: CommandType,
  payload: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(executionCommands)
    .values({
      taskId: s.taskId,
      executionId: s.executionId,
      type,
      payload,
      createdBy: s.userId,
      createdAt: new Date(),
    })
    .returning({ id: executionCommands.id });
  return row!.id;
}

/** What `/issues/:id/resolve` as a clarification writes before the command. */
async function resolveAsClarification(
  s: Seeded,
  issueId: string,
  decision: { decision: string; clarification?: string; chosenOption?: string },
): Promise<string> {
  await db.$client.unsafe(
    "update issues set status = 'RESOLVED', resolution_kind = 'clarification', resolution = $2, resolved_by = $3, resolved_at = now() where id = $1",
    [issueId, decision.decision, s.userId],
  );
  const [row] = await db
    .insert(taskDecisions)
    .values({
      taskId: s.taskId,
      issueId,
      decision: decision.decision,
      clarification: decision.clarification ?? null,
      chosenOption: decision.chosenOption ?? null,
      decidedBy: s.userId,
    })
    .returning({ id: taskDecisions.id });
  return row!.id;
}

/** An extra, already resolved issue with its decision (for "every decision"). */
async function earlierDecision(s: Seeded, text: string): Promise<string> {
  const [issue] = await db
    .insert(issues)
    .values({
      taskId: s.taskId,
      executionId: s.executionId,
      type: "QUESTION",
      severity: "info",
      blocking: false,
      title: "Earlier",
      description: "Earlier question",
      status: "OPEN",
    })
    .returning({ id: issues.id });
  await resolveAsClarification(s, issue!.id, { decision: text });
  return issue!.id;
}

// ------------------------------------------------------------------ reads

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const command = async (id: string) =>
  (await db.query.executionCommands.findFirst({ where: (c, { eq }) => eq(c.id, id) }))!;
const agentMessages = (issueId: string) =>
  db.query.issueMessages.findMany({
    where: (m, { and, eq }) => and(eq(m.issueId, issueId), eq(m.authorKind, "agent")),
    orderBy: (m, { asc }) => [asc(m.createdAt), asc(m.id)],
  });
const eventsOf = async (taskId: string, type: string) =>
  (
    await db.query.executionEvents.findMany({
      where: (e, { eq }) => eq(e.taskId, taskId),
      orderBy: (e, { asc }) => [asc(e.id)],
    })
  ).filter((e) => e.type === type);

// ------------------------------------------------------------- fake agent

type Script = (req: StartRequest | ResumeRequest) => AsyncGenerator<AgentEvent>;

class FakeAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  resumable = true;
  script: Script = async function* () {
    yield { type: "turn_done", finalText: "" };
  };

  start(req: StartRequest): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    return this.script(req);
  }

  resume(req: ResumeRequest): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    return this.script(req);
  }

  async canResume(): Promise<boolean> {
    return this.resumable;
  }
}

interface Prepared {
  calls: Array<Parameters<RunnerDeps["worktrees"]["prepareImplementation"]>[0]>;
}

function makeRunner(
  host: string,
  workerId: string,
  adapter: FakeAdapter,
  prepared: Prepared = { calls: [] },
): Runner {
  const runner = createRunner({
    db,
    registry: createExecutionRegistry(),
    logger,
    workerId,
    host,
    worktrees: {
      prepareImplementation: async (input) => {
        prepared.calls.push(input);
        const worktreePath = input.worktreePath!;
        await fs.mkdir(worktreePath, { recursive: true });
        return { worktreePath, branch: `agent/${input.task.jiraKey}-abcdef12`, startPoint: "remote_branch" };
      },
      prepareSpec: () => Promise.reject(new Error("not expected")),
      remove: async () => ({ branchDeleted: false }),
      // The real writer (C53), against the recorded path.
      writeContext: (worktreePath, context) =>
        new WorktreeManager({ workspaceRoot: workRoot }).writeContext(worktreePath, context),
    },
    adapters: { claude: adapter },
    toolsUrl: () => "http://127.0.0.1:4999/mcp",
    quietTimeoutMs: 10_000,
    basePath: "/usr/bin:/bin",
    timings: { leaseRenewMs: 60_000, blockingPollMs: 50 },
  });
  runners.push(runner);
  return runner;
}

function handlersFor(runner: Runner): CommandHandlers {
  const handlers = createCommandHandlers();
  registerSpecHandlers(handlers, runner, {
    issueSendMessage: createIssueMessageHandler(runner),
  });
  registerIssueHandlers(handlers, runner);
  return handlers;
}

function tickContext(host: string, workerId: string): TickContext {
  return {
    db,
    workerId,
    config: loadConfig({ DATABASE_URL: "postgres://localhost/unused", WORKER_HOST: host }),
    now: new Date(),
    tick: 1,
    logger,
  };
}

/** One consume_commands tick on `host` with the spec and issue handlers. */
async function consume(host: string, workerId: string, runner: Runner): Promise<void> {
  await createConsumeCommandsPhase(handlersFor(runner)).run(tickContext(host, workerId));
}

async function turnEnded(runner: Runner, executionId: string): Promise<void> {
  await waitFor(async () => (runner.isLive(executionId) ? undefined : true), {
    what: "the resumed turn to end",
  });
}

/** What a resumed agent's `report_pr_created` does to the execution. */
async function completeExecution(executionId: string): Promise<void> {
  await db.transaction((tx) =>
    transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.completed",
      actor: { kind: "agent" },
      set: { endedAt: new Date() },
    }),
  );
}

function replyScript(reply: string): Script {
  return async function* () {
    yield { type: "text", delta: reply };
    yield { type: "turn_done", finalText: reply };
  };
}

// ------------------------------------------------------------------ tests

describe("send_message on an implementation execution (design.md §9.3, §10.2, AC1)", () => {
  it("resumes with the message header, stores the agent reply on the issue and returns to WAITING_FOR_USER, twice", async () => {
    const s = await seedWaiting();
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let during: ExecutionState | undefined;
    adapter.script = async function* (req) {
      during = (await execution(s.executionId)).state;
      const reply = req.prompt.includes("first") ? "Device language, per the ticket." : "Yes, store language is also possible.";
      yield { type: "text", delta: reply };
      yield { type: "turn_done", finalText: reply };
    };

    const first = await enqueue(s, "send_message", { issue_id: s.issueId, text: "first: which one do you prefer?" });
    await consume(HOST, s.workerId, runner);
    expect((await command(first)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(during).toBe("RUNNING");
    expect(adapter.resumes).toHaveLength(1);
    const req = adapter.resumes[0]!;
    expect(req.sessionId).toBe(`sess-${s.n}`);
    expect(req.prompt.startsWith("## Message from the user")).toBe(true);
    expect(req.prompt).toContain("first: which one do you prefer?");
    expect(req.prompt).toContain(s.issueId);

    let row = await execution(s.executionId);
    expect(row.state).toBe("WAITING_FOR_USER");
    expect(row.endReason).toBeNull();
    let replies = await agentMessages(s.issueId);
    expect(replies.map((m) => m.body)).toEqual(["Device language, per the ticket."]);
    expect(replies[0]!.userId).toBeNull();

    const second = await enqueue(s, "send_message", { issue_id: s.issueId, text: "second: can it be the store's?" });
    await consume(HOST, s.workerId, runner);
    expect((await command(second)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    row = await execution(s.executionId);
    expect(row.state).toBe("WAITING_FOR_USER");
    expect(row.endReason).toBeNull();
    replies = await agentMessages(s.issueId);
    expect(replies.map((m) => m.body)).toEqual([
      "Device language, per the ticket.",
      "Yes, store language is also possible.",
    ]);
    expect(adapter.resumes).toHaveLength(2);

    // No protocol violation, no retry row.
    expect(await eventsOf(s.taskId, "execution.failed")).toEqual([]);
    const all = await db.query.executions.findMany({ where: (e, { eq }) => eq(e.taskId, s.taskId) });
    expect(all).toHaveLength(1);

    const resumed = await eventsOf(s.taskId, "execution.resumed");
    expect(resumed).toHaveLength(2);
    expect(resumed[0]!.payload).toMatchObject({ command: "send_message", issue_id: s.issueId });
    const messageEvents = (await eventsOf(s.taskId, "issue.message")).map((e) => e.payload);
    expect(messageEvents).toEqual([
      { issue_id: s.issueId, message_id: replies[0]!.id, author_kind: "agent" },
      { issue_id: s.issueId, message_id: replies[1]!.id, author_kind: "agent" },
    ]);
  });

  it("skips and completes a send_message whose issue is no longer OPEN", async () => {
    const s = await seedWaiting();
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    const id = await enqueue(s, "send_message", { issue_id: s.issueId, text: "hello" });
    await db.$client.unsafe("update issues set status = 'RESOLVED' where id = $1", [s.issueId]);

    await consume(HOST, s.workerId, runner);

    const row = await command(id);
    expect(row.completedAt).not.toBeNull();
    expect(adapter.resumes).toHaveLength(0);
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    expect(records.some((r) => r.msg === "command skipped" && String(r.fields.reason).includes("RESOLVED"))).toBe(true);
  });
});

describe("resume_with_decision (design.md §9.2, §10.3, AC2)", () => {
  it("resumes the recorded session with the answer header and records the issue in execution.resumed", async () => {
    const s = await seedWaiting();
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let during: ExecutionState | undefined;
    adapter.script = async function* () {
      during = (await execution(s.executionId)).state;
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "done" };
    };
    const decisionId = await resolveAsClarification(s, s.issueId, {
      decision: "Use the device language.",
      clarification: "Reinstalling resets it.",
      chosenOption: "device",
    });
    const id = await enqueue(s, "resume_with_decision", { issue_id: s.issueId, decision_id: decisionId });

    await consume(HOST, s.workerId, runner);
    expect((await command(id)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(during).toBe("RUNNING");
    expect(adapter.starts).toHaveLength(0);
    expect(adapter.resumes).toHaveLength(1);
    const req = adapter.resumes[0]!;
    expect(req.sessionId).toBe(`sess-${s.n}`);
    expect(req.prompt.startsWith(`## Answer to your issue ${s.issueId}`)).toBe(true);
    expect(req.prompt).toContain("Decision: Use the device language.");
    expect(req.prompt).toContain("Clarification: Reinstalling resets it.");
    expect(req.prompt).toContain("Chosen option: device");

    const [resumed] = await eventsOf(s.taskId, "execution.resumed");
    expect(resumed!.payload).toMatchObject({
      from: "WAITING_FOR_USER",
      to: "RUNNING",
      trigger: "execution.resumed",
      command: "resume_with_decision",
      issue_id: s.issueId,
    });
    expect(resumed!.payload).not.toHaveProperty("fresh_session");
  });

  it("skips a decision that does not belong to the issue", async () => {
    const s = await seedWaiting();
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    const otherIssue = await earlierDecision(s, "unrelated");
    const decision = await db.query.taskDecisions.findFirst({ where: (d, { eq }) => eq(d.issueId, otherIssue) });
    const id = await enqueue(s, "resume_with_decision", { issue_id: s.issueId, decision_id: decision!.id });

    await consume(HOST, s.workerId, runner);

    expect((await command(id)).completedAt).not.toBeNull();
    expect(adapter.resumes).toHaveLength(0);
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
  });
});

describe("resume_with_revision (design.md §9.2, §10.4, AC3)", () => {
  it("moves spec_revision_id to the new revision, keeps the old one in execution.resumed and prompts with the diff", async () => {
    const s = await seedWaiting();
    // What resolve-as-spec-revision then /spec/approve leave behind.
    await db.$client.unsafe("update specification_revisions set status = 'superseded' where id = $1", [s.revisionId]);
    const [v2] = await db
      .insert(specificationRevisions)
      .values({ taskId: s.taskId, version: 2, status: "approved", content: SPEC_V2 })
      .returning({ id: specificationRevisions.id });
    await db.$client.unsafe("update tasks set approved_revision_id = $2 where id = $1", [s.taskId, v2!.id]);
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let during: ExecutionState | undefined;
    adapter.script = async function* () {
      during = (await execution(s.executionId)).state;
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "reconciled" };
    };
    const id = await enqueue(s, "resume_with_revision", { revision_id: v2!.id });

    await consume(HOST, s.workerId, runner);
    expect((await command(id)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(during).toBe("RUNNING");
    expect((await execution(s.executionId)).specRevisionId).toBe(v2!.id);
    expect(adapter.resumes).toHaveLength(1);
    const prompt = adapter.resumes[0]!.prompt;
    expect(prompt.startsWith("## Specification revised to version 2")).toBe(true);
    expect(prompt).toContain("@@");
    expect(prompt).toContain("-Make receipts print in the device language");
    expect(prompt).toContain("+Make receipts print in the store language");
    expect(prompt).toContain("Reconcile this revision");

    const [resumed] = await eventsOf(s.taskId, "execution.resumed");
    expect(resumed!.payload).toMatchObject({
      command: "resume_with_revision",
      previous_spec_revision_id: s.revisionId,
      spec_revision_id: v2!.id,
    });
  });

  it("C53: rewrites .orchestra/context.json with the new revision before the adapter runs", async () => {
    const s = await seedWaiting();
    const contextFile = path.join(s.worktreePath, ".orchestra", "context.json");
    await fs.mkdir(path.dirname(contextFile), { recursive: true });
    await fs.writeFile(contextFile, JSON.stringify({ spec: { version: 1, content: SPEC_V1 } }));
    await db.$client.unsafe("update specification_revisions set status = 'superseded' where id = $1", [s.revisionId]);
    const [v2] = await db
      .insert(specificationRevisions)
      .values({ taskId: s.taskId, version: 2, status: "approved", content: SPEC_V2 })
      .returning({ id: specificationRevisions.id });
    await db.$client.unsafe("update tasks set approved_revision_id = $2 where id = $1", [s.taskId, v2!.id]);
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let seenByAgent: unknown;
    adapter.script = async function* () {
      seenByAgent = JSON.parse(await fs.readFile(contextFile, "utf8"));
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "reconciled" };
    };
    await enqueue(s, "resume_with_revision", { revision_id: v2!.id });

    await consume(HOST, s.workerId, runner);
    await turnEnded(runner, s.executionId);

    const expected = {
      task: { id: s.taskId, jira_key: s.jiraKey, jira_summary: `receipt language ${s.n}` },
      spec: { version: 2, content: SPEC_V2 },
      decisions: [],
      repository: { name: "repo", default_branch: "main", branch: s.branch },
      runtime: "claude",
      review_command: "pnpm test",
    };
    expect(seenByAgent).toEqual(expected);
    expect(JSON.parse(await fs.readFile(contextFile, "utf8"))).toEqual(expected);
  });
});

describe("issues on a spec execution (C54)", () => {
  it("send_message on an issue of a WAITING_FOR_USER spec execution stores the reply and returns to WAITING_FOR_USER", async () => {
    const s = await seedWaiting({ role: "spec" });
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let during: ExecutionState | undefined;
    adapter.script = async function* () {
      during = (await execution(s.executionId)).state;
      yield { type: "text", delta: "Store language, per the ticket." };
      yield { type: "turn_done", finalText: "Store language, per the ticket." };
    };
    const id = await enqueue(s, "send_message", { issue_id: s.issueId, text: "which one?" });

    await consume(HOST, s.workerId, runner);
    expect((await command(id)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(during).toBe("RUNNING");
    expect(adapter.resumes).toHaveLength(1);
    const req = adapter.resumes[0]!;
    expect(req.allowedTools).toBe("spec");
    expect(req.sessionId).toBe(`sess-${s.n}`);
    expect(req.prompt).toBe(issueHeader(s.issueId, `user${s.n}@example.com`, "which one?"));
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    expect((await agentMessages(s.issueId)).map((m) => m.body)).toEqual([
      "Store language, per the ticket.",
    ]);
    const [resumed] = await eventsOf(s.taskId, "execution.resumed");
    expect(resumed!.payload).toMatchObject({ command: "send_message", issue_id: s.issueId });
  });

  it("resume_with_decision moves a WAITING_FOR_USER spec execution to RUNNING, where it stays between turns", async () => {
    const s = await seedWaiting({ role: "spec" });
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let during: ExecutionState | undefined;
    adapter.script = async function* () {
      during = (await execution(s.executionId)).state;
      yield { type: "text", delta: "Noted, updating the draft." };
      yield { type: "turn_done", finalText: "Noted, updating the draft." };
    };
    const decisionId = await resolveAsClarification(s, s.issueId, {
      decision: "Use the store language.",
      chosenOption: "store",
    });
    const id = await enqueue(s, "resume_with_decision", { issue_id: s.issueId, decision_id: decisionId });

    await consume(HOST, s.workerId, runner);
    expect((await command(id)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(during).toBe("RUNNING");
    expect(adapter.starts).toHaveLength(0);
    const req = adapter.resumes[0]!;
    expect(req.allowedTools).toBe("spec");
    expect(req.prompt.startsWith(`## Answer to your issue ${s.issueId}`)).toBe(true);
    expect(req.prompt).toContain("Decision: Use the store language.");
    expect(req.prompt).toContain("Chosen option: store");
    const row = await execution(s.executionId);
    expect(row.state).toBe("RUNNING");
    expect(row.endReason).toBeNull();
    expect(await eventsOf(s.taskId, "execution.failed")).toEqual([]);
    const [resumed] = await eventsOf(s.taskId, "execution.resumed");
    expect(resumed!.payload).toMatchObject({ command: "resume_with_decision", issue_id: s.issueId });
  });

  it("a chat send_message on a RUNNING spec execution still takes the spec chat path", async () => {
    const s = await seedWaiting({ role: "spec", state: "RUNNING" });
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    adapter.script = replyScript("Here is a draft.");
    const id = await enqueue(s, "send_message", { text: "draft it please" });

    await consume(HOST, s.workerId, runner);
    expect((await command(id)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(adapter.resumes).toHaveLength(1);
    expect(adapter.resumes[0]!.prompt).toBe(specMessagePrompt("draft it please"));
    expect((await execution(s.executionId)).state).toBe("RUNNING");
    expect(await agentMessages(s.issueId)).toEqual([]);
    // In place: no transition, so no execution.resumed.
    expect(await eventsOf(s.taskId, "execution.resumed")).toEqual([]);
  });

  it("skips an issue command on an unpinned spec execution at error, since it has no fallback", async () => {
    const s = await seedWaiting({ role: "spec", host: null });
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    const id = await enqueue(s, "send_message", { issue_id: s.issueId, text: "hello" });

    await consume(HOST, s.workerId, runner);

    const row = await command(id);
    expect(row.completedAt).not.toBeNull();
    expect(adapter.resumes).toHaveLength(0);
    expect(adapter.starts).toHaveLength(0);
    expect((await execution(s.executionId)).host).toBeNull();
    expect(records.some((r) => r.level === "error" && r.msg.includes("unpinned"))).toBe(true);
  });
});

/** The implementation path's `## Message from the user` header (§9.2). */
function issueHeader(issueId: string, author: string, text: string): string {
  return `## Message from the user\nIssue ${issueId}:\n- ${author}: ${text}`;
}

describe("fresh-session fallback (C21, D5, §6.1, AC4)", () => {
  it("pins a released execution (host null) here and starts a fresh session with the full prompt and the header", async () => {
    const s = await seedWaiting({ host: null });
    const earlierIssue = await earlierDecision(s, "Receipts stay monochrome.");
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let during: { state: ExecutionState; host: string | null; workerId: string | null } | undefined;
    adapter.script = async function* () {
      const row = await execution(s.executionId);
      during = { state: row.state, host: row.host, workerId: row.workerId };
      yield { type: "session", sessionId: "fresh-session-1" };
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "done" };
    };
    const decisionId = await resolveAsClarification(s, s.issueId, { decision: "Use the device language." });
    const id = await enqueue(s, "resume_with_decision", { issue_id: s.issueId, decision_id: decisionId });

    await consume(HOST, s.workerId, runner);
    expect((await command(id)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(during).toEqual({ state: "RUNNING", host: HOST, workerId: s.workerId });
    expect(adapter.resumes).toHaveLength(0);
    expect(adapter.starts).toHaveLength(1);
    const req = adapter.starts[0]!;
    expect(req.cwd).toBe(s.worktreePath);
    expect(req.allowedTools).toBe("implementation");
    expect(req.prompt).toContain(`## Answer to your issue ${s.issueId}`);
    expect(req.prompt).toContain("## Ticket");
    expect(req.prompt).toContain(s.jiraKey);
    expect(req.prompt).toContain("## Approved specification (revision 1)");
    expect(req.prompt).toContain("Make receipts print in the device language");
    expect(req.prompt).toContain(`- ${earlierIssue}: Receipts stay monochrome.`);
    expect(req.prompt).toContain(`- ${s.issueId}: Use the device language.`);
    expect(req.prompt).toContain(`Working branch: ${s.branch}`);

    const row = await execution(s.executionId);
    expect(row.host).toBe(HOST);
    expect(row.workerId).toBe(s.workerId);
    expect(row.sessionId).toBe("fresh-session-1");
    const [resumed] = await eventsOf(s.taskId, "execution.resumed");
    expect(resumed!.payload).toMatchObject({
      command: "resume_with_decision",
      issue_id: s.issueId,
      fresh_session: true,
      reason: "host_released",
    });
  });

  it("recreates a missing worktree at the recorded path before the fresh session", async () => {
    const s = await seedWaiting({ host: null, worktree: "missing" });
    const adapter = new FakeAdapter();
    const prepared: Prepared = { calls: [] };
    const runner = makeRunner(HOST, s.workerId, adapter, prepared);
    adapter.script = replyScript("I am listening.");
    const id = await enqueue(s, "send_message", { issue_id: s.issueId, text: "still there?" });

    await consume(HOST, s.workerId, runner);
    expect((await command(id)).completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(prepared.calls).toHaveLength(1);
    expect(prepared.calls[0]!.worktreePath).toBe(s.worktreePath);
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.starts[0]!.cwd).toBe(s.worktreePath);
    expect(adapter.starts[0]!.prompt).toContain("## Message from the user");
    expect(adapter.starts[0]!.prompt).toContain("still there?");
    // The conversation turn ends back in WAITING_FOR_USER.
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    expect((await agentMessages(s.issueId)).map((m) => m.body)).toEqual(["I am listening."]);
  });

  it("starts fresh on this host when canResume is false for the recorded session", async () => {
    const s = await seedWaiting();
    const adapter = new FakeAdapter();
    adapter.resumable = false;
    const runner = makeRunner(HOST, s.workerId, adapter);
    adapter.script = async function* () {
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "done" };
    };
    const decisionId = await resolveAsClarification(s, s.issueId, { decision: "Device." });
    await enqueue(s, "resume_with_decision", { issue_id: s.issueId, decision_id: decisionId });

    await consume(HOST, s.workerId, runner);
    await turnEnded(runner, s.executionId);

    expect(adapter.resumes).toHaveLength(0);
    expect(adapter.starts).toHaveLength(1);
    const [resumed] = await eventsOf(s.taskId, "execution.resumed");
    expect(resumed!.payload).toMatchObject({ fresh_session: true, reason: "cannot_resume" });
  });

  it("leaves a command for an execution pinned to another live host unclaimed", async () => {
    const s = await seedWaiting({ host: OTHER_HOST });
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    const id = await enqueue(s, "send_message", { issue_id: s.issueId, text: "hello" });

    await consume(HOST, s.workerId, runner);

    const row = await command(id);
    expect(row.claimedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(adapter.starts).toHaveLength(0);
    expect(adapter.resumes).toHaveLength(0);
    expect((await execution(s.executionId)).host).toBe(OTHER_HOST);
  });

  it("unclaims when the execution is pinned to another host by the time the handler runs", async () => {
    const s = await seedWaiting({ host: OTHER_HOST });
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    const decisionId = await resolveAsClarification(s, s.issueId, { decision: "Device." });
    const id = await enqueue(s, "resume_with_decision", { issue_id: s.issueId, decision_id: decisionId });
    await db.$client.unsafe("update execution_commands set claimed_at = now() where id = $1", [id]);
    const claimed: ExecutionCommandRow = await command(id);

    const handler = handlersFor(runner).handlerFor("resume_with_decision")!;
    const outcome = await handler(claimed, {
      db,
      workerId: s.workerId,
      host: HOST,
      now: new Date(),
      logger,
    });

    expect(outcome).toEqual({ outcome: "unclaimed" });
    expect((await command(id)).claimedAt).toBeNull();
    const row = await execution(s.executionId);
    expect(row.host).toBe(OTHER_HOST);
    expect(row.state).toBe("WAITING_FOR_USER");
    expect(adapter.starts).toHaveLength(0);
  });
});

describe("live turns and refusals (AC5)", () => {
  it("unclaims a send_message that arrives while a turn is live and handles it on the next pass", async () => {
    const s = await seedWaiting();
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let turns = 0;
    adapter.script = async function* () {
      turns += 1;
      if (turns === 1) await gate;
      const reply = `reply ${turns}`;
      yield { type: "text", delta: reply };
      yield { type: "turn_done", finalText: reply };
    };

    const first = await enqueue(s, "send_message", { issue_id: s.issueId, text: "one" });
    await consume(HOST, s.workerId, runner);
    expect((await command(first)).completedAt).not.toBeNull();
    expect(runner.isLive(s.executionId)).toBe(true);

    const second = await enqueue(s, "send_message", { issue_id: s.issueId, text: "two" });
    await consume(HOST, s.workerId, runner);
    let row = await command(second);
    expect(row.claimedAt).toBeNull();
    expect(row.completedAt).toBeNull();

    release();
    await turnEnded(runner, s.executionId);
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");

    await consume(HOST, s.workerId, runner);
    row = await command(second);
    expect(row.completedAt).not.toBeNull();
    await turnEnded(runner, s.executionId);

    expect(adapter.resumes).toHaveLength(2);
    expect(adapter.resumes[1]!.prompt).toContain("two");
    expect((await agentMessages(s.issueId)).map((m) => m.body)).toEqual(["reply 1", "reply 2"]);
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
  });

  it("skips and completes a resume that hits NO_SESSION after the fallback, logging at error", async () => {
    const s = await seedWaiting({ host: null, worktree: "none" });
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    const decisionId = await resolveAsClarification(s, s.issueId, { decision: "Device." });
    const id = await enqueue(s, "resume_with_decision", { issue_id: s.issueId, decision_id: decisionId });

    await consume(HOST, s.workerId, runner);

    const row = await command(id);
    expect(row.completedAt).not.toBeNull();
    expect(adapter.starts).toHaveLength(0);
    expect(adapter.resumes).toHaveLength(0);
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    expect(records.some((r) => r.level === "error" && r.fields.code === "NO_SESSION")).toBe(true);
  });
});
