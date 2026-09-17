// Unit tests · Tanda 7 · L2 — planificador de disponibilidad (regla de rango del
// PMS sobre BD + filas anteriores del fichero, tabla tipo × noche informativa).
// Sin base de datos ni datos personales. Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-availability.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nightsOf, planAvailability, staysOverlap, type AvailabilityInventory, type AvailabilityPlanRow } from "../reservation-import.availability.js";

const DBL: AvailabilityInventory = { roomTypeId: "rt_dbl", code: "DBL", name: "Doble", totalRooms: 2 };
const IND: AvailabilityInventory = { roomTypeId: "rt_ind", code: "IND", name: "Individual", totalRooms: 1 };

function row(rowNumber: number, from: string, to: string, extra: Partial<AvailabilityPlanRow> = {}): AvailabilityPlanRow {
  return { rowNumber, roomTypeId: "rt_dbl", arrivalDate: from, departureDate: to, roomsCount: 1, estado: "confirmada", historical: false, ...extra };
}

describe("utilidades", () => {
  it("staysOverlap replica la regla del PMS (arrival < departure y departure > arrival): las estancias contiguas no solapan", () => {
    assert.equal(staysOverlap("2026-10-01", "2026-10-02", "2026-10-02", "2026-10-03"), false);
    assert.equal(staysOverlap("2026-10-01", "2026-10-03", "2026-10-02", "2026-10-04"), true);
    assert.equal(staysOverlap("2026-10-01", "2026-10-04", "2026-10-02", "2026-10-03"), true);
  });

  it("nightsOf: noches desde la llegada hasta la víspera de la salida; vacío si no hay noches", () => {
    assert.deepEqual(nightsOf("2026-10-01", "2026-10-04"), ["2026-10-01", "2026-10-02", "2026-10-03"]);
    assert.deepEqual(nightsOf("2026-10-04", "2026-10-04"), []);
    assert.deepEqual(nightsOf("2026-10-05", "2026-10-04"), []);
  });
});

describe("planAvailability · regla de rango", () => {
  it("ejemplo verificado: 2 habitaciones, A 1→2, B 3→4, C 1→4 → C excede aunque cabe por noche; rangeRuleRows incluye C", () => {
    const plan = planAvailability({
      rows: [row(1, "2026-10-01", "2026-10-02"), row(2, "2026-10-03", "2026-10-04"), row(3, "2026-10-01", "2026-10-04")],
      inventory: [DBL],
      existing: []
    });
    assert.deepEqual(plan.perRow.get(1), { totalRooms: 2, bookedDb: 0, bookedFile: 0, exceeds: false });
    assert.deepEqual(plan.perRow.get(2), { totalRooms: 2, bookedDb: 0, bookedFile: 0, exceeds: false }, "B no solapa con A");
    assert.deepEqual(plan.perRow.get(3), { totalRooms: 2, bookedDb: 0, bookedFile: 2, exceeds: true }, "C solapa con A y con B: 2 + 1 > 2");
    assert.deepEqual(plan.rejectedRows, [3]);
    assert.deepEqual(plan.overbookingRows, []);
    assert.equal(plan.byRoomType.length, 1);
    const dbl = plan.byRoomType[0]!;
    assert.equal(dbl.code, "DBL");
    assert.equal(dbl.totalRooms, 2);
    assert.equal(dbl.rowsRequested, 3);
    assert.equal(dbl.peakBookedDb, 0);
    assert.equal(dbl.peakBookedFile, 2);
    assert.deepEqual(dbl.rangeRuleRows, [3], "C cabría noche a noche (máximo 2 por noche)");
    assert.deepEqual(dbl.nightsExceeded, [], "sin C no se supera el cupo ninguna noche");
  });

  it("las filas del fichero se descuentan entre sí con roomsCount y las reservas de la BD cuentan como bookedDb", () => {
    const plan = planAvailability({
      rows: [row(1, "2026-10-10", "2026-10-12", { roomsCount: 2 }), row(2, "2026-10-11", "2026-10-13"), row(3, "2026-10-12", "2026-10-13")],
      inventory: [{ ...DBL, totalRooms: 3 }],
      existing: [{ roomTypeId: "rt_dbl", arrivalDate: "2026-10-09", departureDate: "2026-10-11", roomsCount: 1 }]
    });
    assert.deepEqual(plan.perRow.get(1), { totalRooms: 3, bookedDb: 1, bookedFile: 0, exceeds: false });
    assert.deepEqual(plan.perRow.get(2), { totalRooms: 3, bookedDb: 0, bookedFile: 2, exceeds: false }, "la BD (9→11) no solapa 11→13; la fila 1 aporta 2 unidades");
    assert.deepEqual(plan.perRow.get(3), { totalRooms: 3, bookedDb: 0, bookedFile: 1, exceeds: false }, "solo la fila 2 solapa 12→13");
    assert.deepEqual(plan.rejectedRows, []);
    assert.equal(plan.byRoomType[0]?.rowsRequested, 4);
    assert.equal(plan.byRoomType[0]?.peakBookedDb, 1);
    assert.equal(plan.byRoomType[0]?.peakBookedFile, 2);
  });

  it("una fila cancelada se comprueba pero no cuenta para las siguientes", () => {
    const plan = planAvailability({
      rows: [row(1, "2026-10-01", "2026-10-03", { estado: "cancelada" }), row(2, "2026-10-01", "2026-10-03"), row(3, "2026-10-01", "2026-10-03")],
      inventory: [DBL],
      existing: []
    });
    assert.equal(plan.perRow.get(1)?.exceeds, false);
    assert.deepEqual(plan.perRow.get(2), { totalRooms: 2, bookedDb: 0, bookedFile: 0, exceeds: false }, "la cancelada no cuenta");
    assert.deepEqual(plan.perRow.get(3), { totalRooms: 2, bookedDb: 0, bookedFile: 1, exceeds: false });
    assert.deepEqual(plan.rejectedRows, []);
    const cancelledFirst = planAvailability({ rows: [row(1, "2026-10-01", "2026-10-03"), row(2, "2026-10-01", "2026-10-03"), row(3, "2026-10-01", "2026-10-03", { estado: "cancelada" })], inventory: [DBL], existing: [] });
    assert.equal(cancelledFirst.perRow.get(3)?.exceeds, true, "una cancelada también se comprueba contra el cupo (se crea y se cancela en el commit)");
  });

  it("una fila tentativa cuenta (se crea confirmada) y una rechazada no cuenta para las siguientes", () => {
    const plan = planAvailability({
      rows: [row(1, "2026-10-01", "2026-10-03", { estado: "tentativa" }), row(2, "2026-10-01", "2026-10-03"), row(3, "2026-10-01", "2026-10-03"), row(4, "2026-10-02", "2026-10-03")],
      inventory: [DBL],
      existing: []
    });
    assert.equal(plan.perRow.get(3)?.exceeds, true, "tercera unidad con cupo 2");
    assert.deepEqual(plan.perRow.get(4), { totalRooms: 2, bookedDb: 0, bookedFile: 2, exceeds: true }, "la fila 3 rechazada no suma: 2 (filas 1 y 2) + 1 > 2");
    assert.deepEqual(plan.rejectedRows, [3, 4]);
  });

  it("las filas históricas quedan fuera del planificador", () => {
    const plan = planAvailability({
      rows: [row(1, "2026-01-01", "2026-01-05", { historical: true }), row(2, "2026-01-02", "2026-01-03", { historical: true, roomTypeId: "rt_ind" })],
      inventory: [DBL, IND],
      existing: [{ roomTypeId: "rt_dbl", arrivalDate: "2026-01-01", departureDate: "2026-01-05", roomsCount: 2 }]
    });
    assert.equal(plan.perRow.size, 0);
    assert.deepEqual(plan.byRoomType, []);
    assert.deepEqual(plan.rejectedRows, []);
    assert.deepEqual(plan.overbookingRows, []);
  });

  it("permitirOverbooking: la fila que excede se acepta con aviso, sigue contando y aparece en overbookingRows", () => {
    const plan = planAvailability({
      rows: [row(1, "2026-10-01", "2026-10-02"), row(2, "2026-10-03", "2026-10-04"), row(3, "2026-10-01", "2026-10-04"), row(4, "2026-10-01", "2026-10-02")],
      inventory: [DBL],
      existing: [],
      permitirOverbooking: true
    });
    assert.equal(plan.perRow.get(3)?.exceeds, true);
    assert.deepEqual(plan.rejectedRows, []);
    assert.deepEqual(plan.overbookingRows, [3, 4]);
    assert.deepEqual(plan.perRow.get(4), { totalRooms: 2, bookedDb: 0, bookedFile: 2, exceeds: true }, "C aceptada por overbooking cuenta para la fila 4");
    assert.deepEqual(plan.byRoomType[0]?.rangeRuleRows, [3], "C sigue siendo un caso de regla de rango; la fila 4 no cabe ni por noche");
    assert.deepEqual(plan.byRoomType[0]?.nightsExceeded, ["2026-10-01"], "noche 1: A + C + fila 4 = 3 > 2");
  });

  it("nightsExceeded lista las noches en las que la suma por noche (BD + fichero aceptado) supera el cupo", () => {
    const plan = planAvailability({
      rows: [row(1, "2026-10-01", "2026-10-03", { roomsCount: 2 }), row(2, "2026-10-02", "2026-10-03")],
      inventory: [DBL],
      existing: [],
      permitirOverbooking: true
    });
    assert.deepEqual(plan.overbookingRows, [2]);
    assert.deepEqual(plan.byRoomType[0]?.nightsExceeded, ["2026-10-02"]);
    assert.deepEqual(plan.byRoomType[0]?.rangeRuleRows, [], "la fila 2 no cabe ni por noche: no es un caso de regla de rango");
    const preexisting = planAvailability({
      rows: [row(1, "2026-10-05", "2026-10-06")],
      inventory: [DBL],
      existing: [{ roomTypeId: "rt_dbl", arrivalDate: "2026-10-05", departureDate: "2026-10-06", roomsCount: 3 }]
    });
    assert.equal(preexisting.perRow.get(1)?.exceeds, true);
    assert.deepEqual(preexisting.byRoomType[0]?.nightsExceeded, ["2026-10-05"], "la BD ya supera el cupo esa noche aunque la fila se rechace");
  });

  it("varios tipos: cada uno con su cupo, ordenados por código; tipo sin inventario → cupo 0", () => {
    const plan = planAvailability({
      rows: [row(1, "2026-10-01", "2026-10-02", { roomTypeId: "rt_ind" }), row(2, "2026-10-01", "2026-10-02", { roomTypeId: "rt_ind" }), row(3, "2026-10-01", "2026-10-02"), row(4, "2026-10-01", "2026-10-02", { roomTypeId: "rt_zzz" })],
      inventory: [DBL, IND],
      existing: []
    });
    assert.deepEqual(plan.byRoomType.map((type) => type.code), ["DBL", "IND", "rt_zzz"]);
    assert.equal(plan.perRow.get(2)?.exceeds, true, "IND tiene 1 habitación");
    assert.deepEqual(plan.perRow.get(4), { totalRooms: 0, bookedDb: 0, bookedFile: 0, exceeds: true });
    assert.deepEqual(plan.rejectedRows, [2, 4]);
  });
});
