import { describe, expect, it } from "vitest";
import {
  ActorKindSchema,
  AuthorKindSchema,
  CiStateSchema,
  CommandTypeSchema,
  EndReasonSchema,
  ExecutionRoleSchema,
  ExecutionStateSchema,
  IssueStatusSchema,
  IssueTypeSchema,
  NotificationKindSchema,
  PrStateSchema,
  ResolutionKindSchema,
  RevisionStatusSchema,
  ReviewVerdictSchema,
  RuntimeSchema,
  SeveritySchema,
  TaskStateSchema,
  UsageKindSchema,
} from "./enums.js";

/**
 * design.md §4.2, §5, §9.5, spec §15. Each entry is the exact ordered
 * value list the corresponding zod enum must expose.
 */
const EXPECTED = {
  task_state: [
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
  ],
  execution_state: [
    "QUEUED",
    "ASSIGNED",
    "RUNNING",
    "WAITING_FOR_USER",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ],
  execution_role: ["spec", "implementation"],
  runtime: ["claude", "codex"],
  end_reason: [
    "adapter_error",
    "process_crash",
    "lease_expired",
    "agent_hung",
    "setup_failed",
    "protocol_violation",
    "agent_gave_up",
    "budget_exceeded",
    "cancelled",
  ],
  issue_type: [
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
  ],
  severity: ["info", "warning", "blocking"],
  issue_status: ["OPEN", "RESOLVED", "SUPERSEDED"],
  resolution_kind: ["clarification", "spec_revision"],
  command_type: [
    "start_spec_session",
    "send_message",
    "resume_with_decision",
    "resume_with_revision",
    "resume_with_ci_failure",
    "cancel",
  ],
  pr_state: ["open", "merged", "closed"],
  ci_state: ["pending", "running", "passed", "failed"],
  review_verdict: ["clean", "findings", "ask_user"],
  usage_kind: ["main", "review", "resume"],
  notification_kind: [
    "issue_raised",
    "spec_review_requested",
    "needs_human",
    "ready_for_merge",
    "execution_failed",
  ],
  actor_kind: ["user", "worker", "agent", "system"],
  revision_status: ["draft", "approved", "superseded"],
  author_kind: ["agent", "user"],
} as const;

const SCHEMAS = {
  task_state: TaskStateSchema,
  execution_state: ExecutionStateSchema,
  execution_role: ExecutionRoleSchema,
  runtime: RuntimeSchema,
  end_reason: EndReasonSchema,
  issue_type: IssueTypeSchema,
  severity: SeveritySchema,
  issue_status: IssueStatusSchema,
  resolution_kind: ResolutionKindSchema,
  command_type: CommandTypeSchema,
  pr_state: PrStateSchema,
  ci_state: CiStateSchema,
  review_verdict: ReviewVerdictSchema,
  usage_kind: UsageKindSchema,
  notification_kind: NotificationKindSchema,
  actor_kind: ActorKindSchema,
  revision_status: RevisionStatusSchema,
  author_kind: AuthorKindSchema,
} as const;

describe("domain enums (design.md §4.2, §5, §9.5, spec §15)", () => {
  const enumNames = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];

  it("covers exactly the 18 enum names", () => {
    expect(enumNames).toHaveLength(18);
    expect(Object.keys(SCHEMAS).sort()).toEqual([...enumNames].sort());
  });

  for (const name of enumNames) {
    it(`${name} matches its exact ordered value list`, () => {
      expect(SCHEMAS[name].options).toEqual(EXPECTED[name]);
    });
  }
});
