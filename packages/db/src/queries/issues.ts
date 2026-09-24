import { and, asc, eq } from "drizzle-orm";
import { issues } from "../schema/issues.js";
import type { DbOrTx } from "../transition.js";

export type IssueRow = typeof issues.$inferSelect;

export interface ListOpenIssuesOptions {
  /** Restrict to one task; omit for the cross-task attention list. */
  taskId?: string;
}

/**
 * Open issues, oldest first (design.md §12.4 `GET /issues?status=OPEN`).
 * `RESOLVED` and `SUPERSEDED` are excluded: only `OPEN` still needs an
 * answer.
 */
export async function listOpenIssues(
  db: DbOrTx,
  options: ListOpenIssuesOptions,
): Promise<IssueRow[]> {
  const open = eq(issues.status, "OPEN");
  return db
    .select()
    .from(issues)
    .where(
      options.taskId === undefined
        ? open
        : and(open, eq(issues.taskId, options.taskId)),
    )
    .orderBy(asc(issues.createdAt), asc(issues.id));
}
