import { TaskState } from "@orchestra/core";
import { and, asc, eq, gt, inArray, max, notInArray, or, sql } from "drizzle-orm";
import { appendEvent } from "../events.js";
import { executionEvents } from "../schema/events.js";
import { projects } from "../schema/projects.js";
import { pullRequests } from "../schema/pull_requests.js";
import { specificationApprovals, tasks } from "../schema/tasks.js";
import { users } from "../schema/users.js";
import { transition, type Actor, type DbOrTx, type Tx } from "../transition.js";
import { listActiveExecutionIds } from "./task-cost.js";

/** One row of `projects`, trimmed to what the Jira poller needs (design.md §11.1). */
export interface JiraProjectRow {
  id: string;
  key: string;
  jiraJql: string;
}

/** Every project's poll target. Order is not significant; the poller polls sequentially (design.md §11.1, E5). */
export async function listJiraProjects(db: DbOrTx): Promise<JiraProjectRow[]> {
  return db
    .select({ id: projects.id, key: projects.key, jiraJql: projects.jiraJql })
    .from(projects);
}

/** States a task never leaves, so the 404 sweep skips them (design.md §5.1, E3). */
const TERMINAL_TASK_STATES: TaskState[] = [
  TaskState.DONE,
  TaskState.CANCELLED,
  TaskState.FAILED,
];

export interface NonTerminalJiraTaskRow {
  id: string;
  jiraKey: string;
}

/** Non-terminal tasks of one project, candidates for the "still on Jira?" 404 check (E3). */
export async function listNonTerminalJiraTasks(
  db: DbOrTx,
  projectId: string,
): Promise<NonTerminalJiraTaskRow[]> {
  return db
    .select({ id: tasks.id, jiraKey: tasks.jiraKey })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        notInArray(tasks.state, TERMINAL_TASK_STATES),
      ),
    );
}

export interface UpsertJiraTaskInput {
  projectId: string;
  jiraKey: string;
  summary: string;
  priority: number;
  createdAt: Date;
  syncedAt: Date;
}

export interface UpsertJiraTaskResult {
  taskId: string;
  /** True when this call created the row rather than refreshing an existing one. */
  inserted: boolean;
}

/**
 * Upserts one task by `jira_key` (design.md §11.1). A new key is inserted in
 * `NEEDS_SPEC` and gets exactly one `task.state_changed` creation event, in
 * this same transaction (E2). `ON CONFLICT (jira_key) DO NOTHING` is what
 * makes two concurrent polls of the same result set produce at most one
 * insert and one event: the loser's insert returns no row, so it falls
 * through to the refresh branch instead of racing a second insert.
 *
 * An existing key only refreshes `jira_summary`, `jira_priority` and
 * `jira_synced_at` — state and every other column, including on a terminal
 * task, are left untouched (design.md §11.1, C4).
 */
export async function upsertJiraTask(
  tx: Tx,
  input: UpsertJiraTaskInput,
  actor: Actor,
): Promise<UpsertJiraTaskResult> {
  const [inserted] = await tx
    .insert(tasks)
    .values({
      projectId: input.projectId,
      jiraKey: input.jiraKey,
      jiraSummary: input.summary,
      jiraPriority: input.priority,
      jiraCreatedAt: input.createdAt,
      jiraSyncedAt: input.syncedAt,
      state: TaskState.NEEDS_SPEC,
    })
    .onConflictDoNothing({ target: tasks.jiraKey })
    .returning({ id: tasks.id });

  if (inserted) {
    await appendEvent(tx, {
      taskId: inserted.id,
      executionId: null,
      type: "task.state_changed",
      payload: {
        from: null,
        to: TaskState.NEEDS_SPEC,
        trigger: "jira.imported",
        actor: { kind: actor.kind, id: actor.id ?? null },
      },
    });
    return { taskId: inserted.id, inserted: true };
  }

  const [updated] = await tx
    .update(tasks)
    .set({
      jiraSummary: input.summary,
      jiraPriority: input.priority,
      jiraSyncedAt: input.syncedAt,
    })
    .where(eq(tasks.jiraKey, input.jiraKey))
    .returning({ id: tasks.id });

  if (!updated) {
    throw new Error(
      `upsertJiraTask: no row for jira_key ${input.jiraKey} after conflict`,
    );
  }

  return { taskId: updated.id, inserted: false };
}

export interface FailJiraTaskNotFoundInput {
  taskId: string;
  jiraKey: string;
  actor: Actor;
}

/**
 * Moves a task to `FAILED` because its Jira ticket returned 404 (design.md
 * §11.1, Q1), then cancels every one of its still-active
 * (`QUEUED`/`ASSIGNED`/`RUNNING`/`WAITING_FOR_USER`) executions, mirroring
 * `POST /tasks/:id/cancel`: a task can never leave a live execution and its
 * lease behind. The task transition runs first, then the execution
 * transitions, then the `agent.note` reason — all in the same transaction,
 * so a reader can never observe the task's new state without every active
 * execution already cancelled, or the state change without the reason.
 */
export async function failJiraTaskNotFound(
  tx: Tx,
  input: FailJiraTaskNotFoundInput,
): Promise<void> {
  await transition(tx, {
    entity: "task",
    id: input.taskId,
    trigger: "task.failed",
    actor: input.actor,
  });

  const activeExecutionIds = await listActiveExecutionIds(tx, input.taskId);
  for (const executionId of activeExecutionIds) {
    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.cancelled",
      actor: input.actor,
    });
  }

  await appendEvent(tx, {
    taskId: input.taskId,
    executionId: null,
    type: "agent.note",
    payload: {
      source: "jira-poller",
      reason: `Jira ticket ${input.jiraKey} returned 404 and no longer exists`,
    },
  });
}

/**
 * Current highest `execution_events.id`, or `0n` when the table is empty
 * (design.md §11.1 write-back). The Jira write-back loop starts its cursor
 * here (C11): no historical replay on a fresh worker, only events appended
 * from this moment on.
 */
export async function maxExecutionEventId(db: DbOrTx): Promise<bigint> {
  const [row] = await db.select({ id: max(executionEvents.id) }).from(executionEvents);
  return row?.id ?? 0n;
}

/** One `execution_events` row the Jira write-back loop can act on (design.md §11.1). */
export interface JiraWritebackEventRow {
  id: bigint;
  type: "spec.approved" | "pull_request.created" | "task.state_changed";
  payload: unknown;
  taskId: string;
  jiraKey: string;
  jiraProjectId: string;
  /** `tasks.needs_human_reason`, current as of the read (may postdate the event). */
  needsHumanReason: string | null;
  /** `pull_requests.url` for the task, or null when it has no PR yet. */
  pullRequestUrl: string | null;
}

const WRITEBACK_SIMPLE_TYPES = ["spec.approved", "pull_request.created"] as const;

/**
 * Loads write-back trigger events with id > `after` (design.md §11.1 C11):
 * `spec.approved`, `pull_request.created`, and `task.state_changed` whose
 * payload's `to` is `READY_FOR_MERGE` or `NEEDS_HUMAN`, ascending, capped at
 * `limit`. Joined with the task's `jira_key`/`project_id`/`needs_human_reason`
 * and the task's `pull_requests.url` (at most one row per task), so the
 * worker never needs a second round trip, or `drizzle-orm`, to build a
 * comment.
 *
 * Excludes a READY_FOR_MERGE `task.state_changed` event whose payload has
 * `via: "merged_externally"` (F4, C51): `markPullRequestMerged` stamps that
 * marker on the `ci.passed` transition it runs when a human merged the PR
 * before CI finished, so this event never actually observed CI passing —
 * Jira must not be told "CI passed" for it.
 */
export async function listJiraWritebackEvents(
  db: DbOrTx,
  after: bigint,
  limit = 200,
): Promise<JiraWritebackEventRow[]> {
  const rows = await db
    .select({
      id: executionEvents.id,
      type: executionEvents.type,
      payload: executionEvents.payload,
      taskId: tasks.id,
      jiraKey: tasks.jiraKey,
      jiraProjectId: tasks.projectId,
      needsHumanReason: tasks.needsHumanReason,
      pullRequestUrl: pullRequests.url,
    })
    .from(executionEvents)
    .innerJoin(tasks, eq(tasks.id, executionEvents.taskId))
    .leftJoin(pullRequests, eq(pullRequests.taskId, tasks.id))
    .where(
      and(
        gt(executionEvents.id, after),
        or(
          inArray(executionEvents.type, WRITEBACK_SIMPLE_TYPES),
          and(
            eq(executionEvents.type, "task.state_changed"),
            sql`(${executionEvents.payload} ->> 'to') in ('READY_FOR_MERGE', 'NEEDS_HUMAN')`,
            sql`(${executionEvents.payload} ->> 'via') is distinct from 'merged_externally'`,
          ),
        ),
      ),
    )
    .orderBy(asc(executionEvents.id))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    type: row.type as JiraWritebackEventRow["type"],
  }));
}

/**
 * The display name of the user who approved `revisionId` (design.md §11.1
 * "spec approved"): the `specification_approvals` row for that revision,
 * falling back to `actorId` — the `spec.approved` event's actor — when the
 * approval row is missing. Null when neither resolves to a user.
 */
export async function getSpecApprovalDisplayName(
  db: DbOrTx,
  revisionId: string,
  actorId: string | null,
): Promise<string | null> {
  const [approval] = await db
    .select({ displayName: users.displayName })
    .from(specificationApprovals)
    .innerJoin(users, eq(users.id, specificationApprovals.approvedBy))
    .where(eq(specificationApprovals.revisionId, revisionId));
  if (approval) return approval.displayName;

  if (!actorId) return null;
  const [actor] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, actorId));
  return actor?.displayName ?? null;
}
