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

  return (
    <div>
      <header>
        <span>Orchestra</span>
        <nav>
          <NavLink to="/">Board</NavLink>
          <NavLink to="/admin">Admin</NavLink>
          <NavLink to="/costs">Costs</NavLink>
        </nav>
        <div>
          {user && <span>{user.displayName}</span>}
          <button type="button" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      <div>
        <main>
          <Outlet />
        </main>
        <AttentionDrawer client={apiClient} />
      </div>
    </div>
  );
}
