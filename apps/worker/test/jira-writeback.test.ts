import {
  executionEvents,
  executions,
  projects,
  pullRequests,
  specificationApprovals,
  specificationRevisions,
  tasks,
  users,
  type Db,
} from "@orchestra/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import type { JiraClient } from "../src/jira/client.js";
import { JiraApiError } from "../src/jira/client.js";
import { runJiraWriteback } from "../src/jira/writeback.js";
import type { Logger } from "../src/logger.js";
import { startTestDb, type TestDb } from "./harness.js";

let testDb: TestDb;
let db: Db;
let counter = 0;

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.stop();
});

function configWith(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: "postgres://unused",
    host: "test-host",
    capabilities: [],
    maxConcurrent: 2,
    workspaceRoot: "/tmp/orchestra",
    toolsPort: 4317,
    diskHighWaterPct: 85,
    agentQuietTimeoutMs: 1_200_000,
    pricingFile: "config/pricing.json",
    logLevel: "info",
    jiraBaseUrl: "https://goopter.atlassian.net",
    jiraEmail: "bot@goopter.dev",
    jiraApiToken: "token",
    publicUrl: "https://app.example",
    ...overrides,
  };
}

function fakeClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    search: vi.fn(async () => []),
    issueExists: vi.fn(async () => true),
    getIssue: vi.fn(async (key: string) => ({
      key,
      summary: "s",
      description: "",
      comments: [],
    })),
    addComment: vi.fn(async () => {}),
    ...overrides,
  };
}

async function insertProject() {
  counter += 1;
  const [row] = await db
    .insert(projects)
    .values({ key: `WB${counter}`, name: `wb project ${counter}`, jiraJql: "project = WB" })
    .returning();
  return row!;
}

async function insertUser(displayName: string) {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: `writeback-${counter}@example.com`,
      passwordHash: "argon2id$stub",
      displayName,
    })
    .returning();
  return row!;
}

async function insertTask(projectId: string, overrides: Partial<typeof tasks.$inferInsert> = {}) {
  counter += 1;
  const [row] = await db
    .insert(tasks)
    .values({
      projectId,
      jiraKey: `GOOP-${counter}`,
      jiraSummary: "summary",
      jiraPriority: 3,
      jiraCreatedAt: new Date("2026-01-01T00:00:00Z"),
      jiraSyncedAt: new Date("2026-01-01T00:00:00Z"),
      state: "SPEC_REVIEW",
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertExecution(taskId: string) {
  const [row] = await db
    .insert(executions)
    .values({
      taskId,
      role: "implementation",
      attempt: 1,
      state: "RUNNING",
      runtime: "claude",
      model: "claude-sonnet-5",
    })
    .returning();
  return row!;
}

async function insertPullRequest(taskId: string, executionId: string, url: string) {
  const [row] = await db
    .insert(pullRequests)
    .values({
      taskId,
      executionId,
      number: 1,
      url,
      headSha: "abc123",
      state: "open",
      ciState: "pending",
      lastPolledAt: new Date(),
    })
    .returning();
  return row!;
}

async function insertApprovedRevision(taskId: string, approverId: string, version = 2) {
  const [revision] = await db
    .insert(specificationRevisions)
    .values({
      taskId,
      version,
      status: "approved",
      content: {},
      createdBy: approverId,
    })
    .returning();
  await db.insert(specificationApprovals).values({
    revisionId: revision!.id,
    approvedBy: approverId,
    approvedAt: new Date(),
    runtime: "claude",
  });
  return revision!;
}

async function insertEvent(
  taskId: string,
  type: string,
  payload: unknown,
  executionId: string | null = null,
) {
  const [row] = await db
    .insert(executionEvents)
    .values({ taskId, executionId, type, payload })
    .returning();
  return row!;
}

describe("runJiraWriteback: each trigger posts once (design.md §11.1)", () => {
  it("spec approved: posts the version, approver name and link, with the marker", async () => {
    const project = await insertProject();
    const approver = await insertUser("Alice");
    const task = await insertTask(project.id, { state: "SPEC_REVIEW" });
    const revision = await insertApprovedRevision(task.id, approver.id, 2);
    const event = await insertEvent(task.id, "spec.approved", {
      revision_id: revision.id,
      version: 2,
      runtime: "claude",
      actor: { kind: "user", id: approver.id },
    });

    const client = fakeClient();
    const { cursor } = await runJiraWriteback({
      db,
      client,
      config: configWith(),
      logger,
      cursor: event.id - 1n,
    });

    expect(cursor).toBe(event.id);
    expect(client.addComment).toHaveBeenCalledTimes(1);
    expect(client.addComment).toHaveBeenCalledWith(
      task.jiraKey,
      `Specification v 2 approved by Alice. https://app.example/tasks/${task.id}\n[orchestra:spec_approved:${task.id}]`,
    );
  });

  it("pull request created: posts the PR url, no link", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { state: "REVIEWING" });
    const execution = await insertExecution(task.id);
    await insertPullRequest(task.id, execution.id, "https://github.com/org/repo/pull/7");
    const event = await insertEvent(
      task.id,
      "pull_request.created",
      { url: "https://github.com/org/repo/pull/7", number: 7, head_sha: "sha" },
      execution.id,
    );

    const client = fakeClient();
    const { cursor } = await runJiraWriteback({
      db,
      client,
      config: configWith(),
      logger,
      cursor: event.id - 1n,
    });

    expect(cursor).toBe(event.id);
    expect(client.addComment).toHaveBeenCalledWith(
      task.jiraKey,
      `Pull request opened: https://github.com/org/repo/pull/7\n[orchestra:pr_created:${task.id}]`,
    );
  });

  it("READY_FOR_MERGE: posts CI passed with the task's pull request url", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execution = await insertExecution(task.id);
    await insertPullRequest(task.id, execution.id, "https://github.com/org/repo/pull/9");
    const event = await insertEvent(task.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const client = fakeClient();
    const { cursor } = await runJiraWriteback({
      db,
      client,
      config: configWith(),
      logger,
      cursor: event.id - 1n,
    });

    expect(cursor).toBe(event.id);
    expect(client.addComment).toHaveBeenCalledWith(
      task.jiraKey,
      `CI passed. Ready for merge: https://github.com/org/repo/pull/9\n[orchestra:ready_for_merge:${task.id}]`,
    );
  });

  it("NEEDS_HUMAN: posts the stop reason and link", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, {
      state: "NEEDS_HUMAN",
      needsHumanReason: "Agent gave up: could not run tests",
    });
    const event = await insertEvent(task.id, "task.state_changed", {
      from: "IMPLEMENTING",
      to: "NEEDS_HUMAN",
      trigger: "task.escalated",
      actor: { kind: "worker", id: null },
    });

    const client = fakeClient();
    const { cursor } = await runJiraWriteback({
      db,
      client,
      config: configWith(),
      logger,
      cursor: event.id - 1n,
    });

    expect(cursor).toBe(event.id);
    expect(client.addComment).toHaveBeenCalledWith(
      task.jiraKey,
      `Automation stopped: Agent gave up: could not run tests. https://app.example/tasks/${task.id}\n[orchestra:needs_human:${task.id}]`,
    );
  });

  it("a task.state_changed event to any other state is not loaded at all", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { state: "IMPLEMENTING" });
    const event = await insertEvent(task.id, "task.state_changed", {
      from: "READY",
      to: "IMPLEMENTING",
      trigger: "task.claimed",
      actor: { kind: "worker", id: null },
    });

    const client = fakeClient();
    const { cursor } = await runJiraWriteback({
      db,
      client,
      config: configWith(),
      logger,
      cursor: event.id - 1n,
    });

    // Nothing to handle, but the cursor still has nothing after it, so it
    // stays put rather than jumping past a row that was never loaded.
    expect(cursor).toBe(event.id - 1n);
    expect(client.addComment).not.toHaveBeenCalled();
  });
});

describe("runJiraWriteback: spec approved approver lookup (design.md §11.1)", () => {
  it("falls back to the event's actor id when the revision has no approval row", async () => {
    const project = await insertProject();
    const actorUser = await insertUser("Carol");
    const task = await insertTask(project.id, { state: "SPEC_REVIEW" });
    // No `insertApprovedRevision`/approval row here: only the bare revision.
    const [revision] = await db
      .insert(specificationRevisions)
      .values({ taskId: task.id, version: 3, status: "approved", content: {}, createdBy: actorUser.id })
      .returning();
    const event = await insertEvent(task.id, "spec.approved", {
      revision_id: revision!.id,
      version: 3,
      runtime: "claude",
      actor: { kind: "user", id: actorUser.id },
    });

    const client = fakeClient();
    const { cursor } = await runJiraWriteback({
      db,
      client,
      config: configWith(),
      logger,
      cursor: event.id - 1n,
    });

    expect(cursor).toBe(event.id);
    expect(client.addComment).toHaveBeenCalledWith(
      task.jiraKey,
      `Specification v 3 approved by Carol. https://app.example/tasks/${task.id}\n[orchestra:spec_approved:${task.id}]`,
    );
  });
});

describe("runJiraWriteback: dedupe (design.md §11.1, C11-C12)", () => {
  it("a re-run over the same event posts nothing", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execution = await insertExecution(task.id);
    await insertPullRequest(task.id, execution.id, "https://github.com/org/repo/pull/11");
    const event = await insertEvent(task.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const client = fakeClient();
    const first = await runJiraWriteback({ db, client, config: configWith(), logger, cursor: event.id - 1n });
    expect(client.addComment).toHaveBeenCalledTimes(1);

    const second = await runJiraWriteback({ db, client, config: configWith(), logger, cursor: first.cursor });
    expect(second.cursor).toBe(first.cursor);
    expect(client.addComment).toHaveBeenCalledTimes(1);
  });

  it("an existing comment carrying the marker from a previous process posts nothing", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execution = await insertExecution(task.id);
    await insertPullRequest(task.id, execution.id, "https://github.com/org/repo/pull/12");
    const event = await insertEvent(task.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const client = fakeClient({
      getIssue: vi.fn(async (key: string) => ({
        key,
        summary: "s",
        description: "",
        comments: [
          { author: "bot", createdAt: "2026-01-01", body: `some earlier text\n[orchestra:ready_for_merge:${task.id}]` },
        ],
      })),
    });

    const { cursor } = await runJiraWriteback({ db, client, config: configWith(), logger, cursor: event.id - 1n });

    expect(cursor).toBe(event.id);
    expect(client.addComment).not.toHaveBeenCalled();
  });
});

describe("runJiraWriteback: failures (design.md §11.1, C11)", () => {
  it("a failing addComment leaves the cursor before the event so the next run retries it, and a later event is not skipped forever", async () => {
    const project = await insertProject();
    const taskA = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execA = await insertExecution(taskA.id);
    await insertPullRequest(taskA.id, execA.id, "https://github.com/org/repo/pull/20");
    const eventA = await insertEvent(taskA.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const taskB = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execB = await insertExecution(taskB.id);
    await insertPullRequest(taskB.id, execB.id, "https://github.com/org/repo/pull/21");
    const eventB = await insertEvent(taskB.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const failingClient = fakeClient({
      addComment: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    });

    const first = await runJiraWriteback({
      db,
      client: failingClient,
      config: configWith(),
      logger,
      cursor: eventA.id - 1n,
    });

    // Kept before A: B was never reached this run.
    expect(first.cursor).toBe(eventA.id - 1n);
    expect(failingClient.addComment).toHaveBeenCalledTimes(1);

    const workingClient = fakeClient();
    const second = await runJiraWriteback({
      db,
      client: workingClient,
      config: configWith(),
      logger,
      cursor: first.cursor,
    });

    expect(second.cursor).toBe(eventB.id);
    expect(workingClient.addComment).toHaveBeenCalledTimes(2);
    expect(workingClient.addComment).toHaveBeenNthCalledWith(
      1,
      taskA.jiraKey,
      expect.stringContaining("[orchestra:ready_for_merge:" + taskA.id + "]"),
    );
    expect(workingClient.addComment).toHaveBeenNthCalledWith(
      2,
      taskB.jiraKey,
      expect.stringContaining("[orchestra:ready_for_merge:" + taskB.id + "]"),
    );
  });

  it("a 404 on the ticket skips the event and advances past it", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execution = await insertExecution(task.id);
    await insertPullRequest(task.id, execution.id, "https://github.com/org/repo/pull/22");
    const event = await insertEvent(task.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const client = fakeClient({
      getIssue: vi.fn(async () => {
        throw new JiraApiError(404, "not found");
      }),
    });

    const { cursor } = await runJiraWriteback({ db, client, config: configWith(), logger, cursor: event.id - 1n });

    expect(cursor).toBe(event.id);
    expect(client.addComment).not.toHaveBeenCalled();
  });
});

describe("runJiraWriteback: PUBLIC_URL (design.md §11.1, §15.3)", () => {
  it("omits the link sentence when PUBLIC_URL is unset", async () => {
    const project = await insertProject();
    const approver = await insertUser("Bob");
    const task = await insertTask(project.id, { state: "SPEC_REVIEW" });
    const revision = await insertApprovedRevision(task.id, approver.id, 1);
    const event = await insertEvent(task.id, "spec.approved", {
      revision_id: revision.id,
      version: 1,
      runtime: "claude",
      actor: { kind: "user", id: approver.id },
    });

    const client = fakeClient();
    await runJiraWriteback({
      db,
      client,
      config: configWith({ publicUrl: undefined }),
      logger,
      cursor: event.id - 1n,
    });

    expect(client.addComment).toHaveBeenCalledWith(
      task.jiraKey,
      `Specification v 1 approved by Bob.\n[orchestra:spec_approved:${task.id}]`,
    );
  });
});
