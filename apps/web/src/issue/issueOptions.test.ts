import { describe, expect, it } from "vitest";
import { parseSuggestedOptions } from "./issueOptions.js";

describe("parseSuggestedOptions", () => {
  it("returns [] for null", () => {
    expect(parseSuggestedOptions(null)).toEqual([]);
  });

  it("returns [] for malformed content instead of throwing", () => {
    expect(parseSuggestedOptions({ not: "an array" })).toEqual([]);
    expect(parseSuggestedOptions([{ id: "a" }])).toEqual([]);
  });

  it("parses a well-formed option list", () => {
    const options = [
      { id: "local", description: "Store on the device.", tradeoff: "Does not sync." },
      { id: "server", description: "Persist server-side.", tradeoff: "Needs a backend." },
    ];
    expect(parseSuggestedOptions(options)).toEqual(options);
  });
});
