import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { ExecutionState, TaskState } from "@orchestra/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type { Db } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import * as schema from "../src/schema/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "drizzle");

export interface TestDb {
  /** Drizzle client, same type `createDb` hands back. */
  db: Db;
  /** Raw postgres.js client, for `LISTEN` and count assertions. */
  sql: Sql;
  connectionString: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway `postgres:17` container, applies the committed
 * migrations, and returns a drizzle client plus the raw postgres.js client.
 * One container per test file, matching the pattern in `test/schema.test.ts`
 * (`vitest.config.ts` disables file parallelism so they never race).
 */
export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer =
    await new PostgreSqlContainer("postgres:17").start();
  const connectionString = container.getConnectionUri();
  await runMigrations(connectionString, migrationsFolder);
  const sql = postgres(connectionString);
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    connectionString,
    async stop() {
      await sql.end({ timeout: 5 });
      await container.stop();
    },
  };
}

export interface Fixtures {
  userId: string;
  projectId: string;
  repositoryId: string;
}

/** Inserts the one user / project / repository every task hangs off. */
export async function seedFixtures(db: Db, key: string): Promise<Fixtures> {
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `${key.toLowerCase()}@example.com`,
      passwordHash: "argon2id$stub",
      displayName: key,
    })
    .returning({ id: schema.users.id });

  const [project] = await db
    .insert(schema.projects)
    .values({ key, name: `${key} project`, jiraJql: `project = ${key}` })
    .returning({ id: schema.projects.id });

  const [repository] = await db
    .insert(schema.repositories)
    .values({
      projectId: project!.id,
      name: `${key.toLowerCase()}-repo`,
      gitUrl: `git@example.com:goopter/${key.toLowerCase()}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
    })
    .returning({ id: schema.repositories.id });

  return {
    userId: user!.id,
    projectId: project!.id,
    repositoryId: repository!.id,
  };
}

export interface SeedTaskOptions {
  jiraKey: string;
  state: TaskState;
  summary?: string;
  priority?: number;
  createdAt?: Date;
  withRepository?: boolean;
}

/** Inserts one task and returns its id. */
export async function seedTask(
  db: Db,
  fixtures: Fixtures,
  options: SeedTaskOptions,
): Promise<string> {
  const when = options.createdAt ?? new Date("2026-01-01T00:00:00Z");
  const [row] = await db
    .insert(schema.tasks)
    .values({
      projectId: fixtures.projectId,
      repositoryId:
        options.withRepository === false ? null : fixtures.repositoryId,
      jiraKey: options.jiraKey,
      jiraSummary: options.summary ?? `Summary for ${options.jiraKey}`,
      jiraPriority: options.priority ?? 3,
      jiraCreatedAt: when,
      jiraSyncedAt: when,
      state: options.state,
    })
    .returning({ id: schema.tasks.id });
  return row!.id;
}

export interface SeedExecutionOptions {
  role?: "spec" | "implementation";
  attempt?: number;
  state: ExecutionState;
  runtime?: "claude" | "codex";
  model?: string;
}

/** Inserts one execution on `taskId` and returns its id. */
export async function seedExecution(
  db: Db,
  taskId: string,
  options: SeedExecutionOptions,
): Promise<string> {
  const [row] = await db
    .insert(schema.executions)
    .values({
      taskId,
      role: options.role ?? "implementation",
      attempt: options.attempt ?? 1,
      state: options.state,
      runtime: options.runtime ?? "claude",
      model: options.model ?? "claude-sonnet-5",
    })
    .returning({ id: schema.executions.id });
  return row!.id;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
