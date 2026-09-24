import { boolean, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import {
  authorKindEnum,
  issueStatusEnum,
  issueTypeEnum,
  resolutionKindEnum,
  severityEnum,
} from "./enums.js";
import { executions } from "./executions.js";
import { tasks } from "./tasks.js";
import { users } from "./users.js";

/** design.md §4.2 "issues" */
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    type: issueTypeEnum("type").notNull(),
    severity: severityEnum("severity").notNull(),
    blocking: boolean("blocking").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    question: text("question"),
    suggestedOptions: jsonb("suggested_options"),
    recommendedOption: text("recommended_option"),
    status: issueStatusEnum("status").notNull(),
    resolutionKind: resolutionKindEnum("resolution_kind"),
    resolution: text("resolution"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    resolvedAt: timestamptz("resolved_at"),
  },
  (table) => [
    index("issues_status_created_at_idx").on(table.status, table.createdAt),
  ],
);

/** design.md §4.2 "issue_messages" */
export const issueMessages = pgTable("issue_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id")
    .notNull()
    .references(() => issues.id),
  authorKind: authorKindEnum("author_kind").notNull(),
  userId: uuid("user_id").references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** design.md §4.2 "task_decisions" */
export const taskDecisions = pgTable("task_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  issueId: uuid("issue_id")
    .notNull()
    .unique()
    .references(() => issues.id),
  decision: text("decision").notNull(),
  clarification: text("clarification"),
  chosenOption: text("chosen_option"),
  decidedBy: uuid("decided_by")
    .notNull()
    .references(() => users.id),
  decidedAt: timestamptz("decided_at").notNull().defaultNow(),
});
