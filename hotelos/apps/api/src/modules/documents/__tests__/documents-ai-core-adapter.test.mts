// Unit tests · Tanda T9 · lote T9-06a — adaptador del puerto de IA sobre ai-core
// vía runAiTool (documents-ai.core-adapter.ts). Runner y núcleo SIMULADOS: sin
// base de datos, sin red, sin proveedor real. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/documents-ai-core-adapter.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiCore, AiResult, DocumentTelemetry } from "@hotelos/ai-core";
import type { RunnerContext, ToolRunResult } from "@hotelos/ai-core/runner";
import { ForbiddenError } from "../../../lib/http-error.js";
import type { RunAiToolInput } from "../../ai-operations/tool-runner.service.js";
import {
  AI_RESTRICTED_KINDS,
  CLASSIFY_MAX_TEXT,
  PAGES_PER_CHUNK,
  createAiCoreDocumentsPort,
  mergeChunkFields,
  normalizeModelFields,
  pipelineUserContext,
  runFailureNote,
  type RunAiToolFn
} from "../documents-ai.core-adapter.js";
import type { DocumentsAiContext } from "../documents-ai.port.js";
import { INVOICE_SCHEMA, LETTER_SCHEMA, schemaFor } from "../extraction-schemas.js";
import { DEMO_SUPPLIER_TAX_ID, demoInvoicePdf } from "./fixtures.ts";
import { extractPdfText } from "../pdf-text.js";

const ctx: DocumentsAiContext = { organizationId: "org_test", propertyId: "prop_test", userId: "usr_test", correlationId: "corr_adapter" };
const SHA = "f".repeat(64);
const invoiceText = extractPdfText(demoInvoicePdf()).pages[0]!.text;
const USAGE = { model: "claude-haiku-4-5", tokensInput: 120, tokensOutput: 40, cacheReadTokens: 0, costUsd: 0.0015, costEur: 0.0013, latencyMs: 90 };

type Captured = RunAiToolInput<unknown, unknown>;

function runnerContext(input: Captured): RunnerContext {
  return {
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    userId: input.context.userId,
    permissions: [...input.context.permissions],
    enabledModules: ["compliance_hub", "erp_accounting"],
    correlationId: input.correlationId,
    source: input.source ?? "text",
    locale: "es-ES"
  };
}

/** Núcleo simulado: extractFromDocument devuelve `data` del esquema del tipo y telemetría; nunca toca la red. */
function fakeCore(options: { configured?: boolean; onExtract?: (input: Parameters<AiCore["extractFromDocument"]>[0]) => void; data?: Record<string, unknown> } = {}): () => AiCore {
  const core = {
    isConfigured: () => options.configured ?? true,
    providerName: () => (options.configured === false ? "none" : "anthropic"),
    modelName: () => "claude-sonnet-5",
    extractFromDocument: async <T,>(input: Parameters<AiCore["extractFromDocument"]>[0]): Promise<AiResult<{ data: T; document: DocumentTelemetry }>> => {
      options.onExtract?.(input);
      const pages = input.pages?.length ?? input.pageCount ?? 1;
      const data = (options.data ?? {
        supplierTaxId: { value: DEMO_SUPPLIER_TAX_ID, confidence: 0.97, page: 1 },
        invoiceNumber: { value: "F-2026-0042", confidence: 0.9, page: 1 },
        total: { value: "205.70", confidence: 0.88, page: 1 },
        dueDate: { value: null, confidence: 0, page: null },
        lines: { value: [{ description: "Lavado", quantity: 120, unitPrice: "1.25", base: "150.00", taxRate: 21, quota: "31.50", deliveryNoteRef: null }], confidence: 0.8, page: 1 },
        inventado: { value: "no está en el esquema", confidence: 1, page: 1 }
      }) as T;
      return {
        configured: true,
        provider: "anthropic",
        model: USAGE.model,
        usage: { tokensInput: USAGE.tokensInput, tokensOutput: USAGE.tokensOutput, cacheReadTokens: 0, cacheWriteTokens: 0 },
        tokensInput: USAGE.tokensInput,
        tokensOutput: USAGE.tokensOutput,
        costUsd: USAGE.costUsd,
        costEur: USAGE.costEur,
        latencyMs: USAGE.latencyMs,
        stopReason: "end_turn",
        truncated: false,
        toolUses: [],
        data,
        document: { pages, bytes: 4096, sha256: "deadbeef" }
      };
    }
  };
  return () => core as unknown as AiCore;
}

/** Runner simulado: registra la llamada y responde según el nombre (o ejecuta el `execute` explícito de extract). */
function fakeRunner(captured: Captured[], options: { classify?: ToolRunResult<unknown>; extract?: ToolRunResult<unknown> | ((input: Captured) => Promise<ToolRunResult<unknown>>); throwError?: Error } = {}): RunAiToolFn {
  let calls = 0;
  return (async (input: RunAiToolInput<unknown, unknown>) => {
    captured.push(input);
    calls += 1;
    if (options.throwError) throw options.throwError;
    if (input.toolName === "classifyIncomingDocument") {
      return options.classify ?? { status: "executed", toolCallId: `call_${calls}`, configured: true, output: { kind: "invoice", confidence: 0.93, usage: USAGE } };
    }
    if (typeof options.extract === "function") return options.extract(input);
    if (options.extract) return options.extract;
    assert.ok(input.execute, "extract debe pasar un execute explícito");
    const executed = await input.execute(input.input, runnerContext(input));
    const wrapped = executed as { output?: unknown; record?: unknown; configured?: boolean };
    if (wrapped.configured === false) return { status: "executed", toolCallId: `call_${calls}`, configured: false, output: executed };
    // El runner persiste `record` (nunca `output`) en outputJson: aquí se comprueba que no lleva bytes.
    assert.ok(wrapped.record !== undefined, "extract debe devolver record para outputJson");
    assert.doesNotMatch(JSON.stringify(wrapped.record), /base64|JVBERi0/, "record sin bytes");
    return { status: "executed", toolCallId: `call_${calls}`, configured: true, output: wrapped.output, record: wrapped.record } as ToolRunResult<unknown> & { record: unknown };
  }) as RunAiToolFn;
}

describe("classify vía runAiTool", () => {
  it("llama al ejecutor classifyIncomingDocument con source system, texto ≤ 20.000 y nombre de fichero, y devuelve source ai", async () => {
    const captured: Captured[] = [];
    const port = createAiCoreDocumentsPort({ runTool: fakeRunner(captured), core: fakeCore() });
    assert.deepEqual(port.describe(), { configured: true, provider: "anthropic", model: "claude-sonnet-5" });
    const long = `${invoiceText}\n${"x".repeat(30_000)}`;
    const result = await port.classify({ text: long, fileName: "factura.pdf", mimeType: "application/pdf" }, ctx);
    assert.equal(captured.length, 1);
    const call = captured[0]!;
    assert.equal(call.toolName, "classifyIncomingDocument");
    assert.equal(call.source, "system");
    assert.equal(call.correlationId, "corr_adapter");
    assert.equal(call.context.organizationId, "org_test");
    assert.equal(call.context.propertyId, "prop_test");
    assert.equal(call.context.userId, "usr_test");
    assert.deepEqual(call.context.permissions, ["ai.tool.execute"]);
    const input = call.input as { text: string; fileName?: string };
    assert.equal(input.text.length, CLASSIFY_MAX_TEXT);
    assert.equal(input.fileName, "factura.pdf");
    assert.equal(call.execute, undefined, "classify reutiliza el ejecutor L6a (sin execute explícito)");
    assert.deepEqual(result, { kind: "invoice", confidence: 0.93, source: "ai", model: "claude-haiku-4-5" });
  });

  it("denied → reglas con nota ai_denied:<motivo>; sin proveedor → reglas sin llamar al runner; XML y sin texto → reglas", async () => {
    const captured: Captured[] = [];
    const denied = createAiCoreDocumentsPort({ runTool: fakeRunner(captured, { classify: { status: "denied", reason: "budget_exceeded", message: "Presupuesto agotado.", riskLevel: "low" } }), core: fakeCore() });
    const result = await denied.classify({ text: invoiceText, fileName: "f.pdf" }, ctx);
    assert.equal(result.kind, "invoice");
    assert.equal(result.source, "rules");
    assert.equal(result.note, "ai_denied:budget_exceeded");

    const notConfigured = createAiCoreDocumentsPort({ runTool: fakeRunner(captured, { throwError: new Error("no debe llamarse") }), core: fakeCore({ configured: false }) });
    assert.deepEqual(notConfigured.describe(), { configured: false, provider: "none" });
    assert.equal((await notConfigured.classify({ text: invoiceText }, ctx)).source, "rules");

    const xmlOrEmpty = createAiCoreDocumentsPort({ runTool: fakeRunner(captured, { throwError: new Error("no debe llamarse") }), core: fakeCore() });
    assert.equal((await xmlOrEmpty.classify({ text: "<?xml version=\"1.0\"?><catalogo/>", mimeType: "application/xml" }, ctx)).source, "rules");
    assert.equal((await xmlOrEmpty.classify({ text: null, mimeType: "image/png" }, ctx)).kind, "unknown");
    assert.equal(captured.filter((call) => call.toolName === "classifyIncomingDocument").length, 1);
  });

  it("awaiting_confirmation, salida inválida, 403 del runner y excepción → reglas con nota honesta", async () => {
    const waiting = createAiCoreDocumentsPort({ runTool: fakeRunner([], { classify: { status: "awaiting_confirmation", toolCallId: "call_w" } }), core: fakeCore() });
    assert.equal((await waiting.classify({ text: invoiceText }, ctx)).note, "ai_awaiting_confirmation");
    const invalid = createAiCoreDocumentsPort({ runTool: fakeRunner([], { classify: { status: "executed", toolCallId: "c", configured: true, output: { nope: true } } }), core: fakeCore() });
    assert.equal((await invalid.classify({ text: invoiceText }, ctx)).note, "llm_invalid_output");
    const budget = createAiCoreDocumentsPort({ runTool: fakeRunner([], { throwError: new ForbiddenError("Presupuesto mensual de IA agotado.", { code: "AI_BUDGET_EXCEEDED" }) }), core: fakeCore() });
    assert.equal((await budget.classify({ text: invoiceText }, ctx)).note, "runner_error:AI_BUDGET_EXCEEDED");
    const refused = createAiCoreDocumentsPort({ runTool: fakeRunner([], { classify: { status: "executed", toolCallId: "c", configured: false, output: { configured: false, reason: "refusal", message: "no" } } }), core: fakeCore() });
    assert.equal((await refused.classify({ text: invoiceText }, ctx)).note, "ai_not_configured:refusal");
    assert.equal(runFailureNote({ status: "executed", toolCallId: "x", configured: true, output: {} }), null);
  });
});

describe("extract vía runAiTool con execute explícito", () => {
  it("usa el esquema del tipo, instrucción en español, maxTokens 4000 y record sin base64; normaliza campos y pasa costEur", async () => {
    const captured: Captured[] = [];
    const seen: Array<Parameters<AiCore["extractFromDocument"]>[0]> = [];
    const port = createAiCoreDocumentsPort({ runTool: fakeRunner(captured), core: fakeCore({ onExtract: (input) => seen.push(input) }) });
    const pdfBase64 = demoInvoicePdf().toString("base64");
    const result = await port.extract({ kind: "invoice", text: invoiceText, pdfBase64, pageCount: 1, fileName: "factura.pdf", sha256: SHA }, ctx);

    assert.equal(captured.length, 1);
    const call = captured[0]!;
    assert.equal(call.toolName, "extractIncomingDocumentFields");
    assert.equal(call.source, "system");
    assert.equal(typeof call.execute, "function");
    assert.deepEqual(call.input, { pdfBase64, pageCount: 1 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.schema, INVOICE_SCHEMA);
    assert.equal(seen[0]!.schema, schemaFor("invoice"));
    assert.equal(seen[0]!.maxTokens, 4000);
    assert.match(seen[0]!.instruction, /factura de proveedor/);
    assert.equal(seen[0]!.pdfBase64, pdfBase64);

    assert.equal(result.source, "ai");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "claude-haiku-4-5");
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.toolCallIds, ["call_1"]);
    assert.deepEqual(result.telemetry, { model: "claude-haiku-4-5", tokensInput: 120, tokensOutput: 40, costEur: 0.0013, latencyMs: 90 });
    assert.deepEqual(result.fields.supplierTaxId, { value: DEMO_SUPPLIER_TAX_ID, confidence: 0.97, page: 1 });
    assert.deepEqual(result.fields.total, { value: "205.70", confidence: 0.88, page: 1 });
    assert.equal(result.fields.dueDate, undefined, "value null se omite");
    assert.equal(result.fields.inventado, undefined, "claves fuera del esquema se descartan");
    assert.equal((result.fields.lines?.value as unknown[]).length, 1);
    assert.deepEqual(result.warnings, []);
  });

  it("denied → reglas (text_rules) con aviso ai_denied:<motivo>; excepción del runner → reglas con runner_error", async () => {
    const denied = createAiCoreDocumentsPort({ runTool: fakeRunner([], { extract: { status: "denied", reason: "module_disabled", message: "Módulo apagado.", riskLevel: "medium" } }), core: fakeCore() });
    const result = await denied.extract({ kind: "invoice", text: invoiceText, pdfBase64: "JVBERi0=", pageCount: 1, sha256: SHA }, ctx);
    assert.equal(result.source, "text_rules");
    assert.equal(result.warnings[0], "ai_denied:module_disabled");
    assert.equal(result.fields.supplierTaxId?.value, DEMO_SUPPLIER_TAX_ID, "las reglas siguen extrayendo del texto");
    assert.equal(result.telemetry, null);

    const throwing = createAiCoreDocumentsPort({ runTool: fakeRunner([], { throwError: new ForbiddenError("Presupuesto mensual de IA agotado.", { code: "AI_BUDGET_EXCEEDED" }) }), core: fakeCore() });
    const failed = await throwing.extract({ kind: "invoice", text: invoiceText, pdfBase64: "JVBERi0=", pageCount: 1, sha256: SHA }, ctx);
    assert.equal(failed.source, "text_rules");
    assert.equal(failed.warnings[0], "runner_error:AI_BUDGET_EXCEEDED");
  });

  it("letter / administrative_notice / contract solo van al modelo si aiAllowedKinds los incluye; XML y sin bytes → reglas", async () => {
    const captured: Captured[] = [];
    const port = createAiCoreDocumentsPort({ runTool: fakeRunner(captured), core: fakeCore({ data: { subject: { value: "Asunto", confidence: 0.9, page: 1 } } }) });
    assert.deepEqual([...AI_RESTRICTED_KINDS], ["letter", "administrative_notice", "contract"]);
    const restricted = await port.extract({ kind: "letter", text: "Carta", pdfBase64: "JVBERi0=", pageCount: 1, sha256: SHA, aiAllowedKinds: ["invoice"] }, ctx);
    assert.equal(restricted.source, "text_rules");
    assert.equal(restricted.warnings[0], "kind_not_allowed_for_ai:letter");
    assert.equal(captured.length, 0);

    const allowed = await port.extract({ kind: "letter", text: "Carta", pdfBase64: "JVBERi0=", pageCount: 1, sha256: SHA, aiAllowedKinds: ["letter"] }, ctx);
    assert.equal(allowed.source, "ai");
    assert.equal(captured.length, 1);
    const everything = await port.extract({ kind: "administrative_notice", text: "Notificación", pdfBase64: "JVBERi0=", pageCount: 1, sha256: SHA, aiAllowedKinds: [] }, ctx);
    assert.equal(everything.source, "ai", "[] = todos los tipos");
    assert.equal(schemaFor("contract"), LETTER_SCHEMA);

    const xml = await port.extract({ kind: "invoice", xml: "<?xml version=\"1.0\"?><x/>", pageCount: 1, sha256: SHA }, ctx);
    assert.equal(xml.source, "text_rules");
    const noBytes = await port.extract({ kind: "invoice", text: invoiceText, pageCount: 1, sha256: SHA }, ctx);
    assert.equal(noBytes.warnings[0], "no_document_bytes_for_ai");
    assert.equal(captured.length, 2);
  });

  it("más de 20 imágenes → tramos de 20 con desplazamiento de página y telemetría sumada", async () => {
    const captured: Captured[] = [];
    const port = createAiCoreDocumentsPort({ runTool: fakeRunner(captured), core: fakeCore() });
    const pages = Array.from({ length: 45 }, () => ({ mediaType: "image/jpeg", base64: "/9j/4AAQ" }));
    const result = await port.extract({ kind: "invoice", pages, pageCount: 45, sha256: SHA }, ctx);
    assert.equal(captured.length, 3);
    assert.equal((captured[0]!.input as { pages: unknown[] }).pages.length, PAGES_PER_CHUNK);
    assert.equal((captured[2]!.input as { pages: unknown[] }).pages.length, 5);
    assert.equal(result.source, "ai");
    assert.ok(result.warnings.includes("multi_chunk:3"));
    assert.deepEqual(result.toolCallIds, ["call_1", "call_2", "call_3"]);
    assert.equal(result.telemetry?.tokensInput, 360);
    assert.equal(result.telemetry?.costEur, Number((0.0013 * 3).toFixed(4)));
    assert.equal(result.fields.supplierTaxId?.page, 1, "el primer tramo manda en los campos escalares");
    assert.equal((result.fields.lines?.value as unknown[]).length, 3, "las listas se concatenan");
  });

  it("normalizeModelFields y mergeChunkFields son puras", () => {
    const fields = normalizeModelFields("invoice", { total: { value: "10.00", confidence: 1.7, page: 2 }, base: { value: null, confidence: 1, page: 1 }, lines: { value: [], confidence: 1, page: 1 }, ajena: { value: 1, confidence: 1 } }, 20);
    assert.deepEqual(fields, { total: { value: "10.00", confidence: 1, page: 22 } });
    const merged = mergeChunkFields([{ total: { value: "1.00", confidence: 0.9 }, deliveryNoteRefs: { value: ["A"], confidence: 0.8 } }, { total: { value: "2.00", confidence: 0.5 }, deliveryNoteRefs: { value: ["B"], confidence: 0.6 } }]);
    assert.deepEqual(merged, { total: { value: "1.00", confidence: 0.9 }, deliveryNoteRefs: { value: ["A", "B"], confidence: 0.6 } });
    const user = pipelineUserContext({ organizationId: "o", propertyId: "p", correlationId: "c" });
    assert.equal(user.userId, "documents-pipeline");
    assert.deepEqual(user.permissions, ["ai.tool.execute"]);
  });
});
