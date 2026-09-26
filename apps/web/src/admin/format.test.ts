import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { DEAD_HOST_THRESHOLD_SECONDS, describeApiError, formatHeartbeatAge, isStaleHeartbeat } from "./format.js";

describe("formatHeartbeatAge", () => {
  it("formats under a minute as seconds", () => {
    expect(formatHeartbeatAge(45)).toBe("45s ago");
    expect(formatHeartbeatAge(0)).toBe("0s ago");
  });

  it("formats a minute or more as minutes, floored", () => {
    expect(formatHeartbeatAge(60)).toBe("1m ago");
    expect(formatHeartbeatAge(90)).toBe("1m ago");
    expect(formatHeartbeatAge(179)).toBe("2m ago");
  });
});

describe("isStaleHeartbeat", () => {
  it("is false at and under the 15 minute dead-host threshold", () => {
    expect(isStaleHeartbeat(DEAD_HOST_THRESHOLD_SECONDS)).toBe(false);
    expect(isStaleHeartbeat(60)).toBe(false);
  });

  it("is true once the age exceeds 15 minutes", () => {
    expect(isStaleHeartbeat(DEAD_HOST_THRESHOLD_SECONDS + 1)).toBe(true);
    expect(isStaleHeartbeat(20 * 60)).toBe(true);
  });
});

describe("describeApiError", () => {
  it("renders code: message for an ApiError", () => {
    const err = new ApiError(409, "CONFLICT", "A project with key GOOP already exists.");
    expect(describeApiError(err, "fallback")).toBe("CONFLICT: A project with key GOOP already exists.");
  });

  it("falls back to the Error message for a non-api error", () => {
    expect(describeApiError(new Error("network down"), "fallback")).toBe("network down");
  });

  it("uses the fallback for a non-Error rejection", () => {
    expect(describeApiError("nope", "fallback")).toBe("fallback");
  });
});
