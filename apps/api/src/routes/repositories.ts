import { RuntimeSchema } from "@orchestra/core";
import {
  UniqueViolationError,
  getProjectById,
  getRepositoryById,
  insertRepository,
  isUuid,
  listRepositories,
  updateRepository,
  type RepositoryRow,
} from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { z, type ZodError } from "zod";
import { AppError } from "../lib/errors.js";

function validationMessage(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** `git@host:org/repo.git`, requiring both an org and a repo segment. */
const SSH_GIT_URL_RE = /^git@[^\s:/]+:[^\s/]+\/[^\s/]+\.git$/;

/** Ssh shorthand or an `https://` URL with at least `/org/repo` in its path. */
function isValidGitUrl(value: string): boolean {
  if (SSH_GIT_URL_RE.test(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const segments = url.pathname.split("/").filter(Boolean);
  return segments.length >= 2;
}

const CreateRepositorySchema = z
  .object({
    project_id: z.string().refine(isUuid, "project_id must be a uuid"),
    name: z.string().min(1, "name is required"),
    git_url: z
      .string()
      .refine(
        isValidGitUrl,
        "git_url must be an ssh (git@host:org/repo.git) or https URL",
      ),
    default_branch: z.string().min(1, "default_branch is required"),
    default_runtime: RuntimeSchema,
    default_model: z.string().nullable().optional().default(null),
    max_concurrent_worktrees: z.number().int().min(1).default(1),
    required_capability: z.string().nullable().optional().default(null),
    setup_command: z.string().nullable().optional().default(null),
    test_command: z.string().nullable().optional().default(null),
  })
  .strict();

const PatchRepositorySchema = z
  .object({
    project_id: z.string().refine(isUuid, "project_id must be a uuid"),
    name: z.string().min(1, "name is required"),
    git_url: z
      .string()
      .refine(
        isValidGitUrl,
        "git_url must be an ssh (git@host:org/repo.git) or https URL",
      ),
    default_branch: z.string().min(1, "default_branch is required"),
    default_runtime: RuntimeSchema,
    default_model: z.string().nullable(),
    max_concurrent_worktrees: z.number().int().min(1),
    required_capability: z.string().nullable(),
    setup_command: z.string().nullable(),
    test_command: z.string().nullable(),
  })
  .strict()
  .partial();

function toResponse(row: RepositoryRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    git_url: row.gitUrl,
    default_branch: row.defaultBranch,
    default_runtime: row.defaultRuntime,
    default_model: row.defaultModel,
    max_concurrent_worktrees: row.maxConcurrentWorktrees,
    required_capability: row.requiredCapability,
    setup_command: row.setupCommand,
    test_command: row.testCommand,
    created_at: row.createdAt,
  };
}

function notFound(id: string): AppError {
  return new AppError(404, "NOT_FOUND", `repository not found: ${id}`);
}

function conflict(): AppError {
  return new AppError(
    409,
    "CONFLICT",
    "A repository with that name already exists in this project.",
  );
}

/** Admin routes for `repositories` (design.md §12.5, §4.2). */
export default async function repositoriesRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{ Querystring: { project?: string } }>("/", async (request) => {
    const rows = await listRepositories(app.db, {
      projectId: request.query.project,
    });
    return rows.map(toResponse);
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const row = await getRepositoryById(app.db, request.params.id);
    if (!row) throw notFound(request.params.id);
    return toResponse(row);
  });

  app.post("/", async (request, reply) => {
    const parsed = CreateRepositorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    }
    const project = await getProjectById(app.db, parsed.data.project_id);
    if (!project) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `project not found: ${parsed.data.project_id}`,
      );
    }
    try {
      const row = await insertRepository(app.db, {
        projectId: parsed.data.project_id,
        name: parsed.data.name,
        gitUrl: parsed.data.git_url,
        defaultBranch: parsed.data.default_branch,
        defaultRuntime: parsed.data.default_runtime,
        defaultModel: parsed.data.default_model,
        maxConcurrentWorktrees: parsed.data.max_concurrent_worktrees,
        requiredCapability: parsed.data.required_capability,
        setupCommand: parsed.data.setup_command,
        testCommand: parsed.data.test_command,
      });
      reply.code(201);
      return toResponse(row);
    } catch (err) {
      if (err instanceof UniqueViolationError) throw conflict();
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const parsed = PatchRepositorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    }
    if (parsed.data.project_id !== undefined) {
      const project = await getProjectById(app.db, parsed.data.project_id);
      if (!project) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `project not found: ${parsed.data.project_id}`,
        );
      }
    }
    try {
      const row = await updateRepository(app.db, request.params.id, {
        ...(parsed.data.project_id !== undefined
          ? { projectId: parsed.data.project_id }
          : {}),
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.git_url !== undefined
          ? { gitUrl: parsed.data.git_url }
          : {}),
        ...(parsed.data.default_branch !== undefined
          ? { defaultBranch: parsed.data.default_branch }
          : {}),
        ...(parsed.data.default_runtime !== undefined
          ? { defaultRuntime: parsed.data.default_runtime }
          : {}),
        ...(parsed.data.default_model !== undefined
          ? { defaultModel: parsed.data.default_model }
          : {}),
        ...(parsed.data.max_concurrent_worktrees !== undefined
          ? { maxConcurrentWorktrees: parsed.data.max_concurrent_worktrees }
          : {}),
        ...(parsed.data.required_capability !== undefined
          ? { requiredCapability: parsed.data.required_capability }
          : {}),
        ...(parsed.data.setup_command !== undefined
          ? { setupCommand: parsed.data.setup_command }
          : {}),
        ...(parsed.data.test_command !== undefined
          ? { testCommand: parsed.data.test_command }
          : {}),
      });
      if (!row) throw notFound(request.params.id);
      return toResponse(row);
    } catch (err) {
      if (err instanceof UniqueViolationError) throw conflict();
      throw err;
    }
  });
}
