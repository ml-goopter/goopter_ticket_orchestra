import fs from "node:fs/promises";
import {
  appendEvent,
  clearExecutionWorktree,
  listWorktreeCandidates,
  lockWorktreeCandidate,
  markWorktreeEvicted,
  type Db,
  type WorktreeCandidate,
  type WorktreeSweepClass,
} from "@orchestra/db";
import type { Logger } from "../logger.js";
import type { Phase } from "../tick.js";
import { WorktreeManager } from "../worktrees/manager.js";

/** §6.6 rules one and two: finished worktrees are kept for 24 hours. */
export const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;
/** §6.6 rule three: waiting worktrees are evicted after 14 idle days. */
export const IDLE_EVICTION_MS = 14 * 24 * 60 * 60 * 1000;

/** The `WorktreeManager` methods the sweeper uses. */
export type WorktreeOps = Pick<WorktreeManager, "remove" | "pushIfAhead">;

/** Percentage (0-100) of the filesystem holding `workspaceRoot` in use. */
export type DiskUsage = (workspaceRoot: string) => Promise<number>;

/**
 * `df`-style usage of the filesystem holding `root`: used blocks over the
 * blocks available to an unprivileged user plus the used ones.
 */
export const statfsUsagePct: DiskUsage = async (root) => {
  const stats = await fs.statfs(root);
  const used = stats.blocks - stats.bfree;
  const total = used + stats.bavail;
  return total === 0 ? 0 : (used / total) * 100;
};

export interface WorktreeSweeperOptions {
  /**
   * Defaults to a `WorktreeManager` on `config.workspaceRoot`. The repo
   * lock is per process, so any instance serialises with the runner's.
   */
  worktrees?: WorktreeOps;
  /** Defaults to `statfsUsagePct`. Tests inject a fake. */
  diskUsage?: DiskUsage;
}

export interface WorktreeSweepInput {
  db: Db;
  /** `config.host`: only executions whose `host` is this are swept. */
  host: string;
  workspaceRoot: string;
  /** `WORKER_DISK_HIGH_WATER_PCT`. */
  diskHighWaterPct: number;
  now: Date;
  logger: Logger;
}

/** What a candidate's rule does to it. */
type Action = "remove" | "evict";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * design.md §6.6, one pass. Rules in order, each over its own candidates:
 *
 * 1. task `DONE` or `CANCELLED`, execution ended over 24 h ago: remove.
 * 2. execution `FAILED`, no retry pending, ended over 24 h ago: remove.
 * 3. execution `WAITING_FOR_USER` or task `NEEDS_HUMAN`, idle over 14
 *    days: evict.
 * 4. disk usage of `workspaceRoot` above `diskHighWaterPct`: evict rule
 *    three's class oldest idle first, then remove rule two's class oldest
 *    ended first, with no age bound, until usage is no longer above.
 *
 * "Remove" deletes the worktree and local branch and clears
 * `worktree_path` (GOT.35 C7). "Evict" pushes the branch when ahead,
 * deletes the worktree and local branch, stamps `worktree_evicted_at`, and
 * appends `worktree.evicted`; the path and branch stay on the row for the
 * resume path. A candidate that fails is logged and the next one runs.
 */
export async function sweepWorktrees(
  input: WorktreeSweepInput,
  options: WorktreeSweeperOptions = {},
): Promise<void> {
  const { db, host, now, logger, workspaceRoot } = input;
  const worktrees =
    options.worktrees ?? new WorktreeManager({ workspaceRoot });
  const diskUsage = options.diskUsage ?? statfsUsagePct;

  /** Lists one class; a failed list is logged and yields nothing. */
  const list = async (
    kind: WorktreeSweepClass,
    before: Date | null,
  ): Promise<WorktreeCandidate[]> => {
    try {
      return await listWorktreeCandidates(db, { host, kind, before });
    } catch (err) {
      logger.error({ kind, err: errMessage(err) }, "worktree candidate list failed");
      return [];
    }
  };

  /**
   * Applies `action` to one candidate under the task and execution row
   * locks, re-checking its rule first. Returns true when the worktree was
   * removed. Never throws.
   */
  const apply = async (
    candidate: WorktreeCandidate,
    kind: WorktreeSweepClass,
    before: Date | null,
    action: Action,
  ): Promise<boolean> => {
    const fields = {
      executionId: candidate.executionId,
      taskId: candidate.taskId,
      kind,
      action,
    };
    try {
      const outcome = await db.transaction(async (tx) => {
        const row = await lockWorktreeCandidate(tx, {
          host,
          kind,
          before,
          executionId: candidate.executionId,
          taskId: candidate.taskId,
        });
        if (!row) return null;
        if (row.repositoryName === null || row.defaultBranch === null) {
          throw new Error("execution's task has no repository");
        }

        let pushed = false;
        if (action === "evict" && row.branch !== null) {
          const push = await worktrees.pushIfAhead({
            repositoryName: row.repositoryName,
            branch: row.branch,
            defaultBranch: row.defaultBranch,
          });
          if (push.reason === "diverged") return { diverged: true, ahead: push.ahead };
          pushed = push.pushed;
        }

        await worktrees.remove(row.executionId, {
          repositoryName: row.repositoryName,
          branch: row.branch,
        });
        if (action === "remove") {
          await clearExecutionWorktree(tx, row.executionId);
        } else {
          await markWorktreeEvicted(tx, row.executionId, now);
          await appendEvent(tx, {
            taskId: row.taskId,
            executionId: row.executionId,
            type: "worktree.evicted",
            payload: {
              execution_id: row.executionId,
              branch: row.branch,
              pushed,
            },
          });
        }
        return { diverged: false, pushed };
      });

      if (outcome === null) return false;
      if (outcome.diverged) {
        // Removing the local branch would lose commits the remote lacks.
        logger.warn(
          { ...fields, branch: candidate.branch, ahead: outcome.ahead },
          "remote branch diverged, worktree kept",
        );
        return false;
      }
      logger.info(
        { ...fields, ...(action === "evict" ? { pushed: outcome.pushed } : {}) },
        action === "evict" ? "worktree evicted" : "worktree removed",
      );
      return true;
    } catch (err) {
      logger.error({ ...fields, err: errMessage(err) }, "worktree sweep failed");
      return false;
    }
  };

  const retention = new Date(now.getTime() - FINISHED_RETENTION_MS);
  const idleCutoff = new Date(now.getTime() - IDLE_EVICTION_MS);
  const rules: Array<[WorktreeSweepClass, Date, Action]> = [
    ["finished", retention, "remove"],
    ["failed", retention, "remove"],
    ["idle", idleCutoff, "evict"],
  ];
  for (const [kind, before, action] of rules) {
    for (const candidate of await list(kind, before)) {
      await apply(candidate, kind, before, action);
    }
  }

  // Rule four.
  const threshold = input.diskHighWaterPct;
  try {
    let usage = await diskUsage(workspaceRoot);
    if (usage <= threshold) return;
    logger.warn({ usage, threshold }, "workspace disk above high water, evicting");

    const pressure: Array<[WorktreeSweepClass, Action]> = [
      ["idle", "evict"],
      ["failed", "remove"],
    ];
    for (const [kind, action] of pressure) {
      for (const candidate of await list(kind, null)) {
        if (!(await apply(candidate, kind, null, action))) continue;
        usage = await diskUsage(workspaceRoot);
        if (usage <= threshold) return;
      }
    }
    logger.warn({ usage, threshold }, "workspace disk still above high water");
  } catch (err) {
    logger.error({ err: errMessage(err) }, "disk high-water check failed");
  }
}

/**
 * The `worktree_sweeper` tick phase (§6.6). Its cadence, `every`, is set
 * by the phase registry.
 */
export function createWorktreeSweeperPhase(
  options: WorktreeSweeperOptions = {},
): Phase {
  return {
    name: "worktree_sweeper",
    run: async (ctx) => {
      await sweepWorktrees(
        {
          db: ctx.db,
          host: ctx.config.host,
          workspaceRoot: ctx.config.workspaceRoot,
          diskHighWaterPct: ctx.config.diskHighWaterPct,
          now: ctx.now,
          logger: ctx.logger,
        },
        options,
      );
    },
  };
}
