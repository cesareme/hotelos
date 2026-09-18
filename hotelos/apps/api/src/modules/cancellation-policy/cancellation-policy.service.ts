// CancellationPolicy — free-cancel window + penalty engine for late
// cancellations and no-shows. Every PMS in the market (Opera, Mews, Cloudbeds,
// Apaleo) implements this; without it the hotel cannot enforce its commercial
// terms. This service is the single source of truth for "how much do we charge
// when a reservation is cancelled or doesn't show up?".
//
// Tanda L3 (2026-09-18, lote B):
//   · `isDefault` (lote S, schema.prisma): the property's default policy for
//     reservations without `cancellationPolicyId` / `cancellationPolicyCode`.
//     Resolution is id → code → active default → null; the old «first active
//     policy by code» fallback is gone (a seed no longer silently rules every
//     reservation without a code). At most ONE default per property: marking
//     one unmarks the rest inside a transaction (no partial unique index).
//   · The engine is PURE (`computeChargeForPolicy`): the free-cancel window
//     closes at 14:00 wall-clock time of the HOTEL (Property.timezone, decision
//     §6.16) instead of 14:00 UTC; `computeCancellationCharge` only loads the
//     reservation, the policies and the time zone.
//   · Penalties land on the folio as `cancellation_fee` / `no_show_fee` lines
//     with `taxCategory: "not_subject"` (indemnity; LINE_TYPE_CATEGORY maps both
//     to not_subject) instead of `adjustment` (21 %). Decision §6.4 stays open
//     (a per-policy `penaltyTaxCategory` would go here).
//   · The folio the fee lands on is the reservation's OPEN folio; when every
//     folio is closed a new one is opened (before: the first folio whatever its
//     status → 409 from getOpenFolio).
//   · The orchestration (transition + fee + folio close + SoD) lives in
//     reservation-lifecycle.service.ts — this file never imports pms.service
//     (pms → night-audit → cancellation-policy would close a cycle).
//   · Corrector L3 (DS-01 / DS-03 / FC-1): ONE penalty line per reservation
//     and mode. `chargeToFolio` is idempotent — a live `cancellation_fee` /
//     `no_show_fee` line already posted on any live folio of the reservation
//     is returned instead of a second one — and the legacy routes
//     `applyCancellationFee` / `applyNoShowFee` only act on a reservation that
//     IS cancelled / no_show (409 otherwise): they are the repair path for a
//     penalty that never landed (a failure after the status transition), never
//     a way to stack fees on a live reservation.
import { prisma } from "@hotelos/database";
import { NotFoundError, BadRequestError, ConflictError } from "../../lib/http-error.js";
import { mapFolioLine, postFolioLine } from "../folio/folio.service.js";
import { createId } from "../../lib/ids.js";
import type { FolioLineRecord, UserContext } from "../../lib/demo-store.js";
import { resolvePropertyTimeZone, zonedParts } from "../pos/pos.service.js";

export type PenaltyType = "first_night" | "percent" | "fixed_amount" | "all_stay" | "none";

export type CancellationPolicyRecord = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string | null;
  freeCancelHours: number;
  penaltyType: PenaltyType;
  penaltyValue: number | null;
  noShowPenaltyType: PenaltyType;
  noShowPenaltyValue: number | null;
  active: boolean;
  /** Tanda L3: the property's default policy (at most one per property). */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

function toRecord(row: {
  id: string; propertyId: string; code: string; name: string; description: string | null;
  freeCancelHours: number; penaltyType: string; penaltyValue: { toString: () => string } | null;
  noShowPenaltyType: string; noShowPenaltyValue: { toString: () => string } | null;
  active: boolean; isDefault: boolean; createdAt: Date; updatedAt: Date;
}): CancellationPolicyRecord {
  return {
    id: row.id, propertyId: row.propertyId, code: row.code, name: row.name, description: row.description,
    freeCancelHours: row.freeCancelHours,
    penaltyType: row.penaltyType as PenaltyType,
    penaltyValue: row.penaltyValue ? Number(row.penaltyValue.toString()) : null,
    noShowPenaltyType: row.noShowPenaltyType as PenaltyType,
    noShowPenaltyValue: row.noShowPenaltyValue ? Number(row.noShowPenaltyValue.toString()) : null,
    active: row.active,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}

/** Default first, then active ones, then by code. Array (server.ts wraps it in `{ items }`). */
export async function listCancellationPolicies(propertyId: string): Promise<CancellationPolicyRecord[]> {
  const rows = await prisma.cancellationPolicy.findMany({
    where: { propertyId },
    orderBy: [{ isDefault: "desc" }, { active: "desc" }, { code: "asc" }]
  });
  return rows.map(toRecord);
}

export async function getCancellationPolicy(id: string): Promise<CancellationPolicyRecord> {
  const row = await prisma.cancellationPolicy.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Política de cancelación no encontrada.");
  return toRecord(row);
}

export async function createCancellationPolicy(input: {
  context: UserContext;
  propertyId: string;
  payload: {
    code: string; name: string; description?: string;
    freeCancelHours?: number;
    penaltyType?: PenaltyType; penaltyValue?: number | null;
    noShowPenaltyType?: PenaltyType; noShowPenaltyValue?: number | null;
    active?: boolean;
    isDefault?: boolean;
  };
}): Promise<CancellationPolicyRecord> {
  const p = input.payload;
  if (!p.code?.trim() || !p.name?.trim()) throw new BadRequestError("code y name son obligatorios.");
  const isDefault = p.isDefault === true;
  const data = {
    propertyId: input.propertyId,
    code: p.code.trim(),
    name: p.name.trim(),
    description: p.description ?? null,
    freeCancelHours: p.freeCancelHours ?? 48,
    penaltyType: p.penaltyType ?? "first_night",
    penaltyValue: p.penaltyValue ?? null,
    noShowPenaltyType: p.noShowPenaltyType ?? "first_night",
    noShowPenaltyValue: p.noShowPenaltyValue ?? null,
    active: p.active ?? true,
    isDefault
  };
  if (!isDefault) return toRecord(await prisma.cancellationPolicy.create({ data }));
  // One default per property: unmark the rest in the same transaction.
  const [, row] = await prisma.$transaction([
    prisma.cancellationPolicy.updateMany({ where: { propertyId: input.propertyId, isDefault: true }, data: { isDefault: false } }),
    prisma.cancellationPolicy.create({ data })
  ]);
  return toRecord(row);
}

export async function updateCancellationPolicy(input: {
  context: UserContext;
  id: string;
  payload: Partial<{
    name: string; description: string | null;
    freeCancelHours: number;
    penaltyType: PenaltyType; penaltyValue: number | null;
    noShowPenaltyType: PenaltyType; noShowPenaltyValue: number | null;
    active: boolean;
    isDefault: boolean;
  }>;
}): Promise<CancellationPolicyRecord> {
  const existing = await prisma.cancellationPolicy.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Política de cancelación no encontrada.");
  const p = input.payload;
  const data = {
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.freeCancelHours !== undefined ? { freeCancelHours: p.freeCancelHours } : {}),
    ...(p.penaltyType !== undefined ? { penaltyType: p.penaltyType } : {}),
    ...(p.penaltyValue !== undefined ? { penaltyValue: p.penaltyValue } : {}),
    ...(p.noShowPenaltyType !== undefined ? { noShowPenaltyType: p.noShowPenaltyType } : {}),
    ...(p.noShowPenaltyValue !== undefined ? { noShowPenaltyValue: p.noShowPenaltyValue } : {}),
    ...(p.active !== undefined ? { active: p.active } : {}),
    ...(p.isDefault !== undefined ? { isDefault: p.isDefault } : {})
  };
  if (p.isDefault !== true) return toRecord(await prisma.cancellationPolicy.update({ where: { id: input.id }, data }));
  const [, row] = await prisma.$transaction([
    prisma.cancellationPolicy.updateMany({ where: { propertyId: existing.propertyId, isDefault: true, id: { not: input.id } }, data: { isDefault: false } }),
    prisma.cancellationPolicy.update({ where: { id: input.id }, data })
  ]);
  return toRecord(row);
}

export async function deleteCancellationPolicy(id: string) {
  const existing = await prisma.cancellationPolicy.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Política de cancelación no encontrada.");
  await prisma.cancellationPolicy.delete({ where: { id } });
  return { ok: true, id };
}

// --- Engine (pure) ----------------------------------------------------------

export type ChargeMode = "cancellation" | "no_show";

export type ChargeBreakdown = {
  amount: number;
  basis: "none" | "first_night" | "percent" | "fixed_amount" | "all_stay";
  withinFreeWindow: boolean;
  policyCode: string | null;
  policyName: string | null;
  label: string;
  /** Instant the free-cancel window is measured against (14:00 hotel time of the arrival day); null without policy or for no-shows. */
  cutoffAt: string | null;
};

/** Hour of the hotel's wall clock at which the arrival day «starts» for the free-cancel window (common PMS convention). */
export const ARRIVAL_CUTOFF_HOUR = 14;

export type StayForCharge = {
  totalAmount: number;
  /** Calendar day (UTC-midnight Date of a @db.Date column, or YYYY-MM-DD). */
  arrivalDate: Date | string;
  departureDate: Date | string;
};

export type PolicyForCharge = Pick<CancellationPolicyRecord, "code" | "name" | "freeCancelHours" | "penaltyType" | "penaltyValue" | "noShowPenaltyType" | "noShowPenaltyValue">;

function isoDayOf(date: Date | string): string {
  return typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

function nightsBetween(arrival: Date | string, departure: Date | string): number {
  const a = new Date(`${isoDayOf(arrival)}T00:00:00.000Z`).getTime();
  const d = new Date(`${isoDayOf(departure)}T00:00:00.000Z`).getTime();
  return Math.max(1, Math.round((d - a) / 86_400_000));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Instant of `hour:00` on the calendar day of `date`, in `timeZone`. Two
 * passes so a DST switch on that day still lands on the requested wall-clock
 * hour (same technique as pos.service zonedMidnight). Pure.
 */
export function wallClockInstant(date: Date | string, hour: number, timeZone: string): Date {
  const [year, month, day] = isoDayOf(date).split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsetAt = (instant: Date): number => {
    const p = zonedParts(instant, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
  };
  const firstPass = guess - offsetAt(new Date(guess));
  return new Date(guess - offsetAt(new Date(firstPass)));
}

/**
 * Pure policy resolution: explicit id → code → the property's active default →
 * null. NO alphabetical fallback (risk 3 of the L3 recon). `candidates` are the
 * policies of the reservation's property.
 */
export function resolvePolicyFromCandidates(
  reservation: { cancellationPolicyId: string | null; cancellationPolicyCode: string | null },
  candidates: readonly CancellationPolicyRecord[]
): CancellationPolicyRecord | null {
  if (reservation.cancellationPolicyId) {
    const byId = candidates.find((p) => p.id === reservation.cancellationPolicyId);
    if (byId) return byId;
  }
  if (reservation.cancellationPolicyCode) {
    const byCode = candidates.find((p) => p.code === reservation.cancellationPolicyCode);
    if (byCode) return byCode;
  }
  return candidates.find((p) => p.active && p.isDefault) ?? null;
}

export async function resolveReservationPolicy(reservation: {
  propertyId: string;
  cancellationPolicyId: string | null;
  cancellationPolicyCode: string | null;
}): Promise<CancellationPolicyRecord | null> {
  const rows = await prisma.cancellationPolicy.findMany({ where: { propertyId: reservation.propertyId }, take: 200 });
  return resolvePolicyFromCandidates(reservation, rows.map(toRecord));
}

function applyPenalty(penaltyType: PenaltyType, penaltyValue: number | null, total: number, firstNightRate: number): { amount: number; basis: ChargeBreakdown["basis"] } {
  switch (penaltyType) {
    case "first_night": return { amount: round2(firstNightRate), basis: "first_night" };
    case "all_stay": return { amount: round2(total), basis: "all_stay" };
    case "percent":   return { amount: round2((total * (penaltyValue ?? 0)) / 100), basis: "percent" };
    case "fixed_amount": return { amount: round2(penaltyValue ?? 0), basis: "fixed_amount" };
    case "none":
    default:
      return { amount: 0, basis: "none" };
  }
}

export const NO_POLICY_BREAKDOWN: ChargeBreakdown = Object.freeze({
  amount: 0, basis: "none", withinFreeWindow: true, policyCode: null, policyName: null,
  label: "Sin política de cancelación configurada — sin cargo.", cutoffAt: null
}) as ChargeBreakdown;

/**
 * Pure charge computation. Cancellation: free when `freeCancelHours > 0` and
 * `cancelAt` is at least that many hours before 14:00 hotel time of the arrival
 * day (`freeCancelHours = 0` = non-refundable). No-show: never free.
 */
export function computeChargeForPolicy(policy: PolicyForCharge, stay: StayForCharge, cancelAt: Date, timeZone: string, mode: ChargeMode): ChargeBreakdown {
  const total = round2(stay.totalAmount);
  const nights = nightsBetween(stay.arrivalDate, stay.departureDate);
  const firstNightRate = nights > 0 ? total / nights : total;

  if (mode === "no_show") {
    const { amount, basis } = applyPenalty(policy.noShowPenaltyType, policy.noShowPenaltyValue, total, firstNightRate);
    return {
      amount, basis,
      withinFreeWindow: false, // no-shows never benefit from the free window
      policyCode: policy.code, policyName: policy.name,
      label: amount > 0 ? `No-show — ${policy.name}: ${describeBasis(basis, policy.noShowPenaltyValue)}` : `No-show sin cargo (política «${policy.name}»).`,
      cutoffAt: null
    };
  }

  const cutoff = wallClockInstant(stay.arrivalDate, ARRIVAL_CUTOFF_HOUR, timeZone);
  const hoursToArrival = (cutoff.getTime() - cancelAt.getTime()) / 3_600_000;
  const withinFreeWindow = policy.freeCancelHours > 0 && hoursToArrival >= policy.freeCancelHours;
  if (withinFreeWindow) {
    return {
      amount: 0, basis: "none", withinFreeWindow: true,
      policyCode: policy.code, policyName: policy.name,
      label: `Cancelación gratuita (≥${policy.freeCancelHours} h antes de la llegada).`,
      cutoffAt: cutoff.toISOString()
    };
  }
  const { amount, basis } = applyPenalty(policy.penaltyType, policy.penaltyValue, total, firstNightRate);
  return {
    amount, basis, withinFreeWindow: false,
    policyCode: policy.code, policyName: policy.name,
    label: amount > 0
      ? `Cancelación tardía — ${policy.name}: ${describeBasis(basis, policy.penaltyValue)}`
      : `Cancelación tardía sin cargo (política «${policy.name}»).`,
    cutoffAt: cutoff.toISOString()
  };
}

/** Loads the reservation, its policy and the hotel's time zone, then delegates to the pure engine. */
export async function computeCancellationCharge(input: {
  reservationId: string;
  cancelAt?: Date;
  mode?: ChargeMode;
}): Promise<ChargeBreakdown> {
  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const policy = await resolveReservationPolicy(reservation);
  if (!policy) return { ...NO_POLICY_BREAKDOWN };
  const { timeZone } = await resolvePropertyTimeZone(reservation.propertyId);
  return computeChargeForPolicy(
    policy,
    { totalAmount: Number(reservation.totalAmount?.toString() ?? "0"), arrivalDate: reservation.arrivalDate, departureDate: reservation.departureDate },
    input.cancelAt ?? new Date(),
    timeZone,
    input.mode ?? "cancellation"
  );
}

function describeBasis(basis: ChargeBreakdown["basis"], penaltyValue: number | null): string {
  switch (basis) {
    case "first_night": return "primera noche";
    case "all_stay": return "estancia completa";
    case "percent": return `${penaltyValue ?? 0}% del total`;
    case "fixed_amount": return `${(penaltyValue ?? 0).toFixed(2)} €`;
    case "none":
    default: return "sin cargo";
  }
}

// --- Folio posting ----------------------------------------------------------

/**
 * The reservation's OPEN folio (primary first); when none is open a new one is
 * opened so the fee has somewhere to land (a cancelled stay may never have had
 * a folio, or its folio may already be closed).
 */
async function ensureFolioForReservation(reservationId: string): Promise<{ id: string }> {
  const open = await prisma.folio.findFirst({
    where: { reservationId, status: "open", deletedAt: null },
    orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
    select: { id: true }
  });
  if (open) return open;
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true, currency: true } });
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const existing = await prisma.folio.count({ where: { reservationId, deletedAt: null } });
  return prisma.folio.create({
    data: { reservationId, status: "open", currency: reservation.currency ?? "EUR", label: "guest", isPrimary: existing === 0 },
    select: { id: true }
  });
}

/** Folio line type of a penalty mode. Pure. */
export function penaltyLineType(mode: ChargeMode): "cancellation_fee" | "no_show_fee" {
  return mode === "no_show" ? "no_show_fee" : "cancellation_fee";
}

/**
 * The penalty line already posted for (reservation, mode) on any live folio
 * of the reservation, or null. This is the idempotency key of the penalty:
 * one `cancellation_fee` and one `no_show_fee` per reservation at most
 * (corrector L3 · DS-01 / FC-1).
 */
export async function findPostedPenaltyLine(reservationId: string, mode: ChargeMode): Promise<FolioLineRecord | null> {
  const row = await prisma.folioLine.findFirst({
    where: { type: penaltyLineType(mode), deletedAt: null, folio: { reservationId, deletedAt: null } },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }]
  });
  return row ? mapFolioLine(row) : null;
}

/**
 * Posts the penalty as a `cancellation_fee` / `no_show_fee` line, fiscal
 * category `not_subject` (indemnity — decision §6.4). Requires
 * folio.charge.post (postFolioLine). Returns null when there is nothing to
 * charge. IDEMPOTENT per (reservation, mode): a penalty line already posted
 * is returned as is — a retry, a double click or a second caller never
 * stacks a second fee (corrector L3 · DS-01 / FC-1). The caller can tell the
 * two apart with `findPostedPenaltyLine` before calling.
 */
export async function chargeToFolio(input: {
  context: UserContext;
  reservationId: string;
  amount: number;
  description: string;
  mode: ChargeMode;
  correlationId: string;
}): Promise<FolioLineRecord | null> {
  if (input.amount <= 0) return null;
  const posted = await findPostedPenaltyLine(input.reservationId, input.mode);
  if (posted) return posted;
  const folio = await ensureFolioForReservation(input.reservationId);
  return postFolioLine({
    context: input.context,
    folioId: folio.id,
    type: penaltyLineType(input.mode),
    description: input.description,
    quantity: 1,
    unitPrice: input.amount,
    taxCategory: "not_subject",
    correlationId: input.correlationId
  });
}

export type ApplyPenaltyFeeResult = {
  breakdown: ChargeBreakdown;
  line: FolioLineRecord | null;
  /** True when the penalty line already existed: nothing was posted by this call. */
  alreadyApplied: boolean;
};

/**
 * Legacy routes POST /reservations/:id/apply-cancellation-fee · /apply-no-show-fee
 * (corrector L3 · DS-03): the reservation must already be in the state the fee
 * belongs to (`cancelled` for a cancellation fee, `no_show` for a no-show fee;
 * 409 `RESERVATION_STATUS_MISMATCH` otherwise — a confirmed guest is never
 * charged a «cancellation»), and the fee is idempotent per (reservation, mode).
 * They repair a penalty that never landed (e.g. a failure between the status
 * transition and the folio write of /cancel); the normal path is /cancel · /no-show.
 */
async function applyPenaltyFee(input: { context: UserContext; reservationId: string; mode: ChargeMode; cancelAt?: Date; correlationId?: string }): Promise<ApplyPenaltyFeeResult> {
  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId }, select: { id: true, code: true, status: true } });
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const expected = input.mode === "no_show" ? "no_show" : "cancelled";
  if (reservation.status !== expected) {
    throw new ConflictError(
      `La reserva ${reservation.code} está ${reservation.status}: la penalización de ${input.mode === "no_show" ? "no-show" : "cancelación"} solo se aplica a una reserva ${expected === "no_show" ? "marcada como no-show" : "cancelada"} (usa POST /reservations/:id/${input.mode === "no_show" ? "no-show" : "cancel"}).`,
      { code: "RESERVATION_STATUS_MISMATCH", status: reservation.status, expected }
    );
  }
  const posted = await findPostedPenaltyLine(input.reservationId, input.mode);
  const breakdown = await computeCancellationCharge({ reservationId: input.reservationId, cancelAt: input.cancelAt, mode: input.mode });
  if (posted) return { breakdown, line: posted, alreadyApplied: true };
  const line = breakdown.amount > 0
    ? await chargeToFolio({ context: input.context, reservationId: input.reservationId, amount: breakdown.amount, description: breakdown.label, mode: input.mode, correlationId: input.correlationId ?? createId("corr") })
    : null;
  return { breakdown, line, alreadyApplied: false };
}

export async function applyCancellationFee(input: { context: UserContext; reservationId: string; cancelAt?: Date; correlationId?: string }): Promise<ApplyPenaltyFeeResult> {
  return applyPenaltyFee({ ...input, mode: "cancellation" });
}

export async function applyNoShowFee(input: { context: UserContext; reservationId: string; correlationId?: string }): Promise<ApplyPenaltyFeeResult> {
  return applyPenaltyFee({ ...input, mode: "no_show" });
}

// `processNoShows` (night-audit step) moved to reservation-lifecycle.service.ts
// (Tanda L3): it now goes through transitionReservation (SES baja, audit, event).
