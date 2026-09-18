// Estructura societaria · L2 · Sociedad (LegalEntity) service.
//
// Grupo (Organization) → Sociedad (LegalEntity = NIF) → Centro de trabajo
// (Property.kind). This module is the ONLY writer of the legal entity: NIF,
// razón social, domicilios, forma jurídica, régimen (largeCompany / siiEnabled),
// plantilla PGC and — from the platform console only — the VeriFactu chain
// policy. Rules it enforces (design §5.2):
//
//   R10.7  exactly one legal entity per organization in this tanda:
//          POST /legal-entities creates the FIRST one (a tenant created before
//          the backfill) and answers 409 MULTI_ENTITY_NOT_ENABLED afterwards.
//   R11    `organization.structure.manage` for every write; the fields that
//          re-qualify the WHOLE NIF are high risk: `ai.high_risk.confirm` + an
//          explicit `confirmHighRisk: true` (409 HIGH_RISK_CONFIRMATION_REQUIRED
//          { field, fields, changes }) + audit with before/after:
//            - taxId (change or clearing) and legalName — issuer identity of every
//              future invoice of every centre (RD 1619/2012 art. 6.1.c, R2);
//            - siiEnabled, largeCompany — regime of the sociedad (R8): monthly 303
//              / 111 / 115 (RIVA art. 71.3), 347 and 390 «no se presenta», VeriFactu
//              excluded (RD 1007/2023 art. 3.3);
//            - pgcVariant — depositable annual-accounts format (LSC 257-258, R9);
//            - fiscalYearStartMonth — the ejercicio social of the sociedad (LSC
//              art. 26) that fiscal years, closing and opening entries follow.
//          The regime fields live in «IVA y ejercicio» (design §5.3) and need
//          `accounting.configure` besides the structure permission. Same-value
//          writes are not changes. `siiEnabled: true` is refused (409
//          VERIFACTU_SUBMISSIONS_PENDING) while a REAL VeriFactu record of the
//          sociedad has no definitive answer: the SII excludes the sociedad from
//          the RRSIF and the queue would never be sent.
//   R2     the NIF is normalised and checksum-validated (400 TAX_ID_INVALID) and
//          unique across legal entities (409 TAX_ID_IN_USE, no oracle about the
//          other tenant). Issued invoices keep their snapshot (trigger, L1).
//   R7     the chain policy (per_center | per_entity) is set from the platform
//          console (`admin.tenants.manage`), needs `confirm: true` and is
//          immutable once a REAL record (mode preproduction / production) was
//          sent: 409 CHAIN_ALREADY_STARTED. Sandbox and legacy stub records
//          (mode null) never block it. Changing the scope never re-chains:
//          installations are retired / opened by the issuing side (L3).
//
// Reads go through the L1 helpers (resolveLegalIdentity, findDefaultLegalEntity,
// deriveStructureMode, isStructureEnabled); the ledger scope of the Tanda 6
// modules is untouched (organizationId = the single legal entity).
//
// Design: docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md §5.1, §5.2, §5.4.
// Runbook: docs/runbooks/finanzas-contabilidad.md §17.

import { prisma } from "@hotelos/database";
import { BRAND } from "../../lib/brand.js";
import type { Prisma } from "@hotelos/database";
import { isValidSpanishTaxId, normalizeTaxId, spanishTaxIdValidationMessage } from "@hotelos/compliance";
import type { PermissionKey } from "@hotelos/shared";
import { recordAuditEvent } from "../audit/audit.service.js";
import { isPlatformAdmin, listPropertiesForUser, requirePermissions } from "../auth/auth.service.js";
import { findPrefixClash, type SeriesPrefixRow } from "../invoicing/series-prefix.service.js";
import { findSeriesBlockedByTaxIdChange, seriesBlockedByTaxIdChangeWarning } from "../invoicing/invoice.service.js";
import { brandTokensOf, deriveCode, uniqueCode } from "../../scripts/backfill-legal-structure.js";
import { demoStore, type UserContext } from "../../lib/demo-store.js";
import { deriveStructureMode, findDefaultLegalEntity, isStructureEnabled, propertyWithinScope, resolveLegalIdentity } from "../../lib/finance-scope.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/http-error.js";
import type {
  LegalEntityDto,
  LegalEntityPatchResponse,
  LegalStructureErrorCode,
  PropertyEstablishmentDto,
  PropertyKind,
  StructureMode,
  VerifactuChainScope,
  VerifactuInstallationDto
} from "@hotelos/shared";
import type { LegalEntityCreateInput, LegalEntityPatchInput } from "./structure.schemas.js";

// ---------------------------------------------------------------------------
// Error codes (details.code on every 4xx of the structure layer)
// ---------------------------------------------------------------------------

/**
 * Codes of this lot beyond the shared union (handoff: add them to
 * LegalStructureErrorCode in packages/shared/src/legal-structure-types.ts).
 */
export type StructureErrorCode =
  | LegalStructureErrorCode
  /** High-risk field (NIF, razón social, SII / gran empresa, PGC, ejercicio) changed without `confirmHighRisk: true`. */
  | "HIGH_RISK_CONFIRMATION_REQUIRED"
  /** `siiEnabled: true` while REAL VeriFactu records of the sociedad await a definitive AEAT answer (R8, RD 1007/2023 art. 3.3). */
  | "VERIFACTU_SUBMISSIONS_PENDING"
  /** `LegalEntity.code` already used in the organization or `Property.code` in the legal entity. */
  | "CODE_IN_USE"
  /** A hotel with rooms / room types cannot become an office or other centre (R10.6). */
  | "PROPERTY_KIND_CHANGE_BLOCKED"
  /** A centre with that name already exists in the organization (the CLI converges; the product does not). */
  | "PROPERTY_NAME_IN_USE"
  /** An operational routine (night audit…) was asked on an office / other centre (R6). */
  | "WORK_CENTER_NOT_OPERATIONAL"
  /** Structure routes while STRUCTURE_ENABLED=false. */
  | "STRUCTURE_DISABLED";

export const STRUCTURE_MANAGE: readonly PermissionKey[] = ["organization.structure.manage"];
export const HIGH_RISK_CONFIRM: readonly PermissionKey[] = ["ai.high_risk.confirm"];
/** Regime fields of the sociedad («IVA y ejercicio», design §5.3) are accounting configuration too. */
export const ACCOUNTING_CONFIGURE: readonly PermissionKey[] = ["accounting.configure"];
export const TENANTS_MANAGE: readonly PermissionKey[] = ["admin.tenants.manage"];
export const STRUCTURE_READ_ANY: readonly PermissionKey[] = ["accounting.read", "organization.structure.manage"];
/**
 * Entity-wide read (design §5.2 R11 · §5.3 «Director de un hotel»): the NIF,
 * the domicilio fiscal, the series and the installations of EVERY centre.
 * Without one of these keys GET /organizations/me/structure is redacted to the
 * caller's assigned centres (no series, no installation, no fiscal data) and
 * GET /legal-entities/:id is refused (fix t6b#9).
 */
export const ENTITY_WIDE_READ: readonly PermissionKey[] = ["accounting.entity.read", "organization.structure.manage"];

/** True when the caller may read the whole sociedad (a platform admin always may). */
export function hasEntityWideRead(context: Pick<UserContext, "permissions" | "isPlatformAdmin">): boolean {
  return context.isPlatformAdmin === true || ENTITY_WIDE_READ.some((key) => context.permissions.includes(key));
}

/** 403 unless the caller holds an entity-wide read (accounting.entity.read ∨ organization.structure.manage ∨ platform admin). */
export function requireEntityWideRead(context: Pick<UserContext, "permissions" | "isPlatformAdmin">): void {
  if (hasEntityWideRead(context)) return;
  throw new ForbiddenError(`Permiso insuficiente: se requiere ${ENTITY_WIDE_READ.join(" o ")}.`);
}

/** Modes of a VeriFactu submission that count as a REAL emission (R7 immutability). */
export const REAL_VERIFACTU_MODES = ["preproduction", "production"] as const;
/** Statuses with a definitive AEAT answer; anything else (pending · retrying · network_error · failed) is unresolved. */
export const VERIFACTU_RESOLVED_STATUSES = ["accepted", "rejected"] as const;

const LEGAL_ENTITY_NOT_FOUND = "Sociedad no encontrada.";
const ORGANIZATION_NOT_FOUND = "Organización no encontrada.";
const STRUCTURE_ROUTE = "/configuracion/estructura-societaria";

type Db = Prisma.TransactionClient | typeof prisma;
type LegalEntityRow = NonNullable<Awaited<ReturnType<typeof prisma.legalEntity.findFirst>>>;
type PropertyRow = NonNullable<Awaited<ReturnType<typeof prisma.property.findFirst>>>;
type InstallationRow = NonNullable<Awaited<ReturnType<typeof prisma.verifactuInstallation.findFirst>>>;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** 404 (never 403) while the structure is switched off: the routes do not exist for this installation. */
export function assertStructureEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (isStructureEnabled(env)) return;
  const error = new NotFoundError("La estructura societaria no está activada en esta instalación (STRUCTURE_ENABLED=false).");
  error.details = { code: "STRUCTURE_DISABLED" satisfies StructureErrorCode };
  throw error;
}

/** Any of the keys grants the read (route manifests are AND-only, so reads with two admissible keys check here). */
export function requireAnyPermission(context: UserContext, keys: readonly PermissionKey[]): void {
  if (keys.some((key) => context.permissions.includes(key))) return;
  throw new ForbiddenError(`Permiso insuficiente: se requiere ${keys.join(" o ")}.`);
}

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

export function toLegalEntityDto(row: LegalEntityRow): LegalEntityDto {
  const taxId = normalizeTaxId(row.taxId);
  return {
    id: row.id,
    organizationId: row.organizationId,
    code: row.code,
    legalName: row.legalName,
    taxId,
    taxIdValid: isValidSpanishTaxId(taxId),
    legalForm: row.legalForm ?? null,
    fiscalAddress: row.fiscalAddress ?? null,
    fiscalPostalCode: row.fiscalPostalCode ?? null,
    fiscalMunicipality: row.fiscalMunicipality ?? null,
    fiscalIneCode: row.fiscalIneCode ?? null,
    fiscalProvince: row.fiscalProvince ?? null,
    registeredOfficeAddress: row.registeredOfficeAddress ?? null,
    registeredOfficePostalCode: row.registeredOfficePostalCode ?? null,
    registeredOfficeMunicipality: row.registeredOfficeMunicipality ?? null,
    registeredOfficeProvince: row.registeredOfficeProvince ?? null,
    mercantileRegistry: row.mercantileRegistry ?? null,
    cnae: row.cnae ?? null,
    pgcVariant: row.pgcVariant,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    largeCompany: row.largeCompany,
    siiEnabled: row.siiEnabled,
    verifactuChainScope: row.verifactuChainScope,
    cccPrincipal: row.cccPrincipal ?? null,
    isDefault: row.isDefault,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toEstablishmentDto(row: PropertyRow): PropertyEstablishmentDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    legalEntityId: row.legalEntityId ?? null,
    code: row.code ?? null,
    name: row.name,
    tradeName: row.tradeName ?? null,
    kind: row.kind,
    address: row.address ?? null,
    postalCode: row.postalCode ?? null,
    municipality: row.municipality ?? null,
    ineMunicipalityCode: row.ineMunicipalityCode ?? null,
    province: row.province ?? null,
    country: row.country,
    taxRegion: row.taxRegion ?? null,
    fiscalTerritory: row.fiscalTerritory ?? null,
    cadastralReference: row.cadastralReference ?? null,
    surfaceM2: row.surfaceM2 === null || row.surfaceM2 === undefined ? null : row.surfaceM2.toFixed(2),
    iaeEpigraph: row.iaeEpigraph ?? null,
    bedCapacity: row.bedCapacity ?? null,
    starRating: row.starRating ?? null,
    openingMonths: row.openingMonths ?? null,
    tourismRegistryNumber: row.tourismRegistryNumber ?? null,
    sesEstablishmentCode: row.sesEstablishmentCode ?? null,
    socialSecurityCcc: row.socialSecurityCcc ?? null,
    laborCenterCode: row.laborCenterCode ?? null,
    verifactuEnabled: row.verifactuEnabled,
    status: row.status
  };
}

export function toInstallationDto(row: InstallationRow): VerifactuInstallationDto {
  return {
    id: row.id,
    legalEntityId: row.legalEntityId,
    propertyId: row.propertyId ?? null,
    numeroInstalacion: row.numeroInstalacion,
    route: row.route,
    territory: row.territory ?? null,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null
  };
}

// ---------------------------------------------------------------------------
// NIF guard (pure over an injected reader; unit-tested with a fake)
// ---------------------------------------------------------------------------

export type TaxIdReader = { findOwner: (taxId: string) => Promise<{ id: string } | null> };

/** Prisma-backed reader: the legal entity currently holding a NIF (legal_entities.tax_id is unique). */
export function prismaTaxIdReader(db: Db): TaxIdReader {
  return { findOwner: (taxId) => db.legalEntity.findFirst({ where: { taxId }, select: { id: true } }) };
}

/**
 * Normalised, checksum-valid and unclaimed NIF, or a typed 4xx:
 *   400 TAX_ID_INVALID { code, taxId, reason }   (checksum, placeholder, shape)
 *   409 TAX_ID_IN_USE  { code, taxId }           (another legal entity holds it; never says which)
 */
export async function assertTaxIdUsable(raw: string, options: { excludeLegalEntityId?: string | null; reader: TaxIdReader }): Promise<string> {
  const reason = spanishTaxIdValidationMessage(raw);
  const normalized = normalizeTaxId(raw);
  if (reason || !normalized) {
    const error = new BadRequestError(`NIF/CIF no válido («${raw.trim()}»): ${reason ?? "vacío"}`);
    error.details = { code: "TAX_ID_INVALID" satisfies StructureErrorCode, taxId: raw.trim(), reason };
    throw error;
  }
  const owner = await options.reader.findOwner(normalized);
  if (owner && owner.id !== options.excludeLegalEntityId) {
    throw new ConflictError(`Ese NIF ya está asignado a otra sociedad de ${BRAND.name}: cada sujeto pasivo tiene una sola sociedad.`, {
      code: "TAX_ID_IN_USE" satisfies StructureErrorCode,
      taxId: normalized
    });
  }
  return normalized;
}

/**
 * Pure: what a PATCH does to the NIF. `undefined` leaves it alone; `null`
 * clears it («NIF pendiente»); a string replaces it. `changed` drives the
 * high-risk confirmation (a same-value write is not a change).
 */
export function resolveTaxIdChange(current: string | null, next: string | null | undefined): { changed: boolean; next: string | null } {
  if (next === undefined) return { changed: false, next: current };
  const normalizedNext = next === null ? null : normalizeTaxId(next);
  const normalizedCurrent = normalizeTaxId(current);
  return { changed: normalizedNext !== normalizedCurrent, next: normalizedNext };
}

// ---------------------------------------------------------------------------
// High-risk fields of the sociedad (pure; design §5.2 R2 / R8 / R9 / R11)
// ---------------------------------------------------------------------------

/**
 * Fields whose change re-qualifies the whole NIF and therefore needs
 * `ai.high_risk.confirm` + `confirmHighRisk: true` (409 HIGH_RISK_CONFIRMATION_REQUIRED).
 */
export const HIGH_RISK_LEGAL_ENTITY_FIELDS = ["taxId", "legalName", "siiEnabled", "largeCompany", "pgcVariant", "fiscalYearStartMonth"] as const;
export type HighRiskLegalEntityField = (typeof HIGH_RISK_LEGAL_ENTITY_FIELDS)[number];

/** Subset edited in «IVA y ejercicio» (design §5.3): needs `accounting.configure` besides `organization.structure.manage`. */
export const REGIME_LEGAL_ENTITY_FIELDS = ["siiEnabled", "largeCompany", "pgcVariant", "fiscalYearStartMonth"] as const satisfies readonly HighRiskLegalEntityField[];

/** Why each high-risk field is high risk — the operator reads it in the 409 and in the confirm dialog. */
export const HIGH_RISK_FIELD_REASONS: Record<HighRiskLegalEntityField, string> = {
  taxId: "Cambiar o retirar el NIF de la sociedad afecta a todas las facturas futuras de todos sus centros (las emitidas conservan su NIF).",
  legalName: "Cambiar la razón social cambia la identidad emisora de todas las facturas futuras de todos sus centros y el NombreRazon de los registros VeriFactu (RD 1619/2012 art. 6.1.c); las emitidas conservan su snapshot.",
  siiEnabled: "Acoger o sacar la sociedad del SII cambia su régimen entero: 303 mensual (RIVA art. 71.3), 347 y 390 «no se presenta» y VeriFactu deja de aplicar (RD 1007/2023 art. 3.3).",
  largeCompany: "Marcar o desmarcar gran empresa fuerza la periodicidad mensual de 303, 111 y 115 (RIVA art. 71.3) y condiciona el formato de las cuentas anuales.",
  pgcVariant: "Cambiar la variante del PGC decide qué formato de cuentas anuales es depositable para la sociedad (LSC arts. 257-258).",
  fiscalYearStartMonth: "Cambiar el inicio del ejercicio redefine el ejercicio social de la sociedad (LSC art. 26): ejercicios, regularización, cierre y apertura lo siguen."
};

export type LegalEntityCurrentRiskFields = {
  taxId: string | null;
  legalName: string;
  siiEnabled: boolean;
  largeCompany: boolean;
  pgcVariant: string;
  fiscalYearStartMonth: number;
};

export type LegalEntityPatchRisk = {
  /** High-risk fields whose value actually changes (a same-value write is not a change). */
  highRiskFields: HighRiskLegalEntityField[];
  /** Regime fields (R8 / R9 / ejercicio) among them → `accounting.configure` required. */
  regimeFields: HighRiskLegalEntityField[];
  changes: Partial<Record<HighRiskLegalEntityField, { from: unknown; to: unknown }>>;
  /** The patch turns the SII on (false → true). */
  enablesSii: boolean;
};

/** Pure: which high-risk fields a PATCH body really changes on the current sociedad. */
export function assessLegalEntityPatchRisk(
  current: LegalEntityCurrentRiskFields,
  body: Partial<Pick<LegalEntityPatchInput, "taxId" | "legalName" | "siiEnabled" | "largeCompany" | "pgcVariant" | "fiscalYearStartMonth">>
): LegalEntityPatchRisk {
  const changes: LegalEntityPatchRisk["changes"] = {};
  const taxChange = resolveTaxIdChange(current.taxId, body.taxId);
  if (taxChange.changed) changes.taxId = { from: current.taxId, to: taxChange.next };
  if (body.legalName !== undefined && body.legalName.trim() !== current.legalName.trim()) changes.legalName = { from: current.legalName, to: body.legalName.trim() };
  if (body.siiEnabled !== undefined && body.siiEnabled !== current.siiEnabled) changes.siiEnabled = { from: current.siiEnabled, to: body.siiEnabled };
  if (body.largeCompany !== undefined && body.largeCompany !== current.largeCompany) changes.largeCompany = { from: current.largeCompany, to: body.largeCompany };
  if (body.pgcVariant !== undefined && body.pgcVariant !== current.pgcVariant) changes.pgcVariant = { from: current.pgcVariant, to: body.pgcVariant };
  if (body.fiscalYearStartMonth !== undefined && body.fiscalYearStartMonth !== current.fiscalYearStartMonth) {
    changes.fiscalYearStartMonth = { from: current.fiscalYearStartMonth, to: body.fiscalYearStartMonth };
  }
  const highRiskFields = HIGH_RISK_LEGAL_ENTITY_FIELDS.filter((field) => field in changes);
  const regime = new Set<string>(REGIME_LEGAL_ENTITY_FIELDS);
  return {
    highRiskFields,
    regimeFields: highRiskFields.filter((field) => regime.has(field)),
    changes,
    enablesSii: changes.siiEnabled?.to === true
  };
}

/** 409 HIGH_RISK_CONFIRMATION_REQUIRED for the fields that change; `field` is the first one (compat), `fields` all of them. */
export function highRiskConfirmationRequired(risk: LegalEntityPatchRisk, current: Pick<LegalEntityCurrentRiskFields, "taxId">): ConflictError {
  const reasons = risk.highRiskFields.map((field) => HIGH_RISK_FIELD_REASONS[field]);
  return new ConflictError(`${reasons.join(" ")} Confirma la operación de alto riesgo.`, {
    code: "HIGH_RISK_CONFIRMATION_REQUIRED" satisfies StructureErrorCode,
    field: risk.highRiskFields[0],
    fields: risk.highRiskFields,
    changes: risk.changes,
    currentTaxId: current.taxId,
    nextTaxId: risk.changes.taxId ? risk.changes.taxId.to : current.taxId
  });
}

// ---------------------------------------------------------------------------
// Implicit legal entity (shared with createTenant and the provisioning service)
// ---------------------------------------------------------------------------

export type ImplicitLegalEntityInput = {
  organizationId: string;
  organizationName: string;
  legalName?: string | null;
  /** Raw NIF: validated and claimed here (400 / 409); null or omitted → «NIF pendiente». */
  taxId?: string | null;
  code?: string | null;
  legalForm?: LegalEntityDto["legalForm"];
  fiscalAddress?: string | null;
  fiscalPostalCode?: string | null;
  fiscalMunicipality?: string | null;
  fiscalIneCode?: string | null;
  fiscalProvince?: string | null;
  registeredOfficeAddress?: string | null;
  registeredOfficePostalCode?: string | null;
  registeredOfficeMunicipality?: string | null;
  registeredOfficeProvince?: string | null;
  mercantileRegistry?: string | null;
  cnae?: string | null;
  pgcVariant?: LegalEntityDto["pgcVariant"];
  fiscalYearStartMonth?: number;
  largeCompany?: boolean;
  siiEnabled?: boolean;
  cccPrincipal?: string | null;
};

/** Pure: code of a new legal entity (initials of the razón social, unique inside the organization). */
export function planLegalEntityCode(legalName: string, takenCodes: ReadonlySet<string>, requested?: string | null): string {
  if (requested && requested.trim().length > 0) return requested.trim().toUpperCase();
  return uniqueCode(deriveCode(legalName, []), takenCodes);
}

/** Pure: code of a new centre (initials of its name minus the brand tokens, unique inside the legal entity). */
export function planPropertyCode(
  propertyName: string,
  organization: { name: string; legalName: string | null },
  takenCodes: ReadonlySet<string>,
  requested?: string | null
): string {
  if (requested && requested.trim().length > 0) return requested.trim().toUpperCase();
  return uniqueCode(deriveCode(propertyName, brandTokensOf(organization)), takenCodes);
}

/**
 * Create the organization's implicit (default) legal entity inside the caller's
 * transaction. Used by createTenant (new tenant), by POST /legal-entities on a
 * tenant created before the backfill, and by the provisioning service when a
 * centre is added to an organization that has no entity yet. 409
 * MULTI_ENTITY_NOT_ENABLED when a default entity already exists (R10.7).
 */
export async function createImplicitLegalEntity(tx: Db, input: ImplicitLegalEntityInput): Promise<LegalEntityRow> {
  const existing = await tx.legalEntity.findFirst({ where: { organizationId: input.organizationId, isDefault: true } });
  if (existing) throw multiEntityNotEnabled(existing.id);
  const legalName = input.legalName?.trim() || input.organizationName.trim();
  const taxId = input.taxId ? await assertTaxIdUsable(input.taxId, { reader: prismaTaxIdReader(tx) }) : null;
  const taken = new Set((await tx.legalEntity.findMany({ where: { organizationId: input.organizationId }, select: { code: true } })).map((row) => row.code));
  const code = planLegalEntityCode(legalName, taken, input.code);
  if (taken.has(code)) throw codeInUse("legal_entity", code);
  return tx.legalEntity.create({
    data: {
      organizationId: input.organizationId,
      code,
      legalName,
      taxId,
      legalForm: input.legalForm ?? null,
      fiscalAddress: input.fiscalAddress ?? null,
      fiscalPostalCode: input.fiscalPostalCode ?? null,
      fiscalMunicipality: input.fiscalMunicipality ?? null,
      fiscalIneCode: input.fiscalIneCode ?? null,
      fiscalProvince: input.fiscalProvince ?? null,
      registeredOfficeAddress: input.registeredOfficeAddress ?? null,
      registeredOfficePostalCode: input.registeredOfficePostalCode ?? null,
      registeredOfficeMunicipality: input.registeredOfficeMunicipality ?? null,
      registeredOfficeProvince: input.registeredOfficeProvince ?? null,
      mercantileRegistry: input.mercantileRegistry ?? null,
      cnae: input.cnae ?? null,
      pgcVariant: input.pgcVariant ?? "pymes",
      fiscalYearStartMonth: input.fiscalYearStartMonth ?? 1,
      largeCompany: input.largeCompany ?? false,
      siiEnabled: input.siiEnabled ?? false,
      cccPrincipal: input.cccPrincipal ?? null,
      isDefault: true,
      status: "active"
    }
  });
}

/**
 * The organization's default legal entity, created implicitly from the
 * deprecated Organization columns when it does not exist yet (same rule as
 * the backfill: the NIF is copied only when valid and unclaimed).
 */
export async function ensureDefaultLegalEntity(tx: Db, organizationId: string): Promise<{ entity: LegalEntityRow; created: boolean }> {
  const existing = await tx.legalEntity.findFirst({ where: { organizationId, isDefault: true, status: "active" }, orderBy: { createdAt: "asc" } });
  if (existing) return { entity: existing, created: false };
  const organization = await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, legalName: true, taxId: true } });
  if (!organization) throw new NotFoundError(ORGANIZATION_NOT_FOUND);
  const candidate = normalizeTaxId(organization.taxId);
  let taxId: string | null = null;
  if (candidate && isValidSpanishTaxId(candidate)) {
    const owner = await tx.legalEntity.findFirst({ where: { taxId: candidate }, select: { id: true } });
    if (!owner) taxId = candidate;
  }
  const entity = await createImplicitLegalEntity(tx, { organizationId, organizationName: organization.name, legalName: organization.legalName, taxId });
  return { entity, created: true };
}

export function multiEntityNotEnabled(existingLegalEntityId: string): ConflictError {
  return new ConflictError(
    "Esta organización ya tiene su sociedad. En esta versión cada organización tiene exactamente una sociedad (varias sociedades = fase grupo, no activada).",
    { code: "MULTI_ENTITY_NOT_ENABLED" satisfies StructureErrorCode, legalEntityId: existingLegalEntityId }
  );
}

export function codeInUse(scope: "legal_entity" | "property", code: string): ConflictError {
  return new ConflictError(
    scope === "property"
      ? `El código de centro «${code}» ya lo usa otro centro de la misma sociedad: elige otro (2-6 letras o dígitos).`
      : `El código de sociedad «${code}» ya existe en esta organización.`,
    { code: "CODE_IN_USE" satisfies StructureErrorCode, scope, value: code }
  );
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The legal entity, opaque 404 unless it belongs to the caller's organization (platform admins were re-pointed by the tenancy guard). */
export async function requireLegalEntity(context: Pick<UserContext, "organizationId">, legalEntityId: string, db: Db = prisma): Promise<LegalEntityRow> {
  const row = await db.legalEntity.findUnique({ where: { id: legalEntityId } });
  if (!row || row.organizationId !== context.organizationId) throw new NotFoundError(LEGAL_ENTITY_NOT_FOUND);
  return row;
}

/** Property ids of the legal entity (falls back to the organization while properties are not linked yet). */
export async function listEntityPropertyIds(entity: Pick<LegalEntityRow, "id" | "organizationId">, db: Db = prisma): Promise<string[]> {
  const rows = await db.property.findMany({
    where: { OR: [{ legalEntityId: entity.id }, { legalEntityId: null, organizationId: entity.organizationId }] },
    select: { id: true }
  });
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// GET /organizations/me/structure
// ---------------------------------------------------------------------------

export type StructureSeries = {
  id: string;
  propertyId: string;
  sequenceCode: string;
  prefix: string | null;
  year: number | null;
  nextNumber: number;
  padding: number;
  invoiceType: string;
  active: boolean;
};

export type StructureProperty = {
  id: string;
  code: string | null;
  name: string;
  tradeName: string | null;
  kind: PropertyKind;
  municipality: string | null;
  province: string | null;
  status: string;
  legalEntityId: string | null;
  verifactuEnabled: boolean;
  sesHospedajesEnabled: boolean;
  series: StructureSeries[];
  installation: VerifactuInstallationDto | null;
};

export type StructureWarning = "LEGAL_ENTITY_PENDING" | "TAX_ID_PENDING" | "PROPERTIES_UNLINKED";

/**
 * What the caller was allowed to see (fix t6b#9, design §5.3): `entity` = the
 * whole sociedad (accounting.entity.read ∨ organization.structure.manage ∨
 * platform admin); `assigned_properties` = only the centres the caller holds a
 * role in, without series, installations, VAT settings or the fiscal data of the
 * sociedad (NIF, domicilios, RM, CNAE, CCC). `mode` and `counts` always describe
 * the whole organization so the front derives the same layout for everybody.
 */
export type StructureReadScope = "entity" | "assigned_properties";

export type OrganizationStructure = {
  organization: { id: string; name: string; country: string };
  legalEntity:
    | (LegalEntityDto & {
        vatSettings: { periodicity: string; regime: string; prorrataPct: string | null; taxFigure: string } | null;
        properties: StructureProperty[];
      })
    | null;
  mode: StructureMode;
  counts: { properties: number; hotels: number; offices: number; others: number; legalEntities: number };
  warnings: StructureWarning[];
  scope: StructureReadScope;
};

/** Fiscal data of the sociedad hidden from a centre-scoped reader (R11): name and code stay, NIF / domicilios / RM / CNAE / CCC go. */
export function redactLegalEntityDto(dto: LegalEntityDto): LegalEntityDto {
  return {
    ...dto,
    taxId: null,
    taxIdValid: false,
    fiscalAddress: null,
    fiscalPostalCode: null,
    fiscalMunicipality: null,
    fiscalIneCode: null,
    fiscalProvince: null,
    registeredOfficeAddress: null,
    registeredOfficePostalCode: null,
    registeredOfficeMunicipality: null,
    registeredOfficeProvince: null,
    mercantileRegistry: null,
    cnae: null,
    cccPrincipal: null
  };
}

/** Single point of truth of the front (design §5.4): sociedad + centros + series + instalaciones + modo. */
export async function getStructure(context: UserContext, db: Db = prisma): Promise<OrganizationStructure> {
  requireAnyPermission(context, STRUCTURE_READ_ANY);
  const entityWide = hasEntityWideRead(context);
  const organization = await db.organization.findUnique({ where: { id: context.organizationId }, select: { id: true, name: true, country: true } });
  if (!organization) throw new NotFoundError(ORGANIZATION_NOT_FOUND);
  const entity = await findDefaultLegalEntity(organization.id, db as typeof prisma);
  const entityCount = await db.legalEntity.count({ where: { organizationId: organization.id, status: "active" } });
  const allProperties = await db.property.findMany({ where: { organizationId: organization.id }, orderBy: { createdAt: "asc" } });
  // R11: without an entity-wide read only the assigned centres are listed (same predicate as the ledger scope).
  const properties = entityWide ? allProperties : allProperties.filter((row) => propertyWithinScope(context, row.id));
  const propertyIds = properties.map((row) => row.id);
  const [sequences, installations, vatSettings] = await Promise.all([
    !entityWide || propertyIds.length === 0
      ? Promise.resolve([] as StructureSeries[])
      : db.invoiceSequence.findMany({
          where: { propertyId: { in: propertyIds }, active: true },
          select: { id: true, propertyId: true, sequenceCode: true, prefix: true, year: true, nextNumber: true, padding: true, invoiceType: true, active: true },
          orderBy: [{ sequenceCode: "asc" }, { year: "desc" }]
        }),
    entityWide && entity ? db.verifactuInstallation.findMany({ where: { legalEntityId: entity.id, active: true }, orderBy: { createdAt: "asc" } }) : Promise.resolve([] as InstallationRow[]),
    entityWide ? db.vatSettings.findUnique({ where: { organizationId: organization.id }, select: { periodicity: true, regime: true, prorrataPct: true, taxFigure: true } }) : Promise.resolve(null)
  ]);
  const installationByProperty = new Map(installations.filter((row) => row.propertyId).map((row) => [row.propertyId as string, row]));
  const structureProperties: StructureProperty[] = properties.map((row) => ({
    id: row.id,
    code: row.code ?? null,
    name: row.name,
    tradeName: row.tradeName ?? null,
    kind: row.kind,
    municipality: row.municipality ?? null,
    province: row.province ?? null,
    status: row.status,
    legalEntityId: row.legalEntityId ?? null,
    verifactuEnabled: row.verifactuEnabled,
    sesHospedajesEnabled: row.sesHospedajesEnabled,
    series: sequences.filter((sequence) => sequence.propertyId === row.id),
    installation: installationByProperty.has(row.id) ? toInstallationDto(installationByProperty.get(row.id)!) : null
  }));
  // Configuration warnings (pending NIF, unlinked centres) are for whoever manages the sociedad.
  const warnings: StructureWarning[] = [];
  if (!entity) warnings.push("LEGAL_ENTITY_PENDING");
  else if (entityWide && !entity.taxId) warnings.push("TAX_ID_PENDING");
  if (entityWide && entity && allProperties.some((row) => row.legalEntityId === null)) warnings.push("PROPERTIES_UNLINKED");
  const entityDto = entity ? (entityWide ? toLegalEntityDto(entity) : redactLegalEntityDto(toLegalEntityDto(entity))) : null;
  return {
    organization,
    legalEntity: entityDto
      ? {
          ...entityDto,
          vatSettings: vatSettings
            ? { periodicity: vatSettings.periodicity, regime: vatSettings.regime, prorrataPct: vatSettings.prorrataPct ? vatSettings.prorrataPct.toFixed(2) : null, taxFigure: vatSettings.taxFigure }
            : null,
          properties: structureProperties
        }
      : null,
    mode: deriveStructureMode({ legalEntities: entityCount, properties: allProperties.length }),
    counts: {
      properties: allProperties.length,
      hotels: allProperties.filter((row) => row.kind === "hotel").length,
      offices: allProperties.filter((row) => row.kind === "office").length,
      others: allProperties.filter((row) => row.kind === "other").length,
      legalEntities: entityCount
    },
    warnings,
    scope: entityWide ? "entity" : "assigned_properties"
  };
}

// ---------------------------------------------------------------------------
// CRUD de la sociedad
// ---------------------------------------------------------------------------

export async function getLegalEntity(context: UserContext, legalEntityId: string): Promise<LegalEntityDto> {
  // Fix t6b#9: the full DTO (NIF, domicilios, RM, CNAE, CCC) is an entity-wide read, never a centre-scoped one.
  requireEntityWideRead(context);
  return toLegalEntityDto(await requireLegalEntity(context, legalEntityId));
}

/** POST /legal-entities: the first legal entity of a tenant created before the backfill; otherwise 409 MULTI_ENTITY_NOT_ENABLED. */
export async function createLegalEntity(input: { context: UserContext; body: LegalEntityCreateInput; correlationId: string }): Promise<LegalEntityDto> {
  requirePermissions(input.context, [...STRUCTURE_MANAGE]);
  const organization = await prisma.organization.findUnique({ where: { id: input.context.organizationId }, select: { id: true, name: true } });
  if (!organization) throw new NotFoundError(ORGANIZATION_NOT_FOUND);
  const existing = await findDefaultLegalEntity(organization.id);
  if (existing) throw multiEntityNotEnabled(existing.id);
  const row = await prisma.$transaction((tx) => createImplicitLegalEntity(tx, { ...input.body, organizationId: organization.id, organizationName: organization.name }));
  recordAuditEvent({
    organizationId: organization.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "LEGAL_ENTITY_CREATED",
    entityType: "legal_entity",
    entityId: row.id,
    afterJson: toLegalEntityDto(row),
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  syncDemoOrganizationMirror(row);
  return toLegalEntityDto(row);
}

/**
 * PATCH /legal-entities/:legalEntityId. High-risk fields (HIGH_RISK_LEGAL_ENTITY_FIELDS:
 * NIF, razón social, SII, gran empresa, PGC, inicio de ejercicio) need
 * `ai.high_risk.confirm` and `confirmHighRisk: true` (else 409
 * HIGH_RISK_CONFIRMATION_REQUIRED { field, fields, changes }); the regime fields
 * need `accounting.configure` as well («IVA y ejercicio»). The NIF path adds
 * normalisation + checksum (400 TAX_ID_INVALID) + uniqueness (409 TAX_ID_IN_USE).
 * Turning the SII on is refused (409 VERIFACTU_SUBMISSIONS_PENDING) while a REAL
 * VeriFactu record of the sociedad awaits a definitive answer. Everything is
 * audited with before/after. Issued invoices keep their issuer snapshot
 * (trigger invoices_issuer_inmutable, L1).
 */
/**
 * PATCH /legal-entities/:id. The 200 carries `warnings` (fix t6b#11): after a NIF
 * change, one sentence per ACTIVE series whose issued invoices carry the previous
 * NIF — that series answers 409 ISSUER_TAX_ID_SERIES_MISMATCH on the next issuance
 * and must be closed in favour of a successor with another prefix (RD 1619/2012
 * art. 6.1.a; nothing is ever renumbered). Empty when nothing is blocked.
 */
export async function patchLegalEntity(input: { context: UserContext; legalEntityId: string; body: LegalEntityPatchInput; correlationId: string }): Promise<LegalEntityPatchResponse> {
  requirePermissions(input.context, [...STRUCTURE_MANAGE]);
  const current = await requireLegalEntity(input.context, input.legalEntityId);
  const { confirmHighRisk, taxId: taxIdInput, code: codeInput, ...rest } = input.body;

  const data: Prisma.LegalEntityUncheckedUpdateInput = { ...rest };
  const risk = assessLegalEntityPatchRisk(current, input.body);
  if (risk.regimeFields.length > 0) requirePermissions(input.context, [...ACCOUNTING_CONFIGURE]);
  if (risk.highRiskFields.length > 0) {
    requirePermissions(input.context, [...HIGH_RISK_CONFIRM]);
    if (risk.enablesSii) {
      const unresolved = await countUnresolvedRealVerifactuSubmissions(current);
      if (unresolved > 0) {
        throw new ConflictError(
          `La sociedad tiene ${unresolved} registro(s) VeriFactu reales sin respuesta definitiva de la AEAT. Resuélvelos (reintento o anulación) antes de acogerla al SII: el SII la excluye del RRSIF (RD 1007/2023 art. 3.3) y la cola dejaría de enviarse.`,
          { code: "VERIFACTU_SUBMISSIONS_PENDING" satisfies StructureErrorCode, field: "siiEnabled", unresolvedSubmissions: unresolved }
        );
      }
    }
    if (confirmHighRisk !== true) throw highRiskConfirmationRequired(risk, current);
  }
  if (risk.changes.taxId) {
    data.taxId = taxIdInput === null ? null : await assertTaxIdUsable(taxIdInput as string, { excludeLegalEntityId: current.id, reader: prismaTaxIdReader(prisma) });
  }
  if (codeInput !== undefined && codeInput !== current.code) {
    const clash = await prisma.legalEntity.findFirst({ where: { organizationId: current.organizationId, code: codeInput, NOT: { id: current.id } }, select: { id: true } });
    if (clash) throw codeInUse("legal_entity", codeInput);
    data.code = codeInput;
  }
  if (Object.keys(data).length === 0) return { ...toLegalEntityDto(current), warnings: [] };

  const updated = await prisma.legalEntity.update({ where: { id: current.id }, data });
  // t6b#11: series that keep numbering under the previous NIF are reported in this 200 (never renumbered).
  const blockedSeries = risk.changes.taxId
    ? await findSeriesBlockedByTaxIdChange({ organizationId: current.organizationId, legalEntityId: current.id, nextTaxId: updated.taxId })
    : [];
  const warnings = blockedSeries.map((row) => seriesBlockedByTaxIdChangeWarning(row, updated.taxId));
  const before = toLegalEntityDto(current);
  const after = toLegalEntityDto(updated);
  const changedFields = (Object.keys(after) as Array<keyof LegalEntityDto>).filter((key) => key !== "updatedAt" && before[key] !== after[key]);
  recordAuditEvent({
    organizationId: current.organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "LEGAL_ENTITY_UPDATED",
    entityType: "legal_entity",
    entityId: current.id,
    beforeJson: before,
    afterJson: {
      ...after,
      changedFields,
      highRisk: risk.highRiskFields.length > 0,
      highRiskFields: risk.highRiskFields,
      regimeFields: risk.regimeFields,
      confirmHighRisk: confirmHighRisk === true,
      blockedSeries: blockedSeries.map((row) => ({ propertyId: row.propertyId, sequenceId: row.sequenceId, prefix: row.prefix, year: row.year, seriesTaxId: row.seriesTaxId }))
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  syncDemoOrganizationMirror(updated);
  return { ...after, warnings };
}

/**
 * The seed-only demo organization mirror keeps READING the sociedad (design §5.6)
 * so demoStore.organization never diverges from the legal entity. Prisma's
 * deprecated Organization columns are NOT written (no espejo, R2).
 */
function syncDemoOrganizationMirror(row: LegalEntityRow): void {
  if (demoStore.organization.id !== row.organizationId) return;
  Object.assign(demoStore.organization, { legalName: row.legalName, taxId: row.taxId ?? "" });
}

// ---------------------------------------------------------------------------
// GET /legal-entities/:legalEntityId/series · sociedad-wide series and clashes
// ---------------------------------------------------------------------------

export type LegalEntitySeriesRow = StructureSeries & {
  propertyCode: string | null;
  propertyName: string;
  propertyKind: PropertyKind;
  /** Another centre of the same legal entity uses the same prefix in the same year (R3). */
  clash: { propertyId: string; sequenceId: string } | null;
};

/** Pure: mark every active row that clashes with a sister centre's active row. */
export function markSeriesClashes<T extends SeriesPrefixRow>(rows: readonly T[]): Array<T & { clash: { propertyId: string; sequenceId: string } | null }> {
  return rows.map((row) => {
    if (!row.active || row.prefix === null) return { ...row, clash: null };
    const clash = findPrefixClash(rows, { propertyId: row.propertyId, prefix: row.prefix, year: row.year, excludeSequenceId: row.id });
    return { ...row, clash: clash ? { propertyId: clash.propertyId, sequenceId: clash.id } : null };
  });
}

export async function listLegalEntitySeries(context: UserContext, legalEntityId: string): Promise<{ legalEntityId: string; series: LegalEntitySeriesRow[]; clashCount: number }> {
  requireAnyPermission(context, ["billing.configure", "organization.structure.manage"]);
  const entity = await requireLegalEntity(context, legalEntityId);
  const properties = await prisma.property.findMany({
    where: { OR: [{ legalEntityId: entity.id }, { legalEntityId: null, organizationId: entity.organizationId }] },
    select: { id: true, code: true, name: true, kind: true }
  });
  const byProperty = new Map(properties.map((row) => [row.id, row]));
  const rows = await prisma.invoiceSequence.findMany({
    where: { propertyId: { in: properties.map((row) => row.id) } },
    select: { id: true, propertyId: true, sequenceCode: true, prefix: true, year: true, nextNumber: true, padding: true, invoiceType: true, active: true },
    orderBy: [{ propertyId: "asc" }, { sequenceCode: "asc" }, { year: "desc" }]
  });
  const marked = markSeriesClashes(rows);
  const series: LegalEntitySeriesRow[] = marked.map((row) => {
    const property = byProperty.get(row.propertyId);
    return { ...row, propertyCode: property?.code ?? null, propertyName: property?.name ?? row.propertyId, propertyKind: property?.kind ?? "hotel" };
  });
  return { legalEntityId: entity.id, series, clashCount: series.filter((row) => row.clash !== null).length };
}

// ---------------------------------------------------------------------------
// GET /legal-entities/:legalEntityId/verifactu/installations
// ---------------------------------------------------------------------------

export type InstallationView = VerifactuInstallationDto & {
  propertyCode: string | null;
  propertyName: string | null;
  /** Records sent under this installation (any mode) and the last chained invoice, if any. */
  submissions: number;
  lastInvoice: { invoiceNumber: string | null; issuedAt: string | null } | null;
};

export async function listInstallations(context: UserContext, legalEntityId: string): Promise<{ legalEntityId: string; chainScope: VerifactuChainScope; installations: InstallationView[] }> {
  requireAnyPermission(context, ["accounting.configure", "organization.structure.manage"]);
  const entity = await requireLegalEntity(context, legalEntityId);
  const rows = await prisma.verifactuInstallation.findMany({ where: { legalEntityId: entity.id }, orderBy: { createdAt: "asc" } });
  const propertyIds = rows.map((row) => row.propertyId).filter((id): id is string => id !== null);
  const properties = propertyIds.length === 0 ? [] : await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { id: true, code: true, name: true } });
  const byProperty = new Map(properties.map((row) => [row.id, row]));
  const installations: InstallationView[] = [];
  for (const row of rows) {
    const [submissions, lastInvoice] = await Promise.all([
      prisma.verifactuSubmission.count({ where: { installationId: row.id } }),
      prisma.invoice.findFirst({ where: { installationId: row.id, status: { not: "draft" } }, orderBy: [{ issuedAt: "desc" }], select: { invoiceNumber: true, issuedAt: true } })
    ]);
    const property = row.propertyId ? byProperty.get(row.propertyId) : undefined;
    installations.push({
      ...toInstallationDto(row),
      propertyCode: property?.code ?? null,
      propertyName: property?.name ?? null,
      submissions,
      lastInvoice: lastInvoice ? { invoiceNumber: lastInvoice.invoiceNumber ?? null, issuedAt: lastInvoice.issuedAt ? lastInvoice.issuedAt.toISOString() : null } : null
    });
  }
  return { legalEntityId: entity.id, chainScope: entity.verifactuChainScope, installations };
}

// ---------------------------------------------------------------------------
// POST /admin/legal-entities/:legalEntityId/verifactu-scope (platform console)
// ---------------------------------------------------------------------------

/** Real (non-sandbox) records sent by the centres of a legal entity: once > 0 the chain policy is frozen (R7). */
export async function countRealVerifactuSubmissions(entity: Pick<LegalEntityRow, "id" | "organizationId">, db: Db = prisma): Promise<number> {
  const propertyIds = await listEntityPropertyIds(entity, db);
  if (propertyIds.length === 0) return 0;
  return db.verifactuSubmission.count({ where: { propertyId: { in: propertyIds }, mode: { in: [...REAL_VERIFACTU_MODES] } } });
}

/**
 * Real (non-sandbox) records of the sociedad without a definitive AEAT answer
 * (status ∉ VERIFACTU_RESOLVED_STATUSES). While > 0 the sociedad cannot join the
 * SII (R8): the RRSIF stops applying and the queue would never be sent.
 */
export async function countUnresolvedRealVerifactuSubmissions(entity: Pick<LegalEntityRow, "id" | "organizationId">, db: Db = prisma): Promise<number> {
  const propertyIds = await listEntityPropertyIds(entity, db);
  if (propertyIds.length === 0) return 0;
  return db.verifactuSubmission.count({
    where: { propertyId: { in: propertyIds }, mode: { in: [...REAL_VERIFACTU_MODES] }, status: { notIn: [...VERIFACTU_RESOLVED_STATUSES] } }
  });
}

export async function setVerifactuChainScope(input: {
  context: UserContext;
  legalEntityId: string;
  scope: VerifactuChainScope;
  correlationId: string;
}): Promise<{ legalEntity: LegalEntityDto; changed: boolean; realSubmissions: number }> {
  // Platform scope: only a real admin.tenants.manage grant turns a user into a platform admin.
  requirePermissions(input.context, [...TENANTS_MANAGE]);
  if (!(await isPlatformAdmin(input.context))) throw new ForbiddenError("La política de cadena VeriFactu se fija desde la consola de plataforma.");
  const current = await requireLegalEntity(input.context, input.legalEntityId);
  const realSubmissions = await countRealVerifactuSubmissions(current);
  if (current.verifactuChainScope === input.scope) return { legalEntity: toLegalEntityDto(current), changed: false, realSubmissions };
  if (realSubmissions > 0) {
    throw new ConflictError(
      `La sociedad ya ha remitido ${realSubmissions} registro(s) reales a la AEAT: la política de cadena no puede cambiar. Retira las instalaciones y abre otras con número nuevo (nunca se re-encadena).`,
      { code: "CHAIN_ALREADY_STARTED" satisfies StructureErrorCode, realSubmissions, currentScope: current.verifactuChainScope }
    );
  }
  const updated = await prisma.legalEntity.update({ where: { id: current.id }, data: { verifactuChainScope: input.scope } });
  recordAuditEvent({
    organizationId: current.organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "VERIFACTU_CHAIN_SCOPE_CHANGED",
    entityType: "legal_entity",
    entityId: current.id,
    beforeJson: { verifactuChainScope: current.verifactuChainScope },
    afterJson: { verifactuChainScope: updated.verifactuChainScope, realSubmissions, confirmed: true },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return { legalEntity: toLegalEntityDto(updated), changed: true, realSubmissions };
}

// ---------------------------------------------------------------------------
// GET /users/me/properties · switcher (moved here from server.ts, additive fields)
// ---------------------------------------------------------------------------

export type SwitchableProperty = {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  municipality: string | null;
  province: string | null;
  status: string;
  /** Tanda 6b: the switcher groups «Hoteles» / «Centros no alojativos» on it. */
  kind: PropertyKind;
  code: string | null;
  legalEntityId: string | null;
  legalEntityName: string | null;
};

/**
 * Properties the signed-in user may switch to. Tenant isolation: only the
 * platform admin sees every organization. Tanda 8a (RBAC · L1): a non-platform
 * user only sees the properties COVERED by its scope (`assignedPropertyIds`,
 * groups / sociedad / organisation already expanded by lib/rbac-scope.ts) —
 * never the whole organisation; a user without assignments sees none.
 * Contexts without an assignment list (demo fallback, contexts assembled
 * elsewhere) keep the organisation. Falls back to the in-memory demo store
 * when the database holds no property (unseeded instance).
 */
export async function listSwitchableProperties(userContext: UserContext, db: Db = prisma): Promise<SwitchableProperty[]> {
  const platformAdmin = await isPlatformAdmin(userContext);
  const assigned = platformAdmin ? null : userContext.assignedPropertyIds;
  const [properties, organizations] = await Promise.all([
    db.property.findMany({
      where: platformAdmin ? {} : { organizationId: userContext.organizationId, ...(assigned ? { id: { in: assigned } } : {}) },
      select: { id: true, name: true, organizationId: true, municipality: true, province: true, status: true, kind: true, code: true, legalEntityId: true },
      orderBy: { name: "asc" }
    }),
    db.organization.findMany({ where: platformAdmin ? {} : { id: userContext.organizationId }, select: { id: true, name: true } })
  ]);
  if (assigned && assigned.length === 0) return [];
  const orgName = new Map(organizations.map((org) => [org.id, org.name]));
  if (properties.length === 0) {
    return listPropertiesForUser(userContext).map((property) => ({
      id: property.id,
      name: property.name,
      organizationId: property.organizationId,
      organizationName: orgName.get(property.organizationId) ?? property.organizationId,
      municipality: null,
      province: null,
      status: "open",
      kind: "hotel" as const,
      code: null,
      legalEntityId: null,
      legalEntityName: null
    }));
  }
  const entityIds = [...new Set(properties.map((row) => row.legalEntityId).filter((id): id is string => id !== null))];
  const entities = entityIds.length === 0 ? [] : await db.legalEntity.findMany({ where: { id: { in: entityIds } }, select: { id: true, legalName: true } });
  const entityName = new Map(entities.map((row) => [row.id, row.legalName]));
  return properties.map((property) => ({
    id: property.id,
    name: property.name,
    organizationId: property.organizationId,
    organizationName: orgName.get(property.organizationId) ?? property.organizationId,
    municipality: property.municipality ?? null,
    province: property.province ?? null,
    status: property.status,
    kind: property.kind,
    code: property.code ?? null,
    legalEntityId: property.legalEntityId ?? null,
    legalEntityName: property.legalEntityId ? entityName.get(property.legalEntityId) ?? null : null
  }));
}

// ---------------------------------------------------------------------------
// Property profile guard (backoffice property_profile form, design §5.4)
// ---------------------------------------------------------------------------

/**
 * 409 LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY when the establishment profile
 * tries to CHANGE the razón social or the NIF: they belong to the sociedad and
 * are edited in Configuración › Estructura societaria › Datos fiscales. Values
 * equal to the sociedad's are tolerated (a form that still preloads them).
 */
export async function assertProfileDoesNotWriteLegalIdentity(organizationId: string, payload: { legalName?: string; taxId?: string }): Promise<void> {
  const legalName = payload.legalName?.trim() ?? "";
  const taxId = normalizeTaxId(payload.taxId) ?? "";
  if (!legalName && !taxId) return;
  const identity = await resolveLegalIdentity(organizationId);
  const currentName = identity?.legalName.trim() ?? "";
  const currentTaxId = identity?.taxId ?? "";
  const offending: string[] = [];
  if (legalName && legalName !== currentName) offending.push("legalName");
  if (taxId && taxId !== currentTaxId) offending.push("taxId");
  if (offending.length === 0) return;
  throw new ConflictError(
    "El NIF y la razón social son de la sociedad, no del establecimiento: se editan en Configuración › Estructura societaria › Datos fiscales. El perfil del establecimiento solo guarda el nombre comercial y el código del centro.",
    { code: "LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY" satisfies StructureErrorCode, fields: offending, legalEntityId: identity?.legalEntityId ?? null, route: STRUCTURE_ROUTE }
  );
}
