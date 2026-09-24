import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TIMELINE_LIMIT_DEFAULT,
  TIMELINE_LIMIT_MAX,
  clampTimelineLimit,
  getTaskAggregate,
  listAttention,
  listBoard,
  listOpenIssues,
  listTimeline,
} from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import {
  seedExecution,
  seedFixtures,
  seedTask,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "./harness.js";

let h: TestDb;
let fx: Fixtures;

const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "QRY");

  // --- aggregate subject ------------------------------------------------
  ids.agg = await seedTask(h.db, fx, {
    jiraKey: "QRY-1",
    state: "IMPLEMENTING",
    summary: "Aggregate subject",
    priority: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });

  const [revision] = await h.db
    .insert(schema.specificationRevisions)
    .values({
      taskId: ids.agg,
      version: 1,
      status: "approved",
      content: { summary: "approved spec" },
      createdBy: fx.userId,
    })
    .returning({ id: schema.specificationRevisions.id });
  ids.revision = revision!.id;
  await h.db
    .insert(schema.specificationRevisions)
    .values({
      taskId: ids.agg,
      version: 2,
      status: "draft",
      content: { summary: "draft spec" },
      createdBy: fx.userId,
    });
  await h.db
    .update(schema.tasks)
    .set({ approvedRevisionId: ids.revision })
    .where(eq(schema.tasks.id, ids.agg));

  ids.aggSpecExec1 = await seedExecution(h.db, ids.agg, {
    role: "spec",
    attempt: 1,
    state: "COMPLETED",
  });
  ids.aggSpecExec2 = await seedExecution(h.db, ids.agg, {
    role: "spec",
    attempt: 2,
    state: "COMPLETED",
  });
  ids.aggImplExec = await seedExecution(h.db, ids.agg, {
    role: "implementation",
    attempt: 1,
    state: "RUNNING",
  });

  const [openIssue] = await h.db
    .insert(schema.issues)
    .values([
      {
        taskId: ids.agg,
        executionId: ids.aggImplExec,
        type: "QUESTION",
        severity: "info",
        blocking: false,
        title: "Open one",
        description: "d",
        status: "OPEN",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        taskId: ids.agg,
        executionId: ids.aggImplExec,
        type: "RISK",
        severity: "warning",
        blocking: false,
        title: "Open two",
        description: "d",
        status: "OPEN",
        createdAt: new Date("2026-01-03T00:00:00Z"),
      },
      {
        taskId: ids.agg,
        executionId: ids.aggImplExec,
        type: "QUESTION",
        severity: "info",
        blocking: false,
        title: "Resolved one",
        description: "d",
        status: "RESOLVED",
        createdAt: new Date("2026-01-01T12:00:00Z"),
      },
      {
        taskId: ids.agg,
        executionId: ids.aggImplExec,
        type: "QUESTION",
        severity: "info",
        blocking: false,
        title: "Superseded one",
        description: "d",
        status: "SUPERSEDED",
        createdAt: new Date("2026-01-01T13:00:00Z"),
      },
    ])
    .returning({ id: schema.issues.id });
  ids.aggOpenIssue = openIssue!.id;

  const [pr] = await h.db
    .insert(schema.pullRequests)
    .values({
      taskId: ids.agg,
      executionId: ids.aggImplExec,
      number: 7,
      url: "https://github.com/goopter/qry/pull/7",
      headSha: "deadbeef",
      state: "open",
      ciState: "running",
      lastPolledAt: new Date(),
    })
    .returning({ id: schema.pullRequests.id });
  ids.aggPr = pr!.id;

  // --- bare task: no repository, no revision, no execution, no PR -------
  ids.bare = await seedTask(h.db, fx, {
    jiraKey: "QRY-2",
    state: "NEEDS_SPEC",
    priority: 2,
    withRepository: false,
    createdAt: new Date("2026-01-02T00:00:00Z"),
  });

  // --- timeline subject -------------------------------------------------
  ids.timeline = await seedTask(h.db, fx, {
    jiraKey: "QRY-3",
    state: "IMPLEMENTING",
    priority: 3,
    createdAt: new Date("2026-01-03T00:00:00Z"),
  });
  await h.db.insert(schema.executionEvents).values(
    [1, 2, 3, 4, 5].map((n) => ({
      taskId: ids.timeline!,
      type: "agent.note",
      payload: { n },
    })),
  );
  // Noise on another task: listTimeline must not return it.
  await h.db.insert(schema.executionEvents).values({
    taskId: ids.agg,
    type: "agent.note",
    payload: { noise: true },
  });

  // --- attention subjects ----------------------------------------------
  ids.attSpecReview = await seedTask(h.db, fx, {
    jiraKey: "QRY-4",
    state: "SPEC_REVIEW",
    priority: 4,
    createdAt: new Date("2026-01-04T00:00:00Z"),
  });
  ids.attNeedsHuman = await seedTask(h.db, fx, {
    jiraKey: "QRY-5",
    state: "NEEDS_HUMAN",
    priority: 5,
    createdAt: new Date("2026-01-05T00:00:00Z"),
  });
  ids.attReadyForMerge = await seedTask(h.db, fx, {
    jiraKey: "QRY-6",
    state: "READY_FOR_MERGE",
    priority: 6,
    createdAt: new Date("2026-01-06T00:00:00Z"),
  });
  ids.attWaiting = await seedTask(h.db, fx, {
    jiraKey: "QRY-7",
    state: "IMPLEMENTING",
    priority: 7,
    createdAt: new Date("2026-01-07T00:00:00Z"),
  });
  ids.attWaitingExec = await seedExecution(h.db, ids.attWaiting, {
    state: "WAITING_FOR_USER",
  });
  const [blocking] = await h.db
    .insert(schema.issues)
    .values([
      {
        taskId: ids.attWaiting,
        executionId: ids.attWaitingExec,
        type: "DECISION_REQUIRED",
        severity: "blocking",
        blocking: true,
        title: "Which option?",
        description: "d",
        status: "OPEN",
        createdAt: new Date("2026-01-07T01:00:00Z"),
      },
      {
        taskId: ids.attWaiting,
        executionId: ids.attWaitingExec,
        type: "QUESTION",
        severity: "info",
        blocking: false,
        title: "Non blocking",
        description: "d",
        status: "OPEN",
        createdAt: new Date("2026-01-07T00:30:00Z"),
      },
    ])
    .returning({ id: schema.issues.id });
  ids.attBlockingIssue = blocking!.id;

  // F3: a NEEDS_HUMAN task that *also* has a WAITING_FOR_USER execution.
  // `listAttention` must give `waiting_for_user` precedence over the
  // state-based `needs_human` reason for this task (design.md §5.1).
  ids.attNeedsHumanWaiting = await seedTask(h.db, fx, {
    jiraKey: "QRY-12",
    state: "NEEDS_HUMAN",
    priority: 12,
    createdAt: new Date("2026-01-12T00:00:00Z"),
  });
  ids.attNeedsHumanWaitingExec = await seedExecution(
    h.db,
    ids.attNeedsHumanWaiting,
    { state: "WAITING_FOR_USER" },
  );
  const [needsHumanBlocking] = await h.db
    .insert(schema.issues)
    .values({
      taskId: ids.attNeedsHumanWaiting,
      executionId: ids.attNeedsHumanWaitingExec,
      type: "DECISION_REQUIRED",
      severity: "blocking",
      blocking: true,
      title: "NEEDS_HUMAN blocking",
      description: "d",
      status: "OPEN",
      createdAt: new Date("2026-01-12T01:00:00Z"),
    })
    .returning({ id: schema.issues.id });
  ids.attNeedsHumanWaitingBlockingIssue = needsHumanBlocking!.id;

  // Plain IMPLEMENTING task, no waiting execution: never in attention.
  ids.plain = await seedTask(h.db, fx, {
    jiraKey: "QRY-8",
    state: "IMPLEMENTING",
    priority: 8,
    createdAt: new Date("2026-01-08T00:00:00Z"),
  });
  await seedExecution(h.db, ids.plain, { state: "RUNNING" });

  // --- board recency ----------------------------------------------------
  ids.doneRecent = await seedTask(h.db, fx, {
    jiraKey: "QRY-9",
    state: "DONE",
    priority: 9,
    createdAt: new Date("2026-01-09T00:00:00Z"),
  });
  ids.cancelledRecent = await seedTask(h.db, fx, {
    jiraKey: "QRY-10",
    state: "CANCELLED",
    priority: 10,
    createdAt: new Date("2026-01-10T00:00:00Z"),
  });
  ids.doneOld = await seedTask(h.db, fx, {
    jiraKey: "QRY-11",
    state: "DONE",
    priority: 11,
    createdAt: new Date("2026-01-11T00:00:00Z"),
  });
  await h.db
    .update(schema.tasks)
    .set({ updatedAt: sql`now() - interval '8 days'` })
    .where(eq(schema.tasks.id, ids.doneOld));
}, 180000);

afterAll(async () => {
  await h?.stop();
});

describe("getTaskAggregate (AC6)", () => {
  it("returns the joined shape for a fully populated task", async () => {
    const aggregate = await getTaskAggregate(h.db, ids.agg!);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.task.id).toBe(ids.agg);
    expect(aggregate!.task.jiraKey).toBe("QRY-1");
    expect(aggregate!.project.id).toBe(fx.projectId);
    expect(aggregate!.repository!.id).toBe(fx.repositoryId);
    expect(aggregate!.approvedRevision!.id).toBe(ids.revision);
    expect(aggregate!.approvedRevision!.status).toBe("approved");
    expect(aggregate!.latestExecutions.spec!.id).toBe(ids.aggSpecExec2);
    expect(aggregate!.latestExecutions.implementation!.id).toBe(
      ids.aggImplExec,
    );
    expect(aggregate!.openIssueCount).toBe(2);
    expect(aggregate!.pullRequest!.id).toBe(ids.aggPr);
    expect(aggregate!.pullRequest!.number).toBe(7);
  });

  it("returns nulls for the optional parts of a bare task", async () => {
    const aggregate = await getTaskAggregate(h.db, ids.bare!);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.repository).toBeNull();
    expect(aggregate!.approvedRevision).toBeNull();
    expect(aggregate!.latestExecutions.spec).toBeNull();
    expect(aggregate!.latestExecutions.implementation).toBeNull();
    expect(aggregate!.pullRequest).toBeNull();
    expect(aggregate!.openIssueCount).toBe(0);
  });

  it("returns null for an unknown id", async () => {
    expect(
      await getTaskAggregate(h.db, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });
});

describe("listTimeline (AC6)", () => {
  it("returns only this task's events, ordered by id ascending", async () => {
    const rows = await listTimeline(h.db, ids.timeline!, {});
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => (r.payload as { n: number }).n)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(rows.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
  });

  it("respects limit and pages with `after`", async () => {
    const first = await listTimeline(h.db, ids.timeline!, { limit: 2 });
    expect(first).toHaveLength(2);
    expect(first.map((r) => (r.payload as { n: number }).n)).toEqual([1, 2]);

    const second = await listTimeline(h.db, ids.timeline!, {
      after: first[1]!.id,
      limit: 2,
    });
    expect(second.map((r) => (r.payload as { n: number }).n)).toEqual([3, 4]);
    expect(second[0]!.id > first[1]!.id).toBe(true);

    const third = await listTimeline(h.db, ids.timeline!, {
      after: second[1]!.id,
      limit: 2,
    });
    expect(third.map((r) => (r.payload as { n: number }).n)).toEqual([5]);

    const none = await listTimeline(h.db, ids.timeline!, {
      after: third[0]!.id,
    });
    expect(none).toEqual([]);
  });

  it("clamps the limit to [1, 1000] with a default of 200", () => {
    expect(clampTimelineLimit(undefined)).toBe(TIMELINE_LIMIT_DEFAULT);
    expect(TIMELINE_LIMIT_DEFAULT).toBe(200);
    expect(clampTimelineLimit(5000)).toBe(TIMELINE_LIMIT_MAX);
    expect(TIMELINE_LIMIT_MAX).toBe(1000);
    expect(clampTimelineLimit(0)).toBe(1);
    expect(clampTimelineLimit(-3)).toBe(1);
    expect(clampTimelineLimit(7.9)).toBe(7);
    expect(clampTimelineLimit(50)).toBe(50);
  });
});

describe("listOpenIssues (AC6)", () => {
  it("returns only OPEN issues for one task, oldest first", async () => {
    const rows = await listOpenIssues(h.db, { taskId: ids.agg! });
    expect(rows.map((r) => r.title)).toEqual(["Open one", "Open two"]);
    expect(rows.every((r) => r.status === "OPEN")).toBe(true);
  });

  it("returns every OPEN issue across tasks when no task filter is given", async () => {
    const rows = await listOpenIssues(h.db, {});
    expect(rows.map((r) => r.title)).toEqual([
      "Open one",
      "Open two",
      "Non blocking",
      "Which option?",
      "NEEDS_HUMAN blocking",
    ]);
  });

  it("returns an empty list for a task with no open issues", async () => {
    expect(await listOpenIssues(h.db, { taskId: ids.bare! })).toEqual([]);
  });
});

describe("listAttention (AC6)", () => {
  it("returns exactly the five attention reasons and excludes a plain task", async () => {
    const rows = await listAttention(h.db);
    const byTask = new Map(rows.map((r) => [r.taskId, r]));

    expect(byTask.get(ids.attSpecReview!)?.reason).toBe("spec_review");
    expect(byTask.get(ids.attNeedsHuman!)?.reason).toBe("needs_human");
    expect(byTask.get(ids.attReadyForMerge!)?.reason).toBe("ready_for_merge");
    expect(byTask.get(ids.attWaiting!)?.reason).toBe("waiting_for_user");
    expect(byTask.get(ids.attNeedsHumanWaiting!)?.reason).toBe(
      "waiting_for_user",
    );

    expect(byTask.has(ids.plain!)).toBe(false);
    expect(byTask.has(ids.agg!)).toBe(false);
    expect(byTask.has(ids.bare!)).toBe(false);
    expect(rows).toHaveLength(5);
  });

  it("carries the open blocking issue id only for waiting_for_user", async () => {
    const rows = await listAttention(h.db);
    const waiting = rows.find((r) => r.taskId === ids.attWaiting);
    expect(waiting!.blockingIssueId).toBe(ids.attBlockingIssue);
    for (const row of rows.filter((r) => r.reason !== "waiting_for_user")) {
      expect(row.blockingIssueId).toBeNull();
    }
  });

  it("gives waiting_for_user precedence over needs_human for a NEEDS_HUMAN task with a WAITING_FOR_USER execution (F3)", async () => {
    const rows = await listAttention(h.db);
    const matches = rows.filter((r) => r.taskId === ids.attNeedsHumanWaiting);
    expect(matches).toHaveLength(1);
    const row = matches[0]!;
    expect(row.state).toBe("NEEDS_HUMAN");
    expect(row.reason).toBe("waiting_for_user");
    expect(row.blockingIssueId).toBe(ids.attNeedsHumanWaitingBlockingIssue);
  });

  it("carries enough task detail to render the list", async () => {
    const rows = await listAttention(h.db);
    const row = rows.find((r) => r.taskId === ids.attNeedsHuman)!;
    expect(row.jiraKey).toBe("QRY-5");
    expect(row.jiraSummary).toBe("Summary for QRY-5");
    expect(row.state).toBe("NEEDS_HUMAN");
  });
});

describe("listBoard (AC6)", () => {
  it("sets hasWaitingExecution for every task with a WAITING_FOR_USER execution", async () => {
    const rows = await listBoard(h.db);
    const waiting = rows.filter((r) => r.hasWaitingExecution);
    expect(waiting.map((r) => r.taskId)).toEqual([
      ids.attWaiting,
      ids.attNeedsHumanWaiting,
    ]);
  });

  it("includes non-terminal tasks and recently closed ones, excludes stale closed ones", async () => {
    const rows = await listBoard(h.db);
    const keys = rows.map((r) => r.jiraKey);
    expect(keys).toContain("QRY-1");
    expect(keys).toContain("QRY-9");
    expect(keys).toContain("QRY-10");
    expect(keys).not.toContain("QRY-11");
  });

  it("orders by jira_priority then jira_created_at", async () => {
    const rows = await listBoard(h.db);
    expect(rows.map((r) => r.jiraKey)).toEqual([
      "QRY-1",
      "QRY-2",
      "QRY-3",
      "QRY-4",
      "QRY-5",
      "QRY-6",
      "QRY-7",
      "QRY-8",
      "QRY-9",
      "QRY-10",
      "QRY-12",
    ]);
  });
});
