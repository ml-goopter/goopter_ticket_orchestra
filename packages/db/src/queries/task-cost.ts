import type { ExecutionState, Runtime } from "@orchestra/core";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { executions } from "../schema/executions.js";
import { projects, repositories } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx } from "../transition.js";

export interface TaskCost {
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export const ZERO_TASK_COST: TaskCost = {
  costUsd: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
};

/**
 * Sums `executions.cost_usd` (and token counts) per task (design.md §9.7:
 * "task cost is `sum(executions.cost_usd)`... computed in queries, not
 * stored"). Tasks with no executions are simply absent from the returned
 * map; callers fall back to `ZERO_TASK_COST`.
 */
export async function sumTaskCost(
  db: DbOrTx,
  taskIds: string[],
): Promise<Map<string, TaskCost>> {
  if (taskIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      taskId: executions.taskId,
      costUsd: sql<string>`sum(${executions.costUsd})`,
      inputTokens: sql<string>`sum(${executions.inputTokens})`,
      cachedInputTokens: sql<string>`sum(${executions.cachedInputTokens})`,
      outputTokens: sql<string>`sum(${executions.outputTokens})`,
    })
    .from(executions)
    .where(inArray(executions.taskId, taskIds))
    .groupBy(executions.taskId);

  const result = new Map<string, TaskCost>();
  for (const row of rows) {
    result.set(row.taskId, {
      costUsd: Number(row.costUsd),
      inputTokens: Number(row.inputTokens),
      cachedInputTokens: Number(row.cachedInputTokens),
      outputTokens: Number(row.outputTokens),
    });
  }
  return result;
}

/**
 * Effective runtime per task (design.md §18, D18): `runtime_override` when
 * set, otherwise the task's repository's `default_runtime`. Null when the
 * task has neither (no repository assigned yet).
 */
export async function listBoardRuntimes(
  db: DbOrTx,
  taskIds: string[],
): Promise<Map<string, Runtime | null>> {
  if (taskIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      taskId: tasks.id,
      runtimeOverride: tasks.runtimeOverride,
      defaultRuntime: repositories.defaultRuntime,
    })
    .from(tasks)
    .leftJoin(repositories, eq(repositories.id, tasks.repositoryId))
    .where(inArray(tasks.id, taskIds));

  const result = new Map<string, Runtime | null>();
  for (const row of rows) {
    result.set(row.taskId, row.runtimeOverride ?? row.defaultRuntime ?? null);
  }
  return result;
}

const ACTIVE_EXECUTION_STATES = [
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_USER",
] as const satisfies readonly ExecutionState[];

/**
 * Ids of a task's executions still in flight (design.md §5.2 cancel edges:
 * `QUEUED`/`ASSIGNED`/`RUNNING`/`WAITING_FOR_USER` -> `CANCELLED`). Used by
 * `POST /tasks/:id/cancel` to cancel every active execution alongside the
 * task itself.
 */
export async function listActiveExecutionIds(
  db: DbOrTx,
  taskId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.taskId, taskId),
        inArray(executions.state, [...ACTIVE_EXECUTION_STATES]),
      ),
    );
  return rows.map((row) => row.id);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a `?project=` filter to a project id, accepting either the
 * project's id or its `key` (design.md §12.2 `GET /tasks?...&project=`).
 * Null when nothing matches, so the caller can short-circuit to an empty
 * list instead of a SQL error on a malformed uuid.
 */
export async function resolveProjectFilter(
  db: DbOrTx,
  idOrKey: string,
): Promise<string | null> {
  const where = UUID_RE.test(idOrKey)
    ? or(eq(projects.id, idOrKey), eq(projects.key, idOrKey))
    : eq(projects.key, idOrKey);

  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(where)
    .limit(1);
  return row?.id ?? null;
}
