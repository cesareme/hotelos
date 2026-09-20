// Unit tests · Tanda T9 · lote T9-05a — servicio de documentos: funciones puras
// (estado físico por canal, páginas, dedupe, SLA, cursor, filtros, disyunción de
// permisos) y el flujo de captura con almacén inline y BD simulada (orden
// storage.put → transacción, borrado si la transacción falla, 413 / 400 / 409
// antes de tocar el almacén). Sin Postgres, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/documents-service.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionDeniedError, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import { encodeCursor } from "../../../lib/pagination.js";
import {
  applyDocumentStatus,
  buildListWhere,
  buildSearchText,
  capturedAtRange,
  createDocumentsService,
  cursorFilter,
  deadlineKindOf,
  decideDuplicate,
  dueAtOf,
  isDocumentsAdmin,
  isSlaBreached,
  MAX_PAGE_ROWS,
  pageCountFor,
  pageRowsFor,
  physicalStatusFor,
  requireAnyPermission,
  slaDueAt,
  slaSentAtBound,
  emailAuditRefs,
  isEInvoiceXml,
  sourceForFile
} from "../documents.service.js";
import { InlineDocumentStorage } from "../storage/inline-storage.js";
import { isValidStorageKey } from "../storage/storage.js";
import { demoInvoicePdf, htmlDisguisedAsPdf, multiPagePdf, tinyPng, facturaeXml, foreignXml } from "./fixtures.js";

const NOW = new Date("2026-09-19T10:00:00.000Z");

function context(permissions: PermissionKey[], extra: Partial<UserContext> = {}): UserContext {
  return { organizationId: "org_t9", propertyId: "prop_t9a", userId: "usr_t9", fullName: "Prueba T9", deviceId: "dev_t9", permissions, ...extra };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof HttpError ? (error.details as { code?: string } | undefined)?.code : undefined;
}

async function expectHttp(run: () => Promise<unknown>, statusCode: number, code: string): Promise<HttpError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpError, `HttpError esperado, llegó ${String(error)}`);
    assert.equal(error.statusCode, statusCode);
    assert.equal(codeOf(error), code);
    return error;
  }
  assert.fail(`se esperaba ${statusCode} ${code}`);
}

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

describe("physicalStatusFor / pageCountFor / pageRowsFor", () => {
  it("el papel existe salvo correo, e-factura y API (§6.1)", () => {
    assert.equal(physicalStatusFor("upload"), "at_centre");
    assert.equal(physicalStatusFor("mobile"), "at_centre");
    assert.equal(physicalStatusFor("scanner"), "at_centre");
    assert.equal(physicalStatusFor("email"), "not_applicable");
    assert.equal(physicalStatusFor("e_invoice"), "not_applicable");
    assert.equal(physicalStatusFor("api"), "not_applicable");
  });

  it("PDF por countPdfPages (mínimo 1); imagen y XML una página", () => {
    assert.equal(pageCountFor("application/pdf", multiPagePdf(3)), 3);
    assert.equal(pageCountFor("application/pdf", demoInvoicePdf()), 1);
    assert.equal(pageCountFor("application/pdf", Buffer.from("%PDF-1.4\n%%EOF")), 1);
    assert.equal(pageCountFor("image/png", tinyPng()), 1);
    assert.equal(pageCountFor("application/xml", Buffer.from(facturaeXml(), "utf8")), 1);
  });

  it("pageRowsFor acota entre 1 y MAX_PAGE_ROWS", () => {
    assert.deepEqual(pageRowsFor(0), [1]);
    assert.deepEqual(pageRowsFor(3), [1, 2, 3]);
    assert.equal(pageRowsFor(100_000).length, MAX_PAGE_ROWS);
  });
});

describe("decideDuplicate / buildSearchText", () => {
  it("409 salvo allowDuplicate", () => {
    assert.deepEqual(decideDuplicate(null, false), { kind: "none" });
    assert.deepEqual(decideDuplicate(undefined, true), { kind: "none" });
    assert.deepEqual(decideDuplicate({ id: "doc_1" }, false), { kind: "conflict", existingId: "doc_1" });
    assert.deepEqual(decideDuplicate({ id: "doc_1" }, undefined), { kind: "conflict", existingId: "doc_1" });
    assert.deepEqual(decideDuplicate({ id: "doc_1" }, true), { kind: "allowed", existingId: "doc_1" });
  });

  it("buildSearchText une partes no vacías y acota", () => {
    assert.equal(buildSearchText(["DOC-L2A-2026-000001", " factura.pdf ", null, undefined, ""]), "DOC-L2A-2026-000001 factura.pdf");
    assert.equal(buildSearchText(["x".repeat(9000)]).length, 8000);
  });
});

describe("plazos y SLA (§3.5, §6.3)", () => {
  it("deadlineKindOf / dueAtOf: la tarea abierta más próxima gana; si no, el plazo del tipo", () => {
    assert.equal(deadlineKindOf("administrative_notice"), "administrative_notice");
    assert.equal(deadlineKindOf("e_invoice_status"), "e_invoice");
    assert.equal(deadlineKindOf("invoice"), null);
    const row = { kind: "invoice" as const, documentDate: null, capturedAt: NOW };
    assert.equal(dueAtOf(row, []), null);
    const soon = new Date("2026-09-25T00:00:00.000Z");
    const later = new Date("2026-10-01T00:00:00.000Z");
    assert.equal(dueAtOf(row, [later, null, soon])?.toISOString(), soon.toISOString());
    const notice = { kind: "administrative_notice" as const, documentDate: new Date("2026-09-10T00:00:00.000Z"), capturedAt: NOW };
    assert.equal(dueAtOf(notice, [])?.toISOString(), "2026-09-20T00:00:00.000Z");
    assert.equal(dueAtOf({ ...notice, documentDate: null }, [])?.toISOString(), "2026-09-29T00:00:00.000Z");
  });

  it("slaDueAt suma días laborables desde la medianoche UTC del envío", () => {
    // Viernes 18/09 + 2 laborables = martes 22/09 (sábado y domingo no cuentan).
    assert.equal(slaDueAt(new Date("2026-09-18T15:30:00.000Z"), 2).toISOString(), "2026-09-22T00:00:00.000Z");
    assert.equal(slaDueAt(new Date("2026-09-18T15:30:00.000Z"), 0).toISOString(), "2026-09-18T00:00:00.000Z");
  });

  it("isSlaBreached solo en sent_to_office / in_review y cuando el día de vencimiento ha pasado entero", () => {
    const sentAt = new Date("2026-09-14T09:00:00.000Z"); // lunes → vence miércoles 16; vencido desde el jueves 17 00:00
    assert.equal(isSlaBreached({ status: "sent_to_office", sentAt }, 2, new Date("2026-09-16T23:59:59.000Z")), false);
    assert.equal(isSlaBreached({ status: "sent_to_office", sentAt }, 2, new Date("2026-09-17T00:00:00.000Z")), true);
    assert.equal(isSlaBreached({ status: "in_review", sentAt }, 2, NOW), true);
    assert.equal(isSlaBreached({ status: "approved", sentAt }, 2, NOW), false);
    assert.equal(isSlaBreached({ status: "captured", sentAt: null }, 2, NOW), false);
  });

  it("slaSentAtBound es la cota exclusiva de sentAt coherente con isSlaBreached", () => {
    for (const sla of [0, 1, 2, 5]) {
      for (const now of [NOW, new Date("2026-09-21T00:00:00.000Z"), new Date("2026-12-24T12:00:00.000Z"), new Date("2027-01-02T08:00:00.000Z")]) {
        const bound = slaSentAtBound(now, sla);
        for (let day = 0; day < 40; day++) {
          for (const hour of [0, 12, 23]) {
            const sentAt = new Date(now.getTime() - day * 86_400_000 - hour * 3_600_000);
            assert.equal(sentAt.getTime() < bound.getTime(), isSlaBreached({ status: "sent_to_office", sentAt }, sla, now), `sla=${sla} now=${now.toISOString()} sentAt=${sentAt.toISOString()}`);
          }
        }
      }
    }
  });
});

describe("cursorFilter / capturedAtRange / buildListWhere", () => {
  it("cursor nulo → sin filtro; desc/asc por (capturedAt, id); cursor inválido → 400", () => {
    assert.equal(cursorFilter(null, "desc"), null);
    const cursor = encodeCursor({ k: "2026-09-18T10:00:00.000Z", id: "doc_a" });
    assert.deepEqual(cursorFilter(cursor, "desc"), {
      OR: [{ capturedAt: { lt: new Date("2026-09-18T10:00:00.000Z") } }, { capturedAt: new Date("2026-09-18T10:00:00.000Z"), id: { lt: "doc_a" } }]
    });
    assert.deepEqual(cursorFilter(cursor, "asc"), {
      OR: [{ capturedAt: { gt: new Date("2026-09-18T10:00:00.000Z") } }, { capturedAt: new Date("2026-09-18T10:00:00.000Z"), id: { gt: "doc_a" } }]
    });
    assert.throws(() => cursorFilter("no-es-un-cursor", "desc"), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
    assert.throws(() => cursorFilter(encodeCursor({ k: "ayer", id: "x" }), "desc"), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
  });

  it("capturedAtRange: [from 00:00, to + 1 día)", () => {
    assert.equal(capturedAtRange(undefined, undefined), undefined);
    assert.deepEqual(capturedAtRange("2026-09-01", "2026-09-30"), { gte: new Date("2026-09-01T00:00:00.000Z"), lt: new Date("2026-10-01T00:00:00.000Z") });
    assert.deepEqual(capturedAtRange("2026-09-01", undefined), { gte: new Date("2026-09-01T00:00:00.000Z") });
  });

  it("buildListWhere: purgados fuera siempre, bloqueados salvo admin, q en 4 columnas, vencidos por cota", () => {
    const base = buildListWhere({}, { includeBlocked: false, slaBound: null });
    assert.deepEqual(base, { deletedAt: null, blockedAt: null });
    assert.equal(buildListWhere({}, { includeBlocked: true, slaBound: null }).blockedAt, undefined);
    const where = buildListWhere({ q: "DOC-L2A", status: ["captured"], kind: "invoice", physicalStatus: "at_centre", assignedTo: "usr_1", from: "2026-09-01" }, { includeBlocked: false, slaBound: null });
    assert.deepEqual(where.status, { in: ["captured"] });
    assert.equal(where.kind, "invoice");
    assert.equal(where.physicalStatus, "at_centre");
    assert.equal(where.assignedTo, "usr_1");
    assert.equal((where.OR as unknown[]).length, 4);
    const bound = new Date("2026-09-17T00:00:00.000Z");
    const breached = buildListWhere({ slaBreachedOnly: true }, { includeBlocked: false, slaBound: bound });
    assert.deepEqual(breached.sentAt, { lt: bound });
    assert.deepEqual(breached.status, { in: ["sent_to_office", "in_review"] });
    const breachedCaptured = buildListWhere({ slaBreachedOnly: true, status: ["captured", "in_review"] }, { includeBlocked: false, slaBound: bound });
    assert.deepEqual(breachedCaptured.status, { in: ["in_review"] });
  });
});

describe("permisos: disyunción capture | review", () => {
  it("requireAnyPermission pasa con una clave, con platform admin, y lanza PermissionDeniedError sin ninguna", () => {
    assert.doesNotThrow(() => requireAnyPermission(context(["documents.capture"]), ["documents.capture", "documents.review"]));
    assert.doesNotThrow(() => requireAnyPermission(context(["documents.review"]), ["documents.capture", "documents.review"]));
    assert.doesNotThrow(() => requireAnyPermission(context([], { isPlatformAdmin: true }), ["documents.capture", "documents.review"]));
    assert.throws(() => requireAnyPermission(context(["documents.archive.read"]), ["documents.capture", "documents.review"]), (error: unknown) => {
      assert.ok(error instanceof PermissionDeniedError);
      assert.deepEqual(error.missing, ["documents.capture", "documents.review"]);
      return true;
    });
  });

  it("isDocumentsAdmin", () => {
    assert.equal(isDocumentsAdmin(context(["documents.admin"])), true);
    assert.equal(isDocumentsAdmin(context(["documents.review"])), false);
    assert.equal(isDocumentsAdmin(context([], { isPlatformAdmin: true })), true);
  });
});

// ---------------------------------------------------------------------------
// Captura con BD simulada
// ---------------------------------------------------------------------------

type Created = { data: Record<string, any> };

type FakeDb = {
  created: Created[];
  fileCreated: Created[];
  existing: { id: string; registryNumber: string } | null;
  failTransaction: boolean;
  transactions: number;
  property: { findUnique: (args: unknown) => Promise<unknown> };
  incomingDocument: { findFirst: (args: unknown) => Promise<unknown> };
  documentAction: { findMany: () => Promise<unknown[]> };
  supplier: { findMany: () => Promise<unknown[]> };
  documentSettings: { findUnique: () => Promise<null> };
  $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
};

function fakeDb(): FakeDb {
  const db: FakeDb = {
    created: [],
    fileCreated: [],
    existing: null,
    failTransaction: false,
    transactions: 0,
    property: { findUnique: async () => ({ id: "prop_t9a", code: "T9A", organizationId: "org_t9", legalEntityId: "le_t9", kind: "hotel" }) },
    incomingDocument: { findFirst: async () => db.existing },
    documentAction: { findMany: async () => [] },
    supplier: { findMany: async () => [] },
    documentSettings: { findUnique: async () => null },
    $transaction: async (fn) => {
      db.transactions += 1;
      if (db.failTransaction) throw new Error("boom");
      const tx = {
        $executeRaw: async () => 0,
        $queryRaw: async () => [{ next: 1 }],
        incomingDocument: {
          create: async (args: Created) => {
            db.created.push(args);
            const d = args.data;
            const at = d.capturedAt as Date;
            return {
              ...d,
              kindConfidence: null,
              supplierId: null,
              supplierTaxId: null,
              documentNumber: null,
              documentDate: null,
              totalAmount: null,
              currency: "EUR",
              proposedAction: null,
              proposedActionJson: {},
              checksJson: [],
              reviewedFieldsJson: null,
              emailMetaJson: null,
              sentAt: null,
              assignedTo: null,
              reviewStartedAt: null,
              decidedBy: null,
              decidedAt: null,
              rejectReason: null,
              rejectNote: null,
              supplierBillId: null,
              expenseId: null,
              goodsReceiptId: null,
              reviewItemId: null,
              dispatchBatchId: null,
              mergedIntoId: null,
              postedAt: null,
              archivedAt: null,
              retentionUntil: null,
              extendedRetention: false,
              legalHold: false,
              blockedAt: null,
              deletedAt: null,
              guestId: null,
              createdAt: at,
              updatedAt: at
            };
          }
        }
      };
      return fn(tx);
    }
  };
  return db;
}

function serviceWith(db: FakeDb, options: { maxBytes?: number } = {}) {
  const storage = new InlineDocumentStorage({ inlineMaxBytes: 4 * 1024 * 1024 });
  const service = createDocumentsService({
    storage: () => storage,
    maxBytes: () => options.maxBytes ?? 1_000_000,
    now: () => NOW,
    allocate: async (_tx, input) => ({ registryNumber: `DOC-${input.propertyCode}-${input.year}-000001`, registryYear: input.year, registrySeq: 1 }),
    db: db as unknown as Parameters<typeof createDocumentsService>[0]["db"]
  });
  return { service, storage };
}

const pdfFile = (fileName = "factura.pdf", bytes: Buffer = demoInvoicePdf()) => ({ fileName, mimeType: "application/pdf", base64: bytes.toString("base64") });
const capture = (body: unknown, permissions: PermissionKey[] = ["documents.capture"]) => ({ context: context(permissions), propertyId: "prop_t9a", body, correlationId: "corr_t9", ipAddress: "127.0.0.1" });

describe("e-factura y auditoría sin datos personales (RV-08, SEC-02)", () => {
  it("isEInvoiceXml / sourceForFile: un XML Facturae o UBL entra como e_invoice (papel not_applicable); otro XML o un PDF conservan el canal", () => {
    const facturae = Buffer.from(facturaeXml(), "utf8");
    assert.equal(isEInvoiceXml("application/xml", facturae), true);
    assert.equal(isEInvoiceXml("application/xml", Buffer.from(foreignXml(), "utf8")), false);
    assert.equal(isEInvoiceXml("application/pdf", facturae), false);
    assert.equal(sourceForFile("upload", "application/xml", facturae), "e_invoice");
    assert.equal(sourceForFile("email", "application/xml", facturae), "e_invoice");
    assert.equal(sourceForFile("upload", "application/xml", Buffer.from(foreignXml(), "utf8")), "upload");
    assert.equal(sourceForFile("mobile", "application/pdf", Buffer.from("%PDF-1.4")), "mobile");
  });

  it("captura de un XML Facturae subido por la oficina → source e_invoice y physicalStatus not_applicable (nada va a la valija)", async () => {
    const db = fakeDb();
    const { service } = serviceWith(db);
    const [record] = await service.captureIncomingDocuments(capture({ files: [{ fileName: "facturae.xml", mimeType: "application/xml", base64: Buffer.from(facturaeXml(), "utf8").toString("base64") }] }));
    assert.equal(record!.source, "e_invoice");
    assert.equal(record!.physicalStatus, "not_applicable");
    assert.equal(record!.originalFormat, "application/xml");
    assert.equal(db.created[0]!.data.captureNote, null);
  });

  it("emailAuditRefs: del correo solo ids (mensaje, adjunto, conexión); nunca remitente ni asunto", () => {
    assert.deepEqual(emailAuditRefs({ messageId: "m1", attachmentId: "att-1", connectionId: "conn_1", from: "persona@example.test", subject: "Factura de una persona" }), { email: { messageId: "m1", attachmentId: "att-1", connectionId: "conn_1" } });
    assert.deepEqual(emailAuditRefs({ from: "persona@example.test" }), {});
    assert.deepEqual(emailAuditRefs(undefined), {});
  });
});

describe("captureIncomingDocuments (almacén inline, BD simulada)", () => {
  it("crea registro, fila y fichero inline; la clave del almacén es org/prop/doc/sha; físico at_centre; extracción pending", async () => {
    const db = fakeDb();
    const { service, storage } = serviceWith(db);
    const records = await service.captureIncomingDocuments(capture({ files: [pdfFile()], kindHint: "invoice", note: "lavandería" }));
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.registryNumber, "DOC-T9A-2026-000001");
    assert.equal(record.status, "captured");
    assert.equal(record.physicalStatus, "at_centre");
    assert.equal(record.extractionStatus, "pending");
    assert.equal(record.kind, "invoice");
    assert.equal(record.classificationSource, "manual");
    assert.equal(record.source, "upload");
    assert.equal(record.pageCount, 1);
    assert.equal(record.originalFormat, "application/pdf");
    assert.equal(record.capturedBy, "usr_t9");
    assert.equal(record.slaBreached, false);
    assert.equal(record.dueAt, null);
    assert.equal(db.transactions, 1);
    assert.equal(db.created[0]!.data.captureNote, "lavandería", "RV-18: la nota se conserva en su columna");
    const data = db.created[0]!.data;
    assert.equal(data.registryYear, 2026);
    assert.equal(data.registrySeq, 1);
    assert.equal(data.legalEntityId, "le_t9");
    assert.match(data.searchText, /DOC-T9A-2026-000001 factura\.pdf lavandería/);
    const file = data.files.create[0];
    assert.equal(file.role, "original");
    assert.equal(file.storageKind, "inline");
    assert.equal(file.encrypted, false);
    assert.equal(typeof file.inline, "string");
    assert.ok(isValidStorageKey(file.storageKey));
    assert.ok(file.storageKey.startsWith(`org/org_t9/prop/prop_t9a/doc/${record.id}/${record.sha256}.pdf`));
    assert.deepEqual(data.pages.createMany.data, [{ pageNo: 1 }]);
    assert.equal(storage.size, 1);
    assert.equal((await storage.get(file.storageKey))?.bytes.length, record.sizeBytes);
  });

  it("varios ficheros en orden; un PDF de 3 páginas crea 3 filas de página; source mobile", async () => {
    const db = fakeDb();
    const { service } = serviceWith(db);
    const records = await service.captureIncomingDocuments(capture({ files: [pdfFile("a.pdf", multiPagePdf(3)), { fileName: "foto.png", mimeType: "image/png", base64: tinyPng().toString("base64") }], source: "mobile" }));
    assert.equal(records.length, 2);
    assert.equal(records[0]!.pageCount, 3);
    assert.equal(db.created[0]!.data.pages.createMany.data.length, 3);
    assert.equal(records[1]!.originalFormat, "image/png");
    assert.equal(records[1]!.source, "mobile");
    assert.equal(db.transactions, 2);
  });

  it("source fijado por el servidor (email) → physicalStatus not_applicable y emailMeta guardado", async () => {
    const db = fakeDb();
    const { service } = serviceWith(db);
    const [record] = await service.captureIncomingDocuments({ ...capture({ files: [pdfFile()] }), source: "email", emailMeta: { from: "proveedor@example.test", subject: "Factura" }, skipPermissionCheck: true });
    assert.equal(record!.physicalStatus, "not_applicable");
    assert.equal(record!.source, "email");
    assert.deepEqual(db.created[0]!.data.emailMetaJson, { from: "proveedor@example.test", subject: "Factura" });
  });

  it("413 DOCUMENT_TOO_LARGE antes de decodificar y sin tocar almacén ni BD", async () => {
    const db = fakeDb();
    const { service, storage } = serviceWith(db, { maxBytes: 100 });
    const error = await expectHttp(() => service.captureIncomingDocuments(capture({ files: [pdfFile()] })), 413, "DOCUMENT_TOO_LARGE");
    assert.equal((error.details as { maxBytes: number }).maxBytes, 100);
    assert.equal(storage.size, 0);
    assert.equal(db.transactions, 0);
  });

  it("400 DOCUMENT_MIME_NOT_ALLOWED (text/html) y 400 DOCUMENT_CONTENT_MISMATCH (HTML disfrazado de PDF)", async () => {
    const db = fakeDb();
    const { service, storage } = serviceWith(db);
    await expectHttp(() => service.captureIncomingDocuments(capture({ files: [{ fileName: "x.html", mimeType: "text/html", base64: Buffer.from("<html></html>").toString("base64") }] })), 400, "DOCUMENT_MIME_NOT_ALLOWED");
    await expectHttp(() => service.captureIncomingDocuments(capture({ files: [pdfFile("x.pdf", htmlDisguisedAsPdf())] })), 400, "DOCUMENT_CONTENT_MISMATCH");
    assert.equal(storage.size, 0);
    assert.equal(db.transactions, 0);
  });

  it("409 DOCUMENT_DUPLICATE_FILE con existingId; allowDuplicate lo salta; repetido dentro del envío también es 409", async () => {
    const db = fakeDb();
    db.existing = { id: "doc_prev", registryNumber: "DOC-T9A-2026-000001" };
    const { service, storage } = serviceWith(db);
    const error = await expectHttp(() => service.captureIncomingDocuments(capture({ files: [pdfFile()] })), 409, "DOCUMENT_DUPLICATE_FILE");
    assert.equal((error.details as { existingId: string }).existingId, "doc_prev");
    assert.equal(storage.size, 0);
    const records = await service.captureIncomingDocuments(capture({ files: [pdfFile()], allowDuplicate: true }));
    assert.equal(records.length, 1);
    db.existing = null;
    await expectHttp(() => service.captureIncomingDocuments(capture({ files: [pdfFile("a.pdf"), pdfFile("b.pdf")] })), 409, "DOCUMENT_DUPLICATE_FILE");
    const twins = await service.captureIncomingDocuments(capture({ files: [pdfFile("a.pdf"), pdfFile("b.pdf")], allowDuplicate: true }));
    assert.equal(twins.length, 2);
    assert.notEqual(twins[0]!.id, twins[1]!.id);
  });

  it("si la transacción falla, la clave se borra del almacén y el error se propaga", async () => {
    const db = fakeDb();
    db.failTransaction = true;
    const { service, storage } = serviceWith(db);
    await assert.rejects(() => service.captureIncomingDocuments(capture({ files: [pdfFile()] })), /boom/);
    assert.equal(storage.size, 0);
    assert.equal(db.created.length, 0);
  });

  it("sin documents.capture → PermissionDeniedError; cuerpo inválido → 400 VALIDATION_ERROR", async () => {
    const db = fakeDb();
    const { service } = serviceWith(db);
    await assert.rejects(() => service.captureIncomingDocuments(capture({ files: [pdfFile()] }, ["documents.review"])), (error: unknown) => error instanceof PermissionDeniedError);
    await expectHttp(() => service.captureIncomingDocuments(capture({ files: [] })), 400, "VALIDATION_ERROR");
    await expectHttp(() => service.captureIncomingDocuments(capture({ files: [pdfFile()], source: "email" })), 400, "VALIDATION_ERROR");
    assert.equal(db.transactions, 0);
  });
});

describe("applyDocumentStatus", () => {
  function fakeTx(currentStatus: string | null) {
    const calls: unknown[] = [];
    const tx = {
      incomingDocument: {
        updateMany: async (args: { where: { status: string } }) => {
          calls.push(args);
          return { count: currentStatus === args.where.status ? 1 : 0 };
        },
        findUnique: async () => (currentStatus ? { status: currentStatus } : null),
        findUniqueOrThrow: async () => ({ id: "doc_1", status: "sent_to_office" })
      }
    };
    return { tx: tx as unknown as Parameters<typeof applyDocumentStatus>[0], calls };
  }

  it("transición condicional: actualiza cuando el estado coincide", async () => {
    const { tx, calls } = fakeTx("captured");
    const row = await applyDocumentStatus(tx, "doc_1", { from: "captured", action: "send-to-office", to: "sent_to_office", data: { sentAt: NOW } });
    assert.equal(row.status, "sent_to_office");
    assert.deepEqual(calls[0], { where: { id: "doc_1", status: "captured" }, data: { status: "sent_to_office", sentAt: NOW } });
  });

  it("409 DOCUMENT_STATUS_TRANSITION { from, action } en otro estado; 404 opaco si no existe", async () => {
    const error = await expectHttp(() => applyDocumentStatus(fakeTx("sent_to_office").tx, "doc_1", { from: "captured", action: "send-to-office", to: "sent_to_office" }), 409, "DOCUMENT_STATUS_TRANSITION");
    assert.deepEqual(error.details, { code: "DOCUMENT_STATUS_TRANSITION", from: "sent_to_office", action: "send-to-office", to: "sent_to_office" });
    await expectHttp(() => applyDocumentStatus(fakeTx(null).tx, "doc_x", { from: "captured", action: "send-to-office", to: "sent_to_office" }), 404, "DOCUMENT_NOT_FOUND");
  });
});
