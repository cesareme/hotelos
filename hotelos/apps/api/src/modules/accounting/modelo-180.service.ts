// Finanzas · lote «iva-modelos» — Modelo 180 (resumen anual de retenciones
// sobre arrendamientos de inmuebles urbanos, Modelo 115).
//
// Consolidates the four quarters (or twelve months) of Modelo 115 of the year
// and lists every lessor (NIF, name, address of the property, cadastral
// reference, importe íntegro, retención). Boxes of the summary: 01 número
// total de perceptores · 02 importe total de las percepciones · 03 importe
// total de las retenciones e ingresos a cuenta. Decimal arithmetic. Read-only.

import type { FiscalBox, FiscalModelReport } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireYear } from "../../lib/query-dates.js";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";
import { PRESENTACION_MANUAL_NOTA, declaranteOf } from "./modelo-303.service.js";
import { MODELO_115_ROW_PREFIX, loadWithholdingRecords } from "./modelo-111.service.js";
import { compute115 } from "./modelo-115.service.js";
import { ZERO, annualPeriod, money, periodsOfYear, round2, toWire, type Money } from "./vat-books.service.js";

export const MODELO_180_TITLE = "Modelo 180 · Retenciones e ingresos a cuenta · Rentas de arrendamiento de inmuebles urbanos · Resumen anual";

export type LessorRecord = {
  rowCode: string;
  recipientNif: string | null;
  recipientName: string | null;
  recipientAddress: string | null;
  cadastralReference: string | null;
  grossAmount: Money | string | number;
  retentionAmount: Money | string | number;
};

export type Modelo180Lessor = { nif: string; nombre: string; direccion: string; referenciaCatastral: string; importeIntegro: Money; retencion: Money; registros: number };

/** Pure: lessors of the year (one row per NIF + cadastral reference). */
export function lessorsOf(records: readonly LessorRecord[]): Modelo180Lessor[] {
  const byKey = new Map<string, Modelo180Lessor>();
  for (const record of records) {
    if (!record.rowCode.startsWith(MODELO_115_ROW_PREFIX)) continue;
    const nif = record.recipientNif?.trim() ? record.recipientNif.trim().toUpperCase() : "<sin-nif>";
    const referencia = record.cadastralReference?.trim() ?? "";
    const key = `${nif}|${referencia}`;
    const existing = byKey.get(key) ?? { nif, nombre: record.recipientName?.trim() ?? "", direccion: record.recipientAddress?.trim() ?? "", referenciaCatastral: referencia, importeIntegro: ZERO, retencion: ZERO, registros: 0 };
    existing.importeIntegro = existing.importeIntegro.plus(money(record.grossAmount));
    existing.retencion = existing.retencion.plus(money(record.retentionAmount));
    existing.registros += 1;
    if (!existing.nombre && record.recipientName) existing.nombre = record.recipientName.trim();
    if (!existing.direccion && record.recipientAddress) existing.direccion = record.recipientAddress.trim();
    byKey.set(key, existing);
  }
  return Array.from(byKey.values())
    .map((lessor) => ({ ...lessor, importeIntegro: round2(lessor.importeIntegro), retencion: round2(lessor.retencion) }))
    .sort((a, b) => b.retencion.comparedTo(a.retencion) || a.nif.localeCompare(b.nif));
}

export async function buildModelo180(input: { context: UserContext; propertyId?: string | null; year: number }): Promise<FiscalModelReport> {
  requirePermissions(input.context, ["accounting.read"]);
  assertFinanceReadScope(input.context, input.propertyId ?? null);
  const year = requireYear(input.year);
  const organizationId = input.context.organizationId;
  const periodo = annualPeriod(year);
  const records = await loadWithholdingRecords({ organizationId, propertyId: input.propertyId, from: periodo.from, to: periodo.to, rowPrefix: MODELO_115_ROW_PREFIX });
  const lessors = lessorsOf(records);
  const annual = compute115(records);
  const quarters = periodsOfYear(year, "quarterly").map((quarter) => {
    const computation = compute115(records.filter((record) => {
      const day = record.paymentDate.toISOString().slice(0, 10);
      return day >= quarter.from && day <= quarter.to;
    }));
    return { periodo: quarter.code, resultado: toWire(computation.retenciones), base: toWire(computation.base), perceptores: computation.perceptores };
  });
  const { declarante, sociedad } = await declaranteOf(organizationId);
  const avisos: string[] = [];
  if (lessors.length === 0) avisos.push("Sin arrendadores con retención en el ejercicio: el resumen sale a cero.");
  const incomplete = lessors.filter((lessor) => lessor.nif === "<sin-nif>" || !lessor.referenciaCatastral || !lessor.direccion);
  if (incomplete.length > 0) avisos.push(`${incomplete.length} arrendador(es) sin NIF, dirección del inmueble o referencia catastral: completa los datos antes de presentar.`);
  if (input.propertyId) avisos.push("Vista parcial por establecimiento (no liquidable): el Modelo 180 se presenta por NIF de la sociedad (retenedor).");
  const seccion = "Resumen de los datos";
  const casillas: FiscalBox[] = [
    { casilla: "01", clave: "PERCEPTORES", descripcion: "Número total de perceptores", seccion, importe: lessors.length, tipo: "contador" },
    { casilla: "02", clave: "BASE", descripcion: "Importe total de las percepciones (base de las retenciones)", seccion, importe: toWire(annual.base), tipo: "base" },
    { casilla: "03", clave: "RETENCIONES", descripcion: "Importe total de las retenciones e ingresos a cuenta", seccion, importe: toWire(annual.retenciones), tipo: "cuota" }
  ];
  return {
    modelo: "180",
    titulo: MODELO_180_TITLE,
    organizationId,
    propertyId: input.propertyId ?? null,
    periodo,
    declarante,
    sociedad,
    casillas,
    totales: { perceptores: lessors.length, base: toWire(annual.base), retenciones: toWire(annual.retenciones), registros: annual.registros },
    avisos,
    fuentes: { origen: "retenciones", registros: annual.registros, periodos: quarters.map((quarter) => ({ periodo: quarter.periodo, resultado: quarter.resultado })) },
    detalle: lessors.map((lessor) => ({
      nif: lessor.nif,
      nombre: lessor.nombre,
      direccion: lessor.direccion,
      referenciaCatastral: lessor.referenciaCatastral,
      importeIntegro: toWire(lessor.importeIntegro),
      retencion: toWire(lessor.retencion),
      registros: lessor.registros
    })),
    presentacion: { modo: "manual", ficheroOficial: false, nota: PRESENTACION_MANUAL_NOTA },
    generatedAt: new Date().toISOString()
  };
}
