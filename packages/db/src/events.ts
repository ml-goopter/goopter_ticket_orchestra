import type { ExecutionEventType } from "@orchestra/core";
import { sql } from "drizzle-orm";
import { executionEvents } from "./schema/events.js";
import type { Tx } from "./transition.js";

/**
 * The single `NOTIFY` channel (design.md §12.6). The api holds one
 * dedicated `LISTEN` connection on it and fans events out over SSE.
 */
export const NOTIFY_CHANNEL = "orchestra";

/** JSON payload carried on `NOTIFY orchestra` (design.md §12.6). */
export interface NotifyPayload {
  task_id: string;
  event_id: number;
}

export interface AppendEventInput {
  taskId: string;
  /** Null for task-scoped events such as `task.state_changed`. */
  executionId?: string | null;
  type: ExecutionEventType;
  payload: unknown;
}

/**
 * Advisory-lock class (the first key of the two-int4 form) for the per-task
 * event-order lock in `appendEvent`. Postgres keeps the two-int4 key space
 * apart from the single-bigint one, so this cannot collide with
 * `DEPENDENCY_GRAPH_LOCK_KEY` or any other single-key advisory lock.
 */
const EVENT_ORDER_LOCK_CLASS = 918_273_645;

/**
 * Appends one `execution_events` row and issues the matching
 * `NOTIFY orchestra` (design.md §12.6). The notify is deliberately inside
 * the caller's transaction: Postgres queues notifications until commit and
 * discards them on rollback, so a listener can never observe an event row
 * that was never committed.
 *
 * Always call this with a transaction handle, never a pooled client, so the
 * insert and the notify share a fate.
 *
 * Lock order: every caller must already hold a lock on the task row
 * (`FOR UPDATE`, `FOR KEY SHARE`, or the row was inserted in this
 * transaction) before calling this, and must not take a stronger task row
 * lock afterwards. The event-order lock below is then always taken after the
 * task row lock, so it cannot form a cycle with it.
 */
export async function appendEvent(
  tx: Tx,
  input: AppendEventInput,
): Promise<{ id: bigint }> {
  // Per-task commit order. `execution_events.id` is a bigserial assigned at
  // insert, but two transactions can commit in the opposite order of their
  // ids. A reader that has already seen the higher id and resumes "after" it
  // (SSE id dedupe, `Last-Event-ID` / `?after=` replay, `/timeline` paging)
  // would then never see the lower one. Holding this transaction-scoped
  // advisory lock from before the insert until commit or rollback makes a
  // second appender for the same task wait, so it is assigned its id only
  // after the first one's row is committed or gone. Appends for other tasks
  // do not wait. Two tasks whose ids hash to the same key only serialise
  // with each other, which is slower but still correct.
  await tx.execute(
    sql`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK_CLASS}::int4, hashtext(${input.taskId}::text))`,
  );

  const [row] = await tx
    .insert(executionEvents)
    .values({
      taskId: input.taskId,
      executionId: input.executionId ?? null,
      type: input.type,
      payload: input.payload,
    })
    .returning({ id: executionEvents.id });

  if (!row) {
    throw new Error("appendEvent: insert returned no row");
  }

  // `event_id` is a JSON number. `execution_events.id` is a bigserial, so
  // this is exact until 2^53 events, far beyond the retention this table
  // is sized for, and it keeps the payload parseable by `JSON.parse`,
  // which cannot represent a bigint.
  const payload: NotifyPayload = {
    task_id: input.taskId,
    event_id: Number(row.id),
  };

  await tx.execute(
    sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(payload)})`,
  );

  return { id: row.id };
}
