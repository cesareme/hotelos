import { prisma } from "@hotelos/database";

// In-memory cache: propertyId → taxRegion. Property tax region rarely changes.
const propertyRegionCache = new Map<string, string>();
// Cache: `${region}::${lineType}::${dateIso}` → percent (numeric).
const rateCache = new Map<string, number>();

export type ResolvedRate = {
  taxRegion: string;
  taxCode: string;
  rateCode: string;
  ratePercent: number;
  appliesTo: string;
};

async function getTaxRegion(propertyId: string): Promise<string> {
  const cached = propertyRegionCache.get(propertyId);
  if (cached) return cached;
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { taxRegion: true }
  });
  const region = property?.taxRegion ?? "mainland";
  propertyRegionCache.set(propertyId, region);
  return region;
}

export async function resolveTaxRate(input: {
  propertyId: string;
  lineType: string;
  postingDate?: Date;
}): Promise<ResolvedRate> {
  const region = await getTaxRegion(input.propertyId);
  const date = input.postingDate ?? new Date();
  const cacheKey = `${region}::${input.lineType}::${date.toISOString().slice(0, 10)}`;
  const cached = rateCache.get(cacheKey);
  if (cached !== undefined) {
    return resolveCached(region, input.lineType, cached);
  }

  const tax = await prisma.tax.findFirst({ where: { taxRegion: region } });
  if (!tax) {
    return { taxRegion: region, taxCode: "UNKNOWN", rateCode: "zero", ratePercent: 0, appliesTo: input.lineType };
  }

  const rate = await prisma.taxRate.findFirst({
    where: {
      taxId: tax.id,
      appliesTo: input.lineType,
      active: true,
      validFrom: { lte: date },
      OR: [{ validTo: null }, { validTo: { gte: date } }]
    },
    orderBy: { validFrom: "desc" }
  });

  if (!rate) {
    return { taxRegion: region, taxCode: tax.code, rateCode: "zero", ratePercent: 0, appliesTo: input.lineType };
  }
  const percent = Number(rate.ratePercent);
  rateCache.set(cacheKey, percent);
  return {
    taxRegion: region,
    taxCode: tax.code,
    rateCode: rate.rateCode,
    ratePercent: percent,
    appliesTo: rate.appliesTo
  };
}

function resolveCached(region: string, lineType: string, percent: number): ResolvedRate {
  return {
    taxRegion: region,
    taxCode: region === "mainland" ? "IVA" : region === "canary" ? "IGIC" : "IPSI",
    rateCode: percent === 0 ? "zero" : percent > 14 ? "incrementado" : "general",
    ratePercent: percent,
    appliesTo: lineType
  };
}

export function buildTaxCode(taxCode: string, percent: number): string {
  return `ES_${taxCode}_${Math.round(percent)}`;
}

export function invalidateTaxCache(): void {
  propertyRegionCache.clear();
  rateCache.clear();
}
