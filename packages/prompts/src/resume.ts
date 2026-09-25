import type { SpecContent } from "@orchestra/core";
import { diffSpecs } from "./spec-diff.js";

/**
 * Resume prompt headers (design.md §9.2, §9.5, §10.3, §10.4). Each kind
 * prepends a fixed header to whatever a resume needs to say; when
 * `payload.userPrompt` is supplied, the header is followed by the original
 * user prompt sections, because a fallback resume re-seeds a fresh session
 * with the full context (D5).
 */

export interface DecisionResumePayload {
  issueId: string;
  decision: string;
  clarification?: string | null;
  chosenOption?: string | null;
  userPrompt?: string;
}

export interface SpecRevisionResumePayload {
  version: number;
  previous: SpecContent;
  revised: SpecContent;
  userPrompt?: string;
}

export interface CiCheckLog {
  name: string;
  log: string;
}

export interface CiFailureResumePayload {
  sha: string;
  checks: readonly CiCheckLog[];
  round: number;
  maxRounds?: number;
  userPrompt?: string;
}

export interface UserMessageTurn {
  author: string;
  body: string;
}

export interface UserMessageResumePayload {
  issueId: string;
  messages: readonly UserMessageTurn[];
  userPrompt?: string;
}

/** §9.5 protocol retry: resume with a nudge naming the missing terminal tool call. */
export interface ProtocolNudgePayload {
  missingToolCall: string;
  userPrompt?: string;
}

export interface ResumePayloadByKind {
  decision: DecisionResumePayload;
  spec_revision: SpecRevisionResumePayload;
  ci_failure: CiFailureResumePayload;
  user_message: UserMessageResumePayload;
  protocol_nudge: ProtocolNudgePayload;
}

export type ResumeKind = keyof ResumePayloadByKind;

const MAX_LOG_LINES = 200;

/**
 * Keeps the last `max` lines of `text` (the most likely place to find a
 * failure), noting how many were dropped. The notice line itself counts
 * against `max`, so the output never exceeds `max` lines.
 */
function truncateLog(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) {
    return text;
  }
  const kept = lines.slice(lines.length - (max - 1));
  const dropped = lines.length - kept.length;
  return [`… (${dropped} earlier lines omitted)`, ...kept].join("\n");
}

function renderDecisionHeader(payload: DecisionResumePayload): string {
  const lines = [`## Answer to your issue ${payload.issueId}`, `Decision: ${payload.decision}`];
  if (payload.clarification) {
    lines.push(`Clarification: ${payload.clarification}`);
  }
  if (payload.chosenOption) {
    lines.push(`Chosen option: ${payload.chosenOption}`);
  }
  return lines.join("\n");
}

function renderSpecRevisionHeader(payload: SpecRevisionResumePayload): string {
  return [
    `## Specification revised to version ${payload.version}`,
    diffSpecs(payload.previous, payload.revised),
    "Reconcile this revision with any work you have already completed in this worktree before continuing.",
  ].join("\n\n");
}

function renderCiFailureHeader(payload: CiFailureResumePayload): string {
  const roundLine = payload.maxRounds
    ? `Round ${payload.round} of ${payload.maxRounds}.`
    : `Round ${payload.round}.`;
  const failingChecks = `Failing checks: ${payload.checks.map((check) => check.name).join(", ")}`;
  const excerpts = payload.checks.map(
    (check) => `### ${check.name}\n\`\`\`\n${truncateLog(check.log, MAX_LOG_LINES)}\n\`\`\``,
  );
  return [`## CI failed on ${payload.sha}`, roundLine, failingChecks, ...excerpts].join("\n\n");
}

function renderUserMessageHeader(payload: UserMessageResumePayload): string {
  const turns = payload.messages.map((turn) => `- ${turn.author}: ${turn.body}`).join("\n");
  return [`## Message from the user`, `Issue ${payload.issueId}:`, turns].join("\n");
}

function renderProtocolNudgeHeader(payload: ProtocolNudgePayload): string {
  return [
    "## Protocol reminder",
    `Your last turn ended without calling ${payload.missingToolCall}. Call it now, or raise_issue if you are blocked. Do not stop without calling one of them.`,
  ].join("\n");
}

/** Builds the resume prompt for `kind`, prepending its header (design.md §9.2). */
export function buildResumePrompt<K extends ResumeKind>(
  kind: K,
  payload: ResumePayloadByKind[K],
): string {
  let header: string;
  switch (kind) {
    case "decision":
      header = renderDecisionHeader(payload as DecisionResumePayload);
      break;
    case "spec_revision":
      header = renderSpecRevisionHeader(payload as SpecRevisionResumePayload);
      break;
    case "ci_failure":
      header = renderCiFailureHeader(payload as CiFailureResumePayload);
      break;
    case "user_message":
      header = renderUserMessageHeader(payload as UserMessageResumePayload);
      break;
    case "protocol_nudge":
      header = renderProtocolNudgeHeader(payload as ProtocolNudgePayload);
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown resume kind: ${String(exhaustive)}`);
    }
  }

  return payload.userPrompt ? `${header}\n\n${payload.userPrompt}` : header;
}
