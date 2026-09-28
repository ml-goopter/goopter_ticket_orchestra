import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiClient, type ApiClient } from "../api/client.js";
import { createCostsApi, type CostGroup, type CostRow } from "../api/costs.js";
import { formatNumber, formatUsd } from "../ui/number.js";
import { useLatestRequest } from "../board/useLatestRequest.js";

export interface CostsViewProps {
  /** Injectable for tests; defaults to a real `createApiClient()`'s `request`. */
  request?: ApiClient["request"];
}

const GROUPS: Array<{ value: CostGroup; label: string }> = [
  { value: "project", label: "Project" },
  { value: "task", label: "Task" },
  { value: "runtime", label: "Runtime" },
];

/** `yyyy-mm-dd` (an `<input type="date">`'s value) as a start-of-day UTC ISO timestamp. */
function dateInputToIso(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

interface RowTotals {
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  mainCostUsd: number;
  reviewCostUsd: number;
  resumeCostUsd: number;
}

/** Sums the numeric columns across every row (contract point 4: a totals row once there is more than one). */
function sumRows(rows: CostRow[]): RowTotals {
  return rows.reduce<RowTotals>(
    (acc, row) => ({
      costUsd: acc.costUsd + row.costUsd,
      inputTokens: acc.inputTokens + row.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + row.cachedInputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
      mainCostUsd: acc.mainCostUsd + row.byKind.main.costUsd,
      reviewCostUsd: acc.reviewCostUsd + row.byKind.review.costUsd,
      resumeCostUsd: acc.resumeCostUsd + row.byKind.resume.costUsd,
    }),
    { costUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, mainCostUsd: 0, reviewCostUsd: 0, resumeCostUsd: 0 },
  );
}

/**
 * Costs (design.md §14, §12.5 `GET /costs`, task contract GOT.44 part 5;
 * restyled by U5): group by project, task, or runtime; filter by an
 * optional from/to date range; USD and token totals with a by-kind
 * (main/review/resume) sub-breakdown. The Claude SDK's `total_cost_usd` is
 * an estimate under a subscription login (C28/OI2), so the runtime
 * grouping's `claude` row carries an "estimated" badge -- project/task
 * rows can mix runtimes and so do not.
 */
export function CostsView({ request }: CostsViewProps = {}) {
  const costsApi = useMemo(() => createCostsApi(request ?? createApiClient().request), [request]);
  const [group, setGroup] = useState<CostGroup>("project");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<CostRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { begin, isCurrent } = useLatestRequest();

  const fetchRows = useCallback(async () => {
    const generation = begin();
    setError(null);
    try {
      const result = await costsApi.getCosts({
        group,
        from: from ? dateInputToIso(from) : undefined,
        to: to ? dateInputToIso(to) : undefined,
      });
      if (!isCurrent(generation)) return;
      setRows(result);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setRows(null);
      setError(err instanceof Error ? err.message : "Failed to load costs.");
    }
  }, [costsApi, group, from, to, begin, isCurrent]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const totals = rows && rows.length > 1 ? sumRows(rows) : null;

  return (
    <>
      <div className="page-header">
        <h1 className="page-header__title">Costs</h1>
      </div>

      <form className="toolbar" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label>
            Group by
            <select value={group} onChange={(event) => setGroup(event.target.value as CostGroup)}>
              {GROUPS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <label>
            From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
        </div>
        <div className="field">
          <label>
            To
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
      </form>

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}
      {!error && rows === null && <p>Loading...</p>}
      {rows && rows.length === 0 && (
        <div className="empty-state">
          <p>No costs recorded yet.</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="num">
                Cost
              </th>
              <th scope="col" className="num">
                Input tokens
              </th>
              <th scope="col" className="num">
                Cached input tokens
              </th>
              <th scope="col" className="num">
                Output tokens
              </th>
              <th scope="col" className="num">
                Main
              </th>
              <th scope="col" className="num">
                Review
              </th>
              <th scope="col" className="num">
                Resume
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const estimated = group === "runtime" && row.key.id === "claude";
              return (
                <tr key={row.key.id}>
                  <td>
                    {row.key.label}
                    {estimated && <span className="badge badge--neutral"> (estimated)</span>}
                  </td>
                  <td className="num">
                    {formatUsd(row.costUsd)}
                    {row.unpricedRows > 0 && <span> ({row.unpricedRows} unpriced)</span>}
                  </td>
                  <td className="num">{formatNumber(row.inputTokens)}</td>
                  <td className="num">{formatNumber(row.cachedInputTokens)}</td>
                  <td className="num">{formatNumber(row.outputTokens)}</td>
                  <td className="num">{formatUsd(row.byKind.main.costUsd)}</td>
                  <td className="num">{formatUsd(row.byKind.review.costUsd)}</td>
                  <td className="num">{formatUsd(row.byKind.resume.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
          {totals && (
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="num">{formatUsd(totals.costUsd)}</td>
                <td className="num">{formatNumber(totals.inputTokens)}</td>
                <td className="num">{formatNumber(totals.cachedInputTokens)}</td>
                <td className="num">{formatNumber(totals.outputTokens)}</td>
                <td className="num">{formatUsd(totals.mainCostUsd)}</td>
                <td className="num">{formatUsd(totals.reviewCostUsd)}</td>
                <td className="num">{formatUsd(totals.resumeCostUsd)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </>
  );
}
