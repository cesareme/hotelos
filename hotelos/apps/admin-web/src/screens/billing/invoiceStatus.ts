// Shared invoice status helpers of the billing screens (Cocoa 22 · lote 6-A).
//
// The backend InvoiceStatus enum keeps draft / issued / cancelled / rectified;
// «paid» is derived ONLY from the API's `paymentStatus` (captured payments
// linked to the invoice, Tanda 2 · QC-03) — never from a local mark. The
// helpers answer the Cocoa tone of a `CocoaBadge` and its Spanish label.

import type { CocoaTone } from "../../components/cocoa";
import type { InvoiceDraft } from "../../services/pmsCommerceApi";

export type InvoiceUiStatus = "draft" | "issued" | "paid" | "partial" | "cancelled" | "rectified";

export function isInvoicePaid(invoice: Pick<InvoiceDraft, "status" | "paymentStatus">): boolean {
  return invoice.status === "issued" && invoice.paymentStatus === "paid";
}

/** «Marcar pagada» applies to issued invoices with money still due. */
export function canMarkPaid(invoice: Pick<InvoiceDraft, "status" | "paymentStatus">): boolean {
  return invoice.status === "issued" && invoice.paymentStatus !== "paid" && invoice.paymentStatus !== "not_applicable";
}

export function deriveInvoiceUiStatus(invoice: Pick<InvoiceDraft, "status" | "paymentStatus">): InvoiceUiStatus {
  if (invoice.status === "cancelled") return "cancelled";
  if (invoice.status === "rectified") return "rectified";
  if (invoice.status === "issued") {
    if (invoice.paymentStatus === "paid") return "paid";
    if (invoice.paymentStatus === "partial") return "partial";
    return "issued";
  }
  return "draft";
}

export function invoiceStatusTone(status: InvoiceUiStatus): CocoaTone {
  switch (status) {
    case "paid":
      return "success";
    case "partial":
      return "warning";
    case "issued":
      return "info";
    case "cancelled":
      return "danger";
    case "rectified":
      return "warning";
    case "draft":
    default:
      return "neutral";
  }
}

export function invoiceStatusLabel(status: InvoiceUiStatus): string {
  switch (status) {
    case "paid":
      return "Pagada";
    case "partial":
      return "Cobro parcial";
    case "issued":
      return "Emitida";
    case "draft":
      return "Borrador";
    case "cancelled":
      return "Anulada";
    case "rectified":
      return "Rectificada";
    default:
      return status;
  }
}

/** «F1», «R1»… and the legacy draft types → Spanish. */
export function invoiceTypeLabel(invoiceType: string | null | undefined): string {
  switch (invoiceType) {
    case "full":
    case "F1":
      return "Completa (F1)";
    case "simplified":
    case "F2":
      return "Simplificada (F2)";
    case "rectifying":
      return "Rectificativa";
    case "credit_note":
      return "Abono";
    case "R1":
    case "R2":
    case "R3":
    case "R4":
    case "R5":
      return `Rectificativa (${invoiceType})`;
    default:
      return invoiceType ? String(invoiceType) : "—";
  }
}

export function customerTypeLabel(customerType: string | null | undefined): string {
  switch (customerType) {
    case "guest":
      return "Huésped";
    case "company":
      return "Empresa";
    case "agency":
      return "Agencia";
    default:
      return customerType ? String(customerType) : "—";
  }
}
