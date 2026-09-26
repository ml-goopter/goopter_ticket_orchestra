import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentAdapter,
  AgentEvent,
  ToolPolicy,
  UsageBaseline,
} from "@orchestra/adapters";
import {
  SpecContentSchema,
  type EndReason,
  type ExecutionContext,
  type ExecutionEventType,
  type ExecutionState,
  type Runtime,
  type UsageKind,
} from "@orchestra/core";
import {
  DEFAULT_EXECUTION_MODEL,
  addExecutionUsageTotals,
  appendEvent,
  getExecutionState,
  getRevisionByStatus,
  getSpecRevisionById,
  getTaskState,
  hasLiveSpecExecution,
  insertExecutionUsage,
  loadRunnerContext,
  lockExecutionForTool,
  lockTaskForTool,
  markExecutionEnded,
  mergeExecutionEventPayload,
  pinExecutionToHost,
  resolveSpecRepository,
  restoreEvictedWorktree as restoreEvictedWorktreeRow,
  setExecutionPlacement,
  setExecutionSessionId,
  setExecutionWorktree,
  sumSessionUsageByModel,
  transition,
  type Db,
  type RunnerContext,
  type Tx,
} from "@orchestra/db";
import {
  buildResumePrompt,
  buildUserPrompt,
  systemPromptFor,
  type TicketContext,
} from "@orchestra/prompts";
import { redactToken } from "../agent-tools/invoke.js";
import { renewExecutionLease } from "../agent-tools/lease.js";
import {
  createLiveExecution,
  type ExecutionRegistry,
  type LiveExecution,
} from "../agent-tools/registry.js";
import { issueToken, revokeToken } from "../agent-tools/tokens.js";
import type { Logger } from "../logger.js";
import type { ClaimedExecution, OnClaimed } from "../scheduler/claim.js";
import {
  SetupFailedError,
  type PrepareImplementationInput,
  type PrepareSpecInput,
  type PreparedWorktree,
  type RemoveOptions,
  type RemoveResult,
} from "../worktrees/index.js";
// Not re-exported by the worktrees index, which this task does not own.
import type {
  PushIfAheadInput,
  PushIfAheadResult,
} from "../worktrees/manager.js";
import { runFailurePolicy } from "./retry.js";

/**
 * The execution runner (design.md §9.1-§9.4, §8 blocking handling). One
 * async task per live execution: prepare the worktree, issue the agent-tools
 * token, run one adapter turn, then decide the execution's next state from
 * how the turn ended. Every state move goes through `transition()`, which
 * also writes the matching `execution.*` event.
 */

export interface RunnerTimings {
  /** §6.4: lease renewal cadence. */
  leaseRenewMs: number;
  /** §9.3: `agent.message.delta` batching window. */
  flushMs: number;
  /** §8: abort a turn this long after a blocking `raise_issue`. */
  blockingGraceMs: number;
  /** §8: how often `blockingPending` is polled between events. */
  blockingPollMs: number;
}

export const DEFAULT_RUNNER_TIMINGS: RunnerTimings = {
  leaseRenewMs: 30_000,
  flushMs: 200,
  blockingGraceMs: 90_000,
  blockingPollMs: 1_000,
};

/** Upper bound on how long `shutdown` waits for runs to finish. */
export const DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Longest `end_detail` kept for a setup failure. */
export const END_DETAIL_MAX_CHARS = 4_000;

/** Tool-name prefix of the agent-tools server; those calls record themselves. */
export const ORCHESTRA_TOOL_PREFIX = "mcp__orchestra__";

/** `.no-mistakes` at the worktree root selects the no-mistakes prompt (§9.2). */
export const NO_MISTAKES_MARKER = ".no-mistakes";

/**
 * `packages/review-wrapper/bin`, prepended to the agent's PATH (GOT.40 Q7).
 * Resolved from this module: `src/runner` and `dist/runner` sit at the same
 * depth under `apps/worker`.
 */
export const DEFAULT_REVIEW_WRAPPER_BIN = fileURLToPath(
  new URL("../../../../packages/review-wrapper/bin", import.meta.url),
);

export const PROTOCOL_VIOLATION_DETAIL =
  "turn ended without a terminal call: expected report_pr_created, report_failed, or a blocking raise_issue";

export interface RunnerDeps {
  db: Db;
  registry: ExecutionRegistry;
  logger: Logger;
  workerId: string;
  host: string;
  worktrees: {
    prepareImplementation(
      input: PrepareImplementationInput,
    ): Promise<PreparedWorktree>;
    /** Resume of an evicted spec execution recreates its worktree (§6.6). */
    prepareSpec(input: PrepareSpecInput): Promise<PreparedWorktree>;
    /**
     * Resume removes a worktree whose recreation failed part way (§6.6), at
     * the row's recorded `worktree_path` (C33).
     */
    remove(worktreePath: string, options: RemoveOptions): Promise<RemoveResult>;
    /**
     * A fresh retry pushes the failed attempt's local branch first when it
     * ran on this host (C27). Without it nothing is pushed.
     */
    pushIfAhead?(input: PushIfAheadInput): Promise<PushIfAheadResult>;
    /**
     * A resume onto a newly approved revision rewrites the worktree's
     * `.orchestra/context.json`, so `orchestra-review` reads that revision
     * (GOT.47 C53). Without it the file is not rewritten.
     */
    writeContext?(worktreePath: string, context: ExecutionContext): Promise<void>;
  };
  /** One adapter per runtime (§7.3). A missing runtime fails the execution. */
  adapters: Partial<Record<Runtime, AgentAdapter>>;
  /** Agent-tools MCP url; read at session start, after the server listens. */
  toolsUrl: () => string;
  /** Jira `getIssue`, when JIRA_* is configured (Q11). */
  fetchTicket?: (jiraKey: string) => Promise<TicketContext>;
  githubToken?: string;
  /** AGENT_QUIET_TIMEOUT_MS (§9.4). */
  quietTimeoutMs: number;
  reviewWrapperBin?: string;
  /** PATH the agent's PATH is built on. Defaults to `process.env.PATH`. */
  basePath?: string;
  /**
   * Repository test command (design.md OI3, C15). Defaults to the
   * repository row's `test_command`.
   */
  testCommandFor?: (ctx: RunnerContext) => string | null;
  timings?: Partial<RunnerTimings>;
  now?: () => Date;
  /** Test seams; production passes nothing. */
  hooks?: {
    /**
     * Runs after a start or resume has committed and before the turn's
     * token is issued. Tests use it to interleave a state move.
     */
    beforeTokenIssue?: (executionId: string) => Promise<void>;
  };
}

export type ResumeErrorCode =
  | "NOT_FOUND"
  | "ALREADY_LIVE"
  | "NOT_RESUMABLE_STATE"
  | "OTHER_HOST"
  | "NO_SESSION"
  | "NO_ADAPTER"
  | "CANNOT_RESUME"
  | "WORKTREE_UNAVAILABLE"
  | "SHUT_DOWN";

/**
 * `runner.resume` refused. Nothing was written, except that a worktree
 * recreated after eviction is recorded before any later refusal, and a
 * fresh-session fallback's pin to this host (C21) stays.
 */
export class ResumeError extends Error {
  readonly code: ResumeErrorCode;
  readonly executionId: string;

  constructor(code: ResumeErrorCode, executionId: string, message: string) {
    super(message);
    this.name = "ResumeError";
    this.code = code;
    this.executionId = executionId;
  }
}

export interface ResumeInput {
  executionId: string;
  prompt: string;
  usageKind?: Extract<UsageKind, "resume">;
  /**
   * The state the command handler saw (GOT.37, GOT.47). The resume refuses
   * `NOT_RESUMABLE_STATE` when the row is in another state by the time it
   * is locked.
   */
  expectedState?: ExecutionState;
  /**
   * GOT.47: fields merged into the payload of the `execution.resumed` event
   * the resume transition writes, such as the command and the issue.
   */
  resumedPayload?: Record<string, unknown>;
  /**
   * §10.4: the newly approved revision. The resume sets
   * `executions.spec_revision_id` to it in the resume transaction and keeps
   * the old value in `execution.resumed` as `previous_spec_revision_id`.
   */
  specRevisionId?: string;
  /**
   * GOT.47 C21 (D5, §6.1): enables the fresh-session fallback for an
   * implementation execution whose `host` is null (released by the
   * dead-host sweeper) or whose session `canResume` refuses. Receives the
   * full user prompt and returns the prompt of the fresh session. Without
   * it, those cases refuse OTHER_HOST and CANNOT_RESUME.
   */
  freshPrompt?: (userPrompt: string) => string;
  /**
   * GOT.47 §9.3 issue conversation: runs in the after-turn transaction,
   * under the task, then execution, row locks, when the turn ended with the
   * execution still RUNNING. `finalText` is the agent's final text of the
   * turn, redacted. Returning true ends the turn in WAITING_FOR_USER instead
   * of a protocol violation.
   */
  conversationTurn?: (tx: Tx, turn: { finalText: string }) => Promise<boolean>;
}

/** Why a resume started a fresh session (C21). */
export type FreshSessionReason = "host_released" | "cannot_resume";

/** Per-turn options of `runSession`. */
interface TurnOptions {
  /** A fresh session on a RUNNING execution: store its session id (C21). */
  replaceSession?: boolean;
  conversationTurn?: ResumeInput["conversationTurn"];
}

/**
 * What the retry starter hands over with a retry execution (§9.5, C25):
 * the failed execution it retries, and the protocol nudge (C26) when the
 * retry is a protocol one.
 */
export interface RetryStart {
  previousExecutionId: string;
  nudge?: { missingToolCall: string };
}

export interface StartOptions {
  /** Start a retry: resume the failed session if possible, else fresh. */
  retry?: RetryStart;
}

/**
 * Resume header for an infrastructure retry that resumes the failed
 * session. No `buildResumePrompt` kind fits an infrastructure retry.
 */
export function infraRetryResumePrompt(previousAttempt: number, endReason: string): string {
  return [
    "## Retry after an infrastructure failure",
    `The previous attempt (${previousAttempt}) ended with ${endReason}, an infrastructure failure rather than a problem with your work. Continue from where you left off.`,
  ].join("\n");
}

/**
 * Header put before the normal start prompt when a retry starts a fresh
 * session: in the failed attempt's own worktree (C32), or in a new one
 * from the remote branch (C27). A protocol retry (C26) also carries the
 * `protocol_nudge` text naming the missing call, so the nudge survives a
 * fresh start.
 */
export function freshRetryHeader(
  previousAttempt: number,
  endReason: string,
  sameWorktree: boolean,
  nudge?: { missingToolCall: string },
): string {
  const where = sameWorktree
    ? "It runs in the same worktree, so that attempt's changes, committed or not, are still here"
    : "The working branch starts from what that attempt pushed, if anything";
  const header = [
    `## Retry of attempt ${previousAttempt}`,
    `The previous attempt (${previousAttempt}) ended with ${endReason}. This is a new session. ${where}; check its state before continuing.`,
  ].join("\n");
  return nudge
    ? `${header}\n\n${buildResumePrompt("protocol_nudge", { missingToolCall: nudge.missingToolCall })}`
    : header;
}

export interface Runner {
  /** Scheduler hand-off (§6.3). Never blocks the tick. */
  readonly onClaimed: OnClaimed;
  /**
   * Runs an ASSIGNED implementation execution: a claimed one, or with
   * `options.retry` a retry the starter pinned here. Resolves when the run
   * ends; never rejects.
   */
  start(claim: ClaimedExecution, options?: StartOptions): Promise<void>;
  /**
   * Runs the first turn of an ASSIGNED spec execution that the
   * `start_spec_session` handler created and pinned here (§9.1, §9.3, D8).
   * Resolves when the turn has been handled; never rejects.
   */
  startSpec(claim: ClaimedExecution): Promise<void>;
  /**
   * Resumes a WAITING_FOR_USER or COMPLETED execution on this host. A spec
   * execution may also be RUNNING between turns: it resumes in place with
   * no transition (GOT.37 C42), and a COMPLETED spec execution moves back
   * on `execution.resumed` (C45); both need the task in SPEC_IN_PROGRESS.
   * Resolves once it is RUNNING; `done` resolves when the turn has been handled.
   * An evicted worktree is first recreated from the remote branch (§6.6).
   * With `freshPrompt`, an implementation execution released from a dead
   * host, or whose session cannot be resumed, is pinned here and starts a
   * fresh session in its recorded worktree instead (C21).
   * Rejects with `ResumeError` without writing anything otherwise, except
   * that a recreated worktree and a fallback pin stay recorded.
   */
  resume(input: ResumeInput): Promise<{ done: Promise<void> }>;
  /** Aborts the live run of `executionId`. False when none runs here. */
  abort(executionId: string): boolean;
  isLive(executionId: string): boolean;
  /** Aborts every live run and waits up to `timeoutMs` for them to finish. */
  shutdown(timeoutMs?: number): Promise<void>;
}

type StopReason = "cancelled" | "gone" | "hung" | "blocking_timeout" | "shutdown";

class RunState {
  readonly controller = new AbortController();
  stopReason: StopReason | null = null;
  readonly stopped: Promise<void>;
  done: Promise<void> = Promise.resolve();
  private resolveStopped!: () => void;

  constructor(readonly executionId: string) {
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  stop(reason: StopReason): void {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.controller.abort();
    this.resolveStopped();
  }
}

type TurnEnd =
  | { kind: "turn_done"; finalText: string }
  | { kind: "exhausted" }
  | { kind: "error"; message: string; retriable: boolean }
  | { kind: "thrown"; message: string }
  | { kind: "stopped"; reason: StopReason };

const ENDED_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

function tail(text: string, max: number = END_DETAIL_MAX_CHARS): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function setupDetail(err: unknown): string {
  if (err instanceof SetupFailedError) {
    return tail(`${err.message}\n${err.outputTail}`);
  }
  return tail(errMessage(err));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Serialises the run's database writes, so events keep their order. */
function createWriteQueue(log: Logger) {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(what: string, fn: () => Promise<void>): Promise<void> {
      const next = tail.then(fn).catch((err: unknown) => {
        log.error({ what, err: errMessage(err) }, "runner write failed");
      });
      tail = next;
      return next;
    },
    drain: (): Promise<void> => tail,
  };
}

export function createRunner(deps: RunnerDeps): Runner {
  const { db, registry, logger, workerId, host } = deps;
  const now = deps.now ?? (() => new Date());
  const timings: RunnerTimings = { ...DEFAULT_RUNNER_TIMINGS, ...deps.timings };
  const reviewWrapperBin = deps.reviewWrapperBin ?? DEFAULT_REVIEW_WRAPPER_BIN;
  const testCommandFor =
    deps.testCommandFor ?? ((ctx: RunnerContext) => ctx.repository?.testCommand ?? null);
  const live = new Map<string, RunState>();
  let closed = false;

  const worker = { kind: "worker" as const, id: workerId };

  // ------------------------------------------------------------ db writes

  /**
   * Event-only write: task, then execution, KEY SHARE (as agent-tools does).
   * A spec execution only leaves ASSIGNED or RUNNING through the api or a
   * sweeper (request-review, cancel), never through its own tools, so for
   * the spec role a non-live state under the lock means the execution is no
   * longer this runner's: nothing is written and false is returned (GOT.37
   * F5). The key-share lock blocks a concurrent state move until commit.
   * An implementation execution ends through its own tools mid-turn
   * (report_pr_created, report_failed) and keeps its trailing events (§9.3).
   */
  async function appendRunEvent(
    ctx: RunnerContext,
    type: ExecutionEventType,
    payload: unknown,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id, "key share");
      const row = await lockExecutionForTool(tx, ctx.execution.id, "key share");
      if (
        ctx.execution.role === "spec" &&
        row?.state !== "ASSIGNED" &&
        row?.state !== "RUNNING"
      ) {
        return false;
      }
      await appendEvent(tx, {
        taskId: ctx.task.id,
        executionId: ctx.execution.id,
        type,
        payload,
      });
      return true;
    });
  }

  /**
   * Ends the execution FAILED (`ASSIGNED` or `RUNNING` only), then applies
   * the §9.5 retry policy in the same transaction. Any other state was set
   * by a tool or the api and is left alone.
   */
  async function endFailed(
    ctx: RunnerContext,
    endReason: EndReason,
    endDetail: string,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id);
      const row = await lockExecutionForTool(tx, ctx.execution.id);
      if (!row || (row.state !== "ASSIGNED" && row.state !== "RUNNING")) return;
      const endedAt = now();
      await transition(tx, {
        entity: "execution",
        id: ctx.execution.id,
        trigger: "execution.failed",
        actor: worker,
        set: { endReason, endDetail, endedAt },
      });
      await runFailurePolicy(tx, {
        executionId: ctx.execution.id,
        endReason,
        endDetail,
        actor: worker,
        now: endedAt,
        logger,
      });
    });
  }

  /**
   * §8 "issued at start or resume": issues the turn's token only while the
   * execution is ASSIGNED or RUNNING, checked under the task, then
   * execution, row locks. Request-review revokes a spec token in the same
   * transaction that completes the execution, so a token is never stored
   * on a COMPLETED row (GOT.37 F4). Null when the execution is not live.
   */
  async function issueRunToken(ctx: RunnerContext): Promise<string | null> {
    return db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id, "key share");
      const row = await lockExecutionForTool(tx, ctx.execution.id);
      if (row?.state !== "ASSIGNED" && row?.state !== "RUNNING") return null;
      return issueToken(tx, ctx.execution.id);
    });
  }

  // --------------------------------------------------------- run lifecycle

  /**
   * Every exit path: revoke the token (§8, it leaves RUNNING or the turn is
   * over), drop the registry entry, forget the run, stamp `ended_at` on an
   * ended execution.
   */
  async function finalize(state: RunState, log: Logger): Promise<void> {
    const id = state.executionId;
    try {
      await revokeToken(db, id);
    } catch (err) {
      log.error({ err: errMessage(err) }, "token revocation failed");
    }
    registry.delete(id);
    try {
      await markExecutionEnded(db, id, now());
    } catch (err) {
      log.error({ err: errMessage(err) }, "stamping ended_at failed");
    }
    if (live.get(id) === state) live.delete(id);
  }

  function track(
    state: RunState,
    log: Logger,
    body: () => Promise<void>,
  ): Promise<void> {
    state.done = (async () => {
      try {
        await body();
      } catch (err) {
        log.error({ err: errMessage(err) }, "execution run failed");
      } finally {
        await finalize(state, log);
      }
    })();
    return state.done;
  }

  function agentEnv(token: string): Record<string, string> {
    const env: Record<string, string> = {
      PATH: [reviewWrapperBin, deps.basePath ?? process.env.PATH ?? ""]
        .filter((p) => p !== "")
        .join(path.delimiter),
      ORCHESTRA_URL: deps.toolsUrl(),
      ORCHESTRA_TOKEN: token,
    };
    if (deps.githubToken) env.GITHUB_TOKEN = deps.githubToken;
    return env;
  }

  const modelFor = (ctx: RunnerContext): string | undefined =>
    ctx.execution.model === DEFAULT_EXECUTION_MODEL
      ? undefined
      : ctx.execution.model;

  /**
   * §6.4: renews the lease every `leaseRenewMs` while `body` runs. Spec
   * sessions hold no lease, so only implementation renews. `renewNow` also
   * renews once before `body`. The state-gated helper (carry-forward, PR #17)
   * never renews an execution that is no longer ASSIGNED or RUNNING; that
   * result aborts the run.
   */
  async function withLease(
    state: RunState,
    ctx: RunnerContext,
    log: Logger,
    renewNow: boolean,
    body: () => Promise<void>,
  ): Promise<void> {
    if (ctx.execution.role !== "implementation") return body();
    const renew = async (): Promise<void> => {
      try {
        const expiresAt = await renewExecutionLease(db, ctx.execution.id, now());
        if (expiresAt === null) {
          log.info({}, "lease not renewable: execution no longer live, aborting");
          state.stop("gone");
        }
      } catch (err) {
        log.error({ err: errMessage(err) }, "lease renewal failed");
      }
    };
    const interval = setInterval(() => void renew(), timings.leaseRenewMs);
    try {
      if (renewNow) {
        await renew();
        if (state.stopReason !== null) return;
      }
      await body();
    } finally {
      clearInterval(interval);
    }
  }

  // ---------------------------------------------------------- the session

  /**
   * §9.3: issue the token, register, open the adapter stream, persist its
   * events, then decide the next state. `open` starts or resumes the session.
   */
  async function runSession(
    state: RunState,
    ctx: RunnerContext,
    usageKind: "main" | "resume",
    log: Logger,
    open: (token: string, signal: AbortSignal) => AsyncIterable<AgentEvent>,
    turnOptions: TurnOptions = {},
  ): Promise<void> {
    const executionId = ctx.execution.id;
    const writes = createWriteQueue(log);
    /** `appendRunEvent`; a write refused as not live is the gone signal (F5). */
    const appendLive = async (type: ExecutionEventType, payload: unknown): Promise<void> => {
      if (await appendRunEvent(ctx, type, payload)) return;
      if (state.stopReason === null) {
        log.info({ type }, "spec execution left RUNNING, event dropped, aborting the session");
      }
      state.stop("gone");
    };
    const timeouts = new Set<NodeJS.Timeout>();
    const intervals = new Set<NodeJS.Timeout>();
    let quietTimer: NodeJS.Timeout | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    let blockingTimer: NodeJS.Timeout | undefined;

    const after = (ms: number, fn: () => void): NodeJS.Timeout => {
      const t = setTimeout(() => {
        timeouts.delete(t);
        fn();
      }, ms);
      timeouts.add(t);
      return t;
    };
    const cancel = (t: NodeJS.Timeout | undefined): void => {
      if (!t) return;
      clearTimeout(t);
      timeouts.delete(t);
    };

    try {
      await deps.hooks?.beforeTokenIssue?.(executionId);
      const token = await issueRunToken(ctx);
      if (token === null) {
        // Request-review or a cancel moved it since the start or resume
        // transaction committed. No token, no session, no further writes.
        log.info({}, "execution is no longer live, not opening the session");
        state.stop("gone");
        return;
      }
      const redact = <T>(value: T): T => redactToken(value, token);

      // Agent-tools calls renew through the default, state-gated helper.
      const entry: LiveExecution = createLiveExecution(
        { executionId, taskId: ctx.task.id, role: ctx.execution.role },
        { db, now },
      );
      registry.set(entry);

      const checkBlocking = (): void => {
        if (entry.blockingPending && !blockingTimer) {
          log.info({}, "blocking issue raised; turn must end within the grace period");
          blockingTimer = after(timings.blockingGraceMs, () =>
            state.stop("blocking_timeout"),
          );
        }
      };
      intervals.add(setInterval(checkBlocking, timings.blockingPollMs));

      // GOT.37 C44: request-review (and cancel) move a spec execution out of
      // RUNNING in the database only, while a turn may be in flight. On the
      // same poll, a spec run reads its state and aborts the session once
      // it is no longer ASSIGNED or RUNNING; the after-turn then writes
      // nothing (a `gone` stop).
      if (ctx.execution.role === "spec") {
        let reading = false;
        const checkSpecState = (): void => {
          if (reading || state.stopReason !== null) return;
          reading = true;
          void getExecutionState(db, executionId)
            .then((current) => {
              if (current === "ASSIGNED" || current === "RUNNING") return;
              log.info({ state: current }, "spec execution left RUNNING, aborting the session");
              state.stop("gone");
            })
            .catch((err: unknown) => {
              log.warn({ err: errMessage(err) }, "spec execution state check failed");
            })
            .finally(() => {
              reading = false;
            });
        };
        intervals.add(setInterval(checkSpecState, timings.blockingPollMs));
      }

      const resetQuiet = (): void => {
        cancel(quietTimer);
        quietTimer = after(deps.quietTimeoutMs, () => state.stop("hung"));
      };
      resetQuiet();

      // ---- text batching (§9.3)
      let buffer = "";
      let turnText = "";
      const flush = (): Promise<void> => {
        cancel(flushTimer);
        flushTimer = undefined;
        // The timer may have emptied the buffer with its write still queued.
        if (buffer === "") return writes.drain();
        const text = redact(buffer);
        buffer = "";
        return writes.push("agent.message.delta", () =>
          appendLive("agent.message.delta", { text }),
        );
      };

      const events = open(token, state.controller.signal);
      const iterator = events[Symbol.asyncIterator]();
      let finished = false;
      let end: TurnEnd;

      try {
        for (;;) {
          const next = await Promise.race([
            iterator.next().then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            ),
            state.stopped.then(() => null),
          ]);
          if (next === null) {
            end = { kind: "stopped", reason: state.stopReason! };
            break;
          }
          if ("error" in next) {
            finished = true;
            end =
              state.stopReason !== null
                ? { kind: "stopped", reason: state.stopReason }
                : { kind: "thrown", message: redact(errMessage(next.error)) };
            break;
          }
          if (next.result.done) {
            finished = true;
            end = { kind: "exhausted" };
            break;
          }

          const event = next.result.value;
          resetQuiet();
          checkBlocking();

          // Buffered text is written before anything the adapter sent after
          // it, including what an agent-tools call writes once its tool_call
          // event is out, so execution_events keep the adapter's order.
          if (event.type !== "text") await flush();

          if (event.type === "session") {
            await writes.push("session", () =>
              onSession(state, ctx, event.sessionId, log, turnOptions.replaceSession === true),
            );
          } else if (event.type === "text") {
            buffer += event.delta;
            turnText += event.delta;
            if (!flushTimer) flushTimer = after(timings.flushMs, () => void flush());
          } else if (event.type === "tool_call") {
            if (!event.name.startsWith(ORCHESTRA_TOOL_PREFIX)) {
              const payload = redact({ name: event.name, input: event.input });
              await writes.push("agent.tool_call", () =>
                appendLive("agent.tool_call", payload),
              );
            }
          } else if (event.type === "usage") {
            await writes.push("usage", () => recordUsage(ctx, usageKind, event));
          } else if (event.type === "error") {
            end = {
              kind: "error",
              message: redact(event.message),
              retriable: event.retriable,
            };
            break;
          } else if (event.type === "turn_done") {
            end = { kind: "turn_done", finalText: event.finalText };
            break;
          }
          // tool_result: agent-tools records its own calls.
        }
      } finally {
        if (!finished) {
          void Promise.resolve(iterator.return?.()).catch(() => {});
        }
      }

      if (end.kind === "stopped" && end.reason === "gone") {
        // The execution left the live states under us (C44 request-review,
        // a cancel): its buffered text and the turn's message are dropped,
        // so it gets no further runner writes.
        // C52: every role. A gone execution is no longer this runner's, the same class of write F5 forbids.
        cancel(flushTimer);
        flushTimer = undefined;
        buffer = "";
      } else {
        void flush();
        const message =
          turnText !== ""
            ? turnText
            : end.kind === "turn_done"
              ? end.finalText
              : "";
        if (message !== "") {
          const text = redact(message);
          void writes.push("agent.message", () =>
            appendLive("agent.message", { text }),
          );
        }
      }
      await writes.drain();

      // §9.3 issue conversation: the agent's final text of the turn.
      const finalText = redact(
        end.kind === "turn_done" && end.finalText !== "" ? end.finalText : turnText,
      );
      await afterTurn(ctx, entry, end, log, finalText, turnOptions.conversationTurn);
    } finally {
      cancel(quietTimer);
      cancel(flushTimer);
      cancel(blockingTimer);
      for (const t of timeouts) clearTimeout(t);
      for (const i of intervals) clearInterval(i);
      await writes.drain();
    }
  }

  /**
   * `session` event: store the id and move ASSIGNED -> RUNNING (§9.3). With
   * `replaceSession`, a fresh session on a RUNNING execution (C21) also
   * stores its id, so the next resume uses it.
   */
  async function onSession(
    state: RunState,
    ctx: RunnerContext,
    sessionId: string,
    log: Logger,
    replaceSession: boolean,
  ): Promise<void> {
    const outcome = await db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id);
      const row = await lockExecutionForTool(tx, ctx.execution.id);
      if (!row) return "gone" as const;
      if (row.state === "ASSIGNED") {
        await transition(tx, {
          entity: "execution",
          id: ctx.execution.id,
          trigger: "execution.started",
          actor: worker,
          set: { sessionId, startedAt: now() },
        });
        return "started" as const;
      }
      if (row.state !== "RUNNING") return "gone" as const;
      if (replaceSession) await setExecutionSessionId(tx, ctx.execution.id, sessionId);
      return "running" as const;
    });
    if (outcome === "gone") {
      log.info({}, "session started for an execution that is no longer live, aborting");
      state.stop("gone");
    }
  }

  /** `usage` event: one `execution_usage` row, totals, `usage.recorded`. */
  async function recordUsage(
    ctx: RunnerContext,
    kind: "main" | "resume",
    event: Extract<AgentEvent, { type: "usage" }>,
  ): Promise<void> {
    const costUsd = String(event.costUsd ?? 0);
    await db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id, "key share");
      const usage = await insertExecutionUsage(tx, {
        executionId: ctx.execution.id,
        kind,
        round: null,
        runtime: ctx.execution.runtime,
        model: event.model,
        inputTokens: event.input,
        cachedInputTokens: event.cached,
        outputTokens: event.output,
        costUsd,
        recordedAt: now(),
      });
      await addExecutionUsageTotals(tx, ctx.execution.id, {
        inputTokens: event.input,
        cachedInputTokens: event.cached,
        outputTokens: event.output,
        costUsd,
      });
      await appendEvent(tx, {
        taskId: ctx.task.id,
        executionId: ctx.execution.id,
        type: "usage.recorded",
        payload: {
          usage_id: usage.id,
          kind,
          model: event.model,
          input_tokens: event.input,
          cached_input_tokens: event.cached,
          output_tokens: event.output,
          cost_usd: costUsd,
        },
      });
    });
  }

  /**
   * §9.3 after the loop, §8 blocking handling, §9.4 liveness. An issue
   * conversation turn (`conversationTurn`, GOT.47) on a RUNNING execution
   * stores the agent's reply and returns to WAITING_FOR_USER while an issue
   * still holds it there.
   */
  async function afterTurn(
    ctx: RunnerContext,
    entry: LiveExecution,
    end: TurnEnd,
    log: Logger,
    finalText: string,
    conversationTurn?: ResumeInput["conversationTurn"],
  ): Promise<void> {
    switch (end.kind) {
      case "stopped":
        if (end.reason === "hung") {
          await endFailed(
            ctx,
            "agent_hung",
            `no agent event for ${deps.quietTimeoutMs} ms`,
          );
          return;
        }
        if (end.reason !== "blocking_timeout") return;
        break;
      case "error":
        await endFailed(
          ctx,
          "adapter_error",
          JSON.stringify({ message: end.message, retriable: end.retriable }),
        );
        return;
      case "thrown":
        await endFailed(ctx, "process_crash", tail(end.message));
        return;
      case "turn_done":
      case "exhausted":
        break;
    }

    const outcome = await db.transaction(async (tx) => {
      // Task, then execution (carry-forward lock order, PR #17).
      await lockTaskForTool(tx, ctx.task.id);
      const row = await lockExecutionForTool(tx, ctx.execution.id);
      if (!row) return "gone";
      const holding =
        row.state === "RUNNING" && conversationTurn
          ? await conversationTurn(tx, { finalText })
          : false;
      if ((entry.blockingPending || holding) && row.state === "RUNNING") {
        await transition(tx, {
          entity: "execution",
          id: ctx.execution.id,
          trigger: "execution.waiting",
          actor: worker,
        });
        return "waiting";
      }
      if (ENDED_STATES.has(row.state)) return "ended";
      if (ctx.execution.role === "spec") return "spec";
      if (row.state !== "RUNNING" && row.state !== "ASSIGNED") return "other";
      const endedAt = now();
      await transition(tx, {
        entity: "execution",
        id: ctx.execution.id,
        trigger: "execution.failed",
        actor: worker,
        set: {
          endReason: "protocol_violation",
          endDetail: PROTOCOL_VIOLATION_DETAIL,
          endedAt,
        },
      });
      await runFailurePolicy(tx, {
        executionId: ctx.execution.id,
        endReason: "protocol_violation",
        endDetail: PROTOCOL_VIOLATION_DETAIL,
        actor: worker,
        now: endedAt,
        logger: log,
      });
      return "protocol_violation";
    });
    log.info({ outcome, end: end.kind }, "turn handled");
  }

  // ----------------------------------------------------------------- start

  async function loadTicket(ctx: RunnerContext, log: Logger): Promise<TicketContext> {
    const fallback: TicketContext = {
      key: ctx.task.jiraKey,
      summary: ctx.task.jiraSummary,
      description: "",
      comments: [],
    };
    if (!deps.fetchTicket) return fallback;
    try {
      return await deps.fetchTicket(ctx.task.jiraKey);
    } catch (err) {
      log.warn({ err: errMessage(err) }, "Jira ticket fetch failed, prompting without it");
      return fallback;
    }
  }

  /**
   * §9.2 implementation user prompt: ticket, approved spec, every decision
   * on the task, repository block. `ctx.repository` must be set.
   */
  async function implementationUserPrompt(
    ctx: RunnerContext,
    spec: { version: number; content: ReturnType<typeof SpecContentSchema.parse> },
    workingBranch: string | null,
    log: Logger,
  ): Promise<string> {
    return buildUserPrompt({
      role: "implementation",
      ticket: await loadTicket(ctx, log),
      approvedSpec: spec,
      decisions: ctx.decisions.map((d) => ({
        issueId: d.issueId,
        decision: d.decision,
        clarification: d.clarification,
        chosenOption: d.chosenOption,
        author: d.decidedBy,
        decidedAt: d.decidedAt.toISOString().slice(0, 10),
      })),
      repository: {
        name: ctx.repository!.name,
        defaultBranch: ctx.repository!.defaultBranch,
        workingBranch,
        setupCommand: ctx.repository!.setupCommand,
        testCommand: testCommandFor(ctx),
      },
    });
  }

  async function startBody(
    state: RunState,
    claim: ClaimedExecution,
    options: StartOptions,
    log: Logger,
  ): Promise<void> {
    const ctx = await loadRunnerContext(db, claim.executionId);
    if (!ctx) {
      log.warn({}, "claimed execution not found");
      return;
    }
    if (ctx.execution.role !== "implementation" || ctx.execution.state !== "ASSIGNED") {
      log.warn(
        { role: ctx.execution.role, state: ctx.execution.state },
        "claimed execution is not an ASSIGNED implementation, not starting",
      );
      return;
    }
    const retry = options.retry;
    if (!retry) {
      // Renewal covers worktree preparation too: a slow fetch or
      // setup_command must not let the lease expire (§6.4, §6.5).
      await withLease(state, ctx, log, true, () => prepareAndRun(state, ctx, log));
      return;
    }
    const previous = (await loadRunnerContext(db, retry.previousExecutionId))?.execution ?? null;
    // C31, C32: the starter's claim gave this retry the failed attempt's
    // worktree when it was on this host. A retry never prepares a new
    // worktree while that one exists, so no unpushed commit is lost.
    const reused =
      ctx.execution.worktreePath !== null && (await pathExists(ctx.execution.worktreePath))
        ? { worktreePath: ctx.execution.worktreePath, branch: ctx.execution.branch }
        : null;
    await withLease(state, ctx, log, true, async () => {
      if (reused) {
        const session = previous
          ? await resumableSession(ctx, previous, reused.worktreePath, log)
          : null;
        if (session && previous) {
          await resumeRetry(state, ctx, previous, session, retry, log);
          return;
        }
        await prepareAndRun(state, ctx, log, previous, reused, retry.nudge);
        return;
      }
      await prepareAndRun(state, ctx, log, previous, null, retry.nudge);
    });
  }

  /**
   * §9.5 "resume session if canResume": the adapter can resume the failed
   * attempt's session in the worktree this retry took over. Returns the
   * session and worktree, else null.
   */
  async function resumableSession(
    ctx: RunnerContext,
    previous: RunnerContext["execution"],
    worktreePath: string,
    log: Logger,
  ): Promise<{ sessionId: string; worktreePath: string } | null> {
    const adapter = deps.adapters[ctx.execution.runtime];
    const { sessionId } = previous;
    if (!adapter || !sessionId) return null;
    try {
      return (await adapter.canResume(sessionId, worktreePath))
        ? { sessionId, worktreePath }
        : null;
    } catch (err) {
      log.warn({ err: errMessage(err) }, "canResume failed; starting the retry fresh");
      return null;
    }
  }

  /**
   * A retry that resumes the failed session in the failed attempt's
   * worktree, which the starter already recorded on the retry (C31): moves
   * it ASSIGNED -> RUNNING, then resumes with the protocol nudge (C26) or
   * the infrastructure header.
   */
  async function resumeRetry(
    state: RunState,
    ctx: RunnerContext,
    previous: RunnerContext["execution"],
    session: { sessionId: string; worktreePath: string },
    retry: RetryStart,
    log: Logger,
  ): Promise<void> {
    const adapter = deps.adapters[ctx.execution.runtime]!;
    await setExecutionPlacement(db, ctx.execution.id, { workerId, host });
    const started = await db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id);
      const row = await lockExecutionForTool(tx, ctx.execution.id);
      if (row?.state !== "ASSIGNED") return false;
      await transition(tx, {
        entity: "execution",
        id: ctx.execution.id,
        trigger: "execution.started",
        actor: worker,
        set: { sessionId: session.sessionId, startedAt: now() },
      });
      return true;
    });
    if (!started || state.stopReason !== null) {
      log.info({}, "retry is no longer ASSIGNED, not resuming");
      return;
    }

    // The runtime reports session totals, so the baseline is what the
    // failed attempt's session already reported (§9.7).
    const baseline: UsageBaseline = {};
    for (const row of await sumSessionUsageByModel(db, previous.id)) {
      baseline[row.model] = {
        input: row.inputTokens,
        cached: row.cachedInputTokens,
        output: row.outputTokens,
        costUsd: row.costUsd,
      };
    }
    const prompt = retry.nudge
      ? buildResumePrompt("protocol_nudge", { missingToolCall: retry.nudge.missingToolCall })
      : infraRetryResumePrompt(previous.attempt, previous.endReason ?? "an unknown failure");
    const testCommand = testCommandFor(ctx);
    log.info(
      { previousExecutionId: previous.id, sessionId: session.sessionId },
      "retry resumes the failed session",
    );
    await runSession(state, ctx, "resume", log, (token, signal) =>
      adapter.resume(
        {
          cwd: session.worktreePath,
          prompt,
          model: modelFor(ctx),
          allowedTools: "implementation",
          mcp: { url: deps.toolsUrl(), token },
          env: agentEnv(token),
          sessionId: session.sessionId,
          usageBaseline: baseline,
          ...(testCommand ? { testCommand } : {}),
        },
        signal,
      ),
    );
  }

  /**
   * C27: before a fresh retry, push the failed attempt's local branch when
   * it ran on this host, so the new worktree starts from its commits. Runs
   * outside any transaction. A failure is logged and the retry goes on.
   */
  async function pushPreviousBranch(
    ctx: RunnerContext,
    previous: RunnerContext["execution"],
    log: Logger,
  ): Promise<void> {
    if (previous.host !== host || !previous.branch || !ctx.repository) return;
    if (!deps.worktrees.pushIfAhead) return;
    try {
      const result = await deps.worktrees.pushIfAhead({
        repositoryName: ctx.repository.name,
        branch: previous.branch,
        defaultBranch: ctx.repository.defaultBranch,
      });
      log.info(
        { branch: previous.branch, pushed: result.pushed, ahead: result.ahead, reason: result.reason },
        "pushed the failed attempt's branch before a fresh retry",
      );
    } catch (err) {
      log.warn(
        { branch: previous.branch, err: errMessage(err) },
        "could not push the failed attempt's branch; the retry starts from the remote",
      );
    }
  }

  /**
   * Prepares a worktree and starts a new session. `retryOf` is the failed
   * attempt of a fresh retry, and the prompt names it, with the protocol
   * `nudge` when the retry is a protocol one (C26, F3). With `reuse` (C32)
   * the session starts in the failed attempt's worktree the retry took
   * over, and nothing is pushed or prepared. Without it, a retry pushes the
   * failed attempt's branch first when it ran on this host (C27) and
   * prepares a new worktree from the remote branch (the default branch
   * when the remote has none).
   */
  async function prepareAndRun(
    state: RunState,
    ctx: RunnerContext,
    log: Logger,
    retryOf: RunnerContext["execution"] | null = null,
    reuse: { worktreePath: string; branch: string | null } | null = null,
    nudge?: { missingToolCall: string },
  ): Promise<void> {
    await setExecutionPlacement(db, ctx.execution.id, { workerId, host });

    const adapter = deps.adapters[ctx.execution.runtime];
    if (!adapter) {
      await endFailed(
        ctx,
        "adapter_error",
        `${ctx.execution.runtime} adapter not available`,
      );
      return;
    }

    const testCommand = testCommandFor(ctx);
    let prepared: PreparedWorktree;
    let spec: { version: number; content: ReturnType<typeof SpecContentSchema.parse> };
    try {
      if (!ctx.repository) throw new Error("task has no repository");
      if (!ctx.revision) throw new Error("no approved specification revision");
      spec = {
        version: ctx.revision.version,
        content: SpecContentSchema.parse(ctx.revision.content),
      };
      if (reuse) {
        prepared = { worktreePath: reuse.worktreePath, branch: reuse.branch };
      } else {
        if (retryOf) await pushPreviousBranch(ctx, retryOf, log);
        prepared = await deps.worktrees.prepareImplementation({
          executionId: ctx.execution.id,
          repository: {
            name: ctx.repository.name,
            gitUrl: ctx.repository.gitUrl,
            defaultBranch: ctx.repository.defaultBranch,
            setupCommand: ctx.repository.setupCommand,
          },
          task: {
            id: ctx.task.id,
            jiraKey: ctx.task.jiraKey,
            jiraSummary: ctx.task.jiraSummary,
          },
          spec,
          decisions: ctx.decisions.map((d) => ({
            issue_id: d.issueId,
            decision: d.decision,
            clarification: d.clarification,
            chosen_option: d.chosenOption,
            decided_by: d.decidedBy,
            decided_at: d.decidedAt.toISOString(),
          })),
          reviewCommand: testCommand,
          runtime: ctx.execution.runtime,
          ...(retryOf ? { resumeFromRemote: true, fallbackToDefaultBranch: true } : {}),
        });
      }
    } catch (err) {
      log.warn({ err: errMessage(err) }, "worktree preparation failed");
      await endFailed(ctx, "setup_failed", setupDetail(err));
      return;
    }
    if (state.stopReason !== null) return;

    // A reused worktree is already recorded on the row by the starter.
    if (!reuse) {
      await db.transaction(async (tx) => {
        await lockTaskForTool(tx, ctx.task.id, "key share");
        await setExecutionWorktree(tx, ctx.execution.id, prepared);
        await appendEvent(tx, {
          taskId: ctx.task.id,
          executionId: ctx.execution.id,
          type: "worktree.prepared",
          payload: {
            worktree_path: prepared.worktreePath,
            branch: prepared.branch,
            ...(retryOf && prepared.startPoint ? { start_point: prepared.startPoint } : {}),
          },
        });
      });
    }

    const noMistakes = await pathExists(
      path.join(prepared.worktreePath, NO_MISTAKES_MARKER),
    );
    const systemPrompt = systemPromptFor("implementation", { noMistakes });
    const startPrompt = await implementationUserPrompt(ctx, spec, prepared.branch, log);
    const prompt = retryOf
      ? `${freshRetryHeader(retryOf.attempt, retryOf.endReason ?? "an unknown failure", reuse !== null, nudge)}\n\n${startPrompt}`
      : startPrompt;

    if (state.stopReason !== null) return;
    // TODO(GOT.44/GOT.45): pass `maxBudgetUsd` once `projects.max_budget_usd`
    // exists (GOT.44) and the adapters honour it (GOT.45). Until then
    // `budget_exceeded` is classified in retry.ts but never produced (C29).
    await runSession(state, ctx, "main", log, (token, signal) =>
      adapter.start(
        {
          cwd: prepared.worktreePath,
          systemPrompt,
          prompt,
          model: modelFor(ctx),
          allowedTools: "implementation",
          mcp: { url: deps.toolsUrl(), token },
          env: agentEnv(token),
          ...(testCommand ? { testCommand } : {}),
        },
        signal,
      ),
    );
  }

  function start(claim: ClaimedExecution, options: StartOptions = {}): Promise<void> {
    const log = logger.child({ executionId: claim.executionId, taskId: claim.taskId });
    if (closed) {
      log.warn({}, "runner is shutting down, not starting execution");
      return Promise.resolve();
    }
    if (live.has(claim.executionId)) {
      log.warn({}, "execution already running here");
      return Promise.resolve();
    }
    const state = new RunState(claim.executionId);
    live.set(claim.executionId, state);
    return track(state, log, () => startBody(state, claim, options, log));
  }

  // ------------------------------------------------------------ spec start

  /**
   * GOT.37: the first turn of a spec execution (§9.1, §9.2, §9.3, D8). A
   * read-only worktree detached at the default branch under
   * `work/<execution id>`, the spec system prompt, a user prompt with the
   * ticket and the current draft, and the `spec` tool policy. Spec sessions
   * hold no lease. After the turn the execution stays RUNNING (the
   * after-turn `spec` rule) and `finalize` revokes the token.
   */
  async function startSpecBody(
    state: RunState,
    claim: ClaimedExecution,
    log: Logger,
  ): Promise<void> {
    const loaded = await loadRunnerContext(db, claim.executionId);
    if (!loaded) {
      log.warn({}, "spec execution not found");
      return;
    }
    if (loaded.execution.role !== "spec" || loaded.execution.state !== "ASSIGNED") {
      log.warn(
        { role: loaded.execution.role, state: loaded.execution.state },
        "execution is not an ASSIGNED spec execution, not starting",
      );
      return;
    }
    // C41: before approval the task may have no repository.
    const repository =
      loaded.repository ?? (await resolveSpecRepository(db, loaded.task.id));
    const ctx: RunnerContext = { ...loaded, repository };

    const adapter = deps.adapters[ctx.execution.runtime];
    if (!adapter) {
      await endFailed(ctx, "adapter_error", `${ctx.execution.runtime} adapter not available`);
      return;
    }

    let prepared: PreparedWorktree;
    try {
      if (!repository) throw new Error("project has no repository");
      // No row lock is held here (carry-forward, PR #34).
      prepared = await deps.worktrees.prepareSpec({
        executionId: ctx.execution.id,
        repository: {
          name: repository.name,
          gitUrl: repository.gitUrl,
          defaultBranch: repository.defaultBranch,
          setupCommand: repository.setupCommand,
        },
      });
    } catch (err) {
      log.warn({ err: errMessage(err) }, "spec worktree preparation failed");
      await endFailed(ctx, "setup_failed", setupDetail(err));
      return;
    }
    if (state.stopReason !== null) return;

    await db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id, "key share");
      await setExecutionWorktree(tx, ctx.execution.id, prepared);
      await appendEvent(tx, {
        taskId: ctx.task.id,
        executionId: ctx.execution.id,
        type: "worktree.prepared",
        payload: { worktree_path: prepared.worktreePath, branch: prepared.branch },
      });
    });

    const draftRow = await getRevisionByStatus(db, ctx.task.id, "draft");
    const draftContent = draftRow ? SpecContentSchema.safeParse(draftRow.content) : null;
    if (draftContent && !draftContent.success) {
      log.warn({ revisionId: draftRow!.id }, "draft revision is not valid spec content, prompting without it");
    }
    const prompt = buildUserPrompt({
      role: "spec",
      ticket: await loadTicket(ctx, log),
      draftSpec:
        draftRow && draftContent?.success
          ? { version: draftRow.version, content: draftContent.data }
          : null,
      approvedSpec: null,
      decisions: ctx.decisions.map((d) => ({
        issueId: d.issueId,
        decision: d.decision,
        clarification: d.clarification,
        chosenOption: d.chosenOption,
        author: d.decidedBy,
        decidedAt: d.decidedAt.toISOString().slice(0, 10),
      })),
      repository: {
        name: repository!.name,
        defaultBranch: repository!.defaultBranch,
        workingBranch: null,
        setupCommand: repository!.setupCommand,
        testCommand: testCommandFor(ctx),
      },
    });

    if (state.stopReason !== null) return;
    await runSession(state, ctx, "main", log, (token, signal) =>
      adapter.start(
        {
          cwd: prepared.worktreePath,
          systemPrompt: systemPromptFor("spec"),
          prompt,
          model: modelFor(ctx),
          allowedTools: "spec",
          mcp: { url: deps.toolsUrl(), token },
          env: agentEnv(token),
        },
        signal,
      ),
    );
  }

  function startSpec(claim: ClaimedExecution): Promise<void> {
    const log = logger.child({ executionId: claim.executionId, taskId: claim.taskId });
    if (closed) {
      log.warn({}, "runner is shutting down, not starting spec execution");
      return Promise.resolve();
    }
    if (live.has(claim.executionId)) {
      log.warn({}, "execution already running here");
      return Promise.resolve();
    }
    const state = new RunState(claim.executionId);
    live.set(claim.executionId, state);
    return track(state, log, () => startSpecBody(state, claim, log));
  }

  // ---------------------------------------------------------------- resume

  /**
   * §6.6: the sweeper evicted this execution's worktree. Recreates it at the
   * row's recorded `worktree_path` (C33), which is `work/<executionId>` or,
   * for a retry that took over a failed attempt's worktree, that attempt's
   * `work/<id>`, so the adapter's session store, keyed by cwd, still
   * matches: a spec worktree detached at
   * `origin/<default_branch>` (§9.1); an implementation worktree from
   * `origin/<branch>`, or from `origin/<default_branch>` on the same branch
   * name when the remote lacks it (the sweeper pushes a branch that is
   * ahead, so nothing was left to push); that fallback is logged as a
   * warning. Then records the path, clears `worktree_evicted_at` and appends
   * `worktree.prepared` with `start_point` for an implementation worktree.
   * Returns the worktree path. Any failure before the write removes what the
   * recreation left at the recorded path, so the next resume starts clean,
   * then refuses with `WORKTREE_UNAVAILABLE` and writes nothing.
   */
  async function restoreEvictedWorktree(
    ctx: RunnerContext,
    recordedPath: string,
    refuse: (code: ResumeErrorCode, message: string) => never,
    log: Logger,
  ): Promise<string> {
    let prepared: PreparedWorktree;
    try {
      if (!ctx.repository) throw new Error("task has no repository");
      const repository = {
        name: ctx.repository.name,
        gitUrl: ctx.repository.gitUrl,
        defaultBranch: ctx.repository.defaultBranch,
        setupCommand: ctx.repository.setupCommand,
      };
      if (ctx.execution.role === "spec") {
        prepared = await deps.worktrees.prepareSpec({
          executionId: ctx.execution.id,
          repository,
          worktreePath: recordedPath,
        });
      } else {
        if (ctx.execution.role !== "implementation" || !ctx.execution.branch) {
          throw new Error(`a ${ctx.execution.role} worktree cannot be recreated`);
        }
        if (!ctx.revision) throw new Error("no approved specification revision");
        prepared = await deps.worktrees.prepareImplementation({
          executionId: ctx.execution.id,
          repository,
          task: {
            id: ctx.task.id,
            jiraKey: ctx.task.jiraKey,
            jiraSummary: ctx.task.jiraSummary,
          },
          spec: {
            version: ctx.revision.version,
            content: SpecContentSchema.parse(ctx.revision.content),
          },
          decisions: ctx.decisions.map((d) => ({
            issue_id: d.issueId,
            decision: d.decision,
            clarification: d.clarification,
            chosen_option: d.chosenOption,
            decided_by: d.decidedBy,
            decided_at: d.decidedAt.toISOString(),
          })),
          reviewCommand: testCommandFor(ctx),
          runtime: ctx.execution.runtime,
          resumeFromRemote: true,
          fallbackToDefaultBranch: true,
          worktreePath: recordedPath,
        });
      }
    } catch (err) {
      if (ctx.repository) {
        // The row keeps `worktree_evicted_at`; the local branch goes too,
        // as eviction left it.
        try {
          await deps.worktrees.remove(recordedPath, {
            repositoryName: ctx.repository.name,
            branch: ctx.execution.role === "implementation" ? ctx.execution.branch : null,
          });
        } catch (removeErr) {
          log.warn(
            { err: errMessage(removeErr) },
            "could not remove the worktree of a failed recreation",
          );
        }
      }
      return refuse(
        "WORKTREE_UNAVAILABLE",
        `evicted worktree could not be recreated: ${setupDetail(err)}`,
      );
    }
    if (prepared.startPoint === "default_branch") {
      log.warn(
        { branch: prepared.branch, startPoint: prepared.startPoint },
        "remote branch missing, evicted worktree recreated from the default branch",
      );
    }
    await db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id, "key share");
      await restoreEvictedWorktreeRow(tx, ctx.execution.id, prepared);
      await appendEvent(tx, {
        taskId: ctx.task.id,
        executionId: ctx.execution.id,
        type: "worktree.prepared",
        payload: {
          worktree_path: prepared.worktreePath,
          branch: prepared.branch,
          ...(prepared.startPoint ? { start_point: prepared.startPoint } : {}),
        },
      });
    });
    return prepared.worktreePath;
  }

  async function resume(input: ResumeInput): Promise<{ done: Promise<void> }> {
    const { executionId } = input;
    const refuse = (code: ResumeErrorCode, message: string): never => {
      throw new ResumeError(code, executionId, message);
    };
    if (closed) refuse("SHUT_DOWN", "runner is shutting down");
    if (live.has(executionId)) refuse("ALREADY_LIVE", "execution is already running here");

    const state = new RunState(executionId);
    live.set(executionId, state);
    const log = logger.child({ executionId });

    let ctx: RunnerContext;
    let adapter: AgentAdapter;
    let sessionId: string;
    let worktreePath: string;
    const baseline: UsageBaseline = {};
    // C21: set when this resume starts a fresh session instead.
    let fresh: FreshSessionReason | null = null;
    let freshSpec: { version: number; content: ReturnType<typeof SpecContentSchema.parse> } | null =
      null;
    /**
     * What a fresh session needs beyond the recorded worktree: the task's
     * repository, the branch and valid spec content at the execution's
     * revision. Checked before any write; a gap refuses NO_SESSION.
     */
    const freshContext = (c: RunnerContext) => {
      if (!c.repository) return refuse("NO_SESSION", "fresh session: task has no repository");
      if (!c.execution.branch) return refuse("NO_SESSION", "fresh session: execution has no branch");
      if (!c.revision) {
        return refuse("NO_SESSION", "fresh session: no approved specification revision");
      }
      const parsed = SpecContentSchema.safeParse(c.revision.content);
      if (!parsed.success) {
        return refuse("NO_SESSION", "fresh session: specification revision is not valid spec content");
      }
      return { version: c.revision.version, content: parsed.data };
    };
    try {
      const loaded = await loadRunnerContext(db, executionId);
      if (!loaded) return refuse("NOT_FOUND", "execution not found");
      ctx = loaded;
      const { execution } = ctx;
      const spec = execution.role === "spec";
      // GOT.37 C42: a spec execution is RUNNING between turns.
      const resumable =
        execution.state === "WAITING_FOR_USER" ||
        execution.state === "COMPLETED" ||
        (spec && execution.state === "RUNNING");
      if (!resumable) {
        refuse("NOT_RESUMABLE_STATE", `execution is ${execution.state}`);
      }
      if (input.expectedState !== undefined && execution.state !== input.expectedState) {
        refuse(
          "NOT_RESUMABLE_STATE",
          `execution is ${execution.state}, expected ${input.expectedState}`,
        );
      }
      // C41: before approval a spec task may have no repository.
      if (spec && ctx.repository === null) {
        ctx = { ...ctx, repository: await resolveSpecRepository(db, ctx.task.id) };
      }
      // §10.4: the resume runs against the newly approved revision.
      if (input.specRevisionId !== undefined) {
        const revision = await getSpecRevisionById(db, input.specRevisionId);
        if (!revision || revision.taskId !== ctx.task.id) {
          return refuse("NOT_FOUND", "specification revision not found on the task");
        }
        ctx = { ...ctx, revision };
      }
      const canFallBack =
        input.freshPrompt !== undefined && execution.role === "implementation";
      if (execution.host !== host) {
        // C21: released from a dead host, so no worker holds the session.
        if (execution.host !== null || !canFallBack) {
          refuse("OTHER_HOST", "execution is pinned to another host");
        }
        fresh = "host_released";
      }
      if (!execution.sessionId || !execution.worktreePath) {
        refuse("NO_SESSION", "execution has no session or worktree");
      }
      sessionId = execution.sessionId!;
      worktreePath = execution.worktreePath!;
      const found = deps.adapters[execution.runtime];
      if (!found) return refuse("NO_ADAPTER", `${execution.runtime} adapter not available`);
      adapter = found;

      let expectedWorkerId = execution.workerId;
      if (fresh !== null) {
        freshSpec = freshContext(ctx);
        // C21: pin here before touching the worktree, so two workers
        // handling commands for the same released execution never both
        // take it over. No adapter or git call under the lock.
        await db.transaction(async (tx) => {
          await lockTaskForTool(tx, ctx.task.id);
          const row = await lockExecutionForTool(tx, executionId);
          if (row?.state !== execution.state) {
            refuse("NOT_RESUMABLE_STATE", `execution is ${row?.state ?? "gone"}`);
          }
          const pinned = (await loadRunnerContext(tx, executionId))?.execution;
          if (pinned?.host != null) {
            refuse("OTHER_HOST", "execution was pinned to a host since the context loaded");
          }
          await pinExecutionToHost(tx, executionId, { workerId, host });
        });
        expectedWorkerId = workerId;
        log.info({ reason: fresh }, "released execution pinned to this host for a fresh session");
      }

      if (execution.worktreeEvictedAt !== null) {
        worktreePath = await restoreEvictedWorktree(ctx, worktreePath, refuse, log);
      }
      if (fresh === null && !(await adapter.canResume(sessionId, worktreePath))) {
        if (!canFallBack) refuse("CANNOT_RESUME", "session cannot be resumed");
        freshSpec = freshContext(ctx);
        fresh = "cannot_resume";
      }
      // C21: the recorded worktree lives on the dead host, or is gone here.
      if (fresh !== null && !(await pathExists(worktreePath))) {
        worktreePath = await restoreEvictedWorktree(ctx, worktreePath, refuse, log);
      }

      // C53: `orchestra-review` reads the spec from the worktree's
      // context.json, so it moves to the new revision with the execution.
      // Written before the resume transaction, outside any row lock.
      if (input.specRevisionId !== undefined && deps.worktrees.writeContext) {
        try {
          const revision = ctx.revision!;
          const repository = ctx.repository;
          if (!repository) throw new Error("task has no repository");
          await deps.worktrees.writeContext(worktreePath, {
            task: {
              id: ctx.task.id,
              jira_key: ctx.task.jiraKey,
              jira_summary: ctx.task.jiraSummary,
            },
            spec: {
              version: revision.version,
              content: SpecContentSchema.parse(revision.content),
            },
            decisions: ctx.decisions.map((d) => ({
              issue_id: d.issueId,
              decision: d.decision,
              clarification: d.clarification,
              chosen_option: d.chosenOption,
              decided_by: d.decidedBy,
              decided_at: d.decidedAt.toISOString(),
            })),
            repository: {
              name: repository.name,
              default_branch: repository.defaultBranch,
              branch: ctx.execution.branch ?? "",
            },
            runtime: ctx.execution.runtime,
            review_command: testCommandFor(ctx),
          });
        } catch (err) {
          refuse(
            "WORKTREE_UNAVAILABLE",
            `context.json could not be rewritten for the new revision: ${errMessage(err)}`,
          );
        }
      }

      if (fresh === null) {
        for (const row of await sumSessionUsageByModel(db, executionId)) {
          baseline[row.model] = {
            input: row.inputTokens,
            cached: row.cachedInputTokens,
            output: row.outputTokens,
            costUsd: row.costUsd,
          };
        }
      }

      const resumedPayload: Record<string, unknown> = {
        ...input.resumedPayload,
        ...(fresh !== null ? { fresh_session: true, reason: fresh } : {}),
      };
      await db.transaction(async (tx) => {
        await lockTaskForTool(tx, ctx.task.id);
        const row = await lockExecutionForTool(tx, executionId);
        if (row?.state !== execution.state) {
          refuse("NOT_RESUMABLE_STATE", `execution is ${row?.state ?? "gone"}`);
        }
        // §6.1: the dead-host release may have cleared the pin since the
        // context loaded. Re-read it under the execution lock.
        const pinned = (await loadRunnerContext(tx, executionId))?.execution;
        if (pinned?.host !== host || pinned.workerId !== expectedWorkerId) {
          refuse("OTHER_HOST", "execution is no longer pinned to this host");
        }
        // §6.6: the worktree sweeper may have evicted it since then.
        if (pinned?.worktreeEvictedAt != null) {
          refuse("WORKTREE_UNAVAILABLE", "worktree was evicted after the context loaded");
        }
        // GOT.37: a spec chat turn or a send-back only while the user is
        // drafting. Request-review or cancel may have moved the task since.
        if (spec && execution.state !== "WAITING_FOR_USER") {
          const taskState = await getTaskState(tx, ctx.task.id);
          if (taskState !== "SPEC_IN_PROGRESS") {
            refuse("NOT_RESUMABLE_STATE", `task is ${taskState ?? "gone"}, not SPEC_IN_PROGRESS`);
          }
        }
        // F1: a send-back never resumes a second spec session. A restart
        // (C49) may already have started a new one for the task.
        if (spec && execution.state === "COMPLETED" && (await hasLiveSpecExecution(tx, ctx.task.id))) {
          refuse("NOT_RESUMABLE_STATE", "task already has another live spec execution");
        }
        // C42: a RUNNING spec execution resumes in place, no transition.
        if (execution.state !== "RUNNING") {
          const moved = await transition(tx, {
            entity: "execution",
            id: executionId,
            // §5.2: COMPLETED -> RUNNING is the CI back edge for an
            // implementation, and the send-back edge for a spec (C45).
            trigger:
              execution.state === "COMPLETED" && !spec
                ? "resume_with_ci_failure"
                : "execution.resumed",
            actor: worker,
            set: {
              endedAt: null,
              ...(input.specRevisionId !== undefined
                ? { specRevisionId: input.specRevisionId }
                : {}),
            },
          });
          // §10.4: the old revision stays in the event payload.
          const extra: Record<string, unknown> = {
            ...resumedPayload,
            ...(input.specRevisionId !== undefined
              ? {
                  previous_spec_revision_id: pinned?.specRevisionId ?? null,
                  spec_revision_id: input.specRevisionId,
                }
              : {}),
          };
          if (Object.keys(extra).length > 0) {
            await mergeExecutionEventPayload(tx, moved.eventId, extra);
          }
        }
        // A paused execution's lease was not renewed. Renew it with the move
        // to RUNNING, so the sweeper never sees the resumed run stale.
        if (execution.role === "implementation") {
          await renewExecutionLease(tx, executionId, now());
        }
      });
    } catch (err) {
      if (live.get(executionId) === state) live.delete(executionId);
      throw err;
    }

    const role = ctx.execution.role as ToolPolicy;
    const testCommand = testCommandFor(ctx);
    const turnOptions: TurnOptions = { conversationTurn: input.conversationTurn };
    if (fresh !== null) {
      // C21, D5: a new session seeded with the full user prompt, the resume
      // header as its pending prompt.
      const spec = freshSpec!;
      const cwd = worktreePath;
      const buildPrompt = input.freshPrompt!;
      log.info({ reason: fresh }, "resume starts a fresh session");
      const done = track(state, log, () =>
        withLease(state, ctx, log, false, async () => {
          const noMistakes = await pathExists(path.join(cwd, NO_MISTAKES_MARKER));
          const prompt = buildPrompt(
            await implementationUserPrompt(ctx, spec, ctx.execution.branch, log),
          );
          await runSession(
            state,
            ctx,
            input.usageKind ?? "resume",
            log,
            (token, signal) =>
              adapter.start(
                {
                  cwd,
                  systemPrompt: systemPromptFor("implementation", { noMistakes }),
                  prompt,
                  model: modelFor(ctx),
                  allowedTools: "implementation",
                  mcp: { url: deps.toolsUrl(), token },
                  env: agentEnv(token),
                  ...(testCommand ? { testCommand } : {}),
                },
                signal,
              ),
            { ...turnOptions, replaceSession: true },
          );
        }),
      );
      return { done };
    }
    const done = track(state, log, () =>
      // The resume transaction already renewed the lease.
      withLease(state, ctx, log, false, () =>
        runSession(
          state,
          ctx,
          input.usageKind ?? "resume",
          log,
          (token, signal) =>
            adapter.resume(
              {
                cwd: worktreePath,
                prompt: input.prompt,
                model: modelFor(ctx),
                allowedTools: role,
                mcp: { url: deps.toolsUrl(), token },
                env: agentEnv(token),
                sessionId,
                usageBaseline: baseline,
                ...(testCommand ? { testCommand } : {}),
              },
              signal,
            ),
          turnOptions,
        ),
      ),
    );
    return { done };
  }

  // -------------------------------------------------------------- control

  return {
    onClaimed: (claim) => {
      void start(claim);
    },
    start,
    startSpec,
    resume,
    abort(executionId) {
      const state = live.get(executionId);
      if (!state) return false;
      state.stop("cancelled");
      return true;
    },
    isLive: (executionId) => live.has(executionId),
    async shutdown(timeoutMs = DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS) {
      closed = true;
      const runs = [...live.values()];
      for (const run of runs) run.stop("shutdown");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(runs.map((run) => run.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
