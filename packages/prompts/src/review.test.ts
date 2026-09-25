import { describe, expect, it } from "vitest";
import type { SpecContent } from "@orchestra/core";
import { buildReviewPrompt, type ReviewPromptContext } from "./review.js";
import * as prompts from "./index.js";
import { renderSpecMarkdown } from "./spec-markdown.js";

const SPEC: SpecContent = {
  repository: "orchestra-app",
  objective: "Turn tickets into reviewed PRs.",
  scope: ["build the widget"],
  out_of_scope: ["the gadget"],
  requirements: ["must be blue"],
  acceptance_criteria: ["widget renders"],
  validation: ["run vitest"],
  constraints: ["no new deps"],
  dependencies: [],
};

const DIFF = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1 +1 @@",
  '-export const colour = "red";',
  '+export const colour = "blue";',
].join("\n");

const BASE: ReviewPromptContext = {
  spec: { version: 3, content: SPEC },
  decisions: [
    {
      issueId: "issue_784",
      decision: "Receipt language is device-local.",
      clarification: "Reinstall resets it.",
      chosenOption: "device-local",
      author: "user@example.com",
      decidedAt: "2026-09-20",
    },
    {
      issueId: "issue_785",
      decision: "Blue is #0000ff.",
      author: "lead@example.com",
      decidedAt: "2026-09-21",
    },
  ],
  diff: DIFF,
  untracked: [
    { path: "src/new-file.ts", content: "export const added = 1;\n" },
    { path: "docs/notes.md", content: "# Notes\n" },
  ],
  repository: {
    name: "goopter_odoo_modules",
    defaultBranch: "main",
    branch: "agent/GOOP-421-ab12cd",
  },
  testCommand: "pnpm test",
};

describe("buildReviewPrompt (design.md §9.8)", () => {
  it("renders the spec with the spec-markdown renderer", () => {
    const prompt = buildReviewPrompt(BASE);

    expect(prompt).toMatch(/^## Specification \(revision 3\)$/m);
    expect(prompt).toContain(renderSpecMarkdown(SPEC));
  });

  it("lists every decision in the buildUserPrompt format", () => {
    const prompt = buildReviewPrompt(BASE);

    expect(prompt).toContain(
      "- issue_784: Receipt language is device-local. Clarification: Reinstall resets it. Chosen option: device-local (user@example.com on 2026-09-20)",
    );
    expect(prompt).toContain(
      "- issue_785: Blue is #0000ff. (lead@example.com on 2026-09-21)",
    );
  });

  it('renders "None." when there are no decisions or untracked files', () => {
    const prompt = buildReviewPrompt({ ...BASE, decisions: [], untracked: [] });

    expect(prompt).toContain("## Decisions recorded on this task\nNone.");
    expect(prompt).toContain("## Untracked files\nNone.");
  });

  it("puts the diff in a fenced diff block", () => {
    const prompt = buildReviewPrompt(BASE);

    expect(prompt).toContain("```diff\n" + DIFF + "\n```");
  });

  it("marks an empty diff instead of rendering an empty block", () => {
    const prompt = buildReviewPrompt({ ...BASE, diff: "" });

    expect(prompt).toMatch(/## Diff against the merge base\nNo changes to tracked files\./);
  });

  it("puts each untracked file's content in its own fenced block under its path", () => {
    const prompt = buildReviewPrompt(BASE);

    expect(prompt).toContain("### src/new-file.ts\n```\nexport const added = 1;\n```");
    expect(prompt).toContain("### docs/notes.md\n```\n# Notes\n```");
  });

  it("lengthens a fence so content containing backticks cannot close it", () => {
    const content = "Example:\n```ts\nconst x = 1;\n```\n";
    const prompt = buildReviewPrompt({
      ...BASE,
      untracked: [{ path: "README.md", content }],
    });

    expect(prompt).toContain("### README.md\n````\n" + content + "````");
  });

  it("names the repository, branches and test command, omitting a null test command", () => {
    const prompt = buildReviewPrompt(BASE);
    expect(prompt).toContain(
      "## Repository\nName: goopter_odoo_modules\nDefault branch: main\nWorking branch: agent/GOOP-421-ab12cd\nTest command: pnpm test",
    );

    expect(buildReviewPrompt({ ...BASE, testCommand: null })).not.toContain(
      "Test command:",
    );
  });

  it("closes with the JSON-only reply instruction", () => {
    const prompt = buildReviewPrompt(BASE);
    const instructions = prompt.slice(prompt.lastIndexOf("## Instructions"));

    expect(prompt.indexOf("## Instructions")).toBeGreaterThan(
      prompt.indexOf("## Untracked files"),
    );
    expect(instructions).toContain("exactly one JSON document and nothing else");
    expect(instructions).toContain('"verdict"');
    expect(instructions).toContain('"findings"');
    for (const field of ['"severity"', '"file"', '"line"', '"description"', '"action"']) {
      expect(instructions).toContain(field);
    }
  });

  it("carries no ticket section", () => {
    const prompt = buildReviewPrompt(BASE);

    expect(prompt).not.toMatch(/^## Ticket/m);
  });

  it("emits the sections in order", () => {
    const prompt = buildReviewPrompt(BASE);
    const headings = [
      "## Specification (revision 3)",
      "## Decisions recorded on this task",
      "## Repository",
      "## Diff against the merge base",
      "## Untracked files",
      "## Instructions",
    ];
    let cursor = -1;
    for (const heading of headings) {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`^${escaped}$`, "m").exec(prompt);
      expect(match, heading).not.toBeNull();
      expect(match!.index).toBeGreaterThan(cursor);
      cursor = match!.index;
    }
  });

  it("is exported from the package index", () => {
    expect(prompts.buildReviewPrompt).toBe(buildReviewPrompt);
  });

  it("matches the full example snapshot", () => {
    expect(buildReviewPrompt(BASE)).toMatchSnapshot();
  });
});
