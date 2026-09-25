/**
 * Age in column, derived from `updatedAt` against `now` (user decision
 * Q12): minutes below an hour, hours below a day, days after that.
 * `column_entered_at` does not exist yet (out of scope, GOT.36), so
 * `updatedAt` is the closest proxy the api exposes.
 */
export function formatAge(updatedAt: string, now: Date): string {
  const updated = new Date(updatedAt).getTime();
  const diffMs = Math.max(0, now.getTime() - updated);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Cost so far, formatted as USD with two decimals (e.g. `$1.50`). */
export function formatCostUsd(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}
