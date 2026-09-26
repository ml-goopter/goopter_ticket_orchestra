import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminApi, AdminUser, CreateUserInput } from "../api/admin.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { describeApiError } from "./format.js";
import { validateDisplayName, validateUserInput, type FieldErrors } from "./validation.js";

export interface UsersPanelProps {
  adminApi: AdminApi;
}

const EMPTY_FORM: CreateUserInput = { email: "", password: "", displayName: "" };

/**
 * Users panel (design.md §13 no self-registration, §14 Admin row, §12.5
 * `/users`, task contract GOT.29): list, a create form, and a display-name
 * edit per row. No disable/re-enable control -- `PatchUserSchema` in
 * `apps/api/src/routes/users.ts` accepts only `display_name` (a prior
 * review round dropped `disabled` from the route), so the disabled state
 * is shown read-only, in case the CLI or a future route sets it (GOT.29
 * descope, coordinator C40).
 */
export function UsersPanel({ adminApi }: UsersPanelProps) {
  const { begin, isCurrent } = useLatestRequest();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<CreateUserInput>(EMPTY_FORM);
  const [createErrors, setCreateErrors] = useState<FieldErrors>({});
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editErrors, setEditErrors] = useState<FieldErrors>({});
  const [editError, setEditError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    const generation = begin();
    setLoadError(null);
    try {
      const rows = await adminApi.listUsers();
      if (!isCurrent(generation)) return;
      setUsers(rows);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setUsers(null);
      setLoadError(describeApiError(err, "Failed to load users."));
    }
  }, [adminApi, begin, isCurrent]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const errors = validateUserInput(createForm);
    setCreateErrors(errors);
    setCreateError(null);
    if (Object.keys(errors).length > 0) return;
    try {
      await adminApi.createUser(createForm);
      setCreateForm(EMPTY_FORM);
      await fetchUsers();
    } catch (err) {
      setCreateError(describeApiError(err, "Failed to create the user."));
    }
  }

  function startEdit(user: AdminUser) {
    setEditingId(user.id);
    setEditDisplayName(user.displayName);
    setEditErrors({});
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDisplayName("");
    setEditErrors({});
    setEditError(null);
  }

  async function handleSaveEdit(event: FormEvent, user: AdminUser) {
    event.preventDefault();
    const errors = validateDisplayName(editDisplayName);
    setEditErrors(errors);
    setEditError(null);
    if (Object.keys(errors).length > 0) return;
    try {
      await adminApi.patchUser(user.id, { displayName: editDisplayName });
      cancelEdit();
      await fetchUsers();
    } catch (err) {
      setEditError(describeApiError(err, "Failed to update the user."));
    }
  }

  return (
    <section aria-label="Users">
      <h2>Users</h2>

      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && users === null && <p>Loading...</p>}
      {users && users.length === 0 && <p>No users yet.</p>}
      {users && users.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Display name</th>
              <th scope="col">Created</th>
              <th scope="col">State</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) =>
              editingId === user.id ? (
                <tr key={user.id}>
                  <td colSpan={5}>
                    <form aria-label={`Edit ${user.email}`} onSubmit={(event) => void handleSaveEdit(event, user)}>
                      <label>
                        Display name
                        <input value={editDisplayName} onChange={(event) => setEditDisplayName(event.target.value)} />
                      </label>
                      {editErrors.displayName && (
                        <span role="alert" data-testid="edit-error-displayName">
                          {editErrors.displayName}
                        </span>
                      )}
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
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>{user.displayName}</td>
                  <td>{user.createdAt}</td>
                  <td>{user.disabledAt ? "Disabled" : "Active"}</td>
                  <td>
                    <button type="button" onClick={() => startEdit(user)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      <form aria-label="Create user" onSubmit={(event) => void handleCreate(event)}>
        <h3>Create user</h3>
        <label>
          Email
          <input
            type="email"
            value={createForm.email}
            onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })}
          />
        </label>
        {createErrors.email && (
          <span role="alert" data-testid="create-error-email">
            {createErrors.email}
          </span>
        )}
        <label>
          Display name
          <input
            value={createForm.displayName}
            onChange={(event) => setCreateForm({ ...createForm, displayName: event.target.value })}
          />
        </label>
        {createErrors.displayName && (
          <span role="alert" data-testid="create-error-displayName">
            {createErrors.displayName}
          </span>
        )}
        <label>
          Password
          <input
            type="password"
            value={createForm.password}
            onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })}
          />
        </label>
        {createErrors.password && (
          <span role="alert" data-testid="create-error-password">
            {createErrors.password}
          </span>
        )}
        {createError && (
          <p role="alert" data-testid="create-error">
            {createError}
          </p>
        )}
        <button type="submit">Create user</button>
      </form>
    </section>
  );
}
