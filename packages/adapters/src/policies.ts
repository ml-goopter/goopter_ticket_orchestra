import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ToolPolicy } from "./types.js";

/**
 * Tool allow lists per execution role (design.md §7.1).
 *
 * The entries use Claude Code's permission-rule syntax: a bare tool name
 * allows the tool outright, `Tool(pattern)` narrows it. `Bash(git log:*)` is a
 * prefix rule, so the read-only roles get exactly the git commands they need
 * and nothing else.
 */

/**
 * Built-in tool names of the installed `@anthropic-ai/claude-agent-sdk`
 * (0.3.282), read from `BUILTIN_TOOL_NAMES` in the bundled CLI rather than
 * written from memory. `implementation` is "all built-ins" (design.md §7.1),
 * so it is this list verbatim.
 */
export const CLAUDE_BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "Skill",
  "REPL",
  "JavaScript",
  "AskUserQuestion",
  "ToolSearch",
  "SendUserMessage",
] as const;

/** Name of the agent-tools MCP server registered with the session (§8). */
export const ORCHESTRA_MCP_SERVER = "orchestra";

/** Allows every agent-tools MCP tool (design.md §7.1, `implementation`). */
export const ORCHESTRA_MCP_WILDCARD = `mcp__${ORCHESTRA_MCP_SERVER}__*`;

/**
 * Read-only plus the agent tools a spec session may call.
 *
 * `report_complete` is the spec role's only completion path and `report_failed`
 * is granted to every role (design.md §8), so both belong here even though the
 * §7.1 summary line lists only `propose_spec` and `raise_issue`.
 */
export const SPEC_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git log:*)",
  "Bash(git show:*)",
  `mcp__${ORCHESTRA_MCP_SERVER}__propose_spec`,
  `mcp__${ORCHESTRA_MCP_SERVER}__raise_issue`,
  `mcp__${ORCHESTRA_MCP_SERVER}__note`,
  `mcp__${ORCHESTRA_MCP_SERVER}__report_complete`,
  `mcp__${ORCHESTRA_MCP_SERVER}__report_failed`,
] as const;

/**
 * Read-only plus diff inspection. The test command is appended per call.
 *
 * No agent tools: a review reports through `report_review_result`, which the
 * implementation session owns (design.md §8), so the review session itself
 * only returns findings.
 */
export const REVIEW_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git diff:*)",
  "Bash(git log:*)",
] as const;

/** Every built-in plus the agent-tools MCP server (design.md §7.1). */
export const IMPLEMENTATION_TOOLS = [
  ...CLAUDE_BUILTIN_TOOLS,
  ORCHESTRA_MCP_WILDCARD,
] as const;

export interface AllowedToolsOptions {
  /**
   * Repository test command. Only meaningful for the `review` policy, where
   * design.md §7.1 adds "the repository's test command" to the read-only list.
   */
  testCommand?: string;
}

/**
 * Resolves a policy to the `allowedTools` list passed to the runtime.
 *
 * Returns a fresh array each call so a caller cannot mutate a shared policy.
 */
export function allowedToolsFor(
  policy: ToolPolicy,
  opts: AllowedToolsOptions = {},
): string[] {
  switch (policy) {
    case "spec":
      return [...SPEC_TOOLS];
    case "review": {
      const tools: string[] = [...REVIEW_TOOLS];
      if (opts.testCommand) tools.push(`Bash(${opts.testCommand})`);
      return tools;
    }
    case "implementation":
      return [...IMPLEMENTATION_TOOLS];
  }
}

/**
 * Permission mode the policy has to run under for its allow list to mean
 * anything (SDK `PermissionMode`).
 *
 * `bypassPermissions` approves every tool call without consulting the allow
 * list, so a read-only role under it is read-only in name only. `dontAsk`
 * denies whatever is not pre-approved and never prompts, which is the only
 * mode that turns `allowedTools` into a boundary for an unattended session.
 * `implementation` is deliberately unrestricted (design.md §7.1).
 */
export function permissionModeFor(
  policy: ToolPolicy,
): "bypassPermissions" | "dontAsk" {
  return policy === "implementation" ? "bypassPermissions" : "dontAsk";
}

/**
 * Which filesystem settings sources (`Options.settingSources`, sdk.d.ts
 * ~2245) the session loads from the target repository.
 *
 * Omitting the option loads user, project *and* local `.claude/settings*.json`
 * files, so a repository under review or being specced can grant itself
 * `permissions.allow` rules that re-open `Bash` under `dontAsk`. The read-only
 * roles therefore get `[]` — SDK isolation mode, no filesystem settings at
 * all. `implementation` gets `['project']`: the target repository's
 * `CLAUDE.md` is still read (sdk.d.ts requires `'project'` for that), but the
 * user's and any `.claude/settings.local.json` are not.
 */
export function settingSourcesFor(policy: ToolPolicy): SettingSource[] {
  return policy === "implementation" ? ["project"] : [];
}

/**
 * Base set of built-in tools to offer the session, or `undefined` to leave the
 * runtime on its default (every built-in).
 *
 * `allowedTools` only auto-approves; it does not remove a tool from the
 * model's context. Restricting the SDK's `tools` option as well means a
 * read-only session is never even offered `Write`, so an unlisted built-in
 * cannot be attempted and denied — it does not exist for that session.
 *
 * Derived from the policy's own allow list, so the two cannot drift: an entry
 * `Bash(git log:*)` contributes the built-in `Bash`, and `mcp__*` entries
 * contribute nothing because the `tools` option names built-ins only.
 */
export function builtinToolsFor(
  policy: ToolPolicy,
  opts: AllowedToolsOptions = {},
): string[] | undefined {
  if (policy === "implementation") return undefined;

  const builtins: string[] = [];
  for (const entry of allowedToolsFor(policy, opts)) {
    const name = entry.replace(/\(.*\)$/s, "");
    if (name.startsWith("mcp__")) continue;
    if (!builtins.includes(name)) builtins.push(name);
  }
  return builtins;
}
