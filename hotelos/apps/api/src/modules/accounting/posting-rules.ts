import type { EventEnvelope } from "@hotelos/shared";
import { resolveTaxRate } from "./tax-rate.service.js";

export type JournalLineInput = {
  accountCode: string;
  debit: number;
  credit: number;
  description?: string;
};

export type PostingResult = {
  sourceType: string;
  sourceId: string;
  description: string;
  lines: JournalLineInput[];
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const REVENUE_ACCOUNT: Record<string, string> = {
  room: "705",
  breakfast: "700",
  minibar: "700",
  parking: "7050",
  adjustment: "7090",
  tax: "4759"
};

const PAYMENT_ACCOUNT: Record<string, string> = {
  cash: "570",
  card: "572",
  bank_transfer: "572",
  payment_link: "572",
  ota_virtual_card: "4310"
};

export async function ruleForChargePosted(event: EventEnvelope): Promise<PostingResult | null> {
  const payload = event.payload as { lineId: string; total: number; type: string } | undefined;
  if (!payload) return null;
  const total = Number(payload.total);
  if (!Number.isFinite(total) || total === 0) return null;

  const lineType = payload.type;
  const propertyId = event.propertyId;
  const resolved = await resolveTaxRate({ propertyId, lineType, postingDate: new Date(event.createdAt) });
  const vatRate = resolved.ratePercent / 100;
  const revenueAccount = REVENUE_ACCOUNT[lineType] ?? "705";
  const customerAccount = "4300";

  const net = vatRate > 0 ? round(total / (1 + vatRate)) : total;
  const vat = round(total - net);

  const lines: JournalLineInput[] = [
    { accountCode: customerAccount, debit: total, credit: 0, description: `Customer A/R for ${lineType}` },
    { accountCode: revenueAccount, debit: 0, credit: net, description: `${lineType} net revenue (${resolved.taxRegion})` }
  ];
  if (vat > 0) {
    lines.push({
      accountCode: "477",
      debit: 0,
      credit: vat,
      description: `${resolved.taxCode} ${resolved.rateCode} ${resolved.ratePercent}% (${resolved.taxRegion})`
    });
  }

  return {
    sourceType: "folio_line",
    sourceId: payload.lineId,
    description: `Charge posted (${lineType}) total €${total.toFixed(2)} — ${resolved.taxCode}@${resolved.ratePercent}%`,
    lines
  };
}

export function ruleForPaymentCaptured(event: EventEnvelope): PostingResult | null {
  const payload = event.payload as { folioId: string; amount: number; method: string } | undefined;
  if (!payload) return null;
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const paymentAccount = PAYMENT_ACCOUNT[payload.method] ?? "572";
  const customerAccount = "4300";

  return {
    sourceType: "payment",
    sourceId: event.entityId ?? payload.folioId,
    description: `Payment captured (${payload.method}) €${amount.toFixed(2)}`,
    lines: [
      { accountCode: paymentAccount, debit: amount, credit: 0, description: `Receipt via ${payload.method}` },
      { accountCode: customerAccount, debit: 0, credit: amount, description: "Settles customer A/R" }
    ]
  };
}

export function ruleForPaymentRefunded(event: EventEnvelope): PostingResult | null {
  const payload = event.payload as { amount: number; method: string } | undefined;
  if (!payload) return null;
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const paymentAccount = PAYMENT_ACCOUNT[payload.method] ?? "572";

  return {
    sourceType: "payment_refund",
    sourceId: event.entityId ?? "",
    description: `Payment refunded (${payload.method}) €${amount.toFixed(2)}`,
    lines: [
      { accountCode: "4300", debit: amount, credit: 0, description: "Restore customer A/R" },
      { accountCode: paymentAccount, debit: 0, credit: amount, description: `Refund via ${payload.method}` }
    ]
  };
}

// Accounts payable: a supplier bill creates the standard Spanish AP entry.
//   DR <expense> (net base)         e.g. 622 Reparaciones y conservación
//   DR 472       (IVA soportado)
//   CR 4751      (H.P. acreedora por retenciones IRPF)   — if any retention
//   CR 400       (Proveedores) = total invoice − retention (amount payable)
// `total` is the gross invoice (base + IVA); `grossAmount` is the net base.
export function ruleForSupplierBillCreated(event: EventEnvelope): PostingResult | null {
  const payload = event.payload as
    | {
        total?: number;
        taxTotal?: number;
        grossAmount?: number;
        retentionAmount?: number;
        suggestedAccountCode?: string;
        supplierName?: string;
      }
    | undefined;
  if (!payload || !event.entityId) return null;
  const total = round(Number(payload.total ?? 0));
  const iva = round(Number(payload.taxTotal ?? 0));
  if (!Number.isFinite(total) || total === 0) return null;
  const net = round(Number(payload.grossAmount ?? total - iva));
  const retention = round(Number(payload.retentionAmount ?? 0));
  const payable = round(total - retention);
  const expenseAccount = payload.suggestedAccountCode || "622";
  const supplier = payload.supplierName ? ` — ${payload.supplierName}` : "";

  const lines: JournalLineInput[] = [
    { accountCode: expenseAccount, debit: net, credit: 0, description: `Supplier expense${supplier}` }
  ];
  if (iva > 0) {
    lines.push({ accountCode: "472", debit: iva, credit: 0, description: "IVA soportado" });
  }
  if (retention > 0) {
    lines.push({ accountCode: "4751", debit: 0, credit: retention, description: "Retención IRPF" });
  }
  lines.push({ accountCode: "400", debit: 0, credit: payable, description: `Proveedores${supplier}` });

  return {
    sourceType: "supplier_bill",
    sourceId: event.entityId,
    description: `Supplier bill${supplier} total €${total.toFixed(2)}`,
    lines
  };
}

export async function evaluate(event: EventEnvelope): Promise<PostingResult | null> {
  switch (event.eventType) {
    case "ChargePosted":
      return ruleForChargePosted(event);
    case "PaymentCaptured":
      return ruleForPaymentCaptured(event);
    case "PaymentRefunded":
      return ruleForPaymentRefunded(event);
    case "SupplierBillCreated":
      return ruleForSupplierBillCreated(event);
    default:
      return null;
  }
}

export function assertBalanced(lines: JournalLineInput[]): void {
  const totalDebit = round(lines.reduce((sum, l) => sum + l.debit, 0));
  const totalCredit = round(lines.reduce((sum, l) => sum + l.credit, 0));
  if (totalDebit !== totalCredit) {
    throw new Error(`Journal entry not balanced: debit €${totalDebit} vs credit €${totalCredit}`);
  }
}
