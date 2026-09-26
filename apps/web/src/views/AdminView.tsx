import { useMemo, useState } from "react";
import { ProjectsPanel } from "../admin/ProjectsPanel.js";
import { RepositoriesPanel } from "../admin/RepositoriesPanel.js";
import { UsersPanel } from "../admin/UsersPanel.js";
import { WorkersPanel } from "../admin/WorkersPanel.js";
import { createAdminApi, type AdminApi } from "../api/admin.js";
import { createApiClient, type ApiClient } from "../api/client.js";

export interface AdminViewProps {
  /** Injectable for tests; defaults to a real `createApiClient()`'s `request`. */
  request?: ApiClient["request"];
}

type Tab = "projects" | "repositories" | "users" | "workers";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "projects", label: "Projects" },
  { id: "repositories", label: "Repositories" },
  { id: "users", label: "Users" },
  { id: "workers", label: "Workers" },
];

/**
 * Admin (design.md §14 Admin row, §12.5, task contract GOT.29): projects,
 * repositories, users, and workers with heartbeat age and slots. Replaces
 * the GOT.29 placeholder.
 *
 * Only the active tab's panel is mounted, so a panel's polling (the
 * workers panel's 30s refetch) and per-panel state only exist while that
 * tab is visible.
 */
export function AdminView({ request }: AdminViewProps = {}) {
  const adminApi: AdminApi = useMemo(() => createAdminApi(request ?? createApiClient().request), [request]);
  const [tab, setTab] = useState<Tab>("projects");

  return (
    <main>
      <h1>Admin</h1>
      <nav aria-label="Admin sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "projects" && <ProjectsPanel adminApi={adminApi} />}
      {tab === "repositories" && <RepositoriesPanel adminApi={adminApi} />}
      {tab === "users" && <UsersPanel adminApi={adminApi} />}
      {tab === "workers" && <WorkersPanel adminApi={adminApi} />}
    </main>
  );
}
