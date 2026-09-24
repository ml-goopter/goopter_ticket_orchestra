import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import { notificationKindEnum } from "./enums.js";
import { issues } from "./issues.js";
import { tasks } from "./tasks.js";
import { users } from "./users.js";

/** design.md §4.2 "notifications" */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  issueId: uuid("issue_id").references(() => issues.id),
  kind: notificationKindEnum("kind").notNull(),
  title: text("title").notNull(),
  readAt: timestamptz("read_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});
