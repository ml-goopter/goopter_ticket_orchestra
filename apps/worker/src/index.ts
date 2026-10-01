import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAdapter, CodexAdapter } from "@orchestra/adapters";
import {
  createDb,
  deploymentOwner,
  revokeRunningSpecTokensOnHost,
  type Db,
} from "@orchestra/db";
import {
  DEFAULT_AGENT_TOOLS_HOST,
  createAgentToolsServer,
  createExecutionRegistry,
} from "./agent-tools/index.js";
import { ConfigError, loadConfig, redactConfig } from "./config.js";
import {
  detectDockerCapability,
  startDockerStack,
  workerCapabilities,
  type DockerStack,
} from "./containers/index.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  startHeartbeat,
} from "./heartbeat.js";
import { startGitHubPoller } from "./github/index.js";
import { createJiraClient, startJiraPoller, startJiraWriteback } from "./jira/index.js";
import { createLogger, type Logger } from "./logger.js";
import { PHASE_ORDER, createDefaultPhases } from "./phases/index.js";
import { loadPricing, PricingFileError } from "./pricing/index.js";
import { registerWorker } from "./registration.js";
import {
  createCommandHandlers,
  createContainerAdapter,
  createIssueMessageHandler,
  createRunner,
  registerCancelHandler,
  registerCiFailureHandler,
  registerIssueHandlers,
  registerSpecHandlers,
  startRetryStarter,
} from "./runner/index.js";
import { WorktreeManager } from "./worktrees/index.js";
import { detectRuntimes } from "./scheduler/index.js";
import { installSignalHandlers } from "./shutdown.js";
import { DEFAULT_TICK_INTERVAL_MS, createTickLoop } from "./tick.js";

/**
 * The worker process (design.md §2, §15.2). Runs natively on the host: it
 * spawns agents, creates git worktrees and runs each repository's toolchain,
 * none of which belong in a container. It talks to Postgres and nothing else
 * in the control plane — there is no api-to-worker RPC.
 *
 * Startup order matters. The SIGTERM/SIGINT listener is installed first,
 * before this function's first `await`, so the process always has an
 * application-level signal handler (GOT.96); config is validated before
 * anything opens a socket, registration happens before the first tick so a
 * phase always has a worker row to attribute work to, and the handler's real
 * stop function -- the thing that makes a shutdown coherent -- is wired in
 * last, once every subsystem it touches exists.
 */

/**
 * `apps/worker` in the repo, resolved from this module rather than the
 * process's cwd (matching `DEFAULT_REVIEW_WRAPPER_BIN` in runner.ts), so
 * `PRICING_FILE`'s default of `config/pricing.json` (design.md §15.3) finds
 * the repo-root file however the worker was launched.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const closeDb = async (db: Db): Promise<void> => {
  await db.$client.end({ timeout: 5 });
};

async function main(): Promise<void> {
  const bootstrap: Logger = createLogger({
    level: "info",
    host: os.hostname(),
  });

  // GOT.96: install the signal handlers synchronously, before the first
  // `await` below, so the process has an application-level SIGTERM/SIGINT
  // listener from its very first tick -- before `registerWorker` below ever
  // makes the worker's row visible to anything watching for it. `index.ts`
  // runs under tsx (design.md §15.2 test harness), and tsx's loader treats a
  // signal arriving while `process.listenerCount(signal)` is 0 as
  // unhandled: it force-exits the process with `128 + signal` itself,
  // bypassing the `exit(0)`/`exit(1)` calls below entirely. That raced with
  // the rest of this function's startup work (registration, pricing, the
  // tools server, docker, the pollers, the runner, the tick loop) all
  // running *before* `installSignalHandlers` used to be called at the
  // bottom of this function, and surfaced as shutdown.test.ts intermittently
  // observing `{ code: 143, signal: null }` instead of `{ code: 0, signal:
  // null }`. The real teardown isn't assembled this early, so `stop` here
  // awaits `ready`, which startup resolves with the real stop function once
  // every subsystem below exists; by the time that resolves, the entire
  // startup sequence (and so every resource `stop` touches) is guaranteed to
  // have completed, whatever point mid-startup the signal actually arrived.
  let resolveReady!: (stop: () => Promise<void>) => void;
  const ready = new Promise<() => Promise<void>>((resolve) => {
    resolveReady = resolve;
  });
  // The handler above has to be given a logger before `workerId` exists, but
  // its "shutting down"/"shutdown complete" lines should carry `workerId`
  // once registration below has assigned one -- as they did before GOT.96
  // moved installation earlier. `shutdownLogger` forwards every call to
  // whichever logger `currentLogger` points at *when the signal fires*, so
  // swapping `currentLogger` to `log.child({ workerId })` after registration
  // (below) is enough; a signal that arrives before that swap still logs
  // and exits cleanly through `bootstrap`, just without `workerId`.
  let currentLogger: Logger = bootstrap;
  const shutdownLogger: Logger = {
    debug: (fields, msg) => currentLogger.debug(fields, msg),
    info: (fields, msg) => currentLogger.info(fields, msg),
    warn: (fields, msg) => currentLogger.warn(fields, msg),
    error: (fields, msg) => currentLogger.error(fields, msg),
    child: (fields) => currentLogger.child(fields),
  };
  installSignalHandlers({
    logger: shutdownLogger,
    stop: async () => {
      const stop = await ready;
      await stop();
    },
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

  // design.md §9.9 Scheduling: the `docker` capability when `docker info`
  // succeeds and the configured image is present. Without it the worker
  // never touches Docker again.
  const docker = await detectDockerCapability({ image: config.agentContainerImage });
  if (docker.available) {
    logger.info({ image: config.agentContainerImage }, "docker available, container mode enabled");
  } else {
    logger.info({ reason: docker.reason }, "docker not available, container mode disabled");
  }

  let workerId: string;
  try {
    workerId = await registerWorker(db, {
      ...config,
      capabilities: workerCapabilities(config.capabilities, docker.available),
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "worker registration failed",
    );
    await closeDb(db).catch(() => {});
    process.exit(1);
  }

  const log = logger.child({ workerId });
  // From here on, a signal's shutdown log lines carry `workerId` too.
  currentLogger = log;
  log.info({ config: redactConfig(config) }, "worker registered");

  // GOT.82, design.md §9.3, §6.3: a spec execution stays `RUNNING` with a
  // live agent-tools token only for the length of one turn; a crash on this
  // host can leave that token set with no agent process left to finish the
  // turn and revoke it. Run once, before the runner, scheduler phases and
  // the agent-tools server below accept any work, so `holdsCapacity` never
  // counts a leftover token as a held slot and worktree.
  try {
    const revoked = await revokeRunningSpecTokensOnHost(db, config.host);
    log.info({ revoked }, "revoked stale spec-execution agent-tools tokens");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to revoke stale spec-execution agent-tools tokens",
    );
    await closeDb(db).catch(() => {});
    process.exit(1);
  }

  // design.md §9.7: `config/pricing.json`, loaded once and passed to the
  // runner. A bad or missing file fails startup rather than silently
  // pricing every Codex usage event as unknown. A relative `PRICING_FILE`
  // (including the default) is resolved against the repo root, not the
  // process's cwd, so it is found however the worker was launched.
  const pricingPath = path.isAbsolute(config.pricingFile)
    ? config.pricingFile
    : path.join(REPO_ROOT, config.pricingFile);
  let pricing;
  try {
    pricing = await loadPricing(pricingPath);
  } catch (err) {
    if (err instanceof PricingFileError) {
      log.error({ path: err.path, err: err.message }, "pricing file failed to load");
      await closeDb(db).catch(() => {});
      process.exit(1);
    }
    throw err;
  }

  // design.md §8: one agent-tools MCP server per worker, on loopback. The
  // registry is shared with the runner (GOT.31).
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

  // design.md §9.9: only a docker-capable worker builds the container stack:
  // one deployment owner for the manager and the sweeper's cleanup, and the
  // agent-tools container listener. If that fails the worker runs host mode
  // only and re-registers without the capability.
  let dockerStack: DockerStack | undefined;
  if (docker.available) {
    try {
      const owner = await deploymentOwner(db);
      dockerStack = await startDockerStack({
        config,
        owner,
        toolsServer,
        logger: log.child({ component: "containers" }),
      });
      log.info({ containerToolsUrl: dockerStack.toolsUrl() }, "agent container stack ready");
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "agent container stack failed to start; container mode disabled",
      );
      await registerWorker(db, {
        ...config,
        capabilities: workerCapabilities(config.capabilities, false),
      });
    }
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
  // design.md §11.1: independent write-back loop, posting a Jira comment on
  // spec approval, PR creation, READY_FOR_MERGE and NEEDS_HUMAN. Same
  // credential gate as the poller (E4); never blocks startup.
  const stopJiraWriteback = startJiraWriteback({
    db,
    config,
    logger: log.child({ component: "jira-writeback" }),
  });
  // design.md §11.2: independent 60s-interval poller for CI status, merge
  // and close on every open pull request. No-ops with one warning when
  // GITHUB_TOKEN is absent; never blocks startup.
  const stopGitHubPoller = startGitHubPoller({
    db,
    config,
    workerId,
    logger: log.child({ component: "github-poller" }),
  });
  // design.md §7.3: claim only tasks whose runtime binary is on PATH.
  const runtimes = detectRuntimes();
  log.info({ runtimes }, "detected agent runtimes");

  // design.md §9: the execution runner, fed by the claim phase (§6.3) and
  // the command consumer (§6.1). A runtime is claimable when its binary is
  // on PATH (`runtimes` above) and it has an adapter here.
  const jira =
    config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken
      ? createJiraClient({
          baseUrl: config.jiraBaseUrl,
          email: config.jiraEmail,
          apiToken: config.jiraApiToken,
        })
      : undefined;
  // One manager for the runner and the §6.6 worktree sweeper.
  const worktrees = new WorktreeManager({ workspaceRoot: config.workspaceRoot });
  const runner = createRunner({
    db,
    registry,
    logger: log.child({ component: "runner" }),
    workerId,
    host: config.host,
    worktrees,
    adapters: {
      claude: new ClaudeAdapter(),
      codex: new CodexAdapter({
        debug: (reason, line) =>
          log.debug({ component: "codex-adapter", reason, line }, "ignored codex output"),
      }),
    },
    pricing,
    toolsUrl: () => toolsServer.url,
    ...(jira ? { fetchTicket: (key: string) => jira.getIssue(key) } : {}),
    ...(config.githubToken ? { githubToken: config.githubToken } : {}),
    quietTimeoutMs: config.agentQuietTimeoutMs,
    ...(dockerStack
      ? {
          containers: {
            manager: dockerStack.manager,
            toolsUrl: dockerStack.toolsUrl,
            credentials: {
              githubToken: config.githubToken,
              claudeCodeOauthToken: config.claudeCodeOauthToken,
              anthropicApiKey: config.anthropicApiKey,
              openaiApiKey: config.openaiApiKey,
            },
            adapterFor: (runtime, options) =>
              createContainerAdapter(runtime, options, {
                codexDebug: (reason, line) =>
                  log.debug({ component: "codex-adapter", reason, line }, "ignored codex output"),
              }),
          },
        }
      : {}),
  });
  const commands = createCommandHandlers();
  registerCancelHandler(commands, runner);
  // design.md §11.2: CI feedback resumes the same execution (GOT.39).
  registerCiFailureHandler(commands, runner);
  // design.md §12.3, D8: spec sessions start and chat by command (GOT.37).
  // A send_message on an issue is the issue conversation (§9.3, GOT.47),
  // on an implementation or a spec execution (C54).
  registerSpecHandlers(commands, runner, {
    issueSendMessage: createIssueMessageHandler(runner),
  });
  // design.md §10.3, §10.4: issue resolution resumes the execution (GOT.47).
  registerIssueHandlers(commands, runner);

  const loop = createTickLoop({
    db,
    workerId,
    config,
    phases: createDefaultPhases(
      {
        runtimes,
        onClaimed: runner.onClaimed,
        commands,
      },
      // §6.6, §9.9 Orphans: container cleanup only on a docker-capable worker,
      // never of an execution the runner is running here (C4 F1).
      {
        worktrees,
        isLive: runner.isLive,
        ...(dockerStack ? { containers: dockerStack.executionContainers } : {}),
      },
    ),
    logger: log,
    intervalMs: DEFAULT_TICK_INTERVAL_MS,
  });
  loop.start();

  // design.md §9.5, §6.5: independent loop that starts QUEUED retries once
  // their backoff has passed, while this worker has a free slot (C25).
  const stopRetryStarter = startRetryStarter({
    db,
    runner,
    workerId,
    runtimes,
    logger: log.child({ component: "retry-starter" }),
  });

  log.info(
    {
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      phases: [...PHASE_ORDER],
    },
    "worker started",
  );

  // The real stop function, now that every subsystem it touches exists.
  // See the `installSignalHandlers` call at the top of this function for why
  // this is wired through `resolveReady` rather than called directly here.
  resolveReady(async () => {
    await loop.stop();
    // No retry may be handed to a runner that is shutting down.
    await stopRetryStarter();
    // Abort live sessions and let their finally blocks revoke tokens
    // before the tools server and the db go away.
    await runner.shutdown();
    await toolsServer.stop();
    await stopJiraPoller();
    await stopJiraWriteback();
    await stopGitHubPoller();
    await stopHeartbeat();
    await closeDb(db);
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
