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
        <span role="alert" data-testid={`${idPrefix}-error-projectId`}>
          {errors.projectId}
        </span>
      )}
      <label>
        Name
        <input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
      </label>
      {errors.name && (
        <span role="alert" data-testid={`${idPrefix}-error-name`}>
          {errors.name}
        </span>
      )}
      <label>
        Git URL
        <input value={form.gitUrl} onChange={(event) => onChange({ ...form, gitUrl: event.target.value })} />
      </label>
      {errors.gitUrl && (
        <span role="alert" data-testid={`${idPrefix}-error-gitUrl`}>
          {errors.gitUrl}
        </span>
      )}
      <label>
        Default branch
        <input value={form.defaultBranch} onChange={(event) => onChange({ ...form, defaultBranch: event.target.value })} />
      </label>
      {errors.defaultBranch && (
        <span role="alert" data-testid={`${idPrefix}-error-defaultBranch`}>
          {errors.defaultBranch}
        </span>
      )}
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
      <label>
        Default model
        <input
          value={nullableInputValue(form.defaultModel)}
          onChange={(event) => onChange({ ...form, defaultModel: parseNullableInput(event.target.value) })}
        />
      </label>
      <label>
        Max concurrent worktrees
        <input
          type="number"
          value={form.maxConcurrentWorktrees}
          onChange={(event) => onChange({ ...form, maxConcurrentWorktrees: Number(event.target.value) })}
        />
      </label>
      {errors.maxConcurrentWorktrees && (
        <span role="alert" data-testid={`${idPrefix}-error-maxConcurrentWorktrees`}>
          {errors.maxConcurrentWorktrees}
        </span>
      )}
      <label>
        Required capability
        <input
          value={nullableInputValue(form.requiredCapability)}
          onChange={(event) => onChange({ ...form, requiredCapability: parseNullableInput(event.target.value) })}
        />
      </label>
      <label>
        Setup command
        <input
          value={nullableInputValue(form.setupCommand)}
          onChange={(event) => onChange({ ...form, setupCommand: parseNullableInput(event.target.value) })}
        />
      </label>
      <label>
        Test command
        <input
          value={nullableInputValue(form.testCommand)}
          onChange={(event) => onChange({ ...form, testCommand: parseNullableInput(event.target.value) })}
        />
      </label>
    </>
  );
}

/**
 * Repositories panel (design.md §14 Admin row, §12.5 `/repositories`, task
 * contract GOT.29): filter by project, list every column the api stores,
 * create/edit forms for every field. `git_url` format and the review
 * role's composed-command policy on `test_command` are not re-validated
 * client-side (task contract point 2): the api's 400 renders inline next
 * to the field instead.
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

  return (
    <section aria-label="Repositories">
      <h2>Repositories</h2>

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

      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && repositories === null && <p>Loading...</p>}
      {repositories && repositories.length === 0 && <p>No repositories yet.</p>}
      {repositories && repositories.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Git URL</th>
              <th scope="col">Default branch</th>
              <th scope="col">Runtime</th>
              <th scope="col">Model</th>
              <th scope="col">Capacity</th>
              <th scope="col">Capability</th>
              <th scope="col">Setup command</th>
              <th scope="col">Test command</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {repositories.map((repository) =>
              editingId === repository.id && editForm ? (
                <tr key={repository.id}>
                  <td colSpan={10}>
                    <form
                      aria-label={`Edit ${repository.name}`}
                      onSubmit={(event) => void handleSaveEdit(event, repository)}
                    >
                      <RepositoryFields form={editForm} onChange={setEditForm} errors={editErrors} idPrefix="edit" projects={projects} />
                      {editError && (
                        <p role="alert" data-testid="edit-error">
                          {editError}
                        </p>
                      )}
                      <button type="submit">Save</button>
                      <button type="button" onClick={cancelEdit}>
                        Cancel
                      </button>
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={repository.id}>
                  <td>{repository.name}</td>
                  <td>{repository.gitUrl}</td>
                  <td>{repository.defaultBranch}</td>
                  <td>{repository.defaultRuntime}</td>
                  <td>{repository.defaultModel ?? "—"}</td>
                  <td>{repository.maxConcurrentWorktrees}</td>
                  <td>{repository.requiredCapability ?? "—"}</td>
                  <td>{repository.setupCommand ?? "—"}</td>
                  <td>{repository.testCommand ?? "—"}</td>
                  <td>
                    <button type="button" onClick={() => startEdit(repository)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      <form aria-label="Create repository" onSubmit={(event) => void handleCreate(event)}>
        <h3>Create repository</h3>
        <RepositoryFields form={createForm} onChange={setCreateForm} errors={createErrors} idPrefix="create" projects={projects} />
        {createError && (
          <p role="alert" data-testid="create-error">
            {createError}
          </p>
        )}
        <button type="submit">Create repository</button>
      </form>
    </section>
  );
}
