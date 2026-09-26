import type { ResolutionKind, Runtime, SpecContent } from "@orchestra/core";
import { z } from "zod";
import {
  AdminRepositorySchema,
  IssueDetailSchema,
  IssueSchema,
  NotificationSchema,
  PostIssueMessageResultSchema,
  ResolveIssueResultSchema,
  SpecDraftResultSchema,
  SpecMessageResultSchema,
  SpecRevisionTransitionResultSchema,
  TaskAggregateSchema,
  TaskCardSchema,
  TaskTransitionResultSchema,
  TimelinePageSchema,
  type AdminRepository,
  type Issue,
  type IssueDetail,
  type Notification,
  type PostIssueMessageResult,
  type ResolveIssueResult,
  type SpecDraftResult,
  type SpecMessageResult,
  type SpecRevisionTransitionResult,
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

export interface ResolveIssueInput {
  kind: ResolutionKind;
  decision: string;
  clarification?: string;
  chosenOption?: string;
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
 * The issue detail view's extension of `BoardApiClient` (GOT.42), kept as
 * its own interface for the same reason `BoardApiClient` is kept separate
 * from `ApiClient` above: `BoardApiClient` is the type
 * `TaskDetailView.test.tsx`'s inline fake is annotated with, and that file
 * is outside this task's `owned_paths`, so widening `BoardApiClient`
 * itself would force an edit there. `createApiClient()` implements both.
 */
export interface IssueApiClient extends BoardApiClient {
  /** `GET /issues/:id` (design.md §12.4), the issue detail aggregate. */
  getIssue(id: string): Promise<IssueDetail>;
  /** `POST /issues/:id/messages` (design.md §10.2, §12.4). */
  postIssueMessage(id: string, text: string): Promise<PostIssueMessageResult>;
  /** `POST /issues/:id/resolve` (design.md §10.3, §10.4, §12.4). */
  resolveIssue(id: string, input: ResolveIssueInput): Promise<ResolveIssueResult>;
}

/**
 * The spec builder's view of the api (GOT.38, design.md §12.3), layered on
 * `IssueApiClient` the same way that interface is kept separate from
 * `BoardApiClient` above: its own interface so extending it does not force
 * an edit to `IssueApiClient` or the views typed against it.
 * `createApiClient()` implements all three.
 */
export interface SpecApiClient extends IssueApiClient {
  /**
   * `GET /repositories?project=` (design.md §12.5), scoped to one project.
   * The task aggregate carries only the task's own assigned repository
   * (null before approval), so the spec builder's repository-exists check
   * (design.md §4.3) needs this separate list of the task's project's
   * repositories.
   */
  listProjectRepositories(projectId: string): Promise<AdminRepository[]>;
  /** `POST /tasks/:id/spec/session` (design.md §12.3), only legal from `NEEDS_SPEC`. */
  startSpecSession(taskId: string): Promise<TaskTransitionResult>;
  /** `POST /tasks/:id/spec/messages` `{ text }` (design.md §12.3). */
  postSpecMessage(taskId: string, text: string): Promise<SpecMessageResult>;
  /** `PUT /tasks/:id/spec/draft` `{ content }` (design.md §12.3). */
  saveDraft(taskId: string, content: SpecContent): Promise<SpecDraftResult>;
  /** `POST /tasks/:id/spec/request-review` (design.md §12.3). */
  requestReview(taskId: string): Promise<TaskTransitionResult>;
  /** `POST /tasks/:id/spec/send-back` (design.md §12.3). */
  sendBack(taskId: string): Promise<TaskTransitionResult>;
  /** `POST /tasks/:id/spec/approve` `{ runtime? }` (design.md §12.3). */
  approveSpec(taskId: string, runtime?: Runtime): Promise<SpecRevisionTransitionResult>;
  /**
   * `POST /tasks/:id/spec/revise` (design.md §12.3), only legal from
   * `SPEC_APPROVED` or `READY`; 409 `DRAFT_EXISTS` when a draft already
   * exists (docs/build-order.md GOT.38 carry-forward note).
   */
  reviseSpec(taskId: string): Promise<SpecRevisionTransitionResult>;
}

/**
 * Typed wrapper around the api (design.md §12.1). Cookies are httpOnly, so
 * every request is sent with `credentials: "include"` and the caller never
 * touches the session cookie directly (design.md §13).
 */
export function createApiClient(options: ApiClientOptions = {}): SpecApiClient {
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
    getIssue: (id) =>
      request<IssueDetail>("GET", `/issues/${id}`, { schema: IssueDetailSchema }),
    postIssueMessage: (id, text) =>
      request<PostIssueMessageResult>("POST", `/issues/${id}/messages`, {
        body: { text },
        schema: PostIssueMessageResultSchema,
      }),
    resolveIssue: (id, input) =>
      request<ResolveIssueResult>("POST", `/issues/${id}/resolve`, {
        body: {
          kind: input.kind,
          decision: input.decision,
          clarification: input.clarification,
          chosen_option: input.chosenOption,
        },
        schema: ResolveIssueResultSchema,
      }),
    listProjectRepositories: (projectId) =>
      request<AdminRepository[]>(
        "GET",
        `/repositories${buildQuery({ project: projectId })}`,
        { schema: z.array(AdminRepositorySchema) },
      ),
    startSpecSession: (id) =>
      request<TaskTransitionResult>("POST", `/tasks/${id}/spec/session`, {
        schema: TaskTransitionResultSchema,
      }),
    postSpecMessage: (id, text) =>
      request<SpecMessageResult>("POST", `/tasks/${id}/spec/messages`, {
        body: { text },
        schema: SpecMessageResultSchema,
      }),
    saveDraft: (id, content) =>
      request<SpecDraftResult>("PUT", `/tasks/${id}/spec/draft`, {
        body: { content },
        schema: SpecDraftResultSchema,
      }),
    requestReview: (id) =>
      request<TaskTransitionResult>("POST", `/tasks/${id}/spec/request-review`, {
        schema: TaskTransitionResultSchema,
      }),
    sendBack: (id) =>
      request<TaskTransitionResult>("POST", `/tasks/${id}/spec/send-back`, {
        schema: TaskTransitionResultSchema,
      }),
    approveSpec: (id, runtime) =>
      request<SpecRevisionTransitionResult>("POST", `/tasks/${id}/spec/approve`, {
        body: runtime === undefined ? undefined : { runtime },
        schema: SpecRevisionTransitionResultSchema,
      }),
    reviseSpec: (id) =>
      request<SpecRevisionTransitionResult>("POST", `/tasks/${id}/spec/revise`, {
        schema: SpecRevisionTransitionResultSchema,
      }),
  };
}
