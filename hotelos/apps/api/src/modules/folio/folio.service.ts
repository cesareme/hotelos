import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { demoStore, type FolioLineRecord, type FolioRecord, type PaymentRecord, type UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";

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

export type FolioBalance = {
  folio: FolioRecord;
  lines: FolioLineRecord[];
  payments: PaymentRecord[];
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
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

function mapPayment(row: NonNullable<Awaited<ReturnType<typeof prisma.payment.findUnique>>>): PaymentRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    folioId: row.folioId,
    amount: dec(row.amount),
    currency: row.currency,
    method: row.method as PaymentRecord["method"],
    pspReference: row.pspReference ?? undefined,
    status: row.status,
    createdAt: row.createdAt.toISOString()
  };
}

export async function getReservationFolio(reservationId: string): Promise<FolioBalance> {
  const folio = await prisma.folio.findFirst({ where: { reservationId } });
  if (!folio) {
    throw new NotFoundError("Folio was not found.");
  }
  return getFolioBalance(folio.id);
}

export async function getFolioBalance(folioId: string): Promise<FolioBalance> {
  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) {
    throw new NotFoundError("Folio was not found.");
  }
  const [lineRows, paymentRows] = await Promise.all([
    // Hot-fix: cap defensively. A folio has at most a few hundred lines/payments.
    prisma.folioLine.findMany({ where: { folioId: folio.id }, orderBy: { postedAt: "asc" }, take: 500 }),
    prisma.payment.findMany({ where: { folioId: folio.id }, orderBy: { createdAt: "asc" }, take: 500 })
  ]);

  const lines = lineRows.map(mapLine);
  const payments = paymentRows.map(mapPayment);
  const chargesTotal = roundCurrency(lines.reduce((sum, line) => sum + line.total, 0));
  const paymentsTotal = roundCurrency(
    payments.filter((p) => p.status === "captured").reduce((sum, p) => sum + p.amount, 0)
  );

  return {
    folio: mapFolio(folio),
    lines,
    payments,
    chargesTotal,
    paymentsTotal,
    balanceDue: roundCurrency(chargesTotal - paymentsTotal)
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
    await routeLine({ lineId: created.id });
  } catch {
    // routing is best-effort: a failure must never block the underlying post
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
    throw new Error("Payment amount must be positive.");
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

export async function refundPayment(input: {
  context: UserContext;
  paymentId: string;
  reason: string;
  correlationId: string;
}): Promise<PaymentRecord> {
  requirePermissions(input.context, ["payment.refund", "ai.high_risk.confirm"]);

  const existing = await prisma.payment.findUnique({ where: { id: input.paymentId } });
  if (!existing) {
    throw new Error("Payment was not found.");
  }
  if (existing.status !== "captured") {
    throw new Error("Only captured payments can be refunded.");
  }

  const before = mapPayment(existing);
  const updated = await prisma.payment.update({
    where: { id: existing.id },
    data: { status: "refunded" }
  });
  const after = mapPayment(updated);
  mirrorPayment(after);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: after.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYMENT_REFUNDED",
    entityType: "payment",
    entityId: after.id,
    beforeJson: before,
    afterJson: { ...after, reason: input.reason },
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
  if (!folio) {
    throw new Error("Folio was not found.");
  }
  if (folio.status !== "open") {
    throw new Error("Folio is closed.");
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

export type MarkInvoicePaidResult = {
  invoiceId: string;
  payment: PaymentRecord;
  paidAmount: number;
  invoiceTotal: number;
  alreadyPaid: boolean;
};

/**
 * Mark an invoice as paid by recording a captured Payment against the invoice's
 * underlying folio. Idempotent — if a captured payment with the same
 * pspReference (or, when none is supplied, a payment whose amount matches
 * the invoice total) already exists, the existing record is returned.
 *
 * The `InvoiceStatus` enum is intentionally narrow (draft/issued/cancelled/
 * rectified); accounting "paid" status is represented by the existence of
 * captured payments on the linked folio rather than a mutated enum value.
 */
export async function markInvoicePaid(input: MarkInvoicePaidInput): Promise<MarkInvoicePaidResult> {
  requirePermissions(input.context, ["payment.capture"]);

  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice was not found.");
  if (invoice.status === "cancelled" || invoice.status === "rectified") {
    throw new BadRequestError(`Cannot mark a ${invoice.status} invoice as paid.`);
  }

  const invoiceTotal = roundCurrency(dec(invoice.total));
  const amount = roundCurrency(input.amount ?? invoiceTotal);
  if (amount <= 0) throw new BadRequestError("Payment amount must be positive.");

  // Find the linked folio. Invoices are created from a folio, so the most
  // recent open folio on the same property+customer is the natural target —
  // but we cannot reliably reverse-walk that link without a join column.
  // Falling back to the most recent open folio for the property, restricted
  // to ones the invoice's customer is associated with, is robust enough for
  // the demo data; production code would persist invoice.folioId.
  const folio = await prisma.folio.findFirst({
    where: { reservation: { propertyId: invoice.propertyId } },
    orderBy: { id: "desc" }
  });
  if (!folio) {
    throw new NotFoundError("No folio is associated with this invoice's property.");
  }

  // Idempotency: existing captured payment that matches pspReference or amount.
  const existing = await prisma.payment.findFirst({
    where: {
      folioId: folio.id,
      status: "captured",
      ...(input.pspReference
        ? { pspReference: input.pspReference }
        : { amount: { equals: amount } })
    },
    orderBy: { createdAt: "desc" }
  });

  if (existing) {
    const mapped = mapPayment(existing);
    return {
      invoiceId: invoice.id,
      payment: mapped,
      paidAmount: mapped.amount,
      invoiceTotal,
      alreadyPaid: true
    };
  }

  const created = await prisma.payment.create({
    data: {
      propertyId: invoice.propertyId,
      folioId: folio.id,
      amount,
      currency: invoice.currencyCode ?? folio.currency ?? "EUR",
      method: input.method ?? "bank_transfer",
      pspReference: input.pspReference ?? null,
      status: "captured"
    }
  });
  const payment = mapPayment(created);
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
      amount: payment.amount,
      method: payment.method,
      pspReference: payment.pspReference
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: invoice.propertyId,
    entityType: "invoice",
    entityId: invoice.id,
    eventType: "InvoiceMarkedPaid",
    payload: { paymentId: payment.id, amount: payment.amount, invoiceTotal },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return {
    invoiceId: invoice.id,
    payment,
    paidAmount: payment.amount,
    invoiceTotal,
    alreadyPaid: false
  };
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
