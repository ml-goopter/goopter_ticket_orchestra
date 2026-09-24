import { upsertWorker, type Db } from "@orchestra/db";
import type { WorkerConfig } from "./config.js";

/**
 * Upserts this process's row in `agent_workers` (design.md §4.2) and returns
 * its id. `host` is unique, so a restart updates the same row rather than
 * leaving a stale worker behind for the lease sweeper (§6.5) to reason about.
 * Capabilities, concurrency and workspace root are refreshed from the current
 * environment, so a config change takes effect on restart.
 */
export async function registerWorker(
  db: Db,
  config: WorkerConfig,
  now: Date = new Date(),
): Promise<string> {
  const { id } = await upsertWorker(db, {
    host: config.host,
    capabilities: config.capabilities,
    maxConcurrent: config.maxConcurrent,
    workspaceRoot: config.workspaceRoot,
    now,
  });
  return id;
}
