// Finanzas · lote «iva-modelos» — Modelo 303 (autoliquidación del IVA).
//
// Rewritten 2026-09-15 (hallazgos 8/41/42/43): the model no longer parses the
// rate out of journal-line descriptions nor rebuilds the base from the quota.
// It is computed from the VAT books (`VatBookEntry`, vat-books.service.ts):
//   · IVA devengado (régimen general) by rate: casillas 01/03 (4 %), 04/06
//     (10 %), 07/09 (21 %); recargo de equivalencia 16/18 (0,5 %), 19/21
//     (1,4 %), 22/24 (5,2 %); 27 = total cuota devengada;
//   · FIX-1 · F2 (B-4): by `regime` of the row — AIB autofacturas 10/11, ISP
//     autofacturas 12/13 (both out of 01-09), exento_no_sujeto 120 (no quota);
//   · IVA deducible: 28/29 operaciones interiores corrientes (the received
//     ISP quotas included, as the official form does), 30/31 bienes de
//     inversión, 32/33 importaciones (DUA), 36/37 AIB corrientes, 38/39 AIB
//     bienes de inversión, 45 = total a deducir (prorrata general applied when
//     set) — corrector FIX-1 (SEC-08): 38/39 no longer carries the ISP quotas;
//   · resultado: 46 = 27 − 45; 64 = 46; 65 = 100 %; 66 = 64; 77 = 0 (IVA a la
//     importación diferido); 110 = cuotas a compensar pendientes de periodos
//     anteriores; 78 = cuotas a compensar aplicadas en este periodo; 87 =
//     pendientes para periodos posteriores; 69 = 66 + 77 − 78; 70 = 0
//     (complementaria); 71 = 69 − 70 = resultado de la liquidación.
// The pending compensation (110) is read from the ledger (FIX-1 · F3, B-2):
// the balance of 4700 (Hacienda Pública, deudora por IVA) left by the
// non-reversed `vat_settlement` entries AND by the settlement entries imported
// from Sage 200 (`sage200_journal` with the 4750/4700 + 477/472 pattern, «LIQUI
// IVA 1T»; closing / opening entries left out) dated before the period, plus
// the opening balance of VatSettings (`openingCompensation` from
// `openingCompensationPeriod` on) for the quarters before the first ledger
// settlement — ONE aggregated `$queryRaw`, so the 303 and the settlement entry
// always agree. Corrector FIX-1 (SEC-01): when the previous period has NO
// settlement entry (neither native nor imported), the ledger knows nothing of
// its result, so 110 is CHAINED: it is the `compensacionPendienteFinal` of the
// previous period's 303 as ehotelOS computes it, walking back period by period
// until the last one with a settlement entry (or the opening period / the
// first period with book rows), whose 4700 balance is the base
// (`resolveCarriedCompensation`). Two consecutive unsettled periods therefore
// never apply the same balance twice and a negative result carries forward.
// The imported settlements dated inside the period are listed as
// `fuentes.liquidacionesHistoricas` (shown, never posted by ehotelOS).
// Rates without a certain box (5 % of 2023-24, 0 % exempt / not subject) are
// reported with `casilla: null` plus an aviso, never invented.
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
// The cross-check is aggregated in the database (FIX-1 · F3, B-5): two
// `$queryRaw` over the period (sums by side and rate, counts of the excluded
// entries), no `findMany` and no bound — a Faranda quarter with Sage loaded
// (≈ 28.500 entries · 45.000 VAT lines) is read whole. An original replaced by
// a rectificativa «S» whose `#sustituida` counter-rows are missing from the
// books (books rebuilt before Tanda L3-C) is named in `avisos` too.
// Periodicity (quarterly / monthly REDEME) comes from VatSettings; a period
// of the wrong kind is a 400 `PERIOD_MISMATCH` — except the monthly
// INFORMATIVE view of a quarterly sociedad (`informativo=1`, FIX-1 · F3, E-02):
// the month is computed without compensation and flagged not filable. A
// centre breakdown over a Sage period (rows without centre) says so instead
// of painting zeros (E-03, `SAGE_NO_CENTRE_AVISO`). Read-only: never writes.

import { Prisma } from "@prisma/client";
import { prisma } from "@hotelos/database";
import { SAGE_NO_CENTRE_AVISO } from "@hotelos/shared";
import type { FiscalBox, FiscalDeclaranteBadge, FiscalHistoricalSettlementDto, FiscalLedgerCrossCheck, FiscalModelReport, FiscalPeriodDto, FiscalRegimeSummary, VatBookName, VatSettingsDto } from "@hotelos/shared/src/fiscal-types.js";
import { BRAND } from "../../lib/brand.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError } from "../../lib/http-error.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";
import {
  ZERO,
  countSageRowsWithoutCentre,
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

/** FIX-1 · F2: agregado de un régimen (base / cuota / filas). */
export type RegimeAggregate = { base: Money; cuota: Money; filas: number };

export type Modelo303Computation = {
  /**
   * Every accrued emitidas row with rate > 0 by rate — interior AND the ISP/AIB autofacturas: the
   * ledger-facing view (477x) the settlement entry and the journal cross-check read. Casillas 01-09
   * come from `devengadoInterior`; 10-13 from `aib` / `isp`.
   */
  devengado: RateBucket[];
  /** FIX-1 · F2: régimen general interior by rate (casillas 01-09) = `devengado` without the ISP/AIB autofacturas. */
  devengadoInterior: RateBucket[];
  recargo: RateBucket[];
  /** 0 % emitidas WITHOUT a regime that decides their box (aviso «sin casilla»); the `exento_no_sujeto` rows go to 120. */
  noSujetas: Money;
  /** Interior recibidas (28/29): rows with regime null / interior / exento_no_sujeto AND the received ISP quotas (official form; SEC-08). */
  deducibleCorriente: { base: Money; cuota: Money; filas: number };
  /** Interior bienes de inversión (30/31), the ISP investment goods included. */
  deducibleInversion: { base: Money; cuota: Money; filas: number };
  noDeducible: { cuota: Money; filas: number };
  /**
   * FIX-1 · F2 (B-4): inversión del sujeto pasivo — autofacturas emitidas (12/13) y cuotas soportadas.
   * `deducible` is INFORMATIVE (corrector, SEC-08): those rows are already inside 28/29 (30/31), never a box of their own.
   */
  isp: { devengado: RegimeAggregate; deducible: RegimeAggregate };
  /** FIX-1 · F2 (B-4): adquisiciones intracomunitarias — autofacturas emitidas (10/11) y cuotas soportadas corrientes (36/37). */
  aib: { devengado: RegimeAggregate; deducible: RegimeAggregate };
  /** Corrector FIX-1 (SEC-08): adquisiciones intracomunitarias de bienes de inversión (libro bienes_inversion, régimen aib) → 38/39. */
  aibInversion: RegimeAggregate;
  /** FIX-1 · F2 (B-4): importaciones (DUA, tipo F5) — cuotas soportadas (32/33). */
  importacion: RegimeAggregate;
  /** FIX-1 · F2 (B-4): emitidas exentas / no sujetas por reglas de localización (120, base sin cuota). */
  exentoNoSujeto: RegimeAggregate;
  /** Deductible recibidas + bienes_inversion rows (pre-prorrata, every regime), for the ledger cross-check and the settlement. */
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

/** Emitidas that are autofacturas of the sujeto pasivo (ISP / AIB): accrued and deducted at once, never a delivery of its own. */
const isAutofactura = (row: VatBookRow): boolean => row.regime === "isp" || row.regime === "aib";

/**
 * Deductible rows grouped by the box family that decides them (null → interior). The received ISP
 * quotas are `interior` on purpose (corrector FIX-1, SEC-08): the official 303 deducts them in 28/29
 * (30/31 for investment goods) — 38/39 is reserved to the intra-EU acquisitions of investment goods.
 */
function deductibleGroupOf(row: VatBookRow): "interior" | "aib" | "importacion" {
  return row.regime === "aib" || row.regime === "importacion" ? row.regime : "interior";
}

/**
 * The 303 arithmetic from book rows (IVA only). `compensacionPendiente` is
 * the 4700 balance carried into the period (casilla 110). Pure.
 *
 * FIX-1 · F2 (B-4): rows carry `regime`. The ISP/AIB autofacturas leave the
 * rate boxes 01-09 (casillas 10/11 AIB, 12/13 ISP), the received AIB / import
 * quotas leave 28/29 (36/37 corrientes, 38/39 bienes de inversión, 32/33), the
 * received ISP quotas STAY in 28/29 (30/31) as the official form wants
 * (corrector, SEC-08; `isp.deducible` only informs) and the exento_no_sujeto
 * emitidas go to 120 without quota; 27 and 45 include the new boxes, so 46
 * and 71 are exactly what the same rows gave without a regime. Rows with
 * `regime` null are interior, as before F2.
 */
export function compute303(input: { rows: readonly VatBookRow[]; settings: Pick<VatSettingsDto, "prorrataPct" | "regime" | "taxFigure">; compensacionPendiente: Money }): Modelo303Computation {
  const avisos: string[] = [];
  const emitidas = input.rows.filter((row) => row.book === "emitidas");
  const recibidas = input.rows.filter((row) => row.book === "recibidas");
  const inversion = input.rows.filter((row) => row.book === "bienes_inversion");
  const aggregate = (rows: readonly VatBookRow[], cuota: (rows: readonly VatBookRow[]) => Money = (list) => round2(list.reduce((sum, row) => sum.plus(row.quota), ZERO))): RegimeAggregate => ({
    base: round2(rows.reduce((sum, row) => sum.plus(row.base), ZERO)),
    cuota: cuota(rows),
    filas: rows.length
  });

  // Not-subject rows (N1) have quota 0 and rate 0; S1 at 0 % are exempt or
  // misconfigured lines. Both are reported apart from the taxed rates unless
  // the regime says exento_no_sujeto (casilla 120).
  const emitidasInterior = emitidas.filter((row) => !isAutofactura(row));
  const devengado = bucketsByRate(emitidas, (row) => (row.rate.isZero() ? null : { rate: row.rate, base: row.base, cuota: row.quota }));
  const devengadoInterior = bucketsByRate(emitidasInterior, (row) => (row.rate.isZero() ? null : { rate: row.rate, base: row.base, cuota: row.quota }));
  const noSujetas = round2(emitidasInterior.filter((row) => row.rate.isZero() && row.regime !== "exento_no_sujeto").reduce((sum, row) => sum.plus(row.base), ZERO));
  const exentoNoSujeto = aggregate(emitidas.filter((row) => row.regime === "exento_no_sujeto"));
  const recargo = bucketsByRate(emitidas, (row) => (row.surchargeRate && row.surchargeQuota ? { rate: row.surchargeRate, base: row.base, cuota: row.surchargeQuota } : null));

  const deductibleRows = [...recibidas, ...inversion].filter((row) => row.deductible);
  const nonDeductible = [...recibidas, ...inversion].filter((row) => !row.deductible);
  const prorrata = input.settings.prorrataPct !== null && input.settings.prorrataPct < 100 ? new Prisma.Decimal(input.settings.prorrataPct).div(100) : null;
  const deductibleQuota = (rows: readonly VatBookRow[]): Money => {
    const raw = rows.reduce((sum, row) => sum.plus(row.quota), ZERO);
    return prorrata ? round2(raw.times(prorrata)) : round2(raw);
  };
  const corrienteRows = deductibleRows.filter((row) => row.book === "recibidas" && deductibleGroupOf(row) === "interior");
  const inversionRows = deductibleRows.filter((row) => row.book === "bienes_inversion" && deductibleGroupOf(row) === "interior");
  const deducibleCorriente = aggregate(corrienteRows, deductibleQuota);
  const deducibleInversion = aggregate(inversionRows, deductibleQuota);
  const isp = { devengado: aggregate(emitidas.filter((row) => row.regime === "isp")), deducible: aggregate(deductibleRows.filter((row) => row.regime === "isp"), deductibleQuota) };
  const aib = { devengado: aggregate(emitidas.filter((row) => row.regime === "aib")), deducible: aggregate(deductibleRows.filter((row) => row.book !== "bienes_inversion" && deductibleGroupOf(row) === "aib"), deductibleQuota) };
  const aibInversion = aggregate(deductibleRows.filter((row) => row.book === "bienes_inversion" && deductibleGroupOf(row) === "aib"), deductibleQuota);
  const importacion = aggregate(deductibleRows.filter((row) => deductibleGroupOf(row) === "importacion"), deductibleQuota);
  const noDeducible = { cuota: round2(nonDeductible.reduce((sum, row) => sum.plus(row.quota), ZERO)), filas: nonDeductible.length };

  const totalCuotaDevengada = round2(devengado.reduce((sum, bucket) => sum.plus(bucket.cuota), ZERO).plus(recargo.reduce((sum, bucket) => sum.plus(bucket.cuota), ZERO)));
  const totalCuotaDeducible = round2(deducibleCorriente.cuota.plus(deducibleInversion.cuota).plus(importacion.cuota).plus(aib.deducible.cuota).plus(aibInversion.cuota));
  const resultado46 = round2(totalCuotaDevengada.minus(totalCuotaDeducible));
  const resultado66 = resultado46; // 64 = 46 (no régimen simplificado), 65 = 100 %, 66 = 64
  const compensacionPendienteInicial = round2(input.compensacionPendiente);
  const compensacionAplicada = resultado66.greaterThan(0) ? Prisma.Decimal.min(compensacionPendienteInicial, resultado66) : ZERO;
  const resultado69 = round2(resultado66.minus(compensacionAplicada)); // + 77 (0) + 68 (0)
  const resultado71 = resultado69; // − 70 (0)
  const compensacionPendienteFinal = round2(compensacionPendienteInicial.minus(compensacionAplicada).plus(resultado71.lessThan(0) ? resultado71.abs() : ZERO));

  if (prorrata) avisos.push(`Prorrata general del ${input.settings.prorrataPct} % aplicada a las cuotas deducibles (casillas 29, 31, 33, 37 y 39).`);
  if (noDeducible.filas > 0) avisos.push(`${noDeducible.filas} fila(s) de recibidas con cuota no deducible (${noDeducible.cuota.toFixed(2)} €) excluidas de las casillas 28-39.`);
  if (!noSujetas.isZero()) avisos.push(`Operaciones al 0 % (exentas / no sujetas / sin tipo configurado) por ${noSujetas.toFixed(2)} € de base: sin casilla asignada, revisa su calificación antes de presentar.`);
  if (exentoNoSujeto.filas > 0) avisos.push(`${exentoNoSujeto.filas} fila(s) de emitidas exentas / no sujetas por reglas de localización (base ${exentoNoSujeto.base.toFixed(2)} €) en la casilla 120, sin cuota: confirmar con la gestoría si alguna corresponde a las casillas 59 (entregas intracomunitarias) o 60 (exportaciones).`);
  if (isp.deducible.filas > 0) avisos.push(`${isp.deducible.filas} fila(s) de recibidas con inversión del sujeto pasivo (cuota ${isp.deducible.cuota.toFixed(2)} €) deducidas en las casillas 28/29 (30/31 bienes de inversión), como el formulario oficial; su cuota devengada va en 12/13.`);
  if (input.settings.taxFigure !== "IVA") avisos.push(`La organización tributa por ${input.settings.taxFigure}: el Modelo 303 no aplica (IGIC → Modelo 420 ATC; IPSI → ordenanza local). Se muestran solo las filas IVA.`);

  const casillas: FiscalBox[] = [];
  const seen = new Set<string>();
  for (const map of MODELO_303_RATE_BOXES) {
    const bucket = devengadoInterior.find((entry) => rateKey(entry.rate) === map.rate);
    seen.add(map.rate);
    casillas.push(box(map.base, `DEV_BASE_${map.rate}`, `Base imponible al ${map.rate} %`, SECTION_DEVENGADO, bucket?.base ?? ZERO, "base"));
    casillas.push(box(map.tipo, `DEV_TIPO_${map.rate}`, "Tipo %", SECTION_DEVENGADO, new Prisma.Decimal(map.rate), "tipo"));
    casillas.push(box(map.cuota, `DEV_CUOTA_${map.rate}`, `Cuota devengada al ${map.rate} %`, SECTION_DEVENGADO, bucket?.cuota ?? ZERO, "cuota"));
  }
  for (const bucket of devengadoInterior) {
    const key = rateKey(bucket.rate);
    if (seen.has(key)) continue;
    avisos.push(`Tipo ${key} % sin casilla asignada en el Modelo 303 vigente: base ${bucket.base.toFixed(2)} €, cuota ${bucket.cuota.toFixed(2)} € (revisar antes de presentar).`);
    casillas.push(box(null, `DEV_BASE_${key}`, `Base imponible al ${key} % (sin casilla)`, SECTION_DEVENGADO, bucket.base, "base"));
    casillas.push(box(null, `DEV_CUOTA_${key}`, `Cuota devengada al ${key} % (sin casilla)`, SECTION_DEVENGADO, bucket.cuota, "cuota"));
  }
  casillas.push(box("10", "DEV_BASE_AIB", "Adquisiciones intracomunitarias de bienes y servicios: base", SECTION_DEVENGADO, aib.devengado.base, "base"));
  casillas.push(box("11", "DEV_CUOTA_AIB", "Adquisiciones intracomunitarias de bienes y servicios: cuota", SECTION_DEVENGADO, aib.devengado.cuota, "cuota"));
  casillas.push(box("12", "DEV_BASE_ISP", "Otras operaciones con inversión del sujeto pasivo (excepto adquisiciones intracomunitarias): base", SECTION_DEVENGADO, isp.devengado.base, "base"));
  casillas.push(box("13", "DEV_CUOTA_ISP", "Otras operaciones con inversión del sujeto pasivo (excepto adquisiciones intracomunitarias): cuota", SECTION_DEVENGADO, isp.devengado.cuota, "cuota"));
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
  casillas.push(box("32", "DED_BASE_IMPORTACION", "Por cuotas soportadas en las importaciones de bienes corrientes (DUA): base", SECTION_DEDUCIBLE, importacion.base, "base"));
  casillas.push(box("33", "DED_CUOTA_IMPORTACION", "Por cuotas soportadas en las importaciones de bienes corrientes (DUA): cuota", SECTION_DEDUCIBLE, importacion.cuota, "cuota"));
  casillas.push(box("36", "DED_BASE_AIB", "En adquisiciones intracomunitarias de bienes y servicios corrientes: base", SECTION_DEDUCIBLE, aib.deducible.base, "base"));
  casillas.push(box("37", "DED_CUOTA_AIB", "En adquisiciones intracomunitarias de bienes y servicios corrientes: cuota", SECTION_DEDUCIBLE, aib.deducible.cuota, "cuota"));
  casillas.push(box("38", "DED_BASE_AIB_INVERSION", "En adquisiciones intracomunitarias de bienes de inversión: base", SECTION_DEDUCIBLE, aibInversion.base, "base"));
  casillas.push(box("39", "DED_CUOTA_AIB_INVERSION", "En adquisiciones intracomunitarias de bienes de inversión: cuota", SECTION_DEDUCIBLE, aibInversion.cuota, "cuota"));
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
  casillas.push(box("120", "INFO_NO_SUJETAS_LOCALIZACION", "Operaciones no sujetas por reglas de localización o exentas (excepto las incluidas en la casilla 123)", SECTION_INFO, exentoNoSujeto.base, "info"));
  casillas.push(box("122", "INFO_SUJETAS_ISP", "Operaciones sujetas con inversión del sujeto pasivo (ventas)", SECTION_INFO, ZERO, "info"));
  casillas.push(box("123", "INFO_NO_SUJETAS_OSS", "Operaciones no sujetas por reglas de localización acogidas a la OSS", SECTION_INFO, ZERO, "info"));
  if (!noSujetas.isZero()) casillas.push(box(null, "INFO_OPERACIONES_0", "Operaciones al 0 % (exentas / no sujetas) — sin casilla asignada", SECTION_INFO, noSujetas, "info"));

  const baseDevengada = round2(devengado.reduce((sum, bucket) => sum.plus(bucket.base), ZERO));
  const totales: Record<string, number> = {
    baseDevengada: toWire(baseDevengada),
    cuotaDevengada: toWire(totalCuotaDevengada),
    baseDeducible: toWire(deducibleCorriente.base.plus(deducibleInversion.base).plus(importacion.base).plus(aib.deducible.base).plus(aibInversion.base)),
    cuotaDeducible: toWire(totalCuotaDeducible),
    resultadoRegimenGeneral: toWire(resultado46),
    compensacionPendienteInicial: toWire(compensacionPendienteInicial),
    compensacionAplicada: toWire(compensacionAplicada),
    compensacionPendienteFinal: toWire(compensacionPendienteFinal),
    resultado: toWire(resultado71),
    aIngresar: toWire(resultado71.greaterThan(0) ? resultado71 : ZERO),
    aCompensar: toWire(resultado71.lessThan(0) ? resultado71.abs() : ZERO),
    baseAutofacturasIspAib: toWire(isp.devengado.base.plus(aib.devengado.base)),
    cuotaIsp: toWire(isp.devengado.cuota),
    cuotaAib: toWire(aib.devengado.cuota),
    cuotaImportacion: toWire(importacion.cuota),
    cuotaIspDeducible: toWire(isp.deducible.cuota),
    cuotaAibInversion: toWire(aibInversion.cuota),
    baseExentoNoSujeto: toWire(exentoNoSujeto.base)
  };

  return {
    devengado,
    devengadoInterior,
    recargo,
    noSujetas,
    deducibleCorriente,
    deducibleInversion,
    noDeducible,
    isp,
    aib,
    aibInversion,
    importacion,
    exentoNoSujeto,
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
export type ResolvedSettlementPeriod = FiscalPeriodDto & {
  /** FIX-1 · F3 (E-02): a month asked to a quarterly sociedad with `allowMonthlyInformative` — computed as a view, never filed. */
  informativo?: true;
};

export function resolveSettlementPeriod(
  input: { period?: string; fromDate?: string; toDate?: string },
  periodicity?: "quarterly" | "monthly",
  regimen?: Pick<FiscalRegimeSummary, "periodicityForcedBy"> | null,
  options?: { allowMonthlyInformative?: boolean }
): ResolvedSettlementPeriod {
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
    if (periodicity === "quarterly" && periodo.type === "monthly" && options?.allowMonthlyInformative) return { ...periodo, informativo: true };
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

/** Journal statuses that take part in the cross-check: a reversed original keeps its VAT lines in its own period. */
export const LEDGER_CROSS_CHECK_STATUSES = ["posted", "reversed"] as const;
/** Year-end carry-over kinds: they close and reopen the 477x/472x (and 4750/4700) balances without accruing or settling anything. */
const CARRY_OVER_ENTRY_KINDS: ReadonlySet<string> = new Set(["closing", "opening"]);
/** OPERA shadow mode (Tanda 7b): daily revenue accrued on 477 from the PMS with no book row behind it. */
export const PMS_SHADOW_REVENUE_SOURCE_TYPE = "pms_shadow_revenue";
/** Sage 200 imported journal entries (Tanda 7c): only these are screened for the settlement pattern. */
export const SAGE_JOURNAL_SOURCE_TYPE = "sage200_journal";

export { SAGE_NO_CENTRE_AVISO };

/** FIX-1 · F3 (E-02): aviso of the monthly informative view of a quarterly sociedad. */
export const MONTHLY_INFORMATIVE_303_AVISO = "Vista mensual informativa: la sociedad liquida por trimestres; no presentable.";

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
 * 2026-Q2», «LIQUI IVA 1T») nets the quarter's quotas against the Treasury: it
 * is not a devengo. The rate is NOT the discriminator (the importer fills
 * `taxRateCode` from `tipo_iva`); the account pattern is. Pure — the SQL twin
 * is `SAGE_SETTLEMENT_PATTERN_SQL` below.
 */
export function isSageSettlementPattern(sourceType: string, accountCodes: readonly string[]): boolean {
  if (sourceType !== SAGE_JOURNAL_SOURCE_TYPE) return false;
  return accountCodes.some(isSettlementAccount) && accountCodes.some(isAccrualVatAccount);
}

/** SQL twin of `isSageSettlementPattern` over the lines of the entry aliased `je` (settlement AND accrual account present). */
const SAGE_SETTLEMENT_PATTERN_SQL = Prisma.sql`(
  EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = je.id AND (a.code LIKE '4750%' OR a.code LIKE '4700%'))
  AND EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = je.id AND (a.code LIKE '477%' OR a.code LIKE '472%'))
)`;

/**
 * FIX-1 · F3 (B-2): the opening balance to offset that VatSettings carries
 * into a period — `openingCompensation` when the period starts on or after
 * `openingCompensationPeriod`, 0 otherwise (or when no period is set). Pure.
 */
export function applyOpeningCompensation(settings: Pick<VatSettingsDto, "openingCompensation" | "openingCompensationPeriod">, from: string): Money {
  if (!settings.openingCompensationPeriod || !(settings.openingCompensation > 0)) return ZERO;
  let appliesFrom: string;
  try {
    appliesFrom = parseFiscalPeriod(settings.openingCompensationPeriod, ["quarterly", "monthly"]).from;
  } catch {
    return ZERO;
  }
  return from >= appliesFrom ? round2(new Prisma.Decimal(settings.openingCompensation)) : ZERO;
}

/**
 * Balance of 4700 carried into `from` (casilla 110): the opening balance of
 * the settings (`applyOpeningCompensation`) plus debit − credit on 4700x of
 * the non-reversed settlement entries dated before the period — the native
 * `vat_settlement` ones and the ones imported from Sage 200 (settlement
 * pattern; closing / opening entries excluded: they carry the balance over
 * without settling). ONE aggregated query; 0 when nothing was settled yet.
 * `settings` is loaded when the caller does not pass it (390).
 */
export async function pendingVatCompensation(organizationId: string, from: string, settings?: Pick<VatSettingsDto, "openingCompensation" | "openingCompensationPeriod">): Promise<Money> {
  const resolved = settings ?? (await getVatSettings(organizationId));
  const rows = await prisma.$queryRaw<Array<{ balance: Prisma.Decimal | string | null }>>(Prisma.sql`
    SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS balance
    FROM journal_entries je
    JOIN journal_lines jl ON jl.journal_entry_id = je.id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.organization_id = ${organizationId}
      AND je.status::text = 'posted'
      AND je.reversed_by_id IS NULL
      AND je.entry_date < ${from}::date
      AND je.entry_kind NOT IN ('closing', 'opening')
      AND a.code LIKE '4700%'
      AND (je.source_type = 'vat_settlement' OR (je.source_type = ${SAGE_JOURNAL_SOURCE_TYPE} AND ${SAGE_SETTLEMENT_PATTERN_SQL}))`);
  const ledger = money(rows[0]?.balance ?? 0);
  return round2(applyOpeningCompensation(resolved, from).plus(ledger));
}

// ── Casilla 110 encadenada (corrector FIX-1 · SEC-01) ───────────────────────

/** The settlement period right before `periodo` (same kind): 2026-Q1 → 2025-Q4, 2026-01 → 2025-12. Pure. */
export function previousFiscalPeriod(periodo: FiscalPeriodDto): FiscalPeriodDto {
  if (periodo.type === "monthly") {
    const month = periodo.month ?? 1;
    return month > 1 ? parseFiscalPeriod(`${periodo.year}-${String(month - 1).padStart(2, "0")}`, ["monthly"]) : parseFiscalPeriod(`${periodo.year - 1}-12`, ["monthly"]);
  }
  const quarter = periodo.quarter ?? 1;
  return quarter > 1 ? parseFiscalPeriod(`${periodo.year}-Q${quarter - 1}`, ["quarterly"]) : parseFiscalPeriod(`${periodo.year - 1}-Q4`, ["quarterly"]);
}

/** Periods walked back at most (5 years of months); beyond it the ledger balance is used and the 303 says so. */
export const COMPENSATION_CHAIN_MAX_DEPTH = 60;

/** What `resolveCarriedCompensation` needs; the DB flavour is `compensationChainDeps`, the tests inject memory. */
export type CompensationChainDeps = {
  settings: Pick<VatSettingsDto, "prorrataPct" | "regime" | "taxFigure" | "openingCompensation" | "openingCompensationPeriod">;
  /** true when the period has a settlement entry: native `vat_settlement` not reversed, or a Sage LIQUI dated inside it. */
  isSettled: (periodo: FiscalPeriodDto) => Promise<boolean>;
  /** 4700 balance + opening balance carried into `from` (`pendingVatCompensation`). */
  ledgerBalance: (from: string) => Promise<Money>;
  /** IVA book rows of a period (the same the period's own 303 reads). */
  rowsOf: (periodo: FiscalPeriodDto) => Promise<VatBookRow[]>;
  /** First day with book rows in the organisation (null = no books at all). */
  earliestBookDay: () => Promise<string | null>;
  maxDepth?: number;
};

export type CarriedCompensation = {
  /** Casilla 110 of the period. */
  compensacion: Money;
  /** Codes of the unsettled periods whose 303 was chained (oldest first); empty when the ledger balance was used as is. */
  encadenadaDesde: string[];
  /** true when the walk stopped at `maxDepth` (the ledger balance of that point was used). */
  truncada: boolean;
};

/**
 * Casilla 110 of `periodo`: the balance the ledger carries into it when the previous period is
 * settled (native entry or imported LIQUI), otherwise the `compensacionPendienteFinal` of the previous
 * period's 303 computed by ehotelOS — chained backwards until the last settled period, the opening
 * period of VatSettings (`openingCompensationPeriod`: its balance is the base there) or the first
 * period with book rows. Each unsettled period applies (78) or carries (87 + its negative result) once,
 * so two consecutive periods without a settlement entry never consume the same balance twice.
 */
export async function resolveCarriedCompensation(periodo: FiscalPeriodDto, deps: CompensationChainDeps): Promise<CarriedCompensation> {
  const maxDepth = deps.maxDepth ?? COMPENSATION_CHAIN_MAX_DEPTH;
  const earliest = await deps.earliestBookDay();
  let openingFrom: string | null = null;
  if (deps.settings.openingCompensationPeriod && deps.settings.openingCompensation > 0) {
    try {
      openingFrom = parseFiscalPeriod(deps.settings.openingCompensationPeriod, ["quarterly", "monthly"]).from;
    } catch {
      openingFrom = null;
    }
  }
  const chain: FiscalPeriodDto[] = [];
  let truncada = false;
  let current = periodo;
  for (;;) {
    const prev = previousFiscalPeriod(current);
    if (chain.length >= maxDepth) {
      truncada = true;
      break;
    }
    if (earliest === null || prev.to < earliest) break;
    if (openingFrom !== null && prev.from < openingFrom) break;
    if (await deps.isSettled(prev)) break;
    chain.push(prev);
    current = prev;
  }
  if (chain.length === 0) return { compensacion: await deps.ledgerBalance(periodo.from), encadenadaDesde: [], truncada };
  const oldestFirst = [...chain].reverse();
  let balance = await deps.ledgerBalance(oldestFirst[0]!.from);
  for (const unsettled of oldestFirst) {
    const rows = await deps.rowsOf(unsettled);
    balance = compute303({ rows, settings: deps.settings, compensacionPendiente: balance }).compensacionPendienteFinal;
  }
  return { compensacion: balance, encadenadaDesde: oldestFirst.map((entry) => entry.code), truncada };
}

/** Spanish aviso of a chained 110 (none → null). Pure. */
export function compensationChainAviso(encadenadaDesde: readonly string[]): string | null {
  if (encadenadaDesde.length === 0) return null;
  const n = encadenadaDesde.length;
  return `Casilla 110 encadenada desde el Modelo 303 de ${encadenadaDesde.join(", ")} calculado por ${BRAND.name} (${n === 1 ? "1 periodo sin asiento de liquidación" : `${n} periodos sin asiento de liquidación`}): la compensación aplicada allí ya se descuenta; asienta esas liquidaciones (POST /fiscal/vat-settlement) antes de presentar.`;
}

export const COMPENSATION_CHAIN_TRUNCATED_AVISO = `Casilla 110: la cadena de periodos sin asiento de liquidación supera ${COMPENSATION_CHAIN_MAX_DEPTH} periodos; se parte del saldo contable de 4700 en ese punto.`;

/** The DB-backed dependencies of `resolveCarriedCompensation` for an organisation (read-only). */
export function compensationChainDeps(organizationId: string, settings: VatSettingsDto): CompensationChainDeps {
  return {
    settings,
    isSettled: async (periodo) => {
      const native = await existingSettlement(organizationId, periodo.code);
      if (native && !native.reversed) return true;
      return (await historicalSettlements(organizationId, periodo)).length > 0;
    },
    ledgerBalance: (from) => pendingVatCompensation(organizationId, from, settings),
    rowsOf: async (periodo) => {
      const loaded = await loadVatBookRows({ organizationId, from: periodo.from, to: periodo.to, periodicity: settings.periodicity, taxFigure: settings.taxFigure });
      const rows = loaded.rows.filter((row) => row.taxFigure === "IVA");
      const superseded = await supersededRowsInMemory({ organizationId, periodo, rows, periodicity: settings.periodicity });
      return [...rows, ...superseded.rows.filter((row) => row.taxFigure === "IVA")];
    },
    earliestBookDay: async () => {
      const first = await prisma.vatBookEntry.findFirst({ where: { organizationId }, orderBy: { date: "asc" }, select: { date: true } });
      return first ? dateColumnDay(first.date) : null;
    }
  };
}

/**
 * FIX-1 · F3: the settlement entries imported from Sage 200 dated inside the
 * period (`fuentes.liquidacionesHistoricas`): id, number, date, concept and
 * `resultado` = Σ 4750 (haber − debe) − Σ 4700 debe (positive a ingresar,
 * negative a compensar). Historical: ehotelOS never posted them. Read-only.
 */
export async function historicalSettlements(organizationId: string, periodo: Pick<FiscalPeriodDto, "from" | "to">): Promise<FiscalHistoricalSettlementDto[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string; entry_number: number | null; fiscal_year_code: string | null; entry_date: string; description: string | null; acreedora: Prisma.Decimal | string; deudora: Prisma.Decimal | string }>>(Prisma.sql`
    SELECT je.id, je.entry_number, je.fiscal_year_code, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date, je.description,
           COALESCE(SUM(CASE WHEN a.code LIKE '4750%' THEN jl.credit - jl.debit ELSE 0 END), 0) AS acreedora,
           COALESCE(SUM(CASE WHEN a.code LIKE '4700%' THEN jl.debit ELSE 0 END), 0) AS deudora
    FROM journal_entries je
    JOIN journal_lines jl ON jl.journal_entry_id = je.id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.organization_id = ${organizationId}
      AND je.source_type = ${SAGE_JOURNAL_SOURCE_TYPE}
      AND je.status::text = 'posted'
      AND je.reversed_by_id IS NULL
      AND je.entry_kind NOT IN ('closing', 'opening')
      AND je.entry_date >= ${periodo.from}::date AND je.entry_date <= ${periodo.to}::date
      AND ${SAGE_SETTLEMENT_PATTERN_SQL}
    GROUP BY je.id, je.entry_number, je.fiscal_year_code, je.entry_date, je.description
    ORDER BY je.entry_date ASC, je.entry_number ASC NULLS LAST, je.id ASC`);
  return rows.map((row) => ({
    journalEntryId: row.id,
    entryNumber: row.entry_number === null ? null : Number(row.entry_number),
    fiscalYearCode: row.fiscal_year_code,
    entryDate: row.entry_date,
    description: row.description,
    resultado: toWire(money(row.acreedora).minus(money(row.deudora)))
  }));
}

/** Spanish aviso naming the imported settlements of the period (none → null). Pure. */
export function historicalSettlementsAviso(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? `1 liquidación importada de Sage en el periodo (histórica, no contabilizada por ${BRAND.name}).`
    : `${count} liquidaciones importadas de Sage en el periodo (históricas, no contabilizadas por ${BRAND.name}).`;
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

/** Rate text of an aggregated ledger row («21», «10.00», «7,5») → Decimal, or null when it is not a number. Pure. */
export function ledgerRateOf(raw: string | null): Money | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(text) ? new Prisma.Decimal(text) : null;
}

type CrossCheckSumRow = { lado: "repercutido" | "soportado"; rate_source: "code" | "account" | "description" | "none"; rate_raw: string | null; apuntes: number; debit: Prisma.Decimal | string; credit: Prisma.Decimal | string };
type CrossCheckExcludedRow = { nature: "liquidacion" | "cierreApertura" | "pmsSombra" | "liquidacionSage"; entries: number };

/**
 * The CTE both cross-check queries share: the period's `posted` / `reversed`
 * entries with the NATURE that decides their exclusion — their own
 * `sourceType` / `entryKind`, or the reversed target's for a reversal (the
 * target may be dated outside the period, hence the self join). `devengo` =
 * takes part; the four other natures are the exclusions named in `avisos`.
 */
function crossCheckScopeSql(input: { organizationId: string; from: string; to: string; propertyId?: string | null }): Prisma.Sql {
  return Prisma.sql`
    scoped AS (
      SELECT je.id,
             COALESCE(t.source_type, je.source_type) AS nature_source_type,
             COALESCE(t.entry_kind, je.entry_kind) AS nature_entry_kind
      FROM journal_entries je
      LEFT JOIN journal_entries t ON t.id = je.reversal_of_id
      WHERE je.organization_id = ${input.organizationId}
        AND je.status::text IN (${Prisma.join([...LEDGER_CROSS_CHECK_STATUSES])})
        AND je.entry_date >= ${input.from}::date AND je.entry_date <= ${input.to}::date
        ${input.propertyId ? Prisma.sql`AND je.property_id = ${input.propertyId}` : Prisma.empty}
    ),
    classified AS (
      SELECT s.id,
             CASE
               WHEN s.nature_source_type = 'vat_settlement' THEN 'liquidacion'
               WHEN s.nature_entry_kind IN ('closing', 'opening') THEN 'cierreApertura'
               WHEN s.nature_source_type = ${PMS_SHADOW_REVENUE_SOURCE_TYPE} THEN 'pmsSombra'
               WHEN s.nature_source_type = ${SAGE_JOURNAL_SOURCE_TYPE}
                    AND EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = s.id AND (a.code LIKE '4750%' OR a.code LIKE '4700%'))
                    AND EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = s.id AND (a.code LIKE '477%' OR a.code LIKE '472%'))
                 THEN 'liquidacionSage'
               ELSE 'devengo'
             END AS nature
      FROM scoped s
    )`;
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
 *
 * FIX-1 · F3 (B-5): aggregated in the database — one query sums debit /
 * credit and counts the lines by side (477 → repercutido, 472 → soportado)
 * and rate (`tax_rate_code`, else the sub-account suffix `477.21` → 21, else
 * a «21 %» in the description; `guessed` = the rate did not come from
 * `tax_rate_code`), a second one counts the excluded entries by nature. No
 * `findMany`, no bound: the whole period is read whatever its size.
 */
export async function ledgerCrossCheck(input: { organizationId: string; periodo: FiscalPeriodDto; propertyId?: string | null; computation: Modelo303Computation }): Promise<{ check: FiscalLedgerCrossCheck; avisos: string[] }> {
  const avisos: string[] = [];
  const scope = crossCheckScopeSql({ organizationId: input.organizationId, from: input.periodo.from, to: input.periodo.to, propertyId: input.propertyId });
  const [sums, excludedRows] = await Promise.all([
    prisma.$queryRaw<CrossCheckSumRow[]>(Prisma.sql`
      WITH ${scope}
      SELECT CASE WHEN a.code LIKE '477%' THEN 'repercutido' ELSE 'soportado' END AS lado,
             CASE WHEN jl.tax_rate_code ~ '^[0-9]+([.][0-9]+)?$' THEN 'code'
                  WHEN split_part(a.code, '.', 2) ~ '^[0-9]+$' THEN 'account'
                  WHEN jl.description ~ '[0-9]+([.,][0-9]+)?[[:space:]]*%' THEN 'description'
                  ELSE 'none' END AS rate_source,
             CASE WHEN jl.tax_rate_code ~ '^[0-9]+([.][0-9]+)?$' THEN jl.tax_rate_code
                  WHEN split_part(a.code, '.', 2) ~ '^[0-9]+$' THEN split_part(a.code, '.', 2)
                  ELSE substring(jl.description from '([0-9]+([.,][0-9]+)?)[[:space:]]*%') END AS rate_raw,
             COUNT(*)::int AS apuntes,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM classified c
      JOIN journal_lines jl ON jl.journal_entry_id = c.id
      JOIN accounts a ON a.id = jl.account_id
      WHERE c.nature = 'devengo' AND (a.code LIKE '477%' OR a.code LIKE '472%')
      GROUP BY 1, 2, 3`),
    prisma.$queryRaw<CrossCheckExcludedRow[]>(Prisma.sql`
      WITH ${scope}
      SELECT nature, COUNT(*)::int AS entries FROM classified WHERE nature <> 'devengo' GROUP BY nature`)
  ]);
  const excluded = { liquidacion: 0, cierreApertura: 0, pmsSombra: 0, liquidacionSage: 0 };
  for (const row of excludedRows) excluded[row.nature] = Number(row.entries);
  const repercutido = new Map<string, Money>();
  const soportado = new Map<string, Money>();
  let guessed = 0;
  let apuntes = 0;
  for (const row of sums) {
    const count = Number(row.apuntes);
    apuntes += count;
    // Corrector FIX-1 (F3-GUESSED-AVISO-NOISE): the sub-account suffix (477.21 → 21) is deterministic and not
    // «guessed»; only the description-derived (or absent) rate deserves the aviso, as before F3.
    if (row.rate_source === "description" || row.rate_source === "none") guessed += count;
    const rate = ledgerRateOf(row.rate_raw);
    const key = rate ? rate.toFixed(2) : "?";
    const debit = money(row.debit);
    const credit = money(row.credit);
    if (row.lado === "repercutido") {
      repercutido.set(key, (repercutido.get(key) ?? ZERO).plus(credit).minus(debit));
    } else {
      soportado.set(key, (soportado.get(key) ?? ZERO).plus(debit).minus(credit));
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
  if (apuntes === 0) {
    avisos.push("El diario no tiene apuntes de IVA (477x/472x) en el periodo: las facturas aún no asientan, el 303 se calcula exclusivamente desde los libros.");
  } else if (diferencias.length > 0) {
    avisos.push(`Los libros de IVA y el diario difieren en ${diferencias.length} tipo(s) (ver fuentes.diario.diferencias): revisa los asientos antes de liquidar.`);
  }
  if (guessed > 0) avisos.push(`${guessed} apunte(s) de IVA heredados sin tipo (taxRateCode) ni subcuenta por tipo — tipo deducido de la descripción (o sin tipo) solo para el cotejo.`);
  avisos.push(...crossCheckExclusionAvisos(excluded));
  return {
    check: { apuntes, cuotaRepercutida: toWire(cuotaRepercutida), cuotaSoportada: toWire(cuotaSoportada), diferencias, cuadra: diferencias.length === 0 },
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
  /** Corrector FIX-1 (SEC-01): unsettled periods whose 303 fed casilla 110 (oldest first); empty when the ledger balance was used. */
  compensacionEncadenadaDesde: string[];
};

/**
 * Build the 303 of a period without permission checks (callers check). Read-only.
 * `informativo` (FIX-1 · F3, E-02): monthly view of a quarterly sociedad — no
 * compensation (110/78 = 0), no settlement lookup, flagged in `fuentes` and `avisos`.
 */
export async function modelo303ForPeriod(input: { organizationId: string; periodo: FiscalPeriodDto; settings: VatSettingsDto; propertyId?: string | null; crossCheck?: boolean; informativo?: boolean }): Promise<Modelo303ForPeriod> {
  const loaded = await loadVatBookRows({ organizationId: input.organizationId, from: input.periodo.from, to: input.periodo.to, propertyId: input.propertyId, periodicity: input.settings.periodicity, taxFigure: input.settings.taxFigure });
  const avisos: string[] = [...loaded.avisos];
  const ivaRows = loaded.rows.filter((row) => row.taxFigure === "IVA");
  const otherFigures = loaded.rows.length - ivaRows.length;
  if (otherFigures > 0) avisos.push(`${otherFigures} fila(s) con IGIC/IPSI excluidas del Modelo 303.`);
  // FIX-1 · F3 (E-03): a centre breakdown over a Sage period is empty because the imported rows carry no centre.
  if (input.propertyId && ivaRows.length === 0 && (await countSageRowsWithoutCentre(input.organizationId, input.periodo.from, input.periodo.to)) > 0) avisos.push(SAGE_NO_CENTRE_AVISO);
  // Corrector L3 (DS-06): counter the originals replaced by a rectificativa «S» whose #sustituida rows the book lacks.
  const superseded = await supersededRowsInMemory({ organizationId: input.organizationId, periodo: input.periodo, rows: ivaRows, periodicity: input.settings.periodicity });
  ivaRows.push(...superseded.rows.filter((row) => row.taxFigure === "IVA"));
  avisos.push(...superseded.avisos);
  const informativo = input.informativo === true;
  // Corrector FIX-1 (SEC-01): 110 chained through the unsettled periods, ledger balance when the previous one is settled.
  const carried = input.propertyId || informativo ? null : await resolveCarriedCompensation(input.periodo, compensationChainDeps(input.organizationId, input.settings));
  const computation = compute303({ rows: ivaRows, settings: input.settings, compensacionPendiente: carried?.compensacion ?? ZERO });
  avisos.push(...computation.avisos);
  const chainAviso = compensationChainAviso(carried?.encadenadaDesde ?? []);
  if (chainAviso) avisos.push(chainAviso);
  if (carried?.truncada) avisos.push(COMPENSATION_CHAIN_TRUNCATED_AVISO);
  avisos.push(...regimeAvisos(input.settings.sociedad.regimen, "303"));
  if (informativo) avisos.push(MONTHLY_INFORMATIVE_303_AVISO);
  if (input.propertyId) avisos.push(PARTIAL_VIEW_303_AVISO);
  let diario: FiscalLedgerCrossCheck | undefined;
  if (input.crossCheck !== false) {
    const cross = await ledgerCrossCheck({ organizationId: input.organizationId, periodo: input.periodo, propertyId: input.propertyId, computation });
    diario = cross.check;
    avisos.push(...cross.avisos);
  }
  const liquidacion = informativo ? undefined : input.propertyId ? null : await existingSettlement(input.organizationId, input.periodo.code);
  if (liquidacion && !liquidacion.reversed) avisos.push(`Periodo liquidado: asiento ${liquidacion.entryNumber ?? liquidacion.journalEntryId} del ${liquidacion.entryDate}.`);
  // FIX-1 · F3: the settlement entries imported from Sage 200 inside the period (shown as history, never posted here).
  const liquidacionesHistoricas = input.propertyId ? [] : await historicalSettlements(input.organizationId, input.periodo);
  const historicalAviso = historicalSettlementsAviso(liquidacionesHistoricas.length);
  if (historicalAviso) avisos.push(historicalAviso);
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
      ...(liquidacion !== undefined ? { liquidacion } : {}),
      liquidacionesHistoricas,
      ...(informativo ? { informativo: true } : {}),
      registros: ivaRows.length
    },
    detalle: [],
    presentacion: { modo: "manual", ficheroOficial: false, nota: PRESENTACION_MANUAL_NOTA },
    generatedAt: new Date().toISOString()
  };
  return { report, computation, settings: input.settings, rows: ivaRows, compensacionEncadenadaDesde: carried?.encadenadaDesde ?? [] };
}

/**
 * Public entry point (route + legacy server.ts handler). Accepts `period` or
 * the legacy `fromDate`/`toDate` (natural quarter/month). `periodType` is
 * accepted for compatibility and ignored: the periodicity is the
 * organisation's VatSettings.
 */
export async function buildModelo303(input: { context: UserContext; propertyId?: string | null; period?: string; fromDate?: string; toDate?: string; periodType?: "monthly" | "quarterly"; informativo?: boolean }): Promise<FiscalModelReport> {
  requirePermissions(input.context, ["accounting.read"]);
  // R11 (service level, so the legacy /accounting/reports/modelo-* handlers are covered too).
  assertFinanceReadScope(input.context, input.propertyId ?? null);
  const settings = await getVatSettings(input.context.organizationId);
  // `settings.periodicity` is the effective one (monthly under SII / gran empresa, R8); `informativo=1` lets a
  // quarterly sociedad read a month as a view (FIX-1 · F3, E-02).
  const { informativo, ...periodo } = resolveSettlementPeriod(input, settings.periodicity, settings.sociedad.regimen, { allowMonthlyInformative: input.informativo === true });
  const result = await modelo303ForPeriod({ organizationId: input.context.organizationId, periodo, settings, propertyId: input.propertyId ?? null, informativo: informativo === true });
  return result.report;
}
