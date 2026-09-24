import type { Logger } from "./logger.js";

export interface ShutdownOptions {
  logger: Logger;
  /** Graceful teardown: stop the loop, stop the heartbeat, close the db. */
  stop: () => Promise<void>;
  /** Defaults to SIGTERM and SIGINT (design.md §15.2 runs under launchd). */
  signals?: NodeJS.Signals[];
  on?: (signal: NodeJS.Signals, handler: () => void) => void;
  off?: (signal: NodeJS.Signals, handler: () => void) => void;
  exit?: (code: number) => void;
}

export const DEFAULT_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/**
 * Wires graceful shutdown. The first signal drains the in-flight tick and
 * exits 0; a second signal stops waiting and exits 1, so an operator is never
 * stuck behind a hung phase. Everything the handler touches is injectable so
 * the behaviour is testable without killing the test runner.
 *
 * Returns a function that removes the handlers again.
 */
export function installSignalHandlers(options: ShutdownOptions): () => void {
  const {
    logger,
    stop,
    signals = DEFAULT_SHUTDOWN_SIGNALS,
    on = (signal, handler) => void process.on(signal, handler),
    off = (signal, handler) => void process.off(signal, handler),
    exit = (code) => process.exit(code),
  } = options;

  let shuttingDown = false;
  const registered: Array<[NodeJS.Signals, () => void]> = [];

  const handle = (signal: NodeJS.Signals) => () => {
    if (shuttingDown) {
      logger.warn({ signal }, "second signal, forcing exit");
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    void stop().then(
      () => {
        logger.info({ signal }, "shutdown complete");
        exit(0);
      },
      (err: unknown) => {
        logger.error(
          { signal, err: err instanceof Error ? err.message : String(err) },
          "shutdown failed",
        );
        exit(1);
      },
    );
  };

  for (const signal of signals) {
    const handler = handle(signal);
    registered.push([signal, handler]);
    on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of registered) off(signal, handler);
  };
}
