import type { ExecutionRole } from "@orchestra/core";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { executions } from "../schema/executions.js";
import { issues, taskDecisions } from "../schema/issues.js";
import { projects, repositories } from "../schema/projects.js";
import { pullRequests, reviewResults } from "../schema/pull_requests.js";
import {
  specificationApprovals,
  specificationRevisions,
  tasks,
} from "../schema/tasks.js";
import type { DbOrTx } from "../transition.js";
import type { IssueRow, TaskDecisionRow } from "./issues.js";

export type TaskRow = typeof tasks.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;
export type SpecificationRevisionRow = typeof specificationRevisions.$inferSelect;
export type SpecificationApprovalRow = typeof specificationApprovals.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type ReviewResultRow = typeof reviewResults.$inferSelect;

/**
 * Everything `GET /tasks/:id` needs in one shape (design.md §12.2).
 * Optional parts are `null`, never absent, so the api can serialise the
 * object without branching.
 */
export interface TaskAggregate {
  task: TaskRow;
  project: ProjectRow;
  repository: RepositoryRow | null;
  approvedRevision: SpecificationRevisionRow | null;
  /** Highest-attempt execution for each role, or null if the role never ran. */
  latestExecutions: Record<ExecutionRole, ExecutionRow | null>;
  openIssueCount: number;
  pullRequest: PullRequestRow | null;
  /** Every `specification_revisions` row for the task, ascending by version. */
  revisions: SpecificationRevisionRow[];
  /** Every `specification_approvals` row for the task's revisions, ascending by `approved_at`. */
  approvals: SpecificationApprovalRow[];
  /** Every `executions` row for the task, ascending by `created_at` then `attempt`. */
  executions: ExecutionRow[];
  /** Every `issues` row for the task, ascending by `created_at`. */
  issues: IssueRow[];
  /** Every `task_decisions` row for the task, ascending by `decided_at`. */
  decisions: TaskDecisionRow[];
  /** Every `review_results` row for the task's executions, ascending by `created_at`. */
  reviewResults: ReviewResultRow[];
}

export async function getTaskAggregate(
  db: DbOrTx,
  taskId: string,
): Promise<TaskAggregate | null> {
  const [head] = await db
    .select({
      task: tasks,
      project: projects,
      repository: repositories,
      approvedRevision: specificationRevisions,
      pullRequest: pullRequests,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(repositories, eq(repositories.id, tasks.repositoryId))
    .leftJoin(
      specificationRevisions,
      eq(specificationRevisions.id, tasks.approvedRevisionId),
    )
    .leftJoin(pullRequests, eq(pullRequests.taskId, tasks.id))
    .where(eq(tasks.id, taskId));

  if (!head) {
    return null;
  }

  // `pull_requests.task_id` is unique and `approved_revision_id` is a single
  // FK, so the joins above stay one-row. Executions are 1:many, so they get
  // their own ordered read and are folded to the latest per role here.
  const executionRows = await db
    .select()
    .from(executions)
    .where(eq(executions.taskId, taskId))
    .orderBy(desc(executions.attempt), desc(executions.createdAt));

  const latestExecutions: Record<ExecutionRole, ExecutionRow | null> = {
    spec: null,
    implementation: null,
  };
  for (const execution of executionRows) {
    if (latestExecutions[execution.role] === null) {
      latestExecutions[execution.role] = execution;
    }
  }

  const [openIssues] = await db
    .select({ value: count() })
    .from(issues)
    .where(and(eq(issues.taskId, taskId), eq(issues.status, "OPEN")));

  // Contract order ("ascending by created_at then attempt") differs from
  // `executionRows`'s descending fold order above, so this is its own read
  // rather than a re-sort of that array.
  const executionsAscending = await db
    .select()
    .from(executions)
    .where(eq(executions.taskId, taskId))
    .orderBy(asc(executions.createdAt), asc(executions.attempt));

  const executionIds = executionsAscending.map((execution) => execution.id);

  const revisions = await db
    .select()
    .from(specificationRevisions)
    .where(eq(specificationRevisions.taskId, taskId))
    .orderBy(asc(specificationRevisions.version));

  const revisionIds = revisions.map((revision) => revision.id);

  const [approvals, taskIssues, decisions, taskReviewResults] = await Promise.all([
    revisionIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(specificationApprovals)
          .where(inArray(specificationApprovals.revisionId, revisionIds))
          .orderBy(asc(specificationApprovals.approvedAt)),
    db
      .select()
      .from(issues)
      .where(eq(issues.taskId, taskId))
      .orderBy(asc(issues.createdAt)),
    db
      .select()
      .from(taskDecisions)
      .where(eq(taskDecisions.taskId, taskId))
      .orderBy(asc(taskDecisions.decidedAt)),
    executionIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(reviewResults)
          .where(inArray(reviewResults.executionId, executionIds))
          .orderBy(asc(reviewResults.createdAt)),
  ]);

  return {
    task: head.task,
    project: head.project,
    repository: head.repository,
    approvedRevision: head.approvedRevision,
    latestExecutions,
    openIssueCount: openIssues?.value ?? 0,
    pullRequest: head.pullRequest,
    revisions,
    approvals,
    executions: executionsAscending,
    issues: taskIssues,
    decisions,
    reviewResults: taskReviewResults,
  };
}
