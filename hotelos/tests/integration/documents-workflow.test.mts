/**
 * Tanda T9 · lote T9-08 · integración (Postgres): flujo completo centro →
 * oficina sobre un tenant AISLADO (helpers/l2-tenant.mts, organización
 * `org_l2_t9wf…`) con auth real y RBAC_STRICT; Faranda y org_123 solo se leen
 * (invariantes antes y después).
 *
 *   · capturar (receptionist) → send-to-office → assign (administración del
 *     hotel + dirección) → review guarda reviewedFieldsJson y recalcula la
 *     propuesta → 409 DOCUMENT_CHECKS_FAILED sin override → approve
 *     create_supplier_bill con override → SupplierBill draft en el centro con
 *     incomingDocumentId, source digitized, receptionDate = captura,
 *     documentObjectKey `org/…` resoluble por GET …/attachment → downloadPath
 *     → bytes del original; el mismo revisor NO aprueba la factura (409
 *     RBAC_SOD_CONFLICT); dirección general la aprueba; contabilidad la
 *     contabiliza → documento posted y VatBookEntry.date = receptionDate;
 *     anular → documento in_review + aviso; reject returnToCentre →
 *     returned_to_centre + aviso al capturador → recapture → captured con el
 *     mismo registro; reject duplicate → rejected final con retención +1 año;
 *   · approve create_task sobre una notificación → archived + DocumentAction
 *     open con dueAt +10 naturales; archive de un contrato desde el centro →
 *     archived con retentionUntil 31/12 + 6; create_expense: 403 sin
 *     accounting.journal.post, 200 con contabilidad → posted + Expense sin IVA
 *     deducible; split / merge; valija: cerrar → in_transit + PDF de remesa,
 *     recibir → at_office; 404 opaco desde otra organización;
 *   · corrector T9 (revisión final): split lógico por páginas (cada trozo extrae
 *     SOLO su página; origen repartido entero → archived con mergedIntoId), 401
 *     al fallback demo sin token y 403 sin capture ∨ review en las rutas
 *     `authenticated`, enlace factura ↔ documento solo desde el flujo (400 /
 *     404 cross-tenant), retentionUntil al contabilizar, cartas a 6 años,
 *     autoSendToOffice, número revisado en la propuesta, anulación con nota,
 *     asignación solo a revisores, avisos a la oficina agrupados por hora y
 *     búsqueda por la nota de captura tras el pipeline.
 *
 * Almacén en disco temporal (DOCUMENT_STORAGE_KIND=disk sin cifrado); las
 * variables se fijan ANTES de importar el servidor. Fixtures inventadas
 * (modules/documents/__tests__/fixtures.ts); ningún nombre real.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/documents-workflow.test.mts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "ehotelos-t9wf-"));
process.env.DOCUMENT_STORAGE_KIND = "disk";
process.env.DOCUMENT_STORAGE_DIR = STORAGE_DIR;
process.env.DOCUMENT_ENCRYPT_AT_REST = "false";
process.env.DOCUMENT_MAX_BYTES = String(4 * 1024 * 1024);
process.env.DOCUMENT_UPLOAD_BODY_LIMIT = String(8 * 1024 * 1024);

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { resetDocumentsConfigForTests } = await import("../../apps/api/src/modules/documents/documents.config.js");
const { dueAtFor, retentionUntilFor } = await import("../../apps/api/src/modules/documents/retention-rules.js");
const fixtures = await import("../../apps/api/src/modules/documents/__tests__/fixtures.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, any>;
type Reply = { status: number; body: Json; raw: Buffer; headers: Record<string, string | string[] | undefined> };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, session: Session, payload?: unknown, propertyId?: string): Promise<Reply> {
  const res = await strict(() => app.inject({ method, url, headers: { ...session.headers, ...(propertyId ? { "x-property-id": propertyId } : {}) }, ...(payload === undefined ? {} : { payload }) }));
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers as Record<string, string | string[] | undefined> };
}

const codeOf = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;
const b64 = (bytes: Buffer): string => bytes.toString("base64");
const pdfUpload = (fileName: string, bytes: Buffer, extra: Json = {}): Json => ({ files: [{ fileName, mimeType: "application/pdf", base64: b64(bytes) }], ...extra });
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Usuario extra con una o varias plantillas en el centro (barrido por cleanupTenant). */
async function addUser(tenant: IsolatedTenant, key: string, templateKeys: string[], propertyIds: string[]): Promise<{ id: string; email: string }> {
  const id = `usr_t9wf_${key}_${tenant.run}`;
  const email = `${key}.t9wf.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `T9 ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  for (const templateKey of templateKeys) {
    const roleId = tenant.roles[templateKey];
    if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
    for (const propertyId of propertyIds) {
      await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId, organizationId: tenant.organizationId, reason: `t9wf ${key} ${templateKey}` } });
    }
  }
  resetRbacScopeCacheForTests();
  return { id, email };
}

/** Espera a que el pipeline en segundo plano (onCaptured) termine (extractionStatus ≠ pending). */
async function waitForBackground(documentId: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const row = await prisma.incomingDocument.findUnique({ where: { id: documentId }, select: { extractionStatus: true } });
    if (row && row.extractionStatus !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`El pipeline en segundo plano no terminó para ${documentId}.`);
}

async function capture(app: ApiApp, session: Session, propertyId: string, fileName: string, bytes: Buffer, extra: Json = {}): Promise<Json> {
  const reply = await call(app, "POST", `/properties/${propertyId}/documents`, session, pdfUpload(fileName, bytes, extra));
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  const record = (reply.body as unknown as Json[])[0]!;
  await waitForBackground(record.id);
  return record;
}

const RUN_A = `t9wf${newRunId()}`;
const RUN_B = `${RUN_A}b`;
const docs = `/properties/`;

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let receptionist: Session;
let clerk: Session;
let clerkUser: { id: string; email: string };
let director: Session;
let accountant: Session;
let ownerB: Session;
let receptionistB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

const INVOICE_1 = fixtures.demoInvoicePdf({ number: "T9-WF-0001" });
const INVOICE_2 = fixtures.demoInvoicePdf({ number: "T9-WF-0002" });
const NOTICE = fixtures.demoInvoicePdf({ number: "T9-WF-NOTIF" });
const CONTRACT = fixtures.demoInvoicePdf({ number: "T9-WF-CONTRATO" });
const RECEIPT = fixtures.demoInvoicePdf({ number: "T9-WF-TICKET" });
const RECAPTURE_PDF = fixtures.demoInvoicePdf({ number: "T9-WF-0001-bis", issueDate: "2026-09-02" });
const SPLIT_PDF = fixtures.multiPagePdf(3);
const BAG_1 = fixtures.demoInvoicePdf({ number: "T9-WF-VALIJA-1" });
const BAG_2 = fixtures.demoInvoicePdf({ number: "T9-WF-VALIJA-2" });

let doc1: Json;
let billId = "";
let originalKey = "";
let doc2: Json;
let notice: Json;
let contract: Json;
let receipt: Json;
let auditor: Session;
let sheetPath = "";
const OFFICE_SENT_TITLE = "Documentos pendientes en la oficina";
const orgDocs = (organizationId: string): string => `/organizations/${organizationId}/documents`;

/** Fallback demo sin token (HOTELOS_ALLOW_DEMO_AUTH=true, sin Authorization): las rutas `authenticated` deben responder 401 (RV-02). */
async function callAnonymous(method: "GET" | "POST", url: string, payload?: unknown): Promise<Reply> {
  const res = await withEnv({ ...STRICT_ENV, HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development" }, () => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }));
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers as Record<string, string | string[] | undefined> };
}

before(async () => {
  resetDocumentsConfigForTests();
  app = await buildApiServer();
  await app.ready();
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  await enableModules(tenantA.propertyA, ["erp_accounting", "procurement_inventory"]);
  // Administración del hotel (documents.review + payables.create + purchase_orders.receive) y dirección de hotel
  // (payables.approve): el mismo usuario registra la factura al aprobar el documento y NO puede aprobarla (SoD).
  clerkUser = await addUser(tenantA, "clerk", ["admin_clerk", "manager"], [tenantA.propertyA]);
  // Auditoría interna: solo documents.archive.read (ni capture ni review) → 403 en las rutas «capture ∨ review» (R4).
  const auditorUser = await addUser(tenantA, "auditor", ["auditor"], [tenantA.propertyA]);
  receptionist = await strict(() => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  auditor = await strict(() => loginOrThrow(app, auditorUser.email, tenantA.password));
  clerk = await strict(() => loginOrThrow(app, clerkUser.email, tenantA.password));
  director = await strict(() => loginOrThrow(app, tenantA.users.generalManager.email, tenantA.password));
  accountant = await strict(() => loginOrThrow(app, tenantA.users.accountant.email, tenantA.password));
  ownerB = await strict(() => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));
  receptionistB = await strict(() => loginOrThrow(app, tenantB.users.receptionist.email, tenantB.password));
});

after(async () => {
  try {
    await flushAuditQueues();
    if (tenantA) await cleanupTenant(tenantA.organizationId);
    if (tenantB) await cleanupTenant(tenantB.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: { in: [tenantA?.organizationId ?? "", tenantB?.organizationId ?? ""] } } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
    resetDocumentsConfigForTests();
    rmSync(STORAGE_DIR, { recursive: true, force: true });
  }
});

describe("T9-08 · factura: capturar → enviar → asignar → revisar → aprobar → SoD → aprobar → contabilizar → anular", () => {
  it("captura (receptionist), send-to-office y assign por la oficina → in_review con assignedTo y reviewStartedAt", async () => {
    doc1 = await capture(app, receptionist, tenantA.propertyA, "factura-lavanderia.pdf", INVOICE_1, { kindHint: "invoice" });
    assert.equal(doc1.status, "captured");
    const sent = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/send-to-office`, receptionist);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    // RV-10 (§6.3): aviso in-app a quien puede revisar en el centro (documents.review), nunca al capturador; enlace, no adjunto.
    const officeNotice = await prisma.notification.findFirst({ where: { organizationId: tenantA.organizationId, userId: clerkUser.id, title: { startsWith: OFFICE_SENT_TITLE } } });
    assert.ok(officeNotice, "aviso al revisor del centro");
    assert.match(officeNotice.body, new RegExp(doc1.registryNumber));
    assert.doesNotMatch(officeNotice.body, /JVBERi0|base64/);
    assert.equal(await prisma.notification.count({ where: { organizationId: tenantA.organizationId, userId: tenantA.users.receptionist.id, title: { startsWith: OFFICE_SENT_TITLE } } }), 0, "recepción (solo capture) no recibe el aviso");
    // El centro no asigna (documents.review): 403.
    const denied = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/assign`, receptionist, {});
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    // RV-13: solo se asigna a quien puede revisar en el centro (recepción no tiene documents.review) → 400.
    const notReviewer = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/assign`, clerk, { assignedTo: tenantA.users.receptionist.id });
    assert.equal(notReviewer.status, 400, JSON.stringify(notReviewer.body));
    assert.equal(codeOf(notReviewer), "VALIDATION_ERROR");
    assert.deepEqual(notReviewer.body.details.missing, ["documents.review"]);
    const assigned = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/assign`, clerk, {});
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.status, "in_review");
    assert.equal(assigned.body.assignedTo, clerkUser.id);
    assert.ok(assigned.body.reviewStartedAt);
    // Volver a asignar a otra persona sin salir del estado.
    const reassigned = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/assign`, clerk, { assignedTo: tenantA.users.accountant.id });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
    assert.equal(reassigned.body.assignedTo, tenantA.users.accountant.id);
    const badUser = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/assign`, clerk, { assignedTo: tenantB.users.owner.id });
    assert.equal(badUser.status, 400, JSON.stringify(badUser.body));
    // approve desde captured / sent_to_office no existe en la tabla: 409 con { from, action }.
    const notInReview = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/send-to-office`, receptionist);
    assert.equal(notInReview.status, 409);
    assert.equal(codeOf(notInReview), "DOCUMENT_STATUS_TRANSITION");
  });

  it("review guarda reviewedFieldsJson (mezcla), corrige el tipo y recalcula la propuesta; 404 opaco desde otra organización", async () => {
    const reviewed = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/review`, clerk, { reviewedFields: { invoiceNumber: "T9-WF-0001", supplierName: "Lavandería Cantábrica Demo SL" }, kind: "invoice", note: "Revisado" });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.status, "in_review");
    const again = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/review`, clerk, { reviewedFields: { documentNumber: "T9-WF-0001" } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: doc1.id } });
    assert.deepEqual(row.reviewedFieldsJson, { invoiceNumber: "T9-WF-0001", supplierName: "Lavandería Cantábrica Demo SL", documentNumber: "T9-WF-0001" });
    assert.equal(row.classificationSource, "manual");
    assert.equal(row.kind, "invoice");
    // RV-07: el número corregido por el revisor manda en la re-propuesta (y en la factura que nazca de ella).
    const corrected = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/review`, clerk, { reviewedFields: { invoiceNumber: "T9-WF-0001-REV" } });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
    const detailAfter = await call(app, "GET", `${docs}${tenantA.propertyA}/documents/${doc1.id}`, clerk);
    assert.equal(detailAfter.status, 200);
    assert.equal((detailAfter.body.proposal as Json)?.supplierBill?.invoiceNumber, "T9-WF-0001-REV", "la propuesta lleva el número revisado");
    assert.equal((detailAfter.body.reviewedFields as Json)?.invoiceNumber, "T9-WF-0001-REV");
    const restored = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/review`, clerk, { reviewedFields: { invoiceNumber: "T9-WF-0001" } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(((await call(app, "GET", `${docs}${tenantA.propertyA}/documents/${doc1.id}`, clerk)).body.proposal as Json)?.supplierBill?.invoiceNumber, "T9-WF-0001");
    const foreign = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/review`, ownerB, { reviewedFields: {} });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    const unknownKey = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/review`, clerk, { reviewedFields: {}, foo: 1 });
    assert.equal(unknownKey.status, 400);
    assert.equal(codeOf(unknownKey), "VALIDATION_ERROR");
  });

  it("approve create_supplier_bill: 409 DOCUMENT_CHECKS_FAILED con un check en fail sin override; 400 con cuerpo de otra acción; 200 con override → SupplierBill draft enlazada", async () => {
    const detail = await call(app, "GET", `${docs}${tenantA.propertyA}/documents/${doc1.id}`, clerk);
    assert.equal(detail.status, 200);
    // Comprobaciones deterministas: todas ok salvo `duplicate` en fail (forzado para probar el override).
    const checks = Object.fromEntries(Object.entries((detail.body.checks ?? {}) as Json).map(([key, check]) => [key, { ...(check as Json), status: "ok" }]));
    await prisma.incomingDocument.update({ where: { id: doc1.id }, data: { checksJson: { ...checks, duplicate: { status: "fail", message: "Prueba: duplicado forzado" } } } });
    const supplierBill = {
      supplierName: "Lavandería Cantábrica Demo SL",
      supplierTaxId: fixtures.DEMO_SUPPLIER_TAX_ID,
      invoiceNumber: "T9-WF-0001",
      issueDate: "2026-09-10",
      lines: [{ description: "Lavado y planchado", expenseAccountCode: "629", base: "100.00", taxRate: 21, quantity: "120.000", unitPrice: "1.2500", deliveryNoteRef: "ALB-77" }]
    };
    const failed = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/approve`, clerk, { action: "create_supplier_bill", supplierBill });
    assert.equal(failed.status, 409, JSON.stringify(failed.body));
    assert.equal(codeOf(failed), "DOCUMENT_CHECKS_FAILED");
    assert.deepEqual(failed.body.details.failed, ["duplicate"]);
    const wrongBody = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/approve`, clerk, { action: "archive", supplierBill, override: { reason: "prueba" } });
    assert.equal(wrongBody.status, 400, JSON.stringify(wrongBody.body));
    assert.equal(codeOf(wrongBody), "DOCUMENT_ACTION_INVALID_FOR_KIND");
    assert.equal(await prisma.supplierBill.count({ where: { organizationId: tenantA.organizationId } }), 0, "ningún rechazo deja factura");

    const approved = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/approve`, clerk, { action: "create_supplier_bill", supplierBill, override: { reason: "Factura reenviada por el proveedor" } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.document.status, "approved");
    assert.equal(approved.body.document.decidedBy, clerkUser.id);
    assert.ok(approved.body.supplierBillId);
    assert.deepEqual(approved.body.overriddenChecks, ["duplicate"]);
    assert.ok(typeof approved.body.sodNote === "string" && approved.body.sodNote.length > 10);
    billId = approved.body.supplierBillId;
    const bill = approved.body.supplierBill as Json;
    assert.equal(bill.status, "draft");
    assert.equal(bill.propertyId, tenantA.propertyA);
    assert.equal(bill.incomingDocumentId, doc1.id);
    assert.equal(bill.source, "digitized");
    assert.equal(bill.matchStatus, "none");
    assert.equal(bill.receptionDate, isoDay(new Date(doc1.capturedAt)));
    assert.equal(bill.total, "121.00");
    assert.equal(bill.hasAttachment, true);
    assert.equal(bill.lines[0].quantity, "120.000");
    assert.equal(bill.lines[0].unitPrice, "1.2500");
    assert.equal(bill.lines[0].deliveryNoteRef, "ALB-77");
    assert.equal(bill.supplierTaxId, fixtures.DEMO_SUPPLIER_TAX_ID);

    const billRow = await prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } });
    assert.equal(billRow.createdByUserId, clerkUser.id, "quien aprueba queda como registrador (SoD)");
    const file = await prisma.documentFile.findFirstOrThrow({ where: { documentId: doc1.id, role: "original" } });
    originalKey = file.storageKey!;
    assert.equal(billRow.documentObjectKey, originalKey);
    assert.match(originalKey, /^org\//);
    const docRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: doc1.id } });
    assert.equal(docRow.supplierBillId, billId);
    assert.equal(docRow.status, "approved");
    if (approved.body.createdSupplierId) {
      const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: approved.body.createdSupplierId } });
      assert.equal(supplier.organizationId, tenantA.organizationId, "el alta del proveedor solo en la organización que aprueba");
      assert.equal(billRow.supplierId, supplier.id);
    }
    // La revisión de la cola genérica queda decidida.
    if (docRow.reviewItemId) {
      const item = await prisma.aiHumanReviewItem.findUniqueOrThrow({ where: { id: docRow.reviewItemId } });
      assert.equal(item.status, "approved");
    }
    const twice = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/approve`, clerk, { action: "archive" });
    assert.equal(twice.status, 409);
    assert.equal(codeOf(twice), "DOCUMENT_STATUS_TRANSITION");
    assert.equal(twice.body.details.from, "approved");
  });

  it("GET …/supplier-bills/:id/attachment resuelve la clave org/… a downloadPath y la descarga sirve el original", async () => {
    const attachment = await call(app, "GET", `${docs}${tenantA.propertyA}/payables/supplier-bills/${billId}/attachment`, clerk);
    assert.equal(attachment.status, 200, JSON.stringify(attachment.body));
    assert.equal(attachment.body.inline, false);
    assert.equal(attachment.body.documentObjectKey, originalKey);
    assert.equal(attachment.body.documentId, doc1.id);
    assert.equal(attachment.body.downloadPath, `/properties/${tenantA.propertyA}/documents/${doc1.id}/file`);
    const download = await call(app, "GET", attachment.body.downloadPath, clerk);
    assert.equal(download.status, 200);
    assert.equal(download.headers["content-type"], "application/pdf");
    assert.ok(download.raw.equals(INVOICE_1), "bytes del original");
    const listed = await call(app, "GET", `${docs}${tenantA.propertyA}/payables/supplier-bills`, clerk);
    assert.equal(listed.status, 200);
    const mine = (listed.body as unknown as Json[]).find((bill) => bill.id === billId);
    assert.ok(mine);
    assert.equal(mine.source, "digitized");
    assert.equal(mine.incomingDocumentId, doc1.id);
  });

  it("SoD: el revisor que la registró NO puede aprobarla (409 RBAC_SOD_CONFLICT); dirección general la aprueba; contabilidad la contabiliza → documento posted y libro de recibidas fechado por receptionDate", async () => {
    const self = await call(app, "POST", `${docs}${tenantA.propertyA}/payables/supplier-bills/${billId}/approve`, clerk, {});
    assert.equal(self.status, 409, JSON.stringify(self.body));
    assert.equal(codeOf(self), "RBAC_SOD_CONFLICT");
    const approved = await call(app, "POST", `${docs}${tenantA.propertyA}/payables/supplier-bills/${billId}/approve`, director, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "approved");
    const posted = await call(app, "POST", `${docs}${tenantA.propertyA}/payables/supplier-bills/${billId}/post`, accountant, {});
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.status, "posted");
    assert.ok(posted.body.journalEntryId);
    const docRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: doc1.id } });
    assert.equal(docRow.status, "posted");
    assert.ok(docRow.postedAt, "postedAt del documento = el de la factura");
    // RV-04 (§3.2 / §7.5): al contabilizar, la factura recibe su retención: 31/12 del ejercicio de expedición + 6 años.
    assert.equal(isoDay(docRow.retentionUntil!), "2032-12-31");
    const vat = await prisma.vatBookEntry.findFirst({ where: { organizationId: tenantA.organizationId, sourceType: "supplier_bill", sourceId: billId } });
    assert.ok(vat, "fila del libro de recibidas");
    assert.equal(isoDay(vat.date), isoDay(new Date(doc1.capturedAt)), "VatBookEntry.date = receptionDate (no la fecha de expedición 2026-09-10)");
    assert.equal(vat.number, "T9-WF-0001");
  });

  it("anular la factura devuelve el documento a in_review con aviso in-app a quien lo decidió", async () => {
    const cancelled = await call(app, "POST", `${docs}${tenantA.propertyA}/payables/supplier-bills/${billId}/cancel`, accountant, { reason: "Prueba de anulación T9" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, "cancelled");
    const docRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: doc1.id } });
    assert.equal(docRow.status, "in_review");
    assert.equal(docRow.postedAt, null);
    assert.equal(docRow.decidedBy, null);
    // RV-19 (§6.1 «vuelve a in_review con nota»): sin la factura anulada colgando y con el motivo en el documento; la retención se fijará al decidir de nuevo.
    assert.equal(docRow.supplierBillId, null);
    assert.match(docRow.rejectNote ?? "", /anulada: Prueba de anulación T9/);
    assert.equal(docRow.retentionUntil, null);
    const notification = await prisma.notification.findFirst({ where: { organizationId: tenantA.organizationId, userId: clerkUser.id, title: { contains: doc1.registryNumber } } });
    assert.ok(notification, "aviso al revisor");
    assert.equal(notification.status, "unread");
    assert.match(notification.body, /anulado/);
  });

  it("reject returnToCentre → returned_to_centre con aviso al capturador; recapture → captured con el mismo registro; reject sin motivo válido → 400", async () => {
    const badReason = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/reject`, clerk, { reason: "duplicate", returnToCentre: true });
    assert.equal(badReason.status, 400, JSON.stringify(badReason.body));
    const returned = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/reject`, clerk, { reason: "illegible", returnToCentre: true, note: "borroso" });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.document.status, "returned_to_centre");
    assert.equal(returned.body.document.rejectReason, "illegible");
    assert.equal(returned.body.document.rejectNote, "borroso");
    assert.equal(returned.body.notifiedUserId, receptionist.userId);
    const notification = await prisma.notification.findFirst({ where: { organizationId: tenantA.organizationId, userId: receptionist.userId, title: { contains: doc1.registryNumber } } });
    assert.ok(notification, "aviso al capturador");
    assert.match(notification.body, /illegible/);
    const recaptured = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/recapture`, receptionist, { fileName: "factura-bis.pdf", mimeType: "application/pdf", base64: b64(RECAPTURE_PDF) });
    assert.equal(recaptured.status, 200, JSON.stringify(recaptured.body));
    assert.equal(recaptured.body.status, "captured");
    assert.equal(recaptured.body.registryNumber, doc1.registryNumber, "mismo número de registro");
    assert.equal(recaptured.body.rejectReason, null);
    await waitForBackground(doc1.id);
  });

  it("reject duplicate (final) → rejected con retentionUntil 31/12 + 1 año y enlace al original en la auditoría", async () => {
    doc2 = await capture(app, receptionist, tenantA.propertyA, "factura-copia.pdf", INVOICE_2, { kindHint: "invoice" });
    await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc2.id}/send-to-office`, receptionist);
    const assigned = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc2.id}/assign`, clerk, {});
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const rejected = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc2.id}/reject`, clerk, { reason: "duplicate", duplicateOfId: doc1.id });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.document.status, "rejected");
    assert.equal(rejected.body.document.rejectReason, "duplicate");
    assert.equal(rejected.body.document.rejectNote, `Duplicado de ${doc1.registryNumber}`);
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: doc2.id } });
    const expected = retentionUntilFor({ kind: "invoice", documentDate: row.documentDate ?? row.capturedAt, status: "rejected" });
    assert.equal(isoDay(row.retentionUntil!), isoDay(expected));
    assert.match(isoDay(row.retentionUntil!), /-12-31$/);
    assert.equal(row.retentionUntil!.getUTCFullYear(), (row.documentDate ?? row.capturedAt).getUTCFullYear() + 1);
    const final = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc2.id}/reject`, clerk, { reason: "other" });
    assert.equal(final.status, 409);
    assert.equal(codeOf(final), "DOCUMENT_STATUS_TRANSITION");
    assert.equal(final.body.details.from, "rejected");
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: tenantA.organizationId, action: "DOCUMENT_REJECTED", entityId: doc2.id } });
    assert.ok(audit);
    assert.equal((audit.afterJson as Json).duplicateOfId, doc1.id);
  });
});

describe("T9-08 · tarea, archivo, gasto", () => {
  it("approve create_task sobre una notificación → archived + DocumentAction open con dueAt +10 naturales; PATCH la cierra", async () => {
    notice = await capture(app, receptionist, tenantA.propertyA, "notificacion.pdf", NOTICE, { kindHint: "administrative_notice" });
    await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${notice.id}/send-to-office`, receptionist);
    const reviewed = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${notice.id}/review`, clerk, { reviewedFields: { senderName: "Ayuntamiento demo" } });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.status, "in_review", "el primer review autoasigna");
    assert.equal(reviewed.body.assignedTo, clerkUser.id);
    const approved = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${notice.id}/approve`, clerk, { action: "create_task", task: { kind: "respond", title: "Contestar al requerimiento", assignedTo: tenantA.users.accountant.id } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.document.status, "archived");
    assert.ok(approved.body.actionId);
    assert.equal(approved.body.action.status, "open");
    assert.equal(approved.body.action.assignedTo, tenantA.users.accountant.id);
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: notice.id } });
    const expectedDue = dueAtFor("administrative_notice", row.documentDate ?? row.capturedAt)!;
    assert.equal(approved.body.action.dueAt, expectedDue.toISOString());
    assert.equal(approved.body.document.dueAt, expectedDue.toISOString(), "el documento expone el plazo de la tarea abierta");
    assert.ok(expectedDue.getTime() - (row.documentDate ?? row.capturedAt).getTime() >= 10 * 86_400_000 - 1);
    assert.ok(row.archivedAt && row.retentionUntil);
    const notified = await prisma.notification.findFirst({ where: { organizationId: tenantA.organizationId, userId: tenantA.users.accountant.id, title: { contains: "Contestar" } } });
    assert.ok(notified, "aviso a la persona asignada");
    const done = await call(app, "PATCH", `${docs}${tenantA.propertyA}/documents/${notice.id}/actions/${approved.body.actionId}`, clerk, { status: "done", outcomeNote: "Contestado" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, "done");
    assert.equal(done.body.completedBy, clerkUser.id);
    const reopen = await call(app, "PATCH", `${docs}${tenantA.propertyA}/documents/${notice.id}/actions/${approved.body.actionId}`, clerk, { status: "cancelled" });
    assert.equal(reopen.status, 409);
    const extra = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${notice.id}/actions`, clerk, { kind: "file", title: "Archivar copia", dueAt: null });
    assert.equal(extra.status, 201, JSON.stringify(extra.body));
    assert.equal(extra.body.dueAt, null);
  });

  it("archive de un contrato desde el centro → archived con retentionUntil 31/12 + 6; una factura no se archiva desde el centro (400)", async () => {
    contract = await capture(app, receptionist, tenantA.propertyA, "contrato.pdf", CONTRACT, { kindHint: "contract" });
    const denied = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${contract.id}/archive`, receptionist, {});
    assert.equal(denied.status, 403, "documents.review");
    const archived = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${contract.id}/archive`, clerk, { legalHold: true });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.document.status, "archived");
    assert.equal(archived.body.document.legalHold, true);
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: contract.id } });
    assert.equal(isoDay(row.retentionUntil!), `${(row.documentDate ?? row.capturedAt).getUTCFullYear() + 6}-12-31`);
    const invoiceDoc = await capture(app, receptionist, tenantA.propertyA, "factura-centro.pdf", fixtures.demoInvoicePdf({ number: "T9-WF-CENTRO" }), { kindHint: "invoice" });
    const wrongKind = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${invoiceDoc.id}/archive`, clerk, {});
    assert.equal(wrongKind.status, 400, JSON.stringify(wrongKind.body));
    assert.equal(codeOf(wrongKind), "DOCUMENT_ACTION_INVALID_FOR_KIND");
  });

  it("approve create_expense: 403 sin accounting.journal.post (clave extra); 200 con contabilidad → posted + Expense sin IVA deducible", async () => {
    receipt = await capture(app, receptionist, tenantA.propertyA, "ticket.pdf", RECEIPT, { kindHint: "receipt" });
    await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${receipt.id}/send-to-office`, receptionist);
    await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${receipt.id}/assign`, accountant, {});
    const expense = { supplierName: "Cafetería demo", concept: "Cafés reunión", accountCode: "629", base: "10.00", taxRate: 21, paidWith: "cash" };
    const denied = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${receipt.id}/approve`, clerk, { action: "create_expense", expense });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.match(String(denied.body.message), /accounting\.journal\.post/);
    const detail = await call(app, "GET", `${docs}${tenantA.propertyA}/documents/${receipt.id}`, accountant);
    // RV-11: un tique sin líneas extraídas no es una contradicción: `totals` avisa (formulario manual), no falla.
    assert.notEqual((detail.body.checks as Json)?.totals?.status, "fail", JSON.stringify((detail.body.checks as Json)?.totals));
    const failing = Object.entries((detail.body.checks ?? {}) as Json).filter(([, check]) => (check as Json).status === "fail").map(([key]) => key);
    const approved = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${receipt.id}/approve`, accountant, { action: "create_expense", expense, ...(failing.length > 0 ? { override: { reason: `Prueba de integración (${failing.join(", ")})` } } : {}) });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.document.status, "posted");
    assert.ok(approved.body.expenseId);
    // RV-04: el gasto contabilizado también recibe su retención (31/12 del ejercicio del gasto + 6).
    assert.equal(approved.body.document.retentionUntil, `${new Date(receipt.capturedAt).getUTCFullYear() + 6}-12-31`);
    const expenseRow = await prisma.expense.findUniqueOrThrow({ where: { id: approved.body.expenseId } });
    assert.equal(expenseRow.vatDeductible, false, "ticket sin NIF → sin IVA deducible");
    assert.equal(expenseRow.propertyId, tenantA.propertyA);
    assert.ok(expenseRow.journalEntryId);
    const docRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: receipt.id } });
    assert.equal(docRow.expenseId, expenseRow.id);
    assert.ok(docRow.postedAt);
  });
});

describe("T9-08 · recepción de mercancía (T9-09 en la misma transacción)", () => {
  it("approve create_goods_receipt sobre un albarán (purchase_orders.receive) → posted + GoodsReceipt received enlazado; 409 GOODS_RECEIPT_DUPLICATE reenviado", async () => {
    const note = await capture(app, receptionist, tenantA.propertyA, "albaran.pdf", fixtures.demoInvoicePdf({ number: "T9-WF-ALB-1" }), { kindHint: "delivery_note" });
    await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${note.id}/send-to-office`, receptionist);
    await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${note.id}/assign`, clerk, {});
    const detail = await call(app, "GET", `${docs}${tenantA.propertyA}/documents/${note.id}`, clerk);
    const failing = Object.entries((detail.body.checks ?? {}) as Json).filter(([, check]) => (check as Json).status === "fail").map(([key]) => key);
    const goodsReceipt = { supplierName: "Lavandería Cantábrica Demo SL", supplierTaxId: fixtures.DEMO_SUPPLIER_TAX_ID, deliveryNoteNumber: "ALB-77", deliveryDate: "2026-09-18", lines: [{ description: "Sábanas (kg)", quantityReceived: "120.000", unit: "kg", unitPrice: "1.2500", base: "150.00", taxRate: 21 }] };
    const override = failing.length > 0 ? { override: { reason: `Prueba de integración (${failing.join(", ")})` } } : {};
    const approved = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${note.id}/approve`, clerk, { action: "create_goods_receipt", goodsReceipt, ...override });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.document.status, "posted");
    assert.ok(approved.body.goodsReceiptId);
    const receipt = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: approved.body.goodsReceiptId }, include: { lines: true } });
    assert.equal(receipt.incomingDocumentId, note.id);
    assert.equal(receipt.propertyId, tenantA.propertyA);
    assert.equal(receipt.organizationId, tenantA.organizationId);
    assert.equal(receipt.status, "received");
    assert.equal(receipt.lines.length, 1);
    const docRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: note.id } });
    assert.equal(docRow.goodsReceiptId, receipt.id);
    assert.ok(docRow.postedAt);
    assert.equal(isoDay(docRow.retentionUntil!), `${(docRow.documentDate ?? docRow.capturedAt).getUTCFullYear() + 6}-12-31`, "RV-04: la recepción contabilizada lleva retención");
    // Mismo albarán del mismo proveedor en otro documento → 409 del dominio, sin transición.
    const twin = await capture(app, receptionist, tenantA.propertyA, "albaran-2.pdf", fixtures.demoInvoicePdf({ number: "T9-WF-ALB-2" }), { kindHint: "delivery_note" });
    await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${twin.id}/send-to-office`, receptionist);
    await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${twin.id}/assign`, clerk, {});
    const duplicate = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${twin.id}/approve`, clerk, { action: "create_goods_receipt", goodsReceipt, override: { reason: "Prueba de duplicado" } });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(codeOf(duplicate), "GOODS_RECEIPT_DUPLICATE");
    const twinRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: twin.id } });
    assert.equal(twinRow.status, "in_review", "la transacción no deja transición a medias");
    assert.equal(twinRow.goodsReceiptId, null);
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: tenantA.organizationId, action: "GOODS_RECEIPT_CREATED", entityId: receipt.id } }), 1);
  });
});

describe("T9-08 · dividir / unir y valija", () => {
  it("split por rangos → trozos captured con registro propio y copia del fichero; merge → absorbido archived con mergedIntoId", async () => {
    const multi = await capture(app, receptionist, tenantA.propertyA, "lote-escaner.pdf", SPLIT_PDF, { kindHint: "invoice" });
    assert.equal(multi.pageCount, 3);
    const bad = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${multi.id}/split`, receptionist, { ranges: [[1, 4]] });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const split = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${multi.id}/split`, receptionist, { ranges: [[1, 1], [2, 3]] });
    assert.equal(split.status, 200, JSON.stringify(split.body));
    assert.equal(split.body.pieces.length, 2);
    const [pieceA, pieceB] = split.body.pieces as Json[];
    assert.equal(pieceA.status, "captured");
    assert.equal(pieceA.pageCount, 1);
    assert.equal(pieceB.pageCount, 2);
    assert.notEqual(pieceA.registryNumber, multi.registryNumber);
    assert.notEqual(pieceA.registryNumber, pieceB.registryNumber);
    assert.equal(pieceA.sha256, multi.sha256);
    // RV-03: repartidas TODAS las páginas, el origen no queda como cascarón captured: archived, absorbido por el primer trozo.
    assert.equal(split.body.document.pageCount, 0);
    assert.equal(split.body.document.status, "archived");
    assert.equal(split.body.document.mergedIntoId, pieceA.id);
    assert.ok(split.body.document.retentionUntil, "retención por tipo al absorberlo");
    const originRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: multi.id } });
    assert.deepEqual(originRow.sourcePagesJson, []);
    const emptySend = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${multi.id}/send-to-office`, receptionist);
    assert.equal(emptySend.status, 409, JSON.stringify(emptySend.body));
    assert.equal(codeOf(emptySend), "DOCUMENT_STATUS_TRANSITION");
    const fileA = await prisma.documentFile.findFirstOrThrow({ where: { documentId: pieceA.id, role: "original" } });
    assert.ok(existsSync(join(STORAGE_DIR, fileA.storageKey!)), "copia en disco del trozo");
    assert.equal(await prisma.documentPage.count({ where: { documentId: pieceB.id } }), 2);
    await waitForBackground(pieceA.id);
    await waitForBackground(pieceB.id);
    // RV-01: tras su pipeline cada trozo conserva SOLO sus páginas lógicas (el PDF físico es el lote entero).
    const pieceARow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: pieceA.id } });
    assert.deepEqual(pieceARow.sourcePagesJson, [1]);
    assert.equal(pieceARow.pageCount, 1);
    assert.equal(await prisma.documentPage.count({ where: { documentId: pieceA.id } }), 1);
    const pieceBRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: pieceB.id } });
    assert.deepEqual(pieceBRow.sourcePagesJson, [2, 3]);
    assert.equal(pieceBRow.pageCount, 2);
    const pagesB = await prisma.documentPage.findMany({ where: { documentId: pieceB.id }, orderBy: { pageNo: "asc" } });
    assert.deepEqual(pagesB.map((page) => page.pageNo), [1, 2]);
    assert.match(pagesB[0]!.textExtracted ?? "", /Página 2 de 3/);
    assert.match(pagesB[1]!.textExtracted ?? "", /Página 3 de 3/);
    const merged = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${pieceA.id}/merge`, receptionist, { withIds: [pieceB.id] });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.absorbed.length, 1);
    assert.equal(merged.body.absorbed[0].status, "archived");
    assert.equal(merged.body.absorbed[0].mergedIntoId, pieceA.id);
    assert.equal(merged.body.document.pageCount, 3, "el desplazamiento del merge es el pageCount lógico, sin filas duplicadas");
    const mergedPages = await prisma.documentPage.findMany({ where: { documentId: pieceA.id }, orderBy: { pageNo: "asc" } });
    assert.deepEqual(mergedPages.map((page) => page.pageNo), [1, 2, 3]);
    assert.equal(await prisma.documentFile.count({ where: { documentId: pieceB.id } }), 0, "los ficheros pasan al destino");
    assert.equal(await prisma.documentFile.count({ where: { documentId: pieceA.id, role: "derived" } }), 1);
    const again = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${pieceA.id}/merge`, receptionist, { withIds: [pieceB.id] });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(codeOf(again), "DOCUMENT_STATUS_TRANSITION");
    const denied = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${pieceA.id}/split`, ownerB, { ranges: [[1, 1]] });
    assert.equal(denied.status, 404);
  });

  it("valija: cerrar → lote 1 in_transit + hoja de remesa PDF; recibir (oficina) → at_office; el resto sigue in_transit; 403 al centro", async () => {
    const bag1 = await capture(app, receptionist, tenantA.propertyA, "valija-1.pdf", BAG_1, { kindHint: "invoice" });
    const bag2 = await capture(app, receptionist, tenantA.propertyA, "valija-2.pdf", BAG_2, { kindHint: "delivery_note" });
    const closed = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/dispatch-batches`, receptionist, { documentIds: [bag2.id, bag1.id] });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal(closed.body.batchNumber, "1");
    assert.equal(closed.body.documentCount, 2);
    assert.deepEqual(closed.body.registryNumbers, [bag1.registryNumber, bag2.registryNumber].sort());
    assert.equal(closed.body.closedBy, receptionist.userId);
    assert.ok(closed.body.sheetFileId);
    assert.equal(closed.body.sheetDownloadPath, `/properties/${tenantA.propertyA}/documents/dispatch-batches/${closed.body.id}/sheet`);
    sheetPath = closed.body.sheetDownloadPath;
    assert.match(closed.body.sheetFileName, /^remesa-l2a-0001\.pdf$/);
    const rows = await prisma.incomingDocument.findMany({ where: { id: { in: [bag1.id, bag2.id] } }, select: { physicalStatus: true, dispatchBatchId: true } });
    assert.deepEqual(rows.map((row) => row.physicalStatus), ["in_transit", "in_transit"]);
    assert.ok(rows.every((row) => row.dispatchBatchId === closed.body.id));
    const sheetFile = await prisma.documentFile.findUniqueOrThrow({ where: { id: closed.body.sheetFileId } });
    assert.equal(sheetFile.role, "dispatch_sheet");
    assert.ok(existsSync(join(STORAGE_DIR, sheetFile.storageKey!)));

    const sheet = await call(app, "GET", closed.body.sheetDownloadPath, clerk);
    assert.equal(sheet.status, 200, sheet.raw.toString("utf8").slice(0, 200));
    assert.equal(sheet.headers["content-type"], "application/pdf");
    assert.equal(sheet.raw.subarray(0, 5).toString("latin1"), "%PDF-");
    const text = sheet.raw.toString("latin1");
    assert.ok(text.includes(bag1.registryNumber) && text.includes(bag2.registryNumber));
    assert.ok(text.includes("Copia digital no certificada"));

    const again = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/dispatch-batches`, receptionist, { documentIds: [bag1.id] });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(codeOf(again), "DOCUMENT_STATUS_TRANSITION");
    assert.equal(again.body.details.from, "in_transit");

    const deniedReceive = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/dispatch-batches/${closed.body.id}/receive`, receptionist, { receivedIds: [bag1.id] });
    assert.equal(deniedReceive.status, 403, JSON.stringify(deniedReceive.body));
    const received = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/dispatch-batches/${closed.body.id}/receive`, clerk, { receivedIds: [bag1.id] });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.receivedBy, clerkUser.id);
    assert.ok(received.body.receivedAt);
    assert.deepEqual(received.body.receivedIds, [bag1.id]);
    assert.deepEqual(received.body.pendingIds, [bag2.id]);
    const after = await prisma.incomingDocument.findMany({ where: { id: { in: [bag1.id, bag2.id] } }, select: { id: true, physicalStatus: true } });
    assert.equal(after.find((row) => row.id === bag1.id)?.physicalStatus, "at_office");
    assert.equal(after.find((row) => row.id === bag2.id)?.physicalStatus, "in_transit");
    const foreign = await call(app, "GET", closed.body.sheetDownloadPath, ownerB);
    assert.equal(foreign.status, 404);
  });

  it("auditoría: DOCUMENT_ASSIGNED / REVIEWED / APPROVED / REJECTED / ARCHIVED / DISPATCHED sin claves del almacén; 404 opaco al aprobar desde otra organización", async () => {
    await flushAuditQueues();
    for (const action of ["DOCUMENT_ASSIGNED", "DOCUMENT_REVIEWED", "DOCUMENT_APPROVED", "DOCUMENT_REJECTED", "DOCUMENT_ARCHIVED", "DOCUMENT_DISPATCHED", "DOCUMENT_DISPATCH_RECEIVED", "DOCUMENT_SPLIT", "DOCUMENT_MERGED", "DOCUMENT_ACTION_CREATED"]) {
      const events = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, action } });
      assert.ok(events.length >= 1, `${action} auditado (hay ${events.length})`);
      for (const event of events) {
        assert.equal(event.entityType, "incoming_document");
        assert.equal(JSON.stringify(event.afterJson ?? {}).includes("org/"), false, `${action} sin clave del almacén`);
      }
    }
    // SEC-02: la nota de captura nunca va a la auditoría inmutable (solo `withNote` en ficheros / recapturas).
    for (const action of ["DOCUMENT_CAPTURED", "DOCUMENT_RECAPTURED", "DOCUMENT_FILE_ADDED"]) {
      for (const event of await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, action } })) {
        assert.equal("note" in ((event.afterJson ?? {}) as Json), false, `${action} sin nota de captura`);
      }
    }
    const foreign = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${doc1.id}/approve`, ownerB, { action: "archive" });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  });
});

describe("Corrector T9 · split por páginas, sesión real, claves, enlace factura ↔ documento, ajustes", () => {
  it("RV-01: un lote de 2 facturas dividido [[1,1],[2,2]] → cada trozo extrae SOLO su factura (número, NIF, total), una página y aviso pdf_split_text_only", async () => {
    const otherTaxId = fixtures.cifFor("B", "0007777");
    const batch = fixtures.multiInvoicePdf([{ number: "RV-SPLIT-0001" }, { number: "RV-SPLIT-0002", taxId: otherTaxId, lines: [{ description: "Servicio dos", quantity: 2, unitPrice: 100, taxRate: 21 }] }]);
    const lot = await capture(app, receptionist, tenantA.propertyA, "lote-2-facturas.pdf", batch, { kindHint: "invoice", note: "nota de captura RV" });
    assert.equal(lot.pageCount, 2);
    const split = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${lot.id}/split`, receptionist, { ranges: [[1, 1], [2, 2]] });
    assert.equal(split.status, 200, JSON.stringify(split.body));
    const [first, second] = split.body.pieces as Json[];
    await waitForBackground(first.id);
    await waitForBackground(second.id);
    const detailFirst = await call(app, "GET", `${docs}${tenantA.propertyA}/documents/${first.id}`, clerk);
    const detailSecond = await call(app, "GET", `${docs}${tenantA.propertyA}/documents/${second.id}`, clerk);
    assert.equal(detailFirst.status, 200);
    assert.equal(detailSecond.status, 200);
    assert.equal(detailFirst.body.documentNumber, "RV-SPLIT-0001");
    assert.equal(detailFirst.body.supplierTaxId, fixtures.DEMO_SUPPLIER_TAX_ID);
    assert.equal(detailFirst.body.pageCount, 1);
    assert.equal((detailFirst.body.pages as Json[]).length, 1);
    assert.equal(detailSecond.body.documentNumber, "RV-SPLIT-0002");
    assert.equal(detailSecond.body.supplierTaxId, otherTaxId);
    assert.equal(detailSecond.body.totalAmount, "242.00");
    assert.equal(detailSecond.body.pageCount, 1);
    assert.equal((detailSecond.body.pages as Json[]).length, 1);
    assert.match(String((detailSecond.body.pages as Json[])[0]!.textExtracted), /RV-SPLIT-0002/);
    assert.doesNotMatch(String((detailSecond.body.pages as Json[])[0]!.textExtracted), /RV-SPLIT-0001/);
    assert.ok(((detailSecond.body.extraction as Json).warnings as string[]).includes("pdf_split_text_only"));
    assert.equal(split.body.document.status, "archived");
    assert.equal(split.body.document.mergedIntoId, first.id);
    // RV-18: la nota de captura sobrevive a la extracción (heredada por los trozos) y la búsqueda la encuentra.
    const found = await call(app, "GET", `${docs}${tenantA.propertyA}/documents?q=${encodeURIComponent("nota de captura RV")}&status=captured`, clerk);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    const foundIds = (found.body as unknown as Json[]).map((row) => row.id);
    assert.ok(foundIds.includes(first.id) && foundIds.includes(second.id), `q sobre la nota tras el pipeline: ${JSON.stringify(foundIds)}`);
  });

  it("RV-02: sin sesión real (fallback demo sin token) las nueve rutas authenticated responden 401 aunque el fallback siga sirviendo /users/me", async () => {
    const control = await callAnonymous("GET", "/users/me");
    assert.equal(control.status, 200, `el fallback demo está activo: ${JSON.stringify(control.body)}`);
    const base = `${docs}${tenantA.propertyA}/documents`;
    const attempts: Array<[string, "GET" | "POST", string, unknown?]> = [
      ["bandeja", "GET", base],
      ["detalle", "GET", `${base}/${doc1.id}`],
      ["descarga", "GET", `${base}/${doc1.id}/file`],
      ["imagen de página", "GET", `${base}/${doc1.id}/pages/1/image`],
      ["classify", "POST", `${base}/${doc1.id}/classify`, {}],
      ["extract", "POST", `${base}/${doc1.id}/extract`, {}],
      ["split", "POST", `${base}/${doc1.id}/split`, { ranges: [[1, 1]] }],
      ["merge", "POST", `${base}/${doc1.id}/merge`, { withIds: [doc2?.id ?? doc1.id] }],
      ["hoja de remesa", "GET", sheetPath]
    ];
    for (const [label, method, url, payload] of attempts) {
      const reply = await callAnonymous(method, url, payload);
      assert.equal(reply.status, 401, `${label}: ${JSON.stringify(reply.body)}`);
    }
  });

  it("R4: una sesión real sin capture ∨ review (auditoría interna: solo archive.read) → 403 en bandeja, detalle, classify, extract, split, merge y hoja de remesa; 200 en la descarga (archive.read)", async () => {
    const base = `${docs}${tenantA.propertyA}/documents`;
    const denied: Array<[string, "GET" | "POST", string, unknown?]> = [
      ["bandeja", "GET", base],
      ["detalle", "GET", `${base}/${doc1.id}`],
      ["classify", "POST", `${base}/${doc1.id}/classify`, {}],
      ["extract", "POST", `${base}/${doc1.id}/extract`, {}],
      ["split", "POST", `${base}/${doc1.id}/split`, { ranges: [[1, 1]] }],
      ["merge", "POST", `${base}/${doc1.id}/merge`, { withIds: [doc1.id] }],
      ["hoja de remesa", "GET", sheetPath]
    ];
    for (const [label, method, url, payload] of denied) {
      const reply = await call(app, method, url, auditor, payload);
      assert.equal(reply.status, 403, `${label}: ${JSON.stringify(reply.body)}`);
    }
    const file = await call(app, "GET", `${base}/${doc1.id}/file`, auditor);
    assert.equal(file.status, 200, JSON.stringify(file.body));
    assert.equal(file.headers["content-type"], "application/pdf");
  });

  it("SEC-01: por HTTP incomingDocumentId y source ≠ manual se rechazan (400) al crear y al modificar; desde el flujo, un documento de otra organización → 404 y sin efecto", async () => {
    const foreignDoc = await capture(app, receptionistB, tenantB.propertyA, "factura-b.pdf", fixtures.demoInvoicePdf({ number: "T9-WF-B-0001" }), { kindHint: "invoice" });
    const bill = { supplierName: "Proveedor cruzado demo", supplierTaxId: fixtures.DEMO_SUPPLIER_TAX_ID, invoiceNumber: "T9-WF-X-0001", issueDate: "2026-09-12", lines: [{ description: "Servicio", expenseAccountCode: "629", base: "10.00", taxRate: 21 }] };
    const linked = await call(app, "POST", `${docs}${tenantA.propertyA}/payables/supplier-bills`, clerk, { ...bill, incomingDocumentId: foreignDoc.id });
    assert.equal(linked.status, 400, JSON.stringify(linked.body));
    assert.equal(codeOf(linked), "VALIDATION_ERROR");
    assert.equal(linked.body.details.field, "incomingDocumentId");
    const digitized = await call(app, "POST", `${docs}${tenantA.propertyA}/payables/supplier-bills`, clerk, { ...bill, source: "digitized" });
    assert.equal(digitized.status, 400, JSON.stringify(digitized.body));
    assert.equal(digitized.body.details.field, "source");
    const manual = await call(app, "POST", `${docs}${tenantA.propertyA}/payables/supplier-bills`, clerk, { ...bill, source: "manual" });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
    assert.equal(manual.body.incomingDocumentId, null);
    assert.equal(manual.body.source, "manual");
    const patched = await call(app, "PATCH", `${docs}${tenantA.propertyA}/payables/supplier-bills/${manual.body.id}`, clerk, { ...bill, incomingDocumentId: foreignDoc.id });
    assert.equal(patched.status, 400, JSON.stringify(patched.body));
    // Flujo interno (origin documents): la tenencia del documento enlazado se recomprueba → 404 opaco, nada escrito.
    const { createSupplierBillInTx } = await import("../../apps/api/src/modules/payables/supplier-bills.service.js");
    const clerkContext = { organizationId: tenantA.organizationId, propertyId: tenantA.propertyA, userId: clerkUser.id, fullName: "Clerk", deviceId: "t9wf", permissions: ["payables.create"] as never, isPlatformAdmin: false };
    const before = await prisma.supplierBill.count({ where: { organizationId: tenantA.organizationId } });
    await assert.rejects(
      prisma.$transaction((tx) => createSupplierBillInTx(tx, { context: clerkContext as never, propertyId: tenantA.propertyA, organizationId: tenantA.organizationId, body: { ...bill, invoiceNumber: "T9-WF-X-0002", incomingDocumentId: foreignDoc.id, source: "digitized" }, origin: "documents" })),
      (error: { statusCode?: number; details?: { code?: string } }) => error.statusCode === 404 && error.details?.code === "DOCUMENT_NOT_FOUND"
    );
    assert.equal(await prisma.supplierBill.count({ where: { organizationId: tenantA.organizationId } }), before);
    const untouched = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: foreignDoc.id } });
    assert.equal(untouched.status, "captured");
    assert.equal(untouched.supplierBillId, null);
  });

  it("RV-05 / RV-06 / RV-10: carta archivada desde el centro → 6 años; con autoSendToOffice la captura pasa sola a sent_to_office (DOCUMENT_SENT de sistema) y el aviso a la oficina se agrupa por hora", async () => {
    const letter = await capture(app, receptionist, tenantA.propertyA, "carta.pdf", fixtures.demoInvoicePdf({ number: "T9-WF-CARTA" }), { kindHint: "letter" });
    const archivedLetter = await call(app, "POST", `${docs}${tenantA.propertyA}/documents/${letter.id}/archive`, clerk, {});
    assert.equal(archivedLetter.status, 200, JSON.stringify(archivedLetter.body));
    assert.equal(archivedLetter.body.document.retentionUntil, `${new Date(letter.capturedAt).getUTCFullYear() + 6}-12-31`, "correspondencia de proveedores: 6 años (art. 30 CCom), no 4");

    const settings = await call(app, "PATCH", `${orgDocs(tenantA.organizationId)}/settings`, director, { autoSendToOffice: true });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    assert.equal(settings.body.autoSendToOffice, true);
    assert.equal(settings.body.letterRetentionYears, 6);
    try {
      const noticesBefore = await prisma.notification.count({ where: { organizationId: tenantA.organizationId, userId: clerkUser.id, title: { startsWith: OFFICE_SENT_TITLE } } });
      const auto = await capture(app, receptionist, tenantA.propertyA, "factura-auto.pdf", fixtures.demoInvoicePdf({ number: "T9-WF-AUTO" }), { kindHint: "invoice" });
      const detail = await call(app, "GET", `${docs}${tenantA.propertyA}/documents/${auto.id}`, clerk);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.status, "sent_to_office", "§6.1: automático si autoSendToOffice");
      assert.ok(detail.body.sentAt);
      await flushAuditQueues();
      const sentAudit = await prisma.auditEvent.findFirst({ where: { organizationId: tenantA.organizationId, action: "DOCUMENT_SENT", entityId: auto.id } });
      assert.ok(sentAudit, "DOCUMENT_SENT auditado");
      assert.equal(sentAudit.actorType, "system");
      assert.equal((sentAudit.afterJson as Json).automatic, true);
      // Agrupado por hora: el revisor ya recibió un aviso en la última hora (primer envío de la suite) → no se repite.
      const noticesAfter = await prisma.notification.count({ where: { organizationId: tenantA.organizationId, userId: clerkUser.id, title: { startsWith: OFFICE_SENT_TITLE } } });
      assert.equal(noticesAfter, noticesBefore, "sin aviso nuevo dentro de la hora");
      assert.equal(noticesBefore, 1);
    } finally {
      const restore = await call(app, "PATCH", `${orgDocs(tenantA.organizationId)}/settings`, director, { autoSendToOffice: false });
      assert.equal(restore.status, 200, JSON.stringify(restore.body));
    }
  });
});
