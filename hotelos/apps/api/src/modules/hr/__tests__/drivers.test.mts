// Unit tests · Tanda RRHH · RRHH-3 — drivers de la previsión (hr/drivers.service.ts,
// función pura buildLaborDrivers con filas sintéticas). Sin base de datos. Reglas:
// pasado = realizado; futuro = OTB fusionado con la previsión top-level; NUNCA
// deterministic-v1 sin OTB; llegadas/salidas = rooms / LOS medio de los 28 días reales;
// cubiertos por régimen (boardType × pax). Desde apps/api:
//   node --import tsx --test src/modules/hr/__tests__/drivers.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RealizedDay } from "../../revenue/actuals.js";
import { averageLosOf, boardMealsOf, buildLaborDrivers, forecastKindOf, paxPerRoomOf, reservationRatios, type DriverForecastRow, type DriverReservationRow } from "../drivers.service.js";

const TODAY = "2026-09-20";
const PROP = "prop_hr_test";

function realized(date: string, rooms: number, arrivals: number, departures: number, pax: number): RealizedDay {
  return { date, source: "snapshot", rooms, paidRooms: rooms, houseUseRooms: 0, roomRevenue: rooms * 100, totalRevenue: rooms * 100, arrivals, departures, noShows: 0, ooo: 0, pax, occPct: rooms, adr: 100, revpar: null, goppar: null };
}

function losWindow(days = 28, rooms = 50, arrivals = 25, pax = 100): Map<string, RealizedDay> {
  const map = new Map<string, RealizedDay>();
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.UTC(2026, 8, 20 - i));
    const key = d.toISOString().slice(0, 10);
    map.set(key, realized(key, rooms, arrivals, arrivals, pax));
  }
  return map;
}

function res(arrival: string, departure: string, over: Partial<DriverReservationRow> = {}): DriverReservationRow {
  return { arrivalDate: new Date(`${arrival}T00:00:00.000Z`), departureDate: new Date(`${departure}T00:00:00.000Z`), roomsCount: 1, totalAmount: 100 as unknown as DriverReservationRow["totalAmount"], createdAt: new Date("2026-09-01T00:00:00.000Z"), adults: 2, children: 0, boardType: "BB", status: "confirmed", ...over };
}

function fc(date: string, rooms: number, modelVersion: string | null, topLevel = true): DriverForecastRow {
  return { forecastDate: new Date(`${date}T00:00:00.000Z`), roomTypeId: topLevel ? null : "rt_1", ratePlanId: null, channelId: null, segment: null, expectedRoomsSold: rooms, modelVersion };
}

describe("drivers · helpers puros", () => {
  it("boardMealsOf: RO 0 · BB 1 · HB 2 · FB 3 · AI 3 (desayuno + restaurante); desconocido → null", () => {
    assert.deepEqual(boardMealsOf("RO"), { breakfast: 0, restaurant: 0 });
    assert.deepEqual(boardMealsOf("bb"), { breakfast: 1, restaurant: 0 });
    assert.deepEqual(boardMealsOf("HB"), { breakfast: 1, restaurant: 1 });
    assert.deepEqual(boardMealsOf("FB"), { breakfast: 1, restaurant: 2 });
    assert.deepEqual(boardMealsOf("AI"), { breakfast: 1, restaurant: 2 });
    assert.equal(boardMealsOf(null), null);
    assert.equal(boardMealsOf("XX"), null);
  });

  it("forecastKindOf: pms_import:* → pms_forecast; deterministic-v1 o null → deterministic", () => {
    assert.equal(forecastKindOf("pms_import:opera_hf_2026-09-14"), "pms_forecast");
    assert.equal(forecastKindOf("deterministic-v1"), "deterministic");
    assert.equal(forecastKindOf(null), "deterministic");
  });

  it("LOS medio = Σ ocupadas / Σ llegadas de los 28 días reales; pax por habitación = Σ pax / Σ ocupadas; sin llegadas → null", () => {
    const win = losWindow();
    assert.equal(averageLosOf(win.values()), 2);
    assert.equal(paxPerRoomOf(win.values()), 2);
    assert.equal(averageLosOf(losWindow(28, 50, 0, 100).values()), null);
    assert.equal(paxPerRoomOf(losWindow(28, 0, 0, 0).values()), null);
    assert.equal(averageLosOf([]), null);
  });

  it("reservationRatios: LOS y pax/habitación de las reservas OTB (las canceladas no cuentan)", () => {
    const ratios = reservationRatios([res("2026-09-21", "2026-09-23", { roomsCount: 3 }), res("2026-09-22", "2026-09-23"), res("2026-09-22", "2026-09-25", { status: "cancelled" })]);
    assert.equal(ratios.los, 7 / 4);
    // Pax por noche de reserva (2 + 2 + 2 + …): A aporta 2 pax × 2 noches, B 2 pax × 1 noche → 6 / 7 noches-habitación.
    assert.equal(ratios.paxPerRoom, 6 / 7);
    assert.deepEqual(reservationRatios([]), { los: null, paxPerRoom: null });
  });
});

describe("drivers · buildLaborDrivers (ventana 2026-09-18 → 2026-09-24, hoy 2026-09-20)", () => {
  const realizedDays = new Map<string, RealizedDay>([
    ["2026-09-18", realized("2026-09-18", 40, 20, 18, 80)],
    ["2026-09-19", realized("2026-09-19", 45, 22, 21, 90)]
  ]);
  const reservations: DriverReservationRow[] = [
    // Pasado: salida hecha con régimen BB (cubiertos de los días 18 y 19).
    res("2026-09-18", "2026-09-20", { status: "checked_out", roomsCount: 2, adults: 2 }),
    // OTB: A 21→23 (3 hab. BB), B 22→23 (1 hab. HB), C cancelada (no cuenta), D 20→21 sin régimen.
    res("2026-09-21", "2026-09-23", { roomsCount: 3, adults: 2 }),
    res("2026-09-22", "2026-09-23", { boardType: "HB", adults: 2 }),
    res("2026-09-21", "2026-09-25", { status: "cancelled", roomsCount: 9 }),
    res("2026-09-20", "2026-09-21", { boardType: null, adults: 1 })
  ];
  const forecasts: DriverForecastRow[] = [
    fc("2026-09-21", 10, "pms_import:opera_hf_2026-09-14"),
    fc("2026-09-22", 6, "deterministic-v1"),
    fc("2026-09-23", 8, "deterministic-v1")
  ];
  const window = buildLaborDrivers({ propertyId: PROP, from: "2026-09-18", to: "2026-09-24", today: TODAY, roomsInventory: 92, realized: realizedDays, losWindow: losWindow(), reservations, forecasts });
  const day = (date: string) => window.days.find((d) => d.date === date)!;

  it("7 días en orden, inventario constante, LOS 2,0 y pax/hab. 2,0 desde los 28 días reales", () => {
    assert.deepEqual(window.days.map((d) => d.date), ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]);
    assert.ok(window.days.every((d) => d.roomsInventory === 92));
    assert.equal(window.averageLos, 2);
    assert.equal(window.losSource, "realized");
    assert.equal(window.paxPerRoom, 2);
  });

  it("pasado = realizado (source actual) con cubiertos por el régimen de las reservas del día", () => {
    const d18 = day("2026-09-18");
    assert.equal(d18.source, "actual");
    assert.deepEqual([d18.rooms, d18.arrivals, d18.departures, d18.pax], [40, 20, 18, 80]);
    assert.equal(d18.coversBreakfast, 80);
    assert.equal(d18.coversRestaurant, 0);
    assert.deepEqual(d18.degraded, []);
  });

  it("hoy sin OTB ni previsión (la reserva sin régimen ya no está viva… sí: D 20→21 confirmada cuenta como OTB de 1 hab.)", () => {
    const d20 = day("2026-09-20");
    assert.equal(d20.source, "otb");
    assert.equal(d20.rooms, 1);
    assert.equal(d20.arrivals, 0.5);
    assert.equal(d20.pax, 2);
    // Sin régimen conocido ese día: mezcla de la ventana (10 pax conocidos: 8 BB + 2 HB → todos desayunan, 2/10 cenan).
    assert.equal(d20.coversBreakfast, 2);
    assert.equal(d20.coversRestaurant, 0.4);
  });

  it("previsión top-level del PMS por encima del OTB → rooms = previsión, source pms_forecast, llegadas = rooms / LOS", () => {
    const d21 = day("2026-09-21");
    assert.equal(d21.source, "pms_forecast");
    assert.equal(d21.rooms, 10);
    assert.equal(d21.arrivals, 5);
    assert.equal(d21.departures, 5);
    assert.equal(d21.pax, 20);
    assert.equal(d21.coversBreakfast, 20);
    assert.equal(d21.coversRestaurant, 0);
    assert.deepEqual(d21.degraded, []);
  });

  it("deterministic-v1 CON OTB corroborante → se usa (source deterministic) y los cubiertos siguen la mezcla BB/HB del día", () => {
    const d22 = day("2026-09-22");
    assert.equal(d22.source, "deterministic");
    assert.equal(d22.rooms, 6);
    assert.equal(d22.pax, 12);
    // Mezcla del día: 2 pax BB (reserva A) + 2 pax HB (reserva B) → desayunos 4/4, restaurante 2/4.
    assert.equal(d22.coversBreakfast, 12);
    assert.equal(d22.coversRestaurant, 6);
  });

  it("deterministic-v1 SIN OTB → nunca es driver: rooms null, source null, motivo deterministic_without_otb (fila degradada)", () => {
    const d23 = day("2026-09-23");
    assert.equal(d23.rooms, null);
    assert.equal(d23.source, null);
    assert.equal(d23.arrivals, null);
    assert.equal(d23.pax, null);
    assert.equal(d23.coversBreakfast, null);
    assert.deepEqual(d23.degraded, ["deterministic_without_otb"]);
  });

  it("día sin OTB ni previsión → no_otb_no_forecast y entrada en degraded[] con la fecha", () => {
    const d24 = day("2026-09-24");
    assert.equal(d24.rooms, null);
    assert.deepEqual(d24.degraded, ["no_otb_no_forecast"]);
    const entries = window.degraded.filter((e) => e.code === "HR_DRIVERS_DEGRADED");
    assert.deepEqual(entries.map((e) => e.date), ["2026-09-23", "2026-09-24"]);
    assert.ok(entries.every((e) => e.propertyId === PROP));
  });

  it("OTB por encima de la previsión → rooms = OTB y source otb (la previsión nunca rebaja lo reservado)", () => {
    const w = buildLaborDrivers({ propertyId: PROP, from: "2026-09-21", to: "2026-09-21", today: TODAY, roomsInventory: 92, realized: new Map(), losWindow: losWindow(), reservations: [res("2026-09-21", "2026-09-22", { roomsCount: 12 })], forecasts: [fc("2026-09-21", 10, "pms_import:x")] });
    assert.equal(w.days[0]!.rooms, 12);
    assert.equal(w.days[0]!.source, "otb");
  });

  it("filas por tipo se agregan solo cuando no hay ninguna top-level (regla hf-board)", () => {
    const byType = buildLaborDrivers({ propertyId: PROP, from: "2026-09-21", to: "2026-09-21", today: TODAY, roomsInventory: 92, realized: new Map(), losWindow: losWindow(), reservations: [res("2026-09-21", "2026-09-22")], forecasts: [fc("2026-09-21", 4, "pms_import:x", false), fc("2026-09-21", 5, "pms_import:x", false)] });
    assert.equal(byType.days[0]!.rooms, 9);
    const mixed = buildLaborDrivers({ propertyId: PROP, from: "2026-09-21", to: "2026-09-21", today: TODAY, roomsInventory: 92, realized: new Map(), losWindow: losWindow(), reservations: [res("2026-09-21", "2026-09-22")], forecasts: [fc("2026-09-21", 4, "pms_import:x", false), fc("2026-09-21", 7, "pms_import:x", true)] });
    assert.equal(mixed.days[0]!.rooms, 7);
  });
});

describe("drivers · pasado sin cierre ni estancias (corrector RRHH · RF-04)", () => {
  it("un día pasado con fallback por reservas a 0 habitaciones NO es un realizado: rooms null, source null y motivo no_realized_data (fila degradada); con estancias reales sí es actual; sin fila, actual_missing", () => {
    const empty: RealizedDay = { ...realized("2026-09-18", 0, 0, 0, 0), source: "reservations" };
    const fromStays: RealizedDay = { ...realized("2026-09-19", 3, 1, 1, 6), source: "reservations" };
    const window = buildLaborDrivers({ propertyId: PROP, from: "2026-09-17", to: "2026-09-19", today: TODAY, roomsInventory: 92, realized: new Map([["2026-09-18", empty], ["2026-09-19", fromStays]]), losWindow: new Map(), reservations: [], forecasts: [] });
    const d17 = window.days.find((d) => d.date === "2026-09-17")!;
    const d18 = window.days.find((d) => d.date === "2026-09-18")!;
    const d19 = window.days.find((d) => d.date === "2026-09-19")!;
    assert.deepEqual([d18.rooms, d18.arrivals, d18.departures, d18.pax, d18.source], [null, null, null, null, null], "un 0 inventado nunca es dato");
    assert.deepEqual(d18.degraded, ["no_realized_data"]);
    assert.ok(window.degraded.some((entry) => entry.code === "HR_DRIVERS_DEGRADED" && entry.date === "2026-09-18" && /no_realized_data/.test(entry.message)));
    assert.deepEqual(d17.degraded, ["actual_missing"]);
    assert.equal(d19.source, "actual");
    assert.equal(d19.rooms, 3);
    // Un cierre auditado a 0 habitaciones (hotel cerrado ese día) sí es un dato real.
    const closed = buildLaborDrivers({ propertyId: PROP, from: "2026-09-18", to: "2026-09-18", today: TODAY, roomsInventory: 92, realized: new Map([["2026-09-18", realized("2026-09-18", 0, 0, 0, 0)]]), losWindow: new Map(), reservations: [], forecasts: [] });
    assert.equal(closed.days[0]!.source, "actual");
    assert.equal(closed.days[0]!.rooms, 0);
  });
});

describe("drivers · sin histórico (LOS) y sin régimen", () => {
  it("sin 28 días reales, el LOS sale de las reservas OTB (losSource otb); sin nada → llegadas null y aviso HR_DRIVERS_LOS_UNKNOWN", () => {
    const withOtb = buildLaborDrivers({ propertyId: PROP, from: "2026-09-21", to: "2026-09-22", today: TODAY, roomsInventory: 10, realized: new Map(), losWindow: new Map(), reservations: [res("2026-09-21", "2026-09-23", { roomsCount: 2 })], forecasts: [] });
    assert.equal(withOtb.losSource, "otb");
    assert.equal(withOtb.averageLos, 2);
    assert.equal(withOtb.days[0]!.arrivals, 1);
    assert.equal(withOtb.degraded.filter((e) => e.code === "HR_DRIVERS_LOS_UNKNOWN").length, 0);

    const nothing = buildLaborDrivers({ propertyId: PROP, from: "2026-09-21", to: "2026-09-21", today: TODAY, roomsInventory: 10, realized: new Map(), losWindow: new Map(), reservations: [], forecasts: [fc("2026-09-21", 5, "pms_import:x")] });
    assert.equal(nothing.losSource, null);
    assert.equal(nothing.days[0]!.rooms, 5);
    assert.equal(nothing.days[0]!.arrivals, null);
    assert.equal(nothing.days[0]!.pax, null);
    assert.deepEqual(nothing.days[0]!.degraded, ["los_unknown", "pax_unknown"]);
    assert.equal(nothing.degraded.filter((e) => e.code === "HR_DRIVERS_LOS_UNKNOWN").length, 1);
  });

  it("pax conocidos sin ningún régimen en la ventana → cubiertos null (covers_unknown); pax 0 → cubiertos 0", () => {
    const noBoard = buildLaborDrivers({ propertyId: PROP, from: "2026-09-21", to: "2026-09-21", today: TODAY, roomsInventory: 10, realized: new Map(), losWindow: losWindow(), reservations: [res("2026-09-21", "2026-09-22", { boardType: null })], forecasts: [] });
    assert.equal(noBoard.days[0]!.pax, 2);
    assert.equal(noBoard.days[0]!.coversBreakfast, null);
    assert.deepEqual(noBoard.days[0]!.degraded, ["covers_unknown"]);
    const zeroPax = buildLaborDrivers({ propertyId: PROP, from: "2026-09-18", to: "2026-09-18", today: TODAY, roomsInventory: 10, realized: new Map([["2026-09-18", realized("2026-09-18", 0, 0, 0, 0)]]), losWindow: losWindow(), reservations: [], forecasts: [] });
    assert.equal(zeroPax.days[0]!.coversBreakfast, 0);
    assert.equal(zeroPax.days[0]!.source, "actual");
  });
});
