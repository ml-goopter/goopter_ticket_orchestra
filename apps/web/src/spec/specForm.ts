import type { SpecContent } from "@orchestra/core";

/**
 * List-field editors the draft form renders, one per field, in
 * `SpecContentSchema` order after `repository`/`objective` (design.md §4.3).
 */
export const SPEC_LIST_FIELDS = [
  "scope",
  "out_of_scope",
  "requirements",
  "acceptance_criteria",
  "validation",
  "constraints",
  "dependencies",
  "risks",
] as const satisfies readonly (keyof SpecContent)[];

export type SpecListField = (typeof SPEC_LIST_FIELDS)[number];

/** Every `SpecContent` field, in schema order, for the diff/highlight helpers below. */
const ALL_FIELDS = [
  "repository",
  "objective",
  ...SPEC_LIST_FIELDS,
  "notes",
] as const satisfies readonly (keyof SpecContent)[];

export const SPEC_FIELD_LABELS: Record<(typeof ALL_FIELDS)[number], string> = {
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

/** A blank draft to start the form from when the task has no draft revision yet. */
export function emptySpecContent(repository = ""): SpecContent {
  return {
    repository,
    objective: "",
    scope: [],
    out_of_scope: [],
    requirements: [],
    acceptance_criteria: [],
    validation: [],
    constraints: [],
    dependencies: [],
    risks: [],
    notes: "",
  };
}

function listEquals(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const av = a ?? [];
  const bv = b ?? [];
  return av.length === bv.length && av.every((value, index) => value === bv[index]);
}

/**
 * The set of `SpecContent` fields whose value differs between `a` and `b`,
 * used both for the "changed fields" highlight on `spec.proposed`/
 * `spec.revised` (design.md §14 Spec builder row) and for the dirty check
 * against unsaved local edits (C24).
 */
export function changedSpecFields(a: SpecContent, b: SpecContent): Set<(typeof ALL_FIELDS)[number]> {
  const changed = new Set<(typeof ALL_FIELDS)[number]>();
  if (a.repository !== b.repository) changed.add("repository");
  if (a.objective !== b.objective) changed.add("objective");
  if ((a.notes ?? "") !== (b.notes ?? "")) changed.add("notes");
  for (const field of SPEC_LIST_FIELDS) {
    if (!listEquals(a[field], b[field])) {
      changed.add(field);
    }
  }
  return changed;
}

export function specContentEquals(a: SpecContent, b: SpecContent): boolean {
  return changedSpecFields(a, b).size === 0;
}
