import { describe, expect, it } from "vitest";
import type { SpecContent } from "@orchestra/core";
import { diffSpecs } from "./spec-diff.js";

const BASE: SpecContent = {
  repository: "orchestra-app",
  objective: "Turn tickets into reviewed PRs.",
  scope: ["build the widget"],
  out_of_scope: ["the gadget"],
  requirements: ["must be blue", "must be round"],
  acceptance_criteria: ["widget renders"],
  validation: ["run vitest"],
  constraints: ["no new deps"],
  dependencies: ["JIRA-1"],
};

describe("diffSpecs (design.md §9.2, §10.4)", () => {
  it("shows a removed requirement as a - line and an added acceptance criterion as a + line", () => {
    const revised: SpecContent = {
      ...BASE,
      requirements: ["must be blue"],
      acceptance_criteria: ["widget renders", "widget survives a reload"],
    };

    const diff = diffSpecs(BASE, revised);

    expect(diff).toContain("---");
    expect(diff).toContain("+++");
    expect(diff).toContain("@@");
    expect(diff).toContain("-- must be round");
    expect(diff).toContain("+- widget survives a reload");
  });

  it("produces no -/+ lines for equal specs", () => {
    const diff = diffSpecs(BASE, { ...BASE });

    const changeLines = diff
      .split("\n")
      .filter((line) => /^[-+]/.test(line) && !line.startsWith("---") && !line.startsWith("+++"));
    expect(changeLines).toHaveLength(0);
  });

  it("uses the supplied labels in the patch headers", () => {
    const revised: SpecContent = { ...BASE, objective: "Different objective." };
    const diff = diffSpecs(BASE, revised, { a: "v1", b: "v2" });

    expect(diff).toContain("v1");
    expect(diff).toContain("v2");
  });
});
