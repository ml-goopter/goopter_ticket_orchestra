import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminApi, CreateProjectInput, PatchProjectInput, Project } from "../api/admin.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { describeApiError } from "./format.js";
import { validateProjectInput, type FieldErrors } from "./validation.js";

export interface ProjectsPanelProps {
  adminApi: AdminApi;
}

const EMPTY_FORM: CreateProjectInput = {
  key: "",
  name: "",
  jiraJql: "",
  maxInfraRetries: 3,
  maxProtocolRetries: 2,
  maxCiRounds: 3,
  maxReviewRounds: 3,
  maxBudgetUsd: null,
};

function toFormValues(project: Project): CreateProjectInput {
  return {
    key: project.key,
    name: project.name,
    jiraJql: project.jiraJql,
    maxInfraRetries: project.maxInfraRetries,
    maxProtocolRetries: project.maxProtocolRetries,
    maxCiRounds: project.maxCiRounds,
    maxReviewRounds: project.maxReviewRounds,
    maxBudgetUsd: project.maxBudgetUsd,
  };
}

/** Only the fields that differ from `project` end up in the patch body. */
function diffProject(project: Project, form: CreateProjectInput): PatchProjectInput {
  const patch: PatchProjectInput = {};
  if (form.key !== project.key) patch.key = form.key;
  if (form.name !== project.name) patch.name = form.name;
  if (form.jiraJql !== project.jiraJql) patch.jiraJql = form.jiraJql;
  if (form.maxInfraRetries !== project.maxInfraRetries) patch.maxInfraRetries = form.maxInfraRetries;
  if (form.maxProtocolRetries !== project.maxProtocolRetries) patch.maxProtocolRetries = form.maxProtocolRetries;
  if (form.maxCiRounds !== project.maxCiRounds) patch.maxCiRounds = form.maxCiRounds;
  if (form.maxReviewRounds !== project.maxReviewRounds) patch.maxReviewRounds = form.maxReviewRounds;
  if (form.maxBudgetUsd !== project.maxBudgetUsd) patch.maxBudgetUsd = form.maxBudgetUsd;
  return patch;
}

function budgetInputValue(value: number | null): string {
  return value === null ? "" : String(value);
}

function parseBudgetInput(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

interface ProjectFieldsProps {
  form: CreateProjectInput;
  onChange: (form: CreateProjectInput) => void;
  errors: FieldErrors;
  idPrefix: string;
}

function ProjectFields({ form, onChange, errors, idPrefix }: ProjectFieldsProps) {
  return (
    <>
      <div className="field">
        <label>
          Key
          <input value={form.key} onChange={(event) => onChange({ ...form, key: event.target.value })} />
        </label>
        {errors.key && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-key`}>
            {errors.key}
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
          Jira JQL
          <input value={form.jiraJql} onChange={(event) => onChange({ ...form, jiraJql: event.target.value })} />
        </label>
        <p className="field__help">The query used to import tickets for this project.</p>
        {errors.jiraJql && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-jiraJql`}>
            {errors.jiraJql}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Max infra retries
          <input
            type="number"
            value={form.maxInfraRetries}
            onChange={(event) => onChange({ ...form, maxInfraRetries: Number(event.target.value) })}
          />
        </label>
        <p className="field__help">Non-negative integer.</p>
        {errors.maxInfraRetries && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-maxInfraRetries`}>
            {errors.maxInfraRetries}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Max protocol retries
          <input
            type="number"
            value={form.maxProtocolRetries}
            onChange={(event) => onChange({ ...form, maxProtocolRetries: Number(event.target.value) })}
          />
        </label>
        <p className="field__help">Non-negative integer.</p>
        {errors.maxProtocolRetries && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-maxProtocolRetries`}>
            {errors.maxProtocolRetries}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Max CI rounds
          <input
            type="number"
            value={form.maxCiRounds}
            onChange={(event) => onChange({ ...form, maxCiRounds: Number(event.target.value) })}
          />
        </label>
        <p className="field__help">Non-negative integer.</p>
        {errors.maxCiRounds && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-maxCiRounds`}>
            {errors.maxCiRounds}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Max review rounds
          <input
            type="number"
            value={form.maxReviewRounds}
            onChange={(event) => onChange({ ...form, maxReviewRounds: Number(event.target.value) })}
          />
        </label>
        <p className="field__help">Non-negative integer.</p>
        {errors.maxReviewRounds && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-maxReviewRounds`}>
            {errors.maxReviewRounds}
          </span>
        )}
      </div>
      <div className="field">
        <label>
          Max budget USD
          <input
            type="number"
            value={budgetInputValue(form.maxBudgetUsd)}
            onChange={(event) => onChange({ ...form, maxBudgetUsd: parseBudgetInput(event.target.value) })}
          />
        </label>
        <p className="field__help">Leave blank for no cap.</p>
        {errors.maxBudgetUsd && (
          <span className="field__error" role="alert" data-testid={`${idPrefix}-error-maxBudgetUsd`}>
            {errors.maxBudgetUsd}
          </span>
        )}
      </div>
    </>
  );
}

/**
 * Projects panel (design.md §14 Admin row, §12.5 `/projects`, task
 * contract GOT.29; restyled by U5): list plus a create form and a per-row
 * edit form for every field the api accepts, with client-side validation
 * mirroring `apps/api/src/routes/projects.ts` and the api's 400/409
 * rendered inline.
 */
export function ProjectsPanel({ adminApi }: ProjectsPanelProps) {
  const { begin, isCurrent } = useLatestRequest();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<CreateProjectInput>(EMPTY_FORM);
  const [createErrors, setCreateErrors] = useState<FieldErrors>({});
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<CreateProjectInput | null>(null);
  const [editErrors, setEditErrors] = useState<FieldErrors>({});
  const [editError, setEditError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    const generation = begin();
    setLoadError(null);
    try {
      const rows = await adminApi.listProjects();
      if (!isCurrent(generation)) return;
      setProjects(rows);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setProjects(null);
      setLoadError(describeApiError(err, "Failed to load projects."));
    }
  }, [adminApi, begin, isCurrent]);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const errors = validateProjectInput(createForm);
    setCreateErrors(errors);
    setCreateError(null);
    if (Object.keys(errors).length > 0) return;
    try {
      await adminApi.createProject(createForm);
      setCreateForm(EMPTY_FORM);
      await fetchProjects();
    } catch (err) {
      setCreateError(describeApiError(err, "Failed to create the project."));
    }
  }

  function startEdit(project: Project) {
    setEditingId(project.id);
    setEditForm(toFormValues(project));
    setEditErrors({});
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setEditErrors({});
    setEditError(null);
  }

  async function handleSaveEdit(event: FormEvent, project: Project) {
    event.preventDefault();
    if (!editForm) return;
    const errors = validateProjectInput(editForm);
    setEditErrors(errors);
    setEditError(null);
    if (Object.keys(errors).length > 0) return;
    try {
      await adminApi.patchProject(project.id, diffProject(project, editForm));
      cancelEdit();
      await fetchProjects();
    } catch (err) {
      setEditError(describeApiError(err, "Failed to update the project."));
    }
  }

  return (
    <section aria-label="Projects">
      <h2>Projects</h2>

      <div className="admin-panel__table">
        {loadError && (
          <p className="alert alert--error" role="alert">
            {loadError}
          </p>
        )}
        {!loadError && projects === null && <p>Loading...</p>}
        {projects && projects.length === 0 && (
          <div className="empty-state">
            <p>No projects yet.</p>
          </div>
        )}
        {projects && projects.length > 0 && (
          <table>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Name</th>
                <th scope="col">Jira JQL</th>
                <th scope="col" className="num">
                  Infra retries
                </th>
                <th scope="col" className="num">
                  Protocol retries
                </th>
                <th scope="col" className="num">
                  CI rounds
                </th>
                <th scope="col" className="num">
                  Review rounds
                </th>
                <th scope="col" className="num">
                  Budget USD
                </th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) =>
                editingId === project.id && editForm ? (
                  <tr key={project.id}>
                    <td colSpan={9}>
                      <div className="card">
                        <h3>Edit project</h3>
                        <form
                          aria-label={`Edit ${project.key}`}
                          className="form-grid"
                          onSubmit={(event) => void handleSaveEdit(event, project)}
                        >
                          <ProjectFields form={editForm} onChange={setEditForm} errors={editErrors} idPrefix="edit" />
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
                  <tr key={project.id}>
                    <td>{project.key}</td>
                    <td>{project.name}</td>
                    <td>
                      <span className="admin-table__mono" title={project.jiraJql}>
                        {project.jiraJql}
                      </span>
                    </td>
                    <td className="num">{project.maxInfraRetries}</td>
                    <td className="num">{project.maxProtocolRetries}</td>
                    <td className="num">{project.maxCiRounds}</td>
                    <td className="num">{project.maxReviewRounds}</td>
                    <td className="num">{project.maxBudgetUsd ?? "—"}</td>
                    <td>
                      <button type="button" className="admin-table__action" onClick={() => startEdit(project)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Create project</h3>
        <form aria-label="Create project" className="form-grid" onSubmit={(event) => void handleCreate(event)}>
          <ProjectFields form={createForm} onChange={setCreateForm} errors={createErrors} idPrefix="create" />
          {createError && (
            <p className="alert alert--error form-grid__full" role="alert" data-testid="create-error">
              {createError}
            </p>
          )}
          <div className="form-grid__full admin-form__actions">
            <button type="submit" className="primary">
              Create project
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
