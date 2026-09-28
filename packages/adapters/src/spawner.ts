import { spawn as spawnChild } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Process spawner shared by the Claude and Codex adapters (design.md §9.9).
 * Adapters take a spawner and stay unaware of where the process runs: the
 * host spawner below, or a container spawner the worker injects.
 */

/** How a spawned process ended. */
export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

export interface ProcessSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

/**
 * A spawned agent process. `kill` must stop the whole process group, not
 * just the direct child: an agent runtime runs its commands as its own
 * children.
 */
export interface AgentProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** Settles when the process has exited. Rejects if it never started. */
  exit: Promise<ProcessExit>;
  /** Sends `signal` (default `SIGKILL`) to the process group. */
  kill(signal?: NodeJS.Signals): void;
}

export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: ProcessSpawnOptions,
) => AgentProcess;

/**
 * Spawns on the host in a new process group, so `kill` also reaches the
 * commands the process runs, as the worktree runner does for git.
 */
export const spawnHostProcess: ProcessSpawner = (command, args, options) => {
  const child = spawnChild(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  // A process that exits before reading its input closes stdin (EPIPE).
  child.stdin.on("error", () => {});
  const exit = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exit,
    kill(signal = "SIGKILL") {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    },
  };
};
