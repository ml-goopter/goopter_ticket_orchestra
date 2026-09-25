import {
  agentTools,
  RAISE_ISSUE_BLOCKING_INSTRUCTION,
  type AgentToolName,
} from "@orchestra/core";

/**
 * One-line semantics per agent-tools MCP tool (design.md §8), keyed by the
 * tool names in `agentTools`. `toolContractFor` filters this by role
 * membership from the registry rather than hard-coding which tools apply
 * to which role, so the two stay in sync.
 */
const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  raise_issue: `raise a question, blocker, ambiguity, or decision for a human. If the response is blocking, ${RAISE_ISSUE_BLOCKING_INSTRUCTION}`,
  report_review_started: "record that an `orchestra-review` round has started, with its round number.",
  report_review_result: "record an `orchestra-review` verdict and its findings for a round.",
  report_usage: "recorded by orchestra-review for each review round. Never call it yourself.",
  report_pr_created: "record the pull request you opened. Ends the execution.",
  report_complete: "tell the orchestrator the specification conversation is finished. Only the user decides this.",
  report_failed: "give up on this execution with a reason and detail. A human is notified, no automatic retry.",
  propose_spec: "submit or update the draft specification for the user to review.",
  note: "leave a non-blocking observation on the task timeline. Does not pause the execution.",
};

/**
 * Renders the `- \`tool_name\`: description` contract lines for every
 * `agentTools` entry whose `roles` includes `role`, in registry order.
 * Backtick-wrapped so downstream tests can check tool-name coverage without
 * matching on prose.
 */
export function toolContractFor(role: "spec" | "implementation"): string {
  return Object.entries(agentTools)
    .filter(([, tool]) => (tool.roles as readonly string[]).includes(role))
    .map(([name]) => `- \`${name}\`: ${TOOL_DESCRIPTIONS[name as AgentToolName]}`)
    .join("\n");
}
