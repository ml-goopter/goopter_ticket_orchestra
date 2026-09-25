import type { Runtime } from "@orchestra/core";
import {
  countSlotHoldingExecutions,
  getClaimWorker,
  insertQueuedExecution,
  listReadyTasksWithUndetectedRuntime,
  nextExecutionAttempt,
  replaceTaskLease,
  selectClaimCandidate,
  transition,
  type Db,
} from "@orchestra/db";
import { LEASE_TTL_MS } from "../agent-tools/lease.js";
import type { Logger } from "../logger.js";

/** What the claim hands to the runner after commit (§6.3, G1). */
export interface ClaimedExecution {
  executionId: string;
  taskId: string;
}

/**
 * Receives each claimed execution once its transaction has committed. It
 * is called synchronously and not awaited, so it must hand the execution
 * off (to the runner) rather than run the session inline; a returned
 * promise that rejects is logged.
 */
export type OnClaimed = (claim: ClaimedExecution) => void | Promise<void>;

export interface ClaimOptions {
  db: Db;
  workerId: string;
  /** Runtimes detected on PATH at startup (§7.3). */
  runtimes: readonly Runtime[];
  now: Date;
}

/**
 * design.md §6.3: in one transaction, check this worker has a free slot,
 * lock the most urgent eligible `READY` task, insert its implementation
 * execution (`QUEUED`, then `ASSIGNED` through `transition()`), write the
 * lease (replacing an ended execution's leftover row), and move the task
 * `READY -> IMPLEMENTING` (`task.claimed`). Any failure rolls every one of
 * those back. Returns null when there is no free slot or no eligible task.
 *
 * Lock order: the candidate query locks the task row first; the execution
 * row is created and locked after it.
 */
export async function claimNextTask(
  options: ClaimOptions,
): Promise<ClaimedExecution | null> {
  const { db, workerId, runtimes, now } = options;
  const actor = { kind: "worker" as const, id: workerId };

  return db.transaction(async (tx) => {
    const worker = await getClaimWorker(tx, workerId);
    if (!worker) {
      throw new Error(`claim: worker not registered: ${workerId}`);
    }

    const busy = await countSlotHoldingExecutions(tx, worker.host);
    if (busy >= worker.maxConcurrent) return null;

    const candidate = await selectClaimCandidate(tx, {
      workerId,
      host: worker.host,
      runtimes,
    });
    if (!candidate) return null;

    const attempt = await nextExecutionAttempt(
      tx,
      candidate.taskId,
      "implementation",
    );

    const { id: executionId } = await insertQueuedExecution(tx, {
      taskId: candidate.taskId,
      role: "implementation",
      attempt,
      runtime: candidate.runtime,
      model: candidate.model,
      specRevisionId: candidate.approvedRevisionId,
      workerId,
      host: worker.host,
    });

    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.assigned",
      actor,
    });

    // Replaces a leftover lease from the task's ended execution, if any: a
    // READY task has no live execution, and the task row is locked above.
    await replaceTaskLease(tx, {
      taskId: candidate.taskId,
      executionId,
      workerId,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
    });

    await transition(tx, {
      entity: "task",
      id: candidate.taskId,
      trigger: "task.claimed",
      actor,
    });

    return { executionId, taskId: candidate.taskId };
  });
}

export interface RuntimeWarner {
  /** Logs each READY task skipped for an undetected runtime, once per task. */
  warn(db: Db, workerId: string, logger: Logger): Promise<void>;
}

/**
 * design.md §7.3 / G4: a task whose runtime binary is not on PATH waits for
 * a capable worker. Warn once per task for the life of the process, not
 * once per tick.
 */
export function createRuntimeWarner(
  runtimes: readonly Runtime[],
): RuntimeWarner {
  const warned = new Set<string>();
  return {
    async warn(db, workerId, logger) {
      const skipped = await listReadyTasksWithUndetectedRuntime(db, {
        workerId,
        runtimes,
      });
      for (const task of skipped) {
        if (warned.has(task.taskId)) continue;
        warned.add(task.taskId);
        logger.warn(
          {
            taskId: task.taskId,
            jiraKey: task.jiraKey,
            runtime: task.runtime,
            detectedRuntimes: [...runtimes],
          },
          "task runtime binary not on PATH, not claiming",
        );
      }
    },
  };
}

/**
 * Calls the handler without awaiting it, so a slow or failing handler never
 * holds the tick. Both a synchronous throw and a rejected promise are
 * logged; the committed claim stands either way.
 */
export function handOff(
  onClaimed: OnClaimed,
  claim: ClaimedExecution,
  logger: Logger,
): void {
  const fail = (err: unknown): void => {
    logger.error(
      { ...claim, err: err instanceof Error ? err.message : String(err) },
      "onClaimed handler failed",
    );
  };
  try {
    const result = onClaimed(claim);
    if (result instanceof Promise) result.catch(fail);
  } catch (err) {
    fail(err);
  }
}
