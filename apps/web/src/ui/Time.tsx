import { DATE_FALLBACK, formatDateTime, formatRelativeTime, isValidIso } from "./datetime.js";

export interface TimeProps {
  /** ISO timestamp, e.g. a `createdAt`/`updatedAt` field from the api. */
  value: string | null | undefined;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date;
}

/**
 * `<time>` carrying the raw ISO string in `dateTime` (machine-readable)
 * and the full local time in `title` (hover), with a short relative
 * label as its visible text. A missing or unparseable `value` renders
 * `DATE_FALLBACK` with no `dateTime` attribute, instead of throwing (F2).
 */
export function Time({ value, now }: TimeProps) {
  if (!isValidIso(value)) {
    return <time>{DATE_FALLBACK}</time>;
  }
  return (
    <time dateTime={value ?? undefined} title={formatDateTime(value)}>
      {formatRelativeTime(value, now)}
    </time>
  );
}
