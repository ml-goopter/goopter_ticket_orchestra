import { z } from "zod";
import type { DeltaAccumulator } from "../sse/deltas.js";

/** `agent.message.delta` and `agent.message` payload shape (apps/worker/src/runner/runner.ts). */
export const AgentMessagePayloadSchema = z.object({ text: z.string() });

/** One in-progress-then-final agent reply bubble for the issue's execution. */
export interface LiveReply {
  text: string;
  final: boolean;
}

/**
 * Reduces `agent.message.delta`/`agent.message` events for one execution
 * into a single bubble (design.md §12.6: "Agent text arrives as
 * agent.message.delta ... concatenated by the client"; spec §19
 * conversation around issues). Deltas concatenate through `accumulator`
 * keyed by `executionId`; the final `agent.message` clears that buffer and
 * replaces the bubble with its own (complete) text, so a later turn starts
 * from an empty buffer rather than appending onto stale text.
 */
export function reduceAgentReply(
  accumulator: DeltaAccumulator,
  executionId: string,
  event: { type: "agent.message.delta" | "agent.message"; text: string },
): LiveReply {
  if (event.type === "agent.message.delta") {
    return { text: accumulator.append(executionId, event.text), final: false };
  }
  accumulator.flush(executionId);
  return { text: event.text, final: true };
}
