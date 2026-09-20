/**
 * Tanda T9 · lote T9-06a — pipeline de documentos (clasificar → extraer →
 * validar → proponer) por app.inject sobre Postgres real con un tenant AISLADO
 * (helpers/l2-tenant.mts). Faranda y org_123 solo se leen; las invariantes de
 * Faranda son idénticas antes y después.
 *
 * Con provider none (el .env del carril no configura AI_PROVIDER):
 *   · subir la factura demo (fixture FICTICIA de modules/documents/__tests__/fixtures.ts)
 *     → POST …/extract 200 configured:false, extraction.source text_rules con NIF y total,
 *     checks (7) y proposal create_supplier_bill; GET …/documents/:id lo refleja;
 *   · NIF inválido → checks.nif fail; IVA 5 % → checks.vat fail / needsManual;
 *   · la misma factura reenviada con allowDuplicate → checks.duplicate ≠ ok con enlace al original;
 *   · XML Facturae → kind invoice con confianza 1, source e_invoice y propuesta con líneas;
 *   · ai_human_review_items +1 por documento (reviewType incoming_document), una sola vez;
 *   · POST …/classify solo reclasifica; 404 opaco desde otra organización; force → 503.
 * Con proveedor SIMULADO (ai-core falso, runner REAL): ai_tool_calls +2 por extracción
 * (classify + extract), input_json sin base64 y output_json.record sin bytes.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/documents-pipeline.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;
type FarandaInvariants = Awaited<ReturnType<typeof farandaInvariants>>;

const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetDocumentsAiPort, setDocumentsAiPort } = await import("../../apps/api/src/modules/documents/documents-ai.port.js");
const { createAiCoreDocumentsPort } = await import("../../apps/api/src/modules/documents/documents-ai.core-adapter.js");
const { runDocumentPipeline } = await import("../../apps/api/src/modules/documents/pipeline.service.js");
const fixtures = await import("../../apps/api/src/modules/documents/__tests__/fixtures.ts");
const { DEMO_SUPPLIER_TAX_ID, DEMO_LINES, demoInvoicePdf, facturaeXml } = fixtures;
type AiCore = import("@hotelos/ai-core").AiCore;

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type Reply = { status: number; body: Json };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);
const RUN = `dp${newRunId()}`;

async function call(app: ApiApp, method: "GET" | "POST", url: string, session: Session, propertyId: string, payload?: unknown): Promise<Reply> {
  const res = await app.inject({ method, url, headers: { ...session.headers, "x-property-id": propertyId }, ...(payload === undefined ? {} : { payload }) });
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body };
}

const detailsCode = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;

async function upload(app: ApiApp, session: Session, propertyId: string, file: { fileName: string; mimeType: string; bytes: Buffer }, extra: Json = {}): Promise<string> {
  const reply = await call(app, "POST", `/properties/${propertyId}/documents`, session, propertyId, { files: [{ fileName: file.fileName, mimeType: file.mimeType, base64: file.bytes.toString("base64") }], ...extra });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  const records = reply.body as unknown as Array<{ id: string }>;
  assert.ok(Array.isArray(records) && records.length === 1);
  return records[0]!.id;
}

/** Espera a que el pipeline en segundo plano (onCaptured) termine (extractionStatus ≠ pending). */
async function waitForBackground(documentId: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const row = await prisma.incomingDocument.findUnique({ where: { id: documentId }, select: { extractionStatus: true } });
    if (row && row.extractionStatus !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`El pipeline en segundo plano no terminó para ${documentId}.`);
}

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
let manager: Session;
let managerB: Session;
let invariantsBefore: FarandaInvariants;
let invoiceId = "";
let reviewsBefore = 0;

describe("T9-06a · pipeline de documentos (tenant aislado, provider none)", () => {
  before(async () => {
    invariantsBefore = await farandaInvariants();
    resetDocumentsAiPort();
    app = await buildApiServer();
    A = await createIsolatedTenant(RUN);
    B = await createIsolatedTenant(`${RUN}b`);
    await enableModules(A.propertyA, ["compliance_hub", "erp_accounting"]);
    await strict(async () => {
      manager = await loginOrThrow(app, A.users.generalManager.email, A.password);
      managerB = await loginOrThrow(app, B.users.generalManager.email, B.password);
    });
    reviewsBefore = await prisma.aiHumanReviewItem.count({ where: { organizationId: A.organizationId } });
  });

  after(async () => {
    resetDocumentsAiPort();
    try {
      await flushAuditQueues();
      if (A) await cleanupTenant(A.organizationId);
      if (B) await cleanupTenant(B.organizationId);
    } finally {
      await app?.close();
    }
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  });

  it("factura PDF: extract 200 configured:false, source text_rules con NIF y total, 7 checks y propuesta create_supplier_bill; GET lo refleja; cola +1 una sola vez", async () => {
    invoiceId = await upload(app, manager, A.propertyA, { fileName: "factura-demo.pdf", mimeType: "application/pdf", bytes: demoInvoicePdf() });
    await waitForBackground(invoiceId);
    const reply = await call(app, "POST", `/properties/${A.propertyA}/documents/${invoiceId}/extract`, manager, A.propertyA, {});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.configured, false);
    const extraction = reply.body.extraction as Json;
    assert.equal(extraction.source, "text_rules");
    assert.equal(extraction.status, "done");
    assert.equal(extraction.provider, null);
    assert.ok(Number(extraction.runNo) >= 2, "la captura ya ejecutó runNo 1 en segundo plano");
    const fields = extraction.fields as Record<string, { value: unknown; confidence: number }>;
    assert.equal(fields.supplierTaxId?.value, DEMO_SUPPLIER_TAX_ID);
    assert.equal(fields.total?.value, "205.70");
    assert.equal(fields.invoiceNumber?.value, "F-2026-0042");
    const checks = reply.body.checks as Record<string, { status: string }>;
    assert.deepEqual(Object.keys(checks).sort(), ["duplicate", "match", "nif", "retention", "supplier", "totals", "vat"]);
    assert.equal(checks.nif!.status, "ok");
    assert.equal(checks.totals!.status, "ok");
    assert.equal(checks.vat!.status, "ok");
    assert.equal(checks.duplicate!.status, "ok");
    const proposal = reply.body.proposal as Json;
    assert.equal(proposal.action, "create_supplier_bill");
    const bill = proposal.supplierBill as { supplierTaxId: string; invoiceNumber: string; lines: unknown[]; source: string; incomingDocumentId: string };
    assert.equal(bill.supplierTaxId, DEMO_SUPPLIER_TAX_ID);
    assert.equal(bill.invoiceNumber, "F-2026-0042");
    assert.equal(bill.lines.length, DEMO_LINES.length);
    assert.equal(bill.source, "digitized");
    assert.equal(bill.incomingDocumentId, invoiceId);
    assert.equal((reply.body.classification as Json).kind, "invoice");
    assert.equal((reply.body.autonomy as Json).level, "suggest_and_confirm");

    const detail = await call(app, "GET", `/properties/${A.propertyA}/documents/${invoiceId}`, manager, A.propertyA);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.kind, "invoice");
    assert.equal(detail.body.classificationSource, "rules");
    assert.equal(detail.body.extractionStatus, "done");
    assert.equal(detail.body.supplierTaxId, DEMO_SUPPLIER_TAX_ID);
    assert.equal(detail.body.documentNumber, "F-2026-0042");
    assert.equal(detail.body.totalAmount, "205.70");
    assert.equal(detail.body.proposedAction, "create_supplier_bill");
    assert.equal((detail.body.extraction as Json).source, "text_rules");
    assert.equal((detail.body.extraction as Json).runNo, extraction.runNo);
    assert.ok(detail.body.checks && (detail.body.checks as Json).nif);
    assert.equal((detail.body.proposal as Json).action, "create_supplier_bill");
    assert.equal(typeof detail.body.reviewItemId, "string");

    const reviews = await prisma.aiHumanReviewItem.findMany({ where: { organizationId: A.organizationId, relatedEntityId: invoiceId } });
    assert.equal(reviews.length, 1, "una sola revisión por documento aunque el pipeline corra dos veces");
    assert.equal(reviews[0]!.reviewType, "incoming_document");
    assert.equal(reviews[0]!.relatedEntityType, "incoming_document");
    assert.equal(reviews[0]!.propertyId, A.propertyA);
    assert.equal(reviews[0]!.status, "pending");
    assert.equal((reviews[0]!.payloadJson as Json).registryNumber, detail.body.registryNumber);
    assert.equal(await prisma.aiHumanReviewItem.count({ where: { organizationId: A.organizationId } }), reviewsBefore + 1);
    assert.equal(await prisma.documentExtraction.count({ where: { documentId: invoiceId } }), Number(extraction.runNo));
    const pages = await prisma.documentPage.findMany({ where: { documentId: invoiceId } });
    assert.equal(pages.length, 1);
    assert.match(pages[0]!.textExtracted ?? "", /FACTURA/);
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: invoiceId } });
    assert.match(row.searchText ?? "", /F-2026-0042/);
    assert.equal(row.reviewedFieldsJson, null);
  });

  it("NIF inválido → checks.nif fail y propuesta create_expense; IVA 5 % → checks.vat fail con needsManual", async () => {
    const badNif = await upload(app, manager, A.propertyA, { fileName: "factura-nif-malo.pdf", mimeType: "application/pdf", bytes: demoInvoicePdf({ taxId: "B76543210", number: "F-2026-0043" }) });
    await waitForBackground(badNif);
    const bad = await call(app, "POST", `/properties/${A.propertyA}/documents/${badNif}/extract`, manager, A.propertyA, {});
    assert.equal(bad.status, 200, JSON.stringify(bad.body));
    const badChecks = bad.body.checks as Record<string, { status: string }>;
    assert.equal(badChecks.nif!.status, "fail");
    assert.equal((bad.body.proposal as Json).action, "create_expense");

    const vat5 = await upload(app, manager, A.propertyA, { fileName: "factura-iva5.pdf", mimeType: "application/pdf", bytes: demoInvoicePdf({ number: "F-2026-0044", lines: [{ description: "Servicio con tipo no soportado", quantity: 1, unitPrice: 100, taxRate: 5 }] }) });
    await waitForBackground(vat5);
    const vat = await call(app, "POST", `/properties/${A.propertyA}/documents/${vat5}/extract`, manager, A.propertyA, {});
    assert.equal(vat.status, 200, JSON.stringify(vat.body));
    const vatCheck = (vat.body.checks as Record<string, { status: string; details?: Json }>).vat!;
    assert.equal(vatCheck.status, "fail");
    assert.equal(vatCheck.details?.needsManual, true);
  });

  it("misma factura reenviada con allowDuplicate → checks.duplicate ≠ ok con enlace al original", async () => {
    const again = await call(app, "POST", `/properties/${A.propertyA}/documents`, manager, A.propertyA, { files: [{ fileName: "factura-demo.pdf", mimeType: "application/pdf", base64: demoInvoicePdf().toString("base64") }] });
    assert.equal(again.status, 409);
    assert.equal(detailsCode(again), "DOCUMENT_DUPLICATE_FILE");
    const copyId = await upload(app, manager, A.propertyA, { fileName: "factura-demo.pdf", mimeType: "application/pdf", bytes: demoInvoicePdf() }, { allowDuplicate: true });
    await waitForBackground(copyId);
    const reply = await call(app, "POST", `/properties/${A.propertyA}/documents/${copyId}/extract`, manager, A.propertyA, {});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const duplicate = (reply.body.checks as Record<string, { status: string; details?: Json }>).duplicate!;
    assert.notEqual(duplicate.status, "ok");
    assert.equal(duplicate.details?.documentId, invoiceId, "enlace al documento original (mismo sha256)");
  });

  it("XML Facturae → kind invoice con confianza 1, source e_invoice y propuesta create_supplier_bill con líneas", async () => {
    const xmlId = await upload(app, manager, A.propertyA, { fileName: "factura.xml", mimeType: "application/xml", bytes: Buffer.from(facturaeXml({ number: "F-2026-0045" }), "utf8") });
    await waitForBackground(xmlId);
    const reply = await call(app, "POST", `/properties/${A.propertyA}/documents/${xmlId}/extract`, manager, A.propertyA, {});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal((reply.body.extraction as Json).source, "e_invoice");
    assert.deepEqual(reply.body.classification, { kind: "invoice", confidence: 1, source: "rules", note: "e_invoice:facturae" });
    const proposal = reply.body.proposal as { action: string; supplierBill?: { lines: unknown[]; source: string } };
    assert.equal(proposal.action, "create_supplier_bill");
    assert.equal(proposal.supplierBill?.lines.length, DEMO_LINES.length);
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: xmlId } });
    assert.equal(row.kind, "invoice");
    assert.equal(Number(row.kindConfidence), 1);
    assert.equal(row.documentNumber, "F-2026-0045");
    // RV-08 (§4.1 / §6.1): una Facturae subida por el back office entra como e_invoice sin papel que meter en la valija.
    assert.equal(row.source, "e_invoice");
    assert.equal(row.physicalStatus, "not_applicable");
    assert.equal(proposal.supplierBill?.source, "e_invoice");
  });

  it("classify solo reclasifica (sin ejecución nueva); 404 opaco desde otra organización; force sin proveedor → 503 AI_PROVIDER_UNAVAILABLE; cuerpo inválido → 400", async () => {
    const runsBefore = await prisma.documentExtraction.count({ where: { documentId: invoiceId } });
    const classify = await call(app, "POST", `/properties/${A.propertyA}/documents/${invoiceId}/classify`, manager, A.propertyA, {});
    assert.equal(classify.status, 200, JSON.stringify(classify.body));
    assert.equal((classify.body.classification as Json).kind, "invoice");
    assert.equal((classify.body.extraction as Json).runNo, runsBefore, "devuelve la última ejecución existente");
    assert.equal(await prisma.documentExtraction.count({ where: { documentId: invoiceId } }), runsBefore);

    const foreign = await call(app, "POST", `/properties/${B.propertyA}/documents/${invoiceId}/extract`, managerB, B.propertyA, {});
    assert.equal(foreign.status, 404);
    const forced = await call(app, "POST", `/properties/${A.propertyA}/documents/${invoiceId}/extract`, manager, A.propertyA, { force: true });
    assert.equal(forced.status, 503);
    assert.equal(detailsCode(forced), "AI_PROVIDER_UNAVAILABLE");
    const invalid = await call(app, "POST", `/properties/${A.propertyA}/documents/${invoiceId}/extract`, manager, A.propertyA, { force: "sí" });
    assert.equal(invalid.status, 400);
    assert.equal(detailsCode(invalid), "VALIDATION_ERROR");
    assert.equal(await prisma.documentExtraction.count({ where: { documentId: invoiceId } }), runsBefore, "ni el 503 ni el 400 crean ejecuciones");
  });

  it("con proveedor simulado y runner real: ai_tool_calls +2 (classify + extract), input_json sin base64 y record sin bytes; extracción source ai con coste", async () => {
    const seen: string[] = [];
    const usage = { tokensInput: 300, tokensOutput: 80, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const success = { configured: true as const, provider: "anthropic" as const, model: "claude-sonnet-5", usage, tokensInput: 300, tokensOutput: 80, costUsd: 0.002, costEur: 0.0018, latencyMs: 120, stopReason: "end_turn", truncated: false, toolUses: [] };
    const core = {
      isConfigured: () => true,
      providerName: () => "anthropic",
      modelName: () => "claude-sonnet-5",
      structured: async () => ({ ...success, data: { kind: "invoice", confidence: 0.91 } }),
      extractFromDocument: async (input: { pdfBase64?: string; pages?: unknown[]; schema: unknown }) => {
        seen.push(input.pdfBase64 ? "pdf" : "pages");
        return { ...success, data: { supplierTaxId: { value: DEMO_SUPPLIER_TAX_ID, confidence: 0.99, page: 1 }, invoiceNumber: { value: "F-2026-0042", confidence: 0.95, page: 1 }, total: { value: "205.70", confidence: 0.9, page: 1 } }, document: { pages: 1, bytes: 1024, sha256: "deadbeef" } };
      }
    } as unknown as AiCore;
    setDocumentsAiPort(createAiCoreDocumentsPort({ core: () => core }));
    try {
      const callsBefore = await prisma.aiToolCall.count({ where: { organizationId: A.organizationId } });
      const result = await runDocumentPipeline(invoiceId, { trigger: "manual", correlationId: `corr_${RUN}_ai`, userId: A.users.generalManager.id });
      assert.equal(result.configured, true);
      assert.equal(result.provider, "anthropic");
      assert.equal(result.classification.source, "rules", "classify usa el ejecutor L6a (getAiCore real, sin proveedor) → reglas con nota honesta");
      assert.equal(result.extraction?.source, "ai", "extract usa el execute explícito sobre el núcleo simulado");
      assert.equal(result.extraction?.provider, "anthropic");
      assert.equal(result.extraction?.modelVersion, "claude-sonnet-5");
      assert.equal(result.extraction?.costEur, "0.0018");
      assert.equal(result.extraction?.tokensInput, 300);
      assert.deepEqual(seen, ["pdf"]);
      const calls = await prisma.aiToolCall.findMany({ where: { organizationId: A.organizationId }, orderBy: { createdAt: "asc" } });
      assert.equal(calls.length - callsBefore, 2, "classify (denegado/no configurado por el runner real) + extract");
      const extractCall = calls.find((row) => row.toolName === "extractIncomingDocumentFields");
      assert.ok(extractCall, "fila ai_tool_calls de la extracción");
      assert.equal(extractCall.status, "succeeded");
      assert.equal(Number(extractCall.costEur), 0.0018);
      // El runner sustituye cualquier base64 por «<base64 omitido, n caracteres>»: input_json y output_json nunca llevan los bytes
      // (JVBERi0 = «%PDF-» en base64; la clave `pdfBase64` es la del esquema L6a, no un payload).
      for (const row of calls) {
        const inputJson = JSON.stringify(row.inputJson);
        assert.doesNotMatch(inputJson, /JVBERi0|[A-Za-z0-9+/]{200,}/, `${row.toolName}: input_json sin bytes`);
        assert.doesNotMatch(JSON.stringify(row.outputJson), /JVBERi0|[A-Za-z0-9+/]{200,}/, `${row.toolName}: output_json sin bytes`);
        const input = row.inputJson as { pdfBase64?: string };
        if (input.pdfBase64 !== undefined) assert.match(input.pdfBase64, /^<base64 omitido, \d+ caracteres>$/);
      }
      const output = extractCall.outputJson as { output?: { pages?: number; sha256?: string; kind?: string } };
      assert.equal(output.output?.kind, "invoice");
      assert.equal(output.output?.pages, 1);
      const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: invoiceId } });
      assert.equal(row.supplierTaxId, DEMO_SUPPLIER_TAX_ID);
      assert.equal(await prisma.aiHumanReviewItem.count({ where: { organizationId: A.organizationId, relatedEntityId: invoiceId } }), 1, "sigue habiendo una sola revisión");
    } finally {
      resetDocumentsAiPort();
    }
  });
});
