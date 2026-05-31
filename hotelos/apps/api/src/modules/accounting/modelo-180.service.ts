import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { buildModelo115, MODELO_115_ROW_PREFIX } from "./modelo-115.service.js";

// Modelo 180 — resumen anual de las retenciones del Modelo 115 sobre
// arrendamientos urbanos. Consolida los 4 modelos 115 trimestrales del año y
// presenta el desglose por arrendador (NIF, nombre, dirección del inmueble,
// referencia catastral, importe íntegro y retención practicada).

export type Modelo180Quarter = {
  quarter: 1 | 2 | 3 | 4;
  fromDate: string;
  toDate: string;
  perceptores: number;
  base: number;
  retenciones: number;
};

export type Modelo180Lessor = {
  recipientNif: string;
  recipientName: string;
  recipientAddress: string;
  cadastralReference: string;
  importeIntegro: number;
  retencion: number;
};

export type Modelo180Report = {
  organizationId: string;
  propertyId?: string;
  year: number;
  generatedAt: string;
  quarters: Modelo180Quarter[];
  lessors: Modelo180Lessor[];
  totals: {
    perceptores: number;
    baseAnual: number;
    retencionAnual: number;
  };
  casillas: Record<string, number>;
};

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

function quarterRanges(year: number): Array<{ q: 1 | 2 | 3 | 4; from: string; to: string }> {
  return [
    { q: 1, from: `${year}-01-01`, to: `${year}-03-31` },
    { q: 2, from: `${year}-04-01`, to: `${year}-06-30` },
    { q: 3, from: `${year}-07-01`, to: `${year}-09-30` },
    { q: 4, from: `${year}-10-01`, to: `${year}-12-31` }
  ];
}

export async function buildModelo180(input: {
  context: UserContext;
  propertyId?: string;
  year: number;
}): Promise<Modelo180Report> {
  requirePermissions(input.context, ["analytics.read"]);

  const ranges = quarterRanges(input.year);
  const quarterReports = await Promise.all(
    ranges.map((range) =>
      buildModelo115({
        context: input.context,
        propertyId: input.propertyId,
        fromDate: range.from,
        toDate: range.to,
        periodType: "quarterly"
      })
    )
  );

  const quarters: Modelo180Quarter[] = quarterReports.map((report, idx) => ({
    quarter: (idx + 1) as 1 | 2 | 3 | 4,
    fromDate: ranges[idx].from,
    toDate: ranges[idx].to,
    perceptores: report.totals.perceptores,
    base: report.totals.base,
    retenciones: report.totals.retenciones
  }));

  // Desglose anual por arrendador.
  const yearStart = dateOnly(`${input.year}-01-01`);
  const yearEnd = dateOnly(nextDay(`${input.year}-12-31`));

  const records = await prisma.withholdingTaxRecord.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      paymentDate: { gte: yearStart, lt: yearEnd },
      rowCode: { startsWith: MODELO_115_ROW_PREFIX }
    },
    select: {
      recipientNif: true,
      recipientName: true,
      recipientAddress: true,
      cadastralReference: true,
      grossAmount: true,
      retentionAmount: true
    }
  });

  type LessorBucket = {
    recipientNif: string;
    recipientName: string;
    recipientAddress: string;
    cadastralReference: string;
    importeIntegro: number;
    retencion: number;
  };
  const byKey = new Map<string, LessorBucket>();
  for (const record of records) {
    const nif = record.recipientNif ?? "<sin-nif>";
    const cad = record.cadastralReference ?? "";
    const key = `${nif}|${cad}`;
    const existing = byKey.get(key) ?? {
      recipientNif: nif,
      recipientName: record.recipientName ?? "",
      recipientAddress: record.recipientAddress ?? "",
      cadastralReference: cad,
      importeIntegro: 0,
      retencion: 0
    };
    existing.importeIntegro += Number(record.grossAmount.toString());
    existing.retencion += Number(record.retentionAmount.toString());
    if (!existing.recipientName && record.recipientName) existing.recipientName = record.recipientName;
    if (!existing.recipientAddress && record.recipientAddress) existing.recipientAddress = record.recipientAddress;
    byKey.set(key, existing);
  }

  const lessors: Modelo180Lessor[] = Array.from(byKey.values())
    .map((l) => ({
      recipientNif: l.recipientNif,
      recipientName: l.recipientName,
      recipientAddress: l.recipientAddress,
      cadastralReference: l.cadastralReference,
      importeIntegro: round(l.importeIntegro),
      retencion: round(l.retencion)
    }))
    .sort((a, b) => b.retencion - a.retencion);

  const baseAnual = round(quarters.reduce((s, q) => s + q.base, 0));
  const retencionAnual = round(quarters.reduce((s, q) => s + q.retenciones, 0));
  const perceptoresAnuales = byKey.size;

  // Modelo 180 headline casillas.
  const casillas: Record<string, number> = {
    casilla_01: perceptoresAnuales,
    casilla_02: baseAnual,
    casilla_03: retencionAnual
  };

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    year: input.year,
    generatedAt: new Date().toISOString(),
    quarters,
    lessors,
    totals: {
      perceptores: perceptoresAnuales,
      baseAnual,
      retencionAnual
    },
    casillas
  };
}
