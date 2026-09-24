import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;

/**
 * Builds a drizzle client bound to the given Postgres connection string.
 * `db` is the only package that imports drizzle or `postgres` directly
 * (design.md §3); callers get a typed client back.
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}
