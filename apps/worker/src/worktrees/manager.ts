import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXECUTION_CONTEXT_PATH,
  ExecutionContextSchema,
  type ExecutionContext,
  type Runtime,
} from "@orchestra/core";
import { SetupFailedError } from "./errors.js";
import { runGit, runShell } from "./run.js";

/**
 * Worktree manager (design.md §9.1). Keeps one bare clone per repository at
 * `<workspaceRoot>/repos/<name>.git` and one worktree per execution at
 * `<workspaceRoot>/work/<executionId>`. No database access (GOT.25 D3): the
 * caller persists `worktree_path`, `branch`, and the `worktree.prepared`
 * event.
 *
 * The bare clone is created with `git init --bare` plus an `origin` remote,
 * not `git clone --mirror`, so fetched branches land in `refs/remotes/origin/*`
 * and `fetch --prune` never touches the local `agent/*` branches that
 * worktrees have checked out.
 *
 * A failed prepare leaves whatever it created in place. The worktree sweeper
 * (design.md §6.6) removes it with the failed execution.
 */

/** Fields of a `repositories` row the manager needs (design.md §4.2). */
export interface WorktreeRepository {
  name: string;
  gitUrl: string;
  defaultBranch: string;
  setupCommand?: string | null;
}

export interface PrepareImplementationInput {
  executionId: string;
  repository: WorktreeRepository;
  task: { id: string; jiraKey: string; jiraSummary: string };
  /** Approved revision this execution runs against. */
  spec: ExecutionContext["spec"];
  decisions: ExecutionContext["decisions"];
  /** Written to `context.json` as-is. Source is open (design.md OI3). */
  reviewCommand?: string | null;
  /** `executions.runtime`; `orchestra-review` picks its adapter by it (§9.8). */
  runtime: Runtime;
  /**
   * Start the working branch from `origin/agent/<KEY>-<short>` instead of
   * `origin/<default_branch>`: resume after eviction, or a retry from a
   * pushed branch (design.md §6.5, §6.6, §9.1).
   */
  resumeFromRemote?: boolean;
}

export interface PrepareSpecInput {
  executionId: string;
  repository: WorktreeRepository;
}

export interface PreparedWorktree {
  worktreePath: string;
  /** Working branch, `null` for a detached spec worktree. */
  branch: string | null;
}

export interface RemoveOptions {
  repositoryName: string;
  /**
   * Local branch to delete with the worktree. Kept when another worktree
   * has it checked out.
   */
  branch?: string | null;
}

export interface RemoveResult {
  branchDeleted: boolean;
}

export interface PushIfAheadInput {
  repositoryName: string;
  /** Local working branch, e.g. `agent/GOOP-421-0b7c2f4e`. */
  branch: string;
  /**
   * `repositories.default_branch`. Used to count commits only when the
   * remote does not have `branch` yet.
   */
  defaultBranch: string;
}

/** Why `pushIfAhead` did not push. */
export type PushSkipReason =
  /** The remote already has every local commit. */
  | "not_ahead"
  /** The remote branch has commits the local branch lacks. */
  | "diverged"
  /** No local branch of that name. */
  | "no_local_branch";

export interface PushIfAheadResult {
  pushed: boolean;
  /** Local commits the remote did not have before this call. */
  ahead: number;
  /** Set only when `pushed` is false. */
  reason?: PushSkipReason;
}

export interface WorktreeManagerOptions {
  /** `WorkerConfig.workspaceRoot`. */
  workspaceRoot: string;
}

/** Line added to the shared `info/exclude` so `context.json` stays untracked. */
const EXCLUDE_PATTERN = ".orchestra/";

/** One path segment: no separators, no leading dot or dash. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Jira key as a ref component: no dots, so no `..` or `.lock`. */
const SAFE_JIRA_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Branch given to `remove`: must not read as a git option. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertSafe(value: string, pattern: RegExp, what: string): void {
  if (!pattern.test(value)) {
    throw new Error(`invalid ${what}: ${JSON.stringify(value)}`);
  }
}

/**
 * `agent/<jiraKey>-<short>`, where `<short>` is the first 8 hex characters
 * of the task id (GOT.25 D1). Keyed on the task, not the execution, so a
 * retry finds the branch an earlier execution pushed.
 */
export function workingBranchName(jiraKey: string, taskId: string): string {
  assertSafe(jiraKey, SAFE_JIRA_KEY, "jira key");
  const short = taskId.slice(0, 8);
  if (!/^[0-9a-fA-F]{8}$/.test(short)) {
    throw new Error(`invalid task id: ${JSON.stringify(taskId)}`);
  }
  return `agent/${jiraKey}-${short.toLowerCase()}`;
}

/**
 * Serialises git operations on one bare clone within this process, keyed by
 * its absolute path, so concurrent prepares neither race creating the clone
 * nor contend for ref locks during fetch.
 */
const repoLocks = new Map<string, Promise<void>>();

async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  repoLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (repoLocks.get(key) === tail) repoLocks.delete(key);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** True when `ref` (a full ref name) exists in the repository at `gitDir`. */
async function refExists(gitDir: string, ref: string): Promise<boolean> {
  const out = await runGit(gitDir, ["for-each-ref", "--format=%(refname)", ref]);
  return out.trim() === ref;
}

interface WorktreeRecord {
  path: string;
  head?: string;
  /** Full ref, e.g. `refs/heads/agent/GOOP-1-0b7c2f4e`. */
  branch?: string;
}

/** Parses `git worktree list --porcelain -z`. Skips the bare entry. */
async function listWorktrees(barePath: string): Promise<WorktreeRecord[]> {
  const out = await runGit(barePath, ["worktree", "list", "--porcelain", "-z"]);
  const records: WorktreeRecord[] = [];
  let current: (WorktreeRecord & { bare?: boolean }) | undefined;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (current && !current.bare) records.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") current = { path: value };
    else if (!current) continue;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "bare") current.bare = true;
  }
  if (current && !current.bare) records.push(current);
  return records;
}

export class WorktreeManager {
  private readonly workspaceRoot: string;

  constructor(options: WorktreeManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
  }

  /**
   * Design.md §9.1 steps 1-4: fetch, add the worktree on the working branch,
   * run the setup command, write `.orchestra/context.json`.
   *
   * Caller precondition: any earlier session for this task must already have
   * ended before this is called. `releaseBranch` (GOT.25 D5) detaches a
   * stale worktree's HEAD to free the branch purely from git state; the
   * manager has no database access, so it cannot tell whether that
   * worktree's agent process is still running. Calling this while an
   * earlier session for the same task is still live races that session.
   *
   * Throws `GitCommandError` for a git failure and `SetupFailedError` when
   * the setup command exits non-zero.
   */
  async prepareImplementation(
    input: PrepareImplementationInput,
  ): Promise<PreparedWorktree> {
    const { executionId, repository } = input;
    const worktreePath = this.worktreePath(executionId);
    const branch = workingBranchName(input.task.jiraKey, input.task.id);
    const barePath = this.barePath(repository);
    const startPoint = input.resumeFromRemote
      ? `refs/remotes/origin/${branch}`
      : `refs/remotes/origin/${repository.defaultBranch}`;

    await withRepoLock(barePath, async () => {
      await this.fetch(barePath, repository.gitUrl);
      await runGit(barePath, ["worktree", "prune"]);
      await this.releaseBranch(barePath, branch);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      // `-B` creates or resets the branch, so a leftover local branch of the
      // same name does not fail the add. A fresh start does not track the
      // default branch; a resume tracks the remote agent branch.
      await runGit(barePath, [
        "worktree",
        "add",
        input.resumeFromRemote ? "--track" : "--no-track",
        "-B",
        branch,
        worktreePath,
        startPoint,
      ]);
      await this.excludeContextDir(worktreePath);
    });

    const setupCommand = repository.setupCommand?.trim();
    if (setupCommand) {
      const result = await runShell(worktreePath, setupCommand);
      if (result.exitCode !== 0) {
        throw new SetupFailedError(result.exitCode, result.signal, result.tail);
      }
    }

    const context = ExecutionContextSchema.parse({
      task: {
        id: input.task.id,
        jira_key: input.task.jiraKey,
        jira_summary: input.task.jiraSummary,
      },
      spec: input.spec,
      decisions: input.decisions,
      repository: {
        name: repository.name,
        default_branch: repository.defaultBranch,
        branch,
      },
      runtime: input.runtime,
      review_command: input.reviewCommand ?? null,
    } satisfies ExecutionContext);
    const contextFile = path.join(worktreePath, EXECUTION_CONTEXT_PATH);
    await fs.mkdir(path.dirname(contextFile), { recursive: true });
    await fs.writeFile(contextFile, `${JSON.stringify(context, null, 2)}\n`);

    return { worktreePath, branch };
  }

  /**
   * Spec worktree (design.md §9.1): detached at `origin/<default_branch>`,
   * no setup command, no context file.
   */
  async prepareSpec(input: PrepareSpecInput): Promise<PreparedWorktree> {
    const { executionId, repository } = input;
    const worktreePath = this.worktreePath(executionId);
    const barePath = this.barePath(repository);

    await withRepoLock(barePath, async () => {
      await this.fetch(barePath, repository.gitUrl);
      await runGit(barePath, ["worktree", "prune"]);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await runGit(barePath, [
        "worktree",
        "add",
        "--detach",
        worktreePath,
        `refs/remotes/origin/${repository.defaultBranch}`,
      ]);
    });

    return { worktreePath, branch: null };
  }

  /**
   * Deletes `work/<executionId>` and prunes git's record of it. When
   * `options.branch` is set, also deletes that local branch unless another
   * worktree has it checked out.
   *
   * The directory deletion runs under the same per-repository lock as
   * `prepareImplementation`'s fetch/prune/`releaseBranch` sequence. A
   * concurrent prepare's `releaseBranch` lists worktrees and spawns git with
   * cwd set to each listed worktree path (GOT.25 D5); deleting that
   * directory out from under it while it is mid-sequence would make that
   * spawn fail with `GitCommandError`. Serialising remove and prepare on one
   * repository through `withRepoLock` closes that window.
   */
  async remove(
    executionId: string,
    options: RemoveOptions,
  ): Promise<RemoveResult> {
    const worktreePath = this.worktreePath(executionId);
    assertSafe(options.repositoryName, SAFE_SEGMENT, "repository name");
    const branch = options.branch ?? null;
    if (branch !== null) assertSafe(branch, SAFE_BRANCH, "branch");
    const barePath = path.join(
      this.workspaceRoot,
      "repos",
      `${options.repositoryName}.git`,
    );

    return withRepoLock(barePath, async () => {
      await fs.rm(worktreePath, { recursive: true, force: true });
      if (!(await exists(barePath))) return { branchDeleted: false };
      await runGit(barePath, ["worktree", "prune"]);
      if (branch === null) return { branchDeleted: false };

      const ref = `refs/heads/${branch}`;
      const worktrees = await listWorktrees(barePath);
      if (worktrees.some((w) => w.branch === ref)) {
        return { branchDeleted: false };
      }
      const refs = await runGit(barePath, ["for-each-ref", "--format=%(refname)", ref]);
      if (refs.trim() !== ref) return { branchDeleted: false };
      await runGit(barePath, ["branch", "-D", branch]);
      return { branchDeleted: true };
    });
  }

  /**
   * Design.md §6.6 rule three: before an idle worktree is evicted, push its
   * branch so a later resume can start from `origin/<branch>`. Fetches,
   * then pushes only when the local branch has commits the remote lacks:
   * commits not on `origin/<branch>`, or, when the remote has no such
   * branch, commits beyond the merge-base with `origin/<defaultBranch>`.
   *
   * Never force-pushes. A remote branch with commits the local branch lacks
   * is reported as `diverged` and left alone. Runs under the same
   * per-repository lock as `prepareImplementation` and `remove`.
   */
  async pushIfAhead(input: PushIfAheadInput): Promise<PushIfAheadResult> {
    const { repositoryName, branch, defaultBranch } = input;
    assertSafe(repositoryName, SAFE_SEGMENT, "repository name");
    assertSafe(branch, SAFE_BRANCH, "branch");
    assertSafe(defaultBranch, SAFE_BRANCH, "default branch");
    const barePath = path.join(
      this.workspaceRoot,
      "repos",
      `${repositoryName}.git`,
    );
    const local = `refs/heads/${branch}`;
    const tracking = `refs/remotes/origin/${branch}`;
    const count = async (range: string): Promise<number> =>
      Number((await runGit(barePath, ["rev-list", "--count", range])).trim());

    return withRepoLock(barePath, async () => {
      if (!(await exists(barePath)) || !(await refExists(barePath, local))) {
        return { pushed: false, ahead: 0, reason: "no_local_branch" };
      }
      await runGit(barePath, ["fetch", "--quiet", "--prune", "origin"]);

      let ahead: number;
      if (await refExists(barePath, tracking)) {
        ahead = await count(`${tracking}..${local}`);
        const behind = await count(`${local}..${tracking}`);
        if (behind > 0 && ahead > 0) {
          return { pushed: false, ahead, reason: "diverged" };
        }
      } else {
        ahead = await count(`refs/remotes/origin/${defaultBranch}..${local}`);
      }
      if (ahead === 0) return { pushed: false, ahead: 0, reason: "not_ahead" };

      // A plain refspec: git refuses a non-fast-forward, so a remote that
      // moved after the fetch fails the push instead of being overwritten.
      await runGit(barePath, ["push", "--quiet", "origin", `${local}:${local}`]);
      return { pushed: true, ahead };
    });
  }

  private worktreePath(executionId: string): string {
    assertSafe(executionId, SAFE_SEGMENT, "execution id");
    return path.join(this.workspaceRoot, "work", executionId);
  }

  private barePath(repository: WorktreeRepository): string {
    assertSafe(repository.name, SAFE_SEGMENT, "repository name");
    if (repository.gitUrl.startsWith("-")) {
      throw new Error(`invalid git url: ${JSON.stringify(repository.gitUrl)}`);
    }
    return path.join(this.workspaceRoot, "repos", `${repository.name}.git`);
  }

  /**
   * Creates the bare clone on first use, then `fetch --prune` (design.md
   * §9.1 step 1). Creation happens in a temporary directory renamed into
   * place, so a crash or a concurrent worker never leaves a half-configured
   * clone at the final path.
   */
  private async fetch(barePath: string, gitUrl: string): Promise<void> {
    if (!(await exists(barePath))) {
      const reposDir = path.dirname(barePath);
      await fs.mkdir(reposDir, { recursive: true });
      const staging = path.join(
        reposDir,
        `.${path.basename(barePath)}.${randomUUID()}.tmp`,
      );
      try {
        await runGit(reposDir, ["init", "--quiet", "--bare", staging]);
        await runGit(staging, ["remote", "add", "origin", gitUrl]);
        await fs.rename(staging, barePath);
      } catch (err) {
        await fs.rm(staging, { recursive: true, force: true });
        const code = (err as NodeJS.ErrnoException).code;
        const lostRace =
          (code === "ENOTEMPTY" || code === "EEXIST") && (await exists(barePath));
        if (!lostRace) throw err;
      }
    }
    // repositories.git_url is editable through the admin API after the clone
    // already exists, so keep the bare clone's origin in sync on every
    // fetch, not only at creation. Runs under the caller's repo lock, same
    // as the fetch below.
    await runGit(barePath, ["remote", "set-url", "origin", gitUrl]);
    await runGit(barePath, ["fetch", "--quiet", "--prune", "origin"]);
  }

  /**
   * GOT.25 D5: a worktree left by an earlier execution of the same task may
   * still have `branch` checked out, which would make `worktree add` refuse
   * it. Detach that worktree's HEAD at the commit it is on. Only the HEAD ref
   * changes; its index and files are untouched.
   */
  private async releaseBranch(barePath: string, branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`;
    for (const worktree of await listWorktrees(barePath)) {
      if (worktree.branch !== ref || !worktree.head) continue;
      await runGit(worktree.path, [
        "update-ref",
        "--no-deref",
        "-m",
        "orchestra: detach stale worktree",
        "HEAD",
        worktree.head,
      ]);
    }
  }

  /**
   * Adds `.orchestra/` to the exclude file git uses for this worktree. For a
   * linked worktree that is the shared `info/exclude` of the bare clone, so
   * the line is added once and this runs under the repository lock.
   */
  private async excludeContextDir(worktreePath: string): Promise<void> {
    const relative = await runGit(worktreePath, [
      "rev-parse",
      "--git-path",
      "info/exclude",
    ]);
    const excludeFile = path.resolve(worktreePath, relative.trim());
    let content = "";
    try {
      content = await fs.readFile(excludeFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (content.split(/\r?\n/).includes(EXCLUDE_PATTERN)) return;
    await fs.mkdir(path.dirname(excludeFile), { recursive: true });
    const separator = content === "" || content.endsWith("\n") ? "" : "\n";
    await fs.appendFile(excludeFile, `${separator}${EXCLUDE_PATTERN}\n`);
  }
}
