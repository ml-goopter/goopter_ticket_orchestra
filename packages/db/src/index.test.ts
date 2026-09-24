import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, placeholder } from "./index.js";

describe("@orchestra/db placeholder export", () => {
  it("exposes a placeholder symbol composed with @orchestra/core", () => {
    expect(placeholder()).toBe(`${PACKAGE_NAME}+@orchestra/core`);
    expect(PACKAGE_NAME).toBe("@orchestra/db");
  });
});
