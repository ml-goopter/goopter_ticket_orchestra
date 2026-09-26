import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXECUTION_CONTEXT_PATH, ExecutionContextSchema } from "@orchestra/core";
import {
  GitCommandError,
  SETUP_OUTPUT_TAIL_BYTES,
  SetupFailedError,
  WorktreeManager,
  workingBranchName,
  type PrepareImplementationInput,
  type WorktreeRepository,
} from "./index.js";
import * as runModule from "./run.js";

/**
 * Real git against a local bare repository acting as the remote. No network.
 * Commits made by the test pass identity and signing flags explicitly so the
 * host's global git config cannot break them.
 */

const TEST_GIT_FLAGS = [
  "-c",
  "user.name=Orchestra Test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...TEST_GIT_FLAGS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

const TASK_ID = "0b7c2f4e-1111-4222-8333-944455556666";
const OTHER_TASK_ID = "9f00aa11-2222-4333-8444-a55566667777";
const JIRA_KEY = "GOOP-421";
const BRANCH = `agent/${JIRA_KEY}-0b7c2f4e`;

let tmp: string;
let remote: string;
let seed: string;
let workspaceRoot: string;
let repository: WorktreeRepository;

/** Commits a file in the seed clone and pushes `branch` to the remote. */
function pushCommit(branch: string, file: string, content: string): string {
  git(seed, "checkout", "-q", "-B", branch);
  writeFileSyncIn(seed, file, content);
  git(seed, "add", file);
  git(seed, "commit", "-q", "-m", `commit ${file}`);
  git(seed, "push", "-q", "-f", "origin", `${branch}:${branch}`);
  return git(seed, "rev-parse", "HEAD");
}

function writeFileSyncIn(dir: string, file: string, content: string): void {
  execFileSync("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", content, file], {
    cwd: dir,
  });
}

function remoteTip(branch: string): string {
  return git(remote, "rev-parse", `refs/heads/${branch}`);
}

function implInput(
  executionId: string,
  overrides: Partial<PrepareImplementationInput> = {},
): PrepareImplementationInput {
  return {
    executionId,
    repository,
    task: { id: TASK_ID, jiraKey: JIRA_KEY, jiraSummary: "Receipt language" },
    spec: {
      version: 2,
      content: {
        repository: repository.name,
        objective: "Do the thing",
        scope: ["a"],
        out_of_scope: ["b"],
        requirements: ["c"],
        acceptance_criteria: ["d"],
        validation: ["e"],
        constraints: ["f"],
        dependencies: [],
      },
    },
    decisions: [
      {
        issue_id: "issue_784",
        decision: "Device-local.",
        clarification: null,
        chosen_option: "o1",
        decided_by: "user@example.com",
        decided_at: "2026-09-20",
      },
    ],
    reviewCommand: "pnpm test",
    runtime: "claude",
    ...overrides,
  };
}

function bareClonePath(): string {
  return path.join(workspaceRoot, "repos", `${repository.name}.git`);
}

function worktreeRecords(): string {
  return git(bareClonePath(), "worktree", "list", "--porcelain");
}

beforeEach(async () => {
  tmp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-worktrees-")),
  );
  remote = path.join(tmp, "remote.git");
  seed = path.join(tmp, "seed");
  workspaceRoot = path.join(tmp, "workspace");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "clone", "-q", remote, seed);
  pushCommit("main", "README.md", "one");
  repository = {
    name: "sample_repo",
    gitUrl: remote,
    defaultBranch: "main",
    setupCommand: null,
  };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("workingBranchName (D1)", () => {
  it("uses the first 8 hex characters of the task id", () => {
    expect(workingBranchName(JIRA_KEY, TASK_ID)).toBe(BRANCH);
  });

  it("rejects a jira key that is not a safe ref component", () => {
    expect(() => workingBranchName("GOOP 1", TASK_ID)).toThrow();
    expect(() => workingBranchName("../x", TASK_ID)).toThrow();
  });

  it("rejects a task id without 8 leading hex characters", () => {
    expect(() => workingBranchName(JIRA_KEY, "not-a-uuid")).toThrow();
  });
});

describe("WorktreeManager.prepareImplementation (design.md §9.1)", () => {
  it("A1: creates the bare clone and a worktree at the remote default tip", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const result = await manager.prepareImplementation(implInput("exec-1"));

    expect(result).toEqual({
      worktreePath: path.join(workspaceRoot, "work", "exec-1"),
      branch: BRANCH,
      startPoint: "default_branch",
    });
    expect(git(bareClonePath(), "rev-parse", "--is-bare-repository")).toBe(
      "true",
    );
    expect(git(bareClonePath(), "remote", "get-url", "origin")).toBe(remote);
    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(
      remoteTip("main"),
    );
    expect(git(result.worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("A2: fetches before each prepare, so a newly pushed commit is the start point", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    await manager.prepareImplementation(implInput("exec-1"));
    const newTip = pushCommit("main", "second.txt", "two");

    const second = await manager.prepareImplementation(
      implInput("exec-2", {
        task: { id: OTHER_TASK_ID, jiraKey: "GOOP-9", jiraSummary: "x" },
      }),
    );

    expect(git(second.worktreePath, "rev-parse", "HEAD")).toBe(newTip);
    expect(git(bareClonePath(), "rev-parse", "origin/main")).toBe(newTip);
  });

  it("F1: a git_url change reaches an existing bare clone on the next prepare", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    await manager.prepareImplementation(implInput("exec-1"));

    const remote2 = path.join(tmp, "remote2.git");
    const seed2 = path.join(tmp, "seed2");
    git(tmp, "init", "-q", "-b", "main", "--bare", remote2);
    git(tmp, "clone", "-q", remote2, seed2);
    git(seed2, "checkout", "-q", "-B", "main");
    writeFileSyncIn(seed2, "other.txt", "other");
    git(seed2, "add", "other.txt");
    git(seed2, "commit", "-q", "-m", "other commit");
    git(seed2, "push", "-q", "-f", "origin", "main:main");
    const newTip = git(seed2, "rev-parse", "HEAD");

    const result = await manager.prepareImplementation(
      implInput("exec-2", {
        repository: { ...repository, gitUrl: remote2 },
        task: { id: OTHER_TASK_ID, jiraKey: "GOOP-9", jiraSummary: "x" },
      }),
    );

    expect(git(bareClonePath(), "remote", "get-url", "origin")).toBe(remote2);
    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(newTip);
  });

  it("A3: fetch --prune leaves local agent branches in other worktrees alone", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const first = await manager.prepareImplementation(implInput("exec-1"));
    writeFileSyncIn(first.worktreePath, "work.txt", "local work");
    git(first.worktreePath, "add", "work.txt");
    git(first.worktreePath, "commit", "-q", "-m", "local");
    const localSha = git(first.worktreePath, "rev-parse", "HEAD");

    // The same branch exists on the remote, gets fetched, then is deleted
    // on the remote so the next fetch prunes its remote-tracking ref.
    pushCommit(BRANCH, "remote.txt", "remote");
    await manager.prepareSpec({ executionId: "spec-1", repository });
    expect(gitOk(bareClonePath(), "rev-parse", "--verify", `origin/${BRANCH}`)).toBe(true);
    git(remote, "branch", "-D", BRANCH);

    await manager.prepareImplementation(
      implInput("exec-2", {
        task: { id: OTHER_TASK_ID, jiraKey: "GOOP-9", jiraSummary: "x" },
      }),
    );

    expect(gitOk(bareClonePath(), "rev-parse", "--verify", `origin/${BRANCH}`)).toBe(false);
    expect(git(bareClonePath(), "rev-parse", `refs/heads/${BRANCH}`)).toBe(localSha);
    expect(git(first.worktreePath, "rev-parse", "HEAD")).toBe(localSha);
    expect(git(first.worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("A4: two concurrent prepares on a fresh root both succeed with one bare clone", async () => {
    const a = new WorktreeManager({ workspaceRoot });
    const b = new WorktreeManager({ workspaceRoot });
    const [one, two] = await Promise.all([
      a.prepareImplementation(implInput("exec-1")),
      b.prepareImplementation(
        implInput("exec-2", {
          task: { id: OTHER_TASK_ID, jiraKey: "GOOP-9", jiraSummary: "x" },
        }),
      ),
    ]);

    expect(await fs.readdir(path.join(workspaceRoot, "repos"))).toEqual([
      `${repository.name}.git`,
    ]);
    expect(
      git(bareClonePath(), "config", "--get-all", "remote.origin.url"),
    ).toBe(remote);
    expect(git(one.worktreePath, "rev-parse", "HEAD")).toBe(remoteTip("main"));
    expect(git(two.worktreePath, "rev-parse", "HEAD")).toBe(remoteTip("main"));
    // The shared exclude file is updated under the repository lock.
    const exclude = await fs.readFile(
      path.join(bareClonePath(), "info", "exclude"),
      "utf8",
    );
    expect(exclude.split("\n").filter((l) => l === ".orchestra/")).toHaveLength(1);
  });

  it("A5: resume from the remote branch when no local branch exists", async () => {
    const pushed = pushCommit(BRANCH, "pushed.txt", "pushed");
    const manager = new WorktreeManager({ workspaceRoot });

    const result = await manager.prepareImplementation(
      implInput("exec-1", { resumeFromRemote: true }),
    );

    expect(result.branch).toBe(BRANCH);
    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(pushed);
    expect(git(result.worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("resume with fallbackToDefaultBranch starts the branch from origin/<default> when origin lacks it", async () => {
    const manager = new WorktreeManager({ workspaceRoot });

    const result = await manager.prepareImplementation(
      implInput("exec-1", { resumeFromRemote: true, fallbackToDefaultBranch: true }),
    );

    expect(result.branch).toBe(BRANCH);
    expect(result.startPoint).toBe("default_branch");
    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(remoteTip("main"));
    expect(git(result.worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("resume with fallbackToDefaultBranch still uses origin/<branch> when it exists", async () => {
    const pushed = pushCommit(BRANCH, "pushed.txt", "pushed");
    const manager = new WorktreeManager({ workspaceRoot });

    const result = await manager.prepareImplementation(
      implInput("exec-1", { resumeFromRemote: true, fallbackToDefaultBranch: true }),
    );

    expect(result.startPoint).toBe("remote_branch");
    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(pushed);
    expect(git(result.worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("A5: resume from the remote branch when a local branch of that name exists", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const first = await manager.prepareImplementation(implInput("exec-1"));
    writeFileSyncIn(first.worktreePath, "local.txt", "diverged");
    git(first.worktreePath, "add", "local.txt");
    git(first.worktreePath, "commit", "-q", "-m", "diverged");
    await manager.remove("exec-1", { repositoryName: repository.name });
    expect(gitOk(bareClonePath(), "rev-parse", "--verify", `refs/heads/${BRANCH}`)).toBe(true);

    const pushed = pushCommit(BRANCH, "pushed.txt", "pushed");
    const result = await manager.prepareImplementation(
      implInput("exec-2", { resumeFromRemote: true }),
    );

    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(pushed);
    expect(git(result.worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("A6 (D5): succeeds while a stale worktree still has the task branch checked out", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const stale = await manager.prepareImplementation(implInput("exec-1"));
    writeFileSyncIn(stale.worktreePath, "uncommitted.txt", "keep me");
    const staleHead = git(stale.worktreePath, "rev-parse", "HEAD");

    const fresh = await manager.prepareImplementation(implInput("exec-2"));

    expect(git(fresh.worktreePath, "branch", "--show-current")).toBe(BRANCH);
    expect(git(fresh.worktreePath, "rev-parse", "HEAD")).toBe(remoteTip("main"));
    // The stale worktree is detached at its old commit, files untouched.
    expect(git(stale.worktreePath, "branch", "--show-current")).toBe("");
    expect(git(stale.worktreePath, "rev-parse", "HEAD")).toBe(staleHead);
    expect(
      await fs.readFile(path.join(stale.worktreePath, "uncommitted.txt"), "utf8"),
    ).toBe("keep me");
  });

  it("A6 (D5): resume from remote succeeds while a stale worktree has the branch", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    await manager.prepareImplementation(implInput("exec-1"));
    const pushed = pushCommit(BRANCH, "pushed.txt", "pushed");

    const resumed = await manager.prepareImplementation(
      implInput("exec-2", { resumeFromRemote: true }),
    );

    expect(git(resumed.worktreePath, "rev-parse", "HEAD")).toBe(pushed);
    expect(git(resumed.worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("A6 (D5): succeeds when the stale worktree directory was deleted but its record remains", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const stale = await manager.prepareImplementation(implInput("exec-1"));
    await fs.rm(stale.worktreePath, { recursive: true, force: true });

    const fresh = await manager.prepareImplementation(implInput("exec-2"));

    expect(git(fresh.worktreePath, "branch", "--show-current")).toBe(BRANCH);
    expect(worktreeRecords()).not.toContain(stale.worktreePath);
  });

  it("round 2 F1: clears a work/<id> a failed prepare of the same execution left, directory and record", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const failing = { ...repository, setupCommand: "touch leftover.txt; exit 3" };
    await expect(
      manager.prepareImplementation(implInput("exec-1", { repository: failing })),
    ).rejects.toBeInstanceOf(SetupFailedError);
    const worktreePath = path.join(workspaceRoot, "work", "exec-1");
    expect(existsSync(path.join(worktreePath, "leftover.txt"))).toBe(true);
    expect(worktreeRecords()).toContain(worktreePath);

    const result = await manager.prepareImplementation(
      implInput("exec-1", { resumeFromRemote: true, fallbackToDefaultBranch: true }),
    );

    expect(result.worktreePath).toBe(worktreePath);
    expect(existsSync(path.join(worktreePath, "leftover.txt"))).toBe(false);
    expect(git(worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("A7: a passing setup command runs exactly once with the worktree as cwd", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const result = await manager.prepareImplementation(
      implInput("exec-1", {
        repository: {
          ...repository,
          setupCommand: 'printf x >> .setup-runs && pwd > .setup-cwd',
        },
      }),
    );

    expect(
      await fs.readFile(path.join(result.worktreePath, ".setup-runs"), "utf8"),
    ).toBe("x");
    const cwd = (
      await fs.readFile(path.join(result.worktreePath, ".setup-cwd"), "utf8")
    ).trim();
    expect(await fs.realpath(cwd)).toBe(await fs.realpath(result.worktreePath));
  });

  it("A7: a failing setup command throws SetupFailedError with exit code and output tail", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const promise = manager.prepareImplementation(
      implInput("exec-1", {
        repository: {
          ...repository,
          setupCommand: "echo out-line; echo err-line >&2; exit 7",
        },
      }),
    );

    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SetupFailedError);
    const setupError = error as SetupFailedError;
    expect(setupError.exitCode).toBe(7);
    expect(setupError.outputTail).toContain("out-line");
    expect(setupError.outputTail).toContain("err-line");
    expect(setupError).not.toBeInstanceOf(GitCommandError);
  });

  it("A7: the setup output tail is bounded and keeps the end of the output", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const error = await manager
      .prepareImplementation(
        implInput("exec-1", {
          repository: {
            ...repository,
            setupCommand:
              "i=0; while [ $i -lt 4000 ]; do echo line-$i-padding-padding; i=$((i+1)); done; echo LAST-LINE; exit 3",
          },
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(SetupFailedError);
    const setupError = error as SetupFailedError;
    expect(setupError.exitCode).toBe(3);
    expect(Buffer.byteLength(setupError.outputTail)).toBeLessThanOrEqual(
      SETUP_OUTPUT_TAIL_BYTES,
    );
    expect(setupError.outputTail).toContain("LAST-LINE");
    expect(setupError.outputTail).not.toContain("line-0-padding");
  });

  it("A8: writes a schema-valid context.json that git status does not list", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const input = implInput("exec-1");
    const result = await manager.prepareImplementation(input);
    // A second prepare must not add the exclude line twice.
    await manager.prepareImplementation(
      implInput("exec-2", {
        task: { id: OTHER_TASK_ID, jiraKey: "GOOP-9", jiraSummary: "x" },
      }),
    );

    const raw = await fs.readFile(
      path.join(result.worktreePath, EXECUTION_CONTEXT_PATH),
      "utf8",
    );
    const context = ExecutionContextSchema.parse(JSON.parse(raw));
    expect(context).toEqual({
      task: { id: TASK_ID, jira_key: JIRA_KEY, jira_summary: "Receipt language" },
      spec: input.spec,
      decisions: input.decisions,
      repository: {
        name: repository.name,
        default_branch: "main",
        branch: BRANCH,
      },
      runtime: "claude",
      review_command: "pnpm test",
    });

    expect(git(result.worktreePath, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const exclude = await fs.readFile(
      path.join(bareClonePath(), "info", "exclude"),
      "utf8",
    );
    expect(exclude.split("\n").filter((l) => l === ".orchestra/")).toHaveLength(1);
  });

  it("writes the execution's runtime into context.json", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const result = await manager.prepareImplementation(
      implInput("exec-1", { runtime: "codex" }),
    );
    const context = ExecutionContextSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(result.worktreePath, EXECUTION_CONTEXT_PATH),
          "utf8",
        ),
      ),
    );
    expect(context.runtime).toBe("codex");
  });

  it("A8: writes review_command null when the caller supplies none", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const result = await manager.prepareImplementation(
      implInput("exec-1", { reviewCommand: undefined }),
    );
    const context = ExecutionContextSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(result.worktreePath, EXECUTION_CONTEXT_PATH),
          "utf8",
        ),
      ),
    );
    expect(context.review_command).toBeNull();
  });

  it("throws GitCommandError when the remote cannot be cloned", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const error = await manager
      .prepareImplementation(
        implInput("exec-1", {
          repository: { ...repository, gitUrl: path.join(tmp, "missing.git") },
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(GitCommandError);
    const gitError = error as GitCommandError;
    expect(gitError.exitCode).not.toBe(0);
    expect(gitError.args[0]).toBe("fetch");
    expect(gitError).not.toBeInstanceOf(SetupFailedError);
  });

  it("throws GitCommandError when resuming from a remote branch that does not exist", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    await expect(
      manager.prepareImplementation(
        implInput("exec-1", { resumeFromRemote: true }),
      ),
    ).rejects.toBeInstanceOf(GitCommandError);
  });

  it("rejects an execution id that is not a single safe path segment", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    await expect(
      manager.prepareImplementation(implInput("../escape")),
    ).rejects.toThrow(/execution id/);
    expect(existsSync(path.join(workspaceRoot, "escape"))).toBe(false);
  });
});

describe("WorktreeManager.prepareSpec (design.md §9.1)", () => {
  it("A9: creates a detached checkout of the default tip with no context file and no setup", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const result = await manager.prepareSpec({
      executionId: "spec-1",
      repository: { ...repository, setupCommand: "touch .setup-ran" },
    });

    expect(result).toEqual({
      worktreePath: path.join(workspaceRoot, "work", "spec-1"),
      branch: null,
    });
    expect(gitOk(result.worktreePath, "symbolic-ref", "-q", "HEAD")).toBe(false);
    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(remoteTip("main"));
    expect(existsSync(path.join(result.worktreePath, EXECUTION_CONTEXT_PATH))).toBe(false);
    expect(existsSync(path.join(result.worktreePath, ".setup-ran"))).toBe(false);
  });

  it("round 2 F1: clears a stale work/<id> of the same execution before adding", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const stale = await manager.prepareSpec({ executionId: "spec-1", repository });
    writeFileSyncIn(stale.worktreePath, "leftover.txt", "stale");

    const result = await manager.prepareSpec({ executionId: "spec-1", repository });

    expect(result.worktreePath).toBe(stale.worktreePath);
    expect(existsSync(path.join(result.worktreePath, "leftover.txt"))).toBe(false);
    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(remoteTip("main"));
  });
});

describe("WorktreeManager.remove (design.md §6.6)", () => {
  it("A10: deletes the directory, prunes the record, and deletes the branch when asked", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const result = await manager.prepareImplementation(implInput("exec-1"));
    writeFileSyncIn(result.worktreePath, "dirty.txt", "uncommitted");

    const removed = await manager.remove("exec-1", {
      repositoryName: repository.name,
      branch: BRANCH,
    });

    expect(removed).toEqual({ branchDeleted: true });
    expect(existsSync(result.worktreePath)).toBe(false);
    expect(worktreeRecords()).not.toContain(result.worktreePath);
    expect(gitOk(bareClonePath(), "rev-parse", "--verify", `refs/heads/${BRANCH}`)).toBe(false);
  });

  it("A10: keeps the branch when no branch is given", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const result = await manager.prepareImplementation(implInput("exec-1"));

    const removed = await manager.remove("exec-1", {
      repositoryName: repository.name,
    });

    expect(removed).toEqual({ branchDeleted: false });
    expect(existsSync(result.worktreePath)).toBe(false);
    expect(gitOk(bareClonePath(), "rev-parse", "--verify", `refs/heads/${BRANCH}`)).toBe(true);
  });

  it("A10: refuses to delete a branch another worktree has checked out", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const stale = await manager.prepareImplementation(implInput("exec-1"));
    const fresh = await manager.prepareImplementation(implInput("exec-2"));

    const removed = await manager.remove("exec-1", {
      repositoryName: repository.name,
      branch: BRANCH,
    });

    expect(removed).toEqual({ branchDeleted: false });
    expect(existsSync(stale.worktreePath)).toBe(false);
    expect(worktreeRecords()).not.toContain(stale.worktreePath);
    expect(git(bareClonePath(), "rev-parse", `refs/heads/${BRANCH}`)).toBe(
      git(fresh.worktreePath, "rev-parse", "HEAD"),
    );
    expect(git(fresh.worktreePath, "branch", "--show-current")).toBe(BRANCH);
  });

  it("A10: succeeds when the worktree directory is already gone", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const result = await manager.prepareImplementation(implInput("exec-1"));
    await fs.rm(result.worktreePath, { recursive: true, force: true });

    await expect(
      manager.remove("exec-1", { repositoryName: repository.name, branch: BRANCH }),
    ).resolves.toEqual({ branchDeleted: true });
    expect(worktreeRecords()).not.toContain(result.worktreePath);
  });

  it("Y1: a concurrent remove's directory deletion does not fail prepareImplementation's releaseBranch", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const stale = await manager.prepareImplementation(implInput("exec-1"));
    writeFileSyncIn(stale.worktreePath, "uncommitted.txt", "keep me");

    // Simulates `remove()` racing `prepareImplementation`'s locked
    // fetch/prune/releaseBranch sequence: real `fs.rm` on the stale
    // worktree is deferred until `prepareImplementation`'s own `worktree
    // prune` step (which still sees the intact directory) has completed,
    // then finishes before `releaseBranch` lists worktrees and spawns git
    // with the stale worktree's path as cwd.
    const realRm = fs.rm.bind(fs);
    const realRunGit = runModule.runGit;
    // `gate` opens the first time `prepareImplementation`'s own `worktree
    // prune` step is observed. `deleted`, once set by the (mocked) `fs.rm`
    // call on the stale worktree, resolves only after the gate is open and
    // the real deletion has finished, so the prune hook below can await it
    // and guarantee the directory is gone before `releaseBranch` runs.
    let openGate: () => void = () => {};
    let gateOpen = false;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let deleted: Promise<void> | undefined;

    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(((
      target: Parameters<typeof fs.rm>[0],
      opts: Parameters<typeof fs.rm>[1],
    ) => {
      if (target === stale.worktreePath && !deleted) {
        deleted = gate.then(() => realRm(target, opts));
        return deleted;
      }
      return realRm(target, opts);
    }) as typeof fs.rm);

    const runGitSpy = vi
      .spyOn(runModule, "runGit")
      .mockImplementation(async (cwd, args) => {
        const result = await realRunGit(cwd, args);
        if (
          !gateOpen &&
          cwd === bareClonePath() &&
          args[0] === "worktree" &&
          args[1] === "prune"
        ) {
          gateOpen = true;
          openGate();
          if (deleted) await deleted;
        }
        return result;
      });

    try {
      // Dispatched first so it claims the repository lock first: under the
      // fix, `remove`'s directory deletion cannot run until this prepare's
      // whole locked sequence (including `releaseBranch`) has finished.
      const preparePromise = manager.prepareImplementation(implInput("exec-2"));
      const removePromise = manager
        .remove("exec-1", { repositoryName: repository.name, branch: BRANCH })
        .catch(() => undefined);

      const fresh = await preparePromise;
      await removePromise;

      expect(git(fresh.worktreePath, "branch", "--show-current")).toBe(BRANCH);
      expect(git(fresh.worktreePath, "rev-parse", "HEAD")).toBe(
        remoteTip("main"),
      );
    } finally {
      rmSpy.mockRestore();
      runGitSpy.mockRestore();
    }
  });
});

describe("WorktreeManager.pushIfAhead (design.md §6.6 rule three)", () => {
  /** Commits one file in `worktreePath` and returns the new HEAD. */
  function commitIn(worktreePath: string, file: string): string {
    writeFileSyncIn(worktreePath, file, file);
    git(worktreePath, "add", file);
    git(worktreePath, "commit", "-q", "-m", `commit ${file}`);
    return git(worktreePath, "rev-parse", "HEAD");
  }

  const remoteHas = (branch: string): boolean =>
    gitOk(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);

  const pushInput = () => ({
    repositoryName: repository.name,
    branch: BRANCH,
    defaultBranch: repository.defaultBranch,
  });

  /** Every `git push` argument list the manager ran. */
  function spyPushes(): { pushes: string[][]; restore: () => void } {
    const realRunGit = runModule.runGit;
    const pushes: string[][] = [];
    const spy = vi.spyOn(runModule, "runGit").mockImplementation((cwd, args) => {
      if (args[0] === "push") pushes.push([...args]);
      return realRunGit(cwd, args);
    });
    return { pushes, restore: () => spy.mockRestore() };
  }

  it("P1: pushes a branch the remote lacks when it has commits beyond the default branch", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    const head = commitIn(prepared.worktreePath, "a.txt");
    const spy = spyPushes();

    try {
      await expect(manager.pushIfAhead(pushInput())).resolves.toEqual({
        pushed: true,
        ahead: 1,
        tip: head,
      });
    } finally {
      spy.restore();
    }

    expect(remoteTip(BRANCH)).toBe(head);
    expect(spy.pushes).toHaveLength(1);
    // Never a force push: no flag, and no `+` refspec.
    for (const arg of spy.pushes[0]!) {
      expect(arg).not.toMatch(/^(-f|--force.*|\+.*)$/);
    }
  });

  it("P2: pushes and reports the ahead count when the remote branch is behind", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    commitIn(prepared.worktreePath, "a.txt");
    await manager.pushIfAhead(pushInput());
    commitIn(prepared.worktreePath, "b.txt");
    const head = commitIn(prepared.worktreePath, "c.txt");

    await expect(manager.pushIfAhead(pushInput())).resolves.toEqual({
      pushed: true,
      ahead: 2,
      tip: head,
    });
    expect(remoteTip(BRANCH)).toBe(head);
  });

  it("P3: does not push a branch with no commits beyond the default branch", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    const spy = spyPushes();

    try {
      await expect(manager.pushIfAhead(pushInput())).resolves.toEqual({
        pushed: false,
        ahead: 0,
        reason: "not_ahead",
        tip: git(prepared.worktreePath, "rev-parse", "HEAD"),
      });
    } finally {
      spy.restore();
    }
    expect(spy.pushes).toEqual([]);
    expect(remoteHas(BRANCH)).toBe(false);
  });

  it("P4: does not push when the remote branch already has every local commit", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    const head = commitIn(prepared.worktreePath, "a.txt");
    await manager.pushIfAhead(pushInput());
    const spy = spyPushes();

    try {
      await expect(manager.pushIfAhead(pushInput())).resolves.toEqual({
        pushed: false,
        ahead: 0,
        reason: "not_ahead",
        tip: head,
      });
    } finally {
      spy.restore();
    }
    expect(spy.pushes).toEqual([]);
  });

  it("P5: reports a diverged remote without pushing or throwing", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    commitIn(prepared.worktreePath, "a.txt");
    await manager.pushIfAhead(pushInput());
    const localHead = commitIn(prepared.worktreePath, "local.txt");
    // Someone else advances the remote branch from its current tip.
    git(seed, "fetch", "-q", "origin");
    git(seed, "checkout", "-q", "-B", BRANCH, `origin/${BRANCH}`);
    const remoteOnly = pushCommit(BRANCH, "remote.txt", "remote");
    const spy = spyPushes();

    try {
      await expect(manager.pushIfAhead(pushInput())).resolves.toEqual({
        pushed: false,
        ahead: 1,
        reason: "diverged",
        tip: localHead,
      });
    } finally {
      spy.restore();
    }
    expect(spy.pushes).toEqual([]);
    expect(remoteTip(BRANCH)).toBe(remoteOnly);
  });

  it("P6: reports a missing local branch without pushing", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    await manager.prepareImplementation(implInput("exec-1"));
    await manager.remove("exec-1", { repositoryName: repository.name, branch: BRANCH });

    await expect(manager.pushIfAhead(pushInput())).resolves.toEqual({
      pushed: false,
      ahead: 0,
      reason: "no_local_branch",
      tip: null,
    });
    expect(remoteHas(BRANCH)).toBe(false);
  });

  it("rejects a branch that could read as a git option", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    await expect(
      manager.pushIfAhead({ ...pushInput(), branch: "--force" }),
    ).rejects.toThrow(/invalid branch/);
  });

  it("F2: a push that exceeds networkTimeoutMs fails with GitCommandError and pushes nothing", async () => {
    const manager = new WorktreeManager({ workspaceRoot, networkTimeoutMs: 300 });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    commitIn(prepared.worktreePath, "a.txt");
    const hook = path.join(remote, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });

    const started = Date.now();
    const err = await manager.pushIfAhead(pushInput()).catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(err).toBeInstanceOf(GitCommandError);
    expect((err as GitCommandError).args[0]).toBe("push");
    expect((err as GitCommandError).message).toMatch(/timed out after 300 ms/);
    expect(remoteHas(BRANCH)).toBe(false);
    // The repo lock was released: the next call on the repository runs.
    await fs.rm(hook);
    await expect(manager.pushIfAhead(pushInput())).resolves.toMatchObject({
      pushed: true,
    });
  });

  it("round 2 F3: the timeout kills git's whole process group, not only git", async () => {
    const manager = new WorktreeManager({ workspaceRoot, networkTimeoutMs: 1_500 });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    commitIn(prepared.worktreePath, "a.txt");
    const pidFile = path.join(tmp, "hook-child.pid");
    // The hook's child records its pid, then sleeps past the timeout.
    const hook = path.join(remote, "hooks", "pre-receive");
    await fs.writeFile(
      hook,
      `#!/bin/sh\nsh -c 'echo $$ > "$1"; exec sleep 30' sh "${pidFile}" &\nwait\n`,
      { mode: 0o755 },
    );
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw err;
      }
    };

    let pid: number | undefined;
    try {
      const err = await manager.pushIfAhead(pushInput()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitCommandError);
      expect((err as GitCommandError).message).toMatch(/timed out after 1500 ms/);
      pid = Number((await fs.readFile(pidFile, "utf8")).trim());
      expect(pid).toBeGreaterThan(0);

      // A killed child is reaped shortly after; a surviving one sleeps 30 s.
      const deadline = Date.now() + 3_000;
      while (alive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(alive(pid)).toBe(false);
    } finally {
      await fs.rm(hook, { force: true });
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("F2: a fetch that exceeds networkTimeoutMs fails with GitCommandError", async () => {
    const manager = new WorktreeManager({ workspaceRoot, networkTimeoutMs: 300 });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    commitIn(prepared.worktreePath, "a.txt");
    // Local transport runs this in place of git-upload-pack.
    git(bareClonePath(), "config", "remote.origin.uploadpack", "sleep 30; git-upload-pack");

    const started = Date.now();
    const err = await manager.pushIfAhead(pushInput()).catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(err).toBeInstanceOf(GitCommandError);
    expect((err as GitCommandError).args[0]).toBe("fetch");
    expect((err as GitCommandError).message).toMatch(/timed out after 300 ms/);
  });
});

describe("WorktreeManager.remove with expectedTip (F2)", () => {
  it("removes when the local branch is still at expectedTip", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    const tip = git(prepared.worktreePath, "rev-parse", "HEAD");

    await expect(
      manager.remove("exec-1", {
        repositoryName: repository.name,
        branch: BRANCH,
        expectedTip: tip,
      }),
    ).resolves.toEqual({ branchDeleted: true });
    expect(existsSync(prepared.worktreePath)).toBe(false);
  });

  it("keeps the worktree and branch when the tip moved", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));
    const tip = git(prepared.worktreePath, "rev-parse", "HEAD");
    writeFileSyncIn(prepared.worktreePath, "late.txt", "late");
    git(prepared.worktreePath, "add", "late.txt");
    git(prepared.worktreePath, "commit", "-q", "-m", "late");

    await expect(
      manager.remove("exec-1", {
        repositoryName: repository.name,
        branch: BRANCH,
        expectedTip: tip,
      }),
    ).resolves.toEqual({ branchDeleted: false, tipMoved: true });
    expect(existsSync(prepared.worktreePath)).toBe(true);
    expect(gitOk(bareClonePath(), "rev-parse", "--verify", `refs/heads/${BRANCH}`)).toBe(true);
  });

  it("keeps the worktree when expectedTip is null but a local branch now exists", async () => {
    const manager = new WorktreeManager({ workspaceRoot });
    const prepared = await manager.prepareImplementation(implInput("exec-1"));

    await expect(
      manager.remove("exec-1", {
        repositoryName: repository.name,
        branch: BRANCH,
        expectedTip: null,
      }),
    ).resolves.toEqual({ branchDeleted: false, tipMoved: true });
    expect(existsSync(prepared.worktreePath)).toBe(true);
  });
});
