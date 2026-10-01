import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, AgentEvent, ResumeRequest, StartRequest } from "@orchestra/adapters";
import {
  agentWorkers,
  executions,
  hasPendingSpecSessionStart,
  insertExecutionCommand,
  lockTaskExecutionIds,
  lockTaskForSpec,
  projects,
  repositories,
  tasks,
  transition,
  type Db,
} from "@orchestra/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionRegistry } from "../src/agent-tools/index.js";
import { loadConfig } from "../src/config.js";
import {
  ContainerManager,
  withExecutionContainerLock,
  type DockerResult,
  type DockerRunner,
} from "../src/containers/index.js";
import { recordEnsure } from "../src/containers/guard.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  createCommandHandlers,
  createConsumeCommandsPhase,
  createRunner,
  registerSpecHandlers,
  type Runner,
} from "../src/runner/index.js";
import type { TickContext } from "../src/tick.js";
import { sleep, startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * GOT.99, design.md §9.9 Lifecycle: request-review completes a spec
 * execution in the database only. The worker removes that execution's
 * agent container on its next tick, and a send-back resume recreates it
 * with the same mounts (§9.9 Recreation). Real Postgres and the real
 * `ContainerManager` over a stateful fake docker runner.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "got99-host";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const OWNER = "0123456789abcdef0123456789abcdef";
const USER = { kind: "user" as const };

let testDb: TestDb;
let db: Db;
let workRoot: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "got99-spec-container-")));
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

// ------------------------------------------------------------ fake docker

const NOT_FOUND = (name: string): DockerResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `Error response from daemon: No such container: ${name}\n`,
});
const OK = (stdout = ""): DockerResult => ({ exitCode: 0, stdout, stderr: "" });
const RUNNING_STATE = '{"Status":"running","Running":true,"Paused":false,"Restarting":false}\n';

/**
 * A daemon holding containers by name. `run -d` creates one, `rm` deletes
 * one, `container inspect` reports it running or missing. `gate` blocks
 * the next call whose verb matches until released.
 */
class FakeDaemon {
  readonly containers = new Map<string, string[]>();
  readonly calls: string[][] = [];
  #gates: Array<{ verb: string; entered: () => void; released: Promise<void> }> = [];

  /** Blocks the next `verb` call. Resolves `entered` when it arrives. */
  gate(verb: "rm" | "run" | "container"): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    const enteredP = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    this.#gates.push({ verb, entered, released });
    return { entered: enteredP, release };
  }

  verbs(): string[] {
    return this.calls.map((c) => c[0]!);
  }

  runs(): string[][] {
    return this.calls.filter((c) => c[0] === "run");
  }

  readonly run: DockerRunner = async (args) => {
    this.calls.push([...args]);
    const i = this.#gates.findIndex((g) => g.verb === args[0]);
    if (i >= 0) {
      const [g] = this.#gates.splice(i, 1);
      g!.entered();
      await g!.released;
    }
    if (args[0] === "network") return OK("[]\n");
    if (args[0] === "container" && args[1] === "inspect") {
      const name = args.at(-1)!;
      return this.containers.has(name) ? OK(RUNNING_STATE) : NOT_FOUND(name);
    }
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1]!;
      this.containers.set(name, [...args]);
      return OK("abc123\n");
    }
    if (args[0] === "rm") {
      this.containers.delete(args.at(-1)!);
      return OK();
    }
    return OK();
  };
}

const mounts = (args: string[]): string[] =>
  args.flatMap((a, i) => (args[i - 1] === "--mount" ? [a] : []));

// ------------------------------------------------------------ fake agent

type Script = (signal: AbortSignal) => AsyncGenerator<AgentEvent>;

class ScriptedAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  onResume?: () => void;
  startScript: Script = async function* () {
    yield { type: "session", sessionId: "sess-spec" };
    yield { type: "turn_done", finalText: "draft proposed" };
  };
  resumeScript: Script = async function* () {
    yield { type: "turn_done", finalText: "revised" };
  };

  start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    return this.startScript(signal);
  }

  resume(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    this.onResume?.();
    return this.resumeScript(signal);
  }

  async canResume(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------- seeding

let seq = 0;

interface Seeded {
  workerId: string;
  taskId: string;
  executionId: string;
  repositoryName: string;
}

/** A container-mode SPEC_IN_PROGRESS task and its ASSIGNED spec execution pinned here. */
async function seedSpec(): Promise<Seeded> {
  const n = ++seq;
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: ["docker"], maxConcurrent: 4, workspaceRoot: workRoot })
    .returning({ id: agentWorkers.id });
  const [project] = await db
    .insert(projects)
    .values({ key: `GNN${n}`, name: `got99 ${n}`, jiraJql: `project = GNN${n}` })
    .returning({ id: projects.id });
  const repositoryName = `got99-repo-${n}`;
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: repositoryName,
      gitUrl: `git@example.com:${repositoryName}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
      defaultModel: "claude-opus-test",
      maxConcurrentWorktrees: 4,
      agentContainer: true,
      agentImage: "orchestra/agent-node:1",
    })
    .returning({ id: repositories.id });
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey: `GNN-${n}`,
      jiraSummary: `Spec container ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "SPEC_IN_PROGRESS",
    })
    .returning({ id: tasks.id });
  const [row] = await db
    .insert(executions)
    .values({
      taskId: task!.id,
      role: "spec",
      attempt: 1,
      state: "ASSIGNED",
      runtime: "claude",
      model: "claude-opus-test",
      workerId: worker!.id,
      host: HOST,
    })
    .returning({ id: executions.id });
  return { workerId: worker!.id, taskId: task!.id, executionId: row!.id, repositoryName };
}

const executionState = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!.state;

// -------------------------------------------- the api's writes (§12.3)

/** POST /spec/request-review's writes, in the route's order. */
async function requestReview(taskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockTaskForSpec(tx, taskId);
    expect(await hasPendingSpecSessionStart(tx, taskId)).toBe(false);
    await transition(tx, { entity: "task", id: taskId, trigger: "spec.review_requested", actor: USER });
    for (const id of await lockTaskExecutionIds(tx, taskId, "spec", ["RUNNING"])) {
      await transition(tx, {
        entity: "execution",
        id,
        trigger: "execution.completed",
        actor: USER,
        set: { endedAt: new Date(), toolsTokenHash: null },
      });
    }
  });
}

/** POST /spec/send-back's writes (C45). */
async function sendBack(taskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, { entity: "task", id: taskId, trigger: "spec.sent_back", actor: USER });
    const completed = await lockTaskExecutionIds(tx, taskId, "spec", ["COMPLETED"]);
    await insertExecutionCommand(tx, {
      taskId,
      executionId: completed[completed.length - 1]!,
      type: "send_message",
      payload: { text: "Please tighten the scope.", system: "sent_back" },
      createdBy: null,
      now: new Date(),
    });
  });
}

// ---------------------------------------------------------------- harness

interface Harness {
  runner: Runner;
  daemon: FakeDaemon;
  adapter: ScriptedAdapter;
  /** One worker tick's `consume_commands` phase, with the spec handlers. */
  tick(): Promise<void>;
}

function makeHarness(workerId: string): Harness {
  const daemon = new FakeDaemon();
  const adapter = new ScriptedAdapter();
  const manager = new ContainerManager({
    workspaceRoot: workRoot,
    image: "orchestra/agent:test",
    cpus: 1,
    memory: "1g",
    owner: OWNER,
    run: daemon.run,
    uid: 501,
    gid: 20,
  });
  const created = createRunner({
    db,
    registry: createExecutionRegistry(),
    logger,
    workerId,
    host: HOST,
    worktrees: {
      prepareImplementation: () => Promise.reject(new Error("not expected")),
      async prepareSpec(input) {
        const worktreePath = input.worktreePath ?? path.join(workRoot, "work", input.executionId);
        await fs.mkdir(worktreePath, { recursive: true });
        return { worktreePath, branch: null };
      },
      async remove() {
        return { branchDeleted: false };
      },
    },
    adapters: {},
    pricing: {},
    toolsUrl: () => "http://127.0.0.1:4999/mcp",
    quietTimeoutMs: 10_000,
    basePath: "/usr/bin:/bin",
    timings: { leaseRenewMs: 60_000, blockingPollMs: 50 },
    containers: {
      manager,
      toolsUrl: () => "http://host.docker.internal:4999/mcp",
      // No Claude credential: `ensure` writes no auth file, so no exec client.
      credentials: {},
      adapterFor: () => adapter,
    },
  });
  runner = created;
  const handlers = createCommandHandlers();
  registerSpecHandlers(handlers, created);
  const phase = createConsumeCommandsPhase(handlers);
  const tickContext = (): TickContext => ({
    db,
    workerId,
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/unused",
      WORKER_HOST: HOST,
      WORKER_WORKSPACE_ROOT: workRoot,
    }),
    now: new Date(),
    tick: 1,
    logger,
  });
  return { runner: created, daemon, adapter, tick: () => phase.run(tickContext()) };
}

const idle = (r: Runner, executionId: string) =>
  waitFor(async () => (r.isLive(executionId) ? undefined : true), { what: "the turn to end" });

/** A spec session whose first turn has ended: RUNNING between turns, container up. */
async function specBetweenTurns(): Promise<Seeded & Harness & { name: string }> {
  const s = await seedSpec();
  const h = makeHarness(s.workerId);
  await h.runner.startSpec({ executionId: s.executionId, taskId: s.taskId });
  const name = `orchestra-exec-${s.executionId}`;
  expect(await executionState(s.executionId)).toBe("RUNNING");
  expect(h.daemon.containers.has(name)).toBe(true);
  return { ...s, ...h, name };
}

// ------------------------------------------------------------------ tests

describe("spec container removal after request-review (GOT.99, §9.9 Lifecycle)", () => {
  it("AC1: a tick keeps the container between turns and removes it once the api completes the execution", async () => {
    const h = await specBetweenTurns();

    await h.tick();
    expect(h.daemon.containers.has(h.name)).toBe(true);
    expect(h.daemon.verbs()).not.toContain("rm");

    await requestReview(h.taskId);
    expect(await executionState(h.executionId)).toBe("COMPLETED");
    await h.tick();

    expect(h.daemon.containers.has(h.name)).toBe(false);
    expect(h.daemon.calls.filter((c) => c[0] === "rm")).toEqual([["rm", "-f", "-v", h.name]]);
    expect(records.some((r) => r.msg === "agent container removed, spec execution ended")).toBe(true);

    // Nothing left to do: a later tick calls docker no more.
    const calls = h.daemon.calls.length;
    await h.tick();
    expect(h.daemon.calls).toHaveLength(calls);
  });

  it("AC2: a send-back resume after the removal recreates the container with the same mounts and runs the turn", async () => {
    const h = await specBetweenTurns();
    await requestReview(h.taskId);
    await h.tick();
    expect(h.daemon.containers.has(h.name)).toBe(false);

    let runningAtTurn: boolean | undefined;
    h.adapter.onResume = () => {
      runningAtTurn = h.daemon.containers.has(h.name);
    };
    await sendBack(h.taskId);
    await h.tick();
    await idle(h.runner, h.executionId);

    expect(h.adapter.resumes).toHaveLength(1);
    expect(h.adapter.resumes[0]!.prompt).toContain("Please tighten the scope.");
    expect(runningAtTurn).toBe(true);
    expect(await executionState(h.executionId)).toBe("RUNNING");
    const [first, second] = h.daemon.runs();
    expect(second).toBeDefined();
    expect(mounts(second!)).toEqual(mounts(first!));
    expect(mounts(first!)).toHaveLength(3);
    expect(mounts(first!).filter((m) => m.endsWith(",readonly"))).toHaveLength(2);

    // RUNNING between turns again: the next tick keeps it.
    await h.tick();
    expect(h.daemon.containers.has(h.name)).toBe(true);
  });

  it("AC3: no removal while a send-back resume's ensure holds the container lock", async () => {
    const h = await specBetweenTurns();
    await requestReview(h.taskId);

    let runningAtTurn: boolean | undefined;
    h.adapter.onResume = () => {
      runningAtTurn = h.daemon.containers.has(h.name);
    };
    const inspect = h.daemon.gate("container");
    await sendBack(h.taskId);
    const { done } = await h.runner.resume({
      executionId: h.executionId,
      prompt: "sent back",
      usageKind: "resume",
      expectedState: "COMPLETED",
    });
    await inspect.entered;

    await h.tick();
    expect(h.daemon.verbs()).not.toContain("rm");
    inspect.release();
    await done;

    expect(h.daemon.verbs()).not.toContain("rm");
    expect(h.adapter.resumes).toHaveLength(1);
    expect(runningAtTurn).toBe(true);
    expect(h.daemon.containers.has(h.name)).toBe(true);
  });

  it("AC3: no removal while an ensure holds the container lock; an ensure since the decision keeps the container", async () => {
    const h = await specBetweenTurns();
    await requestReview(h.taskId);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    // Stands in for an ensure holding the lock.
    const ensure = withExecutionContainerLock(h.executionId, async () => {
      locked();
      await held;
    });
    await isLocked;

    // The tick reads the mark and the state, then waits for the lock.
    const tick = h.tick();
    await sleep(200);
    expect(h.daemon.verbs()).not.toContain("rm");
    // The ensure records its mark under the lock, after the tick's decision.
    recordEnsure(h.executionId);
    release();
    await ensure;
    await tick;

    expect(h.daemon.verbs()).not.toContain("rm");
    expect(h.daemon.containers.has(h.name)).toBe(true);

    // Still COMPLETED and nothing live: the next tick removes it.
    await h.tick();
    expect(h.daemon.containers.has(h.name)).toBe(false);
  });

  it("AC3: a resume racing an in-flight removal waits, then recreates; the turn never runs without its container", async () => {
    const h = await specBetweenTurns();
    await requestReview(h.taskId);

    const rm = h.daemon.gate("rm");
    const tick = h.tick();
    await rm.entered;

    let runningAtTurn: boolean | undefined;
    h.adapter.onResume = () => {
      runningAtTurn = h.daemon.containers.has(h.name);
    };
    // The send-back resume, as the send_message handler starts it.
    await sendBack(h.taskId);
    const { done } = await h.runner.resume({
      executionId: h.executionId,
      prompt: "sent back",
      usageKind: "resume",
      expectedState: "COMPLETED",
    });
    expect(await executionState(h.executionId)).toBe("RUNNING");
    await sleep(100);
    expect(h.adapter.resumes).toHaveLength(0);

    rm.release();
    await tick;
    await done;

    expect(h.adapter.resumes).toHaveLength(1);
    expect(runningAtTurn).toBe(true);
    const verbs = h.daemon.verbs();
    expect(verbs.lastIndexOf("run")).toBeGreaterThan(verbs.indexOf("rm"));
    expect(h.daemon.containers.has(h.name)).toBe(true);
  });

  it("AC3: a resume live before the removal takes the lock keeps the container", async () => {
    const h = await specBetweenTurns();
    await requestReview(h.taskId);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const other = withExecutionContainerLock(h.executionId, async () => {
      locked();
      await held;
    });
    await isLocked;
    const tick = h.tick();
    await sleep(100);

    await sendBack(h.taskId);
    const { done } = await h.runner.resume({
      executionId: h.executionId,
      prompt: "sent back",
      usageKind: "resume",
      expectedState: "COMPLETED",
    });
    release();
    await other;
    await tick;
    await done;

    expect(h.daemon.verbs()).not.toContain("rm");
    expect(h.adapter.resumes).toHaveLength(1);
    expect(h.daemon.containers.has(h.name)).toBe(true);
  });

  it("the consume phase runs tick hooks in order, with or without handlers; a throwing hook does not stop the next", async () => {
    const s = await seedSpec();
    const ran: string[] = [];
    const ctx: TickContext = {
      db,
      workerId: s.workerId,
      config: loadConfig({
        DATABASE_URL: "postgres://localhost/unused",
        WORKER_HOST: HOST,
        WORKER_WORKSPACE_ROOT: workRoot,
      }),
      now: new Date(),
      tick: 1,
      logger,
    };

    const empty = createCommandHandlers();
    empty.registerTickHook(async (hookCtx) => {
      ran.push(`empty:${hookCtx.host}`);
    });
    await createConsumeCommandsPhase(empty).run(ctx);

    const handlers = createCommandHandlers();
    registerSpecHandlers(handlers, makeHarness(s.workerId).runner);
    handlers.registerTickHook(async () => {
      ran.push("throws");
      throw new Error("hook broke");
    });
    handlers.registerTickHook(async () => {
      ran.push("after");
    });
    await createConsumeCommandsPhase(handlers).run(ctx);

    expect(ran).toEqual([`empty:${HOST}`, "throws", "after"]);
    expect(handlers.tickHooks()).toHaveLength(3);
    expect(
      records.some((r) => r.msg === "command tick hook failed" && r.fields.err === "hook broke"),
    ).toBe(true);
  });

  it("a request-review during a live turn is still removed by the run's own end, once", async () => {
    const s = await seedSpec();
    const h = makeHarness(s.workerId);
    h.adapter.startScript = async function* (signal) {
      yield { type: "session", sessionId: "sess-spec" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const run = h.runner.startSpec({ executionId: s.executionId, taskId: s.taskId });
    await waitFor(async () => (h.adapter.starts.length > 0 ? true : undefined));
    await requestReview(s.taskId);
    await run;
    await idle(h.runner, s.executionId);

    expect(h.daemon.containers.has(`orchestra-exec-${s.executionId}`)).toBe(false);
    await h.tick();
    expect(h.daemon.calls.filter((c) => c[0] === "rm")).toHaveLength(1);
  });
});
