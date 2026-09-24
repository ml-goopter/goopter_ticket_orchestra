import { z } from "zod";
import { IssueTypeSchema, ReviewVerdictSchema, SeveritySchema } from "./enums.js";
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

const FindingSchema = z.object({
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
 * "roles" column), and its input/output zod schemas.
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
