import type { ExecutionRole, Runtime, UsageKind } from "@orchestra/core";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { executions, executionUsage } from "../schema/executions.js";
import { projects } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
import type { DbOrTx } from "../transition.js";

/**
 * design.md §9.7, §12.5 `GET /costs`. `cost_usd` on `execution_usage` is
 * nullable (an unpriced/unknown model, §9.7); every sum here treats a null
 * row as 0 and reports how many rows were unpriced via `unpricedRows`.
 */

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface CostTotals {
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Count of summed rows whose `cost_usd` was `NULL` (design.md §9.7). */
  unpricedRows: number;
}

function zeroTotals(): CostTotals {
  return { costUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, unpricedRows: 0 };
}

function addUsageRow(
  totals: CostTotals,
  row: {
    costUsd: string | null;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  },
): void {
  if (row.costUsd === null) {
    totals.unpricedRows += 1;
  } else {
    totals.costUsd = round6(totals.costUsd + Number(row.costUsd));
  }
  totals.inputTokens += row.inputTokens;
  totals.cachedInputTokens += row.cachedInputTokens;
  totals.outputTokens += row.outputTokens;
}

// ---------------------------------------------------------------------------
// GET /costs?group=project|task|runtime&from=&to=
// ---------------------------------------------------------------------------

export type CostGroup = "project" | "task" | "runtime";

export interface CostRow {
  key: { id: string; label: string };
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  unpricedRows: number;
  byKind: Record<UsageKind, CostTotals>;
}

export interface GetCostsOptions {
  group: CostGroup;
  from?: Date;
  to?: Date;
}

/**
 * Sums `execution_usage` (design.md §9.7: "task cost view breaks down into
 * main session, each review round, each resume") joined through
 * `executions` and `tasks`, grouped by project, task, or runtime. Labels are
 * the project's `name`, the task's `jira_key`, or the runtime itself.
 */
export async function getCosts(
  db: DbOrTx,
  options: GetCostsOptions,
): Promise<CostRow[]> {
  const conditions = [];
  if (options.from) conditions.push(gte(executionUsage.recordedAt, options.from));
  if (options.to) conditions.push(lte(executionUsage.recordedAt, options.to));

  const rows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      taskId: tasks.id,
      jiraKey: tasks.jiraKey,
      runtime: executionUsage.runtime,
      kind: executionUsage.kind,
      costUsd: executionUsage.costUsd,
      inputTokens: executionUsage.inputTokens,
      cachedInputTokens: executionUsage.cachedInputTokens,
      outputTokens: executionUsage.outputTokens,
    })
    .from(executionUsage)
    .innerJoin(executions, eq(executions.id, executionUsage.executionId))
    .innerJoin(tasks, eq(tasks.id, executions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const byKey = new Map<string, CostRow>();

  for (const row of rows) {
    const key =
      options.group === "project"
        ? { id: row.projectId, label: row.projectName }
        : options.group === "task"
          ? { id: row.taskId, label: row.jiraKey }
          : { id: row.runtime, label: row.runtime };

    let entry = byKey.get(key.id);
    if (!entry) {
      entry = {
        key,
        costUsd: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        unpricedRows: 0,
        byKind: { main: zeroTotals(), review: zeroTotals(), resume: zeroTotals() },
      };
      byKey.set(key.id, entry);
    }

    if (row.costUsd === null) {
      entry.unpricedRows += 1;
    } else {
      entry.costUsd = round6(entry.costUsd + Number(row.costUsd));
    }
    entry.inputTokens += row.inputTokens;
    entry.cachedInputTokens += row.cachedInputTokens;
    entry.outputTokens += row.outputTokens;

    addUsageRow(entry.byKind[row.kind], row);
  }

  return [...byKey.values()].sort((a, b) => a.key.label.localeCompare(b.key.label));
}

// ---------------------------------------------------------------------------
// GET /tasks/:id/costs
// ---------------------------------------------------------------------------

export interface TaskCostUsageRow {
  id: string;
  kind: UsageKind;
  round: number | null;
  runtime: Runtime;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  recordedAt: Date;
  /** design.md OI2/C28: the Claude SDK's `total_cost_usd` is an estimate. */
  estimated: boolean;
}

export interface TaskExecutionCostBreakdown {
  executionId: string;
  role: ExecutionRole;
  attempt: number;
  runtime: Runtime;
  estimated: boolean;
  usage: TaskCostUsageRow[];
  total: CostTotals;
}

export interface TaskCostBreakdown {
  taskId: string;
  executions: TaskExecutionCostBreakdown[];
  total: CostTotals;
}

/**
 * Per-execution usage breakdown for the task detail (design.md §14 "Task
 * detail" row, §9.7). Returns `null` when the task does not exist so the
 * route can 404. Usage rows are in ascending `recorded_at` order within
 * their execution, and executions are in ascending `created_at` order.
 */
export async function getTaskCostBreakdown(
  db: DbOrTx,
  taskId: string,
): Promise<TaskCostBreakdown | null> {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task) return null;

  const executionRows = await db
    .select({
      id: executions.id,
      role: executions.role,
      attempt: executions.attempt,
      runtime: executions.runtime,
    })
    .from(executions)
    .where(eq(executions.taskId, taskId))
    .orderBy(asc(executions.createdAt));

  const total = zeroTotals();
  if (executionRows.length === 0) {
    return { taskId, executions: [], total };
  }

  const usageRows = await db
    .select({
      id: executionUsage.id,
      executionId: executionUsage.executionId,
      kind: executionUsage.kind,
      round: executionUsage.round,
      runtime: executionUsage.runtime,
      model: executionUsage.model,
      inputTokens: executionUsage.inputTokens,
      cachedInputTokens: executionUsage.cachedInputTokens,
      outputTokens: executionUsage.outputTokens,
      costUsd: executionUsage.costUsd,
      recordedAt: executionUsage.recordedAt,
    })
    .from(executionUsage)
    .where(
      inArray(
        executionUsage.executionId,
        executionRows.map((row) => row.id),
      ),
    )
    .orderBy(asc(executionUsage.recordedAt));

  const usageByExecution = new Map<string, typeof usageRows>();
  for (const row of usageRows) {
    const list = usageByExecution.get(row.executionId) ?? [];
    list.push(row);
    usageByExecution.set(row.executionId, list);
  }

  const executionBreakdowns: TaskExecutionCostBreakdown[] = executionRows.map(
    (execution) => {
      const executionTotal = zeroTotals();
      const estimated = execution.runtime === "claude";
      const usage: TaskCostUsageRow[] = (
        usageByExecution.get(execution.id) ?? []
      ).map((row) => {
        addUsageRow(executionTotal, row);
        return {
          id: row.id,
          kind: row.kind,
          round: row.round,
          runtime: row.runtime,
          model: row.model,
          inputTokens: row.inputTokens,
          cachedInputTokens: row.cachedInputTokens,
          outputTokens: row.outputTokens,
          costUsd: row.costUsd === null ? null : Number(row.costUsd),
          recordedAt: row.recordedAt,
          estimated: row.runtime === "claude",
        };
      });

      total.costUsd = round6(total.costUsd + executionTotal.costUsd);
      total.inputTokens += executionTotal.inputTokens;
      total.cachedInputTokens += executionTotal.cachedInputTokens;
      total.outputTokens += executionTotal.outputTokens;
      total.unpricedRows += executionTotal.unpricedRows;

      return {
        executionId: execution.id,
        role: execution.role,
        attempt: execution.attempt,
        runtime: execution.runtime,
        estimated,
        usage,
        total: executionTotal,
      };
    },
  );

  return { taskId, executions: executionBreakdowns, total };
}
