import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listExecutionWorktreePaths,
  listRepositoryNames,
  repositoryNameExists,
} from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import { seedExecution, seedFixtures, seedTask, startTestDb, type TestDb } from "./harness.js";

/**
 * Queries behind the worktree sweeper's deleted-repository clone pass
 * (GOT.63, design.md D7): the worker's bare clone directory under
 * `repos/<name>.git` is keyed on `repositories.name` alone, but that name is
 * unique only per project, so both queries look across every project.
 */

let h: TestDb;
let seq = 0;

beforeAll(async () => {
  h = await startTestDb();
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

async function project(key: string): Promise<string> {
  const [row] = await h.db
    .insert(schema.projects)
    .values({ key, name: `${key} project`, jiraJql: `project = ${key}` })
    .returning({ id: schema.projects.id });
  return row!.id;
}

async function repository(projectId: string, name: string): Promise<string> {
  const [row] = await h.db
    .insert(schema.repositories)
    .values({
      projectId,
      name,
      gitUrl: `git@example.com:goopter/${name}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
    })
    .returning({ id: schema.repositories.id });
  return row!.id;
}

describe("listRepositoryNames (GOT.63)", () => {
  it("returns the name of a repository from any project", async () => {
    const key = `LRN${++seq}`;
    const projectId = await project(key);
    const name = `repo-${key.toLowerCase()}`;
    await repository(projectId, name);

    const names = await listRepositoryNames(h.db);

    expect(names.has(name)).toBe(true);
  });

  it("returns one entry for a name two different projects both use", async () => {
    const keyA = `LRN${++seq}`;
    const keyB = `LRN${++seq}`;
    const shared = `shared-${keyA.toLowerCase()}`;
    await repository(await project(keyA), shared);
    await repository(await project(keyB), shared);

    const names = await listRepositoryNames(h.db);

    expect([...names].filter((n) => n === shared)).toEqual([shared]);
  });

  it("does not return a name once its only repository row is deleted", async () => {
    const key = `LRN${++seq}`;
    const projectId = await project(key);
    const name = `repo-${key.toLowerCase()}`;
    const repositoryId = await repository(projectId, name);
    expect((await listRepositoryNames(h.db)).has(name)).toBe(true);

    await h.db.delete(schema.repositories).where(eq(schema.repositories.id, repositoryId));

    expect((await listRepositoryNames(h.db)).has(name)).toBe(false);
  });
});

describe("repositoryNameExists (GOT.63)", () => {
  it("is true when some repository, in any project, currently has the name", async () => {
    const key = `RNE${++seq}`;
    const projectId = await project(key);
    const name = `repo-${key.toLowerCase()}`;
    await repository(projectId, name);

    expect(await repositoryNameExists(h.db, name)).toBe(true);
  });

  it("is false for a name no repository has", async () => {
    expect(await repositoryNameExists(h.db, `nonexistent-${++seq}`)).toBe(false);
  });

  it("stays true for a name after one of two projects using it deletes its repository", async () => {
    const keyA = `RNE${++seq}`;
    const keyB = `RNE${++seq}`;
    const shared = `shared-${keyA.toLowerCase()}`;
    const repoA = await repository(await project(keyA), shared);
    await repository(await project(keyB), shared);

    await h.db.delete(schema.repositories).where(eq(schema.repositories.id, repoA));

    expect(await repositoryNameExists(h.db, shared)).toBe(true);
  });

  it("becomes false once a repository with that name is deleted (re-create-and-recheck race)", async () => {
    const key = `RNE${++seq}`;
    const projectId = await project(key);
    const name = `repo-${key.toLowerCase()}`;
    const repositoryId = await repository(projectId, name);
    expect(await repositoryNameExists(h.db, name)).toBe(true);

    await h.db.delete(schema.repositories).where(eq(schema.repositories.id, repositoryId));
    expect(await repositoryNameExists(h.db, name)).toBe(false);

    // Re-created under the same name: the sweeper's post-lock recheck must
    // see it again, not a stale "gone" answer.
    await repository(projectId, name);
    expect(await repositoryNameExists(h.db, name)).toBe(true);
  });

  it("matches a name that differs only by case (F2: case-insensitive filesystems)", async () => {
    const key = `RNE${++seq}`;
    const name = `Casey_${key}`;
    await repository(await project(key), name);

    expect(await repositoryNameExists(h.db, name.toLowerCase())).toBe(true);
    expect(await repositoryNameExists(h.db, name.toUpperCase())).toBe(true);
  });
});

describe("listExecutionWorktreePaths (GOT.63 F1)", () => {
  it("returns every recorded worktree_path, in any state, and skips executions with none", async () => {
    const key = `LEW${++seq}`;
    const fx = await seedFixtures(h.db, key);
    const taskId = await seedTask(h.db, fx, { jiraKey: `${key}-1`, state: "IMPLEMENTING" });
    const running = await seedExecution(h.db, taskId, { state: "RUNNING" });
    const failed = await seedExecution(h.db, taskId, { state: "FAILED", attempt: 2 });
    const none = await seedExecution(h.db, taskId, { state: "FAILED", attempt: 3 });
    const pathFor = (id: string) => `/workspace/${key}/work/${id}`;
    for (const id of [running, failed]) {
      await h.db
        .update(schema.executions)
        .set({ worktreePath: pathFor(id) })
        .where(eq(schema.executions.id, id));
    }

    const paths = await listExecutionWorktreePaths(h.db);

    expect(paths).toContain(pathFor(running));
    expect(paths).toContain(pathFor(failed));
    expect(paths).not.toContain(pathFor(none));
    expect(paths).not.toContain(null);
  });
});
