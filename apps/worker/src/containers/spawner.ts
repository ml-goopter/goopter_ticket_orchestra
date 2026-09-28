import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import type { AgentProcess, ProcessExit, ProcessSpawner } from "@orchestra/adapters";
import type { Logger } from "../logger.js";
import {
  dockerClientEnv,
  dockerFailure,
  isForwardableEnvName,
  spawnFailure,
  startsWithDockerError,
  type DockerRunner,
} from "./docker.js";

/** Where `orchestra-launch` records each turn's process group id. */
export const PID_DIR = "/run/orchestra";

/**
 * Signals the process group recorded for turn `$1` with signal `$2`. The
 * pid file can lag the exec that writes it, so the script waits up to five
 * seconds for it; exit 3 means no process group was found.
 */
const KILL_SCRIPT =
  `f=${PID_DIR}/"$1".pid; i=0; ` +
  `while [ ! -s "$f" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; ` +
  `[ -s "$f" ] || exit 3; kill -s "$2" -- "-$(cat "$f")"`;

/** Bytes of the exec client's stderr examined for a docker error. */
const STDERR_HEAD_LIMIT = 1024;

export interface ContainerSpawnerDeps {
  container: string;
  run: DockerRunner;
  /** Starts the docker exec client on the host. */
  spawnClient: ProcessSpawner;
  binary: string;
  /** The worker's own environment, read at each spawn. */
  hostEnv: () => NodeJS.ProcessEnv;
  killTimeoutMs: number;
  logger?: Logger;
}

/** `SIGTERM` -> `TERM`; anything unexpected becomes `KILL`. */
function signalName(signal: NodeJS.Signals): string {
  const name = String(signal).replace(/^SIG/, "");
  return /^[A-Z0-9]+$/.test(name) ? name : "KILL";
}

/**
 * The variables of one spawn that go into the container: those whose name
 * the worker's own environment does not define (for example the turn's
 * `ORCHESTRA_TOKEN`, or a variable the agent SDK adds). Adapters build a
 * spawn's env from the whole worker environment, so a name the worker
 * defines is never forwarded here; long-lived credentials enter the
 * container only through `ContainerManager.ensure`'s env (§9.9).
 */
function perSpawnEnv(
  env: Record<string, string | undefined>,
  hostEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isForwardableEnvName(name)) continue;
    if (Object.prototype.hasOwnProperty.call(hostEnv, name)) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

/**
 * Starts `docker exec -i -w <cwd> -e NAME... <container> orchestra-launch
 * <turn> -- <command> <args>` with `forwarded` values in the client's
 * environment, and wraps it as an `AgentProcess`.
 */
export function launchInContainer(
  deps: ContainerSpawnerDeps,
  command: string,
  args: readonly string[],
  cwd: string,
  forwarded: Record<string, string>,
): AgentProcess {
  const turn = `turn-${randomUUID()}`;
  const names = Object.keys(forwarded);
  const execArgs = [
    "exec",
    "-i",
    "-w",
    cwd,
    ...names.flatMap((name) => ["-e", name]),
    deps.container,
    "orchestra-launch",
    turn,
    "--",
    command,
    ...args,
  ];
  const client = deps.spawnClient(deps.binary, execArgs, {
    cwd: process.cwd(),
    env: dockerClientEnv(deps.hostEnv(), forwarded),
  });

  let head = "";
  const stderr = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (head.length < STDERR_HEAD_LIMIT) head += chunk.toString("utf8");
      callback(null, chunk);
    },
  });
  client.stderr.on("error", (err) => stderr.destroy(err));
  client.stderr.pipe(stderr);

  let exited = false;
  const exit: Promise<ProcessExit> = client.exit.then(
    async (result) => {
      exited = true;
      if (result.code !== 0 && result.code !== null) {
        // Lets stderr already read by the client reach `head`.
        await new Promise((resolve) => setImmediate(resolve));
        if (startsWithDockerError(head)) {
          throw dockerFailure(execArgs.slice(0, 1), { exitCode: result.code, stderr: head });
        }
      }
      return result;
    },
    (err: unknown) => {
      exited = true;
      throw spawnFailure(execArgs.slice(0, 1), err);
    },
  );

  const log = deps.logger;
  return {
    stdin: client.stdin,
    stdout: client.stdout,
    stderr,
    exit,
    /**
     * Signals the turn's process group inside the container through a
     * separate `docker exec`, then kills the exec client: killing the
     * client alone leaves the process running (§9.9). After a non-KILL
     * signal reached the group the client is left to exit with it, so a
     * later SIGKILL still finds the group. When the in-container kill fails
     * the client is killed anyway.
     */
    kill(signal: NodeJS.Signals = "SIGKILL") {
      if (exited) return;
      const killArgs = ["exec", deps.container, "sh", "-c", KILL_SCRIPT, "sh", turn, signalName(signal)];
      void deps
        .run(killArgs, { timeoutMs: deps.killTimeoutMs })
        .then(
          (result) => {
            if (result.exitCode === 0) return true;
            log?.warn(
              { container: deps.container, turn, exitCode: result.exitCode, stderr: result.stderr },
              "in-container kill failed",
            );
            return false;
          },
          (err: unknown) => {
            log?.warn(
              { container: deps.container, turn, err: err instanceof Error ? err.message : String(err) },
              "in-container kill failed",
            );
            return false;
          },
        )
        .then((signalled) => {
          if (exited) return;
          if (!signalled || signal === "SIGKILL") client.kill(signal);
        });
    },
  };
}

/** A `ProcessSpawner` (packages/adapters) that runs every process in `deps.container`. */
export function createContainerSpawner(deps: ContainerSpawnerDeps): ProcessSpawner {
  return (command, args, options) =>
    launchInContainer(deps, command, args, options.cwd, perSpawnEnv(options.env, deps.hostEnv()));
}
