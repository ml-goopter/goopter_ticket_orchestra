import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";
import {
  findExecutionByTokenHash,
  getTaskState,
  incrementExecutionReviewRounds,
  insertIssue,
  insertNotification,
  insertPullRequest,
  insertReviewResult,
  lockExecutionForTool,
  renewTaskLease,
  setExecutionToolsTokenHash,
  upsertDraftSpecificationRevision,
} from "../src/queries/agent-tools.js";
import {
  seedExecution,
  seedFixtures,
  seedTask,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "./harness.js";

/**
 * design.md §8 queries. The agent-tools MCP server lives in `apps/worker`,
 * which may not import drizzle, so these helpers are the whole db surface
 * it uses.
 */

let h: TestDb;
let fx: Fixtures;

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "ATQ");
}, 180000);

afterAll(async () => {
  await h?.stop();
});

let seq = 0;
const nextKey = () => `ATQ-${++seq}`;

async function seedWorker(host: string): Promise<string> {
  const [row] = await h.db
    .insert(schema.agentWorkers)
    .values({
      host,
      capabilities: ["node"],
      maxConcurrent: 1,
      workspaceRoot: "/tmp/orchestra",
    })
    .returning({ id: schema.agentWorkers.id });
  return row!.id;
}

describe("tools token hash (design.md §8)", () => {
  it("stores, resolves and revokes a token hash", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, { state: "RUNNING" });

    expect(await findExecutionByTokenHash(h.db, "deadbeef")).toBeNull();

    await setExecutionToolsTokenHash(h.db, executionId, "deadbeef");

    const ctx = await findExecutionByTokenHash(h.db, "deadbeef");
    expect(ctx).not.toBeNull();
    expect(ctx!.execution.id).toBe(executionId);
    expect(ctx!.task.id).toBe(taskId);
    expect(ctx!.project.id).toBe(fx.projectId);
    expect(ctx!.project.maxReviewRounds).toBe(3);

    await setExecutionToolsTokenHash(h.db, executionId, null);
    expect(await findExecutionByTokenHash(h.db, "deadbeef")).toBeNull();
  });

  it("never resolves the empty string, so a blank column can not authenticate", async () => {
    expect(await findExecutionByTokenHash(h.db, "")).toBeNull();
  });
});

describe("lockExecutionForTool (design.md §8)", () => {
  it("returns state and token hash, or null for an unknown id", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, { state: "RUNNING" });
    await setExecutionToolsTokenHash(h.db, executionId, "cafe");

    expect(
      await h.db.transaction((tx) => lockExecutionForTool(tx, executionId)),
    ).toEqual({ state: "RUNNING", toolsTokenHash: "cafe" });
    expect(
      await h.db.transaction((tx) =>
        lockExecutionForTool(tx, "00000000-0000-0000-0000-000000000000"),
      ),
    ).toBeNull();
  });

  it("holds a row lock until the transaction ends", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, { state: "RUNNING" });
    await setExecutionToolsTokenHash(h.db, executionId, "beef");

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));

    const holder = h.db.transaction(async (tx) => {
      await lockExecutionForTool(tx, executionId);
      locked();
      await released;
    });
    await lockTaken;

    let revoked = false;
    const revoke = setExecutionToolsTokenHash(h.db, executionId, null).then(
      () => void (revoked = true),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(revoked).toBe(false);

    release();
    await holder;
    await revoke;
    expect(revoked).toBe(true);
  });
});

describe("renewTaskLease (design.md §6.4, §8)", () => {
  it("moves expires_at forward and returns the new expiry", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, { state: "RUNNING" });
    const workerId = await seedWorker(`atq-lease-${executionId.slice(0, 8)}`);
    const first = new Date("2026-01-01T00:00:00.000Z");
    await h.db.insert(schema.taskLeases).values({
      taskId,
      executionId,
      workerId,
      expiresAt: first,
    });

    const next = new Date("2026-01-01T00:05:00.000Z");
    const returned = await renewTaskLease(h.db, executionId, next);

    expect(returned?.getTime()).toBe(next.getTime());
    const [row] = await h.db
      .select()
      .from(schema.taskLeases)
      .where(eq(schema.taskLeases.executionId, executionId));
    expect(row!.expiresAt.getTime()).toBe(next.getTime());
  });

  it("returns null when the execution holds no lease", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "SPEC_IN_PROGRESS",
    });
    const executionId = await seedExecution(h.db, taskId, {
      state: "RUNNING",
      role: "spec",
    });

    expect(await renewTaskLease(h.db, executionId, new Date())).toBeNull();
  });
});

describe("incrementExecutionReviewRounds (design.md §5.3)", () => {
  it("increments in place and returns the new value", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "REVIEWING",
    });
    const executionId = await seedExecution(h.db, taskId, { state: "RUNNING" });

    expect(await incrementExecutionReviewRounds(h.db, executionId)).toBe(1);
    expect(await incrementExecutionReviewRounds(h.db, executionId)).toBe(2);
  });

  it("throws for an unknown execution", async () => {
    await expect(
      incrementExecutionReviewRounds(
        h.db,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).rejects.toThrow(/execution not found/);
  });
});

describe("insert helpers (design.md §8)", () => {
  it("inserts an issue, a notification, a review result and a pull request", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "REVIEWING",
    });
    const executionId = await seedExecution(h.db, taskId, { state: "RUNNING" });

    const issue = await insertIssue(h.db, {
      taskId,
      executionId,
      type: "DECISION_REQUIRED",
      severity: "blocking",
      blocking: true,
      title: "Which store?",
      description: "Redis or Postgres",
      question: "Pick one",
      suggestedOptions: [{ id: "pg", description: "Postgres", tradeoff: "slow" }],
      recommendedOption: "pg",
      status: "OPEN",
    });
    expect(issue.status).toBe("OPEN");
    expect(issue.suggestedOptions).toEqual([
      { id: "pg", description: "Postgres", tradeoff: "slow" },
    ]);

    const notification = await insertNotification(h.db, {
      userId: null,
      taskId,
      issueId: issue.id,
      kind: "issue_raised",
      title: "Which store?",
    });
    expect(notification.id).toBeTruthy();

    const review = await insertReviewResult(h.db, {
      executionId,
      round: 1,
      verdict: "findings",
      findings: [{ severity: "warning", description: "d", action: "a" }],
      reviewerRuntime: "claude",
    });
    expect(review.id).toBeTruthy();

    const pr = await insertPullRequest(h.db, {
      taskId,
      executionId,
      number: 7,
      url: "https://github.com/x/y/pull/7",
      headSha: "abc123",
      state: "open",
      ciState: "pending",
      lastPolledAt: new Date(),
    });
    expect(pr.id).toBeTruthy();
  });
});

describe("upsertDraftSpecificationRevision (design.md §8 propose_spec)", () => {
  const content = (objective: string) => ({
    repository: "atq-repo",
    objective,
    scope: [],
    out_of_scope: [],
    requirements: [],
    acceptance_criteria: [],
    validation: [],
    constraints: [],
    dependencies: [],
  });

  it("creates one draft then overwrites it, keeping a single row", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "SPEC_IN_PROGRESS",
    });
    const now = new Date("2026-02-01T00:00:00.000Z");

    const first = await upsertDraftSpecificationRevision(h.db, {
      taskId,
      content: content("first"),
      now,
    });
    expect(first).toMatchObject({ version: 1, created: true });

    const second = await upsertDraftSpecificationRevision(h.db, {
      taskId,
      content: content("second"),
      now: new Date("2026-02-01T00:10:00.000Z"),
    });
    expect(second).toMatchObject({ id: first.id, version: 1, created: false });

    const rows = await h.db
      .select()
      .from(schema.specificationRevisions)
      .where(eq(schema.specificationRevisions.taskId, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toMatchObject({ objective: "second" });
    expect(rows[0]!.createdBy).toBeNull();
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("numbers a new draft above the highest existing version", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "SPEC_IN_PROGRESS",
    });
    await h.db.insert(schema.specificationRevisions).values({
      taskId,
      version: 4,
      status: "approved",
      content: content("approved"),
    });

    const draft = await upsertDraftSpecificationRevision(h.db, {
      taskId,
      content: content("draft"),
      now: new Date(),
    });

    expect(draft).toMatchObject({ version: 5, created: true });
  });
});

describe("getTaskState", () => {
  it("returns the state, and null for an unknown task", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: nextKey(),
      state: "CI_RUNNING",
    });
    expect(await getTaskState(h.db, taskId)).toBe("CI_RUNNING");
    expect(
      await getTaskState(h.db, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });
});
