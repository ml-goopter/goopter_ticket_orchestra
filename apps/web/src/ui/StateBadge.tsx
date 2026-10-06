import { humanizeEnum } from "./humanizeEnum.js";

type StatusColor = "attention" | "progress" | "success" | "danger" | "neutral";

/**
 * `TaskState` and `ExecutionState` (@orchestra/core `enums.ts`) to one of
 * the five status colours (design direction: amber for `NEEDS_HUMAN`
 * and waiting-for-user-like, blue for in-progress, green for done/ready for
 * merge, red for failed, grey for cancelled/queued-like). States not
 * listed here (unknown/future) fall back to neutral.
 */
const STATE_COLOR: Record<string, StatusColor> = {
  // Attention / amber.
  NEEDS_HUMAN: "attention",
  WAITING_FOR_USER: "attention",

  // In-progress / blue.
  SPEC_IN_PROGRESS: "progress",
  IMPLEMENTING: "progress",
  REVIEWING: "progress",
  CI_RUNNING: "progress",
  ASSIGNED: "progress",
  RUNNING: "progress",

  // Done / ready for merge / green.
  READY_FOR_MERGE: "success",
  DONE: "success",
  COMPLETED: "success",

  // Failed / red.
  FAILED: "danger",

  // Cancelled and queued-like / grey.
  CANCELLED: "neutral",
  NEEDS_SPEC: "neutral",
  SPEC_REVIEW: "neutral",
  SPEC_APPROVED: "neutral",
  READY: "neutral",
  BLOCKED: "neutral",
  QUEUED: "neutral",
};

export function stateColor(state: string): StatusColor {
  return STATE_COLOR[state] ?? "neutral";
}

export interface StateBadgeProps {
  /** A `TaskState` or `ExecutionState` value, e.g. "READY_FOR_MERGE". */
  state: string;
  /** Override the label instead of deriving it from `state`. */
  label?: string;
}

/** Task or execution state string rendered as a coloured `.badge`. */
export function StateBadge({ state, label }: StateBadgeProps) {
  return <span className={`badge badge--${stateColor(state)}`}>{label ?? humanizeEnum(state)}</span>;
}
