import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentAdapter,
  AgentEvent,
  StartRequest,
} from "@orchestra/adapters";
import {
  agentTools,
  EXECUTION_CONTEXT_PATH,
  type ExecutionContext,
} from "@orchestra/core";

// ------------------------------------------------------------ fake adapter

/** Scripted `AgentAdapter`: records every start request, yields `events`. */
export class FakeAdapter implements AgentAdapter {
  readonly runtime = "claude" as const;
  readonly starts: StartRequest[] = [];

  constructor(
    private readonly script: AgentEvent[] | { throws: Error },
    /** Invoked at the very top of `start()`, before anything else runs. */
    private readonly onStart?: () => void,
  ) {}

  async *start(req: StartRequest): AsyncGenerator<AgentEvent> {
    this.onStart?.();
    this.starts.push(req);
    if ("throws" in this.script) throw this.script.throws;
    for (const event of this.script) yield event;
  }

  resume(): AsyncIterable<AgentEvent> {
    throw new Error("the review wrapper never resumes");
  }

  async canResume(): Promise<boolean> {
    return false;
  }
}

/** A successful review turn replying with `reply`. */
export function reviewTurn(reply: string): AgentEvent[] {
  return [
    { type: "session", sessionId: "s-1" },
    { type: "text", delta: "thinking" },
    {
      type: "usage",
      model: "claude-opus-4",
      input: 1000,
      cached: 200,
      output: 300,
      costUsd: 0.42,
    },
    { type: "usage", model: "claude-haiku-4", input: 10, cached: 0, output: 5 },
    { type: "turn_done", finalText: reply },
  ];
}

// --------------------------------------------------------- fake MCP server

export type ReportTool = "report_usage" | "report_review_result";

export interface RecordedCall {
  tool: ReportTool;
  args: Record<string, unknown>;
}

export interface FakeToolsServer {
  url: string;
  calls: RecordedCall[];
  /** Authorization header of every HTTP request received. */
  authorizations: Array<string | undefined>;
  /** Tools that answer with an MCP tool error. */
  failing: Set<ReportTool>;
  /** `instruction` returned by report_review_result, if set. */
  instruction?: string;
  stop(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * In-process stand-in for the worker's agent-tools server (design.md §8):
 * stateless streamable HTTP, bearer checked on every request, the two
 * tools the wrapper calls registered with the core schemas.
 */
export async function startFakeToolsServer(token: string): Promise<FakeToolsServer> {
  let usageSeq = 0;
  const state: Omit<FakeToolsServer, "url" | "stop"> = {
    calls: [],
    authorizations: [],
    failing: new Set(),
  };

  const respond = (tool: ReportTool, args: Record<string, unknown>, output: Record<string, unknown>): CallToolResult => {
    state.calls.push({ tool, args });
    if (state.failing.has(tool)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: { code: "INTERNAL", message: `${tool} failed` } }),
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      state.authorizations.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "UNAUTHORIZED" }, id: null }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const body = await readJson(req);
      const mcp = new McpServer({ name: "fake-agent-tools", version: "0.0.0" });
      mcp.registerTool(
        "report_usage",
        {
          inputSchema: agentTools.report_usage.input,
          outputSchema: agentTools.report_usage.output,
        },
        (args) => respond("report_usage", args, { usage_id: `usage-${++usageSeq}` }),
      );
      mcp.registerTool(
        "report_review_result",
        {
          inputSchema: agentTools.report_review_result.input,
          outputSchema: agentTools.report_review_result.output,
        },
        (args) =>
          respond("report_review_result", args, {
            ok: true,
            ...(state.instruction ? { instruction: state.instruction } : {}),
          }),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/mcp`,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

// ------------------------------------------------------------ git worktree

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

export const CONTEXT: ExecutionContext = {
  task: { id: "task-1", jira_key: "GOOP-421", jira_summary: "Receipt language" },
  spec: {
    version: 2,
    content: {
      repository: "widgets",
      objective: "Make the widget blue.",
      scope: ["widget colour"],
      out_of_scope: ["gadgets"],
      requirements: ["colour is blue"],
      acceptance_criteria: ["widget renders blue"],
      validation: ["run the tests"],
      constraints: ["no new deps"],
      dependencies: [],
    },
  },
  decisions: [
    {
      issue_id: "issue_784",
      decision: "Blue means #0000ff.",
      clarification: "Not navy.",
      chosen_option: null,
      decided_by: "user@example.com",
      decided_at: "2026-09-20",
    },
  ],
  repository: { name: "widgets", default_branch: "main", branch: "agent/GOOP-421-abc" },
  runtime: "claude",
  review_command: "pnpm test",
};

export const DECOY_TRANSCRIPT = "DECOY-TRANSCRIPT-implementer-said-this-is-fine";

export interface TestRepo {
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * A worktree-shaped repo: `main` with a base commit, `origin/main` as a
 * remote-tracking ref, a later commit on `origin/main` that the review must
 * not see, and the working branch holding one committed change, one
 * uncommitted edit, and one untracked file. `.orchestra/` is excluded the
 * way the worktree manager excludes it (design.md §9.1), and holds a decoy
 * transcript next to `context.json`.
 */
export async function createTestRepo(
  options: {
    withOriginRef?: boolean;
    context?: unknown;
    /** Runs after the standard repo is committed, before `.orchestra/` is written. */
    extra?: (dir: string) => Promise<void>;
  } = {},
): Promise<TestRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-review-")),
  );
  const write = async (rel: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  };

  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "commit.gpgsign", "false");
  await write("src/widget.ts", 'export const colour = "red";\n');
  await write("src/size.ts", "export const size = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");

  git(dir, "checkout", "-q", "-b", "agent/GOOP-421-abc");
  await write("src/widget.ts", 'export const colour = "blue"; // COMMITTED-CHANGE\n');
  git(dir, "commit", "-q", "-am", "committed change");

  // A commit on the default branch after the branch point.
  git(dir, "checkout", "-q", "main");
  await write("src/later.ts", "export const LATER_ON_MAIN = true;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "later on main");
  if (options.withOriginRef !== false) {
    git(dir, "update-ref", "refs/remotes/origin/main", "main");
  }
  git(dir, "checkout", "-q", "agent/GOOP-421-abc");

  await write("src/size.ts", "export const size = 2; // UNCOMMITTED-EDIT\n");
  await write("src/new-file.ts", "export const UNTRACKED_CONTENT = 1;\n");

  if (options.extra) await options.extra(dir);

  await fs.appendFile(path.join(dir, ".git", "info", "exclude"), "\n.orchestra/\n");
  await write(
    EXECUTION_CONTEXT_PATH,
    JSON.stringify(options.context ?? CONTEXT, null, 2),
  );
  await write(".orchestra/transcript.jsonl", `${DECOY_TRANSCRIPT}\n`);

  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
