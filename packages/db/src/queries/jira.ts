import { TaskState } from "@orchestra/core";
import { and, eq, notInArray } from "drizzle-orm";
import { appendEvent } from "../events.js";
import { projects } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
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
