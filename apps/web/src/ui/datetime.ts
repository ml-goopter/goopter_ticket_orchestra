/**
 * Date/time formatting for timestamps returned by the api as ISO strings
 * (design.md §14 Board "age in column", Task detail timeline).
 */

/** Fallback text for a missing or unparseable timestamp (F2). */
export const DATE_FALLBACK = "—";

/** `null`/`undefined`/an unparseable string all parse to `null`, never throw. */
function parseDate(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True for a `value` `formatDateTime`/`formatRelativeTime` can parse. */
export function isValidIso(value: string | null | undefined): boolean {
  return parseDate(value) !== null;
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * ISO string to a local date-time string, e.g. "Jan 5, 2026, 3:04 PM".
 * `null`, `undefined`, or an unparseable string return `DATE_FALLBACK`
 * instead of throwing (F2).
 */
export function formatDateTime(iso: string | null | undefined): string {
  const date = parseDate(iso);
  return date ? dateTimeFormatter.format(date) : DATE_FALLBACK;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * ISO string to a short relative label, e.g. "5 min ago", or "in 5 min"
 * for a future timestamp (F1). Within 45s either side of `now` is "just
 * now". `null`, `undefined`, or an unparseable string return
 * `DATE_FALLBACK` instead of throwing (F2). `now` is injectable so tests
 * don't depend on the wall clock; defaults to `new Date()`.
 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  const date = parseDate(iso);
  if (!date) return DATE_FALLBACK;

  const diffMs = now.getTime() - date.getTime();
  const absDiffMs = Math.abs(diffMs);
  const isFuture = diffMs < 0;

  if (absDiffMs < 45_000) {
    return "just now";
  }
  if (absDiffMs < HOUR) {
    const minutes = Math.round(absDiffMs / MINUTE);
    return isFuture ? `in ${minutes} min` : `${minutes} min ago`;
  }
  if (absDiffMs < DAY) {
    const hours = Math.round(absDiffMs / HOUR);
    return isFuture ? `in ${hours} hr` : `${hours} hr ago`;
  }
  if (absDiffMs < 30 * DAY) {
    const days = Math.round(absDiffMs / DAY);
    const label = `${days} day${days === 1 ? "" : "s"}`;
    return isFuture ? `in ${label}` : `${label} ago`;
  }
  return formatDateTime(iso);
}
