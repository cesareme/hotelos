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
  demoStore,
  type OrganizationRecord,
  type PropertyAiSettingsRecord,
  type PropertyComplianceSettingsRecord,
  type PropertyRecord
} from "./demo-store.js";
import { NotFoundError } from "./http-error.js";
import { hydrateAllPropertyModules } from "../modules/product-modules/product-modules.service.js";

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
}
