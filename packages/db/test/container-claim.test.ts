import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  selectClaimCandidate,
  selectRetryCandidate,
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
 * design.md §9.9 Scheduling: a task whose repository has
 * `agent_container = true` is claimable only by a worker with the `docker`
 * capability, the same filter §7.3 applies to runtimes. Covers the §6.3
 * claim (`selectClaimCandidate`) and the §6.5 retry starter
 * (`selectRetryCandidate`).
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

async function insertRepository(
  name: string,
  values: { agentContainer: boolean; requiredCapability?: string },
): Promise<string> {
  const [row] = await h.db
    .insert(schema.repositories)
    .values({
      projectId: fx.projectId,
      name,
      gitUrl: `git@example.com:goopter/${name}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
      ...values,
    })
    .returning({ id: schema.repositories.id });
  return row!.id;
}

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "CCL");
  hostRepoId = fx.repositoryId;
  containerRepoId = await insertRepository("ccl-container", {
    agentContainer: true,
  });
  workers.plain = await insertWorker("host-plain", []);
  workers.docker = await insertWorker("host-docker", ["docker"]);
  workers.odoo = await insertWorker("host-odoo", ["odoo"]);
  workers.dockerOdoo = await insertWorker("host-docker-odoo", [
    "odoo",
    "docker",
  ]);
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

beforeEach(async () => {
  // Each case sees only the tasks it seeds.
  await h.db.execute(sql`truncate table tasks cascade`);
});

async function seedReadyTask(
  repositoryId: string,
  priority = 3,
): Promise<string> {
  return seedTask(h.db, { ...fx, repositoryId }, {
    jiraKey: `CCL-${++seq}`,
    state: "READY",
    priority,
  });
}

function claim(
  worker: { id: string; host: string },
  runtimes: ("claude" | "codex")[] = ["claude"],
) {
  return h.db.transaction(async (tx) => {
    const row = await selectClaimCandidate(tx, {
      workerId: worker.id,
      host: worker.host,
      runtimes,
    });
    return row?.taskId ?? null;
  });
}

/** A QUEUED retry row (host null) whose `not_before` has passed. */
async function seedQueuedRetry(
  repositoryId: string,
  createdAt: Date,
): Promise<{ taskId: string; executionId: string }> {
  const taskId = await seedTask(h.db, { ...fx, repositoryId }, {
    jiraKey: `CCL-${++seq}`,
    state: "IMPLEMENTING",
  });
  const [execution] = await h.db
    .insert(schema.executions)
    .values({
      taskId,
      role: "implementation",
      attempt: 2,
      state: "QUEUED",
      runtime: "claude",
      model: "claude-sonnet-5",
      createdAt,
    })
    .returning({ id: schema.executions.id });
  await h.db.insert(schema.executionEvents).values({
    taskId,
    executionId: execution!.id,
    type: "execution.queued",
    payload: { not_before: "2026-01-01T00:00:00.000Z" },
  });
  return { taskId, executionId: execution!.id };
}

function startRetry(worker: { id: string; host: string }) {
  return h.db.transaction(async (tx) => {
    const row = await selectRetryCandidate(tx, {
      workerId: worker.id,
      host: worker.host,
      runtimes: ["claude"],
      now: new Date("2026-06-01T00:00:00Z"),
    });
    return row?.executionId ?? null;
  });
}

describe("selectClaimCandidate: agent_container (§9.9 Scheduling)", () => {
  it("does not give a container-mode task to a worker without docker", async () => {
    await seedReadyTask(containerRepoId);
    expect(await claim(workers.plain!)).toBeNull();
  });

  it("gives a container-mode task to a worker with docker", async () => {
    const taskId = await seedReadyTask(containerRepoId);
    expect(await claim(workers.docker!)).toBe(taskId);
  });

  it("gives a host-mode task to a worker without docker", async () => {
    const taskId = await seedReadyTask(hostRepoId);
    expect(await claim(workers.plain!)).toBe(taskId);
  });

  it("gives a host-mode task to a worker with docker", async () => {
    const taskId = await seedReadyTask(hostRepoId);
    expect(await claim(workers.docker!)).toBe(taskId);
  });

  it("a worker without docker skips a more urgent container-mode task and claims the next host-mode task", async () => {
    const containerTask = await seedReadyTask(containerRepoId, 1);
    const hostTask = await seedReadyTask(hostRepoId, 3);
    expect(await claim(workers.plain!)).toBe(hostTask);
    expect(await claim(workers.docker!)).toBe(containerTask);
  });

  it("keeps the runtime filter for a docker worker on a container-mode task", async () => {
    await seedReadyTask(containerRepoId);
    expect(await claim(workers.docker!, ["codex"])).toBeNull();
  });

  it("requires both docker and required_capability on a container-mode repository", async () => {
    const repo = await insertRepository(`ccl-odoo-ctr-${++seq}`, {
      agentContainer: true,
      requiredCapability: "odoo",
    });
    const taskId = await seedReadyTask(repo);
    expect(await claim(workers.docker!)).toBeNull();
    expect(await claim(workers.odoo!)).toBeNull();
    expect(await claim(workers.dockerOdoo!)).toBe(taskId);
  });
});

describe("selectRetryCandidate: agent_container (§9.9 Scheduling)", () => {
  it("does not start a container-mode retry on a worker without docker", async () => {
    await seedQueuedRetry(containerRepoId, new Date("2026-02-01T00:00:00Z"));
    expect(await startRetry(workers.plain!)).toBeNull();
  });

  it("starts a container-mode retry on a worker with docker", async () => {
    const { executionId } = await seedQueuedRetry(
      containerRepoId,
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(await startRetry(workers.docker!)).toBe(executionId);
  });

  it("starts a host-mode retry on a worker without docker", async () => {
    const { executionId } = await seedQueuedRetry(
      hostRepoId,
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(await startRetry(workers.plain!)).toBe(executionId);
  });

  it("starts a host-mode retry on a worker with docker", async () => {
    const { executionId } = await seedQueuedRetry(
      hostRepoId,
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(await startRetry(workers.docker!)).toBe(executionId);
  });

  it("a worker without docker skips an older container-mode retry and starts the next host-mode retry", async () => {
    const older = await seedQueuedRetry(
      containerRepoId,
      new Date("2026-02-01T00:00:00Z"),
    );
    const newer = await seedQueuedRetry(
      hostRepoId,
      new Date("2026-02-02T00:00:00Z"),
    );
    expect(await startRetry(workers.plain!)).toBe(newer.executionId);
    expect(await startRetry(workers.docker!)).toBe(older.executionId);
  });

  it("requires both docker and required_capability on a container-mode repository", async () => {
    const repo = await insertRepository(`ccl-odoo-ctr-${++seq}`, {
      agentContainer: true,
      requiredCapability: "odoo",
    });
    const { executionId } = await seedQueuedRetry(
      repo,
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(await startRetry(workers.docker!)).toBeNull();
    expect(await startRetry(workers.odoo!)).toBeNull();
    expect(await startRetry(workers.dockerOdoo!)).toBe(executionId);
  });
});
