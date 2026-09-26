import { spawn as spawnProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { codexSandboxFor, ORCHESTRA_MCP_SERVER } from "./policies.js";
import { classifyRetriable } from "./retriable.js";
import type {
  AgentAdapter,
  AgentEvent,
  ResumeRequest,
  StartRequest,
  ToolPolicy,
  UsageBaseline,
} from "./types.js";

/**
 * Codex adapter (design.md §7.2). Spawns `codex exec --json` and translates
 * its JSONL event stream into `AgentEvent`s. Like the Claude adapter it yields
 * events and nothing else: persistence, pricing (§9.7) and state transitions
 * belong to the worker (design.md §3, §9).
 *
 * Unverified against an installed Codex (design.md §17 OI1): the `-c` key
 * names in `CODEX_CONFIG_KEYS` and the event shapes read below follow the
 * Codex CLI's documented `exec --json` contract. Correct them here.
 */

/**
 * `-c` config override keys (design.md §7.2, OI1). One place to correct them
 * once a local Codex install confirms the names.
 */
export const CODEX_CONFIG_KEYS = {
  /** Streamable HTTP MCP server url. */
  mcpUrl: `mcp_servers.${ORCHESTRA_MCP_SERVER}.url`,
  /** Name of the environment variable holding the MCP bearer token. */
  mcpBearerTokenEnvVar: `mcp_servers.${ORCHESTRA_MCP_SERVER}.bearer_token_env_var`,
  /** Lets the workspace-write sandbox reach the network (`gh`, `git push`). */
  networkAccess: "sandbox_workspace_write.network_access",
} as const;

/**
 * Environment variable that carries the execution token to Codex's MCP
 * client, so the token is never on the command line (design.md §7.2).
 */
export const CODEX_MCP_TOKEN_ENV = "ORCHESTRA_TOKEN";

/** How a spawned Codex process ended. */
export interface CodexExit {
  code: number | null;
  signal: string | null;
}

export interface CodexSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

/**
 * The slice of a child process the adapter uses, so a test can play back
 * recorded JSONL. `kill` must stop the whole process group: Codex runs the
 * agent's commands as its own children.
 */
export interface CodexChild {
  stdin: { end(data: string): void };
  stdout: AsyncIterable<string | Uint8Array>;
  stderr: AsyncIterable<string | Uint8Array>;
  /** Settles when the process has exited. Rejects if it never started. */
  exit: Promise<CodexExit>;
  kill(): void;
}

export type CodexSpawnFn = (
  command: string,
  args: readonly string[],
  options: CodexSpawnOptions,
) => CodexChild;

export interface CodexAdapterOptions {
  /** Injected process spawner. Defaults to `spawnCodex`. */
  spawn?: CodexSpawnFn;
  /** Binary to run. Defaults to `codex` on PATH (design.md §7.3). */
  command?: string;
  /**
   * Codex session store: `$CODEX_HOME/sessions` (default
   * `~/.codex/sessions`), holding `YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`.
   * Injectable so `canResume` can be tested without a real session.
   */
  sessionRoot?: string;
  /**
   * How long a process that has ended its turn may take to exit on its own
   * before it is killed. Codex writes the session rollout on shutdown, and
   * resume needs it.
   */
  exitGraceMs?: number;
  /** Receives, redacted, every stdout line the adapter ignores. */
  debug?: (reason: string, line: string) => void;
}

const DEFAULT_COMMAND = "codex";
const DEFAULT_EXIT_GRACE_MS = 10_000;

/** Model reported on usage events when the request named none. */
const UNKNOWN_MODEL = "unknown";
const UNKNOWN_ERROR = "unknown adapter error";
const REDACTED = "[redacted]";

/** Bytes of stderr kept for a crash message. */
const STDERR_TAIL_BYTES = 4096;

/**
 * Codex thread ids are uuids. Anything else is rejected before it reaches the
 * filesystem or the command line, where a leading `-` would read as a flag.
 */
const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default location of Codex's session store. */
export function defaultCodexSessionRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

/**
 * Spawns Codex in its own process group, so `kill` also reaches the commands
 * it runs, as the worktree runner does for git.
 */
export const spawnCodex: CodexSpawnFn = (command, args, options) => {
  const child = spawnProcess(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  // A process that exits before reading its prompt closes stdin (EPIPE).
  child.stdin.on("error", () => {});
  const exit = new Promise<CodexExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exit,
    kill() {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
  };
};

export class CodexAdapter implements AgentAdapter {
  readonly runtime = "codex" as const;

  readonly #spawn: CodexSpawnFn;
  readonly #command: string;
  readonly #sessionRoot: string;
  readonly #exitGraceMs: number;
  readonly #debug: (reason: string, line: string) => void;

  constructor(options: CodexAdapterOptions = {}) {
    this.#spawn = options.spawn ?? spawnCodex;
    this.#command = options.command ?? DEFAULT_COMMAND;
    this.#sessionRoot = options.sessionRoot ?? defaultCodexSessionRoot();
    this.#exitGraceMs = options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
    this.#debug = options.debug ?? (() => {});
  }

  start(req: StartRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    // `exec` has no system channel, so the system prompt leads the prompt.
    const stdin = `${req.systemPrompt}\n\n${req.prompt}`;
    return this.#run(req, execArgs(req, undefined), stdin, signal, undefined);
  }

  resume(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (!THREAD_ID_PATTERN.test(req.sessionId)) {
      return malformedThreadStream(redactorFor(req.mcp.token)(req.sessionId));
    }
    return this.#run(
      req,
      execArgs(req, req.sessionId),
      req.prompt,
      signal,
      req.usageBaseline,
    );
  }

  /**
   * Whether Codex still has this thread's rollout on disk. Codex keys its
   * store by date, not by cwd, so `cwd` is not consulted. Never throws: a
   * missing store means "start fresh" (design.md §9.5).
   */
  async canResume(sessionId: string, _cwd: string): Promise<boolean> {
    if (!THREAD_ID_PATTERN.test(sessionId)) return false;
    let entries: string[];
    try {
      entries = await readdir(this.#sessionRoot, { recursive: true });
    } catch {
      return false;
    }
    const suffix = `-${sessionId}.jsonl`;
    return entries.some((entry) => {
      const name = basename(entry);
      return name.startsWith("rollout-") && name.endsWith(suffix);
    });
  }

  #run(
    req: StartRequest | ResumeRequest,
    args: string[],
    stdin: string,
    signal: AbortSignal,
    usageBaseline: UsageBaseline | undefined,
  ): AsyncIterable<AgentEvent> {
    const redact = redactorFor(req.mcp.token);
    return runCodex({
      spawn: this.#spawn,
      command: this.#command,
      args,
      stdin,
      spawnOptions: {
        cwd: req.cwd,
        // Inherited first so Codex keeps HOME and its credentials; the token
        // variable last so a same-named request entry cannot replace it.
        env: { ...process.env, ...req.env, [CODEX_MCP_TOKEN_ENV]: req.mcp.token },
      },
      signal,
      redact,
      model: req.model ?? UNKNOWN_MODEL,
      unbilled: remainingBaseline(usageBaseline),
      exitGraceMs: this.#exitGraceMs,
      debug: (reason, line) => this.#debug(reason, redact(line)),
    });
  }
}

/**
 * `codex exec` arguments. Every exec-level flag precedes `resume`, where the
 * parent command is certain to parse it; `-` reads the prompt from stdin.
 */
function execArgs(
  req: StartRequest | ResumeRequest,
  resumeThreadId: string | undefined,
): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    req.cwd,
    ...sandboxArgs(req.allowedTools),
  ];
  if (req.model !== undefined) args.push("-m", req.model);
  args.push(
    "-c",
    `${CODEX_CONFIG_KEYS.mcpUrl}=${tomlString(req.mcp.url)}`,
    "-c",
    `${CODEX_CONFIG_KEYS.mcpBearerTokenEnvVar}=${tomlString(CODEX_MCP_TOKEN_ENV)}`,
  );
  if (resumeThreadId !== undefined) args.push("resume", resumeThreadId);
  args.push("-");
  return args;
}

function sandboxArgs(policy: ToolPolicy): string[] {
  const { sandbox, networkAccess } = codexSandboxFor(policy);
  const args = ["--sandbox", sandbox];
  if (networkAccess) args.push("-c", `${CODEX_CONFIG_KEYS.networkAccess}=true`);
  return args;
}

/** `-c` values are parsed as TOML; a JSON string is a valid TOML basic string. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function* malformedThreadStream(sessionId: string): AsyncGenerator<AgentEvent> {
  yield {
    type: "error",
    message: `malformed codex thread id: ${JSON.stringify(sessionId)}`,
    retriable: false,
  };
}

interface RunConfig {
  spawn: CodexSpawnFn;
  command: string;
  args: string[];
  stdin: string;
  spawnOptions: CodexSpawnOptions;
  signal: AbortSignal;
  redact: (text: string) => string;
  model: string;
  unbilled: RemainingBaseline | undefined;
  exitGraceMs: number;
  debug: (reason: string, line: string) => void;
}

interface StreamContext {
  model: string;
  unbilled: RemainingBaseline | undefined;
  /** Text of the latest `agent_message`, the turn's final answer. */
  lastMessage: string;
  /** Set once `turn_done` or `error` has been produced. */
  ended: boolean;
  debug: (reason: string, line: string) => void;
}

type ExitOutcome = CodexExit | { error: unknown };

const ABORTED = Symbol("aborted");

/**
 * Drives one Codex process to completion.
 *
 * Abort contract (design.md §7): when `signal` fires the process group is
 * killed at once and the iterator ends quietly, never with an `error` event.
 * The stream ends after the first `turn_done` or `error`; a process that has
 * ended its turn gets `exitGraceMs` to exit on its own before it is killed.
 */
async function* runCodex(run: RunConfig): AsyncGenerator<AgentEvent> {
  const { signal, redact } = run;
  if (signal.aborted) return;

  let child: CodexChild;
  try {
    child = run.spawn(run.command, run.args, run.spawnOptions);
  } catch (error) {
    yield errorEvent(redact(errorText(error)));
    return;
  }

  let exited = false;
  const exit: Promise<ExitOutcome> = child.exit.then(
    (outcome) => {
      exited = true;
      return outcome;
    },
    (error: unknown) => {
      exited = true;
      return { error };
    },
  );

  let killed = false;
  const kill = (): void => {
    if (exited || killed) return;
    killed = true;
    child.kill();
  };

  let onAbort = (): void => {};
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => {
      kill();
      resolve(ABORTED);
    };
  });
  signal.addEventListener("abort", onAbort, { once: true });

  const stderr = new TailCollector(STDERR_TAIL_BYTES, redact);
  void stderr.drain(child.stderr);

  const context: StreamContext = {
    model: run.model,
    unbilled: run.unbilled,
    lastMessage: "",
    ended: false,
    debug: run.debug,
  };
  const lines = splitLines(child.stdout)[Symbol.asyncIterator]();

  try {
    try {
      child.stdin.end(run.stdin);
    } catch {
      // The exit code reports whatever went wrong.
    }

    for (;;) {
      const next = await Promise.race([lines.next(), aborted]);
      if (next === ABORTED) return;
      if (next.done) break;
      for (const event of mapLine(next.value, context)) {
        yield redactEvent(event, redact);
        if (signal.aborted) return;
      }
      if (context.ended) return;
    }

    const outcome = await Promise.race([exit, aborted]);
    if (outcome === ABORTED) return;
    // Output ended without a turn end: a crash whatever the exit code, even
    // 0, and whatever stderr says, so it is retried as infrastructure
    // (design.md §9.5). Ending quietly would let the runner read an
    // exhausted stream as a finished turn.
    if ("error" in outcome) {
      yield errorEvent(redact(`codex failed to run: ${errorText(outcome.error)}`));
    } else {
      const how =
        outcome.code !== null
          ? `exited with code ${outcome.code}`
          : `was killed by ${outcome.signal ?? "a signal"}`;
      const detail = stderr.text().trim();
      yield {
        type: "error",
        message: redact(
          `codex ${how} before the turn ended${detail ? `: ${detail}` : ""}`,
        ),
        retriable: true,
      };
    }
  } catch (error) {
    if (signal.aborted) return;
    yield errorEvent(redact(errorText(error)));
  } finally {
    // The abort listener stays attached through the grace wait, so a cancel
    // during it kills the process at once rather than after `exitGraceMs`.
    if (!exited && context.ended && !signal.aborted) {
      // Keep reading so a full stdout pipe cannot stop Codex from exiting.
      void (async () => {
        try {
          while (!(await lines.next()).done);
        } catch {
          // The exit or the kill below settles the process either way.
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      const graceOver = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, run.exitGraceMs);
      });
      await Promise.race([exit, graceOver, aborted]);
      clearTimeout(timer);
    }
    signal.removeEventListener("abort", onAbort);
    kill();
  }
}

function errorEvent(message: string): AgentEvent {
  return { type: "error", message, retriable: classifyRetriable(message) };
}

/** Splits a byte or text stream into lines, dropping blank ones. */
async function* splitLines(
  stream: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer +=
      typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") yield line;
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") yield buffer.replace(/\r$/, "");
}

/**
 * Keeps the last `limit` characters of a stream, for crash messages.
 *
 * Redacts before it truncates. Truncating first can cut the token at the
 * boundary and leave a fragment the whole-string redaction no longer
 * matches. The kept text is already redacted, so a token split across two
 * chunks is matched once its second half arrives, and any unredacted token
 * prefix can only sit at the tail, which truncation never cuts.
 */
class TailCollector {
  #text = "";
  readonly #limit: number;
  readonly #redact: (text: string) => string;

  constructor(limit: number, redact: (text: string) => string) {
    this.#limit = limit;
    this.#redact = redact;
  }

  async drain(stream: AsyncIterable<string | Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this.#push(
          typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
        );
      }
      this.#push(decoder.decode());
    } catch {
      // A broken stderr pipe only loses crash detail.
    }
  }

  text(): string {
    return this.#text;
  }

  #push(text: string): void {
    this.#text = this.#redact(this.#text + text).slice(-this.#limit);
  }
}

// --- JSONL mapping ----------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapLine(line: string, context: StreamContext): AgentEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    context.debug("unparseable line", line);
    return [];
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    context.debug("unparseable line", line);
    return [];
  }

  switch (parsed.type) {
    case "thread.started":
      return typeof parsed.thread_id === "string"
        ? [{ type: "session", sessionId: parsed.thread_id }]
        : [];
    case "turn.started":
    case "item.started":
    case "item.updated":
      // Progress only; the completed item carries everything recorded.
      return [];
    case "item.completed":
      return mapItem(parsed.item, line, context);
    case "turn.completed": {
      context.ended = true;
      const events: AgentEvent[] = [];
      if (isRecord(parsed.usage)) {
        events.push(chargeAgainstBaseline(usageEvent(parsed.usage, context.model), context));
      }
      events.push({ type: "turn_done", finalText: context.lastMessage });
      return events;
    }
    case "turn.failed": {
      context.ended = true;
      const error = isRecord(parsed.error) ? parsed.error : {};
      return [errorEvent(nonEmpty(error.message) ?? "codex turn failed")];
    }
    case "error":
      context.ended = true;
      return [errorEvent(nonEmpty(parsed.message) ?? "codex reported an error")];
    default:
      context.debug("unknown event type", line);
      return [];
  }
}

/** `item.completed`: agent messages become text, tool items `tool_call`. */
function mapItem(item: unknown, line: string, context: StreamContext): AgentEvent[] {
  if (!isRecord(item) || typeof item.type !== "string") {
    context.debug("unparseable item", line);
    return [];
  }
  switch (item.type) {
    case "agent_message": {
      if (typeof item.text !== "string") return [];
      context.lastMessage = item.text;
      return [{ type: "text", delta: item.text }];
    }
    case "command_execution":
      return [{ type: "tool_call", name: "command_execution", input: { command: item.command } }];
    case "mcp_tool_call": {
      // Named the way the Claude runtime names MCP tools, so the runner
      // recognises agent-tools calls it records itself.
      const server = typeof item.server === "string" ? item.server : "unknown";
      const tool = typeof item.tool === "string" ? item.tool : "unknown";
      return [
        { type: "tool_call", name: `mcp__${server}__${tool}`, input: item.arguments ?? null },
      ];
    }
    case "file_change":
      return [{ type: "tool_call", name: "file_change", input: { changes: item.changes } }];
    case "web_search":
      return [{ type: "tool_call", name: "web_search", input: { query: item.query } }];
    case "reasoning":
    case "todo_list":
    case "error":
      // Reasoning summaries, plans and non-fatal warnings are not recorded.
      return [];
    default:
      context.debug("unknown item type", line);
      return [];
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

type UsageEvent = Extract<AgentEvent, { type: "usage" }>;

/**
 * `turn.completed.usage`. Codex's `input_tokens` includes the cached tokens,
 * so `input` is the uncached remainder: the worker prices `input` and
 * `cached` at separate rates (§9.7) and must not charge a cached token twice.
 * No `costUsd`; the worker prices Codex usage.
 */
function usageEvent(usage: Json, model: string): UsageEvent {
  const cached = tokens(usage.cached_input_tokens);
  return {
    type: "usage",
    model,
    input: Math.max(0, tokens(usage.input_tokens) - cached),
    cached,
    output: tokens(usage.output_tokens),
  };
}

interface RemainingBaseline {
  perModel: Record<string, { input: number; cached: number; output: number }>;
}

/** Mutable copy of the baseline, floored at zero per field. */
function remainingBaseline(
  baseline: UsageBaseline | undefined,
): RemainingBaseline | undefined {
  if (!baseline) return undefined;
  const perModel: RemainingBaseline["perModel"] = {};
  for (const [model, b] of Object.entries(baseline)) {
    perModel[model] = {
      input: Math.max(0, b.input),
      cached: Math.max(0, b.cached),
      output: Math.max(0, b.output),
    };
  }
  return { perModel };
}

/**
 * Subtracts what the resumed session already reported, per model, clamped at
 * zero, exactly as the Claude adapter does: the runtime reports session
 * totals, so without this a resume re-bills every earlier turn (§9.7).
 */
function chargeAgainstBaseline(event: UsageEvent, context: StreamContext): UsageEvent {
  const remaining = context.unbilled?.perModel[event.model];
  if (!remaining) return event;
  const consume = (field: "input" | "cached" | "output"): number => {
    const spent = Math.min(remaining[field], event[field]);
    remaining[field] -= spent;
    return event[field] - spent;
  };
  return {
    ...event,
    input: consume("input"),
    cached: consume("cached"),
    output: consume("output"),
  };
}

// --- redaction and error text -------------------------------------------------

function redactorFor(token: string): (text: string) => string {
  if (token === "") return (text) => text;
  return (text) => text.split(token).join(REDACTED);
}

function redactEvent(event: AgentEvent, redact: (text: string) => string): AgentEvent {
  switch (event.type) {
    case "session":
      return { ...event, sessionId: redact(event.sessionId) };
    case "text":
      return { ...event, delta: redact(event.delta) };
    case "turn_done":
      return { ...event, finalText: redact(event.finalText) };
    case "error":
      return { ...event, message: redact(event.message) };
    case "tool_call":
      return { ...event, name: redact(event.name), input: redactInput(event.input, redact) };
    default:
      return event;
  }
}

/** Redacts a tool input of unknown shape through a JSON round trip. */
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

function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  try {
    const text = JSON.stringify(error);
    if (text && text !== "{}") return text;
  } catch {
    // Circular or a throwing `toJSON`.
  }
  return UNKNOWN_ERROR;
}
