// Documentos: guardas de tamaño y páginas ANTES de fetch, bloques image/document,
// telemetría sin bytes, OCR de identidad con confianza por campo.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { resolveAiConfig } from "../config.ts";
import { AiError } from "../errors.ts";
import { IDENTITY_DOCUMENT_SCHEMA, MAX_IMAGE_BYTES, base64ByteLength, createAiCore, estimatePdfPages } from "../messages.ts";
import { createRateLimiter } from "../rate-limit.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

const CTX = { organizationId: "org_test", toolName: "extractIncomingDocumentFields", purpose: "extract" };
const SCHEMA = { type: "object", additionalProperties: false, required: ["total"], properties: { total: { type: "string" } } };
const PNG = Buffer.from("\x89PNG\r\n\x1a\n" + "pixel".repeat(20), "latin1").toString("base64");

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function message(text) {
  return json(200, { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 100 } });
}
function core(responders, extra = {}) {
  const calls = [];
  const ai = createAiCore({
    config: resolveAiConfig({ provider: "anthropic", apiKey: "sk-test", usdEurRate: "0.9", documentTimeoutMs: "90000" }),
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return responders.shift();
    },
    sleep: async () => undefined,
    ...extra
  });
  return { ai, calls };
}
function pdfWithPages(pages) {
  return Buffer.from("%PDF-1.4\n" + "<< /Type /Page /Parent 1 0 R >>\n".repeat(pages) + "<< /Type /Pages /Count 1 >>\n%%EOF", "latin1").toString("base64");
}

test("imagen de 11 MB → AiError payload_too_large antes de fetch y sin consumir el limitador", async () => {
  const limiter = createRateLimiter({ perMinute: 1, now: () => 0 });
  const { ai, calls } = core([message("{}")], { limiter });
  const elevenMb = "A".repeat(Math.ceil((11 * 1024 * 1024 * 4) / 3 / 4) * 4);
  assert.ok(base64ByteLength(elevenMb) > MAX_IMAGE_BYTES);
  await assert.rejects(ai.extractFromDocument({ pages: [{ mediaType: "image/jpeg", base64: elevenMb }], schema: SCHEMA, instruction: "Extrae" }, CTX), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, "payload_too_large");
    assert.equal(error.retryable, false);
    return true;
  });
  await assert.rejects(ai.extractJsonFromImage(`data:image/jpeg;base64,${elevenMb}`, "Extrae", CTX), (error) => error.code === "payload_too_large");
  assert.equal(calls.length, 0);
  assert.equal(limiter.remaining("org_test"), 1, "la guarda actúa antes de acquire");
});

test("petición de más de 32 MB (varias imágenes de 9 MB) → payload_too_large sin fetch", async () => {
  const { ai, calls } = core([]);
  const nineMb = "A".repeat(Math.ceil((9 * 1024 * 1024 * 4) / 3 / 4) * 4);
  const pages = Array.from({ length: 4 }, () => ({ mediaType: "image/jpeg", base64: nineMb }));
  await assert.rejects(ai.extractFromDocument({ pages, schema: SCHEMA, instruction: "Extrae" }, CTX), (error) => error.code === "payload_too_large");
  assert.equal(calls.length, 0);
});

test("PDF: cuerpo con bloque document + texto, output_config json_schema, sin temperature, timeout de documento y telemetría sin base64", async () => {
  const seen = [];
  const pdf = pdfWithPages(3);
  const { ai, calls } = core([message('{"total":"120,00"}')], {
    client: {
      async createMessage(body, options) {
        seen.push({ body, options });
        return { content: [{ type: "text", text: '{"total":"120,00"}' }], stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 100 } };
      },
      countTokens: async () => ({ input_tokens: 0 }),
      getModel: async () => ({ id: "x" })
    }
  });
  const result = await ai.extractFromDocument({ pdfBase64: pdf, schema: SCHEMA, instruction: "Extrae el total de la factura." }, CTX, { temperature: 0.5 });
  assert.equal(calls.length, 0, "cliente inyectado: fetch no interviene");
  assert.equal(result.configured, true);
  assert.deepEqual(result.data, { total: "120,00" });
  assert.equal(result.document.pages, 3);
  assert.equal(result.document.bytes, base64ByteLength(pdf));
  assert.equal(result.document.sha256, createHash("sha256").update(Buffer.from(pdf, "base64")).digest("hex"));
  assert.equal(JSON.stringify(result.document).includes(pdf.slice(0, 20)), false, "la telemetría nunca lleva bytes");
  const { body, options } = seen[0];
  assert.equal(options.timeoutMs, 90000);
  assert.equal(body.max_tokens, 4000);
  assert.equal("temperature" in body, false);
  assert.deepEqual(body.output_config, { format: { type: "json_schema", schema: SCHEMA } });
  const content = body.messages[0].content;
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } });
  assert.deepEqual(content[1], { type: "text", text: "Extrae el total de la factura." });
});

test("páginas > 100 en haiku rechazadas (imágenes y PDF estimado); el mismo PDF pasa en sonnet-5 (≤ 600)", async () => {
  const { ai, calls } = core([message('{"total":"1"}')]);
  const pages = Array.from({ length: 101 }, () => ({ mediaType: "image/png", base64: PNG }));
  await assert.rejects(ai.extractFromDocument({ pages, schema: SCHEMA, instruction: "x" }, CTX, { model: "classify" }), (error) => error.code === "payload_too_large" && /101/.test(error.message));
  const pdf = pdfWithPages(101);
  assert.equal(estimatePdfPages(Buffer.from(pdf, "base64")), 101, "/Type /Pages no cuenta como página");
  await assert.rejects(ai.extractFromDocument({ pdfBase64: pdf, schema: SCHEMA, instruction: "x" }, CTX, { model: "claude-haiku-4-5" }), (error) => error.code === "payload_too_large");
  await assert.rejects(ai.extractFromDocument({ pdfBase64: pdfWithPages(2), pageCount: 150, schema: SCHEMA, instruction: "x" }, CTX, { model: "classify" }), (error) => error.code === "payload_too_large");
  assert.equal(calls.length, 0);
  const ok = await ai.extractFromDocument({ pdfBase64: pdf, schema: SCHEMA, instruction: "x" }, CTX);
  assert.equal(ok.configured, true);
  assert.equal(ok.document.pages, 101);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "claude-sonnet-5");
});

test("extractIdentityDocument: bloque image + esquema de identidad, campos nulos omitidos y confianza por campo acotada", async () => {
  const { ai, calls } = core([
    message(
      JSON.stringify({
        documentType: "DNI",
        documentNumber: "12345678Z",
        documentSupportNumber: null,
        firstName: " Ludmila ",
        surname1: "Ferreiro",
        surname2: null,
        dateOfBirth: "1980-05-04",
        nationality: "ESP",
        sex: "F",
        confidence: { documentType: 0.99, documentNumber: 0.97, documentSupportNumber: null, firstName: 1.2, surname1: 0.9, surname2: null, dateOfBirth: 0.8, nationality: 0.95, sex: 0.9 }
      })
    )
  ]);
  const result = await ai.extractIdentityDocument(`data:image/png;base64,${PNG}`, { organizationId: "org_test", toolName: "scan_id_document", purpose: "extract" });
  assert.equal(result.configured, true);
  assert.deepEqual(result.fields, { documentType: "DNI", documentNumber: "12345678Z", firstName: "Ludmila", surname1: "Ferreiro", dateOfBirth: "1980-05-04", nationality: "ESP", sex: "F" });
  assert.deepEqual(result.confidence, { documentType: 0.99, documentNumber: 0.97, firstName: 1, surname1: 0.9, dateOfBirth: 0.8, nationality: 0.95, sex: 0.9 });
  assert.equal("data" in result, false);
  assert.equal("document" in result, false);
  const body = calls[0].body;
  assert.deepEqual(body.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });
  assert.match(body.messages[0].content[1].text, /documentos de identidad/);
  assert.deepEqual(body.output_config.format.schema, IDENTITY_DOCUMENT_SCHEMA);
  assert.equal(body.model, "claude-sonnet-5");
  await assert.rejects(ai.extractIdentityDocument("no-es-data-url", CTX), TypeError);

  // CFC-08: la extracción de identidad y el OCR de imagen usan el timeout de documentos (120 s / aquí 90 s), no el de texto (20 s).
  const seen = [];
  const injected = core([], {
    client: {
      async createMessage(_body, options) {
        seen.push(options);
        return { content: [{ type: "text", text: JSON.stringify({ documentType: "DNI", documentNumber: null, documentSupportNumber: null, firstName: null, surname1: null, surname2: null, dateOfBirth: null, nationality: null, sex: null, confidence: { documentType: 0.9, documentNumber: null, documentSupportNumber: null, firstName: null, surname1: null, surname2: null, dateOfBirth: null, nationality: null, sex: null } }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
      },
      countTokens: async () => ({ input_tokens: 0 }),
      getModel: async () => ({ id: "x" })
    }
  });
  await injected.ai.extractIdentityDocument(`data:image/png;base64,${PNG}`, CTX);
  assert.equal(seen[0].timeoutMs, 90000);
  await injected.ai.extractJsonFromImage(`data:image/png;base64,${PNG}`, "Lee", CTX).catch(() => undefined);
  assert.equal(seen[1].timeoutMs, 90000);
});

test("extractJsonFromImage: imagen + instrucción, JSON tolerante a prosa; sin objeto → invalid_output", async () => {
  const { ai, calls } = core([message('Aquí tienes: {"issueDate":"2024-01-02","expiryDate":"2029-01-02"} ¡Saludos!'), message("no hay json")]);
  const result = await ai.extractJsonFromImage(`data:image/jpeg;base64,${PNG}`, "Lee las fechas.", CTX);
  assert.equal(result.configured, true);
  assert.deepEqual(result.data, { issueDate: "2024-01-02", expiryDate: "2029-01-02" });
  assert.deepEqual(calls[0].body.messages[0].content[1], { type: "text", text: "Lee las fechas." });
  assert.equal("output_config" in calls[0].body, false);
  await assert.rejects(ai.extractJsonFromImage(`data:image/jpeg;base64,${PNG}`, "Lee", CTX), (error) => error instanceof AiError && error.code === "invalid_output");
});
