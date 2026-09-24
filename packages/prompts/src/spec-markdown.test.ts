import { describe, expect, it } from "vitest";
import type { SpecContent } from "@orchestra/core";
import { renderSpecMarkdown } from "./spec-markdown.js";

const FULL: SpecContent = {
  repository: "orchestra-app",
  objective: "Turn tickets into reviewed PRs.",
  scope: ["build the widget", "wire it to the API"],
  out_of_scope: ["the gadget"],
  requirements: ["must be blue"],
  acceptance_criteria: ["widget renders"],
  validation: ["run vitest"],
  constraints: ["no new deps"],
  dependencies: ["JIRA-1"],
  risks: ["vendor API may rate-limit"],
  notes: "Coordinate with the design team before merging.",
};

const MINIMAL: SpecContent = {
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

describe("renderSpecMarkdown (design.md §4.3)", () => {
  it("renders one heading per field, in schema order, with lists as bullets and notes as a paragraph", () => {
    const md = renderSpecMarkdown(FULL);

    const headingOrder = [
      "### Repository",
      "### Objective",
      "### Scope",
      "### Out of scope",
      "### Requirements",
      "### Acceptance criteria",
      "### Validation",
      "### Constraints",
      "### Dependencies",
      "### Risks",
      "### Notes",
    ];
    let cursor = -1;
    for (const heading of headingOrder) {
      const index = md.indexOf(heading);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }

    expect(md).toContain("- build the widget");
    expect(md).toContain("- vendor API may rate-limit");
    expect(md).toContain("Coordinate with the design team before merging.");
  });

  it("matches the full-spec snapshot", () => {
    expect(renderSpecMarkdown(FULL)).toMatchSnapshot();
  });

  it("omits Risks and Notes headings when the fields are absent", () => {
    const md = renderSpecMarkdown(MINIMAL);

    expect(md).not.toContain("### Risks");
    expect(md).not.toContain("### Notes");
  });

  it("matches the minimal-spec snapshot", () => {
    expect(renderSpecMarkdown(MINIMAL)).toMatchSnapshot();
  });
});
