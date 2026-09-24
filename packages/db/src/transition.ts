import {
  ExecutionState,
  assertTransition,
  type ActorKind,
  type ExecutionEventType,
  type TaskState,
  type Trigger,
} from "@orchestra/core";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { appendEvent } from "./events.js";
import { auditEvents } from "./schema/events.js";
import { executions } from "./schema/executions.js";
import { tasks } from "./schema/tasks.js";

/**
 * Transaction handle handed to the callback of `db.transaction(...)`.
 * Everything in this module requires one: a transition is only correct if
 * the row lock, the state update, the audit row, the event row and the
 * `NOTIFY` all commit or roll back together.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anything that can run a query: the pooled client or a transaction. */
export type DbOrTx = Db | Tx;

/** Thrown when the entity named by `id` does not exist. */
export class NotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  readonly entity: "task" | "execution";
  readonly id: string;

  constructor(entity: "task" | "execution", id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
    this.entity = entity;
    this.id = id;
  }
}

export interface Actor {
  kind: ActorKind;
  /** User id, worker id or agent id. Null in `audit_events` when absent. */
  id?: string;
}

/**
 * Columns a caller may set in the same `UPDATE` as the state change, so the
 * reason for a move lands atomically with the move. `state` is excluded: the
 * transition table owns it. `updatedAt` is excluded: `transition()` stamps it.
 */
export type TaskSetColumns = Partial<
  Omit<typeof tasks.$inferInsert, "id" | "state" | "createdAt" | "updatedAt">
>;

export type ExecutionSetColumns = Partial<
  Omit<typeof executions.$inferInsert, "id" | "state" | "createdAt">
>;

export interface TaskTransitionInput {
  entity: "task";
  id: string;
  trigger: Trigger;
  actor: Actor;
  set?: TaskSetColumns;
}

export interface ExecutionTransitionInput {
  entity: "execution";
  id: string;
  trigger: Trigger;
  actor: Actor;
  set?: ExecutionSetColumns;
}

export interface TransitionResult<S> {
  from: S;
  to: S;
  /**
   * Id of the `execution_events` row this transition appended. Every
   * transition appends exactly one, so it is always present.
   */
  eventId: bigint;
}

/**
 * Maps an execution's target state to its `execution_events.type`
 * (design.md §9.6). `RUNNING` needs the source state: arriving from
 * `ASSIGNED` is a first start, arriving from `WAITING_FOR_USER` or
 * `COMPLETED` (the `resume_with_ci_failure` back edge, §5.2) is a resume.
 * `QUEUED` is a creation state, never a transition target.
 */
function executionEventType(
  from: ExecutionState,
  to: ExecutionState,
): ExecutionEventType {
  switch (to) {
    case ExecutionState.ASSIGNED:
      return "execution.assigned";
    case ExecutionState.RUNNING:
      return from === ExecutionState.ASSIGNED
        ? "execution.started"
        : "execution.resumed";
    case ExecutionState.WAITING_FOR_USER:
      return "execution.waiting";
    case ExecutionState.COMPLETED:
      return "execution.completed";
    case ExecutionState.FAILED:
      return "execution.failed";
    case ExecutionState.CANCELLED:
      return "execution.cancelled";
    case ExecutionState.QUEUED:
      throw new Error(
        "execution QUEUED is a creation state, not a transition target",
      );
    default: {
      const exhaustive: never = to;
      throw new Error(`unhandled execution state: ${String(exhaustive)}`);
    }
  }
}

/**
 * `TaskSetColumns` / `ExecutionSetColumns` already exclude `id`, `state`
 * (and `updatedAt`/`createdAt`) at the type level, but TypeScript's excess
 * property check only fires on object literals: a caller that builds the
 * `set` value separately (or widens it with `as any`/`as unknown`) can still
 * pass `id` or `state` through at runtime, and a naive `{ ...input.set,
 * state: to }` spread only protects `state` because it is re-assigned after
 * the spread — `id` has no such guard. Stripping these keys here, right
 * before the spread, is what actually enforces the exclusion at runtime.
 */
function stripReservedColumns(
  set: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!set) return {};
  const rest = { ...set };
  delete rest["id"];
  delete rest["state"];
  delete rest["createdAt"];
  delete rest["updatedAt"];
  return rest;
}

async function writeAudit(
  tx: Tx,
  entity: "task" | "execution",
  id: string,
  from: string,
  to: string,
  trigger: Trigger,
  actor: Actor,
): Promise<void> {
  await tx.insert(auditEvents).values({
    entityType: entity,
    entityId: id,
    fromState: from,
    toState: to,
    trigger,
    actorKind: actor.kind,
    actorId: actor.id ?? null,
  });
}

async function transitionTask(
  tx: Tx,
  input: TaskTransitionInput,
): Promise<TransitionResult<TaskState>> {
  // `FOR UPDATE` is what makes two concurrent transitions of the same task
  // serialise. Without it both would read the same `from` and both would
  // pass `assertTransition`, producing a lost update (design.md §5).
  const [row] = await tx
    .select({ state: tasks.state })
    .from(tasks)
    .where(eq(tasks.id, input.id))
    .for("update");

  if (!row) {
    throw new NotFoundError("task", input.id);
  }

  const from = row.state;
  // Throws `TransitionError`, which propagates out of the caller's
  // transaction callback and rolls the whole transaction back.
  const to = assertTransition("task", from, input.trigger);

  await tx
    .update(tasks)
    .set({
      ...stripReservedColumns(input.set),
      state: to,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, input.id));

  await writeAudit(tx, "task", input.id, from, to, input.trigger, input.actor);

  const { id: eventId } = await appendEvent(tx, {
    taskId: input.id,
    executionId: null,
    type: "task.state_changed",
    payload: {
      from,
      to,
      trigger: input.trigger,
      actor: { kind: input.actor.kind, id: input.actor.id ?? null },
    },
  });

  return { from, to, eventId };
}

async function transitionExecution(
  tx: Tx,
  input: ExecutionTransitionInput,
): Promise<TransitionResult<ExecutionState>> {
  const [row] = await tx
    .select({ state: executions.state, taskId: executions.taskId })
    .from(executions)
    .where(eq(executions.id, input.id))
    .for("update");

  if (!row) {
    throw new NotFoundError("execution", input.id);
  }

  const from = row.state;
  const to = assertTransition("execution", from, input.trigger);

  await tx
    .update(executions)
    .set({ ...stripReservedColumns(input.set), state: to })
    .where(eq(executions.id, input.id));

  await writeAudit(
    tx,
    "execution",
    input.id,
    from,
    to,
    input.trigger,
    input.actor,
  );

  const { id: eventId } = await appendEvent(tx, {
    taskId: row.taskId,
    executionId: input.id,
    type: executionEventType(from, to),
    payload: {
      from,
      to,
      trigger: input.trigger,
      actor: { kind: input.actor.kind, id: input.actor.id ?? null },
    },
  });

  return { from, to, eventId };
}

/**
 * The single function that writes `tasks.state` and `executions.state`
 * (design.md §5). It locks the row, validates the move against the core
 * transition table, applies the update, writes `audit_events`, appends an
 * `execution_events` row and issues `NOTIFY orchestra`.
 *
 * Illegal moves throw `TransitionError` and unknown ids throw
 * `NotFoundError`; neither is swallowed, so the caller's transaction rolls
 * back and no partial write survives.
 *
 * Side effects listed in §5.3 (`review_rounds++`, enqueueing commands,
 * notification rows) belong to the caller, in the same transaction.
 */
export function transition(
  tx: Tx,
  input: TaskTransitionInput,
): Promise<TransitionResult<TaskState>>;
export function transition(
  tx: Tx,
  input: ExecutionTransitionInput,
): Promise<TransitionResult<ExecutionState>>;
export function transition(
  tx: Tx,
  input: TaskTransitionInput | ExecutionTransitionInput,
): Promise<TransitionResult<TaskState> | TransitionResult<ExecutionState>> {
  return input.entity === "task"
    ? transitionTask(tx, input)
    : transitionExecution(tx, input);
}
