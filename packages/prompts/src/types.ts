import type { SpecContent } from "@orchestra/core";

/**
 * Plain data types consumed by `buildUserPrompt` (design.md §9.2). The
 * worker is responsible for reading tickets, revisions, and decisions from
 * the db and filling these in; this package does no I/O.
 */

/** A comment on the source Jira ticket. */
export interface TicketComment {
  author: string;
  /** Preformatted, human-readable timestamp (e.g. "2026-09-20"). */
  createdAt: string;
  body: string;
}

export interface TicketContext {
  key: string;
  summary: string;
  description: string;
  comments: readonly TicketComment[];
}

/** A specification revision, rendered from its stored content. */
export interface SpecRevisionContext {
  version: number;
  content: SpecContent;
}

/** A recorded `task_decisions` row (design.md §4.2). */
export interface DecisionContext {
  issueId: string;
  decision: string;
  clarification?: string | null;
  chosenOption?: string | null;
  author: string;
  /** Preformatted, human-readable timestamp (e.g. "2026-09-20"). */
  decidedAt: string;
}

export interface RepositoryContext {
  name: string;
  defaultBranch: string;
  workingBranch?: string | null;
  setupCommand?: string | null;
  testCommand?: string | null;
}

export interface UserPromptContext {
  role: "spec" | "implementation";
  ticket: TicketContext;
  /** The task's currently approved specification revision, if any. */
  approvedSpec?: SpecRevisionContext | null;
  /**
   * The task's current draft revision. Only rendered when `role` is
   * `"spec"` and there is no approved revision.
   */
  draftSpec?: SpecRevisionContext | null;
  decisions: readonly DecisionContext[];
  repository: RepositoryContext;
}
