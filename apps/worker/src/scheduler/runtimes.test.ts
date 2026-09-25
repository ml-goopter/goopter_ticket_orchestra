import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRuntimes } from "./runtimes.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orchestra-runtimes-"));
  dirs.push(dir);
  return dir;
}

function binary(dir: string, name: string, mode = 0o755): void {
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, mode);
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("detectRuntimes (design.md §7.3)", () => {
  it("finds both binaries across PATH entries", () => {
    const a = tempDir();
    const b = tempDir();
    binary(a, "claude");
    binary(b, "codex");

    expect(detectRuntimes({ PATH: [a, b].join(path.delimiter) })).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("returns only the runtimes whose binary is present", () => {
    const a = tempDir();
    binary(a, "codex");

    expect(detectRuntimes({ PATH: a })).toEqual(["codex"]);
  });

  it("ignores a file that is not executable", () => {
    const a = tempDir();
    binary(a, "claude", 0o644);

    expect(detectRuntimes({ PATH: a })).toEqual([]);
  });

  it("ignores a directory named like a binary", () => {
    const a = tempDir();
    // A directory passes an X_OK check (it is searchable) but is not a binary.
    mkdirSync(path.join(a, "claude"));
    binary(a, "codex");

    expect(detectRuntimes({ PATH: a })).toEqual(["codex"]);
  });

  it("returns nothing for an empty or missing PATH", () => {
    expect(detectRuntimes({ PATH: "" })).toEqual([]);
    expect(detectRuntimes({})).toEqual([]);
  });
});
