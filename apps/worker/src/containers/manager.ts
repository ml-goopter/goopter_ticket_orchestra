import fs from "node:fs/promises";
import path from "node:path";
import { spawnHostProcess, type ProcessSpawner } from "@orchestra/adapters";
import type { ExecutionRole } from "@orchestra/core";
import type { Logger } from "../logger.js";
import { SETUP_OUTPUT_TAIL_BYTES } from "../worktrees/errors.js";
import {
  DOCKER_TIMEOUT_MS,
  checkDocker,
  createDockerRunner,
  dockerFailure,
  isForwardableEnvName,
  runDocker,
  type DockerRunner,
} from "./docker.js";
import { launchInContainer, createContainerSpawner, type ContainerSpawnerDeps } from "./spawner.js";

/** The bridge network agent containers join (§9.9 Network). */
export const AGENT_NETWORK = "orchestra-agents";
export const EXECUTION_LABEL = "orchestra.execution";
export const TASK_LABEL = "orchestra.task";

/** `docker run` can be slow on a cold daemon; everything else uses the default. */
const CREATE_TIMEOUT_MS = 120_000;

/** One container per execution (§9.9 Lifecycle). */
export function containerName(executionId: string): string {
  return `orchestra-exec-${executionId}`;
}

const NOT_FOUND = /No such container|No such object/i;

function isNotFound(stderr: string): boolean {
  return NOT_FOUND.test(stderr);
}

/** A container carrying the `orchestra.execution` label. */
export interface LabelledContainer {
  /** Full container id. */
  id: string;
  name: string;
  /** The label's value; not necessarily an execution id. */
  executionId: string;
  /** The `orchestra.task` label, null when absent. */
  taskId: string | null;
}

/** What the worktree sweeper needs from Docker (§6.6, §9.9 Orphans). */
export interface ExecutionContainerOps {
  list(): Promise<LabelledContainer[]>;
  /** Removes `orchestra-exec-<executionId>`; succeeds when it is already gone. */
  removeForExecution(executionId: string): Promise<void>;
  /** Removes a container by id or name; succeeds when it is already gone. */
  remove(ref: string): Promise<void>;
}

async function removeContainer(run: DockerRunner, ref: string, timeoutMs: number): Promise<void> {
  const args = ["rm", "-f", "-v", ref];
  const result = await run(args, { timeoutMs });
  if (result.exitCode !== 0 && !isNotFound(result.stderr)) throw dockerFailure(args, result);
}

const LIST_FORMAT = `{{.ID}}\t{{.Names}}\t{{.Label "${EXECUTION_LABEL}"}}\t{{.Label "${TASK_LABEL}"}}`;

/** `ExecutionContainerOps` over the docker CLI. */
export function dockerExecutionContainers(
  run: DockerRunner = runDocker,
  timeoutMs: number = DOCKER_TIMEOUT_MS,
): ExecutionContainerOps {
  return {
    async list() {
      const args = ["ps", "-a", "--no-trunc", "--filter", `label=${EXECUTION_LABEL}`, "--format", LIST_FORMAT];
      const { stdout } = checkDocker(args, await run(args, { timeoutMs }));
      return stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const [id = "", name = "", executionId = "", taskId = ""] = line.split("\t");
          return { id, name, executionId, taskId: taskId === "" ? null : taskId };
        });
    },
    removeForExecution: (executionId) => removeContainer(run, containerName(executionId), timeoutMs),
    remove: (ref) => removeContainer(run, ref, timeoutMs),
  };
}

export interface ContainerManagerOptions {
  /** `config.workspaceRoot`. */
  workspaceRoot: string;
  /** `AGENT_CONTAINER_IMAGE`, used when a repository has no override. */
  image: string;
  /** `AGENT_CONTAINER_CPUS`. */
  cpus: number;
  /** `AGENT_CONTAINER_MEMORY`. */
  memory: string;
  /** Defaults to the docker CLI. Tests inject a fake. */
  run?: DockerRunner;
  /** Starts docker exec clients. Defaults to `spawnHostProcess`. */
  spawnClient?: ProcessSpawner;
  /** The docker CLI. Defaults to `docker` on `PATH`. */
  binary?: string;
  /** Defaults to the worker's own uid and gid. */
  uid?: number;
  gid?: number;
  /** Defaults to `orchestra-agents`. */
  network?: string;
  /** Limit for each short docker call. */
  timeoutMs?: number;
  /** The worker's environment. Defaults to `process.env`. */
  hostEnv?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface EnsureContainerInput {
  executionId: string;
  taskId: string;
  /** `repositories.name`; the bare clone is `repos/<name>.git`. */
  repositoryName: string;
  /** `spec` mounts the worktree and bare clone read-only. */
  role: ExecutionRole;
  /**
   * The container's variables (§9.9 Environment), by value. Only these,
   * `HOME` and the image `PATH` exist in the container. `HOME`, `PATH` and
   * `DOCKER_*` are rejected.
   */
  env: Readonly<Record<string, string>>;
  /** `repositories.agent_image`. Empty or null means the configured image. */
  image?: string | null;
  /**
   * The execution's recorded worktree, which a retry may have taken over
   * from an earlier execution (C33). Must be under `<root>/work/`.
   * Defaults to `<root>/work/<executionId>`.
   */
  worktreePath?: string;
}

export interface AgentContainer {
  name: string;
  executionId: string;
  taskId: string;
  worktreePath: string;
  /** `<root>/agent-home/<taskId>`, the container's `$HOME`. */
  home: string;
  /** False when a running container was reused. */
  created: boolean;
}

export interface ContainerShellInput {
  container: string;
  /** The worktree. */
  cwd: string;
  command: string;
  timeoutMs: number;
}

export interface ContainerShellResult {
  /** Null when the command was killed. */
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  /** Bounded tail of interleaved stdout and stderr. */
  tail: string;
  timedOut: boolean;
}

interface ContainerState {
  Running?: boolean;
  Paused?: boolean;
  Restarting?: boolean;
}

/**
 * Agent containers for executions of repositories in container mode
 * (design.md §9.9, D20): create, reuse, recreate and remove one container
 * per execution, launch processes in it, and look up the network gateway.
 * Every docker call has a timeout; every docker failure is a `DockerError`.
 */
export class ContainerManager {
  readonly #root: string;
  readonly #image: string;
  readonly #cpus: number;
  readonly #memory: string;
  readonly #run: DockerRunner;
  readonly #spawnClient: ProcessSpawner;
  readonly #binary: string;
  readonly #uid: number;
  readonly #gid: number;
  readonly #network: string;
  readonly #timeoutMs: number;
  readonly #hostEnv: NodeJS.ProcessEnv | undefined;
  readonly #logger: Logger | undefined;
  readonly #ops: ExecutionContainerOps;

  constructor(options: ContainerManagerOptions) {
    this.#root = path.resolve(options.workspaceRoot);
    this.#image = options.image;
    this.#cpus = options.cpus;
    this.#memory = options.memory;
    this.#binary = options.binary ?? "docker";
    this.#hostEnv = options.hostEnv;
    this.#run =
      options.run ?? createDockerRunner({ binary: this.#binary, hostEnv: options.hostEnv });
    this.#spawnClient = options.spawnClient ?? spawnHostProcess;
    this.#uid = options.uid ?? process.getuid?.() ?? 0;
    this.#gid = options.gid ?? process.getgid?.() ?? 0;
    this.#network = options.network ?? AGENT_NETWORK;
    this.#timeoutMs = options.timeoutMs ?? DOCKER_TIMEOUT_MS;
    this.#logger = options.logger;
    this.#ops = dockerExecutionContainers(this.#run, this.#timeoutMs);
  }

  /**
   * Returns the execution's container, running. A running one is reused. A
   * missing one is created, and a stopped or paused one is removed and
   * recreated, from this call's inputs: no state lives only in the
   * container, so a resume after a worker restart gets the same mounts.
   */
  async ensure(input: EnsureContainerInput): Promise<AgentContainer> {
    const name = containerName(input.executionId);
    const worktreePath = this.#worktreePath(input);
    const repoPath = this.#repoPath(input.repositoryName);
    const home = path.join(this.#root, "agent-home", input.taskId);
    const names = Object.keys(input.env);
    for (const envName of names) {
      if (!isForwardableEnvName(envName)) {
        throw new TypeError(`container env name ${JSON.stringify(envName)} is not allowed`);
      }
    }
    if (!/^[A-Za-z0-9-]+$/.test(input.executionId) || !/^[A-Za-z0-9-]+$/.test(input.taskId)) {
      throw new TypeError("execution and task ids must be plain identifiers");
    }
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const handle = { name, executionId: input.executionId, taskId: input.taskId, worktreePath, home };

    const state = await this.#inspect(name);
    if (state && isUsable(state)) return { ...handle, created: false };
    if (state) await this.remove(input.executionId);

    await this.ensureNetwork();
    const readonly = input.role === "spec" ? ",readonly" : "";
    const image = input.image?.trim() || this.#image;
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `${EXECUTION_LABEL}=${input.executionId}`,
      "--label",
      `${TASK_LABEL}=${input.taskId}`,
      "--user",
      `${this.#uid}:${this.#gid}`,
      "--cpus",
      String(this.#cpus),
      "--memory",
      this.#memory,
      "--network",
      this.#network,
      "--pull",
      "never",
      "--mount",
      bindMount(worktreePath) + readonly,
      "--mount",
      bindMount(repoPath) + readonly,
      "--mount",
      bindMount(home),
      "-e",
      `HOME=${home}`,
      ...names.flatMap((envName) => ["-e", envName]),
      image,
    ];
    const result = await this.#run(args, { timeoutMs: CREATE_TIMEOUT_MS, env: input.env });
    if (result.exitCode !== 0) {
      // A concurrent ensure for the same execution won the name.
      if (/is already in use/.test(result.stderr)) {
        const now = await this.#inspect(name);
        if (now && isUsable(now)) return { ...handle, created: false };
      }
      throw dockerFailure(args, result);
    }
    this.#logger?.info({ container: name, image }, "agent container created");
    return { ...handle, created: true };
  }

  /** Removes the execution's container. Succeeds when it is already gone. */
  remove(executionId: string): Promise<void> {
    return this.#ops.removeForExecution(executionId);
  }

  /** Creates the bridge network when it does not exist. */
  async ensureNetwork(): Promise<void> {
    const inspect = ["network", "inspect", "--format", "{{.Name}}", this.#network];
    const found = await this.#run(inspect, { timeoutMs: this.#timeoutMs });
    if (found.exitCode === 0) return;
    if (!/not found/i.test(found.stderr)) throw dockerFailure(inspect, found);
    const create = ["network", "create", "--driver", "bridge", this.#network];
    const created = await this.#run(create, { timeoutMs: this.#timeoutMs });
    if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
      throw dockerFailure(create, created);
    }
  }

  /**
   * The network's IPv4 gateway, the host address containers reach the
   * agent-tools listener on under Linux (§9.9 Network). Creates the network
   * first when needed. Null when it has no IPv4 gateway.
   */
  async networkGateway(): Promise<string | null> {
    await this.ensureNetwork();
    const args = ["network", "inspect", "--format", "{{json .IPAM.Config}}", this.#network];
    const { stdout } = checkDocker(args, await this.#run(args, { timeoutMs: this.#timeoutMs }));
    const configs = (JSON.parse(stdout.trim() || "null") ?? []) as Array<{ Gateway?: string }>;
    const gateway = configs.find((c) => typeof c.Gateway === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(c.Gateway));
    return gateway?.Gateway ?? null;
  }

  /**
   * A `ProcessSpawner` running every process in `container` under
   * `orchestra-launch` (§9.9 Launching processes). The exec gets the
   * container's variables plus those of the spawn whose names the worker's
   * own environment does not define.
   */
  spawner(container: string): ProcessSpawner {
    return createContainerSpawner(this.#spawnerDeps(container));
  }

  /**
   * Runs `sh -c <command>` in `input.cwd` in the container under the
   * launcher, for `setup_command` (§9.9). Resolves with the exit status and
   * the output tail; on timeout kills the command's process group and
   * resolves with `timedOut`. Rejects with `DockerError` when docker exec
   * itself fails.
   */
  async runShell(input: ContainerShellInput): Promise<ContainerShellResult> {
    const proc = launchInContainer(
      this.#spawnerDeps(input.container),
      "sh",
      ["-c", input.command],
      input.cwd,
      {},
    );
    proc.stdin.on("error", () => {});
    proc.stdin.end();
    let tail = "";
    const collect = (chunk: Buffer): void => {
      tail = (tail + chunk.toString("utf8")).slice(-SETUP_OUTPUT_TAIL_BYTES);
    };
    proc.stdout.on("data", collect);
    proc.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, input.timeoutMs);
    try {
      const exit = await proc.exit;
      await new Promise((resolve) => setImmediate(resolve));
      return { exitCode: exit.code, signal: exit.signal, tail, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }

  #spawnerDeps(container: string): ContainerSpawnerDeps {
    return {
      container,
      run: this.#run,
      spawnClient: this.#spawnClient,
      binary: this.#binary,
      hostEnv: () => this.#hostEnv ?? process.env,
      killTimeoutMs: this.#timeoutMs,
      logger: this.#logger,
    };
  }

  /** The container's state, or null when it does not exist. */
  async #inspect(name: string): Promise<ContainerState | null> {
    const args = ["container", "inspect", "--format", "{{json .State}}", name];
    const result = await this.#run(args, { timeoutMs: this.#timeoutMs });
    if (result.exitCode !== 0) {
      if (isNotFound(result.stderr)) return null;
      throw dockerFailure(args, result);
    }
    return JSON.parse(result.stdout) as ContainerState;
  }

  #worktreePath(input: EnsureContainerInput): string {
    const work = path.join(this.#root, "work");
    const worktree = path.resolve(input.worktreePath ?? path.join(work, input.executionId));
    const rel = path.relative(work, worktree);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new TypeError(`worktree path must be under ${work}`);
    }
    return worktree;
  }

  #repoPath(repositoryName: string): string {
    if (
      repositoryName === "" ||
      repositoryName === "." ||
      repositoryName === ".." ||
      path.basename(repositoryName) !== repositoryName ||
      repositoryName.includes("\\")
    ) {
      throw new TypeError("repository name must be a single path segment");
    }
    return path.join(this.#root, "repos", `${repositoryName}.git`);
  }
}

function isUsable(state: ContainerState): boolean {
  return state.Running === true && state.Paused !== true && state.Restarting !== true;
}

/** Quotes one `--mount` field when it holds a CSV delimiter. */
function mountField(field: string): string {
  return /[",\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/** A bind mount at the same path inside and outside (§9.9 Mounts). */
function bindMount(hostPath: string): string {
  return ["type=bind", `source=${hostPath}`, `target=${hostPath}`].map(mountField).join(",");
}
