import { describe, expect, it } from "vitest";
import { humanizeEnum } from "./humanizeEnum.js";

describe("humanizeEnum", () => {
  it("lowercases every word and capitalizes only the first", () => {
    expect(humanizeEnum("SPEC_AMBIGUITY")).toBe("Spec ambiguity");
  });

  it("handles a three-word value", () => {
    expect(humanizeEnum("READY_FOR_MERGE")).toBe("Ready for merge");
  });

  it("handles a single word", () => {
    expect(humanizeEnum("DONE")).toBe("Done");
  });

  it("handles an empty string", () => {
    expect(humanizeEnum("")).toBe("");
  });
});
