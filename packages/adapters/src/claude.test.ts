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
import { afterEach, describe, expect, it } from "vitest";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAdapter,
  type ClaudeQueryFn,
  encodeProjectDir,
} from "./claude.js";
import { allowedToolsFor, builtinToolsFor } from "./policies.js";
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
    expect(options?.mcpServers).toEqual({
      orchestra: {
        type: "http",
        url: "http://127.0.0.1:4599/mcp",
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    });
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
