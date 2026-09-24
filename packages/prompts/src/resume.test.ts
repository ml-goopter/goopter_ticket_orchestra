import { describe, expect, it } from "vitest";
import type { SpecContent } from "@orchestra/core";
import { buildResumePrompt } from "./resume.js";

const SPEC: SpecContent = {
  repository: "orchestra-app",
  objective: "Turn tickets into reviewed PRs.",
  scope: ["build the widget"],
  out_of_scope: ["the gadget"],
  requirements: ["must be blue"],
  acceptance_criteria: ["widget renders"],
  validation: ["run vitest"],
  constraints: ["no new deps"],
  dependencies: ["JIRA-1"],
};

describe("buildResumePrompt (design.md §9.2, §9.5)", () => {
  it("decision: header names the issue and states decision, clarification, and chosen option", () => {
    const prompt = buildResumePrompt("decision", {
      issueId: "issue_784",
      decision: "Receipt language is device-local.",
      clarification: "Reinstall resets it.",
      chosenOption: "device-local",
    });

    expect(prompt.startsWith("## Answer to issue issue_784")).toBe(true);
    expect(prompt).toContain("Decision: Receipt language is device-local.");
    expect(prompt).toContain("Clarification: Reinstall resets it.");
    expect(prompt).toContain("Chosen option: device-local");
    expect(prompt).toMatchSnapshot();
  });

  it("spec_revision: header names the version and includes a unified diff plus reconcile instruction", () => {
    const revised: SpecContent = { ...SPEC, requirements: ["must be blue", "must be round"] };

    const prompt = buildResumePrompt("spec_revision", {
      version: 3,
      previous: SPEC,
      revised,
    });

    expect(prompt.startsWith("## Specification revised to version 3")).toBe(true);
    expect(prompt).toContain("+- must be round");
    expect(prompt).toContain("Reconcile this revision with any work you have already completed");
    expect(prompt).toMatchSnapshot();
  });

  it("ci_failure: header names the sha, lists failing checks, and states the round count", () => {
    const prompt = buildResumePrompt("ci_failure", {
      sha: "abc1234",
      round: 2,
      maxRounds: 3,
      checks: [{ name: "test", log: "1 failing\nExpected true, got false" }],
    });

    expect(prompt.startsWith("## CI failed on abc1234")).toBe(true);
    expect(prompt).toContain("Round 2 of 3.");
    expect(prompt).toContain("Failing checks: test");
    expect(prompt).toContain("Expected true, got false");
    expect(prompt).toMatchSnapshot();
  });

  it("ci_failure: truncates each log excerpt to 200 lines", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    const prompt = buildResumePrompt("ci_failure", {
      sha: "def5678",
      round: 1,
      checks: [{ name: "build", log: lines.join("\n") }],
    });

    const fenceStart = prompt.indexOf("```\n") + 4;
    const fenceEnd = prompt.indexOf("\n```", fenceStart);
    const excerpt = prompt.slice(fenceStart, fenceEnd).split("\n");

    expect(excerpt.length).toBeLessThanOrEqual(200);
    // the last input line must survive truncation, the first must not
    expect(prompt).toContain("line 250");
    expect(prompt).not.toContain("line 1\n");
  });

  it("user_message: header lists conversation turns on the open issue", () => {
    const prompt = buildResumePrompt("user_message", {
      issueId: "issue_900",
      messages: [
        { author: "user@example.com", body: "Can you use the v2 endpoint instead?" },
        { author: "agent", body: "Switching to the v2 endpoint." },
      ],
    });

    expect(prompt.startsWith("## Message from user")).toBe(true);
    expect(prompt).toContain("issue_900");
    expect(prompt).toContain("- user@example.com: Can you use the v2 endpoint instead?");
    expect(prompt).toContain("- agent: Switching to the v2 endpoint.");
    expect(prompt).toMatchSnapshot();
  });

  it("protocol_nudge: names the missing terminal tool call", () => {
    const prompt = buildResumePrompt("protocol_nudge", {
      missingToolCall: "report_pr_created",
    });

    expect(prompt.startsWith("## Protocol reminder")).toBe(true);
    expect(prompt).toContain("report_pr_created");
    expect(prompt).toMatchSnapshot();
  });

  it("appends the original user prompt sections when payload.userPrompt is supplied (D5 fallback)", () => {
    const prompt = buildResumePrompt("decision", {
      issueId: "issue_1",
      decision: "Go with option A.",
      userPrompt: "## Ticket\nGOOP-1: Example\n",
    });

    expect(prompt.startsWith("## Answer to issue issue_1")).toBe(true);
    expect(prompt).toContain("## Ticket\nGOOP-1: Example");
  });
});
