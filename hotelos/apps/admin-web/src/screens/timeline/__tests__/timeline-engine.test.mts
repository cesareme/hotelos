import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARRIVAL_BEFORE_DEPARTURE,
  BAR_HEIGHT,
  BAR_KIND_LABEL,
  BAR_KIND_TONE,
  CELL_WIDTH,
  CELL_WIDTH_NARROW,
  CLOSED_DRAG_REASON,
  CONTEXT_DAYS_BEFORE,
  DEFAULT_FILTERS,
  DEPARTURE_AFTER_ARRIVAL,
  GRANULARITY_DAYS,
  GROUP_ROW_HEIGHT,
  HIDDEN_GUEST_LABEL,
  IN_HOUSE_DRAG_REASON,
  IN_HOUSE_UNDO_NOTE,
  LANE_GAP,
  LEAD_WIDTH,
  LEAD_WIDTH_NARROW,
  MIN_BAR_WIDTH,
  MS_DAY,
  NO_GUEST_LABEL,
  PENDING_GUEST_LABEL,
  PRICE_NOT_REQUOTED_WARNING,
  RES_STATUS_LABEL,
  ROOM_BLOCKED_REASON,
  ROOM_BLOCKED_WARNING,
  ROOM_OCCUPIED_REASON,
  ROOM_STATUS_LABEL,
  ROOM_STATUS_TONE,
  ROW_MIN_HEIGHT,
  UNASSIGNED_ID,
  UNKNOWN_CONFLICT_MESSAGE,
  UNTYPED_ID,
  activityLabel,
  addDays,
  anchorForToday,
  assignLanes,
  availabilityByType,
  barGeometry,
  barKind,
  blockFor,
  bookedByType,
  buildRows,
  columnsFor,
  conflictCode,
  conflictMessage,
  diffDays,
  dragAllowed,
  dragPhase,
  effectiveFilters,
  effectiveStatuses,
  filtersTouched,
  guestLabel,
  isForbidden,
  isNotFound,
  matchesFilters,
  neighborBar,
  newReservationSearch,
  normalizeText,
  occupiedNights,
  overbookingDays,
  overbookingSummary,
  parseDateOnly,
  patchFor,
  pinRow,
  rangeFor,
  referenceToday,
  resolveDrop,
  roomAssignmentConflict,
  roomBlocked,
  roomCapacity,
  roomOverlapCount,
  roomOverlapReason,
  roomStatusKey,
  roomUnits,
  rowHeight,
  rowOffsets,
  rowWindow,
  selectionDates,
  sellableByType,
  snapDays,
  toDateOnly,
  todayLocalIso,
  undoEntryFor,
  undoPatchFor,
  type PendingChange,
  type ResourceRow
} from "../timeline-engine.ts";
import type { AdminReservation, AdminRoom, AdminRoomType } from "../../../services/pmsCommerceApi.ts";

// ---------------------------------------------------------------------------
// Datos inventados: septiembre de 2026, habitaciones «2», «10», «202», tipos A/B.
// ---------------------------------------------------------------------------

const TODAY = "2026-09-12";
const D = (day: string) => parseDateOnly(`2026-09-${day}`);

const TYPES: AdminRoomType[] = [
  { id: "A", propertyId: "p1", name: "Doble", code: "DBL", maxOccupancy: 2 },
  { id: "B", propertyId: "p1", name: "Suite", code: "STE", maxOccupancy: 4 }
];

function room(over: Partial<AdminRoom> & { id: string; number: string }): AdminRoom {
  return { roomTypeId: "A", status: "clean", sellable: true, ...over };
}
const R2 = room({ id: "r2", number: "2" });
const R10 = room({ id: "r10", number: "10", status: "occupied", housekeepingStatus: "clean" });
const R202 = room({ id: "r202", number: "202", roomTypeId: "B", housekeepingStatus: "dirty" });
const R301 = room({ id: "r301", number: "301", roomTypeId: "B", status: "out_of_order" });
const RZ = room({ id: "rz", number: "900", roomTypeId: "Z" });
/** Desordenadas a propósito: buildRows ordena por número. */
const ROOMS: AdminRoom[] = [R202, R10, RZ, R2, R301];
const roomById = new Map(ROOMS.map((r) => [r.id, r]));
const roomTypeById = new Map(TYPES.map((t) => [t.id, t]));

function res(over: Partial<AdminReservation> & { id: string; arrivalDate: string; departureDate: string }): AdminReservation {
  return {
    propertyId: "p1",
    code: `R-${over.id}`,
    channel: "direct",
    status: "confirmed",
    adults: 2,
    children: 0,
    roomTypeId: "A",
    totalAmount: 100,
    currency: "EUR",
    ...over
  };
}

const RANGE = rangeFor(D("10"), "day"); // 2026-09-10 … 2026-09-16 (fin exclusivo 09-17), 150 px
const COLUMNS = columnsFor(RANGE, TODAY);

const A1 = res({ id: "a", arrivalDate: "2026-09-10", departureDate: "2026-09-12", assignedRoomId: "r2" });
const B1 = res({ id: "b", arrivalDate: "2026-09-12", departureDate: "2026-09-14", assignedRoomId: "r2" });
const C1 = res({ id: "c", arrivalDate: "2026-09-11", departureDate: "2026-09-13", assignedRoomId: "r10", status: "checked_in" });
const D1 = res({ id: "d", arrivalDate: "2026-09-13", departureDate: "2026-09-15", assignedRoomId: "r202", roomTypeId: "B" });
const U1 = res({ id: "u", arrivalDate: "2026-09-12", departureDate: "2026-09-13" });
const X1 = res({ id: "x", arrivalDate: "2026-09-12", departureDate: "2026-09-13", status: "cancelled" });

function rowsFor(reservations: AdminReservation[], collapsed: string[] = [], availability = new Map<string, number[]>()): ResourceRow[] {
  return buildRows({ rooms: ROOMS, roomTypes: TYPES, reservations, range: RANGE, todayKey: TODAY, collapsed: new Set(collapsed), availability });
}
type RoomRow = Extract<ResourceRow, { kind: "room" }>;
type GroupRow = Extract<ResourceRow, { kind: "group" }>;
const roomRow = (rows: ResourceRow[], id: string) => rows.find((r) => r.kind === "room" && r.id === id) as RoomRow;
const groupRow = (rows: ResourceRow[], id: string) => rows.find((r) => r.kind === "group" && r.id === id) as GroupRow;

// ---------------------------------------------------------------------------

describe("timeline-engine · fechas", () => {
  it("parseDateOnly/toDateOnly ignoran la hora y no derivan por zona horaria", () => {
    assert.equal(toDateOnly(parseDateOnly("2026-09-10T15:00:00.000Z")), "2026-09-10");
    assert.equal(parseDateOnly("2026-09-10").getTime(), Date.UTC(2026, 8, 10));
    assert.equal(MS_DAY, 86_400_000);
  });

  it("addDays/diffDays cruzan el cambio de mes", () => {
    assert.equal(toDateOnly(addDays(D("30"), 1)), "2026-10-01");
    assert.equal(diffDays(D("10"), D("15")), 5);
    assert.equal(diffDays(D("15"), D("10")), -5);
  });

  it("todayLocalIso es el día civil local en formato YYYY-MM-DD", () => {
    const now = new Date();
    const expected = toDateOnly(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
    assert.equal(todayLocalIso(), expected);
    assert.match(todayLocalIso(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("referenceToday = max(fecha de negocio, día local), como el check-in del API; sin fecha de negocio válida, el día local", () => {
    assert.equal(referenceToday("2026-09-13", "2026-09-19"), "2026-09-19", "cierre nocturno atrasado: manda el día local");
    assert.equal(referenceToday("2026-09-20", "2026-09-19"), "2026-09-20", "fecha de negocio por delante: manda ella");
    assert.equal(referenceToday("2026-09-19", "2026-09-19"), "2026-09-19");
    assert.equal(referenceToday("2026-09-19T00:00:00.000Z", "2026-09-18"), "2026-09-19", "acepta un ISO largo");
    assert.equal(referenceToday(null, "2026-09-19"), "2026-09-19");
    assert.equal(referenceToday(undefined, "2026-09-19"), "2026-09-19");
    assert.equal(referenceToday("ayer", "2026-09-19"), "2026-09-19");
  });

  it("anchorForToday deja un día de contexto a la izquierda", () => {
    assert.equal(CONTEXT_DAYS_BEFORE, 1);
    assert.equal(toDateOnly(anchorForToday("2026-09-18")), "2026-09-17");
    assert.equal(toDateOnly(anchorForToday("2026-10-01")), "2026-09-30");
  });
});

describe("timeline-engine · escala y columnas", () => {
  it("rangeFor: día = 7 columnas de 150 px, fin exclusivo", () => {
    assert.equal(RANGE.dayCount, 7);
    assert.equal(RANGE.cellWidth, 150);
    assert.equal(RANGE.granularity, "day");
    assert.equal(toDateOnly(RANGE.start), "2026-09-10");
    assert.equal(toDateOnly(RANGE.end), "2026-09-17");
  });

  it("rangeFor: semana 14 × 118 y mes 30 × 64", () => {
    assert.deepEqual(GRANULARITY_DAYS, { day: 7, week: 14, month: 30 });
    assert.deepEqual(CELL_WIDTH, { day: 150, week: 118, month: 64 });
    const week = rangeFor(D("10"), "week");
    assert.equal(week.dayCount, 14);
    assert.equal(week.cellWidth, 118);
    const month = rangeFor(D("10"), "month");
    assert.equal(month.dayCount, 30);
    assert.equal(month.cellWidth, 64);
    assert.equal(toDateOnly(month.end), "2026-10-10");
  });

  it("columnsFor marca hoy por clave y el fin de semana por getUTCDay", () => {
    assert.equal(COLUMNS.length, 7);
    assert.deepEqual(
      COLUMNS.map((c) => c.key),
      ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"]
    );
    assert.deepEqual(COLUMNS.map((c) => c.index), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(COLUMNS.map((c) => c.isToday), [false, false, true, false, false, false, false]);
    // 2026-09-12 es sábado y 2026-09-13 domingo.
    assert.deepEqual(COLUMNS.map((c) => c.isWeekend), [false, false, true, true, false, false, false]);
    assert.equal(COLUMNS[2].date.getTime(), D("12").getTime());
  });

  it("rangeFor en pantalla estrecha: celdas 120/88/48 y columna de recursos 104 (mismos días)", () => {
    assert.deepEqual(CELL_WIDTH_NARROW, { day: 120, week: 88, month: 48 });
    assert.equal(LEAD_WIDTH, 200);
    assert.equal(LEAD_WIDTH_NARROW, 104);
    for (const g of ["day", "week", "month"] as const) {
      const wide = rangeFor(D("10"), g);
      const narrow = rangeFor(D("10"), g, { narrow: true });
      assert.equal(narrow.cellWidth, CELL_WIDTH_NARROW[g]);
      assert.equal(narrow.dayCount, wide.dayCount);
      assert.equal(toDateOnly(narrow.start), toDateOnly(wide.start));
      assert.ok(narrow.cellWidth < wide.cellWidth);
      assert.ok(narrow.cellWidth >= MIN_BAR_WIDTH + 4, "una noche cabe con el margen de 4 px");
    }
    assert.equal(rangeFor(D("10"), "week", { narrow: false }).cellWidth, CELL_WIDTH.week);
  });

  it("columnsFor: 30 columnas en mes", () => {
    const cols = columnsFor(rangeFor(D("10"), "month"), "2030-01-01");
    assert.equal(cols.length, 30);
    assert.equal(cols[29].key, "2026-10-09");
    assert.ok(cols.every((c) => !c.isToday));
  });
});

describe("timeline-engine · estado visual de la reserva", () => {
  it("barKind: en casa, sale hoy, llega hoy y resto por estado", () => {
    const k = (status: string, arrivalDate: string, departureDate: string) => barKind({ status, arrivalDate, departureDate }, TODAY);
    assert.equal(k("checked_in", "2026-09-10", "2026-09-12"), "departure_today");
    assert.equal(k("checked_in", "2026-09-12", "2026-09-14"), "in_house");
    assert.equal(k("confirmed", "2026-09-12", "2026-09-14"), "arrival_today");
    assert.equal(k("draft", "2026-09-12", "2026-09-14"), "arrival_today");
    assert.equal(k("confirmed", "2026-09-13", "2026-09-14"), "confirmed");
    assert.equal(k("draft", "2026-09-13", "2026-09-14"), "draft");
    assert.equal(k("checked_out", "2026-09-10", "2026-09-12"), "checked_out");
    assert.equal(k("no_show", "2026-09-12", "2026-09-14"), "no_show");
    assert.equal(k("cancelled", "2026-09-12", "2026-09-14"), "cancelled");
    assert.equal(k("weird", "2026-09-13", "2026-09-14"), "confirmed");
  });

  it("tonos Cocoa y etiquetas en español por tipo de bloque (no-show en ámbar: no comparte el neutro de borrador y salida)", () => {
    assert.deepEqual(BAR_KIND_TONE, {
      arrival_today: "accent",
      in_house: "success",
      departure_today: "warning",
      confirmed: "info",
      draft: "neutral",
      checked_out: "neutral",
      no_show: "warning",
      cancelled: "danger"
    });
    assert.deepEqual(BAR_KIND_LABEL, {
      arrival_today: "Llega hoy",
      in_house: "En casa",
      departure_today: "Sale hoy",
      confirmed: "Confirmada",
      draft: "Borrador",
      checked_out: "Salida",
      no_show: "No-show",
      cancelled: "Cancelada"
    });
  });

  it("RES_STATUS_LABEL cubre los seis estados del API", () => {
    assert.deepEqual(RES_STATUS_LABEL, {
      draft: "Borrador",
      confirmed: "Confirmada",
      checked_in: "En casa",
      checked_out: "Salida",
      cancelled: "Cancelada",
      no_show: "No-show"
    });
  });
});

describe("timeline-engine · habitación", () => {
  it("roomBlocked: mantenimiento, no vendible o fuera de servicio", () => {
    assert.equal(roomBlocked(R2), false);
    assert.equal(roomBlocked(R301), true);
    assert.equal(roomBlocked(room({ id: "x", number: "1", status: "out_of_service" })), true);
    assert.equal(roomBlocked(room({ id: "x", number: "1", sellable: false })), true);
    assert.equal(roomBlocked(room({ id: "x", number: "1", maintenanceStatus: "blocked" })), true);
    assert.equal(roomBlocked(room({ id: "x", number: "1", status: "occupied" })), false);
  });

  it("roomStatusKey: bloqueada > ocupada > housekeeping > status", () => {
    assert.equal(roomStatusKey(R10), "occupied");
    assert.equal(roomStatusKey(room({ id: "x", number: "1", status: "clean", housekeepingStatus: "dirty" })), "dirty");
    assert.equal(roomStatusKey(R301), "blocked");
    assert.equal(roomStatusKey(room({ id: "x", number: "1", sellable: false })), "blocked");
    assert.equal(roomStatusKey(room({ id: "x", number: "1", status: "occupied", sellable: false })), "blocked");
    assert.equal(roomStatusKey(room({ id: "x", number: "1", status: "inspected" })), "inspected");
    assert.equal(roomStatusKey(room({ id: "x", number: "1", status: "clean", housekeepingStatus: "inspected" })), "inspected");
    assert.equal(roomStatusKey(room({ id: "x", number: "1", status: "vacant" })), "clean");
  });

  it("etiquetas, tonos y capacidad por tipo", () => {
    assert.deepEqual(ROOM_STATUS_LABEL, { clean: "Limpia", dirty: "Sucia", inspected: "Inspeccionada", occupied: "Ocupada", blocked: "Bloqueada" });
    assert.deepEqual(ROOM_STATUS_TONE, { clean: "success", dirty: "warning", inspected: "success", occupied: "info", blocked: "danger" });
    assert.equal(roomCapacity(R2, roomTypeById), 2);
    assert.equal(roomCapacity(R202, roomTypeById), 4);
    assert.equal(roomCapacity(RZ, roomTypeById), undefined);
  });
});

describe("timeline-engine · guestLabel", () => {
  const base = res({ id: "g", arrivalDate: "2026-09-10", departureDate: "2026-09-11" });

  it("reservante > nombre resuelto > «Huésped pendiente» si solo hay id", () => {
    assert.equal(guestLabel({ ...base, bookerName: " María García " }, "Otro"), "María García");
    assert.equal(guestLabel({ ...base, primaryGuestId: "cmr123" }, "Ana Pérez"), "Ana Pérez");
    assert.equal(guestLabel({ ...base, primaryGuestId: "cmr123" }), PENDING_GUEST_LABEL);
    assert.equal(guestLabel({ ...base, primaryGuestId: "cmr123" }, null), "Huésped pendiente");
    // 403 de GET /guests/:id: la pantalla guarda esta etiqueta como nombre resuelto.
    assert.equal(guestLabel({ ...base, primaryGuestId: "cmr123" }, HIDDEN_GUEST_LABEL), "Huésped no visible");
  });

  it("sin huésped: empresa, grupo o «Sin huésped»; nunca el id ni el código", () => {
    assert.equal(guestLabel({ ...base, companyName: "Acme SL" }), "Acme SL");
    assert.equal(guestLabel({ ...base, groupCode: "GRP-1" }), "GRP-1");
    assert.equal(guestLabel(base), NO_GUEST_LABEL);
    assert.equal(NO_GUEST_LABEL, "Sin huésped");
    const label = guestLabel({ ...base, primaryGuestId: "cmr123", code: "R-g" });
    assert.ok(!label.includes("cmr123") && !label.includes("R-g"));
  });
});

describe("timeline-engine · blockFor (media celda)", () => {
  it("fuera del rango: salida antes del inicio o llegada el día range.end", () => {
    assert.equal(blockFor(res({ id: "1", arrivalDate: "2026-09-05", departureDate: "2026-09-09" }), RANGE), null);
    assert.equal(blockFor(res({ id: "2", arrivalDate: "2026-09-17", departureDate: "2026-09-19" }), RANGE), null);
  });

  it("la salida a mediodía del primer día del rango sí se pinta (laneEnd 0,5)", () => {
    const block = blockFor(res({ id: "3", arrivalDate: "2026-09-08", departureDate: "2026-09-10" }), RANGE);
    assert.ok(block);
    assert.equal(block.offset, -2);
    assert.equal(block.nights, 2);
    assert.equal(block.continuesLeft, true);
    assert.equal(block.laneStart, 0);
    assert.equal(block.laneEnd, 0.5);
  });

  it("recorte por la izquierda", () => {
    const block = blockFor(res({ id: "4", arrivalDate: "2026-09-08", departureDate: "2026-09-12" }), RANGE);
    assert.ok(block);
    assert.deepEqual(
      { offset: block.offset, nights: block.nights, laneStart: block.laneStart, laneEnd: block.laneEnd, l: block.continuesLeft, r: block.continuesRight },
      { offset: -2, nights: 4, laneStart: 0, laneEnd: 2.5, l: true, r: false }
    );
  });

  it("recorte por la derecha", () => {
    const block = blockFor(res({ id: "5", arrivalDate: "2026-09-16", departureDate: "2026-09-18" }), RANGE);
    assert.ok(block);
    assert.deepEqual(
      { offset: block.offset, nights: block.nights, laneStart: block.laneStart, laneEnd: block.laneEnd, l: block.continuesLeft, r: block.continuesRight },
      { offset: 6, nights: 2, laneStart: 6.5, laneEnd: 7, l: false, r: true }
    );
  });

  it("dentro del rango: llegada a mediodía y salida a mediodía del día de salida", () => {
    const block = blockFor(res({ id: "6", arrivalDate: "2026-09-12", departureDate: "2026-09-14" }), RANGE);
    assert.ok(block);
    assert.equal(block.id, "6");
    assert.deepEqual([block.offset, block.nights, block.laneStart, block.laneEnd], [2, 2, 2.5, 4.5]);
    assert.equal(block.continuesLeft, false);
    assert.equal(block.continuesRight, false);
  });

  it("nights mínimo 1 (llegada y salida el mismo día)", () => {
    const block = blockFor(res({ id: "7", arrivalDate: "2026-09-12", departureDate: "2026-09-12" }), RANGE);
    assert.ok(block);
    assert.equal(block.nights, 1);
    assert.deepEqual([block.laneStart, block.laneEnd], [2.5, 3.5]);
  });
});

describe("timeline-engine · barGeometry", () => {
  const range = { ...rangeFor(D("11"), "day"), cellWidth: 100 };

  it("llegada 09-12 y salida 09-14 desde 09-11 con celda de 100 → left 152, width 196", () => {
    const block = blockFor(res({ id: "g1", arrivalDate: "2026-09-12", departureDate: "2026-09-14" }), range);
    assert.ok(block);
    assert.equal(block.laneStart, 1.5);
    assert.equal(block.laneEnd, 3.5);
    const geo = barGeometry({ ...block, lane: 0 }, range);
    assert.deepEqual(geo, { left: 152, width: 196, top: LANE_GAP, height: BAR_HEIGHT });
    assert.equal(barGeometry({ ...block, lane: 2 }, range).top, 2 * (BAR_HEIGHT + LANE_GAP) + LANE_GAP);
  });

  it("continuesLeft → left 2; continuesRight → borde derecho = dayCount × celda", () => {
    const left = blockFor(res({ id: "g2", arrivalDate: "2026-09-09", departureDate: "2026-09-13" }), range);
    assert.ok(left);
    assert.equal(barGeometry({ ...left, lane: 0 }, range).left, 2);
    const right = blockFor(res({ id: "g3", arrivalDate: "2026-09-16", departureDate: "2026-09-20" }), range);
    assert.ok(right);
    const geo = barGeometry({ ...right, lane: 0 }, range);
    assert.equal(geo.left + geo.width, range.dayCount * range.cellWidth - 2);
  });

  it("MIN_BAR_WIDTH acota los bloques minúsculos", () => {
    assert.equal(MIN_BAR_WIDTH, 24);
    assert.equal(barGeometry({ laneStart: 0, laneEnd: 0.1, lane: 0 }, range).width, MIN_BAR_WIDTH);
  });
});

describe("timeline-engine · carriles", () => {
  it("tres estancias solapadas → tres carriles", () => {
    const { laid, laneCount } = assignLanes([
      { id: "p", laneStart: 0.5, laneEnd: 3.5 },
      { id: "q", laneStart: 1.5, laneEnd: 4.5 },
      { id: "r", laneStart: 2.5, laneEnd: 5.5 }
    ]);
    assert.equal(laneCount, 3);
    assert.deepEqual(laid.map((b) => [b.id, b.lane]), [["p", 0], ["q", 1], ["r", 2]]);
  });

  it("salida y llegada el mismo día comparten carril; el orden de entrada se conserva", () => {
    const { laid, laneCount } = assignLanes([
      { id: "second", laneStart: 2.5, laneEnd: 4.5 },
      { id: "first", laneStart: 0.5, laneEnd: 2.5 }
    ]);
    assert.equal(laneCount, 1);
    assert.deepEqual(laid.map((b) => [b.id, b.lane]), [["second", 0], ["first", 0]]);
  });

  it("rowHeight respeta el mínimo y crece por carril", () => {
    assert.equal(assignLanes([]).laneCount, 1);
    assert.equal(rowHeight(1), ROW_MIN_HEIGHT);
    assert.equal(rowHeight(3), 3 * (BAR_HEIGHT + LANE_GAP) + LANE_GAP);
  });
});

describe("timeline-engine · buildRows", () => {
  it("orden: Sin asignar → grupos en el orden del array → habitaciones 2 < 10 < 202 → Sin tipo al final", () => {
    const rows = rowsFor([A1, B1, C1, D1, U1, X1]);
    assert.deepEqual(
      rows.map((r) => r.id),
      [UNASSIGNED_ID, "A", "r2", "r10", "B", "r202", "r301", UNTYPED_ID, "rz"]
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["unassigned", "group", "room", "room", "group", "room", "room", "group", "room"]
    );
    assert.equal(rows[0].kind === "unassigned" && rows[0].label, "Sin asignar");
    assert.equal(groupRow(rows, UNTYPED_ID).label, "Sin tipo");
  });

  it("un grupo colapsado no emite sus habitaciones", () => {
    const rows = rowsFor([A1, D1], ["A"]);
    assert.deepEqual(rows.map((r) => r.id), ["A", "B", "r202", "r301", UNTYPED_ID, "rz"]);
    assert.equal(groupRow(rows, "A").collapsed, true);
    assert.equal(groupRow(rows, "B").collapsed, false);
  });

  it("una cancelada sin habitación no va a Sin asignar", () => {
    assert.equal(rowsFor([X1]).some((r) => r.kind === "unassigned"), false);
    const rows = rowsFor([U1, X1]);
    const unassigned = rows[0];
    assert.equal(unassigned.kind, "unassigned");
    assert.deepEqual(unassigned.kind === "unassigned" ? unassigned.bars.map((b) => b.id) : [], ["u"]);
  });

  it("campos del grupo: recuento, vendibles, libres desde availability (o ceros) y altura fija", () => {
    const rows = rowsFor([], [], new Map([["A", [1, 1, 1, 1, 1, 1, 1]]]));
    const a = groupRow(rows, "A");
    assert.deepEqual({ roomCount: a.roomCount, sellable: a.sellable, height: a.height, roomTypeId: a.roomTypeId }, { roomCount: 2, sellable: 2, height: GROUP_ROW_HEIGHT, roomTypeId: "A" });
    assert.deepEqual(a.free, [1, 1, 1, 1, 1, 1, 1]);
    const b = groupRow(rows, "B");
    assert.deepEqual({ roomCount: b.roomCount, sellable: b.sellable }, { roomCount: 2, sellable: 1 });
    assert.deepEqual(b.free, [0, 0, 0, 0, 0, 0, 0]);
  });

  it("campos de la habitación: etiqueta, tipo, pax, estado, bloqueo", () => {
    const rows = rowsFor([]);
    const r202 = roomRow(rows, "r202");
    assert.deepEqual(
      { label: r202.label, typeLabel: r202.typeLabel, capacity: r202.capacity, statusKey: r202.statusKey, blocked: r202.blocked, height: r202.height },
      { label: "Hab. 202", typeLabel: "Suite", capacity: 4, statusKey: "dirty", blocked: false, height: ROW_MIN_HEIGHT }
    );
    const r301 = roomRow(rows, "r301");
    assert.equal(r301.statusKey, "blocked");
    assert.equal(r301.blocked, true);
    const rz = roomRow(rows, "rz");
    assert.equal(rz.typeLabel, "Sin tipo");
    assert.equal(rz.capacity, undefined);
    assert.equal(roomRow(rows, "r10").statusKey, "occupied");
  });

  it("los bloques caen en su habitación con tipo, tono y carril", () => {
    const rows = rowsFor([A1, B1, C1, D1]);
    const r2 = roomRow(rows, "r2");
    assert.deepEqual(r2.bars.map((b) => [b.id, b.kind, b.tone, b.lane]), [["a", "confirmed", "info", 0], ["b", "arrival_today", "accent", 0]]);
    assert.equal(r2.laneCount, 1);
    const r10 = roomRow(rows, "r10");
    assert.deepEqual(r10.bars.map((b) => [b.id, b.kind, b.tone]), [["c", "in_house", "success"]]);
    assert.equal(roomRow(rows, "r202").bars[0].id, "d");
    assert.equal(roomRow(rows, "r301").bars.length, 0);
  });
});

describe("timeline-engine · virtualización", () => {
  const rows = Array.from({ length: 30 }, () => ({ height: 56 }));
  const offsets = rowOffsets(rows);

  it("rowOffsets: sumas prefijas con longitud rows + 1", () => {
    assert.equal(offsets.length, 31);
    assert.equal(offsets[0], 0);
    assert.equal(offsets[30], 1680);
    assert.deepEqual(rowOffsets([{ height: 36 }, { height: 56 }, { height: 144 }]), [0, 36, 92, 236]);
  });

  it("scrollTop 0 → start 0 con overscan por debajo", () => {
    assert.deepEqual(rowWindow(offsets, 0, 400), { start: 0, end: 11, topSpacer: 0, bottomSpacer: 1064 });
  });

  it("scroll al final → end = rows.length y bottomSpacer 0", () => {
    assert.deepEqual(rowWindow(offsets, 1280, 400), { start: 19, end: 30, topSpacer: 1064, bottomSpacer: 0 });
  });

  it("pinRow fija la fila origen del arrastre dentro de la ventana (o devuelve la misma)", () => {
    const list = Array.from({ length: 20 }, () => ({ height: 56 }));
    const offsets = rowOffsets(list);
    const win = rowWindow(offsets, 0, 200, 0); // filas 0..3
    assert.deepEqual(pinRow(win, offsets, null), win);
    assert.deepEqual(pinRow(win, offsets, 2), win, "ya dentro: la misma ventana");
    assert.deepEqual(pinRow(win, offsets, 99), win, "fuera de rango: la misma ventana");
    const below = pinRow(win, offsets, 10);
    assert.equal(below.start, win.start);
    assert.equal(below.end, 11);
    assert.equal(below.topSpacer, 0);
    assert.equal(below.bottomSpacer, offsets[20] - offsets[11]);
    const far = rowWindow(offsets, 900, 200, 0);
    const above = pinRow(far, offsets, 1);
    assert.equal(above.start, 1);
    assert.equal(above.end, far.end);
    assert.equal(above.topSpacer, 56);
    assert.equal(above.topSpacer + above.bottomSpacer + (above.end - above.start) * 56, offsets[20], "las alturas siguen sumando el total");
  });

  it("overscan configurable y lista vacía", () => {
    assert.deepEqual(rowWindow(offsets, 1000, 400, 0), { start: 17, end: 25, topSpacer: 952, bottomSpacer: 280 });
    const wide = rowWindow(offsets, 1000, 400);
    assert.ok(wide.start < 17 && wide.end > 25);
    assert.deepEqual(rowWindow([0], 0, 400), { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 });
  });
});

describe("timeline-engine · arrastre", () => {
  const M = res({ id: "m", arrivalDate: "2026-09-12", departureDate: "2026-09-14", assignedRoomId: "r2" });
  const H = { ...M, status: "checked_in" };
  // r5: habitación libre y limpia del mismo tipo (r10 está «occupied» y ahora se rechaza como en el API).
  const R5 = room({ id: "r5", number: "5" });
  const dragRooms = new Map([...roomById, ["r5", R5]]);
  const drop = (over: Partial<Parameters<typeof resolveDrop>[0]>) =>
    resolveDrop({ res: M, mode: "move", dxDays: 0, targetRoomId: "r2", roomById: dragRooms, roomTypeById, ...over });

  it("snapDays redondea al día más cercano", () => {
    assert.equal(snapDays(160, 100), 2);
    assert.equal(snapDays(-40, 100), 0);
    assert.equal(snapDays(-60, 100), -1);
    assert.equal(snapDays(75, 150), 1);
  });

  it("dragPhase: clic hasta el umbral, arrastre a partir de él", () => {
    assert.equal(dragPhase(3, 2), "click");
    assert.equal(dragPhase(4, 4), "click");
    assert.equal(dragPhase(5, 0), "drag");
    assert.equal(dragPhase(0, -5), "drag");
    assert.equal(dragPhase(2, 0, 1), "drag");
  });

  it("dragAllowed por estado", () => {
    assert.deepEqual(dragAllowed({ status: "confirmed" }), { move: true, resize: true, room: true });
    assert.deepEqual(dragAllowed({ status: "draft" }), { move: true, resize: true, room: true });
    assert.deepEqual(dragAllowed({ status: "checked_in" }), { move: false, resize: false, room: true, reason: IN_HOUSE_DRAG_REASON });
    for (const status of ["checked_out", "cancelled", "no_show"]) {
      assert.deepEqual(dragAllowed({ status }), { move: false, resize: false, room: false, reason: CLOSED_DRAG_REASON });
    }
    assert.equal(IN_HOUSE_DRAG_REASON, "Una reserva en casa solo puede cambiar de habitación");
    assert.equal(CLOSED_DRAG_REASON, "La reserva está cerrada");
  });

  it("mover dos días en la misma habitación", () => {
    const out = drop({ dxDays: 2 });
    assert.equal(out.rejected, null);
    assert.deepEqual(out.pending, {
      type: "move",
      res: M,
      newRoomId: null,
      newRoomLabel: undefined,
      newArrival: "2026-09-14",
      newDeparture: "2026-09-16",
      warnings: [PRICE_NOT_REQUOTED_WARNING]
    });
  });

  it("cambiar de habitación sin mover fechas", () => {
    const out = drop({ targetRoomId: "r5" });
    assert.deepEqual(out.pending, { type: "move", res: M, newRoomId: "r5", newRoomLabel: "Hab. 5", newArrival: null, newDeparture: null, warnings: [] });
  });

  it("ambos a la vez", () => {
    const out = drop({ dxDays: 1, targetRoomId: "r5" });
    assert.ok(out.pending && out.pending.type === "move");
    assert.deepEqual(
      [out.pending.newRoomId, out.pending.newArrival, out.pending.newDeparture, out.pending.warnings],
      ["r5", "2026-09-13", "2026-09-15", [PRICE_NOT_REQUOTED_WARNING]]
    );
  });

  it("sobre «Sin asignar», la misma habitación o ninguna fila no cambia la habitación", () => {
    assert.deepEqual(drop({ targetRoomId: UNASSIGNED_ID }), { pending: null, rejected: null });
    assert.deepEqual(drop({ targetRoomId: "r2" }), { pending: null, rejected: null });
    assert.deepEqual(drop({ targetRoomId: null }), { pending: null, rejected: null });
    const out = drop({ targetRoomId: UNASSIGNED_ID, dxDays: 2 });
    assert.ok(out.pending && out.pending.type === "move");
    assert.equal(out.pending.newRoomId, null);
    assert.equal(out.pending.newArrival, "2026-09-14");
  });

  it("resize-end: la salida debe quedar después de la llegada", () => {
    assert.deepEqual(drop({ mode: "resize-end", dxDays: -2 }), { pending: null, rejected: DEPARTURE_AFTER_ARRIVAL });
    assert.equal(DEPARTURE_AFTER_ARRIVAL, "La salida debe ser posterior a la llegada");
    const out = drop({ mode: "resize-end", dxDays: -1 });
    assert.deepEqual(out.pending, { type: "resize", res: M, newArrivalDate: "2026-09-12", newDepartureDate: "2026-09-13", warnings: [PRICE_NOT_REQUOTED_WARNING] });
    assert.deepEqual(drop({ mode: "resize-end", dxDays: 0 }), { pending: null, rejected: null });
  });

  it("resize-start: la llegada debe quedar antes de la salida", () => {
    assert.deepEqual(drop({ mode: "resize-start", dxDays: 2 }), { pending: null, rejected: ARRIVAL_BEFORE_DEPARTURE });
    const out = drop({ mode: "resize-start", dxDays: -1 });
    assert.deepEqual(out.pending, { type: "resize", res: M, newArrivalDate: "2026-09-11", newDepartureDate: "2026-09-14", warnings: [PRICE_NOT_REQUOTED_WARNING] });
    assert.deepEqual(drop({ mode: "resize-start", dxDays: 0 }), { pending: null, rejected: null });
  });

  it("en casa con fechas y misma habitación → rechazado con la razón", () => {
    assert.deepEqual(drop({ res: H, dxDays: 1 }), { pending: null, rejected: IN_HOUSE_DRAG_REASON });
    assert.deepEqual(drop({ res: H, mode: "resize-end", dxDays: 1 }), { pending: null, rejected: IN_HOUSE_DRAG_REASON });
    assert.deepEqual(drop({ res: H, mode: "resize-start", dxDays: -1 }), { pending: null, rejected: IN_HOUSE_DRAG_REASON });
  });

  it("en casa con fechas y otra habitación → solo habitación, con aviso", () => {
    const out = drop({ res: H, dxDays: 1, targetRoomId: "r5" });
    assert.deepEqual(out.pending, { type: "move", res: H, newRoomId: "r5", newRoomLabel: "Hab. 5", newArrival: null, newDeparture: null, warnings: [IN_HOUSE_DRAG_REASON] });
    const clean = drop({ res: H, targetRoomId: "r5" });
    assert.ok(clean.pending && clean.pending.type === "move");
    assert.deepEqual(clean.pending.warnings, []);
  });

  it("estado cerrado → rechazado", () => {
    for (const status of ["checked_out", "cancelled", "no_show"]) {
      assert.deepEqual(drop({ res: { ...M, status }, dxDays: 1, targetRoomId: "r5" }), { pending: null, rejected: CLOSED_DRAG_REASON });
    }
  });

  it("avisos: tipo, pax y precio (el bloqueo ya no es aviso: rechaza)", () => {
    const type = drop({ targetRoomId: "r202" });
    assert.ok(type.pending && type.pending.type === "move");
    assert.deepEqual(type.pending.warnings, ["La habitación 202 es de tipo Suite y la reserva es de tipo Doble"]);

    const pax = drop({ res: { ...M, adults: 2, children: 1, assignedRoomId: "r202", roomTypeId: "B" }, targetRoomId: "r2" });
    assert.ok(pax.pending && pax.pending.type === "move");
    assert.deepEqual(pax.pending.warnings, [
      "La habitación 2 es de tipo Doble y la reserva es de tipo Suite",
      "La habitación admite 2 personas y la reserva lleva 3"
    ]);
    assert.equal(ROOM_BLOCKED_WARNING, "La habitación está bloqueada por mantenimiento");

    const both = drop({ targetRoomId: "r202", dxDays: 1 });
    assert.ok(both.pending && both.pending.type === "move");
    assert.deepEqual(both.pending.warnings, ["La habitación 202 es de tipo Suite y la reserva es de tipo Doble", PRICE_NOT_REQUOTED_WARNING]);
    assert.equal(PRICE_NOT_REQUOTED_WARNING, "El precio no se recalcula al cambiar las fechas: revísalo en la reserva");
  });

  // Alineado con canAssignRoom (inventory.engine.ts): lo que el API rechaza con
  // 409 se rechaza aquí, antes de abrir el diálogo, con el mismo motivo.
  it("habitación bloqueada (mantenimiento / fuera de servicio) → rechazado, como en el API y en el diálogo Asignar", () => {
    assert.deepEqual(drop({ res: { ...M, roomTypeId: "B", assignedRoomId: "r202" }, targetRoomId: "r301" }), { pending: null, rejected: ROOM_BLOCKED_REASON });
    assert.equal(ROOM_BLOCKED_REASON, "La habitación está bloqueada por mantenimiento o no es vendible");
    // También en casa: el traslado a una bloqueada no se propone.
    assert.deepEqual(drop({ res: { ...H, roomTypeId: "B", assignedRoomId: "r202" }, targetRoomId: "r301" }), { pending: null, rejected: ROOM_BLOCKED_REASON });
  });

  it("habitación ocupada (otra reserva en casa, o marcada «occupied» sin verla) → rechazado con el motivo del API", () => {
    const inHouse = res({ id: "h10", arrivalDate: "2026-09-11", departureDate: "2026-09-13", assignedRoomId: "r10", status: "checked_in" });
    assert.deepEqual(drop({ targetRoomId: "r10", reservations: [inHouse] }), { pending: null, rejected: ROOM_OCCUPIED_REASON });
    assert.equal(ROOM_OCCUPIED_REASON, "La habitación está ocupada actualmente");
    // Sin reservas cargadas, el `status: "occupied"` de la fila basta (la fila se pinta «Ocupada»).
    assert.deepEqual(drop({ targetRoomId: "r10" }), { pending: null, rejected: ROOM_OCCUPIED_REASON });
    // Aunque el ocupante salga antes de la nueva llegada: el API no mira fechas para «ocupada».
    assert.deepEqual(drop({ targetRoomId: "r10", dxDays: 2, reservations: [inHouse] }), { pending: null, rejected: ROOM_OCCUPIED_REASON });
    // La propia reserva en casa revalidándose sobre su habitación (mover fechas no aplica en casa, pero
    // una `occupied` con ocupante = ella misma no es conflicto): roomAssignmentConflict lo distingue.
    const self = { ...H, id: "h10", assignedRoomId: "r10" };
    assert.equal(roomAssignmentConflict(self, R10, { arrivalDate: "2026-09-12", departureDate: "2026-09-14" }, [{ ...inHouse, id: "h10" }]), null);
    // Una reserva en una habitación que solo FIGURA ocupada (otra en casa cargada en otra habitación) no se ve afectada.
    const elsewhere = res({ id: "e", arrivalDate: "2026-09-11", departureDate: "2026-09-13", assignedRoomId: "r2", status: "checked_in" });
    assert.equal(roomAssignmentConflict(M, R5, { arrivalDate: "2026-09-12", departureDate: "2026-09-14" }, [elsewhere]), null);
  });

  it("otra confirmada o en casa asignada a la habitación destino que solape las nuevas fechas → rechazado; sin solape, propuesta", () => {
    const other = res({ id: "o", arrivalDate: "2026-09-13", departureDate: "2026-09-15", assignedRoomId: "r5" });
    const overlap = drop({ targetRoomId: "r5", reservations: [other] });
    assert.deepEqual(overlap, { pending: null, rejected: roomOverlapReason("5", "R-o") });
    assert.equal(overlap.rejected, "La habitación 5 ya está asignada a la reserva R-o en esas fechas");
    // Salida el día de la nueva llegada: no solapa (llegada < salida y salida > llegada).
    const backToBack = res({ id: "b2b", arrivalDate: "2026-09-10", departureDate: "2026-09-12", assignedRoomId: "r5" });
    assert.equal(drop({ targetRoomId: "r5", reservations: [backToBack] }).rejected, null);
    // Las cerradas y las canceladas no ocupan; las de otra habitación tampoco cuentan; la propia reserva se ignora.
    for (const status of ["checked_out", "cancelled", "no_show"]) {
      assert.equal(drop({ targetRoomId: "r5", reservations: [{ ...other, status }] }).rejected, null, status);
    }
    assert.equal(drop({ targetRoomId: "r5", reservations: [{ ...other, assignedRoomId: "r202" }] }).rejected, null);
    assert.equal(drop({ targetRoomId: "r5", reservations: [{ ...M, assignedRoomId: "r5" }] }).rejected, null, "la propia reserva no es conflicto");
    // Mover de fechas en la MISMA habitación también revalida (el PATCH lo hace): solape con la vecina.
    const neighbour = res({ id: "n", arrivalDate: "2026-09-14", departureDate: "2026-09-16", assignedRoomId: "r2" });
    assert.deepEqual(drop({ dxDays: 1, reservations: [neighbour] }), { pending: null, rejected: roomOverlapReason("2", "R-n") });
    assert.equal(drop({ dxDays: 1, reservations: [{ ...neighbour, arrivalDate: "2026-09-15", departureDate: "2026-09-17" }] }).rejected, null);
    // Y el redimensionado: alargar la salida hasta pisar a la vecina.
    assert.deepEqual(drop({ mode: "resize-end", dxDays: 1, reservations: [neighbour] }), { pending: null, rejected: roomOverlapReason("2", "R-n") });
    assert.equal(drop({ mode: "resize-end", dxDays: 1, reservations: [{ ...neighbour, arrivalDate: "2026-09-15" }] }).rejected, null);
    assert.deepEqual(drop({ mode: "resize-start", dxDays: -2, reservations: [{ ...backToBack, assignedRoomId: "r2" }] }), { pending: null, rejected: roomOverlapReason("2", "R-b2b") });
    // Sin habitación asignada (y sin soltar sobre una fila) no hay nada que validar.
    assert.equal(drop({ res: { ...M, assignedRoomId: undefined }, dxDays: 1, targetRoomId: null, reservations: [neighbour] }).rejected, null);
    // …pero soltar la no asignada sobre la fila de la vecina sí revalida esa habitación.
    assert.deepEqual(drop({ res: { ...M, assignedRoomId: undefined }, dxDays: 1, targetRoomId: "r2", reservations: [neighbour] }), { pending: null, rejected: roomOverlapReason("2", "R-n") });
  });
});

describe("timeline-engine · parches y deshacer", () => {
  const M = res({ id: "m", arrivalDate: "2026-09-12", departureDate: "2026-09-14", assignedRoomId: "r2" });
  const moveBoth: PendingChange = { type: "move", res: M, newRoomId: "r10", newRoomLabel: "Hab. 10", newArrival: "2026-09-13", newDeparture: "2026-09-15", warnings: [] };
  const moveDates: PendingChange = { type: "move", res: M, newRoomId: null, newArrival: "2026-09-13", newDeparture: "2026-09-15", warnings: [] };
  const moveRoom: PendingChange = { type: "move", res: M, newRoomId: "r10", newRoomLabel: "Hab. 10", newArrival: null, newDeparture: null, warnings: [] };
  const resize: PendingChange = { type: "resize", res: M, newArrivalDate: "2026-09-12", newDepartureDate: "2026-09-15", warnings: [] };

  it("patchFor: solo mueve fechas por PATCH; el cambio de habitación solo va por assign-room", () => {
    assert.deepEqual(patchFor(moveBoth), { arrivalDate: "2026-09-13", departureDate: "2026-09-15", assignedRoomId: "r10" });
    assert.deepEqual(patchFor(moveDates), { arrivalDate: "2026-09-13", departureDate: "2026-09-15" });
    assert.equal(patchFor(moveRoom), null);
    assert.deepEqual(patchFor(resize), { arrivalDate: "2026-09-12", departureDate: "2026-09-15" });
    assert.equal(patchFor({ type: "checkin", res: M }), null);
    assert.equal(patchFor({ type: "assign", res: M }), null);
  });

  it("undoPatchFor devuelve los valores previos (habitación null si no había)", () => {
    assert.deepEqual(undoPatchFor(moveBoth), { arrivalDate: "2026-09-12", departureDate: "2026-09-14", assignedRoomId: "r2" });
    const free = { ...M, assignedRoomId: undefined };
    assert.deepEqual(undoPatchFor({ type: "assign", res: free }), { arrivalDate: "2026-09-12", departureDate: "2026-09-14", assignedRoomId: null });
  });

  it("undoEntryFor: etiquetas en español y roomOnly en casa", () => {
    assert.deepEqual(undoEntryFor(moveRoom), {
      reservationId: "m",
      code: "R-m",
      label: "Reserva R-m movida a Hab. 10",
      patch: { arrivalDate: "2026-09-12", departureDate: "2026-09-14", assignedRoomId: "r2" },
      roomOnly: false
    });
    assert.equal(undoEntryFor(moveDates)?.label, "Reserva R-m movida de fechas");
    assert.equal(undoEntryFor(moveBoth)?.label, "Reserva R-m movida de fechas");
    assert.equal(undoEntryFor(resize)?.label, "Fechas de R-m actualizadas");
    assert.equal(undoEntryFor({ type: "assign", res: M })?.label, "Habitación de R-m asignada");
    const inHouse = undoEntryFor({ ...moveRoom, res: { ...M, status: "checked_in" } });
    assert.deepEqual(inHouse && { roomOnly: inHouse.roomOnly, patch: inHouse.patch }, { roomOnly: true, patch: { assignedRoomId: "r2" } });
    // En casa, deshacer es otro traslado: la entrada lo advierte; fuera de casa no hay nota.
    assert.equal(inHouse?.note, IN_HOUSE_UNDO_NOTE);
    assert.match(IN_HOUSE_UNDO_NOTE, /habitación intermedia queda sucia/);
    assert.equal(undoEntryFor(moveRoom)?.note, undefined);
    assert.equal(undoEntryFor(resize)?.note, undefined);
    assert.equal(undoEntryFor({ type: "checkin", res: M }), null);
    assert.equal(undoEntryFor({ type: "cancel", res: M }), null);
  });
});

describe("timeline-engine · colisiones y disponibilidad", () => {
  const P1 = res({ id: "p1", arrivalDate: "2026-09-11", departureDate: "2026-09-13", assignedRoomId: "r2" });
  const P2 = res({ id: "p2", arrivalDate: "2026-09-12", departureDate: "2026-09-13" });
  const P3 = res({ id: "p3", arrivalDate: "2026-09-12", departureDate: "2026-09-14", assignedRoomId: "r10", status: "checked_in" });
  const P4 = res({ id: "p4", arrivalDate: "2026-09-12", departureDate: "2026-09-13", status: "cancelled" });
  const P5 = res({ id: "p5", arrivalDate: "2026-09-12", departureDate: "2026-09-13", status: "draft" });
  const Q1 = res({ id: "q1", arrivalDate: "2026-09-10", departureDate: "2026-09-12", assignedRoomId: "r202", roomTypeId: "B", status: "checked_in" });
  const Q2 = res({ id: "q2", arrivalDate: "2026-09-11", departureDate: "2026-09-13", roomTypeId: "B" });

  it("roomOverlapCount cuenta TODOS los pares vivos solapados por habitación (sin cerradas, no-show, canceladas ni sin asignar)", () => {
    const list = [
      res({ id: "o1", arrivalDate: "2026-09-10", departureDate: "2026-09-13", assignedRoomId: "r2" }),
      res({ id: "o2", arrivalDate: "2026-09-12", departureDate: "2026-09-15", assignedRoomId: "r2" }),
      res({ id: "o3", arrivalDate: "2026-09-14", departureDate: "2026-09-16", assignedRoomId: "r2" }),
      res({ id: "o4", arrivalDate: "2026-09-10", departureDate: "2026-09-16", assignedRoomId: "r2", status: "cancelled" }),
      res({ id: "o5", arrivalDate: "2026-09-10", departureDate: "2026-09-16" }),
      res({ id: "o6", arrivalDate: "2026-09-13", departureDate: "2026-09-15", assignedRoomId: "r10" })
    ];
    assert.equal(roomOverlapCount(list), 2);
    assert.equal(roomOverlapCount([]), 0);
    // Una salida cerrada o un no-show que pisan a una confirmada no son un solape (antes daban falsos positivos).
    const closed = res({ id: "c", arrivalDate: "2026-09-10", departureDate: "2026-09-16", assignedRoomId: "r2", status: "checked_out" });
    const noShow = res({ id: "ns", arrivalDate: "2026-09-10", departureDate: "2026-09-16", assignedRoomId: "r2", status: "no_show" });
    assert.equal(roomOverlapCount([list[0], closed, noShow]), 0);
    // Tres estancias que se pisan a la vez son tres pares, no solo los consecutivos.
    const triple = [
      res({ id: "t1", arrivalDate: "2026-09-10", departureDate: "2026-09-16", assignedRoomId: "r2" }),
      res({ id: "t2", arrivalDate: "2026-09-11", departureDate: "2026-09-13", assignedRoomId: "r2", status: "checked_in" }),
      res({ id: "t3", arrivalDate: "2026-09-12", departureDate: "2026-09-14", assignedRoomId: "r2" })
    ];
    assert.equal(roomOverlapCount(triple), 3);
  });

  it("occupiedNights: llegada ≤ día < salida", () => {
    assert.deepEqual(occupiedNights(P1, COLUMNS), [false, true, true, false, false, false, false]);
    assert.deepEqual(occupiedNights(res({ id: "z", arrivalDate: "2026-09-05", departureDate: "2026-09-11" }), COLUMNS), [true, false, false, false, false, false, false]);
  });

  it("sellableByType descuenta las bloqueadas y conserva el tipo a 0", () => {
    assert.deepEqual([...sellableByType(ROOMS)], [["B", 1], ["A", 2], ["Z", 1]]);
    assert.deepEqual([...sellableByType([R301])], [["B", 0]]);
  });

  it("bookedByType solo cuenta confirmadas y en casa, asignadas o no", () => {
    const booked = bookedByType([P1, P2, P3, P4, P5, Q1, Q2], COLUMNS);
    assert.deepEqual(booked.get("A"), [0, 1, 3, 1, 0, 0, 0]);
    assert.deepEqual(booked.get("B"), [1, 2, 1, 0, 0, 0, 0]);
  });

  it("roomsCount: una reserva de grupo descuenta sus unidades (como el API), mínimo 1", () => {
    assert.equal(roomUnits({ roomsCount: 3 }), 3);
    assert.equal(roomUnits({ roomsCount: 1 }), 1);
    assert.equal(roomUnits({ roomsCount: 0 }), 1);
    assert.equal(roomUnits({ roomsCount: undefined }), 1);
    assert.equal(roomUnits({ roomsCount: 2.9 }), 2);
    const group = res({ id: "grp", arrivalDate: "2026-09-12", departureDate: "2026-09-13", roomsCount: 3 });
    assert.deepEqual(bookedByType([group], COLUMNS).get("A"), [0, 0, 3, 0, 0, 0, 0]);
    assert.deepEqual(availabilityByType(ROOMS, [group], COLUMNS).get("A"), [2, 2, -1, 2, 2, 2, 2]);
    assert.deepEqual(overbookingDays(ROOMS, TYPES, [group], COLUMNS), [{ roomTypeId: "A", roomTypeName: "Doble", dayKey: "2026-09-12", booked: 3, sellable: 2 }]);
  });

  it("availabilityByType = vendibles − ocupadas (negativo en overbooking)", () => {
    const free = availabilityByType(ROOMS, [P1, P2, P3, P4, P5, Q1, Q2], COLUMNS);
    assert.deepEqual(free.get("A"), [2, 1, -1, 1, 2, 2, 2]);
    assert.deepEqual(free.get("B"), [0, -1, 0, 1, 1, 1, 1]);
    assert.deepEqual(free.get("Z"), [1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(availabilityByType([R2], [Q2], COLUMNS).get("B"), [0, -1, -1, 0, 0, 0, 0]);
  });

  it("overbookingDays: tres confirmadas de tipo A el 12/09 con dos vendibles → un día afectado", () => {
    const days = overbookingDays(ROOMS, TYPES, [P1, P2, P3, P4, P5], COLUMNS);
    assert.deepEqual(days, [{ roomTypeId: "A", roomTypeName: "Doble", dayKey: "2026-09-12", booked: 3, sellable: 2 }]);
    assert.deepEqual(overbookingDays(ROOMS, TYPES, [P1, P2, P4, P5], COLUMNS), []);
  });

  it("overbookingDays ordena por día y tipo; overbookingSummary cuenta días distintos", () => {
    const days = overbookingDays(ROOMS, TYPES, [P1, P2, P3, P4, P5, Q1, Q2], COLUMNS);
    assert.deepEqual(days.map((d) => [d.roomTypeName, d.dayKey, d.booked, d.sellable]), [["Suite", "2026-09-11", 2, 1], ["Doble", "2026-09-12", 3, 2]]);
    const summary = overbookingSummary(days);
    assert.equal(summary.count, 2);
    assert.deepEqual(summary.dayKeys, ["2026-09-11", "2026-09-12"]);
    assert.deepEqual([...summary.byType], [["B", ["2026-09-11"]], ["A", ["2026-09-12"]]]);
    assert.deepEqual(overbookingSummary([]), { count: 0, dayKeys: [], byType: new Map() });
  });
});

describe("timeline-engine · filtros", () => {
  const F1 = res({ id: "f1", code: "R-1", arrivalDate: "2026-09-12", departureDate: "2026-09-14", bookerName: "María García", assignedRoomId: "r202", roomTypeId: "B" });
  const F2 = res({ id: "f2", code: "R-2", arrivalDate: "2026-09-12", departureDate: "2026-09-14", bookerName: "Pedro López", assignedRoomId: "r10", channel: "booking" });
  const F3 = res({ id: "f3", code: "R-3", arrivalDate: "2026-09-12", departureDate: "2026-09-14", status: "cancelled" });
  const F4 = res({ id: "f4", code: "R-4", arrivalDate: "2026-09-12", departureDate: "2026-09-14", primaryGuestId: "g1" });
  const present = { statuses: ["confirmed", "cancelled"], channels: ["direct", "booking"], roomTypes: ["A", "B"] };
  const base = effectiveFilters(DEFAULT_FILTERS, present);
  const ctx = { roomById, guestNames: { g1: "Ana Pérez" } };

  it("effectiveStatuses: sin selección, todo lo presente menos cancelled", () => {
    assert.deepEqual(effectiveStatuses(["confirmed", "cancelled", "checked_in"], null), ["confirmed", "checked_in"]);
    assert.deepEqual(effectiveStatuses(["confirmed", "cancelled"], ["cancelled"]), ["cancelled"]);
    assert.deepEqual(base, { status: ["confirmed"], channel: ["direct", "booking"], roomType: ["A", "B"], query: "" });
  });

  it("normalizeText quita acentos y mayúsculas", () => {
    assert.equal(normalizeText("  GARCÍA Ñ "), "garcia n");
    assert.equal(normalizeText("Pérez"), "perez");
  });

  it("la búsqueda «202» casa por número de habitación", () => {
    const filters = { ...base, query: "202" };
    assert.equal(matchesFilters(F1, filters, ctx), true);
    assert.equal(matchesFilters(F2, filters, ctx), false);
    assert.equal(matchesFilters(F1, { ...base, query: "R-1" }, ctx), true);
  });

  it("la búsqueda casa por huésped sin acentos, también por el nombre resuelto, nunca por el id", () => {
    assert.equal(matchesFilters(F1, { ...base, query: "garcía" }, ctx), true);
    assert.equal(matchesFilters(F1, { ...base, query: "GARCIA" }, ctx), true);
    assert.equal(matchesFilters(F2, { ...base, query: "lopez" }, ctx), true);
    assert.equal(matchesFilters(F1, { ...base, query: "lopez" }, ctx), false);
    assert.equal(matchesFilters(F4, { ...base, query: "perez" }, ctx), true);
    assert.equal(matchesFilters(F4, { ...base, query: "g1" }, ctx), false);
    assert.equal(matchesFilters(F4, { ...base, query: "pendiente" }, { roomById, guestNames: {} }), true);
  });

  it("cancelled queda oculta por defecto y aparece al seleccionarla", () => {
    assert.equal(matchesFilters(F3, base, ctx), false);
    assert.equal(matchesFilters(F3, { ...base, status: ["cancelled"] }, ctx), true);
    assert.equal(matchesFilters(F1, { ...base, status: [] }, ctx), false);
  });

  it("tipo de habitación y canal", () => {
    assert.equal(matchesFilters(F1, { ...base, roomType: ["B"] }, ctx), true);
    assert.equal(matchesFilters(F2, { ...base, roomType: ["B"] }, ctx), false);
    assert.equal(matchesFilters(F2, { ...base, channel: ["booking"] }, ctx), true);
    assert.equal(matchesFilters(F1, { ...base, channel: ["booking"] }, ctx), false);
  });

  it("filtersTouched y effectiveFilters con selección explícita", () => {
    assert.equal(filtersTouched(DEFAULT_FILTERS), false);
    assert.equal(filtersTouched({ ...DEFAULT_FILTERS, query: "  " }), false);
    assert.equal(filtersTouched({ ...DEFAULT_FILTERS, query: "x" }), true);
    assert.equal(filtersTouched({ ...DEFAULT_FILTERS, status: [] }), true);
    assert.equal(filtersTouched({ ...DEFAULT_FILTERS, roomType: ["A"] }), true);
    assert.deepEqual(effectiveFilters({ status: ["cancelled"], channel: ["booking"], roomType: ["A"], query: "q" }, present), {
      status: ["cancelled"],
      channel: ["booking"],
      roomType: ["A"],
      query: "q"
    });
  });
});

describe("timeline-engine · teclado", () => {
  // Filas con barras: Sin asignar [u], Hab. 2 [a, b], Hab. 10 [c], Hab. 202 [d].
  const rows = rowsFor([A1, B1, C1, D1, U1]);

  it("sin selección (o id desconocido) → primera barra; sin barras → null", () => {
    assert.equal(neighborBar(rows, null, "down"), "u");
    assert.equal(neighborBar(rows, "nope", "left"), "u");
    assert.equal(neighborBar(rowsFor([]), null, "down"), null);
    assert.equal(neighborBar([], "a", "up"), null);
  });

  it("izquierda/derecha recorren la fila por laneStart y paran en los extremos", () => {
    assert.equal(neighborBar(rows, "a", "right"), "b");
    assert.equal(neighborBar(rows, "b", "left"), "a");
    assert.equal(neighborBar(rows, "a", "left"), null);
    assert.equal(neighborBar(rows, "b", "right"), null);
  });

  it("arriba/abajo saltan a la fila con barras más cercana, prefiriendo el solape", () => {
    assert.equal(neighborBar(rows, "u", "down"), "b");
    assert.equal(neighborBar(rows, "a", "down"), "c");
    assert.equal(neighborBar(rows, "c", "up"), "a");
    assert.equal(neighborBar(rows, "c", "down"), "d");
    assert.equal(neighborBar(rows, "d", "up"), "c");
    assert.equal(neighborBar(rows, "d", "down"), null);
    assert.equal(neighborBar(rows, "u", "up"), null);
  });
});

describe("timeline-engine · crear por celdas", () => {
  it("selectionDates acepta índices invertidos", () => {
    assert.deepEqual(selectionDates({ startIndex: 3, endIndex: 1 }, RANGE), { arrivalDate: "2026-09-11", departureDate: "2026-09-14", nights: 3 });
    assert.deepEqual(selectionDates({ startIndex: 2, endIndex: 2 }, RANGE), { arrivalDate: "2026-09-12", departureDate: "2026-09-13", nights: 1 });
  });

  it("newReservationSearch: orden fijo y codificación URL", () => {
    assert.equal(
      newReservationSearch({ arrivalDate: "2026-09-11", departureDate: "2026-09-14", roomTypeId: "A B", assignedRoomId: "r2" }),
      "arrivalDate=2026-09-11&departureDate=2026-09-14&roomTypeId=A+B&assignedRoomId=r2"
    );
    assert.equal(newReservationSearch({ arrivalDate: "2026-09-11", departureDate: "2026-09-14" }), "arrivalDate=2026-09-11&departureDate=2026-09-14");
    assert.equal(newReservationSearch({ arrivalDate: "2026-09-11", departureDate: "2026-09-14", assignedRoomId: "r2" }), "arrivalDate=2026-09-11&departureDate=2026-09-14&assignedRoomId=r2");
  });
});

describe("timeline-engine · errores del API y actividad", () => {
  it("isForbidden/isNotFound leen status y toleran cualquier valor", () => {
    assert.equal(isForbidden({ status: 403 }), true);
    assert.equal(isForbidden({ status: 404 }), false);
    assert.equal(isNotFound({ status: 404 }), true);
    assert.equal(isNotFound(new Error("x")), false);
    assert.equal(isForbidden(null), false);
    assert.equal(isForbidden(undefined), false);
    assert.equal(isForbidden("403"), false);
  });

  it("conflictCode solo con 409 y details.code de texto", () => {
    assert.equal(conflictCode({ status: 409, details: { code: "ROOM_CONFLICT" } }), "ROOM_CONFLICT");
    assert.equal(conflictCode({ status: 409, details: { code: "BALANCE_DUE", balanceDue: 12 } }), "BALANCE_DUE");
    assert.equal(conflictCode({ status: 409 }), null);
    assert.equal(conflictCode({ status: 409, details: { code: 7 } }), null);
    assert.equal(conflictCode({ status: 400, details: { code: "ROOM_CONFLICT" } }), null);
    assert.equal(conflictCode(null), null);
  });

  it("conflictMessage en español con fallback", () => {
    assert.equal(conflictMessage("ROOM_CONFLICT"), "La habitación entra en conflicto con otra reserva en esas fechas");
    assert.equal(conflictMessage("BALANCE_DUE"), "El folio tiene saldo pendiente: cóbralo o confirma la salida con saldo");
    assert.equal(conflictMessage("CHECK_IN_DATE_OUT_OF_RANGE"), "La llegada está fuera de la ventana de check-in (±1 día sobre la fecha de negocio o la de hoy, la más reciente)");
    assert.equal(conflictMessage("RESERVATION_CHANGED_MEANWHILE"), "La reserva cambió mientras se procesaba: actualiza y repite");
    assert.equal(conflictMessage("OTRO"), UNKNOWN_CONFLICT_MESSAGE);
    assert.equal(conflictMessage(null), "No se pudo completar la acción.");
  });

  it("activityLabel traduce tipo y departamento", () => {
    assert.equal(activityLabel("message", "Chat"), "Mensaje · Chat");
    assert.equal(activityLabel("housekeeping", "Housekeeping"), "Limpieza");
    assert.equal(activityLabel("maintenance", "Maintenance"), "Mantenimiento");
    assert.equal(activityLabel("service_request", "Reception"), "Petición · Recepción");
    assert.equal(activityLabel("service_request", "Spa"), "Petición · Spa");
    assert.equal(activityLabel("service_request", ""), "Petición");
  });
});
