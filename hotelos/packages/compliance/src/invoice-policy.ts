export type InvoiceStatus = "draft" | "issued" | "cancelled" | "rectified";
export type InvoiceCorrectionType = "cancellation" | "credit_note" | "rectifying_invoice";

export function assertInvoiceMutable(status: InvoiceStatus): void {
  if (status !== "draft") {
    throw new Error("Issued invoices are immutable. Use cancellation, credit note, or rectifying invoice workflow.");
  }
}

export function allowedInvoiceCorrectionWorkflows(status: InvoiceStatus): InvoiceCorrectionType[] {
  if (status === "issued") {
    return ["cancellation", "credit_note", "rectifying_invoice"];
  }

  if (status === "rectified" || status === "cancelled") {
    return [];
  }

  return ["cancellation"];
}

export function buildVerifactuHashPayload(input: {
  invoiceNumber: string;
  issuedAt: string;
  total: number;
  taxTotal: number;
  previousInvoiceHash?: string;
}): string {
  return JSON.stringify({
    invoiceNumber: input.invoiceNumber,
    issuedAt: input.issuedAt,
    total: input.total,
    taxTotal: input.taxTotal,
    previousInvoiceHash: input.previousInvoiceHash ?? null
  });
}

