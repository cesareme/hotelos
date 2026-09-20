// Unit tests · Tanda T9 · lote T9-08 — acciones de la oficina: matriz acción →
// clave extra (§6.2 adaptado), override obligatorio con un check en fail (409
// DOCUMENT_CHECKS_FAILED), cuerpo de otra acción (400
// DOCUMENT_ACTION_INVALID_FOR_KIND), esquemas de reject / task y cuerpos
// efectivos de factura y gasto. Sin Postgres, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/actions-permissions.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCUMENT_PROPOSED_ACTIONS, PermissionDeniedError, type DocumentChecks, type DocumentProposedAction, type PermissionKey } from "@hotelos/shared";
import { HttpError } from "../../../lib/http-error.js";
import {
  ACTION_EXTRA_PERMISSION,
  assertApprovePermissions,
  assertBodyMatchesAction,
  assertChecksPass,
  buildExpenseBody,
  buildSupplierBillBody,
  CENTRE_ARCHIVABLE_KINDS,
  DocumentActionRequestSchema,
  DocumentApproveRequestSchema,
  DocumentRejectRequestSchema,
  extraPermissionFor,
  failedChecks,
  retentionKindOf,
  taskDeadlineKindOf
} from "../actions.service.js";

const context = (permissions: PermissionKey[], isPlatformAdmin = false) => ({ permissions, isPlatformAdmin });

function codeOf(error: unknown): string | undefined {
  return error instanceof HttpError ? (error.details as { code?: string } | undefined)?.code : undefined;
}

const check = (status: "ok" | "warn" | "fail") => ({ status, message: status });
const CHECKS_OK: DocumentChecks = { nif: check("ok"), supplier: check("warn"), totals: check("ok"), vat: check("ok"), duplicate: check("ok"), retention: check("ok"), match: check("ok") };
const CHECKS_FAIL: DocumentChecks = { ...CHECKS_OK, duplicate: check("fail"), totals: check("fail") };

describe("matriz acción → clave extra (§6.2 adaptado)", () => {
  it("create_supplier_bill → payables.create · create_expense → accounting.journal.post · create_goods_receipt → purchase_orders.receive · tarea / archivo → solo documents.review", () => {
    const expected: Record<DocumentProposedAction, PermissionKey | null> = {
      create_supplier_bill: "payables.create",
      create_expense: "accounting.journal.post",
      create_goods_receipt: "purchase_orders.receive",
      create_task: null,
      archive: null
    };
    assert.deepEqual(ACTION_EXTRA_PERMISSION, expected);
    for (const action of DOCUMENT_PROPOSED_ACTIONS) assert.equal(extraPermissionFor(action), expected[action]);
  });

  it("documents.review + la clave extra pasan; la que falta sale en `missing` (403 PermissionDeniedError)", () => {
    for (const action of DOCUMENT_PROPOSED_ACTIONS) {
      const extra = extraPermissionFor(action);
      const full: PermissionKey[] = ["documents.review", ...(extra ? [extra] : [])];
      assert.doesNotThrow(() => assertApprovePermissions(context(full), action), `${action} con todas las claves`);
      // Solo documents.review: falla en las acciones con clave extra.
      if (extra) {
        assert.throws(
          () => assertApprovePermissions(context(["documents.review"]), action),
          (error: unknown) => error instanceof PermissionDeniedError && error.statusCode === 403 && error.missing.length === 1 && error.missing[0] === extra
        );
        // Solo la clave extra sin documents.review: falta review.
        assert.throws(() => assertApprovePermissions(context([extra]), action), (error: unknown) => error instanceof PermissionDeniedError && error.missing.includes("documents.review"));
      }
      // Sin nada: faltan ambas (o solo review).
      assert.throws(() => assertApprovePermissions(context([]), action), (error: unknown) => error instanceof PermissionDeniedError && error.missing[0] === "documents.review");
      // Administrador de plataforma: siempre.
      assert.doesNotThrow(() => assertApprovePermissions(context([], true), action));
    }
  });
});

describe("comprobaciones y cuerpo de la aprobación", () => {
  it("ningún fail → pasa; con fail y sin override → 409 DOCUMENT_CHECKS_FAILED { failed }; con override.reason → pasa y devuelve las claves", () => {
    assert.deepEqual(failedChecks(null), []);
    assert.deepEqual(failedChecks(CHECKS_OK), []);
    assert.deepEqual(failedChecks(CHECKS_FAIL), ["totals", "duplicate"]);
    assert.deepEqual(assertChecksPass(CHECKS_OK, undefined), []);
    assert.deepEqual(assertChecksPass(null, undefined), []);
    assert.throws(
      () => assertChecksPass(CHECKS_FAIL, undefined),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409 && codeOf(error) === "DOCUMENT_CHECKS_FAILED" && JSON.stringify((error.details as { failed: string[] }).failed) === JSON.stringify(["totals", "duplicate"])
    );
    assert.deepEqual(assertChecksPass(CHECKS_FAIL, { reason: "Factura reenviada por el proveedor" }), ["totals", "duplicate"]);
  });

  it("cuerpo de otra acción → 400 DOCUMENT_ACTION_INVALID_FOR_KIND; el esquema exige override.reason ≥ 3", () => {
    const parsed = DocumentApproveRequestSchema.parse({ action: "create_task", supplierBill: { invoiceNumber: "X" } });
    assert.throws(() => assertBodyMatchesAction(parsed), (error: unknown) => codeOf(error) === "DOCUMENT_ACTION_INVALID_FOR_KIND" && (error as HttpError).statusCode === 400);
    assert.doesNotThrow(() => assertBodyMatchesAction(DocumentApproveRequestSchema.parse({ action: "create_supplier_bill", supplierBill: { invoiceNumber: "X" } })));
    assert.doesNotThrow(() => assertBodyMatchesAction(DocumentApproveRequestSchema.parse({ action: "archive" })));
    assert.equal(DocumentApproveRequestSchema.safeParse({ action: "archive", override: { reason: "ok" } }).success, false);
    assert.equal(DocumentApproveRequestSchema.safeParse({ action: "archive", override: { reason: "porque sí" } }).success, true);
    assert.equal(DocumentApproveRequestSchema.safeParse({ action: "archive", foo: 1 }).success, false);
    assert.equal(DocumentApproveRequestSchema.safeParse({ action: "nope" }).success, false);
  });

  it("reject: returnToCentre admite illegible | missing_pages | other; cerrar admite duplicate | not_ours | other", () => {
    assert.equal(DocumentRejectRequestSchema.safeParse({ reason: "illegible", returnToCentre: true }).success, true);
    assert.equal(DocumentRejectRequestSchema.safeParse({ reason: "duplicate", returnToCentre: true }).success, false);
    assert.equal(DocumentRejectRequestSchema.safeParse({ reason: "duplicate", duplicateOfId: "doc_1" }).success, true);
    assert.equal(DocumentRejectRequestSchema.safeParse({ reason: "illegible" }).success, false);
    assert.equal(DocumentRejectRequestSchema.safeParse({ reason: "other" }).success, true);
    assert.equal(DocumentRejectRequestSchema.safeParse({ reason: "other", returnToCentre: true }).success, true);
  });

  it("tarea: kind del catálogo, title obligatorio, dueAt ISO-8601 o null", () => {
    assert.equal(DocumentActionRequestSchema.safeParse({ kind: "respond", title: "Contestar" }).success, true);
    assert.equal(DocumentActionRequestSchema.safeParse({ kind: "respond", title: "Contestar", dueAt: "2026-10-01T00:00:00.000Z" }).success, true);
    assert.equal(DocumentActionRequestSchema.safeParse({ kind: "respond", title: "Contestar", dueAt: null }).success, true);
    assert.equal(DocumentActionRequestSchema.safeParse({ kind: "respond", title: "Contestar", dueAt: "mañana" }).success, false);
    assert.equal(DocumentActionRequestSchema.safeParse({ kind: "dance", title: "x" }).success, false);
    assert.equal(DocumentActionRequestSchema.safeParse({ kind: "pay", title: "" }).success, false);
  });
});

describe("cuerpos efectivos (§7.1)", () => {
  const document = { id: "doc_1", source: "upload" as const, capturedAt: new Date("2026-09-19T08:15:00.000Z"), documentDate: new Date("2026-09-10T00:00:00.000Z") };
  const proposal = { action: "create_supplier_bill" as const, supplierBill: { invoiceNumber: "F-1", issueDate: "2026-09-10", supplierTaxId: "B12345674", lines: [] }, expense: { supplierName: "Bar", concept: "Café", accountCode: "629", base: 10, taxRate: 21 } };

  it("factura: el cuerpo revisado prevalece sobre la propuesta; el servidor fija incomingDocumentId, source, documentObjectKey y receptionDate (captura)", () => {
    const fromProposal = buildSupplierBillBody({ document, proposal, body: undefined, storageKey: "org/o/prop/p/doc/doc_1/aa.pdf" });
    assert.equal(fromProposal.invoiceNumber, "F-1");
    assert.equal(fromProposal.incomingDocumentId, "doc_1");
    assert.equal(fromProposal.source, "digitized");
    assert.equal(fromProposal.documentObjectKey, "org/o/prop/p/doc/doc_1/aa.pdf");
    assert.equal(fromProposal.receptionDate, "2026-09-19");
    const reviewed = buildSupplierBillBody({ document: { ...document, source: "e_invoice" }, proposal, body: { invoiceNumber: "F-2", receptionDate: "2026-09-18", attachment: { base64: "x" }, incomingDocumentId: "otro" }, storageKey: null });
    assert.equal(reviewed.invoiceNumber, "F-2");
    assert.equal(reviewed.source, "e_invoice");
    assert.equal(reviewed.receptionDate, "2026-09-18");
    assert.equal(reviewed.incomingDocumentId, "doc_1", "el id del documento nunca lo fija el cliente");
    assert.equal("attachment" in reviewed, false);
  });

  it("gasto: fecha del documento por defecto, recibo = clave del original, vatDeductible:false sin NIF, paidWith null se retira", () => {
    const body = buildExpenseBody({ document, proposal, body: { ...proposal.expense, paidWith: null }, storageKey: "org/o/prop/p/doc/doc_1/aa.pdf" });
    assert.equal(body.date, "2026-09-10");
    assert.equal(body.receiptObjectKey, "org/o/prop/p/doc/doc_1/aa.pdf");
    assert.equal(body.vatDeductible, false);
    assert.equal("paidWith" in body, false);
    const withNif = buildExpenseBody({ document, proposal, body: { ...proposal.expense, supplierNif: "B12345674", paidWith: "cash", vatDeductible: true }, storageKey: null });
    assert.equal(withNif.vatDeductible, true);
    assert.equal(withNif.paidWith, "cash");
  });

  it("tipo → retención y plazo: e_invoice_status / unknown → other; administrative_notice y e_invoice_status llevan plazo; el centro solo archiva letter | contract | other", () => {
    assert.equal(retentionKindOf("invoice"), "invoice");
    assert.equal(retentionKindOf("unknown"), "other");
    assert.equal(retentionKindOf("e_invoice_status"), "other");
    assert.equal(taskDeadlineKindOf("administrative_notice"), "administrative_notice");
    assert.equal(taskDeadlineKindOf("e_invoice_status"), "e_invoice");
    assert.equal(taskDeadlineKindOf("letter"), null);
    assert.deepEqual([...CENTRE_ARCHIVABLE_KINDS].sort(), ["contract", "letter", "other"]);
  });
});
