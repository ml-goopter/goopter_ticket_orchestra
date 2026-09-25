import { z } from "zod";
import {
  IssueSchema,
  NotificationSchema,
  TaskAggregateSchema,
  TaskCardSchema,
  TaskTransitionResultSchema,
  TimelinePageSchema,
  type Issue,
  type Notification,
  type TaskAggregate,
  type TaskCard,
  type TaskTransitionResult,
  type TimelinePage,
} from "./types.js";

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
 * Builds a leading `?a=b&c=d` query string, omitting any key whose value
 * is `undefined` -- so an unset filter contributes nothing to the path
 * rather than an empty `key=` pair.
 */
function buildQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export interface ListTasksOptions {
  /** `true` sends `?attention=1` (design.md §12.2); omitted otherwise. */
  attention?: boolean;
}

export interface ListIssuesOptions {
  status?: string;
  blocking?: boolean;
}

export interface GetTimelineOptions {
  /** Exclusive lower bound: the last event id already loaded. */
  after?: number;
  limit?: number;
}

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
 * The board and attention drawer's view of the api (GOT.36), kept as its
 * own interface rather than widening `ApiClient` itself: `ApiClient` is
 * the type every other view's tests mock against (e.g.
 * `SessionProvider.test.tsx`, `router.test.tsx`), and adding required
 * methods there would force an unrelated edit to files outside this
 * task's `owned_paths`. `createApiClient()` implements both.
 */
export interface BoardApiClient extends ApiClient {
  listTasks(options?: ListTasksOptions): Promise<TaskCard[]>;
  listIssues(options?: ListIssuesOptions): Promise<Issue[]>;
  listNotifications(): Promise<Notification[]>;
  markNotificationRead(id: string): Promise<Notification>;
  /** `GET /tasks/:id` (design.md §12.2), the task detail aggregate. */
  getTask(id: string): Promise<TaskAggregate>;
  /** `GET /tasks/:id/timeline?after=&limit=` (design.md §12.2, §12.6). */
  getTimeline(id: string, options?: GetTimelineOptions): Promise<TimelinePage>;
  /** `POST /tasks/:id/cancel` (design.md §12.2). */
  cancelTask(id: string): Promise<TaskTransitionResult>;
  /** `POST /tasks/:id/retry`, only legal from `NEEDS_HUMAN` (design.md §12.2). */
  retryTask(id: string): Promise<TaskTransitionResult>;
}

/**
 * Typed wrapper around the api (design.md §12.1). Cookies are httpOnly, so
 * every request is sent with `credentials: "include"` and the caller never
 * touches the session cookie directly (design.md §13).
 */
export function createApiClient(options: ApiClientOptions = {}): BoardApiClient {
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
    listTasks: (options = {}) =>
      request<TaskCard[]>(
        "GET",
        `/tasks${buildQuery({ attention: options.attention ? "1" : undefined })}`,
        { schema: z.array(TaskCardSchema) },
      ),
    listIssues: (options = {}) =>
      request<Issue[]>(
        "GET",
        `/issues${buildQuery({
          status: options.status,
          blocking: options.blocking === undefined ? undefined : options.blocking ? "1" : "0",
        })}`,
        { schema: z.array(IssueSchema) },
      ),
    listNotifications: () =>
      request<Notification[]>("GET", "/notifications", { schema: z.array(NotificationSchema) }),
    markNotificationRead: (id) =>
      request<Notification>("POST", `/notifications/${id}/read`, { schema: NotificationSchema }),
    getTask: (id) =>
      request<TaskAggregate>("GET", `/tasks/${id}`, { schema: TaskAggregateSchema }),
    getTimeline: (id, options = {}) =>
      request<TimelinePage>(
        "GET",
        `/tasks/${id}/timeline${buildQuery({
          after: options.after === undefined ? undefined : String(options.after),
          limit: options.limit === undefined ? undefined : String(options.limit),
        })}`,
        { schema: TimelinePageSchema },
      ),
    cancelTask: (id) =>
      request<TaskTransitionResult>("POST", `/tasks/${id}/cancel`, {
        schema: TaskTransitionResultSchema,
      }),
    retryTask: (id) =>
      request<TaskTransitionResult>("POST", `/tasks/${id}/retry`, {
        schema: TaskTransitionResultSchema,
      }),
  };
}
