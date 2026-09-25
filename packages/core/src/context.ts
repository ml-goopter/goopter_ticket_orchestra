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
