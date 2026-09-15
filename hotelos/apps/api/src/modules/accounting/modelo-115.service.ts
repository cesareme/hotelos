// Finanzas · lote «iva-modelos» — Modelo 115 (retenciones e ingresos a cuenta
// sobre rentas procedentes del arrendamiento de inmuebles urbanos).
//
// Source: `WithholdingTaxRecord` rows whose rowCode starts with "L" (L01 =
// arrendamientos / subarrendamientos de inmuebles urbanos; the prefix keeps
// them apart from the 111 rows 01-05). Boxes of the form:
//   01 número de perceptores · 02 base de las retenciones e ingresos a cuenta ·
//   03 retenciones e ingresos a cuenta · 04 resultados a ingresar de anteriores
//   autoliquidaciones · 05 resultado a ingresar (03 − 04).
// Decimal arithmetic. Read-only.

import type { FiscalBox, FiscalModelReport, FiscalPeriodDto } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { PRESENTACION_MANUAL_NOTA, declaranteOf, resolveSettlementPeriod } from "./modelo-303.service.js";
import { MODELO_115_ROW_PREFIX, loadWithholdingRecords, type WithholdingRecordForModel } from "./modelo-111.service.js";
import { ZERO, money, round2, toWire, type Money } from "./vat-books.service.js";

export { MODELO_115_ROW_PREFIX };

export const MODELO_115_TITLE = "Modelo 115 · Retenciones e ingresos a cuenta · Rentas de arrendamiento de inmuebles urbanos";

export const MODELO_115_ROW_CODES = ["L01"] as const;

const ROW_DEFINITIONS: ReadonlyArray<{ code: string; label: string }> = [{ code: "L01", label: "Arrendamientos y subarrendamientos de inmuebles urbanos" }];

export function listModelo115RowCodes(): Array<{ code: string; label: string }> {
  return ROW_DEFINITIONS.map((row) => ({ code: row.code, label: row.label }));
}

export type Modelo115Computation = {
  perceptores: number;
  base: Money;
  retenciones: Money;
  registros: number;
  casillas: FiscalBox[];
  totales: Record<string, number>;
  avisos: string[];
};

/** Pure: 115 boxes from the L-rows of the period. */
export function compute115(records: readonly WithholdingRecordForModel[]): Modelo115Computation {
  const avisos: string[] = [];
  const nifs = new Set<string>();
  let base = ZERO;
  let retenciones = ZERO;
  let registros = 0;
  let ignored = 0;
  for (const record of records) {
    if (!record.rowCode.startsWith(MODELO_115_ROW_PREFIX)) {
      ignored += 1;
      continue;
    }
    registros += 1;
    base = base.plus(money(record.grossAmount));
    retenciones = retenciones.plus(money(record.retentionAmount));
    nifs.add(record.recipientNif?.trim() ? record.recipientNif.trim().toUpperCase() : `<sin-nif:${registros}>`);
  }
  if (ignored > 0) avisos.push(`${ignored} registro(s) sin clave L ignorados: pertenecen al Modelo 111.`);
  if (registros === 0) avisos.push("Sin retenciones de arrendamiento en el periodo: el modelo sale a cero.");
  base = round2(base);
  retenciones = round2(retenciones);
  const perceptores = registros > 0 ? nifs.size : 0;
  const seccion = "Liquidación";
  const casillas: FiscalBox[] = [
    { casilla: "01", clave: "PERCEPTORES", descripcion: "Número de perceptores", seccion, importe: perceptores, tipo: "contador" },
    { casilla: "02", clave: "BASE", descripcion: "Base de las retenciones e ingresos a cuenta", seccion, importe: toWire(base), tipo: "base" },
    { casilla: "03", clave: "RETENCIONES", descripcion: "Retenciones e ingresos a cuenta", seccion, importe: toWire(retenciones), tipo: "cuota" },
    { casilla: "04", clave: "ANTERIORES", descripcion: "Resultados a ingresar de anteriores autoliquidaciones del mismo periodo", seccion, importe: 0, tipo: "cuota" },
    { casilla: "05", clave: "RESULTADO", descripcion: "Resultado a ingresar (03 − 04)", seccion, importe: toWire(retenciones), tipo: "resultado" }
  ];
  return {
    perceptores,
    base,
    retenciones,
    registros,
    casillas,
    totales: { perceptores, base: toWire(base), retenciones: toWire(retenciones), resultado: toWire(retenciones), registros },
    avisos
  };
}

export async function modelo115ForPeriod(input: { organizationId: string; periodo: FiscalPeriodDto; propertyId?: string | null }): Promise<{ report: FiscalModelReport; computation: Modelo115Computation }> {
  const records = await loadWithholdingRecords({ organizationId: input.organizationId, propertyId: input.propertyId, from: input.periodo.from, to: input.periodo.to, rowPrefix: MODELO_115_ROW_PREFIX });
  const computation = compute115(records);
  const report: FiscalModelReport = {
    modelo: "115",
    titulo: MODELO_115_TITLE,
    organizationId: input.organizationId,
    propertyId: input.propertyId ?? null,
    periodo: input.periodo,
    declarante: await declaranteOf(input.organizationId),
    casillas: computation.casillas,
    totales: computation.totales,
    avisos: computation.avisos,
    fuentes: { origen: "retenciones", registros: computation.registros },
    detalle: [],
    presentacion: { modo: "manual", ficheroOficial: false, nota: PRESENTACION_MANUAL_NOTA },
    generatedAt: new Date().toISOString()
  };
  return { report, computation };
}

/** Public entry point (route + legacy server.ts handler). */
export async function buildModelo115(input: { context: UserContext; propertyId?: string | null; period?: string; fromDate?: string; toDate?: string; periodType?: "monthly" | "quarterly" }): Promise<FiscalModelReport> {
  requirePermissions(input.context, ["accounting.read"]);
  const periodo = resolveSettlementPeriod(input);
  return (await modelo115ForPeriod({ organizationId: input.context.organizationId, periodo, propertyId: input.propertyId ?? null })).report;
}
