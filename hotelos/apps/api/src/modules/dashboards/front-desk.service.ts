import { prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

export type FrontDeskDashboardInput = {
  propertyId: string;
  date?: string;
};

/**
 * Colaboradores inyectables (Tanda UX-1 · lote U3): el test unitario
 * (`__tests__/front-desk.service.test.mts`) pasa un Prisma falso y un cálculo
 * de saldos falso; en producción se usan `prisma` y `computeBalancesForReservations`.
 */
export type FrontDeskDashboardDeps = {
  db?: Pick<typeof prisma, "reservation" | "reservationGuest" | "guest" | "room" | "roomType">;
  computeBalances?: (reservationIds: string[]) => Promise<Map<string, number>>;
  now?: () => Date;
};

/** Campos aditivos por fila (U3 → U6): ids para `mutate`/prefetch y VIP visible en Mi día. */
export type FrontDeskRowIds = {
  /** Habitación asignada (mismo valor que `assignedRoomId`; nombre alineado con la cola y `assign-room`). */
  roomId?: string;
  roomTypeId?: string;
  assignedRoomId: string | null;
  /** `Reservation.vipFlag`. */
  vip: boolean;
};

export type FrontDeskDashboardKpis = {
  /** Arrivals still expected or already in (confirmed / checked_in) — never cancelled or no-show. */
  arrivalsToday: number;
  /** Cancelled / no-show reservations that were due to arrive today (kept visible, counted apart). */
  arrivalsCancelledToday: number;
  /** In-house or already departed guests leaving today — never cancelled or no-show. */
  departuresToday: number;
  inHouseNow: number;
  unassignedRooms: number;
  overdueDepartures: number;
  pendingBalanceEur: number;
};

export type FrontDeskArrivalRow = FrontDeskRowIds & {
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

export type FrontDeskDepartureRow = FrontDeskRowIds & {
  reservationId: string;
  guestName: string;
  departureDate: string;
  roomNumber?: string;
  balanceEur: number;
  status: string;
};

export type FrontDeskInHouseRow = FrontDeskRowIds & {
  reservationId: string;
  guestName: string;
  roomNumber?: string;
  departureDate: string;
  nightsRemaining: number;
  balanceEur: number;
  status: string;
};

export type FrontDeskUnassignedRow = FrontDeskRowIds & {
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

function rowIds(r: { assignedRoomId: string | null; roomTypeId: string | null; vipFlag: boolean }): FrontDeskRowIds {
  return {
    roomId: r.assignedRoomId ?? undefined,
    roomTypeId: r.roomTypeId ?? undefined,
    assignedRoomId: r.assignedRoomId,
    vip: r.vipFlag === true
  };
}

export async function buildFrontDeskDashboard(
  input: FrontDeskDashboardInput,
  deps: FrontDeskDashboardDeps = {}
): Promise<FrontDeskDashboardResult> {
  const db = deps.db ?? prisma;
  const computeBalances = deps.computeBalances ?? computeBalancesForReservations;
  const propertyId = input.propertyId;
  const dayStart = startOfDayUtc(input.date);
  const dayEnd = endOfDayUtc(dayStart);
  const now = deps.now ? deps.now() : new Date();

  // Pull all reservations relevant to the dashboard in a few queries.
  // REC-07: only live reservations count as arrivals/departures. Cancelled and
  // no-show rows were inflating both KPIs (and the unassigned list derived
  // from arrivals); they are counted separately in arrivalsCancelledToday.
  // Same status rule as front-desk-queue.service and room-rack.service.
  // Tanda UX-1 · U3 (F27): las cinco consultas son independientes → una sola
  // ronda con Promise.all (mismo patrón que front-desk-queue.service.ts).
  const [arrivalsRaw, arrivalsCancelledCount, departuresRaw, inHouseRaw, overdueDeparturesCount] = await Promise.all([
    db.reservation.findMany({
      where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd }, status: { in: ["confirmed", "checked_in"] } },
      orderBy: { arrivalDate: "asc" }
    }),
    db.reservation.count({
      where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd }, status: { in: ["cancelled", "no_show"] } }
    }),
    db.reservation.findMany({
      where: { propertyId, departureDate: { gte: dayStart, lt: dayEnd }, status: { in: ["checked_in", "checked_out"] } },
      orderBy: { departureDate: "asc" }
    }),
    // UX-1 (corrector L-16): «En el hotel» = alojados ahora, salgan hoy o no
    // (la lista de reservas cuenta lo mismo: status checked_in); las salidas
    // hechas quedan fuera por estado, no por fecha.
    db.reservation.findMany({
      where: {
        propertyId,
        status: "checked_in"
      },
      orderBy: { departureDate: "asc" }
    }),
    db.reservation.count({
      where: {
        propertyId,
        status: "checked_in",
        departureDate: { lt: now }
      }
    })
  ]);

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

  // Primary guest per reservation (fallback to any guest if no primary). Los
  // vínculos y luego los huéspedes son la única cadena dependiente; corre en
  // paralelo con habitaciones, tipos y saldos (segunda ronda de Promise.all).
  async function loadGuests(): Promise<{
    guestIdByReservation: Map<string, string>;
    guestById: Map<string, { firstName: string | null; surname1: string | null; surname2: string | null }>;
  }> {
    const guestIdByReservation = new Map<string, string>();
    const guestById = new Map<string, { firstName: string | null; surname1: string | null; surname2: string | null }>();
    if (reservationIds.length === 0) return { guestIdByReservation, guestById };
    const reservationGuests = await db.reservationGuest.findMany({
      where: { reservationId: { in: reservationIds } },
      select: { reservationId: true, guestId: true, isPrimary: true }
    });
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
      : await db.guest.findMany({
          where: { id: { in: guestIds } },
          select: { id: true, firstName: true, surname1: true, surname2: true }
        });
    for (const guest of guests) {
      guestById.set(guest.id, {
        firstName: guest.firstName ?? null,
        surname1: guest.surname1 ?? null,
        surname2: guest.surname2 ?? null
      });
    }
    return { guestIdByReservation, guestById };
  }

  // Per-reservation folio balances via the shared helper (Sprint 46). Batched:
  // one folio query + one folioLine groupBy + one payment query + one refund
  // groupBy, regardless of reservation count.
  const [{ guestIdByReservation, guestById }, rooms, roomTypes, balanceByReservation] = await Promise.all([
    loadGuests(),
    roomIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; number: string }>)
      : db.room.findMany({
          where: { id: { in: roomIds } },
          select: { id: true, number: true }
        }),
    roomTypeIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; name: string }>)
      : db.roomType.findMany({
          where: { id: { in: roomTypeIds } },
          select: { id: true, name: true }
        }),
    computeBalances(reservationIds)
  ]);

  // Rooms (for roomNumber).
  const roomNumberById = new Map<string, string>();
  for (const room of rooms) {
    roomNumberById.set(room.id, room.number);
  }

  // Room types (for roomTypeName).
  const roomTypeNameById = new Map<string, string>();
  for (const rt of roomTypes) {
    roomTypeNameById.set(rt.id, rt.name);
  }

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
      ...rowIds(r),
      reservationId: r.id,
      guestName: guestNameForReservation(r.id),
      arrivalDate: isoDate(r.arrivalDate),
      nights,
      roomNumber,
      roomTypeName,
      status: String(r.status),
      balanceEur: balanceForReservation(r.id),
      // The column is specialRequests; notes is the legacy fallback.
      specialRequests: r.specialRequests ?? r.notes ?? undefined
    };
  });

  // Build departures rows.
  const departures: FrontDeskDepartureRow[] = departuresRaw.map((r) => {
    const roomNumber = r.assignedRoomId ? roomNumberById.get(r.assignedRoomId) : undefined;
    return {
      ...rowIds(r),
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
      ...rowIds(r),
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
      ...rowIds(r),
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
      arrivalsCancelledToday: safeNumber(arrivalsCancelledCount),
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
