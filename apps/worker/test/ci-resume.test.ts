import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import type { ExecutionState } from "@orchestra/core";
import {
  agentWorkers,
  applyCiFailure,
  executionCommands,
  executions,
  projects,
  pullRequests,
  repositories,
  taskLeases,
  tasks,
  transition,
  unclaimCommand,
  type Db,
} from "@orchestra/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createExecutionRegistry } from "../src/agent-tools/index.js";
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  createCommandHandlers,
  createConsumeCommandsPhase,
  createRunner,
  registerCiFailureHandler,
  type CommandHandler,
  type Runner,
} from "../src/runner/index.js";
import type { TickContext } from "../src/tick.js";
import { startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * GOT.39: the §11.2 `ci.failed` side effects (`applyCiFailure`, C16) and the
 * `resume_with_ci_failure` command handler (§5.2, §9.2), against a real
 * Postgres with a fake adapter.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "ci-host-a";
const OTHER_HOST = "ci-host-b";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const WORKER = { kind: "worker" as const };

let testDb: TestDb;
let db: Db;
let workRoot: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "got39-ci-"));
});

afterAll(async () => {
  await testDb?.stop();
  await fs.rm(workRoot, { recursive: true, force: true });
});

const runners: Runner[] = [];

beforeEach(async () => {
  records.length = 0;
  await db.$client.unsafe(
    "truncate table projects, agent_workers, audit_events restart identity cascade",
  );
});

afterEach(async () => {
  while (runners.length > 0) await runners.pop()!.shutdown(2000);
});

// ---------------------------------------------------------------- seeding

let seq = 0;

interface Seeded {
  workerId: string;
  otherWorkerId: string;
  taskId: string;
  executionId: string;
  pullRequestId: string;
}

/**
 * A task in CI_RUNNING whose implementation execution is COMPLETED on
 * `HOST`, with a session, a worktree and an open PR: what
 * `report_pr_created` leaves behind.
 */
async function seedCiRunning(
  options: { maxCiRounds?: number; ciRounds?: number } = {},
): Promise<Seeded> {
  const n = ++seq;
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: workRoot })
    .returning({ id: agentWorkers.id });
  const [other] = await db
    .insert(agentWorkers)
    .values({ host: OTHER_HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: workRoot })
    .returning({ id: agentWorkers.id });
  const [project] = await db
    .insert(projects)
    .values({
      key: `CI${n}`,
      name: `ci ${n}`,
      jiraJql: `project = CI${n}`,
      ...(options.maxCiRounds === undefined ? {} : { maxCiRounds: options.maxCiRounds }),
    })
    .returning({ id: projects.id });
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: `ci-repo-${n}`,
      gitUrl: `git@example.com:ci-repo-${n}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
    })
    .returning({ id: repositories.id });
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey: `CI-${n}`,
      jiraSummary: `ci task ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "CI_RUNNING",
    })
    .returning({ id: tasks.id });
  const worktreePath = path.join(workRoot, `work-${n}`);
  await fs.mkdir(worktreePath, { recursive: true });
  const [execution] = await db
    .insert(executions)
    .values({
      taskId: task!.id,
      role: "implementation",
      attempt: 1,
      state: "COMPLETED",
      runtime: "claude",
      model: "default",
      workerId: worker!.id,
      host: HOST,
      worktreePath,
      branch: `agent/CI-${n}-abcdef12`,
      sessionId: `sess-${n}`,
      ciRounds: options.ciRounds ?? 0,
      endedAt: NOW,
    })
    .returning({ id: executions.id });
  await db.insert(taskLeases).values({
    taskId: task!.id,
    executionId: execution!.id,
    workerId: worker!.id,
    expiresAt: NOW,
  });
  const [pr] = await db
    .insert(pullRequests)
    .values({
      taskId: task!.id,
      executionId: execution!.id,
      number: 7,
      url: "https://github.com/goopter/repo/pull/7",
      headSha: "abc1234",
      state: "open",
      ciState: "pending",
      lastPolledAt: NOW,
    })
    .returning({ id: pullRequests.id });
  return {
    workerId: worker!.id,
    otherWorkerId: other!.id,
    taskId: task!.id,
    executionId: execution!.id,
    pullRequestId: pr!.id,
  };
}

const CHECKS = [
  { name: "unit", url: "https://ci.example.com/unit", log_excerpt: "FAIL receipt.test.ts\nexpected fr got en" },
  { name: "lint", url: "https://ci.example.com/lint", log_excerpt: "error no-unused-vars" },
];

async function failCi(s: Seeded, headSha = "abc1234") {
  return db.transaction((tx) =>
    applyCiFailure(tx, {
      taskId: s.taskId,
      executionId: s.executionId,
      pullRequestId: s.pullRequestId,
      headSha,
      checks: CHECKS,
      actor: WORKER,
      now: NOW,
    }),
  );
}

// ------------------------------------------------------------------ reads

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const task = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const commandsFor = (taskId: string) =>
  db.query.executionCommands.findMany({
    where: (c, { eq }) => eq(c.taskId, taskId),
    orderBy: (c, { asc }) => [asc(c.createdAt)],
  });
const eventsOf = async (taskId: string, type: string) =>
  (
    await db.query.executionEvents.findMany({
      where: (e, { eq }) => eq(e.taskId, taskId),
      orderBy: (e, { asc }) => [asc(e.id)],
    })
  ).filter((e) => e.type === type);

// ------------------------------------------------------------- fake agent

class FakeAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly resumes: ResumeRequest[] = [];
  onCanResume?: () => Promise<void>;
  script: (req: ResumeRequest) => AsyncGenerator<AgentEvent> = async function* () {};

  start(_req: StartRequest): AsyncIterable<AgentEvent> {
    throw new Error("start is not expected here");
  }

  resume(req: ResumeRequest): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    return this.script(req);
  }

  async canResume(): Promise<boolean> {
    await this.onCanResume?.();
    return true;
  }
}

function makeRunner(host: string, workerId: string, adapter: FakeAdapter): Runner {
  const runner = createRunner({
    db,
    registry: createExecutionRegistry(),
    logger,
    workerId,
    host,
    worktrees: {
      prepareImplementation: () => Promise.reject(new Error("not expected")),
      prepareSpec: () => Promise.reject(new Error("not expected")),
      remove: async () => ({ branchDeleted: false }),
    },
    adapters: { claude: adapter },
    toolsUrl: () => "http://127.0.0.1:4999/mcp",
    quietTimeoutMs: 10_000,
    basePath: "/usr/bin:/bin",
    timings: { leaseRenewMs: 60_000 },
  });
  runners.push(runner);
  return runner;
}

/** One consume_commands tick on `host` with only the CI handler registered. */
async function consume(host: string, workerId: string, runner: Runner): Promise<void> {
  const handlers = createCommandHandlers();
  registerCiFailureHandler(handlers, runner);
  const ctx: TickContext = {
    db,
    workerId,
    config: loadConfig({ DATABASE_URL: "postgres://localhost/unused", WORKER_HOST: host }),
    now: new Date(),
    tick: 1,
    logger,
  };
  await createConsumeCommandsPhase(handlers).run(ctx);
}

/** What a resumed agent's `report_pr_created` does to the execution. */
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

// ------------------------------------------------------------------ tests

describe("applyCiFailure (design.md §5.3, §11.2, C16)", () => {
  it("moves the task to IMPLEMENTING, increments ci_rounds, writes ci.failed and enqueues resume_with_ci_failure", async () => {
    const s = await seedCiRunning();

    const result = await failCi(s, "def5678");

    expect(result).toMatchObject({ round: 1, escalated: false });
    expect((await task(s.taskId)).state).toBe("IMPLEMENTING");
    const row = await execution(s.executionId);
    expect(row.ciRounds).toBe(1);
    // The execution is resumed by the command, not here.
    expect(row.state).toBe("COMPLETED");

    const failed = await eventsOf(s.taskId, "ci.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.executionId).toBe(s.executionId);
    expect(failed[0]!.payload).toEqual({
      pull_request_id: s.pullRequestId,
      head_sha: "def5678",
      round: 1,
      checks: [
        { name: "unit", url: "https://ci.example.com/unit" },
        { name: "lint", url: "https://ci.example.com/lint" },
      ],
    });

    const commands = await commandsFor(s.taskId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      executionId: s.executionId,
      type: "resume_with_ci_failure",
      claimedAt: null,
      completedAt: null,
    });
    expect(commands[0]!.payload).toEqual({
      pull_request_id: s.pullRequestId,
      head_sha: "def5678",
      round: 1,
      checks: CHECKS,
    });
    expect(result.commandId).toBe(commands[0]!.id);

    const [audit] = await db.$client.unsafe<{ trigger: string }[]>(
      "select trigger from audit_events where entity_id = $1 and to_state = 'IMPLEMENTING'",
      [s.taskId],
    );
    expect(audit!.trigger).toBe("ci.failed");
  });

  it("at the limit: escalates to NEEDS_HUMAN with the reason and enqueues nothing", async () => {
    const s = await seedCiRunning({ maxCiRounds: 3, ciRounds: 3 });

    const result = await failCi(s);

    expect(result).toMatchObject({ round: 4, escalated: true, commandId: null });
    const t = await task(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toBe("CI round limit exceeded: round 4 > max_ci_rounds 3");
    expect((await execution(s.executionId)).ciRounds).toBe(4);
    expect(await eventsOf(s.taskId, "ci.failed")).toHaveLength(1);
    expect(await commandsFor(s.taskId)).toEqual([]);
    const triggers = await db.$client.unsafe<{ trigger: string }[]>(
      "select trigger from audit_events where entity_id = $1 order by id",
      [s.taskId],
    );
    expect(triggers.map((a) => a.trigger)).toEqual(["ci.failed", "task.escalated"]);
  });

  it("the last round under the limit still enqueues the resume", async () => {
    const s = await seedCiRunning({ maxCiRounds: 3, ciRounds: 2 });

    const result = await failCi(s);

    expect(result).toMatchObject({ round: 3, escalated: false });
    expect((await task(s.taskId)).state).toBe("IMPLEMENTING");
    expect(await commandsFor(s.taskId)).toHaveLength(1);
  });

  it("refuses a task that is not CI_RUNNING and writes nothing", async () => {
    const s = await seedCiRunning();
    await db.$client.unsafe("update tasks set state = 'READY_FOR_MERGE' where id = $1", [s.taskId]);

    await expect(failCi(s)).rejects.toThrow();

    expect((await execution(s.executionId)).ciRounds).toBe(0);
    expect(await eventsOf(s.taskId, "ci.failed")).toEqual([]);
    expect(await commandsFor(s.taskId)).toEqual([]);
  });
});

describe("resume_with_ci_failure handler (design.md §5.2, §9.2, AC3)", () => {
  it("resumes the COMPLETED execution with the CI header prompt and completes the command", async () => {
    const s = await seedCiRunning({ maxCiRounds: 3 });
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);
    let during: ExecutionState | undefined;
    adapter.script = async function* () {
      during = (await execution(s.executionId)).state;
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "fixed" };
    };
    const longLog = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n");
    await db.transaction((tx) =>
      applyCiFailure(tx, {
        taskId: s.taskId,
        executionId: s.executionId,
        pullRequestId: s.pullRequestId,
        headSha: "def5678",
        checks: [...CHECKS, { name: "e2e", url: "https://ci.example.com/e2e", log_excerpt: longLog }],
        actor: WORKER,
        now: NOW,
      }),
    );

    await consume(HOST, s.workerId, runner);

    const [command] = await commandsFor(s.taskId);
    expect(command!.completedAt).not.toBeNull();
    await waitFor(async () => (runner.isLive(s.executionId) ? undefined : true), {
      what: "the resumed turn to end",
    });

    expect(during).toBe("RUNNING");
    expect(adapter.resumes).toHaveLength(1);
    const req = adapter.resumes[0]!;
    expect(req.sessionId).toBe(`sess-${seq}`);
    expect(req.prompt.startsWith("## CI failed on def5678")).toBe(true);
    expect(req.prompt).toContain("Round 1 of 3.");
    expect(req.prompt).toContain("Failing checks: unit, lint, e2e");
    expect(req.prompt).toContain("expected fr got en");
    expect(req.prompt).toContain("error no-unused-vars");
    // §9.2: up to 200 lines per check.
    expect(req.prompt).toContain("line 250");
    expect(req.prompt).not.toContain("line 51\n");
    expect(req.prompt).toContain("earlier lines omitted");

    const audit = await db.$client.unsafe<{ trigger: string }[]>(
      "select trigger from audit_events where entity_id = $1 and from_state = 'COMPLETED' and to_state = 'RUNNING'",
      [s.executionId],
    );
    expect(audit.map((a) => a.trigger)).toEqual(["resume_with_ci_failure"]);
    expect((await execution(s.executionId)).state).toBe("COMPLETED");
  });

  it("OTHER_HOST: unclaims the command without failing the execution; a consumer on the right host handles it later", async () => {
    const s = await seedCiRunning();
    // The §6.1 dead-host release unpinned it, so this host may claim it but
    // the runner refuses it.
    await db.$client.unsafe(
      "update executions set host = null, worker_id = null where id = $1",
      [s.executionId],
    );
    await failCi(s);
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);

    await consume(HOST, s.workerId, runner);

    let [command] = await commandsFor(s.taskId);
    expect(command!.claimedAt).toBeNull();
    expect(command!.completedAt).toBeNull();
    expect(adapter.resumes).toHaveLength(0);
    const row = await execution(s.executionId);
    expect(row.state).toBe("COMPLETED");
    expect(row.endReason).toBeNull();
    // C20: `unclaimed`, logged at info, never as a handler failure.
    expect(
      records.some((r) => r.level === "info" && r.msg === "command left for another worker"),
    ).toBe(true);
    expect(records.filter((r) => r.level === "error")).toEqual([]);

    // Now pinned to the other host: this host no longer claims it.
    await db.$client.unsafe(
      "update executions set host = $1, worker_id = $2 where id = $3",
      [OTHER_HOST, s.otherWorkerId, s.executionId],
    );
    await consume(HOST, s.workerId, runner);
    [command] = await commandsFor(s.taskId);
    expect(command!.claimedAt).toBeNull();

    const otherAdapter = new FakeAdapter();
    otherAdapter.script = async function* () {
      await completeExecution(s.executionId);
      yield { type: "turn_done", finalText: "fixed" };
    };
    const otherRunner = makeRunner(OTHER_HOST, s.otherWorkerId, otherAdapter);
    await consume(OTHER_HOST, s.otherWorkerId, otherRunner);

    [command] = await commandsFor(s.taskId);
    expect(command!.claimedAt).not.toBeNull();
    expect(command!.completedAt).not.toBeNull();
    await waitFor(async () => (otherRunner.isLive(s.executionId) ? undefined : true), {
      what: "the resumed turn to end",
    });
    expect(otherAdapter.resumes).toHaveLength(1);
    expect(otherAdapter.resumes[0]!.prompt).toContain("## CI failed on abc1234");
  });

  it("OTHER_HOST after the claim: the pin moved between the context load and the lock", async () => {
    const s = await seedCiRunning();
    await failCi(s);
    const adapter = new FakeAdapter();
    adapter.onCanResume = async () => {
      await db.$client.unsafe(
        "update executions set host = $1, worker_id = $2 where id = $3",
        [OTHER_HOST, s.otherWorkerId, s.executionId],
      );
    };
    const runner = makeRunner(HOST, s.workerId, adapter);

    await consume(HOST, s.workerId, runner);

    const [command] = await commandsFor(s.taskId);
    expect(command!.claimedAt).toBeNull();
    expect(command!.completedAt).toBeNull();
    expect(adapter.resumes).toHaveLength(0);
    expect((await execution(s.executionId)).state).toBe("COMPLETED");
  });

  it.each(["CANCELLED", "FAILED", "WAITING_FOR_USER", "RUNNING"] as const)(
    "not COMPLETED (%s): skips the command, completing it with a warning, and never unclaims it",
    async (state) => {
      const s = await seedCiRunning();
      await failCi(s);
      await db.$client.unsafe("update executions set state = $1 where id = $2", [
        state,
        s.executionId,
      ]);
      const adapter = new FakeAdapter();
      const runner = makeRunner(HOST, s.workerId, adapter);

      await consume(HOST, s.workerId, runner);

      const [command] = await commandsFor(s.taskId);
      expect(command!.claimedAt).not.toBeNull();
      expect(command!.completedAt).not.toBeNull();
      expect(adapter.resumes).toHaveLength(0);
      expect((await execution(s.executionId)).state).toBe(state);
      const skipped = records.filter((r) => r.msg === "command skipped");
      expect(skipped.map((r) => r.level)).toEqual(["warn"]);
      expect(skipped[0]!.fields.reason).toBe(`execution is ${state}, not COMPLETED`);
      expect(records.filter((r) => r.level === "error")).toEqual([]);

      // A later tick does not pick it up again.
      await consume(HOST, s.workerId, runner);
      expect(adapter.resumes).toHaveLength(0);
      expect(records.filter((r) => r.msg === "command skipped")).toHaveLength(1);
    },
  );

  it("NOT_RESUMABLE after the claim: the execution was cancelled between the load and the lock", async () => {
    const s = await seedCiRunning();
    await failCi(s);
    const adapter = new FakeAdapter();
    adapter.onCanResume = async () => {
      await db.$client.unsafe("update executions set state = 'CANCELLED' where id = $1", [
        s.executionId,
      ]);
    };
    const runner = makeRunner(HOST, s.workerId, adapter);

    await consume(HOST, s.workerId, runner);

    const [command] = await commandsFor(s.taskId);
    expect(command!.claimedAt).not.toBeNull();
    expect(command!.completedAt).not.toBeNull();
    expect(adapter.resumes).toHaveLength(0);
    expect((await execution(s.executionId)).state).toBe("CANCELLED");
    expect(records.find((r) => r.msg === "command skipped")?.level).toBe("warn");
  });

  it("a payload that fails validation is skipped and completed, logged at error, not left claimed", async () => {
    const s = await seedCiRunning();
    const { commandId } = await failCi(s);
    await db.$client.unsafe(
      "update execution_commands set payload = '{\"head_sha\": 7}'::jsonb where id = $1",
      [commandId!],
    );
    const adapter = new FakeAdapter();
    const runner = makeRunner(HOST, s.workerId, adapter);

    await consume(HOST, s.workerId, runner);

    const [command] = await commandsFor(s.taskId);
    expect(command!.claimedAt).not.toBeNull();
    expect(command!.completedAt).not.toBeNull();
    expect(adapter.resumes).toHaveLength(0);
    expect((await execution(s.executionId)).state).toBe("COMPLETED");
    expect(
      records.some(
        (r) => r.level === "error" && r.msg === "resume_with_ci_failure payload is invalid",
      ),
    ).toBe(true);
    expect(records.find((r) => r.msg === "command skipped")?.fields.reason).toMatch(
      /^invalid payload: /,
    );
    expect(records.some((r) => r.msg === "command handler failed")).toBe(false);
  });
});

describe("consume_commands outcomes (C20)", () => {
  let seeded: Seeded | undefined;
  beforeEach(() => {
    seeded = undefined;
  });

  /** One `send_message` command on a seeded execution pinned to `HOST`. */
  async function seedCommand(): Promise<{ id: string }> {
    seeded ??= await seedCiRunning();
    const [row] = await db
      .insert(executionCommands)
      .values({
        taskId: seeded.taskId,
        executionId: seeded.executionId,
        type: "send_message",
        payload: {},
      })
      .returning({ id: executionCommands.id });
    return row!;
  }

  async function run(handler: CommandHandler): Promise<void> {
    const handlers = createCommandHandlers();
    handlers.registerCommandHandler("send_message", handler);
    const ctx: TickContext = {
      db,
      workerId: "unused",
      config: loadConfig({ DATABASE_URL: "postgres://localhost/unused", WORKER_HOST: HOST }),
      now: NOW,
      tick: 1,
      logger,
    };
    await createConsumeCommandsPhase(handlers).run(ctx);
  }

  const commandRow = async (id: string) =>
    (await db.query.executionCommands.findFirst({ where: (c, { eq }) => eq(c.id, id) }))!;

  it("handled and a void return stamp completed_at and log at info", async () => {
    const a = await seedCommand();
    await run(async () => ({ outcome: "handled" }));
    expect((await commandRow(a.id)).completedAt).not.toBeNull();

    const b = await seedCommand();
    await run(async () => {});
    expect((await commandRow(b.id)).completedAt).not.toBeNull();
    expect(records.filter((r) => r.msg === "command completed").map((r) => r.level)).toEqual([
      "info",
      "info",
    ]);
  });

  it("unclaimed does not stamp completed_at, logs at info, and a later tick claims it again", async () => {
    const c = await seedCommand();
    const seen: string[] = [];
    await run(async (command, ctx) => {
      seen.push(command.id);
      await unclaimCommand(ctx.db, command.id);
      return { outcome: "unclaimed" };
    });
    let row = await commandRow(c.id);
    expect(row.claimedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(records.find((r) => r.msg === "command left for another worker")?.level).toBe("info");
    expect(records.filter((r) => r.level === "error")).toEqual([]);

    await run(async (command) => {
      seen.push(command.id);
      return { outcome: "handled" };
    });
    row = await commandRow(c.id);
    expect(seen).toEqual([c.id, c.id]);
    expect(row.completedAt).not.toBeNull();
  });

  it("skipped stamps completed_at and logs the reason at warn", async () => {
    const c = await seedCommand();
    await run(async () => ({ outcome: "skipped", reason: "nothing to do" }));
    expect((await commandRow(c.id)).completedAt).not.toBeNull();
    const skipped = records.find((r) => r.msg === "command skipped")!;
    expect(skipped.level).toBe("warn");
    expect(skipped.fields.reason).toBe("nothing to do");
  });

  it("a throw keeps today's behaviour: claimed, uncompleted, logged at error", async () => {
    const c = await seedCommand();
    await run(async () => {
      throw new Error("boom");
    });
    const row = await commandRow(c.id);
    expect(row.claimedAt).not.toBeNull();
    expect(row.completedAt).toBeNull();
    expect(records.find((r) => r.msg === "command handler failed")?.level).toBe("error");
  });
});
