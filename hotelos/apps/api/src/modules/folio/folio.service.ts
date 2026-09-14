import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { demoStore, type FolioLineRecord, type FolioRecord, type PaymentRecord, type UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { derivePaymentStatus, type InvoicePaymentStatus } from "../invoicing/invoice.service.js";

// Transitional dual-write helpers; see pms.service.ts for context.
function mirrorFolio(folio: FolioRecord): void {
  const idx = demoStore.folios.findIndex((f) => f.id === folio.id);
  if (idx >= 0) demoStore.folios[idx] = folio;
  else demoStore.folios.push(folio);
}
function mirrorFolioLine(line: FolioLineRecord): void {
  const idx = demoStore.folioLines.findIndex((l) => l.id === line.id);
  if (idx >= 0) demoStore.folioLines[idx] = line;
  else demoStore.folioLines.push(line);
}
function mirrorPayment(payment: PaymentRecord): void {
  const idx = demoStore.payments.findIndex((p) => p.id === payment.id);
  if (idx >= 0) demoStore.payments[idx] = payment;
  else demoStore.payments.push(payment);
}

/** Payment as rendered inside a folio balance: the base record plus what has been refunded on it. */
export type FolioPaymentRecord = InvoicePaymentRecord & {
  /**
   * Σ PaymentRefund.amount recorded against this payment. A fully refunded
   * payment (status "refunded") reports its whole amount even when it predates
   * the PaymentRefund ledger.
   */
  refundedAmount: number;
};

export type FolioBalance = {
  folio: FolioRecord;
  lines: FolioLineRecord[];
  payments: FolioPaymentRecord[];
  chargesTotal: number;
  /**
   * Net cash collected: Σ captured payments − Σ partial refunds on them.
   * Payments with status "refunded" count 0 (and their refund rows are not
   * subtracted again).
   */
  paymentsTotal: number;
  /** Σ partial refunds already subtracted from paymentsTotal (informational). */
  refundsTotal: number;
  balanceDue: number;
};

export type ReservationFolioSummary = {
  id: string;
  label: string | null;
  status: string;
  balanceDue: number;
};

export type ReservationBalance = {
  /** Σ balanceDue over every non-deleted folio of the reservation, open AND closed. */
  balanceDue: number;
  folios: ReservationFolioSummary[];
};

/**
 * GET /reservations/:id/folio payload (REC-08): the PRIMARY folio's balance
 * (unchanged shape) plus the reservation-wide aggregate so check-out and the
 * front-desk drawers see debt parked on secondary folios.
 */
export type ReservationFolioBalance = FolioBalance & {
  reservationBalanceDue: number;
  folios: ReservationFolioSummary[];
};

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

const CENT_TOLERANCE = 0.005;

/** Attach a machine-readable payload to a typed HTTP error (HttpError.details). */
function withDetails<E extends Error & { details?: unknown }>(error: E, details: Record<string, unknown>): E {
  error.details = details;
  return error;
}

/**
 * PaymentRefund rows that reduce the collected cash. The ledger has no other
 * writer today (this module creates "completed" rows); explicit failure
 * statuses are excluded so a bounced PSP refund never lowers the balance.
 */
const REFUND_FAILED_STATUSES = ["failed", "rejected", "cancelled"] as const;

type CountablePayment = { status: string; amount: number; refundedAmount: number };

/**
 * Single reducer behind every "cash collected" figure in this module (folio
 * balance, reservation balance, invoice paid total): only "captured" payments
 * count, and the refunds recorded on them are subtracted. Refunds on payments
 * that are no longer "captured" are ignored because the payment itself
 * already counts 0.
 */
function reduceCapturedCash(payments: ReadonlyArray<CountablePayment>): { gross: number; refunds: number } {
  let gross = 0;
  let refunds = 0;
  for (const payment of payments) {
    if (payment.status !== "captured") continue;
    gross += payment.amount;
    refunds += payment.refundedAmount;
  }
  return { gross, refunds };
}

/** Net cash of a payment set: Σ captured amounts − Σ counted refunds on them. */
export function netCapturedTotal(payments: ReadonlyArray<CountablePayment>): number {
  const { gross, refunds } = reduceCapturedCash(payments);
  return roundCurrency(gross - refunds);
}

/**
 * Pure money-path aggregate shared by getFolioBalance and the tests: charges
 * minus net captured cash (see reduceCapturedCash).
 */
export function aggregateFolioTotals(
  lines: ReadonlyArray<{ total: number }>,
  payments: ReadonlyArray<CountablePayment>
): { chargesTotal: number; paymentsTotal: number; refundsTotal: number; balanceDue: number } {
  const chargesTotal = roundCurrency(lines.reduce((sum, line) => sum + line.total, 0));
  const { gross, refunds } = reduceCapturedCash(payments);
  const refundsTotal = roundCurrency(refunds);
  const paymentsTotal = roundCurrency(gross - refunds);
  return { chargesTotal, paymentsTotal, refundsTotal, balanceDue: roundCurrency(chargesTotal - paymentsTotal) };
}

type RefundSumClient = Pick<typeof prisma, "paymentRefund"> | Prisma.TransactionClient;
/** Client able to read payments + refunds (+ invoices): the root client or an interactive transaction. */
type MoneyClient = Pick<typeof prisma, "payment" | "paymentRefund" | "invoice"> | Prisma.TransactionClient;

/** Σ counted PaymentRefund.amount per payment id (payments without refunds are absent from the map). */
async function sumRefundsByPayment(client: RefundSumClient, paymentIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (paymentIds.length === 0) return out;
  const groups = await client.paymentRefund.groupBy({
    by: ["paymentId"],
    where: { paymentId: { in: paymentIds }, status: { notIn: [...REFUND_FAILED_STATUSES] } },
    _sum: { amount: true }
  });
  for (const group of groups) out.set(group.paymentId, roundCurrency(dec(group._sum.amount)));
  return out;
}

function withRefundedAmount<P extends PaymentRecord>(payment: P, refunded: number | undefined): P & { refundedAmount: number } {
  // A "refunded" payment predating the PaymentRefund ledger has no rows: it is
  // still fully returned by definition of its status.
  const refundedAmount = payment.status === "refunded" ? Math.max(refunded ?? 0, payment.amount) : refunded ?? 0;
  return { ...payment, refundedAmount: roundCurrency(refundedAmount) };
}

function mapFolio(row: NonNullable<Awaited<ReturnType<typeof prisma.folio.findUnique>>>): FolioRecord {
  return {
    id: row.id,
    reservationId: row.reservationId,
    guestId: row.guestId ?? undefined,
    status: row.status,
    currency: row.currency
  };
}

function mapLine(row: NonNullable<Awaited<ReturnType<typeof prisma.folioLine.findUnique>>>): FolioLineRecord {
  return {
    id: row.id,
    folioId: row.folioId,
    type: row.type as FolioLineRecord["type"],
    description: row.description,
    quantity: dec(row.quantity),
    unitPrice: dec(row.unitPrice),
    taxCode: row.taxCode ?? undefined,
    total: dec(row.total),
    postedAt: row.postedAt.toISOString(),
    postedBy: row.postedBy ?? undefined
  };
}

type PaymentRow = NonNullable<Awaited<ReturnType<typeof prisma.payment.findUnique>>>;

/**
 * Base API shape of a payment. Always carries `invoiceId` (null when the
 * payment is not linked to an invoice) so refund / folio / mark-paid
 * responses agree on the link — a refund response must not report
 * `invoiceId: null` for a payment whose row is linked.
 */
function mapPayment(row: PaymentRow): InvoicePaymentRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    folioId: row.folioId,
    invoiceId: row.invoiceId ?? null,
    amount: dec(row.amount),
    currency: row.currency,
    method: row.method as PaymentRecord["method"],
    pspReference: row.pspReference ?? undefined,
    status: row.status,
    createdAt: row.createdAt.toISOString()
  };
}

// Folio has no createdAt column; cuid ids are time-sortable, so `id asc` is
// the "oldest folio" fallback when no folio is flagged primary. Deleted folios
// never take part in balances.
const RESERVATION_FOLIO_ORDER: Prisma.FolioOrderByWithRelationInput[] = [{ isPrimary: "desc" }, { id: "asc" }];

type ReservationFolioEntry = {
  row: { id: string; label: string; status: string; isPrimary: boolean };
  balance: FolioBalance;
};

/** Every non-deleted folio of the reservation (primary first) with its balance. */
async function loadReservationFolioBalances(reservationId: string): Promise<ReservationFolioEntry[]> {
  // Hot-fix: cap defensively. A reservation has at most a handful of folios.
  const rows = await prisma.folio.findMany({
    where: { reservationId, deletedAt: null },
    orderBy: RESERVATION_FOLIO_ORDER,
    select: { id: true, label: true, status: true, isPrimary: true },
    take: 50
  });
  const balances = await Promise.all(rows.map((row) => getFolioBalance(row.id)));
  return rows.map((row, index) => ({ row, balance: balances[index]! }));
}

function summarizeReservationFolios(entries: ReservationFolioEntry[]): ReservationBalance {
  const folios = entries.map(({ row, balance }) => ({
    id: row.id,
    label: row.label ?? null,
    status: row.status,
    balanceDue: balance.balanceDue
  }));
  return { balanceDue: roundCurrency(folios.reduce((sum, f) => sum + f.balanceDue, 0)), folios };
}

/**
 * Reservation-wide debt (REC-08). Aggregates getFolioBalance over ALL
 * non-deleted folios — open and closed alike: a closed folio that still
 * carries a balance is still money owed. A reservation without folios owes 0.
 */
export async function getReservationBalance(
  reservationId: string
): Promise<{ balanceDue: number; folios: Array<{ id: string; label: string | null; status: string; balanceDue: number }> }> {
  return summarizeReservationFolios(await loadReservationFolioBalances(reservationId));
}

/**
 * Balance of the reservation's PRIMARY folio (isPrimary, else the oldest)
 * plus `reservationBalanceDue` / `folios[]` covering every folio (REC-08).
 */
export async function getReservationFolio(reservationId: string): Promise<ReservationFolioBalance> {
  const entries = await loadReservationFolioBalances(reservationId);
  const primary = entries[0];
  if (!primary) {
    throw new NotFoundError("Folio was not found.");
  }
  const reservation = summarizeReservationFolios(entries);
  return { ...primary.balance, reservationBalanceDue: reservation.balanceDue, folios: reservation.folios };
}

export async function getFolioBalance(folioId: string): Promise<FolioBalance> {
  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio || folio.deletedAt) {
    throw new NotFoundError("Folio was not found.");
  }
  const [lineRows, paymentRows] = await Promise.all([
    // Hot-fix: cap defensively. A folio has at most a few hundred lines/payments.
    // Soft-deleted lines and payments never count towards the balance.
    prisma.folioLine.findMany({ where: { folioId: folio.id, deletedAt: null }, orderBy: { postedAt: "asc" }, take: 500 }),
    prisma.payment.findMany({ where: { folioId: folio.id, deletedAt: null }, orderBy: { createdAt: "asc" }, take: 500 })
  ]);
  const refundedByPayment = await sumRefundsByPayment(prisma, paymentRows.map((row) => row.id));

  const lines = lineRows.map(mapLine);
  const payments = paymentRows.map((row) => withRefundedAmount(mapPayment(row), refundedByPayment.get(row.id)));

  return {
    folio: mapFolio(folio),
    lines,
    payments,
    ...aggregateFolioTotals(lines, payments)
  };
}

export async function postFolioLine(input: {
  context: UserContext;
  folioId: string;
  type: FolioLineRecord["type"];
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode?: string;
  correlationId: string;
}): Promise<FolioLineRecord> {
  requirePermissions(input.context, ["folio.charge.post"]);

  const folio = await getOpenFolio(input.folioId);
  const propertyId = await resolveFolioPropertyId(input.folioId);
  const total = roundCurrency(input.quantity * input.unitPrice);

  const created = await prisma.folioLine.create({
    data: {
      folioId: folio.id,
      type: input.type,
      description: input.description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      taxCode: input.taxCode ?? null,
      total,
      postedBy: input.context.userId
    }
  });
  // Auto-route the new line if any FolioRoutingRule on the reservation
  // matches its type and the line landed on the primary folio. This is the
  // "F&B goes to company folio" pattern every PMS implements.
  try {
    const { routeLine } = await import("./folio-routing.service.js");
    // routeLine reports a closed/missing target itself (audit + console) and
    // leaves the line on the origin folio; only unexpected errors land here.
    await routeLine({ lineId: created.id, context: input.context, correlationId: input.correlationId });
  } catch (error) {
    // Routing is best-effort: a failure must never block the underlying post,
    // but it must be visible (QC-06) — the charge may have stayed on the
    // wrong folio.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[folio.routing] auto-routing failed for line ${created.id} on folio ${folio.id} (correlationId ${input.correlationId}): ${message}`
    );
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action: "FOLIO_ROUTING_FAILED",
      entityType: "folio_line",
      entityId: created.id,
      afterJson: { lineId: created.id, folioId: folio.id, lineType: input.type, error: message },
      correlationId: input.correlationId
    });
  }
  const finalLine = await prisma.folioLine.findUnique({ where: { id: created.id } });
  const line = mapLine(finalLine ?? created);
  mirrorFolioLine(line);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FOLIO_CHARGE_POSTED",
    entityType: "folio_line",
    entityId: line.id,
    afterJson: line,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId,
    entityType: "folio",
    entityId: folio.id,
    eventType: "ChargePosted",
    payload: { lineId: line.id, total: line.total, type: line.type },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return line;
}

export async function postPayment(input: {
  context: UserContext;
  folioId: string;
  amount: number;
  currency?: string;
  method: PaymentRecord["method"];
  pspReference?: string;
  correlationId: string;
}): Promise<PaymentRecord> {
  requirePermissions(input.context, ["payment.capture"]);

  const folio = await getOpenFolio(input.folioId);
  const propertyId = await resolveFolioPropertyId(input.folioId);
  if (input.amount <= 0) {
    throw new BadRequestError("El importe del cobro debe ser positivo.");
  }

  const created = await prisma.payment.create({
    data: {
      propertyId,
      folioId: folio.id,
      amount: roundCurrency(input.amount),
      currency: input.currency ?? folio.currency,
      method: input.method,
      pspReference: input.pspReference ?? null,
      status: "captured"
    }
  });
  const payment = mapPayment(created);
  mirrorPayment(payment);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYMENT_CAPTURED",
    entityType: "payment",
    entityId: payment.id,
    afterJson: payment,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId,
    entityType: "payment",
    entityId: payment.id,
    eventType: "PaymentCaptured",
    payload: { folioId: folio.id, amount: payment.amount, method: payment.method },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return payment;
}

export type PaymentRefundRecord = {
  id: string;
  paymentId: string;
  amount: number;
  status: string;
  requiresApproval: boolean;
  approvedBy: string | null;
  providerReference: string | null;
  createdAt: string;
};

/** Payment returned by refundPayment: base record (with its invoice link) plus its refund ledger. */
export type RefundedPaymentRecord = InvoicePaymentRecord & {
  refundedAmount: number;
  refunds: PaymentRefundRecord[];
};

/**
 * True when the net cash collected on an invoice no longer covers its total,
 * i.e. Invoice.paidAt must be cleared (a refund re-opened the balance).
 */
export function invoiceUnsettled(invoiceTotal: number, netPaid: number): boolean {
  return netPaid + CENT_TOLERANCE < invoiceTotal;
}

/**
 * Re-derive Invoice.paidAt after a refund on one of its linked payments:
 * paidAt is cleared when the net collected cash (captured − refunds, the same
 * rule as getFolioBalance) drops below the invoice total, and left untouched
 * while the invoice is still settled. Returns the resulting paidAt.
 */
async function syncInvoicePaidAtAfterRefund(tx: Prisma.TransactionClient, invoiceId: string): Promise<Date | null> {
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { total: true, paidAt: true } });
  if (!invoice || !invoice.paidAt) return invoice?.paidAt ?? null;
  const netPaid = await linkedPaidTotal(tx, invoiceId);
  if (!invoiceUnsettled(roundCurrency(dec(invoice.total)), netPaid)) return invoice.paidAt;
  await tx.invoice.update({ where: { id: invoiceId }, data: { paidAt: null } });
  return null;
}

export type RefundPlan = {
  /** Amount this refund returns to the guest (rounded to the cent). */
  amount: number;
  /** True when the refund settles everything still pending on the payment. */
  full: boolean;
  /** Amount still refundable BEFORE this refund. */
  pending: number;
};

/**
 * Pure decision for a (partial) refund. `requested` undefined means "refund
 * everything still pending"; a requested amount equal to the pending amount
 * (within a cent) is also a full refund.
 *  - pending ≤ 0            → 409 (already fully refunded)
 *  - requested ≤ 0 / NaN    → 400
 *  - requested > pending    → 400
 */
export function planRefund(input: { paymentAmount: number; refundedBefore: number; requested?: number }): RefundPlan {
  const pending = roundCurrency(input.paymentAmount - input.refundedBefore);
  if (pending <= CENT_TOLERANCE) {
    throw new ConflictError("El cobro ya está devuelto por completo.");
  }
  const amount = roundCurrency(input.requested ?? pending);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestError("El importe a devolver debe ser positivo.");
  }
  if (amount > pending + CENT_TOLERANCE) {
    throw new BadRequestError(
      `El importe a devolver (${amount.toFixed(2)} €) supera el pendiente de devolución del cobro (${pending.toFixed(2)} €).`
    );
  }
  return { amount, full: Math.abs(pending - amount) < CENT_TOLERANCE, pending };
}

function mapRefund(row: NonNullable<Awaited<ReturnType<typeof prisma.paymentRefund.findUnique>>>): PaymentRefundRecord {
  return {
    id: row.id,
    paymentId: row.paymentId,
    amount: dec(row.amount),
    status: row.status,
    requiresApproval: row.requiresApproval,
    approvedBy: row.approvedBy ?? null,
    providerReference: row.providerReference ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

async function loadRefundedPayment(paymentId: string): Promise<RefundedPaymentRecord> {
  const [row, refundRows] = await Promise.all([
    prisma.payment.findUnique({ where: { id: paymentId } }),
    prisma.paymentRefund.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } })
  ]);
  if (!row) throw new NotFoundError("Pago no encontrado.");
  const refunds = refundRows.map(mapRefund);
  const counted = refunds
    .filter((r) => !(REFUND_FAILED_STATUSES as readonly string[]).includes(r.status))
    .reduce((sum, r) => sum + r.amount, 0);
  return { ...withRefundedAmount(mapPayment(row), counted), refunds };
}

/**
 * Refund a captured payment, fully or partially.
 *  - `amount` omitted or equal to what is still pending → full refund: the
 *    payment flips to "refunded" and a PaymentRefund row records the amount.
 *  - 0 < amount < pending → partial refund: a PaymentRefund row is created and
 *    the payment STAYS "captured" (PaymentStatus has no partially_refunded
 *    value); getFolioBalance subtracts the refund ledger from the payment.
 *  - amount > pending (payment.amount − previous refunds) or ≤ 0 → 400.
 * The pending check and the status flip run inside one transaction so a
 * double click cannot over-refund.
 */
export async function refundPayment(input: {
  context: UserContext;
  paymentId: string;
  reason: string;
  /** Partial refund amount; omitted → refund everything still pending on the payment. */
  amount?: number;
  correlationId: string;
}): Promise<RefundedPaymentRecord> {
  requirePermissions(input.context, ["payment.refund", "ai.high_risk.confirm"]);

  const existing = await prisma.payment.findUnique({ where: { id: input.paymentId } });
  if (!existing || existing.deletedAt) {
    throw new NotFoundError("Pago no encontrado.");
  }
  if (existing.status !== "captured") {
    throw new ConflictError(
      existing.status === "refunded"
        ? "El cobro ya está devuelto por completo."
        : "Solo se pueden devolver cobros capturados."
    );
  }
  if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount <= 0)) {
    throw new BadRequestError("El importe a devolver debe ser positivo.");
  }

  const before = mapPayment(existing);
  const { plan, refund, invoicePaidAt } = await prisma.$transaction(async (tx) => {
    const refundedBefore = (await sumRefundsByPayment(tx, [existing.id])).get(existing.id) ?? 0;
    const plan = planRefund({ paymentAmount: dec(existing.amount), refundedBefore, requested: input.amount });
    const refund = await tx.paymentRefund.create({
      data: {
        paymentId: existing.id,
        amount: plan.amount,
        status: "completed",
        requiresApproval: false,
        approvedBy: input.context.userId
      }
    });
    if (plan.full) {
      // Conditional flip: a concurrent full refund of the same payment loses
      // here and the whole transaction (refund row included) rolls back.
      const flipped = await tx.payment.updateMany({
        where: { id: existing.id, status: "captured", deletedAt: null },
        data: { status: "refunded" }
      });
      if (flipped.count === 0) {
        throw new ConflictError("El cobro ya ha sido devuelto por otro usuario.");
      }
    }
    // A payment linked to an invoice (markInvoicePaid) stamped Invoice.paidAt
    // when it settled the balance; giving cash back re-opens that balance, so
    // paidAt is re-derived in the same transaction as the refund row.
    const invoicePaidAt = existing.invoiceId ? await syncInvoicePaidAtAfterRefund(tx, existing.invoiceId) : null;
    return { plan, refund: mapRefund(refund), invoicePaidAt };
  });

  const after = await loadRefundedPayment(existing.id);
  mirrorPayment({ ...before, status: after.status });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: after.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYMENT_REFUNDED",
    entityType: "payment",
    entityId: after.id,
    beforeJson: before,
    afterJson: {
      ...after,
      refundId: refund.id,
      amount: plan.amount,
      partial: !plan.full,
      reason: input.reason,
      invoicePaidAt: existing.invoiceId ? invoicePaidAt?.toISOString() ?? null : undefined
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: after.propertyId,
    entityType: "payment",
    entityId: after.id,
    eventType: "PaymentRefunded",
    payload: {
      folioId: after.folioId,
      paymentId: after.id,
      refundId: refund.id,
      amount: plan.amount,
      method: after.method,
      partial: !plan.full,
      reason: input.reason
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

export async function closeFolio(input: {
  context: UserContext;
  folioId: string;
  correlationId: string;
}): Promise<FolioRecord> {
  const folio = await getOpenFolio(input.folioId);
  const balance = await getFolioBalance(folio.id);

  // Tolerate sub-cent rounding noise (and a tiny credit) rather than a strict !== 0.
  if (Math.abs(balance.balanceDue) >= 0.005) {
    throw new BadRequestError(`Folio cannot be closed with balance due ${balance.balanceDue}.`);
  }

  const before = balance.folio;
  const updated = await prisma.folio.update({
    where: { id: folio.id },
    data: { status: "closed" }
  });
  const after = mapFolio(updated);
  mirrorFolio(after);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FOLIO_CLOSED",
    entityType: "folio",
    entityId: after.id,
    beforeJson: before,
    afterJson: after,
    correlationId: input.correlationId
  });

  return after;
}

async function getOpenFolio(folioId: string): Promise<FolioRecord> {
  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio || folio.deletedAt) {
    throw new NotFoundError("El folio no existe.");
  }
  if (folio.status !== "open") {
    throw new ConflictError("El folio está cerrado; no admite más cargos ni movimientos.");
  }
  return mapFolio(folio);
}

async function resolveFolioPropertyId(folioId: string): Promise<string> {
  const folio = await prisma.folio.findUnique({
    where: { id: folioId },
    select: { reservationId: true }
  });
  if (!folio) throw new Error("Folio was not found.");
  const reservation = await prisma.reservation.findUnique({
    where: { id: folio.reservationId },
    select: { propertyId: true }
  });
  if (!reservation) throw new Error("Reservation for folio was not found.");
  return reservation.propertyId;
}

// ---------------------------------------------------------------------------
// Advanced folio/billing operations (Sprint 40 — folio split, charge moves,
// invoice mark-paid, send-by-email). Models the patterns every PMS implements
// (Cloudbeds folio split, Opera routing, RoomMaster move-lines) but keeps
// them idempotent so AI agents / retries cannot duplicate state.
// ---------------------------------------------------------------------------

export type SplitFolioInput = {
  context: UserContext;
  sourceFolioId: string;
  newFolio: {
    label: string;
    guestId?: string | null;
    currency?: string;
  };
  /** Charges to move out of the source folio into the new one. */
  moveChargeIds: string[];
  /** When true (default), keep the source folio open after the split. */
  keepInOriginal?: boolean;
  correlationId: string;
};

export type SplitFolioResult = {
  sourceFolio: FolioRecord;
  newFolio: FolioRecord;
  movedChargeIds: string[];
  idempotent: boolean;
};

/**
 * Split a folio: create a NEW sibling folio on the same reservation and move
 * the requested charges into it. Idempotent — repeated calls with the same
 * (sourceFolioId, sorted chargeIds, label) return the previously-created
 * folio instead of generating a duplicate. Mirrors the Cloudbeds "split
 * folio" UX and the Opera "transfer to window" workflow.
 *
 *  - All chargeIds MUST belong to the source folio (rejected otherwise).
 *  - The new folio is created on the SAME reservation as the source folio.
 *  - When `keepInOriginal=false`, the source folio is closed at the end (only
 *    if its remaining balance settles to ~0; mirrors `closeFolio`'s rule).
 */
export async function splitFolio(input: SplitFolioInput): Promise<SplitFolioResult> {
  requirePermissions(input.context, ["folio.charge.post"]);

  const source = await prisma.folio.findUnique({ where: { id: input.sourceFolioId } });
  if (!source) throw new NotFoundError("Source folio was not found.");
  if (source.status !== "open") {
    throw new BadRequestError("Source folio must be open to split.");
  }
  const label = input.newFolio.label?.trim();
  if (!label) throw new BadRequestError("newFolio.label is required.");

  const moveIds = Array.from(new Set(input.moveChargeIds ?? [])).sort();
  if (moveIds.length === 0) {
    throw new BadRequestError("At least one chargeId is required to split.");
  }

  // Idempotency: if an open folio on the same reservation already carries the
  // requested label AND every requested charge already lives on it, return it.
  const existingSibling = await prisma.folio.findFirst({
    where: {
      reservationId: source.reservationId,
      label,
      id: { not: source.id },
      status: "open"
    }
  });
  if (existingSibling) {
    const linesOnSibling = await prisma.folioLine.findMany({
      where: { id: { in: moveIds }, folioId: existingSibling.id },
      select: { id: true }
    });
    if (linesOnSibling.length === moveIds.length) {
      return {
        sourceFolio: mapFolio(source),
        newFolio: mapFolio(existingSibling),
        movedChargeIds: moveIds,
        idempotent: true
      };
    }
  }

  // Validate charges belong to the source folio.
  const lineRows = await prisma.folioLine.findMany({
    where: { id: { in: moveIds } },
    select: { id: true, folioId: true }
  });
  const foreign = lineRows.find((l) => l.folioId !== source.id);
  if (foreign) {
    throw new BadRequestError(
      `Charge ${foreign.id} does not belong to source folio ${source.id}.`
    );
  }
  if (lineRows.length !== moveIds.length) {
    throw new NotFoundError("One or more charges were not found.");
  }

  const propertyId = await resolveFolioPropertyId(source.id);

  // Create the sibling + move lines in a single transaction.
  const result = await prisma.$transaction(async (tx) => {
    const created = existingSibling ?? await tx.folio.create({
      data: {
        reservationId: source.reservationId,
        guestId: input.newFolio.guestId ?? null,
        status: "open",
        currency: input.newFolio.currency ?? source.currency,
        label,
        isPrimary: false
      }
    });
    if (moveIds.length > 0) {
      await tx.folioLine.updateMany({
        where: { id: { in: moveIds }, folioId: source.id },
        data: { folioId: created.id }
      });
    }
    return created;
  });

  // Optional close of source folio when caller requested keepInOriginal=false.
  let finalSource = source;
  if (input.keepInOriginal === false) {
    const remaining = await getFolioBalance(source.id);
    if (Math.abs(remaining.balanceDue) < 0.005) {
      const closed = await prisma.folio.update({ where: { id: source.id }, data: { status: "closed" } });
      finalSource = closed;
    }
  }

  // Mirror cache + audit.
  mirrorFolio(mapFolio(result));
  mirrorFolio(mapFolio(finalSource));

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FOLIO_SPLIT",
    entityType: "folio",
    entityId: result.id,
    afterJson: {
      sourceFolioId: source.id,
      newFolioId: result.id,
      label,
      movedChargeIds: moveIds,
      keepInOriginal: input.keepInOriginal !== false
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId,
    entityType: "folio",
    entityId: result.id,
    eventType: "FolioSplit",
    payload: { sourceFolioId: source.id, newFolioId: result.id, movedCount: moveIds.length },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return {
    sourceFolio: mapFolio(finalSource),
    newFolio: mapFolio(result),
    movedChargeIds: moveIds,
    idempotent: false
  };
}

export type MoveChargesInput = {
  context: UserContext;
  sourceFolioId: string;
  targetFolioId: string;
  chargeIds: string[];
  correlationId: string;
};

export type MoveChargesResult = {
  sourceFolioId: string;
  targetFolioId: string;
  movedChargeIds: string[];
  skippedChargeIds: string[];
};

/**
 * Move folio charges (lines) from one folio to another. Both folios must
 * belong to the SAME reservation and the target must be open. Lines already
 * present on the target are skipped (idempotent). Used as the data-side
 * primitive behind the drag-drop UX in folio split views.
 */
export async function moveChargesBetweenFolios(input: MoveChargesInput): Promise<MoveChargesResult> {
  requirePermissions(input.context, ["folio.charge.post"]);

  if (!input.chargeIds || input.chargeIds.length === 0) {
    throw new BadRequestError("chargeIds is required.");
  }
  if (input.sourceFolioId === input.targetFolioId) {
    throw new BadRequestError("sourceFolioId and targetFolioId must differ.");
  }
  const [source, target] = await Promise.all([
    prisma.folio.findUnique({ where: { id: input.sourceFolioId } }),
    prisma.folio.findUnique({ where: { id: input.targetFolioId } })
  ]);
  if (!source) throw new NotFoundError("Source folio was not found.");
  if (!target) throw new NotFoundError("Target folio was not found.");
  if (target.status !== "open") {
    throw new BadRequestError("Target folio must be open.");
  }
  if (source.reservationId !== target.reservationId) {
    throw new BadRequestError("Source and target folios must share a reservation.");
  }

  const requested = Array.from(new Set(input.chargeIds));
  const lines = await prisma.folioLine.findMany({
    where: { id: { in: requested } },
    select: { id: true, folioId: true }
  });
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    if (line.folioId === target.id) {
      // Already on the target — idempotent skip.
      skipped.push(line.id);
    } else if (line.folioId === source.id) {
      moved.push(line.id);
    } else {
      throw new BadRequestError(
        `Charge ${line.id} does not belong to source folio ${source.id}.`
      );
    }
  }
  // Anything not found in the DB is treated as a skip rather than a failure
  // so a retried request stays idempotent even after a partial replay.
  const foundIds = new Set(lines.map((l) => l.id));
  for (const id of requested) {
    if (!foundIds.has(id)) skipped.push(id);
  }

  if (moved.length > 0) {
    await prisma.folioLine.updateMany({
      where: { id: { in: moved }, folioId: source.id },
      data: { folioId: target.id }
    });
  }

  const propertyId = await resolveFolioPropertyId(source.id);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FOLIO_CHARGES_MOVED",
    entityType: "folio",
    entityId: target.id,
    afterJson: {
      sourceFolioId: source.id,
      targetFolioId: target.id,
      movedChargeIds: moved,
      skippedChargeIds: skipped
    },
    correlationId: input.correlationId
  });

  return {
    sourceFolioId: source.id,
    targetFolioId: target.id,
    movedChargeIds: moved,
    skippedChargeIds: skipped
  };
}

export type MarkInvoicePaidInput = {
  context: UserContext;
  invoiceId: string;
  method?: PaymentRecord["method"];
  pspReference?: string;
  amount?: number;
  correlationId: string;
};

export type InvoicePaymentRecord = PaymentRecord & { invoiceId: string | null };

export type MarkInvoicePaidResult = {
  invoiceId: string;
  payment: InvoicePaymentRecord;
  paidAmount: number;
  invoiceTotal: number;
  alreadyPaid: boolean;
  /** Net cash linked to the invoice after this call: Σ captured payments − Σ refunds on them. */
  paidTotal: number;
  balanceDue: number;
  paymentStatus: InvoicePaymentStatus;
  paidAt: string | null;
};

/**
 * Net cash collected on an invoice through its linked payments, with the SAME
 * arithmetic as getFolioBalance (captured − counted PaymentRefund rows), so a
 * refunded capture re-opens the invoice balance instead of staying "paid".
 */
async function linkedPaidTotal(client: MoneyClient, invoiceId: string): Promise<number> {
  // Hot-fix: cap defensively. An invoice has a handful of linked payments.
  const rows = await client.payment.findMany({
    where: { invoiceId, status: "captured", deletedAt: null },
    select: { id: true, amount: true, status: true },
    take: 500
  });
  const refundedByPayment = await sumRefundsByPayment(client, rows.map((row) => row.id));
  return netCapturedTotal(
    rows.map((row) => ({ status: row.status, amount: dec(row.amount), refundedAmount: refundedByPayment.get(row.id) ?? 0 }))
  );
}

export type InvoiceCollectionPlan =
  | { alreadySettled: true; balanceBefore: 0 }
  | { alreadySettled: false; balanceBefore: number; settledAfter: boolean };

/**
 * Pure decision for collecting `amount` on an invoice whose net paid total is
 * `paidBefore` (captured − refunds):
 *  - paidBefore ≥ total (within a cent) → alreadySettled (caller answers
 *    alreadyPaid=true instead of inserting another capture)
 *  - amount > total − paidBefore         → 409 AMOUNT_EXCEEDS_BALANCE
 *  - otherwise                            → collect; settledAfter tells the
 *    caller whether to stamp Invoice.paidAt.
 */
export function planInvoiceCollection(input: { invoiceTotal: number; paidBefore: number; amount: number }): InvoiceCollectionPlan {
  if (input.paidBefore + CENT_TOLERANCE >= input.invoiceTotal) return { alreadySettled: true, balanceBefore: 0 };
  const balanceBefore = roundCurrency(input.invoiceTotal - input.paidBefore);
  if (input.amount > balanceBefore + CENT_TOLERANCE) {
    throw withDetails(
      new ConflictError(
        `El importe (${input.amount.toFixed(2)} €) supera el saldo pendiente de la factura (${balanceBefore.toFixed(2)} €).`
      ),
      { code: "AMOUNT_EXCEEDS_BALANCE", amount: input.amount, balanceDue: balanceBefore }
    );
  }
  return {
    alreadySettled: false,
    balanceBefore,
    settledAfter: input.paidBefore + input.amount + CENT_TOLERANCE >= input.invoiceTotal
  };
}

// Namespace of the per-invoice advisory lock taken by markInvoicePaid
// (pg_advisory_xact_lock(hashtext(scope), hashtext(invoiceId))).
const MARK_PAID_LOCK_SCOPE = "invoice.mark-paid";

type CollectOutcome =
  | { kind: "existing"; row: PaymentRow }
  | { kind: "created"; row: PaymentRow; paidBefore: number };

/**
 * Mark an invoice as paid by recording a captured Payment on the invoice's OWN
 * folio (Invoice.folioId, FISC-04) linked back through Payment.invoiceId.
 *
 * Idempotent by (invoiceId, pspReference): Payment.pspReference is stored as
 * AES-GCM ciphertext, so the equality lookup is served by the deterministic
 * `pspReferenceLookupHash` sibling (LOOKUP_HASH_FIELDS.Payment — the client
 * extension rewrites the where and fills the hash on create). Without a
 * pspReference an invoice whose net linked cash already covers the total
 * answers alreadyPaid=true and an amount above the balance due is refused
 * (409) so a double click cannot over-collect. Invoice.paidAt is stamped when
 * the balance reaches zero. Only issued invoices accept collections: a draft
 * is refused (409 INVOICE_NOT_ISSUED) so it can never show up as "paid".
 *
 * Concurrency: the idempotency lookup, the balance check and the insert run
 * inside one transaction under a per-invoice advisory lock, so two
 * simultaneous calls with the same pspReference (or two partial collections
 * racing past the balance) serialize — the second one sees the first's row
 * after its commit and returns it with alreadyPaid=true. Residual window: the
 * lock is per invoice, so the same pspReference posted against two DIFFERENT
 * invoices is not deduplicated (that would need a unique index on the hash,
 * i.e. a migration, and is not a retry scenario). Legacy rows whose hash is
 * still null are invisible to the lookup until backfill:payment-hash runs.
 *
 * The `InvoiceStatus` enum is intentionally narrow (draft/issued/cancelled/
 * rectified); accounting "paid" status is derived from captured payments
 * rather than a mutated enum value.
 */
export async function markInvoicePaid(input: MarkInvoicePaidInput): Promise<MarkInvoicePaidResult> {
  requirePermissions(input.context, ["payment.capture"]);

  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new NotFoundError("Factura no encontrada.");
  if (invoice.status === "cancelled" || invoice.status === "rectified") {
    throw new ConflictError(
      invoice.status === "cancelled"
        ? "La factura está anulada; no admite cobros."
        : "La factura ha sido rectificada; registra el cobro sobre la rectificativa."
    );
  }
  if (invoice.status === "draft") {
    throw withDetails(new ConflictError("La factura no está emitida; emítela antes de registrar el cobro."), {
      code: "INVOICE_NOT_ISSUED",
      invoiceId: invoice.id,
      status: invoice.status
    });
  }
  // Manual drafts (POST /invoices/drafts) have no folio: Payment.folioId is
  // mandatory, so the invoice must be linked to a folio before collecting.
  if (!invoice.folioId) {
    throw new ConflictError("La factura no está vinculada a ningún folio; no se puede registrar el cobro.");
  }
  const folio = await prisma.folio.findUnique({ where: { id: invoice.folioId } });
  if (!folio) {
    throw new ConflictError("El folio vinculado a la factura ya no existe; no se puede registrar el cobro.");
  }

  const invoiceTotal = roundCurrency(dec(invoice.total));
  if (invoiceTotal <= 0) {
    throw new ConflictError("La factura no tiene importe positivo que cobrar.");
  }
  const amount = roundCurrency(input.amount ?? invoiceTotal);
  if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError("El importe del cobro debe ser positivo.");

  const pspReference = input.pspReference?.trim() || null;
  const finish = async (payment: InvoicePaymentRecord, alreadyPaid: boolean): Promise<MarkInvoicePaidResult> => {
    const paidTotal = await linkedPaidTotal(prisma, invoice.id);
    const paymentStatus = derivePaymentStatus(invoice.status, invoiceTotal, paidTotal);
    const current = await prisma.invoice.findUnique({ where: { id: invoice.id }, select: { paidAt: true } });
    return {
      invoiceId: invoice.id,
      payment,
      paidAmount: payment.amount,
      invoiceTotal,
      alreadyPaid,
      paidTotal,
      balanceDue: roundCurrency(Math.max(invoiceTotal - paidTotal, 0)),
      paymentStatus,
      paidAt: current?.paidAt?.toISOString() ?? null
    };
  };

  const outcome = await prisma.$transaction(async (tx): Promise<CollectOutcome> => {
    // Serialize every collection on this invoice (see the docblock). Same
    // pattern as pms.service (pg_advisory_xact_lock via $executeRaw); the
    // lock is released with the transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${MARK_PAID_LOCK_SCOPE}), hashtext(${invoice.id}))`;

    // Idempotency by (invoiceId, pspReference): the PSP already told us about
    // this capture. Any non-deleted status counts — a capture that was later
    // refunded is still "already registered"; re-posting its reference must
    // not create a second capture.
    if (pspReference) {
      const existing = await tx.payment.findFirst({
        where: { invoiceId: invoice.id, pspReference, deletedAt: null },
        orderBy: { createdAt: "desc" }
      });
      if (existing) return { kind: "existing", row: existing };
    }

    const paidBefore = await linkedPaidTotal(tx, invoice.id);
    const plan = planInvoiceCollection({ invoiceTotal, paidBefore, amount });
    if (plan.alreadySettled) {
      // Already settled: return the latest linked payment instead of creating another.
      const last = await tx.payment.findFirst({
        where: { invoiceId: invoice.id, status: "captured", deletedAt: null },
        orderBy: { createdAt: "desc" }
      });
      if (last) return { kind: "existing", row: last };
      // paidBefore ≥ total > 0 implies at least one captured linked payment.
      throw new ConflictError("La factura ya está cobrada.");
    }

    const row = await tx.payment.create({
      data: {
        propertyId: invoice.propertyId,
        folioId: folio.id,
        invoiceId: invoice.id,
        amount,
        currency: invoice.currencyCode ?? folio.currency ?? "EUR",
        method: input.method ?? "bank_transfer",
        pspReference,
        status: "captured"
      }
    });
    if (plan.settledAfter) {
      await tx.invoice.update({ where: { id: invoice.id }, data: { paidAt: row.createdAt } });
    }
    return { kind: "created", row, paidBefore };
  });

  if (outcome.kind === "existing") return finish(mapPayment(outcome.row), true);

  const { paidBefore } = outcome;
  const payment = mapPayment(outcome.row);
  mirrorPayment(payment);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: invoice.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_MARKED_PAID",
    entityType: "invoice",
    entityId: invoice.id,
    afterJson: {
      paymentId: payment.id,
      folioId: folio.id,
      amount: payment.amount,
      method: payment.method,
      pspReference: payment.pspReference,
      paidTotal: roundCurrency(paidBefore + amount),
      invoiceTotal
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: invoice.propertyId,
    entityType: "invoice",
    entityId: invoice.id,
    eventType: "InvoiceMarkedPaid",
    payload: { paymentId: payment.id, folioId: folio.id, amount: payment.amount, invoiceTotal },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return finish(payment, false);
}

export type SendInvoiceByEmailInput = {
  context: UserContext;
  invoiceId: string;
  recipient: string;
  subject?: string;
  message?: string;
  correlationId: string;
};

export type SendInvoiceByEmailResult = {
  acknowledged: true;
  recipient: string;
  invoiceId: string;
  sentAt: string;
};

/**
 * Acknowledge an invoice-by-email send request. Does NOT dispatch a real
 * email — that is delegated to the messaging worker. Records an audit event
 * (which doubles as the send log) and a domain event so downstream listeners
 * can pick up the actual delivery. Returns `acknowledged: true` plus the
 * recipient address so the caller can render a confirmation UI.
 */
export async function sendInvoiceByEmail(input: SendInvoiceByEmailInput): Promise<SendInvoiceByEmailResult> {
  requirePermissions(input.context, ["invoice.issue"]);

  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice was not found.");
  const recipient = input.recipient?.trim();
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new BadRequestError("recipient must be a valid email address.");
  }

  const sentAt = new Date().toISOString();

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: invoice.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_EMAIL_SENT",
    entityType: "invoice",
    entityId: invoice.id,
    afterJson: {
      recipient,
      subject: input.subject ?? null,
      messagePreview: input.message ? input.message.slice(0, 200) : null,
      sentAt
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: invoice.propertyId,
    entityType: "invoice",
    entityId: invoice.id,
    eventType: "InvoiceEmailQueued",
    payload: { recipient, sentAt },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return { acknowledged: true, recipient, invoiceId: invoice.id, sentAt };
}
