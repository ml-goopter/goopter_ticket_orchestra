import { spawn } from "node:child_process";
import { DOCKER_STDERR_LIMIT, DockerError } from "./errors.js";

/** Default limit for one docker CLI call. */
export const DOCKER_TIMEOUT_MS = 30_000;

export interface DockerRunOptions {
  /** Kill the docker client and reject with `DockerError` after this long. */
  timeoutMs: number;
  /**
   * Values for the variables the call names with `-e NAME`. They reach the
   * docker client through its environment, never its argv, so host `ps`
   * cannot show them (§9.9).
   */
  env?: Readonly<Record<string, string>>;
}

export interface DockerResult {
  /** `null` when docker was ended by a signal. */
  exitCode: number | null;
  stdout: string;
  /** Bounded tail. */
  stderr: string;
}

/**
 * Runs `docker <args>` to completion. Resolves on any exit status; rejects
 * with `DockerError` only when the CLI cannot start (`unavailable`) or the
 * timeout elapses (`timeout`). Tests inject a fake.
 */
export type DockerRunner = (
  args: readonly string[],
  options: DockerRunOptions,
) => Promise<DockerResult>;

/**
 * Host variables the docker client itself reads: its binary search path,
 * its config and context under `$HOME`, rootless sockets, and every
 * `DOCKER_*` setting. Nothing else from the worker's environment reaches
 * the client, so nothing else can reach a container through `-e NAME`.
 */
const CLIENT_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
]);

/** A portable environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names never forwarded into a container: `HOME` is the agent home and
 * `PATH` the image's (§9.9), and `DOCKER_*` would redirect the client.
 */
export function isReservedEnvName(name: string): boolean {
  return name === "HOME" || name === "PATH" || name.startsWith("DOCKER_");
}

/** True when `name` may be forwarded with `-e NAME`. */
export function isForwardableEnvName(name: string): boolean {
  return ENV_NAME.test(name) && !isReservedEnvName(name);
}

/** The docker client's own settings from `hostEnv`, plus `extra`. */
export function dockerClientEnv(
  hostEnv: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (CLIENT_ENV_NAMES.has(name) || name.startsWith("DOCKER_")) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (isForwardableEnvName(name)) env[name] = value;
  }
  return env;
}

const UNAVAILABLE =
  /Cannot connect to the Docker daemon|failed to connect to the docker API|error during connect|Is the docker daemon running/i;
const DAEMON_ERROR =
  /^(docker: )?Error response from daemon:|^OCI runtime exec failed|^Error: No such (container|object)/;

/**
 * True when `stderr` begins with a docker CLI or daemon error rather than
 * output of the command docker ran. Only the start is examined, so an
 * agent that prints similar text later is not mistaken for docker.
 */
export function startsWithDockerError(stderr: string): boolean {
  const head = stderr.trimStart();
  return DAEMON_ERROR.test(head) || UNAVAILABLE.test(head.split("\n", 1)[0] ?? "");
}

/** The `DockerError` for a call that ran and exited non-zero. */
export function dockerFailure(
  args: readonly string[],
  result: Pick<DockerResult, "exitCode" | "stderr">,
): DockerError {
  return new DockerError({
    reason: UNAVAILABLE.test(result.stderr) ? "unavailable" : "failed",
    args,
    exitCode: result.exitCode,
    stderr: result.stderr,
  });
}

/** Throws `dockerFailure` unless the call exited 0. */
export function checkDocker(args: readonly string[], result: DockerResult): DockerResult {
  if (result.exitCode !== 0) throw dockerFailure(args, result);
  return result;
}

/** Maps a failure to start the docker client to `DockerError`. */
export function spawnFailure(args: readonly string[], err: unknown): DockerError {
  if (err instanceof DockerError) return err;
  return new DockerError({
    reason: "unavailable",
    args,
    exitCode: null,
    stderr: err instanceof Error ? err.message : String(err),
  });
}

export interface DockerRunnerOptions {
  /** Defaults to `docker` on the client environment's `PATH`. */
  binary?: string;
  /** Source of the client's own settings. Defaults to `process.env`. */
  hostEnv?: NodeJS.ProcessEnv;
}

/** The real `DockerRunner`: spawns the docker CLI. */
export function createDockerRunner(options: DockerRunnerOptions = {}): DockerRunner {
  const binary = options.binary ?? "docker";
  return (args, runOptions) =>
    new Promise((resolve, reject) => {
      const hostEnv = options.hostEnv ?? process.env;
      // Its own process group, so a timeout also reaches what it spawned
      // (a credential helper, an ssh transport).
      const child = spawn(binary, [...args], {
        env: dockerClientEnv(hostEnv, runOptions.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        settle(() =>
          reject(
            new DockerError({
              reason: "timeout",
              args,
              exitCode: null,
              stderr: `timed out after ${runOptions.timeoutMs} ms`,
            }),
          ),
        );
      }, runOptions.timeoutMs);
      const stdout: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-DOCKER_STDERR_LIMIT);
      });
      child.on("error", (err) => settle(() => reject(spawnFailure(args, err))));
      child.on("close", (code) =>
        settle(() =>
          resolve({ exitCode: code, stdout: Buffer.concat(stdout).toString("utf8"), stderr }),
        ),
      );
    });
}

/** `createDockerRunner()` with its defaults. */
export const runDocker: DockerRunner = createDockerRunner();
