import { eq, sql } from "drizzle-orm";
import { executionEvents } from "../schema/events.js";
import { executions } from "../schema/executions.js";
import { specificationRevisions } from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";
import type { SpecificationRevisionRow } from "./task-aggregate.js";

/**
 * Queries behind the worker's issue resumes (design.md §9.2, §9.3, §10.2-
 * §10.4) and the fresh-session fallback for an execution released from a
 * dead host (§6.1, D5, C21). The worker may not import drizzle, so every
 * statement lives here; the worker owns the transaction boundaries, holds
 * the task, then execution, row locks, and calls `transition()` for every
 * state move.
 */

/** One specification revision, unlocked. `null` when it does not exist. */
export async function getSpecRevisionById(
  db: DbOrTx,
  revisionId: string,
): Promise<SpecificationRevisionRow | null> {
  const [row] = await db
    .select()
    .from(specificationRevisions)
    .where(eq(specificationRevisions.id, revisionId))
    .limit(1);
  return row ?? null;
}

/**
 * Pins the execution to this worker and host (C21): the fresh-session
 * fallback takes over an execution the dead-host release unpinned. Call
 * with the task, then execution, row locked, after checking `host` is null.
 */
export async function pinExecutionToHost(
  tx: Tx,
  executionId: string,
  placement: { workerId: string; host: string },
): Promise<void> {
  await tx
    .update(executions)
    .set({ workerId: placement.workerId, host: placement.host })
    .where(eq(executions.id, executionId));
}

/**
 * Records the session a fresh-session fallback started on an execution that
 * is already RUNNING (C21), so later resumes use it. Call with the execution
 * row locked.
 */
export async function setExecutionSessionId(
  tx: Tx,
  executionId: string,
  sessionId: string,
): Promise<void> {
  await tx
    .update(executions)
    .set({ sessionId })
    .where(eq(executions.id, executionId));
}

/**
 * Merges `extra` into the payload of an `execution_events` row appended
 * earlier in the same transaction: `transition()` writes the
 * `execution.resumed` payload with `from`/`to`/`trigger`/`actor` only, and a
 * resume adds what caused it (§10.4: the previous `spec_revision_id`). The
 * `NOTIFY` carries only the event id and fires at commit, so no reader sees
 * the payload before the merge.
 */
export async function mergeExecutionEventPayload(
  tx: Tx,
  eventId: bigint,
  extra: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(executionEvents)
    .set({ payload: sql`${executionEvents.payload} || ${JSON.stringify(extra)}::jsonb` })
    .where(eq(executionEvents.id, eventId));
}
