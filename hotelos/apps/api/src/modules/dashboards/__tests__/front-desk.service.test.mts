// Unit tests · Tanda UX-1 · lote U3 (F27) — buildFrontDeskDashboard con las
// nueve consultas en dos rondas de Promise.all (docs/design/UX-RECEPCION-FEEL.md
// §6.3). Prisma falso inyectado por `deps` (sin base de datos, sin red): el
// mismo conjunto de fixtures ficticias se sirve (a) en serie, (b) con los
// resultados llegando en orden inverso y con retardos, y el resultado debe ser
// idéntico en los tres casos y al esperado a mano; además se comprueba que las
// consultas independientes vuelan a la vez y que las filas llevan los campos
// aditivos `roomId`, `roomTypeId`, `assignedRoomId` y `vip`. Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/front-desk.service.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildFrontDeskDashboard, type FrontDeskDashboardDeps, type FrontDeskDashboardResult } from "../front-desk.service.js";

const SOURCE = readFileSync(new URL("../front-desk.service.ts", import.meta.url), "utf8");

const PROPERTY = "prop_test";
const NOW = new Date("2026-09-19T12:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Reservation = {
  id: string;
  propertyId: string;
  status: string;
  arrivalDate: Date;
  departureDate: Date;
  roomTypeId: string | null;
  assignedRoomId: string | null;
  vipFlag: boolean;
  specialRequests: string | null;
  notes: string | null;
};

const reservations: Reservation[] = [
  { id: "r_arr1", propertyId: PROPERTY, status: "confirmed", arrivalDate: day("2026-09-19"), departureDate: day("2026-09-21"), roomTypeId: "rt_dbl", assignedRoomId: null, vipFlag: true, specialRequests: "Cuna", notes: null },
  { id: "r_arr2", propertyId: PROPERTY, status: "checked_in", arrivalDate: day("2026-09-19"), departureDate: day("2026-09-20"), roomTypeId: "rt_sup", assignedRoomId: "room_101", vipFlag: false, specialRequests: null, notes: "Nota heredada" },
  { id: "r_dep1", propertyId: PROPERTY, status: "checked_in", arrivalDate: day("2026-09-17"), departureDate: day("2026-09-19"), roomTypeId: "rt_dbl", assignedRoomId: "room_204", vipFlag: false, specialRequests: null, notes: null },
  { id: "r_dep2", propertyId: PROPERTY, status: "checked_out", arrivalDate: day("2026-09-16"), departureDate: day("2026-09-19"), roomTypeId: null, assignedRoomId: "room_204", vipFlag: false, specialRequests: null, notes: null },
  { id: "r_inh1", propertyId: PROPERTY, status: "checked_in", arrivalDate: day("2026-09-18"), departureDate: day("2026-09-22"), roomTypeId: "rt_sup", assignedRoomId: "room_310", vipFlag: true, specialRequests: null, notes: "Prefiere planta alta" },
  { id: "r_cancel", propertyId: PROPERTY, status: "cancelled", arrivalDate: day("2026-09-19"), departureDate: day("2026-09-20"), roomTypeId: "rt_dbl", assignedRoomId: null, vipFlag: false, specialRequests: null, notes: null },
  { id: "r_noshow", propertyId: PROPERTY, status: "no_show", arrivalDate: day("2026-09-19"), departureDate: day("2026-09-20"), roomTypeId: "rt_dbl", assignedRoomId: null, vipFlag: false, specialRequests: null, notes: null },
  { id: "r_future", propertyId: PROPERTY, status: "confirmed", arrivalDate: day("2026-09-25"), departureDate: day("2026-09-27"), roomTypeId: "rt_dbl", assignedRoomId: null, vipFlag: false, specialRequests: null, notes: null },
  { id: "r_other_prop", propertyId: "prop_other", status: "confirmed", arrivalDate: day("2026-09-19"), departureDate: day("2026-09-20"), roomTypeId: "rt_dbl", assignedRoomId: null, vipFlag: true, specialRequests: null, notes: null }
];

const reservationGuests = [
  { reservationId: "r_arr1", guestId: "g1", isPrimary: true },
  { reservationId: "r_arr2", guestId: "g2", isPrimary: false },
  { reservationId: "r_arr2", guestId: "g3", isPrimary: true },
  { reservationId: "r_dep1", guestId: "g4", isPrimary: false },
  { reservationId: "r_inh1", guestId: "g5", isPrimary: true },
  { reservationId: "r_future", guestId: "g6", isPrimary: true }
];

const guests = [
  { id: "g1", firstName: "Ana", surname1: "Prueba", surname2: "Uno" },
  { id: "g2", firstName: "Acompañante", surname1: "Dos", surname2: null },
  { id: "g3", firstName: "Titular", surname1: "Tres", surname2: null },
  { id: "g4", firstName: "Solo", surname1: null, surname2: null },
  { id: "g5", firstName: "Vip", surname1: "Cinco", surname2: "Test" },
  { id: "g6", firstName: "Futuro", surname1: "Seis", surname2: null }
];

const rooms = [
  { id: "room_101", number: "101" },
  { id: "room_204", number: "204" },
  { id: "room_310", number: "310" },
  { id: "room_999", number: "999" }
];

const roomTypes = [
  { id: "rt_dbl", name: "Doble" },
  { id: "rt_sup", name: "Superior" }
];

const balances = new Map<string, number>([
  ["r_arr1", 120],
  ["r_arr2", 0],
  ["r_dep1", 42.5],
  ["r_dep2", -10],
  ["r_inh1", 33.25]
]);

// ---------------------------------------------------------------- Prisma falso mínimo

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const value = row[field];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as { in?: unknown[]; gte?: Date; lt?: Date; gt?: Date };
      if (c.in && !c.in.includes(value)) return false;
      if (c.gte !== undefined && !((value as Date).getTime() >= c.gte.getTime())) return false;
      if (c.lt !== undefined && !((value as Date).getTime() < c.lt.getTime())) return false;
      if (c.gt !== undefined && !((value as Date).getTime() > c.gt.getTime())) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

type Schedule = "serial" | "reverse";

/** Prisma falso: filtra por `where`, ordena por `orderBy` asc, proyecta `select`; el `schedule` decide cómo vuelven los resultados. */
function fakeDb(schedule: Schedule) {
  const log: Array<{ label: string; startedAt: number; endedAt: number }> = [];
  let active = 0;
  let maxActive = 0;
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const run = async <T>(label: string, produce: () => T): Promise<T> => {
    const index = seq;
    seq += 1;
    if (schedule === "serial") {
      // Cada consulta espera a la anterior: la referencia «secuencial».
      const next = chain.then(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const startedAt = index;
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        log.push({ label, startedAt, endedAt: seq });
        return produce();
      });
      chain = next.catch(() => undefined);
      return next;
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    // Orden inverso: la primera consulta lanzada es la última en contestar.
    await new Promise((resolve) => setTimeout(resolve, 12 - Math.min(10, index)));
    active -= 1;
    log.push({ label, startedAt: index, endedAt: seq });
    return produce();
  };
  const findMany = <T extends Record<string, unknown>>(label: string, table: T[], args: { where: Where; orderBy?: Record<string, "asc" | "desc">; select?: Record<string, boolean> }) =>
    run(label, () => {
      const rows = table.filter((row) => matches(row, args.where));
      if (args.orderBy) {
        const [field, direction] = Object.entries(args.orderBy)[0]!;
        rows.sort((a, b) => {
          const av = a[field] as Date | string;
          const bv = b[field] as Date | string;
          const cmp = av instanceof Date ? av.getTime() - (bv as Date).getTime() : String(av).localeCompare(String(bv));
          return direction === "asc" ? cmp : -cmp;
        });
      }
      return rows.map((row) => pick(row, args.select));
    });
  const db = {
    reservation: {
      findMany: (args: { where: Where; orderBy?: Record<string, "asc" | "desc"> }) => findMany("reservation.findMany", reservations as unknown as Record<string, unknown>[], args),
      count: (args: { where: Where }) => run("reservation.count", () => reservations.filter((row) => matches(row as unknown as Record<string, unknown>, args.where)).length)
    },
    reservationGuest: { findMany: (args: { where: Where; select?: Record<string, boolean> }) => findMany("reservationGuest.findMany", reservationGuests, args) },
    guest: { findMany: (args: { where: Where; select?: Record<string, boolean> }) => findMany("guest.findMany", guests as unknown as Record<string, unknown>[], args) },
    room: { findMany: (args: { where: Where; select?: Record<string, boolean> }) => findMany("room.findMany", rooms, args) },
    roomType: { findMany: (args: { where: Where; select?: Record<string, boolean> }) => findMany("roomType.findMany", roomTypes, args) }
  };
  const computeBalances = (ids: string[]) =>
    run("balances", () => {
      const out = new Map<string, number>();
      for (const id of ids) out.set(id, balances.get(id) ?? 0);
      return out;
    });
  const deps: FrontDeskDashboardDeps = { db: db as unknown as FrontDeskDashboardDeps["db"], computeBalances, now: () => NOW };
  return { deps, log, stats: () => ({ maxActive, queries: log.length }) };
}

// ---------------------------------------------------------------- esperado a mano

const EXPECTED: FrontDeskDashboardResult = {
  kpis: {
    arrivalsToday: 2,
    arrivalsCancelledToday: 2,
    departuresToday: 2,
    inHouseNow: 3,
    unassignedRooms: 1,
    overdueDepartures: 1,
    pendingBalanceEur: 195.75
  },
  arrivals: [
    { roomId: undefined, roomTypeId: "rt_dbl", assignedRoomId: null, vip: true, reservationId: "r_arr1", guestName: "Ana Prueba Uno", arrivalDate: "2026-09-19", nights: 2, roomNumber: undefined, roomTypeName: "Doble", status: "confirmed", balanceEur: 120, specialRequests: "Cuna" },
    { roomId: "room_101", roomTypeId: "rt_sup", assignedRoomId: "room_101", vip: false, reservationId: "r_arr2", guestName: "Titular Tres", arrivalDate: "2026-09-19", nights: 1, roomNumber: "101", roomTypeName: "Superior", status: "checked_in", balanceEur: 0, specialRequests: "Nota heredada" }
  ],
  departures: [
    { roomId: "room_204", roomTypeId: "rt_dbl", assignedRoomId: "room_204", vip: false, reservationId: "r_dep1", guestName: "Solo", departureDate: "2026-09-19", roomNumber: "204", balanceEur: 42.5, status: "checked_in" },
    { roomId: "room_204", roomTypeId: undefined, assignedRoomId: "room_204", vip: false, reservationId: "r_dep2", guestName: "(unknown guest)", departureDate: "2026-09-19", roomNumber: "204", balanceEur: -10, status: "checked_out" }
  ],
  inHouse: [
    // L-16: la salida de hoy sigue alojada hasta el check-out (misma definición que la lista).
    { roomId: "room_204", roomTypeId: "rt_dbl", assignedRoomId: "room_204", vip: false, reservationId: "r_dep1", guestName: "Solo", roomNumber: "204", departureDate: "2026-09-19", nightsRemaining: 0, balanceEur: 42.5, status: "checked_in" },
    { roomId: "room_101", roomTypeId: "rt_sup", assignedRoomId: "room_101", vip: false, reservationId: "r_arr2", guestName: "Titular Tres", roomNumber: "101", departureDate: "2026-09-20", nightsRemaining: 1, balanceEur: 0, status: "checked_in" },
    { roomId: "room_310", roomTypeId: "rt_sup", assignedRoomId: "room_310", vip: true, reservationId: "r_inh1", guestName: "Vip Cinco Test", roomNumber: "310", departureDate: "2026-09-22", nightsRemaining: 3, balanceEur: 33.25, status: "checked_in" }
  ],
  unassigned: [
    { roomId: undefined, roomTypeId: "rt_dbl", assignedRoomId: null, vip: true, reservationId: "r_arr1", guestName: "Ana Prueba Uno", arrivalDate: "2026-09-19", roomTypeName: "Doble", preferences: undefined }
  ]
};

describe("front-desk.service.ts · Promise.all (F27)", () => {
  it("el fuente tiene dos rondas de Promise.all y ninguna consulta Prisma secuencial suelta", () => {
    assert.equal(SOURCE.split("await Promise.all([").length - 1, 2, "dos rondas");
    assert.equal(SOURCE.split("await db.").length - 1, 2, "solo la cadena vínculos → huéspedes espera dentro de loadGuests");
    assert.doesNotMatch(SOURCE, /await prisma\./);
    assert.match(SOURCE, /const \[arrivalsRaw, arrivalsCancelledCount, departuresRaw, inHouseRaw, overdueDeparturesCount\] = await Promise\.all\(\[/);
    assert.match(SOURCE, /const \[\{ guestIdByReservation, guestById \}, rooms, roomTypes, balanceByReservation\] = await Promise\.all\(\[/);
    assert.match(SOURCE, /export type FrontDeskRowIds = \{[\s\S]*roomId\?: string;[\s\S]*roomTypeId\?: string;[\s\S]*assignedRoomId: string \| null;[\s\S]*vip: boolean;/);
  });

  it("con resultados en orden inverso y retardos el resultado es idéntico al esperado a mano", async () => {
    const { deps, stats } = fakeDb("reverse");
    const result = await buildFrontDeskDashboard({ propertyId: PROPERTY, date: "2026-09-19" }, deps);
    assert.deepEqual(result, EXPECTED);
    const { maxActive, queries } = stats();
    assert.equal(queries, 10, "5 consultas de reservas + vínculos + huéspedes + habitaciones + tipos + saldos");
    assert.ok(maxActive >= 5, `las cinco consultas de reservas vuelan a la vez (máximo simultáneo ${maxActive})`);
  });

  it("la versión secuencial (cada consulta espera a la anterior) devuelve exactamente lo mismo", async () => {
    const serial = fakeDb("serial");
    const reverse = fakeDb("reverse");
    const [a, b] = await Promise.all([
      buildFrontDeskDashboard({ propertyId: PROPERTY, date: "2026-09-19" }, serial.deps),
      buildFrontDeskDashboard({ propertyId: PROPERTY, date: "2026-09-19" }, reverse.deps)
    ]);
    assert.deepEqual(a, b);
    assert.deepEqual(a, EXPECTED);
    assert.equal(serial.stats().maxActive, 1, "la referencia secuencial nunca solapa consultas");
    assert.equal(serial.stats().queries, reverse.stats().queries);
  });

  it("la segunda ronda solapa la cadena vínculos → huéspedes con habitaciones, tipos y saldos", async () => {
    const { deps, log } = fakeDb("reverse");
    await buildFrontDeskDashboard({ propertyId: PROPERTY, date: "2026-09-19" }, deps);
    const byLabel = new Map(log.map((entry) => [entry.label, entry]));
    const links = byLabel.get("reservationGuest.findMany")!;
    const roomsQuery = byLabel.get("room.findMany")!;
    const balancesQuery = byLabel.get("balances")!;
    assert.ok(roomsQuery.startedAt < links.endedAt, "habitaciones se lanzan antes de que vuelvan los vínculos");
    assert.ok(balancesQuery.startedAt < links.endedAt, "saldos se lanzan antes de que vuelvan los vínculos");
    assert.ok(byLabel.get("guest.findMany")!.startedAt > links.startedAt, "huéspedes solo tras los vínculos");
  });

  it("las filas llevan roomId / roomTypeId / assignedRoomId / vip coherentes con la reserva", async () => {
    const { deps } = fakeDb("reverse");
    const result = await buildFrontDeskDashboard({ propertyId: PROPERTY, date: "2026-09-19" }, deps);
    for (const row of [...result.arrivals, ...result.departures, ...result.inHouse, ...result.unassigned]) {
      const source = reservations.find((r) => r.id === row.reservationId)!;
      assert.equal(row.assignedRoomId, source.assignedRoomId, row.reservationId);
      assert.equal(row.roomId, source.assignedRoomId ?? undefined, row.reservationId);
      assert.equal(row.roomTypeId, source.roomTypeId ?? undefined, row.reservationId);
      assert.equal(row.vip, source.vipFlag, row.reservationId);
      assert.equal(typeof row.vip, "boolean");
    }
    assert.deepEqual(result.arrivals.map((r) => r.vip), [true, false]);
    // L-16: la salida de hoy (r_dep1) sigue «En el hotel» hasta su check-out.
    assert.deepEqual(result.inHouse.map((r) => r.vip), [false, false, true]);
  });

  it("sin reservas: listas vacías, KPI a cero y ninguna consulta de joins ni de saldos con ids vacíos", async () => {
    const { deps, log } = fakeDb("reverse");
    const result = await buildFrontDeskDashboard({ propertyId: "prop_empty", date: "2026-09-19" }, deps);
    assert.deepEqual(result, {
      kpis: { arrivalsToday: 0, arrivalsCancelledToday: 0, departuresToday: 0, inHouseNow: 0, unassignedRooms: 0, overdueDepartures: 0, pendingBalanceEur: 0 },
      arrivals: [],
      departures: [],
      inHouse: [],
      unassigned: []
    });
    const labels = log.map((entry) => entry.label).sort();
    assert.deepEqual(labels, ["balances", "reservation.count", "reservation.count", "reservation.findMany", "reservation.findMany", "reservation.findMany"]);
  });

  it("sin `date` toma el día UTC de hoy y sin `deps` usa Prisma real (firma aditiva)", () => {
    assert.match(SOURCE, /export async function buildFrontDeskDashboard\(\s*input: FrontDeskDashboardInput,\s*deps: FrontDeskDashboardDeps = \{\}\s*\)/);
    assert.match(SOURCE, /const db = deps\.db \?\? prisma;/);
    assert.match(SOURCE, /const computeBalances = deps\.computeBalances \?\? computeBalancesForReservations;/);
  });
});
