/**
 * `execution_events.type` values (design.md §9.6). `task.state_changed` is
 * written by `transition()` for every task move; `usage.recorded` is written
 * whenever an `execution_usage` row is inserted. `spec.message` (GOT.57 D1)
 * is the user's side of a spec builder chat turn, written by `POST
 * /tasks/:id/spec/messages` alongside its `send_message` command; its
 * payload is `{ text, author_user_id }`, distinct from `issue.message` and
 * never carried on `agent.message`.
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
  "spec.message",
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
