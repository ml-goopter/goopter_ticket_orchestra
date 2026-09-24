import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, placeholder } from "./index.js";

describe("@orchestra/core placeholder export", () => {
  it("exposes a placeholder symbol identifying the package", () => {
    expect(placeholder()).toBe(PACKAGE_NAME);
    expect(PACKAGE_NAME).toBe("@orchestra/core");
  });
});
