import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

// Modelo 303 (AEAT) — declaración trimestral del IVA. Aggregates output VAT
// (cuenta 477) from journal lines by rate bucket. The mapping below follows
// the boxes (casillas) defined by AEAT for hotels and similar services.

export type Modelo303Bucket = {
  ratePercent: number;
  baseImponible: number;
  cuotaRepercutida: number;
  casillaBase: number;
  casillaCuota: number;
};

export type Modelo303Report = {
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  periodType: "monthly" | "quarterly";
  fromDate: string;
  toDate: string;
  generatedAt: string;
  buckets: Modelo303Bucket[];
  // Total IVA devengado (totales agregados por casillas estándar)
  totals: {
    baseImponible: number;
    cuotaDevengada: number;
    netResult: number;
  };
  // Output: full casilla map for direct PDF/AEAT XML rendering.
  casillas: Record<string, number>;
};

// Mainland casilla map per Modelo 303 (régimen general). Each row pair
// (base, cuota) corresponds to a tax rate.
const CASILLA_MAINLAND: Record<number, { base: number; cuota: number }> = {
  21: { base: 1, cuota: 3 },
  10: { base: 4, cuota: 6 },
  5: { base: 152, cuota: 153 },
  4: { base: 7, cuota: 9 }
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

export async function buildModelo303(input: {
  context: UserContext;
  propertyId?: string;
  fromDate: string;
  toDate: string;
  periodType?: "monthly" | "quarterly";
}): Promise<Modelo303Report> {
  requirePermissions(input.context, ["analytics.read"]);

  if (input.fromDate >= input.toDate) {
    throw new Error("fromDate must be before toDate.");
  }

  const start = dateOnly(input.fromDate);
  const end = dateOnly(nextDay(input.toDate));

  const vatAccount = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId: input.context.organizationId, code: "477" } },
    select: { id: true }
  });
  if (!vatAccount) {
    throw new Error("Account 477 (H.P. IVA repercutido) not found in chart of accounts.");
  }

  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      status: "posted",
      postedAt: { gte: start, lt: end }
    },
    select: { id: true }
  });
  if (entries.length === 0) {
    return {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      periodCode: `${input.fromDate}_${input.toDate}`,
      periodType: input.periodType ?? "quarterly",
      fromDate: input.fromDate,
      toDate: input.toDate,
      generatedAt: new Date().toISOString(),
      buckets: [],
      totals: { baseImponible: 0, cuotaDevengada: 0, netResult: 0 },
      casillas: {}
    };
  }

  const vatLines = await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entries.map((e) => e.id) }, accountId: vatAccount.id }
  });

  const buckets = new Map<number, { base: number; cuota: number }>();
  for (const line of vatLines) {
    const description = line.description ?? "";
    const match = description.match(/(\d+(?:\.\d+)?)%/);
    const rate = match ? Number(match[1]) : 0;
    const cuota = Number(line.credit.toString()) - Number(line.debit.toString());
    if (cuota === 0) continue;
    const base = rate > 0 ? cuota / (rate / 100) : 0;
    const existing = buckets.get(rate) ?? { base: 0, cuota: 0 };
    existing.base += base;
    existing.cuota += cuota;
    buckets.set(rate, existing);
  }

  const bucketRows: Modelo303Bucket[] = Array.from(buckets.entries()).map(([rate, sum]) => {
    const cas = CASILLA_MAINLAND[rate] ?? { base: 0, cuota: 0 };
    return {
      ratePercent: rate,
      baseImponible: round(sum.base),
      cuotaRepercutida: round(sum.cuota),
      casillaBase: cas.base,
      casillaCuota: cas.cuota
    };
  }).sort((a, b) => b.ratePercent - a.ratePercent);

  const casillas: Record<string, number> = {};
  for (const b of bucketRows) {
    if (b.casillaBase > 0) casillas[`casilla_${b.casillaBase}`] = b.baseImponible;
    if (b.casillaCuota > 0) casillas[`casilla_${b.casillaCuota}`] = b.cuotaRepercutida;
  }

  const totalBase = round(bucketRows.reduce((sum, b) => sum + b.baseImponible, 0));
  const totalCuota = round(bucketRows.reduce((sum, b) => sum + b.cuotaRepercutida, 0));
  casillas["casilla_27"] = totalBase;
  casillas["casilla_46"] = totalCuota;
  casillas["casilla_71"] = totalCuota;

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    periodCode: `${input.fromDate}_${input.toDate}`,
    periodType: input.periodType ?? "quarterly",
    fromDate: input.fromDate,
    toDate: input.toDate,
    generatedAt: new Date().toISOString(),
    buckets: bucketRows,
    totals: {
      baseImponible: totalBase,
      cuotaDevengada: totalCuota,
      netResult: totalCuota
    },
    casillas
  };
}
