import { renewTaskLease, type DbOrTx } from "@orchestra/db";

/** design.md §6.4: `task_leases.expires_at = now() + 5 min`. */
export const LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * The single implementation of lease renewal for agent-tools calls
 * (design.md §8: "Every call also renews the lease"). Returns the new
 * expiry, or `null` when the execution holds no lease.
 */
export function renewExecutionLease(
  db: DbOrTx,
  executionId: string,
  now: Date,
): Promise<Date | null> {
  return renewTaskLease(
    db,
    executionId,
    new Date(now.getTime() + LEASE_TTL_MS),
  );
}
