// CSRD / ESRS reporting service.
//
// La directiva CSRD obliga a publicar 12 estándares ESRS (4 environment, 4
// social, 2 governance, 2 general) con datos del ejercicio anterior.
// Para hoteles, los indicadores más relevantes son:
//
//   ESRS E1 (Cambio climático): Scope 1 emisiones (gas, gasoil de calefacción,
//   fugas refrigerantes), Scope 2 (electricidad), Scope 3 (cadena de valor —
//   commuting, viajes huéspedes, residuos).
//   ESRS E3 (Recursos hídricos): consumo m³ + reciclaje.
//   ESRS E5 (Economía circular): residuos kg, % reciclado.
//   ESRS S1 (Plantilla propia): headcount, edad media, brecha salarial,
//   accidentes, formación horas/empleado.
//
// Catálogo mínimo de disclosures que un hotel debe reportar.

import { prisma } from "@hotelos/database";
import { createHash } from "node:crypto";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

export const ESRS_DISCLOSURES = [
  // E1 Climate change
  { standard: "ESRS_E1", code: "E1-6_GHG_Scope1", description: "Scope 1 GHG emissions (gas + heating oil + refrigerant leaks)", unit: "tCO2e", required: true },
  { standard: "ESRS_E1", code: "E1-6_GHG_Scope2_LocationBased", description: "Scope 2 GHG emissions (electricity, location-based)", unit: "tCO2e", required: true },
  { standard: "ESRS_E1", code: "E1-6_GHG_Scope2_MarketBased", description: "Scope 2 GHG emissions (electricity, market-based)", unit: "tCO2e", required: true },
  { standard: "ESRS_E1", code: "E1-6_GHG_Scope3", description: "Scope 3 GHG emissions (commuting + guest travel + waste)", unit: "tCO2e", required: true },
  { standard: "ESRS_E1", code: "E1-5_Energy_Total", description: "Total energy consumption", unit: "MWh", required: true },
  { standard: "ESRS_E1", code: "E1-5_Energy_Renewable", description: "Renewable energy consumption", unit: "MWh", required: true },
  // E3 Water
  { standard: "ESRS_E3", code: "E3-4_Water_Consumed", description: "Water consumed", unit: "m3", required: true },
  { standard: "ESRS_E3", code: "E3-4_Water_Recycled", description: "Water recycled or reused", unit: "m3", required: false },
  { standard: "ESRS_E3", code: "E3-4_Water_PerNight", description: "Water consumed per occupied room night", unit: "m3/RN", required: false },
  // E5 Waste
  { standard: "ESRS_E5", code: "E5-5_Waste_Generated", description: "Waste generated", unit: "t", required: true },
  { standard: "ESRS_E5", code: "E5-5_Waste_Diverted", description: "Waste diverted from disposal (recycled, composted)", unit: "t", required: true },
  // S1 Own workforce
  { standard: "ESRS_S1", code: "S1-6_Headcount", description: "Total headcount end of period", unit: "headcount", required: true },
  { standard: "ESRS_S1", code: "S1-6_Headcount_Female", description: "Female employees (headcount)", unit: "headcount", required: true },
  { standard: "ESRS_S1", code: "S1-6_Headcount_Male", description: "Male employees (headcount)", unit: "headcount", required: true },
  { standard: "ESRS_S1", code: "S1-14_PayGap", description: "Unadjusted gender pay gap", unit: "%", required: true },
  { standard: "ESRS_S1", code: "S1-14_Accidents_LostTime", description: "Lost-time work accidents", unit: "count", required: true },
  { standard: "ESRS_S1", code: "S1-13_Training_HoursPerEmployee", description: "Avg. training hours per employee", unit: "hours", required: false },
  // G1 Governance
  { standard: "ESRS_G1", code: "G1-6_AntiCorruption_Cases", description: "Confirmed cases of corruption", unit: "count", required: true }
] as const;

export type EsrsDisclosure = (typeof ESRS_DISCLOSURES)[number];

// ---------------------------------------------------------------------------
// Persistencia + lectura
// ---------------------------------------------------------------------------

export async function getCatalog() {
  return ESRS_DISCLOSURES.map((d) => ({ ...d }));
}

export async function listIndicators(input: { context: UserContext; organizationId: string; fiscalYear: string }) {
  requirePermissions(input.context, ["compliance.configure"]);
  return prisma.esrsIndicator.findMany({
    where: { organizationId: input.organizationId, fiscalYear: input.fiscalYear },
    orderBy: [{ standardCode: "asc" }, { disclosureCode: "asc" }]
  });
}

export async function upsertIndicator(input: {
  context: UserContext;
  payload: {
    organizationId: string;
    propertyId?: string | null;
    fiscalYear: string;
    standardCode: string;
    disclosureCode: string;
    numericValue?: number;
    textValue?: string;
    unit?: string;
    source?: string;
    metadataJson?: Record<string, unknown>;
  };
}) {
  requirePermissions(input.context, ["compliance.configure"]);
  const p = input.payload;
  const disclosure = ESRS_DISCLOSURES.find((d) => d.code === p.disclosureCode);
  if (!disclosure) throw new BadRequestError(`Disclosure code unknown: ${p.disclosureCode}`);
  // Compound unique with a nullable column — Prisma's typing rejects null but
  // it's valid at runtime. Cast through unknown for this known pattern.
  return prisma.esrsIndicator.upsert({
    where: {
      organizationId_propertyId_fiscalYear_disclosureCode: {
        organizationId: p.organizationId,
        propertyId: p.propertyId ?? null,
        fiscalYear: p.fiscalYear,
        disclosureCode: p.disclosureCode
      } as unknown as { organizationId: string; propertyId: string; fiscalYear: string; disclosureCode: string }
    },
    create: {
      organizationId: p.organizationId,
      propertyId: p.propertyId ?? null,
      fiscalYear: p.fiscalYear,
      standardCode: p.standardCode,
      disclosureCode: p.disclosureCode,
      valueType: p.numericValue !== undefined ? "NUMERIC" : "TEXT",
      numericValue: p.numericValue ?? null,
      textValue: p.textValue ?? null,
      unit: p.unit ?? disclosure.unit ?? "n/a",
      source: p.source ?? "manual",
      metadataJson: p.metadataJson as unknown as object | undefined
    },
    update: {
      numericValue: p.numericValue ?? null,
      textValue: p.textValue ?? null,
      unit: p.unit ?? disclosure.unit,
      source: p.source ?? "manual",
      metadataJson: p.metadataJson as unknown as object | undefined,
      computedAt: new Date()
    }
  });
}

// ---------------------------------------------------------------------------
// Generador del informe
// ---------------------------------------------------------------------------

export async function generateReport(input: {
  context: UserContext;
  organizationId: string;
  fiscalYear: string;
}) {
  requirePermissions(input.context, ["compliance.configure"]);

  const indicators = await prisma.esrsIndicator.findMany({
    where: { organizationId: input.organizationId, fiscalYear: input.fiscalYear }
  });

  // Calcular completeness % sobre los disclosures `required`.
  const requiredCodes: string[] = ESRS_DISCLOSURES.filter((d) => d.required).map((d) => d.code);
  const reportedRequired = indicators.filter((i) => requiredCodes.includes(i.disclosureCode)).length;
  const completenessPct = requiredCodes.length > 0
    ? Math.round((reportedRequired / requiredCodes.length) * 1000) / 10
    : 0;

  // Agrupar por estándar para el resumen.
  const byStandard: Record<string, { reported: number; required: number; values: Array<{ code: string; value: unknown; unit: string | null }> }> = {};
  for (const d of ESRS_DISCLOSURES) {
    if (!byStandard[d.standard]) byStandard[d.standard] = { reported: 0, required: 0, values: [] };
    if (d.required) byStandard[d.standard].required += 1;
  }
  for (const ind of indicators) {
    const standardKey = ind.standardCode;
    if (!byStandard[standardKey]) byStandard[standardKey] = { reported: 0, required: 0, values: [] };
    byStandard[standardKey].reported += 1;
    byStandard[standardKey].values.push({
      code: ind.disclosureCode,
      value: ind.numericValue ? Number(ind.numericValue) : ind.textValue,
      unit: ind.unit
    });
  }

  const summary = {
    organizationId: input.organizationId,
    fiscalYear: input.fiscalYear,
    totalIndicators: indicators.length,
    requiredDisclosures: requiredCodes.length,
    reportedRequired,
    completenessPct,
    standards: byStandard,
    generatedAt: new Date().toISOString()
  };

  // Hash del contenido para integridad.
  const hash = createHash("sha256").update(JSON.stringify(summary)).digest("base64");

  const report = await prisma.esrsReport.upsert({
    where: { organizationId_fiscalYear: { organizationId: input.organizationId, fiscalYear: input.fiscalYear } },
    create: {
      organizationId: input.organizationId,
      fiscalYear: input.fiscalYear,
      status: completenessPct === 100 ? "ready" : "draft",
      format: "json",
      contentHash: hash,
      summaryJson: summary as unknown as object,
      generatedBy: input.context.userId
    },
    update: {
      status: completenessPct === 100 ? "ready" : "draft",
      contentHash: hash,
      summaryJson: summary as unknown as object,
      generatedAt: new Date(),
      generatedBy: input.context.userId
    }
  });

  return { report, summary };
}

export async function getReport(input: { context: UserContext; organizationId: string; fiscalYear: string }) {
  requirePermissions(input.context, ["compliance.configure"]);
  const r = await prisma.esrsReport.findUnique({
    where: { organizationId_fiscalYear: { organizationId: input.organizationId, fiscalYear: input.fiscalYear } }
  });
  if (!r) throw new NotFoundError("Report not generated yet.");
  return r;
}
