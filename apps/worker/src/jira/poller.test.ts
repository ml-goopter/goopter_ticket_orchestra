import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { startJiraPoller } from "./poller.js";
import type { JiraClient } from "./client.js";

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

/**
 * A minimal drizzle-shaped stub: `listJiraProjects` awaits `.from()`
 * directly, `listNonTerminalJiraTasks` chains `.from().where()`. Returning a
 * promise with a `.where()` method satisfies both call sites.
 */
function fakeProjectsDb(
  projects: Array<{ id: string; key: string; jiraJql: string }>,
) {
  return {
    select: () => ({
      from: () =>
        Object.assign(Promise.resolve(projects), {
          where: () => Promise.resolve([]),
        }),
    }),
  };
}

beforeEach(() => {
  records.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startJiraPoller credential gate (design.md §11.1, E4, C7)", () => {
  it("does not start and logs one warning when JIRA_BASE_URL is missing", async () => {
    const client = { search: vi.fn(), issueExists: vi.fn(), getIssue: vi.fn() } satisfies JiraClient;
    const stop = startJiraPoller({
      db: {} as never,
      config: configWith({ jiraBaseUrl: undefined }),
      workerId: "worker-1",
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(client.search).not.toHaveBeenCalled();
    expect(client.issueExists).not.toHaveBeenCalled();
    expect(records.filter((r) => r.level === "warn")).toHaveLength(1);
    await stop();
  });

  it("does not start when JIRA_EMAIL or JIRA_API_TOKEN is missing", async () => {
    const client = { search: vi.fn(), issueExists: vi.fn(), getIssue: vi.fn() } satisfies JiraClient;
    const stopA = startJiraPoller({
      db: {} as never,
      config: configWith({ jiraEmail: undefined }),
      workerId: "worker-1",
      logger,
      client,
    });
    const stopB = startJiraPoller({
      db: {} as never,
      config: configWith({ jiraApiToken: undefined }),
      workerId: "worker-1",
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.search).not.toHaveBeenCalled();
    await stopA();
    await stopB();
  });
});

describe("startJiraPoller loop (design.md §11.1, E5)", () => {
  it("polls every project in sequence on a 60s cadence and stops cleanly", async () => {
    const client = {
      search: vi.fn(async () => []),
      issueExists: vi.fn(),
      getIssue: vi.fn(),
    } satisfies JiraClient;

    // `listJiraProjects` is imported from `@orchestra/db` inside poller.ts;
    // stub it at the module boundary so this test needs no real database.
    const dbStub = fakeProjectsDb([{ id: "p1", key: "GOOP", jiraJql: "project = GOOP" }]);

    const stop = startJiraPoller({
      db: dbStub as never,
      config: configWith(),
      workerId: "worker-1",
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(70_000);
    expect(client.search).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(70_000);
    expect(client.search).toHaveBeenCalledTimes(2);

    await stop();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it("an error on one project does not stop the loop (C6)", async () => {
    const client = {
      search: vi.fn(async () => {
        throw new Error("network error");
      }),
      issueExists: vi.fn(),
      getIssue: vi.fn(),
    } satisfies JiraClient;

    const dbStub = fakeProjectsDb([{ id: "p1", key: "GOOP", jiraJql: "project = GOOP" }]);

    const stop = startJiraPoller({
      db: dbStub as never,
      config: configWith(),
      workerId: "worker-1",
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(70_000);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(client.search).toHaveBeenCalledTimes(2);

    await stop();
  });

  it("stop() called mid-cycle skips the remaining projects (F2 regression)", async () => {
    const searchCalls: string[] = [];
    let resolveFirstSearch: (() => void) | undefined;
    const client = {
      search: vi.fn(async (jql: string) => {
        searchCalls.push(jql);
        if (searchCalls.length === 1) {
          // Pause the first project's search so the test can call stop()
          // while the cycle is still in progress.
          await new Promise<void>((resolve) => {
            resolveFirstSearch = resolve;
          });
        }
        return [];
      }),
      issueExists: vi.fn(),
      getIssue: vi.fn(),
    } satisfies JiraClient;

    const dbStub = fakeProjectsDb([
      { id: "p1", key: "GOOP", jiraJql: "project = GOOP" },
      { id: "p2", key: "OTHER", jiraJql: "project = OTHER" },
    ]);

    const stop = startJiraPoller({
      db: dbStub as never,
      config: configWith(),
      workerId: "worker-1",
      logger,
      client,
    });

    await vi.advanceTimersByTimeAsync(70_000);
    expect(searchCalls).toHaveLength(1);

    const stopPromise = stop();
    resolveFirstSearch?.();
    await stopPromise;

    expect(searchCalls).toHaveLength(1);
  });
});
