import { describe, expect, it } from "vitest";
import { formatCompactNumber } from "./format.js";

describe("formatCompactNumber", () => {
  it("formats a value in the millions with one decimal and an M suffix", () => {
    expect(formatCompactNumber(48213904)).toBe("48.2M");
  });

  it("formats a value in the thousands with one decimal and a K suffix", () => {
    expect(formatCompactNumber(788403)).toBe("788.4K");
  });

  it("leaves a value under 1000 unabbreviated", () => {
    expect(formatCompactNumber(190)).toBe("190");
  });

  it("formats zero as 0", () => {
    expect(formatCompactNumber(0)).toBe("0");
  });
});
