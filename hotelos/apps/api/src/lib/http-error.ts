// Typed HTTP errors so service/handler code can signal the correct status
// code, and the global error handler (server.ts) can map them to a clean
// JSON response instead of a generic 500.

export class HttpError extends Error {
  readonly statusCode: number;
  readonly expose: boolean;
  constructor(statusCode: number, message: string, expose = true) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.expose = expose;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Authentication required") {
    super(401, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message = "Conflict") {
    super(409, message);
  }
}

/**
 * Best-effort extraction of an HTTP status code from an arbitrary thrown
 * value: explicit `statusCode`, Fastify validation errors, and the most
 * common Prisma known-request-error codes.
 */
export function statusCodeForError(error: unknown): number {
  if (error && typeof error === "object") {
    const e = error as { statusCode?: unknown; validation?: unknown; code?: unknown };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode <= 599) {
      return e.statusCode;
    }
    if (e.validation) return 400; // Fastify schema validation
    if (typeof e.code === "string") {
      switch (e.code) {
        case "P2002": // unique constraint violation
          return 409;
        case "P2025": // record not found
          return 404;
        case "P2003": // FK constraint
        case "P2000": // value too long
          return 400;
        default:
          break;
      }
    }
  }
  return 500;
}
