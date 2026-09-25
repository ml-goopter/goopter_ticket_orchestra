import os from "node:os";
import { createDb, type Db } from "@orchestra/db";
import {
  DEFAULT_AGENT_TOOLS_HOST,
  createAgentToolsServer,
  createExecutionRegistry,
} from "./agent-tools/index.js";
import { ConfigError, loadConfig, redactConfig } from "./config.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  startHeartbeat,
} from "./heartbeat.js";
import { startJiraPoller } from "./jira/index.js";
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

  // design.md §8: one agent-tools MCP server per worker, on loopback. The
  // registry is shared with the runner (GOT.31) once it exists.
  const registry = createExecutionRegistry();
  const toolsServer = createAgentToolsServer({
    db,
    registry,
    logger: log.child({ component: "agent-tools" }),
  });
  try {
    await toolsServer.start(config.toolsPort, DEFAULT_AGENT_TOOLS_HOST);
  } catch (err) {
    log.error(
      {
        port: config.toolsPort,
        err: err instanceof Error ? err.message : String(err),
      },
      "agent-tools server failed to start",
    );
    await closeDb(db).catch(() => {});
    process.exit(1);
  }

  const stopHeartbeat = startHeartbeat(db, workerId, { logger: log });
  // design.md §11.1: independent 60s-interval poller. No-ops with one
  // warning when Jira credentials are absent (E4); never blocks startup.
  const stopJiraPoller = startJiraPoller({
    db,
    config,
    workerId,
    logger: log.child({ component: "jira-poller" }),
  });
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
      await toolsServer.stop();
      await stopJiraPoller();
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
