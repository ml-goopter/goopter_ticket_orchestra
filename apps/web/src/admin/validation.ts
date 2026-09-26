import type { CreateProjectInput, CreateRepositoryInput, CreateUserInput } from "../api/admin.js";

/** Maps a field name to its inline validation message. Empty means valid. */
export type FieldErrors = Record<string, string>;

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Mirrors `apps/api/src/routes/projects.ts`'s `CreateProjectSchema` /
 * `PatchProjectSchema`: required key and name, non-negative integer
 * limits, and a non-negative (or absent/null) budget. `jira_jql` is
 * required by the same schema, so it is checked here too even though the
 * task contract's summary only calls out key/name -- otherwise a blank
 * jql is a guaranteed round trip to a 400.
 */
export function validateProjectInput(input: CreateProjectInput): FieldErrors {
  const errors: FieldErrors = {};
  if (input.key.trim() === "") {
    errors.key = "key is required";
  }
  if (input.name.trim() === "") {
    errors.name = "name is required";
  }
  if (input.jiraJql.trim() === "") {
    errors.jiraJql = "jira_jql is required";
  }
  for (const field of ["maxInfraRetries", "maxProtocolRetries", "maxCiRounds", "maxReviewRounds"] as const) {
    if (!isNonNegativeInteger(input[field])) {
      errors[field] = `${field} must be a non-negative integer`;
    }
  }
  if (input.maxBudgetUsd !== null && !(Number.isFinite(input.maxBudgetUsd) && input.maxBudgetUsd >= 0)) {
    errors.maxBudgetUsd = "max_budget_usd must not be negative";
  }
  return errors;
}

/**
 * Mirrors `apps/api/src/routes/repositories.ts`'s required fields and
 * `max_concurrent_worktrees` bound. `git_url` format and `test_command`'s
 * composed-command policy are deliberately left to the api's 400 (task
 * contract point 2): those are shown inline from the `ApiError`, not
 * duplicated here.
 */
export function validateRepositoryInput(input: CreateRepositoryInput): FieldErrors {
  const errors: FieldErrors = {};
  if (input.projectId.trim() === "") {
    errors.projectId = "project is required";
  }
  if (input.name.trim() === "") {
    errors.name = "name is required";
  }
  if (input.gitUrl.trim() === "") {
    errors.gitUrl = "git_url is required";
  }
  if (input.defaultBranch.trim() === "") {
    errors.defaultBranch = "default_branch is required";
  }
  if (!Number.isInteger(input.maxConcurrentWorktrees) || input.maxConcurrentWorktrees < 1) {
    errors.maxConcurrentWorktrees = "max_concurrent_worktrees must be at least 1";
  }
  return errors;
}

/** Mirrors `apps/api/src/routes/users.ts`'s `CreateUserSchema` required fields. */
export function validateUserInput(input: CreateUserInput): FieldErrors {
  const errors: FieldErrors = {};
  if (input.email.trim() === "") {
    errors.email = "email is required";
  }
  if (input.password === "") {
    errors.password = "password is required";
  }
  if (input.displayName.trim() === "") {
    errors.displayName = "display_name is required";
  }
  return errors;
}

/** A display name to patch a user: required, mirrors `PatchUserSchema`. */
export function validateDisplayName(displayName: string): FieldErrors {
  return displayName.trim() === "" ? { displayName: "display_name is required" } : {};
}
