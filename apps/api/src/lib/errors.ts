import type { FastifyInstance } from "fastify";

/**
 * Thrown by route handlers for expected failures. `statusCode` and `code`
 * flow straight into the `{ error: { code, message } }` body the global
 * handler produces (design.md §12 intro).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const AUTH_INVALID_CREDENTIALS = new AppError(
  401,
  "INVALID_CREDENTIALS",
  "Invalid email or password.",
);

export const AUTH_REQUIRED = new AppError(
  401,
  "AUTH_REQUIRED",
  "Authentication required.",
);

function defaultCodeFor(statusCode: number): string {
  if (statusCode === 429) return "RATE_LIMITED";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode >= 400 && statusCode < 500) return "BAD_REQUEST";
  return "INTERNAL_ERROR";
}

/**
 * Global error handler (design.md §12 intro): every error, thrown or
 * validation, resolves to `{ error: { code, message } }`. 4xx for
 * validation/auth, 500 otherwise, and the 500 body never carries the real
 * message or stack outside development/test so nothing internal leaks in
 * production.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: Error, request, reply) => {
    if (err instanceof AppError) {
      reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message } });
      return;
    }

    const isValidation = Boolean(
      (err as { validation?: unknown }).validation,
    );
    const rawStatus = (err as { statusCode?: number }).statusCode;
    const statusCode = isValidation
      ? 400
      : rawStatus && rawStatus >= 400 && rawStatus < 600
        ? rawStatus
        : 500;

    if (statusCode >= 500) {
      request.log.error(err);
    }

    const isProduction = app.config.NODE_ENV === "production";
    const message =
      statusCode < 500 || !isProduction
        ? err.message
        : "Internal server error";

    reply
      .code(statusCode)
      .send({ error: { code: defaultCodeFor(statusCode), message } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply
      .code(404)
      .send({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });
}
