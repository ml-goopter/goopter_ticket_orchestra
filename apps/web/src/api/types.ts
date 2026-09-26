import { z } from "zod";
import {
  CiStateSchema,
  DASHBOARD_COLUMNS,
  EndReasonSchema,
  ExecutionRoleSchema,
  ExecutionStateSchema,
  FindingSchema,
  IssueStatusSchema,
  IssueTypeSchema,
  NotificationKindSchema,
  PrStateSchema,
  ResolutionKindSchema,
  ReviewVerdictSchema,
  RevisionStatusSchema,
  RuntimeSchema,
  SeveritySchema,
  SpecContentSchema,
  TaskStateSchema,
} from "@orchestra/core";

/**
 * Board card shape (`toCard` in apps/api/src/routes/tasks.ts, design.md
 * §12.2 `GET /tasks`). `column` is one of `@orchestra/core`'s
 * `DASHBOARD_COLUMNS`, computed server-side by `deriveColumn`.
 */
export const TaskCardSchema = z.object({
  id: z.string(),
  jiraKey: z.string(),
  jiraSummary: z.string(),
  state: TaskStateSchema,
  column: z.enum(DASHBOARD_COLUMNS),
  runtime: RuntimeSchema.nullable(),
  projectId: z.string(),
  repositoryId: z.string().nullable(),
  jiraPriority: z.number(),
  jiraCreatedAt: z.string(),
  updatedAt: z.string(),
  hasWaitingExecution: z.boolean(),
  cost: z.number(),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;

/**
 * Issue row shape (`GET /issues`, apps/api/src/routes/issues.ts, which
 * returns `packages/db`'s `IssueRow` unchanged -- drizzle's camelCase
 * column names, design.md §4.2 "issues").
 */
export const IssueSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  executionId: z.string(),
  type: IssueTypeSchema,
  severity: SeveritySchema,
  blocking: z.boolean(),
  title: z.string(),
  description: z.string(),
  question: z.string().nullable(),
  suggestedOptions: z.unknown().nullable(),
  recommendedOption: z.string().nullable(),
  status: IssueStatusSchema,
  resolutionKind: ResolutionKindSchema.nullable(),
  resolution: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Issue = z.infer<typeof IssueSchema>;

/**
 * Notification row shape (`GET /notifications`,
 * `POST /notifications/:id/read`, apps/api/src/routes/notifications.ts,
 * design.md §4.2 "notifications").
 */
export const NotificationSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  taskId: z.string(),
  issueId: z.string().nullable(),
  kind: NotificationKindSchema,
  title: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * Task detail aggregate shape (`GET /tasks/:id`, design.md §12.2, §14 Task
 * detail row, packages/db's `TaskAggregate` widened by GOT.41). Every
 * sub-row is drizzle's camelCase column set, as stored.
 */
export const ProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  jiraJql: z.string(),
  maxInfraRetries: z.number(),
  maxProtocolRetries: z.number(),
  maxCiRounds: z.number(),
  maxReviewRounds: z.number(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  gitUrl: z.string(),
  defaultBranch: z.string(),
  defaultRuntime: RuntimeSchema,
  defaultModel: z.string().nullable(),
  maxConcurrentWorktrees: z.number(),
  requiredCapability: z.string().nullable(),
  setupCommand: z.string().nullable(),
  createdAt: z.string(),
});
export type Repository = z.infer<typeof RepositorySchema>;

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryId: z.string().nullable(),
  jiraKey: z.string(),
  jiraSummary: z.string(),
  jiraPriority: z.number(),
  jiraCreatedAt: z.string(),
  jiraSyncedAt: z.string(),
  state: TaskStateSchema,
  runtimeOverride: RuntimeSchema.nullable(),
  approvedRevisionId: z.string().nullable(),
  needsHumanReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const SpecificationRevisionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  version: z.number(),
  status: RevisionStatusSchema,
  content: SpecContentSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpecificationRevision = z.infer<typeof SpecificationRevisionSchema>;

export const SpecificationApprovalSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  approvedBy: z.string(),
  approvedAt: z.string(),
  runtime: RuntimeSchema,
});
export type SpecificationApproval = z.infer<typeof SpecificationApprovalSchema>;

export const ExecutionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  role: ExecutionRoleSchema,
  attempt: z.number(),
  state: ExecutionStateSchema,
  runtime: RuntimeSchema,
  model: z.string(),
  specRevisionId: z.string().nullable(),
  workerId: z.string().nullable(),
  host: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  sessionId: z.string().nullable(),
  toolsTokenHash: z.string().nullable(),
  endReason: EndReasonSchema.nullable(),
  endDetail: z.string().nullable(),
  reviewRounds: z.number(),
  ciRounds: z.number(),
  infraRetriesUsed: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  /** Stored `numeric`, so this arrives as a string (e.g. `"1.250000"`). */
  costUsd: z.string(),
  worktreeEvictedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Execution = z.infer<typeof ExecutionSchema>;

export const TaskDecisionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  issueId: z.string(),
  decision: z.string(),
  clarification: z.string().nullable(),
  chosenOption: z.string().nullable(),
  decidedBy: z.string(),
  decidedAt: z.string(),
});
export type TaskDecision = z.infer<typeof TaskDecisionSchema>;

export const ReviewResultSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  round: z.number(),
  verdict: ReviewVerdictSchema,
  findings: z.array(FindingSchema),
  reviewerRuntime: RuntimeSchema,
  usageId: z.string().nullable(),
  createdAt: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const PullRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  number: z.number(),
  url: z.string(),
  headSha: z.string(),
  state: PrStateSchema,
  ciState: CiStateSchema,
  ciDetail: z.unknown().nullable(),
  lastPolledAt: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const TaskDependencySchema = z.object({
  taskId: z.string(),
  jiraKey: z.string(),
  state: TaskStateSchema,
});
export type TaskDependency = z.infer<typeof TaskDependencySchema>;

export const TaskCostSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
});
export type TaskCost = z.infer<typeof TaskCostSchema>;

export const TaskAggregateSchema = z.object({
  task: TaskSchema,
  project: ProjectSchema,
  repository: RepositorySchema.nullable(),
  approvedRevision: SpecificationRevisionSchema.nullable(),
  latestExecutions: z.object({
    spec: ExecutionSchema.nullable(),
    implementation: ExecutionSchema.nullable(),
  }),
  openIssueCount: z.number(),
  pullRequest: PullRequestSchema.nullable(),
  revisions: z.array(SpecificationRevisionSchema),
  approvals: z.array(SpecificationApprovalSchema),
  executions: z.array(ExecutionSchema),
  issues: z.array(IssueSchema),
  decisions: z.array(TaskDecisionSchema),
  reviewResults: z.array(ReviewResultSchema),
  dependencies: z.array(TaskDependencySchema),
  cost: TaskCostSchema,
});
export type TaskAggregate = z.infer<typeof TaskAggregateSchema>;

/**
 * One page of `execution_events`, ascending by id (`GET
 * /tasks/:id/timeline`, design.md §12.2, §12.6).
 */
export const TimelineEventSchema = z.object({
  id: z.number(),
  taskId: z.string(),
  executionId: z.string().nullable(),
  type: z.string(),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const TimelinePageSchema = z.object({
  events: z.array(TimelineEventSchema),
  nextAfter: z.number(),
});
export type TimelinePage = z.infer<typeof TimelinePageSchema>;

/** `{ from, to }` returned by `POST /tasks/:id/cancel` and `.../retry`. */
export const TaskTransitionResultSchema = z.object({
  from: TaskStateSchema,
  to: TaskStateSchema,
});
export type TaskTransitionResult = z.infer<typeof TaskTransitionResultSchema>;

/**
 * `POST /tasks/:id/spec/messages` result (design.md §12.3,
 * apps/api/src/routes/spec.ts): the enqueued `send_message` command.
 */
export const SpecMessageResultSchema = z.object({
  commandId: z.string(),
  executionId: z.string(),
});
export type SpecMessageResult = z.infer<typeof SpecMessageResultSchema>;

/**
 * `PUT /tasks/:id/spec/draft` result (design.md §12.3): `packages/db`'s bare
 * `SpecRevisionRow`, not the full `SpecificationRevision` -- it has no
 * `taskId`/`createdBy`/timestamps.
 */
export const SpecDraftResultSchema = z.object({
  id: z.string(),
  version: z.number(),
  status: RevisionStatusSchema,
  content: SpecContentSchema,
});
export type SpecDraftResult = z.infer<typeof SpecDraftResultSchema>;

/**
 * `POST /tasks/:id/spec/approve` and `.../spec/revise` result (design.md
 * §12.3): the transition plus the revision id they acted on.
 */
export const SpecRevisionTransitionResultSchema = z.object({
  from: TaskStateSchema,
  to: TaskStateSchema,
  revisionId: z.string(),
});
export type SpecRevisionTransitionResult = z.infer<
  typeof SpecRevisionTransitionResultSchema
>;

/**
 * `GET /repositories?project=` row shape (`toResponse` in
 * apps/api/src/routes/repositories.ts, design.md §12.5) -- snake_case admin
 * shape, distinct from the aggregate's drizzle-cased `RepositorySchema|
 * above. Used by the spec builder's repository-exists check (design.md
 * §4.3 approval rule): the aggregate carries only the task's own assigned
 * repository (null before approval), never the project's full list.
 */
export const AdminRepositorySchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  default_runtime: RuntimeSchema,
  default_model: z.string().nullable(),
  max_concurrent_worktrees: z.number(),
  required_capability: z.string().nullable(),
  setup_command: z.string().nullable(),
  created_at: z.string(),
});
export type AdminRepository = z.infer<typeof AdminRepositorySchema>;
