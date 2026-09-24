import { describe, expect, it } from "vitest";
import { agentTools, type AgentToolName } from "@orchestra/core";
import {
  systemPromptFor,
  SPEC_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES,
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

  it.each(ROLES)("matches the %s snapshot", (role) => {
    expect(promptFor(role)).toMatchSnapshot();
  });

  it("matches the implementation no-mistakes snapshot", () => {
    expect(systemPromptFor("implementation", { noMistakes: true })).toMatchSnapshot();
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
