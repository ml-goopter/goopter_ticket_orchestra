import { TaskState } from "@orchestra/core";
import { and, asc, desc, eq, gt, inArray, max, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { appendEvent } from "../events.js";
import { executionEvents } from "../schema/events.js";
import { projects } from "../schema/projects.js";
import { pullRequests } from "../schema/pull_requests.js";
import { specificationApprovals, tasks } from "../schema/tasks.js";
import { users } from "../schema/users.js";
import { transition, type Actor, type DbOrTx, type Tx } from "../transition.js";
import { insertNotification } from "./agent-tools.js";
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

/**
 * Where a task's Jira ticket stands relative to the project (GOT.77, user
 * decision O1): `closed` is status category Done, `left_jql` is open but no
 * longer returned by the project's JQL, `in_scope` is neither.
 */
export type JiraScope = "in_scope" | "closed" | "left_jql";

const JIRA_SCOPES: readonly JiraScope[] = ["in_scope", "closed", "left_jql"];

/** Tasks whose ticket closing or leaving the JQL cancels them (O1). */
const JIRA_SPEC_GROUP_STATES: readonly TaskState[] = [
  TaskState.NEEDS_SPEC,
  TaskState.SPEC_IN_PROGRESS,
  TaskState.SPEC_REVIEW,
  TaskState.SPEC_APPROVED,
];

/**
 * What `applyJiraScope` does (GOT.77):
 * - `cancel`: spec-group task, ticket closed or out of the JQL.
 * - `signal`: any other non-terminal task, ticket closed or out of the JQL,
 *   and the last recorded scope differs: one notification plus one note.
 * - `restore`: that task's ticket is back in scope after a signal: one note,
 *   no notification, so a later close signals again.
 * - `none`: everything else, including every DONE/CANCELLED/FAILED task.
 */
export type JiraScopeAction = "none" | "cancel" | "signal" | "restore";

/**
 * The GOT.77 decision table. `lastScope` is the scope recorded by the most
 * recent `signal`/`restore` note, null when there is none (read as
 * `in_scope`). Pure, so the poller can skip the transaction for the common
 * no-op case and `applyJiraScope` can re-decide under the task lock.
 */
export function jiraScopeAction(
  state: TaskState,
  lastScope: JiraScope | null,
  scope: JiraScope,
): JiraScopeAction {
  if (TERMINAL_TASK_STATES.includes(state)) return "none";
  if (JIRA_SPEC_GROUP_STATES.includes(state)) {
    return scope === "in_scope" ? "none" : "cancel";
  }
  const last = lastScope ?? "in_scope";
  if (scope === last) return "none";
  return scope === "in_scope" ? "restore" : "signal";
}

export interface NonTerminalJiraTaskRow {
  id: string;
  jiraKey: string;
  state: TaskState;
  /** Latest scope recorded by a jira-poller signal/restore note, or null. */
  jiraScope: JiraScope | null;
}

// Aliased so the correlated reference to `tasks.id` renders qualified, as
// in `listAttention`: an unaliased raw subquery resolves a bare `id` against
// the inner table.
const jiraScopeEvent = alias(executionEvents, "jira_scope_event");

/**
 * The latest `jiraScope` recorded on a task's timeline by a jira-poller
 * `agent.note`, as a scalar subquery correlated on `tasks.id`.
 */
function latestJiraScopeSql(db: DbOrTx) {
  return sql<string | null>`${db
    .select({ jiraScope: sql`${jiraScopeEvent.payload} ->> 'jiraScope'` })
    .from(jiraScopeEvent)
    .where(
      and(
        eq(jiraScopeEvent.taskId, tasks.id),
        eq(jiraScopeEvent.type, "agent.note"),
        sql`${jiraScopeEvent.payload} ->> 'source' = 'jira-poller'`,
        sql`${jiraScopeEvent.payload} ->> 'jiraScope' is not null`,
      ),
    )
    .orderBy(desc(jiraScopeEvent.id))
    .limit(1)}`;
}

function toJiraScope(value: string | null): JiraScope | null {
  return JIRA_SCOPES.includes(value as JiraScope) ? (value as JiraScope) : null;
}

/**
 * Non-terminal tasks of one project, with their state and last recorded
 * Jira scope: candidates for the 404 check (E3) and the closed / left-JQL
 * check (GOT.77).
 */
export async function listNonTerminalJiraTasks(
  db: DbOrTx,
  projectId: string,
): Promise<NonTerminalJiraTaskRow[]> {
  const rows = await db
    .select({
      id: tasks.id,
      jiraKey: tasks.jiraKey,
      state: tasks.state,
      jiraScope: latestJiraScopeSql(db),
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        notInArray(tasks.state, TERMINAL_TASK_STATES),
      ),
    );
  return rows.map((row) => ({ ...row, jiraScope: toJiraScope(row.jiraScope) }));
}

/**
 * The latest Jira scope recorded on `taskId` by a jira-poller `agent.note`,
 * or null when the poller has never recorded one (GOT.93). Used by
 * `POST /tasks/:id/reopen` (design.md §5.1, §12.2) to refuse reopening a
 * `CANCELLED` task whose last recorded scope is `closed` or `left_jql`: the
 * poller stops checking a cancelled task, so nothing would ever notice the
 * ticket coming back in scope if reopen were allowed. Call it inside the
 * same transaction as the caller's task row lock, after that lock.
 */
export async function getLatestJiraScope(
  db: DbOrTx,
  taskId: string,
): Promise<JiraScope | null> {
  const [row] = await db
    .select({ jiraScope: latestJiraScopeSql(db) })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  return toJiraScope(row?.jiraScope ?? null);
}

export interface ApplyJiraScopeInput {
  taskId: string;
  jiraKey: string;
  scope: JiraScope;
  actor: Actor;
}

function scopeReason(jiraKey: string, scope: Exclude<JiraScope, "in_scope">): string {
  return scope === "closed"
    ? `Jira ticket ${jiraKey} was closed in Jira (status category Done)`
    : `Jira ticket ${jiraKey} no longer matches the project's JQL`;
}

/**
 * Applies one ticket observation to its task (GOT.77, user decision O1).
 * Locks the task row `FOR UPDATE` first and decides with `jiraScopeAction`
 * from the locked state and the latest recorded scope, so a task that moved
 * since the poll read is judged by its current state and two concurrent
 * polls raise one signal, not two.
 *
 * `cancel` mirrors the 404 path (`failJiraTaskNotFound`) and
 * `POST /tasks/:id/cancel`: task transition, then every active execution
 * (task row before execution row), then the `agent.note` reason. `signal`
 * inserts a broadcast `jira_out_of_scope` notification and a note;
 * `restore` only a note. Every note carries `jiraScope`, which is what the
 * next call reads as the last recorded scope.
 */
export async function applyJiraScope(
  tx: Tx,
  input: ApplyJiraScopeInput,
): Promise<JiraScopeAction> {
  const [row] = await tx
    .select({ state: tasks.state })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .for("update");
  if (!row) return "none";

  const [last] = await tx
    .select({ jiraScope: latestJiraScopeSql(tx) })
    .from(tasks)
    .where(eq(tasks.id, input.taskId));
  const action = jiraScopeAction(
    row.state,
    toJiraScope(last?.jiraScope ?? null),
    input.scope,
  );

  if (action === "none") return action;

  if (action === "cancel") {
    const scope = input.scope as Exclude<JiraScope, "in_scope">;
    await transition(tx, {
      entity: "task",
      id: input.taskId,
      trigger: "task.cancelled",
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
        jiraScope: scope,
        reason: `${scopeReason(input.jiraKey, scope)}; task cancelled`,
      },
    });
    return action;
  }

  if (action === "signal") {
    const scope = input.scope as Exclude<JiraScope, "in_scope">;
    const what = scope === "closed" ? "was closed in Jira" : "left the project's JQL";
    await appendEvent(tx, {
      taskId: input.taskId,
      executionId: null,
      type: "agent.note",
      payload: {
        source: "jira-poller",
        jiraScope: scope,
        reason: `${scopeReason(input.jiraKey, scope)} while the task is ${row.state}; not cancelled, a human must decide`,
      },
    });
    await insertNotification(tx, {
      userId: null,
      taskId: input.taskId,
      kind: "jira_out_of_scope",
      title: `${input.jiraKey} ${what} while work is under way`,
    });
    return action;
  }

  await appendEvent(tx, {
    taskId: input.taskId,
    executionId: null,
    type: "agent.note",
    payload: {
      source: "jira-poller",
      jiraScope: "in_scope",
      reason: `Jira ticket ${input.jiraKey} is open and matches the project's JQL again`,
    },
  });
  return action;
}

export interface UpsertJiraTaskInput {
  projectId: string;
  jiraKey: string;
  summary: string;
  priority: number;
  createdAt: Date;
  syncedAt: Date;
  /**
   * The ticket's status category is Done as of this poll (GOT.77, user
   * decision Q1, 2026-09-29). A ticket that is Done the first time the JQL
   * returns it is never imported.
   */
  isDone: boolean;
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
 *
 * `isDone` (GOT.77, Q1): a ticket already Done the first time it is seen is
 * never inserted — no task, no notification, no event. `null` is returned
 * for that case. An already-imported task whose ticket is Done still gets
 * its summary/priority/synced_at refreshed here; `pollProject`'s later
 * closed/left-JQL sweep is what cancels or signals it.
 */
export async function upsertJiraTask(
  tx: Tx,
  input: UpsertJiraTaskInput,
  actor: Actor,
): Promise<UpsertJiraTaskResult | null> {
  if (input.isDone) {
    const [updated] = await tx
      .update(tasks)
      .set({
        jiraSummary: input.summary,
        jiraPriority: input.priority,
        jiraSyncedAt: input.syncedAt,
      })
      .where(eq(tasks.jiraKey, input.jiraKey))
      .returning({ id: tasks.id });
    return updated ? { taskId: updated.id, inserted: false } : null;
  }

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
