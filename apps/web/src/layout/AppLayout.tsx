import { useCallback, useMemo, useRef, useState, type MouseEvent } from "react";
import { NavLink, Outlet } from "react-router";
import { createApiClient, type BoardApiClient } from "../api/client.js";
import { useSession } from "../auth/SessionProvider.js";
import {
  AttentionDrawer,
  ZERO_ATTENTION_COUNTS,
  type AttentionCounts,
  type AttentionDrawerHandle,
  type AttentionSection,
} from "./AttentionDrawer.js";

export interface AppLayoutProps {
  /** Injectable for tests, forwarded to `AttentionDrawer`; defaults to a real createApiClient(). */
  client?: BoardApiClient;
  /** Injectable for tests, forwarded to `AttentionDrawer`. */
  now?: Date;
}

const ATTENTION_SUB_SECTIONS: ReadonlyArray<{ key: AttentionSection; label: string }> = [
  { key: "blocking", label: "Blocking issues" },
  { key: "specReviews", label: "Spec reviews" },
  { key: "needsHuman", label: "Needs human" },
  { key: "readyForMerge", label: "Ready for merge" },
  { key: "unread", label: "Unread" },
];

/**
 * Left sidebar, the persistent attention panel, and the page area
 * (design.md §14), rendered around every authenticated route. `RequireAuth`
 * in router.tsx puts this only where `status === "authenticated"`, so
 * `user` is always set here.
 */
export function AppLayout({ client, now }: AppLayoutProps = {}) {
  const { user, logout } = useSession();
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const [counts, setCounts] = useState<AttentionCounts>(ZERO_ATTENTION_COUNTS);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const panelRef = useRef<AttentionDrawerHandle | null>(null);

  const navLinkClassName = ({ isActive }: { isActive: boolean }) =>
    `sidebar__nav-item${isActive ? " sidebar__nav-item--active" : ""}`;

  const openAttention = useCallback(
    (section?: AttentionSection) => (event: MouseEvent<HTMLButtonElement>) => {
      panelRef.current?.open(section, event.currentTarget);
    },
    [],
  );

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Primary">
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark">O</span>
          Orchestra
        </div>

        <button
          type="button"
          className="sidebar__nav-item"
          aria-haspopup="dialog"
          aria-expanded={attentionOpen}
          onClick={openAttention()}
        >
          Attention
          <span className="badge badge--attention sidebar__nav-count" data-testid="attention-count">
            {counts.total}
          </span>
        </button>
        <div className="sidebar__sub-nav">
          {ATTENTION_SUB_SECTIONS.map((section) => (
            <button
              key={section.key}
              type="button"
              className="sidebar__sub-item"
              aria-haspopup="dialog"
              onClick={openAttention(section.key)}
            >
              {section.label}
              <span className="sidebar__sub-item-count" data-testid={`attention-count-${section.key}`}>
                {counts[section.key]}
              </span>
            </button>
          ))}
        </div>

        <div className="sidebar__nav-label">Workspace</div>
        <NavLink to="/" end className={navLinkClassName}>
          Board
        </NavLink>
        <NavLink to="/costs" className={navLinkClassName}>
          Costs
        </NavLink>
        <NavLink to="/admin" className={navLinkClassName}>
          Admin
        </NavLink>

        <div className="sidebar__foot">
          {user && <span className="sidebar__user-name">{user.displayName}</span>}
          <button type="button" className="sidebar__logout" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </nav>

      <div className="app-shell__main">
        <main className="page">
          <Outlet />
        </main>
      </div>

      <AttentionDrawer
        ref={panelRef}
        client={apiClient}
        onCountsChange={setCounts}
        onOpenChange={setAttentionOpen}
        now={now}
      />
    </div>
  );
}
