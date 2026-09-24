import { describe, expect, it } from "vitest";
import {
  SpecContentSchema,
  validateSpecForApproval,
  type SpecContent,
} from "./spec-content.js";

const VALID: SpecContent = {
  repository: "orchestra-app",
  objective: "Do the thing",
  scope: ["build the widget"],
  out_of_scope: ["the gadget"],
  requirements: ["must be blue"],
  acceptance_criteria: ["widget renders"],
  validation: ["run vitest"],
  constraints: ["no new deps"],
  dependencies: ["JIRA-1"],
};

const resolves = (name: string) => name === "orchestra-app";
const neverResolves = () => false;

describe("SpecContentSchema (design.md §4.3)", () => {
  it("parses a valid document", () => {
    expect(SpecContentSchema.parse(VALID)).toEqual(VALID);
  });

  it("rejects a document missing a required field", () => {
    const { objective, ...missingObjective } = VALID;
    void objective;
    expect(SpecContentSchema.safeParse(missingObjective).success).toBe(false);
  });

  it("accepts a document with risks and notes omitted", () => {
    const result = SpecContentSchema.safeParse(VALID);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.risks).toBeUndefined();
      expect(result.data.notes).toBeUndefined();
    }
  });
});

describe("validateSpecForApproval (design.md §4.3 approval rule)", () => {
  it("approves a valid document whose repository resolves", () => {
    const result = validateSpecForApproval(VALID, resolves);
    expect(result.ok).toBe(true);
  });

  it("rejects when the repository does not resolve", () => {
    const result = validateSpecForApproval(VALID, neverResolves);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("repository"))).toBe(true);
    }
  });

  const requiredLists = [
    "scope",
    "out_of_scope",
    "requirements",
    "acceptance_criteria",
    "validation",
    "constraints",
    "dependencies",
  ] as const;

  for (const field of requiredLists) {
    it(`rejects when ${field} is empty`, () => {
      const content = { ...VALID, [field]: [] };
      const result = validateSpecForApproval(content, resolves);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes(field))).toBe(true);
      }
    });
  }

  it("accepts an empty risks list (risks is exempt from the non-empty rule)", () => {
    const content = { ...VALID, risks: [] };
    const result = validateSpecForApproval(content, resolves);
    expect(result.ok).toBe(true);
  });

  it("reports two simultaneous failures together", () => {
    const content = { ...VALID, scope: [], requirements: [] };
    const result = validateSpecForApproval(content, resolves);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("scope"))).toBe(true);
      expect(result.errors.some((e) => e.includes("requirements"))).toBe(
        true,
      );
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});
