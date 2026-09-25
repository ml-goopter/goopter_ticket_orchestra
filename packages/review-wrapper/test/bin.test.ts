import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(PACKAGE_DIR, "bin", "orchestra-review.js");

/**
 * AC8: the package bin runs the built dist (Q7: no bundler). Needs
 * `corepack pnpm -r build` first, as the test command does.
 */
describe("orchestra-review bin", () => {
  it("is declared in package.json and is executable", () => {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin["orchestra-review"]).toBe("./bin/orchestra-review.js");
    expect(statSync(BIN).mode & 0o111).not.toBe(0);
    expect(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("runs from the built dist and exits 3 with the error on stderr when env is missing", () => {
    expect(existsSync(path.join(PACKAGE_DIR, "dist", "cli.js")), "run the build first").toBe(true);
    const env = { ...process.env };
    delete env.ORCHESTRA_URL;
    delete env.ORCHESTRA_TOKEN;

    const result = spawnSync(BIN, ["--round", "1"], {
      cwd: os.tmpdir(),
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/ORCHESTRA_URL/);
  });

  it("prints the usage line and exits 3 when --round is missing", () => {
    const result = spawnSync(BIN, [], { cwd: os.tmpdir(), encoding: "utf8" });

    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/usage: orchestra-review --round <n>/);
  });
});
