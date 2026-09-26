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
  type ExecutionEventType,
  type Runtime,
  type UsageKind,
} from "@orchestra/core";
import {
  DEFAULT_EXECUTION_MODEL,
  addExecutionUsageTotals,
  appendEvent,
  insertExecutionUsage,
  loadRunnerContext,
  lockExecutionForTool,
  lockTaskForTool,
  markExecutionEnded,
  restoreEvictedWorktree as restoreEvictedWorktreeRow,
  setExecutionPlacement,
  setExecutionWorktree,
  sumSessionUsageByModel,
  transition,
  type Db,
  type RunnerContext,
} from "@orchestra/db";
import {
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
    /** Resume removes a worktree whose recreation failed part way (§6.6). */
    remove(executionId: string, options: RemoveOptions): Promise<RemoveResult>;
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
 * recreated after eviction is recorded before any later refusal.
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
}

export interface Runner {
  /** Scheduler hand-off (§6.3). Never blocks the tick. */
  readonly onClaimed: OnClaimed;
  /** Runs a claimed execution. Resolves when the run ends; never rejects. */
  start(claim: ClaimedExecution): Promise<void>;
  /**
   * Resumes a WAITING_FOR_USER or COMPLETED execution on this host. Resolves
   * once it is RUNNING; `done` resolves when the turn has been handled.
   * An evicted worktree is first recreated from the remote branch (§6.6).
   * Rejects with `ResumeError` without writing anything otherwise, except
   * that a recreated worktree stays recorded.
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

  /** Event-only write: task, then execution, KEY SHARE (as agent-tools does). */
  async function appendRunEvent(
    ctx: RunnerContext,
    type: ExecutionEventType,
    payload: unknown,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await lockTaskForTool(tx, ctx.task.id, "key share");
      await lockExecutionForTool(tx, ctx.execution.id, "key share");
      await appendEvent(tx, {
        taskId: ctx.task.id,
        executionId: ctx.execution.id,
        type,
        payload,
      });
    });
  }

  /**
   * Ends the execution FAILED (`ASSIGNED` or `RUNNING` only). Any other
   * state was set by a tool or the api and is left alone. The task is not
   * touched (Q10); the retry policy is GOT.43's.
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
      await transition(tx, {
        entity: "execution",
        id: ctx.execution.id,
        trigger: "execution.failed",
        actor: worker,
        set: { endReason, endDetail, endedAt: now() },
      });
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
  ): Promise<void> {
    const executionId = ctx.execution.id;
    const writes = createWriteQueue(log);
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
      const token = await issueToken(db, executionId);
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
          appendRunEvent(ctx, "agent.message.delta", { text }),
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
              onSession(state, ctx, event.sessionId, log),
            );
          } else if (event.type === "text") {
            buffer += event.delta;
            turnText += event.delta;
            if (!flushTimer) flushTimer = after(timings.flushMs, () => void flush());
          } else if (event.type === "tool_call") {
            if (!event.name.startsWith(ORCHESTRA_TOOL_PREFIX)) {
              const payload = redact({ name: event.name, input: event.input });
              await writes.push("agent.tool_call", () =>
                appendRunEvent(ctx, "agent.tool_call", payload),
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
          appendRunEvent(ctx, "agent.message", { text }),
        );
      }
      await writes.drain();

      await afterTurn(ctx, entry, end, log);
    } finally {
      cancel(quietTimer);
      cancel(flushTimer);
      cancel(blockingTimer);
      for (const t of timeouts) clearTimeout(t);
      for (const i of intervals) clearInterval(i);
      await writes.drain();
    }
  }

  /** `session` event: store the id and move ASSIGNED -> RUNNING (§9.3). */
  async function onSession(
    state: RunState,
    ctx: RunnerContext,
    sessionId: string,
    log: Logger,
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
      return row.state === "RUNNING" ? ("running" as const) : ("gone" as const);
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

  /** §9.3 after the loop, §8 blocking handling, §9.4 liveness. */
  async function afterTurn(
    ctx: RunnerContext,
    entry: LiveExecution,
    end: TurnEnd,
    log: Logger,
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
      if (entry.blockingPending && row.state === "RUNNING") {
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
      await transition(tx, {
        entity: "execution",
        id: ctx.execution.id,
        trigger: "execution.failed",
        actor: worker,
        set: {
          endReason: "protocol_violation",
          endDetail: PROTOCOL_VIOLATION_DETAIL,
          endedAt: now(),
        },
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

  async function startBody(
    state: RunState,
    claim: ClaimedExecution,
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
    // Renewal covers worktree preparation too: a slow fetch or setup_command
    // must not let the lease expire (§6.4, §6.5).
    await withLease(state, ctx, log, true, () => prepareAndRun(state, ctx, log));
  }

  async function prepareAndRun(
    state: RunState,
    ctx: RunnerContext,
    log: Logger,
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
      });
    } catch (err) {
      log.warn({ err: errMessage(err) }, "worktree preparation failed");
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

    const noMistakes = await pathExists(
      path.join(prepared.worktreePath, NO_MISTAKES_MARKER),
    );
    const systemPrompt = systemPromptFor("implementation", { noMistakes });
    const prompt = buildUserPrompt({
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
        workingBranch: prepared.branch,
        setupCommand: ctx.repository!.setupCommand,
        testCommand,
      },
    });

    if (state.stopReason !== null) return;
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

  function start(claim: ClaimedExecution): Promise<void> {
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
    return track(state, log, () => startBody(state, claim, log));
  }

  // ---------------------------------------------------------------- resume

  /**
   * §6.6: the sweeper evicted this execution's worktree. Recreates it at the
   * same `work/<executionId>` path: a spec worktree detached at
   * `origin/<default_branch>` (§9.1); an implementation worktree from
   * `origin/<branch>`, or from `origin/<default_branch>` on the same branch
   * name when the remote lacks it (the sweeper pushes a branch that is
   * ahead, so nothing was left to push); that fallback is logged as a
   * warning. Then records the path, clears `worktree_evicted_at` and appends
   * `worktree.prepared` with `start_point` for an implementation worktree.
   * Returns the worktree path. Any failure before the write removes what the
   * recreation left at `work/<executionId>`, so the next resume starts
   * clean, then refuses with `WORKTREE_UNAVAILABLE` and writes nothing.
   */
  async function restoreEvictedWorktree(
    ctx: RunnerContext,
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
        });
      }
    } catch (err) {
      if (ctx.repository) {
        // The row keeps `worktree_evicted_at`; the local branch goes too,
        // as eviction left it.
        try {
          await deps.worktrees.remove(ctx.execution.id, {
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
    let baseline: UsageBaseline;
    try {
      const loaded = await loadRunnerContext(db, executionId);
      if (!loaded) return refuse("NOT_FOUND", "execution not found");
      ctx = loaded;
      const { execution } = ctx;
      if (execution.state !== "WAITING_FOR_USER" && execution.state !== "COMPLETED") {
        refuse("NOT_RESUMABLE_STATE", `execution is ${execution.state}`);
      }
      if (execution.host !== host) refuse("OTHER_HOST", "execution is pinned to another host");
      if (!execution.sessionId || !execution.worktreePath) {
        refuse("NO_SESSION", "execution has no session or worktree");
      }
      sessionId = execution.sessionId!;
      worktreePath = execution.worktreePath!;
      const found = deps.adapters[execution.runtime];
      if (!found) return refuse("NO_ADAPTER", `${execution.runtime} adapter not available`);
      adapter = found;
      if (execution.worktreeEvictedAt !== null) {
        worktreePath = await restoreEvictedWorktree(ctx, refuse, log);
      }
      if (!(await adapter.canResume(sessionId, worktreePath))) {
        refuse("CANNOT_RESUME", "session cannot be resumed");
      }

      baseline = {};
      for (const row of await sumSessionUsageByModel(db, executionId)) {
        baseline[row.model] = {
          input: row.inputTokens,
          cached: row.cachedInputTokens,
          output: row.outputTokens,
          costUsd: row.costUsd,
        };
      }

      await db.transaction(async (tx) => {
        await lockTaskForTool(tx, ctx.task.id);
        const row = await lockExecutionForTool(tx, executionId);
        if (row?.state !== execution.state) {
          refuse("NOT_RESUMABLE_STATE", `execution is ${row?.state ?? "gone"}`);
        }
        // §6.1: the dead-host release may have cleared the pin since the
        // context loaded. Re-read it under the execution lock.
        const pinned = (await loadRunnerContext(tx, executionId))?.execution;
        if (pinned?.host !== host || pinned.workerId !== execution.workerId) {
          refuse("OTHER_HOST", "execution is no longer pinned to this host");
        }
        // §6.6: the worktree sweeper may have evicted it since then.
        if (pinned?.worktreeEvictedAt != null) {
          refuse("WORKTREE_UNAVAILABLE", "worktree was evicted after the context loaded");
        }
        await transition(tx, {
          entity: "execution",
          id: executionId,
          // §5.2: COMPLETED -> RUNNING is the CI back edge.
          trigger:
            execution.state === "COMPLETED"
              ? "resume_with_ci_failure"
              : "execution.resumed",
          actor: worker,
          set: { endedAt: null },
        });
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
    const done = track(state, log, () =>
      // The resume transaction already renewed the lease.
      withLease(state, ctx, log, false, () =>
        runSession(state, ctx, input.usageKind ?? "resume", log, (token, signal) =>
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
