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

const ZERO_KIND = { cost_usd: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, unpriced_rows: 0 };

function twoProjectRows() {
  return [
    {
      key: { id: "p1", label: "Project A" },
      cost_usd: 1,
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 0,
      unpriced_rows: 0,
      by_kind: { main: ZERO_KIND, review: ZERO_KIND, resume: ZERO_KIND },
    },
    {
      key: { id: "p2", label: "Project B" },
      cost_usd: 2,
      input_tokens: 200,
      cached_input_tokens: 0,
      output_tokens: 0,
      unpriced_rows: 0,
      by_kind: { main: ZERO_KIND, review: ZERO_KIND, resume: ZERO_KIND },
    },
  ];
}

describe("CostsView", () => {
  it("shows a loading state before the first fetch resolves", () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    render(<CostsView request={request} />);

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("shows the page topbar with the Costs title", async () => {
    const request = vi.fn().mockResolvedValue([]);
    render(<CostsView request={request} />);

    expect(screen.getByRole("heading", { name: "Costs" })).toBeTruthy();
    await waitFor(() => expect(request).toHaveBeenCalled());
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

  it("formats a large token count with thousands separators", async () => {
    const request = vi.fn().mockResolvedValue([
      {
        key: { id: "p1", label: "Big project" },
        cost_usd: 12.5,
        input_tokens: 788403,
        cached_input_tokens: 0,
        output_tokens: 0,
        unpriced_rows: 0,
        by_kind: { main: ZERO_KIND, review: ZERO_KIND, resume: ZERO_KIND },
      },
    ]);
    render(<CostsView request={request} />);

    await waitFor(() => expect(screen.getByText("Big project")).toBeTruthy());
    const row = screen.getByText("Big project").closest("tr")!;
    expect(within(row).getByText("788,403")).toBeTruthy();
    expect(within(row).getByText("$12.50")).toBeTruthy();
  });

  it("shows no totals row for a single row", async () => {
    const request = vi.fn().mockResolvedValue(projectRows());
    render(<CostsView request={request} />);

    await waitFor(() => expect(screen.getByText("CST1 project")).toBeTruthy());
    expect(screen.queryByText("Total")).toBeNull();
  });

  it("shows a totals row summing cost and token columns when there is more than one row", async () => {
    const request = vi.fn().mockResolvedValue(twoProjectRows());
    render(<CostsView request={request} />);

    await waitFor(() => expect(screen.getByText("Project A")).toBeTruthy());
    const totalsRow = screen.getByText("Total").closest("tr")!;
    expect(within(totalsRow).getByText("$3.00")).toBeTruthy();
    expect(within(totalsRow).getByText("300")).toBeTruthy();
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

  it("refetches with the new group when the segmented control changes", async () => {
    const request = vi.fn().mockResolvedValue([]);
    render(<CostsView request={request} />);

    await waitFor(() => expect(request).toHaveBeenCalledWith("GET", "/costs?group=project"));

    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));

    await waitFor(() => expect(screen.getByText("claude")).toBeTruthy());
    const claudeRow = screen.getByText("claude").closest("tr")!;
    const codexRow = screen.getByText("codex").closest("tr")!;
    expect(within(claudeRow).getByText("(estimated)")).toBeTruthy();
    expect(within(codexRow).queryByText("(estimated)")).toBeNull();
  });

  describe("totals tiles", () => {
    it("shows four tiles with cost/token totals once a single row has loaded", async () => {
      const request = vi.fn().mockResolvedValue(projectRows());
      render(<CostsView request={request} />);

      await waitFor(() => expect(screen.getByText("CST1 project")).toBeTruthy());

      const totalTile = screen.getByText("Total cost").closest(".costs-tile") as HTMLElement;
      expect(within(totalTile).getByText("$1.75")).toBeTruthy();
      expect(within(totalTile).getByText("Main $1.00 · Review $0.50 · Resume $0.25")).toBeTruthy();

      expect(screen.getByText("Input tokens")).toBeTruthy();
      expect(screen.getByText("Cached input tokens")).toBeTruthy();
      expect(screen.getByText("Output tokens")).toBeTruthy();
    });

    it("shows a compact value with the exact count underneath for a large token total", async () => {
      const request = vi.fn().mockResolvedValue([
        {
          key: { id: "p1", label: "Big project" },
          cost_usd: 214.37,
          input_tokens: 48213904,
          cached_input_tokens: 36870112,
          output_tokens: 1904377,
          unpriced_rows: 0,
          by_kind: { main: ZERO_KIND, review: ZERO_KIND, resume: ZERO_KIND },
        },
      ]);
      render(<CostsView request={request} />);

      await waitFor(() => expect(screen.getByText("Big project")).toBeTruthy());

      const inputTile = screen.getByText("Input tokens").closest(".costs-tile") as HTMLElement;
      expect(within(inputTile).getByText("48.2M")).toBeTruthy();
      expect(within(inputTile).getByText("48,213,904")).toBeTruthy();

      const cachedTile = screen.getByText("Cached input tokens").closest(".costs-tile") as HTMLElement;
      expect(within(cachedTile).getByText("36.9M")).toBeTruthy();
      expect(within(cachedTile).getByText("36,870,112")).toBeTruthy();

      const outputTile = screen.getByText("Output tokens").closest(".costs-tile") as HTMLElement;
      expect(within(outputTile).getByText("1.9M")).toBeTruthy();
      expect(within(outputTile).getByText("1,904,377")).toBeTruthy();
    });

    it("sums tile totals across more than one row", async () => {
      const request = vi.fn().mockResolvedValue(twoProjectRows());
      render(<CostsView request={request} />);

      await waitFor(() => expect(screen.getByText("Project A")).toBeTruthy());

      const totalTile = screen.getByText("Total cost").closest(".costs-tile") as HTMLElement;
      expect(totalTile.querySelector(".costs-tile__value")?.textContent).toBe("$3.00");

      const inputTile = screen.getByText("Input tokens").closest(".costs-tile") as HTMLElement;
      expect(inputTile.querySelector(".costs-tile__value")?.textContent).toBe("300");
      expect(inputTile.querySelector(".costs-tile__sub")?.textContent).toBe("300");
    });

    it("does not show tiles while loading, on error, or when there are no rows", async () => {
      const loading = vi.fn(() => new Promise<never>(() => {}));
      const { unmount } = render(<CostsView request={loading} />);
      expect(screen.queryByText("Total cost")).toBeNull();
      unmount();

      const erroring = vi.fn().mockRejectedValue(new Error("network down"));
      render(<CostsView request={erroring} />);
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.queryByText("Total cost")).toBeNull();
      cleanup();

      const empty = vi.fn().mockResolvedValue([]);
      render(<CostsView request={empty} />);
      await waitFor(() => expect(screen.getByText("No costs recorded yet.")).toBeTruthy());
      expect(screen.queryByText("Total cost")).toBeNull();
    });
  });
});
