// Shared invoice status helpers used by BillingCenterScreen, FolioDetailScreen
// and InvoiceDetailScreen. "paid" is a UI-only derived status driven by the
// session-storage flag — the backend InvoiceStatus enum keeps only:
// draft / issued / cancelled / rectified.
//
// Keep this module in sync with the badge variants of the underlying primitive
// (currently StatusBadge v2; will move to CocoaStatusBadge when available).

import type { StatusBadgeVariant } from "../../components/v2/StatusBadge";

export type InvoiceUiStatus =
  | "draft"
  | "issued"
  | "paid"
  | "cancelled"
  | "rectified";

export function statusBadgeVariant(status: InvoiceUiStatus): StatusBadgeVariant {
  switch (status) {
    case "paid":
      return "success";
    case "issued":
      return "info";
    case "draft":
      return "neutral";
    case "cancelled":
      return "danger";
    case "rectified":
      return "warn";
    default:
      return "neutral";
  }
}

export function statusBadgeLabel(status: InvoiceUiStatus): string {
  switch (status) {
    case "paid":
      return "Pagada";
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
