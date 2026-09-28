// @vitest-environment jsdom
import type { SpecContent } from "@orchestra/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminRepository } from "../api/types.js";
import { SpecDraftForm } from "./SpecDraftForm.js";
import { emptySpecContent } from "./specForm.js";

afterEach(cleanup);

function makeRepository(overrides: Partial<AdminRepository> = {}): AdminRepository {
  return {
    id: "repo-1",
    project_id: "project-1",
    name: "tsk-repo",
    git_url: "git@example.com:goopter/tsk-repo.git",
    default_branch: "main",
    default_runtime: "claude",
    default_model: null,
    max_concurrent_worktrees: 1,
    required_capability: null,
    setup_command: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderForm({
  content = emptySpecContent(),
  repositories = [] as AdminRepository[],
  disabled = false,
  onChange = vi.fn(),
  highlightedFields = new Set<string>(),
}: {
  content?: SpecContent;
  repositories?: AdminRepository[];
  disabled?: boolean;
  onChange?: (next: SpecContent) => void;
  highlightedFields?: ReadonlySet<string>;
} = {}) {
  render(
    <SpecDraftForm
      content={content}
      repositories={repositories}
      highlightedFields={highlightedFields}
      disabled={disabled}
      onChange={onChange}
    />,
  );
  return { onChange };
}

describe("SpecDraftForm repository field", () => {
  it("renders a select listing the project's repositories by name, with an accessible name", () => {
    renderForm({ repositories: [makeRepository({ id: "r1", name: "repo-a" }), makeRepository({ id: "r2", name: "repo-b" })] });

    const select = screen.getByLabelText("Repository") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    const optionNames = Array.from(select.options).map((option) => option.value);
    expect(optionNames).toEqual(["", "repo-a", "repo-b"]);
  });

  it("D3: preselects the single repository when the field is empty", () => {
    const onChange = vi.fn();
    renderForm({
      content: emptySpecContent(""),
      repositories: [makeRepository({ id: "r1", name: "only-repo" })],
      onChange,
    });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ repository: "only-repo" }));
  });

  it("does not preselect when two or more repositories exist and the field is empty", () => {
    const onChange = vi.fn();
    renderForm({
      content: emptySpecContent(""),
      repositories: [makeRepository({ id: "r1", name: "repo-a" }), makeRepository({ id: "r2", name: "repo-b" })],
      onChange,
    });

    expect(onChange).not.toHaveBeenCalled();
    const select = screen.getByLabelText("Repository") as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("shows a stale saved value as selected but flags it invalid, without replacing it", () => {
    const onChange = vi.fn();
    renderForm({
      content: emptySpecContent("deleted-repo"),
      repositories: [makeRepository({ id: "r1", name: "repo-a" })],
      onChange,
    });

    const select = screen.getByLabelText("Repository") as HTMLSelectElement;
    expect(select.value).toBe("deleted-repo");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("repository-invalid").textContent).toContain("deleted-repo");
  });

  it("shows an empty-state message and no control when there are no repositories", () => {
    renderForm({ content: emptySpecContent(""), repositories: [] });

    expect(screen.getByTestId("repository-empty-state")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("reaches onChange (the saved draft) with the chosen repository name on user selection", () => {
    const onChange = vi.fn();
    renderForm({
      content: emptySpecContent(""),
      repositories: [makeRepository({ id: "r1", name: "repo-a" }), makeRepository({ id: "r2", name: "repo-b" })],
      onChange,
    });

    const select = screen.getByLabelText("Repository") as HTMLSelectElement;
    select.value = "repo-b";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ repository: "repo-b" }));
  });
});
