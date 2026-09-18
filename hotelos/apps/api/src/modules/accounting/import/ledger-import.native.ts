// Importación contable desde Sage 200 (Tanda 7c · L2) — índice de documentos NATIVOS
// de Anfitorio para el modo sombra (design §5.1 y §10.4.2 #8).
//
// Durante el modo sombra Sage 200 registra también las facturas que Anfitorio emite
// (VeriFactu) y sus cobros; importar el diario tal cual las duplicaría. El lote las
// EXCLUYE (`skipped_native`) comparando serie + número normalizados
// (`normalizeNativeDocumentKey`, L1) con las facturas de la organización, y los
// cobros por importe + fecha (± 3 días, heurística siempre avisada).
//
// Hechos verificados contra el esquema (schema.prisma):
//   · `Invoice` NO lleva organizationId: la unión es por `propertyId ∈ properties(organizationId)`;
//     `invoiceNumber` (:3531) es el número impreso completo (`FAC-2026-000015`) y
//     `seriesCode` (:3573) la serie con la que se numeró;
//   · los `sourceId` de los asientos nativos son DESNUDOS (`invoiceId`, `paymentId`, sin
//     prefijo `invoice/`; runbook finanzas-contabilidad §1.1): el asiento de una factura es
//     `findJournalEntryBySource(org, 'invoice' | 'invoice_rectification' | 'invoice_cancellation', invoiceId)`;
//   · `Payment` cuelga de propertyId + folioId y su asiento es `payment` / `<paymentId>`; el cobro
//     de un folio se registra ANTES de facturar (invoiceId nulo) y la proyección lo contabiliza igual
//     (`paymentCandidates`: deletedAt null, reversalOfId null, status captured | refunded, con o sin
//     factura), así que el índice incluye TODOS los cobros proyectables, no solo los ligados a una
//     factura (integración L6: un cobro TPV de 12,50 sin factura duplicaba el asiento de Sage); las
//     devoluciones completadas (`PaymentRefund.status completed`, asiento `payment_refund` /
//     `<refundId>`) se indexan por su importe y fecha con sourceType `payment_refund`;
//   · `SupplierBill` (facturas recibidas contabilizadas o pagadas en Anfitorio) se indexa por
//     NIF del proveedor + número del proveedor (`nativeSupplierBillKey`) para el libro de
//     RECIBIDAS de un lote `vat_books`: `writeInputVatRows` ya materializó su fila.
// Sin fila de asiento nativo (factura emitida pero aún no proyectada) la factura sigue
// excluida: el replay de la proyección la contabilizaría después (design §5.1.5).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { isoDay } from "../accounting.service.js";
import { nativeInvoiceKey, normalizeNativeDocumentKey } from "./ledger-import.mapping.js";
import { nativeSupplierBillKey, type NativeEntryRef, type NativeIndex } from "./ledger-import.posting.js";

/** Cliente mínimo (transacción o raíz) que lee el índice; los tests pasan dobles (`supplierBill` opcional). */
export type NativeIndexClient = (Pick<Prisma.TransactionClient, "property" | "invoice" | "payment" | "journalEntry"> & Partial<Pick<Prisma.TransactionClient, "supplierBill" | "paymentRefund">>) | typeof prisma;

/** Estados de `SupplierBill` con fila de libro de recibidas propia (`writeInputVatRows` al contabilizar). */
export const NATIVE_SUPPLIER_BILL_STATUSES: readonly string[] = Object.freeze(["posted", "paid"]);

/** Tipos de asiento nativo de una factura, por prioridad (la factura viva antes que su anulación). */
export const NATIVE_INVOICE_SOURCE_TYPES: readonly string[] = Object.freeze(["invoice", "invoice_rectification", "invoice_cancellation"]);
export const NATIVE_PAYMENT_SOURCE_TYPE = "payment" as const;
export const NATIVE_REFUND_SOURCE_TYPE = "payment_refund" as const;
/** Estados de `Payment` que la proyección contabiliza (`paymentCandidates`, projection.ts): el cobro existe en el diario con o sin factura. */
export const NATIVE_PAYMENT_STATUSES: readonly string[] = Object.freeze(["captured", "refunded"]);

export type NativeIndexStats = {
  properties: number;
  invoices: number;
  invoiceKeys: number;
  payments: number;
  supplierBills: number;
};

/**
 * Facturas y cobros nativos de la organización (todas sus propiedades) indexados por
 * la clave de documento normalizada y por importe cobrado.
 */
export async function buildNativeIndex(client: NativeIndexClient, organizationId: string): Promise<{ index: NativeIndex; stats: NativeIndexStats }> {
  const properties = await client.property.findMany({ where: { organizationId }, select: { id: true, code: true } });
  const propertyIds = properties.map((property) => property.id);
  const invoiceKeys = new Map<string, NativeEntryRef>();
  const paymentAmounts = new Map<string, NativeEntryRef[]>();
  const supplierBillKeys = new Map<string, NativeEntryRef>();
  if (propertyIds.length === 0) {
    return { index: { invoiceKeys, paymentAmounts, supplierBillKeys }, stats: { properties: 0, invoices: 0, invoiceKeys: 0, payments: 0, supplierBills: 0 } };
  }
  const invoices = await client.invoice.findMany({
    where: { propertyId: { in: propertyIds }, invoiceNumber: { not: null }, deletedAt: null },
    select: { id: true, invoiceNumber: true, seriesCode: true, propertyId: true, status: true }
  });
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const nativeEntries = invoiceIds.length
    ? await client.journalEntry.findMany({
        where: { organizationId, sourceType: { in: [...NATIVE_INVOICE_SOURCE_TYPES] }, sourceId: { in: invoiceIds } },
        select: { sourceType: true, sourceId: true, status: true }
      })
    : [];
  const entryByInvoice = new Map<string, { sourceType: string; sourceId: string }>();
  for (const type of NATIVE_INVOICE_SOURCE_TYPES) {
    for (const entry of nativeEntries) {
      if (entry.sourceType !== type || !entry.sourceId || entryByInvoice.has(entry.sourceId)) continue;
      entryByInvoice.set(entry.sourceId, { sourceType: entry.sourceType, sourceId: entry.sourceId });
    }
  }
  const invoiceById = new Map<string, { invoiceNumber: string | null }>();
  for (const invoice of invoices) {
    invoiceById.set(invoice.id, { invoiceNumber: invoice.invoiceNumber });
    if (!invoice.invoiceNumber) continue;
    const native = entryByInvoice.get(invoice.id) ?? { sourceType: "invoice", sourceId: invoice.id };
    const ref: NativeEntryRef = { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, sourceType: native.sourceType, sourceId: native.sourceId, date: null };
    const keys = new Set<string>();
    const full = nativeInvoiceKey(invoice.invoiceNumber);
    if (full) keys.add(full);
    // Serie explícita + número impreso: `FAC-2026` + `FAC-2026-000015` → el serial tras la serie.
    if (invoice.seriesCode && invoice.invoiceNumber.toUpperCase().startsWith(invoice.seriesCode.toUpperCase())) {
      const serial = invoice.invoiceNumber.slice(invoice.seriesCode.length).replace(/^[-_/\s]+/, "");
      const bySeries = normalizeNativeDocumentKey(invoice.seriesCode, serial);
      if (bySeries) keys.add(bySeries);
    }
    for (const key of keys) if (!invoiceKeys.has(key)) invoiceKeys.set(key, ref);
  }
  // Mismo filtro que la proyección (`paymentCandidates`): cobros captados o devueltos, no borrados y que no
  // son filas de reverso; CON o SIN factura (el cobro del folio se proyecta aunque la factura llegue después).
  const payments = await client.payment.findMany({
    where: { propertyId: { in: propertyIds }, deletedAt: null, reversalOfId: null, status: { in: [...NATIVE_PAYMENT_STATUSES] as ("captured" | "refunded")[] } },
    select: { id: true, amount: true, invoiceId: true, createdAt: true, propertyId: true }
  });
  for (const payment of payments) {
    const amount = payment.amount.toFixed(2);
    const invoice = payment.invoiceId ? invoiceById.get(payment.invoiceId) : undefined;
    // `propertyId`: la heurística importe + fecha solo excluye asientos de Sage del mismo centro (buildJournalEntries).
    const ref: NativeEntryRef = { invoiceId: payment.invoiceId ?? null, invoiceNumber: invoice?.invoiceNumber ?? null, sourceType: NATIVE_PAYMENT_SOURCE_TYPE, sourceId: payment.id, date: isoDay(payment.createdAt), propertyId: payment.propertyId ?? null };
    paymentAmounts.set(amount, [...(paymentAmounts.get(amount) ?? []), ref]);
  }
  // Devoluciones completadas: asiento `payment_refund` / `<refundId>` (inverso del cobro, mismo importe).
  const refunds = client.paymentRefund && payments.length > 0
    ? await client.paymentRefund.findMany({ where: { paymentId: { in: payments.map((payment) => payment.id) }, status: "completed" }, select: { id: true, paymentId: true, amount: true, createdAt: true } })
    : [];
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  for (const refund of refunds) {
    const payment = paymentById.get(refund.paymentId);
    const invoice = payment?.invoiceId ? invoiceById.get(payment.invoiceId) : undefined;
    const amount = refund.amount.toFixed(2);
    const ref: NativeEntryRef = { invoiceId: payment?.invoiceId ?? null, invoiceNumber: invoice?.invoiceNumber ?? null, sourceType: NATIVE_REFUND_SOURCE_TYPE, sourceId: refund.id, date: isoDay(refund.createdAt), propertyId: payment?.propertyId ?? null };
    paymentAmounts.set(amount, [...(paymentAmounts.get(amount) ?? []), ref]);
  }
  // Facturas recibidas contabilizadas en Anfitorio (libro de recibidas ya materializado por el documento).
  const supplierBills = client.supplierBill
    ? await client.supplierBill.findMany({
        where: { propertyId: { in: propertyIds }, status: { in: [...NATIVE_SUPPLIER_BILL_STATUSES] as ("posted" | "paid")[] }, invoiceNumber: { not: null } },
        select: { id: true, invoiceNumber: true, supplierTaxId: true, journalEntryId: true }
      })
    : [];
  for (const bill of supplierBills) {
    const key = nativeSupplierBillKey(bill.supplierTaxId, bill.invoiceNumber);
    if (!key || supplierBillKeys.has(key)) continue;
    supplierBillKeys.set(key, { invoiceId: null, invoiceNumber: bill.invoiceNumber, sourceType: "supplier_bill", sourceId: bill.id, date: null });
  }
  return {
    index: { invoiceKeys, paymentAmounts, supplierBillKeys },
    stats: { properties: properties.length, invoices: invoices.length, invoiceKeys: invoiceKeys.size, payments: payments.length + refunds.length, supplierBills: supplierBills.length }
  };
}
