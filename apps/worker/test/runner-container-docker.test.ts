import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  AgentProcess,
  ProcessSpawner,
  ResumeRequest,
  StartRequest,
} from "@orchestra/adapters";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecutionRegistry } from "../src/agent-tools/index.js";
import { ContainerManager, containerName } from "../src/containers/index.js";
import type { Logger } from "../src/logger.js";
import { claudeContainerSpawner, createRunner, type Runner } from "../src/runner/index.js";
import { claimNextTask } from "../src/scheduler/index.js";
import { startTestDb, type TestDb } from "./harness.js";

/**
 * design.md §9.9, C4, against the real Docker daemon and the locally built
 * `orchestra/agent` image: a container-mode execution's setup_command and a
 * spawned process run in the execution's container through the runner.
 * The adapter is a fake that spawns plain commands (and `claude --version`),
 * so no model token is spent. Skips only when `docker info` fails. Every
 * container, network and file created here is removed in `afterAll`.
 */

const IMAGE = process.env.ORCHESTRA_TEST_AGENT_IMAGE ?? "orchestra/agent:0.0.1";

const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
  timeout: 30_000,
});
const dockerOk = info.status === 0;
if (!dockerOk) {
  const reason = (info.error?.message ?? info.stderr ?? "").trim() || `exit ${info.status}`;
  console.warn(
    [
      "",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "!! SKIPPING runner-container-docker.test.ts: `docker info` failed.",
      `!! reason: ${reason}`,
      "!! The real-Docker tests for container-mode executions (§9.9) did NOT run.",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "",
    ].join("\n"),
  );
}

const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
};

const HOST = "c4-docker-host";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const CONTAINER_TOOLS_URL = "http://host.docker.internal:4999/mcp";
const GH_SECRET = `gh-${randomUUID()}`;
const OPENAI_SECRET = `sk-openai-${randomUUID()}`;
const OAUTH_SECRET = `sk-ant-oat-${randomUUID()}`;
const DB_LEAK = `postgres://orchestra:${randomUUID()}@db/orchestra`;
const JIRA_LEAK = `jira-${randomUUID()}`;
const SPEC = {
  repository: "repo",
  objective: "o",
  scope: ["s"],
  out_of_scope: ["x"],
  requirements: ["r"],
  acceptance_criteria: ["a"],
  validation: ["v"],
  constraints: ["c"],
  dependencies: [],
};

function dockerStatus(...args: string[]): number | null {
  return spawnSync("docker", args, { stdio: "ignore" }).status;
}

async function collect(proc: AgentProcess): Promise<{ out: string; code: number | null }> {
  let out = "";
  proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
  proc.stderr.on("data", (c: Buffer) => (out += c.toString()));
  proc.stdin.end();
  const exit = await proc.exit;
  await new Promise((r) => setImmediate(r));
  return { out, code: exit.code };
}

const toMap = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

/**
 * A stand-in for the Claude and Codex adapters: builds each spawn's env the
 * way they do (worker environment, then `req.env`, then the token) and runs
 * `command` through the injected container spawner.
 */
class SpawningAdapter implements AgentAdapter {
  spawn: ProcessSpawner | undefined;
  output: string | undefined;
  exitCode: number | null | undefined;
  /** The turn's agent-tools token, as the runner issued it. */
  token: string | undefined;
  constructor(
    readonly runtime: Runtime,
    private readonly hostEnv: NodeJS.ProcessEnv,
    private readonly command: (spawn: ProcessSpawner) => { command: string; args: string[]; spawn: ProcessSpawner },
    private readonly onDone: (executionId: string) => Promise<void>,
  ) {}

  start(req: StartRequest): AsyncIterable<AgentEvent> {
    const self = this;
    return (async function* () {
      const executionId = path.basename(req.cwd);
      yield { type: "session", sessionId: randomUUID() } as AgentEvent;
      const { command, args, spawn } = self.command(self.spawn!);
      self.token = req.mcp.token;
      const proc = spawn(command, args, {
        cwd: req.cwd,
        env: { ...self.hostEnv, ...req.env, ORCHESTRA_TOKEN: req.mcp.token },
      });
      const { out, code } = await collect(proc);
      self.output = out;
      self.exitCode = code;
      await self.onDone(executionId);
      yield { type: "turn_done", finalText: "done" } as AgentEvent;
    })();
  }

  resume(_req: ResumeRequest): AsyncIterable<AgentEvent> {
    throw new Error("not used");
  }

  async canResume(): Promise<boolean> {
    return false;
  }
}

describe.skipIf(!dockerOk)("container-mode execution against real Docker (§9.9, C4)", () => {
  const network = `orchestra-agents-c4-${randomUUID().slice(0, 8)}`;
  const owner = randomUUID().replaceAll("-", "");
  const hostEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: DB_LEAK, JIRA_API_TOKEN: JIRA_LEAK };
  const created = new Set<string>();
  let testDb: TestDb;
  let db: Db;
  let tmp: string;
  let root: string;
  let manager: ContainerManager;
  let runner: Runner | undefined;
  let seq = 0;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "c4-runner-docker-")));
    root = path.join(tmp, "ws");
    manager = new ContainerManager({
      workspaceRoot: root,
      image: IMAGE,
      cpus: 1,
      memory: "512m",
      owner,
      network,
      hostEnv,
    });
  });

  afterAll(async () => {
    await runner?.shutdown(2000);
    for (const name of created) dockerStatus("rm", "-f", "-v", name);
    dockerStatus("network", "rm", network);
    await testDb?.stop();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  async function seedClaimed(runtime: Runtime, setupCommand: string | null) {
    const n = ++seq;
    const [worker] = await db
      .insert(agentWorkers)
      .values({ host: HOST, capabilities: ["docker"], maxConcurrent: 4, workspaceRoot: root })
      .onConflictDoNothing()
      .returning({ id: agentWorkers.id });
    const workerId =
      worker?.id ??
      (await db.query.agentWorkers.findFirst({ where: (w, { eq }) => eq(w.host, HOST) }))!.id;
    const [project] = await db
      .insert(projects)
      .values({ key: `DKR${n}`, name: `docker ${n}`, jiraJql: `project = DKR${n}` })
      .returning({ id: projects.id });
    const repositoryName = `dkr-repo-${n}`;
    const [repo] = await db
      .insert(repositories)
      .values({
        projectId: project!.id,
        name: repositoryName,
        gitUrl: `git@example.com:${repositoryName}.git`,
        defaultBranch: "main",
        defaultRuntime: runtime,
        defaultModel: "test-model",
        maxConcurrentWorktrees: 4,
        setupCommand,
        agentContainer: true,
        agentImage: null,
      })
      .returning({ id: repositories.id });
    const [task] = await db
      .insert(tasks)
      .values({
        projectId: project!.id,
        repositoryId: repo!.id,
        jiraKey: `DKR-${n}`,
        jiraSummary: `Docker task ${n}`,
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
    const claim = await claimNextTask({ db, workerId, runtimes: [runtime], now: new Date() });
    if (!claim) throw new Error("claim returned nothing");
    created.add(containerName(claim.executionId));
    return { workerId, repositoryName, taskId: task!.id, executionId: claim.executionId };
  }

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

  function makeRunner(
    workerId: string,
    repositoryName: string,
    adapter: SpawningAdapter,
    containerManager: ContainerManager = manager,
  ): Runner {
    runner = createRunner({
      db,
      registry: createExecutionRegistry(),
      logger: quiet,
      workerId,
      host: HOST,
      worktrees: {
        async prepareImplementation(input) {
          const worktreePath = path.join(root, "work", input.executionId);
          await fs.mkdir(worktreePath, { recursive: true });
          await fs.mkdir(path.join(root, "repos", `${repositoryName}.git`), { recursive: true });
          return { worktreePath, branch: `agent/${input.task.jiraKey}-abcdef12` };
        },
        async prepareSpec() {
          throw new Error("not used");
        },
        async remove() {
          return { branchDeleted: false };
        },
      },
      adapters: {},
      pricing: {},
      toolsUrl: () => "http://127.0.0.1:4999/mcp",
      quietTimeoutMs: 120_000,
      containers: {
        manager: containerManager,
        toolsUrl: () => CONTAINER_TOOLS_URL,
        credentials: {
          githubToken: GH_SECRET,
          claudeCodeOauthToken: OAUTH_SECRET,
          openaiApiKey: OPENAI_SECRET,
        },
        setupTimeoutMs: 60_000,
        adapterFor: (_runtime, options) => {
          adapter.spawn = options.spawn;
          return adapter;
        },
      },
    });
    return runner;
  }

  it("runs setup_command and the session's process in the execution's container with only the §9.9 variables, then removes it", async () => {
    const s = await seedClaimed(
      "codex",
      'printf "uid=%s\\n" "$(id -u)" > setup.txt && env > setup-env.txt',
    );
    const adapter = new SpawningAdapter(
      "codex",
      hostEnv,
      (spawn) => ({ command: "sh", args: ["-c", "env; echo PWD_IS=$(pwd)"], spawn }),
      completeViaTool,
    );
    const r = makeRunner(s.workerId, s.repositoryName, adapter);

    await r.start({ executionId: s.executionId, taskId: s.taskId });

    const row = (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, s.executionId) }))!;
    expect(row.state).toBe("COMPLETED");
    const worktree = path.join(root, "work", s.executionId);
    const home = path.join(root, "agent-home", s.taskId);

    // setup_command ran in the container, in the worktree, as the worker's uid.
    expect(await fs.readFile(path.join(worktree, "setup.txt"), "utf8")).toBe(`uid=${process.getuid!()}\n`);
    const setupEnv = toMap(await fs.readFile(path.join(worktree, "setup-env.txt"), "utf8"));
    expect(setupEnv.HOME).toBe(home);
    expect(setupEnv.GITHUB_TOKEN).toBe(GH_SECRET);
    expect(setupEnv.ORCHESTRA_URL).toBe(CONTAINER_TOOLS_URL);
    expect(setupEnv.DATABASE_URL).toBeUndefined();
    expect(setupEnv.JIRA_API_TOKEN).toBeUndefined();
    expect(setupEnv.ORCHESTRA_TOKEN).toBeUndefined();

    // The session's process: the §9.9 list, the turn's token, nothing else of the worker's.
    expect(adapter.exitCode).toBe(0);
    const env = toMap(adapter.output!);
    expect(env.PWD_IS).toBe(worktree);
    expect(env.HOME).toBe(home);
    expect(env.ORCHESTRA_URL).toBe(CONTAINER_TOOLS_URL);
    expect(env.ORCHESTRA_TOKEN).toMatch(/.{20,}/);
    expect(env.GITHUB_TOKEN).toBe(GH_SECRET);
    expect(env.OPENAI_API_KEY).toBe(OPENAI_SECRET);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH_SECRET);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JIRA_API_TOKEN).toBeUndefined();
    expect(adapter.output).not.toContain(DB_LEAK);
    expect(adapter.output).not.toContain(JIRA_LEAK);

    // Removed when the execution ended.
    expect(dockerStatus("container", "inspect", containerName(s.executionId))).not.toBe(0);
  });

  it("gives the container the turn's ORCHESTRA_TOKEN and ORCHESTRA_URL when the worker's own environment has stale ones (C4 F2)", async () => {
    const STALE_TOKEN = `stale-${randomUUID()}`;
    const STALE_URL = "http://127.0.0.1:1/stale";
    const staleEnv: NodeJS.ProcessEnv = { ...hostEnv, ORCHESTRA_TOKEN: STALE_TOKEN, ORCHESTRA_URL: STALE_URL };
    const staleManager = new ContainerManager({
      workspaceRoot: root,
      image: IMAGE,
      cpus: 1,
      memory: "512m",
      owner,
      network,
      hostEnv: staleEnv,
    });
    const s = await seedClaimed("codex", null);
    const adapter = new SpawningAdapter(
      "codex",
      staleEnv,
      (spawn) => ({ command: "sh", args: ["-c", "env"], spawn }),
      completeViaTool,
    );
    const r = makeRunner(s.workerId, s.repositoryName, adapter, staleManager);

    await r.start({ executionId: s.executionId, taskId: s.taskId });

    expect(adapter.exitCode).toBe(0);
    const env = toMap(adapter.output!);
    expect(adapter.token).toMatch(/.{20,}/);
    expect(env.ORCHESTRA_TOKEN).toBe(adapter.token);
    expect(env.ORCHESTRA_URL).toBe(CONTAINER_TOOLS_URL);
    expect(adapter.output).not.toContain(STALE_TOKEN);
    expect(adapter.output).not.toContain(STALE_URL);
    const row = (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, s.executionId) }))!;
    expect(row.state).toBe("COMPLETED");
    expect(dockerStatus("container", "inspect", containerName(s.executionId))).not.toBe(0);
  });

  it("runs the image's claude CLI in place of the SDK's host binary, spending no model tokens", async () => {
    const s = await seedClaimed("claude", null);
    const adapter = new SpawningAdapter(
      "claude",
      hostEnv,
      (spawn) => ({
        command: "/nonexistent/host/node_modules/claude-agent-sdk-darwin-arm64/claude",
        args: ["--version"],
        spawn: claudeContainerSpawner(spawn),
      }),
      completeViaTool,
    );
    const r = makeRunner(s.workerId, s.repositoryName, adapter);

    await r.start({ executionId: s.executionId, taskId: s.taskId });

    expect(adapter.exitCode).toBe(0);
    expect(adapter.output).toMatch(/\d+\.\d+\.\d+/);
    const row = (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, s.executionId) }))!;
    expect(row.state).toBe("COMPLETED");
    expect(dockerStatus("container", "inspect", containerName(s.executionId))).not.toBe(0);
  });
});
