import { prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

export type FrontDeskDashboardInput = {
  propertyId: string;
  date?: string;
};

export type FrontDeskDashboardKpis = {
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  unassignedRooms: number;
  overdueDepartures: number;
  pendingBalanceEur: number;
};

export type FrontDeskArrivalRow = {
  reservationId: string;
  guestName: string;
  arrivalDate: string;
  nights: number;
  roomNumber?: string;
  roomTypeName?: string;
  status: string;
  balanceEur: number;
  specialRequests?: string;
};

export type FrontDeskDepartureRow = {
  reservationId: string;
  guestName: string;
  departureDate: string;
  roomNumber?: string;
  balanceEur: number;
  status: string;
};

export type FrontDeskInHouseRow = {
  reservationId: string;
  guestName: string;
  roomNumber?: string;
  departureDate: string;
  nightsRemaining: number;
  balanceEur: number;
  status: string;
};

export type FrontDeskUnassignedRow = {
  reservationId: string;
  guestName: string;
  arrivalDate: string;
  roomTypeName?: string;
  preferences?: string;
};

export type FrontDeskDashboardResult = {
  kpis: FrontDeskDashboardKpis;
  arrivals: FrontDeskArrivalRow[];
  departures: FrontDeskDepartureRow[];
  inHouse: FrontDeskInHouseRow[];
  unassigned: FrontDeskUnassignedRow[];
};

function startOfDayUtc(input?: string): Date {
  if (input) {
    const trimmed = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return new Date(`${trimmed}T00:00:00.000Z`);
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
    }
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function endOfDayUtc(start: Date): Date {
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function safeNumber(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return value;
}

function isoDate(value: Date | string): string {
  if (typeof value === "string") return value.length >= 10 ? value.slice(0, 10) : value;
  return value.toISOString().slice(0, 10);
}

function nightsBetween(arrival: Date, departure: Date): number {
  const ms = departure.getTime() - arrival.getTime();
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  return days > 0 ? days : 0;
}

function formatGuestName(parts: { firstName?: string | null; surname1?: string | null; surname2?: string | null }): string {
  const pieces = [parts.firstName, parts.surname1, parts.surname2].filter((p): p is string => Boolean(p && p.trim()));
  return pieces.length > 0 ? pieces.join(" ") : "(unknown guest)";
}

export async function buildFrontDeskDashboard(
  input: FrontDeskDashboardInput
): Promise<FrontDeskDashboardResult> {
  const propertyId = input.propertyId;
  const dayStart = startOfDayUtc(input.date);
  const dayEnd = endOfDayUtc(dayStart);
  const now = new Date();

  // Pull all reservations relevant to the dashboard in a few queries.
  const arrivalsRaw = await prisma.reservation.findMany({
    where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd } },
    orderBy: { arrivalDate: "asc" }
  });

  const departuresRaw = await prisma.reservation.findMany({
    where: { propertyId, departureDate: { gte: dayStart, lt: dayEnd } },
    orderBy: { departureDate: "asc" }
  });

  const inHouseRaw = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: "checked_in",
      departureDate: { gt: now }
    },
    orderBy: { departureDate: "asc" }
  });

  const overdueDeparturesCount = await prisma.reservation.count({
    where: {
      propertyId,
      status: "checked_in",
      departureDate: { lt: now }
    }
  });

  const unassignedRaw = arrivalsRaw.filter((r) => !r.assignedRoomId);

  // Collect IDs needed for joins.
  const reservationIds = Array.from(
    new Set([
      ...arrivalsRaw.map((r) => r.id),
      ...departuresRaw.map((r) => r.id),
      ...inHouseRaw.map((r) => r.id)
    ])
  );
  const roomIds = Array.from(
    new Set(
      [
        ...arrivalsRaw.map((r) => r.assignedRoomId),
        ...departuresRaw.map((r) => r.assignedRoomId),
        ...inHouseRaw.map((r) => r.assignedRoomId)
      ].filter((id): id is string => Boolean(id))
    )
  );
  const roomTypeIds = Array.from(
    new Set(
      [
        ...arrivalsRaw.map((r) => r.roomTypeId),
        ...departuresRaw.map((r) => r.roomTypeId),
        ...inHouseRaw.map((r) => r.roomTypeId)
      ].filter((id): id is string => Boolean(id))
    )
  );

  // Primary guest per reservation (fallback to any guest if no primary).
  const reservationGuests = reservationIds.length === 0
    ? []
    : await prisma.reservationGuest.findMany({
        where: { reservationId: { in: reservationIds } },
        select: { reservationId: true, guestId: true, isPrimary: true }
      });
  const guestIdByReservation = new Map<string, string>();
  // Pass 1: primaries.
  for (const link of reservationGuests) {
    if (link.isPrimary && !guestIdByReservation.has(link.reservationId)) {
      guestIdByReservation.set(link.reservationId, link.guestId);
    }
  }
  // Pass 2: fill in remaining with any guest.
  for (const link of reservationGuests) {
    if (!guestIdByReservation.has(link.reservationId)) {
      guestIdByReservation.set(link.reservationId, link.guestId);
    }
  }
  const guestIds = Array.from(new Set(Array.from(guestIdByReservation.values())));
  const guests = guestIds.length === 0
    ? []
    : await prisma.guest.findMany({
        where: { id: { in: guestIds } },
        select: { id: true, firstName: true, surname1: true, surname2: true }
      });
  const guestById = new Map<string, { firstName: string | null; surname1: string | null; surname2: string | null }>();
  for (const guest of guests) {
    guestById.set(guest.id, {
      firstName: guest.firstName ?? null,
      surname1: guest.surname1 ?? null,
      surname2: guest.surname2 ?? null
    });
  }

  // Rooms (for roomNumber).
  const rooms = roomIds.length === 0
    ? []
    : await prisma.room.findMany({
        where: { id: { in: roomIds } },
        select: { id: true, number: true }
      });
  const roomNumberById = new Map<string, string>();
  for (const room of rooms) {
    roomNumberById.set(room.id, room.number);
  }

  // Room types (for roomTypeName).
  const roomTypes = roomTypeIds.length === 0
    ? []
    : await prisma.roomType.findMany({
        where: { id: { in: roomTypeIds } },
        select: { id: true, name: true }
      });
  const roomTypeNameById = new Map<string, string>();
  for (const rt of roomTypes) {
    roomTypeNameById.set(rt.id, rt.name);
  }

  // Per-reservation folio balances via the shared helper (Sprint 46). Batched:
  // one folio query + one folioLine groupBy + one payment query + one refund
  // groupBy, regardless of reservation count.
  const balanceByReservation = await computeBalancesForReservations(reservationIds);

  function balanceForReservation(reservationId: string): number {
    return balanceByReservation.get(reservationId) ?? 0;
  }

  function guestNameForReservation(reservationId: string): string {
    const guestId = guestIdByReservation.get(reservationId);
    if (!guestId) return "(unknown guest)";
    const guest = guestById.get(guestId);
    if (!guest) return "(unknown guest)";
    return formatGuestName(guest);
  }

  // Build arrivals rows.
  const arrivals: FrontDeskArrivalRow[] = arrivalsRaw.map((r) => {
    const roomNumber = r.assignedRoomId ? roomNumberById.get(r.assignedRoomId) : undefined;
    const roomTypeName = r.roomTypeId ? roomTypeNameById.get(r.roomTypeId) : undefined;
    const nights = nightsBetween(r.arrivalDate, r.departureDate);
    return {
      reservationId: r.id,
      guestName: guestNameForReservation(r.id),
      arrivalDate: isoDate(r.arrivalDate),
      nights,
      roomNumber,
      roomTypeName,
      status: String(r.status),
      balanceEur: balanceForReservation(r.id),
      specialRequests: r.notes ?? undefined
    };
  });

  // Build departures rows.
  const departures: FrontDeskDepartureRow[] = departuresRaw.map((r) => {
    const roomNumber = r.assignedRoomId ? roomNumberById.get(r.assignedRoomId) : undefined;
    return {
      reservationId: r.id,
      guestName: guestNameForReservation(r.id),
      departureDate: isoDate(r.departureDate),
      roomNumber,
      balanceEur: balanceForReservation(r.id),
      status: String(r.status)
    };
  });

  // Build in-house rows.
  const inHouse: FrontDeskInHouseRow[] = inHouseRaw.map((r) => {
    const roomNumber = r.assignedRoomId ? roomNumberById.get(r.assignedRoomId) : undefined;
    const nightsRemaining = Math.max(0, Math.ceil((r.departureDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    return {
      reservationId: r.id,
      guestName: guestNameForReservation(r.id),
      roomNumber,
      departureDate: isoDate(r.departureDate),
      nightsRemaining,
      balanceEur: balanceForReservation(r.id),
      status: String(r.status)
    };
  });

  // Build unassigned rows.
  const unassigned: FrontDeskUnassignedRow[] = unassignedRaw.map((r) => {
    const roomTypeName = r.roomTypeId ? roomTypeNameById.get(r.roomTypeId) : undefined;
    return {
      reservationId: r.id,
      guestName: guestNameForReservation(r.id),
      arrivalDate: isoDate(r.arrivalDate),
      roomTypeName,
      preferences: r.notes ?? undefined
    };
  });

  // KPI: pending balance — sum of positive balances across arrivals + in-house + departures (deduped).
  const balanceReservationIds = new Set<string>();
  for (const r of [...arrivalsRaw, ...departuresRaw, ...inHouseRaw]) {
    balanceReservationIds.add(r.id);
  }
  let pendingBalanceEur = 0;
  for (const reservationId of balanceReservationIds) {
    const balance = balanceForReservation(reservationId);
    if (balance > 0) pendingBalanceEur += balance;
  }
  pendingBalanceEur = Math.round(pendingBalanceEur * 100) / 100;

  return {
    kpis: {
      arrivalsToday: safeNumber(arrivalsRaw.length),
      departuresToday: safeNumber(departuresRaw.length),
      inHouseNow: safeNumber(inHouseRaw.length),
      unassignedRooms: safeNumber(unassignedRaw.length),
      overdueDepartures: safeNumber(overdueDeparturesCount),
      pendingBalanceEur: safeNumber(pendingBalanceEur)
    },
    arrivals,
    departures,
    inHouse,
    unassigned
  };
}
