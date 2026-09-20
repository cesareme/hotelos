// Unit tests · Tanda T9 · lote T9-06a — pipeline con respaldo honesto
// (pipeline.service.ts) sobre un Prisma SIMULADO en memoria y sin almacén
// (fichero inline). Sin Postgres, sin red, sin proveedor de IA (provider none).
// Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/pipeline-fallback.test.mts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { HttpError } from "../../../lib/http-error.js";
import type { PropertyAiSettings } from "../../ai-operations/property-ai.service.js";
import { resetDocumentsAiPort } from "../documents-ai.port.js";
import {
  AI_PROVIDER_UNAVAILABLE,
  DOCUMENT_PIPELINE_AUDIT_ACTIONS,
  applyReviewedFields,
  buildPipelineSearchText,
  contentOf,
  normalizeExtractedFields,
  parseSourcePages,
  proposeDocumentAction,
  resetDocumentPipelineForTests,
  runDocumentPipeline,
  selectSourcePages,
  swapOwnTaxId
} from "../pipeline.service.js";
import { DOCUMENT_AUDIT_ACTIONS } from "../documents-audit.js";
import { encodeInline, sha256Hex } from "../storage/inline-storage.js";
import { DEMO_CUSTOMER_TAX_ID, DEMO_SUPPLIER_TAX_ID, cifFor, demoInvoicePdf, facturaeXml, imageOnlyPdf, multiInvoicePdf } from "./fixtures.ts";

type Row = Record<string, unknown>;

const ORG = "org_pipe_test";
const PROP = "prop_pipe_test";
const DOC = "doc_pipe_test";
const NOW = new Date("2026-09-19T10:00:00.000Z");

/** Prisma en memoria: solo las operaciones que usa el pipeline. */
function fakePrisma(seed: { document: Row; file: Row; settings?: Row | null; supplier?: Row | null; bills?: Row[]; twin?: Row | null }) {
  const documents = new Map<string, Row>([[seed.document.id as string, { ...seed.document }]]);
  const extractions: Row[] = [];
  const pages = new Map<number, Row>();
  const audit: Row[] = [];
  let ids = 0;
  const api = {
    incomingDocument: {
      findUnique: async ({ where }: { where: { id: string } }) => documents.get(where.id) ?? null,
      findFirst: async ({ where }: { where: Row }) => (where.sha256 && seed.twin ? seed.twin : null),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = documents.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: { id: string; reviewItemId?: null; status?: string }; data: Row }) => {
        const row = documents.get(where.id)!;
        if (where.reviewItemId === null && row.reviewItemId) return { count: 0 };
        if (where.status !== undefined && row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }
    },
    // office-notifications.ts (envío automático): sin claves en este Prisma simulado → nadie que avisar.
    permission: { findUnique: async () => null },
    documentFile: { findMany: async () => [seed.file] },
    documentExtraction: {
      findFirst: async () => (extractions.length > 0 ? extractions[extractions.length - 1] : null),
      findUnique: async ({ where }: { where: { id: string } }) => extractions.find((row) => row.id === where.id) ?? null,
      create: async ({ data }: { data: Row }) => {
        ids += 1;
        const row = { id: `ext_${ids}`, provider: null, modelVersion: null, schemaVersion: 1, fieldsJson: {}, confidenceJson: {}, warningsJson: [], tokensInput: null, tokensOutput: null, costEur: null, durationMs: null, error: null, status: "done", createdAt: NOW, ...data };
        extractions.push(row);
        return row;
      }
    },
    documentPage: {
      upsert: async ({ where, create }: { where: { documentId_pageNo: { pageNo: number } }; create: Row }) => {
        pages.set(where.documentId_pageNo.pageNo, create);
        return create;
      },
      findMany: async () => [...pages.values()]
    },
    property: { findUnique: async () => ({ id: PROP, code: "HTL", kind: "hotel", organizationId: ORG, legalEntityId: "le_pipe" }) },
    documentSettings: { findUnique: async () => seed.settings ?? null },
    supplier: { findFirst: async () => seed.supplier ?? null },
    supplierBill: { findMany: async () => seed.bills ?? [] },
    goodsReceipt: { findMany: async () => [] },
    legalEntity: { findMany: async () => [{ id: "le_pipe", taxId: DEMO_CUSTOMER_TAX_ID }] },
    propertyAiToolSetting: { findUnique: async () => null },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(api)
  };
  return { api, documents, extractions, pages, audit };
}

function inlineFile(bytes: Buffer, mimeType: string, fileName: string): Row {
  return { id: "file_pipe", documentId: DOC, role: "original", pageNo: null, fileName, mimeType, sizeBytes: bytes.length, sha256: sha256Hex(bytes), storageKind: "inline", storageKey: null, inline: encodeInline(bytes), encrypted: false, uploadedBy: null, createdAt: NOW };
}

function document(overrides: Row = {}): Row {
  return {
    id: DOC,
    organizationId: ORG,
    legalEntityId: "le_pipe",
    propertyId: PROP,
    registryNumber: "DOC-HTL-2026-000001",
    registryYear: 2026,
    registrySeq: 1,
    kind: "unknown",
    kindConfidence: null,
    classificationSource: null,
    status: "captured",
    physicalStatus: "at_centre",
    source: "upload",
    originalFormat: "application/pdf",
    title: null,
    sha256: "0".repeat(64),
    sizeBytes: 1,
    pageCount: 0,
    supplierId: null,
    supplierTaxId: null,
    documentNumber: null,
    documentDate: null,
    totalAmount: null,
    currency: "EUR",
    extractionStatus: "pending",
    proposedAction: null,
    proposedActionJson: {},
    checksJson: [],
    reviewedFieldsJson: { supplierName: "Corregido por la oficina" },
    searchText: "DOC-HTL-2026-000001",
    reviewItemId: null,
    capturedAt: NOW,
    deletedAt: null,
    mergedIntoId: null,
    ...overrides
  };
}

const SETTINGS: PropertyAiSettings = { propertyId: PROP, aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", guestFacingDisclosure: null, voiceLocales: [], configurationJson: {}, updatedAt: null, isDefault: true };

type Harness = ReturnType<typeof fakePrisma> & { reviews: Row[]; audits: Row[] };

function harness(seed: Parameters<typeof fakePrisma>[0]): Harness {
  const fake = fakePrisma(seed);
  const reviews: Row[] = [];
  const audits: Row[] = [];
  resetDocumentsAiPort();
  resetDocumentPipelineForTests({
    db: fake.api as unknown as Parameters<typeof resetDocumentPipelineForTests>[0] extends infer T ? (T extends { db?: infer D } ? D : never) : never,
    storage: () => {
      throw new Error("el fichero es inline: el almacén no debe usarse");
    },
    enqueueReview: (async (input: Row) => {
      reviews.push(input);
      return { id: `rev_${reviews.length}` } as never;
    }) as never,
    getPropertyAiSettings: async () => SETTINGS,
    findSageSupplierByNif: async () => null,
    findSageReceivedByNifAndNumber: async () => [],
    findSageReceivedFuzzy: async () => [],
    audit: ((input: Row) => {
      audits.push(input);
      return { id: `aud_${audits.length}` } as never;
    }) as never,
    now: () => NOW
  });
  return { ...fake, reviews, audits };
}

describe("runDocumentPipeline sin proveedor (provider none)", () => {
  beforeEach(() => resetDocumentsAiPort());
  afterEach(() => {
    resetDocumentPipelineForTests();
    resetDocumentsAiPort();
  });

  it("factura PDF: configured:false, source text_rules, runNo 1 y 2, cola una sola vez, reviewedFieldsJson intacto y force → 503", async () => {
    const pdf = demoInvoicePdf({ retentionRate: 15 });
    const h = harness({ document: document(), file: inlineFile(pdf, "application/pdf", "factura.pdf") });

    const first = await runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_1" });
    assert.equal(first.configured, false);
    assert.equal(first.provider, "none");
    assert.deepEqual(first.classification, { kind: "invoice", confidence: 0.95, source: "rules" });
    assert.ok(first.extraction);
    assert.equal(first.extraction.runNo, 1);
    assert.equal(first.extraction.source, "text_rules");
    assert.equal(first.extraction.status, "done");
    assert.equal(first.extraction.provider, null);
    assert.equal(first.extraction.fields.supplierTaxId && (first.extraction.fields.supplierTaxId as { value: string }).value, DEMO_SUPPLIER_TAX_ID);
    assert.equal(first.extraction.confidence.supplierTaxId, 0.9);
    assert.ok(first.extraction.warnings.includes("text_rules_limited_coverage"));
    assert.ok(first.checks);
    assert.equal(first.checks.nif.status, "ok");
    assert.equal(first.checks.duplicate.status, "ok");
    assert.equal(first.proposal?.action, "create_supplier_bill");
    assert.deepEqual(first.autonomy, { level: "suggest_and_confirm", enabled: true, wouldAutoArchive: false, wouldCreateDraft: false });

    const row = h.documents.get(DOC)!;
    assert.equal(row.kind, "invoice");
    assert.equal(row.classificationSource, "rules");
    assert.equal(row.kindConfidence, "0.9500");
    assert.equal(row.supplierTaxId, DEMO_SUPPLIER_TAX_ID);
    assert.equal(row.documentNumber, "F-2026-0042");
    assert.equal((row.documentDate as Date).toISOString().slice(0, 10), "2026-09-10");
    assert.equal(row.totalAmount, "180.20");
    assert.equal(row.extractionStatus, "done");
    assert.equal(row.proposedAction, "create_supplier_bill");
    assert.equal((row.proposedActionJson as { autonomy: { level: string } }).autonomy.level, "suggest_and_confirm");
    assert.ok((row.proposedActionJson as { supplierBill?: { lines: unknown[] } }).supplierBill?.lines.length === 2);
    assert.deepEqual(row.reviewedFieldsJson, { supplierName: "Corregido por la oficina" }, "reviewedFieldsJson nunca se pisa");
    assert.match(row.searchText as string, /DOC-HTL-2026-000001/);
    assert.match(row.searchText as string, /F-2026-0042/);
    assert.equal(row.pageCount, 1);
    assert.equal(row.reviewItemId, "rev_1");
    assert.equal(h.pages.get(1)?.textExtracted && String(h.pages.get(1)!.textExtracted).includes("FACTURA"), true);
    assert.equal(h.reviews.length, 1);
    assert.equal(h.reviews[0]!.reviewType, "incoming_document");
    assert.equal(h.reviews[0]!.relatedEntityType, "incoming_document");
    assert.equal(h.reviews[0]!.relatedEntityId, DOC);
    const payload = h.reviews[0]!.payloadJson as Row;
    assert.equal(payload.kind, "invoice");
    assert.equal(payload.supplierTaxId, DEMO_SUPPLIER_TAX_ID);
    assert.equal(payload.total, 180.2);
    assert.equal(payload.registryNumber, "DOC-HTL-2026-000001");
    assert.deepEqual((payload.checks as Row).nif, "ok");
    assert.deepEqual(h.audits.map((a) => a.action), [DOCUMENT_PIPELINE_AUDIT_ACTIONS.classified, DOCUMENT_PIPELINE_AUDIT_ACTIONS.extracted]);
    assert.equal(h.audits[0]!.actorType, "system");
    assert.doesNotMatch(JSON.stringify(h.audits), /Lavander|JVBERi0/, "auditoría sin texto ni bytes");

    const second = await runDocumentPipeline(DOC, { trigger: "manual", correlationId: "corr_2", userId: "usr_office" });
    assert.equal(second.extraction?.runNo, 2);
    assert.equal(h.extractions.length, 2);
    assert.equal(h.reviews.length, 1, "la cola se encola una sola vez por documento");
    assert.equal(h.documents.get(DOC)!.reviewItemId, "rev_1");

    await assert.rejects(runDocumentPipeline(DOC, { trigger: "manual", correlationId: "corr_3", force: true }), (error: HttpError) => {
      assert.equal(error.statusCode, 503);
      assert.equal((error.details as { code: string }).code, AI_PROVIDER_UNAVAILABLE);
      return true;
    });
    assert.equal(h.extractions.length, 2, "force sin proveedor no crea ejecución");
  });

  it("XML Facturae: kind invoice con confianza 1, source e_invoice y propuesta create_supplier_bill con líneas", async () => {
    const xml = Buffer.from(facturaeXml(), "utf8");
    const h = harness({ document: document({ originalFormat: "application/xml", source: "e_invoice" }), file: inlineFile(xml, "application/xml", "factura.xml") });
    const result = await runDocumentPipeline(DOC, { trigger: "email", correlationId: "corr_xml" });
    assert.deepEqual(result.classification, { kind: "invoice", confidence: 1, source: "rules", note: "e_invoice:facturae" });
    assert.equal(result.extraction?.source, "e_invoice");
    assert.equal(result.extraction?.confidence.total, 1);
    assert.equal(result.proposal?.action, "create_supplier_bill");
    const bill = result.proposal?.supplierBill;
    assert.ok(bill);
    assert.equal(bill.lines.length, 2);
    assert.equal(bill.source, "e_invoice");
    assert.equal(h.documents.get(DOC)!.kindConfidence, "1.0000");
  });

  it("no pisa un tipo fijado por una persona, y stage classify solo reclasifica sin crear ejecución", async () => {
    const pdf = demoInvoicePdf();
    const h = harness({ document: document({ kind: "letter", classificationSource: "manual" }), file: inlineFile(pdf, "application/pdf", "carta.pdf") });
    const result = await runDocumentPipeline(DOC, { trigger: "manual", correlationId: "corr_manual" });
    assert.equal(result.classification.source, "manual");
    assert.equal(result.classification.kind, "letter");
    assert.equal(h.documents.get(DOC)!.kind, "letter");
    assert.equal(result.proposal?.action, "archive");
    assert.deepEqual(h.audits.map((a) => a.action), [DOCUMENT_PIPELINE_AUDIT_ACTIONS.extracted]);

    const h2 = harness({ document: document(), file: inlineFile(pdf, "application/pdf", "factura.pdf") });
    const classified = await runDocumentPipeline(DOC, { trigger: "manual", correlationId: "corr_cls", stage: "classify" });
    assert.equal(classified.classification.kind, "invoice");
    assert.equal(classified.extraction, null);
    assert.equal(h2.extractions.length, 0);
    assert.equal(h2.documents.get(DOC)!.kind, "invoice");
    assert.equal(h2.reviews.length, 0);
  });

  it("PDF sin capa de texto: unknown 0, extracción vacía con aviso, y el fallo de almacén queda failed con error en la fila", async () => {
    const pdf = imageOnlyPdf();
    const h = harness({ document: document(), file: inlineFile(pdf, "application/pdf", "escaneo.pdf") });
    const result = await runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_img" });
    assert.equal(result.classification.kind, "unknown");
    assert.equal(result.classification.confidence, 0);
    assert.equal(result.extraction?.source, "text_rules");
    assert.ok(result.extraction?.warnings.includes("pdf_without_text_layer"));
    assert.ok(result.extraction?.warnings.includes("no_text_layer"));
    assert.equal(result.proposal?.action, "archive");
    assert.equal(h.reviews.length, 1);

    const broken = harness({ document: document(), file: { ...inlineFile(pdf, "application/pdf", "x.pdf"), storageKind: "disk", inline: null, storageKey: "org/o/prop/p/doc/d/" + "0".repeat(64) + ".pdf" } });
    await assert.rejects(runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_fail" }), /almacén no debe usarse/);
    assert.equal(broken.extractions.length, 1);
    assert.equal(broken.extractions[0]!.status, "failed");
    assert.match(String(broken.extractions[0]!.error), /almacén/);
    assert.equal(broken.documents.get(DOC)!.extractionStatus, "failed");
    assert.equal(broken.reviews.length, 0);
    assert.equal(broken.audits[0]!.action, DOCUMENT_PIPELINE_AUDIT_ACTIONS.extracted);
    assert.equal((broken.audits[0]!.afterJson as Row).status, "failed");
  });

  it("proposeDocumentAction recalcula sobre la última extracción con los campos revisados por encima y persiste solo con persist:true", async () => {
    const pdf = demoInvoicePdf();
    const h = harness({ document: document({ reviewedFieldsJson: { total: "999.99" } }), file: inlineFile(pdf, "application/pdf", "factura.pdf") });
    await runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_p1" });
    const preview = await proposeDocumentAction({ documentId: DOC, organizationId: ORG, propertyId: PROP, correlationId: "corr_p2", persist: false });
    assert.equal(preview.runNo, 1);
    assert.equal(preview.kind, "invoice");
    assert.equal(preview.checks.totals.status, "fail", "el total revisado (999,99) no cuadra con las líneas");
    assert.equal(preview.proposal.action, "create_supplier_bill");
    assert.equal(h.documents.get(DOC)!.checksJson && (h.documents.get(DOC)!.checksJson as Record<string, { status: string }>).totals.status, "ok", "preview no escribe");
    const audits = h.audits.length;
    const executed = await proposeDocumentAction({ documentId: DOC, organizationId: ORG, propertyId: PROP, correlationId: "corr_p3", userId: "usr_office", persist: true });
    assert.equal(executed.checks.totals.status, "fail");
    assert.equal((h.documents.get(DOC)!.checksJson as Record<string, { status: string }>).totals.status, "fail");
    assert.equal(h.audits.length, audits + 1);
    assert.equal(h.audits[h.audits.length - 1]!.action, DOCUMENT_PIPELINE_AUDIT_ACTIONS.proposed);
    await assert.rejects(proposeDocumentAction({ documentId: DOC, organizationId: "otra", propertyId: PROP, correlationId: "c", persist: false }), (error: HttpError) => error.statusCode === 404);
  });
});

describe("split lógico (RV-01): sourcePagesJson recorta texto, filas de página y pageCount al trozo", () => {
  beforeEach(() => resetDocumentsAiPort());
  afterEach(() => {
    resetDocumentPipelineForTests();
    resetDocumentsAiPort();
  });

  const OTHER_TAX_ID = cifFor("B", "0007777");
  const BATCH = multiInvoicePdf([{ number: "RV-SPLIT-0001" }, { number: "RV-SPLIT-0002", taxId: OTHER_TAX_ID, lines: [{ description: "Servicio dos", quantity: 2, unitPrice: 100, taxRate: 21 }] }]);

  it("el trozo de la página 2 extrae SOLO su factura (número, NIF y total de la página 2), escribe una fila de página y avisa pdf_split_text_only", async () => {
    const h = harness({ document: document({ pageCount: 1, sourcePagesJson: [2] }), file: inlineFile(BATCH, "application/pdf", "lote.pdf") });
    const result = await runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_split_2" });
    const row = h.documents.get(DOC)!;
    assert.equal(row.documentNumber, "RV-SPLIT-0002");
    assert.equal(row.supplierTaxId, OTHER_TAX_ID);
    assert.equal(row.totalAmount, "242.00");
    assert.equal(row.pageCount, 1);
    assert.equal(h.pages.size, 1, "solo la página lógica 1 del trozo");
    assert.match(String(h.pages.get(1)!.textExtracted), /RV-SPLIT-0002/);
    assert.doesNotMatch(String(h.pages.get(1)!.textExtracted), /RV-SPLIT-0001/);
    assert.ok(result.extraction?.warnings.includes("pdf_split_text_only"), "el PDF completo no viaja al modelo");
    assert.doesNotMatch(String(row.searchText), /RV-SPLIT-0001/);
  });

  it("el trozo de la página 1 no ve la página 2; sin sourcePagesJson el documento entero sigue leyendo todas las páginas", async () => {
    const piece = harness({ document: document({ pageCount: 1, sourcePagesJson: [1] }), file: inlineFile(BATCH, "application/pdf", "lote.pdf") });
    await runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_split_1" });
    assert.equal(piece.documents.get(DOC)!.documentNumber, "RV-SPLIT-0001");
    assert.equal(piece.documents.get(DOC)!.supplierTaxId, DEMO_SUPPLIER_TAX_ID);
    assert.equal(piece.pages.size, 1);

    const whole = harness({ document: document({ pageCount: 2 }), file: inlineFile(BATCH, "application/pdf", "lote.pdf") });
    const result = await runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_whole" });
    assert.equal(whole.pages.size, 2);
    assert.equal(whole.documents.get(DOC)!.pageCount, 2);
    assert.ok(!result.extraction?.warnings.includes("pdf_split_text_only"));
  });

  it("selectSourcePages / parseSourcePages (puras): orden lógico, PDF descartado con aviso; XML e imágenes intactos", () => {
    const content = { mimeType: "application/pdf", text: "a\n\nb\n\nc", pagesText: ["a", "b", "c"], pageCount: 3, xml: null, pages: null, pdf: Buffer.from("%PDF"), warnings: ["x"] };
    const cut = selectSourcePages(content, [3, 1]);
    assert.deepEqual(cut.pagesText, ["c", "a"]);
    assert.equal(cut.text, "c\n\na");
    assert.equal(cut.pageCount, 2);
    assert.equal(cut.pdf, null);
    assert.deepEqual(cut.warnings, ["x", "pdf_split_text_only"]);
    assert.equal(selectSourcePages(content, null), content);
    const missing = selectSourcePages(content, [9]);
    assert.deepEqual(missing.pagesText, [""]);
    assert.equal(missing.text, null);
    const xml = { ...content, mimeType: "application/xml" };
    assert.equal(selectSourcePages(xml, [2]), xml);
    assert.deepEqual(parseSourcePages([2, "x", 0, 3, 1.5]), [2, 3]);
    assert.equal(parseSourcePages([]), null);
    assert.equal(parseSourcePages("2"), null);
  });
});

describe("envío automático a la oficina (RV-06: DocumentSettings.autoSendToOffice)", () => {
  beforeEach(() => resetDocumentsAiPort());
  afterEach(() => {
    resetDocumentPipelineForTests();
    resetDocumentsAiPort();
  });

  const settings = { organizationId: ORG, officeSlaBusinessDays: 2, autoSendToOffice: true, aiAllowedKindsJson: [], priceTolerancePct: 2, quantityTolerance: 0, amountToleranceAbs: 1, requireMatchForApproval: false, retentionYearsDefault: 6, letterRetentionYears: 6, extendedRetentionYears: 10 };

  it("captura recién extraída → sent_to_office con sentAt y DOCUMENT_SENT de sistema (automatic: true); una reejecución manual no vuelve a enviar", async () => {
    const h = harness({ document: document(), file: inlineFile(demoInvoicePdf(), "application/pdf", "factura.pdf"), settings });
    await runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_auto" });
    const row = h.documents.get(DOC)!;
    assert.equal(row.status, "sent_to_office");
    assert.equal((row.sentAt as Date).toISOString(), NOW.toISOString());
    assert.equal(row.extractionStatus, "done");
    const sent = h.audits.find((audit) => audit.action === DOCUMENT_AUDIT_ACTIONS.sent);
    assert.ok(sent, "DOCUMENT_SENT auditado");
    assert.equal(sent!.actorType, "system");
    assert.equal((sent!.afterJson as Row).automatic, true);
    assert.equal((sent!.afterJson as Row).trigger, "capture");
    assert.deepEqual(h.audits.map((audit) => audit.action), [DOCUMENT_PIPELINE_AUDIT_ACTIONS.classified, DOCUMENT_AUDIT_ACTIONS.sent, DOCUMENT_PIPELINE_AUDIT_ACTIONS.extracted]);

    await runDocumentPipeline(DOC, { trigger: "manual", correlationId: "corr_auto_2", userId: "usr_office" });
    assert.equal(h.audits.filter((audit) => audit.action === DOCUMENT_AUDIT_ACTIONS.sent).length, 1);
  });

  it("sin el ajuste (o con el documento ya enviado a mano) la captura sigue captured / no se pisa", async () => {
    const off = harness({ document: document(), file: inlineFile(demoInvoicePdf(), "application/pdf", "factura.pdf"), settings: { ...settings, autoSendToOffice: false } });
    await runDocumentPipeline(DOC, { trigger: "capture", correlationId: "corr_off" });
    assert.equal(off.documents.get(DOC)!.status, "captured");
    assert.ok(!off.audits.some((audit) => audit.action === DOCUMENT_AUDIT_ACTIONS.sent));

    const manual = harness({ document: document({ status: "sent_to_office", sentAt: new Date("2026-09-18T00:00:00.000Z") }), file: inlineFile(demoInvoicePdf(), "application/pdf", "factura.pdf"), settings });
    await runDocumentPipeline(DOC, { trigger: "email", correlationId: "corr_manual" });
    assert.equal((manual.documents.get(DOC)!.sentAt as Date).toISOString(), "2026-09-18T00:00:00.000Z", "el envío manual previo se conserva");
    assert.ok(!manual.audits.some((audit) => audit.action === DOCUMENT_AUDIT_ACTIONS.sent));
  });
});

describe("utilidades puras del pipeline", () => {
  it("normalizeExtractedFields mapea el esquema por tipo a los campos de validación; swapOwnTaxId corrige el NIF propio", () => {
    const invoice = normalizeExtractedFields(
      "invoice",
      { supplierTaxId: { value: DEMO_CUSTOMER_TAX_ID, confidence: 0.9 }, customerTaxId: { value: DEMO_SUPPLIER_TAX_ID, confidence: 0.7 }, invoiceNumber: { value: "F-1", confidence: 0.8 }, base: { value: "10.00", confidence: 0.8 }, taxBreakdown: { value: [{ rate: 10, base: "10.00", quota: "1.00" }], confidence: 0.8 }, total: { value: "11.00", confidence: 0.8 } },
      "Factura con inversión del sujeto pasivo"
    );
    assert.equal(invoice.documentNumber, "F-1");
    assert.equal(invoice.baseTotal, "10.00");
    assert.equal(invoice.taxRate, 10);
    assert.equal(invoice.reverseCharge, true);
    const swapped = swapOwnTaxId(invoice, [DEMO_CUSTOMER_TAX_ID]);
    assert.equal(swapped.supplierTaxId, DEMO_SUPPLIER_TAX_ID);
    assert.equal(swapped.customerTaxId, DEMO_CUSTOMER_TAX_ID);
    assert.equal(swapOwnTaxId(swapped, [DEMO_CUSTOMER_TAX_ID]), swapped);
    const notice = normalizeExtractedFields("administrative_notice", { issuer: { value: "AEAT", confidence: 0.5 }, deadlineDate: { value: "2026-10-01", confidence: 0.6 } }, "Agencia Tributaria requerimiento");
    assert.equal(notice.noticeKind, "aeat_requirement");
    assert.equal(notice.dueDate, "2026-10-01");
    assert.equal(notice.requiresResponse, true);
    const merged = applyReviewedFields({ total: "1.00", text: "t" }, { total: "2.00", text: "no" });
    assert.deepEqual(merged, { total: "2.00", text: "t" });
    // RV-07: el número corregido por el revisor manda también sobre documentNumber (derivado de la extracción original).
    assert.deepEqual(applyReviewedFields({ invoiceNumber: "F-1", documentNumber: "F-1" }, { invoiceNumber: "F-1-REV" }), { invoiceNumber: "F-1-REV", documentNumber: "F-1-REV" });
    assert.deepEqual(applyReviewedFields({ deliveryNoteNumber: "A-1", documentNumber: "A-1" }, { deliveryNoteNumber: " A-2 " }), { deliveryNoteNumber: " A-2 ", documentNumber: "A-2" });
    assert.deepEqual(applyReviewedFields({ invoiceNumber: "F-1", documentNumber: "F-1" }, { invoiceNumber: "F-9", documentNumber: "X" }), { invoiceNumber: "F-9", documentNumber: "F-9" }, "el número del tipo manda sobre el derivado (reviewedFieldsJson no guarda el orden de las revisiones)");
    assert.deepEqual(applyReviewedFields({ invoiceNumber: "F-1", documentNumber: "F-1" }, { documentNumber: "X" }), { invoiceNumber: "F-1", documentNumber: "X" }, "sin número del tipo, documentNumber revisado cuenta");
    assert.deepEqual(applyReviewedFields({ invoiceNumber: "F-1", documentNumber: "F-1" }, { invoiceNumber: "" }), { invoiceNumber: "", documentNumber: "F-1" });
  });

  it("buildPipelineSearchText incluye registro, NIF y número y elimina los números de tarjeta; contentOf distingue PDF / XML / imagen", () => {
    const text = buildPipelineSearchText({ registryNumber: "DOC-HTL-2026-000009" }, { supplierName: "Proveedor Demo", supplierTaxId: DEMO_SUPPLIER_TAX_ID, invoiceNumber: "F-9", total: "10.00" }, ["Pagado con tarjeta 4111 1111 1111 1111 el 10/09/2026"]);
    assert.match(text, /DOC-HTL-2026-000009/);
    assert.match(text, new RegExp(DEMO_SUPPLIER_TAX_ID));
    assert.match(text, /F-9/);
    assert.doesNotMatch(text, /4111 1111 1111 1111/);
    assert.match(text, /\[TARJETA_1\]/);
    // RV-18: el nombre del fichero y la nota de captura sobreviven a la extracción.
    const withNote = buildPipelineSearchText({ registryNumber: "DOC-HTL-2026-000010", title: "lote-escaner.pdf", captureNote: "nota de captura RV" }, { supplierName: null }, ["texto"]);
    assert.match(withNote, /lote-escaner\.pdf/);
    assert.match(withNote, /nota de captura RV/);
    const xml = contentOf("application/xml", Buffer.from(facturaeXml(), "utf8"), 0);
    assert.equal(xml.xml && xml.xml.includes("<fe:Facturae"), true);
    assert.equal(xml.pages, null);
    const image = contentOf("image/jpeg", Buffer.from("ffd8ffe0", "hex"), 0);
    assert.equal(image.text, null);
    assert.equal(image.pages?.[0]?.mediaType, "image/jpeg");
    assert.equal(image.pageCount, 1);
    const pdf = contentOf("application/pdf", demoInvoicePdf(), 0);
    assert.equal(pdf.pageCount, 1);
    assert.match(pdf.text ?? "", /FACTURA/);
  });
});
