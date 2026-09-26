// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { AdminApi, AdminUser } from "../api/admin.js";
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

function fakeAdminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    patchProject: vi.fn(),
    listRepositories: vi.fn(),
    createRepository: vi.fn(),
    patchRepository: vi.fn(),
    listUsers: vi.fn().mockResolvedValue([]),
    createUser: vi.fn(),
    patchUser: vi.fn(),
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

  it("lists email, display name, created, and disabled state read-only", async () => {
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
    expect(screen.getByText("2026-01-01T00:00:00.000Z")).toBeTruthy();
    expect(screen.getAllByText("Active").length).toBe(1);
    expect(screen.getAllByText("Disabled").length).toBe(1);
  });

  it("has no disable or re-enable control", async () => {
    const adminApi = fakeAdminApi({ listUsers: vi.fn().mockResolvedValue([user()]) });
    render(<UsersPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("newuser@example.com")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /disable/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /enable/i })).toBeNull();
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
});
