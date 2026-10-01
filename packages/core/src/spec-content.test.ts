import { describe, expect, it } from "vitest";
import {
  invalidDependencyEntries,
  invalidDependenciesMessage,
  JIRA_KEY_PATTERN,
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

  // GOT.90/GOT.100: the schema itself stays permissive about `dependencies`
  // content so a draft already stored with prose still parses (design.md
  // §4.3; write-time rejection lives in `invalidDependencyEntries` below).
  it("still parses a document whose dependencies hold prose, not Jira keys", () => {
    const prose = {
      ...VALID,
      dependencies: ["None - self-contained change within the sandbox repository"],
    };
    const result = SpecContentSchema.safeParse(prose);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependencies).toEqual(prose.dependencies);
    }
  });
});

describe("JIRA_KEY_PATTERN / invalidDependencyEntries (GOT.90/GOT.100, coordinator D1)", () => {
  it.each(["JIRA-1", "SPC-100", "AB_CD-42"])("accepts the Jira key %s", (key) => {
    expect(JIRA_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each([
    "None - self-contained change within the sandbox repository",
    "jira-1",
    "JIRA",
    "JIRA-",
    "-1",
    "1-JIRA",
    "",
  ])("rejects the non-key entry %j", (entry) => {
    expect(JIRA_KEY_PATTERN.test(entry)).toBe(false);
  });

  it("returns no offending entries for an empty list", () => {
    expect(invalidDependencyEntries([])).toEqual([]);
  });

  it("returns no offending entries when every entry is a Jira key", () => {
    expect(invalidDependencyEntries(["JIRA-1", "SPC-100"])).toEqual([]);
  });

  it("names every non-key entry, preserving order, and leaves valid keys out", () => {
    const prose = "None - self-contained change within the sandbox repository";
    expect(invalidDependencyEntries(["JIRA-1", prose, "SPC-100", "also not a key"])).toEqual([
      prose,
      "also not a key",
    ]);
  });

  it("invalidDependenciesMessage names the offending entries and states the rule", () => {
    const message = invalidDependenciesMessage(["not a key"]);
    expect(message).toContain("not a key");
    expect(message.toLowerCase()).toContain("jira issue key");
    expect(message.toLowerCase()).toContain("risks");
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

  it("accepts an empty dependencies list (the task depends on nothing)", () => {
    const content = { ...VALID, dependencies: [] };
    const result = validateSpecForApproval(content, resolves);
    expect(result).toEqual({ ok: true, content });
  });

  it("still rejects an empty requirements list when dependencies is empty", () => {
    const content = { ...VALID, dependencies: [], requirements: [] };
    const result = validateSpecForApproval(content, resolves);
    expect(result).toEqual({
      ok: false,
      errors: ["requirements must not be empty"],
    });
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
