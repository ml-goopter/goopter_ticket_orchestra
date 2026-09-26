// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { AdminApi, Project } from "../api/admin.js";
import { ProjectsPanel } from "./ProjectsPanel.js";

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

function fakeAdminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    createProject: vi.fn(),
    patchProject: vi.fn(),
    listRepositories: vi.fn(),
    createRepository: vi.fn(),
    patchRepository: vi.fn(),
    listUsers: vi.fn(),
    createUser: vi.fn(),
    patchUser: vi.fn(),
    listWorkers: vi.fn(),
    ...overrides,
  };
}

describe("ProjectsPanel", () => {
  it("shows a loading state before the first fetch resolves", () => {
    const adminApi = fakeAdminApi({ listProjects: vi.fn(() => new Promise<never>(() => {})) });
    render(<ProjectsPanel adminApi={adminApi} />);

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("shows an empty state, then a populated list", async () => {
    const adminApi = fakeAdminApi({ listProjects: vi.fn().mockResolvedValue([]) });
    render(<ProjectsPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("No projects yet.")).toBeTruthy());
  });

  it("lists a project's key, name, jql and limits", async () => {
    const adminApi = fakeAdminApi({ listProjects: vi.fn().mockResolvedValue([project()]) });
    render(<ProjectsPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("GOOP")).toBeTruthy());
    expect(screen.getByText("Goopter")).toBeTruthy();
    expect(screen.getByText("project = GOOP")).toBeTruthy();
  });

  it("shows a load error", async () => {
    const adminApi = fakeAdminApi({ listProjects: vi.fn().mockRejectedValue(new Error("network down")) });
    render(<ProjectsPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network down"));
  });

  it("creates a project: form values become the POST body, then the list refetches", async () => {
    const listProjects = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([project()]);
    const createProject = vi.fn().mockResolvedValue(project());
    const adminApi = fakeAdminApi({ listProjects, createProject });
    render(<ProjectsPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("No projects yet.")).toBeTruthy());

    const createForm = screen.getByRole("form", { name: "Create project" });
    fireEvent.change(within(createForm, "Key"), { target: { value: "GOOP" } });
    fireEvent.change(within(createForm, "Name"), { target: { value: "Goopter" } });
    fireEvent.change(within(createForm, "Jira JQL"), { target: { value: "project = GOOP" } });
    fireEvent.submit(createForm);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        key: "GOOP",
        name: "Goopter",
        jiraJql: "project = GOOP",
        maxInfraRetries: 3,
        maxProtocolRetries: 2,
        maxCiRounds: 3,
        maxReviewRounds: 3,
        maxBudgetUsd: null,
      }),
    );
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("GOOP")).toBeTruthy());
  });

  it("blocks a negative limit client-side with an inline message and never calls the api", async () => {
    const createProject = vi.fn();
    const adminApi = fakeAdminApi({ createProject });
    render(<ProjectsPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("No projects yet.")).toBeTruthy());

    const createForm = screen.getByRole("form", { name: "Create project" });
    fireEvent.change(within(createForm, "Key"), { target: { value: "GOOP" } });
    fireEvent.change(within(createForm, "Name"), { target: { value: "Goopter" } });
    fireEvent.change(within(createForm, "Jira JQL"), { target: { value: "project = GOOP" } });
    fireEvent.change(within(createForm, "Max infra retries"), { target: { value: "-1" } });
    fireEvent.submit(createForm);

    expect(await screen.findByTestId("create-error-maxInfraRetries")).toBeTruthy();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("renders a 409 from the api inline next to the create form", async () => {
    const createProject = vi.fn().mockRejectedValue(new ApiError(409, "CONFLICT", "A project with key GOOP already exists."));
    const adminApi = fakeAdminApi({ createProject });
    render(<ProjectsPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("No projects yet.")).toBeTruthy());

    const createForm = screen.getByRole("form", { name: "Create project" });
    fireEvent.change(within(createForm, "Key"), { target: { value: "GOOP" } });
    fireEvent.change(within(createForm, "Name"), { target: { value: "Goopter" } });
    fireEvent.change(within(createForm, "Jira JQL"), { target: { value: "project = GOOP" } });
    fireEvent.submit(createForm);

    expect((await screen.findByTestId("create-error")).textContent).toBe(
      "CONFLICT: A project with key GOOP already exists.",
    );
  });

  it("edits a project: only the changed field is sent in the PATCH body, then the list refetches", async () => {
    const original = project();
    const updated = project({ name: "Goopter Renamed" });
    const listProjects = vi.fn().mockResolvedValueOnce([original]).mockResolvedValueOnce([updated]);
    const patchProject = vi.fn().mockResolvedValue(updated);
    const adminApi = fakeAdminApi({ listProjects, patchProject });
    render(<ProjectsPanel adminApi={adminApi} />);

    await waitFor(() => expect(screen.getByText("GOOP")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editForm = screen.getByRole("form", { name: "Edit GOOP" });
    fireEvent.change(within(editForm, "Name"), { target: { value: "Goopter Renamed" } });
    fireEvent.submit(editForm);

    await waitFor(() => expect(patchProject).toHaveBeenCalledWith("proj-1", { name: "Goopter Renamed" }));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Goopter Renamed")).toBeTruthy());
  });
});

/** Finds a labelled input inside a given form's subtree by its label text. */
function within(container: HTMLElement, labelText: string): HTMLElement {
  const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.startsWith(labelText));
  if (!label) throw new Error(`no label starting with "${labelText}" in the given form`);
  const input = label.querySelector("input");
  if (!input) throw new Error(`no input inside the "${labelText}" label`);
  return input;
}
