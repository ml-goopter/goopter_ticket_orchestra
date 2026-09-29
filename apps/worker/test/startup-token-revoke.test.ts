import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  seedExecutionRow,
  seedTaskRow,
  startTestDb,
  waitFor,
  type TestDb,
} from "./harness.js";

/**
 * GOT.82: worker startup revokes stale spec-execution agent-tools tokens
 * before anything else accepts work. Spawns the real worker entry point,
 * the same way `shutdown.test.ts` does, against a seeded execution row
 * that looks exactly like one a crashed worker left behind on this host.
 */

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

/**
 * An image tag no host has, so the §9.9 `docker` check fails the same way on
 * every host and the worker stays in host mode (mirrors `shutdown.test.ts`).
 */
const ABSENT_AGENT_IMAGE = "orchestra/agent:absent-startup-revoke-test";

async function startWorker(host: string): Promise<{
  child: ChildProcess;
  output: string[];
}> {
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
      AGENT_CONTAINER_IMAGE: ABSENT_AGENT_IMAGE,
    },
  });
  spawned.push(child);
  const output: string[] = [];
  child.stderr?.on("data", (c) => output.push(String(c)));
  child.stdout?.on("data", (c) => output.push(String(c)));
  return { child, output };
}

beforeAll(async () => {
  testDb = await startTestDb();
});

afterAll(async () => {
  for (const child of spawned) if (child.exitCode === null) child.kill("SIGKILL");
  await testDb?.stop();
});

describe("worker startup stale spec-token revocation (GOT.82)", () => {
  it("revokes this host's RUNNING spec execution's token before logging it started, and leaves another host's alone", async () => {
    const host = "startup-revoke-host-1";
    const otherHost = "startup-revoke-host-1-other";

    const task = await seedTaskRow(testDb.db, { taskState: "IMPLEMENTING" });
    const staleSpecId = await seedExecutionRow(testDb.db, {
      taskId: task.taskId,
      role: "spec",
      state: "RUNNING",
      host,
    });
    const otherHostSpecId = await seedExecutionRow(testDb.db, {
      taskId: task.taskId,
      role: "spec",
      state: "RUNNING",
      host: otherHost,
      attempt: 2,
    });
    await testDb.db.$client.unsafe(
      "update executions set tools_token_hash = $1 where id = $2",
      ["startup-revoke-host-1-stale-token", staleSpecId],
    );
    await testDb.db.$client.unsafe(
      "update executions set tools_token_hash = $1 where id = $2",
      ["startup-revoke-host-1-other-token", otherHostSpecId],
    );

    const { child, output } = await startWorker(host);

    await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(
            `worker exited early with ${child.exitCode}: ${output.join("")}`,
          );
        }
        return output.join("").includes("revoked stale spec-execution agent-tools tokens")
          ? true
          : undefined;
      },
      { timeoutMs: 20000, what: "the startup revocation log line" },
    );

    expect(output.join("")).toMatch(/"revoked":1/);

    const staleRow = await testDb.db.query.executions.findFirst({
      where: (e, { eq }) => eq(e.id, staleSpecId),
    });
    expect(staleRow?.toolsTokenHash).toBeNull();

    const otherRow = await testDb.db.query.executions.findFirst({
      where: (e, { eq }) => eq(e.id, otherHostSpecId),
    });
    expect(otherRow?.toolsTokenHash).toBe("startup-revoke-host-1-other-token");

    // The revocation ran before the "worker started" line (runner, scheduler
    // phases and the agent-tools server accepting work).
    const combined = output.join("");
    const revokeIdx = combined.indexOf("revoked stale spec-execution agent-tools tokens");
    const startedIdx = combined.indexOf('"worker started"');
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(startedIdx).toBeGreaterThan(revokeIdx);

    child.kill("SIGTERM");
  });
});
