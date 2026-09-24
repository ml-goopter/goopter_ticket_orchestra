import { z } from "zod";

/**
 * `POST /auth/login` and `GET /auth/me` both resolve to this shape
 * (apps/api/src/routes/auth.ts, design.md §12.1).
 */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
});
export type User = z.infer<typeof UserSchema>;

const HealthSchema = z.object({ status: z.string() });

/**
 * Every api error resolves to `{ error: { code, message } }`
 * (apps/api/src/lib/errors.ts). Thrown by `request()` for any non-2xx
 * response so callers can branch on `code` without re-parsing the body.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export type FetchLike = typeof fetch;

export interface ApiClientOptions {
  /** Defaults to "/api"; the dev server proxies that to the api (vite.config.ts). */
  baseUrl?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export interface RequestOptions<T> {
  body?: unknown;
  /** When supplied, the parsed JSON body is validated (and typed) against it. */
  schema?: z.ZodType<T>;
}

export interface ApiClient {
  request<T>(
    method: string,
    path: string,
    options?: RequestOptions<T>,
  ): Promise<T>;
  login(email: string, password: string): Promise<User>;
  logout(): Promise<void>;
  me(): Promise<User>;
  health(): Promise<{ status: string }>;
}

/**
 * Typed wrapper around the api (design.md §12.1). Cookies are httpOnly, so
 * every request is sent with `credentials: "include"` and the caller never
 * touches the session cookie directly (design.md §13).
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "/api";
  const fetchImpl = options.fetch ?? fetch;

  async function request<T>(
    method: string,
    path: string,
    requestOptions: RequestOptions<T> = {},
  ): Promise<T> {
    const { body, schema } = requestOptions;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      credentials: "include",
      headers:
        body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsedError = ErrorBodySchema.safeParse(json);
      if (parsedError.success) {
        throw new ApiError(
          response.status,
          parsedError.data.error.code,
          parsedError.data.error.message,
        );
      }
      throw new ApiError(
        response.status,
        "UNKNOWN_ERROR",
        `Request failed with status ${response.status}.`,
      );
    }

    return schema ? schema.parse(json) : (json as T);
  }

  return {
    request,
    login: (email, password) =>
      request<User>("POST", "/auth/login", {
        body: { email, password },
        schema: UserSchema,
      }),
    logout: () => request<void>("POST", "/auth/logout"),
    me: () => request<User>("GET", "/auth/me", { schema: UserSchema }),
    health: () =>
      request<{ status: string }>("GET", "/health", { schema: HealthSchema }),
  };
}
