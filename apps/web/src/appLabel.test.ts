import { describe, expect, it } from "vitest";
import { placeholder as corePlaceholder } from "@orchestra/core";
import { PACKAGE_NAME, getAppLabel } from "./appLabel.js";

describe("@orchestra/web appLabel", () => {
  it("composes a label with @orchestra/core, with no DOM required", () => {
    expect(getAppLabel()).toBe(`${PACKAGE_NAME}+${corePlaceholder()}`);
    expect(PACKAGE_NAME).toBe("@orchestra/web");
  });
});
