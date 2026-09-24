// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { ApiError } from "./api/client.js";
import type { ApiClient, User } from "./api/client.js";
import { SessionProvider } from "./auth/SessionProvider.js";
import { AppRouter } from "./router.js";

afterEach(cleanup);

const authedUser: User = { id: "1", email: "a@b.com", displayName: "A" };
const unauthorized = new ApiError(401, "AUTH_REQUIRED", "Authentication required.");

function makeClient(me: () => Promise<User>): ApiClient {
  return {
    request: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me,
    health: vi.fn(),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(path: string, me: () => Promise<User>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider client={makeClient(me)}>
        <LocationProbe />
        <AppRouter />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("AppRouter", () => {
  it("redirects an anonymous visit to a protected route to /login?next=<path>", async () => {
    renderAt("/tasks/abc", () => Promise.reject(unauthorized));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/login?next=%2Ftasks%2Fabc"),
    );
    expect(screen.getByRole("heading", { name: "Log in" })).toBeTruthy();
  });

  it("redirects an authenticated visit to /login to /", async () => {
    renderAt("/login", () => Promise.resolve(authedUser));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/"));
    expect(screen.getByRole("heading", { name: "Board" })).toBeTruthy();
  });

  it("renders the login heading for an anonymous visit to /login", async () => {
    renderAt("/login", () => Promise.reject(unauthorized));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Log in" })).toBeTruthy());
  });

  const placeholders: Array<[string, string]> = [
    ["/", "Board"],
    ["/tasks/abc", "Task detail"],
    ["/tasks/abc/spec", "Spec builder"],
    ["/issues/xyz", "Issue detail"],
    ["/admin", "Admin"],
    ["/costs", "Costs"],
  ];

  it.each(placeholders)(
    "renders the %s route's placeholder heading %s when authenticated",
    async (path, heading) => {
      renderAt(path, () => Promise.resolve(authedUser));

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: heading })).toBeTruthy(),
      );
    },
  );
});
