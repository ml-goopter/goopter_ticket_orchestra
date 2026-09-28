/**
 * Date/time formatting for timestamps returned by the api as ISO strings
 * (design.md §14 Board "age in column", Task detail timeline).
 */

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** ISO string to a local date-time string, e.g. "Jan 5, 2026, 3:04 PM". */
export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * ISO string to a short relative label, e.g. "5 min ago". `now` is
 * injectable so tests don't depend on the wall clock; defaults to
 * `new Date()`.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();

  if (diffMs < 45_000) {
    return "just now";
  }
  if (diffMs < HOUR) {
    const minutes = Math.round(diffMs / MINUTE);
    return `${minutes} min ago`;
  }
  if (diffMs < DAY) {
    const hours = Math.round(diffMs / HOUR);
    return `${hours} hr ago`;
  }
  if (diffMs < 30 * DAY) {
    const days = Math.round(diffMs / DAY);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return formatDateTime(iso);
}
