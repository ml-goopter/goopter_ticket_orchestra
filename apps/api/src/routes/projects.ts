import {
  UniqueViolationError,
  getProjectById,
  insertProject,
  listProjects,
  updateProject,
  type ProjectRow,
} from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { z, type ZodError } from "zod";
import { AppError } from "../lib/errors.js";

/** Jira project key: an uppercase letter followed by uppercase/digits/underscore. */
const KEY_RE = /^[A-Z][A-Z0-9_]+$/;

function validationMessage(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** design.md build-order Q9: no enforcement here, only storage. */
const MaxBudgetUsdSchema = z
  .number()
  .nonnegative("max_budget_usd must not be negative")
  .nullable();

const CreateProjectSchema = z
  .object({
    key: z.string().regex(KEY_RE, "key must match ^[A-Z][A-Z0-9_]+$"),
    name: z.string().min(1, "name is required"),
    jira_jql: z.string().min(1, "jira_jql is required"),
    max_infra_retries: z.number().int().min(0).default(3),
    max_protocol_retries: z.number().int().min(0).default(2),
    max_ci_rounds: z.number().int().min(0).default(3),
    max_review_rounds: z.number().int().min(0).default(3),
    max_budget_usd: MaxBudgetUsdSchema.default(null),
  })
  .strict();

const PatchProjectSchema = z
  .object({
    key: z.string().regex(KEY_RE, "key must match ^[A-Z][A-Z0-9_]+$"),
    name: z.string().min(1, "name is required"),
    jira_jql: z.string().min(1, "jira_jql is required"),
    max_infra_retries: z.number().int().min(0),
    max_protocol_retries: z.number().int().min(0),
    max_ci_rounds: z.number().int().min(0),
    max_review_rounds: z.number().int().min(0),
    max_budget_usd: MaxBudgetUsdSchema,
  })
  .strict()
  .partial();

function toResponse(row: ProjectRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    jira_jql: row.jiraJql,
    max_infra_retries: row.maxInfraRetries,
    max_protocol_retries: row.maxProtocolRetries,
    max_ci_rounds: row.maxCiRounds,
    max_review_rounds: row.maxReviewRounds,
    max_budget_usd: row.maxBudgetUsd === null ? null : Number(row.maxBudgetUsd),
    created_at: row.createdAt,
  };
}

function notFound(id: string): AppError {
  return new AppError(404, "NOT_FOUND", `project not found: ${id}`);
}

/** Admin routes for `projects` (design.md §12.5, §4.2). */
export default async function projectsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/", async () => {
    const rows = await listProjects(app.db);
    return rows.map(toResponse);
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const row = await getProjectById(app.db, request.params.id);
    if (!row) throw notFound(request.params.id);
    return toResponse(row);
  });

  app.post("/", async (request, reply) => {
    const parsed = CreateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    }
    try {
      const row = await insertProject(app.db, {
        key: parsed.data.key,
        name: parsed.data.name,
        jiraJql: parsed.data.jira_jql,
        maxInfraRetries: parsed.data.max_infra_retries,
        maxProtocolRetries: parsed.data.max_protocol_retries,
        maxCiRounds: parsed.data.max_ci_rounds,
        maxReviewRounds: parsed.data.max_review_rounds,
        maxBudgetUsd:
          parsed.data.max_budget_usd === null
            ? null
            : parsed.data.max_budget_usd.toFixed(6),
      });
      reply.code(201);
      return toResponse(row);
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        throw new AppError(
          409,
          "CONFLICT",
          `A project with key ${parsed.data.key} already exists.`,
        );
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const parsed = PatchProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    }
    try {
      const row = await updateProject(app.db, request.params.id, {
        ...(parsed.data.key !== undefined ? { key: parsed.data.key } : {}),
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.jira_jql !== undefined
          ? { jiraJql: parsed.data.jira_jql }
          : {}),
        ...(parsed.data.max_infra_retries !== undefined
          ? { maxInfraRetries: parsed.data.max_infra_retries }
          : {}),
        ...(parsed.data.max_protocol_retries !== undefined
          ? { maxProtocolRetries: parsed.data.max_protocol_retries }
          : {}),
        ...(parsed.data.max_ci_rounds !== undefined
          ? { maxCiRounds: parsed.data.max_ci_rounds }
          : {}),
        ...(parsed.data.max_review_rounds !== undefined
          ? { maxReviewRounds: parsed.data.max_review_rounds }
          : {}),
        ...(parsed.data.max_budget_usd !== undefined
          ? {
              maxBudgetUsd:
                parsed.data.max_budget_usd === null
                  ? null
                  : parsed.data.max_budget_usd.toFixed(6),
            }
          : {}),
      });
      if (!row) throw notFound(request.params.id);
      return toResponse(row);
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        throw new AppError(
          409,
          "CONFLICT",
          `A project with key ${parsed.data.key} already exists.`,
        );
      }
      throw err;
    }
  });
}
