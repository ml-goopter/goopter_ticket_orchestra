import { ApiError } from "../api/client.js";

/**
 * Dead-host threshold (design.md §6.1): a worker whose `agent_workers`
 * heartbeat is older than this is treated as dead by the scheduler's
 * sweeper. The workers panel highlights the same threshold (task contract
 * C39) so an admin can see a host is about to be reclaimed before the
 * sweeper acts.
 */
export const DEAD_HOST_THRESHOLD_SECONDS = 15 * 60;

/** `heartbeat_age_seconds` as "Ns ago" under a minute, "Nm ago" at or above it. */
export function formatHeartbeatAge(seconds: number): string {
  if (seconds < 60) {
    return `${Math.floor(seconds)}s ago`;
  }
  return `${Math.floor(seconds / 60)}m ago`;
}

/** True once the heartbeat age exceeds the dead-host threshold (§6.1). */
export function isStaleHeartbeat(seconds: number): boolean {
  return seconds > DEAD_HOST_THRESHOLD_SECONDS;
}

/**
 * Renders `${code}: ${message}` for an api error so a 400/409's exact
 * reason is always visible inline next to the form that triggered it
 * (mirrors `IssueDetailView.tsx`'s `describeApiError`).
 */
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : fallback;
}
