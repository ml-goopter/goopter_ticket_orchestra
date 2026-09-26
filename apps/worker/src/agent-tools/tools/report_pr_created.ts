import { appendEvent, transition, upsertPullRequest } from "@orchestra/db";
import { defineTool } from "../tool.js";
import { revokeToken } from "../tokens.js";

/**
 * design.md §8, §5.3: record `pull_requests`, `pull_request.created`, task
 * REVIEWING -> CI_RUNNING, execution RUNNING -> COMPLETED. The execution
 * leaves RUNNING, so the token is revoked in the same transaction (§8).
 *
 * GOT.39 C17: after a CI-failure resume the task already has its PR row, so
 * a second call updates that row in place (new head sha, CI back to
 * pending) instead of inserting another.
 */
export const reportPrCreated = defineTool({
  name: "report_pr_created",
  description:
    "Call once after you have pushed your branch and opened the pull request. This completes the execution.",
  async run({ tx, auth, now, actor }, input) {
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
