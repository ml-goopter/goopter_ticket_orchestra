import { heartbeatWorker, type Db } from "@orchestra/db";
import type { Logger } from "./logger.js";

export interface HeartbeatOptions {
  /** design.md §6.4: every 30 seconds. */
  intervalMs?: number;
  now?: () => Date;
  logger?: Logger;
  /**
   * §6.4 renews `task_leases.expires_at` for this worker's live executions on
   * the same cadence. Registered by the runner (GOT.26); a no-op until then.
   */
  renewLeases?: () => Promise<void>;
  /** Called for every failed beat, in addition to the error log. */
  onError?: (err: unknown) => void;
}

/** Stops the heartbeat and resolves once the in-flight beat has finished. */
export type StopHeartbeat = () => Promise<void>;

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Keeps `agent_workers.last_heartbeat_at` fresh so another worker's sweeper
 * can tell this host apart from a dead one (design.md §6.1, §6.4). A failed
 * beat is logged and retried on the next interval rather than thrown: a
 * transient database blip must not kill a worker that is mid-execution. Lease
 * renewal rides the same timer because §6.4 ties the two cadences together.
 */
export function startHeartbeat(
  db: Db,
  workerId: string,
  options: HeartbeatOptions = {},
): StopHeartbeat {
  const {
    intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    now = () => new Date(),
    logger,
    renewLeases,
    onError,
  } = options;

  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const report = (err: unknown, msg: string) => {
    logger?.error(
      { workerId, err: err instanceof Error ? err.message : String(err) },
      msg,
    );
    try {
      onError?.(err);
    } catch {
      // An onError that throws must not stop the heartbeat.
    }
  };

  async function beat(): Promise<void> {
    const at = now();
    try {
      await heartbeatWorker(db, workerId, at);
      logger?.debug({ workerId, at: at.toISOString() }, "heartbeat");
    } catch (err) {
      report(err, "heartbeat failed");
    }

    // Renewal is independent: a failed heartbeat must still attempt renewal,
    // and a failed renewal must not suppress the next heartbeat.
    if (!renewLeases) return;
    try {
      await renewLeases();
    } catch (err) {
      report(err, "lease renewal failed");
    }
  }

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = beat().finally(() => {
      inFlight = undefined;
    });
  }, intervalMs);

  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
