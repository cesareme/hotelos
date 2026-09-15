// Lote «fix:admin-web» (auditoría UX del editor de tarifas, 2026-09-15):
// helpers puros que sostienen las correcciones (etiquetas en español, filtro
// de canales inactivos, estado vacío de recomendaciones, badge del historial,
// celdas guardadas sin enviar). Sin React ni DOM.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RateGridBulkUpdateRequest, RateGridCellRecommendation } from "@hotelos/shared";
import {
  RESTRICTION_LABELS,
  activeGridChannels,
  channelModeLabel,
  deliveryStatusLabel,
  describeSync,
  journalStatusLabel,
  markupLabel,
  mealPlanLabel,
  restrictionChips,
  summarizeRecommendations
} from "../helpers.ts";
import { mergePendingPush, pendingPushFromRequest } from "../rate-grid-utils.ts";
import type { PendingPush } from "../types.ts";

describe("ux · vocabulario en español (browser-ux#9)", () => {
  it("traduce el meal plan crudo de la cabecera de fila", () => {
    assert.equal(mealPlanLabel("room_only"), "Solo alojamiento");
    assert.equal(mealPlanLabel("breakfast"), "Con desayuno");
    assert.equal(mealPlanLabel("BED_AND_BREAKFAST"), "Con desayuno");
    assert.equal(mealPlanLabel("half_board"), "Media pensión");
    assert.equal(mealPlanLabel("dinner_included"), "Dinner included");
    assert.equal(mealPlanLabel(null), null);
    assert.equal(mealPlanLabel(""), null);
  });
  it("nombra los modos de canal sin jerga (stub/sandbox)", () => {
    assert.equal(channelModeLabel("stub"), "simulado");
    assert.equal(channelModeLabel("sandbox"), "modo de pruebas");
    assert.equal(channelModeLabel("real"), "real");
    assert.equal(channelModeLabel(undefined), "");
  });
  it("habla de recargo, no de markup", () => {
    assert.equal(markupLabel(0), "sin recargo");
    assert.equal(markupLabel(null), "sin recargo");
    assert.equal(markupLabel(12), "+12 % de recargo");
    assert.equal(markupLabel(-5), "−5 % de recargo");
  });
  it("«Stop sell» pasa a «Cierre de venta» en etiquetas y chips", () => {
    assert.equal(RESTRICTION_LABELS.stopSell, "Cierre de venta");
    const chip = restrictionChips({ stopSell: true }).find((c) => c.key === "stopSell");
    assert.ok(chip);
    assert.equal(chip.text, "STOP");
    assert.equal(chip.label, "Cierre de venta");
  });
  it("estados de entrega en español para el log del hub", () => {
    assert.equal(deliveryStatusLabel("queued"), "en cola");
    assert.equal(deliveryStatusLabel("timeout"), "sin respuesta");
    assert.equal(deliveryStatusLabel("superseded"), "sustituida");
    assert.equal(deliveryStatusLabel("whatever"), "whatever");
    assert.equal(deliveryStatusLabel(null), "—");
  });
});

describe("ux · canales inactivos fuera de los selectores (browser-ux#12)", () => {
  it("quita inactive/paused/disabled y conserva active y error", () => {
    const rows = [
      { id: "a", status: "active" },
      { id: "b", status: "inactive" },
      { id: "c", status: "error" },
      { id: "d", status: "paused" },
      { id: "e", status: "Disabled" }
    ];
    assert.deepEqual(
      activeGridChannels(rows).map((c) => c.id),
      ["a", "c"]
    );
  });
});

describe("ux · estado vacío de la capa de recomendaciones (browser-ux#5)", () => {
  const rec = (action: RateGridCellRecommendation["action"], confidence: number, missing: string[] = [], suggestedPrice: number | null = 100): RateGridCellRecommendation => ({
    currentPrice: 90,
    suggestedPrice,
    deltaPct: suggestedPrice === null ? null : 11,
    action,
    confidence,
    reasons: [],
    missing
  });
  it("cuenta hold/no_data como no accionables y ordena las señales ausentes por frecuencia", () => {
    const summary = summarizeRecommendations([
      rec("hold", 20, ["forecast", "otb_empty", "compset"]),
      rec("hold", 20, ["forecast", "otb_empty"]),
      rec("no_data", 0, ["forecast"], null),
      null,
      undefined
    ]);
    assert.equal(summary.total, 3);
    assert.equal(summary.actionable, 0);
    assert.equal(summary.hold, 2);
    assert.equal(summary.noData, 1);
    assert.equal(summary.avgConfidence, 13);
    assert.deepEqual(summary.missing, ["sin previsión", "sin reservas en libros", "sin datos de compset"]);
  });
  it("una subida/bajada con precio sugerido sí es accionable; sin precio no", () => {
    const summary = summarizeRecommendations([rec("raise", 80), rec("lower", 75), rec("raise", 60, [], null)]);
    assert.equal(summary.actionable, 2);
    assert.equal(summary.hold, 1);
    assert.equal(summary.avgConfidence, 72);
    assert.deepEqual(summary.missing, []);
  });
  it("vacío → sin confianza media", () => {
    assert.deepEqual(summarizeRecommendations([]), { total: 0, actionable: 0, hold: 0, noData: 0, avgConfidence: null, missing: [] });
  });
});

describe("ux · badge del historial (browser-ux#18)", () => {
  it("guardado sin publicar y reversión leen «guardado sin enviar a canales», nunca «borrador»", () => {
    assert.deepEqual(journalStatusLabel({ status: "draft", pushStatus: "draft" }), { label: "guardado sin enviar a canales", tone: "accent" });
    assert.deepEqual(journalStatusLabel({ status: "published", pushStatus: "draft" }), { label: "guardado sin enviar a canales", tone: "accent" });
  });
  it("publicado / parcial / fallido / revertido", () => {
    assert.equal(journalStatusLabel({ status: "published", pushStatus: "pushed" }).label, "✓ publicado");
    assert.equal(journalStatusLabel({ status: "published", pushStatus: "partial" }).tone, "warn");
    assert.equal(journalStatusLabel({ status: "published", pushStatus: "failed" }).tone, "danger");
    assert.deepEqual(journalStatusLabel({ status: "reverted", pushStatus: "pushed" }), { label: "revertido", tone: "muted" });
  });
});

describe("ux · celdas revertidas pendientes de reenvío (browser-ux#7)", () => {
  it("describeSync muestra el motivo explícito de un estado never", () => {
    assert.equal(describeSync("Booking.com", { status: "never", error: "pendiente de reenvío tras revertir" }), "Booking.com: pendiente de reenvío tras revertir");
    assert.equal(describeSync("Booking.com", { status: "never" }), "Booking.com: sin enviar");
    assert.equal(describeSync("Booking.com", null), "Booking.com: sin enviar");
  });
});

describe("ux · guardado sin enviar → pendingPush (browser-ux#1/#6)", () => {
  it("deriva el rango, planes y tipos de la petición bulk-update (celdas + ops, sin el plan «*»)", () => {
    const req: RateGridBulkUpdateRequest = {
      reason: "Corrección",
      cells: [
        { ratePlanId: "bar", roomTypeId: "dbl", date: "2027-04-03", price: 90 },
        { ratePlanId: "*", roomTypeId: "sup", date: "2027-04-01", available: 3 }
      ],
      ops: [{ id: "op1", scope: { from: "2027-04-05", to: "2027-04-07", ratePlanIds: ["nr"], roomTypeIds: ["jrs"] }, price: { mode: "percent", value: 5 } } as never]
    };
    const pending = pendingPushFromRequest(req, 4, "jrn_1", "2027-01-01T00:00:00.000Z");
    assert.ok(pending);
    assert.equal(pending.source, "save");
    assert.equal(pending.count, 4);
    assert.equal(pending.from, "2027-04-01");
    assert.equal(pending.to, "2027-04-07");
    assert.deepEqual(pending.ratePlanIds.sort(), ["bar", "nr"]);
    assert.deepEqual(pending.roomTypeIds.sort(), ["dbl", "jrs", "sup"]);
    assert.equal(pending.journalId, "jrn_1");
  });
  it("sin celdas escritas no hay nada pendiente", () => {
    assert.equal(pendingPushFromRequest({ reason: "x" }, 0, null, "2027-01-01T00:00:00.000Z"), null);
    assert.equal(pendingPushFromRequest({ reason: "x", cells: [{ ratePlanId: "bar", roomTypeId: "dbl", date: "2027-04-03", price: 90 }] }, 0, null, "2027-01-01T00:00:00.000Z"), null);
  });
  it("un segundo guardado amplía la ventana y suma celdas; el último journal gana", () => {
    const first: PendingPush = { source: "save", count: 2, from: "2027-04-03", to: "2027-04-04", ratePlanIds: ["bar"], roomTypeIds: ["dbl"], journalId: "j1", at: "2027-01-01T00:00:00.000Z" };
    const second: PendingPush = { source: "revert", count: 1, from: "2027-04-01", to: "2027-04-02", ratePlanIds: ["nr"], roomTypeIds: ["dbl", "sup"], journalId: "j2", at: "2027-01-02T00:00:00.000Z", channelIds: ["ch1"] };
    const merged = mergePendingPush(first, second);
    assert.equal(merged.count, 3);
    assert.equal(merged.from, "2027-04-01");
    assert.equal(merged.to, "2027-04-04");
    assert.deepEqual(merged.ratePlanIds.sort(), ["bar", "nr"]);
    assert.deepEqual(merged.roomTypeIds.sort(), ["dbl", "sup"]);
    assert.equal(merged.journalId, "j2");
    assert.equal(merged.source, "revert");
    assert.equal(mergePendingPush(null, second), second);
  });
});
