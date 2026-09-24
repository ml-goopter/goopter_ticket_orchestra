import { sign as signCookie } from "@fastify/cookie";
import { createDb, runMigrations, sessions, users, type Db } from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { SESSION_COOKIE_NAME } from "../src/plugins/auth.js";
import { hashPassword } from "../src/lib/passwords.js";

export interface TestDb {
  db: Db;
  connectionString: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway `postgres:17` container and applies the committed
 * `@orchestra/db` migrations, mirroring `packages/db/test/harness.ts`
 * (copied rather than imported across packages, per design.md §3).
 * `runMigrations` defaults its migrations folder relative to its own
 * module location inside `@orchestra/db`, so no cross-package path needs
 * to be hard-coded here. `db.$client` is the raw postgres.js pool
 * `createDb` opened internally, kept only to close it on `stop()`.
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

/** Mutable clock so tests can advance "now" between requests (AC3). */
export interface Clock {
  now(): Date;
  set(date: Date): void;
  advance(ms: number): void;
}

export function createClock(
  start: Date = new Date("2026-01-01T00:00:00Z"),
): Clock {
  let current = start;
  return {
    now: () => current,
    set(date: Date) {
      current = date;
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

const TEST_SESSION_SECRET = "test-session-secret-at-least-32-bytes!!";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://unused",
    SESSION_SECRET: TEST_SESSION_SECRET,
    PORT: 0,
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
    TRUST_PROXY: false,
    ...overrides,
  };
}

/** Builds the app against a running test db with an injectable clock. */
export async function buildTestApp(
  testDb: TestDb,
  clock: Clock = createClock(),
  configOverrides: Partial<Config> = {},
): Promise<FastifyInstance> {
  const config = testConfig({
    DATABASE_URL: testDb.connectionString,
    ...configOverrides,
  });
  return buildApp({ db: testDb.db, config, now: clock.now });
}

export interface SeedUserOptions {
  email: string;
  password: string;
  displayName?: string;
  disabled?: boolean;
}

export interface SeededUser {
  id: string;
  email: string;
  displayName: string;
}

export async function seedUser(
  db: Db,
  options: SeedUserOptions,
): Promise<SeededUser> {
  const passwordHash = await hashPassword(options.password);
  const [row] = await db
    .insert(users)
    .values({
      email: options.email,
      passwordHash,
      displayName: options.displayName ?? options.email,
      disabledAt: options.disabled ? new Date() : null,
    })
    .returning({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
    });
  if (!row) throw new Error("seedUser: insert returned no row");
  return row;
}

export interface SeedSessionOptions {
  userId: string;
  expiresAt: Date;
  lastSeenAt?: Date;
}

/** Inserts a session row directly, bypassing login (for expiry tests). */
export async function seedSession(
  db: Db,
  options: SeedSessionOptions,
): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({
      userId: options.userId,
      expiresAt: options.expiresAt,
      lastSeenAt: options.lastSeenAt ?? options.expiresAt,
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error("seedSession: insert returned no row");
  return row.id;
}

/** Signs a raw session id the same way `@fastify/cookie` does. */
export function signSessionId(
  sessionId: string,
  secret: string = TEST_SESSION_SECRET,
): string {
  return signCookie(sessionId, secret);
}

/** `Cookie` header value for a given raw (unsigned) session id. */
export function sessionCookieHeader(
  sessionId: string,
  secret: string = TEST_SESSION_SECRET,
): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(signSessionId(sessionId, secret))}`;
}
