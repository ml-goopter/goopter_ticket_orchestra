import { useId, useMemo, useState } from "react";
import "../admin/admin.css";
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
 * Admin (design.md §14 Admin row, §12.5, task contract GOT.29; restyled by
 * U5): projects, repositories, users, and workers with heartbeat age and
 * slots, behind an accessible tablist (WAI-ARIA APG tabs pattern -- role
 * `tablist`/`tab`/`tabpanel`, `aria-selected` on the active tab).
 *
 * Only the active tab's panel is mounted, so a panel's polling (the
 * workers panel's 30s refetch) and per-panel state only exist while that
 * tab is visible.
 */
export function AdminView({ request }: AdminViewProps = {}) {
  const adminApi: AdminApi = useMemo(() => createAdminApi(request ?? createApiClient().request), [request]);
  const [tab, setTab] = useState<Tab>("projects");
  const baseId = useId();

  return (
    <>
      <div className="page-header">
        <h1 className="page-header__title">Admin</h1>
      </div>

      <div className="tabs" role="tablist" aria-label="Admin sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-panel-${t.id}`}
            className={tab === t.id ? "tabs__tab tabs__tab--active" : "tabs__tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {TABS.filter((t) => t.id === tab).map((t) => (
        <div key={t.id} role="tabpanel" id={`${baseId}-panel-${t.id}`} aria-labelledby={`${baseId}-tab-${t.id}`}>
          {t.id === "projects" && <ProjectsPanel adminApi={adminApi} />}
          {t.id === "repositories" && <RepositoriesPanel adminApi={adminApi} />}
          {t.id === "users" && <UsersPanel adminApi={adminApi} />}
          {t.id === "workers" && <WorkersPanel adminApi={adminApi} />}
        </div>
      ))}
    </>
  );
}
