import { z } from "zod";

/**
 * `raise_issue`'s `options` shape (packages/core/src/agent-tools.ts
 * `OptionSchema`), as stored verbatim in `issues.suggested_options` (jsonb)
 * and returned by `GET /issues/:id` as `issue.suggestedOptions: unknown`
 * (design.md §14 Issue Object, §18).
 */
export const IssueOptionSchema = z.object({
  id: z.string(),
  description: z.string(),
  tradeoff: z.string(),
});
export type IssueOption = z.infer<typeof IssueOptionSchema>;

const IssueOptionsSchema = z.array(IssueOptionSchema);

/**
 * Parses `issue.suggestedOptions` into a typed list of radio choices.
 * Returns `[]` for `null`/malformed content rather than throwing, since the
 * field is `unknown` at the api boundary and a bad shape should degrade to
 * "no options" instead of breaking the rest of the issue detail view.
 */
export function parseSuggestedOptions(value: unknown): IssueOption[] {
  if (value === null || value === undefined) {
    return [];
  }
  const parsed = IssueOptionsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
