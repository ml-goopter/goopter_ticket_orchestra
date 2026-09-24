import { customType, timestamp } from "drizzle-orm/pg-core";

/** `timestamptz` column (design.md §4.2: "Timestamps are `timestamptz`."). */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}

/**
 * Case-insensitive text, used for `users.email` (design.md §4.2). Requires
 * the `citext` extension, enabled in the first migration
 * (drizzle/0000_*.sql).
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});
