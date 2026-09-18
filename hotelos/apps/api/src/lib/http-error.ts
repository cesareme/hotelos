// Typed HTTP errors so service/handler code can signal the correct status
// code, and the global error handler (server.ts) can map them to a clean
// JSON response instead of a generic 500.

import type { ApprovalKind, RbacErrorCode, ThresholdTier } from "@hotelos/shared";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly expose: boolean;
  /** Machine-readable payload forwarded on 4xx bodies (e.g. { code: "BALANCE_DUE", balanceDue }). */
  details?: unknown;
  constructor(statusCode: number, message: string, expose = true, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.expose = expose;
    if (details !== undefined) this.details = details;
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
  /** `details` is forwarded on the 409 body (e.g. { code: "RESERVATION_CODE_CONFLICT" }, { code: "RBAC_SOD_CONFLICT", pair, templates }). */
  constructor(message = "Conflict", details?: unknown) {
    super(409, message, true, details);
  }
}

/**
 * Tanda 8a (RBAC · L1): a 403 of the access engine with a machine-readable
 * `details.code` (RbacErrorCode of packages/shared: RBAC_LEVEL_EXCEEDED,
 * RBAC_SCOPE_EXCEEDED, RBAC_SELF_ASSIGNMENT, RBAC_BREAK_GLASS_FORBIDDEN,
 * SUPERVISOR_PIN_INVALID, BREAK_GLASS_REAUTH_REQUIRED…) so the front branches
 * on the code instead of parsing the Spanish message. Extra `details` fields
 * are merged after the code (never overwrite it).
 */
export class RbacForbiddenError extends HttpError {
  constructor(message: string, code: RbacErrorCode, details?: object) {
    super(403, message, true, { ...(details ?? {}), code });
  }
}

/**
 * Tanda 8a (RBAC · L1, §4.7): the operation needs a prior approval
 * (approval_requests) — 409 with `details.code = "APPROVAL_REQUIRED"`, the
 * kind, the amount tier and, when the caller already opened a request that
 * does not match yet, its id.
 */
export class ApprovalRequiredError extends HttpError {
  constructor(message: string, details: { kind: ApprovalKind; tier: ThresholdTier; requestId?: string }) {
    super(409, message, true, { code: "APPROVAL_REQUIRED", kind: details.kind, tier: details.tier, ...(details.requestId ? { requestId: details.requestId } : {}) });
  }
}

/**
 * Translate a Prisma known-request error into a client-safe HTTP description
 * (status + Spanish message + machine-readable details). Prisma's own
 * `message` embeds the invocation text (and in dev the source path/lines),
 * which must never reach an API response. Returns null for anything that is
 * not one of the recognised codes so callers can fall back to their own
 * handling. Companion of `statusCodeForError` (kept intact — this one adds
 * the message/details layer).
 */
export function describePrismaError(
  error: unknown
): { statusCode: number; message: string; details: Record<string, unknown> } | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { code?: unknown; meta?: unknown };
  if (typeof e.code !== "string") return null;
  const meta = (e.meta && typeof e.meta === "object" ? e.meta : {}) as Record<string, unknown>;
  switch (e.code) {
    case "P2002": // unique constraint violation
      return {
        statusCode: 409,
        message: "Ya existe un registro con el mismo valor único.",
        details: { code: "UNIQUE_VIOLATION", target: meta.target ?? null }
      };
    case "P2025": // record not found (update/delete on a missing row)
      return {
        statusCode: 404,
        message: "El registro no existe.",
        details: { code: "NOT_FOUND" }
      };
    case "P2003": // FK constraint
      return {
        statusCode: 400,
        message: "Referencia inválida.",
        details: { code: "FK_VIOLATION", field: meta.field_name ?? null }
      };
    case "P2000": // value too long for the column
      return {
        statusCode: 400,
        message: "Valor demasiado largo.",
        details: { code: "VALUE_TOO_LONG", column: meta.column_name ?? null }
      };
    default:
      return null;
  }
}

/**
 * Best-effort extraction of an HTTP status code from an arbitrary thrown
 * value: explicit `statusCode`, Fastify validation errors, and the most
 * common Prisma known-request-error codes.
 */
/**
 * Tanda 5 (L1c · api): Fastify's own content-type/body errors (code
 * FST_ERR_CTP_*) reach the global handler with an English message and a
 * correct status (400/413/415). They are client errors, so the message must
 * be Spanish like every other 4xx of this API: `PATCH …/modules/:code` with
 * `Content-Type: application/json` and an empty body used to answer «Body
 * cannot be empty when content-type is set to 'application/json'». Returns
 * null for anything else so the caller falls back to its own handling.
 */
export function describeFastifyContentTypeError(error: unknown): { statusCode: number; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  switch (code) {
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
      return { statusCode: 400, message: "El cuerpo de la petición debe ser un objeto JSON." };
    case "FST_ERR_CTP_INVALID_JSON_BODY":
      return { statusCode: 400, message: "El cuerpo de la petición no es JSON válido." };
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return { statusCode: 415, message: "Tipo de contenido no admitido: envía application/json." };
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
      return { statusCode: 400, message: "La longitud del cuerpo de la petición no coincide con Content-Length." };
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return { statusCode: 413, message: "El cuerpo de la petición es demasiado grande." };
    default:
      return null;
  }
}

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
