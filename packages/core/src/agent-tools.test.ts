import { describe, expect, it } from "vitest";
import {
  agentTools,
  FindingSchema,
  ReviewFindingsDocumentSchema,
} from "./agent-tools.js";

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
  report_usage: {
    valid: {
      kind: "review",
      round: 1,
      model: "claude-opus-4",
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 5,
      cost_usd: 0.01,
    },
    invalid: {
      kind: "review",
      model: "claude-opus-4",
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 5,
      // missing cost_usd
    },
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
  it("has the 8 tools §8 defines plus report_usage (§9.7)", () => {
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
        "report_usage",
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

  it("report_usage is implementation-only", () => {
    expect(agentTools.report_usage.roles).toEqual(["implementation"]);
  });

  describe("report_usage input", () => {
    const valid = CASES.report_usage.valid;

    it("round is optional", () => {
      const { round, ...rest } = valid;
      void round;
      expect(agentTools.report_usage.input.safeParse(rest).success).toBe(true);
    });

    it("rejects round 0, negative tokens, negative cost and an unknown kind", () => {
      for (const bad of [
        { ...valid, round: 0 },
        { ...valid, input_tokens: -1 },
        { ...valid, cached_input_tokens: 1.5 },
        { ...valid, output_tokens: -1 },
        { ...valid, cost_usd: -0.01 },
        { ...valid, kind: "other" },
      ]) {
        expect(agentTools.report_usage.input.safeParse(bad).success).toBe(false);
      }
    });

    it("returns a usage_id", () => {
      expect(
        agentTools.report_usage.output.safeParse({ usage_id: "u1" }).success,
      ).toBe(true);
      expect(agentTools.report_usage.output.safeParse({}).success).toBe(false);
    });
  });

  it("report_review_result accepts an optional usage_id", () => {
    const input = agentTools.report_review_result.input;
    expect(
      input.parse({ round: 1, verdict: "clean", findings: [], usage_id: "u1" })
        .usage_id,
    ).toBe("u1");
    expect(
      input.safeParse({ round: 1, verdict: "clean", findings: [], usage_id: 7 })
        .success,
    ).toBe(false);
  });

  it("ReviewFindingsDocumentSchema is the reviewer's { verdict, findings } reply", () => {
    expect(
      ReviewFindingsDocumentSchema.safeParse({
        verdict: "findings",
        findings: [
          { severity: "warning", file: "a.ts", line: 3, description: "d", action: "a" },
        ],
      }).success,
    ).toBe(true);
    expect(
      ReviewFindingsDocumentSchema.safeParse({ verdict: "maybe", findings: [] })
        .success,
    ).toBe(false);
    expect(
      ReviewFindingsDocumentSchema.safeParse({ verdict: "clean" }).success,
    ).toBe(false);
    expect(FindingSchema.safeParse({ severity: "info", description: "d", action: "a" }).success).toBe(true);
  });

  it("raise_issue covers both roles", () => {
    expect(agentTools.raise_issue.roles).toEqual(["spec", "implementation"]);
  });
});
