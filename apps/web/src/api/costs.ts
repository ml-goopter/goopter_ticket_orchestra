import { z } from "zod";
import type { ApiClient } from "./client.js";

/**
 * Standalone client for `GET /costs` and `GET /tasks/:id/costs` (design.md
 * §12.5, §9.7, task contract GOT.44 part 5). Kept out of `client.ts` /
 * `types.ts` deliberately: those files are owned by GOT.38 while this task
 * runs concurrently, so this module only depends on the `request` function
 * type and defines its own schemas rather than widening either file.
 */

export type CostGroup = "project" | "task" | "runtime";
export type UsageKind = "main" | "review" | "resume";

export interface CostKey {
  id: string;
  label: string;
}

export interface CostTotals {
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  unpricedRows: number;
}

export interface CostRow {
  key: CostKey;
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  unpricedRows: number;
  byKind: Record<UsageKind, CostTotals>;
}

export interface TaskCostUsageRow {
  id: string;
  kind: UsageKind;
  round: number | null;
  runtime: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  recordedAt: string;
  estimated: boolean;
}

export interface TaskExecutionCost {
  executionId: string;
  role: string;
  attempt: number;
  runtime: string;
  estimated: boolean;
  usage: TaskCostUsageRow[];
  total: CostTotals;
}

export interface TaskCostBreakdown {
  taskId: string;
  executions: TaskExecutionCost[];
  total: CostTotals;
}

export interface GetCostsParams {
  group: CostGroup;
  /** ISO timestamp; inclusive lower bound on `execution_usage.recorded_at`. */
  from?: string;
  /** ISO timestamp; inclusive upper bound on `execution_usage.recorded_at`. */
  to?: string;
}

export interface CostsApi {
  getCosts(params: GetCostsParams): Promise<CostRow[]>;
  getTaskCosts(taskId: string): Promise<TaskCostBreakdown>;
}

const CostKeySchema = z.object({ id: z.string(), label: z.string() });

const CostTotalsSchema = z.object({
  cost_usd: z.number(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  unpriced_rows: z.number(),
});

const CostRowSchema = z.object({
  key: CostKeySchema,
  cost_usd: z.number(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  unpriced_rows: z.number(),
  by_kind: z.object({
    main: CostTotalsSchema,
    review: CostTotalsSchema,
    resume: CostTotalsSchema,
  }),
});

const TaskCostUsageRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["main", "review", "resume"]),
  round: z.number().nullable(),
  runtime: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number().nullable(),
  recorded_at: z.string(),
  estimated: z.boolean(),
});

const TaskExecutionCostSchema = z.object({
  execution_id: z.string(),
  role: z.string(),
  attempt: z.number(),
  runtime: z.string(),
  estimated: z.boolean(),
  usage: z.array(TaskCostUsageRowSchema),
  total: CostTotalsSchema,
});

const TaskCostBreakdownSchema = z.object({
  task_id: z.string(),
  executions: z.array(TaskExecutionCostSchema),
  total: CostTotalsSchema,
});

function mapTotals(totals: z.infer<typeof CostTotalsSchema>): CostTotals {
  return {
    costUsd: totals.cost_usd,
    inputTokens: totals.input_tokens,
    cachedInputTokens: totals.cached_input_tokens,
    outputTokens: totals.output_tokens,
    unpricedRows: totals.unpriced_rows,
  };
}

function mapRow(row: z.infer<typeof CostRowSchema>): CostRow {
  return {
    key: row.key,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    unpricedRows: row.unpriced_rows,
    byKind: {
      main: mapTotals(row.by_kind.main),
      review: mapTotals(row.by_kind.review),
      resume: mapTotals(row.by_kind.resume),
    },
  };
}

function mapUsageRow(row: z.infer<typeof TaskCostUsageRowSchema>): TaskCostUsageRow {
  return {
    id: row.id,
    kind: row.kind,
    round: row.round,
    runtime: row.runtime,
    model: row.model,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    recordedAt: row.recorded_at,
    estimated: row.estimated,
  };
}

function mapExecution(execution: z.infer<typeof TaskExecutionCostSchema>): TaskExecutionCost {
  return {
    executionId: execution.execution_id,
    role: execution.role,
    attempt: execution.attempt,
    runtime: execution.runtime,
    estimated: execution.estimated,
    usage: execution.usage.map(mapUsageRow),
    total: mapTotals(execution.total),
  };
}

function mapBreakdown(breakdown: z.infer<typeof TaskCostBreakdownSchema>): TaskCostBreakdown {
  return {
    taskId: breakdown.task_id,
    executions: breakdown.executions.map(mapExecution),
    total: mapTotals(breakdown.total),
  };
}

/**
 * Builds a leading `?a=b&c=d` query string, omitting any key whose value is
 * `undefined`. Duplicated from `client.ts`'s private helper of the same
 * shape rather than imported: that file is owned by GOT.38 concurrently.
 */
function buildQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/** Builds a costs client from a bare `request` function (design.md §12.5). */
export function createCostsApi(request: ApiClient["request"]): CostsApi {
  return {
    getCosts: async ({ group, from, to }) => {
      const json = await request<unknown>("GET", `/costs${buildQuery({ group, from, to })}`);
      return z.array(CostRowSchema).parse(json).map(mapRow);
    },
    getTaskCosts: async (taskId) => {
      const json = await request<unknown>("GET", `/tasks/${taskId}/costs`);
      return mapBreakdown(TaskCostBreakdownSchema.parse(json));
    },
  };
}
