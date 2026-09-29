import {
  resolveContainerEndpoint,
  type AgentToolsServer,
} from "../agent-tools/index.js";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { DOCKER_TIMEOUT_MS, runDocker, type DockerRunner } from "./docker.js";
import {
  ContainerManager,
  dockerExecutionContainers,
  type ExecutionContainerOps,
} from "./manager.js";

/**
 * Start-up wiring of container mode (design.md §9.9 Scheduling, Network,
 * C4): the `docker` capability check and the container stack that only a
 * worker passing it builds.
 */

/** The capability a docker-capable worker registers (§9.9 Scheduling). */
export const DOCKER_CAPABILITY = "docker";

export interface DockerDetection {
  available: boolean;
  /** Why not, when unavailable. */
  reason?: string;
}

export interface DetectDockerOptions {
  /** `AGENT_CONTAINER_IMAGE`. */
  image: string;
  /** Defaults to the docker CLI. */
  run?: DockerRunner;
  timeoutMs?: number;
}

/**
 * §9.9 Scheduling: `docker info` succeeds and the configured image is
 * present locally. Never throws. Stops at the first failure, so a host
 * without Docker is asked nothing beyond `docker info`.
 */
export async function detectDockerCapability(
  options: DetectDockerOptions,
): Promise<DockerDetection> {
  const run = options.run ?? runDocker;
  const timeoutMs = options.timeoutMs ?? DOCKER_TIMEOUT_MS;
  const attempt = async (args: string[], what: string): Promise<string | null> => {
    try {
      const result = await run(args, { timeoutMs });
      if (result.exitCode === 0) return null;
      return `${what} failed (exit ${result.exitCode ?? "none"}): ${result.stderr.trim()}`;
    } catch (err) {
      return `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const info = await attempt(["info", "--format", "{{.ServerVersion}}"], "docker info");
  if (info !== null) return { available: false, reason: info };
  const image = await attempt(
    ["image", "inspect", "--format", "{{.Id}}", options.image],
    `image ${options.image} lookup`,
  );
  if (image !== null) return { available: false, reason: image };
  return { available: true };
}

/**
 * The capabilities to register: the configured ones, with `docker` exactly
 * when the check found it. A `docker` listed in `WORKER_CAPABILITIES` on a
 * host that failed the check is dropped, so container-mode tasks are never
 * routed to a worker that cannot run them.
 */
export function workerCapabilities(configured: readonly string[], docker: boolean): string[] {
  const rest = configured.filter((c) => c !== DOCKER_CAPABILITY);
  return docker ? [...rest, DOCKER_CAPABILITY] : rest;
}

export interface DockerStack {
  manager: ContainerManager;
  /** For the worktree sweeper's container cleanup (§6.6, §9.9 Orphans). */
  executionContainers: ExecutionContainerOps;
  /** The container-facing agent-tools URL: `ORCHESTRA_URL` and `mcp.url`. */
  toolsUrl: () => string;
}

export interface StartDockerStackInput {
  config: Pick<
    WorkerConfig,
    | "workspaceRoot"
    | "agentContainerImage"
    | "agentContainerCpus"
    | "agentContainerMemory"
    | "toolsPort"
  >;
  /** `deploymentOwner(db)`, computed once by the caller. */
  owner: string;
  toolsServer: Pick<AgentToolsServer, "startContainerListener" | "containerUrl">;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to the docker CLI. */
  run?: DockerRunner;
  logger?: Logger;
}

/**
 * Builds the container stack of a docker-capable worker: one
 * `ContainerManager` and one `dockerExecutionContainers`, both labelled with
 * `owner`, and the agent-tools container listener (§9.9 Network) at the
 * address `resolveContainerEndpoint` picks (on Linux the `orchestra-agents`
 * gateway from `networkGateway`). Never binds a wildcard. Rejects when the
 * listener cannot start.
 */
export async function startDockerStack(input: StartDockerStackInput): Promise<DockerStack> {
  const { config, owner, toolsServer } = input;
  const platform = input.platform ?? process.platform;
  const manager = new ContainerManager({
    workspaceRoot: config.workspaceRoot,
    image: config.agentContainerImage,
    cpus: config.agentContainerCpus,
    memory: config.agentContainerMemory,
    owner,
    ...(input.run ? { run: input.run } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
  const executionContainers = dockerExecutionContainers({
    owner,
    ...(input.run ? { run: input.run } : {}),
  });
  const gatewayAddress =
    platform === "linux" ? ((await manager.networkGateway()) ?? undefined) : undefined;
  const endpoint = resolveContainerEndpoint({
    platform,
    port: config.toolsPort,
    ...(gatewayAddress ? { gatewayAddress } : {}),
  });
  await toolsServer.startContainerListener(endpoint);
  return { manager, executionContainers, toolsUrl: () => toolsServer.containerUrl };
}
