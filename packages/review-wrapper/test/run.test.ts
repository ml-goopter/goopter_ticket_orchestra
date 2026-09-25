import fs from "node:fs/promises";
import path from "node:path";
import { REVIEW_SYSTEM_PROMPT } from "@orchestra/prompts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_UNAVAILABLE_MESSAGE,
  runReview,
  type RunDeps,
} from "../src/index.js";
import {
  CONTEXT,
  createTestRepo,
  DECOY_TRANSCRIPT,
  FakeAdapter,
  reviewTurn,
  startFakeToolsServer,
  type FakeToolsServer,
  type TestRepo,
} from "./support.js";

const TOKEN = "tok-review-wrapper-test";

const FINDINGS = {
  verdict: "findings",
  findings: [
    {
      severity: "warning",
      file: "src/size.ts",
      line: 1,
      description: "size changed without a test",
      action: "add a regression test",
    },
  ],
};

let repo: TestRepo;
let tools: FakeToolsServer;

beforeEach(async () => {
  repo = await createTestRepo();
  tools = await startFakeToolsServer(TOKEN);
});

afterEach(async () => {
  await tools.stop();
  await repo.cleanup();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  adapter: FakeAdapter;
  adapterCreated: boolean;
  reads: string[];
}

async function run(
  options: {
    argv?: string[];
    reply?: string;
    adapter?: FakeAdapter;
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
): Promise<Run> {
  const adapter =
    options.adapter ?? new FakeAdapter(reviewTurn(options.reply ?? JSON.stringify(FINDINGS)));
  let stdout = "";
  let stderr = "";
  let adapterCreated = false;
  const reads: string[] = [];
  const deps: RunDeps = {
    argv: options.argv ?? ["--round", "2"],
    env: options.env ?? {
      ORCHESTRA_URL: tools.url,
      ORCHESTRA_TOKEN: TOKEN,
      PATH: process.env.PATH,
      KEEP_ME: "yes",
    },
    cwd: options.cwd ?? repo.dir,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    readFile: async (file) => {
      reads.push(file);
      return fs.readFile(file, "utf8");
    },
    createAdapter: () => {
      adapterCreated = true;
      return adapter;
    },
  };
  const code = await runReview(deps);
  return { code, stdout, stderr, adapter, adapterCreated, reads };
}

describe("prompt inputs (AC5)", () => {
  it("includes committed changes, the uncommitted edit and the untracked file, not later main commits", async () => {
    const result = await run();

    expect(result.code).toBe(1);
    const prompt = result.adapter.starts[0]!.prompt;
    expect(prompt).toContain("COMMITTED-CHANGE");
    expect(prompt).toContain("UNCOMMITTED-EDIT");
    expect(prompt).toContain("### src/new-file.ts");
    expect(prompt).toContain("UNTRACKED_CONTENT");
    // Diff is against the merge base, so the default branch's later commit
    // is not presented as a change.
    expect(prompt).not.toContain("LATER_ON_MAIN");
    expect(prompt).toContain("Make the widget blue.");
    expect(prompt).toContain("- issue_784: Blue means #0000ff. Clarification: Not navy.");
    expect(prompt).not.toMatch(/^## Ticket/m);
  });

  it("reads only context.json and the untracked files; the decoy transcript never reaches the prompt", async () => {
    const result = await run();

    expect(result.adapter.starts[0]!.prompt).not.toContain(DECOY_TRANSCRIPT);
    expect(result.reads.sort()).toEqual(
      [
        path.join(repo.dir, ".orchestra", "context.json"),
        path.join(repo.dir, "src", "new-file.ts"),
      ].sort(),
    );
  });

  it("falls back to the local default branch when origin/<default> is absent", async () => {
    const local = await createTestRepo({ withOriginRef: false });
    try {
      const result = await run({ cwd: local.dir });

      expect(result.code).toBe(1);
      const prompt = result.adapter.starts[0]!.prompt;
      expect(prompt).toContain("COMMITTED-CHANGE");
      expect(prompt).toContain("UNCOMMITTED-EDIT");
      expect(prompt).not.toContain("LATER_ON_MAIN");
    } finally {
      await local.cleanup();
    }
  });

  it("an empty diff with no untracked files is still reviewed", async () => {
    const { git } = await import("./support.js");
    git(repo.dir, "checkout", "-q", "--", ".");
    await fs.rm(path.join(repo.dir, "src", "new-file.ts"));
    git(repo.dir, "reset", "-q", "--hard", "main");

    const result = await run({ reply: JSON.stringify({ verdict: "clean", findings: [] }) });

    expect(result.code).toBe(0);
    expect(result.adapter.starts[0]!.prompt).toContain("No changes to tracked files.");
    expect(result.adapter.starts[0]!.prompt).toContain("## Untracked files\nNone.");
  });
});

describe("session request", () => {
  it("starts a review-policy session with the review system prompt, test command, MCP and env minus the token", async () => {
    const result = await run();

    expect(result.adapter.starts).toHaveLength(1);
    const req = result.adapter.starts[0]!;
    expect(req.cwd).toBe(repo.dir);
    expect(req.systemPrompt).toBe(REVIEW_SYSTEM_PROMPT);
    expect(req.allowedTools).toBe("review");
    expect(req.model).toBeUndefined();
    expect(req.testCommand).toBe("pnpm test");
    expect(req.mcp).toEqual({ url: tools.url, token: TOKEN });
    expect(req.env.KEEP_ME).toBe("yes");
    expect(req.env.ORCHESTRA_URL).toBe(tools.url);
    expect("ORCHESTRA_TOKEN" in req.env).toBe(false);
  });

  it("passes no test command when review_command is null", async () => {
    const nullCommand = await createTestRepo({
      context: { ...CONTEXT, review_command: null },
    });
    try {
      const result = await run({ cwd: nullCommand.dir });
      expect(result.adapter.starts[0]!.testCommand).toBeUndefined();
    } finally {
      await nullCommand.cleanup();
    }
  });
});

describe("verdicts, stdout and reporting (AC6)", () => {
  for (const [verdict, code] of [
    ["clean", 0],
    ["findings", 1],
    ["ask_user", 2],
  ] as const) {
    it(`${verdict} exits ${code}, prints the findings JSON, reports usage then the result`, async () => {
      const doc = verdict === "clean" ? { verdict, findings: [] } : { ...FINDINGS, verdict };

      const result = await run({ reply: JSON.stringify(doc) });

      expect(result.code).toBe(code);
      expect(JSON.parse(result.stdout)).toEqual(doc);
      expect(tools.calls.map((c) => c.tool)).toEqual([
        "report_usage",
        "report_review_result",
      ]);
      expect(tools.calls[0]!.args).toEqual({
        kind: "review",
        round: 2,
        model: "claude-opus-4,claude-haiku-4",
        input_tokens: 1010,
        cached_input_tokens: 200,
        output_tokens: 305,
        cost_usd: 0.42,
      });
      expect(tools.calls[1]!.args).toEqual({
        round: 2,
        verdict,
        findings: doc.findings,
        usage_id: "usage-1",
      });
      expect(tools.authorizations.length).toBeGreaterThan(0);
      expect(new Set(tools.authorizations)).toEqual(new Set([`Bearer ${TOKEN}`]));
    });
  }

  it("accepts a reply wrapped in a ```json fence", async () => {
    const result = await run({
      reply: "```json\n" + JSON.stringify(FINDINGS, null, 2) + "\n```",
    });

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(FINDINGS);
  });

  it("accepts --round=N", async () => {
    const result = await run({ argv: ["--round=3"] });

    expect(result.code).toBe(1);
    expect(tools.calls[1]!.args.round).toBe(3);
  });

  it("reports cost 0 when no usage event carries a cost", async () => {
    const adapter = new FakeAdapter([
      { type: "usage", model: "m", input: 1, cached: 0, output: 1 },
      { type: "turn_done", finalText: JSON.stringify(FINDINGS) },
    ]);

    await run({ adapter });

    expect(tools.calls[0]!.args).toMatchObject({ model: "m", cost_usd: 0 });
  });

  it("report_usage failing still reports the result without usage_id, then exits 3", async () => {
    tools.failing.add("report_usage");

    const result = await run();

    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual(FINDINGS);
    expect(tools.calls.map((c) => c.tool)).toEqual(["report_usage", "report_review_result"]);
    expect(tools.calls[1]!.args).not.toHaveProperty("usage_id");
    expect(result.stderr).toMatch(/report_usage/);
  });

  it("report_review_result failing exits 3", async () => {
    tools.failing.add("report_review_result");

    const result = await run();

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/report_review_result/);
  });

  it("surfaces an instruction from report_review_result on stderr, stdout unchanged", async () => {
    tools.instruction = "Stop now. Do not continue the review loop. Call report_failed.";

    const result = await run();

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(FINDINGS);
    expect(result.stderr).toContain(tools.instruction);
  });
});

describe("errors exit 3 with nothing reported (AC7)", () => {
  async function expectNothingReported(result: Run, stderr: RegExp) {
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(stderr);
    expect(tools.calls).toEqual([]);
  }

  for (const [label, argv] of [
    ["missing --round", []],
    ["--round without a value", ["--round"]],
    ["--round 0", ["--round", "0"]],
    ["--round 1.5", ["--round", "1.5"]],
    ["--round abc", ["--round", "abc"]],
    ["an unknown argument", ["--round", "1", "--extra"]],
  ] as const) {
    it(label, async () => {
      const result = await run({ argv: [...argv] });
      await expectNothingReported(result, /usage: orchestra-review --round <n>/);
      expect(result.adapterCreated).toBe(false);
    });
  }

  for (const missing of ["ORCHESTRA_URL", "ORCHESTRA_TOKEN"]) {
    it(`missing ${missing}`, async () => {
      const env: Record<string, string | undefined> = {
        ORCHESTRA_URL: tools.url,
        ORCHESTRA_TOKEN: TOKEN,
      };
      delete env[missing];
      const result = await run({ env });
      await expectNothingReported(result, new RegExp(missing));
      expect(result.adapterCreated).toBe(false);
    });
  }

  it("missing context.json", async () => {
    await fs.rm(path.join(repo.dir, ".orchestra", "context.json"));
    const result = await run();
    await expectNothingReported(result, /context\.json/);
    expect(result.adapterCreated).toBe(false);
  });

  it("context.json that is not JSON", async () => {
    await fs.writeFile(path.join(repo.dir, ".orchestra", "context.json"), "{nope");
    const result = await run();
    await expectNothingReported(result, /context\.json/);
  });

  it("context.json that fails the schema", async () => {
    const { runtime, ...noRuntime } = CONTEXT;
    void runtime;
    await fs.writeFile(
      path.join(repo.dir, ".orchestra", "context.json"),
      JSON.stringify(noRuntime),
    );
    const result = await run();
    await expectNothingReported(result, /context\.json/);
    expect(result.adapterCreated).toBe(false);
  });

  it("a git failure (not a repository)", async () => {
    await fs.rm(path.join(repo.dir, ".git"), { recursive: true, force: true });
    const result = await run();
    await expectNothingReported(result, /git/);
    expect(result.adapterCreated).toBe(false);
  });

  for (const [label, reply] of [
    ["prose instead of JSON", "Looks good to me!"],
    ["JSON with an unknown verdict", JSON.stringify({ verdict: "maybe", findings: [] })],
    ["JSON missing findings", JSON.stringify({ verdict: "clean" })],
    [
      "JSON with a malformed finding",
      JSON.stringify({ verdict: "findings", findings: [{ severity: "huge" }] }),
    ],
  ] as const) {
    it(`unparseable reviewer output: ${label}`, async () => {
      const result = await run({ reply });
      await expectNothingReported(result, /reviewer reply/);
    });
  }

  it("an adapter error event", async () => {
    const adapter = new FakeAdapter([
      { type: "usage", model: "m", input: 1, cached: 0, output: 1, costUsd: 0.1 },
      { type: "error", message: "rate limited", retriable: true },
    ]);
    const result = await run({ adapter });
    await expectNothingReported(result, /rate limited/);
  });

  it("a thrown adapter error", async () => {
    const adapter = new FakeAdapter({ throws: new Error("spawn claude ENOENT") });
    const result = await run({ adapter });
    await expectNothingReported(result, /spawn claude ENOENT/);
  });

  it("a session that ends without turn_done", async () => {
    const adapter = new FakeAdapter([{ type: "session", sessionId: "s" }]);
    const result = await run({ adapter });
    await expectNothingReported(result, /without a final reply/);
  });

  it("runtime codex exits 3 before starting any session", async () => {
    const codex = await createTestRepo({ context: { ...CONTEXT, runtime: "codex" } });
    try {
      const result = await run({ cwd: codex.dir });
      await expectNothingReported(result, new RegExp(CODEX_UNAVAILABLE_MESSAGE.replace(/[()]/g, "\\$&")));
      expect(result.adapterCreated).toBe(false);
      expect(result.adapter.starts).toHaveLength(0);
    } finally {
      await codex.cleanup();
    }
  });
});
