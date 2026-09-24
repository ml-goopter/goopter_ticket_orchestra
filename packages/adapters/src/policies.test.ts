import { describe, expect, it } from "vitest";
import {
  CLAUDE_BUILTIN_TOOLS,
  allowedToolsFor,
  builtinToolsFor,
  permissionModeFor,
  settingSourcesFor,
} from "./policies.js";

describe("allowedToolsFor (design.md §7.1 tool policies)", () => {
  it("returns the exact spec list", () => {
    expect(allowedToolsFor("spec")).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "mcp__orchestra__propose_spec",
      "mcp__orchestra__raise_issue",
      "mcp__orchestra__note",
      "mcp__orchestra__report_complete",
      "mcp__orchestra__report_failed",
    ]);
  });

  it("grants spec the reporting tools design.md §8 gives its role", () => {
    const spec = allowedToolsFor("spec");
    expect(spec).toContain("mcp__orchestra__report_complete");
    expect(spec).toContain("mcp__orchestra__report_failed");
  });

  it("gives review no agent-tools: a review returns findings only", () => {
    expect(
      allowedToolsFor("review", { testCommand: "pnpm -r test" }).filter((t) =>
        t.startsWith("mcp__"),
      ),
    ).toEqual([]);
  });

  it("returns the exact review list without a test command", () => {
    expect(allowedToolsFor("review")).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff:*)",
      "Bash(git log:*)",
    ]);
  });

  it("appends the repository test command to the review list", () => {
    expect(allowedToolsFor("review", { testCommand: "pnpm -r test" })).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(pnpm -r test)",
    ]);
  });

  it("ignores an empty test command", () => {
    expect(allowedToolsFor("review", { testCommand: "" })).toEqual(
      allowedToolsFor("review"),
    );
  });

  it("returns every built-in plus the orchestra MCP wildcard for implementation", () => {
    expect(allowedToolsFor("implementation")).toEqual([
      ...CLAUDE_BUILTIN_TOOLS,
      "mcp__orchestra__*",
    ]);
    expect(allowedToolsFor("implementation")).toContain("Write");
    expect(allowedToolsFor("implementation")).toContain("Edit");
    expect(allowedToolsFor("implementation")).toContain("Bash");
  });

  it("never grants write or unrestricted shell to the read-only policies", () => {
    for (const policy of ["spec", "review"] as const) {
      const tools = allowedToolsFor(policy, { testCommand: "pnpm -r test" });
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Edit");
      expect(tools).not.toContain("NotebookEdit");
      expect(tools).not.toContain("Bash");
      expect(tools.filter((t) => t.startsWith("Bash"))).toSatisfy(
        (bash: string[]) => bash.every((t) => /^Bash\(.+\)$/.test(t)),
      );
    }
  });

  it("returns a fresh array so callers cannot mutate the policy", () => {
    const first = allowedToolsFor("spec");
    first.push("Write");
    expect(allowedToolsFor("spec")).not.toContain("Write");
  });
});

describe("permissionModeFor (the allow list must be the gate)", () => {
  it("denies anything not pre-approved for the read-only roles", () => {
    expect(permissionModeFor("spec")).toBe("dontAsk");
    expect(permissionModeFor("review")).toBe("dontAsk");
  });

  it("bypasses permissions for implementation (design.md §7.1)", () => {
    expect(permissionModeFor("implementation")).toBe("bypassPermissions");
  });
});

describe("settingSourcesFor (repository filesystem settings, sdk.d.ts ~2245)", () => {
  it("disables filesystem settings for the read-only roles", () => {
    expect(settingSourcesFor("spec")).toEqual([]);
    expect(settingSourcesFor("review")).toEqual([]);
  });

  it("loads only the target repository's project settings for implementation", () => {
    expect(settingSourcesFor("implementation")).toEqual(["project"]);
  });

  it("returns a fresh array so callers cannot mutate a shared constant", () => {
    const first = settingSourcesFor("implementation");
    first.push("user");
    expect(settingSourcesFor("implementation")).toEqual(["project"]);
  });
});

describe("builtinToolsFor (base set of built-ins offered to the session)", () => {
  it("offers a spec session only the built-ins its allow list names", () => {
    expect(builtinToolsFor("spec")).toEqual(["Read", "Glob", "Grep", "Bash"]);
  });

  it("offers a review session only the built-ins its allow list names", () => {
    expect(builtinToolsFor("review")).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(builtinToolsFor("review", { testCommand: "pnpm -r test" })).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash",
    ]);
  });

  it("never offers a write tool to a read-only role", () => {
    for (const policy of ["spec", "review"] as const) {
      const tools = builtinToolsFor(policy, { testCommand: "pnpm -r test" });
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Edit");
      expect(tools).not.toContain("NotebookEdit");
      expect(tools).not.toContain("Task");
    }
  });

  it("carries no MCP entries: the tools option names built-ins only", () => {
    for (const policy of ["spec", "review"] as const) {
      for (const tool of builtinToolsFor(policy) ?? []) {
        expect(CLAUDE_BUILTIN_TOOLS).toContain(tool);
      }
    }
  });

  it("leaves implementation on the runtime default, i.e. every built-in", () => {
    expect(builtinToolsFor("implementation")).toBeUndefined();
  });
});
