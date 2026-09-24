import type { TaskState } from "@orchestra/core";
import { and, asc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { executions } from "../schema/executions.js";
import { issues } from "../schema/issues.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx } from "../transition.js";

/** Why a task is on the attention list. */
export type AttentionReason =
  | "spec_review"
  | "needs_human"
  | "ready_for_merge"
  | "waiting_for_user";

export interface AttentionRow {
  taskId: string;
  jiraKey: string;
  jiraSummary: string;
  state: TaskState;
  jiraPriority: number;
  jiraCreatedAt: Date;
  updatedAt: Date;
  reason: AttentionReason;
  /** Oldest open blocking issue, set only when `reason` is `waiting_for_user`. */
  blockingIssueId: string | null;
}

/**
 * Task states that on their own put a task in front of a human
 * (design.md §5.1: awaiting spec approval, escalated, merge pending).
 */
const ATTENTION_STATES = [
  "SPEC_REVIEW",
  "NEEDS_HUMAN",
  "READY_FOR_MERGE",
] as const satisfies readonly TaskState[];

/**
 * Tasks waiting on a person (spec §2.4, design.md §12.2 `?attention=1`).
 *
 * A task appears once. `waiting_for_user` takes precedence over the
 * state-based reasons, matching `deriveColumn`, where "Waiting for You"
 * wins over the state's own column (§5.1). The remaining three reasons are
 * mutually exclusive because they are distinct task states.
 */
export async function listAttention(db: DbOrTx): Promise<AttentionRow[]> {
  const waitingExecution = sql<boolean>`${exists(
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

  // `issues` is aliased so the correlated reference to `tasks.id` renders
  // qualified. An unaliased raw-SQL subquery resolves a bare `id` against
  // the inner table, which silently matches nothing.
  const blockingIssue = alias(issues, "blocking_issue");
  const blockingIssueId = sql<string | null>`${db
    .select({ id: blockingIssue.id })
    .from(blockingIssue)
    .where(
      and(
        eq(blockingIssue.taskId, tasks.id),
        eq(blockingIssue.status, "OPEN"),
        eq(blockingIssue.blocking, true),
      ),
    )
    .orderBy(asc(blockingIssue.createdAt), asc(blockingIssue.id))
    .limit(1)}`;

  const rows = await db
    .select({
      taskId: tasks.id,
      jiraKey: tasks.jiraKey,
      jiraSummary: tasks.jiraSummary,
      state: tasks.state,
      jiraPriority: tasks.jiraPriority,
      jiraCreatedAt: tasks.jiraCreatedAt,
      updatedAt: tasks.updatedAt,
      waiting: waitingExecution,
      blockingIssueId,
    })
    .from(tasks)
    .where(or(inArray(tasks.state, [...ATTENTION_STATES]), waitingExecution))
    .orderBy(asc(tasks.jiraPriority), asc(tasks.jiraCreatedAt));

  return rows.map((row) => {
    const reason: AttentionReason = row.waiting
      ? "waiting_for_user"
      : row.state === "SPEC_REVIEW"
        ? "spec_review"
        : row.state === "NEEDS_HUMAN"
          ? "needs_human"
          : "ready_for_merge";
    return {
      taskId: row.taskId,
      jiraKey: row.jiraKey,
      jiraSummary: row.jiraSummary,
      state: row.state,
      jiraPriority: row.jiraPriority,
      jiraCreatedAt: row.jiraCreatedAt,
      updatedAt: row.updatedAt,
      reason,
      blockingIssueId:
        reason === "waiting_for_user" ? row.blockingIssueId : null,
    };
  });
}
