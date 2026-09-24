import { renderSpecMarkdown } from "./spec-markdown.js";
import type {
  DecisionContext,
  RepositoryContext,
  TicketContext,
  UserPromptContext,
} from "./types.js";

export type { UserPromptContext } from "./types.js";

/** Builds the `## Ticket` section (design.md §9.2). */
function renderTicketSection(ticket: TicketContext): string {
  const lines = [`${ticket.key}: ${ticket.summary}`, ticket.description];

  if (ticket.comments.length > 0) {
    lines.push(
      "",
      "Comments:",
      ...ticket.comments.map(
        (comment) => `- ${comment.author} (${comment.createdAt}): ${comment.body}`,
      ),
    );
  }

  return `## Ticket\n${lines.join("\n")}`;
}

/** Builds the `## Approved specification` / draft / no-spec section. */
function renderSpecSection(ctx: UserPromptContext): string {
  if (ctx.approvedSpec) {
    return `## Approved specification (revision ${ctx.approvedSpec.version})\n${renderSpecMarkdown(ctx.approvedSpec.content)}`;
  }

  if (ctx.role === "spec" && ctx.draftSpec) {
    return `## Draft specification (revision ${ctx.draftSpec.version})\n${renderSpecMarkdown(ctx.draftSpec.content)}`;
  }

  return "## No specification yet";
}

/** Builds one `- ` line for a recorded decision. */
function renderDecisionLine(decision: DecisionContext): string {
  const parts = [decision.decision];

  if (decision.clarification) {
    parts.push(`Clarification: ${decision.clarification}`);
  }

  if (decision.chosenOption) {
    parts.push(`Chosen option: ${decision.chosenOption}`);
  }

  return `- ${decision.issueId}: ${parts.join(" ")} (${decision.author} on ${decision.decidedAt})`;
}

/** Builds the `## Decisions recorded on this task` section. */
function renderDecisionsSection(decisions: readonly DecisionContext[]): string {
  if (decisions.length === 0) {
    return "## Decisions recorded on this task\nNone.";
  }

  return `## Decisions recorded on this task\n${decisions.map(renderDecisionLine).join("\n")}`;
}

/** Builds the `## Repository` section, omitting lines with a null value. */
function renderRepositorySection(repository: RepositoryContext): string {
  const lines = [
    `Name: ${repository.name}`,
    `Default branch: ${repository.defaultBranch}`,
  ];

  if (repository.workingBranch) {
    lines.push(`Working branch: ${repository.workingBranch}`);
  }
  if (repository.setupCommand) {
    lines.push(`Setup command: ${repository.setupCommand}`);
  }
  if (repository.testCommand) {
    lines.push(`Test command: ${repository.testCommand}`);
  }

  return `## Repository\n${lines.join("\n")}`;
}

const SPEC_INSTRUCTIONS =
  "Read the ticket and explore the repository read-only, then work with the user to build a specification. Use raise_issue for open questions, propose_spec whenever you have a draft ready for review, and report_complete only once the user confirms it is finished.";

const IMPLEMENTATION_INSTRUCTIONS =
  "Implement the approved specification above in this repository. Follow the review protocol in your system prompt before opening a pull request.";

/** Builds the `## Instructions` section, role-specific. */
function renderInstructionsSection(role: UserPromptContext["role"]): string {
  const body = role === "spec" ? SPEC_INSTRUCTIONS : IMPLEMENTATION_INSTRUCTIONS;
  return `## Instructions\n${body}`;
}

/**
 * Assembles the user prompt for a start or resume (design.md §9.2), in the
 * fixed section order: Ticket, spec, Decisions, Repository, Instructions.
 */
export function buildUserPrompt(ctx: UserPromptContext): string {
  return [
    renderTicketSection(ctx.ticket),
    renderSpecSection(ctx),
    renderDecisionsSection(ctx.decisions),
    renderRepositorySection(ctx.repository),
    renderInstructionsSection(ctx.role),
  ].join("\n\n");
}
