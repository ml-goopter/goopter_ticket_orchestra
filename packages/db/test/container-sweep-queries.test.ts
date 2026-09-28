import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listContainerExecutions,
  lockContainerExecution,
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

/**
 * Queries behind the worktree sweeper's orphan-container pass (design.md
 * §9.9 "Orphans", §6.6): look up the executions named by container labels,
 * then lock one before its container is removed.
 */

let h: TestDb;
let fx: Fixtures;
let seq = 0;

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "CTR");
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

async function seed(
  state: "RUNNING" | "FAILED" | "COMPLETED" | "CANCELLED",
  host: string | null,
): Promise<{ taskId: string; executionId: string }> {
  const taskId = await seedTask(h.db, fx, {
    jiraKey: `CTR-${++seq}`,
    state: "IMPLEMENTING",
  });
  const executionId = await seedExecution(h.db, taskId, { state });
  await h.db
    .update(schema.executions)
    .set({ host })
    .where(eq(schema.executions.id, executionId));
  return { taskId, executionId };
}

describe("listContainerExecutions", () => {
  it("returns id, task, state and host for each known execution id", async () => {
    const a = await seed("FAILED", "host-a");
    const b = await seed("RUNNING", null);

    const rows = await listContainerExecutions(h.db, [a.executionId, b.executionId]);

    expect(rows.sort((x, y) => x.executionId.localeCompare(y.executionId))).toEqual(
      [
        { executionId: a.executionId, taskId: a.taskId, state: "FAILED", host: "host-a" },
        { executionId: b.executionId, taskId: b.taskId, state: "RUNNING", host: null },
      ].sort((x, y) => x.executionId.localeCompare(y.executionId)),
    );
  });

  it("omits unknown ids and ignores values that are not uuids instead of failing", async () => {
    const a = await seed("CANCELLED", "host-a");

    const rows = await listContainerExecutions(h.db, [
      a.executionId,
      randomUUID(),
      "not-a-uuid",
      "'; drop table executions; --",
    ]);

    expect(rows.map((r) => r.executionId)).toEqual([a.executionId]);
  });

  it("returns nothing for an empty list without querying", async () => {
    expect(await listContainerExecutions(h.db, [])).toEqual([]);
    expect(await listContainerExecutions(h.db, ["x"])).toEqual([]);
  });
});

describe("lockContainerExecution", () => {
  it("locks the task and execution rows and returns the current state and host", async () => {
    const a = await seed("COMPLETED", "host-a");

    const row = await h.db.transaction((tx) => lockContainerExecution(tx, a));

    expect(row).toEqual({
      executionId: a.executionId,
      taskId: a.taskId,
      state: "COMPLETED",
      host: "host-a",
    });
  });

  it("returns null when the execution does not belong to the task", async () => {
    const a = await seed("FAILED", "host-a");
    const b = await seed("FAILED", "host-a");

    const row = await h.db.transaction((tx) =>
      lockContainerExecution(tx, { executionId: a.executionId, taskId: b.taskId }),
    );

    expect(row).toBeNull();
  });

  it("skips a task row another transaction holds (retried next sweep)", async () => {
    const a = await seed("FAILED", "host-a");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const holder = h.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, a.taskId))
        .for("update");
      locked();
      await held;
    });
    await isLocked;

    try {
      const row = await h.db.transaction((tx) => lockContainerExecution(tx, a));
      expect(row).toBeNull();
    } finally {
      release();
      await holder;
    }
  });

  it("skips an execution row another transaction holds", async () => {
    const a = await seed("FAILED", "host-a");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const holder = h.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.executions.id })
        .from(schema.executions)
        .where(eq(schema.executions.id, a.executionId))
        .for("update");
      locked();
      await held;
    });
    await isLocked;

    try {
      const row = await h.db.transaction((tx) => lockContainerExecution(tx, a));
      expect(row).toBeNull();
    } finally {
      release();
      await holder;
    }
  });
});
