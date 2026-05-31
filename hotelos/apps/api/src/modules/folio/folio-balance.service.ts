import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

// Shared folio-balance helper (Sprint 46).
//
// The `Folio` model carries no balance column, so outstanding amounts are
// derived from charges (FolioLine.total), captured payments (Payment.amount
// where status="captured") and refunds (PaymentRefund.amount) against those
// payments. This module is the single canonical implementation; dashboards and
// the guest portal call it instead of recomputing balances inline.
//
// Sharp edge — FolioLine has no payment line type. Its `type` column only ever
// holds charge kinds ("room" | "tax" | "breakfast" | "parking" | "minibar" |
// "adjustment"), so every FolioLine is a charge. Payments live entirely in the
// `Payment` table and refunds in `PaymentRefund`. We therefore sum *all*
// FolioLine.total for chargesTotal — there is nothing to filter out.
//
// Canonical formula (matches the battle-tested front-desk.service logic, plus
// the refund leg required by this sprint):
//
//   balanceDue = chargesTotal − paymentsTotal + refundsTotal
//
// where refundsTotal is added back because a refund returns money to the guest,
// re-opening the amount they owe.

export type FolioBalanceBreakdown = {
  chargesTotal: number;
  paymentsTotal: number;
  refundsTotal: number;
  balanceDue: number;
  currency: string;
};

const DEFAULT_CURRENCY = "EUR";

function dec(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyBreakdown(currency = DEFAULT_CURRENCY): FolioBalanceBreakdown {
  return { chargesTotal: 0, paymentsTotal: 0, refundsTotal: 0, balanceDue: 0, currency };
}

// Internal: sum charges / captured payments / refunds for a set of folio IDs in
// a fixed number of queries (no per-folio fan-out). Returns per-folio maps.
async function loadFolioTotals(folioIds: string[]): Promise<{
  chargesByFolio: Map<string, number>;
  paymentsByFolio: Map<string, number>;
  refundsByFolio: Map<string, number>;
}> {
  const chargesByFolio = new Map<string, number>();
  const paymentsByFolio = new Map<string, number>();
  const refundsByFolio = new Map<string, number>();
  if (folioIds.length === 0) {
    return { chargesByFolio, paymentsByFolio, refundsByFolio };
  }

  // Query 1: Σ FolioLine.total grouped by folio.
  // Query 2: captured payments (id + folioId + amount) for these folios — we
  //   need the IDs to join refunds, so we findMany rather than groupBy.
  const [folioLineGroups, capturedPayments] = await Promise.all([
    prisma.folioLine.groupBy({
      by: ["folioId"],
      where: { folioId: { in: folioIds } },
      _sum: { total: true }
    }),
    prisma.payment.findMany({
      where: { folioId: { in: folioIds }, status: "captured" },
      select: { id: true, folioId: true, amount: true }
    })
  ]);

  for (const row of folioLineGroups) {
    chargesByFolio.set(row.folioId, dec(row._sum?.total));
  }

  const folioIdByPaymentId = new Map<string, string>();
  for (const p of capturedPayments) {
    folioIdByPaymentId.set(p.id, p.folioId);
    paymentsByFolio.set(p.folioId, (paymentsByFolio.get(p.folioId) ?? 0) + dec(p.amount));
  }

  // Query 3: Σ PaymentRefund.amount for those captured payments, grouped by
  //   payment, then folded back onto the owning folio.
  const paymentIds = capturedPayments.map((p) => p.id);
  if (paymentIds.length > 0) {
    const refundGroups = await prisma.paymentRefund.groupBy({
      by: ["paymentId"],
      where: { paymentId: { in: paymentIds } },
      _sum: { amount: true }
    });
    for (const row of refundGroups) {
      const folioId = folioIdByPaymentId.get(row.paymentId);
      if (!folioId) continue;
      refundsByFolio.set(folioId, (refundsByFolio.get(folioId) ?? 0) + dec(row._sum?.amount));
    }
  }

  return { chargesByFolio, paymentsByFolio, refundsByFolio };
}

function reduceBreakdown(
  folioIds: string[],
  totals: {
    chargesByFolio: Map<string, number>;
    paymentsByFolio: Map<string, number>;
    refundsByFolio: Map<string, number>;
  },
  currency: string
): FolioBalanceBreakdown {
  let chargesTotal = 0;
  let paymentsTotal = 0;
  let refundsTotal = 0;
  for (const id of folioIds) {
    chargesTotal += totals.chargesByFolio.get(id) ?? 0;
    paymentsTotal += totals.paymentsByFolio.get(id) ?? 0;
    refundsTotal += totals.refundsByFolio.get(id) ?? 0;
  }
  chargesTotal = round2(chargesTotal);
  paymentsTotal = round2(paymentsTotal);
  refundsTotal = round2(refundsTotal);
  return {
    chargesTotal,
    paymentsTotal,
    refundsTotal,
    balanceDue: round2(chargesTotal - paymentsTotal + refundsTotal),
    currency
  };
}

// Single-folio balance breakdown.
export async function computeFolioBalance(folioId: string): Promise<FolioBalanceBreakdown> {
  const folio = await prisma.folio.findUnique({
    where: { id: folioId },
    select: { id: true, currency: true }
  });
  if (!folio) return emptyBreakdown();
  const totals = await loadFolioTotals([folio.id]);
  return reduceBreakdown([folio.id], totals, folio.currency ?? DEFAULT_CURRENCY);
}

// Balance summed across every folio of a reservation.
export async function computeReservationBalance(
  reservationId: string
): Promise<FolioBalanceBreakdown> {
  const folios = await prisma.folio.findMany({
    where: { reservationId },
    select: { id: true, currency: true }
  });
  if (folios.length === 0) return emptyBreakdown();
  const folioIds = folios.map((f) => f.id);
  const totals = await loadFolioTotals(folioIds);
  const currency = folios[0]?.currency ?? DEFAULT_CURRENCY;
  return reduceBreakdown(folioIds, totals, currency);
}

// Batched balanceDue for many reservations at once. Avoids N+1 by issuing a
// fixed query budget regardless of reservation count:
//   1 folio query (in clause) + 1 folioLine groupBy + 1 payment findMany
//   + 1 paymentRefund groupBy, then reducing in memory.
// Returns a Map keyed by reservationId; every requested id is present (0 when
// the reservation has no folios). Values are the rounded balanceDue.
export async function computeBalancesForReservations(
  reservationIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const uniqueIds = Array.from(new Set(reservationIds));
  for (const id of uniqueIds) result.set(id, 0);
  if (uniqueIds.length === 0) return result;

  const folios = await prisma.folio.findMany({
    where: { reservationId: { in: uniqueIds } },
    select: { id: true, reservationId: true }
  });
  if (folios.length === 0) return result;

  const folioIdsByReservation = new Map<string, string[]>();
  for (const f of folios) {
    const list = folioIdsByReservation.get(f.reservationId) ?? [];
    list.push(f.id);
    folioIdsByReservation.set(f.reservationId, list);
  }

  const totals = await loadFolioTotals(folios.map((f) => f.id));

  for (const id of uniqueIds) {
    const folioIds = folioIdsByReservation.get(id) ?? [];
    let charges = 0;
    let payments = 0;
    let refunds = 0;
    for (const folioId of folioIds) {
      charges += totals.chargesByFolio.get(folioId) ?? 0;
      payments += totals.paymentsByFolio.get(folioId) ?? 0;
      refunds += totals.refundsByFolio.get(folioId) ?? 0;
    }
    result.set(id, round2(charges - payments + refunds));
  }

  return result;
}
