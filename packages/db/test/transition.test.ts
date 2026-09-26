import { TransitionError } from "@orchestra/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError, transition } from "../src/transition.js";
import * as schema from "../src/schema/index.js";
import {
  seedExecution,
  seedFixtures,
  seedTask,
  sleep,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "./harness.js";

let h: TestDb;
let fx: Fixtures;

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "TRN");
}, 180000);

afterAll(async () => {
  await h?.stop();
});

async function auditRows(entityId: string) {
  return h.db
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityId, entityId));
}

async function eventRows(taskId: string) {
  return h.db
    .select()
    .from(schema.executionEvents)
    .where(eq(schema.executionEvents.taskId, taskId));
}

async function taskState(taskId: string) {
  const [row] = await h.db
    .select({ state: schema.tasks.state, updatedAt: schema.tasks.updatedAt })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  return row!;
}

describe("transition() rejects illegal moves and leaves nothing behind (AC1)", () => {
  it("throws core's TransitionError and rolls the whole transaction back", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-1",
      state: "NEEDS_SPEC",
    });

    await expect(
      h.db.transaction(async (tx) =>
        transition(tx, {
          entity: "task",
          id: taskId,
          trigger: "task.claimed",
          actor: { kind: "worker", id: "worker-1" },
        }),
      ),
    ).rejects.toThrow(TransitionError);

    expect(await auditRows(taskId)).toHaveLength(0);
    expect(await eventRows(taskId)).toHaveLength(0);
    expect((await taskState(taskId)).state).toBe("NEEDS_SPEC");
  });

  it("rolls back writes the caller made earlier in the same transaction", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-2",
      state: "NEEDS_SPEC",
    });

    await expect(
      h.db.transaction(async (tx) => {
        await tx.insert(schema.executionEvents).values({
          taskId,
          type: "agent.note",
          payload: { note: "should not survive" },
        });
        return transition(tx, {
          entity: "task",
          id: taskId,
          trigger: "ci.passed",
          actor: { kind: "system" },
        });
      }),
    ).rejects.toThrow(TransitionError);

    expect(await eventRows(taskId)).toHaveLength(0);
  });
});

describe("transition() on a task writes state, audit and event (AC2)", () => {
  it("NEEDS_SPEC -> SPEC_IN_PROGRESS", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-3",
      state: "NEEDS_SPEC",
    });
    const before = (await taskState(taskId)).updatedAt;
    await sleep(10);

    const result = await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "task",
        id: taskId,
        trigger: "spec.session_started",
        actor: { kind: "user", id: fx.userId },
      }),
    );

    expect(result.from).toBe("NEEDS_SPEC");
    expect(result.to).toBe("SPEC_IN_PROGRESS");

    const after = await taskState(taskId);
    expect(after.state).toBe("SPEC_IN_PROGRESS");
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime());

    const audit = await auditRows(taskId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entityType: "task",
      entityId: taskId,
      fromState: "NEEDS_SPEC",
      toState: "SPEC_IN_PROGRESS",
      trigger: "spec.session_started",
      actorKind: "user",
      actorId: fx.userId,
    });

    const events = await eventRows(taskId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("task.state_changed");
    expect(events[0]!.executionId).toBeNull();
    expect(events[0]!.payload).toMatchObject({
      from: "NEEDS_SPEC",
      to: "SPEC_IN_PROGRESS",
      trigger: "spec.session_started",
      actor: { kind: "user", id: fx.userId },
    });
    expect(result.eventId).toBe(events[0]!.id);
  });

  it("persists `set` columns in the same update as the state", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-4",
      state: "IMPLEMENTING",
    });

    await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "task",
        id: taskId,
        trigger: "task.escalated",
        actor: { kind: "worker", id: "worker-1" },
        set: { needsHumanReason: "review rounds exhausted" },
      }),
    );

    const [row] = await h.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    expect(row!.state).toBe("NEEDS_HUMAN");
    expect(row!.needsHumanReason).toBe("review rounds exhausted");
  });

  it("F4 regression: merges `eventPayload` into the state_changed event, alongside from/to/trigger/actor", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-4B",
      state: "CI_RUNNING",
    });

    await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "task",
        id: taskId,
        trigger: "ci.passed",
        actor: { kind: "worker", id: "worker-1" },
        eventPayload: { via: "merged_externally" },
      }),
    );

    const events = await eventRows(taskId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: "worker-1" },
      via: "merged_externally",
    });
  });

  it("records a null actor id when the actor has none", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-5",
      state: "READY",
    });
    await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "task",
        id: taskId,
        trigger: "task.cancelled",
        actor: { kind: "system" },
      }),
    );
    const audit = await auditRows(taskId);
    expect(audit[0]!.actorId).toBeNull();
    expect(audit[0]!.actorKind).toBe("system");
  });
});

describe("transition() on an execution (AC3)", () => {
  it("QUEUED -> ASSIGNED -> RUNNING -> FAILED with `set` columns", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-6",
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, { state: "QUEUED" });

    const assigned = await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "execution",
        id: executionId,
        trigger: "execution.assigned",
        actor: { kind: "worker", id: "worker-1" },
      }),
    );
    expect(assigned).toMatchObject({ from: "QUEUED", to: "ASSIGNED" });

    const running = await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "execution",
        id: executionId,
        trigger: "execution.started",
        actor: { kind: "worker", id: "worker-1" },
      }),
    );
    expect(running).toMatchObject({ from: "ASSIGNED", to: "RUNNING" });

    const endedAt = new Date("2026-02-02T03:04:05.000Z");
    await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "execution",
        id: executionId,
        trigger: "execution.failed",
        actor: { kind: "system" },
        set: { endReason: "process_crash", endDetail: "exit 137", endedAt },
      }),
    );

    const [execution] = await h.db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.id, executionId));
    expect(execution!.state).toBe("FAILED");
    expect(execution!.endReason).toBe("process_crash");
    expect(execution!.endDetail).toBe("exit 137");
    expect(execution!.endedAt?.toISOString()).toBe(endedAt.toISOString());

    const audit = await h.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, executionId))
      .orderBy(schema.auditEvents.id);
    expect(audit).toHaveLength(3);
    expect(audit.map((r) => r.entityType)).toEqual([
      "execution",
      "execution",
      "execution",
    ]);
    expect(audit.map((r) => r.toState)).toEqual([
      "ASSIGNED",
      "RUNNING",
      "FAILED",
    ]);

    const events = await h.db
      .select()
      .from(schema.executionEvents)
      .where(eq(schema.executionEvents.taskId, taskId))
      .orderBy(schema.executionEvents.id);
    expect(events.map((r) => r.type)).toEqual([
      "execution.assigned",
      "execution.started",
      "execution.failed",
    ]);
    for (const event of events) {
      expect(event.executionId).toBe(executionId);
      expect(event.taskId).toBe(taskId);
    }
  });

  it("maps WAITING_FOR_USER -> RUNNING to execution.resumed, not started", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-7",
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, {
      state: "WAITING_FOR_USER",
    });

    await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "execution",
        id: executionId,
        trigger: "execution.resumed",
        actor: { kind: "user", id: fx.userId },
      }),
    );

    const events = await eventRows(taskId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("execution.resumed");
  });

  it("maps COMPLETED -> RUNNING (resume_with_ci_failure) to execution.resumed", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-8",
      state: "CI_RUNNING",
    });
    const executionId = await seedExecution(h.db, taskId, {
      state: "COMPLETED",
    });

    await h.db.transaction(async (tx) =>
      transition(tx, {
        entity: "execution",
        id: executionId,
        trigger: "resume_with_ci_failure",
        actor: { kind: "worker", id: "worker-1" },
      }),
    );

    const events = await eventRows(taskId);
    expect(events.map((r) => r.type)).toEqual(["execution.resumed"]);
  });

  const eventTypeCases: Array<{
    key: string;
    trigger: "execution.waiting" | "execution.completed" | "execution.cancelled";
    to: string;
    type: string;
  }> = [
    {
      key: "TRN-12",
      trigger: "execution.waiting",
      to: "WAITING_FOR_USER",
      type: "execution.waiting",
    },
    {
      key: "TRN-13",
      trigger: "execution.completed",
      to: "COMPLETED",
      type: "execution.completed",
    },
    {
      key: "TRN-14",
      trigger: "execution.cancelled",
      to: "CANCELLED",
      type: "execution.cancelled",
    },
  ];

  for (const c of eventTypeCases) {
    it(`maps RUNNING -> ${c.to} to ${c.type}`, async () => {
      const taskId = await seedTask(h.db, fx, {
        jiraKey: c.key,
        state: "IMPLEMENTING",
      });
      const executionId = await seedExecution(h.db, taskId, {
        state: "RUNNING",
      });

      await h.db.transaction(async (tx) =>
        transition(tx, {
          entity: "execution",
          id: executionId,
          trigger: c.trigger,
          actor: { kind: "system" },
        }),
      );

      const events = await eventRows(taskId);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe(c.type);
      expect(events[0]!.executionId).toBe(executionId);
      expect(events[0]!.payload).toMatchObject({ from: "RUNNING", to: c.to });
    });
  }

  it("rejects an illegal execution move and writes nothing", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-9",
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, { state: "QUEUED" });

    await expect(
      h.db.transaction(async (tx) =>
        transition(tx, {
          entity: "execution",
          id: executionId,
          trigger: "execution.completed",
          actor: { kind: "system" },
        }),
      ),
    ).rejects.toThrow(TransitionError);

    expect(await auditRows(executionId)).toHaveLength(0);
    expect(await eventRows(taskId)).toHaveLength(0);
  });
});

describe("transition() concurrency (AC5)", () => {
  it("serialises two racing transitions from the same state: exactly one wins", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-10",
      state: "READY",
    });

    const claim = (actorId: string) =>
      h.db.transaction(async (tx) => {
        const result = await transition(tx, {
          entity: "task",
          id: taskId,
          trigger: "task.claimed",
          actor: { kind: "worker", id: actorId },
        });
        // Hold the row lock so the other transaction is forced to wait on
        // the `SELECT ... FOR UPDATE` rather than reading a stale state.
        await sleep(400);
        return result;
      });

    const first = claim("worker-a");
    await sleep(100);
    const second = claim("worker-b");

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      TransitionError,
    );

    const audit = await auditRows(taskId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.toState).toBe("IMPLEMENTING");

    const events = await eventRows(taskId);
    expect(events).toHaveLength(1);
  });
});

describe("transition() on an unknown row (AC7)", () => {
  const missing = "00000000-0000-4000-8000-000000000000";

  it("throws NotFoundError for an unknown task and writes nothing", async () => {
    await expect(
      h.db.transaction(async (tx) =>
        transition(tx, {
          entity: "task",
          id: missing,
          trigger: "task.claimed",
          actor: { kind: "worker", id: "worker-1" },
        }),
      ),
    ).rejects.toThrow(NotFoundError);

    expect(await auditRows(missing)).toHaveLength(0);
  });

  it("throws NotFoundError for an unknown execution", async () => {
    await expect(
      h.db.transaction(async (tx) =>
        transition(tx, {
          entity: "execution",
          id: missing,
          trigger: "execution.started",
          actor: { kind: "worker", id: "worker-1" },
        }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("rolls back a caller write that preceded the NotFoundError", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "TRN-11",
      state: "READY",
    });

    await expect(
      h.db.transaction(async (tx) => {
        await tx
          .update(schema.tasks)
          .set({ needsHumanReason: "should not survive" })
          .where(eq(schema.tasks.id, taskId));
        return transition(tx, {
          entity: "task",
          id: missing,
          trigger: "task.claimed",
          actor: { kind: "system" },
        });
      }),
    ).rejects.toThrow(NotFoundError);

    const [row] = await h.db
      .select()
      .from(schema.tasks)
      .where(
        and(eq(schema.tasks.id, taskId), eq(schema.tasks.state, "READY")),
      );
    expect(row!.needsHumanReason).toBeNull();
  });
});
