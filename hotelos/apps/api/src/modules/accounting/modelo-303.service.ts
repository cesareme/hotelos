// Finanzas · lote «iva-modelos» — Modelo 303 (autoliquidación del IVA).
//
// Rewritten 2026-09-15 (hallazgos 8/41/42/43): the model no longer parses the
// rate out of journal-line descriptions nor rebuilds the base from the quota.
// It is computed from the VAT books (`VatBookEntry`, vat-books.service.ts):
//   · IVA devengado (régimen general) by rate: casillas 01/03 (4 %), 04/06
//     (10 %), 07/09 (21 %); recargo de equivalencia 16/18 (0,5 %), 19/21
//     (1,4 %), 22/24 (5,2 %); 27 = total cuota devengada;
//   · IVA deducible: 28/29 operaciones interiores corrientes, 30/31 bienes de
//     inversión, 45 = total a deducir (prorrata general applied when set);
//   · resultado: 46 = 27 − 45; 64 = 46; 65 = 100 %; 66 = 64; 77 = 0 (IVA a la
//     importación diferido); 110 = cuotas a compensar pendientes de periodos
//     anteriores; 78 = cuotas a compensar aplicadas en este periodo; 87 =
//     pendientes para periodos posteriores; 69 = 66 + 77 − 78; 70 = 0
//     (complementaria); 71 = 69 − 70 = resultado de la liquidación.
// The pending compensation (110) is read from the ledger: the balance of 4700
// (Hacienda Pública, deudora por IVA) left by the non-reversed `vat_settlement`
// entries dated before the period, so the 303 and the settlement entry always
// agree. Rates without a certain box (5 % of 2023-24, 0 % exempt / not
// subject) are reported with `casilla: null` plus an aviso, never invented.
// The ledger cross-check (`fuentes.diario`) compares the book quotas with the
// 477x / 472x journal lines of the period and lists the differences. Both
// halves of a reversed pair count, each on its own date (status `posted` or
// `reversed`): a cancelled invoice nets to zero only when its cancellation
// falls in the same period, exactly as in the books (t6#8). Left out of the
// cross-check, each exclusion named with its count in `avisos` (Tanda L3-C):
//   · the settlement entry (`vat_settlement`) and the year-end close / open
//     entries — they move VAT between accounts without accruing it;
//   · the OPERA shadow revenue entries (`pms_shadow_revenue`, Tanda 7b) — they
//     accrue 477 from the PMS daily revenue with NO book row (the invoices
//     live in the other PMS), so they can never match the books;
//   · the settlement entries imported from Sage 200 (`sage200_journal` whose
//     lines touch 4750x / 4700x together with 477x / 472x, and their
//     reversals) — the importer fills `taxRateCode` from `tipo_iva`, so the
//     rate is NOT the discriminator: the account pattern is;
//   · and their reversals (the reversed target may be dated outside the
//     period, so it is looked up by id).
// The cross-check is bounded (`LEDGER_CROSS_CHECK_MAX_ENTRIES` /
// `LEDGER_CROSS_CHECK_MAX_LINES`): a hit is reported in `avisos`. An original
// replaced by a rectificativa «S» whose `#sustituida` counter-rows are missing
// from the books (books rebuilt before Tanda L3-C) is named in `avisos` too.
// Periodicity (quarterly / monthly REDEME) comes from VatSettings; a period
// of the wrong kind is a 400 `PERIOD_MISMATCH`. Read-only: never writes.

import { Prisma } from "@prisma/client";
import { prisma } from "@hotelos/database";
import type { FiscalBox, FiscalDeclaranteBadge, FiscalLedgerCrossCheck, FiscalModelReport, FiscalPeriodDto, FiscalRegimeSummary, VatBookName, VatSettingsDto } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError } from "../../lib/http-error.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";
import {
  ZERO,
  dateColumn,
  dateColumnDay,
  declarantePair,
  differs,
  getVatSettings,
  isIsoDay,
  loadVatBookRows,
  money,
  parseFiscalPeriod,
  periodFromRange,
  regimeAvisos,
  round2,
  summarizeVatRows,
  supersededSourceId,
  toWire,
  vatRowsFromInvoice,
  INVOICE_FOR_BOOKS_SELECT,
  type InvoiceForBooks,
  type InvoiceLineForBooks,
  type Money,
  type VatBookRow
} from "./vat-books.service.js";

// ── Box map (certain numbers only) ──────────────────────────────────────────

/** Régimen general: rate → (base, tipo, cuota) boxes of the current 303 form. */
export const MODELO_303_RATE_BOXES: ReadonlyArray<{ rate: string; base: string; tipo: string; cuota: string }> = [
  { rate: "4", base: "01", tipo: "02", cuota: "03" },
  { rate: "10", base: "04", tipo: "05", cuota: "06" },
  { rate: "21", base: "07", tipo: "08", cuota: "09" }
];

/** Recargo de equivalencia: surcharge rate → (base, tipo, cuota). */
export const MODELO_303_SURCHARGE_BOXES: ReadonlyArray<{ rate: string; base: string; tipo: string; cuota: string }> = [
  { rate: "0.5", base: "16", tipo: "17", cuota: "18" },
  { rate: "1.4", base: "19", tipo: "20", cuota: "21" },
  { rate: "5.2", base: "22", tipo: "23", cuota: "24" }
];

export const MODELO_303_TITLE = "Modelo 303 · Impuesto sobre el Valor Añadido · Autoliquidación";

export const PRESENTACION_MANUAL_NOTA =
  "Presentación manual en la sede electrónica de la AEAT con el resumen por casilla (JSON/PDF). No se genera el fichero de diseño de registro oficial.";

/** sourceId of the settlement entry of a period (shared with vat-settlement.service.ts). */
export function vatSettlementSourceId(periodCode: string): string {
  return `vat-settlement:${periodCode}`;
}

const SECTION_DEVENGADO = "IVA devengado · Régimen general";
const SECTION_RECARGO = "IVA devengado · Recargo de equivalencia";
const SECTION_DEDUCIBLE = "IVA deducible";
const SECTION_RESULTADO = "Resultado";
const SECTION_INFO = "Información adicional";

function rateKey(rate: Money): string {
  // "21.00" → "21", "0.50" → "0.5"
  return rate.toFixed(2).replace(/\.?0+$/, "") || "0";
}

function box(casilla: string | null, clave: string, descripcion: string, seccion: string, importe: Money, tipo: FiscalBox["tipo"]): FiscalBox {
  return { casilla, clave, descripcion, seccion, importe: toWire(importe), tipo };
}

// ── Pure computation ────────────────────────────────────────────────────────

export type RateBucket = { rate: Money; base: Money; cuota: Money; filas: number };

export type Modelo303Computation = {
  devengado: RateBucket[];
  recargo: RateBucket[];
  noSujetas: Money;
  deducibleCorriente: { base: Money; cuota: Money; filas: number };
  deducibleInversion: { base: Money; cuota: Money; filas: number };
  noDeducible: { cuota: Money; filas: number };
  /** Deductible recibidas + bienes_inversion rows (pre-prorrata), for the ledger cross-check. */
  deductibleRows: VatBookRow[];
  totalCuotaDevengada: Money;
  totalCuotaDeducible: Money;
  resultado46: Money;
  compensacionPendienteInicial: Money;
  compensacionAplicada: Money;
  compensacionPendienteFinal: Money;
  resultado71: Money;
  casillas: FiscalBox[];
  totales: Record<string, number>;
  avisos: string[];
};

function bucketsByRate(rows: readonly VatBookRow[], pick: (row: VatBookRow) => { rate: Money; base: Money; cuota: Money } | null): RateBucket[] {
  const map = new Map<string, RateBucket>();
  for (const row of rows) {
    const picked = pick(row);
    if (!picked) continue;
    const key = picked.rate.toFixed(2);
    const bucket = map.get(key) ?? { rate: picked.rate, base: ZERO, cuota: ZERO, filas: 0 };
    bucket.base = bucket.base.plus(picked.base);
    bucket.cuota = bucket.cuota.plus(picked.cuota);
    bucket.filas += 1;
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort((a, b) => b.rate.comparedTo(a.rate));
}

/**
 * The 303 arithmetic from book rows (IVA only). `compensacionPendiente` is
 * the 4700 balance carried into the period (casilla 110). Pure.
 */
export function compute303(input: { rows: readonly VatBookRow[]; settings: Pick<VatSettingsDto, "prorrataPct" | "regime" | "taxFigure">; compensacionPendiente: Money }): Modelo303Computation {
  const avisos: string[] = [];
  const emitidas = input.rows.filter((row) => row.book === "emitidas");
  const recibidas = input.rows.filter((row) => row.book === "recibidas");
  const inversion = input.rows.filter((row) => row.book === "bienes_inversion");

  // Not-subject rows (N1) have quota 0 and rate 0; S1 at 0 % are exempt or
  // misconfigured lines. Both are reported apart from the taxed rates.
  const devengado = bucketsByRate(emitidas, (row) => (row.rate.isZero() ? null : { rate: row.rate, base: row.base, cuota: row.quota }));
  const noSujetas = round2(emitidas.filter((row) => row.rate.isZero()).reduce((sum, row) => sum.plus(row.base), ZERO));
  const recargo = bucketsByRate(emitidas, (row) => (row.surchargeRate && row.surchargeQuota ? { rate: row.surchargeRate, base: row.base, cuota: row.surchargeQuota } : null));

  const deductibleRows = [...recibidas, ...inversion].filter((row) => row.deductible);
  const nonDeductible = [...recibidas, ...inversion].filter((row) => !row.deductible);
  const prorrata = input.settings.prorrataPct !== null && input.settings.prorrataPct < 100 ? new Prisma.Decimal(input.settings.prorrataPct).div(100) : null;
  const deductibleQuota = (rows: readonly VatBookRow[]): Money => {
    const raw = rows.reduce((sum, row) => sum.plus(row.quota), ZERO);
    return prorrata ? round2(raw.times(prorrata)) : round2(raw);
  };
  const corrienteRows = deductibleRows.filter((row) => row.book === "recibidas");
  const inversionRows = deductibleRows.filter((row) => row.book === "bienes_inversion");
  const deducibleCorriente = { base: round2(corrienteRows.reduce((sum, row) => sum.plus(row.base), ZERO)), cuota: deductibleQuota(corrienteRows), filas: corrienteRows.length };
  const deducibleInversion = { base: round2(inversionRows.reduce((sum, row) => sum.plus(row.base), ZERO)), cuota: deductibleQuota(inversionRows), filas: inversionRows.length };
  const noDeducible = { cuota: round2(nonDeductible.reduce((sum, row) => sum.plus(row.quota), ZERO)), filas: nonDeductible.length };

  const totalCuotaDevengada = round2(devengado.reduce((sum, bucket) => sum.plus(bucket.cuota), ZERO).plus(recargo.reduce((sum, bucket) => sum.plus(bucket.cuota), ZERO)));
  const totalCuotaDeducible = round2(deducibleCorriente.cuota.plus(deducibleInversion.cuota));
  const resultado46 = round2(totalCuotaDevengada.minus(totalCuotaDeducible));
  const resultado66 = resultado46; // 64 = 46 (no régimen simplificado), 65 = 100 %, 66 = 64
  const compensacionPendienteInicial = round2(input.compensacionPendiente);
  const compensacionAplicada = resultado66.greaterThan(0) ? Prisma.Decimal.min(compensacionPendienteInicial, resultado66) : ZERO;
  const resultado69 = round2(resultado66.minus(compensacionAplicada)); // + 77 (0) + 68 (0)
  const resultado71 = resultado69; // − 70 (0)
  const compensacionPendienteFinal = round2(compensacionPendienteInicial.minus(compensacionAplicada).plus(resultado71.lessThan(0) ? resultado71.abs() : ZERO));

  if (prorrata) avisos.push(`Prorrata general del ${input.settings.prorrataPct} % aplicada a las cuotas deducibles (casillas 29 y 31).`);
  if (noDeducible.filas > 0) avisos.push(`${noDeducible.filas} fila(s) de recibidas con cuota no deducible (${noDeducible.cuota.toFixed(2)} €) excluidas de las casillas 28-31.`);
  if (!noSujetas.isZero()) avisos.push(`Operaciones al 0 % (exentas / no sujetas / sin tipo configurado) por ${noSujetas.toFixed(2)} € de base: sin casilla asignada, revisa su calificación antes de presentar.`);
  if (input.settings.taxFigure !== "IVA") avisos.push(`La organización tributa por ${input.settings.taxFigure}: el Modelo 303 no aplica (IGIC → Modelo 420 ATC; IPSI → ordenanza local). Se muestran solo las filas IVA.`);

  const casillas: FiscalBox[] = [];
  const seen = new Set<string>();
  for (const map of MODELO_303_RATE_BOXES) {
    const bucket = devengado.find((entry) => rateKey(entry.rate) === map.rate);
    seen.add(map.rate);
    casillas.push(box(map.base, `DEV_BASE_${map.rate}`, `Base imponible al ${map.rate} %`, SECTION_DEVENGADO, bucket?.base ?? ZERO, "base"));
    casillas.push(box(map.tipo, `DEV_TIPO_${map.rate}`, "Tipo %", SECTION_DEVENGADO, new Prisma.Decimal(map.rate), "tipo"));
    casillas.push(box(map.cuota, `DEV_CUOTA_${map.rate}`, `Cuota devengada al ${map.rate} %`, SECTION_DEVENGADO, bucket?.cuota ?? ZERO, "cuota"));
  }
  for (const bucket of devengado) {
    const key = rateKey(bucket.rate);
    if (seen.has(key)) continue;
    avisos.push(`Tipo ${key} % sin casilla asignada en el Modelo 303 vigente: base ${bucket.base.toFixed(2)} €, cuota ${bucket.cuota.toFixed(2)} € (revisar antes de presentar).`);
    casillas.push(box(null, `DEV_BASE_${key}`, `Base imponible al ${key} % (sin casilla)`, SECTION_DEVENGADO, bucket.base, "base"));
    casillas.push(box(null, `DEV_CUOTA_${key}`, `Cuota devengada al ${key} % (sin casilla)`, SECTION_DEVENGADO, bucket.cuota, "cuota"));
  }
  for (const bucket of recargo) {
    const key = rateKey(bucket.rate);
    const map = MODELO_303_SURCHARGE_BOXES.find((entry) => entry.rate === key);
    casillas.push(box(map?.base ?? null, `RE_BASE_${key}`, `Recargo de equivalencia: base al ${key} %`, SECTION_RECARGO, bucket.base, "base"));
    casillas.push(box(map?.tipo ?? null, `RE_TIPO_${key}`, "Tipo %", SECTION_RECARGO, bucket.rate, "tipo"));
    casillas.push(box(map?.cuota ?? null, `RE_CUOTA_${key}`, `Recargo de equivalencia: cuota al ${key} %`, SECTION_RECARGO, bucket.cuota, "cuota"));
    if (!map) avisos.push(`Recargo de equivalencia al ${key} % sin casilla asignada.`);
  }
  casillas.push(box("27", "DEV_TOTAL_CUOTA", "Total cuota devengada", SECTION_DEVENGADO, totalCuotaDevengada, "cuota"));
  casillas.push(box("28", "DED_BASE_CORRIENTE", "Por cuotas soportadas en operaciones interiores corrientes: base", SECTION_DEDUCIBLE, deducibleCorriente.base, "base"));
  casillas.push(box("29", "DED_CUOTA_CORRIENTE", "Por cuotas soportadas en operaciones interiores corrientes: cuota", SECTION_DEDUCIBLE, deducibleCorriente.cuota, "cuota"));
  casillas.push(box("30", "DED_BASE_INVERSION", "Por cuotas soportadas en operaciones interiores con bienes de inversión: base", SECTION_DEDUCIBLE, deducibleInversion.base, "base"));
  casillas.push(box("31", "DED_CUOTA_INVERSION", "Por cuotas soportadas en operaciones interiores con bienes de inversión: cuota", SECTION_DEDUCIBLE, deducibleInversion.cuota, "cuota"));
  casillas.push(box("45", "DED_TOTAL", "Total a deducir", SECTION_DEDUCIBLE, totalCuotaDeducible, "cuota"));
  casillas.push(box("46", "RESULTADO_REGIMEN_GENERAL", "Resultado régimen general (27 − 45)", SECTION_RESULTADO, resultado46, "resultado"));
  casillas.push(box("64", "SUMA_RESULTADOS", "Suma de resultados (46 + 58)", SECTION_RESULTADO, resultado46, "resultado"));
  casillas.push(box("65", "PCT_ESTADO", "% atribuible a la Administración del Estado", SECTION_RESULTADO, new Prisma.Decimal(100), "tipo"));
  casillas.push(box("66", "ATRIBUIBLE_ESTADO", "Atribuible a la Administración del Estado", SECTION_RESULTADO, resultado66, "resultado"));
  casillas.push(box("77", "IVA_IMPORTACION_DIFERIDO", "IVA a la importación liquidado por la Aduana pendiente de ingreso", SECTION_RESULTADO, ZERO, "cuota"));
  casillas.push(box("110", "COMPENSACION_PENDIENTE_INICIAL", "Cuotas a compensar pendientes de periodos anteriores", SECTION_RESULTADO, compensacionPendienteInicial, "cuota"));
  casillas.push(box("78", "COMPENSACION_APLICADA", "Cuotas a compensar de periodos anteriores aplicadas en este periodo", SECTION_RESULTADO, compensacionAplicada, "cuota"));
  casillas.push(box("87", "COMPENSACION_PENDIENTE_POSTERIOR", "Cuotas a compensar de periodos previos pendientes para periodos posteriores", SECTION_RESULTADO, round2(compensacionPendienteInicial.minus(compensacionAplicada)), "cuota"));
  casillas.push(box("69", "RESULTADO", "Resultado (66 + 77 − 78 + 68)", SECTION_RESULTADO, resultado69, "resultado"));
  casillas.push(box("70", "A_DEDUCIR_COMPLEMENTARIA", "A deducir (exclusivamente en caso de autoliquidación complementaria)", SECTION_RESULTADO, ZERO, "cuota"));
  casillas.push(box("71", "RESULTADO_LIQUIDACION", "Resultado de la liquidación (69 − 70)", SECTION_RESULTADO, resultado71, "resultado"));
  if (!noSujetas.isZero()) casillas.push(box(null, "INFO_OPERACIONES_0", "Operaciones al 0 % (exentas / no sujetas) — sin casilla asignada", SECTION_INFO, noSujetas, "info"));

  const baseDevengada = round2(devengado.reduce((sum, bucket) => sum.plus(bucket.base), ZERO));
  const totales: Record<string, number> = {
    baseDevengada: toWire(baseDevengada),
    cuotaDevengada: toWire(totalCuotaDevengada),
    baseDeducible: toWire(deducibleCorriente.base.plus(deducibleInversion.base)),
    cuotaDeducible: toWire(totalCuotaDeducible),
    resultadoRegimenGeneral: toWire(resultado46),
    compensacionPendienteInicial: toWire(compensacionPendienteInicial),
    compensacionAplicada: toWire(compensacionAplicada),
    compensacionPendienteFinal: toWire(compensacionPendienteFinal),
    resultado: toWire(resultado71),
    aIngresar: toWire(resultado71.greaterThan(0) ? resultado71 : ZERO),
    aCompensar: toWire(resultado71.lessThan(0) ? resultado71.abs() : ZERO)
  };

  return {
    devengado,
    recargo,
    noSujetas,
    deducibleCorriente,
    deducibleInversion,
    noDeducible,
    deductibleRows,
    totalCuotaDevengada,
    totalCuotaDeducible,
    resultado46,
    compensacionPendienteInicial,
    compensacionAplicada,
    compensacionPendienteFinal,
    resultado71,
    casillas,
    totales,
    avisos
  };
}

// ── Period resolution ───────────────────────────────────────────────────────

/**
 * Period of a 303 / 111 / 115 request: `period` (2026-Q3 · 2026-09) or the
 * legacy `fromDate`/`toDate` pair, which must be a natural quarter or month.
 * When `periodicity` is given the kind must match it (400 PERIOD_MISMATCH);
 * `regimen` (Tanda 6b · R8) names the sociedad's regime in the message when
 * the monthly periodicity is forced by SII / gran empresa.
 */
export function resolveSettlementPeriod(input: { period?: string; fromDate?: string; toDate?: string }, periodicity?: "quarterly" | "monthly", regimen?: Pick<FiscalRegimeSummary, "periodicityForcedBy"> | null): FiscalPeriodDto {
  let periodo: FiscalPeriodDto;
  if (input.period) {
    periodo = parseFiscalPeriod(input.period, ["quarterly", "monthly"]);
  } else if (input.fromDate || input.toDate) {
    if (!isIsoDay(input.fromDate) || !isIsoDay(input.toDate)) {
      throw new BadRequestError("Indica period (2026-Q3 · 2026-09) o fromDate y toDate (formato YYYY-MM-DD).");
    }
    const resolved = periodFromRange(input.fromDate, input.toDate);
    if (!resolved || resolved.type === "annual") {
      const error = new BadRequestError("fromDate y toDate deben delimitar un trimestre o mes natural completo (p. ej. 2026-07-01..2026-09-30); usa mejor period=2026-Q3.");
      error.details = { code: "INVALID_PERIOD" };
      throw error;
    }
    periodo = resolved;
  } else {
    const error = new BadRequestError("El parámetro period es obligatorio (2026-Q3 trimestral · 2026-09 mensual).");
    error.details = { code: "INVALID_PERIOD" };
    throw error;
  }
  if (periodicity && periodo.type !== periodicity) {
    const forcedBy = regimen?.periodicityForcedBy ?? null;
    const monthlyReason = forcedBy === "sii" ? "sociedad acogida al SII, RIVA art. 71.3" : forcedBy === "large_company" ? "sociedad calificada como gran empresa, RIVA art. 71.3" : "REDEME";
    const error = new BadRequestError(
      periodicity === "quarterly"
        ? `La sociedad liquida trimestralmente: usa un trimestre (${periodo.year}-Q${periodo.quarter ?? 1}), no un mes.`
        : `La sociedad liquida mensualmente (${monthlyReason}): usa un mes (${periodo.year}-01), no un trimestre.`
    );
    error.details = { code: "PERIOD_MISMATCH", periodicity, requested: periodo.code, ...(forcedBy ? { forcedBy } : {}) };
    throw error;
  }
  return periodo;
}

// ── Ledger readers (read-only) ──────────────────────────────────────────────

async function vatAccountIds(organizationId: string, prefixes: readonly string[]): Promise<Map<string, string>> {
  const accounts = await prisma.account.findMany({ where: { organizationId, OR: prefixes.map((prefix) => ({ code: { startsWith: prefix } })) }, select: { id: true, code: true } });
  return new Map(accounts.map((account) => [account.id, account.code]));
}

/**
 * Balance of 4700 carried into `from` by the non-reversed settlement entries
 * (casilla 110). Debit − credit on 4700 of `vat_settlement` entries dated
 * before the period; 0 when nothing was settled yet.
 */
export async function pendingVatCompensation(organizationId: string, from: string): Promise<Money> {
  const entries = await prisma.journalEntry.findMany({
    where: { organizationId, sourceType: "vat_settlement", status: "posted", reversedById: null, entryDate: { lt: dateColumn(from) } },
    select: { id: true }
  });
  if (entries.length === 0) return ZERO;
  const accounts = await vatAccountIds(organizationId, ["4700"]);
  const lines = await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entries.map((entry) => entry.id) }, accountId: { in: Array.from(accounts.keys()) } },
    select: { debit: true, credit: true }
  });
  return round2(lines.reduce((sum, line) => sum.plus(money(line.debit)).minus(money(line.credit)), ZERO));
}

function rateOfLedgerLine(line: { taxRateCode: string | null; description: string | null }, accountCode: string): { rate: Money | null; guessed: boolean } {
  if (line.taxRateCode && /^\d+(\.\d+)?$/.test(line.taxRateCode)) return { rate: new Prisma.Decimal(line.taxRateCode), guessed: false };
  const dot = accountCode.indexOf(".");
  if (dot > 0) {
    const suffix = accountCode.slice(dot + 1);
    if (/^\d+$/.test(suffix)) return { rate: new Prisma.Decimal(Number(suffix)), guessed: false };
  }
  const match = /(\d+(?:[.,]\d+)?)\s*%/.exec(line.description ?? "");
  if (match) return { rate: new Prisma.Decimal(match[1]!.replace(",", ".")), guessed: true };
  return { rate: null, guessed: true };
}

/** Journal statuses that take part in the cross-check: a reversed original keeps its VAT lines in its own period. */
export const LEDGER_CROSS_CHECK_STATUSES = ["posted", "reversed"] as const;
/** Year-end carry-over kinds: they close and reopen the 477x/472x balances without accruing anything. */
const CARRY_OVER_ENTRY_KINDS: ReadonlySet<string> = new Set(["closing", "opening"]);
/** OPERA shadow mode (Tanda 7b): daily revenue accrued on 477 from the PMS with no book row behind it. */
export const PMS_SHADOW_REVENUE_SOURCE_TYPE = "pms_shadow_revenue";
/** Sage 200 imported journal entries (Tanda 7c): only these are screened for the settlement pattern. */
export const SAGE_JOURNAL_SOURCE_TYPE = "sage200_journal";
/** Explicit bound of the entries a cross-check reads (≈ 3.000 a quarter at Faranda with Sage loaded); a hit is reported in `avisos`. */
export const LEDGER_CROSS_CHECK_MAX_ENTRIES = 25_000;
/** Explicit bound of the 477x / 472x / 4750x / 4700x lines a cross-check reads; a hit is reported in `avisos`. */
export const LEDGER_CROSS_CHECK_MAX_LINES = 50_000;

/**
 * Entries that move VAT without accruing it, so they must not enter the
 * cross-check: the settlement (477/472 → 4750/4700), the year-end closing /
 * opening entries, and the OPERA shadow revenue entries (`pms_shadow_revenue`),
 * which accrue 477 without any row in the books (the invoices live in the
 * other PMS: the books can never match them). Pure.
 */
export function isNonAccrualVatEntry(entry: { sourceType: string; entryKind: string }): boolean {
  return entry.sourceType === "vat_settlement" || entry.sourceType === PMS_SHADOW_REVENUE_SOURCE_TYPE || CARRY_OVER_ENTRY_KINDS.has(entry.entryKind);
}

const isSettlementAccount = (code: string): boolean => code.startsWith("4750") || code.startsWith("4700");
const isAccrualVatAccount = (code: string): boolean => code.startsWith("477") || code.startsWith("472");

/**
 * Settlement pattern of an entry imported from Sage 200: a `sage200_journal`
 * entry (or the reversal of one — `sourceType` is the target's) whose lines
 * touch a settlement account (4750x Hacienda acreedora / 4700x deudora) TOGETHER
 * with an accrual account (477x / 472x). Such an entry («Liquidación IVA
 * 2026-Q2») nets the quarter's quotas against the Treasury: it is not a
 * devengo. The rate is NOT the discriminator (the importer fills `taxRateCode`
 * from `tipo_iva`); the account pattern is. Pure.
 */
export function isSageSettlementPattern(sourceType: string, accountCodes: readonly string[]): boolean {
  if (sourceType !== SAGE_JOURNAL_SOURCE_TYPE) return false;
  return accountCodes.some(isSettlementAccount) && accountCodes.some(isAccrualVatAccount);
}

/** Spanish `avisos` naming every exclusion of the cross-check with its count (only the non-zero ones). Pure. */
export function crossCheckExclusionAvisos(excluded: { liquidacion: number; cierreApertura: number; pmsSombra: number; liquidacionSage: number }): string[] {
  const avisos: string[] = [];
  const plural = (n: number, singular: string, pluralForm: string): string => `${n} ${n === 1 ? singular : pluralForm}`;
  if (excluded.liquidacion > 0) avisos.push(`${plural(excluded.liquidacion, "asiento de liquidación del IVA excluido", "asientos de liquidación del IVA excluidos")} del cotejo (mueven las cuotas a 4750/4700 sin devengarlas).`);
  if (excluded.cierreApertura > 0) avisos.push(`${plural(excluded.cierreApertura, "asiento de cierre o apertura de ejercicio excluido", "asientos de cierre o apertura de ejercicio excluidos")} del cotejo (arrastran saldos de 477/472 sin devengarlos).`);
  if (excluded.pmsSombra > 0) avisos.push(`${plural(excluded.pmsSombra, "asiento de ingresos de OPERA en modo sombra (pms_shadow_revenue) excluido", "asientos de ingresos de OPERA en modo sombra (pms_shadow_revenue) excluidos")} del cotejo: devengan 477 desde el PMS sin fila en el libro de emitidas.`);
  if (excluded.liquidacionSage > 0) avisos.push(`${plural(excluded.liquidacionSage, "asiento de liquidación importado de Sage excluido", "asientos de liquidación importados de Sage excluidos")} del cotejo (patrón 4750/4700 junto a 477/472).`);
  return avisos;
}

/**
 * What the journal says for the period on 477x (repercutido) and 472x
 * (soportado), grouped by rate, versus the book buckets.
 *
 * Both halves of a reversed pair count, each in its own period: the original
 * keeps `status = reversed` together with its 477x/472x lines, and the
 * reversal (`reversalOfId`) carries the opposite lines on its own date —
 * exactly how the books record an invoice and its cancellation (dated on
 * the cancellation day). Filtering on `posted` alone dropped the original
 * and kept the reversal, so every invoice cancelled inside the period
 * subtracted its quota twice and broke `cuadra` (t6#8).
 *
 * Excluded together with their reversals (see the header; every exclusion is
 * named with its count in `avisos`): the settlement entries, the year-end
 * close/open entries, the OPERA shadow revenue entries and the settlement
 * entries imported from Sage 200 (account pattern 4750/4700 + 477/472). The
 * reversed target may be dated outside the period, so it is looked up by id.
 * Bounded by `LEDGER_CROSS_CHECK_MAX_ENTRIES` / `LEDGER_CROSS_CHECK_MAX_LINES`.
 */
export async function ledgerCrossCheck(input: { organizationId: string; periodo: FiscalPeriodDto; propertyId?: string | null; computation: Modelo303Computation }): Promise<{ check: FiscalLedgerCrossCheck; avisos: string[] }> {
  const avisos: string[] = [];
  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: input.organizationId,
      status: { in: [...LEDGER_CROSS_CHECK_STATUSES] },
      entryDate: { gte: dateColumn(input.periodo.from), lte: dateColumn(input.periodo.to) },
      ...(input.propertyId ? { propertyId: input.propertyId } : {})
    },
    select: { id: true, sourceType: true, entryKind: true, reversalOfId: true },
    orderBy: [{ entryDate: "asc" }, { id: "asc" }],
    take: LEDGER_CROSS_CHECK_MAX_ENTRIES + 1
  });
  if (entries.length > LEDGER_CROSS_CHECK_MAX_ENTRIES) {
    entries.length = LEDGER_CROSS_CHECK_MAX_ENTRIES;
    avisos.push(`El diario del periodo ${input.periodo.code} supera ${LEDGER_CROSS_CHECK_MAX_ENTRIES} asientos: el cotejo con el diario usa los primeros ${LEDGER_CROSS_CHECK_MAX_ENTRIES} por fecha y no es concluyente; acota el periodo o el centro.`);
  }
  // Reversal targets (possibly dated outside the period) decide the nature of a reversal entry.
  const reversalTargetIds = Array.from(new Set(entries.map((entry) => entry.reversalOfId).filter((id): id is string => Boolean(id))));
  const targets = new Map<string, { sourceType: string; entryKind: string }>(
    reversalTargetIds.length > 0
      ? (await prisma.journalEntry.findMany({ where: { id: { in: reversalTargetIds } }, select: { id: true, sourceType: true, entryKind: true } })).map((entry) => [entry.id, { sourceType: entry.sourceType, entryKind: entry.entryKind }])
      : []
  );
  /** The entry that gives a journal entry its nature: itself, or the reversed target of a reversal. */
  const natureOf = (entry: { sourceType: string; entryKind: string; reversalOfId: string | null }): { sourceType: string; entryKind: string } =>
    (entry.reversalOfId && targets.get(entry.reversalOfId)) || entry;
  const excluded = { liquidacion: 0, cierreApertura: 0, pmsSombra: 0, liquidacionSage: 0 };
  const relevant: typeof entries = [];
  for (const entry of entries) {
    const nature = natureOf(entry);
    if (nature.sourceType === "vat_settlement") excluded.liquidacion += 1;
    else if (CARRY_OVER_ENTRY_KINDS.has(nature.entryKind)) excluded.cierreApertura += 1;
    else if (nature.sourceType === PMS_SHADOW_REVENUE_SOURCE_TYPE) excluded.pmsSombra += 1;
    else if (isNonAccrualVatEntry(nature)) excluded.liquidacion += 1;
    else relevant.push(entry);
  }
  // Accrual accounts plus the settlement accounts: the latter only serve the Sage pattern, never the sums.
  const accounts = await vatAccountIds(input.organizationId, ["477", "472", "4750", "4700"]);
  const allLines = relevant.length > 0 && accounts.size > 0
    ? await prisma.journalLine.findMany({
        where: { journalEntryId: { in: relevant.map((entry) => entry.id) }, accountId: { in: Array.from(accounts.keys()) } },
        select: { journalEntryId: true, accountId: true, debit: true, credit: true, taxRateCode: true, description: true },
        orderBy: [{ journalEntryId: "asc" }, { id: "asc" }],
        take: LEDGER_CROSS_CHECK_MAX_LINES + 1
      })
    : [];
  if (allLines.length > LEDGER_CROSS_CHECK_MAX_LINES) {
    allLines.length = LEDGER_CROSS_CHECK_MAX_LINES;
    avisos.push(`Los apuntes de IVA del periodo ${input.periodo.code} superan ${LEDGER_CROSS_CHECK_MAX_LINES}: el cotejo con el diario usa los primeros ${LEDGER_CROSS_CHECK_MAX_LINES} y no es concluyente; acota el periodo o el centro.`);
  }
  // Sage settlement pattern, decided per entry over its own lines.
  const codesByEntry = new Map<string, string[]>();
  for (const line of allLines) {
    const bucket = codesByEntry.get(line.journalEntryId) ?? [];
    bucket.push(accounts.get(line.accountId) ?? "");
    codesByEntry.set(line.journalEntryId, bucket);
  }
  const sageSettlementIds = new Set<string>();
  for (const entry of relevant) {
    if (isSageSettlementPattern(natureOf(entry).sourceType, codesByEntry.get(entry.id) ?? [])) sageSettlementIds.add(entry.id);
  }
  excluded.liquidacionSage = sageSettlementIds.size;
  const lines = allLines.filter((line) => !sageSettlementIds.has(line.journalEntryId) && isAccrualVatAccount(accounts.get(line.accountId) ?? ""));
  const repercutido = new Map<string, Money>();
  const soportado = new Map<string, Money>();
  let guessed = 0;
  for (const line of lines) {
    const code = accounts.get(line.accountId) ?? "";
    const { rate, guessed: wasGuessed } = rateOfLedgerLine(line, code);
    if (wasGuessed) guessed += 1;
    const key = rate ? rate.toFixed(2) : "?";
    if (code.startsWith("477")) {
      repercutido.set(key, (repercutido.get(key) ?? ZERO).plus(money(line.credit)).minus(money(line.debit)));
    } else {
      soportado.set(key, (soportado.get(key) ?? ZERO).plus(money(line.debit)).minus(money(line.credit)));
    }
  }
  const diferencias: FiscalLedgerCrossCheck["diferencias"] = [];
  const compare = (libro: "repercutido" | "soportado", books: Map<string, Money>, ledger: Map<string, Money>): void => {
    const keys = new Set([...books.keys(), ...ledger.keys()]);
    for (const key of keys) {
      const fromBooks = round2(books.get(key) ?? ZERO);
      const fromLedger = round2(ledger.get(key) ?? ZERO);
      if (differs(fromBooks, fromLedger)) {
        diferencias.push({ libro, rate: key === "?" ? null : toWire(new Prisma.Decimal(key)), libros: toWire(fromBooks), diario: toWire(fromLedger), diferencia: toWire(fromBooks.minus(fromLedger)) });
      }
    }
  };
  const bookRepercutido = new Map<string, Money>(input.computation.devengado.map((bucket) => [bucket.rate.toFixed(2), bucket.cuota]));
  // Soportado is compared per rate with the deductible rows' quotas (pre-prorrata: the ledger carries the full 472 quota).
  const bookSoportado = new Map<string, Money>();
  for (const row of input.computation.deductibleRows) {
    const key = row.rate.toFixed(2);
    bookSoportado.set(key, (bookSoportado.get(key) ?? ZERO).plus(row.quota));
  }
  compare("repercutido", bookRepercutido, repercutido);
  compare("soportado", bookSoportado, soportado);
  const cuotaRepercutida = round2(Array.from(repercutido.values()).reduce((sum, value) => sum.plus(value), ZERO));
  const cuotaSoportada = round2(Array.from(soportado.values()).reduce((sum, value) => sum.plus(value), ZERO));
  if (lines.length === 0) {
    avisos.push("El diario no tiene apuntes de IVA (477x/472x) en el periodo: las facturas aún no asientan, el 303 se calcula exclusivamente desde los libros.");
  } else if (diferencias.length > 0) {
    avisos.push(`Los libros de IVA y el diario difieren en ${diferencias.length} tipo(s) (ver fuentes.diario.diferencias): revisa los asientos antes de liquidar.`);
  }
  if (guessed > 0) avisos.push(`${guessed} apunte(s) de IVA heredados sin tipo (taxRateCode) — tipo deducido de la subcuenta o de la descripción solo para el cotejo.`);
  avisos.push(...crossCheckExclusionAvisos(excluded));
  return {
    check: { apuntes: lines.length, cuotaRepercutida: toWire(cuotaRepercutida), cuotaSoportada: toWire(cuotaSoportada), diferencias, cuadra: diferencias.length === 0 },
    avisos
  };
}

/**
 * Tanda L3-C / corrector L3 (DS-06): an original replaced by a rectificativa
 * por sustitución («S») must carry its `<originalId>#sustituida` counter-rows
 * in the books (the live writer materialises them; a rebuild derives them).
 * Books rebuilt before L3-C lack them, so the replaced invoice would be
 * counted in full while the ledger reversed it. Instead of only NAMING the
 * gap, the missing counter-rows are DERIVED IN MEMORY for this computation
 * (same `vatRowsFromInvoice` the rebuild uses, dated on the substitute's issue
 * day, kept when they fall in the period) and the aviso says so — the live
 * 303 no longer overstates the quota until `POST /fiscal/vat-books/rebuild`
 * persists them. Nothing is written. Rows already present are never doubled.
 */
export async function supersededRowsInMemory(input: { organizationId: string; periodo: FiscalPeriodDto; rows: readonly VatBookRow[]; periodicity: VatSettingsDto["periodicity"] }): Promise<{ rows: VatBookRow[]; avisos: string[] }> {
  const rectificationIds = Array.from(new Set(input.rows.filter((row) => row.book === "emitidas" && row.sourceType === "rectification").map((row) => row.sourceId)));
  if (rectificationIds.length === 0) return { rows: [], avisos: [] };
  const substitutes = await prisma.invoice.findMany({
    where: { id: { in: rectificationIds }, rectificationType: "S", rectifyingForId: { not: null }, deletedAt: null },
    select: { id: true, invoiceNumber: true, rectifyingForId: true, issuedAt: true }
  });
  if (substitutes.length === 0) return { rows: [], avisos: [] };
  const present = new Set(input.rows.map((row) => row.sourceId));
  const missing = substitutes.filter((substitute) => !present.has(supersededSourceId(substitute.rectifyingForId!)));
  if (missing.length === 0) return { rows: [], avisos: [] };
  const originalIds = missing.map((substitute) => substitute.rectifyingForId!);
  const originals = await prisma.invoice.findMany({ where: { id: { in: originalIds }, deletedAt: null }, select: INVOICE_FOR_BOOKS_SELECT });
  const lines = await prisma.invoiceLine.findMany({
    where: { invoiceId: { in: originalIds } },
    select: { invoiceId: true, total: true, taxRate: true, taxCode: true, taxCalificacion: true, taxFigure: true }
  });
  const linesByInvoice = new Map<string, InvoiceLineForBooks[]>();
  for (const line of lines) {
    const bucket = linesByInvoice.get(line.invoiceId) ?? [];
    bucket.push(line);
    linesByInvoice.set(line.invoiceId, bucket);
  }
  const forBooks = new Map<string, InvoiceForBooks>(originals.map((invoice) => [invoice.id, { ...invoice, lines: linesByInvoice.get(invoice.id) ?? [] }]));
  const inRange = (day: string): boolean => day >= input.periodo.from && day <= input.periodo.to;
  const rows: VatBookRow[] = [];
  const avisos: string[] = [];
  for (const substitute of missing) {
    const originalId = substitute.rectifyingForId!;
    const original = forBooks.get(originalId);
    const originalLabel = original?.invoiceNumber ?? originalId;
    if (!original || !substitute.issuedAt) {
      avisos.push(`Factura ${originalLabel} sustituida por ${substitute.invoiceNumber ?? substitute.id} sin contrafilas #sustituida en el libro de emitidas y sin documento original legible: ejecuta POST /fiscal/vat-books/rebuild del periodo ${input.periodo.code}.`);
      continue;
    }
    const derived = vatRowsFromInvoice({ invoice: original, organizationId: input.organizationId, periodicity: input.periodicity, kind: "superseded", supersededAt: substitute.issuedAt }).rows.filter((row) => inRange(row.date));
    const quota = round2(derived.reduce((sum, row) => sum.plus(row.quota), ZERO));
    rows.push(...derived);
    avisos.push(
      derived.length > 0
        ? `Factura ${originalLabel} sustituida por ${substitute.invoiceNumber ?? substitute.id} sin contrafilas #sustituida en el libro de emitidas: ${derived.length} contrafila(s) derivadas en memoria para este cálculo (cuota ${quota.toFixed(2)} €); ejecuta POST /fiscal/vat-books/rebuild del periodo ${input.periodo.code} para persistirlas.`
        : `Factura ${originalLabel} sustituida por ${substitute.invoiceNumber ?? substitute.id} sin contrafilas #sustituida en el libro de emitidas (fuera del periodo ${input.periodo.code}): ejecuta POST /fiscal/vat-books/rebuild del periodo de la sustitutiva.`
    );
  }
  return { rows, avisos };
}

export async function existingSettlement(organizationId: string, periodCode: string): Promise<FiscalModelReport["fuentes"]["liquidacion"]> {
  const entry = await prisma.journalEntry.findFirst({
    where: { organizationId, sourceType: "vat_settlement", sourceId: vatSettlementSourceId(periodCode), status: { in: ["posted", "reversed"] } },
    orderBy: [{ postedAt: "desc" }],
    select: { id: true, entryNumber: true, fiscalYearCode: true, entryDate: true, reversedById: true, status: true }
  });
  if (!entry) return null;
  return { journalEntryId: entry.id, entryNumber: entry.entryNumber, fiscalYearCode: entry.fiscalYearCode, entryDate: dateColumnDay(entry.entryDate), reversed: Boolean(entry.reversedById) || entry.status === "reversed" };
}

/**
 * Declarant of every AEAT model (Tanda 6b · R2): the sociedad behind the NIF,
 * read through `resolveLegalIdentity` (getVatSettings carries the badge) —
 * never `Organization.taxId/legalName`. `declarante` is the legacy pair the
 * reports and the PDF print; `sociedad` is the typed badge with the regime.
 */
export async function declaranteOf(organizationId: string): Promise<{ declarante: { nif: string | null; nombre: string | null }; sociedad: FiscalDeclaranteBadge }> {
  const settings = await getVatSettings(organizationId);
  return { declarante: declarantePair(settings.sociedad), sociedad: settings.sociedad };
}

export const PARTIAL_VIEW_303_AVISO = "Vista parcial por establecimiento (no liquidable): el Modelo 303 se presenta por NIF de la sociedad, que es el declarante; las casillas de esta vista son un desglose informativo.";

// ── Model for a period (shared by the route, the 390 and the settlement) ────

export type Modelo303ForPeriod = {
  report: FiscalModelReport;
  computation: Modelo303Computation;
  settings: VatSettingsDto;
  rows: VatBookRow[];
};

/** Build the 303 of a period without permission checks (callers check). Read-only. */
export async function modelo303ForPeriod(input: { organizationId: string; periodo: FiscalPeriodDto; settings: VatSettingsDto; propertyId?: string | null; crossCheck?: boolean }): Promise<Modelo303ForPeriod> {
  const loaded = await loadVatBookRows({ organizationId: input.organizationId, from: input.periodo.from, to: input.periodo.to, propertyId: input.propertyId, periodicity: input.settings.periodicity, taxFigure: input.settings.taxFigure });
  const avisos: string[] = [...loaded.avisos];
  const ivaRows = loaded.rows.filter((row) => row.taxFigure === "IVA");
  const otherFigures = loaded.rows.length - ivaRows.length;
  if (otherFigures > 0) avisos.push(`${otherFigures} fila(s) con IGIC/IPSI excluidas del Modelo 303.`);
  // Corrector L3 (DS-06): counter the originals replaced by a rectificativa «S» whose #sustituida rows the book lacks.
  const superseded = await supersededRowsInMemory({ organizationId: input.organizationId, periodo: input.periodo, rows: ivaRows, periodicity: input.settings.periodicity });
  ivaRows.push(...superseded.rows.filter((row) => row.taxFigure === "IVA"));
  avisos.push(...superseded.avisos);
  const compensacion = input.propertyId ? ZERO : await pendingVatCompensation(input.organizationId, input.periodo.from);
  const computation = compute303({ rows: ivaRows, settings: input.settings, compensacionPendiente: compensacion });
  avisos.push(...computation.avisos);
  avisos.push(...regimeAvisos(input.settings.sociedad.regimen, "303"));
  if (input.propertyId) avisos.push(PARTIAL_VIEW_303_AVISO);
  let diario: FiscalLedgerCrossCheck | undefined;
  if (input.crossCheck !== false) {
    const cross = await ledgerCrossCheck({ organizationId: input.organizationId, periodo: input.periodo, propertyId: input.propertyId, computation });
    diario = cross.check;
    avisos.push(...cross.avisos);
  }
  const liquidacion = input.propertyId ? null : await existingSettlement(input.organizationId, input.periodo.code);
  if (liquidacion && !liquidacion.reversed) avisos.push(`Periodo liquidado: asiento ${liquidacion.entryNumber ?? liquidacion.journalEntryId} del ${liquidacion.entryDate}.`);
  const summary = (book: VatBookName) => summarizeVatRows(ivaRows.filter((row) => row.book === book));
  const anyDerived = (Object.values(loaded.origen) as Array<"libros" | "documentos">).some((origen) => origen === "documentos");
  const report: FiscalModelReport = {
    modelo: "303",
    titulo: MODELO_303_TITLE,
    organizationId: input.organizationId,
    propertyId: input.propertyId ?? null,
    periodo: input.periodo,
    declarante: declarantePair(input.settings.sociedad),
    sociedad: input.settings.sociedad,
    casillas: computation.casillas,
    totales: computation.totales,
    avisos,
    fuentes: {
      origen: anyDerived ? "documentos" : "libros",
      libros: { emitidas: summary("emitidas"), recibidas: summary("recibidas"), bienes_inversion: summary("bienes_inversion") },
      ...(diario ? { diario } : {}),
      liquidacion,
      registros: ivaRows.length
    },
    detalle: [],
    presentacion: { modo: "manual", ficheroOficial: false, nota: PRESENTACION_MANUAL_NOTA },
    generatedAt: new Date().toISOString()
  };
  return { report, computation, settings: input.settings, rows: ivaRows };
}

/**
 * Public entry point (route + legacy server.ts handler). Accepts `period` or
 * the legacy `fromDate`/`toDate` (natural quarter/month). `periodType` is
 * accepted for compatibility and ignored: the periodicity is the
 * organisation's VatSettings.
 */
export async function buildModelo303(input: { context: UserContext; propertyId?: string | null; period?: string; fromDate?: string; toDate?: string; periodType?: "monthly" | "quarterly" }): Promise<FiscalModelReport> {
  requirePermissions(input.context, ["accounting.read"]);
  // R11 (service level, so the legacy /accounting/reports/modelo-* handlers are covered too).
  assertFinanceReadScope(input.context, input.propertyId ?? null);
  const settings = await getVatSettings(input.context.organizationId);
  // `settings.periodicity` is the effective one (monthly under SII / gran empresa, R8).
  const periodo = resolveSettlementPeriod(input, settings.periodicity, settings.sociedad.regimen);
  const result = await modelo303ForPeriod({ organizationId: input.context.organizationId, periodo, settings, propertyId: input.propertyId ?? null });
  return result.report;
}
