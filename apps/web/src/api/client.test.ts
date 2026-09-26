import { describe, expect, it, vi } from "vitest";
import { makeTaskAggregate } from "../task/fixtures.js";
import { ApiError, createApiClient } from "./client.js";

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("createApiClient", () => {
  it("posts JSON to /auth/login with credentials included", async () => {
    const user = { id: "1", email: "a@b.com", displayName: "A" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, user));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.login("a@b.com", "secret");

    expect(result).toEqual(user);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.body).toBe(JSON.stringify({ email: "a@b.com", password: "secret" }));
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("turns a 401 response into an ApiError carrying the api's code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(401, {
        error: { code: "AUTH_REQUIRED", message: "Authentication required." },
      }),
    );
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    let caught: unknown;
    try {
      await client.me();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe("AUTH_REQUIRED");
    expect(apiError.message).toBe("Authentication required.");
  });

  it("throws when the response body fails schema validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { nope: true }));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    await expect(client.me()).rejects.toThrow();
  });

  const card = {
    id: "1",
    jiraKey: "ABC-1",
    jiraSummary: "Do the thing",
    state: "READY",
    column: "Ready",
    runtime: "claude",
    projectId: "p1",
    repositoryId: "r1",
    jiraPriority: 1,
    jiraCreatedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasWaitingExecution: false,
    cost: 1.5,
  };

  it("listTasks() hits GET /tasks with no query string by default and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, [card]));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.listTasks();

    expect(result).toEqual([card]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/tasks");
  });

  it("listTasks({ attention: true }) hits GET /tasks?attention=1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, [card]));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    await client.listTasks({ attention: true });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/tasks?attention=1");
  });

  it("throws when a task card fails schema validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, [{ nope: true }]));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    await expect(client.listTasks()).rejects.toThrow();
  });

  const issue = {
    id: "i1",
    taskId: "t1",
    executionId: "e1",
    type: "BLOCKER",
    severity: "blocking",
    blocking: true,
    title: "Need a decision",
    description: "...",
    question: null,
    suggestedOptions: null,
    recommendedOption: null,
    status: "OPEN",
    resolutionKind: null,
    resolution: null,
    resolvedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
  };

  it("listIssues({ status, blocking }) hits GET /issues?status=OPEN&blocking=1 and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, [issue]));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.listIssues({ status: "OPEN", blocking: true });

    expect(result).toEqual([issue]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/issues?status=OPEN&blocking=1");
  });

  it("listIssues() with no options hits GET /issues with no query string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, []));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    await client.listIssues();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/issues");
  });

  const notification = {
    id: "n1",
    userId: null,
    taskId: "t1",
    issueId: null,
    kind: "needs_human",
    title: "Task needs you",
    readAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("listNotifications() hits GET /notifications and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, [notification]));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.listNotifications();

    expect(result).toEqual([notification]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/notifications");
  });

  it("markNotificationRead(id) posts to /notifications/:id/read and validates the response", async () => {
    const read = { ...notification, readAt: "2026-01-02T00:00:00.000Z" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, read));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.markNotificationRead("n1");

    expect(result).toEqual(read);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notifications/n1/read");
    expect(init.method).toBe("POST");
  });

  it("getTask(id) hits GET /tasks/:id and validates the response", async () => {
    const aggregate = makeTaskAggregate();
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, aggregate));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.getTask("task-1");

    expect(result).toEqual(aggregate);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/tasks/task-1");
  });

  const timelinePage = {
    events: [
      {
        id: 1,
        taskId: "task-1",
        executionId: null,
        type: "agent.note",
        payload: { n: 1 },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    nextAfter: 1,
  };

  it("getTimeline(id, { after, limit }) hits GET /tasks/:id/timeline?after=&limit=", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, timelinePage));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.getTimeline("task-1", { after: 0, limit: 200 });

    expect(result).toEqual(timelinePage);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/tasks/task-1/timeline?after=0&limit=200");
  });

  it("getTimeline(id) with no options hits GET /tasks/:id/timeline with no query string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, timelinePage));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    await client.getTimeline("task-1");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/tasks/task-1/timeline");
  });

  it("cancelTask(id) posts to /tasks/:id/cancel and validates the response", async () => {
    const body = { from: "IMPLEMENTING", to: "CANCELLED" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.cancelTask("task-1");

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/cancel");
    expect(init.method).toBe("POST");
  });

  it("retryTask(id) posts to /tasks/:id/retry and validates the response", async () => {
    const body = { from: "NEEDS_HUMAN", to: "IMPLEMENTING" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.retryTask("task-1");

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/retry");
    expect(init.method).toBe("POST");
  });

  const adminRepository = {
    id: "r1",
    project_id: "p1",
    name: "tsk-repo",
    git_url: "git@example.com:goopter/tsk-repo.git",
    default_branch: "main",
    default_runtime: "claude",
    default_model: null,
    max_concurrent_worktrees: 1,
    required_capability: null,
    setup_command: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("listProjectRepositories(id) hits GET /repositories?project=:id and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, [adminRepository]));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.listProjectRepositories("p1");

    expect(result).toEqual([adminRepository]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/repositories?project=p1");
  });

  it("startSpecSession(id) posts to /tasks/:id/spec/session with no body and validates the response", async () => {
    const body = { from: "NEEDS_SPEC", to: "SPEC_IN_PROGRESS" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.startSpecSession("task-1");

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/spec/session");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("postSpecMessage(id, text) posts { text } to /tasks/:id/spec/messages and validates the response", async () => {
    const body = { commandId: "cmd-1", executionId: "exec-1" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.postSpecMessage("task-1", "hello");

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/spec/messages");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ text: "hello" }));
  });

  it("saveDraft(id, content) puts { content } to /tasks/:id/spec/draft and validates the response", async () => {
    const content = {
      repository: "tsk-repo",
      objective: "do it",
      scope: ["a"],
      out_of_scope: [],
      requirements: ["r1"],
      acceptance_criteria: ["ac1"],
      validation: ["v1"],
      constraints: [],
      dependencies: [],
    };
    const body = { id: "rev-1", version: 1, status: "draft", content };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.saveDraft("task-1", content);

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/spec/draft");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ content }));
  });

  it("requestReview(id) posts to /tasks/:id/spec/request-review and validates the response", async () => {
    const body = { from: "SPEC_IN_PROGRESS", to: "SPEC_REVIEW" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.requestReview("task-1");

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/spec/request-review");
    expect(init.method).toBe("POST");
  });

  it("sendBack(id) posts to /tasks/:id/spec/send-back and validates the response", async () => {
    const body = { from: "SPEC_REVIEW", to: "SPEC_IN_PROGRESS" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.sendBack("task-1");

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/spec/send-back");
    expect(init.method).toBe("POST");
  });

  it("approveSpec(id, runtime) posts { runtime } to /tasks/:id/spec/approve and validates the response", async () => {
    const body = { from: "SPEC_REVIEW", to: "READY", revisionId: "rev-1" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.approveSpec("task-1", "codex");

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/spec/approve");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ runtime: "codex" }));
  });

  it("approveSpec(id) with no runtime sends no body", async () => {
    const body = { from: "SPEC_REVIEW", to: "READY", revisionId: "rev-1" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    await client.approveSpec("task-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it("reviseSpec(id) posts to /tasks/:id/spec/revise and validates the response", async () => {
    const body = { from: "SPEC_APPROVED", to: "SPEC_IN_PROGRESS", revisionId: "rev-2" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, body));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.reviseSpec("task-1");

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1/spec/revise");
    expect(init.method).toBe("POST");
  });

  it("a 409 response turns into an ApiError carrying the code (e.g. spec/revise DRAFT_EXISTS)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(409, { error: { code: "DRAFT_EXISTS", message: "The task already has a draft revision." } }),
    );
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    let caught: unknown;
    try {
      await client.reviseSpec("task-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe("DRAFT_EXISTS");
  });
});
