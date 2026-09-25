import { renderSpecMarkdown } from "./spec-markdown.js";
import type { DecisionContext, SpecRevisionContext } from "./types.js";

/**
 * User prompt for an `orchestra-review` session (design.md §9.8). The
 * reviewer's only inputs are the contract and the code: the approved spec,
 * the recorded decisions, and the diff with untracked files. It has no
 * ticket and never sees the implementing agent's transcript.
 */

/** A file git does not track yet, with its content read from disk. */
export interface UntrackedFile {
  path: string;
  content: string;
}

export interface ReviewPromptContext {
  spec: SpecRevisionContext;
  decisions: readonly DecisionContext[];
  /** `git diff <merge-base>` output: committed and uncommitted changes. */
  diff: string;
  untracked: readonly UntrackedFile[];
  repository: { name: string; defaultBranch: string; branch: string };
  testCommand?: string | null;
}

/**
 * Wraps `content` in a fence longer than any backtick run inside it, so a
 * file that itself contains ``` cannot close the block early.
 */
function fenced(content: string, lang = ""): string {
  const longestRun = Math.max(
    0,
    ...(content.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `${fence}${lang}\n${body}${fence}`;
}

/** Same line format as `buildUserPrompt` (design.md §9.2). */
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

function renderDecisionsSection(decisions: readonly DecisionContext[]): string {
  const body =
    decisions.length === 0 ? "None." : decisions.map(renderDecisionLine).join("\n");
  return `## Decisions recorded on this task\n${body}`;
}

function renderRepositorySection(ctx: ReviewPromptContext): string {
  const lines = [
    `Name: ${ctx.repository.name}`,
    `Default branch: ${ctx.repository.defaultBranch}`,
    `Working branch: ${ctx.repository.branch}`,
  ];
  if (ctx.testCommand) lines.push(`Test command: ${ctx.testCommand}`);
  return `## Repository\n${lines.join("\n")}`;
}

function renderDiffSection(diff: string): string {
  const body =
    diff.trim() === "" ? "No changes to tracked files." : fenced(diff, "diff");
  return `## Diff against the merge base\n${body}`;
}

function renderUntrackedSection(files: readonly UntrackedFile[]): string {
  if (files.length === 0) return "## Untracked files\nNone.";
  const blocks = files.map((file) => `### ${file.path}\n${fenced(file.content)}`);
  return `## Untracked files\n${blocks.join("\n\n")}`;
}

const REVIEW_INSTRUCTIONS = `Review the diff and the untracked files above against the specification and the recorded decisions. You may read the repository and run the test command to check your findings.

Reply with exactly one JSON document and nothing else: no prose, no code fence. Its shape:

{"verdict": "clean" | "findings" | "ask_user", "findings": [{"severity": "info" | "warning" | "blocking", "file": "<path, optional>", "line": <line number, optional>, "description": "<what is wrong>", "action": "<what the implementer should do>"}]}

Use "clean" with an empty findings list when nothing needs to change. Use "ask_user" when the specification and decisions do not let you decide.`;

/**
 * Assembles the review prompt in fixed section order: Specification,
 * Decisions, Repository, Diff, Untracked files, Instructions.
 */
export function buildReviewPrompt(ctx: ReviewPromptContext): string {
  return [
    `## Specification (revision ${ctx.spec.version})\n${renderSpecMarkdown(ctx.spec.content)}`,
    renderDecisionsSection(ctx.decisions),
    renderRepositorySection(ctx),
    renderDiffSection(ctx.diff),
    renderUntrackedSection(ctx.untracked),
    `## Instructions\n${REVIEW_INSTRUCTIONS}`,
  ].join("\n\n");
}
