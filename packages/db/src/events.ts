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
 * Appends one `execution_events` row and issues the matching
 * `NOTIFY orchestra` (design.md §12.6). The notify is deliberately inside
 * the caller's transaction: Postgres queues notifications until commit and
 * discards them on rollback, so a listener can never observe an event row
 * that was never committed.
 *
 * Always call this with a transaction handle, never a pooled client, so the
 * insert and the notify share a fate.
 */
export async function appendEvent(
  tx: Tx,
  input: AppendEventInput,
): Promise<{ id: bigint }> {
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
