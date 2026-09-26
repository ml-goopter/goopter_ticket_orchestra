import { RuntimeSchema, type Runtime } from "@orchestra/core";
import { z } from "zod";
import type { ApiClient } from "./client.js";

/**
 * Standalone client for the admin routes -- `/projects`, `/repositories`,
 * `/users`, `/workers` (design.md §12.5, §14 Admin row, task contract
 * GOT.29). Kept out of `client.ts` / `types.ts` deliberately, the same as
 * `costs.ts`: those files are owned by a concurrently running task, so
 * this module only depends on the `request` function type and defines its
 * own schemas rather than widening either file.
 */

export interface Project {
  id: string;
  key: string;
  name: string;
  jiraJql: string;
  maxInfraRetries: number;
  maxProtocolRetries: number;
  maxCiRounds: number;
  maxReviewRounds: number;
  maxBudgetUsd: number | null;
  createdAt: string;
}

export interface CreateProjectInput {
  key: string;
  name: string;
  jiraJql: string;
  maxInfraRetries: number;
  maxProtocolRetries: number;
  maxCiRounds: number;
  maxReviewRounds: number;
  /** `null` stores no budget cap (api default). */
  maxBudgetUsd: number | null;
}

/** Only the keys present are sent; `apps/api`'s `PatchProjectSchema` is itself `.partial()`. */
export type PatchProjectInput = Partial<CreateProjectInput>;

export interface Repository {
  id: string;
  projectId: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  defaultRuntime: Runtime;
  defaultModel: string | null;
  maxConcurrentWorktrees: number;
  requiredCapability: string | null;
  setupCommand: string | null;
  testCommand: string | null;
  createdAt: string;
}

export interface CreateRepositoryInput {
  projectId: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  defaultRuntime: Runtime;
  defaultModel: string | null;
  maxConcurrentWorktrees: number;
  requiredCapability: string | null;
  setupCommand: string | null;
  testCommand: string | null;
}

export type PatchRepositoryInput = Partial<CreateRepositoryInput>;

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  /** Set by the CLI or a future route; no admin route sets this today. */
  disabledAt: string | null;
  createdAt: string;
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
}

/**
 * `apps/api/src/routes/users.ts`'s `PatchUserSchema` accepts only
 * `display_name`: a prior review round dropped `disabled` from the route
 * ("the design does not specify an api route for disabling users"), so
 * there is no field here for it either (GOT.29 descope, coordinator C40).
 */
export interface PatchUserInput {
  displayName?: string;
}

export interface Worker {
  id: string;
  host: string;
  capabilities: string[];
  maxConcurrent: number;
  workspaceRoot: string;
  lastHeartbeatAt: string;
  startedAt: string;
  heartbeatAgeSeconds: number;
  freeSlots: number;
}

export interface AdminApi {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  patchProject(id: string, patch: PatchProjectInput): Promise<Project>;
  listRepositories(projectId?: string): Promise<Repository[]>;
  createRepository(input: CreateRepositoryInput): Promise<Repository>;
  patchRepository(id: string, patch: PatchRepositoryInput): Promise<Repository>;
  listUsers(): Promise<AdminUser[]>;
  createUser(input: CreateUserInput): Promise<AdminUser>;
  patchUser(id: string, patch: PatchUserInput): Promise<AdminUser>;
  listWorkers(): Promise<Worker[]>;
}

const ProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  jira_jql: z.string(),
  max_infra_retries: z.number(),
  max_protocol_retries: z.number(),
  max_ci_rounds: z.number(),
  max_review_rounds: z.number(),
  max_budget_usd: z.number().nullable(),
  created_at: z.string(),
});

const RepositorySchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  default_runtime: RuntimeSchema,
  default_model: z.string().nullable(),
  max_concurrent_worktrees: z.number(),
  required_capability: z.string().nullable(),
  setup_command: z.string().nullable(),
  test_command: z.string().nullable(),
  created_at: z.string(),
});

const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string(),
  disabled_at: z.string().nullable(),
  created_at: z.string(),
});

const WorkerSchema = z.object({
  id: z.string(),
  host: z.string(),
  capabilities: z.array(z.string()),
  max_concurrent: z.number(),
  workspace_root: z.string(),
  last_heartbeat_at: z.string(),
  started_at: z.string(),
  heartbeat_age_seconds: z.number(),
  free_slots: z.number(),
});

function mapProject(row: z.infer<typeof ProjectSchema>): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    jiraJql: row.jira_jql,
    maxInfraRetries: row.max_infra_retries,
    maxProtocolRetries: row.max_protocol_retries,
    maxCiRounds: row.max_ci_rounds,
    maxReviewRounds: row.max_review_rounds,
    maxBudgetUsd: row.max_budget_usd,
    createdAt: row.created_at,
  };
}

function mapRepository(row: z.infer<typeof RepositorySchema>): Repository {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    gitUrl: row.git_url,
    defaultBranch: row.default_branch,
    defaultRuntime: row.default_runtime,
    defaultModel: row.default_model,
    maxConcurrentWorktrees: row.max_concurrent_worktrees,
    requiredCapability: row.required_capability,
    setupCommand: row.setup_command,
    testCommand: row.test_command,
    createdAt: row.created_at,
  };
}

function mapAdminUser(row: z.infer<typeof AdminUserSchema>): AdminUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
  };
}

function mapWorker(row: z.infer<typeof WorkerSchema>): Worker {
  return {
    id: row.id,
    host: row.host,
    capabilities: row.capabilities,
    maxConcurrent: row.max_concurrent,
    workspaceRoot: row.workspace_root,
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    heartbeatAgeSeconds: row.heartbeat_age_seconds,
    freeSlots: row.free_slots,
  };
}

function projectCreateBody(input: CreateProjectInput) {
  return {
    key: input.key,
    name: input.name,
    jira_jql: input.jiraJql,
    max_infra_retries: input.maxInfraRetries,
    max_protocol_retries: input.maxProtocolRetries,
    max_ci_rounds: input.maxCiRounds,
    max_review_rounds: input.maxReviewRounds,
    max_budget_usd: input.maxBudgetUsd,
  };
}

/** Only keys present on `patch` are included, so an untouched field is never sent. */
function projectPatchBody(patch: PatchProjectInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.key !== undefined) body.key = patch.key;
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.jiraJql !== undefined) body.jira_jql = patch.jiraJql;
  if (patch.maxInfraRetries !== undefined) body.max_infra_retries = patch.maxInfraRetries;
  if (patch.maxProtocolRetries !== undefined) body.max_protocol_retries = patch.maxProtocolRetries;
  if (patch.maxCiRounds !== undefined) body.max_ci_rounds = patch.maxCiRounds;
  if (patch.maxReviewRounds !== undefined) body.max_review_rounds = patch.maxReviewRounds;
  if (patch.maxBudgetUsd !== undefined) body.max_budget_usd = patch.maxBudgetUsd;
  return body;
}

function repositoryCreateBody(input: CreateRepositoryInput) {
  return {
    project_id: input.projectId,
    name: input.name,
    git_url: input.gitUrl,
    default_branch: input.defaultBranch,
    default_runtime: input.defaultRuntime,
    default_model: input.defaultModel,
    max_concurrent_worktrees: input.maxConcurrentWorktrees,
    required_capability: input.requiredCapability,
    setup_command: input.setupCommand,
    test_command: input.testCommand,
  };
}

function repositoryPatchBody(patch: PatchRepositoryInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.projectId !== undefined) body.project_id = patch.projectId;
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.gitUrl !== undefined) body.git_url = patch.gitUrl;
  if (patch.defaultBranch !== undefined) body.default_branch = patch.defaultBranch;
  if (patch.defaultRuntime !== undefined) body.default_runtime = patch.defaultRuntime;
  if (patch.defaultModel !== undefined) body.default_model = patch.defaultModel;
  if (patch.maxConcurrentWorktrees !== undefined) body.max_concurrent_worktrees = patch.maxConcurrentWorktrees;
  if (patch.requiredCapability !== undefined) body.required_capability = patch.requiredCapability;
  if (patch.setupCommand !== undefined) body.setup_command = patch.setupCommand;
  if (patch.testCommand !== undefined) body.test_command = patch.testCommand;
  return body;
}

/**
 * Builds a leading `?a=b&c=d` query string, omitting any key whose value is
 * `undefined`. Duplicated from `client.ts`'s private helper of the same
 * shape rather than imported, for the same reason as `costs.ts`.
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

/** Builds an admin client from a bare `request` function (design.md §12.5). */
export function createAdminApi(request: ApiClient["request"]): AdminApi {
  return {
    listProjects: async () => {
      const json = await request<unknown>("GET", "/projects");
      return z.array(ProjectSchema).parse(json).map(mapProject);
    },
    createProject: async (input) => {
      const json = await request<unknown>("POST", "/projects", { body: projectCreateBody(input) });
      return mapProject(ProjectSchema.parse(json));
    },
    patchProject: async (id, patch) => {
      const json = await request<unknown>("PATCH", `/projects/${id}`, { body: projectPatchBody(patch) });
      return mapProject(ProjectSchema.parse(json));
    },
    listRepositories: async (projectId) => {
      const json = await request<unknown>("GET", `/repositories${buildQuery({ project: projectId })}`);
      return z.array(RepositorySchema).parse(json).map(mapRepository);
    },
    createRepository: async (input) => {
      const json = await request<unknown>("POST", "/repositories", { body: repositoryCreateBody(input) });
      return mapRepository(RepositorySchema.parse(json));
    },
    patchRepository: async (id, patch) => {
      const json = await request<unknown>("PATCH", `/repositories/${id}`, { body: repositoryPatchBody(patch) });
      return mapRepository(RepositorySchema.parse(json));
    },
    listUsers: async () => {
      const json = await request<unknown>("GET", "/users");
      return z.array(AdminUserSchema).parse(json).map(mapAdminUser);
    },
    createUser: async (input) => {
      const json = await request<unknown>("POST", "/users", {
        body: { email: input.email, password: input.password, display_name: input.displayName },
      });
      return mapAdminUser(AdminUserSchema.parse(json));
    },
    patchUser: async (id, patch) => {
      const body: Record<string, unknown> = {};
      if (patch.displayName !== undefined) body.display_name = patch.displayName;
      const json = await request<unknown>("PATCH", `/users/${id}`, { body });
      return mapAdminUser(AdminUserSchema.parse(json));
    },
    listWorkers: async () => {
      const json = await request<unknown>("GET", "/workers");
      return z.array(WorkerSchema).parse(json).map(mapWorker);
    },
  };
}
