// Render benchmark: 100 plan rows × 365 days through react-dom/server.
//
// Proves the virtual window: with a 1400×800 viewport only the visible rows
// and columns (+ overscan) are mounted, so the SSR string holds ~1 000–2 000
// gridcells out of 36 500, and the render stays well under a second on a
// laptop. The grid's stylesheet import is DOM-guarded, so no loader hook is
// needed (chained `module.register` hooks break tsx on Node 24).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RateGridCell, RateGridResponse } from "@hotelos/shared";

function buildResponse(roomTypeCount: number, planCount: number, days: number): { response: RateGridResponse; dates: string[] } {
  const dates: string[] = [];
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < days; i++) dates.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  const roomTypes = Array.from({ length: roomTypeCount }, (_, i) => ({ id: `rt${i}`, code: `RT${i}`, name: `Tipo ${i}`, rooms: 10, sortOrder: i }));
  const ratePlans = Array.from({ length: planCount }, (_, i) =>
    i === 0
      ? { id: "bar", code: "BAR", name: "BAR", ratePlanType: "BAR", derivation: { mode: "none" as const, value: 0 }, active: true }
      : { id: `p${i}`, code: `P${i}`, name: `Plan ${i}`, ratePlanType: "NR", parentRatePlanId: "bar", derivation: { mode: "percent" as const, value: -5 * i }, active: true }
  );
  const cells: RateGridCell[] = [];
  for (const rt of roomTypes) {
    for (const p of ratePlans) {
      for (const d of dates) {
        cells.push({
          ratePlanId: p.id,
          roomTypeId: rt.id,
          date: d,
          basePrice: 100 + (d.charCodeAt(9) % 7) * 5,
          effectivePrice: 100,
          currency: "EUR",
          restrictions: d.endsWith("5") ? { minLos: 2 } : {},
          inventory: { total: 10, available: 6, outOfOrder: 0, stopSell: false },
          source: p.id === "bar" ? "manual" : "derived",
          derivedFrom: p.id === "bar" ? null : { ratePlanId: "bar", ratePlanCode: "BAR", derivation: p.derivation },
          sync: { booking: { status: "confirmed" } }
        });
      }
    }
  }
  return {
    response: { propertyId: "prop_123", from: dates[0], to: dates[dates.length - 1], currency: "EUR", roomTypes, ratePlans, channels: [{ id: "booking", providerCode: "booking_com", name: "Booking.com", channelType: "ota", status: "active", mode: "sandbox", markupPercent: 15, mappedProducts: roomTypeCount * planCount, readyToPush: true }], cells, generatedAt: "2026-01-01T00:00:00Z" },
    dates
  };
}

describe("render benchmark · 100 rows × 365 days", () => {
  it("mounts only the visible window and renders under 1.5 s", async () => {
    const { createElement } = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { CocoaRateGrid } = await import("../CocoaRateGrid.tsx");
    const { emptyDraft } = await import("../draft-store.ts");
    const { EMPTY_SELECTION } = await import("../types.ts");

    const { response, dates } = buildResponse(25, 4, 365); // 100 plan rows + 25 availability rows + 25 group rows
    assert.equal(response.cells.length, 36_500);

    const t0 = performance.now();
    const html = renderToString(
      createElement(CocoaRateGrid, {
        response,
        dates,
        view: "rates",
        layers: { demand: false, recommendations: false, sync: true },
        draft: emptyDraft(),
        selection: EMPTY_SELECTION,
        onSelectionChange: () => {},
        onCellEdit: () => {},
        onOpenQuickEdit: () => {},
        onOpenBulkEdit: () => {},
        onCellRecommendationAction: () => {},
        propertyName: "Bench",
        initialViewport: { width: 1400, height: 800 }
      })
    );
    const ms = performance.now() - t0;
    const mounted = (html.match(/role="gridcell"/g) ?? []).length;
    const rows = (html.match(/role="row"/g) ?? []).length;
    // eslint-disable-next-line no-console
    console.log(`render-bench: ${response.cells.length} cells → ${mounted} gridcells mounted in ${rows} rows · ${ms.toFixed(0)} ms · html ${(html.length / 1024).toFixed(0)} KB`);
    assert.ok(mounted > 0, "should mount cells");
    assert.ok(mounted < 3000, `virtual window too large: ${mounted}`);
    assert.ok(ms < 1500, `render too slow: ${ms.toFixed(0)} ms`);
    assert.match(html, /aria-label="Tarifas de Bench"/);
    assert.match(html, /sin tarifa|€/);
  });
});
