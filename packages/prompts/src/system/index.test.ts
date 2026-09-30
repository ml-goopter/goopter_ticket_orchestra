import { describe, expect, it } from "vitest";
import { agentTools, type AgentToolName } from "@orchestra/core";
import {
  systemPromptFor,
  SPEC_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE,
  DELEGATION_PROTOCOL,
  REVIEW_SYSTEM_PROMPT,
} from "./index.js";

const ROLES = ["spec", "implementation", "review"] as const;

/** Every tool name in `agentTools`, so coverage tests stay in sync with core. */
const ALL_TOOL_NAMES = Object.keys(agentTools) as AgentToolName[];

function promptFor(role: (typeof ROLES)[number]): string {
  return systemPromptFor(role);
}

describe("systemPromptFor (design.md §9.2)", () => {
  it.each(ROLES)("returns a non-empty string for role %s", (role) => {
    expect(promptFor(role).length).toBeGreaterThan(0);
  });

  it("returns the static constant for each role", () => {
    expect(systemPromptFor("spec")).toBe(SPEC_SYSTEM_PROMPT);
    expect(systemPromptFor("implementation")).toBe(IMPLEMENTATION_SYSTEM_PROMPT);
    expect(systemPromptFor("review")).toBe(REVIEW_SYSTEM_PROMPT);
  });

  describe("delegation section (Claude runtime only)", () => {
    it("returns the Claude variant for runtime claude", () => {
      expect(systemPromptFor("implementation", { runtime: "claude" })).toBe(
        IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE,
      );
    });

    it("the Claude variant has the section after the tool contract and before the review protocol", () => {
      const prompt = IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE;
      const delegation = prompt.indexOf(DELEGATION_PROTOCOL);
      expect(delegation).toBeGreaterThan(prompt.indexOf("## Agent-tools contract"));
      expect(delegation).toBeLessThan(prompt.indexOf("## Review protocol"));
    });

    it("routes hard, medium and simple units to opus, sonnet and haiku and forbids fable", () => {
      expect(DELEGATION_PROTOCOL).toContain("Hard, model `opus`");
      expect(DELEGATION_PROTOCOL).toContain("Medium, model `sonnet`");
      expect(DELEGATION_PROTOCOL).toContain("Simple, model `haiku`");
      expect(DELEGATION_PROTOCOL).toContain("Never pass `fable`.");
      expect(DELEGATION_PROTOCOL).toContain("At most two foreground `Agent` calls in one message; wait for both results.");
    });

    it("names the Agent tool instead of Task", () => {
      expect(DELEGATION_PROTOCOL).toContain("`Agent`");
      expect(DELEGATION_PROTOCOL).not.toContain("`Task`");
      expect(DELEGATION_PROTOCOL).not.toMatch(/\bTask tool\b/);
    });

    it("requires foreground subagent calls and forbids ending the turn while one runs", () => {
      expect(DELEGATION_PROTOCOL).toContain("run_in_background");
      expect(DELEGATION_PROTOCOL.toLowerCase()).toContain("wait for each subagent's result before continuing");
      expect(DELEGATION_PROTOCOL.toLowerCase()).toContain(
        "never end your turn while any subagent is still running",
      );
      expect(DELEGATION_PROTOCOL.toLowerCase()).toContain("terminal agent-tools call");
    });

    it("requires resumed or retried sessions to start new subagents, never message old ones", () => {
      expect(DELEGATION_PROTOCOL.toLowerCase()).toContain("resumed or retried session");
      expect(DELEGATION_PROTOCOL.toLowerCase()).toContain("new subagents");
      expect(DELEGATION_PROTOCOL.toLowerCase()).toContain(
        "never message, resume, or wait for a subagent from an earlier session or execution",
      );
    });

    it("leaves the prompt unchanged for runtime codex or no runtime", () => {
      expect(systemPromptFor("implementation", { runtime: "codex" })).toBe(IMPLEMENTATION_SYSTEM_PROMPT);
      expect(IMPLEMENTATION_SYSTEM_PROMPT).not.toContain(DELEGATION_PROTOCOL);
    });

    it("ignores runtime for spec and review", () => {
      expect(systemPromptFor("spec", { runtime: "claude" })).toBe(SPEC_SYSTEM_PROMPT);
      expect(systemPromptFor("review", { runtime: "claude" })).toBe(REVIEW_SYSTEM_PROMPT);
    });
  });

  it.each(ROLES)("matches the %s snapshot", (role) => {
    expect(promptFor(role)).toMatchSnapshot();
  });

  it("matches the implementation Claude snapshot", () => {
    expect(systemPromptFor("implementation", { runtime: "claude" })).toMatchSnapshot();
  });

  describe("tool-name coverage against the agentTools registry (design.md §8)", () => {
    it.each(ROLES)("prompt for %s mentions every tool whose roles include it, and no tool whose roles exclude it", (role) => {
      const prompt = promptFor(role);

      for (const name of ALL_TOOL_NAMES) {
        const included = (agentTools[name].roles as readonly string[]).includes(role);
        const mentioned = prompt.includes(`\`${name}\``) || prompt.includes(name);
        if (included) {
          expect(mentioned, `expected ${role} prompt to mention ${name}`).toBe(true);
        } else {
          expect(mentioned, `expected ${role} prompt not to mention ${name}`).toBe(false);
        }
      }
    });
  });

  it("the implementation prompt names orchestra-review and report_pr_created", () => {
    expect(IMPLEMENTATION_SYSTEM_PROMPT).toContain("orchestra-review");
    expect(IMPLEMENTATION_SYSTEM_PROMPT).toContain("report_pr_created");
  });

  it("the spec prompt names propose_spec and does not name report_pr_created", () => {
    expect(SPEC_SYSTEM_PROMPT).toContain("propose_spec");
    expect(SPEC_SYSTEM_PROMPT).not.toContain("report_pr_created");
  });

  it.each(ROLES)("the %s prompt has a blocking-issue sentence containing 'stop'", (role) => {
    const prompt = promptFor(role).toLowerCase();
    const sentences = prompt.split(/(?<=[.!?])\s+/);
    expect(sentences.some((sentence) => sentence.includes("stop"))).toBe(true);
  });
});
