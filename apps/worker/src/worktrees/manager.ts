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
 * `<workspaceRoot>/repos/<name>.git` and creates each worktree at
 * `<workspaceRoot>/work/<executionId>`. After creation every operation is
 * keyed on the path the execution row recorded (GOT.43 C33): a retry may
 * own a worktree another execution created, so `remove` takes that path and
 * a recreation after eviction takes it as an explicit target. No database
 * access (GOT.25 D3): the caller persists `worktree_path`, `branch`, and the
 * `worktree.prepared` event.
 *
 * The bare clone is created with `git init --bare` plus an `origin` remote,
 * not `git clone --mirror`, so fetched branches land in `refs/remotes/origin/*`
 * and `fetch --prune` never touches the local `agent/*` branches that
 * worktrees have checked out.
 *
 * A failed prepare leaves whatever it created in place. The worktree sweeper
 * (design.md §6.6) removes it with the failed execution. A later prepare of
 * the same execution (resume after eviction) clears it before adding.
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
  /**
   * Create the worktree here instead of `work/<executionId>`: the row's
   * recorded `worktree_path` when recreating after eviction (C33). Must be
   * `<workspaceRoot>/work/<one safe segment>`.
   */
  worktreePath?: string;
  /**
   * With `resumeFromRemote`: when `origin` has no such branch after the
   * fetch, start it from `origin/<default_branch>` as a fresh start does.
   * Resume after eviction uses it: the sweeper pushes a branch that is
   * ahead, so a missing remote branch means nothing was left to push.
   */
  fallbackToDefaultBranch?: boolean;
}

export interface PrepareSpecInput {
  executionId: string;
  repository: WorktreeRepository;
  /** As `PrepareImplementationInput.worktreePath` (C33). */
  worktreePath?: string;
}

/**
 * Where `prepareImplementation` started the working branch:
 * `origin/<branch>` or `origin/<default_branch>`.
 */
export type StartPoint = "remote_branch" | "default_branch";

export interface PreparedWorktree {
  worktreePath: string;
  /** Working branch, `null` for a detached spec worktree. */
  branch: string | null;
  /** Set by `prepareImplementation`; absent for a spec worktree. */
  startPoint?: StartPoint;
}

export interface RemoveOptions {
  repositoryName: string;
  /**
   * Local branch to delete with the worktree. Kept when another worktree
   * has it checked out.
   */
  branch?: string | null;
  /**
   * When set, remove only if the local `branch` is still at this commit
   * (`null`: still absent), checked under the repository lock. Otherwise
   * nothing is removed and the result has `tipMoved`. Needs `branch`.
   */
  expectedTip?: string | null;
}

export interface RemoveResult {
  branchDeleted: boolean;
  /** Set when `expectedTip` did not match: nothing was removed. */
  tipMoved?: true;
}

/** What `withRepositoryLock` hands its callback. */
export interface LockedRepository {
  /** `remove` on the locked repository, without taking the lock again. */
  remove(
    worktreePath: string,
    options: Omit<RemoveOptions, "repositoryName">,
  ): Promise<RemoveResult>;
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
  /**
   * Commit the local branch was at when this call checked it, `null` when
   * there is no local branch. Pass to `remove` as `expectedTip`.
   */
  tip: string | null;
}

/** Default bound on one git network call (fetch, push). */
export const DEFAULT_NETWORK_TIMEOUT_MS = 120_000;

export interface WorktreeManagerOptions {
  /** `WorkerConfig.workspaceRoot`. */
  workspaceRoot: string;
  /**
   * Bound on each git fetch and push. A call that runs longer is killed
   * and fails with `GitCommandError`. Defaults to
   * `DEFAULT_NETWORK_TIMEOUT_MS`.
   */
  networkTimeoutMs?: number;
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

/** Commit `ref` (a full ref name) points at, or null when it does not exist. */
async function refTip(gitDir: string, ref: string): Promise<string | null> {
  const out = await runGit(gitDir, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    ref,
  ]);
  for (const line of out.split("\n")) {
    const space = line.indexOf(" ");
    if (space !== -1 && line.slice(0, space) === ref) return line.slice(space + 1);
  }
  return null;
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
  private readonly networkTimeoutMs: number;

  constructor(options: WorktreeManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.networkTimeoutMs =
      options.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
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
   * A `work/<executionId>` left by an earlier failed prepare of the same
   * execution is deleted, and its git record pruned, before the add.
   *
   * Throws `GitCommandError` for a git failure and `SetupFailedError` when
   * the setup command exits non-zero.
   */
  async prepareImplementation(
    input: PrepareImplementationInput,
  ): Promise<PreparedWorktree> {
    const { executionId, repository } = input;
    const worktreePath =
      input.worktreePath !== undefined
        ? this.recordedWorktreePath(input.worktreePath)
        : this.worktreePath(executionId);
    const branch = workingBranchName(input.task.jiraKey, input.task.id);
    const barePath = this.barePath(repository);
    const remoteBranch = `refs/remotes/origin/${branch}`;

    const fromRemote = await withRepoLock(barePath, async () => {
      await this.fetch(barePath, repository.gitUrl);
      const fromRemote =
        input.resumeFromRemote === true &&
        (input.fallbackToDefaultBranch !== true ||
          (await refExists(barePath, remoteBranch)));
      const startPoint = fromRemote
        ? remoteBranch
        : `refs/remotes/origin/${repository.defaultBranch}`;
      await this.clearStale(barePath, worktreePath);
      await this.releaseBranch(barePath, branch);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      // `-B` creates or resets the branch, so a leftover local branch of the
      // same name does not fail the add. A fresh start does not track the
      // default branch; a resume tracks the remote agent branch.
      await runGit(barePath, [
        "worktree",
        "add",
        fromRemote ? "--track" : "--no-track",
        "-B",
        branch,
        worktreePath,
        startPoint,
      ]);
      await this.excludeContextDir(worktreePath);
      return fromRemote;
    });

    const setupCommand = repository.setupCommand?.trim();
    if (setupCommand) {
      const result = await runShell(worktreePath, setupCommand);
      if (result.exitCode !== 0) {
        throw new SetupFailedError(result.exitCode, result.signal, result.tail);
      }
    }

    await this.writeContextFile(worktreePath, {
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
    });

    return {
      worktreePath,
      branch,
      startPoint: fromRemote ? "remote_branch" : "default_branch",
    };
  }

  /**
   * Rewrites `.orchestra/context.json` in an existing worktree at its
   * recorded path (C33), in the format `prepareImplementation` writes:
   * `resume_with_revision` moves the execution to a newly approved revision,
   * and `orchestra-review` reads the spec from this file (§9.8, GOT.47 C53).
   * Throws when `context` is invalid or the path is not a recorded worktree
   * path.
   */
  async writeContext(worktreePath: string, context: ExecutionContext): Promise<void> {
    await this.writeContextFile(this.recordedWorktreePath(worktreePath), context);
  }

  /**
   * Validates `context` and writes it to `.orchestra/context.json` under
   * `worktreePath`: the one context writer behind `prepareImplementation`
   * and `writeContext`.
   */
  private async writeContextFile(
    worktreePath: string,
    context: ExecutionContext,
  ): Promise<void> {
    const parsed = ExecutionContextSchema.parse(context);
    const contextFile = path.join(worktreePath, EXECUTION_CONTEXT_PATH);
    await fs.mkdir(path.dirname(contextFile), { recursive: true });
    await fs.writeFile(contextFile, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  /**
   * Spec worktree (design.md §9.1): detached at `origin/<default_branch>`,
   * no setup command, no context file. Clears a stale `work/<executionId>`
   * first, as `prepareImplementation` does.
   */
  async prepareSpec(input: PrepareSpecInput): Promise<PreparedWorktree> {
    const { executionId, repository } = input;
    const worktreePath =
      input.worktreePath !== undefined
        ? this.recordedWorktreePath(input.worktreePath)
        : this.worktreePath(executionId);
    const barePath = this.barePath(repository);

    await withRepoLock(barePath, async () => {
      await this.fetch(barePath, repository.gitUrl);
      await this.clearStale(barePath, worktreePath);
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
   * Deletes the worktree at `worktreePath`, the execution row's recorded
   * `worktree_path` (C33), and prunes git's record of it. When
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
    worktreePath: string,
    options: RemoveOptions,
  ): Promise<RemoveResult> {
    const target = this.recordedWorktreePath(worktreePath);
    const barePath = this.barePathByName(options.repositoryName);
    return withRepoLock(barePath, () =>
      this.removeLocked(barePath, target, options),
    );
  }

  /**
   * Runs `fn` holding the per-repository lock that `prepareImplementation`,
   * `prepareSpec`, `remove` and `pushIfAhead` take. `fn` gets a `remove`
   * that runs under this lock. Calling any of those four manager methods on
   * the same repository from inside `fn` waits on the lock `fn` holds and
   * never returns.
   *
   * The worktree sweeper takes this lock before it opens the transaction
   * that locks the task and execution rows, so it never waits for the lock
   * while holding those rows.
   */
  async withRepositoryLock<T>(
    repositoryName: string,
    fn: (repository: LockedRepository) => Promise<T>,
  ): Promise<T> {
    const barePath = this.barePathByName(repositoryName);
    return withRepoLock(barePath, () =>
      fn({
        remove: (worktreePath, options) =>
          this.removeLocked(barePath, this.recordedWorktreePath(worktreePath), {
            ...options,
            repositoryName,
          }),
      }),
    );
  }

  /**
   * `remove`'s body. The caller holds the lock on `barePath` and has
   * checked `worktreePath` with `recordedWorktreePath`.
   */
  private async removeLocked(
    barePath: string,
    worktreePath: string,
    options: RemoveOptions,
  ): Promise<RemoveResult> {
    const branch = options.branch ?? null;
    if (branch !== null) assertSafe(branch, SAFE_BRANCH, "branch");
    if (options.expectedTip !== undefined && branch === null) {
      throw new Error("expectedTip needs a branch");
    }

    if (options.expectedTip !== undefined) {
      const current = (await exists(barePath))
        ? await refTip(barePath, `refs/heads/${branch}`)
        : null;
      if (current !== options.expectedTip) {
        return { branchDeleted: false, tipMoved: true };
      }
    }
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
   * per-repository lock as `prepareImplementation` and `remove`. The fetch
   * and the push are each bounded by `networkTimeoutMs`.
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

    const network = { timeoutMs: this.networkTimeoutMs };

    return withRepoLock(barePath, async () => {
      const tip = (await exists(barePath)) ? await refTip(barePath, local) : null;
      if (tip === null) {
        return { pushed: false, ahead: 0, reason: "no_local_branch", tip };
      }
      await runGit(barePath, ["fetch", "--quiet", "--prune", "origin"], network);

      let ahead: number;
      if (await refExists(barePath, tracking)) {
        ahead = await count(`${tracking}..${tip}`);
        const behind = await count(`${tip}..${tracking}`);
        if (behind > 0 && ahead > 0) {
          return { pushed: false, ahead, reason: "diverged", tip };
        }
      } else {
        ahead = await count(`refs/remotes/origin/${defaultBranch}..${tip}`);
      }
      if (ahead === 0) {
        return { pushed: false, ahead: 0, reason: "not_ahead", tip };
      }

      // A plain refspec: git refuses a non-fast-forward, so a remote that
      // moved after the fetch fails the push instead of being overwritten.
      // Pushing the sha, not the ref, pins what `tip` reports.
      await runGit(
        barePath,
        ["push", "--quiet", "origin", `${tip}:${local}`],
        network,
      );
      return { pushed: true, ahead, tip };
    });
  }

  /**
   * A recorded `worktree_path` (C33), checked as strictly as a path built
   * from an execution id: absolute, exactly `<workspaceRoot>/work/<segment>`
   * with one safe segment, no traversal. Throws otherwise.
   */
  private recordedWorktreePath(worktreePath: string): string {
    const workRoot = path.join(this.workspaceRoot, "work");
    const segment = path.basename(worktreePath);
    if (
      !path.isAbsolute(worktreePath) ||
      path.normalize(worktreePath) !== worktreePath ||
      path.dirname(worktreePath) !== workRoot ||
      !SAFE_SEGMENT.test(segment)
    ) {
      throw new Error(`invalid worktree path: ${JSON.stringify(worktreePath)}`);
    }
    return path.join(workRoot, segment);
  }

  private worktreePath(executionId: string): string {
    assertSafe(executionId, SAFE_SEGMENT, "execution id");
    return path.join(this.workspaceRoot, "work", executionId);
  }

  private barePath(repository: WorktreeRepository): string {
    if (repository.gitUrl.startsWith("-")) {
      throw new Error(`invalid git url: ${JSON.stringify(repository.gitUrl)}`);
    }
    return this.barePathByName(repository.name);
  }

  private barePathByName(repositoryName: string): string {
    assertSafe(repositoryName, SAFE_SEGMENT, "repository name");
    return path.join(this.workspaceRoot, "repos", `${repositoryName}.git`);
  }

  /**
   * Deletes `worktreePath` and prunes git's record of it, so a `worktree
   * add` at that path does not fail with "already exists". Called under the
   * repository lock.
   */
  private async clearStale(barePath: string, worktreePath: string): Promise<void> {
    await fs.rm(worktreePath, { recursive: true, force: true });
    await runGit(barePath, ["worktree", "prune"]);
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
    await runGit(barePath, ["fetch", "--quiet", "--prune", "origin"], {
      timeoutMs: this.networkTimeoutMs,
    });
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
