import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";
import { transition } from "../src/transition.js";
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

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "SET");
}, 180000);

afterAll(async () => {
  await h?.stop();
});

/**
 * F2 regression: `TaskSetColumns`/`ExecutionSetColumns` exclude `id` and
 * `state` at the type level, but TS excess-property checks do not apply to
 * a non-literal object, so a caller that widens `set` (e.g. `as any`) could
 * previously smuggle `id`/`state` through the `{ ...input.set, state: to }`
 * spread and overwrite the primary key or the state the transition table
 * just computed. `transition()` now strips those columns from `set` before
 * the spread, so the row's real `id`/`state` always wins.
 */
describe("transition set guard (F2)", () => {
  it("keeps the task's own id and computed state when set tries to override them", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "SET-1",
      state: "NEEDS_SPEC",
    });
    const otherTaskId = "00000000-0000-4000-8000-000000000000";

    const result = await h.db.transaction((tx) =>
      transition(tx, {
        entity: "task",
        id: taskId,
        trigger: "spec.session_started",
        actor: { kind: "user", id: fx.userId },
        // `TaskSetColumns` excludes `id`/`state` at the type level; the
        // `as` cast simulates a caller that bypasses that with `any`, which
        // is exactly the gap F2 closes at runtime.
        set: {
          id: otherTaskId,
          state: "DONE",
          needsHumanReason: "smuggled",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    );

    expect(result.to).toBe("SPEC_IN_PROGRESS");

    const [row] = await h.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    expect(row).toBeDefined();
    expect(row!.id).toBe(taskId);
    expect(row!.state).toBe("SPEC_IN_PROGRESS");
    // The non-reserved column in `set` still applies.
    expect(row!.needsHumanReason).toBe("smuggled");

    const clobbered = await h.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, otherTaskId));
    expect(clobbered).toHaveLength(0);
  });

  it("keeps the execution's own id and computed state when set tries to override them", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "SET-2",
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, {
      state: "ASSIGNED",
    });
    const otherExecutionId = "00000000-0000-4000-8000-000000000001";

    const result = await h.db.transaction((tx) =>
      transition(tx, {
        entity: "execution",
        id: executionId,
        trigger: "execution.started",
        actor: { kind: "worker", id: "worker-1" },
        set: {
          id: otherExecutionId,
          state: "FAILED",
          host: "smuggled-host",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    );

    expect(result.to).toBe("RUNNING");

    const [row] = await h.db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.id, executionId));
    expect(row).toBeDefined();
    expect(row!.id).toBe(executionId);
    expect(row!.state).toBe("RUNNING");
    expect(row!.host).toBe("smuggled-host");

    const clobbered = await h.db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.id, otherExecutionId));
    expect(clobbered).toHaveLength(0);
  });
});
