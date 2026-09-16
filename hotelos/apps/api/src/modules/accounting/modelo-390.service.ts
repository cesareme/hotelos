// Finanzas · lote «iva-modelos» — Modelo 390 (resumen anual del IVA).
//
// Aggregates the settlement periods of the year (4 quarters or 12 months per
// VatSettings) from the VAT books: IVA devengado by rate, IVA deducible
// (corriente / bienes de inversión), the result of every period (casilla 71 of
// its 303), the compensation carried at year end and the volume of
// operations. Box numbering: the official 390 layout is NOT asserted here —
// every box carries `casilla: null` and a stable `clave`, and the report says
// so in `avisos` («validar la numeración con la gestoría»). Nothing invented.
// Read-only.

import { Prisma } from "@prisma/client";
import type { FiscalBox, FiscalDeclaranteBadge, FiscalModelReport, FiscalPeriodDto, FiscalRegimeProposal, FiscalRegimeReport, VatBookName, VatSettingsDto } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireYear } from "../../lib/query-dates.js";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";
import { PRESENTACION_MANUAL_NOTA, compute303, existingSettlement, pendingVatCompensation, type Modelo303Computation } from "./modelo-303.service.js";
import {
  LARGE_COMPANY_THRESHOLD,
  ZERO,
  annualPeriod,
  declarantePair,
  getVatSettings,
  loadVatBookRows,
  periodsOfYear,
  regimeAvisos,
  round2,
  siiModelNotFiledMotivo,
  summarizeVatRows,
  toWire,
  type Money,
  type VatBookRow
} from "./vat-books.service.js";

export const MODELO_390_TITLE = "Modelo 390 · Impuesto sobre el Valor Añadido · Declaración-resumen anual";

const SECTION_DEVENGADO = "Operaciones en régimen general · IVA devengado";
const SECTION_DEDUCIBLE = "Operaciones en régimen general · IVA deducible";
const SECTION_RESULTADO = "Resultado de las liquidaciones";
const SECTION_VOLUMEN = "Volumen de operaciones";

export const MODELO_390_NUMBERING_AVISO =
  "Modelo 390: numeración de casillas pendiente de validar con la gestoría (se presentan claves y descripciones del formulario, no números de casilla).";

function box(clave: string, descripcion: string, seccion: string, importe: Money, tipo: FiscalBox["tipo"]): FiscalBox {
  return { casilla: null, clave, descripcion, seccion, importe: toWire(importe), tipo };
}

function rateKey(rate: Money): string {
  return rate.toFixed(2).replace(/\.?0+$/, "") || "0";
}

export type Modelo390PeriodResult = {
  periodo: FiscalPeriodDto;
  computation: Modelo303Computation;
  liquidado: boolean;
};

/** Pure aggregation of the per-period 303 computations into the annual boxes. */
export function aggregate390(input: { year: number; periods: readonly Modelo390PeriodResult[]; rows: readonly VatBookRow[] }): { casillas: FiscalBox[]; totales: Record<string, number>; avisos: string[] } {
  const avisos: string[] = [MODELO_390_NUMBERING_AVISO];
  const devengado = new Map<string, { rate: Money; base: Money; cuota: Money }>();
  let baseCorriente = ZERO;
  let cuotaCorriente = ZERO;
  let baseInversion = ZERO;
  let cuotaInversion = ZERO;
  let resultadoLiquidaciones = ZERO;
  let noSujetas = ZERO;
  for (const period of input.periods) {
    for (const bucket of period.computation.devengado) {
      const key = bucket.rate.toFixed(2);
      const existing = devengado.get(key) ?? { rate: bucket.rate, base: ZERO, cuota: ZERO };
      existing.base = existing.base.plus(bucket.base);
      existing.cuota = existing.cuota.plus(bucket.cuota);
      devengado.set(key, existing);
    }
    baseCorriente = baseCorriente.plus(period.computation.deducibleCorriente.base);
    cuotaCorriente = cuotaCorriente.plus(period.computation.deducibleCorriente.cuota);
    baseInversion = baseInversion.plus(period.computation.deducibleInversion.base);
    cuotaInversion = cuotaInversion.plus(period.computation.deducibleInversion.cuota);
    resultadoLiquidaciones = resultadoLiquidaciones.plus(period.computation.resultado71);
    noSujetas = noSujetas.plus(period.computation.noSujetas);
  }
  const casillas: FiscalBox[] = [];
  let totalBase = ZERO;
  let totalCuota = ZERO;
  for (const bucket of Array.from(devengado.values()).sort((a, b) => b.rate.comparedTo(a.rate))) {
    const key = rateKey(bucket.rate);
    casillas.push(box(`DEV_BASE_${key}`, `Régimen ordinario · base imponible al ${key} %`, SECTION_DEVENGADO, bucket.base, "base"));
    casillas.push(box(`DEV_CUOTA_${key}`, `Régimen ordinario · cuota devengada al ${key} %`, SECTION_DEVENGADO, bucket.cuota, "cuota"));
    totalBase = totalBase.plus(bucket.base);
    totalCuota = totalCuota.plus(bucket.cuota);
  }
  casillas.push(box("DEV_TOTAL_BASE", "Total bases IVA", SECTION_DEVENGADO, totalBase, "base"));
  casillas.push(box("DEV_TOTAL_CUOTA", "Total cuotas IVA devengadas", SECTION_DEVENGADO, totalCuota, "cuota"));
  casillas.push(box("DED_BASE_CORRIENTE", "Operaciones interiores corrientes · base", SECTION_DEDUCIBLE, baseCorriente, "base"));
  casillas.push(box("DED_CUOTA_CORRIENTE", "Operaciones interiores corrientes · cuota deducible", SECTION_DEDUCIBLE, cuotaCorriente, "cuota"));
  casillas.push(box("DED_BASE_INVERSION", "Operaciones interiores con bienes de inversión · base", SECTION_DEDUCIBLE, baseInversion, "base"));
  casillas.push(box("DED_CUOTA_INVERSION", "Operaciones interiores con bienes de inversión · cuota deducible", SECTION_DEDUCIBLE, cuotaInversion, "cuota"));
  const totalDeducible = round2(cuotaCorriente.plus(cuotaInversion));
  casillas.push(box("DED_TOTAL", "Total IVA deducible", SECTION_DEDUCIBLE, totalDeducible, "cuota"));
  const resultadoRegimenGeneral = round2(totalCuota.minus(totalDeducible));
  casillas.push(box("RESULTADO_REGIMEN_GENERAL", "Resultado régimen general (devengado − deducible)", SECTION_RESULTADO, resultadoRegimenGeneral, "resultado"));
  casillas.push(box("RESULTADO_LIQUIDACIONES", "Suma de resultados de las autoliquidaciones del ejercicio (casilla 71 de cada 303)", SECTION_RESULTADO, round2(resultadoLiquidaciones), "resultado"));
  const last = input.periods[input.periods.length - 1];
  const pendienteFin = last ? last.computation.compensacionPendienteFinal : ZERO;
  casillas.push(box("COMPENSACION_PENDIENTE_FIN", "Cuotas pendientes de compensación al término del ejercicio", SECTION_RESULTADO, pendienteFin, "cuota"));
  const volumen = round2(totalBase.plus(noSujetas));
  casillas.push(box("VOLUMEN_OPERACIONES", "Volumen de operaciones (bases, incluidas las operaciones al 0 %)", SECTION_VOLUMEN, volumen, "info"));
  if (!noSujetas.isZero()) casillas.push(box("OPERACIONES_0", "Operaciones al 0 % (exentas / no sujetas) incluidas en el volumen", SECTION_VOLUMEN, round2(noSujetas), "info"));
  const liquidados = input.periods.filter((period) => period.liquidado).length;
  if (liquidados < input.periods.length) {
    avisos.push(`${input.periods.length - liquidados} de ${input.periods.length} periodos del ejercicio ${input.year} sin asiento de liquidación (POST /fiscal/vat-settlement).`);
  }
  return {
    casillas,
    totales: {
      baseDevengada: toWire(totalBase),
      cuotaDevengada: toWire(totalCuota),
      baseDeducible: toWire(baseCorriente.plus(baseInversion)),
      cuotaDeducible: toWire(totalDeducible),
      resultadoRegimenGeneral: toWire(resultadoRegimenGeneral),
      resultadoLiquidaciones: toWire(resultadoLiquidaciones),
      compensacionPendienteFin: toWire(pendienteFin),
      volumenOperaciones: toWire(volumen),
      periodos: input.periods.length,
      periodosLiquidados: liquidados
    },
    avisos
  };
}

/** Per-period results of a year from ONE load of the books (no ledger cross-check per period). */
export async function modelo303PeriodsOfYear(input: { organizationId: string; year: number; settings: VatSettingsDto; propertyId?: string | null }): Promise<{ periods: Modelo390PeriodResult[]; rows: VatBookRow[]; avisos: string[]; origen: "libros" | "documentos" }> {
  const year = annualPeriod(input.year);
  const loaded = await loadVatBookRows({ organizationId: input.organizationId, from: year.from, to: year.to, propertyId: input.propertyId, periodicity: input.settings.periodicity, taxFigure: input.settings.taxFigure });
  const rows = loaded.rows.filter((row) => row.taxFigure === "IVA");
  const periods: Modelo390PeriodResult[] = [];
  for (const periodo of periodsOfYear(input.year, input.settings.periodicity)) {
    const periodRows = rows.filter((row) => row.date >= periodo.from && row.date <= periodo.to);
    const compensacion = input.propertyId ? ZERO : await pendingVatCompensation(input.organizationId, periodo.from);
    const computation = compute303({ rows: periodRows, settings: input.settings, compensacionPendiente: compensacion });
    const settlement = input.propertyId ? null : await existingSettlement(input.organizationId, periodo.code);
    periods.push({ periodo, computation, liquidado: Boolean(settlement && !settlement.reversed) });
  }
  const anyDerived = (Object.values(loaded.origen) as Array<"libros" | "documentos">).some((origen) => origen === "documentos");
  return { periods, rows, avisos: loaded.avisos, origen: anyDerived ? "documentos" : "libros" };
}

export async function buildModelo390(input: { context: UserContext; propertyId?: string | null; year: number }): Promise<FiscalModelReport> {
  requirePermissions(input.context, ["accounting.read"]);
  assertFinanceReadScope(input.context, input.propertyId ?? null);
  const year = requireYear(input.year);
  const organizationId = input.context.organizationId;
  const settings = await getVatSettings(organizationId);
  const loaded = await modelo303PeriodsOfYear({ organizationId, year, settings, propertyId: input.propertyId ?? null });
  const aggregated = aggregate390({ year, periods: loaded.periods, rows: loaded.rows });
  const regimen = settings.sociedad.regimen;
  const noSePresenta = regimen.modelosNoPresentados.includes("390") ? { motivo: siiModelNotFiledMotivo("390") } : undefined;
  const avisos = Array.from(new Set([...(noSePresenta ? [noSePresenta.motivo] : []), ...aggregated.avisos, ...loaded.avisos, ...loaded.periods.flatMap((period) => period.computation.avisos), ...regimeAvisos(regimen, "390")]));
  if (input.propertyId) avisos.push("Vista parcial por establecimiento (no liquidable): el Modelo 390 se presenta por NIF de la sociedad.");
  const summary = (book: VatBookName) => summarizeVatRows(loaded.rows.filter((row) => row.book === book));
  return {
    modelo: "390",
    titulo: MODELO_390_TITLE,
    organizationId,
    propertyId: input.propertyId ?? null,
    periodo: annualPeriod(year),
    declarante: declarantePair(settings.sociedad),
    sociedad: settings.sociedad,
    casillas: aggregated.casillas,
    totales: aggregated.totales,
    avisos,
    fuentes: {
      origen: "modelos_303",
      libros: { emitidas: summary("emitidas"), recibidas: summary("recibidas"), bienes_inversion: summary("bienes_inversion") },
      periodos: loaded.periods.map((period) => ({ periodo: period.periodo.code, resultado: toWire(period.computation.resultado71) })),
      registros: loaded.rows.length
    },
    detalle: loaded.periods.map((period) => ({
      periodo: period.periodo.code,
      periodoAeat: period.periodo.aeatPeriod,
      baseDevengada: period.computation.totales.baseDevengada ?? 0,
      cuotaDevengada: toWire(period.computation.totalCuotaDevengada),
      cuotaDeducible: toWire(period.computation.totalCuotaDeducible),
      resultado: toWire(period.computation.resultado71),
      liquidado: period.liquidado ? "sí" : "no"
    })),
    presentacion: { modo: "manual", ficheroOficial: false, nota: PRESENTACION_MANUAL_NOTA, ...(noSePresenta ? { noSePresenta } : {}) },
    generatedAt: new Date().toISOString()
  };
}

// ── Régimen: propuesta al cierre del ejercicio (Tanda 6b · R8) ──────────────

const EUR = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Pure (RIVA art. 71.3): the volumen de operaciones of a year above
 * 6.010.121,04 € makes the sujeto pasivo «gran empresa» from the following
 * year (303/111/115 monthly, SII compulsory — which exonerates 347/390 and
 * excludes VeriFactu). The proposal compares the figure with the flags of the
 * legal entity and NEVER writes: the change is confirmed in Estructura
 * societaria › Datos fiscales. `volumen = null` (empty books) proposes nothing.
 * The fiscal-year close (L4) calls this to show the proposal in its preview.
 */
export function proposeRegime(input: { year: number; volumen: Money | null; sociedad: Pick<FiscalDeclaranteBadge, "regimen"> }): FiscalRegimeProposal {
  const current: FiscalRegimeProposal["regimen"] = input.sociedad.regimen.largeCompany || input.sociedad.regimen.siiEnabled ? "gran_empresa" : "general";
  const threshold = `${EUR.format(toWire(LARGE_COMPANY_THRESHOLD))} €`;
  if (input.volumen === null) {
    return { regimen: current, cambia: false, motivo: `Sin operaciones registradas en ${input.year}: no hay base para proponer un cambio de régimen (umbral de gran empresa ${threshold}, RIVA art. 71.3).` };
  }
  const volumen = `${EUR.format(toWire(input.volumen))} €`;
  const exceeds = input.volumen.greaterThan(LARGE_COMPANY_THRESHOLD);
  if (exceeds && current === "general") {
    return {
      regimen: "gran_empresa",
      cambia: true,
      motivo: `Volumen de operaciones ${input.year}: ${volumen} > ${threshold} (RIVA art. 71.3). Desde el 1 de enero de ${input.year + 1} la sociedad es gran empresa: Modelos 303/111/115 mensuales, SII obligatorio (exonera 347 y 390) y fuera del RRSIF (VeriFactu no aplica, RD 1007/2023 art. 3.3). Confirmar con la gestoría y marcar «Gran empresa / SII» en Estructura societaria › Datos fiscales.`
    };
  }
  if (!exceeds && current === "gran_empresa") {
    return {
      regimen: "general",
      cambia: true,
      motivo: `Volumen de operaciones ${input.year}: ${volumen} ≤ ${threshold} (RIVA art. 71.3). La sociedad está marcada como gran empresa / SII: revisar con la gestoría si mantiene el régimen (mensual, SII) o vuelve al régimen general desde el 1 de enero de ${input.year + 1}.`
    };
  }
  return {
    regimen: current,
    cambia: false,
    motivo: exceeds
      ? `Volumen de operaciones ${input.year}: ${volumen} > ${threshold}: la sociedad ya tributa como gran empresa (mensual${input.sociedad.regimen.siiEnabled ? ", SII" : ""}).`
      : `Volumen de operaciones ${input.year}: ${volumen} ≤ ${threshold}: la sociedad sigue en régimen general (${input.sociedad.regimen.persistedPeriodicity === "monthly" ? "mensual" : "trimestral"}).`
  };
}

/**
 * `GET /fiscal/regime?year=`: the sociedad's regime (R8) and the proposal for
 * the following year from the volumen de operaciones of the 390. Read-only.
 */
export async function buildFiscalRegimeReport(input: { context: UserContext; year: number }): Promise<FiscalRegimeReport> {
  requirePermissions(input.context, ["accounting.read"]);
  // The volumen de operaciones is a whole-sociedad amount (R11).
  assertFinanceReadScope(input.context, null);
  const year = requireYear(input.year);
  const organizationId = input.context.organizationId;
  const settings = await getVatSettings(organizationId);
  const loaded = await modelo303PeriodsOfYear({ organizationId, year, settings, propertyId: null });
  const aggregated = aggregate390({ year, periods: loaded.periods, rows: loaded.rows });
  const volumen = loaded.rows.length === 0 ? null : new Prisma.Decimal(aggregated.totales.volumenOperaciones ?? 0);
  const propuesta = proposeRegime({ year, volumen, sociedad: settings.sociedad });
  const avisos = [...regimeAvisos(settings.sociedad.regimen, "303"), ...loaded.avisos];
  if (settings.sociedad.source === "organization_fallback") avisos.push("Sociedad pendiente de alta (sin backfill de estructura societaria): el régimen se lee de los valores por defecto.");
  return {
    organizationId,
    year,
    sociedad: settings.sociedad,
    vatSettings: settings,
    volumenOperaciones: volumen === null ? null : toWire(volumen),
    umbralGranEmpresa: toWire(LARGE_COMPANY_THRESHOLD),
    propuesta,
    avisos: Array.from(new Set(avisos)),
    generatedAt: new Date().toISOString()
  };
}
