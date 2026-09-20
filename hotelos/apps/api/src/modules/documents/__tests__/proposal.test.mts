// Unit tests · Tanda T9 · lote T9-06b — propuesta de acción (diseño §5.1 «Proponer», §7, §3.5).
// Sin base de datos, sin red; NIF calculados sobre dígitos inventados. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/proposal.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cifFor } from "./fixtures.js";
import { buildProposal, deadlineKindOf, payableAccountFromSage, proposedActionFor, type BuildProposalInput } from "../proposal.js";
import { validateDocument, type ExtractedDocumentFields } from "../validation.js";

const NIF = cifFor("B", "7654321");
const CAPTURED_AT = "2026-09-10T09:30:00.000Z";

const invoiceFields = (over: Partial<ExtractedDocumentFields> = {}): ExtractedDocumentFields => ({
  supplierName: "Lavandería Cantábrica Demo SL",
  supplierTaxId: NIF,
  documentNumber: " F-2026/0042 ",
  issueDate: "2026-09-08",
  dueDate: "2026-10-08",
  total: "205.70",
  lines: [
    { description: "Lavado y planchado de sábanas (kg)", quantity: 120, unitPrice: "1.25", taxRate: 21, deliveryNoteRef: "ALB-2026/0042" },
    { description: "Toallas de baño (unidad)", quantity: 40, unitPrice: "0.50", taxRate: 21 }
  ],
  ...over
});

function propose(kind: BuildProposalInput["kind"], fields: ExtractedDocumentFields, over: Partial<BuildProposalInput> = {}) {
  const checks = validateDocument({ kind, fields, supplier: over.supplier ?? null, sageSupplier: over.sageSupplier ?? null });
  return buildProposal({ kind, fields, propertyId: "prop_demo", propertyKind: "hotel", checks, settings: null, capturedAt: CAPTURED_AT, incomingDocumentId: "doc_1", ...over });
}

describe("factura → create_supplier_bill", () => {
  it("cuerpo completo: proveedor conocido, líneas con su cuenta por defecto, número exacto, recepción = captura, source digitized", () => {
    const supplier = { id: "sup_1", name: "Lavandería Cantábrica Demo SL", taxId: NIF, defaultExpenseAccountCode: "6290001", retentionRate: null };
    const proposal = propose("invoice", invoiceFields(), { supplier });
    assert.equal(proposal.action, "create_supplier_bill");
    assert.equal(proposal.targetPropertyId, "prop_demo");
    assert.equal(proposal.needsAccount, false);
    assert.equal(proposal.needsManual, false);
    assert.equal(proposal.supplierProposal, undefined);
    const bill = proposal.supplierBill!;
    assert.equal(bill.supplierId, "sup_1");
    assert.equal(bill.supplierName, undefined);
    assert.equal(bill.invoiceNumber, "F-2026/0042", "número exacto como aparece (solo recortado)");
    assert.equal(bill.issueDate, "2026-09-08");
    assert.equal(bill.dueDate, "2026-10-08");
    assert.equal(bill.receptionDate, "2026-09-10");
    assert.equal(bill.source, "digitized");
    assert.equal(bill.incomingDocumentId, "doc_1");
    assert.equal(bill.expectedTotal, "205.70");
    assert.equal(bill.retentionRate, null);
    assert.equal(bill.payableAccountCode, undefined);
    assert.equal(bill.lines.length, 2);
    assert.deepEqual(bill.lines[0], { description: "Lavado y planchado de sábanas (kg)", expenseAccountCode: "6290001", base: "150.00", taxRate: "21", quantity: "120.000", unitPrice: "1.2500", deliveryNoteRef: "ALB-2026/0042" });
    assert.deepEqual(bill.lines[1], { description: "Toallas de baño (unidad)", expenseAccountCode: "6290001", base: "20.00", taxRate: "21", quantity: "40.000", unitPrice: "0.5000" });
  });

  it("proveedor solo en Sage: supplierName + supplierTaxId de Sage, supplierProposal.fromSage, cuenta 400/410 de Sage, 629 con needsAccount", () => {
    const sage = { name: "LAVANDERIA CANTABRICA DEMO SL", taxId: NIF, sourceAccount: "4100007", accounts: ["4100007"] };
    const proposal = propose("invoice", invoiceFields(), { sageSupplier: sage });
    const bill = proposal.supplierBill!;
    assert.equal(bill.supplierId, null);
    assert.equal(bill.supplierName, "LAVANDERIA CANTABRICA DEMO SL");
    assert.equal(bill.supplierTaxId, NIF);
    assert.equal(bill.payableAccountCode, "410");
    assert.ok(bill.lines.every((l) => l.expenseAccountCode === "629"));
    assert.equal(proposal.needsAccount, true);
    assert.deepEqual(proposal.supplierProposal, { fromSage: true, name: "LAVANDERIA CANTABRICA DEMO SL", taxId: NIF });
    assert.equal(payableAccountFromSage({ name: "x", taxId: null, sourceAccount: "4000012" }), "400");
    assert.equal(payableAccountFromSage({ name: "x", taxId: null, sourceAccount: "4110001" }), undefined);
    assert.equal(payableAccountFromSage(null), undefined);
  });

  it("proveedor desconocido: nombre extraído y supplierProposal sin Sage; retención de la ficha; expectedTotal solo si el total impreso cuadra", () => {
    const unknown = propose("invoice", invoiceFields());
    assert.equal(unknown.supplierBill?.supplierName, "Lavandería Cantábrica Demo SL");
    assert.deepEqual(unknown.supplierProposal, { fromSage: false, name: "Lavandería Cantábrica Demo SL", taxId: NIF });
    const supplier = { id: "sup_2", name: "Asesoría Demo", taxId: NIF, retentionRate: "15.00", defaultExpenseAccountCode: "623" };
    const withRetention = propose("invoice", invoiceFields({ lines: [{ description: "Honorarios", base: "1000.00", taxRate: 21 }], retentionRate: 15, total: "1060.00" }), { supplier });
    assert.equal(withRetention.supplierBill?.retentionRate, "15");
    assert.equal(withRetention.supplierBill?.expectedTotal, "1060.00");
    const rounding = propose("invoice", invoiceFields({ total: "205.71" }));
    assert.equal(rounding.supplierBill?.expectedTotal, undefined, "con 0,01 de redondeo no se fuerza el total impreso (400 TOTAL_MISMATCH)");
    const off = propose("invoice", invoiceFields({ total: "210.00" }));
    assert.equal(off.supplierBill?.expectedTotal, undefined);
  });

  it("e-factura → source e_invoice; sin líneas → línea única con nota; IVA no admitido → needsManual", () => {
    const einvoice = propose("invoice", invoiceFields(), { source: "e_invoice" });
    assert.equal(einvoice.supplierBill?.source, "e_invoice");
    const noLines = propose("invoice", invoiceFields({ lines: [], baseTotal: "170.00", taxTotal: "35.70" }));
    assert.equal(noLines.supplierBill?.lines.length, 1);
    assert.deepEqual(noLines.supplierBill?.lines[0], { description: "Factura F-2026/0042", expenseAccountCode: "629", base: "170.00", taxRate: "21" });
    assert.ok(noLines.notes.some((n) => /Sin líneas extraídas/.test(n)));
    const manual = propose("invoice", invoiceFields({ reverseCharge: true }));
    assert.equal(manual.needsManual, true);
    assert.equal(manual.action, "create_supplier_bill");
    assert.ok(manual.notes.some((n) => /isp/.test(n)));
  });

  it("documento capturado en la oficina: la acción sigue en ese centro (nota para el revisor)", () => {
    const proposal = propose("invoice", invoiceFields(), { propertyId: "prop_office", propertyKind: "office" });
    assert.equal(proposal.targetPropertyId, "prop_office");
    assert.ok(proposal.notes.some((n) => /oficina central/.test(n)));
  });
});

describe("ticket / factura sin NIF → create_expense", () => {
  it("ticket sin NIF: vatDeductible false, paidWith null, base y tipo del ticket", () => {
    const proposal = propose("receipt", { supplierName: "Cafetería Demo", documentNumber: "T-771", issueDate: "2026-09-09", total: "12.10", lines: [{ description: "Desayunos reunión", base: "11.00", taxRate: 10 }] });
    assert.equal(proposal.action, "create_expense");
    const expense = proposal.expense!;
    assert.equal(expense.supplierNif, null);
    assert.equal(expense.vatDeductible, false);
    assert.equal(expense.paidWith, null);
    assert.equal(expense.supplierName, "Cafetería Demo");
    assert.equal(expense.concept, "Desayunos reunión");
    assert.equal(expense.accountCode, "629");
    assert.equal(expense.base, "11.00");
    assert.equal(expense.taxRate, "10");
    assert.equal(expense.total, "12.10");
    assert.equal(expense.date, "2026-09-09");
    assert.equal(proposal.needsAccount, true);
    assert.deepEqual(proposal.supplierProposal, { fromSage: false, name: "Cafetería Demo", taxId: null });
  });

  it("ticket con NIF válido: vatDeductible true; factura sin NIF → gasto con nota; varios tipos → el de mayor base", () => {
    const withNif = propose("receipt", { supplierTaxId: NIF, supplierName: "Cafetería Demo", total: "12.10", lines: [{ description: "Desayunos", base: "11.00", taxRate: 10 }] });
    assert.equal(withNif.expense?.vatDeductible, true);
    assert.equal(withNif.expense?.supplierNif, NIF);
    const invoiceNoNif = propose("invoice", invoiceFields({ supplierTaxId: null }));
    assert.equal(invoiceNoNif.action, "create_expense");
    assert.equal(invoiceNoNif.expense?.vatDeductible, false);
    assert.ok(invoiceNoNif.notes.some((n) => /sin NIF válido/.test(n)));
    const mixed = propose("receipt", { supplierName: "Súper Demo", total: "23.10", lines: [{ description: "Agua", base: "10.00", taxRate: 4 }, { description: "Refrescos", base: "10.00", taxRate: 21 }, { description: "Fruta", base: "1.00", taxRate: 4 }] });
    assert.equal(mixed.expense?.taxRate, "4");
    assert.equal(mixed.expense?.base, "21.00");
    assert.equal(mixed.expense?.total, undefined);
    assert.ok(mixed.notes.some((n) => /varios tipos de IVA/.test(n)));
  });
});

describe("albarán → create_goods_receipt", () => {
  it("cuerpo con número, fecha de entrega y líneas (cantidad 3 decimales, precio 4)", () => {
    const proposal = propose("delivery_note", {
      supplierTaxId: NIF,
      supplierName: "Lavandería Cantábrica Demo SL",
      deliveryNoteNumber: "ALB-2026/0042",
      deliveryDate: "2026-09-08",
      lines: [
        { description: "Lavado y planchado de sábanas (kg)", quantity: "120", unitPrice: "1.25", taxRate: 21 },
        { description: "Toallas de baño (unidad)", quantity: 40, unitPrice: "0.5" }
      ]
    });
    assert.equal(proposal.action, "create_goods_receipt");
    const receipt = proposal.goodsReceipt!;
    assert.equal(receipt.supplierId, null);
    assert.equal(receipt.supplierTaxId, NIF);
    assert.equal(receipt.supplierName, "Lavandería Cantábrica Demo SL");
    assert.equal(receipt.deliveryNoteNumber, "ALB-2026/0042");
    assert.equal(receipt.deliveryDate, "2026-09-08");
    assert.equal(receipt.receivedBy, null);
    assert.deepEqual(receipt.lines, [
      { description: "Lavado y planchado de sábanas (kg)", quantityReceived: "120.000", unitPrice: "1.2500", base: "150.00", taxRate: "21" },
      { description: "Toallas de baño (unidad)", quantityReceived: "40.000", unitPrice: "0.5000", base: "20.00" }
    ]);
  });

  it("con proveedor conocido usa supplierId; sin número ni fecha cae a la captura con nota", () => {
    const proposal = propose("delivery_note", { lines: [{ description: "Cajas", quantity: 6 }] }, { supplier: { id: "sup_1", taxId: NIF } });
    assert.equal(proposal.goodsReceipt?.supplierId, "sup_1");
    assert.equal(proposal.goodsReceipt?.deliveryNoteNumber, "");
    assert.equal(proposal.goodsReceipt?.deliveryDate, "2026-09-10");
    assert.ok(proposal.notes.some((n) => /Sin número de albarán/.test(n)));
    assert.equal(propose("delivery_note", {}).goodsReceipt?.lines.length, 1);
  });
});

describe("correspondencia → create_task / archive", () => {
  it("notificación administrativa → create_task respond con dueAt +10 días naturales desde la captura", () => {
    const proposal = propose("administrative_notice", { senderName: "Ayuntamiento Demo", subject: "Licencia de terraza" });
    assert.equal(proposal.action, "create_task");
    assert.equal(proposal.task?.kind, "respond");
    assert.equal(proposal.task?.dueAt, "2026-09-20T00:00:00.000Z");
    assert.equal(proposal.task?.title, "Notificación administrativa · Licencia de terraza");
    assert.equal(proposal.task?.assignedTo, null);
    assert.match(proposal.task?.description ?? "", /Remitente: Ayuntamiento Demo/);
    assert.ok(proposal.notes.some((n) => /Plazo por defecto/.test(n)));
  });

  it("el plazo cuenta desde la fecha del escrito si se extrajo; sanción → pay +20; requerimiento AEAT → respond +10 hábiles; dueDate impreso manda", () => {
    assert.equal(propose("administrative_notice", { issueDate: "2026-09-01" }).task?.dueAt, "2026-09-11T00:00:00.000Z");
    const fine = propose("administrative_notice", { noticeKind: "traffic_fine" });
    assert.equal(fine.task?.kind, "pay");
    assert.equal(fine.task?.dueAt, "2026-09-30T00:00:00.000Z");
    assert.equal(fine.task?.title, "Sanción de tráfico");
    const aeat = propose("administrative_notice", { noticeKind: "aeat_requirement" });
    assert.equal(aeat.task?.kind, "respond");
    assert.equal(aeat.task?.dueAt, "2026-09-24T00:00:00.000Z", "10 días hábiles desde el jueves 10/09 (sin festivos nacionales)");
    assert.equal(propose("administrative_notice", { dueDate: "2026-10-01" }).task?.dueAt, "2026-10-01T00:00:00.000Z");
    assert.equal(deadlineKindOf("administrative_notice", {}), "administrative_notice");
    assert.equal(deadlineKindOf("e_invoice_status", {}), "e_invoice");
    assert.equal(deadlineKindOf("letter", {}), null);
  });

  it("estado de e-factura → verify +4 días hábiles; carta con plazo → respond; carta sin plazo, contrato, otro y desconocido → archive", () => {
    const status = propose("e_invoice_status", {});
    assert.equal(status.task?.kind, "verify");
    assert.equal(status.task?.dueAt, "2026-09-16T00:00:00.000Z");
    const letterWithDeadline = propose("letter", { senderName: "Proveedor Demo", requiresResponse: true });
    assert.equal(letterWithDeadline.action, "create_task");
    assert.equal(letterWithDeadline.task?.kind, "respond");
    assert.equal(letterWithDeadline.task?.dueAt, null);
    assert.equal(propose("letter", { dueDate: "2026-09-30" }).task?.dueAt, "2026-09-30T00:00:00.000Z");
    for (const kind of ["letter", "contract", "other", "unknown"] as const) {
      const archived = propose(kind, { senderName: "Proveedor Demo" });
      assert.equal(archived.action, "archive", kind);
      assert.equal(archived.supplierBill, undefined);
      assert.equal(archived.task, undefined);
    }
    const checks = validateDocument({ kind: "contract", fields: {} });
    assert.equal(proposedActionFor("contract", {}, checks), "archive");
  });
});
