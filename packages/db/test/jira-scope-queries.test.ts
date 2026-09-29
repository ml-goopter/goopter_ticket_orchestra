import { TaskState } from "@orchestra/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyJiraScope,
  jiraScopeAction,
  listNonTerminalJiraTasks,
  type JiraScope,
} from "../src/queries/jira.js";
import {
  seedExecution,
  seedFixtures,
  seedTask,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "./harness.js";

/**
 * GOT.77, user decision O1: a task follows its Jira ticket being closed
 * (status category Done) or leaving the project's JQL. Spec-group tasks are
 * cancelled; tasks with work under way get one `jira_out_of_scope`
 * notification plus a timeline note per ticket change.
 */

let h: TestDb;
let fx: Fixtures;

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "JSC");
}, 180000);

afterAll(async () => {
  await h?.stop();
});

const actor = { kind: "worker" as const, id: "test-worker" };

let seq = 0;
const nextKey = () => `JSC-${++seq}`;

async function taskRow(taskId: string) {
  return h.db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, taskId) });
}

async function executionRow(executionId: string) {
  return h.db.query.executions.findFirst({
    where: (e, { eq }) => eq(e.id, executionId),
  });
}

async function notesFor(taskId: string) {
  const rows = await h.db.query.executionEvents.findMany({
    where: (e, { and, eq }) => and(eq(e.taskId, taskId), eq(e.type, "agent.note")),
    orderBy: (e, { asc }) => asc(e.id),
  });
  return rows.map((row) => row.payload as Record<string, unknown>);
}

async function notificationsFor(taskId: string) {
  return h.db.query.notifications.findMany({
    where: (n, { eq }) => eq(n.taskId, taskId),
  });
}

async function apply(taskId: string, jiraKey: string, scope: JiraScope) {
  return h.db.transaction((tx) =>
    applyJiraScope(tx, { taskId, jiraKey, scope, actor }),
  );
}

const SPEC_GROUP = [
  TaskState.NEEDS_SPEC,
  TaskState.SPEC_IN_PROGRESS,
  TaskState.SPEC_REVIEW,
  TaskState.SPEC_APPROVED,
] as const;

const ACTIVE_GROUP = [
  TaskState.READY,
  TaskState.BLOCKED,
  TaskState.IMPLEMENTING,
  TaskState.REVIEWING,
  TaskState.CI_RUNNING,
  TaskState.READY_FOR_MERGE,
  TaskState.NEEDS_HUMAN,
] as const;

describe("jiraScopeAction (GOT.77 decision table)", () => {
  it.each(SPEC_GROUP)("%s: cancels on closed or left_jql, nothing when in scope", (state) => {
    expect(jiraScopeAction(state, null, "closed")).toBe("cancel");
    expect(jiraScopeAction(state, null, "left_jql")).toBe("cancel");
    expect(jiraScopeAction(state, null, "in_scope")).toBe("none");
  });

  it.each(ACTIVE_GROUP)("%s: signals once per change, restores silently", (state) => {
    expect(jiraScopeAction(state, null, "closed")).toBe("signal");
    expect(jiraScopeAction(state, null, "left_jql")).toBe("signal");
    expect(jiraScopeAction(state, "closed", "closed")).toBe("none");
    expect(jiraScopeAction(state, "closed", "left_jql")).toBe("signal");
    expect(jiraScopeAction(state, null, "in_scope")).toBe("none");
    expect(jiraScopeAction(state, "in_scope", "in_scope")).toBe("none");
    expect(jiraScopeAction(state, "closed", "in_scope")).toBe("restore");
    expect(jiraScopeAction(state, "in_scope", "closed")).toBe("signal");
  });

  it.each([TaskState.DONE, TaskState.CANCELLED, TaskState.FAILED])(
    "%s: always nothing",
    (state) => {
      for (const scope of ["closed", "left_jql", "in_scope"] as const) {
        expect(jiraScopeAction(state, null, scope)).toBe("none");
      }
    },
  );
});

describe("applyJiraScope: spec group is cancelled", () => {
  it("cancels the task and its live spec execution with a closed-in-Jira note", async () => {
    const key = nextKey();
    const taskId = await seedTask(h.db, fx, { jiraKey: key, state: TaskState.SPEC_IN_PROGRESS });
    const executionId = await seedExecution(h.db, taskId, { role: "spec", state: "RUNNING" });

    await expect(apply(taskId, key, "closed")).resolves.toBe("cancel");

    expect((await taskRow(taskId))!.state).toBe(TaskState.CANCELLED);
    expect((await executionRow(executionId))!.state).toBe("CANCELLED");
    const notes = await notesFor(taskId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: "jira-poller", jiraScope: "closed" });
    expect(String(notes[0]!.reason)).toContain(key);
    expect(String(notes[0]!.reason)).toMatch(/closed in Jira/);
    expect(await notificationsFor(taskId)).toHaveLength(0);
  });

  it("gives a left-the-JQL reason when the ticket no longer matches", async () => {
    const key = nextKey();
    const taskId = await seedTask(h.db, fx, { jiraKey: key, state: TaskState.NEEDS_SPEC });

    await expect(apply(taskId, key, "left_jql")).resolves.toBe("cancel");

    expect((await taskRow(taskId))!.state).toBe(TaskState.CANCELLED);
    const notes = await notesFor(taskId);
    expect(notes[0]).toMatchObject({ source: "jira-poller", jiraScope: "left_jql" });
    expect(String(notes[0]!.reason)).toMatch(/no longer matches the project's JQL/);
  });

  it("does nothing when the ticket is in scope", async () => {
    const key = nextKey();
    const taskId = await seedTask(h.db, fx, { jiraKey: key, state: TaskState.SPEC_REVIEW });

    await expect(apply(taskId, key, "in_scope")).resolves.toBe("none");

    expect((await taskRow(taskId))!.state).toBe(TaskState.SPEC_REVIEW);
    expect(await notesFor(taskId)).toHaveLength(0);
  });
});

describe("applyJiraScope: work under way is signalled, not cancelled", () => {
  it("raises one jira_out_of_scope notification and one note, then nothing on repeat", async () => {
    const key = nextKey();
    const taskId = await seedTask(h.db, fx, { jiraKey: key, state: TaskState.IMPLEMENTING });
    const executionId = await seedExecution(h.db, taskId, { state: "RUNNING" });

    await expect(apply(taskId, key, "closed")).resolves.toBe("signal");
    await expect(apply(taskId, key, "closed")).resolves.toBe("none");

    expect((await taskRow(taskId))!.state).toBe(TaskState.IMPLEMENTING);
    expect((await executionRow(executionId))!.state).toBe("RUNNING");
    const notifications = await notificationsFor(taskId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "jira_out_of_scope", userId: null, readAt: null });
    expect(notifications[0]!.title).toContain(key);
    const notes = await notesFor(taskId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: "jira-poller", jiraScope: "closed" });
  });

  it("records a reopen without a notification, and signals again on the next close", async () => {
    const key = nextKey();
    const taskId = await seedTask(h.db, fx, { jiraKey: key, state: TaskState.CI_RUNNING });

    await apply(taskId, key, "closed");
    await expect(apply(taskId, key, "in_scope")).resolves.toBe("restore");
    await expect(apply(taskId, key, "in_scope")).resolves.toBe("none");
    await expect(apply(taskId, key, "closed")).resolves.toBe("signal");

    expect(await notificationsFor(taskId)).toHaveLength(2);
    const notes = await notesFor(taskId);
    expect(notes.map((n) => n.jiraScope)).toEqual(["closed", "in_scope", "closed"]);
  });

  it("two concurrent applies of the same change raise exactly one notification", async () => {
    const key = nextKey();
    const taskId = await seedTask(h.db, fx, { jiraKey: key, state: TaskState.REVIEWING });

    const outcomes = await Promise.all([
      apply(taskId, key, "left_jql"),
      apply(taskId, key, "left_jql"),
    ]);

    expect(outcomes.sort()).toEqual(["none", "signal"]);
    expect(await notificationsFor(taskId)).toHaveLength(1);
    expect(await notesFor(taskId)).toHaveLength(1);
  });

  it("decides under the task lock, so a task that moved on since the poll read is judged by its new state", async () => {
    const key = nextKey();
    const taskId = await seedTask(h.db, fx, { jiraKey: key, state: TaskState.DONE });

    await expect(apply(taskId, key, "closed")).resolves.toBe("none");

    expect((await taskRow(taskId))!.state).toBe(TaskState.DONE);
    expect(await notesFor(taskId)).toHaveLength(0);
    expect(await notificationsFor(taskId)).toHaveLength(0);
  });
});

describe("listNonTerminalJiraTasks (GOT.77)", () => {
  it("returns each task's state and its latest recorded Jira scope", async () => {
    const f = await seedFixtures(h.db, "JSL");
    const plainKey = "JSL-1";
    const signalledKey = "JSL-2";
    const plainId = await seedTask(h.db, f, { jiraKey: plainKey, state: TaskState.NEEDS_SPEC });
    const signalledId = await seedTask(h.db, f, { jiraKey: signalledKey, state: TaskState.IMPLEMENTING });
    await seedTask(h.db, f, { jiraKey: "JSL-3", state: TaskState.DONE });

    await apply(signalledId, signalledKey, "closed");
    await apply(signalledId, signalledKey, "in_scope");
    await apply(signalledId, signalledKey, "left_jql");

    const rows = await listNonTerminalJiraTasks(h.db, f.projectId);
    const byKey = new Map(rows.map((row) => [row.jiraKey, row]));

    expect([...byKey.keys()].sort()).toEqual([plainKey, signalledKey]);
    expect(byKey.get(plainKey)).toEqual({
      id: plainId,
      jiraKey: plainKey,
      state: TaskState.NEEDS_SPEC,
      jiraScope: null,
    });
    expect(byKey.get(signalledKey)).toEqual({
      id: signalledId,
      jiraKey: signalledKey,
      state: TaskState.IMPLEMENTING,
      jiraScope: "left_jql",
    });
  });
});
