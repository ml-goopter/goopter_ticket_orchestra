import { TaskState, ExecutionState } from "./enums.js";

/**
 * Declarative `(entity, from, trigger) -> to` table for the task and
 * execution state machines (design.md §5). This is the "full table" that
 * §5.3 refers to as code; the prose table there is an excerpt.
 *
 * Trigger naming: where §5.3 or §9.6 already names an event for an edge
 * (`task.claimed`, `review.started`, `review.findings`,
 * `pull_request.created`, `ci.failed`, `ci.passed`, `pull_request.merged`,
 * `pull_request.closed`, `issue.resolved.spec_revision`, `spec.approved`,
 * `spec.review_requested`, `spec.sent_back`, `resume_with_ci_failure`) that
 * name is reused verbatim. Edges §5 only describes in prose get a
 * consistent dotted name invented here:
 *
 *  - `spec.session_started`  NEEDS_SPEC -> SPEC_IN_PROGRESS
 *  - `dependency.satisfied`  SPEC_APPROVED -> READY (dependency check, no
 *    paused execution)
 *  - `dependency.failed`     SPEC_APPROVED -> BLOCKED (dependency check)
 *  - `dependency.resolved`   BLOCKED -> READY
 *  - `spec.revise`           SPEC_APPROVED/READY -> SPEC_IN_PROGRESS
 *    (§12.3 POST /spec/revise)
 *  - `task.escalated`        IMPLEMENTING/REVIEWING/CI_RUNNING -> NEEDS_HUMAN
 *  - `human.retry`           NEEDS_HUMAN -> READY
 *  - `task.cancelled`        any state except DONE/CANCELLED -> CANCELLED
 *  - `task.failed`           any non-terminal state -> FAILED
 *  - `execution.assigned`    QUEUED -> ASSIGNED
 *  - `execution.started`     ASSIGNED -> RUNNING
 *  - `execution.waiting`     RUNNING -> WAITING_FOR_USER
 *  - `execution.resumed`     WAITING_FOR_USER -> RUNNING
 *  - `execution.completed`   RUNNING -> COMPLETED
 *  - `execution.failed`      ASSIGNED/RUNNING -> FAILED
 *  - `execution.cancelled`   QUEUED/ASSIGNED/RUNNING/WAITING_FOR_USER -> CANCELLED
 *
 * Note: `spec.approved` appears twice with different `from` states
 * (SPEC_REVIEW -> SPEC_APPROVED, and SPEC_APPROVED -> IMPLEMENTING for
 * "approve with paused execution", §5.3 row 9). Both rows are legal because
 * uniqueness is keyed on `(entity, from, trigger)`, not `trigger` alone.
 * The "no execution" dependency-check outcome (§5.3 row 10) is split into
 * the two deterministic triggers above, since a single trigger cannot map
 * one `(entity, from)` pair to two different `to` states.
 */

export const TASK_TRANSITIONS = [
  { entity: "task", from: TaskState.NEEDS_SPEC, trigger: "spec.session_started", to: TaskState.SPEC_IN_PROGRESS },
  { entity: "task", from: TaskState.SPEC_IN_PROGRESS, trigger: "spec.review_requested", to: TaskState.SPEC_REVIEW },
  { entity: "task", from: TaskState.SPEC_REVIEW, trigger: "spec.sent_back", to: TaskState.SPEC_IN_PROGRESS },
  { entity: "task", from: TaskState.SPEC_REVIEW, trigger: "spec.approved", to: TaskState.SPEC_APPROVED },
  { entity: "task", from: TaskState.SPEC_APPROVED, trigger: "dependency.satisfied", to: TaskState.READY },
  { entity: "task", from: TaskState.SPEC_APPROVED, trigger: "dependency.failed", to: TaskState.BLOCKED },
  { entity: "task", from: TaskState.SPEC_APPROVED, trigger: "spec.approved", to: TaskState.IMPLEMENTING },
  { entity: "task", from: TaskState.READY, trigger: "task.claimed", to: TaskState.IMPLEMENTING },
  { entity: "task", from: TaskState.IMPLEMENTING, trigger: "review.started", to: TaskState.REVIEWING },
  { entity: "task", from: TaskState.REVIEWING, trigger: "review.findings", to: TaskState.IMPLEMENTING },
  { entity: "task", from: TaskState.REVIEWING, trigger: "pull_request.created", to: TaskState.CI_RUNNING },
  { entity: "task", from: TaskState.CI_RUNNING, trigger: "ci.failed", to: TaskState.IMPLEMENTING },
  { entity: "task", from: TaskState.CI_RUNNING, trigger: "ci.passed", to: TaskState.READY_FOR_MERGE },
  { entity: "task", from: TaskState.READY_FOR_MERGE, trigger: "pull_request.merged", to: TaskState.DONE },
  { entity: "task", from: TaskState.IMPLEMENTING, trigger: "issue.resolved.spec_revision", to: TaskState.SPEC_IN_PROGRESS },
  { entity: "task", from: TaskState.REVIEWING, trigger: "issue.resolved.spec_revision", to: TaskState.SPEC_IN_PROGRESS },
  { entity: "task", from: TaskState.IMPLEMENTING, trigger: "task.escalated", to: TaskState.NEEDS_HUMAN },
  { entity: "task", from: TaskState.REVIEWING, trigger: "task.escalated", to: TaskState.NEEDS_HUMAN },
  { entity: "task", from: TaskState.CI_RUNNING, trigger: "task.escalated", to: TaskState.NEEDS_HUMAN },
  { entity: "task", from: TaskState.NEEDS_HUMAN, trigger: "human.retry", to: TaskState.READY },
  { entity: "task", from: TaskState.READY_FOR_MERGE, trigger: "pull_request.closed", to: TaskState.NEEDS_HUMAN },
  { entity: "task", from: TaskState.BLOCKED, trigger: "dependency.resolved", to: TaskState.READY },
  // design.md §12.3 POST /spec/revise: "from SPEC_APPROVED or READY only".
  { entity: "task", from: TaskState.SPEC_APPROVED, trigger: "spec.revise", to: TaskState.SPEC_IN_PROGRESS },
  { entity: "task", from: TaskState.READY, trigger: "spec.revise", to: TaskState.SPEC_IN_PROGRESS },

  // Any state except DONE and CANCELLED itself may cancel (design.md §5.1
  // prose). Expanded into one explicit row per source state.
  { entity: "task", from: TaskState.NEEDS_SPEC, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.SPEC_IN_PROGRESS, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.SPEC_REVIEW, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.SPEC_APPROVED, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.READY, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.BLOCKED, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.IMPLEMENTING, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.REVIEWING, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.CI_RUNNING, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.READY_FOR_MERGE, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.NEEDS_HUMAN, trigger: "task.cancelled", to: TaskState.CANCELLED },
  { entity: "task", from: TaskState.FAILED, trigger: "task.cancelled", to: TaskState.CANCELLED },

  // FAILED is reachable from any non-terminal state on `task.failed`
  // (ticket disappeared or repository deleted, §5.1 prose).
  { entity: "task", from: TaskState.NEEDS_SPEC, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.SPEC_IN_PROGRESS, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.SPEC_REVIEW, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.SPEC_APPROVED, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.READY, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.BLOCKED, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.IMPLEMENTING, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.REVIEWING, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.CI_RUNNING, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.READY_FOR_MERGE, trigger: "task.failed", to: TaskState.FAILED },
  { entity: "task", from: TaskState.NEEDS_HUMAN, trigger: "task.failed", to: TaskState.FAILED },
] as const satisfies readonly {
  entity: "task";
  from: TaskState;
  trigger: string;
  to: TaskState;
}[];

export const EXECUTION_TRANSITIONS = [
  { entity: "execution", from: ExecutionState.QUEUED, trigger: "execution.assigned", to: ExecutionState.ASSIGNED },
  { entity: "execution", from: ExecutionState.ASSIGNED, trigger: "execution.started", to: ExecutionState.RUNNING },
  { entity: "execution", from: ExecutionState.RUNNING, trigger: "execution.waiting", to: ExecutionState.WAITING_FOR_USER },
  { entity: "execution", from: ExecutionState.WAITING_FOR_USER, trigger: "execution.resumed", to: ExecutionState.RUNNING },
  { entity: "execution", from: ExecutionState.RUNNING, trigger: "execution.completed", to: ExecutionState.COMPLETED },
  { entity: "execution", from: ExecutionState.RUNNING, trigger: "execution.failed", to: ExecutionState.FAILED },
  // A failure before the session starts: setup_failed, an adapter error or
  // agent_hung before the `session` event (§9.3-§9.5), lease_expired (§6.5).
  { entity: "execution", from: ExecutionState.ASSIGNED, trigger: "execution.failed", to: ExecutionState.FAILED },
  { entity: "execution", from: ExecutionState.QUEUED, trigger: "execution.cancelled", to: ExecutionState.CANCELLED },
  { entity: "execution", from: ExecutionState.ASSIGNED, trigger: "execution.cancelled", to: ExecutionState.CANCELLED },
  { entity: "execution", from: ExecutionState.RUNNING, trigger: "execution.cancelled", to: ExecutionState.CANCELLED },
  { entity: "execution", from: ExecutionState.WAITING_FOR_USER, trigger: "execution.cancelled", to: ExecutionState.CANCELLED },
  // The one backward edge (design.md §5.2 prose): CI feedback resumes the
  // same execution instead of creating a new one.
  { entity: "execution", from: ExecutionState.COMPLETED, trigger: "resume_with_ci_failure", to: ExecutionState.RUNNING },
] as const satisfies readonly {
  entity: "execution";
  from: ExecutionState;
  trigger: string;
  to: ExecutionState;
}[];

export const TRANSITIONS = [...TASK_TRANSITIONS, ...EXECUTION_TRANSITIONS] as const;

export type TransitionRow = (typeof TRANSITIONS)[number];

/** String literal union of every trigger name used in the table. */
export type Trigger = TransitionRow["trigger"];

export type EntityKind = TransitionRow["entity"];
