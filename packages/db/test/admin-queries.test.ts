import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UniqueViolationError,
  getProjectById,
  getRepositoryById,
  insertProject,
  insertRepository,
  listProjects,
  listRepositories,
  listWorkersWithSlots,
  updateProject,
  updateRepository,
} from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import { seedExecution, seedFixtures, seedTask, startTestDb, type TestDb } from "./harness.js";

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

function projectInput(key: string) {
  return {
    key,
    name: `${key} project`,
    jiraJql: `project = ${key}`,
    maxInfraRetries: 3,
    maxProtocolRetries: 2,
    maxCiRounds: 3,
    maxReviewRounds: 3,
  };
}

describe("insertProject / listProjects / getProjectById (AC6)", () => {
  it("inserts a project and reads it back", async () => {
    const created = await insertProject(h.db, projectInput("ADMQ1"));
    expect(created.key).toBe("ADMQ1");
    expect(created.maxInfraRetries).toBe(3);

    const fetched = await getProjectById(h.db, created.id);
    expect(fetched?.id).toBe(created.id);

    const all = await listProjects(h.db);
    expect(all.some((p) => p.id === created.id)).toBe(true);
  });

  it("returns null for an unknown id", async () => {
    const result = await getProjectById(
      h.db,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("throws UniqueViolationError on a duplicate key", async () => {
    await insertProject(h.db, projectInput("ADMQ2"));

    await expect(insertProject(h.db, projectInput("ADMQ2"))).rejects.toMatchObject(
      { entity: "project", fields: ["key"] },
    );
    await expect(insertProject(h.db, projectInput("ADMQ2"))).rejects.toBeInstanceOf(
      UniqueViolationError,
    );
  });

  it("updates a subset of columns and rejects a key collision (AC6)", async () => {
    const a = await insertProject(h.db, projectInput("ADMQ3A"));
    const b = await insertProject(h.db, projectInput("ADMQ3B"));

    const updated = await updateProject(h.db, a.id, { name: "renamed" });
    expect(updated?.name).toBe("renamed");
    expect(updated?.key).toBe("ADMQ3A");

    await expect(
      updateProject(h.db, b.id, { key: "ADMQ3A" }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });
});

describe("insertRepository / listRepositories / getRepositoryById (AC6)", () => {
  it("inserts a repository scoped to a project", async () => {
    const project = await insertProject(h.db, projectInput("ADMR1"));
    const repo = await insertRepository(h.db, {
      projectId: project.id,
      name: "repo-one",
      gitUrl: "git@example.com:goopter/repo-one.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: null,
      maxConcurrentWorktrees: 1,
      requiredCapability: null,
      setupCommand: null,
    });
    expect(repo.projectId).toBe(project.id);

    const fetched = await getRepositoryById(h.db, repo.id);
    expect(fetched?.name).toBe("repo-one");

    const scoped = await listRepositories(h.db, { projectId: project.id });
    expect(scoped.map((r) => r.id)).toEqual([repo.id]);
  });

  it("throws UniqueViolationError on a duplicate (project_id, name) but allows the same name in another project", async () => {
    const project = await insertProject(h.db, projectInput("ADMR2"));
    const otherProject = await insertProject(h.db, projectInput("ADMR2B"));

    await insertRepository(h.db, {
      projectId: project.id,
      name: "shared-name",
      gitUrl: "git@example.com:goopter/shared.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: null,
      maxConcurrentWorktrees: 1,
      requiredCapability: null,
      setupCommand: null,
    });

    await expect(
      insertRepository(h.db, {
        projectId: project.id,
        name: "shared-name",
        gitUrl: "git@example.com:goopter/shared2.git",
        defaultBranch: "main",
        defaultRuntime: "claude",
        defaultModel: null,
        maxConcurrentWorktrees: 1,
        requiredCapability: null,
        setupCommand: null,
      }),
    ).rejects.toMatchObject({ entity: "repository", fields: ["projectId", "name"] });

    const inOtherProject = await insertRepository(h.db, {
      projectId: otherProject.id,
      name: "shared-name",
      gitUrl: "git@example.com:goopter/shared3.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: null,
      maxConcurrentWorktrees: 1,
      requiredCapability: null,
      setupCommand: null,
    });
    expect(inOtherProject.name).toBe("shared-name");
  });

  it("rejects a repository name collision on update", async () => {
    const project = await insertProject(h.db, projectInput("ADMR3"));
    await insertRepository(h.db, {
      projectId: project.id,
      name: "existing",
      gitUrl: "git@example.com:goopter/existing.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: null,
      maxConcurrentWorktrees: 1,
      requiredCapability: null,
      setupCommand: null,
    });
    const other = await insertRepository(h.db, {
      projectId: project.id,
      name: "other",
      gitUrl: "git@example.com:goopter/other.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: null,
      maxConcurrentWorktrees: 1,
      requiredCapability: null,
      setupCommand: null,
    });

    await expect(
      updateRepository(h.db, other.id, { name: "existing" }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });
});

describe("listWorkersWithSlots (AC4, AC6)", () => {
  it("computes heartbeat_age_seconds and free_slots from active executions on the host", async () => {
    const fixtures = await seedFixtures(h.db, "ADMW1");
    const taskId = await seedTask(h.db, fixtures, {
      jiraKey: "ADMW1-1",
      state: "IMPLEMENTING",
    });

    const now = new Date("2026-01-01T00:01:30Z");
    const [worker] = await h.db
      .insert(schema.agentWorkers)
      .values({
        host: "admq-worker-1",
        capabilities: ["node"],
        maxConcurrent: 3,
        workspaceRoot: "/srv/orchestra",
        lastHeartbeatAt: new Date("2026-01-01T00:00:00Z"),
        startedAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning({ id: schema.agentWorkers.id });

    const runningId = await seedExecution(h.db, taskId, { state: "RUNNING" });
    const completedId = await seedExecution(h.db, taskId, {
      state: "COMPLETED",
    });
    await h.db
      .update(schema.executions)
      .set({ host: "admq-worker-1" })
      .where(inArray(schema.executions.id, [runningId, completedId]));

    const rows = await listWorkersWithSlots(h.db, now);
    const row = rows.find((r) => r.id === worker!.id);
    expect(row).toBeDefined();
    expect(row?.heartbeatAgeSeconds).toBe(90);
    expect(row?.freeSlots).toBe(2);
  });

  it("clamps free_slots at 0 when a host is over-assigned (R4)", async () => {
    const fixtures = await seedFixtures(h.db, "ADMW2");
    const taskId = await seedTask(h.db, fixtures, {
      jiraKey: "ADMW2-1",
      state: "IMPLEMENTING",
    });

    const now = new Date("2026-01-01T00:01:30Z");
    const [worker] = await h.db
      .insert(schema.agentWorkers)
      .values({
        host: "admq-worker-2",
        capabilities: ["node"],
        maxConcurrent: 1,
        workspaceRoot: "/srv/orchestra",
        lastHeartbeatAt: new Date("2026-01-01T00:00:00Z"),
        startedAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning({ id: schema.agentWorkers.id });

    const runningId1 = await seedExecution(h.db, taskId, { state: "RUNNING" });
    const runningId2 = await seedExecution(h.db, taskId, {
      state: "RUNNING",
      attempt: 2,
    });
    await h.db
      .update(schema.executions)
      .set({ host: "admq-worker-2" })
      .where(inArray(schema.executions.id, [runningId1, runningId2]));

    const rows = await listWorkersWithSlots(h.db, now);
    const row = rows.find((r) => r.id === worker!.id);
    expect(row).toBeDefined();
    expect(row?.freeSlots).toBe(0);
  });
});
