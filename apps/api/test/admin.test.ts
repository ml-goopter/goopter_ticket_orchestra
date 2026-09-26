import {
  agentWorkers,
  executions,
  projects,
  repositories,
  sessions,
  tasks,
  users,
} from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestApp,
  createClock,
  seedUser,
  startTestDb,
  type Clock,
  type TestDb,
} from "./harness.js";
import {
  seedAgentWorker,
  seedExecutionOnHost,
  seedProject,
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

    it("rejects a `disabled` field with 400 and writes nothing, but display_name still updates (R3, AC5)", async () => {
      const app = await withAuthedApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: "notoggle@example.com",
          password: "a very long password",
          display_name: "No Toggle",
        },
      });
      const created = createRes.json();

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/users/${created.id}`,
        headers: { cookie },
        payload: { disabled: true },
      });
      expect(patchRes.statusCode).toBe(400);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/users/${created.id}`,
        headers: { cookie },
      });
      expect(getRes.json().disabled_at).toBeNull();
      expect(getRes.json().display_name).toBe("No Toggle");

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
