// Unit tests · Tanda 7d — funciones puras del CLI de la carga real de OPERA Cloud
// (`import-opera-reports.ts`): flags, fechas OPERA, pseudo rooms, dedupe de llegadas, nombres,
// orden, habitaciones en blanco por solape, ocupación, tipo físico, enriquecimiento C9, canal /
// segmento / pago / garantía, notas, denylist de salida, troceo, plan de inventario, propuestas de
// tipos y resumen. Sin BD y con filas INVENTADAS (nunca datos de los informes reales). Desde apps/api:
//   node --import tsx --test src/scripts/__tests__/import-opera-reports.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESERVATION_IMPORT_FIELDS, RESERVATION_IMPORT_MAX_ROWS } from "@hotelos/shared";
import {
  ARRIVAL_COLUMNS,
  CANONICAL_HEADER,
  COMMANDS,
  OPERA_EXTRA_FIELDS,
  OUTPUT_DENYLIST,
  ROOM_TYPE_PROPOSALS,
  STAY_COLUMNS,
  USAGE,
  applyPhysicalTypes,
  augustRoomNights,
  blankOverlappingRooms,
  buildBackfillPlan,
  buildInventoryPlan,
  buildNotes,
  buildRoomCatalog,
  buildSyncBody,
  cellByName,
  channelOfAgency,
  chunkRows,
  clampOccupancy,
  decimalOf,
  dedupeArrivals,
  deriveChannel,
  deriveSegment,
  enrichReservedFromArrivals,
  expectedExtras,
  expectedFromSummary,
  floorOf,
  formatAmount,
  formatAmountTimes,
  formatReconciliation,
  formatSummary,
  guaranteeOf,
  indexColumns,
  isDeniedColumn,
  isPseudoCategory,
  mapGuarantee,
  mapPayment,
  maxOccupancyOf,
  orderStayRows,
  parseFlags,
  parseOperaDate,
  physicalTypeOf,
  readArrivalRows,
  readCanonicalCsv,
  readStayRows,
  reconcileRaw,
  splitOperaName,
  stripEstimatedNote,
  stripPartyPrefix,
  summarizeFeed,
  toCanonicalCsv,
  toCanonicalRow,
  type BackfillReservation,
  type CanonicalRow,
  type HotelSummary,
  type OperaExtraField,
  type OperaRow,
  type PrepSummary,
  type ReadResult
} from "../import-opera-reports.js";

// ---------------------------------------------------------------------------
// Filas inventadas
// ---------------------------------------------------------------------------

function row(extra: Partial<OperaRow> = {}): OperaRow {
  return {
    kind: "stay",
    rowNumber: 1,
    reference: "10000001",
    confirmationNo: "",
    externalReference: "",
    status: "CHECKED OUT",
    arrival: "2026-08-10",
    departure: "2026-08-12",
    nights: 2,
    category: "DND2",
    roomType: "DND2",
    room: "101",
    roomOpera: "",
    roomsCount: 1,
    adults: 2,
    children: 0,
    personsOpera: null,
    fullName: "Ficticio Inventado, Prueba",
    company: "",
    agency: "",
    group: "",
    channel: "direct",
    segment: "leisure",
    payment: "",
    vip: "",
    deposit: "",
    total: "200,00",
    currency: "EUR",
    rateCode: "BASE",
    ratePerNight: "100,00",
    guarantee: "CHECKED IN",
    guaranteeDesc: "Checked In",
    market: "",
    origin: "",
    groupId: "",
    blockCode: "",
    products: "",
    vipLevel: "",
    compHouse: "",
    insertDate: "2026-07-01",
    paymentCode: "",
    estimatedTotal: false,
    enriched: false,
    ...extra
  };
}

/** Tabla de estancias inventada con las 40 cabeceras reales (los valores son ficticios). */
const STAY_HEADER = ["RESORT", "GRPBY_DISP1", "ROOM_CLASS", "GRPBY_DISP2", "RESV_NAME_ID", "GUARANTEE_CODE", "RESV_STATUS", "ROOM", "FULL_NAME", "DEPARTURE", "PERSONS", "GROUP_NAME", "NO_OF_ROOMS", "ROOM_CATEGORY_LABEL", "RATE_CODE", "INSERT_USER", "INSERT_DATE", "GUARANTEE_CODE_DESC", "COMPANY_NAME", "TRAVEL_AGENT_NAME", "ARRIVAL", "NIGHTS", "COMP_HOUSE_YN", "SHARE_AMOUNT", "C_T_S_NAME", "SHORT_RESV_STATUS", "SHARE_AMOUNT_PER_STAY", "RC_NTS", "RC_RMS", "RC_PRS", "RC_RATE", "RES_NTS", "RES_RMS", "RES_PRS", "RES_RATE", "SUMNO_OF_ROOMSPERREPORT", "SUMPERSONSPERREPORT", "S_NTS", "LOGO", "S_RATE"];

type StayCells = Partial<Record<(typeof STAY_HEADER)[number], string>>;

function stayCells(values: StayCells): string[] {
  const defaults: StayCells = {
    RESORT: "ES999",
    RESV_NAME_ID: "10000001",
    GUARANTEE_CODE: "CHECKED IN",
    RESV_STATUS: "CHECKED OUT",
    ROOM: "101",
    FULL_NAME: "Ficticio Inventado, Prueba",
    DEPARTURE: "12/08/26",
    PERSONS: "2",
    NO_OF_ROOMS: "1",
    ROOM_CATEGORY_LABEL: "DND2",
    RATE_CODE: "BASE",
    INSERT_USER: "SENTINEL_INSERT_USER",
    INSERT_DATE: "01/07/26",
    GUARANTEE_CODE_DESC: "Checked In",
    ARRIVAL: "10/08/26",
    NIGHTS: "2",
    SHARE_AMOUNT: "100",
    SHARE_AMOUNT_PER_STAY: "200",
    RC_NTS: "SENTINEL_RC",
    RES_RATE: "SENTINEL_RES",
    S_RATE: "SENTINEL_S",
    LOGO: "SENTINEL_LOGO",
    SUMPERSONSPERREPORT: "SENTINEL_SUM"
  };
  const merged = { ...defaults, ...values };
  return STAY_HEADER.map((column) => merged[column] ?? "");
}

function table(header: readonly string[], rows: string[][]) {
  return { header: [...header], rows: rows.map((cells, index) => ({ rowNumber: index + 1, line: index + 2, cells, kinds: cells.map(() => "string" as const) })) };
}

const ARRIVAL_HEADER = [...ARRIVAL_COLUMNS, "INSERT_USER", "UPDATE_USER", "CREDIT_CARD_NUMBER", "EXP_DATE", "BILL_TO_ADDRESS", "SHARE_NAMES", "ACCOMPANYING_NAMES", "MEMBERSHIP_CARD_NO", "TRX_STRING", "TRACE_TEXT", "FC_PRICE", "BILL_RESV", "GUEST_NAME_ID", "SUM_ROOMS", "LOGO", "UPDATE_DATE"];

type ArrivalCells = Partial<Record<(typeof ARRIVAL_HEADER)[number], string>>;

function arrivalCells(values: ArrivalCells): string[] {
  const defaults: ArrivalCells = {
    CONFIRMATION_NO: "270000001",
    RESV_NAME_ID: "10000009",
    EXTERNAL_REFERENCE: "55555555",
    ARRIVAL: "18/09/26",
    DEPARTURE: "20/09/26",
    ROOM_CATEGORY_LABEL: "DND2",
    DISP_ROOM_NO: "101",
    NO_OF_ROOMS: "1",
    ADULTS: "2",
    CHILDREN: "0",
    PERSONS: "2",
    MARKET_CODE: "TACO",
    RATE_CODE: "SP2BK",
    GUARANTEE_CODE: "CC",
    COMPANY_NAME: "T- Booking.Com",
    ORIGIN_OF_BOOKING: "CRS",
    SHARE_AMOUNT: "64.13",
    CURRENCY_CODE: "EUR",
    DEPOSIT_PAID: "0",
    PAYMENT_METHOD: "MC",
    FULL_NAME: "Probando, Ejemplo",
    INSERT_USER: "SENTINEL_INSERT_USER",
    UPDATE_USER: "SENTINEL_UPDATE_USER",
    CREDIT_CARD_NUMBER: "SENTINEL_CARD",
    EXP_DATE: "SENTINEL_EXP",
    BILL_TO_ADDRESS: "SENTINEL_BILL",
    SHARE_NAMES: "SENTINEL_SHARE",
    ACCOMPANYING_NAMES: "SENTINEL_ACC",
    MEMBERSHIP_CARD_NO: "SENTINEL_MEMB",
    TRX_STRING: "SENTINEL_TRX",
    TRACE_TEXT: "SENTINEL_TRACE",
    FC_PRICE: "SENTINEL_FC",
    BILL_RESV: "SENTINEL_BILLRESV",
    GUEST_NAME_ID: "SENTINEL_GUESTID",
    SUM_ROOMS: "SENTINEL_SUM",
    LOGO: "SENTINEL_LOGO",
    UPDATE_DATE: "18-SEP-26"
  };
  const merged = { ...defaults, ...values };
  return ARRIVAL_HEADER.map((column) => merged[column] ?? "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseFlags · USAGE", () => {
  it("prep: --in, --out, --hotel y --chunk; defectos (all, 5000, dry-run, sin json)", () => {
    const flags = parseFlags(["prep", "--in", "/tmp/in", "--out", "/tmp/out", "--hotel", "RA", "--chunk", "1000"]);
    assert.equal(flags.command, "prep");
    assert.equal(flags.in, "/tmp/in");
    assert.equal(flags.out, "/tmp/out");
    assert.equal(flags.hotel, "RA");
    assert.equal(flags.chunk, 1000);
    assert.equal(flags.apply, false);
    assert.equal(flags.json, false);
    assert.equal(parseFlags(["prep", "--in", "a", "--out", "b"]).hotel, "all");
    assert.equal(parseFlags(["prep", "--in", "a", "--out", "b"]).chunk, RESERVATION_IMPORT_MAX_ROWS);
    for (const command of COMMANDS) assert.ok(USAGE.includes(command), command);
    assert.ok(USAGE.includes("--business-date"));
  });

  it("apply, undo, verify, demo-retire e inventory: flags obligatorios y listas", () => {
    const apply = parseFlags(["apply", "--property", "p1", "--file", "x.csv", "--feed", "inhouse", "--business-date", "2026-09-18", "--apply", "--force", "--json"]);
    assert.equal(apply.feed, "inhouse");
    assert.equal(apply.businessDate, "2026-09-18");
    assert.equal(apply.apply, true);
    assert.equal(apply.force, true);
    assert.equal(apply.json, true);
    const undo = parseFlags(["undo", "--property", "p1", "--import", "imp_1", "--reason", "motivo"]);
    assert.equal(undo.importId, "imp_1");
    assert.equal(undo.reason, "motivo");
    const verify = parseFlags(["verify", "--property", "p1", "--expected", "RESUMEN.json", "--hotel", "LT"]);
    assert.equal(verify.expected, "RESUMEN.json");
    const verifyRaw = parseFlags(["verify", "--property", "p1", "--in", "/xlsx", "--hotel", "LT"]);
    assert.deepEqual([verifyRaw.in, verifyRaw.expected], ["/xlsx", null], "verify admite solo --in (xlsx brutos)");
    const backfill = parseFlags(["backfill", "--property", "p1", "--hotel", "RA", "--out", "/prep", "--apply"]);
    assert.deepEqual([backfill.command, backfill.hotel, backfill.out, backfill.apply], ["backfill", "RA", "/prep", true]);
    const retire = parseFlags(["demo-retire", "--property", "p1", "--cancel", "RES-1, RES-2,", "--checkout", "RES-3"]);
    assert.deepEqual(retire.cancel, ["RES-1", "RES-2"]);
    assert.deepEqual(retire.checkout, ["RES-3"]);
    const inventory = parseFlags(["inventory", "--property", "p1", "--plan", "RA-inventario.json", "--apply"]);
    assert.equal(inventory.plan, "RA-inventario.json");
    assert.equal(parseFlags(["--help"]).help, true);
  });

  it("errores de uso: subcomando desconocido, flags obligatorios, valores inválidos, exclusiones", () => {
    assert.throws(() => parseFlags(["foo"]), /Subcomando desconocido/);
    assert.throws(() => parseFlags(["--json"]), /Falta el subcomando/);
    assert.throws(() => parseFlags(["prep", "--in", "a"]), /--in <dir> y --out <dir>/);
    assert.throws(() => parseFlags(["prep", "--in", "a", "--out", "b", "--apply"]), /no admite --apply/);
    assert.throws(() => parseFlags(["prep", "--in", "a", "--out", "b", "--hotel", "ZZ"]), /--hotel debe ser/);
    assert.throws(() => parseFlags(["prep", "--in", "a", "--out", "b", "--chunk", "0"]), /--chunk/);
    assert.throws(() => parseFlags(["apply", "--property", "p", "--file", "f", "--feed", "departures", "--business-date", "2026-09-18"]), /--feed debe ser/);
    assert.throws(() => parseFlags(["apply", "--property", "p", "--file", "f", "--feed", "arrivals", "--business-date", "2026-02-30"]), /--business-date/);
    assert.throws(() => parseFlags(["apply", "--property", "p", "--file", "f", "--feed", "arrivals"]), /apply exige/);
    assert.throws(() => parseFlags(["apply", "--property", "p", "--file", "f", "--feed", "arrivals", "--business-date", "2026-09-18", "--dry-run", "--apply"]), /excluyentes/);
    assert.throws(() => parseFlags(["verify", "--property", "p", "--expected", "r.json"]), /verify exige/);
    assert.throws(() => parseFlags(["verify", "--property", "p", "--hotel", "RA"]), /al menos uno de --expected/);
    assert.throws(() => parseFlags(["backfill", "--property", "p", "--hotel", "RA"]), /backfill exige/);
    assert.throws(() => parseFlags(["backfill", "--property", "p", "--out", "/prep"]), /backfill exige/);
    assert.throws(() => parseFlags(["demo-retire", "--property", "p"]), /--cancel y\/o --checkout/);
    assert.throws(() => parseFlags(["demo-retire", "--property", "p", "--cancel", "RES-1", "--apply"]), /exige --reason/);
    assert.throws(() => parseFlags(["undo", "--property", "p"]), /undo exige/);
    assert.throws(() => parseFlags(["prep", "--in", "a", "--out", "b", "--in", "c"]), /solo puede indicarse una vez/);
    assert.throws(() => parseFlags(["prep", "--in", "a", "--out", "b", "--bogus"]), /Flag desconocido/);
    assert.throws(() => parseFlags(["prep", "--in"]), /necesita un valor/);
  });
});

describe("parseOperaDate · isPseudoCategory · importes · planta", () => {
  it("DD/MM/YY y DD-MON-YY → ISO; ISO tal cual; inválidas → null", () => {
    assert.equal(parseOperaDate("18/09/26"), "2026-09-18");
    assert.equal(parseOperaDate("01/01/26"), "2026-01-01");
    assert.equal(parseOperaDate("18-SEP-26"), "2026-09-18");
    assert.equal(parseOperaDate("23-jul-26"), "2026-07-23");
    assert.equal(parseOperaDate("2026-09-18"), "2026-09-18");
    assert.equal(parseOperaDate("31/02/26"), null);
    assert.equal(parseOperaDate("18/9/26"), null, "OPERA siempre escribe dos dígitos");
    assert.equal(parseOperaDate(""), null);
    assert.equal(parseOperaDate("18-XYZ-26"), null);
  });

  it("PI / PM y habitaciones 9000-9500 son pseudo; DND2 en la 101 no", () => {
    assert.equal(isPseudoCategory("PI", "9100"), true);
    assert.equal(isPseudoCategory("pm", "9001"), true);
    assert.equal(isPseudoCategory("DND2", "9500"), true);
    assert.equal(isPseudoCategory("DND2", "9501"), false);
    assert.equal(isPseudoCategory("DND2", "101"), false);
    assert.equal(isPseudoCategory("KND1", "001"), false, "001-016 son habitaciones reales de Marsol y Rías Altas");
  });

  it("formatAmount: «238» → «238,00», «1931.5» → «1931,50», «97,75» → «97,75», vacío → «»; × noches con redondeo", () => {
    assert.equal(formatAmount("238"), "238,00");
    assert.equal(formatAmount("1931.5"), "1931,50");
    assert.equal(formatAmount("97,75"), "97,75");
    assert.equal(formatAmount("0"), "0,00");
    assert.equal(formatAmount(""), "");
    assert.equal(formatAmount("abc"), "");
    assert.equal(formatAmountTimes("64.13", 2), "128,26");
    assert.equal(formatAmountTimes("33.333", 3), "100,00");
    assert.equal(formatAmountTimes("", 3), "");
  });

  it("floorOf: «001» → 0, «101» → 1, «1001» → 10", () => {
    assert.equal(floorOf("001"), "0");
    assert.equal(floorOf("101"), "1");
    assert.equal(floorOf("1001"), "10");
    assert.equal(floorOf("9"), "0");
  });
});

describe("dedupeArrivals · splitOperaName · orderStayRows · chunkRows", () => {
  it("dedupe por CONFIRMATION_NO: gana la primera fila; sin nº de confirmación no se deduplica", () => {
    const header = ["CONFIRMATION_NO", "X"];
    const rows = [
      { rowNumber: 1, cells: ["270000001", "a"] },
      { rowNumber: 2, cells: ["270000001", "b"] },
      { rowNumber: 3, cells: ["270000002", "c"] },
      { rowNumber: 4, cells: ["", "d"] },
      { rowNumber: 5, cells: ["", "e"] },
      { rowNumber: 6, cells: ["270000001", "f"] }
    ];
    const { unique, duplicates } = dedupeArrivals(rows, indexColumns(header));
    assert.deepEqual(unique.map((r) => r.rowNumber), [1, 3, 4, 5]);
    assert.deepEqual(duplicates, [2, 6]);
    assert.equal(unique[0]!.cells[1], "a", "la primera fila gana");
  });

  it("splitOperaName: coma → apellidos/nombre; sin coma → primer token nombre y resto apellidos; un token → ambos", () => {
    assert.deepEqual(splitOperaName("Ficticio Inventado, Prueba"), { firstName: "Prueba", surnames: "Ficticio Inventado", kind: "comma" });
    assert.deepEqual(splitOperaName("  Probando ,  Ejemplo  "), { firstName: "Ejemplo", surnames: "Probando", kind: "comma" });
    assert.deepEqual(splitOperaName("Prueba Ficticio Inventado"), { firstName: "Prueba", surnames: "Ficticio Inventado", kind: "no_comma" });
    assert.deepEqual(splitOperaName("Ficticio"), { firstName: "Ficticio", surnames: "Ficticio", kind: "single" });
    assert.deepEqual(splitOperaName("Ficticio,"), { firstName: "Ficticio", surnames: "Ficticio", kind: "single" });
    assert.deepEqual(splitOperaName(""), { firstName: "", surnames: "", kind: "single" });
  });

  it("orderStayRows: CANCELLED, NO SHOW, CHECKED OUT (por llegada), RESERVED y CHECKED IN al final", () => {
    const rows = [
      row({ rowNumber: 1, status: "CHECKED IN", arrival: "2026-09-15" }),
      row({ rowNumber: 2, status: "CHECKED OUT", arrival: "2026-08-20" }),
      row({ rowNumber: 3, status: "RESERVED", arrival: "2026-09-18" }),
      row({ rowNumber: 4, status: "CANCELLED", arrival: "2026-09-01" }),
      row({ rowNumber: 5, status: "CHECKED OUT", arrival: "2026-08-02" }),
      row({ rowNumber: 6, status: "NO SHOW", arrival: "2026-08-10" }),
      row({ rowNumber: 7, status: "CHECKED OUT", arrival: "2026-08-02", reference: "10000000" })
    ];
    assert.deepEqual(orderStayRows(rows).map((r) => r.rowNumber), [4, 6, 7, 5, 2, 3, 1]);
    assert.equal(rows[0]!.rowNumber, 1, "no muta la entrada");
  });

  it("chunkRows: ≤ 5000 filas por trozo; vacío → un trozo vacío", () => {
    const rows = Array.from({ length: 12 }, (_, i) => i);
    assert.deepEqual(chunkRows(rows, 5).map((chunk) => chunk.length), [5, 5, 2]);
    assert.deepEqual(chunkRows(rows).map((chunk) => chunk.length), [12]);
    assert.deepEqual(chunkRows(rows, 999_999).map((chunk) => chunk.length), [12], "el tope es RESERVATION_IMPORT_MAX_ROWS");
    assert.deepEqual(chunkRows([]), [[]]);
  });
});

describe("blankOverlappingRooms · clampOccupancy · tipo físico · enriquecimiento", () => {
  it("canceladas y no-show pierden la habitación (número a roomOpera); sin solapes nada más cambia", () => {
    const rows = [row({ rowNumber: 1, status: "CANCELLED", room: "101" }), row({ rowNumber: 2, status: "NO SHOW", room: "102" }), row({ rowNumber: 3, status: "CHECKED OUT", room: "103" })];
    const counts = blankOverlappingRooms(rows);
    assert.deepEqual(counts, { dead: 2, overlap: 0, historicalKept: 0 });
    assert.equal(rows[0]!.room, "");
    assert.equal(rows[0]!.roomOpera, "101");
    assert.equal(rows[1]!.room, "");
    assert.equal(rows[2]!.room, "103");
  });

  it("solape en la misma habitación: se blanquea la que NO es CHECKED IN; dos CHECKED OUT solapadas (cambio de habitación) conservan las dos; sin solape se conservan", () => {
    const rows = [
      row({ rowNumber: 1, status: "CHECKED OUT", room: "201", arrival: "2026-09-10", departure: "2026-09-20" }),
      row({ rowNumber: 2, status: "CHECKED IN", room: "201", arrival: "2026-09-16", departure: "2026-09-19" }),
      row({ rowNumber: 3, status: "CHECKED OUT", room: "202", arrival: "2026-08-01", departure: "2026-08-05" }),
      row({ rowNumber: 4, status: "CHECKED OUT", room: "202", arrival: "2026-08-03", departure: "2026-08-06" }),
      row({ rowNumber: 5, status: "CHECKED OUT", room: "202", arrival: "2026-08-05", departure: "2026-08-07" }),
      row({ rowNumber: 6, status: "RESERVED", room: "201", arrival: "2026-09-18", departure: "2026-09-21" }),
      row({ rowNumber: 7, status: "CHECKED OUT", room: "203", arrival: "2026-08-10", departure: "2026-08-17" }),
      row({ rowNumber: 8, status: "CHECKED OUT", room: "203", arrival: "2026-08-10", departure: "2026-08-11" }),
      row({ rowNumber: 9, status: "CHECKED OUT", room: "203", arrival: "2026-08-13", departure: "2026-08-14" }),
      row({ rowNumber: 10, status: "RESERVED", room: "204", arrival: "2026-09-19", departure: "2026-09-22" }),
      row({ rowNumber: 11, status: "RESERVED", room: "204", arrival: "2026-09-20", departure: "2026-09-23" })
    ];
    const counts = blankOverlappingRooms(rows);
    assert.equal(rows[0]!.room, "", "la CHECKED OUT que solapa a la CHECKED IN se blanquea aunque llegara antes");
    assert.equal(rows[1]!.room, "201");
    assert.equal(rows[2]!.room, "202");
    assert.equal(rows[3]!.room, "202", "dos CHECKED OUT solapadas: cambio de habitación a mitad de estancia, las dos conservan la habitación (FO-04)");
    assert.equal(rows[4]!.room, "202", "[05,07) no solapa con [01,05) ni con [03,06)… sí con [03,06): también cerrada, se conserva");
    assert.equal(rows[5]!.room, "", "la RESERVED que solapa a la CHECKED IN se blanquea");
    assert.equal(rows[6]!.room, "203");
    assert.equal(rows[7]!.room, "203", "estancia larga cerrada + cortas cerradas en la misma habitación: historia, se conservan");
    assert.equal(rows[8]!.room, "203");
    assert.equal(rows[9]!.room, "204");
    assert.equal(rows[10]!.room, "", "dos RESERVED solapadas (vivas): la posterior se blanquea");
    assert.deepEqual(counts, { dead: 0, overlap: 3, historicalKept: 4 });
  });

  it("clampOccupancy: PERSONS 0 → 1; adultos + niños > máximo del tipo → recorte con PERSONS OPERA; máximo × habitaciones", () => {
    const rows = [row({ adults: 0 }), row({ roomType: "TND1", adults: 3 }), row({ roomType: "DND2", adults: 2, children: 2 }), row({ roomType: "DND2", adults: 3 }), row({ roomType: "DND2", roomsCount: 2, adults: 5 }), row({ roomType: "ZZZZ", adults: 4 })];
    const clamped = clampOccupancy(rows);
    assert.equal(rows[0]!.adults, 1);
    assert.equal(rows[0]!.personsOpera, null);
    assert.deepEqual([rows[1]!.adults, rows[1]!.children, rows[1]!.personsOpera], [2, 0, 3]);
    assert.deepEqual([rows[2]!.adults, rows[2]!.children, rows[2]!.personsOpera], [1, 2, 4]);
    assert.equal(rows[3]!.personsOpera, null, "3 en DND2 (máx 3) no se recorta");
    assert.equal(rows[4]!.personsOpera, null, "5 en 2 × DND2 no se recorta");
    assert.equal(rows[5]!.personsOpera, null, "tipo desconocido → máximo 4");
    assert.equal(clamped, 2);
    assert.equal(maxOccupancyOf("KNE1"), 5);
    assert.equal(maxOccupancyOf("tnd2"), 2);
  });

  it("buildRoomCatalog: categoría dominante por habitación (moda); physicalTypeOf y applyPhysicalTypes solo cuando difiere", () => {
    const catalog = buildRoomCatalog([
      row({ room: "232", category: "DND4" }),
      row({ room: "232", category: "DND4" }),
      row({ room: "232", category: "TND3" }),
      row({ room: "101", category: "DND3" }),
      row({ room: "9100", category: "PI" }),
      row({ room: "", category: "DND2" })
    ]);
    assert.equal(physicalTypeOf("232", catalog), "DND4");
    assert.equal(physicalTypeOf("101", catalog), "DND3");
    assert.equal(physicalTypeOf("9100", catalog), null, "las pseudo no entran");
    assert.equal(physicalTypeOf("999", catalog), null);
    assert.deepEqual(catalog.get("232")?.categories, { DND4: 2, TND3: 1 });
    const rows = [row({ room: "232", category: "TND3", roomType: "TND3" }), row({ room: "101", category: "DND3", roomType: "DND3" }), row({ room: "", category: "TND3", roomType: "TND3" })];
    assert.equal(applyPhysicalTypes(rows, catalog), 1);
    assert.equal(rows[0]!.roomType, "DND4");
    assert.equal(rows[0]!.category, "TND3", "la categoría OPERA se conserva para las notas");
    assert.equal(rows[2]!.roomType, "TND3", "sin habitación no se toca");
  });

  it("enrichReservedFromArrivals (C9): solo las RESERVED con fila de llegadas; copia canal, segmento, pago, VIP, depósito, grupo, ocupación y datos de notas", () => {
    const stays = [row({ reference: "10000009", status: "RESERVED", arrival: "2026-09-18", channel: "direct", segment: "leisure", adults: 2 }), row({ reference: "10000010", status: "RESERVED" }), row({ reference: "10000009", status: "CHECKED OUT", channel: "direct" })];
    const arrivals = [row({ kind: "arrival", reference: "10000009", confirmationNo: "270000001", externalReference: "5555", channel: "booking_com", segment: "wholesale", payment: "credit_card", paymentCode: "MC", vip: "si", vipLevel: "Gold", deposit: "50,00", group: "BLK1", groupId: "77", blockCode: "BLK1", adults: 1, children: 1, market: "TACO", origin: "CRS", products: "AD" })];
    assert.equal(enrichReservedFromArrivals(stays, arrivals), 1);
    const enriched = stays[0]!;
    assert.equal(enriched.enriched, true);
    assert.equal(enriched.channel, "booking_com");
    assert.equal(enriched.segment, "wholesale");
    assert.equal(enriched.payment, "credit_card");
    assert.equal(enriched.vip, "si");
    assert.equal(enriched.deposit, "50,00");
    assert.equal(enriched.group, "BLK1");
    assert.deepEqual([enriched.adults, enriched.children], [1, 1]);
    assert.equal(enriched.confirmationNo, "270000001");
    assert.equal(enriched.market, "TACO");
    assert.equal(enriched.total, "200,00", "el importe de estancias (SHARE_AMOUNT_PER_STAY) se conserva");
    assert.equal(stays[1]!.enriched, false);
    assert.equal(stays[2]!.enriched, false, "una CHECKED OUT no se enriquece aunque coincida la referencia");
  });
});

describe("canal · segmento · pago · garantía · notas", () => {
  it("deriveChannel (estancias): agencia → diccionario; empresa → corporate; grupo / LGRU → group; cortesía → direct; resto direct", () => {
    assert.equal(channelOfAgency("Booking.Com"), "booking_com");
    assert.equal(channelOfAgency("Travelscape LLC"), "expedia");
    assert.equal(channelOfAgency("Expedia Affiliate Network"), "expedia");
    assert.equal(channelOfAgency("Hotels.Com"), "hotels_com");
    assert.equal(channelOfAgency("TRIP .COM TRAVEL"), "ota");
    assert.equal(channelOfAgency("EDREAMS ODIGEO S.A"), "ota");
    assert.equal(channelOfAgency("AGODA COMPANY PTE LTD"), "ota");
    assert.equal(channelOfAgency("WORLD 2 MEET, S.L.U."), "wholesale");
    assert.equal(channelOfAgency("JUMBONLINE ACCOMMODATIONS & SERVICES SL"), "wholesale");
    assert.equal(channelOfAgency("TIP"), "wholesale");
    assert.equal(channelOfAgency("NUEVO COLOR SL"), "wholesale");
    assert.equal(channelOfAgency("VIAJES FICTICIOS S.L.U"), "agency");
    assert.equal(channelOfAgency(""), null);
    assert.equal(deriveChannel(row({ agency: "Booking.Com", company: "EMPRESA FICTICIA SL" })), "booking_com", "la agencia manda");
    assert.equal(deriveChannel(row({ company: "EMPRESA FICTICIA SL" })), "corporate");
    assert.equal(deriveChannel(row({ group: "GRUPO FICTICIO" })), "group");
    assert.equal(deriveChannel(row({ rateCode: "LGRUGO" })), "group");
    assert.equal(deriveChannel(row({ rateCode: "SZHOUS" })), "direct");
    assert.equal(deriveChannel(row({})), "direct");
  });

  it("deriveChannel (llegadas): COMPANY_NAME con prefijo y, si no, ORIGIN_OF_BOOKING; origen desconocido tal cual", () => {
    assert.deepEqual(stripPartyPrefix("T- Booking.Com"), { kind: "agency", name: "Booking.Com" });
    assert.deepEqual(stripPartyPrefix("C- EMPRESA FICTICIA"), { kind: "company", name: "EMPRESA FICTICIA" });
    assert.deepEqual(stripPartyPrefix("SIN PREFIJO"), { kind: "none", name: "SIN PREFIJO" });
    const arrival = (extra: Partial<OperaRow>) => row({ kind: "arrival", ...extra });
    assert.equal(deriveChannel(arrival({ agency: "Booking.Com" })), "booking_com");
    assert.equal(deriveChannel(arrival({ company: "EMPRESA FICTICIA" })), "corporate");
    assert.equal(deriveChannel(arrival({ origin: "WEB" })), "direct");
    assert.equal(deriveChannel(arrival({ origin: "EML" })), "email");
    assert.equal(deriveChannel(arrival({ origin: "WLK" })), "walk_in");
    assert.equal(deriveChannel(arrival({ origin: "WKI" })), "walk_in");
    assert.equal(deriveChannel(arrival({ origin: "CRS" })), "gds");
    assert.equal(deriveChannel(arrival({ origin: "SAL" })), "corporate");
    assert.equal(deriveChannel(arrival({ origin: "SLC" })), "corporate");
    assert.equal(deriveChannel(arrival({ origin: "HTP" })), "phone");
    assert.equal(deriveChannel(arrival({ origin: "XX" })), "direct");
    assert.equal(deriveChannel(arrival({ origin: "GPI" })), "direct");
    assert.equal(deriveChannel(arrival({ origin: "HSE" })), "direct");
    assert.equal(deriveChannel(arrival({ origin: "ZZZ" })), "ZZZ", "no cubierto: el importador avisa CHANNEL_UNKNOWN");
    assert.equal(deriveChannel(arrival({ origin: "" })), "direct");
  });

  it("deriveSegment: llegadas por MARKET_CODE (GR_* group, CORP, COMP, TACO, FLEX…); estancias cortesía > empresa > grupo > mayorista > leisure", () => {
    const arrival = (extra: Partial<OperaRow>) => row({ kind: "arrival", ...extra });
    assert.equal(deriveSegment(arrival({ market: "GR_TW" })), "group");
    assert.equal(deriveSegment(arrival({ market: "GR_AC" })), "group");
    assert.equal(deriveSegment(arrival({ market: "CORP" })), "corporate");
    assert.equal(deriveSegment(arrival({ market: "COMP" })), "complimentary");
    assert.equal(deriveSegment(arrival({ market: "TACO" })), "wholesale");
    for (const market of ["FLEX", "PKG", "OPBU", "PREP", "QUAL", "XXX"]) assert.equal(deriveSegment(arrival({ market })), "leisure", market);
    assert.equal(deriveSegment(arrival({ market: "NUEVO" })), "NUEVO");
    assert.equal(deriveSegment(arrival({ market: "" })), "leisure");
    assert.equal(deriveSegment(row({ compHouse: "HC", group: "GRUPO" })), "complimentary");
    assert.equal(deriveSegment(row({ rateCode: "LCOMPL" })), "complimentary");
    assert.equal(deriveSegment(row({ company: "EMPRESA" })), "corporate");
    assert.equal(deriveSegment(row({ group: "GRUPO" })), "group");
    assert.equal(deriveSegment(row({ agency: "WORLD 2 MEET SLU" })), "wholesale");
    assert.equal(deriveSegment(row({ agency: "Booking.Com" })), "leisure");
  });

  it("mapPayment y mapGuarantee", () => {
    assert.equal(mapPayment("CA"), "cash");
    assert.equal(mapPayment("ef"), "cash");
    for (const code of ["MC", "VI", "AX"]) assert.equal(mapPayment(code), "credit_card");
    assert.equal(mapPayment("DB"), "company_invoice");
    assert.equal(mapPayment("TR"), "bank_transfer");
    for (const code of ["BOO", "DEPFW", "EXP"]) assert.equal(mapPayment(code), "online_prepaid");
    assert.equal(mapPayment("ZZ"), "");
    assert.equal(mapPayment(""), "");
    assert.equal(mapGuarantee("CC"), "credit_card");
    assert.equal(mapGuarantee("DB"), "company_invoice");
    assert.equal(mapGuarantee("PD"), "online_prepaid");
    assert.equal(mapGuarantee("DP"), "bank_transfer");
    assert.equal(mapGuarantee("DP-REC"), "bank_transfer");
    assert.equal(mapGuarantee("DP-R"), "bank_transfer");
    assert.equal(mapGuarantee("VC"), "voucher");
    for (const code of ["4P", "6P", "DG", "TG", "PG", "GM", "CHECKED IN", ""]) assert.equal(mapGuarantee(code), "", code);
  });

  it("buildNotes: formato fijo con solo códigos, fechas e importes; sin usuarios de OPERA; ≤ 2000 caracteres", () => {
    const notes = buildNotes(row({ kind: "arrival", confirmationNo: "270000001", externalReference: "5555", guarantee: "CC", guaranteeDesc: "Credit Card Guaranteed", rateCode: "SP2BK", ratePerNight: "64,13", paymentCode: "MC", market: "TACO", origin: "CRS", category: "DND2", groupId: "77", blockCode: "BLK1", products: "AD", vipLevel: "Gold", compHouse: "C", insertDate: "2026-07-01", roomOpera: "101", personsOpera: 4, estimatedTotal: true }));
    assert.equal(notes, "OPERA · conf 270000001 · ext 5555 · garantía CC (Credit Card Guaranteed) · tarifa SP2BK · tarifa/noche 64,13 · pago MC · mercado TACO · origen CRS · categoría DND2 · bloque 77/BLK1 · productos AD · VIP Gold · comp C · creada 2026-07-01 · hab. OPERA 101 · PERSONS OPERA 4 · importe estimado tarifa×noches");
    assert.equal(buildNotes(row({ rateCode: "", ratePerNight: "", guarantee: "", insertDate: "" })), "OPERA · categoría DND2");
    assert.ok(buildNotes(row({ products: "x".repeat(3000) })).length <= 2000);
    assert.doesNotMatch(notes, /Ficticio|SENTINEL/);
  });
});

describe("OUTPUT_DENYLIST · lectura de informes · fila canónica", () => {
  it("isDeniedColumn: exactas y prefijos; las columnas leídas nunca están en la denylist; cellByName rechaza una denegada", () => {
    for (const column of ["INSERT_USER", "UPDATE_USER", "CREDIT_CARD_NUMBER", "EXP_DATE", "BILL_TO_ADDRESS", "SHARE_NAMES", "ACCOMPANYING_NAMES", "ACCOMPANYING_YN", "MEMBERSHIP_TYPE", "TRX_STRING", "TRACE_TEXT", "FC_TRX_CODE", "BILL_RESORT", "BILL_RESV", "GUEST_NAME_ID", "RC_NTS", "RES_RATE", "S_RATE", "SUMNO_OF_ROOMSPERREPORT", "SUM_ADULTS", "LOGO", "logo"]) assert.equal(isDeniedColumn(column), true, column);
    for (const column of [...STAY_COLUMNS, ...ARRIVAL_COLUMNS]) assert.equal(isDeniedColumn(column), false, column);
    assert.equal(isDeniedColumn("RESV_NAME_ID"), false, "RES_ es prefijo, RESV no");
    assert.equal(isDeniedColumn("RESORT"), false);
    assert.equal(isDeniedColumn("SHARE_AMOUNT"), false);
    assert.equal(OUTPUT_DENYLIST.exact.length + OUTPUT_DENYLIST.prefixes.length, 19);
    assert.throws(() => cellByName(["x"], indexColumns(["INSERT_USER"]), "INSERT_USER"), /OUTPUT_DENYLIST/);
  });

  it("readStayRows: omite pseudo, day-use, > 365 noches y fechas ilegibles; construye la fila; ninguna celda denegada llega a la salida", () => {
    const parsed = table(STAY_HEADER, [
      stayCells({ RESV_NAME_ID: "1", RESV_STATUS: "CHECKED OUT", ROOM: "101", TRAVEL_AGENT_NAME: "Booking.Com", RATE_CODE: "SBOOK" }),
      stayCells({ RESV_NAME_ID: "2", ROOM_CATEGORY_LABEL: "PM", ROOM: "9001" }),
      stayCells({ RESV_NAME_ID: "3", ROOM: "9100", ROOM_CATEGORY_LABEL: "DND2" }),
      stayCells({ RESV_NAME_ID: "4", NIGHTS: "0", ARRIVAL: "10/08/26", DEPARTURE: "10/08/26" }),
      stayCells({ RESV_NAME_ID: "5", NIGHTS: "734", ARRIVAL: "08/08/26", DEPARTURE: "11/08/28", RESV_STATUS: "CANCELLED" }),
      stayCells({ RESV_NAME_ID: "6", ARRIVAL: "xx/08/26" }),
      stayCells({ RESV_NAME_ID: "7", RESV_STATUS: "RESERVED", ROOM: "102", ARRIVAL: "18/09/26", DEPARTURE: "20/09/26", GUARANTEE_CODE: "DP-REC", GUARANTEE_CODE_DESC: "Deposit Received", PERSONS: "0", COMPANY_NAME: "EMPRESA FICTICIA SL", SHARE_AMOUNT_PER_STAY: "1931.5", COMP_HOUSE_YN: "H", RATE_CODE: "SZHOUS" })
    ]);
    const { rows, omitted } = readStayRows(parsed);
    assert.deepEqual(omitted.map((o) => [o.reference, o.reason]), [["2", "pseudo"], ["3", "pseudo"], ["4", "day_use"], ["5", "over_365"], ["6", "invalid_date"]]);
    assert.equal(rows.length, 2);
    const first = rows[0]!;
    assert.equal(first.kind, "stay");
    assert.equal(first.reference, "1");
    assert.deepEqual([first.arrival, first.departure, first.nights], ["2026-08-10", "2026-08-12", 2]);
    assert.equal(first.channel, "booking_com");
    assert.equal(first.segment, "leisure");
    assert.equal(first.total, "200,00");
    assert.equal(first.ratePerNight, "100,00");
    assert.equal(first.insertDate, "2026-07-01");
    assert.equal(first.payment, "", "garantía CHECKED IN → sin método de pago");
    const reserved = rows[1]!;
    assert.equal(reserved.status, "RESERVED");
    assert.equal(reserved.adults, 0, "PERSONS 0 se recorta después, en clampOccupancy");
    assert.equal(reserved.channel, "corporate");
    assert.equal(reserved.segment, "complimentary");
    assert.equal(reserved.payment, "bank_transfer");
    assert.equal(reserved.total, "1931,50");
    const csv = toCanonicalCsv(rows.map(toCanonicalRow));
    assert.doesNotMatch(csv, /SENTINEL/);
    assert.throws(() => readStayRows(table(STAY_HEADER.filter((column) => column !== "NIGHTS"), [])), /faltan columnas NIGHTS/);
  });

  it("readArrivalRows: dedupe, RESERVED, importe estimado tarifa × noches, agencia / empresa por prefijo, pago, VIP y depósito; sin celdas denegadas", () => {
    const parsed = table(ARRIVAL_HEADER, [
      arrivalCells({ CONFIRMATION_NO: "270000001", RESV_NAME_ID: "11" }),
      arrivalCells({ CONFIRMATION_NO: "270000001", RESV_NAME_ID: "11", FULL_NAME: "Probando, Ejemplo|ROUT" }),
      arrivalCells({ CONFIRMATION_NO: "270000002", RESV_NAME_ID: "12", COMPANY_NAME: "C- EMPRESA FICTICIA SL", PAYMENT_METHOD: "", GUARANTEE_CODE: "DB", MARKET_CODE: "CORP", ORIGIN_OF_BOOKING: "SAL", VIP: "Gold", DEPOSIT_PAID: "50", DISP_ROOM_NO: "", SHARE_AMOUNT: "", ADULTS: "1", CHILDREN: "1", PERSONS: "2", ARRIVAL: "19/09/26", DEPARTURE: "22/09/26" }),
      arrivalCells({ CONFIRMATION_NO: "270000003", RESV_NAME_ID: "13", ROOM_CATEGORY_LABEL: "PI", DISP_ROOM_NO: "9100" }),
      arrivalCells({ CONFIRMATION_NO: "270000004", RESV_NAME_ID: "14", ARRIVAL: "19/09/26", DEPARTURE: "19/09/26" })
    ]);
    const { rows, omitted, duplicates } = readArrivalRows(parsed);
    assert.equal(duplicates, 1);
    assert.deepEqual(omitted.map((o) => o.reason), ["duplicate", "pseudo", "day_use"]);
    assert.equal(rows.length, 2);
    const first = rows[0]!;
    assert.equal(first.kind, "arrival");
    assert.equal(first.status, "RESERVED");
    assert.equal(first.reference, "11");
    assert.equal(first.confirmationNo, "270000001");
    assert.equal(first.agency, "Booking.Com");
    assert.equal(first.channel, "booking_com");
    assert.equal(first.segment, "wholesale");
    assert.equal(first.payment, "credit_card");
    assert.equal(first.total, "128,26", "64.13 × 2 noches");
    assert.equal(first.estimatedTotal, true);
    assert.equal(first.deposit, "");
    assert.equal(first.group, "");
    const second = rows[1]!;
    assert.equal(second.company, "EMPRESA FICTICIA SL");
    assert.equal(second.channel, "corporate");
    assert.equal(second.segment, "corporate");
    assert.equal(second.payment, "company_invoice", "sin PAYMENT_METHOD → garantía DB");
    assert.equal(second.vip, "si");
    assert.equal(second.vipLevel, "Gold");
    assert.equal(second.deposit, "50,00");
    assert.deepEqual([second.adults, second.children, second.nights], [1, 1, 3]);
    assert.equal(second.total, "0,00", "sin tarifa → 0,00 (cortesía o bloque sin tarifa)");
    assert.equal(second.room, "");
    const csv = toCanonicalCsv(rows.map(toCanonicalRow));
    assert.doesNotMatch(csv, /SENTINEL/);
    assert.doesNotMatch(csv, /18-SEP-26/, "UPDATE_DATE no se escribe");
  });

  it("toCanonicalRow: 33 celdas en el orden de RESERVATION_IMPORT_FIELDS + 3 extras (garantia, importe_estimado, deposito_pagado); nombre y apellidos rellenos; tarifa y contacto vacíos; toCanonicalCsv con BOM y entrecomillado", () => {
    const cells = toCanonicalRow(row({ company: "EMPRESA; FICTICIA", group: "G".repeat(100) }));
    assert.equal(cells.length, RESERVATION_IMPORT_FIELDS.length + OPERA_EXTRA_FIELDS.length);
    assert.deepEqual(CANONICAL_HEADER, [...RESERVATION_IMPORT_FIELDS, "garantia", "importe_estimado", "deposito_pagado"]);
    const at = (field: (typeof RESERVATION_IMPORT_FIELDS)[number] | OperaExtraField): string => cells[CANONICAL_HEADER.indexOf(field)]!;
    assert.equal(at("referencia_externa"), "10000001");
    assert.equal(at("nombre"), "Prueba");
    assert.equal(at("apellidos"), "Ficticio Inventado");
    assert.equal(at("tarifa"), "");
    assert.equal(at("email"), "");
    assert.equal(at("documento_numero"), "");
    assert.equal(at("estado"), "CHECKED OUT");
    assert.equal(at("importe_total"), "200,00");
    assert.equal(at("grupo").length, 80);
    assert.match(at("notas"), /^OPERA · /);
    assert.equal(at("garantia"), "", "«CHECKED IN» es un literal de estado, no una garantía");
    assert.equal(at("importe_estimado"), "", "estancia: total exacto");
    assert.equal(at("deposito_pagado"), "");
    const arrival = toCanonicalRow(row({ kind: "arrival", status: "RESERVED", guarantee: "DP-REC", estimatedTotal: true, deposit: "150,00" }));
    const atArrival = (field: (typeof RESERVATION_IMPORT_FIELDS)[number] | OperaExtraField): string => arrival[CANONICAL_HEADER.indexOf(field)]!;
    assert.equal(atArrival("garantia"), "DP-REC");
    assert.equal(atArrival("importe_estimado"), "si");
    assert.equal(atArrival("deposito_pagado"), "150,00");
    assert.equal(atArrival("deposito"), "150,00", "`deposito` (solicitado) sigue llevando el importe");
    const csv = toCanonicalCsv([cells]);
    assert.ok(csv.startsWith("﻿" + CANONICAL_HEADER.join(";")));
    assert.ok(csv.includes('"EMPRESA; FICTICIA"'));
    assert.equal(csv.split("\n").length, 3, "cabecera + fila + salto final");
  });

  it("guaranteeOf: código real en mayúsculas; literales de estado (CHECKED IN / DUE OUT…) y vacío → «»", () => {
    assert.equal(guaranteeOf(" cc "), "CC");
    assert.equal(guaranteeOf("dp-rec"), "DP-REC");
    assert.equal(guaranteeOf("CHECKED IN"), "");
    assert.equal(guaranteeOf("Checked Out"), "");
    assert.equal(guaranteeOf("DUE OUT"), "");
    assert.equal(guaranteeOf(""), "");
  });

  it("readCanonicalCsv: relee lo que escribe toCanonicalCsv (extras incluidas) e indexa por referencia (gana la primera)", () => {
    const rows = [row({ reference: "20000001", status: "CHECKED OUT", room: "101", guarantee: "CHECKED IN" }), row({ kind: "arrival", reference: "20000002", status: "RESERVED", room: "", guarantee: "4P", estimatedTotal: true, deposit: "80,50" }), row({ reference: "20000001", status: "CANCELLED", room: "" })];
    const parsed = readCanonicalCsv(toCanonicalCsv(rows.map(toCanonicalRow)));
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.byReference.size, 2);
    const first = parsed.byReference.get("20000001")!;
    assert.deepEqual([first.estado, first.habitacion, first.garantia, first.importeEstimado, first.depositoPagado], ["CHECKED OUT", "101", "", false, ""]);
    assert.match(first.notas, /^OPERA · /);
    const second = parsed.byReference.get("20000002")!;
    assert.deepEqual([second.estado, second.habitacion, second.garantia, second.importeEstimado, second.depositoPagado], ["RESERVED", "", "4P", true, "80,50"]);
    assert.throws(() => readCanonicalCsv("a;b\n1;2\n"), /CSV canónico sin las columnas/);
  });

  it("stripEstimatedNote y decimalOf", () => {
    assert.equal(stripEstimatedNote("OPERA · conf 1 · tarifa BAR · importe estimado tarifa×noches"), "OPERA · conf 1 · tarifa BAR");
    assert.equal(stripEstimatedNote("OPERA · importe estimado tarifa×noches · hab. OPERA 101"), "OPERA · hab. OPERA 101");
    assert.equal(stripEstimatedNote("OPERA · conf 1"), "OPERA · conf 1");
    assert.equal(decimalOf("1234,50"), "1234.50", "solo se cambia la coma decimal (formatAmount nunca escribe separador de miles)");
    assert.equal(decimalOf("80,50"), "80.50");
    assert.equal(decimalOf(""), null);
  });
});

describe("buildBackfillPlan (corrección posterior a la carga, datos inventados)", () => {
  const canonical = (extra: Partial<CanonicalRow> = {}): CanonicalRow => ({ rowNumber: 2, reference: "30000001", estado: "CHECKED OUT", habitacion: "", notas: "OPERA · conf 1", garantia: "", importeEstimado: false, depositoPagado: "", ...extra });
  const reservation = (extra: Partial<BackfillReservation> = {}): BackfillReservation => ({ id: "res_1", code: "RES-1", status: "checked_out", externalReference: "30000001", guaranteeType: null, priceSource: "file", notes: "OPERA · conf 1", depositPaid: null, assignedRoomId: null, arrivalDate: "2026-08-10", departureDate: "2026-08-12", stays: 1, ...extra });

  it("garantía: la de estancias si es real, si no la de llegadas; nunca pisa una garantía ya informada", () => {
    const plan = buildBackfillPlan({
      reservations: [reservation(), reservation({ id: "res_2", code: "RES-2", externalReference: "30000002" }), reservation({ id: "res_3", code: "RES-3", externalReference: "30000003", guaranteeType: "CC" })],
      stays: new Map([
        ["30000001", canonical({ garantia: "" })],
        ["30000002", canonical({ reference: "30000002", garantia: "DB" })],
        ["30000003", canonical({ reference: "30000003", garantia: "4P" })]
      ]),
      arrivals: new Map([["30000001", canonical({ reference: "30000001", estado: "RESERVED", garantia: "CC" })]]),
      roomIdByNumber: new Map()
    });
    assert.equal(plan.patches.length, 2);
    assert.equal(plan.patches[0]!.guaranteeType, "CC", "estancia sin código real → la de llegadas");
    assert.equal(plan.patches[1]!.guaranteeType, "DB");
    assert.equal(plan.counts.guaranteeType, 2);
    assert.equal(plan.counts.unchanged, 1, "RES-3 ya tenía garantía");
  });

  it("origen del precio: llegada estimada sin fila de estancias → quoted; enlazada (con fila de estancias) → la nota se retira y price_source se queda", () => {
    const plan = buildBackfillPlan({
      reservations: [
        reservation({ id: "res_a", code: "RES-A", status: "confirmed", externalReference: "30000010", notes: "OPERA · conf 1 · importe estimado tarifa×noches", stays: 0 }),
        reservation({ id: "res_b", code: "RES-B", status: "confirmed", externalReference: "30000011", notes: "OPERA · conf 2 · importe estimado tarifa×noches", stays: 0 }),
        reservation({ id: "res_c", code: "RES-C", status: "confirmed", externalReference: "30000012", priceSource: "quoted", notes: "OPERA · importe estimado tarifa×noches", stays: 0 })
      ],
      stays: new Map([["30000011", canonical({ reference: "30000011", estado: "RESERVED" })]]),
      arrivals: new Map([
        ["30000010", canonical({ reference: "30000010", estado: "RESERVED", importeEstimado: true })],
        ["30000011", canonical({ reference: "30000011", estado: "RESERVED", importeEstimado: true })],
        ["30000012", canonical({ reference: "30000012", estado: "RESERVED", importeEstimado: true })]
      ]),
      roomIdByNumber: new Map()
    });
    const byCode = new Map(plan.patches.map((patch) => [patch.code, patch] as const));
    assert.equal(byCode.get("RES-A")!.priceSource, "quoted");
    assert.equal(byCode.get("RES-A")!.notes, undefined, "sin fila de estancias la nota sigue (el total sigue estimado)");
    assert.equal(byCode.get("RES-B")!.priceSource, undefined, "el lote de estancias puso el total exacto");
    assert.equal(byCode.get("RES-B")!.notes, "OPERA · conf 2");
    assert.equal(byCode.has("RES-C"), false, "ya era quoted y no está enlazada: sin cambios");
    assert.deepEqual([plan.counts.priceSource, plan.counts.notes, plan.counts.unchanged], [1, 1, 1]);
  });

  it("depósito pagado y habitación + Stay de una cerrada sin habitación (solo si la habitación existe y está activa)", () => {
    const plan = buildBackfillPlan({
      reservations: [
        reservation({ id: "res_r", code: "RES-R", externalReference: "30000020", stays: 0 }),
        reservation({ id: "res_s", code: "RES-S", externalReference: "30000021", stays: 0 }),
        reservation({ id: "res_t", code: "RES-T", externalReference: "30000022", stays: 1, assignedRoomId: "room_101" }),
        reservation({ id: "res_u", code: "RES-U", status: "confirmed", externalReference: "30000023", stays: 0, depositPaid: "10.00" })
      ],
      stays: new Map([
        ["30000020", canonical({ reference: "30000020", habitacion: "101", depositoPagado: "40,00" })],
        ["30000021", canonical({ reference: "30000021", habitacion: "999" })],
        ["30000022", canonical({ reference: "30000022", habitacion: "101" })]
      ]),
      arrivals: new Map([["30000023", canonical({ reference: "30000023", estado: "RESERVED", depositoPagado: "25,00" })]]),
      roomIdByNumber: new Map([["101", "room_101"]])
    });
    const byCode = new Map(plan.patches.map((patch) => [patch.code, patch] as const));
    assert.deepEqual(byCode.get("RES-R")!.room, { number: "101", roomId: "room_101" });
    assert.equal(byCode.get("RES-R")!.depositPaid, "40.00");
    assert.equal(byCode.has("RES-S"), false, "habitación inexistente: se lista, no se inventa");
    assert.deepEqual(plan.roomsMissing, ["999"]);
    assert.equal(byCode.has("RES-T"), false, "ya tiene habitación y Stay");
    assert.equal(byCode.has("RES-U"), false, "deposit_paid ya informado");
    assert.deepEqual([plan.counts.room, plan.counts.depositPaid, plan.counts.withoutRow], [1, 1, 0]);
  });
});

describe("reconcileRaw · expectedExtras (verify --in)", () => {
  it("reconcileRaw: bruto por RESV_STATUS = escritas + omitidas por motivo; llegadas con repetidas aparte", () => {
    const stays: ReadResult = {
      rows: [row({ status: "CHECKED OUT" }), row({ status: "CHECKED OUT" }), row({ status: "CANCELLED", room: "" })],
      omitted: [
        { rowNumber: 5, reference: "1", reason: "pseudo", status: "CHECKED OUT", category: "PM", room: "9001" },
        { rowNumber: 6, reference: "2", reason: "day_use", status: "CHECKED IN", category: "DND2", room: "101" },
        { rowNumber: 7, reference: "3", reason: "over_365", status: "CANCELLED", category: "DND2", room: "" }
      ]
    };
    const arrivals: ReadResult & { duplicates: number } = {
      rows: [row({ kind: "arrival", status: "RESERVED" })],
      omitted: [
        { rowNumber: 3, reference: "", reason: "duplicate", status: "RESERVED", category: "", room: "" },
        { rowNumber: 4, reference: "9", reason: "pseudo", status: "RESERVED", category: "PI", room: "9100" }
      ],
      duplicates: 1
    };
    const reconciliation = reconcileRaw(stays, arrivals);
    assert.deepEqual(reconciliation.stays, {
      CANCELLED: { raw: 2, omitted: { over_365: 1 }, written: 1 },
      "CHECKED IN": { raw: 1, omitted: { day_use: 1 }, written: 0 },
      "CHECKED OUT": { raw: 3, omitted: { pseudo: 1 }, written: 2 }
    });
    assert.deepEqual(reconciliation.arrivals, { raw: 3, duplicates: 1, omitted: { pseudo: 1 }, written: 1 });
    const lines = formatReconciliation(reconciliation);
    assert.ok(lines[0]!.includes("OPERA bruto → cargado"));
    assert.ok(lines.some((line) => line.includes("TOTAL") && line.includes("6") && line.includes("3")));
    assert.ok(lines.at(-1)!.includes("repetidas (marcadores) 1"));
  });

  it("expectedExtras: garantías por referencia (estancia o llegada), quoted = llegadas estimadas no enlazadas, depósitos, cerradas sin habitación", () => {
    const extras = expectedExtras({
      orderedStays: [
        row({ reference: "1", status: "CHECKED OUT", guarantee: "CHECKED IN", room: "" }),
        row({ reference: "2", status: "RESERVED", guarantee: "CC", room: "102", deposit: "10,00" }),
        row({ reference: "3", status: "CHECKED OUT", guarantee: "CHECKED OUT", room: "103" })
      ],
      orderedArrivals: [
        row({ kind: "arrival", reference: "2", status: "RESERVED", guarantee: "CC", estimatedTotal: true, deposit: "10,00" }),
        row({ kind: "arrival", reference: "4", status: "RESERVED", guarantee: "4P", estimatedTotal: true }),
        row({ kind: "arrival", reference: "5", status: "RESERVED", guarantee: "", estimatedTotal: true, deposit: "0,00" })
      ]
    });
    assert.deepEqual(extras, { guaranteeType: 2, priceSourceQuoted: 2, depositPaid: 1, closedWithoutRoom: 1 });
  });
});

describe("buildInventoryPlan · ROOM_TYPE_PROPOSALS · resumen", () => {
  it("plan idempotente: tipos que faltan, re-tipado por número, altas con planta, desactivación de sobrantes y de tipos sintéticos", () => {
    const plan = buildInventoryPlan({
      operaRooms: [
        { number: "101", type: "DND2" },
        { number: "102", type: "KND1" },
        { number: "001", type: "DND2" },
        { number: "1001", type: "DND4" }
      ],
      dbRooms: [
        { id: "r101", number: "101", roomTypeId: "t_dbl", active: true, sellable: true },
        { id: "r102", number: "102", roomTypeId: "t_knd1", active: true, sellable: true },
        { id: "r103", number: "103", roomTypeId: "t_dbl", active: true, sellable: true },
        { id: "r104", number: "104", roomTypeId: "t_ind", active: false, sellable: false }
      ],
      dbTypes: [
        { id: "t_dbl", code: "DBL", active: true, sellable: true },
        { id: "t_knd1", code: "KND1", active: true, sellable: true },
        { id: "t_ind", code: "IND", active: true, sellable: false },
        { id: "t_old", code: "OLD", active: false, sellable: true },
        { id: "t_gone", code: "GONE", active: false, sellable: false }
      ]
    });
    assert.deepEqual(plan.typesToCreate, ["DND2", "DND4"]);
    assert.deepEqual(plan.roomsToRetype, [{ roomId: "r101", number: "101", fromCode: "DBL", toCode: "DND2" }]);
    assert.deepEqual(plan.roomsToCreate, [
      { number: "001", type: "DND2", floor: "0" },
      { number: "1001", type: "DND4", floor: "10" }
    ]);
    assert.deepEqual(plan.roomsToDeactivate, [{ roomId: "r103", number: "103", code: "DBL" }], "la 104 ya estaba desactivada");
    assert.deepEqual(plan.typesToDeactivate, ["DBL", "IND"], "KND1 tiene habitaciones OPERA; OLD ya estaba inactivo");
    assert.deepEqual(plan.typesToUnsell, ["DBL", "OLD"], "sin habitación OPERA y aún vendibles: DBL (a desactivar) y OLD (inactivo); IND y GONE ya no se venden");
    assert.equal(plan.unchangedRooms, 1);
    const again = buildInventoryPlan({
      operaRooms: [{ number: "101", type: "DND2" }],
      dbRooms: [{ id: "r101", number: "101", roomTypeId: "t_dnd2", active: true, sellable: true }],
      dbTypes: [{ id: "t_dnd2", code: "DND2", active: true }]
    });
    assert.deepEqual(again, { typesToCreate: [], roomsToRetype: [], roomsToCreate: [], roomsToDeactivate: [], typesToDeactivate: [], typesToUnsell: [], unchangedRooms: 1 });
  });

  it("ROOM_TYPE_PROPOSALS: 14 códigos (12 tipos + PI y PM pseudo), nombres en español, TND* con baseCapacity 1", () => {
    assert.equal(ROOM_TYPE_PROPOSALS.length, 14);
    const codes = ROOM_TYPE_PROPOSALS.map((proposal) => proposal.code);
    assert.deepEqual(codes, ["DND2", "DND3", "DND4", "DSD3", "DSD4", "DSD5", "KND1", "KND2", "KNE1", "TND1", "TND2", "TND3", "PI", "PM"]);
    assert.equal(ROOM_TYPE_PROPOSALS.filter((proposal) => proposal.pseudo).length, 2);
    for (const proposal of ROOM_TYPE_PROPOSALS.filter((candidate) => !candidate.pseudo)) {
      assert.ok(proposal.maxOccupancy >= 2 && proposal.maxOccupancy <= 5, proposal.code);
      assert.equal(proposal.baseCapacity, proposal.code.startsWith("TND") ? 1 : 2, proposal.code);
      assert.ok(proposal.name.length > 3);
    }
  });

  it("summarizeFeed, augustRoomNights, expectedFromSummary y formatSummary", () => {
    const rows = [
      row({ status: "CHECKED OUT", arrival: "2026-07-30", departure: "2026-08-03", room: "101" }),
      row({ status: "CHECKED IN", arrival: "2026-08-30", departure: "2026-09-02", room: "102" }),
      row({ status: "CHECKED IN", arrival: "2026-09-17", departure: "2026-09-20", room: "" }),
      row({ status: "RESERVED", arrival: "2026-09-18", departure: "2026-09-19", room: "103", fullName: "Probando Ejemplo" }),
      row({ status: "CANCELLED", arrival: "2026-08-10", departure: "2026-08-20", room: "" }),
      row({ status: "NO SHOW", arrival: "2026-08-10", departure: "2026-08-11", room: "" })
    ];
    assert.equal(augustRoomNights(rows), 2 + 2, "[07-30,08-03) → 2 noches de agosto; [08-30,09-02) → 2");
    const estancias = summarizeFeed(rows, [{ rowNumber: 9, reference: "9", reason: "pseudo", status: "CHECKED OUT", category: "PM", room: "9001" }], { file: "e.xlsx", sha256In: "a", rowsRead: 7, rowsUnique: 7, blankedRooms: { dead: 2, overlap: 0 }, physicalTypeApplied: 0, personsClamped: 0, enriched: 1, out: [{ file: "X-estancias.csv", sha256: "b", rows: 6 }] });
    assert.equal(estancias.rowsWritten, 6);
    assert.deepEqual(estancias.omitted, { pseudo: 1 });
    assert.deepEqual(estancias.byStatus, { "CHECKED OUT": 1, "CHECKED IN": 2, RESERVED: 1, CANCELLED: 1, "NO SHOW": 1 });
    assert.deepEqual(estancias.byTargetStatus, { checked_out: 1, checked_in: 1, "confirmed (CHECKED IN sin habitación)": 1, confirmed: 1, cancelled: 1, no_show: 1 });
    assert.deepEqual(estancias.inHouseRooms, ["102"]);
    assert.deepEqual(estancias.arrivalsByDate, { "2026-08-30": 1, "2026-09-17": 1, "2026-09-18": 1 });
    assert.deepEqual(estancias.nameSplit, { comma: 5, no_comma: 1 });
    const llegadas = summarizeFeed([row({ kind: "arrival", status: "RESERVED", arrival: "2026-09-18" }), row({ kind: "arrival", status: "RESERVED", arrival: "2026-09-19" }), row({ kind: "arrival", status: "RESERVED", arrival: "2026-09-19" })], [], { file: "l.xlsx", sha256In: "c", rowsRead: 4, rowsUnique: 3, blankedRooms: { dead: 0, overlap: 0 }, physicalTypeApplied: 0, personsClamped: 0, enriched: 0, out: [{ file: "X-llegadas.csv", sha256: "d", rows: 3 }] });
    const hotel: HotelSummary = { name: "Hotel Ficticio", resort: "ES999", estancias, llegadas, inventario: { file: "X-inventario.json", sha256: "e", types: 2, rooms: 3, ambiguous: ["103"] } };
    const expected = expectedFromSummary(hotel);
    assert.deepEqual(expected.byStatus, { confirmed: 3 + 1, checked_in: 1, checked_out: 1, no_show: 1, cancelled: 1 });
    assert.deepEqual(expected.inHouseRooms, ["102"]);
    assert.deepEqual(expected.arrivals, { "2026-09-18": 1, "2026-09-19": 2 });
    assert.equal(expected.augustRoomNights, 4);
    const summary: PrepSummary = { generatedAt: "2026-09-19T00:00:00.000Z", cutDate: "2026-09-18", inDir: "/in", outDir: "/out", hotels: { RA: hotel } };
    const lines = formatSummary(summary);
    assert.ok(lines[0]!.includes("corte 2026-09-18"));
    assert.ok(lines.some((line) => line.includes("RA · Hotel Ficticio (ES999)")));
    assert.ok(lines.some((line) => line.includes("leídas 7 · escritas 6 · omitidas pseudo 1")));
    assert.ok(lines.some((line) => line.includes("18/09 1 · 19/09 2")));
    assert.ok(lines.some((line) => line.includes("ambiguas 103")));
    assert.ok(!lines.join("\n").includes("Inventado") && !lines.join("\n").includes("Prueba"), "el resumen nunca lleva nombres");
  });

  it("buildSyncBody: modo sync con tarifa ignorada, omitir inválidas, permitir overbooking, horizonte 730 y muestra mínima", () => {
    const body = buildSyncBody({ fileName: "RA-llegadas.csv", contentBase64: "AAAA", feed: "arrivals", businessDate: "2026-09-18", force: true });
    assert.equal(body.mode, "sync");
    assert.equal(body.feed, "arrivals");
    assert.equal(body.businessDate, "2026-09-18");
    assert.deepEqual(body.mapping, { tarifa: null });
    assert.equal(body.omitirInvalidas, true);
    assert.equal(body.permitirOverbooking, true);
    assert.equal(body.historico, false);
    assert.equal(body.force, true);
    assert.equal(body.horizonDays, 730);
    assert.equal(body.sampleSize, 1);
    assert.equal(body.profile, undefined, "sin perfil: el mapeo canónico por cabecera y el statusMap OPERA por defecto");
  });
});
