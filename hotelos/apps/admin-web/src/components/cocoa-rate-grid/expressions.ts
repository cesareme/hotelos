// CocoaRateGrid v2 — price expression parser (pure, tested with node:test).
//
// Inline editing and the quick-edit popover accept small expressions instead
// of a bare number, the way revenue managers type them:
//   "132" | "132,50"        → set price
//   "+10%" | "-5 %"         → percent change over the current price
//   "+5" | "-5 €" | "-5€"   → absolute change (currency symbol optional)
//   "=BAR" | "=BAR-10%" | "=BAR+5" → relative to the BAR plan of the same
//                                  room type and date (only when BAR exists)
// Decimal comma and point are both accepted. Whitespace is ignored.

import type { RateGridPriceOp } from "@hotelos/shared";

export type ParsedExpression =
  | { kind: "set"; value: number }
  | { kind: "percent"; value: number }
  | { kind: "amount"; value: number }
  | { kind: "bar"; mode: "none" | "percent" | "amount"; value: number };

export type ExpressionResult =
  | { ok: true; expression: ParsedExpression }
  | { ok: false; error: string };

export interface EvaluateContext {
  /** Current price of the cell (null when "sin tarifa"). */
  current: number | null;
  /** BAR price of the same room type and date (null/undefined when no BAR plan). */
  bar?: number | null;
  /** Whether a BAR plan exists at all (governs "=BAR…" acceptance). */
  hasBar?: boolean;
}

export type EvaluateResult = { ok: true; value: number } | { ok: false; error: string };

const NUMBER_RE = /^(\d+(?:[.,]\d{1,2})?)$/;
const SIGNED_NUMBER_RE = /^([+\-−–])\s*(\d+(?:[.,]\d{1,2})?)\s*(%|€|eur)?$/i;
const BAR_RE = /^=\s*BAR\s*(?:([+\-−–])\s*(\d+(?:[.,]\d{1,2})?)\s*(%|€|eur)?)?$/i;

function toNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

function sign(s: string): number {
  return s === "+" ? 1 : -1;
}

/** Parse without evaluating. Never throws. */
export function parseExpression(input: string): ExpressionResult {
  const text = (input ?? "").trim().replace(/\s+/g, "");
  if (text === "") return { ok: false, error: "Escribe 132, +10 % o −5 €" };

  const plain = NUMBER_RE.exec(text);
  if (plain) {
    const value = toNumber(plain[1]);
    if (!Number.isFinite(value) || value < 0) return { ok: false, error: "El precio no puede ser negativo" };
    return { ok: true, expression: { kind: "set", value } };
  }

  const signed = SIGNED_NUMBER_RE.exec(text);
  if (signed) {
    const value = sign(signed[1]) * toNumber(signed[2]);
    const unit = (signed[3] ?? "").toLowerCase();
    if (unit === "%") return { ok: true, expression: { kind: "percent", value } };
    return { ok: true, expression: { kind: "amount", value } };
  }

  const bar = BAR_RE.exec(text);
  if (bar) {
    if (!bar[1]) return { ok: true, expression: { kind: "bar", mode: "none", value: 0 } };
    const value = sign(bar[1]) * toNumber(bar[2]);
    const unit = (bar[3] ?? "").toLowerCase();
    return { ok: true, expression: { kind: "bar", mode: unit === "%" ? "percent" : "amount", value } };
  }

  return { ok: false, error: "Expresión no válida. Escribe 132, +10 % o −5 €" };
}

/** Whether the raw text looks like it is meant to be an expression (used for keyboard "type to edit"). */
export function isExpressionStartChar(ch: string): boolean {
  return /^[0-9+\-−=,.]$/.test(ch);
}

/** Apply a parsed expression to a context. Rounds to 2 decimals, never negative. */
export function evaluateExpression(expression: ParsedExpression, ctx: EvaluateContext): EvaluateResult {
  switch (expression.kind) {
    case "set":
      return { ok: true, value: round2(expression.value) };
    case "percent": {
      if (ctx.current === null || ctx.current === undefined) return { ok: false, error: "La celda no tiene tarifa: escribe un precio fijo" };
      return { ok: true, value: Math.max(0, round2(ctx.current * (1 + expression.value / 100))) };
    }
    case "amount": {
      if (ctx.current === null || ctx.current === undefined) return { ok: false, error: "La celda no tiene tarifa: escribe un precio fijo" };
      return { ok: true, value: Math.max(0, round2(ctx.current + expression.value)) };
    }
    case "bar": {
      if (ctx.hasBar === false) return { ok: false, error: "No hay un plan BAR en esta propiedad" };
      if (ctx.bar === null || ctx.bar === undefined) return { ok: false, error: "BAR no tiene tarifa ese día" };
      if (expression.mode === "none") return { ok: true, value: round2(ctx.bar) };
      if (expression.mode === "percent") return { ok: true, value: Math.max(0, round2(ctx.bar * (1 + expression.value / 100))) };
      return { ok: true, value: Math.max(0, round2(ctx.bar + expression.value)) };
    }
    default:
      return { ok: false, error: "Expresión no válida" };
  }
}

/** Parse + evaluate in one go. */
export function evaluateInput(input: string, ctx: EvaluateContext): EvaluateResult {
  const parsed = parseExpression(input);
  if (!parsed.ok) return parsed;
  return evaluateExpression(parsed.expression, ctx);
}

/**
 * Translate an expression into a contract `RateGridPriceOp` for bulk/quick
 * edits. BAR-relative expressions have no contract op (the backend does not
 * evaluate formulas) so they return null and the caller expands them per cell.
 */
export function expressionToPriceOp(expression: ParsedExpression): RateGridPriceOp | null {
  switch (expression.kind) {
    case "set":
      return { mode: "set", value: expression.value };
    case "percent":
      return { mode: "percent", value: expression.value };
    case "amount":
      return { mode: "amount", value: expression.value };
    default:
      return null;
  }
}

/** Human description used in previews: "Subir 10 %", "Bajar 5 €", "Fijar 132 €", "BAR −10 %". */
export function describeExpression(expression: ParsedExpression, currency = "€"): string {
  const fmt = (n: number) => n.toFixed(Number.isInteger(n) ? 0 : 2).replace(".", ",");
  switch (expression.kind) {
    case "set":
      return `Fijar ${fmt(expression.value)} ${currency}`;
    case "percent":
      return `${expression.value >= 0 ? "Subir" : "Bajar"} ${fmt(Math.abs(expression.value))} %`;
    case "amount":
      return `${expression.value >= 0 ? "Subir" : "Bajar"} ${fmt(Math.abs(expression.value))} ${currency}`;
    case "bar": {
      if (expression.mode === "none") return "Igual que BAR";
      const s = expression.value >= 0 ? "+" : "−";
      return `BAR ${s}${fmt(Math.abs(expression.value))} ${expression.mode === "percent" ? "%" : currency}`;
    }
    default:
      return "";
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
