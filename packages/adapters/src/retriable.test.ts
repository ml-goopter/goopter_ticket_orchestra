import { describe, expect, it } from "vitest";
import { classifyRetriable } from "./retriable.js";

describe("classifyRetriable (design.md §9.5 adapter_error retriable vs terminal)", () => {
  it.each([
    ["rate limit", "API error: rate_limit exceeded for this organization"],
    ["429", "Request failed with status 429 Too Many Requests"],
    ["ECONNRESET", "read ECONNRESET"],
    ["network", "fetch failed: ENOTFOUND api.anthropic.com"],
    ["socket hang up", "socket hang up"],
    ["5xx", "API error 503 Service Unavailable"],
    ["500", "Internal server error"],
    ["overloaded", "overloaded_error: Overloaded"],
    ["529", "Request failed with status 529"],
    ["timeout", "Request timed out after 600000ms"],
  ])("classifies %s as retriable", (_label, message) => {
    expect(classifyRetriable(message)).toBe(true);
  });

  it.each([
    ["authentication", "authentication_failed: invalid x-api-key"],
    ["401", "Request failed with status 401 Unauthorized"],
    ["403 forbidden", "403 Forbidden: this key cannot access the resource"],
    ["oauth", "oauth_org_not_allowed"],
    ["invalid model", "model_not_found: the model claude-nope-1 does not exist"],
    ["unknown model", "Invalid model: claude-nope-1"],
    ["budget", "error_max_budget_usd: budget exceeded"],
    ["max turns", "error_max_turns: reached the maximum number of turns"],
    ["credit balance", "Your credit balance is too low to access the API"],
    ["quota", "billing_error: quota exceeded"],
    ["account on hold", "account_on_hold"],
  ])("classifies %s as not retriable", (_label, message) => {
    expect(classifyRetriable(message)).toBe(false);
  });

  it("treats an unclassified failure as retriable so the runner retries within its cap", () => {
    expect(classifyRetriable("something went sideways")).toBe(true);
    expect(classifyRetriable("")).toBe(true);
  });

  it("prefers the terminal classification when both signals are present", () => {
    // A 429 body that is actually a hard quota denial must not be retried.
    expect(
      classifyRetriable("429 Too Many Requests: your credit balance is too low"),
    ).toBe(false);
  });
});
