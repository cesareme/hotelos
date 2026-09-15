import { prisma } from "@hotelos/database";
import { treasuryPayables, treasuryPosition, treasuryReceivables } from "../treasury/treasury.service.js";
import { addDays, dayUtc, dec, money, moneyNumber, round2, sum } from "../treasury/money.js";

// Finance position dashboard (Tesorería): a read model over the treasury
// service (lote tesoreria-banca).
//
//   · accountsReceivableTotal = invoices net of rectifications and of their
//     payments + open folios without invoice (treasury.receivables);
//   · accountsPayableTotal    = received invoices unpaid + payroll unpaid +
//     commissions unsettled + ledger tax liabilities (treasury.payables);
//   · cashOnHand              = 570 + reconciled bank balances from the
//     ledger / statements (treasury.position) — never the historical sum of
//     payments, and refunds are no longer subtracted twice;
//   · monthCollectedPct       = captured this month (net of refunds) / issued
//     this month.
// Shape kept for the existing screen; `labels` carries the Spanish captions
// and `source`/`warnings` say where the figures come from.

export type FinancePositionDashboard = {
  kpis: {
    accountsReceivableTotal: number;
    accountsPayableTotal: number;
    cashOnHand: number;
    monthCollectedPct: number;
    pendingSettlements: number;
  };
  arAging: AgingBuckets;
  apAging: AgingBuckets;
  topDebtors: Array<{ guestOrAccount: string; invoiceCount: number; outstanding: number }>;
  topCreditors: Array<{ supplierName: string; billCount: number; outstanding: number }>;
  recentPayments: Array<{ id: string; amount: number; method: string; methodLabel: string; capturedAt?: string; reference?: string }>;
  banks: Array<{ bankAccountId: string; name: string; reconciledBalance: number; ledgerBalance: number; statementClosing: number | null; drift: number; unmatchedLines: number }>;
  source: string;
  warnings: string[];
  labels: Record<string, string>;
};

export type AgingBuckets = {
  current: number;
  days0_30: number;
  days31_60: number;
  days61_90: number;
  days90Plus: number;
};

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta (datáfono)",
  card_terminal: "Tarjeta (datáfono)",
  card_online: "Tarjeta online",
  bank_transfer: "Transferencia",
  payment_link: "Enlace de pago",
  ota_virtual_card: "Tarjeta virtual OTA",
  other: "Otro"
};

const LABELS: Record<string, string> = {
  accountsReceivableTotal: "Pendiente de cobro",
  accountsPayableTotal: "Pendiente de pago",
  cashOnHand: "Caja y bancos",
  monthCollectedPct: "% cobrado del mes",
  pendingSettlements: "Datáfono y pasarela pendientes de liquidar",
  arAging: "Antigüedad de cobros",
  apAging: "Antigüedad de pagos",
  topDebtors: "Principales deudores",
  topCreditors: "Principales acreedores",
  recentPayments: "Últimos cobros",
  banks: "Cuentas bancarias",
  current: "No vencido",
  days0_30: "0-30 días",
  days31_60: "31-60 días",
  days61_90: "61-90 días",
  days90Plus: "> 90 días"
};

function agingToNumbers(a: { current: string; days0_30: string; days31_60: string; days61_90: string; days90Plus: string }): AgingBuckets {
  return { current: Number(a.current), days0_30: Number(a.days0_30), days31_60: Number(a.days31_60), days61_90: Number(a.days61_90), days90Plus: Number(a.days90Plus) };
}

export async function buildFinancePositionDashboard(input: { propertyId: string; asOf?: Date }): Promise<FinancePositionDashboard> {
  const propertyId = input.propertyId;
  const asOf = input.asOf ?? new Date();
  const asOfDay = dayUtc(asOf);
  const monthStart = new Date(Date.UTC(asOfDay.getUTCFullYear(), asOfDay.getUTCMonth(), 1));

  const [position, receivables, payables] = await Promise.all([
    treasuryPosition({ propertyId, asOf: asOfDay }),
    treasuryReceivables({ propertyId, asOf: asOfDay }),
    treasuryPayables({ propertyId, asOf: asOfDay })
  ]);

  // Month collected %: captured this month net of refunds / issued this month.
  const [issuedThisMonth, capturedThisMonth] = await Promise.all([
    prisma.invoice.findMany({ where: { propertyId, deletedAt: null, status: { in: ["issued", "rectified"] }, issuedAt: { gte: monthStart, lt: addDays(asOfDay, 1) } }, select: { total: true } }),
    prisma.payment.findMany({ where: { propertyId, status: "captured", deletedAt: null, createdAt: { gte: monthStart, lt: addDays(asOfDay, 1) } }, select: { id: true, amount: true } })
  ]);
  const refunds = capturedThisMonth.length ? await prisma.paymentRefund.findMany({ where: { paymentId: { in: capturedThisMonth.map((p) => p.id) }, status: { notIn: ["rejected", "failed", "cancelled"] } }, select: { amount: true } }) : [];
  const issuedMonthTotal = round2(sum(issuedThisMonth.map((i) => dec(i.total))));
  const collectedMonthTotal = round2(sum(capturedThisMonth.map((p) => dec(p.amount))).minus(sum(refunds.map((r) => dec(r.amount)))));
  const monthCollectedPct = issuedMonthTotal.gt(0) ? Number(collectedMonthTotal.div(issuedMonthTotal).mul(100).toDecimalPlaces(1).toString()) : 0;

  // Top debtors / creditors from the treasury items.
  const debtorMap = new Map<string, { guestOrAccount: string; invoiceCount: number; outstanding: number }>();
  for (const item of receivables.items) {
    const key = item.counterparty;
    const existing = debtorMap.get(key) ?? { guestOrAccount: key, invoiceCount: 0, outstanding: 0 };
    existing.invoiceCount += 1;
    existing.outstanding = moneyNumber(dec(existing.outstanding).plus(dec(item.outstanding)));
    debtorMap.set(key, existing);
  }
  const creditorMap = new Map<string, { supplierName: string; billCount: number; outstanding: number }>();
  for (const item of payables.items) {
    const key = item.counterparty;
    const existing = creditorMap.get(key) ?? { supplierName: key, billCount: 0, outstanding: 0 };
    existing.billCount += 1;
    existing.outstanding = moneyNumber(dec(existing.outstanding).plus(dec(item.outstanding)));
    creditorMap.set(key, existing);
  }

  const recent = await prisma.payment.findMany({ where: { propertyId, status: "captured", deletedAt: null }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, amount: true, method: true, methodCode: true, createdAt: true, pspReference: true } });

  return {
    kpis: {
      accountsReceivableTotal: Number(receivables.total),
      accountsPayableTotal: Number(payables.total),
      cashOnHand: Number(position.totals.cashAndBanks),
      monthCollectedPct,
      pendingSettlements: Number(position.pendingSettlements.total)
    },
    arAging: agingToNumbers(receivables.aging),
    apAging: agingToNumbers(payables.aging),
    topDebtors: Array.from(debtorMap.values()).filter((d) => d.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).slice(0, 10),
    topCreditors: Array.from(creditorMap.values()).filter((c) => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).slice(0, 10),
    recentPayments: recent.map((p) => ({
      id: p.id,
      amount: moneyNumber(p.amount),
      method: p.methodCode ?? p.method,
      methodLabel: METHOD_LABELS[p.methodCode ?? p.method] ?? p.method,
      capturedAt: p.createdAt.toISOString(),
      reference: p.pspReference ?? undefined
    })),
    banks: position.banks.map((b) => ({
      bankAccountId: b.bankAccountId,
      name: b.name,
      reconciledBalance: Number(b.reconciledBalance),
      ledgerBalance: Number(b.ledgerBalance),
      statementClosing: b.statementClosing === null ? null : Number(b.statementClosing),
      drift: Number(b.drift),
      unmatchedLines: b.unmatchedLines
    })),
    source: position.source,
    warnings: [...position.warnings, `Cobrado este mes ${money(collectedMonthTotal)} € sobre ${money(issuedMonthTotal)} € facturados.`],
    labels: LABELS
  };
}
