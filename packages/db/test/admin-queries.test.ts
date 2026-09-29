import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UniqueViolationError,
  deleteProject,
  deleteRepository,
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
import type { DbOrTx } from "../src/transition.js";
import {
  seedExecution,
  seedFixtures,
  seedTask,
  sleep,
  startTestDb,
  type TestDb,
} from "./harness.js";

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

function repoInput(projectId: string, name: string) {
  return {
    projectId,
    name,
    gitUrl: `git@example.com:goopter/${name}.git`,
    defaultBranch: "main",
    defaultRuntime: "claude" as const,
    defaultModel: null,
    maxConcurrentWorktrees: 1,
    requiredCapability: null,
    setupCommand: null,
  };
}

/** Inserts one task row with fields not covered by `seedTask`'s fixtures shape. */
async function insertTaskRow(
  db: DbOrTx,
  input: {
    projectId: string;
    repositoryId: string | null;
    jiraKey: string;
  },
) {
  const when = new Date("2026-01-01T00:00:00Z");
  const [row] = await db
    .insert(schema.tasks)
    .values({
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      jiraKey: input.jiraKey,
      jiraSummary: `Summary for ${input.jiraKey}`,
      jiraPriority: 3,
      jiraCreatedAt: when,
      jiraSyncedAt: when,
      state: "NEEDS_SPEC",
    })
    .returning({ id: schema.tasks.id });
  return row!.id;
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

  it("defaults agent_container to false and agent_image to null when omitted (C6, D20)", async () => {
    const project = await insertProject(h.db, projectInput("ADMR4"));
    const repo = await insertRepository(h.db, {
      projectId: project.id,
      name: "no-container",
      gitUrl: "git@example.com:goopter/no-container.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: null,
      maxConcurrentWorktrees: 1,
      requiredCapability: null,
      setupCommand: null,
    });
    expect(repo.agentContainer).toBe(false);
    expect(repo.agentImage).toBeNull();
  });

  it("stores explicit agent_container / agent_image and patches them (C6, D20)", async () => {
    const project = await insertProject(h.db, projectInput("ADMR5"));
    const repo = await insertRepository(h.db, {
      projectId: project.id,
      name: "with-container",
      gitUrl: "git@example.com:goopter/with-container.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: null,
      maxConcurrentWorktrees: 1,
      requiredCapability: null,
      setupCommand: null,
      agentContainer: true,
      agentImage: "orchestra/agent:custom",
    });
    expect(repo.agentContainer).toBe(true);
    expect(repo.agentImage).toBe("orchestra/agent:custom");

    const fetched = await getRepositoryById(h.db, repo.id);
    expect(fetched?.agentContainer).toBe(true);
    expect(fetched?.agentImage).toBe("orchestra/agent:custom");

    const updated = await updateRepository(h.db, repo.id, {
      agentContainer: false,
      agentImage: null,
    });
    expect(updated?.agentContainer).toBe(false);
    expect(updated?.agentImage).toBeNull();
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

  it("does not count an idle spec session (RUNNING, no token) as a used slot, but does count one mid-turn (GOT.82)", async () => {
    const fixtures = await seedFixtures(h.db, "ADMW3");
    const taskId = await seedTask(h.db, fixtures, {
      jiraKey: "ADMW3-1",
      state: "NEEDS_SPEC",
    });

    const now = new Date("2026-01-01T00:01:30Z");
    const [worker] = await h.db
      .insert(schema.agentWorkers)
      .values({
        host: "admq-worker-3",
        capabilities: ["node"],
        maxConcurrent: 2,
        workspaceRoot: "/srv/orchestra",
        lastHeartbeatAt: new Date("2026-01-01T00:00:00Z"),
        startedAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning({ id: schema.agentWorkers.id });

    const idleSpecId = await seedExecution(h.db, taskId, {
      role: "spec",
      state: "RUNNING",
    });
    const midTurnSpecId = await seedExecution(h.db, taskId, {
      role: "spec",
      state: "RUNNING",
      attempt: 2,
    });
    await h.db
      .update(schema.executions)
      .set({ host: "admq-worker-3" })
      .where(inArray(schema.executions.id, [idleSpecId, midTurnSpecId]));
    await h.db
      .update(schema.executions)
      .set({ toolsTokenHash: "admw3-mid-turn-token" })
      .where(eq(schema.executions.id, midTurnSpecId));

    const rows = await listWorkersWithSlots(h.db, now);
    const row = rows.find((r) => r.id === worker!.id);
    expect(row).toBeDefined();
    // Only the mid-turn spec session holds a slot: max_concurrent (2) - 1.
    expect(row?.freeSlots).toBe(1);
  });
});

describe("deleteRepository (GOT.52)", () => {
  it("deletes a repository with no referencing tasks", async () => {
    const project = await insertProject(h.db, projectInput("DELR1"));
    const repo = await insertRepository(h.db, repoInput(project.id, "delr1-repo"));

    const result = await deleteRepository(h.db, repo.id);

    expect(result).toEqual({ status: "deleted" });
    expect(await getRepositoryById(h.db, repo.id)).toBeNull();
  });

  it("returns not_found for an unknown id", async () => {
    const result = await deleteRepository(
      h.db,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("blocks and leaves the repository intact when a task references it, with the referencing count", async () => {
    const fixtures = await seedFixtures(h.db, "DELR2");
    await seedTask(h.db, fixtures, { jiraKey: "DELR2-1", state: "NEEDS_SPEC" });
    await seedTask(h.db, fixtures, { jiraKey: "DELR2-2", state: "NEEDS_SPEC" });

    const result = await deleteRepository(h.db, fixtures.repositoryId);

    expect(result).toEqual({ status: "blocked", taskCount: 2 });
    expect(await getRepositoryById(h.db, fixtures.repositoryId)).not.toBeNull();
  });

  it("is race-safe: deleteRepository blocks behind an uncommitted referencing task insert, then sees it and blocks instead of deleting (AC4, F3)", async () => {
    const project = await insertProject(h.db, projectInput("DELR3"));
    const repo = await insertRepository(h.db, repoInput(project.id, "delr3-repo"));

    let taskInserted!: () => void;
    const taskInsertedPromise = new Promise<void>((resolve) => {
      taskInserted = resolve;
    });
    let releaseInsertTx!: () => void;
    const releaseInsertTxPromise = new Promise<void>((resolve) => {
      releaseInsertTx = resolve;
    });

    // The insert's FK check takes a FOR KEY SHARE lock on the repository row
    // and holds it for the life of this transaction, uncommitted.
    const insertTxPromise = h.db.transaction(async (tx) => {
      await insertTaskRow(tx, {
        projectId: project.id,
        repositoryId: repo.id,
        jiraKey: "DELR3-1",
      });
      taskInserted();
      await releaseInsertTxPromise;
    });
    // Attached immediately so a rejection here (e.g. this transaction fails
    // for an unrelated reason before `releaseInsertTx` is even called) can
    // never surface as an unhandled rejection during the window below; the
    // `await insertTxPromise` further down still observes the same outcome.
    insertTxPromise.catch(() => {});

    await taskInsertedPromise;

    let deleteSettled = false;
    const deletePromise = deleteRepository(h.db, repo.id).then((result) => {
      deleteSettled = true;
      return result;
    });
    deletePromise.catch(() => {});

    // deleteRepository's own `SELECT ... FOR UPDATE` on the repository row
    // conflicts with the insert transaction's FOR KEY SHARE lock: it must
    // still be pending while that transaction holds the lock uncommitted.
    await sleep(200);
    expect(deleteSettled).toBe(false);

    releaseInsertTx();
    await insertTxPromise;

    const result = await deletePromise;
    expect(result).toEqual({ status: "blocked", taskCount: 1 });
    expect(await getRepositoryById(h.db, repo.id)).not.toBeNull();
  });
});

describe("deleteProject (GOT.52, D2)", () => {
  it("deletes a project and all its repositories in one transaction when no task references it", async () => {
    const project = await insertProject(h.db, projectInput("DELP1"));
    const repoA = await insertRepository(h.db, repoInput(project.id, "delp1-a"));
    const repoB = await insertRepository(h.db, repoInput(project.id, "delp1-b"));

    const result = await deleteProject(h.db, project.id);

    expect(result).toEqual({ status: "deleted" });
    expect(await getProjectById(h.db, project.id)).toBeNull();
    expect(await getRepositoryById(h.db, repoA.id)).toBeNull();
    expect(await getRepositoryById(h.db, repoB.id)).toBeNull();
  });

  it("returns not_found for an unknown id", async () => {
    const result = await deleteProject(
      h.db,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("blocks and deletes nothing when a task references the project directly", async () => {
    const fixtures = await seedFixtures(h.db, "DELP2");
    await seedTask(h.db, fixtures, {
      jiraKey: "DELP2-1",
      state: "NEEDS_SPEC",
      withRepository: false,
    });

    const result = await deleteProject(h.db, fixtures.projectId);

    expect(result).toEqual({ status: "blocked", taskCount: 1 });
    expect(await getProjectById(h.db, fixtures.projectId)).not.toBeNull();
    expect(await getRepositoryById(h.db, fixtures.repositoryId)).not.toBeNull();
  });

  it("blocks (no partial delete) when a task only references one of its repositories", async () => {
    const project = await insertProject(h.db, projectInput("DELP3"));
    const repoA = await insertRepository(h.db, repoInput(project.id, "delp3-a"));
    const repoB = await insertRepository(h.db, repoInput(project.id, "delp3-b"));
    await insertTaskRow(h.db, {
      projectId: project.id,
      repositoryId: repoA.id,
      jiraKey: "DELP3-1",
    });

    const result = await deleteProject(h.db, project.id);

    expect(result).toEqual({ status: "blocked", taskCount: 1 });
    expect(await getProjectById(h.db, project.id)).not.toBeNull();
    expect(await getRepositoryById(h.db, repoA.id)).not.toBeNull();
    expect(await getRepositoryById(h.db, repoB.id)).not.toBeNull();
  });

  it("counts a task referencing only one of the project's repositories, with a different project_id, as referencing it (directly-or-through-repositories)", async () => {
    const projectA = await insertProject(h.db, projectInput("DELP4A"));
    const projectB = await insertProject(h.db, projectInput("DELP4B"));
    const repoA = await insertRepository(h.db, repoInput(projectA.id, "delp4-a"));
    await insertTaskRow(h.db, {
      projectId: projectB.id,
      repositoryId: repoA.id,
      jiraKey: "DELP4-1",
    });

    const result = await deleteProject(h.db, projectA.id);

    expect(result).toEqual({ status: "blocked", taskCount: 1 });
    expect(await getProjectById(h.db, projectA.id)).not.toBeNull();
    expect(await getRepositoryById(h.db, repoA.id)).not.toBeNull();
  });

  it("is race-safe: a task insert racing a project delete never leaves an orphaned task", async () => {
    const project = await insertProject(h.db, projectInput("DELP5"));

    const [deleteResult, insertResult] = await Promise.allSettled([
      deleteProject(h.db, project.id),
      insertTaskRow(h.db, {
        projectId: project.id,
        repositoryId: null,
        jiraKey: "DELP5-1",
      }),
    ]);

    const projectStillExists =
      (await getProjectById(h.db, project.id)) !== null;
    const taskRows = await h.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.jiraKey, "DELP5-1"));

    if (!projectStillExists) {
      // The delete won the race: no task can have landed against a project
      // that no longer exists.
      expect(insertResult.status).toBe("rejected");
      expect(taskRows).toHaveLength(0);
      expect(deleteResult.status).toBe("fulfilled");
      if (deleteResult.status === "fulfilled") {
        expect(deleteResult.value).toEqual({ status: "deleted" });
      }
    } else {
      // The insert won the race: the delete must have seen it and refused.
      expect(insertResult.status).toBe("fulfilled");
      expect(taskRows).toHaveLength(1);
      expect(deleteResult.status).toBe("fulfilled");
      if (deleteResult.status === "fulfilled") {
        expect(deleteResult.value).toEqual({ status: "blocked", taskCount: 1 });
      }
    }
  });
});
