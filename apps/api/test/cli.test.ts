import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessions, users } from "@orchestra/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type TestDb, startTestDb, testConfig } from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(__dirname, "..");
const tsxBin = path.join(apiRoot, "node_modules", ".bin", "tsx");
const cliEntry = path.join(apiRoot, "src", "cli", "users-add.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: apiRoot,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("users:add CLI (AC6)", () => {
  let testDb: TestDb;
  let env: Record<string, string>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const config = testConfig({ DATABASE_URL: testDb.connectionString });
    env = {
      DATABASE_URL: config.DATABASE_URL,
      SESSION_SECRET: config.SESSION_SECRET,
    };
  }, 120000);

  afterAll(async () => {
    await testDb?.stop();
  }, 120000);

  afterEach(async () => {
    await testDb.db.delete(sessions);
    await testDb.db.delete(users);
  });

  it(
    "creates a user non-interactively via PASSWORD and exits 0",
    async () => {
      const result = await runCli(
        ["cli-created@example.com", "--name", "CLI Created"],
        { ...env, PASSWORD: "a very long password" },
      );
      expect(result.code).toBe(0);
    },
    30000,
  );

  it(
    "exits 1 with a clear message for a duplicate email",
    async () => {
      const first = await runCli(["dup-cli@example.com"], {
        ...env,
        PASSWORD: "a very long password",
      });
      expect(first.code).toBe(0);

      const second = await runCli(["dup-cli@example.com"], {
        ...env,
        PASSWORD: "another long password",
      });
      expect(second.code).toBe(1);
      expect(second.stderr).toMatch(/already exists/i);
    },
    30000,
  );

  it(
    "exits 1 with a clear message for a password shorter than 12 characters",
    async () => {
      const result = await runCli(["weak-pw@example.com"], {
        ...env,
        PASSWORD: "short",
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/12 characters/i);
    },
    30000,
  );
});
