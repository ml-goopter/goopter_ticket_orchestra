import {
  deleteLease,
  listDeadHosts,
  listExpiredLiveLeases,
  lockExpiredLease,
  releaseExecutionsOnDeadHosts,
  transition,
  type Db,
  type ExpiredLease,
  type ReleasedExecution,
} from "@orchestra/db";
import type { Logger } from "../logger.js";
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
 * expired before `now` and deletes the lease, one transaction per lease.
 * The task is left as it is: the retry policy (§9.5) is GOT.43's (Q10).
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

        await transition(tx, {
          entity: "execution",
          id: lease.executionId,
          trigger: "execution.failed",
          actor: { kind: "worker", id: workerId },
          set: {
            endReason: "lease_expired",
            endDetail: `lease expired at ${lease.expiresAt.toISOString()}, held by worker ${lease.workerId}`,
            endedAt: now,
            // §8: the agent-tools token is revoked when the execution
            // leaves RUNNING.
            toolsTokenHash: null,
          },
        });
        await deleteLease(tx, lease.leaseId);
        return lease;
      });
      if (!swept) continue;

      failed.push(swept.executionId);
      logger.warn(
        {
          taskId: swept.taskId,
          executionId: swept.executionId,
          leaseWorkerId: swept.workerId,
          expiresAt: swept.expiresAt.toISOString(),
        },
        "lease expired, execution failed; task awaits the retry policy",
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
 * design.md §6.1 dead-host release. Clears `host` and `worker_id` on
 * `WAITING_FOR_USER` and `COMPLETED` executions pinned to a host whose
 * heartbeat is older than `DEAD_HOST_AFTER_MS`, so any worker may take
 * their commands. This worker's host is never dead. Writes no event.
 * Returns the execution ids released.
 */
export async function releaseDeadHostExecutions(
  input: SweepInput,
  options: LeaseSweeperOptions = {},
): Promise<string[]> {
  const { db, workerId, now, logger } = input;
  const deadHost = { now, thresholdMs: DEAD_HOST_AFTER_MS, excludeWorkerId: workerId };

  const hosts = await listDeadHosts(db, deadHost);
  if (hosts.length === 0) return [];

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
 * §6.1 dead-host release. A failure of the release is logged and does not
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
