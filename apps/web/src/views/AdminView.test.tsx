// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { AdminView } from "./AdminView.js";

afterEach(cleanup);

/**
 * A minimal `request` fake that answers every admin route with an empty
 * list, so each panel reaches its empty state without a schema mismatch.
 */
function emptyRequest(): ApiClient["request"] {
  return vi.fn(async (_method: string, path: string) => {
    if (path.startsWith("/projects")) return [];
    if (path.startsWith("/repositories")) return [];
    if (path.startsWith("/users")) return [];
    if (path.startsWith("/workers")) return [];
    throw new Error(`unexpected path: ${path}`);
  }) as unknown as ApiClient["request"];
}

describe("AdminView", () => {
  it("defaults to the Projects tab", async () => {
    const request = emptyRequest();
    render(<AdminView request={request} />);

    expect(screen.getByRole("heading", { name: "Admin" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-current")).toBe("page");
  });

  it("switches to the Repositories panel and fetches its data", async () => {
    const request = emptyRequest();
    render(<AdminView request={request} />);

    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Repositories" })).toBeTruthy());
    expect(request).toHaveBeenCalledWith("GET", "/repositories");
  });

  it("switches to the Users panel and fetches its data", async () => {
    const request = emptyRequest();
    render(<AdminView request={request} />);

    fireEvent.click(screen.getByRole("button", { name: "Users" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Users" })).toBeTruthy());
    expect(request).toHaveBeenCalledWith("GET", "/users");
  });

  it("switches to the Workers panel and fetches its data", async () => {
    const request = emptyRequest();
    render(<AdminView request={request} />);

    fireEvent.click(screen.getByRole("button", { name: "Workers" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Workers" })).toBeTruthy());
    expect(request).toHaveBeenCalledWith("GET", "/workers");
  });

  it("unmounts the previous panel when switching tabs (no stale Projects heading)", async () => {
    const request = emptyRequest();
    render(<AdminView request={request} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Workers" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull());
  });
});
