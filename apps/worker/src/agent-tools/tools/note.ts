import { appendEvent } from "@orchestra/db";
import { defineTool } from "../tool.js";

/** design.md §8: `agent.note` for the timeline. */
export const note = defineTool({
  name: "note",
  description:
    "Leave a short note on the task timeline for an observation that does not need a human decision.",
  async run({ tx, auth }, input) {
    await appendEvent(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: "agent.note",
      payload: { text: input.text },
    });
    return { output: { ok: true } };
  },
});
