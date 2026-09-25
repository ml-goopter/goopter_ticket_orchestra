import type { IssueStatus } from "@orchestra/core";
import { and, asc, eq, ne } from "drizzle-orm";
import { executions } from "../schema/executions.js";
import { issueMessages, issues, taskDecisions } from "../schema/issues.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";

/**
 * Queries behind the issue routes (design.md §10.2-§10.5, §12.4). The api
 * may not import drizzle, so every statement those routes run lives here;
 * the routes own transaction boundaries and call `transition()` for the
 * one state move a `spec_revision` resolution makes.
 *
 * Lock order used by `/issues/:id/messages` and `/issues/:id/resolve`: the
 * task row (`lockTaskForSpec`), then the execution row
 * (`lockExecutionForTool`), then the issue row (`lockIssue`). Both routes
 * first read `getIssueLocation` without a lock to learn which task and
 * execution to lock -- safe because `issues.task_id`/`issues.execution_id`
 * are set once at insert and never updated.
 */

export type IssueRow = typeof issues.$inferSelect;
export type IssueMessageRow = typeof issueMessages.$inferSelect;
export type TaskDecisionRow = typeof taskDecisions.$inferSelect;

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

export interface ListIssuesOptions {
  status?: IssueStatus;
  blocking?: boolean;
}

/**
 * Issues filtered by `status` and/or `blocking`, oldest first -- same
 * order as `listOpenIssues` (design.md §12.4
 * `GET /issues?status=&blocking=`). Either filter, both, or neither.
 */
export async function listIssues(
  db: DbOrTx,
  options: ListIssuesOptions = {},
): Promise<IssueRow[]> {
  const conditions = [
    options.status !== undefined ? eq(issues.status, options.status) : undefined,
    options.blocking !== undefined ? eq(issues.blocking, options.blocking) : undefined,
  ].filter((c) => c !== undefined);

  return db
    .select()
    .from(issues)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(issues.createdAt), asc(issues.id));
}

export interface IssueLocation {
  taskId: string;
  executionId: string;
}

/**
 * Unlocked read of an issue's `task_id`/`execution_id`, both immutable
 * once inserted. Callers use this to learn which task and execution rows
 * to lock, in order, before locking the issue itself. `null` for an
 * unknown issue.
 */
export async function getIssueLocation(
  db: DbOrTx,
  issueId: string,
): Promise<IssueLocation | null> {
  const [row] = await db
    .select({ taskId: issues.taskId, executionId: issues.executionId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ?? null;
}

/**
 * Locks the issue row `FOR UPDATE`. Call last in the lock order (task,
 * execution, issue), so a concurrent message/resolve on the same issue
 * serialises rather than racing. `null` when the issue does not exist.
 */
export async function lockIssue(tx: Tx, issueId: string): Promise<IssueRow | null> {
  const [row] = await tx
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .for("update");
  return row ?? null;
}

export interface IssueExecutionSummary {
  id: string;
  role: "spec" | "implementation";
  state: string;
  runtime: string;
}

export interface IssueTaskSummary {
  id: string;
  jiraKey: string;
  state: string;
}

export interface IssueDetail {
  issue: IssueRow;
  messages: IssueMessageRow[];
  execution: IssueExecutionSummary;
  task: IssueTaskSummary;
  decision: TaskDecisionRow | null;
}

/**
 * Full detail behind `GET /issues/:id` (design.md §12.4): the issue, its
 * messages oldest first, the execution and task it belongs to, and its
 * decision when resolved. `null` for an unknown issue.
 */
export async function getIssueDetail(
  db: DbOrTx,
  issueId: string,
): Promise<IssueDetail | null> {
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!issue) return null;

  const [executionRows, taskRows, messages, decisionRows] = await Promise.all([
    db
      .select({
        id: executions.id,
        role: executions.role,
        state: executions.state,
        runtime: executions.runtime,
      })
      .from(executions)
      .where(eq(executions.id, issue.executionId))
      .limit(1),
    db
      .select({ id: tasks.id, jiraKey: tasks.jiraKey, state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, issue.taskId))
      .limit(1),
    db
      .select()
      .from(issueMessages)
      .where(eq(issueMessages.issueId, issueId))
      .orderBy(asc(issueMessages.createdAt), asc(issueMessages.id)),
    db
      .select()
      .from(taskDecisions)
      .where(eq(taskDecisions.issueId, issueId))
      .limit(1),
  ]);

  const execution = executionRows[0];
  const task = taskRows[0];
  if (!execution || !task) {
    throw new Error(
      `getIssueDetail: issue ${issueId} references a missing execution or task`,
    );
  }

  return { issue, messages, execution, task, decision: decisionRows[0] ?? null };
}

export interface InsertIssueMessageInput {
  issueId: string;
  userId: string;
  body: string;
  now: Date;
}

/** Inserts one user `issue_messages` row (design.md §10.2). */
export async function insertIssueMessage(
  tx: Tx,
  input: InsertIssueMessageInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(issueMessages)
    .values({
      issueId: input.issueId,
      authorKind: "user",
      userId: input.userId,
      body: input.body,
      createdAt: input.now,
    })
    .returning({ id: issueMessages.id });
  if (!row) throw new Error("insertIssueMessage: insert returned no row");
  return row;
}

export interface ResolveIssueInput {
  issueId: string;
  resolutionKind: "clarification" | "spec_revision";
  resolution: string;
  resolvedBy: string;
  now: Date;
}

/**
 * Common write of every resolve path (design.md §10.3, §10.4): marks the
 * issue `RESOLVED`. Caller already holds the issue row lock.
 */
export async function resolveIssue(tx: Tx, input: ResolveIssueInput): Promise<void> {
  await tx
    .update(issues)
    .set({
      status: "RESOLVED",
      resolutionKind: input.resolutionKind,
      resolution: input.resolution,
      resolvedBy: input.resolvedBy,
      resolvedAt: input.now,
    })
    .where(eq(issues.id, input.issueId));
}

export interface InsertTaskDecisionInput {
  taskId: string;
  issueId: string;
  decision: string;
  clarification: string | null;
  chosenOption: string | null;
  decidedBy: string;
  now: Date;
}

/** Inserts the `task_decisions` row for a resolved issue (design.md §4.2). */
export async function insertTaskDecision(
  tx: Tx,
  input: InsertTaskDecisionInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(taskDecisions)
    .values({
      taskId: input.taskId,
      issueId: input.issueId,
      decision: input.decision,
      clarification: input.clarification,
      chosenOption: input.chosenOption,
      decidedBy: input.decidedBy,
      decidedAt: input.now,
    })
    .returning({ id: taskDecisions.id });
  if (!row) throw new Error("insertTaskDecision: insert returned no row");
  return row;
}

export interface SupersedeOtherOpenIssuesInput {
  executionId: string;
  excludeIssueId: string;
  now: Date;
}

/**
 * Marks every other `OPEN` issue on the same execution `SUPERSEDED`
 * (design.md §10.4: resolving a `spec_revision` issue supersedes the
 * execution's other open issues). Returns their ids so the caller can
 * append one `issue.resolved` event per superseded issue.
 */
export async function supersedeOtherOpenIssues(
  tx: Tx,
  input: SupersedeOtherOpenIssuesInput,
): Promise<string[]> {
  const rows = await tx
    .update(issues)
    .set({ status: "SUPERSEDED", resolvedAt: input.now })
    .where(
      and(
        eq(issues.executionId, input.executionId),
        eq(issues.status, "OPEN"),
        ne(issues.id, input.excludeIssueId),
      ),
    )
    .returning({ id: issues.id });
  return rows.map((r) => r.id);
}
