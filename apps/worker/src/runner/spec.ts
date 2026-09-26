import { SpecContentSchema } from "@orchestra/core";
import {
  DEFAULT_EXECUTION_MODEL,
  completeExecutionCommand,
  getRevisionByStatus,
  hasLiveSpecExecution,
  hasPendingSpecResume,
  insertQueuedExecution,
  loadRunnerContext,
  lockTaskForSpecStart,
  nextExecutionAttempt,
  resolveSpecRepository,
  transition,
  unclaimCommand,
  type Db,
} from "@orchestra/db";
import { renderSpecMarkdown } from "@orchestra/prompts";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { CommandHandler, CommandHandlers, CommandOutcome } from "./commands.js";
import { ResumeError, type Runner } from "./runner.js";

/**
 * GOT.37: the spec role's command handlers (design.md §5.2, §9.3, §12.3,
 * D8).
 *
 * `start_spec_session` creates the spec execution and completes its command
 * in one transaction, then hands the execution to `runner.startSpec`. The
 * consumer stamps `completed_at` only after a handler resolves, outside
 * the handler's transaction, so the handler stamps it itself inside the
 * transaction that creates the execution: request-review refuses while the
 * command is uncompleted, and once it reads as completed the ASSIGNED
 * execution is visible to it. The consumer's own stamp for `handled` then
 * rewrites an already completed command.
 *
 * `send_message` on a spec execution resumes its session with the user's
 * text (C42): RUNNING between turns resumes in place; a COMPLETED one sent
 * back from review (`system: "sent_back"`, C45) moves back to RUNNING first.
 * The chat text is not stored as an execution event (C43).
 *
 * Outcomes (C20): `handled` once the session is started or RUNNING;
 * `unclaimed` when a turn is already in flight here or the execution is
 * pinned to another host; `skipped` when there is nothing to do.
 */

/** Header of a user chat turn. `buildResumePrompt("user_message")` is per issue. */
export const SPEC_MESSAGE_HEADER = "## Message from the user";
/** Header of the send-back resume (C45). */
export const SPEC_SENT_BACK_HEADER = "## Specification sent back";

const SendMessagePayloadSchema = z.object({
  text: z.string().min(1),
  system: z.literal("sent_back").optional(),
});

export function specMessagePrompt(text: string): string {
  return `${SPEC_MESSAGE_HEADER}\n${text}`;
}

/**
 * The send-back resume prompt: the user's intent, then the current draft
 * rendered as markdown, or JSON when it is not valid spec content.
 */
export function specSentBackPrompt(
  text: string,
  draft: { version: number; content: unknown } | null,
): string {
  if (!draft) return `${SPEC_SENT_BACK_HEADER}\n${text}\n\nThe task has no draft revision.`;
  const parsed = SpecContentSchema.safeParse(draft.content);
  const body = parsed.success
    ? renderSpecMarkdown(parsed.data)
    : `\`\`\`json\n${JSON.stringify(draft.content, null, 2)}\n\`\`\``;
  return `${SPEC_SENT_BACK_HEADER}\n${text}\n\n### Current draft (revision ${draft.version})\n${body}`;
}

type StartResult = { ok: true; executionId: string } | { ok: false; reason: string; error?: true };

/**
 * One transaction: lock the task, check it, insert the QUEUED spec
 * execution pinned here, move it ASSIGNED, complete the command. Returns
 * without writing when a check fails.
 */
async function createSpecExecution(
  db: Db,
  input: { commandId: string; taskId: string; workerId: string; host: string },
): Promise<StartResult> {
  return db.transaction(async (tx): Promise<StartResult> => {
    const task = await lockTaskForSpecStart(tx, input.taskId);
    if (!task) return { ok: false, reason: "task not found" };
    if (task.state !== "SPEC_IN_PROGRESS") {
      return { ok: false, reason: `task is ${task.state}, not SPEC_IN_PROGRESS` };
    }
    if (await hasLiveSpecExecution(tx, input.taskId)) {
      return { ok: false, reason: "task already has a live spec execution" };
    }
    // F1: a pending send-back resumes the COMPLETED session instead.
    if (await hasPendingSpecResume(tx, input.taskId)) {
      return { ok: false, reason: "a sent-back spec session is about to resume" };
    }
    const repository = await resolveSpecRepository(tx, input.taskId);
    if (!repository) {
      return { ok: false, reason: "project has no repository", error: true };
    }
    const { id } = await insertQueuedExecution(tx, {
      taskId: input.taskId,
      role: "spec",
      attempt: await nextExecutionAttempt(tx, input.taskId, "spec"),
      runtime: repository.defaultRuntime,
      model: repository.defaultModel ?? DEFAULT_EXECUTION_MODEL,
      specRevisionId: null,
      workerId: input.workerId,
      host: input.host,
    });
    await transition(tx, {
      entity: "execution",
      id,
      trigger: "execution.assigned",
      actor: { kind: "worker", id: input.workerId },
    });
    await completeExecutionCommand(tx, input.commandId, new Date());
    return { ok: true, executionId: id };
  });
}

export interface SpecHandlerOptions {
  /**
   * GOT.47: handles a `send_message` on an issue (§9.3, §10.2): every one
   * on an implementation execution, and one whose payload names an
   * `issue_id` on a spec execution (C54), which a blocking `raise_issue` left
   * in WAITING_FOR_USER. Without it such a command is skipped.
   */
  issueSendMessage?: CommandHandler;
}

/** An issue message (`/issues/:id/messages`) rather than a spec chat turn. */
const isIssueMessage = (payload: unknown): boolean =>
  typeof payload === "object" &&
  payload !== null &&
  typeof (payload as { issue_id?: unknown }).issue_id === "string";

export function registerSpecHandlers(
  handlers: CommandHandlers,
  runner: Pick<Runner, "startSpec" | "resume" | "isLive">,
  options: SpecHandlerOptions = {},
): void {
  handlers.registerCommandHandler("start_spec_session", async (command, ctx) => {
    const log = ctx.logger.child({ commandId: command.id, taskId: command.taskId });
    if (command.executionId !== null) {
      return { outcome: "skipped", reason: "start_spec_session names an execution" };
    }
    const result = await createSpecExecution(ctx.db, {
      commandId: command.id,
      taskId: command.taskId,
      workerId: ctx.workerId,
      host: ctx.host,
    });
    if (!result.ok) {
      if (result.error) log.error({ reason: result.reason }, "start_spec_session: cannot start");
      return { outcome: "skipped", reason: result.reason };
    }
    log.info({ executionId: result.executionId }, "spec execution created");
    // Runs the first turn after the command completes, as a claim does.
    void runner.startSpec({ executionId: result.executionId, taskId: command.taskId });
    return { outcome: "handled" };
  });

  handlers.registerCommandHandler("send_message", async (command, ctx) => {
    const executionId = command.executionId;
    const log = ctx.logger.child({ commandId: command.id, executionId });
    if (executionId === null) {
      return { outcome: "skipped", reason: "send_message names no execution" };
    }
    const loaded = await loadRunnerContext(ctx.db, executionId);
    if (!loaded) return { outcome: "skipped", reason: "execution not found" };
    // Issue conversation (GOT.47): any message on an implementation
    // execution, an issue message on a spec execution (C54).
    if (loaded.execution.role !== "spec" || isIssueMessage(command.payload)) {
      if (options.issueSendMessage) return options.issueSendMessage(command, ctx);
    }
    if (loaded.execution.role !== "spec") {
      return { outcome: "skipped", reason: "not a spec execution" };
    }
    const parsed = SendMessagePayloadSchema.safeParse(command.payload);
    if (!parsed.success) {
      log.error({ issues: parsed.error.issues }, "send_message payload is invalid");
      return { outcome: "skipped", reason: `invalid payload: ${parsed.error.message}` };
    }
    const { text, system } = parsed.data;
    const sentBack = system === "sent_back";
    const state = loaded.execution.state;
    // A plain message goes to a RUNNING session. A send-back resumes the
    // COMPLETED one, or a RUNNING one when an earlier send-back already did.
    if (state !== "RUNNING" && !(sentBack && state === "COMPLETED")) {
      return { outcome: "skipped", reason: `spec execution is ${state}` };
    }
    if (loaded.execution.host === null) return unpinned(log);

    const unclaim = async (why: string): Promise<CommandOutcome> => {
      await unclaimCommand(ctx.db, command.id);
      log.info({ reason: why }, "send_message: left for a later tick");
      return { outcome: "unclaimed" };
    };
    if (runner.isLive(executionId)) return unclaim("a turn is in flight");

    const prompt = sentBack
      ? specSentBackPrompt(text, await getRevisionByStatus(ctx.db, loaded.task.id, "draft"))
      : specMessagePrompt(text);
    try {
      // Resolves once RUNNING; the turn runs on after the command completes.
      await runner.resume({ executionId, prompt, usageKind: "resume", expectedState: state });
    } catch (err) {
      if (!(err instanceof ResumeError)) throw err;
      switch (err.code) {
        case "ALREADY_LIVE":
          return unclaim("a turn is in flight");
        case "OTHER_HOST": {
          const reloaded = await loadRunnerContext(ctx.db, executionId);
          if (reloaded && reloaded.execution.host === null) return unpinned(log);
          return unclaim(err.message);
        }
        case "NOT_FOUND":
        case "NOT_RESUMABLE_STATE":
          return { outcome: "skipped", reason: err.message };
        // F3: the session or its worktree is gone for good (C46 removed an
        // approved spec's worktree). Retrying would never succeed.
        case "NO_SESSION":
        case "CANNOT_RESUME":
          log.error({ code: err.code, reason: err.message }, "send_message: spec session cannot be resumed");
          return { outcome: "skipped", reason: err.message };
        default:
          throw err;
      }
    }
    log.info({ sentBack }, "resumed spec execution");
    return { outcome: "handled" };
  });
}

/**
 * C21: released from a dead host (host null), so no worker holds the
 * session. Skipped and logged at error, as the CI handler does.
 */
function unpinned(log: Logger): CommandOutcome {
  log.error({}, "send_message: spec execution is unpinned");
  return { outcome: "skipped", reason: "execution unpinned; no worker holds its session" };
}
