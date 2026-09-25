import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { Runtime } from "@orchestra/core";

/** Binary each runtime's adapter spawns or drives (design.md §7.1, §7.2). */
const RUNTIME_BINARIES: ReadonlyArray<readonly [Runtime, string]> = [
  ["claude", "claude"],
  ["codex", "codex"],
];

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runtimes whose binary is on `PATH` (design.md §7.3: "The worker refuses
 * to claim a task whose runtime binary is not on its PATH"). Run once at
 * startup. `env` is injectable so tests control `PATH`.
 */
export function detectRuntimes(
  env: NodeJS.ProcessEnv = process.env,
): Runtime[] {
  const dirs = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir.length > 0);

  return RUNTIME_BINARIES.filter(([, binary]) =>
    dirs.some((dir) => isExecutableFile(path.join(dir, binary))),
  ).map(([runtime]) => runtime);
}
