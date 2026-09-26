import { describe, expect, it } from "vitest";
import { validateDisplayName, validateProjectInput, validateRepositoryInput, validateUserInput } from "./validation.js";

const VALID_PROJECT = {
  key: "GOOP",
  name: "Goopter",
  jiraJql: "project = GOOP",
  maxInfraRetries: 3,
  maxProtocolRetries: 2,
  maxCiRounds: 3,
  maxReviewRounds: 3,
  maxBudgetUsd: null,
};

const VALID_REPOSITORY = {
  projectId: "proj-1",
  name: "goopter_odoo_modules",
  gitUrl: "git@example.com:goopter/goopter_odoo_modules.git",
  defaultBranch: "main",
  defaultRuntime: "claude" as const,
  defaultModel: null,
  maxConcurrentWorktrees: 1,
  requiredCapability: null,
  setupCommand: null,
  testCommand: null,
};

const VALID_USER = {
  email: "newuser@example.com",
  password: "a very long password",
  displayName: "New User",
};

describe("validateProjectInput", () => {
  it("returns no errors for a valid input", () => {
    expect(validateProjectInput(VALID_PROJECT)).toEqual({});
  });

  it("requires key, name, and jira_jql", () => {
    const errors = validateProjectInput({ ...VALID_PROJECT, key: " ", name: "", jiraJql: "" });
    expect(errors.key).toBeTruthy();
    expect(errors.name).toBeTruthy();
    expect(errors.jiraJql).toBeTruthy();
  });

  it("rejects a negative limit", () => {
    const errors = validateProjectInput({ ...VALID_PROJECT, maxInfraRetries: -1 });
    expect(errors.maxInfraRetries).toBe("maxInfraRetries must be a non-negative integer");
  });

  it("rejects a non-integer limit", () => {
    const errors = validateProjectInput({ ...VALID_PROJECT, maxCiRounds: 1.5 });
    expect(errors.maxCiRounds).toBeTruthy();
  });

  it("accepts a null budget and rejects a negative one", () => {
    expect(validateProjectInput({ ...VALID_PROJECT, maxBudgetUsd: null }).maxBudgetUsd).toBeUndefined();
    expect(validateProjectInput({ ...VALID_PROJECT, maxBudgetUsd: -5 }).maxBudgetUsd).toBeTruthy();
    expect(validateProjectInput({ ...VALID_PROJECT, maxBudgetUsd: 0 }).maxBudgetUsd).toBeUndefined();
  });
});

describe("validateRepositoryInput", () => {
  it("returns no errors for a valid input", () => {
    expect(validateRepositoryInput(VALID_REPOSITORY)).toEqual({});
  });

  it("requires project, name, git_url, and default_branch", () => {
    const errors = validateRepositoryInput({ ...VALID_REPOSITORY, projectId: "", name: "", gitUrl: "", defaultBranch: "" });
    expect(errors.projectId).toBeTruthy();
    expect(errors.name).toBeTruthy();
    expect(errors.gitUrl).toBeTruthy();
    expect(errors.defaultBranch).toBeTruthy();
  });

  it("rejects max_concurrent_worktrees under 1", () => {
    expect(validateRepositoryInput({ ...VALID_REPOSITORY, maxConcurrentWorktrees: 0 }).maxConcurrentWorktrees).toBeTruthy();
  });

  it("does not validate git_url format or test_command content (left to the api's 400)", () => {
    const errors = validateRepositoryInput({ ...VALID_REPOSITORY, gitUrl: "not-a-url", testCommand: "pnpm test && rm -rf /" });
    expect(errors.gitUrl).toBeUndefined();
    expect(errors.testCommand).toBeUndefined();
  });
});

describe("validateUserInput", () => {
  it("returns no errors for a valid input", () => {
    expect(validateUserInput(VALID_USER)).toEqual({});
  });

  it("requires email, password, and display_name", () => {
    const errors = validateUserInput({ email: "", password: "", displayName: "" });
    expect(errors.email).toBeTruthy();
    expect(errors.password).toBeTruthy();
    expect(errors.displayName).toBeTruthy();
  });
});

describe("validateDisplayName", () => {
  it("requires a non-blank display name", () => {
    expect(validateDisplayName("Renamed")).toEqual({});
    expect(validateDisplayName("  ")).toEqual({ displayName: "display_name is required" });
  });
});
