// Room Rack service — el "corazón visual" del PMS según la directriz Nov 2026.
//
// Devuelve cada habitación enriquecida con:
//   - estado físico (clean/dirty/inspected/ooo/oos/maintenance)
//   - estado HK (housekeepingStatus libre, normalizado)
//   - reserva actual (si ocupada): huésped, fecha salida, saldo, badges
//   - próxima llegada (si vacía/sucia): huésped, ETA, badges
//   - flags resumidos: vip, balance_due, special_request, hk_urgent (ETA<2h)
//
// La UI agrupa por planta y pinta tiles. La directriz exige estados:
// disponible · ocupada · sucia · en limpieza · lista · inspeccionada ·
// fuera de servicio · bloqueada · mantenimiento · VIP · incidencia ·
// late checkout · early check-in.

import { prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

export type RoomRackBadge =
  | "vip"
  | "balance_due"
  | "special_request"
  | "hk_urgent"
  | "overbooking"
  | "incident"
  | "late_checkout"
  | "early_checkin"
  | "vacant_due_soon";

export type RoomRackOccupancy =
  | "vacant_clean"
  | "vacant_dirty"
  | "occupied_stay"
  | "occupied_departing_today"
  | "checked_out_today"
  | "out_of_order"
  | "blocked_maintenance";

export type RoomRackReservation = {
  reservationId: string;
  guestName: string;
  guestId?: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  eta?: string;
  etd?: string;
  balanceDue: number;
  vip: boolean;
  loyaltyTier?: string;
  specialRequest?: string;
};

export type RoomRackTile = {
  roomId: string;
  roomNumber: string;
  floor?: string;
  roomTypeId?: string;
  roomTypeName?: string;
  status: string;                  // de Prisma RoomStatus (clean, dirty, ...)
  housekeepingStatus?: string;     // libre
  occupancy: RoomRackOccupancy;
  badges: RoomRackBadge[];
  currentReservation?: RoomRackReservation;
  nextArrival?: RoomRackReservation; // si vacía o en limpieza y llega alguien hoy
};

export type RoomRackFloor = {
  floor: string;
  rooms: RoomRackTile[];
};

export type RoomRackResult = {
  propertyId: string;
  generatedAt: string;
  floors: RoomRackFloor[];
  totals: {
    rooms: number;
    occupied: number;
    vacantClean: number;
    vacantDirty: number;
    outOfOrder: number;
    arrivalsToday: number;
    departuresToday: number;
  };
  roomTypeById: Record<string, { id: string; name: string }>;
};

function startOfDayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function fmtName(g: { firstName?: string | null; surname1?: string | null; surname2?: string | null } | null): string {
  if (!g) return "Huésped";
  const parts = [g.firstName, g.surname1, g.surname2].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" ") : "Huésped";
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

function normalizeHk(value?: string | null): string {
  if (!value) return "";
  return value.toLowerCase();
}

function isCleanHk(value?: string | null): boolean {
  const v = normalizeHk(value);
  return v === "clean" || v === "inspected" || v === "ready";
}

function isDirtyHk(value?: string | null): boolean {
  const v = normalizeHk(value);
  return v === "dirty" || v === "cleaning" || v === "in_progress" || v === "stayover";
}

export async function buildRoomRack(input: { propertyId: string; now?: Date }): Promise<RoomRackResult> {
  const propertyId = input.propertyId;
  const now = input.now ?? new Date();
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);

  const [rooms, roomTypes, inHouse, arrivalsToday, departuresToday, openWorkOrders] = await Promise.all([
    prisma.room.findMany({ where: { propertyId, active: true }, orderBy: [{ floor: "asc" }, { number: "asc" }] }),
    prisma.roomType.findMany({ where: { propertyId } }),
    prisma.reservation.findMany({
      where: { propertyId, status: "checked_in" },
      orderBy: { departureDate: "asc" }
    }),
    prisma.reservation.findMany({
      where: {
        propertyId,
        arrivalDate: { gte: today, lt: tomorrow },
        status: { in: ["confirmed", "checked_in"] }
      },
      orderBy: { eta: "asc" }
    }),
    prisma.reservation.findMany({
      where: {
        propertyId,
        departureDate: { gte: today, lt: tomorrow },
        status: { in: ["checked_in", "checked_out"] }
      }
    }),
    prisma.workOrder.findMany({
      where: { propertyId, status: { in: ["open", "in_progress"] } },
      select: { id: true, roomId: true, priority: true, title: true }
    }).catch(() => [])
  ]);

  const roomTypeById = new Map(roomTypes.map((t) => [t.id, t]));
  const workOrdersByRoom = new Map<string, Array<{ id: string; priority?: string | null; title: string }>>();
  for (const wo of openWorkOrders) {
    if (!wo.roomId) continue;
    const list = workOrdersByRoom.get(wo.roomId) ?? [];
    list.push({ id: wo.id, priority: wo.priority, title: wo.title });
    workOrdersByRoom.set(wo.roomId, list);
  }

  // Reservas relevantes (in-house + llegadas + salidas) deduplicadas
  const relevantReservationIds = new Set<string>();
  for (const r of [...inHouse, ...arrivalsToday, ...departuresToday]) relevantReservationIds.add(r.id);
  const relevantIds = Array.from(relevantReservationIds);

  // Guests vinculados
  const links = relevantIds.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: relevantIds } },
        select: { reservationId: true, guestId: true, isPrimary: true }
      })
    : [];
  const primaryGuestByReservation = new Map<string, string>();
  for (const link of links) {
    if (link.isPrimary) primaryGuestByReservation.set(link.reservationId, link.guestId);
  }
  for (const link of links) {
    if (!primaryGuestByReservation.has(link.reservationId)) primaryGuestByReservation.set(link.reservationId, link.guestId);
  }
  const guestIds = Array.from(new Set(Array.from(primaryGuestByReservation.values())));
  const guests = guestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: guestIds } },
        select: { id: true, firstName: true, surname1: true, surname2: true, vipCode: true, loyaltyTier: true }
      })
    : [];
  const guestById = new Map(guests.map((g) => [g.id, g]));

  // Balances
  const balances = await computeBalancesForReservations(relevantIds);

  const reservationsById = new Map<string, (typeof inHouse)[number]>();
  for (const r of [...inHouse, ...arrivalsToday, ...departuresToday]) reservationsById.set(r.id, r);

  function buildResForRack(reservationId: string): RoomRackReservation | undefined {
    const r = reservationsById.get(reservationId);
    if (!r) return undefined;
    const guestId = primaryGuestByReservation.get(r.id);
    const guest = guestId ? guestById.get(guestId) : undefined;
    return {
      reservationId: r.id,
      guestId,
      guestName: fmtName(guest ?? null),
      status: String(r.status),
      arrivalDate: isoDate(r.arrivalDate),
      departureDate: isoDate(r.departureDate),
      eta: r.eta ?? undefined,
      etd: r.etd ?? undefined,
      balanceDue: balances.get(r.id) ?? 0,
      vip: Boolean(guest?.vipCode || (guest?.loyaltyTier && /platinum|gold|diamond/i.test(guest.loyaltyTier))),
      loyaltyTier: guest?.loyaltyTier ?? undefined,
      specialRequest: r.specialRequests ?? r.notes ?? undefined
    };
  }

  // Mapa de habitación → reserva actual (in-house) y próxima llegada (arrivalsToday).
  const currentByRoomId = new Map<string, RoomRackReservation>();
  for (const r of inHouse) {
    if (!r.assignedRoomId) continue;
    const enriched = buildResForRack(r.id);
    if (enriched) currentByRoomId.set(r.assignedRoomId, enriched);
  }
  const nextArrivalByRoomId = new Map<string, RoomRackReservation>();
  for (const r of arrivalsToday) {
    if (!r.assignedRoomId) continue;
    // Skip if room ya tiene currentReservation (entonces ya hay un huésped)
    if (currentByRoomId.has(r.assignedRoomId)) continue;
    const enriched = buildResForRack(r.id);
    if (enriched) nextArrivalByRoomId.set(r.assignedRoomId, enriched);
  }

  const departureRoomIds = new Set<string>();
  for (const r of departuresToday) {
    if (r.assignedRoomId) departureRoomIds.add(r.assignedRoomId);
  }

  const hourNow = now.getUTCHours();

  // Build tiles
  const tiles: RoomRackTile[] = rooms.map((room) => {
    const current = currentByRoomId.get(room.id);
    const next = nextArrivalByRoomId.get(room.id);
    const hk = normalizeHk(room.housekeepingStatus);
    const isOoo = room.status === "out_of_order" || hk === "out_of_order" || hk === "oo";
    const isBlocked = !room.sellable;
    const workOrders = workOrdersByRoom.get(room.id) ?? [];
    const hasOpenIncident = workOrders.length > 0;

    let occupancy: RoomRackOccupancy;
    if (isOoo) occupancy = "out_of_order";
    else if (isBlocked || hasOpenIncident) occupancy = "blocked_maintenance";
    else if (current) {
      // ¿sale hoy?
      if (departureRoomIds.has(room.id) && current.status === "checked_in") {
        occupancy = "occupied_departing_today";
      } else {
        occupancy = "occupied_stay";
      }
    } else if (isCleanHk(room.housekeepingStatus) || room.status === "clean") {
      occupancy = "vacant_clean";
    } else {
      occupancy = "vacant_dirty";
    }
    // Si está vacía-limpia y tiene una llegada hoy, marcamos "vacant_due_soon" como badge.

    const badges: RoomRackBadge[] = [];
    const focusRes = current ?? next;
    if (focusRes?.vip) badges.push("vip");
    if (focusRes && focusRes.balanceDue > 0.01) badges.push("balance_due");
    if (focusRes?.specialRequest) badges.push("special_request");
    if (hasOpenIncident) badges.push("incident");
    if (occupancy === "occupied_departing_today" && hourNow >= 14) badges.push("late_checkout");
    if (next) {
      badges.push("vacant_due_soon");
      // HK urgente si ETA <= 2h y la habitación no está limpia.
      const etaHour = next.eta ? parseInt(next.eta.slice(0, 2), 10) : NaN;
      if (Number.isFinite(etaHour) && etaHour - hourNow <= 2 && !isCleanHk(room.housekeepingStatus)) {
        badges.push("hk_urgent");
      }
      // Early check-in si ETA < 14:00
      if (Number.isFinite(etaHour) && etaHour < 14) badges.push("early_checkin");
    }

    const roomType = room.roomTypeId ? roomTypeById.get(room.roomTypeId) : undefined;
    return {
      roomId: room.id,
      roomNumber: room.number,
      floor: room.floor ?? undefined,
      roomTypeId: room.roomTypeId ?? undefined,
      roomTypeName: roomType?.name ?? undefined,
      status: String(room.status),
      housekeepingStatus: room.housekeepingStatus ?? undefined,
      occupancy,
      badges,
      currentReservation: current,
      nextArrival: next
    };
  });

  // Group por planta (mantiene orden numérico del room number dentro de la planta).
  const floorsMap = new Map<string, RoomRackTile[]>();
  for (const tile of tiles) {
    const key = tile.floor ?? "—";
    const list = floorsMap.get(key) ?? [];
    list.push(tile);
    floorsMap.set(key, list);
  }
  const floors: RoomRackFloor[] = Array.from(floorsMap.entries())
    .sort(([a], [b]) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    })
    .map(([floor, list]) => ({
      floor,
      rooms: list.sort((x, y) => x.roomNumber.localeCompare(y.roomNumber, undefined, { numeric: true }))
    }));

  const totals = {
    rooms: tiles.length,
    occupied: tiles.filter((t) => t.occupancy === "occupied_stay" || t.occupancy === "occupied_departing_today").length,
    vacantClean: tiles.filter((t) => t.occupancy === "vacant_clean").length,
    vacantDirty: tiles.filter((t) => t.occupancy === "vacant_dirty").length,
    outOfOrder: tiles.filter((t) => t.occupancy === "out_of_order" || t.occupancy === "blocked_maintenance").length,
    arrivalsToday: arrivalsToday.length,
    departuresToday: departuresToday.length
  };

  const roomTypeMap: Record<string, { id: string; name: string }> = {};
  for (const rt of roomTypes) roomTypeMap[rt.id] = { id: rt.id, name: rt.name };

  return {
    propertyId,
    generatedAt: now.toISOString(),
    floors,
    totals,
    roomTypeById: roomTypeMap
  };
}
