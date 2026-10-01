import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUTH_ENV_NAMES,
  CLAUDE_AUTH_FILE_PATH,
  EXECUTION_CONTEXT_PATH,
  ExecutionContextSchema,
  claudeAuthFileContent,
  parseClaudeAuthFile,
  type ExecutionContext,
} from "./context.js";
import * as core from "./index.js";

const VALID: ExecutionContext = {
  task: {
    id: "0b7c2f4e-1111-4222-8333-944455556666",
    jira_key: "GOOP-421",
    jira_summary: "Receipt language setting",
  },
  spec: {
    version: 2,
    content: {
      repository: "goopter_odoo_modules",
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
      decision: "Receipt language is device-local.",
      clarification: "Reinstall resets it.",
      chosen_option: null,
      decided_by: "user@example.com",
      decided_at: "2026-09-20",
    },
  ],
  repository: {
    name: "goopter_odoo_modules",
    default_branch: "main",
    branch: "agent/GOOP-421-0b7c2f4e",
  },
  runtime: "claude",
  review_command: null,
};

describe("ExecutionContextSchema (design.md §9.1 step 4, §9.8)", () => {
  it("parses a valid context document", () => {
    expect(ExecutionContextSchema.parse(VALID)).toEqual(VALID);
  });

  it("round-trips through JSON", () => {
    const text = JSON.stringify(VALID);
    expect(ExecutionContextSchema.parse(JSON.parse(text))).toEqual(VALID);
  });

  it("accepts a review command string", () => {
    const withCommand = { ...VALID, review_command: "pnpm test" };
    expect(ExecutionContextSchema.parse(withCommand).review_command).toBe(
      "pnpm test",
    );
  });

  it("rejects a missing review_command key (null is explicit)", () => {
    const { review_command, ...rest } = VALID;
    void review_command;
    expect(ExecutionContextSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing runtime (the wrapper picks its adapter by it)", () => {
    const { runtime, ...rest } = VALID;
    void runtime;
    expect(ExecutionContextSchema.safeParse(rest).success).toBe(false);
  });

  it("accepts codex and rejects an unknown runtime", () => {
    expect(
      ExecutionContextSchema.parse({ ...VALID, runtime: "codex" }).runtime,
    ).toBe("codex");
    expect(
      ExecutionContextSchema.safeParse({ ...VALID, runtime: "gemini" }).success,
    ).toBe(false);
  });

  it("rejects a missing working branch", () => {
    const bad = {
      ...VALID,
      repository: { name: "x", default_branch: "main" },
    };
    expect(ExecutionContextSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects spec content that fails the §4.3 schema", () => {
    const bad = {
      ...VALID,
      spec: { version: 2, content: { objective: "only" } },
    };
    expect(ExecutionContextSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-positive spec version", () => {
    const bad = { ...VALID, spec: { ...VALID.spec, version: 0 } };
    expect(ExecutionContextSchema.safeParse(bad).success).toBe(false);
  });

  it("names the file path inside the worktree", () => {
    expect(EXECUTION_CONTEXT_PATH).toBe(".orchestra/context.json");
  });

  it("is exported from the package index", () => {
    expect(core.ExecutionContextSchema).toBe(ExecutionContextSchema);
    expect(core.EXECUTION_CONTEXT_PATH).toBe(EXECUTION_CONTEXT_PATH);
  });
});

describe("Claude credential file (design.md §9.9 Auth)", () => {
  const OAUTH = "dummy-oauth-value";
  const KEY = "dummy-api-key-value";

  it("lives at /run/orchestra/claude-auth and is exported from the package index", () => {
    expect(CLAUDE_AUTH_FILE_PATH).toBe("/run/orchestra/claude-auth");
    expect(core.CLAUDE_AUTH_FILE_PATH).toBe(CLAUDE_AUTH_FILE_PATH);
    expect(core.parseClaudeAuthFile).toBe(parseClaudeAuthFile);
    expect(core.claudeAuthFileContent).toBe(claudeAuthFileContent);
    expect([...CLAUDE_AUTH_ENV_NAMES]).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  });

  it("content prefers the OAuth token over the API key", () => {
    expect(
      claudeAuthFileContent({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY }),
    ).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${OAUTH}\n`);
  });

  it("content falls back to the API key", () => {
    expect(claudeAuthFileContent({ ANTHROPIC_API_KEY: KEY, OTHER: "x" })).toBe(
      `ANTHROPIC_API_KEY=${KEY}\n`,
    );
    expect(claudeAuthFileContent({ CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: KEY })).toBe(
      `ANTHROPIC_API_KEY=${KEY}\n`,
    );
  });

  it("content is null when neither credential is set", () => {
    expect(claudeAuthFileContent({})).toBeNull();
    expect(claudeAuthFileContent({ GITHUB_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: "" })).toBeNull();
  });

  it("parses what it formats", () => {
    expect(parseClaudeAuthFile(claudeAuthFileContent({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH })!)).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: OAUTH,
    });
    expect(parseClaudeAuthFile(`ANTHROPIC_API_KEY=${KEY}`)).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: KEY,
    });
  });

  it("keeps an = inside the value", () => {
    expect(parseClaudeAuthFile("ANTHROPIC_API_KEY=a=b\n")).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: "a=b",
    });
  });

  it.each([
    ["empty", ""],
    ["only a newline", "\n"],
    ["no =", "CLAUDE_CODE_OAUTH_TOKEN"],
    ["empty value", "CLAUDE_CODE_OAUTH_TOKEN=\n"],
    ["empty name", `=${OAUTH}\n`],
    ["another name", "GITHUB_TOKEN=x\n"],
    ["lower-case name", "claude_code_oauth_token=x\n"],
    ["two lines", `CLAUDE_CODE_OAUTH_TOKEN=${OAUTH}\nANTHROPIC_API_KEY=${KEY}\n`],
    ["trailing blank line", `CLAUDE_CODE_OAUTH_TOKEN=${OAUTH}\n\n`],
    ["carriage return", `CLAUDE_CODE_OAUTH_TOKEN=${OAUTH}\r\n`],
    ["leading space", ` CLAUDE_CODE_OAUTH_TOKEN=${OAUTH}\n`],
  ])("rejects a malformed file: %s", (_label, text) => {
    expect(parseClaudeAuthFile(text)).toBeNull();
  });
});
