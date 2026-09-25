import { describe, expect, it } from "vitest";
import { formatAge, formatCostUsd } from "./format.js";

describe("formatAge", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it("formats minutes below an hour", () => {
    expect(formatAge("2026-01-01T11:57:00.000Z", now)).toBe("3m");
  });

  it("formats hours below a day", () => {
    expect(formatAge("2026-01-01T10:00:00.000Z", now)).toBe("2h");
  });

  it("formats days at a day or more", () => {
    expect(formatAge("2025-12-27T12:00:00.000Z", now)).toBe("5d");
  });

  it("floors negative or zero differences to 0m", () => {
    expect(formatAge("2026-01-01T12:00:00.000Z", now)).toBe("0m");
    expect(formatAge("2026-01-01T13:00:00.000Z", now)).toBe("0m");
  });
});

describe("formatCostUsd", () => {
  it("formats with a dollar sign and two decimals", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(1.5)).toBe("$1.50");
    expect(formatCostUsd(12.345)).toBe("$12.35");
  });
});
