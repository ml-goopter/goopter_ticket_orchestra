import type { Runtime } from "@orchestra/core";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminApi, CreateRepositoryInput, PatchRepositoryInput, Project, Repository } from "../api/admin.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { describeApiError } from "./format.js";
import { validateRepositoryInput, type FieldErrors } from "./validation.js";

export interface RepositoriesPanelProps {
  adminApi: AdminApi;
}

const RUNTIMES: Runtime[] = ["claude", "codex"];

function emptyForm(projectId: string): CreateRepositoryInput {
  return {
    projectId,
    name: "",
    gitUrl: "",
    defaultBranch: "main",
    defaultRuntime: "claude",
    defaultModel: null,
    maxConcurrentWorktrees: 1,
    requiredCapability: null,
    setupCommand: null,
    testCommand: null,
    agentContainer: false,
    agentImage: null,
  };
}

function toFormValues(repository: Repository): CreateRepositoryInput {
  return {
    projectId: repository.projectId,
    name: repository.name,
    gitUrl: repository.gitUrl,
    defaultBranch: repository.defaultBranch,
    defaultRuntime: repository.defaultRuntime,
    defaultModel: repository.defaultModel,
    maxConcurrentWorktrees: repository.maxConcurrentWorktrees,
    requiredCapability: repository.requiredCapability,
    setupCommand: repository.setupCommand,
    testCommand: repository.testCommand,
    agentContainer: repository.agentContainer,
    agentImage: repository.agentImage,
  };
}

/** Only the fields that differ from `repository` end up in the patch body. */
function diffRepository(repository: Repository, form: CreateRepositoryInput): PatchRepositoryInput {
  const patch: PatchRepositoryInput = {};
  if (form.projectId !== repository.projectId) patch.projectId = form.projectId;
  if (form.name !== repository.name) patch.name = form.name;
  if (form.gitUrl !== repository.gitUrl) patch.gitUrl = form.gitUrl;
  if (form.defaultBranch !== repository.defaultBranch) patch.defaultBranch = form.defaultBranch;
  if (form.defaultRuntime !== repository.defaultRuntime) patch.defaultRuntime = form.defaultRuntime;
  if (form.defaultModel !== repository.defaultModel) patch.defaultModel = form.defaultModel;
  if (form.maxConcurrentWorktrees !== repository.maxConcurrentWorktrees) {
    patch.maxConcurrentWorktrees = form.maxConcurrentWorktrees;
  }
  if (form.requiredCapability !== repository.requiredCapability) patch.requiredCapability = form.requiredCapability;
  if (form.setupCommand !== repository.setupCommand) patch.setupCommand = form.setupCommand;
  if (form.testCommand !== repository.testCommand) patch.testCommand = form.testCommand;
  if (form.agentContainer !== repository.agentContainer) patch.agentContainer = form.agentContainer;
  if (form.agentImage !== repository.agentImage) patch.agentImage = form.agentImage;
  return patch;
}

function nullableInputValue(value: string | null): string {
  return value ?? "";
}

function parseNullableInput(value: string): string | null {
  return value === "" ? null : value;
}

interface RepositoryFieldsProps {
  form: CreateRepositoryInput;
  onChange: (form: CreateRepositoryInput) => void;
  errors: FieldErrors;
  idPrefix: string;
  projects: Project[];
}

function RepositoryFields({ form, onChange, errors, idPrefix, projects }: RepositoryFieldsProps) {
  return (
    <>
      <div className="field">
        <label>
          Project
          <select value={form.projectId} onChange={(event) => onChange({ ...form, projectId: event.target.value })}>
            <option value="">Select a project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.key}
              </option>
            ))}
          </select>
        </label>
        {errors.projectId && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-projectId`}>
            {errors.projectId}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Name
          <input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
        </label>
        {errors.name && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-name`}>
            {errors.name}
          </span>
        )}
      </div>
      <div className="field form-grid__full">
        <label>
          Git URL
          <input value={form.gitUrl} onChange={(event) => onChange({ ...form, gitUrl: event.target.value })} />
        </label>
        {errors.gitUrl && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-gitUrl`}>
            {errors.gitUrl}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Default branch
          <input
            value={form.defaultBranch}
            onChange={(event) => onChange({ ...form, defaultBranch: event.target.value })}
          />
        </label>
        {errors.defaultBranch && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-defaultBranch`}>
            {errors.defaultBranch}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Default runtime
          <select
            value={form.defaultRuntime}
            onChange={(event) => onChange({ ...form, defaultRuntime: event.target.value as Runtime })}
          >
            {RUNTIMES.map((runtime) => (
              <option key={runtime} value={runtime}>
                {runtime}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <label>
          Default model
          <input
            value={nullableInputValue(form.defaultModel)}
            onChange={(event) => onChange({ ...form, defaultModel: parseNullableInput(event.target.value) })}
          />
        </label>
        <p className="field__help">Optional; overrides the repository's default model.</p>
      </div>
      <div className="field">
        <label>
          Max concurrent worktrees
          <input
            type="number"
            value={form.maxConcurrentWorktrees}
            onChange={(event) => onChange({ ...form, maxConcurrentWorktrees: Number(event.target.value) })}
          />
        </label>
        <p className="field__help">At least 1.</p>
        {errors.maxConcurrentWorktrees && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-maxConcurrentWorktrees`}>
            {errors.maxConcurrentWorktrees}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Required capability
          <input
            value={nullableInputValue(form.requiredCapability)}
            onChange={(event) => onChange({ ...form, requiredCapability: parseNullableInput(event.target.value) })}
          />
        </label>
        <p className="field__help">Optional; matches a worker's capability tags.</p>
      </div>
      <div className="field">
        <label>
          Setup command
          <input
            value={nullableInputValue(form.setupCommand)}
            onChange={(event) => onChange({ ...form, setupCommand: parseNullableInput(event.target.value) })}
          />
        </label>
        <p className="field__help">Optional; run once per fresh worktree.</p>
      </div>
      <div className="field form-grid__full">
        <label>
          Test command
          <input
            value={nullableInputValue(form.testCommand)}
            onChange={(event) => onChange({ ...form, testCommand: parseNullableInput(event.target.value) })}
          />
        </label>
        <p className="field__help">
          Optional; must not contain shell metacharacters ( ) * &amp; ; | ` $ &lt; &gt; or a newline.
        </p>
      </div>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={form.agentContainer}
            onChange={(event) => onChange({ ...form, agentContainer: event.target.checked })}
          />
          Run agent in a container
        </label>
        <p className="field__help">design.md §9.9; runs this repository's agent processes in a container.</p>
      </div>
      <div className="field">
        <label>
          Agent image
          <input
            value={nullableInputValue(form.agentImage)}
            onChange={(event) => onChange({ ...form, agentImage: parseNullableInput(event.target.value) })}
          />
        </label>
        <p className="field__help">Optional; image override for container mode, built `FROM orchestra/agent`.</p>
      </div>
    </>
  );
}

/**
 * Repositories panel (design.md §14 Admin row, §12.5 `/repositories`, task
 * contract GOT.29; restyled by U5): filter by project, list every column
 * the api stores, create/edit forms for every field. `git_url` format and
 * the review role's composed-command policy on `test_command` are not
 * re-validated client-side (task contract point 2): the api's 400 renders
 * inline next to the field instead.
 */
export function RepositoriesPanel({ adminApi }: RepositoriesPanelProps) {
  const { begin, isCurrent } = useLatestRequest();
  const [projects, setProjects] = useState<Project[]>([]);
  const [filterProjectId, setFilterProjectId] = useState<string>("");
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<CreateRepositoryInput>(emptyForm(""));
  const [createErrors, setCreateErrors] = useState<FieldErrors>({});
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<CreateRepositoryInput | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const [editErrors, setEditErrors] = useState<FieldErrors>({});
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    void adminApi.listProjects().then(setProjects);
  }, [adminApi]);

  const fetchRepositories = useCallback(async () => {
    const generation = begin();
    setLoadError(null);
    try {
      const rows = await adminApi.listRepositories(filterProjectId || undefined);
      if (!isCurrent(generation)) return;
      setRepositories(rows);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setRepositories(null);
      setLoadError(describeApiError(err, "Failed to load repositories."));
    }
  }, [adminApi, filterProjectId, begin, isCurrent]);

  useEffect(() => {
    void fetchRepositories();
  }, [fetchRepositories]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const errors = validateRepositoryInput(createForm);
    setCreateErrors(errors);
    setCreateError(null);
    if (Object.keys(errors).length > 0) return;
    try {
      await adminApi.createRepository(createForm);
      setCreateForm(emptyForm(createForm.projectId));
      await fetchRepositories();
    } catch (err) {
      setCreateError(describeApiError(err, "Failed to create the repository."));
    }
  }

  function startEdit(repository: Repository) {
    setEditingId(repository.id);
    setEditForm(toFormValues(repository));
    setEditErrors({});
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setEditErrors({});
    setEditError(null);
  }

  async function handleSaveEdit(event: FormEvent, repository: Repository) {
    event.preventDefault();
    if (!editForm) return;
    const errors = validateRepositoryInput(editForm);
    setEditErrors(errors);
    setEditError(null);
    if (Object.keys(errors).length > 0) return;
    try {
      await adminApi.patchRepository(repository.id, diffRepository(repository, editForm));
      cancelEdit();
      await fetchRepositories();
    } catch (err) {
      setEditError(describeApiError(err, "Failed to update the repository."));
    }
  }

  /**
   * Confirm names the repository, matching `TaskDetailView.tsx`'s
   * cancel-task pattern; cancelling the browser confirm does nothing.
   */
  async function handleDelete(repository: Repository) {
    if (!window.confirm(`Delete repository ${repository.name}?`)) {
      return;
    }
    setDeletingId(repository.id);
    setDeleteError(null);
    try {
      await adminApi.deleteRepository(repository.id);
      await fetchRepositories();
    } catch (err) {
      setDeleteError({ id: repository.id, message: describeApiError(err, "Failed to delete the repository.") });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section aria-label="Repositories">
      <h2>Repositories</h2>

      <div className="toolbar">
        <div className="field">
          <label>
            Filter by project
            <select value={filterProjectId} onChange={(event) => setFilterProjectId(event.target.value)}>
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.key}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="admin-panel__table">
        {loadError && (
          <p className="alert alert--error" role="alert">
            {loadError}
          </p>
        )}
        {!loadError && repositories === null && <p>Loading...</p>}
        {repositories && repositories.length === 0 && (
          <div className="empty-state">
            <p>No repositories yet.</p>
          </div>
        )}
        {repositories && repositories.length > 0 && (
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Git URL</th>
                <th scope="col">Default branch</th>
                <th scope="col">Runtime</th>
                <th scope="col">Model</th>
                <th scope="col" className="num">
                  Capacity
                </th>
                <th scope="col">Capability</th>
                <th scope="col">Setup command</th>
                <th scope="col">Test command</th>
                <th scope="col">Container</th>
                <th scope="col">Image</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {repositories.map((repository) =>
                editingId === repository.id && editForm ? (
                  <tr key={repository.id}>
                    <td colSpan={12}>
                      <div className="card">
                        <h3>Edit repository</h3>
                        <form
                          aria-label={`Edit ${repository.name}`}
                          className="form-grid"
                          onSubmit={(event) => void handleSaveEdit(event, repository)}
                        >
                          <RepositoryFields
                            form={editForm}
                            onChange={setEditForm}
                            errors={editErrors}
                            idPrefix="edit"
                            projects={projects}
                          />
                          {editError && (
                            <p className="alert alert--error form-grid__full" role="alert" data-testid="edit-error">
                              {editError}
                            </p>
                          )}
                          <div className="form-grid__full admin-form__actions">
                            <button type="submit" className="primary">
                              Save
                            </button>
                            <button type="button" onClick={cancelEdit}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={repository.id}>
                    <td>{repository.name}</td>
                    <td>
                      <span className="admin-table__mono" title={repository.gitUrl}>
                        {repository.gitUrl}
                      </span>
                    </td>
                    <td>{repository.defaultBranch}</td>
                    <td>{repository.defaultRuntime}</td>
                    <td>{repository.defaultModel ?? "—"}</td>
                    <td className="num">{repository.maxConcurrentWorktrees}</td>
                    <td>{repository.requiredCapability ?? "—"}</td>
                    <td>
                      {repository.setupCommand ? (
                        <span className="admin-table__mono" title={repository.setupCommand}>
                          {repository.setupCommand}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {repository.testCommand ? (
                        <span className="admin-table__mono" title={repository.testCommand}>
                          {repository.testCommand}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{repository.agentContainer ? "Yes" : "No"}</td>
                    <td>{repository.agentImage ?? "—"}</td>
                    <td>
                      <button type="button" className="admin-table__action" onClick={() => startEdit(repository)}>
                        Edit
                      </button>{" "}
                      <button
                        type="button"
                        className="admin-table__action"
                        aria-label={`Delete ${repository.name}`}
                        disabled={deletingId === repository.id}
                        onClick={() => void handleDelete(repository)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ),
              )}
              {deleteError && (
                <tr key={`${deleteError.id}-delete-error`}>
                  <td colSpan={12}>
                    <p
                      className="alert alert--error"
                      role="alert"
                      data-testid={`delete-error-${deleteError.id}`}
                    >
                      {deleteError.message}
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Create repository</h3>
        <form aria-label="Create repository" className="form-grid" onSubmit={(event) => void handleCreate(event)}>
          <RepositoryFields form={createForm} onChange={setCreateForm} errors={createErrors} idPrefix="create" projects={projects} />
          {createError && (
            <p className="alert alert--error form-grid__full" role="alert" data-testid="create-error">
              {createError}
            </p>
          )}
          <div className="form-grid__full admin-form__actions">
            <button type="submit" className="primary">
              Create repository
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
