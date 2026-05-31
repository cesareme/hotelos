import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

// Modelo 111 (AEAT) — declaración trimestral de retenciones e ingresos a cuenta del IRPF.
// Aggregates `WithholdingTaxRecord` rows (built up in cuenta 4751 H.P. acreedor por
// retenciones practicadas) per row code (01 empleados, 02 profesionales, 03 actividades
// agrarias, …) for the requested period and produces the AEAT casilla map.

export type Modelo111RowCode =
  | "01" // Rendimientos del trabajo: empleados
  | "02" // Rendimientos de actividades económicas: profesionales
  | "03" // Rendimientos de actividades agrícolas, ganaderas o forestales
  | "04" // Rendimientos de premios
  | "05" // Ganancias patrimoniales (aprovechamientos forestales)
  | "06" // Contraprestaciones imagen
  | "07" // Cesión derechos de imagen
  | "other";

export type Modelo111Row = {
  rowCode: Modelo111RowCode | string;
  label: string;
  perceptores: number;
  base: number;
  retenciones: number;
  // AEAT casilla pair (perceptores, base, retenciones)
  casillaPerceptores: number;
  casillaBase: number;
  casillaRetenciones: number;
};

export type Modelo111Report = {
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  periodType: "monthly" | "quarterly";
  fromDate: string;
  toDate: string;
  generatedAt: string;
  rows: Modelo111Row[];
  totals: {
    perceptores: number;
    base: number;
    retenciones: number;
    resultadoLiquidacion: number;
  };
  casillas: Record<string, number>;
};

// AEAT Modelo 111 row code → casilla triplet (perceptores, base, retenciones)
// Following the official Modelo 111 form layout (BOE Orden HAC/646/2018 + revisions).
const ROW_DEFINITIONS: Array<{
  code: string;
  label: string;
  perceptores: number;
  base: number;
  retenciones: number;
}> = [
  { code: "01", label: "Rendimientos del trabajo: dinerarios", perceptores: 1, base: 2, retenciones: 3 },
  { code: "01b", label: "Rendimientos del trabajo: en especie", perceptores: 4, base: 5, retenciones: 6 },
  { code: "02", label: "Actividades económicas: dinerarios", perceptores: 7, base: 8, retenciones: 9 },
  { code: "02b", label: "Actividades económicas: en especie", perceptores: 10, base: 11, retenciones: 12 },
  { code: "03", label: "Premios por juegos, concursos, rifas: dinerarios", perceptores: 13, base: 14, retenciones: 15 },
  { code: "03b", label: "Premios por juegos, concursos, rifas: en especie", perceptores: 16, base: 17, retenciones: 18 },
  { code: "04", label: "Ganancias patrimoniales (aprovechamientos forestales): dinerarios", perceptores: 19, base: 20, retenciones: 21 },
  { code: "04b", label: "Ganancias patrimoniales (aprovechamientos forestales): en especie", perceptores: 22, base: 23, retenciones: 24 },
  { code: "05", label: "Contraprestaciones por cesión derechos de imagen: dinerarios", perceptores: 25, base: 26, retenciones: 27 },
  { code: "05b", label: "Contraprestaciones por cesión derechos de imagen: en especie", perceptores: 28, base: 29, retenciones: 30 }
];

const ROW_BY_CODE = new Map(ROW_DEFINITIONS.map((row) => [row.code, row]));

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function buildModelo111(input: {
  context: UserContext;
  propertyId?: string;
  fromDate: string;
  toDate: string;
  periodType?: "monthly" | "quarterly";
}): Promise<Modelo111Report> {
  requirePermissions(input.context, ["analytics.read"]);

  if (input.fromDate >= input.toDate) {
    throw new Error("fromDate must be before toDate.");
  }

  const start = dateOnly(input.fromDate);
  const end = dateOnly(nextDay(input.toDate));

  const records = await prisma.withholdingTaxRecord.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      paymentDate: { gte: start, lt: end }
    },
    select: {
      rowCode: true,
      recipientNif: true,
      grossAmount: true,
      retentionAmount: true
    }
  });

  // Aggregate per rowCode: track distinct perceptores by NIF (or by sourceId when no NIF).
  type Bucket = { base: number; retenciones: number; nifs: Set<string> };
  const byRow = new Map<string, Bucket>();
  for (const def of ROW_DEFINITIONS) {
    byRow.set(def.code, { base: 0, retenciones: 0, nifs: new Set() });
  }

  for (const record of records) {
    const bucket = byRow.get(record.rowCode) ?? byRow.get("01")!;
    bucket.base += Number(record.grossAmount.toString());
    bucket.retenciones += Number(record.retentionAmount.toString());
    bucket.nifs.add(record.recipientNif ?? "<sin-nif>");
  }

  const rows: Modelo111Row[] = ROW_DEFINITIONS.map((def) => {
    const bucket = byRow.get(def.code)!;
    return {
      rowCode: def.code,
      label: def.label,
      perceptores: bucket.nifs.size > 0 && bucket.base > 0 ? bucket.nifs.size : 0,
      base: round(bucket.base),
      retenciones: round(bucket.retenciones),
      casillaPerceptores: def.perceptores,
      casillaBase: def.base,
      casillaRetenciones: def.retenciones
    };
  });

  const casillas: Record<string, number> = {};
  for (const row of rows) {
    casillas[`casilla_${row.casillaPerceptores}`] = row.perceptores;
    casillas[`casilla_${row.casillaBase}`] = row.base;
    casillas[`casilla_${row.casillaRetenciones}`] = row.retenciones;
  }

  const totalPerceptores = rows.reduce((sum, r) => sum + r.perceptores, 0);
  const totalBase = round(rows.reduce((sum, r) => sum + r.base, 0));
  const totalRetenciones = round(rows.reduce((sum, r) => sum + r.retenciones, 0));

  // Modelo 111 headline casillas:
  //   casilla_28 = Total retenciones e ingresos a cuenta (suma del bloque dinerario + especie)
  //   casilla_29 = Resultados a ingresar de declaraciones anteriores (negativos) — 0 por defecto
  //   casilla_30 = TotalRetenciones (28 - 29)
  //   casilla_31 = Resultado a ingresar de la autoliquidación
  casillas.casilla_28 = totalRetenciones;
  casillas.casilla_29 = 0;
  casillas.casilla_30 = totalRetenciones;
  casillas.casilla_31 = totalRetenciones;

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    periodCode: `${input.fromDate}_${input.toDate}`,
    periodType: input.periodType ?? "quarterly",
    fromDate: input.fromDate,
    toDate: input.toDate,
    generatedAt: new Date().toISOString(),
    rows,
    totals: {
      perceptores: totalPerceptores,
      base: totalBase,
      retenciones: totalRetenciones,
      resultadoLiquidacion: totalRetenciones
    },
    casillas
  };
}

export function listModelo111RowCodes(): Array<{ code: string; label: string }> {
  return ROW_DEFINITIONS.map((def) => ({ code: def.code, label: def.label }));
}

export function isKnownRowCode(code: string): boolean {
  return ROW_BY_CODE.has(code);
}
