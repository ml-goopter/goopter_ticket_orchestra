import { z } from "zod";
import {
  IssueTypeSchema,
  ReviewVerdictSchema,
  SeveritySchema,
  UsageKindSchema,
} from "./enums.js";
import { SpecContentSchema } from "./spec-content.js";

/**
 * Agent-tools MCP server tool schemas (design.md §8). Every tool takes and
 * returns JSON validated by the schemas below.
 */

/** Instruction returned by `raise_issue` when the issue is blocking. */
export const RAISE_ISSUE_BLOCKING_INSTRUCTION =
  "Stop now. End your turn without further work. You will be resumed with the answer.";

/** Instruction returned by `report_review_result` once `round` exceeds `max_review_rounds`. */
export const REVIEW_ROUND_LIMIT_INSTRUCTION =
  "Stop now. Do not continue the review loop. Call report_failed.";

const OptionSchema = z.object({
  id: z.string(),
  description: z.string(),
  tradeoff: z.string(),
});

/** One review finding (design.md §8 `report_review_result`, §9.8). */
export const FindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  description: z.string(),
  action: z.string(),
});

const OkOutputSchema = z.object({ ok: z.literal(true) });

// raise_issue — roles: all (spec, implementation)
export const RaiseIssueInputSchema = z.object({
  type: IssueTypeSchema,
  severity: SeveritySchema,
  blocking: z.boolean(),
  title: z.string(),
  description: z.string(),
  question: z.string().optional(),
  options: z.array(OptionSchema).optional(),
  recommended_option: z.string().optional(),
});
export type RaiseIssueInput = z.infer<typeof RaiseIssueInputSchema>;

export const RaiseIssueOutputSchema = z.object({
  issue_id: z.string(),
  instruction: z.string().optional(),
});
export type RaiseIssueOutput = z.infer<typeof RaiseIssueOutputSchema>;

// report_review_started — roles: implementation
export const ReportReviewStartedInputSchema = z.object({
  round: z.number().int().positive(),
});
export type ReportReviewStartedInput = z.infer<
  typeof ReportReviewStartedInputSchema
>;

export const ReportReviewStartedOutputSchema = OkOutputSchema;
export type ReportReviewStartedOutput = z.infer<
  typeof ReportReviewStartedOutputSchema
>;

// report_review_result — roles: implementation
export const ReportReviewResultInputSchema = z.object({
  round: z.number().int().positive(),
  verdict: ReviewVerdictSchema,
  findings: z.array(FindingSchema),
  /** `report_usage` result for this round's review session (design.md §9.7). */
  usage_id: z.string().optional(),
});
export type ReportReviewResultInput = z.infer<
  typeof ReportReviewResultInputSchema
>;

export const ReportReviewResultOutputSchema = z.object({
  ok: z.literal(true),
  instruction: z.string().optional(),
});
export type ReportReviewResultOutput = z.infer<
  typeof ReportReviewResultOutputSchema
>;

/**
 * The JSON document a review session replies with and `orchestra-review`
 * prints to stdout (design.md §9.8).
 */
export const ReviewFindingsDocumentSchema = z.object({
  verdict: ReviewVerdictSchema,
  findings: z.array(FindingSchema),
});
export type ReviewFindingsDocument = z.infer<
  typeof ReviewFindingsDocumentSchema
>;

// report_usage — roles: implementation (design.md §9.7: `orchestra-review`
// runs report their own usage with `kind = review`)
const TokenCountSchema = z.number().int().nonnegative();

export const ReportUsageInputSchema = z.object({
  kind: UsageKindSchema,
  round: z.number().int().positive().optional(),
  model: z.string(),
  input_tokens: TokenCountSchema,
  cached_input_tokens: TokenCountSchema,
  output_tokens: TokenCountSchema,
  cost_usd: z.number().nonnegative(),
});
export type ReportUsageInput = z.infer<typeof ReportUsageInputSchema>;

export const ReportUsageOutputSchema = z.object({
  usage_id: z.string(),
});
export type ReportUsageOutput = z.infer<typeof ReportUsageOutputSchema>;

// report_pr_created — roles: implementation
export const ReportPrCreatedInputSchema = z.object({
  url: z.string(),
  number: z.number().int().positive(),
  head_sha: z.string(),
});
export type ReportPrCreatedInput = z.infer<typeof ReportPrCreatedInputSchema>;

export const ReportPrCreatedOutputSchema = OkOutputSchema;
export type ReportPrCreatedOutput = z.infer<
  typeof ReportPrCreatedOutputSchema
>;

// report_complete — roles: spec
export const ReportCompleteInputSchema = z.object({
  summary: z.string(),
});
export type ReportCompleteInput = z.infer<typeof ReportCompleteInputSchema>;

export const ReportCompleteOutputSchema = OkOutputSchema;
export type ReportCompleteOutput = z.infer<typeof ReportCompleteOutputSchema>;

// report_failed — roles: all (spec, implementation)
export const ReportFailedInputSchema = z.object({
  reason: z.string(),
  detail: z.string(),
});
export type ReportFailedInput = z.infer<typeof ReportFailedInputSchema>;

export const ReportFailedOutputSchema = OkOutputSchema;
export type ReportFailedOutput = z.infer<typeof ReportFailedOutputSchema>;

// propose_spec — roles: spec
export const ProposeSpecInputSchema = SpecContentSchema;
export type ProposeSpecInput = z.infer<typeof ProposeSpecInputSchema>;

export const ProposeSpecOutputSchema = OkOutputSchema;
export type ProposeSpecOutput = z.infer<typeof ProposeSpecOutputSchema>;

// note — roles: all (spec, implementation)
export const NoteInputSchema = z.object({
  text: z.string(),
});
export type NoteInput = z.infer<typeof NoteInputSchema>;

export const NoteOutputSchema = OkOutputSchema;
export type NoteOutput = z.infer<typeof NoteOutputSchema>;

/**
 * Registry of every agent-tools MCP tool, its allowed roles (design.md §8
 * "roles" column), and its input/output zod schemas. `report_usage` is not
 * in the §8 table; §9.7 has `orchestra-review` record its own usage.
 */
export const agentTools = {
  raise_issue: {
    roles: ["spec", "implementation"],
    input: RaiseIssueInputSchema,
    output: RaiseIssueOutputSchema,
  },
  report_review_started: {
    roles: ["implementation"],
    input: ReportReviewStartedInputSchema,
    output: ReportReviewStartedOutputSchema,
  },
  report_review_result: {
    roles: ["implementation"],
    input: ReportReviewResultInputSchema,
    output: ReportReviewResultOutputSchema,
  },
  report_usage: {
    roles: ["implementation"],
    input: ReportUsageInputSchema,
    output: ReportUsageOutputSchema,
  },
  report_pr_created: {
    roles: ["implementation"],
    input: ReportPrCreatedInputSchema,
    output: ReportPrCreatedOutputSchema,
  },
  report_complete: {
    roles: ["spec"],
    input: ReportCompleteInputSchema,
    output: ReportCompleteOutputSchema,
  },
  report_failed: {
    roles: ["spec", "implementation"],
    input: ReportFailedInputSchema,
    output: ReportFailedOutputSchema,
  },
  propose_spec: {
    roles: ["spec"],
    input: ProposeSpecInputSchema,
    output: ProposeSpecOutputSchema,
  },
  note: {
    roles: ["spec", "implementation"],
    input: NoteInputSchema,
    output: NoteOutputSchema,
  },
} as const satisfies Record<
  string,
  {
    roles: readonly ("spec" | "implementation")[];
    input: z.ZodTypeAny;
    output: z.ZodTypeAny;
  }
>;

export type AgentToolName = keyof typeof agentTools;
