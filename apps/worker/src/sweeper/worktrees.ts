import fs from "node:fs/promises";
import {
  appendEvent,
  clearExecutionWorktree,
  listApprovedSpecWorktrees,
  listContainerExecutions,
  listRepositoryNames,
  listWorktreeCandidates,
  lockApprovedSpecWorktree,
  lockContainerExecution,
  lockWorktreeCandidate,
  markWorktreeEvicted,
  repositoryNameExists,
  type ApprovedSpecWorktree,
  type ContainerExecution,
  type Db,
  type WorktreeCandidate,
  type WorktreeSweepClass,
} from "@orchestra/db";
import {
  ensureMark,
  forgetEnsure,
  withExecutionContainerLock,
  type ExecutionContainerOps,
  type LabelledContainer,
} from "../containers/index.js";
import type { Logger } from "../logger.js";
import type { Phase } from "../tick.js";
import { WorktreeManager, type BareCloneEntry } from "../worktrees/manager.js";

/** §6.6 rules one and two: finished worktrees are kept for 24 hours. */
export const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;
/** §6.6 rule three: waiting worktrees are evicted after 14 idle days. */
export const IDLE_EVICTION_MS = 14 * 24 * 60 * 60 * 1000;

/** The `WorktreeManager` methods the sweeper uses. */
export type WorktreeOps = Pick<
  WorktreeManager,
  "withRepositoryLock" | "pushIfAhead" | "listBareClones"
>;

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
   * Agent containers (§9.9), normally `dockerExecutionContainers()` with
   * this deployment's owner. Only a worker with the `docker` capability
   * passes it; omitted, the sweeper touches no container.
   */
  containers?: ExecutionContainerOps;
  /**
   * The runner's `isLive`: true while this process runs, starts or resumes
   * the execution. A live execution's container is never removed, whatever
   * its row says. Omitted, no execution counts as live here.
   */
  isLive?: (executionId: string) => boolean;
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

/**
 * Execution states whose container is never removed: the execution is
 * running or about to run (§9.9 Reuse). A spec execution is `RUNNING`
 * between turns.
 */
const CONTAINER_LIVE_STATES: ReadonlySet<ContainerExecution["state"]> = new Set([
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
]);

/** What a candidate's rule does to it. */
type Action = "remove" | "evict";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

interface GuardedRemoval {
  executionId: string;
  /** `ensureMark(executionId)`, read before the sweeper's decision. */
  mark: number;
  /** Re-checked on a fresh read of the execution, null when it is gone. */
  removable: (row: ContainerExecution | null) => boolean;
  /** The docker removal. */
  remove: () => Promise<void>;
  /** `WorktreeSweeperOptions.isLive`. */
  isLive?: ((executionId: string) => boolean) | undefined;
  fields: Record<string, unknown>;
}

/**
 * Removes one container after the sweeper's decision has committed, holding
 * only the execution's container lock: no transaction is open and no
 * repository lock is held. Under that lock it skips when this process runs
 * the execution (`isLive`), or when an `ensure` ran since `mark` was read (a
 * resume is using the container), re-reads the execution without row locks
 * and skips unless `removable`, then removes and clears the mark. A run
 * that starts or resumes meanwhile ensures only after it is live and its
 * state move has committed; that `ensure` waits for the lock and recreates
 * the container. Logs; never throws. True when removed.
 */
async function removeContainerGuarded(
  db: Db,
  logger: Logger,
  removal: GuardedRemoval,
): Promise<boolean> {
  const { executionId, fields } = removal;
  try {
    return await withExecutionContainerLock(executionId, async () => {
      if (removal.isLive?.(executionId)) {
        logger.info({ ...fields, reason: "live" }, "agent container kept, execution resumed");
        return false;
      }
      if (ensureMark(executionId) !== removal.mark) {
        logger.info({ ...fields, reason: "ensured" }, "agent container kept, execution resumed");
        return false;
      }
      const [row] = await listContainerExecutions(db, [executionId]);
      if (!removal.removable(row ?? null)) {
        logger.info(
          { ...fields, reason: row?.state ?? "gone" },
          "agent container kept, execution resumed",
        );
        return false;
      }
      await removal.remove();
      forgetEnsure(executionId);
      return true;
    });
  } catch (err) {
    logger.warn({ ...fields, err: errMessage(err) }, "agent container removal failed");
    return false;
  }
}

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
 * the execution's agent container is removed too (§9.9 Removal). After rule
 * three, the orphan pass removes containers carrying this deployment's
 * `orchestra.owner` label whose execution has ended, on any host, or does
 * not exist (§9.9 Orphans). A container failure is logged and never blocks
 * worktree cleanup; the orphan pass picks up what a failed removal left.
 *
 * Lock order for one candidate: the per-repository lock of the worktree
 * manager, then the task row, then the execution row. The repository lock
 * is in-process, so Postgres cannot see a wait on it; taking it before the
 * row locks means the sweeper never holds a row while it waits behind a
 * fetch or push on the same repository. The runner never calls the manager
 * while holding a row lock, so the order is not inverted anywhere. The
 * orphan pass takes the task row, then the execution row, and no
 * repository lock.
 *
 * GOT.63's deleted-repository clone pass (`sweepDeletedRepositoryClones`,
 * below) takes no row lock at all, task, execution or otherwise: a
 * `repositories` row has no worktree candidate hanging off it for this
 * sweep to lock. It takes only the worktree manager's per-repository lock,
 * keyed on the clone's directory name, then a single unlocked
 * `repositoryNameExists` read as its recheck, then the filesystem removal,
 * all before releasing that lock. Because it holds no database lock at any
 * point, it cannot invert against anything above; it can only ever wait
 * behind, or make wait, a `prepareImplementation`, `prepareSpec` or
 * `pushIfAhead` call on the same repository name, which is exactly the
 * serialisation that lock exists for.
 *
 * No docker call runs inside a transaction or under the repository lock, so
 * a slow or hung daemon never holds a row or a repository. The container
 * step comes after the decision's transaction has committed and the
 * repository lock is released:
 *
 * 1. before the decision, read the execution's ensure mark;
 * 2. decide and write under the row locks, commit, release the locks;
 * 3. take the execution's in-process container lock, which
 *    `ContainerManager.ensure` also takes and which is acquired last
 *    everywhere, so it joins no wait cycle;
 * 4. keep the container if this process runs the execution (`isLive`), if
 *    the mark changed (an `ensure` ran after step 1: a resume, for example
 *    of the worktree just evicted, is using it) or if a fresh read shows the
 *    execution `QUEUED`, `ASSIGNED` or `RUNNING`;
 * 5. otherwise remove it and clear the mark.
 *
 * A resume that ensures during step 5 waits for the lock, finds the
 * container missing and recreates it (§9.9 Recreation). The runner ensures
 * only while the execution is live here and after its state move, so a
 * container this process ensured earlier is removed by the orphan pass
 * once its execution has ended by any path, the api's request-review,
 * cancel or a Jira 404 included, which notify no worker (C4 F1).
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

  /**
   * Removes the container of an execution whose worktree was just removed
   * or evicted, unless it was ensured since `mark` or is live again. Runs
   * with no transaction open and no repository lock. Never throws.
   */
  const removeContainer = async (
    executionId: string,
    mark: number,
    fields: Record<string, unknown>,
  ): Promise<void> => {
    if (!containers) return;
    await removeContainerGuarded(db, logger, {
      executionId,
      mark,
      removable: (row) => row === null || !CONTAINER_LIVE_STATES.has(row.state),
      remove: () => containers.removeForExecution(executionId),
      isLive: options.isLive,
      fields,
    });
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

      const mark = ensureMark(candidate.executionId);
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
      await removeContainer(candidate.executionId, mark, fields);
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
      const mark = ensureMark(candidate.executionId);
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
          return "done" as const;
        }),
      );
      if (outcome === "done") {
        logger.info(fields, "spec worktree removed");
        await removeContainer(candidate.executionId, mark, fields);
      }
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

  if (containers) await sweepOrphanContainers({ db, logger }, containers, options.isLive);

  await sweepDeletedRepositoryClones(db, worktrees, logger);

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
 * §9.9 Orphans, one pass. Considers only containers labelled
 * `orchestra.execution` and carrying this deployment's `orchestra.owner`
 * (never any other: a container with no owner or another owner belongs to
 * another stack on the same daemon) and removes each whose label names no
 * execution, or an execution that has ended. This deployment's containers
 * are exclusively its own regardless of which host the execution's row
 * currently names: a row released to no host or moved to another host is
 * still ended, and its container is still this deployment's to reclaim. A
 * container of an execution this process runs (`isLive`) is left alone; one
 * this process ensured for a run that has since finished is not, so an
 * execution the api ended without any worker's knowledge loses its
 * container on the next pass (C4 F1). A known execution is re-checked with
 * its task and execution rows locked; the removal itself runs after that
 * transaction commits, under the guard of `removeContainerGuarded`. Never
 * throws.
 */
async function sweepOrphanContainers(
  input: Pick<WorktreeSweepInput, "db" | "logger">,
  containers: ExecutionContainerOps,
  isLive: WorktreeSweeperOptions["isLive"],
): Promise<void> {
  const { db, logger } = input;
  let listed: LabelledContainer[];
  try {
    listed = (await containers.list()).filter((c) => c.owner === containers.owner);
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
    CONTAINER_ENDED_STATES.has(row.state);

  for (const container of listed) {
    const { executionId } = container;
    const fields = { container: container.id, executionId };
    try {
      const mark = ensureMark(executionId);
      const row = known.get(executionId.toLowerCase());
      if (row) {
        if (!ownedAndEnded(row)) continue;
        const locked = await db.transaction((tx) => lockContainerExecution(tx, row));
        if (!locked || !ownedAndEnded(locked)) continue;
      }
      const removed = await removeContainerGuarded(db, logger, {
        executionId,
        mark,
        removable: (current) => current === null || ownedAndEnded(current),
        remove: () => containers.remove(container.id),
        isLive,
        fields,
      });
      if (removed) {
        logger.info(
          { ...fields, reason: row ? row.state : "unknown" },
          "orphan agent container removed",
        );
      }
    } catch (err) {
      logger.warn({ ...fields, err: errMessage(err) }, "agent container removal failed");
    }
  }
}

/**
 * GOT.63, one pass: a bare clone directory under `repos/` whose name
 * matches no repository row, in any project, is the delete route's
 * leftover (design.md D7 keys the clone on name alone; §12.5's delete
 * refuses while a task still references the repository, and the foreign
 * key from `tasks.repository_id` enforces the same thing, so no execution
 * or worktree can still name a deleted repository by the time this runs;
 * there is nothing under `work/` for this pass to find or touch).
 *
 * Lists `repos/` once, unlocked, logs and skips any symlinked entry there
 * without following it, and keeps a directory a current repository still
 * names. For the rest it takes the worktree manager's per-repository lock,
 * keyed on the directory's name, and re-reads `repositoryNameExists` before
 * removing: a repository recreated with that name, and being cloned or
 * fetched under that same lock, is never deleted. No database row lock is
 * held at any point in this pass, only that in-process lock. A clone that
 * fails to remove is logged and the rest of the sweep continues. Never
 * throws.
 */
async function sweepDeletedRepositoryClones(
  db: Db,
  worktrees: WorktreeOps,
  logger: Logger,
): Promise<void> {
  let clones: BareCloneEntry[];
  try {
    clones = await worktrees.listBareClones();
  } catch (err) {
    logger.error({ err: errMessage(err) }, "bare clone list failed");
    return;
  }

  const candidates: string[] = [];
  for (const clone of clones) {
    if (clone.isSymlink) {
      logger.warn({ name: clone.name }, "repos entry is a symlink, skipped");
      continue;
    }
    candidates.push(clone.name);
  }
  if (candidates.length === 0) return;

  let names: Set<string>;
  try {
    names = await listRepositoryNames(db);
  } catch (err) {
    logger.error({ err: errMessage(err) }, "repository name list failed");
    return;
  }

  for (const name of candidates) {
    if (names.has(name)) continue;
    try {
      const removed = await worktrees.withRepositoryLock(name, async (repo) => {
        if (await repositoryNameExists(db, name)) return false;
        await repo.removeBareClone();
        return true;
      });
      if (removed) {
        logger.info({ name }, "deleted repository's bare clone removed");
      }
    } catch (err) {
      logger.error({ name, err: errMessage(err) }, "bare clone removal failed");
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
