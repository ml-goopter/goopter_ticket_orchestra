// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestRequest } from "./useLatestRequest.js";

describe("useLatestRequest", () => {
  it("treats the first begin() as current until a later begin() supersedes it", () => {
    const { result } = renderHook(() => useLatestRequest());

    const first = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(true);

    const second = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(false);
    expect(result.current.isCurrent(second)).toBe(true);
  });

  it("treats every generation as stale after unmount", () => {
    const { result, unmount } = renderHook(() => useLatestRequest());

    const gen = result.current.begin();
    expect(result.current.isCurrent(gen)).toBe(true);

    unmount();

    expect(result.current.isCurrent(gen)).toBe(false);
  });
});
