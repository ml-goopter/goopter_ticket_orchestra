import {
  ReviewFindingsDocumentSchema,
  type ReviewFindingsDocument,
} from "@orchestra/core";
import { ReviewError } from "./errors.js";

/** A whole reply wrapped in one ```json (or bare ```) fence. */
const FENCED = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

/**
 * Parses the review session's final text into `{ verdict, findings }`
 * validated by the core schemas. A surrounding code fence is stripped;
 * anything else that is not exactly that document is an error (C2).
 */
export function parseReviewReply(finalText: string): ReviewFindingsDocument {
  const trimmed = finalText.trim();
  const body = FENCED.exec(trimmed)?.[1] ?? trimmed;

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ReviewError(
      `reviewer reply is not a JSON document: ${excerpt(trimmed)}`,
    );
  }

  const parsed = ReviewFindingsDocumentSchema.safeParse(json);
  if (!parsed.success) {
    throw new ReviewError(
      `reviewer reply does not match { verdict, findings }: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function excerpt(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
