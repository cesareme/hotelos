// Rate grid v2 · derived rate plans (pure, no I/O).
//
// A derived plan (BAR-NR = BAR −10 %) stores its rule in `RatePlan.derivationJson`
// with the shape `{ mode: "none" | "percent" | "amount", value, roundTo? }`.
// Derived prices are MATERIALISED on write (the child's RateDay rows exist with
// `source: "derived"`), so the maths lives here and is shared by the bulk-update
// engine, the rederive endpoint and the rate-plan validation.

import { z } from "zod";
import type { RatePlanDerivation } from "@hotelos/shared";

/** Rounding modes accepted on the wire: 0 = integer, 1 = one decimal, 2 = cents, 0.99 = psychological. */
export const derivationSchema = z
  .object({
    mode: z.enum(["none", "percent", "amount"]),
    value: z.number().finite(),
    roundTo: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(0.99)]).optional()
  })
  .strict()
  .superRefine((d, ctx) => {
    // −100 % (or below) yields 0 € for every parent price: a rule that can only
    // publish a fake 0 is rejected at configuration time (the engine also
    // refuses to materialise ≤ 0 €, but the earlier the better).
    if (d.mode === "percent" && d.value <= -100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value debe ser mayor que -100: un descuento del 100 % o más produce siempre 0 €", path: ["value"] });
    }
    if (d.mode === "percent" && d.value > 1000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value no puede superar 1000 (%)", path: ["value"] });
    }
  });

/**
 * Why a derivation would produce ≤ 0 € for the parent's lowest price, or null
 * when it is safe. `parentMinPrice` is the minimum RateDay price of the
 * parent over its future window (null when the parent has no rates yet).
 */
export function derivationFloorIssue(derivation: RatePlanDerivation, parentMinPrice: number | null): string | null {
  if (derivation.mode === "percent" && derivation.value <= -100) return "un descuento del 100 % o más produce siempre 0 €";
  if (parentMinPrice === null) return null;
  if (applyDerivation(parentMinPrice, derivation) <= 0) {
    const rule = derivation.mode === "amount" ? `${derivation.value} €` : `${derivation.value} %`;
    return `la regla (${rule}) produce 0 € sobre la tarifa mínima actual del plan padre (${parentMinPrice} €): revisa el valor`;
  }
  return null;
}

export const NO_DERIVATION: RatePlanDerivation = { mode: "none", value: 0 };

/** Money rounding to cents with the half-up rule (avoids 1.005 → 1 float artefacts). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Lenient reader for the persisted JSON: legacy plans carry `{}` (or garbage),
 * which is "no derivation" — never throws so a bad row cannot break the grid.
 * Writes go through `derivationSchema` (strict) instead.
 */
export function parseDerivation(raw: unknown): RatePlanDerivation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...NO_DERIVATION };
  const r = raw as Record<string, unknown>;
  const mode = r.mode ?? r.type;
  if (mode !== "percent" && mode !== "amount" && mode !== "none") return { ...NO_DERIVATION };
  const value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : 0;
  const roundTo = r.roundTo === 0 || r.roundTo === 1 || r.roundTo === 2 || r.roundTo === 0.99 ? r.roundTo : undefined;
  return roundTo === undefined ? { mode, value } : { mode, value, roundTo };
}

/**
 * Round a (non-negative) price with the derivation's `roundTo`:
 *   undefined / 2 → cents · 0 → integer · 1 → one decimal ·
 *   0.99 → nearest integer minus one cent (89.6 → 89.99, 89.4 → 88.99); a
 *   price that rounds to 0 stays 0 (never −0.01).
 */
export function roundPrice(value: number, roundTo: RatePlanDerivation["roundTo"]): number {
  if (roundTo === 0) return Math.round(value + Number.EPSILON);
  if (roundTo === 1) return Math.round((value + Number.EPSILON) * 10) / 10;
  if (roundTo === 0.99) {
    const whole = Math.round(value + Number.EPSILON);
    return whole <= 0 ? 0 : round2(whole - 0.01);
  }
  return round2(value);
}

/**
 * Derived price from the parent's base price. The result is clamped at 0 (an
 * amount larger than the base cannot produce a negative rate) and rounded with
 * the plan's `roundTo`. `mode: "none"` copies the parent (rounded to cents).
 */
export function applyDerivation(base: number, derivation: RatePlanDerivation): number {
  if (!Number.isFinite(base)) throw new TypeError("applyDerivation: base must be a finite number");
  let derived: number;
  switch (derivation.mode) {
    case "percent":
      derived = base * (1 + derivation.value / 100);
      break;
    case "amount":
      derived = base + derivation.value;
      break;
    case "none":
    default:
      derived = base;
  }
  if (derived < 0) derived = 0;
  return roundPrice(derived, derivation.roundTo);
}

/** True when the plan actually derives its prices (has a parent — mode "none" still copies the parent). */
export function isDerivedPlan(plan: { parentRatePlanId: string | null; ratePlanType?: string | null }): boolean {
  return Boolean(plan.parentRatePlanId);
}
