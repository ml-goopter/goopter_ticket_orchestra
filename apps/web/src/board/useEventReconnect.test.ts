// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventStreamStatus } from "../sse/useEventStream.js";
import { useRefetchOnReconnect } from "./useEventReconnect.js";

describe("useRefetchOnReconnect", () => {
  it("does not refetch on the initial open", () => {
    const refetch = vi.fn();
    const { rerender } = renderHook(
      ({ status }: { status: EventStreamStatus }) => useRefetchOnReconnect(status, refetch),
      { initialProps: { status: "closed" as EventStreamStatus } },
    );

    rerender({ status: "connecting" });
    rerender({ status: "open" });

    expect(refetch).not.toHaveBeenCalled();
  });

  it("refetches when the connection re-opens after having been open before", () => {
    const refetch = vi.fn();
    const { rerender } = renderHook(
      ({ status }: { status: EventStreamStatus }) => useRefetchOnReconnect(status, refetch),
      { initialProps: { status: "closed" as EventStreamStatus } },
    );

    rerender({ status: "open" });
    expect(refetch).not.toHaveBeenCalled();

    rerender({ status: "closed" });
    rerender({ status: "connecting" });
    rerender({ status: "open" });

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch again while status stays open", () => {
    const refetch = vi.fn();
    const { rerender } = renderHook(
      ({ status }: { status: EventStreamStatus }) => useRefetchOnReconnect(status, refetch),
      { initialProps: { status: "open" as EventStreamStatus } },
    );

    rerender({ status: "open" });
    rerender({ status: "open" });

    expect(refetch).not.toHaveBeenCalled();
  });
});
