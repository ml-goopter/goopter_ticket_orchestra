import { z } from "zod";

/**
 * Domain enums (design.md §4.2, §5, §9.5, §9.6, spec §15).
 *
 * Each enum below produces three artifacts:
 *  - an `as const` object mapping each member name to itself, for use as a
 *    value (e.g. `TaskState.NEEDS_SPEC`);
 *  - a zod schema validating one of the member strings;
 *  - a TS type (same name as the const object; TS keeps value and type
 *    declarations in separate namespaces so this is not a collision).
 *
 * `ENUMS` is a registry from the Postgres enum name (snake_case, per
 * design.md §4.2) to the ordered tuple of values, so `packages/db` can
 * generate `pgEnum` definitions from a single source of truth.
 */

function makeEnum<const T extends readonly [string, ...string[]]>(
  values: T,
): {
  values: T;
  obj: { [K in T[number]]: K };
  schema: z.ZodEnum<{ [K in T[number]]: K }>;
} {
  const obj = Object.fromEntries(values.map((v) => [v, v])) as {
    [K in T[number]]: K;
  };
  return { values, obj, schema: z.enum(values) };
}

const taskState = makeEnum([
  "NEEDS_SPEC",
  "SPEC_IN_PROGRESS",
  "SPEC_REVIEW",
  "SPEC_APPROVED",
  "READY",
  "BLOCKED",
  "IMPLEMENTING",
  "REVIEWING",
  "CI_RUNNING",
  "READY_FOR_MERGE",
  "NEEDS_HUMAN",
  "DONE",
  "CANCELLED",
  "FAILED",
] as const);
export const TaskState = taskState.obj;
export const TaskStateSchema = taskState.schema;
export type TaskState = z.infer<typeof TaskStateSchema>;

const executionState = makeEnum([
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_USER",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const);
export const ExecutionState = executionState.obj;
export const ExecutionStateSchema = executionState.schema;
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

const executionRole = makeEnum(["spec", "implementation"] as const);
export const ExecutionRole = executionRole.obj;
export const ExecutionRoleSchema = executionRole.schema;
export type ExecutionRole = z.infer<typeof ExecutionRoleSchema>;

const runtime = makeEnum(["claude", "codex"] as const);
export const Runtime = runtime.obj;
export const RuntimeSchema = runtime.schema;
export type Runtime = z.infer<typeof RuntimeSchema>;

const endReason = makeEnum([
  "adapter_error",
  "process_crash",
  "lease_expired",
  "agent_hung",
  "setup_failed",
  "protocol_violation",
  "agent_gave_up",
  "budget_exceeded",
  "cancelled",
] as const);
export const EndReason = endReason.obj;
export const EndReasonSchema = endReason.schema;
export type EndReason = z.infer<typeof EndReasonSchema>;

const issueType = makeEnum([
  "QUESTION",
  "DECISION_REQUIRED",
  "BLOCKER",
  "SPEC_AMBIGUITY",
  "MISSING_INFORMATION",
  "MISSING_ACCESS",
  "UNEXPECTED_BEHAVIOR",
  "SCOPE_CONFLICT",
  "DEPENDENCY",
  "RISK",
  "VALIDATION_FAILURE",
] as const);
export const IssueType = issueType.obj;
export const IssueTypeSchema = issueType.schema;
export type IssueType = z.infer<typeof IssueTypeSchema>;

const severity = makeEnum(["info", "warning", "blocking"] as const);
export const Severity = severity.obj;
export const SeveritySchema = severity.schema;
export type Severity = z.infer<typeof SeveritySchema>;

const issueStatus = makeEnum(["OPEN", "RESOLVED", "SUPERSEDED"] as const);
export const IssueStatus = issueStatus.obj;
export const IssueStatusSchema = issueStatus.schema;
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

const resolutionKind = makeEnum(["clarification", "spec_revision"] as const);
export const ResolutionKind = resolutionKind.obj;
export const ResolutionKindSchema = resolutionKind.schema;
export type ResolutionKind = z.infer<typeof ResolutionKindSchema>;

const commandType = makeEnum([
  "start_spec_session",
  "send_message",
  "resume_with_decision",
  "resume_with_revision",
  "resume_with_ci_failure",
  "cancel",
] as const);
export const CommandType = commandType.obj;
export const CommandTypeSchema = commandType.schema;
export type CommandType = z.infer<typeof CommandTypeSchema>;

const prState = makeEnum(["open", "merged", "closed"] as const);
export const PrState = prState.obj;
export const PrStateSchema = prState.schema;
export type PrState = z.infer<typeof PrStateSchema>;

const ciState = makeEnum(["pending", "running", "passed", "failed"] as const);
export const CiState = ciState.obj;
export const CiStateSchema = ciState.schema;
export type CiState = z.infer<typeof CiStateSchema>;

const reviewVerdict = makeEnum(["clean", "findings", "ask_user"] as const);
export const ReviewVerdict = reviewVerdict.obj;
export const ReviewVerdictSchema = reviewVerdict.schema;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

const usageKind = makeEnum(["main", "review", "resume"] as const);
export const UsageKind = usageKind.obj;
export const UsageKindSchema = usageKind.schema;
export type UsageKind = z.infer<typeof UsageKindSchema>;

const notificationKind = makeEnum([
  "issue_raised",
  "spec_review_requested",
  "needs_human",
  "ready_for_merge",
  "execution_failed",
] as const);
export const NotificationKind = notificationKind.obj;
export const NotificationKindSchema = notificationKind.schema;
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

const actorKind = makeEnum(["user", "worker", "agent", "system"] as const);
export const ActorKind = actorKind.obj;
export const ActorKindSchema = actorKind.schema;
export type ActorKind = z.infer<typeof ActorKindSchema>;

const authorKind = makeEnum(["agent", "user"] as const);
export const AuthorKind = authorKind.obj;
export const AuthorKindSchema = authorKind.schema;
export type AuthorKind = z.infer<typeof AuthorKindSchema>;

const revisionStatus = makeEnum(["draft", "approved", "superseded"] as const);
export const RevisionStatus = revisionStatus.obj;
export const RevisionStatusSchema = revisionStatus.schema;
export type RevisionStatus = z.infer<typeof RevisionStatusSchema>;

/**
 * Registry from Postgres enum name to its ordered value tuple. `packages/db`
 * derives every `pgEnum(...)` from this so the enum values never drift
 * between validation (here) and storage (there).
 */
export const ENUMS = {
  task_state: taskState.values,
  execution_state: executionState.values,
  execution_role: executionRole.values,
  runtime: runtime.values,
  end_reason: endReason.values,
  issue_type: issueType.values,
  severity: severity.values,
  issue_status: issueStatus.values,
  resolution_kind: resolutionKind.values,
  command_type: commandType.values,
  pr_state: prState.values,
  ci_state: ciState.values,
  review_verdict: reviewVerdict.values,
  usage_kind: usageKind.values,
  notification_kind: notificationKind.values,
  actor_kind: actorKind.values,
  author_kind: authorKind.values,
  revision_status: revisionStatus.values,
} as const;
