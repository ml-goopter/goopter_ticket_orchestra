import { describe, expect, it } from "vitest";
import { agentTools } from "./agent-tools.js";

/**
 * design.md §8: one valid-input / missing-required-field pair per tool,
 * plus the roles assertions.
 */
const CASES = {
  raise_issue: {
    valid: {
      type: "QUESTION",
      severity: "info",
      blocking: false,
      title: "Need clarification",
      description: "What does X mean?",
    },
    invalid: {
      severity: "info",
      blocking: false,
      title: "Need clarification",
      description: "What does X mean?",
      // missing required `type`
    },
  },
  report_review_started: {
    valid: { round: 1 },
    invalid: {},
  },
  report_review_result: {
    valid: { round: 1, verdict: "clean", findings: [] },
    invalid: { round: 1, findings: [] }, // missing verdict
  },
  report_pr_created: {
    valid: {
      url: "https://github.com/org/repo/pull/1",
      number: 1,
      head_sha: "abc123",
    },
    invalid: { url: "https://github.com/org/repo/pull/1", number: 1 }, // missing head_sha
  },
  report_complete: {
    valid: { summary: "Done" },
    invalid: {},
  },
  report_failed: {
    valid: { reason: "gave_up", detail: "could not proceed" },
    invalid: { reason: "gave_up" }, // missing detail
  },
  propose_spec: {
    valid: {
      repository: "orchestra-app",
      objective: "Do the thing",
      scope: ["build the widget"],
      out_of_scope: ["the gadget"],
      requirements: ["must be blue"],
      acceptance_criteria: ["widget renders"],
      validation: ["run vitest"],
      constraints: ["no new deps"],
      dependencies: ["JIRA-1"],
    },
    invalid: {
      objective: "Do the thing",
      scope: [],
      out_of_scope: [],
      requirements: [],
      acceptance_criteria: [],
      validation: [],
      constraints: [],
      dependencies: [],
      // missing required `repository`
    },
  },
  note: {
    valid: { text: "observed something" },
    invalid: {},
  },
} as const;

describe("agentTools (design.md §8)", () => {
  it("has exactly the 8 tools §8 defines", () => {
    expect(Object.keys(agentTools).sort()).toEqual(
      [
        "note",
        "propose_spec",
        "raise_issue",
        "report_complete",
        "report_failed",
        "report_pr_created",
        "report_review_result",
        "report_review_started",
      ].sort(),
    );
  });

  for (const [name, { valid, invalid }] of Object.entries(CASES)) {
    describe(name, () => {
      it("parses a valid input", () => {
        const result =
          agentTools[name as keyof typeof agentTools].input.safeParse(valid);
        expect(result.success).toBe(true);
      });

      it("rejects an input missing a required field", () => {
        const result =
          agentTools[name as keyof typeof agentTools].input.safeParse(
            invalid,
          );
        expect(result.success).toBe(false);
      });
    });
  }

  it("report_review_started is implementation-only", () => {
    expect(agentTools.report_review_started.roles).toEqual([
      "implementation",
    ]);
  });

  it("raise_issue covers both roles", () => {
    expect(agentTools.raise_issue.roles).toEqual(["spec", "implementation"]);
  });
});
