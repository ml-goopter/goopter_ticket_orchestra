import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createDb, runMigrations, type Db } from "@orchestra/db";

export interface TestDb {
  /** Drizzle client, the same type `createDb` hands back. */
  db: Db;
  connectionString: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway `postgres:17` container and applies the committed
 * migrations. Mirrors `packages/db/test/harness.ts` deliberately: the worker
 * copies the pattern rather than importing test files across packages.
 * `vitest.config.ts` disables file parallelism so containers never race.
 */
export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer =
    await new PostgreSqlContainer("postgres:17").start();
  const connectionString = container.getConnectionUri();
  await runMigrations(connectionString);
  const db = createDb(connectionString);
  return {
    db,
    connectionString,
    async stop() {
      await db.$client.end({ timeout: 5 });
      await container.stop();
    },
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a value, or throws after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  { timeoutMs = 10000, everyMs = 100, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(everyMs);
  }
}
