import { describe, expect, it } from "vitest";
import { formatDateTime, formatRelativeTime } from "./datetime.js";

describe("formatDateTime", () => {
  it("renders a local date and time containing the year", () => {
    const result = formatDateTime("2026-01-05T15:04:00.000Z");
    expect(result).toContain("2026");
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns a fallback for an unparseable string instead of throwing (F2)", () => {
    expect(() => formatDateTime("not-a-date")).not.toThrow();
    expect(formatDateTime("not-a-date")).toBe("—");
  });

  it("returns a fallback for null and undefined (F2)", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-05T12:00:00.000Z");

  it("renders 'just now' for under 45 seconds", () => {
    expect(formatRelativeTime("2026-01-05T11:59:30.000Z", now)).toBe("just now");
  });

  it("renders minutes ago", () => {
    expect(formatRelativeTime("2026-01-05T11:55:00.000Z", now)).toBe("5 min ago");
  });

  it("renders hours ago", () => {
    expect(formatRelativeTime("2026-01-05T09:00:00.000Z", now)).toBe("3 hr ago");
  });

  it("renders days ago, pluralized", () => {
    expect(formatRelativeTime("2026-01-02T12:00:00.000Z", now)).toBe("3 days ago");
  });

  it("renders 1 day ago without a trailing 's'", () => {
    expect(formatRelativeTime("2026-01-04T12:00:00.000Z", now)).toBe("1 day ago");
  });

  it("falls back to an absolute date beyond 30 days", () => {
    const result = formatRelativeTime("2025-11-01T12:00:00.000Z", now);
    expect(result).toBe(formatDateTime("2025-11-01T12:00:00.000Z"));
  });

  it("renders 'just now' for a future timestamp within 45 seconds (F1)", () => {
    expect(formatRelativeTime("2026-01-05T12:00:30.000Z", now)).toBe("just now");
  });

  it("renders 'in X min' for a future timestamp (F1)", () => {
    expect(formatRelativeTime("2026-01-05T12:05:00.000Z", now)).toBe("in 5 min");
  });

  it("renders 'in X hr' for a future timestamp (F1)", () => {
    expect(formatRelativeTime("2026-01-05T15:00:00.000Z", now)).toBe("in 3 hr");
  });

  it("renders 'in X days' for a future timestamp (F1)", () => {
    expect(formatRelativeTime("2026-01-08T12:00:00.000Z", now)).toBe("in 3 days");
  });

  it("returns a fallback for an unparseable string instead of throwing (F2)", () => {
    expect(() => formatRelativeTime("not-a-date", now)).not.toThrow();
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });

  it("returns a fallback for null and undefined (F2)", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
    expect(formatRelativeTime(undefined, now)).toBe("—");
  });
});
