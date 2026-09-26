import { TaskState } from "@orchestra/core";
import {
  listOpenPullRequests,
  lockPullRequestForPoll,
  markPullRequestCi,
  markPullRequestClosed,
  markPullRequestMerged,
  touchPullRequestPolled,
  updatePullRequestHead,
  type Actor,
  type CiFailedCheck,
  type CiPollDecision,
  type Db,
  type OpenPullRequestRow,
} from "@orchestra/db";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  GitHubApiError,
  createGitHubClient,
  parseRepositoryGitUrl,
  type GitHubCheckRun,
  type GitHubClient,
} from "./client.js";
import { fetchLogExcerpt } from "./log-excerpt.js";

/** design.md §11.2: every 60 seconds, up to 10% jitter, matching the Jira poller. */
export const DEFAULT_GITHUB_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_GITHUB_POLL_JITTER_RATIO = 0.1;

/** design.md §11.2: zero check runs after this long from `pending_since` counts as passed. */
export const NO_CHECKS_GRACE_MS = 2 * 60_000;

const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export type CheckRunsEvaluation =
  | { outcome: "no_checks" }
  | { outcome: "in_progress" }
  | { outcome: "passed" }
  | { outcome: "failed"; failing: GitHubCheckRun[] };

/**
 * design.md §11.2: any completed check whose conclusion is not success,
 * neutral or skipped fails the PR outright, even while other checks are
 * still running. Only when every run has completed and none failed is the
 * PR passed; otherwise the poller waits for the next cycle.
 */
export function evaluateCheckRuns(runs: GitHubCheckRun[]): CheckRunsEvaluation {
  if (runs.length === 0) return { outcome: "no_checks" };

  const failing = runs.filter(
    (run) => run.status === "completed" && !SUCCESS_CONCLUSIONS.has(run.conclusion ?? ""),
  );
  if (failing.length > 0) return { outcome: "failed", failing };

  const allCompleted = runs.every((run) => run.status === "completed");
  return allCompleted ? { outcome: "passed" } : { outcome: "in_progress" };
}

/** `ci_detail.pending_since` written by `updatePullRequestHead` (C36), if present. */
export function parsePendingSince(ciDetail: unknown): Date | undefined {
  if (!ciDetail || typeof ciDetail !== "object") return undefined;
  const value = (ciDetail as { pending_since?: unknown }).pending_since;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Decision =
  | { type: "merged"; mergedAt: Date }
  | { type: "closed" }
  | { type: "new_sha"; headSha: string }
  | { type: "not_actionable" }
  | { type: "wait" }
  | { type: "ci"; decision: CiPollDecision };

interface PollOneOptions {
  db: Db;
  client: GitHubClient;
  actor: Actor;
  logger: Logger;
  now: () => Date;
  row: OpenPullRequestRow;
  owner: string;
  repo: string;
}

/**
 * Fetches the PR, decides the outcome (design.md §11.2), then applies it in
 * one transaction that locks the task, then the execution, then re-reads the
 * pull request row: a head sha or state change since the row was listed
 * means another writer already handled it, so this poll applies nothing.
 * Returns `rateLimited: true` when GitHub itself asked to be backed off.
 */
async function pollOnePullRequest(options: PollOneOptions): Promise<{ rateLimited: boolean }> {
  const { db, client, actor, logger, now, row, owner, repo } = options;

  let pr;
  try {
    pr = await client.getPullRequest(owner, repo, row.number);
  } catch (err) {
    if (err instanceof GitHubApiError && err.rateLimited) return { rateLimited: true };
    if (err instanceof GitHubApiError && err.status === 404) {
      logger.warn(
        { pullRequestId: row.pullRequestId, taskId: row.taskId, number: row.number },
        "pull request not found on GitHub; left open for the next poll",
      );
      return { rateLimited: false };
    }
    throw err;
  }

  let decision: Decision;
  if (pr.merged) {
    decision = { type: "merged", mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : now() };
  } else if (pr.state === "closed") {
    decision = { type: "closed" };
  } else if (pr.headSha !== row.headSha) {
    decision = { type: "new_sha", headSha: pr.headSha };
  } else if (row.taskState !== TaskState.CI_RUNNING) {
    // design.md §11.2: only act on CI results while CI_RUNNING.
    decision = { type: "not_actionable" };
  } else {
    let checkRuns: GitHubCheckRun[];
    try {
      checkRuns = await client.listCheckRuns(owner, repo, pr.headSha);
    } catch (err) {
      if (err instanceof GitHubApiError && err.rateLimited) return { rateLimited: true };
      throw err;
    }

    const evaluation = evaluateCheckRuns(checkRuns);
    if (evaluation.outcome === "passed") {
      decision = { type: "ci", decision: { outcome: "passed", noChecks: false } };
    } else if (evaluation.outcome === "in_progress") {
      decision = { type: "wait" };
    } else if (evaluation.outcome === "no_checks") {
      const pendingSince = parsePendingSince(row.ciDetail) ?? row.createdAt;
      const elapsed = now().getTime() - pendingSince.getTime();
      decision =
        elapsed >= NO_CHECKS_GRACE_MS
          ? { type: "ci", decision: { outcome: "passed", noChecks: true } }
          : { type: "wait" };
    } else {
      const checks: CiFailedCheck[] = [];
      for (const failing of evaluation.failing) {
        checks.push({
          name: failing.name,
          url: failing.htmlUrl ?? failing.detailsUrl ?? "",
          log_excerpt: await fetchLogExcerpt(client, owner, repo, failing),
        });
      }
      decision = { type: "ci", decision: { outcome: "failed", checks } };
    }
  }

  const outcome = await db.transaction(async (tx) => {
    const locked = await lockPullRequestForPoll(tx, {
      taskId: row.taskId,
      executionId: row.executionId,
      pullRequestId: row.pullRequestId,
    });
    if (!locked || locked.headSha !== row.headSha || locked.prState !== "open") {
      return { kind: "stale" as const };
    }

    switch (decision.type) {
      case "merged": {
        if (
          locked.taskState !== TaskState.READY_FOR_MERGE &&
          locked.taskState !== TaskState.CI_RUNNING
        ) {
          await touchPullRequestPolled(tx, row.pullRequestId, now());
          return { kind: "not_actionable" as const, taskState: locked.taskState };
        }
        await markPullRequestMerged(tx, {
          taskId: row.taskId,
          executionId: row.executionId,
          pullRequestId: row.pullRequestId,
          taskState: locked.taskState,
          mergedAt: decision.mergedAt,
          actor,
        });
        return { kind: "applied" as const };
      }
      case "closed": {
        if (
          locked.taskState !== TaskState.READY_FOR_MERGE &&
          locked.taskState !== TaskState.CI_RUNNING
        ) {
          await touchPullRequestPolled(tx, row.pullRequestId, now());
          return { kind: "not_actionable" as const, taskState: locked.taskState };
        }
        await markPullRequestClosed(tx, {
          taskId: row.taskId,
          executionId: row.executionId,
          pullRequestId: row.pullRequestId,
          jiraKey: row.jiraKey,
          taskState: locked.taskState,
          actor,
          now: now(),
        });
        return { kind: "applied" as const };
      }
      case "new_sha": {
        await updatePullRequestHead(tx, {
          pullRequestId: row.pullRequestId,
          headSha: decision.headSha,
          now: now(),
        });
        return { kind: "applied" as const };
      }
      case "not_actionable": {
        await touchPullRequestPolled(tx, row.pullRequestId, now());
        return { kind: "not_actionable" as const, taskState: locked.taskState };
      }
      case "wait": {
        await touchPullRequestPolled(tx, row.pullRequestId, now());
        return { kind: "waiting" as const };
      }
      case "ci": {
        if (locked.taskState !== TaskState.CI_RUNNING) {
          await touchPullRequestPolled(tx, row.pullRequestId, now());
          return { kind: "not_actionable" as const, taskState: locked.taskState };
        }
        const result = await markPullRequestCi(tx, {
          taskId: row.taskId,
          executionId: row.executionId,
          pullRequestId: row.pullRequestId,
          headSha: row.headSha,
          jiraKey: row.jiraKey,
          prUrl: row.url,
          decision: decision.decision,
          actor,
          now: now(),
        });
        if (!result.applied) {
          return { kind: "ci_skipped" as const, reason: result.reason };
        }
        return { kind: "applied" as const };
      }
    }
  });

  if (outcome.kind === "stale") {
    logger.info(
      { pullRequestId: row.pullRequestId, taskId: row.taskId },
      "pull request superseded since listing; poll skipped",
    );
  } else if (outcome.kind === "not_actionable") {
    logger.debug(
      { pullRequestId: row.pullRequestId, taskId: row.taskId, taskState: outcome.taskState },
      "task not in an actionable state for this pull request outcome",
    );
  } else if (outcome.kind === "ci_skipped") {
    logger.info(
      { pullRequestId: row.pullRequestId, taskId: row.taskId, reason: outcome.reason },
      "ci failure not applied: pull request superseded",
    );
  }

  return { rateLimited: false };
}

export interface PollGithubPullRequestsOptions {
  db: Db;
  client: GitHubClient;
  actor: Actor;
  logger: Logger;
  now?: () => Date;
}

/**
 * One pass over every open `pull_requests` row (design.md §11.2). A GitHub
 * error on one row is logged and the loop continues; rate limiting stops
 * this run early with a warning so the next scheduled run backs off
 * naturally.
 */
export async function pollGithubPullRequests(
  options: PollGithubPullRequestsOptions,
): Promise<void> {
  const { db, client, actor, logger, now = () => new Date() } = options;

  let rows: OpenPullRequestRow[];
  try {
    rows = await listOpenPullRequests(db);
  } catch (err) {
    logger.error({ err: errMsg(err) }, "listing open pull requests failed");
    return;
  }

  for (const row of rows) {
    let owner: string;
    let repo: string;
    try {
      ({ owner, repo } = parseRepositoryGitUrl(row.gitUrl));
    } catch (err) {
      logger.error(
        { pullRequestId: row.pullRequestId, taskId: row.taskId, err: errMsg(err) },
        "cannot parse owner/repo from repository git url",
      );
      continue;
    }

    try {
      const { rateLimited } = await pollOnePullRequest({
        db,
        client,
        actor,
        logger,
        now,
        row,
        owner,
        repo,
      });
      if (rateLimited) {
        logger.warn({}, "GitHub rate limited; stopping this poll run early");
        return;
      }
    } catch (err) {
      logger.error(
        { pullRequestId: row.pullRequestId, taskId: row.taskId, err: errMsg(err) },
        "polling pull request failed",
      );
    }
  }
}

export interface StartGitHubPollerOptions {
  db: Db;
  config: WorkerConfig;
  workerId: string;
  logger: Logger;
  intervalMs?: number;
  jitterRatio?: number;
  now?: () => Date;
  /** Injectable for tests; defaults to a real client built from `config`. */
  client?: GitHubClient;
}

export type StopGitHubPoller = () => Promise<void>;

/**
 * Starts the GitHub poller: one loop, every `intervalMs` with up to
 * `jitterRatio` jitter (design.md §11.2). Missing `GITHUB_TOKEN` logs one
 * warning and returns a no-op stop function; the worker still starts.
 */
export function startGitHubPoller(options: StartGitHubPollerOptions): StopGitHubPoller {
  const {
    db,
    config,
    workerId,
    logger,
    intervalMs = DEFAULT_GITHUB_POLL_INTERVAL_MS,
    jitterRatio = DEFAULT_GITHUB_POLL_JITTER_RATIO,
    now = () => new Date(),
  } = options;

  if (!config.githubToken) {
    logger.warn({}, "GITHUB_TOKEN is missing; GitHub poller not started");
    return async () => {};
  }

  const client = options.client ?? createGitHubClient({ token: config.githubToken });
  const actor: Actor = { kind: "worker", id: workerId };

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  function scheduleNext(): void {
    if (stopped) return;
    const jitter = intervalMs * jitterRatio * Math.random();
    timer = setTimeout(() => void run(), intervalMs + jitter);
  }

  async function run(): Promise<void> {
    if (stopped) return;
    inFlight = (async () => {
      try {
        await pollGithubPullRequests({ db, client, actor, logger, now });
      } catch (err) {
        logger.error({ err: errMsg(err) }, "github poll run failed");
      }
    })();

    try {
      await inFlight;
    } finally {
      inFlight = undefined;
      scheduleNext();
    }
  }

  scheduleNext();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}
