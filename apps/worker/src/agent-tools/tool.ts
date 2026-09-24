import type { AgentToolName, agentTools } from "@orchestra/core";
import type { Actor, Tx } from "@orchestra/db";
import type { z } from "zod";
import type { LiveExecution } from "./registry.js";
import type { AuthContext } from "./tokens.js";

export type ToolInput<N extends AgentToolName> = z.infer<
  (typeof agentTools)[N]["input"]
>;
export type ToolOutput<N extends AgentToolName> = z.infer<
  (typeof agentTools)[N]["output"]
>;

/** What a tool's side effects run with: one open transaction. */
export interface ToolContext {
  tx: Tx;
  auth: AuthContext;
  /** One timestamp per call, so every row a call writes agrees. */
  now: Date;
  /** `{ kind: "agent", id: execution id }`, for `transition()` and audit. */
  actor: Actor;
}

export interface ToolOutcome<N extends AgentToolName> {
  output: ToolOutput<N>;
  /**
   * In-process follow-up that must only happen once the transaction has
   * committed, such as setting `blockingPending`. `live` is undefined when
   * the execution is not in the registry.
   */
  afterCommit?: (live: LiveExecution | undefined) => void;
}

/**
 * One agent tool (design.md §8). Authentication, the role check, input
 * validation, the transaction, lease renewal and the `agent.tool_call`
 * record are the server's job; `run` is only the tool's own side effects.
 */
export interface AgentToolDefinition<N extends AgentToolName> {
  name: N;
  description: string;
  run(ctx: ToolContext, input: ToolInput<N>): Promise<ToolOutcome<N>>;
}

export function defineTool<N extends AgentToolName>(
  def: AgentToolDefinition<N>,
): AgentToolDefinition<N> {
  return def;
}
