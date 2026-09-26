import { and, desc, eq, exists, inArray, sql } from "drizzle-orm";
import {
  executionUsage,
  executions,
  taskLeases,
} from "../schema/executions.js";
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
 * Row-lock strength for the two helpers below. `"update"` is `FOR UPDATE`.
 * `"key share"` is `FOR KEY SHARE`, the lock a foreign-key check takes on
 * the referenced row: it still waits behind a `FOR UPDATE` holder, so it
 * fixes lock order for a transaction that only inserts rows referencing
 * the task and execution, without blocking other writers.
 */
export type ToolRowLock = "update" | "key share";

/**
 * Locks the task row, `FOR UPDATE` unless `strength` says otherwise. A tool
 * transaction calls this before `lockExecutionForTool`, so it takes the
 * task lock before the execution lock, the same order as `transition()`
 * callers that cancel a task and then its executions. Taking them the other
 * way round deadlocks against such a caller (40P01). Returns false when the
 * task does not exist.
 */
export async function lockTaskForTool(
  tx: Tx,
  taskId: string,
  strength: ToolRowLock = "update",
): Promise<boolean> {
  const [row] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for(strength);
  return row !== undefined;
}

/**
 * Re-reads an execution's state and token hash with `SELECT ... FOR UPDATE`
 * (or `strength`), so a tool can re-check its authorization as the first
 * statement of its transaction and hold that answer until commit: a
 * concurrent revoke or state change waits for the tool, or the tool sees
 * it. `null` when the execution does not exist.
 */
export async function lockExecutionForTool(
  tx: Tx,
  executionId: string,
  strength: ToolRowLock = "update",
): Promise<Pick<ExecutionRow, "state" | "toolsTokenHash"> | null> {
  const [row] = await tx
    .select({
      state: executions.state,
      toolsTokenHash: executions.toolsTokenHash,
    })
    .from(executions)
    .where(eq(executions.id, executionId))
    .for(strength);
  return row ?? null;
}

/** Execution states whose lease may be renewed: the live ones (§6.4, §6.5). */
const LEASE_RENEWABLE_STATES = ["ASSIGNED", "RUNNING"] as const;

/**
 * Pushes the execution's lease out to `expiresAt` (design.md §6.4, §8:
 * "Every call also renews the lease"), but only while the execution is
 * `ASSIGNED` or `RUNNING`. A lease is never extended for an execution that
 * has already ended or been cancelled. Returns the new expiry, or `null`
 * when nothing was renewed: the execution holds no lease (a spec session
 * has none) or is not live. Neither is an error.
 */
export async function renewTaskLease(
  db: DbOrTx,
  executionId: string,
  expiresAt: Date,
): Promise<Date | null> {
  const [row] = await db
    .update(taskLeases)
    .set({ expiresAt })
    .where(
      and(
        eq(taskLeases.executionId, executionId),
        exists(
          db
            .select({ one: sql`1` })
            .from(executions)
            .where(
              and(
                eq(executions.id, taskLeases.executionId),
                inArray(executions.state, [...LEASE_RENEWABLE_STATES]),
              ),
            ),
        ),
      ),
    )
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

export type InsertExecutionUsageInput = typeof executionUsage.$inferInsert;

/** Inserts one `execution_usage` row (design.md §4.2, §9.7 `report_usage`). */
export async function insertExecutionUsage(
  db: DbOrTx,
  input: InsertExecutionUsageInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(executionUsage)
    .values(input)
    .returning({ id: executionUsage.id });
  if (!row) throw new Error("insertExecutionUsage: insert returned no row");
  return row;
}

export interface ExecutionUsageTotalsDelta {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Decimal string, as `numeric` columns take it. */
  costUsd: string;
}

/**
 * Adds one usage row's tokens and cost to the execution's running totals
 * (design.md §9.3 "add to execution totals"). In-place SQL increments, so
 * two concurrent calls cannot lose one.
 */
export async function addExecutionUsageTotals(
  db: DbOrTx,
  executionId: string,
  delta: ExecutionUsageTotalsDelta,
): Promise<void> {
  const [row] = await db
    .update(executions)
    .set({
      inputTokens: sql`${executions.inputTokens} + ${delta.inputTokens}`,
      cachedInputTokens: sql`${executions.cachedInputTokens} + ${delta.cachedInputTokens}`,
      outputTokens: sql`${executions.outputTokens} + ${delta.outputTokens}`,
      costUsd: sql`${executions.costUsd} + ${delta.costUsd}::numeric`,
    })
    .where(eq(executions.id, executionId))
    .returning({ id: executions.id });
  if (!row) throw new Error(`execution not found: ${executionId}`);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `usageId` names an `execution_usage` row of `executionId`, so
 * `report_review_result` can refuse a usage id that is unknown or belongs
 * to another execution. A value that is not a uuid is simply not found
 * rather than a Postgres cast error.
 */
export async function executionUsageBelongsTo(
  db: DbOrTx,
  usageId: string,
  executionId: string,
): Promise<boolean> {
  if (!UUID_PATTERN.test(usageId)) return false;
  const [row] = await db
    .select({ id: executionUsage.id })
    .from(executionUsage)
    .where(
      and(
        eq(executionUsage.id, usageId),
        eq(executionUsage.executionId, executionId),
      ),
    )
    .limit(1);
  return row !== undefined;
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

export interface UpsertPullRequestInput {
  taskId: string;
  executionId: string;
  number: number;
  url: string;
  headSha: string;
  now: Date;
}

/**
 * `report_pr_created` (design.md §8, GOT.39 C17). A task has at most one
 * `pull_requests` row. The first call inserts it open with `ci_state =
 * pending`. A later call, after a CI-failure resume, updates that row in
 * place: `number`, `url`, `head_sha`, `execution_id`, `ci_state = pending`,
 * `ci_detail = null`, `last_polled_at = now`. `state` and `created_at` are
 * kept.
 */
export async function upsertPullRequest(
  db: DbOrTx,
  input: UpsertPullRequestInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(pullRequests)
    .values({
      taskId: input.taskId,
      executionId: input.executionId,
      number: input.number,
      url: input.url,
      headSha: input.headSha,
      state: "open",
      ciState: "pending",
      lastPolledAt: input.now,
      createdAt: input.now,
    })
    .onConflictDoUpdate({
      target: pullRequests.taskId,
      set: {
        executionId: input.executionId,
        number: input.number,
        url: input.url,
        headSha: input.headSha,
        ciState: "pending",
        ciDetail: null,
        lastPolledAt: input.now,
      },
    })
    .returning({ id: pullRequests.id });
  if (!row) throw new Error("upsertPullRequest: upsert returned no row");
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
