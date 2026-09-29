import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client.js";
import { createAdminApi, DeleteBlockedError } from "./admin.js";

function projectJson(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "proj-1",
    key: "GOOP",
    name: "Goopter",
    jira_jql: "project = GOOP",
    max_infra_retries: 3,
    max_protocol_retries: 2,
    max_ci_rounds: 3,
    max_review_rounds: 3,
    max_budget_usd: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function repositoryJson(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "repo-1",
    project_id: "proj-1",
    name: "goopter_odoo_modules",
    git_url: "git@example.com:goopter/goopter_odoo_modules.git",
    default_branch: "main",
    default_runtime: "claude",
    default_model: null,
    max_concurrent_worktrees: 1,
    required_capability: null,
    setup_command: null,
    test_command: null,
    agent_container: false,
    agent_image: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function userJson(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "user-1",
    email: "newuser@example.com",
    display_name: "New User",
    disabled_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function workerJson(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "worker-1",
    host: "admin-test-host",
    capabilities: ["default"],
    max_concurrent: 3,
    workspace_root: "/srv/orchestra",
    last_heartbeat_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    heartbeat_age_seconds: 90,
    free_slots: 2,
    ...overrides,
  };
}

describe("createAdminApi", () => {
  describe("projects", () => {
    it("listProjects() hits GET /projects and maps rows to camelCase", async () => {
      const request = vi.fn().mockResolvedValue([projectJson()]);
      const api = createAdminApi(request);

      const rows = await api.listProjects();

      expect(request).toHaveBeenCalledWith("GET", "/projects");
      expect(rows).toEqual([
        {
          id: "proj-1",
          key: "GOOP",
          name: "Goopter",
          jiraJql: "project = GOOP",
          maxInfraRetries: 3,
          maxProtocolRetries: 2,
          maxCiRounds: 3,
          maxReviewRounds: 3,
          maxBudgetUsd: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
    });

    it("createProject() POSTs the exact snake_case body and maps the response", async () => {
      const request = vi.fn().mockResolvedValue(projectJson());
      const api = createAdminApi(request);

      const project = await api.createProject({
        key: "GOOP",
        name: "Goopter",
        jiraJql: "project = GOOP",
        maxInfraRetries: 3,
        maxProtocolRetries: 2,
        maxCiRounds: 3,
        maxReviewRounds: 3,
        maxBudgetUsd: null,
      });

      expect(request).toHaveBeenCalledWith("POST", "/projects", {
        body: {
          key: "GOOP",
          name: "Goopter",
          jira_jql: "project = GOOP",
          max_infra_retries: 3,
          max_protocol_retries: 2,
          max_ci_rounds: 3,
          max_review_rounds: 3,
          max_budget_usd: null,
        },
      });
      expect(project.key).toBe("GOOP");
    });

    it("patchProject() sends only the keys present on the patch", async () => {
      const request = vi.fn().mockResolvedValue(projectJson({ name: "Renamed" }));
      const api = createAdminApi(request);

      await api.patchProject("proj-1", { name: "Renamed" });

      expect(request).toHaveBeenCalledWith("PATCH", "/projects/proj-1", {
        body: { name: "Renamed" },
      });
    });

    it("patchProject() includes an explicit null max_budget_usd (clearing it) but omits untouched fields", async () => {
      const request = vi.fn().mockResolvedValue(projectJson());
      const api = createAdminApi(request);

      await api.patchProject("proj-1", { maxBudgetUsd: null });

      expect(request).toHaveBeenCalledWith("PATCH", "/projects/proj-1", {
        body: { max_budget_usd: null },
      });
    });

    it("surfaces an api error with its code", async () => {
      const request = vi.fn().mockRejectedValue(Object.assign(new Error("A project with key GOOP already exists."), { code: "CONFLICT", status: 409, name: "ApiError" }));
      const api = createAdminApi(request);

      await expect(
        api.createProject({
          key: "GOOP",
          name: "Goopter",
          jiraJql: "project = GOOP",
          maxInfraRetries: 3,
          maxProtocolRetries: 2,
          maxCiRounds: 3,
          maxReviewRounds: 3,
          maxBudgetUsd: null,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("throws when the response fails schema validation", async () => {
      const request = vi.fn().mockResolvedValue([{ nope: true }]);
      const api = createAdminApi(request);

      await expect(api.listProjects()).rejects.toThrow();
    });

    it("deleteProject() DELETEs /projects/:id and resolves on success", async () => {
      const request = vi.fn().mockResolvedValue(undefined);
      const api = createAdminApi(request);

      await api.deleteProject("proj-1");

      expect(request).toHaveBeenCalledWith("DELETE", "/projects/proj-1");
    });

    it("deleteProject() maps a 409 REFERENCED_BY_TASKS into a DeleteBlockedError with the task count", async () => {
      const request = vi.fn().mockRejectedValue(
        new ApiError(409, "REFERENCED_BY_TASKS", "Cannot delete: 3 task(s) reference this project or its repositories."),
      );
      const api = createAdminApi(request);

      const error = await api.deleteProject("proj-1").catch((err: unknown) => err);

      expect(error).toBeInstanceOf(DeleteBlockedError);
      expect((error as DeleteBlockedError).taskCount).toBe(3);
      expect((error as DeleteBlockedError).message).toBe(
        "Cannot delete: 3 task(s) reference this project or its repositories.",
      );
    });

    it("deleteProject() propagates a 404 as an ApiError, like other not-found handling", async () => {
      const request = vi.fn().mockRejectedValue(new ApiError(404, "NOT_FOUND", "project proj-404 not found"));
      const api = createAdminApi(request);

      const error = await api.deleteProject("proj-404").catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    });
  });

  describe("repositories", () => {
    it("listRepositories() omits the project query param when not supplied", async () => {
      const request = vi.fn().mockResolvedValue([]);
      const api = createAdminApi(request);

      await api.listRepositories();

      expect(request).toHaveBeenCalledWith("GET", "/repositories");
    });

    it("listRepositories(projectId) filters by project and maps rows", async () => {
      const request = vi.fn().mockResolvedValue([repositoryJson()]);
      const api = createAdminApi(request);

      const rows = await api.listRepositories("proj-1");

      expect(request).toHaveBeenCalledWith("GET", "/repositories?project=proj-1");
      expect(rows[0]).toEqual({
        id: "repo-1",
        projectId: "proj-1",
        name: "goopter_odoo_modules",
        gitUrl: "git@example.com:goopter/goopter_odoo_modules.git",
        defaultBranch: "main",
        defaultRuntime: "claude",
        defaultModel: null,
        maxConcurrentWorktrees: 1,
        requiredCapability: null,
        setupCommand: null,
        testCommand: null,
        agentContainer: false,
        agentImage: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("createRepository() POSTs the exact snake_case body with every field", async () => {
      const request = vi.fn().mockResolvedValue(repositoryJson());
      const api = createAdminApi(request);

      await api.createRepository({
        projectId: "proj-1",
        name: "goopter_odoo_modules",
        gitUrl: "git@example.com:goopter/goopter_odoo_modules.git",
        defaultBranch: "main",
        defaultRuntime: "claude",
        defaultModel: "sonnet",
        maxConcurrentWorktrees: 2,
        requiredCapability: "docker",
        setupCommand: "pnpm install",
        testCommand: "pnpm test",
        agentContainer: true,
        agentImage: "orchestra/agent:custom",
      });

      expect(request).toHaveBeenCalledWith("POST", "/repositories", {
        body: {
          project_id: "proj-1",
          name: "goopter_odoo_modules",
          git_url: "git@example.com:goopter/goopter_odoo_modules.git",
          default_branch: "main",
          default_runtime: "claude",
          default_model: "sonnet",
          max_concurrent_worktrees: 2,
          required_capability: "docker",
          setup_command: "pnpm install",
          test_command: "pnpm test",
          agent_container: true,
          agent_image: "orchestra/agent:custom",
        },
      });
    });

    it("patchRepository() sends only the keys present on the patch", async () => {
      const request = vi.fn().mockResolvedValue(repositoryJson({ test_command: "npm run test:unit" }));
      const api = createAdminApi(request);

      await api.patchRepository("repo-1", { testCommand: "npm run test:unit" });

      expect(request).toHaveBeenCalledWith("PATCH", "/repositories/repo-1", {
        body: { test_command: "npm run test:unit" },
      });
    });

    it("patchRepository() sends agent_container and agent_image when present", async () => {
      const request = vi.fn().mockResolvedValue(repositoryJson({ agent_container: true, agent_image: "orchestra/agent:custom" }));
      const api = createAdminApi(request);

      await api.patchRepository("repo-1", { agentContainer: true, agentImage: "orchestra/agent:custom" });

      expect(request).toHaveBeenCalledWith("PATCH", "/repositories/repo-1", {
        body: { agent_container: true, agent_image: "orchestra/agent:custom" },
      });
    });

    it("surfaces a 400 VALIDATION_ERROR (composed test_command) with its code", async () => {
      const request = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("test_command must not contain ( ) * & ; | ` $ < > or a newline"), { code: "VALIDATION_ERROR", status: 400, name: "ApiError" }));
      const api = createAdminApi(request);

      await expect(api.patchRepository("repo-1", { testCommand: "pnpm test && rm -rf /" })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });

    it("deleteRepository() DELETEs /repositories/:id and resolves on success", async () => {
      const request = vi.fn().mockResolvedValue(undefined);
      const api = createAdminApi(request);

      await api.deleteRepository("repo-1");

      expect(request).toHaveBeenCalledWith("DELETE", "/repositories/repo-1");
    });

    it("deleteRepository() maps a 409 REFERENCED_BY_TASKS into a DeleteBlockedError with the task count", async () => {
      const request = vi
        .fn()
        .mockRejectedValue(new ApiError(409, "REFERENCED_BY_TASKS", "Cannot delete: 1 task(s) reference this repository."));
      const api = createAdminApi(request);

      const error = await api.deleteRepository("repo-1").catch((err: unknown) => err);

      expect(error).toBeInstanceOf(DeleteBlockedError);
      expect((error as DeleteBlockedError).taskCount).toBe(1);
      expect((error as DeleteBlockedError).message).toBe("Cannot delete: 1 task(s) reference this repository.");
    });

    it("deleteRepository() propagates a 404 as an ApiError, like other not-found handling", async () => {
      const request = vi.fn().mockRejectedValue(new ApiError(404, "NOT_FOUND", "repository repo-404 not found"));
      const api = createAdminApi(request);

      const error = await api.deleteRepository("repo-404").catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    });
  });

  describe("users", () => {
    it("listUsers() hits GET /users and maps rows", async () => {
      const request = vi.fn().mockResolvedValue([userJson()]);
      const api = createAdminApi(request);

      const rows = await api.listUsers();

      expect(request).toHaveBeenCalledWith("GET", "/users");
      expect(rows[0]).toEqual({
        id: "user-1",
        email: "newuser@example.com",
        displayName: "New User",
        disabledAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("createUser() POSTs email/password/display_name", async () => {
      const request = vi.fn().mockResolvedValue(userJson());
      const api = createAdminApi(request);

      await api.createUser({ email: "newuser@example.com", password: "a very long password", displayName: "New User" });

      expect(request).toHaveBeenCalledWith("POST", "/users", {
        body: { email: "newuser@example.com", password: "a very long password", display_name: "New User" },
      });
    });

    it("patchUser() sends only display_name when disabled is omitted", async () => {
      const request = vi.fn().mockResolvedValue(userJson({ display_name: "Renamed" }));
      const api = createAdminApi(request);

      await api.patchUser("user-1", { displayName: "Renamed" });

      expect(request).toHaveBeenCalledWith("PATCH", "/users/user-1", {
        body: { display_name: "Renamed" },
      });
    });

    it("patchUser() sends disabled: true (GOT.61)", async () => {
      const request = vi.fn().mockResolvedValue(userJson({ disabled_at: "2026-01-01T00:00:00.000Z" }));
      const api = createAdminApi(request);

      const result = await api.patchUser("user-1", { disabled: true });

      expect(request).toHaveBeenCalledWith("PATCH", "/users/user-1", {
        body: { disabled: true },
      });
      expect(result.disabledAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("patchUser() sends disabled: false", async () => {
      const request = vi.fn().mockResolvedValue(userJson());
      const api = createAdminApi(request);

      await api.patchUser("user-1", { disabled: false });

      expect(request).toHaveBeenCalledWith("PATCH", "/users/user-1", {
        body: { disabled: false },
      });
    });

    it("surfaces a duplicate-email 409 with its code", async () => {
      const request = vi.fn().mockRejectedValue(Object.assign(new Error("dup"), { code: "CONFLICT", status: 409, name: "ApiError" }));
      const api = createAdminApi(request);

      await expect(
        api.createUser({ email: "dup@example.com", password: "a very long password", displayName: "Dup" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("getCurrentUser() hits GET /auth/me and maps the camelCase response (GOT.61)", async () => {
      const request = vi
        .fn()
        .mockResolvedValue({ id: "current-admin", email: "me@example.com", displayName: "Me" });
      const api = createAdminApi(request);

      const me = await api.getCurrentUser!();

      expect(request).toHaveBeenCalledWith("GET", "/auth/me");
      expect(me).toEqual({ id: "current-admin", email: "me@example.com", displayName: "Me" });
    });
  });

  describe("workers", () => {
    it("listWorkers() hits GET /workers and maps heartbeat age and free slots", async () => {
      const request = vi.fn().mockResolvedValue([workerJson()]);
      const api = createAdminApi(request);

      const rows = await api.listWorkers();

      expect(request).toHaveBeenCalledWith("GET", "/workers");
      expect(rows[0]).toEqual({
        id: "worker-1",
        host: "admin-test-host",
        capabilities: ["default"],
        maxConcurrent: 3,
        workspaceRoot: "/srv/orchestra",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        heartbeatAgeSeconds: 90,
        freeSlots: 2,
      });
    });
  });
});
