import { TaskState } from "@orchestra/core";
import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { appendEvent } from "../events.js";
import { pullRequests } from "../schema/pull_requests.js";
import { repositories } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
import { type Actor, transition, type Tx } from "../transition.js";
import { insertNotification, lockExecutionForTool, lockTaskForTool } from "./agent-tools.js";
import { applyCiFailure, type CiFailedCheck } from "./ci.js";

/**
 * Queries behind the GitHub poller (design.md §11.2, GOT.46). The poller
 * runs in `apps/worker`, which may not import drizzle, so every statement it
 * needs lives here.
 */

export interface OpenPullRequestRow {
  pullRequestId: string;
  taskId: string;
  executionId: string;
  jiraKey: string;
  taskState: TaskState;
  headSha: string;
  number: number;
  url: string;
  gitUrl: string;
  createdAt: Date;
  ciDetail: unknown;
}

/** Every `pull_requests` row still `open`, with what the poller needs to decide it. */
export async function listOpenPullRequests(db: Db): Promise<OpenPullRequestRow[]> {
  return db
    .select({
      pullRequestId: pullRequests.id,
      taskId: pullRequests.taskId,
      executionId: pullRequests.executionId,
      jiraKey: tasks.jiraKey,
      taskState: tasks.state,
      headSha: pullRequests.headSha,
      number: pullRequests.number,
      url: pullRequests.url,
      gitUrl: repositories.gitUrl,
      createdAt: pullRequests.createdAt,
      ciDetail: pullRequests.ciDetail,
    })
    .from(pullRequests)
    .innerJoin(tasks, eq(tasks.id, pullRequests.taskId))
    .innerJoin(repositories, eq(repositories.id, tasks.repositoryId))
    .where(eq(pullRequests.state, "open"));
}

export interface LockedPullRequestForPoll {
  prState: "open" | "merged" | "closed";
  headSha: string;
  taskState: TaskState;
}

/**
 * Locks the task, then the execution (carry-forward lock order), then
 * re-reads the task's pull request row. The poller compares `headSha` and
 * `taskState` against what it decided on at listing time, and treats a
 * mismatch as superseded rather than an error. Returns `null` when the task
 * or execution no longer exists.
 */
export async function lockPullRequestForPoll(
  tx: Tx,
  input: { taskId: string; executionId: string; pullRequestId: string },
): Promise<LockedPullRequestForPoll | null> {
  if (!(await lockTaskForTool(tx, input.taskId))) return null;
  if (!(await lockExecutionForTool(tx, input.executionId))) return null;

  const [row] = await tx
    .select({
      state: pullRequests.state,
      headSha: pullRequests.headSha,
      taskState: tasks.state,
    })
    .from(pullRequests)
    .innerJoin(tasks, eq(tasks.id, pullRequests.taskId))
    .where(eq(pullRequests.id, input.pullRequestId));
  if (!row) return null;

  return { prState: row.state, headSha: row.headSha, taskState: row.taskState };
}

/** Updates only `last_polled_at`: a row polled this run with nothing else to do. */
export async function touchPullRequestPolled(
  tx: Tx,
  pullRequestId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(pullRequests)
    .set({ lastPolledAt: now })
    .where(eq(pullRequests.id, pullRequestId));
}

/**
 * The poller's own first observation of zero check runs on the PR's current
 * sha (design.md §11.2, C50). Records `pending_since = now` in `ci_detail`
 * so the 2-minute grace period counts from here, never from
 * `pull_requests.created_at` — a row can reach zero check runs long after
 * it was created (`report_pr_created` resets it on every new push), so
 * `created_at` is never a valid stand-in for "since when has this had no
 * checks".
 */
export async function recordNoChecksPending(
  tx: Tx,
  input: { pullRequestId: string; now: Date },
): Promise<void> {
  await tx
    .update(pullRequests)
    .set({
      ciDetail: { pending_since: input.now.toISOString() },
      lastPolledAt: input.now,
    })
    .where(eq(pullRequests.id, input.pullRequestId));
}

/**
 * A new head sha at the PR's current open state (design.md §11.2): the row
 * moves to that sha, CI resets to pending with a fresh `pending_since`, and
 * no task transition happens. `report_pr_created` already reset the row for
 * a resumed execution's new PR; this is the "someone pushed to the same open
 * PR" case the poller alone observes.
 */
export async function updatePullRequestHead(
  tx: Tx,
  input: { pullRequestId: string; headSha: string; now: Date },
): Promise<void> {
  await tx
    .update(pullRequests)
    .set({
      headSha: input.headSha,
      ciState: "pending",
      ciDetail: { pending_since: input.now.toISOString() },
      lastPolledAt: input.now,
    })
    .where(eq(pullRequests.id, input.pullRequestId));
}

export interface MarkPullRequestMergedInput {
  taskId: string;
  executionId: string;
  pullRequestId: string;
  /** The task's state under the lock: `READY_FOR_MERGE` or `CI_RUNNING`. */
  taskState: TaskState;
  mergedAt: Date;
  actor: Actor;
  /** The poll's own clock (F6): distinct from `mergedAt`, which is GitHub's. */
  now: Date;
}

/**
 * The PR merged (design.md §11.2, §5.3, C34). From `READY_FOR_MERGE`, a
 * plain `pull_request.merged` -> `DONE`. From `CI_RUNNING` (a human merged
 * before CI finished), `ci.passed` -> `READY_FOR_MERGE` first, then
 * `pull_request.merged` -> `DONE`, in the same transaction.
 */
export async function markPullRequestMerged(
  tx: Tx,
  input: MarkPullRequestMergedInput,
): Promise<void> {
  if (input.taskState === TaskState.CI_RUNNING) {
    await transition(tx, {
      entity: "task",
      id: input.taskId,
      trigger: "ci.passed",
      actor: input.actor,
      // F4 (C51): a human merged before CI finished, so this ci.passed ->
      // READY_FOR_MERGE never actually observed CI passing. The marker lets
      // the Jira write-back selector (packages/db/src/queries/jira.ts) skip
      // announcing "CI passed" for a task that was merged without it.
      eventPayload: { via: "merged_externally" },
    });
    await appendEvent(tx, {
      taskId: input.taskId,
      executionId: input.executionId,
      type: "ci.passed",
      payload: { pull_request_id: input.pullRequestId },
    });
  }

  await transition(tx, {
    entity: "task",
    id: input.taskId,
    trigger: "pull_request.merged",
    actor: input.actor,
  });
  await appendEvent(tx, {
    taskId: input.taskId,
    executionId: input.executionId,
    type: "pull_request.merged",
    payload: { pull_request_id: input.pullRequestId },
  });

  await tx
    .update(pullRequests)
    .set({ state: "merged", mergedAt: input.mergedAt, lastPolledAt: input.now })
    .where(eq(pullRequests.id, input.pullRequestId));
}

export interface MarkPullRequestClosedInput {
  taskId: string;
  executionId: string;
  pullRequestId: string;
  jiraKey: string;
  /** The task's state under the lock: `READY_FOR_MERGE` or `CI_RUNNING`. */
  taskState: TaskState;
  actor: Actor;
  now: Date;
}

const CLOSED_UNMERGED_REASON = "pull request closed unmerged";

/**
 * The PR closed unmerged (design.md §11.2, §5.3, C34). From
 * `READY_FOR_MERGE`, `pull_request.closed` -> `NEEDS_HUMAN`. From
 * `CI_RUNNING`, `task.escalated` -> `NEEDS_HUMAN` with the reason, since
 * `CI_RUNNING` has no `pull_request.closed` edge.
 */
export async function markPullRequestClosed(
  tx: Tx,
  input: MarkPullRequestClosedInput,
): Promise<void> {
  if (input.taskState === TaskState.READY_FOR_MERGE) {
    await transition(tx, {
      entity: "task",
      id: input.taskId,
      trigger: "pull_request.closed",
      actor: input.actor,
      set: { needsHumanReason: CLOSED_UNMERGED_REASON },
    });
  } else {
    await transition(tx, {
      entity: "task",
      id: input.taskId,
      trigger: "task.escalated",
      actor: input.actor,
      set: { needsHumanReason: CLOSED_UNMERGED_REASON },
    });
  }

  await appendEvent(tx, {
    taskId: input.taskId,
    executionId: input.executionId,
    type: "pull_request.closed",
    payload: { pull_request_id: input.pullRequestId },
  });

  await tx
    .update(pullRequests)
    .set({ state: "closed", lastPolledAt: input.now })
    .where(eq(pullRequests.id, input.pullRequestId));

  await insertNotification(tx, {
    userId: null,
    taskId: input.taskId,
    kind: "needs_human",
    title: `Pull request closed unmerged: ${input.jiraKey}`,
    createdAt: input.now,
  });
}

/** What the poller decided from a sha's check runs (design.md §11.2). */
export type CiPollDecision =
  | { outcome: "passed"; noChecks: boolean }
  | { outcome: "failed"; checks: CiFailedCheck[] };

export interface MarkPullRequestCiInput {
  taskId: string;
  executionId: string;
  pullRequestId: string;
  headSha: string;
  jiraKey: string;
  prUrl: string;
  decision: CiPollDecision;
  actor: Actor;
  now: Date;
}

export type MarkPullRequestCiResult = { applied: true } | { applied: false; reason: string };

/**
 * The CI_RUNNING check-run decision (design.md §11.2). `passed` transitions
 * `ci.passed` -> `READY_FOR_MERGE`, records `ci_state = passed` and notifies
 * `ready_for_merge`. `failed` delegates the state machine side effects to
 * `applyCiFailure` (packages/db/src/queries/ci.ts) and, only once that
 * applied, records `ci_state = failed` with the failing checks.
 */
export async function markPullRequestCi(
  tx: Tx,
  input: MarkPullRequestCiInput,
): Promise<MarkPullRequestCiResult> {
  if (input.decision.outcome === "passed") {
    await transition(tx, {
      entity: "task",
      id: input.taskId,
      trigger: "ci.passed",
      actor: input.actor,
    });
    await appendEvent(tx, {
      taskId: input.taskId,
      executionId: input.executionId,
      type: "ci.passed",
      payload: {
        pull_request_id: input.pullRequestId,
        head_sha: input.headSha,
        ...(input.decision.noChecks ? { no_checks: true } : {}),
      },
    });
    await tx
      .update(pullRequests)
      .set({
        ciState: "passed",
        ciDetail: input.decision.noChecks ? { no_checks: true } : null,
        lastPolledAt: input.now,
      })
      .where(eq(pullRequests.id, input.pullRequestId));
    await insertNotification(tx, {
      userId: null,
      taskId: input.taskId,
      kind: "ready_for_merge",
      title: `${input.jiraKey} is ready for merge: ${input.prUrl}`,
      createdAt: input.now,
    });
    return { applied: true };
  }

  const result = await applyCiFailure(tx, {
    taskId: input.taskId,
    executionId: input.executionId,
    pullRequestId: input.pullRequestId,
    headSha: input.headSha,
    checks: input.decision.checks,
    actor: input.actor,
    now: input.now,
  });
  if (!result.applied) {
    return { applied: false, reason: result.reason };
  }

  await tx
    .update(pullRequests)
    .set({
      ciState: "failed",
      ciDetail: {
        failed: input.decision.checks.map((c) => ({ name: c.name, url: c.url })),
      },
      lastPolledAt: input.now,
    })
    .where(eq(pullRequests.id, input.pullRequestId));

  return { applied: true };
}
