// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApi, Worker } from "../api/admin.js";
import { WorkersPanel } from "./WorkersPanel.js";

afterEach(cleanup);

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    host: "admin-test-host",
    capabilities: ["default", "docker"],
    maxConcurrent: 3,
    workspaceRoot: "/srv/orchestra",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAgeSeconds: 90,
    freeSlots: 2,
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
    listUsers: vi.fn(),
    createUser: vi.fn(),
    patchUser: vi.fn(),
    listWorkers: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("WorkersPanel", () => {
  it("shows loading, then an empty state", async () => {
    const adminApi = fakeAdminApi();
    render(<WorkersPanel adminApi={adminApi} />);

    expect(screen.getByText("Loading...")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No workers registered.")).toBeTruthy());
  });

  it("lists host, capabilities, slots, and the formatted heartbeat age", async () => {
    const adminApi = fakeAdminApi({ listWorkers: vi.fn().mockResolvedValue([worker()]) });
    render(<WorkersPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("admin-test-host")).toBeTruthy());
    expect(screen.getByText("default, docker")).toBeTruthy();
    expect(screen.getByText("1m ago")).toBeTruthy();
    expect(screen.queryByTestId("stale-marker")).toBeNull();
  });

  it("marks a worker stale once its heartbeat age exceeds 15 minutes", async () => {
    const adminApi = fakeAdminApi({
      listWorkers: vi.fn().mockResolvedValue([worker({ heartbeatAgeSeconds: 15 * 60 + 1 })]),
    });
    render(<WorkersPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByTestId("stale-marker")).toBeTruthy());
  });

  it("does not mark a worker stale at exactly 15 minutes", async () => {
    const adminApi = fakeAdminApi({
      listWorkers: vi.fn().mockResolvedValue([worker({ heartbeatAgeSeconds: 15 * 60 })]),
    });
    render(<WorkersPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("admin-test-host")).toBeTruthy());
    expect(screen.queryByTestId("stale-marker")).toBeNull();
  });

  it("refetches when the refresh button is clicked", async () => {
    const listWorkers = vi.fn().mockResolvedValue([worker()]);
    const adminApi = fakeAdminApi({ listWorkers });
    render(<WorkersPanel adminApi={adminApi} />);

    await waitFor(() => expect(listWorkers).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(listWorkers).toHaveBeenCalledTimes(2));
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("refetches automatically every 30 seconds while mounted", async () => {
      const listWorkers = vi.fn().mockResolvedValue([worker()]);
      const adminApi = fakeAdminApi({ listWorkers });
      render(<WorkersPanel adminApi={adminApi} />);

      await vi.waitFor(() => expect(listWorkers).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(listWorkers).toHaveBeenCalledTimes(2));

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(listWorkers).toHaveBeenCalledTimes(3));
    });

    it("stops refetching once unmounted", async () => {
      const listWorkers = vi.fn().mockResolvedValue([worker()]);
      const adminApi = fakeAdminApi({ listWorkers });
      const { unmount } = render(<WorkersPanel adminApi={adminApi} />);

      await vi.waitFor(() => expect(listWorkers).toHaveBeenCalledTimes(1));
      unmount();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(listWorkers).toHaveBeenCalledTimes(1);
    });
  });
});
