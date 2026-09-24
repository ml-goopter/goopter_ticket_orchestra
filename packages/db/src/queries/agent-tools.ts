import { and, desc, eq, sql } from "drizzle-orm";
import { executions, taskLeases } from "../schema/executions.js";
import { issues } from "../schema/issues.js";
import { notifications } from "../schema/notifications.js";
import { projects } from "../schema/projects.js";
import { pullRequests, reviewResults } from "../schema/pull_requests.js";
import { specificationRevisions, tasks } from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";
import type {
  ExecutionRow,
  ProjectRow,
  TaskRow,
} from "./task-aggregate.js";

/**
 * Queries behind the agent-tools MCP server (design.md §8). The server runs
 * in `apps/worker`, which may not import drizzle, so every statement it
 * needs lives here.
 */

export type IssueRowInserted = typeof issues.$inferSelect;

/** What a valid agent-tools bearer token resolves to. */
export interface AgentToolsExecutionContext {
  execution: ExecutionRow;
  task: TaskRow;
  project: ProjectRow;
}

/**
 * Stores (or clears, with `null`) the sha-256 hex of an execution's
 * agent-tools token. Clearing is the revocation in design.md §8.
 */
export async function setExecutionToolsTokenHash(
  db: DbOrTx,
  executionId: string,
  tokenHash: string | null,
): Promise<void> {
  await db
    .update(executions)
    .set({ toolsTokenHash: tokenHash })
    .where(eq(executions.id, executionId));
}

/**
 * Resolves a presented token hash to its execution plus the task and
 * project the tools need (role, runtime, `max_review_rounds`). Returns
 * `null` for an unknown or revoked token: `tools_token_hash` is null once
 * revoked, and null never equals a hash.
 */
export async function findExecutionByTokenHash(
  db: DbOrTx,
  tokenHash: string,
): Promise<AgentToolsExecutionContext | null> {
  if (tokenHash === "") return null;

  const [row] = await db
    .select({ execution: executions, task: tasks, project: projects })
    .from(executions)
    .innerJoin(tasks, eq(tasks.id, executions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(executions.toolsTokenHash, tokenHash))
    .limit(1);

  return row ?? null;
}

/**
 * Re-reads an execution's state and token hash with `SELECT ... FOR UPDATE`,
 * so a tool can re-check its authorization as the first statement of its
 * transaction and hold that answer until commit: a concurrent revoke or
 * state change waits for the tool, or the tool sees it. `null` when the
 * execution does not exist.
 */
export async function lockExecutionForTool(
  tx: Tx,
  executionId: string,
): Promise<Pick<ExecutionRow, "state" | "toolsTokenHash"> | null> {
  const [row] = await tx
    .select({
      state: executions.state,
      toolsTokenHash: executions.toolsTokenHash,
    })
    .from(executions)
    .where(eq(executions.id, executionId))
    .for("update");
  return row ?? null;
}

/**
 * Pushes the execution's lease out to `expiresAt` (design.md §6.4, §8:
 * "Every call also renews the lease"). Returns the new expiry, or `null`
 * when the execution holds no lease — a spec session has none, and that is
 * not an error.
 */
export async function renewTaskLease(
  db: DbOrTx,
  executionId: string,
  expiresAt: Date,
): Promise<Date | null> {
  const [row] = await db
    .update(taskLeases)
    .set({ expiresAt })
    .where(eq(taskLeases.executionId, executionId))
    .returning({ expiresAt: taskLeases.expiresAt });

  return row?.expiresAt ?? null;
}

/**
 * `review_rounds++` for the `REVIEWING -> IMPLEMENTING` side effect
 * (design.md §5.3). Done as an in-place SQL increment rather than a
 * read-then-write so two concurrent calls cannot lose one.
 */
export async function incrementExecutionReviewRounds(
  db: DbOrTx,
  executionId: string,
): Promise<number> {
  const [row] = await db
    .update(executions)
    .set({ reviewRounds: sql`${executions.reviewRounds} + 1` })
    .where(eq(executions.id, executionId))
    .returning({ reviewRounds: executions.reviewRounds });

  if (!row) {
    throw new Error(`execution not found: ${executionId}`);
  }
  return row.reviewRounds;
}

export type InsertIssueInput = typeof issues.$inferInsert;

/** Inserts the `issues` row behind `raise_issue` (design.md §8, §10.1). */
export async function insertIssue(
  db: DbOrTx,
  input: InsertIssueInput,
): Promise<IssueRowInserted> {
  const [row] = await db.insert(issues).values(input).returning();
  if (!row) throw new Error("insertIssue: insert returned no row");
  return row;
}

export type InsertNotificationInput = typeof notifications.$inferInsert;

/** Inserts one `notifications` row (design.md §4.2, §10.1). */
export async function insertNotification(
  db: DbOrTx,
  input: InsertNotificationInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(notifications)
    .values(input)
    .returning({ id: notifications.id });
  if (!row) throw new Error("insertNotification: insert returned no row");
  return row;
}

export type InsertReviewResultInput = typeof reviewResults.$inferInsert;

/** Inserts one `review_results` row (design.md §8 `report_review_result`). */
export async function insertReviewResult(
  db: DbOrTx,
  input: InsertReviewResultInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(reviewResults)
    .values(input)
    .returning({ id: reviewResults.id });
  if (!row) throw new Error("insertReviewResult: insert returned no row");
  return row;
}

export type InsertPullRequestInput = typeof pullRequests.$inferInsert;

/** Inserts one `pull_requests` row (design.md §8 `report_pr_created`). */
export async function insertPullRequest(
  db: DbOrTx,
  input: InsertPullRequestInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(pullRequests)
    .values(input)
    .returning({ id: pullRequests.id });
  if (!row) throw new Error("insertPullRequest: insert returned no row");
  return row;
}

export interface UpsertDraftSpecificationRevisionInput {
  taskId: string;
  content: unknown;
  now: Date;
}

export interface UpsertedSpecificationRevision {
  id: string;
  version: number;
  /** False when an existing draft was overwritten. */
  created: boolean;
}

/**
 * Upserts the task's single `draft` revision (design.md §8 `propose_spec`).
 * A task may hold at most one draft (unique index in §4.2), so a second
 * proposal replaces the first rather than stacking versions. A new draft
 * takes `max(version) + 1` so it never collides with an approved or
 * superseded revision.
 */
export async function upsertDraftSpecificationRevision(
  db: DbOrTx,
  input: UpsertDraftSpecificationRevisionInput,
): Promise<UpsertedSpecificationRevision> {
  const [existing] = await db
    .select({
      id: specificationRevisions.id,
      version: specificationRevisions.version,
    })
    .from(specificationRevisions)
    .where(
      and(
        eq(specificationRevisions.taskId, input.taskId),
        eq(specificationRevisions.status, "draft"),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(specificationRevisions)
      .set({ content: input.content, updatedAt: input.now })
      .where(eq(specificationRevisions.id, existing.id));
    return { id: existing.id, version: existing.version, created: false };
  }

  const [latest] = await db
    .select({ version: specificationRevisions.version })
    .from(specificationRevisions)
    .where(eq(specificationRevisions.taskId, input.taskId))
    .orderBy(desc(specificationRevisions.version))
    .limit(1);

  const [row] = await db
    .insert(specificationRevisions)
    .values({
      taskId: input.taskId,
      version: (latest?.version ?? 0) + 1,
      status: "draft",
      content: input.content,
      createdBy: null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({
      id: specificationRevisions.id,
      version: specificationRevisions.version,
    });

  if (!row) {
    throw new Error("upsertDraftSpecificationRevision: insert returned no row");
  }
  return { ...row, created: true };
}

/**
 * Current `tasks.state`, for callers that must decide whether an edge
 * exists before calling `transition()` (design.md §8 `report_failed` on a
 * spec task, which §5.1 gives no `NEEDS_HUMAN` edge).
 */
export async function getTaskState(
  db: DbOrTx,
  taskId: string,
): Promise<TaskRow["state"] | null> {
  const [row] = await db
    .select({ state: tasks.state })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row?.state ?? null;
}
