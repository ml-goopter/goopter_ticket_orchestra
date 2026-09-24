import type { TaskState, ExecutionState } from "./enums.js";
import { TRANSITIONS } from "./transitions.js";

/**
 * Pure lookup against the transition table (design.md §5). No I/O, no
 * `Date`, no randomness. The db-backed `transition()` that writes
 * `audit_events` and calls `NOTIFY` is GOT.16, layered on top of this.
 */

export interface IllegalTransitionInfo {
  readonly code: "ILLEGAL_TRANSITION";
  readonly entity: "task" | "execution";
  readonly from: TaskState | ExecutionState;
  readonly trigger: string;
}

/** Thrown by `assertTransition`; also matches `IllegalTransitionInfo`. */
export class TransitionError extends Error implements IllegalTransitionInfo {
  readonly code = "ILLEGAL_TRANSITION" as const;
  readonly entity: "task" | "execution";
  readonly from: TaskState | ExecutionState;
  readonly trigger: string;

  constructor(entity: "task" | "execution", from: TaskState | ExecutionState, trigger: string) {
    super(`illegal transition: ${entity} ${from} -> (${trigger})`);
    this.name = "TransitionError";
    this.entity = entity;
    this.from = from;
    this.trigger = trigger;
  }
}

export type TransitionResult<To> =
  | { ok: true; to: To }
  | { ok: false; error: IllegalTransitionInfo };

export function resolveTransition(
  entity: "task",
  from: TaskState,
  trigger: string,
): TransitionResult<TaskState>;
export function resolveTransition(
  entity: "execution",
  from: ExecutionState,
  trigger: string,
): TransitionResult<ExecutionState>;
export function resolveTransition(
  entity: "task" | "execution",
  from: TaskState | ExecutionState,
  trigger: string,
): TransitionResult<TaskState | ExecutionState> {
  const row = TRANSITIONS.find(
    (r) => r.entity === entity && r.from === from && r.trigger === trigger,
  );
  if (!row) {
    return { ok: false, error: new TransitionError(entity, from, trigger) };
  }
  return { ok: true, to: row.to };
}

export function assertTransition(
  entity: "task",
  from: TaskState,
  trigger: string,
): TaskState;
export function assertTransition(
  entity: "execution",
  from: ExecutionState,
  trigger: string,
): ExecutionState;
export function assertTransition(
  entity: "task" | "execution",
  from: TaskState | ExecutionState,
  trigger: string,
): TaskState | ExecutionState {
  const result =
    entity === "task"
      ? resolveTransition("task", from as TaskState, trigger)
      : resolveTransition("execution", from as ExecutionState, trigger);
  if (!result.ok) {
    throw new TransitionError(entity, from, trigger);
  }
  return result.to;
}
