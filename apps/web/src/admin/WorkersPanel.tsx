import { useCallback, useEffect, useState } from "react";
import type { AdminApi, Worker } from "../api/admin.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { describeApiError, formatHeartbeatAge, isStaleHeartbeat } from "./format.js";

export interface WorkersPanelProps {
  adminApi: AdminApi;
}

/** How often the panel refetches while mounted (task contract point 2). */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * Workers panel (design.md §14 Admin row, §12.5 `/workers`, §6.1 dead-host
 * threshold, task contract GOT.29): read-only list with host, capabilities,
 * capacity, and heartbeat age; a stale highlight past the 15 minute
 * dead-host threshold; a manual refresh and an automatic refetch every 30s
 * while this panel is mounted.
 */
export function WorkersPanel({ adminApi }: WorkersPanelProps) {
  const { begin, isCurrent } = useLatestRequest();
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchWorkers = useCallback(async () => {
    const generation = begin();
    setLoadError(null);
    try {
      const rows = await adminApi.listWorkers();
      if (!isCurrent(generation)) return;
      setWorkers(rows);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setWorkers(null);
      setLoadError(describeApiError(err, "Failed to load workers."));
    }
  }, [adminApi, begin, isCurrent]);

  useEffect(() => {
    void fetchWorkers();
  }, [fetchWorkers]);

  useEffect(() => {
    const interval = setInterval(() => void fetchWorkers(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchWorkers]);

  return (
    <section aria-label="Workers">
      <h2>Workers</h2>
      <button type="button" onClick={() => void fetchWorkers()}>
        Refresh
      </button>

      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && workers === null && <p>Loading...</p>}
      {workers && workers.length === 0 && <p>No workers registered.</p>}
      {workers && workers.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Host</th>
              <th scope="col">Capabilities</th>
              <th scope="col">Max slots</th>
              <th scope="col">Free slots</th>
              <th scope="col">Heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((worker) => {
              const stale = isStaleHeartbeat(worker.heartbeatAgeSeconds);
              return (
                <tr key={worker.id} data-stale={stale}>
                  <td>{worker.host}</td>
                  <td>{worker.capabilities.join(", ")}</td>
                  <td>{worker.maxConcurrent}</td>
                  <td>{worker.freeSlots}</td>
                  <td>
                    {formatHeartbeatAge(worker.heartbeatAgeSeconds)}
                    {stale && (
                      <span role="status" data-testid="stale-marker">
                        {" "}
                        stale
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
