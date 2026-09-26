import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `canResume` must reject a malformed id before it touches the filesystem, so
// `readdir` is wrapped in a spy that still calls through.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

import {
  CODEX_CONFIG_KEYS,
  CODEX_MCP_TOKEN_ENV,
  CodexAdapter,
  type CodexChild,
  type CodexExit,
  type CodexSpawnFn,
  type CodexSpawnOptions,
  defaultCodexSessionRoot,
} from "./codex.js";
import { codexSandboxFor } from "./policies.js";
import type { AgentEvent, ResumeRequest, StartRequest } from "./types.js";

const THREAD_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";
/** Token the recorded fixtures quote back. */
const TOKEN = "codex-fixture-token-5ecret";

const FIXTURES = fileURLToPath(
  new URL("../test/fixtures/codex/", import.meta.url),
);
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const startRequest: StartRequest = {
  cwd: "/work/exec-1",
  systemPrompt: "You are the implementer.",
  prompt: "Implement GOT-1.",
  model: "gpt-5-codex",
  allowedTools: "implementation",
  mcp: { url: "http://127.0.0.1:4599/mcp", token: TOKEN },
  env: { PATH: "/usr/bin:/bin", GITHUB_TOKEN: "gh-token" },
};

const resumeRequest: ResumeRequest = {
  cwd: startRequest.cwd,
  prompt: "Continue GOT-1.",
  model: startRequest.model,
  allowedTools: "implementation",
  mcp: startRequest.mcp,
  env: startRequest.env,
  sessionId: THREAD_ID,
};

// --- fake process ---------------------------------------------------------

interface SpawnCall {
  command: string;
  args: string[];
  options: CodexSpawnOptions;
  stdin: string | undefined;
}

interface FakeRun {
  spawn: CodexSpawnFn;
  calls: SpawnCall[];
  kills: number;
}

/**
 * A child that plays back `stdout` in small chunks (splitting lines, so the
 * adapter's line buffering is exercised) and then exits with `exit`. With
 * `hang`, stdout stays open after the recording until `kill()`.
 */
function fakeCodex(
  stdout: string,
  opts: {
    exit?: CodexExit;
    stderr?: string;
    hang?: boolean;
    /** Delay between stdout ending and the exit, for the grace test. */
    exitAfterMs?: number;
    /** Never exit unless killed. */
    neverExit?: boolean;
  } = {},
): FakeRun {
  const run: FakeRun = { spawn: undefined!, calls: [], kills: 0 };
  run.spawn = (command, args, options) => {
    const call: SpawnCall = {
      command,
      args: [...args],
      options,
      stdin: undefined,
    };
    run.calls.push(call);

    let killed!: () => void;
    const killedP = new Promise<void>((resolve) => {
      killed = resolve;
    });
    let resolveExit!: (exit: CodexExit) => void;
    const exit = new Promise<CodexExit>((resolve) => {
      resolveExit = resolve;
    });
    void killedP.then(() => resolveExit({ code: null, signal: "SIGKILL" }));
    // Like a real process, the exit does not wait for stdout to be read.
    if (!opts.hang && !opts.neverExit) {
      const finalExit = opts.exit ?? { code: 0, signal: null };
      setTimeout(() => resolveExit(finalExit), opts.exitAfterMs ?? 0);
    }

    async function* out(): AsyncGenerator<string> {
      for (let i = 0; i < stdout.length; i += 37) {
        yield stdout.slice(i, i + 37);
        await Promise.resolve();
      }
      if (opts.hang) await killedP;
    }
    async function* err(): AsyncGenerator<Uint8Array> {
      if (opts.stderr) yield new TextEncoder().encode(opts.stderr);
    }

    const child: CodexChild = {
      stdin: {
        end(data: string) {
          call.stdin = data;
        },
      },
      stdout: out(),
      stderr: err(),
      exit,
      kill() {
        run.kills += 1;
        killed();
      },
    };
    return child;
  };
  return run;
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const neverAborted = (): AbortSignal => new AbortController().signal;

const iterate = (stream: AsyncIterable<AgentEvent>): AsyncIterator<AgentEvent> =>
  stream[Symbol.asyncIterator]();

/** `startRequest` without a model. */
function withoutModel(): StartRequest {
  const req = { ...startRequest };
  delete req.model;
  return req;
}

/** Value of the `-c` override for `key`, or undefined. */
function override(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-c" && args[i + 1]!.startsWith(`${key}=`)) {
      return args[i + 1]!.slice(key.length + 1);
    }
  }
  return undefined;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

// --- AC1: spawn arguments -------------------------------------------------

describe("CodexAdapter.start spawn arguments (design.md §7.2)", () => {
  it("runs codex exec --json with -C cwd, --skip-git-repo-check and stdin as the prompt", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    const adapter = new CodexAdapter({ spawn: fake.spawn });
    await collect(adapter.start(startRequest, neverAborted()));

    expect(fake.calls).toHaveLength(1);
    const { command, args, options } = fake.calls[0]!;
    expect(command).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(flagValue(args, "-C")).toBe("/work/exec-1");
    expect(flagValue(args, "-m")).toBe("gpt-5-codex");
    // `-` reads the prompt from stdin and is the last argument.
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("resume");
    expect(options.cwd).toBe("/work/exec-1");
  });

  it("configures the orchestra MCP server by url and a token env variable name", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, neverAborted()),
    );
    const { args, options } = fake.calls[0]!;

    expect(CODEX_CONFIG_KEYS.mcpUrl).toBe("mcp_servers.orchestra.url");
    expect(CODEX_CONFIG_KEYS.mcpBearerTokenEnvVar).toBe(
      "mcp_servers.orchestra.bearer_token_env_var",
    );
    expect(override(args, CODEX_CONFIG_KEYS.mcpUrl)).toBe(
      '"http://127.0.0.1:4599/mcp"',
    );
    expect(override(args, CODEX_CONFIG_KEYS.mcpBearerTokenEnvVar)).toBe(
      `"${CODEX_MCP_TOKEN_ENV}"`,
    );
    // The token travels in the environment, never on the command line.
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(options.env[CODEX_MCP_TOKEN_ENV]).toBe(TOKEN);
    expect(options.env.GITHUB_TOKEN).toBe("gh-token");
    expect(options.env.PATH).toBe("/usr/bin:/bin");
  });

  it("the token env variable wins over a same-named request env entry", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(
        { ...startRequest, env: { [CODEX_MCP_TOKEN_ENV]: "stale" } },
        neverAborted(),
      ),
    );
    expect(fake.calls[0]!.options.env[CODEX_MCP_TOKEN_ENV]).toBe(TOKEN);
  });

  it.each([
    ["implementation", "workspace-write", "true"],
    ["spec", "read-only", undefined],
    ["review", "read-only", undefined],
  ] as const)(
    "the %s role runs with --sandbox %s",
    async (policy, sandbox, network) => {
      const fake = fakeCodex(fixture("start-session.jsonl"));
      await collect(
        new CodexAdapter({ spawn: fake.spawn }).start(
          { ...startRequest, allowedTools: policy },
          neverAborted(),
        ),
      );
      const { args } = fake.calls[0]!;
      expect(flagValue(args, "--sandbox")).toBe(sandbox);
      expect(args.filter((a) => a === "--sandbox")).toHaveLength(1);
      expect(override(args, CODEX_CONFIG_KEYS.networkAccess)).toBe(network);
      expect(codexSandboxFor(policy).sandbox).toBe(sandbox);
    },
  );

  it("prepends the system prompt to the user prompt on stdin", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, neverAborted()),
    );
    const stdin = fake.calls[0]!.stdin!;
    expect(stdin.indexOf("You are the implementer.")).toBe(0);
    expect(stdin.indexOf("Implement GOT-1.")).toBeGreaterThan(
      stdin.indexOf("You are the implementer."),
    );
    // Nothing from either prompt is on the command line.
    expect(fake.calls[0]!.args.join(" ")).not.toContain("Implement GOT-1.");
  });

  it("omits -m when no model is requested", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    const noModel = withoutModel();
    await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(noModel, neverAborted()),
    );
    expect(fake.calls[0]!.args).not.toContain("-m");
  });

  it("uses the injected command name", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    await collect(
      new CodexAdapter({ spawn: fake.spawn, command: "/opt/codex/bin/codex" }).start(
        startRequest,
        neverAborted(),
      ),
    );
    expect(fake.calls[0]!.command).toBe("/opt/codex/bin/codex");
  });
});

// --- AC2: event mapping ---------------------------------------------------

describe("CodexAdapter JSONL mapping (design.md §7.2)", () => {
  it("maps a recorded start session to session, text, tool_call, usage and turn_done in order", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, neverAborted()),
    );

    expect(events).toEqual([
      { type: "session", sessionId: THREAD_ID },
      { type: "text", delta: "Reading the repository." },
      {
        type: "tool_call",
        name: "command_execution",
        input: { command: "bash -lc 'git log --oneline -3'" },
      },
      {
        type: "tool_call",
        name: "mcp__orchestra__note",
        input: { text: "starting" },
      },
      {
        type: "tool_call",
        name: "file_change",
        input: { changes: [{ path: "src/a.ts", kind: "update" }] },
      },
      { type: "text", delta: "Opened the pull request." },
      // input_tokens includes the cached tokens; `input` is the uncached part
      // so pricing input and cached_input separately does not double count.
      { type: "usage", model: "gpt-5-codex", input: 315, cached: 24448, output: 122 },
      { type: "turn_done", finalText: "Opened the pull request." },
    ]);
    const usage = events.find((e) => e.type === "usage")!;
    expect("costUsd" in usage).toBe(false);
  });

  it("reports the usage model as unknown when no model was requested", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    const noModel = withoutModel();
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(noModel, neverAborted()),
    );
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      model: "unknown",
    });
  });

  it("passes unknown event types and unparseable lines to the debug hook and emits nothing for them", async () => {
    const debug = vi.fn();
    const fake = fakeCodex(
      [
        "not json",
        `{"type":"x.future","token":"${TOKEN}"}`,
        `{"type":"item.completed","item":{"id":"i","type":"x.item"}}`,
        fixture("start-session.jsonl"),
      ].join("\n"),
    );
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn, debug }).start(startRequest, neverAborted()),
    );
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "text",
      "tool_call",
      "tool_call",
      "tool_call",
      "text",
      "usage",
      "turn_done",
    ]);
    const reasons = debug.mock.calls.map((c) => c[0] as string);
    expect(reasons).toContain("unparseable line");
    expect(reasons).toContain("unknown event type");
    expect(reasons).toContain("unknown item type");
    for (const [, line] of debug.mock.calls) {
      expect(line as string).not.toContain(TOKEN);
    }
  });

  it("handles a final line with no trailing newline", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl").trimEnd());
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, neverAborted()),
    );
    expect(events.at(-1)).toEqual({
      type: "turn_done",
      finalText: "Opened the pull request.",
    });
  });
});

// --- AC3: resume ----------------------------------------------------------

describe("CodexAdapter.resume (design.md §7.2, §9.7)", () => {
  it("passes resume <thread_id>, keeps the flags, and sends only the prompt on stdin", async () => {
    const fake = fakeCodex(fixture("resume-session.jsonl"));
    await collect(
      new CodexAdapter({ spawn: fake.spawn }).resume(resumeRequest, neverAborted()),
    );
    const { args, stdin, options } = fake.calls[0]!;
    const at = args.indexOf("resume");
    expect(at).toBeGreaterThan(0);
    expect(args[at + 1]).toBe(THREAD_ID);
    expect(args.at(-1)).toBe("-");
    expect(args).toContain("--json");
    expect(flagValue(args, "-C")).toBe("/work/exec-1");
    expect(flagValue(args, "--sandbox")).toBe("workspace-write");
    expect(override(args, CODEX_CONFIG_KEYS.mcpUrl)).toBe(
      '"http://127.0.0.1:4599/mcp"',
    );
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(options.env[CODEX_MCP_TOKEN_ENV]).toBe(TOKEN);
    expect(stdin).toBe("Continue GOT-1.");
  });

  it("emits the runtime's totals unchanged without a baseline", async () => {
    const fake = fakeCodex(fixture("resume-session.jsonl"));
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).resume(resumeRequest, neverAborted()),
    );
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      model: "gpt-5-codex",
      input: 4000,
      cached: 26000,
      output: 200,
    });
  });

  it("subtracts the matching model's baseline", async () => {
    const fake = fakeCodex(fixture("resume-session.jsonl"));
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).resume(
        {
          ...resumeRequest,
          usageBaseline: {
            "gpt-5-codex": { input: 315, cached: 24448, output: 122 },
            "other-model": { input: 999_999, cached: 999_999, output: 999_999 },
          },
        },
        neverAborted(),
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "text",
      "usage",
      "turn_done",
    ]);
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      model: "gpt-5-codex",
      input: 3685,
      cached: 1552,
      output: 78,
    });
  });

  it("clamps each field at zero when the baseline exceeds the reported totals", async () => {
    const fake = fakeCodex(fixture("resume-session.jsonl"));
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).resume(
        {
          ...resumeRequest,
          usageBaseline: {
            "gpt-5-codex": { input: 50_000, cached: 50_000, output: 150 },
          },
        },
        neverAborted(),
      ),
    );
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      model: "gpt-5-codex",
      input: 0,
      cached: 0,
      output: 50,
    });
  });

  it("rejects a malformed thread id without spawning", async () => {
    const fake = fakeCodex(fixture("resume-session.jsonl"));
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).resume(
        { ...resumeRequest, sessionId: "--dangerously-bypass-approvals-and-sandbox" },
        neverAborted(),
      ),
    );
    expect(fake.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retriable: false });
  });
});

// --- AC4: failures and redaction ------------------------------------------

describe("CodexAdapter failures and redaction (design.md §9.5)", () => {
  it("turn.failed yields one classified error and no second error for the exit code", async () => {
    const fake = fakeCodex(fixture("turn-failed.jsonl"), {
      exit: { code: 1, signal: null },
    });
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, neverAborted()),
    );
    expect(events.map((e) => e.type)).toEqual(["session", "error"]);
    const error = events[1] as Extract<AgentEvent, { type: "error" }>;
    expect(error.message).toContain("401 Unauthorized");
    // Auth is terminal (retriable.ts).
    expect(error.retriable).toBe(false);
  });

  it("a top-level error event yields a classified, retriable error", async () => {
    const fake = fakeCodex(fixture("error-event.jsonl"), {
      exit: { code: 1, signal: null },
    });
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, neverAborted()),
    );
    expect(events).toEqual([
      { type: "session", sessionId: THREAD_ID },
      {
        type: "error",
        message: "stream disconnected before completion: connection reset by peer",
        retriable: true,
      },
    ]);
  });

  it("a non-zero exit with no turn end yields a retriable error carrying stderr", async () => {
    const fake = fakeCodex(fixture("crash-no-turn-end.jsonl"), {
      exit: { code: 101, signal: null },
      stderr: `thread 'main' panicked; unauthorized token ${TOKEN}\n`,
    });
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, neverAborted()),
    );
    expect(events.map((e) => e.type)).toEqual(["session", "text", "error"]);
    const error = events[2] as Extract<AgentEvent, { type: "error" }>;
    // Process crash class: retriable even though stderr says "unauthorized".
    expect(error.retriable).toBe(true);
    expect(error.message).toContain("101");
    expect(error.message).toContain("panicked");
    expect(error.message).not.toContain(TOKEN);
  });

  it("a signal exit with no turn end yields a retriable error", async () => {
    const fake = fakeCodex(fixture("crash-no-turn-end.jsonl"), {
      exit: { code: null, signal: "SIGSEGV" },
    });
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, neverAborted()),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", retriable: true });
    expect((events.at(-1) as { message: string }).message).toContain("SIGSEGV");
  });

  it("redacts the token from text, tool inputs and error messages", async () => {
    const debug = vi.fn();
    const fake = fakeCodex(fixture("token-leak.jsonl"), {
      exit: { code: 1, signal: null },
    });
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn, debug }).start(
        startRequest,
        neverAborted(),
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "text",
      "tool_call",
      "tool_call",
      "error",
    ]);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).toContain("[redacted]");
    expect(events[3]).toEqual({
      type: "tool_call",
      name: "mcp__orchestra__note",
      input: { text: "leaked [redacted]" },
    });
  });

  it("a spawn function that throws yields a redacted error rather than throwing", async () => {
    const adapter = new CodexAdapter({
      spawn: () => {
        throw new Error(`spawn failed with ${TOKEN}`);
      },
    });
    const events = await collect(adapter.start(startRequest, neverAborted()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retriable: true });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });
});

// --- AC6: abort -----------------------------------------------------------

describe("CodexAdapter abort (design.md §7: cancel is the AbortSignal)", () => {
  it("kills the process on abort and ends the iterator without an error event", async () => {
    const fake = fakeCodex(
      '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}\n',
      { hang: true },
    );
    const controller = new AbortController();
    const iterator = iterate(new CodexAdapter({ spawn: fake.spawn })
      .start(startRequest, controller.signal));

    expect((await iterator.next()).value).toEqual({
      type: "session",
      sessionId: THREAD_ID,
    });
    const pending = iterator.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(fake.kills).toBeGreaterThanOrEqual(1);
  });

  it("never spawns when the signal is already aborted", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"));
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn }).start(startRequest, controller.signal),
    );
    expect(events).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("kills the process when the consumer stops early", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"), { hang: true });
    const iterator = iterate(new CodexAdapter({ spawn: fake.spawn })
      .start(startRequest, neverAborted()));
    await iterator.next();
    await iterator.return?.();
    expect(fake.kills).toBe(1);
  });

  it("lets the process exit on its own after turn_done instead of killing it", async () => {
    // Codex flushes the session rollout on shutdown; killing it right after
    // turn.completed could lose what resume needs.
    const fake = fakeCodex(fixture("start-session.jsonl"), { exitAfterMs: 30 });
    const iterator = iterate(new CodexAdapter({ spawn: fake.spawn, exitGraceMs: 5_000 })
      .start(startRequest, neverAborted()));
    for (;;) {
      const next = await iterator.next();
      if (next.done || next.value.type === "turn_done") break;
    }
    await iterator.return?.();
    expect(fake.kills).toBe(0);
  });

  it("kills a process that has not exited within the grace period after turn_done", async () => {
    const fake = fakeCodex(fixture("start-session.jsonl"), { neverExit: true });
    const events = await collect(
      new CodexAdapter({ spawn: fake.spawn, exitGraceMs: 20 }).start(
        startRequest,
        neverAborted(),
      ),
    );
    expect(events.at(-1)?.type).toBe("turn_done");
    expect(fake.kills).toBe(1);
  });
});

// --- default spawner against a real process --------------------------------

describe("CodexAdapter with the default spawner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orchestra-codex-bin-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw err;
    }
  };

  async function fakeBinary(script: string): Promise<string> {
    const path = join(dir, "codex");
    await writeFile(path, `#!/bin/sh\n${script}`, { mode: 0o755 });
    return path;
  }

  async function waitFor(file: string): Promise<number> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const text = (await readFile(file, "utf8")).trim();
        if (text !== "") return Number(text);
      } catch {
        // Not written yet.
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("abort kills the whole process group, including grandchildren", async () => {
    const selfPid = join(dir, "self.pid");
    const childPid = join(dir, "child.pid");
    const command = await fakeBinary(
      [
        `echo $$ > "${selfPid}"`,
        `sh -c 'echo $$ > "$1"; exec sleep 30' sh "${childPid}" &`,
        `echo '{"type":"thread.started","thread_id":"${THREAD_ID}"}'`,
        "wait",
        "",
      ].join("\n"),
    );
    const controller = new AbortController();
    const iterator = iterate(new CodexAdapter({ command })
      .start({ ...startRequest, cwd: dir }, controller.signal));

    const pids: number[] = [];
    try {
      expect((await iterator.next()).value).toEqual({
        type: "session",
        sessionId: THREAD_ID,
      });
      pids.push(await waitFor(selfPid), await waitFor(childPid));
      expect(pids.every(alive)).toBe(true);

      const pending = iterator.next();
      controller.abort();
      expect(await pending).toEqual({ done: true, value: undefined });

      const deadline = Date.now() + 3_000;
      while (pids.some(alive) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(pids.some(alive)).toBe(false);
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("feeds stdin, reads JSONL and reports a crash exit with redacted stderr", async () => {
    const stdinCopy = join(dir, "stdin.txt");
    const command = await fakeBinary(
      [
        `cat > "${stdinCopy}"`,
        `echo '{"type":"thread.started","thread_id":"${THREAD_ID}"}'`,
        `echo "fatal: bad token $${CODEX_MCP_TOKEN_ENV}" >&2`,
        "exit 3",
        "",
      ].join("\n"),
    );
    const events = await collect(
      new CodexAdapter({ command }).start({ ...startRequest, cwd: dir }, neverAborted()),
    );
    expect(events.map((e) => e.type)).toEqual(["session", "error"]);
    const error = events[1] as Extract<AgentEvent, { type: "error" }>;
    expect(error.retriable).toBe(true);
    expect(error.message).toContain("fatal: bad token [redacted]");
    expect(error.message).not.toContain(TOKEN);
    expect(await readFile(stdinCopy, "utf8")).toBe(
      "You are the implementer.\n\nImplement GOT-1.",
    );
  });

  it("a missing binary yields a retriable error event", async () => {
    const events = await collect(
      new CodexAdapter({ command: join(dir, "no-such-codex") }).start(
        startRequest,
        neverAborted(),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retriable: true });
  });
});

// --- AC5: canResume -------------------------------------------------------

describe("CodexAdapter.canResume (Codex session store on disk)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orchestra-codex-sessions-"));
    vi.mocked(readdir).mockClear();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to $CODEX_HOME/sessions, else ~/.codex/sessions", () => {
    expect(defaultCodexSessionRoot({ CODEX_HOME: "/srv/codex" })).toBe(
      "/srv/codex/sessions",
    );
    expect(defaultCodexSessionRoot({})).toMatch(/\.codex[/\\]sessions$/);
  });

  it("is true when a rollout for the thread exists under a dated directory", async () => {
    const day = join(root, "2026", "09", "25");
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, `rollout-2026-09-25T10-00-00-${THREAD_ID}.jsonl`),
      "{}\n",
    );
    const adapter = new CodexAdapter({ sessionRoot: root });
    await expect(adapter.canResume(THREAD_ID, "/work/exec-1")).resolves.toBe(true);
  });

  it("is false when no rollout for the thread exists", async () => {
    const day = join(root, "2026", "09", "25");
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, "rollout-2026-09-25T10-00-00-0199a213-81c0-7800-8aa1-000000000000.jsonl"),
      "{}\n",
    );
    const adapter = new CodexAdapter({ sessionRoot: root });
    await expect(adapter.canResume(THREAD_ID, "/work/exec-1")).resolves.toBe(false);
  });

  it("is false when the session root does not exist", async () => {
    const adapter = new CodexAdapter({ sessionRoot: join(root, "missing") });
    await expect(adapter.canResume(THREAD_ID, "/work/exec-1")).resolves.toBe(false);
  });

  it.each(["../../etc/passwd", "", "*", `${THREAD_ID}/..`, `-${THREAD_ID}`])(
    "rejects the malformed id %j without touching the filesystem",
    async (id) => {
      const adapter = new CodexAdapter({ sessionRoot: root });
      await expect(adapter.canResume(id, "/work/exec-1")).resolves.toBe(false);
      expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    },
  );
});
