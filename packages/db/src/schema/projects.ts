import { integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import { runtimeEnum } from "./enums.js";

/** design.md §4.2 "projects" */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  jiraJql: text("jira_jql").notNull(),
  maxInfraRetries: integer("max_infra_retries").notNull().default(3),
  maxProtocolRetries: integer("max_protocol_retries").notNull().default(2),
  maxCiRounds: integer("max_ci_rounds").notNull().default(3),
  maxReviewRounds: integer("max_review_rounds").notNull().default(3),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** design.md §4.2 "repositories" */
export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    gitUrl: text("git_url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    defaultRuntime: runtimeEnum("default_runtime").notNull(),
    defaultModel: text("default_model"),
    maxConcurrentWorktrees: integer("max_concurrent_worktrees")
      .notNull()
      .default(1),
    requiredCapability: text("required_capability"),
    setupCommand: text("setup_command"),
    /** One plain command the review role may run (design.md OI3, C15). */
    testCommand: text("test_command"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [unique().on(table.projectId, table.name)],
);
