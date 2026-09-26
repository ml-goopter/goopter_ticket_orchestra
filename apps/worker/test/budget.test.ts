import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, AgentEvent, ResumeRequest, StartRequest } from "@orchestra/adapters";
import type { Runtime } from "@orchestra/core";
import {
  agentWorkers,
  projects,
  repositories,
  specificationRevisions,
  tasks,
  transition,
  type Db,
} from "@orchestra/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionRegistry,
  type ExecutionRegistry,
} from "../src/agent-tools/index.js";
import type { Logger } from "../src/logger.js";
import { resetPricingWarnings, type PricingTable } from "../src/pricing/index.js";
import { createRunner, type Runner, type RunnerDeps } from "../src/runner/index.js";
import { claimNextTask } from "../src/scheduler/index.js";
import type { PrepareImplementationInput, PrepareSpecInput } from "../src/worktrees/index.js";
import { startTestDb, type TestDb } from "./harness.js";

/**
 * design.md §7 (StartRequest.maxBudgetUsd), §9.5 (budget_exceeded is a
 * business failure that goes to NEEDS_HUMAN) and §9.7 (Codex usage priced
 * from config/pricing.json, cost_usd NULL for an unknown model). GOT.50.
 */

const HOST = "budget-host";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const TOOLS_URL = "http://127.0.0.1:4998/mcp";
const BASE_PATH = "/usr/bin:/bin";

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

const PRICING: PricingTable = {
  "gpt-5-codex": { input: 1.25, cached_input: 0.125, output: 10.0 },
};

let testDb: TestDb;
let db: Db;
let workRoot: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "got50-budget-"));
});

afterAll(async () => {
  await testDb?.stop();
  await fs.rm(workRoot, { recursive: true, force: true });
});

let runner: Runner | undefined;

beforeEach(async () => {
  await db.$client.unsafe(
    "truncate table projects, agent_workers, audit_events, users restart identity cascade",
  );
  resetPricingWarnings();
});

afterEach(async () => {
  await runner?.shutdown(2000);
  runner = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- seeding

let seq = 0;

interface Seeded {
  workerId: string;
  taskId: string;
  executionId: string;
}

async function seedClaimed(
  options: { runtime?: Runtime; maxBudgetUsd?: string | null } = {},
): Promise<Seeded> {
  const n = ++seq;
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: workRoot })
    .onConflictDoNothing()
    .returning({ id: agentWorkers.id });
  const workerId =
    worker?.id ??
    (await db.query.agentWorkers.findFirst({ where: (w, { eq }) => eq(w.host, HOST) }))!.id;
  const [project] = await db
    .insert(projects)
    .values({
      key: `BGT${n}`,
      name: `budget ${n}`,
      jiraJql: `project = BGT${n}`,
      maxBudgetUsd: options.maxBudgetUsd === undefined ? null : options.maxBudgetUsd,
    })
    .returning({ id: projects.id });
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: `repo-${n}`,
      gitUrl: `git@example.com:repo-${n}.git`,
      defaultBranch: "main",
      defaultRuntime: options.runtime ?? "claude",
      defaultModel: "claude-opus-test",
      maxConcurrentWorktrees: 4,
      setupCommand: "npm ci",
    })
    .returning({ id: repositories.id });
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey: `BGT-${n}`,
      jiraSummary: `Receipt language ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "READY",
    })
    .returning({ id: tasks.id });
  const [revision] = await db
    .insert(specificationRevisions)
    .values({ taskId: task!.id, version: 2, status: "approved", content: SPEC })
    .returning({ id: specificationRevisions.id });
  await db.$client.unsafe("update tasks set approved_revision_id = $1 where id = $2", [
    revision!.id,
    task!.id,
  ]);

  const claim = await claimNextTask({
    db,
    workerId,
    runtimes: [options.runtime ?? "claude"],
    now: new Date(),
  });
  if (!claim) throw new Error("claim returned nothing");
  return { workerId, taskId: claim.taskId, executionId: claim.executionId };
}

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const task = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const usageRowsFor = (executionId: string) =>
  db.query.executionUsage.findMany({
    where: (u, { eq }) => eq(u.executionId, executionId),
    orderBy: (u, { asc }) => [asc(u.recordedAt)],
  });
const eventsFor = (executionId: string) =>
  db.query.executionEvents.findMany({
    where: (e, { eq }) => eq(e.executionId, executionId),
    orderBy: (e, { asc }) => [asc(e.id)],
  });

// ------------------------------------------------------------ fake agent

interface ScriptApi {
  signal: AbortSignal;
  executionId: string;
}

type Script = (api: ScriptApi) => AsyncGenerator<AgentEvent>;

class FakeAdapter implements AgentAdapter {
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  script: Script = async function* () {};

  constructor(readonly runtime: Runtime) {}

  start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    return this.script({ signal, executionId: path.basename(req.cwd) });
  }

  resume(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    return this.script({ signal, executionId: path.basename(req.cwd) });
  }

  async canResume(): Promise<boolean> {
    return true;
  }
}

/** What `report_pr_created` does to the execution (§8). */
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

// ------------------------------------------------------------- the runner

interface Harness {
  adapter: FakeAdapter;
  registry: ExecutionRegistry;
  runner: Runner;
}

function makeRunner(options: {
  workerId: string;
  runtime: Runtime;
  pricing?: PricingTable;
}): Harness {
  const registry: ExecutionRegistry = createExecutionRegistry();
  const adapter = new FakeAdapter(options.runtime);
  const deps: RunnerDeps = {
    db,
    registry,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child(): Logger {
        return deps.logger;
      },
    },
    workerId: options.workerId,
    host: HOST,
    worktrees: {
      async prepareImplementation(input: PrepareImplementationInput) {
        const worktreePath = path.join(workRoot, "work", input.executionId);
        await fs.mkdir(worktreePath, { recursive: true });
        return { worktreePath, branch: `agent/${input.task.jiraKey}-abcdef12` };
      },
      async prepareSpec(input: PrepareSpecInput) {
        const worktreePath = path.join(workRoot, "work", input.executionId);
        await fs.mkdir(worktreePath, { recursive: true });
        return { worktreePath, branch: null };
      },
      async remove() {
        return { branchDeleted: false };
      },
    },
    adapters: { [options.runtime]: adapter },
    pricing: options.pricing ?? PRICING,
    toolsUrl: () => TOOLS_URL,
    quietTimeoutMs: 10_000,
    basePath: BASE_PATH,
    timings: { leaseRenewMs: 100, blockingGraceMs: 400, blockingPollMs: 50 },
  };
  const created = createRunner(deps);
  runner = created;
  return { adapter, registry, runner: created };
}

// ------------------------------------------------------------------ tests

describe("StartRequest/ResumeRequest maxBudgetUsd (§7, C55, AC1)", () => {
  it("carries the project's max_budget_usd on both start and resume", async () => {
    const s = await seedClaimed({ maxBudgetUsd: "3.500000" });
    const h = makeRunner({ workerId: s.workerId, runtime: "claude" });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-budget-start" };
      h.registry.get(executionId)!.blockingPending = true;
      yield { type: "turn_done", finalText: "stopping for a question" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    expect(h.adapter.starts[0]!.maxBudgetUsd).toBe(3.5);

    h.adapter.script = async function* () {
      yield { type: "turn_done", finalText: "answered" };
    };
    const { done } = await h.runner.resume({
      executionId: s.executionId,
      prompt: "## Message from the user\nuse en-US",
    });
    await done;

    expect(h.adapter.resumes[0]!.maxBudgetUsd).toBe(3.5);
  });

  it("omits max_budget_usd on both start and resume when the project has none", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, runtime: "claude" });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-budget-null" };
      h.registry.get(executionId)!.blockingPending = true;
      yield { type: "turn_done", finalText: "stopping for a question" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });
    expect((await execution(s.executionId)).state).toBe("WAITING_FOR_USER");
    expect(h.adapter.starts[0]!.maxBudgetUsd).toBeUndefined();

    h.adapter.script = async function* () {
      yield { type: "turn_done", finalText: "answered" };
    };
    const { done } = await h.runner.resume({
      executionId: s.executionId,
      prompt: "## Message from the user\nuse en-US",
    });
    await done;

    expect(h.adapter.resumes[0]!.maxBudgetUsd).toBeUndefined();
  });
});

describe("adapter error budget classification (§9.5, AC2)", () => {
  it("a budget-pattern adapter error ends budget_exceeded, escalating the task to NEEDS_HUMAN", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, runtime: "claude" });
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-budget-err" };
      yield { type: "error", message: "budget exceeded for this session", retriable: false };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("budget_exceeded");
    expect(row.endDetail).toBe("budget exceeded for this session");
    const t = await task(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toContain("budget exceeded for this session");
  });

  it("a non-budget adapter error still ends adapter_error, unaffected by the new classification", async () => {
    const s = await seedClaimed();
    const h = makeRunner({ workerId: s.workerId, runtime: "claude" });
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-other-err" };
      yield { type: "error", message: "rate limited", retriable: true };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("adapter_error");
    expect(JSON.parse(row.endDetail!)).toEqual({ message: "rate limited", retriable: true });
  });
});

describe("Codex usage pricing (§9.7, AC3)", () => {
  it("prices a Codex usage event against the table and adds it to the execution's totals", async () => {
    const s = await seedClaimed({ runtime: "codex" });
    const h = makeRunner({ workerId: s.workerId, runtime: "codex" });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-priced" };
      yield { type: "usage", model: "gpt-5-codex", input: 1_000_000, cached: 0, output: 0 };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const usage = await usageRowsFor(s.executionId);
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]!.costUsd)).toBe(1.25);
    const row = await execution(s.executionId);
    expect(Number(row.costUsd)).toBe(1.25);
    const recorded = (await eventsFor(s.executionId)).find((e) => e.type === "usage.recorded");
    expect(recorded!.payload).toMatchObject({ cost_usd: "1.25" });
  });

  it("records cost_usd NULL, warns once, and leaves totals unchanged for an unknown model", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await seedClaimed({ runtime: "codex" });
    const h = makeRunner({ workerId: s.workerId, runtime: "codex" });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-unknown" };
      yield { type: "usage", model: "mystery-model", input: 1_000_000, cached: 0, output: 0 };
      yield { type: "usage", model: "mystery-model", input: 1_000_000, cached: 0, output: 0 };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const usage = await usageRowsFor(s.executionId);
    expect(usage.map((u) => u.costUsd)).toEqual([null, null]);
    const row = await execution(s.executionId);
    expect(Number(row.costUsd)).toBe(0);
    const recorded = (await eventsFor(s.executionId)).filter((e) => e.type === "usage.recorded");
    expect(recorded.map((e) => (e.payload as { cost_usd: unknown }).cost_usd)).toEqual([
      null,
      null,
    ]);
    // Warned once for the model's life, not once per usage row.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stores a Claude usage event's own costUsd as before, unpriced", async () => {
    const s = await seedClaimed({ runtime: "claude" });
    const h = makeRunner({ workerId: s.workerId, runtime: "claude" });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-claude-usage" };
      yield { type: "usage", model: "claude-opus-test", input: 100, cached: 0, output: 50, costUsd: 0.42 };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const usage = await usageRowsFor(s.executionId);
    expect(Number(usage[0]!.costUsd)).toBe(0.42);
  });
});

describe("cumulative budget cap for runtimes without adapter enforcement (§9.7 item 4, AC4)", () => {
  it("aborts a Codex execution whose priced cumulative cost crosses max_budget_usd", async () => {
    const s = await seedClaimed({ runtime: "codex", maxBudgetUsd: "1.000000" });
    const h = makeRunner({ workerId: s.workerId, runtime: "codex" });
    h.adapter.script = async function* () {
      yield { type: "session", sessionId: "sess-over-budget" };
      // gpt-5-codex input rate is $1.25 / million tokens: 1M tokens costs
      // $1.25, crossing the $1.00 cap in a single usage event.
      yield { type: "usage", model: "gpt-5-codex", input: 1_000_000, cached: 0, output: 0 };
      // A truly hung agent from here: the abort must end the turn on its own.
      await new Promise(() => {});
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    const row = await execution(s.executionId);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("budget_exceeded");
    expect(row.endDetail).toMatch(/^cost 1\.2500 USD exceeded budget 1\.0000 USD$/);
    const t = await task(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toContain("budget_exceeded");
  });

  it("does not abort the same Codex usage when the project has no budget", async () => {
    const s = await seedClaimed({ runtime: "codex" });
    const h = makeRunner({ workerId: s.workerId, runtime: "codex" });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-no-budget" };
      yield { type: "usage", model: "gpt-5-codex", input: 1_000_000, cached: 0, output: 0 };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect((await execution(s.executionId)).state).toBe("COMPLETED");
  });

  it("does not abort a Claude execution: it relies on the adapter's own enforcement", async () => {
    const s = await seedClaimed({ runtime: "claude", maxBudgetUsd: "0.000001" });
    const h = makeRunner({ workerId: s.workerId, runtime: "claude" });
    h.adapter.script = async function* ({ executionId }) {
      yield { type: "session", sessionId: "sess-claude-over" };
      // Far over the cap, but only "codex" is checked here (§9.7 item 4).
      yield { type: "usage", model: "claude-opus-test", input: 100, cached: 0, output: 50, costUsd: 100 };
      await completeViaTool(executionId);
      yield { type: "turn_done", finalText: "done" };
    };

    await h.runner.start({ executionId: s.executionId, taskId: s.taskId });

    expect((await execution(s.executionId)).state).toBe("COMPLETED");
  });
});
