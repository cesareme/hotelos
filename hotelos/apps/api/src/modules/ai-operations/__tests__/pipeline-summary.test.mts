// Tanda L6a (lote 3): resumen puro de ai_tool_calls (summarizeToolCalls) que
// alimenta el panel del pipeline: completed cuenta como éxito, pending como
// espera, y hasRealCost solo con model y cost_eur no nulos. Sin base de datos.
// From apps/api:
//   node --import tsx --test src/modules/ai-operations/__tests__/pipeline-summary.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monthStartUtc, summarizeToolCalls, type ToolCallStatus } from "../pipeline.service.js";

const STATUSES: ToolCallStatus[] = ["succeeded", "failed", "pending", "awaiting_confirmation", "rejected", "completed", "skipped"];

describe("summarizeToolCalls · vocabulario de 7 estados", () => {
  it("completed y succeeded cuentan como éxito; pending y awaiting_confirmation como espera; failed/rejected/skipped aparte", () => {
    const summary = summarizeToolCalls(STATUSES.map((status) => ({ status })));
    assert.equal(summary.total, 7);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.awaiting, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.rejected, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.successRatePct, 28.6);
    assert.equal(summary.hasRealCost, false);
    assert.equal(summary.costEur, 0);
    assert.equal(summary.tokens, 0);
  });

  it("las dos filas legadas de messaging (completed, sin modelo ni coste) son éxito sin coste real", () => {
    const summary = summarizeToolCalls([
      { status: "completed", model: null, costEur: null },
      { status: "completed", model: null, costEur: null }
    ]);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.successRatePct, 100);
    assert.equal(summary.hasRealCost, false, "sin modelo ni coste no hay coste real");
    assert.equal(summary.costEur, 0);
  });

  it("hasRealCost exige alguna fila con model no nulo y cost_eur no nulo; los ceros de semilla sin modelo no cuentan", () => {
    assert.equal(summarizeToolCalls([{ status: "succeeded", model: null, costEur: 0.5 }]).hasRealCost, false);
    assert.equal(summarizeToolCalls([{ status: "succeeded", model: "claude-sonnet-5", costEur: null }]).hasRealCost, false);
    assert.equal(summarizeToolCalls([{ status: "failed", model: "claude-sonnet-5", costEur: 0.0004 }]).hasRealCost, true);
    const withZero = summarizeToolCalls([{ status: "skipped", model: null, costEur: 0 }, { status: "succeeded", model: "claude-haiku-4-5-20251001", costEur: 0.0002 }]);
    assert.equal(withZero.hasRealCost, true);
    assert.equal(withZero.costEur, 0);
  });

  it("suma coste (redondeado a 2 decimales) y tokens, y ordena byStatus de mayor a menor", () => {
    const summary = summarizeToolCalls([
      { status: "succeeded", model: "claude-sonnet-5", costEur: 0.126, tokensInput: 100, tokensOutput: 20 },
      { status: "succeeded", model: "claude-sonnet-5", costEur: 0.13, tokensInput: 50, tokensOutput: null },
      { status: "awaiting_confirmation", model: null, costEur: null, tokensInput: null, tokensOutput: null },
      { status: "pending" }
    ]);
    assert.equal(summary.costEur, 0.26);
    assert.equal(summary.tokens, 170);
    assert.deepEqual(summary.byStatus, [
      { status: "succeeded", count: 2 },
      { status: "awaiting_confirmation", count: 1 },
      { status: "pending", count: 1 }
    ]);
  });

  it("conjunto vacío → todo a cero sin NaN", () => {
    const summary = summarizeToolCalls([]);
    assert.deepEqual(summary, { total: 0, succeeded: 0, awaiting: 0, failed: 0, rejected: 0, skipped: 0, successRatePct: 0, costEur: 0, tokens: 0, hasRealCost: false, byStatus: [] });
  });
});

describe("monthStartUtc · mes natural UTC del presupuesto", () => {
  it("devuelve el primer instante del mes en UTC", () => {
    assert.equal(monthStartUtc(new Date("2026-09-18T23:59:59.000Z")).toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(monthStartUtc(new Date("2026-01-01T00:00:00.000Z")).toISOString(), "2026-01-01T00:00:00.000Z");
  });
});
