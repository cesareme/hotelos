// Unitarios de la forma `cells` de POST …/rate-grid/recommendations/apply
// (contrato con admin-web, 2026-09-15): validación zod estricta de
// currentPrice / suggestedPrice y la decisión pura por celda
// (`buildCellDecision`, sin BD). Se ejecutan desde apps/api con
//   node --import tsx --test src/modules/revenue/__tests__/recommendations-apply.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RateRecommendationsResponse } from "@hotelos/shared";
import { ApplyBodySchema, ApplyCellSchema, buildCellDecision, type ApplyCell, type CellDecisionInput } from "../recommendations.routes.js";
import { parseOrBadRequest } from "../demand-calendar.service.js";
import { BadRequestError } from "../../../lib/http-error.js";

type Day = RateRecommendationsResponse["days"][number];
type Rec = Day["byRoomType"][number];

const BASE_CELL = { roomTypeId: "rt_dbl", date: "2027-03-22", action: "accept" as const };

function rec(over: Partial<Rec> = {}): Rec {
  return {
    roomTypeId: "rt_dbl",
    currentPrice: 110,
    suggestedPrice: 121,
    deltaPct: 10,
    action: "raise",
    confidence: 80,
    reasons: [{ code: "forecast", label: "Previsión 93 % de ocupación", weight: 10, value: 93 }],
    missing: ["compset"],
    suggestedRestrictions: null,
    ...over
  };
}

function day(byRoomType: Rec[] = [rec()]): Day {
  return {
    date: "2027-03-22",
    daysOut: 188,
    signals: { date: "2027-03-22", otbRooms: 3, occPct: 12.5, fcOccPct: 93, fcSource: "pms_import:opera", stlyOccPct: null, stlyAdr: null, pickup7: 1, compsetMedian: 118, events: [], budgetGapPct: null },
    byRoomType
  };
}

function decide(cell: Partial<ApplyCell> & { action: ApplyCell["action"] }, over: Partial<CellDecisionInput> = {}) {
  const parsed = ApplyCellSchema.parse({ ...BASE_CELL, ...cell });
  const input: CellDecisionInput = {
    propertyId: "prop_123",
    ratePlanId: "rp_bar",
    userId: "usr_123",
    now: new Date("2026-09-15T10:00:00.000Z"),
    cell: parsed,
    rec: rec(),
    day: day(),
    sources: { otb: "reservations", forecast: "pms_forecast" },
    includeRestrictions: false,
    highRiskDeltaPct: 15,
    journalId: null,
    ...over
  };
  return buildCellDecision(input);
}

type Json = Record<string, unknown>;
function decided(d: ReturnType<typeof buildCellDecision>) {
  assert.equal(d.kind, "decided", JSON.stringify(d));
  if (d.kind !== "decided") throw new Error("unreachable");
  return { patch: d.patch, row: d.row, current: d.row.currentValueJson as Json, recommended: d.row.recommendedValueJson as Json, impact: d.row.expectedImpactJson as Json, reason: d.row.reasonJson as Json };
}

describe("ApplyCellSchema — currentPrice / suggestedPrice (contrato 3)", () => {
  it("acepta currentPrice y suggestedPrice > 0 y ≤ 50.000; suggestedPrice admite null (el motor puede no tener)", () => {
    const v = ApplyCellSchema.parse({ ...BASE_CELL, currentPrice: 100, suggestedPrice: 110, appliedPrice: 110 });
    assert.equal(v.currentPrice, 100);
    assert.equal(v.suggestedPrice, 110);
    assert.equal(ApplyCellSchema.parse({ ...BASE_CELL, suggestedPrice: null, appliedPrice: 90 }).suggestedPrice, null);
    assert.equal(ApplyCellSchema.parse({ ...BASE_CELL, currentPrice: 50_000, appliedPrice: 90 }).currentPrice, 50_000);
  });
  it("rechaza currentPrice 0, negativo, > 50.000, no numérico o null; suggestedPrice 0; claves desconocidas; adjust sin appliedPrice", () => {
    const bad = (cell: unknown) => ApplyCellSchema.safeParse(cell).success;
    assert.equal(bad({ ...BASE_CELL, currentPrice: 0 }), false);
    assert.equal(bad({ ...BASE_CELL, currentPrice: -1 }), false);
    assert.equal(bad({ ...BASE_CELL, currentPrice: 50_000.01 }), false);
    assert.equal(bad({ ...BASE_CELL, currentPrice: "100" }), false);
    assert.equal(bad({ ...BASE_CELL, currentPrice: null }), false);
    assert.equal(bad({ ...BASE_CELL, currentPrice: Number.POSITIVE_INFINITY }), false);
    assert.equal(bad({ ...BASE_CELL, suggestedPrice: 0 }), false);
    assert.equal(bad({ ...BASE_CELL, suggestedPrice: 60_000 }), false);
    assert.equal(bad({ ...BASE_CELL, shownPrice: 100 }), false);
    assert.equal(bad({ ...BASE_CELL, action: "adjust" }), false);
    assert.equal(bad({ ...BASE_CELL, action: "adjust", appliedPrice: 0 }), true); // el grid admite 0 como precio
  });
  it("los 400 salen en español con la ruta del campo (parseOrBadRequest + zodErrorMapEs)", () => {
    assert.throws(
      () => parseOrBadRequest(ApplyBodySchema, { from: "2027-03-20", to: "2027-03-27", ratePlanId: "rp", cells: [{ ...BASE_CELL, currentPrice: 0 }] }),
      (e: unknown) => {
        assert.ok(e instanceof BadRequestError);
        assert.equal(e.message, "cuerpo inválido: cells.0.currentPrice: debe ser mayor que 0");
        return true;
      }
    );
    assert.throws(
      () => parseOrBadRequest(ApplyBodySchema, { from: "2027-03-20", to: "2027-03-27", ratePlanId: "rp", cells: [{ ...BASE_CELL, suggestedPrice: 60_000 }] }),
      (e: unknown) => {
        assert.ok(e instanceof BadRequestError);
        assert.equal(e.message, "cuerpo inválido: cells.0.suggestedPrice: debe ser menor o igual que 50000");
        return true;
      }
    );
    assert.throws(
      () => parseOrBadRequest(ApplyBodySchema, { from: "2027-03-20", to: "2027-03-27", ratePlanId: "rp", cells: [{ ...BASE_CELL, appliedPrice: 90, extra: 1 }] }),
      (e: unknown) => {
        assert.ok(e instanceof BadRequestError);
        assert.equal(e.message, "cuerpo inválido: cells.0: clave no admitida: 'extra'");
        return true;
      }
    );
  });
  it("ApplyBodySchema: journalId opcional/nullable; cells excluyente con dates/roomTypeIds", () => {
    const base = { from: "2027-03-20", to: "2027-03-27", ratePlanId: "rp" };
    assert.equal(ApplyBodySchema.parse({ ...base, journalId: "jrn_1", cells: [{ ...BASE_CELL, appliedPrice: 90 }] }).journalId, "jrn_1");
    assert.equal(ApplyBodySchema.parse({ ...base, journalId: null }).journalId, null);
    assert.equal(ApplyBodySchema.safeParse({ ...base, journalId: "" }).success, false);
    assert.equal(ApplyBodySchema.safeParse({ ...base, dates: ["2027-03-21"], cells: [{ ...BASE_CELL, appliedPrice: 90 }] }).success, false);
    assert.equal(ApplyBodySchema.safeParse({ ...base, roomTypeIds: ["rt_dbl"], cells: [{ ...BASE_CELL, appliedPrice: 90 }] }).success, false);
  });
});

describe("buildCellDecision — precios que vio el usuario frente al recálculo del motor", () => {
  it("accept tras el bulk-update: currentValueJson.price = currentPrice del cliente, enginePrice = lo que ve el motor; shownPrice = suggestedPrice enviado; price = recálculo del motor", () => {
    // El motor ya ve el precio nuevo (110) y recalcula otra sugerencia (121); el usuario vio 100 → 110.
    const { patch, row, current, recommended, impact, reason } = decided(decide({ action: "accept", currentPrice: 100, suggestedPrice: 110, appliedPrice: 110 }, { journalId: "jrn_bulk" }));
    assert.equal(current.price, 100);
    assert.equal(current.enginePrice, 110);
    assert.equal(current.priceSource, "client");
    assert.equal(current.barSource, "rate_grid");
    assert.equal(current.occupancyPct, 12.5);
    assert.equal(recommended.price, 121);
    assert.equal(recommended.shownPrice, 110);
    assert.equal(recommended.appliedPrice, 110);
    assert.equal(recommended.decision, "accept");
    assert.equal(recommended.action, "raise");
    // Δ sobre el baseline que vio el usuario (100 → 110), no sobre el 110 del motor.
    assert.deepEqual(impact, { direction: "up", deltaPct: 10 });
    assert.equal(reason.journalId, "jrn_bulk");
    assert.equal(row.status, "applied");
    assert.equal(row.approvedBy, "usr_123");
    assert.ok(row.appliedAt instanceof Date);
    assert.equal(row.rejectedBy, undefined);
    assert.deepEqual(patch, { ratePlanId: "rp_bar", roomTypeId: "rt_dbl", date: "2027-03-22", price: 110, expected: { price: 100 } });
  });
  it("sin currentPrice ni suggestedPrice: baseline y sugerencia del motor (compatibilidad con el cuerpo antiguo), sin `expected` en el parche", () => {
    const { patch, current, recommended, impact } = decided(decide({ action: "accept", appliedPrice: 121 }));
    assert.equal(current.price, 110);
    assert.equal(current.enginePrice, 110);
    assert.equal(current.priceSource, "engine");
    assert.equal(recommended.price, 121);
    assert.equal(recommended.shownPrice, null);
    assert.equal(recommended.appliedPrice, 121);
    assert.deepEqual(impact, { direction: "up", deltaPct: 10 });
    assert.equal(patch?.expected, undefined);
  });
  it("accept sin appliedPrice publica lo que el usuario vio (suggestedPrice) antes que el recálculo del motor; sin nada, el del motor", () => {
    const shown = decided(decide({ action: "accept", suggestedPrice: 115 }));
    assert.equal(shown.patch?.price, 115);
    assert.equal(shown.recommended.appliedPrice, 115);
    assert.equal(shown.recommended.price, 121);
    const engine = decided(decide({ action: "accept" }));
    assert.equal(engine.patch?.price, 121);
  });
  it("motor sin sugerencia (no_data) → la del cliente vale como price; sin ninguna y sin appliedPrice → skipped", () => {
    const noData = rec({ currentPrice: null, suggestedPrice: null, deltaPct: null, action: "no_data" });
    const ok = decided(decide({ action: "accept", currentPrice: 90, suggestedPrice: 95 }, { rec: noData }));
    assert.equal(ok.recommended.price, 95);
    assert.equal(ok.patch?.price, 95);
    assert.equal(ok.current.price, 90);
    assert.equal(ok.current.enginePrice, null);
    assert.deepEqual(ok.impact, { direction: "up", deltaPct: 5.56 });
    const skipped = decide({ action: "accept" }, { rec: noData });
    assert.deepEqual(skipped, { kind: "skipped", reason: "sin precio sugerido ni appliedPrice" });
  });
  it("adjust: appliedPrice manda; Δ y riesgo se miden contra el baseline del cliente", () => {
    const { patch, recommended, impact, row } = decided(decide({ action: "adjust", currentPrice: 100, suggestedPrice: 110, appliedPrice: 130 }));
    assert.equal(patch?.price, 130);
    assert.equal(recommended.appliedPrice, 130);
    assert.equal(recommended.shownPrice, 110);
    assert.deepEqual(impact, { direction: "up", deltaPct: 30 });
    assert.equal(row.riskLevel, "high"); // 30 % > highRiskDeltaPct 15
    assert.equal(decided(decide({ action: "adjust", currentPrice: 100, appliedPrice: 105 })).row.riskLevel, "medium");
  });
  it("reject: sin parche, fila rejected con rejectedBy, appliedPrice null y Δ de la sugerencia mostrada sobre el baseline", () => {
    const { patch, row, recommended, impact, reason } = decided(decide({ action: "reject", currentPrice: 100, suggestedPrice: 90, reason: "  evento cancelado " }));
    assert.equal(patch, null);
    assert.equal(row.status, "rejected");
    assert.equal(row.rejectedBy, "usr_123");
    assert.equal(row.approvedBy, undefined);
    assert.equal(row.appliedAt, undefined);
    assert.equal(recommended.appliedPrice, null);
    assert.equal(recommended.shownPrice, 90);
    assert.equal(recommended.decision, "reject");
    assert.deepEqual(impact, { direction: "down", deltaPct: -10 });
    assert.equal(reason.userReason, "evento cancelado");
    // reject sin baseline ni sugerencia del cliente → Δ del motor.
    assert.deepEqual(decided(decide({ action: "reject" })).impact, { direction: "up", deltaPct: 10 });
  });
  it("includeRestrictions copia las restricciones sugeridas al parche y a la fila; sin flag no viajan", () => {
    const withRestr = rec({ suggestedRestrictions: { minLos: 2, cta: true } });
    const on = decided(decide({ action: "accept", appliedPrice: 121 }, { rec: withRestr, includeRestrictions: true }));
    assert.deepEqual(on.patch?.restrictions, { minLos: 2, cta: true });
    assert.deepEqual(on.recommended.restrictions, { minLos: 2, cta: true });
    const off = decided(decide({ action: "accept", appliedPrice: 121 }, { rec: withRestr }));
    assert.equal(off.patch?.restrictions, undefined);
    assert.equal(off.recommended.restrictions, null);
    // Un reject nunca lleva restricciones aunque se pidan.
    const rej = decided(decide({ action: "reject" }, { rec: withRestr, includeRestrictions: true }));
    assert.equal(rej.recommended.restrictions, null);
  });
  it("precios se redondean a 2 decimales en parche y fila; reasonJson conserva reasons/missing/sources del motor", () => {
    const { patch, recommended, reason } = decided(decide({ action: "adjust", currentPrice: 100, appliedPrice: 123.456 }));
    assert.equal(patch?.price, 123.46);
    assert.equal(recommended.appliedPrice, 123.46);
    assert.deepEqual(reason.missing, ["compset"]);
    assert.deepEqual(reason.sources, { otb: "reservations", forecast: "pms_forecast" });
    assert.equal((reason.reasons as unknown[]).length, 1);
    assert.equal(reason.journalId, null);
  });
});
