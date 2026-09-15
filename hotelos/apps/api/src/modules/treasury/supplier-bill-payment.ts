// Supplier bill payment hook of the treasury lot.
//
// Reconciling a bank outflow against a received invoice pays it: D 400|410 /
// H 572 (sourceType supplier_bill_payment), `paymentDate`, `status = paid`,
// `paidJournalEntryId`. The supplier/expense lot owns the SupplierBill life
// cycle (posting the accrual entry); this file only implements the payment
// leg the bank needs and exposes `setSupplierBillPayer` so the integrator can
// route it to that lot's `paySupplierBill` once it exists (handoff).

import { prisma } from "@hotelos/database";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { ledger, type Db } from "./ledger-bridge.js";
import { dayUtc, dec, money, round2, sameAmount, type Dec } from "./money.js";

const SUPPLIERS_CODE = "400";
const CREDITORS_CODE = "410";
const BANK_CODE = "572";

export type PaySupplierBillInput = {
  billId: string;
  paidAt: Date | string;
  /** Amount actually paid (must equal the bill total: partial payments are not modelled). */
  amount: Dec;
  bankLedgerCode?: string | null;
  reference?: string | null;
  createdBy?: string | null;
  db?: Db;
};

export type PaySupplierBillResult = { billId: string; journalEntryId: string; amount: string; created: boolean };

export type SupplierBillPayer = {
  pay(input: PaySupplierBillInput): Promise<PaySupplierBillResult>;
  /** Undo a payment recorded from the bank (reverse the entry, reopen the bill). */
  unpay(input: { billId: string; entryDate: Date | string; createdBy?: string | null; db?: Db }): Promise<{ billId: string; reversalJournalEntryId: string | null }>;
};

/** Suppliers (400) for goods/services of the activity; creditors (410) for the rest. The bill's suggested account decides. */
function payableCodeFor(bill: { suggestedAccountCode: string | null }): string {
  const code = bill.suggestedAccountCode ?? "";
  if (code.startsWith("60") || code.startsWith("30")) return SUPPLIERS_CODE;
  return code.startsWith("62") || code.startsWith("21") || code.startsWith("20") ? CREDITORS_CODE : SUPPLIERS_CODE;
}

export const defaultSupplierBillPayer: SupplierBillPayer = {
  async pay(input) {
    const db = input.db ?? prisma;
    const bill = await db.supplierBill.findUnique({ where: { id: input.billId } });
    if (!bill) throw new NotFoundError("La factura de proveedor no existe.");
    if (bill.paidJournalEntryId && bill.paymentDate) {
      return { billId: bill.id, journalEntryId: bill.paidJournalEntryId, amount: money(bill.total), created: false };
    }
    if (bill.status === "cancelled") throw new ConflictError("La factura de proveedor está anulada.", { code: "SUPPLIER_BILL_CANCELLED" });
    if (bill.status !== "posted" || !bill.journalEntryId) {
      throw new ConflictError("Contabiliza la factura recibida antes de conciliar su pago.", { code: "SUPPLIER_BILL_NOT_POSTED", status: bill.status });
    }
    const total = round2(dec(bill.total));
    if (!sameAmount(total, input.amount)) {
      throw new ConflictError(`El importe del movimiento (${money(input.amount)}) no coincide con el total de la factura (${money(total)}).`, {
        code: "SUPPLIER_BILL_AMOUNT_MISMATCH",
        expected: money(total),
        actual: money(input.amount)
      });
    }
    const organizationId = bill.organizationId ?? (await db.property.findUnique({ where: { id: bill.propertyId }, select: { organizationId: true } }))?.organizationId;
    if (!organizationId) throw new NotFoundError("La propiedad de la factura no existe.");
    const paidAt = dayUtc(input.paidAt);
    const description = `Pago factura ${bill.invoiceNumber ?? bill.id} · ${bill.supplierName ?? "proveedor"}`;
    // The payment debits the SAME payable account the accrual credited (400 / 410 / a subaccount);
    // the expense-code heuristic is only the fallback for bills whose entry has no 40x/41x line.
    const accrualLines = await db.journalLine.findMany({ where: { journalEntryId: bill.journalEntryId }, select: { accountCode: true, credit: true } });
    const payableLine = accrualLines.find((l) => l.accountCode && /^4(0|1)/.test(l.accountCode) && dec(l.credit).gt(0));
    const payableCode = payableLine?.accountCode ?? payableCodeFor(bill);
    const entry = await ledger().postJournalEntry({
      organizationId,
      propertyId: bill.propertyId,
      entryDate: paidAt,
      sourceType: "supplier_bill_payment",
      sourceId: bill.id,
      description,
      reference: input.reference ?? bill.invoiceNumber ?? null,
      createdBy: input.createdBy ?? null,
      lines: [
        { accountCode: payableCode, debit: total, description },
        { accountCode: input.bankLedgerCode?.trim() || BANK_CODE, credit: total, description }
      ],
      db
    });
    await db.supplierBill.update({ where: { id: bill.id }, data: { paymentDate: paidAt, status: "paid", paidJournalEntryId: entry.id } });
    return { billId: bill.id, journalEntryId: entry.id, amount: money(total), created: entry.created };
  },

  async unpay(input) {
    const db = input.db ?? prisma;
    const bill = await db.supplierBill.findUnique({ where: { id: input.billId } });
    if (!bill) throw new NotFoundError("La factura de proveedor no existe.");
    if (!bill.paidJournalEntryId) return { billId: bill.id, reversalJournalEntryId: null };
    const organizationId = bill.organizationId ?? (await db.property.findUnique({ where: { id: bill.propertyId }, select: { organizationId: true } }))?.organizationId;
    if (!organizationId) throw new NotFoundError("La propiedad de la factura no existe.");
    const reversal = await ledger().reverseJournalEntry({
      organizationId,
      journalEntryId: bill.paidJournalEntryId,
      entryDate: input.entryDate,
      description: `Reverso pago factura ${bill.invoiceNumber ?? bill.id} (desconciliación bancaria)`,
      createdBy: input.createdBy ?? null,
      db
    });
    await db.supplierBill.update({ where: { id: bill.id }, data: { paymentDate: null, status: "posted", paidJournalEntryId: null } });
    return { billId: bill.id, reversalJournalEntryId: reversal.id };
  }
};

let payer: SupplierBillPayer = defaultSupplierBillPayer;

/** Integration hook: the suppliers/expenses lot plugs its own payment service here. */
export function setSupplierBillPayer(next: SupplierBillPayer | null): void {
  payer = next ?? defaultSupplierBillPayer;
}

export function supplierBillPayer(): SupplierBillPayer {
  return payer;
}
