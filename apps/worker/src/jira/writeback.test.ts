import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { JiraClient } from "./client.js";
import { startJiraWriteback } from "./writeback.js";

/** Only the fields `loadConfig` would set; the writeback loop reads nothing else. */
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
    jiraBaseUrl: "https://goopter.atlassian.net",
    jiraEmail: "bot@goopter.dev",
    jiraApiToken: "token",
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

function fakeClient(): JiraClient {
  return {
    search: vi.fn(),
    issueExists: vi.fn(),
    getIssue: vi.fn(),
    addComment: vi.fn(),
  };
}

/**
 * A minimal drizzle-shaped stub for the two query shapes the writeback loop
 * uses: `maxExecutionEventId` awaits `.from()` directly, `listJiraWritebackEvents`
 * chains `.from().innerJoin().leftJoin().where().orderBy().limit()`. Both
 * always resolve to no rows, matching `apps/worker/test/jira-poller.test.ts`'s
 * `fakeProjectsDb` pattern.
 */
function fakeEmptyDb() {
  const from = () =>
    Object.assign(Promise.resolve([]), {
      innerJoin: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    });
  const select = vi.fn(() => ({ from }));
  return { select };
}

beforeEach(() => {
  records.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startJiraWriteback credential gate (design.md §11.1, E4)", () => {
  it("does not start and logs one warning when JIRA_BASE_URL is missing", async () => {
    const client = fakeClient();
    const stop = startJiraWriteback({
      db: {} as never,
      config: configWith({ jiraBaseUrl: undefined }),
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(client.getIssue).not.toHaveBeenCalled();
    expect(client.addComment).not.toHaveBeenCalled();
    expect(records.filter((r) => r.level === "warn")).toHaveLength(1);
    await stop();
  });

  it("does not start when JIRA_EMAIL or JIRA_API_TOKEN is missing", async () => {
    const client = fakeClient();
    const stopA = startJiraWriteback({
      db: {} as never,
      config: configWith({ jiraEmail: undefined }),
      logger,
      client,
    });
    const stopB = startJiraWriteback({
      db: {} as never,
      config: configWith({ jiraApiToken: undefined }),
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.addComment).not.toHaveBeenCalled();
    await stopA();
    await stopB();
  });
});

describe("startJiraWriteback loop (design.md §11.1, C10)", () => {
  it("runs on an interval-plus-jitter cadence and stops cleanly", async () => {
    const client = fakeClient();
    const db = fakeEmptyDb();

    const stop = startJiraWriteback({
      db: db as never,
      config: configWith(),
      logger,
      client,
      intervalMs: 1000,
      jitterRatio: 0,
    });

    // First run: initializes the cursor (one `select`) then lists events
    // (a second `select`).
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.select).toHaveBeenCalledTimes(2);

    // Second run: cursor already initialized, only the list query runs.
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.select).toHaveBeenCalledTimes(3);

    await stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(db.select).toHaveBeenCalledTimes(3);
  });
});
