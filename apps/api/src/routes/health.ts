import type { FastifyInstance } from "fastify";

/**
 * `GET /api/health` (auth plugin's public route list, design.md §13):
 * liveness only, no cookie required.
 */
export default async function healthRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));
}
