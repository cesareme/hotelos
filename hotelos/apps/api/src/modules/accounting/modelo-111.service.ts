// Finanzas · lote «iva-modelos» — Modelo 111 (retenciones e ingresos a cuenta
// del IRPF: rendimientos del trabajo, actividades económicas, premios…).
//
// Source: `WithholdingTaxRecord` (posting-rules/withholding-tax.ts writes one
// row per payroll payment / professional invoice) filtered by `paymentDate`
// in the period. Rows whose rowCode starts with "L" belong to the Modelo 115
// (arrendamientos) and are EXCLUDED here (hallazgo 100: they used to be summed
// into row 01). Unknown row codes fall back to the row of their sourceType
// (payroll → 01, anything else → 02) with an aviso. Decimal arithmetic.
//
// Box map (Modelo 111 vigente):
//   I.   Rendimientos del trabajo: dinerarios 01/02/03 · en especie 04/05/06
//   II.  Rendimientos de actividades económicas: dinerarios 07/08/09 · en especie 10/11/12
//   III. Premios por la participación en juegos, concursos, rifas…: dinerarios 13/14/15 · en especie 16/17/18
//   IV.  Ganancias patrimoniales derivadas de aprovechamientos forestales: dinerarias 19/20/21 · en especie 22/23/24
//   V.   Contraprestaciones por la cesión de derechos de imagen: 25/26/27
//   Total liquidación: 28 total retenciones e ingresos a cuenta · 29 resultados a
//   ingresar de anteriores autoliquidaciones · 30 resultado a ingresar (28 − 29).
// Each block is (número de perceptores, importe de las percepciones, importe
// de las retenciones). Read-only.

import { prisma } from "@hotelos/database";
import type { FiscalBox, FiscalModelReport, FiscalPeriodDto } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";
import { PRESENTACION_MANUAL_NOTA, declaranteOf, resolveSettlementPeriod } from "./modelo-303.service.js";
import { ZERO, dateColumn, money, regimeAvisos, round2, toWire, type Money } from "./vat-books.service.js";

export const MODELO_111_TITLE = "Modelo 111 · Retenciones e ingresos a cuenta del IRPF · Autoliquidación";

/** Modelo 115 rows carry an "L" prefix (see modelo-115.service.ts) and never enter the 111. */
export const MODELO_115_ROW_PREFIX = "L";

/** Box numbers are numeric here (tests/withholding-tax-posting-contract.test.mjs reads them) and printed zero-padded ("07"). */
export type Modelo111RowDefinition = { code: string; label: string; seccion: string; perceptores: number; base: number; retenciones: number };

export const MODELO_111_ROWS: readonly Modelo111RowDefinition[] = Object.freeze([
  { code: "01", label: "Rendimientos del trabajo: dinerarios", seccion: "I. Rendimientos del trabajo", perceptores: 1, base: 2, retenciones: 3 },
  { code: "01b", label: "Rendimientos del trabajo: en especie", seccion: "I. Rendimientos del trabajo", perceptores: 4, base: 5, retenciones: 6 },
  { code: "02", label: "Rendimientos de actividades económicas: dinerarios", seccion: "II. Rendimientos de actividades económicas", perceptores: 7, base: 8, retenciones: 9 },
  { code: "02b", label: "Rendimientos de actividades económicas: en especie", seccion: "II. Rendimientos de actividades económicas", perceptores: 10, base: 11, retenciones: 12 },
  { code: "03", label: "Premios por la participación en juegos, concursos, rifas o combinaciones aleatorias: dinerarios", seccion: "III. Premios", perceptores: 13, base: 14, retenciones: 15 },
  { code: "03b", label: "Premios por la participación en juegos, concursos, rifas o combinaciones aleatorias: en especie", seccion: "III. Premios", perceptores: 16, base: 17, retenciones: 18 },
  { code: "04", label: "Ganancias patrimoniales derivadas de aprovechamientos forestales de vecinos: dinerarias", seccion: "IV. Ganancias patrimoniales", perceptores: 19, base: 20, retenciones: 21 },
  { code: "04b", label: "Ganancias patrimoniales derivadas de aprovechamientos forestales de vecinos: en especie", seccion: "IV. Ganancias patrimoniales", perceptores: 22, base: 23, retenciones: 24 },
  { code: "05", label: "Contraprestaciones por la cesión de derechos de imagen", seccion: "V. Cesión de derechos de imagen", perceptores: 25, base: 26, retenciones: 27 }
]);

const ROW_BY_CODE = new Map(MODELO_111_ROWS.map((row) => [row.code, row]));

/** Official box label of a numeric box number ("07"). */
export function boxLabel(box: number): string {
  return String(box).padStart(2, "0");
}

export function listModelo111RowCodes(): Array<{ code: string; label: string }> {
  return MODELO_111_ROWS.map((row) => ({ code: row.code, label: row.label }));
}

export function isKnownRowCode(code: string): boolean {
  return ROW_BY_CODE.has(code);
}

export type WithholdingRecordForModel = {
  sourceType: string;
  rowCode: string;
  recipientNif: string | null;
  grossAmount: Money | string | number;
  retentionAmount: Money | string | number;
};

export type Modelo111Row = { code: string; label: string; perceptores: number; base: Money; retenciones: Money; registros: number };

export type Modelo111Computation = {
  rows: Modelo111Row[];
  totalRetenciones: Money;
  totalBase: Money;
  perceptores: number;
  registros: number;
  casillas: FiscalBox[];
  totales: Record<string, number>;
  avisos: string[];
};

/** Row of a record: its rowCode when known, else the row of its sourceType (payroll → 01, other → 02). */
export function modelo111RowFor(record: Pick<WithholdingRecordForModel, "sourceType" | "rowCode">): { code: string; fallback: boolean } {
  if (ROW_BY_CODE.has(record.rowCode)) return { code: record.rowCode, fallback: false };
  return { code: record.sourceType === "payroll_payment" ? "01" : "02", fallback: true };
}

/** Pure: 111 boxes from withholding records of the period (115 rows already excluded by the caller). */
export function compute111(records: readonly WithholdingRecordForModel[]): Modelo111Computation {
  const avisos: string[] = [];
  const buckets = new Map<string, { base: Money; retenciones: Money; nifs: Set<string>; registros: number }>();
  for (const row of MODELO_111_ROWS) buckets.set(row.code, { base: ZERO, retenciones: ZERO, nifs: new Set(), registros: 0 });
  const allNifs = new Set<string>();
  let fallbacks = 0;
  let excluded = 0;
  for (const record of records) {
    if (record.rowCode.startsWith(MODELO_115_ROW_PREFIX)) {
      excluded += 1;
      continue;
    }
    const { code, fallback } = modelo111RowFor(record);
    if (fallback) fallbacks += 1;
    const bucket = buckets.get(code)!;
    bucket.base = bucket.base.plus(money(record.grossAmount));
    bucket.retenciones = bucket.retenciones.plus(money(record.retentionAmount));
    bucket.registros += 1;
    const nif = record.recipientNif?.trim() ? record.recipientNif.trim().toUpperCase() : `<sin-nif:${bucket.registros}:${code}>`;
    bucket.nifs.add(nif);
    allNifs.add(nif);
  }
  if (excluded > 0) avisos.push(`${excluded} registro(s) de arrendamientos (clave L) excluidos: corresponden al Modelo 115.`);
  if (fallbacks > 0) avisos.push(`${fallbacks} registro(s) con clave desconocida asignados por tipo de origen (nómina → 01, resto → 02).`);
  const rows: Modelo111Row[] = MODELO_111_ROWS.map((definition) => {
    const bucket = buckets.get(definition.code)!;
    return { code: definition.code, label: definition.label, perceptores: bucket.registros > 0 ? bucket.nifs.size : 0, base: round2(bucket.base), retenciones: round2(bucket.retenciones), registros: bucket.registros };
  });
  const casillas: FiscalBox[] = [];
  for (const row of rows) {
    const definition = ROW_BY_CODE.get(row.code)!;
    casillas.push({ casilla: boxLabel(definition.perceptores), clave: `${row.code}_PERCEPTORES`, descripcion: `${row.label} · número de perceptores`, seccion: definition.seccion, importe: row.perceptores, tipo: "contador" });
    casillas.push({ casilla: boxLabel(definition.base), clave: `${row.code}_BASE`, descripcion: `${row.label} · importe de las percepciones`, seccion: definition.seccion, importe: toWire(row.base), tipo: "base" });
    casillas.push({ casilla: boxLabel(definition.retenciones), clave: `${row.code}_RETENCIONES`, descripcion: `${row.label} · importe de las retenciones e ingresos a cuenta`, seccion: definition.seccion, importe: toWire(row.retenciones), tipo: "cuota" });
  }
  const totalRetenciones = round2(rows.reduce((sum, row) => sum.plus(row.retenciones), ZERO));
  const totalBase = round2(rows.reduce((sum, row) => sum.plus(row.base), ZERO));
  casillas.push({ casilla: "28", clave: "TOTAL_RETENCIONES", descripcion: "Total retenciones e ingresos a cuenta", seccion: "Total liquidación", importe: toWire(totalRetenciones), tipo: "cuota" });
  casillas.push({ casilla: "29", clave: "ANTERIORES", descripcion: "Resultados a ingresar de anteriores autoliquidaciones del mismo periodo", seccion: "Total liquidación", importe: 0, tipo: "cuota" });
  casillas.push({ casilla: "30", clave: "RESULTADO", descripcion: "Resultado a ingresar (28 − 29)", seccion: "Total liquidación", importe: toWire(totalRetenciones), tipo: "resultado" });
  if (records.length - excluded === 0) avisos.push("Sin registros de retención en el periodo: el modelo sale a cero (las nóminas y facturas de profesionales alimentan WithholdingTaxRecord al contabilizarse).");
  return {
    rows,
    totalRetenciones,
    totalBase,
    perceptores: allNifs.size,
    registros: records.length - excluded,
    casillas,
    totales: { perceptores: allNifs.size, base: toWire(totalBase), retenciones: toWire(totalRetenciones), resultado: toWire(totalRetenciones), registros: records.length - excluded },
    avisos
  };
}

export async function loadWithholdingRecords(input: { organizationId: string; propertyId?: string | null; from: string; to: string; rowPrefix?: string; excludePrefix?: string }) {
  return prisma.withholdingTaxRecord.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      paymentDate: { gte: dateColumn(input.from), lte: dateColumn(input.to) },
      ...(input.rowPrefix ? { rowCode: { startsWith: input.rowPrefix } } : {}),
      ...(input.excludePrefix ? { NOT: { rowCode: { startsWith: input.excludePrefix } } } : {})
    },
    select: { sourceType: true, rowCode: true, recipientNif: true, recipientName: true, recipientAddress: true, cadastralReference: true, grossAmount: true, retentionAmount: true, paymentDate: true },
    orderBy: [{ paymentDate: "asc" }]
  });
}

export async function modelo111ForPeriod(input: { organizationId: string; periodo: FiscalPeriodDto; propertyId?: string | null }): Promise<FiscalModelReport> {
  const [records, { declarante, sociedad }] = await Promise.all([
    loadWithholdingRecords({ organizationId: input.organizationId, propertyId: input.propertyId, from: input.periodo.from, to: input.periodo.to, excludePrefix: MODELO_115_ROW_PREFIX }),
    declaranteOf(input.organizationId)
  ]);
  const computation = compute111(records);
  const avisos = [...computation.avisos, ...regimeAvisos(sociedad.regimen, "111")];
  if (input.propertyId) avisos.push("Vista parcial por establecimiento (no liquidable): el Modelo 111 se presenta por NIF de la sociedad (retenedor).");
  return {
    modelo: "111",
    titulo: MODELO_111_TITLE,
    organizationId: input.organizationId,
    propertyId: input.propertyId ?? null,
    periodo: input.periodo,
    declarante,
    sociedad,
    casillas: computation.casillas,
    totales: computation.totales,
    avisos,
    fuentes: { origen: "retenciones", registros: computation.registros },
    detalle: computation.rows.filter((row) => row.registros > 0).map((row) => ({ clave: row.code, concepto: row.label, perceptores: row.perceptores, base: toWire(row.base), retenciones: toWire(row.retenciones), registros: row.registros })),
    presentacion: { modo: "manual", ficheroOficial: false, nota: PRESENTACION_MANUAL_NOTA },
    generatedAt: new Date().toISOString()
  };
}

/** Public entry point (route + legacy server.ts handler): `period` (2026-Q3 · 2026-09) or fromDate/toDate of a natural quarter/month. */
export async function buildModelo111(input: { context: UserContext; propertyId?: string | null; period?: string; fromDate?: string; toDate?: string; periodType?: "monthly" | "quarterly" }): Promise<FiscalModelReport> {
  requirePermissions(input.context, ["accounting.read"]);
  assertFinanceReadScope(input.context, input.propertyId ?? null);
  // R8: a gran empresa (volumen > 6.010.121,04 €) files the 111 monthly (RIRPF art. 108.1); otherwise month or quarter as requested.
  const { sociedad } = await declaranteOf(input.context.organizationId);
  const periodo = resolveSettlementPeriod(input, sociedad.regimen.periodicityForcedBy ? "monthly" : undefined, sociedad.regimen);
  return modelo111ForPeriod({ organizationId: input.context.organizationId, periodo, propertyId: input.propertyId ?? null });
}
