import { RAISE_ISSUE_BLOCKING_INSTRUCTION } from "@orchestra/core";
import { appendEvent, insertIssue, insertNotification } from "@orchestra/db";
import { defineTool } from "../tool.js";

/** Returned for a non-blocking issue: the agent keeps working (§10.5). */
export const RAISE_ISSUE_CONTINUE_INSTRUCTION = "Recorded. Continue.";

/**
 * design.md §8, §10.1. Inserts the issue, `issue.created`, and a broadcast
 * notification (`user_id` null = every user). A blocking issue does not
 * change task or execution state here: it sets `blockingPending`, and the
 * runner moves the execution to `WAITING_FOR_USER` when the turn ends.
 */
export const raiseIssue = defineTool({
  name: "raise_issue",
  description:
    "Raise an issue for a human: a question, a decision you cannot make, or a blocker. " +
    "If blocking is true, stop and end your turn as instructed; you will be resumed with the answer.",
  async run({ tx, auth, now }, input) {
    const issue = await insertIssue(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: input.type,
      severity: input.severity,
      blocking: input.blocking,
      title: input.title,
      description: input.description,
      question: input.question ?? null,
      suggestedOptions: input.options ?? null,
      recommendedOption: input.recommended_option ?? null,
      status: "OPEN",
      createdAt: now,
    });

    await appendEvent(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: "issue.created",
      payload: {
        issue_id: issue.id,
        type: issue.type,
        severity: issue.severity,
        blocking: issue.blocking,
        title: issue.title,
      },
    });

    await insertNotification(tx, {
      userId: null,
      taskId: auth.task.id,
      issueId: issue.id,
      kind: "issue_raised",
      title: issue.title,
      createdAt: now,
    });

    if (!input.blocking) {
      return {
        output: {
          issue_id: issue.id,
          instruction: RAISE_ISSUE_CONTINUE_INSTRUCTION,
        },
      };
    }

    return {
      output: { issue_id: issue.id, instruction: RAISE_ISSUE_BLOCKING_INSTRUCTION },
      afterCommit: (live) => {
        if (live) live.blockingPending = true;
      },
    };
  },
});
