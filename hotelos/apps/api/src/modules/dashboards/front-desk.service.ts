import { prisma } from "@hotelos/database";
import { CHECKIN_SESSION_STATUSES, type CheckInSessionStatus } from "@hotelos/shared";
import { createDegradedCollector } from "../../lib/degraded.js";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

export type FrontDeskDashboardInput = {
  propertyId: string;
  date?: string;
};

/** Modelos del check-in automatizado (Tanda CHK · W3-D) que alimentan la capa `preCheckIn` / `suggestedRoom` / `key`. */
export type FrontDeskCheckInDb = Pick<typeof prisma, "checkInSession" | "assignmentSuggestion" | "guestPortalAction">;

/**
 * Colaboradores inyectables (Tanda UX-1 · lote U3): el test unitario
 * (`__tests__/front-desk.service.test.mts`) pasa un Prisma falso y un cálculo
 * de saldos falso; en producción se usan `prisma` y `computeBalancesForReservations`.
 *
 * Tanda CHK · W3-D: los tres modelos de check-in son opcionales en el
 * colaborador. Cuando faltan (dobles anteriores a la tanda) la capa de
 * check-in no se consulta y el resultado no lleva `preCheckIn`, `suggestedRoom`,
 * `key`, `kpis.preCheckInCompleted` ni `degraded` (contrato aditivo intacto);
 * con `prisma` real siempre se consulta.
 */
export type FrontDeskDashboardDeps = {
  db?: Pick<typeof prisma, "reservation" | "reservationGuest" | "guest" | "room" | "roomType"> & Partial<FrontDeskCheckInDb>;
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
  /**
   * Tanda CHK · W3-D: llegadas de hoy con el pre-check-in completado
   * (`CheckInSession.status` ∈ ready_for_arrival · arrived · checked_in ·
   * handed_off, mismo criterio que `listArrivals`). Ausente cuando el
   * colaborador no expone los modelos de check-in.
   */
  preCheckInCompleted?: number;
};

/** Estado del pre-check-in de una llegada (diseño §8, columna «Pre-check-in»). */
export type FrontDeskPreCheckIn = {
  /** Estado de la `CheckInSession`, o `not_invited` si la reserva no tiene sesión. */
  status: CheckInSessionStatus | "not_invited";
  /** Viajeros con datos completos, firmados o verificados (`CheckInGuest.status` ∈ data_complete · signed · verified). */
  completedGuests: number;
  /** Viajeros de la sesión (huecos `pending` incluidos); 0 sin sesión. */
  totalGuests: number;
  /** `CheckInSession.channel` (email · whatsapp · sms · kiosk · reception · manual). */
  channel?: string;
};

/** Primera candidata de la `AssignmentSuggestion` pendiente (`suggested`) de una llegada sin habitación (diseño §4b consumidores). */
export type FrontDeskSuggestedRoom = {
  suggestionId: string;
  roomId: string;
  number: string;
  /** `AssignmentReason.detail` de la candidata, en el orden del motor. */
  reasons: string[];
  /** 0..1 (`AssignmentSuggestion.confidence`). */
  confidence: number;
};

/**
 * Llave de la llegada (diseño §8, columna «Llave»): `issued` si hay una llave
 * móvil activa (`GuestPortalAction` mobile_key); `pending` si la sesión de
 * check-in sigue abierta por un canal del huésped (la llave saldrá del
 * auto-check-in); `reception` en los demás casos (tarjeta en el mostrador).
 */
export type FrontDeskKeyStatus = {
  status: "issued" | "pending" | "reception";
  serialNumber?: string;
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
  /** Tanda CHK · W3-D (presentes cuando el colaborador expone los modelos de check-in). */
  preCheckIn?: FrontDeskPreCheckIn;
  suggestedRoom?: FrontDeskSuggestedRoom;
  key?: FrontDeskKeyStatus;
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
  /**
   * Tanda CHK · W3-D (convención QC-06, lib/degraded.ts): consultas de la capa
   * de check-in que cayeron a su valor por defecto en esta respuesta
   * (`checkin_sessions` · `assignment_suggestions` · `mobile_keys`). Presente
   * siempre que se consultó la capa (array vacío si todo fue bien).
   */
  degraded?: string[];
};

// ---------------------------------------------------------------------------
// Tanda CHK · W3-D: capa de check-in de las llegadas (diseño §8 «Recepción · /hoy»).
// ---------------------------------------------------------------------------

/**
 * Estados de sesión que cuentan como pre-check-in completado. Corrector CHK
 * (REV3-09): `handed_off` (derivada a recepción: identidad por cotejar, datos
 * sin vincular, pago fallido) NO es un pre-check-in hecho y no infla el % de §1.8.
 */
export const PRECHECKIN_COMPLETED_STATUSES: ReadonlySet<string> = new Set(["ready_for_arrival", "arrived", "checked_in"]);
/** Estados de sesión abiertos: la llave saldrá del auto-check-in si el canal es del huésped. */
const PRECHECKIN_OPEN_STATUSES: ReadonlySet<string> = new Set(["invited", "in_progress", "ready_for_arrival", "arrived"]);
/** `CheckInGuest.status` que cuentan como viajero completado. */
const GUEST_COMPLETED_STATUSES: ReadonlySet<string> = new Set(["data_complete", "signed", "verified"]);

type CheckInOverlaySession = { status: CheckInSessionStatus; channel: string; completedGuests: number; totalGuests: number };

type CheckInOverlay = {
  sessionByReservation: Map<string, CheckInOverlaySession>;
  suggestionByReservation: Map<string, FrontDeskSuggestedRoom>;
  /** reservationId → serialNumber de la llave móvil activa (undefined si el payload no lo trae). */
  keyByReservation: Map<string, string | undefined>;
  degraded: string[];
};

function hasCheckInModels<T extends Partial<FrontDeskCheckInDb>>(db: T): db is T & FrontDeskCheckInDb {
  return Boolean(db.checkInSession && db.assignmentSuggestion && db.guestPortalAction);
}

function toSessionStatus(value: string): CheckInSessionStatus {
  return (CHECKIN_SESSION_STATUSES as readonly string[]).includes(value) ? (value as CheckInSessionStatus) : "invited";
}

/** Primera candidata de `candidatesJson` (AssignmentCandidate[]; misma tolerancia que `parseCandidates` de room-assignment.service). */
function firstCandidate(json: unknown): { roomId: string; number: string; reasons: string[] } | null {
  if (!Array.isArray(json)) return null;
  const first = json.find((item) => Boolean(item) && typeof item === "object" && typeof (item as { roomId?: unknown }).roomId === "string") as
    | { roomId: string; number?: unknown; reasons?: unknown }
    | undefined;
  if (!first) return null;
  const reasons = Array.isArray(first.reasons)
    ? first.reasons
        .map((reason) => (reason && typeof reason === "object" ? (reason as { detail?: unknown }).detail : undefined))
        .filter((detail): detail is string => typeof detail === "string" && detail.trim().length > 0)
    : [];
  return { roomId: first.roomId, number: typeof first.number === "string" ? first.number : first.roomId.slice(-4), reasons };
}

/**
 * Tres consultas agregadas por ids de reserva (sin N+1), cada una dentro de
 * `safe()` para que una tabla rota no vacíe la columna en silencio. Se lanzan
 * a la vez y se esperan después (misma idea que las dos rondas de Promise.all
 * del tablero; esta ronda corre en paralelo con la segunda).
 */
async function loadCheckInOverlay(
  db: FrontDeskCheckInDb,
  propertyId: string,
  arrivals: Array<{ id: string; assignedRoomId: string | null }>
): Promise<CheckInOverlay> {
  const { safe, degraded } = createDegradedCollector("dashboards.front-desk", { propertyId });
  const overlay: CheckInOverlay = { sessionByReservation: new Map(), suggestionByReservation: new Map(), keyByReservation: new Map(), degraded };
  const reservationIds = arrivals.map((r) => r.id);
  const unassignedIds = arrivals.filter((r) => !r.assignedRoomId).map((r) => r.id);
  if (reservationIds.length === 0) return overlay;

  const sessionsPromise = safe(
    "checkin_sessions",
    db.checkInSession.findMany({
      where: { propertyId, reservationId: { in: reservationIds } },
      select: { reservationId: true, status: true, channel: true, guests: { select: { status: true } } }
    }),
    []
  );
  const suggestionsPromise =
    unassignedIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; reservationId: string; candidatesJson: unknown; confidence: unknown }>)
      : safe(
          "assignment_suggestions",
          db.assignmentSuggestion.findMany({
            where: { propertyId, reservationId: { in: unassignedIds }, status: "suggested" },
            orderBy: { createdAt: "desc" },
            select: { id: true, reservationId: true, candidatesJson: true, confidence: true }
          }),
          []
        );
  const keysPromise = safe(
    "mobile_keys",
    db.guestPortalAction.findMany({
      where: { propertyId, reservationId: { in: reservationIds }, actionType: "mobile_key", status: "active" },
      orderBy: { createdAt: "desc" },
      select: { reservationId: true, payloadJson: true }
    }),
    []
  );
  const sessions = await sessionsPromise;
  const suggestions = await suggestionsPromise;
  const keys = await keysPromise;

  for (const session of sessions) {
    overlay.sessionByReservation.set(session.reservationId, {
      status: toSessionStatus(session.status),
      channel: session.channel,
      completedGuests: session.guests.filter((guest) => GUEST_COMPLETED_STATUSES.has(guest.status)).length,
      totalGuests: session.guests.length
    });
  }
  // Más reciente por reserva (orderBy createdAt desc → la primera gana).
  for (const suggestion of suggestions) {
    if (overlay.suggestionByReservation.has(suggestion.reservationId)) continue;
    const candidate = firstCandidate(suggestion.candidatesJson);
    if (!candidate) continue;
    const confidence = Number(suggestion.confidence);
    overlay.suggestionByReservation.set(suggestion.reservationId, {
      suggestionId: suggestion.id,
      roomId: candidate.roomId,
      number: candidate.number,
      reasons: candidate.reasons,
      confidence: Number.isFinite(confidence) ? confidence : 0
    });
  }
  for (const key of keys) {
    if (!key.reservationId || overlay.keyByReservation.has(key.reservationId)) continue;
    const payload = key.payloadJson && typeof key.payloadJson === "object" ? (key.payloadJson as Record<string, unknown>) : {};
    overlay.keyByReservation.set(key.reservationId, typeof payload.serialNumber === "string" ? payload.serialNumber : undefined);
  }
  return overlay;
}

function keyStatusFor(overlay: CheckInOverlay, reservationId: string): FrontDeskKeyStatus {
  if (overlay.keyByReservation.has(reservationId)) {
    const serialNumber = overlay.keyByReservation.get(reservationId);
    return serialNumber ? { status: "issued", serialNumber } : { status: "issued" };
  }
  const session = overlay.sessionByReservation.get(reservationId);
  if (session && PRECHECKIN_OPEN_STATUSES.has(session.status) && session.channel !== "reception") return { status: "pending" };
  return { status: "reception" };
}

function checkInFieldsFor(overlay: CheckInOverlay, reservationId: string): Pick<FrontDeskArrivalRow, "preCheckIn" | "suggestedRoom" | "key"> {
  const session = overlay.sessionByReservation.get(reservationId);
  const suggestedRoom = overlay.suggestionByReservation.get(reservationId);
  return {
    preCheckIn: session
      ? { status: session.status, completedGuests: session.completedGuests, totalGuests: session.totalGuests, channel: session.channel }
      : { status: "not_invited", completedGuests: 0, totalGuests: 0 },
    ...(suggestedRoom ? { suggestedRoom } : {}),
    key: keyStatusFor(overlay, reservationId)
  };
}

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

  // Tanda CHK · W3-D: capa de check-in de las llegadas (sesión, sugerencia,
  // llave). Solo depende de la primera ronda: arranca ya y corre en paralelo
  // con la segunda; se espera después. Sin modelos de check-in en el
  // colaborador → null y el resultado no cambia (contrato aditivo).
  const checkInOverlayPromise = hasCheckInModels(db) ? loadCheckInOverlay(db, propertyId, arrivalsRaw) : null;

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
  const checkInOverlay = checkInOverlayPromise ? await checkInOverlayPromise : null;

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
      specialRequests: r.specialRequests ?? r.notes ?? undefined,
      // Tanda CHK · W3-D: preCheckIn / suggestedRoom / key solo con la capa consultada.
      ...(checkInOverlay ? checkInFieldsFor(checkInOverlay, r.id) : {})
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

  // KPI (Tanda CHK · W3-D): llegadas de hoy con el pre-check-in completado.
  let preCheckInCompleted = 0;
  if (checkInOverlay) {
    for (const r of arrivalsRaw) {
      const session = checkInOverlay.sessionByReservation.get(r.id);
      if (session && PRECHECKIN_COMPLETED_STATUSES.has(session.status)) preCheckInCompleted += 1;
    }
  }

  return {
    kpis: {
      arrivalsToday: safeNumber(arrivalsRaw.length),
      arrivalsCancelledToday: safeNumber(arrivalsCancelledCount),
      departuresToday: safeNumber(departuresRaw.length),
      inHouseNow: safeNumber(inHouseRaw.length),
      unassignedRooms: safeNumber(unassignedRaw.length),
      overdueDepartures: safeNumber(overdueDeparturesCount),
      pendingBalanceEur: safeNumber(pendingBalanceEur),
      ...(checkInOverlay ? { preCheckInCompleted: safeNumber(preCheckInCompleted) } : {})
    },
    arrivals,
    departures,
    inHouse,
    unassigned,
    ...(checkInOverlay ? { degraded: checkInOverlay.degraded } : {})
  };
}
