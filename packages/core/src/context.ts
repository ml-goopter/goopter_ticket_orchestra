import { z } from "zod";
import { RuntimeSchema } from "./enums.js";
import { SpecContentSchema } from "./spec-content.js";

/**
 * Execution context file written into every implementation worktree
 * (design.md §9.1 step 4) and read by `orchestra-review` (§9.8). The worker
 * writes it, the review wrapper reads it; both validate with this schema.
 * Field names are snake_case like the other JSON wire formats in core.
 */

/** Path of the context file, relative to the worktree root. */
export const EXECUTION_CONTEXT_PATH = ".orchestra/context.json";

export const ExecutionContextSchema = z.object({
  task: z.object({
    id: z.string().min(1),
    jira_key: z.string().min(1),
    jira_summary: z.string(),
  }),
  /** The approved specification revision this execution runs against. */
  spec: z.object({
    version: z.number().int().positive(),
    content: SpecContentSchema,
  }),
  /** `task_decisions` rows recorded on the task (design.md §4.2). */
  decisions: z.array(
    z.object({
      issue_id: z.string().min(1),
      decision: z.string(),
      clarification: z.string().nullable(),
      chosen_option: z.string().nullable(),
      decided_by: z.string(),
      decided_at: z.string(),
    }),
  ),
  repository: z.object({
    name: z.string().min(1),
    default_branch: z.string().min(1),
    /** Working branch, `agent/<KEY>-<short>`. */
    branch: z.string().min(1),
  }),
  /**
   * Runtime of the parent execution (`executions.runtime`). `orchestra-review`
   * starts its review session through the same adapter (design.md §9.8).
   */
  runtime: RuntimeSchema,
  /**
   * Command the review role may run. Its source is open (design.md OI3), so
   * it is caller-supplied and `null` when unknown.
   */
  review_command: z.string().min(1).nullable(),
});

export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

/**
 * Claude credential file in an agent container (design.md §9.9 Auth). The
 * Claude CLI strips auth variables from commands its Bash tool runs, so
 * `orchestra-review`, launched through that tool, cannot see them. The
 * worker writes this file on every `ContainerManager.ensure` and the
 * wrapper reads it when its own env has no credential. The path is in the
 * container's own filesystem, not a host mount.
 */
export const CLAUDE_AUTH_FILE_PATH = "/run/orchestra/claude-auth";

/** The only names the file may carry, in order of preference. */
export const CLAUDE_AUTH_ENV_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

export type ClaudeAuthEnvName = (typeof CLAUDE_AUTH_ENV_NAMES)[number];

export interface ClaudeAuth {
  name: ClaudeAuthEnvName;
  value: string;
}

/**
 * The file's content for `env`: one line `NAME=value`, the OAuth token
 * preferred over the API key. Null when neither is set.
 */
export function claudeAuthFileContent(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  for (const name of CLAUDE_AUTH_ENV_NAMES) {
    const value = env[name];
    if (value) return `${name}=${value}\n`;
  }
  return null;
}

/**
 * Parses the file: exactly one `NAME=value` line, optionally ending in a
 * newline, NAME one of `CLAUDE_AUTH_ENV_NAMES`, value non-empty. Null when
 * the text is anything else.
 */
export function parseClaudeAuthFile(text: string): ClaudeAuth | null {
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (/[\r\n]/.test(line)) return null;
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const name = line.slice(0, eq);
  const value = line.slice(eq + 1);
  if (value === "") return null;
  const known = CLAUDE_AUTH_ENV_NAMES.find((n) => n === name);
  return known ? { name: known, value } : null;
}
