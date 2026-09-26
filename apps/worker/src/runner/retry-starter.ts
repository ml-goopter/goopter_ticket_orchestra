import fs from "node:fs/promises";
import type { Runtime } from "@orchestra/core";
import {
  countSlotHoldingExecutions,
  getClaimWorker,
  lockPreviousWorktree,
  lockQueuedRetry,
  pinRetryExecution,
  replaceTaskLease,
  selectRetryCandidate,
  transferRetryWorktree,
  transition,
  type Db,
} from "@orchestra/db";
import { LEASE_TTL_MS } from "../agent-tools/lease.js";
import type { Logger } from "../logger.js";
import type { ClaimedExecution } from "../scheduler/claim.js";
import { parseRetryQueuedPayload } from "./retry.js";
import type { RetryStart, Runner } from "./runner.js";

/**
 * The retry starter (design.md §9.5, §6.5, C25): takes `QUEUED` retry
 * executions with no host once their backoff has passed and starts them on
 * this worker.
 *
 * `not_before` is read from the retry's `execution.queued` event payload,
 * where the policy writes it together with the protocol nudge the starter
 * also needs. It is not derived from `created_at`, because a protocol
 * retry has no backoff and does not use an infrastructure retry.
 *
 * Out of scope here (GOT.47): executions released from a dead host with
 * `host` null that are WAITING_FOR_USER, or COMPLETED with a skipped CI
 * resume (C21). They are not FAILED, have no retry row, and are never
 * taken by this starter; their fresh-session fallback (D5, §6.1) belongs
 * to the resume commands in GOT.47.
 */

export const DEFAULT_RETRY_STARTER_INTERVAL_MS = 5_000;

/** Upper bound on retries taken in one run; free slots bound it first. */
const MAX_RETRIES_PER_RUN = 50;

/** A retry pinned to this worker, as handed to the runner. */
export interface ClaimedRetry extends ClaimedExecution {
  retry: RetryStart;
}

export interface ClaimNextRetryOptions {
  db: Db;
  workerId: string;
  /** Runtimes detected on PATH at startup (§7.3). */
  runtimes: readonly Runtime[];
  now: Date;
}

/**
 * One transaction: lock this worker's row and check it has a free slot
 * (the claim's capacity helper, §6.3), lock the oldest due retry's task row
 * `SKIP LOCKED`, then its execution row, pin the execution to this worker,
 * move it `QUEUED -> ASSIGNED` (`execution.assigned`) and replace the
 * task's lease. When the failed attempt's worktree is on this host, not
 * evicted, and still on disk, the retry takes it over in the same
 * transaction (C31, C32): the retry row gets its path and branch and the
 * failed row's `worktree_path` is cleared. Null when there is no free slot
 * or no due retry. Lock order: worker, task, retry execution, failed
 * execution. The worktree manager is never called here; the only file
 * system access is one `stat` of the old worktree path.
 */
export async function claimNextRetry(
  options: ClaimNextRetryOptions,
): Promise<ClaimedRetry | null> {
  const { db, workerId, runtimes, now } = options;
  const actor = { kind: "worker" as const, id: workerId };

  return db.transaction(async (tx) => {
    const worker = await getClaimWorker(tx, workerId);
    if (!worker) throw new Error(`retry starter: worker not registered: ${workerId}`);

    const busy = await countSlotHoldingExecutions(tx, worker.host);
    if (busy >= worker.maxConcurrent) return null;

    const candidate = await selectRetryCandidate(tx, {
      workerId,
      host: worker.host,
      runtimes,
      now,
    });
    if (!candidate) return null;

    const queued = parseRetryQueuedPayload(candidate.queued);
    if (!queued) {
      throw new Error(
        `retry starter: execution ${candidate.executionId} has a malformed execution.queued payload`,
      );
    }
    if (!(await lockQueuedRetry(tx, candidate.executionId))) return null;

    await pinRetryExecution(tx, candidate.executionId, { workerId, host: worker.host });

    const previous = await lockPreviousWorktree(tx, {
      executionId: queued.retry_of,
      taskId: candidate.taskId,
    });
    if (
      previous?.worktreePath &&
      previous.host === worker.host &&
      previous.worktreeEvictedAt === null &&
      (await directoryExists(previous.worktreePath))
    ) {
      await transferRetryWorktree(tx, {
        fromExecutionId: queued.retry_of,
        toExecutionId: candidate.executionId,
        worktreePath: previous.worktreePath,
        branch: previous.branch,
      });
    }
    await transition(tx, {
      entity: "execution",
      id: candidate.executionId,
      trigger: "execution.assigned",
      actor,
    });
    await replaceTaskLease(tx, {
      taskId: candidate.taskId,
      executionId: candidate.executionId,
      workerId,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
    });

    const retry: RetryStart = { previousExecutionId: queued.retry_of };
    if (queued.nudge) retry.nudge = { missingToolCall: queued.nudge.missing_tool_call };
    return { executionId: candidate.executionId, taskId: candidate.taskId, retry };
  });
}

async function directoryExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export interface RetryStarterOptions {
  db: Db;
  runner: Pick<Runner, "start">;
  workerId: string;
  runtimes: readonly Runtime[];
  logger: Logger;
  /** Fake clock for tests. */
  now?: () => Date;
}

/**
 * One starter run: claims due retries while this worker has a free slot
 * and hands each to the runner after its transaction commits, without
 * awaiting the run. Returns what it claimed.
 */
export async function runRetryStarter(
  options: RetryStarterOptions,
): Promise<ClaimedRetry[]> {
  const { db, runner, workerId, runtimes, logger } = options;
  const now = options.now ?? (() => new Date());
  const claimed: ClaimedRetry[] = [];

  for (let i = 0; i < MAX_RETRIES_PER_RUN; i++) {
    const claim = await claimNextRetry({ db, workerId, runtimes, now: now() });
    if (!claim) break;
    claimed.push(claim);
    logger.info(
      {
        executionId: claim.executionId,
        taskId: claim.taskId,
        previousExecutionId: claim.retry.previousExecutionId,
        nudge: claim.retry.nudge !== undefined,
      },
      "retry execution assigned to this worker",
    );
    const { retry, ...execution } = claim;
    runner.start(execution, { retry }).catch((err: unknown) => {
      logger.error(
        { ...execution, err: err instanceof Error ? err.message : String(err) },
        "retry start failed",
      );
    });
  }
  return claimed;
}

export type StopRetryStarter = () => Promise<void>;

/**
 * Starts the independent retry starter loop, one run every `intervalMs`
 * after the previous run ends. A failed run is logged and the next one is
 * still scheduled. The returned function stops the loop and waits for a
 * run in flight.
 */
export function startRetryStarter(
  options: RetryStarterOptions & { intervalMs?: number },
): StopRetryStarter {
  const { logger, intervalMs = DEFAULT_RETRY_STARTER_INTERVAL_MS } = options;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => void run(), intervalMs);
  }

  async function run(): Promise<void> {
    if (stopped) return;
    inFlight = runRetryStarter(options).then(
      () => undefined,
      (err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "retry starter run failed; scheduling next run",
        );
      },
    );
    await inFlight;
    inFlight = undefined;
    scheduleNext();
  }

  scheduleNext();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}
