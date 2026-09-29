import {
  agentWorkers,
  executions,
  projects,
  repositories,
  sessions,
  tasks,
  updateAdminUser,
  users,
  type Db,
} from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestApp,
  createClock,
  seedUser,
  startTestDb,
  waitForLockWaiters,
  type Clock,
  type TestDb,
} from "./harness.js";
import {
  seedAgentWorker,
  seedExecutionOnHost,
  seedProject,
  seedRepository,
  seedTask,
} from "./admin-seed.js";

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader)
    ? setCookieHeader[0]
    : setCookieHeader;
  if (!header) throw new Error("no Set-Cookie header on response");
  const [pair] = header.split(";");
  return pair!;
}

describe("admin routes", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  let clock: Clock;
  let cookie: string;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120000);

  afterAll(async () => {
    await testDb?.stop();
  }, 120000);

  afterEach(async () => {
    await app?.close();
    await testDb.db.delete(executions);
    await testDb.db.delete(tasks);
    await testDb.db.delete(repositories);
    await testDb.db.delete(projects);
    await testDb.db.delete(agentWorkers);
    await testDb.db.delete(sessions);
    await testDb.db.delete(users);
  });

  /** Builds the app, seeds one user, logs in, and returns the session cookie. */
  async function withAuthedApp(): Promise<FastifyInstance> {
    clock = createClock(new Date("2026-01-01T00:00:00Z"));
    app = await buildTestApp(testDb, clock);
    await seedUser(testDb.db, {
      email: "admin@example.com",
      password: "correct horse battery",
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery" },
    });
    cookie = extractCookie(loginRes.headers["set-cookie"]);
    return app;
  }

  describe("auth (AC5)", () => {
    it("rejects an unauthenticated GET /api/projects with 401", async () => {
      clock = createClock();
      app = await buildTestApp(testDb, clock);
      const res = await app.inject({ method: "GET", url: "/api/projects" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("projects (AC1)", () => {
    it("creates with defaults applied, gets, lists, and patches a subset", async () => {
      const app = await withAuthedApp();

      const createRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { key: "GOOP", name: "Goopter", jira_jql: "project = GOOP" },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      expect(created).toMatchObject({
        key: "GOOP",
        name: "Goopter",
        jira_jql: "project = GOOP",
        max_infra_retries: 3,
        max_protocol_retries: 2,
        max_ci_rounds: 3,
        max_review_rounds: 3,
      });

      const getRes = await app.inject({
        method: "GET",
        url: `/api/projects/${created.id}`,
        headers: { cookie },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(created.id);

      const listRes = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie },
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().map((p: { id: string }) => p.id)).toContain(
        created.id,
      );

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/projects/${created.id}`,
        headers: { cookie },
        payload: { name: "Goopter Renamed" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({
        id: created.id,
        key: "GOOP",
        name: "Goopter Renamed",
      });
    });

    it("rejects an invalid key pattern with 400", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { key: "goop", name: "Goopter", jira_jql: "project = GOOP" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an empty jira_jql with 400", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { key: "GOOP", name: "Goopter", jira_jql: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a negative retry count with 400", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: {
          key: "GOOP",
          name: "Goopter",
          jira_jql: "project = GOOP",
          max_infra_retries: -1,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a duplicate key with 409", async () => {
      const app = await withAuthedApp();
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { key: "GOOP", name: "Goopter", jira_jql: "project = GOOP" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { key: "GOOP", name: "Other", jira_jql: "project = GOOP2" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("returns 404 for an unknown project id", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/00000000-0000-0000-0000-000000000000",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("GOT.44 Q9: defaults max_budget_usd to null, stores and reads it, and patches it", async () => {
      const app = await withAuthedApp();

      const createRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { key: "BUDG", name: "Budgeted", jira_jql: "project = BUDG" },
      });
      expect(createRes.statusCode).toBe(201);
      expect(createRes.json().max_budget_usd).toBeNull();

      const withBudgetRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: {
          key: "BUDG2",
          name: "Budgeted 2",
          jira_jql: "project = BUDG2",
          max_budget_usd: 500.5,
        },
      });
      expect(withBudgetRes.statusCode).toBe(201);
      const created = withBudgetRes.json();
      expect(created.max_budget_usd).toBe(500.5);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/projects/${created.id}`,
        headers: { cookie },
      });
      expect(getRes.json().max_budget_usd).toBe(500.5);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/projects/${created.id}`,
        headers: { cookie },
        payload: { max_budget_usd: 750 },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().max_budget_usd).toBe(750);

      const clearRes = await app.inject({
        method: "PATCH",
        url: `/api/projects/${created.id}`,
        headers: { cookie },
        payload: { max_budget_usd: null },
      });
      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.json().max_budget_usd).toBeNull();
    });

    it("rejects a negative max_budget_usd with 400 on create and patch", async () => {
      const app = await withAuthedApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: {
          key: "BUDN",
          name: "Bad Budget",
          jira_jql: "project = BUDN",
          max_budget_usd: -1,
        },
      });
      expect(createRes.statusCode).toBe(400);

      const okRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { key: "BUDN2", name: "Ok Budget", jira_jql: "project = BUDN2" },
      });
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/projects/${okRes.json().id}`,
        headers: { cookie },
        payload: { max_budget_usd: -5 },
      });
      expect(patchRes.statusCode).toBe(400);
    });
  });

  describe("DELETE /api/projects/:id (GOT.52)", () => {
    it("deletes a project and all its repositories when no task references it", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "DELP1" });
      const repo = await seedRepository(testDb.db, {
        projectId: project.id,
        name: "delp1-repo",
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${project.id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");

      const getProjectRes = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
        headers: { cookie },
      });
      expect(getProjectRes.statusCode).toBe(404);

      const getRepoRes = await app.inject({
        method: "GET",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
      });
      expect(getRepoRes.statusCode).toBe(404);
    });

    it("returns 409 with the reason and task count, deleting nothing, when a task references the project", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "DELP2" });
      await seedTask(testDb.db, { projectId: project.id, jiraKey: "DELP2-1" });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${project.id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe("REFERENCED_BY_TASKS");
      expect(body.error.task_count).toBe(1);
      expect(typeof body.error.message).toBe("string");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
        headers: { cookie },
      });
      expect(getRes.statusCode).toBe(200);
    });

    it("returns 409 with the task count when a task only references one of the project's repositories", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "DELP3" });
      const repo = await seedRepository(testDb.db, {
        projectId: project.id,
        name: "delp3-repo",
      });
      await seedTask(testDb.db, {
        projectId: project.id,
        repositoryId: repo.id,
        jiraKey: "DELP3-1",
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${project.id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.task_count).toBe(1);

      const getRepoRes = await app.inject({
        method: "GET",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
      });
      expect(getRepoRes.statusCode).toBe(200);
    });

    it("returns 404 for an unknown project id", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/projects/00000000-0000-0000-0000-000000000000",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects a malformed project id with 400", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/projects/not-a-uuid",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an unauthenticated request with 401", async () => {
      clock = createClock();
      app = await buildTestApp(testDb, clock);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/projects/00000000-0000-0000-0000-000000000000",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("repositories (AC2)", () => {
    async function createProject(app: FastifyInstance, key: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { key, name: `${key} project`, jira_jql: `project = ${key}` },
      });
      return res.json() as { id: string };
    }

    it("creates, lists filtered by project, and patches", async () => {
      const app = await withAuthedApp();
      const project = await createProject(app, "REPO1");

      const createRes = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: {
          project_id: project.id,
          name: "goopter_odoo_modules",
          git_url: "git@example.com:goopter/goopter_odoo_modules.git",
          default_branch: "main",
          default_runtime: "claude",
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      expect(created).toMatchObject({
        project_id: project.id,
        name: "goopter_odoo_modules",
        max_concurrent_worktrees: 1,
      });

      const otherProject = await createProject(app, "REPO2");
      await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: {
          project_id: otherProject.id,
          name: "other-repo",
          git_url: "git@example.com:goopter/other-repo.git",
          default_branch: "main",
          default_runtime: "codex",
        },
      });

      const listRes = await app.inject({
        method: "GET",
        url: `/api/repositories?project=${project.id}`,
        headers: { cookie },
      });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json() as Array<{ id: string; project_id: string }>;
      expect(list.map((r) => r.id)).toEqual([created.id]);
      expect(list.every((r) => r.project_id === project.id)).toBe(true);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/repositories/${created.id}`,
        headers: { cookie },
        payload: { default_branch: "develop" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().default_branch).toBe("develop");
    });

    it("GOT.39 C15: stores test_command on create, returns it on read, and patches it", async () => {
      const app = await withAuthedApp();
      const project = await createProject(app, "REPOTC");

      const createRes = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: {
          project_id: project.id,
          name: "tc-repo",
          git_url: "git@example.com:goopter/tc-repo.git",
          default_branch: "main",
          default_runtime: "claude",
          test_command: "pnpm test",
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      expect(created.test_command).toBe("pnpm test");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/repositories/${created.id}`,
        headers: { cookie },
      });
      expect(getRes.json().test_command).toBe("pnpm test");

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/repositories/${created.id}`,
        headers: { cookie },
        payload: { test_command: "npm run test:unit" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().test_command).toBe("npm run test:unit");

      const clearRes = await app.inject({
        method: "PATCH",
        url: `/api/repositories/${created.id}`,
        headers: { cookie },
        payload: { test_command: null },
      });
      expect(clearRes.json().test_command).toBeNull();

      const defaultRes = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: {
          project_id: project.id,
          name: "tc-default-repo",
          git_url: "git@example.com:goopter/tc-default-repo.git",
          default_branch: "main",
          default_runtime: "claude",
        },
      });
      expect(defaultRes.json().test_command).toBeNull();
    });

    describe("C6: agent_container / agent_image (D20)", () => {
      it("defaults agent_container to false and agent_image to null when omitted", async () => {
        const app = await withAuthedApp();
        const project = await createProject(app, "REPOAC1");

        const createRes = await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {
            project_id: project.id,
            name: "no-container-repo",
            git_url: "git@example.com:goopter/no-container-repo.git",
            default_branch: "main",
            default_runtime: "claude",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const created = createRes.json();
        expect(created.agent_container).toBe(false);
        expect(created.agent_image).toBeNull();
      });

      it("stores agent_container and agent_image on create, returns them on read, and patches them", async () => {
        const app = await withAuthedApp();
        const project = await createProject(app, "REPOAC2");

        const createRes = await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {
            project_id: project.id,
            name: "container-repo",
            git_url: "git@example.com:goopter/container-repo.git",
            default_branch: "main",
            default_runtime: "claude",
            agent_container: true,
            agent_image: "orchestra/agent:custom",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const created = createRes.json();
        expect(created.agent_container).toBe(true);
        expect(created.agent_image).toBe("orchestra/agent:custom");

        const getRes = await app.inject({
          method: "GET",
          url: `/api/repositories/${created.id}`,
          headers: { cookie },
        });
        expect(getRes.json().agent_container).toBe(true);
        expect(getRes.json().agent_image).toBe("orchestra/agent:custom");

        const patchRes = await app.inject({
          method: "PATCH",
          url: `/api/repositories/${created.id}`,
          headers: { cookie },
          payload: { agent_container: false, agent_image: null },
        });
        expect(patchRes.statusCode).toBe(200);
        expect(patchRes.json().agent_container).toBe(false);
        expect(patchRes.json().agent_image).toBeNull();
      });

      it("accepts an empty-string agent_image the same way setup_command is accepted", async () => {
        const app = await withAuthedApp();
        const project = await createProject(app, "REPOAC3");

        const createRes = await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {
            project_id: project.id,
            name: "empty-image-repo",
            git_url: "git@example.com:goopter/empty-image-repo.git",
            default_branch: "main",
            default_runtime: "claude",
            setup_command: "",
            agent_image: "",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const created = createRes.json();
        expect(created.setup_command).toBe("");
        expect(created.agent_image).toBe("");
      });

      it("rejects a non-boolean agent_container with 400 VALIDATION_ERROR", async () => {
        const app = await withAuthedApp();
        const project = await createProject(app, "REPOAC4");

        const res = await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {
            project_id: project.id,
            name: "bad-container-repo",
            git_url: "git@example.com:goopter/bad-container-repo.git",
            default_branch: "main",
            default_runtime: "claude",
            agent_container: "yes",
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("VALIDATION_ERROR");
      });

      it("rejects a non-string agent_image with 400 VALIDATION_ERROR", async () => {
        const app = await withAuthedApp();
        const project = await createProject(app, "REPOAC5");

        const res = await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {
            project_id: project.id,
            name: "bad-image-repo",
            git_url: "git@example.com:goopter/bad-image-repo.git",
            default_branch: "main",
            default_runtime: "claude",
            agent_image: 123,
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("VALIDATION_ERROR");
      });

      it("patch rejects a non-boolean agent_container with 400 and keeps the old value", async () => {
        const app = await withAuthedApp();
        const project = await createProject(app, "REPOAC6");
        const createRes = await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {
            project_id: project.id,
            name: "patch-bad-container-repo",
            git_url: "git@example.com:goopter/patch-bad-container-repo.git",
            default_branch: "main",
            default_runtime: "claude",
            agent_container: true,
          },
        });
        const created = createRes.json();

        const patchRes = await app.inject({
          method: "PATCH",
          url: `/api/repositories/${created.id}`,
          headers: { cookie },
          payload: { agent_container: "nope" },
        });
        expect(patchRes.statusCode).toBe(400);
        expect(patchRes.json().error.code).toBe("VALIDATION_ERROR");

        const getRes = await app.inject({
          method: "GET",
          url: `/api/repositories/${created.id}`,
          headers: { cookie },
        });
        expect(getRes.json().agent_container).toBe(true);
      });
    });

    describe("GOT.39 F1: test_command must pass the review role's validateTestCommand", () => {
      const BAD_TEST_COMMANDS: Array<[string, string]> = [
        ["empty", ""],
        ["whitespace", "   "],
        ["&&", "pnpm test && rm -rf /"],
        [";", "pnpm test; echo x"],
        ["|", "pnpm test | tee out"],
        ["$", "pnpm test $HOME"],
        ["backtick", "pnpm test `id`"],
        ["redirect", "pnpm test > out"],
        ["paren", "pnpm test) Bash(rm -rf"],
        ["star", "pnpm *"],
        ["newline", "pnpm test\nBash(rm)"],
        [":* suffix", "pnpm test:*"],
      ];

      async function createTcRepo(app: FastifyInstance, key: string) {
        const project = await createProject(app, key);
        const res = await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {
            project_id: project.id,
            name: `${key.toLowerCase()}-repo`,
            git_url: `git@example.com:goopter/${key.toLowerCase()}-repo.git`,
            default_branch: "main",
            default_runtime: "claude",
            test_command: "pnpm test",
          },
        });
        expect(res.statusCode).toBe(201);
        return { project, repo: res.json() as { id: string } };
      }

      it.each(BAD_TEST_COMMANDS)(
        "create rejects a %s test_command with 400 VALIDATION_ERROR",
        async (_label, testCommand) => {
          const app = await withAuthedApp();
          const project = await createProject(app, "TCBADC");
          const res = await app.inject({
            method: "POST",
            url: "/api/repositories",
            headers: { cookie },
            payload: {
              project_id: project.id,
              name: "bad-tc-repo",
              git_url: "git@example.com:goopter/bad-tc-repo.git",
              default_branch: "main",
              default_runtime: "claude",
              test_command: testCommand,
            },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().error.code).toBe("VALIDATION_ERROR");
          const list = await app.inject({
            method: "GET",
            url: `/api/repositories?project=${project.id}`,
            headers: { cookie },
          });
          expect(list.json()).toEqual([]);
        },
      );

      it.each(BAD_TEST_COMMANDS)(
        "patch rejects a %s test_command with 400 VALIDATION_ERROR and keeps the old value",
        async (_label, testCommand) => {
          const app = await withAuthedApp();
          const { repo } = await createTcRepo(app, "TCBADP");
          const res = await app.inject({
            method: "PATCH",
            url: `/api/repositories/${repo.id}`,
            headers: { cookie },
            payload: { test_command: testCommand },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().error.code).toBe("VALIDATION_ERROR");
          const getRes = await app.inject({
            method: "GET",
            url: `/api/repositories/${repo.id}`,
            headers: { cookie },
          });
          expect(getRes.json().test_command).toBe("pnpm test");
        },
      );

      it("trims a plain command on create and on patch, and null still clears it", async () => {
        const app = await withAuthedApp();
        const project = await createProject(app, "TCTRIM");
        const createRes = await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {
            project_id: project.id,
            name: "trim-repo",
            git_url: "git@example.com:goopter/trim-repo.git",
            default_branch: "main",
            default_runtime: "claude",
            test_command: "  pnpm test --run  ",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const created = createRes.json();
        expect(created.test_command).toBe("pnpm test --run");

        const patchRes = await app.inject({
          method: "PATCH",
          url: `/api/repositories/${created.id}`,
          headers: { cookie },
          payload: { test_command: "\tnpm run test:unit " },
        });
        expect(patchRes.statusCode).toBe(200);
        expect(patchRes.json().test_command).toBe("npm run test:unit");

        const clearRes = await app.inject({
          method: "PATCH",
          url: `/api/repositories/${created.id}`,
          headers: { cookie },
          payload: { test_command: null },
        });
        expect(clearRes.statusCode).toBe(200);
        expect(clearRes.json().test_command).toBeNull();
      });
    });

    it.each([
      ["plain word", "not-a-url"],
      ["ftp url", "ftp://example.com/org/repo.git"],
      ["missing repo", "https://github.com/org"],
    ])("rejects a bad git_url (%s) with 400", async (_label, gitUrl) => {
      const app = await withAuthedApp();
      const project = await createProject(app, "REPOBAD");
      const res = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: {
          project_id: project.id,
          name: "bad-url-repo",
          git_url: gitUrl,
          default_branch: "main",
          default_runtime: "claude",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a default_runtime outside the enum with 400", async () => {
      const app = await withAuthedApp();
      const project = await createProject(app, "REPORT");
      const res = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: {
          project_id: project.id,
          name: "bad-runtime-repo",
          git_url: "git@example.com:goopter/bad-runtime-repo.git",
          default_branch: "main",
          default_runtime: "gpt5",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects max_concurrent_worktrees 0 with 400", async () => {
      const app = await withAuthedApp();
      const project = await createProject(app, "REPOMCW");
      const res = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: {
          project_id: project.id,
          name: "zero-slots-repo",
          git_url: "git@example.com:goopter/zero-slots-repo.git",
          default_branch: "main",
          default_runtime: "claude",
          max_concurrent_worktrees: 0,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown project_id with 400", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: {
          project_id: "00000000-0000-0000-0000-000000000000",
          name: "orphan-repo",
          git_url: "git@example.com:goopter/orphan-repo.git",
          default_branch: "main",
          default_runtime: "claude",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a duplicate (project_id, name) with 409 but allows the same name in another project with 201", async () => {
      const app = await withAuthedApp();
      const project = await createProject(app, "REPODUP");
      const payload = {
        project_id: project.id,
        name: "dup-repo",
        git_url: "git@example.com:goopter/dup-repo.git",
        default_branch: "main",
        default_runtime: "claude",
      };
      await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload,
      });
      const dupRes = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload,
      });
      expect(dupRes.statusCode).toBe(409);

      const otherProject = await createProject(app, "REPODUP2");
      const otherRes = await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { cookie },
        payload: { ...payload, project_id: otherProject.id },
      });
      expect(otherRes.statusCode).toBe(201);
    });
  });

  describe("DELETE /api/repositories/:id (GOT.52)", () => {
    it("deletes a repository when no task references it", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "DELR1" });
      const repo = await seedRepository(testDb.db, {
        projectId: project.id,
        name: "delr1-repo",
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
      });
      expect(getRes.statusCode).toBe(404);
    });

    it("returns 409 with the reason and task count, deleting nothing, when a task references the repository", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "DELR2" });
      const repo = await seedRepository(testDb.db, {
        projectId: project.id,
        name: "delr2-repo",
      });
      await seedTask(testDb.db, {
        projectId: project.id,
        repositoryId: repo.id,
        jiraKey: "DELR2-1",
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe("REFERENCED_BY_TASKS");
      expect(body.error.task_count).toBe(1);
      expect(typeof body.error.message).toBe("string");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
      });
      expect(getRes.statusCode).toBe(200);
    });

    it("returns 404 for an unknown repository id", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/repositories/00000000-0000-0000-0000-000000000000",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects a malformed repository id with 400", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/repositories/not-a-uuid",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an unauthenticated request with 401", async () => {
      clock = createClock();
      app = await buildTestApp(testDb, clock);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/repositories/00000000-0000-0000-0000-000000000000",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("PATCH /api/repositories/:id rename guard (GOT.63-fix2, D7)", () => {
    it("renames a repository with no referencing tasks", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "RENA1" });
      const repo = await seedRepository(testDb.db, {
        projectId: project.id,
        name: "rena1-old",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
        payload: { name: "rena1-new" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("rena1-new");
    });

    it("returns 409 with the reason and task count, applying nothing, when a task references the repository", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "RENA2" });
      const repo = await seedRepository(testDb.db, {
        projectId: project.id,
        name: "rena2-old",
      });
      await seedTask(testDb.db, {
        projectId: project.id,
        repositoryId: repo.id,
        jiraKey: "RENA2-1",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
        payload: { name: "rena2-new", default_branch: "develop" },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe("REPOSITORY_IN_USE");
      expect(body.error.task_count).toBe(1);
      expect(typeof body.error.message).toBe("string");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
      });
      const getBody = getRes.json();
      expect(getBody.name).toBe("rena2-old");
      expect(getBody.default_branch).toBe("main");
    });

    it("allows a PATCH sending the unchanged name even with referencing tasks", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "RENA3" });
      const repo = await seedRepository(testDb.db, {
        projectId: project.id,
        name: "rena3-repo",
      });
      await seedTask(testDb.db, {
        projectId: project.id,
        repositoryId: repo.id,
        jiraKey: "RENA3-1",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
        payload: { name: "rena3-repo", default_branch: "develop" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe("rena3-repo");
      expect(body.default_branch).toBe("develop");
    });

    it("allows a PATCH touching only other fields even with referencing tasks", async () => {
      const app = await withAuthedApp();
      const project = await seedProject(testDb.db, { key: "RENA4" });
      const repo = await seedRepository(testDb.db, {
        projectId: project.id,
        name: "rena4-repo",
      });
      await seedTask(testDb.db, {
        projectId: project.id,
        repositoryId: repo.id,
        jiraKey: "RENA4-1",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/repositories/${repo.id}`,
        headers: { cookie },
        payload: { default_branch: "develop" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe("rena4-repo");
      expect(body.default_branch).toBe("develop");
    });
  });

  describe("users (AC3)", () => {
    it("creates a user who can then log in, and never leaks password_hash", async () => {
      const app = await withAuthedApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "newuser@example.com",
          password: "a very long password",
          display_name: "New User",
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      expect(created).not.toHaveProperty("password_hash");

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "newuser@example.com", password: "a very long password" },
      });
      expect(loginRes.statusCode).toBe(200);

      const listRes = await app.inject({
        method: "GET",
        url: "/api/users",
        headers: { cookie },
      });
      expect(listRes.statusCode).toBe(200);
      for (const user of listRes.json()) {
        expect(user).not.toHaveProperty("password_hash");
      }

      const getRes = await app.inject({
        method: "GET",
        url: `/api/users/${created.id}`,
        headers: { cookie },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json()).not.toHaveProperty("password_hash");
    });

    it("rejects a duplicate email with 409", async () => {
      const app = await withAuthedApp();
      await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "dup@example.com",
          password: "a very long password",
          display_name: "Dup",
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "dup@example.com",
          password: "a different long password",
          display_name: "Dup2",
        },
      });
      expect(res.statusCode).toBe(409);
    });

    it("rejects a short password with 400", async () => {
      const app = await withAuthedApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "short@example.com",
          password: "short11chr",
          display_name: "Short",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("PATCH still applies display_name on its own, unaffected by disabled (AC5)", async () => {
      const app = await withAuthedApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "renameonly@example.com",
          password: "a very long password",
          display_name: "Before",
        },
      });
      const created = createRes.json();

      const renameRes = await app.inject({
        method: "PATCH",
        url: `/api/users/${created.id}`,
        headers: { cookie },
        payload: { display_name: "Still Works" },
      });
      expect(renameRes.statusCode).toBe(200);
      expect(renameRes.json().display_name).toBe("Still Works");
      expect(renameRes.json().disabled_at).toBeNull();
    });

    it("rejects an empty display_name on PATCH with 400 (disabled keeps its own validation)", async () => {
      const app = await withAuthedApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "badpatch@example.com",
          password: "a very long password",
          display_name: "Fine",
        },
      });
      const created = createRes.json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/users/${created.id}`,
        headers: { cookie },
        payload: { display_name: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("disables and re-enables a user, gating login and rejecting an in-flight session (D-GOT.61)", async () => {
      const app = await withAuthedApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "togglable@example.com",
          password: "a very long password",
          display_name: "Togglable",
        },
      });
      const created = createRes.json();

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "togglable@example.com", password: "a very long password" },
      });
      const targetCookie = extractCookie(loginRes.headers["set-cookie"]);

      const meBeforeRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: targetCookie },
      });
      expect(meBeforeRes.statusCode).toBe(200);

      const disableRes = await app.inject({
        method: "PATCH",
        url: `/api/users/${created.id}`,
        headers: { cookie },
        payload: { disabled: true },
      });
      expect(disableRes.statusCode).toBe(200);
      expect(disableRes.json().disabled_at).not.toBeNull();
      expect(disableRes.json()).not.toHaveProperty("password_hash");

      // The disabled user's already-issued session stops authorizing on its
      // very next request -- no session row was deleted, the auth
      // preHandler checked disabled_at live.
      const meAfterDisableRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: targetCookie },
      });
      expect(meAfterDisableRes.statusCode).toBe(401);

      const loginAfterDisableRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "togglable@example.com",
          password: "a very long password",
        },
      });
      // Same 401 body as a wrong password (design.md §13, AC2).
      expect(loginAfterDisableRes.statusCode).toBe(401);

      const enableRes = await app.inject({
        method: "PATCH",
        url: `/api/users/${created.id}`,
        headers: { cookie },
        payload: { disabled: false },
      });
      expect(enableRes.statusCode).toBe(200);
      expect(enableRes.json().disabled_at).toBeNull();

      const loginAfterEnableRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "togglable@example.com",
          password: "a very long password",
        },
      });
      expect(loginAfterEnableRes.statusCode).toBe(200);

      // Re-enabling does not resurrect the old (pre-disable) session.
      const meWithOldCookieRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: targetCookie },
      });
      expect(meWithOldCookieRes.statusCode).toBe(401);
    });

    it("a login past password verification when a disable commits is refused and leaves no session (GOT.61 F1)", async () => {
      const app = await withAuthedApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "login-race@example.com",
          password: "a very long password",
          display_name: "Login Race",
        },
      });
      const targetId: string = createRes.json().id;

      let disabled!: () => void;
      const disabledPromise = new Promise<void>((resolve) => (disabled = resolve));
      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => (release = resolve));

      // The real disable, held open uncommitted: `updateAdminUser` runs in
      // a savepoint of this outer transaction, so its row locks stay held
      // until the barrier releases the outer commit.
      const disableTx = testDb.db.transaction(async (tx) => {
        const result = await updateAdminUser(
          tx as unknown as Db,
          targetId,
          { disabled: true },
          clock.now(),
        );
        expect(result.status).toBe("ok");
        disabled();
        await releasePromise;
      });
      disableTx.catch(() => {});
      await disabledPromise;

      // The login reads the still-enabled row, verifies the password, and
      // reaches its session insert while the disable is uncommitted.
      const login = app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "login-race@example.com", password: "a very long password" },
      });
      await waitForLockWaiters(testDb, 1);

      release();
      await disableTx;
      const loginRes = await login;

      expect(loginRes.statusCode).toBe(401);
      expect(loginRes.json().error.code).toBe("INVALID_CREDENTIALS");
      expect(loginRes.headers["set-cookie"]).toBeUndefined();
      const remaining = await testDb.sql<{ count: number }[]>`
        select count(*)::int as count from sessions where user_id = ${targetId}
      `;
      expect(remaining[0]!.count).toBe(0);
    });

    it("disabling an already-disabled user is a no-op: disabled_at is unchanged", async () => {
      const app = await withAuthedApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "idempotent@example.com",
          password: "a very long password",
          display_name: "Idempotent",
        },
      });
      const created = createRes.json();

      const firstDisableRes = await app.inject({
        method: "PATCH",
        url: `/api/users/${created.id}`,
        headers: { cookie },
        payload: { disabled: true },
      });
      const firstDisabledAt = firstDisableRes.json().disabled_at;

      const secondDisableRes = await app.inject({
        method: "PATCH",
        url: `/api/users/${created.id}`,
        headers: { cookie },
        payload: { disabled: true },
      });
      expect(secondDisableRes.statusCode).toBe(200);
      expect(secondDisableRes.json().disabled_at).toBe(firstDisabledAt);
    });

    it("refuses to disable the caller's own account with 409", async () => {
      const app = await withAuthedApp();
      await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "second-admin@example.com",
          password: "a very long password",
          display_name: "Second Admin",
        },
      });

      const meRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie },
      });
      const selfId = meRes.json().id;

      const res = await app.inject({
        method: "PATCH",
        url: `/api/users/${selfId}`,
        headers: { cookie },
        payload: { disabled: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("CANNOT_DISABLE_SELF");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/users/${selfId}`,
        headers: { cookie },
      });
      expect(getRes.json().disabled_at).toBeNull();
    });

    it("refuses to disable the last enabled user with 409, distinct from self-disable", async () => {
      const app = await withAuthedApp();

      // Two more users, A and B. Disable the seeded admin from A's session
      // (not self-disable, and two others -- A and B -- stay enabled).
      // A and B are now the only two enabled users, and neither request
      // below targets its own caller, so a 409 here can only be the
      // last-enabled-user check, not CANNOT_DISABLE_SELF.
      await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: { email: "race-a@example.com", password: "a very long password", display_name: "A" },
      });
      await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: { email: "race-b@example.com", password: "a very long password", display_name: "B" },
      });

      async function loginCookie(email: string): Promise<string> {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email, password: "a very long password" },
        });
        return extractCookie(res.headers["set-cookie"]);
      }
      const cookieA = await loginCookie("race-a@example.com");
      const cookieB = await loginCookie("race-b@example.com");

      const meRes = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      const seededAdminId = meRes.json().id;
      const disableSeededAdminRes = await app.inject({
        method: "PATCH",
        url: `/api/users/${seededAdminId}`,
        headers: { cookie: cookieA },
        payload: { disabled: true },
      });
      expect(disableSeededAdminRes.statusCode).toBe(200);

      const meARes = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieA } });
      const meBRes = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieB } });
      const idA = meARes.json().id;
      const idB = meBRes.json().id;

      // Barrier: hold `FOR SHARE` on both rows from a separate connection
      // before either request starts. Both requests then pass auth and
      // block inside their disable transaction -- with the `FOR UPDATE`,
      // on the enabled-rows select before deciding; without it, only on
      // the final `UPDATE users`, after both have already decided -- so
      // releasing the barrier starts a genuine race either way.
      let locked!: () => void;
      const lockedPromise = new Promise<void>((resolve) => (locked = resolve));
      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => (release = resolve));
      const blocker = testDb.sql.begin(async (tx) => {
        await tx`select 1 from users where id in (${idA}, ${idB}) for share`;
        locked();
        await releasePromise;
      });
      blocker.catch(() => {});
      await lockedPromise;

      const patchAtoB = app.inject({
        method: "PATCH",
        url: `/api/users/${idB}`,
        headers: { cookie: cookieA },
        payload: { disabled: true },
      });
      const patchBtoA = app.inject({
        method: "PATCH",
        url: `/api/users/${idA}`,
        headers: { cookie: cookieB },
        payload: { disabled: true },
      });
      await waitForLockWaiters(testDb, 2);

      release();
      await blocker;
      const [resAtoB, resBtoA] = await Promise.all([patchAtoB, patchBtoA]);

      // Exactly one side wins (200); the other is refused with 409
      // LAST_ENABLED_USER. Both passed auth before the barrier lifted, so
      // the loser can only be the invariant refusal. (Not a status-code
      // sort: the winner is identified by its status instead.)
      const attempts = [
        { res: resAtoB, cookie: cookieA },
        { res: resBtoA, cookie: cookieB },
      ];
      const winners = attempts.filter((a) => a.res.statusCode === 200);
      const losers = attempts.filter((a) => a.res.statusCode !== 200);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.res.statusCode).toBe(409);
      expect(losers[0]!.res.json().error.code).toBe("LAST_ENABLED_USER");

      // `cookie` (the seeded admin's own session) no longer authorizes:
      // disabling the seeded admin earlier in this test deleted it. The
      // winner's session is still live (it is the one user left enabled),
      // so it lists instead.
      const listRes = await app.inject({
        method: "GET",
        url: "/api/users",
        headers: { cookie: winners[0]!.cookie },
      });
      const disabledAmongAB = listRes
        .json()
        .filter((u: { id: string }) => u.id === idA || u.id === idB)
        .filter((u: { disabled_at: string | null }) => u.disabled_at !== null);
      expect(disabledAmongAB).toHaveLength(1);
    });
  });

  describe("workers (AC4)", () => {
    it("returns heartbeat_age_seconds and free_slots", async () => {
      const app = await withAuthedApp();

      const project = await seedProject(testDb.db, { key: "WRKP" });
      const task = await seedTask(testDb.db, {
        projectId: project.id,
        jiraKey: "WRKP-1",
      });
      await seedAgentWorker(testDb.db, {
        host: "admin-test-host",
        maxConcurrent: 3,
        lastHeartbeatAt: new Date(clock.now().getTime() - 90 * 1000),
      });
      await seedExecutionOnHost(testDb.db, {
        taskId: task.id,
        host: "admin-test-host",
        state: "RUNNING",
      });
      await seedExecutionOnHost(testDb.db, {
        taskId: task.id,
        host: "admin-test-host",
        state: "COMPLETED",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/workers",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const row = res
        .json()
        .find((w: { host: string }) => w.host === "admin-test-host");
      expect(row).toBeDefined();
      expect(row.heartbeat_age_seconds).toBe(90);
      expect(row.free_slots).toBe(2);
    });
  });
});
