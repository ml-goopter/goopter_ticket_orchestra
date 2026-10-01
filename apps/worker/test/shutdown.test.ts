import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { agentWorkers } from "@orchestra/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, waitFor, type TestDb } from "./harness.js";
import {
  killAllTrackedWorkersAndAssertNoneSurvive,
  killWorkerTree,
  spawnWorkerProcess,
} from "./worker-process.js";

const tsxCli = fileURLToPath(
  new URL("./dist/cli.mjs", import.meta.resolve("tsx/package.json")),
);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const workerDir = fileURLToPath(new URL("..", import.meta.url));

let testDb: TestDb;

/** A loopback port that was free a moment ago, so the child's tools server can bind it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * An image tag no host has, so the §9.9 `docker` check fails the same way on
 * every host and the worker stays in host mode.
 */
const ABSENT_AGENT_IMAGE = "orchestra/agent:absent-shutdown-test";

async function startWorker(
  host: string,
  env: Record<string, string> = { AGENT_CONTAINER_IMAGE: ABSENT_AGENT_IMAGE },
): Promise<ChildProcess> {
  const child = spawnWorkerProcess(process.execPath, [tsxCli, entry], {
    cwd: workerDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL: testDb.connectionString,
      WORKER_HOST: host,
      WORKER_CAPABILITIES: "node",
      WORKER_TOOLS_PORT: String(await freePort()),
      LOG_LEVEL: "debug",
      ...env,
    },
  });
  return child;
}

/** Resolves with `{ code, signal }` when the child finally exits. */
function exitOf(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
}

beforeAll(async () => {
  testDb = await startTestDb();
});

afterAll(async () => {
  // Force-kills every worker this file spawned, including the grandchild
  // tsx spawns to actually run the entry point, and asserts (GOT.92) that
  // none survives -- whatever the tests above did or didn't clean up.
  await killAllTrackedWorkersAndAssertNoneSurvive();
  await testDb?.stop();
});

describe("worker entry point (design.md §15.2)", () => {
  it("registers, then exits 0 on SIGTERM", async () => {
    const stderr: string[] = [];
    const child = await startWorker("signal-host-1");
    child.stderr?.on("data", (c) => stderr.push(String(c)));
    child.stdout?.on("data", (c) => stderr.push(String(c)));

    const row = await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(
            `worker exited early with ${child.exitCode}: ${stderr.join("")}`,
          );
        }
        const rows = await testDb.db.select().from(agentWorkers);
        return rows.find((r) => r.host === "signal-host-1");
      },
      { timeoutMs: 20000, what: "the agent_workers row" },
    );

    expect(row.capabilities).toEqual(["node"]);
    expect(row.maxConcurrent).toBe(2);

    const exited = exitOf(child);
    killWorkerTree(child, "SIGTERM");

    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`no exit within 10s: ${stderr.join("")}`)),
          10000,
        ),
      ),
    ]);

    expect(result).toEqual({ code: 0, signal: null });
  });

  // GOT.96 fix1: the signal handler is installed before `main()`'s first
  // `await` (so tsx never force-exits before a listener exists), but the
  // shutdown log lines it emits after registration must still carry the
  // workerId field the old last-installed handler got from `log.child({
  // workerId })` -- not the bootstrap logger's fields.
  it("carries workerId on the shutdown log lines once the worker has registered", async () => {
    const lines: string[] = [];
    const onData = (chunk: unknown) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim().length > 0) lines.push(line);
      }
    };
    const child = await startWorker("signal-host-workerid");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const row = await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`worker exited early with ${child.exitCode}: ${lines.join("\n")}`);
        }
        const rows = await testDb.db.select().from(agentWorkers);
        return rows.find((r) => r.host === "signal-host-workerid");
      },
      { timeoutMs: 20000, what: "the agent_workers row" },
    );

    const exited = exitOf(child);
    killWorkerTree(child, "SIGTERM");

    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`no exit within 10s: ${lines.join("\n")}`)),
          10000,
        ),
      ),
    ]);
    expect(result).toEqual({ code: 0, signal: null });

    const records = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is Record<string, unknown> => r !== undefined);

    const shuttingDown = records.find((r) => r.msg === "shutting down");
    const shutdownComplete = records.find((r) => r.msg === "shutdown complete");

    expect(shuttingDown?.workerId).toBe(row.id);
    expect(shutdownComplete?.workerId).toBe(row.id);
  });

  // §9.9 Scheduling, C4: on a host with Docker and the agent image the
  // worker registers `docker` and builds its container stack.
  const agentImage = process.env.ORCHESTRA_TEST_AGENT_IMAGE ?? "orchestra/agent:0.0.1";
  const dockerReady =
    spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 30_000 })
      .status === 0 &&
    spawnSync("docker", ["image", "inspect", agentImage], { stdio: "ignore", timeout: 30_000 }).status === 0;
  if (!dockerReady) {
    console.warn(
      `!! SKIPPING the docker-capable worker start-up test: docker info or image ${agentImage} unavailable`,
    );
  }
  it.skipIf(!dockerReady)(
    "with Docker and the agent image, registers the docker capability and starts the container stack",
    async () => {
      const output: string[] = [];
      const child = await startWorker("signal-host-docker", { AGENT_CONTAINER_IMAGE: agentImage });
      child.stderr?.on("data", (c) => output.push(String(c)));
      child.stdout?.on("data", (c) => output.push(String(c)));

      const row = await waitFor(
        async () => {
          if (child.exitCode !== null) {
            throw new Error(`worker exited early with ${child.exitCode}: ${output.join("")}`);
          }
          const rows = await testDb.db.select().from(agentWorkers);
          return rows.find((r) => r.host === "signal-host-docker");
        },
        { timeoutMs: 20000, what: "the agent_workers row" },
      );
      expect(row.capabilities).toEqual(["node", "docker"]);
      await waitFor(
        async () => (output.join("").includes("agent container stack ready") ? true : undefined),
        { timeoutMs: 20000, what: "the container stack" },
      );

      const exited = exitOf(child);
      killWorkerTree(child, "SIGTERM");
      expect(await exited).toEqual({ code: 0, signal: null });
    },
  );

  it("fails fast with a named variable when DATABASE_URL is missing", async () => {
    const stderr: string[] = [];
    const child = spawnWorkerProcess(process.execPath, [tsxCli, entry], {
      cwd: workerDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DATABASE_URL: "" },
    });
    child.stderr?.on("data", (c) => stderr.push(String(c)));
    child.stdout?.on("data", (c) => stderr.push(String(c)));

    const { code } = await exitOf(child);

    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/DATABASE_URL/);
  });
});
