import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "@orchestra/db";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { registerErrorHandler } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";
import realtimePlugin, { type RealtimeOptions } from "./realtime/index.js";
import authRoutes from "./routes/auth.js";
import healthRoutes from "./routes/health.js";
import issuesRoutes from "./routes/issues.js";
import notificationsRoutes from "./routes/notifications.js";
import tasksRoutes from "./routes/tasks.js";
import specRoutes from "./routes/spec.js";
import projectsRoutes from "./routes/projects.js";
import repositoriesRoutes from "./routes/repositories.js";
import streamRoutes from "./routes/stream.js";
import usersRoutes from "./routes/users.js";
import workersRoutes from "./routes/workers.js";
import "./types.js";

export interface AppDeps {
  db: Db;
  config: Config;
  /** Injectable clock; defaults to the wall clock. Tests pin it. */
  now?: () => Date;
  /** SSE hub overrides (keepalive interval, row loaders); tests only. */
  realtime?: RealtimeOptions;
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
  await app.register(realtimePlugin, deps.realtime ?? {});

  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(tasksRoutes, { prefix: "/api" });
  await app.register(streamRoutes, { prefix: "/api" });
  await app.register(specRoutes, { prefix: "/api" });
  await app.register(issuesRoutes, { prefix: "/api/issues" });
  await app.register(notificationsRoutes, { prefix: "/api/notifications" });
  await app.register(projectsRoutes, { prefix: "/api/projects" });
  await app.register(repositoriesRoutes, { prefix: "/api/repositories" });
  await app.register(usersRoutes, { prefix: "/api/users" });
  await app.register(workersRoutes, { prefix: "/api/workers" });

  return app;
}
