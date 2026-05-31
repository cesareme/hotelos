// CancellationPolicy — free-cancel window + penalty engine for late
// cancellations and no-shows. Every PMS in the market (Opera, Mews, Cloudbeds,
// Apaleo) implements this; without it the hotel cannot enforce its commercial
// terms. This service is the single source of truth for "how much do we charge
// when a reservation is cancelled or doesn't show up?".
import { prisma } from "@hotelos/database";
import { NotFoundError, BadRequestError } from "../../lib/http-error.js";
import { postFolioLine, getReservationFolio } from "../folio/folio.service.js";
import { createId } from "../../lib/ids.js";
import type { UserContext } from "../../lib/demo-store.js";

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
  createdAt: string;
  updatedAt: string;
};

function toRecord(row: {
  id: string; propertyId: string; code: string; name: string; description: string | null;
  freeCancelHours: number; penaltyType: string; penaltyValue: { toString: () => string } | null;
  noShowPenaltyType: string; noShowPenaltyValue: { toString: () => string } | null;
  active: boolean; createdAt: Date; updatedAt: Date;
}): CancellationPolicyRecord {
  return {
    id: row.id, propertyId: row.propertyId, code: row.code, name: row.name, description: row.description,
    freeCancelHours: row.freeCancelHours,
    penaltyType: row.penaltyType as PenaltyType,
    penaltyValue: row.penaltyValue ? Number(row.penaltyValue.toString()) : null,
    noShowPenaltyType: row.noShowPenaltyType as PenaltyType,
    noShowPenaltyValue: row.noShowPenaltyValue ? Number(row.noShowPenaltyValue.toString()) : null,
    active: row.active,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}

export async function listCancellationPolicies(propertyId: string): Promise<CancellationPolicyRecord[]> {
  const rows = await prisma.cancellationPolicy.findMany({ where: { propertyId }, orderBy: [{ active: "desc" }, { code: "asc" }] });
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
  };
}): Promise<CancellationPolicyRecord> {
  const p = input.payload;
  if (!p.code?.trim() || !p.name?.trim()) throw new BadRequestError("code y name son obligatorios.");
  const row = await prisma.cancellationPolicy.create({
    data: {
      propertyId: input.propertyId,
      code: p.code.trim(),
      name: p.name.trim(),
      description: p.description ?? null,
      freeCancelHours: p.freeCancelHours ?? 48,
      penaltyType: p.penaltyType ?? "first_night",
      penaltyValue: p.penaltyValue ?? null,
      noShowPenaltyType: p.noShowPenaltyType ?? "first_night",
      noShowPenaltyValue: p.noShowPenaltyValue ?? null,
      active: p.active ?? true
    }
  });
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
  }>;
}): Promise<CancellationPolicyRecord> {
  const existing = await prisma.cancellationPolicy.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Política de cancelación no encontrada.");
  const p = input.payload;
  const row = await prisma.cancellationPolicy.update({
    where: { id: input.id },
    data: {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.freeCancelHours !== undefined ? { freeCancelHours: p.freeCancelHours } : {}),
      ...(p.penaltyType !== undefined ? { penaltyType: p.penaltyType } : {}),
      ...(p.penaltyValue !== undefined ? { penaltyValue: p.penaltyValue } : {}),
      ...(p.noShowPenaltyType !== undefined ? { noShowPenaltyType: p.noShowPenaltyType } : {}),
      ...(p.noShowPenaltyValue !== undefined ? { noShowPenaltyValue: p.noShowPenaltyValue } : {}),
      ...(p.active !== undefined ? { active: p.active } : {})
    }
  });
  return toRecord(row);
}

export async function deleteCancellationPolicy(id: string) {
  const existing = await prisma.cancellationPolicy.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Política de cancelación no encontrada.");
  await prisma.cancellationPolicy.delete({ where: { id } });
  return { ok: true, id };
}

// --- Engine ---------------------------------------------------------------

export type ChargeBreakdown = {
  amount: number;
  basis: "none" | "first_night" | "percent" | "fixed_amount" | "all_stay";
  withinFreeWindow: boolean;
  policyCode: string | null;
  policyName: string | null;
  label: string;
};

function nightsBetween(arrival: Date, departure: Date): number {
  return Math.max(1, Math.round((departure.getTime() - arrival.getTime()) / 86_400_000));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function resolveReservationPolicy(reservation: { propertyId: string; cancellationPolicyId: string | null; cancellationPolicyCode: string | null }): Promise<CancellationPolicyRecord | null> {
  // 1) explicit policy id on the reservation
  if (reservation.cancellationPolicyId) {
    const row = await prisma.cancellationPolicy.findUnique({ where: { id: reservation.cancellationPolicyId } });
    if (row) return toRecord(row);
  }
  // 2) fall back to code lookup
  if (reservation.cancellationPolicyCode) {
    const row = await prisma.cancellationPolicy.findUnique({
      where: { propertyId_code: { propertyId: reservation.propertyId, code: reservation.cancellationPolicyCode } }
    });
    if (row) return toRecord(row);
  }
  // 3) fall back to the property's default active policy with code "DEFAULT" or
  //    the first active one
  const fallback = await prisma.cancellationPolicy.findFirst({
    where: { propertyId: reservation.propertyId, active: true },
    orderBy: [{ code: "asc" }]
  });
  return fallback ? toRecord(fallback) : null;
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

export async function computeCancellationCharge(input: {
  reservationId: string;
  cancelAt?: Date;
  mode?: "cancellation" | "no_show";
}): Promise<ChargeBreakdown> {
  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const mode = input.mode ?? "cancellation";

  const policy = await resolveReservationPolicy(reservation);
  if (!policy) {
    return { amount: 0, basis: "none", withinFreeWindow: true, policyCode: null, policyName: null, label: "Sin política de cancelación configurada — sin cargo." };
  }

  const total = Number(reservation.totalAmount?.toString() ?? "0");
  const nights = nightsBetween(reservation.arrivalDate, reservation.departureDate);
  const firstNightRate = nights > 0 ? total / nights : total;
  const cancelAt = input.cancelAt ?? new Date();

  if (mode === "no_show") {
    const { amount, basis } = applyPenalty(policy.noShowPenaltyType, policy.noShowPenaltyValue, total, firstNightRate);
    return {
      amount, basis,
      withinFreeWindow: false, // no-shows never benefit from the free window
      policyCode: policy.code, policyName: policy.name,
      label: amount > 0 ? `No-show — ${policy.name}: ${describeBasis(basis, policy.noShowPenaltyValue)}` : `No-show sin cargo (política «${policy.name}»).`
    };
  }

  // cancellation
  // arrival "starts" at 14:00 local on the arrival date — a common PMS convention.
  const arrivalRef = new Date(reservation.arrivalDate);
  arrivalRef.setUTCHours(14, 0, 0, 0);
  const hoursToArrival = (arrivalRef.getTime() - cancelAt.getTime()) / 3_600_000;
  // freeCancelHours = 0 means "non-refundable" (no free window). Require a
  // strictly positive window to grant the free cancellation.
  const withinFreeWindow = policy.freeCancelHours > 0 && hoursToArrival >= policy.freeCancelHours;
  if (withinFreeWindow) {
    return {
      amount: 0, basis: "none", withinFreeWindow: true,
      policyCode: policy.code, policyName: policy.name,
      label: `Cancelación gratuita (≥${policy.freeCancelHours} h antes de la llegada).`
    };
  }
  const { amount, basis } = applyPenalty(policy.penaltyType, policy.penaltyValue, total, firstNightRate);
  return {
    amount, basis, withinFreeWindow: false,
    policyCode: policy.code, policyName: policy.name,
    label: amount > 0
      ? `Cancelación tardía — ${policy.name}: ${describeBasis(basis, policy.penaltyValue)}`
      : `Cancelación tardía sin cargo (política «${policy.name}»).`
  };
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

async function ensureFolioForReservation(reservationId: string): Promise<{ id: string }> {
  const existing = await prisma.folio.findFirst({ where: { reservationId }, select: { id: true } });
  if (existing) return existing;
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true, currency: true } });
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  return prisma.folio.create({
    data: { reservationId, status: "open", currency: reservation.currency ?? "EUR" },
    select: { id: true }
  });
}

async function chargeToFolio(input: {
  context: UserContext;
  reservationId: string;
  amount: number;
  description: string;
  correlationId: string;
}) {
  if (input.amount <= 0) return null;
  // For cancellations/no-shows the guest may have never had a folio opened (the
  // stay never happened). Open one on the fly so the fee has somewhere to land.
  const folio = await ensureFolioForReservation(input.reservationId);
  // Suppress the unused-import warning when getReservationFolio is not used in
  // a given runtime path (kept here so future routing changes can use it).
  void getReservationFolio;
  return postFolioLine({
    context: input.context,
    folioId: folio.id,
    type: "adjustment", // Folio engine accepts free-form types; "adjustment" surfaces under fees in reporting.
    description: input.description,
    quantity: 1,
    unitPrice: input.amount,
    correlationId: input.correlationId
  });
}

export async function applyCancellationFee(input: { context: UserContext; reservationId: string; cancelAt?: Date; correlationId?: string }) {
  const breakdown = await computeCancellationCharge({ reservationId: input.reservationId, cancelAt: input.cancelAt, mode: "cancellation" });
  const line = breakdown.amount > 0
    ? await chargeToFolio({ context: input.context, reservationId: input.reservationId, amount: breakdown.amount, description: breakdown.label, correlationId: input.correlationId ?? createId("corr") })
    : null;
  return { breakdown, line };
}

export async function applyNoShowFee(input: { context: UserContext; reservationId: string; correlationId?: string }) {
  const breakdown = await computeCancellationCharge({ reservationId: input.reservationId, mode: "no_show" });
  const line = breakdown.amount > 0
    ? await chargeToFolio({ context: input.context, reservationId: input.reservationId, amount: breakdown.amount, description: breakdown.label, correlationId: input.correlationId ?? createId("corr") })
    : null;
  return { breakdown, line };
}

// --- Bulk: night-audit step ------------------------------------------------
// Finds confirmed reservations whose arrival date is in the past and that
// never checked in. Marks them as no_show and posts the no-show fee.
export async function processNoShows(input: { context: UserContext; propertyId: string; businessDate: Date; correlationId: string }) {
  const candidates = await prisma.reservation.findMany({
    where: {
      propertyId: input.propertyId,
      status: { in: ["draft", "confirmed"] },
      arrivalDate: { lt: input.businessDate }
    },
    select: { id: true, code: true, arrivalDate: true, totalAmount: true }
  });
  const results: Array<{ reservationId: string; code: string; charge: number; basis: string }> = [];
  for (const r of candidates) {
    const { breakdown } = await applyNoShowFee({ context: input.context, reservationId: r.id, correlationId: input.correlationId });
    await prisma.reservation.update({ where: { id: r.id }, data: { status: "no_show" } });
    results.push({ reservationId: r.id, code: r.code, charge: breakdown.amount, basis: breakdown.basis });
  }
  return { processedCount: results.length, totalChargedEur: round2(results.reduce((s, r) => s + r.charge, 0)), results };
}
