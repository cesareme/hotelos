// Tanda 5 (L1c · api): Fastify's body/content-type errors (FST_ERR_CTP_*)
// are exposed with a Spanish message and their own status by the global
// error handler. Pure, no server. Run from apps/api with
//   node --import tsx --test src/lib/__tests__/http-error-fastify.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalRequiredError, ConflictError, ForbiddenError, HttpError, RbacForbiddenError, TooManyRequestsError, describeFastifyContentTypeError, statusCodeForError } from "../http-error.js";

function fastifyError(code: string, statusCode: number, message: string): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

describe("describeFastifyContentTypeError · Spanish 4xx for Fastify body errors", () => {
  it("translates the empty JSON body error (PATCH with Content-Type: application/json and no body)", () => {
    const error = fastifyError("FST_ERR_CTP_EMPTY_JSON_BODY", 400, "Body cannot be empty when content-type is set to 'application/json'");
    assert.deepEqual(describeFastifyContentTypeError(error), { statusCode: 400, message: "El cuerpo de la petición debe ser un objeto JSON." });
    assert.equal(statusCodeForError(error), 400);
  });

  it("translates invalid JSON, unsupported media type, bad content length and body too large", () => {
    assert.equal(describeFastifyContentTypeError(fastifyError("FST_ERR_CTP_INVALID_JSON_BODY", 400, "x"))?.message, "El cuerpo de la petición no es JSON válido.");
    const media = describeFastifyContentTypeError(fastifyError("FST_ERR_CTP_INVALID_MEDIA_TYPE", 415, "x"));
    assert.equal(media?.statusCode, 415);
    assert.match(media?.message ?? "", /^Tipo de contenido no admitido/);
    assert.equal(describeFastifyContentTypeError(fastifyError("FST_ERR_CTP_INVALID_CONTENT_LENGTH", 400, "x"))?.statusCode, 400);
    assert.equal(describeFastifyContentTypeError(fastifyError("FST_ERR_CTP_BODY_TOO_LARGE", 413, "x"))?.statusCode, 413);
  });

  it("returns null for anything else (typed HttpErrors, Prisma codes, plain errors)", () => {
    assert.equal(describeFastifyContentTypeError(new Error("boom")), null);
    assert.equal(describeFastifyContentTypeError({ code: "P2002" }), null);
    assert.equal(describeFastifyContentTypeError(null), null);
    assert.equal(describeFastifyContentTypeError("FST_ERR_CTP_EMPTY_JSON_BODY"), null);
  });
});

// ── Tanda 8a (RBAC · L1): typed errors of the access engine ─────────────────
describe("RbacForbiddenError / ApprovalRequiredError · status and machine-readable details", () => {
  it("RbacForbiddenError is a 403 HttpError whose details carry the code (extra fields never overwrite it)", () => {
    const error = new RbacForbiddenError("No puedes asignar un rol de nivel superior al tuyo.", "RBAC_LEVEL_EXCEEDED", { targetRank: 3, callerRank: 2, code: "IGNORED" });
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 403);
    assert.equal(statusCodeForError(error), 403);
    assert.equal(error.expose, true);
    assert.deepEqual(error.details, { targetRank: 3, callerRank: 2, code: "RBAC_LEVEL_EXCEEDED" });
    assert.equal(error.name, "RbacForbiddenError");
    assert.equal(new RbacForbiddenError("x", "RBAC_BREAK_GLASS_FORBIDDEN").statusCode, 403);
    assert.deepEqual(new RbacForbiddenError("x", "RBAC_BREAK_GLASS_FORBIDDEN").details, { code: "RBAC_BREAK_GLASS_FORBIDDEN" });
  });

  it("ApprovalRequiredError is a 409 with code APPROVAL_REQUIRED, the kind, the tier and the optional requestId", () => {
    const withRequest = new ApprovalRequiredError("Esta operación necesita una aprobación previa.", { kind: "refund", tier: "T2", requestId: "apr_1" });
    assert.equal(withRequest.statusCode, 409);
    assert.equal(statusCodeForError(withRequest), 409);
    assert.deepEqual(withRequest.details, { code: "APPROVAL_REQUIRED", kind: "refund", tier: "T2", requestId: "apr_1" });
    const without = new ApprovalRequiredError("x", { kind: "supplier_bill", tier: "ABOVE_T4" });
    assert.deepEqual(without.details, { code: "APPROVAL_REQUIRED", kind: "supplier_bill", tier: "ABOVE_T4" });
  });

  it("ConflictError forwards the RBAC_SOD_CONFLICT details", () => {
    const error = new ConflictError("La combinación de roles viola la separación de funciones.", { code: "RBAC_SOD_CONFLICT", pair: { a: "payables.create", b: "payables.approve" }, templates: ["admin_clerk", "manager"] });
    assert.equal(error.statusCode, 409);
    assert.deepEqual(error.details, { code: "RBAC_SOD_CONFLICT", pair: { a: "payables.create", b: "payables.approve" }, templates: ["admin_clerk", "manager"] });
  });
});

// ── Tanda L6a (lote 3): errores tipados del tool runner de IA ───────────────
describe("TooManyRequestsError / ForbiddenError con details · 429 y 403 tipados del tool runner", () => {
  it("TooManyRequestsError is a 429 HttpError with code AI_RATE_LIMITED and the optional retryAfterSeconds", () => {
    const error = new TooManyRequestsError("Límite de peticiones de IA alcanzado; reintente en 2 s.", { retryAfterSeconds: 2 });
    assert.ok(error instanceof HttpError);
    assert.equal(error.name, "TooManyRequestsError");
    assert.equal(error.statusCode, 429);
    assert.equal(statusCodeForError(error), 429);
    assert.equal(error.expose, true);
    assert.deepEqual(error.details, { code: "AI_RATE_LIMITED", retryAfterSeconds: 2 });
    const bare = new TooManyRequestsError();
    assert.equal(bare.message, "Demasiadas peticiones");
    assert.deepEqual(bare.details, { code: "AI_RATE_LIMITED" });
    assert.deepEqual(new TooManyRequestsError("x", { code: "AI_THROTTLED" }).details, { code: "AI_THROTTLED" }, "un código explícito sustituye al defecto");
  });

  it("ForbiddenError keeps its 403 and now forwards optional details (AI_BUDGET_EXCEEDED)", () => {
    const plain = new ForbiddenError();
    assert.equal(plain.statusCode, 403);
    assert.equal(plain.message, "Forbidden");
    assert.equal(plain.details, undefined);
    const budget = new ForbiddenError("Presupuesto mensual de IA agotado.", { code: "AI_BUDGET_EXCEEDED", propertyId: "prop_1", budgetEur: 25, spentEur: 25 });
    assert.equal(budget.statusCode, 403);
    assert.equal(statusCodeForError(budget), 403);
    assert.deepEqual(budget.details, { code: "AI_BUDGET_EXCEEDED", propertyId: "prop_1", budgetEur: 25, spentEur: 25 });
  });
});
