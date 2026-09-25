import { REVIEW_ROUND_LIMIT_INSTRUCTION } from "@orchestra/core";
import {
  appendEvent,
  executionUsageBelongsTo,
  incrementExecutionReviewRounds,
  insertReviewResult,
  transition,
} from "@orchestra/db";
import { defineTool } from "../tool.js";

/** Returned for `ask_user`: §8 says it "must be followed by raise_issue". */
export const ASK_USER_INSTRUCTION =
  "The reviewer needs a human decision. Call raise_issue with the question now.";

/**
 * design.md §8, §5.3. Records the result and its event, then:
 *
 *  - `round > project.max_review_rounds`: the limit wins over the verdict.
 *    Task -> NEEDS_HUMAN (`task.escalated`, §5.1 "limit exhausted") with
 *    `needs_human_reason`, and the agent is told to stop and call
 *    `report_failed`. No `review_rounds++`, because no new round starts.
 *  - `findings`: task REVIEWING -> IMPLEMENTING (`review.findings`) and
 *    `executions.review_rounds++`. The counter is on the execution row, so
 *    it cannot ride `transition()`'s task `set`; it is an in-place SQL
 *    increment in the same transaction instead.
 *  - `clean`: no transition. The agent goes on to push and open the PR.
 *  - `ask_user`: no transition. The agent is told to call `raise_issue`.
 *
 * `usage_id` (from `report_usage`, §9.7) is stored on the row. One that is
 * unknown or belongs to another execution fails the call before any write.
 */
export const reportReviewResult = defineTool({
  name: "report_review_result",
  description:
    "Record the result of a review round: verdict clean, findings, or ask_user, with the findings list.",
  async run({ tx, auth, now, actor }, input) {
    if (
      input.usage_id !== undefined &&
      !(await executionUsageBelongsTo(tx, input.usage_id, auth.execution.id))
    ) {
      throw new Error(
        `usage_id ${input.usage_id} is not a usage row of this execution`,
      );
    }

    const review = await insertReviewResult(tx, {
      executionId: auth.execution.id,
      round: input.round,
      verdict: input.verdict,
      findings: input.findings,
      reviewerRuntime: auth.execution.runtime,
      usageId: input.usage_id ?? null,
      createdAt: now,
    });

    await appendEvent(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: "review.result",
      payload: {
        review_result_id: review.id,
        round: input.round,
        verdict: input.verdict,
        findings_count: input.findings.length,
      },
    });

    const max = auth.project.maxReviewRounds;
    if (input.round > max) {
      await transition(tx, {
        entity: "task",
        id: auth.task.id,
        trigger: "task.escalated",
        actor,
        set: {
          needsHumanReason: `Review round limit exceeded: round ${input.round} > max_review_rounds ${max}`,
        },
      });
      return {
        output: { ok: true, instruction: REVIEW_ROUND_LIMIT_INSTRUCTION },
      };
    }

    switch (input.verdict) {
      case "findings":
        await transition(tx, {
          entity: "task",
          id: auth.task.id,
          trigger: "review.findings",
          actor,
        });
        await incrementExecutionReviewRounds(tx, auth.execution.id);
        return { output: { ok: true } };
      case "clean":
        return { output: { ok: true } };
      case "ask_user":
        return { output: { ok: true, instruction: ASK_USER_INSTRUCTION } };
      default: {
        const exhaustive: never = input.verdict;
        throw new Error(`unhandled verdict: ${String(exhaustive)}`);
      }
    }
  },
});
