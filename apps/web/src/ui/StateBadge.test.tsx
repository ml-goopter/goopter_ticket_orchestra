// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StateBadge, stateColor } from "./StateBadge.js";

describe("stateColor", () => {
  it("maps NEEDS_HUMAN and WAITING_FOR_USER to attention", () => {
    expect(stateColor("NEEDS_HUMAN")).toBe("attention");
    expect(stateColor("WAITING_FOR_USER")).toBe("attention");
  });

  it("maps in-progress states to progress", () => {
    for (const state of ["SPEC_IN_PROGRESS", "IMPLEMENTING", "REVIEWING", "CI_RUNNING"]) {
      expect(stateColor(state)).toBe("progress");
    }
  });

  it("maps READY_FOR_MERGE and DONE to success", () => {
    expect(stateColor("READY_FOR_MERGE")).toBe("success");
    expect(stateColor("DONE")).toBe("success");
  });

  it("maps FAILED to danger", () => {
    expect(stateColor("FAILED")).toBe("danger");
  });

  it("maps CANCELLED and an unknown state to neutral", () => {
    expect(stateColor("CANCELLED")).toBe("neutral");
    expect(stateColor("SOMETHING_UNKNOWN")).toBe("neutral");
  });
});

describe("StateBadge", () => {
  it("renders a readable label with the status-coloured badge class", () => {
    render(<StateBadge state="READY_FOR_MERGE" />);
    const badge = screen.getByText("Ready for merge");
    expect(badge.className).toBe("badge badge--success");
  });

  it("accepts a label override", () => {
    render(<StateBadge state="NEEDS_HUMAN" label="Needs you" />);
    expect(screen.getByText("Needs you").className).toBe("badge badge--attention");
  });
});
