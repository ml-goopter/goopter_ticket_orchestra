import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type {
  AgentAdapter,
  AgentEvent,
  AgentProcess,
  ProcessExit,
  ProcessSpawner,
  ProcessSpawnOptions,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import type { Runtime } from "@orchestra/core";
import {
  agentWorkers,
  executions,
  projects,
  repositories,
  specificationRevisions,
  tasks,
  transition,
  type Db,
  type ExecutionCommandRow,
} from "@orchestra/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionRegistry } from "../src/agent-tools/index.js";
import {
  DockerError,
  type ContainerShellInput,
  type ContainerShellResult,
  type EnsureContainerInput,
} from "../src/containers/index.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  CLAUDE_CONTAINER_COMMAND,
  claudeContainerSpawner,
  claudeSessionRoot,
  claimNextRetry,
  classifyFailure,
  codexSessionRoot,
  createCommandHandlers,
  createContainerAdapter,
  createRunner,
  registerCancelHandler,
  type ContainerAdapterOptions,
  type Runner,
  type RunnerContainerOps,
  type RunnerDeps,
} from "../src/runner/index.js";
import { claimNextTask } from "../src/scheduler/index.js";
import type { PrepareImplementationInput, PrepareSpecInput } from "../src/worktrees/index.js";
import { startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * design.md §9.9 (D20), C4: container mode in the runner, against a real
 * Postgres with fake container ops, a fake adapter factory and a fake
 * worktree manager. Real Docker is exercised in
 * `runner-container-docker.test.ts`.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "container-host";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const HOST_TOOLS_URL = "http://127.0.0.1:4999/mcp";
const CONTAINER_TOOLS_URL = "http://host.docker.internal:4999/mcp";
const SETUP_TIMEOUT_MS = 12_345;
const CREDENTIALS = {
  githubToken: "gh-token",
  claudeCodeOauthToken: "sk-ant-oat-token",
  anthropicApiKey: "sk-ant-api-key",
  openaiApiKey: "sk-openai-key",
};

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

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "c4-runner-container-")));
});

afterAll(async () => {
  await testDb?.stop();
  if (workRoot) await fs.rm(workRoot, { recursive: true, force: true });
});

let runner: Runner | undefined;

beforeEach(async () => {
  records.length = 0;
  await db.$client.unsafe(
    "truncate table projects, agent_workers, audit_events, users restart identity cascade",
  );
});

afterEach(async () => {
  await runner?.shutdown(2000);
  runner = undefined;
});

// ---------------------------------------------------------------- seeding

let seq = 0;

interface Seeded {
  workerId: string;
  taskId: string;
  executionId: string;
  repositoryId: string;
  repositoryName: string;
}

interface SeedOptions {
  runtime?: Runtime;
  agentContainer?: boolean;
  agentImage?: string | null;
  setupCommand?: string | null;
}

async function seedRepoTask(options: SeedOptions, taskState: "READY" | "SPEC_IN_PROGRESS") {
  const n = ++seq;
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: ["docker"], maxConcurrent: 4, workspaceRoot: workRoot })
    .onConflictDoNothing()
    .returning({ id: agentWorkers.id });
  const workerId =
    worker?.id ??
    (await db.query.agentWorkers.findFirst({ where: (w, { eq }) => eq(w.host, HOST) }))!.id;
  const [project] = await db
    .insert(projects)
    .values({ key: `CTR${n}`, name: `container ${n}`, jiraJql: `project = CTR${n}` })
    .returning({ id: projects.id });
  const repositoryName = `ctr-repo-${n}`;
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: repositoryName,
      gitUrl: `git@example.com:${repositoryName}.git`,
      defaultBranch: "main",
      defaultRuntime: options.runtime ?? "claude",
      defaultModel: "claude-opus-test",
      maxConcurrentWorktrees: 4,
      setupCommand: options.setupCommand === undefined ? "npm ci" : options.setupCommand,
      agentContainer: options.agentContainer ?? true,
      agentImage: options.agentImage === undefined ? "orchestra/agent-node:1" : options.agentImage,
    })
    .returning({ id: repositories.id });
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey: `CTR-${n}`,
      jiraSummary: `Container task ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: taskState,
    })
    .returning({ id: tasks.id });
  return { workerId, projectId: project!.id, repositoryId: repo!.id, repositoryName, taskId: task!.id };
}

async function seedClaimed(options: SeedOptions = {}): Promise<Seeded> {
  const base = await seedRepoTask(options, "READY");
  const [revision] = await db
    .insert(specificationRevisions)
    .values({ taskId: base.taskId, version: 2, status: "approved", content: SPEC })
    .returning({ id: specificationRevisions.id });
  await db.$client.unsafe("update tasks set approved_revision_id = $1 where id = $2", [
    revision!.id,
    base.taskId,
  ]);
  const claim = await claimNextTask({
    db,
    workerId: base.workerId,
    runtimes: [options.runtime ?? "claude"],
    now: new Date(),
  });
  if (!claim) throw new Error("claim returned nothing");
  return { ...base, executionId: claim.executionId };
}

/** An ASSIGNED spec execution pinned here, as `start_spec_session` leaves it. */
async function seedSpec(options: SeedOptions = {}): Promise<Seeded> {
  const base = await seedRepoTask(options, "SPEC_IN_PROGRESS");
  const [row] = await db
    .insert(executions)
    .values({
      taskId: base.taskId,
      role: "spec",
      attempt: 1,
      state: "ASSIGNED",
      runtime: options.runtime ?? "claude",
      model: "claude-opus-test",
      workerId: base.workerId,
      host: HOST,
    })
    .returning({ id: executions.id });
  return { ...base, executionId: row!.id };
}

// ------------------------------------------------------------------ reads

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const eventTypes = async (executionId: string) =>
  (
    await db.query.executionEvents.findMany({
      where: (e, { eq }) => eq(e.executionId, executionId),
      orderBy: (e, { asc }) => [asc(e.id)],
    })
  ).map((e) => e.type);

async function completeViaTool(executionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.completed",
      actor: { kind: "agent", id: executionId },
      set: { endedAt: new Date() },
    });
  });
}

/**
 * FAILED as the agent's own `report_failed` leaves it (`agent_gave_up`, §8),
 * or as the lease sweeper does (`lease_expired`, §6.4).
 */
async function failExecution(
  executionId: string,
  endReason: "agent_gave_up" | "lease_expired",
): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.failed",
      actor:
        endReason === "agent_gave_up"
          ? { kind: "agent", id: executionId }
          : { kind: "worker", id: "sweeper" },
      set: { endReason, endDetail: "test", endedAt: new Date() },
    });
  });
}

async function cancelViaApi(taskId: string, executionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, { entity: "task", id: taskId, trigger: "task.cancelled", actor: { kind: "user" } });
    await transition(tx, {
      entity: "execution",
      id: executionId,
      trigger: "execution.cancelled",
      actor: { kind: "user" },
    });
  });
}

/** What a blocking `raise_issue` leaves on the live entry (§8). */
function raiseBlocking(h: Harness, executionId: string): void {
  h.registry.get(executionId)!.blockingPending = true;
}

const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

// ------------------------------------------------------------------ fakes

/** One ordered log across the worktree manager, container ops and adapter. */
let order: string[] = [];

interface FakeProcessControl {
  proc: AgentProcess;
  finish(exit: ProcessExit | Error): void;
  /** Signals `proc.kill` received, in order. */
  kills: string[];
}

function fakeProcess(): FakeProcessControl {
  let resolveExit!: (exit: ProcessExit) => void;
  let rejectExit!: (err: Error) => void;
  const exit = new Promise<ProcessExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  exit.catch(() => {});
  const kills: string[] = [];
  const proc: AgentProcess = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exit,
    kill: (signal = "SIGKILL") => void kills.push(signal),
  };
  return {
    kills,
    proc,
    finish(result) {
      if (result instanceof Error) rejectExit(result);
      else resolveExit(result);
    },
  };
}

class FakeContainers implements RunnerContainerOps {
  readonly ensures: EnsureContainerInput[] = [];
  readonly removes: string[] = [];
  readonly shells: ContainerShellInput[] = [];
  readonly spawnerFor: string[] = [];
  readonly spawns: Array<{ container: string; command: string; args: readonly string[]; options: ProcessSpawnOptions }> = [];
  ensureError?: Error;
  shellError?: Error;
  shellResult: ContainerShellResult = { exitCode: 0, signal: null, tail: "", timedOut: false };
  onEnsure?: (input: EnsureContainerInput) => Promise<void>;
  onRemove?: (executionId: string) => Promise<void>;
  /** What the next spawned process does. */
  nextProcess: () => FakeProcessControl = () => {
    const control = fakeProcess();
    control.finish({ code: 0, signal: null });
    return control;
  };

  agentHome(taskId: string): string {
    return path.join(workRoot, "agent-home", taskId);
  }

  async ensure(input: EnsureContainerInput) {
    order.push("ensure");
    this.ensures.push(input);
    await this.onEnsure?.(input);
    if (this.ensureError) throw this.ensureError;
    return {
      name: `orchestra-exec-${input.executionId}`,
      executionId: input.executionId,
      taskId: input.taskId,
      worktreePath: input.worktreePath ?? path.join(workRoot, "work", input.executionId),
      home: this.agentHome(input.taskId),
      created: true,
    };
  }

  async remove(executionId: string): Promise<void> {
    order.push("remove");
    this.removes.push(executionId);
    await this.onRemove?.(executionId);
  }

  async runShell(input: ContainerShellInput): Promise<ContainerShellResult> {
    order.push("setup");
    this.shells.push(input);
    if (this.shellError) throw this.shellError;
    return this.shellResult;
  }

  spawner(container: string): ProcessSpawner {
    this.spawnerFor.push(container);
    return (command, args, options) => {
      this.spawns.push({ container, command, args, options });
      return this.nextProcess().proc;
    };
  }
}

interface ScriptApi {
  token: string;
  signal: AbortSignal;
  executionId: string;
  spawn: ProcessSpawner | undefined;
}

type Script = (api: ScriptApi) => AsyncGenerator<AgentEvent>;

class FakeAdapter implements AgentAdapter {
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  readonly canResumeCalls: Array<{ sessionId: string; cwd: string }> = [];
  canResumeResult = true;
  script: Script = async function* () {};
  /** Set by the container adapter factory. */
  spawn: ProcessSpawner | undefined;
  home: string | undefined;

  constructor(readonly runtime: Runtime) {}

  start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    order.push("adapter.start");
    this.starts.push(req);
    return this.script({ token: req.mcp.token, signal, executionId: path.basename(req.cwd), spawn: this.spawn });
  }

  resume(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    order.push("adapter.resume");
    this.resumes.push(req);
    return this.script({ token: req.mcp.token, signal, executionId: path.basename(req.cwd), spawn: this.spawn });
  }

  async canResume(sessionId: string, cwd: string): Promise<boolean> {
    this.canResumeCalls.push({ sessionId, cwd });
    return this.canResumeResult;
  }
}

interface Harness {
  containers: FakeContainers;
  /** The host-mode adapter. */
  hostAdapter: FakeAdapter;
  /** The container-mode adapter the factory hands out, one per runtime. */
  adapter: FakeAdapter;
  made: Array<{ runtime: Runtime; home: string }>;
  registry: ReturnType<typeof createExecutionRegistry>;
  prepared: PrepareImplementationInput[];
  specPrepared: PrepareSpecInput[];
  runner: Runner;
}

function makeRunner(options: {
  workerId: string;
  runtime?: Runtime;
  withoutDocker?: boolean;
  credentials?: Partial<typeof CREDENTIALS>;
  timings?: RunnerDeps["timings"];
  quietTimeoutMs?: number;
}): Harness {
  const registry = createExecutionRegistry();
  const prepared: PrepareImplementationInput[] = [];
  const specPrepared: PrepareSpecInput[] = [];
  const containers = new FakeContainers();
  const hostAdapter = new FakeAdapter(options.runtime ?? "claude");
  const adapter = new FakeAdapter(options.runtime ?? "claude");
  const made: Array<{ runtime: Runtime; home: string }> = [];
  const deps: RunnerDeps = {
    db,
    registry,
    logger,
    workerId: options.workerId,
    host: HOST,
    worktrees: {
      async prepareImplementation(input) {
        order.push("prepare");
        prepared.push(input);
        const worktreePath = input.worktreePath ?? path.join(workRoot, "work", input.executionId);
        await fs.mkdir(worktreePath, { recursive: true });
        return { worktreePath, branch: `agent/${input.task.jiraKey}-abcdef12`, startPoint: "remote_branch" };
      },
      async prepareSpec(input) {
        order.push("prepare");
        specPrepared.push(input);
        const worktreePath = input.worktreePath ?? path.join(workRoot, "work", input.executionId);
        await fs.mkdir(worktreePath, { recursive: true });
        return { worktreePath, branch: null };
      },
      async remove() {
        return { branchDeleted: false };
      },
    },
    adapters: { [options.runtime ?? "claude"]: hostAdapter },
    pricing: {},
    toolsUrl: () => HOST_TOOLS_URL,
    githubToken: "gh-token",
    quietTimeoutMs: options.quietTimeoutMs ?? 10_000,
    basePath: "/usr/bin:/bin",
    timings: options.timings ?? { leaseRenewMs: 100, blockingGraceMs: 400, blockingPollMs: 50 },
  };
  if (!options.withoutDocker) {
    deps.containers = {
      manager: containers,
      toolsUrl: () => CONTAINER_TOOLS_URL,
      credentials: { ...CREDENTIALS, ...options.credentials },
      setupTimeoutMs: SETUP_TIMEOUT_MS,
      adapterFor(runtime: Runtime, adapterOptions: ContainerAdapterOptions) {
        made.push({ runtime, home: adapterOptions.home });
        adapter.spawn = adapterOptions.spawn;
        adapter.home = adapterOptions.home;
        return adapter;
      },
    };
  }
  const created = createRunner(deps);
  runner = created;
  order = [];
  return { containers, hostAdapter, adapter, made, registry, prepared, specPrepared, runner: created };
}

const finishTurn: Script = async function* ({ executionId }) {
  yield { type: "session", sessionId: `sess-${executionId}` };
  await completeViaTool(executionId);
  yield { type: "turn_done", finalText: "PR opened" };
};

// ------------------------------------------------------------------ tests

describe("mode selection (§9.9, D20)", () => {
  it("a repository with agent_container = false runs on the host and never touches the container ops", async () => {
    const s = await seedClaimed({ agentContainer: false });
    const h = makeRunner({ workerId: s.workerId });
    h.hostAdapter.script = finishTurn;

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect((await execution(s.executionId)).state).toBe("COMPLETED");
    expect(h.containers.ensures).toHaveLength(0);
    expect(h.containers.removes).toHaveLength(0);
    expect(h.containers.shells).toHaveLength(0);
    expect(h.containers.spawnerFor).toHaveLength(0);
    expect(h.made).toHaveLength(0);
    expect(h.adapter.starts).toHaveLength(0);
    // Host mode as before: setup runs in preparation, host URL and PATH.
    expect(h.prepared[0]!.repository.setupCommand).toBe("npm ci");
    const req = h.hostAdapter.starts[0]!;
    expect(req.mcp.url).toBe(HOST_TOOLS_URL);
    expect(req.env.ORCHESTRA_URL).toBe(HOST_TOOLS_URL);
    expect(req.env.PATH).toContain("review-wrapper");
  });

  it("a repository with agent_container = true runs every agent process through the container", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = finishTurn;

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect((await execution(s.executionId)).state).toBe("COMPLETED");
    expect(h.hostAdapter.starts).toHaveLength(0);
    expect(h.adapter.starts).toHaveLength(1);
    expect(h.containers.spawnerFor).toEqual([`orchestra-exec-${s.executionId}`]);
    expect(h.made).toEqual([{ runtime: "claude", home: path.join(workRoot, "agent-home", s.taskId) }]);
  });
});

describe("lifecycle (§9.9 Lifecycle)", () => {
  it("ensures after worktree preparation and before the first turn, runs setup in the container, removes on COMPLETED", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    let preparedAtEnsure = false;
    h.containers.onEnsure = async () => {
      preparedAtEnsure = (await eventTypes(s.executionId)).includes("worktree.prepared");
    };
    h.adapter.script = finishTurn;

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect(order).toEqual(["prepare", "ensure", "setup", "adapter.start", "remove"]);
    expect(preparedAtEnsure).toBe(true);
    // Setup never runs on the host in container mode.
    expect(h.prepared[0]!.repository.setupCommand).toBeNull();
    const row = await execution(s.executionId);
    const ensure = h.containers.ensures[0]!;
    expect(ensure).toMatchObject({
      executionId: s.executionId,
      taskId: s.taskId,
      repositoryName: s.repositoryName,
      role: "implementation",
      image: "orchestra/agent-node:1",
      worktreePath: row.worktreePath,
    });
    expect(h.containers.shells[0]).toEqual({
      container: `orchestra-exec-${s.executionId}`,
      cwd: row.worktreePath,
      command: "npm ci",
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("passes a null or empty agent_image as null, so the configured default applies", async () => {
    for (const agentImage of [null, "  "]) {
      const s = await seedClaimed({ agentImage });
      const h = makeRunner({ workerId: s.workerId });
      h.adapter.script = finishTurn;
      await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
      expect(h.containers.ensures[0]!.image).toBeNull();
      await h.runner.shutdown(2000);
    }
  });

  it("skips setup when the repository has none", async () => {
    const s = await seedClaimed({ setupCommand: null });
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = finishTurn;
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    expect(order).toEqual(["prepare", "ensure", "adapter.start", "remove"]);
  });

  it("a failed setup ends FAILED setup_failed with the output tail, starts no session, removes the container", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.containers.shellResult = { exitCode: 2, signal: null, tail: "npm ERR! in container", timedOut: false };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("setup_failed");
    expect(row.endDetail).toContain("setup command failed (exit 2)");
    expect(row.endDetail).toContain("npm ERR! in container");
    expect(h.adapter.starts).toHaveLength(0);
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("a setup that times out ends FAILED setup_failed naming the timeout", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.containers.shellResult = { exitCode: null, signal: "SIGKILL", tail: "still installing", timedOut: true };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.endReason).toBe("setup_failed");
    expect(row.endDetail).toContain(`timed out after ${SETUP_TIMEOUT_MS} ms`);
    expect(row.endDetail).toContain("still installing");
  });

  it("keeps the container while the execution waits for the user, and a resume ensures only after its state move", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      raiseBlocking(h, executionId);
      yield { type: "turn_done", finalText: "asked" };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    expect(h.containers.removes).toHaveLength(0);

    order = [];
    let stateAtEnsure: string | undefined;
    h.containers.onEnsure = async () => {
      stateAtEnsure = (await execution(s.executionId)).state;
    };
    h.adapter.script = finishTurn;
    const { done } = await h.runner.resume({ executionId: s.executionId, prompt: "answer" });
    await done;

    expect(stateAtEnsure).toBe("RUNNING");
    expect(order).toEqual(["ensure", "adapter.resume", "remove"]);
    // canResume looked at the container's session store (the factory's adapter).
    expect(h.adapter.canResumeCalls).toHaveLength(1);
    expect(h.hostAdapter.canResumeCalls).toHaveLength(0);
    expect(h.containers.ensures[1]!.worktreePath).toBe((await execution(s.executionId)).worktreePath);
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("a resume that recreates an evicted worktree runs setup in the container after the state move", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      raiseBlocking(h, executionId);
      yield { type: "turn_done", finalText: "asked" };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await db.$client.unsafe("update executions set worktree_evicted_at = now() where id = $1", [
      s.executionId,
    ]);

    order = [];
    let stateAtSetup: string | undefined;
    h.containers.onEnsure = async () => {
      stateAtSetup = (await execution(s.executionId)).state;
    };
    h.adapter.script = finishTurn;
    const { done } = await h.runner.resume({ executionId: s.executionId, prompt: "answer" });
    await done;

    expect(order).toEqual(["prepare", "ensure", "setup", "adapter.resume", "remove"]);
    expect(stateAtSetup).toBe("RUNNING");
    expect(h.prepared[1]!.repository.setupCommand).toBeNull();
    expect(h.containers.shells[1]!.command).toBe("npm ci");
  });

  it("removes the container when a cancel ends a live turn", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    const handlers = createCommandHandlers();
    registerCancelHandler(handlers, h.runner);
    h.adapter.script = async function* ({ signal, executionId }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      await aborted(signal);
    };
    const run = h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await waitFor(async () => ((await execution(s.executionId)).state === "RUNNING" ? true : undefined));
    await cancelViaApi(s.taskId, s.executionId);
    h.runner.abort(s.executionId);
    await run;

    expect((await execution(s.executionId)).state).toBe("CANCELLED");
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("a cancel command for a waiting execution on this host removes its container", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      raiseBlocking(h, executionId);
      yield { type: "turn_done", finalText: "asked" };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    expect(h.containers.removes).toHaveLength(0);

    await cancelViaApi(s.taskId, s.executionId);
    await h.runner.releaseContainer(s.executionId);
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("releaseContainer leaves a live-state execution's container alone", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      raiseBlocking(h, executionId);
      yield { type: "turn_done", finalText: "asked" };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await h.runner.releaseContainer(s.executionId);
    expect(h.containers.removes).toHaveLength(0);
  });

  it("the cancel handler releases the container when no session runs here", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      raiseBlocking(h, executionId);
      yield { type: "turn_done", finalText: "asked" };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await cancelViaApi(s.taskId, s.executionId);

    const handlers = createCommandHandlers();
    registerCancelHandler(handlers, h.runner);
    const handler = handlers.handlerFor("cancel")!;
    await handler({ id: "cmd-1", executionId: s.executionId } as ExecutionCommandRow, {
      db,
      workerId: s.workerId,
      host: HOST,
      now: new Date(),
      logger,
    });
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("a spec execution mounts read-only (role spec), runs no setup, and keeps its container between turns", async () => {
    const s = await seedSpec();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      yield { type: "turn_done", finalText: "draft proposed" };
    };

    await h.runner.startSpec({ executionId: s.executionId, taskId: s.taskId });

    expect((await execution(s.executionId)).state).toBe("RUNNING");
    expect(order).toEqual(["prepare", "ensure", "adapter.start"]);
    expect(h.containers.ensures[0]!.role).toBe("spec");
    expect(h.containers.shells).toHaveLength(0);
    expect(h.containers.removes).toHaveLength(0);
    expect(h.adapter.starts[0]!.allowedTools).toBe("spec");
  });

  it("a retry that took over another execution's worktree ensures with that recorded path (C33)", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "11111111-2222-4333-8444-555555555555" };
      void executionId;
      yield { type: "error", message: "overloaded", retriable: true };
    };
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    const failed = await execution(s.executionId);
    expect(failed.state).toBe("FAILED");
    const retry = await db.query.executions.findFirst({
      where: (e, { and, eq }) => and(eq(e.taskId, s.taskId), eq(e.state, "QUEUED")),
    });
    expect(retry).toBeDefined();
    // The retry starter's claim (C31): pins it here and takes the failed
    // attempt's worktree over.
    const claimed = await claimNextRetry({
      db,
      workerId: s.workerId,
      runtimes: ["claude"],
      now: new Date(Date.now() + 10 * 60_000),
    });
    expect(claimed?.executionId).toBe(retry!.id);
    expect((await execution(retry!.id)).worktreePath).toBe(failed.worktreePath);

    order = [];
    h.adapter.script = async function* ({ executionId }) {
      void executionId;
      await completeViaTool(retry!.id);
      yield { type: "turn_done", finalText: "done" };
    };
    await h.runner.start({ executionId: retry!.id, taskId: s.taskId }, { retry: claimed!.retry });

    expect(order).toEqual(["ensure", "adapter.resume", "remove"]);
    const ensure = h.containers.ensures.at(-1)!;
    expect(ensure.executionId).toBe(retry!.id);
    expect(ensure.worktreePath).toBe(failed.worktreePath);
    expect(ensure.worktreePath).not.toBe(path.join(workRoot, "work", retry!.id));
    expect(h.adapter.resumes[0]!.cwd).toBe(failed.worktreePath);
  });
});

describe("environment (§9.9 Environment)", () => {
  it("the container gets exactly ORCHESTRA_URL, GITHUB_TOKEN and the Claude OAuth token; each turn adds only ORCHESTRA_TOKEN", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.adapter.script = finishTurn;

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const env = h.containers.ensures[0]!.env;
    expect(env).toEqual({
      ORCHESTRA_URL: CONTAINER_TOOLS_URL,
      GITHUB_TOKEN: "gh-token",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-token",
    });
    for (const name of ["DATABASE_URL", "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HOME", "PATH"]) {
      expect(env).not.toHaveProperty(name);
    }
    const req = h.adapter.starts[0]!;
    expect(req.mcp.url).toBe(CONTAINER_TOOLS_URL);
    expect(Object.keys(req.env).sort()).toEqual(["ORCHESTRA_TOKEN", "ORCHESTRA_URL"]);
    expect(req.env.ORCHESTRA_URL).toBe(CONTAINER_TOOLS_URL);
    expect(req.env.ORCHESTRA_TOKEN).toBe(req.mcp.token);
    // orchestra-review comes from the image PATH, not the host wrapper bin.
    expect(req.env).not.toHaveProperty("PATH");
  });

  it("falls back to ANTHROPIC_API_KEY when no OAuth token is configured", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, credentials: { claudeCodeOauthToken: undefined } });
    h.adapter.script = finishTurn;
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    const env = h.containers.ensures[0]!.env;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-key");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("OPENAI_API_KEY enters only a Codex execution's container", async () => {
    const s = await seedClaimed({ runtime: "codex" });
    const h = makeRunner({ workerId: s.workerId, runtime: "codex" });
    h.adapter.script = finishTurn;
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    expect(h.containers.ensures[0]!.env.OPENAI_API_KEY).toBe("sk-openai-key");
    expect(h.made[0]!.runtime).toBe("codex");
  });
});

describe("failures (§9.5, §9.9 Scheduling)", () => {
  const retriableAdapterError = (row: { endReason: string | null; endDetail: string | null }) => {
    expect(row.endReason).toBe("adapter_error");
    expect(JSON.parse(row.endDetail!).retriable).toBe(true);
    expect(classifyFailure("adapter_error", row.endDetail)).toMatchObject({
      class: "infrastructure",
      action: "retry",
    });
  };

  it("an ensure DockerError removes the container first, then fails adapter_error retriable", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.containers.ensureError = new DockerError({
      reason: "failed",
      args: ["run", "-d"],
      exitCode: 125,
      stderr: "docker: Error response from daemon: invalid mount config",
    });
    let stateAtRemove: string | undefined;
    h.containers.onRemove = async () => {
      stateAtRemove ??= (await execution(s.executionId)).state;
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    retriableAdapterError(row);
    expect(row.endDetail).toContain("invalid mount config");
    expect(stateAtRemove).toBe("ASSIGNED");
    expect(h.containers.shells).toHaveLength(0);
    expect(h.adapter.starts).toHaveLength(0);
  });

  it("a DockerError from setup's docker exec fails adapter_error retriable", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.containers.shellError = new DockerError({
      reason: "unavailable",
      args: ["exec"],
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon",
    });
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    retriableAdapterError(row);
    expect(h.adapter.starts).toHaveLength(0);
  });

  it("a DockerError of a turn's process fails adapter_error retriable, not process_crash", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId });
    h.containers.nextProcess = () => {
      const control = fakeProcess();
      control.finish(
        new DockerError({
          reason: "unavailable",
          args: ["exec"],
          exitCode: 1,
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        }),
      );
      return control;
    };
    h.adapter.script = async function* ({ executionId, spawn }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      const proc = spawn!("claude", ["--print"], { cwd: "/tmp", env: {} });
      await proc.exit.catch(() => {});
      throw new Error("Claude Code process exited with code 1");
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    retriableAdapterError(row);
    expect(row.endDetail).toContain("Cannot connect to the Docker daemon");
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("a container-mode execution on a worker without docker fails adapter_error retriable and never runs on the host", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, withoutDocker: true });
    h.hostAdapter.script = finishTurn;

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    retriableAdapterError(row);
    expect(row.endDetail).toMatch(/docker/i);
    expect(h.prepared).toHaveLength(0);
    expect(h.hostAdapter.starts).toHaveLength(0);
  });

  it("a container-mode spec execution on a worker without docker fails the same way", async () => {
    const s = await seedSpec();
    const h = makeRunner({ workerId: s.workerId, withoutDocker: true });
    h.hostAdapter.script = finishTurn;

    await h.runner.startSpec({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    retriableAdapterError(row);
    expect(h.specPrepared).toHaveLength(0);
    expect(h.hostAdapter.starts).toHaveLength(0);
  });

  it("a container-mode resume on a worker without docker fails after the state move instead of running on the host", async () => {
    const s = await seedClaimed();
    const withDocker = makeRunner({ workerId: s.workerId });
    withDocker.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: `sess-${executionId}` };
      raiseBlocking(withDocker, executionId);
      yield { type: "turn_done", finalText: "asked" };
    };
    await withDocker.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await withDocker.runner.shutdown(2000);

    const h = makeRunner({ workerId: s.workerId, withoutDocker: true });
    h.hostAdapter.script = finishTurn;
    const { done } = await h.runner.resume({ executionId: s.executionId, prompt: "answer" });
    await done;

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    retriableAdapterError(row);
    expect(h.hostAdapter.resumes).toHaveLength(0);
    expect(h.hostAdapter.starts).toHaveLength(0);
  });
});

describe("container adapters (§9.9 Launching processes)", () => {
  it("the Claude spawner runs the image's claude CLI with the SDK's arguments", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const inner: ProcessSpawner = (command, args) => {
      calls.push({ command, args });
      return fakeProcess().proc;
    };
    claudeContainerSpawner(inner)(
      "/Users/me/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
      ["--output-format", "stream-json"],
      { cwd: "/w", env: {} },
    );
    expect(CLAUDE_CONTAINER_COMMAND).toBe("claude");
    expect(calls).toEqual([{ command: "claude", args: ["--output-format", "stream-json"] }]);
  });

  it.each([
    ["a JavaScript entry point run by node", "/usr/local/bin/node", ["/sdk/cli.js", "--output-format", "stream-json"]],
    ["an .mjs entry point run by node", "node", ["/sdk/cli.mjs", "--print"]],
    ["a binary that is not claude", "/sdk/bin/claude-code", ["--print"]],
  ])("the Claude spawner refuses %s instead of rewriting it (C4 F3)", (_label, command, args) => {
    const calls: string[] = [];
    const inner: ProcessSpawner = (c) => {
      calls.push(c);
      return fakeProcess().proc;
    };
    expect(() => claudeContainerSpawner(inner)(command, args, { cwd: "/w", env: {} })).toThrow(
      /unexpected Claude CLI launch/,
    );
    expect(calls).toEqual([]);
  });

  it("canResume reads the session stores under the agent home", async () => {
    const home = path.join(workRoot, "agent-home", "task-canresume");
    const cwd = path.join(workRoot, "work", "exec-canresume");
    const claudeSession = "0b7c2f4e-1111-4222-8333-444455556666";
    const codexThread = "0b7c2f4e-aaaa-4bbb-8ccc-ddddeeeeffff";
    expect(claudeSessionRoot(home)).toBe(path.join(home, ".claude", "projects"));
    expect(codexSessionRoot(home)).toBe(path.join(home, ".codex", "sessions"));
    const spawn: ProcessSpawner = () => fakeProcess().proc;
    const claude = createContainerAdapter("claude", { spawn, home });
    const codex = createContainerAdapter("codex", { spawn, home });
    expect(claude.runtime).toBe("claude");
    expect(codex.runtime).toBe("codex");
    expect(await claude.canResume(claudeSession, cwd)).toBe(false);
    expect(await codex.canResume(codexThread, cwd)).toBe(false);

    const claudeDir = path.join(claudeSessionRoot(home), cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, `${claudeSession}.jsonl`), "{}\n");
    const codexDir = path.join(codexSessionRoot(home), "2026", "09", "28");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(path.join(codexDir, `rollout-2026-09-28T10-00-00-${codexThread}.jsonl`), "{}\n");

    expect(await claude.canResume(claudeSession, cwd)).toBe(true);
    expect(await codex.canResume(codexThread, cwd)).toBe(true);
  });
});

describe("usage after report_pr_created (GOT.98, §9.7)", () => {
  /** A Claude `result` message's usage events: cost on the first model only. */
  const RESULT_USAGE: AgentEvent[] = [
    { type: "usage", model: "claude-haiku-4-5-20251001", input: 1200, cached: 300, output: 450, costUsd: 0.5374 },
    { type: "usage", model: "claude-sonnet-5", input: 10, cached: 0, output: 5 },
  ];

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * The CLI calls report_pr_created, then sends its closing text and the
   * `result` message `resultAfterMs` later (SCRUM-111: a lease renewal found
   * the execution COMPLETED 2.6 s after the call, before the result). In
   * container mode the CLI is a process started through the container
   * spawner, killed on abort as the SDK does.
   */
  function reportThenResult(
    resultAfterMs: number,
    tool: "report_pr_created" | "report_failed" = "report_pr_created",
  ): Script {
    return async function* ({ executionId, signal, spawn, token }) {
      if (spawn) {
        const proc = spawn(CLAUDE_CONTAINER_COMMAND, ["--print"], { cwd: "/w", env: { ORCHESTRA_TOKEN: token } });
        signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
      }
      yield { type: "session", sessionId: `sess-${executionId}` };
      yield { type: "tool_call", name: `mcp__orchestra__${tool}`, input: {} };
      if (tool === "report_failed") await failExecution(executionId, "agent_gave_up");
      else await completeViaTool(executionId);
      await Promise.race([sleep(resultAfterMs), aborted(signal)]);
      // An aborted SDK query ends the stream without its result.
      if (signal.aborted) return;
      yield { type: "text", delta: "PR opened" };
      for (const event of RESULT_USAGE) yield event;
      yield { type: "turn_done", finalText: "PR opened" };
    };
  }

  /** A container spawner whose processes run until killed. */
  function liveProcesses(h: Harness): FakeProcessControl[] {
    const processes: FakeProcessControl[] = [];
    h.containers.nextProcess = () => {
      const control = fakeProcess();
      processes.push(control);
      return control;
    };
    return processes;
  }

  async function usageOf(executionId: string) {
    const rows = await db.query.executionUsage.findMany({
      where: (u, { eq }) => eq(u.executionId, executionId),
      orderBy: (u, { asc }) => [asc(u.recordedAt), asc(u.model)],
    });
    const row = await execution(executionId);
    const types = await eventTypes(executionId);
    return {
      rows: rows.map((u) => ({
        kind: u.kind,
        model: u.model,
        input: u.inputTokens,
        cached: u.cachedInputTokens,
        output: u.outputTokens,
        cost: u.costUsd,
      })),
      costUsd: row.costUsd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      usageEvents: types.filter((t) => t === "usage.recorded").length,
      agentMessage: types.includes("agent.message"),
      state: row.state,
    };
  }

  it("a container run records the result's usage and cost as a host run does when a renewal finds the execution COMPLETED first", async () => {
    // Renewals every 50 ms: several land between report_pr_created and the result 300 ms later.
    const timings = { leaseRenewMs: 50, blockingGraceMs: 5_000, blockingPollMs: 50 };
    const recorded = [];
    let processes: FakeProcessControl[] = [];
    for (const agentContainer of [false, true]) {
      const s = await seedClaimed({ agentContainer });
      const h = makeRunner({ workerId: s.workerId, timings });
      if (agentContainer) processes = liveProcesses(h);
      const adapter = agentContainer ? h.adapter : h.hostAdapter;
      adapter.script = reportThenResult(300);

      await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

      recorded.push(await usageOf(s.executionId));
      if (agentContainer) {
        expect(h.containers.spawns).toHaveLength(1);
        expect(h.containers.removes).toEqual([s.executionId]);
      }
      await h.runner.shutdown(2000);
    }

    const [host, container] = recorded;
    expect(host!.rows).toHaveLength(2);
    expect(host!.costUsd).toBe("0.537400");
    expect(host!.usageEvents).toBe(2);
    expect(host!.agentMessage).toBe(true);
    expect(host!.state).toBe("COMPLETED");
    expect(container).toEqual(host);
    // The container's CLI was never killed before its result arrived.
    expect(processes).toHaveLength(1);
    expect(processes[0]!.kills).toEqual([]);
  });

  it("an agent still working after report_pr_created is stopped once the grace runs out, killing its container process", async () => {
    const s = await seedClaimed();
    const h = makeRunner({
      workerId: s.workerId,
      timings: { leaseRenewMs: 50, blockingGraceMs: 400, blockingPollMs: 50 },
    });
    const processes = liveProcesses(h);
    h.adapter.script = reportThenResult(60_000);

    const started = Date.now();
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    const elapsed = Date.now() - started;

    // Bounded by the grace (400 ms after a renewal saw COMPLETED), not the 10 s quiet timeout.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(5_000);
    expect(h.adapter.starts).toHaveLength(1);
    expect(processes[0]!.kills).toEqual(["SIGTERM"]);
    const row = await execution(s.executionId);
    expect(row.state).toBe("COMPLETED");
    expect(row.endReason).toBeNull();
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("a renewal that finds the execution CANCELLED still stops the container turn at once", async () => {
    const s = await seedClaimed();
    const h = makeRunner({
      workerId: s.workerId,
      timings: { leaseRenewMs: 50, blockingGraceMs: 60_000, blockingPollMs: 50 },
    });
    const processes = liveProcesses(h);
    h.adapter.script = async function* ({ executionId, signal, spawn }) {
      const proc = spawn!(CLAUDE_CONTAINER_COMMAND, ["--print"], { cwd: "/w", env: {} });
      signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
      yield { type: "session", sessionId: `sess-${executionId}` };
      await aborted(signal);
    };
    const run = h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    await waitFor(async () => ((await execution(s.executionId)).state === "RUNNING" ? true : undefined));

    const cancelled = Date.now();
    await cancelViaApi(s.taskId, s.executionId);
    await run;

    expect(Date.now() - cancelled).toBeLessThan(5_000);
    expect(processes[0]!.kills).toEqual(["SIGTERM"]);
    expect((await execution(s.executionId)).state).toBe("CANCELLED");
    expect(h.containers.removes).toEqual([s.executionId]);
  });

  it("the quiet timeout still stops a silent container turn and kills its process", async () => {
    const s = await seedClaimed();
    const h = makeRunner({
      workerId: s.workerId,
      quietTimeoutMs: 300,
      timings: { leaseRenewMs: 50, blockingGraceMs: 60_000, blockingPollMs: 50 },
    });
    const processes = liveProcesses(h);
    h.adapter.script = async function* ({ executionId, signal, spawn }) {
      const proc = spawn!(CLAUDE_CONTAINER_COMMAND, ["--print"], { cwd: "/w", env: {} });
      signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
      yield { type: "session", sessionId: `sess-${executionId}` };
      await aborted(signal);
    };

    const started = Date.now();
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(processes[0]!.kills).toEqual(["SIGTERM"]);
    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("agent_hung");
  });

  it("a turn that ended its execution with report_failed records the result's usage in host and container mode", async () => {
    const timings = { leaseRenewMs: 50, blockingGraceMs: 5_000, blockingPollMs: 50 };
    const recorded = [];
    let processes: FakeProcessControl[] = [];
    for (const agentContainer of [false, true]) {
      const s = await seedClaimed({ agentContainer });
      const h = makeRunner({ workerId: s.workerId, timings });
      if (agentContainer) processes = liveProcesses(h);
      const adapter = agentContainer ? h.adapter : h.hostAdapter;
      adapter.script = reportThenResult(300, "report_failed");

      await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

      recorded.push(await usageOf(s.executionId));
      expect((await execution(s.executionId)).endReason).toBe("agent_gave_up");
      if (agentContainer) expect(h.containers.removes).toEqual([s.executionId]);
      await h.runner.shutdown(2000);
    }

    const [host, container] = recorded;
    expect(host!.rows).toHaveLength(2);
    expect(host!.costUsd).toBe("0.537400");
    expect(host!.usageEvents).toBe(2);
    expect(host!.agentMessage).toBe(true);
    expect(host!.state).toBe("FAILED");
    expect(container).toEqual(host);
    expect(processes).toHaveLength(1);
    expect(processes[0]!.kills).toEqual([]);
  });

  it("an agent still working after report_failed is stopped once the grace runs out", async () => {
    const s = await seedClaimed();
    const h = makeRunner({
      workerId: s.workerId,
      timings: { leaseRenewMs: 50, blockingGraceMs: 400, blockingPollMs: 50 },
    });
    const processes = liveProcesses(h);
    h.adapter.script = reportThenResult(60_000, "report_failed");

    const started = Date.now();
    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(5_000);
    expect(processes[0]!.kills).toEqual(["SIGTERM"]);
    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("agent_gave_up");
  });

  it("a renewal that finds the execution FAILED with lease_expired stops the turn at once in host and container mode", async () => {
    for (const agentContainer of [false, true]) {
      const s = await seedClaimed({ agentContainer });
      const h = makeRunner({
        workerId: s.workerId,
        timings: { leaseRenewMs: 50, blockingGraceMs: 60_000, blockingPollMs: 50 },
      });
      const processes = liveProcesses(h);
      const adapter = agentContainer ? h.adapter : h.hostAdapter;
      adapter.script = async function* ({ executionId, signal, spawn }) {
        if (spawn) {
          const proc = spawn(CLAUDE_CONTAINER_COMMAND, ["--print"], { cwd: "/w", env: {} });
          signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
        }
        yield { type: "session", sessionId: `sess-${executionId}` };
        await aborted(signal);
      };
      const run = h.runner.start({ executionId: s.executionId, taskId: s.taskId });
      await waitFor(async () => ((await execution(s.executionId)).state === "RUNNING" ? true : undefined));

      const failed = Date.now();
      await failExecution(s.executionId, "lease_expired");
      await run;

      expect(Date.now() - failed).toBeLessThan(5_000);
      if (agentContainer) expect(processes[0]!.kills).toEqual(["SIGTERM"]);
      const row = await execution(s.executionId);
      expect(row.state).toBe("FAILED");
      expect(row.endReason).toBe("lease_expired");
      await h.runner.shutdown(2000);
    }
  });
});
