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

export type CommandHandler = (
  command: ExecutionCommandRow,
  ctx: CommandContext,
) => Promise<void>;

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
 * `created_at` order. `completed_at` is set once a handler resolves. A
 * handler that throws is logged and its command stays claimed and
 * uncompleted; the next command still runs.
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
          await handler(command, {
            db: ctx.db,
            workerId: ctx.workerId,
            host,
            now: ctx.now,
            logger: ctx.logger,
          });
          await completeExecutionCommand(ctx.db, command.id, new Date());
          ctx.logger.info(fields, "command completed");
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
      return;
    }
    const aborted = runner.abort(executionId);
    ctx.logger.info(
      { commandId: command.id, executionId, aborted },
      aborted ? "cancel aborted live session" : "cancel: no live session here",
    );
  });
}
