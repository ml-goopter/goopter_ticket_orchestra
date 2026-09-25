import { and, asc, eq, gt } from "drizzle-orm";
import { executionEvents } from "../schema/events.js";
import type { DbOrTx } from "../transition.js";

export type ExecutionEventRow = typeof executionEvents.$inferSelect;

/** Page size when the caller does not ask for one. */
export const TIMELINE_LIMIT_DEFAULT = 200;
/** Hard ceiling, so one request cannot drag the whole event log out. */
export const TIMELINE_LIMIT_MAX = 1000;

/**
 * Clamps a caller-supplied page size into `[1, TIMELINE_LIMIT_MAX]`. A
 * missing or non-finite value (`NaN`, `±Infinity`) gets the default.
 */
export function clampTimelineLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return TIMELINE_LIMIT_DEFAULT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), TIMELINE_LIMIT_MAX);
}

export interface TimelineOptions {
  /** Exclusive lower bound: the SSE `Last-Event-ID` / `?after=` cursor. */
  after?: bigint;
  limit?: number;
}

/**
 * One page of a task's event log, ascending by id (design.md §12.2, §12.6).
 * Ascending order and an exclusive `after` are what let an SSE client
 * reconnect with `Last-Event-ID` and receive every event it missed exactly
 * once.
 */
export async function listTimeline(
  db: DbOrTx,
  taskId: string,
  options: TimelineOptions,
): Promise<ExecutionEventRow[]> {
  const where =
    options.after === undefined
      ? eq(executionEvents.taskId, taskId)
      : and(
          eq(executionEvents.taskId, taskId),
          gt(executionEvents.id, options.after),
        );

  return db
    .select()
    .from(executionEvents)
    .where(where)
    .orderBy(asc(executionEvents.id))
    .limit(clampTimelineLimit(options.limit));
}
