import { resolveTransition } from "@orchestra/core";
import { getTaskState, transition } from "@orchestra/db";
import { defineTool } from "../tool.js";
import { revokeToken } from "../tokens.js";

/**
 * design.md §8, §9.5: execution RUNNING -> FAILED with
 * `end_reason = agent_gave_up`, task -> NEEDS_HUMAN, token revoked.
 *
 * The task only moves when core has a `task.escalated` edge from its
 * current state (IMPLEMENTING, REVIEWING, CI_RUNNING). Two cases have none
 * and leave the task where it is, with the `execution.failed` event as the
 * record:
 *  - a spec execution: §5.1 has no SPEC_IN_PROGRESS -> NEEDS_HUMAN edge;
 *  - a task already in NEEDS_HUMAN, e.g. after `report_review_result`
 *    escalated on the round limit and told the agent to call this.
 */
export const reportFailed = defineTool({
  name: "report_failed",
  description:
    "Give up on this task when you cannot finish it. A human will take over. Give a short reason and the detail.",
  async run({ tx, auth, now, actor }, input) {
    await transition(tx, {
      entity: "execution",
      id: auth.execution.id,
      trigger: "execution.failed",
      actor,
      set: {
        endReason: "agent_gave_up",
        endDetail: `${input.reason}: ${input.detail}`,
        endedAt: now,
      },
    });

    const taskState = await getTaskState(tx, auth.task.id);
    if (taskState && resolveTransition("task", taskState, "task.escalated").ok) {
      await transition(tx, {
        entity: "task",
        id: auth.task.id,
        trigger: "task.escalated",
        actor,
        set: { needsHumanReason: `Agent gave up: ${input.reason}` },
      });
    }

    await revokeToken(tx, auth.execution.id);
    return { output: { ok: true } };
  },
});
