// Point-of-sale (TPV) — outlets + tickets with charge-to-room.
// Tickets are held in-memory for the demo (same lifetime as the demo store).
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
// property per process and never blocks real ticket creation.
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

export function listPosOutlets(_propertyId: string): PosOutlet[] {
  return OUTLET_DEFS.map((o) => ({ id: `out_${o.code}`, name: o.name, category: o.code }));
}

export function listPosTickets(propertyId: string): PosTicket[] {
  seedDemoTickets(propertyId);
  return tickets
    .filter((t) => t.propertyId === propertyId)
    .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === "open" ? -1 : 1));
}

export function openPosTicket(input: { propertyId: string; outletId: string; roomNumber?: string }): PosTicket {
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
  tickets.push(ticket);
  return ticket;
}

export function addPosLine(input: { ticketId: string; name: string; quantity: number; unitPrice: number }): PosTicket {
  const ticket = tickets.find((t) => t.id === input.ticketId);
  if (!ticket) throw new NotFoundError("Comanda no encontrada.");
  if (ticket.status !== "open") throw new BadRequestError("La comanda ya está cerrada.");
  const qty = Math.max(1, Math.round(input.quantity || 1));
  const unit = round2(input.unitPrice || 0);
  ticket.lines.push({ name: input.name.trim() || "Consumo", quantity: qty, unitPrice: unit, total: round2(qty * unit) });
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
  }

  ticket.status = "closed";
  ticket.settlement = input.settlement;
  ticket.closedAt = nowIso();

  // F&B inventory consumption: try to decrement stock for any ticket lines
  // that match a configured MenuItem (case-insensitive). Best-effort — a
  // failure here must not block the ticket close (POS revenue is the
  // priority, not inventory bookkeeping).
  try {
    const { consumeStockForPosTicket } = await import("../fnb-inventory/fnb-inventory.service.js");
    await consumeStockForPosTicket({
      propertyId: ticket.propertyId,
      ticketId: ticket.id,
      outletId: ticket.outletId,
      lines: ticket.lines.map((l) => ({ name: l.name, quantity: l.quantity }))
    });
  } catch {
    // swallow — inventory is observability, not a hard requirement
  }

  return ticket;
}
