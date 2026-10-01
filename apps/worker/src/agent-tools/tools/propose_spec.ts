import {
  invalidDependenciesMessage,
  invalidDependencyEntries,
} from "@orchestra/core";
import { appendEvent, findRepositoryById, upsertDraftSpecificationRevision } from "@orchestra/db";
import { defineTool, RepositoryLockedError } from "../tool.js";

/**
 * Thrown when `input.dependencies` holds an entry that is not a Jira issue
 * key (GOT.90/GOT.100, coordinator D1). `invoke.ts`'s `classify()` has no
 * case for this error, so today it still reaches the agent as a generic
 * `INTERNAL` tool error rather than one naming the offending entries --
 * `invoke.ts` is outside this change's owned paths. Wiring a case there
 * (mapping this error to a dedicated tool error code, the same way
 * `RepositoryLockedError` and `ReviewRequiredError` are) is a follow-up.
 */
export class InvalidDependenciesError extends Error {
  constructor(readonly invalid: readonly string[]) {
    super(invalidDependenciesMessage(invalid));
    this.name = "InvalidDependenciesError";
  }
}

/**
 * design.md §8: upsert the task's single draft revision and write
 * `spec.proposed`. The input is `SpecContent`; the server validates it
 * against the core schema before this runs, so an invalid spec never
 * reaches the transaction. Approval rules (`validateSpecForApproval`) are
 * not applied here: a draft may be incomplete (§4.3).
 *
 * GOT.80 D2: once the task's repository is locked, a proposed spec naming a
 * different one is refused with `RepositoryLockedError`, mapped by
 * `invoke.ts` to the `REPOSITORY_LOCKED` tool error code rather than
 * `INTERNAL`. An empty `repository` makes no claim either way.
 *
 * GOT.90/GOT.100: `dependencies` must hold only Jira issue keys (coordinator
 * D1), checked before any write so an invalid call leaves the draft
 * untouched (see `InvalidDependenciesError` above).
 */
export const proposeSpec = defineTool({
  name: "propose_spec",
  description:
    "Spec sessions only: save the full specification as the task's draft. Each call replaces the previous draft.",
  async run({ tx, auth, now }, input) {
    const invalidDependencies = invalidDependencyEntries(input.dependencies);
    if (invalidDependencies.length > 0) {
      throw new InvalidDependenciesError(invalidDependencies);
    }
    if (input.repository !== "" && auth.task.repositoryId !== null) {
      const repository = await findRepositoryById(tx, auth.task.repositoryId);
      if (repository !== null && repository.name !== input.repository) {
        throw new RepositoryLockedError(repository.name);
      }
    }
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
