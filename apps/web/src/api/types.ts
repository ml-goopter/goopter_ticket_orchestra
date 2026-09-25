import { z } from "zod";
import {
  DASHBOARD_COLUMNS,
  IssueStatusSchema,
  IssueTypeSchema,
  NotificationKindSchema,
  ResolutionKindSchema,
  RuntimeSchema,
  SeveritySchema,
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
