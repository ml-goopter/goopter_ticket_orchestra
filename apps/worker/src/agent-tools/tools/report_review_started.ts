import { appendEvent, transition } from "@orchestra/db";
import { defineTool } from "../tool.js";

/** design.md §8, §5.3: `review.started`, task IMPLEMENTING -> REVIEWING. */
export const reportReviewStarted = defineTool({
  name: "report_review_started",
  description:
    "Call when you start a review round of your own changes. round starts at 1.",
  async run({ tx, auth, actor }, input) {
    await appendEvent(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: "review.started",
      payload: { round: input.round },
    });
    await transition(tx, {
      entity: "task",
      id: auth.task.id,
      trigger: "review.started",
      actor,
    });
    return { output: { ok: true } };
  },
});
