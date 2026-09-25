// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useEventStream,
  type EventSourceLike,
  type MessageEventLike,
  type StreamEvent,
} from "./useEventStream.js";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];

  closed = false;
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEventLike) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEventLike) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown, id?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId: id });
    }
  }
}

function factory(url: string): EventSourceLike {
  return new FakeEventSource(url);
}

function currentSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no FakeEventSource created yet");
  return source;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useEventStream", () => {
  it("reconnects after an error with ?after=<lastEventId>", () => {
    const { result } = renderHook(() =>
      useEventStream("/api/tasks/1/stream", { createEventSource: factory }),
    );

    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe("/api/tasks/1/stream");

    act(() => {
      first.emit("task.state_changed", { foo: "bar" }, "42");
    });
    expect(result.current.lastEventId).toBe("42");

    act(() => {
      first.onerror?.(new Event("error"));
    });
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toBe("/api/tasks/1/stream?after=42");
  });

  it("doubles the backoff delay on repeated errors", () => {
    renderHook(() => useEventStream("/api/tasks/1/stream", { createEventSource: factory }));

    act(() => currentSource().onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => currentSource().onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(1999));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(3);

    act(() => currentSource().onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(3999));
    expect(FakeEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("resets the backoff after a successful open", () => {
    renderHook(() => useEventStream("/api/tasks/1/stream", { createEventSource: factory }));

    // Two errors without a successful open in between: attempt is now 2, so
    // the next delay would be 4000ms if it were not reset.
    act(() => currentSource().onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(1000));
    act(() => currentSource().onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(2000));
    expect(FakeEventSource.instances).toHaveLength(3);

    // A successful open resets the attempt counter to 0.
    act(() => currentSource().onopen?.());
    act(() => currentSource().onerror?.(new Event("error")));

    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("updates lastEventId as events arrive", () => {
    const { result } = renderHook(() =>
      useEventStream("/api/tasks/1/stream", { createEventSource: factory }),
    );

    expect(result.current.lastEventId).toBeNull();
    act(() => currentSource().emit("agent.message", { text: "hi" }, "7"));
    expect(result.current.lastEventId).toBe("7");
    act(() => currentSource().emit("agent.message", { text: "again" }, "8"));
    expect(result.current.lastEventId).toBe("8");
  });

  it("does not send ?after= on the first connect", () => {
    renderHook(() => useEventStream("/api/tasks/1/stream", { createEventSource: factory }));

    expect(FakeEventSource.instances[0]!.url).toBe("/api/tasks/1/stream");
  });

  it("subscribes to a caller-supplied types list, e.g. dashboard notification events", () => {
    const onEvent = vi.fn();
    renderHook(() =>
      useEventStream("/api/stream", {
        createEventSource: factory,
        onEvent,
        types: ["task.state_changed", "issue.created", "issue.resolved", "notification"],
      }),
    );

    act(() => currentSource().emit("notification", { kind: "needs_human" }, "9"));

    expect(onEvent).toHaveBeenCalledWith({
      type: "notification",
      data: { kind: "needs_human" },
      id: "9",
    });
  });

  it("narrows StreamEvent.type to the configured §12.6 types without a cast (F1)", () => {
    const dashboardTypes = [
      "task.state_changed",
      "issue.created",
      "issue.resolved",
      "notification",
    ] as const;

    const seen: string[] = [];
    // Compile-checked: `event.type` is the literal union of `dashboardTypes`,
    // so narrowing to "notification" needs no cast. This fails tsc with
    // TS2367 ("no overlap") before the hook is made generic over `types`.
    const onEvent = (event: StreamEvent<(typeof dashboardTypes)[number]>) => {
      if (event.type === "notification") {
        seen.push(event.type);
      }
    };

    renderHook(() =>
      useEventStream<(typeof dashboardTypes)[number]>("/api/stream", {
        createEventSource: factory,
        onEvent,
        types: dashboardTypes,
      }),
    );

    act(() => currentSource().emit("notification", { kind: "needs_human" }, "9"));

    expect(seen).toEqual(["notification"]);
  });

  it("does not reconnect when a caller passes a new array with the same types", () => {
    const { rerender } = renderHook(
      ({ types }: { types: readonly string[] }) =>
        useEventStream("/api/tasks/1/stream", { createEventSource: factory, types }),
      { initialProps: { types: ["task.state_changed", "notification"] } },
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = currentSource();

    rerender({ types: ["task.state_changed", "notification"] });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.closed).toBe(false);
  });

  it("reconnects exactly once when the set of types actually changes", () => {
    const { rerender } = renderHook(
      ({ types }: { types: readonly string[] }) =>
        useEventStream("/api/tasks/1/stream", { createEventSource: factory, types }),
      { initialProps: { types: ["task.state_changed", "notification"] } },
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = currentSource();

    rerender({ types: ["task.state_changed", "issue.created"] });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("reconnects when the type set changes in a way a joined, sorted key would miss (F4)", () => {
    // ["a,b"] and ["a", "b"] both sort+join to "a,b", so a `typesKey` built
    // from `.join(",")` sees no change here even though the set differs.
    const { rerender } = renderHook(
      ({ types }: { types: readonly string[] }) =>
        useEventStream("/api/tasks/1/stream", { createEventSource: factory, types }),
      { initialProps: { types: ["a,b"] } },
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = currentSource();

    rerender({ types: ["a", "b"] });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("does not reconnect when a caller passes a new array with duplicate entries (F4)", () => {
    const { rerender } = renderHook(
      ({ types }: { types: readonly string[] }) =>
        useEventStream("/api/tasks/1/stream", { createEventSource: factory, types }),
      { initialProps: { types: ["task.state_changed", "notification"] } },
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = currentSource();

    rerender({ types: ["task.state_changed", "notification", "notification"] });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.closed).toBe(false);
  });

  it("closes the source and stops reconnecting when disabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useEventStream("/api/tasks/1/stream", { createEventSource: factory, enabled }),
      { initialProps: { enabled: true } },
    );

    const first = currentSource();
    rerender({ enabled: false });
    expect(first.closed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(result.current.status).toBe("closed");
  });
});
