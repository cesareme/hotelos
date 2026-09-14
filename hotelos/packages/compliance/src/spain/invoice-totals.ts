// Invoice totals and VeriFactu tax breakdown (Tanda 3 · contract B).
//
// Folio and invoice lines carry GROSS amounts (tax included). The only way the
// invoice header (CuotaTotal / ImporteTotal, which enter the huella), the
// RegistroAlta <Desglose>, the PDF and the UI can agree to the cent is to
// derive all of them from ONE grouping: lines are grouped by (Impuesto,
// CalificacionOperacion, TipoImpositivo), the base of the group is
// round2(Σ total / (1 + t)) and its quota round2(Σ total − base). Rounding per
// group (not per line) is what AEAT validates: CuotaTotal must equal the sum
// of the CuotaRepercutida of the groups. The result is persisted in
// Invoice.taxBreakdownJson and is the single source for XML / PDF / UI.
//
// The type aliases below mirror the ones exported by ./indirect-tax.ts
// (contract A: TaxFigure, VerifactuImpuesto, Calificacion). They are kept
// local and NOT exported so this module has no import dependency and the
// package's `export *` never re-exports the same name twice.

type TaxFigure = "IVA" | "IGIC" | "IPSI";
type VerifactuImpuesto = "01" | "02" | "03";
type Calificacion = "S1" | "N1";

export type TaxBreakdownGroup = {
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  calificacion: Calificacion;
  /** TipoImpositivo of the group; always 0 for N1 (not subject: no rate, no quota). */
  ratePercent: number;
  /** BaseImponibleOimporteNoSujeto: taxable base for S1, the gross amount for N1. */
  base: number;
  /** CuotaRepercutida: 0 for N1. */
  quota: number;
};

export type InvoiceTotalsLine = {
  /** Gross line amount (tax included). May be negative on rectificativas. */
  total: number;
  ratePercent: number;
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  calificacion: Calificacion;
};

export type InvoiceTotals = {
  /** ImporteTotal: round2(Σ line totals). */
  total: number;
  /** CuotaTotal: Σ group quotas (equal by construction to the breakdown). */
  taxTotal: number;
  breakdown: TaxBreakdownGroup[];
};

/**
 * Half-away-from-zero rounding to cents. Symmetric so a full reversal
 * (every line negated) produces exactly −original per group, and with a tiny
 * epsilon so binary noise (1.005 → 1.00499…) does not flip a half cent.
 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`roundMoney: not a finite number (${value})`);
  const sign = value < 0 ? -1 : 1;
  const cents = Math.round((Math.abs(value) + Number.EPSILON) * 100);
  const rounded = (sign * cents) / 100;
  // Normalise -0 so JSON / equality checks never see a negative zero.
  return rounded === 0 ? 0 : rounded;
}

const CALIFICACION_ORDER: Record<Calificacion, number> = { S1: 0, N1: 1 };

function groupKey(line: InvoiceTotalsLine, ratePercent: number): string {
  return `${line.impuesto}::${line.calificacion}::${ratePercent}`;
}

/**
 * Totals and tax breakdown of a set of gross lines (contract B).
 *
 * - Groups by (impuesto, calificacion, ratePercent). Figure is implied by the
 *   impuesto (one figure per impuesto), so it never splits a group.
 * - S1: base = round2(Σ total / (1 + t)), quota = round2(Σ total − base).
 *   Per-group rounding, never per line.
 * - N1 (not subject): base = round2(Σ total), quota 0, ratePercent 0.
 * - S1 with rate 0 (legacy / misconfigured lines): base = Σ total, quota 0.
 *   Such lines are what taxReadinessForInvoice blocks; the arithmetic here
 *   still has to be well defined for drafts and sandbox issuance.
 * - taxTotal = Σ quotas (equal by construction to the breakdown), total =
 *   round2(Σ line totals).
 *
 * Deterministic output order: impuesto, then S1 before N1, then rate desc.
 * Pure; no I/O.
 */
export function computeInvoiceTotals(lines: readonly InvoiceTotalsLine[]): InvoiceTotals {
  const groups = new Map<string, { line: InvoiceTotalsLine; ratePercent: number; sum: number }>();
  let total = 0;
  for (const line of lines) {
    if (!Number.isFinite(line.total)) throw new Error(`computeInvoiceTotals: line total is not a finite number (${line.total})`);
    if (!Number.isFinite(line.ratePercent) || line.ratePercent < 0) {
      throw new Error(`computeInvoiceTotals: invalid ratePercent (${line.ratePercent})`);
    }
    const ratePercent = line.calificacion === "N1" ? 0 : line.ratePercent;
    const key = groupKey(line, ratePercent);
    const group = groups.get(key);
    if (group) group.sum += line.total;
    else groups.set(key, { line, ratePercent, sum: line.total });
    total += line.total;
  }

  const breakdown: TaxBreakdownGroup[] = [];
  let taxTotal = 0;
  for (const group of groups.values()) {
    const gross = roundMoney(group.sum);
    const subject = group.line.calificacion === "S1" && group.ratePercent > 0;
    const base = subject ? roundMoney(group.sum / (1 + group.ratePercent / 100)) : gross;
    const quota = subject ? roundMoney(group.sum - base) : 0;
    taxTotal += quota;
    breakdown.push({
      figure: group.line.figure,
      impuesto: group.line.impuesto,
      calificacion: group.line.calificacion,
      ratePercent: group.ratePercent,
      base,
      quota
    });
  }
  breakdown.sort(
    (a, b) =>
      a.impuesto.localeCompare(b.impuesto) ||
      CALIFICACION_ORDER[a.calificacion] - CALIFICACION_ORDER[b.calificacion] ||
      b.ratePercent - a.ratePercent
  );

  return { total: roundMoney(total), taxTotal: roundMoney(taxTotal), breakdown };
}

const FIGURES: readonly string[] = ["IVA", "IGIC", "IPSI"];
const IMPUESTOS: readonly string[] = ["01", "02", "03"];
const CALIFICACIONES: readonly string[] = ["S1", "N1"];

/**
 * Re-hydrate a breakdown persisted in Invoice.taxBreakdownJson. Anything that
 * is not a well-formed group array yields [] (legacy invoices issued before
 * Tanda 3 have no breakdown; callers fall back to per-line aggregation or
 * show "—"). Never throws on malformed JSON: the invoice must still render.
 */
export function parseTaxBreakdown(value: unknown): TaxBreakdownGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: TaxBreakdownGroup[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    if (
      typeof g.figure !== "string" || !FIGURES.includes(g.figure) ||
      typeof g.impuesto !== "string" || !IMPUESTOS.includes(g.impuesto) ||
      typeof g.calificacion !== "string" || !CALIFICACIONES.includes(g.calificacion) ||
      typeof g.ratePercent !== "number" || typeof g.base !== "number" || typeof g.quota !== "number"
    ) {
      continue;
    }
    groups.push({
      figure: g.figure as TaxFigure,
      impuesto: g.impuesto as VerifactuImpuesto,
      calificacion: g.calificacion as Calificacion,
      ratePercent: g.ratePercent,
      base: g.base,
      quota: g.quota
    });
  }
  return groups;
}
