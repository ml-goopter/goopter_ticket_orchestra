import type { CommandType } from "@orchestra/core";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  executionCommands,
  executionUsage,
  executions,
} from "../schema/executions.js";
import { taskDecisions } from "../schema/issues.js";
import { projects, repositories } from "../schema/projects.js";
import { specificationRevisions, tasks } from "../schema/tasks.js";
import { users } from "../schema/users.js";
import type { DbOrTx } from "../transition.js";
import type {
  ExecutionRow,
  ProjectRow,
  RepositoryRow,
  SpecificationRevisionRow,
  TaskRow,
} from "./task-aggregate.js";

/**
 * Queries behind the worker's execution runner and command consumer
 * (design.md §6.1, §9.1-§9.3). The worker may not import drizzle, so every
 * statement they run lives here. State moves still go through
 * `transition()`.
 */

export type ExecutionCommandRow = typeof executionCommands.$inferSelect;

/** §6.1: at most this many commands per tick. */
export const COMMAND_CLAIM_LIMIT = 10;

export interface ClaimExecutionCommandsInput {
  /** This worker's `WORKER_HOST`. */
  host: string;
  /** Command types a handler is registered for. Others stay unclaimed. */
  types: readonly CommandType[];
  now: Date;
  limit?: number;
}

/**
 * design.md §6.1 in one statement, so the select, its row locks and the
 * `claimed_at` write share one transaction. Takes unclaimed commands of a
 * handled `type` whose execution is unset, unpinned (`host` null) or pinned
 * to `host`, oldest first, `FOR UPDATE SKIP LOCKED` so two workers never
 * claim the same row. Returned oldest first.
 */
export async function claimExecutionCommands(
  db: DbOrTx,
  input: ClaimExecutionCommandsInput,
): Promise<ExecutionCommandRow[]> {
  if (input.types.length === 0) return [];
  const limit = input.limit ?? COMMAND_CLAIM_LIMIT;

  const hostMatches = db
    .select({ id: executions.id })
    .from(executions)
    .where(or(eq(executions.host, input.host), isNull(executions.host)));

  const candidates = db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        isNull(executionCommands.claimedAt),
        inArray(executionCommands.type, [...input.types]),
        or(
          isNull(executionCommands.executionId),
          inArray(executionCommands.executionId, hostMatches),
        ),
      ),
    )
    .orderBy(asc(executionCommands.createdAt), asc(executionCommands.id))
    .limit(limit)
    .for("update", { skipLocked: true });

  const rows = await db
    .update(executionCommands)
    .set({ claimedAt: input.now })
    .where(inArray(executionCommands.id, candidates))
    .returning();

  return rows.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
}

/** Stamps `completed_at` once the command's handler has resolved (§6.1). */
export async function completeExecutionCommand(
  db: DbOrTx,
  commandId: string,
  now: Date,
): Promise<void> {
  await db
    .update(executionCommands)
    .set({ completedAt: now })
    .where(eq(executionCommands.id, commandId));
}

/**
 * Returns a claimed, uncompleted command to the queue (`claimed_at` back to
 * null), so the §6.1 claim on the right host can take it (GOT.39, GOT.47
 * carry-forward). A completed command is left alone.
 */
export async function unclaimCommand(
  db: DbOrTx,
  commandId: string,
): Promise<void> {
  await db
    .update(executionCommands)
    .set({ claimedAt: null })
    .where(
      and(
        eq(executionCommands.id, commandId),
        isNull(executionCommands.completedAt),
      ),
    );
}

/** One `task_decisions` row with the deciding user's email (§9.2). */
export interface RunnerDecision {
  issueId: string;
  decision: string;
  clarification: string | null;
  chosenOption: string | null;
  decidedBy: string;
  decidedAt: Date;
}

/** Everything the runner reads before starting a session (§9.1, §9.2). */
export interface RunnerContext {
  execution: ExecutionRow;
  task: TaskRow;
  project: ProjectRow;
  repository: RepositoryRow | null;
  /**
   * `executions.spec_revision_id`, falling back to the task's approved
   * revision. Null when neither exists.
   */
  revision: SpecificationRevisionRow | null;
  decisions: RunnerDecision[];
}

/** Loads the runner context for an execution, or null when it is gone. */
export async function loadRunnerContext(
  db: DbOrTx,
  executionId: string,
): Promise<RunnerContext | null> {
  const [head] = await db
    .select({
      execution: executions,
      task: tasks,
      project: projects,
      repository: repositories,
    })
    .from(executions)
    .innerJoin(tasks, eq(tasks.id, executions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(repositories, eq(repositories.id, tasks.repositoryId))
    .where(eq(executions.id, executionId))
    .limit(1);
  if (!head) return null;

  const revisionId =
    head.execution.specRevisionId ?? head.task.approvedRevisionId;
  let revision: SpecificationRevisionRow | null = null;
  if (revisionId) {
    const [row] = await db
      .select()
      .from(specificationRevisions)
      .where(eq(specificationRevisions.id, revisionId))
      .limit(1);
    revision = row ?? null;
  }

  const decisions = await db
    .select({
      issueId: taskDecisions.issueId,
      decision: taskDecisions.decision,
      clarification: taskDecisions.clarification,
      chosenOption: taskDecisions.chosenOption,
      decidedBy: users.email,
      decidedAt: taskDecisions.decidedAt,
    })
    .from(taskDecisions)
    .innerJoin(users, eq(users.id, taskDecisions.decidedBy))
    .where(eq(taskDecisions.taskId, head.task.id))
    .orderBy(asc(taskDecisions.decidedAt), asc(taskDecisions.id));

  return { ...head, revision, decisions };
}

/**
 * Reads `executions.cost_usd`, the running total `addExecutionUsageTotals`
 * maintains (design.md §9.7, GOT.50 item 4: "the execution's cumulative
 * cost_usd"). Null when the execution is gone.
 */
export async function getExecutionCostUsd(
  db: DbOrTx,
  executionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ costUsd: executions.costUsd })
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);
  return row?.costUsd ?? null;
}

/**
 * Sets `worker_id` and `host` where the claim left them null (§9.1). An
 * existing value is kept.
 */
export async function setExecutionPlacement(
  db: DbOrTx,
  executionId: string,
  placement: { workerId: string; host: string },
): Promise<void> {
  await db
    .update(executions)
    .set({
      workerId: sql`coalesce(${executions.workerId}, ${placement.workerId}::uuid)`,
      host: sql`coalesce(${executions.host}, ${placement.host})`,
    })
    .where(eq(executions.id, executionId));
}

/** Records the prepared worktree on the execution (§9.1). */
export async function setExecutionWorktree(
  db: DbOrTx,
  executionId: string,
  worktree: { worktreePath: string; branch: string | null },
): Promise<void> {
  await db
    .update(executions)
    .set({ worktreePath: worktree.worktreePath, branch: worktree.branch })
    .where(eq(executions.id, executionId));
}

/**
 * Stamps `ended_at` on an execution that has ended (COMPLETED, FAILED,
 * CANCELLED) and has none yet, for example one the api cancelled. No-op
 * otherwise.
 */
export async function markExecutionEnded(
  db: DbOrTx,
  executionId: string,
  now: Date,
): Promise<void> {
  await db
    .update(executions)
    .set({ endedAt: now })
    .where(
      and(
        eq(executions.id, executionId),
        isNull(executions.endedAt),
        inArray(executions.state, ["COMPLETED", "FAILED", "CANCELLED"]),
      ),
    );
}

/** Per-model totals of one session's recorded usage. */
export interface SessionUsageByModel {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Sums the execution's `main` and `resume` usage rows per model: what its
 * agent session has already reported, and so the baseline a resume passes
 * to the adapter (§9.7). `review` rows come from separate sessions and are
 * left out.
 */
export async function sumSessionUsageByModel(
  db: DbOrTx,
  executionId: string,
): Promise<SessionUsageByModel[]> {
  const rows = await db
    .select({
      model: executionUsage.model,
      inputTokens: sql<string>`sum(${executionUsage.inputTokens})`,
      cachedInputTokens: sql<string>`sum(${executionUsage.cachedInputTokens})`,
      outputTokens: sql<string>`sum(${executionUsage.outputTokens})`,
      costUsd: sql<string>`sum(${executionUsage.costUsd})`,
    })
    .from(executionUsage)
    .where(
      and(
        eq(executionUsage.executionId, executionId),
        inArray(executionUsage.kind, ["main", "resume"]),
      ),
    )
    .groupBy(executionUsage.model)
    .orderBy(asc(executionUsage.model));

  return rows.map((row) => ({
    model: row.model,
    inputTokens: Number(row.inputTokens),
    cachedInputTokens: Number(row.cachedInputTokens),
    outputTokens: Number(row.outputTokens),
    costUsd: Number(row.costUsd),
  }));
}
