import { describe, expect, it } from "vitest";
import type { SpecContent } from "@orchestra/core";
import { buildUserPrompt, type UserPromptContext } from "./user.js";

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

const BASE_CONTEXT: UserPromptContext = {
  role: "implementation",
  ticket: {
    key: "GOOP-421",
    summary: "Add a receipt language toggle",
    description: "Users in the field report the wrong receipt language.",
    comments: [
      { author: "alice@example.com", createdAt: "2026-09-18", body: "Repro'd on device 3." },
    ],
  },
  approvedSpec: { version: 2, content: SPEC },
  decisions: [
    {
      issueId: "issue_784",
      decision: "Receipt language is device-local.",
      clarification: "Reinstall resets it.",
      chosenOption: "device-local",
      author: "user@example.com",
      decidedAt: "2026-09-20",
    },
  ],
  repository: {
    name: "goopter_odoo_modules",
    defaultBranch: "main",
    workingBranch: "agent/GOOP-421-ab12cd",
    setupCommand: "pnpm install",
    testCommand: "pnpm test",
  },
};

const HEADINGS_IN_ORDER = [
  "## Ticket",
  "## Approved specification (revision 2)",
  "## Decisions recorded on this task",
  "## Repository",
  "## Instructions",
];

describe("buildUserPrompt (design.md §9.2)", () => {
  it("emits the five headings, in order", () => {
    const prompt = buildUserPrompt(BASE_CONTEXT);

    // Match whole lines: a raw substring search would also match "### Repository"
    // (a spec-markdown field heading) inside the string "## Repository".
    let cursor = -1;
    for (const heading of HEADINGS_IN_ORDER) {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`^${escaped}$`, "m").exec(prompt);
      expect(match, `expected to find heading line: ${heading}`).not.toBeNull();
      const index = match!.index;
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("renders the ticket key, summary, description, and comments", () => {
    const prompt = buildUserPrompt(BASE_CONTEXT);

    expect(prompt).toContain("GOOP-421: Add a receipt language toggle");
    expect(prompt).toContain("Users in the field report the wrong receipt language.");
    expect(prompt).toContain("- alice@example.com (2026-09-18): Repro'd on device 3.");
  });

  it("renders the approved spec via renderSpecMarkdown", () => {
    const prompt = buildUserPrompt(BASE_CONTEXT);

    expect(prompt).toContain("### Requirements");
    expect(prompt).toContain("- must be blue");
  });

  it("lists decisions with issue id, decision, clarification, chosen option, author, and date", () => {
    const prompt = buildUserPrompt(BASE_CONTEXT);

    expect(prompt).toContain(
      "- issue_784: Receipt language is device-local. Clarification: Reinstall resets it. Chosen option: device-local (user@example.com on 2026-09-20)",
    );
  });

  it('renders "None." when there are no decisions', () => {
    const prompt = buildUserPrompt({ ...BASE_CONTEXT, decisions: [] });

    expect(prompt).toContain("## Decisions recorded on this task\nNone.");
  });

  it("omits null repository lines", () => {
    const prompt = buildUserPrompt({
      ...BASE_CONTEXT,
      repository: { name: "goopter_odoo_modules", defaultBranch: "main" },
    });

    expect(prompt).toContain("Name: goopter_odoo_modules");
    expect(prompt).toContain("Default branch: main");
    expect(prompt).not.toContain("Working branch:");
    expect(prompt).not.toContain("Setup command:");
    expect(prompt).not.toContain("Test command:");
  });

  it("renders a spec role draft under a Draft heading when there is no approved revision", () => {
    const prompt = buildUserPrompt({
      ...BASE_CONTEXT,
      role: "spec",
      approvedSpec: null,
      draftSpec: { version: 1, content: SPEC },
    });

    expect(prompt).toContain("## Draft specification (revision 1)");
    expect(prompt).not.toContain("## Approved specification");
  });

  it('renders "## No specification yet" when there is no approved or draft revision', () => {
    const prompt = buildUserPrompt({
      ...BASE_CONTEXT,
      role: "spec",
      approvedSpec: null,
      draftSpec: null,
    });

    expect(prompt).toContain("## No specification yet");
  });

  it("matches the full example snapshot", () => {
    expect(buildUserPrompt(BASE_CONTEXT)).toMatchSnapshot();
  });
});
