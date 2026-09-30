import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("components.css", () => {
  it("resets heading margins to 0 inside .topbar", () => {
    const componentsCss = readFileSync(
      resolve(__dirname, "./components.css"),
      "utf-8"
    );

    // Check that there is a rule for headings inside .topbar that sets margin to 0
    const topbarHeadingRulePattern =
      /\.topbar\s+(?:h[1-6]|(?:h[1-6]\s*,\s*)*h[1-6])\s*\{[^}]*margin\s*:\s*0\s*;[^}]*\}/s;

    expect(componentsCss).toMatch(topbarHeadingRulePattern);
  });
});
