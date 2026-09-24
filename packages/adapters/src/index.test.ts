import { describe, expect, it } from "vitest";
import { placeholder as corePlaceholder } from "@orchestra/core";
import { placeholder as promptsPlaceholder } from "@orchestra/prompts";
import { PACKAGE_NAME, placeholder } from "./index.js";

describe("@orchestra/adapters placeholder export", () => {
  it("exposes a placeholder symbol composed with core and prompts", () => {
    expect(placeholder()).toBe(
      `${PACKAGE_NAME}+${corePlaceholder()}+${promptsPlaceholder()}`,
    );
    expect(PACKAGE_NAME).toBe("@orchestra/adapters");
  });
});
