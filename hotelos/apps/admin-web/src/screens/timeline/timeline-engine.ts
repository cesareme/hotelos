// Live Timeline · motor puro (Tanda TL · lote TL-1).
//
// Lógica sin DOM ni red: fechas, escala, geometría de bloques (llegada y
// salida a media celda), filas por tipo y habitación, ventana de
// virtualización, arrastre (destino, validación local y avisos), colisiones y
// overbooking por tipo y día, filtros, navegación por teclado, creación por
// celdas y mapeo de errores del API. La presentación (React, formateadores, tokens
// Cocoa) vive en components/timeline y en LiveTimeline.tsx; aquí solo hay datos
// y cadenas en español sin formatear (las fechas y el dinero se formatean en la
// presentación con lib/format). Unit-tested en __tests__/timeline-engine.test.mts.

import type { AdminReservation, AdminRoom, AdminRoomType, ReservationPatch } from "../../services/pmsCommerceApi";
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";

// ---------------------------------------------------------------------------
// Fechas (solo día, UTC, sin deriva de zona horaria)
// ---------------------------------------------------------------------------

export const MS_DAY = 86_400_000;

/** «YYYY-MM-DD» (o un ISO más largo) → medianoche UTC de ese día. */
export function parseDateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

/** Fecha → «YYYY-MM-DD» (UTC). */
export function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addDays(value: Date, n: number): Date {
  return new Date(value.getTime() + n * MS_DAY);
}

/** Días completos entre dos fechas (redondeado, tolera saltos horarios). */
export function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_DAY);
}

/**
 * Día civil local expresado en UTC («2026-09-18»). Es el fallback cuando el
 * API de fecha de negocio no responde: la fecha de negocio de la propiedad
 * manda y la pantalla la pide primero; si esa llamada falla se usa este valor
 * y la pantalla lo avisa.
 */
export function todayLocalIso(): string {
  const now = new Date();
  return toDateOnly(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

/** Un día de contexto a la izquierda para ver las salidas de hoy a media celda. */
export const CONTEXT_DAYS_BEFORE = 1;

/** Inicio del rango al pulsar «Hoy»: hoy menos el contexto de la izquierda. */
export function anchorForToday(todayKey: string): Date {
  return addDays(parseDateOnly(todayKey), -CONTEXT_DAYS_BEFORE);
}

/**
 * «Hoy» de la pantalla: la fecha de negocio de la propiedad o, si va por
 * detrás (cierre nocturno pendiente), el día local. Es la misma regla que el
 * check-in del API (`referenceDate = max(businessDate, localToday)`,
 * pms.service.ts), así los bloques «Llega hoy», los contadores y la ventana de
 * check-in coinciden con lo que el API acepta. Sin fecha de negocio, el día local.
 */
export function referenceToday(businessDate: string | null | undefined, localToday: string): string {
  const business = (businessDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(business)) return localToday;
  return business > localToday ? business : localToday;
}

// ---------------------------------------------------------------------------
// Escala y constantes de geometría
// ---------------------------------------------------------------------------

export type Granularity = "day" | "week" | "month";

export const GRANULARITY_DAYS: Record<Granularity, number> = { day: 7, week: 14, month: 30 };
export const CELL_WIDTH: Record<Granularity, number> = { day: 150, week: 118, month: 64 };
/** Escala en pantallas estrechas (< 600 px): celdas más cortas para ver más de un día. */
export const CELL_WIDTH_NARROW: Record<Granularity, number> = { day: 120, week: 88, month: 48 };

/** Anchura de la columna fija de recursos (habitación, tipo, pax). */
export const LEAD_WIDTH = 200;
/** Columna de recursos en pantallas estrechas (solo el número y el estado; el resto con elipsis). */
export const LEAD_WIDTH_NARROW = 104;
/** Altura de la cabecera de días. */
export const HEAD_HEIGHT = 48;
export const BAR_HEIGHT = 40;
export const LANE_GAP = 6;
export const ROW_MIN_HEIGHT = 56;
export const GROUP_ROW_HEIGHT = 36;
export const UNASSIGNED_ID = "__unassigned__";
export const UNASSIGNED_LABEL = "Sin asignar";
/** Grupo de las habitaciones cuyo roomTypeId no está en la lista de tipos. */
export const UNTYPED_ID = "__untyped__";
export const UNTYPED_LABEL = "Sin tipo";
/** Píxeles de movimiento a partir de los que un pulsado deja de ser un clic. */
export const DRAG_THRESHOLD_PX = 4;
export const MIN_BAR_WIDTH = 24;

export type TimelineRange = {
  start: Date;
  /** Exclusivo: start + dayCount. */
  end: Date;
  dayCount: number;
  cellWidth: number;
  granularity: Granularity;
};

export function rangeFor(anchor: Date, granularity: Granularity, options: { narrow?: boolean } = {}): TimelineRange {
  const dayCount = GRANULARITY_DAYS[granularity];
  const start = parseDateOnly(toDateOnly(anchor));
  const cellWidth = (options.narrow ? CELL_WIDTH_NARROW : CELL_WIDTH)[granularity];
  return { start, end: addDays(start, dayCount), dayCount, cellWidth, granularity };
}

export type DayColumn = {
  key: string;
  index: number;
  date: Date;
  isToday: boolean;
  isWeekend: boolean;
};

/** Columnas del rango; las etiquetas (día de la semana, día/mes) las pone la presentación. */
export function columnsFor(range: TimelineRange, todayKey: string): DayColumn[] {
  return Array.from({ length: range.dayCount }, (_, index) => {
    const date = addDays(range.start, index);
    const key = toDateOnly(date);
    const weekday = date.getUTCDay();
    return { key, index, date, isToday: key === todayKey, isWeekend: weekday === 0 || weekday === 6 };
  });
}

// ---------------------------------------------------------------------------
// Estado visual de una reserva (color por estado)
// ---------------------------------------------------------------------------

export type BarKind =
  | "arrival_today"
  | "in_house"
  | "departure_today"
  | "confirmed"
  | "draft"
  | "checked_out"
  | "no_show"
  | "cancelled";

/** Orden de la leyenda. */
export const BAR_KINDS: readonly BarKind[] = [
  "arrival_today",
  "in_house",
  "departure_today",
  "confirmed",
  "draft",
  "checked_out",
  "no_show",
  "cancelled"
];

export function barKind(res: Pick<AdminReservation, "status" | "arrivalDate" | "departureDate">, todayKey: string): BarKind {
  const status = res.status;
  if (status === "checked_in") return res.departureDate.slice(0, 10) === todayKey ? "departure_today" : "in_house";
  if (status === "confirmed" || status === "draft") {
    if (res.arrivalDate.slice(0, 10) === todayKey) return "arrival_today";
    return status;
  }
  if (status === "checked_out" || status === "no_show" || status === "cancelled") return status;
  return "confirmed";
}

/**
 * Tono por estado. Solo hay siete tonos Cocoa, así que los tres «neutros»
 * (borrador, salida, no-show) se distinguen además por el trazo del bloque
 * (`data-kind` en la hoja: borrador discontinuo, salida atenuada, no-show
 * punteado y tachado) y por la variante de la leyenda (LEGEND_VARIANT).
 */
export const BAR_KIND_TONE: Record<BarKind, CocoaTone> = {
  arrival_today: "accent",
  in_house: "success",
  departure_today: "warning",
  confirmed: "info",
  draft: "neutral",
  checked_out: "neutral",
  no_show: "warning",
  cancelled: "danger"
};

export const BAR_KIND_LABEL: Record<BarKind, string> = {
  arrival_today: "Llega hoy",
  in_house: "En casa",
  departure_today: "Sale hoy",
  confirmed: "Confirmada",
  draft: "Borrador",
  checked_out: "Salida",
  no_show: "No-show",
  cancelled: "Cancelada"
};

/** Etiqueta del estado de reserva del API (para filtros y ficha). */
export const RES_STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  checked_in: "En casa",
  checked_out: "Salida",
  cancelled: "Cancelada",
  no_show: "No-show"
};

// ---------------------------------------------------------------------------
// Habitación: estado, bloqueo y capacidad
// ---------------------------------------------------------------------------

export type RoomStatusKey = "clean" | "dirty" | "inspected" | "occupied" | "blocked";

export const ROOM_STATUS_KEYS: readonly RoomStatusKey[] = ["clean", "dirty", "inspected", "occupied", "blocked"];

/** Misma regla que la validación de asignación del API: mantenimiento, no vendible o fuera de servicio. */
export function roomBlocked(room: Pick<AdminRoom, "status" | "maintenanceStatus" | "sellable">): boolean {
  return (
    room.maintenanceStatus === "blocked" ||
    !room.sellable ||
    room.status === "out_of_order" ||
    room.status === "out_of_service"
  );
}

export function roomStatusKey(room: Pick<AdminRoom, "status" | "housekeepingStatus" | "maintenanceStatus" | "sellable">): RoomStatusKey {
  if (roomBlocked(room)) return "blocked";
  if (room.status === "occupied") return "occupied";
  const hk = room.housekeepingStatus;
  if (hk === "dirty" || hk === "clean" || hk === "inspected") return hk;
  const status = room.status;
  if (status === "dirty" || status === "clean" || status === "inspected") return status;
  return "clean";
}

export const ROOM_STATUS_LABEL: Record<RoomStatusKey, string> = {
  clean: "Limpia",
  dirty: "Sucia",
  inspected: "Inspeccionada",
  occupied: "Ocupada",
  blocked: "Bloqueada"
};

export const ROOM_STATUS_TONE: Record<RoomStatusKey, CocoaTone> = {
  clean: "success",
  dirty: "warning",
  inspected: "success",
  occupied: "info",
  blocked: "danger"
};

export function roomCapacity(
  room: Pick<AdminRoom, "roomTypeId">,
  roomTypeById: ReadonlyMap<string, Pick<AdminRoomType, "maxOccupancy">>
): number | undefined {
  return roomTypeById.get(room.roomTypeId)?.maxOccupancy;
}

// ---------------------------------------------------------------------------
// Huésped visible
// ---------------------------------------------------------------------------

export const NO_GUEST_LABEL = "Sin huésped";
export const PENDING_GUEST_LABEL = "Huésped pendiente";
/**
 * La pantalla guarda esta etiqueta como «nombre resuelto» cuando GET /guests/:id
 * responde 403 (perfil sin guests.read): el bloque deja de decir «pendiente»
 * para siempre y dice la verdad. Nunca se inventa un nombre.
 */
export const HIDDEN_GUEST_LABEL = "Huésped no visible";

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * Nombre que se pinta en el bloque: el reservante, el nombre resuelto del
 * huésped principal, «Huésped pendiente» si solo hay id, y en su defecto la
 * empresa o el grupo. Nunca el id ni el código de la reserva.
 */
export function guestLabel(
  res: Pick<AdminReservation, "bookerName" | "primaryGuestId" | "companyName" | "groupCode">,
  resolvedName?: string | null
): string {
  const booker = text(res.bookerName);
  if (booker) return booker;
  const resolved = text(resolvedName);
  if (resolved) return resolved;
  if (text(res.primaryGuestId)) return PENDING_GUEST_LABEL;
  return text(res.companyName) || text(res.groupCode) || NO_GUEST_LABEL;
}

// ---------------------------------------------------------------------------
// Bloques con media celda (llegada y salida a mediodía)
// ---------------------------------------------------------------------------

export type BarModel = {
  id: string;
  res: AdminReservation;
  kind: BarKind;
  tone: CocoaTone;
  /** Días desde el inicio del rango hasta la llegada (puede ser negativo). */
  offset: number;
  nights: number;
  /** Celdas desde el inicio del rango hasta el borde izquierdo del bloque. */
  laneStart: number;
  /** Celdas desde el inicio del rango hasta el borde derecho del bloque. */
  laneEnd: number;
  continuesLeft: boolean;
  continuesRight: boolean;
  lane: number;
};

export type BarPlacement = Omit<BarModel, "lane" | "kind" | "tone">;

export function nightsOf(res: Pick<AdminReservation, "arrivalDate" | "departureDate">): number {
  return Math.max(1, diffDays(parseDateOnly(res.arrivalDate), parseDateOnly(res.departureDate)));
}

/**
 * Posición de una reserva en el rango, o null si no toca el rango. La salida a
 * mediodía del primer día del rango sí se pinta (laneEnd 0,5); la llegada el
 * día `range.end` no.
 */
export function blockFor(res: AdminReservation, range: Pick<TimelineRange, "start" | "end" | "dayCount">): BarPlacement | null {
  const arrival = parseDateOnly(res.arrivalDate);
  const departure = parseDateOnly(res.departureDate);
  if (!(arrival < range.end && departure >= range.start)) return null;
  const offset = diffDays(range.start, arrival);
  const nights = Math.max(1, diffDays(arrival, departure));
  const continuesLeft = offset < 0;
  const continuesRight = offset + nights + 0.5 > range.dayCount;
  return {
    id: res.id,
    res,
    offset,
    nights,
    laneStart: continuesLeft ? 0 : offset + 0.5,
    laneEnd: continuesRight ? range.dayCount : offset + nights + 0.5,
    continuesLeft,
    continuesRight
  };
}

export type BarGeometry = { left: number; width: number; top: number; height: number };

export function barGeometry(
  bar: Pick<BarModel, "laneStart" | "laneEnd" | "lane">,
  range: Pick<TimelineRange, "cellWidth">
): BarGeometry {
  const leftPx = bar.laneStart * range.cellWidth;
  const rightPx = bar.laneEnd * range.cellWidth;
  return {
    left: leftPx + 2,
    width: Math.max(MIN_BAR_WIDTH, rightPx - leftPx - 4),
    top: bar.lane * (BAR_HEIGHT + LANE_GAP) + LANE_GAP,
    height: BAR_HEIGHT
  };
}

/**
 * Reparto en carriles (interval partitioning) sobre laneStart/laneEnd: dos
 * estancias consecutivas en la misma habitación (salida y llegada el mismo día)
 * comparten carril porque el laneEnd de la primera es el laneStart de la segunda.
 */
export function assignLanes<T extends { laneStart: number; laneEnd: number }>(
  items: T[]
): { laid: (T & { lane: number })[]; laneCount: number } {
  const ends: number[] = [];
  const order = [...items.keys()].sort(
    (a, b) => items[a].laneStart - items[b].laneStart || items[a].laneEnd - items[b].laneEnd
  );
  const laneOf = new Array<number>(items.length).fill(0);
  for (const i of order) {
    const item = items[i];
    let placed = false;
    for (let lane = 0; lane < ends.length; lane++) {
      if (item.laneStart >= ends[lane]) {
        laneOf[i] = lane;
        ends[lane] = item.laneEnd;
        placed = true;
        break;
      }
    }
    if (!placed) {
      laneOf[i] = ends.length;
      ends.push(item.laneEnd);
    }
  }
  return { laid: items.map((item, i) => ({ ...item, lane: laneOf[i] })), laneCount: Math.max(1, ends.length) };
}

export function rowHeight(laneCount: number): number {
  return Math.max(ROW_MIN_HEIGHT, laneCount * (BAR_HEIGHT + LANE_GAP) + LANE_GAP);
}

function barsFor(
  list: AdminReservation[],
  range: TimelineRange,
  todayKey: string
): { bars: BarModel[]; laneCount: number } {
  const placed: BarPlacement[] = [];
  for (const res of list) {
    const block = blockFor(res, range);
    if (block) placed.push(block);
  }
  const { laid, laneCount } = assignLanes(placed);
  const bars = laid.map((bar) => {
    const kind = barKind(bar.res, todayKey);
    return { ...bar, kind, tone: BAR_KIND_TONE[kind] };
  });
  return { bars, laneCount };
}

// ---------------------------------------------------------------------------
// Filas (carril «Sin asignar», grupos por tipo, habitaciones)
// ---------------------------------------------------------------------------

export type ResourceRow =
  | {
      kind: "unassigned";
      id: typeof UNASSIGNED_ID;
      label: typeof UNASSIGNED_LABEL;
      bars: BarModel[];
      laneCount: number;
      height: number;
    }
  | {
      kind: "group";
      /** Igual al roomTypeId (o UNTYPED_ID para «Sin tipo»). */
      id: string;
      roomTypeId: string;
      label: string;
      collapsed: boolean;
      roomCount: number;
      /** Habitaciones del tipo no bloqueadas. */
      sellable: number;
      /** Libres por columna del rango (puede ser negativo en overbooking). */
      free: number[];
      height: number;
    }
  | {
      kind: "room";
      id: string;
      room: AdminRoom;
      roomTypeId: string;
      label: string;
      typeLabel: string;
      capacity?: number;
      statusKey: RoomStatusKey;
      blocked: boolean;
      bars: BarModel[];
      laneCount: number;
      height: number;
    };

export type BuildRowsInput = {
  rooms: ReadonlyArray<AdminRoom>;
  /** En el orden del API (displayOrder ascendente). */
  roomTypes: ReadonlyArray<AdminRoomType>;
  /** Ya filtradas. */
  reservations: ReadonlyArray<AdminReservation>;
  range: TimelineRange;
  todayKey: string;
  collapsed: ReadonlySet<string>;
  /** Libres por tipo y columna (availabilityByType). */
  availability: ReadonlyMap<string, number[]>;
};

export function sortRoomsByNumber<T extends Pick<AdminRoom, "number">>(rooms: ReadonlyArray<T>): T[] {
  return [...rooms].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export function buildRows(input: BuildRowsInput): ResourceRow[] {
  const { range, todayKey, collapsed } = input;
  const rows: ResourceRow[] = [];

  const unassigned = input.reservations.filter((r) => !r.assignedRoomId && r.status !== "cancelled");
  if (unassigned.length) {
    const { bars, laneCount } = barsFor(unassigned, range, todayKey);
    if (bars.length) {
      rows.push({ kind: "unassigned", id: UNASSIGNED_ID, label: UNASSIGNED_LABEL, bars, laneCount, height: rowHeight(laneCount) });
    }
  }

  const byRoom = new Map<string, AdminReservation[]>();
  for (const r of input.reservations) {
    if (!r.assignedRoomId) continue;
    const list = byRoom.get(r.assignedRoomId);
    if (list) list.push(r);
    else byRoom.set(r.assignedRoomId, [r]);
  }

  const roomTypeById = new Map(input.roomTypes.map((t) => [t.id, t]));
  const roomsByType = new Map<string, AdminRoom[]>();
  for (const room of sortRoomsByNumber(input.rooms)) {
    const key = roomTypeById.has(room.roomTypeId) ? room.roomTypeId : UNTYPED_ID;
    const list = roomsByType.get(key);
    if (list) list.push(room);
    else roomsByType.set(key, [room]);
  }

  const zeros = () => new Array<number>(range.dayCount).fill(0);
  const pushGroup = (groupId: string, label: string, typeLabel: string, rooms: AdminRoom[], capacity: number | undefined) => {
    const isCollapsed = collapsed.has(groupId);
    rows.push({
      kind: "group",
      id: groupId,
      roomTypeId: groupId,
      label,
      collapsed: isCollapsed,
      roomCount: rooms.length,
      sellable: rooms.filter((room) => !roomBlocked(room)).length,
      free: input.availability.get(groupId) ?? zeros(),
      height: GROUP_ROW_HEIGHT
    });
    if (isCollapsed) return;
    for (const room of rooms) {
      const { bars, laneCount } = barsFor(byRoom.get(room.id) ?? [], range, todayKey);
      rows.push({
        kind: "room",
        id: room.id,
        room,
        roomTypeId: room.roomTypeId,
        label: `Hab. ${room.number}`,
        typeLabel,
        capacity,
        statusKey: roomStatusKey(room),
        blocked: roomBlocked(room),
        bars,
        laneCount,
        height: rowHeight(laneCount)
      });
    }
  };

  for (const type of input.roomTypes) {
    const rooms = roomsByType.get(type.id);
    if (!rooms) continue;
    pushGroup(type.id, type.name, type.name, rooms, type.maxOccupancy);
  }
  const untyped = roomsByType.get(UNTYPED_ID);
  if (untyped) pushGroup(UNTYPED_ID, UNTYPED_LABEL, UNTYPED_LABEL, untyped, undefined);

  return rows;
}

// ---------------------------------------------------------------------------
// Virtualización de filas
// ---------------------------------------------------------------------------

/** Sumas prefijas de alturas: offsets[i] = píxel donde empieza la fila i; longitud rows.length + 1. */
export function rowOffsets(rows: ReadonlyArray<{ height: number }>): number[] {
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + rows[i].height;
  return offsets;
}

export type RowWindow = { start: number; end: number; topSpacer: number; bottomSpacer: number };

/**
 * Filas [start, end) que cubren el viewport más el overscan. `scrollTop` es
 * RELATIVO al inicio de las filas: el que llama resta la cabecera fija
 * (HEAD_HEIGHT + GROUP_ROW_HEIGHT de la fila «Libres» sticky).
 */
export function rowWindow(offsets: ReadonlyArray<number>, scrollTop: number, viewportHeight: number, overscanPx = 200): RowWindow {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 };
  const total = offsets[count];
  const from = Math.max(0, scrollTop - overscanPx);
  const to = Math.min(total, scrollTop + viewportHeight + overscanPx);

  // start: última fila cuyo inicio es ≤ from.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= from) lo = mid;
    else hi = mid - 1;
  }
  const start = lo;

  // end: primera fila cuyo inicio es ≥ to (exclusivo).
  lo = start;
  hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] >= to) hi = mid;
    else lo = mid + 1;
  }
  const end = Math.max(lo, Math.min(start + 1, count));

  return { start, end, topSpacer: offsets[start], bottomSpacer: total - offsets[end] };
}

/**
 * Ventana que además contiene la fila `rowIndex` (la fila origen de un
 * arrastre: el fantasma vive en su carril y no debe desmontarse aunque el
 * autoscroll vertical la saque del viewport). Sin fila (null / fuera de rango)
 * devuelve la misma ventana.
 */
export function pinRow(win: RowWindow, offsets: ReadonlyArray<number>, rowIndex: number | null): RowWindow {
  const count = offsets.length - 1;
  if (rowIndex === null || rowIndex < 0 || rowIndex >= count) return win;
  if (rowIndex >= win.start && rowIndex < win.end) return win;
  const start = Math.min(win.start, rowIndex);
  const end = Math.max(win.end, rowIndex + 1);
  return { start, end, topSpacer: offsets[start], bottomSpacer: offsets[count] - offsets[end] };
}

// ---------------------------------------------------------------------------
// Arrastre: destino, permisos, validación local y avisos
// ---------------------------------------------------------------------------

export function snapDays(dxPx: number, cellWidth: number): number {
  // `|| 0` evita el -0 de Math.round con desplazamientos negativos pequeños.
  return Math.round(dxPx / cellWidth) || 0;
}

export function dragPhase(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): "click" | "drag" {
  return Math.abs(dx) > threshold || Math.abs(dy) > threshold ? "drag" : "click";
}

export type DragMode = "move" | "resize-end" | "resize-start";

export const IN_HOUSE_DRAG_REASON = "Una reserva en casa solo puede cambiar de habitación";
export const CLOSED_DRAG_REASON = "La reserva está cerrada";
export const DEPARTURE_AFTER_ARRIVAL = "La salida debe ser posterior a la llegada";
export const ARRIVAL_BEFORE_DEPARTURE = "La llegada debe ser anterior a la salida";
export const PRICE_NOT_REQUOTED_WARNING = "El precio no se recalcula al cambiar las fechas: revísalo en la reserva";
export const ROOM_BLOCKED_WARNING = "La habitación está bloqueada por mantenimiento";
/** Motivos de rechazo local alineados con canAssignRoom del API (inventory.engine.ts): el diálogo no llega a abrirse. */
export const ROOM_BLOCKED_REASON = "La habitación está bloqueada por mantenimiento o no es vendible";
export const ROOM_OCCUPIED_REASON = "La habitación está ocupada actualmente";

/** «La habitación 202 ya está asignada a la reserva R-1 en esas fechas». */
export function roomOverlapReason(roomNumber: string, code: string): string {
  return `La habitación ${roomNumber} ya está asignada a la reserva ${code} en esas fechas`;
}

const CLOSED_STATUSES: ReadonlySet<string> = new Set(["checked_out", "cancelled", "no_show"]);
/** Estados que ocupan inventario (los mismos que canAssignRoom y la disponibilidad por tipo). */
const OCCUPYING_STATUSES: ReadonlySet<string> = new Set(["confirmed", "checked_in"]);

export type DragPermission = { move: boolean; resize: boolean; room: boolean; reason?: string };

/**
 * Qué admite el API por estado: en casa solo el cambio de habitación (el
 * PATCH de una checked_in delega en el traslado transaccional); cerrada, nada.
 */
export function dragAllowed(res: Pick<AdminReservation, "status">): DragPermission {
  if (res.status === "checked_in") return { move: false, resize: false, room: true, reason: IN_HOUSE_DRAG_REASON };
  if (CLOSED_STATUSES.has(res.status)) return { move: false, resize: false, room: false, reason: CLOSED_DRAG_REASON };
  return { move: true, resize: true, room: true };
}

export type PendingChange =
  | {
      type: "move";
      res: AdminReservation;
      newRoomId: string | null;
      newRoomLabel?: string;
      newArrival: string | null;
      newDeparture: string | null;
      warnings: string[];
    }
  | {
      type: "resize";
      res: AdminReservation;
      newArrivalDate: string;
      newDepartureDate: string;
      warnings: string[];
    }
  | { type: "checkin" | "checkout" | "cancel" | "noshow" | "assign"; res: AdminReservation };

export type DropResolution = { pending: PendingChange | null; rejected: string | null };

/** Lo que necesita la validación local de habitación de cada reserva cargada. */
export type RoomOccupant = Pick<AdminReservation, "id" | "code" | "status" | "assignedRoomId" | "arrivalDate" | "departureDate">;

export type ResolveDropInput = {
  res: AdminReservation;
  mode: DragMode;
  dxDays: number;
  /** Fila bajo el puntero al soltar (UNASSIGNED_ID incluido) o null. */
  targetRoomId: string | null;
  roomById: ReadonlyMap<string, AdminRoom>;
  roomTypeById: ReadonlyMap<string, AdminRoomType>;
  /** Reservas cargadas en el rango (todas, sin filtrar): ocupación y solapes en la habitación destino. */
  reservations?: ReadonlyArray<RoomOccupant>;
};

const NOTHING: DropResolution = { pending: null, rejected: null };

/**
 * Misma regla que canAssignRoom del API sobre los datos cargados: bloqueada
 * (mantenimiento / no vendible / fuera de servicio) → rechazo; ocupada por OTRA
 * reserva en casa (o marcada `occupied` sin que la ocupe esta misma reserva) →
 * rechazo; otra confirmada o en casa asignada a esa habitación que solape las
 * nuevas fechas → rechazo. Devuelve null si nada lo impide. Los solapes fuera
 * de la ventana cargada los sigue rechazando el API (409).
 */
export function roomAssignmentConflict(
  res: Pick<AdminReservation, "id">,
  room: AdminRoom,
  stay: { arrivalDate: string; departureDate: string },
  reservations: ReadonlyArray<RoomOccupant> = []
): string | null {
  if (roomBlocked(room)) return ROOM_BLOCKED_REASON;
  const others = reservations.filter((other) => other.id !== res.id && other.assignedRoomId === room.id);
  const inHouseOthers = others.filter((other) => other.status === "checked_in");
  const inHouseSelf = reservations.some((other) => other.id === res.id && other.status === "checked_in" && other.assignedRoomId === room.id);
  if (inHouseOthers.length > 0 || (room.status === "occupied" && !inHouseSelf)) return ROOM_OCCUPIED_REASON;
  const arrival = stay.arrivalDate.slice(0, 10);
  const departure = stay.departureDate.slice(0, 10);
  const overlap = others.find(
    (other) => OCCUPYING_STATUSES.has(other.status) && other.arrivalDate.slice(0, 10) < departure && other.departureDate.slice(0, 10) > arrival
  );
  return overlap ? roomOverlapReason(room.number, overlap.code) : null;
}

/** Avisos locales de un cambio de habitación (el API no valida tipo ni pax; el bloqueo sí lo rechaza). */
export function roomChangeWarnings(
  res: Pick<AdminReservation, "roomTypeId" | "adults" | "children">,
  room: AdminRoom,
  roomTypeById: ReadonlyMap<string, AdminRoomType>
): string[] {
  const warnings: string[] = [];
  if (room.roomTypeId !== res.roomTypeId) {
    const roomType = roomTypeById.get(room.roomTypeId)?.name ?? room.roomTypeId;
    const resType = roomTypeById.get(res.roomTypeId)?.name ?? res.roomTypeId;
    warnings.push(`La habitación ${room.number} es de tipo ${roomType} y la reserva es de tipo ${resType}`);
  }
  const capacity = roomCapacity(room, roomTypeById);
  const pax = res.adults + res.children;
  if (capacity !== undefined && pax > capacity) {
    warnings.push(`La habitación admite ${capacity} personas y la reserva lleva ${pax}`);
  }
  if (roomBlocked(room)) warnings.push(ROOM_BLOCKED_WARNING);
  return warnings;
}

export function resolveDrop(input: ResolveDropInput): DropResolution {
  const { res, mode, dxDays } = input;
  const allowed = dragAllowed(res);
  if (!allowed.move && !allowed.resize && !allowed.room) {
    return { pending: null, rejected: allowed.reason ?? CLOSED_DRAG_REASON };
  }
  const arrival = parseDateOnly(res.arrivalDate);
  const departure = parseDateOnly(res.departureDate);

  // El PATCH de fechas revalida la habitación asignada sobre la nueva estancia
  // (pms.service.ts, REC-01b) y assign-room la destino: misma comprobación aquí.
  const currentRoom = res.assignedRoomId ? input.roomById.get(res.assignedRoomId) : undefined;
  const conflictIn = (room: AdminRoom | undefined, stay: { arrivalDate: string; departureDate: string }): string | null =>
    room ? roomAssignmentConflict(res, room, stay, input.reservations) : null;

  if (mode === "resize-end" || mode === "resize-start") {
    if (dxDays === 0) return NOTHING;
    if (!allowed.resize) return { pending: null, rejected: allowed.reason ?? IN_HOUSE_DRAG_REASON };
    let stay: { arrivalDate: string; departureDate: string };
    if (mode === "resize-end") {
      const newDeparture = addDays(departure, dxDays);
      if (!(newDeparture > arrival)) return { pending: null, rejected: DEPARTURE_AFTER_ARRIVAL };
      stay = { arrivalDate: toDateOnly(arrival), departureDate: toDateOnly(newDeparture) };
    } else {
      const newArrival = addDays(arrival, dxDays);
      if (!(newArrival < departure)) return { pending: null, rejected: ARRIVAL_BEFORE_DEPARTURE };
      stay = { arrivalDate: toDateOnly(newArrival), departureDate: toDateOnly(departure) };
    }
    const conflict = conflictIn(currentRoom, stay);
    if (conflict) return { pending: null, rejected: conflict };
    return {
      pending: { type: "resize", res, newArrivalDate: stay.arrivalDate, newDepartureDate: stay.departureDate, warnings: [PRICE_NOT_REQUOTED_WARNING] },
      rejected: null
    };
  }

  // move: fila bajo el puntero + desplazamiento en días.
  const targetRoomId = input.targetRoomId;
  const roomChanged =
    !!targetRoomId && targetRoomId !== UNASSIGNED_ID && targetRoomId !== (res.assignedRoomId ?? null);
  let newArrival = dxDays !== 0 ? toDateOnly(addDays(arrival, dxDays)) : null;
  let newDeparture = newArrival ? toDateOnly(addDays(parseDateOnly(newArrival), nightsOf(res))) : null;
  if (!roomChanged && !newArrival) return NOTHING;

  const warnings: string[] = [];
  if (newArrival && !allowed.move) {
    // En casa: las fechas no se tocan; si además cambia la habitación, se
    // propone solo el cambio de habitación y se avisa.
    if (!roomChanged) return { pending: null, rejected: allowed.reason ?? IN_HOUSE_DRAG_REASON };
    newArrival = null;
    newDeparture = null;
    if (allowed.reason) warnings.push(allowed.reason);
  }

  const targetRoom = roomChanged && targetRoomId ? input.roomById.get(targetRoomId) : undefined;
  // Habitación que tendrá la reserva tras el cambio, sobre las fechas nuevas
  // (o las actuales si solo cambia la habitación): bloqueo, ocupación y solape.
  const conflict = conflictIn(targetRoom ?? currentRoom, {
    arrivalDate: newArrival ?? res.arrivalDate,
    departureDate: newDeparture ?? res.departureDate
  });
  if (conflict) return { pending: null, rejected: conflict };
  if (targetRoom) warnings.push(...roomChangeWarnings(res, targetRoom, input.roomTypeById));
  if (newArrival) warnings.push(PRICE_NOT_REQUOTED_WARNING);

  return {
    pending: {
      type: "move",
      res,
      newRoomId: roomChanged ? targetRoomId : null,
      newRoomLabel: targetRoom ? `Hab. ${targetRoom.number}` : undefined,
      newArrival,
      newDeparture,
      warnings
    },
    rejected: null
  };
}

// ---------------------------------------------------------------------------
// Parches del API y deshacer
// ---------------------------------------------------------------------------

/**
 * PATCH que ejecuta el cambio, o null cuando no hay PATCH: un movimiento solo
 * de habitación va por POST assign-room, y las acciones de estado por sus
 * endpoints propios.
 */
export function patchFor(change: PendingChange): ReservationPatch | null {
  if (change.type === "move") {
    if (!change.newArrival || !change.newDeparture) return null;
    return {
      arrivalDate: change.newArrival,
      departureDate: change.newDeparture,
      ...(change.newRoomId ? { assignedRoomId: change.newRoomId } : {})
    };
  }
  if (change.type === "resize") {
    return { arrivalDate: change.newArrivalDate, departureDate: change.newDepartureDate };
  }
  return null;
}

/** Valores previos de la reserva (fechas y habitación) para revertir un cambio. */
export function undoPatchFor(change: PendingChange): ReservationPatch {
  return {
    arrivalDate: change.res.arrivalDate,
    departureDate: change.res.departureDate,
    assignedRoomId: change.res.assignedRoomId ?? null
  };
}

/**
 * Deshacer un traslado en casa es OTRO traslado (POST assign-room): el API
 * deja sucia la habitación intermedia y abre su tarea de limpieza, y eso no se
 * revierte. La barra de deshacer lo dice antes de pulsar.
 */
export const IN_HOUSE_UNDO_NOTE = "Volver a la habitación anterior es un nuevo traslado: la habitación intermedia queda sucia y con su tarea de limpieza";
export const IN_HOUSE_UNDO_DONE_MESSAGE = "Traslado revertido. Revisa la limpieza de la habitación intermedia.";

export type UndoEntry = {
  reservationId: string;
  code: string;
  /** Etiqueta del toast, sin fechas formateadas. */
  label: string;
  patch: ReservationPatch;
  /** En casa: solo se puede revertir la habitación (POST assign-room con el id previo). */
  roomOnly: boolean;
  /** Aviso honesto de lo que deshacer NO revierte (traslados en casa). */
  note?: string;
};

export function undoEntryFor(change: PendingChange): UndoEntry | null {
  if (change.type !== "move" && change.type !== "resize" && change.type !== "assign") return null;
  const { res } = change;
  const roomOnly = res.status === "checked_in";
  const patch: ReservationPatch = roomOnly ? { assignedRoomId: res.assignedRoomId ?? null } : undoPatchFor(change);
  let label: string;
  if (change.type === "resize") label = `Fechas de ${res.code} actualizadas`;
  else if (change.type === "move") {
    label = change.newArrival
      ? `Reserva ${res.code} movida de fechas`
      : `Reserva ${res.code} movida a ${change.newRoomLabel ?? "otra habitación"}`;
  } else label = `Habitación de ${res.code} asignada`;
  const entry: UndoEntry = { reservationId: res.id, code: res.code, label, patch, roomOnly };
  return roomOnly ? { ...entry, note: IN_HOUSE_UNDO_NOTE } : entry;
}

// ---------------------------------------------------------------------------
// Colisiones y disponibilidad por tipo y día
// ---------------------------------------------------------------------------

/**
 * Pares de reservas VIVAS (confirmada o en casa) asignadas a la misma
 * habitación cuyas noches se solapan: todos los pares, no solo los
 * consecutivos. Una salida cerrada, un no-show o una cancelada ya no ocupan.
 */
export function roomOverlapCount(reservations: ReadonlyArray<AdminReservation>): number {
  const byRoom = new Map<string, AdminReservation[]>();
  for (const r of reservations) {
    if (!r.assignedRoomId || !OCCUPYING_STATUSES.has(r.status)) continue;
    const list = byRoom.get(r.assignedRoomId);
    if (list) list.push(r);
    else byRoom.set(r.assignedRoomId, [r]);
  }
  let count = 0;
  for (const list of byRoom.values()) {
    const sorted = list
      .map((r) => ({ a: parseDateOnly(r.arrivalDate).getTime(), d: parseDateOnly(r.departureDate).getTime() }))
      .sort((x, y) => x.a - y.a || x.d - y.d);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].a < sorted[i].d; j++) count++;
    }
  }
  return count;
}

/** Por columna: true si la reserva ocupa esa noche (llegada ≤ día < salida). */
export function occupiedNights(
  res: Pick<AdminReservation, "arrivalDate" | "departureDate">,
  columns: ReadonlyArray<Pick<DayColumn, "key">>
): boolean[] {
  const arrival = res.arrivalDate.slice(0, 10);
  const departure = res.departureDate.slice(0, 10);
  return columns.map((col) => col.key >= arrival && col.key < departure);
}

/** Habitaciones vendibles (no bloqueadas) por tipo; los tipos con todas bloqueadas quedan a 0. */
export function sellableByType(rooms: ReadonlyArray<AdminRoom>): Map<string, number> {
  const out = new Map<string, number>();
  for (const room of rooms) out.set(room.roomTypeId, (out.get(room.roomTypeId) ?? 0) + (roomBlocked(room) ? 0 : 1));
  return out;
}

/** Unidades de inventario que consume una reserva (el API descuenta `roomsCount`, mínimo 1). */
export function roomUnits(res: Pick<AdminReservation, "roomsCount">): number {
  const n = res.roomsCount;
  return typeof n === "number" && Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/** Unidades de habitación confirmadas o en casa por tipo (asignadas o no) y columna. */
export function bookedByType(
  reservations: ReadonlyArray<AdminReservation>,
  columns: ReadonlyArray<Pick<DayColumn, "key">>
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const res of reservations) {
    if (!OCCUPYING_STATUSES.has(res.status)) continue;
    const nights = occupiedNights(res, columns);
    const units = roomUnits(res);
    let row = out.get(res.roomTypeId);
    if (!row) {
      row = new Array<number>(columns.length).fill(0);
      out.set(res.roomTypeId, row);
    }
    for (let i = 0; i < nights.length; i++) if (nights[i]) row[i] += units;
  }
  return out;
}

/** Libres por tipo y columna = vendibles − ocupadas (negativo en overbooking). */
export function availabilityByType(
  rooms: ReadonlyArray<AdminRoom>,
  reservations: ReadonlyArray<AdminReservation>,
  columns: ReadonlyArray<Pick<DayColumn, "key">>
): Map<string, number[]> {
  const sellable = sellableByType(rooms);
  const booked = bookedByType(reservations, columns);
  const out = new Map<string, number[]>();
  const typeIds = new Set<string>([...sellable.keys(), ...booked.keys()]);
  for (const typeId of typeIds) {
    const available = sellable.get(typeId) ?? 0;
    const taken = booked.get(typeId);
    out.set(
      typeId,
      columns.map((_, i) => available - (taken ? taken[i] : 0))
    );
  }
  return out;
}

export type OverbookingDay = {
  roomTypeId: string;
  roomTypeName: string;
  dayKey: string;
  booked: number;
  sellable: number;
};

/** Días con más confirmadas + en casa que habitaciones vendibles, por tipo; ordenado por día y tipo. */
export function overbookingDays(
  rooms: ReadonlyArray<AdminRoom>,
  roomTypes: ReadonlyArray<AdminRoomType>,
  reservations: ReadonlyArray<AdminReservation>,
  columns: ReadonlyArray<Pick<DayColumn, "key">>
): OverbookingDay[] {
  const sellable = sellableByType(rooms);
  const booked = bookedByType(reservations, columns);
  const typeOrder = new Map(roomTypes.map((t, i) => [t.id, i]));
  const typeName = new Map(roomTypes.map((t) => [t.id, t.name]));
  const out: OverbookingDay[] = [];
  for (const [typeId, taken] of booked) {
    const available = sellable.get(typeId) ?? 0;
    for (let i = 0; i < columns.length; i++) {
      if (taken[i] > available) {
        out.push({
          roomTypeId: typeId,
          roomTypeName: typeName.get(typeId) ?? UNTYPED_LABEL,
          dayKey: columns[i].key,
          booked: taken[i],
          sellable: available
        });
      }
    }
  }
  const rank = (id: string) => typeOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  return out.sort(
    (a, b) =>
      (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0) ||
      rank(a.roomTypeId) - rank(b.roomTypeId) ||
      a.roomTypeName.localeCompare(b.roomTypeName)
  );
}

export type OverbookingSummary = { count: number; dayKeys: string[]; byType: Map<string, string[]> };

/** count = días distintos; byType = días por roomTypeId (en el orden de `days`). */
export function overbookingSummary(days: ReadonlyArray<OverbookingDay>): OverbookingSummary {
  const dayKeys: string[] = [];
  const byType = new Map<string, string[]>();
  for (const day of days) {
    if (!dayKeys.includes(day.dayKey)) dayKeys.push(day.dayKey);
    const list = byType.get(day.roomTypeId);
    if (list) list.push(day.dayKey);
    else byType.set(day.roomTypeId, [day.dayKey]);
  }
  return { count: dayKeys.length, dayKeys, byType };
}

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

/** null = todo lo presente (en estado: menos cancelled). */
export type TimelineFilters = {
  status: string[] | null;
  channel: string[] | null;
  roomType: string[] | null;
  query: string;
};

export const DEFAULT_FILTERS: TimelineFilters = { status: null, channel: null, roomType: null, query: "" };

/** Listas ya resueltas (sin null) que consume matchesFilters. */
export type EffectiveFilters = { status: string[]; channel: string[]; roomType: string[]; query: string };

export function effectiveStatuses(present: ReadonlyArray<string>, selected: ReadonlyArray<string> | null): string[] {
  return selected ? [...selected] : present.filter((s) => s !== "cancelled");
}

/** Resuelve los null de TimelineFilters con lo presente en los datos. */
export function effectiveFilters(
  filters: TimelineFilters,
  present: { statuses: ReadonlyArray<string>; channels: ReadonlyArray<string>; roomTypes: ReadonlyArray<string> }
): EffectiveFilters {
  return {
    status: effectiveStatuses(present.statuses, filters.status),
    channel: filters.channel ? [...filters.channel] : [...present.channels],
    roomType: filters.roomType ? [...filters.roomType] : [...present.roomTypes],
    query: filters.query
  };
}

/** Minúsculas sin acentos (NFD), recortado. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export type FilterContext = {
  roomById: ReadonlyMap<string, Pick<AdminRoom, "number">>;
  /** Nombres resueltos por primaryGuestId. */
  guestNames: Readonly<Record<string, string>>;
};

/**
 * Estado, canal y tipo por inclusión en las listas efectivas (una lista vacía
 * no deja pasar nada); la búsqueda casa por código, huésped visible, número de
 * habitación, reservante y empresa, sin acentos ni mayúsculas.
 */
export function matchesFilters(res: AdminReservation, filters: EffectiveFilters, ctx: FilterContext): boolean {
  if (!filters.status.includes(res.status)) return false;
  if (!filters.channel.includes(res.channel)) return false;
  if (!filters.roomType.includes(res.roomTypeId)) return false;
  const query = normalizeText(filters.query);
  if (!query) return true;
  const roomNumber = res.assignedRoomId ? ctx.roomById.get(res.assignedRoomId)?.number : undefined;
  const resolved = res.primaryGuestId ? ctx.guestNames[res.primaryGuestId] : undefined;
  const haystack = [res.code, guestLabel(res, resolved), roomNumber, res.bookerName, res.companyName]
    .filter((part): part is string => !!part)
    .map(normalizeText);
  return haystack.some((part) => part.includes(query));
}

export function filtersTouched(filters: TimelineFilters): boolean {
  return filters.status !== null || filters.channel !== null || filters.roomType !== null || filters.query.trim() !== "";
}

// ---------------------------------------------------------------------------
// Teclado: selección con flechas
// ---------------------------------------------------------------------------

export type ArrowDirection = "left" | "right" | "up" | "down";

type BarRow = { rowIndex: number; bars: BarModel[] };

function barRows(rows: ReadonlyArray<ResourceRow>): BarRow[] {
  const out: BarRow[] = [];
  rows.forEach((row, rowIndex) => {
    if (row.kind === "group" || row.bars.length === 0) return;
    const bars = [...row.bars].sort((a, b) => a.laneStart - b.laneStart || a.laneEnd - b.laneEnd || a.id.localeCompare(b.id));
    out.push({ rowIndex, bars });
  });
  return out;
}

function intervalDistance(a: Pick<BarModel, "laneStart" | "laneEnd">, b: Pick<BarModel, "laneStart" | "laneEnd">): number {
  // Negativo si solapan (cuanto mas solape, mas cerca), 0 si se tocan, el hueco si no.
  return Math.max(a.laneStart, b.laneStart) - Math.min(a.laneEnd, b.laneEnd);
}

/**
 * Id de la barra a la que salta la selección, o null si no hay salto
 * (extremo de la fila, sin filas con barras en esa dirección, sin barras).
 * Con currentId null (o desconocido) devuelve la primera barra.
 */
export function neighborBar(rows: ReadonlyArray<ResourceRow>, currentId: string | null, dir: ArrowDirection): string | null {
  const list = barRows(rows);
  if (list.length === 0) return null;
  let rowAt = -1;
  let barAt = -1;
  if (currentId) {
    for (let i = 0; i < list.length && rowAt < 0; i++) {
      const j = list[i].bars.findIndex((bar) => bar.id === currentId);
      if (j >= 0) {
        rowAt = i;
        barAt = j;
      }
    }
  }
  if (rowAt < 0) return list[0].bars[0].id;
  const row = list[rowAt];
  if (dir === "left") return barAt > 0 ? row.bars[barAt - 1].id : null;
  if (dir === "right") return barAt < row.bars.length - 1 ? row.bars[barAt + 1].id : null;
  const target = dir === "up" ? list[rowAt - 1] : list[rowAt + 1];
  if (!target) return null;
  const current = row.bars[barAt];
  let best = target.bars[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const bar of target.bars) {
    const distance = intervalDistance(current, bar);
    if (distance < bestDistance) {
      best = bar;
      bestDistance = distance;
    }
  }
  return best.id;
}

// ---------------------------------------------------------------------------
// Crear reserva seleccionando celdas
// ---------------------------------------------------------------------------

export type CellSelection = { roomId: string; startIndex: number; endIndex: number };

/** Llegada = celda menor; noches = celdas seleccionadas (los índices pueden venir invertidos). */
export function selectionDates(
  sel: Pick<CellSelection, "startIndex" | "endIndex">,
  range: Pick<TimelineRange, "start">
): { arrivalDate: string; departureDate: string; nights: number } {
  const first = Math.min(sel.startIndex, sel.endIndex);
  const last = Math.max(sel.startIndex, sel.endIndex);
  const nights = last - first + 1;
  const arrival = addDays(range.start, first);
  return { arrivalDate: toDateOnly(arrival), departureDate: toDateOnly(addDays(arrival, nights)), nights };
}

/** Query string (sin «?») para Nueva reserva: arrivalDate, departureDate, roomTypeId, assignedRoomId. */
export function newReservationSearch(input: {
  arrivalDate: string;
  departureDate: string;
  roomTypeId?: string;
  assignedRoomId?: string;
}): string {
  const params = new URLSearchParams();
  params.set("arrivalDate", input.arrivalDate);
  params.set("departureDate", input.departureDate);
  if (input.roomTypeId) params.set("roomTypeId", input.roomTypeId);
  if (input.assignedRoomId) params.set("assignedRoomId", input.assignedRoomId);
  return params.toString();
}

// ---------------------------------------------------------------------------
// Errores del API
// ---------------------------------------------------------------------------

type ErrorShape = { status?: unknown; details?: { code?: unknown } | null } | null | undefined;

function statusOf(err: unknown): number | null {
  const status = (err as ErrorShape)?.status;
  return typeof status === "number" ? status : null;
}

export function isForbidden(err: unknown): boolean {
  return statusOf(err) === 403;
}

export function isNotFound(err: unknown): boolean {
  return statusOf(err) === 404;
}

/** Código tipado de un 409 (ROOM_CONFLICT, BALANCE_DUE, CHECK_IN_DATE_OUT_OF_RANGE, RESERVATION_CHANGED_MEANWHILE) o null. */
export function conflictCode(err: unknown): string | null {
  if (statusOf(err) !== 409) return null;
  const code = (err as ErrorShape)?.details?.code;
  return typeof code === "string" && code ? code : null;
}

export const CONFLICT_MESSAGES: Record<string, string> = {
  ROOM_CONFLICT: "La habitación entra en conflicto con otra reserva en esas fechas",
  BALANCE_DUE: "El folio tiene saldo pendiente: cóbralo o confirma la salida con saldo",
  CHECK_IN_DATE_OUT_OF_RANGE: "La llegada está fuera de la ventana de check-in (±1 día sobre la fecha de negocio o la de hoy, la más reciente)",
  RESERVATION_CHANGED_MEANWHILE: "La reserva cambió mientras se procesaba: actualiza y repite"
};

export const UNKNOWN_CONFLICT_MESSAGE = "No se pudo completar la acción.";

export function conflictMessage(code: string | null | undefined): string {
  return (code && CONFLICT_MESSAGES[code]) || UNKNOWN_CONFLICT_MESSAGE;
}

// ---------------------------------------------------------------------------
// Actividad del huésped (los departamentos llegan en inglés del API)
// ---------------------------------------------------------------------------

export type ActivityKind = "message" | "housekeeping" | "maintenance" | "service_request";

const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  message: "Mensaje",
  housekeeping: "Limpieza",
  maintenance: "Mantenimiento",
  service_request: "Petición"
};

const DEPARTMENT_LABEL: Record<string, string> = {
  Chat: "Chat",
  Housekeeping: "Limpieza",
  Maintenance: "Mantenimiento",
  Reception: "Recepción"
};

/** «Mensaje · Chat», «Petición · Recepción»; sin repetir cuando tipo y departamento coinciden («Limpieza»). */
export function activityLabel(kind: ActivityKind, department: string): string {
  const head = ACTIVITY_KIND_LABEL[kind] ?? kind;
  const dept = DEPARTMENT_LABEL[department] ?? department;
  if (!dept || dept === head) return head;
  return `${head} · ${dept}`;
}
