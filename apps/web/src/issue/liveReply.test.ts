import { describe, expect, it } from "vitest";
import { createDeltaAccumulator } from "../sse/deltas.js";
import { reduceAgentReply } from "./liveReply.js";

describe("reduceAgentReply", () => {
  it("concatenates deltas for the same execution into one in-progress bubble", () => {
    const accumulator = createDeltaAccumulator();

    const first = reduceAgentReply(accumulator, "exec-1", { type: "agent.message.delta", text: "Hello" });
    expect(first).toEqual({ text: "Hello", final: false });

    const second = reduceAgentReply(accumulator, "exec-1", { type: "agent.message.delta", text: " world" });
    expect(second).toEqual({ text: "Hello world", final: false });
  });

  it("replaces the in-progress bubble with the final agent.message text and clears the buffer", () => {
    const accumulator = createDeltaAccumulator();
    reduceAgentReply(accumulator, "exec-1", { type: "agent.message.delta", text: "Hello" });

    const final = reduceAgentReply(accumulator, "exec-1", { type: "agent.message", text: "Hello world." });
    expect(final).toEqual({ text: "Hello world.", final: true });
    expect(accumulator.get("exec-1")).toBe("");
  });

  it("keeps separate buffers per execution", () => {
    const accumulator = createDeltaAccumulator();
    reduceAgentReply(accumulator, "exec-1", { type: "agent.message.delta", text: "A" });
    const other = reduceAgentReply(accumulator, "exec-2", { type: "agent.message.delta", text: "B" });
    expect(other).toEqual({ text: "B", final: false });
    expect(accumulator.get("exec-1")).toBe("A");
  });
});
