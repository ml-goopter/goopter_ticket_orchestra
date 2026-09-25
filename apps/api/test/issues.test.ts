import type { SpecContent } from "@orchestra/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Clock,
  type Fixtures,
  type TestDb,
  buildTestApp,
  createClock,
  seedExecution,
  seedFixtures,
  seedIssue,
  seedRevision,
  seedSession,
  seedTask,
  sessionCookieHeader,
  startTestDb,
} from "./harness.js";

let h: TestDb;
let app: FastifyInstance;
let clock: Clock;
let fx: Fixtures;
let cookie: string;

const REPO = "iss-repo";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  h = await startTestDb();
  clock = createClock(new Date("2026-01-01T00:00:00Z"));
  app = await buildTestApp(h, clock);
  fx = await seedFixtures(h.db, "ISS");
  const sessionId = await seedSession(h.db, {
    userId: fx.userId,
    expiresAt: new Date(clock.now().getTime() + 1000 * 60 * 60),
  });
  cookie = sessionCookieHeader(sessionId);
}, 180000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

let keyCounter = 100;
function nextKey(): string {
  keyCounter += 1;
  return `ISS-${keyCounter}`;
}

async function newTask(
  state: Parameters<typeof seedTask>[2]["state"],
  extra: Partial<Parameters<typeof seedTask>[2]> = {},
): Promise<string> {
  const key = nextKey();
  return seedTask(h.db, fx, { jiraKey: key, state, ...extra });
}

function content(overrides: Partial<SpecContent> = {}): SpecContent {
  return {
    repository: REPO,
    objective: "Do the thing",
    scope: ["scope"],
    out_of_scope: ["not that"],
    requirements: ["req"],
    acceptance_criteria: ["ac"],
    validation: ["run tests"],
    constraints: ["none"],
    dependencies: [],
    ...overrides,
  };
}

async function setApprovedRevision(taskId: string, revisionId: string): Promise<void> {
  await h.sql`update tasks set approved_revision_id = ${revisionId} where id = ${taskId}`;
}

function get(url: string, withCookie = true) {
  return app.inject({ method: "GET", url, headers: withCookie ? { cookie } : {} });
}

function post(url: string, payload?: unknown, withCookie = true) {
  return app.inject({
    method: "POST",
    url,
    headers: withCookie ? { cookie } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function issueRow(issueId: string) {
  const [row] = await h.sql<
    {
      status: string;
      resolution_kind: string | null;
      resolution: string | null;
      resolved_by: string | null;
      resolved_at: Date | null;
      blocking: boolean;
    }[]
  >`select status, resolution_kind, resolution, resolved_by, resolved_at, blocking from issues where id = ${issueId}`;
  return row!;
}

async function taskRow(taskId: string) {
  const [row] = await h.sql<{ state: string; approved_revision_id: string | null }[]>`
    select state, approved_revision_id from tasks where id = ${taskId}`;
  return row!;
}

async function executionRow(executionId: string) {
  const [row] = await h.sql<{ state: string }[]>`
    select state from executions where id = ${executionId}`;
  return row!;
}

async function messages(issueId: string) {
  return h.sql<{ author_kind: string; user_id: string | null; body: string }[]>`
    select author_kind, user_id, body from issue_messages where issue_id = ${issueId} order by created_at, id`;
}

async function decisions(issueId: string) {
  return h.sql<
    {
      id: string;
      task_id: string;
      decision: string;
      clarification: string | null;
      chosen_option: string | null;
      decided_by: string;
    }[]
  >`select id, task_id, decision, clarification, chosen_option, decided_by from task_decisions where issue_id = ${issueId}`;
}

async function commands(taskId: string) {
  return h.sql<
    { type: string; execution_id: string | null; payload: Record<string, unknown> }[]
  >`select type, execution_id, payload from execution_commands where task_id = ${taskId} order by created_at, id`;
}

async function eventTypes(taskId: string): Promise<string[]> {
  const rows = await h.sql<{ type: string }[]>`
    select type from execution_events where task_id = ${taskId} order by id`;
  return rows.map((r) => r.type);
}

async function eventPayloads(taskId: string): Promise<Record<string, unknown>[]> {
  const rows = await h.sql<{ payload: Record<string, unknown> }[]>`
    select payload from execution_events where task_id = ${taskId} order by id`;
  return rows.map((r) => r.payload);
}

async function revisions(taskId: string) {
  return h.sql<{ id: string; version: number; status: string; content: SpecContent }[]>`
    select id, version, status, content from specification_revisions where task_id = ${taskId} order by version`;
}

/** Everything an issue route could write, for "nothing written" checks. */
async function snapshot(issueId: string, taskId: string) {
  return {
    issue: await issueRow(issueId),
    task: await taskRow(taskId),
    messages: await messages(issueId),
    decisions: await decisions(issueId),
    commands: await commands(taskId),
    events: await eventTypes(taskId),
    revisions: (await revisions(taskId)).map((r) => ({ status: r.status, version: r.version })),
  };
}

describe("GET /api/issues (AC1)", () => {
  it("filters by status and blocking", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const open = await seedIssue(h.db, { taskId, executionId: execId, blocking: true, status: "OPEN" });
    const resolved = await seedIssue(h.db, { taskId, executionId: execId, blocking: false, status: "RESOLVED" });

    const all = await get("/api/issues");
    expect(all.statusCode).toBe(200);
    const allIds = (all.json() as Array<{ id: string }>).map((r) => r.id);
    expect(allIds).toContain(open);
    expect(allIds).toContain(resolved);

    const openOnly = await get("/api/issues?status=OPEN");
    expect((openOnly.json() as Array<{ id: string }>).map((r) => r.id)).toEqual([open]);

    const blockingOnly = await get("/api/issues?blocking=1");
    expect((blockingOnly.json() as Array<{ id: string }>).map((r) => r.id)).toEqual([open]);

    const nonBlockingOnly = await get("/api/issues?blocking=0");
    expect((nonBlockingOnly.json() as Array<{ id: string }>).map((r) => r.id)).toEqual([resolved]);
  });

  it("returns 400 for an invalid status or blocking value", async () => {
    expect((await get("/api/issues?status=BOGUS")).statusCode).toBe(400);
    expect((await get("/api/issues?blocking=yes")).statusCode).toBe(400);
  });

  it("orders results by created_at ascending, regardless of insertion order", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const later = await seedIssue(h.db, {
      taskId,
      executionId: execId,
      blocking: true,
      status: "OPEN",
      createdAt: new Date("2026-01-05T00:00:00Z"),
    });
    const earlier = await seedIssue(h.db, {
      taskId,
      executionId: execId,
      blocking: true,
      status: "OPEN",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    const res = await get(`/api/issues?status=OPEN&blocking=1`);
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>)
      .map((r) => r.id)
      .filter((id) => id === earlier || id === later);
    expect(ids).toEqual([earlier, later]);
  });
});

describe("GET /api/issues/:id (AC2)", () => {
  it("returns messages, execution and task context, and decision", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, {
      role: "implementation",
      state: "WAITING_FOR_USER",
      runtime: "claude",
    });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });

    const withCookie = { cookie };
    await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/messages`,
      headers: withCookie,
      payload: { text: "hello" },
    });

    const res = await get(`/api/issues/${issueId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issue.id).toBe(issueId);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ authorKind: "user", body: "hello" });
    expect(body.execution).toMatchObject({ id: execId, role: "implementation", state: "WAITING_FOR_USER", runtime: "claude" });
    expect(body.task).toMatchObject({ id: taskId, jira_key: expect.any(String), state: "IMPLEMENTING" });
    expect(body.decision).toBeNull();
  });

  it("returns 404 for an unknown or non-UUID id", async () => {
    expect((await get(`/api/issues/${UNKNOWN_ID}`)).statusCode).toBe(404);
    expect((await get(`/api/issues/not-a-uuid`)).statusCode).toBe(400);
  });
});

describe("POST /api/issues/:id/messages (AC3)", () => {
  it("inserts a message and a send_message command", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });

    const res = await post(`/api/issues/${issueId}/messages`, { text: "please clarify" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messageId: expect.any(String), commandId: expect.any(String), executionId: execId });

    const msgs = await messages(issueId);
    expect(msgs).toEqual([{ author_kind: "user", user_id: fx.userId, body: "please clarify" }]);

    const cmds = await commands(taskId);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      type: "send_message",
      execution_id: execId,
      payload: { issue_id: issueId, text: "please clarify" },
    });
    expect(await eventTypes(taskId)).toEqual(["issue.message"]);
  });

  it("returns 409 ISSUE_NOT_OPEN when the issue is not open and writes nothing", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true, status: "RESOLVED" });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/messages`, { text: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ISSUE_NOT_OPEN");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });

  it("returns 409 EXECUTION_NOT_WAITING when the execution isn't waiting and writes nothing", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "RUNNING" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/messages`, { text: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EXECUTION_NOT_WAITING");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });

  it("returns 400 for empty text and writes nothing", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    expect((await post(`/api/issues/${issueId}/messages`, { text: "" })).statusCode).toBe(400);
    expect((await post(`/api/issues/${issueId}/messages`, {})).statusCode).toBe(400);
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });
});

describe("POST /api/issues/:id/resolve clarification (AC4)", () => {
  it("resolves a blocking issue as clarification and enqueues resume_with_decision", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });

    const res = await post(`/api/issues/${issueId}/resolve`, {
      kind: "clarification",
      decision: "Use approach A",
      clarification: "because it's simpler",
      chosen_option: "A",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      issueId,
      kind: "clarification",
      commandId: expect.any(String),
      task: null,
      revisionId: null,
    });

    const resolved = await issueRow(issueId);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolution_kind).toBe("clarification");
    expect(resolved.resolution).toBe("Use approach A");
    expect(resolved.resolved_by).toBe(fx.userId);
    expect(new Date(resolved.resolved_at!).getTime()).toBe(clock.now().getTime());
    const decisionRows = await decisions(issueId);
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0]).toMatchObject({
      task_id: taskId,
      decision: "Use approach A",
      clarification: "because it's simpler",
      chosen_option: "A",
      decided_by: fx.userId,
    });
    expect(body.decisionId).toBe(decisionRows[0]!.id);

    const cmds = await commands(taskId);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      type: "resume_with_decision",
      execution_id: execId,
      payload: { issue_id: issueId, decision_id: decisionRows[0]!.id },
    });
    expect(await eventTypes(taskId)).toEqual(["issue.resolved"]);
    expect((await taskRow(taskId)).state).toBe("IMPLEMENTING");
    expect((await executionRow(execId)).state).toBe("WAITING_FOR_USER");
  });

  it("returns 409 EXECUTION_NOT_WAITING for a blocking clarification when the execution isn't waiting", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "RUNNING" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "clarification", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EXECUTION_NOT_WAITING");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });
});

describe("POST /api/issues/:id/resolve spec_revision (AC5, AC6)", () => {
  it("creates a draft from the approved content, moves the task to SPEC_IN_PROGRESS, and supersedes other open issues on the same execution only", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const approved = await seedRevision(h.db, taskId, 1, "approved", content({ objective: "v1", notes: "old notes" }));
    await setApprovedRevision(taskId, approved);
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true, title: "Need decision" });
    const otherOnSameExec = await seedIssue(h.db, { taskId, executionId: execId, blocking: false });

    const otherTaskId = await newTask("IMPLEMENTING");
    const otherExecId = await seedExecution(h.db, otherTaskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueOnDifferentExec = await seedIssue(h.db, { taskId: otherTaskId, executionId: otherExecId, blocking: false });

    const res = await post(`/api/issues/${issueId}/resolve`, {
      kind: "spec_revision",
      decision: "Change the approach entirely",
      clarification: "extra context",
      chosen_option: "B",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      issueId,
      kind: "spec_revision",
      commandId: null,
      task: { from: "IMPLEMENTING", to: "SPEC_IN_PROGRESS" },
      revisionId: expect.any(String),
    });

    const resolved = await issueRow(issueId);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolution_kind).toBe("spec_revision");
    expect(resolved.resolution).toBe("Change the approach entirely");
    expect(resolved.resolved_by).toBe(fx.userId);
    expect(new Date(resolved.resolved_at!).getTime()).toBe(clock.now().getTime());
    expect((await taskRow(taskId)).state).toBe("SPEC_IN_PROGRESS");
    expect((await executionRow(execId)).state).toBe("WAITING_FOR_USER");

    const revs = await revisions(taskId);
    const draft = revs.find((r) => r.status === "draft")!;
    expect(draft.id).toBe(body.revisionId);
    expect(draft.content.objective).toBe("v1");
    expect(draft.content.notes).toContain("old notes");
    expect(draft.content.notes).toContain("Change the approach entirely");

    expect(await commands(taskId)).toHaveLength(0);
    const types = await eventTypes(taskId);
    expect(types).toContain("issue.resolved");
    expect(types).toContain("spec.revised");
    expect(types).toContain("task.state_changed");

    const payloads = await eventPayloads(taskId);
    const supersedeEvent = payloads.find(
      (p) => p["issue_id"] === otherOnSameExec && p["status"] === "SUPERSEDED",
    );
    expect(supersedeEvent).toMatchObject({ superseded_by: issueId });

    const superseded = await issueRow(otherOnSameExec);
    expect(superseded.status).toBe("SUPERSEDED");
    expect(new Date(superseded.resolved_at!).getTime()).toBe(clock.now().getTime());
    expect(superseded.resolution_kind).toBeNull();
    expect((await issueRow(issueOnDifferentExec)).status).toBe("OPEN");
  });

  it("returns 409 ILLEGAL_TRANSITION when the task is SPEC_IN_PROGRESS and writes nothing", async () => {
    const taskId = await newTask("SPEC_IN_PROGRESS");
    const approved = await seedRevision(h.db, taskId, 1, "approved", content());
    await setApprovedRevision(taskId, approved);
    const execId = await seedExecution(h.db, taskId, { role: "spec", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "spec_revision", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });

  it("returns 409 EXECUTION_NOT_WAITING when the execution isn't waiting and writes nothing", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const approved = await seedRevision(h.db, taskId, 1, "approved", content());
    await setApprovedRevision(taskId, approved);
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "RUNNING" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "spec_revision", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EXECUTION_NOT_WAITING");
    expect(await snapshot(issueId, taskId)).toEqual(before);
    expect((await issueRow(issueId)).status).toBe("OPEN");
    expect((await taskRow(taskId)).state).toBe("IMPLEMENTING");
  });

  it("checks the transition before the execution state: SPEC_IN_PROGRESS with a running execution is ILLEGAL_TRANSITION, not EXECUTION_NOT_WAITING", async () => {
    const taskId = await newTask("SPEC_IN_PROGRESS");
    const approved = await seedRevision(h.db, taskId, 1, "approved", content());
    await setApprovedRevision(taskId, approved);
    const execId = await seedExecution(h.db, taskId, { role: "spec", state: "RUNNING" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "spec_revision", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });

  it("checks the execution state before the approved-revision check: no approved revision with a running execution is EXECUTION_NOT_WAITING, not NO_APPROVED_REVISION", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "RUNNING" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "spec_revision", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EXECUTION_NOT_WAITING");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });

  it("returns 409 NO_APPROVED_REVISION without an approved revision and writes nothing", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "spec_revision", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NO_APPROVED_REVISION");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });

  it("returns 409 DRAFT_EXISTS when the task already has a draft and writes nothing", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const approved = await seedRevision(h.db, taskId, 1, "approved", content());
    await setApprovedRevision(taskId, approved);
    await seedRevision(h.db, taskId, 2, "draft", content({ objective: "in progress" }));
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "spec_revision", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DRAFT_EXISTS");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });
});

describe("POST /api/issues/:id/resolve non-blocking (AC7)", () => {
  it("records a decision, enqueues no command, leaves task and execution unchanged", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "RUNNING" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: false });

    const res = await post(`/api/issues/${issueId}/resolve`, {
      kind: "clarification",
      decision: "Noted, no change needed",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ issueId, kind: "clarification", commandId: null, task: null, revisionId: null });

    expect((await issueRow(issueId)).status).toBe("RESOLVED");
    expect((await decisions(issueId))).toHaveLength(1);
    expect(await commands(taskId)).toHaveLength(0);
    expect((await taskRow(taskId)).state).toBe("IMPLEMENTING");
    expect((await executionRow(execId)).state).toBe("RUNNING");
  });

  it("returns 409 ILLEGAL_RESOLUTION for spec_revision on a non-blocking issue and writes nothing", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: false });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "spec_revision", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_RESOLUTION");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });
});

describe("POST /api/issues/:id/resolve on an already resolved issue (AC8)", () => {
  it("returns 409 ISSUE_NOT_OPEN and writes nothing", async () => {
    const taskId = await newTask("IMPLEMENTING");
    const execId = await seedExecution(h.db, taskId, { role: "implementation", state: "WAITING_FOR_USER" });
    const issueId = await seedIssue(h.db, { taskId, executionId: execId, blocking: true, status: "RESOLVED" });
    const before = await snapshot(issueId, taskId);

    const res = await post(`/api/issues/${issueId}/resolve`, { kind: "clarification", decision: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ISSUE_NOT_OPEN");
    expect(await snapshot(issueId, taskId)).toEqual(before);
  });
});

describe("auth (P9)", () => {
  it("returns 401 without a session", async () => {
    expect((await get("/api/issues", false)).statusCode).toBe(401);
    expect((await post(`/api/issues/${UNKNOWN_ID}/messages`, { text: "hi" }, false)).statusCode).toBe(401);
    expect((await post(`/api/issues/${UNKNOWN_ID}/resolve`, { kind: "clarification", decision: "x" }, false)).statusCode).toBe(401);
  });
});
