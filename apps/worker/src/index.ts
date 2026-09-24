import os from "node:os";
import { createDb, type Db } from "@orchestra/db";
import { ConfigError, loadConfig, redactConfig } from "./config.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  startHeartbeat,
} from "./heartbeat.js";
import { createLogger, type Logger } from "./logger.js";
import { PHASE_ORDER, createDefaultPhases } from "./phases/index.js";
import { registerWorker } from "./registration.js";
import { installSignalHandlers } from "./shutdown.js";
import { DEFAULT_TICK_INTERVAL_MS, createTickLoop } from "./tick.js";

/**
 * The worker process (design.md §2, §15.2). Runs natively on the host: it
 * spawns agents, creates git worktrees and runs each repository's toolchain,
 * none of which belong in a container. It talks to Postgres and nothing else
 * in the control plane — there is no api-to-worker RPC.
 *
 * Startup order matters. Config is validated before anything opens a socket,
 * registration happens before the first tick so a phase always has a worker
 * row to attribute work to, and signal handlers go on last so a shutdown
 * always has something coherent to shut down.
 */

const closeDb = async (db: Db): Promise<void> => {
  await db.$client.end({ timeout: 5 });
};

async function main(): Promise<void> {
  const bootstrap: Logger = createLogger({
    level: "info",
    host: os.hostname(),
  });

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      bootstrap.error({ variables: err.variables }, err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel, host: config.host });
  const db = createDb(config.databaseUrl);

  let workerId: string;
  try {
    workerId = await registerWorker(db, config);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "worker registration failed",
    );
    await closeDb(db).catch(() => {});
    process.exit(1);
  }

  const log = logger.child({ workerId });
  log.info({ config: redactConfig(config) }, "worker registered");

  const stopHeartbeat = startHeartbeat(db, workerId, { logger: log });
  const loop = createTickLoop({
    db,
    workerId,
    config,
    phases: createDefaultPhases(),
    logger: log,
    intervalMs: DEFAULT_TICK_INTERVAL_MS,
  });
  loop.start();

  log.info(
    {
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      phases: [...PHASE_ORDER],
    },
    "worker started",
  );

  installSignalHandlers({
    logger: log,
    stop: async () => {
      await loop.stop();
      await stopHeartbeat();
      await closeDb(db);
    },
  });
}

main().catch((err: unknown) => {
  const logger = createLogger({ level: "error", host: os.hostname() });
  logger.error(
    { err: err instanceof Error ? (err.stack ?? err.message) : String(err) },
    "worker failed to start",
  );
  process.exit(1);
});
