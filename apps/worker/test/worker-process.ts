import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * GOT.92: `shutdown.test.ts` and `startup-token-revoke.test.ts` both launch
 * `apps/worker/src/index.ts` through the tsx CLI: `spawn(process.execPath,
 * [tsxCli, entry])`. tsx's CLI does not run the entry point itself -- it
 * spawns a *second* Node process (`node --import .../loader.mjs entry.ts`)
 * to do that, and only relays signals to it on a best-effort basis. Killing
 * just the `ChildProcess` handle a test gets back:
 *
 * - leaves that grandchild running, reparented to PID 1, whenever the test
 *   uses SIGKILL (uncatchable, so tsx never gets to relay it) or a test ends
 *   without waiting for the wrapper to finish relaying a SIGTERM;
 * - relies on tsx's own signal-relay race (a 30ms wait, a real signal, a
 *   30ms wait, then SIGKILL the grandchild) even in the tests that do wait.
 *
 * The fix here does not depend on tsx's relay at all: every worker is
 * spawned `detached: true`, making the tsx wrapper the leader of a new
 * process group that the grandchild it spawns inherits. Killing the whole
 * group (`process.kill(-pid, signal)`) reaches both processes directly, and
 * the group ID stays valid for the grandchild even after the wrapper itself
 * has exited. `killAllTrackedWorkersAndAssertNoneSurvive` is the
 * suite-level backstop: it force-kills every worker this module spawned,
 * whatever the test that spawned it did, then asserts against the OS
 * process table -- not this module's own bookkeeping -- because the
 * grandchild is a process no test ever gets a `ChildProcess` handle for.
 */

/** Absolute path to the worker entry point this worktree's tests spawn. */
export const WORKER_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const tracked = new Set<ChildProcess>();

/**
 * Spawns a process the same way the worker tests launch the tsx CLI, but in
 * its own process group so {@link killWorkerTree} can reach every process
 * tsx spawns, not just the one this returns. Tracks the child so
 * {@link killAllTrackedWorkersAndAssertNoneSurvive} can sweep it at suite
 * teardown regardless of whether the test that spawned it passed, failed or
 * timed out.
 */
export function spawnWorkerProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  tracked.add(child);
  child.once("exit", () => tracked.delete(child));
  return child;
}

/**
 * Sends `signal` to `child`'s whole process group, so the tsx wrapper *and*
 * the grandchild it spawns to run the entry point both receive it directly.
 * No-ops once `child` has already exited. Falls back to signalling just the
 * one pid if the group is already gone (for example on a very late,
 * already-exited call).
 */
export function killWorkerTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Sends `signal` to `child`'s process group and resolves once `child` has
 * exited, force-killing the whole group with SIGKILL after `timeoutMs` if
 * the graceful signal didn't land in time.
 */
export function killWorkerTreeAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => killWorkerTree(child, "SIGKILL"), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killWorkerTree(child, signal);
  });
}

/** Every live pid whose command line runs this worktree's `WORKER_ENTRY`. */
function listWorkerEntryPids(): number[] {
  const output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .filter((line) => line.includes(WORKER_ENTRY))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid));
}

/**
 * Suite-level safety net (GOT.92 acceptance #2-4). Force-kills every worker
 * process group this module spawned that is still alive, then asserts
 * against the OS process table that nothing running `WORKER_ENTRY` in this
 * worktree survived -- including a grandchild tsx spawned that this module
 * never held a `ChildProcess` handle for. Call from `afterAll`, after every
 * `it` has run (whether it passed, failed or timed out).
 */
export async function killAllTrackedWorkersAndAssertNoneSurvive(): Promise<void> {
  for (const child of tracked) killWorkerTree(child, "SIGKILL");

  const deadline = Date.now() + 5000;
  let survivors = listWorkerEntryPids();
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    survivors = listWorkerEntryPids();
  }
  if (survivors.length === 0) return;

  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  throw new Error(
    `${survivors.length} worker process(es) survived the suite: pid(s) ${survivors.join(", ")} running ${WORKER_ENTRY}`,
  );
}
