// Folio routing — split a reservation's charges across multiple folios so
// different parties (guest, company, travel agent) can be billed separately.
//
// Standard PMS pattern, implemented in three pieces:
//  1. listReservationFolios / createSecondaryFolio — surface and add folios
//     on the same reservation.
//  2. createRule / listRules — declarative rules (source line type → target
//     folio) evaluated when a new line is posted.
//  3. routeLine — used by folio.service.ts after a line lands on the primary
//     folio to move it to the right secondary folio if a rule matches.
//  4. transferFolioLine — manual reassignment of an existing line to another
//     folio on the same reservation.
import { prisma } from "@hotelos/database";
import { NotFoundError, BadRequestError, ConflictError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";

export async function listReservationFolios(reservationId: string) {
  // Hot-fix: cap defensively. A reservation has at most a handful of folios.
  const rows = await prisma.folio.findMany({ where: { reservationId, deletedAt: null }, orderBy: [{ isPrimary: "desc" }, { label: "asc" }], take: 50 });
  return rows;
}

/**
 * Resolve and validate the target folio of a routing rule. The target must be
 * an OPEN folio of the SAME reservation: a missing, soft-deleted or foreign
 * folio answers an opaque 404 (never confirm that another reservation's folio
 * id exists), a closed one answers 409 — routing charges into a closed folio
 * would silently reopen settled money.
 */
async function assertRoutingTarget(reservationId: string, targetFolioId: string) {
  const target = await prisma.folio.findUnique({ where: { id: targetFolioId } });
  if (!target || target.deletedAt || target.reservationId !== reservationId) {
    throw new NotFoundError("Folio destino no encontrado en esta reserva.");
  }
  if (target.status !== "open") {
    throw new ConflictError("El folio destino está cerrado; elige un folio abierto para la regla de routing.");
  }
  return target;
}

export async function createSecondaryFolio(input: {
  context: UserContext;
  reservationId: string;
  payload: { label: string; guestId?: string | null; currency?: string };
}) {
  const r = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!r) throw new NotFoundError("Reserva no encontrada.");
  if (!input.payload.label?.trim()) throw new BadRequestError("label es obligatorio (p. ej. «company», «travel_agent»).");
  // Ensure a primary folio exists; the first folio is always primary.
  const existingPrimary = await prisma.folio.findFirst({ where: { reservationId: input.reservationId, isPrimary: true, deletedAt: null } });
  if (!existingPrimary) {
    await prisma.folio.create({ data: { reservationId: input.reservationId, status: "open", currency: r.currency ?? "EUR", label: "guest", isPrimary: true } });
  }
  return prisma.folio.create({
    data: {
      reservationId: input.reservationId,
      guestId: input.payload.guestId ?? null,
      status: "open",
      currency: input.payload.currency ?? r.currency ?? "EUR",
      label: input.payload.label.trim(),
      isPrimary: false
    }
  });
}

export async function listRoutingRules(reservationId: string) {
  // Hot-fix: cap defensively. A reservation has at most a few dozen rules.
  return prisma.folioRoutingRule.findMany({
    where: { reservationId },
    orderBy: [{ active: "desc" }, { priority: "asc" }, { createdAt: "asc" }],
    take: 200
  });
}

export async function createRoutingRule(input: {
  context: UserContext;
  reservationId: string;
  payload: { sourceType: string; targetFolioId: string; priority?: number; notes?: string; active?: boolean };
}) {
  const p = input.payload;
  if (!p.sourceType?.trim()) throw new BadRequestError("sourceType es obligatorio.");
  if (!p.targetFolioId) throw new BadRequestError("targetFolioId es obligatorio.");
  await assertRoutingTarget(input.reservationId, p.targetFolioId);
  return prisma.folioRoutingRule.create({
    data: {
      reservationId: input.reservationId,
      sourceType: p.sourceType.trim().toLowerCase(),
      targetFolioId: p.targetFolioId,
      priority: p.priority ?? 0,
      notes: p.notes ?? null,
      active: p.active ?? true
    }
  });
}

export async function updateRoutingRule(input: { context: UserContext; id: string; payload: Partial<{ sourceType: string; targetFolioId: string; priority: number; notes: string; active: boolean }> }) {
  const existing = await prisma.folioRoutingRule.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Regla de routing no encontrada.");
  if (input.payload.targetFolioId !== undefined) {
    // Re-pointing a rule is subject to the same target validation as creation.
    await assertRoutingTarget(existing.reservationId, input.payload.targetFolioId);
  }
  const data: Record<string, unknown> = {};
  for (const k of ["sourceType", "targetFolioId", "priority", "notes", "active"]) {
    if ((input.payload as Record<string, unknown>)[k] !== undefined) data[k] = (input.payload as Record<string, unknown>)[k];
  }
  return prisma.folioRoutingRule.update({ where: { id: input.id }, data });
}

export async function deleteRoutingRule(id: string) {
  const existing = await prisma.folioRoutingRule.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Regla de routing no encontrada.");
  await prisma.folioRoutingRule.delete({ where: { id } });
  return { ok: true, id };
}

export type RouteLineFailureReason = "target_folio_closed" | "target_folio_not_found" | "target_folio_foreign_reservation";

export type RouteLineResult = {
  lineId: string;
  /** Folio the line was on when routing ran. */
  from: string;
  /** Folio the line lives on after routing (equals `from` when not routed). */
  to: string;
  ruleId: string;
  routed: boolean;
  reason?: RouteLineFailureReason;
};

/** Pure check of a rule target against the origin folio; null when routable. */
export function routingTargetFailure(
  origin: { reservationId: string },
  target: { reservationId: string; status: string; deletedAt: Date | null } | null
): RouteLineFailureReason | null {
  if (!target || target.deletedAt) return "target_folio_not_found";
  if (target.reservationId !== origin.reservationId) return "target_folio_foreign_reservation";
  if (target.status !== "open") return "target_folio_closed";
  return null;
}

async function resolveReservationScope(
  reservationId: string,
  context: UserContext | undefined
): Promise<{ organizationId: string; propertyId: string | undefined }> {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { propertyId: true } });
  const property = reservation
    ? await prisma.property.findUnique({ where: { id: reservation.propertyId }, select: { organizationId: true } })
    : null;
  return {
    organizationId: property?.organizationId ?? context?.organizationId ?? "unknown",
    propertyId: reservation?.propertyId ?? context?.propertyId
  };
}

// routeLine — called from folio.service.ts (and the POS) right after a line is
// posted on the primary folio. If a matching rule exists (sourceType ===
// line.type or "*"), the line is moved to the targetFolioId.
//
// Money-path guard: the target must still be an OPEN folio of the same
// reservation. Otherwise the line is NOT moved — it stays on the origin folio
// where it remains collectable — and the failure is made visible (QC-06):
// console.error with correlation + FOLIO_ROUTING_FAILED audit event. No error
// is thrown so the caller's post is not blocked; genuine failures (DB errors)
// still propagate to the caller's honest catch.
export async function routeLine(input: { lineId: string; context?: UserContext; correlationId?: string }): Promise<RouteLineResult | null> {
  const line = await prisma.folioLine.findUnique({ where: { id: input.lineId } });
  if (!line) return null;
  const folio = await prisma.folio.findUnique({ where: { id: line.folioId } });
  if (!folio) return null;
  // Only auto-route lines that landed on the PRIMARY folio (avoid loops).
  if (!folio.isPrimary) return null;
  const rules = await prisma.folioRoutingRule.findMany({
    where: { reservationId: folio.reservationId, active: true },
    orderBy: { priority: "asc" }
  });
  const match = rules.find((r) => r.sourceType === line.type || r.sourceType === "*");
  if (!match) return null;
  if (match.targetFolioId === folio.id) return null;

  const target = await prisma.folio.findUnique({ where: { id: match.targetFolioId } });
  const reason = routingTargetFailure(folio, target);
  if (reason) {
    const correlationId = input.correlationId ?? `line:${line.id}`;
    const scope = await resolveReservationScope(folio.reservationId, input.context);
    console.error(
      `[folio.routing] rule ${match.id} could not route line ${line.id} (${line.type}) from folio ${folio.id} to ${match.targetFolioId}: ${reason}; charge stays on the origin folio (reservation ${folio.reservationId}, correlationId ${correlationId})`
    );
    recordAuditEvent({
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      actorUserId: input.context?.userId,
      actorType: "system",
      action: "FOLIO_ROUTING_FAILED",
      entityType: "folio_line",
      entityId: line.id,
      afterJson: {
        lineId: line.id,
        folioId: folio.id,
        lineType: line.type,
        ruleId: match.id,
        targetFolioId: match.targetFolioId,
        targetStatus: target?.status ?? null,
        reason
      },
      correlationId
    });
    return { lineId: line.id, from: folio.id, to: folio.id, ruleId: match.id, routed: false, reason };
  }

  await prisma.folioLine.update({ where: { id: line.id }, data: { folioId: match.targetFolioId } });
  return { lineId: line.id, from: folio.id, to: match.targetFolioId, ruleId: match.id, routed: true };
}

// Manual move of a single line from its current folio to another folio of the
// SAME reservation. Useful for adjustments at check-out time.
export async function transferFolioLine(input: { context: UserContext; lineId: string; targetFolioId: string }) {
  const line = await prisma.folioLine.findUnique({ where: { id: input.lineId } });
  if (!line) throw new NotFoundError("Línea de folio no encontrada.");
  const current = await prisma.folio.findUnique({ where: { id: line.folioId } });
  const target = await prisma.folio.findUnique({ where: { id: input.targetFolioId } });
  if (!current || current.deletedAt || !target || target.deletedAt) throw new NotFoundError("Folio no encontrado.");
  if (current.reservationId !== target.reservationId) throw new BadRequestError("Origen y destino deben pertenecer a la misma reserva.");
  if (target.status !== "open") throw new ConflictError("El folio destino está cerrado; no admite más cargos ni movimientos.");
  if (current.id === target.id) return line;
  return prisma.folioLine.update({ where: { id: line.id }, data: { folioId: target.id } });
}
