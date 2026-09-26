import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiClient, type ApiClient } from "../api/client.js";
import { createCostsApi, type CostGroup, type CostRow } from "../api/costs.js";
import { formatCostUsd } from "../board/format.js";
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

/**
 * Costs (design.md §14, §12.5 `GET /costs`, task contract GOT.44 part 5):
 * group by project, task, or runtime; filter by an optional from/to date
 * range; USD and token totals with a by-kind (main/review/resume)
 * sub-breakdown. The Claude SDK's `total_cost_usd` is an estimate under a
 * subscription login (C28/OI2), so the runtime grouping's `claude` row
 * carries an "estimated" badge -- project/task rows can mix runtimes and so
 * do not.
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

  return (
    <main>
      <h1>Costs</h1>
      <form onSubmit={(event) => event.preventDefault()}>
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
        <label>
          From
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </form>

      {error && <p role="alert">{error}</p>}
      {!error && rows === null && <p>Loading...</p>}
      {rows && rows.length === 0 && <p>No costs recorded yet.</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Cost</th>
              <th scope="col">Input tokens</th>
              <th scope="col">Cached input tokens</th>
              <th scope="col">Output tokens</th>
              <th scope="col">Main</th>
              <th scope="col">Review</th>
              <th scope="col">Resume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const estimated = group === "runtime" && row.key.id === "claude";
              return (
                <tr key={row.key.id}>
                  <td>
                    {row.key.label}
                    {estimated && <span> (estimated)</span>}
                  </td>
                  <td>
                    {formatCostUsd(row.costUsd)}
                    {row.unpricedRows > 0 && <span> ({row.unpricedRows} unpriced)</span>}
                  </td>
                  <td>{row.inputTokens}</td>
                  <td>{row.cachedInputTokens}</td>
                  <td>{row.outputTokens}</td>
                  <td>{formatCostUsd(row.byKind.main.costUsd)}</td>
                  <td>{formatCostUsd(row.byKind.review.costUsd)}</td>
                  <td>{formatCostUsd(row.byKind.resume.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
