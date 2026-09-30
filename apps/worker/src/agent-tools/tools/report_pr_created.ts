import {
  appendEvent,
  latestReviewRound,
  transition,
  upsertPullRequest,
  type Tx,
} from "@orchestra/db";
import { defineTool, ReviewRequiredError } from "../tool.js";
import { revokeToken } from "../tokens.js";

const REVIEW_REQUIRED_INSTRUCTION =
  "report_pr_created needs a clean verdict for the latest review round. " +
  "Run orchestra-review, fix the findings and run it again until the verdict is clean, " +
  "then call report_pr_created again.";

/**
 * D14 order is implement, review loop, push, PR (design.md §8, GOT.97). The
 * latest round is the last `review.started` of this execution, and it must
 * have a `clean` `review.result`. Throws `ReviewRequiredError` before any
 * write otherwise, so the tool's transaction writes nothing.
 */
async function requireCleanReview(
  tx: Tx,
  taskId: string,
  executionId: string,
): Promise<void> {
  const latest = await latestReviewRound(tx, taskId, executionId);
  if (latest === null) {
    throw new ReviewRequiredError(
      `No review round has been started. Call report_review_started first. ${REVIEW_REQUIRED_INSTRUCTION}`,
    );
  }
  if (latest.verdict === null) {
    throw new ReviewRequiredError(
      `Review round ${latest.round} has no result yet. ${REVIEW_REQUIRED_INSTRUCTION}`,
    );
  }
  if (latest.verdict !== "clean") {
    throw new ReviewRequiredError(
      `Review round ${latest.round} ended with verdict ${latest.verdict}. ${REVIEW_REQUIRED_INSTRUCTION}`,
    );
  }
}

/**
 * design.md §8, §5.3: record `pull_requests`, `pull_request.created`, task
 * REVIEWING -> CI_RUNNING, execution RUNNING -> COMPLETED. The execution
 * leaves RUNNING, so the token is revoked in the same transaction (§8).
 *
 * Refused with `REVIEW_REQUIRED` unless the latest review round is clean
 * (GOT.97, `requireCleanReview`).
 *
 * GOT.39 C17: after a CI-failure resume the task already has its PR row, so
 * a second call updates that row in place (new head sha, CI back to
 * pending) instead of inserting another.
 */
export const reportPrCreated = defineTool({
  name: "report_pr_created",
  description:
    "Call once after orchestra-review returned a clean verdict for your latest review round and you have pushed your branch and opened the pull request. This completes the execution.",
  async run({ tx, auth, now, actor }, input) {
    await requireCleanReview(tx, auth.task.id, auth.execution.id);

    const pr = await upsertPullRequest(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      number: input.number,
      url: input.url,
      headSha: input.head_sha,
      now,
    });

    await appendEvent(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: "pull_request.created",
      payload: {
        pull_request_id: pr.id,
        number: input.number,
        url: input.url,
        head_sha: input.head_sha,
      },
    });

    await transition(tx, {
      entity: "task",
      id: auth.task.id,
      trigger: "pull_request.created",
      actor,
    });
    await transition(tx, {
      entity: "execution",
      id: auth.execution.id,
      trigger: "execution.completed",
      actor,
      set: { endedAt: now },
    });
    await revokeToken(tx, auth.execution.id);

    return { output: { ok: true } };
  },
});
