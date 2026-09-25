import {
  createClaimPhase,
  createPromotePhase,
  type SchedulerDeps,
} from "../scheduler/index.js";
import type { Phase, TickContext } from "../tick.js";

/**
 * The scheduler's phase order, fixed by design.md §6. Order is a correctness
 * property, not a preference: promotion must see what command consumption
 * wrote, and claim must see what promotion promoted.
 */
export const PHASE_ORDER = [
  /** §6.1 claim unclaimed `execution_commands` for this host. */
  "consume_commands",
  /** §6.2 SPEC_APPROVED -> READY or BLOCKED, by dependency state. */
  "promote_approved",
  /** §6.3 take at most one READY task into an execution plus a lease. */
  "claim",
  /** §6.5 fail executions whose lease expired, then apply the retry policy. */
  "lease_sweeper",
  /** §6.6 remove worktrees for finished, abandoned or over-quota executions. */
  "worktree_sweeper",
] as const;

export type PhaseName = (typeof PHASE_ORDER)[number];

/** §6.6 runs hourly; at the §6 tick of 5 seconds that is every 720 ticks. */
export const WORKTREE_SWEEPER_EVERY_TICKS = 720;

const EVERY: Partial<Record<PhaseName, number>> = {
  worktree_sweeper: WORKTREE_SWEEPER_EVERY_TICKS,
};

/**
 * Placeholder body. Logs that the phase was reached and returns, so the loop,
 * ordering and cadence are exercisable before the real work lands in GOT.26
 * (commands, claim, leases), GOT.34 and GOT.35 (promotion, sweepers).
 */
function stub(name: PhaseName): Phase {
  const every = EVERY[name];
  return {
    name,
    ...(every === undefined ? {} : { every }),
    run: async (ctx: TickContext): Promise<void> => {
      ctx.logger.debug(
        { phase: name, tick: ctx.tick },
        "phase not implemented yet",
      );
    },
  };
}

/**
 * The phases the worker registers at startup, in §6 order. Returns a fresh
 * array each call so a caller cannot mutate the registry. §6.2 promotion and
 * §6.3 claim are real; the other phases are still stubs.
 */
export function createDefaultPhases(deps: SchedulerDeps = {}): Phase[] {
  return PHASE_ORDER.map((name) => {
    switch (name) {
      case "promote_approved":
        return createPromotePhase();
      case "claim":
        return createClaimPhase(deps);
      default:
        return stub(name);
    }
  });
}
