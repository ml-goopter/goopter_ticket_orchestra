import type { SpecContent } from "@orchestra/core";

/**
 * Renders a `SpecContent` document as markdown, one `###` heading per field
 * in schema order (design.md §4.3), for embedding in prompts and diffs.
 * List fields render as `- ` bullets, `notes` as a paragraph, and `risks`
 * / `notes` are omitted entirely when absent.
 */

const TEXT_FIELDS = ["repository", "objective"] as const;

const LIST_FIELDS = [
  "scope",
  "out_of_scope",
  "requirements",
  "acceptance_criteria",
  "validation",
  "constraints",
  "dependencies",
  "risks",
] as const;

const HEADINGS: Record<keyof SpecContent, string> = {
  repository: "Repository",
  objective: "Objective",
  scope: "Scope",
  out_of_scope: "Out of scope",
  requirements: "Requirements",
  acceptance_criteria: "Acceptance criteria",
  validation: "Validation",
  constraints: "Constraints",
  dependencies: "Dependencies",
  risks: "Risks",
  notes: "Notes",
};

/** Schema-order field list, matching `SpecContentSchema` (design.md §4.3). */
const FIELD_ORDER = [
  "repository",
  "objective",
  "scope",
  "out_of_scope",
  "requirements",
  "acceptance_criteria",
  "validation",
  "constraints",
  "dependencies",
  "risks",
  "notes",
] as const satisfies readonly (keyof SpecContent)[];

export function renderSpecMarkdown(spec: SpecContent): string {
  const sections: string[] = [];

  for (const field of FIELD_ORDER) {
    if ((field === "risks" || field === "notes") && spec[field] === undefined) {
      continue;
    }

    const heading = `### ${HEADINGS[field]}`;

    if (field === "notes") {
      sections.push(`${heading}\n\n${spec.notes}`);
      continue;
    }

    if ((TEXT_FIELDS as readonly string[]).includes(field)) {
      sections.push(`${heading}\n\n${spec[field] as string}`);
      continue;
    }

    if ((LIST_FIELDS as readonly string[]).includes(field)) {
      const items = (spec[field] as readonly string[] | undefined) ?? [];
      const body = items.map((item) => `- ${item}`).join("\n");
      sections.push(`${heading}\n\n${body}`);
      continue;
    }
  }

  return `${sections.join("\n\n")}\n`;
}
