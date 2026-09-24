import type { ExecutionRole } from "@orchestra/core";
import { and, count, desc, eq } from "drizzle-orm";
import { executions } from "../schema/executions.js";
import { issues } from "../schema/issues.js";
import { projects, repositories } from "../schema/projects.js";
import { pullRequests } from "../schema/pull_requests.js";
import { specificationRevisions, tasks } from "../schema/tasks.js";
import type { DbOrTx } from "../transition.js";

export type TaskRow = typeof tasks.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;
export type SpecificationRevisionRow = typeof specificationRevisions.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;

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

  return {
    task: head.task,
    project: head.project,
    repository: head.repository,
    approvedRevision: head.approvedRevision,
    latestExecutions,
    openIssueCount: openIssues?.value ?? 0,
    pullRequest: head.pullRequest,
  };
}
