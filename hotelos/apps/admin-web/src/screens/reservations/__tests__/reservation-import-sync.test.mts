import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ReservationImportPreview, ReservationImportSummary, ReservationImportSyncResult } from "@hotelos/shared";
import {
  SYNC_ACTION_LABELS,
  SYNC_CALLOUT_HELP,
  hasSyncWork,
  isSyncMode,
  parseImportLotParam,
  parseSyncSearchParams,
  skipsMappingStep,
  syncActionLabel,
  syncActionTitle,
  syncActionTone,
  syncBlockers,
  syncCalloutText,
  syncImportButtonLabel,
  syncRequestFields,
  syncResultLines,
  syncResultTitle,
  syncRowOutcomeLabel,
  syncRowOutcomeTone,
  syncSummaryKpis
} from "../reservation-import-sync.ts";

// Tanda 7b · L4: the sync mode of the wizard is driven by the query string the
// «Modo sombra OPERA» panel builds (buildSyncImportUrl) — no react-router, the
// screen reads window.location.search — and every helper here is pure.

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("reservation-import-sync · parseSyncSearchParams", () => {
  it("resolves the four literals of the panel link (with or without the leading «?»)", () => {
    const expected = { mode: "sync", profile: "opera_cloud", feed: "arrivals", businessDate: "2026-09-17" };
    assert.deepEqual(parseSyncSearchParams("?modo=sync&perfil=opera_cloud&feed=arrivals&fecha=2026-09-17"), expected);
    assert.deepEqual(parseSyncSearchParams("modo=sync&perfil=opera_cloud&feed=arrivals&fecha=2026-09-17"), expected);
    assert.deepEqual(parseSyncSearchParams("?fecha=2026-09-17&feed=departures&perfil=opera_cloud&modo=sync"), { mode: "sync", profile: "opera_cloud", feed: "departures", businessDate: "2026-09-17" });
  });

  it("accepts the four reservation feeds and nothing else", () => {
    for (const feed of ["arrivals", "inhouse", "departures", "changes"]) {
      assert.equal(parseSyncSearchParams(`?modo=sync&perfil=opera_cloud&feed=${feed}`).feed, feed);
    }
    for (const feed of ["revenue", "stats", "profiles", "ohip_delta", "", "ARRIVALS", "llegadas"]) {
      assert.deepEqual(parseSyncSearchParams(`?modo=sync&perfil=opera_cloud&feed=${feed}`), { mode: "create" }, feed);
    }
  });

  it("falls back to create on any invalid or missing value (mode, profile, feed) and on an empty or malformed search", () => {
    assert.deepEqual(parseSyncSearchParams(""), { mode: "create" });
    assert.deepEqual(parseSyncSearchParams("?"), { mode: "create" });
    assert.deepEqual(parseSyncSearchParams("?modo=create&perfil=opera_cloud&feed=arrivals"), { mode: "create" });
    assert.deepEqual(parseSyncSearchParams("?modo=sync&perfil=mews&feed=arrivals"), { mode: "create" });
    assert.deepEqual(parseSyncSearchParams("?modo=sync&feed=arrivals"), { mode: "create" });
    assert.deepEqual(parseSyncSearchParams("?modo=sync&perfil=opera_cloud"), { mode: "create" });
    assert.deepEqual(parseSyncSearchParams("?dev=1"), { mode: "create" });
    assert.deepEqual(parseSyncSearchParams("?modo=SYNC&perfil=opera_cloud&feed=arrivals"), { mode: "create" });
  });

  it("keeps sync but drops a business date that is not a real YYYY-MM-DD (the screen fills today)", () => {
    for (const fecha of ["17/09/2026", "2026-9-7", "2026-13-01", "2026-02-30", "hoy", ""]) {
      const parsed = parseSyncSearchParams(`?modo=sync&perfil=opera_cloud&feed=inhouse&fecha=${fecha}`);
      assert.equal(parsed.mode, "sync", fecha);
      assert.equal(parsed.businessDate, undefined, fecha);
    }
    assert.equal(parseSyncSearchParams("?modo=sync&perfil=opera_cloud&feed=inhouse&fecha=2026-02-28").businessDate, "2026-02-28");
  });

  it("isSyncMode reads the mode only", () => {
    assert.equal(isSyncMode({ mode: "sync" }), true);
    assert.equal(isSyncMode({ mode: "create" }), false);
  });

  it("parseImportLotParam reads ?lote=<id> (the panel's «Ver lote») and rejects anything that is not an id", () => {
    assert.equal(parseImportLotParam("?lote=imp_cmu4abc123"), "imp_cmu4abc123");
    assert.equal(parseImportLotParam("?modo=sync&lote=imp-1"), "imp-1");
    assert.equal(parseImportLotParam("?lote="), null);
    assert.equal(parseImportLotParam("?lote=../x"), null);
    assert.equal(parseImportLotParam(""), null);
    assert.equal(parseImportLotParam("?dev=1"), null);
  });
});

describe("reservation-import-sync · request fields and copy", () => {
  it("adds mode, profile, feed and businessDate in sync mode and NOTHING in create mode (the Tanda 7 bodies do not change)", () => {
    const sync = parseSyncSearchParams("?modo=sync&perfil=opera_cloud&feed=changes&fecha=2026-09-16");
    assert.deepEqual(syncRequestFields(sync, sync.businessDate), { mode: "sync", profile: "opera_cloud", feed: "changes", businessDate: "2026-09-16" });
    assert.deepEqual(syncRequestFields(sync, "2026-09-17"), { mode: "sync", profile: "opera_cloud", feed: "changes", businessDate: "2026-09-17" });
    assert.deepEqual(syncRequestFields(sync, "17/09/2026"), { mode: "sync", profile: "opera_cloud", feed: "changes" });
    assert.deepEqual(syncRequestFields(sync, null), { mode: "sync", profile: "opera_cloud", feed: "changes" });
    assert.deepEqual(syncRequestFields({ mode: "create" }, "2026-09-17"), {});
    assert.deepEqual(Object.keys(syncRequestFields({ mode: "create" }, "2026-09-17")), []);
  });

  it("paints the callout as «Modo sincronizar: perfil OPERA Cloud · feed <label> · fecha de negocio <fecha>»", () => {
    const sync = parseSyncSearchParams("?modo=sync&perfil=opera_cloud&feed=arrivals&fecha=2026-09-17");
    assert.equal(syncCalloutText(sync, sync.businessDate), "Modo sincronizar: perfil OPERA Cloud · feed Llegadas · fecha de negocio 17/09/2026");
    assert.equal(syncCalloutText(sync, null), "Modo sincronizar: perfil OPERA Cloud · feed Llegadas · fecha de negocio sin fijar");
    assert.match(SYNC_CALLOUT_HELP, /nada se borra/);
    assert.match(SYNC_CALLOUT_HELP, /«Columnas»/);
  });
});

describe("reservation-import-sync · steps, action column and counters", () => {
  const preview = (over: Partial<Pick<ReservationImportPreview, "header" | "mappingSource" | "missingRequired">>) => ({
    header: ["RESERVATION_ID", "ARRIVAL_DATE", "RATE"],
    mappingSource: { RESERVATION_ID: "explicit", ARRIVAL_DATE: "explicit", RATE: "explicit" },
    missingRequired: [],
    ...over
  }) as Pick<ReservationImportPreview, "header" | "mappingSource" | "missingRequired">;

  it("skips «Columnas» only in sync mode, with every column explicit and nothing mandatory missing", () => {
    assert.equal(skipsMappingStep(preview({}), { mode: "sync" }), true);
    assert.equal(skipsMappingStep(preview({}), { mode: "create" }), false);
    assert.equal(skipsMappingStep(preview({ mappingSource: { RESERVATION_ID: "explicit", ARRIVAL_DATE: "synonym", RATE: "explicit" } }), { mode: "sync" }), false);
    assert.equal(skipsMappingStep(preview({ mappingSource: { RESERVATION_ID: "explicit", ARRIVAL_DATE: "explicit" } }), { mode: "sync" }), false);
    assert.equal(skipsMappingStep(preview({ missingRequired: ["llegada"] }), { mode: "sync" }), false);
    assert.equal(skipsMappingStep(preview({ header: [], mappingSource: {} }), { mode: "sync" }), false);
    assert.equal(skipsMappingStep(null, { mode: "sync" }), false);
  });

  it("labels and tones the five sync actions in Spanish and titles the row with the diffed field names only", () => {
    assert.deepEqual(Object.keys(SYNC_ACTION_LABELS), ["create", "update", "unchanged", "transition", "skip"]);
    assert.equal(syncActionLabel("update"), "Actualizar");
    assert.equal(syncActionLabel("transition"), "Cambio de estado");
    assert.equal(syncActionLabel(null), "—");
    assert.equal(syncActionLabel("otra"), "otra");
    assert.equal(syncActionTone("create"), "success");
    assert.equal(syncActionTone("transition"), "warning");
    assert.equal(syncActionTone(undefined), "neutral");
    assert.equal(syncActionTitle({ action: "update", reservationCode: "RES-00081", diff: ["arrivalDate", "ratePlanId"] }), "Actualizar · RES-00081 (arrivalDate, ratePlanId)");
    assert.equal(syncActionTitle({ action: "create" }), "Crear");
    assert.equal(syncActionTitle(null), undefined);
  });

  it("adds the three sync counters after the six of the Tanda 7 and knows when the snapshot has work besides creations", () => {
    const summary: ReservationImportSummary = { valid: 10, warning: 2, error: 0, skipped: 1, historical: 0, toCreate: 3, toUpdate: 12, unchanged: 40, toTransition: 2 };
    assert.deepEqual(
      syncSummaryKpis(summary).map((kpi) => [kpi.key, kpi.label, kpi.value, kpi.tone]),
      [
        ["toUpdate", "A actualizar", "12", "info"],
        ["unchanged", "Sin cambios", "40", undefined],
        ["toTransition", "Cambio de estado", "2", "warning"]
      ]
    );
    assert.deepEqual(syncSummaryKpis({}).map((kpi) => kpi.value), ["0", "0", "0"]);
    assert.equal(hasSyncWork(summary), true);
    assert.equal(hasSyncWork({}), false);
    assert.equal(hasSyncWork({ toCreate: 5 } as ReservationImportSummary), false);
  });

  it("drops the create-only blocker when the snapshot only updates rows, keeps everything else", () => {
    const blockers = ["no hay ninguna reserva que crear", "2 filas con errores: corrígelas o activa «Omitir filas inválidas»"];
    assert.deepEqual(syncBlockers(blockers, { toUpdate: 3 }), ["2 filas con errores: corrígelas o activa «Omitir filas inválidas»"]);
    assert.deepEqual(syncBlockers(blockers, { toCreate: 0 } as ReservationImportSummary), blockers);
    assert.deepEqual(syncBlockers(blockers, null), blockers);
    assert.notEqual(syncBlockers(blockers, null), blockers, "returns a copy");
  });

  it("names the primary action «Sincronizar …» with the counters that are not zero", () => {
    assert.equal(syncImportButtonLabel({ toCreate: 3, toUpdate: 12, toTransition: 1 }), "Sincronizar 3 nuevas · 12 actualizadas · 1 cambio de estado");
    assert.equal(syncImportButtonLabel({ toCreate: 1, toUpdate: 0, toTransition: 0 }), "Sincronizar 1 nueva");
    assert.equal(syncImportButtonLabel({ toCreate: 0, toUpdate: 0, toTransition: 0 }), "Sincronizar");
    assert.equal(syncImportButtonLabel(null), "Sincronizar");
  });
});

describe("reservation-import-sync · result", () => {
  const sync: ReservationImportSyncResult = {
    feed: "arrivals",
    businessDate: "2026-09-17",
    counts: { created: 3, updated: 12, unchanged: 40, transitioned: 2, skipped: 1, error: 0 },
    missing: [
      { confirmationNo: "12345678", reservationCode: "IMP-RA-2026-101", arrivalDate: "2026-09-20", missingStreak: 1 },
      { confirmationNo: "12345679", reservationCode: "IMP-RA-2026-102", arrivalDate: "2026-09-21", missingStreak: 2 }
    ],
    conflicts: [{ rowNumber: 7, confirmationNo: "99999999", reservationCode: "RES-00081" }],
    checkInWithoutRoom: [{ confirmationNo: "12345680", reservationCode: "IMP-RA-2026-103" }]
  };

  it("labels the new outcomes (updated · unchanged · transitioned) and leaves the classic ones to the Tanda 7 helpers", () => {
    assert.equal(syncRowOutcomeLabel("updated"), "Actualizada");
    assert.equal(syncRowOutcomeLabel("unchanged"), "Sin cambios");
    assert.equal(syncRowOutcomeLabel("transitioned"), "Cambio de estado");
    assert.equal(syncRowOutcomeLabel("created"), null);
    assert.equal(syncRowOutcomeTone("updated"), "info");
    assert.equal(syncRowOutcomeTone("error"), null);
  });

  it("titles the result with the feed, the business date and the counters that matter", () => {
    assert.equal(syncResultTitle(sync), "Sincronizado el corte de llegadas del 17/09/2026: 3 creadas · 12 actualizadas · 40 sin cambios · 2 con cambio de estado · 1 omitidas");
    assert.equal(syncResultTitle({ ...sync, counts: { ...sync.counts, transitioned: 0, skipped: 0 } }), "Sincronizado el corte de llegadas del 17/09/2026: 3 creadas · 12 actualizadas · 40 sin cambios");
  });

  it("lists absent reservations, local conflicts and check-ins without a room by reservation code, never by guest", () => {
    const lines = syncResultLines(sync);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^2 reservas ausentes del corte \(alerta, no se cancelan; hasta 2 cortes seguidos\): IMP-RA-2026-101, IMP-RA-2026-102\.$/);
    assert.match(lines[1], /^1 conflicto con una reserva creada en ehotelOS \(filas omitidas\): fila 7 · RES-00081\.$/);
    assert.match(lines[2], /^1 check-in en OPERA sin habitación válida \(permanecen confirmadas\): IMP-RA-2026-103\.$/);
    for (const line of lines) assert.doesNotMatch(line, /12345678|99999999/, "confirmation numbers stay out of the lines (codes only)");
    assert.deepEqual(syncResultLines({ missing: [], conflicts: [], checkInWithoutRoom: [] }), []);
    assert.deepEqual(syncResultLines(null), []);
  });

  it("caps long code lists at eight and counts the rest", () => {
    const missing = Array.from({ length: 11 }, (_, index) => ({ confirmationNo: String(index), reservationCode: `IMP-${index}`, arrivalDate: "2026-09-20", missingStreak: 1 }));
    const [line] = syncResultLines({ missing, conflicts: [], checkInWithoutRoom: [] });
    assert.match(line, /IMP-7 y 3 más\.$/);
  });
});

describe("reservation-import-sync · module hygiene", () => {
  it("is pure (no React, no api-client, no import.meta), formats only through lib/format and imports @hotelos/shared as types only", () => {
    const source = read("../reservation-import-sync.ts");
    const code = stripComments(source);
    assert.doesNotMatch(code, /from "react"|api-client|import\.meta|window\./);
    assert.match(code, /from "\.\.\/\.\.\/lib\/format";/);
    assert.doesNotMatch(code, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/);
    for (const line of source.split("\n").filter((entry) => /from "@hotelos\/shared"/.test(entry))) assert.match(line, /^(?:import|export) type\b|^\} from "@hotelos\/shared";$/, `runtime import from @hotelos/shared: ${line}`);
    assert.doesNotMatch(source, /^import \{[^}]*\} from "@hotelos\/shared";/m);
  });
});
