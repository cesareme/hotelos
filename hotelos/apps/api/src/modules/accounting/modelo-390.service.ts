import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { buildModelo303 } from "./modelo-303.service.js";

// Modelo 390 — resumen anual del IVA (AEAT). Agrega los 12 modelos 303 mensuales
// (o 4 trimestrales) y produce la liquidación consolidada. Para hotelos lo
// generamos derivando from journal_lines de la cuenta 477 a lo largo del año.

export type Modelo390Quarter = {
  quarter: 1 | 2 | 3 | 4;
  fromDate: string;
  toDate: string;
  baseImponible: number;
  cuotaRepercutida: number;
};

export type Modelo390Bucket = {
  ratePercent: number;
  baseAnual: number;
  cuotaAnual: number;
  baseQ1: number;
  cuotaQ1: number;
  baseQ2: number;
  cuotaQ2: number;
  baseQ3: number;
  cuotaQ3: number;
  baseQ4: number;
  cuotaQ4: number;
};

export type Modelo390Report = {
  organizationId: string;
  propertyId?: string;
  year: number;
  generatedAt: string;
  quarters: Modelo390Quarter[];
  buckets: Modelo390Bucket[];
  totals: {
    baseAnual: number;
    cuotaAnualDevengada: number;
    cuotaAnualLiquidada: number;
  };
  // Headline casillas for Modelo 390 form.
  casillas: Record<string, number>;
};

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function quarterRanges(year: number): Array<{ q: 1 | 2 | 3 | 4; from: string; to: string }> {
  return [
    { q: 1, from: `${year}-01-01`, to: `${year}-03-31` },
    { q: 2, from: `${year}-04-01`, to: `${year}-06-30` },
    { q: 3, from: `${year}-07-01`, to: `${year}-09-30` },
    { q: 4, from: `${year}-10-01`, to: `${year}-12-31` }
  ];
}

export async function buildModelo390(input: {
  context: UserContext;
  propertyId?: string;
  year: number;
}): Promise<Modelo390Report> {
  requirePermissions(input.context, ["analytics.read"]);

  const ranges = quarterRanges(input.year);
  const quarterReports = await Promise.all(
    ranges.map((range) =>
      buildModelo303({
        context: input.context,
        propertyId: input.propertyId,
        fromDate: range.from,
        toDate: range.to,
        periodType: "quarterly"
      })
    )
  );

  // Aggregate buckets across quarters.
  const bucketsByRate = new Map<number, Modelo390Bucket>();
  quarterReports.forEach((report, qIndex) => {
    const q = (qIndex + 1) as 1 | 2 | 3 | 4;
    for (const bucket of report.buckets) {
      const existing = bucketsByRate.get(bucket.ratePercent) ?? {
        ratePercent: bucket.ratePercent,
        baseAnual: 0,
        cuotaAnual: 0,
        baseQ1: 0, cuotaQ1: 0,
        baseQ2: 0, cuotaQ2: 0,
        baseQ3: 0, cuotaQ3: 0,
        baseQ4: 0, cuotaQ4: 0
      };
      existing.baseAnual += bucket.baseImponible;
      existing.cuotaAnual += bucket.cuotaRepercutida;
      const baseKey = `baseQ${q}` as `baseQ${1 | 2 | 3 | 4}`;
      const cuotaKey = `cuotaQ${q}` as `cuotaQ${1 | 2 | 3 | 4}`;
      existing[baseKey] += bucket.baseImponible;
      existing[cuotaKey] += bucket.cuotaRepercutida;
      bucketsByRate.set(bucket.ratePercent, existing);
    }
  });

  const buckets = Array.from(bucketsByRate.values())
    .map((b) => ({
      ratePercent: b.ratePercent,
      baseAnual: round(b.baseAnual),
      cuotaAnual: round(b.cuotaAnual),
      baseQ1: round(b.baseQ1), cuotaQ1: round(b.cuotaQ1),
      baseQ2: round(b.baseQ2), cuotaQ2: round(b.cuotaQ2),
      baseQ3: round(b.baseQ3), cuotaQ3: round(b.cuotaQ3),
      baseQ4: round(b.baseQ4), cuotaQ4: round(b.cuotaQ4)
    }))
    .sort((a, b) => b.ratePercent - a.ratePercent);

  const quarters: Modelo390Quarter[] = quarterReports.map((report, idx) => ({
    quarter: (idx + 1) as 1 | 2 | 3 | 4,
    fromDate: ranges[idx].from,
    toDate: ranges[idx].to,
    baseImponible: report.totals.baseImponible,
    cuotaRepercutida: report.totals.cuotaDevengada
  }));

  const baseAnual = round(buckets.reduce((s, b) => s + b.baseAnual, 0));
  const cuotaAnual = round(buckets.reduce((s, b) => s + b.cuotaAnual, 0));

  // Modelo 390 headline casillas (régimen general, ventas).
  const casillas: Record<string, number> = {
    casilla_99: baseAnual,
    casilla_109: cuotaAnual,
    casilla_500: baseAnual,
    casilla_511: cuotaAnual,
    casilla_658: cuotaAnual,
    casilla_662: cuotaAnual
  };
  for (const b of buckets) {
    if (b.ratePercent === 21) {
      casillas.casilla_07 = b.baseAnual;
      casillas.casilla_09 = b.cuotaAnual;
    } else if (b.ratePercent === 10) {
      casillas.casilla_04 = b.baseAnual;
      casillas.casilla_06 = b.cuotaAnual;
    } else if (b.ratePercent === 4) {
      casillas.casilla_01 = b.baseAnual;
      casillas.casilla_03 = b.cuotaAnual;
    }
  }

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    year: input.year,
    generatedAt: new Date().toISOString(),
    quarters,
    buckets,
    totals: {
      baseAnual,
      cuotaAnualDevengada: cuotaAnual,
      cuotaAnualLiquidada: cuotaAnual
    },
    casillas
  };
}
