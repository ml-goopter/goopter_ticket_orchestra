// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "./datetime.js";
import { Time } from "./Time.js";

describe("Time", () => {
  it("carries the ISO string in dateTime, the local time in title, and a relative label as text", () => {
    const now = new Date("2026-01-05T12:00:00.000Z");
    render(<Time value="2026-01-05T11:55:00.000Z" now={now} />);

    const el = screen.getByText("5 min ago");
    expect(el.tagName).toBe("TIME");
    expect(el.getAttribute("dateTime")).toBe("2026-01-05T11:55:00.000Z");
    expect(el.getAttribute("title")).toBe(formatDateTime("2026-01-05T11:55:00.000Z"));
  });
});
