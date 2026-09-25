import { spawn } from "node:child_process";
import { GitCommandError, SETUP_OUTPUT_TAIL_BYTES } from "./errors.js";

/** Keeps only the last `limit` bytes written to it. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  /**
   * Decoded tail, at most `limit` bytes as UTF-8. Invalid bytes decode to
   * U+FFFD (3 bytes), which can grow the text, so the decoded form is cut
   * again at a character boundary.
   */
  toString(): string {
    const decoded = decodeFromBoundary(Buffer.concat(this.chunks));
    const encoded = Buffer.from(decoded, "utf8");
    if (encoded.length <= this.limit) return decoded;
    return decodeFromBoundary(encoded.subarray(encoded.length - this.limit));
  }
}

/** Drops leading UTF-8 continuation bytes, then decodes. */
function decodeFromBoundary(bytes: Buffer): string {
  let start = 0;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

export interface ShellResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Bounded tail of interleaved stdout and stderr. */
  tail: string;
}

/**
 * Environment for git. `GIT_TERMINAL_PROMPT=0` makes a missing credential
 * fail instead of hanging the worker on an interactive prompt. Everything
 * else, including auth, comes from the host's git configuration (D6).
 */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/** Runs `git <args>` in `cwd`. Throws `GitCommandError` on a non-zero exit. */
export function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr = new TailBuffer(SETUP_OUTPUT_TAIL_BYTES);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) =>
      reject(new GitCommandError(args, null, err.message)),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new GitCommandError(args, code, stderr.toString()));
      }
    });
  });
}

/**
 * Runs `command` through `/bin/sh -c` in `cwd` and resolves with its exit
 * status and the bounded tail of interleaved stdout and stderr. Never
 * rejects on a non-zero exit; spawn errors resolve as exit `null`.
 */
export function runShell(
  cwd: string,
  command: string,
  tailBytes: number = SETUP_OUTPUT_TAIL_BYTES,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail = new TailBuffer(tailBytes);
    child.stdout.on("data", (chunk: Buffer) => tail.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => tail.push(chunk));
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("close", (code, signal) => {
      if (spawnError) tail.push(Buffer.from(spawnError.message));
      resolve({
        exitCode: spawnError ? null : code,
        signal,
        tail: tail.toString(),
      });
    });
  });
}
