import pino, { type DestinationStream } from "pino";
import type { LogLevel } from "./config.js";

/** Structured fields attached to one record. Never put a secret here. */
export type LogFields = Record<string, unknown>;

/**
 * The slice of pino the worker uses. Declaring it structurally keeps `tick.ts`
 * and the phases testable with a recording stub instead of a real logger.
 */
export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Bound onto every record (design.md §15.2). */
  host: string;
}

/**
 * One JSON object per line on stdout, so launchd or systemd can ship the
 * worker's log without a formatter. Callers add `workerId`, `phase` and
 * `tick` through `child()`.
 */
export function createLogger(
  options: LoggerOptions,
  destination?: DestinationStream,
): Logger {
  return pino(
    { level: options.level, base: { host: options.host } },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
