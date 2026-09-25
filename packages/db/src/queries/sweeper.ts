import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agentWorkers, executions, taskLeases } from "../schema/executions.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";

/**
 * Queries behind the worker's lease sweeper phase (design.md §6.5) and the
 * dead-host command release (§6.1). The worker may not import drizzle, so
 * every statement lives here. Lock order everywhere: task row, then
 * execution row, then lease row.
 */

/** Execution states a lease is live for (§6.5). */
const LEASED_STATES = ["ASSIGNED", "RUNNING"] as const;

/**
 * Execution states whose commands a dead host strands (§6.1). `ASSIGNED`
 * and `RUNNING` on a dead host are the lease sweeper's, not the release's.
 */
const RELEASABLE_STATES = ["WAITING_FOR_USER", "COMPLETED"] as const;

/** One `task_leases` row whose execution is still live. */
export interface ExpiredLease {
  leaseId: string;
  taskId: string;
  executionId: string;
  /** The worker that held the lease, not the sweeping worker. */
  workerId: string;
  expiresAt: Date;
}

/**
 * Leases with `expires_at < now` whose execution is `ASSIGNED` or `RUNNING`
 * (§6.5), oldest expiry first. Read without locks: each is re-checked
 * under `lockExpiredLease` before anything is written. Leases of ended
 * executions stay in the table until the next claim replaces them, and are
 * not returned.
 */
export async function listExpiredLiveLeases(
  db: DbOrTx,
  now: Date,
): Promise<ExpiredLease[]> {
  return db
    .select({
      leaseId: taskLeases.id,
      taskId: taskLeases.taskId,
      executionId: taskLeases.executionId,
      workerId: taskLeases.workerId,
      expiresAt: taskLeases.expiresAt,
    })
    .from(taskLeases)
    .innerJoin(executions, eq(executions.id, taskLeases.executionId))
    .where(
      and(
        lt(taskLeases.expiresAt, now),
        inArray(executions.state, [...LEASED_STATES]),
      ),
    )
    .orderBy(asc(taskLeases.expiresAt), asc(taskLeases.id));
}

export interface LockExpiredLeaseInput {
  leaseId: string;
  taskId: string;
  executionId: string;
  now: Date;
}

/**
 * Locks the task row, then the execution row, then the lease row, each
 * `FOR UPDATE SKIP LOCKED`, and re-checks under those locks that the lease
 * still belongs to the execution, is still expired at `now`, and that the
 * execution is still `ASSIGNED` or `RUNNING`. Returns the lease as locked,
 * or null when any row is gone, locked by another transaction (a
 * concurrent sweeper or a transition in flight; retried next tick), or no
 * longer qualifies (the runner renewed or ended it after the select).
 */
export async function lockExpiredLease(
  tx: Tx,
  input: LockExpiredLeaseInput,
): Promise<ExpiredLease | null> {
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .for("update", { skipLocked: true });
  if (!task) return null;

  const [execution] = await tx
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.id, input.executionId),
        eq(executions.taskId, input.taskId),
        inArray(executions.state, [...LEASED_STATES]),
      ),
    )
    .for("update", { skipLocked: true });
  if (!execution) return null;

  const [lease] = await tx
    .select({
      leaseId: taskLeases.id,
      taskId: taskLeases.taskId,
      executionId: taskLeases.executionId,
      workerId: taskLeases.workerId,
      expiresAt: taskLeases.expiresAt,
    })
    .from(taskLeases)
    .where(
      and(
        eq(taskLeases.id, input.leaseId),
        eq(taskLeases.taskId, input.taskId),
        eq(taskLeases.executionId, input.executionId),
        lt(taskLeases.expiresAt, input.now),
      ),
    )
    .for("update", { skipLocked: true });
  return lease ?? null;
}

/** Deletes one `task_leases` row (§6.5). */
export async function deleteLease(tx: Tx, leaseId: string): Promise<void> {
  await tx.delete(taskLeases).where(eq(taskLeases.id, leaseId));
}

export interface DeadHostInput {
  now: Date;
  /** A host is dead when its heartbeat is older than `now - thresholdMs`. */
  thresholdMs: number;
  /** The calling worker. Its own host is never dead. */
  excludeWorkerId: string;
}

const deadHostCondition = (input: DeadHostInput) =>
  and(
    lt(
      agentWorkers.lastHeartbeatAt,
      new Date(input.now.getTime() - input.thresholdMs),
    ),
    ne(agentWorkers.id, input.excludeWorkerId),
  );

/**
 * Hosts whose `agent_workers.last_heartbeat_at` is older than
 * `now - thresholdMs` (§6.1), excluding the calling worker's own row.
 */
export async function listDeadHosts(
  db: DbOrTx,
  input: DeadHostInput,
): Promise<string[]> {
  const rows = await db
    .select({ host: agentWorkers.host })
    .from(agentWorkers)
    .where(deadHostCondition(input))
    .orderBy(asc(agentWorkers.host));
  return rows.map((row) => row.host);
}

/** One execution whose host pin was cleared. */
export interface ReleasedExecution {
  executionId: string;
  taskId: string;
  /** The dead host it was pinned to. */
  host: string;
}

export interface ReleaseExecutionsInput extends DeadHostInput {
  hosts: readonly string[];
}

/**
 * Clears `host` and `worker_id` on `WAITING_FOR_USER` and `COMPLETED`
 * executions pinned to one of `hosts` (§6.1), so any worker may take their
 * commands. One transaction per execution: task row, then execution row,
 * both `FOR UPDATE SKIP LOCKED` (a locked row is retried next tick), then
 * the update re-checks the state, the pin, and that the host is still dead
 * under the same rule as `listDeadHosts`. Writes no event and no audit row:
 * no state moves. Returns what was released.
 */
export async function releaseExecutionsOnDeadHosts(
  db: Db,
  input: ReleaseExecutionsInput,
): Promise<ReleasedExecution[]> {
  if (input.hosts.length === 0) return [];

  const candidates = await db
    .select({
      executionId: executions.id,
      taskId: executions.taskId,
      host: sql<string>`${executions.host}`,
    })
    .from(executions)
    .where(
      and(
        inArray(executions.host, [...input.hosts]),
        inArray(executions.state, [...RELEASABLE_STATES]),
      ),
    )
    .orderBy(asc(executions.id));

  const stillDead = db
    .select({ host: agentWorkers.host })
    .from(agentWorkers)
    .where(deadHostCondition(input));

  const released: ReleasedExecution[] = [];
  for (const candidate of candidates) {
    const done = await db.transaction(async (tx) => {
      const [task] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, candidate.taskId))
        .for("update", { skipLocked: true });
      if (!task) return false;

      const [execution] = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(eq(executions.id, candidate.executionId))
        .for("update", { skipLocked: true });
      if (!execution) return false;

      const rows = await tx
        .update(executions)
        .set({ host: null, workerId: null })
        .where(
          and(
            eq(executions.id, candidate.executionId),
            eq(executions.host, candidate.host),
            inArray(executions.state, [...RELEASABLE_STATES]),
            inArray(executions.host, stillDead),
          ),
        )
        .returning({ id: executions.id });
      return rows.length > 0;
    });
    if (done) released.push(candidate);
  }
  return released;
}
