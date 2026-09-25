import { eq, max } from "drizzle-orm";
import { executionEvents } from "../schema/events.js";
import type { DbOrTx } from "../transition.js";

/**
 * The task's highest committed `execution_events.id`, or null when it has
 * none (design.md §12.6). A `GET /tasks/:id/stream` opened without a
 * cursor starts after this id. Anchoring on the task's own maximum, not
 * the channel-wide one, is safe because one task's events commit in id
 * order, so every event this read cannot see gets a higher id.
 */
export async function maxTaskEventId(
  db: DbOrTx,
  taskId: string,
): Promise<bigint | null> {
  const [row] = await db
    .select({ id: max(executionEvents.id) })
    .from(executionEvents)
    .where(eq(executionEvents.taskId, taskId));
  return row?.id ?? null;
}
