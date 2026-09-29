import { describe, expect, it } from "vitest";
import { agentTools, type AgentToolName } from "@orchestra/core";
import {
  systemPromptFor,
  SPEC_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES,
  IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE,
  IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES_CLAUDE,
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

  it("returns the no-mistakes variant for implementation when requested", () => {
    const withNoMistakes = systemPromptFor("implementation", { noMistakes: true });
    expect(withNoMistakes).toBe(IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES);
    expect(withNoMistakes).not.toBe(IMPLEMENTATION_SYSTEM_PROMPT);
    expect(withNoMistakes).toContain("no-mistakes");
  });

  it("ignores noMistakes for spec and review", () => {
    expect(systemPromptFor("spec", { noMistakes: true })).toBe(SPEC_SYSTEM_PROMPT);
    expect(systemPromptFor("review", { noMistakes: true })).toBe(REVIEW_SYSTEM_PROMPT);
  });

  describe("delegation section (Claude runtime only)", () => {
    it("returns the Claude variants for runtime claude", () => {
      expect(systemPromptFor("implementation", { runtime: "claude" })).toBe(
        IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE,
      );
      expect(systemPromptFor("implementation", { runtime: "claude", noMistakes: true })).toBe(
        IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES_CLAUDE,
      );
    });

    it.each([
      ["manual", IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE],
      ["no-mistakes", IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES_CLAUDE],
    ])("the %s Claude variant has the section after the tool contract and before the review protocol", (_name, prompt) => {
      const delegation = prompt.indexOf(DELEGATION_PROTOCOL);
      expect(delegation).toBeGreaterThan(prompt.indexOf("## Agent-tools contract"));
      expect(delegation).toBeLessThan(prompt.indexOf("## Review protocol"));
    });

    it("routes hard, medium and simple units to opus, sonnet and haiku and forbids fable", () => {
      expect(DELEGATION_PROTOCOL).toContain("Hard, model `opus`");
      expect(DELEGATION_PROTOCOL).toContain("Medium, model `sonnet`");
      expect(DELEGATION_PROTOCOL).toContain("Simple, model `haiku`");
      expect(DELEGATION_PROTOCOL).toContain("Never pass `fable`.");
      expect(DELEGATION_PROTOCOL).toContain("At most two subagents at once.");
    });

    it("leaves the prompt unchanged for runtime codex or no runtime", () => {
      expect(systemPromptFor("implementation", { runtime: "codex" })).toBe(IMPLEMENTATION_SYSTEM_PROMPT);
      expect(systemPromptFor("implementation", { runtime: "codex", noMistakes: true })).toBe(
        IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES,
      );
      expect(IMPLEMENTATION_SYSTEM_PROMPT).not.toContain(DELEGATION_PROTOCOL);
      expect(IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES).not.toContain(DELEGATION_PROTOCOL);
    });

    it("ignores runtime for spec and review", () => {
      expect(systemPromptFor("spec", { runtime: "claude" })).toBe(SPEC_SYSTEM_PROMPT);
      expect(systemPromptFor("review", { runtime: "claude" })).toBe(REVIEW_SYSTEM_PROMPT);
    });
  });

  it.each(ROLES)("matches the %s snapshot", (role) => {
    expect(promptFor(role)).toMatchSnapshot();
  });

  it("matches the implementation no-mistakes snapshot", () => {
    expect(systemPromptFor("implementation", { noMistakes: true })).toMatchSnapshot();
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
