import type { ExecutionEventType, ExecutionState } from "@orchestra/core";

/**
 * Event types the spec builder's chat subscribes to on `GET
 * /tasks/:id/stream` (design.md §12.3, §12.6, §14 Spec builder row). Agent
 * text and tool calls drive the chat; the `spec.*` and `task.state_changed`
 * events drive refetches of the draft and aggregate.
 */
export const SPEC_STREAM_EVENT_TYPES = [
  "agent.message.delta",
  "agent.message",
  "agent.tool_call",
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
