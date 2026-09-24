import { appendEvent, insertPullRequest, transition } from "@orchestra/db";
import { defineTool } from "../tool.js";
import { revokeToken } from "../tokens.js";

/**
 * design.md §8, §5.3: insert `pull_requests`, `pull_request.created`, task
 * REVIEWING -> CI_RUNNING, execution RUNNING -> COMPLETED. The execution
 * leaves RUNNING, so the token is revoked in the same transaction (§8).
 */
export const reportPrCreated = defineTool({
  name: "report_pr_created",
  description:
    "Call once after you have pushed your branch and opened the pull request. This completes the execution.",
  async run({ tx, auth, now, actor }, input) {
    const pr = await insertPullRequest(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      number: input.number,
      url: input.url,
      headSha: input.head_sha,
      state: "open",
      ciState: "pending",
      lastPolledAt: now,
      createdAt: now,
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
