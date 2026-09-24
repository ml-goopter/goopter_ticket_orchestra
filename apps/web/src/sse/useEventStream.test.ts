// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEventStream, type EventSourceLike, type MessageEventLike } from "./useEventStream.js";

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
    expect(first.url).toBe("/api/tasks/1/stream?after=");

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
