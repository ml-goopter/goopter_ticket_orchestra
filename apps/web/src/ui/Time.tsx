import { formatDateTime, formatRelativeTime } from "./datetime.js";

export interface TimeProps {
  /** ISO timestamp, e.g. a `createdAt`/`updatedAt` field from the api. */
  value: string;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date;
}

/**
 * `<time>` carrying the raw ISO string in `dateTime` (machine-readable)
 * and the full local time in `title` (hover), with a short relative
 * label as its visible text.
 */
export function Time({ value, now }: TimeProps) {
  return (
    <time dateTime={value} title={formatDateTime(value)}>
      {formatRelativeTime(value, now)}
    </time>
  );
}
