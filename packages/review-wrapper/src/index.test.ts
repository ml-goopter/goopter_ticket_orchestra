import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, placeholder } from "./index.js";

describe("@orchestra/review-wrapper placeholder export", () => {
  it("exposes a placeholder symbol composed with @orchestra/core", () => {
    expect(placeholder()).toBe(`${PACKAGE_NAME}+@orchestra/core`);
    expect(PACKAGE_NAME).toBe("@orchestra/review-wrapper");
  });
});
