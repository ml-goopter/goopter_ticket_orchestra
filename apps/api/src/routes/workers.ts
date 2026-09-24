import { listWorkersWithSlots, type AgentWorkerWithSlots } from "@orchestra/db";
import type { FastifyInstance } from "fastify";

function toResponse(row: AgentWorkerWithSlots) {
  return {
    id: row.id,
    host: row.host,
    capabilities: row.capabilities,
    max_concurrent: row.maxConcurrent,
    workspace_root: row.workspaceRoot,
    last_heartbeat_at: row.lastHeartbeatAt,
    started_at: row.startedAt,
    heartbeat_age_seconds: row.heartbeatAgeSeconds,
    free_slots: row.freeSlots,
  };
}

/**
 * `GET /api/workers` (design.md §12.5): `agent_workers` rows plus derived
 * `heartbeat_age_seconds` and `free_slots` (max_concurrent minus the count
 * of `ASSIGNED`/`RUNNING` executions on that host).
 */
export default async function workersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    const rows = await listWorkersWithSlots(app.db, app.now());
    return rows.map(toResponse);
  });
}
