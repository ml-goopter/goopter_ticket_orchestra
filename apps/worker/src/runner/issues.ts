import { SpecContentSchema, type SpecContent } from "@orchestra/core";
import {
  appendEvent,
  findUserById,
  getIssueById,
  getSpecRevisionById,
  getTaskDecisionById,
  hasOpenBlockingIssue,
  insertAgentIssueMessage,
  loadRunnerContext,
  lockIssue,
  unclaimCommand,
  type ExecutionCommandRow,
  type RunnerContext,
  type Tx,
} from "@orchestra/db";
import { buildResumePrompt } from "@orchestra/prompts";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type {
  CommandContext,
  CommandHandler,
  CommandHandlers,
  CommandOutcome,
} from "./commands.js";
import { ResumeError, type ResumeInput, type Runner } from "./runner.js";

/**
 * GOT.47: the issue conversation and the issue resume commands (design.md
 * §9.2, §9.3, §10.2-§10.4).
 *
 * - `send_message` on an implementation execution in WAITING_FOR_USER
 *   (`{ issue_id, text }`, §10.2): resumes with the `## Message from the
 *   user` header; after the turn the runner stores the agent's final text
 *   as an agent `issue_messages` row and returns the execution to
 *   WAITING_FOR_USER while a blocking issue is still OPEN (§9.3). The spec
 *   handler routes a spec execution's `send_message` elsewhere.
 * - `resume_with_decision` (`{ issue_id, decision_id }`, §10.3): resumes
 *   with the `## Answer to your issue <id>` header.
 * - `resume_with_revision` (`{ revision_id }`, §10.4): resumes against the
 *   newly approved revision with the `## Specification revised to version
 *   N` header and the diff from the execution's previous revision.
 *
 * Every resume passes `freshPrompt`, so an execution released from a dead
 * host or whose session cannot be resumed starts a fresh session here
 * (C21, D5), and records the command and issue in `execution.resumed`.
 *
 * Outcomes (C20): `handled` once the execution is RUNNING; `unclaimed` when a
 * turn is live here or the execution is pinned to another host; `skipped`
 * when there is nothing to do, and at error level when the session is gone
 * for good (NO_SESSION, CANNOT_RESUME, GOT.37 precedent).
 */

const SendMessagePayloadSchema = z.object({
  issue_id: z.uuid(),
  text: z.string().min(1),
});

const ResumeWithDecisionPayloadSchema = z.object({
  issue_id: z.uuid(),
  decision_id: z.uuid(),
});

const ResumeWithRevisionPayloadSchema = z.object({
  revision_id: z.uuid(),
});

type IssueRunner = Pick<Runner, "resume" | "isLive">;

// --------------------------------------------------------- prompt builders

/** §9.2 `## Message from the user`, then the full prompt of a fresh session. */
export function issueMessagePrompt(
  issueId: string,
  author: string,
  text: string,
  userPrompt?: string,
): string {
  return buildResumePrompt("user_message", {
    issueId,
    messages: [{ author, body: text }],
    ...(userPrompt !== undefined ? { userPrompt } : {}),
  });
}

/** §9.2 `## Answer to your issue <id>`, then the full prompt of a fresh session. */
export function decisionResumePrompt(
  issueId: string,
  decision: { decision: string; clarification: string | null; chosenOption: string | null },
  userPrompt?: string,
): string {
  return buildResumePrompt("decision", {
    issueId,
    decision: decision.decision,
    clarification: decision.clarification,
    chosenOption: decision.chosenOption,
    ...(userPrompt !== undefined ? { userPrompt } : {}),
  });
}

/**
 * §9.2, §10.4 `## Specification revised to version N` with the unified diff
 * of the rendered spec and the reconcile instruction, then the full prompt
 * of a fresh session.
 */
export function revisionResumePrompt(
  version: number,
  previous: SpecContent,
  revised: SpecContent,
  userPrompt?: string,
): string {
  return buildResumePrompt("spec_revision", {
    version,
    previous,
    revised,
    ...(userPrompt !== undefined ? { userPrompt } : {}),
  });
}

// ----------------------------------------------------------------- shared

type Checked = { ok: true; loaded: RunnerContext } | { ok: false; outcome: CommandOutcome };

const skipped = (reason: string): { ok: false; outcome: CommandOutcome } => ({
  ok: false,
  outcome: { outcome: "skipped", reason },
});

async function unclaim(
  ctx: CommandContext,
  command: ExecutionCommandRow,
  log: Logger,
  why: string,
): Promise<CommandOutcome> {
  await unclaimCommand(ctx.db, command.id);
  log.info({ reason: why }, `${command.type}: left for a later tick`);
  return { outcome: "unclaimed" };
}

/**
 * The checks every issue command shares: the execution exists, is an
 * implementation execution in WAITING_FOR_USER and runs no turn here. A
 * live turn unclaims (checked first, since a live turn is RUNNING).
 */
async function checkExecution(
  command: ExecutionCommandRow,
  ctx: CommandContext,
  runner: IssueRunner,
  executionId: string,
  log: Logger,
): Promise<Checked> {
  if (runner.isLive(executionId)) {
    return { ok: false, outcome: await unclaim(ctx, command, log, "a turn is in flight") };
  }
  const loaded = await loadRunnerContext(ctx.db, executionId);
  if (!loaded) return skipped("execution not found");
  if (loaded.execution.role !== "implementation") {
    return skipped(`not an implementation execution: ${loaded.execution.role}`);
  }
  if (loaded.execution.state !== "WAITING_FOR_USER") {
    return skipped(`execution is ${loaded.execution.state}, not WAITING_FOR_USER`);
  }
  return { ok: true, loaded };
}

/**
 * Runs `runner.resume` and maps its refusals to outcomes. Resolves once the
 * execution is RUNNING; the turn runs on after the command completes.
 */
async function resumeExecution(
  command: ExecutionCommandRow,
  ctx: CommandContext,
  log: Logger,
  runner: IssueRunner,
  input: ResumeInput,
): Promise<CommandOutcome> {
  try {
    await runner.resume(input);
  } catch (err) {
    if (!(err instanceof ResumeError)) throw err;
    switch (err.code) {
      case "ALREADY_LIVE":
        return unclaim(ctx, command, log, "a turn is in flight");
      // A host null execution takes the fallback, so this is another host,
      // or a pin that changed since the context loaded.
      case "OTHER_HOST":
        return unclaim(ctx, command, log, err.message);
      case "NOT_FOUND":
      case "NOT_RESUMABLE_STATE":
        return { outcome: "skipped", reason: err.message };
      // The session or its worktree is gone for good, even after the
      // fallback. Retrying would never succeed (GOT.37 F3).
      case "NO_SESSION":
      case "CANNOT_RESUME":
        log.error(
          { code: err.code, reason: err.message },
          `${command.type}: execution cannot be resumed`,
        );
        return { outcome: "skipped", reason: err.message };
      default:
        throw err;
    }
  }
  log.info({}, `${command.type}: resumed execution`);
  return { outcome: "handled" };
}

/**
 * §9.3 after-turn hook of a conversation turn, under the task, then
 * execution, row locks: locks the issue last (the api's order), stores the
 * agent's reply on it while it is OPEN, then keeps the execution waiting
 * while any blocking issue on it is OPEN.
 */
function captureReply(
  loaded: RunnerContext,
  issueId: string,
  log: Logger,
): (tx: Tx, turn: { finalText: string }) => Promise<boolean> {
  return async (tx, turn) => {
    const issue = await lockIssue(tx, issueId);
    if (issue?.status === "OPEN") {
      if (turn.finalText === "") {
        log.warn({ issueId }, "send_message: the agent's turn had no text to store");
      } else {
        const message = await insertAgentIssueMessage(tx, {
          issueId,
          body: turn.finalText,
          now: new Date(),
        });
        await appendEvent(tx, {
          taskId: loaded.task.id,
          executionId: loaded.execution.id,
          type: "issue.message",
          payload: { issue_id: issueId, message_id: message.id, author_kind: "agent" },
        });
      }
    }
    return hasOpenBlockingIssue(tx, loaded.execution.id);
  };
}

// ---------------------------------------------------------------- handlers

/**
 * `send_message` on an implementation execution. Registered through
 * `registerSpecHandlers`' `implementationSendMessage`, since a command type
 * has one handler and the spec role owns the spec execution's messages.
 */
export function createIssueMessageHandler(runner: IssueRunner): CommandHandler {
  return async (command, ctx) => {
    const executionId = command.executionId;
    const log = ctx.logger.child({ commandId: command.id, executionId });
    if (executionId === null) {
      return { outcome: "skipped", reason: "send_message names no execution" };
    }
    const parsed = SendMessagePayloadSchema.safeParse(command.payload);
    if (!parsed.success) {
      log.error({ issues: parsed.error.issues }, "send_message payload is invalid");
      return { outcome: "skipped", reason: `invalid payload: ${parsed.error.message}` };
    }
    const { issue_id: issueId, text } = parsed.data;

    const checked = await checkExecution(command, ctx, runner, executionId, log);
    if (!checked.ok) return checked.outcome;
    const issue = await getIssueById(ctx.db, issueId);
    if (!issue || issue.executionId !== executionId) {
      return { outcome: "skipped", reason: "issue not found on the execution" };
    }
    if (issue.status !== "OPEN") {
      log.info({ issueId, status: issue.status }, "send_message: issue is no longer OPEN");
      return { outcome: "skipped", reason: `issue is ${issue.status}, not OPEN` };
    }
    const author =
      command.createdBy !== null
        ? ((await findUserById(ctx.db, command.createdBy))?.email ?? "user")
        : "user";

    return resumeExecution(command, ctx, log, runner, {
      executionId,
      prompt: issueMessagePrompt(issueId, author, text),
      usageKind: "resume",
      expectedState: "WAITING_FOR_USER",
      resumedPayload: { command: "send_message", issue_id: issueId },
      freshPrompt: (userPrompt) => issueMessagePrompt(issueId, author, text, userPrompt),
      conversationTurn: captureReply(checked.loaded, issueId, log),
    });
  };
}

/** Registers `resume_with_decision` and `resume_with_revision`. */
export function registerIssueHandlers(handlers: CommandHandlers, runner: IssueRunner): void {
  handlers.registerCommandHandler("resume_with_decision", async (command, ctx) => {
    const executionId = command.executionId;
    const log = ctx.logger.child({ commandId: command.id, executionId });
    if (executionId === null) {
      return { outcome: "skipped", reason: "resume_with_decision names no execution" };
    }
    const parsed = ResumeWithDecisionPayloadSchema.safeParse(command.payload);
    if (!parsed.success) {
      log.error({ issues: parsed.error.issues }, "resume_with_decision payload is invalid");
      return { outcome: "skipped", reason: `invalid payload: ${parsed.error.message}` };
    }
    const { issue_id: issueId, decision_id: decisionId } = parsed.data;

    const checked = await checkExecution(command, ctx, runner, executionId, log);
    if (!checked.ok) return checked.outcome;
    const decision = await getTaskDecisionById(ctx.db, decisionId);
    if (!decision || decision.issueId !== issueId || decision.taskId !== checked.loaded.task.id) {
      log.error({ issueId, decisionId }, "resume_with_decision: decision not found for the issue");
      return { outcome: "skipped", reason: "decision not found for the issue" };
    }

    return resumeExecution(command, ctx, log, runner, {
      executionId,
      prompt: decisionResumePrompt(issueId, decision),
      usageKind: "resume",
      expectedState: "WAITING_FOR_USER",
      resumedPayload: { command: "resume_with_decision", issue_id: issueId },
      freshPrompt: (userPrompt) => decisionResumePrompt(issueId, decision, userPrompt),
    });
  });

  handlers.registerCommandHandler("resume_with_revision", async (command, ctx) => {
    const executionId = command.executionId;
    const log = ctx.logger.child({ commandId: command.id, executionId });
    if (executionId === null) {
      return { outcome: "skipped", reason: "resume_with_revision names no execution" };
    }
    const parsed = ResumeWithRevisionPayloadSchema.safeParse(command.payload);
    if (!parsed.success) {
      log.error({ issues: parsed.error.issues }, "resume_with_revision payload is invalid");
      return { outcome: "skipped", reason: `invalid payload: ${parsed.error.message}` };
    }
    const revisionId = parsed.data.revision_id;

    const checked = await checkExecution(command, ctx, runner, executionId, log);
    if (!checked.ok) return checked.outcome;
    const { loaded } = checked;
    const previousId = loaded.execution.specRevisionId;
    const [previous, revised] = await Promise.all([
      previousId !== null ? getSpecRevisionById(ctx.db, previousId) : Promise.resolve(null),
      getSpecRevisionById(ctx.db, revisionId),
    ]);
    if (!revised || revised.taskId !== loaded.task.id) {
      log.error({ revisionId }, "resume_with_revision: revision not found on the task");
      return { outcome: "skipped", reason: "revision not found on the task" };
    }
    if (!previous) {
      log.error({ previousId }, "resume_with_revision: execution has no previous revision");
      return { outcome: "skipped", reason: "execution has no previous specification revision" };
    }
    const before = SpecContentSchema.safeParse(previous.content);
    const after = SpecContentSchema.safeParse(revised.content);
    if (!before.success || !after.success) {
      log.error({ previousId, revisionId }, "resume_with_revision: revision is not valid spec content");
      return { outcome: "skipped", reason: "specification revision is not valid spec content" };
    }

    return resumeExecution(command, ctx, log, runner, {
      executionId,
      prompt: revisionResumePrompt(revised.version, before.data, after.data),
      usageKind: "resume",
      expectedState: "WAITING_FOR_USER",
      resumedPayload: { command: "resume_with_revision" },
      specRevisionId: revisionId,
      freshPrompt: (userPrompt) =>
        revisionResumePrompt(revised.version, before.data, after.data, userPrompt),
    });
  });
}
