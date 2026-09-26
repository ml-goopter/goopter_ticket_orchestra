// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostsView } from "./CostsView.js";

afterEach(cleanup);

function projectRows() {
  return [
    {
      key: { id: "p1", label: "CST1 project" },
      cost_usd: 1.75,
      input_tokens: 190,
      cached_input_tokens: 15,
      output_tokens: 80,
      unpriced_rows: 0,
      by_kind: {
        main: { cost_usd: 1, input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, unpriced_rows: 0 },
        review: { cost_usd: 0.5, input_tokens: 60, cached_input_tokens: 5, output_tokens: 20, unpriced_rows: 0 },
        resume: { cost_usd: 0.25, input_tokens: 30, cached_input_tokens: 0, output_tokens: 10, unpriced_rows: 0 },
      },
    },
  ];
}

describe("CostsView", () => {
  it("shows a loading state before the first fetch resolves", () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    render(<CostsView request={request} />);

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("fetches group=project by default and renders a row with its by-kind breakdown", async () => {
    const request = vi.fn().mockResolvedValue(projectRows());
    render(<CostsView request={request} />);

    await waitFor(() => expect(screen.getByText("CST1 project")).toBeTruthy());
    expect(request).toHaveBeenCalledWith("GET", "/costs?group=project");

    const row = screen.getByText("CST1 project").closest("tr")!;
    expect(within(row).getByText("$1.75")).toBeTruthy();
    expect(within(row).getByText("190")).toBeTruthy();
  });

  it("shows an empty state when there are no rows", async () => {
    const request = vi.fn().mockResolvedValue([]);
    render(<CostsView request={request} />);

    await waitFor(() => expect(screen.getByText("No costs recorded yet.")).toBeTruthy());
  });

  it("shows a visible error state when the fetch fails", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network down"));
    render(<CostsView request={request} />);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network down"));
  });

  it("refetches with the new group when the selector changes", async () => {
    const request = vi.fn().mockResolvedValue([]);
    render(<CostsView request={request} />);

    await waitFor(() => expect(request).toHaveBeenCalledWith("GET", "/costs?group=project"));

    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "runtime" } });

    await waitFor(() => expect(request).toHaveBeenCalledWith("GET", "/costs?group=runtime"));
  });

  it("includes from/to in the query once both date inputs are set", async () => {
    const request = vi.fn().mockResolvedValue([]);
    render(<CostsView request={request} />);

    await waitFor(() => expect(request).toHaveBeenCalledWith("GET", "/costs?group=project"));

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-03-01" } });

    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        "GET",
        expect.stringContaining("group=project&from=2026-02-01") as unknown as string,
      ),
    );
  });

  it("shows an estimated badge on the claude row when grouped by runtime", async () => {
    const request = vi.fn().mockResolvedValue([
      {
        key: { id: "claude", label: "claude" },
        cost_usd: 1.75,
        input_tokens: 190,
        cached_input_tokens: 15,
        output_tokens: 80,
        unpriced_rows: 0,
        by_kind: {
          main: { cost_usd: 1, input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, unpriced_rows: 0 },
          review: { cost_usd: 0.5, input_tokens: 60, cached_input_tokens: 5, output_tokens: 20, unpriced_rows: 0 },
          resume: { cost_usd: 0.25, input_tokens: 30, cached_input_tokens: 0, output_tokens: 10, unpriced_rows: 0 },
        },
      },
      {
        key: { id: "codex", label: "codex" },
        cost_usd: 2,
        input_tokens: 280,
        cached_input_tokens: 0,
        output_tokens: 140,
        unpriced_rows: 1,
        by_kind: {
          main: { cost_usd: 0, input_tokens: 200, cached_input_tokens: 0, output_tokens: 100, unpriced_rows: 1 },
          review: { cost_usd: 2, input_tokens: 80, cached_input_tokens: 0, output_tokens: 40, unpriced_rows: 0 },
          resume: { cost_usd: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, unpriced_rows: 0 },
        },
      },
    ]);
    render(<CostsView request={request} />);

    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "runtime" } });

    await waitFor(() => expect(screen.getByText("claude")).toBeTruthy());
    const claudeRow = screen.getByText("claude").closest("tr")!;
    const codexRow = screen.getByText("codex").closest("tr")!;
    expect(within(claudeRow).getByText("(estimated)")).toBeTruthy();
    expect(within(codexRow).queryByText("(estimated)")).toBeNull();
  });
});
