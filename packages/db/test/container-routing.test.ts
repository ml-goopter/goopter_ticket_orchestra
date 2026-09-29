import type { CommandType } from "@orchestra/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimExecutionCommands,
  workerMatchesRepositoryContainerMode,
} from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import {
  seedFixtures,
  seedTask,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "./harness.js";

/**
 * design.md §9.9 Scheduling on the §6.1 command claim (C4b): a container-mode
 * repository's work goes only to a worker with the `docker` capability.
 * Covers the two claims that would otherwise place an agent session on any
 * worker: `start_spec_session` (no execution yet) and the resume commands of
 * an implementation execution released from a dead host (host null), which
 * the handler pins for a fresh session (C21). Anything else claims as before.
 */

let h: TestDb;
let fx: Fixtures;
let hostRepoId: string;
let containerRepoId: string;
let seq = 0;

const workers: Record<string, { id: string; host: string }> = {};

async function insertWorker(
  host: string,
  capabilities: string[],
): Promise<{ id: string; host: string }> {
  const [row] = await h.db
    .insert(schema.agentWorkers)
    .values({ host, capabilities, maxConcurrent: 10, workspaceRoot: "/ws" })
    .returning({ id: schema.agentWorkers.id });
  return { id: row!.id, host };
}

async function insertProject(key: string): Promise<string> {
  const [row] = await h.db
    .insert(schema.projects)
    .values({ key, name: `${key} project`, jiraJql: `project = ${key}` })
    .returning({ id: schema.projects.id });
  return row!.id;
}

async function insertRepository(
  projectId: string,
  name: string,
  agentContainer: boolean,
): Promise<string> {
  const [row] = await h.db
    .insert(schema.repositories)
    .values({
      projectId,
      name,
      gitUrl: `git@example.com:goopter/${name}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
      agentContainer,
    })
    .returning({ id: schema.repositories.id });
  return row!.id;
}

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "CRT");
  hostRepoId = fx.repositoryId;
  containerRepoId = await insertRepository(fx.projectId, "crt-container", true);
  workers.plain = await insertWorker("host-plain", []);
  workers.docker = await insertWorker("host-docker", ["docker"]);
  workers.odoo = await insertWorker("host-odoo", ["odoo"]);
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

beforeEach(async () => {
  await h.db.execute(sql`truncate table tasks cascade`);
});

let clock = Date.parse("2026-03-01T00:00:00Z");

async function seedTaskOn(
  repositoryId: string | null,
  state: "SPEC_IN_PROGRESS" | "IMPLEMENTING",
  projectId = fx.projectId,
): Promise<string> {
  const taskId = await seedTask(h.db, { ...fx, projectId, repositoryId: repositoryId ?? fx.repositoryId }, {
    jiraKey: `CRT-${++seq}`,
    state,
    withRepository: repositoryId !== null,
  });
  return taskId;
}

async function insertExecution(
  taskId: string,
  values: { host: string | null; role?: "spec" | "implementation" },
): Promise<string> {
  const [row] = await h.db
    .insert(schema.executions)
    .values({
      taskId,
      role: values.role ?? "implementation",
      attempt: 1,
      state: "WAITING_FOR_USER",
      runtime: "claude",
      model: "claude-sonnet-5",
      host: values.host,
      sessionId: "sess",
      worktreePath: "/ws/work/x",
    })
    .returning({ id: schema.executions.id });
  return row!.id;
}

async function insertCommand(
  taskId: string,
  executionId: string | null,
  type: CommandType,
): Promise<string> {
  const [row] = await h.db
    .insert(schema.executionCommands)
    .values({
      taskId,
      executionId,
      type,
      payload: {},
      createdAt: new Date((clock += 1000)),
    })
    .returning({ id: schema.executionCommands.id });
  return row!.id;
}

const ALL_TYPES: CommandType[] = [
  "start_spec_session",
  "send_message",
  "resume_with_decision",
  "resume_with_revision",
  "resume_with_ci_failure",
  "cancel",
];

async function claim(worker: { id: string; host: string }): Promise<string[]> {
  const rows = await claimExecutionCommands(h.db, {
    workerId: worker.id,
    host: worker.host,
    types: ALL_TYPES,
    now: new Date(),
  });
  return rows.map((r) => r.id);
}

async function commandRow(id: string) {
  const [row] = await h.db.execute<{ claimed_at: Date | null; completed_at: Date | null }>(
    sql`select claimed_at, completed_at from execution_commands where id = ${id}`,
  );
  return row!;
}

describe("start_spec_session claim (§9.9 Scheduling)", () => {
  it("a worker without docker leaves a container-mode task's start unclaimed", async () => {
    const taskId = await seedTaskOn(containerRepoId, "SPEC_IN_PROGRESS");
    const id = await insertCommand(taskId, null, "start_spec_session");
    expect(await claim(workers.plain!)).toEqual([]);
    expect(await claim(workers.odoo!)).toEqual([]);
    expect(await commandRow(id)).toMatchObject({ claimed_at: null, completed_at: null });
  });

  it("a docker worker claims a container-mode task's start", async () => {
    const taskId = await seedTaskOn(containerRepoId, "SPEC_IN_PROGRESS");
    const id = await insertCommand(taskId, null, "start_spec_session");
    expect(await claim(workers.docker!)).toEqual([id]);
  });

  it("any worker claims a host-mode task's start", async () => {
    const a = await insertCommand(await seedTaskOn(hostRepoId, "SPEC_IN_PROGRESS"), null, "start_spec_session");
    expect(await claim(workers.plain!)).toEqual([a]);
    const b = await insertCommand(await seedTaskOn(hostRepoId, "SPEC_IN_PROGRESS"), null, "start_spec_session");
    expect(await claim(workers.docker!)).toEqual([b]);
  });

  it("with no task repository, follows the project's first repository by name (C41)", async () => {
    // Container-mode first by name.
    const p1 = await insertProject(`CRA${++seq}`);
    await insertRepository(p1, "a-ctr", true);
    await insertRepository(p1, "b-host", false);
    const t1 = await seedTaskOn(null, "SPEC_IN_PROGRESS", p1);
    const c1 = await insertCommand(t1, null, "start_spec_session");
    expect(await claim(workers.plain!)).toEqual([]);
    expect(await claim(workers.docker!)).toEqual([c1]);

    // Host-mode first by name, a container-mode one after it.
    const p2 = await insertProject(`CRB${++seq}`);
    await insertRepository(p2, "b-ctr", true);
    await insertRepository(p2, "a-host", false);
    const t2 = await seedTaskOn(null, "SPEC_IN_PROGRESS", p2);
    const c2 = await insertCommand(t2, null, "start_spec_session");
    expect(await claim(workers.plain!)).toEqual([c2]);
  });

  it("a project with no repository still claims as before (the handler skips it)", async () => {
    const p = await insertProject(`CRN${++seq}`);
    const t = await seedTaskOn(null, "SPEC_IN_PROGRESS", p);
    const c = await insertCommand(t, null, "start_spec_session");
    expect(await claim(workers.plain!)).toEqual([c]);
  });
});

describe("resume of a released implementation execution (C21, §9.9)", () => {
  const RESUME_TYPES: CommandType[] = ["send_message", "resume_with_decision", "resume_with_revision"];

  for (const type of RESUME_TYPES) {
    it(`${type}: a worker without docker leaves a released container-mode execution's command unclaimed`, async () => {
      const taskId = await seedTaskOn(containerRepoId, "IMPLEMENTING");
      const executionId = await insertExecution(taskId, { host: null });
      const id = await insertCommand(taskId, executionId, type);
      expect(await claim(workers.plain!)).toEqual([]);
      expect(await commandRow(id)).toMatchObject({ claimed_at: null, completed_at: null });
      expect(await claim(workers.docker!)).toEqual([id]);
    });
  }

  it("a released host-mode execution's command is claimed by a worker without docker", async () => {
    const taskId = await seedTaskOn(hostRepoId, "IMPLEMENTING");
    const executionId = await insertExecution(taskId, { host: null });
    const id = await insertCommand(taskId, executionId, "resume_with_decision");
    expect(await claim(workers.plain!)).toEqual([id]);
  });

  it("a container-mode execution pinned to the worker's own host is still claimed there", async () => {
    const taskId = await seedTaskOn(containerRepoId, "IMPLEMENTING");
    const executionId = await insertExecution(taskId, { host: workers.plain!.host });
    const id = await insertCommand(taskId, executionId, "resume_with_decision");
    expect(await claim(workers.plain!)).toEqual([id]);
  });

  it("commands that never pin (cancel, resume_with_ci_failure) on a released container-mode execution claim as before", async () => {
    const taskId = await seedTaskOn(containerRepoId, "IMPLEMENTING");
    const executionId = await insertExecution(taskId, { host: null });
    const cancel = await insertCommand(taskId, executionId, "cancel");
    const ci = await insertCommand(taskId, executionId, "resume_with_ci_failure");
    expect(await claim(workers.plain!)).toEqual([cancel, ci]);
  });

  it("a released spec execution's command claims as before (the handler skips it)", async () => {
    const taskId = await seedTaskOn(containerRepoId, "SPEC_IN_PROGRESS");
    const executionId = await insertExecution(taskId, { host: null, role: "spec" });
    const id = await insertCommand(taskId, executionId, "send_message");
    expect(await claim(workers.plain!)).toEqual([id]);
  });

  it("a worker without docker is not starved by more than a claim's worth of container-mode work", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const taskId = await seedTaskOn(containerRepoId, "IMPLEMENTING");
      ids.push(await insertCommand(taskId, await insertExecution(taskId, { host: null }), "send_message"));
    }
    const hostTask = await seedTaskOn(hostRepoId, "SPEC_IN_PROGRESS");
    const hostCommand = await insertCommand(hostTask, null, "start_spec_session");
    expect(await claim(workers.plain!)).toEqual([hostCommand]);
    expect(await claim(workers.docker!)).toEqual(ids.slice(0, 10));
  });
});

describe("workerMatchesRepositoryContainerMode (§9.9)", () => {
  it("is true for a host-mode repository on any worker", async () => {
    expect(await workerMatchesRepositoryContainerMode(h.db, hostRepoId, workers.plain!.id)).toBe(true);
    expect(await workerMatchesRepositoryContainerMode(h.db, hostRepoId, workers.docker!.id)).toBe(true);
  });

  it("is true for a container-mode repository only on a docker worker", async () => {
    expect(await workerMatchesRepositoryContainerMode(h.db, containerRepoId, workers.plain!.id)).toBe(false);
    expect(await workerMatchesRepositoryContainerMode(h.db, containerRepoId, workers.odoo!.id)).toBe(false);
    expect(await workerMatchesRepositoryContainerMode(h.db, containerRepoId, workers.docker!.id)).toBe(true);
  });
});
