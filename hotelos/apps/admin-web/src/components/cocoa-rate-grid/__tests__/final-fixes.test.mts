// Lote «fix:admin-web» (corrección final tras la verificación en navegador,
// 2026-09-15): helpers puros que sostienen cada corrección — precedencia de
// los mapeos por producto (browser-ux-final#1), colocación del popover (#2),
// acciones de una recomendación «hold» (#3), recuentos y unidades (#7),
// margen del toast sobre la barra (#9), modo del drawer con un envío en curso
// (#10), etiquetas de modo/proveedor/tipo (#11, #12) y el hash `#channel=`
// de Mapeos (#13). Sin React ni DOM.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RateGridCell, RateGridChannel, RateGridResponse } from "@hotelos/shared";
import {
  CHANNEL_MODE_LABELS,
  channelModeLabel,
  channelTypeLabel,
  placePopover,
  providerLabel,
  queuedDeliveriesSummary,
  recommendationChoices,
  snapshotBefore,
  toastOffsetForBar
} from "../helpers.ts";
import { channelsForProduct, countDraftCellsByChannel, isChannelMappedForProduct, indexProductMappings, resolveReviewDrawerMode } from "../rate-grid-utils.ts";
import { draftReducer, initialDraftStore } from "../draft-store.ts";
import { AVAILABILITY_PLAN_ID, type ChannelProductMappingLite } from "../types.ts";
import { channelIdFromHash, withChannelHash } from "../../../lib/channel-hash.ts";

function channel(id: string, mappedProducts = 4): RateGridChannel {
  return { id, providerCode: id, name: id, channelType: "ota", status: "active", mode: "sandbox", markupPercent: 0, mappedProducts, readyToPush: true };
}

function cell(ratePlanId: string, roomTypeId: string, date: string, price: number, sync?: RateGridCell["sync"]): RateGridCell {
  return { ratePlanId, roomTypeId, date, basePrice: price, effectivePrice: price, currency: "EUR", restrictions: {}, source: "manual", ...(sync ? { sync } : {}) };
}

const CHANNELS = [channel("bk"), channel("ex"), channel("cx")];

describe("final · mapeos por producto: la lista solo manda sobre los canales que cubre (browser-ux-final#1)", () => {
  // Lo que el editor infería de cell.sync tras publicar IND·3 ago: solo bk × IND.
  const partial: ChannelProductMappingLite[] = [{ channelId: "bk", roomTypeId: "ind", ratePlanId: "bar" }];
  it("un producto sin entrada de un canal cubierto queda fuera de ESE canal, no de todos", () => {
    const ids = channelsForProduct("dbl", "bar", CHANNELS, partial, null).map((c) => c.id);
    assert.deepEqual(ids, ["ex", "cx"]);
    assert.deepEqual(channelsForProduct("ind", "bar", CHANNELS, partial, null).map((c) => c.id), ["bk", "ex", "cx"]);
  });
  it("con los mapeos reales de todos los canales la lista es autoritativa", () => {
    const full: ChannelProductMappingLite[] = [];
    for (const ch of ["bk", "ex", "cx"]) for (const rt of ["ind", "dbl"]) full.push({ channelId: ch, roomTypeId: rt, ratePlanId: "bar" });
    full.push({ channelId: "cx", roomTypeId: "sui", ratePlanId: "bar" });
    assert.deepEqual(channelsForProduct("dbl", "bar", CHANNELS, full, null).map((c) => c.id), ["bk", "ex", "cx"]);
    assert.deepEqual(channelsForProduct("sui", "bar", CHANNELS, full, null).map((c) => c.id), ["cx"]);
    assert.deepEqual(channelsForProduct("dbl", "nr", CHANNELS, full, null), []);
  });
  it("sin lista: las claves de sync suman canales pero nunca excluyen a los mapeados", () => {
    const sample = cell("bar", "dbl", "2027-08-05", 100, { bk: { status: "confirmed" } });
    const channels = [channel("bk", 0), channel("ex", 4), channel("cx", 0)];
    assert.deepEqual(channelsForProduct("dbl", "bar", channels, undefined, sample).map((c) => c.id), ["bk", "ex"]);
    assert.deepEqual(channelsForProduct("dbl", "bar", channels, [], null).map((c) => c.id), ["ex"]);
  });
  it("isChannelMappedForProduct expone la misma precedencia", () => {
    const index = indexProductMappings(partial);
    assert.equal(isChannelMappedForProduct(channel("bk"), "dbl", "bar", index, null), false);
    assert.equal(isChannelMappedForProduct(channel("ex"), "dbl", "bar", index, null), true);
    assert.equal(isChannelMappedForProduct(channel("ex", 0), "dbl", "bar", index, null), false);
  });
  it("los recuentos del drawer siguen la misma regla (celda DBL y disponibilidad)", () => {
    const cells = [cell("bar", "dbl", "2027-08-05", 100), cell("bar", "ind", "2027-08-03", 90, { bk: { status: "confirmed" } })];
    const res: RateGridResponse = { propertyId: "p", from: "2027-08-01", to: "2027-08-14", currency: "EUR", roomTypes: [], ratePlans: [], channels: CHANNELS, cells, inventory: [] } as unknown as RateGridResponse;
    let store = initialDraftStore();
    const dblKey = "bar|dbl|2027-08-05";
    store = draftReducer(store, { type: "cell", patch: { ratePlanId: "bar", roomTypeId: "dbl", date: "2027-08-05", price: 110 }, before: snapshotBefore(cells[0]), origin: "cell" } as never);
    const availKey = `${AVAILABILITY_PLAN_ID}|dbl|2027-08-05`;
    store = draftReducer(store, { type: "cell", patch: { ratePlanId: AVAILABILITY_PLAN_ID, roomTypeId: "dbl", date: "2027-08-05", available: 3 }, before: snapshotBefore(undefined), origin: "cell" } as never);
    assert.ok(store.present.patches.has(dblKey) && store.present.patches.has(availKey));
    assert.deepEqual(countDraftCellsByChannel(store.present, res, partial), { bk: 0, ex: 2, cx: 2 });
    assert.deepEqual(countDraftCellsByChannel(store.present, res, undefined), { bk: 2, ex: 2, cx: 2 });
  });
});

describe("final · placePopover: debajo, encima o recortado al viewport (browser-ux-final#2)", () => {
  const vp = { viewportWidth: 1280, viewportHeight: 800 };
  it("debajo del ancla cuando cabe", () => {
    assert.deepEqual(placePopover({ anchor: { top: 100, left: 300, width: 80, height: 40 }, width: 360, height: 330, ...vp }), { top: 146, left: 300 });
  });
  it("voltea encima cuando no cabe debajo pero sí encima", () => {
    assert.deepEqual(placePopover({ anchor: { top: 672, left: 300, width: 80, height: 40 }, width: 360, height: 330, ...vp }), { top: 336, left: 300 });
  });
  it("recorta al viewport cuando no cabe en ningún lado (modo «Rechazar · Otro» a 800 px)", () => {
    // Ancla a 400 px, popover de 469 px: debajo acabaría en 915, encima empezaría en −75.
    const pos = placePopover({ anchor: { top: 400, left: 300, width: 80, height: 46 }, width: 360, height: 469, ...vp });
    assert.deepEqual(pos, { top: 800 - 469 - 8, left: 300 });
    assert.ok(pos.top + 469 <= 800 - 8);
  });
  it("nunca por encima del margen aunque sea más alto que el viewport (el CSS lo hace desplazable)", () => {
    assert.equal(placePopover({ anchor: { top: 400, left: 300, width: 80, height: 46 }, width: 360, height: 900, ...vp }).top, 8);
  });
  it("respeta el borde derecho e izquierdo y centra sin ancla", () => {
    assert.equal(placePopover({ anchor: { top: 100, left: 1200, width: 40, height: 40 }, width: 360, height: 200, ...vp }).left, 1280 - 360 - 8);
    assert.equal(placePopover({ anchor: { top: 100, left: -20, width: 40, height: 40 }, width: 360, height: 200, ...vp }).left, 8);
    assert.deepEqual(placePopover({ anchor: null, width: 300, height: 200, ...vp }), { top: 306, left: 490 });
  });
});

describe("final · recomendación «hold»: sin «Aceptar», ajuste desde el precio actual (browser-ux-final#3)", () => {
  it("hold con suggestedPrice del motor no ofrece aceptar ese precio", () => {
    const c = recommendationChoices({ action: "hold", suggestedPrice: 111.28, currentPrice: 117.14 });
    assert.equal(c.holdLike, true);
    assert.equal(c.canAccept, false);
    assert.equal(c.canAdjust, true);
    assert.equal(c.adjustStart, 117.14);
    assert.equal(c.adjustLabel, "Fijar otro precio");
  });
  it("raise / lower conservan Aceptar y el stepper parte del sugerido", () => {
    const c = recommendationChoices({ action: "raise", suggestedPrice: 132, currentPrice: 118 });
    assert.deepEqual([c.holdLike, c.canAccept, c.canAdjust, c.adjustStart, c.adjustLabel], [false, true, true, 132, "Aceptar con ajuste"]);
  });
  it("no_data sin precio actual: solo rechazar", () => {
    const c = recommendationChoices({ action: "no_data", suggestedPrice: null, currentPrice: null });
    assert.deepEqual([c.holdLike, c.canAccept, c.canAdjust, c.adjustStart], [true, false, false, 0]);
  });
  it("una acción de cambio sin precio sugerido se trata como hold", () => {
    assert.equal(recommendationChoices({ action: "lower", suggestedPrice: null, currentPrice: 90 }).canAccept, false);
  });
});

describe("final · recuentos y unidades (browser-ux-final#7)", () => {
  it("las entregas encoladas explican que van por tipo y canal", () => {
    assert.equal(queuedDeliveriesSummary(6, 1, 3), "6 entregas encoladas (tarifas y disponibilidad) para 1 celda en 3 canales.");
    assert.equal(queuedDeliveriesSummary(3, 1, 3), "3 entregas encoladas para 1 celda en 3 canales.");
    assert.equal(queuedDeliveriesSummary(1, 1, 1), "1 entrega encolada para 1 celda en 1 canal.");
    assert.equal(queuedDeliveriesSummary(0, 2, 0), "0 entregas encoladas para 2 celdas en 0 canales.");
  });
});

describe("final · toast sobre la barra sticky (browser-ux-final#9)", () => {
  it("120 px con la barra de una fila y la diferencia cuando crece", () => {
    assert.equal(toastOffsetForBar(44), 120);
    assert.equal(toastOffsetForBar(86), 162);
    assert.equal(toastOffsetForBar(30), 120);
    assert.equal(toastOffsetForBar(Number.NaN), 120);
  });
});

describe("final · modo del drawer con un envío en curso (browser-ux-final#10)", () => {
  it("en reposo sigue a los datos", () => {
    assert.equal(resolveReviewDrawerMode({ idle: true, draftCells: 3, pendingPushCount: 1, canPush: true, startedAsPush: false }), "publish");
    assert.equal(resolveReviewDrawerMode({ idle: true, draftCells: 0, pendingPushCount: 1, canPush: true, startedAsPush: false }), "push");
    assert.equal(resolveReviewDrawerMode({ idle: true, draftCells: 0, pendingPushCount: 1, canPush: false, startedAsPush: false }), "publish");
    assert.equal(resolveReviewDrawerMode({ idle: true, draftCells: 0, pendingPushCount: 0, canPush: true, startedAsPush: false }), "publish");
  });
  it("con una publicación en curso y un pendingPush anterior NO cambia a «Enviar a canales»", () => {
    assert.equal(resolveReviewDrawerMode({ idle: false, draftCells: 0, pendingPushCount: 1, canPush: true, startedAsPush: false }), "publish");
    assert.equal(resolveReviewDrawerMode({ idle: false, draftCells: 0, pendingPushCount: 0, canPush: true, startedAsPush: true }), "push");
  });
});

describe("final · etiquetas coherentes de modo, proveedor y tipo (browser-ux-final#11/#12)", () => {
  it("cada opción del select empieza con las palabras de channelModeLabel", () => {
    for (const mode of ["stub", "sandbox", "real"] as const) {
      assert.ok(CHANNEL_MODE_LABELS[mode].toLowerCase().startsWith(channelModeLabel(mode)), `${mode}: ${CHANNEL_MODE_LABELS[mode]} vs ${channelModeLabel(mode)}`);
    }
    assert.equal(CHANNEL_MODE_LABELS.sandbox, "Modo de pruebas (sandbox del proveedor)");
  });
  it("proveedor y tipo de canal en español, sin enum crudo", () => {
    assert.equal(providerLabel("booking_com"), "Booking.com");
    assert.equal(providerLabel("AIRBNB"), "Airbnb");
    assert.equal(providerLabel("channex"), "Channex");
    assert.equal(providerLabel("new_ota"), "New ota");
    assert.equal(providerLabel(null), "");
    assert.equal(channelTypeLabel("vacation_rental"), "alquiler vacacional");
    assert.equal(channelTypeLabel("AGGREGATOR"), "agregador");
    assert.equal(channelTypeLabel("ota"), "OTA");
    assert.equal(channelTypeLabel("something_else"), "something else");
    assert.equal(channelTypeLabel(undefined), "");
  });
});

describe("final · hash #channel= de Mapeos (browser-ux-final#13)", () => {
  it("escribe, sustituye y conserva otros parámetros", () => {
    assert.equal(withChannelHash("", "cx1"), "#channel=cx1");
    assert.equal(withChannelHash("#", "cx1"), "#channel=cx1");
    assert.equal(withChannelHash("#channel=ex1", "cx1"), "#channel=cx1");
    assert.equal(withChannelHash("#tab=legacy&channel=ex1", "cx1"), "#tab=legacy&channel=cx1");
    assert.equal(withChannelHash("#tab=legacy", "cx1"), "#tab=legacy&channel=cx1");
    assert.equal(withChannelHash("#channel=ex1", ""), "#channel=ex1");
  });
  it("codifica y decodifica de ida y vuelta", () => {
    const id = "cmu1sicx2 0002/á";
    assert.equal(channelIdFromHash(withChannelHash("#x=1", id)), id);
    assert.equal(channelIdFromHash("#channel=cmu1sicx10001fyqxifqpuxvi"), "cmu1sicx10001fyqxifqpuxvi");
    assert.equal(channelIdFromHash("#tab=1"), "");
  });
});
