import { describe, expect, it } from "vitest";
import {
  EXECUTION_CONTEXT_PATH,
  ExecutionContextSchema,
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
