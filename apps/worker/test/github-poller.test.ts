import {
  executionCommands,
  executionEvents,
  executions,
  notifications,
  projects,
  pullRequests,
  repositories,
  tasks,
  type Db,
} from "@orchestra/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "../src/github/client.js";
import { createGitHubClient } from "../src/github/client.js";
import { pollGithubPullRequests } from "../src/github/poller.js";
import type { Logger } from "../src/logger.js";
import { startTestDb, type TestDb } from "./harness.js";

/**
 * GOT.46: the §11.2 GitHub poller end to end, against a real Postgres and a
 * fake-fetch GitHub double, exercising `applyCiFailure` and `transition()`
 * for real.
 */

const records: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const actor = { kind: "worker" as const, id: "github-poller-test-worker" };
const NOW = new Date("2026-09-25T10:00:00.000Z");

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(() => {
  records.length = 0;
});

afterEach(async () => {
  await db.$client.unsafe(
    "truncate table projects, audit_events restart identity cascade",
  );
});

// ---------------------------------------------------------------- seeding

let seq = 0;

interface Seeded {
  taskId: string;
  executionId: string;
  pullRequestId: string;
  jiraKey: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
}

async function seedOpenPullRequest(
  options: {
    taskState?: string;
    headSha?: string;
    ciRounds?: number;
    maxCiRounds?: number;
    createdAt?: Date;
    ciDetail?: unknown;
    prState?: "open" | "merged" | "closed";
  } = {},
): Promise<Seeded> {
  const n = ++seq;
  const owner = "goopter";
  const repo = `repo-${n}`;
  const headSha = options.headSha ?? "sha-initial";
  const [project] = await db
    .insert(projects)
    .values({
      key: `GH${n}`,
      name: `gh ${n}`,
      jiraJql: `project = GH${n}`,
      ...(options.maxCiRounds === undefined ? {} : { maxCiRounds: options.maxCiRounds }),
    })
    .returning({ id: projects.id });
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: repo,
      gitUrl: `https://github.com/${owner}/${repo}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
    })
    .returning({ id: repositories.id });
  const jiraKey = `GH-${n}`;
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repository!.id,
      jiraKey,
      jiraSummary: `gh task ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: options.taskState ?? "CI_RUNNING",
    })
    .returning({ id: tasks.id });
  const [execution] = await db
    .insert(executions)
    .values({
      taskId: task!.id,
      role: "implementation",
      attempt: 1,
      state: "COMPLETED",
      runtime: "claude",
      model: "default",
      ciRounds: options.ciRounds ?? 0,
      endedAt: NOW,
    })
    .returning({ id: executions.id });
  const [pr] = await db
    .insert(pullRequests)
    .values({
      taskId: task!.id,
      executionId: execution!.id,
      number: n,
      url: `https://github.com/${owner}/${repo}/pull/${n}`,
      headSha,
      state: options.prState ?? "open",
      ciState: "pending",
      ciDetail: options.ciDetail ?? null,
      lastPolledAt: NOW,
      createdAt: options.createdAt ?? NOW,
    })
    .returning({ id: pullRequests.id });

  return {
    taskId: task!.id,
    executionId: execution!.id,
    pullRequestId: pr!.id,
    jiraKey,
    owner,
    repo,
    number: n,
    headSha,
  };
}

// ------------------------------------------------------------------ reads

const taskRow = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const executionRow = async (id: string) =>
  (await db.query.executions.findFirst({ where: (e, { eq }) => eq(e.id, id) }))!;
const pullRequestRow = async (id: string) =>
  (await db.query.pullRequests.findFirst({ where: (p, { eq }) => eq(p.id, id) }))!;
const eventsOf = async (taskId: string, type?: string) => {
  const rows = await db.query.executionEvents.findMany({
    where: (e, { eq }) => eq(e.taskId, taskId),
    orderBy: (e, { asc }) => [asc(e.id)],
  });
  return type ? rows.filter((r) => r.type === type) : rows;
};
const commandsFor = (taskId: string) =>
  db.query.executionCommands.findMany({ where: (c, { eq }) => eq(c.taskId, taskId) });
const notificationsFor = (taskId: string) =>
  db.query.notifications.findMany({ where: (n, { eq }) => eq(n.taskId, taskId) });

// -------------------------------------------------------------- fake github

interface FakePrState {
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  head_sha: string;
}

/**
 * A fake-fetch GitHub double (design.md §11.2), keyed by owner/repo/number
 * and owner/repo/sha, routing on the URL pathname the same way the real
 * `createGitHubClient` calls it.
 */
function createFakeGitHub() {
  const prs = new Map<string, FakePrState>();
  const checks = new Map<string, unknown[]>();
  const logs = new Map<string, string>();
  let rateLimitNext = false;
  const requests: string[] = [];

  const prKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;
  const checksKey = (owner: string, repo: string, sha: string) => `${owner}/${repo}@${sha}`;

  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(input);
    requests.push(url.pathname);

    if (rateLimitNext) {
      rateLimitNext = false;
      return new Response("rate limited", { status: 429 });
    }

    const pullMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullMatch) {
      const [, owner, repo, numberStr] = pullMatch;
      const pr = prs.get(prKey(owner!, repo!, Number(numberStr)));
      if (!pr) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          state: pr.state,
          merged: pr.merged,
          merged_at: pr.merged_at,
          head: { sha: pr.head_sha },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const checksMatch = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/check-runs$/.exec(
      url.pathname,
    );
    if (checksMatch) {
      const [, owner, repo, sha] = checksMatch;
      const runs = checks.get(checksKey(owner!, repo!, sha!)) ?? [];
      return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const logMatch = /^\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/([^/]+)\/logs$/.exec(url.pathname);
    if (logMatch) {
      const jobId = logMatch[3]!;
      const log = logs.get(jobId);
      if (log === undefined) return new Response("not found", { status: 404 });
      return new Response(log, { status: 200 });
    }

    return new Response("unhandled", { status: 500 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    requests,
    setPr(owner: string, repo: string, number: number, pr: FakePrState) {
      prs.set(prKey(owner, repo, number), pr);
    },
    setCheckRuns(owner: string, repo: string, sha: string, runs: unknown[]) {
      checks.set(checksKey(owner, repo, sha), runs);
    },
    setLog(jobId: string, text: string) {
      logs.set(jobId, text);
    },
    rateLimitNextRequest() {
      rateLimitNext = true;
    },
  };
}

function successCheck(name: string, conclusion = "success") {
  return {
    name,
    status: "completed",
    conclusion,
    details_url: null,
    html_url: `https://github.com/x/y/runs/${name}`,
    external_id: null,
    app: { slug: "github-actions" },
  };
}

function failingActionsCheck(name: string, jobId: string) {
  return {
    name,
    status: "completed",
    conclusion: "failure",
    details_url: `https://github.com/x/y/actions/runs/1/jobs/${jobId}`,
    html_url: null,
    external_id: jobId,
    app: { slug: "github-actions" },
  };
}

async function run(client: GitHubClient, now: () => Date = () => NOW): Promise<void> {
  await pollGithubPullRequests({ db, client, actor, logger, now });
}

// ------------------------------------------------------------------ tests

describe("AC1: all check runs successful", () => {
  it("moves CI_RUNNING to READY_FOR_MERGE, sets ci_state passed, appends ci.passed, notifies ready_for_merge", async () => {
    const s = await seedOpenPullRequest({ headSha: "sha-1" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-1",
    });
    gh.setCheckRuns(s.owner, s.repo, "sha-1", [
      successCheck("unit"),
      successCheck("lint", "neutral"),
      successCheck("e2e", "skipped"),
    ]);
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    expect((await taskRow(s.taskId)).state).toBe("READY_FOR_MERGE");
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.ciState).toBe("passed");
    expect(await eventsOf(s.taskId, "ci.passed")).toHaveLength(1);
    const notes = await notificationsFor(s.taskId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe("ready_for_merge");
    expect(notes[0]!.title).toContain(s.jiraKey);
  });
});

describe("AC2: a failed check", () => {
  it("applies ci.failed via applyCiFailure with a 200-line log excerpt", async () => {
    const s = await seedOpenPullRequest({ headSha: "sha-2", maxCiRounds: 3 });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-2",
    });
    gh.setCheckRuns(s.owner, s.repo, "sha-2", [failingActionsCheck("unit", "555")]);
    const longLog = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n");
    gh.setLog("555", longLog);
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    expect((await taskRow(s.taskId)).state).toBe("IMPLEMENTING");
    expect((await executionRow(s.executionId)).ciRounds).toBe(1);
    expect(await eventsOf(s.taskId, "ci.failed")).toHaveLength(1);
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.ciState).toBe("failed");
    expect(pr.ciDetail).toMatchObject({
      failed: [{ name: "unit", url: "https://github.com/x/y/actions/runs/1/jobs/555" }],
    });

    const [command] = await commandsFor(s.taskId);
    expect(command!.type).toBe("resume_with_ci_failure");
    const payload = command!.payload as { checks: Array<{ log_excerpt: string }> };
    expect(payload.checks[0]!.log_excerpt.split("\n")).toHaveLength(200);
    expect(payload.checks[0]!.log_excerpt).toContain("line 250");
    expect(payload.checks[0]!.log_excerpt).not.toContain("line 50\n");
  });

  it("at the CI round limit, escalates to NEEDS_HUMAN and enqueues no command", async () => {
    const s = await seedOpenPullRequest({ headSha: "sha-3", maxCiRounds: 2, ciRounds: 2 });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-3",
    });
    gh.setCheckRuns(s.owner, s.repo, "sha-3", [failingActionsCheck("unit", "1")]);
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    expect((await taskRow(s.taskId)).state).toBe("NEEDS_HUMAN");
    expect(await commandsFor(s.taskId)).toEqual([]);
  });

  it("a stale head sha (row updated between decision and lock) applies nothing", async () => {
    const s = await seedOpenPullRequest({ headSha: "sha-4" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-4",
    });
    gh.setCheckRuns(s.owner, s.repo, "sha-4", [failingActionsCheck("unit", "1")]);
    // Simulate a concurrent report_pr_created committing a new sha for the
    // same task before this poll's transaction takes the task lock: the
    // client already returned "sha-4" for us to decide on, but the row now
    // says otherwise.
    const client: GitHubClient = {
      async getPullRequest(owner, repo, number) {
        const real = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });
        const pr = await real.getPullRequest(owner, repo, number);
        await db.$client.unsafe("update pull_requests set head_sha = $1 where id = $2", [
          "sha-4-newer",
          s.pullRequestId,
        ]);
        return pr;
      },
      listCheckRuns: (owner, repo, sha) =>
        createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl }).listCheckRuns(owner, repo, sha),
      getJobLog: (owner, repo, jobId) =>
        createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl }).getJobLog(owner, repo, jobId),
    };

    await run(client);

    expect((await taskRow(s.taskId)).state).toBe("CI_RUNNING");
    expect((await executionRow(s.executionId)).ciRounds).toBe(0);
    expect(await eventsOf(s.taskId, "ci.failed")).toEqual([]);
    expect(await commandsFor(s.taskId)).toEqual([]);
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.headSha).toBe("sha-4-newer");
    expect(pr.lastPolledAt.toISOString()).toBe(NOW.toISOString());
  });
});

describe("AC3: new head sha on an open PR", () => {
  it("updates head_sha, resets ci_state to pending with pending_since, and does not transition", async () => {
    const s = await seedOpenPullRequest({ headSha: "sha-old" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-new",
    });
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    expect((await taskRow(s.taskId)).state).toBe("CI_RUNNING");
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.headSha).toBe("sha-new");
    expect(pr.ciState).toBe("pending");
    expect(pr.ciDetail).toMatchObject({ pending_since: NOW.toISOString() });
    expect(await eventsOf(s.taskId)).toEqual([]);
  });
});

describe("AC4: merged", () => {
  it("READY_FOR_MERGE -> DONE with pull_request.merged, state merged and merged_at", async () => {
    const s = await seedOpenPullRequest({ taskState: "READY_FOR_MERGE", headSha: "sha-5" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "closed",
      merged: true,
      merged_at: "2026-09-25T09:00:00.000Z",
      head_sha: "sha-5",
    });
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    expect((await taskRow(s.taskId)).state).toBe("DONE");
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.state).toBe("merged");
    expect(pr.mergedAt?.toISOString()).toBe("2026-09-25T09:00:00.000Z");
    expect(await eventsOf(s.taskId, "pull_request.merged")).toHaveLength(1);
  });

  it("CI_RUNNING -> ci.passed then DONE in one transaction", async () => {
    const s = await seedOpenPullRequest({ taskState: "CI_RUNNING", headSha: "sha-6" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "closed",
      merged: true,
      merged_at: "2026-09-25T09:00:00.000Z",
      head_sha: "sha-6",
    });
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    expect((await taskRow(s.taskId)).state).toBe("DONE");
    expect(await eventsOf(s.taskId, "ci.passed")).toHaveLength(1);
    expect(await eventsOf(s.taskId, "pull_request.merged")).toHaveLength(1);
    const stateChanges = await eventsOf(s.taskId, "task.state_changed");
    expect(stateChanges.map((e) => (e.payload as { to: string }).to)).toEqual([
      "READY_FOR_MERGE",
      "DONE",
    ]);
  });
});

describe("AC5: closed unmerged", () => {
  it("READY_FOR_MERGE -> NEEDS_HUMAN via pull_request.closed, with a needs_human notification", async () => {
    const s = await seedOpenPullRequest({ taskState: "READY_FOR_MERGE", headSha: "sha-7" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "closed",
      merged: false,
      merged_at: null,
      head_sha: "sha-7",
    });
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    const t = await taskRow(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(await eventsOf(s.taskId, "pull_request.closed")).toHaveLength(1);
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.state).toBe("closed");
    const notes = await notificationsFor(s.taskId);
    expect(notes.some((n) => n.kind === "needs_human")).toBe(true);
  });

  it("CI_RUNNING -> NEEDS_HUMAN via task.escalated with the reason", async () => {
    const s = await seedOpenPullRequest({ taskState: "CI_RUNNING", headSha: "sha-8" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "closed",
      merged: false,
      merged_at: null,
      head_sha: "sha-8",
    });
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    const t = await taskRow(s.taskId);
    expect(t.state).toBe("NEEDS_HUMAN");
    expect(t.needsHumanReason).toBe("pull request closed unmerged");
    expect(await eventsOf(s.taskId, "pull_request.closed")).toHaveLength(1);
  });
});

describe("AC6: zero check runs", () => {
  it("does nothing within the 2-minute grace period", async () => {
    const s = await seedOpenPullRequest({ headSha: "sha-9", createdAt: NOW });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-9",
    });
    gh.setCheckRuns(s.owner, s.repo, "sha-9", []);
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });
    const oneMinuteLater = new Date(NOW.getTime() + 60_000);

    await run(client, () => oneMinuteLater);

    expect((await taskRow(s.taskId)).state).toBe("CI_RUNNING");
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.ciState).toBe("pending");
    expect(pr.lastPolledAt.toISOString()).toBe(oneMinuteLater.toISOString());
  });

  it("treats zero check runs older than 2 minutes as passed, with no_checks", async () => {
    const s = await seedOpenPullRequest({ headSha: "sha-10", createdAt: NOW });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-10",
    });
    gh.setCheckRuns(s.owner, s.repo, "sha-10", []);
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });
    const threeMinutesLater = new Date(NOW.getTime() + 3 * 60_000);

    await run(client, () => threeMinutesLater);

    expect((await taskRow(s.taskId)).state).toBe("READY_FOR_MERGE");
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.ciState).toBe("passed");
    expect(pr.ciDetail).toEqual({ no_checks: true });
  });
});

describe("AC7: in-progress checks and non-actionable states", () => {
  it("a still-running check only updates last_polled_at", async () => {
    const s = await seedOpenPullRequest({ headSha: "sha-11" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-11",
    });
    gh.setCheckRuns(s.owner, s.repo, "sha-11", [
      { name: "unit", status: "in_progress", conclusion: null, details_url: null, html_url: null, external_id: null, app: null },
    ]);
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });
    const later = new Date(NOW.getTime() + 1000);

    await run(client, () => later);

    expect((await taskRow(s.taskId)).state).toBe("CI_RUNNING");
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.ciState).toBe("pending");
    expect(pr.lastPolledAt.toISOString()).toBe(later.toISOString());
    expect(await eventsOf(s.taskId)).toEqual([]);
  });

  it("a task not in CI_RUNNING (e.g. IMPLEMENTING) only updates last_polled_at", async () => {
    const s = await seedOpenPullRequest({ taskState: "IMPLEMENTING", headSha: "sha-12" });
    const gh = createFakeGitHub();
    gh.setPr(s.owner, s.repo, s.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-12",
    });
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });
    const later = new Date(NOW.getTime() + 1000);

    await run(client, () => later);

    expect((await taskRow(s.taskId)).state).toBe("IMPLEMENTING");
    const pr = await pullRequestRow(s.pullRequestId);
    expect(pr.lastPolledAt.toISOString()).toBe(later.toISOString());
    expect(await eventsOf(s.taskId)).toEqual([]);
    expect(gh.requests.some((p) => p.includes("check-runs"))).toBe(false);
  });
});

describe("AC8: one row's GitHub error does not stop the others", () => {
  it("a 404 on one PR leaves it untouched and logs at warn; the next PR still polls", async () => {
    const missing = await seedOpenPullRequest({ headSha: "sha-13" });
    const ok = await seedOpenPullRequest({ taskState: "READY_FOR_MERGE", headSha: "sha-14" });
    const gh = createFakeGitHub();
    // `missing` has no PR registered in the fake, so its lookup 404s.
    gh.setPr(ok.owner, ok.repo, ok.number, {
      state: "closed",
      merged: true,
      merged_at: "2026-09-25T09:00:00.000Z",
      head_sha: "sha-14",
    });
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    expect((await taskRow(missing.taskId)).state).toBe("CI_RUNNING");
    expect(records.some((r) => r.level === "warn")).toBe(true);
    expect((await taskRow(ok.taskId)).state).toBe("DONE");
  });

  it("rate limiting stops the run early with a warning, leaving the next row unpolled", async () => {
    const first = await seedOpenPullRequest({ headSha: "sha-15" });
    const second = await seedOpenPullRequest({ headSha: "sha-16" });
    const gh = createFakeGitHub();
    gh.setPr(first.owner, first.repo, first.number, {
      state: "open",
      merged: false,
      merged_at: null,
      head_sha: "sha-15",
    });
    gh.rateLimitNextRequest();
    const client = createGitHubClient({ token: "t", fetchImpl: gh.fetchImpl });

    await run(client);

    expect(records.some((r) => r.level === "warn" && r.msg.includes("rate limited"))).toBe(true);
    const secondRow = await pullRequestRow(second.pullRequestId);
    expect(secondRow.lastPolledAt.toISOString()).toBe(NOW.toISOString());
  });
});
