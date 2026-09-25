import { z } from "zod";

/**
 * Specification content schema (design.md §4.3). Stored in
 * `specification_revisions.content`. Draft parsing (`SpecContentSchema.parse`
 * / `.safeParse`) accepts empty lists; only `validateSpecForApproval` below
 * enforces the approval rule.
 */
export const SpecContentSchema = z.object({
  repository: z.string(),
  objective: z.string(),
  scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
  requirements: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  validation: z.array(z.string()),
  constraints: z.array(z.string()),
  dependencies: z.array(z.string()),
  risks: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export type SpecContent = z.infer<typeof SpecContentSchema>;

export type SpecApprovalResult =
  | { ok: true; content: SpecContent }
  | { ok: false; errors: string[] };

/**
 * Every list field except `risks` and `dependencies` must be non-empty for a
 * spec to be approved (design.md §4.3). An empty `dependencies` list means
 * the task depends on nothing.
 */
const REQUIRED_NON_EMPTY_LIST_FIELDS = [
  "scope",
  "out_of_scope",
  "requirements",
  "acceptance_criteria",
  "validation",
  "constraints",
] as const satisfies readonly (keyof SpecContent)[];

/**
 * Approval requires: the content is schema-valid, `repository` resolves via
 * `repositoryExists`, and every list field except `risks` and `dependencies`
 * is non-empty (design.md §4.3).
 */
export function validateSpecForApproval(
  content: unknown,
  repositoryExists: (name: string) => boolean,
): SpecApprovalResult {
  const parsed = SpecContentSchema.safeParse(content);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) =>
          `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
      ),
    };
  }

  const spec = parsed.data;
  const errors: string[] = [];

  if (!repositoryExists(spec.repository)) {
    errors.push(`repository "${spec.repository}" does not resolve`);
  }

  for (const field of REQUIRED_NON_EMPTY_LIST_FIELDS) {
    const list = spec[field] as readonly string[];
    if (list.length === 0) {
      errors.push(`${field} must not be empty`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, content: spec };
}
