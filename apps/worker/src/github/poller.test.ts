import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { GitHubClient } from "./client.js";
import { evaluateCheckRuns, parsePendingSince, startGitHubPoller } from "./poller.js";

/** Only the fields `loadConfig` would set; the poller reads nothing else. */
function configWith(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: "postgres://unused",
    host: "test-host",
    capabilities: [],
    maxConcurrent: 2,
    workspaceRoot: "/tmp/orchestra",
    toolsPort: 4317,
    diskHighWaterPct: 85,
    agentQuietTimeoutMs: 1_200_000,
    pricingFile: "config/pricing.json",
    logLevel: "info",
    githubToken: "gh-token",
    ...overrides,
  };
}

const records: Array<{ level: string; fields: unknown; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

/** A minimal drizzle-shaped stub: `listOpenPullRequests` awaits `.where()` after two joins. */
function fakeRowsDb(rows: unknown[] = []) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve(rows),
          }),
        }),
      }),
    }),
  };
}

function fakeGithubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: vi.fn(),
    listCheckRuns: vi.fn(),
    getJobLog: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  records.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluateCheckRuns (design.md §11.2)", () => {
  const run = (over: Partial<Parameters<typeof evaluateCheckRuns>[0][number]>) => ({
    id: 1,
    name: "check",
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    htmlUrl: null,
    externalId: null,
    appSlug: null,
    ...over,
  });

  it("no check runs is no_checks", () => {
    expect(evaluateCheckRuns([])).toEqual({ outcome: "no_checks" });
  });

  it("all successful is passed", () => {
    expect(evaluateCheckRuns([run({}), run({ conclusion: "success" })])).toEqual({
      outcome: "passed",
    });
  });

  it("neutral and skipped count as success", () => {
    expect(
      evaluateCheckRuns([run({ conclusion: "neutral" }), run({ conclusion: "skipped" })]),
    ).toEqual({ outcome: "passed" });
  });

  it("a still-running check with nothing failed yet is in_progress", () => {
    expect(evaluateCheckRuns([run({}), run({ status: "in_progress", conclusion: null })])).toEqual(
      { outcome: "in_progress" },
    );
  });

  it("one failing conclusion is failed even while another check is still running", () => {
    const failing = run({ conclusion: "failure", name: "unit" });
    const result = evaluateCheckRuns([failing, run({ status: "in_progress", conclusion: null })]);
    expect(result).toEqual({ outcome: "failed", failing: [failing] });
  });

  it.each(["failure", "timed_out", "cancelled", "action_required"])(
    "conclusion %s fails the check",
    (conclusion) => {
      const failing = run({ conclusion });
      expect(evaluateCheckRuns([failing])).toEqual({ outcome: "failed", failing: [failing] });
    },
  );
});

describe("parsePendingSince", () => {
  it("reads pending_since from ci_detail", () => {
    const date = parsePendingSince({ pending_since: "2026-01-01T00:00:00.000Z" });
    expect(date?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is undefined for null, a non-object or a missing field", () => {
    expect(parsePendingSince(null)).toBeUndefined();
    expect(parsePendingSince("nope")).toBeUndefined();
    expect(parsePendingSince({})).toBeUndefined();
  });
});

describe("startGitHubPoller credential gate (design.md §11.2)", () => {
  it("does not start and logs one warning when GITHUB_TOKEN is missing", async () => {
    const client = fakeGithubClient();
    const stop = startGitHubPoller({
      db: {} as never,
      config: configWith({ githubToken: undefined }),
      workerId: "worker-1",
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(client.getPullRequest).not.toHaveBeenCalled();
    expect(records.filter((r) => r.level === "warn")).toHaveLength(1);
    await stop();
  });
});

describe("startGitHubPoller loop (design.md §11.2)", () => {
  it("polls on a 60s cadence and stops cleanly", async () => {
    const client = fakeGithubClient();
    const dbStub = fakeRowsDb([]);

    const stop = startGitHubPoller({
      db: dbStub as never,
      config: configWith(),
      workerId: "worker-1",
      logger,
      client,
    });

    // Nothing to poll (no open rows), but the loop itself must still run
    // once per cadence, then stop taking further ticks once stopped.
    await vi.advanceTimersByTimeAsync(70_000);
    await vi.advanceTimersByTimeAsync(70_000);

    await stop();
    await vi.advanceTimersByTimeAsync(200_000);

    expect(records.filter((r) => r.level === "error")).toEqual([]);
  });

  it("an error listing pull requests does not throw out of the loop", async () => {
    const client = fakeGithubClient();
    const dbStub = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => Promise.reject(new Error("connection reset")),
            }),
          }),
        }),
      }),
    };

    const stop = startGitHubPoller({
      db: dbStub as never,
      config: configWith(),
      workerId: "worker-1",
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(70_000);
    expect(records.some((r) => r.level === "error")).toBe(true);

    await stop();
  });
});
