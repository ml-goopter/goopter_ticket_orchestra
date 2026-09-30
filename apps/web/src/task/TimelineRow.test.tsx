// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { TimelineRow } from "./TimelineRow.js";
import type { TimelineItem } from "./timelineItems.js";

afterEach(cleanup);

function makeItem(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    key: "k1",
    type: "agent.tool_call",
    eventId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    executionId: null,
    kind: "tool_call",
    ...overrides,
  };
}

function renderRow(item: TimelineItem) {
  return render(
    <MemoryRouter>
      <ul>
        <TimelineRow item={item} taskId="task-1" />
      </ul>
    </MemoryRouter>,
  );
}

function getPre() {
  return screen.getByTestId("timeline-item").querySelector("pre");
}

describe("TimelineRow JSON preview (GOT.65)", () => {
  describe("tool_call toolInput", () => {
    it("renders a small tool input exactly as JSON.stringify would, with no truncation notice", () => {
      const toolInput = { path: "src/index.ts", limit: 100 };
      renderRow(makeItem({ kind: "tool_call", toolName: "read_file", toolInput }));

      expect(getPre()?.textContent).toBe(JSON.stringify(toolInput, null, 2));
      expect(screen.queryByTestId("json-truncated-notice")).toBeNull();
    });

    it("truncates a large tool input and shows a notice naming the omitted character count", () => {
      const toolInput = { blob: "x".repeat(10_000) };
      const full = JSON.stringify(toolInput, null, 2);
      renderRow(makeItem({ kind: "tool_call", toolName: "read_file", toolInput }));

      const shown = getPre()?.textContent ?? "";
      expect(shown.length).toBe(4000);
      expect(full.startsWith(shown)).toBe(true);

      const notice = screen.getByTestId("json-truncated-notice");
      const omitted = full.length - shown.length;
      expect(notice.textContent).toContain(omitted.toLocaleString("en-US"));
      expect(notice.textContent?.toLowerCase()).toContain("truncated");
    });

    it("never splits a surrogate pair when an emoji straddles the preview limit", () => {
      // Position the blob so the emoji's high surrogate lands exactly at the
      // preview cut (index 3999 of the stringified JSON, 0-indexed) and its
      // low surrogate falls just past it, at index 4000.
      const prefix = JSON.stringify({ blob: "" }, null, 2);
      const blobStart = prefix.indexOf('""') + 1;
      const padLength = 4000 - blobStart - 1;
      const toolInput = { blob: "x".repeat(padLength) + "\u{1F600}" + "y".repeat(50) };
      const full = JSON.stringify(toolInput, null, 2);
      expect(full.charCodeAt(3999)).toBeGreaterThanOrEqual(0xd800);
      expect(full.charCodeAt(3999)).toBeLessThanOrEqual(0xdbff);
      expect(full.charCodeAt(4000)).toBeGreaterThanOrEqual(0xdc00);

      renderRow(makeItem({ kind: "tool_call", toolName: "read_file", toolInput }));

      const shown = getPre()?.textContent ?? "";
      const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      expect(loneSurrogate.test(shown)).toBe(false);
      expect(full.startsWith(shown)).toBe(true);

      const notice = screen.getByTestId("json-truncated-notice");
      const omitted = full.length - shown.length;
      expect(notice.textContent).toContain(omitted.toLocaleString("en-US"));
    });
  });

  describe("generic (unknown event) payload", () => {
    it("renders a small unknown payload exactly as JSON.stringify would, with no truncation notice", () => {
      const payload = { foo: "bar", count: 3 };
      renderRow(makeItem({ kind: "generic", type: "some.unknown.event", payload }));

      expect(getPre()?.textContent).toBe(JSON.stringify(payload, null, 2));
      expect(screen.queryByTestId("json-truncated-notice")).toBeNull();
    });

    it("truncates a large unknown payload and shows a notice naming the omitted character count", () => {
      const payload = { blob: "y".repeat(10_000) };
      const full = JSON.stringify(payload, null, 2);
      renderRow(makeItem({ kind: "generic", type: "some.unknown.event", payload }));

      const shown = getPre()?.textContent ?? "";
      expect(shown.length).toBe(4000);
      expect(full.startsWith(shown)).toBe(true);

      const notice = screen.getByTestId("json-truncated-notice");
      const omitted = full.length - shown.length;
      expect(notice.textContent).toContain(omitted.toLocaleString("en-US"));
      expect(notice.textContent?.toLowerCase()).toContain("truncated");
    });
  });
});

describe("TimelineRow row tints (UR3 AC5)", () => {
  it("gives a failed tool call a danger tint", () => {
    renderRow(
      makeItem({ kind: "tool_call", toolName: "run_tests", toolInput: {}, toolOk: false, toolError: "boom" }),
    );

    expect(screen.getByTestId("timeline-item").className).toContain("timeline-item--danger");
  });

  it("does not tint a successful tool call", () => {
    renderRow(makeItem({ kind: "tool_call", toolName: "run_tests", toolInput: {}, toolOk: true }));

    expect(screen.getByTestId("timeline-item").className).not.toContain("timeline-item--danger");
  });

  it("gives an issue row an attention tint", () => {
    renderRow(makeItem({ kind: "issue", type: "issue.created", issueTitle: "Which pagination style?" }));

    expect(screen.getByTestId("timeline-item").className).toContain("timeline-item--attention");
  });

  it("does not tint a row that is neither a failed tool call nor an issue", () => {
    renderRow(makeItem({ kind: "state_changed", type: "task.state_changed", from: "READY", to: "IMPLEMENTING" }));

    const className = screen.getByTestId("timeline-item").className;
    expect(className).not.toContain("timeline-item--danger");
    expect(className).not.toContain("timeline-item--attention");
  });
});
