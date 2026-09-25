import { execFile } from "node:child_process";
import path from "node:path";
import type { UntrackedFile } from "@orchestra/prompts";
import { ReviewError } from "./errors.js";

/** Runs `git <args>` in `cwd`, resolving stdout. Rejects on a non-zero exit. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** Largest git output accepted. A review diff above this is refused. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new ReviewError(`git ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface WorktreeChanges {
  mergeBase: string;
  /** `git diff <merge-base>`: committed and uncommitted changes to tracked files. */
  diff: string;
  untracked: UntrackedFile[];
}

/**
 * What the reviewer sees (design.md §9.8 step 2, GOT.40 contract D):
 *
 *  - merge base of `origin/<default>` and HEAD, or of the local
 *    `<default>` when the remote-tracking ref is absent;
 *  - `git diff <merge-base>`, the working tree against the merge base, so
 *    uncommitted edits are included;
 *  - every untracked, non-ignored file with its content read from disk.
 *
 * Nothing else under the worktree is read.
 */
export async function collectChanges(
  cwd: string,
  defaultBranch: string,
  deps: { git: GitRunner; readFile: (file: string) => Promise<string> },
): Promise<WorktreeChanges> {
  const { git, readFile } = deps;
  const originRef = `refs/remotes/origin/${defaultBranch}`;
  const hasOrigin = await git(["rev-parse", "--verify", "--quiet", originRef], cwd).then(
    () => true,
    () => false,
  );
  const base = hasOrigin ? originRef : defaultBranch;
  const mergeBase = (await git(["merge-base", base, "HEAD"], cwd)).trim();

  const diff = await git(["diff", "--no-color", "--no-ext-diff", mergeBase], cwd);

  const listed = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  const paths = listed.split("\0").filter((p) => p !== "");
  const untracked: UntrackedFile[] = [];
  for (const rel of paths) {
    let content: string;
    try {
      content = await readFile(path.join(cwd, rel));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewError(`cannot read untracked file ${rel}: ${detail}`);
    }
    untracked.push({ path: rel, content });
  }

  return { mergeBase, diff, untracked };
}
