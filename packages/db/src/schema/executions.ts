import {
  type AnyPgColumn,
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import {
  commandTypeEnum,
  endReasonEnum,
  executionRoleEnum,
  executionStateEnum,
  runtimeEnum,
  usageKindEnum,
} from "./enums.js";
import { specificationRevisions, tasks } from "./tasks.js";
import { users } from "./users.js";

/** design.md §4.2 "executions" */
export const executions = pgTable(
  "executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    role: executionRoleEnum("role").notNull(),
    attempt: integer("attempt").notNull(),
    state: executionStateEnum("state").notNull(),
    runtime: runtimeEnum("runtime").notNull(),
    model: text("model").notNull(),
    specRevisionId: uuid("spec_revision_id").references(
      () => specificationRevisions.id,
    ),
    workerId: uuid("worker_id").references(
      (): AnyPgColumn => agentWorkers.id,
    ),
    host: text("host"),
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    sessionId: text("session_id"),
    /**
     * SHA-256 (hex) of the agent-tools bearer token for this execution
     * (design.md §8: "The token is a random 32-byte value stored on the
     * execution row as a hash, issued at start or resume, and revoked when
     * the execution leaves `RUNNING`"). §4.2 lists no column for it; this
     * is that column. Null means no live token, which is what makes
     * revocation a single `set null`.
     */
    toolsTokenHash: text("tools_token_hash"),
    endReason: endReasonEnum("end_reason"),
    endDetail: text("end_detail"),
    reviewRounds: integer("review_rounds").notNull().default(0),
    ciRounds: integer("ci_rounds").notNull().default(0),
    infraRetriesUsed: integer("infra_retries_used").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    worktreeEvictedAt: timestamptz("worktree_evicted_at"),
    startedAt: timestamptz("started_at"),
    endedAt: timestamptz("ended_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("executions_task_id_created_at_idx").on(
      table.taskId,
      table.createdAt,
    ),
    index("executions_state_host_idx").on(table.state, table.host),
    // Every agent-tools call resolves its bearer by this hash (§8). Unique
    // so one token can never resolve to two executions; partial because a
    // revoked or never-issued token is null on many rows.
    uniqueIndex("executions_tools_token_hash_key")
      .on(table.toolsTokenHash)
      .where(sql`${table.toolsTokenHash} is not null`),
  ],
);

/** design.md §4.2 "execution_usage" */
export const executionUsage = pgTable("execution_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  executionId: uuid("execution_id")
    .notNull()
    .references(() => executions.id),
  kind: usageKindEnum("kind").notNull(),
  round: integer("round"),
  runtime: runtimeEnum("runtime").notNull(),
  model: text("model").notNull(),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
  cachedInputTokens: bigint("cached_input_tokens", {
    mode: "number",
  }).notNull(),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
  /**
   * Nullable (design.md §9.7): a model missing from `config/pricing.json`
   * records its tokens with `cost_usd = NULL` rather than failing the
   * execution.
   */
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  recordedAt: timestamptz("recorded_at").notNull().defaultNow(),
});

/** design.md §4.2 "task_leases" */
export const taskLeases = pgTable("task_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .unique()
    .references(() => tasks.id),
  executionId: uuid("execution_id")
    .notNull()
    .references(() => executions.id),
  workerId: uuid("worker_id")
    .notNull()
    .references((): AnyPgColumn => agentWorkers.id),
  acquiredAt: timestamptz("acquired_at").notNull().defaultNow(),
  expiresAt: timestamptz("expires_at").notNull(),
});

/** design.md §4.2 "agent_workers" */
export const agentWorkers = pgTable("agent_workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  host: text("host").notNull().unique(),
  capabilities: text("capabilities").array().notNull(),
  maxConcurrent: integer("max_concurrent").notNull(),
  workspaceRoot: text("workspace_root").notNull(),
  lastHeartbeatAt: timestamptz("last_heartbeat_at").notNull().defaultNow(),
  startedAt: timestamptz("started_at").notNull().defaultNow(),
});

/** design.md §4.2 "execution_commands" */
export const executionCommands = pgTable(
  "execution_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    executionId: uuid("execution_id").references(() => executions.id),
    type: commandTypeEnum("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    claimedAt: timestamptz("claimed_at"),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    index("execution_commands_unclaimed_idx")
      .on(table.claimedAt)
      .where(sql`${table.claimedAt} is null`),
  ],
);
