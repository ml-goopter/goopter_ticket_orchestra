import type { Runtime } from "@orchestra/core";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { executionEvents } from "../schema/events.js";
import { agentWorkers, executions } from "../schema/executions.js";
import { projects, repositories } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";
import type { ExecutionRow, ProjectRow, TaskRow } from "./task-aggregate.js";

/**
 * Queries behind the worker's retry policy and retry starter (design.md
 * §9.5, §6.5). The worker may not import drizzle, so every statement lives
 * here. State moves still go through `transition()`. Lock order: the
 * worker row, then the task row, then the execution row.
 */

/** What the failure policy reads once the task and execution are locked. */
export interface FailurePolicyContext {
  execution: ExecutionRow;
  task: TaskRow;
  project: ProjectRow;
}

/**
 * Reads the execution, its task and the task's project. Takes no lock: the
 * caller already holds the task row, then the execution row.
 */
export async function loadFailurePolicyContext(
  db: DbOrTx,
  executionId: string,
): Promise<FailurePolicyContext | null> {
  const [row] = await db
    .select({ execution: executions, task: tasks, project: projects })
    .from(executions)
    .innerJoin(tasks, eq(tasks.id, executions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(executions.id, executionId))
    .limit(1);
  return row ?? null;
}

/** Executions of `taskId` that ended `protocol_violation` (§9.5, C26). */
export async function countProtocolViolations(
  db: DbOrTx,
  taskId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(executions)
    .where(
      and(
        eq(executions.taskId, taskId),
        eq(executions.endReason, "protocol_violation"),
      ),
    );
  return row?.n ?? 0;
}

export interface InsertRetryExecutionInput {
  taskId: string;
  role: "spec" | "implementation";
  attempt: number;
  runtime: Runtime;
  model: string;
  specRevisionId: string | null;
  branch: string | null;
  sessionId: string | null;
  infraRetriesUsed: number;
}

/**
 * Inserts a retry execution in `QUEUED` with no host and no worker, so any
 * capable worker's retry starter may take it (§6.5). The caller holds the
 * task row lock.
 */
export async function insertRetryExecution(
  tx: Tx,
  input: InsertRetryExecutionInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(executions)
    .values({ ...input, state: "QUEUED", host: null, workerId: null })
    .returning({ id: executions.id });
  if (!row) throw new Error("insertRetryExecution: insert returned no row");
  return row;
}

/**
 * Sets `needs_human_reason` when it is null. A reason an escalation already
 * wrote is kept. The caller holds the task row lock.
 */
export async function setNeedsHumanReasonIfMissing(
  tx: Tx,
  taskId: string,
  reason: string,
): Promise<boolean> {
  const rows = await tx
    .update(tasks)
    .set({ needsHumanReason: reason, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), isNull(tasks.needsHumanReason)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/** Execution states that are not ended (§5.2). */
const LIVE_STATES = [
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_USER",
] as const;

/** Execution states that hold a worker slot (§6.3). */
const SLOT_HOLDING_STATES = ["ASSIGNED", "RUNNING"] as const;

/** Task states a retry execution may start in (§9.5). */
const RETRYABLE_TASK_STATES = ["IMPLEMENTING", "REVIEWING"] as const;

export interface RetryCandidateInput {
  workerId: string;
  host: string;
  /** Runtimes whose binary this worker found on PATH (§7.3). */
  runtimes: readonly Runtime[];
  now: Date;
}

/** A QUEUED retry execution the starter may take, with its queue payload. */
export interface RetryCandidate {
  executionId: string;
  taskId: string;
  /** Payload of the row's `execution.queued` event. */
  queued: unknown;
}

const others = alias(executions, "other");
const queuedEvent = alias(executionEvents, "queued_event");

/**
 * The oldest `QUEUED` implementation execution with `host` null whose
 * `execution.queued` event's `not_before` has passed at `now`, whose task
 * is `IMPLEMENTING` or `REVIEWING` with no other live execution, whose
 * runtime this worker detected, whose repository this worker is capable of
 * (D16) and is below `max_concurrent_worktrees` on this host (§6.3).
 *
 * Locks the task row `FOR UPDATE OF tasks SKIP LOCKED`, so a concurrent
 * starter skips it and takes the next one. Call after `getClaimWorker` and
 * before `lockQueuedRetry`: worker, then task, then execution.
 */
export async function selectRetryCandidate(
  tx: Tx,
  input: RetryCandidateInput,
): Promise<RetryCandidate | null> {
  if (input.runtimes.length === 0) return null;

  const busy = tx.$with("busy").as(
    tx
      .select({
        repositoryId: tasks.repositoryId,
        n: sql<number>`count(*)::int`.as("n"),
      })
      .from(executions)
      .innerJoin(tasks, eq(tasks.id, executions.taskId))
      .where(
        and(
          eq(executions.host, input.host),
          inArray(executions.state, [...SLOT_HOLDING_STATES]),
        ),
      )
      .groupBy(tasks.repositoryId),
  );

  const [row] = await tx
    .with(busy)
    .select({
      executionId: executions.id,
      taskId: executions.taskId,
      queued: queuedEvent.payload,
    })
    .from(executions)
    .innerJoin(tasks, eq(tasks.id, executions.taskId))
    .innerJoin(repositories, eq(repositories.id, tasks.repositoryId))
    .innerJoin(
      queuedEvent,
      and(
        eq(queuedEvent.executionId, executions.id),
        eq(queuedEvent.type, "execution.queued"),
      ),
    )
    .leftJoin(busy, eq(busy.repositoryId, repositories.id))
    .where(
      and(
        eq(executions.state, "QUEUED"),
        isNull(executions.host),
        eq(executions.role, "implementation"),
        inArray(executions.runtime, [...input.runtimes]),
        inArray(tasks.state, [...RETRYABLE_TASK_STATES]),
        sql`(${queuedEvent.payload}->>'not_before')::timestamptz <= ${input.now.toISOString()}::timestamptz`,
        notExists(
          tx
            .select({ one: sql`1` })
            .from(others)
            .where(
              and(
                eq(others.taskId, executions.taskId),
                ne(others.id, executions.id),
                inArray(others.state, [...LIVE_STATES]),
              ),
            ),
        ),
        or(
          isNull(repositories.requiredCapability),
          exists(
            tx
              .select({ one: sql`1` })
              .from(agentWorkers)
              .where(
                and(
                  eq(agentWorkers.id, input.workerId),
                  sql`${repositories.requiredCapability} = any(${agentWorkers.capabilities})`,
                ),
              ),
          ),
        ),
        sql`coalesce(${busy.n}, 0) < ${repositories.maxConcurrentWorktrees}`,
      ),
    )
    .orderBy(asc(executions.createdAt), asc(executions.id))
    .limit(1)
    .for("update", { of: tasks, skipLocked: true });

  return row ?? null;
}

/**
 * Locks the execution row `FOR UPDATE` after its task row, and returns true
 * when it is still `QUEUED` with no host, re-checked under the lock.
 */
export async function lockQueuedRetry(
  tx: Tx,
  executionId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.state, "QUEUED"),
        isNull(executions.host),
      ),
    )
    .for("update");
  return row !== undefined;
}

/**
 * Pins a retry execution to the starting worker (§6.5). The caller holds
 * the task row, then the execution row.
 */
export async function pinRetryExecution(
  tx: Tx,
  executionId: string,
  placement: { workerId: string; host: string },
): Promise<void> {
  await tx
    .update(executions)
    .set({ workerId: placement.workerId, host: placement.host })
    .where(eq(executions.id, executionId));
}

/** Where a failed attempt's worktree is, read under its row lock (C31). */
export interface RetryPreviousWorktree {
  host: string | null;
  worktreePath: string | null;
  branch: string | null;
  worktreeEvictedAt: Date | null;
}

/**
 * Locks the failed attempt's execution row `FOR UPDATE` and returns where
 * its worktree is. Call after the task row and the retry's own row, in the
 * retry claim transaction. Null when the row is gone or not `FAILED`.
 */
export async function lockPreviousWorktree(
  tx: Tx,
  input: { executionId: string; taskId: string },
): Promise<RetryPreviousWorktree | null> {
  const [row] = await tx
    .select({
      host: executions.host,
      worktreePath: executions.worktreePath,
      branch: executions.branch,
      worktreeEvictedAt: executions.worktreeEvictedAt,
    })
    .from(executions)
    .where(
      and(
        eq(executions.id, input.executionId),
        eq(executions.taskId, input.taskId),
        eq(executions.state, "FAILED"),
      ),
    )
    .for("update");
  return row ?? null;
}

/**
 * C31: the retry takes over the failed attempt's worktree. Sets the
 * retry's `worktree_path` and `branch`, and clears the failed row's
 * `worktree_path`, so the worktree sweeper never treats the directory as
 * the failed row's. Both rows are locked by the caller.
 */
export async function transferRetryWorktree(
  tx: Tx,
  input: {
    fromExecutionId: string;
    toExecutionId: string;
    worktreePath: string;
    branch: string | null;
  },
): Promise<void> {
  await tx
    .update(executions)
    .set({ worktreePath: input.worktreePath, branch: input.branch })
    .where(eq(executions.id, input.toExecutionId));
  await tx
    .update(executions)
    .set({ worktreePath: null })
    .where(eq(executions.id, input.fromExecutionId));
}
