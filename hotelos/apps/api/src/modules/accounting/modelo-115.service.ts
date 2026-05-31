import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

// Modelo 115 (AEAT) — declaración trimestral de retenciones e ingresos a cuenta
// del IRPF correspondientes a rentas o rendimientos procedentes del arrendamiento
// o subarrendamiento de inmuebles urbanos. Se nutre de `WithholdingTaxRecord`
// filtrando filas cuyo rowCode comienza por "L" (Lessor / arrendamiento urbano),
// para que no colisione con los row codes 01–05 del Modelo 111.
//
// Casillas oficiales:
//   01 = número de perceptores (arrendadores)
//   02 = base de las retenciones (importe íntegro satisfecho)
//   03 = importe de las retenciones
//   04 = resultados a ingresar de declaraciones anteriores (0 por defecto)
//   05 = resultado a ingresar de la autoliquidación (= 03 - 04)

export const MODELO_115_ROW_PREFIX = "L";
export const MODELO_115_ROW_CODES = ["L01"] as const;

export type Modelo115Row = {
  rowCode: string;
  label: string;
  perceptores: number;
  base: number;
  retenciones: number;
};

export type Modelo115Report = {
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  periodType: "monthly" | "quarterly";
  fromDate: string;
  toDate: string;
  generatedAt: string;
  rows: Modelo115Row[];
  totals: {
    perceptores: number;
    base: number;
    retenciones: number;
    resultadoLiquidacion: number;
  };
  casillas: Record<string, number>;
};

const ROW_DEFINITIONS: Array<{ code: string; label: string }> = [
  { code: "L01", label: "Arrendamientos / subarrendamientos de inmuebles urbanos" }
];

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

export async function buildModelo115(input: {
  context: UserContext;
  propertyId?: string;
  fromDate: string;
  toDate: string;
  periodType?: "monthly" | "quarterly";
}): Promise<Modelo115Report> {
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
      paymentDate: { gte: start, lt: end },
      rowCode: { startsWith: MODELO_115_ROW_PREFIX }
    },
    select: {
      rowCode: true,
      recipientNif: true,
      grossAmount: true,
      retentionAmount: true
    }
  });

  type Bucket = { base: number; retenciones: number; nifs: Set<string> };
  const byRow = new Map<string, Bucket>();
  for (const def of ROW_DEFINITIONS) {
    byRow.set(def.code, { base: 0, retenciones: 0, nifs: new Set() });
  }

  for (const record of records) {
    const bucket = byRow.get(record.rowCode) ?? byRow.get("L01")!;
    bucket.base += Number(record.grossAmount.toString());
    bucket.retenciones += Number(record.retentionAmount.toString());
    bucket.nifs.add(record.recipientNif ?? "<sin-nif>");
  }

  const rows: Modelo115Row[] = ROW_DEFINITIONS.map((def) => {
    const bucket = byRow.get(def.code)!;
    return {
      rowCode: def.code,
      label: def.label,
      perceptores: bucket.nifs.size > 0 && bucket.base > 0 ? bucket.nifs.size : 0,
      base: round(bucket.base),
      retenciones: round(bucket.retenciones)
    };
  });

  const totalPerceptores = rows.reduce((sum, r) => sum + r.perceptores, 0);
  const totalBase = round(rows.reduce((sum, r) => sum + r.base, 0));
  const totalRetenciones = round(rows.reduce((sum, r) => sum + r.retenciones, 0));

  // Modelo 115 headline casillas.
  const casillas: Record<string, number> = {
    casilla_01: totalPerceptores,
    casilla_02: totalBase,
    casilla_03: totalRetenciones,
    casilla_04: 0,
    casilla_05: totalRetenciones
  };

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

export function listModelo115RowCodes(): Array<{ code: string; label: string }> {
  return ROW_DEFINITIONS.map((def) => ({ code: def.code, label: def.label }));
}
