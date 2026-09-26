import {
  RuntimeSchema,
  TaskStateSchema,
  TransitionError,
  deriveColumn,
  type TaskState,
} from "@orchestra/core";
import {
  ZERO_TASK_COST,
  getTaskAggregate,
  getTaskCostBreakdown,
  listActiveExecutionIds,
  listAttention,
  listBoard,
  listBoardRuntimes,
  listDependencies,
  listTimeline,
  lockDependencyGraph,
  NotFoundError,
  replaceDependencies,
  resolveProjectFilter,
  resolveTaskIdsByJiraKey,
  setRuntimeOverride,
  sumTaskCost,
  transition,
  wouldCreateCycle,
  type Actor,
  type BoardRow,
  type DependencyRow,
  type TaskAggregate,
  type TaskCost,
  type TaskCostBreakdown,
  type TaskCostUsageRow,
  type TaskExecutionCostBreakdown,
  type TransitionResult,
} from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";

const TaskIdParamsSchema = z.object({ id: z.uuid() });

function parseTaskId(params: unknown): string {
  const parsed = TaskIdParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "id must be a UUID.");
  }
  return parsed.data.id;
}

const TaskListQuerySchema = z.object({
  state: z.string().optional(),
  project: z.string().optional(),
  attention: z.string().optional(),
});

const TimelineQuerySchema = z.object({
  after: z
    .string()
    .regex(/^\d+$/, "after must be a non-negative integer")
    .optional(),
  limit: z.string().regex(/^\d+$/, "limit must be an integer").optional(),
});

const PatchBodySchema = z
  .object({
    runtime_override: RuntimeSchema.nullable().optional(),
    dependencies: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Thrown inside the PATCH transaction; caught by the route to shape the 409 body (design.md §12.2). */
class DependencyCycleError extends Error {
  readonly path: string[];
  constructor(jiraKeyPath: string[]) {
    super(`dependency cycle: ${jiraKeyPath.join(" -> ")}`);
    this.name = "DependencyCycleError";
    this.path = jiraKeyPath;
  }
}

/**
 * `transition()` throws `NotFoundError`/`TransitionError` (from `@orchestra/db`
 * and `@orchestra/core` respectively); both map to the api's `{ error }` shape
 * here so route handlers can just await `transition()` inside a try/catch.
 */
function rethrowTransitionError(err: unknown): never {
  if (err instanceof NotFoundError) {
    throw new AppError(404, "NOT_FOUND", err.message);
  }
  if (err instanceof TransitionError) {
    throw new AppError(409, "ILLEGAL_TRANSITION", err.message);
  }
  throw err;
}

function toCard(
  row: BoardRow,
  costByTask: Map<string, TaskCost>,
  runtimeByTask: Map<string, "claude" | "codex" | null>,
) {
  return {
    id: row.taskId,
    jiraKey: row.jiraKey,
    jiraSummary: row.jiraSummary,
    state: row.state,
    column: deriveColumn(row.state, row.hasWaitingExecution),
    runtime: runtimeByTask.get(row.taskId) ?? null,
    projectId: row.projectId,
    repositoryId: row.repositoryId,
    jiraPriority: row.jiraPriority,
    jiraCreatedAt: row.jiraCreatedAt,
    updatedAt: row.updatedAt,
    hasWaitingExecution: row.hasWaitingExecution,
    cost: (costByTask.get(row.taskId) ?? ZERO_TASK_COST).costUsd,
  };
}

function serializeAggregate(
  aggregate: TaskAggregate,
  dependencies: DependencyRow[],
  cost: TaskCost,
) {
  return { ...aggregate, dependencies, cost };
}

function serializeUsageRow(row: TaskCostUsageRow) {
  return {
    id: row.id,
    kind: row.kind,
    round: row.round,
    runtime: row.runtime,
    model: row.model,
    input_tokens: row.inputTokens,
    cached_input_tokens: row.cachedInputTokens,
    output_tokens: row.outputTokens,
    cost_usd: row.costUsd,
    recorded_at: row.recordedAt,
    estimated: row.estimated,
  };
}

function serializeExecutionCost(execution: TaskExecutionCostBreakdown) {
  return {
    execution_id: execution.executionId,
    role: execution.role,
    attempt: execution.attempt,
    runtime: execution.runtime,
    estimated: execution.estimated,
    usage: execution.usage.map(serializeUsageRow),
    total: {
      cost_usd: execution.total.costUsd,
      input_tokens: execution.total.inputTokens,
      cached_input_tokens: execution.total.cachedInputTokens,
      output_tokens: execution.total.outputTokens,
      unpriced_rows: execution.total.unpricedRows,
    },
  };
}

function serializeTaskCostBreakdown(breakdown: TaskCostBreakdown) {
  return {
    task_id: breakdown.taskId,
    executions: breakdown.executions.map(serializeExecutionCost),
    total: {
      cost_usd: breakdown.total.costUsd,
      input_tokens: breakdown.total.inputTokens,
      cached_input_tokens: breakdown.total.cachedInputTokens,
      output_tokens: breakdown.total.outputTokens,
      unpriced_rows: breakdown.total.unpricedRows,
    },
  };
}

/**
 * Task read and mutation routes (design.md §12.2). Every mutation goes
 * through `transition()` inside a transaction except `PATCH /tasks/:id`,
 * which does not move `tasks.state` at all (it only sets `runtime_override`
 * and replaces `task_dependencies`), so it writes no `audit_events` row and
 * appends no `execution_events` row -- those are `transition()`'s job and
 * only apply to an actual state change.
 */
export default async function tasksRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks", async (request) => {
    const parsed = TaskListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid query parameters.");
    }
    const { state, project, attention } = parsed.data;

    let stateFilter: TaskState | undefined;
    if (state !== undefined) {
      const stateResult = TaskStateSchema.safeParse(state);
      if (!stateResult.success) {
        throw new AppError(400, "VALIDATION_ERROR", `Unknown state: ${state}`);
      }
      stateFilter = stateResult.data;
    }

    let rows: BoardRow[] = await listBoard(app.db);

    if (project !== undefined) {
      const projectId = await resolveProjectFilter(app.db, project);
      rows = projectId === null ? [] : rows.filter((row) => row.projectId === projectId);
    }

    if (stateFilter !== undefined) {
      rows = rows.filter((row) => row.state === stateFilter);
    }

    if (attention === "1") {
      const attentionIds = new Set(
        (await listAttention(app.db)).map((row) => row.taskId),
      );
      rows = rows.filter((row) => attentionIds.has(row.taskId));
    }

    const taskIds = rows.map((row) => row.taskId);
    const [costByTask, runtimeByTask] = await Promise.all([
      sumTaskCost(app.db, taskIds),
      listBoardRuntimes(app.db, taskIds),
    ]);

    return rows.map((row) => toCard(row, costByTask, runtimeByTask));
  });

  app.get("/tasks/:id", async (request) => {
    const id = parseTaskId(request.params);
    const aggregate = await getTaskAggregate(app.db, id);
    if (!aggregate) {
      throw new AppError(404, "NOT_FOUND", `task not found: ${id}`);
    }
    const [dependencies, costByTask] = await Promise.all([
      listDependencies(app.db, id),
      sumTaskCost(app.db, [id]),
    ]);
    return serializeAggregate(
      aggregate,
      dependencies,
      costByTask.get(id) ?? ZERO_TASK_COST,
    );
  });

  app.get("/tasks/:id/timeline", async (request) => {
    const id = parseTaskId(request.params);

    const queryParsed = TimelineQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "after and limit must be non-negative integers.",
      );
    }
    const { after, limit } = queryParsed.data;

    const limitNum = limit === undefined ? undefined : Number(limit);
    if (limitNum !== undefined && (limitNum < 1 || limitNum > 1000)) {
      throw new AppError(400, "VALIDATION_ERROR", "limit must be between 1 and 1000.");
    }
    const afterNum = after === undefined ? undefined : Number(after);

    const aggregate = await getTaskAggregate(app.db, id);
    if (!aggregate) {
      throw new AppError(404, "NOT_FOUND", `task not found: ${id}`);
    }

    const rows = await listTimeline(app.db, id, {
      after: after === undefined ? undefined : BigInt(after),
      limit: limitNum,
    });

    const nextAfter =
      rows.length > 0 ? Number(rows[rows.length - 1]!.id) : (afterNum ?? 0);

    return {
      events: rows.map((row) => ({ ...row, id: Number(row.id) })),
      nextAfter,
    };
  });

  /** design.md §12.5/§14 task detail cost breakdown; §9.7. */
  app.get("/tasks/:id/costs", async (request) => {
    const id = parseTaskId(request.params);
    const breakdown = await getTaskCostBreakdown(app.db, id);
    if (!breakdown) {
      throw new AppError(404, "NOT_FOUND", `task not found: ${id}`);
    }
    return serializeTaskCostBreakdown(breakdown);
  });

  app.patch("/tasks/:id", async (request, reply) => {
    const id = parseTaskId(request.params);
    const bodyParsed = PatchBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "runtime_override must be 'claude', 'codex', or null; dependencies must be an array of Jira keys.",
      );
    }
    const { runtime_override, dependencies } = bodyParsed.data;

    if (dependencies !== undefined) {
      const seen = new Set<string>();
      for (const key of dependencies) {
        if (seen.has(key)) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            `Duplicate dependency: ${key}`,
          );
        }
        seen.add(key);
      }
    }

    try {
      return await app.db.transaction(async (tx) => {
        // Takes a whole-graph advisory lock before anything else in the
        // transaction -- in particular before `setRuntimeOverride`'s
        // `UPDATE tasks` below -- whenever the request touches dependencies
        // (design.md §12.2, lockDependencyGraph doc comment). Two opposing
        // concurrent PATCHes that both set runtime_override and
        // dependencies used to row-lock their own task first (via
        // setRuntimeOverride) and then request a second, differently-
        // ordered row lock, which could deadlock (Postgres 40P01). An
        // advisory lock taken before either request's first UPDATE has no
        // row order to deadlock on: the second caller just waits here.
        if (dependencies !== undefined) {
          await lockDependencyGraph(tx);
        }

        const existing = await getTaskAggregate(tx, id);
        if (!existing) {
          throw new AppError(404, "NOT_FOUND", `task not found: ${id}`);
        }

        if (runtime_override !== undefined) {
          await setRuntimeOverride(tx, id, runtime_override);
        }

        if (dependencies !== undefined) {
          const { found, unknown } = await resolveTaskIdsByJiraKey(
            tx,
            dependencies,
          );
          if (unknown.length > 0) {
            throw new AppError(
              400,
              "UNKNOWN_DEPENDENCY",
              `Unknown Jira key(s): ${unknown.join(", ")}`,
            );
          }
          const dependsOnTaskIds = dependencies.map((key) => found.get(key)!);

          const cycle = await wouldCreateCycle(tx, id, dependsOnTaskIds);
          if (cycle) {
            throw new DependencyCycleError(cycle.jiraKeys);
          }

          await replaceDependencies(tx, id, dependsOnTaskIds);
        }

        const [aggregate, dependencyRows, costByTask] = await Promise.all([
          getTaskAggregate(tx, id),
          listDependencies(tx, id),
          sumTaskCost(tx, [id]),
        ]);
        return serializeAggregate(
          aggregate!,
          dependencyRows,
          costByTask.get(id) ?? ZERO_TASK_COST,
        );
      });
    } catch (err) {
      if (err instanceof DependencyCycleError) {
        reply.code(409);
        return {
          error: {
            code: "DEPENDENCY_CYCLE",
            message: err.message,
            path: err.path,
          },
        };
      }
      throw err;
    }
  });

  app.post("/tasks/:id/cancel", async (request) => {
    const id = parseTaskId(request.params);
    const actor: Actor = { kind: "user", id: request.user!.id };

    let result: TransitionResult<TaskState>;
    try {
      result = await app.db.transaction(async (tx) => {
        const taskResult = await transition(tx, {
          entity: "task",
          id,
          trigger: "task.cancelled",
          actor,
        });

        const activeExecutionIds = await listActiveExecutionIds(tx, id);
        for (const executionId of activeExecutionIds) {
          await transition(tx, {
            entity: "execution",
            id: executionId,
            trigger: "execution.cancelled",
            actor,
          });
        }

        return taskResult;
      });
    } catch (err) {
      rethrowTransitionError(err);
    }

    return { from: result.from, to: result.to };
  });

  app.post("/tasks/:id/retry", async (request) => {
    const id = parseTaskId(request.params);
    const actor: Actor = { kind: "user", id: request.user!.id };

    let result: TransitionResult<TaskState>;
    try {
      result = await app.db.transaction((tx) =>
        transition(tx, {
          entity: "task",
          id,
          trigger: "human.retry",
          actor,
          set: { needsHumanReason: null },
        }),
      );
    } catch (err) {
      rethrowTransitionError(err);
    }

    return { from: result.from, to: result.to };
  });
}
