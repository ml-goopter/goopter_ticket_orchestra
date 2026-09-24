// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../api/client.js";
import type { ApiClient, User } from "../api/client.js";
import { SessionProvider, useSession } from "./SessionProvider.js";

afterEach(cleanup);

function makeClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    request: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    health: vi.fn(),
    ...overrides,
  };
}

function StatusProbe() {
  const { status, user } = useSession();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? ""}</span>
    </div>
  );
}

describe("SessionProvider", () => {
  it("bootstraps to authenticated when me() succeeds", async () => {
    const user: User = { id: "1", email: "a@b.com", displayName: "A" };
    const client = makeClient({ me: vi.fn().mockResolvedValue(user) });

    render(
      <SessionProvider client={client}>
        <StatusProbe />
      </SessionProvider>,
    );

    expect(screen.getByTestId("status").textContent).toBe("loading");
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated"),
    );
    expect(screen.getByTestId("user").textContent).toBe("a@b.com");
  });

  it("bootstraps to anonymous when me() rejects with 401", async () => {
    const client = makeClient({
      me: vi
        .fn()
        .mockRejectedValue(new ApiError(401, "AUTH_REQUIRED", "Authentication required.")),
    });

    render(
      <SessionProvider client={client}>
        <StatusProbe />
      </SessionProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("anonymous"),
    );
    expect(screen.getByTestId("user").textContent).toBe("");
  });

  it("flips to authenticated after a successful login()", async () => {
    const user: User = { id: "1", email: "a@b.com", displayName: "A" };
    const client = makeClient({
      me: vi
        .fn()
        .mockRejectedValue(new ApiError(401, "AUTH_REQUIRED", "Authentication required.")),
      login: vi.fn().mockResolvedValue(user),
    });

    function LoginProbe() {
      const { status, login } = useSession();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <button type="button" onClick={() => void login("a@b.com", "secret")}>
            log in
          </button>
        </div>
      );
    }

    render(
      <SessionProvider client={client}>
        <LoginProbe />
      </SessionProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("anonymous"),
    );

    screen.getByText("log in").click();

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated"),
    );
    expect(client.login).toHaveBeenCalledWith("a@b.com", "secret");
  });

  it("surfaces a failed login as an error message", async () => {
    const client = makeClient({
      me: vi
        .fn()
        .mockRejectedValue(new ApiError(401, "AUTH_REQUIRED", "Authentication required.")),
      login: vi
        .fn()
        .mockRejectedValue(new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.")),
    });

    function LoginProbe() {
      const { error, login } = useSession();
      return (
        <div>
          <span data-testid="error">{error ?? ""}</span>
          <button type="button" onClick={() => void login("a@b.com", "wrong")}>
            log in
          </button>
        </div>
      );
    }

    render(
      <SessionProvider client={client}>
        <LoginProbe />
      </SessionProvider>,
    );

    screen.getByText("log in").click();

    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe("Invalid email or password."),
    );
  });
});
