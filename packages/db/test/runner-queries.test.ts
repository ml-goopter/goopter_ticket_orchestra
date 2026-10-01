import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLatestEarlierImplementation } from "../src/queries/index.js";
import {
  seedExecution,
  seedFixtures,
  seedTask,
  startTestDb,
  type TestDb,
} from "./harness.js";

/**
 * GOT.95: the query a new implementation execution claimed from READY uses
 * to find the task's latest earlier implementation execution, whose branch
 * it pushes first when that execution ran on this host (§9.5, C27).
 */

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

describe("loadLatestEarlierImplementation (GOT.95)", () => {
  it("returns null for a task's first implementation execution", async () => {
    const fixtures = await seedFixtures(h.db, "LEI1");
    const taskId = await seedTask(h.db, fixtures, { jiraKey: "LEI1-1", state: "IMPLEMENTING" });
    const current = await seedExecution(h.db, taskId, { attempt: 1, state: "ASSIGNED" });

    expect(await loadLatestEarlierImplementation(h.db, current)).toBeNull();
  });

  it("returns the highest earlier attempt, skipping spec executions and the current one", async () => {
    const fixtures = await seedFixtures(h.db, "LEI2");
    const taskId = await seedTask(h.db, fixtures, { jiraKey: "LEI2-1", state: "IMPLEMENTING" });
    await seedExecution(h.db, taskId, { attempt: 1, state: "FAILED" });
    const second = await seedExecution(h.db, taskId, { attempt: 2, state: "COMPLETED" });
    await seedExecution(h.db, taskId, { role: "spec", attempt: 5, state: "COMPLETED" });
    const current = await seedExecution(h.db, taskId, { attempt: 3, state: "ASSIGNED" });

    const earlier = await loadLatestEarlierImplementation(h.db, current);

    expect(earlier?.id).toBe(second);
  });

  it("ignores another task's executions and an earlier spec execution", async () => {
    const fixtures = await seedFixtures(h.db, "LEI3");
    const taskId = await seedTask(h.db, fixtures, { jiraKey: "LEI3-1", state: "IMPLEMENTING" });
    const otherTask = await seedTask(h.db, fixtures, { jiraKey: "LEI3-2", state: "IMPLEMENTING" });
    await seedExecution(h.db, otherTask, { attempt: 1, state: "COMPLETED" });
    await seedExecution(h.db, taskId, { role: "spec", attempt: 1, state: "COMPLETED" });
    const current = await seedExecution(h.db, taskId, { attempt: 1, state: "ASSIGNED" });

    expect(await loadLatestEarlierImplementation(h.db, current)).toBeNull();
  });

  it("returns null when the execution is gone", async () => {
    expect(
      await loadLatestEarlierImplementation(h.db, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });
});
