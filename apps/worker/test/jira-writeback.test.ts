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
import { MAX_EVENT_ATTEMPTS, runJiraWriteback } from "../src/jira/writeback.js";
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

describe("runJiraWriteback: malformed payload does not stall the loop (regression, F1 part 1, C14)", () => {
  it("a non-uuid revision_id fails validation and is skipped on the first pass; a later valid event in the same batch still posts in the same run", async () => {
    const project = await insertProject();
    const approver = await insertUser("Dave");

    const taskA = await insertTask(project.id, { state: "SPEC_REVIEW" });
    const eventA = await insertEvent(taskA.id, "spec.approved", {
      revision_id: "not-a-uuid",
      version: 1,
      runtime: "claude",
      actor: { kind: "user", id: approver.id },
    });

    const taskB = await insertTask(project.id, { state: "SPEC_REVIEW" });
    const revisionB = await insertApprovedRevision(taskB.id, approver.id, 2);
    const eventB = await insertEvent(taskB.id, "spec.approved", {
      revision_id: revisionB.id,
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
      cursor: eventA.id - 1n,
    });

    // Validation catches the bad payload before any db or Jira call: the
    // event is skipped immediately, and B, later in the same batch, still
    // posts in this same run — no restart or second pass needed.
    expect(cursor).toBe(eventB.id);
    expect(client.addComment).toHaveBeenCalledTimes(1);
    expect(client.addComment).toHaveBeenCalledWith(
      taskB.jiraKey,
      `Specification v 2 approved by Dave. https://app.example/tasks/${taskB.id}\n[orchestra:spec_approved:${taskB.id}]`,
    );
  });
});

describe("runJiraWriteback: bounded retries for transient failures (regression, F1 part 2, C14)", () => {
  it("skips an event after MAX_EVENT_ATTEMPTS consecutive failures and still posts the following event, clearing the attempts entry", async () => {
    const project = await insertProject();

    const taskA = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execA = await insertExecution(taskA.id);
    await insertPullRequest(taskA.id, execA.id, "https://github.com/org/repo/pull/30");
    const eventA = await insertEvent(taskA.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const taskB = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execB = await insertExecution(taskB.id);
    await insertPullRequest(taskB.id, execB.id, "https://github.com/org/repo/pull/31");
    const eventB = await insertEvent(taskB.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    // Always fails posting to A's ticket; B posts normally.
    const addComment = vi.fn(async (key: string) => {
      if (key === taskA.jiraKey) throw new Error("ECONNRESET");
    });
    const client = fakeClient({ addComment });

    const attempts = new Map<string, number>();
    let cursor = eventA.id - 1n;

    for (let i = 0; i < MAX_EVENT_ATTEMPTS - 1; i += 1) {
      const result = await runJiraWriteback({ db, client, config: configWith(), logger, cursor, attempts });
      cursor = result.cursor;
    }

    // A has not been skipped yet: the cursor is still stuck before it, and
    // it has failed MAX_EVENT_ATTEMPTS - 1 times so far.
    expect(cursor).toBe(eventA.id - 1n);
    expect(attempts.get(String(eventA.id))).toBe(MAX_EVENT_ATTEMPTS - 1);
    expect(addComment).toHaveBeenCalledTimes(MAX_EVENT_ATTEMPTS - 1);

    // The MAX_EVENT_ATTEMPTS-th consecutive failure skips A in the same run
    // that it happens, and B — later in the batch — still posts.
    const last = await runJiraWriteback({ db, client, config: configWith(), logger, cursor, attempts });

    expect(last.cursor).toBe(eventB.id);
    expect(addComment).toHaveBeenCalledTimes(MAX_EVENT_ATTEMPTS + 1);
    expect(addComment).toHaveBeenLastCalledWith(taskB.jiraKey, expect.stringContaining(taskB.id));
    expect(attempts.has(String(eventA.id))).toBe(false);
  });

  it("a Jira call that fails twice then succeeds posts once and clears the attempts entry", async () => {
    const project = await insertProject();
    const task = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execution = await insertExecution(task.id);
    await insertPullRequest(task.id, execution.id, "https://github.com/org/repo/pull/40");
    const event = await insertEvent(task.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    let calls = 0;
    const addComment = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("ECONNRESET");
    });
    const client = fakeClient({ addComment });

    const attempts = new Map<string, number>();
    let cursor = event.id - 1n;

    for (let i = 0; i < 2; i += 1) {
      const result = await runJiraWriteback({ db, client, config: configWith(), logger, cursor, attempts });
      cursor = result.cursor;
    }

    expect(cursor).toBe(event.id - 1n);
    expect(attempts.get(String(event.id))).toBe(2);

    const result = await runJiraWriteback({ db, client, config: configWith(), logger, cursor, attempts });

    expect(result.cursor).toBe(event.id);
    expect(addComment).toHaveBeenCalledTimes(3);
    expect(attempts.has(String(event.id))).toBe(false);
  });
});

describe("runJiraWriteback: a bad ticket shape only retries its own event (regression, F2)", () => {
  it("keeps an earlier event's cursor progress when a later event's marker check throws", async () => {
    const project = await insertProject();

    const taskA = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execA = await insertExecution(taskA.id);
    await insertPullRequest(taskA.id, execA.id, "https://github.com/org/repo/pull/50");
    const eventA = await insertEvent(taskA.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const taskB = await insertTask(project.id, { state: "READY_FOR_MERGE" });
    const execB = await insertExecution(taskB.id);
    await insertPullRequest(taskB.id, execB.id, "https://github.com/org/repo/pull/51");
    const eventB = await insertEvent(taskB.id, "task.state_changed", {
      from: "CI_RUNNING",
      to: "READY_FOR_MERGE",
      trigger: "ci.passed",
      actor: { kind: "worker", id: null },
    });

    const client = fakeClient({
      getIssue: vi.fn(async (key: string) => {
        if (key === taskB.jiraKey) {
          return { key, summary: "s", description: "", comments: undefined as unknown as never };
        }
        return { key, summary: "s", description: "", comments: [] };
      }),
    });

    const { cursor } = await runJiraWriteback({
      db,
      client,
      config: configWith(),
      logger,
      cursor: eventA.id - 1n,
    });

    // B's marker check throws (comments is undefined); the run must not
    // reject, and A's cursor progress from earlier in the batch is kept.
    expect(cursor).toBe(eventA.id);
    expect(client.addComment).toHaveBeenCalledTimes(1);
    expect(client.addComment).toHaveBeenCalledWith(
      taskA.jiraKey,
      expect.stringContaining(`[orchestra:ready_for_merge:${taskA.id}]`),
    );
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
