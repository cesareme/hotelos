import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PmsShadowAlertRecord, PmsShadowFeedStatus, PmsShadowOverview, PmsShadowProfileRecord, PmsShadowReconciliationRow, PmsShadowRunRecord, PmsShadowTrxCodeMapping } from "@hotelos/shared";
import {
  ALERT_CODE_LABELS,
  DICTIONARY_KEYS,
  FEED_LABELS,
  IMPORT_WIZARD_PATH,
  RECON_METRIC_LABELS,
  alertCodeLabel,
  alertCodeOptions,
  alertDetailLines,
  alertResolutionLabel,
  alertSeverityTone,
  buildSyncImportUrl,
  dictionaryRows,
  expectedTimeLabel,
  feedBusinessDateFor,
  feedLabel,
  feedOptions,
  feedStateTone,
  fileExtension,
  formatCounts,
  groupTrxMapping,
  isReservationFeed,
  isTrxMappingComplete,
  kpiCaption,
  lastFileLabel,
  overviewKpis,
  profileStatusOptions,
  profileSummary,
  reconciliationMetricLabel,
  reconciliationStatusLabel,
  reconciliationSummary,
  reconciliationTone,
  revenueStatusTone,
  rowsToDictionary,
  runSourceLabel,
  runStatusOptions,
  runStatusTone,
  trxRowsToMapping,
  unmappedTrxCount,
  uploadSummary
} from "../pms-shadow-helpers.ts";

// Tanda 7b · L4: the pure helpers of the «Modo sombra OPERA» panel. Fixtures are
// fictional (OPERA hotel code RIAS, Rías Altas, reservation codes only).

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

function run(over: Partial<PmsShadowRunRecord> = {}): PmsShadowRunRecord {
  return {
    id: "run_1",
    organizationId: "org_1",
    propertyId: "prop_1",
    feed: "arrivals",
    source: "email",
    businessDate: "2026-09-17",
    fileName: "res_detail_2026-09-17.csv",
    contentHash: "abc",
    status: "done",
    reservationImportId: "imp_1",
    revenueImportId: null,
    createdCount: 3,
    updatedCount: 12,
    unchangedCount: 40,
    transitionedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    result: {},
    alerts: [],
    errorMessage: null,
    correlationId: null,
    createdBy: null,
    startedAt: "2026-09-17T06:31:00.000Z",
    finishedAt: "2026-09-17T06:31:05.000Z",
    createdAt: "2026-09-17T06:31:00.000Z",
    ...over
  };
}

describe("pms-shadow-helpers · feeds, runs and alerts", () => {
  it("labels the eight feeds in Spanish and knows the four reservation feeds", () => {
    assert.deepEqual(Object.keys(FEED_LABELS), ["arrivals", "inhouse", "departures", "changes", "revenue", "profiles", "stats", "ohip_delta"]);
    assert.equal(feedLabel("arrivals"), "Llegadas");
    assert.equal(feedLabel("revenue"), "Ingresos del día");
    assert.equal(feedLabel("otro"), "otro");
    assert.equal(feedLabel(null), "—");
    for (const feed of ["arrivals", "inhouse", "departures", "changes"]) assert.equal(isReservationFeed(feed), true, feed);
    for (const feed of ["revenue", "stats", "profiles", "ohip_delta", null, ""]) assert.equal(isReservationFeed(feed), false, String(feed));
    assert.deepEqual(feedOptions({ withAll: true }).map((option) => option.value), ["", "arrivals", "inhouse", "departures", "changes", "revenue", "profiles", "stats", "ohip_delta"]);
    assert.deepEqual(feedOptions({ only: ["revenue", "stats"] }).map((option) => option.label), ["Ingresos del día", "Estadísticas y cuadre"]);
  });

  it("tones run statuses, feed states and alert severities (CocoaTone) and labels the sources", () => {
    assert.equal(runStatusTone("done"), "success");
    assert.equal(runStatusTone("partial"), "warning");
    assert.equal(runStatusTone("failed"), "danger");
    assert.equal(runStatusTone("processing"), "info");
    assert.equal(runStatusTone("otro"), "neutral");
    assert.deepEqual(runStatusOptions().map((option) => option.value), ["", "received", "processing", "done", "partial", "failed"]);
    assert.equal(feedStateTone("ok"), "success");
    assert.equal(feedStateTone("late"), "warning");
    assert.equal(feedStateTone("failed"), "danger");
    assert.equal(feedStateTone("unscheduled"), "neutral");
    assert.equal(alertSeverityTone("error"), "danger");
    assert.equal(alertSeverityTone("warning"), "warning");
    assert.equal(alertSeverityTone("info"), "info");
    assert.equal(alertSeverityTone("otra"), "neutral");
    assert.equal(runSourceLabel("api_key"), "Clave de API");
    assert.equal(runSourceLabel(null), "—");
  });

  it("formats the counters as «3 creadas · 12 actualizadas · 40 sin cambios» and appends the non-zero extras", () => {
    assert.equal(formatCounts(run()), "3 creadas · 12 actualizadas · 40 sin cambios");
    assert.equal(formatCounts(run({ transitionedCount: 2, skippedCount: 1, errorCount: 4 })), "3 creadas · 12 actualizadas · 40 sin cambios · 2 con cambio de estado · 1 omitida · 4 con error");
    // FUX-7B-07: singular with 1, plural with 0 and from 2.
    assert.equal(formatCounts(run({ createdCount: 1, updatedCount: 1, unchangedCount: 1, skippedCount: 1, errorCount: 1 })), "1 creada · 1 actualizada · 1 sin cambios · 1 omitida · 1 con error");
    assert.equal(formatCounts(run({ createdCount: 0, updatedCount: 0, unchangedCount: 0 })), "sin filas");
    assert.equal(formatCounts(run({ createdCount: 1234, updatedCount: 0, unchangedCount: 0 })), "1234 creadas · 0 actualizadas · 0 sin cambios");
    assert.equal(formatCounts(null), "—");
  });

  it("paints the feed table cells: expected time with «obligatorio», last file with its date", () => {
    const feed = (over: Partial<PmsShadowFeedStatus>): PmsShadowFeedStatus => ({ feed: "arrivals", expectedTime: "06:30", required: true, state: "ok", lastRun: run(), ...over });
    assert.equal(expectedTimeLabel(feed({})), "06:30 (obligatorio)");
    assert.equal(expectedTimeLabel(feed({ required: false })), "06:30");
    assert.equal(expectedTimeLabel(feed({ expectedTime: null })), "—");
    assert.match(lastFileLabel(run()), /^res_detail_2026-09-17\.csv · 17\/09\/2026/);
    assert.match(lastFileLabel(run({ fileName: null })), /^sin nombre · /);
    assert.equal(lastFileLabel(null), "—");
  });

  it("labels the eleven alert codes and describes a resolution without personal data", () => {
    assert.equal(Object.keys(ALERT_CODE_LABELS).length, 11);
    assert.equal(alertCodeLabel("OPERA_FEED_LATE"), "Corte de OPERA no recibido a la hora prevista");
    assert.equal(alertCodeLabel("OTRO"), "OTRO");
    assert.deepEqual(alertCodeOptions()[0], { value: "", label: "Todos los códigos" });
    assert.equal(alertCodeOptions().length, 12);
    const alert = (over: Partial<PmsShadowAlertRecord>): PmsShadowAlertRecord => ({
      id: "al_1",
      organizationId: "org_1",
      propertyId: "prop_1",
      businessDate: "2026-09-17",
      code: "OPERA_RECON_COUNT_MISMATCH",
      severity: "error",
      message: "Los conteos del día no cuadran con OPERA",
      expected: { arrivals: 12 },
      actual: { arrivals: 11 },
      runId: "run_1",
      confirmationNo: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      createdAt: "2026-09-17T07:00:00.000Z",
      ...over
    });
    assert.equal(alertResolutionLabel(alert({})), "Abierta");
    assert.match(alertResolutionLabel(alert({ resolvedAt: "2026-09-17T09:00:00.000Z", resolutionNote: "Llegada tardía registrada en OPERA" })), /^Resuelta el 17\/09\/2026, .* · Llegada tardía registrada en OPERA$/);
    assert.deepEqual(alertDetailLines(alert({})), ["Esperado: arrivals 12", "Obtenido: arrivals 11"]);
    assert.deepEqual(alertDetailLines(alert({ expected: {}, actual: { codes: ["1000", "2000"] } })), ['Obtenido: codes ["1000","2000"]']);
  });
});

describe("pms-shadow-helpers · reconciliation", () => {
  it("tones and labels the three row statuses and every metric of the rules", () => {
    assert.equal(reconciliationTone("ok"), "success");
    assert.equal(reconciliationTone("mismatch"), "danger");
    assert.equal(reconciliationTone("missing"), "neutral");
    assert.equal(reconciliationTone("otro"), "neutral");
    assert.equal(reconciliationStatusLabel("ok"), "Cuadra");
    assert.equal(reconciliationStatusLabel("mismatch"), "No cuadra");
    assert.equal(reconciliationStatusLabel("missing"), "Sin dato de OPERA");
    for (const metric of ["arrivals", "departures", "rooms_occupied", "occupancy_pct", "no_shows", "revenue_rooms", "revenue_total", "tax_total", "adr", "revpar", "transaction_total_today", "reservations_made", "cancellations"]) {
      assert.ok(RECON_METRIC_LABELS[metric], metric);
    }
    assert.equal(reconciliationMetricLabel("revenue_rooms"), "Ingresos de alojamiento");
    assert.equal(reconciliationMetricLabel("desconocida"), "desconocida");
    const rows: PmsShadowReconciliationRow[] = [
      { metric: "arrivals", opera: "12", anfitorio: "12", delta: "0", status: "ok" },
      { metric: "departures", opera: "9", anfitorio: "8", delta: "-1", status: "mismatch" },
      { metric: "adr", opera: null, anfitorio: "98.50", delta: null, status: "missing" }
    ];
    assert.equal(reconciliationSummary(rows), "1 cuadran · 1 no cuadran · 1 sin dato");
  });
});

describe("pms-shadow-helpers · link to the wizard", () => {
  it("builds /recepcion/reservas/importar?modo=sync&perfil=opera_cloud&feed=<feed>&fecha=<YYYY-MM-DD>", () => {
    assert.equal(IMPORT_WIZARD_PATH, "/recepcion/reservas/importar");
    assert.equal(buildSyncImportUrl({ feed: "arrivals", businessDate: "2026-09-17" }), "/recepcion/reservas/importar?modo=sync&perfil=opera_cloud&feed=arrivals&fecha=2026-09-17");
    assert.equal(buildSyncImportUrl({ feed: "departures" }), "/recepcion/reservas/importar?modo=sync&perfil=opera_cloud&feed=departures");
    assert.equal(buildSyncImportUrl({ feed: "changes", businessDate: "17/09/2026" }), "/recepcion/reservas/importar?modo=sync&perfil=opera_cloud&feed=changes");
    assert.equal(buildSyncImportUrl({ feed: "inhouse", businessDate: null }, "/otra/ruta"), "/otra/ruta?modo=sync&perfil=opera_cloud&feed=inhouse");
  });

  it("feedBusinessDateFor applies the feed's businessDateOffset of the profile schedule (SC-07: departures → yesterday), today otherwise", () => {
    const schedule = [
      { feed: "arrivals" as const, businessDateOffset: 0 as const },
      { feed: "departures" as const, businessDateOffset: -1 as const },
      { feed: "changes" as const, businessDateOffset: -1 as const }
    ];
    assert.equal(feedBusinessDateFor("arrivals", schedule, "2026-09-17"), "2026-09-17");
    assert.equal(feedBusinessDateFor("departures", schedule, "2026-09-17"), "2026-09-16");
    assert.equal(feedBusinessDateFor("changes", schedule, "2026-03-01"), "2026-02-28", "cruza el mes");
    assert.equal(feedBusinessDateFor("departures", schedule, "2027-01-01"), "2026-12-31", "cruza el año");
    assert.equal(feedBusinessDateFor("inhouse", schedule, "2026-09-17"), "2026-09-17", "sin entrada en la programación: hoy");
    assert.equal(feedBusinessDateFor("departures", [], "2026-09-17"), "2026-09-17", "perfil sin programación: hoy");
    assert.equal(feedBusinessDateFor("departures", schedule, null), null);
    assert.equal(feedBusinessDateFor("departures", schedule, "17/09/2026"), null, "fecha que no es YYYY-MM-DD: sin fecha (el asistente toma la de la propiedad)");
  });
});

describe("pms-shadow-helpers · profile", () => {
  const mapping: PmsShadowTrxCodeMapping[] = [
    { code: "1000", description: "Room Revenue", transactionType: "Lodging", kind: "revenue", accountCode: "705.1", usaliDepartment: "rooms" },
    { code: "2000", description: "Breakfast", kind: "revenue", accountCode: "705.2" },
    { code: "8000", description: "VAT 10 %", kind: "tax" },
    { code: "9000", description: "Cash", kind: "payment", accountCode: "570" },
    { code: "9500", description: "Paid out", kind: "ignore" },
    { code: "1500", description: "Minibar", kind: "revenue", accountCode: "705.3", usaliDepartment: "other_operated" }
  ];

  it("groups the transaction codes by kind, sorted by code, with «sin mapear» flagged (no account, or no USALI department on a revenue line)", () => {
    const groups = groupTrxMapping(mapping);
    assert.deepEqual(groups.map((group) => [group.kind, group.label, group.rows.map((row) => row.code), group.unmappedCount]), [
      ["revenue", "Ingreso", ["1000", "1500", "2000"], 1],
      ["tax", "Impuesto repercutido", ["8000"], 1],
      ["payment", "Cobro", ["9000"], 0],
      ["ignore", "Sin asiento", ["9500"], 0]
    ]);
    assert.deepEqual(groups[0].rows.map((row) => row.unmapped), [false, false, true]);
    assert.equal(unmappedTrxCount(mapping), 2);
    assert.equal(unmappedTrxCount([]), 0);
    assert.equal(unmappedTrxCount(null), 0);
    assert.deepEqual(groupTrxMapping([]), []);
    assert.equal(isTrxMappingComplete({ kind: "ignore" }), true);
    assert.equal(isTrxMappingComplete({ kind: "tax", accountCode: " " }), false);
    assert.equal(isTrxMappingComplete({ kind: "payment", accountCode: "572" }), true);
  });

  it("sanitises the editable rows before the PUT (blank codes dropped, blank optionals absent, trimmed)", () => {
    const rows: PmsShadowTrxCodeMapping[] = [
      { code: " 1000 ", description: " Room Revenue ", kind: "revenue", accountCode: " 705.1 ", usaliDepartment: "rooms", taxRateCode: "" },
      { code: "", kind: "revenue", accountCode: "705.1" },
      { code: "8000", description: "", kind: "tax", accountCode: "", transactionType: "Tax" }
    ];
    assert.deepEqual(trxRowsToMapping(rows), [
      { code: "1000", description: "Room Revenue", kind: "revenue", accountCode: "705.1", usaliDepartment: "rooms" },
      { code: "8000", kind: "tax", transactionType: "Tax" }
    ]);
  });

  it("turns the master dictionaries into editable rows and back", () => {
    assert.deepEqual(DICTIONARY_KEYS, ["roomTypes", "rateCodes", "marketCodes", "sourceCodes", "paymentTypes"]);
    assert.deepEqual(dictionaryRows({ SUP: "SUP", DBL: "", STD: "DBL" }), [
      { key: "DBL", value: "", unmapped: true },
      { key: "STD", value: "DBL", unmapped: false },
      { key: "SUP", value: "SUP", unmapped: false }
    ]);
    assert.deepEqual(dictionaryRows(undefined), []);
    assert.deepEqual(rowsToDictionary([{ key: " STD ", value: " DBL " }, { key: "", value: "X" }, { key: "PM", value: "" }]), { STD: "DBL", PM: "" });
  });

  it("summarises the profile for the drawer trigger and offers the two statuses", () => {
    const profile = (over: Partial<PmsShadowProfileRecord>): Pick<PmsShadowProfileRecord, "operaHotelCode" | "status" | "trxMapping"> => ({ operaHotelCode: "RIAS", status: "active", trxMapping: mapping, ...over });
    assert.equal(profileSummary(profile({})), "RIAS · Activo · 2 sin mapear");
    assert.equal(profileSummary(profile({ status: "paused", trxMapping: [mapping[0]] })), "RIAS · En pausa · transaction codes completos");
    assert.equal(profileSummary(null), "Sin perfil: crea el perfil de mapeo para empezar");
    assert.deepEqual(profileStatusOptions(), [
      { value: "active", label: "Activo" },
      { value: "paused", label: "En pausa" }
    ]);
    assert.equal(revenueStatusTone("posted"), "success");
    assert.equal(revenueStatusTone("reversed"), "warning");
  });
});

describe("pms-shadow-helpers · KPI strip and manual upload", () => {
  const overview: Pick<PmsShadowOverview, "lastRunAt" | "linkedReservations" | "openAlerts" | "lastReconciledDate"> = {
    lastRunAt: "2026-09-17T06:31:00.000Z",
    linkedReservations: 187,
    openAlerts: 2,
    lastReconciledDate: "2026-09-16"
  };

  it("captions each KPI from the overview", () => {
    const now = new Date("2026-09-17T09:31:00.000Z");
    assert.equal(kpiCaption(overview, "lastRun", now), "hace 3 horas");
    assert.equal(kpiCaption(overview, "linked"), "Reservas con enlace a OPERA");
    assert.equal(kpiCaption(overview, "alerts"), "2 pendientes de resolver");
    assert.equal(kpiCaption(overview, "reconciled"), "Reconciliación en verde");
    const empty = { lastRunAt: null, linkedReservations: 0, openAlerts: 0, lastReconciledDate: null };
    assert.equal(kpiCaption(empty, "lastRun"), "Ningún corte recibido todavía");
    assert.equal(kpiCaption(empty, "linked"), "Todavía sin reservas sincronizadas");
    assert.equal(kpiCaption(empty, "alerts"), "Ninguna alerta abierta");
    assert.equal(kpiCaption(empty, "reconciled"), "Ningún día conciliado todavía");
  });

  it("builds the four KPIs of §6.6 with their degraded labels", () => {
    const kpis = overviewKpis(overview, new Date("2026-09-17T09:31:00.000Z"));
    assert.deepEqual(kpis.map((kpi) => [kpi.key, kpi.label, kpi.degradedLabel, kpi.tone]), [
      ["lastRun", "Último corte", "lastRunAt", "info"],
      ["linked", "Reservas enlazadas", "linkedReservations", "success"],
      ["alerts", "Alertas abiertas", "openAlerts", "warning"],
      ["reconciled", "Último día conciliado", "lastReconciledDate", "success"]
    ]);
    assert.equal(kpis[1].value, "187");
    assert.equal(kpis[3].value, "16/09/2026");
    const empty = overviewKpis({ lastRunAt: null, linkedReservations: 0, openAlerts: 0, lastReconciledDate: null });
    assert.deepEqual(empty.map((kpi) => kpi.value), ["—", "0", "0", "—"]);
    assert.equal(empty[2].tone, "success");
  });

  it("summarises a manual upload for the toast and reads the extension only as a hint", () => {
    assert.equal(
      uploadSummary({ status: "done", counts: { created: 0, updated: 0, unchanged: 0, transitioned: 0, skipped: 0, error: 0 }, run: { feed: "revenue", businessDate: "2026-09-16" } }),
      "Corte de ingresos del día del 16/09/2026 registrado (procesado) · sin filas"
    );
    assert.equal(
      uploadSummary({ status: "partial", counts: { created: 2, updated: 1, unchanged: 0, transitioned: 0, skipped: 0, error: 1 }, run: { feed: "arrivals", businessDate: null } }),
      "Corte de llegadas registrado (parcial) · 2 creadas · 1 actualizada · 0 sin cambios · 1 con error"
    );
    assert.equal(fileExtension("GEN_XMLBO_REVENUE_RIAS.XML"), "xml");
    assert.equal(fileExtension("sin-extension"), "");
    assert.equal(fileExtension(null), "");
  });
});

describe("pms-shadow-helpers · module hygiene", () => {
  it("is pure (no React, no api-client, no import.meta), formats only through lib/format and imports @hotelos/shared as types only", () => {
    const source = read("../pms-shadow-helpers.ts");
    const code = stripComments(source);
    assert.doesNotMatch(code, /from "react"|api-client|import\.meta|window\./);
    assert.match(code, /from "\.\.\/\.\.\/lib\/format";/);
    assert.doesNotMatch(code, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/);
    for (const line of source.split("\n").filter((entry) => /from "@hotelos\/shared"/.test(entry))) assert.match(line, /^(?:import|export) type\b|^\} from "@hotelos\/shared";$/, `runtime import from @hotelos/shared: ${line}`);
    assert.doesNotMatch(source, /^import \{[^}]*\} from "@hotelos\/shared";/m);
  });
});
