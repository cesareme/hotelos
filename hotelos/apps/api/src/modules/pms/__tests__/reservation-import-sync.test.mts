// Unit tests · Tanda 7b · L1 — modo `sync` del importador de reservas (OPERA Cloud
// en modo sombra), PURO (sin base de datos): perfil de mapeo por cabecera literal,
// cabecera sintética, estimación de totales, estados OPERA, veredicto por fila
// (`decideSyncAction`), hash de fila sin PII, reservas ausentes por feed y sal del
// hash de contenido. Huéspedes FICTICIOS @example.com. Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-sync.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OPERA_CLOUD_DEPARTURE_ALL_HEADER,
  OPERA_CLOUD_PROFILE,
  OPERA_CLOUD_RESPONSYS_HEADER,
  OPERA_CLOUD_STATUS_MAP,
  RESERVATION_IMPORT_SYNC_REFERENCE_COLUMN,
  RESERVATION_IMPORT_SYNC_TOTAL_COLUMN,
  type NormalizedReservationRow,
  type ReservationImportMapping,
  type ReservationSyncTargetStatus
} from "@hotelos/shared";
import { foldStatusLiteral, resolveProfileMapping, resolveSyncTargetStatus } from "../reservation-import.mapping.js";
import { contentHashRowsOf, reservationImportContentHash, syncRowHash, type ReservationImportCatalogs } from "../reservation-import.normalize.js";
import { ReservationImportParseError, parseReservationImportFile, type ParsedTable } from "../reservation-import.parser.js";
import {
  applyHeaderOverride,
  applyProfileValueMaps,
  computeMissing,
  decideSyncAction,
  diffFields,
  estimateTotals,
  injectReferences,
  restoreFirstRowCells,
  stayKeyOf,
  syncWindowContains,
  type SyncLinkedReservation
} from "../reservation-import.sync.js";

const ARRIVALS = OPERA_CLOUD_PROFILE.feeds.arrivals!;
const DEPARTURES = OPERA_CLOUD_PROFILE.feeds.departures!;

function table(header: string[], rows: string[][]): ParsedTable {
  return {
    header,
    rows: rows.map((cells, index) => ({ rowNumber: index + 1, line: index + 2, cells, kinds: cells.map((cell) => (cell === "" ? "empty" : "string")) })),
    format: "csv",
    bom: false,
    warnings: [],
    truncated: false
  };
}

function normalizedRow(extra: Partial<NormalizedReservationRow> = {}): NormalizedReservationRow {
  return {
    externalReference: "RIAS-1001",
    arrivalDate: "2026-10-12",
    departureDate: "2026-10-15",
    nights: 3,
    roomTypeId: "rt_dbl",
    roomTypeCode: "DBL",
    ratePlanId: "rp_bar",
    ratePlanCode: "BAR",
    roomsCount: 1,
    adults: 2,
    children: 0,
    infants: 0,
    channel: "booking_com",
    sourceCode: "BDC",
    marketSegment: "leisure",
    estado: "confirmada",
    historical: false,
    guest: { firstName: "Lucía", surname1: "Ferreiro", surname2: "Castro", email: "lucia.ferreiro@example.com", documentNumber: "11111111H" },
    companyName: "Empresa Ficticia SL",
    groupCode: "GRP-1",
    totalAmount: "312.00",
    totalSource: "file",
    currency: "EUR",
    vipFlag: false,
    targetStatus: "confirmed",
    ...extra
  };
}

function linked(extra: Partial<SyncLinkedReservation["reservation"]> = {}, link: Partial<SyncLinkedReservation["link"]> = {}): SyncLinkedReservation {
  const normalized = normalizedRow();
  return {
    link: { id: "link_1", confirmationNo: "RIAS-1001", reservationId: "res_1", rowHash: syncRowHash(normalized), lastStatus: "confirmed", missingStreak: 0, ...link },
    reservation: {
      id: "res_1",
      code: "RES-00001",
      status: "confirmed",
      arrivalDate: "2026-10-12",
      departureDate: "2026-10-15",
      roomTypeId: "rt_dbl",
      ratePlanId: "rp_bar",
      adults: 2,
      children: 0,
      roomsCount: 1,
      totalAmount: "312.00",
      marketSegment: "leisure",
      channel: "booking_com",
      sourceCode: "BDC",
      groupCode: "GRP-1",
      companyName: "Empresa Ficticia SL",
      travelAgentName: null,
      assignedRoomId: null,
      ...extra
    }
  };
}

const CATALOGS: ReservationImportCatalogs = {
  roomTypes: [{ id: "rt_dbl", code: "DBL", name: "Doble", maxOccupancy: 2, active: true }],
  ratePlans: [{ id: "rp_bar", code: "BAR", name: "Best Available Rate", active: true }],
  rooms: [{ id: "room_201", number: "201", roomTypeId: "rt_dbl" }],
  defaultRatePlanId: "rp_bar",
  currency: "EUR",
  businessDate: "2026-09-17",
  today: "2026-09-17",
  timezone: "Europe/Madrid"
};

describe("resolveProfileMapping · perfil OPERA Cloud", () => {
  it("cabecera literal Responsys de 33 columnas → 0 desconocidas, 0 ausentes; RATE ignorada, RATE_CODE → tarifa, DISCOUNT_AMOUNT null", () => {
    const header = [...OPERA_CLOUD_RESPONSYS_HEADER];
    const result = resolveProfileMapping(header, ARRIVALS);
    assert.deepEqual(result.unknownColumns, []);
    assert.deepEqual(result.missingProfileColumns, []);
    assert.equal(Object.keys(result.mapping).length, 33);
    assert.equal(result.mapping.RESERVATION_ID, "referencia_externa");
    assert.equal(result.mapping.RATE, null, "RATE es la tarifa de la primera noche: no se mapea a tarifa");
    assert.equal(result.mapping.RATE_CODE, "tarifa");
    assert.equal(result.mapping.DISCOUNT_AMOUNT, null);
    assert.equal(result.mapping.NAME_ON_CARD, null, "PII de tarjeta nunca se mapea");
    assert.equal(result.mapping.RESERVATION_STATUS, "estado");
    assert.equal(result.mapping.ROOM_NUMBER, "habitacion");
    assert.equal(result.mapping.NUM_NIGHTS, "noches");
    assert.equal(result.mapping.NUM_ROOMS, "habitaciones");
    assert.equal(result.mapping.BOOKING_SOURCE, "canal");
    // Todas las claves del mapeo son cabeceras REALES del fichero (applyMapping lo exige).
    for (const column of Object.keys(result.mapping)) assert.ok(header.includes(column), column);
  });

  it("casa por plegado (minúsculas, espacios, puntos) y una columna renombrada queda en missingProfileColumns + unknownColumns", () => {
    const folded = OPERA_CLOUD_RESPONSYS_HEADER.map((column) => column.toLowerCase().replace(/_/g, " "));
    const ok = resolveProfileMapping(folded, ARRIVALS);
    assert.deepEqual(ok.unknownColumns, []);
    assert.deepEqual(ok.missingProfileColumns, []);
    assert.equal(ok.mapping["reservation id"], "referencia_externa");

    const renamed = OPERA_CLOUD_RESPONSYS_HEADER.map((column) => (column === "RESERVATION_ID" ? "RESV_ID" : column));
    const result = resolveProfileMapping(renamed, ARRIVALS);
    assert.deepEqual(result.unknownColumns, ["RESV_ID"]);
    assert.deepEqual(result.missingProfileColumns, ["RESERVATION_ID"]);
    assert.equal(result.mapping.RESV_ID, null, "la desconocida se ignora explícitamente (no se sugiere por sinónimo)");
    assert.equal("RESERVATION_ID" in result.mapping, false);
  });

  it("departure_all: 19 columnas, «Room No.» → habitacion, «Name» → nombre, «Res. Status» → estado, Balance ignorada", () => {
    const result = resolveProfileMapping([...OPERA_CLOUD_DEPARTURE_ALL_HEADER], DEPARTURES);
    assert.deepEqual(result.unknownColumns, []);
    assert.deepEqual(result.missingProfileColumns, []);
    assert.equal(result.mapping["Room No."], "habitacion");
    assert.equal(result.mapping.Name, "nombre");
    assert.equal(result.mapping["Res. Status"], "estado");
    assert.equal(result.mapping.Balance, null);
    assert.equal(result.mapping["Block Code"], null);
  });
});

describe("resolveSyncTargetStatus · estados OPERA (diseño §4.1)", () => {
  const LITERALS: Array<[string, ReservationSyncTargetStatus]> = [
    ["Reserved", "confirmed"],
    ["RESERVED", "confirmed"],
    ["Confirmed", "confirmed"],
    ["Due In", "confirmed"],
    ["DueIn", "confirmed"],
    ["DUE IN", "confirmed"],
    ["Prospect", "confirmed"],
    ["PROSPECT", "confirmed"],
    ["Requested", "confirmed"],
    ["REQUESTED", "confirmed"],
    ["Checked In", "checked_in"],
    ["CHECKED IN", "checked_in"],
    ["In House", "checked_in"],
    ["InHouse", "checked_in"],
    ["IN HOUSE", "checked_in"],
    ["Due Out", "checked_in"],
    ["DueOut", "checked_in"],
    ["DUE OUT", "checked_in"],
    ["PendingCheckout", "checked_in"],
    ["PENDING CHECKOUT", "checked_in"],
    ["Walkin", "checked_in"],
    ["WALKIN", "checked_in"],
    ["Checked Out", "checked_out"],
    ["CHECKED OUT", "checked_out"],
    ["CheckedOut", "checked_out"],
    ["Cancelled", "cancelled"],
    ["CANCELLED", "cancelled"],
    ["Canceled", "cancelled"],
    ["No Show", "no_show"],
    ["NO SHOW", "no_show"],
    ["NoShow", "no_show"],
    ["Waitlist", "skip"],
    ["WAITLIST", "skip"],
    ["Waitlisted", "skip"]
  ];

  it(`${LITERALS.length} grafías de informes, exports, OHIP síncrono, async y Business Events → estado destino`, () => {
    for (const [raw, expected] of LITERALS) assert.equal(resolveSyncTargetStatus(raw, OPERA_CLOUD_STATUS_MAP), expected, raw);
    assert.equal(Object.keys(OPERA_CLOUD_STATUS_MAP).length, 22, "22 claves plegadas en el perfil");
    for (const key of Object.keys(OPERA_CLOUD_STATUS_MAP)) assert.equal(resolveSyncTargetStatus(key, OPERA_CLOUD_STATUS_MAP), OPERA_CLOUD_STATUS_MAP[key], key);
  });

  it("vacío, desconocido o diccionario vacío → null; foldStatusLiteral pliega como foldValue", () => {
    assert.equal(resolveSyncTargetStatus("", OPERA_CLOUD_STATUS_MAP), null);
    assert.equal(resolveSyncTargetStatus("Tentativa", OPERA_CLOUD_STATUS_MAP), null);
    assert.equal(resolveSyncTargetStatus("Reserved", {}), null);
    assert.equal(resolveSyncTargetStatus("Reserved", { reserved: "draft" as ReservationSyncTargetStatus }), null, "valor fuera del catálogo → null");
    assert.equal(foldStatusLiteral(" Checked  In "), "checked_in");
    assert.equal(foldStatusLiteral("NO SHOW"), "no_show");
  });

  it("sync sin perfil resuelve los literales RESV_STATUS reales (Tanda 7d: statusMap por defecto = OPERA_CLOUD_PROFILE.statusMap)", () => {
    // El servicio, sin `profile`, ya no arranca con `{}`: hereda el diccionario del perfil OPERA Cloud.
    const statusMap = OPERA_CLOUD_PROFILE.statusMap;
    assert.equal(resolveSyncTargetStatus("CHECKED OUT", statusMap), "checked_out");
    assert.equal(resolveSyncTargetStatus("CHECKED IN", statusMap), "checked_in");
    assert.equal(resolveSyncTargetStatus("RESERVED", statusMap), "confirmed");
    assert.equal(resolveSyncTargetStatus("NO SHOW", statusMap), "no_show");
    assert.equal(resolveSyncTargetStatus("CANCELLED", statusMap), "cancelled");
    assert.equal(resolveSyncTargetStatus("WAITLIST", statusMap), "skip");
    assert.equal(resolveSyncTargetStatus("", statusMap), null);
    assert.equal(statusMap, OPERA_CLOUD_STATUS_MAP, "el perfil expone el mismo diccionario");
  });
});

describe("applyHeaderOverride · fichero sin fila de cabecera", () => {
  const LINES = [
    ["201", "Lucía Ferreiro", "", "", "", "", "18/09/2026", "20/09/2026", "2", "0", "1", "2", "DBL", "", "BAR", "Checked Out", "11:00", "VI", "0.00"],
    ["202", "Marek Nowak", "Empresa Ficticia SL", "", "", "", "17/09/2026", "20/09/2026", "1", "0", "1", "3", "DBL", "", "BAR", "Due Out", "", "CA", "0.00"]
  ];
  const content = LINES.map((cells) => cells.join(";")).join("\r\n") + "\r\n";

  it("la primera fila del fichero pasa a ser la fila de datos 1 (celdas vacías y repetidas restauradas) y la cabecera es la del perfil", () => {
    const parsed = parseReservationImportFile({ format: "csv", content });
    assert.equal(parsed.rows.length, 1, "el parser tomó la primera fila por cabecera");
    assert.ok(parsed.header.some((cell) => /^columna_\d+$/.test(cell)), "celdas vacías renombradas por el parser");
    assert.ok(parsed.header.includes("2 (2)"), "celda repetida desambiguada por el parser");
    const out = applyHeaderOverride(parsed, DEPARTURES.headerless!);
    assert.deepEqual(out.header, [...OPERA_CLOUD_DEPARTURE_ALL_HEADER]);
    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.rows[0]!.cells, LINES[0]);
    assert.deepEqual(out.rows[0]!.kinds.slice(0, 4), ["string", "string", "empty", "empty"]);
    assert.deepEqual(out.rows.map((row) => row.rowNumber), [1, 2]);
    assert.deepEqual(out.rows[1]!.cells, LINES[1]);
    assert.ok(out.rows[0]!.line < out.rows[1]!.line);
    assert.deepEqual(out.warnings.filter((warning) => /cabecera repite/.test(warning)), [], "los avisos de cabecera repetida no aplican a un fichero sin cabecera");
    // La tabla original no se muta.
    assert.equal(parsed.rows.length, 1);
  });

  it("nº de columnas distinto → ReservationImportParseError RESERVATION_IMPORT_HEADER_MISMATCH { expected, receivedCount } sin las celdas recibidas (SEC-02)", () => {
    const parsed = parseReservationImportFile({ format: "csv", content });
    assert.throws(
      () => applyHeaderOverride(parsed, ["a", "b", "c"]),
      (error: unknown) => {
        if (!(error instanceof ReservationImportParseError) || error.code !== "RESERVATION_IMPORT_HEADER_MISMATCH") return false;
        const details = error.details as { expected: unknown; receivedCount: number; received?: unknown };
        assert.ok(Array.isArray(details.expected));
        assert.equal(details.receivedCount, 19);
        assert.equal(details.received, undefined, "la primera fila de datos (huésped) nunca viaja en los detalles");
        return true;
      }
    );
  });

  it("restoreFirstRowCells: columna_<n> → vacía; «X (2)» → «X» solo si «X» ya apareció", () => {
    assert.deepEqual(restoreFirstRowCells(["2", "columna_2", "2 (2)", "3 (2)", "x"]), ["2", "", "2", "3 (2)", "x"]);
  });
});

describe("applyProfileValueMaps · diccionarios del PmsShadowProfile", () => {
  const header = ["RESERVATION_ID", "ROOM_TYPE", "RATE_CODE", "BOOKING_SOURCE", "PAYMENT_TYPE", "ROOM_NUMBER"];
  const mapping: ReservationImportMapping = { RESERVATION_ID: "referencia_externa", ROOM_TYPE: "tipo_habitacion", RATE_CODE: "tarifa", BOOKING_SOURCE: "canal", PAYMENT_TYPE: "metodo_pago", ROOM_NUMBER: "habitacion" };

  it("traduce por diccionario plegado (propiedad > perfil), omite pseudo rooms y se queda con la primera habitación", () => {
    const parsed = table(header, [
      ["RIAS-1", "DLX", "RACK", "BDC", "VI", "201, 202"],
      ["RIAS-2", "PM", "BAR", "web", "CA", "101"],
      ["RIAS-3", "SUP", "BAR", "gds", "xx", ""]
    ]);
    const out = applyProfileValueMaps(parsed, mapping, { roomTypes: { dlx: "DBL" }, rateCodes: { RACK: "BAR" }, sourceCodes: { bdc: "booking_com_propiedad" }, pseudoRoomTypes: ["PM", "HOUSE"] }, OPERA_CLOUD_PROFILE);
    assert.deepEqual(out.parsed.rows[0]!.cells, ["RIAS-1", "DBL", "BAR", "booking_com_propiedad", "credit_card", "201"]);
    assert.deepEqual(out.parsed.rows[1]!.cells, ["RIAS-2", "PM", "BAR", "direct", "cash", "101"], "pseudo room: la celda se conserva y la fila se omite");
    assert.deepEqual(out.parsed.rows[2]!.cells, ["RIAS-3", "SUP", "BAR", "gds", "xx", ""], "sin entrada → tal cual");
    assert.equal(out.replaced, 6);
    assert.deepEqual(out.issues.map((entry) => [entry.rowNumber, entry.issue.code]), [[2, "RESERVATION_IMPORT_ROW_OPERA_PSEUDO_ROOM"]]);
    assert.doesNotMatch(out.issues[0]!.issue.message, /PM/, "el mensaje no cita el valor");
    assert.deepEqual(parsed.rows[0]!.cells, ["RIAS-1", "DLX", "RACK", "BDC", "VI", "201, 202"], "no muta la tabla original");
  });
});

describe("estimateTotals · RATE × noches × habitaciones", () => {
  const header = ["RESERVATION_ID", "ARRIVAL_DATE", "DEPARTURE_DATE", "NUM_NIGHTS", "NUM_ROOMS", "RATE"];
  const mapping: ReservationImportMapping = { RESERVATION_ID: "referencia_externa", ARRIVAL_DATE: "llegada", DEPARTURE_DATE: "salida", NUM_NIGHTS: "noches", NUM_ROOMS: "habitaciones", RATE: null };

  it("añade la columna sintética a la cabecera y a cada fila, la mapea a importe_total y avisa OPERA_TOTAL_ESTIMATED", () => {
    const parsed = table(header, [
      ["RIAS-1", "20261012", "20261015", "3", "2", "120.50"],
      ["RIAS-2", "20261012", "20261014", "", "", "99.99"],
      ["RIAS-3", "20261012", "20261013", "1", "1", ""],
      ["RIAS-4", "20261012", "20261013", "1", "1", "abc"]
    ]);
    const out = estimateTotals(parsed, mapping);
    assert.equal(out.applied, true);
    assert.deepEqual(out.parsed.header, [...header, RESERVATION_IMPORT_SYNC_TOTAL_COLUMN]);
    assert.equal(out.mapping[RESERVATION_IMPORT_SYNC_TOTAL_COLUMN], "importe_total");
    assert.equal(out.parsed.rows[0]!.cells.at(-1), "723.00", "120,50 × 3 noches × 2 habitaciones");
    assert.equal(out.parsed.rows[0]!.kinds.at(-1), "string");
    assert.equal(out.parsed.rows[1]!.cells.at(-1), "199.98", "noches de llegada / salida y 1 habitación por defecto");
    assert.equal(out.parsed.rows[2]!.cells.at(-1), "", "sin RATE → vacío (se cotizará)");
    assert.equal(out.parsed.rows[3]!.cells.at(-1), "", "RATE ilegible → vacío");
    assert.deepEqual(out.issues.map((entry) => entry.rowNumber), [1, 2]);
    assert.ok(out.issues.every((entry) => entry.issue.code === "RESERVATION_IMPORT_ROW_OPERA_TOTAL_ESTIMATED"));
    assert.deepEqual(out.estimates.get(1), { rateFirstNight: "120.50", estimatedTotal: "723.00" });
    assert.deepEqual(out.estimates.get(2), { rateFirstNight: "99.99", estimatedTotal: "199.98" });
    assert.equal(out.estimates.has(3), false);
    assert.equal(parsed.header.length, 6, "no muta la tabla original");
    assert.equal("__importe_total_estimado" in mapping, false, "no muta el mapeo original");
  });

  it("sin columna RATE, o con importe_total ya mapeado, no hace nada", () => {
    const noRate = estimateTotals(table(header.slice(0, 5), [["RIAS-1", "20261012", "20261015", "3", "2"]]), mapping);
    assert.equal(noRate.applied, false);
    assert.equal(noRate.parsed.header.length, 5);
    const withTotal = estimateTotals(table([...header, "TOTAL"], [["RIAS-1", "20261012", "20261015", "3", "2", "120.50", "500"]]), { ...mapping, TOTAL: "importe_total" });
    assert.equal(withTotal.applied, false);
    assert.equal(withTotal.issues.length, 0);
  });
});

describe("injectReferences · informes sin nº de confirmación", () => {
  it("añade __referencia_externa con el nº de confirmación del enlace que casa por (habitación, llegada, salida); sin enlace queda vacía", () => {
    const header = ["Room No.", "Arr. Date", "Dep. Date", "Res. Status"];
    const mapping: ReservationImportMapping = { "Room No.": "habitacion", "Arr. Date": "llegada", "Dep. Date": "salida", "Res. Status": "estado" };
    const parsed = table(header, [
      ["201", "18/09/2026", "20/09/2026", "Checked Out"],
      ["0202", "17/09/2026", "20/09/2026", "Due Out"],
      ["", "17/09/2026", "20/09/2026", "Due Out"]
    ]);
    const links = new Map([[stayKeyOf("201", "2026-09-18", "2026-09-20"), "RIAS-7001"]]);
    const out = injectReferences(parsed, mapping, (stay) => links.get(stayKeyOf(stay.roomNumber, stay.arrivalDate, stay.departureDate)) ?? null);
    assert.equal(out.applied, true);
    assert.equal(out.resolved, 1);
    assert.equal(out.parsed.header.at(-1), RESERVATION_IMPORT_SYNC_REFERENCE_COLUMN);
    assert.equal(out.mapping[RESERVATION_IMPORT_SYNC_REFERENCE_COLUMN], "referencia_externa");
    assert.deepEqual(out.parsed.rows.map((row) => row.cells.at(-1)), ["RIAS-7001", "", ""]);
    assert.equal(stayKeyOf("0202", "2026-09-17", "2026-09-20"), stayKeyOf("202", "2026-09-17", "2026-09-20"), "ceros a la izquierda plegados");
    const already = injectReferences(table([...header, "Conf"], [["201", "18/09/2026", "20/09/2026", "Checked Out", "X"]]), { ...mapping, Conf: "referencia_externa" }, () => "no");
    assert.equal(already.applied, false, "con columna de referencia no hace nada");
  });
});

describe("syncRowHash · estable y sin datos personales", () => {
  it("mismo hash con otro huésped, otro e-mail y otro importe cotizado; distinto al cambiar llegada, tarifa, habitación, importe del fichero o estado destino", () => {
    const base = syncRowHash(normalizedRow());
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(syncRowHash(normalizedRow({ guest: { firstName: "Marek", surname1: "Nowak", email: "marek.nowak@example.com", phone: "+48600111002", documentNumber: "AB1234567" } })), base, "el huésped no entra en el hash");
    assert.equal(syncRowHash(normalizedRow({ notes: "otra nota", specialRequests: "cama extra", vipFlag: true, estimatedArrivalTime: "18:00" })), base, "notas, peticiones, vip y hora no entran");
    assert.equal(syncRowHash(normalizedRow({ totalAmount: "999.00", totalSource: "quoted" })), syncRowHash(normalizedRow({ totalAmount: "0.00", totalSource: "none" })), "un importe cotizado no cuenta");
    assert.notEqual(syncRowHash(normalizedRow({ arrivalDate: "2026-10-13", nights: 2 })), base);
    assert.notEqual(syncRowHash(normalizedRow({ ratePlanCode: "BAR-BB", ratePlanId: "rp_bb" })), base);
    assert.notEqual(syncRowHash(normalizedRow({ roomId: "room_201", roomNumber: "201" })), base);
    assert.notEqual(syncRowHash(normalizedRow({ totalAmount: "313.00" })), base);
    assert.notEqual(syncRowHash(normalizedRow({ targetStatus: "checked_in" })), base);
    assert.notEqual(syncRowHash(normalizedRow({ adults: 1 })), base);
    assert.notEqual(syncRowHash(normalizedRow({ groupCode: "GRP-2" })), base);
    const json = JSON.stringify(normalizedRow());
    assert.doesNotMatch(base, /Ferreiro|example/, "hex puro");
    assert.ok(json.includes("Ferreiro"), "la fila sí lleva PII; el hash no depende de ella");
  });
});

describe("decideSyncAction · veredicto por fila (diseño §5.1, §5.3)", () => {
  const rowHash = syncRowHash(normalizedRow());

  it("sin enlace ni reserva local → create; destino checked_in con habitación → transición check_in; sin habitación → OPERA_CHECKIN_WITHOUT_ROOM", () => {
    const plain = decideSyncAction({ rowNumber: 1, normalized: normalizedRow(), rowHash });
    assert.equal(plain.action, "create");
    assert.equal(plain.transition, null);
    assert.equal(plain.reactivate, false);
    assert.deepEqual(plain.issues, []);
    const inHouse = decideSyncAction({ rowNumber: 2, normalized: normalizedRow({ targetStatus: "checked_in", roomId: "room_201", roomNumber: "201" }), rowHash });
    assert.equal(inHouse.action, "create");
    assert.equal(inHouse.transition, "check_in");
    const noRoom = decideSyncAction({ rowNumber: 3, normalized: normalizedRow({ targetStatus: "checked_in" }), rowHash });
    assert.equal(noRoom.action, "create");
    assert.equal(noRoom.transition, null);
    assert.equal(noRoom.checkInWithoutRoom, true);
    assert.deepEqual(noRoom.issues.map((issue) => issue.code), ["RESERVATION_IMPORT_ROW_OPERA_CHECKIN_WITHOUT_ROOM"]);
    const out = decideSyncAction({ rowNumber: 4, normalized: normalizedRow({ targetStatus: "checked_out", roomId: "room_201", roomNumber: "201" }), rowHash });
    assert.equal(out.transition, "check_in_and_out");
    const historical = decideSyncAction({ rowNumber: 5, normalized: normalizedRow({ targetStatus: "checked_out", historical: true }), rowHash });
    assert.equal(historical.transition, null, "una histórica nace cerrada en createReservation");
    assert.equal(historical.checkInWithoutRoom, false);
    assert.equal(decideSyncAction({ rowNumber: 6, normalized: normalizedRow({ targetStatus: "cancelled", estado: "cancelada" }), rowHash }).transition, "cancel");
    assert.equal(decideSyncAction({ rowNumber: 7, normalized: normalizedRow({ targetStatus: "no_show" }), rowHash }).transition, "no_show");
    assert.equal(decideSyncAction({ rowNumber: 8, normalized: normalizedRow({ targetStatus: "skip" }), rowHash }).action, "skip");
  });

  it("sin enlace pero con reserva activa local con esa referencia → skip OPERA_CONFLICT_LOCAL_RESERVATION (nunca se toca)", () => {
    const decision = decideSyncAction({ rowNumber: 1, normalized: normalizedRow(), rowHash, activeUnlinkedReservation: { id: "res_local", code: "RES-00009", status: "confirmed" } });
    assert.equal(decision.action, "skip");
    assert.equal(decision.currentStatus, "confirmed");
    assert.deepEqual(decision.issues.map((issue) => issue.code), ["RESERVATION_IMPORT_ROW_OPERA_CONFLICT_LOCAL_RESERVATION"]);
    assert.match(decision.issues[0]!.message, /RES-00009/);
    assert.equal(decision.issues[0]!.details?.reservationCode, "RES-00009");
  });

  it("enlace + mismo hash + mismo estado → unchanged; hash distinto → update con diff SIN valores; diff vacío pero estado distinto → transition", () => {
    const same = decideSyncAction({ rowNumber: 1, normalized: normalizedRow(), rowHash, link: linked() });
    assert.equal(same.action, "unchanged");
    assert.deepEqual(same.diff, []);
    assert.equal(same.currentStatus, "confirmed");

    const moved = normalizedRow({ arrivalDate: "2026-10-13", departureDate: "2026-10-16", adults: 1, totalAmount: "250.00" });
    const update = decideSyncAction({ rowNumber: 2, normalized: moved, rowHash: syncRowHash(moved), link: linked() });
    assert.equal(update.action, "update");
    assert.deepEqual(update.diff, ["arrivalDate", "departureDate", "adults", "totalAmount"]);
    assert.equal(update.transition, null);
    assert.equal(JSON.stringify(update).includes("2026-10-13"), false, "el diff solo lleva nombres de campo");

    const cancel = normalizedRow({ targetStatus: "cancelled", estado: "cancelada" });
    const transition = decideSyncAction({ rowNumber: 3, normalized: cancel, rowHash: syncRowHash(cancel), link: linked() });
    assert.equal(transition.action, "transition");
    assert.equal(transition.transition, "cancel");
    assert.deepEqual(transition.diff, []);

    const both = normalizedRow({ targetStatus: "checked_in", roomId: "room_201", roomNumber: "201", adults: 1 });
    const updateAndCheckIn = decideSyncAction({ rowNumber: 4, normalized: both, rowHash: syncRowHash(both), link: linked() });
    assert.equal(updateAndCheckIn.action, "update");
    assert.deepEqual(updateAndCheckIn.diff, ["adults", "assignedRoomId"]);
    assert.equal(updateAndCheckIn.transition, "check_in");

    const checkOut = normalizedRow({ targetStatus: "checked_out" });
    const fromInHouse = decideSyncAction({ rowNumber: 5, normalized: checkOut, rowHash: syncRowHash(checkOut), link: linked({ status: "checked_in", assignedRoomId: "room_201" }) });
    assert.equal(fromInHouse.action, "transition");
    assert.equal(fromInHouse.transition, "check_out");
  });

  it("campos que el fichero no trae no son afirmaciones: sin canal ni empresa no hay diff aunque la reserva los tenga", () => {
    const partial = normalizedRow({ sourceCode: undefined, channel: "direct", companyName: undefined, groupCode: undefined, marketSegment: undefined, totalAmount: "0.00", totalSource: "none" });
    assert.deepEqual(diffFields(partial, linked().reservation), []);
    const decision = decideSyncAction({ rowNumber: 1, normalized: partial, rowHash: syncRowHash(partial), link: linked() });
    assert.equal(decision.action, "unchanged");
  });

  it("alojada: cancelación / no-show → SYNC_CANCEL_AFTER_CHECKIN sin cambio; cambio de habitación → SYNC_ROOM_MOVE_IGNORED fuera del diff; llegada y tipo congelados", () => {
    const cancel = normalizedRow({ targetStatus: "cancelled", estado: "cancelada" });
    const decision = decideSyncAction({ rowNumber: 1, normalized: cancel, rowHash: syncRowHash(cancel), link: linked({ status: "checked_in", assignedRoomId: "room_201" }) });
    assert.equal(decision.action, "unchanged");
    assert.equal(decision.transition, null);
    assert.deepEqual(decision.issues.map((issue) => issue.code), ["RESERVATION_IMPORT_ROW_SYNC_CANCEL_AFTER_CHECKIN"]);

    const moved = normalizedRow({ targetStatus: "checked_in", roomId: "room_202", roomNumber: "202", arrivalDate: "2026-10-11", nights: 4, departureDate: "2026-10-16", roomTypeId: "rt_sup", roomTypeCode: "SUP" });
    const move = decideSyncAction({ rowNumber: 2, normalized: moved, rowHash: syncRowHash(moved), link: linked({ status: "checked_in", assignedRoomId: "room_201" }) });
    assert.equal(move.action, "update");
    assert.deepEqual(move.diff, ["departureDate"], "llegada, tipo y habitación quedan fuera del diff de una reserva alojada");
    assert.deepEqual(move.issues.map((issue) => issue.code), ["RESERVATION_IMPORT_ROW_SYNC_ROOM_MOVE_IGNORED"]);
  });

  it("regresión: confirmed sobre checked_in / checked_out, o checked_in sobre checked_out → skip SYNC_STATUS_REGRESSION", () => {
    const confirmed = normalizedRow();
    for (const status of ["checked_in", "checked_out"] as const) {
      const decision = decideSyncAction({ rowNumber: 1, normalized: confirmed, rowHash: syncRowHash(confirmed), link: linked({ status }) });
      assert.equal(decision.action, "skip", status);
      assert.deepEqual(decision.issues.map((issue) => issue.code), ["RESERVATION_IMPORT_ROW_SYNC_STATUS_REGRESSION"]);
    }
    const inHouse = normalizedRow({ targetStatus: "checked_in", roomId: "room_201", roomNumber: "201" });
    assert.equal(decideSyncAction({ rowNumber: 2, normalized: inHouse, rowHash: syncRowHash(inHouse), link: linked({ status: "checked_out" }) }).action, "skip");
    const closed = normalizedRow({ targetStatus: "checked_out", adults: 1 });
    const stay = decideSyncAction({ rowNumber: 3, normalized: closed, rowHash: syncRowHash(closed), link: linked({ status: "checked_out" }) });
    assert.equal(stay.action, "unchanged", "una estancia cerrada no admite cambios de campos");
    assert.deepEqual(stay.diff, []);
  });

  it("reactivación: enlace a cancelada / no-show y OPERA la trae viva → create + REFERENCE_REUSED_CANCELLED + reactivate; cancelada sobre cancelada → unchanged", () => {
    const alive = normalizedRow();
    const decision = decideSyncAction({ rowNumber: 1, normalized: alive, rowHash: syncRowHash(alive), link: linked({ status: "cancelled" }, { lastStatus: "cancelled" }) });
    assert.equal(decision.action, "create");
    assert.equal(decision.reactivate, true);
    assert.equal(decision.currentStatus, "cancelled");
    assert.deepEqual(decision.issues.map((issue) => issue.code), ["RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED"]);
    const dead = normalizedRow({ targetStatus: "no_show" });
    const still = decideSyncAction({ rowNumber: 2, normalized: dead, rowHash: syncRowHash(dead), link: linked({ status: "cancelled" }) });
    assert.equal(still.action, "unchanged");
    assert.equal(still.reactivate, false);
  });

  it("enlace confirmado y destino checked_in sin habitación en la fila ni asignada → OPERA_CHECKIN_WITHOUT_ROOM, sin transición; con habitación asignada → check_in", () => {
    const inHouse = normalizedRow({ targetStatus: "checked_in" });
    const noRoom = decideSyncAction({ rowNumber: 1, normalized: inHouse, rowHash: syncRowHash(inHouse), link: linked() });
    assert.equal(noRoom.transition, null);
    assert.equal(noRoom.checkInWithoutRoom, true);
    assert.deepEqual(noRoom.issues.map((issue) => issue.code), ["RESERVATION_IMPORT_ROW_OPERA_CHECKIN_WITHOUT_ROOM"]);
    const assigned = decideSyncAction({ rowNumber: 2, normalized: inHouse, rowHash: syncRowHash(inHouse), link: linked({ assignedRoomId: "room_201" }) });
    assert.equal(assigned.transition, "check_in");
    assert.equal(assigned.action, "transition");
  });
});

describe("computeMissing · ventana por feed (diseño §5.2)", () => {
  const links = [
    { confirmationNo: "RIAS-1", reservationCode: "RES-1", status: "confirmed" as const, arrivalDate: "2026-09-17", departureDate: "2026-09-20", missingStreak: 0 },
    { confirmationNo: "RIAS-2", reservationCode: "RES-2", status: "checked_in" as const, arrivalDate: "2026-09-15", departureDate: "2026-09-18", missingStreak: 1 },
    { confirmationNo: "RIAS-3", reservationCode: "RES-3", status: "confirmed" as const, arrivalDate: "2026-10-30", departureDate: "2026-11-02", missingStreak: 0 },
    { confirmationNo: "RIAS-4", reservationCode: "RES-4", status: "cancelled" as const, arrivalDate: "2026-09-17", departureDate: "2026-09-18", missingStreak: 0 },
    { confirmationNo: "RIAS-5", reservationCode: "RES-5", status: "confirmed" as const, arrivalDate: "2026-09-16", departureDate: "2026-09-17", missingStreak: 0 }
  ];

  it("arrivals: llegada ∈ [businessDate, +horizonte]; inhouse: llegada ≤ bd < salida; departures: salida = bd; changes: nada; las vistas y las canceladas nunca", () => {
    const seen = ["rias-3"];
    const arrivals = computeMissing({ feed: "arrivals", businessDate: "2026-09-17", horizonDays: 30, links, seenConfirmationNos: seen });
    assert.deepEqual(arrivals.map((entry) => entry.confirmationNo), ["RIAS-1"], "RIAS-3 vista (sin distinguir mayúsculas), RIAS-2 llegó antes, RIAS-4 cancelada, RIAS-5 llegó ayer");
    assert.deepEqual(arrivals[0], { confirmationNo: "RIAS-1", reservationCode: "RES-1", arrivalDate: "2026-09-17", missingStreak: 0 });
    const wide = computeMissing({ feed: "arrivals", businessDate: "2026-09-17", horizonDays: 60, links, seenConfirmationNos: [] });
    assert.deepEqual(wide.map((entry) => entry.confirmationNo), ["RIAS-1", "RIAS-3"]);
    const inhouse = computeMissing({ feed: "inhouse", businessDate: "2026-09-17", horizonDays: 30, links, seenConfirmationNos: [] });
    assert.deepEqual(inhouse.map((entry) => entry.confirmationNo), ["RIAS-2", "RIAS-1"], "orden por llegada; RIAS-5 sale hoy (bd < salida falla)");
    const departures = computeMissing({ feed: "departures", businessDate: "2026-09-18", horizonDays: 30, links, seenConfirmationNos: [] });
    assert.deepEqual(departures.map((entry) => entry.confirmationNo), ["RIAS-2"]);
    assert.deepEqual(computeMissing({ feed: "changes", businessDate: "2026-09-17", horizonDays: 30, links, seenConfirmationNos: [] }), []);
    assert.equal(syncWindowContains("arrivals", "2026-09-17", 30, { arrivalDate: "2026-10-17", departureDate: "2026-10-18" }), true, "borde superior incluido");
    assert.equal(syncWindowContains("arrivals", "2026-09-17", 30, { arrivalDate: "2026-10-18", departureDate: "2026-10-19" }), false);
  });
});

describe("hash de contenido · sal (feed, businessDate) en modo sync", () => {
  const header = ["RESERVATION_ID", "GUEST_LAST_NAME", "GUEST_FIRST_NAME", "ARRIVAL_DATE", "DEPARTURE_DATE", "ROOM_TYPE", "RESERVATION_STATUS"];
  const mapping: ReservationImportMapping = { RESERVATION_ID: "referencia_externa", GUEST_LAST_NAME: "apellidos", GUEST_FIRST_NAME: "nombre", ARRIVAL_DATE: "llegada", DEPARTURE_DATE: "salida", ROOM_TYPE: "tipo_habitacion", RESERVATION_STATUS: "estado" };
  const parsed = table(header, [["RIAS-1", "Ferreiro", "Lucía", "20261012", "20261015", "DBL", "Reserved"]]);
  const statusMap = OPERA_CLOUD_STATUS_MAP;

  it("mismo snapshot con otro businessDate → hash distinto; mismo (feed, businessDate) → mismo hash; otro feed → distinto", () => {
    const d1 = reservationImportContentHash(contentHashRowsOf(parsed, mapping, CATALOGS, { mode: "sync", statusMap, feed: "arrivals", businessDate: "2026-09-17" }));
    const d1Again = reservationImportContentHash(contentHashRowsOf(parsed, mapping, CATALOGS, { mode: "sync", statusMap, feed: "arrivals", businessDate: "2026-09-17" }));
    const d2 = reservationImportContentHash(contentHashRowsOf(parsed, mapping, CATALOGS, { mode: "sync", statusMap, feed: "arrivals", businessDate: "2026-09-18" }));
    const inhouse = reservationImportContentHash(contentHashRowsOf(parsed, mapping, CATALOGS, { mode: "sync", statusMap, feed: "inhouse", businessDate: "2026-09-17" }));
    assert.equal(d1, d1Again);
    assert.notEqual(d1, d2);
    assert.notEqual(d1, inhouse);
    // La fila sintética es `sync:<feed>:<businessDate>` en la lista de filas no normalizadas.
    const rows = contentHashRowsOf(parsed, mapping, CATALOGS, { mode: "sync", statusMap, feed: "arrivals", businessDate: "2026-09-17" });
    assert.deepEqual(rows.at(-1), { cells: ["sync:arrivals:2026-09-17"] });
    assert.equal(rows[0]!.normalized?.targetStatus, "confirmed");
  });

  it("modo create: sin sal y sin clave de estado destino (hash de la Tanda 7 intacto); un estado Reserved → Checked In del mismo día es otro corte", () => {
    const create = contentHashRowsOf(parsed, mapping, CATALOGS);
    assert.equal(create.length, 1);
    assert.equal(create[0]!.normalized?.targetStatus, undefined);
    assert.equal(reservationImportContentHash(create), reservationImportContentHash(contentHashRowsOf(parsed, mapping, CATALOGS, {})));
    const checkedIn = table(header, [["RIAS-1", "Ferreiro", "Lucía", "20261012", "20261015", "DBL", "Checked In"]]);
    const a = reservationImportContentHash(contentHashRowsOf(parsed, mapping, CATALOGS, { mode: "sync", statusMap, feed: "arrivals", businessDate: "2026-09-17" }));
    const b = reservationImportContentHash(contentHashRowsOf(checkedIn, mapping, CATALOGS, { mode: "sync", statusMap, feed: "arrivals", businessDate: "2026-09-17" }));
    assert.notEqual(a, b);
  });
});
