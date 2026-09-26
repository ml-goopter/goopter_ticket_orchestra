import type { ExecutionState } from "@orchestra/core";
import { loadRunnerContext, unclaimCommand } from "@orchestra/db";
import { buildResumePrompt } from "@orchestra/prompts";
import { z } from "zod";
import type { CommandHandlers, CommandOutcome } from "./commands.js";
import { ResumeError, type Runner } from "./runner.js";

/**
 * design.md §5.2, §9.2, §11.2: the `resume_with_ci_failure` command handler.
 * `applyCiFailure` enqueues the command; this resumes the COMPLETED
 * implementation execution on the CI back edge with the `## CI failed on
 * <sha>` prompt. The runner's resume does the state move, lease renewal,
 * token and event loop; after the turn, the runner's usual after-turn
 * logic applies.
 *
 * Outcomes (C20): `handled` once the execution is RUNNING; `unclaimed` when
 * the execution is pinned to another host (OTHER_HOST), so the right host
 * takes it (GOT.47 carry-forward); `skipped` when there is nothing to
 * resume: no execution, not an implementation, not COMPLETED, or an invalid
 * payload. Any other refusal throws and leaves the command claimed.
 */

const ResumeWithCiFailurePayloadSchema = z.object({
  pull_request_id: z.string(),
  head_sha: z.string(),
  round: z.number().int().positive(),
  checks: z.array(
    z.object({ name: z.string(), url: z.string(), log_excerpt: z.string() }),
  ),
});

const notCompleted = (state: ExecutionState | undefined): CommandOutcome => ({
  outcome: "skipped",
  reason:
    state === undefined ? "execution not found" : `execution is ${state}, not COMPLETED`,
});

export function registerCiFailureHandler(
  handlers: CommandHandlers,
  runner: Pick<Runner, "resume">,
): void {
  handlers.registerCommandHandler("resume_with_ci_failure", async (command, ctx) => {
    const executionId = command.executionId;
    const log = ctx.logger.child({ commandId: command.id, executionId });
    if (executionId === null) {
      return { outcome: "skipped", reason: "resume_with_ci_failure names no execution" };
    }
    const parsed = ResumeWithCiFailurePayloadSchema.safeParse(command.payload);
    if (!parsed.success) {
      log.error({ issues: parsed.error.issues }, "resume_with_ci_failure payload is invalid");
      return { outcome: "skipped", reason: `invalid payload: ${parsed.error.message}` };
    }
    const payload = parsed.data;

    const loaded = await loadRunnerContext(ctx.db, executionId);
    if (!loaded || loaded.execution.state !== "COMPLETED") {
      return notCompleted(loaded?.execution.state);
    }
    if (loaded.execution.role !== "implementation") {
      return {
        outcome: "skipped",
        reason: `not an implementation execution: ${loaded.execution.role}`,
      };
    }

    const prompt = buildResumePrompt("ci_failure", {
      sha: payload.head_sha,
      checks: payload.checks.map((c) => ({ name: c.name, log: c.log_excerpt })),
      round: payload.round,
      maxRounds: loaded.project.maxCiRounds,
    });

    try {
      // Resolves once RUNNING; the turn runs on after the command completes.
      await runner.resume({ executionId, prompt, usageKind: "resume" });
    } catch (err) {
      if (!(err instanceof ResumeError)) throw err;
      if (err.code === "OTHER_HOST") {
        await unclaimCommand(ctx.db, command.id);
        log.info({ reason: err.message }, "resume_with_ci_failure: execution is on another host");
        return { outcome: "unclaimed" };
      }
      if (err.code === "NOT_RESUMABLE_STATE") {
        const state = (await loadRunnerContext(ctx.db, executionId))?.execution.state;
        return notCompleted(state);
      }
      throw err;
    }
    log.info({ round: payload.round }, "resumed execution with the CI failure");
    return { outcome: "handled" };
  });
}
