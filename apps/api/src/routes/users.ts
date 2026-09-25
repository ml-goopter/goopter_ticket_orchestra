import {
  getAdminUserById,
  listAdminUsers,
  updateAdminUser,
  type AdminUserRow,
} from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { z, type ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { createUser, DuplicateEmailError, WeakPasswordError } from "../lib/users.js";

function validationMessage(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

const CreateUserSchema = z
  .object({
    email: z.string().min(1, "email is required"),
    password: z.string().min(1, "password is required"),
    display_name: z.string().min(1, "display_name is required"),
  })
  .strict();

/**
 * `.strict()` rejects a `disabled` field with 400 rather than silently
 * ignoring it: no api route sets `disabled_at` (R3, design.md §12.5 lists
 * the route but not this field; users.disable is out of scope pending a
 * design decision).
 */
const PatchUserSchema = z
  .object({
    display_name: z.string().min(1, "display_name is required"),
  })
  .strict()
  .partial();

function toResponse(row: AdminUserRow) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.displayName,
    disabled_at: row.disabledAt,
    created_at: row.createdAt,
  };
}

function notFound(id: string): AppError {
  return new AppError(404, "NOT_FOUND", `user not found: ${id}`);
}

/**
 * Admin routes for `users` (design.md §12.5, §13: create requires an
 * existing session; the first user is created by `users:add`, not here).
 * Never returns `password_hash`: `toResponse` and the db layer's
 * `AdminUserRow` both exclude it.
 */
export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    const rows = await listAdminUsers(app.db);
    return rows.map(toResponse);
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const row = await getAdminUserById(app.db, request.params.id);
    if (!row) throw notFound(request.params.id);
    return toResponse(row);
  });

  app.post("/", async (request, reply) => {
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    }
    try {
      const created = await createUser({
        db: app.db,
        email: parsed.data.email,
        password: parsed.data.password,
        displayName: parsed.data.display_name,
      });
      const row = await getAdminUserById(app.db, created.id);
      if (!row) throw notFound(created.id);
      reply.code(201);
      return toResponse(row);
    } catch (err) {
      if (err instanceof DuplicateEmailError) {
        throw new AppError(409, "CONFLICT", err.message);
      }
      if (err instanceof WeakPasswordError) {
        throw new AppError(400, "VALIDATION_ERROR", err.message);
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const parsed = PatchUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    }
    const row = await updateAdminUser(app.db, request.params.id, {
      ...(parsed.data.display_name !== undefined
        ? { displayName: parsed.data.display_name }
        : {}),
    });
    if (!row) throw notFound(request.params.id);
    return toResponse(row);
  });
}
