// Front Desk Action Queue — cola priorizada de "lo que debe hacer recepción
// ahora". Reemplaza la mentalidad de "dashboard de listas" por una secuencia
// ordenada de problemas + acción recomendada.
//
// Directriz (Nov 2026):
//   "HotelOS no es un PMS para guardar datos. Es un sistema para que el hotel
//    actúe mejor, más rápido y con menos errores."
//
// Detectores incluidos (orden por prioridad descendente):
//   1.  overbooking            · dos reservas activas en la misma habitación
//   2.  no_show_risk           · llegada de hoy + pasaron las 19:00 + sigue confirmed
//   3.  late_checkout_overdue  · salida hoy + pasaron las 14:00 + sigue checked_in
//   4.  incident_open          · incidencia/work order activo en habitación ocupada
//   5.  unassigned_arrival     · llegada de hoy sin habitación asignada → recomienda
//                                primera habitación limpia del mismo room type
//   6.  checkin_blocked        · llegada de hoy + room asignado pero NO limpio
//   7.  housekeeping_late      · habitación sucia + llegada en <2h (mismo room type)
//   8.  open_balance           · folio con saldo > 0 + salida hoy
//   9.  checkout_pending       · salida hoy + sigue checked_in
//  10.  checkin_ready          · llegada hoy + room limpio + sigue confirmed → 1-clic
//  11.  vip_arriving           · guest VIP llega hoy
//  12.  repeat_arriving        · guest con ≥1 estancia anterior (checked_out)
//
// Tanda CHK · W3-D (diseño §4b consumidores, §4d handoffs, §8 «Cola de acciones»),
// leídos de CheckInSession / AssignmentSuggestion / SesHospedajesSubmission:
//  13.  identity_review        · sesión handed_off (identity_review · identity_mismatch) → urgente
//  14.  minor_without_guardian · sesión handed_off (menor sin adulto) → urgente
//  15.  room_not_ready         · sesión handed_off (habitación no lista al llegar) → urgente
//  16.  payment_failed         · sesión handed_off (pago rechazado / sin PSP) → hoy
//  17.  ses_rejected           · parte SES rechazado hoy → hoy
//  18.  assignment_suggested   · llegada de MAÑANA sin habitación con sugerencia
//                                pendiente (lote de las 18:00) → confirmar en un clic
//  19.  precheckin_ready       · sesión ready_for_arrival → «Hacer check-in»
//                                (sustituye a checkin_ready para esa reserva)
//  20.  self_checkin_done      · sesión checked_in por el huésped (portal) o el
//                                kiosco en las últimas 12 h → informativo
//   ·   unassigned_arrival     · si hay AssignmentSuggestion `suggested`, la
//                                recomendación es la 1.ª candidata del motor con
//                                sus motivos y la acción `confirm_assignment`
//                                (2.ª y 3.ª como acciones secundarias).
//
// Cada item incluye:
//   - priority: "urgent" | "today" | "soon"
//   - title: cabecera corta
//   - context: línea de detalle (huésped, hora, habitación, motivo)
//   - recommendation: texto natural con el siguiente paso ("La 405 está limpia
//                     y es Doble Vista Mar. ¿Asignar?")
//   - action: { label, kind, payload } — el frontend traduce kind a navegación
//             o a una mutación API (asignar habitación, marcar como no-show…)
//
// El servicio devuelve la cola completa, ordenada y deduplicada. La UI decide
// cuántos items mostrar.

import { prisma } from "@hotelos/database";
// Tanda L5 (lote A): limpieza por el helper único del estado unificado.
import { roomStateOf } from "../housekeeping/room-state.service.js";
import { createDegradedCollector } from "../../lib/degraded.js";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

// ===========================================================================
// Tipos públicos
// ===========================================================================

export type FrontDeskQueuePriority = "urgent" | "today" | "soon";

export type FrontDeskQueueKind =
  | "overbooking"
  | "no_show_risk"
  | "late_checkout_overdue"
  | "incident_open"
  | "unassigned_arrival"
  | "checkin_blocked"
  | "housekeeping_late"
  | "open_balance"
  | "checkout_pending"
  | "checkin_ready"
  | "vip_arriving"
  | "repeat_arriving"
  // Tanda CHK · W3-D
  | "precheckin_ready"
  | "assignment_suggested"
  | "self_checkin_done"
  | "identity_review"
  | "minor_without_guardian"
  | "room_not_ready"
  | "payment_failed"
  | "ses_rejected";

export type FrontDeskQueueActionKind =
  | "open_reservation"           // navega al detalle de la reserva
  | "open_room_rack"             // abre el room rack en una habitación
  | "open_housekeeping"          // navega a HK
  | "open_work_order"            // navega a mantenimiento / incidencia
  | "assign_room"                // mutación: asigna roomId a la reserva
  | "mark_no_show"               // mutación: marca como no-show
  | "open_folio"                 // navega al folio
  | "open_guest"                 // navega a la ficha de huésped
  | "start_checkin"              // arranca el flujo de check-in en 90s
  | "start_checkout"             // arranca el flujo de check-out
  // Tanda CHK · W3-D
  | "confirm_assignment"         // mutación: POST /assignment-suggestions/:id/confirm · payload { suggestionId, roomId, roomNumber, reservationId }
  | "open_precheckin";           // navega al pre-check-in de la reserva · payload { reservationId }

/** Modelos Prisma que lee la cola (inyectables en tests; `prisma` real por defecto). */
export type FrontDeskQueueDb = Pick<
  typeof prisma,
  "reservation" | "room" | "workOrder" | "reservationGuest" | "guest" | "checkInSession" | "assignmentSuggestion" | "sesHospedajesSubmission"
>;

/**
 * Colaboradores inyectables (Tanda CHK · W3-D, mismo patrón que
 * `FrontDeskDashboardDeps`): `__tests__/front-desk-checkin.test.mts` pasa un
 * Prisma falso y saldos falsos; en producción se usan `prisma` y
 * `computeBalancesForReservations`. El parche de delegados de
 * tests/integration/l2-robustez sigue funcionando porque `db` es el mismo objeto.
 */
export type FrontDeskQueueDeps = {
  db?: FrontDeskQueueDb;
  computeBalances?: (reservationIds: string[]) => Promise<Map<string, number>>;
};

export type FrontDeskQueueAction = {
  label: string;
  kind: FrontDeskQueueActionKind;
  payload?: Record<string, string | number | boolean | undefined>;
};

export type FrontDeskQueueItem = {
  id: string;
  priority: FrontDeskQueuePriority;
  kind: FrontDeskQueueKind;
  title: string;
  context: string;
  recommendation?: string;
  primaryAction?: FrontDeskQueueAction;
  secondaryActions?: FrontDeskQueueAction[];
  reservationId?: string;
  guestId?: string;
  roomId?: string;
  workOrderId?: string;
  dueAt?: string; // ISO datetime — opcional, ordena dentro de la misma priority
};

export type FrontDeskQueueResult = {
  generatedAt: string;
  items: FrontDeskQueueItem[];
  counts: Record<FrontDeskQueueKind, number>;
  summary: {
    urgent: number;
    today: number;
    soon: number;
    total: number;
  };
  /**
   * Tanda L2 (L2-06, QC-06): secondary sources that fell back to empty in this
   * response ("work_orders"; Tanda CHK · W3-D: "checkin_sessions",
   * "assignment_suggestions", "assignment_suggestions_tomorrow", "ses_rejected").
   */
  degraded: string[];
};

// ===========================================================================
// Helpers
// ===========================================================================

/** Día UTC de `now` (W3-D: antes leía el reloj real e ignoraba `input.now`; sin `now` es lo mismo). */
function startOfDayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ventana del detector self_checkin_done. */
const SELF_CHECKIN_WINDOW_MS = 12 * 60 * 60 * 1000;

/** `CheckInSession.handoffKind` → kind de cola (diseño §4d). Kinds no listados (group_arrival, walk_in…) no generan ítem en este lote. */
const HANDOFF_QUEUE_KIND: Record<string, Extract<FrontDeskQueueKind, "identity_review" | "minor_without_guardian" | "room_not_ready" | "payment_failed">> = {
  identity_review: "identity_review",
  identity_mismatch: "identity_review",
  minor_without_guardian: "minor_without_guardian",
  room_not_ready: "room_not_ready",
  payment_failed: "payment_failed"
};

const HANDOFF_COPY: Record<
  "identity_review" | "minor_without_guardian" | "room_not_ready" | "payment_failed",
  { priority: FrontDeskQueuePriority; title: string; recommendation: string }
> = {
  identity_review: {
    priority: "urgent",
    title: "Revisar identidad",
    recommendation: "Coteja el documento en el mostrador y marca la identidad como verificada antes de entregar la llave."
  },
  minor_without_guardian: {
    priority: "urgent",
    title: "Menor sin adulto responsable",
    recommendation: "Identifica al adulto responsable de la reserva antes de firmar el parte del menor."
  },
  room_not_ready: {
    priority: "urgent",
    title: "Habitación no lista para el auto-check-in",
    recommendation: "Prioriza la limpieza con pisos o reasigna una habitación limpia de la misma categoría."
  },
  payment_failed: {
    priority: "today",
    title: "Pago rechazado",
    recommendation: "Cobra en el mostrador o envía un nuevo enlace de pago antes de completar el check-in."
  }
};

/** Candidatas de `AssignmentSuggestion.candidatesJson` (misma tolerancia que `parseCandidates` de room-assignment.service). */
type QueueCandidate = { roomId: string; number: string; reasons: string[] };

function candidatesOf(json: unknown): QueueCandidate[] {
  if (!Array.isArray(json)) return [];
  const out: QueueCandidate[] = [];
  for (const item of json) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { roomId?: unknown; number?: unknown; reasons?: unknown };
    if (typeof candidate.roomId !== "string") continue;
    const reasons = Array.isArray(candidate.reasons)
      ? candidate.reasons
          .map((reason) => (reason && typeof reason === "object" ? (reason as { detail?: unknown }).detail : undefined))
          .filter((detail): detail is string => typeof detail === "string" && detail.trim().length > 0)
      : [];
    out.push({ roomId: candidate.roomId, number: typeof candidate.number === "string" ? candidate.number : candidate.roomId.slice(-4), reasons });
  }
  return out;
}

/** «La 312: Inspeccionada esta mañana · Planta alta como pidió (confianza 80 %)». */
function describeCandidate(candidate: QueueCandidate, confidence: number): string {
  const motives = candidate.reasons.slice(0, 2);
  const pct = Number.isFinite(confidence) ? Math.round(Math.max(0, Math.min(1, confidence)) * 100) : null;
  return `la ${candidate.number}${motives.length ? `: ${motives.join(" · ")}` : ""}${pct !== null ? ` (confianza ${pct} %)` : ""}`;
}

function confirmAssignmentAction(label: string, suggestionId: string, reservationId: string, candidate: QueueCandidate): FrontDeskQueueAction {
  return {
    label,
    kind: "confirm_assignment",
    payload: { suggestionId, roomId: candidate.roomId, roomNumber: candidate.number, reservationId }
  };
}

function elapsedLabel(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60000));
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `hace ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

function fmtName(g: { firstName?: string | null; surname1?: string | null; surname2?: string | null } | null): string {
  if (!g) return "Huésped";
  const parts = [g.firstName, g.surname1, g.surname2].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" ") : "Huésped";
}

function priorityWeight(p: FrontDeskQueuePriority): number {
  if (p === "urgent") return 0;
  if (p === "today") return 1;
  return 2;
}

const KIND_ORDER: FrontDeskQueueKind[] = [
  "overbooking",
  "no_show_risk",
  "late_checkout_overdue",
  "incident_open",
  "unassigned_arrival",
  "checkin_blocked",
  "housekeeping_late",
  "open_balance",
  "checkout_pending",
  "checkin_ready",
  "vip_arriving",
  "repeat_arriving",
  // Tanda CHK · W3-D (después de los existentes: el orden previo no cambia).
  "identity_review",
  "minor_without_guardian",
  "room_not_ready",
  "payment_failed",
  "ses_rejected",
  "assignment_suggested",
  "precheckin_ready",
  "self_checkin_done"
];

/** Todos los kinds están en KIND_ORDER (`counts` los cubre todos). */
export const FRONT_DESK_QUEUE_KINDS: readonly FrontDeskQueueKind[] = KIND_ORDER;

function kindWeight(k: FrontDeskQueueKind): number {
  const idx = KIND_ORDER.indexOf(k);
  return idx === -1 ? 99 : idx;
}

// ===========================================================================
// Builder principal
// ===========================================================================

export async function buildFrontDeskQueue(
  input: { propertyId: string; now?: Date; limit?: number },
  deps: FrontDeskQueueDeps = {}
): Promise<FrontDeskQueueResult> {
  const db = deps.db ?? prisma;
  const computeBalances = deps.computeBalances ?? computeBalancesForReservations;
  const propertyId = input.propertyId;
  const now = input.now ?? new Date();
  const dayStart = startOfDayUtc(now);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const items: FrontDeskQueueItem[] = [];

  // Pagination guard rails. Default 100, caller may override within [1, 500].
  const rawLimit = input.limit;
  const take = Number.isFinite(rawLimit as number)
    ? Math.min(500, Math.max(1, Math.floor(rawLimit as number)))
    : 100;

  // ----------------------------------------------------------------------
  // Carga base: llegadas, salidas, in-house, habitaciones, guests, work orders.
  // ----------------------------------------------------------------------
  const { safe, degraded } = createDegradedCollector("dashboards.front-desk-queue", { propertyId });
  const [arrivalsToday, departuresToday, inHouseAll, allRooms, openWorkOrders] = await Promise.all([
    db.reservation.findMany({
      where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd }, status: { in: ["confirmed", "checked_in", "no_show"] } },
      orderBy: { eta: "asc" },
      take
    }),
    db.reservation.findMany({
      where: { propertyId, departureDate: { gte: dayStart, lt: dayEnd }, status: { in: ["checked_in", "checked_out"] } },
      orderBy: { etd: "asc" },
      take
    }),
    db.reservation.findMany({
      where: { propertyId, status: "checked_in" },
      take
    }),
    db.room.findMany({ where: { propertyId, active: true }, take: Math.max(take, 500) }),
    // Work orders. Tanda L2 (L2-06): a failed query is logged and reported in
    // `degraded[]` (was `.catch(() => [])`: a broken table looked like «sin incidencias»).
    safe(
      "work_orders",
      db.workOrder.findMany({
        where: { propertyId, status: { in: ["open", "in_progress"] } },
        orderBy: { createdAt: "asc" },
        take
      }),
      []
    )
  ]);

  // Map de habitaciones por id (para resolver número, housekeeping status).
  const roomById = new Map(allRooms.map((r) => [r.id, r]));
  // Habitaciones limpias e inspeccionadas y libres (sin reserva activa) por room type.
  const occupiedRoomIds = new Set(
    [...inHouseAll.map((r) => r.assignedRoomId), ...arrivalsToday.map((r) => r.assignedRoomId)]
      .filter((id): id is string => Boolean(id))
  );
  const cleanByRoomType = new Map<string, typeof allRooms>();
  /** Candidatas ya propuestas a otra llegada (L-22). */
  const suggestedRoomIds = new Set<string>();
  for (const room of allRooms) {
    if (!room.roomTypeId) continue;
    // Tanda L5: estado unificado — limpia por housekeepingStatus (helper único).
    const state = roomStateOf(room);
    if (state.occupancy === "out_of_order" || state.occupancy === "out_of_service" || state.isBlocked) continue;
    if (!state.isClean) continue;
    if (occupiedRoomIds.has(room.id)) continue;
    const list = cleanByRoomType.get(room.roomTypeId) ?? [];
    list.push(room);
    cleanByRoomType.set(room.roomTypeId, list);
  }

  // Guest names para llegadas/salidas/in-house.
  const allReservationIds = [
    ...arrivalsToday.map((r) => r.id),
    ...departuresToday.map((r) => r.id),
    ...inHouseAll.map((r) => r.id)
  ];
  // Tanda CHK · W3-D: la capa de check-in se lee en la misma ronda que los
  // vínculos (todas dependen solo de las llegadas), cada consulta dentro de
  // `safe()`: una tabla rota deja la cola sin esos ítems y lo declara en `degraded[]`.
  const arrivalIds = arrivalsToday.map((r) => r.id);
  const arrivalIdSet = new Set(arrivalIds);
  const selfCheckInSince = new Date(now.getTime() - SELF_CHECKIN_WINDOW_MS);
  const [reservationGuests, sessions, suggestions, sesRejected] = await Promise.all([
    allReservationIds.length
      ? db.reservationGuest.findMany({
          where: { reservationId: { in: allReservationIds } },
          select: { reservationId: true, guestId: true, isPrimary: true },
          take: Math.max(take, 500)
        })
      : Promise.resolve([]),
    // Sesiones de las llegadas de hoy + auto-check-ins recientes (aunque la
    // llegada fuera ayer por la noche).
    safe(
      "checkin_sessions",
      db.checkInSession.findMany({
        where: {
          propertyId,
          OR: [{ reservationId: { in: arrivalIds } }, { status: "checked_in", checkedInAt: { gte: selfCheckInSince } }]
        },
        select: {
          id: true,
          reservationId: true,
          status: true,
          channel: true,
          kioskDeviceId: true,
          handoffKind: true,
          handoffReason: true,
          etaDeclared: true,
          checkedInAt: true,
          guests: { select: { status: true } }
        },
        take: Math.max(take, 500)
      }),
      []
    ),
    // Sugerencias pendientes de la propiedad (llegadas de hoy sin habitación y
    // lote de mañana); la más reciente por reserva gana (orderBy desc).
    safe(
      "assignment_suggestions",
      db.assignmentSuggestion.findMany({
        where: { propertyId, status: "suggested" },
        orderBy: { createdAt: "desc" },
        select: { id: true, reservationId: true, candidatesJson: true, confidence: true },
        take: Math.max(take, 500)
      }),
      []
    ),
    safe(
      "ses_rejected",
      db.sesHospedajesSubmission.findMany({
        where: { propertyId, status: "rejected", updatedAt: { gte: dayStart } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, reservationId: true, errorCode: true, updatedAt: true },
        take
      }),
      []
    )
  ]);
  const primaryGuestId = new Map<string, string>();
  for (const link of reservationGuests) {
    if (link.isPrimary) primaryGuestId.set(link.reservationId, link.guestId);
  }
  for (const link of reservationGuests) {
    if (!primaryGuestId.has(link.reservationId)) primaryGuestId.set(link.reservationId, link.guestId);
  }
  const guestIds = Array.from(new Set(Array.from(primaryGuestId.values())));

  const sessionByReservation = new Map(sessions.map((session) => [session.reservationId, session] as const));
  const suggestionByReservation = new Map<string, (typeof suggestions)[number]>();
  for (const suggestion of suggestions) {
    if (!suggestionByReservation.has(suggestion.reservationId)) suggestionByReservation.set(suggestion.reservationId, suggestion);
  }
  const suggestedElsewhereIds = Array.from(suggestionByReservation.keys()).filter((id) => !arrivalIdSet.has(id));

  const [guests, priorLinks, tomorrowSuggested] = await Promise.all([
    guestIds.length
      ? db.guest.findMany({
          where: { id: { in: guestIds } },
          select: { id: true, firstName: true, surname1: true, surname2: true, vipCode: true, loyaltyTier: true, documentNumber: true },
          take: Math.max(take, 500)
        })
      : Promise.resolve([]),
    // Para "repeat_arriving": cuenta de estancias anteriores por guestId.
    guestIds.length
      ? db.reservationGuest.findMany({
          where: {
            guestId: { in: guestIds },
            reservation: { propertyId, status: "checked_out", departureDate: { lt: dayStart } }
          },
          select: { guestId: true, reservationId: true },
          take: Math.max(take, 500)
        })
      : Promise.resolve([]),
    // Detector 18: reservas de MAÑANA sin habitación con sugerencia pendiente.
    suggestedElsewhereIds.length
      ? safe(
          "assignment_suggestions_tomorrow",
          db.reservation.findMany({
            where: {
              id: { in: suggestedElsewhereIds },
              propertyId,
              status: "confirmed",
              assignedRoomId: null,
              arrivalDate: { gte: dayEnd, lt: new Date(dayEnd.getTime() + DAY_MS) }
            },
            select: { id: true, code: true, eta: true },
            orderBy: { eta: "asc" },
            take
          }),
          []
        )
      : Promise.resolve([])
  ]);
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const priorStaysByGuest = new Map<string, number>();
  for (const link of priorLinks) {
    priorStaysByGuest.set(link.guestId, (priorStaysByGuest.get(link.guestId) ?? 0) + 1);
  }

  // Reservas conocidas por id (llegadas + in-house) para los detectores que parten de la sesión o del parte SES.
  const reservationById = new Map<string, (typeof arrivalsToday)[number]>();
  for (const res of [...arrivalsToday, ...inHouseAll]) reservationById.set(res.id, res);

  // Folio balances de llegadas + salidas + in-house.
  const balances = await computeBalances(allReservationIds);
  const balanceFor = (id: string) => balances.get(id) ?? 0;
  const nameFor = (resId: string) => {
    const gid = primaryGuestId.get(resId);
    if (!gid) return "Huésped";
    return fmtName(guestById.get(gid) ?? null);
  };

  // Hora actual del día (h) para detectar no-show y late checkout.
  const hour = now.getUTCHours();

  // ----------------------------------------------------------------------
  // Detector 1: OVERBOOKING — dos reservas activas en la misma habitación
  // dentro de las próximas 14 noches.
  // ----------------------------------------------------------------------
  const overbookingHorizon = new Date(dayStart.getTime() + 14 * 24 * 60 * 60 * 1000);
  const overbookingCandidates = await db.reservation.findMany({
    where: {
      propertyId,
      status: { in: ["confirmed", "checked_in"] },
      assignedRoomId: { not: null },
      departureDate: { gt: dayStart },
      arrivalDate: { lt: overbookingHorizon }
    },
    select: { id: true, assignedRoomId: true, arrivalDate: true, departureDate: true },
    take: Math.max(take, 500)
  });
  const byRoom = new Map<string, Array<{ id: string; arrival: Date; departure: Date }>>();
  for (const r of overbookingCandidates) {
    if (!r.assignedRoomId) continue;
    const list = byRoom.get(r.assignedRoomId) ?? [];
    list.push({ id: r.id, arrival: r.arrivalDate, departure: r.departureDate });
    byRoom.set(r.assignedRoomId, list);
  }
  for (const [roomId, list] of byRoom.entries()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.arrival.getTime() - b.arrival.getTime());
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const curr = list[i];
      if (curr.arrival < prev.departure) {
        const room = roomById.get(roomId);
        items.push({
          id: `overbooking_${prev.id}_${curr.id}`,
          priority: "urgent",
          kind: "overbooking",
          title: `Solape en habitación ${room?.number ?? roomId.slice(-4)}`,
          context: `Dos reservas activas en las mismas fechas. Hay que reasignar una antes de la llegada.`,
          recommendation: "Reubica la reserva más reciente a una habitación equivalente disponible.",
          reservationId: curr.id,
          roomId,
          primaryAction: { label: "Resolver conflicto", kind: "open_room_rack", payload: { roomId } }
        });
      }
    }
  }

  // ----------------------------------------------------------------------
  // Iteramos las LLEGADAS de hoy: cubre los detectores 2, 5, 6, 7, 10, 11, 12.
  // ----------------------------------------------------------------------
  for (const res of arrivalsToday) {
    if (res.status === "no_show") continue; // ya marcada
    const guestId = primaryGuestId.get(res.id);
    const guest = guestId ? guestById.get(guestId) : undefined;
    const guestName = fmtName(guest ?? null);
    const room = res.assignedRoomId ? roomById.get(res.assignedRoomId) : undefined;
    const etaHour = res.eta ? parseInt(res.eta.slice(0, 2), 10) : NaN;
    const etaLabel = res.eta ? ` · ETA ${res.eta}` : "";

    // Detector 2: no_show_risk — pasaron 19:00 y sigue confirmed.
    // No usamos `continue`: una llegada en riesgo de no-show puede ser VIP o
    // recurrente, y a recepción le importa saberlo igual.
    let noShowFlagged = false;
    if (res.status === "confirmed" && hour >= 19) {
      items.push({
        id: `no_show_${res.id}`,
        priority: "urgent",
        kind: "no_show_risk",
        title: `Posible no-show · ${guestName}`,
        context: `Llegada prevista hoy${etaLabel}. Ya pasan de las 19:00 y no ha hecho check-in.`,
        recommendation: "Llama o envía un WhatsApp para confirmar. Si no aparece antes del cierre, márcala como no-show. Si llega ahora, puedes hacer el check-in directamente.",
        reservationId: res.id,
        guestId: guest?.id,
        primaryAction: { label: "Contactar huésped", kind: "open_guest", payload: { guestId: guest?.id ?? "" } },
        secondaryActions: [
          { label: "Hacer check-in", kind: "start_checkin", payload: { reservationId: res.id } },
          { label: "Marcar no-show", kind: "mark_no_show", payload: { reservationId: res.id } }
        ]
      });
      noShowFlagged = true;
    }

    // Tanda CHK · W3-D — detectores 19 y 13-16 a partir de la CheckInSession.
    // Van ANTES de unassigned_arrival (que hace `continue`): un handoff del
    // kiosco importa aunque la reserva no tenga habitación.
    const session = sessionByReservation.get(res.id);
    const preCheckInReady = Boolean(session && session.status === "ready_for_arrival" && res.status === "confirmed" && !noShowFlagged);
    if (session && preCheckInReady) {
      const completed = session.guests.filter((g) => ["data_complete", "signed", "verified"].includes(g.status)).length;
      const roomReady = room ? roomStateOf(room).isClean : false;
      items.push({
        id: `precheckin_ready_${res.id}`,
        priority: "today",
        kind: "precheckin_ready",
        title: `Pre-check-in completo · ${guestName}`,
        context: `${completed}/${session.guests.length} viajeros con datos y firma${session.etaDeclared ? ` · llegada declarada ${session.etaDeclared}` : etaLabel}${room ? ` · Hab. ${room.number}` : " · sin habitación"}.`,
        recommendation: roomReady
          ? "Todo listo: coteja el documento y entrega la llave (≤ 90 s)."
          : room
            ? "El huésped ya lo tiene todo hecho; falta que la habitación esté lista."
            : "El huésped ya lo tiene todo hecho; falta asignarle habitación.",
        reservationId: res.id,
        guestId: guest?.id,
        roomId: room?.id,
        primaryAction: { label: "Hacer check-in", kind: "start_checkin", payload: { reservationId: res.id } },
        secondaryActions: [{ label: "Ver pre-check-in", kind: "open_precheckin", payload: { reservationId: res.id } }]
      });
    }
    if (session && session.status === "handed_off" && res.status === "confirmed") {
      const handoffKind = HANDOFF_QUEUE_KIND[session.handoffKind ?? ""];
      if (handoffKind) {
        const copy = HANDOFF_COPY[handoffKind];
        const origin = session.channel === "kiosk" || session.kioskDeviceId ? "Derivado desde el kiosco" : "Derivado desde el portal";
        items.push({
          id: `${handoffKind}_${res.id}`,
          priority: copy.priority,
          kind: handoffKind,
          title: `${copy.title} · ${guestName}`,
          context: `${origin}${etaLabel}${room ? ` · Hab. ${room.number}` : ""}${session.handoffReason ? ` · ${session.handoffReason}` : ""}.`,
          recommendation: copy.recommendation,
          reservationId: res.id,
          guestId: guest?.id,
          roomId: room?.id,
          primaryAction: { label: "Abrir pre-check-in", kind: "open_precheckin", payload: { reservationId: res.id } },
          secondaryActions: [{ label: "Hacer check-in", kind: "start_checkin", payload: { reservationId: res.id } }]
        });
      }
    }

    // Detector 5: unassigned_arrival — sin habitación asignada.
    // Si ya marcamos no_show_risk, evitamos duplicar el flag de "haz algo".
    if (!res.assignedRoomId && res.status === "confirmed" && !noShowFlagged) {
      // Tanda CHK · W3-D (diseño §4b consumidores): si el motor dejó una
      // AssignmentSuggestion `suggested`, la recomendación es su 1.ª candidata
      // con motivos y la acción es confirmar (2.ª y 3.ª como alternativas).
      // Se descartan candidatas ya ocupadas, bloqueadas, inactivas o
      // propuestas a otra llegada (L-22); sin candidata válida, lógica previa.
      const stored = suggestionByReservation.get(res.id);
      const storedCandidates = stored
        ? candidatesOf(stored.candidatesJson).filter((candidate) => {
            const candidateRoom = roomById.get(candidate.roomId);
            if (!candidateRoom || occupiedRoomIds.has(candidate.roomId) || suggestedRoomIds.has(candidate.roomId)) return false;
            const state = roomStateOf(candidateRoom);
            return !(state.occupancy === "out_of_order" || state.occupancy === "out_of_service" || state.isBlocked);
          })
        : [];
      const top = storedCandidates[0];
      if (stored && top) {
        suggestedRoomIds.add(top.roomId);
        const confidence = Number(stored.confidence);
        items.push({
          id: `unassigned_${res.id}`,
          priority: "urgent",
          kind: "unassigned_arrival",
          title: `Sin habitación · ${guestName}`,
          context: `Llega hoy${etaLabel}. No tiene habitación asignada.`,
          recommendation: `El motor propone ${describeCandidate(top, confidence)}. ¿Confirmar?`,
          reservationId: res.id,
          guestId: guest?.id,
          primaryAction: confirmAssignmentAction(`Confirmar ${top.number}`, stored.id, res.id, top),
          secondaryActions: [
            ...storedCandidates.slice(1, 3).map((candidate) => confirmAssignmentAction(`Asignar ${candidate.number}`, stored.id, res.id, candidate)),
            { label: "Ver room rack", kind: "open_room_rack", payload: { propertyId } }
          ]
        });
        continue;
      }
      const candidates = res.roomTypeId ? cleanByRoomType.get(res.roomTypeId) ?? [] : [];
      // L-22: dos llegadas del mismo tipo nunca reciben la misma candidata.
      const suggestion = candidates.find((candidate) => !suggestedRoomIds.has(candidate.id));
      if (suggestion) suggestedRoomIds.add(suggestion.id);
      const roomTypeLabel = res.roomTypeId ? "" : "";
      items.push({
        id: `unassigned_${res.id}`,
        priority: "urgent",
        kind: "unassigned_arrival",
        title: `Sin habitación · ${guestName}`,
        context: `Llega hoy${etaLabel}${roomTypeLabel}. No tiene habitación asignada.`,
        recommendation: suggestion
          ? `La ${suggestion.number} está limpia y es del mismo tipo. ¿Asignar?`
          : "No hay habitaciones limpias del mismo tipo. Revisa upgrades o llama a housekeeping.",
        reservationId: res.id,
        guestId: guest?.id,
        primaryAction: suggestion
          ? { label: `Asignar ${suggestion.number}`, kind: "assign_room", payload: { reservationId: res.id, roomId: suggestion.id, roomNumber: suggestion.number } }
          : { label: "Abrir reserva", kind: "open_reservation", payload: { reservationId: res.id } },
        secondaryActions: [{ label: "Ver room rack", kind: "open_room_rack", payload: { propertyId } }]
      });
      continue;
    }

    // Detector 6 + 10: checkin_blocked vs checkin_ready. Sólo si no flageamos
    // ya no_show_risk (no tiene sentido sugerir "haz check-in" cuando hay riesgo
    // de que el huésped ni siquiera aparezca).
    if (res.status === "confirmed" && room && !noShowFlagged) {
      // Tanda L5: limpia por housekeepingStatus (helper único), sin alias ni fallback a status.
      const roomState = roomStateOf(room);
      const hk = roomState.cleanliness;
      const isClean = roomState.isClean;
      if (!isClean) {
        // Detector 7: housekeeping_late — si la llegada está en <2h.
        const isImminent = Number.isFinite(etaHour) && etaHour - hour <= 2 && etaHour >= hour;
        items.push({
          id: `checkin_blocked_${res.id}`,
          priority: isImminent ? "urgent" : "today",
          kind: isImminent ? "housekeeping_late" : "checkin_blocked",
          title: `Habitación no lista · ${room.number}`,
          context: `${guestName} llega${etaLabel}. La ${room.number} está ${cleanlinessLabel(hk)}.`,
          recommendation: isImminent
            ? "Prioriza la limpieza con housekeeping o reasigna a una habitación limpia."
            : "Pide a housekeeping que adelante la limpieza de esta habitación.",
          reservationId: res.id,
          roomId: room.id,
          primaryAction: { label: "Avisar housekeeping", kind: "open_housekeeping", payload: { roomNumber: room.number } },
          secondaryActions: [{ label: "Buscar alternativa", kind: "open_room_rack", payload: { roomId: room.id } }]
        });
        continue;
      }
      // Detector 10: checkin_ready. W3-D: si ya hay precheckin_ready para la
      // reserva (misma acción «Hacer check-in», más contexto) no se duplica.
      if (!preCheckInReady) {
        items.push({
          id: `checkin_ready_${res.id}`,
          priority: "today",
          kind: "checkin_ready",
          title: `Listo para check-in · ${guestName}`,
          context: `Hab. ${room.number}${etaLabel}. La habitación está lista.`,
          recommendation: "Pulsa para arrancar el flujo de check-in (≤ 90 s).",
          reservationId: res.id,
          guestId: guest?.id,
          roomId: room.id,
          primaryAction: { label: "Hacer check-in", kind: "start_checkin", payload: { reservationId: res.id } },
          secondaryActions: [{ label: "Ver reserva", kind: "open_reservation", payload: { reservationId: res.id } }]
        });
      }
    }

    // Detector 11: VIP
    if (guest?.vipCode || (guest?.loyaltyTier && /platinum|gold|diamond/i.test(guest.loyaltyTier))) {
      items.push({
        id: `vip_${res.id}`,
        priority: "today",
        kind: "vip_arriving",
        title: `VIP llega hoy · ${guestName}`,
        context: `${guest.vipCode ?? guest.loyaltyTier}${etaLabel}${room ? ` · Hab. ${room.number}` : ""}.`,
        recommendation: "Confirma con dirección los detalles de bienvenida (amenity, upgrade, atención).",
        reservationId: res.id,
        guestId: guest.id,
        primaryAction: { label: "Ver perfil", kind: "open_guest", payload: { guestId: guest.id } }
      });
    }

    // Detector 12: repeat_arriving
    const priorStays = guest ? (priorStaysByGuest.get(guest.id) ?? 0) : 0;
    if (priorStays > 0) {
      items.push({
        id: `repeat_${res.id}`,
        priority: "soon",
        kind: "repeat_arriving",
        title: `Cliente recurrente · ${guestName}`,
        context: `${priorStays} estancia${priorStays === 1 ? "" : "s"} previa${priorStays === 1 ? "" : "s"}${etaLabel}.`,
        recommendation: "Reconócelo en el check-in y revisa preferencias del histórico.",
        reservationId: res.id,
        guestId: guest?.id,
        primaryAction: { label: "Ver histórico", kind: "open_guest", payload: { guestId: guest?.id ?? "" } }
      });
    }
  }

  // ----------------------------------------------------------------------
  // Iteramos SALIDAS de hoy: detectores 3, 8, 9.
  // ----------------------------------------------------------------------
  for (const res of departuresToday) {
    const guestName = nameFor(res.id);
    const room = res.assignedRoomId ? roomById.get(res.assignedRoomId) : undefined;
    const balance = balanceFor(res.id);
    const etdHour = res.etd ? parseInt(res.etd.slice(0, 2), 10) : NaN;

    if (res.status === "checked_in") {
      // Detector 3: late_checkout_overdue — pasaron las 14:00.
      if (hour >= 14) {
        items.push({
          id: `late_checkout_${res.id}`,
          priority: "urgent",
          kind: "late_checkout_overdue",
          title: `Late checkout sin resolver · Hab. ${room?.number ?? "—"}`,
          context: `${guestName} debería haber salido. Es tarde y sigue alojado.`,
          recommendation: "Confirma si autoriza late checkout (puede llevar cargo) o cierra la estancia.",
          reservationId: res.id,
          roomId: room?.id,
          primaryAction: { label: "Hacer check-out", kind: "start_checkout", payload: { reservationId: res.id } }
        });
      } else {
        // Detector 9: checkout_pending — salida hoy, sigue in-house.
        items.push({
          id: `checkout_${res.id}`,
          priority: "today",
          kind: "checkout_pending",
          title: `Check-out pendiente · Hab. ${room?.number ?? "—"}`,
          context: `${guestName} sale hoy${Number.isFinite(etdHour) ? ` · ETD ${res.etd}` : ""}.`,
          recommendation: balance > 0
            ? `Saldo pendiente €${balance.toFixed(2)}. Cobra antes de cerrar el folio.`
            : "Folio saldado. Pulsa para hacer check-out.",
          reservationId: res.id,
          roomId: room?.id,
          primaryAction: { label: "Hacer check-out", kind: "start_checkout", payload: { reservationId: res.id } }
        });
      }
    }

    // Detector 8: open_balance — salida hoy con saldo > 0 (puede solapar con checkout_pending pero
    // sólo añadimos si no se cubrió ya con late_checkout o si la reserva ya está checked_out con deuda).
    if (balance > 0 && res.status === "checked_out") {
      items.push({
        id: `open_balance_${res.id}`,
        priority: "urgent",
        kind: "open_balance",
        title: `Folio sin cobrar · Hab. ${room?.number ?? "—"}`,
        context: `${guestName} ya hizo check-out con €${balance.toFixed(2)} de saldo.`,
        recommendation: "Contacta al huésped y reclama el saldo o aplica una baja contable.",
        reservationId: res.id,
        primaryAction: { label: "Abrir folio", kind: "open_folio", payload: { reservationId: res.id } }
      });
    }
  }

  // ----------------------------------------------------------------------
  // Detector 4: INCIDENT_OPEN — work orders en habitaciones in-house.
  // ----------------------------------------------------------------------
  const inHouseRoomIds = new Set(inHouseAll.map((r) => r.assignedRoomId).filter((id): id is string => Boolean(id)));
  for (const wo of openWorkOrders as Array<{ id: string; propertyId: string; roomId?: string | null; title: string; priority?: string | null; status: string; createdAt: Date }>) {
    if (!wo.roomId) continue;
    const room = roomById.get(wo.roomId);
    if (!room) continue;
    const inHouse = inHouseRoomIds.has(wo.roomId);
    items.push({
      id: `incident_${wo.id}`,
      priority: inHouse ? "urgent" : "today",
      kind: "incident_open",
      title: `Incidencia en ${room.number} · ${wo.title}`,
      context: inHouse
        ? `Cliente actualmente alojado. Avería sigue ${wo.status}.`
        : `Habitación bloqueada por avería desde ${wo.createdAt.toISOString().slice(0, 10)}.`,
      recommendation: inHouse
        ? "Comunícate con el huésped y prioriza la reparación o reubica."
        : "Confirma con mantenimiento la fecha de devolución para liberar inventario.",
      roomId: wo.roomId,
      workOrderId: wo.id,
      primaryAction: { label: "Abrir incidencia", kind: "open_work_order", payload: { workOrderId: wo.id } }
    });
  }

  // ----------------------------------------------------------------------
  // Tanda CHK · W3-D — Detector 20: SELF_CHECKIN_DONE. Sesión `checked_in`
  // en las últimas 12 h cuyo actor fue el huésped (portal) o el kiosco. Sin
  // columna de actor en CheckInSession, el canal es el proxy: `reception`
  // queda fuera; `kiosk` (o kioskDeviceId) → kiosco; el resto → portal.
  // ----------------------------------------------------------------------
  for (const session of sessions) {
    if (session.status !== "checked_in" || !session.checkedInAt) continue;
    if (session.checkedInAt.getTime() < selfCheckInSince.getTime() || session.checkedInAt.getTime() > now.getTime()) continue;
    if (session.channel === "reception") continue;
    const res = reservationById.get(session.reservationId);
    if (!res || res.status !== "checked_in") continue;
    const viaKiosk = session.channel === "kiosk" || Boolean(session.kioskDeviceId);
    const room = res.assignedRoomId ? roomById.get(res.assignedRoomId) : undefined;
    items.push({
      id: `self_checkin_${res.id}`,
      priority: "today",
      kind: "self_checkin_done",
      title: `Check-in autónomo completado · Hab. ${room?.number ?? "—"}`,
      context: `${nameFor(res.id)} hizo el check-in ${viaKiosk ? "en el kiosco" : "desde su móvil"} ${elapsedLabel(session.checkedInAt, now)}.`,
      recommendation: "Informativo: desde la reserva puedes cambiar de habitación, revocar la llave o anular el check-in.",
      reservationId: res.id,
      guestId: primaryGuestId.get(res.id),
      roomId: room?.id,
      dueAt: session.checkedInAt.toISOString(),
      primaryAction: { label: "Ver reserva", kind: "open_reservation", payload: { reservationId: res.id } },
      secondaryActions: [{ label: "Ver pre-check-in", kind: "open_precheckin", payload: { reservationId: res.id } }]
    });
  }

  // ----------------------------------------------------------------------
  // Detector 17: SES_REJECTED — partes rechazados hoy (un ítem por reserva;
  // solo el código de error, nunca el mensaje del ministerio con datos).
  // ----------------------------------------------------------------------
  const sesByKey = new Map<string, { reservationId: string | null; count: number; codes: Set<string> }>();
  for (const submission of sesRejected) {
    const key = submission.reservationId ?? `submission_${submission.id}`;
    const entry = sesByKey.get(key) ?? { reservationId: submission.reservationId ?? null, count: 0, codes: new Set<string>() };
    entry.count += 1;
    if (submission.errorCode) entry.codes.add(submission.errorCode);
    sesByKey.set(key, entry);
  }
  for (const [key, entry] of sesByKey.entries()) {
    const res = entry.reservationId ? reservationById.get(entry.reservationId) : undefined;
    const room = res?.assignedRoomId ? roomById.get(res.assignedRoomId) : undefined;
    const codes = Array.from(entry.codes).sort();
    items.push({
      id: `ses_rejected_${key}`,
      priority: "today",
      kind: "ses_rejected",
      title: `Parte SES rechazado · ${entry.reservationId ? nameFor(entry.reservationId) : "sin reserva vinculada"}`,
      context: `${entry.count} envío${entry.count === 1 ? "" : "s"} rechazado${entry.count === 1 ? "" : "s"} hoy${codes.length ? ` · código ${codes.join(", ")}` : ""}${room ? ` · Hab. ${room.number}` : ""}.`,
      recommendation: "Corrige el parte de viajeros y reenvíalo desde cumplimiento; el reintento automático no cubre los rechazos de datos.",
      reservationId: entry.reservationId ?? undefined,
      roomId: room?.id,
      ...(entry.reservationId
        ? { primaryAction: { label: "Abrir reserva", kind: "open_reservation" as const, payload: { reservationId: entry.reservationId } } }
        : {})
    });
  }

  // ----------------------------------------------------------------------
  // Detector 18: ASSIGNMENT_SUGGESTED — llegadas de mañana sin habitación con
  // sugerencia pendiente (lote de las 18:00, diseño §4b «suggest_and_confirm»).
  // ----------------------------------------------------------------------
  for (const res of tomorrowSuggested) {
    const stored = suggestionByReservation.get(res.id);
    if (!stored) continue;
    const candidates = candidatesOf(stored.candidatesJson).filter((candidate) => roomById.has(candidate.roomId));
    const top = candidates[0];
    if (!top) continue;
    const confidence = Number(stored.confidence);
    items.push({
      id: `assignment_suggested_${res.id}`,
      priority: "today",
      kind: "assignment_suggested",
      title: `Asignación sugerida · ${res.code}`,
      context: `Llega mañana${res.eta ? ` · ETA ${res.eta}` : ""}. El motor propone ${describeCandidate(top, confidence)}.`,
      recommendation: "Confirma la habitación para dejar la llegada de mañana preparada, o elige otra candidata.",
      reservationId: res.id,
      primaryAction: confirmAssignmentAction(`Confirmar ${top.number}`, stored.id, res.id, top),
      secondaryActions: [
        ...candidates.slice(1, 3).map((candidate) => confirmAssignmentAction(`Asignar ${candidate.number}`, stored.id, res.id, candidate)),
        { label: "Abrir reserva", kind: "open_reservation", payload: { reservationId: res.id } }
      ]
    });
  }

  // ----------------------------------------------------------------------
  // Ordenación final: priority → kind → dueAt.
  // ----------------------------------------------------------------------
  items.sort((a, b) => {
    const w = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (w !== 0) return w;
    const k = kindWeight(a.kind) - kindWeight(b.kind);
    if (k !== 0) return k;
    return (a.dueAt ?? "").localeCompare(b.dueAt ?? "");
  });

  // Counts y summary.
  const counts = KIND_ORDER.reduce((acc, k) => { acc[k] = 0; return acc; }, {} as Record<FrontDeskQueueKind, number>);
  for (const it of items) counts[it.kind]++;
  const summary = {
    urgent: items.filter((i) => i.priority === "urgent").length,
    today: items.filter((i) => i.priority === "today").length,
    soon: items.filter((i) => i.priority === "soon").length,
    total: items.length
  };

  return { generatedAt: now.toISOString(), items, counts, summary, degraded };
}

/** Estado de limpieza en el idioma del mostrador (D5; nunca el enum crudo, L-14). */
export function cleanlinessLabel(status: string | null | undefined): string {
  switch ((status ?? "").trim().toLowerCase()) {
    case "clean":
      return "limpia";
    case "inspected":
      return "inspeccionada";
    case "dirty":
      return "sucia";
    case "cleaning":
    case "in_progress":
      return "en limpieza";
    case "occupied":
      return "ocupada";
    case "blocked":
      return "bloqueada";
    case "out_of_order":
    case "ooo":
    case "out_of_service":
      return "fuera de servicio";
    default:
      return "en un estado desconocido";
  }
}
