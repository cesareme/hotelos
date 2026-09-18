import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ORPHAN_OUTLET_LABEL,
  TIME_ZONE_WARNING_TITLE,
  UTC_FALLBACK_LABEL,
  cashSummaryOutletOptions,
  countLabel,
  degradedCounterLabel,
  degradedCounters,
  invoiceSeries,
  invoiceSeriesLabel,
  outletRowLabel,
  posCashWarnings,
  ticketsCaption,
  timeZoneLabel,
  type PosCashSummaryLike
} from "../posSummaryView.ts";

// Tanda L3 · lote P1 «POS front honesto»: the board paints what the arqueo of
// GET /pos/cash-summary does NOT contain (open tickets are not revenue; rows
// without settlement or without closedAt; counters that failed; a property
// without time zone) and the REAL series of a ticket's simplified invoice
// (prefix of the number the API returns, never a constant of the UI — §6.15).
// The helpers are pure; the screen and the client reach api-client
// (import.meta.env) and cannot load under node --test, so their recipe is
// pinned on the source like finance-scope-usage.test.mts does.

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Intl es-ES separates the amount and «€» with a no-break space: compare on plain spaces. */
const plain = (text: string) => text.replace(/ /g, " ");

function clean(): PosCashSummaryLike {
  return {
    openTickets: { count: 0, total: 0 },
    totals: { tickets: 4, total: 61.4, bySettlement: { cash: 18, card: 43.4, room: 0 }, unsettled: { tickets: 0, total: 0, reason: "settlement_missing" } },
    unplaceable: { tickets: 0, total: 0, ids: [], reason: "closed_at_missing" },
    degraded: [],
    timeZone: "Europe/Madrid",
    timeZoneSource: "property"
  };
}

describe("Punto de venta · avisos del arqueo (posCashWarnings)", () => {
  it("a clean count has nothing to warn about", () => {
    assert.deepEqual(posCashWarnings(clean()), []);
  });

  it("open tickets of the window are pending, not revenue (count and amount, es-ES)", () => {
    const [w, ...rest] = posCashWarnings({ ...clean(), openTickets: { count: 2, total: 12.5 } });
    assert.equal(rest.length, 0);
    assert.equal(w.kind, "open_tickets");
    assert.equal(w.tone, "warning");
    assert.equal(w.count, 2);
    assert.equal(w.amount, 12.5);
    assert.match(plain(w.message), /^2 comandas abiertas por 12,50 € /);
    assert.match(w.message, /no son ingreso/);
    const [one] = posCashWarnings({ ...clean(), openTickets: { count: 1, total: 3 } });
    assert.match(plain(one.message), /^1 comanda abierta por 3,00 € /);
  });

  it("closed rows without a settlement count in the total but in no method", () => {
    const base = clean();
    const [w] = posCashWarnings({ ...base, totals: { ...base.totals, unsettled: { tickets: 3, total: 40.25, reason: "settlement_missing" } } });
    assert.equal(w.kind, "unsettled");
    assert.equal(w.count, 3);
    assert.equal(w.amount, 40.25);
    assert.match(plain(w.message), /^3 comandas cerradas por 40,25 € /);
    assert.match(w.message, /no en efectivo, tarjeta ni habitación/);
  });

  it("closed rows without closedAt are outside every window (danger)", () => {
    const [w] = posCashWarnings({ ...clean(), unplaceable: { tickets: 1, total: 9.9, ids: ["pos_1"], reason: "closed_at_missing" } });
    assert.equal(w.kind, "unplaceable");
    assert.equal(w.tone, "danger");
    assert.match(plain(w.message), /^1 comanda cerrada por 9,90 € /);
    assert.match(w.message, /fuera de los totales/);
  });

  it("a failed counter is named as not available (never a zero) and its own notice is suppressed", () => {
    const warnings = posCashWarnings({ ...clean(), openTickets: { count: 0, total: 0 }, degraded: ["openTickets", "unplaceable"] });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, "degraded");
    assert.equal(warnings[0].title, "Indicadores no disponibles");
    assert.match(warnings[0].message, /comandas abiertas y comandas cerradas sin fecha de cierre/);
    assert.match(warnings[0].message, /no como cero/);
    assert.equal(degradedCounterLabel("openTickets"), "comandas abiertas");
    assert.equal(degradedCounterLabel("somethingElse"), "somethingElse", "an unknown label is shown raw, never hidden");
    assert.deepEqual(degradedCounters({ degraded: ["unplaceable"] }), { openTickets: false, unplaceable: true });
    assert.deepEqual(degradedCounters({ degraded: [] }), { openTickets: false, unplaceable: false });
  });

  it("a property without time zone is a notice «zona horaria del hotel no configurada» and the label names the fallback", () => {
    const utc = { ...clean(), timeZone: "UTC", timeZoneSource: "utc_fallback" as const };
    const [w] = posCashWarnings(utc);
    assert.equal(w.kind, "time_zone");
    assert.equal(w.title, TIME_ZONE_WARNING_TITLE);
    assert.match(w.title, /[Zz]ona horaria del hotel no configurada/);
    assert.match(w.message, /medianoche UTC/);
    assert.equal(timeZoneLabel(utc), UTC_FALLBACK_LABEL);
    assert.equal(timeZoneLabel(clean()), "Europe/Madrid");
  });

  it("reads in a fixed order: failed counters, open, unsettled, unplaceable, time zone", () => {
    const base = clean();
    const kinds = posCashWarnings({
      ...base,
      openTickets: { count: 1, total: 1 },
      totals: { ...base.totals, unsettled: { tickets: 1, total: 1, reason: "settlement_missing" } },
      unplaceable: { tickets: 1, total: 1, ids: ["x"], reason: "closed_at_missing" },
      degraded: ["custom"],
      timeZone: "UTC",
      timeZoneSource: "utc_fallback"
    }).map((w) => w.kind);
    assert.deepEqual(kinds, ["degraded", "open_tickets", "unsettled", "unplaceable", "time_zone"]);
  });
});

describe("Punto de venta · serie real de la factura simplificada", () => {
  it("is the prefix of the number the API returns (with or without the centre code)", () => {
    assert.equal(invoiceSeries("SIM-2026-000001"), "SIM");
    assert.equal(invoiceSeries("SIM-RA-2026-000001"), "SIM");
    assert.equal(invoiceSeries("FAC-2026-000016"), "FAC");
    assert.equal(invoiceSeries("  sim-2026-000002 "), "SIM");
    assert.equal(invoiceSeriesLabel("SIM-2026-000001"), "Serie SIM");
  });

  it("is null when there is no number or the value is not a series-prefixed number", () => {
    assert.equal(invoiceSeries(null), null);
    assert.equal(invoiceSeries(undefined), null);
    assert.equal(invoiceSeries(""), null);
    assert.equal(invoiceSeries("cmu4805uo000afyvlr44ufp8r"), null);
    assert.equal(invoiceSeries("2026-000001"), null);
    assert.equal(invoiceSeriesLabel(null), null);
  });
});

describe("Punto de venta · filas y filtro por punto de venta del arqueo", () => {
  it("names an orphan Outlet FK honestly and keeps real names", () => {
    assert.equal(outletRowLabel({ outletName: "Bar" }), "Bar");
    assert.equal(outletRowLabel({ outletName: null }), ORPHAN_OUTLET_LABEL);
    assert.equal(outletRowLabel({ outletName: "   " }), ORPHAN_OUTLET_LABEL);
  });

  it("offers one option per board outlet id, skips orphan rows and deduplicates rows of one type", () => {
    assert.deepEqual(
      cashSummaryOutletOptions([
        { outletId: "out_bar", outletName: "Bar" },
        { outletId: null, outletName: null },
        { outletId: "out_restaurant", outletName: "Restaurante" },
        { outletId: "out_bar", outletName: "Bar de la piscina" }
      ]),
      [
        { value: "out_bar", label: "Bar" },
        { value: "out_restaurant", label: "Restaurante" }
      ]
    );
    assert.deepEqual(cashSummaryOutletOptions([]), []);
  });

  it("formats counts and amounts in es-ES (grouping from five digits, comma decimals)", () => {
    assert.equal(plain(ticketsCaption(3, 12.5)), "3 comandas · 12,50 €");
    assert.equal(plain(ticketsCaption(1, 1000)), "1 comanda · 1000,00 €");
    assert.equal(countLabel(1234), "1234");
    assert.equal(countLabel(12500), "12.500");
  });
});

describe("Punto de venta · recipe pinned on the source (PosDashboard.tsx · posApi.ts · posSummaryView.ts)", () => {
  const screen = source("../PosDashboard.tsx");
  const client = source("../../../services/posApi.ts");
  const helpers = source("../posSummaryView.ts");

  it("reads the hotel inside the component through the ONE «Ámbito» (never a module-level PROPERTY_ID) and waits for the structure", () => {
    assert.doesNotMatch(screen, /const PROPERTY_ID = getActivePropertyId\(\)/);
    assert.doesNotMatch(screen, /getActivePropertyId|getActiveProperty\(/);
    assert.match(screen, /useFinanceScope\("centre_default", \{ excludeOffice: true \}\)/);
    assert.match(screen, /const propertyId = finance\.propertyId \?\? finance\.active\.propertyId;/);
    assert.match(screen, /<FinanceScopeSelector scope=\{finance\} \/>/);
    assert.match(screen, /eyebrow=\{finance\.eyebrow\("Operaciones"\)\}/);
    assert.match(screen, /finance\.loading \? null : `\/properties\/\$\{propertyId\}\/pos\/tickets`/);
    assert.match(screen, /if \(finance\.loading\) return;/);
    assert.match(screen, /\}, \[propertyId, finance\.loading\]\);/);
    assert.doesNotMatch(screen, /\}, \[propertyId\]\);/, "every reader keyed on propertyId also depends on finance.loading");
  });

  it("every property-bound call carries the hotel in scope (outlets, tickets, arqueo, opening a ticket)", () => {
    for (const call of ["fetchPosOutlets(propertyId)", "fetchPosCashSummary({ ...cashSummaryWindow(csFrom, csTo), outletId: csOutletId || undefined }, propertyId)", "openPosTicket({ outletId, roomNumber: roomNumber || undefined }, propertyId)"]) {
      assert.ok(screen.includes(call), `PosDashboard: ${call}`);
    }
    assert.match(screen, /cashSummary\.propertyId === propertyId/, "a count of another hotel is never shown");
  });

  it("paints the side counters of the arqueo (open · unsettled · unplaceable · degraded · time zone) through the pure helpers", () => {
    for (const marker of ["posCashWarnings(", "degradedCounters(", "timeZoneLabel(", "UTC_FALLBACK_LABEL", 'timeZoneSource === "utc_fallback"', "openTickets.count", "openTickets.total", "totals.unsettled", "unsettledLabel(", 'kind="degraded"', "degraded={cashDegraded.openTickets}", 'rowKey="outletRowId"', "cashSummaryOutletOptions(summary.byOutlet)"]) {
      assert.ok(screen.includes(marker), `PosDashboard: ${marker}`);
    }
    assert.doesNotMatch(screen, /rowKey="outletId"/, "the board outlet id is not unique per row (and may be null)");
  });

  it("shows the real series of the simplified invoice and never a hard-coded one", () => {
    assert.match(screen, /invoiceSeries\(value\)/);
    assert.match(screen, /invoiceSeriesLabel\(selected\.invoiceNumber\)/);
    assert.doesNotMatch(screen, /\bFS\b/, "the «FS» series of the old comments is gone (§6.15)");
    assert.doesNotMatch(screen, /["'`]SIM["'`]/, "the series is read from the number, never a UI constant");
  });

  it("adds no inline style and no colour literal (Cocoa 22 rules 5 · 6)", () => {
    // 7 layout props + the rule-6 comment that names `style={{…}}` (the Cocoa contract counts both; budget 40): none added by L3-P1.
    assert.ok((screen.match(/\bstyle=\{/g) ?? []).length <= 8, "PosDashboard keeps its 8 pre-existing style={ matches (7 layout props + 1 comment)");
    for (const src of [screen, helpers]) {
      assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/);
      assert.doesNotMatch(src, /\b(?:rgba?|hsla?)\(/);
      assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/);
    }
  });

  it("the client mirrors the API shape of GET /pos/cash-summary (pos-cash-closure.service.ts)", () => {
    for (const marker of [
      "propertyId: string;",
      "date: string | null;",
      "outletId: string | null;",
      "timeZone: string;",
      "timeZoneSource: PosCashTimeZoneSource;",
      'export type PosCashTimeZoneSource = "property" | "utc_fallback";',
      "outletRowId: string;",
      "outletName: string | null;",
      "unsettled: PosCashUnsettled;",
      "openTickets: PosCashOpenTickets;",
      "unplaceable: PosCashUnplaceable;",
      "degraded: string[];",
      'source: "pos_orders";',
      'reason: "settlement_missing"',
      'reason: "closed_at_missing"',
      "ids: string[]"
    ]) {
      assert.ok(client.includes(marker), `posApi.ts: ${marker}`);
    }
    assert.match(client, /export type PosSettlementTotals = Record<PosSettlement, number>;/);
  });

  it("the helpers are pure (no React, no api-client) and format through lib/format (Intl es-ES)", () => {
    const imports = helpers.match(/^import .* from "[^"]+";$/gm) ?? [];
    assert.ok(imports.length >= 2, "the helper imports lib/format and the wire types");
    for (const line of imports) assert.doesNotMatch(line, /react|api-client|activeProperty|useApiData|components\/cocoa\/Cocoa/, line);
    assert.doesNotMatch(helpers, /import\.meta\.env/);
    assert.match(helpers, /import \{ money, number, plural \} from "\.\.\/\.\.\/lib\/format";/);
    assert.doesNotMatch(helpers, /new Intl\./, "no second es-ES formatter next to lib/format");
  });
});
