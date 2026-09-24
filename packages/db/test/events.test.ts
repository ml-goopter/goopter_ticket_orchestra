import { TransitionError } from "@orchestra/core";
import { eq } from "drizzle-orm";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTIFY_CHANNEL, appendEvent } from "../src/events.js";
import * as schema from "../src/schema/index.js";
import { transition } from "../src/transition.js";
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
let listener: Sql;

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "EVT");
  listener = postgres(h.connectionString, { max: 1 });
}, 180000);

afterAll(async () => {
  await listener?.end({ timeout: 5 });
  await h?.stop();
});

/**
 * Subscribes a second raw connection to the `orchestra` channel and collects
 * every payload it receives until `stop()` is called (design.md §12.6).
 */
async function collectNotifications() {
  const received: string[] = [];
  const subscription = await listener.listen(NOTIFY_CHANNEL, (payload) => {
    received.push(payload);
  });
  return {
    received,
    async stop() {
      await subscription.unlisten();
    },
  };
}

describe("appendEvent (design.md §12.6)", () => {
  it("inserts an execution_events row and returns its id", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "EVT-1",
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, {
      state: "RUNNING",
    });

    const { id } = await h.db.transaction(async (tx) =>
      appendEvent(tx, {
        taskId,
        executionId,
        type: "agent.message",
        payload: { text: "hello" },
      }),
    );

    const rows = await h.db
      .select()
      .from(schema.executionEvents)
      .where(eq(schema.executionEvents.taskId, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.executionId).toBe(executionId);
    expect(rows[0]!.payload).toEqual({ text: "hello" });
  });

  it("leaves execution_id null when none is given", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "EVT-2",
      state: "NEEDS_SPEC",
    });

    await h.db.transaction(async (tx) =>
      appendEvent(tx, { taskId, type: "agent.note", payload: {} }),
    );

    const rows = await h.db
      .select()
      .from(schema.executionEvents)
      .where(eq(schema.executionEvents.taskId, taskId));
    expect(rows[0]!.executionId).toBeNull();
  });
});

describe("NOTIFY on commit (AC4)", () => {
  it("delivers exactly one { task_id, event_id } payload for a committed transition", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "EVT-3",
      state: "NEEDS_SPEC",
    });
    const sub = await collectNotifications();
    try {
      const result = await h.db.transaction(async (tx) =>
        transition(tx, {
          entity: "task",
          id: taskId,
          trigger: "spec.session_started",
          actor: { kind: "user", id: fx.userId },
        }),
      );

      await sleep(500);

      expect(sub.received).toHaveLength(1);
      const parsed = JSON.parse(sub.received[0]!) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["event_id", "task_id"]);
      expect(parsed.task_id).toBe(taskId);

      const [row] = await h.db
        .select()
        .from(schema.executionEvents)
        .where(eq(schema.executionEvents.taskId, taskId));
      expect(String(parsed.event_id)).toBe(String(row!.id));
      expect(String(parsed.event_id)).toBe(String(result.eventId));
    } finally {
      await sub.stop();
    }
  });

  it("delivers nothing when the transaction rolls back on an illegal transition", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "EVT-4",
      state: "NEEDS_SPEC",
    });
    const sub = await collectNotifications();
    try {
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

      await sleep(500);
      expect(sub.received).toEqual([]);
    } finally {
      await sub.stop();
    }
  });

  it("delivers nothing and persists no event row when a transaction rolls back after appendEvent commits its writes to the tx", async () => {
    // F1: unlike the illegal-transition test above (which never reaches
    // `appendEvent` because `assertTransition` throws first), this test
    // drives a *legal* transition through to a successful `appendEvent`
    // call inside the transaction, proves that write happened, and only
    // then forces a rollback. That is the only way to prove `pg_notify` is
    // issued inside the transaction rather than after it: if `NOTIFY` were
    // fired outside the transaction (e.g. after `db.transaction` resolved),
    // this test would still see a notification even though the row never
    // survives commit.
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "EVT-6",
      state: "NEEDS_SPEC",
    });
    const sub = await collectNotifications();
    class ForcedRollback extends Error {}
    try {
      await expect(
        h.db.transaction(async (tx) => {
          const result = await transition(tx, {
            entity: "task",
            id: taskId,
            trigger: "spec.session_started",
            actor: { kind: "user", id: fx.userId },
          });

          // Prove appendEvent actually ran and wrote inside this same
          // transaction before we roll it back.
          expect(result.eventId).toBeDefined();
          const rowsInTx = await tx
            .select()
            .from(schema.executionEvents)
            .where(eq(schema.executionEvents.taskId, taskId));
          expect(rowsInTx).toHaveLength(1);
          expect(rowsInTx[0]!.id).toBe(result.eventId);

          throw new ForcedRollback("force rollback after appendEvent");
        }),
      ).rejects.toThrow(ForcedRollback);

      await sleep(500);
      expect(sub.received).toEqual([]);

      const rowsAfterRollback = await h.db
        .select()
        .from(schema.executionEvents)
        .where(eq(schema.executionEvents.taskId, taskId));
      expect(rowsAfterRollback).toEqual([]);
    } finally {
      await sub.stop();
    }
  });

  it("delivers one payload per appended event", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "EVT-5",
      state: "IMPLEMENTING",
    });
    const executionId = await seedExecution(h.db, taskId, {
      state: "RUNNING",
    });
    const sub = await collectNotifications();
    try {
      await h.db.transaction(async (tx) => {
        await appendEvent(tx, {
          taskId,
          executionId,
          type: "agent.message.delta",
          payload: { text: "a" },
        });
        await appendEvent(tx, {
          taskId,
          executionId,
          type: "agent.message.delta",
          payload: { text: "b" },
        });
      });

      await sleep(500);
      expect(sub.received).toHaveLength(2);
      const ids = sub.received.map(
        (p) => (JSON.parse(p) as { event_id: number }).event_id,
      );
      expect(ids[1]).toBeGreaterThan(ids[0]!);
    } finally {
      await sub.stop();
    }
  });
});
