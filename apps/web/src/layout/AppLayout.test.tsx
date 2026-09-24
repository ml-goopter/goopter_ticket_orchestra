// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ApiClient, User } from "../api/client.js";
import { SessionProvider } from "../auth/SessionProvider.js";
import { AppLayout } from "./AppLayout.js";

afterEach(cleanup);

function makeClient(user: User): ApiClient {
  return {
    request: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn().mockResolvedValue(user),
    health: vi.fn(),
  };
}

describe("AppLayout", () => {
  it("renders the attention drawer toggle with a zero count badge", async () => {
    const user: User = { id: "1", email: "a@b.com", displayName: "A" };

    render(
      <MemoryRouter initialEntries={["/"]}>
        <SessionProvider client={makeClient(user)}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<div>content</div>} />
            </Route>
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );

    const toggle = await screen.findByRole("button", { name: /attention/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("attention-count").textContent).toBe("0");
  });
});
