import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";
import { useSession } from "./auth/SessionProvider.js";
import { AppLayout } from "./layout/AppLayout.js";
import { AdminView } from "./views/AdminView.js";
import { BoardView } from "./views/BoardView.js";
import { CostsView } from "./views/CostsView.js";
import { IssueDetailView } from "./views/IssueDetailView.js";
import { LoginPage } from "./views/LoginPage.js";
import { SpecBuilderView } from "./views/SpecBuilderView.js";
import { TaskDetailView } from "./views/TaskDetailView.js";

/**
 * Redirects an anonymous visitor to `/login?next=<path>`; renders nothing
 * while the session is still bootstrapping so the login page never flashes
 * for an about-to-be-authenticated user (design.md §12.1).
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();

  if (status === "loading") {
    return null;
  }
  if (status === "anonymous") {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

/** Redirects an already-authenticated visitor away from `/login`. */
function LoginRoute() {
  const { status } = useSession();
  const [searchParams] = useSearchParams();

  if (status === "loading") {
    return null;
  }
  if (status === "authenticated") {
    return <Navigate to={searchParams.get("next") ?? "/"} replace />;
  }
  return <LoginPage />;
}

/**
 * Route table (design.md §14). Every view besides `/login` is a placeholder
 * until its build-order task replaces it.
 */
export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<BoardView />} />
        <Route path="/tasks/:id" element={<TaskDetailView />} />
        <Route path="/tasks/:id/spec" element={<SpecBuilderView />} />
        <Route path="/issues/:id" element={<IssueDetailView />} />
        <Route path="/admin" element={<AdminView />} />
        <Route path="/costs" element={<CostsView />} />
      </Route>
    </Routes>
  );
}
