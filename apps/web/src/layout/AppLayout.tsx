import { useMemo } from "react";
import { NavLink, Outlet } from "react-router";
import { createApiClient, type BoardApiClient } from "../api/client.js";
import { useSession } from "../auth/SessionProvider.js";
import { AttentionDrawer } from "./AttentionDrawer.js";

export interface AppLayoutProps {
  /** Injectable for tests, forwarded to `AttentionDrawer`; defaults to a real createApiClient(). */
  client?: BoardApiClient;
}

/**
 * Header, nav, and the persistent attention drawer, rendered around every
 * authenticated route (design.md §14). `RequireAuth` in router.tsx puts this
 * only where `status === "authenticated"`, so `user` is always set here.
 */
export function AppLayout({ client }: AppLayoutProps = {}) {
  const { user, logout } = useSession();
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);

  const navLinkClassName = ({ isActive }: { isActive: boolean }) =>
    `app-shell__nav-link${isActive ? " app-shell__nav-link--active" : ""}`;

  return (
    <div className="app-shell">
      <header className="app-shell__bar">
        <span className="app-shell__brand">Orchestra</span>
        <nav className="app-shell__nav">
          <NavLink to="/" end className={navLinkClassName}>
            Board
          </NavLink>
          <NavLink to="/admin" className={navLinkClassName}>
            Admin
          </NavLink>
          <NavLink to="/costs" className={navLinkClassName}>
            Costs
          </NavLink>
        </nav>
        <AttentionDrawer client={apiClient} />
        <div className="app-shell__user">
          {user && <span className="app-shell__user-name">{user.displayName}</span>}
          <button type="button" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      <div className="app-shell__main">
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
