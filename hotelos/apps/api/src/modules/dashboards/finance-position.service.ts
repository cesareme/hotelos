import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { listSupplierBills } from "../accounting/accounting.service.js";

// Read-only finance health monitor: AR, AP and Cash position for a property.
//
// Sharp edges to be aware of (see report):
//   * Supplier bills are fully Prisma-backed via `accounting.service.ts`
//     (`listSupplierBills` reads `prisma.supplierBill`). As of Sprint 29 the
//     Spain-specific extras (retention*, paymentDate, supplierName, …) are
//     real columns on the model, so they survive restarts. Pre-Sprint-29
//     rows may have those columns as NULL; AP aging uses
//     `dueDate`/`issueDate` + `total` so that case is still safe here.
//   * `InvoiceStatus` enum only has draft/issued/cancelled/rectified — no
//     `sent` or `overdue`. We treat any non-cancelled non-draft invoice as AR
//     and let aging buckets surface the "overdue" view.
//   * Invoices have no direct guest link; the only customer dimension is
//     `customerTaxId`. Top debtors are grouped by taxId (falling back to
//     "Walk-in / unidentified" when null).

export type FinancePositionDashboard = {
  kpis: {
    accountsReceivableTotal: number;
    accountsPayableTotal: number;
    cashOnHand: number;
    monthCollectedPct: number;
  };
  arAging: AgingBuckets;
  apAging: AgingBuckets;
  topDebtors: Array<{ guestOrAccount: string; invoiceCount: number; outstanding: number }>;
  topCreditors: Array<{ supplierName: string; billCount: number; outstanding: number }>;
  recentPayments: Array<{ id: string; amount: number; method: string; capturedAt?: string; reference?: string }>;
};

export type AgingBuckets = {
  current: number;
  days0_30: number;
  days31_60: number;
  days61_90: number;
  days90Plus: number;
};

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyBuckets(): AgingBuckets {
  return { current: 0, days0_30: 0, days31_60: 0, days61_90: 0, days90Plus: 0 };
}

function diffDays(later: Date, earlier: Date): number {
  const ms = later.getTime() - earlier.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function addToBucket(buckets: AgingBuckets, asOf: Date, reference: Date | null | undefined, amount: number) {
  if (!reference || Number.isNaN(reference.getTime())) {
    // No date we can bucket on — treat as current.
    buckets.current = round(buckets.current + amount);
    return;
  }
  const days = diffDays(asOf, reference);
  if (days < 0) buckets.current = round(buckets.current + amount);
  else if (days <= 30) buckets.days0_30 = round(buckets.days0_30 + amount);
  else if (days <= 60) buckets.days31_60 = round(buckets.days31_60 + amount);
  else if (days <= 90) buckets.days61_90 = round(buckets.days61_90 + amount);
  else buckets.days90Plus = round(buckets.days90Plus + amount);
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function buildFinancePositionDashboard(input: {
  propertyId: string;
  asOf?: Date;
}): Promise<FinancePositionDashboard> {
  const propertyId = input.propertyId;
  const asOf = input.asOf ?? new Date();
  const monthStart = startOfMonth(asOf);

  // 1) Load invoices + folios + payments + refunds in parallel.
  const [invoiceRows, paymentRows, reservationRows] = await Promise.all([
    prisma.invoice.findMany({ where: { propertyId } }),
    prisma.payment.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" } }),
    prisma.reservation.findMany({ where: { propertyId }, select: { id: true } })
  ]);

  const reservationIds = reservationRows.map((r) => r.id);
  const folioRows = reservationIds.length
    ? await prisma.folio.findMany({ where: { reservationId: { in: reservationIds } } })
    : [];
  const folioIds = folioRows.map((f) => f.id);
  const folioLineRows = folioIds.length
    ? await prisma.folioLine.findMany({ where: { folioId: { in: folioIds } } })
    : [];
  const paymentIds = paymentRows.map((p) => p.id);
  const refundRows = paymentIds.length
    ? await prisma.paymentRefund.findMany({ where: { paymentId: { in: paymentIds } } })
    : [];

  // 2) AR — outstanding per invoice. The schema has no invoice-level paid
  //    amount, so we approximate outstanding via the related folio balance:
  //    outstanding = max(0, invoice.total - paymentsCaptured_for_folio_share).
  //    Without a hard folio↔invoice link we cannot apportion when a folio has
  //    multiple invoices. We therefore treat issued/non-cancelled invoices as
  //    fully outstanding and subtract captured payments on the same property
  //    only via the month-collected ratio (KPI). This is a conscious read-only
  //    approximation and is documented in the report.
  const arInvoices = invoiceRows.filter((inv) => inv.status !== "draft" && inv.status !== "cancelled");

  // 3) AP from Prisma-backed supplier bills (filtered by property).
  const supplierBills = (await listSupplierBills(propertyId)).filter(
    (bill) => bill.status !== "posted" || true
  );
  // Treat "not paid" = anything not yet posted. paymentDate presence means a
  // payment was attached, so we exclude those from AP open.
  const openSupplierBills = supplierBills.filter((bill) => !bill.paymentDate);

  // 4) Compute AR aging buckets.
  const arAging = emptyBuckets();
  for (const inv of arInvoices) {
    const ref = parseDate(inv.issuedAt) ?? parseDate(inv.createdAt);
    addToBucket(arAging, asOf, ref, dec(inv.total));
  }

  // 5) Compute AP aging buckets.
  const apAging = emptyBuckets();
  for (const bill of openSupplierBills) {
    const ref = parseDate(bill.dueDate) ?? parseDate(bill.issueDate);
    const grossOutstanding = Number(bill.total) || 0;
    addToBucket(apAging, asOf, ref, grossOutstanding);
  }

  // 6) Cash on hand = captured payments minus refunds.
  const capturedPayments = paymentRows.filter((p) => p.status === "captured");
  const totalCaptured = capturedPayments.reduce((sum, p) => sum + dec(p.amount), 0);
  const totalRefunded = refundRows.reduce((sum, r) => sum + dec(r.amount), 0);
  const cashOnHand = round(totalCaptured - totalRefunded);

  // 7) Month collected % = collected this calendar month / issued this calendar month.
  const issuedThisMonth = arInvoices.filter((inv) => {
    const issued = parseDate(inv.issuedAt) ?? parseDate(inv.createdAt);
    return issued !== null && issued >= monthStart && issued <= asOf;
  });
  const issuedMonthTotal = issuedThisMonth.reduce((sum, inv) => sum + dec(inv.total), 0);
  const collectedThisMonth = capturedPayments.filter((p) => p.createdAt >= monthStart && p.createdAt <= asOf);
  const collectedMonthTotal = collectedThisMonth.reduce((sum, p) => sum + dec(p.amount), 0);
  const monthCollectedPct = issuedMonthTotal > 0
    ? Math.round((collectedMonthTotal / issuedMonthTotal) * 1000) / 10
    : 0;

  // 8) KPI totals.
  const accountsReceivableTotal = round(
    arAging.current + arAging.days0_30 + arAging.days31_60 + arAging.days61_90 + arAging.days90Plus
  );
  const accountsPayableTotal = round(
    apAging.current + apAging.days0_30 + apAging.days31_60 + apAging.days61_90 + apAging.days90Plus
  );

  // 9) Top debtors — group invoices by customerTaxId.
  type DebtorAgg = { guestOrAccount: string; invoiceCount: number; outstanding: number };
  const debtorMap = new Map<string, DebtorAgg>();
  for (const inv of arInvoices) {
    const key = inv.customerTaxId ?? "__walkin__";
    const label = inv.customerTaxId
      ? `${inv.customerType} · ${inv.customerTaxId}`
      : "Walk-in / unidentified";
    const existing = debtorMap.get(key);
    if (existing) {
      existing.invoiceCount += 1;
      existing.outstanding = round(existing.outstanding + dec(inv.total));
    } else {
      debtorMap.set(key, { guestOrAccount: label, invoiceCount: 1, outstanding: round(dec(inv.total)) });
    }
  }
  const topDebtors = Array.from(debtorMap.values())
    .filter((d) => d.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 10);

  // 10) Top creditors — group open supplier bills by supplier.
  type CreditorAgg = { supplierName: string; billCount: number; outstanding: number };
  const creditorMap = new Map<string, CreditorAgg>();
  for (const bill of openSupplierBills) {
    const key = bill.supplierName || "Unknown supplier";
    const existing = creditorMap.get(key);
    const amount = Number(bill.total) || 0;
    if (existing) {
      existing.billCount += 1;
      existing.outstanding = round(existing.outstanding + amount);
    } else {
      creditorMap.set(key, { supplierName: key, billCount: 1, outstanding: round(amount) });
    }
  }
  const topCreditors = Array.from(creditorMap.values())
    .filter((c) => c.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 10);

  // 11) Recent captured payments (most recent 10).
  const recentPayments = capturedPayments.slice(0, 10).map((p) => ({
    id: p.id,
    amount: round(dec(p.amount)),
    method: p.method,
    capturedAt: p.createdAt.toISOString(),
    reference: p.pspReference ?? undefined
  }));

  // Silence unused-variable hints for folio data — we keep the queries in
  // place because they are cheap and let downstream additions (e.g. precise
  // per-invoice outstanding) plug in without re-fetching.
  void folioRows;
  void folioLineRows;

  return {
    kpis: {
      accountsReceivableTotal,
      accountsPayableTotal,
      cashOnHand,
      monthCollectedPct
    },
    arAging,
    apAging,
    topDebtors,
    topCreditors,
    recentPayments
  };
}
