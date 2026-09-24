import type { Db } from "@orchestra/db";
import type { WorkerConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Everything a phase is allowed to reach (design.md §6). */
export interface TickContext {
  db: Db;
  workerId: string;
  config: WorkerConfig;
  /** One timestamp per tick, so phases in the same tick agree on "now". */
  now: Date;
  /** 1-based, incremented once per executed tick. */
  tick: number;
  /** Already bound to `phase` and `tick`. */
  logger: Logger;
}

/** One ordered step of the scheduler tick (design.md §6.1-§6.6). */
export interface Phase {
  name: string;
  /** Run on every Nth tick. Default 1. The worktree sweeper uses 720. */
  every?: number;
  run(ctx: TickContext): Promise<void>;
}

export interface TickLoopOptions {
  db: Db;
  workerId: string;
  config: WorkerConfig;
  phases: Phase[];
  logger: Logger;
  /** design.md §6: the scheduler runs on a 5 second tick. */
  intervalMs?: number;
  /** Called for every phase that throws, in addition to the error log. */
  onError?: (err: unknown, phase: string, tick: number) => void;
  now?: () => Date;
}

export interface TickLoop {
  /** Schedules ticks. The first runs one interval from now. Idempotent. */
  start(): void;
  /** Stops scheduling and resolves once the in-flight tick has finished. */
  stop(): Promise<void>;
  /** Runs exactly one tick. Used by tests and by a one-shot invocation. */
  runOnce(): Promise<void>;
  /** Number of ticks executed so far. Skipped ticks do not count. */
  readonly tick: number;
}

export const DEFAULT_TICK_INTERVAL_MS = 5000;

/**
 * The scheduler loop (design.md §6). Phases run sequentially in registration
 * order: §6.2 promotion must see the state §6.1 wrote, and §6.3 claim must see
 * the tasks §6.2 promoted. Three guarantees the rest of the worker relies on:
 *
 * - a phase that throws is logged and reported, and the following phases and
 *   every later tick still run. One broken sweeper never stalls the worker.
 * - ticks never overlap. A tick that outruns the interval causes the next
 *   firings to be skipped, so two ticks can never race for the same task.
 * - `stop()` resolves only after the in-flight tick completes, so shutdown
 *   never severs a half-written claim transaction.
 */
export function createTickLoop(options: TickLoopOptions): TickLoop {
  const {
    db,
    workerId,
    config,
    phases,
    logger,
    intervalMs = DEFAULT_TICK_INTERVAL_MS,
    onError,
    now = () => new Date(),
  } = options;

  const seen = new Set<string>();
  for (const phase of phases) {
    if (seen.has(phase.name)) {
      throw new Error(`Duplicate tick phase name: ${phase.name}`);
    }
    seen.add(phase.name);
    if (phase.every !== undefined && (!Number.isInteger(phase.every) || phase.every < 1)) {
      throw new Error(
        `Tick phase ${phase.name} has an invalid \`every\`: must be an integer >= 1`,
      );
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let tick = 0;

  async function runTick(): Promise<void> {
    tick += 1;
    const current = tick;
    const at = now();

    for (const phase of phases) {
      if (current % (phase.every ?? 1) !== 0) continue;

      const phaseLogger = logger.child({ phase: phase.name, tick: current });
      try {
        await phase.run({
          db,
          workerId,
          config,
          now: at,
          tick: current,
          logger: phaseLogger,
        });
      } catch (err) {
        logger.error(
          {
            phase: phase.name,
            tick: current,
            err: err instanceof Error ? err.message : String(err),
          },
          "tick phase failed",
        );
        try {
          onError?.(err, phase.name, current);
        } catch {
          // An onError that throws must not take the loop down with it.
        }
      }
    }
  }

  function fire(): void {
    if (stopped) return;
    if (inFlight) {
      logger.warn(
        { tick, intervalMs },
        "tick still running, skip this interval",
      );
      return;
    }
    inFlight = runTick().finally(() => {
      inFlight = undefined;
    });
  }

  return {
    get tick() {
      return tick;
    },
    start() {
      if (timer || stopped) return;
      timer = setInterval(fire, intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await inFlight;
    },
    async runOnce() {
      inFlight = runTick().finally(() => {
        inFlight = undefined;
      });
      await inFlight;
    },
  };
}
