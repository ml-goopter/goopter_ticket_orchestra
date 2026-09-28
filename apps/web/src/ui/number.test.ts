import { describe, expect, it } from "vitest";
import { formatNumber, formatUsd } from "./number.js";

describe("formatNumber", () => {
  it("adds thousands separators", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("passes through small numbers unchanged", () => {
    expect(formatNumber(42)).toBe("42");
  });
});

describe("formatUsd", () => {
  it("uses 4 decimals below one cent", () => {
    expect(formatUsd(0.004)).toBe("$0.0040");
  });

  it("uses 2 decimals at or above one cent", () => {
    expect(formatUsd(12.3)).toBe("$12.30");
  });

  it("formats exactly zero with 2 decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("adds thousands separators for large amounts", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});
