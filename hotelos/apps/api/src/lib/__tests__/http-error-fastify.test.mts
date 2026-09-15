// Tanda 5 (L1c · api): Fastify's body/content-type errors (FST_ERR_CTP_*)
// are exposed with a Spanish message and their own status by the global
// error handler. Pure, no server. Run from apps/api with
//   node --import tsx --test src/lib/__tests__/http-error-fastify.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeFastifyContentTypeError, statusCodeForError } from "../http-error.js";

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
