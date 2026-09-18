// Tenant mirrors + per-property settings provisioning (Tanda 1).
//
// Several legacy guards are synchronous and read the in-memory demoStore only
// (requirePropertyAccess / requireAdvancedModuleEnabled in advanced-modules,
// getComplianceSettings in backoffice…). Properties that only exist in Prisma
// (Faranda cmrhw9jy40003fyvbuu2ec2w7, tenants created by createTenant) were
// therefore answered with 500 until some other flow happened to hydrate the
// mirror. server.ts calls hydrateTenantMirrors() once at boot (after the
// production guards) and createTenant/bootstrapPilot mirror the rows they just
// created, so a new hotel is usable without a restart.
//
// Rules:
//   - MERGE by id, never replace: prop_456 exists only in the seed and several
//     flows/tests rely on it (the tenancy hook keeps it unreachable over HTTP).
//   - Prisma is the source of truth: a DB row wins over the seed fixture with
//     the same id.
//   - No invented data: nullable DB columns map to `undefined`, never to demo
//     values.
//
// demoStore has a singular `organization` (org_123) and no `organizations`
// collection (lib/demo-store.ts is owned by another group), so organizations
// are mirrored into `organizationMirror` below; once DemoStore grows an
// `organizations: OrganizationRecord[]` collection this Map can be dropped.

import { prisma } from "@hotelos/database";
import {
  TAX_CATEGORIES,
  TAX_FIGURE_NAMES,
  figureForRegion,
  normalizeTaxRegion,
  rateCodeFor,
  statutoryRate,
  type TaxRegion
} from "@hotelos/compliance";
import {
  demoStore,
  type OrganizationRecord,
  type PropertyAiSettingsRecord,
  type PropertyComplianceSettingsRecord,
  type PropertyRecord
} from "./demo-store.js";
import { NotFoundError } from "./http-error.js";
import { hydrateAllPropertyModules } from "../modules/product-modules/product-modules.service.js";
import { ensureCategoryDefinitions } from "../modules/backoffice/categories.store.js";
import { invalidateTaxCache, planCatalogProvisioning } from "../modules/accounting/tax-rate.service.js";

export type TenantHydrationResult = {
  properties: number;
  organizations: number;
  modules: number;
};

// ---------------------------------------------------------------------------
// Row → record mappers (same shapes as the seed fixtures)
// ---------------------------------------------------------------------------

type PropertyRow = NonNullable<Awaited<ReturnType<typeof prisma.property.findUnique>>>;
type OrganizationRow = NonNullable<Awaited<ReturnType<typeof prisma.organization.findUnique>>>;
type PropertyAiSettingRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyAiSetting.findUnique>>>;
type PropertyComplianceSettingRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyComplianceSetting.findUnique>>>;

function toPropertyRecord(row: PropertyRow): PropertyRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    legalName: row.legalName ?? undefined,
    address: row.address ?? undefined,
    municipality: row.municipality ?? undefined,
    province: row.province ?? undefined,
    timezone: row.timezone,
    country: row.country,
    taxRegion: row.taxRegion ?? undefined,
    sesHospedajesEnabled: row.sesHospedajesEnabled,
    verifactuEnabled: row.verifactuEnabled
  };
}

function toOrganizationRecord(row: OrganizationRow): OrganizationRecord {
  // OrganizationRecord declares legalName/taxId as required strings (seed
  // shape); a tenant without them mirrors as "" so nothing demo leaks in.
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName ?? "",
    taxId: row.taxId ?? ""
  };
}

function toConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toAiSettingsRecord(row: PropertyAiSettingRow): PropertyAiSettingsRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    aiEnabled: row.aiEnabled,
    defaultAutomationLevel: row.defaultAutomationLevel as PropertyAiSettingsRecord["defaultAutomationLevel"],
    guestFacingDisclosure: row.guestFacingDisclosure ?? undefined,
    voiceLocales: Array.isArray(row.voiceLocales) ? row.voiceLocales : [],
    configurationJson: toConfig(row.configurationJson),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toComplianceSettingsRecord(row: PropertyComplianceSettingRow): PropertyComplianceSettingsRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    country: row.country,
    taxRegion: row.taxRegion ?? undefined,
    vatRegime: row.vatRegime ?? undefined,
    tourismTaxRegion: row.tourismTaxRegion ?? undefined,
    sesHospedajesEnabled: row.sesHospedajesEnabled,
    verifactuEnabled: row.verifactuEnabled,
    ticketbaiEnabled: row.ticketbaiEnabled,
    siiEnabled: row.siiEnabled,
    b2bEinvoiceEnabled: row.b2bEinvoiceEnabled,
    configurationJson: toConfig(row.configurationJson),
    updatedAt: row.updatedAt.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Mirrors
// ---------------------------------------------------------------------------

/** Insert-or-update in place (keeps object identity so sync readers holding a reference see the update). */
function mergeRecord<T extends { id: string }>(collection: T[], record: T, match?: (candidate: T) => boolean): T {
  const existing = collection.find(match ?? ((candidate) => candidate.id === record.id));
  if (existing) {
    Object.assign(existing, record);
    return existing;
  }
  collection.push(record);
  return record;
}

/**
 * Organizations by id. Seeded with the demo organization so readers get one
 * lookup for both demo and real tenants. See header note about demo-store.ts.
 */
export const organizationMirror = new Map<string, OrganizationRecord>([[demoStore.organization.id, demoStore.organization]]);

/** Mirror one Prisma organization row (merge by id). */
export function mirrorOrganization(row: OrganizationRow): OrganizationRecord {
  const record = toOrganizationRecord(row);
  const existing = organizationMirror.get(record.id);
  if (existing) {
    // Keep the seed's non-empty legalName/taxId when the DB column is null:
    // the demo fixtures are the only place those values live for org_123.
    Object.assign(existing, {
      name: record.name,
      legalName: record.legalName || existing.legalName,
      taxId: record.taxId || existing.taxId
    });
    return existing;
  }
  organizationMirror.set(record.id, record);
  return record;
}

/** Mirror one Prisma property row into demoStore.properties (merge by id). */
export function mirrorProperty(row: PropertyRow): PropertyRecord {
  return mergeRecord(demoStore.properties, toPropertyRecord(row));
}

function mirrorAiSettings(row: PropertyAiSettingRow): PropertyAiSettingsRecord {
  // One row per property (unique propertyId): match by propertyId so a seed
  // fixture with a legacy id (ai_prop_123) converges to the DB row.
  return mergeRecord(demoStore.propertyAiSettings, toAiSettingsRecord(row), (candidate) => candidate.propertyId === row.propertyId);
}

function mirrorComplianceSettings(row: PropertyComplianceSettingRow): PropertyComplianceSettingsRecord {
  return mergeRecord(
    demoStore.propertyComplianceSettings,
    toComplianceSettingsRecord(row),
    (candidate) => candidate.propertyId === row.propertyId
  );
}

/** Merge (by id, never replace) Prisma properties/organizations/property modules into the in-memory mirrors. */
export async function hydrateTenantMirrors(): Promise<TenantHydrationResult> {
  const [organizations, properties, aiSettings, complianceSettings] = await Promise.all([
    prisma.organization.findMany(),
    prisma.property.findMany(),
    prisma.propertyAiSetting.findMany(),
    prisma.propertyComplianceSetting.findMany()
  ]);

  for (const row of organizations) mirrorOrganization(row);
  for (const row of properties) mirrorProperty(row);
  // Settings rows are mirrored too: backoffice getComplianceSettings is still a
  // synchronous demoStore reader, and the AI settings mirror feeds the
  // dashboard aiStatus. Not counted in the result (contract: 3 counters).
  for (const row of aiSettings) mirrorAiSettings(row);
  for (const row of complianceSettings) mirrorComplianceSettings(row);

  const modules = await hydrateAllPropertyModules();

  // Tanda L2 (L2-04): the category catalogue is persisted in category_definitions
  // (upsert by code, once per process) so the category manager and the setup
  // forms read Prisma rows. Nothing persisted is hydrated back into memory.
  // Lazy import: backoffice.service.ts imports this module (ensurePropertyTaxes),
  // so a static import here would create a load-time cycle.
  const { CATEGORY_DEFINITION_CATALOG } = await import("../modules/backoffice/backoffice.service.js");
  await ensureCategoryDefinitions(CATEGORY_DEFINITION_CATALOG);

  return { properties: properties.length, organizations: organizations.length, modules };
}

// ---------------------------------------------------------------------------
// Per-property settings provisioning (CFG-P1-4)
// ---------------------------------------------------------------------------

// Same text as property-ai.service.ts DEFAULT_DISCLOSURE (not exported there)
// and the flagship seed: both surfaces must agree on the default disclosure.
const DEFAULT_AI_DISCLOSURE =
  "Parte de la atención de este establecimiento puede estar gestionada por un asistente de inteligencia artificial. " +
  "Puede solicitar hablar con una persona del equipo en cualquier momento.\n" +
  "Some interactions at this property may be handled by an AI assistant. " +
  "You can ask to speak with a member of our team at any time.";

/** Idempotently create the default PropertyAiSetting / PropertyComplianceSetting rows for a property. */
export async function ensurePropertySettings(propertyId: string): Promise<void> {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property) {
    throw new NotFoundError("Propiedad no encontrada.");
  }

  // upsert with an empty update keeps existing rows untouched (idempotent and
  // safe if two replicas provision the same property).
  const [ai, compliance] = await Promise.all([
    prisma.propertyAiSetting.upsert({
      where: { propertyId },
      update: {},
      create: {
        propertyId,
        aiEnabled: true,
        defaultAutomationLevel: "suggest_and_confirm",
        guestFacingDisclosure: DEFAULT_AI_DISCLOSURE,
        voiceLocales: ["es-ES", "en-GB"],
        configurationJson: {}
      }
    }),
    prisma.propertyComplianceSetting.upsert({
      where: { propertyId },
      update: {},
      create: {
        propertyId,
        // Derived from the property itself, not from the demo hotel.
        country: property.country,
        taxRegion: property.taxRegion,
        sesHospedajesEnabled: property.sesHospedajesEnabled,
        verifactuEnabled: property.verifactuEnabled,
        ticketbaiEnabled: false,
        siiEnabled: false,
        b2bEinvoiceEnabled: false,
        configurationJson: {}
      }
    })
  ]);

  mirrorProperty(property);
  mirrorAiSettings(ai);
  mirrorComplianceSettings(compliance);

  // Tanda 3: indirect-tax catalogue per (organization, region). A failure
  // here must not leave the tenant half-created (the property row already
  // exists): log with the property id and let the operator re-run
  // POST /backoffice/properties/:propertyId/taxes/provision.
  try {
    await ensurePropertyTaxes({ propertyId, organizationId: property.organizationId });
  } catch (error) {
    console.error(`[tenant-hydration] ensurePropertyTaxes failed for property ${propertyId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Indirect-tax provisioning (Tanda 3 · contract C)
// ---------------------------------------------------------------------------

export type EnsurePropertyTaxesResult = {
  /** Canonical region persisted for the property; null when it cannot be derived (nothing provisioned). */
  taxRegion: TaxRegion | null;
  /** TaxRate rows created in this call (includes `repaired`). */
  provisioned: number;
  /** Categories that already had a row in force today (left untouched — manual overrides survive). */
  skipped: number;
  /** Subset of `provisioned`: catalogue rows written from today because the category's rows were all closed or future. */
  repaired: number;
};

/**
 * Idempotently provision the statutory catalogue for a property:
 *   1. region = normalizeTaxRegion(taxRegion ?? property.taxRegion, property.province);
 *      a non-canonical stored value is normalised and PERSISTED on
 *      Property.taxRegion and PropertyComplianceSetting.taxRegion (never '');
 *      when no region can be derived nothing is written and taxRegion is null;
 *   2. upsert Tax by (organizationId, figure code, region) with the VeriFactu
 *      Impuesto code;
 *   3. create one TaxRate per fiscal category (appliesTo = category, source
 *      "catalog", legalBasis from the doc) unless the category already has an
 *      active row IN FORCE today (validFrom <= today, validTo null or >= today).
 *      A category that never had a row gets validFrom 2000-01-01 (legacy seed
 *      shape); one whose rows are all closed (a statutory row ended by a manual
 *      override that was later superseded and never replaced) or future gets a
 *      row from today, closed the day before the next future row
 *      (planCatalogProvisioning). Idempotent: a second run skips everything.
 * Called from ensurePropertySettings (createTenant / bootstrapPilot), the
 * provision endpoint, the seeds and the backfill.
 */
export async function ensurePropertyTaxes(input: {
  propertyId: string;
  organizationId?: string;
  taxRegion?: string | null;
}): Promise<EnsurePropertyTaxesResult> {
  const property = await prisma.property.findUnique({
    where: { id: input.propertyId },
    select: { id: true, organizationId: true, taxRegion: true, province: true }
  });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const organizationId = input.organizationId ?? property.organizationId;
  const rawRegion = input.taxRegion !== undefined ? input.taxRegion : property.taxRegion;
  const region = normalizeTaxRegion(rawRegion, property.province);
  if (region === null) {
    console.warn(`[tenant-hydration] property ${property.id} has no tax region or province to derive it from: taxes not provisioned.`);
    return { taxRegion: null, provisioned: 0, skipped: 0, repaired: 0 };
  }

  // Persist the canonical region (Property + compliance mirror). Never ''.
  if (property.taxRegion !== region) {
    const updated = await prisma.property.update({ where: { id: property.id }, data: { taxRegion: region } });
    mirrorProperty(updated);
  }
  const compliance = await prisma.propertyComplianceSetting.findUnique({ where: { propertyId: property.id } });
  if (compliance && compliance.taxRegion !== region) {
    const updated = await prisma.propertyComplianceSetting.update({ where: { propertyId: property.id }, data: { taxRegion: region } });
    mirrorComplianceSettings(updated);
  }

  const { figure, impuesto } = figureForRegion(region);
  const tax = await prisma.tax.upsert({
    where: { organizationId_code_taxRegion: { organizationId, code: figure, taxRegion: region } },
    // Fill the Impuesto code on rows provisioned before Tanda 3; nothing else changes.
    update: { verifactuImpuesto: impuesto },
    create: {
      organizationId,
      code: figure,
      name: TAX_FIGURE_NAMES[figure],
      country: "ES",
      taxRegion: region,
      liabilityAccountCode: "477",
      verifactuImpuesto: impuesto,
      source: "catalog"
    }
  });

  // Coverage is decided on the validity window, not on row existence: a
  // statutory row closed by a manual override that was later superseded
  // (validTo in the past, no successor) leaves the category uncovered and
  // must be repaired with a row from today (Faranda general_services after
  // the Tanda 3 verification run).
  const existing = await prisma.taxRate.findMany({
    where: { taxId: tax.id, active: true, category: { in: [...TAX_CATEGORIES] } },
    select: { category: true, appliesTo: true, validFrom: true, validTo: true }
  });
  const plan = planCatalogProvisioning(existing, new Date());

  let provisioned = 0;
  let repaired = 0;
  for (const entry of plan.missing) {
    const spec = statutoryRate(region, entry.category);
    const rateCode = rateCodeFor(figure, spec.percent, spec.calificacion);
    await prisma.taxRate.upsert({
      where: { taxId_rateCode_appliesTo_validFrom: { taxId: tax.id, rateCode, appliesTo: entry.category, validFrom: entry.validFrom } },
      // An inactive row with the same key (superseded by a manual override
      // that was later removed) is revived as a catalogue row rather than
      // duplicated.
      update: {
        active: true,
        validTo: entry.validTo,
        ratePercent: spec.percent,
        category: entry.category,
        calificacion: spec.calificacion,
        verifyAgainstOrdinance: spec.verifyAgainstOrdinance,
        source: "catalog",
        legalBasis: spec.legalBasis
      },
      create: {
        taxId: tax.id,
        rateCode,
        ratePercent: spec.percent,
        appliesTo: entry.category,
        validFrom: entry.validFrom,
        validTo: entry.validTo,
        active: true,
        category: entry.category,
        calificacion: spec.calificacion,
        verifyAgainstOrdinance: spec.verifyAgainstOrdinance,
        source: "catalog",
        legalBasis: spec.legalBasis
      }
    });
    provisioned++;
    if (entry.repair) repaired++;
  }

  invalidateTaxCache(property.id);
  return { taxRegion: region, provisioned, skipped: plan.covered.length, repaired };
}
