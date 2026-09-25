import type { TaskState } from "@orchestra/core";
import {
  listDependencies,
  listPromotionCandidateIds,
  lockDependencyGraph,
  lockTaskForPromotion,
  transition,
  type Db,
} from "@orchestra/db";
import type { Logger } from "../logger.js";

export type PromotionTrigger = "dependency.satisfied" | "dependency.failed";

/** Dependency states that make an approved task `BLOCKED` (§6.2). */
const FAILED_DEPENDENCY_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "FAILED",
  "CANCELLED",
]);

/**
 * design.md §6.2, decided from the states of a task's dependencies. Any
 * `FAILED` or `CANCELLED` dependency blocks the task. Otherwise all `DONE`
 * (or none at all) makes it `READY`. Anything else leaves it waiting.
 */
export function decidePromotion(
  dependencyStates: readonly TaskState[],
): PromotionTrigger | null {
  if (dependencyStates.some((s) => FAILED_DEPENDENCY_STATES.has(s))) {
    return "dependency.failed";
  }
  if (dependencyStates.every((s) => s === "DONE")) {
    return "dependency.satisfied";
  }
  return null;
}

export interface PromotionOptions {
  db: Db;
  workerId: string;
  logger: Logger;
}

export interface PromotionOutcome {
  taskId: string;
  trigger: PromotionTrigger;
}

/**
 * design.md §6.2: moves every `SPEC_APPROVED` task with no paused execution
 * to `READY` or `BLOCKED` by its dependencies. One transaction per task, so
 * one bad task cannot roll back another's promotion.
 *
 * Each transaction takes the dependency-graph advisory lock first, then the
 * task row. That is the order the api's dependency `PATCH` uses (advisory
 * lock, then its `UPDATE tasks`), so the two serialise instead of
 * deadlocking, and promotion never reads a dependency set a concurrent
 * `PATCH` is about to replace.
 */
export async function promoteApprovedTasks(
  options: PromotionOptions,
): Promise<PromotionOutcome[]> {
  const { db, workerId, logger } = options;
  const outcomes: PromotionOutcome[] = [];

  for (const taskId of await listPromotionCandidateIds(db)) {
    let trigger: PromotionTrigger | null;
    try {
      trigger = await db.transaction(async (tx) => {
        await lockDependencyGraph(tx);
        if (!(await lockTaskForPromotion(tx, taskId))) return null;

        const dependencies = await listDependencies(tx, taskId);
        const decided = decidePromotion(dependencies.map((d) => d.state));
        if (decided === null) return null;

        await transition(tx, {
          entity: "task",
          id: taskId,
          trigger: decided,
          actor: { kind: "worker", id: workerId },
        });
        return decided;
      });
    } catch (err) {
      // Rolled back. The task stays SPEC_APPROVED and is retried next tick;
      // the remaining candidates still get their turn this tick.
      logger.error(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        "promotion failed",
      );
      continue;
    }

    if (trigger !== null) {
      outcomes.push({ taskId, trigger });
      logger.info({ taskId, trigger }, "promoted approved task");
    }
  }

  return outcomes;
}
