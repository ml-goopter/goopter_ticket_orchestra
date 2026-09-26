import type { ExecutionEventType, ExecutionState } from "@orchestra/core";
import type { Execution, TimelineEvent } from "../api/types.js";

/**
 * Event types the spec builder's chat subscribes to on `GET
 * /tasks/:id/stream` (design.md §12.3, §12.6, §14 Spec builder row). Agent
 * text and tool calls drive the chat; `execution.started`/`.resumed` (F2,
 * GOT.38 review round 2: a retry or resume can start a spec execution the
 * last-loaded aggregate doesn't know about yet), the `spec.*` events, and
 * `task.state_changed` drive refetches of the draft and aggregate.
 */
export const SPEC_STREAM_EVENT_TYPES = [
  "agent.message.delta",
  "agent.message",
  "agent.tool_call",
  "execution.started",
  "execution.resumed",
  "spec.proposed",
  "spec.revised",
  "spec.review_requested",
  "spec.sent_back",
  "spec.approved",
  "task.state_changed",
] as const satisfies readonly ExecutionEventType[];

export type SpecStreamEventType = (typeof SPEC_STREAM_EVENT_TYPES)[number];

/**
 * Execution states a spec execution can take a message in (mirrors
 * `apps/api/src/routes/spec.ts`'s `LIVE_EXECUTION_STATES`, §5.2): not yet
 * ended. `POST /tasks/:id/spec/messages` refuses with 409
 * `NO_LIVE_SPEC_EXECUTION` outside this set.
 */
const LIVE_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set([
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_USER",
]);

export function isLiveExecutionState(state: ExecutionState | null | undefined): boolean {
  return state !== null && state !== undefined && LIVE_EXECUTION_STATES.has(state);
}

/**
 * Whether a `GET /tasks/:id/timeline` backlog row belongs in the spec
 * chat pane on page load: chat text/tool calls from a spec-role execution
 * (never an implementation execution's), plus the issue-independent
 * `spec.*` transition events, which `apps/worker`'s `propose_spec` tool
 * tags with the spec execution's id but the `spec.ts` route (revise,
 * review, send back, approve) leaves execution-less (`null`).
 */
export function isSpecChatBacklogEvent(event: TimelineEvent, specExecutionIds: ReadonlySet<string>): boolean {
  if (event.type === "agent.message" || event.type === "agent.tool_call") {
    return event.executionId !== null && specExecutionIds.has(event.executionId);
  }
  if (event.type.startsWith("spec.")) {
    return event.executionId === null || specExecutionIds.has(event.executionId);
  }
  return false;
}

/** The task's spec-role execution ids (an aggregate can carry several across retries), for `isSpecChatBacklogEvent`/`isSpecChatLiveEvent`. */
export function specRoleExecutionIds(executions: readonly Pick<Execution, "id" | "role">[]): Set<string> {
  return new Set(executions.filter((execution) => execution.role === "spec").map((execution) => execution.id));
}

const CHAT_EVENT_TYPES: ReadonlySet<string> = new Set(["agent.message", "agent.message.delta", "agent.tool_call"]);

/**
 * Whether `type` is one of the per-execution live chat row types
 * (`agent.message`, `.delta`, `agent.tool_call`) `SpecBuilderView` gates on
 * a spec-execution id (F1, GOT.38 review round 1: the stream carries every
 * execution event for the task, not just the spec execution's, e.g. a
 * paused implementation execution sharing the task, design.md §10.4), as
 * opposed to a task-scoped type (`spec.*`, `task.state_changed`,
 * `execution.started`/`.resumed`) that is never gated on an execution id.
 * An id that doesn't match the task's known spec-role executions is
 * buffered rather than dropped outright (F2, GOT.38 review round 2): a
 * retry can start a new spec execution the last-loaded aggregate doesn't
 * know about yet, so `SpecBuilderView` re-checks a buffered id against a
 * freshly-fetched aggregate before deciding it is genuinely foreign.
 */
export function isSpecChatEventType(type: string): boolean {
  return CHAT_EVENT_TYPES.has(type);
}
