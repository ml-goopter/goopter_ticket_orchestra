import type { Runtime } from "@orchestra/core";
import type { CommandHandlers } from "../runner/commands.js";
import type { Phase } from "../tick.js";
import {
  claimNextTask,
  createRuntimeWarner,
  handOff,
  type OnClaimed,
} from "./claim.js";
import { promoteApprovedTasks } from "./promotion.js";

export {
  claimNextTask,
  createRuntimeWarner,
  handOff,
  type ClaimOptions,
  type ClaimedExecution,
  type OnClaimed,
} from "./claim.js";
export {
  decidePromotion,
  promoteApprovedTasks,
  type PromotionOutcome,
  type PromotionTrigger,
} from "./promotion.js";
export { detectRuntimes } from "./runtimes.js";

/** What the scheduler phases need beyond the tick context. */
export interface SchedulerDeps {
  /** Runtimes detected on PATH at startup (§7.3). Default none. */
  runtimes?: readonly Runtime[];
  /**
   * Receives each claimed execution after commit (G1): the runner's
   * `onClaimed`. Without it the claim phase does nothing.
   */
  onClaimed?: OnClaimed;
  /**
   * §6.1 command handlers. Absent or empty, the consume phase claims
   * nothing.
   */
  commands?: CommandHandlers;
}

/** design.md §6.2 as a tick phase. */
export function createPromotePhase(): Phase {
  return {
    name: "promote_approved",
    run: async (ctx) => {
      await promoteApprovedTasks({
        db: ctx.db,
        workerId: ctx.workerId,
        logger: ctx.logger,
      });
    },
  };
}

/** design.md §6.3 as a tick phase: at most one claim per tick (G3). */
export function createClaimPhase(deps: SchedulerDeps = {}): Phase {
  const runtimes = [...(deps.runtimes ?? [])];
  const { onClaimed } = deps;
  const warner = createRuntimeWarner(runtimes);

  return {
    name: "claim",
    run: async (ctx) => {
      if (!onClaimed) {
        ctx.logger.debug(
          { phase: "claim", tick: ctx.tick },
          "no onClaimed handler registered, not claiming",
        );
        return;
      }

      await warner.warn(ctx.db, ctx.workerId, ctx.logger);

      const claim = await claimNextTask({
        db: ctx.db,
        workerId: ctx.workerId,
        runtimes,
        now: ctx.now,
      });
      if (!claim) return;

      ctx.logger.info({ ...claim }, "claimed task");
      handOff(onClaimed, claim, ctx.logger);
    },
  };
}
