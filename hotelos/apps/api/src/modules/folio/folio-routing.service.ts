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
import { NotFoundError, BadRequestError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";

export async function listReservationFolios(reservationId: string) {
  // Hot-fix: cap defensively. A reservation has at most a handful of folios.
  const rows = await prisma.folio.findMany({ where: { reservationId }, orderBy: [{ isPrimary: "desc" }, { label: "asc" }], take: 50 });
  return rows;
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
  const existingPrimary = await prisma.folio.findFirst({ where: { reservationId: input.reservationId, isPrimary: true } });
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
  const target = await prisma.folio.findUnique({ where: { id: p.targetFolioId } });
  if (!target || target.reservationId !== input.reservationId) {
    throw new BadRequestError("targetFolio debe pertenecer a la misma reserva.");
  }
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

// routeLine — called from folio.service.ts right after a line is posted on the
// primary folio. If a matching rule exists (sourceType === line.type or "*"),
// the line is moved to the targetFolioId.
export async function routeLine(input: { lineId: string }) {
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
  await prisma.folioLine.update({ where: { id: line.id }, data: { folioId: match.targetFolioId } });
  return { lineId: line.id, from: folio.id, to: match.targetFolioId, ruleId: match.id };
}

// Manual move of a single line from its current folio to another folio of the
// SAME reservation. Useful for adjustments at check-out time.
export async function transferFolioLine(input: { context: UserContext; lineId: string; targetFolioId: string }) {
  const line = await prisma.folioLine.findUnique({ where: { id: input.lineId } });
  if (!line) throw new NotFoundError("Línea de folio no encontrada.");
  const current = await prisma.folio.findUnique({ where: { id: line.folioId } });
  const target = await prisma.folio.findUnique({ where: { id: input.targetFolioId } });
  if (!current || !target) throw new NotFoundError("Folio no encontrado.");
  if (current.reservationId !== target.reservationId) throw new BadRequestError("Origen y destino deben pertenecer a la misma reserva.");
  if (target.status !== "open") throw new BadRequestError("El folio destino debe estar abierto.");
  if (current.id === target.id) return line;
  return prisma.folioLine.update({ where: { id: line.id }, data: { folioId: target.id } });
}
