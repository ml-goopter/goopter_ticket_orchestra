/**
 * `execution_events.type` values (design.md §9.6). `task.state_changed` is
 * written by `transition()` for every task move; `usage.recorded` is written
 * whenever an `execution_usage` row is inserted.
 */
export const EXECUTION_EVENT_TYPES = [
  "execution.queued",
  "execution.assigned",
  "execution.started",
  "execution.resumed",
  "execution.heartbeat",
  "execution.waiting",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
  "worktree.prepared",
  "worktree.evicted",
  "agent.message.delta",
  "agent.message",
  "agent.tool_call",
  "agent.note",
  "spec.proposed",
  "spec.review_requested",
  "spec.approved",
  "spec.sent_back",
  "spec.revised",
  "issue.created",
  "issue.message",
  "issue.resolved",
  "review.started",
  "review.result",
  "pull_request.created",
  "ci.started",
  "ci.failed",
  "ci.passed",
  "pull_request.merged",
  "pull_request.closed",
  "task.state_changed",
  "usage.recorded",
] as const;

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];
