import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSpecRepository } from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import { seedFixtures, seedTask, startTestDb, type TestDb } from "./harness.js";

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120000);

afterAll(async () => {
  await h?.stop();
});

/**
 * GOT.80 D2, D3: `resolveSpecRepository` returns the task's own
 * `repository_id`, never a project-wide alphabetical fallback.
 */
describe("resolveSpecRepository (GOT.80 D2, D3)", () => {
  it("returns the task's own repository even when another repository of the project sorts first alphabetically", async () => {
    const fx = await seedFixtures(h.db, "SER1");
    // seedFixtures names the fixture repository "ser1-repo"; add one that
    // sorts before it so a fallback-by-name would pick the wrong one.
    const [earlier] = await h.db
      .insert(schema.repositories)
      .values({
        projectId: fx.projectId,
        name: "aaa-earlier-repo",
        gitUrl: "git@example.com:goopter/aaa-earlier.git",
        defaultBranch: "main",
        defaultRuntime: "claude",
      })
      .returning({ id: schema.repositories.id });
    expect(earlier).toBeDefined();

    const taskId = await seedTask(h.db, fx, {
      jiraKey: "SER1-1",
      state: "SPEC_IN_PROGRESS",
    });

    const resolved = await resolveSpecRepository(h.db, taskId);
    expect(resolved?.id).toBe(fx.repositoryId);
    expect(resolved?.name).toBe("ser1-repo");
  });

  it("returns null when the task has no repository yet, even though the project has one", async () => {
    const fx = await seedFixtures(h.db, "SER2");
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "SER2-1",
      state: "NEEDS_SPEC",
      withRepository: false,
    });

    expect(await resolveSpecRepository(h.db, taskId)).toBeNull();
  });

  it("returns null for an unknown task id", async () => {
    expect(
      await resolveSpecRepository(h.db, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });
});
