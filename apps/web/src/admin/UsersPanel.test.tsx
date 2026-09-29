// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { AdminApi, AdminUser, CurrentAdminUser } from "../api/admin.js";
import { formatDateTime } from "../ui/datetime.js";
import { UsersPanel } from "./UsersPanel.js";

afterEach(cleanup);

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "user-1",
    email: "newuser@example.com",
    displayName: "New User",
    disabledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const CURRENT_USER: CurrentAdminUser = { id: "current-admin", email: "me@example.com", displayName: "Me" };

/**
 * `getCurrentUser` defaults to a caller distinct from every row's `user-1`
 * fixture id, so most tests exercise a non-self row without asking (GOT.61).
 */
function fakeAdminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    patchProject: vi.fn(),
    deleteProject: vi.fn(),
    listRepositories: vi.fn(),
    createRepository: vi.fn(),
    patchRepository: vi.fn(),
    deleteRepository: vi.fn(),
    listUsers: vi.fn().mockResolvedValue([]),
    createUser: vi.fn(),
    patchUser: vi.fn(),
    getCurrentUser: vi.fn().mockResolvedValue(CURRENT_USER),
    listWorkers: vi.fn(),
    ...overrides,
  };
}

function within(container: HTMLElement, labelText: string): HTMLElement {
  const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.startsWith(labelText));
  if (!label) throw new Error(`no label starting with "${labelText}"`);
  const input = label.querySelector("input");
  if (!input) throw new Error(`no input inside the "${labelText}" label`);
  return input;
}

describe("UsersPanel", () => {
  it("shows loading, then an empty state", async () => {
    const adminApi = fakeAdminApi();
    render(<UsersPanel adminApi={adminApi} />);

    expect(screen.getByText("Loading...")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No users yet.")).toBeTruthy());
  });

  it("lists email, display name, created, and disabled state", async () => {
    const adminApi = fakeAdminApi({
      listUsers: vi
        .fn()
        .mockResolvedValue([
          user(),
          user({
            id: "user-2",
            email: "disabled@example.com",
            displayName: "Disabled User",
            createdAt: "2026-02-01T00:00:00.000Z",
            disabledAt: "2026-02-01T00:00:00.000Z",
          }),
        ]),
    });
    render(<UsersPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("newuser@example.com")).toBeTruthy());
    expect(screen.getByText("New User")).toBeTruthy();
    // createdAt is far enough in the past that formatRelativeTime falls back
    // to the same absolute string formatDateTime produces (ui/datetime.ts),
    // so this stays true regardless of when the suite runs.
    const created = screen.getByText(formatDateTime("2026-01-01T00:00:00.000Z"));
    expect(created.tagName).toBe("TIME");
    expect(created.getAttribute("dateTime")).toBe("2026-01-01T00:00:00.000Z");
    expect(created.getAttribute("title")).toBe(formatDateTime("2026-01-01T00:00:00.000Z"));
    expect(screen.getAllByText("Active").length).toBe(1);
    expect(screen.getAllByText("Disabled").length).toBe(1);
  });

  it("creates a user, then the list refetches", async () => {
    const listUsers = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([user()]);
    const createUser = vi.fn().mockResolvedValue(user());
    const adminApi = fakeAdminApi({ listUsers, createUser });
    render(<UsersPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("No users yet.")).toBeTruthy());

    const createForm = screen.getByRole("form", { name: "Create user" });
    fireEvent.change(within(createForm, "Email"), { target: { value: "newuser@example.com" } });
    fireEvent.change(within(createForm, "Display name"), { target: { value: "New User" } });
    fireEvent.change(within(createForm, "Password"), { target: { value: "a very long password" } });
    fireEvent.submit(createForm);

    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith({
        email: "newuser@example.com",
        displayName: "New User",
        password: "a very long password",
      }),
    );
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("newuser@example.com")).toBeTruthy());
  });

  it("edits a user's display name: PATCH carries only display_name, then the list refetches", async () => {
    const original = user();
    const updated = user({ displayName: "Renamed" });
    const listUsers = vi.fn().mockResolvedValueOnce([original]).mockResolvedValueOnce([updated]);
    const patchUser = vi.fn().mockResolvedValue(updated);
    const adminApi = fakeAdminApi({ listUsers, patchUser });
    render(<UsersPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("New User")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editForm = screen.getByRole("form", { name: "Edit newuser@example.com" });
    fireEvent.change(within(editForm, "Display name"), { target: { value: "Renamed" } });
    fireEvent.submit(editForm);

    await waitFor(() => expect(patchUser).toHaveBeenCalledWith("user-1", { displayName: "Renamed" }));
    expect(patchUser.mock.calls[0]![1]).not.toHaveProperty("disabled");
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Renamed")).toBeTruthy());
  });

  it("renders a duplicate-email 409 inline on create", async () => {
    const createUser = vi.fn().mockRejectedValue(new ApiError(409, "CONFLICT", "A user with that email already exists."));
    const adminApi = fakeAdminApi({ createUser });
    render(<UsersPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("No users yet.")).toBeTruthy());

    const createForm = screen.getByRole("form", { name: "Create user" });
    fireEvent.change(within(createForm, "Email"), { target: { value: "dup@example.com" } });
    fireEvent.change(within(createForm, "Display name"), { target: { value: "Dup" } });
    fireEvent.change(within(createForm, "Password"), { target: { value: "a very long password" } });
    fireEvent.submit(createForm);

    expect((await screen.findByTestId("create-error")).textContent).toBe(
      "CONFLICT: A user with that email already exists.",
    );
  });

  describe("disable / enable (GOT.61)", () => {
    it("cancelling the disable confirm does nothing", async () => {
      const patchUser = vi.fn();
      const adminApi = fakeAdminApi({ listUsers: vi.fn().mockResolvedValue([user()]), patchUser });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<UsersPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("newuser@example.com")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Disable newuser@example.com" }));

      expect(confirmSpy).toHaveBeenCalled();
      expect(patchUser).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("confirming disables the user: names the user in the confirm, PATCHes disabled: true, and the row updates", async () => {
      const original = user();
      const disabled = user({ disabledAt: "2026-03-01T00:00:00.000Z" });
      const listUsers = vi.fn().mockResolvedValueOnce([original]).mockResolvedValueOnce([disabled]);
      const patchUser = vi.fn().mockResolvedValue(disabled);
      const adminApi = fakeAdminApi({ listUsers, patchUser });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<UsersPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("newuser@example.com")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Disable newuser@example.com" }));

      expect(confirmSpy.mock.calls[0]?.[0]).toContain("newuser@example.com");
      await waitFor(() => expect(patchUser).toHaveBeenCalledWith("user-1", { disabled: true }));
      await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByText("Disabled")).toBeTruthy());
      confirmSpy.mockRestore();
    });

    it("re-enabling needs no confirm and PATCHes disabled: false", async () => {
      const original = user({ disabledAt: "2026-03-01T00:00:00.000Z" });
      const enabled = user({ disabledAt: null });
      const listUsers = vi.fn().mockResolvedValueOnce([original]).mockResolvedValueOnce([enabled]);
      const patchUser = vi.fn().mockResolvedValue(enabled);
      const adminApi = fakeAdminApi({ listUsers, patchUser });
      const confirmSpy = vi.spyOn(window, "confirm");
      render(<UsersPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("newuser@example.com")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Enable newuser@example.com" }));

      expect(confirmSpy).not.toHaveBeenCalled();
      await waitFor(() => expect(patchUser).toHaveBeenCalledWith("user-1", { disabled: false }));
      await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getAllByText("Active").length).toBe(1));
      confirmSpy.mockRestore();
    });

    it("the current user's own toggle is disabled with an explanation, and no confirm fires if clicked", async () => {
      const self = user({ id: CURRENT_USER.id, email: "self@example.com" });
      const patchUser = vi.fn();
      const adminApi = fakeAdminApi({ listUsers: vi.fn().mockResolvedValue([self]), patchUser });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<UsersPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("self@example.com")).toBeTruthy());
      const toggle = await waitFor(() => {
        const el = screen.getByRole("button", { name: "Disable self@example.com" });
        expect(el.hasAttribute("disabled")).toBe(true);
        return el;
      });
      expect(toggle.getAttribute("title")).toMatch(/own account/i);

      fireEvent.click(toggle);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(patchUser).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("on a 409 the row is unchanged and an inline message shows the api error", async () => {
      const patchUser = vi
        .fn()
        .mockRejectedValue(new ApiError(409, "LAST_ENABLED_USER", "Cannot disable the last enabled user."));
      const adminApi = fakeAdminApi({ listUsers: vi.fn().mockResolvedValue([user()]), patchUser });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<UsersPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("newuser@example.com")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Disable newuser@example.com" }));

      expect((await screen.findByTestId("toggle-error-user-1")).textContent).toBe(
        "LAST_ENABLED_USER: Cannot disable the last enabled user.",
      );
      expect(screen.getByText("Active")).toBeTruthy();
      confirmSpy.mockRestore();
    });

    it("disables the toggle button while the request is in flight", async () => {
      let resolvePatch!: (u: AdminUser) => void;
      const patchUser = vi.fn(() => new Promise<AdminUser>((resolve) => (resolvePatch = resolve)));
      const adminApi = fakeAdminApi({ listUsers: vi.fn().mockResolvedValue([user()]), patchUser });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<UsersPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("newuser@example.com")).toBeTruthy());
      const toggle = screen.getByRole("button", { name: "Disable newuser@example.com" });
      fireEvent.click(toggle);

      await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(true));
      resolvePatch(user({ disabledAt: "2026-03-01T00:00:00.000Z" }));
      confirmSpy.mockRestore();
    });
  });
});
