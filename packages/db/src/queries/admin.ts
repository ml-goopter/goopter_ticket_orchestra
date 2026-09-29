import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Runtime } from "@orchestra/core";
import type { Db } from "../client.js";
import { agentWorkers, executions } from "../schema/executions.js";
import { projects, repositories } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
import { users } from "../schema/users.js";
import type { DbOrTx } from "../transition.js";
// `ProjectRow`, `RepositoryRow` (task-aggregate.ts) and `AgentWorkerRow`
// (workers.ts) already exist with this exact shape; reusing them (rather
// than redeclaring `typeof projects.$inferSelect` etc. here) avoids the
// duplicate-export ambiguity `queries/index.ts`'s `export *` barrel would
// otherwise hit.
import type { ProjectRow, RepositoryRow } from "./task-aggregate.js";
import type { AgentWorkerRow } from "./workers.js";

/** Postgres SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505";

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code
    : undefined;
}

/**
 * Same unwrap as `queries/auth.ts`'s `insertUser`: `postgres.js` sets
 * `.code` to the SQLSTATE, but drizzle wraps that error in a
 * `DrizzleQueryError` and puts the original on `.cause`.
 */
function isUniqueViolation(err: unknown): boolean {
  if (errorCode(err) === UNIQUE_VIOLATION) return true;
  if (err instanceof Error && err.cause) {
    return errorCode(err.cause) === UNIQUE_VIOLATION;
  }
  return false;
}

/**
 * Thrown by the admin insert/update helpers below when a unique constraint
 * is violated (design.md §12.5: projects.key, repositories (project_id,
 * name)). Routes catch this and map it to 409 CONFLICT.
 */
export class UniqueViolationError extends Error {
  readonly entity: "project" | "repository";
  readonly fields: string[];

  constructor(entity: "project" | "repository", fields: string[]) {
    super(`${entity} violates uniqueness on ${fields.join(", ")}.`);
    this.name = "UniqueViolationError";
    this.entity = entity;
    this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface InsertProjectInput {
  key: string;
  name: string;
  jiraJql: string;
  maxInfraRetries: number;
  maxProtocolRetries: number;
  maxCiRounds: number;
  maxReviewRounds: number;
  /** design.md build-order Q9. Decimal string or `null`; omitted means `null`. */
  maxBudgetUsd?: string | null;
}

/** Inserts one project row. A duplicate `key` surfaces as `UniqueViolationError`. */
export async function insertProject(
  db: DbOrTx,
  input: InsertProjectInput,
): Promise<ProjectRow> {
  try {
    const [row] = await db.insert(projects).values(input).returning();
    if (!row) {
      throw new Error("Failed to insert project.");
    }
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new UniqueViolationError("project", ["key"]);
    }
    throw err;
  }
}

export async function listProjects(db: DbOrTx): Promise<ProjectRow[]> {
  return db.select().from(projects).orderBy(asc(projects.createdAt));
}

export async function getProjectById(
  db: DbOrTx,
  id: string,
): Promise<ProjectRow | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return row ?? null;
}

export type UpdateProjectInput = Partial<InsertProjectInput>;

/** Patches a subset of a project's columns. Returns `null` if `id` is unknown. */
export async function updateProject(
  db: DbOrTx,
  id: string,
  patch: UpdateProjectInput,
): Promise<ProjectRow | null> {
  if (Object.keys(patch).length === 0) {
    return getProjectById(db, id);
  }
  try {
    const [row] = await db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, id))
      .returning();
    return row ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new UniqueViolationError("project", ["key"]);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface InsertRepositoryInput {
  projectId: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  defaultRuntime: Runtime;
  defaultModel: string | null;
  maxConcurrentWorktrees: number;
  requiredCapability: string | null;
  setupCommand: string | null;
  /** design.md OI3 (C15). Omitted means null. */
  testCommand?: string | null;
  /** design.md §9.9, D20. Omitted means the column default (`false`). */
  agentContainer?: boolean;
  /** design.md §9.9. Omitted means null. */
  agentImage?: string | null;
}

/**
 * Inserts one repository row. A duplicate `(project_id, name)` surfaces as
 * `UniqueViolationError`. The caller is responsible for checking
 * `project_id` exists first (design.md §12.5: unknown project → 400, not a
 * constraint violation).
 */
export async function insertRepository(
  db: DbOrTx,
  input: InsertRepositoryInput,
): Promise<RepositoryRow> {
  try {
    const [row] = await db.insert(repositories).values(input).returning();
    if (!row) {
      throw new Error("Failed to insert repository.");
    }
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new UniqueViolationError("repository", ["projectId", "name"]);
    }
    throw err;
  }
}

export interface ListRepositoriesOptions {
  projectId?: string;
}

export async function listRepositories(
  db: DbOrTx,
  options: ListRepositoriesOptions = {},
): Promise<RepositoryRow[]> {
  if (options.projectId === undefined) {
    return db
      .select()
      .from(repositories)
      .orderBy(asc(repositories.createdAt));
  }
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, options.projectId))
    .orderBy(asc(repositories.createdAt));
}

export async function getRepositoryById(
  db: DbOrTx,
  id: string,
): Promise<RepositoryRow | null> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, id))
    .limit(1);
  return row ?? null;
}

export type UpdateRepositoryInput = Partial<InsertRepositoryInput>;

/** Patches a subset of a repository's columns. Returns `null` if `id` is unknown. */
export async function updateRepository(
  db: DbOrTx,
  id: string,
  patch: UpdateRepositoryInput,
): Promise<RepositoryRow | null> {
  if (Object.keys(patch).length === 0) {
    return getRepositoryById(db, id);
  }
  try {
    const [row] = await db
      .update(repositories)
      .set(patch)
      .where(eq(repositories.id, id))
      .returning();
    return row ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new UniqueViolationError("repository", ["projectId", "name"]);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Deletion (GOT.52, tracker 2026-09-28 O1/D2)
// ---------------------------------------------------------------------------

export type AdminDeleteResult =
  | { status: "not_found" }
  | { status: "blocked"; taskCount: number }
  | { status: "deleted" };

/**
 * Deletes a repository iff no task references it (tracker O1). Locks the
 * repository row `FOR UPDATE` before counting: Postgres takes a `FOR KEY
 * SHARE` lock on a row for every insert/update that points a foreign key
 * at it (`agent-tools.ts`'s `ToolRowLock` documents the same mechanism),
 * and that conflicts with `FOR UPDATE`. So a concurrent `INSERT INTO tasks
 * (repository_id, ...)` referencing this row blocks until this transaction
 * commits or rolls back — it can never land against a row this call just
 * deleted, and a blocked insert that resolves after the delete fails its
 * own foreign-key check rather than creating an orphan.
 */
export async function deleteRepository(
  db: Db,
  id: string,
): Promise<AdminDeleteResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.id, id))
      .for("update");
    if (!row) return { status: "not_found" as const };

    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.repositoryId, id));
    const taskCount = countRow?.count ?? 0;
    if (taskCount > 0) return { status: "blocked" as const, taskCount };

    await tx.delete(repositories).where(eq(repositories.id, id));
    return { status: "deleted" as const };
  });
}

/**
 * Deletes a project and, in the same transaction, every repository under
 * it (tracker D2), iff no task references the project directly or through
 * one of those repositories. Locks the project row and every one of its
 * repository rows `FOR UPDATE` before counting, for the same reason
 * `deleteRepository` does: a concurrent task insert/update pointing at any
 * of those rows takes a `FOR KEY SHARE` lock that blocks behind ours, so it
 * cannot land after or during this delete.
 */
export async function deleteProject(
  db: Db,
  id: string,
): Promise<AdminDeleteResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, id))
      .for("update");
    if (!row) return { status: "not_found" as const };

    const repoRows = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.projectId, id))
      .for("update");
    const repoIds = repoRows.map((r) => r.id);

    const referencesProject =
      repoIds.length > 0
        ? or(eq(tasks.projectId, id), inArray(tasks.repositoryId, repoIds))
        : eq(tasks.projectId, id);

    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(referencesProject);
    const taskCount = countRow?.count ?? 0;
    if (taskCount > 0) return { status: "blocked" as const, taskCount };

    await tx.delete(repositories).where(eq(repositories.projectId, id));
    await tx.delete(projects).where(eq(projects.id, id));
    return { status: "deleted" as const };
  });
}

// ---------------------------------------------------------------------------
// Users (admin view: never selects `password_hash`)
// ---------------------------------------------------------------------------

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  disabledAt: Date | null;
  createdAt: Date;
}

const adminUserColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
};

export async function listAdminUsers(db: DbOrTx): Promise<AdminUserRow[]> {
  return db
    .select(adminUserColumns)
    .from(users)
    .orderBy(asc(users.createdAt));
}

export async function getAdminUserById(
  db: DbOrTx,
  id: string,
): Promise<AdminUserRow | null> {
  const [row] = await db
    .select(adminUserColumns)
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}

export interface UpdateAdminUserInput {
  displayName?: string;
  /** `undefined` leaves `disabled_at` untouched; `null` clears it. */
  disabledAt?: Date | null;
}

/** Patches `display_name` and/or `disabled_at`. Returns `null` if `id` is unknown. */
export async function updateAdminUser(
  db: DbOrTx,
  id: string,
  patch: UpdateAdminUserInput,
): Promise<AdminUserRow | null> {
  if (Object.keys(patch).length === 0) {
    return getAdminUserById(db, id);
  }
  const [row] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, id))
    .returning(adminUserColumns);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export interface AgentWorkerWithSlots extends AgentWorkerRow {
  /** `now` minus `last_heartbeat_at`, in whole seconds. */
  heartbeatAgeSeconds: number;
  /** `max_concurrent` minus the count of `ASSIGNED`/`RUNNING` executions on that host. */
  freeSlots: number;
}

/** States that hold a worker slot (design.md §6). */
const ACTIVE_EXECUTION_STATES = ["ASSIGNED", "RUNNING"] as const;

/**
 * One row per `agent_workers`, with `heartbeat_age_seconds` and
 * `free_slots` computed against `now` (design.md §12.5). The active-execution
 * count is one grouped query rather than one query per worker.
 */
export async function listWorkersWithSlots(
  db: DbOrTx,
  now: Date,
): Promise<AgentWorkerWithSlots[]> {
  const workers = await db
    .select()
    .from(agentWorkers)
    .orderBy(asc(agentWorkers.host));

  if (workers.length === 0) {
    return [];
  }

  const hosts = workers.map((w) => w.host);
  const counts = await db
    .select({
      host: executions.host,
      count: sql<number>`count(*)::int`,
    })
    .from(executions)
    .where(
      and(
        inArray(executions.host, hosts),
        inArray(executions.state, [...ACTIVE_EXECUTION_STATES]),
      ),
    )
    .groupBy(executions.host);

  const activeByHost = new Map(counts.map((c) => [c.host, c.count]));

  return workers.map((worker) => {
    const active = activeByHost.get(worker.host) ?? 0;
    const heartbeatAgeSeconds = Math.floor(
      (now.getTime() - worker.lastHeartbeatAt.getTime()) / 1000,
    );
    return {
      ...worker,
      heartbeatAgeSeconds,
      // Clamped: a host can be over-assigned (manual reassignment, a race
      // with the scheduler), and slots must never go negative for callers
      // that add this to a budget (R4).
      freeSlots: Math.max(0, worker.maxConcurrent - active),
    };
  });
}
