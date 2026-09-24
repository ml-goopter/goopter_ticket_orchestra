import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "@orchestra/db";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { registerErrorHandler } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import healthRoutes from "./routes/health.js";
import "./types.js";

export interface AppDeps {
  db: Db;
  config: Config;
  /** Injectable clock; defaults to the wall clock. Tests pin it. */
  now?: () => Date;
}

/**
 * Builds a Fastify instance without listening (design.md §12 intro), so
 * tests can `app.inject` directly. `index.ts` is the only caller that
 * listens.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());

  const app = Fastify({
    logger: { level: deps.config.LOG_LEVEL },
    trustProxy: deps.config.TRUST_PROXY,
  });

  app.decorate("db", deps.db);
  app.decorate("config", deps.config);
  app.decorate("now", now);

  registerErrorHandler(app);

  await app.register(cookie, { secret: deps.config.SESSION_SECRET });
  await app.register(rateLimit, { global: false });

  await app.register(authPlugin);

  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api/auth" });

  return app;
}
