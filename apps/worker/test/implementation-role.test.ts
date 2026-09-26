import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
import { REVIEW_ROUND_LIMIT_INSTRUCTION } from "@orchestra/core";
import {
  agentWorkers,
  applyCiFailure,
  projects,
  repositories,
  specificationRevisions,
  tasks,
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
import {
  createAgentToolsServer,
  createExecutionRegistry,
  type AgentToolsServer,
  type ExecutionRegistry,
} from "../src/agent-tools/index.js";
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  createCommandHandlers,
  createConsumeCommandsPhase,
  createRunner,
  registerCiFailureHandler,
  type Runner,
} from "../src/runner/index.js";
import { claimNextTask } from "../src/scheduler/index.js";
import type { TickContext } from "../src/tick.js";
import { WorktreeManager } from "../src/worktrees/index.js";
import { startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * GOT.39: the implementation role end to end (design.md §5.3, §8, §9.1-§9.3,
 * §11.2). A real Postgres, the real agent-tools server in-process, the real
 * worktree manager on a local git remote, and a fake adapter whose session
 * calls the agent tools over MCP in the order an implementing agent does.
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "impl-role-host";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const TEST_COMMAND = "pnpm test --filter receipts";
const PR_URL = "https://github.com/goopter/receipts/pull/42";

const SPEC = {
  repository: "receipts",
  objective: "Print receipts in the device language",
  scope: ["receipt printer"],
  out_of_scope: ["email receipts"],
  requirements: ["use device locale"],
  acceptance_criteria: ["receipt uses locale"],
  validation: ["unit test"],
  constraints: ["no new deps"],
  dependencies: [],
};

const GIT_FLAGS = [
  "-c",
  "user.name=Orchestra Test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...GIT_FLAGS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

let testDb: TestDb;
let db: Db;
let root: string;
let remote: string;
let registry: ExecutionRegistry;
let server: AgentToolsServer;
let workerId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "got39-impl-")));
  remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, seed);
  git(seed, "checkout", "-q", "-B", "main");
  await fs.writeFile(path.join(seed, "README.md"), "receipts");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "push", "-q", "origin", "main:main");

  registry = createExecutionRegistry();
  server = createAgentToolsServer({ db, registry, logger, now: () => new Date() });
  await server.start(0, "127.0.0.1");
});

afterAll(async () => {
  await server?.stop();
  await testDb?.stop();
  await fs.rm(root, { recursive: true, force: true });
});

let runner: Runner | undefined;
const clients: Client[] = [];

beforeEach(async () => {
  records.length = 0;
  await db.$client.unsafe(
    "truncate table projects, agent_workers, audit_events restart identity cascade",
  );
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: [], maxConcurrent: 4, workspaceRoot: root })
    .returning({ id: agentWorkers.id });
  workerId = worker!.id;
});

afterEach(async () => {
  await runner?.shutdown(2000);
  runner = undefined;
  while (clients.length > 0) await clients.pop()!.close().catch(() => {});
});

// ---------------------------------------------------------------- seeding

let seq = 0;

interface Claimed {
  taskId: string;
  executionId: string;
}

async function seedAndClaim(options: { maxReviewRounds?: number } = {}): Promise<Claimed> {
  const n = ++seq;
  const [project] = await db
    .insert(projects)
    .values({
      key: `IMP${n}`,
      name: `impl ${n}`,
      jiraJql: `project = IMP${n}`,
      maxCiRounds: 3,
      maxReviewRounds: options.maxReviewRounds ?? 3,
    })
    .returning({ id: projects.id });
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: `receipts-${n}`,
      gitUrl: remote,
      defaultBranch: "main",
      defaultRuntime: "claude",
      maxConcurrentWorktrees: 4,
      testCommand: TEST_COMMAND,
    })
    .returning({ id: repositories.id });
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey: `IMP-${n}`,
      jiraSummary: `Receipt language ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "READY",
    })
    .returning({ id: tasks.id });
  const [revision] = await db
    .insert(specificationRevisions)
    .values({ taskId: task!.id, version: 1, status: "approved", content: SPEC })
    .returning({ id: specificationRevisions.id });
  await db.$client.unsafe("update tasks set approved_revision_id = $1 where id = $2", [
    revision!.id,
    task!.id,
  ]);
  const claim = await claimNextTask({ db, workerId, runtimes: ["claude"], now: new Date() });
  if (!claim) throw new Error("claim returned nothing");
  return { taskId: claim.taskId, executionId: claim.executionId };
}

// ------------------------------------------------------------------ reads

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const task = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const pullRequestsOf = (taskId: string) =>
  db.query.pullRequests.findMany({ where: (p, { eq }) => eq(p.taskId, taskId) });
const commandsOf = (taskId: string) =>
  db.query.executionCommands.findMany({
    where: (c, { eq }) => eq(c.taskId, taskId),
    orderBy: (c, { asc }) => [asc(c.createdAt)],
  });

// ------------------------------------------------------------ fake agent

/** One agent-tools call over MCP; returns the structured output. */
async function callTool(
  req: StartRequest | ResumeRequest,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = new Client({ name: "impl-role-agent", version: "0.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(req.mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${req.mcp.token}` } },
    }),
  );
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    throw new Error(`${name} failed: ${text}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

type Step = {
  tool: string;
  args: Record<string, unknown>;
  /** Snapshot taken right after the call returns. */
  observe?: (output: Record<string, unknown>) => Promise<void>;
};

class ToolCallingAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];
  readonly resumes: ResumeRequest[] = [];
  readonly errors: string[] = [];
  startSteps: Step[] = [];
  resumeSteps: Step[] = [];

  start(req: StartRequest): AsyncIterable<AgentEvent> {
    this.starts.push(req);
    return this.session(req, this.startSteps, "sess-impl");
  }

  resume(req: ResumeRequest): AsyncIterable<AgentEvent> {
    this.resumes.push(req);
    return this.session(req, this.resumeSteps, null);
  }

  async canResume(): Promise<boolean> {
    return true;
  }

  private async *session(
    req: StartRequest | ResumeRequest,
    steps: Step[],
    sessionId: string | null,
  ): AsyncGenerator<AgentEvent> {
    if (sessionId) yield { type: "session", sessionId };
    for (const step of steps) {
      yield { type: "tool_call", name: `mcp__orchestra__${step.tool}`, input: step.args };
      try {
        const output = await callTool(req, step.tool, step.args);
        await step.observe?.(output);
      } catch (err) {
        // Recorded and asserted on; a throw here would read as a crash.
        this.errors.push(err instanceof Error ? err.message : String(err));
        break;
      }
    }
    yield { type: "turn_done", finalText: "done" };
  }
}

function makeRunner(adapter: ToolCallingAdapter): Runner {
  runner = createRunner({
    db,
    registry,
    logger,
    workerId,
    host: HOST,
    worktrees: new WorktreeManager({ workspaceRoot: path.join(root, "workspace") }),
    adapters: { claude: adapter },
    toolsUrl: () => server.url,
    quietTimeoutMs: 20_000,
    basePath: "/usr/bin:/bin",
    timings: { leaseRenewMs: 60_000 },
  });
  return runner;
}

async function consumeCommands(r: Runner): Promise<void> {
  const handlers = createCommandHandlers();
  registerCiFailureHandler(handlers, r);
  const ctx: TickContext = {
    db,
    workerId,
    config: loadConfig({ DATABASE_URL: "postgres://localhost/unused", WORKER_HOST: HOST }),
    now: new Date(),
    tick: 1,
    logger,
  };
  await createConsumeCommandsPhase(handlers).run(ctx);
}

const FINDING = {
  severity: "warning",
  file: "src/receipt.ts",
  line: 12,
  description: "locale is read once at import time",
  action: "read the locale per print",
};

// ------------------------------------------------------------------ tests

describe("implementation role end to end (GOT.39, AC1, AC4)", () => {
  it("drives review rounds to a PR, then a CI failure resume back to CI_RUNNING, then the CI round limit", async () => {
    const c = await seedAndClaim();
    const adapter = new ToolCallingAdapter();
    const r = makeRunner(adapter);
    const seen: Array<{ step: string; task: string; execution: string; reviewRounds: number }> = [];
    const observe = (step: string) => async () => {
      const t = await task(c.taskId);
      const e = await execution(c.executionId);
      seen.push({ step, task: t.state, execution: e.state, reviewRounds: e.reviewRounds });
    };
    let tokenHashWhileRunning: string | null = null;
    adapter.startSteps = [
      {
        tool: "report_review_started",
        args: { round: 1 },
        observe: async () => {
          tokenHashWhileRunning = (await execution(c.executionId)).toolsTokenHash;
          await observe("review_started 1")();
        },
      },
      {
        tool: "report_review_result",
        args: { round: 1, verdict: "findings", findings: [FINDING] },
        observe: observe("review_result 1 findings"),
      },
      { tool: "report_review_started", args: { round: 2 }, observe: observe("review_started 2") },
      {
        tool: "report_review_result",
        args: { round: 2, verdict: "clean", findings: [] },
        observe: observe("review_result 2 clean"),
      },
      {
        tool: "report_pr_created",
        args: { url: PR_URL, number: 42, head_sha: "sha-first" },
        observe: observe("pr_created"),
      },
    ];

    await r.start({ executionId: c.executionId, taskId: c.taskId });

    expect(adapter.errors).toEqual([]);
    expect(seen).toEqual([
      { step: "review_started 1", task: "REVIEWING", execution: "RUNNING", reviewRounds: 0 },
      { step: "review_result 1 findings", task: "IMPLEMENTING", execution: "RUNNING", reviewRounds: 1 },
      { step: "review_started 2", task: "REVIEWING", execution: "RUNNING", reviewRounds: 1 },
      { step: "review_result 2 clean", task: "REVIEWING", execution: "RUNNING", reviewRounds: 1 },
      { step: "pr_created", task: "CI_RUNNING", execution: "COMPLETED", reviewRounds: 1 },
    ]);
    expect(tokenHashWhileRunning).not.toBeNull();

    // AC1: the repository test command reaches the adapter and context.json.
    const start = adapter.starts[0]!;
    expect(start.testCommand).toBe(TEST_COMMAND);
    const context = JSON.parse(
      await fs.readFile(path.join(start.cwd, ".orchestra", "context.json"), "utf8"),
    ) as { review_command: string | null };
    expect(context.review_command).toBe(TEST_COMMAND);

    let prs = await pullRequestsOf(c.taskId);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      executionId: c.executionId,
      number: 42,
      url: PR_URL,
      headSha: "sha-first",
      state: "open",
      ciState: "pending",
    });
    let row = await execution(c.executionId);
    expect(row.state).toBe("COMPLETED");
    expect(row.toolsTokenHash).toBeNull();
    expect(row.ciRounds).toBe(0);
    expect((await task(c.taskId)).state).toBe("CI_RUNNING");
    expect(r.isLive(c.executionId)).toBe(false);

    // ---- CI fails (what GOT.46's poller will do).
    await db.transaction((tx) =>
      applyCiFailure(tx, {
        taskId: c.taskId,
        executionId: c.executionId,
        pullRequestId: prs[0]!.id,
        headSha: "sha-first",
        checks: [
          { name: "unit-tests", url: "https://ci.example.com/1", log_excerpt: "FAIL receipt.test.ts" },
          { name: "typecheck", url: "https://ci.example.com/2", log_excerpt: "TS2345 in receipt.ts" },
        ],
        actor: { kind: "worker", id: workerId },
        now: new Date(),
      }),
    );
    expect((await task(c.taskId)).state).toBe("IMPLEMENTING");
    expect((await execution(c.executionId)).ciRounds).toBe(1);
    let commands = await commandsOf(c.taskId);
    expect(commands.map((cmd) => cmd.type)).toEqual(["resume_with_ci_failure"]);

    // ---- The resumed session fixes CI, reviews again and re-reports the PR (D14).
    seen.length = 0;
    adapter.resumeSteps = [
      { tool: "report_review_started", args: { round: 3 }, observe: observe("review_started 3") },
      {
        tool: "report_review_result",
        args: { round: 3, verdict: "clean", findings: [] },
        observe: observe("review_result 3 clean"),
      },
      {
        tool: "report_pr_created",
        args: { url: PR_URL, number: 42, head_sha: "sha-second" },
        observe: observe("pr_created again"),
      },
    ];

    await consumeCommands(r);
    await waitFor(async () => (r.isLive(c.executionId) ? undefined : true), {
      what: "the resumed turn to end",
    });

    commands = await commandsOf(c.taskId);
    expect(commands[0]!.completedAt).not.toBeNull();
    expect(adapter.errors).toEqual([]);
    expect(adapter.resumes).toHaveLength(1);
    const resumed = adapter.resumes[0]!;
    expect(resumed.sessionId).toBe("sess-impl");
    expect(resumed.testCommand).toBe(TEST_COMMAND);
    expect(resumed.prompt.startsWith("## CI failed on sha-first")).toBe(true);
    expect(resumed.prompt).toContain("Round 1 of 3.");
    expect(resumed.prompt).toContain("unit-tests");
    expect(resumed.prompt).toContain("typecheck");
    expect(resumed.prompt).toContain("FAIL receipt.test.ts");
    expect(seen).toEqual([
      { step: "review_started 3", task: "REVIEWING", execution: "RUNNING", reviewRounds: 1 },
      { step: "review_result 3 clean", task: "REVIEWING", execution: "RUNNING", reviewRounds: 1 },
      { step: "pr_created again", task: "CI_RUNNING", execution: "COMPLETED", reviewRounds: 1 },
    ]);
    prs = await pullRequestsOf(c.taskId);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 42, headSha: "sha-second", ciState: "pending" });
    row = await execution(c.executionId);
    expect(row.state).toBe("COMPLETED");
    expect(row.toolsTokenHash).toBeNull();
    expect(row.ciRounds).toBe(1);
    expect(row.endReason).toBeNull();
    const backEdge = await db.$client.unsafe<{ trigger: string }[]>(
      "select trigger from audit_events where entity_id = $1 and from_state = 'COMPLETED' and to_state = 'RUNNING'",
      [c.executionId],
    );
    expect(backEdge.map((a) => a.trigger)).toEqual(["resume_with_ci_failure"]);

    // ---- CI round limit: ci_rounds already at max_ci_rounds.
    await db.$client.unsafe("update executions set ci_rounds = 3 where id = $1", [c.executionId]);
    await db.transaction((tx) =>
      applyCiFailure(tx, {
        taskId: c.taskId,
        executionId: c.executionId,
        pullRequestId: prs[0]!.id,
        headSha: "sha-second",
        checks: [{ name: "unit-tests", url: "https://ci.example.com/3", log_excerpt: "FAIL again" }],
        actor: { kind: "worker", id: workerId },
        now: new Date(),
      }),
    );
    const escalated = await task(c.taskId);
    expect(escalated.state).toBe("NEEDS_HUMAN");
    expect(escalated.needsHumanReason).toBe("CI round limit exceeded: round 4 > max_ci_rounds 3");
    expect((await execution(c.executionId)).ciRounds).toBe(4);
    expect(await commandsOf(c.taskId)).toHaveLength(1);
    await consumeCommands(r);
    expect(adapter.resumes).toHaveLength(1);
  });

  it("review round limit through the real tool: NEEDS_HUMAN with the reason and the stop instruction", async () => {
    const c = await seedAndClaim({ maxReviewRounds: 1 });
    const adapter = new ToolCallingAdapter();
    const r = makeRunner(adapter);
    let instruction: unknown;
    adapter.startSteps = [
      { tool: "report_review_started", args: { round: 1 } },
      { tool: "report_review_result", args: { round: 1, verdict: "findings", findings: [FINDING] } },
      { tool: "report_review_started", args: { round: 2 } },
      {
        tool: "report_review_result",
        args: { round: 2, verdict: "findings", findings: [FINDING] },
        observe: async (output) => {
          instruction = output.instruction;
        },
      },
      { tool: "report_failed", args: { reason: "review limit", detail: "stopped as instructed" } },
    ];

    await r.start({ executionId: c.executionId, taskId: c.taskId });

    expect(adapter.errors).toEqual([]);
    expect(instruction).toBe(REVIEW_ROUND_LIMIT_INSTRUCTION);
    const t = await task(c.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toBe("Review round limit exceeded: round 2 > max_review_rounds 1");
    const row = await execution(c.executionId);
    expect(row.reviewRounds).toBe(1);
    expect(row.state).toBe("FAILED");
    expect(row.endReason).toBe("agent_gave_up");
    expect(row.toolsTokenHash).toBeNull();
    expect(await pullRequestsOf(c.taskId)).toEqual([]);
  });
});
