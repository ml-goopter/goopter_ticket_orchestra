import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiClient, type ApiClient } from "../api/client.js";
import { createCostsApi, type CostGroup, type CostRow } from "../api/costs.js";
import "../costs/costs.css";
import { formatCompactNumber } from "../costs/format.js";
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

/** Sums the numeric columns across every row (the tiles, and the footer once there is more than one row). */
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
 * restyled to the approved mockup by UR6): group by project, task, or
 * runtime; filter by an optional from/to date range; USD and token totals
 * tiles with a by-kind (main/review/resume) sub-breakdown, and a table with
 * a per-row cost bar sized relative to the largest row cost. The Claude
 * SDK's `total_cost_usd` is an estimate under a subscription login
 * (C28/OI2), so the runtime grouping's `claude` row carries an "estimated"
 * badge -- project/task rows can mix runtimes and so do not.
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

  // Tiles show for one row or more (contract point 2); the footer totals
  // row keeps the pre-restyle rule of needing more than one row, so both
  // read from the same sum rather than computing it twice.
  const totals = rows && rows.length > 0 ? sumRows(rows) : null;
  const maxCost = rows && rows.length > 0 ? Math.max(0, ...rows.map((row) => row.costUsd)) : 0;

  return (
    <>
      <div className="topbar">
        <h1 className="topbar__crumb-current costs-topbar__title">Costs</h1>
        <div className="topbar__spacer" />
        <div className="topbar__actions">
          <span className="costs-toolbar__label">Group by</span>
          <div className="segmented" role="group" aria-label="Group by">
            {GROUPS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={
                  group === option.value ? "segmented__button segmented__button--active" : "segmented__button"
                }
                aria-pressed={group === option.value}
                onClick={() => setGroup(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="costs-toolbar__date">
            <span className="costs-toolbar__label">From</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="costs-toolbar__date">
            <span className="costs-toolbar__label">To</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
      </div>

      <div className="costs-content">
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

        {totals && rows && rows.length > 0 && (
          <div className="costs-tiles">
            <div className="costs-tile">
              <div className="costs-tile__label">Total cost</div>
              <div className="costs-tile__value">{formatUsd(totals.costUsd)}</div>
              <div className="costs-tile__sub">
                Main {formatUsd(totals.mainCostUsd)} · Review {formatUsd(totals.reviewCostUsd)} · Resume{" "}
                {formatUsd(totals.resumeCostUsd)}
              </div>
            </div>
            <div className="costs-tile">
              <div className="costs-tile__label">Input tokens</div>
              <div className="costs-tile__value">{formatCompactNumber(totals.inputTokens)}</div>
              <div className="costs-tile__sub">{formatNumber(totals.inputTokens)}</div>
            </div>
            <div className="costs-tile">
              <div className="costs-tile__label">Cached input tokens</div>
              <div className="costs-tile__value">{formatCompactNumber(totals.cachedInputTokens)}</div>
              <div className="costs-tile__sub">{formatNumber(totals.cachedInputTokens)}</div>
            </div>
            <div className="costs-tile">
              <div className="costs-tile__label">Output tokens</div>
              <div className="costs-tile__value">{formatCompactNumber(totals.outputTokens)}</div>
              <div className="costs-tile__sub">{formatNumber(totals.outputTokens)}</div>
            </div>
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="costs-table">
            <table>
              <thead>
                <tr>
                  <th scope="col" rowSpan={2}>
                    Name
                  </th>
                  <th scope="col" className="num" rowSpan={2}>
                    Cost
                  </th>
                  <th scope="colgroup" colSpan={3} className="costs-table__group-header">
                    Tokens
                  </th>
                  <th scope="colgroup" colSpan={3} className="costs-table__group-header">
                    Cost by kind
                  </th>
                </tr>
                <tr>
                  <th scope="col" className="num costs-table__bl">
                    Input
                  </th>
                  <th scope="col" className="num">
                    Cached input
                  </th>
                  <th scope="col" className="num">
                    Output
                  </th>
                  <th scope="col" className="num costs-table__bl">
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
                  const barWidth = maxCost > 0 ? (row.costUsd / maxCost) * 100 : 0;
                  return (
                    <tr key={row.key.id}>
                      <td>
                        {row.key.label}
                        {estimated && <span className="badge badge--neutral"> (estimated)</span>}
                      </td>
                      <td className="num">
                        <div className="costs-cost">
                          {row.unpricedRows > 0 && (
                            <span className="costs-cost__unpriced">({row.unpricedRows} unpriced)</span>
                          )}
                          <span className="costs-bar">
                            <span className="costs-bar__fill" style={{ width: `${barWidth}%` }} />
                          </span>
                          <b>{formatUsd(row.costUsd)}</b>
                        </div>
                      </td>
                      <td className="num costs-table__bl">{formatNumber(row.inputTokens)}</td>
                      <td className="num">{formatNumber(row.cachedInputTokens)}</td>
                      <td className="num">{formatNumber(row.outputTokens)}</td>
                      <td className="num costs-table__bl">{formatUsd(row.byKind.main.costUsd)}</td>
                      <td className="num">{formatUsd(row.byKind.review.costUsd)}</td>
                      <td className="num">{formatUsd(row.byKind.resume.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {totals && rows.length > 1 && (
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td className="num">{formatUsd(totals.costUsd)}</td>
                    <td className="num costs-table__bl">{formatNumber(totals.inputTokens)}</td>
                    <td className="num">{formatNumber(totals.cachedInputTokens)}</td>
                    <td className="num">{formatNumber(totals.outputTokens)}</td>
                    <td className="num costs-table__bl">{formatUsd(totals.mainCostUsd)}</td>
                    <td className="num">{formatUsd(totals.reviewCostUsd)}</td>
                    <td className="num">{formatUsd(totals.resumeCostUsd)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </>
  );
}
