import type { Runtime } from "@orchestra/core";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  not,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  agentWorkers,
  executions,
  taskLeases,
} from "../schema/executions.js";
import { repositories } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";

/**
 * Queries behind the worker's scheduler phases (design.md §6.2 promotion,
 * §6.3 claim). The worker may not import drizzle, so every statement the
 * phases run lives here; the phases own transaction boundaries and call
 * `transition()` for every state move.
 */

/** Execution states that hold a worker slot and a worktree (§6.3, D5). */
const SLOT_HOLDING_STATES = ["ASSIGNED", "RUNNING"] as const;

/** A task with an execution in this state is paused, not promotable (§6.2). */
const PAUSED_STATE = "WAITING_FOR_USER";

/** `repositories.default_model` fallback when the repository sets none. */
export const DEFAULT_EXECUTION_MODEL = "default";

/**
 * Execution states that are not ended (§5.2). A `READY` task with one of
 * these is not claimable: the review round limit can leave an execution
 * `RUNNING` while a human retry moves its task back to `READY`.
 */
const LIVE_STATES = [
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_USER",
] as const;

const noLiveExecution = (db: DbOrTx): SQL =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(executions)
      .where(
        and(
          eq(executions.taskId, tasks.id),
          inArray(executions.state, [...LIVE_STATES]),
        ),
      ),
  );

const noPausedExecution = (db: DbOrTx): SQL =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(executions)
      .where(
        and(
          eq(executions.taskId, tasks.id),
          eq(executions.state, PAUSED_STATE),
        ),
      ),
  );

/**
 * Ids of `SPEC_APPROVED` tasks with no paused execution (§6.2), most urgent
 * first. Read without locks: each id is re-checked under
 * `lockTaskForPromotion` before anything is written.
 */
export async function listPromotionCandidateIds(
  db: DbOrTx,
): Promise<string[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.state, "SPEC_APPROVED"), noPausedExecution(db)))
    .orderBy(asc(tasks.jiraPriority), asc(tasks.jiraCreatedAt), asc(tasks.id));
  return rows.map((row) => row.id);
}

/**
 * Locks the task row `FOR UPDATE SKIP LOCKED` if it is still
 * `SPEC_APPROVED` with no paused execution. False when the task moved on,
 * gained a paused execution, or is locked by another transaction (it is
 * retried next tick).
 */
export async function lockTaskForPromotion(
  tx: Tx,
  taskId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.state, "SPEC_APPROVED"),
        noPausedExecution(tx),
      ),
    )
    .for("update", { of: tasks, skipLocked: true });
  return row !== undefined;
}

/** The claiming worker's row, read inside the claim transaction. */
export interface ClaimWorker {
  host: string;
  maxConcurrent: number;
}

export async function getClaimWorker(
  tx: Tx,
  workerId: string,
): Promise<ClaimWorker | null> {
  const [row] = await tx
    .select({
      host: agentWorkers.host,
      maxConcurrent: agentWorkers.maxConcurrent,
    })
    .from(agentWorkers)
    .where(eq(agentWorkers.id, workerId));
  return row ?? null;
}

/**
 * Executions on `host` holding a slot: `ASSIGNED` and `RUNNING` (§6.3, the
 * same rule as `listWorkersWithSlots`). `WAITING_FOR_USER` frees its slot
 * (D5).
 */
export async function countSlotHoldingExecutions(
  db: DbOrTx,
  host: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(executions)
    .where(
      and(
        eq(executions.host, host),
        inArray(executions.state, [...SLOT_HOLDING_STATES]),
      ),
    );
  return row?.n ?? 0;
}

/** `coalesce(tasks.runtime_override, repositories.default_runtime)` (§7.3). */
const effectiveRuntime = sql<Runtime>`coalesce(${tasks.runtimeOverride}, ${repositories.defaultRuntime})`;

/**
 * Repository capability matches the worker (§6.3, D16): a null
 * `required_capability` matches every worker.
 */
const capabilityMatches = (db: DbOrTx, workerId: string): SQL =>
  or(
    isNull(repositories.requiredCapability),
    exists(
      db
        .select({ one: sql`1` })
        .from(agentWorkers)
        .where(
          and(
            eq(agentWorkers.id, workerId),
            sql`${repositories.requiredCapability} = any(${agentWorkers.capabilities})`,
          ),
        ),
    ),
  )!;

export interface ClaimCandidateInput {
  workerId: string;
  host: string;
  /** Runtimes whose binary this worker found on PATH (§7.3). */
  runtimes: readonly Runtime[];
}

/** The task a claim will take, with what its execution row needs (G5). */
export interface ClaimCandidate {
  taskId: string;
  runtime: Runtime;
  model: string;
  approvedRevisionId: string | null;
}

/**
 * design.md §6.3 candidate query. Picks the most urgent (`jira_priority`,
 * then oldest `jira_created_at`) `READY` task with no live execution, whose
 * repository this worker is capable of, whose repository is below `max_concurrent_worktrees` on
 * this host, and whose effective runtime is detected. Locks the task row
 * `FOR UPDATE OF tasks SKIP LOCKED`, so a concurrent claimer skips it and
 * takes the next one. The task lock is the first row lock of the claim
 * transaction, before any execution row, per the task-then-execution lock
 * order.
 */
export async function selectClaimCandidate(
  tx: Tx,
  input: ClaimCandidateInput,
): Promise<ClaimCandidate | null> {
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
      taskId: tasks.id,
      runtime: effectiveRuntime,
      model: sql<string>`coalesce(${repositories.defaultModel}, ${DEFAULT_EXECUTION_MODEL})`,
      approvedRevisionId: tasks.approvedRevisionId,
    })
    .from(tasks)
    .innerJoin(repositories, eq(repositories.id, tasks.repositoryId))
    .leftJoin(busy, eq(busy.repositoryId, repositories.id))
    .where(
      and(
        eq(tasks.state, "READY"),
        noLiveExecution(tx),
        capabilityMatches(tx, input.workerId),
        sql`coalesce(${busy.n}, 0) < ${repositories.maxConcurrentWorktrees}`,
        inArray(effectiveRuntime, [...input.runtimes]),
      ),
    )
    .orderBy(asc(tasks.jiraPriority), asc(tasks.jiraCreatedAt), asc(tasks.id))
    .limit(1)
    .for("update", { of: tasks, skipLocked: true });

  return row ?? null;
}

/** `max(attempt) + 1` over the task's executions of `role`, 1 when none (G5). */
export async function nextExecutionAttempt(
  tx: Tx,
  taskId: string,
  role: "spec" | "implementation",
): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${executions.attempt}), 0)::int` })
    .from(executions)
    .where(and(eq(executions.taskId, taskId), eq(executions.role, role)));
  return (row?.max ?? 0) + 1;
}

export interface InsertQueuedExecutionInput {
  taskId: string;
  role: "spec" | "implementation";
  attempt: number;
  runtime: Runtime;
  model: string;
  specRevisionId: string | null;
  workerId: string;
  host: string;
}

/**
 * Inserts an execution in `QUEUED`, its creation state (§5.2). The caller
 * moves it on with `transition()`; nothing here writes a later state.
 */
export async function insertQueuedExecution(
  tx: Tx,
  input: InsertQueuedExecutionInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(executions)
    .values({ ...input, state: "QUEUED" })
    .returning({ id: executions.id });
  if (!row) throw new Error("insertQueuedExecution: insert returned no row");
  return row;
}

export interface ReplaceTaskLeaseInput {
  taskId: string;
  executionId: string;
  workerId: string;
  acquiredAt: Date;
  expiresAt: Date;
}

/**
 * Writes the task's lease (§4.2 `task_leases`, one per task), overwriting
 * a row the task already has only when that row's execution is not
 * `ASSIGNED` or `RUNNING`. Leases are not deleted when an execution ends,
 * so a task that returns to `READY` can still carry its ended execution's
 * lease, and that row is replaced. A lease held by a live execution is
 * never taken over: the call throws, so the caller's transaction rolls
 * back. Call only with the task row already locked, so the lease row is
 * locked after it (task-then-execution lock order); the execution state is
 * read, not locked.
 */
export async function replaceTaskLease(
  tx: Tx,
  input: ReplaceTaskLeaseInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(taskLeases)
    .values(input)
    .onConflictDoUpdate({
      target: taskLeases.taskId,
      set: {
        executionId: input.executionId,
        workerId: input.workerId,
        acquiredAt: input.acquiredAt,
        expiresAt: input.expiresAt,
      },
      setWhere: notExists(
        tx
          .select({ one: sql`1` })
          .from(executions)
          .where(
            and(
              eq(executions.id, taskLeases.executionId),
              inArray(executions.state, [...SLOT_HOLDING_STATES]),
            ),
          ),
      ),
    })
    .returning({ id: taskLeases.id });
  if (!row) {
    throw new Error(
      `replaceTaskLease: task ${input.taskId} lease is held by a live execution`,
    );
  }
  return row;
}

export interface RuntimeSkippedTask {
  taskId: string;
  jiraKey: string;
  runtime: Runtime;
}

/**
 * `READY` tasks this worker is capable of but will not claim because their
 * effective runtime is not among `runtimes` (§7.3), so the worker can log
 * each one. Read only.
 */
export async function listReadyTasksWithUndetectedRuntime(
  db: DbOrTx,
  input: { workerId: string; runtimes: readonly Runtime[] },
): Promise<RuntimeSkippedTask[]> {
  const conditions: SQL[] = [
    eq(tasks.state, "READY"),
    capabilityMatches(db, input.workerId),
  ];
  if (input.runtimes.length > 0) {
    conditions.push(not(inArray(effectiveRuntime, [...input.runtimes])));
  }

  return db
    .select({
      taskId: tasks.id,
      jiraKey: tasks.jiraKey,
      runtime: effectiveRuntime,
    })
    .from(tasks)
    .innerJoin(repositories, eq(repositories.id, tasks.repositoryId))
    .where(and(...conditions))
    .orderBy(asc(tasks.jiraPriority), asc(tasks.jiraCreatedAt), asc(tasks.id));
}
