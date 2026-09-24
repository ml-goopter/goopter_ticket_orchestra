import { appendEvent, upsertDraftSpecificationRevision } from "@orchestra/db";
import { defineTool } from "../tool.js";

/**
 * design.md §8: upsert the task's single draft revision and write
 * `spec.proposed`. The input is `SpecContent`; the server validates it
 * against the core schema before this runs, so an invalid spec never
 * reaches the transaction. Approval rules (`validateSpecForApproval`) are
 * not applied here: a draft may be incomplete (§4.3).
 */
export const proposeSpec = defineTool({
  name: "propose_spec",
  description:
    "Spec sessions only: save the full specification as the task's draft. Each call replaces the previous draft.",
  async run({ tx, auth, now }, input) {
    const revision = await upsertDraftSpecificationRevision(tx, {
      taskId: auth.task.id,
      content: input,
      now,
    });
    await appendEvent(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: "spec.proposed",
      payload: { revision_id: revision.id, version: revision.version },
    });
    return { output: { ok: true } };
  },
});
