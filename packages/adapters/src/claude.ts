import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  allowedToolsFor,
  builtinToolsFor,
  InvalidTestCommandError,
  permissionModeFor,
  settingSourcesFor,
} from "./policies.js";
import { classifyRetriable } from "./retriable.js";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
  UsageBaseline,
} from "./types.js";

/**
 * Claude adapter (design.md §7.1). Wraps `@anthropic-ai/claude-agent-sdk`
 * and translates its message stream into `AgentEvent`s. It yields events and
 * nothing else: persistence, cost rows and state transitions belong to the
 * worker (design.md §3, §9).
 */

/**
 * The slice of the SDK's `query` this adapter uses. Narrower than
 * `typeof query` — the returned `Query` object's control methods are not
 * needed — so a test can substitute a scripted async generator.
 */
export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface ClaudeAdapterOptions {
  /** Injected `query` implementation. Defaults to the SDK's. */
  query?: ClaudeQueryFn;
  /**
   * Directory holding the SDK's per-project session stores, i.e. the
   * `projects` directory under `CLAUDE_CONFIG_DIR` (default `~/.claude`).
   * Injectable so `canResume` can be tested without a real session.
   */
  sessionRoot?: string;
}

/** Model reported on a usage event when the session never announced one. */
const UNKNOWN_MODEL = "unknown";

/** Message used when a thrown value carries no usable text at all. */
const UNKNOWN_ERROR = "unknown adapter error";

/** Replacement for the execution token in anything the adapter emits. */
const REDACTED = "[redacted]";

/**
 * Session ids are SDK-minted uuids. Anything else is rejected before it
 * reaches `join`, so `canResume` cannot be walked out of its root.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Default location of the SDK's session stores. */
export function defaultSessionRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

/**
 * Encodes a working directory the way the Claude session store names its
 * per-project directory: every character outside `[a-zA-Z0-9]` becomes `-`.
 *
 * Known limitation: the store truncates names longer than 200 characters and
 * appends a hash of the original path. That case is not reproduced here, so
 * `canResume` reports false for such a cwd and the runner starts a fresh
 * session instead of resuming.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export class ClaudeAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;

  readonly #query: ClaudeQueryFn;
  readonly #sessionRoot: string;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#query = options.query ?? sdkQuery;
    this.#sessionRoot = options.sessionRoot ?? defaultSessionRoot();
  }

  start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const redact = redactorFor(req.mcp.token);
    let options: Options;
    try {
      options = { ...baseOptions(req), systemPrompt: req.systemPrompt };
    } catch (error) {
      if (error instanceof InvalidTestCommandError) {
        return invalidTestCommandStream(error, redact);
      }
      throw error;
    }
    return runQuery(
      this.#query,
      req.prompt,
      options,
      signal,
      // A fresh session has no earlier turns, so the runtime's cumulative
      // totals are already this session's totals.
      { redact },
    );
  }

  resume(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const redact = redactorFor(req.mcp.token);
    let options: Options;
    try {
      options = { ...baseOptions(req), resume: req.sessionId };
    } catch (error) {
      if (error instanceof InvalidTestCommandError) {
        return invalidTestCommandStream(error, redact);
      }
      throw error;
    }
    const run: RunConfig = { redact };
    if (req.usageBaseline) run.usageBaseline = req.usageBaseline;
    return runQuery(this.#query, req.prompt, options, signal, run);
  }

  /**
   * Whether the SDK still has this session's transcript on disk for `cwd`.
   * Never throws: a missing file, a missing project directory and a missing
   * root all mean "start fresh" (design.md §9.5).
   *
   * The session store keys on the cwd the CLI resolved, which is the real
   * path — a worktree reached through a symlinked `workspace_root` is stored
   * under the target, not the link. Both spellings are checked so a resumable
   * session is not thrown away.
   */
  async canResume(sessionId: string, cwd: string): Promise<boolean> {
    if (!SESSION_ID_PATTERN.test(sessionId)) return false;

    const candidates = new Set<string>([cwd]);
    try {
      candidates.add(await realpath(cwd));
    } catch {
      // The worktree may already be evicted (design.md §6.6); the raw path
      // is still worth checking.
    }

    for (const candidate of candidates) {
      try {
        const transcript = join(
          this.#sessionRoot,
          encodeProjectDir(candidate),
          `${sessionId}.jsonl`,
        );
        if ((await stat(transcript)).isFile()) return true;
      } catch {
        // Not under this spelling of the path.
      }
    }
    return false;
  }
}

/**
 * Options shared by start and resume. Optional request fields are omitted
 * rather than set to `undefined` so the SDK sees exactly what was asked for,
 * and so `resume` provably carries no `systemPrompt` key.
 */
function baseOptions(req: StartRequest | ResumeRequest): Options {
  const policy = req.allowedTools;
  const permissionMode = permissionModeFor(policy);
  // `testCommand` is an optional extension of §7 (design.md §7.1); only the
  // `review` policy uses it, so `allowedToolsFor`/`builtinToolsFor` ignore it
  // for `spec` and `implementation`.
  const policyOpts = { testCommand: req.testCommand };
  const options: Options = {
    cwd: req.cwd,
    // design.md §7.1. The tool allow list, not a prompt, is the boundary, so
    // the read-only roles run under `dontAsk`: unlisted tools are denied
    // rather than auto-approved, and `tools` keeps them out of the session
    // altogether.
    allowedTools: allowedToolsFor(policy, policyOpts),
    // sdk.d.ts ~2245: omitted loads user, project and local
    // `.claude/settings*.json` from the target repository, so its own
    // `permissions.allow` could re-grant a read-only or unrestricted-Bash
    // role tools this adapter deliberately withholds.
    settingSources: settingSourcesFor(policy),
    mcpServers: {
      orchestra: {
        type: "http",
        url: req.mcp.url,
        headers: { Authorization: `Bearer ${req.mcp.token}` },
      },
    },
    permissionMode,
    // `Options.env` REPLACES the subprocess environment rather than merging
    // it (sdk.d.ts), so the inherited environment is spread first: without it
    // the CLI subprocess loses PATH, HOME and its credentials.
    env: { ...process.env, ...req.env },
  };
  const tools = builtinToolsFor(policy, policyOpts);
  if (tools !== undefined) options.tools = tools;
  // The SDK ignores `bypassPermissions` unless this companion flag is set.
  if (permissionMode === "bypassPermissions") {
    options.allowDangerouslySkipPermissions = true;
  }
  if (req.model !== undefined) options.model = req.model;
  if (req.maxBudgetUsd !== undefined) options.maxBudgetUsd = req.maxBudgetUsd;
  return options;
}

/**
 * Terminal stream for a request whose `testCommand` failed validation (F1,
 * design.md §7.1, §9.5). Non-retriable: the value is wrong, not transient,
 * so retrying the same request produces the same rejection. `query` is never
 * called — the invalid value never reaches a permission rule at all.
 */
async function* invalidTestCommandStream(
  error: InvalidTestCommandError,
  redact: (text: string) => string,
): AsyncGenerator<AgentEvent> {
  yield { type: "error", message: redact(error.message), retriable: false };
}

/** Per-run concerns that are not SDK options. */
interface RunConfig {
  /** Strips the execution token out of anything the adapter emits. */
  redact: (text: string) => string;
  /** Usage already reported for a resumed session (design.md §9.7). */
  usageBaseline?: UsageBaseline;
}

/**
 * Drives one `query` call to completion.
 *
 * Abort contract (design.md §7): when `signal` fires, the SDK query is
 * aborted through its own `abortController` and the iterator ends quietly.
 * An abort is never reported as an `error` event, because it is a cancel, not
 * a failure. A signal already aborted before the first `next()` never starts
 * a query at all.
 */
async function* runQuery(
  queryFn: ClaudeQueryFn,
  prompt: string,
  options: Options,
  signal: AbortSignal,
  run: RunConfig,
): AsyncGenerator<AgentEvent> {
  if (signal.aborted) return;

  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const context: StreamContext = {
    toolNames: new Map(),
    model: undefined,
    unbilled: remainingBaseline(run.usageBaseline),
  };

  try {
    const stream = queryFn({
      prompt,
      options: { ...options, abortController: controller },
    });
    for await (const message of stream) {
      if (signal.aborted) return;
      for (const event of mapMessage(message, context)) {
        yield redactEvent(event, run.redact);
        if (signal.aborted) return;
      }
    }
  } catch (error) {
    // An abort unwinds the SDK by throwing. That is the cancel path, not a
    // failure, so the iterator just ends.
    if (signal.aborted || controller.signal.aborted) return;
    const message = run.redact(errorText(error));
    yield { type: "error", message, retriable: classifyRetriable(message) };
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!controller.signal.aborted) controller.abort();
  }
}

/** Mutable, per-model remainder of a baseline not yet subtracted. */
interface RemainingModelBaseline {
  input: number;
  cached: number;
  output: number;
}

/** Mutable baseline remainder for the whole run: per-model plus the cost pool. */
interface RemainingBaseline {
  perModel: Record<string, RemainingModelBaseline>;
  /** Sum of every model's baseline `costUsd`, consumed against the single
   * session-wide cost delta as it is attributed to one event. */
  cost: number;
}

interface StreamContext {
  /** tool_use id → tool name, so a tool_result can report the name (§7.1). */
  toolNames: Map<string, string>;
  /** Model announced by the `system` init, used when `modelUsage` is absent. */
  model: string | undefined;
  /**
   * Usage already billed for this session and not yet subtracted from the
   * runtime's cumulative totals, keyed per model. Consumed as usage events
   * are emitted, so a turn reports only what it added. `undefined` means
   * "emit as reported"; a model with no entry is emitted unchanged.
   */
  unbilled: RemainingBaseline | undefined;
}

function* mapMessage(
  message: SDKMessage,
  context: StreamContext,
): Generator<AgentEvent> {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        context.model = message.model;
        yield { type: "session", sessionId: message.session_id };
      }
      return;
    case "assistant":
      for (const block of contentBlocks(message.message)) {
        if (isTextBlock(block)) {
          yield { type: "text", delta: block.text };
        } else if (isToolUseBlock(block)) {
          context.toolNames.set(block.id, block.name);
          yield { type: "tool_call", name: block.name, input: block.input };
        }
      }
      return;
    case "user":
      for (const block of contentBlocks(message.message)) {
        if (!isToolResultBlock(block)) continue;
        yield {
          type: "tool_result",
          // The SDK does not repeat the tool name on the result, so it comes
          // from the tool_use that opened it. An unmatched id (a resumed
          // session whose tool_use landed in an earlier turn) reports the id.
          name: context.toolNames.get(block.tool_use_id) ?? block.tool_use_id,
          ok: block.is_error !== true,
        };
      }
      return;
    case "result":
      yield* mapResult(message, context);
      return;
    default:
      // Partial messages, status, hook and notification frames carry nothing
      // the orchestration layer records.
      return;
  }
}

/**
 * `result` closes a turn (design.md §7.1, §9.7): usage first so cost is
 * captured even for a failed turn, then either `turn_done` or `error`.
 */
function* mapResult(
  message: SDKResultMessage,
  context: StreamContext,
): Generator<AgentEvent> {
  for (const event of usageEvents(message, context.model)) {
    yield chargeAgainstBaseline(event, context);
  }

  if (message.subtype !== "success" || message.is_error) {
    const text = resultErrorText(message);
    yield { type: "error", message: text, retriable: classifyRetriable(text) };
    return;
  }

  yield { type: "turn_done", finalText: message.result };
}

type UsageEvent = Extract<AgentEvent, { type: "usage" }>;

/**
 * One usage event per model in `modelUsage`, which the SDK documents as the
 * correct field for token accounting. `total_cost_usd` is the whole query's
 * cost, so it is attributed to exactly one event; summing `costUsd` across a
 * turn therefore does not double count.
 *
 * `cached` carries cache *reads* only. Cache-creation tokens are priced
 * differently and the §7 event has no field for them.
 */
function* usageEvents(
  message: SDKResultMessage,
  fallbackModel: string | undefined,
): Generator<UsageEvent> {
  const perModel = Object.entries(message.modelUsage ?? {});
  const totalCostUsd = message.total_cost_usd;

  if (perModel.length > 0) {
    let costAttributed = false;
    for (const [model, usage] of perModel) {
      const event: UsageEvent = {
        type: "usage",
        model,
        input: usage.inputTokens ?? 0,
        cached: usage.cacheReadInputTokens ?? 0,
        output: usage.outputTokens ?? 0,
      };
      if (!costAttributed && typeof totalCostUsd === "number") {
        event.costUsd = totalCostUsd;
        costAttributed = true;
      }
      yield event;
    }
    return;
  }

  const usage = message.usage;
  if (!usage) return;
  const event: UsageEvent = {
    type: "usage",
    model: fallbackModel ?? UNKNOWN_MODEL,
    input: usage.input_tokens ?? 0,
    cached: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
  if (typeof totalCostUsd === "number") event.costUsd = totalCostUsd;
  yield event;
}

/**
 * Copies the baseline into a mutable per-run remainder, floored at zero per
 * field so a bad baseline cannot inflate a turn. The per-model subtraction
 * never mutates the caller's `UsageBaseline`.
 */
function remainingBaseline(
  baseline: UsageBaseline | undefined,
): RemainingBaseline | undefined {
  if (!baseline) return undefined;
  const perModel: Record<string, RemainingModelBaseline> = {};
  let cost = 0;
  for (const [model, modelBaseline] of Object.entries(baseline)) {
    perModel[model] = {
      input: Math.max(0, modelBaseline.input),
      cached: Math.max(0, modelBaseline.cached),
      output: Math.max(0, modelBaseline.output),
    };
    cost += Math.max(0, modelBaseline.costUsd ?? 0);
  }
  return { perModel, cost: Math.max(0, cost) };
}

/**
 * Subtracts what the session already reported from one usage event.
 *
 * The runtime reports session totals, not turn totals, so a resumed session
 * re-reports every earlier turn, and a multi-model turn reports one set of
 * totals per model. Token counts are matched and subtracted per model — a
 * model absent from the baseline is emitted unchanged — while `costUsd` is a
 * single session-wide number (`total_cost_usd` minus the sum of every
 * model's baseline `costUsd`), consumed from one shared pool so it is
 * subtracted only once, on whichever event carries it.
 */
function chargeAgainstBaseline(
  event: UsageEvent,
  context: StreamContext,
): UsageEvent {
  const remaining = context.unbilled;
  if (!remaining) return event;

  const modelBaseline = remaining.perModel[event.model];
  const charged: UsageEvent = modelBaseline
    ? {
        ...event,
        input: consume(modelBaseline, "input", event.input),
        cached: consume(modelBaseline, "cached", event.cached),
        output: consume(modelBaseline, "output", event.output),
      }
    : { ...event };
  if (event.costUsd !== undefined) {
    charged.costUsd = consumeCost(remaining, event.costUsd);
  }
  return charged;
}

/** Spends as much of `remaining[field]` as `value` covers, returns the rest. */
function consume(
  remaining: RemainingModelBaseline,
  field: keyof RemainingModelBaseline,
  value: number,
): number {
  const spent = Math.min(remaining[field], value);
  remaining[field] -= spent;
  return value - spent;
}

/** Spends as much of the shared cost pool as `value` covers, returns the rest. */
function consumeCost(remaining: RemainingBaseline, value: number): number {
  const spent = Math.min(remaining.cost, value);
  remaining.cost -= spent;
  return value - spent;
}

/**
 * Removes the execution token (design.md §8) from everything the adapter
 * emits. The token authorises the agent-tools MCP server, and a tool call or
 * a failure message can quote it back — a `curl` with the Authorization
 * header, a 401 body. Events are persisted and shown in the UI, so the
 * redaction happens before they leave the adapter.
 */
function redactorFor(token: string): (text: string) => string {
  if (token === "") return (text) => text;
  return (text) => text.split(token).join(REDACTED);
}

function redactEvent(
  event: AgentEvent,
  redact: (text: string) => string,
): AgentEvent {
  switch (event.type) {
    case "text":
      return { ...event, delta: redact(event.delta) };
    case "turn_done":
      return { ...event, finalText: redact(event.finalText) };
    case "error":
      return { ...event, message: redact(event.message) };
    case "tool_call":
      return { ...event, input: redactInput(event.input, redact) };
    default:
      return event;
  }
}

/**
 * Redacts a tool input of unknown shape. Serialising and re-parsing reaches
 * nested values without walking arbitrary structures; `[redacted]` needs no
 * JSON escaping, so the round trip stays valid. Anything that will not
 * serialise is passed through untouched rather than dropped.
 */
function redactInput(input: unknown, redact: (text: string) => string): unknown {
  if (typeof input === "string") return redact(input);
  if (input === null || typeof input !== "object") return input;
  try {
    const json = JSON.stringify(input);
    if (typeof json !== "string") return input;
    const cleaned = redact(json);
    return cleaned === json ? input : (JSON.parse(cleaned) as unknown);
  } catch {
    return input;
  }
}

function resultErrorText(message: SDKResultMessage): string {
  const parts: string[] = [message.subtype];
  const errors = "errors" in message ? message.errors : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    parts.push(errors.join("; "));
  } else if (
    message.subtype === "success" &&
    typeof message.result === "string" &&
    message.result.length > 0
  ) {
    parts.push(message.result);
  }
  return parts.join(": ");
}

/**
 * Failure text for anything a runtime can throw.
 *
 * The result is always a non-empty string: it feeds `classifyRetriable` and is
 * persisted as the execution's failure reason, so `undefined` (from
 * `JSON.stringify(undefined)`) or a throw on a circular object would lose the
 * failure entirely.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;

  let text = "";
  try {
    text = JSON.stringify(error) ?? "";
  } catch {
    // Circular or a value with a throwing `toJSON`.
  }
  if (text === "" || text === "{}") {
    try {
      text = String(error);
    } catch {
      text = "";
    }
  }
  return text === "" ? UNKNOWN_ERROR : text;
}

interface TextBlock {
  type: "text";
  text: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
}

/**
 * Content blocks are narrowed structurally rather than through the Anthropic
 * SDK's beta message types, so this package does not depend on that surface.
 */
function contentBlocks(message: { content?: unknown }): unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

function blockType(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const type = (block as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    blockType(block) === "text" &&
    typeof (block as TextBlock).text === "string"
  );
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  if (blockType(block) !== "tool_use") return false;
  const candidate = block as ToolUseBlock;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  return (
    blockType(block) === "tool_result" &&
    typeof (block as ToolResultBlock).tool_use_id === "string"
  );
}
