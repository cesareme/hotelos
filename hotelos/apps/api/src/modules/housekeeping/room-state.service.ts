// Tanda L5 (lote A) · estado de habitación UNIFICADO — única fuente de verdad.
//
// Modelo (schema.prisma, model Room):
//   · `status`             = ocupación / disponibilidad (occupied | out_of_order |
//                            out_of_service) y, si la habitación está LIBRE, espejo
//                            de la limpieza (clean | dirty | inspected) para que los
//                            `groupBy status` existentes sigan valiendo;
//   · `housekeepingStatus` = limpieza con vocabulario cerrado dirty | clean |
//                            inspected (NOT NULL, default clean);
//   · `maintenanceStatus`  = ok | blocked | needs_attention (NOT NULL, default ok).
//
// Los alias de entrada (ready → clean; stayover | cleaning | in_progress → dirty)
// se aceptan en la ruta libre `POST /rooms/:id/housekeeping-status` pero NUNCA se
// almacenan. El gate «habitación limpia» sigue en el cliente y en el detector de
// la cola de recepción: `canAssignRoom` no bloquea por dirty.
//
// Diez escritores (check-in, check-out, cambio de habitación alojada, mark-clean,
// mark-inspected, ruta libre, bloqueo y liberación de mantenimiento, vendible /
// no vendible del Room Rack, importación) pasan por `applyRoomTransition`, que es
// IDEMPOTENTE: un evento que no cambia nada devuelve la fila sin escribir ni
// auditar; uno que cambia escribe con `updateMany where { id, status actual }`
// (concurrencia optimista) y registra `ROOM_STATE_CHANGED` (auditoría,
// before/after) + `RoomStateChanged` (dominio).
// Tenencia: responsabilidad del LLAMADOR (findRoomInOrg, assertEntityAccess,
// acceso a la reserva…), como en createSystemHousekeepingTask.
//
// Corrector L5 (OP-01): un bloqueo de mantenimiento sobre una habitación OCUPADA
// no sobrescribe la ocupación: `status` sigue `occupied` (el huésped sigue
// contando en los dashboards), `maintenanceStatus` pasa a blocked y deja de ser
// vendible; al check-out una bloqueada queda `out_of_order`. (OP-03): dentro de
// una transacción (`db` = cliente de transacción) los eventos NO se emiten hasta
// que el llamador confirme: `emitRoomStateEvents(result)` tras el commit, para que
// un rollback no deje ROOM_STATE_CHANGED fantasma en auditoría ni en event_stream.
// (OP-05): `mark_sellable` / `mark_unsellable` cubren POST /rooms/:id/sellable con
// el invariante blocked ⇒ sellable=false (liberar una bloqueada es 409: la libera
// la orden de trabajo).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";

// ---------------------------------------------------------------------------
// Vocabulario cerrado
// ---------------------------------------------------------------------------

export const HOUSEKEEPING_STATUSES = ["dirty", "clean", "inspected"] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

export const MAINTENANCE_STATUSES = ["ok", "blocked", "needs_attention"] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const ROOM_STATUSES = ["clean", "dirty", "inspected", "occupied", "out_of_order", "out_of_service"] as const;
export type RoomStatusValue = (typeof ROOM_STATUSES)[number];

export type RoomOccupancy = "vacant" | "occupied" | "out_of_order" | "out_of_service";

/** Alias de entrada admitidos por la ruta libre: se normalizan, nunca se almacenan. */
const HOUSEKEEPING_INPUT_ALIASES: Readonly<Record<string, HousekeepingStatus>> = {
  ready: "clean",
  stayover: "dirty",
  cleaning: "dirty",
  in_progress: "dirty"
};

export function isHousekeepingStatus(value: unknown): value is HousekeepingStatus {
  return typeof value === "string" && (HOUSEKEEPING_STATUSES as readonly string[]).includes(value);
}

export function isMaintenanceStatus(value: unknown): value is MaintenanceStatus {
  return typeof value === "string" && (MAINTENANCE_STATUSES as readonly string[]).includes(value);
}

export function isRoomStatus(value: unknown): value is RoomStatusValue {
  return typeof value === "string" && (ROOM_STATUSES as readonly string[]).includes(value);
}

/**
 * Normaliza un estado de limpieza de ENTRADA (ruta libre, importación): acepta el
 * vocabulario cerrado y los alias históricos (ready, stayover, cleaning,
 * in_progress); cualquier otro texto → null (el llamador responde 400).
 */
export function normalizeHousekeepingInput(raw: string): HousekeepingStatus | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (isHousekeepingStatus(value)) return value;
  return HOUSEKEEPING_INPUT_ALIASES[value] ?? null;
}

// ---------------------------------------------------------------------------
// roomStateOf — lectura única
// ---------------------------------------------------------------------------

export type RoomStateInput = {
  status: string;
  housekeepingStatus: string | null | undefined;
  maintenanceStatus: string | null | undefined;
  sellable: boolean;
};

export type RoomState = {
  occupancy: RoomOccupancy;
  /** Limpieza (por `housekeepingStatus`, en TODAS las ocupaciones). */
  cleanliness: HousekeepingStatus;
  /** clean | inspected. */
  isClean: boolean;
  /** maintenanceStatus === "blocked" || !sellable. */
  isBlocked: boolean;
};

function occupancyOf(status: string): RoomOccupancy {
  switch (status) {
    case "occupied":
      return "occupied";
    case "out_of_order":
      return "out_of_order";
    case "out_of_service":
      return "out_of_service";
    default:
      return "vacant";
  }
}

/**
 * Limpieza efectiva de una fila. Tras la migración `20260919090000_operaciones_l5`
 * `housekeepingStatus` siempre está en vocabulario; la tolerancia a NULL / alias
 * cubre solo espejos en memoria y filas de tests anteriores (misma regla que la
 * normalización SQL: NULL → espejo de status o clean; alias → su destino; resto → dirty).
 */
function cleanlinessOf(room: Pick<RoomStateInput, "status" | "housekeepingStatus">): HousekeepingStatus {
  const raw = room.housekeepingStatus;
  if (raw === null || raw === undefined || raw === "") {
    return isHousekeepingStatus(room.status) ? room.status : "clean";
  }
  return normalizeHousekeepingInput(raw) ?? "dirty";
}

export function roomStateOf(room: RoomStateInput): RoomState {
  const cleanliness = cleanlinessOf(room);
  return {
    occupancy: occupancyOf(room.status),
    cleanliness,
    isClean: cleanliness === "clean" || cleanliness === "inspected",
    isBlocked: room.maintenanceStatus === "blocked" || !room.sellable
  };
}

// ---------------------------------------------------------------------------
// nextRoomState — máquina de estados PURA
// ---------------------------------------------------------------------------

export type RoomStateEvent =
  | "check_in"
  | "check_out"
  | "mark_clean"
  | "mark_dirty"
  | "mark_inspected"
  | "block_maintenance"
  | "release_maintenance"
  | "mark_sellable"
  | "mark_unsellable";

export const ROOM_STATE_EVENTS: readonly RoomStateEvent[] = [
  "check_in",
  "check_out",
  "mark_clean",
  "mark_dirty",
  "mark_inspected",
  "block_maintenance",
  "release_maintenance",
  "mark_sellable",
  "mark_unsellable"
];

/** Los cuatro campos de estado de `model Room`, ya en vocabulario. */
export type RoomStateSnapshot = {
  status: RoomStatusValue;
  housekeepingStatus: HousekeepingStatus;
  maintenanceStatus: MaintenanceStatus;
  sellable: boolean;
};

export type RoomStateContext = {
  /**
   * Hay una reserva alojada en la habitación. Lo consultan `block_maintenance` y
   * `release_maintenance`; sin dato, vale `status === "occupied"` (status = ocupación).
   */
  inHouse?: boolean;
};

/** not_clean: mark_inspected sobre una sucia · blocked: mark_sellable sobre una bloqueada por orden de trabajo. */
export type RoomTransitionError = "not_clean" | "blocked";

export type RoomTransitionResult =
  | {
      ok: true;
      /** false = idempotente: nada que escribir ni auditar. */
      changed: boolean;
      next: RoomStateSnapshot;
      /** Solo los campos que cambian (lo que se escribe). */
      patch: Partial<RoomStateSnapshot>;
    }
  | { ok: false; error: RoomTransitionError };

/** Estado de limpieza que refleja `status` cuando la habitación está libre. */
function mirrorStatus(current: RoomStateSnapshot, cleanliness: HousekeepingStatus): RoomStatusValue {
  return occupancyOf(current.status) === "vacant" ? cleanliness : current.status;
}

function computeNext(current: RoomStateSnapshot, event: RoomStateEvent, context: RoomStateContext): RoomStateSnapshot | RoomTransitionError {
  const occupancy = occupancyOf(current.status);
  const inHouse = context.inHouse ?? occupancy === "occupied";
  switch (event) {
    case "check_in":
      // Ocupación; la limpieza es de pisos y no se toca.
      return { ...current, status: "occupied" };
    case "check_out": {
      // La habitación queda libre y sucia; una bloqueada por mantenimiento pasa a
      // out_of_order (OP-01: se bloqueó estando ocupada); una OOO/OOS conserva su
      // indisponibilidad.
      const status: RoomStatusValue =
        current.maintenanceStatus === "blocked"
          ? "out_of_order"
          : occupancy === "out_of_order" || occupancy === "out_of_service"
            ? current.status
            : "dirty";
      return { ...current, status, housekeepingStatus: "dirty" };
    }
    case "mark_clean": {
      // clean e inspected ya cuentan como limpias: no se degrada una inspeccionada.
      const cleanliness: HousekeepingStatus = current.housekeepingStatus === "inspected" ? "inspected" : "clean";
      return { ...current, housekeepingStatus: cleanliness, status: mirrorStatus(current, cleanliness) };
    }
    case "mark_dirty":
      return { ...current, housekeepingStatus: "dirty", status: mirrorStatus(current, "dirty") };
    case "mark_inspected": {
      if (current.housekeepingStatus === "dirty") return "not_clean";
      return { ...current, housekeepingStatus: "inspected", status: mirrorStatus(current, "inspected") };
    }
    case "block_maintenance":
      // Bloqueo: no vendible y bloqueada; la limpieza se conserva. Una OCUPADA sigue
      // ocupada (OP-01: el huésped no desaparece de los recuentos); una libre / OOS
      // pasa a out_of_order.
      return { ...current, status: inHouse ? "occupied" : "out_of_order", maintenanceStatus: "blocked", sellable: false };
    case "release_maintenance": {
      // Liberación: vuelve a estar disponible y SUCIA (tras una intervención se limpia);
      // si hay alguien alojado sigue ocupada; una OOS (importación) no es de mantenimiento.
      const status: RoomStatusValue = inHouse ? "occupied" : current.status === "out_of_service" ? "out_of_service" : "dirty";
      return { ...current, status, housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true };
    }
    case "mark_sellable": {
      // Room Rack «Desbloquear habitación» (OP-05): una bloqueada por orden de trabajo
      // NO se libera a mano (invariante blocked ⇒ sellable=false); una OOO/OOS sin
      // orden (importación, «Bloquear habitación») vuelve al inventario con su limpieza.
      if (current.maintenanceStatus === "blocked") return "blocked";
      const status: RoomStatusValue = occupancy === "out_of_order" || occupancy === "out_of_service" ? current.housekeepingStatus : current.status;
      return { ...current, status, sellable: true };
    }
    case "mark_unsellable": {
      // Room Rack «Bloquear habitación»: fuera de venta sin orden de trabajo; una
      // libre pasa a out_of_service (status = disponibilidad), una ocupada sigue
      // ocupada y una OOO conserva su estado.
      const status: RoomStatusValue = occupancy === "vacant" ? "out_of_service" : current.status;
      return { ...current, status, sellable: false };
    }
    default: {
      const never: never = event;
      throw new Error(`Evento de estado de habitación desconocido: ${String(never)}`);
    }
  }
}

/**
 * Transición PURA: sin base de datos, sin efectos. `changed:false` cuando el
 * evento no altera ningún campo (idempotencia: mark-clean sobre limpia,
 * mark-inspected sobre inspeccionada, check-in sobre ocupada, bloqueo sobre
 * bloqueada…). `ok:false` para `mark_inspected` sobre una sucia (`not_clean`) y
 * para `mark_sellable` sobre una bloqueada por orden de trabajo (`blocked`).
 */
export function nextRoomState(current: RoomStateSnapshot, event: RoomStateEvent, context: RoomStateContext = {}): RoomTransitionResult {
  const outcome = computeNext(current, event, context);
  if (typeof outcome === "string") return { ok: false, error: outcome };
  const patch: Partial<RoomStateSnapshot> = {};
  if (outcome.status !== current.status) patch.status = outcome.status;
  if (outcome.housekeepingStatus !== current.housekeepingStatus) patch.housekeepingStatus = outcome.housekeepingStatus;
  if (outcome.maintenanceStatus !== current.maintenanceStatus) patch.maintenanceStatus = outcome.maintenanceStatus;
  if (outcome.sellable !== current.sellable) patch.sellable = outcome.sellable;
  return { ok: true, changed: Object.keys(patch).length > 0, next: outcome, patch };
}

// ---------------------------------------------------------------------------
// foldRoomStateCounts — cifras únicas para los dashboards
// ---------------------------------------------------------------------------

export type RoomStateCountRow = { status: string; housekeepingStatus: string | null | undefined; count: number };

export type RoomStateCounts = {
  /** Limpieza por `housekeepingStatus` en TODAS las ocupaciones. */
  clean: number;
  dirty: number;
  inspected: number;
  /** Por `status`. */
  occupied: number;
  /** out_of_order + out_of_service. */
  outOfOrder: number;
  total: number;
};

/**
 * Pliega un `groupBy({ by: ["status", "housekeepingStatus"] })` en las cifras que
 * comparten `/dashboards/housekeeping`, operations-director,
 * `GET /properties/:id/dashboard` y el Room Rack.
 */
export function foldRoomStateCounts(rows: ReadonlyArray<RoomStateCountRow>): RoomStateCounts {
  const counts: RoomStateCounts = { clean: 0, dirty: 0, inspected: 0, occupied: 0, outOfOrder: 0, total: 0 };
  for (const row of rows) {
    const count = Number.isFinite(row.count) ? Math.max(0, Math.trunc(row.count)) : 0;
    if (count === 0) continue;
    const state = roomStateOf({ status: row.status, housekeepingStatus: row.housekeepingStatus, maintenanceStatus: "ok", sellable: true });
    counts.total += count;
    counts[state.cleanliness] += count;
    if (state.occupancy === "occupied") counts.occupied += count;
    else if (state.occupancy === "out_of_order" || state.occupancy === "out_of_service") counts.outOfOrder += count;
  }
  return counts;
}

/** Lista plegada (misma forma que el antiguo `groupBy status`) a partir de las cifras únicas. */
export function roomStateCountsAsList(counts: RoomStateCounts): Array<{ status: string; count: number }> {
  return [
    { status: "clean", count: counts.clean },
    { status: "dirty", count: counts.dirty },
    { status: "inspected", count: counts.inspected },
    { status: "occupied", count: counts.occupied },
    { status: "out_of_order", count: counts.outOfOrder }
  ];
}

// ---------------------------------------------------------------------------
// applyRoomTransition — escritura idempotente y auditada
// ---------------------------------------------------------------------------

export type RoomStateDb = Prisma.TransactionClient | typeof prisma;

type RoomRow = NonNullable<Awaited<ReturnType<typeof prisma.room.findUnique>>>;

export type ApplyRoomTransitionInput = {
  /**
   * Cliente de transacción cuando el estado debe ser atómico con la reserva
   * (check-in / check-out / cambio de habitación / bulk). OJO (OP-03): con un
   * cliente de transacción los eventos quedan DIFERIDOS — el llamador llama a
   * `emitRoomStateEvents(result)` después del commit.
   */
  db?: RoomStateDb;
  roomId: string;
  event: RoomStateEvent;
  context: UserContext;
  correlationId: string;
  /** Motivo legible que viaja en la auditoría (p. ej. «Check-out RES-00012»). */
  reason?: string;
};

export type ApplyRoomTransitionResult = {
  room: RoomRow;
  /** false = la habitación ya estaba en el estado pedido: sin escritura ni evento. */
  changed: boolean;
  state: RoomStateSnapshot;
  /**
   * true cuando `db` era un cliente de transacción: ROOM_STATE_CHANGED /
   * RoomStateChanged NO se han emitido todavía (un rollback no debe dejar
   * eventos fantasma). Llama a `emitRoomStateEvents(result)` tras el commit.
   */
  deferred: boolean;
  /** Emite los eventos UNA sola vez (no-op si nada cambió o ya se emitieron). */
  emitEvents: () => void;
};

export const ROOM_STATE_CHANGED_AUDIT_ACTION = "ROOM_STATE_CHANGED";
export const ROOM_STATE_CHANGED_EVENT_TYPE = "RoomStateChanged";

export function snapshotOf(row: Pick<RoomRow, "status" | "housekeepingStatus" | "maintenanceStatus" | "sellable">): RoomStateSnapshot {
  const status = String(row.status);
  return {
    status: isRoomStatus(status) ? status : "clean",
    housekeepingStatus: cleanlinessOf({ status, housekeepingStatus: row.housekeepingStatus }),
    maintenanceStatus: isMaintenanceStatus(row.maintenanceStatus) ? row.maintenanceStatus : "ok",
    sellable: Boolean(row.sellable)
  };
}

/** Emite los eventos diferidos de una o varias transiciones (tras el commit). Tolera null / undefined. */
export function emitRoomStateEvents(...results: Array<ApplyRoomTransitionResult | null | undefined>): void {
  for (const result of results) result?.emitEvents();
}

export async function applyRoomTransition(input: ApplyRoomTransitionInput): Promise<ApplyRoomTransitionResult> {
  const db = input.db ?? prisma;
  // Un cliente distinto del singleton es una transacción interactiva: los eventos se difieren (OP-03).
  const deferred = input.db !== undefined && input.db !== prisma;
  const row = await db.room.findUnique({ where: { id: input.roomId } });
  if (!row) throw new NotFoundError("Habitación no encontrada.");

  const current = snapshotOf(row);
  const context: RoomStateContext = {};
  if (input.event === "block_maintenance" || input.event === "release_maintenance") {
    context.inHouse = (await db.reservation.count({ where: { assignedRoomId: row.id, status: "checked_in" } })) > 0;
  }

  const outcome = nextRoomState(current, input.event, context);
  if (!outcome.ok) {
    if (outcome.error === "blocked") {
      throw new ConflictError("La habitación está bloqueada por una orden de trabajo: resuélvela para liberarla; el bloqueo no se quita a mano.", {
        code: "ROOM_MAINTENANCE_BLOCKED",
        roomId: row.id
      });
    }
    throw new ConflictError("Solo se pueden inspeccionar habitaciones limpias.", { code: "ROOM_NOT_CLEAN", roomId: row.id, housekeepingStatus: current.housekeepingStatus });
  }
  if (!outcome.changed) {
    return { room: row, changed: false, state: current, deferred: false, emitEvents: () => undefined };
  }

  // Concurrencia optimista: solo escribe si `status` sigue siendo el leído.
  const written = await db.room.updateMany({
    where: { id: row.id, status: row.status },
    data: outcome.patch
  });
  if (written.count !== 1) {
    throw new ConflictError("La habitación ha cambiado de estado mientras se procesaba; recarga y vuelve a intentarlo.", {
      code: "ROOM_STATE_CHANGED_MEANWHILE",
      roomId: row.id
    });
  }
  const updated = await db.room.findUniqueOrThrow({ where: { id: row.id } });

  const actorType = input.context.userId ? "user" : "system";
  let emitted = false;
  const emitEvents = (): void => {
    if (emitted) return;
    emitted = true;
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: row.propertyId,
      actorUserId: input.context.userId || undefined,
      actorType,
      action: ROOM_STATE_CHANGED_AUDIT_ACTION,
      entityType: "room",
      entityId: row.id,
      beforeJson: current,
      afterJson: { ...outcome.next, event: input.event, reason: input.reason ?? null },
      correlationId: input.correlationId
    });
    recordDomainEvent({
      organizationId: input.context.organizationId,
      propertyId: row.propertyId,
      entityType: "room",
      entityId: row.id,
      eventType: ROOM_STATE_CHANGED_EVENT_TYPE,
      payload: { roomNumber: row.number, event: input.event, before: current, after: outcome.next, reason: input.reason ?? null },
      actorType,
      actorUserId: input.context.userId || undefined,
      correlationId: input.correlationId
    });
  };
  if (!deferred) emitEvents();

  return { room: updated, changed: true, state: outcome.next, deferred, emitEvents };
}
