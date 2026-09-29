import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  ProcessSpawner,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import type { CommandType } from "@orchestra/core";
import {
  agentWorkers,
  executionCommands,
  executions,
  issues,
  projects,
  repositories,
  specificationRevisions,
  taskDecisions,
  taskLeases,
  tasks,
  transition,
  users,
  type Db,
} from "@orchestra/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionRegistry } from "../src/agent-tools/index.js";
import { loadConfig } from "../src/config.js";
import type {
  ContainerShellInput,
  ContainerShellResult,
  EnsureContainerInput,
} from "../src/containers/index.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  createCommandHandlers,
  createConsumeCommandsPhase,
  createIssueMessageHandler,
  createRunner,
  registerIssueHandlers,
  registerSpecHandlers,
  type CommandHandlers,
  type Runner,
  type RunnerContainerOps,
  type RunnerDeps,
} from "../src/runner/index.js";
import type { TickContext } from "../src/tick.js";
import { startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * design.md §9.9 Scheduling on the command paths (C4b): a container-mode
 * repository's agent session is placed only on a worker with the `docker`
 * capability. Covers `start_spec_session` and the fresh-session fallback
 * (C21) that pins an implementation execution released from a dead host.
 * A worker without docker leaves the command unclaimed for a docker worker,
 * instead of taking it and failing the execution.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const PLAIN_HOST = "routing-plain";
const DOCKER_HOST = "routing-docker";
const NOW = new Date("2026-09-25T10:00:00.000Z");

const SPEC = {
  repository: "repo",
  objective: "Make receipts print in the device language",
  scope: ["receipt printer"],
  out_of_scope: ["email receipts"],
  requirements: ["use device locale"],
  acceptance_criteria: ["receipt uses locale"],
  validation: ["unit test"],
  constraints: ["no new deps"],
  dependencies: [],
};

let testDb: TestDb;
let db: Db;
let workRoot: string;
let plainWorkerId: string;
let dockerWorkerId: string;
let userId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "c4b-routing-")));
});

afterAll(async () => {
  await testDb?.stop();
  if (workRoot) await fs.rm(workRoot, { recursive: true, force: true });
});

const runners: Runner[] = [];

beforeEach(async () => {
  records.length = 0;
  await db.$client.unsafe(
    "truncate table projects, agent_workers, users, audit_events restart identity cascade",
  );
  const [plain] = await db
    .insert(agentWorkers)
    .values({ host: PLAIN_HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: workRoot })
    .returning({ id: agentWorkers.id });
  const [docker] = await db
    .insert(agentWorkers)
    .values({ host: DOCKER_HOST, capabilities: ["docker"], maxConcurrent: 4, workspaceRoot: workRoot })
    .returning({ id: agentWorkers.id });
  plainWorkerId = plain!.id;
  dockerWorkerId = docker!.id;
  const [user] = await db
    .insert(users)
    .values({ email: "routing@example.com", passwordHash: "x", displayName: "Routing" })
    .returning({ id: users.id });
  userId = user!.id;
});

afterEach(async () => {
  while (runners.length > 0) await runners.pop()!.shutdown(2000);
});

// ---------------------------------------------------------------- seeding

let seq = 0;

async function seedProject(): Promise<{ projectId: string; n: number }> {
  const n = ++seq;
  const [project] = await db
    .insert(projects)
    .values({ key: `RTG${n}`, name: `routing ${n}`, jiraJql: `project = RTG${n}` })
    .returning({ id: projects.id });
  return { projectId: project!.id, n };
}

async function seedRepository(projectId: string, name: string, agentContainer: boolean): Promise<string> {
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId,
      name,
      gitUrl: `git@example.com:${name}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: "claude-opus-test",
      testCommand: "pnpm test",
      setupCommand: null,
      agentContainer,
    })
    .returning({ id: repositories.id });
  return repo!.id;
}

async function enqueue(
  taskId: string,
  executionId: string | null,
  type: CommandType,
  payload: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(executionCommands)
    .values({ taskId, executionId, type, payload, createdBy: userId, createdAt: new Date() })
    .returning({ id: executionCommands.id });
  return row!.id;
}

const command = async (id: string) =>
  (await db.query.executionCommands.findFirst({ where: (c, { eq }) => eq(c.id, id) }))!;
const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const executionsOf = (taskId: string) =>
  db.query.executions.findMany({ where: (e, { eq }) => eq(e.taskId, taskId) });
const eventTypes = async (taskId: string) =>
  (
    await db.query.executionEvents.findMany({
      where: (e, { eq }) => eq(e.taskId, taskId),
      orderBy: (e, { asc }) => [asc(e.id)],
    })
  ).map((e) => e.type);

function tickContext(host: string, workerId: string): TickContext {
  return {
    db,
    workerId,
    config: loadConfig({ DATABASE_URL: "postgres://localhost/unused", WORKER_HOST: host }),
    now: new Date(),
    tick: 1,
    logger,
  };
}

// ======================================================= start_spec_session

interface FakeSpecRunner extends Pick<Runner, "startSpec" | "resume" | "isLive"> {
  started: Array<{ executionId: string; taskId: string }>;
}

function fakeSpecRunner(): FakeSpecRunner {
  const started: FakeSpecRunner["started"] = [];
  return {
    started,
    startSpec: async (claim) => {
      started.push({ executionId: claim.executionId, taskId: claim.taskId });
    },
    resume: () => Promise.reject(new Error("not expected")),
    isLive: () => false,
  };
}

function specHandlers(runner: FakeSpecRunner): CommandHandlers {
  const handlers = createCommandHandlers();
  registerSpecHandlers(handlers, runner);
  return handlers;
}

async function consumeSpec(host: string, workerId: string, runner: FakeSpecRunner): Promise<void> {
  await createConsumeCommandsPhase(specHandlers(runner)).run(tickContext(host, workerId));
}

/** A SPEC_IN_PROGRESS task; its repository is `taskRepository` or none (C41). */
async function seedSpecTask(
  repos: Array<{ name: string; agentContainer: boolean }>,
  taskRepository: string | null,
): Promise<string> {
  const { projectId, n } = await seedProject();
  const ids: Record<string, string> = {};
  for (const r of repos) ids[r.name] = await seedRepository(projectId, `${r.name}-${n}`, r.agentContainer);
  const [task] = await db
    .insert(tasks)
    .values({
      projectId,
      repositoryId: taskRepository ? ids[taskRepository]! : null,
      jiraKey: `RTG-${n}`,
      jiraSummary: `Routing ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "SPEC_IN_PROGRESS",
    })
    .returning({ id: tasks.id });
  return task!.id;
}

describe("start_spec_session placement (§9.9 Scheduling)", () => {
  it("a worker without docker leaves a container-mode start unclaimed; a docker worker then takes it", async () => {
    const taskId = await seedSpecTask([{ name: "ctr", agentContainer: true }], "ctr");
    const id = await enqueue(taskId, null, "start_spec_session", {});

    const plain = fakeSpecRunner();
    await consumeSpec(PLAIN_HOST, plainWorkerId, plain);
    await consumeSpec(PLAIN_HOST, plainWorkerId, plain);
    let row = await command(id);
    expect(row.claimedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(await executionsOf(taskId)).toEqual([]);
    expect(plain.started).toEqual([]);

    const docker = fakeSpecRunner();
    await consumeSpec(DOCKER_HOST, dockerWorkerId, docker);
    row = await command(id);
    expect(row.completedAt).not.toBeNull();
    const [created] = await executionsOf(taskId);
    expect(created).toMatchObject({ role: "spec", state: "ASSIGNED", host: DOCKER_HOST, workerId: dockerWorkerId });
    expect(docker.started).toEqual([{ executionId: created!.id, taskId }]);
  });

  it("follows the project's first repository by name when the task has none (C41)", async () => {
    const taskId = await seedSpecTask(
      [
        { name: "b-host", agentContainer: false },
        { name: "a-ctr", agentContainer: true },
      ],
      null,
    );
    const id = await enqueue(taskId, null, "start_spec_session", {});
    await consumeSpec(PLAIN_HOST, plainWorkerId, fakeSpecRunner());
    expect((await command(id)).claimedAt).toBeNull();
    expect(await executionsOf(taskId)).toEqual([]);
  });

  it("a handler on a worker without docker that holds a container-mode start unclaims it without creating an execution", async () => {
    // As if the repository switched to container mode after the claim.
    const taskId = await seedSpecTask([{ name: "ctr", agentContainer: true }], "ctr");
    const id = await enqueue(taskId, null, "start_spec_session", {});
    await db.$client.unsafe("update execution_commands set claimed_at = now() where id = $1", [id]);
    const runner = fakeSpecRunner();

    const outcome = await specHandlers(runner).handlerFor("start_spec_session")!(await command(id), {
      db,
      workerId: plainWorkerId,
      host: PLAIN_HOST,
      now: new Date(),
      logger,
    });

    expect(outcome).toEqual({ outcome: "unclaimed" });
    const row = await command(id);
    expect(row.claimedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(await executionsOf(taskId)).toEqual([]);
    expect(runner.started).toEqual([]);
  });

  it("a worker without docker starts a host-mode spec session as before", async () => {
    const taskId = await seedSpecTask([{ name: "host", agentContainer: false }], "host");
    const id = await enqueue(taskId, null, "start_spec_session", {});
    const plain = fakeSpecRunner();
    await consumeSpec(PLAIN_HOST, plainWorkerId, plain);
    expect((await command(id)).completedAt).not.toBeNull();
    const [created] = await executionsOf(taskId);
    expect(created).toMatchObject({ state: "ASSIGNED", host: PLAIN_HOST, workerId: plainWorkerId });
    expect(plain.started).toHaveLength(1);
  });
});

// ============================================ fresh-session fallback (C21)

class FakeAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  script: (req: StartRequest | ResumeRequest) => AsyncGenerator<AgentEvent> = async function* () {
    yield { type: "turn_done", finalText: "" };
  };

  start(req: StartRequest): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    return this.script(req);
  }

  resume(req: ResumeRequest): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    return this.script(req);
  }

  async canResume(): Promise<boolean> {
    return true;
  }
}

class FakeContainers implements RunnerContainerOps {
  readonly ensures: EnsureContainerInput[] = [];

  agentHome(taskId: string): string {
    return path.join(workRoot, "agent-home", taskId);
  }

  async ensure(input: EnsureContainerInput) {
    this.ensures.push(input);
    return {
      name: `orchestra-exec-${input.executionId}`,
      executionId: input.executionId,
      taskId: input.taskId,
      worktreePath: input.worktreePath ?? path.join(workRoot, "work", input.executionId),
      home: this.agentHome(input.taskId),
      created: true,
    };
  }

  async remove(): Promise<void> {}

  async runShell(_input: ContainerShellInput): Promise<ContainerShellResult> {
    return { exitCode: 0, signal: null, tail: "", timedOut: false };
  }

  spawner(): ProcessSpawner {
    return () => {
      throw new Error("not expected");
    };
  }
}

interface Harness {
  runner: Runner;
  /** The host-mode adapter. */
  hostAdapter: FakeAdapter;
  /** The container-mode adapter (docker worker only). */
  containerAdapter: FakeAdapter;
  containers: FakeContainers;
}

function makeRunner(host: string, workerId: string, docker: boolean): Harness {
  const hostAdapter = new FakeAdapter();
  const containerAdapter = new FakeAdapter();
  const containers = new FakeContainers();
  const deps: RunnerDeps = {
    db,
    registry: createExecutionRegistry(),
    logger,
    workerId,
    host,
    worktrees: {
      prepareImplementation: async (input) => {
        const worktreePath = input.worktreePath!;
        await fs.mkdir(worktreePath, { recursive: true });
        return { worktreePath, branch: `agent/${input.task.jiraKey}-abcdef12`, startPoint: "remote_branch" };
      },
      prepareSpec: () => Promise.reject(new Error("not expected")),
      remove: async () => ({ branchDeleted: false }),
    },
    adapters: { claude: hostAdapter },
    toolsUrl: () => "http://127.0.0.1:4999/mcp",
    quietTimeoutMs: 10_000,
    basePath: "/usr/bin:/bin",
    timings: { leaseRenewMs: 60_000, blockingPollMs: 50 },
  };
  if (docker) {
    deps.containers = {
      manager: containers,
      toolsUrl: () => "http://host.docker.internal:4999/mcp",
      credentials: {},
      adapterFor: () => containerAdapter,
    };
  }
  const runner = createRunner(deps);
  runners.push(runner);
  return { runner, hostAdapter, containerAdapter, containers };
}

function issueHandlers(runner: Runner): CommandHandlers {
  const handlers = createCommandHandlers();
  registerSpecHandlers(handlers, runner, { issueSendMessage: createIssueMessageHandler(runner) });
  registerIssueHandlers(handlers, runner);
  return handlers;
}

async function consumeIssues(host: string, workerId: string, runner: Runner): Promise<void> {
  await createConsumeCommandsPhase(issueHandlers(runner)).run(tickContext(host, workerId));
}

interface Released {
  taskId: string;
  executionId: string;
  issueId: string;
  decisionId: string;
  worktreePath: string;
}

/**
 * An IMPLEMENTING task whose implementation execution the dead-host pass
 * released (host and worker null) while WAITING_FOR_USER on a blocking
 * issue, now resolved as a clarification.
 */
async function seedReleased(agentContainer: boolean): Promise<Released> {
  const { projectId, n } = await seedProject();
  const repositoryId = await seedRepository(projectId, `repo-${n}`, agentContainer);
  const jiraKey = `RTG-${n}`;
  const [task] = await db
    .insert(tasks)
    .values({
      projectId,
      repositoryId,
      jiraKey,
      jiraSummary: `Routing ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "IMPLEMENTING",
    })
    .returning({ id: tasks.id });
  const [revision] = await db
    .insert(specificationRevisions)
    .values({ taskId: task!.id, version: 1, status: "approved", content: SPEC })
    .returning({ id: specificationRevisions.id });
  await db.$client.unsafe("update tasks set approved_revision_id = $2 where id = $1", [task!.id, revision!.id]);
  const worktreePath = path.join(workRoot, "work", `exec-${n}`);
  await fs.mkdir(worktreePath, { recursive: true });
  const [row] = await db
    .insert(executions)
    .values({
      taskId: task!.id,
      role: "implementation",
      attempt: 1,
      state: "WAITING_FOR_USER",
      runtime: "claude",
      model: "default",
      specRevisionId: revision!.id,
      workerId: null,
      host: null,
      worktreePath,
      branch: `agent/${jiraKey}-abcdef12`,
      sessionId: `sess-${n}`,
      startedAt: NOW,
    })
    .returning({ id: executions.id });
  await db.insert(taskLeases).values({
    taskId: task!.id,
    executionId: row!.id,
    workerId: plainWorkerId,
    expiresAt: NOW,
  });
  const [issue] = await db
    .insert(issues)
    .values({
      taskId: task!.id,
      executionId: row!.id,
      type: "QUESTION",
      severity: "blocking",
      blocking: true,
      title: "Which language?",
      description: "Device or store language?",
      status: "RESOLVED",
      resolutionKind: "clarification",
      resolution: "Device.",
      resolvedBy: userId,
      resolvedAt: NOW,
    })
    .returning({ id: issues.id });
  const [decision] = await db
    .insert(taskDecisions)
    .values({ taskId: task!.id, issueId: issue!.id, decision: "Device.", decidedBy: userId })
    .returning({ id: taskDecisions.id });
  return {
    taskId: task!.id,
    executionId: row!.id,
    issueId: issue!.id,
    decisionId: decision!.id,
    worktreePath,
  };
}

async function completeExecution(executionId: string): Promise<void> {
  await db.transaction((tx) =>
    transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.completed",
      actor: { kind: "agent" },
      set: { endedAt: new Date() },
    }),
  );
}

async function turnEnded(runner: Runner, executionId: string): Promise<void> {
  await waitFor(async () => (runner.isLive(executionId) ? undefined : true), {
    what: "the resumed turn to end",
  });
}

describe("fresh-session fallback placement (C21, §9.9 Scheduling)", () => {
  it("a worker without docker leaves a released container-mode execution's command unclaimed and unpinned; a docker worker then pins it", async () => {
    const s = await seedReleased(true);
    const id = await enqueue(s.taskId, s.executionId, "resume_with_decision", {
      issue_id: s.issueId,
      decision_id: s.decisionId,
    });

    const plain = makeRunner(PLAIN_HOST, plainWorkerId, false);
    await consumeIssues(PLAIN_HOST, plainWorkerId, plain.runner);
    await consumeIssues(PLAIN_HOST, plainWorkerId, plain.runner);
    let cmd = await command(id);
    expect(cmd.claimedAt).toBeNull();
    expect(cmd.completedAt).toBeNull();
    let row = await execution(s.executionId);
    expect(row).toMatchObject({ state: "WAITING_FOR_USER", host: null, workerId: null, endReason: null });
    expect(plain.hostAdapter.starts).toHaveLength(0);
    expect(await eventTypes(s.taskId)).not.toContain("execution.failed");

    const docker = makeRunner(DOCKER_HOST, dockerWorkerId, true);
    docker.containerAdapter.script = async function* () {
      yield { type: "session", sessionId: "fresh-session" };
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "done" };
    };
    await consumeIssues(DOCKER_HOST, dockerWorkerId, docker.runner);
    cmd = await command(id);
    expect(cmd.completedAt).not.toBeNull();
    await turnEnded(docker.runner, s.executionId);
    row = await execution(s.executionId);
    expect(row).toMatchObject({ host: DOCKER_HOST, workerId: dockerWorkerId, sessionId: "fresh-session" });
    expect(docker.containerAdapter.starts).toHaveLength(1);
    expect(docker.hostAdapter.starts).toHaveLength(0);
    expect(docker.containers.ensures).toHaveLength(1);
  });

  it("a handler on a worker without docker that holds such a command refuses the pin and unclaims it", async () => {
    // As if the repository switched to container mode after the claim.
    const s = await seedReleased(true);
    const id = await enqueue(s.taskId, s.executionId, "send_message", {
      issue_id: s.issueId,
      text: "still there?",
    });
    await db.$client.unsafe("update issues set status = 'OPEN' where id = $1", [s.issueId]);
    await db.$client.unsafe("update execution_commands set claimed_at = now() where id = $1", [id]);
    const plain = makeRunner(PLAIN_HOST, plainWorkerId, false);

    const outcome = await issueHandlers(plain.runner).handlerFor("send_message")!(await command(id), {
      db,
      workerId: plainWorkerId,
      host: PLAIN_HOST,
      now: new Date(),
      logger,
    });

    expect(outcome).toEqual({ outcome: "unclaimed" });
    const cmd = await command(id);
    expect(cmd.claimedAt).toBeNull();
    expect(cmd.completedAt).toBeNull();
    const row = await execution(s.executionId);
    expect(row).toMatchObject({ state: "WAITING_FOR_USER", host: null, workerId: null, endReason: null });
    expect(plain.hostAdapter.starts).toHaveLength(0);
    expect(await eventTypes(s.taskId)).not.toContain("execution.failed");
  });

  it("a worker without docker pins a released host-mode execution and starts fresh as before", async () => {
    const s = await seedReleased(false);
    const id = await enqueue(s.taskId, s.executionId, "resume_with_decision", {
      issue_id: s.issueId,
      decision_id: s.decisionId,
    });
    const plain = makeRunner(PLAIN_HOST, plainWorkerId, false);
    plain.hostAdapter.script = async function* () {
      yield { type: "session", sessionId: "fresh-host" };
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    await consumeIssues(PLAIN_HOST, plainWorkerId, plain.runner);
    expect((await command(id)).completedAt).not.toBeNull();
    await turnEnded(plain.runner, s.executionId);

    const row = await execution(s.executionId);
    expect(row).toMatchObject({ host: PLAIN_HOST, workerId: plainWorkerId, sessionId: "fresh-host" });
    expect(plain.hostAdapter.starts).toHaveLength(1);
  });
});
