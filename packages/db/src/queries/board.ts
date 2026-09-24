import type { TaskState } from "@orchestra/core";
import { and, asc, eq, exists, gt, inArray, not, or, sql } from "drizzle-orm";
import { executions } from "../schema/executions.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx } from "../transition.js";

export interface BoardRow {
  taskId: string;
  projectId: string;
  repositoryId: string | null;
  jiraKey: string;
  jiraSummary: string;
  state: TaskState;
  jiraPriority: number;
  jiraCreatedAt: Date;
  updatedAt: Date;
  /**
   * Second argument to core's `deriveColumn`. Computed here so the api can
   * stay free of SQL and `packages/core` can stay free of I/O.
   */
  hasWaitingExecution: boolean;
}

/**
 * States a task never leaves on its own, so they only stay on the board
 * while they are still fresh.
 */
const CLOSED_STATES = ["DONE", "CANCELLED"] as const satisfies readonly TaskState[];

/** How long a closed task keeps its place in the "Done" column (§5.1). */
export const BOARD_CLOSED_WINDOW = sql`now() - interval '7 days'`;

/**
 * Every task the dashboard should render (design.md §5.1, §12.2): all open
 * tasks, plus `DONE` and `CANCELLED` ones closed in the last 7 days.
 * `FAILED` stays, since §5.1 allows it to be cancelled and a failed task
 * still needs someone to look at it.
 *
 * Ordering matches the scheduler's claim order (§6.3): priority, then age.
 */
export async function listBoard(db: DbOrTx): Promise<BoardRow[]> {
  const hasWaitingExecution = sql<boolean>`${exists(
    db
      .select({ one: sql`1` })
      .from(executions)
      .where(
        and(
          eq(executions.taskId, tasks.id),
          eq(executions.state, "WAITING_FOR_USER"),
        ),
      ),
  )}`;

  return db
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      repositoryId: tasks.repositoryId,
      jiraKey: tasks.jiraKey,
      jiraSummary: tasks.jiraSummary,
      state: tasks.state,
      jiraPriority: tasks.jiraPriority,
      jiraCreatedAt: tasks.jiraCreatedAt,
      updatedAt: tasks.updatedAt,
      hasWaitingExecution,
    })
    .from(tasks)
    .where(
      or(
        not(inArray(tasks.state, [...CLOSED_STATES])),
        gt(tasks.updatedAt, BOARD_CLOSED_WINDOW),
      ),
    )
    .orderBy(asc(tasks.jiraPriority), asc(tasks.jiraCreatedAt));
}
