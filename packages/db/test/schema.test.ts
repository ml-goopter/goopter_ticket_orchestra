import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENUMS } from "@orchestra/core";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import * as schema from "../src/schema/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "drizzle");

/**
 * design.md §4.2: the exact 21 tables and their expected columns. Used to
 * assert the migrated schema (AC1) rather than trusting drizzle's own
 * table objects, which would make the test tautological.
 */
const EXPECTED_TABLES: Record<string, string[]> = {
  projects: [
    "id",
    "key",
    "name",
    "jira_jql",
    "max_infra_retries",
    "max_protocol_retries",
    "max_ci_rounds",
    "max_review_rounds",
    "created_at",
  ],
  repositories: [
    "id",
    "project_id",
    "name",
    "git_url",
    "default_branch",
    "default_runtime",
    "default_model",
    "max_concurrent_worktrees",
    "required_capability",
    "setup_command",
    "created_at",
  ],
  tasks: [
    "id",
    "project_id",
    "repository_id",
    "jira_key",
    "jira_summary",
    "jira_priority",
    "jira_created_at",
    "jira_synced_at",
    "state",
    "runtime_override",
    "approved_revision_id",
    "needs_human_reason",
    "created_at",
    "updated_at",
  ],
  specification_revisions: [
    "id",
    "task_id",
    "version",
    "status",
    "content",
    "created_by",
    "created_at",
    "updated_at",
  ],
  specification_approvals: [
    "id",
    "revision_id",
    "approved_by",
    "approved_at",
    "runtime",
  ],
  task_dependencies: ["task_id", "depends_on_task_id"],
  executions: [
    "id",
    "task_id",
    "role",
    "attempt",
    "state",
    "runtime",
    "model",
    "spec_revision_id",
    "worker_id",
    "host",
    "worktree_path",
    "branch",
    "session_id",
    "end_reason",
    "end_detail",
    "review_rounds",
    "ci_rounds",
    "infra_retries_used",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "cost_usd",
    "worktree_evicted_at",
    "started_at",
    "ended_at",
    "created_at",
  ],
  execution_usage: [
    "id",
    "execution_id",
    "kind",
    "round",
    "runtime",
    "model",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "cost_usd",
    "recorded_at",
  ],
  task_leases: [
    "id",
    "task_id",
    "execution_id",
    "worker_id",
    "acquired_at",
    "expires_at",
  ],
  agent_workers: [
    "id",
    "host",
    "capabilities",
    "max_concurrent",
    "workspace_root",
    "last_heartbeat_at",
    "started_at",
  ],
  execution_commands: [
    "id",
    "task_id",
    "execution_id",
    "type",
    "payload",
    "created_by",
    "created_at",
    "claimed_at",
    "completed_at",
  ],
  issues: [
    "id",
    "task_id",
    "execution_id",
    "type",
    "severity",
    "blocking",
    "title",
    "description",
    "question",
    "suggested_options",
    "recommended_option",
    "status",
    "resolution_kind",
    "resolution",
    "resolved_by",
    "created_at",
    "resolved_at",
  ],
  issue_messages: [
    "id",
    "issue_id",
    "author_kind",
    "user_id",
    "body",
    "created_at",
  ],
  task_decisions: [
    "id",
    "task_id",
    "issue_id",
    "decision",
    "clarification",
    "chosen_option",
    "decided_by",
    "decided_at",
  ],
  pull_requests: [
    "id",
    "task_id",
    "execution_id",
    "number",
    "url",
    "head_sha",
    "state",
    "ci_state",
    "ci_detail",
    "last_polled_at",
    "created_at",
    "merged_at",
  ],
  review_results: [
    "id",
    "execution_id",
    "round",
    "verdict",
    "findings",
    "reviewer_runtime",
    "usage_id",
    "created_at",
  ],
  execution_events: [
    "id",
    "task_id",
    "execution_id",
    "type",
    "payload",
    "created_at",
  ],
  audit_events: [
    "id",
    "entity_type",
    "entity_id",
    "from_state",
    "to_state",
    "trigger",
    "actor_kind",
    "actor_id",
    "created_at",
  ],
  users: [
    "id",
    "email",
    "password_hash",
    "display_name",
    "disabled_at",
    "created_at",
  ],
  sessions: ["id", "user_id", "expires_at", "created_at", "last_seen_at"],
  notifications: [
    "id",
    "user_id",
    "task_id",
    "issue_id",
    "kind",
    "title",
    "read_at",
    "created_at",
  ],
};

let container: StartedPostgreSqlContainer;
let sql: Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17").start();
  await runMigrations(container.getConnectionUri(), migrationsFolder);
  sql = postgres(container.getConnectionUri());
  db = drizzle(sql, { schema });
}, 120000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

describe("migrated schema (design.md §4.2)", () => {
  it("has exactly the 21 tables from §4.2, no more, no less (AC1)", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    const actual = rows.map((r) => r.table_name).sort();
    const expected = Object.keys(EXPECTED_TABLES).sort();
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(21);
  });

  it("has the expected column set for every table (AC1)", async () => {
    for (const [table, expectedColumns] of Object.entries(EXPECTED_TABLES)) {
      const rows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = ${table}
      `;
      const actual = rows.map((r) => r.column_name).sort();
      expect(actual, `columns of "${table}"`).toEqual(
        [...expectedColumns].sort(),
      );
    }
  });

  it("every pg_enum's labels match the corresponding @orchestra/core tuple (AC2)", async () => {
    for (const [enumName, values] of Object.entries(ENUMS)) {
      const rows = await sql<{ enumlabel: string; enumsortorder: string }[]>`
        select e.enumlabel, e.enumsortorder
        from pg_type t
        join pg_enum e on e.enumtypid = t.oid
        where t.typname = ${enumName}
        order by e.enumsortorder
      `;
      const actual = rows.map((r) => r.enumlabel);
      expect(actual, `pg_enum labels for "${enumName}"`).toEqual([
        ...values,
      ]);
    }
  });
});

describe("one row per table, FKs satisfied (AC3, AC4)", () => {
  it("inserts a full dependency-ordered graph and every table has the expected row count", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: "reviewer@example.com",
        passwordHash: "argon2id$stub",
        displayName: "Reviewer",
      })
      .returning();

    const [project] = await db
      .insert(schema.projects)
      .values({
        key: "GOOP",
        name: "Goopter",
        jiraJql: "project = GOOP AND labels = agent-ready",
      })
      .returning();

    const [repository] = await db
      .insert(schema.repositories)
      .values({
        projectId: project!.id,
        name: "goopter_odoo_modules",
        gitUrl: "git@example.com:goopter/goopter_odoo_modules.git",
        defaultBranch: "main",
        defaultRuntime: "claude",
      })
      .returning();

    const [worker] = await db
      .insert(schema.agentWorkers)
      .values({
        host: "worker-1.local",
        capabilities: ["node", "odoo"],
        maxConcurrent: 2,
        workspaceRoot: "/srv/orchestra",
      })
      .returning();

    // `task2` exists only to give `task_dependencies` a distinct
    // `depends_on_task_id`: the schema forbids a task depending on itself
    // (design.md §4.2, tested below), so a valid dependency row needs two
    // real tasks. `tasks` therefore ends this test with 2 rows, not 1.
    const [task1, task2] = await db
      .insert(schema.tasks)
      .values([
        {
          projectId: project!.id,
          repositoryId: repository!.id,
          jiraKey: "GOOP-1",
          jiraSummary: "Do the thing",
          jiraPriority: 1,
          jiraCreatedAt: new Date(),
          jiraSyncedAt: new Date(),
          state: "READY",
        },
        {
          projectId: project!.id,
          jiraKey: "GOOP-2",
          jiraSummary: "Prerequisite thing",
          jiraPriority: 1,
          jiraCreatedAt: new Date(),
          jiraSyncedAt: new Date(),
          state: "DONE",
        },
      ])
      .returning();

    const [revision] = await db
      .insert(schema.specificationRevisions)
      .values({
        taskId: task1!.id,
        version: 1,
        status: "approved",
        content: { summary: "stub spec" },
        createdBy: user!.id,
      })
      .returning();

    await db
      .update(schema.tasks)
      .set({ approvedRevisionId: revision!.id })
      .where(eq(schema.tasks.id, task1!.id));

    await db.insert(schema.specificationApprovals).values({
      revisionId: revision!.id,
      approvedBy: user!.id,
      approvedAt: new Date(),
      runtime: "claude",
    });

    await db.insert(schema.taskDependencies).values({
      taskId: task1!.id,
      dependsOnTaskId: task2!.id,
    });

    const [execution] = await db
      .insert(schema.executions)
      .values({
        taskId: task1!.id,
        role: "implementation",
        attempt: 1,
        state: "RUNNING",
        runtime: "claude",
        model: "claude-sonnet-5",
        specRevisionId: revision!.id,
        workerId: worker!.id,
      })
      .returning();

    const [usage] = await db
      .insert(schema.executionUsage)
      .values({
        executionId: execution!.id,
        kind: "main",
        runtime: "claude",
        model: "claude-sonnet-5",
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 500,
        costUsd: "0.500000",
      })
      .returning();

    await db.insert(schema.taskLeases).values({
      taskId: task1!.id,
      executionId: execution!.id,
      workerId: worker!.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    await db.insert(schema.executionCommands).values({
      taskId: task1!.id,
      executionId: execution!.id,
      type: "send_message",
      payload: { text: "hello" },
      createdBy: user!.id,
    });

    const [issue] = await db
      .insert(schema.issues)
      .values({
        taskId: task1!.id,
        executionId: execution!.id,
        type: "QUESTION",
        severity: "info",
        blocking: false,
        title: "Which flag?",
        description: "Ambiguous requirement",
        status: "OPEN",
      })
      .returning();

    await db.insert(schema.issueMessages).values({
      issueId: issue!.id,
      authorKind: "agent",
      body: "Which flag should I use?",
    });

    await db.insert(schema.taskDecisions).values({
      taskId: task1!.id,
      issueId: issue!.id,
      decision: "Use --force",
      decidedBy: user!.id,
    });

    await db.insert(schema.pullRequests).values({
      taskId: task1!.id,
      executionId: execution!.id,
      number: 42,
      url: "https://github.com/goopter/goopter_odoo_modules/pull/42",
      headSha: "abc123",
      state: "open",
      ciState: "pending",
      lastPolledAt: new Date(),
    });

    await db.insert(schema.reviewResults).values({
      executionId: execution!.id,
      round: 1,
      verdict: "clean",
      findings: [],
      reviewerRuntime: "claude",
      usageId: usage!.id,
    });

    await db.insert(schema.executionEvents).values({
      taskId: task1!.id,
      executionId: execution!.id,
      type: "execution.started",
      payload: {},
    });

    await db.insert(schema.auditEvents).values({
      entityType: "task",
      entityId: task1!.id,
      toState: "READY",
      trigger: "task.claimed",
      actorKind: "system",
    });

    await db.insert(schema.sessions).values({
      userId: user!.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    await db.insert(schema.notifications).values({
      userId: user!.id,
      taskId: task1!.id,
      issueId: issue!.id,
      kind: "issue_raised",
      title: "New issue raised",
    });

    const counts: Record<string, number> = {};
    for (const table of Object.keys(EXPECTED_TABLES)) {
      const [row] = await sql<{ count: string }[]>`
        select count(*)::int as count from ${sql(table)}
      `;
      counts[table] = Number(row!.count);
    }

    const expectedCounts = Object.fromEntries(
      Object.keys(EXPECTED_TABLES).map((table) => [
        table,
        table === "tasks" ? 2 : 1,
      ]),
    );
    expect(counts).toEqual(expectedCounts);
  });
});

describe("partial unique indexes on specification_revisions (design.md §4.2)", () => {
  it("rejects a second `draft` revision for the same task, and a second `approved`, but allows `superseded` twice", async () => {
    const [project] = await db
      .insert(schema.projects)
      .values({
        key: "PART",
        name: "Partial index test project",
        jiraJql: "project = PART",
      })
      .returning();

    const [task] = await db
      .insert(schema.tasks)
      .values({
        projectId: project!.id,
        jiraKey: "PART-1",
        jiraSummary: "Partial index task",
        jiraPriority: 1,
        jiraCreatedAt: new Date(),
        jiraSyncedAt: new Date(),
        state: "NEEDS_SPEC",
      })
      .returning();

    await db.insert(schema.specificationRevisions).values({
      taskId: task!.id,
      version: 1,
      status: "draft",
      content: {},
    });

    await expect(
      db.insert(schema.specificationRevisions).values({
        taskId: task!.id,
        version: 2,
        status: "draft",
        content: {},
      }),
    ).rejects.toThrow();

    await db.insert(schema.specificationRevisions).values({
      taskId: task!.id,
      version: 3,
      status: "approved",
      content: {},
    });

    await expect(
      db.insert(schema.specificationRevisions).values({
        taskId: task!.id,
        version: 4,
        status: "approved",
        content: {},
      }),
    ).rejects.toThrow();

    // `superseded` has no partial unique index, so two rows are fine.
    await db.insert(schema.specificationRevisions).values({
      taskId: task!.id,
      version: 5,
      status: "superseded",
      content: {},
    });
    await db.insert(schema.specificationRevisions).values({
      taskId: task!.id,
      version: 6,
      status: "superseded",
      content: {},
    });

    const rows = await db
      .select()
      .from(schema.specificationRevisions)
      .where(eq(schema.specificationRevisions.taskId, task!.id));
    expect(rows).toHaveLength(4);
  });
});

describe("task_dependencies self-dependency check (design.md §4.2)", () => {
  it("rejects task_id = depends_on_task_id", async () => {
    const [project] = await db
      .insert(schema.projects)
      .values({
        key: "SELF",
        name: "Self-dependency test project",
        jiraJql: "project = SELF",
      })
      .returning();

    const [task] = await db
      .insert(schema.tasks)
      .values({
        projectId: project!.id,
        jiraKey: "SELF-1",
        jiraSummary: "Self-dependency task",
        jiraPriority: 1,
        jiraCreatedAt: new Date(),
        jiraSyncedAt: new Date(),
        state: "NEEDS_SPEC",
      })
      .returning();

    await expect(
      db.insert(schema.taskDependencies).values({
        taskId: task!.id,
        dependsOnTaskId: task!.id,
      }),
    ).rejects.toThrow();
  });
});
