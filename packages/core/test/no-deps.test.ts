import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(
  new URL("../package.json", import.meta.url),
);

describe("@orchestra/core package.json (design.md §3: core has no I/O, only zod as a runtime dep)", () => {
  it("declares exactly zod as its runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;

    const deps = pkg["dependencies"] as Record<string, string> | undefined;

    expect(deps).toBeDefined();
    expect(Object.keys(deps!)).toEqual(["zod"]);
  });

  it("declares no workspace:* dependency anywhere in the manifest", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;

    const depFields = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;

    for (const field of depFields) {
      const deps = pkg[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [name, range] of Object.entries(deps)) {
        expect(
          range.startsWith("workspace:"),
          `${field}.${name} must not be a workspace dependency`,
        ).toBe(false);
      }
    }
  });
});
