import { execFile } from "node:child_process";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import type { UntrackedFile } from "@orchestra/prompts";
import { ReviewError } from "./errors.js";

/**
 * Content recorded for an untracked directory (a nested repo or a
 * symlinked directory git lists but never recurses into). Never read.
 */
export const DIRECTORY_CONTENT_MARKER = "(directory)";

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

/**
 * Resolves the invoking cwd to the git worktree root (`git rev-parse
 * --show-toplevel`), so a review run from a subdirectory still finds
 * `.orchestra/context.json` and sees the whole diff and untracked listing.
 * A `cwd` outside any repository throws, same as any other git failure.
 */
export async function resolveWorktreeRoot(cwd: string, git: GitRunner): Promise<string> {
  const output = await git(["rev-parse", "--show-toplevel"], cwd);
  return output.trim();
}

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
 *  - every untracked, non-ignored path, with content read from disk for a
 *    regular file, the `readlink` target string for a symlink (never the
 *    target's content, which may live outside the worktree, D14), and the
 *    `DIRECTORY_CONTENT_MARKER` for a directory (a nested repo or a
 *    symlinked directory), never read.
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
    // `git ls-files` marks a directory entry (a nested repo, or a directory
    // under an ignored ancestor it still lists) with a trailing slash and
    // never recurses into it.
    const isListedAsDirectory = rel.endsWith("/");
    const relPath = isListedAsDirectory ? rel.slice(0, -1) : rel;
    const absolute = path.join(cwd, relPath);

    let stats;
    try {
      stats = await lstat(absolute);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewError(`cannot read untracked file ${rel}: ${detail}`);
    }

    if (isListedAsDirectory || stats.isDirectory()) {
      untracked.push({ path: relPath, content: DIRECTORY_CONTENT_MARKER });
      continue;
    }

    if (stats.isSymbolicLink()) {
      // Never follow the link: git stores the link's target string, not the
      // target's content, and the target can live outside the worktree.
      let target: string;
      try {
        target = await readlink(absolute);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ReviewError(`cannot read untracked file ${rel}: ${detail}`);
      }
      untracked.push({ path: relPath, content: target });
      continue;
    }

    let content: string;
    try {
      content = await readFile(absolute);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewError(`cannot read untracked file ${rel}: ${detail}`);
    }
    untracked.push({ path: relPath, content });
  }

  return { mergeBase, diff, untracked };
}
