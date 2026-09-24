import type { Db } from "@orchestra/db";
import type { Config } from "./config.js";

/**
 * Decorators set once in `buildApp` (`app.ts`) and read everywhere else:
 * the db client, parsed config, and an injectable clock so tests can
 * control "now" (design.md §12 intro).
 */
declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
    now: () => Date;
  }
}
