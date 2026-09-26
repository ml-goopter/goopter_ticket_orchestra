import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../client.js";
import { executionEvents } from "../schema/events.js";
import { agentWorkers, executions, taskLeases } from "../schema/executions.js";
import { repositories } from "../schema/projects.js";
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
  /**
   * Called for each candidate after the unlocked select and before its
   * transaction opens. Tests use it to interleave a heartbeat or a state
   * move; production passes nothing.
   */
  beforeRelease?: (candidate: ReleasedExecution) => Promise<void>;
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
    await input.beforeRelease?.(candidate);
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

// ------------------------------------------------------ worktree sweeper

/**
 * Candidate classes of the worktree sweeper (design.md §6.6), one per rule
 * that selects executions:
 *
 * - `finished`: rule one. Task `DONE` or `CANCELLED`, execution ended.
 * - `failed`: rule two. Execution `FAILED` and ended, no retry pending: no
 *   execution of the task is `QUEUED`, `ASSIGNED`, `RUNNING` or
 *   `WAITING_FOR_USER`, and the task is not `READY` (GOT.35 C8).
 * - `idle`: rule three. Execution `WAITING_FOR_USER`, or its task
 *   `NEEDS_HUMAN`, and the execution is not live.
 *
 * Rule four (disk high water) reuses `idle` and `failed` with no age bound.
 */
export type WorktreeSweepClass = "finished" | "failed" | "idle";

/** Execution states the sweeper never touches (§6.6 rule four). */
const WORKTREE_LIVE_STATES = ["QUEUED", "ASSIGNED", "RUNNING"] as const;

/** Execution states that mean a retry of the task is pending (C8). */
const RETRY_PENDING_STATES = [
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_USER",
] as const;

export interface WorktreeCandidateFilter {
  /** `executions.host`: only worktrees on this host. */
  host: string;
  kind: WorktreeSweepClass;
  /**
   * Only rows whose `since` is strictly before this instant. Null for no
   * age bound (rule four).
   */
  before: Date | null;
}

/** One execution whose worktree a sweeper rule selects. */
export interface WorktreeCandidate {
  executionId: string;
  taskId: string;
  worktreePath: string;
  branch: string | null;
  /** Null when the task has no repository; the sweeper cannot remove it. */
  repositoryName: string | null;
  defaultBranch: string | null;
  /**
   * The age the rule measures. `ended_at` for `finished` and `failed`. For
   * `idle`, executions have no `updated_at`, so it is the newest
   * `execution_events.created_at` of the execution, else `ended_at`, else
   * `started_at`, else `created_at`.
   */
  since: Date;
}

const siblings = alias(executions, "sibling");

function sinceExpression(kind: WorktreeSweepClass): SQL<Date> {
  if (kind !== "idle") {
    return sql<Date>`${executions.endedAt}`.mapWith(executions.endedAt);
  }
  // `task_id` is in the predicate so the (task_id, id) index serves it.
  const lastEvent = sql`(select max(${executionEvents.createdAt}) from ${executionEvents} where ${executionEvents.taskId} = ${executions.taskId} and ${executionEvents.executionId} = ${executions.id})`;
  return sql<Date>`coalesce(${lastEvent}, ${executions.endedAt}, ${executions.startedAt}, ${executions.createdAt})`.mapWith(
    executions.endedAt,
  );
}

function kindCondition(db: DbOrTx, kind: WorktreeSweepClass): SQL | undefined {
  switch (kind) {
    case "finished":
      return and(
        inArray(tasks.state, ["DONE", "CANCELLED"]),
        isNotNull(executions.endedAt),
      );
    case "failed":
      return and(
        eq(executions.state, "FAILED"),
        isNotNull(executions.endedAt),
        ne(tasks.state, "READY"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(siblings)
            .where(
              and(
                eq(siblings.taskId, executions.taskId),
                inArray(siblings.state, [...RETRY_PENDING_STATES]),
              ),
            ),
        ),
      );
    case "idle":
      return or(
        eq(executions.state, "WAITING_FOR_USER"),
        eq(tasks.state, "NEEDS_HUMAN"),
      );
  }
}

function candidateQuery(db: DbOrTx, filter: WorktreeCandidateFilter, extra?: SQL) {
  const since = sinceExpression(filter.kind);
  return db
    .select({
      executionId: executions.id,
      taskId: executions.taskId,
      worktreePath: sql<string>`${executions.worktreePath}`,
      branch: executions.branch,
      repositoryName: repositories.name,
      defaultBranch: repositories.defaultBranch,
      since,
    })
    .from(executions)
    .innerJoin(tasks, eq(tasks.id, executions.taskId))
    .leftJoin(repositories, eq(repositories.id, tasks.repositoryId))
    .where(
      and(
        eq(executions.host, filter.host),
        isNotNull(executions.worktreePath),
        isNull(executions.worktreeEvictedAt),
        notInArray(executions.state, [...WORKTREE_LIVE_STATES]),
        kindCondition(db, filter.kind),
        filter.before === null
          ? sql`${since} is not null`
          : sql`${since} < ${filter.before.toISOString()}::timestamptz`,
        extra,
      ),
    )
    .orderBy(asc(since), asc(executions.id));
}

/**
 * Executions on `filter.host` whose worktree is still present and not
 * evicted, matching `filter.kind` and older than `filter.before`, oldest
 * `since` first. Read without locks: each is re-checked under
 * `lockWorktreeCandidate` before anything is removed.
 */
export async function listWorktreeCandidates(
  db: DbOrTx,
  filter: WorktreeCandidateFilter,
): Promise<WorktreeCandidate[]> {
  return candidateQuery(db, filter);
}

export interface LockWorktreeCandidateInput extends WorktreeCandidateFilter {
  executionId: string;
  taskId: string;
}

/**
 * Locks the task row, then the execution row, both `FOR UPDATE SKIP
 * LOCKED`, and re-evaluates the candidate's rule under those locks.
 * Returns the candidate, or null when a row is gone, locked by another
 * transaction (retried on the next sweep), or no longer qualifies. Holding
 * the task lock keeps a resume, a claim or a cancel from moving the
 * execution while its worktree is removed.
 */
export async function lockWorktreeCandidate(
  tx: Tx,
  input: LockWorktreeCandidateInput,
): Promise<WorktreeCandidate | null> {
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
      ),
    )
    .for("update", { skipLocked: true });
  if (!execution) return null;

  const [row] = await candidateQuery(
    tx,
    { host: input.host, kind: input.kind, before: input.before },
    eq(executions.id, input.executionId),
  );
  return row ?? null;
}

/**
 * Rules one and two (GOT.35 C7): the worktree is gone, so clear
 * `worktree_path` and the execution stops being a candidate. `branch` is
 * kept as history. Writes no event.
 */
export async function clearExecutionWorktree(
  tx: Tx,
  executionId: string,
): Promise<void> {
  await tx
    .update(executions)
    .set({ worktreePath: null })
    .where(eq(executions.id, executionId));
}

/**
 * Rule three: stamps `worktree_evicted_at`. `worktree_path` and `branch`
 * are kept; resume after eviction recreates the worktree from the remote
 * branch (§6.6).
 */
export async function markWorktreeEvicted(
  tx: Tx,
  executionId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(executions)
    .set({ worktreeEvictedAt: now })
    .where(eq(executions.id, executionId));
}
