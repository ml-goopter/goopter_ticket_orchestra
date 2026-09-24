import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { citext, timestamptz } from "./columns.js";

/** design.md §4.2 "users" */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  disabledAt: timestamptz("disabled_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** design.md §4.2 "sessions" */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamptz("expires_at").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
});
