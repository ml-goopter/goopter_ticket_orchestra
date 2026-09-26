import type { CommandType } from "@orchestra/core";
import {
  claimExecutionCommands,
  completeExecutionCommand,
  type Db,
  type ExecutionCommandRow,
} from "@orchestra/db";
import type { Logger } from "../logger.js";
import type { Phase } from "../tick.js";

/**
 * design.md §6.1 command consumer. Each command type has at most one
 * handler; a type with no handler is never claimed, so a later task can
 * register it and pick up what was enqueued before.
 */

export interface CommandContext {
  db: Db;
  workerId: string;
  host: string;
  now: Date;
  logger: Logger;
}

/**
 * What a handler did with its command (GOT.39 C20).
 *
 *  - `handled`: done. The consumer stamps `completed_at`.
 *  - `unclaimed`: the handler already reset `claimed_at` (`unclaimCommand`)
 *    so another worker may take it. The consumer does not stamp it and
 *    logs at info.
 *  - `skipped`: nothing to do, ever. The consumer stamps `completed_at` and
 *    logs `reason` at warn.
 *
 * Returning nothing counts as `handled`. A thrown error leaves the command
 * claimed and uncompleted, logged at error.
 */
export type CommandOutcome =
  | { outcome: "handled" }
  | { outcome: "unclaimed" }
  | { outcome: "skipped"; reason: string };

export type CommandHandler = (
  command: ExecutionCommandRow,
  ctx: CommandContext,
) => Promise<CommandOutcome | void>;

export interface CommandHandlers {
  /** Throws when `type` already has a handler. */
  registerCommandHandler(type: CommandType, handler: CommandHandler): void;
  handlerFor(type: CommandType): CommandHandler | undefined;
  /** Types with a handler, in registration order. */
  types(): CommandType[];
}

export function createCommandHandlers(): CommandHandlers {
  const handlers = new Map<CommandType, CommandHandler>();
  return {
    registerCommandHandler(type, handler) {
      if (handlers.has(type)) {
        throw new Error(`command handler already registered: ${type}`);
      }
      handlers.set(type, handler);
    },
    handlerFor: (type) => handlers.get(type),
    types: () => [...handlers.keys()],
  };
}

/**
 * The `consume_commands` tick phase. Claims up to 10 handled commands in one
 * statement, then runs each handler outside that transaction, in
 * `created_at` order. `completed_at` is set once a handler resolves
 * `handled` or `skipped`; an `unclaimed` command is left for the next claim
 * (`CommandOutcome`). A handler that throws is logged and its command stays
 * claimed and uncompleted; the next command still runs.
 */
export function createConsumeCommandsPhase(
  handlers: CommandHandlers = createCommandHandlers(),
): Phase {
  return {
    name: "consume_commands",
    run: async (ctx) => {
      const types = handlers.types();
      if (types.length === 0) {
        ctx.logger.debug(
          { phase: "consume_commands", tick: ctx.tick },
          "no command handlers registered, not claiming",
        );
        return;
      }

      const host = ctx.config.host;
      const claimed = await claimExecutionCommands(ctx.db, {
        host,
        types,
        now: ctx.now,
      });

      for (const command of claimed) {
        const handler = handlers.handlerFor(command.type);
        const fields = {
          commandId: command.id,
          type: command.type,
          executionId: command.executionId,
        };
        if (!handler) continue;
        try {
          const result = await handler(command, {
            db: ctx.db,
            workerId: ctx.workerId,
            host,
            now: ctx.now,
            logger: ctx.logger,
          });
          const outcome: CommandOutcome = result ?? { outcome: "handled" };
          switch (outcome.outcome) {
            case "unclaimed":
              ctx.logger.info(fields, "command left for another worker");
              break;
            case "skipped":
              await completeExecutionCommand(ctx.db, command.id, new Date());
              ctx.logger.warn({ ...fields, reason: outcome.reason }, "command skipped");
              break;
            case "handled":
              await completeExecutionCommand(ctx.db, command.id, new Date());
              ctx.logger.info(fields, "command completed");
              break;
            default: {
              const exhaustive: never = outcome;
              throw new Error(`unhandled command outcome: ${JSON.stringify(exhaustive)}`);
            }
          }
        } catch (err) {
          ctx.logger.error(
            { ...fields, err: err instanceof Error ? err.message : String(err) },
            "command handler failed",
          );
        }
      }
    },
  };
}

/** What the cancel handler needs from the runner. */
export interface CancelTarget {
  /** Aborts the live run of `executionId`. False when none runs here. */
  abort(executionId: string): boolean;
}

/**
 * GOT.31 Q8: `cancel` aborts the live session of the command's
 * `execution_id` if this worker runs it, and is a no-op otherwise. The
 * payload is not read. State is the api's to set.
 */
export function registerCancelHandler(
  handlers: CommandHandlers,
  runner: CancelTarget,
): void {
  handlers.registerCommandHandler("cancel", async (command, ctx) => {
    const executionId = command.executionId;
    if (executionId === null) {
      ctx.logger.warn({ commandId: command.id }, "cancel command names no execution");
      return { outcome: "skipped", reason: "cancel command names no execution" };
    }
    const aborted = runner.abort(executionId);
    ctx.logger.info(
      { commandId: command.id, executionId, aborted },
      aborted ? "cancel aborted live session" : "cancel: no live session here",
    );
    return { outcome: "handled" };
  });
}
