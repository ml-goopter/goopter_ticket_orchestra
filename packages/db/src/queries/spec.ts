import type {
  CommandType,
  ExecutionState,
  Runtime,
  TaskState,
} from "@orchestra/core";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { executionCommands, executions } from "../schema/executions.js";
import { repositories } from "../schema/projects.js";
import {
  specificationApprovals,
  specificationRevisions,
  tasks,
} from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";

/**
 * Queries behind the specification routes (design.md §12.3). The api may
 * not import drizzle, so every statement those routes run lives here; the
 * routes own transaction boundaries and call `transition()` for every state
 * move.
 *
 * Lock order used by every spec route: dependency-graph advisory lock (only
 * approve takes it), then the task row (`lockTaskForSpec`), then execution
 * rows (`lockTaskExecutionIds`). `appendEvent`'s per-task advisory lock is
 * always taken after the task row.
 */

export interface LockedSpecTask {
  state: TaskState;
  projectId: string;
  approvedRevisionId: string | null;
}

/**
 * Locks the task row `FOR UPDATE` and reads what the spec routes decide on.
 * Call it first in the transaction (after `lockDependencyGraph` when the
 * route takes it), so the task row is locked before any execution row.
 * `null` when the task does not exist.
 */
export async function lockTaskForSpec(
  tx: Tx,
  taskId: string,
): Promise<LockedSpecTask | null> {
  const [row] = await tx
    .select({
      state: tasks.state,
      projectId: tasks.projectId,
      approvedRevisionId: tasks.approvedRevisionId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update");
  return row ?? null;
}

/**
 * Ids of the task's executions of `role` in one of `states`, locked
 * `FOR UPDATE`, oldest first. Call only with the task row already locked
 * (task-then-execution lock order).
 */
export async function lockTaskExecutionIds(
  tx: Tx,
  taskId: string,
  role: "spec" | "implementation",
  states: readonly ExecutionState[],
): Promise<string[]> {
  const rows = await tx
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.taskId, taskId),
        eq(executions.role, role),
        inArray(executions.state, [...states]),
      ),
    )
    .orderBy(asc(executions.createdAt), asc(executions.id))
    .for("update");
  return rows.map((row) => row.id);
}

/**
 * True when the task has a `start_spec_session` command that has not
 * completed, claimed or not: the spec session is still starting and has no
 * execution row yet. Call with the task row already locked.
 */
export async function hasPendingSpecSessionStart(
  tx: Tx,
  taskId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.taskId, taskId),
        eq(executionCommands.type, "start_spec_session"),
        isNull(executionCommands.completedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface SpecRevisionRow {
  id: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  content: unknown;
}

const revisionColumns = {
  id: specificationRevisions.id,
  version: specificationRevisions.version,
  status: specificationRevisions.status,
  content: specificationRevisions.content,
};

/** The task's single revision in `status`, or `null` (§4.2: at most one draft, one approved). */
export async function getRevisionByStatus(
  db: DbOrTx,
  taskId: string,
  status: "draft" | "approved",
): Promise<SpecRevisionRow | null> {
  const [row] = await db
    .select(revisionColumns)
    .from(specificationRevisions)
    .where(
      and(
        eq(specificationRevisions.taskId, taskId),
        eq(specificationRevisions.status, status),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface InsertDraftRevisionInput {
  taskId: string;
  content: unknown;
  createdBy: string;
  now: Date;
}

/**
 * Inserts a new `draft` revision at `max(version) + 1` for the task, so it
 * never collides with an approved or superseded version. The caller holds
 * the task row lock, which serialises version allocation between routes.
 */
export async function insertDraftRevision(
  tx: Tx,
  input: InsertDraftRevisionInput,
): Promise<SpecRevisionRow> {
  const [latest] = await tx
    .select({
      max: sql<number>`coalesce(max(${specificationRevisions.version}), 0)::int`,
    })
    .from(specificationRevisions)
    .where(eq(specificationRevisions.taskId, input.taskId));

  const [row] = await tx
    .insert(specificationRevisions)
    .values({
      taskId: input.taskId,
      version: (latest?.max ?? 0) + 1,
      status: "draft",
      content: input.content,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning(revisionColumns);
  if (!row) throw new Error("insertDraftRevision: insert returned no row");
  return row;
}

/** Overwrites a draft revision's `content`. */
export async function updateDraftRevisionContent(
  tx: Tx,
  revisionId: string,
  content: unknown,
  now: Date,
): Promise<SpecRevisionRow> {
  const [row] = await tx
    .update(specificationRevisions)
    .set({ content, updatedAt: now })
    .where(
      and(
        eq(specificationRevisions.id, revisionId),
        eq(specificationRevisions.status, "draft"),
      ),
    )
    .returning(revisionColumns);
  if (!row) {
    throw new Error(`updateDraftRevisionContent: no draft ${revisionId}`);
  }
  return row;
}

export interface ProjectRepository {
  id: string;
  name: string;
  defaultRuntime: Runtime;
}

/** The repository named `name` within `projectId` (unique on `(project_id, name)`), or `null`. */
export async function findProjectRepositoryByName(
  db: DbOrTx,
  projectId: string,
  name: string,
): Promise<ProjectRepository | null> {
  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      defaultRuntime: repositories.defaultRuntime,
    })
    .from(repositories)
    .where(
      and(eq(repositories.projectId, projectId), eq(repositories.name, name)),
    )
    .limit(1);
  return row ?? null;
}

export interface ApproveRevisionInput {
  taskId: string;
  revisionId: string;
  approvedBy: string;
  runtime: Runtime;
  now: Date;
}

/**
 * Approval's revision writes (§12.3, §10.4): the task's current `approved`
 * revision becomes `superseded`, then the draft becomes `approved`, then the
 * `specification_approvals` row is inserted. Superseding first keeps the
 * one-approved-per-task partial unique index satisfied at every statement.
 * Returns the id of the superseded revision, or `null` when there was none.
 */
export async function approveRevision(
  tx: Tx,
  input: ApproveRevisionInput,
): Promise<{ supersededRevisionId: string | null }> {
  const superseded = await tx
    .update(specificationRevisions)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(specificationRevisions.taskId, input.taskId),
        eq(specificationRevisions.status, "approved"),
      ),
    )
    .returning({ id: specificationRevisions.id });

  const approved = await tx
    .update(specificationRevisions)
    .set({ status: "approved", updatedAt: input.now })
    .where(
      and(
        eq(specificationRevisions.id, input.revisionId),
        eq(specificationRevisions.status, "draft"),
      ),
    )
    .returning({ id: specificationRevisions.id });
  if (approved.length !== 1) {
    throw new Error(`approveRevision: no draft ${input.revisionId}`);
  }

  await tx.insert(specificationApprovals).values({
    revisionId: input.revisionId,
    approvedBy: input.approvedBy,
    approvedAt: input.now,
    runtime: input.runtime,
  });

  return { supersededRevisionId: superseded[0]?.id ?? null };
}

export interface InsertExecutionCommandInput {
  taskId: string;
  /** Null only for `start_spec_session` (§4.2). */
  executionId: string | null;
  type: CommandType;
  payload: unknown;
  createdBy: string | null;
  now: Date;
}

/** Inserts one unclaimed `execution_commands` row (§4.2). */
export async function insertExecutionCommand(
  tx: Tx,
  input: InsertExecutionCommandInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(executionCommands)
    .values({
      taskId: input.taskId,
      executionId: input.executionId,
      type: input.type,
      payload: input.payload,
      createdBy: input.createdBy,
      createdAt: input.now,
    })
    .returning({ id: executionCommands.id });
  if (!row) throw new Error("insertExecutionCommand: insert returned no row");
  return row;
}
