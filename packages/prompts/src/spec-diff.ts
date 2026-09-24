import { createTwoFilesPatch } from "diff";
import type { SpecContent } from "@orchestra/core";
import { renderSpecMarkdown } from "./spec-markdown.js";

/**
 * Unified diff between the rendered markdown of two spec revisions, used in
 * the `## Specification revised to version N` resume header (design.md
 * §9.2, §10.4). Equal specs produce a single "no changes" line rather than
 * an empty patch.
 */
export function diffSpecs(
  a: SpecContent,
  b: SpecContent,
  labels?: { a: string; b: string },
): string {
  const before = renderSpecMarkdown(a);
  const after = renderSpecMarkdown(b);

  if (before === after) {
    return "No changes.";
  }

  return createTwoFilesPatch(
    labels?.a ?? "previous specification",
    labels?.b ?? "revised specification",
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  );
}
