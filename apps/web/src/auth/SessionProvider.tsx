import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiError, createApiClient, type ApiClient, type User } from "../api/client.js";

export type SessionStatus = "loading" | "anonymous" | "authenticated";

export interface SessionContextValue {
  status: SessionStatus;
  user: User | null;
  /** Message from the last failed `login()` call, cleared on the next attempt. */
  error: string | null;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export interface SessionProviderProps {
  children: ReactNode;
  /** Injectable for tests; defaults to a real `createApiClient()`. */
  client?: ApiClient;
}

/**
 * Bootstraps the session by calling `GET /auth/me` on mount (design.md
 * §12.1, §13) and exposes the result via context. Anonymous is any `me()`
 * failure, not only 401, since the client has no other action to take.
 */
export function SessionProvider({ children, client }: SessionProviderProps) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .me()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setStatus("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        const me = await apiClient.login(email, password);
        setUser(me);
        setStatus("authenticated");
      } catch (err) {
        setUser(null);
        setStatus("anonymous");
        setError(err instanceof ApiError ? err.message : "Login failed.");
      }
    },
    [apiClient],
  );

  const logout = useCallback(async () => {
    await apiClient.logout();
    setUser(null);
    setStatus("anonymous");
  }, [apiClient]);

  const value = useMemo<SessionContextValue>(
    () => ({ status, user, error, login, logout }),
    [status, user, error, login, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return value;
}
