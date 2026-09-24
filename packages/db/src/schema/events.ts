import { bigserial, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import { actorKindEnum } from "./enums.js";
import { executions } from "./executions.js";
import { tasks } from "./tasks.js";

/** design.md §4.2 "execution_events". Append-only. */
export const executionEvents = pgTable(
  "execution_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    executionId: uuid("execution_id").references(() => executions.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("execution_events_task_id_id_idx").on(table.taskId, table.id),
  ],
);

/** design.md §4.2 "audit_events" */
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  trigger: text("trigger").notNull(),
  actorKind: actorKindEnum("actor_kind").notNull(),
  actorId: text("actor_id"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});
