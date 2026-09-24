import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tsconfigPath = fileURLToPath(
  new URL("../tsconfig.json", import.meta.url),
);
const violationFilePath = fileURLToPath(
  new URL("../src/__boundary_violation.ts", import.meta.url),
);
const tscBinPath = fileURLToPath(
  new URL("../bin/tsc", import.meta.resolve("typescript/package.json")),
);

describe("@orchestra/adapters dependency boundary (design.md §3: adapters depends on nothing from db)", () => {
  it("fails type-check when it imports @orchestra/db", () => {
    expect(existsSync(violationFilePath)).toBe(false);

    writeFileSync(
      violationFilePath,
      'import { placeholder } from "@orchestra/db";\nexport const violation = placeholder();\n',
      "utf8",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [tscBinPath, "--noEmit", "-p", tsconfigPath],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
    } finally {
      rmSync(violationFilePath, { force: true });
    }
  });
});
