// Unit tests · Tanda 7b · L3 — reglas puras del modo sombra OPERA Cloud
// (pms-shadow.rules.ts): clasificación del feed, cabecera sintética, contexto de
// sistema, alertas del sync, feeds tardíos, reconciliación §5.4, métricas declaradas
// (JSON / XML) y origen del run → origen del lote. Sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/pms-shadow/__tests__/pms-shadow-rules.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPERA_CLOUD_DEPARTURE_ALL_HEADER, OPERA_CLOUD_RESPONSYS_HEADER, PMS_SHADOW_FEED_LATE_GRACE_MINUTES, PMS_SHADOW_SYSTEM_USER_ID } from "@hotelos/shared";
import {
  DEFAULT_PMS_SHADOW_SCHEDULE,
  PMS_SHADOW_DECLARED_KEYS,
  PMS_SHADOW_RECON_METRICS,
  PMS_SHADOW_SYSTEM_DEVICE_ID,
  PMS_SHADOW_UNRECOGNIZED_FEED,
  addDaysIso,
  buildAlertsFromSyncResult,
  classifyFeed,
  compareReconciliation,
  computeLateFeeds,
  foldLabel,
  headerOverrideFor,
  lateFeedKey,
  localDateTime,
  mapRunSourceToImportSource,
  normalizeDeclaredStats,
  parseDeclaredStats,
  parseStatNumber,
  reconciliationAlertMessage,
  reconciliationMismatches,
  scheduleFeedsOf,
  systemContext,
  zonedDayWindowUtc
} from "../pms-shadow.rules.js";

const RESPONSYS_HEAD = `${OPERA_CLOUD_RESPONSYS_HEADER.join(",")}\r\nRIAS-1001,Ferreiro,Lucía,,,,BDC,Hotel,20260920,20260922,2,2,0,1,DBL,,,120.00,,,VI,,,,,,,,,,BAR,,Reserved\r\n`;
const REVENUE_HEAD = `<?xml version="1.0" encoding="UTF-8"?>\n<revenue hotel_code="RIAS" date="2026-09-16">\n  <transaction_total transaction_type="REVENUE"><transaction_code>1000</transaction_code></transaction_total>\n</revenue>`;

describe("classifyFeed — por nombre de fichero y, si no, por cabecera / contenido", () => {
  it("nombres de export e informe de Oracle", () => {
    assert.equal(classifyFeed({ fileName: "RESPONSYS_RESV_AUTO_20260916.csv" }), "arrivals");
    assert.equal(classifyFeed({ fileName: "res_detail_20260916.txt" }), "arrivals");
    assert.equal(classifyFeed({ fileName: "departure_all.txt" }), "departures");
    assert.equal(classifyFeed({ fileName: "gibyroom_RIAS.txt" }), "inhouse");
    assert.equal(classifyFeed({ fileName: "rescancel.txt" }), "changes");
    assert.equal(classifyFeed({ fileName: "nanoshow.csv" }), "changes");
    assert.equal(classifyFeed({ fileName: "resreservyesterday.txt" }), "changes");
    assert.equal(classifyFeed({ fileName: "GEN_XMLBO_REVENUE_RIAS_20260916.xml" }), "revenue");
    assert.equal(classifyFeed({ fileName: "findeptcodes.xml" }), "revenue");
    assert.equal(classifyFeed({ fileName: "RESPONSYS_TRX_AUTO.csv" }), "revenue");
    assert.equal(classifyFeed({ fileName: "manager_report.xml" }), "stats");
    assert.equal(classifyFeed({ fileName: "trial_balance_20260916.xml" }), "stats");
    assert.equal(classifyFeed({ fileName: "GEN_XMLBO_STATISTICS.xml" }), "stats");
  });

  it("contenido: cabecera Responsys → arrivals; <revenue → revenue; Trn. Code / TRANSACTION_ID → revenue; statistic_record → stats", () => {
    assert.equal(classifyFeed({ fileName: "corte.csv", head: RESPONSYS_HEAD }), "arrivals");
    assert.equal(classifyFeed({ fileName: "salida.xml", head: REVENUE_HEAD }), "revenue");
    assert.equal(classifyFeed({ fileName: "informe.txt", head: "Trn. Code,Description,Day Gross,Day Net,Month Gross,Month Net,Year Gross,Year Net\n1000,Lodging,100.00,100.00" }), "revenue");
    assert.equal(classifyFeed({ fileName: "export.csv", head: "TRANSACTION_DATE,TRANSACTION_ID,RESERVATION_ID,REVENUE_TYPES,REVENUE_AMOUNTS,CURRENCY" }), "revenue");
    assert.equal(classifyFeed({ fileName: "x.xml", head: "<?xml version=\"1.0\"?><statistics><statistic_record><rooms>10</rooms></statistic_record></statistics>" }), "stats");
    assert.equal(classifyFeed({ fileName: "﻿corte.csv", head: `﻿${RESPONSYS_HEAD}` }), "arrivals", "BOM tolerado");
  });

  it("nada reconocible → null (el servicio lo registra como OPERA_FEED_UNRECOGNIZED con feed «unknown»)", () => {
    assert.equal(classifyFeed({ fileName: "notas.txt", head: "hola mundo" }), null);
    assert.equal(classifyFeed({ fileName: "", head: "" }), null);
    assert.equal(classifyFeed({ fileName: null, head: null }), null);
    assert.equal(classifyFeed({ fileName: "datos.xml", head: "<?xml version=\"1.0\"?><otra_cosa/>" }), null);
    assert.equal(PMS_SHADOW_UNRECOGNIZED_FEED, "unknown");
  });
});

describe("headerOverrideFor — «Delimited Data» sin fila de cabecera recibe la sintética del perfil", () => {
  const dataLine = ["201", "Marek Nowak", "", "", "", "", "17/09/2026", "19/09/2026", "1", "0", "1", "2", "DBL", "", "BAR", "Checked Out", "11:00", "CA", "0.00"].join(";");

  it("departures sin cabecera → las 19 columnas literales de departure_all", () => {
    assert.deepEqual(headerOverrideFor("departures", `${dataLine}\r\n`), [...OPERA_CLOUD_DEPARTURE_ALL_HEADER]);
    assert.deepEqual(headerOverrideFor("departures", ""), [...OPERA_CLOUD_DEPARTURE_ALL_HEADER], "fichero vacío: la sintética (el importador dirá que no hay filas)");
  });

  it("departures CON cabecera literal → undefined (el importador la lee tal cual); arrivals nunca (Responsys trae cabecera)", () => {
    assert.equal(headerOverrideFor("departures", `${OPERA_CLOUD_DEPARTURE_ALL_HEADER.join(";")}\r\n${dataLine}`), undefined);
    assert.equal(headerOverrideFor("arrivals", RESPONSYS_HEAD), undefined);
    assert.equal(headerOverrideFor("inhouse", "x"), undefined, "sin perfil de columnas");
  });

  it("foldLabel = foldValue de la Tanda 7", () => {
    assert.equal(foldLabel("Arrival Rooms"), "arrival_rooms");
    assert.equal(foldLabel("  % Rooms Occupied "), "rooms_occupied");
    assert.equal(foldLabel("Habitación Nº 1"), "habitacion_n_1");
  });
});

describe("systemContext y mapRunSourceToImportSource", () => {
  it("contexto de sistema: usr_system_pms_shadow, claves del sync + integrations.read + accounting.journal.post, nunca integrations.connect", () => {
    const context = systemContext("org_1", "prop_1");
    assert.equal(context.organizationId, "org_1");
    assert.equal(context.propertyId, "prop_1");
    assert.equal(context.userId, PMS_SHADOW_SYSTEM_USER_ID);
    assert.equal(context.fullName, "Modo sombra OPERA");
    assert.equal(context.deviceId, PMS_SHADOW_SYSTEM_DEVICE_ID);
    assert.equal(context.isPlatformAdmin, false);
    for (const key of ["pms.reservation.read", "pms.reservation.create", "pms.reservation.modify", "pms.checkin.execute", "pms.checkout.execute", "integrations.read", "accounting.journal.post"]) {
      assert.ok(context.permissions.includes(key as never), key);
    }
    assert.ok(!context.permissions.includes("integrations.connect" as never));
    assert.equal(context.permissions.length, 7);
  });

  it("origen del run → optionsJson.source del lote", () => {
    assert.equal(mapRunSourceToImportSource("email"), "email");
    assert.equal(mapRunSourceToImportSource("api_key"), "api_key");
    assert.equal(mapRunSourceToImportSource("cli"), "cli");
    assert.equal(mapRunSourceToImportSource("manual"), "http");
    assert.equal(mapRunSourceToImportSource("sftp"), "job");
    assert.equal(mapRunSourceToImportSource("ohip"), "job");
  });
});

describe("buildAlertsFromSyncResult — ausentes, conflictos y check-in sin habitación, sin nombres", () => {
  const run = { id: "run_1", feed: "arrivals", businessDate: "2026-09-17" };

  it("sin bloque sync → []", () => {
    assert.deepEqual(buildAlertsFromSyncResult(undefined, run), []);
    assert.deepEqual(buildAlertsFromSyncResult(null, run), []);
  });

  it("ausente 1 corte → warning; 2 o más → error; conflicto y check-in sin habitación → warning; nº de confirmación en la alerta", () => {
    const alerts = buildAlertsFromSyncResult(
      {
        feed: "arrivals",
        businessDate: "2026-09-17",
        counts: { created: 0, updated: 0, unchanged: 0, transitioned: 0, skipped: 0, error: 0 },
        missing: [
          { confirmationNo: "RIAS-1001", reservationCode: "RES-00001", arrivalDate: "2026-09-20", missingStreak: 1 },
          { confirmationNo: "RIAS-1002", reservationCode: "RES-00002", arrivalDate: "2026-09-21", missingStreak: 2 }
        ],
        conflicts: [{ rowNumber: 4, confirmationNo: "RIAS-1003", reservationCode: "RES-00003" }],
        checkInWithoutRoom: [{ confirmationNo: "RIAS-1004", reservationCode: "RES-00004" }]
      },
      run
    );
    assert.equal(alerts.length, 4);
    assert.deepEqual(alerts.map((alert) => [alert.code, alert.severity, alert.confirmationNo]), [
      ["OPERA_MISSING_IN_SNAPSHOT", "warning", "RIAS-1001"],
      ["OPERA_MISSING_IN_SNAPSHOT", "error", "RIAS-1002"],
      ["OPERA_CONFLICT_LOCAL_RESERVATION", "warning", "RIAS-1003"],
      ["OPERA_CHECKIN_WITHOUT_ROOM", "warning", "RIAS-1004"]
    ]);
    assert.match(alerts[0]!.message, /RIAS-1001 \(RES-00001, llegada 2026-09-20\)/);
    assert.match(alerts[1]!.message, /2 corte\(s\) consecutivo\(s\)/);
    assert.match(alerts[1]!.message, /confirma en OPERA/);
    assert.match(alerts[2]!.message, /fila 4/);
    assert.equal(alerts[0]!.details?.runId, "run_1");
    assert.equal(alerts[0]!.details?.missingStreak, 1);
    for (const alert of alerts) assert.ok(!/Ferreiro|Nowak|@/.test(alert.message), "sin datos personales");
  });
});

describe("fechas y zonas horarias", () => {
  it("localDateTime en Europe/Madrid (CEST) y zona inválida → UTC", () => {
    assert.deepEqual(localDateTime(new Date("2026-09-17T07:30:00Z"), "Europe/Madrid"), { date: "2026-09-17", minutes: 9 * 60 + 30 });
    assert.deepEqual(localDateTime(new Date("2026-09-16T22:30:00Z"), "Europe/Madrid"), { date: "2026-09-17", minutes: 30 });
    assert.deepEqual(localDateTime(new Date("2026-09-17T07:30:00Z"), "Zona/Inexistente"), { date: "2026-09-17", minutes: 7 * 60 + 30 });
  });

  it("zonedDayWindowUtc: el día natural de Madrid en UTC; addDaysIso cruza mes", () => {
    const window = zonedDayWindowUtc("2026-09-17", "Europe/Madrid");
    assert.equal(window.start.toISOString(), "2026-09-16T22:00:00.000Z");
    assert.equal(window.end.toISOString(), "2026-09-17T22:00:00.000Z");
    assert.equal(addDaysIso("2026-09-30", 1), "2026-10-01");
    assert.equal(addDaysIso("2026-03-01", -1), "2026-02-28");
  });

  it("scheduleFeedsOf ignora entradas malformadas y DEFAULT_PMS_SHADOW_SCHEDULE trae 5 feeds", () => {
    assert.equal(DEFAULT_PMS_SHADOW_SCHEDULE.feeds.length, 5);
    assert.deepEqual(scheduleFeedsOf(DEFAULT_PMS_SHADOW_SCHEDULE).map((feed) => feed.feed), ["arrivals", "departures", "changes", "revenue", "stats"]);
    assert.deepEqual(scheduleFeedsOf({ feeds: [{ feed: "arrivals", expectedTime: "25:00", businessDateOffset: 0, required: true }, { feed: "otro", expectedTime: "06:00" }, "x", { feed: "revenue", expectedTime: "7:00", businessDateOffset: -1, required: "sí" }] }), [
      { feed: "revenue", expectedTime: "7:00", businessDateOffset: -1, required: false }
    ]);
    assert.deepEqual(scheduleFeedsOf(null), []);
    assert.deepEqual(scheduleFeedsOf({}), []);
  });
});

describe("computeLateFeeds — hora esperada en la zona de la propiedad + gracia, businessDateOffset, solo required", () => {
  const profiles = [{ propertyId: "prop_ra", timezone: "Europe/Madrid", schedule: DEFAULT_PMS_SHADOW_SCHEDULE }];

  it("a las 09:30 de Madrid faltan arrivals (hoy) y departures (06:30 + 120; SC-07: business date de ayer, salidas ya «Checked Out») y revenue (07:00 + 120, ayer); changes y stats no son required", () => {
    const now = new Date("2026-09-17T07:30:00Z");
    const late = computeLateFeeds({ profiles, runsByPropertyFeedDate: new Set(), now });
    assert.deepEqual(
      late.map((entry) => [entry.feed, entry.businessDate, entry.deliveryDate, entry.minutesLate]),
      [
        ["arrivals", "2026-09-17", "2026-09-17", 180],
        ["departures", "2026-09-16", "2026-09-17", 180],
        ["revenue", "2026-09-16", "2026-09-17", 150]
      ]
    );
    assert.equal(DEFAULT_PMS_SHADOW_SCHEDULE.feeds.find((feed) => feed.feed === "departures")?.businessDateOffset, -1, "SC-07");
    assert.equal(PMS_SHADOW_FEED_LATE_GRACE_MINUTES, 120);
  });

  it("un run del feed y business date esperados lo saca de la lista; antes de la hora + gracia nada es tardío", () => {
    const now = new Date("2026-09-17T07:30:00Z");
    const runs = new Set([lateFeedKey("prop_ra", "arrivals", "2026-09-17"), lateFeedKey("prop_ra", "revenue", "2026-09-16")]);
    assert.deepEqual(computeLateFeeds({ profiles, runsByPropertyFeedDate: runs, now }).map((entry) => entry.feed), ["departures"]);
    assert.deepEqual(computeLateFeeds({ profiles, runsByPropertyFeedDate: new Set(), now: new Date("2026-09-17T06:29:00Z") }), [], "08:29 en Madrid: dentro de la gracia");
    assert.deepEqual(computeLateFeeds({ profiles, runsByPropertyFeedDate: new Set(), now, graceMinutes: 600 }), []);
  });

  it("un run del feed con OTRO business date no cuenta (el mismo snapshot otro día es otro corte)", () => {
    const now = new Date("2026-09-17T07:30:00Z");
    const runs = new Set([lateFeedKey("prop_ra", "arrivals", "2026-09-16")]);
    assert.ok(computeLateFeeds({ profiles, runsByPropertyFeedDate: runs, now }).some((entry) => entry.feed === "arrivals"));
  });
});

describe("parseStatNumber y normalizeDeclaredStats", () => {
  it("formatos ES / EN, porcentajes, negativos entre paréntesis, basura", () => {
    assert.equal(parseStatNumber("1.234,56")?.toFixed(2), "1234.56");
    assert.equal(parseStatNumber("1,234.56")?.toFixed(2), "1234.56");
    assert.equal(parseStatNumber("1,5")?.toFixed(2), "1.50");
    assert.equal(parseStatNumber("1.234.567")?.toFixed(0), "1234567");
    assert.equal(parseStatNumber("12 %")?.toFixed(0), "12");
    assert.equal(parseStatNumber("(5)")?.toFixed(0), "-5");
    assert.equal(parseStatNumber(98.5)?.toFixed(2), "98.50");
    assert.equal(parseStatNumber("abc"), null);
    assert.equal(parseStatNumber(""), null);
    assert.equal(parseStatNumber(null), null);
  });

  it("claves camelCase y sinónimos snake_case → canónicas y normalizadas (enteros para conteos, 2 decimales para importes)", () => {
    assert.deepEqual(normalizeDeclaredStats({ arrival_rooms: "12", roomRevenue: "1.234,5", adr: 98.5, occupancy_pct: "80,00 %", desconocida: "1", noShowRooms: null }), {
      arrivalRooms: "12",
      roomRevenue: "1234.50",
      adr: "98.50",
      occupancyPct: "80.00"
    });
    assert.equal(normalizeDeclaredStats({ nada: "1" }), null);
    assert.equal(normalizeDeclaredStats(null), null);
    assert.equal(normalizeDeclaredStats([1]), null);
    assert.equal(PMS_SHADOW_DECLARED_KEYS.length, PMS_SHADOW_RECON_METRICS.length);
  });
});

describe("parseDeclaredStats — JSON o XML (Manager Report / Trial Balance) → métricas declaradas", () => {
  it("JSON con claves canónicas o sinónimos", () => {
    assert.deepEqual(parseDeclaredStats('{"arrival_rooms":"12","room_revenue":"1.234,50","adr":98.5}'), { arrivalRooms: "12", roomRevenue: "1234.50", adr: "98.50" });
    assert.equal(parseDeclaredStats('{"otra":"1"}'), null);
    assert.equal(parseDeclaredStats("{ no es json"), null);
  });

  it("XML por filas con DESCRIPTION + DAY (modelo de datos del Manager Report) toma la columna Day", () => {
    const xml = `<?xml version="1.0"?>
<MANAGER_REPORT>
  <ROW><DESCRIPTION>Arrival Rooms</DESCRIPTION><DAY>12</DAY><MONTH>300</MONTH><YEAR>2400</YEAR></ROW>
  <ROW><DESCRIPTION>Rooms Occupied</DESCRIPTION><DAY>80</DAY><MONTH>1800</MONTH></ROW>
  <ROW><DESCRIPTION>% Rooms Occupied</DESCRIPTION><DAY>86.96</DAY></ROW>
  <ROW><DESCRIPTION>Room Revenue</DESCRIPTION><DAY>8123.45</DAY></ROW>
  <ROW><DESCRIPTION>Reservations Made Today</DESCRIPTION><DAY>7</DAY></ROW>
  <ROW><DESCRIPTION>Algo que no existe</DESCRIPTION><DAY>1</DAY></ROW>
</MANAGER_REPORT>`;
    assert.deepEqual(parseDeclaredStats(xml), { arrivalRooms: "12", roomsOccupied: "80", occupancyPct: "86.96", roomRevenue: "8123.45", reservationsMadeToday: "7" });
  });

  it("XML por nombre de elemento (Trial Balance) y bytes con BOM", () => {
    const xml = `<TRIAL_BALANCE><HOTEL>RIAS</HOTEL><TRANSACTION_TOTAL_TODAY>1725.20</TRANSACTION_TOTAL_TODAY><ROOM_REVENUE><DAY>1234.50</DAY><MONTH>9.99</MONTH></ROOM_REVENUE></TRIAL_BALANCE>`;
    assert.deepEqual(parseDeclaredStats(xml), { transactionTotalToday: "1725.20", roomRevenue: "1234.50" });
    assert.deepEqual(parseDeclaredStats(Buffer.from(`﻿${xml}`, "utf8")), { transactionTotalToday: "1725.20", roomRevenue: "1234.50" });
    assert.equal(parseDeclaredStats("<a><b>1</b></a>"), null);
    assert.equal(parseDeclaredStats("texto plano"), null);
    assert.equal(parseDeclaredStats("<roto"), null);
  });
});

describe("compareReconciliation — tolerancias de §5.4 y filas del panel", () => {
  it("ok dentro de tolerancia, mismatch fuera, missing cuando falta un lado", () => {
    const rows = compareReconciliation({
      declared: { arrivalRooms: "12", roomRevenue: "1234.50", adr: "100.00", occupancyPct: "80.05", transactionTotalToday: "1725.20" },
      computed: { arrivalRooms: "12", departureRooms: "3", roomRevenue: "1235.20", adr: "100.04", occupancyPct: "80.20", transactionTotalToday: "1725.20" }
    });
    const byMetric = new Map(rows.map((row) => [row.metric, row]));
    assert.equal(rows.length, PMS_SHADOW_RECON_METRICS.length);
    assert.deepEqual(byMetric.get("arrivals"), { metric: "arrivals", opera: "12", anfitorio: "12", delta: "0", status: "ok" });
    assert.deepEqual(byMetric.get("revenue_rooms"), { metric: "revenue_rooms", opera: "1234.50", anfitorio: "1235.20", delta: "0.70", status: "ok" }, "1 € de tolerancia en totales");
    assert.deepEqual(byMetric.get("adr"), { metric: "adr", opera: "100.00", anfitorio: "100.04", delta: "0.04", status: "ok" }, "0,05 € en ADR");
    assert.equal(byMetric.get("occupancy_pct")?.status, "mismatch", "0,15 puntos > 0,10");
    assert.deepEqual(byMetric.get("departures"), { metric: "departures", opera: null, anfitorio: "3", delta: null, status: "missing" });
    assert.deepEqual(byMetric.get("revenue_total"), { metric: "revenue_total", opera: null, anfitorio: "—", delta: null, status: "missing" });
    assert.equal(byMetric.get("transaction_total_today")?.status, "ok");
  });

  it("conteos exactos: 13 frente a 12 es mismatch; los mismatches se agrupan en conteos e importes y el mensaje cita métricas, nunca nombres", () => {
    const rows = compareReconciliation({ declared: { arrivalRooms: "12", totalRevenue: "1000.00" }, computed: { arrivalRooms: "13", totalRevenue: "1002.00" } });
    const groups = reconciliationMismatches(rows);
    assert.deepEqual(groups.count.map((row) => row.metric), ["arrivals"]);
    assert.deepEqual(groups.revenue.map((row) => row.metric), ["revenue_total"]);
    assert.equal(groups.count[0]?.delta, "1");
    const message = reconciliationAlertMessage("OPERA_RECON_COUNT_MISMATCH", "2026-09-17", groups.count);
    assert.match(message, /\(2026-09-17\): arrivals: OPERA 12 · ehotelOS 13 \(Δ 1\)/);
  });

  it("tolerancias personalizadas", () => {
    const rows = compareReconciliation({ declared: { totalRevenue: "1000.00" }, computed: { totalRevenue: "1002.00" }, tolerances: { revenueTotal: "5.00" } });
    assert.equal(rows.find((row) => row.metric === "revenue_total")?.status, "ok");
  });
});
