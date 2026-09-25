/** Upper bound, in bytes, of the output kept on a failure. */
export const SETUP_OUTPUT_TAIL_BYTES = 16 * 1024;

/**
 * A git command run by the worktree manager exited non-zero or could not be
 * started. Distinct from `SetupFailedError` so the runner can tell a broken
 * clone or ref from a failing repository setup command.
 */
export class GitCommandError extends Error {
  readonly code = "GIT_COMMAND_FAILED" as const;
  /** Arguments passed to `git`, without the leading `git`. */
  readonly args: readonly string[];
  /** `null` when git was killed by a signal or could not be spawned. */
  readonly exitCode: number | null;
  /** Bounded tail of git's stderr. */
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(
      `git ${args.join(" ")} failed (exit ${exitCode ?? "none"}): ${stderr.trim()}`,
    );
    this.name = "GitCommandError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * `repositories.setup_command` exited non-zero (design.md §9.1 step 3). The
 * runner maps this to `end_reason = setup_failed`, an infrastructure failure
 * (§9.5).
 */
export class SetupFailedError extends Error {
  readonly code = "SETUP_FAILED" as const;
  /** `null` when the command was killed by a signal. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Last `SETUP_OUTPUT_TAIL_BYTES` of interleaved stdout and stderr. */
  readonly outputTail: string;

  constructor(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    outputTail: string,
  ) {
    super(
      `setup command failed (${exitCode === null ? `signal ${signal ?? "unknown"}` : `exit ${exitCode}`})`,
    );
    this.name = "SetupFailedError";
    this.exitCode = exitCode;
    this.signal = signal;
    this.outputTail = outputTail;
  }
}
