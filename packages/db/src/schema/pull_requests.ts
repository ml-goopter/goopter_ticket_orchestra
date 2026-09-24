import { integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import { ciStateEnum, prStateEnum, reviewVerdictEnum, runtimeEnum } from "./enums.js";
import { executionUsage, executions } from "./executions.js";
import { tasks } from "./tasks.js";

/** design.md §4.2 "pull_requests" */
export const pullRequests = pgTable("pull_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .unique()
    .references(() => tasks.id),
  executionId: uuid("execution_id")
    .notNull()
    .references(() => executions.id),
  number: integer("number").notNull(),
  url: text("url").notNull(),
  headSha: text("head_sha").notNull(),
  state: prStateEnum("state").notNull(),
  ciState: ciStateEnum("ci_state").notNull(),
  ciDetail: jsonb("ci_detail"),
  lastPolledAt: timestamptz("last_polled_at").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  mergedAt: timestamptz("merged_at"),
});

/** design.md §4.2 "review_results" */
export const reviewResults = pgTable("review_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  executionId: uuid("execution_id")
    .notNull()
    .references(() => executions.id),
  round: integer("round").notNull(),
  verdict: reviewVerdictEnum("verdict").notNull(),
  findings: jsonb("findings").notNull(),
  reviewerRuntime: runtimeEnum("reviewer_runtime").notNull(),
  usageId: uuid("usage_id").references(() => executionUsage.id),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});
