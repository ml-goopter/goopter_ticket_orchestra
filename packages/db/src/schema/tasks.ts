import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { revisionStatusEnum, runtimeEnum, taskStateEnum } from "./enums.js";
import { projects, repositories } from "./projects.js";
import { users } from "./users.js";

/**
 * design.md §4.2 "tasks" and "specification_revisions" defined together:
 * `tasks.approved_revision_id` references `specification_revisions.id` and
 * `specification_revisions.task_id` references `tasks.id`, a cycle. Both
 * references are lazy (`() => otherTable.column`) so the two `pgTable`
 * calls can point at each other regardless of declaration order.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    jiraKey: text("jira_key").notNull().unique(),
    jiraSummary: text("jira_summary").notNull(),
    jiraPriority: integer("jira_priority").notNull(),
    jiraCreatedAt: timestamptz("jira_created_at").notNull(),
    jiraSyncedAt: timestamptz("jira_synced_at").notNull(),
    state: taskStateEnum("state").notNull(),
    runtimeOverride: runtimeEnum("runtime_override"),
    approvedRevisionId: uuid("approved_revision_id").references(
      (): AnyPgColumn => specificationRevisions.id,
    ),
    needsHumanReason: text("needs_human_reason"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("tasks_state_idx").on(table.state),
    index("tasks_repository_id_state_idx").on(
      table.repositoryId,
      table.state,
    ),
  ],
);

/** design.md §4.2 "specification_revisions" */
export const specificationRevisions = pgTable(
  "specification_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    version: integer("version").notNull(),
    status: revisionStatusEnum("status").notNull(),
    content: jsonb("content").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("specification_revisions_task_id_version_key").on(
      table.taskId,
      table.version,
    ),
    // At most one `draft` revision per task.
    uniqueIndex("specification_revisions_one_draft_per_task")
      .on(table.taskId)
      .where(sql`${table.status} = 'draft'`),
    // At most one `approved` revision per task.
    uniqueIndex("specification_revisions_one_approved_per_task")
      .on(table.taskId)
      .where(sql`${table.status} = 'approved'`),
  ],
);

/** design.md §4.2 "specification_approvals" */
export const specificationApprovals = pgTable("specification_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  revisionId: uuid("revision_id")
    .notNull()
    .unique()
    .references(() => specificationRevisions.id),
  approvedBy: uuid("approved_by")
    .notNull()
    .references(() => users.id),
  approvedAt: timestamptz("approved_at").notNull(),
  runtime: runtimeEnum("runtime").notNull(),
});

/** design.md §4.2 "task_dependencies" */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
    check(
      "task_dependencies_no_self_dependency",
      sql`${table.taskId} <> ${table.dependsOnTaskId}`,
    ),
  ],
);
