// Unit tests · Tanda CHK · lote W3-D — Mi día con la capa de check-in
// (diseño docs/design/CHECKIN-AUTOMATIZADO-IA.md §8 «Recepción · /hoy» y
// «Cola de acciones», §4b consumidores, §4d handoffs). Prisma falso inyectado
// por `deps` (sin base de datos, sin red), mismo estilo que
// front-desk.service.test.mts: fixtures ficticias, resultados esperados a mano.
// Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/front-desk-checkin.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFrontDeskDashboard, type FrontDeskDashboardDeps } from "../front-desk.service.js";
import {
  FRONT_DESK_QUEUE_KINDS,
  buildFrontDeskQueue,
  type FrontDeskQueueDeps,
  type FrontDeskQueueItem,
  type FrontDeskQueueKind
} from "../front-desk-queue.service.js";

const PROPERTY = "prop_test";
const NOW = new Date("2026-09-19T12:00:00.000Z");
const TODAY = "2026-09-19";
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

// ---------------------------------------------------------------- fixtures (ficticias)

type Reservation = {
  id: string;
  propertyId: string;
  code: string;
  status: string;
  arrivalDate: Date;
  departureDate: Date;
  roomTypeId: string | null;
  assignedRoomId: string | null;
  vipFlag: boolean;
  eta: string | null;
  etd: string | null;
  specialRequests: string | null;
  notes: string | null;
};

const res = (partial: Partial<Reservation> & Pick<Reservation, "id" | "code" | "status" | "arrivalDate" | "departureDate">): Reservation => ({
  propertyId: PROPERTY,
  roomTypeId: "rt_dbl",
  assignedRoomId: null,
  vipFlag: false,
  eta: null,
  etd: null,
  specialRequests: null,
  notes: null,
  ...partial
});

const reservations: Reservation[] = [
  // Pre-check-in completo (2/2), habitación inspeccionada, sin llave todavía.
  res({ id: "r_ready", code: "TST-READY", status: "confirmed", arrivalDate: day(TODAY), departureDate: day("2026-09-21"), roomTypeId: "rt_sup", assignedRoomId: "room_101", eta: "16:00" }),
  // Sin habitación, con sugerencia del motor pendiente.
  res({ id: "r_sugg", code: "TST-SUGG", status: "confirmed", arrivalDate: day(TODAY), departureDate: day("2026-09-20"), eta: "15:00" }),
  // Auto-check-in hecho en el kiosco hace 30 min con llave móvil emitida.
  res({ id: "r_key", code: "TST-KEY", status: "checked_in", arrivalDate: day(TODAY), departureDate: day("2026-09-22"), roomTypeId: "rt_sup", assignedRoomId: "room_310" }),
  // Derivada desde el kiosco por identidad no verificable.
  res({ id: "r_handoff", code: "TST-HAND", status: "confirmed", arrivalDate: day(TODAY), departureDate: day("2026-09-20"), roomTypeId: "rt_sup", assignedRoomId: "room_120" }),
  // Sin habitación y sin sesión ni sugerencia: lógica previa (primera limpia del tipo).
  res({ id: "r_plain", code: "TST-PLAIN", status: "confirmed", arrivalDate: day(TODAY), departureDate: day("2026-09-20") }),
  // Llega mañana sin habitación con sugerencia del lote de las 18:00.
  res({ id: "r_tomorrow", code: "TST-TOM", status: "confirmed", arrivalDate: day("2026-09-20"), departureDate: day("2026-09-22"), eta: "14:00" }),
  // In-house con parte SES rechazado hoy.
  res({ id: "r_ses", code: "TST-SES", status: "checked_in", arrivalDate: day("2026-09-18"), departureDate: day("2026-09-21"), assignedRoomId: "room_330" }),
  res({ id: "r_other_prop", code: "OTR-1", status: "confirmed", arrivalDate: day(TODAY), departureDate: day("2026-09-20"), propertyId: "prop_other" })
];

const reservationGuests = [
  { reservationId: "r_ready", guestId: "g_ready", isPrimary: true },
  { reservationId: "r_sugg", guestId: "g_sugg", isPrimary: true },
  { reservationId: "r_key", guestId: "g_key", isPrimary: true },
  { reservationId: "r_handoff", guestId: "g_hand", isPrimary: true },
  { reservationId: "r_plain", guestId: "g_plain", isPrimary: true },
  { reservationId: "r_tomorrow", guestId: "g_tom", isPrimary: true },
  { reservationId: "r_ses", guestId: "g_ses", isPrimary: true }
];

const guests = [
  { id: "g_ready", firstName: "Lista", surname1: "Prueba", surname2: null, vipCode: null, loyaltyTier: null, documentNumber: null },
  { id: "g_sugg", firstName: "Sugerida", surname1: "Prueba", surname2: null, vipCode: null, loyaltyTier: null, documentNumber: null },
  { id: "g_key", firstName: "Llave", surname1: "Prueba", surname2: null, vipCode: null, loyaltyTier: null, documentNumber: null },
  { id: "g_hand", firstName: "Derivada", surname1: "Prueba", surname2: null, vipCode: null, loyaltyTier: null, documentNumber: null },
  { id: "g_plain", firstName: "Normal", surname1: "Prueba", surname2: null, vipCode: null, loyaltyTier: null, documentNumber: null },
  { id: "g_tom", firstName: "Mañana", surname1: "Prueba", surname2: null, vipCode: null, loyaltyTier: null, documentNumber: null },
  { id: "g_ses", firstName: "Parte", surname1: "Prueba", surname2: null, vipCode: null, loyaltyTier: null, documentNumber: null }
];

const room = (id: string, number: string, roomTypeId: string, housekeepingStatus: string) => ({
  id,
  propertyId: PROPERTY,
  number,
  roomTypeId,
  active: true,
  sellable: true,
  status: "available",
  housekeepingStatus,
  maintenanceStatus: "ok"
});

const rooms = [
  room("room_101", "101", "rt_sup", "inspected"),
  room("room_120", "120", "rt_sup", "clean"),
  room("room_204", "204", "rt_dbl", "clean"),
  room("room_205", "205", "rt_dbl", "clean"),
  room("room_206", "206", "rt_dbl", "clean"),
  room("room_310", "310", "rt_sup", "clean"),
  room("room_330", "330", "rt_dbl", "dirty")
];

const roomTypes = [
  { id: "rt_dbl", name: "Doble" },
  { id: "rt_sup", name: "Superior" }
];

type Session = {
  id: string;
  propertyId: string;
  reservationId: string;
  status: string;
  channel: string;
  kioskDeviceId: string | null;
  handoffKind: string | null;
  handoffReason: string | null;
  etaDeclared: string | null;
  checkedInAt: Date | null;
};

const sessions: Session[] = [
  { id: "cs_ready", propertyId: PROPERTY, reservationId: "r_ready", status: "ready_for_arrival", channel: "email", kioskDeviceId: null, handoffKind: null, handoffReason: null, etaDeclared: "17:30", checkedInAt: null },
  { id: "cs_key", propertyId: PROPERTY, reservationId: "r_key", status: "checked_in", channel: "kiosk", kioskDeviceId: "kiosk_1", handoffKind: null, handoffReason: null, etaDeclared: null, checkedInAt: minutesAgo(30) },
  { id: "cs_hand", propertyId: PROPERTY, reservationId: "r_handoff", status: "handed_off", channel: "kiosk", kioskDeviceId: "kiosk_1", handoffKind: "identity_review", handoffReason: "MRZ con dígitos de control fallidos", etaDeclared: null, checkedInAt: null }
];

const checkInGuests = [
  { id: "cg_1", sessionId: "cs_ready", status: "signed" },
  { id: "cg_2", sessionId: "cs_ready", status: "verified" },
  { id: "cg_3", sessionId: "cs_key", status: "verified" },
  { id: "cg_4", sessionId: "cs_hand", status: "document_captured" },
  { id: "cg_5", sessionId: "cs_hand", status: "pending" }
];

const suggestionCandidates = [
  { roomId: "room_204", number: "204", score: 65, reasons: [{ rule: "hk:inspected", weight: 30, detail: "Inspeccionada esta mañana" }, { rule: "preference:high_floor", weight: 15, detail: "Planta alta como pidió" }, { rule: "rotation", weight: 5, detail: "Reparte el uso" }], warnings: [] },
  { roomId: "room_205", number: "205", score: 40, reasons: [{ rule: "hk:clean", weight: 20, detail: "Limpia" }], warnings: [] },
  { roomId: "room_206", number: "206", score: 20, reasons: [], warnings: [] }
];

const suggestions = [
  // Más antigua de la misma reserva: debe perder frente a la reciente.
  { id: "as_old", propertyId: PROPERTY, reservationId: "r_sugg", status: "suggested", candidatesJson: [{ roomId: "room_206", number: "206", score: 10, reasons: [], warnings: [] }], confidence: "0.1000", createdAt: new Date("2026-09-18T18:00:00.000Z") },
  { id: "as_sugg", propertyId: PROPERTY, reservationId: "r_sugg", status: "suggested", candidatesJson: suggestionCandidates, confidence: "0.8000", createdAt: new Date("2026-09-19T08:00:00.000Z") },
  { id: "as_confirmed", propertyId: PROPERTY, reservationId: "r_ready", status: "confirmed", candidatesJson: suggestionCandidates, confidence: "0.9000", createdAt: new Date("2026-09-19T09:00:00.000Z") },
  { id: "as_tom", propertyId: PROPERTY, reservationId: "r_tomorrow", status: "suggested", candidatesJson: [{ roomId: "room_206", number: "206", score: 50, reasons: [{ rule: "hk:clean", weight: 20, detail: "Limpia" }], warnings: [] }], confidence: "0.5000", createdAt: new Date("2026-09-18T18:00:00.000Z") }
];

const portalActions = [
  { id: "mkey_MK-TEST-1", propertyId: PROPERTY, reservationId: "r_key", actionType: "mobile_key", status: "active", payloadJson: { serialNumber: "MK-TEST-1", validUntil: "2026-09-22T12:00:00.000Z" }, createdAt: minutesAgo(25) },
  { id: "mkey_old", propertyId: PROPERTY, reservationId: "r_ready", actionType: "mobile_key", status: "revoked", payloadJson: { serialNumber: "MK-REVOKED" }, createdAt: minutesAgo(200) }
];

const sesSubmissions = [
  { id: "ses_1", propertyId: PROPERTY, reservationId: "r_ses", guestRegisterRecordId: "grr_1", status: "rejected", errorCode: "10130", updatedAt: minutesAgo(90) },
  { id: "ses_2", propertyId: PROPERTY, reservationId: "r_ses", guestRegisterRecordId: "grr_2", status: "rejected", errorCode: "10131", updatedAt: minutesAgo(60) },
  { id: "ses_old", propertyId: PROPERTY, reservationId: "r_ses", guestRegisterRecordId: "grr_3", status: "rejected", errorCode: "10130", updatedAt: new Date("2026-09-17T10:00:00.000Z") }
];

const balances = new Map<string, number>([["r_ready", 120]]);

// ---------------------------------------------------------------- Prisma falso mínimo

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where, tables: Record<string, Row[]>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === "OR") {
      if (!(condition as Where[]).some((branch) => matches(row, branch, tables))) return false;
      continue;
    }
    if (field === "reservation") {
      const target = tables.reservation.find((r) => r.id === row.reservationId);
      if (!target || !matches(target, condition as Where, tables)) return false;
      continue;
    }
    const value = row[field];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as { in?: unknown[]; gte?: Date; lt?: Date; gt?: Date; not?: unknown };
      if (c.in && !c.in.includes(value)) return false;
      if (c.gte !== undefined && !((value as Date) instanceof Date && (value as Date).getTime() >= c.gte.getTime())) return false;
      if (c.lt !== undefined && !((value as Date) instanceof Date && (value as Date).getTime() < c.lt.getTime())) return false;
      if (c.gt !== undefined && !((value as Date) instanceof Date && (value as Date).getTime() > c.gt.getTime())) return false;
      if ("not" in c && value === c.not) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

function project(row: Row, select: Record<string, unknown> | undefined, tables: Record<string, Row[]>): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, spec] of Object.entries(select)) {
    if (key === "guests" && spec && typeof spec === "object") {
      const nested = (spec as { select?: Record<string, boolean> }).select;
      out.guests = tables.checkInGuest.filter((g) => g.sessionId === row.id).map((g) => project(g, nested, tables));
      continue;
    }
    if (spec) out[key] = row[key];
  }
  return out;
}

type FakeOptions = {
  /** Modelos de check-in expuestos (false = doble anterior a la tanda). */
  checkInModels?: boolean;
  /** Vacía las tres tablas de check-in (mismo tenant sin sesiones ni sugerencias ni SES). */
  emptyCheckIn?: boolean;
  /** Hace fallar `checkInSession.findMany` (tabla rota → degraded). */
  brokenSessions?: boolean;
};

function fakeDb(options: FakeOptions = {}) {
  const empty = options.emptyCheckIn === true;
  const tables: Record<string, Row[]> = {
    reservation: reservations as unknown as Row[],
    reservationGuest: reservationGuests,
    guest: guests as unknown as Row[],
    room: rooms,
    roomType: roomTypes,
    workOrder: [],
    checkInSession: empty ? [] : (sessions as unknown as Row[]),
    checkInGuest: empty ? [] : checkInGuests,
    assignmentSuggestion: empty ? [] : (suggestions as unknown as Row[]),
    guestPortalAction: empty ? [] : (portalActions as unknown as Row[]),
    sesHospedajesSubmission: empty ? [] : (sesSubmissions as unknown as Row[])
  };
  const calls: string[] = [];
  const findMany = (table: string) => async (args: { where: Where; orderBy?: Record<string, "asc" | "desc"> | Array<Record<string, "asc" | "desc">>; select?: Record<string, unknown>; take?: number }) => {
    calls.push(`${table}.findMany`);
    await new Promise((resolve) => setTimeout(resolve, 1));
    let rows = tables[table].filter((row) => matches(row, args.where, tables));
    const orderBy = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
    if (orderBy) {
      const [field, direction] = Object.entries(orderBy)[0]!;
      // Como Postgres: NULL al final en asc (ORDER BY eta ASC → NULLS LAST).
      rows = [...rows].sort((a, b) => {
        const av = a[field] as Date | string | null | undefined;
        const bv = b[field] as Date | string | null | undefined;
        if ((av ?? null) === null && (bv ?? null) === null) return 0;
        if ((av ?? null) === null) return direction === "asc" ? 1 : -1;
        if ((bv ?? null) === null) return direction === "asc" ? -1 : 1;
        const cmp = av instanceof Date && bv instanceof Date ? av.getTime() - bv.getTime() : String(av).localeCompare(String(bv));
        return direction === "asc" ? cmp : -cmp;
      });
    }
    if (typeof args.take === "number") rows = rows.slice(0, args.take);
    return rows.map((row) => project(row, args.select, tables));
  };
  const count = (table: string) => async (args: { where: Where }) => {
    calls.push(`${table}.count`);
    return tables[table].filter((row) => matches(row, args.where, tables)).length;
  };
  const db: Record<string, unknown> = {
    reservation: { findMany: findMany("reservation"), count: count("reservation") },
    reservationGuest: { findMany: findMany("reservationGuest") },
    guest: { findMany: findMany("guest") },
    room: { findMany: findMany("room") },
    roomType: { findMany: findMany("roomType") },
    workOrder: { findMany: findMany("workOrder") }
  };
  if (options.checkInModels !== false) {
    db.checkInSession = {
      findMany: options.brokenSessions
        ? async () => {
            calls.push("checkInSession.findMany");
            throw new Error("relation \"checkin_sessions\" does not exist");
          }
        : findMany("checkInSession")
    };
    db.assignmentSuggestion = { findMany: findMany("assignmentSuggestion") };
    db.guestPortalAction = { findMany: findMany("guestPortalAction") };
    db.sesHospedajesSubmission = { findMany: findMany("sesHospedajesSubmission") };
  }
  const computeBalances = async (ids: string[]) => {
    calls.push("balances");
    const out = new Map<string, number>();
    for (const id of ids) out.set(id, balances.get(id) ?? 0);
    return out;
  };
  const dashboardDeps: FrontDeskDashboardDeps = { db: db as unknown as FrontDeskDashboardDeps["db"], computeBalances, now: () => NOW };
  const queueDeps: FrontDeskQueueDeps = { db: db as unknown as FrontDeskQueueDeps["db"], computeBalances };
  return { dashboardDeps, queueDeps, calls };
}

const NEW_KINDS: FrontDeskQueueKind[] = ["precheckin_ready", "assignment_suggested", "self_checkin_done", "identity_review", "minor_without_guardian", "room_not_ready", "payment_failed", "ses_rejected"];

const byId = (items: FrontDeskQueueItem[], id: string): FrontDeskQueueItem => {
  const item = items.find((candidate) => candidate.id === id);
  assert.ok(item, `falta el ítem ${id} (hay: ${items.map((i) => i.id).join(", ")})`);
  return item;
};

// ---------------------------------------------------------------- Mi día · llegadas

describe("front-desk.service.ts · capa de check-in de las llegadas (W3-D)", () => {
  it("llegada con sesión ready_for_arrival muestra preCheckIn 2/2 y cuenta en preCheckInCompleted", async () => {
    const { dashboardDeps, calls } = fakeDb();
    const result = await buildFrontDeskDashboard({ propertyId: PROPERTY, date: TODAY }, dashboardDeps);
    const ready = result.arrivals.find((row) => row.reservationId === "r_ready")!;
    assert.deepEqual(ready.preCheckIn, { status: "ready_for_arrival", completedGuests: 2, totalGuests: 2, channel: "email" });
    assert.equal(ready.roomNumber, "101");
    assert.equal(ready.suggestedRoom, undefined, "la sugerencia confirmada no se muestra en una llegada ya asignada");
    // r_ready (ready_for_arrival) + r_key (checked_in) = 2; r_handoff (handed_off, identidad por cotejar) NO cuenta
    // (corrector REV3-09); r_sugg y r_plain no tienen sesión.
    assert.equal(result.kpis.preCheckInCompleted, 2);
    assert.equal(result.kpis.arrivalsToday, 5);
    assert.deepEqual(result.degraded, []);
    // Sin N+1: una consulta por tabla de check-in, con ids agregados.
    assert.equal(calls.filter((c) => c === "checkInSession.findMany").length, 1);
    assert.equal(calls.filter((c) => c === "assignmentSuggestion.findMany").length, 1);
    assert.equal(calls.filter((c) => c === "guestPortalAction.findMany").length, 1);
  });

  it("sugerencia adjunta con motivos (los detail) y confidence; la más reciente gana", async () => {
    const { dashboardDeps } = fakeDb();
    const result = await buildFrontDeskDashboard({ propertyId: PROPERTY, date: TODAY }, dashboardDeps);
    const sugg = result.arrivals.find((row) => row.reservationId === "r_sugg")!;
    assert.deepEqual(sugg.suggestedRoom, {
      suggestionId: "as_sugg",
      roomId: "room_204",
      number: "204",
      reasons: ["Inspeccionada esta mañana", "Planta alta como pidió", "Reparte el uso"],
      confidence: 0.8
    });
    assert.deepEqual(sugg.preCheckIn, { status: "not_invited", completedGuests: 0, totalGuests: 0 });
    assert.deepEqual(sugg.key, { status: "reception" });
    // La fila de «sin asignar» no cambia (contrato previo).
    assert.deepEqual(result.unassigned.map((row) => row.reservationId), ["r_sugg", "r_plain"]);
  });

  it("llave emitida (mobile_key activa) con su serial; pendiente si la sesión sigue abierta por un canal del huésped", async () => {
    const { dashboardDeps } = fakeDb();
    const result = await buildFrontDeskDashboard({ propertyId: PROPERTY, date: TODAY }, dashboardDeps);
    const withKey = result.arrivals.find((row) => row.reservationId === "r_key")!;
    assert.deepEqual(withKey.key, { status: "issued", serialNumber: "MK-TEST-1" });
    assert.deepEqual(withKey.preCheckIn, { status: "checked_in", completedGuests: 1, totalGuests: 1, channel: "kiosk" });
    const ready = result.arrivals.find((row) => row.reservationId === "r_ready")!;
    assert.deepEqual(ready.key, { status: "pending" }, "la llave revocada no cuenta; la sesión abierta por email la emitirá");
    const handoff = result.arrivals.find((row) => row.reservationId === "r_handoff")!;
    assert.deepEqual(handoff.key, { status: "reception" }, "handed_off → tarjeta en el mostrador");
    assert.deepEqual(handoff.preCheckIn, { status: "handed_off", completedGuests: 0, totalGuests: 2, channel: "kiosk" });
  });

  it("colaborador sin modelos de check-in: ninguna clave nueva (contrato aditivo de front-desk.service.test)", async () => {
    const { dashboardDeps, calls } = fakeDb({ checkInModels: false });
    const result = await buildFrontDeskDashboard({ propertyId: PROPERTY, date: TODAY }, dashboardDeps);
    assert.ok(!("degraded" in result));
    assert.ok(!("preCheckInCompleted" in result.kpis));
    for (const row of result.arrivals) {
      assert.ok(!("preCheckIn" in row) && !("suggestedRoom" in row) && !("key" in row), row.reservationId);
    }
    assert.ok(!calls.some((c) => c.startsWith("checkInSession") || c.startsWith("assignmentSuggestion") || c.startsWith("guestPortalAction")));
  });

  it("tabla de sesiones rota: degraded la nombra, las filas quedan «sin invitar» y el resto del tablero sigue", async () => {
    const { dashboardDeps } = fakeDb({ brokenSessions: true });
    const result = await buildFrontDeskDashboard({ propertyId: PROPERTY, date: TODAY }, dashboardDeps);
    assert.deepEqual(result.degraded, ["checkin_sessions"]);
    assert.equal(result.kpis.preCheckInCompleted, 0);
    assert.equal(result.arrivals.length, 5);
    for (const row of result.arrivals) assert.equal(row.preCheckIn?.status, "not_invited", row.reservationId);
    assert.deepEqual(result.arrivals.find((row) => row.reservationId === "r_key")!.key, { status: "issued", serialNumber: "MK-TEST-1" });
    assert.equal(result.arrivals.find((row) => row.reservationId === "r_sugg")!.suggestedRoom?.number, "204");
  });
});

// ---------------------------------------------------------------- Cola de acciones

describe("front-desk-queue.service.ts · kinds de check-in (W3-D)", () => {
  it("cola: unassigned_arrival con sugerencia → confirm_assignment con la 1.ª candidata y sus 2 primeros motivos", async () => {
    const { queueDeps } = fakeDb();
    const result = await buildFrontDeskQueue({ propertyId: PROPERTY, now: NOW }, queueDeps);
    const item = byId(result.items, "unassigned_r_sugg");
    assert.equal(item.kind, "unassigned_arrival");
    assert.equal(item.priority, "urgent");
    assert.equal(item.recommendation, "El motor propone la 204: Inspeccionada esta mañana · Planta alta como pidió (confianza 80 %). ¿Confirmar?");
    assert.deepEqual(item.primaryAction, {
      label: "Confirmar 204",
      kind: "confirm_assignment",
      payload: { suggestionId: "as_sugg", roomId: "room_204", roomNumber: "204", reservationId: "r_sugg" }
    });
    assert.deepEqual(
      item.secondaryActions?.map((action) => [action.kind, action.payload?.roomNumber ?? action.label]),
      [
        ["confirm_assignment", "205"],
        ["confirm_assignment", "206"],
        ["open_room_rack", "Ver room rack"]
      ]
    );
    // L-22: la 204 ya está propuesta; la llegada sin sugerencia recibe la siguiente limpia del tipo.
    const plain = byId(result.items, "unassigned_r_plain");
    assert.equal(plain.primaryAction?.kind, "assign_room");
    assert.equal(plain.primaryAction?.payload?.roomNumber, "205");
    assert.deepEqual(result.degraded, []);
  });

  it("handoff identity_review urgente con open_precheckin; kiosco y motivo en el contexto", async () => {
    const { queueDeps } = fakeDb();
    const result = await buildFrontDeskQueue({ propertyId: PROPERTY, now: NOW }, queueDeps);
    const item = byId(result.items, "identity_review_r_handoff");
    assert.equal(item.kind, "identity_review");
    assert.equal(item.priority, "urgent");
    assert.equal(item.title, "Revisar identidad · Derivada Prueba");
    assert.equal(item.context, "Derivado desde el kiosco · Hab. 120 · MRZ con dígitos de control fallidos.");
    assert.deepEqual(item.primaryAction, { label: "Abrir pre-check-in", kind: "open_precheckin", payload: { reservationId: "r_handoff" } });
    assert.equal(result.items.indexOf(item) < result.items.findIndex((i) => i.priority === "today"), true, "los urgentes van antes que los de hoy");
    // El detector previo de habitación lista sigue vivo para esa reserva (problema distinto).
    assert.equal(byId(result.items, "checkin_ready_r_handoff").kind, "checkin_ready");
  });

  it("precheckin_ready sustituye a checkin_ready para esa reserva y lleva start_checkin", async () => {
    const { queueDeps } = fakeDb();
    const result = await buildFrontDeskQueue({ propertyId: PROPERTY, now: NOW }, queueDeps);
    const item = byId(result.items, "precheckin_ready_r_ready");
    assert.equal(item.priority, "today");
    assert.equal(item.context, "2/2 viajeros con datos y firma · llegada declarada 17:30 · Hab. 101.");
    assert.equal(item.primaryAction?.kind, "start_checkin");
    assert.deepEqual(item.secondaryActions, [{ label: "Ver pre-check-in", kind: "open_precheckin", payload: { reservationId: "r_ready" } }]);
    assert.equal(result.items.find((i) => i.id === "checkin_ready_r_ready"), undefined, "sin duplicar «Hacer check-in»");
  });

  it("self_checkin_done (kiosco, últimas 12 h), ses_rejected (hoy, un ítem por reserva) y assignment_suggested (mañana)", async () => {
    const { queueDeps } = fakeDb();
    const result = await buildFrontDeskQueue({ propertyId: PROPERTY, now: NOW }, queueDeps);
    const self = byId(result.items, "self_checkin_r_key");
    assert.equal(self.kind, "self_checkin_done");
    assert.equal(self.title, "Check-in autónomo completado · Hab. 310");
    assert.equal(self.context, "Llave Prueba hizo el check-in en el kiosco hace 30 min.");
    assert.equal(self.primaryAction?.kind, "open_reservation");

    const ses = byId(result.items, "ses_rejected_r_ses");
    assert.equal(ses.priority, "today");
    assert.equal(ses.context, "2 envíos rechazados hoy · código 10130, 10131 · Hab. 330.");
    assert.deepEqual(ses.primaryAction, { label: "Abrir reserva", kind: "open_reservation", payload: { reservationId: "r_ses" } });

    const tomorrow = byId(result.items, "assignment_suggested_r_tomorrow");
    assert.equal(tomorrow.title, "Asignación sugerida · TST-TOM");
    assert.equal(tomorrow.context, "Llega mañana · ETA 14:00. El motor propone la 206: Limpia (confianza 50 %).");
    assert.equal(tomorrow.primaryAction?.kind, "confirm_assignment");
    assert.equal(tomorrow.primaryAction?.payload?.suggestionId, "as_tom");

    assert.equal(result.counts.self_checkin_done, 1);
    assert.equal(result.counts.ses_rejected, 1);
    assert.equal(result.counts.assignment_suggested, 1);
    assert.equal(result.counts.identity_review, 1);
    assert.equal(result.counts.precheckin_ready, 1);
    assert.equal(result.counts.unassigned_arrival, 2);
    assert.equal(result.summary.total, result.items.length);
  });

  it("sin sesiones no cambia la cola actual: mismos ítems y acciones que antes de la tanda", async () => {
    const { queueDeps } = fakeDb({ emptyCheckIn: true });
    const result = await buildFrontDeskQueue({ propertyId: PROPERTY, now: NOW }, queueDeps);
    assert.deepEqual(
      result.items.map((item) => [item.id, item.kind, item.priority, item.primaryAction?.kind, item.primaryAction?.payload?.roomNumber]),
      [
        ["unassigned_r_sugg", "unassigned_arrival", "urgent", "assign_room", "204"],
        ["unassigned_r_plain", "unassigned_arrival", "urgent", "assign_room", "205"],
        ["checkin_ready_r_ready", "checkin_ready", "today", "start_checkin", undefined],
        ["checkin_ready_r_handoff", "checkin_ready", "today", "start_checkin", undefined]
      ]
    );
    for (const kind of NEW_KINDS) assert.equal(result.counts[kind], 0, kind);
    assert.ok(!result.items.some((item) => [item.primaryAction, ...(item.secondaryActions ?? [])].some((a) => a && (a.kind === "confirm_assignment" || a.kind === "open_precheckin"))));
    assert.deepEqual(result.degraded, []);
  });

  it("counts cubre todos los kinds (los 12 previos en su orden + los 8 nuevos) y una tabla rota va a degraded", async () => {
    const { queueDeps } = fakeDb({ brokenSessions: true });
    const result = await buildFrontDeskQueue({ propertyId: PROPERTY, now: NOW }, queueDeps);
    assert.deepEqual(Object.keys(result.counts), [...FRONT_DESK_QUEUE_KINDS]);
    assert.deepEqual(FRONT_DESK_QUEUE_KINDS.slice(0, 12), [
      "overbooking", "no_show_risk", "late_checkout_overdue", "incident_open", "unassigned_arrival", "checkin_blocked",
      "housekeeping_late", "open_balance", "checkout_pending", "checkin_ready", "vip_arriving", "repeat_arriving"
    ]);
    assert.deepEqual([...FRONT_DESK_QUEUE_KINDS.slice(12)].sort(), [...NEW_KINDS].sort());
    assert.deepEqual(result.degraded, ["checkin_sessions"]);
    // Sin sesiones no hay precheckin/handoff/self, pero la sugerencia y el SES siguen.
    assert.equal(result.counts.precheckin_ready, 0);
    assert.equal(result.counts.identity_review, 0);
    assert.equal(byId(result.items, "unassigned_r_sugg").primaryAction?.kind, "confirm_assignment");
    assert.equal(result.counts.ses_rejected, 1);
    assert.equal(byId(result.items, "checkin_ready_r_ready").kind, "checkin_ready");
  });
});
