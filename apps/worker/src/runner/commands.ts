import type { CommandType } from "@orchestra/core";
import {
  claimExecutionCommands,
  completeExecutionCommand,
  type Db,
  type ExecutionCommandRow,
} from "@orchestra/db";
import type { Logger } from "../logger.js";
import type { Phase, TickContext } from "../tick.js";

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

/**
 * Work the `consume_commands` phase runs on every tick after its commands,
 * for a state change the api makes with no command (GOT.99: request-review
 * completing a spec execution between turns).
 */
export type TickHook = (ctx: CommandContext) => Promise<void>;

export interface CommandHandlers {
  /** Throws when `type` already has a handler. */
  registerCommandHandler(type: CommandType, handler: CommandHandler): void;
  handlerFor(type: CommandType): CommandHandler | undefined;
  /** Types with a handler, in registration order. */
  types(): CommandType[];
  /** Adds a hook the phase runs on every tick, after the claimed commands. */
  registerTickHook(hook: TickHook): void;
  /** Hooks in registration order. */
  tickHooks(): TickHook[];
}

export function createCommandHandlers(): CommandHandlers {
  const handlers = new Map<CommandType, CommandHandler>();
  const hooks: TickHook[] = [];
  return {
    registerCommandHandler(type, handler) {
      if (handlers.has(type)) {
        throw new Error(`command handler already registered: ${type}`);
      }
      handlers.set(type, handler);
    },
    handlerFor: (type) => handlers.get(type),
    types: () => [...handlers.keys()],
    registerTickHook(hook) {
      hooks.push(hook);
    },
    tickHooks: () => [...hooks],
  };
}

/**
 * The `consume_commands` tick phase. Claims up to 10 handled commands in one
 * statement, then runs each handler outside that transaction, in
 * `created_at` order. `completed_at` is set once a handler resolves
 * `handled` or `skipped`; an `unclaimed` command is left for the next claim
 * (`CommandOutcome`). A handler that throws is logged and its command stays
 * claimed and uncompleted; the next command still runs. Then each tick hook
 * runs in order; one that throws is logged and the next still runs.
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
        await runTickHooks(handlers, ctx);
        return;
      }

      const host = ctx.config.host;
      const claimed = await claimExecutionCommands(ctx.db, {
        workerId: ctx.workerId,
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
      await runTickHooks(handlers, ctx);
    },
  };
}

async function runTickHooks(handlers: CommandHandlers, ctx: TickContext): Promise<void> {
  for (const hook of handlers.tickHooks()) {
    try {
      await hook({
        db: ctx.db,
        workerId: ctx.workerId,
        host: ctx.config.host,
        now: ctx.now,
        logger: ctx.logger,
      });
    } catch (err) {
      ctx.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "command tick hook failed",
      );
    }
  }
}

/** What the cancel handler needs from the runner. */
export interface CancelTarget {
  /** Aborts the live run of `executionId`. False when none runs here. */
  abort(executionId: string): boolean;
  /**
   * §9.9 Removal: removes the agent container of an execution that ended
   * with no live run here. Absent, nothing is removed.
   */
  releaseContainer?(executionId: string): Promise<void>;
}

/**
 * GOT.31 Q8: `cancel` aborts the live session of the command's
 * `execution_id` if this worker runs it, and is a no-op otherwise. The
 * payload is not read. State is the api's to set. With no live session
 * here it releases the execution's agent container (§9.9); a live one is
 * removed when its run ends.
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
    if (!aborted) await runner.releaseContainer?.(executionId);
    return { outcome: "handled" };
  });
}
