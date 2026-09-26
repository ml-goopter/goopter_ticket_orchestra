import { useEffect, useMemo, useState } from "react";
import { createApiClient, type ApiClient } from "../api/client.js";
import { createCostsApi, type TaskCostBreakdown, type TaskCostUsageRow } from "../api/costs.js";
import { formatCostUsd } from "../board/format.js";

export interface CostBreakdownProps {
  taskId: string;
  /**
   * Injectable for tests; defaults to a real `createApiClient()`'s
   * `request`. An unconfigured test double (e.g. `TaskDetailView.test.tsx`'s
   * fake, whose `request` is a bare `vi.fn()`) resolves to `undefined`,
   * which fails schema validation and lands in the error state below rather
   * than throwing uncaught.
   */
  request?: ApiClient["request"];
}

type LoadState = "loading" | "loaded" | "error";

function formatMaybeCost(cost: number | null): string {
  return cost === null ? "-" : formatCostUsd(cost);
}

function usageLabel(row: TaskCostUsageRow): string {
  if (row.kind === "main") {
    return "Main";
  }
  if (row.kind === "review") {
    return `Review round ${row.round ?? "?"}`;
  }
  return "Resume";
}

/**
 * Per-execution cost breakdown embedded in `TaskDetailView`'s executions
 * section (design.md §9.7, §12.5, task contract GOT.44 part 5): main, each
 * review round, and each resume, with an "estimated" badge on every claude
 * row (C28/OI2 - the Claude SDK's `total_cost_usd` is an estimate under a
 * subscription login).
 */
export function CostBreakdown({ taskId, request }: CostBreakdownProps) {
  const costsApi = useMemo(() => createCostsApi(request ?? createApiClient().request), [request]);
  const [state, setState] = useState<LoadState>("loading");
  const [breakdown, setBreakdown] = useState<TaskCostBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    costsApi
      .getTaskCosts(taskId)
      .then((result) => {
        if (cancelled) return;
        setBreakdown(result);
        setState("loaded");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load costs.");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [costsApi, taskId]);

  if (state === "loading") {
    return <p>Loading costs...</p>;
  }

  if (state === "error") {
    // Not `role="alert"`: `TaskDetailView` already surfaces one action
    // alert at a time, and a second `role="alert"` here would break its
    // `getByRole("alert")` queries by making them ambiguous.
    return <p data-testid="cost-breakdown-error">{error}</p>;
  }

  if (!breakdown || breakdown.executions.length === 0) {
    return <p>No cost data yet.</p>;
  }

  return (
    <div data-testid="cost-breakdown">
      {breakdown.executions.map((execution) => (
        <div key={execution.executionId}>
          <p>
            {execution.role} attempt {execution.attempt} total: {formatCostUsd(execution.total.costUsd)}
            {execution.estimated && <span> (estimated)</span>}
          </p>
          <ul>
            {execution.usage.map((row) => (
              <li key={row.id}>
                {usageLabel(row)}: {formatMaybeCost(row.costUsd)}
                {row.estimated && <span> (estimated)</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p>Task total: {formatCostUsd(breakdown.total.costUsd)}</p>
    </div>
  );
}
