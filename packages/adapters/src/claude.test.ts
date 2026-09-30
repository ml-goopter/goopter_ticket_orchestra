import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAdapter,
  type ClaudeQueryFn,
  encodeProjectDir,
} from "./claude.js";
import { allowedToolsFor, builtinToolsFor } from "./policies.js";
import { classifyRetriable } from "./retriable.js";
import type {
  AgentProcess,
  ProcessExit,
  ProcessSpawner,
  ProcessSpawnOptions,
} from "./spawner.js";
import type { AgentEvent, ResumeRequest, StartRequest } from "./types.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "s3cr3t-execution-token";

const startRequest: StartRequest = {
  cwd: "/work/exec-1",
  systemPrompt: "You are the implementer.",
  prompt: "Implement GOT-1.",
  model: "claude-sonnet-5",
  allowedTools: "implementation",
  mcp: { url: "http://127.0.0.1:4599/mcp", token: TOKEN },
  env: { ORCHESTRA_TOKEN: TOKEN },
  maxBudgetUsd: 5,
};

const resumeRequest: ResumeRequest = {
  cwd: startRequest.cwd,
  prompt: "Continue GOT-1.",
  model: startRequest.model,
  allowedTools: startRequest.allowedTools,
  mcp: startRequest.mcp,
  env: startRequest.env,
  maxBudgetUsd: startRequest.maxBudgetUsd,
  sessionId: SESSION_ID,
};

// --- SDK message fixtures -------------------------------------------------
// Shaped from the installed SDK's `sdk.d.ts`; only the fields the adapter
// reads are populated, so the casts keep the fixtures readable.
const cast = (value: unknown): SDKMessage => value as SDKMessage;

const systemInit = cast({
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  model: "claude-sonnet-5",
  cwd: "/work/exec-1",
  tools: [],
  uuid: "u-init",
});

const assistantText = cast({
  type: "assistant",
  session_id: SESSION_ID,
  parent_tool_use_id: null,
  uuid: "u-text",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Reading the repository." }],
  },
});

const assistantToolUse = cast({
  type: "assistant",
  session_id: SESSION_ID,
  parent_tool_use_id: null,
  uuid: "u-tool",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_01",
        name: "Read",
        input: { file_path: "/work/exec-1/README.md" },
      },
    ],
  },
});

const userToolResult = cast({
  type: "user",
  session_id: SESSION_ID,
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_01", content: "# readme" },
    ],
  },
});

function resultSuccess(
  overrides: Record<string, unknown> = {},
): SDKMessage {
  return cast({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Opened PR #12.",
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 3,
    total_cost_usd: 0.4211,
    session_id: SESSION_ID,
    uuid: "u-result",
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 44,
    },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 100,
        outputTokens: 200,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 40,
        webSearchRequests: 0,
        costUSD: 0.4211,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    },
    ...overrides,
  });
}

// --- fake query -----------------------------------------------------------
interface FakeCall {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options | undefined;
}

interface Fake {
  fn: ClaudeQueryFn;
  calls: FakeCall[];
  abortObserved: boolean;
}

function fakeQuery(
  script: (fake: Fake, call: FakeCall) => AsyncGenerator<SDKMessage>,
): Fake {
  const fake: Fake = {
    calls: [],
    abortObserved: false,
    fn: (params) => {
      const call: FakeCall = {
        prompt: params.prompt,
        options: params.options,
      };
      fake.calls.push(call);
      // The SDK is cancelled through the `abortController` option, so that is
      // what the fake watches — teardown of the scripted generator is not
      // evidence the query was aborted.
      call.options?.abortController?.signal.addEventListener("abort", () => {
        fake.abortObserved = true;
      });
      return script(fake, call);
    },
  };
  return fake;
}

function scripted(messages: SDKMessage[]): Fake {
  return fakeQuery(async function* () {
    for (const message of messages) yield message;
  });
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const tempRoots: string[] = [];
async function makeSessionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestra-sessions-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

// --- tests ----------------------------------------------------------------
describe("ClaudeAdapter.start (design.md §7.1 message mapping)", () => {
  it("maps a full turn to session, text, tool_call, tool_result, usage, turn_done", async () => {
    const fake = scripted([
      systemInit,
      assistantText,
      assistantToolUse,
      userToolResult,
      resultSuccess(),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events.map((e) => e.type)).toEqual([
      "session",
      "text",
      "tool_call",
      "tool_result",
      "usage",
      "turn_done",
    ]);
    expect(events[0]).toEqual({ type: "session", sessionId: SESSION_ID });
    expect(events[1]).toEqual({
      type: "text",
      delta: "Reading the repository.",
    });
    expect(events[2]).toEqual({
      type: "tool_call",
      name: "Read",
      input: { file_path: "/work/exec-1/README.md" },
    });
    expect(events[3]).toEqual({ type: "tool_result", name: "Read", ok: true });
    expect(events[4]).toEqual({
      type: "usage",
      model: "claude-sonnet-5",
      input: 100,
      cached: 300,
      output: 200,
      costUsd: 0.4211,
    });
    expect(events[5]).toEqual({ type: "turn_done", finalText: "Opened PR #12." });
  });

  it("reports a failed tool_result as not ok", async () => {
    const failed = cast({
      type: "user",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            is_error: true,
            content: "ENOENT",
          },
        ],
      },
    });
    const fake = scripted([systemInit, assistantToolUse, failed]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events.at(-1)).toEqual({
      type: "tool_result",
      name: "Read",
      ok: false,
    });
  });

  it("falls back to the tool_use id when the name cannot be resolved", async () => {
    const orphan = cast({
      type: "user",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_99" }],
      },
    });
    const fake = scripted([systemInit, orphan]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events.at(-1)).toEqual({
      type: "tool_result",
      name: "toolu_99",
      ok: true,
    });
  });

  it("emits one usage event per model and attributes total_cost_usd once", async () => {
    const fake = scripted([
      systemInit,
      resultSuccess({
        total_cost_usd: 1.5,
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 1,
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
          "claude-haiku-5": {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.5,
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const usage = (
      await collect(adapter.start(startRequest, new AbortController().signal))
    ).filter((e) => e.type === "usage");

    expect(usage).toHaveLength(2);
    const costs = usage.map((e) => e.costUsd).filter((c) => c !== undefined);
    expect(costs).toEqual([1.5]);
  });

  it("falls back to the result usage block when modelUsage is absent", async () => {
    const fake = scripted([
      systemInit,
      resultSuccess({ modelUsage: undefined }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const usage = (
      await collect(adapter.start(startRequest, new AbortController().signal))
    ).filter((e) => e.type === "usage");

    expect(usage).toEqual([
      {
        type: "usage",
        model: "claude-sonnet-5",
        input: 11,
        cached: 33,
        output: 22,
        costUsd: 0.4211,
      },
    ]);
  });
});

describe("ClaudeAdapter query options (design.md §7.1)", () => {
  it("passes the orchestra MCP server as bearer-authenticated http", async () => {
    const fake = scripted([systemInit, assistantText, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    const options = fake.calls[0]?.options;
    // The header names ORCHESTRA_TOKEN, which the CLI expands from its env,
    // so the token never lands on the `--mcp-config` argv (design.md §8).
    expect(options?.mcpServers).toEqual({
      orchestra: {
        type: "http",
        url: "http://127.0.0.1:4599/mcp",
        headers: { Authorization: "Bearer ${ORCHESTRA_TOKEN}" },
      },
    });
    expect(options?.env?.ORCHESTRA_TOKEN).toBe(TOKEN);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("passes cwd, prompts, policy, budget, env and bypassed permissions on start", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(adapter.start(startRequest, new AbortController().signal));

    const call = fake.calls[0];
    expect(call?.prompt).toBe("Implement GOT-1.");
    expect(call?.options).toMatchObject({
      cwd: "/work/exec-1",
      systemPrompt: "You are the implementer.",
      model: "claude-sonnet-5",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxBudgetUsd: 5,
    });
    expect(call?.options?.env).toMatchObject({ ORCHESTRA_TOKEN: TOKEN });
    expect(call?.options?.allowedTools).toContain("mcp__orchestra__*");
    expect(call?.options?.resume).toBeUndefined();
  });

  it("leaves the built-in tool set at the runtime default for implementation", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(adapter.start(startRequest, new AbortController().signal));

    expect(fake.calls[0]?.options).not.toHaveProperty("tools");
  });

  for (const policy of ["spec", "review"] as const) {
    it(`denies anything outside the allow list for a ${policy} run`, async () => {
      // bypassPermissions would auto-approve every tool, which makes the
      // allow list decorative. `dontAsk` denies whatever is not pre-approved,
      // and `tools` keeps the unlisted built-ins out of the session entirely.
      const fake = scripted([systemInit, resultSuccess()]);
      const adapter = new ClaudeAdapter({ query: fake.fn });

      await collect(
        adapter.start(
          { ...startRequest, allowedTools: policy },
          new AbortController().signal,
        ),
      );

      const options = fake.calls[0]?.options;
      expect(options?.permissionMode).toBe("dontAsk");
      expect(options?.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
      expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
      expect(options?.allowedTools).toEqual(allowedToolsFor(policy));
    });
  }

  it("never configures the orchestra MCP server for a review run, and never puts ORCHESTRA_TOKEN in its env even when req.env carries one (start) (commit cadff5c, design.md §9.8)", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.start(
        {
          ...startRequest,
          allowedTools: "review",
          env: { ...startRequest.env, ORCHESTRA_TOKEN: TOKEN },
        },
        new AbortController().signal,
      ),
    );

    const options = fake.calls[0]?.options;
    expect(options?.mcpServers).not.toHaveProperty("orchestra");
    expect(options?.env).not.toHaveProperty("ORCHESTRA_TOKEN");
  });

  it("never configures the orchestra MCP server for a review run, and never puts ORCHESTRA_TOKEN in its env even when req.env carries one (resume) (commit cadff5c, design.md §9.8)", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.resume(
        {
          ...resumeRequest,
          allowedTools: "review",
          env: { ...resumeRequest.env, ORCHESTRA_TOKEN: TOKEN },
        },
        new AbortController().signal,
      ),
    );

    const options = fake.calls[0]?.options;
    expect(options?.mcpServers).not.toHaveProperty("orchestra");
    expect(options?.env).not.toHaveProperty("ORCHESTRA_TOKEN");
  });

  it("strips an ORCHESTRA_TOKEN inherited from process.env for a review run, not merely omits adding one (commit cadff5c, design.md §9.8)", async () => {
    process.env.ORCHESTRA_TOKEN = "leaked-from-process-env";
    try {
      const fake = scripted([systemInit, resultSuccess()]);
      const adapter = new ClaudeAdapter({ query: fake.fn });

      await collect(
        adapter.start(
          { ...startRequest, allowedTools: "review", env: {} },
          new AbortController().signal,
        ),
      );

      const options = fake.calls[0]?.options;
      expect(options?.env).not.toHaveProperty("ORCHESTRA_TOKEN");
    } finally {
      delete process.env.ORCHESTRA_TOKEN;
    }
  });

  for (const policy of ["implementation", "spec"] as const) {
    it(`start (${policy}): options.env.ORCHESTRA_TOKEN is req.mcp.token even when req.env and process.env carry different stale values (design.md §8, §9.9)`, async () => {
      process.env.ORCHESTRA_TOKEN = "stale-token-from-process-env";
      try {
        const fake = scripted([systemInit, resultSuccess()]);
        const adapter = new ClaudeAdapter({ query: fake.fn });

        await collect(
          adapter.start(
            {
              ...startRequest,
              allowedTools: policy,
              env: {
                ...startRequest.env,
                ORCHESTRA_TOKEN: "stale-token-from-req-env",
              },
            },
            new AbortController().signal,
          ),
        );

        expect(fake.calls[0]?.options?.env?.ORCHESTRA_TOKEN).toBe(
          startRequest.mcp.token,
        );
      } finally {
        delete process.env.ORCHESTRA_TOKEN;
      }
    });

    it(`resume (${policy}): options.env.ORCHESTRA_TOKEN is req.mcp.token even when req.env and process.env carry different stale values (design.md §8, §9.9)`, async () => {
      process.env.ORCHESTRA_TOKEN = "stale-token-from-process-env";
      try {
        const fake = scripted([systemInit, resultSuccess()]);
        const adapter = new ClaudeAdapter({ query: fake.fn });

        await collect(
          adapter.resume(
            {
              ...resumeRequest,
              allowedTools: policy,
              env: {
                ...resumeRequest.env,
                ORCHESTRA_TOKEN: "stale-token-from-req-env",
              },
            },
            new AbortController().signal,
          ),
        );

        expect(fake.calls[0]?.options?.env?.ORCHESTRA_TOKEN).toBe(
          resumeRequest.mcp.token,
        );
      } finally {
        delete process.env.ORCHESTRA_TOKEN;
      }
    });
  }

  it("still withholds the orchestra MCP server and token from a review run that also carries a testCommand", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.start(
        {
          ...startRequest,
          allowedTools: "review",
          testCommand: "pnpm -r test",
        },
        new AbortController().signal,
      ),
    );

    const options = fake.calls[0]?.options;
    expect(options?.mcpServers).not.toHaveProperty("orchestra");
    expect(options?.env).not.toHaveProperty("ORCHESTRA_TOKEN");
  });

  it("grants Bash(<testCommand>) to a review run that carries one (design.md §7.1)", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.start(
        {
          ...startRequest,
          allowedTools: "review",
          testCommand: "pnpm -r test",
        },
        new AbortController().signal,
      ),
    );

    const options = fake.calls[0]?.options;
    expect(options?.allowedTools).toContain("Bash(pnpm -r test)");
    expect(options?.tools).toContain("Bash");
  });

  it("does not grant Bash to a review run without a testCommand", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.start(
        { ...startRequest, allowedTools: "review" },
        new AbortController().signal,
      ),
    );

    const options = fake.calls[0]?.options;
    expect(options?.allowedTools).toEqual(allowedToolsFor("review"));
    expect(options?.tools).toEqual(builtinToolsFor("review"));
  });

  // F3: an empty or whitespace-only testCommand must reach validation and be
  // rejected the same as any other invalid value, not silently omit the
  // grant.
  const invalidTestCommands = ["pnpm test) Bash(rm -rf", "", "   "];

  for (const testCommand of invalidTestCommands) {
    it(`yields a single non-retriable error and never calls query for an invalid testCommand ${JSON.stringify(testCommand)} (start)`, async () => {
      const fake = scripted([systemInit, resultSuccess()]);
      const adapter = new ClaudeAdapter({ query: fake.fn });

      const events = await collect(
        adapter.start(
          {
            ...startRequest,
            allowedTools: "review",
            testCommand,
          },
          new AbortController().signal,
        ),
      );

      expect(events).toEqual([
        {
          type: "error",
          message: expect.any(String),
          retriable: false,
        },
      ]);
      expect(fake.calls).toHaveLength(0);
    });

    it(`yields a single non-retriable error and never calls query for an invalid testCommand ${JSON.stringify(testCommand)} (resume)`, async () => {
      const fake = scripted([systemInit, resultSuccess()]);
      const adapter = new ClaudeAdapter({ query: fake.fn });

      const events = await collect(
        adapter.resume(
          {
            ...resumeRequest,
            allowedTools: "review",
            testCommand,
          },
          new AbortController().signal,
        ),
      );

      expect(events).toEqual([
        {
          type: "error",
          message: expect.any(String),
          retriable: false,
        },
      ]);
      expect(fake.calls).toHaveLength(0);
    });
  }

  for (const policy of ["spec", "implementation"] as const) {
    it(`ignores testCommand for the ${policy} policy`, async () => {
      const fake = scripted([systemInit, resultSuccess()]);
      const adapter = new ClaudeAdapter({ query: fake.fn });

      await collect(
        adapter.start(
          { ...startRequest, allowedTools: policy, testCommand: "pnpm -r test" },
          new AbortController().signal,
        ),
      );

      const withCommand = fake.calls[0]?.options?.allowedTools;
      expect(withCommand).toEqual(allowedToolsFor(policy));
    });
  }

  it("merges the request env over the inherited process env", async () => {
    // Options.env REPLACES the subprocess environment, so a bare req.env
    // strips PATH and HOME from the CLI subprocess.
    process.env.ORCHESTRA_ENV_MERGE_PROBE = "inherited";
    try {
      const fake = scripted([systemInit, resultSuccess()]);
      const adapter = new ClaudeAdapter({ query: fake.fn });

      await collect(
        adapter.start(
          {
            ...startRequest,
            env: { ORCHESTRA_TOKEN: TOKEN, ORCHESTRA_ENV_MERGE_PROBE: "request" },
          },
          new AbortController().signal,
        ),
      );

      const env = fake.calls[0]?.options?.env;
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env?.ORCHESTRA_TOKEN).toBe(TOKEN);
      expect(env?.ORCHESTRA_ENV_MERGE_PROBE).toBe("request");
    } finally {
      delete process.env.ORCHESTRA_ENV_MERGE_PROBE;
    }
  });

  it("omits model and maxBudgetUsd when the request omits them", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.start(
        {
          cwd: startRequest.cwd,
          systemPrompt: startRequest.systemPrompt,
          prompt: startRequest.prompt,
          allowedTools: startRequest.allowedTools,
          mcp: startRequest.mcp,
          env: startRequest.env,
        },
        new AbortController().signal,
      ),
    );

    expect(fake.calls[0]?.options).not.toHaveProperty("model");
    expect(fake.calls[0]?.options).not.toHaveProperty("maxBudgetUsd");
  });

  it("resumes with resume: sessionId and no systemPrompt", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.resume(
        {
          cwd: startRequest.cwd,
          prompt: startRequest.prompt,
          model: startRequest.model,
          allowedTools: startRequest.allowedTools,
          mcp: startRequest.mcp,
          env: startRequest.env,
          maxBudgetUsd: startRequest.maxBudgetUsd,
          sessionId: SESSION_ID,
        },
        new AbortController().signal,
      ),
    );

    const options = fake.calls[0]?.options;
    expect(options?.resume).toBe(SESSION_ID);
    expect(options).not.toHaveProperty("systemPrompt");
    expect(options).toMatchObject({ cwd: "/work/exec-1" });
  });

  it("applies the read-only policy for a spec run", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.start(
        { ...startRequest, allowedTools: "spec" },
        new AbortController().signal,
      ),
    );

    expect(fake.calls[0]?.options?.allowedTools).not.toContain("Write");
  });

  for (const [policy, expected] of [
    ["spec", []],
    ["review", []],
    ["implementation", ["project"]],
  ] as const) {
    it(`sets settingSources to ${JSON.stringify(expected)} for ${policy} (sdk.d.ts ~2245)`, async () => {
      const fake = scripted([systemInit, resultSuccess()]);
      const adapter = new ClaudeAdapter({ query: fake.fn });

      await collect(
        adapter.start(
          { ...startRequest, allowedTools: policy },
          new AbortController().signal,
        ),
      );

      expect(fake.calls[0]?.options?.settingSources).toEqual(expected);
    });
  }

  it("carries settingSources through resume too", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(
      adapter.resume(
        { ...resumeRequest, allowedTools: "spec" },
        new AbortController().signal,
      ),
    );

    expect(fake.calls[0]?.options?.settingSources).toEqual([]);
  });
});

describe("ClaudeAdapter.resume usage accounting (cumulative SDK totals)", () => {
  async function usageOf(req: ResumeRequest): Promise<AgentEvent[]> {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });
    const events = await collect(
      adapter.resume(req, new AbortController().signal),
    );
    return events.filter((e) => e.type === "usage");
  }

  it("emits the SDK totals unchanged when no baseline is supplied", async () => {
    expect(await usageOf(resumeRequest)).toEqual([
      {
        type: "usage",
        model: "claude-sonnet-5",
        input: 100,
        cached: 300,
        output: 200,
        costUsd: 0.4211,
      },
    ]);
  });

  it("emits only the delta since the baseline of the resumed session", async () => {
    // `total_cost_usd` and `modelUsage` cover the whole session, so a resume
    // without subtraction re-bills every earlier turn.
    const usage = await usageOf({
      ...resumeRequest,
      usageBaseline: {
        "claude-sonnet-5": { input: 60, cached: 100, output: 150, costUsd: 0.2 },
      },
    });

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      type: "usage",
      model: "claude-sonnet-5",
      input: 40,
      cached: 200,
      output: 50,
    });
    expect(usage[0] as { costUsd?: number }).toHaveProperty("costUsd");
    expect((usage[0] as { costUsd?: number }).costUsd).toBeCloseTo(0.2211, 6);
  });

  it("clamps at zero when the baseline is at or above the SDK totals", async () => {
    const usage = await usageOf({
      ...resumeRequest,
      usageBaseline: {
        "claude-sonnet-5": { input: 999, cached: 999, output: 999, costUsd: 9 },
      },
    });

    expect(usage).toEqual([
      {
        type: "usage",
        model: "claude-sonnet-5",
        input: 0,
        cached: 0,
        output: 0,
        costUsd: 0,
      },
    ]);
  });

  it("subtracts each model's own baseline independently in a multi-model turn", async () => {
    // Each model's baseline is much closer to its own cumulative than to the
    // other model's: a baseline consumed greedily across models (rather than
    // matched by model) would misattribute these deltas.
    const fake = scripted([
      systemInit,
      resultSuccess({
        total_cost_usd: 1.5,
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 1,
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
          "claude-haiku-5": {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.5,
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const usage = (
      await collect(
        adapter.resume(
          {
            ...resumeRequest,
            usageBaseline: {
              "claude-sonnet-5": { input: 5, cached: 10, output: 5, costUsd: 0.3 },
              "claude-haiku-5": { input: 20, cached: 100, output: 50, costUsd: 0.2 },
            },
          },
          new AbortController().signal,
        ),
      )
    ).filter((e) => e.type === "usage");

    expect(usage).toHaveLength(2);
    const sonnet = usage.find(
      (e) => "model" in e && e.model === "claude-sonnet-5",
    );
    const haiku = usage.find(
      (e) => "model" in e && e.model === "claude-haiku-5",
    );
    expect(sonnet).toMatchObject({ input: 5, cached: 20, output: 15 });
    expect(haiku).toMatchObject({ input: 80, cached: 200, output: 150 });

    // Cost is a single session-wide delta (total_cost_usd minus the sum of
    // every model's baseline costUsd), attributed to exactly one event.
    const costs = usage
      .map((e) => (e as { costUsd?: number }).costUsd)
      .filter((c): c is number => c !== undefined);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toBeCloseTo(1.5 - (0.3 + 0.2), 6);
  });

  it("emits a model absent from the baseline unchanged", async () => {
    const fake = scripted([
      systemInit,
      resultSuccess({
        total_cost_usd: 1.5,
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 1,
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
          "claude-haiku-5": {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.5,
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const usage = (
      await collect(
        adapter.resume(
          {
            ...resumeRequest,
            usageBaseline: {
              "claude-sonnet-5": { input: 5, cached: 10, output: 5, costUsd: 1 },
            },
          },
          new AbortController().signal,
        ),
      )
    ).filter((e) => e.type === "usage");

    const haiku = usage.find(
      (e) => "model" in e && e.model === "claude-haiku-5",
    );
    expect(haiku).toMatchObject({ input: 100, cached: 300, output: 200 });
  });

  it("applies the baseline to the fallback usage block too", async () => {
    const fake = scripted([
      systemInit,
      resultSuccess({ modelUsage: undefined }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const usage = (
      await collect(
        adapter.resume(
          {
            ...resumeRequest,
            usageBaseline: {
              "claude-sonnet-5": { input: 1, cached: 3, output: 2, costUsd: 0.4 },
            },
          },
          new AbortController().signal,
        ),
      )
    ).filter((e) => e.type === "usage");

    expect(usage[0]).toMatchObject({ input: 10, cached: 30, output: 20 });
    expect((usage[0] as { costUsd?: number }).costUsd).toBeCloseTo(0.0211, 6);
  });

  it("leaves start on the SDK totals: a fresh session has no earlier turns", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const usage = (
      await collect(adapter.start(startRequest, new AbortController().signal))
    ).filter((e) => e.type === "usage");

    expect(usage).toEqual([
      {
        type: "usage",
        model: "claude-sonnet-5",
        input: 100,
        cached: 300,
        output: 200,
        costUsd: 0.4211,
      },
    ]);
  });
});

describe("ClaudeAdapter secret redaction (§8 execution token)", () => {
  it("keeps the execution token out of every emitted event", async () => {
    // A tool call can echo the token: the review wrapper is invoked with it,
    // and a failing MCP call can quote the Authorization header back.
    const leakyToolUse = cast({
      type: "assistant",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      uuid: "u-leak",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `exporting ORCHESTRA_TOKEN=${TOKEN}` },
          {
            type: "tool_use",
            id: "toolu_07",
            name: "Bash",
            input: {
              command: `curl -H 'Authorization: Bearer ${TOKEN}' http://127.0.0.1:4599/mcp`,
              nested: { token: TOKEN },
            },
          },
        ],
      },
    });
    const fake = scripted([
      systemInit,
      leakyToolUse,
      resultSuccess({
        subtype: "error_during_execution",
        is_error: true,
        result: undefined,
        errors: [`401 from http://127.0.0.1:4599/mcp with bearer ${TOKEN}`],
      }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(events[1]).toEqual({
      type: "text",
      delta: "exporting ORCHESTRA_TOKEN=[redacted]",
    });
    expect(events[2]).toEqual({
      type: "tool_call",
      name: "Bash",
      input: {
        command:
          "curl -H 'Authorization: Bearer [redacted]' http://127.0.0.1:4599/mcp",
        nested: { token: "[redacted]" },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("[redacted]"),
    });
  });

  it("redacts the token out of a thrown SDK error too", async () => {
    // eslint-disable-next-line require-yield
    const fake = fakeQuery(async function* () {
      throw new Error(`connect failed with Bearer ${TOKEN}`);
    });
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(events[0]).toMatchObject({
      type: "error",
      message: "connect failed with Bearer [redacted]",
    });
  });

  it("leaves events untouched when the request carries no token", async () => {
    const fake = scripted([systemInit, assistantText, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(
        { ...startRequest, mcp: { url: startRequest.mcp.url, token: "" } },
        new AbortController().signal,
      ),
    );

    expect(events[1]).toEqual({
      type: "text",
      delta: "Reading the repository.",
    });
  });
});

describe("ClaudeAdapter abort handling (design.md §7: cancel is the AbortSignal)", () => {
  it("aborts the query and ends the iterator without throwing when the SDK unwinds", async () => {
    // Aborted while the adapter is awaiting the next SDK message, which is
    // how a real run cancels: the SDK throws an AbortError out of the stream.
    const fake = fakeQuery(async function* (_self, call) {
      yield systemInit;
      const signal = call.options?.abortController?.signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve();
        });
      });
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const adapter = new ClaudeAdapter({ query: fake.fn });
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    for await (const event of adapter.start(startRequest, controller.signal)) {
      events.push(event);
      setTimeout(() => {
        controller.abort();
      }, 0);
    }

    expect(events.map((e) => e.type)).toEqual(["session"]);
    expect(fake.abortObserved).toBe(true);
  });

  it("stops yielding as soon as the signal fires between events", async () => {
    const fake = scripted([
      systemInit,
      assistantText,
      assistantToolUse,
      resultSuccess(),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    for await (const event of adapter.start(startRequest, controller.signal)) {
      events.push(event);
      controller.abort();
    }

    expect(events.map((e) => e.type)).toEqual(["session"]);
    expect(fake.abortObserved).toBe(true);
  });

  it("drops the remaining events of a message aborted part way through", async () => {
    // One assistant message can carry several blocks. The signal must be
    // honoured between them, not only between SDK messages.
    const multiBlock = cast({
      type: "assistant",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      uuid: "u-multi",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
          { type: "tool_use", id: "toolu_02", name: "Grep", input: {} },
        ],
      },
    });
    const fake = scripted([multiBlock, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    for await (const event of adapter.start(startRequest, controller.signal)) {
      events.push(event);
      controller.abort();
    }

    expect(events).toEqual([{ type: "text", delta: "first" }]);
  });

  it("yields nothing and never calls query when the signal is already aborted", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(adapter.start(startRequest, controller.signal));

    expect(events).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("ClaudeAdapter error mapping (design.md §9.5)", () => {
  it("maps an error result subtype to a retriable error event after usage", async () => {
    const fake = scripted([
      systemInit,
      resultSuccess({
        subtype: "error_during_execution",
        is_error: true,
        result: undefined,
        errors: ["Request failed with status 529 overloaded"],
      }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events.map((e) => e.type)).toEqual(["session", "usage", "error"]);
    const error = events.at(-1);
    expect(error).toMatchObject({ type: "error", retriable: true });
    expect(error).toHaveProperty("message", expect.stringContaining("529"));
  });

  it("maps a budget-exhausted result to a terminal error event", async () => {
    const fake = scripted([
      systemInit,
      resultSuccess({
        subtype: "error_max_budget_usd",
        is_error: true,
        result: undefined,
        errors: [],
      }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events.at(-1)).toMatchObject({ type: "error", retriable: false });
  });

  it("maps a success result flagged is_error to an error event", async () => {
    const fake = scripted([
      systemInit,
      resultSuccess({ is_error: true, result: "authentication_failed" }),
    ]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events.at(-1)).toMatchObject({ type: "error", retriable: false });
  });

  it("maps an SDK throw to an error event and then ends the iterator", async () => {
    // eslint-disable-next-line require-yield
    const fake = fakeQuery(async function* () {
      throw new Error("read ECONNRESET");
    });
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events).toEqual([
      {
        type: "error",
        message: expect.stringContaining("ECONNRESET"),
        retriable: true,
      },
    ]);
  });

  it("still reports a message when the SDK throws a non-Error value", async () => {
    // eslint-disable-next-line require-yield
    const fake = fakeQuery(async function* () {
      throw undefined;
    });
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events).toHaveLength(1);
    const error = events[0];
    expect(error?.type).toBe("error");
    expect((error as { message: string }).message).not.toBe("");
    expect(typeof (error as { message: string }).message).toBe("string");
    expect(error).toMatchObject({ retriable: true });
  });

  it("survives a thrown value that cannot be serialised", async () => {
    const circular: Record<string, unknown> = { code: "EAGAIN" };
    circular.self = circular;
    // eslint-disable-next-line require-yield
    const fake = fakeQuery(async function* () {
      throw circular;
    });
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect((events[0] as { message: string }).message).not.toBe("");
  });

  it("reports an Error with an empty message as a non-empty failure", async () => {
    // eslint-disable-next-line require-yield
    const fake = fakeQuery(async function* () {
      throw new Error("");
    });
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect((events[0] as { message: string }).message).not.toBe("");
  });
});

describe("ClaudeAdapter.canResume (SDK session store on disk)", () => {
  it("encodes a cwd the way the Claude session store does", () => {
    expect(encodeProjectDir("/Users/goopterdev/Src/goopter_ticket_orchestra")).toBe(
      "-Users-goopterdev-Src-goopter-ticket-orchestra",
    );
  });

  it("returns true when the session transcript exists for that cwd", async () => {
    const root = await makeSessionRoot();
    const cwd = "/work/exec-1";
    await mkdir(join(root, encodeProjectDir(cwd)), { recursive: true });
    await writeFile(join(root, encodeProjectDir(cwd), `${SESSION_ID}.jsonl`), "");
    const adapter = new ClaudeAdapter({ sessionRoot: root });

    await expect(adapter.canResume(SESSION_ID, cwd)).resolves.toBe(true);
  });

  it("finds a session stored under the resolved cwd when the cwd is a symlink", async () => {
    // Regression: the smoke run against the real SDK stored the session under
    // /private/var/... while the caller passed the /var/... symlink, so
    // canResume said false for a live session.
    const root = await makeSessionRoot();
    const workspace = await mkdtemp(join(tmpdir(), "orchestra-workspace-"));
    tempRoots.push(workspace);
    const target = join(workspace, "real-worktree");
    const link = join(workspace, "linked-worktree");
    await mkdir(target, { recursive: true });
    await symlink(target, link);

    const stored = encodeProjectDir(await realpath(link));
    await mkdir(join(root, stored), { recursive: true });
    await writeFile(join(root, stored, `${SESSION_ID}.jsonl`), "");
    const adapter = new ClaudeAdapter({ sessionRoot: root });

    await expect(adapter.canResume(SESSION_ID, link)).resolves.toBe(true);
  });

  it("returns false when the transcript is absent", async () => {
    const root = await makeSessionRoot();
    await mkdir(join(root, encodeProjectDir("/work/exec-1")), {
      recursive: true,
    });
    const adapter = new ClaudeAdapter({ sessionRoot: root });

    await expect(adapter.canResume(SESSION_ID, "/work/exec-1")).resolves.toBe(
      false,
    );
  });

  it("returns false rather than throwing when the session root does not exist", async () => {
    const adapter = new ClaudeAdapter({
      sessionRoot: join(tmpdir(), "orchestra-no-such-root-3f9a"),
    });

    await expect(adapter.canResume(SESSION_ID, "/work/exec-1")).resolves.toBe(
      false,
    );
  });

  it("returns false for a session id that is not a plain identifier", async () => {
    const root = await makeSessionRoot();
    const adapter = new ClaudeAdapter({ sessionRoot: root });

    await expect(
      adapter.canResume("../../etc/passwd", "/work/exec-1"),
    ).resolves.toBe(false);
  });
});

describe("ClaudeAdapter identity", () => {
  it("reports the claude runtime", () => {
    expect(new ClaudeAdapter().runtime).toBe("claude");
  });
});

// --- injected process spawner (design.md §9.9) ------------------------------

interface SpawnerCall {
  command: string;
  args: readonly string[];
  options: ProcessSpawnOptions;
}

interface FakeProcess {
  process: AgentProcess;
  kills: (NodeJS.Signals | undefined)[];
  exit: (outcome: ProcessExit) => void;
  fail: (error: Error) => void;
}

function fakeProcess(): FakeProcess {
  let exit!: (outcome: ProcessExit) => void;
  let fail!: (error: Error) => void;
  const exitP = new Promise<ProcessExit>((resolve, reject) => {
    exit = resolve;
    fail = reject;
  });
  const kills: (NodeJS.Signals | undefined)[] = [];
  return {
    process: {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exit: exitP,
      kill(signal) {
        kills.push(signal);
      },
    },
    kills,
    exit,
    fail,
  };
}

function recordingSpawner(): {
  spawn: ProcessSpawner;
  calls: SpawnerCall[];
  children: FakeProcess[];
} {
  const calls: SpawnerCall[] = [];
  const children: FakeProcess[] = [];
  const spawn: ProcessSpawner = (command, args, options) => {
    calls.push({ command, args, options });
    const child = fakeProcess();
    children.push(child);
    return child.process;
  };
  return { spawn, calls, children };
}

/** The SDK spawn hook the adapter handed to `query` on its first call. */
function sdkSpawnHook(fake: Fake): NonNullable<Options["spawnClaudeCodeProcess"]> {
  const hook = fake.calls[0]?.options?.spawnClaudeCodeProcess;
  if (hook === undefined) throw new Error("spawnClaudeCodeProcess was not set");
  return hook;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const sdkSpawnOptions = (
  signal: AbortSignal = new AbortController().signal,
): SpawnOptions => ({
  command: "/usr/local/bin/claude",
  args: ["--output-format", "stream-json", "--verbose"],
  cwd: "/work/exec-1",
  env: { PATH: "/usr/bin", ORCHESTRA_TOKEN: TOKEN },
  signal,
});

describe("ClaudeAdapter process spawner (design.md §9.9)", () => {
  it("does not set spawnClaudeCodeProcess on start or resume without a spawner", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const adapter = new ClaudeAdapter({ query: fake.fn });

    await collect(adapter.start(startRequest, new AbortController().signal));
    await collect(adapter.resume(resumeRequest, new AbortController().signal));

    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.options).toBeDefined();
      expect("spawnClaudeCodeProcess" in call.options!).toBe(false);
    }
  });

  it("sets spawnClaudeCodeProcess on both start and resume with a spawner", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const { spawn } = recordingSpawner();
    const adapter = new ClaudeAdapter({ query: fake.fn, spawn });

    await collect(adapter.start(startRequest, new AbortController().signal));
    await collect(adapter.resume(resumeRequest, new AbortController().signal));

    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(typeof call.options?.spawnClaudeCodeProcess).toBe("function");
    }
    // Resume still carries the session and no system prompt.
    expect(fake.calls[1]!.options?.resume).toBe(SESSION_ID);
    expect("systemPrompt" in fake.calls[1]!.options!).toBe(false);
  });

  it("passes the SDK's command, args, cwd and env through to the spawner", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const spawner = recordingSpawner();
    await collect(
      new ClaudeAdapter({ query: fake.fn, spawn: spawner.spawn }).start(
        startRequest,
        new AbortController().signal,
      ),
    );

    const options = sdkSpawnOptions();
    const spawned = sdkSpawnHook(fake)(options);

    expect(spawner.calls).toEqual([
      {
        command: "/usr/local/bin/claude",
        args: ["--output-format", "stream-json", "--verbose"],
        options: { cwd: "/work/exec-1", env: options.env },
      },
    ]);
    const child = spawner.children[0]!.process;
    expect(spawned.stdin).toBe(child.stdin);
    expect(spawned.stdout).toBe(child.stdout);
  });

  it("falls back to the current directory when the SDK gives no cwd", async () => {
    const fake = scripted([systemInit, resultSuccess()]);
    const spawner = recordingSpawner();
    await collect(
      new ClaudeAdapter({ query: fake.fn, spawn: spawner.spawn }).start(
        startRequest,
        new AbortController().signal,
      ),
    );
    const options = sdkSpawnOptions();
    delete options.cwd;
    sdkSpawnHook(fake)(options);
    expect(spawner.calls[0]!.options.cwd).toBe(process.cwd());
  });

  describe("the returned process meets the SDK's SpawnedProcess contract", () => {
    async function spawned(signal?: AbortSignal): Promise<{
      proc: SpawnedProcess;
      child: FakeProcess;
    }> {
      const fake = scripted([systemInit, resultSuccess()]);
      const spawner = recordingSpawner();
      await collect(
        new ClaudeAdapter({ query: fake.fn, spawn: spawner.spawn }).start(
          startRequest,
          new AbortController().signal,
        ),
      );
      const proc = sdkSpawnHook(fake)(sdkSpawnOptions(signal));
      return { proc, child: spawner.children[0]! };
    }

    it("reports running, then emits exit with code and signal and records them", async () => {
      const { proc, child } = await spawned();
      expect(proc.exitCode).toBeNull();
      expect(proc.signalCode ?? null).toBeNull();
      expect(proc.killed).toBe(false);

      const onExit: [number | null, NodeJS.Signals | null][] = [];
      const onceExit: [number | null, NodeJS.Signals | null][] = [];
      proc.on("exit", (code, signal) => onExit.push([code, signal]));
      proc.once("exit", (code, signal) => onceExit.push([code, signal]));

      child.exit({ code: 0, signal: null });
      await tick();

      expect(onExit).toEqual([[0, null]]);
      expect(onceExit).toEqual([[0, null]]);
      expect(proc.exitCode).toBe(0);
      expect(proc.signalCode ?? null).toBeNull();
    });

    it("records a signal exit as signalCode with a null exitCode", async () => {
      const { proc, child } = await spawned();
      const seen: [number | null, NodeJS.Signals | null][] = [];
      proc.on("exit", (code, signal) => seen.push([code, signal]));

      child.exit({ code: null, signal: "SIGTERM" });
      await tick();

      expect(seen).toEqual([[null, "SIGTERM"]]);
      expect(proc.exitCode).toBeNull();
      expect(proc.signalCode).toBe("SIGTERM");
    });

    it("off removes an exit listener", async () => {
      const { proc, child } = await spawned();
      const seen: number[] = [];
      const listener = (): void => {
        seen.push(1);
      };
      proc.on("exit", listener);
      proc.off("exit", listener);

      child.exit({ code: 0, signal: null });
      await tick();
      expect(seen).toEqual([]);
    });

    it("emits error when the process never started", async () => {
      const { proc, child } = await spawned();
      const errors: Error[] = [];
      const exits: unknown[] = [];
      proc.on("error", (error) => errors.push(error));
      proc.on("exit", (...args) => exits.push(args));

      child.fail(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
      await tick();

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("spawn docker ENOENT");
      expect(exits).toEqual([]);
    });

    it("does not throw when the process fails with no error listener", async () => {
      const { child } = await spawned();
      child.fail(new Error("spawn docker ENOENT"));
      await tick();
    });

    it("kill forwards the SDK's signal to the spawner's group kill and marks the process killed", async () => {
      const { proc, child } = await spawned();

      expect(proc.kill("SIGTERM")).toBe(true);
      expect(proc.killed).toBe(true);
      expect(proc.kill("SIGKILL")).toBe(true);
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("kill after exit is a no-op that reaches no process group", async () => {
      const { proc, child } = await spawned();
      child.exit({ code: 0, signal: null });
      await tick();

      expect(proc.kill("SIGTERM")).toBe(false);
      expect(proc.killed).toBe(false);
      expect(child.kills).toEqual([]);
    });

    it("kills the group with SIGTERM when the SDK's forwarded signal aborts", async () => {
      const controller = new AbortController();
      const { proc, child } = await spawned(controller.signal);
      expect(child.kills).toEqual([]);

      controller.abort();
      expect(child.kills).toEqual(["SIGTERM"]);
      expect(proc.killed).toBe(true);
    });

    it("kills at once when the forwarded signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { child } = await spawned(controller.signal);
      expect(child.kills).toEqual(["SIGTERM"]);
    });

    it("ignores the forwarded signal once the process has exited", async () => {
      const controller = new AbortController();
      const { child } = await spawned(controller.signal);
      child.exit({ code: 0, signal: null });
      await tick();

      controller.abort();
      expect(child.kills).toEqual([]);
    });

    it("drains stderr so a full pipe cannot stall the CLI", async () => {
      const { child } = await spawned();
      const stderr = child.process.stderr as PassThrough;
      // Far past the default high-water mark: a stream nobody reads stops
      // accepting writes and `write` returns false.
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 8; i++) stderr.write(chunk);
      await tick();
      expect(stderr.readableFlowing).toBe(true);
      expect(stderr.readableLength).toBe(0);
    });
  });
});

// --- stderr tail on a spawner crash (F1, design.md §7.1, §9.5) -------------

/**
 * Scripts a query that spawns through the SDK's hook, writes `stderrText` to
 * the spawned process's stderr, exits it non-zero, then throws `thrown` —
 * the shape of a real crash: with a custom spawner the SDK's own thrown exit
 * error carries no stderr text of its own (F1).
 */
function crashingSpawnerQuery(
  spawner: ReturnType<typeof recordingSpawner>,
  stderrText: string,
  thrown: string,
): Fake {
  return fakeQuery(async function* (_self, call) {
    const hook = call.options?.spawnClaudeCodeProcess;
    if (!hook) throw new Error("no spawner installed");
    hook(sdkSpawnOptions(call.options?.abortController?.signal));
    const child = spawner.children[0]!.process.stderr as PassThrough;
    child.write(stderrText);
    await tick();
    spawner.children[0]!.exit({ code: 1, signal: null });
    await tick();
    throw new Error(thrown);
  });
}

describe("ClaudeAdapter stderr tail on a spawner crash (F1, design.md §7.1, §9.5)", () => {
  it("includes the spawned process's stderr in the thrown error and reclassifies it via classifyRetriable", async () => {
    const spawner = recordingSpawner();
    // The thrown SDK error alone ("exited with code 1") matches no terminal
    // pattern, so without the stderr tail this would wrongly retry a
    // terminal auth failure.
    const fake = crashingSpawnerQuery(
      spawner,
      "authentication_failed: invalid api key\n",
      "Claude Code process exited with code 1",
    );
    const adapter = new ClaudeAdapter({ query: fake.fn, spawn: spawner.spawn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events).toHaveLength(1);
    const error = events[0] as { type: string; message: string; retriable: boolean };
    expect(error.type).toBe("error");
    expect(error.message).toContain("Claude Code process exited with code 1");
    expect(error.message).toContain("authentication_failed: invalid api key");
    expect(error.retriable).toBe(classifyRetriable(error.message));
    expect(error.retriable).toBe(false);
  });

  it("redacts the execution token out of the stderr tail", async () => {
    const spawner = recordingSpawner();
    const fake = crashingSpawnerQuery(
      spawner,
      `fatal: request failed, Authorization: Bearer ${TOKEN}\n`,
      "Claude Code process exited with code 1",
    );
    const adapter = new ClaudeAdapter({ query: fake.fn, spawn: spawner.spawn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(JSON.stringify(events)).not.toContain(TOKEN);
    const error = events[0] as { message: string };
    expect(error.message).toContain("[redacted]");
  });

  it("keeps only the last 4096 characters of a long stderr stream", async () => {
    const spawner = recordingSpawner();
    const filler = "x".repeat(5000);
    const fake = crashingSpawnerQuery(
      spawner,
      `${filler}TAIL-MARKER`,
      "Claude Code process exited with code 1",
    );
    const adapter = new ClaudeAdapter({ query: fake.fn, spawn: spawner.spawn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    const error = events[0] as { message: string };
    expect(error.message).toContain("TAIL-MARKER");
    const detail = error.message.split("Claude Code process exited with code 1: ")[1]!;
    expect(detail.length).toBeLessThanOrEqual(4096);
  });

  it("does not append a stderr tail when no spawner is configured", async () => {
    // eslint-disable-next-line require-yield
    const fake = fakeQuery(async function* () {
      throw new Error("Claude Code process exited with code 1");
    });
    const adapter = new ClaudeAdapter({ query: fake.fn });

    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );

    expect(events).toEqual([
      {
        type: "error",
        message: "Claude Code process exited with code 1",
        retriable: true,
      },
    ]);
  });
});

// --- execution token stays off the CLI argv (design.md §8, §9.9) -----------
// The Agent SDK serialises `mcpServers` into a `--mcp-config <json>` argument,
// and argv is readable by any user on the host (`ps`) and shows up in a
// `docker exec` command line. These cases drive the real SDK `query` so the
// argv recorded is the one the SDK would actually launch the CLI with.

/** Records every CLI launch the real SDK makes: command, argv and env. */
interface CliLaunch {
  command: string;
  args: readonly string[];
  env: Record<string, string | undefined>;
}

/**
 * An SDK `SpawnedProcess` for a CLI that exits at once with code 1, so the
 * real SDK query fails fast after it has built and handed over its argv.
 */
function exitingSpawnedProcess(): SpawnedProcess {
  const child = fakeProcess();
  (child.process.stdout as PassThrough).end();
  setImmediate(() => child.exit({ code: 1, signal: null }));
  return {
    stdin: child.process.stdin,
    stdout: child.process.stdout,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    on: (event: string, listener: (...args: never[]) => void) => {
      if (event === "exit") {
        void child.process.exit.then((o) =>
          (listener as (c: number | null, s: null) => void)(o.code, null),
        );
      }
    },
    once: (event: string, listener: (...args: never[]) => void) => {
      if (event === "exit") {
        void child.process.exit.then((o) =>
          (listener as (c: number | null, s: null) => void)(o.code, null),
        );
      }
    },
    off: () => {},
  } as unknown as SpawnedProcess;
}

/**
 * Host mode: no `ProcessSpawner`, so the SDK would spawn the CLI itself. The
 * real SDK `query` runs with a recording `spawnClaudeCodeProcess` added only
 * here, after the adapter has built its options, so the recorded argv is the
 * one the SDK builds for a host launch.
 */
function hostModeRecorder(): { query: ClaudeQueryFn; launches: CliLaunch[] } {
  const launches: CliLaunch[] = [];
  const query: ClaudeQueryFn = (params) => {
    if (params.options?.spawnClaudeCodeProcess) {
      throw new Error("host mode must not install a spawner");
    }
    return sdkQuery({
      prompt: params.prompt,
      options: {
        ...params.options,
        spawnClaudeCodeProcess: (spawnOptions) => {
          launches.push({
            command: spawnOptions.command,
            args: spawnOptions.args,
            env: spawnOptions.env,
          });
          return exitingSpawnedProcess();
        },
      },
    });
  };
  return { query, launches };
}

/** Spawner mode: the adapter's own `ProcessSpawner` path, real SDK `query`. */
function spawnerModeRecorder(): { spawn: ProcessSpawner; launches: CliLaunch[] } {
  const launches: CliLaunch[] = [];
  const spawn: ProcessSpawner = (command, args, options) => {
    launches.push({ command, args, env: options.env });
    const child = fakeProcess();
    (child.process.stdout as PassThrough).end();
    setImmediate(() => child.exit({ code: 1, signal: null }));
    return child.process;
  };
  return { spawn, launches };
}

/** The `--mcp-config` JSON the SDK put on argv, parsed. */
function mcpConfigArg(args: readonly string[]): {
  mcpServers: Record<string, { headers?: Record<string, string> }>;
} {
  const at = args.indexOf("--mcp-config");
  if (at < 0 || at + 1 >= args.length) throw new Error("no --mcp-config on argv");
  return JSON.parse(args[at + 1]!);
}

describe("ClaudeAdapter keeps the execution token off the CLI argv (design.md §8, §9.9)", () => {
  let cwd: string;
  const argvCases: {
    mode: string;
    call: "start" | "resume";
  }[] = [
    { mode: "host", call: "start" },
    { mode: "host", call: "resume" },
    { mode: "spawner", call: "start" },
    { mode: "spawner", call: "resume" },
  ];

  async function launch(
    mode: string,
    call: "start" | "resume",
    env: Record<string, string> = startRequest.env,
  ): Promise<{ launches: CliLaunch[]; events: AgentEvent[] }> {
    cwd = await makeSessionRoot();
    let adapter: ClaudeAdapter;
    let launches: CliLaunch[];
    if (mode === "host") {
      const recorder = hostModeRecorder();
      adapter = new ClaudeAdapter({ query: recorder.query });
      launches = recorder.launches;
    } else {
      const recorder = spawnerModeRecorder();
      adapter = new ClaudeAdapter({ spawn: recorder.spawn });
      launches = recorder.launches;
    }
    const signal = new AbortController().signal;
    const stream =
      call === "start"
        ? adapter.start({ ...startRequest, cwd, env }, signal)
        : adapter.resume({ ...resumeRequest, cwd, env }, signal);
    const events = await collect(stream);
    return { launches, events };
  }

  it.each(argvCases)(
    "$mode mode $call: no CLI argument contains the token",
    async ({ mode, call }) => {
      const { launches, events } = await launch(mode, call);

      expect(launches).toHaveLength(1);
      const { command, args } = launches[0]!;
      expect(command).not.toContain(TOKEN);
      for (const arg of args) expect(arg).not.toContain(TOKEN);
      // The MCP server is still configured on argv, just without the secret.
      expect(args).toContain("--mcp-config");
      expect(JSON.stringify(events)).not.toContain(TOKEN);
    },
  );

  it.each(argvCases)(
    "$mode mode $call: the MCP header references ORCHESTRA_TOKEN, which the CLI env carries",
    async ({ mode, call }) => {
      // The request env deliberately lacks ORCHESTRA_TOKEN: the adapter must
      // supply it from `mcp.token`, as the Codex adapter does (design.md §7.2).
      const { launches } = await launch(mode, call, { PATH: "/usr/bin" });

      const { args, env } = launches[0]!;
      expect(mcpConfigArg(args).mcpServers.orchestra?.headers).toEqual({
        Authorization: "Bearer ${ORCHESTRA_TOKEN}",
      });
      expect(env.ORCHESTRA_TOKEN).toBe(TOKEN);
    },
  );

  it.each(argvCases)(
    "$mode mode $call: a review run's recorded CLI launch carries no ORCHESTRA_TOKEN and no orchestra entry in --mcp-config (commit cadff5c, design.md §9.8)",
    async ({ mode, call }) => {
      cwd = await makeSessionRoot();
      let adapter: ClaudeAdapter;
      let launches: CliLaunch[];
      if (mode === "host") {
        const recorder = hostModeRecorder();
        adapter = new ClaudeAdapter({ query: recorder.query });
        launches = recorder.launches;
      } else {
        const recorder = spawnerModeRecorder();
        adapter = new ClaudeAdapter({ spawn: recorder.spawn });
        launches = recorder.launches;
      }
      const signal = new AbortController().signal;
      const stream =
        call === "start"
          ? adapter.start({ ...startRequest, allowedTools: "review", cwd }, signal)
          : adapter.resume({ ...resumeRequest, allowedTools: "review", cwd }, signal);
      await collect(stream);

      expect(launches).toHaveLength(1);
      const { args, env } = launches[0]!;
      expect(env.ORCHESTRA_TOKEN).toBeUndefined();
      for (const arg of args) expect(arg).not.toContain(TOKEN);
      if (args.includes("--mcp-config")) {
        expect(mcpConfigArg(args).mcpServers).not.toHaveProperty("orchestra");
      }
    },
  );
});

describe("ClaudeAdapter background subagents at turn end (GOT.101)", () => {
  // SDK message shapes from the installed `sdk.d.ts`: `tool_use` blocks for
  // Agent and Task, and the `task_started`, `task_updated` and
  // `task_notification` system messages that bracket a subagent's life.
  const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
    cast({
      type: "assistant",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      uuid: `u-${id}`,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name, input }],
      },
    });
  const toolResult = (id: string, options: { isError?: boolean } = {}) =>
    cast({
      type: "user",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: "launched",
            ...(options.isError === true ? { is_error: true } : {}),
          },
        ],
      },
    });
  const taskStarted = (fields: Record<string, unknown>) =>
    cast({
      type: "system",
      subtype: "task_started",
      description: "implement the ticket",
      session_id: SESSION_ID,
      uuid: `u-started-${String(fields.task_id)}`,
      ...fields,
    });
  const taskUpdated = (taskId: string, patch: Record<string, unknown>) =>
    cast({
      type: "system",
      subtype: "task_updated",
      task_id: taskId,
      patch,
      session_id: SESSION_ID,
      uuid: `u-updated-${taskId}`,
    });
  const taskNotification = (fields: Record<string, unknown>) =>
    cast({
      type: "system",
      subtype: "task_notification",
      status: "completed",
      output_file: "/tmp/out",
      summary: "done",
      session_id: SESSION_ID,
      uuid: `u-note-${String(fields.task_id)}`,
      ...fields,
    });
  const delegate = { description: "do it", prompt: "Implement GOT-1." };

  async function turnDone(messages: SDKMessage[]): Promise<AgentEvent> {
    const adapter = new ClaudeAdapter({ query: scripted(messages).fn });
    const events = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );
    const done = events.filter((e) => e.type === "turn_done");
    expect(done).toHaveLength(1);
    return done[0]!;
  }

  it("counts an Agent call with run_in_background true that has not returned", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_a", "Agent", { ...delegate, run_in_background: true }),
        toolResult("toolu_a"),
        resultSuccess({ result: "Now I'll delegate." }),
      ]),
    ).toEqual({
      type: "turn_done",
      finalText: "Now I'll delegate.",
      backgroundSubagents: 1,
    });
  });

  it("drops a background Agent call whose tool_result errored before any task message (GOT.101-B F1)", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_a", "Agent", { ...delegate, run_in_background: true }),
        // Denied or invalid input: the delegation never started, so no
        // task_started or task_notification follows.
        toolResult("toolu_a", { isError: true }),
        resultSuccess(),
      ]),
    ).toEqual({ type: "turn_done", finalText: "Opened PR #12." });
  });

  it("counts a Task call with run_in_background true the same way", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_t", "Task", { ...delegate, run_in_background: true }),
        resultSuccess(),
      ]),
    ).toMatchObject({ backgroundSubagents: 1 });
  });

  it("counts a subagent the SDK registered in the background without the flag", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_b", "Agent", delegate),
        taskStarted({
          task_id: "task_b",
          tool_use_id: "toolu_b",
          task_type: "local_agent",
          is_backgrounded: true,
        }),
        toolResult("toolu_b"),
        resultSuccess(),
      ]),
    ).toMatchObject({ backgroundSubagents: 1 });
  });

  it("counts a foreground subagent later moved to the background", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_m", "Agent", { ...delegate, run_in_background: false }),
        taskStarted({
          task_id: "task_m",
          tool_use_id: "toolu_m",
          task_type: "local_agent",
          is_backgrounded: false,
        }),
        taskUpdated("task_m", { is_backgrounded: true }),
        toolResult("toolu_m"),
        resultSuccess(),
      ]),
    ).toMatchObject({ backgroundSubagents: 1 });
  });

  it("counts each outstanding subagent and drops the ones that settled", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_1", "Agent", { ...delegate, run_in_background: true }),
        toolUse("toolu_2", "Agent", { ...delegate, run_in_background: true }),
        toolUse("toolu_3", "Agent", { ...delegate, run_in_background: true }),
        taskStarted({
          task_id: "task_2",
          tool_use_id: "toolu_2",
          task_type: "local_agent",
          is_backgrounded: true,
        }),
        taskStarted({
          task_id: "task_3",
          tool_use_id: "toolu_3",
          task_type: "local_agent",
          is_backgrounded: true,
        }),
        // Settled by the notification's tool_use_id with no task_started seen.
        taskNotification({ task_id: "task_1", tool_use_id: "toolu_1" }),
        // Settled by task id only.
        taskUpdated("task_2", { status: "completed" }),
        resultSuccess(),
      ]),
    ).toMatchObject({ backgroundSubagents: 1 });
  });

  it("reports nothing when every background subagent returned before the turn ended", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_a", "Agent", { ...delegate, run_in_background: true }),
        taskStarted({
          task_id: "task_a",
          tool_use_id: "toolu_a",
          task_type: "local_agent",
          is_backgrounded: true,
        }),
        toolResult("toolu_a"),
        taskNotification({ task_id: "task_a", status: "failed" }),
        resultSuccess(),
      ]),
    ).toEqual({ type: "turn_done", finalText: "Opened PR #12." });
  });

  it("leaves foreground delegation exactly as before", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_f", "Agent", { ...delegate, run_in_background: false }),
        taskStarted({
          task_id: "task_f",
          tool_use_id: "toolu_f",
          task_type: "local_agent",
          is_backgrounded: false,
        }),
        taskNotification({ task_id: "task_f", tool_use_id: "toolu_f" }),
        toolResult("toolu_f"),
        resultSuccess(),
      ]),
    ).toEqual({ type: "turn_done", finalText: "Opened PR #12." });
  });

  it("does not count a background shell command as a subagent", async () => {
    expect(
      await turnDone([
        systemInit,
        toolUse("toolu_s", "Bash", { command: "pnpm test", run_in_background: true }),
        taskStarted({
          task_id: "task_s",
          tool_use_id: "toolu_s",
          task_type: "local_bash",
          is_backgrounded: true,
        }),
        toolResult("toolu_s"),
        resultSuccess(),
      ]),
    ).toEqual({ type: "turn_done", finalText: "Opened PR #12." });
  });

  it("does not leak an outstanding background subagent from a start stream into a resume stream", async () => {
    let call = 0;
    const adapter = new ClaudeAdapter({
      query: () => {
        call += 1;
        // The start stream ends with an Agent call still running in the
        // background and no settling task message; the resumed stream is a
        // fresh CLI process, so it must start with an empty set even though
        // the first stream's context object is still reachable.
        const messages =
          call === 1
            ? [
                systemInit,
                toolUse("toolu_a", "Agent", { ...delegate, run_in_background: true }),
                toolResult("toolu_a"),
                resultSuccess(),
              ]
            : [systemInit, resultSuccess()];
        return (async function* () {
          for (const message of messages) yield message;
        })();
      },
    });

    const started = await collect(
      adapter.start(startRequest, new AbortController().signal),
    );
    expect(started.at(-1)).toEqual({
      type: "turn_done",
      finalText: "Opened PR #12.",
      backgroundSubagents: 1,
    });

    const resumed = await collect(
      adapter.resume(resumeRequest, new AbortController().signal),
    );
    expect(resumed.at(-1)).toEqual({ type: "turn_done", finalText: "Opened PR #12." });
  });
});
