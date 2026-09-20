// Tanda CHK (lote W2-C) · Servicio de asignación explicable — diseño §4b
// (docs/design/CHECKIN-AUTOMATIZADO-IA.md). Lector del motor PURO
// `room-assignment.engine.ts` (lote W1-C): carga los datos por PROPIEDAD con
// consultas agregadas (nunca una por habitación · R14), ejecuta `suggestRooms`,
// persiste `AssignmentSuggestion` y cierra la sugerencia con `assignRoom`.
//
//   · suggestForReservation({ context, reservationId, sessionId?, persist })
//       pms.reservation.read · 1 instantánea de la propiedad (8 consultas
//       agregadas: habitaciones activas, tipos, órdenes abiertas, bloqueos que
//       solapan, comunicadas, reservas asignadas que solapan, rotación 30 días,
//       política) + 4 del titular (titular, huésped, reservas previas, estancias)
//       + 1 groupBy de llegadas pendientes por tipo + `quoteAvailability` SOLO si
//       la política permite mejora. Expira las `suggested` anteriores de la
//       reserva y crea la nueva con el `automationLevel` de la política.
//   · confirmSuggestion({ context, suggestionId, roomId? })
//       pms.reservation.modify (lo exige assignRoom) · sin roomId → primera
//       candidata · `assignRoom` (si la reserva ya está in-house deriva sola a
//       moveInHouseReservation) · estado `confirmed` (candidata) o `changed`
//       (otra) · decidedBy/decidedAt · auditoría ASSIGNMENT_SUGGESTION_DECIDED.
//   · runBatchForDate({ context, propertyId, date? })
//       pms.reservation.modify · llegadas `confirmed` sin habitación del día
//       (sin `date`: mañana según la fecha de negocio) · UNA instantánea para
//       todo el lote · la primera candidata de cada llegada queda ocupada
//       virtualmente para las siguientes (front-desk-queue.service L-22) ·
//       con `autoAssignLevel = preassign` NO asigna (D4 por defecto): anota
//       «pre-asignación autónoma desactivada» · { suggested, skipped, failed[] }
//       con catch honesto por reserva (QC-06).
//   · Bloqueos (`RoomBlock`) y comunicadas (`RoomConnection`): crear / borrar /
//       listar con validación (fechas, solape → 409, par ordenado → 409).
//
// Política: `PropertyCheckInPolicy` leída por propiedad a través de `db` (doble en
// tests) y normalizada con `toPolicyDto` del lote W2-A (checkin-policy.service.ts:
// mismos valores por defecto y saneado que `getPolicy`): assignmentWeightsJson,
// allowUpgradeSuggestion, requireInspectedRoom, autoAssignLevel.
//
// Rotación (+5 «Reparte el uso»): recuento de `Stay` por habitación de la
// PROPIEDAD en los últimos 30 días (uso del inventario), inyectado en
// `guest.stays30dByRoomId` porque el motor lo aplica al evaluar al titular.
// Grupo: habitaciones ya asignadas a reservas del mismo groupCode/groupBookingId
// dentro de la ventana de fechas de la instantánea.
//
// `housekeepingAlerts` (sucias descartadas por llegada ≤ 2 h) se devuelven en
// el resultado; este servicio NO crea la tarea a pisos (ver openIssues del lote).
//
// Dependencias inyectables (`AssignmentDeps`, patrón RbacDeps): `db` (subconjunto
// de Prisma), `assignRoom`, `quoteAvailability`, `audit`, `now`, `businessDate`
// → los tests unitarios usan dobles en memoria; producción, los reales.

import { prisma } from "@hotelos/database";
import {
  ROOM_BLOCK_REASONS,
  ROOM_CONNECTION_KINDS,
  type AssignmentCandidate as SharedAssignmentCandidate,
  type AssignmentSource,
  type AssignmentSuggestionDto,
  type AssignmentSuggestionStatus,
  type AutoAssignLevel,
  type RoomBlockReason,
  type RoomConnectionKind
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { toPolicyDto } from "../checkin/checkin-policy.service.js";
import { getCurrentBusinessDate } from "../night-audit/night-audit.service.js";
import { assignRoom, quoteAvailability } from "./pms.service.js";
import {
  dateKey,
  suggestRooms,
  type AssignmentCandidate,
  type AssignmentDemandByType,
  type AssignmentGuestInput,
  type AssignmentHousekeepingAlert,
  type AssignmentPolicy,
  type AssignmentRejection,
  type AssignmentRoomInput,
  type AssignmentSuggestionResult,
  type AssignmentWeightKey
} from "./room-assignment.engine.js";

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

export type AssignmentDb = Pick<
  typeof prisma,
  | "property"
  | "reservation"
  | "room"
  | "roomType"
  | "workOrder"
  | "roomBlock"
  | "roomConnection"
  | "propertyCheckInPolicy"
  | "assignmentSuggestion"
  | "reservationGuest"
  | "guest"
  | "stay"
  | "checkInSession"
>;

export type AssignmentDeps = {
  db: AssignmentDb;
  assignRoom: typeof assignRoom;
  quoteAvailability: typeof quoteAvailability;
  audit: typeof recordAuditEvent;
  now: () => Date;
  /** Fecha de negocio `YYYY-MM-DD` de la propiedad (lote sin `date` → día siguiente). */
  businessDate: (propertyId: string) => Promise<string>;
};

export const defaultAssignmentDeps: AssignmentDeps = {
  db: prisma,
  assignRoom,
  quoteAvailability,
  audit: recordAuditEvent,
  now: () => new Date(),
  businessDate: getCurrentBusinessDate
};

export function withAssignmentDeps(deps?: Partial<AssignmentDeps>): AssignmentDeps {
  return { ...defaultAssignmentDeps, ...(deps ?? {}) };
}

// ---------------------------------------------------------------------------
// Constantes y DTOs
// ---------------------------------------------------------------------------

export const ASSIGNMENT_SUGGESTION_DECIDED = "ASSIGNMENT_SUGGESTION_DECIDED";
export const ROOM_BLOCK_CREATED = "ROOM_BLOCK_CREATED";
export const ROOM_BLOCK_DELETED = "ROOM_BLOCK_DELETED";
export const ROOM_CONNECTION_CREATED = "ROOM_CONNECTION_CREATED";
export const ROOM_CONNECTION_DELETED = "ROOM_CONNECTION_DELETED";

export const PREASSIGN_DISABLED_NOTE = "pre-asignación autónoma desactivada (D4): la sugerencia queda pendiente de confirmación";
export const ROTATION_WINDOW_DAYS = 30;

const SUGGESTION_NOT_FOUND = "Sugerencia no encontrada.";
const RESERVATION_NOT_FOUND = "Reserva no encontrada.";
const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";
const ROOM_NOT_FOUND = "Habitación no encontrada.";
const SESSION_NOT_FOUND = "Sesión de check-in no encontrada.";
const BLOCK_NOT_FOUND = "Bloqueo no encontrado.";
const CONNECTION_NOT_FOUND = "Conexión no encontrada.";

/** Sugerencia persistida más el detalle EN MEMORIA del motor (rechazos, notas, avisos a pisos). */
export type AssignmentSuggestionDetailDto = AssignmentSuggestionDto & {
  rejected: AssignmentRejection[];
  dataNotes: string[];
  housekeepingAlerts: AssignmentHousekeepingAlert[];
  /** false con `persist: false` (id vacío, sin fila). */
  persisted: boolean;
};

export type ConfirmSuggestionResult = {
  suggestion: AssignmentSuggestionDto;
  reservation: Awaited<ReturnType<typeof assignRoom>>;
};

export type AssignmentBatchItem = {
  reservationId: string;
  code: string;
  suggestionId: string | null;
  /** Número de la primera candidata (la que queda ocupada virtualmente para el resto del lote). */
  proposedRoomNumber: string | null;
  candidates: number;
  rejected: number;
  dataNotes: string[];
};

export type AssignmentBatchResult = {
  propertyId: string;
  date: string;
  automationLevel: AutoAssignLevel;
  suggested: number;
  skipped: number;
  failed: Array<{ reservationId: string; code: string; error: string }>;
  items: AssignmentBatchItem[];
  durationMs: number;
};

export type RoomBlockDto = {
  id: string;
  propertyId: string;
  roomId: string;
  fromDate: string;
  toDate: string;
  reason: RoomBlockReason;
  workOrderId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
};

export type RoomConnectionDto = {
  id: string;
  propertyId: string;
  roomAId: string;
  roomBId: string;
  kind: RoomConnectionKind;
};

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function addDays(iso: string, days: number): string {
  const at = dateOnly(iso);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** `preferencesJson` de Guest/CheckInSession como lista de claves (array, objeto {clave:true} o string separada por comas). */
export function preferenceKeysOf(json: unknown): string[] {
  if (Array.isArray(json)) return json.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim().toLowerCase());
  if (typeof json === "string") return json.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (json && typeof json === "object") {
    return Object.entries(json as Record<string, unknown>)
      .filter(([, value]) => value === true || value === 1 || value === "true" || value === "yes" || value === "si" || value === "sí")
      .map(([key]) => key.trim().toLowerCase());
  }
  return [];
}

/** `assignmentWeightsJson` → pesos numéricos finitos (claves desconocidas se ignoran en el motor). */
export function weightsOf(json: unknown): Partial<Record<AssignmentWeightKey, number>> {
  const out: Partial<Record<AssignmentWeightKey, number>> = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key as AssignmentWeightKey] = value;
  }
  return out;
}

function parseCandidates(json: unknown): SharedAssignmentCandidate[] {
  if (!Array.isArray(json)) return [];
  return json.filter((item): item is SharedAssignmentCandidate => Boolean(item) && typeof item === "object" && typeof (item as { roomId?: unknown }).roomId === "string");
}

type SuggestionRow = NonNullable<Awaited<ReturnType<AssignmentDb["assignmentSuggestion"]["findUnique"]>>>;
type ReservationRow = NonNullable<Awaited<ReturnType<AssignmentDb["reservation"]["findUnique"]>>>;
type RoomBlockRow = NonNullable<Awaited<ReturnType<AssignmentDb["roomBlock"]["findUnique"]>>>;
type RoomConnectionRow = NonNullable<Awaited<ReturnType<AssignmentDb["roomConnection"]["findUnique"]>>>;

export function toSuggestionDto(row: SuggestionRow): AssignmentSuggestionDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    reservationId: row.reservationId,
    sessionId: row.sessionId ?? null,
    candidates: parseCandidates(row.candidatesJson),
    rejectedCount: row.rejectedCount,
    chosenRoomId: row.chosenRoomId ?? null,
    confidence: Number(row.confidence),
    rulesVersion: row.rulesVersion,
    source: row.source as AssignmentSource,
    automationLevel: row.automationLevel as AutoAssignLevel,
    status: row.status as AssignmentSuggestionStatus,
    decidedBy: row.decidedBy ?? null,
    decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
    aiToolCallId: row.aiToolCallId ?? null,
    createdAt: new Date(row.createdAt).toISOString()
  };
}

function toRoomBlockDto(row: RoomBlockRow): RoomBlockDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomId: row.roomId,
    fromDate: dateKey(row.fromDate),
    toDate: dateKey(row.toDate),
    reason: row.reason as RoomBlockReason,
    workOrderId: row.workOrderId ?? null,
    note: row.note ?? null,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt).toISOString()
  };
}

function toRoomConnectionDto(row: RoomConnectionRow): RoomConnectionDto {
  return { id: row.id, propertyId: row.propertyId, roomAId: row.roomAId, roomBId: row.roomBId, kind: row.kind as RoomConnectionKind };
}

/** 404 opaco (mismo mensaje que un id inexistente) cuando la propiedad no es de la organización. */
async function assertPropertyOfOrg(db: AssignmentDb, propertyId: string, organizationId: string, message = PROPERTY_NOT_FOUND): Promise<void> {
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property || property.organizationId !== organizationId) throw new NotFoundError(message);
}

// ---------------------------------------------------------------------------
// Política
// ---------------------------------------------------------------------------

export type AssignmentPolicySnapshot = AssignmentPolicy & { autoAssignLevel: AutoAssignLevel };

/** `PropertyCheckInPolicy` de la propiedad vía `db` + `toPolicyDto` (W2-A): sin fila, los @default del esquema. */
export async function loadAssignmentPolicy(db: AssignmentDb, propertyId: string): Promise<AssignmentPolicySnapshot> {
  const row = await db.propertyCheckInPolicy.findUnique({ where: { propertyId } });
  const policy = toPolicyDto(row, propertyId);
  return {
    allowUpgrade: policy.allowUpgradeSuggestion,
    requireInspectedRoom: policy.requireInspectedRoom,
    weights: weightsOf(policy.assignmentWeights),
    autoAssignLevel: policy.autoAssignLevel
  };
}

// ---------------------------------------------------------------------------
// Instantánea de la propiedad (consultas agregadas · R14)
// ---------------------------------------------------------------------------

type AssignedReservation = {
  id: string;
  assignedRoomId: string | null;
  status: string;
  arrivalDate: Date;
  departureDate: Date;
  groupCode: string | null;
  groupBookingId: string | null;
};

export type PropertySnapshot = {
  propertyId: string;
  /** Ventana [from, to) cargada. */
  from: string;
  to: string;
  rooms: AssignmentRoomInput[];
  roomTypes: Array<{ id: string; displayOrder: number | null; maxOccupancy: number | null }>;
  openWorkOrderRoomIds: string[];
  roomBlocks: Array<{ roomId: string; fromDate: Date; toDate: Date }>;
  roomConnections: Array<{ roomAId: string; roomBId: string; kind: string }>;
  /** Reservas confirmed/checked_in con habitación que solapan la ventana. */
  assigned: AssignedReservation[];
  /** Estancias por habitación en los últimos 30 días (toda la propiedad). */
  stays30dByRoomId: Record<string, number>;
  policy: AssignmentPolicySnapshot;
};

export async function loadPropertySnapshot(db: AssignmentDb, input: { propertyId: string; from: string; to: string; now: Date }): Promise<PropertySnapshot> {
  const from = dateOnly(input.from);
  const to = dateOnly(input.to);
  const since = new Date(input.now.getTime() - ROTATION_WINDOW_DAYS * 86_400_000);
  const [rooms, roomTypes, workOrders, roomBlocks, roomConnections, assigned, policy] = await Promise.all([
    db.room.findMany({
      where: { propertyId: input.propertyId, active: true },
      select: {
        id: true,
        number: true,
        roomTypeId: true,
        floor: true,
        floorId: true,
        viewType: true,
        maxOccupancy: true,
        bedConfigurationJson: true,
        featuresJson: true,
        accessibilityJson: true,
        status: true,
        housekeepingStatus: true,
        maintenanceStatus: true,
        sellable: true,
        active: true
      },
      orderBy: { number: "asc" }
    }),
    db.roomType.findMany({ where: { propertyId: input.propertyId }, select: { id: true, displayOrder: true, maxOccupancy: true } }),
    // Mismo criterio que el rack (dashboards/room-rack.service.ts): abiertas o en curso.
    db.workOrder.findMany({ where: { propertyId: input.propertyId, status: { in: ["open", "in_progress"] }, roomId: { not: null } }, select: { roomId: true } }),
    db.roomBlock.findMany({ where: { propertyId: input.propertyId, fromDate: { lt: to }, toDate: { gte: from } }, select: { roomId: true, fromDate: true, toDate: true } }),
    db.roomConnection.findMany({ where: { propertyId: input.propertyId }, select: { roomAId: true, roomBId: true, kind: true } }),
    db.reservation.findMany({
      where: {
        propertyId: input.propertyId,
        status: { in: ["confirmed", "checked_in"] },
        assignedRoomId: { not: null },
        arrivalDate: { lt: to },
        departureDate: { gt: from },
        deletedAt: null
      },
      select: { id: true, assignedRoomId: true, status: true, arrivalDate: true, departureDate: true, groupCode: true, groupBookingId: true }
    }),
    loadAssignmentPolicy(db, input.propertyId)
  ]);
  const roomIds = rooms.map((room) => room.id);
  const stays = roomIds.length === 0 ? [] : await db.stay.groupBy({ by: ["roomId"], where: { roomId: { in: roomIds }, checkinAt: { gte: since } }, _count: { _all: true } });
  const stays30dByRoomId: Record<string, number> = {};
  for (const roomId of roomIds) stays30dByRoomId[roomId] = 0;
  for (const row of stays) stays30dByRoomId[row.roomId] = row._count._all;
  return {
    propertyId: input.propertyId,
    from: input.from,
    to: input.to,
    rooms: rooms.map((room) => ({ ...room, status: String(room.status) })),
    roomTypes,
    openWorkOrderRoomIds: workOrders.map((wo) => wo.roomId).filter((id): id is string => Boolean(id)),
    roomBlocks,
    roomConnections,
    assigned: assigned.map((row) => ({ ...row, status: String(row.status) })),
    stays30dByRoomId,
    policy
  };
}

// ---------------------------------------------------------------------------
// Titulares (4 consultas para N reservas, nunca por habitación)
// ---------------------------------------------------------------------------

type GuestLoad = { guest: AssignmentGuestInput | null; preferences: string[] };

async function loadGuestInputs(db: AssignmentDb, snapshot: PropertySnapshot, reservationIds: string[]): Promise<Map<string, GuestLoad>> {
  const out = new Map<string, GuestLoad>();
  if (reservationIds.length === 0) return out;
  const primaries = await db.reservationGuest.findMany({ where: { reservationId: { in: reservationIds }, isPrimary: true }, select: { reservationId: true, guestId: true } });
  const guestByReservation = new Map<string, string>();
  for (const link of primaries) if (!guestByReservation.has(link.reservationId)) guestByReservation.set(link.reservationId, link.guestId);
  const guestIds = Array.from(new Set(guestByReservation.values()));
  if (guestIds.length === 0) return out;
  const [guests, previousLinks] = await Promise.all([
    db.guest.findMany({ where: { id: { in: guestIds }, deletedAt: null }, select: { id: true, vipCode: true, loyaltyTier: true, preferencesJson: true } }),
    db.reservationGuest.findMany({ where: { guestId: { in: guestIds }, isPrimary: true }, select: { reservationId: true, guestId: true } })
  ]);
  const previousReservationIds = previousLinks.map((link) => link.reservationId).filter((id) => !reservationIds.includes(id));
  const guestOfReservation = new Map(previousLinks.map((link) => [link.reservationId, link.guestId]));
  const roomIds = new Set(snapshot.rooms.map((room) => room.id));
  const lastStayByGuest = new Map<string, string>();
  if (previousReservationIds.length > 0) {
    const stays = await db.stay.findMany({
      where: { reservationId: { in: previousReservationIds }, status: "checked_out" },
      select: { reservationId: true, roomId: true, checkoutAt: true },
      orderBy: [{ checkoutAt: "desc" }]
    });
    for (const stay of stays) {
      if (!roomIds.has(stay.roomId)) continue;
      const guestId = guestOfReservation.get(stay.reservationId);
      if (guestId && !lastStayByGuest.has(guestId)) lastStayByGuest.set(guestId, stay.roomId);
    }
  }
  const guestById = new Map(guests.map((guest) => [guest.id, guest]));
  for (const reservationId of reservationIds) {
    const guestId = guestByReservation.get(reservationId);
    const guest = guestId ? guestById.get(guestId) : undefined;
    if (!guest) {
      out.set(reservationId, { guest: null, preferences: [] });
      continue;
    }
    const preferences = preferenceKeysOf(guest.preferencesJson);
    out.set(reservationId, {
      guest: {
        id: guest.id,
        vipCode: guest.vipCode,
        loyaltyTier: guest.loyaltyTier,
        preferences,
        lastStayRoomId: lastStayByGuest.get(guest.id) ?? null,
        stays30dByRoomId: snapshot.stays30dByRoomId
      },
      preferences
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Demanda por tipo (quoteAvailability SOLO con mejora permitida)
// ---------------------------------------------------------------------------

type DemandLoader = (input: { arrivalDate: string; departureDate: string; adults: number; children: number }) => Promise<Record<string, number> | null>;

/** `availableRooms` por tipo vía quoteAvailability, memorizado por (llegada, salida, pax) dentro de un lote. */
function demandLoader(deps: AssignmentDeps, propertyId: string): DemandLoader {
  const cache = new Map<string, Promise<Record<string, number> | null>>();
  return (input) => {
    if (input.arrivalDate >= input.departureDate) return Promise.resolve(null);
    const key = `${input.arrivalDate}|${input.departureDate}|${input.adults + input.children}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = deps
        .quoteAvailability({ propertyId, arrivalDate: input.arrivalDate, departureDate: input.departureDate, adults: input.adults, children: input.children })
        .then((items) => Object.fromEntries(items.map((item) => [item.roomTypeId, item.availableRooms])));
      cache.set(key, pending);
    }
    return pending;
  };
}

async function pendingArrivalsByType(db: AssignmentDb, propertyId: string, arrivalDate: Date, excludeReservationId: string): Promise<Record<string, number>> {
  const rows = await db.reservation.groupBy({
    by: ["roomTypeId"],
    where: { propertyId, status: "confirmed", assignedRoomId: null, arrivalDate, deletedAt: null, id: { not: excludeReservationId } },
    _count: { _all: true }
  });
  const out: Record<string, number> = {};
  for (const row of rows) if (row.roomTypeId) out[row.roomTypeId] = row._count._all;
  return out;
}

// ---------------------------------------------------------------------------
// Motor sobre la instantánea
// ---------------------------------------------------------------------------

type ComputeInput = {
  reservation: ReservationRow;
  snapshot: PropertySnapshot;
  guestLoad: GuestLoad;
  sessionPreferences: string[];
  etaDeclared: string | null;
  /** Habitaciones propuestas a otras llegadas del lote → código de reserva. */
  virtuallyTaken: Map<string, string>;
  demandByRoomType?: AssignmentDemandByType;
  now: Date;
};

function computeSuggestion(input: ComputeInput): AssignmentSuggestionResult {
  const { reservation, snapshot } = input;
  const arrival = dateKey(reservation.arrivalDate);
  const departure = dateKey(reservation.departureDate);
  const overlapping = snapshot.assigned.filter((row) => row.id !== reservation.id && dateKey(row.arrivalDate) < departure && dateKey(row.departureDate) > arrival);
  const groupCode = reservation.groupCode?.trim() || null;
  const groupAssigned = overlapping.filter((row) => row.assignedRoomId && ((groupCode && row.groupCode?.trim() === groupCode) || (reservation.groupBookingId && row.groupBookingId === reservation.groupBookingId)));
  const roomById = new Map(snapshot.rooms.map((room) => [room.id, room]));
  const virtualRejections: AssignmentRejection[] = [];
  const rooms = snapshot.rooms.filter((room) => {
    const takenBy = input.virtuallyTaken.get(room.id);
    if (!takenBy) return true;
    virtualRejections.push({ roomId: room.id, number: room.number, reason: `Propuesta a otra llegada del lote (${takenBy})` });
    return false;
  });
  const preferences = Array.from(new Set([...input.sessionPreferences, ...(input.guestLoad.guest?.preferences ?? [])]));
  const guest: AssignmentGuestInput | null = input.guestLoad.guest ? { ...input.guestLoad.guest, preferences } : null;
  const result = suggestRooms({
    reservation: {
      id: reservation.id,
      roomTypeId: reservation.roomTypeId,
      arrivalDate: arrival,
      departureDate: departure,
      adults: reservation.adults,
      children: reservation.children,
      vipFlag: reservation.vipFlag,
      accessibilityNeeds: reservation.accessibilityNeeds,
      groupCode: reservation.groupCode,
      groupBookingId: reservation.groupBookingId,
      specialRequests: reservation.specialRequests,
      etaHHMM: input.etaDeclared ?? reservation.eta ?? reservation.estimatedArrivalTime ?? null
    },
    guest,
    rooms,
    roomTypes: snapshot.roomTypes,
    overlappingReservations: overlapping.map((row) => ({ id: row.id, assignedRoomId: row.assignedRoomId, status: row.status })),
    openWorkOrderRoomIds: snapshot.openWorkOrderRoomIds,
    roomBlocks: snapshot.roomBlocks,
    roomConnections: snapshot.roomConnections,
    groupAssignedRooms: groupAssigned.map((row) => ({ roomId: row.assignedRoomId as string, floor: roomById.get(row.assignedRoomId as string)?.floor ?? null })),
    demandByRoomType: input.demandByRoomType,
    policy: { allowUpgrade: snapshot.policy.allowUpgrade, requireInspectedRoom: snapshot.policy.requireInspectedRoom, weights: snapshot.policy.weights },
    now: input.now
  });
  return { ...result, rejected: [...result.rejected, ...virtualRejections] };
}

async function persistSuggestion(db: AssignmentDb, input: { propertyId: string; reservationId: string; sessionId: string | null; result: AssignmentSuggestionResult; automationLevel: AutoAssignLevel }): Promise<SuggestionRow> {
  await db.assignmentSuggestion.updateMany({ where: { reservationId: input.reservationId, status: "suggested" }, data: { status: "expired" } });
  return db.assignmentSuggestion.create({
    data: {
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      sessionId: input.sessionId,
      candidatesJson: input.result.candidates as unknown as object[],
      rejectedCount: input.result.rejected.length,
      confidence: round4(input.result.confidence),
      rulesVersion: input.result.rulesVersion,
      source: input.result.source,
      automationLevel: input.automationLevel,
      status: "suggested"
    }
  });
}

function unsavedDto(input: { propertyId: string; reservationId: string; sessionId: string | null; result: AssignmentSuggestionResult; automationLevel: AutoAssignLevel; now: Date }): AssignmentSuggestionDto {
  return {
    id: "",
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    sessionId: input.sessionId,
    candidates: input.result.candidates as AssignmentCandidate[],
    rejectedCount: input.result.rejected.length,
    chosenRoomId: null,
    confidence: round4(input.result.confidence),
    rulesVersion: input.result.rulesVersion,
    source: input.result.source,
    automationLevel: input.automationLevel,
    status: "suggested",
    decidedBy: null,
    decidedAt: null,
    aiToolCallId: null,
    createdAt: input.now.toISOString()
  };
}

// ---------------------------------------------------------------------------
// suggestForReservation
// ---------------------------------------------------------------------------

export async function suggestForReservation(
  input: { context: UserContext; reservationId: string; sessionId?: string | null; persist?: boolean },
  deps?: Partial<AssignmentDeps>
): Promise<AssignmentSuggestionDetailDto> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.read"]);
  const reservation = await d.db.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation || reservation.deletedAt) throw new NotFoundError(RESERVATION_NOT_FOUND);
  await assertPropertyOfOrg(d.db, reservation.propertyId, input.context.organizationId, RESERVATION_NOT_FOUND);

  let sessionId: string | null = null;
  let sessionPreferences: string[] = [];
  let etaDeclared: string | null = null;
  if (input.sessionId) {
    const session = await d.db.checkInSession.findUnique({ where: { id: input.sessionId }, select: { id: true, reservationId: true, preferencesJson: true, etaDeclared: true } });
    if (!session || session.reservationId !== reservation.id) throw new NotFoundError(SESSION_NOT_FOUND);
    sessionId = session.id;
    sessionPreferences = preferenceKeysOf(session.preferencesJson);
    etaDeclared = session.etaDeclared ?? null;
  }

  const now = d.now();
  const arrival = dateKey(reservation.arrivalDate);
  const departure = dateKey(reservation.departureDate);
  const snapshot = await loadPropertySnapshot(d.db, { propertyId: reservation.propertyId, from: arrival, to: departure > arrival ? departure : addDays(arrival, 1), now });
  const [guestLoads, pending] = await Promise.all([loadGuestInputs(d.db, snapshot, [reservation.id]), pendingArrivalsByType(d.db, reservation.propertyId, reservation.arrivalDate, reservation.id)]);
  const demandByRoomType = await demandFor(demandLoader(d, reservation.propertyId), snapshot, reservation, pending);

  const result = computeSuggestion({
    reservation,
    snapshot,
    guestLoad: guestLoads.get(reservation.id) ?? { guest: null, preferences: [] },
    sessionPreferences,
    etaDeclared,
    virtuallyTaken: new Map(),
    demandByRoomType,
    now
  });
  const automationLevel = snapshot.policy.autoAssignLevel;
  const persist = input.persist ?? true;
  const dto = persist
    ? toSuggestionDto(await persistSuggestion(d.db, { propertyId: reservation.propertyId, reservationId: reservation.id, sessionId, result, automationLevel }))
    : unsavedDto({ propertyId: reservation.propertyId, reservationId: reservation.id, sessionId, result, automationLevel, now });
  return { ...dto, rejected: result.rejected, dataNotes: result.dataNotes, housekeepingAlerts: result.housekeepingAlerts, persisted: persist };
}

/**
 * Demanda por tipo para la protección de inventario (−20 «Se reserva para otra
 * llegada»): SOLO los tipos distintos del reservado. La reserva consume una
 * habitación de su propio tipo de todos modos (quoteAvailability ya la cuenta
 * como ocupada y en un hotel lleno «available ≤ 1» penalizaría por igual a todas
 * sus candidatas sin discriminar nada); la regla protege la última habitación de
 * un tipo SUPERIOR con llegadas pendientes cuando se evalúa una mejora.
 */
async function demandFor(load: DemandLoader, snapshot: PropertySnapshot, reservation: ReservationRow, pendingByType: Record<string, number>): Promise<AssignmentDemandByType | undefined> {
  if (!snapshot.policy.allowUpgrade) return undefined;
  const availability = await load({ arrivalDate: dateKey(reservation.arrivalDate), departureDate: dateKey(reservation.departureDate), adults: reservation.adults, children: reservation.children });
  if (!availability) return undefined;
  const out: AssignmentDemandByType = {};
  for (const [roomTypeId, available] of Object.entries(availability)) {
    if (roomTypeId === reservation.roomTypeId) continue;
    out[roomTypeId] = { available, pendingArrivals: pendingByType[roomTypeId] ?? 0 };
  }
  return out;
}

/** Sugerencias de una reserva, la más reciente primero (pms.reservation.read). */
export async function listSuggestionsForReservation(input: { context: UserContext; reservationId: string }, deps?: Partial<AssignmentDeps>): Promise<AssignmentSuggestionDto[]> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.read"]);
  const reservation = await d.db.reservation.findUnique({ where: { id: input.reservationId }, select: { id: true, propertyId: true, deletedAt: true } });
  if (!reservation || reservation.deletedAt) throw new NotFoundError(RESERVATION_NOT_FOUND);
  await assertPropertyOfOrg(d.db, reservation.propertyId, input.context.organizationId, RESERVATION_NOT_FOUND);
  const rows = await d.db.assignmentSuggestion.findMany({ where: { reservationId: reservation.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return rows.map(toSuggestionDto);
}

// ---------------------------------------------------------------------------
// confirmSuggestion
// ---------------------------------------------------------------------------

export async function confirmSuggestion(
  input: { context: UserContext; suggestionId: string; roomId?: string | null; correlationId?: string },
  deps?: Partial<AssignmentDeps>
): Promise<ConfirmSuggestionResult> {
  const d = withAssignmentDeps(deps);
  // La exige assignRoom (pms.service.ts); aquí antes de leer nada.
  requirePermissions(input.context, ["pms.reservation.modify"]);
  const row = await d.db.assignmentSuggestion.findUnique({ where: { id: input.suggestionId } });
  if (!row) throw new NotFoundError(SUGGESTION_NOT_FOUND);
  await assertPropertyOfOrg(d.db, row.propertyId, input.context.organizationId, SUGGESTION_NOT_FOUND);
  if (row.status !== "suggested") throw new ConflictError(`La sugerencia ya está decidida (${row.status}).`, { code: "ASSIGNMENT_SUGGESTION_DECIDED", status: row.status });
  const candidates = parseCandidates(row.candidatesJson);
  const roomId = input.roomId?.trim() || candidates[0]?.roomId;
  if (!roomId) throw new ConflictError("La sugerencia no tiene candidatas: elige una habitación.", { code: "ASSIGNMENT_NO_CANDIDATES" });
  const correlationId = input.correlationId ?? createId("corr");

  // assignRoom valida tenencia, estado de la reserva y solapes bajo el bloqueo de
  // fila; si la reserva ya está in-house deriva a moveInHouseReservation.
  const reservation = await d.assignRoom({ context: input.context, reservationId: row.reservationId, roomId, correlationId });

  const status: AssignmentSuggestionStatus = candidates.some((candidate) => candidate.roomId === roomId) ? "confirmed" : "changed";
  const decidedAt = d.now();
  const claimed = await d.db.assignmentSuggestion.updateMany({
    where: { id: row.id, status: "suggested" },
    data: { status, chosenRoomId: roomId, decidedBy: input.context.userId, decidedAt }
  });
  if (claimed.count !== 1) throw new ConflictError("La sugerencia se decidió mientras se procesaba; recarga y revisa la habitación asignada.", { code: "ASSIGNMENT_SUGGESTION_DECIDED" });
  const after = await d.db.assignmentSuggestion.findUnique({ where: { id: row.id } });
  const suggestion = toSuggestionDto(after ?? { ...row, status, chosenRoomId: roomId, decidedBy: input.context.userId, decidedAt });

  d.audit({
    organizationId: input.context.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: ASSIGNMENT_SUGGESTION_DECIDED,
    entityType: "assignment_suggestion",
    entityId: row.id,
    beforeJson: toSuggestionDto(row),
    afterJson: suggestion,
    deviceId: input.context.deviceId,
    correlationId
  });
  return { suggestion, reservation };
}

// ---------------------------------------------------------------------------
// runBatchForDate
// ---------------------------------------------------------------------------

export async function runBatchForDate(input: { context: UserContext; propertyId: string; date?: string | null }, deps?: Partial<AssignmentDeps>): Promise<AssignmentBatchResult> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.modify"]);
  await assertPropertyOfOrg(d.db, input.propertyId, input.context.organizationId);
  const date = input.date ? input.date : addDays(await d.businessDate(input.propertyId), 1);
  if (!isIsoDate(date)) throw new BadRequestError("La fecha del lote debe tener formato YYYY-MM-DD.");
  const startedAt = Date.now();
  const now = d.now();

  const arrivals = await d.db.reservation.findMany({
    where: { propertyId: input.propertyId, status: "confirmed", assignedRoomId: null, arrivalDate: dateOnly(date), deletedAt: null },
    orderBy: [{ code: "asc" }]
  });
  // VIP primero, luego por hora de llegada (sin ETA al final), luego por código.
  arrivals.sort((a, b) => Number(b.vipFlag) - Number(a.vipFlag) || compareEta(a.eta ?? a.estimatedArrivalTime, b.eta ?? b.estimatedArrivalTime) || a.code.localeCompare(b.code));

  const to = arrivals.reduce((max, row) => (dateKey(row.departureDate) > max ? dateKey(row.departureDate) : max), addDays(date, 1));
  const snapshot = await loadPropertySnapshot(d.db, { propertyId: input.propertyId, from: date, to, now });
  const automationLevel = snapshot.policy.autoAssignLevel;
  const guestLoads = await loadGuestInputs(d.db, snapshot, arrivals.map((row) => row.id));
  const loadDemand = demandLoader(d, input.propertyId);
  const pendingAll: Record<string, number> = {};
  for (const row of arrivals) if (row.roomTypeId) pendingAll[row.roomTypeId] = (pendingAll[row.roomTypeId] ?? 0) + 1;

  const result: AssignmentBatchResult = { propertyId: input.propertyId, date, automationLevel, suggested: 0, skipped: 0, failed: [], items: [], durationMs: 0 };
  const virtuallyTaken = new Map<string, string>();
  for (const reservation of arrivals) {
    try {
      const pending = { ...pendingAll };
      if (reservation.roomTypeId) pending[reservation.roomTypeId] = Math.max(0, (pending[reservation.roomTypeId] ?? 1) - 1);
      const demandByRoomType = await demandFor(loadDemand, snapshot, reservation, pending);
      const computed = computeSuggestion({
        reservation,
        snapshot,
        guestLoad: guestLoads.get(reservation.id) ?? { guest: null, preferences: [] },
        sessionPreferences: [],
        etaDeclared: null,
        virtuallyTaken,
        demandByRoomType,
        now
      });
      const dataNotes = [...computed.dataNotes];
      if (automationLevel === "preassign") dataNotes.push(PREASSIGN_DISABLED_NOTE);
      if (computed.candidates.length === 0) {
        result.skipped += 1;
        result.items.push({ reservationId: reservation.id, code: reservation.code, suggestionId: null, proposedRoomNumber: null, candidates: 0, rejected: computed.rejected.length, dataNotes });
        continue;
      }
      const row = await persistSuggestion(d.db, { propertyId: input.propertyId, reservationId: reservation.id, sessionId: null, result: computed, automationLevel });
      const first = computed.candidates[0]!;
      virtuallyTaken.set(first.roomId, reservation.code);
      result.suggested += 1;
      result.items.push({ reservationId: reservation.id, code: reservation.code, suggestionId: row.id, proposedRoomNumber: first.number, candidates: computed.candidates.length, rejected: computed.rejected.length, dataNotes });
    } catch (error) {
      // QC-06: una reserva rota no tumba el lote; el motivo viaja al resultado.
      result.failed.push({ reservationId: reservation.id, code: reservation.code, error: errorMessage(error) });
    }
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

function compareEta(a: string | null | undefined, b: string | null | undefined): number {
  const x = a && /^\d{1,2}:\d{2}$/.test(a.trim()) ? a.trim().padStart(5, "0") : null;
  const y = b && /^\d{1,2}:\d{2}$/.test(b.trim()) ? b.trim().padStart(5, "0") : null;
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Bloqueos de habitación (RoomBlock)
// ---------------------------------------------------------------------------

export async function createRoomBlock(
  input: { context: UserContext; propertyId: string; roomId: string; fromDate: string; toDate: string; reason: string; note?: string | null; workOrderId?: string | null; correlationId?: string },
  deps?: Partial<AssignmentDeps>
): Promise<RoomBlockDto> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.modify"]);
  await assertPropertyOfOrg(d.db, input.propertyId, input.context.organizationId);
  if (!isIsoDate(input.fromDate) || !isIsoDate(input.toDate)) throw new BadRequestError("Las fechas del bloqueo deben tener formato YYYY-MM-DD.");
  if (input.fromDate > input.toDate) throw new BadRequestError("La fecha final del bloqueo debe ser igual o posterior a la inicial.");
  if (!(ROOM_BLOCK_REASONS as readonly string[]).includes(input.reason)) throw new BadRequestError(`Motivo de bloqueo no válido (${ROOM_BLOCK_REASONS.join(", ")}).`);
  const room = await d.db.room.findFirst({ where: { id: input.roomId, propertyId: input.propertyId, active: true }, select: { id: true, number: true } });
  if (!room) throw new NotFoundError(ROOM_NOT_FOUND);
  if (input.workOrderId) {
    const workOrder = await d.db.workOrder.findFirst({ where: { id: input.workOrderId, propertyId: input.propertyId }, select: { id: true } });
    if (!workOrder) throw new NotFoundError("Orden de trabajo no encontrada.");
  }
  const overlapping = await d.db.roomBlock.findFirst({
    where: { roomId: room.id, fromDate: { lte: dateOnly(input.toDate) }, toDate: { gte: dateOnly(input.fromDate) } },
    select: { id: true, fromDate: true, toDate: true }
  });
  if (overlapping) {
    throw new ConflictError(`La habitación ${room.number} ya tiene un bloqueo que solapa (del ${dateKey(overlapping.fromDate)} al ${dateKey(overlapping.toDate)}).`, { code: "ROOM_BLOCK_OVERLAP", blockId: overlapping.id });
  }
  const row = await d.db.roomBlock.create({
    data: {
      propertyId: input.propertyId,
      roomId: room.id,
      fromDate: dateOnly(input.fromDate),
      toDate: dateOnly(input.toDate),
      reason: input.reason,
      workOrderId: input.workOrderId ?? null,
      note: input.note?.trim() || null,
      createdBy: input.context.userId
    }
  });
  const dto = toRoomBlockDto(row);
  d.audit({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: ROOM_BLOCK_CREATED,
    entityType: "room_block",
    entityId: row.id,
    afterJson: dto,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId ?? createId("corr")
  });
  return dto;
}

export async function deleteRoomBlock(input: { context: UserContext; blockId: string; correlationId?: string }, deps?: Partial<AssignmentDeps>): Promise<RoomBlockDto> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.modify"]);
  const row = await d.db.roomBlock.findUnique({ where: { id: input.blockId } });
  if (!row) throw new NotFoundError(BLOCK_NOT_FOUND);
  await assertPropertyOfOrg(d.db, row.propertyId, input.context.organizationId, BLOCK_NOT_FOUND);
  await d.db.roomBlock.deleteMany({ where: { id: row.id } });
  const dto = toRoomBlockDto(row);
  d.audit({
    organizationId: input.context.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: ROOM_BLOCK_DELETED,
    entityType: "room_block",
    entityId: row.id,
    beforeJson: dto,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId ?? createId("corr")
  });
  return dto;
}

/** Bloqueos de la propiedad; con `from`/`to` (YYYY-MM-DD) solo los que solapan la ventana [from, to]. */
export async function listRoomBlocks(input: { context: UserContext; propertyId: string; roomId?: string | null; from?: string | null; to?: string | null }, deps?: Partial<AssignmentDeps>): Promise<RoomBlockDto[]> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.read"]);
  await assertPropertyOfOrg(d.db, input.propertyId, input.context.organizationId);
  if ((input.from && !isIsoDate(input.from)) || (input.to && !isIsoDate(input.to))) throw new BadRequestError("Las fechas del filtro deben tener formato YYYY-MM-DD.");
  const rows = await d.db.roomBlock.findMany({
    where: {
      propertyId: input.propertyId,
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(input.to ? { fromDate: { lte: dateOnly(input.to) } } : {}),
      ...(input.from ? { toDate: { gte: dateOnly(input.from) } } : {})
    },
    orderBy: [{ fromDate: "asc" }, { roomId: "asc" }]
  });
  return rows.map(toRoomBlockDto);
}

// ---------------------------------------------------------------------------
// Habitaciones comunicadas (RoomConnection)
// ---------------------------------------------------------------------------

export async function createRoomConnection(
  input: { context: UserContext; propertyId: string; roomAId: string; roomBId: string; kind: string; correlationId?: string },
  deps?: Partial<AssignmentDeps>
): Promise<RoomConnectionDto> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.modify"]);
  await assertPropertyOfOrg(d.db, input.propertyId, input.context.organizationId);
  if (!(ROOM_CONNECTION_KINDS as readonly string[]).includes(input.kind)) throw new BadRequestError(`Tipo de conexión no válido (${ROOM_CONNECTION_KINDS.join(", ")}).`);
  if (input.roomAId === input.roomBId) throw new BadRequestError("Una habitación no puede comunicarse consigo misma.");
  const rooms = await d.db.room.findMany({ where: { id: { in: [input.roomAId, input.roomBId] }, propertyId: input.propertyId, active: true }, select: { id: true } });
  if (rooms.length !== 2) throw new NotFoundError(ROOM_NOT_FOUND);
  // Par ordenado (misma propiedad): una sola fila por pareja, en cualquier orden de entrada.
  const [roomAId, roomBId] = [input.roomAId, input.roomBId].sort();
  const existing = await d.db.roomConnection.findFirst({
    where: { OR: [{ roomAId, roomBId }, { roomAId: roomBId, roomBId: roomAId }] },
    select: { id: true, kind: true }
  });
  if (existing) throw new ConflictError(`Las habitaciones ya están conectadas (${existing.kind}).`, { code: "ROOM_CONNECTION_EXISTS", connectionId: existing.id });
  const row = await d.db.roomConnection.create({ data: { propertyId: input.propertyId, roomAId: roomAId!, roomBId: roomBId!, kind: input.kind } });
  const dto = toRoomConnectionDto(row);
  d.audit({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: ROOM_CONNECTION_CREATED,
    entityType: "room_connection",
    entityId: row.id,
    afterJson: dto,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId ?? createId("corr")
  });
  return dto;
}

export async function deleteRoomConnection(input: { context: UserContext; connectionId: string; correlationId?: string }, deps?: Partial<AssignmentDeps>): Promise<RoomConnectionDto> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.modify"]);
  const row = await d.db.roomConnection.findUnique({ where: { id: input.connectionId } });
  if (!row) throw new NotFoundError(CONNECTION_NOT_FOUND);
  await assertPropertyOfOrg(d.db, row.propertyId, input.context.organizationId, CONNECTION_NOT_FOUND);
  await d.db.roomConnection.deleteMany({ where: { id: row.id } });
  const dto = toRoomConnectionDto(row);
  d.audit({
    organizationId: input.context.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: ROOM_CONNECTION_DELETED,
    entityType: "room_connection",
    entityId: row.id,
    beforeJson: dto,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId ?? createId("corr")
  });
  return dto;
}

export async function listRoomConnections(input: { context: UserContext; propertyId: string; roomId?: string | null }, deps?: Partial<AssignmentDeps>): Promise<RoomConnectionDto[]> {
  const d = withAssignmentDeps(deps);
  requirePermissions(input.context, ["pms.reservation.read"]);
  await assertPropertyOfOrg(d.db, input.propertyId, input.context.organizationId);
  const rows = await d.db.roomConnection.findMany({
    where: { propertyId: input.propertyId, ...(input.roomId ? { OR: [{ roomAId: input.roomId }, { roomBId: input.roomId }] } : {}) },
    orderBy: [{ roomAId: "asc" }, { roomBId: "asc" }]
  });
  return rows.map(toRoomConnectionDto);
}
