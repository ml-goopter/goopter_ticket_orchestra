import { describe, expect, it } from "vitest";
import { placeholder as corePlaceholder } from "@orchestra/core";
import { placeholder as dbPlaceholder } from "@orchestra/db";
import { PACKAGE_NAME, placeholder } from "./index.js";

describe("@orchestra/api placeholder export", () => {
  it("exposes a placeholder symbol composed with core and db", () => {
    expect(placeholder()).toBe(
      `${PACKAGE_NAME}+${corePlaceholder()}+${dbPlaceholder()}`,
    );
    expect(PACKAGE_NAME).toBe("@orchestra/api");
  });
});
