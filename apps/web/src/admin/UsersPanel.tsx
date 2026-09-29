import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminApi, AdminUser, CreateUserInput } from "../api/admin.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { Time } from "../ui/Time.js";
import { describeApiError } from "./format.js";
import { validateDisplayName, validateUserInput, type FieldErrors } from "./validation.js";

export interface UsersPanelProps {
  adminApi: AdminApi;
}

const EMPTY_FORM: CreateUserInput = { email: "", password: "", displayName: "" };

/**
 * Users panel (design.md §13 no self-registration, §14 Admin row, §12.5
 * `/users`, task contract GOT.29; restyled by U5): list, a create form, a
 * display-name edit per row, and a Disable/Enable toggle per row (GOT.61).
 * Disabling asks for confirmation first (it logs the user out and blocks
 * their login); re-enabling does not. The caller's own row can never be
 * toggled -- `request.user!.id === request.params.id` is a route-level
 * 409 (`apps/api/src/routes/users.ts`), so the button is disabled here
 * too rather than letting the click round-trip for nothing. `currentUserId`
 * comes from `adminApi.getCurrentUser()` (`GET /auth/me`) rather than
 * `SessionProvider`'s context: `AdminView.tsx` (another task's forbidden
 * path) mounts this panel outside any `SessionProvider` in its own tests,
 * so this panel fetches it independently instead of widening that context.
 * A failure to load it (or GOT.61 predates GOT.29) just leaves every
 * toggle enabled; the route's own 409 still refuses a self-disable.
 */
export function UsersPanel({ adminApi }: UsersPanelProps) {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
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

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<{ id: string; message: string } | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    adminApi
      .getCurrentUser?.()
      .then((me) => {
        if (!cancelled) setCurrentUserId(me.id);
      })
      .catch(() => {
        // Leaves every toggle enabled; the route's own 409 still refuses a
        // self-disable (see the class doc comment above).
      });
    return () => {
      cancelled = true;
    };
  }, [adminApi]);

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

  /**
   * Disabling confirms first (it ends the user's sessions and blocks their
   * login); re-enabling does not. Cancelling the browser confirm does
   * nothing, matching `RepositoriesPanel.tsx`'s delete pattern.
   */
  async function handleToggle(user: AdminUser) {
    const nextDisabled = user.disabledAt === null;
    if (nextDisabled && !window.confirm(`Disable ${user.email}? They will be signed out and unable to log in.`)) {
      return;
    }
    setTogglingId(user.id);
    setToggleError(null);
    try {
      await adminApi.patchUser(user.id, { disabled: nextDisabled });
      await fetchUsers();
    } catch (err) {
      setToggleError({ id: user.id, message: describeApiError(err, "Failed to update the user.") });
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <section aria-label="Users">
      <h2>Users</h2>

      <div className="admin-panel__table">
        {loadError && (
          <p className="alert alert--error" role="alert">
            {loadError}
          </p>
        )}
        {!loadError && users === null && <p>Loading...</p>}
        {users && users.length === 0 && (
          <div className="empty-state">
            <p>No users yet.</p>
          </div>
        )}
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
                      <div className="card">
                        <h3>Edit user</h3>
                        <form
                          aria-label={`Edit ${user.email}`}
                          className="form-grid"
                          onSubmit={(event) => void handleSaveEdit(event, user)}
                        >
                          <div className="field">
                            <label>
                              Display name
                              <input
                                value={editDisplayName}
                                onChange={(event) => setEditDisplayName(event.target.value)}
                              />
                            </label>
                            {editErrors.displayName && (
                              <span className="field__error" role="alert" data-testid="edit-error-displayName">
                                {editErrors.displayName}
                              </span>
                            )}
                          </div>
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
                  <tr key={user.id}>
                    <td>{user.email}</td>
                    <td>{user.displayName}</td>
                    <td>
                      <Time value={user.createdAt} />
                    </td>
                    <td>
                      <span className={user.disabledAt ? "badge badge--neutral" : "badge badge--success"}>
                        {user.disabledAt ? "Disabled" : "Active"}
                      </span>
                    </td>
                    <td>
                      <button type="button" className="admin-table__action" onClick={() => startEdit(user)}>
                        Edit
                      </button>{" "}
                      <button
                        type="button"
                        className="admin-table__action"
                        aria-label={`${user.disabledAt ? "Enable" : "Disable"} ${user.email}`}
                        disabled={togglingId === user.id || user.id === currentUserId}
                        title={user.id === currentUserId ? "You cannot disable your own account." : undefined}
                        onClick={() => void handleToggle(user)}
                      >
                        {user.disabledAt ? "Enable" : "Disable"}
                      </button>
                    </td>
                  </tr>
                ),
              )}
              {toggleError && (
                <tr key={`${toggleError.id}-toggle-error`}>
                  <td colSpan={5}>
                    <p
                      className="alert alert--error"
                      role="alert"
                      data-testid={`toggle-error-${toggleError.id}`}
                    >
                      {toggleError.message}
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Create user</h3>
        <form aria-label="Create user" className="form-grid" onSubmit={(event) => void handleCreate(event)}>
          <div className="field">
            <label>
              Email
              <input
                type="email"
                value={createForm.email}
                onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })}
              />
            </label>
            {createErrors.email && (
              <span className="field__error" role="alert" data-testid="create-error-email">
                {createErrors.email}
              </span>
            )}
          </div>
          <div className="field">
            <label>
              Display name
              <input
                value={createForm.displayName}
                onChange={(event) => setCreateForm({ ...createForm, displayName: event.target.value })}
              />
            </label>
            {createErrors.displayName && (
              <span className="field__error" role="alert" data-testid="create-error-displayName">
                {createErrors.displayName}
              </span>
            )}
          </div>
          <div className="field">
            <label>
              Password
              <input
                type="password"
                value={createForm.password}
                onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })}
              />
            </label>
            {createErrors.password && (
              <span className="field__error" role="alert" data-testid="create-error-password">
                {createErrors.password}
              </span>
            )}
          </div>
          {createError && (
            <p className="alert alert--error form-grid__full" role="alert" data-testid="create-error">
              {createError}
            </p>
          )}
          <div className="form-grid__full admin-form__actions">
            <button type="submit" className="primary">
              Create user
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
