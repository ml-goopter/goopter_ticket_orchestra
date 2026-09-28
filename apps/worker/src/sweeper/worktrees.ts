import fs from "node:fs/promises";
import {
  appendEvent,
  clearExecutionWorktree,
  listApprovedSpecWorktrees,
  listContainerExecutions,
  listWorktreeCandidates,
  lockApprovedSpecWorktree,
  lockContainerExecution,
  lockWorktreeCandidate,
  markWorktreeEvicted,
  type ApprovedSpecWorktree,
  type ContainerExecution,
  type Db,
  type WorktreeCandidate,
  type WorktreeSweepClass,
} from "@orchestra/db";
import type {
  ExecutionContainerOps,
  LabelledContainer,
} from "../containers/index.js";
import type { Logger } from "../logger.js";
import type { Phase } from "../tick.js";
import { WorktreeManager } from "../worktrees/manager.js";

/** §6.6 rules one and two: finished worktrees are kept for 24 hours. */
export const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;
/** §6.6 rule three: waiting worktrees are evicted after 14 idle days. */
export const IDLE_EVICTION_MS = 14 * 24 * 60 * 60 * 1000;

/** The `WorktreeManager` methods the sweeper uses. */
export type WorktreeOps = Pick<WorktreeManager, "withRepositoryLock" | "pushIfAhead">;

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
  /**
   * Agent containers (§9.9), normally `dockerExecutionContainers()`. Only a
   * worker with the `docker` capability passes it; omitted, the sweeper
   * touches no container.
   */
  containers?: ExecutionContainerOps;
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

/**
 * Execution states whose agent container the orphan pass removes: the
 * execution has ended (§9.9 "removed when the execution ends"). A
 * `COMPLETED` execution that is resumed later recreates its container.
 */
const CONTAINER_ENDED_STATES: ReadonlySet<ContainerExecution["state"]> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

/** What a candidate's rule does to it. */
type Action = "remove" | "evict";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * design.md §6.6, one pass. Rules in order, each over its own candidates:
 *
 * 0. a `COMPLETED` spec execution whose task is past `SPEC_REVIEW` (any
 *    state but `NEEDS_SPEC`, `SPEC_IN_PROGRESS`, `SPEC_REVIEW`): remove,
 *    with no age threshold (§9.1 "removed when the spec is approved",
 *    GOT.37 C46). The sweeper runs hourly, so removal can lag approval by
 *    up to an hour; that latency is accepted.
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
 *
 * With `options.containers`, whenever a rule removes or evicts a worktree,
 * the execution's agent container is removed too (§9.9 Removal). After rule three, the orphan
 * pass removes every container labelled `orchestra.execution` whose
 * execution has ended on this host or does not exist (§9.9 Orphans). A
 * container failure is logged and never blocks worktree cleanup.
 *
 * Lock order for one candidate: the per-repository lock of the worktree
 * manager, then the task row, then the execution row. The repository lock
 * is in-process, so Postgres cannot see a wait on it; taking it before the
 * row locks means the sweeper never holds a row while it waits behind a
 * fetch or push on the same repository. The runner never calls the manager
 * while holding a row lock, so the order is not inverted anywhere. The
 * container removal runs last, still holding the row locks, so a resume
 * cannot reuse the container while it is being removed. The orphan pass
 * takes the task row, then the execution row, and no repository lock.
 */
export async function sweepWorktrees(
  input: WorktreeSweepInput,
  options: WorktreeSweeperOptions = {},
): Promise<void> {
  const { db, host, now, logger, workspaceRoot } = input;
  const worktrees =
    options.worktrees ?? new WorktreeManager({ workspaceRoot });
  const diskUsage = options.diskUsage ?? statfsUsagePct;
  const containers = options.containers;

  /** Removes the execution's container. Logs a failure; never throws. */
  const removeContainer = async (
    executionId: string,
    fields: Record<string, unknown>,
  ): Promise<void> => {
    if (!containers) return;
    try {
      await containers.removeForExecution(executionId);
    } catch (err) {
      logger.warn({ ...fields, err: errMessage(err) }, "agent container removal failed");
    }
  };

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
   * Applies `action` to one candidate. An eviction pushes first, holding no
   * lock across the call. Then, holding the repository lock, a transaction
   * takes the task and execution row locks, re-checks the rule, requires
   * the branch to be the one pushed and its local tip unchanged since the
   * push, and only then removes the worktree and writes the row. A slow
   * push or a fetch by another caller delays the sweeper but never a
   * transition or a resume. Returns true when the worktree was removed.
   * Never throws.
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
      if (candidate.repositoryName === null || candidate.defaultBranch === null) {
        throw new Error("execution's task has no repository");
      }
      const repositoryName = candidate.repositoryName;

      let pushed = false;
      /** Local tip the push saw; `undefined` when nothing was pushed or checked. */
      let expectedTip: string | null | undefined;
      if (action === "evict" && candidate.branch !== null) {
        const push = await worktrees.pushIfAhead({
          repositoryName,
          branch: candidate.branch,
          defaultBranch: candidate.defaultBranch,
        });
        if (push.reason === "diverged") {
          // Removing the local branch would lose commits the remote lacks.
          logger.warn(
            { ...fields, branch: candidate.branch, ahead: push.ahead },
            "remote branch diverged, worktree kept",
          );
          return false;
        }
        pushed = push.pushed;
        expectedTip = push.tip;
      }

      const outcome = await worktrees.withRepositoryLock(repositoryName, (repo) =>
        db.transaction(async (tx) => {
          const row = await lockWorktreeCandidate(tx, {
            host,
            kind,
            before,
            executionId: candidate.executionId,
            taskId: candidate.taskId,
          });
          if (!row) return "gone" as const;
          if (row.branch !== candidate.branch || row.repositoryName !== repositoryName) {
            return "gone" as const;
          }

          // C33: the recorded path, which a retry may have taken over from
          // the execution that created it.
          const removed = await repo.remove(row.worktreePath, {
            branch: row.branch,
            ...(expectedTip !== undefined ? { expectedTip } : {}),
          });
          if (removed.tipMoved) return "tip_moved" as const;
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
          await removeContainer(row.executionId, fields);
          return "done" as const;
        }),
      );

      if (outcome === "gone") return false;
      if (outcome === "tip_moved") {
        logger.warn(
          { ...fields, branch: candidate.branch },
          "branch moved after the push, worktree kept",
        );
        return false;
      }
      logger.info(
        { ...fields, ...(action === "evict" ? { pushed } : {}) },
        action === "evict" ? "worktree evicted" : "worktree removed",
      );
      return true;
    } catch (err) {
      logger.error({ ...fields, err: errMessage(err) }, "worktree sweep failed");
      return false;
    }
  };

  /**
   * Rule zero for one candidate: holding the repository lock, a transaction
   * locks the task and execution rows, re-checks the rule, removes the
   * detached worktree at its recorded path (C33) and clears
   * `worktree_path`. Never throws.
   */
  const removeSpec = async (candidate: ApprovedSpecWorktree): Promise<void> => {
    const fields = {
      executionId: candidate.executionId,
      taskId: candidate.taskId,
      kind: "approved_spec",
      action: "remove",
    };
    try {
      const repositoryName = candidate.repositoryName;
      if (repositoryName === null) throw new Error("execution's project has no repository");
      const outcome = await worktrees.withRepositoryLock(repositoryName, (repo) =>
        db.transaction(async (tx) => {
          const row = await lockApprovedSpecWorktree(tx, {
            host,
            executionId: candidate.executionId,
            taskId: candidate.taskId,
          });
          if (!row || row.repositoryName !== repositoryName) return "gone" as const;
          await repo.remove(row.worktreePath, { branch: null });
          await clearExecutionWorktree(tx, row.executionId);
          await removeContainer(row.executionId, fields);
          return "done" as const;
        }),
      );
      if (outcome === "done") logger.info(fields, "spec worktree removed");
    } catch (err) {
      logger.error({ ...fields, err: errMessage(err) }, "worktree sweep failed");
    }
  };

  let specCandidates: ApprovedSpecWorktree[] = [];
  try {
    specCandidates = await listApprovedSpecWorktrees(db, host);
  } catch (err) {
    logger.error({ kind: "approved_spec", err: errMessage(err) }, "worktree candidate list failed");
  }
  for (const candidate of specCandidates) await removeSpec(candidate);

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

  if (containers) await sweepOrphanContainers({ db, host, logger }, containers);

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
 * §9.9 Orphans, one pass. Lists containers labelled `orchestra.execution`
 * (never any other) and removes each whose label names no execution, or an
 * execution on `host` that has ended. An execution on another host, or on
 * none, is left alone: its container's owner cannot be told apart here. A
 * known execution is re-checked with its task and execution rows locked,
 * and the container is removed under those locks. Never throws.
 */
async function sweepOrphanContainers(
  input: Pick<WorktreeSweepInput, "db" | "host" | "logger">,
  containers: ExecutionContainerOps,
): Promise<void> {
  const { db, host, logger } = input;
  let listed: LabelledContainer[];
  try {
    listed = await containers.list();
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "agent container list failed");
    return;
  }
  if (listed.length === 0) return;

  let known: Map<string, ContainerExecution>;
  try {
    const rows = await listContainerExecutions(
      db,
      listed.map((c) => c.executionId),
    );
    known = new Map(rows.map((row) => [row.executionId.toLowerCase(), row]));
  } catch (err) {
    logger.error({ err: errMessage(err) }, "agent container execution lookup failed");
    return;
  }

  const ownedAndEnded = (row: ContainerExecution): boolean =>
    row.host === host && CONTAINER_ENDED_STATES.has(row.state);

  for (const container of listed) {
    const fields = { container: container.id, executionId: container.executionId };
    try {
      const row = known.get(container.executionId.toLowerCase());
      if (!row) {
        await containers.remove(container.id);
        logger.info({ ...fields, reason: "unknown" }, "orphan agent container removed");
        continue;
      }
      if (!ownedAndEnded(row)) continue;
      const removed = await db.transaction(async (tx) => {
        const locked = await lockContainerExecution(tx, row);
        if (!locked || !ownedAndEnded(locked)) return false;
        await containers.remove(container.id);
        return true;
      });
      if (removed) logger.info({ ...fields, reason: row.state }, "orphan agent container removed");
    } catch (err) {
      logger.warn({ ...fields, err: errMessage(err) }, "agent container removal failed");
    }
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
