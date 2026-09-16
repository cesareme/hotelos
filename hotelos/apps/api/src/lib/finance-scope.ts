// Finance scope and legal identity (Tanda 6b · L1 · estructura societaria).
//
// Grupo (Organization) → Sociedad (LegalEntity = NIF) → Centro de trabajo
// (Property.kind). Three indirections the finance modules program against so
// the holding phase changes ONE place instead of ~800 `organizationId` reads:
//
//   resolveLegalIdentity(organizationId)
//       The single reader of the issuer / declarant identity: NIF, razón social,
//       domicilio fiscal, PGC variant, SII regime, chain policy. It is the ONLY
//       module of Finanzas allowed to read the deprecated Organization.taxId /
//       Organization.legalName columns — and only as the fallback for a tenant
//       whose implicit legal entity has not been backfilled yet (`source:
//       "organization_fallback"`). tests/legal-identity-readers-contract.test.mjs
//       greps every finance module for direct reads.
//
//   resolveLedgerScope(context, { legalEntityId?, propertyId? })
//       The single point that turns a request into a ledger scope. In this tanda
//       an organization has EXACTLY one legal entity (design §5.2 R10.7), so the
//       scope is always that entity, optionally filtered by a work centre; any
//       other `legalEntityId` is an opaque 404 (no existence oracle). The holding
//       phase makes this function demand an active legal entity when several
//       exist (400 LEGAL_ENTITY_REQUIRED) — callers do not change.
//
//   listOperationalProperties(organizationId)
//       The ONLY `kind = hotel` filter for night audit, portfolio, occupancy,
//       tourist tax, SES and per-room KPIs (design §5.2 R6): an `office` / `other`
//       centre never enters an operational loop. L2 re-exports it from
//       lib/tenancy.ts; the implementation lives here.
//
// Pure helpers (`isOperationalKind`, `filterOperationalProperties`,
// `deriveStructureMode`, `isStructureEnabled`) take no database so they can be
// unit-tested and reused by in-memory mirrors (demoStore.properties).
//
// Design: docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md §5.1 (decisión 2), §5.2
// R2 / R6 / R10. Data contract: docs/runbooks/finanzas-contabilidad.md §17.

import { prisma } from "@hotelos/database";
import { isValidSpanishTaxId, normalizeTaxId } from "@hotelos/compliance";
import { NotFoundError } from "./http-error.js";
import type { UserContext } from "./demo-store.js";
import type {
  LegalIdentityDto,
  PermissionKey,
  PropertyKind,
  StructureMode
} from "@hotelos/shared";

export type LegalIdentity = LegalIdentityDto;

/** Subset of the Prisma client the resolvers touch (unit tests pass in-memory fakes). */
export type FinanceDb = Pick<typeof prisma, "legalEntity" | "organization" | "property">;

/** The part of the user context the scope resolution reads. */
export type ScopeContext = Pick<UserContext, "organizationId"> & Partial<Pick<UserContext, "assignedPropertyIds" | "isPlatformAdmin">>;

const ORGANIZATION_NOT_FOUND = "Organización no encontrada.";
const LEGAL_ENTITY_NOT_FOUND = "Sociedad no encontrada.";
const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";

// ---------------------------------------------------------------------------
// STRUCTURE_ENABLED kill-switch
// ---------------------------------------------------------------------------

/**
 * `STRUCTURE_ENABLED` (apps/api/src/lib/env.ts): unset / empty / "true" / "1" →
 * enabled (default); "false" / "0" → the API behaves as a single hotel (no
 * «Sociedad» scope, no office in the switcher, structure routes 404). Tables,
 * backfill and `resolveLegalIdentity` never depend on it.
 */
export function isStructureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.STRUCTURE_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw === "true" || raw === "1";
}

// ---------------------------------------------------------------------------
// Legal identity (single reader)
// ---------------------------------------------------------------------------

type LegalEntityRow = NonNullable<Awaited<ReturnType<typeof prisma.legalEntity.findFirst>>>;

function identityFromEntity(entity: LegalEntityRow): LegalIdentity {
  const taxId = normalizeTaxId(entity.taxId);
  return {
    legalEntityId: entity.id,
    organizationId: entity.organizationId,
    code: entity.code,
    legalName: entity.legalName,
    taxId,
    taxIdValid: isValidSpanishTaxId(taxId),
    source: "legal_entity",
    legalForm: entity.legalForm ?? null,
    fiscalAddress: entity.fiscalAddress ?? null,
    fiscalPostalCode: entity.fiscalPostalCode ?? null,
    fiscalMunicipality: entity.fiscalMunicipality ?? null,
    fiscalIneCode: entity.fiscalIneCode ?? null,
    fiscalProvince: entity.fiscalProvince ?? null,
    pgcVariant: entity.pgcVariant,
    largeCompany: entity.largeCompany,
    siiEnabled: entity.siiEnabled,
    verifactuChainScope: entity.verifactuChainScope,
    cccPrincipal: entity.cccPrincipal ?? null
  };
}

/** The organization's default (and, in this tanda, only) active legal entity, or null before the backfill. */
export async function findDefaultLegalEntity(organizationId: string, db: FinanceDb = prisma): Promise<LegalEntityRow | null> {
  return db.legalEntity.findFirst({
    where: { organizationId, isDefault: true, status: "active" },
    orderBy: { createdAt: "asc" }
  });
}

/**
 * Issuer / declarant identity of an organization. Null only when the
 * organization itself does not exist. Never throws for a missing NIF: callers
 * decide (409 ISSUER_TAX_ID_MISSING on issuance, «NIF pendiente» in the UI).
 */
export async function resolveLegalIdentity(organizationId: string, db: FinanceDb = prisma): Promise<LegalIdentity | null> {
  const entity = await findDefaultLegalEntity(organizationId, db);
  if (entity) return identityFromEntity(entity);

  // Fallback for a tenant without a backfilled legal entity. This is the single
  // permitted read of the deprecated Organization.taxId / legalName columns.
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, legalName: true, taxId: true }
  });
  if (!organization) return null;
  const taxId = normalizeTaxId(organization.taxId);
  return {
    legalEntityId: null,
    organizationId: organization.id,
    code: null,
    legalName: organization.legalName ?? organization.name,
    taxId,
    taxIdValid: isValidSpanishTaxId(taxId),
    source: "organization_fallback",
    legalForm: null,
    fiscalAddress: null,
    fiscalPostalCode: null,
    fiscalMunicipality: null,
    fiscalIneCode: null,
    fiscalProvince: null,
    pgcVariant: "pymes",
    largeCompany: false,
    siiEnabled: false,
    verifactuChainScope: "per_center",
    cccPrincipal: null
  };
}

/** Same as resolveLegalIdentity, 404 (opaque) when the organization does not exist. */
export async function requireLegalIdentity(organizationId: string, db: FinanceDb = prisma): Promise<LegalIdentity> {
  const identity = await resolveLegalIdentity(organizationId, db);
  if (!identity) throw new NotFoundError(ORGANIZATION_NOT_FOUND);
  return identity;
}

// ---------------------------------------------------------------------------
// Ledger scope
// ---------------------------------------------------------------------------

export type LedgerScopeInput = {
  /** Explicit legal entity (fase holding). In this tanda it must be the default one or absent. */
  legalEntityId?: string | null;
  /** Work-centre filter (informative views); null / absent = the whole sociedad. */
  propertyId?: string | null;
};

export type LedgerScope = {
  kind: "entity" | "property";
  organizationId: string;
  /** Null until the organization's implicit legal entity is backfilled (identity.source tells). */
  legalEntityId: string | null;
  identity: LegalIdentity;
  /** Centre filter; null = the whole legal entity. */
  propertyId: string | null;
  propertyKind: PropertyKind | null;
};

/**
 * Mirror of `isPropertyAssigned` (lib/tenancy.ts): a context without
 * assignments keeps the organization-wide scope; otherwise the property must
 * be one the user holds a role in. Kept local so lib/tenancy.ts can re-export
 * `listOperationalProperties` from here without an import cycle; the unit test
 * asserts parity with the tenancy predicate.
 */
export function propertyWithinScope(context: Pick<ScopeContext, "assignedPropertyIds" | "isPlatformAdmin">, propertyId: string): boolean {
  if (context.isPlatformAdmin) return true;
  const assigned = context.assignedPropertyIds;
  if (!assigned || assigned.length === 0) return true;
  return assigned.includes(propertyId);
}

// ---------------------------------------------------------------------------
// Whole-sociedad read / write scope (design §5.2 R11) — moved here from
// modules/accounting/ledger.routes.ts (integration, Tanda 6b) so that no
// service imports a routes module; ledger.routes.ts re-exports them.
// ---------------------------------------------------------------------------

export const ENTITY_READ_PERMISSION: PermissionKey = "accounting.entity.read";

export type FinanceScopeContext = Pick<UserContext, "permissions"> & Partial<Pick<UserContext, "assignedPropertyIds" | "isPlatformAdmin">>;

/**
 * True when the context may read the finances of the WHOLE sociedad: platform
 * admin, holder of `accounting.entity.read`, or a context without property
 * assignments (organization-wide by construction — demo fallback, owners
 * without user_property_roles — exactly like `isPropertyAssigned`).
 */
export function hasEntityReadScope(context: FinanceScopeContext): boolean {
  if (context.isPlatformAdmin) return true;
  if (context.permissions.includes(ENTITY_READ_PERMISSION)) return true;
  const assigned = context.assignedPropertyIds;
  return !assigned || assigned.length === 0;
}

const ENTITY_SCOPE_UNAVAILABLE = "Ámbito no disponible: indica el centro de trabajo asignado (propertyId).";

/**
 * Guard of every finance read with amounts. With a `propertyId` the centre
 * must be within the caller's scope (the global tenant hook already grants
 * it for HTTP callers; direct service callers get the same opaque 404).
 * Without one, the caller needs the whole-sociedad scope; otherwise a 404
 * with `details.code = ENTITY_SCOPE_REQUIRED` — the same status the sister
 * centre gets, so neither answer is an oracle of the sociedad's structure.
 */
export function assertFinanceReadScope(context: FinanceScopeContext, propertyId: string | null | undefined): void {
  if (propertyId) {
    if (!propertyWithinScope(context, propertyId)) throw new NotFoundError(PROPERTY_NOT_FOUND);
    return;
  }
  if (hasEntityReadScope(context)) return;
  const error = new NotFoundError(ENTITY_SCOPE_UNAVAILABLE);
  error.details = { code: "ENTITY_SCOPE_REQUIRED", requiredPermission: ENTITY_READ_PERMISSION };
  throw error;
}

/**
 * Guard of a finance WRITE (posting / reversing a manual asiento): the same
 * rule as the reads. Without a `propertyId` the asiento belongs to the whole
 * sociedad (society-level, `property_id NULL`) and needs `accounting.entity.read`
 * (or an organization-wide context); with one, that centre must be within
 * scope. The 404 is as opaque as in the reads (`ENTITY_SCOPE_REQUIRED`).
 */
export function assertFinanceWriteScope(context: FinanceScopeContext, propertyId: string | null | undefined): void {
  assertFinanceReadScope(context, propertyId);
}

/** Several centres at once (USALI compare, PyG por centro): each one must be within scope, or the whole sociedad. */
export function assertFinanceReadScopeMany(context: FinanceScopeContext, propertyIds: readonly string[] | null | undefined): void {
  if (!propertyIds || propertyIds.length === 0) {
    assertFinanceReadScope(context, null);
    return;
  }
  for (const propertyId of propertyIds) assertFinanceReadScope(context, propertyId);
}

/**
 * Resolve the ledger scope of a request. Plan, journal, VAT books, AEAT models,
 * fiscal years and annual accounts stay keyed by `organizationId`; this is the
 * one place that says WHICH legal entity that organization id stands for.
 */
export async function resolveLedgerScope(context: ScopeContext, input: LedgerScopeInput = {}, db: FinanceDb = prisma): Promise<LedgerScope> {
  const identity = await requireLegalIdentity(context.organizationId, db);
  if (input.legalEntityId && input.legalEntityId !== identity.legalEntityId) {
    // One legal entity per organization in this tanda: any other id is opaque.
    throw new NotFoundError(LEGAL_ENTITY_NOT_FOUND);
  }
  const base = { organizationId: context.organizationId, legalEntityId: identity.legalEntityId, identity };
  if (!input.propertyId) return { ...base, kind: "entity", propertyId: null, propertyKind: null };

  const property = await db.property.findUnique({
    where: { id: input.propertyId },
    select: { id: true, organizationId: true, legalEntityId: true, kind: true }
  });
  if (!property || property.organizationId !== context.organizationId) throw new NotFoundError(PROPERTY_NOT_FOUND);
  if (!propertyWithinScope(context, property.id)) throw new NotFoundError(PROPERTY_NOT_FOUND);
  if (identity.legalEntityId && property.legalEntityId && property.legalEntityId !== identity.legalEntityId) {
    // Invariant R10.1: a property belongs to a legal entity of its own organization.
    throw new NotFoundError(PROPERTY_NOT_FOUND);
  }
  return { ...base, kind: "property", propertyId: property.id, propertyKind: property.kind };
}

// ---------------------------------------------------------------------------
// Operational properties (kind = hotel)
// ---------------------------------------------------------------------------

/** A row without `kind` (legacy in-memory mirror) is a hotel: the column default. */
export function isOperationalKind(kind: PropertyKind | string | null | undefined): boolean {
  return (kind ?? "hotel") === "hotel";
}

/** Pure filter for in-memory collections (demoStore.properties, hydrated tenant mirrors). */
export function filterOperationalProperties<T extends { kind?: PropertyKind | string | null }>(rows: readonly T[]): T[] {
  return rows.filter((row) => isOperationalKind(row.kind));
}

export type OperationalProperty = {
  id: string;
  organizationId: string;
  legalEntityId: string | null;
  code: string | null;
  name: string;
  kind: PropertyKind;
  status: string;
  timezone: string;
};

const OPERATIONAL_SELECT = {
  id: true,
  organizationId: true,
  legalEntityId: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  timezone: true
} as const;

/**
 * Hotels of an organization (kind = hotel), oldest first. Offices and other
 * non-lodging centres are excluded: they have no rooms, rates, POS, tourist tax
 * or SES, and a per-room KPI over them must render a DegradedValue, never 0.
 */
export async function listOperationalProperties(
  organizationId: string,
  db: FinanceDb = prisma,
  options: { includeClosed?: boolean } = {}
): Promise<OperationalProperty[]> {
  return db.property.findMany({
    where: { organizationId, kind: "hotel", ...(options.includeClosed ? {} : { status: { not: "closed" } }) },
    select: OPERATIONAL_SELECT,
    orderBy: { createdAt: "asc" }
  });
}

// ---------------------------------------------------------------------------
// Structure mode
// ---------------------------------------------------------------------------

/** `GET /organizations/me/structure → mode` (L2): pure over the counts. */
export function deriveStructureMode(counts: { legalEntities: number; properties: number }): StructureMode {
  if (counts.legalEntities >= 2) return "group";
  if (counts.properties >= 2) return "multi_center";
  return "single_hotel";
}
