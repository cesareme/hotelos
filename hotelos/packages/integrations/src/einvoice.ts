export type B2bEinvoiceStatus = "created" | "sent" | "accepted" | "rejected" | "paid";

export type B2bEinvoiceEnvelope = {
  invoiceId: string;
  syntax: "UBL" | "Facturae";
  status: B2bEinvoiceStatus;
  events: Array<{ status: B2bEinvoiceStatus; at: string; message?: string }>;
};

export function createB2bEinvoiceEnvelope(invoiceId: string, syntax: "UBL" | "Facturae" = "UBL"): B2bEinvoiceEnvelope {
  return {
    invoiceId,
    syntax,
    status: "created",
    events: [{ status: "created", at: new Date().toISOString() }]
  };
}

