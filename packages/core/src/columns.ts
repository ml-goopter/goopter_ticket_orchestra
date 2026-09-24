import { TaskState } from "./enums.js";

/**
 * Derived dashboard columns (design.md §5.1 table). Pure function of task
 * state plus whether any execution on the task is `WAITING_FOR_USER`.
 */
export const DASHBOARD_COLUMNS = [
  "Needs Spec",
  "Spec In Progress",
  "Awaiting Spec Approval",
  "Ready",
  "Implementing",
  "Waiting for You",
  "CI",
  "Ready for Merge",
  "Needs Human",
  "Done",
] as const;

export type DashboardColumn = (typeof DASHBOARD_COLUMNS)[number];

/**
 * `FAILED` is not listed in the §5.1 column table (which enumerates
 * `DONE`, `CANCELLED` for the "Done" column). Treated as "Done" here since
 * it is a terminal task state with nothing left to act on.
 */
function baseColumn(taskState: TaskState): DashboardColumn {
  switch (taskState) {
    case TaskState.NEEDS_SPEC:
      return "Needs Spec";
    case TaskState.SPEC_IN_PROGRESS:
      return "Spec In Progress";
    case TaskState.SPEC_REVIEW:
      return "Awaiting Spec Approval";
    case TaskState.SPEC_APPROVED:
    case TaskState.READY:
    case TaskState.BLOCKED:
      return "Ready";
    case TaskState.IMPLEMENTING:
    case TaskState.REVIEWING:
      return "Implementing";
    case TaskState.CI_RUNNING:
      return "CI";
    case TaskState.READY_FOR_MERGE:
      return "Ready for Merge";
    case TaskState.NEEDS_HUMAN:
      return "Needs Human";
    case TaskState.DONE:
    case TaskState.CANCELLED:
    case TaskState.FAILED:
      return "Done";
    default: {
      const exhaustive: never = taskState;
      throw new Error(`unhandled task state: ${String(exhaustive)}`);
    }
  }
}

/**
 * "Waiting for You" wins for any task state when an execution on the task
 * is `WAITING_FOR_USER` (§5.1 table); otherwise the state maps directly.
 */
export function deriveColumn(
  taskState: TaskState,
  hasExecutionWaitingForUser: boolean,
): DashboardColumn {
  if (hasExecutionWaitingForUser) {
    return "Waiting for You";
  }
  return baseColumn(taskState);
}
