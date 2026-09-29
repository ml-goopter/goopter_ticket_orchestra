import { TaskState } from "@orchestra/core";
import {
  executionEvents,
  executions,
  notifications,
  projects,
  tasks,
  type Db,
} from "@orchestra/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JiraApiError, MISSING_JIRA_PRIORITY } from "../src/jira/client.js";
import type { JiraClient, JiraSearchIssue } from "../src/jira/client.js";
import { pollProject } from "../src/jira/poller.js";
import type { Logger } from "../src/logger.js";
import { startTestDb, type TestDb } from "./harness.js";

let testDb: TestDb;
let db: Db;
let projectCounter = 0;

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const actor = { kind: "worker" as const, id: "jira-poller-test-worker" };

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.stop();
});

async function insertProject(jiraJql = "project = TEST") {
  projectCounter += 1;
  const [row] = await db
    .insert(projects)
    .values({
      key: `PRJ${projectCounter}`,
      name: `Test project ${projectCounter}`,
      jiraJql,
    })
    .returning();
  return row!;
}

async function insertTask(
  projectId: string,
  overrides: Partial<typeof tasks.$inferInsert> = {},
) {
  const [row] = await db
    .insert(tasks)
    .values({
      projectId,
      jiraKey: `GOOP-${Math.random().toString(36).slice(2, 8)}`,
      jiraSummary: "original summary",
      jiraPriority: 5,
      jiraCreatedAt: new Date("2025-01-01T00:00:00.000Z"),
      jiraSyncedAt: new Date("2025-01-01T00:00:00.000Z"),
      state: TaskState.NEEDS_SPEC,
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertExecution(
  taskId: string,
  overrides: Partial<typeof executions.$inferInsert> = {},
) {
  const [row] = await db
    .insert(executions)
    .values({
      taskId,
      role: "implementation",
      attempt: 1,
      state: "RUNNING",
      runtime: "codex",
      model: "gpt-5-codex",
      ...overrides,
    })
    .returning();
  return row!;
}

function fakeClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    search: vi.fn(async () => []),
    getIssueStatus: vi.fn(async () => ({ statusCategory: "indeterminate" })),
    getIssue: vi.fn(async () => {
      throw new Error("getIssue not used by the poller");
    }),
    addComment: vi.fn(async () => {
      throw new Error("addComment not used by the poller");
    }),
    ...overrides,
  };
}

// Plain array filters rather than drizzle-orm's `eq`/`and`: the worker does
// not depend on `drizzle-orm` directly, only through `@orchestra/db`'s
// query modules, and this test should not add that dependency just to
// build `where` clauses.
async function taskByKey(jiraKey: string) {
  const rows = await db.select().from(tasks);
  return rows.filter((row) => row.jiraKey === jiraKey);
}

async function tasksForProject(projectId: string) {
  const rows = await db.select().from(tasks);
  return rows.filter((row) => row.projectId === projectId);
}

async function eventsForTask(taskId: string) {
  const rows = await db.select().from(executionEvents);
  return rows.filter((row) => row.taskId === taskId);
}

async function stateChangedEventsFor(taskId: string) {
  const rows = await eventsForTask(taskId);
  return rows.filter((row) => row.type === "task.state_changed");
}

describe("pollProject: new keys (design.md §11.1, C2)", () => {
  it("inserts a new key in NEEDS_SPEC with the Jira fields set, plus one creation event", async () => {
    const project = await insertProject();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const syncedAt = new Date("2026-01-02T00:00:00.000Z");
    const client = fakeClient({
      search: vi.fn(async () => [
        { key: "GOOP-100", summary: "Do the thing", priority: 2, createdAt },
      ]),
    });

    await pollProject({ db, project, client, actor, logger, now: () => syncedAt });

    const [task] = await taskByKey("GOOP-100");
    expect(task).toBeDefined();
    expect(task!.state).toBe(TaskState.NEEDS_SPEC);
    expect(task!.jiraSummary).toBe("Do the thing");
    expect(task!.jiraPriority).toBe(2);
    expect(task!.jiraCreatedAt.toISOString()).toBe(createdAt.toISOString());
    expect(task!.jiraSyncedAt.toISOString()).toBe(syncedAt.toISOString());

    const events = await stateChangedEventsFor(task!.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      from: null,
      to: "NEEDS_SPEC",
      trigger: "jira.imported",
    });
  });
});

describe("pollProject: missing priority (design.md §11.1, F1 regression)", () => {
  it("inserts a ticket with no priority using a sentinel that fits jira_priority (int4)", async () => {
    const project = await insertProject();
    const client = fakeClient({
      search: vi.fn(async () => [
        {
          key: "GOOP-109",
          summary: "no priority",
          priority: MISSING_JIRA_PRIORITY,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    });

    await pollProject({ db, project, client, actor, logger });

    const [task] = await taskByKey("GOOP-109");
    expect(task).toBeDefined();
    expect(task!.jiraPriority).toBe(MISSING_JIRA_PRIORITY);
  });
});

describe("pollProject: idempotency (design.md §11.1, C3)", () => {
  it("polling twice produces no duplicate task or creation event", async () => {
    const project = await insertProject();
    const client = fakeClient({
      search: vi.fn(async () => [
        { key: "GOOP-101", summary: "s", priority: 1, createdAt: new Date() },
      ]),
    });

    await pollProject({ db, project, client, actor, logger });
    await pollProject({ db, project, client, actor, logger });

    const rows = await taskByKey("GOOP-101");
    expect(rows).toHaveLength(1);
    const events = await stateChangedEventsFor(rows[0]!.id);
    expect(events).toHaveLength(1);
  });

  it("two concurrent polls of the same results produce no duplicate task or creation event", async () => {
    const project = await insertProject();
    const issue = { key: "GOOP-102", summary: "s", priority: 1, createdAt: new Date() };
    const client = fakeClient({ search: vi.fn(async () => [issue]) });

    await Promise.all([
      pollProject({ db, project, client, actor, logger }),
      pollProject({ db, project, client, actor, logger }),
    ]);

    const rows = await taskByKey("GOOP-102");
    expect(rows).toHaveLength(1);
    const events = await stateChangedEventsFor(rows[0]!.id);
    expect(events).toHaveLength(1);
  });
});

describe("pollProject: existing keys (design.md §11.1, C4)", () => {
  it("refreshes summary, priority and synced_at only, leaving state and everything else untouched", async () => {
    const project = await insertProject();
    const existing = await insertTask(project.id, {
      jiraKey: "GOOP-103",
      jiraSummary: "old summary",
      jiraPriority: 5,
      jiraCreatedAt: new Date("2025-06-01T00:00:00.000Z"),
      jiraSyncedAt: new Date("2025-06-02T00:00:00.000Z"),
      state: TaskState.NEEDS_SPEC,
    });

    const syncedAt = new Date("2026-03-01T00:00:00.000Z");
    const client = fakeClient({
      search: vi.fn(async () => [
        { key: "GOOP-103", summary: "new summary", priority: 1, createdAt: new Date("2020-01-01") },
      ]),
    });

    await pollProject({ db, project, client, actor, logger, now: () => syncedAt });

    const [after] = await taskByKey("GOOP-103");
    expect(after!.jiraSummary).toBe("new summary");
    expect(after!.jiraPriority).toBe(1);
    expect(after!.jiraSyncedAt.toISOString()).toBe(syncedAt.toISOString());
    // Untouched: state, jira_created_at, id.
    expect(after!.state).toBe(TaskState.NEEDS_SPEC);
    expect(after!.jiraCreatedAt.toISOString()).toBe(existing.jiraCreatedAt.toISOString());
    expect(after!.id).toBe(existing.id);

    const events = await stateChangedEventsFor(existing.id);
    expect(events).toHaveLength(0);
  });

  it("refreshes a terminal task's summary and priority without touching its state", async () => {
    const project = await insertProject();
    const existing = await insertTask(project.id, {
      jiraKey: "GOOP-104",
      state: TaskState.DONE,
    });

    const client = fakeClient({
      search: vi.fn(async () => [
        { key: "GOOP-104", summary: "refreshed", priority: 3, createdAt: existing.jiraCreatedAt },
      ]),
    });

    await pollProject({ db, project, client, actor, logger });

    const [after] = await taskByKey("GOOP-104");
    expect(after!.jiraSummary).toBe("refreshed");
    expect(after!.jiraPriority).toBe(3);
    expect(after!.state).toBe(TaskState.DONE);
  });
});

describe("pollProject: missing keys (design.md §11.1, E3, Q1, C5)", () => {
  it("moves a missing task to FAILED with an agent.note reason, in the same transaction", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { jiraKey: "GOOP-105" });
    const client = fakeClient({
      search: vi.fn(async () => []),
      getIssueStatus: vi.fn(async () => null),
    });

    await pollProject({ db, project, client, actor, logger });

    const rows = await taskByKey("GOOP-105");
    expect(rows[0]!.state).toBe(TaskState.FAILED);

    const events = await eventsForTask(task.id);
    const failedStateChange = events.find(
      (e) => e.type === "task.state_changed",
    );
    expect(failedStateChange).toBeDefined();
    expect(failedStateChange!.payload).toMatchObject({ to: "FAILED" });
    const note = events.find((e) => e.type === "agent.note");
    expect(note).toBeDefined();
    expect(note!.executionId).toBeNull();
    expect(note!.payload).toMatchObject({ source: "jira-poller" });
    expect((note!.payload as { reason: string }).reason).toContain("GOOP-105");
  });

  it("looks up a missing task's ticket status when it still returns 200 (GOT.77)", async () => {
    const project = await insertProject();
    await insertTask(project.id, { jiraKey: "GOOP-106" });
    const client = fakeClient({ search: vi.fn(async () => []) });

    await pollProject({ db, project, client, actor, logger });

    expect(client.getIssueStatus).toHaveBeenCalledWith("GOOP-106");
  });

  it("never re-checks a terminal task even when it is absent from the search", async () => {
    const project = await insertProject();
    await insertTask(project.id, { jiraKey: "GOOP-107", state: TaskState.DONE });
    const client = fakeClient({
      search: vi.fn(async () => []),
      getIssueStatus: vi.fn(async () => {
        throw new Error("getIssueStatus should not be called for a terminal task");
      }),
    });

    await expect(
      pollProject({ db, project, client, actor, logger }),
    ).resolves.toBeUndefined();
    expect(client.getIssueStatus).not.toHaveBeenCalled();
  });
});

describe("pollProject: missing keys cancel active executions (design.md §11.1, F2 regression)", () => {
  it("cancels a RUNNING execution in the same transaction the task fails in", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { jiraKey: "GOOP-110" });
    const execution = await insertExecution(task.id, { state: "RUNNING" });
    const client = fakeClient({
      search: vi.fn(async () => []),
      getIssueStatus: vi.fn(async () => null),
    });

    await pollProject({ db, project, client, actor, logger });

    const [after] = await taskByKey("GOOP-110");
    expect(after!.state).toBe(TaskState.FAILED);

    const executionRows = await db.select().from(executions);
    const executionAfter = executionRows.find((row) => row.id === execution.id);
    expect(executionAfter!.state).toBe("CANCELLED");
  });
});

describe("pollProject: search failures (design.md §11.1, C6)", () => {
  it("leaves the database unchanged and does not throw when search fails", async () => {
    const project = await insertProject();
    const client = fakeClient({
      search: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    });

    await expect(
      pollProject({ db, project, client, actor, logger }),
    ).resolves.toBeUndefined();

    const rows = await tasksForProject(project.id);
    expect(rows).toHaveLength(0);
  });

  it("an error on one project does not prevent the next project from being polled", async () => {
    const projectA = await insertProject();
    const projectB = await insertProject();
    const clientA = fakeClient({
      search: vi.fn(async () => {
        throw new Error("500 from Jira");
      }),
    });
    const clientB = fakeClient({
      search: vi.fn(async () => [
        { key: "GOOP-108", summary: "s", priority: 1, createdAt: new Date() },
      ]),
    });

    await pollProject({ db, project: projectA, client: clientA, actor, logger });
    await pollProject({ db, project: projectB, client: clientB, actor, logger });

    const rowsA = await tasksForProject(projectA.id);
    expect(rowsA).toHaveLength(0);
    const rowsB = await taskByKey("GOOP-108");
    expect(rowsB).toHaveLength(1);
  });
});

// GOT.77, user decision O1 (2026-09-28): tasks follow their Jira ticket being
// closed (status category Done) or leaving the project's JQL.

function searchIssue(
  key: string,
  statusCategory: string | null,
): JiraSearchIssue {
  return {
    key,
    summary: "s",
    priority: 1,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    statusCategory,
  };
}

async function notesFor(taskId: string) {
  const rows = await eventsForTask(taskId);
  return rows
    .filter((row) => row.type === "agent.note")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => row.payload as { source?: string; reason?: string; jiraScope?: string });
}

async function notificationsFor(taskId: string) {
  const rows = await db.select().from(notifications);
  return rows.filter((row) => row.taskId === taskId);
}

async function executionById(executionId: string) {
  const rows = await db.select().from(executions);
  return rows.find((row) => row.id === executionId);
}

let keyCounter = 0;
const nextKey = () => `SCRUM-${++keyCounter}`;

const SPEC_GROUP = [
  TaskState.NEEDS_SPEC,
  TaskState.SPEC_IN_PROGRESS,
  TaskState.SPEC_REVIEW,
  TaskState.SPEC_APPROVED,
] as const;

const WORK_UNDER_WAY = [
  TaskState.READY,
  TaskState.BLOCKED,
  TaskState.IMPLEMENTING,
  TaskState.REVIEWING,
  TaskState.CI_RUNNING,
  TaskState.READY_FOR_MERGE,
  TaskState.NEEDS_HUMAN,
] as const;

describe("pollProject: spec-group task, ticket closed in Jira (GOT.77)", () => {
  it.each(SPEC_GROUP)("%s returned by the search as Done is cancelled with a closed reason", async (state) => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state });
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, "done")]) });

    await pollProject({ db, project, client, actor, logger });

    const [after] = await taskByKey(key);
    expect(after!.state).toBe(TaskState.CANCELLED);
    const notes = await notesFor(task.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: "jira-poller", jiraScope: "closed" });
    expect(notes[0]!.reason).toContain(key);
    expect(notes[0]!.reason).toMatch(/closed in Jira/);
    expect(await notificationsFor(task.id)).toHaveLength(0);
  });

  it("cancels the live spec execution in the same transaction", async () => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state: TaskState.SPEC_IN_PROGRESS });
    const execution = await insertExecution(task.id, { role: "spec", state: "RUNNING" });
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, "done")]) });

    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(TaskState.CANCELLED);
    expect((await executionById(execution.id))!.state).toBe("CANCELLED");
    const types = (await eventsForTask(task.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((e) => e.type);
    // Task row before execution row, then the reason (the 404 path's order).
    expect(types).toEqual(["task.state_changed", "execution.cancelled", "agent.note"]);
  });

  it("a ticket no longer in the search whose lookup says Done is cancelled with a closed reason", async () => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state: TaskState.NEEDS_SPEC });
    const client = fakeClient({
      search: vi.fn(async () => []),
      getIssueStatus: vi.fn(async () => ({ statusCategory: "done" })),
    });

    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(TaskState.CANCELLED);
    expect((await notesFor(task.id))[0]).toMatchObject({ jiraScope: "closed" });
  });
});

describe("pollProject: spec-group task, ticket left the JQL (GOT.77)", () => {
  it.each(SPEC_GROUP)("%s whose open ticket is no longer returned is cancelled with a left-JQL reason", async (state) => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state });
    const client = fakeClient({
      search: vi.fn(async () => []),
      getIssueStatus: vi.fn(async () => ({ statusCategory: "indeterminate" })),
    });

    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(TaskState.CANCELLED);
    const notes = await notesFor(task.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: "jira-poller", jiraScope: "left_jql" });
    expect(notes[0]!.reason).toMatch(/no longer matches the project's JQL/);
  });

  it("an open ticket still returned by the search is left alone", async () => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state: TaskState.SPEC_REVIEW });
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, "indeterminate")]) });

    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(TaskState.SPEC_REVIEW);
    expect(await notesFor(task.id)).toHaveLength(0);
    expect(client.getIssueStatus).not.toHaveBeenCalled();
  });
});

describe("pollProject: work under way is signalled, not cancelled (GOT.77)", () => {
  it.each(WORK_UNDER_WAY)("%s: ticket closed raises one notification and one note, once", async (state) => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state });
    const execution = await insertExecution(task.id, { state: "RUNNING" });
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, "done")]) });

    await pollProject({ db, project, client, actor, logger });
    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(state);
    expect((await executionById(execution.id))!.state).toBe("RUNNING");
    const notes = await notesFor(task.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: "jira-poller", jiraScope: "closed" });
    const raised = await notificationsFor(task.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: "jira_out_of_scope", userId: null, readAt: null });
    expect(raised[0]!.title).toContain(key);
  });

  it.each(WORK_UNDER_WAY)("%s: ticket left the JQL raises one notification and one note, once", async (state) => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state });
    const client = fakeClient({ search: vi.fn(async () => []) });

    await pollProject({ db, project, client, actor, logger });
    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(state);
    expect((await notesFor(task.id)).map((n) => n.jiraScope)).toEqual(["left_jql"]);
    expect((await notificationsFor(task.id)).map((n) => n.kind)).toEqual(["jira_out_of_scope"]);
  });
});

describe("pollProject: reopened ticket (GOT.77)", () => {
  it("does not resurrect a task cancelled because its ticket closed, and raises nothing", async () => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state: TaskState.NEEDS_SPEC });
    let status = "done";
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, status)]) });

    await pollProject({ db, project, client, actor, logger });
    expect((await taskByKey(key))[0]!.state).toBe(TaskState.CANCELLED);
    const eventsAfterCancel = (await eventsForTask(task.id)).length;

    status = "indeterminate";
    await pollProject({ db, project, client, actor, logger });
    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(TaskState.CANCELLED);
    expect(await eventsForTask(task.id)).toHaveLength(eventsAfterCancel);
    expect(await notificationsFor(task.id)).toHaveLength(0);
  });

  it("work under way: reopening adds one note and no notification; closing again signals again", async () => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state: TaskState.IMPLEMENTING });
    let status = "done";
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, status)]) });

    await pollProject({ db, project, client, actor, logger });
    status = "indeterminate";
    await pollProject({ db, project, client, actor, logger });
    await pollProject({ db, project, client, actor, logger });

    expect((await notificationsFor(task.id))).toHaveLength(1);
    expect((await notesFor(task.id)).map((n) => n.jiraScope)).toEqual(["closed", "in_scope"]);

    status = "done";
    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(TaskState.IMPLEMENTING);
    expect((await notificationsFor(task.id))).toHaveLength(2);
    expect((await notesFor(task.id)).map((n) => n.jiraScope)).toEqual(["closed", "in_scope", "closed"]);
  });
});

describe("pollProject: transient Jira errors change nothing (GOT.77)", () => {
  it.each([
    ["network", new Error("ECONNRESET")],
    ["5xx", new JiraApiError(503, "Jira issue lookup failed with status 503")],
    ["rate limit", new JiraApiError(429, "Jira issue lookup failed with status 429")],
  ])("a %s error on the status lookup leaves spec and active tasks untouched", async (_label, error) => {
    const project = await insertProject();
    const specKey = nextKey();
    const activeKey = nextKey();
    const specTask = await insertTask(project.id, { jiraKey: specKey, state: TaskState.NEEDS_SPEC });
    const activeTask = await insertTask(project.id, { jiraKey: activeKey, state: TaskState.IMPLEMENTING });
    const client = fakeClient({
      search: vi.fn(async () => []),
      getIssueStatus: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(pollProject({ db, project, client, actor, logger })).resolves.toBeUndefined();

    expect((await taskByKey(specKey))[0]!.state).toBe(TaskState.NEEDS_SPEC);
    expect((await taskByKey(activeKey))[0]!.state).toBe(TaskState.IMPLEMENTING);
    expect(await eventsForTask(specTask.id)).toHaveLength(0);
    expect(await eventsForTask(activeTask.id)).toHaveLength(0);
    expect(await notificationsFor(activeTask.id)).toHaveLength(0);
  });

  it("a failed search touches no task, even ones that would otherwise look closed", async () => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state: TaskState.NEEDS_SPEC });
    const client = fakeClient({
      search: vi.fn(async () => {
        throw new JiraApiError(429, "Jira search failed with status 429");
      }),
      getIssueStatus: vi.fn(async () => ({ statusCategory: "done" })),
    });

    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(TaskState.NEEDS_SPEC);
    expect(await eventsForTask(task.id)).toHaveLength(0);
    expect(client.getIssueStatus).not.toHaveBeenCalled();
  });
});

describe("pollProject: DONE and CANCELLED tasks are ignored (GOT.77)", () => {
  it.each([TaskState.DONE, TaskState.CANCELLED])("%s returned by the search as Done is untouched", async (state) => {
    const project = await insertProject();
    const key = nextKey();
    const task = await insertTask(project.id, { jiraKey: key, state });
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, "done")]) });

    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(state);
    expect(await eventsForTask(task.id)).toHaveLength(0);
    expect(await notificationsFor(task.id)).toHaveLength(0);
  });

  it.each([TaskState.DONE, TaskState.CANCELLED])("%s absent from the search is never looked up", async (state) => {
    const project = await insertProject();
    const key = nextKey();
    await insertTask(project.id, { jiraKey: key, state });
    const client = fakeClient({ search: vi.fn(async () => []) });

    await pollProject({ db, project, client, actor, logger });

    expect((await taskByKey(key))[0]!.state).toBe(state);
    expect(client.getIssueStatus).not.toHaveBeenCalled();
  });
});

describe("pollProject: a ticket already Done when first seen (GOT.77 Q1)", () => {
  it("is not imported: no task, no notification, no event", async () => {
    const project = await insertProject();
    const key = nextKey();
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, "done")]) });

    await pollProject({ db, project, client, actor, logger });

    expect(await taskByKey(key)).toHaveLength(0);
    const notifs = await db.select().from(notifications);
    expect(notifs.filter((n) => n.title.includes(key))).toHaveLength(0);
  });

  it("a later poll that sees it reopened and still matching the JQL imports it normally", async () => {
    const project = await insertProject();
    const key = nextKey();
    let status = "done";
    const client = fakeClient({ search: vi.fn(async () => [searchIssue(key, status)]) });

    await pollProject({ db, project, client, actor, logger });
    expect(await taskByKey(key)).toHaveLength(0);

    status = "indeterminate";
    await pollProject({ db, project, client, actor, logger });

    const [task] = await taskByKey(key);
    expect(task).toBeDefined();
    expect(task!.state).toBe(TaskState.NEEDS_SPEC);
    const events = await stateChangedEventsFor(task!.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      from: null,
      to: "NEEDS_SPEC",
      trigger: "jira.imported",
    });
  });
});
