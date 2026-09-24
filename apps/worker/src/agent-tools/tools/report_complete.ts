import { appendEvent } from "@orchestra/db";
import { defineTool } from "../tool.js";

/**
 * design.md §8: spec role only, "when the user has finished". Records the
 * summary as an `agent.note` and changes no state: the api's request-review
 * path is what completes a spec execution (§5.2, §9.3).
 */
export const reportComplete = defineTool({
  name: "report_complete",
  description:
    "Spec sessions only: call when the user has said the specification is finished, with a short summary.",
  async run({ tx, auth }, input) {
    await appendEvent(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: "agent.note",
      payload: { text: input.summary, tool: "report_complete" },
    });
    return { output: { ok: true } };
  },
});
