import { TaskState } from "@orchestra/core";
import {
  executionEvents,
  projects,
  tasks,
  type Db,
} from "@orchestra/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JiraClient } from "../src/jira/client.js";
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

function fakeClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    search: vi.fn(async () => []),
    issueExists: vi.fn(async () => true),
    getIssue: vi.fn(async () => {
      throw new Error("getIssue not used by the poller");
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
      issueExists: vi.fn(async () => false),
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

  it("leaves a missing task untouched when its ticket still returns 200", async () => {
    const project = await insertProject();
    await insertTask(project.id, { jiraKey: "GOOP-106" });
    const client = fakeClient({
      search: vi.fn(async () => []),
      issueExists: vi.fn(async () => true),
    });

    await pollProject({ db, project, client, actor, logger });

    const [after] = await taskByKey("GOOP-106");
    expect(after!.state).toBe(TaskState.NEEDS_SPEC);
    expect(client.issueExists).toHaveBeenCalledWith("GOOP-106");
  });

  it("never re-checks a terminal task even when it is absent from the search", async () => {
    const project = await insertProject();
    await insertTask(project.id, { jiraKey: "GOOP-107", state: TaskState.DONE });
    const client = fakeClient({
      search: vi.fn(async () => []),
      issueExists: vi.fn(async () => {
        throw new Error("issueExists should not be called for a terminal task");
      }),
    });

    await expect(
      pollProject({ db, project, client, actor, logger }),
    ).resolves.toBeUndefined();
    expect(client.issueExists).not.toHaveBeenCalled();
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
