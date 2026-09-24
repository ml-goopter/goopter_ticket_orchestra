import { eq } from "drizzle-orm";
import { agentWorkers } from "../schema/executions.js";
import type { DbOrTx } from "../transition.js";

export type AgentWorkerRow = typeof agentWorkers.$inferSelect;

export interface UpsertWorkerInput {
  host: string;
  capabilities: string[];
  maxConcurrent: number;
  workspaceRoot: string;
  now: Date;
}

/**
 * Upserts a worker's row in `agent_workers` (design.md §4.2) keyed on the
 * unique `host` column, so a restart updates the same row instead of
 * leaving a stale one behind for the lease sweeper (§6.5) to reason about.
 */
export async function upsertWorker(
  db: DbOrTx,
  input: UpsertWorkerInput,
): Promise<{ id: string }> {
  const values = {
    host: input.host,
    capabilities: input.capabilities,
    maxConcurrent: input.maxConcurrent,
    workspaceRoot: input.workspaceRoot,
    startedAt: input.now,
    lastHeartbeatAt: input.now,
  };

  const [row] = await db
    .insert(agentWorkers)
    .values(values)
    .onConflictDoUpdate({
      target: agentWorkers.host,
      set: {
        capabilities: values.capabilities,
        maxConcurrent: values.maxConcurrent,
        workspaceRoot: values.workspaceRoot,
        startedAt: values.startedAt,
        lastHeartbeatAt: values.lastHeartbeatAt,
      },
    })
    .returning({ id: agentWorkers.id });

  if (!row) {
    throw new Error(`Failed to register worker for host ${input.host}`);
  }
  return row;
}

/** Advances `last_heartbeat_at` for one worker (design.md §6.1, §6.4). */
export async function heartbeatWorker(
  db: DbOrTx,
  workerId: string,
  now: Date,
): Promise<void> {
  await db
    .update(agentWorkers)
    .set({ lastHeartbeatAt: now })
    .where(eq(agentWorkers.id, workerId));
}
