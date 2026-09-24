import { describe, expect, it } from "vitest";
import { createDeltaAccumulator } from "./deltas.js";

describe("createDeltaAccumulator", () => {
  it("concatenates deltas for one execution in order", () => {
    const acc = createDeltaAccumulator();
    acc.append("exec-1", "Hel");
    acc.append("exec-1", "lo, ");
    const result = acc.append("exec-1", "world");

    expect(result).toBe("Hello, world");
    expect(acc.get("exec-1")).toBe("Hello, world");
  });

  it("keeps deltas for a different execution separate", () => {
    const acc = createDeltaAccumulator();
    acc.append("exec-1", "a");
    acc.append("exec-2", "b");
    acc.append("exec-1", "c");

    expect(acc.get("exec-1")).toBe("ac");
    expect(acc.get("exec-2")).toBe("b");
  });

  it("flushes and resets the buffer on agent.message", () => {
    const acc = createDeltaAccumulator();
    acc.append("exec-1", "partial");

    const flushed = acc.flush("exec-1");

    expect(flushed).toBe("partial");
    expect(acc.get("exec-1")).toBe("");

    acc.append("exec-1", "next");
    expect(acc.get("exec-1")).toBe("next");
  });

  it("flushing an execution with no buffer returns an empty string", () => {
    const acc = createDeltaAccumulator();
    expect(acc.flush("unknown")).toBe("");
  });
});
