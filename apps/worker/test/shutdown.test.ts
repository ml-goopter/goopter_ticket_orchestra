import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { agentWorkers } from "@orchestra/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, waitFor, type TestDb } from "./harness.js";

const tsxCli = fileURLToPath(
  new URL("./dist/cli.mjs", import.meta.resolve("tsx/package.json")),
);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const workerDir = fileURLToPath(new URL("..", import.meta.url));

let testDb: TestDb;
const spawned: ChildProcess[] = [];

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

async function startWorker(host: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [tsxCli, entry], {
    cwd: workerDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL: testDb.connectionString,
      WORKER_HOST: host,
      WORKER_CAPABILITIES: "node",
      WORKER_TOOLS_PORT: String(await freePort()),
      LOG_LEVEL: "debug",
    },
  });
  spawned.push(child);
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
  for (const child of spawned) if (child.exitCode === null) child.kill("SIGKILL");
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
    child.kill("SIGTERM");

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

  it("fails fast with a named variable when DATABASE_URL is missing", async () => {
    const stderr: string[] = [];
    const child = spawn(process.execPath, [tsxCli, entry], {
      cwd: workerDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DATABASE_URL: "" },
    });
    spawned.push(child);
    child.stderr?.on("data", (c) => stderr.push(String(c)));
    child.stdout?.on("data", (c) => stderr.push(String(c)));

    const { code } = await exitOf(child);

    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/DATABASE_URL/);
  });
});
