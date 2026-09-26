import type { ExecutionState, TaskState } from "@orchestra/core";
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { agentWorkers, executionCommands, executions } from "../schema/executions.js";
import { repositories } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";
import type { RepositoryRow } from "./task-aggregate.js";

/**
 * Queries behind the worker's spec role (design.md §5.2, §9.1, §9.3, D8):
 * the `start_spec_session` handler, the runner's spec-session abort check,
 * the dead-host pass for orphaned spec sessions (GOT.37 C48), and the
 * worktree sweeper's approved-spec rule (C46). The worker may
 * not import drizzle, so every statement lives here; the worker owns the
 * transaction boundaries and calls `transition()` for every state move.
 *
 * Lock order: task row, then execution row.
 */

/** Execution states that are not ended (§5.2): a live spec session. */
const LIVE_SPEC_STATES = ["QUEUED", "ASSIGNED", "RUNNING", "WAITING_FOR_USER"] as const;

/** Task states in which a spec worktree is still in use (C46). */
const SPEC_WORKTREE_TASK_STATES = ["NEEDS_SPEC", "SPEC_IN_PROGRESS", "SPEC_REVIEW"] as const;

export interface LockedSpecStartTask {
  state: TaskState;
  projectId: string;
  repositoryId: string | null;
}

/**
 * Locks the task row `FOR UPDATE` and reads what the `start_spec_session`
 * handler decides on. Call it first in the transaction. `null` when the task
 * does not exist.
 */
export async function lockTaskForSpecStart(
  tx: Tx,
  taskId: string,
): Promise<LockedSpecStartTask | null> {
  const [row] = await tx
    .select({
      state: tasks.state,
      projectId: tasks.projectId,
      repositoryId: tasks.repositoryId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update");
  return row ?? null;
}

/**
 * True when the task has a spec execution in `QUEUED`, `ASSIGNED`,
 * `RUNNING` or `WAITING_FOR_USER`. Call with the task row locked: every
 * spec execution is created under that lock, so the answer holds until
 * commit.
 */
export async function hasLiveSpecExecution(tx: Tx, taskId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.taskId, taskId),
        eq(executions.role, "spec"),
        inArray(executions.state, [...LIVE_SPEC_STATES]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * True when the task has an uncompleted `send_message` command on a
 * `COMPLETED` spec execution: a send-back (C45) is about to resume that
 * session, so a new one must not start (GOT.37 F1). Call with the task row
 * locked.
 */
export async function hasPendingSpecResume(tx: Tx, taskId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .innerJoin(executions, eq(executions.id, executionCommands.executionId))
    .where(
      and(
        eq(executionCommands.taskId, taskId),
        eq(executionCommands.type, "send_message"),
        isNull(executionCommands.completedAt),
        eq(executions.role, "spec"),
        eq(executions.state, "COMPLETED"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The repository a spec session explores (GOT.37 C41): the task's
 * repository when set, else the project's repositories ordered by name,
 * the first one. Before approval a task may have no repository. `null` when
 * the task is gone or its project has no repository.
 */
export async function resolveSpecRepository(
  db: DbOrTx,
  taskId: string,
): Promise<RepositoryRow | null> {
  const [task] = await db
    .select({ projectId: tasks.projectId, repositoryId: tasks.repositoryId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task) return null;
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      task.repositoryId !== null
        ? eq(repositories.id, task.repositoryId)
        : eq(repositories.projectId, task.projectId),
    )
    .orderBy(asc(repositories.name), asc(repositories.id))
    .limit(1);
  return row ?? null;
}

/** An execution's current state, unlocked. `null` when it is gone. */
export async function getExecutionState(
  db: DbOrTx,
  executionId: string,
): Promise<ExecutionState | null> {
  const [row] = await db
    .select({ state: executions.state })
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);
  return row?.state ?? null;
}

// ------------------------------------ orphaned spec sessions (C48)

/** An ASSIGNED spec execution pinned to a dead host. */
export interface OrphanedSpecExecution {
  executionId: string;
  taskId: string;
  host: string;
}

export interface DeadHostSpecInput {
  now: Date;
  /** A host is dead when its heartbeat is older than `now - thresholdMs`. */
  thresholdMs: number;
  /** The calling worker. Its own host is never dead. */
  excludeWorkerId: string;
}

/** Hosts of `agent_workers` rows that are dead under `input` (§6.1). */
const deadHosts = (db: DbOrTx, input: DeadHostSpecInput) =>
  db
    .select({ host: agentWorkers.host })
    .from(agentWorkers)
    .where(
      and(
        lt(agentWorkers.lastHeartbeatAt, new Date(input.now.getTime() - input.thresholdMs)),
        ne(agentWorkers.id, input.excludeWorkerId),
      ),
    );

const orphanedSpecCondition = (db: DbOrTx, input: DeadHostSpecInput) =>
  and(
    eq(executions.role, "spec"),
    eq(executions.state, "ASSIGNED"),
    inArray(executions.host, deadHosts(db, input)),
  );

const orphanedColumns = {
  executionId: executions.id,
  taskId: executions.taskId,
  host: sql<string>`${executions.host}`,
};

/**
 * GOT.37 C48: ASSIGNED spec executions pinned to a dead host. Spec sessions
 * hold no lease (§6.4), so the lease pass never fails one whose host died
 * before its session started. Read without locks: each is re-checked under
 * `lockOrphanedSpecExecution`.
 */
export async function listOrphanedSpecExecutions(
  db: DbOrTx,
  input: DeadHostSpecInput,
): Promise<OrphanedSpecExecution[]> {
  return db
    .select(orphanedColumns)
    .from(executions)
    .where(orphanedSpecCondition(db, input))
    .orderBy(asc(executions.id));
}

/**
 * Locks the task row, then the execution row, both `FOR UPDATE SKIP
 * LOCKED`, and re-checks that the execution is still an ASSIGNED spec
 * execution on a dead host. Null when a row is gone, locked by another
 * transaction (retried next tick), or no longer qualifies.
 */
export async function lockOrphanedSpecExecution(
  tx: Tx,
  input: DeadHostSpecInput & { executionId: string; taskId: string },
): Promise<OrphanedSpecExecution | null> {
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .for("update", { skipLocked: true });
  if (!task) return null;
  const [execution] = await tx
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.id, input.executionId), eq(executions.taskId, input.taskId)))
    .for("update", { skipLocked: true });
  if (!execution) return null;
  const [row] = await tx
    .select(orphanedColumns)
    .from(executions)
    .where(and(eq(executions.id, input.executionId), orphanedSpecCondition(tx, input)));
  return row ?? null;
}

// ------------------------------------------------ worktree sweeper (C46)

/** A `COMPLETED` spec execution whose task is past `SPEC_REVIEW`. */
export interface ApprovedSpecWorktree {
  executionId: string;
  taskId: string;
  worktreePath: string;
  /**
   * The task's repository, else the project's first by name (C41's rule).
   * Null when the project has none; the sweeper cannot remove it then.
   */
  repositoryName: string | null;
}

/** C41's repository rule as a scalar subquery on the joined task. */
const specRepositoryName = sql<string | null>`coalesce(
  (select r.name from ${repositories} r where r.id = ${tasks.repositoryId}),
  (select r.name from ${repositories} r where r.project_id = ${tasks.projectId} order by r.name, r.id limit 1)
)`;

function approvedSpecQuery(db: DbOrTx, host: string, executionId?: string) {
  return db
    .select({
      executionId: executions.id,
      taskId: executions.taskId,
      worktreePath: sql<string>`${executions.worktreePath}`,
      repositoryName: specRepositoryName,
    })
    .from(executions)
    .innerJoin(tasks, eq(tasks.id, executions.taskId))
    .where(
      and(
        eq(executions.host, host),
        eq(executions.role, "spec"),
        eq(executions.state, "COMPLETED"),
        isNotNull(executions.worktreePath),
        isNull(executions.worktreeEvictedAt),
        notInArray(tasks.state, [...SPEC_WORKTREE_TASK_STATES]),
        executionId === undefined ? undefined : eq(executions.id, executionId),
      ),
    )
    .orderBy(asc(executions.endedAt), asc(executions.id));
}

/**
 * C46: `COMPLETED` spec executions on `host` whose worktree is present and
 * whose task is past `SPEC_REVIEW` (any state but `NEEDS_SPEC`,
 * `SPEC_IN_PROGRESS`, `SPEC_REVIEW`). No age bound. Read without locks:
 * each is re-checked under `lockApprovedSpecWorktree`.
 */
export async function listApprovedSpecWorktrees(
  db: DbOrTx,
  host: string,
): Promise<ApprovedSpecWorktree[]> {
  return approvedSpecQuery(db, host);
}

/**
 * Locks the task row, then the execution row, both `FOR UPDATE SKIP
 * LOCKED`, and re-checks the rule under those locks. Null when a row is
 * gone, locked by another transaction (retried next sweep), or no longer
 * qualifies: a send-back that resumed the execution, for example.
 */
export async function lockApprovedSpecWorktree(
  tx: Tx,
  input: { host: string; executionId: string; taskId: string },
): Promise<ApprovedSpecWorktree | null> {
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .for("update", { skipLocked: true });
  if (!task) return null;
  const [execution] = await tx
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.id, input.executionId), eq(executions.taskId, input.taskId)))
    .for("update", { skipLocked: true });
  if (!execution) return null;
  const [row] = await approvedSpecQuery(tx, input.host, input.executionId);
  return row ?? null;
}
