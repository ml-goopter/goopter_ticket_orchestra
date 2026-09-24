import { describe, expect, it } from "vitest";
import { placeholder as corePlaceholder } from "@orchestra/core";
import { placeholder as dbPlaceholder } from "@orchestra/db";
import { placeholder as adaptersPlaceholder } from "@orchestra/adapters";
import { placeholder as promptsPlaceholder } from "@orchestra/prompts";
import { PACKAGE_NAME, placeholder } from "./index.js";

describe("@orchestra/worker placeholder export", () => {
  it("exposes a placeholder symbol composed with core, db, adapters, and prompts", () => {
    expect(placeholder()).toBe(
      [
        PACKAGE_NAME,
        corePlaceholder(),
        dbPlaceholder(),
        adaptersPlaceholder(),
        promptsPlaceholder(),
      ].join("+"),
    );
    expect(PACKAGE_NAME).toBe("@orchestra/worker");
  });
});
