import {
  deleteLease,
  listDeadHosts,
  listExpiredLiveLeases,
  listOrphanedSpecExecutions,
  lockExpiredLease,
  lockOrphanedSpecExecution,
  releaseExecutionsOnDeadHosts,
  transition,
  type Db,
  type ExpiredLease,
  type ReleasedExecution,
} from "@orchestra/db";
import type { Logger } from "../logger.js";
import { runFailurePolicy } from "../runner/retry.js";
import type { Phase } from "../tick.js";

export type { ExpiredLease } from "@orchestra/db";
export * from "./worktrees.js";

/** §6.1: a host that has not heartbeated for 15 minutes is dead. */
export const DEAD_HOST_AFTER_MS = 15 * 60 * 1000;

export interface LeaseSweeperOptions {
  /**
   * Called for each expired lease after the unlocked select and before its
   * transaction opens. A throw fails that lease only. Tests use it to
   * interleave a renewal or force an error; production passes nothing.
   */
  beforeLock?: (lease: ExpiredLease) => Promise<void>;
  /**
   * Called for each dead-host release candidate after the unlocked selects
   * and before its transaction opens. Tests use it to interleave a
   * heartbeat or a state move; production passes nothing.
   */
  beforeRelease?: (candidate: ReleasedExecution) => Promise<void>;
}

export interface SweepInput {
  db: Db;
  /** The sweeping worker: the transition's actor, never treated as dead. */
  workerId: string;
  now: Date;
  logger: Logger;
}

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * design.md §6.5. Fails every `ASSIGNED` or `RUNNING` execution whose lease
 * expired before `now`, deletes the lease and applies the §9.5 retry policy,
 * one transaction per lease: below `max_infra_retries` a retry execution
 * with no host is queued for any worker, otherwise the task is escalated.
 * The worktree stays on the dead host. A lease that fails is logged and
 * the next one still runs. Returns the execution ids failed.
 */
export async function sweepExpiredLeases(
  input: SweepInput,
  options: LeaseSweeperOptions = {},
): Promise<string[]> {
  const { db, workerId, now, logger } = input;
  const failed: string[] = [];

  for (const candidate of await listExpiredLiveLeases(db, now)) {
    try {
      await options.beforeLock?.(candidate);
      const swept = await db.transaction(async (tx) => {
        const lease = await lockExpiredLease(tx, {
          leaseId: candidate.leaseId,
          taskId: candidate.taskId,
          executionId: candidate.executionId,
          now,
        });
        if (!lease) return null;

        const actor = { kind: "worker" as const, id: workerId };
        const endDetail = `lease expired at ${lease.expiresAt.toISOString()}, held by worker ${lease.workerId}`;
        await transition(tx, {
          entity: "execution",
          id: lease.executionId,
          trigger: "execution.failed",
          actor,
          set: {
            endReason: "lease_expired",
            endDetail,
            endedAt: now,
            // §8: the agent-tools token is revoked when the execution
            // leaves RUNNING.
            toolsTokenHash: null,
          },
        });
        await deleteLease(tx, lease.leaseId);
        // Task, then execution, are locked by `lockExpiredLease`.
        const outcome = await runFailurePolicy(tx, {
          executionId: lease.executionId,
          endReason: "lease_expired",
          endDetail,
          actor,
          now,
          logger,
        });
        return { lease, outcome: outcome.kind };
      });
      if (!swept) continue;

      failed.push(swept.lease.executionId);
      logger.warn(
        {
          taskId: swept.lease.taskId,
          executionId: swept.lease.executionId,
          leaseWorkerId: swept.lease.workerId,
          expiresAt: swept.lease.expiresAt.toISOString(),
          retryPolicy: swept.outcome,
        },
        "lease expired, execution failed; retry policy applied",
      );
    } catch (err) {
      logger.error(
        {
          taskId: candidate.taskId,
          executionId: candidate.executionId,
          err: errMessage(err),
        },
        "lease sweep failed",
      );
    }
  }
  return failed;
}

/**
 * GOT.37 C48: fails every ASSIGNED spec execution pinned to a dead host
 * with `process_crash`. Spec sessions hold no lease, so the lease pass
 * never sees one whose host died between the `start_spec_session` commit
 * and the session start. Same transaction shape as the lease pass, one per
 * execution: task row then execution row locked, `execution.failed` with
 * the token revoked, then the §9.5 retry policy, which for a spec
 * execution only notifies. A failure is logged and the next one still
 * runs. Returns the execution ids failed.
 */
export async function failOrphanedSpecExecutions(input: SweepInput): Promise<string[]> {
  const { db, workerId, now, logger } = input;
  const deadHost = { now, thresholdMs: DEAD_HOST_AFTER_MS, excludeWorkerId: workerId };
  const failed: string[] = [];

  for (const candidate of await listOrphanedSpecExecutions(db, deadHost)) {
    try {
      const swept = await db.transaction(async (tx) => {
        const row = await lockOrphanedSpecExecution(tx, {
          ...deadHost,
          executionId: candidate.executionId,
          taskId: candidate.taskId,
        });
        if (!row) return null;

        const actor = { kind: "worker" as const, id: workerId };
        const endDetail = `host ${row.host} stopped heartbeating before the spec session started`;
        await transition(tx, {
          entity: "execution",
          id: row.executionId,
          trigger: "execution.failed",
          actor,
          set: {
            endReason: "process_crash",
            endDetail,
            endedAt: now,
            // §8: the agent-tools token is revoked when the execution
            // leaves RUNNING.
            toolsTokenHash: null,
          },
        });
        // Task, then execution, are locked by `lockOrphanedSpecExecution`.
        const outcome = await runFailurePolicy(tx, {
          executionId: row.executionId,
          endReason: "process_crash",
          endDetail,
          actor,
          now,
          logger,
        });
        return { row, outcome: outcome.kind };
      });
      if (!swept) continue;

      failed.push(swept.row.executionId);
      logger.warn(
        {
          taskId: swept.row.taskId,
          executionId: swept.row.executionId,
          host: swept.row.host,
          retryPolicy: swept.outcome,
        },
        "spec execution orphaned on a dead host, failed; retry policy applied",
      );
    } catch (err) {
      logger.error(
        { taskId: candidate.taskId, executionId: candidate.executionId, err: errMessage(err) },
        "orphaned spec execution sweep failed",
      );
    }
  }
  return failed;
}

/**
 * design.md §6.1 dead-host release. First fails orphaned ASSIGNED spec
 * executions on dead hosts (C48). Then clears `host` and `worker_id` on
 * `WAITING_FOR_USER` and `COMPLETED` executions pinned to a host whose
 * heartbeat is older than `DEAD_HOST_AFTER_MS`, so any worker may take
 * their commands. This worker's host is never dead. The release writes no
 * event. Returns the execution ids released.
 */
export async function releaseDeadHostExecutions(
  input: SweepInput,
  options: LeaseSweeperOptions = {},
): Promise<string[]> {
  const { db, workerId, now, logger } = input;
  const deadHost = { now, thresholdMs: DEAD_HOST_AFTER_MS, excludeWorkerId: workerId };

  const hosts = await listDeadHosts(db, deadHost);
  if (hosts.length === 0) return [];

  await failOrphanedSpecExecutions(input);

  const released = await releaseExecutionsOnDeadHosts(db, {
    ...deadHost,
    hosts,
    ...(options.beforeRelease ? { beforeRelease: options.beforeRelease } : {}),
  });
  for (const row of released) {
    logger.info(
      { executionId: row.executionId, taskId: row.taskId, host: row.host },
      "released execution from dead host",
    );
  }
  return released.map((row) => row.executionId);
}

/**
 * The `lease_sweeper` tick phase, every tick: the §6.5 lease pass, then the
 * §6.1 dead-host pass (orphaned ASSIGNED spec executions failed, C48, then
 * the release). A failure of the release is logged and does not
 * undo the lease pass, which committed per lease.
 */
export function createLeaseSweeperPhase(
  options: LeaseSweeperOptions = {},
): Phase {
  return {
    name: "lease_sweeper",
    run: async (ctx) => {
      const input: SweepInput = {
        db: ctx.db,
        workerId: ctx.workerId,
        now: ctx.now,
        logger: ctx.logger,
      };
      await sweepExpiredLeases(input, options);
      try {
        await releaseDeadHostExecutions(input, options);
      } catch (err) {
        ctx.logger.error({ err: errMessage(err) }, "dead-host release failed");
      }
    },
  };
}
