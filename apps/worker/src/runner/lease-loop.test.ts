import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithRenewal } from "./lease-loop.js";

/**
 * design.md §6.4, GOT.78. Only the interval is faked, so the test fires
 * renewals itself and never sleeps. Every renewal waits until the test
 * releases it.
 */

const INTERVAL_MS = 1000;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** A renew whose calls are each held until `release(call)`. */
function heldRenew(onSettled: (call: number) => void = () => {}) {
  const gates: Deferred[] = [];
  const renew = async (): Promise<void> => {
    const call = gates.length;
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    onSettled(call);
  };
  return {
    renew,
    calls: () => gates.length,
    release: (call: number) => gates[call]!.resolve(),
  };
}

/** One real macrotask turn: every promise continuation already queued has run. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Tracks whether a promise has settled, without awaiting it. */
function watch(p: Promise<unknown>): { settled: () => boolean; done: Promise<unknown> } {
  let settled = false;
  const done = p.then(
    (v) => {
      settled = true;
      return v;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    },
  );
  done.catch(() => {});
  return { settled: () => settled, done };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runWithRenewal (design.md §6.4, GOT.78)", () => {
  it("does not return while a renewal the interval started is in flight when the body ends", async () => {
    const order: string[] = [];
    const r = heldRenew(() => order.push("renewal settled"));
    const bodyGate = deferred();
    const wrapped = watch(
      runWithRenewal(r.renew, { intervalMs: INTERVAL_MS, renewNow: false, shouldRun: () => true }, async () => {
        await bodyGate.promise;
        order.push("body done");
      }).then(() => order.push("wrapper returned")),
    );

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(r.calls()).toBe(1);
    bodyGate.resolve();
    await turn();

    expect(order).toEqual(["body done"]);
    expect(wrapped.settled()).toBe(false);

    r.release(0);
    await wrapped.done;
    expect(order).toEqual(["body done", "renewal settled", "wrapper returned"]);

    // The interval is stopped: nothing renews after the wrapper returned.
    vi.advanceTimersByTime(INTERVAL_MS * 5);
    expect(r.calls()).toBe(1);
  });

  it("awaits every renewal in flight, not only the latest", async () => {
    const r = heldRenew();
    const bodyGate = deferred();
    const wrapped = watch(
      runWithRenewal(r.renew, { intervalMs: INTERVAL_MS, renewNow: false, shouldRun: () => true }, () => bodyGate.promise),
    );

    vi.advanceTimersByTime(INTERVAL_MS);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(r.calls()).toBe(2);
    bodyGate.resolve();
    r.release(1);
    await turn();
    expect(wrapped.settled()).toBe(false);

    r.release(0);
    await wrapped.done;
  });

  it("rethrows the body's error only after a renewal in flight has settled", async () => {
    const order: string[] = [];
    const r = heldRenew(() => order.push("renewal settled"));
    const bodyGate = deferred();
    const wrapped = watch(
      runWithRenewal(r.renew, { intervalMs: INTERVAL_MS, renewNow: false, shouldRun: () => true }, async () => {
        await bodyGate.promise;
        throw new Error("body failed");
      }).catch((err: unknown) => order.push(`wrapper threw: ${(err as Error).message}`)),
    );

    vi.advanceTimersByTime(INTERVAL_MS);
    bodyGate.resolve();
    await turn();
    expect(order).toEqual([]);
    expect(wrapped.settled()).toBe(false);

    r.release(0);
    await wrapped.done;
    expect(order).toEqual(["renewal settled", "wrapper threw: body failed"]);
    vi.advanceTimersByTime(INTERVAL_MS * 5);
    expect(r.calls()).toBe(1);
  });

  it("when the first renewal stops the run, skips the body and still awaits an interval renewal in flight", async () => {
    let stopped = false;
    const r = heldRenew((call) => {
      if (call === 0) stopped = true;
    });
    let bodyRan = false;
    const wrapped = watch(
      runWithRenewal(
        r.renew,
        { intervalMs: INTERVAL_MS, renewNow: true, shouldRun: () => !stopped },
        async () => {
          bodyRan = true;
        },
      ),
    );

    // The first renewal is slow enough that the interval fires during it.
    expect(r.calls()).toBe(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(r.calls()).toBe(2);
    r.release(0);
    await turn();
    expect(stopped).toBe(true);
    expect(wrapped.settled()).toBe(false);

    r.release(1);
    await wrapped.done;
    expect(bodyRan).toBe(false);
    vi.advanceTimersByTime(INTERVAL_MS * 5);
    expect(r.calls()).toBe(2);
  });

  it("when an interval renewal stops the run, the body's exit still awaits another renewal in flight", async () => {
    const stop = deferred();
    const r = heldRenew((call) => {
      if (call === 0) stop.resolve();
    });
    // The body ends when a renewal stops the run, as the runner's abort does.
    const wrapped = watch(
      runWithRenewal(r.renew, { intervalMs: INTERVAL_MS, renewNow: false, shouldRun: () => true }, () => stop.promise),
    );

    vi.advanceTimersByTime(INTERVAL_MS);
    vi.advanceTimersByTime(INTERVAL_MS);
    r.release(0);
    await turn();
    expect(wrapped.settled()).toBe(false);

    r.release(1);
    await wrapped.done;
  });

  it("renews once before the body when renewNow is set and the run may continue", async () => {
    const calls: string[] = [];
    await runWithRenewal(
      async () => void calls.push("renew"),
      { intervalMs: INTERVAL_MS, renewNow: true, shouldRun: () => true },
      async () => void calls.push("body"),
    );
    expect(calls).toEqual(["renew", "body"]);
  });

  it("does not renew before the body without renewNow", async () => {
    const calls: string[] = [];
    await runWithRenewal(
      async () => void calls.push("renew"),
      { intervalMs: INTERVAL_MS, renewNow: false, shouldRun: () => true },
      async () => void calls.push("body"),
    );
    expect(calls).toEqual(["body"]);
  });
});
