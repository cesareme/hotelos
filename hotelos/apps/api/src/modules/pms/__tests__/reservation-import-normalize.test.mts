// Unit tests · Tanda 7 · L1 — normalización por fila contra catálogos sintéticos,
// duplicados dentro del fichero, hash de contenido y garantía GDPR (ningún mensaje
// contiene valores de la fila). Sin base de datos; huéspedes FICTICIOS. Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-normalize.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPERA_CLOUD_STATUS_MAP, RESERVATION_IMPORT_FIELDS, type ReservationImportField, type ReservationImportRowCode } from "@hotelos/shared";
import { writeXlsx } from "../../financial-statements/xlsx-writer.js";
import { applyMapping } from "../reservation-import.mapping.js";
import { parseCsvTable, parseReservationImportFile } from "../reservation-import.parser.js";
import {
  type ReservationImportCatalogs,
  normalizeRow,
  normalizeTable,
  parseImportAmount,
  parseImportCurrency,
  parseImportDate,
  parseImportEmail,
  parseImportInteger,
  parseImportPhone,
  parseImportTime,
  contentHashRowsOf,
  personalValuesOf,
  reservationImportContentHash,
  resolveRoomType,
  rowStatusFromIssues,
  splitFullName,
  stripRowValues
} from "../reservation-import.normalize.js";

const CATALOGS: ReservationImportCatalogs = {
  roomTypes: [
    { id: "rt_dbl", code: "DBL", name: "Doble estándar", maxOccupancy: 2, active: true },
    { id: "rt_ind", code: "IND", name: "Individual", maxOccupancy: 1, active: true },
    { id: "rt_jrs", code: "JRS", name: "Junior suite", maxOccupancy: 3, active: true },
    { id: "rt_old", code: "OLD", name: "Antigua", maxOccupancy: 2, active: false }
  ],
  ratePlans: [
    { id: "rp_bar", code: "BAR", name: "Best Available Rate", active: true },
    { id: "rp_bb", code: "BAR-BB", name: "BAR con desayuno", active: true },
    { id: "rp_off", code: "OLDRATE", name: "Tarifa antigua", active: false }
  ],
  rooms: [
    { id: "room_111", number: "111", roomTypeId: "rt_dbl" },
    { id: "room_411", number: "411", roomTypeId: "rt_dbl" },
    { id: "room_101", number: "101", roomTypeId: "rt_ind" }
  ],
  defaultRatePlanId: "rp_bar",
  currency: "EUR",
  businessDate: "2026-09-16", today: "2026-09-16"
};

const FIELDS: readonly ReservationImportField[] = RESERVATION_IMPORT_FIELDS;
const DEFAULTS: Partial<Record<ReservationImportField, string>> = {
  referencia_externa: "IMP-001",
  llegada: "2026-10-12",
  salida: "2026-10-15",
  tipo_habitacion: "DBL",
  tarifa: "BAR",
  adultos: "2",
  nombre: "Lucía",
  apellidos: "Ferreiro Castro",
  email: "lucia.ferreiro@example.com",
  importe_total: "312,00"
};

type Overrides = Partial<Record<ReservationImportField, string>>;

function cellsOf(overrides: Overrides): string[] {
  return FIELDS.map((field) => overrides[field] ?? DEFAULTS[field] ?? "");
}

function run(overrides: Overrides, options: { historico?: boolean; splitName?: boolean } = {}, catalogs: ReservationImportCatalogs = CATALOGS) {
  const cells = cellsOf(overrides);
  return normalizeRow({ rowNumber: 1, cells, kinds: cells.map((cell) => (cell === "" ? "empty" : "string")) }, FIELDS, catalogs, {
    historico: options.historico ?? false,
    splitName: options.splitName ?? false
  });
}

const codes = (result: { issues: Array<{ code: ReservationImportRowCode }> }): ReservationImportRowCode[] => result.issues.map((issue) => issue.code);

describe("parseImportDate · parseImportTime · números e importes", () => {
  it("12 formatos de fecha → 2026-10-12; celda de fecha Excel; serial con fromSerial", () => {
    const samples = [
      "2026-10-12",
      "2026-10-12 15:00",
      "2026-10-12T15:00:00Z",
      "2026/10/12",
      "2026.10.12",
      "12/10/2026",
      "12-10-2026",
      "12.10.2026",
      "12/10/26",
      "12/10/2026 15:00",
      "20261012",
      "12 de octubre de 2026",
      "12 oct 2026",
      "Oct 12, 2026"
    ];
    for (const sample of samples) {
      assert.deepEqual(parseImportDate(sample), { iso: "2026-10-12", fromSerial: false }, sample);
    }
    assert.deepEqual(parseImportDate("2026-10-12", "date"), { iso: "2026-10-12", fromSerial: false });
    assert.deepEqual(parseImportDate("46000"), { iso: "2025-12-09", fromSerial: true });
    assert.deepEqual(parseImportDate("46000.0"), { iso: "2025-12-09", fromSerial: true });
    assert.deepEqual(parseImportDate("1/3/26"), { iso: "2026-03-01", fromSerial: false });
  });

  it("fechas inexistentes o irreconocibles → null", () => {
    assert.equal(parseImportDate("31/02/2026"), null);
    assert.equal(parseImportDate("2026-02-30"), null);
    assert.equal(parseImportDate("2026-13-01"), null);
    assert.equal(parseImportDate("12345"), null, "serial fuera de 20000..80000");
    assert.equal(parseImportDate("mañana"), null);
    assert.equal(parseImportDate("12 de brumario de 2026"), null);
    assert.equal(parseImportDate(""), null);
    assert.equal(parseImportDate("1899-12-31"), null);
  });

  it("horas: H:MM, HH:MM, HH.MM, HH:MM:SS, 16h30, celda de hora Excel, fracción", () => {
    assert.equal(parseImportTime("9:05"), "09:05");
    assert.equal(parseImportTime("16:30"), "16:30");
    assert.equal(parseImportTime("16.30"), "16:30");
    assert.equal(parseImportTime("16:30:00"), "16:30");
    assert.equal(parseImportTime("16h30"), "16:30");
    assert.equal(parseImportTime("16h"), "16:00");
    assert.equal(parseImportTime("16:30", "time"), "16:30");
    assert.equal(parseImportTime("0.6875"), "16:30");
    assert.equal(parseImportTime("25:00"), null);
    assert.equal(parseImportTime("tarde"), null);
  });

  it("enteros, importes, moneda, e-mail, teléfono, nombre completo", () => {
    assert.equal(parseImportInteger("2"), 2);
    assert.equal(parseImportInteger("2.0"), 2);
    assert.equal(parseImportInteger("2,0"), 2);
    assert.equal(parseImportInteger("2.5"), null);
    assert.equal(parseImportInteger("dos"), null);
    assert.equal(parseImportAmount("1.234,56"), "1234.56");
    assert.equal(parseImportAmount("1,234.56"), "1234.56");
    assert.equal(parseImportAmount("312"), "312.00");
    assert.equal(parseImportAmount("€ 312"), "312.00");
    assert.equal(parseImportAmount("-5"), null);
    assert.equal(parseImportAmount("1000000"), null);
    assert.equal(parseImportAmount("abc"), null);
    assert.equal(parseImportCurrency("€"), "EUR");
    assert.equal(parseImportCurrency("euros"), "EUR");
    assert.equal(parseImportCurrency("usd"), "USD");
    assert.equal(parseImportCurrency(""), null);
    assert.equal(parseImportEmail("Lucia.Ferreiro@Example.com"), "lucia.ferreiro@example.com");
    assert.equal(parseImportEmail("lucia.ferreiro-at-example.com"), null);
    assert.equal(parseImportPhone("+34 600 111 001"), "+34600111001");
    assert.equal(parseImportPhone("600-111-001"), "600111001");
    assert.equal(parseImportPhone("12"), null);
    assert.equal(parseImportPhone("llamar por la tarde"), null);
    assert.deepEqual(splitFullName("Ferreiro Castro, Lucía"), { firstName: "Lucía", surnames: "Ferreiro Castro" });
    assert.deepEqual(splitFullName("Lucía Ferreiro Castro"), { firstName: "Lucía", surnames: "Ferreiro Castro" });
    assert.deepEqual(splitFullName("Marek"), { firstName: "Marek", surnames: "" });
  });
});

describe("normalizeRow · fechas y estancia", () => {
  it("fila válida de referencia", () => {
    const result = run({});
    assert.deepEqual(codes(result), []);
    const row = result.normalized!;
    assert.equal(row.arrivalDate, "2026-10-12");
    assert.equal(row.departureDate, "2026-10-15");
    assert.equal(row.nights, 3);
    assert.equal(row.roomTypeId, "rt_dbl");
    assert.equal(row.roomTypeCode, "DBL");
    assert.equal(row.ratePlanId, "rp_bar");
    assert.equal(row.ratePlanCode, "BAR");
    assert.equal(row.roomsCount, 1);
    assert.deepEqual([row.adults, row.children, row.infants], [2, 0, 0]);
    assert.equal(row.channel, "direct");
    assert.equal(row.sourceCode, undefined);
    assert.equal(row.estado, "confirmada");
    assert.equal(row.historical, false);
    assert.deepEqual(row.guest, { firstName: "Lucía", surname1: "Ferreiro", surname2: "Castro", email: "lucia.ferreiro@example.com" });
    assert.equal(row.totalAmount, "312.00");
    assert.equal(row.totalSource, "file");
    assert.equal(row.currency, "EUR");
    assert.equal(row.vipFlag, false);
    assert.equal(row.externalReference, "IMP-001");
    assert.deepEqual(result.resolved, {
      externalReference: "IMP-001",
      arrivalDate: "2026-10-12",
      departureDate: "2026-10-15",
      nights: 3,
      roomTypeCode: "DBL",
      ratePlanCode: "BAR",
      roomNumber: null,
      roomsCount: 1,
      estado: "confirmada",
      historical: false,
      totalAmount: "312.00",
      totalSource: "file"
    });
  });

  it("serial Excel 46000 → fecha con aviso DATE_FROM_SERIAL", () => {
    const result = run({ llegada: "46000", salida: "46003" }, {}, { ...CATALOGS, businessDate: "2025-12-01", today: "2025-12-01" });
    assert.deepEqual(codes(result), ["RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL", "RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL"]);
    assert.equal(result.normalized!.arrivalDate, "2025-12-09");
    assert.equal(result.normalized!.departureDate, "2025-12-12");
  });

  it("salida por noches; noches incoherentes; 31/02; salida ≤ llegada; noches fuera de rango; sin salida ni noches", () => {
    const byNights = run({ salida: "", noches: "3" });
    assert.deepEqual(codes(byNights), []);
    assert.equal(byNights.normalized!.departureDate, "2026-10-15");
    assert.equal(byNights.normalized!.nights, 3);

    const mismatch = run({ noches: "2" });
    assert.deepEqual(codes(mismatch), ["RESERVATION_IMPORT_ROW_NIGHTS_MISMATCH"]);
    assert.equal(mismatch.normalized, undefined);
    assert.equal(mismatch.issues[0]!.details?.nightsFromDates, 3);

    assert.deepEqual(codes(run({ llegada: "31/02/2026" })), ["RESERVATION_IMPORT_ROW_INVALID_DATE"]);
    assert.deepEqual(codes(run({ salida: "2026-10-12" })), ["RESERVATION_IMPORT_ROW_DATE_ORDER"]);
    assert.deepEqual(codes(run({ salida: "2026-10-11" })), ["RESERVATION_IMPORT_ROW_DATE_ORDER"]);
    assert.deepEqual(codes(run({ salida: "", noches: "0" })), ["RESERVATION_IMPORT_ROW_INVALID_NIGHTS"]);
    assert.deepEqual(codes(run({ salida: "", noches: "400" })), ["RESERVATION_IMPORT_ROW_INVALID_NIGHTS"]);
    assert.deepEqual(codes(run({ salida: "2027-10-13" })), ["RESERVATION_IMPORT_ROW_INVALID_NIGHTS"]);
    assert.deepEqual(codes(run({ salida: "2026-12-15" })), ["RESERVATION_IMPORT_ROW_LONG_STAY"]);
    assert.deepEqual(codes(run({ salida: "", noches: "" })), ["RESERVATION_IMPORT_ROW_MISSING_FIELD"]);
    assert.deepEqual(codes(run({ llegada: "" })), ["RESERVATION_IMPORT_ROW_MISSING_FIELD"]);
    assert.deepEqual(codes(run({ llegada: "2029-01-10", salida: "2029-01-12" })), ["RESERVATION_IMPORT_ROW_FAR_FUTURE"]);
  });

  it("llegadas pasadas: PAST_ARRIVAL sin histórico; histórico → historical; estancia en curso → IN_HOUSE_PAST", () => {
    const past = run({ llegada: "2026-09-01", salida: "2026-09-05" });
    assert.deepEqual(codes(past), ["RESERVATION_IMPORT_ROW_PAST_ARRIVAL"]);
    assert.equal(past.issues[0]!.details?.today, "2026-09-16");
    assert.match(past.issues[0]!.message, /anterior a hoy \(2026-09-16\)/);

    // T7-FUN-01: la frontera es el HOY de la propiedad, no la fecha de negocio (que puede ir por detrás si hay días sin cerrar).
    const lagging = { ...CATALOGS, businessDate: "2026-09-13", today: "2026-09-17" };
    assert.deepEqual(codes(run({ llegada: "2026-09-14", salida: "2026-09-16" }, {}, lagging)), ["RESERVATION_IMPORT_ROW_PAST_ARRIVAL"], "llegada entre la fecha de negocio y hoy: pasada");
    assert.deepEqual(codes(run({ llegada: "2026-09-16", salida: "2026-09-18" }, {}, lagging)), ["RESERVATION_IMPORT_ROW_PAST_ARRIVAL"], "llegada de ayer: pasada");
    const finished = run({ llegada: "2026-09-10", salida: "2026-09-15" }, { historico: true }, lagging);
    assert.deepEqual(codes(finished), ["RESERVATION_IMPORT_ROW_HISTORICAL"], "estancia terminada hace dos días: histórica, no «en curso»");
    assert.equal(finished.normalized!.historical, true);
    assert.deepEqual(codes(run({ llegada: "2026-09-17", salida: "2026-09-19" }, {}, lagging)), [], "llegada hoy: normal");

    const historical = run({ llegada: "2026-09-01", salida: "2026-09-05" }, { historico: true });
    assert.deepEqual(codes(historical), ["RESERVATION_IMPORT_ROW_HISTORICAL"]);
    assert.equal(historical.normalized!.historical, true);
    assert.equal(historical.resolved!.historical, true);

    const ignoredStatus = run({ llegada: "2026-09-01", salida: "2026-09-05", estado: "cancelada" }, { historico: true });
    assert.deepEqual(codes(ignoredStatus), ["RESERVATION_IMPORT_ROW_HISTORICAL", "RESERVATION_IMPORT_ROW_STATUS_IGNORED_HISTORICAL"]);
    assert.equal(ignoredStatus.normalized!.estado, "confirmada");

    const inHouse = run({ llegada: "2026-09-10", salida: "2026-09-20" }, { historico: true });
    assert.deepEqual(codes(inHouse), ["RESERVATION_IMPORT_ROW_IN_HOUSE_PAST"]);
    assert.deepEqual(codes(run({ llegada: "2026-09-10", salida: "2026-09-20" })), ["RESERVATION_IMPORT_ROW_PAST_ARRIVAL"]);

    const today = run({ llegada: "2026-09-16", salida: "2026-09-18" });
    assert.deepEqual(codes(today), [], "la llegada en la fecha de negocio es normal");
    const endsToday = run({ llegada: "2026-09-15", salida: "2026-09-16" }, { historico: true });
    assert.equal(endsToday.normalized!.historical, true, "salida = fecha de negocio → histórica");
  });
});

describe("normalizeRow · catálogos de la propiedad", () => {
  it("tipo: código, nombre, contención, sinónimo, desconocido con sugerencias, inactivo", () => {
    assert.equal(run({ tipo_habitacion: "dbl" }).normalized!.roomTypeId, "rt_dbl");
    assert.equal(run({ tipo_habitacion: "Doble estándar" }).normalized!.roomTypeId, "rt_dbl");
    assert.equal(run({ tipo_habitacion: "Individual", adultos: "1" }).normalized!.roomTypeId, "rt_ind");
    const contained = run({ tipo_habitacion: "Doble" });
    assert.deepEqual(codes(contained), ["RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY"]);
    assert.equal(contained.normalized!.roomTypeCode, "DBL");
    const synonym = run({ tipo_habitacion: "Double room" });
    assert.deepEqual(codes(synonym), ["RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY"]);
    assert.equal(synonym.normalized!.roomTypeCode, "DBL");
    const single = run({ tipo_habitacion: "Single", adultos: "1" });
    assert.equal(single.normalized!.roomTypeCode, "IND");
    const bySuite = run({ tipo_habitacion: "Suite presidencial" });
    assert.deepEqual(codes(bySuite), ["RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY"], "grupo «suite» con candidato único → aproximado con aviso");
    assert.equal(bySuite.normalized!.roomTypeCode, "JRS");
    const unknown = run({ tipo_habitacion: "Loft ático" });
    assert.deepEqual(codes(unknown), ["RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN"]);
    assert.deepEqual(unknown.issues[0]!.details?.suggestions, ["DBL", "IND", "JRS"]);
    assert.deepEqual(codes(run({ tipo_habitacion: "OLD" })), ["RESERVATION_IMPORT_ROW_ROOM_TYPE_INACTIVE"]);
    assert.deepEqual(codes(run({ tipo_habitacion: "" })), ["RESERVATION_IMPORT_ROW_MISSING_FIELD"]);
    assert.equal(resolveRoomType("Junior", CATALOGS.roomTypes).kind, "fuzzy");
    assert.equal(resolveRoomType("Suite", CATALOGS.roomTypes).kind, "fuzzy", "«suite» solo está en Junior suite");
  });

  it("tarifa: por defecto con aviso si la columna está mapeada, código, nombre, desconocida, inactiva", () => {
    const defaulted = run({ tarifa: "" });
    assert.deepEqual(codes(defaulted), ["RESERVATION_IMPORT_ROW_RATE_PLAN_DEFAULTED"]);
    assert.equal(defaulted.normalized!.ratePlanCode, "BAR");
    const cells = cellsOf({});
    const unmapped = normalizeRow({ rowNumber: 1, cells, kinds: cells.map(() => "string") }, FIELDS.map((field) => (field === "tarifa" ? null : field)), CATALOGS, { historico: false, splitName: false });
    assert.deepEqual(codes(unmapped), [], "sin columna de tarifa no hay aviso");
    assert.equal(unmapped.normalized!.ratePlanCode, "BAR");
    assert.equal(run({ tarifa: "BAR-BB" }).normalized!.ratePlanId, "rp_bb");
    assert.equal(run({ tarifa: "bar con desayuno" }).normalized!.ratePlanId, "rp_bb");
    assert.deepEqual(codes(run({ tarifa: "XXX" })), ["RESERVATION_IMPORT_ROW_RATE_PLAN_UNKNOWN"]);
    assert.deepEqual(codes(run({ tarifa: "OLDRATE" })), ["RESERVATION_IMPORT_ROW_RATE_PLAN_INACTIVE"]);
    const noDefault = run({ tarifa: "" }, {}, { ...CATALOGS, defaultRatePlanId: null });
    assert.deepEqual(codes(noDefault), []);
    assert.equal(noDefault.normalized!.ratePlanId, undefined);
  });

  it("habitación: existente, inexistente, de otro tipo, con varias unidades", () => {
    const ok = run({ habitacion: "111" });
    assert.deepEqual(codes(ok), []);
    assert.equal(ok.normalized!.roomId, "room_111");
    assert.equal(ok.normalized!.roomNumber, "111");
    assert.equal(ok.resolved!.roomNumber, "111");
    assert.equal(run({ habitacion: "0111" }).normalized!.roomId, "room_111", "ceros a la izquierda tolerados");
    assert.deepEqual(codes(run({ habitacion: "999" })), ["RESERVATION_IMPORT_ROW_ROOM_UNKNOWN"]);
    assert.deepEqual(codes(run({ habitacion: "101" })), ["RESERVATION_IMPORT_ROW_ROOM_TYPE_MISMATCH"]);
    assert.deepEqual(codes(run({ habitacion: "111", habitaciones: "2" })), ["RESERVATION_IMPORT_ROW_ROOM_WITH_MULTIPLE_ROOMS"]);
  });

  it("ocupación: 3 adultos en DBL → error; 2 habitaciones con 3 adultos → ok; 0 adultos → error; no enteros → error", () => {
    assert.deepEqual(codes(run({ adultos: "3" })), ["RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED"]);
    assert.deepEqual(codes(run({ adultos: "2", ninos: "1" })), ["RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED"]);
    const twoRooms = run({ adultos: "3", habitaciones: "2" });
    assert.deepEqual(codes(twoRooms), []);
    assert.equal(twoRooms.normalized!.roomsCount, 2);
    assert.deepEqual(codes(run({ adultos: "2", bebes: "3" })), [], "los bebés no cuentan");
    assert.deepEqual(codes(run({ adultos: "0" })), ["RESERVATION_IMPORT_ROW_ADULTS_REQUIRED"]);
    assert.equal(run({ adultos: "" }).normalized!.adults, 1, "adultos vacío → 1");
    assert.deepEqual(codes(run({ adultos: "dos" })), ["RESERVATION_IMPORT_ROW_INVALID_NUMBER"]);
    assert.deepEqual(codes(run({ habitaciones: "0" })), ["RESERVATION_IMPORT_ROW_INVALID_NUMBER"]);
  });

  it("régimen, canal, segmento, estado, método de pago, vip, hora", () => {
    const row = run({
      regimen: "Alojamiento y desayuno",
      canal: "Booking.com",
      segmento: "ota",
      estado: "tentativa",
      metodo_pago: "prepago OTA",
      vip: "sí",
      hora_llegada: "16:30",
      empresa: "Acme SL",
      agencia: "Viajes Demo",
      grupo: "G-1",
      deposito: "59,20",
      peticiones: "Cuna",
      notas: "Booking.com 4411223344"
    });
    assert.deepEqual(codes(row), []);
    const n = row.normalized!;
    assert.equal(n.boardType, "BB");
    assert.equal(n.channel, "booking_com");
    assert.equal(n.sourceCode, "Booking.com");
    assert.equal(n.marketSegment, "ota");
    assert.equal(n.estado, "tentativa");
    assert.equal(n.paymentMethod, "online_prepaid");
    assert.equal(n.vipFlag, true);
    assert.equal(n.estimatedArrivalTime, "16:30");
    assert.equal(n.companyName, "Acme SL");
    assert.equal(n.travelAgentName, "Viajes Demo");
    assert.equal(n.groupCode, "G-1");
    assert.equal(n.depositAmount, "59.20");
    assert.equal(n.specialRequests, "Cuna");
    assert.equal(n.notes, "Booking.com 4411223344");

    const unknowns = run({ regimen: "Cena", canal: "Paloma mensajera", segmento: "peregrinos", metodo_pago: "trueque", vip: "quizás" });
    assert.deepEqual(codes(unknowns).sort(), [
      "RESERVATION_IMPORT_ROW_BOARD_UNKNOWN",
      "RESERVATION_IMPORT_ROW_CHANNEL_UNKNOWN",
      "RESERVATION_IMPORT_ROW_PAYMENT_METHOD_UNKNOWN",
      "RESERVATION_IMPORT_ROW_SEGMENT_UNKNOWN",
      "RESERVATION_IMPORT_ROW_VIP_UNKNOWN"
    ]);
    assert.equal(unknowns.normalized!.boardType, undefined);
    assert.equal(unknowns.normalized!.channel, "paloma_mensajera");
    assert.equal(unknowns.normalized!.marketSegment, "peregrinos");
    assert.equal(unknowns.normalized!.paymentMethod, "trueque");
    assert.equal(unknowns.normalized!.vipFlag, false);
    assert.deepEqual(codes(run({ estado: "no-show" })), ["RESERVATION_IMPORT_ROW_INVALID_STATUS"]);
    assert.equal(run({ estado: "cancelada" }).normalized!.estado, "cancelada");
  });

  it("importes y moneda: «1.234,56» → 1234.56; USD → INVALID_CURRENCY; «€» → EUR; vacío → 0.00 none; inválido → error", () => {
    const amount = run({ importe_total: "1.234,56" });
    assert.equal(amount.normalized!.totalAmount, "1234.56");
    assert.equal(amount.normalized!.totalSource, "file");
    assert.deepEqual(codes(run({ moneda: "USD" })), ["RESERVATION_IMPORT_ROW_INVALID_CURRENCY"]);
    assert.equal(run({ moneda: "€" }).normalized!.currency, "EUR");
    assert.equal(run({ moneda: "eur" }).normalized!.currency, "EUR");
    const empty = run({ importe_total: "" });
    assert.deepEqual(codes(empty), []);
    assert.equal(empty.normalized!.totalAmount, "0.00");
    assert.equal(empty.normalized!.totalSource, "none");
    assert.deepEqual(codes(run({ importe_total: "gratis" })), ["RESERVATION_IMPORT_ROW_INVALID_AMOUNT"]);
    assert.deepEqual(codes(run({ importe_total: "-10" })), ["RESERVATION_IMPORT_ROW_INVALID_AMOUNT"]);
    assert.deepEqual(codes(run({ deposito: "1.000.000,00" })), ["RESERVATION_IMPORT_ROW_INVALID_AMOUNT"]);
  });
});

describe("normalizeRow · huésped", () => {
  it("e-mail inválido → EMAIL_DROPPED; teléfono inválido → PHONE_DROPPED; nacionalidad ES → ESP; desconocida → descartada", () => {
    const badEmail = run({ email: "lucia.ferreiro-at-example.com" });
    assert.deepEqual(codes(badEmail), ["RESERVATION_IMPORT_ROW_EMAIL_DROPPED"]);
    assert.equal(badEmail.normalized!.guest.email, undefined);
    const badPhone = run({ telefono: "12" });
    assert.deepEqual(codes(badPhone), ["RESERVATION_IMPORT_ROW_PHONE_DROPPED"]);
    assert.equal(badPhone.normalized!.guest.phone, undefined);
    assert.equal(run({ telefono: "+34 600 111 001" }).normalized!.guest.phone, "+34600111001");
    assert.equal(run({ nacionalidad: "ES" }).normalized!.guest.nationality, "ESP");
    assert.equal(run({ nacionalidad: "Polonia" }).normalized!.guest.nationality, "POL");
    const badNationality = run({ nacionalidad: "Atlántida" });
    assert.deepEqual(codes(badNationality), ["RESERVATION_IMPORT_ROW_NATIONALITY_DROPPED"]);
    assert.equal(badNationality.normalized!.guest.nationality, undefined);
  });

  it("documento: tipo canónico, tipo desconocido en mayúsculas con aviso, número en mayúsculas sin espacios", () => {
    const passport = run({ documento_tipo: "PAS", documento_numero: "ab 1234567" });
    assert.deepEqual(codes(passport), []);
    assert.equal(passport.normalized!.guest.documentType, "PASSPORT");
    assert.equal(passport.normalized!.guest.documentNumber, "AB1234567");
    const other = run({ documento_tipo: "carné", documento_numero: "x-1" });
    assert.deepEqual(codes(other), ["RESERVATION_IMPORT_ROW_DOCUMENT_TYPE_UNKNOWN"]);
    assert.equal(other.normalized!.guest.documentType, "CARNÉ");
  });

  it("«Ferreiro Castro, Lucía» y «Lucía Ferreiro Castro» con splitName → NAME_SPLIT; una sola palabra → falta apellidos", () => {
    const comma = run({ nombre: "Ferreiro Castro, Lucía", apellidos: "" }, { splitName: true });
    assert.deepEqual(codes(comma), ["RESERVATION_IMPORT_ROW_NAME_SPLIT"]);
    assert.deepEqual(comma.normalized!.guest, { firstName: "Lucía", surname1: "Ferreiro", surname2: "Castro", email: "lucia.ferreiro@example.com" });
    const plain = run({ nombre: "Lucía Ferreiro Castro", apellidos: "" }, { splitName: true });
    assert.deepEqual(codes(plain), ["RESERVATION_IMPORT_ROW_NAME_SPLIT"]);
    assert.equal(plain.normalized!.guest.firstName, "Lucía");
    assert.equal(plain.normalized!.guest.surname1, "Ferreiro");
    assert.equal(plain.normalized!.guest.surname2, "Castro");
    const single = run({ nombre: "Marek", apellidos: "" }, { splitName: true });
    assert.deepEqual(codes(single), ["RESERVATION_IMPORT_ROW_MISSING_FIELD"]);
    assert.equal(single.issues[0]!.column, "apellidos");
    assert.deepEqual(codes(run({ apellidos: "" })), ["RESERVATION_IMPORT_ROW_MISSING_FIELD"]);
    assert.deepEqual(codes(run({ nombre: "" })), ["RESERVATION_IMPORT_ROW_MISSING_FIELD"]);
    const oneSurname = run({ apellidos: "Nowak" });
    assert.equal(oneSurname.normalized!.guest.surname1, "Nowak");
    assert.equal(oneSurname.normalized!.guest.surname2, undefined);
  });

  it("longitudes máximas: recorte con CELL_TRUNCATED", () => {
    const long = run({ notas: "n".repeat(2100), peticiones: "p".repeat(2001), grupo: "g".repeat(81), nombre: "L".repeat(121), documento_numero: "d".repeat(61) });
    assert.deepEqual(codes(long), Array(5).fill("RESERVATION_IMPORT_ROW_CELL_TRUNCATED"));
    assert.equal(long.normalized!.notes!.length, 2000);
    assert.equal(long.normalized!.specialRequests!.length, 2000);
    assert.equal(long.normalized!.groupCode!.length, 80);
    assert.equal(long.normalized!.guest.firstName.length, 120);
    assert.equal(long.normalized!.guest.documentNumber!.length, 60);
  });
});

describe("normalizeTable · duplicados dentro del fichero y veredicto", () => {
  const HEADER = "referencia_externa;llegada;salida;tipo_habitacion;habitacion;nombre;apellidos;email;documento_numero";
  const csv = (...rows: string[]): string => [HEADER, ...rows].join("\n") + "\n";
  const table = (text: string, historico = false) => normalizeTable(parseCsvTable(text), null, CATALOGS, { historico });

  it("habitación repetida con noches solapadas → ROOM_DUPLICATE_IN_FILE (error) en la fila posterior; sin solape → nada", () => {
    const overlapping = table(csv("A;2026-10-12;2026-10-15;DBL;111;Lucía;Ferreiro;;", "B;2026-10-14;2026-10-16;DBL;111;Marek;Nowak;;"));
    assert.deepEqual(overlapping.rows.map((row) => row.status), ["valid", "error"]);
    assert.deepEqual(codes(overlapping.rows[1]!), ["RESERVATION_IMPORT_ROW_ROOM_DUPLICATE_IN_FILE"]);
    assert.equal(overlapping.rows[1]!.issues[0]!.details?.otherRow, 1);
    assert.equal(overlapping.rows[1]!.normalized, undefined, "una fila con error no expone normalized");
    const consecutive = table(csv("A;2026-10-12;2026-10-15;DBL;111;Lucía;Ferreiro;;", "B;2026-10-15;2026-10-16;DBL;111;Marek;Nowak;;"));
    assert.deepEqual(consecutive.rows.map((row) => row.status), ["valid", "valid"]);
    const otherRoom = table(csv("A;2026-10-12;2026-10-15;DBL;111;Lucía;Ferreiro;;", "B;2026-10-12;2026-10-15;DBL;411;Marek;Nowak;;"));
    assert.deepEqual(otherRoom.rows.map((row) => row.status), ["valid", "valid"]);
  });

  it("referencia repetida → DUPLICATE_IN_FILE (omitida, gana la primera); mismo huésped + llegada + tipo → POSSIBLE_DUPLICATE", () => {
    const duplicated = table(csv("A;2026-10-12;2026-10-15;DBL;;Lucía;Ferreiro;;", "a;2026-11-01;2026-11-03;IND;;Marek;Nowak;;"));
    assert.deepEqual(duplicated.rows.map((row) => row.status), ["valid", "skipped"]);
    assert.deepEqual(codes(duplicated.rows[1]!), ["RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE"]);
    assert.equal(duplicated.rows[1]!.issues[0]!.details?.firstRow, 1);
    assert.ok(duplicated.rows[1]!.normalized, "una fila omitida conserva normalized (el servicio decide)");
    const possible = table(csv("A;2026-10-12;2026-10-15;DBL;;Lucía;Ferreiro;lucia@example.com;", "B;2026-10-12;2026-10-14;DBL;;Lucia;Ferreiro;lucia@example.com;"));
    assert.deepEqual(possible.rows.map((row) => row.status), ["valid", "warning"]);
    assert.deepEqual(codes(possible.rows[1]!), ["RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE"]);
    const byName = table(csv(";2026-10-12;2026-10-15;DBL;;Lucía;Ferreiro Castro;;", ";2026-10-12;2026-10-14;DBL;;lucia;FERREIRO CASTRO;;"));
    assert.deepEqual(codes(byName.rows[1]!), ["RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE"], "apellidos + nombre plegados");
    const byDocument = table(csv(";2026-10-12;2026-10-15;DBL;;Lucía;Ferreiro;;11111111H", ";2026-10-12;2026-10-14;DBL;;Ana;Otra;;11111111h"));
    assert.deepEqual(codes(byDocument.rows[1]!), ["RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE"], "mismo documento");
    const otherType = table(csv(";2026-10-12;2026-10-15;DBL;;Lucía;Ferreiro;;", ";2026-10-12;2026-10-14;IND;;Lucía;Ferreiro;;"));
    assert.deepEqual(otherType.rows.map((row) => row.status), ["valid", "valid"]);
  });

  it("mapeo de terceros con nombre completo y veredictos", () => {
    const text = "Booking ID,Check-in,Nights,Room Type,Guest name,Adults\nB-1,12/10/2026,3,Double,\"Ferreiro Castro, Lucía\",2\nB-2,13/10/2026,2,IND,Marek Nowak,2\nB-3,,2,DBL,Ana Sola,1\n";
    const result = normalizeTable(parseCsvTable(text), null, CATALOGS, { historico: false });
    assert.equal(result.splitName, true);
    assert.deepEqual(result.mappingByIndex, ["referencia_externa", "llegada", "noches", "tipo_habitacion", "nombre", "adultos"]);
    assert.deepEqual(result.rows.map((row) => row.status), ["warning", "error", "error"]);
    assert.deepEqual(codes(result.rows[0]!).sort(), ["RESERVATION_IMPORT_ROW_NAME_SPLIT", "RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY"]);
    assert.equal(result.rows[0]!.normalized!.guest.firstName, "Lucía");
    assert.equal(result.rows[0]!.normalized!.departureDate, "2026-10-15");
    assert.ok(codes(result.rows[1]!).includes("RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED"));
    assert.ok(codes(result.rows[2]!).includes("RESERVATION_IMPORT_ROW_MISSING_FIELD"));
    assert.equal(rowStatusFromIssues([]), "valid");
    assert.equal(rowStatusFromIssues([{ code: "RESERVATION_IMPORT_ROW_NAME_SPLIT", message: "" }]), "warning");
    assert.equal(rowStatusFromIssues([{ code: "RESERVATION_IMPORT_ROW_NAME_SPLIT", message: "" }, { code: "RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE", message: "" }]), "skipped");
    assert.equal(rowStatusFromIssues([{ code: "RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE", message: "" }, { code: "RESERVATION_IMPORT_ROW_INVALID_DATE", message: "" }]), "error");
  });
});

describe("reservationImportContentHash", () => {
  const A = "llegada;salida;tipo_habitacion;nombre;apellidos;email\n2026-10-12;2026-10-15;DBL;Lucía;Ferreiro Castro;lucia@example.com\n2026-10-20;2026-10-22;IND;Marek;Nowak;marek@example.com\n";
  const B = "\uFEFFllegada,salida,tipo_habitacion,nombre,apellidos,email\r\n2026-10-20 , 2026-10-22 , IND , Marek , Nowak , MAREK@example.com\r\n\r\n2026-10-12,2026-10-15,dbl,Lucía,Ferreiro Castro,lucia@example.com\r\n";
  const C = "llegada;salida;tipo_habitacion;nombre;apellidos;email\n2026-10-12;2026-10-15;DBL;Lucía;Ferreiro Castro;lucia@example.com\n2026-10-20;2026-10-22;DBL;Marek;Nowak;marek@example.com\n";
  const hashOf = (text: string) => reservationImportContentHash(normalizeTable(parseCsvTable(text), null, CATALOGS, { historico: false }).rows);

  it("idéntico con espacios, BOM, separador, CRLF y orden distinto; distinto al cambiar una celda", () => {
    const a = hashOf(A);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(hashOf(B), a);
    assert.notEqual(hashOf(C), a);
    assert.notEqual(hashOf(A.replace("Nowak", "Nowac")), a);
  });

  it("no depende de la opción «histórico» ni del importe cotizado, sí de los errores del fichero", () => {
    const rows = normalizeTable(parseCsvTable(A), null, CATALOGS, { historico: false }).rows;
    const rowsHistorical = normalizeTable(parseCsvTable(A), null, CATALOGS, { historico: true }).rows;
    assert.equal(reservationImportContentHash(rows), reservationImportContentHash(rowsHistorical));
    const quoted = rows.map((row) => ({ ...row, normalized: row.normalized ? { ...row.normalized, totalAmount: "500.00", totalSource: "quoted" as const } : undefined }));
    assert.equal(reservationImportContentHash(quoted), reservationImportContentHash(rows));
    const withError = normalizeTable(parseCsvTable(A.replace("2026-10-15", "31/02/2026")), null, CATALOGS, { historico: false }).rows;
    assert.notEqual(reservationImportContentHash(withError), reservationImportContentHash(rows));
    assert.equal(reservationImportContentHash([]), reservationImportContentHash([]));
  });

  it("T7-FUN-03: contentHashRowsOf ignora la frontera temporal: mismo hash con y sin «histórico», y con otro «hoy», para un fichero con llegadas pasadas", () => {
    const past = "llegada;salida;tipo_habitacion;nombre;apellidos;email\n2026-09-01;2026-09-05;DBL;Lucía;Ferreiro Castro;lucia@example.com\n2026-09-10;2026-09-20;IND;Marek;Nowak;marek@example.com\n2026-10-20;2026-10-22;IND;Ana;Pérez;ana@example.com\n";
    const parsed = parseCsvTable(past);
    // Con la normalización real el hash cambiaba con la opción (PAST_ARRIVAL → error → celdas; HISTORICAL → normalizada).
    const plain = normalizeTable(parsed, null, CATALOGS, { historico: false }).rows;
    const historical = normalizeTable(parsed, null, CATALOGS, { historico: true }).rows;
    assert.notEqual(reservationImportContentHash(plain), reservationImportContentHash(historical), "la normalización real sí depende de la opción");
    const hash = reservationImportContentHash(contentHashRowsOf(parsed, null, CATALOGS));
    assert.equal(reservationImportContentHash(contentHashRowsOf(parsed, null, { ...CATALOGS, today: "2026-09-25", businessDate: "2026-09-20" })), hash, "otro día: mismo hash");
    assert.equal(reservationImportContentHash(contentHashRowsOf(parsed, null, { ...CATALOGS, today: "2020-01-01" })), hash);
    const hashRows = contentHashRowsOf(parsed, null, CATALOGS);
    assert.ok(hashRows.every((row) => row.normalized !== undefined), "para el hash ninguna fila es pasada ni está en curso");
    assert.notEqual(reservationImportContentHash(contentHashRowsOf(parseCsvTable(past.replace("Nowak", "Nowac")), null, CATALOGS)), hash, "sigue cambiando con una celda");
  });
});

describe("GDPR · ningún mensaje contiene valores de la fila", () => {
  const PERSONAL = ["Lucía", "lucia.ferreiro", "Ferreiro", "Castro", "11111111H", "example.com", "+34 600 111 001", "600111001"];

  it("fila ficticia con todos los avisos y errores posibles", () => {
    const result = run({
      llegada: "31/02/2026",
      tipo_habitacion: "Suite presidencial",
      nombre: "Lucía",
      apellidos: "Ferreiro Castro",
      email: "lucia.ferreiro-at-example.com",
      telefono: "+34 600 111 001 ext",
      documento_tipo: "carné",
      documento_numero: "11111111H",
      nacionalidad: "Atlántida",
      regimen: "Cena",
      canal: "Paloma",
      estado: "no-show",
      vip: "quizás",
      importe_total: "gratis",
      moneda: "USD",
      notas: "Lucía Ferreiro Castro 11111111H lucia.ferreiro@example.com"
    });
    assert.ok(result.issues.length >= 10, `se esperaban muchas incidencias: ${codes(result).join(",")}`);
    const serialized = JSON.stringify(result.issues);
    for (const value of PERSONAL) {
      assert.equal(serialized.includes(value), false, `el mensaje contiene «${value}»: ${serialized}`);
    }
    for (const issue of result.issues) {
      assert.match(issue.message, /^Fila 1: /);
    }
  });

  it("fila válida con avisos: NAME_SPLIT, GUEST, POSSIBLE_DUPLICATE tampoco citan valores", () => {
    const text = "Check-in,Nights,Room Type,Guest name,E-mail,Documento\n12/10/2026,3,Doble,\"Ferreiro Castro, Lucía\",lucia.ferreiro@example.com,11111111H\n12/10/2026,2,DBL,Lucía Ferreiro Castro,LUCIA.FERREIRO@example.com,11111111H\n";
    const result = normalizeTable(parseCsvTable(text), null, CATALOGS, { historico: false });
    const serialized = JSON.stringify(result.rows.map((row) => row.issues));
    assert.ok(result.rows.every((row) => row.issues.length > 0));
    for (const value of PERSONAL) {
      assert.equal(serialized.includes(value), false, `el mensaje contiene «${value}»: ${serialized}`);
    }
  });

  it("stripRowValues borra valores colados (≥ 3 caracteres, sin distinguir mayúsculas) y respeta los cortos", () => {
    assert.equal(stripRowValues("El huésped Lucía Ferreiro no existe (DBL, 2)", ["Lucía Ferreiro", "DBL", "2"]), "El huésped [valor omitido] no existe ([valor omitido], 2)");
    assert.equal(stripRowValues("Fila 2: falta la llegada.", ["2", "Ana", "x"]), "Fila 2: falta la llegada.");
    assert.equal(stripRowValues("Documento 11111111h duplicado", ["11111111H"]), "Documento [valor omitido] duplicado");
    assert.equal(stripRowValues("sin cambios", []), "sin cambios");
  });

  it("T7-FUN-02: solo tokens completos («Ana» no toca «Analizando», «Mar» no toca «marcaría», «PAS» no toca «PASAPORTE»)", () => {
    assert.equal(stripRowValues("Analizando la fila de Ana", ["Ana"]), "Analizando la fila de [valor omitido]");
    assert.equal(stripRowValues("la auditoría nocturna la marcaría no-show", ["Mar"]), "la auditoría nocturna la marcaría no-show");
    assert.equal(stripRowValues("«Documento tipo» admite DNI / NIE / PASAPORTE / TIE", ["PAS"]), "«Documento tipo» admite DNI / NIE / PASAPORTE / TIE");
    assert.equal(stripRowValues("Importe total vacío", ["ota"]), "Importe total vacío");
    assert.equal(stripRowValues("fila histórica", ["Hist"]), "fila histórica");
    assert.equal(stripRowValues("asignada a Ferreiro Castro (lucia.ferreiro@example.com)", ["Ferreiro Castro", "lucia.ferreiro@example.com"]), "asignada a [valor omitido] ([valor omitido])");
  });

  it("T7-FUN-02: personalValuesOf devuelve solo las celdas personales (y sus palabras), nunca códigos de catálogo ni el estado", () => {
    const mapping: Array<ReservationImportField | null> = ["referencia_externa", "estado", "tipo_habitacion", "nombre", "apellidos", "email", "documento_tipo", "documento_numero", "notas", null];
    const cells = ["BK-1", "tentativa", "SRA", "Lucía", "Ferreiro Castro", "lucia@example.com", "PAS", "X1234567", "Llega tarde, cuna", "columna ignorada"];
    const values = personalValuesOf(cells, mapping);
    assert.deepEqual(values, ["Llega tarde, cuna", "lucia@example.com", "Ferreiro Castro", "Ferreiro", "X1234567", "Castro", "Lucía"], "celda completa y palabras de identidad, las más largas primero; las notas solo como celda");
    assert.ok(!values.includes("tentativa") && !values.includes("SRA") && !values.includes("PAS") && !values.includes("BK-1") && !values.includes("columna ignorada"));
    assert.ok(!values.includes("Llega") && !values.includes("tarde") && !values.includes("cuna"), "las palabras sueltas de una nota no son valores personales");
    // Los mensajes del servicio que citan catálogo sobreviven; los que citan al huésped no.
    assert.equal(stripRowValues("Fila 5: «Estado» tentativa: se crea confirmada.", values), "Fila 5: «Estado» tentativa: se crea confirmada.");
    assert.equal(stripRowValues("Fila 5: tipo SRA: cupo 5, 5 ya reservadas, 1 solicitadas", values), "Fila 5: tipo SRA: cupo 5, 5 ya reservadas, 1 solicitadas");
    assert.equal(stripRowValues("Fila 5: huésped Lucía Ferreiro Castro (X1234567) ya existe", values), "Fila 5: huésped [valor omitido] [valor omitido] ([valor omitido]) ya existe");
    // Una fila con «Mar» de nombre y «Sol» de apellido no rompe «marcaría» ni «solicitadas».
    const short = personalValuesOf(["Mar", "Sol"], ["nombre", "apellidos"]);
    assert.deepEqual(short, ["Mar", "Sol"]);
    assert.equal(stripRowValues("la marcaría no-show; 2 solicitadas", short), "la marcaría no-show; 2 solicitadas");
  });

  it("integración T7: las palabras de «notas» y «peticiones» no mutilan los mensajes de la fila (solo la celda completa se protege)", () => {
    const mapping: Array<ReservationImportField | null> = ["estado", "nombre", "apellidos", "notas", "peticiones"];
    const cells = ["cancelada", "Antía", "Freire Bello", "Cancelada por la clienta el 10/09 · confirmar antes del 20/10", "Fecha copiada de Excel, cama con vistas"];
    const values = personalValuesOf(cells, mapping);
    assert.equal(stripRowValues("Fila 19: «Estado» cancelada: se crea y se cancela en el mismo lote.", values), "Fila 19: «Estado» cancelada: se crea y se cancela en el mismo lote.");
    assert.equal(stripRowValues("Fila 5: «Estado» tentativa: se crea confirmada con la nota interna «confirmar con el cliente».", values), "Fila 5: «Estado» tentativa: se crea confirmada con la nota interna «confirmar con el cliente».");
    assert.equal(stripRowValues("Fila 6: «Llegada» se ha leído de un serial numérico de Excel: comprueba la fecha.", values), "Fila 6: «Llegada» se ha leído de un serial numérico de Excel: comprueba la fecha.");
    // La nota entera y el huésped siguen protegidos.
    assert.equal(stripRowValues("error: Cancelada por la clienta el 10/09 · confirmar antes del 20/10 (Antía Freire Bello)", values), "error: [valor omitido] ([valor omitido] [valor omitido])");
  });
});

describe("plantilla oficial (diseño §2.4) · ida y vuelta CSV → XLSX", () => {
  const TEMPLATE =
    "\uFEFFreferencia_externa;llegada;salida;noches;tipo_habitacion;tarifa;habitacion;habitaciones;adultos;ninos;bebes;regimen;canal;segmento;estado;nombre;apellidos;email;telefono;nacionalidad;documento_tipo;documento_numero;empresa;agencia;grupo;importe_total;moneda;deposito;metodo_pago;hora_llegada;peticiones;notas;vip\r\n" +
    "IMP-RA-2026-001;2026-10-12;2026-10-15;;DBL;BAR;111;1;2;0;0;RO;directo;leisure;confirmada;Lucía;Ferreiro Castro;lucia.ferreiro@example.com;+34 600 111 001;ES;DNI;11111111H;;;;312,00;EUR;0;tarjeta;16:30;Cama de matrimonio;;no\r\n" +
    "IMP-RA-2026-002;13/10/2026;;2;Doble Superior Vista Ría;BAR-BB;;1;2;1;0;Alojamiento y desayuno;booking;ota;confirmada;Marek;Nowak;marek.nowak@example.com;+48 600 111 002;PL;PAS;AB1234567;;;;296,00;EUR;59,20;prepago OTA;;Cuna para el niño;Booking.com 4411223344;no\r\n";
  const RIAS_ALTAS: ReservationImportCatalogs = {
    roomTypes: [
      { id: "rt_dbl", code: "DBL", name: "Doble", maxOccupancy: 2, active: true },
      { id: "rt_dsv", code: "DSV", name: "Doble Superior Vista Ría", maxOccupancy: 3, active: true }
    ],
    ratePlans: [
      { id: "rp_bar", code: "BAR", name: "BAR", active: true },
      { id: "rp_bb", code: "BAR-BB", name: "BAR desayuno", active: true }
    ],
    rooms: [{ id: "room_111", number: "111", roomTypeId: "rt_dbl" }],
    defaultRatePlanId: "rp_bar",
    currency: "EUR",
    businessDate: "2026-09-16", today: "2026-09-16"
  };

  it("las dos filas de ejemplo son válidas sin incidencias y el hash coincide leído desde el .xlsx equivalente", () => {
    const parsed = parseReservationImportFile({ content: TEMPLATE, fileName: "plantilla-reservas.csv" });
    assert.equal(parsed.header.length, 33);
    const mapping = applyMapping(parsed.header);
    assert.deepEqual(mapping.unmappedColumns, []);
    assert.deepEqual(mapping.missingRequired, []);
    assert.ok(Object.values(mapping.mappingSource).every((source) => source === "synonym"));
    const table = normalizeTable(parsed, null, RIAS_ALTAS, { historico: false });
    assert.deepEqual(table.rows.map((row) => [row.status, row.issues.length]), [
      ["valid", 0],
      ["valid", 0]
    ]);
    const second = table.rows[1]!.normalized!;
    assert.equal(second.arrivalDate, "2026-10-13");
    assert.equal(second.departureDate, "2026-10-15");
    assert.equal(second.roomTypeCode, "DSV");
    assert.equal(second.ratePlanCode, "BAR-BB");
    assert.equal(second.boardType, "BB");
    assert.equal(second.channel, "booking_com");
    assert.equal(second.sourceCode, "booking");
    assert.equal(second.paymentMethod, "online_prepaid");
    assert.equal(second.depositAmount, "59.20");
    assert.deepEqual(second.guest, {
      firstName: "Marek",
      surname1: "Nowak",
      email: "marek.nowak@example.com",
      phone: "+48600111002",
      nationality: "POL",
      documentType: "PASSPORT",
      documentNumber: "AB1234567"
    });
    assert.equal(table.rows[0]!.normalized!.roomNumber, "111");
    assert.equal(table.rows[0]!.normalized!.estimatedArrivalTime, "16:30");

    const book = writeXlsx([{ name: "Reservas", rows: [parsed.header, ...parsed.rows.map((row) => row.cells)] }]);
    const parsedXlsx = parseReservationImportFile({ contentBase64: book.toString("base64"), fileName: "plantilla-reservas.xlsx" });
    assert.equal(parsedXlsx.format, "xlsx");
    assert.deepEqual(parsedXlsx.warnings, []);
    const tableXlsx = normalizeTable(parsedXlsx, null, RIAS_ALTAS, { historico: false });
    assert.equal(reservationImportContentHash(tableXlsx.rows), reservationImportContentHash(table.rows));
  });
});

// ---- Tanda 7b · L1 · modo `sync` (estado destino, frontera temporal por destino, referencia obligatoria) ----

describe("normalizeRow · modo sync (Tanda 7b)", () => {
  const SYNC = { historico: false, splitName: false, mode: "sync" as const, statusMap: OPERA_CLOUD_STATUS_MAP };
  function sync(overrides: Overrides, options: Partial<typeof SYNC> = {}) {
    const cells = cellsOf(overrides);
    return normalizeRow({ rowNumber: 1, cells, kinds: cells.map((cell) => (cell === "" ? "empty" : "string")) }, FIELDS, CATALOGS, { ...SYNC, ...options });
  }

  it("Reserved → targetStatus confirmed, estado confirmada, sin inHouse; Cancelled → cancelada; NO SHOW → no_show", () => {
    const reserved = sync({ estado: "Reserved" });
    assert.equal(reserved.normalized?.targetStatus, "confirmed");
    assert.equal(reserved.normalized?.estado, "confirmada");
    assert.equal(reserved.normalized?.inHouse, undefined);
    assert.equal(rowStatusFromIssues(reserved.issues), "valid");
    const cancelled = sync({ estado: "Cancelled" });
    assert.equal(cancelled.normalized?.targetStatus, "cancelled");
    assert.equal(cancelled.normalized?.estado, "cancelada");
    assert.equal(sync({ estado: "NO SHOW" }).normalized?.targetStatus, "no_show");
    assert.equal(sync({ estado: "NO SHOW" }).normalized?.estado, "confirmada", "no-show se crea confirmada y se transiciona en el commit");
  });

  it("Checked In con llegada ayer y salida futura → PERMITIDA (inHouse), no IN_HOUSE_PAST ni PAST_ARRIVAL", () => {
    const result = sync({ estado: "Checked In", llegada: "2026-09-15", salida: "2026-09-18" });
    assert.ok(!codes(result).includes("RESERVATION_IMPORT_ROW_IN_HOUSE_PAST"));
    assert.ok(!codes(result).includes("RESERVATION_IMPORT_ROW_PAST_ARRIVAL"));
    assert.equal(result.normalized?.inHouse, true);
    assert.equal(result.normalized?.historical, false);
    assert.equal(result.normalized?.targetStatus, "checked_in");
    const today = sync({ estado: "In House", llegada: "2026-09-16", salida: "2026-09-18" });
    assert.equal(today.normalized?.inHouse, true);
    const future = sync({ estado: "Due In", llegada: "2026-09-20", salida: "2026-09-22" });
    assert.equal(future.normalized?.inHouse, undefined, "llegada futura: sin marca");
  });

  it("Checked Out con salida pasada → histórica SIN exigir «histórico» (aviso HISTORICAL); con salida futura → inHouse", () => {
    const past = sync({ estado: "Checked Out", llegada: "2026-09-10", salida: "2026-09-12" });
    assert.equal(past.normalized?.historical, true);
    assert.ok(codes(past).includes("RESERVATION_IMPORT_ROW_HISTORICAL"));
    assert.ok(!codes(past).includes("RESERVATION_IMPORT_ROW_PAST_ARRIVAL"));
    assert.equal(rowStatusFromIssues(past.issues), "warning");
    const early = sync({ estado: "Checked Out", llegada: "2026-09-15", salida: "2026-09-18" });
    assert.equal(early.normalized?.historical, false);
    assert.equal(early.normalized?.inHouse, true);
  });

  it("Reserved con llegada pasada → PAST_ARRIVAL (regla de siempre); Cancelled / No Show con llegada pasada → sin frontera", () => {
    const past = sync({ estado: "Reserved", llegada: "2026-09-10", salida: "2026-09-12" });
    assert.ok(codes(past).includes("RESERVATION_IMPORT_ROW_PAST_ARRIVAL"));
    assert.equal(past.normalized, undefined);
    const historic = sync({ estado: "Reserved", llegada: "2026-09-10", salida: "2026-09-12" }, { historico: true });
    assert.equal(historic.normalized?.historical, true, "con «histórico» sigue funcionando como en create");
    const cancelled = sync({ estado: "Cancelled", llegada: "2026-09-10", salida: "2026-09-12" });
    assert.ok(!codes(cancelled).includes("RESERVATION_IMPORT_ROW_PAST_ARRIVAL"));
    assert.equal(cancelled.normalized?.estado, "cancelada");
    const noShow = sync({ estado: "No Show", llegada: "2026-09-15", salida: "2026-09-16" });
    assert.equal(noShow.normalized?.targetStatus, "no_show");
    assert.equal(rowStatusFromIssues(noShow.issues), "valid");
  });

  it("Waitlist → OPERA_WAITLIST_SKIPPED (omitida, con fila normalizada); estado fuera del diccionario o vacío → INVALID_STATUS", () => {
    const waitlist = sync({ estado: "Waitlist" });
    assert.ok(codes(waitlist).includes("RESERVATION_IMPORT_ROW_OPERA_WAITLIST_SKIPPED"));
    assert.equal(rowStatusFromIssues(waitlist.issues), "skipped");
    assert.equal(waitlist.normalized?.targetStatus, "skip");
    const unknown = sync({ estado: "tentativa" });
    assert.ok(codes(unknown).includes("RESERVATION_IMPORT_ROW_INVALID_STATUS"), "en sync manda el diccionario del perfil, no los sinónimos de create");
    assert.equal(unknown.normalized, undefined);
    const empty = sync({ estado: "" });
    assert.ok(codes(empty).includes("RESERVATION_IMPORT_ROW_INVALID_STATUS"));
    assert.ok(codes(sync({ estado: "Reserved" }, { statusMap: {} })).includes("RESERVATION_IMPORT_ROW_INVALID_STATUS"), "diccionario vacío → todo estado es inválido");
  });

  it("fila sin referencia_externa → SYNC_REQUIRES_REFERENCE (error); en create sigue siendo opcional", () => {
    const missing = sync({ estado: "Reserved", referencia_externa: "" });
    assert.ok(codes(missing).includes("RESERVATION_IMPORT_ROW_SYNC_REQUIRES_REFERENCE"));
    assert.equal(rowStatusFromIssues(missing.issues), "error");
    assert.equal(missing.normalized, undefined);
    const create = run({ referencia_externa: "" });
    assert.ok(!codes(create).includes("RESERVATION_IMPORT_ROW_SYNC_REQUIRES_REFERENCE"));
    assert.ok(create.normalized);
    for (const issue of missing.issues) assert.doesNotMatch(issue.message, /Ferreiro|example/);
  });

  it("normalizeTable con mode sync propaga targetStatus e inHouse; en create no existe targetStatus y los sinónimos de estado siguen mandando", () => {
    const header = ["referencia_externa", "llegada", "salida", "tipo_habitacion", "nombre", "apellidos", "estado"];
    const rows = [
      ["RIAS-1", "2026-09-15", "2026-09-18", "DBL", "Lucía", "Ferreiro", "CHECKED IN"],
      ["RIAS-2", "2026-10-01", "2026-10-03", "DBL", "Marek", "Nowak", "Confirmed"]
    ];
    const parsed = { header, rows: rows.map((cells, index) => ({ rowNumber: index + 1, line: index + 2, cells, kinds: cells.map(() => "string" as const) })) };
    const synced = normalizeTable(parsed, null, CATALOGS, { historico: false, mode: "sync", statusMap: OPERA_CLOUD_STATUS_MAP });
    assert.equal(synced.rows[0]!.normalized?.targetStatus, "checked_in");
    assert.equal(synced.rows[0]!.normalized?.inHouse, true);
    assert.equal(synced.rows[0]!.status, "valid");
    assert.equal(synced.rows[1]!.normalized?.targetStatus, "confirmed");
    const created = normalizeTable(parsed, null, CATALOGS, { historico: false });
    assert.equal(created.rows[0]!.status, "error", "en create «CHECKED IN» no es un estado admitido");
    assert.equal(created.rows[1]!.normalized?.targetStatus, undefined);
    assert.equal(created.rows[1]!.normalized?.estado, "confirmada");
  });
});
