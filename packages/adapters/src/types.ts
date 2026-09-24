import type { Runtime } from "@orchestra/core";

/**
 * The agent adapter contract (design.md §7).
 *
 * One adapter per runtime. Cancel is the `AbortSignal`, status is the event
 * stream, and the result is the `turn_done` event plus whatever the agent
 * reported through agent-tools. Adapters yield events; persisting them is the
 * worker's job, which is why this package never imports `@orchestra/db`
 * (design.md §3).
 */

/** Execution role a session runs under, which fixes its tool allow list. */
export type ToolPolicy = "implementation" | "spec" | "review";

export interface StartRequest {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  model?: string;
  allowedTools: ToolPolicy;
  mcp: { url: string; token: string };
  env: Record<string, string>;
  maxBudgetUsd?: number;
}

/**
 * Token and cost totals a resumed session has already reported, keyed per
 * model.
 *
 * Runtimes report usage for the whole session, not the turn, so a resume
 * repeats every earlier turn's numbers, and a multi-model turn reports one
 * set of totals per model. Subtracting the matching model's baseline is what
 * keeps `execution_costs` from double counting (design.md §9.7); a model with
 * no entry here is emitted unchanged. `costUsd` is optional per model because
 * the delta it feeds is a single session-wide number (cumulative
 * `total_cost_usd` minus the sum of every model's baseline `costUsd`,
 * clamped at zero), not a per-model subtraction.
 */
export interface ModelUsageBaseline {
  input: number;
  cached: number;
  output: number;
  costUsd?: number;
}

export type UsageBaseline = Record<string, ModelUsageBaseline>;

export interface ResumeRequest extends Omit<StartRequest, "systemPrompt"> {
  sessionId: string;
  /**
   * Totals already recorded for this session. Optional extension of the §7
   * request shape: when present the adapter emits only the delta since these
   * numbers, clamped at zero.
   *
   * When absent the adapter emits the runtime's cumulative totals unchanged,
   * so the worker must persist the running totals per session and pass them
   * back on every resume, or the same tokens are billed again.
   */
  usageBaseline?: UsageBaseline;
}

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean }
  | {
      type: "usage";
      model: string;
      input: number;
      cached: number;
      output: number;
      costUsd?: number;
    }
  | { type: "turn_done"; finalText: string }
  | { type: "error"; message: string; retriable: boolean };

export interface AgentAdapter {
  /** `'claude' | 'codex'` (design.md §7). */
  readonly runtime: Runtime;
  start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resume(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  canResume(sessionId: string, cwd: string): Promise<boolean>;
}

/**
 * Compile-time proof that the list below covers the `AgentEvent` union
 * exactly. `Record<AgentEvent["type"], true>` rejects the object literal when
 * a union member is missing, and rejects an entry that is not a member, so
 * adding an event type without updating this map fails `tsc -b`.
 */
const AGENT_EVENT_TYPE_SET: Record<AgentEvent["type"], true> = {
  session: true,
  text: true,
  tool_call: true,
  tool_result: true,
  usage: true,
  turn_done: true,
  error: true,
};

/** Every `AgentEvent` discriminator, for exhaustive handling and tests. */
export const AGENT_EVENT_TYPES = Object.keys(
  AGENT_EVENT_TYPE_SET,
) as AgentEvent["type"][];
