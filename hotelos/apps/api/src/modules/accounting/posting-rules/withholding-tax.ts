import { prisma, type Prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { ConflictError } from "../../../lib/http-error.js";

// Withholding-tax posting rule.
//
// Builds the `WithholdingTaxRecord` projection that feeds Modelo 111 (AEAT
// quarterly IRPF withholding return). We fan out from existing domain events:
//
//   * `SupplierBillCreated`        -> incoming bill from a vendor (typical
//                                     case: professional services where the
//                                     hotel withholds IRPF on the supplier's
//                                     gross amount before paying them).
//   * `InvoiceIssued`              -> outgoing B2B invoice where the customer
//                                     withholds IRPF on our behalf (rarer in
//                                     hospitality but valid for owner-side
//                                     invoices in a property-management
//                                     scenario).
//
// Strict idempotency by `(sourceType, sourceId)` — re-running the rule for the
// same source updates the existing row instead of inserting a duplicate. There
// is no Prisma `@@unique` constraint on `(sourceType, sourceId)` in the
// schema (only an index), so we implement upsert manually inside a
// transaction.
//
// The accounting journal (DR <expense> / CR 400 / CR 4751 retención) is
// produced by the existing posting engine in `posting-rules.ts` (see the
// `SupplierBillCreated` branch of `evaluate`). This module only owns the IRPF
// projection table — it is intentionally decoupled from the journal so that
// the Modelo 111 report stays correct even if the journal posting fails (e.g.
// a closed fiscal period).
//
// Work centre (Tanda 6b · L4, design §5.2 R4 and §4 #7): a retention ALWAYS
// belongs to a centre (`propertyId`) — the head office (`Property.kind =
// office`) included — so the 111/115/190 of the sociedad aggregates every
// centre. The former guard `if (!event.propertyId) return null` dropped the
// office's payroll and professional invoices in silence (Modelo 111
// incomplete). Now an event that carries a retention and no centre throws
// 409 WORK_CENTER_REQUIRED: in the projection path the dispatcher
// (posting-rules/index.ts) logs it and records the ACCOUNTING_PROJECTION_FAILED
// audit event with `details.code`; a synchronous caller (payroll) surfaces the
// 409 to the user. Events without a retention component stay silent — they are
// not withholding events. `requireWithholdingWorkCenter` is the one check that
// the centre exists inside the organisation (any kind).

export type WithholdingSourceType = "vendor_invoice" | "issued_invoice" | "payroll_payment";

export const WORK_CENTER_REQUIRED_CODE = "WORK_CENTER_REQUIRED" as const;

export type WithholdingDraft = {
  organizationId: string;
  propertyId: string;
  sourceType: WithholdingSourceType;
  sourceId: string;
  recipientNif?: string | null;
  recipientName?: string | null;
  grossAmount: Prisma.Decimal | string | number;
  retentionRate: Prisma.Decimal | string | number;
  retentionAmount: Prisma.Decimal | string | number;
  rowCode?: string;
  paymentDate: Date | string;
  fiscalPeriodId?: string | null;
};

// Modelo 111 row codes. We map the high-level domain event type to the
// AEAT row code; callers may override with an explicit `rowCode` in the
// event payload when a vendor is e.g. an agricultural producer (row 03).
export const MODELO_111_ROW_DEFAULTS: Record<WithholdingSourceType, string> = {
  vendor_invoice: "02", // Actividades económicas: profesionales (dinerarios)
  issued_invoice: "02", // Same row, customer-withheld
  payroll_payment: "01" // Rendimientos del trabajo
};

function toDecimal(value: Prisma.Decimal | string | number): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite monetary value");
    return value.toFixed(2);
  }
  // Prisma.Decimal supports toString() with full precision.
  return value.toString();
}

function toPaymentDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  // Accept ISO strings; coerce to a midnight-UTC Date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  return new Date(value);
}

// --- work centre -------------------------------------------------------------

/** 409 WORK_CENTER_REQUIRED with typed details (Spanish message; `code` always wins over `extra.code`). */
export function workCenterRequiredError(extra: Record<string, unknown> = {}): ConflictError {
  return new ConflictError(
    "La retención necesita un centro de trabajo (propertyId): asigna el hotel o la oficina central para que el Modelo 111/115 la incluya.",
    { ...extra, code: WORK_CENTER_REQUIRED_CODE }
  );
}

/** Subset of the Prisma client the rule touches (the root client or an interactive transaction). */
export type WithholdingDb = Pick<Prisma.TransactionClient, "property" | "withholdingTaxRecord">;

/**
 * The work centre of a retention must exist inside the organisation — any
 * kind (hotel, office, other). Returns the centre; throws 409
 * WORK_CENTER_REQUIRED when missing or foreign (never a 404: the caller's
 * document, not the URL, is what lacks the centre).
 */
export async function requireWithholdingWorkCenter(
  organizationId: string,
  propertyId: string | null | undefined,
  db: WithholdingDb = prisma
): Promise<{ id: string; kind: string }> {
  if (!propertyId) throw workCenterRequiredError({ organizationId });
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true, kind: true } });
  if (!property || property.organizationId !== organizationId) {
    throw workCenterRequiredError({ organizationId, propertyId, reason: "PROPERTY_NOT_IN_ORGANIZATION" });
  }
  return { id: property.id, kind: String(property.kind) };
}

// --- public API ------------------------------------------------------------

/**
 * Idempotently upsert a withholding-tax record. Returns the persisted row.
 *
 * Idempotency: keyed by `(sourceType, sourceId)`. If a row already exists for
 * that pair we update its monetary fields and dates in place instead of
 * inserting a duplicate. This lets posting be safely re-driven (e.g. on
 * server restart, replay of the domain-event log). Pass `db` to join the
 * caller's interactive transaction (payroll posts slip, asiento and record
 * together).
 */
export async function upsertWithholdingRecord(draft: WithholdingDraft, db?: Prisma.TransactionClient) {
  const rowCode = draft.rowCode ?? MODELO_111_ROW_DEFAULTS[draft.sourceType] ?? "02";
  const paymentDate = toPaymentDate(draft.paymentDate);

  const data = {
    organizationId: draft.organizationId,
    propertyId: draft.propertyId,
    sourceType: draft.sourceType,
    sourceId: draft.sourceId,
    recipientNif: draft.recipientNif ?? null,
    recipientName: draft.recipientName ?? null,
    grossAmount: toDecimal(draft.grossAmount),
    retentionRate: toDecimal(draft.retentionRate),
    retentionAmount: toDecimal(draft.retentionAmount),
    rowCode,
    paymentDate,
    fiscalPeriodId: draft.fiscalPeriodId ?? null
  };

  // We can't use `prisma.withholdingTaxRecord.upsert` because the unique key
  // isn't a single Prisma `@@unique` (it's an `@@index`). Do the
  // find-then-create/update inside a transaction to avoid race-condition dups.
  const run = async (tx: WithholdingDb) => {
    await requireWithholdingWorkCenter(draft.organizationId, draft.propertyId, tx);
    const existing = await tx.withholdingTaxRecord.findFirst({
      where: { sourceType: draft.sourceType, sourceId: draft.sourceId },
      select: { id: true }
    });
    if (existing) {
      return tx.withholdingTaxRecord.update({ where: { id: existing.id }, data });
    }
    return tx.withholdingTaxRecord.create({ data });
  };
  return db ? run(db) : prisma.$transaction((tx) => run(tx));
}

/**
 * Map a domain event into a `WithholdingDraft`. Returns null when the event
 * is not a withholding event or carries no retention (rate and amount both
 * zero / missing). Throws 409 WORK_CENTER_REQUIRED when it carries a
 * retention and no work centre — never a silent drop (R4).
 */
export function draftFromEvent(event: EventEnvelope): WithholdingDraft | null {
  if (!event.organizationId) return null;
  if (!event.entityId) return null;

  const sourceType = mapEventToSourceType(event);
  if (!sourceType) return null;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const retentionRateRaw = payload.retentionRate;
  const retentionAmountRaw = payload.retentionAmount;
  const grossAmountRaw = payload.grossAmount ?? payload.total ?? payload.netAmount;

  const retentionRate = numberOrZero(retentionRateRaw);
  let retentionAmount = numberOrZero(retentionAmountRaw);
  const gross = numberOrZero(grossAmountRaw);

  // Allow either an explicit retentionAmount or compute it from a rate.
  // retentionRate is expressed as a decimal fraction (0.15) or percent (15);
  // disambiguate by treating values >= 1 as percent.
  if (retentionAmount === 0 && retentionRate > 0 && gross > 0) {
    const ratePct = retentionRate >= 1 ? retentionRate / 100 : retentionRate;
    retentionAmount = Math.round(gross * ratePct * 100) / 100;
  }

  if (retentionRate <= 0 && retentionAmount <= 0) return null;

  if (!event.propertyId) {
    throw workCenterRequiredError({
      eventId: event.eventId,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      sourceType,
      retentionAmount: retentionAmount.toFixed(2)
    });
  }

  const ratePercent = retentionRate >= 1 ? retentionRate : retentionRate * 100;

  return {
    organizationId: event.organizationId,
    propertyId: event.propertyId,
    sourceType,
    sourceId: event.entityId,
    recipientNif: (payload.recipientNif as string | undefined) ?? (payload.supplierTaxId as string | undefined) ?? null,
    recipientName: (payload.recipientName as string | undefined) ?? (payload.supplierName as string | undefined) ?? null,
    grossAmount: gross.toFixed(2),
    retentionRate: ratePercent.toFixed(2),
    retentionAmount: retentionAmount.toFixed(2),
    rowCode: (payload.rowCode as string | undefined) ?? MODELO_111_ROW_DEFAULTS[sourceType],
    paymentDate: (payload.paymentDate as string | undefined) ?? event.createdAt,
    fiscalPeriodId: (payload.fiscalPeriodId as string | undefined) ?? null
  };
}

/**
 * Side-effect entry point invoked by the projection dispatcher. Safe to call
 * for any event; returns silently when the event has no retention component.
 * A retention without a work centre propagates as 409 WORK_CENTER_REQUIRED so
 * the dispatcher records ACCOUNTING_PROJECTION_FAILED (audit trail) instead
 * of losing the record.
 */
export async function recordWithholdingFromEvent(event: EventEnvelope): Promise<void> {
  const draft = draftFromEvent(event);
  if (!draft) return;
  await upsertWithholdingRecord(draft);
}

// --- helpers ---------------------------------------------------------------

function mapEventToSourceType(event: EventEnvelope): WithholdingSourceType | null {
  switch (event.eventType) {
    case "SupplierBillCreated":
    case "SupplierBillUpdated":
      return "vendor_invoice";
    case "InvoiceIssued":
      return "issued_invoice";
    case "PayrollPaymentRecorded":
      return "payroll_payment";
    default:
      return null;
  }
}

function numberOrZero(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "object" && value !== null && "toString" in value) {
    const parsed = Number((value as { toString(): string }).toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
