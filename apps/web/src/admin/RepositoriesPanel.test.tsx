// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { DeleteBlockedError, type AdminApi, type Project, type Repository } from "../api/admin.js";
import { RepositoriesPanel } from "./RepositoriesPanel.js";

afterEach(cleanup);

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    key: "GOOP",
    name: "Goopter",
    jiraJql: "project = GOOP",
    maxInfraRetries: 3,
    maxProtocolRetries: 2,
    maxCiRounds: 3,
    maxReviewRounds: 3,
    maxBudgetUsd: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function repository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-1",
    projectId: "proj-1",
    name: "goopter_odoo_modules",
    gitUrl: "git@example.com:goopter/goopter_odoo_modules.git",
    defaultBranch: "main",
    defaultRuntime: "claude",
    defaultModel: null,
    maxConcurrentWorktrees: 1,
    requiredCapability: null,
    setupCommand: null,
    testCommand: null,
    agentContainer: false,
    agentImage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeAdminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listProjects: vi.fn().mockResolvedValue([project(), project({ id: "proj-2", key: "OTHER" })]),
    createProject: vi.fn(),
    patchProject: vi.fn(),
    deleteProject: vi.fn(),
    listRepositories: vi.fn().mockResolvedValue([]),
    createRepository: vi.fn(),
    patchRepository: vi.fn(),
    deleteRepository: vi.fn(),
    listUsers: vi.fn(),
    createUser: vi.fn(),
    patchUser: vi.fn(),
    listWorkers: vi.fn(),
    ...overrides,
  };
}

function within(container: HTMLElement, labelText: string): HTMLElement {
  const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.startsWith(labelText));
  if (!label) throw new Error(`no label starting with "${labelText}"`);
  const control = label.querySelector("input, select");
  if (!control) throw new Error(`no control inside the "${labelText}" label`);
  return control as HTMLElement;
}

describe("RepositoriesPanel", () => {
  it("shows loading, then an empty state", async () => {
    const adminApi = fakeAdminApi();
    render(<RepositoriesPanel adminApi={adminApi} />);

    expect(screen.getByText("Loading...")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No repositories yet.")).toBeTruthy());
  });

  it("lists every column", async () => {
    const adminApi = fakeAdminApi({
      listRepositories: vi.fn().mockResolvedValue([
        repository({
          requiredCapability: "docker",
          testCommand: "pnpm test",
          agentContainer: true,
          agentImage: "orchestra/agent:custom",
        }),
      ]),
    });
    render(<RepositoriesPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("goopter_odoo_modules")).toBeTruthy());
    expect(screen.getByText((_, el) => el?.textContent === "git@example.com:goopter/goopter_odoo_modules.git · main")).toBeTruthy();
    expect(screen.getByText("docker")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    // Containerised: the image name renders as a success badge, not the row's default branch project name.
    expect(screen.getByText("orchestra/agent:custom")).toBeTruthy();
  });

  it("shows 'Host' for a non-containerised repository", async () => {
    const adminApi = fakeAdminApi({
      listRepositories: vi.fn().mockResolvedValue([repository({ agentContainer: false, agentImage: null })]),
    });
    render(<RepositoriesPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("goopter_odoo_modules")).toBeTruthy());
    expect(screen.getByText("Host")).toBeTruthy();
  });

  it("shows the repository's project by name", async () => {
    const adminApi = fakeAdminApi({
      listRepositories: vi.fn().mockResolvedValue([repository({ projectId: "proj-1" })]),
    });
    render(<RepositoriesPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("Goopter")).toBeTruthy());
  });

  it("applies the project filter to the list call", async () => {
    const listRepositories = vi.fn().mockResolvedValue([]);
    const adminApi = fakeAdminApi({ listRepositories });
    render(<RepositoriesPanel adminApi={adminApi} />);

    await waitFor(() => expect(listRepositories).toHaveBeenCalledWith(undefined));

    await waitFor(() => expect(screen.getAllByText("GOOP").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Filter by project"), { target: { value: "proj-1" } });

    await waitFor(() => expect(listRepositories).toHaveBeenCalledWith("proj-1"));
  });

  it("creates a repository with every field, then the list refetches", async () => {
    const listRepositories = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([repository()]);
    const createRepository = vi.fn().mockResolvedValue(repository());
    const adminApi = fakeAdminApi({ listRepositories, createRepository });
    render(<RepositoriesPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("No repositories yet.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create repository" }));

    const createForm = screen.getByRole("form", { name: "Create repository" });
    fireEvent.change(within(createForm, "Project"), { target: { value: "proj-1" } });
    fireEvent.change(within(createForm, "Name"), { target: { value: "goopter_odoo_modules" } });
    fireEvent.change(within(createForm, "Git URL"), {
      target: { value: "git@example.com:goopter/goopter_odoo_modules.git" },
    });
    fireEvent.change(within(createForm, "Default branch"), { target: { value: "main" } });
    fireEvent.change(within(createForm, "Default runtime"), { target: { value: "codex" } });
    fireEvent.change(within(createForm, "Default model"), { target: { value: "gpt-5-codex" } });
    fireEvent.change(within(createForm, "Max concurrent worktrees"), { target: { value: "2" } });
    fireEvent.change(within(createForm, "Required capability"), { target: { value: "docker" } });
    fireEvent.change(within(createForm, "Setup command"), { target: { value: "pnpm install" } });
    fireEvent.change(within(createForm, "Test command"), { target: { value: "pnpm test" } });
    fireEvent.click(within(createForm, "Run agent in a container"));
    fireEvent.change(within(createForm, "Agent image"), { target: { value: "orchestra/agent:custom" } });
    fireEvent.submit(createForm);

    await waitFor(() =>
      expect(createRepository).toHaveBeenCalledWith({
        projectId: "proj-1",
        name: "goopter_odoo_modules",
        gitUrl: "git@example.com:goopter/goopter_odoo_modules.git",
        defaultBranch: "main",
        defaultRuntime: "codex",
        defaultModel: "gpt-5-codex",
        maxConcurrentWorktrees: 2,
        requiredCapability: "docker",
        setupCommand: "pnpm install",
        testCommand: "pnpm test",
        agentContainer: true,
        agentImage: "orchestra/agent:custom",
      }),
    );
    await waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(2));
  });

  it("edits a repository: only the changed field is sent, then the list refetches", async () => {
    const original = repository();
    const updated = repository({ defaultBranch: "develop" });
    const listRepositories = vi.fn().mockResolvedValueOnce([original]).mockResolvedValueOnce([updated]);
    const patchRepository = vi.fn().mockResolvedValue(updated);
    const adminApi = fakeAdminApi({ listRepositories, patchRepository });
    render(<RepositoriesPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("goopter_odoo_modules")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editForm = screen.getByRole("form", { name: "Edit goopter_odoo_modules" });
    fireEvent.change(within(editForm, "Default branch"), { target: { value: "develop" } });
    fireEvent.submit(editForm);

    await waitFor(() => expect(patchRepository).toHaveBeenCalledWith("repo-1", { defaultBranch: "develop" }));
    await waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(2));
  });

  it("edits agent_container and agent_image, showing the current values in the form", async () => {
    const original = repository({ agentContainer: true, agentImage: "orchestra/agent:custom" });
    const updated = repository({ agentContainer: false, agentImage: null });
    const listRepositories = vi.fn().mockResolvedValueOnce([original]).mockResolvedValueOnce([updated]);
    const patchRepository = vi.fn().mockResolvedValue(updated);
    const adminApi = fakeAdminApi({ listRepositories, patchRepository });
    render(<RepositoriesPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("goopter_odoo_modules")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editForm = screen.getByRole("form", { name: "Edit goopter_odoo_modules" });
    expect((within(editForm, "Run agent in a container") as HTMLInputElement).checked).toBe(true);
    expect((within(editForm, "Agent image") as HTMLInputElement).value).toBe("orchestra/agent:custom");

    fireEvent.click(within(editForm, "Run agent in a container"));
    fireEvent.change(within(editForm, "Agent image"), { target: { value: "" } });
    fireEvent.submit(editForm);

    await waitFor(() =>
      expect(patchRepository).toHaveBeenCalledWith("repo-1", { agentContainer: false, agentImage: null }),
    );
    await waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(2));
  });

  it("renders a 400 for a composed test_command inline next to the create form", async () => {
    const createRepository = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, "VALIDATION_ERROR", "test_command: test_command must not contain ( ) * & ; | ` $ < > or a newline"),
      );
    const adminApi = fakeAdminApi({ createRepository });
    render(<RepositoriesPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("No repositories yet.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create repository" }));

    const createForm = screen.getByRole("form", { name: "Create repository" });
    fireEvent.change(within(createForm, "Project"), { target: { value: "proj-1" } });
    fireEvent.change(within(createForm, "Name"), { target: { value: "goopter_odoo_modules" } });
    fireEvent.change(within(createForm, "Git URL"), {
      target: { value: "git@example.com:goopter/goopter_odoo_modules.git" },
    });
    fireEvent.change(within(createForm, "Test command"), { target: { value: "pnpm test && rm -rf /" } });
    fireEvent.submit(createForm);

    expect((await screen.findByTestId("create-error")).textContent).toBe(
      "VALIDATION_ERROR: test_command: test_command must not contain ( ) * & ; | ` $ < > or a newline",
    );
  });

  describe("delete", () => {
    it("cancelling the confirm does nothing", async () => {
      const deleteRepository = vi.fn();
      const adminApi = fakeAdminApi({
        listRepositories: vi.fn().mockResolvedValue([repository()]),
        deleteRepository,
      });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<RepositoriesPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("goopter_odoo_modules")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Delete goopter_odoo_modules" }));

      expect(confirmSpy).toHaveBeenCalled();
      expect(deleteRepository).not.toHaveBeenCalled();
      expect(screen.getByText("goopter_odoo_modules")).toBeTruthy();
      confirmSpy.mockRestore();
    });

    it("confirming names the repository, calls the api, and the row disappears", async () => {
      const deleteRepository = vi.fn().mockResolvedValue(undefined);
      const listRepositories = vi.fn().mockResolvedValueOnce([repository()]).mockResolvedValueOnce([]);
      const adminApi = fakeAdminApi({ listRepositories, deleteRepository });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<RepositoriesPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("goopter_odoo_modules")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Delete goopter_odoo_modules" }));

      expect(confirmSpy.mock.calls[0]?.[0]).toContain("goopter_odoo_modules");
      await waitFor(() => expect(deleteRepository).toHaveBeenCalledWith("repo-1"));
      await waitFor(() => expect(listRepositories).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByText("No repositories yet.")).toBeTruthy());
      confirmSpy.mockRestore();
    });

    it("on a 409 the row stays and an inline message shows the reason and task count", async () => {
      const deleteRepository = vi
        .fn()
        .mockRejectedValue(new DeleteBlockedError("Cannot delete: 4 task(s) reference this repository.", 4));
      const adminApi = fakeAdminApi({
        listRepositories: vi.fn().mockResolvedValue([repository()]),
        deleteRepository,
      });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<RepositoriesPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("goopter_odoo_modules")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Delete goopter_odoo_modules" }));

      expect((await screen.findByTestId("delete-error-repo-1")).textContent).toBe(
        "Cannot delete: 4 task(s) reference this repository.",
      );
      expect(screen.getByText("goopter_odoo_modules")).toBeTruthy();
      confirmSpy.mockRestore();
    });

    it("disables the delete button while the request is in flight", async () => {
      let resolveDelete!: () => void;
      const deleteRepository = vi.fn(() => new Promise<void>((resolve) => (resolveDelete = resolve)));
      const adminApi = fakeAdminApi({
        listRepositories: vi.fn().mockResolvedValue([repository()]),
        deleteRepository,
      });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<RepositoriesPanel adminApi={adminApi} />);

      await waitFor(() => expect(screen.getByText("goopter_odoo_modules")).toBeTruthy());
      const deleteButton = screen.getByRole("button", { name: "Delete goopter_odoo_modules" });
      fireEvent.click(deleteButton);

      await waitFor(() => expect(deleteButton.hasAttribute("disabled")).toBe(true));
      resolveDelete();
      confirmSpy.mockRestore();
    });
  });
});
