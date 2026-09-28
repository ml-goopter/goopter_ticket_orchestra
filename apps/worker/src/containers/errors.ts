/** Upper bound, in characters, of docker stderr kept on an error. */
export const DOCKER_STDERR_LIMIT = 4096;

/**
 * Why a docker CLI call failed:
 *
 * - `unavailable`: the CLI is missing or the daemon is not reachable.
 * - `timeout`: the call did not finish in its time limit.
 * - `failed`: docker ran and reported an error (create, exec, remove).
 */
export type DockerErrorReason = "unavailable" | "timeout" | "failed";

export interface DockerErrorInit {
  reason: DockerErrorReason;
  /** Arguments passed to `docker`. Never carries a secret value (§9.9). */
  args: readonly string[];
  /** `null` when docker did not exit normally or never started. */
  exitCode: number | null;
  stderr: string;
}

/**
 * A docker CLI call failed (design.md §9.9). Distinct from every other
 * worker error so the runner can classify it as `adapter_error`, retriable
 * (§9.5, §9.9 Scheduling).
 */
export class DockerError extends Error {
  readonly code = "DOCKER_FAILED" as const;
  readonly reason: DockerErrorReason;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  /** Bounded tail of docker's stderr. */
  readonly stderr: string;

  constructor(init: DockerErrorInit) {
    const stderr = init.stderr.slice(-DOCKER_STDERR_LIMIT);
    const verb = init.args.slice(0, 2).join(" ");
    super(
      `docker ${verb} ${init.reason} (exit ${init.exitCode ?? "none"}): ${stderr.trim()}`,
    );
    this.name = "DockerError";
    this.reason = init.reason;
    this.args = [...init.args];
    this.exitCode = init.exitCode;
    this.stderr = stderr;
  }
}
