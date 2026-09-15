import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeExpression, evaluateInput, expressionToPriceOp, parseExpression } from "../expressions.ts";

describe("expressions · parseExpression", () => {
  it("parses a plain number with comma or point", () => {
    assert.deepEqual(parseExpression("132"), { ok: true, expression: { kind: "set", value: 132 } });
    assert.deepEqual(parseExpression("132,50"), { ok: true, expression: { kind: "set", value: 132.5 } });
    assert.deepEqual(parseExpression(" 99.9 "), { ok: true, expression: { kind: "set", value: 99.9 } });
  });

  it("parses signed percent and amount (with optional € / unicode minus)", () => {
    assert.deepEqual(parseExpression("+10%"), { ok: true, expression: { kind: "percent", value: 10 } });
    assert.deepEqual(parseExpression("-5"), { ok: true, expression: { kind: "amount", value: -5 } });
    assert.deepEqual(parseExpression("−5 €"), { ok: true, expression: { kind: "amount", value: -5 } });
    assert.deepEqual(parseExpression("+ 12,5 %"), { ok: true, expression: { kind: "percent", value: 12.5 } });
  });

  it("parses BAR-relative expressions", () => {
    assert.deepEqual(parseExpression("=BAR"), { ok: true, expression: { kind: "bar", mode: "none", value: 0 } });
    assert.deepEqual(parseExpression("=BAR-10%"), { ok: true, expression: { kind: "bar", mode: "percent", value: -10 } });
    assert.deepEqual(parseExpression("=bar + 5"), { ok: true, expression: { kind: "bar", mode: "amount", value: 5 } });
  });

  it("rejects garbage and negatives with a Spanish message", () => {
    const r = parseExpression("abc");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Escribe 132/);
    assert.equal(parseExpression("").ok, false);
    assert.equal(parseExpression("=BAR*2").ok, false);
  });
});

describe("expressions · evaluateInput", () => {
  it("evaluates relative to the current price", () => {
    assert.deepEqual(evaluateInput("+10%", { current: 120 }), { ok: true, value: 132 });
    assert.deepEqual(evaluateInput("-5", { current: 120 }), { ok: true, value: 115 });
    assert.deepEqual(evaluateInput("132", { current: null }), { ok: true, value: 132 });
  });

  it("refuses relative expressions on a cell without price", () => {
    const r = evaluateInput("+10%", { current: null });
    assert.equal(r.ok, false);
  });

  it("evaluates BAR expressions only when BAR exists", () => {
    assert.deepEqual(evaluateInput("=BAR-10%", { current: 100, bar: 120, hasBar: true }), { ok: true, value: 108 });
    assert.deepEqual(evaluateInput("=BAR", { current: 100, bar: 120.456, hasBar: true }), { ok: true, value: 120.46 });
    const noBar = evaluateInput("=BAR-10%", { current: 100, hasBar: false });
    assert.equal(noBar.ok, false);
    if (!noBar.ok) assert.match(noBar.error, /No hay un plan BAR/);
  });

  it("never produces a negative price", () => {
    assert.deepEqual(evaluateInput("-500", { current: 120 }), { ok: true, value: 0 });
  });
});

describe("expressions · contract mapping", () => {
  it("maps set/percent/amount to RateGridPriceOp and BAR to null", () => {
    const p = parseExpression("+10%");
    assert.ok(p.ok);
    if (p.ok) assert.deepEqual(expressionToPriceOp(p.expression), { mode: "percent", value: 10 });
    const b = parseExpression("=BAR-10%");
    assert.ok(b.ok);
    if (b.ok) assert.equal(expressionToPriceOp(b.expression), null);
  });

  it("describes expressions in Spanish", () => {
    assert.equal(describeExpression({ kind: "percent", value: 10 }), "Subir 10 %");
    assert.equal(describeExpression({ kind: "amount", value: -5 }), "Bajar 5 €");
    assert.equal(describeExpression({ kind: "set", value: 132 }), "Fijar 132 €");
    assert.equal(describeExpression({ kind: "bar", mode: "percent", value: -10 }), "BAR −10 %");
  });
});
