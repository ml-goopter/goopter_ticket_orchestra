import { pgEnum } from "drizzle-orm/pg-core";
import { ENUMS } from "@orchestra/core";

/**
 * Postgres enums, one per entry in `@orchestra/core`'s `ENUMS` registry
 * (design.md §4.2). Values are never redeclared here; they are read
 * straight from `core` so storage cannot drift from validation.
 */
export const taskStateEnum = pgEnum("task_state", ENUMS.task_state);
export const executionStateEnum = pgEnum(
  "execution_state",
  ENUMS.execution_state,
);
export const executionRoleEnum = pgEnum(
  "execution_role",
  ENUMS.execution_role,
);
export const runtimeEnum = pgEnum("runtime", ENUMS.runtime);
export const endReasonEnum = pgEnum("end_reason", ENUMS.end_reason);
export const issueTypeEnum = pgEnum("issue_type", ENUMS.issue_type);
export const severityEnum = pgEnum("severity", ENUMS.severity);
export const issueStatusEnum = pgEnum("issue_status", ENUMS.issue_status);
export const resolutionKindEnum = pgEnum(
  "resolution_kind",
  ENUMS.resolution_kind,
);
export const commandTypeEnum = pgEnum("command_type", ENUMS.command_type);
export const prStateEnum = pgEnum("pr_state", ENUMS.pr_state);
export const ciStateEnum = pgEnum("ci_state", ENUMS.ci_state);
export const reviewVerdictEnum = pgEnum(
  "review_verdict",
  ENUMS.review_verdict,
);
export const usageKindEnum = pgEnum("usage_kind", ENUMS.usage_kind);
export const notificationKindEnum = pgEnum(
  "notification_kind",
  ENUMS.notification_kind,
);
export const actorKindEnum = pgEnum("actor_kind", ENUMS.actor_kind);
export const authorKindEnum = pgEnum("author_kind", ENUMS.author_kind);
export const revisionStatusEnum = pgEnum(
  "revision_status",
  ENUMS.revision_status,
);
