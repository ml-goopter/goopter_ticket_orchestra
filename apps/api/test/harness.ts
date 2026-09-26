import { sign as signCookie } from "@fastify/cookie";
import type {
  EndReason,
  ExecutionState,
  IssueStatus,
  IssueType,
  NotificationKind,
  ReviewVerdict,
  Runtime,
  Severity,
  TaskState,
} from "@orchestra/core";
import {
  createDb,
  executions,
  executionUsage,
  issues,
  notifications,
  projects,
  repositories,
  reviewResults,
  runMigrations,
  sessions,
  specificationApprovals,
  specificationRevisions,
  taskDecisions,
  taskDependencies,
  tasks,
  users,
  type Db,
} from "@orchestra/db";
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
  /**
   * Raw postgres.js client `createDb` opened internally (`db.$client`),
   * for tagged-template reads that would otherwise need an `eq`-style
   * query operator (forbidden in `apps/api`, design.md §3). Mirrors
   * `packages/db/test/harness.ts`'s `sql`.
   */
  sql: Db["$client"];
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
    sql: db.$client,
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

export interface Fixtures {
  userId: string;
  projectId: string;
  repositoryId: string;
}

/**
 * Inserts the one project / repository every task hangs off, mirroring
 * `packages/db/test/harness.ts` (copied rather than imported across
 * packages, per design.md §3).
 */
export async function seedFixtures(db: Db, key: string): Promise<Fixtures> {
  const user = await seedUser(db, {
    email: `${key.toLowerCase()}@example.com`,
    password: "correct horse battery",
  });

  const [project] = await db
    .insert(projects)
    .values({ key, name: `${key} project`, jiraJql: `project = ${key}` })
    .returning({ id: projects.id });

  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: `${key.toLowerCase()}-repo`,
      gitUrl: `git@example.com:goopter/${key.toLowerCase()}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
    })
    .returning({ id: repositories.id });

  return {
    userId: user.id,
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
  runtimeOverride?: "claude" | "codex" | null;
  needsHumanReason?: string | null;
}

/** Inserts one task and returns its id. */
export async function seedTask(
  db: Db,
  fixtures: Fixtures,
  options: SeedTaskOptions,
): Promise<string> {
  const when = options.createdAt ?? new Date("2026-01-01T00:00:00Z");
  const [row] = await db
    .insert(tasks)
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
      runtimeOverride: options.runtimeOverride ?? null,
      needsHumanReason: options.needsHumanReason ?? null,
    })
    .returning({ id: tasks.id });
  return row!.id;
}

export interface SeedExecutionOptions {
  role?: "spec" | "implementation";
  attempt?: number;
  state: ExecutionState;
  runtime?: Runtime;
  model?: string;
  costUsd?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  specRevisionId?: string | null;
  sessionId?: string | null;
  branch?: string | null;
  endReason?: EndReason | null;
  createdAt?: Date;
}

/** Inserts one execution on `taskId` and returns its id. */
export async function seedExecution(
  db: Db,
  taskId: string,
  options: SeedExecutionOptions,
): Promise<string> {
  const [row] = await db
    .insert(executions)
    .values({
      taskId,
      role: options.role ?? "implementation",
      attempt: options.attempt ?? 1,
      state: options.state,
      runtime: options.runtime ?? "claude",
      model: options.model ?? "claude-sonnet-5",
      costUsd: options.costUsd ?? "0",
      inputTokens: options.inputTokens ?? 0,
      cachedInputTokens: options.cachedInputTokens ?? 0,
      outputTokens: options.outputTokens ?? 0,
      specRevisionId: options.specRevisionId ?? null,
      sessionId: options.sessionId ?? null,
      branch: options.branch ?? null,
      endReason: options.endReason ?? null,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning({ id: executions.id });
  return row!.id;
}

export interface SeedExecutionUsageOptions {
  kind?: "main" | "review" | "resume";
  round?: number | null;
  runtime?: Runtime;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Decimal string; `null` for an unpriced (unknown-model) row (design.md §9.7). */
  costUsd?: string | null;
  recordedAt?: Date;
}

/** Inserts one `execution_usage` row directly (design.md §4.2, §9.7). */
export async function seedExecutionUsage(
  db: Db,
  executionId: string,
  options: SeedExecutionUsageOptions = {},
): Promise<string> {
  const [row] = await db
    .insert(executionUsage)
    .values({
      executionId,
      kind: options.kind ?? "main",
      round: options.round ?? null,
      runtime: options.runtime ?? "claude",
      model: options.model ?? "claude-sonnet-5",
      inputTokens: options.inputTokens ?? 0,
      cachedInputTokens: options.cachedInputTokens ?? 0,
      outputTokens: options.outputTokens ?? 0,
      costUsd: options.costUsd === undefined ? "0" : options.costUsd,
      ...(options.recordedAt ? { recordedAt: options.recordedAt } : {}),
    })
    .returning({ id: executionUsage.id });
  if (!row) throw new Error("seedExecutionUsage: insert returned no row");
  return row.id;
}

/** Inserts one `task_dependencies` row directly. */
export async function seedDependency(
  db: Db,
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  await db.insert(taskDependencies).values({ taskId, dependsOnTaskId });
}

/**
 * `audit_events` rows for one entity, read via the raw `sql` client since
 * `apps/api` cannot import an `eq`-style query operator (design.md §3).
 * Columns are aliased to match `auditEvents`'s camelCase field names.
 */
export async function listAuditEventsForEntity(
  sql: Db["$client"],
  entityId: string,
): Promise<Array<{ toState: string }>> {
  return sql<{ toState: string }[]>`
    select to_state as "toState" from audit_events where entity_id = ${entityId}
  `;
}

/** `execution_events` rows for one task, read via the raw `sql` client. */
export async function listExecutionEventsForTask(
  sql: Db["$client"],
  taskId: string,
): Promise<Array<{ type: string }>> {
  return sql<{ type: string }[]>`
    select type from execution_events where task_id = ${taskId}
  `;
}

/** One `executions` row by id, read via the raw `sql` client. */
export async function findExecutionById(
  sql: Db["$client"],
  executionId: string,
): Promise<{ state: string } | null> {
  const rows = await sql<{ state: string }[]>`
    select state from executions where id = ${executionId}
  `;
  return rows[0] ?? null;
}

export interface SeedRevisionOptions {
  createdBy?: string | null;
}

/** Inserts one `specification_revisions` row directly, mirroring spec.test.ts's local helper. */
export async function seedRevision(
  db: Db,
  taskId: string,
  version: number,
  status: "draft" | "approved" | "superseded",
  content: unknown,
  options: SeedRevisionOptions = {},
): Promise<string> {
  const [row] = await db
    .insert(specificationRevisions)
    .values({
      taskId,
      version,
      status,
      content,
      createdBy: options.createdBy ?? null,
    })
    .returning({ id: specificationRevisions.id });
  if (!row) throw new Error("seedRevision: insert returned no row");
  return row.id;
}

export interface SeedApprovalOptions {
  approvedBy: string;
  runtime?: Runtime;
  approvedAt?: Date;
}

/** Inserts one `specification_approvals` row directly. */
export async function seedApproval(
  db: Db,
  revisionId: string,
  options: SeedApprovalOptions,
): Promise<string> {
  const [row] = await db
    .insert(specificationApprovals)
    .values({
      revisionId,
      approvedBy: options.approvedBy,
      approvedAt: options.approvedAt ?? new Date("2026-01-01T00:00:00Z"),
      runtime: options.runtime ?? "claude",
    })
    .returning({ id: specificationApprovals.id });
  if (!row) throw new Error("seedApproval: insert returned no row");
  return row.id;
}

export interface SeedTaskDecisionOptions {
  taskId: string;
  issueId: string;
  decision?: string;
  clarification?: string | null;
  chosenOption?: string | null;
  decidedBy: string;
  decidedAt?: Date;
}

/** Inserts one `task_decisions` row directly. */
export async function seedTaskDecision(
  db: Db,
  options: SeedTaskDecisionOptions,
): Promise<string> {
  const [row] = await db
    .insert(taskDecisions)
    .values({
      taskId: options.taskId,
      issueId: options.issueId,
      decision: options.decision ?? "Proceed as clarified.",
      clarification: options.clarification ?? null,
      chosenOption: options.chosenOption ?? null,
      decidedBy: options.decidedBy,
      decidedAt: options.decidedAt ?? new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: taskDecisions.id });
  if (!row) throw new Error("seedTaskDecision: insert returned no row");
  return row.id;
}

export interface SeedReviewResultOptions {
  round?: number;
  verdict?: ReviewVerdict;
  findings?: unknown;
  reviewerRuntime?: Runtime;
  createdAt?: Date;
}

/** Inserts one `review_results` row directly. */
export async function seedReviewResult(
  db: Db,
  executionId: string,
  options: SeedReviewResultOptions = {},
): Promise<string> {
  const [row] = await db
    .insert(reviewResults)
    .values({
      executionId,
      round: options.round ?? 1,
      verdict: options.verdict ?? "findings",
      findings: options.findings ?? [
        { severity: "warning", description: "Nit.", action: "Fix later." },
      ],
      reviewerRuntime: options.reviewerRuntime ?? "claude",
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning({ id: reviewResults.id });
  if (!row) throw new Error("seedReviewResult: insert returned no row");
  return row.id;
}

export interface SeedIssueOptions {
  taskId: string;
  executionId: string;
  type?: IssueType;
  severity?: Severity;
  blocking: boolean;
  title?: string;
  description?: string;
  question?: string | null;
  status?: IssueStatus;
  createdAt?: Date;
}

/** Inserts one `issues` row directly, oldest first when seeded in order. */
export async function seedIssue(db: Db, options: SeedIssueOptions): Promise<string> {
  const [row] = await db
    .insert(issues)
    .values({
      taskId: options.taskId,
      executionId: options.executionId,
      type: options.type ?? "QUESTION",
      severity: options.severity ?? "blocking",
      blocking: options.blocking,
      title: options.title ?? "An issue",
      description: options.description ?? "Issue description",
      question: options.question ?? null,
      status: options.status ?? "OPEN",
      createdAt: options.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: issues.id });
  if (!row) throw new Error("seedIssue: insert returned no row");
  return row.id;
}

export interface SeedNotificationOptions {
  userId?: string | null;
  taskId: string;
  issueId?: string | null;
  kind?: NotificationKind;
  title?: string;
  readAt?: Date | null;
  createdAt?: Date;
}

/** Inserts one `notifications` row directly. */
export async function seedNotification(
  db: Db,
  options: SeedNotificationOptions,
): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: options.userId ?? null,
      taskId: options.taskId,
      issueId: options.issueId ?? null,
      kind: options.kind ?? "issue_raised",
      title: options.title ?? "Notification",
      readAt: options.readAt ?? null,
      createdAt: options.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: notifications.id });
  if (!row) throw new Error("seedNotification: insert returned no row");
  return row.id;
}
