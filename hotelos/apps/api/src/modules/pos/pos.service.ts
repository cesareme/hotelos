// Point-of-sale (TPV) — outlets + tickets with charge-to-room.
// Every ticket is persisted to Prisma as a PosOrder (+ PosOrderLine rows) with
// the SAME id as the in-memory ticket, so POS sales survive restarts and feed
// the read-only /dashboards/pos read model (modules/dashboards/pos.service.ts).
// The in-memory array is kept as a mirror cache: it is what the interactive
// board reads (it carries UI-only fields the schema does not have: outletName,
// roomNumber, settlement, closedAt) — see apps/admin-web/src/services/posApi.ts.
// Closing a ticket "to room" posts a real folio line on the in-house guest's
// reservation, integrating POS with the existing billing/folio system.
import { prisma } from "@hotelos/database";
import { getReservationFolio, postFolioLine } from "../folio/folio.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";

export type PosOutlet = { id: string; name: string; category: string };
export type PosLine = { name: string; quantity: number; unitPrice: number; total: number };
export type PosTicket = {
  id: string;
  propertyId: string;
  outletId: string;
  outletName: string;
  status: "open" | "closed";
  roomNumber?: string;
  lines: PosLine[];
  total: number;
  settlement?: "room" | "cash" | "card";
  createdAt: string;
  closedAt?: string;
};

const OUTLET_DEFS: { code: string; name: string }[] = [
  { code: "restaurant", name: "Restaurante" },
  { code: "bar", name: "Bar" },
  { code: "cafe", name: "Cafetería" },
  { code: "roomservice", name: "Room service" },
  { code: "spa", name: "Spa" }
];

const tickets: PosTicket[] = [];

// Demo tickets are seeded lazily the first time a property's board is opened, so
// the POS board is never empty on a fresh demo. Seeding only runs once per
// property per process and never blocks real ticket creation. Seeded tickets
// live in memory only; they are materialised into Prisma the first time they
// are touched (line added / closed) via ensurePosOrderRow.
const seededProperties = new Set<string>();
function seedDemoTickets(propertyId: string): void {
  if (seededProperties.has(propertyId)) return;
  seededProperties.add(propertyId);
  const mk = (outletCode: string, roomNumber: string | undefined, lines: PosLine[], status: "open" | "closed", settlement?: "room" | "cash" | "card", minsAgo = 30): PosTicket => {
    const created = new Date(Date.now() - minsAgo * 60_000).toISOString();
    return {
      id: createId("pos"), propertyId, outletId: `out_${outletCode}`, outletName: outletName(`out_${outletCode}`),
      status, roomNumber, lines, total: round2(lines.reduce((s, l) => s + l.total, 0)),
      settlement, createdAt: created, closedAt: status === "closed" ? new Date(Date.now() - (minsAgo - 5) * 60_000).toISOString() : undefined
    };
  };
  const line = (name: string, quantity: number, unitPrice: number): PosLine => ({ name, quantity, unitPrice, total: round2(quantity * unitPrice) });
  tickets.push(
    mk("restaurant", "204", [line("Menú del día", 2, 18.5), line("Copa de vino", 2, 4.5)], "open", undefined, 25),
    mk("bar", undefined, [line("Caña", 3, 3), line("Ración de jamón", 1, 14)], "open", undefined, 12),
    mk("roomservice", "312", [line("Club sándwich", 1, 16), line("Agua mineral", 2, 3)], "open", undefined, 8),
    mk("cafe", undefined, [line("Café con leche", 2, 2.4), line("Tarta de queso", 1, 5.5)], "closed", "card", 95),
    mk("restaurant", "118", [line("Cena carta", 2, 41)], "closed", "room", 140)
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function recompute(ticket: PosTicket) {
  ticket.total = round2(ticket.lines.reduce((s, l) => s + l.total, 0));
}
function outletName(outletId: string): string {
  return OUTLET_DEFS.find((o) => `out_${o.code}` === outletId)?.name ?? outletId;
}
function outletCode(posOutletId: string): string {
  return posOutletId.startsWith("out_") ? posOutletId.slice("out_".length) : posOutletId;
}

// PosOrder.outletId must reference a real Outlet row so the POS dashboard can
// label revenue per outlet. The board uses synthetic ids (out_restaurant, …)
// shared across properties, while Outlet.id is a global PK — so we resolve (or
// lazily create) one Outlet row per property+outletType and cache the mapping.
const outletRowIdCache = new Map<string, string>();
async function resolveOutletRowId(propertyId: string, posOutletId: string): Promise<string> {
  const code = outletCode(posOutletId);
  const cacheKey = `${propertyId}:${code}`;
  const cached = outletRowIdCache.get(cacheKey);
  if (cached) return cached;
  const existing = await prisma.outlet.findFirst({ where: { propertyId, outletType: code } });
  const outlet =
    existing ??
    (await prisma.outlet.create({
      data: { propertyId, name: outletName(posOutletId), outletType: code, status: "active" }
    }));
  outletRowIdCache.set(cacheKey, outlet.id);
  return outlet.id;
}

/** Best-effort room lookup — a ticket may carry a free-text room number. */
async function findRoomId(propertyId: string, roomNumber: string | undefined): Promise<string | null> {
  if (!roomNumber) return null;
  const room = await prisma.room.findFirst({ where: { propertyId, number: roomNumber }, select: { id: true } });
  return room?.id ?? null;
}

/**
 * Guarantees the PosOrder row behind a ticket exists (same id). New tickets
 * are persisted at open; seeded demo tickets are materialised here (order +
 * their current lines) the first time they are written to.
 */
async function ensurePosOrderRow(ticket: PosTicket): Promise<void> {
  const existing = await prisma.posOrder.findUnique({ where: { id: ticket.id }, select: { id: true } });
  if (existing) return;
  const outletRowId = await resolveOutletRowId(ticket.propertyId, ticket.outletId);
  const roomId = await findRoomId(ticket.propertyId, ticket.roomNumber);
  await prisma.posOrder.create({
    data: {
      id: ticket.id,
      propertyId: ticket.propertyId,
      outletId: outletRowId,
      roomId,
      status: ticket.status,
      total: ticket.total,
      createdAt: new Date(ticket.createdAt)
    }
  });
  if (ticket.lines.length > 0) {
    await prisma.posOrderLine.createMany({
      data: ticket.lines.map((line) => ({
        posOrderId: ticket.id,
        description: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        total: line.total
      }))
    });
  }
}

export function listPosOutlets(_propertyId: string): PosOutlet[] {
  return OUTLET_DEFS.map((o) => ({ id: `out_${o.code}`, name: o.name, category: o.code }));
}

export function listPosTickets(propertyId: string): PosTicket[] {
  seedDemoTickets(propertyId);
  return tickets
    .filter((t) => t.propertyId === propertyId)
    .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === "open" ? -1 : 1));
}

export async function openPosTicket(input: { propertyId: string; outletId: string; roomNumber?: string }): Promise<PosTicket> {
  const ticket: PosTicket = {
    id: createId("pos"),
    propertyId: input.propertyId,
    outletId: input.outletId,
    outletName: outletName(input.outletId),
    status: "open",
    roomNumber: input.roomNumber?.trim() || undefined,
    lines: [],
    total: 0,
    createdAt: nowIso()
  };
  // Persist first (PosOrder shares the ticket id); mirror in memory only once
  // the DB write succeeded so both stores stay consistent.
  await ensurePosOrderRow(ticket);
  tickets.push(ticket);
  return ticket;
}

export async function addPosLine(input: { ticketId: string; name: string; quantity: number; unitPrice: number }): Promise<PosTicket> {
  const ticket = tickets.find((t) => t.id === input.ticketId);
  if (!ticket) throw new NotFoundError("Comanda no encontrada.");
  if (ticket.status !== "open") throw new BadRequestError("La comanda ya está cerrada.");
  const qty = Math.max(1, Math.round(input.quantity || 1));
  const unit = round2(input.unitPrice || 0);
  const line: PosLine = { name: input.name.trim() || "Consumo", quantity: qty, unitPrice: unit, total: round2(qty * unit) };
  const newTotal = round2([...ticket.lines, line].reduce((s, l) => s + l.total, 0));

  await ensurePosOrderRow(ticket);
  // Best-effort product link so the dashboard's "top products" can attribute
  // the sale when a configured PosProduct matches the free-text line name.
  const product = await prisma.posProduct.findFirst({
    where: { propertyId: ticket.propertyId, name: { equals: line.name, mode: "insensitive" } },
    select: { id: true }
  });
  await prisma.posOrderLine.create({
    data: {
      posOrderId: ticket.id,
      productId: product?.id ?? null,
      description: line.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      total: line.total
    }
  });
  await prisma.posOrder.update({ where: { id: ticket.id }, data: { total: newTotal } });

  ticket.lines.push(line);
  recompute(ticket);
  return ticket;
}

export async function closePosTicket(input: {
  context: UserContext;
  ticketId: string;
  settlement: "room" | "cash" | "card";
  correlationId: string;
}): Promise<PosTicket> {
  const ticket = tickets.find((t) => t.id === input.ticketId);
  if (!ticket) throw new NotFoundError("Comanda no encontrada.");
  if (ticket.status !== "open") throw new BadRequestError("La comanda ya está cerrada.");
  if (ticket.lines.length === 0) throw new BadRequestError("Añade al menos un consumo antes de cerrar.");

  let chargedRoomId: string | null = null;
  let chargedReservationId: string | null = null;

  if (input.settlement === "room") {
    if (!ticket.roomNumber) throw new BadRequestError("Indica la habitación para cargar el consumo.");
    const room = await prisma.room.findFirst({ where: { propertyId: ticket.propertyId, number: ticket.roomNumber }, select: { id: true } });
    if (!room) throw new NotFoundError(`No existe la habitación ${ticket.roomNumber}.`);
    const reservation = await prisma.reservation.findFirst({
      where: { propertyId: ticket.propertyId, assignedRoomId: room.id, status: "checked_in" },
      select: { id: true }
    });
    if (!reservation) throw new BadRequestError(`No hay ningún huésped alojado en la habitación ${ticket.roomNumber}.`);
    const folio = await getReservationFolio(reservation.id);
    await postFolioLine({
      context: input.context,
      folioId: folio.folio.id,
      type: "minibar",
      description: `${ticket.outletName}: ${ticket.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}`,
      quantity: 1,
      unitPrice: ticket.total,
      correlationId: input.correlationId
    });
    chargedRoomId = room.id;
    chargedReservationId = reservation.id;
  }

  // Persist the close before mutating the in-memory mirror. PosOrder has no
  // settlement/closedAt columns (schema is out of scope here), so the DB keeps
  // status/total/room/reservation; settlement details stay on the ticket
  // mirror and — for room charges — on the posted folio line.
  await ensurePosOrderRow(ticket);
  await prisma.posOrder.update({
    where: { id: ticket.id },
    data: {
      status: "closed",
      total: ticket.total,
      ...(chargedRoomId ? { roomId: chargedRoomId } : {}),
      ...(chargedReservationId ? { reservationId: chargedReservationId } : {})
    }
  });

  ticket.status = "closed";
  ticket.settlement = input.settlement;
  ticket.closedAt = nowIso();

  // F&B inventory consumption: try to decrement stock for any ticket lines
  // that match a configured MenuItem (case-insensitive). Best-effort — a
  // failure here must not block the ticket close (POS revenue is the
  // priority, not inventory bookkeeping), but it must leave a trace.
  try {
    const { consumeStockForPosTicket } = await import("../fnb-inventory/fnb-inventory.service.js");
    await consumeStockForPosTicket({
      propertyId: ticket.propertyId,
      ticketId: ticket.id,
      outletId: ticket.outletId,
      lines: ticket.lines.map((l) => ({ name: l.name, quantity: l.quantity }))
    });
  } catch (error) {
    console.warn(
      `[pos] Stock consumption failed for ticket ${ticket.id} (property ${ticket.propertyId}, outlet ${ticket.outletId}); ticket closed but inventory was not decremented.`,
      error
    );
  }

  return ticket;
}
