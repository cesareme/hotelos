import type { HotelModuleCode } from "@hotelos/product";
import { getHotelModuleManifest, getManualSetupOption, HOTEL_MODULES, MANUAL_SETUP_COVERAGE_SUMMARY, MANUAL_SETUP_OPTIONS } from "@hotelos/product";
import {
  ORGANIZATION_TEMPLATE_ROLE_KEYS,
  PERMISSIONS,
  ROLE_PERMISSION_MAP,
  ROLE_TEMPLATE_DEFAULT_SCOPE,
  ROLE_TEMPLATE_DESCRIPTIONS_ES,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LABELS_ES,
  ROLE_TEMPLATE_LEVEL,
  ROLE_TEMPLATE_VERSION,
  isPlatformPermission,
  type AuditEvent,
  type PermissionKey,
  type RoleKey,
  type RoleLevel,
  type ScopeType
} from "@hotelos/shared";
import { existsSync } from "node:fs";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
// Tanda 8a (RBAC · L3, design §5.4, §5.5, §6.6, C11): users and roles per
// hotel are REAL — the list only shows users whose live assignment covers the
// property (lib/rbac-scope.ts, the single reader of user_property_roles ∪
// user_role_assignments), an invitation carries a scope and a template whose
// level the inviter must hold (403 RBAC_SCOPE_EXCEEDED / RBAC_LEVEL_EXCEEDED),
// the grant is written in both tables (writeRoleAssignment) and audited as
// ROLE_ASSIGNED, and disabling a user revokes its assignments, sessions and
// pending invitations (USER_DISABLED). Retiring a user from ONE hotel is the
// job of DELETE /rbac/assignments/:id (modules/rbac), never of this file.
import { recordRoleAssigned, writeRoleAssignment } from "../auth/auth-pilot.service.js";
import { createInvitation, getPendingInvitations, type PendingInvitationInfo } from "../auth/invitations.service.js";
import { assertNotBreakGlass } from "../rbac/assignments.service.js";
import { bumpRbacVersion, coversProperty, loadUserScope, maxRankOf, rankOfAssignment, type ScopeAssignment } from "../../lib/rbac-scope.js";
import { ensurePropertyModulePersisted, listPropertyModules } from "../product-modules/product-modules.service.js";
import { getPropertyTaxProfile, invalidateTaxCache } from "../accounting/tax-rate.service.js";
import { resolveSesEstablishment } from "../compliance/ses-submission.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, RbacForbiddenError } from "../../lib/http-error.js";
import { ensureRoleHasPermissions } from "../../lib/rbac-catalog.js";
import { ensurePropertyTaxes } from "../../lib/tenant-hydration.js";
// Tanda 6b (L2 · estructura societaria): the issuer identity (NIF, razón social)
// is read from the legal entity only; the property profile keeps the trade name
// and the centre code; series prefixes follow R3 and are unique per legal entity.
import { resolveLegalIdentity } from "../../lib/finance-scope.js";
import { assertSeriesPrefixFree, defaultSeriesPrefix } from "../invoicing/series-prefix.service.js";
import { lockSeriesOpening } from "../invoicing/invoice.service.js";
import { assertProfileDoesNotWriteLegalIdentity, codeInUse } from "../structure/legal-entity.service.js";
import { STRUCTURE_CODE_PATTERN } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { z } from "zod";
import { parse } from "../../lib/validate.js";
// Tanda L2 (L2-04): el gestor de categorías, los campos personalizados y las
// tablas de puesta en marcha (salud de módulos, pasos, envíos manuales y de
// formularios) viven en Prisma; el acceso a filas está en categories.store.ts y
// setup.store.ts, los catálogos y los esquemas zod siguen aquí.
import {
  countCustomFieldDefinitions,
  countPropertyCategoryOptions,
  createCustomFieldDefinition,
  createPropertyCategoryOption,
  findCategoryDefinitionByCode,
  findCategoryDefinitionById,
  findCustomFieldDefinition,
  findPropertyCategoryOption,
  findPropertyCategoryOptionByCode,
  listCategoryDefinitions,
  listCustomFieldDefinitions,
  listCustomFieldValues,
  listPropertyCategoryOptions,
  updateCategoryOptionOrder,
  updateCustomFieldDefinition,
  updatePropertyCategoryOption,
  upsertCustomFieldValue,
  type CategoryDefinitionRecord,
  type PropertyCategoryOptionRecord,
  type PropertyCustomFieldDefinitionRecord
} from "./categories.store.js";
import {
  createManualSetupSubmission,
  createSetupFormSubmission,
  ensureSetupSteps,
  findSetupStep,
  latestManualSetupSubmissionsByOption,
  latestSetupFormSubmissionsByForm,
  listManualSetupSubmissions,
  listModuleHealthChecks,
  listSetupFormSubmissions,
  listSetupSteps,
  replaceModuleHealthChecks,
  upsertSetupStep,
  type ModuleHealthCheckInput
} from "./setup.store.js";
// Tanda L5 (lote C): el readiness se recalcula en el GET cuando las filas faltan
// o superan la ventana (readiness-freshness.ts, puro); el go-live escribe
// properties.go_live_at y completa el paso `go_live`.
import { isReadinessStale, readinessComputedAt } from "./readiness-freshness.js";
// Tanda L5 (lote A → C, dueño único de este fichero): el estado de habitación
// del bulk PATCH pasa por la transición unificada (idempotente, auditada como
// ROOM_STATE_CHANGED, respeta ocupación / OOO) y las filas se tipan desde el
// vocabulario cerrado del helper único (sin fallback: hk / mnt ya son NOT NULL).
import {
  HOUSEKEEPING_STATUSES,
  MAINTENANCE_STATUSES,
  applyRoomTransition,
  emitRoomStateEvents,
  isHousekeepingStatus,
  nextRoomState,
  snapshotOf,
  type ApplyRoomTransitionResult,
  type HousekeepingStatus,
  type MaintenanceStatus,
  type RoomStateEvent
} from "../housekeeping/room-state.service.js";
import {
  describeSesEstablishmentIssue,
  isValidSpanishTaxId,
  normalizeTaxId,
  normalizeTaxRegion,
  resolveVerifactuSoftware,
  spanishTaxIdValidationMessage,
  type TaxCategory,
  type TaxRegion
} from "@hotelos/compliance";
import {
  demoStore,
  type AccountingSettingsRecord,
  type BackOfficeAiSuggestionRecord,
  type BuildingRecord,
  type DepartmentRecord,
  type FloorRecord,
  type InvoiceSequenceRecord,
  type BedTypeRecord,
  type DocumentTemplateRecord,
  type HousekeepingSectionRecord,
  type MaintenanceAreaRecord,
  type ManualSetupSubmissionRecord,
  type OrganizationRecord,
  type PropertyAiSettingsRecord,
  type PropertyComplianceSettingsRecord,
  type PropertyRecord,
  type PropertyImportRecord,
  type PropertyMapPositionRecord,
  type PropertyReadinessCheckRecord,
  type PropertySetupFormSubmissionRecord,
  type PropertySpaceRecord,
  type PropertySetupStepRecord,
  type PropertyZoneRecord,
  type QrCodeRecord,
  type RoomFeatureRecord,
  type RoomRecord,
  type RoomTypeRecord,
  type UserDepartmentRecord,
  type UserRecord,
  type UserContext
} from "../../lib/demo-store.js";

// Fase 0 (Opción A): mapper Prisma Room row -> RoomRecord. Replica el mapRoom de
// pms.service.ts (no se importa para evitar acoplar módulos / ciclos). Normaliza
// nullables a undefined y Decimal squareMeters a number, igual que el mirror del PMS.
function mapRoomRow(row: {
  id: string;
  propertyId: string;
  roomTypeId: string;
  buildingId: string | null;
  floorId: string | null;
  zoneId: string | null;
  number: string;
  floor: string | null;
  roomCode: string | null;
  displayName: string | null;
  maxOccupancy: number | null;
  standardOccupancy: number | null;
  bedConfigurationJson: unknown;
  featuresJson: unknown;
  accessibilityJson: unknown;
  viewType: string | null;
  orientation: string | null;
  squareMeters: { toString(): string } | number | null;
  status: RoomRecord["status"];
  /** NOT NULL desde 20260919090000_operaciones_l5 (Tanda L5 · lote A). */
  housekeepingStatus: string;
  maintenanceStatus: string;
  sellable: boolean;
  active: boolean;
  sortOrder: number;
}): RoomRecord {
  const state = snapshotOf(row);
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    buildingId: row.buildingId ?? undefined,
    floorId: row.floorId ?? undefined,
    zoneId: row.zoneId ?? undefined,
    number: row.number,
    floor: row.floor ?? "",
    roomCode: row.roomCode ?? undefined,
    displayName: row.displayName ?? undefined,
    maxOccupancy: row.maxOccupancy ?? undefined,
    standardOccupancy: row.standardOccupancy ?? undefined,
    bedConfigurationJson: (row.bedConfigurationJson as Record<string, unknown> | null) ?? undefined,
    featuresJson: (row.featuresJson as Record<string, unknown> | null) ?? undefined,
    accessibilityJson: (row.accessibilityJson as Record<string, unknown> | null) ?? undefined,
    viewType: row.viewType ?? undefined,
    orientation: row.orientation ?? undefined,
    squareMeters: row.squareMeters === null ? undefined : Number(row.squareMeters),
    status: row.status,
    // Tanda L5 (lote A): sin fallback a NULL (columnas NOT NULL desde la migración
    // 20260919090000_operaciones_l5); el tipado sale del helper único, que solo
    // normaliza restos fuera de vocabulario de espejos o seeds de test.
    housekeepingStatus: state.housekeepingStatus,
    maintenanceStatus: state.maintenanceStatus,
    sellable: row.sellable,
    active: row.active,
    sortOrder: row.sortOrder
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fase 0 (persistencia Back Office, tanda 2): dual-write Prisma + demoStore para
// la configuración del hotel (room types, perfil, fiscal/facturación, usuarios,
// departamentos, HK/mantenimiento, plantillas, QR, AI). Regla:
//   · Escritura: Prisma PRIMERO (fuente durable; si falla no se toca memoria),
//     después espejo demoStore con el MISMO id — los lectores legacy síncronos
//     (readiness, validadores de módulos, export/preview) siguen funcionando.
//   · Lectura (GETs de confirmación): Prisma primero, merge con los registros
//     que solo existen en el seed in-memory (p.ej. hk_f4, tpl_welcome_es) para
//     no regresionar la demo sembrada; de paso se refresca el espejo.
// Ver docs/strategy/anfitorio-equipo-2026-06/PERSIST-BACKOFFICE.md.

type PropertyRow = NonNullable<Awaited<ReturnType<typeof prisma.property.findFirst>>>;
type OrganizationRow = NonNullable<Awaited<ReturnType<typeof prisma.organization.findFirst>>>;
type UserRow = NonNullable<Awaited<ReturnType<typeof prisma.user.findFirst>>>;
type RoomTypeRow = NonNullable<Awaited<ReturnType<typeof prisma.roomType.findFirst>>>;
type RoomFeatureRow = NonNullable<Awaited<ReturnType<typeof prisma.roomFeature.findFirst>>>;
type BedTypeRow = NonNullable<Awaited<ReturnType<typeof prisma.bedType.findFirst>>>;
type DepartmentRow = NonNullable<Awaited<ReturnType<typeof prisma.department.findFirst>>>;
type UserDepartmentRow = NonNullable<Awaited<ReturnType<typeof prisma.userDepartment.findFirst>>>;
type HousekeepingSectionRow = NonNullable<Awaited<ReturnType<typeof prisma.housekeepingSection.findFirst>>>;
type HousekeepingRuleRow = NonNullable<Awaited<ReturnType<typeof prisma.housekeepingRule.findFirst>>>;
type MaintenanceAreaRow = NonNullable<Awaited<ReturnType<typeof prisma.maintenanceArea.findFirst>>>;
type MaintenanceRuleRow = NonNullable<Awaited<ReturnType<typeof prisma.maintenanceRule.findFirst>>>;
type ComplianceSettingsRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyComplianceSetting.findFirst>>>;
type InvoiceSequenceRow = NonNullable<Awaited<ReturnType<typeof prisma.invoiceSequence.findFirst>>>;
type AccountingSettingsRow = NonNullable<Awaited<ReturnType<typeof prisma.accountingSetting.findFirst>>>;
type AiSettingsRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyAiSetting.findFirst>>>;
type DocumentTemplateRow = NonNullable<Awaited<ReturnType<typeof prisma.documentTemplate.findFirst>>>;
type QrCodeRow = NonNullable<Awaited<ReturnType<typeof prisma.qrCode.findFirst>>>;
type AuditEventRow = NonNullable<Awaited<ReturnType<typeof prisma.auditEvent.findFirst>>>;
type ReadinessCheckRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyReadinessCheck.findFirst>>>;

const asJson = (value: Record<string, unknown> | undefined): Prisma.InputJsonValue => (value ?? {}) as Prisma.InputJsonValue;

const jsonRecord = (value: unknown): Record<string, unknown> => (value as Record<string, unknown> | null) ?? {};

const isoDate = (value: Date | string | null | undefined): string => (value instanceof Date ? value.toISOString() : value ?? nowIso());

/** Une filas Prisma (prioritarias) con registros que solo viven en demoStore (dedup por id). */
function mergeById<T extends { id: string }>(primary: T[], secondary: T[]): T[] {
  const seen = new Set(primary.map((record) => record.id));
  return [...primary, ...secondary.filter((record) => !seen.has(record.id))];
}

/** Actualiza in place (conserva identidad de objeto) o inserta el registro espejo en demoStore. */
function mirrorRecord<T extends { id: string }>(collection: T[], record: T, match?: (candidate: T) => boolean): T {
  const existing = collection.find(match ?? ((candidate) => candidate.id === record.id));
  if (existing) {
    Object.assign(existing, record);
    return existing;
  }
  collection.push(record);
  return record;
}

function mapPropertyRow(row: PropertyRow): PropertyRecord {
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

/** Property para lecturas de confirmación: Prisma primero, fallback al seed in-memory (p.ej. prop_456). */
async function resolveProperty(propertyId: string): Promise<PropertyRecord | undefined> {
  const row = await prisma.property.findUnique({ where: { id: propertyId } });
  if (row) return mapPropertyRow(row);
  return demoStore.properties.find((candidate) => candidate.id === propertyId);
}

function mapOrganizationRow(row: OrganizationRow): OrganizationRecord {
  // legalName/taxId are nullable in Prisma but required strings in the legacy shape:
  // an empty string means "not configured" — never borrow the demo organization's values.
  return { id: row.id, name: row.name, legalName: row.legalName ?? "", taxId: row.taxId ?? "" };
}

/**
 * Organization of a property: Prisma-first; the in-memory demo organization is
 * only a fallback for ITSELF (seed-only tenants), never for another tenant's id.
 * Missing organization = typed 404 (the property row would be dangling).
 */
async function requireOrganization(organizationId: string): Promise<OrganizationRecord> {
  const row: OrganizationRow | null = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (row) {
    const mapped = mapOrganizationRow(row);
    if (demoStore.organization.id === mapped.id) {
      // Mirror only the columns that are set in Prisma so a null column never blanks the seed values.
      Object.assign(demoStore.organization, { name: row.name }, row.legalName ? { legalName: row.legalName } : {}, row.taxId ? { taxId: row.taxId } : {});
      return demoStore.organization;
    }
    return mapped;
  }
  if (demoStore.organization.id === organizationId) return demoStore.organization;
  throw new NotFoundError("Organización no encontrada.");
}

function mapUserRow(row: UserRow): UserRecord {
  // Mapeo explícito: NUNCA propagar passwordHash/lockout al shape de la API.
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    phone: row.phone ?? undefined,
    fullName: row.fullName,
    status: row.status as UserRecord["status"],
    mfaEnabled: row.mfaEnabled
  };
}

function mapRoomTypeRow(row: RoomTypeRow): RoomTypeRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    code: row.code,
    maxOccupancy: row.maxOccupancy,
    baseCapacity: row.baseCapacity,
    description: row.description ?? undefined,
    defaultBedConfigurationJson: jsonRecord(row.defaultBedConfigurationJson),
    defaultAmenitiesJson: jsonRecord(row.defaultAmenitiesJson),
    defaultPhotosJson: jsonRecord(row.defaultPhotosJson),
    defaultRateCategory: row.defaultRateCategory ?? undefined,
    sellable: row.sellable,
    displayOrder: row.displayOrder,
    active: row.active
  };
}

function mapRoomFeatureRow(row: RoomFeatureRow): RoomFeatureRecord {
  return { id: row.id, propertyId: row.propertyId, code: row.code, name: row.name, category: row.category ?? undefined, active: row.active };
}

function mapBedTypeRow(row: BedTypeRow): BedTypeRecord {
  return { id: row.id, propertyId: row.propertyId, code: row.code, name: row.name, capacity: row.capacity, active: row.active };
}

function mapDepartmentRow(row: DepartmentRow): DepartmentRecord {
  return { id: row.id, propertyId: row.propertyId, name: row.name, code: row.code, description: row.description ?? undefined, active: row.active };
}

function mapUserDepartmentRow(row: UserDepartmentRow): UserDepartmentRecord {
  return { id: row.id, userId: row.userId, departmentId: row.departmentId, roleLabel: row.roleLabel ?? undefined, active: row.active };
}

function mapHousekeepingSectionRow(row: HousekeepingSectionRow): HousekeepingSectionRecord {
  return { id: row.id, propertyId: row.propertyId, name: row.name, code: row.code ?? undefined, description: row.description ?? undefined, active: row.active };
}

function mapMaintenanceAreaRow(row: MaintenanceAreaRow): MaintenanceAreaRecord {
  return { id: row.id, propertyId: row.propertyId, name: row.name, code: row.code ?? undefined, description: row.description ?? undefined, active: row.active };
}

function mapConfigRuleRow(row: HousekeepingRuleRow | MaintenanceRuleRow): { id: string; propertyId: string; ruleCode: string; configurationJson: Record<string, unknown>; active: boolean } {
  return { id: row.id, propertyId: row.propertyId, ruleCode: row.ruleCode, configurationJson: jsonRecord(row.configurationJson), active: row.active };
}

function mapComplianceRow(row: ComplianceSettingsRow): PropertyComplianceSettingsRecord {
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
    configurationJson: jsonRecord(row.configurationJson),
    updatedAt: isoDate(row.updatedAt)
  };
}

function mapInvoiceSequenceRow(row: InvoiceSequenceRow): InvoiceSequenceRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    sequenceCode: row.sequenceCode,
    prefix: row.prefix ?? undefined,
    nextNumber: row.nextNumber,
    padding: row.padding,
    invoiceType: row.invoiceType as InvoiceSequenceRecord["invoiceType"],
    active: row.active
  };
}

function mapAccountingRow(row: AccountingSettingsRow): AccountingSettingsRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    chartTemplate: row.chartTemplate ?? undefined,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    configurationJson: jsonRecord(row.configurationJson),
    updatedAt: isoDate(row.updatedAt)
  };
}

function mapAiSettingsRow(row: AiSettingsRow): PropertyAiSettingsRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    aiEnabled: row.aiEnabled,
    defaultAutomationLevel: row.defaultAutomationLevel as PropertyAiSettingsRecord["defaultAutomationLevel"],
    guestFacingDisclosure: row.guestFacingDisclosure ?? undefined,
    voiceLocales: row.voiceLocales,
    configurationJson: jsonRecord(row.configurationJson),
    updatedAt: isoDate(row.updatedAt)
  };
}

function mapDocumentTemplateRow(row: DocumentTemplateRow): DocumentTemplateRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    templateCode: row.templateCode,
    name: row.name,
    channel: row.channel as DocumentTemplateRecord["channel"],
    language: row.language,
    subject: row.subject ?? undefined,
    body: row.body,
    variablesJson: jsonRecord(row.variablesJson),
    active: row.active,
    updatedAt: isoDate(row.updatedAt)
  };
}

/** Maps a persisted audit_events row to the shared AuditEvent shape (ISO dates, undefined for nulls). */
function mapAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    actorUserId: row.actorUserId ?? undefined,
    actorType: row.actorType,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? undefined,
    beforeJson: row.beforeJson ?? undefined,
    afterJson: row.afterJson ?? undefined,
    ipAddress: row.ipAddress ?? undefined,
    deviceId: row.deviceId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    hashAlgorithm: "sha256",
    previousHash: row.previousHash ?? undefined,
    currentHash: row.currentHash,
    createdAt: isoDate(row.createdAt)
  };
}

function mapReadinessCheckRow(row: ReadinessCheckRow): PropertyReadinessCheckRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    checkCode: row.checkCode,
    status: row.status as PropertyReadinessCheckRecord["status"],
    severity: row.severity as PropertyReadinessCheckRecord["severity"],
    message: row.message,
    relatedEntityType: row.relatedEntityType ?? undefined,
    relatedEntityId: row.relatedEntityId ?? undefined,
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt)
  };
}

function mapQrCodeRow(row: QrCodeRow): QrCodeRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    entityType: row.entityType as QrCodeRecord["entityType"],
    entityId: row.entityId,
    qrValue: row.qrValue,
    purpose: row.purpose as QrCodeRecord["purpose"],
    active: row.active,
    createdAt: isoDate(row.createdAt)
  };
}

/** Upsert de PropertyComplianceSetting (unique propertyId) desde el shape en memoria. */
async function persistComplianceSettings(next: PropertyComplianceSettingsRecord): Promise<PropertyComplianceSettingsRecord> {
  const data = {
    country: next.country,
    taxRegion: next.taxRegion ?? null,
    vatRegime: next.vatRegime ?? null,
    tourismTaxRegion: next.tourismTaxRegion ?? null,
    sesHospedajesEnabled: next.sesHospedajesEnabled,
    verifactuEnabled: next.verifactuEnabled,
    ticketbaiEnabled: next.ticketbaiEnabled,
    siiEnabled: next.siiEnabled,
    b2bEinvoiceEnabled: next.b2bEinvoiceEnabled,
    configurationJson: asJson(next.configurationJson)
  };
  const row = await prisma.propertyComplianceSetting.upsert({
    where: { propertyId: next.propertyId },
    update: data,
    create: { id: next.id, propertyId: next.propertyId, ...data }
  });
  return mapComplianceRow(row);
}

// ─────────────────────────────────────────────────────────────────────────────
// CFG-P1-4: per-property settings are provisioned lazily. A property that only
// exists in Prisma (created by createTenant/bootstrapPilot) has no
// PropertyComplianceSetting / PropertyAiSetting row: readers return explicit
// defaults flagged `provisioned: false`, and the first PATCH upserts the row
// (defaults + patch). Default ids follow the seed convention (pcs_<id>, ai_<id>)
// so GET and the subsequent PATCH agree on the identifier.

const byPropertyId = <T extends { propertyId: string }>(propertyId: string) => (candidate: T) => candidate.propertyId === propertyId;

/** Compliance defaults derived from the property row itself (country/tax region/flags), all other integrations off. */
function defaultComplianceSettings(property: PropertyRecord): PropertyComplianceSettingsRecord {
  return {
    id: `pcs_${property.id}`,
    propertyId: property.id,
    country: property.country,
    taxRegion: property.taxRegion,
    vatRegime: undefined,
    tourismTaxRegion: undefined,
    sesHospedajesEnabled: property.sesHospedajesEnabled,
    verifactuEnabled: property.verifactuEnabled,
    ticketbaiEnabled: false,
    siiEnabled: false,
    b2bEinvoiceEnabled: false,
    configurationJson: {},
    updatedAt: nowIso()
  };
}

/** Persisted (Prisma, mirrored) or seed-only compliance record; undefined when the property has neither. */
async function findComplianceSettings(propertyId: string): Promise<{ settings: PropertyComplianceSettingsRecord; provisioned: boolean } | undefined> {
  const row = await prisma.propertyComplianceSetting.findUnique({ where: { propertyId } });
  if (row) {
    return { settings: mirrorRecord(demoStore.propertyComplianceSettings, mapComplianceRow(row), byPropertyId(propertyId)), provisioned: true };
  }
  const legacy = demoStore.propertyComplianceSettings.find(byPropertyId(propertyId));
  return legacy ? { settings: legacy, provisioned: false } : undefined;
}

/** Compliance settings for any existing property: persisted row, seed record, or defaults (404 if the property does not exist). */
async function resolveComplianceSettings(propertyId: string): Promise<{ settings: PropertyComplianceSettingsRecord; provisioned: boolean }> {
  const found = await findComplianceSettings(propertyId);
  if (found) return found;
  const property = await requireProperty(propertyId);
  return { settings: defaultComplianceSettings(property), provisioned: false };
}

// Keep in sync with ai-operations/property-ai.service.ts defaultSettings(): AI on,
// safe suggest_and_confirm level, bilingual disclosure. configurationJson adds the
// privacy-safe ID-image retention default this module's PATCH guard enforces.
const DEFAULT_AI_GUEST_DISCLOSURE =
  "Parte de la atención de este establecimiento puede estar gestionada por un asistente de inteligencia artificial. " +
  "Puede solicitar hablar con una persona del equipo en cualquier momento.\n" +
  "Some interactions at this property may be handled by an AI assistant. " +
  "You can ask to speak with a member of staff at any time.";

function defaultAiSettings(propertyId: string): PropertyAiSettingsRecord {
  return {
    id: `ai_${propertyId}`,
    propertyId,
    aiEnabled: true,
    defaultAutomationLevel: "suggest_and_confirm",
    guestFacingDisclosure: DEFAULT_AI_GUEST_DISCLOSURE,
    voiceLocales: ["es-ES", "en-GB"],
    configurationJson: { documentImageRetentionPolicy: "discard_after_ocr" },
    updatedAt: nowIso()
  };
}

/** AI settings for any property: persisted row (mirrored), seed record, or defaults. Never throws for a missing row. */
async function resolveAiSettings(propertyId: string): Promise<{ settings: PropertyAiSettingsRecord; provisioned: boolean }> {
  const row = await prisma.propertyAiSetting.findUnique({ where: { propertyId } });
  if (row) {
    return { settings: mirrorRecord(demoStore.propertyAiSettings, mapAiSettingsRow(row), byPropertyId(propertyId)), provisioned: true };
  }
  const legacy = demoStore.propertyAiSettings.find(byPropertyId(propertyId));
  return { settings: legacy ?? defaultAiSettings(propertyId), provisioned: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistencia tanda 2 (continuación): helpers de materialización para
// departamentos, usuarios, HK/mantenimiento, secuencias, plantillas y settings.
// Regla común: lookup Prisma-first (refresca espejo); los registros que solo
// viven en el seed in-memory se materializan (createMany + skipDuplicates,
// mismo id) para que la siguiente edición ya persista.

function departmentToDbRow(record: DepartmentRecord) {
  return {
    id: record.id,
    propertyId: record.propertyId,
    name: record.name,
    code: record.code,
    description: record.description ?? null,
    active: record.active
  };
}

async function requireDepartment(propertyId: string, departmentId: string): Promise<DepartmentRecord> {
  const row = await prisma.department.findFirst({ where: { id: departmentId, propertyId } });
  if (row) return mirrorRecord(demoStore.departments, mapDepartmentRow(row));
  const legacy = demoStore.departments.find((candidate) => candidate.propertyId === propertyId && candidate.id === departmentId);
  if (!legacy) {
    throw new NotFoundError("Departamento no encontrado.");
  }
  await prisma.department.createMany({ data: [departmentToDbRow(legacy)], skipDuplicates: true });
  return legacy;
}

function housekeepingSectionToDbRow(record: HousekeepingSectionRecord) {
  return {
    id: record.id,
    propertyId: record.propertyId,
    name: record.name,
    code: record.code ?? null,
    description: record.description ?? null,
    active: record.active
  };
}

async function requireHousekeepingSection(propertyId: string, sectionId: string): Promise<HousekeepingSectionRecord> {
  const row = await prisma.housekeepingSection.findFirst({ where: { id: sectionId, propertyId } });
  if (row) return mirrorRecord(demoStore.housekeepingSections, mapHousekeepingSectionRow(row));
  const legacy = demoStore.housekeepingSections.find((candidate) => candidate.propertyId === propertyId && candidate.id === sectionId);
  if (!legacy) {
    throw new NotFoundError("Sección de pisos no encontrada.");
  }
  await prisma.housekeepingSection.createMany({ data: [housekeepingSectionToDbRow(legacy)], skipDuplicates: true });
  return legacy;
}

function maintenanceAreaToDbRow(record: MaintenanceAreaRecord) {
  return {
    id: record.id,
    propertyId: record.propertyId,
    name: record.name,
    code: record.code ?? null,
    description: record.description ?? null,
    active: record.active
  };
}

async function requireMaintenanceArea(propertyId: string, areaId: string): Promise<MaintenanceAreaRecord> {
  const row = await prisma.maintenanceArea.findFirst({ where: { id: areaId, propertyId } });
  if (row) return mirrorRecord(demoStore.maintenanceAreas, mapMaintenanceAreaRow(row));
  const legacy = demoStore.maintenanceAreas.find((candidate) => candidate.propertyId === propertyId && candidate.id === areaId);
  if (!legacy) {
    throw new NotFoundError("Área de mantenimiento no encontrada.");
  }
  await prisma.maintenanceArea.createMany({ data: [maintenanceAreaToDbRow(legacy)], skipDuplicates: true });
  return legacy;
}

/** Valida que todos los roomIds pertenezcan a la propiedad (Prisma o espejo legacy). */
async function assertRoomsBelongToProperty(propertyId: string, roomIds: string[]): Promise<void> {
  const rows = roomIds.length > 0
    ? await prisma.room.findMany({ where: { id: { in: roomIds }, propertyId }, select: { id: true } })
    : [];
  const persistedIds = new Set(rows.map((room) => room.id));
  for (const roomId of roomIds) {
    const known = persistedIds.has(roomId) || demoStore.rooms.some((candidate) => candidate.id === roomId && candidate.propertyId === propertyId);
    if (!known) {
      throw new BadRequestError("Todas las habitaciones asignadas deben pertenecer a la propiedad.");
    }
  }
}

/**
 * Building/floor/zone ids written by room, floor, zone and space mutations must
 * belong to the property (Prisma or seed mirror). Returns the floor name for room rows.
 */
async function resolveMapReferences(
  propertyId: string,
  refs: { buildingId?: string; floorId?: string; zoneId?: string }
): Promise<{ floorName: string }> {
  const { buildingId, floorId, zoneId } = refs;
  if (buildingId) {
    const building =
      (await prisma.building.findFirst({ where: { id: buildingId, propertyId }, select: { id: true } })) ??
      demoStore.buildings.find((candidate) => candidate.id === buildingId && candidate.propertyId === propertyId);
    if (!building) {
      throw new NotFoundError("Building was not found.");
    }
  }
  let floorName = "";
  if (floorId) {
    const floor =
      (await prisma.floor.findFirst({ where: { id: floorId, propertyId }, select: { name: true } })) ??
      demoStore.floors.find((candidate) => candidate.id === floorId && candidate.propertyId === propertyId);
    if (!floor) {
      throw new NotFoundError("Floor was not found.");
    }
    floorName = floor.name;
  }
  if (zoneId) {
    const zone =
      (await prisma.propertyZone.findFirst({ where: { id: zoneId, propertyId }, select: { id: true } })) ??
      demoStore.propertyZones.find((candidate) => candidate.id === zoneId && candidate.propertyId === propertyId);
    if (!zone) {
      throw new NotFoundError("Zone was not found.");
    }
  }
  return { floorName };
}

/** Rooms by id for configuration reads: one Prisma query, seed mirror only for ids the DB does not have. */
async function resolveRoomsById(propertyId: string, roomIds: string[]): Promise<Map<string, RoomRecord>> {
  const uniqueIds = [...new Set(roomIds)];
  const rows = uniqueIds.length > 0
    ? await prisma.room.findMany({ where: { id: { in: uniqueIds }, propertyId } })
    : [];
  const roomsById = new Map<string, RoomRecord>();
  for (const row of rows) {
    roomsById.set(row.id, mirrorRecord(demoStore.rooms, mapRoomRow(row)));
  }
  for (const roomId of uniqueIds) {
    if (roomsById.has(roomId)) continue;
    const legacy = demoStore.rooms.find((candidate) => candidate.id === roomId && candidate.propertyId === propertyId);
    if (legacy) roomsById.set(roomId, legacy);
  }
  return roomsById;
}

function userToDbRow(record: UserRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    email: record.email,
    phone: record.phone ?? null,
    fullName: record.fullName,
    status: record.status,
    mfaEnabled: record.mfaEnabled
  };
}

/**
 * Usuario para mutaciones, acotado a la organización de la propiedad: Prisma
 * primero; un usuario solo-seed se materializa (skipDuplicates protege contra el
 * unique de email). `persisted` indica si la fila existe en la BD tras el
 * intento — si no, se muta solo el espejo.
 */
async function requireBackOfficeUser(organizationId: string, userId: string): Promise<{ user: UserRecord; persisted: boolean }> {
  const row = await prisma.user.findFirst({ where: { id: userId, organizationId } });
  if (row) return { user: mirrorRecord(demoStore.users, mapUserRow(row)), persisted: true };
  const legacy = demoStore.users.find((candidate) => candidate.id === userId && candidate.organizationId === organizationId);
  if (!legacy) {
    throw new NotFoundError("User was not found.");
  }
  await prisma.user.createMany({ data: [userToDbRow(legacy)], skipDuplicates: true });
  const persistedRow = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  return { user: legacy, persisted: Boolean(persistedRow) };
}

async function requireAccountingSettings(propertyId: string): Promise<AccountingSettingsRecord> {
  const row = await prisma.accountingSetting.findFirst({ where: { propertyId } });
  if (row) {
    return mirrorRecord(demoStore.accountingSettings, mapAccountingRow(row), (candidate) => candidate.propertyId === row.propertyId);
  }
  const legacy = demoStore.accountingSettings.find((candidate) => candidate.propertyId === propertyId);
  if (!legacy) {
    throw new NotFoundError("Configuración contable no encontrada.");
  }
  await prisma.accountingSetting.createMany({
    data: [
      {
        id: legacy.id,
        organizationId: legacy.organizationId,
        propertyId: legacy.propertyId ?? null,
        chartTemplate: legacy.chartTemplate ?? null,
        fiscalYearStartMonth: legacy.fiscalYearStartMonth,
        configurationJson: asJson(legacy.configurationJson)
      }
    ],
    skipDuplicates: true
  });
  return legacy;
}

function documentTemplateToDbRow(record: DocumentTemplateRecord) {
  return {
    id: record.id,
    propertyId: record.propertyId,
    templateCode: record.templateCode,
    name: record.name,
    channel: record.channel,
    language: record.language,
    subject: record.subject ?? null,
    body: record.body,
    variablesJson: asJson(record.variablesJson),
    active: record.active
  };
}

async function requireDocumentTemplate(propertyId: string, templateId: string): Promise<DocumentTemplateRecord> {
  const row = await prisma.documentTemplate.findFirst({ where: { id: templateId, propertyId } });
  if (row) return mirrorRecord(demoStore.documentTemplates, mapDocumentTemplateRow(row));
  const legacy = demoStore.documentTemplates.find((candidate) => candidate.propertyId === propertyId && candidate.id === templateId);
  if (!legacy) {
    throw new NotFoundError("Plantilla no encontrada.");
  }
  await prisma.documentTemplate.createMany({ data: [documentTemplateToDbRow(legacy)], skipDuplicates: true });
  return legacy;
}

type BackOfficeMutationInput = {
  context: UserContext;
  propertyId: string;
  correlationId: string;
};

type PropertyMapImportRow = {
  building?: string;
  floor?: string;
  zone?: string;
  roomNumber?: string;
  roomType?: string;
  maxOccupancy?: number;
  standardOccupancy?: number;
  beds?: string;
  features?: string;
  sellable?: boolean;
  active?: boolean;
  squareMeters?: number;
  viewType?: string;
  accessibility?: string;
};

/** Corrector L5 (L5F-06): etiqueta en español de cada paso del catálogo — única fuente (el front la lee del GET …/setup). */
export const SETUP_STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  organization_details: "Datos de la organización",
  property_legal_details: "Datos legales del establecimiento",
  property_physical_map: "Mapa físico (edificios, plantas, zonas)",
  room_types: "Tipos de habitación",
  rooms: "Habitaciones",
  departments: "Departamentos",
  users_and_roles: "Usuarios y roles",
  modules: "Módulos",
  tax_and_compliance: "Impuestos y cumplimiento",
  billing_and_invoice_sequences: "Facturación y series",
  payments: "Pagos",
  integrations: "Integraciones",
  ai_settings: "Ajustes de IA",
  review: "Revisión final",
  go_live: "Salida en vivo"
});

const SETUP_STEPS = [
  "organization_details",
  "property_legal_details",
  "property_physical_map",
  "room_types",
  "rooms",
  "departments",
  "users_and_roles",
  "modules",
  "tax_and_compliance",
  "billing_and_invoice_sequences",
  "payments",
  "integrations",
  "ai_settings",
  "review",
  "go_live"
];

// Tanda L2 (L2-04): CategoryDefinitionRecord, PropertyCategoryOptionRecord,
// PropertyCustomFieldDefinitionRecord y PropertyCustomFieldValueRecord se
// declaran en categories.store.ts (misma forma que la versión en memoria).

type PropertySetupFormField = {
  key: string;
  label: string;
  inputType:
    | "text"
    | "textarea"
    | "number"
    | "boolean"
    | "select"
    | "multi_select"
    | "money"
    | "date"
    | "json";
  required?: boolean;
  categoryCode?: string;
  /** Plain strings (value === label) or canonical `{ value, label }` pairs (persisted value ≠ human label). */
  options?: Array<string | PropertySetupFormOption>;
  mapsTo?: string;
};

export type PropertySetupFormOption = { value: string; label: string };

type PropertySetupFormDefinition = {
  code: string;
  title: string;
  route: string;
  apiRoute: string;
  description: string;
  permission: PermissionKey;
  targetEntityType: string;
  setupStepCode: string;
  inputCategories: string[];
  fields: PropertySetupFormField[];
  dataQualityChecks: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Tanda 3 (readiness-backoffice) · pure fiscal-profile and series helpers.
// No I/O: unit-tested in __tests__/fiscal-profile.test.mts and
// __tests__/invoice-series-policy.test.mts. Every writer of Property.taxRegion /
// postalCode / ineMunicipalityCode / fiscalTerritory (profile form, compliance
// settings, createTenant, bootstrap, onboarding import) goes through
// resolveFiscalLocation so the four surfaces share one validation contract.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical tax-region select (value persisted in Property.taxRegion, label shown by the wizard). */
export const TAX_REGION_OPTIONS: readonly PropertySetupFormOption[] = [
  { value: "ES_PENINSULA_BALEARES", label: "Península y Baleares (IVA)" },
  { value: "ES_CANARIAS", label: "Canarias (IGIC)" },
  { value: "ES_CEUTA", label: "Ceuta (IPSI)" },
  { value: "ES_MELILLA", label: "Melilla (IPSI)" }
];

export const FISCAL_TERRITORIES = ["common", "bizkaia", "gipuzkoa", "araba", "navarra"] as const;
export type FiscalTerritory = (typeof FISCAL_TERRITORIES)[number];

/** Reporting territory select: territorio común → VeriFactu (AEAT); forales → TicketBAI / Hacienda Foral. */
export const FISCAL_TERRITORY_OPTIONS: readonly PropertySetupFormOption[] = [
  { value: "common", label: "Territorio común (AEAT · VeriFactu)" },
  { value: "bizkaia", label: "Bizkaia (TicketBAI)" },
  { value: "gipuzkoa", label: "Gipuzkoa (TicketBAI)" },
  { value: "araba", label: "Araba/Álava (TicketBAI)" },
  { value: "navarra", label: "Navarra (Hacienda Foral)" }
];

/** Tourist-tax engine `ccaaCode` values (TouristTaxRate.ccaaCode) plus the explicit "none". */
export const TOURISM_TAX_REGION_CODES = ["CAT", "BAL", "EUSK"] as const;
export type TourismTaxRegionCode = (typeof TOURISM_TAX_REGION_CODES)[number];

export const TOURISM_TAX_REGION_OPTIONS: readonly PropertySetupFormOption[] = [
  { value: "none", label: "Sin tasa turística autonómica" },
  { value: "CAT", label: "Cataluña (IEET)" },
  { value: "BAL", label: "Illes Balears (ITS)" },
  { value: "EUSK", label: "Euskadi (tasa turística)" }
];

export const TOURIST_TAX_TREATMENTS = ["included_10", "not_subject", "none"] as const;
export type TouristTaxTreatmentCode = (typeof TOURIST_TAX_TREATMENTS)[number];

const POSTAL_CODE_PATTERN = /^\d{5}$/;
const INE_MUNICIPALITY_CODE_PATTERN = /^\d{5}$/;
/** Spanish province codes 01–52 (CP prefix and INE province code share the numbering). */
const PROVINCE_CODE_PATTERN = /^(0[1-9]|[1-4]\d|5[0-2])$/;

const hasText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Attach a machine-readable payload to a typed HTTP error (HttpError.details is forwarded on 4xx bodies). */
function withDetails<T extends { details?: unknown }>(error: T, details: Record<string, unknown>): T {
  error.details = details;
  return error;
}

/** Spanish postal code: exactly 5 digits with a real province prefix (01–52). Throws 400 otherwise. */
export function validatePostalCode(raw: string): string {
  const value = raw.trim();
  if (!POSTAL_CODE_PATTERN.test(value) || !PROVINCE_CODE_PATTERN.test(value.slice(0, 2))) {
    throw new BadRequestError(`Código postal no válido («${raw.trim()}»): deben ser 5 dígitos y empezar por el código de provincia (01–52).`);
  }
  return value;
}

/** INE municipality code: 5 digits = 2 (province) + 3 (municipality). Throws 400 otherwise. */
export function validateIneMunicipalityCode(raw: string): string {
  const value = raw.trim();
  if (!INE_MUNICIPALITY_CODE_PATTERN.test(value) || !PROVINCE_CODE_PATTERN.test(value.slice(0, 2))) {
    throw withDetails(
      new BadRequestError(
        `Código INE de municipio no válido («${raw.trim()}»): deben ser 5 dígitos (2 de provincia + 3 de municipio) y la provincia debe coincidir con la del código postal.`
      ),
      { code: "INE_MUNICIPALITY_CODE_INVALID", ineMunicipalityCode: raw.trim() }
    );
  }
  return value;
}

/**
 * CP and INE code must belong to the same province (same two-digit prefix). Throws 400
 * otherwise; the message states the rule so the PATCH caller knows what to fix.
 */
export function assertPostalAndIneCoherent(postalCode: string | null, ineMunicipalityCode: string | null): void {
  if (!postalCode || !ineMunicipalityCode) return;
  const postalProvinceCode = postalCode.slice(0, 2);
  const ineProvinceCode = ineMunicipalityCode.slice(0, 2);
  if (postalProvinceCode !== ineProvinceCode) {
    throw withDetails(
      new BadRequestError(
        `El código postal (${postalCode}) y el código INE (${ineMunicipalityCode}) pertenecen a provincias distintas (${postalProvinceCode} ≠ ${ineProvinceCode}): el código INE de municipio debe coincidir con la provincia del código postal (mismos dos primeros dígitos).`
      ),
      { code: "POSTAL_INE_PROVINCE_MISMATCH", postalCode, ineMunicipalityCode, postalProvinceCode, ineProvinceCode }
    );
  }
}

/** SES.HOSPEDAJES establishment registry number: 3–64 alphanumeric characters or hyphens (e.g. H-CO-000123). */
const SES_REGISTRY_NUMBER_PATTERN = /^[A-Za-z0-9-]{3,64}$/;

/** Trimmed SES registry number; 400 (details.code SES_REGISTRY_NUMBER_INVALID) when it does not match the pattern. */
export function validateSesRegistryNumber(raw: string): string {
  const value = raw.trim();
  if (!SES_REGISTRY_NUMBER_PATTERN.test(value)) {
    throw withDetails(
      new BadRequestError(
        `Número de registro SES.HOSPEDAJES no válido («${value}»): entre 3 y 64 caracteres alfanuméricos o guiones, sin espacios.`
      ),
      { code: "SES_REGISTRY_NUMBER_INVALID", sesRegistryNumber: value, minLength: 3, maxLength: 64 }
    );
  }
  return value;
}

/**
 * Three-state text field of a PATCH body: `undefined` (key absent) → no change,
 * `null` or blank text → clear (null), any other text → trimmed value. Numbers are
 * accepted as text (postal codes typed as JSON numbers); anything else is a 400.
 */
export function normalizeClearablePatchField(raw: unknown, fieldName: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string") {
    throw withDetails(new BadRequestError(`${fieldName} debe ser texto o null (null vacía el campo).`), {
      code: "PATCH_FIELD_TYPE_INVALID",
      field: fieldName,
      receivedType: typeof raw
    });
  }
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

/** Case-insensitive normalisation of the reporting territory; null when unrecognised. */
export function normalizeFiscalTerritory(raw: string | null | undefined): FiscalTerritory | null {
  if (!hasText(raw)) return null;
  const value = raw.trim().toLowerCase();
  const aliases: Record<string, FiscalTerritory> = {
    common: "common",
    comun: "common",
    "común": "common",
    aeat: "common",
    verifactu: "common",
    bizkaia: "bizkaia",
    vizcaya: "bizkaia",
    gipuzkoa: "gipuzkoa",
    guipuzcoa: "gipuzkoa",
    "guipúzcoa": "gipuzkoa",
    araba: "araba",
    alava: "araba",
    "álava": "araba",
    "araba/álava": "araba",
    navarra: "navarra",
    nafarroa: "navarra"
  };
  return aliases[value] ?? null;
}

/**
 * Tourism-tax region as the engine's ccaaCode. Accepts the legacy wizard labels
 * ("Catalonia", "Balearic Islands", "None"). Returns "none" for an explicit
 * "no tax", the code, or null when unrecognised.
 */
export function normalizeTourismTaxRegion(raw: string | null | undefined): TourismTaxRegionCode | "none" | null {
  if (!hasText(raw)) return null;
  const value = raw.trim().toLowerCase();
  const aliases: Record<string, TourismTaxRegionCode | "none"> = {
    none: "none",
    ninguna: "none",
    "sin tasa": "none",
    cat: "CAT",
    catalonia: "CAT",
    "cataluña": "CAT",
    catalunya: "CAT",
    ieet: "CAT",
    bal: "BAL",
    "balearic islands": "BAL",
    baleares: "BAL",
    "illes balears": "BAL",
    "islas baleares": "BAL",
    its: "BAL",
    eusk: "EUSK",
    euskadi: "EUSK",
    "país vasco": "EUSK",
    "pais vasco": "EUSK",
    "basque country": "EUSK"
  };
  return aliases[value] ?? null;
}

export function normalizeTouristTaxTreatment(raw: string | null | undefined): TouristTaxTreatmentCode | null {
  if (!hasText(raw)) return null;
  const value = raw.trim().toLowerCase() as TouristTaxTreatmentCode;
  return (TOURIST_TAX_TREATMENTS as readonly string[]).includes(value) ? value : null;
}

export type FiscalLocationFields = {
  taxRegion?: string | null;
  postalCode?: string | null;
  ineMunicipalityCode?: string | null;
  fiscalTerritory?: string | null;
};

export type FiscalLocation = {
  /** Canonical region when one could be resolved (input, canonicalised existing value or province). */
  taxRegion: TaxRegion | null;
  /** Where the canonical region came from; null when nothing could be resolved. */
  taxRegionSource: "input" | "existing" | "province" | null;
  /** Value to persist: canonical region, the untouched legacy value when unresolvable, or null — never "". */
  taxRegionToPersist: string | null;
  postalCode: string | null;
  ineMunicipalityCode: string | null;
  fiscalTerritory: FiscalTerritory | null;
};

export type FiscalLocationDeps = {
  normalizeTaxRegion: (raw: string | null | undefined, province?: string | null) => TaxRegion | null;
};

const FORAL_TERRITORIES: readonly FiscalTerritory[] = ["bizkaia", "gipuzkoa", "araba", "navarra"];

/**
 * Non-destructive merge of the fiscal-location fields (profile form, compliance
 * settings, tenant creation, bootstrap, onboarding import):
 *   · an explicit non-empty value wins and is validated (400 when invalid);
 *   · an empty / missing value keeps the current one (canonicalised when the
 *     legacy spelling is recognised, derived from the province when empty);
 *   · "" is never persisted (the root cause of the ES_UNKNOWN_0 invoices).
 * `clearOnNull` (compliance-settings PATCH only): an explicit `null` / "" for
 * postalCode, ineMunicipalityCode or fiscalTerritory CLEARS the stored value
 * instead of keeping it — a key that is absent (`undefined`) still keeps it.
 * taxRegion is never cleared this way (the resolver needs a region; Property
 * keeps its canonical/derived value).
 * `deps` is injectable so the pure contract is unit-testable without the
 * statutory catalogue module.
 */
export function resolveFiscalLocation(
  input: { current: FiscalLocationFields; patch: FiscalLocationFields; province?: string | null; clearOnNull?: boolean },
  deps: FiscalLocationDeps = { normalizeTaxRegion }
): FiscalLocation {
  const current = input.current;
  const patch = input.patch;
  const province = hasText(input.province) ? input.province.trim() : null;
  /** true when the patch explicitly asks to empty the field (only in clearOnNull mode). */
  const clears = (value: string | null | undefined): boolean => input.clearOnNull === true && value !== undefined && !hasText(value);

  let taxRegion: TaxRegion | null = null;
  let taxRegionSource: FiscalLocation["taxRegionSource"] = null;
  let taxRegionToPersist: string | null = null;
  if (hasText(patch.taxRegion)) {
    // Explicit input is validated on its own (no province fallback: garbage must not
    // silently become "the province's region").
    const canonical = deps.normalizeTaxRegion(patch.taxRegion.trim(), null);
    if (!canonical) {
      throw new BadRequestError(
        `Región fiscal no reconocida («${patch.taxRegion.trim()}»). Valores admitidos: ${TAX_REGION_OPTIONS.map((option) => option.value).join(", ")}.`
      );
    }
    taxRegion = canonical;
    taxRegionSource = "input";
    taxRegionToPersist = canonical;
  } else if (hasText(current.taxRegion)) {
    const canonical = deps.normalizeTaxRegion(current.taxRegion.trim(), province);
    taxRegion = canonical;
    taxRegionSource = canonical ? "existing" : null;
    // Unrecognised legacy value: keep it as-is (never blank another writer's data).
    taxRegionToPersist = canonical ?? current.taxRegion.trim();
  } else if (province) {
    const canonical = deps.normalizeTaxRegion(null, province);
    taxRegion = canonical;
    taxRegionSource = canonical ? "province" : null;
    taxRegionToPersist = canonical;
  }

  const postalCode = hasText(patch.postalCode)
    ? validatePostalCode(patch.postalCode)
    : clears(patch.postalCode)
      ? null
      : hasText(current.postalCode)
        ? current.postalCode.trim()
        : null;
  const ineMunicipalityCode = hasText(patch.ineMunicipalityCode)
    ? validateIneMunicipalityCode(patch.ineMunicipalityCode)
    : clears(patch.ineMunicipalityCode)
      ? null
      : hasText(current.ineMunicipalityCode)
        ? current.ineMunicipalityCode.trim()
        : null;
  assertPostalAndIneCoherent(postalCode, ineMunicipalityCode);

  let fiscalTerritory: FiscalTerritory | null = null;
  if (hasText(patch.fiscalTerritory)) {
    fiscalTerritory = normalizeFiscalTerritory(patch.fiscalTerritory);
    if (!fiscalTerritory) {
      throw new BadRequestError(
        `Territorio fiscal no reconocido («${patch.fiscalTerritory.trim()}»). Valores admitidos: ${FISCAL_TERRITORIES.join(", ")}.`
      );
    }
  } else if (!clears(patch.fiscalTerritory) && hasText(current.fiscalTerritory)) {
    fiscalTerritory = normalizeFiscalTerritory(current.fiscalTerritory);
  }
  if (fiscalTerritory && FORAL_TERRITORIES.includes(fiscalTerritory) && taxRegion && taxRegion !== "ES_PENINSULA_BALEARES") {
    throw new BadRequestError(
      `El territorio foral ${fiscalTerritory} solo es coherente con la región fiscal ES_PENINSULA_BALEARES (IVA), no con ${taxRegion}.`
    );
  }

  return { taxRegion, taxRegionSource, taxRegionToPersist, postalCode, ineMunicipalityCode, fiscalTerritory };
}

// ── Invoice series (FISC-09) ────────────────────────────────────────────────

/** Series codes the allocator understands (contract D: allocateInvoiceNumber series). */
export const CANONICAL_SERIES_CODES = ["FAC", "SIM", "REC"] as const;

/** Wizard/back-office invoice types → AEAT TipoFactura family stored in InvoiceSequence.invoiceType. */
export function seriesInvoiceType(raw: string): "F1" | "F2" | "F3" | "R" | "R1" | "R2" | "R3" | "R4" | "R5" {
  const value = raw.trim();
  const aliases: Record<string, "F1" | "F2" | "R"> = {
    full: "F1",
    completa: "F1",
    simplified: "F2",
    simplificada: "F2",
    rectifying: "R",
    rectificativa: "R",
    credit_note: "R",
    abono: "R"
  };
  const mapped = aliases[value.toLowerCase()];
  if (mapped) return mapped;
  if (/^(F[123]|R[1-5]?)$/.test(value.toUpperCase())) return value.toUpperCase() as ReturnType<typeof seriesInvoiceType>;
  throw new BadRequestError(
    `Tipo de factura no reconocido («${value}»). Valores admitidos: full (F1), simplified (F2), rectifying / credit_note (R) o los códigos AEAT F1, F2, F3, R1–R5.`
  );
}

/** FAC ↔ F1, SIM ↔ F2, REC ↔ R*: the allocator picks the series by code, so the pair must agree. Throws 400. */
export function assertSeriesCodeMatchesType(sequenceCode: string, invoiceType: string): void {
  const code = sequenceCode.trim().toUpperCase();
  const expected: Record<string, RegExp> = { FAC: /^F[13]$/, SIM: /^F2$/, REC: /^R[1-5]?$/ };
  const rule = expected[code];
  if (rule && !rule.test(invoiceType)) {
    throw new BadRequestError(`La serie ${code} solo admite facturas de tipo ${code === "FAC" ? "F1/F3" : code === "SIM" ? "F2" : "R (rectificativas)"}; recibido ${invoiceType}.`);
  }
}

/** Year embedded in a legacy prefix such as "FAC-2026-" (null when the prefix carries none). */
export function sequenceYearFromPrefix(prefix: string | null | undefined): number | null {
  if (!prefix) return null;
  const match = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(prefix);
  return match ? Number(match[1]) : null;
}

/** Calendar year in Europe/Madrid (an issue at 00:30 on 1 January belongs to the new year, not to UTC's). */
export function madridYear(date: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric" }).format(date));
}

/** Series year: explicit `year` → year of the prefix → current Madrid year. Throws 400 on an out-of-range year. */
export function resolveSequenceYear(input: { year?: number | null; prefix?: string | null; now?: Date }): number {
  if (input.year !== undefined && input.year !== null) {
    if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) {
      throw new BadRequestError(`El ejercicio de la serie no es válido («${input.year}»): debe ser un año entre 2000 y 2100.`);
    }
    return input.year;
  }
  return sequenceYearFromPrefix(input.prefix) ?? madridYear(input.now);
}

/** Highest issued number (numeric suffix) among the invoice numbers of a series prefix; null when none. */
export function maxIssuedNumber(invoiceNumbers: Array<string | null | undefined>, prefix: string): number | null {
  let max: number | null = null;
  for (const number of invoiceNumbers) {
    if (!number || !number.startsWith(prefix)) continue;
    const suffix = number.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const value = Number(suffix);
    if (max === null || value > max) max = value;
  }
  return max;
}

export type InvoiceSequencePatchViolation = {
  code: "SERIES_PREFIX_LOCKED" | "SERIES_PADDING_LOCKED" | "SERIES_NEXT_NUMBER_BELOW_ISSUED";
  field: "prefix" | "padding" | "nextNumber";
  message: string;
};

/**
 * Policy for editing a series that already has issued invoices: prefix and
 * padding are frozen (renumbering a live series breaks the VeriFactu chain and
 * the unique invoice numbers) and nextNumber can never drop to an already
 * issued number. A series without issued invoices is freely editable.
 */
export function invoiceSequencePatchViolations(input: {
  existing: { prefix: string | null; padding: number; nextNumber: number };
  patch: { prefix?: string | null; padding?: number; nextNumber?: number };
  issued: { count: number; maxNumber: number | null };
}): InvoiceSequencePatchViolation[] {
  const violations: InvoiceSequencePatchViolation[] = [];
  if (input.issued.count === 0) return violations;
  if (input.patch.prefix !== undefined && (input.patch.prefix ?? null) !== (input.existing.prefix ?? null)) {
    violations.push({
      code: "SERIES_PREFIX_LOCKED",
      field: "prefix",
      message: `No se puede cambiar el prefijo de una serie con ${input.issued.count} factura(s) emitida(s); crea una serie nueva para el próximo ejercicio.`
    });
  }
  if (input.patch.padding !== undefined && input.patch.padding !== input.existing.padding) {
    violations.push({
      code: "SERIES_PADDING_LOCKED",
      field: "padding",
      message: `No se puede cambiar el número de dígitos de una serie con ${input.issued.count} factura(s) emitida(s).`
    });
  }
  const floor = (input.issued.maxNumber ?? 0) + 1;
  if (input.patch.nextNumber !== undefined && input.patch.nextNumber < floor) {
    violations.push({
      code: "SERIES_NEXT_NUMBER_BELOW_ISSUED",
      field: "nextNumber",
      message: `El siguiente número (${input.patch.nextNumber}) no puede ser inferior a ${floor}: la serie ya tiene emitida la ${input.issued.maxNumber}.`
    });
  }
  return violations;
}

/**
 * Catálogo de definiciones de categoría (Tanda L2 · L2-04): se siembra en
 * category_definitions al arrancar (ensureCategoryDefinitions, tenant-hydration.ts,
 * upsert por code) y las pantallas leen las filas. Los ids fijos solo se usan al
 * crear; una fila sembrada antes con otro id conserva el suyo.
 */
export const CATEGORY_DEFINITION_CATALOG: CategoryDefinitionRecord[] = [
  { id: "catdef_room_type_categories", code: "room_type_categories", name: "Room type categories", categoryGroup: "Rooms", entityType: "room_type", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 5 },
  { id: "catdef_room_features", code: "room_features", name: "Room features", categoryGroup: "Rooms", entityType: "room", mode: "property_editable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 10 },
  { id: "catdef_bed_types", code: "bed_types", name: "Bed types", categoryGroup: "Rooms", entityType: "room_type", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 20 },
  { id: "catdef_view_types", code: "view_types", name: "View types", categoryGroup: "Rooms", entityType: "room", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 30 },
  { id: "catdef_accessibility_features", code: "accessibility_features", name: "Accessibility features", categoryGroup: "Rooms", entityType: "room", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 40 },
  { id: "catdef_space_types", code: "space_types", name: "Space and resource types", categoryGroup: "Spaces & Resources", entityType: "inventory_resource", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 50 },
  { id: "catdef_housekeeping_task_types", code: "housekeeping_task_types", name: "Housekeeping task types", categoryGroup: "Housekeeping", entityType: "housekeeping_task", mode: "property_editable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 60 },
  { id: "catdef_maintenance_issue_types", code: "maintenance_issue_types", name: "Maintenance issue types", categoryGroup: "Maintenance", entityType: "work_order", mode: "property_editable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 70 },
  { id: "catdef_work_order_priorities", code: "work_order_priorities", name: "Work order priorities", categoryGroup: "Maintenance", entityType: "work_order", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 80 },
  { id: "catdef_market_segments", code: "market_segments", name: "Market segments", categoryGroup: "Revenue", entityType: "reservation", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 90 },
  { id: "catdef_reservation_source_codes", code: "reservation_source_codes", name: "Reservation source codes", categoryGroup: "Reservations", entityType: "reservation", mode: "property_extendable", valueSchemaJson: { usedBy: "manual_reservation_creation" }, isCore: true, active: true, sortOrder: 92 },
  { id: "catdef_reservation_statuses", code: "reservation_statuses", name: "Reservation statuses", categoryGroup: "Reservations", entityType: "reservation", mode: "read_only", valueSchemaJson: { internalState: true }, isCore: true, active: true, sortOrder: 94 },
  { id: "catdef_guarantee_policies", code: "guarantee_policies", name: "Guarantee policies", categoryGroup: "Reservations", entityType: "reservation", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 96 },
  { id: "catdef_cancellation_policies", code: "cancellation_policies", name: "Cancellation policies", categoryGroup: "Reservations", entityType: "reservation", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 98 },
  { id: "catdef_billing_instruction_types", code: "billing_instruction_types", name: "Billing instruction types", categoryGroup: "Finance", entityType: "reservation", mode: "property_extendable", valueSchemaJson: { usedBy: "reservation_billing" }, isCore: true, active: true, sortOrder: 99 },
  { id: "catdef_channel_categories", code: "channel_categories", name: "Channel categories", categoryGroup: "Distribution", entityType: "channel", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 100 },
  { id: "catdef_revenue_report_fields", code: "revenue_report_fields", name: "Revenue report fields", categoryGroup: "Revenue", entityType: "revenue_snapshot", mode: "property_extendable", valueSchemaJson: { supportsLegacyMapping: true }, isCore: true, active: true, sortOrder: 110 },
  { id: "catdef_payment_method_categories", code: "payment_method_categories", name: "Payment method categories", categoryGroup: "Finance", entityType: "payment", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 120 },
  { id: "catdef_invoice_sequence_types", code: "invoice_sequence_types", name: "Invoice sequence types", categoryGroup: "Compliance", entityType: "invoice", mode: "system_controlled", valueSchemaJson: { legalControlled: true }, isCore: true, active: true, sortOrder: 130 },
  { id: "catdef_document_types", code: "document_types", name: "Guest register document types", categoryGroup: "Compliance", entityType: "guest_register", mode: "system_controlled", valueSchemaJson: { legalControlled: true }, isCore: true, active: true, sortOrder: 140 },
  { id: "catdef_pos_product_categories", code: "pos_product_categories", name: "POS product categories", categoryGroup: "POS", entityType: "pos_product", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 150 },
  { id: "catdef_asset_categories", code: "asset_categories", name: "Asset categories", categoryGroup: "Assets", entityType: "asset", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 160 },
  { id: "catdef_safety_incident_categories", code: "safety_incident_categories", name: "Safety incident categories", categoryGroup: "Safety", entityType: "safety_incident", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 170 },
  { id: "catdef_ai_review_categories", code: "ai_review_categories", name: "AI review categories", categoryGroup: "AI", entityType: "ai_human_review", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 180 }
];

const categoryTemplates = [
  { code: "boutique_hotel", name: "Boutique hotel", creates: ["Sea view", "Balcony", "Signature suite", "Welcome amenity", "Concierge request"], groups: ["Rooms", "Guest Experience", "Revenue"] },
  { code: "urban_business_hotel", name: "Urban business hotel", creates: ["Corporate", "Business transient", "Meeting room", "Late checkout", "Airport transfer"], groups: ["Revenue", "Spaces & Resources", "Guest Experience"] },
  { code: "resort", name: "Resort", creates: ["Pool view", "Spa room", "Resort fee", "Family leisure", "Activities"], groups: ["Rooms", "Spaces & Resources", "POS"] },
  { code: "rural_hotel", name: "Rural hotel", creates: ["Nature view", "Pet friendly", "Fireplace", "Outdoor activity"], groups: ["Rooms", "Guest Experience"] },
  { code: "aparthotel", name: "Aparthotel", creates: ["Kitchenette", "Monthly stay", "Linen exchange", "Apartment cleaning"], groups: ["Rooms", "Housekeeping"] },
  { code: "hostel", name: "Hostel", creates: ["Dorm bed", "Shared bathroom", "Locker", "Group leisure"], groups: ["Rooms", "Revenue"] },
  { code: "luxury_hotel", name: "Luxury hotel", creates: ["Butler service", "Fine dining", "Spa suite", "VIP arrival"], groups: ["Guest Experience", "POS", "Spaces & Resources"] },
  { code: "small_independent_hotel", name: "Small independent hotel", creates: ["Direct", "Walk-in", "Maintenance basic", "Daily cleaning"], groups: ["Revenue", "Operations"] },
  { code: "multi_property_group", name: "Multi-property group", creates: ["Central sales", "Shared supplier", "Group reporting", "Portfolio segment"], groups: ["Revenue", "Finance"] }
];

export const PROPERTY_SETUP_FORM_DEFINITIONS: PropertySetupFormDefinition[] = [
  {
    code: "property_profile",
    title: "Property profile",
    route: "/backoffice/property-setup/property-profile",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/property_profile",
    description: "Legal and operational identity for the property.",
    permission: "property_profile.edit",
    targetEntityType: "property",
    setupStepCode: "property_legal_details",
    inputCategories: ["Property profile", "Legal profile", "Business date rules"],
    fields: [
      { key: "name", label: "Property name", inputType: "text", required: true, mapsTo: "properties.name" },
      // Tanda 6b (L2): the profile no longer carries the NIF nor the razón social — they belong to
      // the legal entity (Configuración › Estructura societaria › Datos fiscales). The establishment
      // keeps its trade name (invoice establishment block) and its centre code (series prefixes).
      { key: "tradeName", label: "Trade name (on invoice)", inputType: "text", mapsTo: "properties.trade_name" },
      { key: "code", label: "Centre code", inputType: "text", mapsTo: "properties.code" },
      { key: "address", label: "Address", inputType: "textarea", required: true, mapsTo: "properties.address" },
      { key: "country", label: "Country", inputType: "select", required: true, options: ["ES", "PT", "FR", "IT"], mapsTo: "properties.country" },
      { key: "province", label: "Province", inputType: "text", mapsTo: "properties.province" },
      { key: "city", label: "City", inputType: "text", required: true, mapsTo: "properties.municipality" },
      // Tanda 3 (FISC-08): postal code and INE municipality code live on Property (SES establishment block).
      { key: "postalCode", label: "Postal code", inputType: "text", mapsTo: "properties.postal_code" },
      { key: "ineMunicipalityCode", label: "INE municipality code", inputType: "text", mapsTo: "properties.ine_municipality_code" },
      { key: "phone", label: "Contact phone", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.phone" },
      { key: "email", label: "Contact email", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.email" },
      { key: "website", label: "Website", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.website" },
      { key: "starRating", label: "Category / star rating", inputType: "select", options: ["1*", "2*", "3*", "4*", "5*", "5* GL"], mapsTo: "property_setup_form_submissions.payload_json.starRating" },
      { key: "totalRooms", label: "Total rooms", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.totalRooms" },
      { key: "checkInTime", label: "Default check-in time", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.checkInTime" },
      { key: "checkOutTime", label: "Default check-out time", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.checkOutTime" },
      { key: "timezone", label: "Timezone", inputType: "select", required: true, options: ["Europe/Madrid", "Europe/Lisbon", "Europe/Paris"], mapsTo: "properties.timezone" },
      { key: "currency", label: "Currency", inputType: "select", required: true, options: ["EUR", "GBP", "USD"], mapsTo: "property_setup_form_submissions.payload_json.currency" },
      { key: "language", label: "Language", inputType: "select", options: ["es", "en", "ca", "fr"], mapsTo: "property_setup_form_submissions.payload_json.language" },
      // Tanda 3: canonical values (value persisted, label displayed) — the wizard used to persist the English label.
      { key: "taxRegion", label: "Tax region", inputType: "select", options: [...TAX_REGION_OPTIONS], mapsTo: "properties.tax_region" },
      { key: "fiscalTerritory", label: "Fiscal territory (reporting route)", inputType: "select", options: [...FISCAL_TERRITORY_OPTIONS], mapsTo: "properties.fiscal_territory" },
      { key: "tourismTaxRegion", label: "Tourism tax region", inputType: "select", options: [...TOURISM_TAX_REGION_OPTIONS], mapsTo: "property_compliance_settings.tourism_tax_region" },
      { key: "businessDateRules", label: "Business date rules", inputType: "textarea", mapsTo: "property_setup_form_submissions.payload_json.businessDateRules" }
    ],
    dataQualityChecks: ["issuer_legal_name_set", "issuer_tax_id_valid", "property_fiscal_address_complete", "timezone_configured", "tax_region_configured"]
  },
  {
    code: "building",
    title: "Building form",
    route: "/backoffice/property-setup/buildings",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/building",
    description: "Create a physical building used by rooms, floors, zones and spaces.",
    permission: "property.map.manage",
    targetEntityType: "building",
    setupStepCode: "property_physical_map",
    inputCategories: ["Buildings", "Property mapper"],
    fields: [
      { key: "name", label: "Building name", inputType: "text", required: true, mapsTo: "buildings.name" },
      { key: "code", label: "Building code", inputType: "text", required: true, mapsTo: "buildings.code" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "buildings.description" },
      { key: "sortOrder", label: "Sort order", inputType: "number", mapsTo: "buildings.sort_order" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "buildings.active" }
    ],
    dataQualityChecks: ["duplicate_building_code", "building_has_floors_or_spaces"]
  },
  {
    code: "floor",
    title: "Floor form",
    route: "/backoffice/property-setup/floors",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/floor",
    description: "Create a floor inside a building.",
    permission: "property.map.manage",
    targetEntityType: "floor",
    setupStepCode: "property_physical_map",
    inputCategories: ["Floors", "Buildings", "Property mapper"],
    fields: [
      { key: "buildingId", label: "Building", inputType: "select", required: true, mapsTo: "floors.building_id" },
      { key: "name", label: "Floor name", inputType: "text", required: true, mapsTo: "floors.name" },
      { key: "floorNumber", label: "Floor number", inputType: "number", mapsTo: "floors.floor_number" },
      { key: "code", label: "Floor code", inputType: "text", mapsTo: "floors.code" },
      { key: "sortOrder", label: "Sort order", inputType: "number", mapsTo: "floors.sort_order" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "floors.active" }
    ],
    dataQualityChecks: ["floor_has_building", "duplicate_floor_code"]
  },
  {
    code: "zone",
    title: "Zone form",
    route: "/backoffice/property-setup/zones",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/zone",
    description: "Create an operational zone for rooms, spaces, housekeeping and maintenance.",
    permission: "property.map.manage",
    targetEntityType: "property_zone",
    setupStepCode: "property_physical_map",
    inputCategories: ["Zones", "Housekeeping sections", "Maintenance areas", "Property mapper"],
    fields: [
      { key: "buildingId", label: "Building", inputType: "select", mapsTo: "property_zones.building_id" },
      { key: "floorId", label: "Floor", inputType: "select", mapsTo: "property_zones.floor_id" },
      { key: "name", label: "Zone name", inputType: "text", required: true, mapsTo: "property_zones.name" },
      { key: "zoneType", label: "Zone type", inputType: "select", required: true, options: ["guest_rooms", "public_area", "back_of_house", "technical", "food_beverage", "wellness", "parking", "events", "outdoor"], mapsTo: "property_zones.zone_type" },
      { key: "code", label: "Code", inputType: "text", mapsTo: "property_zones.code" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "property_zones.description" },
      { key: "housekeepingSectionId", label: "Housekeeping section", inputType: "select", categoryCode: "housekeeping_task_types", mapsTo: "housekeeping_section_rooms.housekeeping_section_id" },
      { key: "maintenanceAreaId", label: "Maintenance area", inputType: "select", categoryCode: "maintenance_issue_types", mapsTo: "maintenance_area_rooms.maintenance_area_id" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "property_zones.active" }
    ],
    dataQualityChecks: ["zone_has_floor", "zone_has_rooms_or_spaces"]
  },
  {
    code: "room_type",
    title: "Room type form",
    route: "/backoffice/property-setup/room-types",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/room_type",
    description: "Define a sellable room type and its operational defaults.",
    permission: "room_types.manage",
    targetEntityType: "room_type",
    setupStepCode: "room_types",
    inputCategories: ["Room types", "Room features", "Bed types", "View types", "Accessibility features"],
    fields: [
      { key: "name", label: "Name", inputType: "text", required: true, mapsTo: "room_types.name" },
      { key: "code", label: "Code", inputType: "text", required: true, mapsTo: "room_types.code" },
      { key: "category", label: "Category", inputType: "select", required: true, categoryCode: "room_type_categories", mapsTo: "room_types.default_rate_category" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "room_types.description" },
      { key: "baseOccupancy", label: "Base occupancy", inputType: "number", required: true, mapsTo: "room_types.base_capacity" },
      { key: "maxOccupancy", label: "Max occupancy", inputType: "number", required: true, mapsTo: "room_types.max_occupancy" },
      { key: "maxAdults", label: "Max adults", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.maxAdults" },
      { key: "maxChildren", label: "Max children", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.maxChildren" },
      { key: "extraBedCapacity", label: "Extra bed capacity", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.extraBedCapacity" },
      { key: "defaultBedSetup", label: "Default bed setup", inputType: "select", categoryCode: "bed_types", mapsTo: "room_types.default_bed_configuration_json" },
      { key: "defaultFeatures", label: "Default features", inputType: "multi_select", categoryCode: "room_features", mapsTo: "room_types.default_amenities_json" },
      { key: "defaultCleaningCategory", label: "Default cleaning category", inputType: "select", categoryCode: "housekeeping_task_types", mapsTo: "room_types.default_amenities_json.cleaningCategory" },
      { key: "smokingPolicy", label: "Smoking policy", inputType: "select", options: ["non_smoking", "smoking", "mixed"], mapsTo: "property_setup_form_submissions.payload_json.smokingPolicy" },
      { key: "baseRate", label: "Base rate (€)", inputType: "money", mapsTo: "property_setup_form_submissions.payload_json.baseRate" },
      { key: "sellable", label: "Sellable", inputType: "boolean", mapsTo: "room_types.sellable" },
      { key: "displayOrder", label: "Display order", inputType: "number", mapsTo: "room_types.display_order" }
    ],
    dataQualityChecks: ["room_type_has_rooms", "room_type_occupancy_valid"]
  },
  {
    code: "room",
    title: "Room form",
    route: "/backoffice/property-setup/rooms",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/room",
    description: "Create and map a physical room to type, building, floor, zone and operational ownership.",
    permission: "rooms.manage",
    targetEntityType: "room",
    setupStepCode: "rooms",
    inputCategories: ["Rooms", "Room types", "Buildings", "Floors", "Zones", "Housekeeping sections", "Maintenance areas"],
    fields: [
      { key: "roomNumber", label: "Room number", inputType: "text", required: true, mapsTo: "rooms.number" },
      { key: "displayName", label: "Display name", inputType: "text", mapsTo: "rooms.display_name" },
      { key: "roomTypeId", label: "Room type", inputType: "select", required: true, mapsTo: "rooms.room_type_id" },
      { key: "buildingId", label: "Building", inputType: "select", required: true, mapsTo: "rooms.building_id" },
      { key: "floorId", label: "Floor", inputType: "select", required: true, mapsTo: "rooms.floor_id" },
      { key: "zoneId", label: "Zone", inputType: "select", required: true, mapsTo: "rooms.zone_id" },
      { key: "maxOccupancy", label: "Max occupancy", inputType: "number", mapsTo: "rooms.max_occupancy" },
      { key: "standardOccupancy", label: "Standard occupancy", inputType: "number", mapsTo: "rooms.standard_occupancy" },
      { key: "beds", label: "Beds", inputType: "json", categoryCode: "bed_types", mapsTo: "rooms.bed_configuration_json" },
      { key: "features", label: "Features", inputType: "multi_select", categoryCode: "room_features", mapsTo: "rooms.features_json" },
      { key: "viewType", label: "View type", inputType: "select", categoryCode: "view_types", mapsTo: "rooms.view_type" },
      { key: "orientation", label: "Orientation", inputType: "text", mapsTo: "rooms.orientation" },
      { key: "squareMeters", label: "Square meters", inputType: "number", mapsTo: "rooms.square_meters" },
      { key: "accessibility", label: "Accessibility", inputType: "multi_select", categoryCode: "accessibility_features", mapsTo: "rooms.accessibility_json" },
      { key: "sellable", label: "Sellable", inputType: "boolean", mapsTo: "rooms.sellable" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "rooms.active" },
      { key: "status", label: "Status", inputType: "select", options: ["clean", "dirty", "inspected", "occupied", "out_of_order", "out_of_service"], mapsTo: "rooms.status" }
    ],
    dataQualityChecks: ["room_has_type", "room_has_building_floor_zone", "sellable_room_has_operational_ownership"]
  },
  {
    code: "space_resource",
    title: "Space and resource form",
    route: "/backoffice/property-setup/spaces-resources",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/space_resource",
    description: "Create bookable and non-bookable spaces such as parking, meeting rooms, outlets and technical areas.",
    permission: "spaces.manage",
    targetEntityType: "property_space",
    setupStepCode: "property_physical_map",
    inputCategories: ["Spaces", "Bookable resources", "Resource types", "Space types"],
    fields: [
      { key: "name", label: "Name", inputType: "text", required: true, mapsTo: "property_spaces.name" },
      { key: "code", label: "Code", inputType: "text", required: true, mapsTo: "property_spaces.code" },
      { key: "resourceType", label: "Resource type", inputType: "select", required: true, categoryCode: "space_types", options: ["parking_space", "meeting_room", "coworking_desk", "spa_room", "restaurant_table", "event_space", "equipment", "storage", "technical_room", "other"], mapsTo: "inventory_resources.resource_type" },
      { key: "spaceType", label: "Space type", inputType: "select", required: true, options: ["reception", "lobby", "restaurant", "bar", "kitchen", "spa", "gym", "pool", "parking", "meeting_room", "laundry", "storage", "technical_room", "office", "terrace", "garden", "other"], mapsTo: "property_spaces.space_type" },
      { key: "buildingId", label: "Building", inputType: "select", mapsTo: "property_spaces.building_id" },
      { key: "floorId", label: "Floor", inputType: "select", mapsTo: "property_spaces.floor_id" },
      { key: "zoneId", label: "Zone", inputType: "select", mapsTo: "property_spaces.zone_id" },
      { key: "capacity", label: "Capacity", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.capacity" },
      { key: "hourlyBookable", label: "Hourly bookable", inputType: "boolean", mapsTo: "property_setup_form_submissions.payload_json.hourlyBookable" },
      { key: "dailyBookable", label: "Daily bookable", inputType: "boolean", mapsTo: "property_setup_form_submissions.payload_json.dailyBookable" },
      { key: "monthlyBookable", label: "Monthly bookable", inputType: "boolean", mapsTo: "property_setup_form_submissions.payload_json.monthlyBookable" },
      { key: "sellable", label: "Sellable", inputType: "boolean", mapsTo: "property_setup_form_submissions.payload_json.sellable" },
      { key: "taxCode", label: "Tax code", inputType: "select", categoryCode: "payment_method_categories", mapsTo: "property_setup_form_submissions.payload_json.taxCode" },
      { key: "defaultRate", label: "Default rate", inputType: "money", mapsTo: "property_setup_form_submissions.payload_json.defaultRate" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "property_spaces.active" }
    ],
    dataQualityChecks: ["sellable_resource_has_tax_code", "bookable_resource_has_capacity"]
  },
  {
    code: "department",
    title: "Department form",
    route: "/backoffice/property-setup/departments",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/department",
    description: "Create operational departments and ownership for setup, tasks and approvals.",
    permission: "departments.manage",
    targetEntityType: "department",
    setupStepCode: "departments",
    inputCategories: ["Departments", "Users", "Roles"],
    fields: [
      { key: "name", label: "Name", inputType: "text", required: true, mapsTo: "departments.name" },
      { key: "code", label: "Code", inputType: "text", required: true, mapsTo: "departments.code" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "departments.description" },
      { key: "managerUserId", label: "Manager", inputType: "select", mapsTo: "user_departments.user_id" },
      { key: "userIds", label: "Users", inputType: "multi_select", mapsTo: "user_departments.user_id" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "departments.active" }
    ],
    dataQualityChecks: ["department_code_unique", "department_has_manager"]
  },
  {
    code: "housekeeping_setup",
    title: "Housekeeping setup form",
    route: "/backoffice/property-setup/operations",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/housekeeping_setup",
    description: "Configure sections, task types, cleaning schemas and inspection rules.",
    permission: "operations_setup.manage",
    targetEntityType: "housekeeping_rule",
    setupStepCode: "departments",
    inputCategories: ["Housekeeping sections", "Housekeeping task types", "Cleaning schemas"],
    fields: [
      { key: "sectionName", label: "Housekeeping section", inputType: "text", required: true, mapsTo: "housekeeping_sections.name" },
      { key: "taskTypes", label: "Task types", inputType: "multi_select", categoryCode: "housekeeping_task_types", mapsTo: "property_category_options" },
      { key: "cleaningSchemas", label: "Cleaning schemas", inputType: "multi_select", mapsTo: "housekeeping_rules.configuration_json.cleaningSchemas" },
      { key: "defaultDurationMinutes", label: "Default duration", inputType: "number", mapsTo: "housekeeping_rules.configuration_json.defaultDurationMinutes" },
      { key: "inspectionRequired", label: "Inspection required", inputType: "boolean", mapsTo: "housekeeping_rules.configuration_json.inspectionRequired" },
      { key: "stayoverPolicy", label: "Stayover policy", inputType: "select", options: ["daily", "on_request", "every_two_days", "eco_opt_out"], mapsTo: "housekeeping_rules.configuration_json.stayoverPolicy" },
      { key: "departurePolicy", label: "Departure policy", inputType: "textarea", mapsTo: "housekeeping_rules.configuration_json.departurePolicy" },
      { key: "deepCleanFrequency", label: "Deep clean frequency", inputType: "text", mapsTo: "housekeeping_rules.configuration_json.deepCleanFrequency" },
      { key: "linenRules", label: "Linen rules", inputType: "textarea", mapsTo: "housekeeping_rules.configuration_json.linenRules" },
      { key: "minibarRules", label: "Minibar rules", inputType: "textarea", mapsTo: "housekeeping_rules.configuration_json.minibarRules" }
    ],
    dataQualityChecks: ["housekeeping_sections_cover_sellable_rooms", "inspection_policy_configured"]
  },
  {
    code: "maintenance_setup",
    title: "Maintenance setup form",
    route: "/backoffice/property-setup/maintenance",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/maintenance_setup",
    description: "Configure maintenance areas, issue types, priorities, SLA and room blocking rules.",
    permission: "operations_setup.manage",
    targetEntityType: "maintenance_rule",
    setupStepCode: "departments",
    inputCategories: ["Maintenance areas", "Maintenance issue types", "Work order priorities", "Asset categories"],
    fields: [
      { key: "areaName", label: "Maintenance area", inputType: "text", required: true, mapsTo: "maintenance_areas.name" },
      { key: "issueTypes", label: "Issue types", inputType: "multi_select", categoryCode: "maintenance_issue_types", mapsTo: "property_category_options" },
      { key: "priorityLevels", label: "Priority levels", inputType: "multi_select", categoryCode: "work_order_priorities", mapsTo: "property_category_options" },
      { key: "slaRules", label: "SLA rules", inputType: "textarea", mapsTo: "maintenance_rules.configuration_json.slaRules" },
      { key: "roomBlockingRules", label: "Room blocking rules", inputType: "textarea", mapsTo: "maintenance_rules.configuration_json.roomBlockingRules" },
      { key: "assetCategories", label: "Asset categories", inputType: "multi_select", categoryCode: "asset_categories", mapsTo: "property_category_options" },
      { key: "contractorCategories", label: "Contractor categories", inputType: "multi_select", mapsTo: "maintenance_rules.configuration_json.contractorCategories" },
      { key: "preventiveMaintenanceCategories", label: "Preventive maintenance categories", inputType: "multi_select", mapsTo: "maintenance_rules.configuration_json.preventiveMaintenanceCategories" }
    ],
    dataQualityChecks: ["maintenance_areas_cover_rooms", "blocking_rules_configured"]
  },
  {
    code: "revenue_setup",
    title: "Revenue category form",
    route: "/backoffice/property-setup/revenue",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/revenue_setup",
    description: "Configure commercial taxonomy used by rate plans, reports, segmentation and forecasts.",
    permission: "revenue_setup.manage",
    targetEntityType: "revenue_category_setup",
    setupStepCode: "modules",
    inputCategories: ["Market segments", "Source codes", "Channel categories", "Revenue categories", "Forecast driver categories"],
    fields: [
      { key: "marketSegmentLabel", label: "Market segment", inputType: "text", required: true, categoryCode: "market_segments", mapsTo: "property_category_options.market_segments" },
      { key: "sourceCodeLabel", label: "Source code", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.sourceCodeLabel" },
      { key: "channelCategoryLabel", label: "Channel category", inputType: "text", categoryCode: "channel_categories", mapsTo: "property_category_options.channel_categories" },
      { key: "rateCategoryLabel", label: "Rate category", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.rateCategoryLabel" },
      { key: "demandEventType", label: "Demand event type", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.demandEventType" },
      { key: "forecastDriverCategory", label: "Forecast driver category", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.forecastDriverCategory" }
    ],
    dataQualityChecks: ["rate_plans_have_category", "channels_have_category", "legacy_revenue_report_fields_mapped"]
  },
  {
    code: "finance_compliance_setup",
    title: "Finance and compliance setup form",
    route: "/backoffice/property-setup/finance-compliance",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/finance_compliance_setup",
    description: "Configure tax, invoice sequences, authority routing, payment methods and retention rules.",
    permission: "compliance_setup.manage",
    targetEntityType: "property_compliance_settings",
    setupStepCode: "tax_and_compliance",
    inputCategories: ["Tax codes", "Payment method categories", "Invoice sequences", "Compliance settings", "Retention rules"],
    fields: [
      // Tanda 3: same canonical select as the profile form; persisted on Property AND mirrored to compliance settings.
      { key: "taxRegion", label: "Tax region", inputType: "select", required: true, options: [...TAX_REGION_OPTIONS], mapsTo: "properties.tax_region" },
      { key: "authorityType", label: "Authority type", inputType: "select", required: true, options: ["ses_hospedajes", "mossos", "ertzaintza", "manual", "other"], mapsTo: "property_compliance_settings.configuration_json.authorityType" },
      { key: "paymentMethodCategory", label: "Payment method category", inputType: "text", categoryCode: "payment_method_categories", mapsTo: "property_category_options.payment_method_categories" },
      { key: "invoiceSequenceCode", label: "Invoice sequence code", inputType: "text", required: true, mapsTo: "invoice_sequences.sequence_code" },
      { key: "invoiceType", label: "Invoice type", inputType: "select", required: true, options: ["full", "simplified", "rectifying", "credit_note"], mapsTo: "invoice_sequences.invoice_type" },
      { key: "retentionRule", label: "Retention rule", inputType: "text", mapsTo: "property_compliance_settings.configuration_json.retentionRule" },
      { key: "submissionMode", label: "Submission mode", inputType: "select", options: ["batch_export", "web_service", "manual"], mapsTo: "property_compliance_settings.configuration_json.submissionMode" }
    ],
    dataQualityChecks: ["invoice_sequence_configured", "ses_hospedajes_credentials", "retention_rule_configured"]
  },
  {
    code: "ai_setup",
    title: "AI setup form",
    route: "/backoffice/property-setup/ai",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/ai_setup",
    description: "Configure AI automation level, OCR privacy, locales and human review defaults.",
    permission: "ai.configure",
    targetEntityType: "property_ai_settings",
    setupStepCode: "ai_settings",
    inputCategories: ["AI settings", "AI governance", "OCR privacy"],
    fields: [
      { key: "aiEnabled", label: "AI enabled", inputType: "boolean", mapsTo: "property_ai_settings.ai_enabled" },
      { key: "defaultAutomationLevel", label: "Default automation level", inputType: "select", required: true, options: ["off", "draft_only", "suggest_and_confirm", "auto_low_risk", "auto_within_rules"], mapsTo: "property_ai_settings.default_automation_level" },
      { key: "guestFacingDisclosure", label: "Guest-facing disclosure", inputType: "textarea", mapsTo: "property_ai_settings.guest_facing_disclosure" },
      { key: "voiceLocales", label: "Voice locales", inputType: "multi_select", options: ["es-ES", "en-US", "ca-ES", "fr-FR"], mapsTo: "property_ai_settings.voice_locales" },
      { key: "documentImageRetentionPolicy", label: "Document image retention policy", inputType: "select", options: ["discard_after_ocr", "manual_exception_only"], mapsTo: "property_ai_settings.configuration_json.documentImageRetentionPolicy" },
      { key: "humanReviewDefault", label: "Human review default", inputType: "select", options: ["required_for_sensitive", "required_for_high_risk", "always"], mapsTo: "property_ai_settings.configuration_json.humanReviewDefault" }
    ],
    dataQualityChecks: ["document_image_storage_disabled", "high_risk_ai_requires_confirmation"]
  },
  {
    code: "custom_field",
    title: "Custom field form",
    route: "/backoffice/property-setup/custom-fields",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/custom_field",
    description: "Add custom fields to rooms, guests, reservations, assets or resources without code changes.",
    permission: "custom_fields.manage",
    targetEntityType: "property_custom_field_definition",
    setupStepCode: "property_physical_map",
    inputCategories: ["Custom fields", "Validation rules", "Visibility rules"],
    fields: [
      { key: "entityType", label: "Entity type", inputType: "select", required: true, options: ["room", "room_type", "guest", "reservation", "asset", "inventory_resource", "work_order"], mapsTo: "property_custom_field_definitions.entity_type" },
      { key: "fieldKey", label: "Field key", inputType: "text", required: true, mapsTo: "property_custom_field_definitions.field_key" },
      { key: "label", label: "Label", inputType: "text", required: true, mapsTo: "property_custom_field_definitions.label" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "property_custom_field_definitions.description" },
      { key: "dataType", label: "Data type", inputType: "select", required: true, options: ["text", "number", "boolean", "date", "datetime", "select", "multi_select", "money", "percentage", "json"], mapsTo: "property_custom_field_definitions.data_type" },
      { key: "required", label: "Required", inputType: "boolean", mapsTo: "property_custom_field_definitions.required" },
      { key: "searchable", label: "Searchable", inputType: "boolean", mapsTo: "property_custom_field_definitions.searchable" },
      { key: "visibleInList", label: "Visible in list", inputType: "boolean", mapsTo: "property_custom_field_definitions.visible_in_list" },
      { key: "visibleInDetail", label: "Visible in detail", inputType: "boolean", mapsTo: "property_custom_field_definitions.visible_in_detail" },
      { key: "validationJson", label: "Validation JSON", inputType: "json", mapsTo: "property_custom_field_definitions.validation_json" }
    ],
    dataQualityChecks: ["custom_required_fields_have_defaults", "custom_field_keys_unique"]
  }
];

function audit(input: BackOfficeMutationInput & {
  action: string;
  entityType: string;
  entityId?: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}) {
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeJson: input.beforeJson,
    afterJson: input.afterJson,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
}

function domain(input: BackOfficeMutationInput & {
  eventType: string;
  entityType: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}) {
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: input.entityType,
    entityId: input.entityId ?? "",
    eventType: input.eventType,
    payload: input.payload ?? {},
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
}

function enabledModuleCodes(propertyId: string): HotelModuleCode[] {
  return demoStore.propertyModules
    .filter((propertyModule) => propertyModule.propertyId === propertyId && propertyModule.status === "enabled")
    .map((propertyModule) => demoStore.modules.find((module) => module.id === propertyModule.moduleId)?.code)
    .filter((code): code is HotelModuleCode => Boolean(code));
}

/**
 * Property gate for every back-office read/write (CFG-P0-1): Prisma-first via
 * resolveProperty, refreshes the demoStore mirror (same object identity for the
 * legacy in-place mutations) and fails with a typed 404 instead of a bare 500,
 * so hotels that only exist in Prisma can use the whole back office.
 */
async function requireProperty(propertyId: string): Promise<PropertyRecord> {
  const property = await resolveProperty(propertyId);
  if (!property) {
    throw new NotFoundError("Propiedad no encontrada.");
  }
  return mirrorRecord(demoStore.properties, property);
}

async function requireCategoryDefinition(categoryCode: string): Promise<CategoryDefinitionRecord> {
  const definition = await findCategoryDefinitionByCode(categoryCode);
  if (!definition) {
    throw new NotFoundError(`Definición de categoría no encontrada: ${categoryCode}`);
  }
  return definition;
}

async function requireCategoryDefinitionById(definitionId: string): Promise<CategoryDefinitionRecord> {
  const definition = await findCategoryDefinitionById(definitionId);
  if (!definition) {
    throw new NotFoundError("Definición de categoría no encontrada.");
  }
  return definition;
}

async function requireCategoryOption(propertyId: string, optionId: string): Promise<PropertyCategoryOptionRecord> {
  const option = await findPropertyCategoryOption(propertyId, optionId);
  if (!option) {
    throw new NotFoundError(`Opción de categoría no encontrada: ${optionId}`);
  }
  return option;
}

/**
 * Propiedad existente Y de la organización del usuario (admin de plataforma
 * aparte): 404 opaco para una propiedad ajena. Para las escrituras del gestor
 * de categorías, campos personalizados y puesta en marcha (Tanda L2 · L2-04).
 */
async function requireOrganizationProperty(propertyId: string, context: UserContext): Promise<PropertyRecord> {
  const property = await requireProperty(propertyId);
  if (property.organizationId !== context.organizationId && !context.isPlatformAdmin) {
    throw new NotFoundError("Propiedad no encontrada.");
  }
  return property;
}

function assertCategoryModeAllowsEdit(definition: CategoryDefinitionRecord, patch?: Record<string, unknown>) {
  if (definition.mode === "read_only") {
    throw new ConflictError("Las categorías de solo lectura no se pueden editar.");
  }
  if (definition.mode === "system_controlled" && (patch?.code !== undefined || patch?.label !== undefined)) {
    throw new ConflictError("Los códigos y etiquetas de las categorías legales controladas por el sistema no se pueden renombrar.");
  }
}

function categoryOptionView(propertyId: string, definition: CategoryDefinitionRecord, option: PropertyCategoryOptionRecord) {
  return {
    ...option,
    canDelete: !option.isSystemDefault,
    canDeactivate: true,
    linkedRecordsUrl: `/backoffice/properties/${propertyId}/configuration/categories/${definition.code}?option=${option.id}`
  };
}

/** Vista de una definición con las opciones de la propiedad ya cargadas (sin consultas). */
function buildCategoryView(propertyId: string, definition: CategoryDefinitionRecord, options: PropertyCategoryOptionRecord[]) {
  const own = options
    .filter((option) => option.categoryDefinitionId === definition.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
    .map((option) => categoryOptionView(propertyId, definition, option));
  return {
    ...definition,
    options: own,
    activeOptions: own.filter((option) => option.active).length,
    inactiveOptions: own.filter((option) => !option.active).length
  };
}

async function categoryWithOptions(propertyId: string, definition: CategoryDefinitionRecord) {
  return buildCategoryView(propertyId, definition, await listPropertyCategoryOptions(propertyId, { categoryDefinitionId: definition.id }));
}

async function configurationDataQuality(propertyId: string) {
  const rooms = demoStore.rooms.filter((room) => room.propertyId === propertyId);
  const roomTypes = demoStore.roomTypes.filter((roomType) => roomType.propertyId === propertyId);
  const inactiveOptions = await countPropertyCategoryOptions(propertyId, { active: false });
  return [
    {
      code: "rooms_without_room_type",
      severity: rooms.some((room) => room.sellable && !room.roomTypeId) ? "blocking" : "info",
      message: "Las habitaciones vendibles deben tener un tipo de habitación activo."
    },
    {
      code: "rooms_without_building_floor_zone",
      severity: rooms.some((room) => !room.buildingId || !room.floorId || !room.zoneId) ? "warning" : "info",
      message: "Las habitaciones deberían estar asignadas a edificio, planta y zona."
    },
    {
      code: "room_type_without_rooms",
      severity: roomTypes.some((roomType) => !rooms.some((room) => room.roomTypeId === roomType.id)) ? "warning" : "info",
      message: "Conviene revisar los tipos de habitación sin habitaciones."
    },
    {
      code: "inactive_category_still_used_by_active_records",
      severity: inactiveOptions > 0 ? "warning" : "info",
      message: "Las opciones de categoría desactivadas siguen visibles en los registros históricos y conviene revisarlas."
    },
    {
      code: "duplicate_option_codes",
      severity: "info",
      message: "Los códigos de opción son únicos por propiedad y categoría por restricción de la base de datos."
    }
  ];
}

function propertySetupFormDefinition(formCode: string) {
  const definition = PROPERTY_SETUP_FORM_DEFINITIONS.find((candidate) => candidate.code === formCode);
  if (!definition) {
    throw new NotFoundError(`Formulario de configuración no encontrado: ${formCode}`);
  }
  return definition;
}

function manualSetupOptionDefinition(optionCode: string) {
  const option = getManualSetupOption(optionCode);
  if (!option) {
    throw new NotFoundError(`Opción de configuración manual no encontrada: ${optionCode}`);
  }
  return option;
}

function manualSetupInputKey(label: string) {
  const words = label
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
}

function manualSetupPayloadValues(payload: Record<string, unknown>) {
  return typeof payload.values === "object" && payload.values !== null && !Array.isArray(payload.values)
    ? payload.values as Record<string, unknown>
    : payload;
}

function manualSetupPayloadHasValue(values: Record<string, unknown>, label: string) {
  const camelKey = manualSetupInputKey(label);
  const snakeKey = camelKey.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
  const candidateValues = [values[label], values[camelKey], values[snakeKey]];
  return candidateValues.some((value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

function validateManualSetupPayload(option: ReturnType<typeof manualSetupOptionDefinition>, payload: Record<string, unknown>) {
  const values = manualSetupPayloadValues(payload);
  return option.requiredInputs
    .filter((input) => !manualSetupPayloadHasValue(values, input))
    .map((input) => `${input} es obligatorio para ${option.label}.`);
}

function payloadText(payload: Record<string, unknown>, key: string, fallback?: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback ?? "";
}

function payloadNumber(payload: Record<string, unknown>, key: string, fallback?: number) {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return fallback;
}

function payloadBoolean(payload: Record<string, unknown>, key: string, fallback = true) {
  const value = payload[key];
  return typeof value === "boolean" ? value : fallback;
}

function payloadArray(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}

async function completePropertySetupStep(input: BackOfficeMutationInput, stepCode: string, metadataJson: Record<string, unknown>): Promise<PropertySetupStepRecord> {
  const existing = await findSetupStep(input.propertyId, stepCode);
  return upsertSetupStep(input.propertyId, stepCode, {
    status: "completed",
    completedAt: new Date(),
    completedBy: input.context.userId,
    metadataJson: { ...(existing?.metadataJson ?? {}), ...metadataJson }
  });
}

async function createCategoryOptionFromSetup(input: BackOfficeMutationInput, categoryCode: string, label: string): Promise<PropertyCategoryOptionRecord | undefined> {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) return undefined;
  const definition = await requireCategoryDefinition(categoryCode);
  const code = trimmedLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const existing = await findPropertyCategoryOptionByCode(input.propertyId, definition.id, code);
  if (existing) return existing;
  const record = await createPropertyCategoryOption({
    propertyId: input.propertyId,
    categoryDefinitionId: definition.id,
    userId: input.context.userId,
    option: {
      code,
      label: trimmedLabel,
      metadataJson: { createdFrom: "property_setup_form" },
      isSystemDefault: false,
      active: true,
      sortOrder: (await countPropertyCategoryOptions(input.propertyId, { categoryDefinitionId: definition.id })) + 1
    }
  });
  audit({ ...input, action: "CategoryOptionCreated", entityType: "property_category_option", entityId: record.id, afterJson: record });
  return record;
}

function validatePropertySetupPayload(definition: PropertySetupFormDefinition, payload: Record<string, unknown>) {
  return definition.fields
    .filter((field) => field.required)
    .filter((field) => {
      const value = payload[field.key];
      return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    })
    .map((field) => `${field.label} es obligatorio.`);
}

/** Columns of Property that only exist in Prisma (the PropertyRecord mirror predates Tanda 3). */
async function propertyFiscalColumns(propertyId: string): Promise<{
  taxRegion: string | null;
  province: string | null;
  postalCode: string | null;
  ineMunicipalityCode: string | null;
  fiscalTerritory: string | null;
  /** Tanda 6b: establishment columns of the structure (trade name, centre code, kind, legal entity). */
  tradeName: string | null;
  code: string | null;
  kind: string | null;
  legalEntityId: string | null;
}> {
  const row = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { taxRegion: true, province: true, postalCode: true, ineMunicipalityCode: true, fiscalTerritory: true, tradeName: true, code: true, kind: true, legalEntityId: true }
  });
  return row ?? { taxRegion: null, province: null, postalCode: null, ineMunicipalityCode: null, fiscalTerritory: null, tradeName: null, code: null, kind: null, legalEntityId: null };
}

/**
 * Current values of the property_profile form keyed by field key (canonical
 * codes; "" when unset). Tanda 6b: `legalName` / `taxId` are READ-ONLY mirrors
 * of the legal entity (resolveLegalIdentity) so an older form preloads the
 * sociedad's identity; the writable identity fields of the establishment are
 * `tradeName` and `code`.
 */
async function propertyProfileFormValues(
  propertyId: string,
  property: PropertyRecord,
  organization: OrganizationRecord,
  compliance: PropertyComplianceSettingsRecord
): Promise<Record<string, string>> {
  const fiscal = await propertyFiscalColumns(propertyId);
  const identity = await resolveLegalIdentity(organization.id);
  const taxRegion = normalizeTaxRegion(fiscal.taxRegion ?? property.taxRegion ?? null, fiscal.province ?? property.province ?? null);
  const tourismTaxRegion = normalizeTourismTaxRegion(compliance.tourismTaxRegion);
  return {
    name: property.name,
    tradeName: fiscal.tradeName ?? "",
    code: fiscal.code ?? "",
    kind: fiscal.kind ?? "hotel",
    legalEntityId: fiscal.legalEntityId ?? identity?.legalEntityId ?? "",
    legalName: identity?.legalName ?? "",
    taxId: identity?.taxId ?? "",
    address: property.address ?? "",
    country: property.country,
    province: property.province ?? "",
    city: property.municipality ?? "",
    postalCode: fiscal.postalCode ?? "",
    ineMunicipalityCode: fiscal.ineMunicipalityCode ?? "",
    timezone: property.timezone,
    taxRegion: taxRegion ?? "",
    fiscalTerritory: normalizeFiscalTerritory(fiscal.fiscalTerritory) ?? "",
    tourismTaxRegion: tourismTaxRegion ?? ""
  };
}

async function formExistingData(propertyId: string, formCode: string) {
  switch (formCode) {
    case "property_profile": {
      // Persistencia tanda 2: la vista de "datos existentes" confirma el guardado →
      // lee Prisma (fallback in-memory) para que sobreviva al reinicio.
      const property = await requireProperty(propertyId);
      const organization = await requireOrganization(property.organizationId);
      const compliance = await getComplianceSettings(propertyId);
      return {
        property,
        organization,
        compliance,
        // Tanda 3: form-key → current value map so the wizard PRELOADS instead of starting
        // blank (a blank save used to overwrite taxRegion with ""). Canonical codes only.
        values: await propertyProfileFormValues(propertyId, property, organization, compliance)
      };
    }
    // Fase 0 (Opción A): estructura de propiedad servida desde Prisma (fuente de verdad).
    case "building":
      return prisma.building.findMany({ where: { propertyId } });
    case "floor":
      return prisma.floor.findMany({ where: { propertyId } });
    case "zone":
      return prisma.propertyZone.findMany({ where: { propertyId } });
    case "room_type":
      return listBackOfficeRoomTypes(propertyId);
    case "room":
      return (await prisma.room.findMany({ where: { propertyId } })).map(mapRoomRow);
    case "space_resource":
      return prisma.propertySpace.findMany({ where: { propertyId } });
    case "department":
      return listDepartments(propertyId);
    case "housekeeping_setup":
      return getHousekeepingConfiguration(propertyId);
    case "maintenance_setup":
      return getMaintenanceConfiguration(propertyId);
    case "finance_compliance_setup":
      return { compliance: await getComplianceSettings(propertyId), billing: await getBillingSettings(propertyId) };
    case "ai_setup":
      return getAiSettings(propertyId);

    case "custom_field":
      return listCustomFields(propertyId);
    default:
      return {};
  }
}

type PropertySetupTarget = {
  targetEntityType: string;
  targetEntityId?: string;
  result: unknown;
};

async function applyPropertySetupForm(input: BackOfficeMutationInput, definition: PropertySetupFormDefinition, payload: Record<string, unknown>): Promise<PropertySetupTarget> {
  switch (definition.code) {
    case "property_profile": {
      const property = await requireProperty(input.propertyId);
      // The organization is the property's OWN organization (never demoStore.organization /
      // org_123): writing the legal profile of one tenant must not touch another tenant's row.
      const organization = await requireOrganization(property.organizationId);
      const currentFiscal = await propertyFiscalColumns(property.id);
      const before = { property: { ...property, ...currentFiscal }, organization: { ...organization } };
      // Persistencia tanda 2: Prisma primero (Property + Organization), después espejo.
      // Tanda 3: fiscal-location fields are NON-destructive (empty input keeps the
      // current value, "" is never persisted) and validated: canonical region (400 when
      // unrecognised), 5-digit CP / INE coherent by province, reporting territory.
      const nextProvince = payloadText(payload, "province", property.province ?? "");
      const fiscal = resolveFiscalLocation({
        current: currentFiscal,
        patch: {
          taxRegion: payloadText(payload, "taxRegion") || payloadText(payload, "region"),
          postalCode: payloadText(payload, "postalCode"),
          ineMunicipalityCode: payloadText(payload, "ineMunicipalityCode"),
          fiscalTerritory: payloadText(payload, "fiscalTerritory")
        },
        province: nextProvince || null
      });
      const tourismTaxRegionInput = payloadText(payload, "tourismTaxRegion");
      const tourismTaxRegion = tourismTaxRegionInput ? normalizeTourismTaxRegion(tourismTaxRegionInput) : undefined;
      if (tourismTaxRegionInput && !tourismTaxRegion) {
        throw new BadRequestError(
          `Región de tasa turística no reconocida («${tourismTaxRegionInput}»). Valores admitidos: ${TOURISM_TAX_REGION_OPTIONS.map((option) => option.value).join(", ")}.`
        );
      }
      const nextProperty: PropertyRecord = {
        ...property,
        name: payloadText(payload, "name", property.name),
        address: payloadText(payload, "address", property.address ?? ""),
        country: payloadText(payload, "country", property.country),
        municipality: payloadText(payload, "city", property.municipality ?? ""),
        province: nextProvince,
        timezone: payloadText(payload, "timezone", property.timezone),
        taxRegion: fiscal.taxRegionToPersist ?? undefined
      };
      // Tanda 6b (L2, design §5.4 / §4 #16): the profile NEVER writes the NIF nor the
      // razón social — they belong to the legal entity (Configuración › Estructura
      // societaria › Datos fiscales). A body that tries to CHANGE them is a 409
      // LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY (values equal to the sociedad's are
      // tolerated: an older form still preloads them). Property.legalName is deprecated
      // and no longer written; the establishment keeps its trade name and centre code.
      await assertProfileDoesNotWriteLegalIdentity(property.organizationId, { legalName: payloadText(payload, "legalName"), taxId: payloadText(payload, "taxId") });
      const tradeNameInput = payloadText(payload, "tradeName");
      const codeInput = payloadText(payload, "code").toUpperCase();
      if (codeInput && !STRUCTURE_CODE_PATTERN.test(codeInput)) {
        throw new BadRequestError(`Código de centro no válido («${codeInput}»): usa de 2 a 6 letras o dígitos en mayúsculas (p. ej. RA, LT, OC).`);
      }
      if (codeInput && codeInput !== currentFiscal.code) {
        const codeClash = await prisma.property.findFirst({
          where: {
            code: codeInput,
            id: { not: property.id },
            ...(currentFiscal.legalEntityId
              ? { OR: [{ legalEntityId: currentFiscal.legalEntityId }, { legalEntityId: null, organizationId: property.organizationId }] }
              : { organizationId: property.organizationId })
          },
          select: { id: true }
        });
        if (codeClash) throw codeInUse("property", codeInput);
      }
      const identity = await resolveLegalIdentity(property.organizationId);
      const propertyData = {
        name: nextProperty.name,
        address: nextProperty.address ?? null,
        municipality: nextProperty.municipality ?? null,
        province: nextProperty.province || null,
        country: nextProperty.country,
        taxRegion: fiscal.taxRegionToPersist,
        postalCode: fiscal.postalCode,
        ineMunicipalityCode: fiscal.ineMunicipalityCode,
        fiscalTerritory: fiscal.fiscalTerritory,
        timezone: nextProperty.timezone,
        ...(tradeNameInput ? { tradeName: tradeNameInput } : {}),
        ...(codeInput ? { code: codeInput } : {})
      };
      // upsert: tolera properties que solo existen en el seed in-memory (p.ej. prop_456).
      await prisma.property.upsert({
        where: { id: property.id },
        update: propertyData,
        create: {
          id: property.id,
          organizationId: property.organizationId,
          ...propertyData,
          // Property.legalName is deprecated (design §5.1 · R2): the razón social is the
          // sociedad's and the trade name travels in `tradeName`; nothing writes it any more.
          sesHospedajesEnabled: property.sesHospedajesEnabled,
          verifactuEnabled: property.verifactuEnabled
        }
      });
      Object.assign(property, nextProperty);
      if (demoStore.property.id === property.id) Object.assign(demoStore.property, property);
      // The in-memory demo organization mirrors the sociedad's identity (read-only, design §5.6).
      const nextOrganization: OrganizationRecord = identity
        ? { ...organization, legalName: identity.legalName, taxId: identity.taxId ?? "" }
        : { ...organization };
      if (demoStore.organization.id === organization.id && identity) Object.assign(demoStore.organization, nextOrganization);
      // Compliance is only re-aligned when the property already has settings (persisted or
      // seed): the profile form never provisions compliance on its own.
      const existingCompliance = await findComplianceSettings(input.propertyId);
      let compliance: PropertyComplianceSettingsRecord | undefined;
      if (existingCompliance) {
        const nextCompliance: PropertyComplianceSettingsRecord = {
          ...existingCompliance.settings,
          // Mirror of Property.taxRegion (canonical); never "" (undefined → NULL).
          taxRegion: fiscal.taxRegionToPersist ?? undefined,
          tourismTaxRegion:
            tourismTaxRegion === undefined
              ? existingCompliance.settings.tourismTaxRegion || undefined
              : tourismTaxRegion === "none" || tourismTaxRegion === null
                ? undefined
                : tourismTaxRegion,
          updatedAt: nowIso()
        };
        const persisted = await persistComplianceSettings(nextCompliance);
        compliance = mirrorRecord(demoStore.propertyComplianceSettings, persisted, byPropertyId(input.propertyId));
      }
      // The tax resolver caches region + rates per property: drop them so the next folio
      // line / invoice uses the region just saved, then (re)provision the statutory
      // catalogue for that region (idempotent; contract C). Provisioning failure is
      // reported, never hidden: the profile IS saved, readiness will flag the missing rates.
      invalidateTaxCache(property.id);
      let taxProvisioning: { ok: boolean; taxRegion: string | null; provisioned?: number; skipped?: number; error?: string };
      try {
        const provisioned = await ensurePropertyTaxes({ propertyId: property.id, organizationId: property.organizationId, taxRegion: fiscal.taxRegionToPersist });
        taxProvisioning = { ok: true, ...provisioned };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[backoffice.property_profile] ensurePropertyTaxes failed after profile save", {
          propertyId: property.id,
          correlationId: input.correlationId,
          taxRegion: fiscal.taxRegionToPersist,
          error: message
        });
        taxProvisioning = { ok: false, taxRegion: fiscal.taxRegion, error: message };
      }
      const fiscalAfter = {
        taxRegion: fiscal.taxRegion,
        taxRegionSource: fiscal.taxRegionSource,
        fiscalTerritory: fiscal.fiscalTerritory,
        postalCode: fiscal.postalCode,
        ineMunicipalityCode: fiscal.ineMunicipalityCode,
        tourismTaxRegion: compliance?.tourismTaxRegion ?? null,
        taxProvisioning
      };
      audit({
        ...input,
        action: "PropertyProfileUpdated",
        entityType: "property",
        entityId: property.id,
        beforeJson: before,
        afterJson: { property: { ...property, ...fiscalAfter }, organization: nextOrganization, compliance }
      });
      return { targetEntityType: "property", targetEntityId: property.id, result: { ...property, ...fiscalAfter } };
    }
    case "building": {
      const building = await createBuilding({
        ...input,
        building: {
          name: payloadText(payload, "name"),
          code: payloadText(payload, "code"),
          description: payloadText(payload, "description"),
          sortOrder: payloadNumber(payload, "sortOrder"),
          active: payloadBoolean(payload, "active", true)
        }
      });
      return { targetEntityType: "building", targetEntityId: building.id, result: building };
    }
    case "floor": {
      const floor = await createFloor({
        ...input,
        floor: {
          buildingId: payloadText(payload, "buildingId", demoStore.buildings.find((building) => building.propertyId === input.propertyId)?.id),
          name: payloadText(payload, "name"),
          floorNumber: payloadNumber(payload, "floorNumber"),
          code: payloadText(payload, "code"),
          sortOrder: payloadNumber(payload, "sortOrder"),
          active: payloadBoolean(payload, "active", true)
        }
      });
      return { targetEntityType: "floor", targetEntityId: floor.id, result: floor };
    }
    case "zone": {
      const zone = await createZone({
        ...input,
        zone: {
          buildingId: payloadText(payload, "buildingId", demoStore.buildings.find((building) => building.propertyId === input.propertyId)?.id),
          floorId: payloadText(payload, "floorId", demoStore.floors.find((floor) => floor.propertyId === input.propertyId)?.id),
          name: payloadText(payload, "name"),
          zoneType: payloadText(payload, "zoneType", "guest_rooms") as PropertyZoneRecord["zoneType"],
          code: payloadText(payload, "code"),
          description: payloadText(payload, "description"),
          active: payloadBoolean(payload, "active", true)
        }
      });
      return { targetEntityType: "property_zone", targetEntityId: zone.id, result: zone };
    }
    case "room_type": {
      const roomType = await createBackOfficeRoomType({
        ...input,
        roomType: {
          name: payloadText(payload, "name"),
          code: payloadText(payload, "code"),
          maxOccupancy: payloadNumber(payload, "maxOccupancy", 2)!,
          baseCapacity: payloadNumber(payload, "baseOccupancy", 2)!,
          description: payloadText(payload, "description"),
          defaultBedConfigurationJson: { defaultBedSetup: payloadText(payload, "defaultBedSetup") },
          defaultAmenitiesJson: {
            features: payloadArray(payload, "defaultFeatures"),
            cleaningCategory: payloadText(payload, "defaultCleaningCategory")
          },
          defaultRateCategory: payloadText(payload, "category"),
          sellable: payloadBoolean(payload, "sellable", true),
          displayOrder: payloadNumber(payload, "displayOrder")
        }
      });
      return { targetEntityType: "room_type", targetEntityId: roomType.id, result: roomType };
    }
    case "room": {
      const created = await bulkCreateRooms({
        ...input,
        roomTypeId: payloadText(payload, "roomTypeId", demoStore.roomTypes.find((roomType) => roomType.propertyId === input.propertyId)?.id),
        roomNumbers: [payloadText(payload, "roomNumber")],
        buildingId: payloadText(payload, "buildingId", demoStore.buildings.find((building) => building.propertyId === input.propertyId)?.id),
        floorId: payloadText(payload, "floorId", demoStore.floors.find((floor) => floor.propertyId === input.propertyId)?.id),
        zoneId: payloadText(payload, "zoneId", demoStore.propertyZones.find((zone) => zone.propertyId === input.propertyId)?.id),
        sellable: payloadBoolean(payload, "sellable", true),
        active: payloadBoolean(payload, "active", true)
      });
      const baseRoom = created.rooms[0];
      // Fase 0 (Opción A): los campos de detalle del formulario se persisten a Prisma
      // (antes solo se hacía Object.assign en memoria y se perdían al reiniciar).
      const updatedRow = await prisma.room.update({
        where: { id: baseRoom.id },
        data: {
          displayName: payloadText(payload, "displayName", baseRoom.displayName ?? `Room ${baseRoom.number}`),
          maxOccupancy: payloadNumber(payload, "maxOccupancy", baseRoom.maxOccupancy),
          standardOccupancy: payloadNumber(payload, "standardOccupancy", baseRoom.standardOccupancy),
          bedConfigurationJson: { beds: payload.beds ?? {} },
          featuresJson: { features: payloadArray(payload, "features") },
          viewType: payloadText(payload, "viewType", baseRoom.viewType ?? ""),
          orientation: payloadText(payload, "orientation", baseRoom.orientation ?? ""),
          squareMeters: payloadNumber(payload, "squareMeters", baseRoom.squareMeters) ?? null,
          accessibilityJson: { accessibility: payloadArray(payload, "accessibility") },
          status: payloadText(payload, "status", baseRoom.status) as RoomRecord["status"]
        }
      });
      const room = mapRoomRow(updatedRow);
      const idx = demoStore.rooms.findIndex((r) => r.id === room.id);
      if (idx >= 0) demoStore.rooms[idx] = room;
      else demoStore.rooms.push(room);
      return { targetEntityType: "room", targetEntityId: room.id, result: room };
    }
    case "space_resource": {
      const space = await createSpace({
        ...input,
        space: {
          name: payloadText(payload, "name"),
          code: payloadText(payload, "code"),
          spaceType: payloadText(payload, "spaceType", "other") as PropertySpaceRecord["spaceType"],
          buildingId: payloadText(payload, "buildingId", demoStore.buildings.find((building) => building.propertyId === input.propertyId)?.id),
          floorId: payloadText(payload, "floorId", demoStore.floors.find((floor) => floor.propertyId === input.propertyId)?.id),
          zoneId: payloadText(payload, "zoneId", demoStore.propertyZones.find((zone) => zone.propertyId === input.propertyId)?.id),
          description: JSON.stringify({
            resourceType: payloadText(payload, "resourceType"),
            capacity: payloadNumber(payload, "capacity"),
            hourlyBookable: payloadBoolean(payload, "hourlyBookable", false),
            dailyBookable: payloadBoolean(payload, "dailyBookable", true),
            monthlyBookable: payloadBoolean(payload, "monthlyBookable", false),
            sellable: payloadBoolean(payload, "sellable", false),
            taxCode: payloadText(payload, "taxCode"),
            defaultRate: payloadNumber(payload, "defaultRate")
          }),
          active: payloadBoolean(payload, "active", true)
        }
      });
      return { targetEntityType: "property_space", targetEntityId: space.id, result: space };
    }
    case "department": {
      const department = await createDepartment({
        ...input,
        department: {
          name: payloadText(payload, "name"),
          code: payloadText(payload, "code"),
          description: payloadText(payload, "description"),
          active: payloadBoolean(payload, "active", true)
        }
      });
      const managerUserId = payloadText(payload, "managerUserId");
      if (managerUserId) {
        await assignUserToDepartment({ ...input, departmentId: department.id, userId: managerUserId, roleLabel: "Manager" });
      }
      return { targetEntityType: "department", targetEntityId: department.id, result: department };
    }
    case "housekeeping_setup": {
      const section = await createHousekeepingSection({
        ...input,
        section: {
          name: payloadText(payload, "sectionName"),
          code: payloadText(payload, "sectionCode"),
          active: true
        }
      });
      const rule = await upsertHousekeepingRule({
        ...input,
        ruleCode: "housekeeping_operating_policy",
        configurationJson: payload,
        active: true
      });
      return { targetEntityType: "housekeeping_rule", targetEntityId: rule.id, result: { section, rule } };
    }
    case "maintenance_setup": {
      const area = await createMaintenanceArea({
        ...input,
        area: {
          name: payloadText(payload, "areaName"),
          code: payloadText(payload, "areaCode"),
          active: true
        }
      });
      const rule = await upsertMaintenanceRule({
        ...input,
        ruleCode: "maintenance_operating_policy",
        configurationJson: payload,
        active: true
      });
      return { targetEntityType: "maintenance_rule", targetEntityId: rule.id, result: { area, rule } };
    }
    case "revenue_setup": {
      const createdOptions = [
        await createCategoryOptionFromSetup(input, "market_segments", payloadText(payload, "marketSegmentLabel")),
        await createCategoryOptionFromSetup(input, "channel_categories", payloadText(payload, "channelCategoryLabel")),
        await createCategoryOptionFromSetup(input, "revenue_report_fields", payloadText(payload, "rateCategoryLabel"))
      ].filter(Boolean);
      return { targetEntityType: "revenue_category_setup", result: { createdOptions, payload } };
    }
    case "finance_compliance_setup": {
      const compliance = await patchComplianceSettings({
        ...input,
        patch: {
          // Tanda 3: an empty select keeps the current region (never persists "").
          taxRegion: payloadText(payload, "taxRegion") || undefined,
          configurationJson: {
            authorityType: payloadText(payload, "authorityType"),
            retentionRule: payloadText(payload, "retentionRule"),
            submissionMode: payloadText(payload, "submissionMode")
          }
        }
      });
      const invoicePrefix = payloadText(payload, "invoicePrefix");
      const billing = await patchBillingSettings({
        ...input,
        invoiceSequence: {
          sequenceCode: payloadText(payload, "invoiceSequenceCode"),
          invoiceType: payloadText(payload, "invoiceType", "full") as InvoiceSequenceRecord["invoiceType"],
          // Only an explicit prefix reaches the series (an empty one would collide with the prefix lock).
          ...(invoicePrefix ? { prefix: invoicePrefix } : {}),
          active: true
        }
      });
      await createCategoryOptionFromSetup(input, "payment_method_categories", payloadText(payload, "paymentMethodCategory"));
      return { targetEntityType: "property_compliance_settings", targetEntityId: compliance.id, result: { compliance, billing } };
    }
    case "ai_setup": {
      const settings = await patchAiSettings({
        ...input,
        patch: {
          aiEnabled: payloadBoolean(payload, "aiEnabled", true),
          defaultAutomationLevel: payloadText(payload, "defaultAutomationLevel", "suggest_and_confirm") as PropertyAiSettingsRecord["defaultAutomationLevel"],
          guestFacingDisclosure: payloadText(payload, "guestFacingDisclosure"),
          voiceLocales: payloadArray(payload, "voiceLocales").map(String),
          configurationJson: {
            documentImageRetentionPolicy: payloadText(payload, "documentImageRetentionPolicy", "discard_after_ocr"),
            humanReviewDefault: payloadText(payload, "humanReviewDefault", "required_for_sensitive")
          }
        }
      });
      return { targetEntityType: "property_ai_settings", targetEntityId: settings.id, result: settings };
    }
    case "custom_field": {
      const field = await createCustomField({
        ...input,
        field: {
          entityType: payloadText(payload, "entityType"),
          fieldKey: payloadText(payload, "fieldKey"),
          label: payloadText(payload, "label"),
          description: payloadText(payload, "description"),
          dataType: payloadText(payload, "dataType", "text") as PropertyCustomFieldDefinitionRecord["dataType"],
          required: payloadBoolean(payload, "required", false),
          searchable: payloadBoolean(payload, "searchable", false),
          visibleInList: payloadBoolean(payload, "visibleInList", false),
          visibleInDetail: payloadBoolean(payload, "visibleInDetail", true),
          validationJson: typeof payload.validationJson === "object" && payload.validationJson !== null ? payload.validationJson as Record<string, unknown> : {}
        }
      });
      return { targetEntityType: "property_custom_field_definition", targetEntityId: field.id, result: field };
    }
    default:
      return { targetEntityType: definition.targetEntityType, result: payload };
  }
}

export async function listPropertySetupForms(propertyId: string) {
  await requireProperty(propertyId);
  const [steps, latestByForm] = await Promise.all([listSetupSteps(propertyId, SETUP_STEPS), latestSetupFormSubmissionsByForm(propertyId)]);
  return {
    propertyId,
    forms: PROPERTY_SETUP_FORM_DEFINITIONS.map((definition) => {
      const step = steps.find((candidate) => candidate.stepCode === definition.setupStepCode);
      const latestSubmission = latestByForm.get(definition.code);
      return {
        ...definition,
        status: latestSubmission?.status ?? step?.status ?? "not_started",
        latestSubmission
      };
    })
  };
}

export async function listManualSetupOptions(propertyId: string) {
  await requireProperty(propertyId);
  // Hydrate the module mirror from Prisma first: it is empty for Prisma-only hotels at boot.
  await listPropertyModules(propertyId);
  const enabledModules = new Set(
    demoStore.propertyModules
      .filter((propertyModule) => propertyModule.propertyId === propertyId && propertyModule.status !== "disabled")
      .map((propertyModule) => propertyModule.moduleId)
  );
  const latestByOption = await latestManualSetupSubmissionsByOption(propertyId);
  const options = MANUAL_SETUP_OPTIONS.map((option) => {
    const latestSubmission = latestByOption.get(option.code);
    return {
      ...option,
      setupState: latestSubmission?.status ?? "not_started",
      latestSubmission,
      moduleEnabled: !option.moduleCode || option.moduleCode === "backoffice" || enabledModules.has(option.moduleCode),
      localDemoReason:
        option.moduleCode && option.moduleCode !== "backoffice" && !enabledModules.has(option.moduleCode)
          ? `Oculta porque el módulo ${option.moduleCode} está desactivado`
          : "Visible"
    };
  });

  return {
    propertyId,
    coverage: MANUAL_SETUP_COVERAGE_SUMMARY,
    setupSummary: {
      totalOptions: options.length,
      savedOptions: options.filter((option) => option.setupState === "saved").length,
      failedOptions: options.filter((option) => option.setupState === "failed").length,
      notStartedOptions: options.filter((option) => option.setupState === "not_started").length
    },
    options
  };
}

export async function getManualSetupOptionDetail(propertyId: string, optionCode: string) {
  await requireProperty(propertyId);
  const option = manualSetupOptionDefinition(optionCode);
  const submissions = await listManualSetupSubmissions(propertyId, option.code);
  return {
    propertyId,
    option,
    latestSubmission: submissions.at(-1),
    submissions,
    databaseBinding: {
      readEndpoint: option.apiEndpoint,
      saveEndpoint: option.saveEndpoint,
      targetTables: option.targetTables,
      inputCategories: option.inputCategories
    }
  };
}

const manualSetupPayloadSchema = z.record(z.string(), z.unknown());

export async function saveManualSetupOption(input: BackOfficeMutationInput & {
  optionCode: string;
  payload: Record<string, unknown>;
}) {
  const option = manualSetupOptionDefinition(input.optionCode);
  await requireOrganizationProperty(input.propertyId, input.context);
  requirePermissions(input.context, [option.permission as PermissionKey]);
  const payload = parse(manualSetupPayloadSchema, input.payload ?? {}, "body");
  const validationErrors = validateManualSetupPayload(option, payload);
  const submission = await createManualSetupSubmission({
    propertyId: input.propertyId,
    optionCode: option.code,
    status: validationErrors.length > 0 ? "failed" : "saved",
    payloadJson: payload,
    validationErrorsJson: validationErrors,
    targetTables: [...option.targetTables],
    inputCategories: [...option.inputCategories],
    completionChecksJson: option.completionChecks.map((check) => ({ ...check })),
    createdBy: input.context.userId
  });

  if (validationErrors.length > 0) {
    audit({
      ...input,
      action: "ManualSetupValidationFailed",
      entityType: "manual_setup_submission",
      entityId: submission.id,
      afterJson: { submission, option }
    });
    // Validation failures are a client error (400), never a generic 500.
    throw new BadRequestError(validationErrors.join(" "));
  }

  audit({
    ...input,
    action: "ManualSetupOptionSaved",
    entityType: "manual_setup_submission",
    entityId: submission.id,
    afterJson: { submission, option }
  });
  domain({
    ...input,
    eventType: "ManualSetupOptionSaved",
    entityType: "manual_setup_submission",
    entityId: submission.id,
    payload: { optionCode: option.code, targetTables: option.targetTables }
  });

  return {
    option,
    submission,
    databaseBinding: {
      readEndpoint: option.apiEndpoint,
      saveEndpoint: option.saveEndpoint,
      targetTables: option.targetTables,
      inputCategories: option.inputCategories
    }
  };
}

export async function getPropertySetupForm(propertyId: string, formCode: string) {
  await requireProperty(propertyId);
  const definition = propertySetupFormDefinition(formCode);
  const categoryCodes = definition.fields.map((field) => field.categoryCode).filter((code): code is string => Boolean(code));
  const [definitions, options, submissions, existingData, dataQuality] = await Promise.all([
    categoryCodes.length > 0 ? listCategoryDefinitions() : Promise.resolve([] as CategoryDefinitionRecord[]),
    categoryCodes.length > 0 ? listPropertyCategoryOptions(propertyId) : Promise.resolve([] as PropertyCategoryOptionRecord[]),
    listSetupFormSubmissions(propertyId, formCode),
    formExistingData(propertyId, formCode),
    configurationDataQuality(propertyId)
  ]);
  return {
    ...definition,
    propertyId,
    existingData,
    categoryOptions: definition.fields
      .filter((field) => field.categoryCode)
      .map((field) => {
        const categoryDefinition = definitions.find((candidate) => candidate.code === field.categoryCode);
        if (!categoryDefinition) {
          throw new NotFoundError(`Definición de categoría no encontrada: ${field.categoryCode}`);
        }
        return {
          fieldKey: field.key,
          categoryCode: field.categoryCode,
          options: buildCategoryView(propertyId, categoryDefinition, options).options
        };
      }),
    dataQuality,
    submissions
  };
}

const propertySetupPayloadSchema = z.record(z.string(), z.unknown());

export async function savePropertySetupForm(input: BackOfficeMutationInput & {
  formCode: string;
  payload: Record<string, unknown>;
}) {
  const definition = propertySetupFormDefinition(input.formCode);
  requirePermissions(input.context, [definition.permission]);
  await requireOrganizationProperty(input.propertyId, input.context);
  const payload = parse(propertySetupPayloadSchema, input.payload ?? {}, "body");
  const validationErrors = validatePropertySetupPayload(definition, payload);
  if (validationErrors.length > 0) {
    const failed = await createSetupFormSubmission({
      propertyId: input.propertyId,
      formCode: definition.code,
      status: "failed",
      payloadJson: payload,
      validationErrorsJson: validationErrors,
      targetEntityType: definition.targetEntityType,
      createdBy: input.context.userId
    });
    audit({ ...input, action: "PropertySetupFormValidationFailed", entityType: "property_setup_form_submission", entityId: failed.id, afterJson: failed });
    // Validation failures are a client error (400), never a generic 500.
    throw new BadRequestError(validationErrors.join(" "));
  }

  const target = await applyPropertySetupForm(input, definition, payload);
  const submission = await createSetupFormSubmission({
    propertyId: input.propertyId,
    formCode: definition.code,
    status: "saved",
    payloadJson: payload,
    validationErrorsJson: [],
    targetEntityType: target.targetEntityType,
    targetEntityId: target.targetEntityId,
    createdBy: input.context.userId
  });
  const step = await completePropertySetupStep(input, definition.setupStepCode, { lastFormCode: definition.code, lastSubmissionId: submission.id });
  audit({ ...input, action: "PropertySetupFormSaved", entityType: target.targetEntityType, entityId: target.targetEntityId, afterJson: { submission, target: target.result, step } });
  domain({
    ...input,
    eventType: "PropertySetupFormSaved",
    entityType: target.targetEntityType,
    entityId: target.targetEntityId,
    payload: { formCode: definition.code, submissionId: submission.id }
  });
  return {
    form: definition,
    submission,
    target,
    setupStep: step
  };
}

/**
 * Readiness checks are persisted in property_readiness_checks (unique per propertyId +
 * checkCode) so every API replica reads the same result instead of a per-process memory
 * copy (Tanda L2 · L2-04: no in-memory mirror any more — the 68 real rows are the truth).
 */
async function upsertReadinessCheck(
  propertyId: string,
  check: Omit<PropertyReadinessCheckRecord, "id" | "propertyId" | "createdAt" | "updatedAt">
): Promise<PropertyReadinessCheckRecord> {
  const data = {
    status: check.status,
    severity: check.severity,
    message: check.message,
    relatedEntityType: check.relatedEntityType ?? null,
    relatedEntityId: check.relatedEntityId ?? null
  };
  const row = await prisma.propertyReadinessCheck.upsert({
    where: { propertyId_checkCode: { propertyId, checkCode: check.checkCode } },
    create: { propertyId, checkCode: check.checkCode, ...data },
    update: data
  });
  return mapReadinessCheckRow(row);
}

const RECENT_AUDIT_EVENTS_LIMIT = 8;

export async function getBackOfficeDashboard(propertyId: string) {
  const property = await requireProperty(propertyId);
  // Tenant-scoped counters read Prisma (source of truth): the demoStore mirrors are hydrated
  // lazily (room types only after a /room-types call, rooms never) and auditEvents/users hold
  // every tenant's records, which leaked other organizations' events into this dashboard.
  const [setup, readiness, modules, ai, usersPendingInvitation, roomsMapped, roomTypesConfigured, auditRows] = await Promise.all([
    getSetupProgress(propertyId),
    getReadiness(propertyId),
    listBackOfficeModules(propertyId),
    resolveAiSettings(propertyId),
    prisma.user.count({ where: { organizationId: property.organizationId, status: "invited" } }),
    prisma.room.count({
      where: { propertyId, OR: [{ buildingId: { not: null } }, { floorId: { not: null } }, { zoneId: { not: null } }] }
    }),
    prisma.roomType.count({ where: { propertyId, active: true } }),
    prisma.auditEvent.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" }, take: RECENT_AUDIT_EVENTS_LIMIT })
  ]);
  // Audit writes reach Postgres through an async queue (audit.service.ts), so events sealed a
  // moment ago may only exist in the mirror: merge the property-scoped entries and keep the newest.
  const recentAuditEvents = mergeById(
    auditRows.map(mapAuditEventRow),
    demoStore.auditEvents.filter((event) => event.propertyId === propertyId).slice(-RECENT_AUDIT_EVENTS_LIMIT)
  )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, RECENT_AUDIT_EVENTS_LIMIT);
  const integrationErrors = demoStore.integrationConnections.filter(
    (connection) => connection.propertyId === propertyId && connection.status === "error"
  );
  const failedIntegrationEvents = demoStore.integrationEvents.filter((event) => event.status === "failed");
  const paymentProviderConnected = demoStore.integrationConnections.some((connection) => {
    const provider = demoStore.integrationProviders.find((candidate) => candidate.id === connection.providerId);
    return connection.propertyId === propertyId && connection.status === "connected" && provider?.code.includes("payments");
  });
  const blockingIssues = readiness.checks.filter((check) => check.severity === "blocking" && check.status !== "pass");

  return {
    propertyId,
    setupProgress: setup.progressPercent,
    goLiveReadiness: readiness.status,
    blockingIssues,
    activeModules: modules.filter((module) => module.status === "enabled").length,
    modulesNeedingConfiguration: modules.filter((module) => module.healthStatus !== "ok"),
    integrationErrors: integrationErrors.length + failedIntegrationEvents.length,
    complianceWarnings: readiness.checks.filter((check) => check.severity !== "info").length,
    usersPendingInvitation,
    roomsMapped,
    roomTypesConfigured,
    invoiceSequenceStatus: demoStore.invoiceSequences.some((sequence) => sequence.propertyId === propertyId && sequence.active)
      ? "configured"
      : "missing",
    paymentProviderStatus: paymentProviderConnected ? "connected" : "missing",
    aiStatus: ai.settings.aiEnabled ? "enabled" : "disabled",
    recommendedNextAction: blockingIssues[0]?.message ?? "Review go-live checklist.",
    recentAuditEvents
  };
}

export async function getConfigurationCenter(propertyId: string) {
  await requireProperty(propertyId);
  const [definitions, optionCount, customFieldCount, dataQuality] = await Promise.all([
    listCategoryDefinitions(),
    countPropertyCategoryOptions(propertyId),
    countCustomFieldDefinitions(propertyId, { active: true }),
    configurationDataQuality(propertyId)
  ]);
  return {
    propertyId,
    title: "Centro de configuración",
    description: "Gestiona categorías, campos personalizados, tipos de habitación, espacios, departamentos, segmentos de mercado, reglas de pisos y categorías de mantenimiento.",
    categoryGroups: Array.from(new Set(definitions.map((definition) => definition.categoryGroup))),
    categoryCount: definitions.length,
    optionCount,
    customFieldCount,
    setupForms: [
      "PropertyProfileForm",
      "BuildingForm",
      "FloorForm",
      "ZoneForm",
      "RoomTypeForm",
      "RoomForm",
      "SpaceResourceForm",
      "DepartmentForm",
      "HousekeepingSetupForms",
      "MaintenanceSetupForms",
      "RevenueCategoryForms",
      "ComplianceCategoryForms"
    ],
    dataQuality,
    primaryActions: ["Open Category Manager", "Open Custom Fields", "Apply template", "Import categories", "Ask AI Setup Assistant"]
  };
}

// ── Gestor de categorías (Tanda L2 · L2-04: Prisma) ─────────────────────────
// Authorization for these GETs lives in the RBAC route manifest (categories.read); the former
// requirePermissions(demoStore.userContext) evaluated the demo super-user, not the request.

const jsonRecordSchema = z.record(z.string(), z.unknown());
const optionalNullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const CATEGORY_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const categoryOptionTranslationSchema = z
  .object({
    language: z.string().trim().min(2).max(10),
    label: z.string().trim().min(1).max(200),
    description: optionalNullableText(500)
  })
  .strict();

const categoryOptionCreateSchema = z
  .object({
    code: z.string().trim().min(1).max(80).regex(CATEGORY_CODE_PATTERN, "código: solo letras, números, guion, punto y guion bajo"),
    label: z.string().trim().min(1).max(200),
    description: optionalNullableText(500),
    colorToken: optionalNullableText(80),
    iconName: optionalNullableText(80),
    parentOptionId: optionalNullableText(64),
    metadataJson: jsonRecordSchema.optional(),
    isSystemDefault: z.boolean().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    translations: z.array(categoryOptionTranslationSchema).max(20).optional()
  })
  .strict();

const categoryOptionPatchSchema = categoryOptionCreateSchema.partial().strict();

export type CategoryOptionInput = z.input<typeof categoryOptionCreateSchema>;
export type CategoryOptionPatch = z.input<typeof categoryOptionPatchSchema>;

const categoryOptionIdsSchema = z.array(z.string().trim().min(1).max(64)).min(1).max(500);

export async function listConfigurationCategories(propertyId: string) {
  await requireProperty(propertyId);
  const [definitions, options] = await Promise.all([listCategoryDefinitions(), listPropertyCategoryOptions(propertyId)]);
  return {
    propertyId,
    groups: Array.from(new Set(definitions.map((definition) => definition.categoryGroup))).map((group) => ({
      group,
      categories: definitions
        .filter((definition) => definition.categoryGroup === group)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((definition) => buildCategoryView(propertyId, definition, options))
    }))
  };
}

export async function getConfigurationCategory(propertyId: string, categoryCode: string) {
  await requireProperty(propertyId);
  return categoryWithOptions(propertyId, await requireCategoryDefinition(categoryCode));
}

export async function createCategoryOption(input: BackOfficeMutationInput & {
  categoryCode: string;
  option: CategoryOptionInput;
}) {
  requirePermissions(input.context, ["categories.manage"]);
  const option = parse(categoryOptionCreateSchema, input.option, "body");
  await requireOrganizationProperty(input.propertyId, input.context);
  const definition = await requireCategoryDefinition(input.categoryCode);
  assertCategoryModeAllowsEdit(definition);
  if (definition.mode === "system_controlled" && !option.isSystemDefault) {
    throw new ConflictError("Las categorías legales controladas por el sistema solo se amplían mediante valores por defecto controlados.");
  }
  if (option.parentOptionId) {
    const parent = await findPropertyCategoryOption(input.propertyId, option.parentOptionId);
    if (!parent || parent.categoryDefinitionId !== definition.id) {
      throw new BadRequestError("La opción superior debe pertenecer a la misma propiedad y categoría.");
    }
  }
  // Duplicate (propertyId, category, code) → 409 from the unique constraint (categories.store).
  const record = await createPropertyCategoryOption({
    propertyId: input.propertyId,
    categoryDefinitionId: definition.id,
    userId: input.context.userId,
    option: {
      ...option,
      sortOrder: option.sortOrder ?? (await countPropertyCategoryOptions(input.propertyId, { categoryDefinitionId: definition.id })) + 1
    }
  });
  audit({ ...input, action: "CategoryOptionCreated", entityType: "property_category_option", entityId: record.id, afterJson: record });
  return record;
}

export async function patchCategoryOption(input: BackOfficeMutationInput & {
  optionId: string;
  patch: CategoryOptionPatch;
}) {
  requirePermissions(input.context, ["categories.manage"]);
  const patch = parse(categoryOptionPatchSchema, input.patch, "body");
  await requireOrganizationProperty(input.propertyId, input.context);
  const before = await requireCategoryOption(input.propertyId, input.optionId);
  const definition = await requireCategoryDefinitionById(before.categoryDefinitionId);
  assertCategoryModeAllowsEdit(definition, patch as Record<string, unknown>);
  if (patch.parentOptionId) {
    const parent = await findPropertyCategoryOption(input.propertyId, patch.parentOptionId);
    if (!parent || parent.categoryDefinitionId !== definition.id || parent.id === before.id) {
      throw new BadRequestError("La opción superior debe pertenecer a la misma propiedad y categoría.");
    }
  }
  const option = await updatePropertyCategoryOption({ propertyId: input.propertyId, optionId: before.id, userId: input.context.userId, patch });
  audit({ ...input, action: "CategoryOptionUpdated", entityType: "property_category_option", entityId: option.id, beforeJson: before, afterJson: option });
  return option;
}

export async function setCategoryOptionActive(input: BackOfficeMutationInput & { optionId: string; active: boolean }) {
  requirePermissions(input.context, ["categories.manage"]);
  await requireOrganizationProperty(input.propertyId, input.context);
  const before = await requireCategoryOption(input.propertyId, input.optionId);
  const option = await updatePropertyCategoryOption({
    propertyId: input.propertyId,
    optionId: before.id,
    userId: input.context.userId,
    patch: { active: input.active }
  });
  audit({
    ...input,
    action: input.active ? "CategoryOptionReactivated" : "CategoryOptionDeactivated",
    entityType: "property_category_option",
    entityId: option.id,
    beforeJson: before,
    afterJson: { ...option, linkedRecordsRemainVisible: option.usageCount > 0 }
  });
  return option;
}

export async function reorderCategoryOptions(input: BackOfficeMutationInput & { categoryCode: string; optionIds: string[] }) {
  requirePermissions(input.context, ["categories.manage"]);
  const optionIds = parse(categoryOptionIdsSchema, input.optionIds, "body");
  await requireOrganizationProperty(input.propertyId, input.context);
  const definition = await requireCategoryDefinition(input.categoryCode);
  assertCategoryModeAllowsEdit(definition);
  const options = await listPropertyCategoryOptions(input.propertyId);
  const byId = new Map(options.map((option) => [option.id, option]));
  for (const optionId of optionIds) {
    const option = byId.get(optionId);
    if (!option) {
      throw new NotFoundError(`Opción de categoría no encontrada: ${optionId}`);
    }
    if (option.categoryDefinitionId !== definition.id) {
      throw new BadRequestError("No se pueden reordenar opciones fuera de la categoría seleccionada.");
    }
  }
  await updateCategoryOptionOrder(
    input.propertyId,
    input.context.userId,
    optionIds.map((id, index) => ({ id, sortOrder: index + 1 }))
  );
  const reordered = await listPropertyCategoryOptions(input.propertyId, { categoryDefinitionId: definition.id });
  audit({ ...input, action: "CategoryOptionsReordered", entityType: "category_definition", entityId: definition.id, afterJson: { optionIds } });
  return { status: "reordered" as const, options: reordered };
}

// ── Campos personalizados (Tanda L2 · L2-04: Prisma) ────────────────────────

const CUSTOM_FIELD_DATA_TYPES = ["text", "number", "boolean", "date", "datetime", "select", "multi_select", "money", "percentage", "json"] as const;

const customFieldCreateSchema = z
  .object({
    entityType: z.string().trim().min(1).max(60),
    fieldKey: z.string().trim().min(1).max(80).regex(CATEGORY_CODE_PATTERN, "clave: solo letras, números, guion, punto y guion bajo"),
    label: z.string().trim().min(1).max(200),
    description: optionalNullableText(500),
    dataType: z.enum(CUSTOM_FIELD_DATA_TYPES),
    required: z.boolean().optional(),
    searchable: z.boolean().optional(),
    visibleInList: z.boolean().optional(),
    visibleInDetail: z.boolean().optional(),
    optionsCategoryDefinitionId: optionalNullableText(64),
    validationJson: jsonRecordSchema.optional(),
    visibilityRulesJson: jsonRecordSchema.optional(),
    defaultValueJson: jsonRecordSchema.optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional()
  })
  .strict();

const customFieldPatchSchema = customFieldCreateSchema.partial().strict();

export type CustomFieldInput = z.input<typeof customFieldCreateSchema>;
export type CustomFieldPatch = z.input<typeof customFieldPatchSchema>;

const customFieldValuesSchema = z
  .array(z.object({ fieldDefinitionId: z.string().trim().min(1).max(64), valueJson: jsonRecordSchema }).strict())
  .min(1)
  .max(100);

// Authorization for this GET lives in the RBAC route manifest (custom_fields.read).
export async function listCustomFields(propertyId: string) {
  await requireProperty(propertyId);
  return { items: await listCustomFieldDefinitions(propertyId) };
}

export async function createCustomField(input: BackOfficeMutationInput & { field: CustomFieldInput }) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  const field = parse(customFieldCreateSchema, input.field, "body");
  await requireOrganizationProperty(input.propertyId, input.context);
  if (field.optionsCategoryDefinitionId) {
    await requireCategoryDefinitionById(field.optionsCategoryDefinitionId);
  }
  // Duplicate (propertyId, entityType, fieldKey) → 409 from the unique constraint (categories.store).
  const record = await createCustomFieldDefinition({
    propertyId: input.propertyId,
    field: {
      ...field,
      sortOrder: field.sortOrder ?? (await countCustomFieldDefinitions(input.propertyId)) + 1
    }
  });
  audit({ ...input, action: "CustomFieldCreated", entityType: "property_custom_field_definition", entityId: record.id, afterJson: record });
  return record;
}

export async function patchCustomField(input: BackOfficeMutationInput & { fieldId: string; patch: CustomFieldPatch }) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  const patch = parse(customFieldPatchSchema, input.patch, "body");
  await requireOrganizationProperty(input.propertyId, input.context);
  const before = await findCustomFieldDefinition(input.propertyId, input.fieldId);
  if (!before) throw new NotFoundError("Campo personalizado no encontrado.");
  if (patch.optionsCategoryDefinitionId) {
    await requireCategoryDefinitionById(patch.optionsCategoryDefinitionId);
  }
  const field = await updateCustomFieldDefinition({ propertyId: input.propertyId, fieldId: before.id, patch });
  if (!field) throw new NotFoundError("Campo personalizado no encontrado.");
  audit({ ...input, action: patch.active === false ? "CustomFieldDeactivated" : "CustomFieldUpdated", entityType: "property_custom_field_definition", entityId: field.id, beforeJson: before, afterJson: field });
  return field;
}

// Authorization for this GET lives in the RBAC route manifest (custom_fields.read).
export async function getEntityCustomFields(propertyId: string, entityType: string, entityId: string) {
  await requireProperty(propertyId);
  const [definitions, values] = await Promise.all([
    listCustomFieldDefinitions(propertyId, { entityType, active: true }),
    listCustomFieldValues(propertyId, entityType, entityId)
  ]);
  return { definitions, values };
}

export async function patchEntityCustomFields(input: BackOfficeMutationInput & {
  entityType: string;
  entityId: string;
  values: Array<{ fieldDefinitionId: string; valueJson: Record<string, unknown> }>;
}) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  const values = parse(customFieldValuesSchema, input.values, "body");
  await requireOrganizationProperty(input.propertyId, input.context);
  const definitions = await listCustomFieldDefinitions(input.propertyId, { entityType: input.entityType });
  const updated = [];
  for (const value of values) {
    const definition = definitions.find((candidate) => candidate.id === value.fieldDefinitionId);
    if (!definition) {
      throw new NotFoundError("Definición de campo personalizado no encontrada.");
    }
    updated.push(
      await upsertCustomFieldValue({
        propertyId: input.propertyId,
        entityType: input.entityType,
        entityId: input.entityId,
        fieldDefinitionId: definition.id,
        valueJson: value.valueJson
      })
    );
  }
  audit({ ...input, action: "CustomFieldUpdated", entityType: input.entityType, entityId: input.entityId, afterJson: updated });
  return { status: "updated" as const, values: updated };
}

export async function seedDefaultCategories(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["categories.manage"]);
  await requireOrganizationProperty(input.propertyId, input.context);
  const [definitions, existing] = await Promise.all([listCategoryDefinitions(), listPropertyCategoryOptions(input.propertyId)]);
  const created: PropertyCategoryOptionRecord[] = [];
  for (const definition of definitions) {
    if (definition.mode === "read_only" || existing.some((option) => option.categoryDefinitionId === definition.id)) continue;
    created.push(
      await createCategoryOption({
        ...input,
        categoryCode: definition.code,
        option: { code: "default", label: "Por defecto", isSystemDefault: true, metadataJson: { seededFromDefinition: definition.code } }
      })
    );
  }
  return { status: "seeded" as const, createdCount: created.length, created };
}

const categoryImportRowsSchema = z.array(z.record(z.string(), z.unknown())).max(5000);

export async function previewCategoryImport(input: BackOfficeMutationInput & { rows: Array<Record<string, unknown>> }) {
  requirePermissions(input.context, ["categories.import"]);
  const rows = parse(categoryImportRowsSchema, input.rows, "body");
  await requireOrganizationProperty(input.propertyId, input.context);
  const requiredColumns = ["category_code", "option_code", "label"];
  const errors: string[] = [];
  const [definitions, existing] = await Promise.all([listCategoryDefinitions(), listPropertyCategoryOptions(input.propertyId)]);
  const create = rows.filter((row) => {
    for (const column of requiredColumns) {
      if (!row[column]) errors.push(`Falta la columna ${column}`);
    }
    const definition = definitions.find((candidate) => candidate.code === row.category_code);
    return Boolean(definition && !existing.some((option) => option.categoryDefinitionId === definition.id && option.code === row.option_code));
  }).length;
  const update = rows.length - create;
  const preview = { status: errors.length ? "blocked" : "ready", create, update, skip: errors.length, errors, requiredColumns };
  audit({ ...input, action: "CategoryImportPreviewed", entityType: "category_import", afterJson: preview });
  return preview;
}

export async function applyCategoryImport(input: BackOfficeMutationInput & { rows: Array<Record<string, unknown>>; confirmationProvided?: boolean }) {
  requirePermissions(input.context, ["categories.import"]);
  if (!input.confirmationProvided) {
    return { status: "confirmation_required" as const, message: "La importación de categorías requiere previsualización y confirmación antes de aplicarse." };
  }
  const rows = parse(categoryImportRowsSchema, input.rows, "body");
  await requireOrganizationProperty(input.propertyId, input.context);
  const created: PropertyCategoryOptionRecord[] = [];
  for (const row of rows) {
    created.push(
      await createCategoryOption({
        ...input,
        categoryCode: String(row.category_code),
        option: {
          code: String(row.option_code),
          label: String(row.label),
          description: row.description ? String(row.description) : undefined,
          parentOptionId: row.parent_option_code ? String(row.parent_option_code) : undefined,
          colorToken: row.color_token ? String(row.color_token) : undefined,
          iconName: row.icon_name ? String(row.icon_name) : undefined,
          active: row.active !== false,
          sortOrder: row.sort_order ? Number(row.sort_order) : undefined
        }
      })
    );
  }
  audit({ ...input, action: "CategoryImportApplied", entityType: "category_import", afterJson: { createdCount: created.length } });
  return { status: "applied" as const, createdCount: created.length, created };
}

export async function exportCategories(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["categories.export"]);
  await requireOrganizationProperty(input.propertyId, input.context);
  const [definitions, options] = await Promise.all([listCategoryDefinitions(), listPropertyCategoryOptions(input.propertyId)]);
  const rows = options.map((option) => ({
    category_code: definitions.find((definition) => definition.id === option.categoryDefinitionId)?.code,
    option_code: option.code,
    label: option.label,
    description: option.description,
    parent_option_code: option.parentOptionId,
    color_token: option.colorToken,
    icon_name: option.iconName,
    active: option.active,
    sort_order: option.sortOrder
  }));
  audit({ ...input, action: "CategoryExported", entityType: "category_export", afterJson: { rowCount: rows.length } });
  return { format: "json", rows };
}

// Authorization for this GET lives in the RBAC route manifest (categories.read).
export function listCategoryTemplates() {
  return { items: categoryTemplates };
}

export async function previewCategoryTemplate(input: BackOfficeMutationInput & { templateCode: string }) {
  requirePermissions(input.context, ["categories.manage"]);
  await requireOrganizationProperty(input.propertyId, input.context);
  const template = categoryTemplates.find((candidate) => candidate.code === input.templateCode);
  if (!template) throw new NotFoundError("Plantilla de categorías no encontrada.");
  const options = await listPropertyCategoryOptions(input.propertyId);
  const preview = {
    template,
    willCreate: template.creates,
    willUpdate: [],
    willSkip: template.creates.filter((label) => options.some((option) => option.label.toLowerCase() === label.toLowerCase())),
    requiresConfirmation: true
  };
  audit({ ...input, action: "CategoryTemplatePreviewed", entityType: "category_template", entityId: template.code, afterJson: preview });
  return preview;
}

export async function applyCategoryTemplate(input: BackOfficeMutationInput & { templateCode: string; confirmationProvided?: boolean }) {
  requirePermissions(input.context, ["categories.manage"]);
  if (!input.confirmationProvided) {
    return { status: "confirmation_required" as const, message: "La aplicación de una plantilla de categorías requiere previsualización y confirmación." };
  }
  const preview = await previewCategoryTemplate(input);
  audit({ ...input, action: "CategoryTemplateApplied", entityType: "category_template", entityId: input.templateCode, afterJson: preview });
  return { status: "applied" as const, created: preview.willCreate, skipped: preview.willSkip };
}

export function suggestPropertyCategories(input: BackOfficeMutationInput & { prompt: string }) {
  requirePermissions(input.context, ["ai_category_setup.use"]);
  const suggestions = {
    prompt: input.prompt,
    confidence: 0.92,
    requiresReview: true,
    requiresConfirmation: true,
    willCreate: [
      { categoryCode: "room_features", label: "Sea view", code: "sea_view" },
      { categoryCode: "room_features", label: "Balcony", code: "balcony" },
      { categoryCode: "maintenance_issue_types", label: "HVAC", code: "hvac" },
      { categoryCode: "market_segments", label: "Leisure", code: "leisure" },
      { categoryCode: "pos_product_categories", label: "Minibar", code: "minibar" }
    ],
    rules: {
      aiCannotApplyWithoutConfirmation: true,
      systemControlledLegalCategoriesRequireReview: true,
      auditEventsOnApply: ["AIPropertyCategoriesSuggested", "AIPropertyCategoriesApplied"]
    }
  };
  audit({ ...input, action: "AIPropertyCategoriesSuggested", entityType: "category_ai_suggestion", afterJson: suggestions });
  return suggestions;
}

// ── Pasos de puesta en marcha (Tanda L2 · L2-04: property_setup_steps) ──────

const setupStepStatusSchema = z.enum(["not_started", "in_progress", "completed", "blocked", "needs_review"]);
const setupStepPatchSchema = z
  .object({
    stepCode: z.string().trim().min(1).max(80),
    status: setupStepStatusSchema,
    metadataJson: jsonRecordSchema.optional()
  })
  .strict();

export async function getSetupProgress(propertyId: string) {
  await requireProperty(propertyId);
  // First GET of a property materialises the catalogue as `not_started` rows (idempotent).
  await ensureSetupSteps(propertyId, SETUP_STEPS);
  const [rows, goLiveAt] = await Promise.all([listSetupSteps(propertyId, SETUP_STEPS), propertyGoLiveAt(propertyId)]);
  // Corrector L5 (L5F-06): cada paso viaja con su etiqueta (SETUP_STEP_LABELS); el front no duplica el catálogo.
  const steps = rows.map((step) => ({ ...step, label: SETUP_STEP_LABELS[step.stepCode] ?? step.stepCode }));
  const completed = steps.filter((step) => step.status === "completed").length;
  return {
    propertyId,
    steps,
    completed,
    total: steps.length,
    progressPercent: steps.length === 0 ? 0 : Math.round((completed / steps.length) * 100),
    // Tanda L5 (lote C): la propiedad está en vivo cuando approveGoLive escribió go_live_at.
    live: goLiveAt !== null,
    goLiveAt
  };
}

/** ISO de properties.go_live_at (Tanda L5 · lote C), null sin aprobar. */
async function propertyGoLiveAt(propertyId: string): Promise<string | null> {
  const row = await prisma.property.findUnique({ where: { id: propertyId }, select: { goLiveAt: true } });
  return row?.goLiveAt ? row.goLiveAt.toISOString() : null;
}

export async function updateSetupStep(input: BackOfficeMutationInput & {
  stepCode: string;
  status: PropertySetupStepRecord["status"];
  metadataJson?: Record<string, unknown>;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const body = parse(setupStepPatchSchema, { stepCode: input.stepCode, status: input.status, metadataJson: input.metadataJson }, "body");
  if (!SETUP_STEPS.includes(body.stepCode)) {
    throw new NotFoundError(`Paso de puesta en marcha desconocido: ${body.stepCode}`);
  }
  await requireOrganizationProperty(input.propertyId, input.context);
  const existing = await findSetupStep(input.propertyId, body.stepCode);
  const before = existing ? { ...existing } : undefined;
  const completed = body.status === "completed";
  const record = await upsertSetupStep(input.propertyId, body.stepCode, {
    status: body.status,
    completedAt: completed ? new Date() : existing?.completedAt ? new Date(existing.completedAt) : null,
    completedBy: completed ? input.context.userId : (existing?.completedBy ?? null),
    metadataJson: body.metadataJson ?? existing?.metadataJson ?? {}
  });
  audit({ ...input, action: "PropertySetupStepUpdated", entityType: "property_setup_step", entityId: record.id, beforeJson: before, afterJson: record });
  return record;
}

/** Filas persistidas de la propiedad en el orden canónico (createdAt = orden de los upserts). */
async function loadReadinessRows(propertyId: string): Promise<PropertyReadinessCheckRecord[]> {
  const rows = await prisma.propertyReadinessCheck.findMany({
    where: { propertyId },
    orderBy: [{ createdAt: "asc" }, { checkCode: "asc" }],
    take: 500
  });
  return rows.map(mapReadinessCheckRow);
}

export type PropertyReadinessResponse = {
  propertyId: string;
  /** `ready` solo con comprobaciones calculadas (> 0) y ninguna bloqueante pendiente. */
  status: "ready" | "blocked";
  blockingCount: number;
  checks: PropertyReadinessCheckRecord[];
  /** Instante del último cálculo persistido (máximo updatedAt), ISO 8601. */
  computedAt: string | null;
  /** properties.go_live_at (ISO) cuando la salida en vivo ya está aprobada. */
  goLiveAt: string | null;
};

function buildReadinessResponse(propertyId: string, checks: PropertyReadinessCheckRecord[], goLiveAt: string | null): PropertyReadinessResponse {
  const blocking = checks.filter((check) => check.severity === "blocking" && check.status !== "pass");
  return {
    propertyId,
    // A property with no computed checks is not "ready": its readiness is simply unknown.
    status: checks.length === 0 || blocking.length > 0 ? "blocked" : "ready",
    blockingCount: blocking.length,
    checks,
    computedAt: readinessComputedAt(checks),
    goLiveAt
  };
}

/**
 * Tanda L5 (lote C): readiness REAL en el GET. Prisma es la única fuente (Tanda L2 ·
 * L2-04); si no hay filas o la más reciente supera la ventana de frescura
 * (READINESS_MAX_AGE_MS) se evalúa y persiste de nuevo — sin auditar, la auditoría
 * es de la recalculación explícita y del go-live — y se devuelve lo persistido.
 * Un segundo GET dentro de la ventana no toca la base de datos y repite `computedAt`.
 */
export async function getReadiness(propertyId: string): Promise<PropertyReadinessResponse> {
  await requireProperty(propertyId);
  let checks = await loadReadinessRows(propertyId);
  if (isReadinessStale(checks, new Date())) {
    await persistReadiness(propertyId, await evaluateReadiness(propertyId));
    checks = await loadReadinessRows(propertyId);
  }
  return buildReadinessResponse(propertyId, checks, await propertyGoLiveAt(propertyId));
}

/** Recalculación explícita (POST …/readiness/recalculate): evalúa, persiste, audita y devuelve el GET. */
export async function recalculateReadiness(input: BackOfficeMutationInput): Promise<PropertyReadinessResponse> {
  requirePermissions(input.context, ["property.configure"]);
  await requireOrganizationProperty(input.propertyId, input.context);
  await recalculateAndAudit(input);
  return await getReadiness(input.propertyId);
}

/** evaluate + persist + audit PropertyReadinessRecalculated (recalculate y go-live). */
async function recalculateAndAudit(input: BackOfficeMutationInput): Promise<PropertyReadinessCheckRecord[]> {
  const records = await persistReadiness(input.propertyId, await evaluateReadiness(input.propertyId));
  audit({ ...input, action: "PropertyReadinessRecalculated", entityType: "property", entityId: input.propertyId, afterJson: records });
  return records;
}

// ── Applicability of SES.HOSPEDAJES / VeriFactu (Tanda 3 closure) ───────────
// A flag nobody switched on must not hide an obligation the hotel is already
// meeting in practice: an establishment that has sent partes to the MIR, or has
// issued invoices, is subject to the checks whatever the flag says.

/** SES usage window: submissions created within the last N days count as "in use". */
export const SES_USAGE_WINDOW_DAYS = 180;

export type ComplianceApplicability = {
  /** The obligation's checks apply (flag on OR real usage). */
  applies: boolean;
  byFlag: boolean;
  byUsage: boolean;
  usageCount: number;
  /**
   * Set only when the obligation applies by usage with the flag OFF, e.g.
   * "activo por uso: 3 envíos; SES.HOSPEDAJES está desactivado en los ajustes del establecimiento".
   * Appended to every check message of that obligation so the operator sees why it applies.
   * Cocoa 22 · ola 11 (qa#14): the note names the product switch in Spanish, never the flag.
   */
  usageNote: string | null;
};

/**
 * Pure rule: applies = flagEnabled || usageCount > 0. `usageLabel` is the plural noun of
 * the usage evidence ("envíos", "facturas emitidas"); `switchLabel` is what the hotelier
 * reads for the switch ("SES.HOSPEDAJES", "VeriFactu", "el módulo de facturación y
 * cumplimiento"); `windowLabel` (optional) qualifies the count ("últimos 180 días")
 * without breaking the canonical note text.
 */
export function resolveComplianceApplicability(input: {
  flagEnabled: boolean;
  usageCount: number;
  switchLabel: string;
  usageLabel: string;
  windowLabel?: string;
}): ComplianceApplicability {
  const byFlag = input.flagEnabled === true;
  const usageCount = Number.isFinite(input.usageCount) && input.usageCount > 0 ? Math.floor(input.usageCount) : 0;
  const byUsage = usageCount > 0;
  const usageNote =
    byUsage && !byFlag
      ? `activo por uso: ${usageCount} ${input.usageLabel}; ${input.switchLabel} está desactivado en los ajustes del establecimiento${input.windowLabel ? ` (${input.windowLabel})` : ""}`
      : null;
  return { applies: byFlag || byUsage, byFlag, byUsage, usageCount, usageNote };
}

/** Appends the usage note (when any) to a check message: "<message> Nota: <note>." */
export function withUsageNote(message: string, applicability: ComplianceApplicability): string {
  return applicability.usageNote ? `${message} Nota: ${applicability.usageNote}.` : message;
}

/**
 * Tanda L5 (lote C): EVALÚA las 17 comprobaciones de puesta en marcha de la propiedad —
 * solo lecturas, sin escribir ni auditar. Los códigos y los textos son los de siempre
 * (apps/admin-web readiness-message.test.mts y compliance-closure.test.mts los fijan).
 * `persistReadiness` los guarda; el GET (ventana de frescura), la recalculación
 * explícita y el go-live combinan ambos.
 */
async function evaluateReadiness(propertyId: string): Promise<ReadinessCheckInput[]> {
  const property = await requireProperty(propertyId);
  // Module state: hydrate the mirror from Prisma before reading it (empty for Prisma-only hotels at boot).
  await listPropertyModules(propertyId);
  const modules = enabledModuleCodes(propertyId);
  // Room-type and sellable-room checks read Prisma (source of truth): the demoStore mirrors are
  // hydrated lazily (room types after a /room-types call, rooms never), which made the result
  // depend on the order of previous calls and blocked go-live for Prisma-only hotels.
  const [roomTypeCount, sellableRoomCount] = await Promise.all([
    prisma.roomType.count({ where: { propertyId, active: true } }),
    // Room.roomTypeId is non-nullable in Prisma, so active + sellable already implies a room type.
    prisma.room.count({ where: { propertyId, active: true, sellable: true } })
  ]);
  // Fase 0 (Opción A): el check default_building_exists lee de Prisma (fuente de verdad).
  const hasActiveBuilding = (await prisma.building.count({ where: { propertyId, active: true } })) > 0;
  // Compliance and admin-user checks read Prisma (CFG-P0-1): the demoStore mirrors only
  // hold seed data (or users of whichever property was listed last), which made the SES
  // check pass trivially and the admin check misleading for real hotels.
  const complianceSettings = (await resolveComplianceSettings(propertyId)).settings;
  // Tanda L5 · integrador (INT-L5-03): the T8a route POST /rbac/assignments writes
  // user_role_assignments only (the user_property_roles mirror is written by the
  // invite, tenant-admin and onboarding bootstrap flows), so a hotel whose staff was
  // assigned through the RBAC screen could never pass this check. Both sources count:
  // the legacy mirror and the live (non-revoked) property-scoped assignments.
  const [mirrorRows, liveAssignments] = await Promise.all([
    prisma.userPropertyRole.findMany({ where: { propertyId }, select: { userId: true } }),
    prisma.userRoleAssignment.findMany({ where: { propertyId, scopeType: "property", revokedAt: null }, select: { userId: true } })
  ]);
  const assignedUserIds = Array.from(new Set([...mirrorRows, ...liveAssignments].map((assignment) => assignment.userId)));
  const hasAdminUser =
    assignedUserIds.length > 0 &&
    (await prisma.user.count({
      where: { id: { in: assignedUserIds }, organizationId: property.organizationId, status: "active" }
    })) > 0;
  // Tanda 3 ("cumplimiento sin atrezzo"): every fiscal fact comes from Prisma or the real
  // environment — no in-memory mirrors, no flags nobody writes. Each check carries a
  // relatedEntityType/Id so the UI can deep-link to the form that fixes it.
  const sesUsageSince = new Date(Date.now() - SES_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [legalIdentity, fiscalColumns, complianceRow, activeSequences, connectedIntegrations, sesSubmissionCount, issuedInvoiceCount] =
    await Promise.all([
      // Tanda 6b (R2): the issuer identity is the legal entity's (single reader), never Property.legalName.
      resolveLegalIdentity(property.organizationId),
      propertyFiscalColumns(propertyId),
      prisma.propertyComplianceSetting.findUnique({
        where: { propertyId },
        select: { ipsiOrdinanceConfirmedAt: true, sesRegistryNumber: true }
      }),
      prisma.invoiceSequence.findMany({
        where: { propertyId, active: true },
        select: { sequenceCode: true, prefix: true, year: true, invoiceType: true }
      }),
      prisma.integrationConnection.findMany({ where: { propertyId, status: "connected" }, select: { providerId: true } }),
      // Real usage (any status: a queued or rejected parte is still an obligation in flight).
      prisma.sesHospedajesSubmission.count({ where: { propertyId, createdAt: { gte: sesUsageSince } } }),
      // Issued, cancelled and rectified invoices all exist in the fiscal chain; drafts do not.
      prisma.invoice.count({ where: { propertyId, status: { in: ["issued", "cancelled", "rectified"] } } })
    ]);
  const paymentProviderConnected = await paymentProviderConnectedFor(propertyId, connectedIntegrations.map((row) => row.providerId));

  // Applicability = flag OR real usage (resolveComplianceApplicability, unit-tested). When
  // it applies by usage only, every check of that obligation carries the note.
  const sesApplicability = resolveComplianceApplicability({
    flagEnabled: Boolean(complianceSettings?.sesHospedajesEnabled || property.sesHospedajesEnabled),
    usageCount: sesSubmissionCount,
    switchLabel: "SES.HOSPEDAJES",
    usageLabel: "envíos",
    windowLabel: `últimos ${SES_USAGE_WINDOW_DAYS} días`
  });
  const verifactuApplicability = resolveComplianceApplicability({
    flagEnabled: Boolean(complianceSettings?.verifactuEnabled || property.verifactuEnabled),
    usageCount: issuedInvoiceCount,
    switchLabel: "VeriFactu",
    usageLabel: "facturas emitidas"
  });
  // Billing series (Tanda 4 · H3a): a property that already issues invoices is
  // subject to the series check whatever the module flag says (Faranda: module
  // off, 25 invoices with verifactu_hash). Same rule as SES "activo por uso".
  const billingApplicability = resolveComplianceApplicability({
    flagEnabled: modules.includes("compliance_billing"),
    usageCount: issuedInvoiceCount,
    switchLabel: "el módulo de facturación y cumplimiento",
    usageLabel: "facturas emitidas"
  });
  const sesEnabled = sesApplicability.applies;
  const verifactuEnabled = verifactuApplicability.applies;
  const verifactuMode = integrationModeFromEnv(process.env.VERIFACTU_MODE);
  const sesMode = integrationModeFromEnv(process.env.SES_HOSPEDAJES_MODE);
  const verifactuCert = certificateEnvStatus(process.env.VERIFACTU_CERT_PATH, process.env.VERIFACTU_CERT_PASSPHRASE);
  const sesCert = certificateEnvStatus(process.env.SES_HOSPEDAJES_CERT_PATH, process.env.SES_HOSPEDAJES_CERT_PASSPHRASE);

  // Issuer identity (Tanda 6b, R2): the legal entity is the single source of the NIF and the razón
  // social; a tenant without backfilled entity resolves to the deprecated Organization columns
  // through resolveLegalIdentity (source organization_fallback). Property.legalName is never read.
  const issuerTaxId = normalizeTaxId(legalIdentity?.taxId);
  const issuerTaxIdValid = isValidSpanishTaxId(issuerTaxId);
  const issuerLegalName = (legalIdentity?.legalName ?? "").trim();
  const legalEntityRef = legalIdentity?.legalEntityId
    ? ({ relatedEntityType: "legal_entity", relatedEntityId: legalIdentity.legalEntityId } as const)
    : ({ relatedEntityType: "organization", relatedEntityId: property.organizationId } as const);

  // Fiscal address (SES establishment block + invoice header).
  const addressMissing = (
    [
      ["address", property.address],
      ["municipality", property.municipality],
      ["province", property.province],
      ["postalCode", fiscalColumns.postalCode]
    ] as Array<[string, string | null | undefined]>
  )
    .filter(([, value]) => !hasText(value))
    .map(([key]) => key);
  const fiscalAddressRequired = sesEnabled || verifactuEnabled;
  // Why the address is mandatory, in this check's own words (Tanda 4 · H3b): the
  // SES/VeriFactu "activo por uso" notes belong to their own checks and used to be
  // appended here twice, even on a passing address.
  const fiscalAddressReasons = [
    sesApplicability.applies
      ? sesApplicability.byFlag
        ? "SES.HOSPEDAJES activado"
        : `SES.HOSPEDAJES en uso (${sesApplicability.usageCount} envíos en los últimos ${SES_USAGE_WINDOW_DAYS} días)`
      : null,
    verifactuApplicability.applies
      ? verifactuApplicability.byFlag
        ? "VeriFactu activado"
        : `VeriFactu en uso (${verifactuApplicability.usageCount} facturas emitidas)`
      : null
  ].filter((reason): reason is string => reason !== null);

  // Tax region + statutory rates actually provisioned (contract C: never UNKNOWN, but a
  // property is only "configured" when its region is explicit and the rates exist in DB).
  const taxProfile = await getPropertyTaxProfile(propertyId);
  const requiredCategories: TaxCategory[] = ["accommodation", "food_beverage", "general_services"];
  const provisionedCategories = new Set(taxProfile.rates.filter((rate) => rate.source !== "catalog").map((rate) => rate.category));
  const missingCategories = requiredCategories.filter((category) => !provisionedCategories.has(category));
  const taxRegionExplicit = taxProfile.taxRegion !== null && taxProfile.regionSource !== "default";
  const taxRegionConfigured = taxRegionExplicit && missingCategories.length === 0;
  const isIpsiRegion = taxProfile.taxRegion === "ES_CEUTA" || taxProfile.taxRegion === "ES_MELILLA";
  const ipsiConfirmed = Boolean(complianceRow?.ipsiOrdinanceConfirmedAt ?? taxProfile.ipsiOrdinanceConfirmedAt);

  // Series of the current fiscal year (FISC-09): the allocator opens FAC-<year> lazily on the
  // first issue, so a missing row is a warning, not a blocker.
  const currentYear = madridYear();
  const hasCurrentYearSeries = activeSequences.some(
    (sequence) =>
      (sequence.year ?? sequenceYearFromPrefix(sequence.prefix)) === currentYear &&
      (sequence.sequenceCode.toUpperCase() === "FAC" || /^F/.test(sequence.invoiceType))
  );

  // SES establishment profile (contract F) and VeriFactu software declaration (contract E).
  const sesEstablishment = sesEnabled ? await resolveSesEstablishment(propertyId) : null;
  const software = verifactuEnabled ? resolveVerifactuSoftware() : null;
  const verifactuRealMode = verifactuEnabled && verifactuMode !== "sandbox";
  const sesRealMode = sesEnabled && sesMode !== "sandbox";

  const propertyRef = { relatedEntityType: "property", relatedEntityId: property.id } as const;
  const organizationRef = { relatedEntityType: "organization", relatedEntityId: property.organizationId } as const;
  const complianceRef = { relatedEntityType: "property_compliance_settings", relatedEntityId: complianceSettings?.id } as const;
  const envRef = { relatedEntityType: "env", relatedEntityId: undefined } as const;

  const checks: ReadinessCheckInput[] = [
    {
      checkCode: "issuer_legal_name_set",
      status: issuerLegalName ? "pass" : "fail",
      severity: "blocking",
      message: issuerLegalName
        ? `Razón social del emisor (sociedad): ${issuerLegalName}.`
        : "Falta la razón social de la sociedad emisora (Configuración › Estructura societaria › Datos fiscales).",
      ...legalEntityRef
    },
    {
      checkCode: "issuer_tax_id_valid",
      status: issuerTaxIdValid ? "pass" : "fail",
      severity: "blocking",
      message: issuerTaxIdValid
        ? `NIF/CIF de la sociedad emisora válido (${issuerTaxId}).`
        : issuerTaxId
          ? `El NIF/CIF de la sociedad emisora (${issuerTaxId}) no supera la validación (letra/dígito de control): ${spanishTaxIdValidationMessage(issuerTaxId) ?? ""}`.trim()
          : "Falta el NIF/CIF de la sociedad emisora (Configuración › Estructura societaria › Datos fiscales). El NIF del emisor es un valor provisional; sustitúyelo por el NIF real antes de emitir facturas: en producción la emisión se bloquea.",
      ...legalEntityRef
    },
    {
      checkCode: "property_fiscal_address_complete",
      status: addressMissing.length === 0 ? "pass" : fiscalAddressRequired ? "fail" : "warning",
      severity: fiscalAddressRequired ? "blocking" : "warning",
      message:
        addressMissing.length === 0
          ? "Dirección fiscal completa (dirección, municipio, provincia y código postal)."
          : `Dirección fiscal incompleta: faltan ${addressMissing.map((key) => FISCAL_ADDRESS_FIELD_LABELS[key] ?? key).join(", ")}. ${fiscalAddressRequired ? `Obligatoria: ${fiscalAddressReasons.join(" y ")}.` : "Necesaria antes de activar SES.HOSPEDAJES o VeriFactu."}`,
      ...propertyRef
    },
    {
      checkCode: "timezone_configured",
      status: hasText(property.timezone) ? "pass" : "fail",
      severity: "blocking",
      message: hasText(property.timezone) ? `Zona horaria: ${property.timezone}.` : "Falta la zona horaria del establecimiento (cierre nocturno y fechas fiscales).",
      ...propertyRef
    },
    {
      checkCode: "tax_region_configured",
      status: taxRegionConfigured ? "pass" : "fail",
      severity: "blocking",
      message: taxRegionConfigured
        ? `Región fiscal ${taxRegionName(taxProfile.taxRegion)} (${taxProfile.figure}) con tipos vigentes para alojamiento, restauración y servicios.`
        : !taxRegionExplicit
          ? `Región fiscal sin configurar (${taxProfile.taxRegion ? `derivada por defecto: ${taxRegionName(taxProfile.taxRegion)}` : "desconocida"}): elige Península y Baleares, Canarias, Ceuta o Melilla en el perfil del establecimiento.${taxProfile.warnings.length > 0 ? ` ${taxProfile.warnings.join(" ")}` : ""}`
          : `Faltan tipos vigentes en la base de datos para ${missingCategories.join(", ")} (región ${taxRegionName(taxProfile.taxRegion)}): guarda el perfil o pulsa «Provisionar impuestos».`,
      ...propertyRef
    },
    {
      checkCode: "ipsi_ordinance_confirmed",
      status: !isIpsiRegion || ipsiConfirmed ? "pass" : "fail",
      severity: isIpsiRegion ? "blocking" : "info",
      message: !isIpsiRegion
        ? "No aplica: el IPSI solo rige en Ceuta y Melilla."
        : ipsiConfirmed
          ? "Tipos del IPSI confirmados contra la ordenanza municipal vigente."
          : "Los tipos del IPSI cambian por ordenanza anual: confirma en Cumplimiento › Fiscal que los tipos aplicados coinciden con la ordenanza vigente.",
      ...complianceRef
    },
    {
      checkCode: "default_building_exists",
      status: hasActiveBuilding ? "pass" : "fail",
      severity: "blocking",
      message: hasActiveBuilding ? "Existe al menos un edificio activo." : "Se necesita al menos un edificio (o edificio por defecto).",
      ...propertyRef
    },
    {
      checkCode: "room_type_exists",
      status: roomTypeCount > 0 ? "pass" : "fail",
      severity: "blocking",
      message: roomTypeCount > 0 ? `${roomTypeCount} tipo(s) de habitación activos.` : "Se necesita al menos un tipo de habitación activo.",
      ...propertyRef
    },
    {
      checkCode: "sellable_room_exists",
      status: sellableRoomCount > 0 ? "pass" : "fail",
      severity: "blocking",
      message: sellableRoomCount > 0 ? `${sellableRoomCount} habitación(es) vendibles activas.` : "Se necesita al menos una habitación activa y vendible con tipo asignado.",
      ...propertyRef
    },
    {
      checkCode: "admin_user_exists",
      status: hasAdminUser ? "pass" : "fail",
      severity: "blocking",
      message: hasAdminUser ? "Hay al menos un usuario activo asignado al establecimiento." : "Se necesita al menos un usuario activo (administrador o gerente) asignado al establecimiento.",
      ...propertyRef
    },
    {
      checkCode: "invoice_sequence_configured",
      // Applies by module flag OR by real usage. With series but none for the
      // current year the allocator opens FAC-<year> lazily (FISC-09), so that is
      // a warning (non-blocking), not a failure; no active series at all fails.
      status: !billingApplicability.applies ? "pass" : activeSequences.length === 0 ? "fail" : hasCurrentYearSeries ? "pass" : "warning",
      severity: billingApplicability.applies && activeSequences.length > 0 && !hasCurrentYearSeries ? "warning" : "blocking",
      message: withUsageNote(
        !billingApplicability.applies
          ? "No aplica: el módulo de facturación y cumplimiento no está activado y el establecimiento no ha emitido facturas."
          : activeSequences.length === 0
            ? `Se necesita al menos una serie de facturación activa (FAC): ${billingApplicability.byFlag ? "el módulo de facturación está activado" : "el establecimiento ya emite facturas"}.`
            : `Series de facturación activas: ${activeSequences.map((sequence) => `${sequence.sequenceCode}${sequence.year ? `/${sequence.year}` : ""}`).join(", ")}${hasCurrentYearSeries ? ` (incluye el ejercicio ${currentYear})` : `; ninguna del ejercicio ${currentYear}: se abrirá FAC-${currentYear} en la primera emisión`}.`,
        billingApplicability
      ),
      relatedEntityType: "invoice_sequence",
      relatedEntityId: undefined
    },
    {
      checkCode: "invoice_series_current_year",
      status: hasCurrentYearSeries ? "pass" : "warning",
      severity: "warning",
      message: hasCurrentYearSeries
        ? `Serie de facturas completas del ejercicio ${currentYear} disponible.`
        : `No hay serie FAC del ejercicio ${currentYear}: se abrirá automáticamente (FAC-${currentYear}-000001) en la primera emisión del año; créala antes si quieres fijar prefijo o numeración.`,
      relatedEntityType: "invoice_sequence",
      relatedEntityId: undefined
    },
    {
      checkCode: "payment_provider_connected",
      status: !modules.includes("payment_vault") || paymentProviderConnected ? "pass" : "fail",
      severity: "blocking",
      message: !modules.includes("payment_vault")
        ? "No aplica: el módulo Payment Vault no está activado."
        : paymentProviderConnected
          ? "Pasarela de pago conectada."
          : "Se necesita una pasarela de pago conectada con el módulo Payment Vault activado.",
      relatedEntityType: "integration_connection",
      relatedEntityId: undefined
    },
    {
      checkCode: "ses_establishment_profile",
      status: !sesEnabled ? "pass" : sesEstablishment?.ok ? "pass" : "fail",
      severity: sesEnabled ? "blocking" : "info",
      message: withUsageNote(
        !sesEnabled
          ? "No aplica: SES.HOSPEDAJES desactivado para este establecimiento y sin envíos en los últimos 180 días."
          : sesEstablishment?.ok
            ? `Datos del establecimiento para SES.HOSPEDAJES completos (registro ${sesEstablishment.establishment.registryNumber}, INE ${sesEstablishment.establishment.municipalityCode}).`
            : `Datos del establecimiento incompletos para SES.HOSPEDAJES (nunca se envían valores por defecto): ${(sesEstablishment?.missing ?? []).map(describeSesEstablishmentIssue).join(" ")}`,
        sesApplicability
      ),
      ...propertyRef
    },
    {
      checkCode: "ses_hospedajes_credentials",
      status: !sesEnabled ? "pass" : sesRealMode && sesCert.configured && sesCert.exists ? "pass" : "fail",
      severity: sesEnabled ? "blocking" : "info",
      message: withUsageNote(
        !sesEnabled
          ? "No aplica: SES.HOSPEDAJES desactivado para este establecimiento y sin envíos en los últimos 180 días."
          : !sesRealMode
            ? "SES.HOSPEDAJES en modo de pruebas: los partes van a un simulador, no al Ministerio del Interior. Configura el modo de preproducción o producción con certificado antes de la puesta en marcha."
            : !sesCert.configured
              ? `SES.HOSPEDAJES en ${integrationModePhrase(sesMode)} sin certificado configurado: ${sesCert.reason}.`
              : !sesCert.exists
                ? "La ruta del certificado de SES.HOSPEDAJES no existe."
                : `SES.HOSPEDAJES en ${integrationModePhrase(sesMode)} con certificado configurado.`,
        sesApplicability
      ),
      ...envRef
    },
    {
      checkCode: "verifactu_software_declared",
      status: !verifactuEnabled ? "pass" : software?.ok ? "pass" : verifactuRealMode ? "fail" : "warning",
      severity: verifactuRealMode ? "blocking" : verifactuEnabled ? "warning" : "info",
      message: withUsageNote(
        !verifactuEnabled
          ? "No aplica: VeriFactu desactivado para este establecimiento y sin facturas emitidas."
          : software?.ok
            ? `Declaración del sistema informático de VeriFactu completa (${software.software.nombreRazon} · NIF ${software.software.nif} · ${software.software.nombreSistema} ${software.software.version}).`
            : `Declaración del sistema informático de VeriFactu incompleta (${(software?.errors ?? []).join("; ")}). ${verifactuRealMode ? "Bloquea el envío real a la AEAT." : "En pruebas se envía con valores provisionales."}`,
        verifactuApplicability
      ),
      ...envRef
    },
    {
      checkCode: "platform_certificate_notice",
      status: verifactuCert.configured || sesCert.configured ? "warning" : "pass",
      severity: "info",
      message:
        verifactuCert.configured || sesCert.configured
          ? "El certificado configurado (VeriFactu / SES.HOSPEDAJES) es de la plataforma, no del hotel: cada obligado tributario debe firmar con su propio certificado antes de emitir en producción."
          : "Certificado de plataforma no configurado (VeriFactu / SES.HOSPEDAJES): los envíos a la AEAT y al Ministerio del Interior se firman con una firma de pruebas, válida solo en modo de pruebas.",
      ...envRef
    }
  ];

  return checks;
}

/**
 * PERSISTE las comprobaciones evaluadas (Tanda L5 · lote C): upserts secuenciales para
 * conservar el orden canónico (getReadiness ordena por createdAt) y borrado de los
 * códigos retirados (legal_profile_complete se dividió en checks atómicos) para que una
 * fila «fail» antigua no bloquee el go-live para siempre. Sin auditoría: la ponen la
 * recalculación explícita y el go-live. Dos GET simultáneos (banner + checklist) pueden
 * crear la misma fila a la vez: la colisión de clave única se reintenta como update.
 */
async function persistReadiness(propertyId: string, checks: readonly ReadinessCheckInput[]): Promise<PropertyReadinessCheckRecord[]> {
  const records: PropertyReadinessCheckRecord[] = [];
  for (const check of checks) {
    try {
      records.push(await upsertReadinessCheck(propertyId, check));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      records.push(await upsertReadinessCheck(propertyId, check));
    }
  }
  const currentCodes = checks.map((check) => check.checkCode);
  await prisma.propertyReadinessCheck.deleteMany({ where: { propertyId, checkCode: { notIn: currentCodes } } });
  return records;
}

/** Prisma P2002 (unique constraint) sin depender de la clase de error del cliente. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

type ReadinessCheckInput = Omit<PropertyReadinessCheckRecord, "id" | "propertyId" | "createdAt" | "updatedAt">;

type IntegrationEnvMode = "sandbox" | "preproduction" | "production";

function integrationModeFromEnv(raw: string | undefined): IntegrationEnvMode {
  return raw === "production" || raw === "preproduction" ? raw : "sandbox";
}

// Cocoa 22 · ola 11 (qa#14): readiness messages read in Spanish at the source —
// no environment variable names, no «sandbox» / «stub», no English field keys,
// no region codes. The front (lib/format readinessMessage) only normalises.
const INTEGRATION_MODE_PHRASES: Record<IntegrationEnvMode, string> = {
  sandbox: "modo de pruebas",
  preproduction: "modo de preproducción",
  production: "modo de producción"
};

/** integrationModePhrase("preproduction") → "modo de preproducción". */
export function integrationModePhrase(mode: IntegrationEnvMode): string {
  return INTEGRATION_MODE_PHRASES[mode];
}

/** Fiscal address keys of Property / propertyFiscalColumns → what the hotelier reads. */
export const FISCAL_ADDRESS_FIELD_LABELS: Record<string, string> = {
  address: "dirección",
  municipality: "municipio",
  province: "provincia",
  postalCode: "código postal",
  country: "país"
};

/** taxRegionName("ES_CANARIAS") → "Canarias"; an unknown code is returned as-is. */
export function taxRegionName(code: string | null | undefined): string {
  if (!code) return "desconocida";
  const option = TAX_REGION_OPTIONS.find((candidate) => candidate.value === code);
  return option ? option.label.replace(/ \([^)]*\)$/, "") : code;
}

/** Same rule as compliance-health.service checkCert: placeholder / blank env = not configured. */
function certificateEnvStatus(pathEnv: string | undefined, passEnv: string | undefined): { configured: boolean; exists: boolean; reason?: string } {
  const placeholder = (value: string | undefined) => !value || value === "change-me";
  if (placeholder(pathEnv)) return { configured: false, exists: false, reason: "falta la ruta del certificado" };
  if (placeholder(passEnv)) return { configured: false, exists: false, reason: "falta la contraseña del certificado" };
  return { configured: true, exists: existsSync(pathEnv!) };
}

/**
 * Payment gateway connected: Prisma first (integration_connections/providers/categories);
 * the in-memory seed connection (iconn_mock_payments of prop_123) is only a fallback for
 * the seed-only property, never for a real hotel.
 */
async function paymentProviderConnectedFor(propertyId: string, connectedProviderIds: string[]): Promise<boolean> {
  if (connectedProviderIds.length > 0) {
    const providers = await prisma.integrationProvider.findMany({
      where: { id: { in: connectedProviderIds } },
      select: { code: true, categoryId: true }
    });
    if (providers.some((provider) => provider.code.toLowerCase().includes("payment"))) return true;
    const categoryIds = providers.map((provider) => provider.categoryId);
    if (categoryIds.length > 0) {
      const categories = await prisma.integrationCategory.findMany({ where: { id: { in: categoryIds } }, select: { code: true } });
      if (categories.some((category) => category.code.toLowerCase().includes("payment"))) return true;
    }
  }
  if (propertyId !== demoStore.property.id) return false;
  return demoStore.integrationConnections.some((connection) => {
    const provider = demoStore.integrationProviders.find((candidate) => candidate.id === connection.providerId);
    return connection.propertyId === propertyId && connection.status === "connected" && Boolean(provider?.code.includes("payments"));
  });
}

export type GoLiveApprovalResult =
  | { status: "blocked"; propertyId: string; blockers: PropertyReadinessCheckRecord[]; goLiveAt: string | null }
  | {
      status: "approved";
      propertyId: string;
      approvedAt: string;
      goLiveAt: string;
      /** true cuando la propiedad ya estaba en vivo: no se escribe ni se emite un nuevo evento. */
      alreadyLive: boolean;
      /** Paso `go_live` de property_setup_steps (completado en esta llamada o antes). */
      step: PropertySetupStepRecord | null;
    };

/**
 * Tanda L5 (lote C): la aprobación de la salida en vivo CAMBIA ESTADO. Decide sobre
 * comprobaciones recién calculadas (evaluate + persist + audit PropertyReadinessRecalculated):
 * una propiedad nueva no tiene filas y unas filas viejas no deben aprobarla ni bloquearla.
 *   · bloqueada → { status: "blocked", blockers, goLiveAt } sin escribir nada;
 *   · ya en vivo (properties.go_live_at) → { status: "approved", alreadyLive: true } sin evento nuevo;
 *   · lista → en UNA transacción escribe go_live_at (solo si sigue NULL: dos aprobaciones
 *     simultáneas no producen dos eventos) y completa el paso `go_live`; después audita y
 *     emite PropertyGoLiveApproved con { goLiveAt }.
 */
export async function approveGoLive(input: BackOfficeMutationInput): Promise<GoLiveApprovalResult> {
  requirePermissions(input.context, ["property.go_live"]);
  await requireOrganizationProperty(input.propertyId, input.context);
  const records = await recalculateAndAudit(input);
  const blockers = records.filter((check) => check.severity === "blocking" && check.status !== "pass");
  const current = await propertyGoLiveAt(input.propertyId);
  if (records.length === 0 || blockers.length > 0) {
    return { status: "blocked", propertyId: input.propertyId, blockers, goLiveAt: current };
  }
  if (current !== null) {
    return {
      status: "approved",
      propertyId: input.propertyId,
      approvedAt: current,
      goLiveAt: current,
      alreadyLive: true,
      step: await findSetupStep(input.propertyId, "go_live")
    };
  }

  const approvedAt = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    // Optimistic guard: only the first approval writes; a concurrent one sees count 0.
    const written = await tx.property.updateMany({ where: { id: input.propertyId, goLiveAt: null }, data: { goLiveAt: approvedAt } });
    if (written.count !== 1) return null;
    await ensureSetupSteps(input.propertyId, SETUP_STEPS, tx);
    const step = await upsertSetupStep(
      input.propertyId,
      "go_live",
      {
        status: "completed",
        completedAt: approvedAt,
        completedBy: input.context.userId,
        metadataJson: { approvedAt: approvedAt.toISOString(), approvedBy: input.context.userId, correlationId: input.correlationId }
      },
      tx
    );
    return step;
  });
  if (outcome === null) {
    // Lost the race against another approval: report it as already live, no second event.
    const goLiveAt = (await propertyGoLiveAt(input.propertyId)) ?? approvedAt.toISOString();
    return { status: "approved", propertyId: input.propertyId, approvedAt: goLiveAt, goLiveAt, alreadyLive: true, step: await findSetupStep(input.propertyId, "go_live") };
  }

  const goLiveAt = approvedAt.toISOString();
  audit({
    ...input,
    action: "PropertyGoLiveApproved",
    entityType: "property",
    entityId: input.propertyId,
    beforeJson: { goLiveAt: null },
    afterJson: { goLiveAt, setupStep: outcome }
  });
  domain({ ...input, eventType: "PropertyGoLiveApproved", entityType: "property", entityId: input.propertyId, payload: { goLiveAt } });
  return { status: "approved", propertyId: input.propertyId, approvedAt: goLiveAt, goLiveAt, alreadyLive: false, step: outcome };
}

export async function getPropertyMap(propertyId: string) {
  await requireProperty(propertyId);
  // Fase 0 (Opción A): Prisma-only para la estructura de propiedad. buildings/floors/
  // zones/spaces y rooms se sirven directamente desde Prisma (sembrados en seed.ts y
  // persistidos por createX/bulkCreateRooms), de modo que el mapa sobrevive al reinicio
  // sin depender del seed in-memory. assets/mapPositions siguen en demoStore (fuera
  // de alcance). Ver docs/strategy/.../PERSIST-BACKOFFICE.md.
  const [pBuildings, pFloors, pZones, pSpaces, pRooms, property] = await Promise.all([
    prisma.building.findMany({ where: { propertyId } }),
    prisma.floor.findMany({ where: { propertyId } }),
    prisma.propertyZone.findMany({ where: { propertyId } }),
    prisma.propertySpace.findMany({ where: { propertyId } }),
    prisma.room.findMany({ where: { propertyId } }),
    // Persistencia tanda 2: el perfil editado (nombre/dirección/región fiscal) se
    // confirma desde Prisma; fallback al seed in-memory para properties sin fila.
    resolveProperty(propertyId)
  ]);
  const normalizeDates = <T extends Record<string, unknown>>(rows: Array<Record<string, unknown>>): T[] =>
    rows.map((row) => ({
      ...row,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
    })) as unknown as T[];
  const buildings = normalizeDates<BuildingRecord>(pBuildings as Array<Record<string, unknown>>);
  const floors = normalizeDates<FloorRecord>(pFloors as Array<Record<string, unknown>>);
  const zones = normalizeDates<PropertyZoneRecord>(pZones as Array<Record<string, unknown>>);
  const spaces = normalizeDates<PropertySpaceRecord>(pSpaces as Array<Record<string, unknown>>);
  const rooms = pRooms.map(mapRoomRow);
  return {
    property,
    buildings,
    floors,
    zones,
    spaces,
    rooms,
    assets: demoStore.assets.filter((asset) => asset.propertyId === propertyId),
    mapPositions: demoStore.propertyMapPositions.filter((position) => position.propertyId === propertyId),
    tree: buildings.map((building) => ({
      ...building,
      floors: floors
        .filter((floor) => floor.buildingId === building.id)
        .map((floor) => ({
          ...floor,
          zones: zones
            .filter((zone) => zone.floorId === floor.id)
            .map((zone) => ({
              ...zone,
              rooms: rooms.filter((room) => room.zoneId === zone.id),
              spaces: spaces.filter((space) => space.zoneId === zone.id)
            }))
        }))
    }))
  };
}

export async function createBuilding(input: BackOfficeMutationInput & {
  building: Pick<BuildingRecord, "name"> & Partial<BuildingRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const timestamp = nowIso();
  const record: BuildingRecord = {
    id: createId("bld"),
    propertyId: input.propertyId,
    name: input.building.name,
    code: input.building.code,
    description: input.building.description,
    sortOrder: input.building.sortOrder ?? demoStore.buildings.length + 1,
    active: input.building.active ?? true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  // Fase 0 (Opción A): Prisma-only. getPropertyMap y demás lectores leen de Prisma,
  // así que ya no se mantiene la copia en demoStore.buildings.
  await prisma.building.create({
    data: { id: record.id, propertyId: record.propertyId, name: record.name, code: record.code ?? null, description: record.description ?? null, sortOrder: record.sortOrder, active: record.active }
  });
  audit({ ...input, action: "BuildingCreated", entityType: "building", entityId: record.id, afterJson: record });
  return record;
}

export async function createFloor(input: BackOfficeMutationInput & {
  floor: Pick<FloorRecord, "name"> & Partial<FloorRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  await resolveMapReferences(input.propertyId, { buildingId: input.floor.buildingId });
  const timestamp = nowIso();
  const record: FloorRecord = {
    id: createId("floor"),
    propertyId: input.propertyId,
    buildingId: input.floor.buildingId,
    name: input.floor.name,
    floorNumber: input.floor.floorNumber,
    code: input.floor.code,
    sortOrder: input.floor.sortOrder ?? input.floor.floorNumber ?? demoStore.floors.length + 1,
    active: input.floor.active ?? true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  // Fase 0 (Opción A): Prisma-only.
  await prisma.floor.create({
    data: { id: record.id, propertyId: record.propertyId, buildingId: record.buildingId ?? null, name: record.name, floorNumber: record.floorNumber ?? null, code: record.code ?? null, sortOrder: record.sortOrder, active: record.active }
  });
  audit({ ...input, action: "FloorCreated", entityType: "floor", entityId: record.id, afterJson: record });
  return record;
}

export async function createZone(input: BackOfficeMutationInput & {
  zone: Pick<PropertyZoneRecord, "name" | "zoneType"> & Partial<PropertyZoneRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  await resolveMapReferences(input.propertyId, { buildingId: input.zone.buildingId, floorId: input.zone.floorId });
  const timestamp = nowIso();
  const record: PropertyZoneRecord = {
    id: createId("zone"),
    propertyId: input.propertyId,
    buildingId: input.zone.buildingId,
    floorId: input.zone.floorId,
    name: input.zone.name,
    code: input.zone.code,
    zoneType: input.zone.zoneType,
    description: input.zone.description,
    sortOrder: input.zone.sortOrder ?? demoStore.propertyZones.length + 1,
    active: input.zone.active ?? true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  // Fase 0 (Opción A): Prisma-only.
  await prisma.propertyZone.create({
    data: { id: record.id, propertyId: record.propertyId, buildingId: record.buildingId ?? null, floorId: record.floorId ?? null, name: record.name, code: record.code ?? null, zoneType: record.zoneType, description: record.description ?? null, sortOrder: record.sortOrder, active: record.active }
  });
  audit({ ...input, action: "ZoneCreated", entityType: "property_zone", entityId: record.id, afterJson: record });
  return record;
}

export async function createSpace(input: BackOfficeMutationInput & {
  space: Pick<PropertySpaceRecord, "name" | "spaceType"> & Partial<PropertySpaceRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  await resolveMapReferences(input.propertyId, { buildingId: input.space.buildingId, floorId: input.space.floorId, zoneId: input.space.zoneId });
  const timestamp = nowIso();
  const record: PropertySpaceRecord = {
    id: createId("space"),
    propertyId: input.propertyId,
    buildingId: input.space.buildingId,
    floorId: input.space.floorId,
    zoneId: input.space.zoneId,
    name: input.space.name,
    code: input.space.code,
    spaceType: input.space.spaceType,
    description: input.space.description,
    active: input.space.active ?? true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  // Fase 0 (Opción A): Prisma-only.
  await prisma.propertySpace.create({
    data: { id: record.id, propertyId: record.propertyId, buildingId: record.buildingId ?? null, floorId: record.floorId ?? null, zoneId: record.zoneId ?? null, name: record.name, code: record.code ?? null, spaceType: record.spaceType, description: record.description ?? null, active: record.active }
  });
  audit({ ...input, action: "SpaceCreated", entityType: "property_space", entityId: record.id, afterJson: record });
  return record;
}

/** @deprecated L2: sin ruta (L2-02 retira map-positions). */
export function upsertMapPosition(input: BackOfficeMutationInput & {
  position: Pick<PropertyMapPositionRecord, "entityType" | "entityId" | "x" | "y"> & Partial<PropertyMapPositionRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  let position = demoStore.propertyMapPositions.find(
    (candidate) =>
      candidate.propertyId === input.propertyId &&
      candidate.entityType === input.position.entityType &&
      candidate.entityId === input.position.entityId &&
      candidate.floorId === input.position.floorId
  );
  const before = position ? { ...position } : undefined;
  if (!position) {
    position = {
      id: createId("pos"),
      propertyId: input.propertyId,
      entityType: input.position.entityType,
      entityId: input.position.entityId,
      floorId: input.position.floorId,
      x: input.position.x,
      y: input.position.y,
      width: input.position.width,
      height: input.position.height,
      rotation: input.position.rotation,
      metadataJson: input.position.metadataJson ?? {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    demoStore.propertyMapPositions.push(position);
  } else {
    Object.assign(position, input.position, { updatedAt: nowIso() });
  }

  audit({
    ...input,
    action: before ? "PropertyMapPositionUpdated" : "PropertyMapPositionCreated",
    entityType: "property_map_position",
    entityId: position.id,
    beforeJson: before,
    afterJson: position
  });
  return position;
}

function roomNumberFromRange(start: string, offset: number): string {
  const startNumber = Number(start);
  if (Number.isNaN(startNumber)) {
    throw new BadRequestError("roomRangeStart debe ser numérico para crear un rango de habitaciones.");
  }
  return String(startNumber + offset);
}

export async function bulkCreateRooms(input: BackOfficeMutationInput & {
  roomTypeId: string;
  roomRangeStart?: string;
  roomRangeEnd?: string;
  roomNumbers?: string[];
  buildingId?: string;
  floorId?: string;
  zoneId?: string;
  sellable?: boolean;
  active?: boolean;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const sellable = input.sellable ?? true;
  if (sellable && !input.roomTypeId) {
    throw new BadRequestError("Las habitaciones vendibles deben tener un tipo de habitación.");
  }
  // Fase 0 (Opción A): Room.roomTypeId es NOT NULL en Prisma. Las rooms no vendibles
  // del demo igualmente traen roomTypeId; si faltara, fallaría el create. No lo
  // inventamos: lo validamos explícito para dar un error claro en vez de un 500 de Prisma.
  if (!input.roomTypeId) {
    throw new BadRequestError("Se requiere un tipo de habitación para crear habitaciones.");
  }

  const roomNumbers =
    input.roomNumbers ??
    (input.roomRangeStart && input.roomRangeEnd
      ? Array.from({ length: Number(input.roomRangeEnd) - Number(input.roomRangeStart) + 1 }, (_, index) =>
          roomNumberFromRange(input.roomRangeStart!, index)
        )
      : []);

  if (roomNumbers.length === 0) {
    throw new BadRequestError("Se requiere al menos un número de habitación.");
  }

  // Unicidad por (propertyId, number) contra Prisma (fuente de verdad).
  const existingRows = await prisma.room.findMany({
    where: { propertyId: input.propertyId, number: { in: roomNumbers } },
    select: { number: true }
  });
  const duplicates = existingRows.map((row) => row.number);
  if (duplicates.length > 0) {
    throw new ConflictError(`El número de habitación debe ser único por propiedad: ${duplicates.join(", ")}`);
  }

  await requireRoomType(input.propertyId, input.roomTypeId);
  const { floorName } = await resolveMapReferences(input.propertyId, {
    buildingId: input.buildingId,
    floorId: input.floorId,
    zoneId: input.zoneId
  });

  const created: RoomRecord[] = [];
  for (const number of roomNumbers) {
    // Prisma genera el id (cuid). Se escribe a Prisma y se espeja en demoStore.rooms
    // porque housekeeping/maintenance/assets/pms leen ese mirror en memoria de forma
    // síncrona (mismo patrón que pms.service.ts createRoom -> mirrorRoom).
    const row = await prisma.room.create({
      data: {
        propertyId: input.propertyId,
        roomTypeId: input.roomTypeId,
        buildingId: input.buildingId ?? null,
        floorId: input.floorId ?? null,
        zoneId: input.zoneId ?? null,
        number,
        floor: floorName,
        roomCode: `RM${number}`,
        displayName: `Room ${number}`,
        status: "clean",
        housekeepingStatus: "clean",
        maintenanceStatus: "ok",
        sellable,
        active: input.active ?? true,
        sortOrder: Number(number) || 0
      }
    });
    const record = mapRoomRow(row);
    const idx = demoStore.rooms.findIndex((r) => r.id === record.id);
    if (idx >= 0) demoStore.rooms[idx] = record;
    else demoStore.rooms.push(record);
    created.push(record);
  }

  audit({ ...input, action: "RoomBulkCreated", entityType: "room", afterJson: { createdCount: created.length, rooms: created } });
  return { status: "created" as const, createdCount: created.length, rooms: created };
}

export async function bulkUpdateRooms(input: BackOfficeMutationInput & {
  roomIds: string[];
  patch: Partial<Pick<RoomRecord, "roomTypeId" | "buildingId" | "floorId" | "zoneId" | "sellable" | "active" | "featuresJson" | "bedConfigurationJson" | "housekeepingStatus" | "maintenanceStatus">>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  // Fase 0 (Opción A): rooms desde Prisma (fuente de verdad) en vez de demoStore.
  const existingRows = await prisma.room.findMany({ where: { propertyId: input.propertyId, id: { in: input.roomIds } } });
  if (existingRows.length !== input.roomIds.length) {
    throw new BadRequestError("Todas las habitaciones seleccionadas deben pertenecer a la propiedad.");
  }
  const before = existingRows.map(mapRoomRow);
  if (input.patch.sellable === true && !input.patch.roomTypeId && before.some((room) => !room.roomTypeId)) {
    throw new BadRequestError("Una habitación no puede marcarse como vendible sin un tipo de habitación asignado.");
  }
  if (input.patch.roomTypeId) {
    await requireRoomType(input.propertyId, input.patch.roomTypeId);
  }
  await resolveMapReferences(input.propertyId, { zoneId: input.patch.zoneId });
  if (input.patch.buildingId) {
    const building = await prisma.building.findFirst({ where: { id: input.patch.buildingId, propertyId: input.propertyId } });
    if (!building?.active) {
      throw new BadRequestError("La habitación no puede asignarse a una planta o edificio desactivados.");
    }
  }
  if (input.patch.floorId) {
    const floor = await prisma.floor.findFirst({ where: { id: input.patch.floorId, propertyId: input.propertyId } });
    if (!floor?.active) {
      throw new BadRequestError("La habitación no puede asignarse a una planta o edificio desactivados.");
    }
  }

  // Tanda L5 (lote A → C): vocabulario cerrado del estado unificado. La limpieza NUNCA se
  // escribe a mano: pasa por applyRoomTransition (mark_clean / mark_dirty / mark_inspected),
  // idempotente, auditada como ROOM_STATE_CHANGED y respetuosa con la ocupación / OOO en
  // `status`. El mantenimiento admite ok | needs_attention; `blocked` (y su liberación)
  // solo los escribe una orden de trabajo (maintenance.service).
  const housekeepingEvent = bulkHousekeepingEvent(input.patch.housekeepingStatus);
  const maintenanceStatus = bulkMaintenanceStatus(input.patch.maintenanceStatus);
  if (maintenanceStatus !== undefined) {
    const blocked = existingRows.filter((room) => room.maintenanceStatus === "blocked");
    if (blocked.length > 0) {
      throw new ConflictError(
        `Habitación bloqueada por una orden de trabajo: ${blocked.map((room) => room.number).join(", ")}. Resuelve la orden para liberarla; el estado de mantenimiento no se cambia a mano.`,
        { code: "ROOM_MAINTENANCE_BLOCKED", roomIds: blocked.map((room) => room.id) }
      );
    }
  }
  if (housekeepingEvent) {
    // Pre-check every transition (pure) so a rejected room never leaves the batch half applied.
    const notClean = existingRows.filter((room) => !nextRoomState(snapshotOf(room), housekeepingEvent).ok);
    if (notClean.length > 0) {
      throw new ConflictError("Solo se pueden inspeccionar habitaciones limpias.", {
        code: "ROOM_NOT_CLEAN",
        roomIds: notClean.map((room) => room.id),
        roomNumbers: notClean.map((room) => room.number)
      });
    }
  }

  // Solo los campos presentes en el patch (todos columnas de Room). Prisma omite los
  // `undefined`, así que el patch parcial se traduce 1:1. Los JSON van casteados para
  // encajar con InputJsonValue (RoomRecord los tipa como Record<string, unknown>).
  const data = {
    roomTypeId: input.patch.roomTypeId,
    buildingId: input.patch.buildingId,
    floorId: input.patch.floorId,
    zoneId: input.patch.zoneId,
    sellable: input.patch.sellable,
    active: input.patch.active,
    featuresJson: input.patch.featuresJson as Prisma.InputJsonValue | undefined,
    bedConfigurationJson: input.patch.bedConfigurationJson as Prisma.InputJsonValue | undefined,
    maintenanceStatus
  };
  const hasColumnPatch = Object.values(data).some((value) => value !== undefined);

  // Corrector L5 (OP-09): todo el lote en UNA transacción — un conflicto optimista
  // (ROOM_STATE_CHANGED_MEANWHILE) a mitad ya no deja el bulk PATCH a medias — y los
  // eventos de estado se emiten solo tras el commit (OP-03).
  const { updatedRows, transitions } = await prisma.$transaction(async (tx) => {
    const updatedRows: typeof existingRows = [];
    const transitions: ApplyRoomTransitionResult[] = [];
    for (const id of input.roomIds) {
      let updatedRow = hasColumnPatch ? await tx.room.update({ where: { id }, data }) : existingRows.find((room) => room.id === id)!;
      if (housekeepingEvent) {
        const transition = await applyRoomTransition({
          db: tx,
          roomId: id,
          event: housekeepingEvent,
          context: input.context,
          correlationId: input.correlationId,
          reason: `bulk-rooms ${input.patch.housekeepingStatus}`
        });
        transitions.push(transition);
        updatedRow = transition.room;
      }
      updatedRows.push(updatedRow);
    }
    return { updatedRows, transitions };
  });
  emitRoomStateEvents(...transitions);
  const rooms: RoomRecord[] = [];
  for (const updatedRow of updatedRows) {
    const record = mapRoomRow(updatedRow);
    const idx = demoStore.rooms.findIndex((r) => r.id === record.id);
    if (idx >= 0) demoStore.rooms[idx] = record;
    else demoStore.rooms.push(record);
    rooms.push(record);
  }

  audit({
    ...input,
    action: "RoomBulkUpdated",
    entityType: "room",
    beforeJson: before,
    afterJson: rooms
  });
  return { status: "updated" as const, updatedCount: rooms.length, rooms };
}

/** Evento de limpieza del bulk PATCH (Tanda L5): clean | dirty | inspected; otro texto → 400 en español. */
function bulkHousekeepingEvent(raw: unknown): RoomStateEvent | undefined {
  if (raw === undefined) return undefined;
  if (!isHousekeepingStatus(raw)) {
    throw new BadRequestError(`Estado de limpieza no válido: usa ${HOUSEKEEPING_STATUSES.join(", ")}.`);
  }
  const events: Record<HousekeepingStatus, RoomStateEvent> = { clean: "mark_clean", dirty: "mark_dirty", inspected: "mark_inspected" };
  return events[raw];
}

/** Estado de mantenimiento del bulk PATCH (Tanda L5): ok | needs_attention; `blocked` exige una orden de trabajo. */
function bulkMaintenanceStatus(raw: unknown): Exclude<MaintenanceStatus, "blocked"> | undefined {
  if (raw === undefined) return undefined;
  if (raw === "blocked") {
    throw new BadRequestError("Para bloquear una habitación usa una orden de trabajo (Mantenimiento › Partes); el bloqueo no se escribe a mano.");
  }
  if (raw !== "ok" && raw !== "needs_attention") {
    throw new BadRequestError(`Estado de mantenimiento no válido: usa ${MAINTENANCE_STATUSES.filter((status) => status !== "blocked").join(" o ")}.`);
  }
  return raw;
}

/** @deprecated L2: sin ruta (L2-02 retira GET …/map/export). */
export function exportPropertyMap(propertyId: string) {
  return demoStore.rooms
    .filter((room) => room.propertyId === propertyId)
    .map((room) => ({
      building: demoStore.buildings.find((building) => building.id === room.buildingId)?.name,
      floor: demoStore.floors.find((floor) => floor.id === room.floorId)?.name ?? room.floor,
      zone: demoStore.propertyZones.find((zone) => zone.id === room.zoneId)?.name,
      room_number: room.number,
      room_type: demoStore.roomTypes.find((roomType) => roomType.id === room.roomTypeId)?.code,
      max_occupancy: room.maxOccupancy,
      standard_occupancy: room.standardOccupancy,
      beds: room.bedConfigurationJson,
      features: room.featuresJson,
      sellable: room.sellable,
      active: room.active !== false,
      housekeeping_status: room.housekeepingStatus,
      maintenance_status: room.maintenanceStatus,
      square_meters: room.squareMeters,
      view_type: room.viewType,
      accessibility: room.accessibilityJson
    }));
}

export async function listBackOfficeRoomTypes(propertyId: string) {
  // Persistencia tanda 2: la lista lee Prisma (fuente durable) y se une con los
  // room types que solo existan en el seed in-memory; el espejo se refresca para
  // los lectores legacy síncronos (export/preview/proposals).
  const [rows, roomRows, reservationRows] = await Promise.all([
    prisma.roomType.findMany({ where: { propertyId }, orderBy: [{ displayOrder: "asc" }, { code: "asc" }] }),
    prisma.room.findMany({ where: { propertyId }, select: { roomTypeId: true } }),
    prisma.reservation.findMany({ where: { propertyId, status: { not: "cancelled" } }, select: { roomTypeId: true } })
  ]);
  const mapped = rows.map(mapRoomTypeRow);
  for (const roomType of mapped) mirrorRecord(demoStore.roomTypes, roomType);
  const merged = mergeById(mapped, demoStore.roomTypes.filter((roomType) => roomType.propertyId === propertyId));
  return merged.map((roomType) => ({
    ...roomType,
    linkedRoomCount:
      roomRows.filter((room) => room.roomTypeId === roomType.id).length ||
      demoStore.rooms.filter((room) => room.roomTypeId === roomType.id).length,
    futureReservationCount:
      reservationRows.filter((reservation) => reservation.roomTypeId === roomType.id).length ||
      demoStore.reservations.filter((reservation) => reservation.roomTypeId === roomType.id && reservation.status !== "cancelled").length
  }));
}

export async function createBackOfficeRoomType(input: BackOfficeMutationInput & {
  roomType: Pick<RoomTypeRecord, "name" | "code" | "maxOccupancy" | "baseCapacity"> & Partial<RoomTypeRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const duplicateInPrisma = await prisma.roomType.findUnique({
    where: { propertyId_code: { propertyId: input.propertyId, code: input.roomType.code } },
    select: { id: true }
  });
  if (duplicateInPrisma || demoStore.roomTypes.some((roomType) => roomType.propertyId === input.propertyId && roomType.code === input.roomType.code)) {
    throw new ConflictError("El código del tipo de habitación debe ser único por propiedad.");
  }
  const record: RoomTypeRecord = {
    id: createId("rt"),
    propertyId: input.propertyId,
    name: input.roomType.name,
    code: input.roomType.code,
    maxOccupancy: input.roomType.maxOccupancy,
    baseCapacity: input.roomType.baseCapacity,
    description: input.roomType.description,
    defaultBedConfigurationJson: input.roomType.defaultBedConfigurationJson ?? {},
    defaultAmenitiesJson: input.roomType.defaultAmenitiesJson ?? {},
    defaultPhotosJson: input.roomType.defaultPhotosJson ?? {},
    defaultRateCategory: input.roomType.defaultRateCategory,
    sellable: input.roomType.sellable ?? true,
    displayOrder: input.roomType.displayOrder ?? demoStore.roomTypes.length + 1,
    active: input.roomType.active ?? true
  };
  // Persistencia tanda 2: Prisma primero (mismo id), después espejo demoStore.
  await prisma.roomType.create({
    data: {
      id: record.id,
      propertyId: record.propertyId,
      name: record.name,
      code: record.code,
      maxOccupancy: record.maxOccupancy,
      baseCapacity: record.baseCapacity,
      description: record.description ?? null,
      defaultBedConfigurationJson: asJson(record.defaultBedConfigurationJson),
      defaultAmenitiesJson: asJson(record.defaultAmenitiesJson),
      defaultPhotosJson: asJson(record.defaultPhotosJson),
      defaultRateCategory: record.defaultRateCategory ?? null,
      sellable: record.sellable ?? true,
      displayOrder: record.displayOrder ?? 0,
      active: record.active ?? true
    }
  });
  demoStore.roomTypes.push(record);
  audit({ ...input, action: "RoomTypeCreated", entityType: "room_type", entityId: record.id, afterJson: record });
  return record;
}

// Persistencia tanda 2: Prisma primero; fallback al espejo para room types que solo
// existan en el seed in-memory (se persistirán en su primera edición vía upsert).
// Acotado a la propiedad: un id de otra propiedad se trata como inexistente.
async function requireRoomType(propertyId: string, roomTypeId: string): Promise<RoomTypeRecord> {
  const row = await prisma.roomType.findFirst({ where: { id: roomTypeId, propertyId } });
  if (row) return mirrorRecord(demoStore.roomTypes, mapRoomTypeRow(row));
  const roomType = demoStore.roomTypes.find((candidate) => candidate.id === roomTypeId && candidate.propertyId === propertyId);
  if (!roomType) {
    throw new NotFoundError("Room type was not found.");
  }
  return roomType;
}

/** Upsert por id desde el shape en memoria: crea la fila si el registro venía del seed in-memory. */
async function persistRoomType(record: RoomTypeRecord): Promise<RoomTypeRecord> {
  const data = {
    propertyId: record.propertyId,
    name: record.name,
    code: record.code,
    maxOccupancy: record.maxOccupancy,
    baseCapacity: record.baseCapacity,
    description: record.description ?? null,
    defaultBedConfigurationJson: asJson(record.defaultBedConfigurationJson),
    defaultAmenitiesJson: asJson(record.defaultAmenitiesJson),
    defaultPhotosJson: asJson(record.defaultPhotosJson),
    defaultRateCategory: record.defaultRateCategory ?? null,
    sellable: record.sellable ?? true,
    displayOrder: record.displayOrder ?? 0,
    active: record.active ?? true
  };
  const row = await prisma.roomType.upsert({
    where: { id: record.id },
    update: data,
    create: { id: record.id, ...data }
  });
  return mapRoomTypeRow(row);
}

export async function patchBackOfficeRoomType(input: BackOfficeMutationInput & {
  roomTypeId: string;
  patch: Partial<RoomTypeRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const roomType = await requireRoomType(input.propertyId, input.roomTypeId);
  if (input.patch.maxOccupancy !== undefined) {
    // Valida contra Prisma (reservas persistidas) y contra el espejo legacy.
    const reservationRows = await prisma.reservation.findMany({
      where: { propertyId: input.propertyId, roomTypeId: input.roomTypeId, status: { not: "cancelled" } },
      select: { adults: true, children: true }
    });
    const conflictingReservation =
      reservationRows.some((reservation) => reservation.adults + reservation.children > input.patch.maxOccupancy!) ||
      demoStore.reservations.some(
        (reservation) =>
          reservation.propertyId === input.propertyId &&
          reservation.roomTypeId === input.roomTypeId &&
          reservation.status !== "cancelled" &&
          reservation.adults + reservation.children > input.patch.maxOccupancy!
      );
    if (conflictingReservation) {
      throw new ConflictError("La nueva ocupación máxima entra en conflicto con reservas futuras del tipo de habitación.");
    }
  }
  const before = { ...roomType };
  // Prisma primero: el id y propertyId no son parcheables (evita divergencia con el espejo).
  const { id: _ignoredId, propertyId: _ignoredPropertyId, ...patch } = input.patch;
  const persisted = await persistRoomType({ ...roomType, ...patch, id: roomType.id, propertyId: roomType.propertyId });
  Object.assign(roomType, persisted);
  audit({ ...input, action: "RoomTypeUpdated", entityType: "room_type", entityId: roomType.id, beforeJson: before, afterJson: roomType });
  return roomType;
}

export async function deactivateBackOfficeRoomType(input: BackOfficeMutationInput & { roomTypeId: string }) {
  requirePermissions(input.context, ["property.map.manage"]);
  const roomType = await requireRoomType(input.propertyId, input.roomTypeId);
  const before = { ...roomType };
  const persisted = await persistRoomType({ ...roomType, active: false });
  Object.assign(roomType, persisted);
  audit({ ...input, action: "RoomTypeDeactivated", entityType: "room_type", entityId: roomType.id, beforeJson: before, afterJson: roomType });
  return roomType;
}

export async function mergeBackOfficeRoomTypes(input: BackOfficeMutationInput & {
  sourceRoomTypeId: string;
  targetRoomTypeId: string;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const source = await requireRoomType(input.propertyId, input.sourceRoomTypeId);
  const target = await requireRoomType(input.propertyId, input.targetRoomTypeId);
  if (source.id === target.id) {
    throw new BadRequestError("Los tipos de habitación origen y destino deben ser distintos.");
  }
  const before = {
    source: { ...source },
    rooms: demoStore.rooms.filter((room) => room.roomTypeId === source.id).map((room) => ({ ...room })),
    reservations: demoStore.reservations.filter((reservation) => reservation.roomTypeId === source.id).map((reservation) => ({ ...reservation }))
  };
  // Prisma primero: reasignación persistida de rooms y reservas + desactivación del origen.
  await prisma.room.updateMany({ where: { propertyId: input.propertyId, roomTypeId: source.id }, data: { roomTypeId: target.id } });
  await prisma.reservation.updateMany({ where: { propertyId: input.propertyId, roomTypeId: source.id }, data: { roomTypeId: target.id } });
  const persistedSource = await persistRoomType({ ...source, active: false });
  // Espejo demoStore (lectores legacy síncronos).
  for (const room of demoStore.rooms.filter((candidate) => candidate.roomTypeId === source.id)) {
    room.roomTypeId = target.id;
  }
  for (const reservation of demoStore.reservations.filter((candidate) => candidate.roomTypeId === source.id)) {
    reservation.roomTypeId = target.id;
  }
  Object.assign(source, persistedSource);
  audit({ ...input, action: "RoomTypeMerged", entityType: "room_type", entityId: source.id, beforeJson: before, afterJson: { source, target } });
  return { status: "merged" as const, source, target };
}

export async function listRoomsForRoomType(propertyId: string, roomTypeId: string) {
  // Persistencia tanda 2: rooms viven en Prisma (Fase 0); la lista confirma merges/altas.
  const rows = await prisma.room.findMany({ where: { roomTypeId, propertyId } });
  const mapped = rows.map(mapRoomRow);
  return mergeById(
    mapped,
    demoStore.rooms.filter((room) => room.roomTypeId === roomTypeId && room.propertyId === propertyId)
  );
}

export async function listRoomFeatures(propertyId: string) {
  const rows = await prisma.roomFeature.findMany({ where: { propertyId } });
  const mapped = rows.map(mapRoomFeatureRow);
  for (const feature of mapped) mirrorRecord(demoStore.roomFeatures, feature);
  return mergeById(mapped, demoStore.roomFeatures.filter((feature) => feature.propertyId === propertyId));
}

export async function createRoomFeature(input: BackOfficeMutationInput & {
  feature: Pick<RoomFeatureRecord, "code" | "name"> & Partial<RoomFeatureRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const duplicateInPrisma = await prisma.roomFeature.findUnique({
    where: { propertyId_code: { propertyId: input.propertyId, code: input.feature.code } },
    select: { id: true }
  });
  if (duplicateInPrisma || demoStore.roomFeatures.some((feature) => feature.propertyId === input.propertyId && feature.code === input.feature.code)) {
    throw new ConflictError("El código de la característica de habitación debe ser único por propiedad.");
  }
  const record: RoomFeatureRecord = {
    id: createId("rf"),
    propertyId: input.propertyId,
    code: input.feature.code,
    name: input.feature.name,
    category: input.feature.category,
    active: input.feature.active ?? true
  };
  // Persistencia tanda 2: Prisma primero (mismo id), después espejo.
  await prisma.roomFeature.create({
    data: { id: record.id, propertyId: record.propertyId, code: record.code, name: record.name, category: record.category ?? null, active: record.active }
  });
  demoStore.roomFeatures.push(record);
  audit({ ...input, action: "RoomFeatureCreated", entityType: "room_feature", entityId: record.id, afterJson: record });
  return record;
}

export async function listBedTypes(propertyId: string) {
  const rows = await prisma.bedType.findMany({ where: { propertyId } });
  const mapped = rows.map(mapBedTypeRow);
  for (const bedType of mapped) mirrorRecord(demoStore.bedTypes, bedType);
  return mergeById(mapped, demoStore.bedTypes.filter((bedType) => bedType.propertyId === propertyId));
}

export async function createBedType(input: BackOfficeMutationInput & {
  bedType: Pick<BedTypeRecord, "code" | "name"> & Partial<BedTypeRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const duplicateInPrisma = await prisma.bedType.findUnique({
    where: { propertyId_code: { propertyId: input.propertyId, code: input.bedType.code } },
    select: { id: true }
  });
  if (duplicateInPrisma || demoStore.bedTypes.some((bedType) => bedType.propertyId === input.propertyId && bedType.code === input.bedType.code)) {
    throw new ConflictError("El código del tipo de cama debe ser único por propiedad.");
  }
  const record: BedTypeRecord = {
    id: createId("bed"),
    propertyId: input.propertyId,
    code: input.bedType.code,
    name: input.bedType.name,
    capacity: input.bedType.capacity ?? 1,
    active: input.bedType.active ?? true
  };
  // Persistencia tanda 2: Prisma primero (mismo id), después espejo.
  await prisma.bedType.create({
    data: { id: record.id, propertyId: record.propertyId, code: record.code, name: record.name, capacity: record.capacity, active: record.active }
  });
  demoStore.bedTypes.push(record);
  audit({ ...input, action: "BedTypeCreated", entityType: "bed_type", entityId: record.id, afterJson: record });
  return record;
}

/** @deprecated L2: sin ruta (L2-02 retira map/imports). */
export function previewPropertyMapImport(input: BackOfficeMutationInput & { rows: PropertyMapImportRow[] }) {
  requirePermissions(input.context, ["property.import"]);
  const errors: string[] = [];
  const warnings: string[] = [];
  const knownRoomTypes = new Set(demoStore.roomTypes.filter((roomType) => roomType.propertyId === input.propertyId).map((roomType) => roomType.code));
  const existingRoomNumbers = new Set(demoStore.rooms.filter((room) => room.propertyId === input.propertyId).map((room) => room.number));

  input.rows.forEach((row, index) => {
    if (!row.roomNumber) {
      errors.push(`Row ${index + 1}: room_number is required.`);
    }
    if (row.roomNumber && existingRoomNumbers.has(row.roomNumber)) {
      errors.push(`Row ${index + 1}: room ${row.roomNumber} already exists.`);
    }
    if (row.roomType && !knownRoomTypes.has(row.roomType)) {
      warnings.push(`Row ${index + 1}: room type ${row.roomType} will be created if confirmed.`);
    }
  });

  const importRecord: PropertyImportRecord = {
    id: createId("import"),
    propertyId: input.propertyId,
    importType: "property_map",
    status: errors.length > 0 ? "failed" : "previewed",
    previewJson: {
      rows: input.rows,
      createCount: input.rows.length,
      warnings
    },
    errorJson: { errors },
    createdBy: input.context.userId,
    createdAt: nowIso()
  };
  demoStore.propertyImports.push(importRecord);
  audit({ ...input, action: "PropertyImportPreviewed", entityType: "property_import", entityId: importRecord.id, afterJson: importRecord });
  return importRecord;
}

/** @deprecated L2: sin ruta (L2-02 retira map/imports/:importId/commit). */
export async function commitPropertyMapImport(input: BackOfficeMutationInput & { importId: string; createUnknownReferences?: boolean }) {
  requirePermissions(input.context, ["property.import"]);
  const importRecord = demoStore.propertyImports.find((candidate) => candidate.id === input.importId && candidate.propertyId === input.propertyId);
  if (!importRecord) {
    throw new NotFoundError("Importación no encontrada.");
  }
  if (importRecord.status !== "previewed") {
    throw new ConflictError("Solo se pueden confirmar importaciones previsualizadas.");
  }

  const rows = (importRecord.previewJson.rows ?? []) as PropertyMapImportRow[];
  const roomTypeByCode = new Map(demoStore.roomTypes.filter((roomType) => roomType.propertyId === input.propertyId).map((roomType) => [roomType.code, roomType]));
  const createdRooms: RoomRecord[] = [];
  for (const row of rows) {
    if (!row.roomNumber) {
      throw new BadRequestError("La importación contiene una fila sin número de habitación.");
    }
    let roomType = row.roomType ? roomTypeByCode.get(row.roomType) : undefined;
    if (!roomType && row.roomType && input.createUnknownReferences) {
      roomType = {
        id: createId("rt"),
        propertyId: input.propertyId,
        name: row.roomType,
        code: row.roomType,
        maxOccupancy: row.maxOccupancy ?? 2,
        baseCapacity: row.standardOccupancy ?? 2,
        description: "Created from Back Office import",
        active: true,
        sellable: true
      };
      demoStore.roomTypes.push(roomType);
      roomTypeByCode.set(row.roomType, roomType);
    }
    if (!roomType) {
      throw new BadRequestError(`Tipo de habitación desconocido: ${row.roomType ?? "sin indicar"}.`);
    }
    const created = await bulkCreateRooms({
      context: input.context,
      propertyId: input.propertyId,
      correlationId: input.correlationId,
      roomTypeId: roomType.id,
      roomNumbers: [row.roomNumber],
      sellable: row.sellable ?? true,
      active: row.active ?? true
    });
    createdRooms.push(...created.rooms);
  }

  const before = { ...importRecord };
  importRecord.status = "committed";
  importRecord.committedAt = nowIso();
  audit({ ...input, action: "PropertyImportCommitted", entityType: "property_import", entityId: importRecord.id, beforeJson: before, afterJson: importRecord });
  return { status: "committed" as const, import: importRecord, createdRooms };
}

/** @deprecated L2: sin ruta (L2-02 retira map/imports/:importId). */
export function getPropertyImport(propertyId: string, importId: string) {
  return demoStore.propertyImports.find((candidate) => candidate.propertyId === propertyId && candidate.id === importId);
}

export async function listBackOfficeModules(propertyId: string) {
  // Prisma is the source of truth for PropertyModule: listPropertyModules re-hydrates the
  // demoStore mirror (mapping DB module ids to catalog ids), so Prisma-only hotels see
  // their real module state instead of an empty mirror. Tanda L2 (L2-04): the health
  // checks come from module_health_checks in ONE query for the whole property.
  const [propertyModules, healthChecks] = await Promise.all([listPropertyModules(propertyId), listModuleHealthChecks(propertyId)]);
  return HOTEL_MODULES.map((manifest) => {
    const propertyModule = propertyModules.find((candidate) => candidate.module?.code === manifest.code);
    const health = healthChecks.filter((check) => check.moduleCode === manifest.code);
    const healthStatus = health.some((check) => check.status === "error")
      ? "error"
      : health.some((check) => check.status === "needs_configuration")
        ? "needs_configuration"
        : "ok";
    return {
      ...manifest,
      // Tanda 5 (L1b · api-side): a module without a PropertyModule row is
      // "enabled" when the manifest says it starts enabled (`enabledByDefault`,
      // §14.1 — pms_core plus the reversible default set), the same rule
      // product-modules.service applies when it materialises the row.
      status: propertyModule?.status ?? (manifest.enabledByDefault ? "enabled" : "available"),
      configurationJson: propertyModule?.configurationJson ?? {},
      healthStatus,
      healthChecks: health,
      recommendedNextAction: health.find((check) => check.status !== "ok")?.message ?? "No se requiere ninguna acción."
    };
  });
}

export async function configureModule(input: BackOfficeMutationInput & { moduleCode: HotelModuleCode; configurationJson: Record<string, unknown> }) {
  requirePermissions(input.context, ["modules.configure"]);
  const moduleRecord = demoStore.modules.find((module) => module.code === input.moduleCode);
  if (!moduleRecord) {
    throw new NotFoundError("Módulo no encontrado.");
  }
  // Persistencia tanda 2: el estado PropertyModule vive en Prisma (misma fila
  // que usan enable/disable en product-modules.service); Prisma primero, espejo después.
  const propertyModule = await ensurePropertyModulePersisted(input.propertyId, input.moduleCode);
  const before = { ...propertyModule };
  const mergedConfiguration = { ...propertyModule.configurationJson, ...input.configurationJson };
  const row = await prisma.propertyModule.update({
    where: { id: propertyModule.id },
    data: { configurationJson: asJson(mergedConfiguration) }
  });
  propertyModule.configurationJson = jsonRecord(row.configurationJson);
  audit({ ...input, action: "ModuleConfigured", entityType: "property_module", entityId: propertyModule.id, beforeJson: before, afterJson: propertyModule });
  return { module: getHotelModuleManifest(input.moduleCode), propertyModule };
}

export async function getModuleConfiguration(propertyId: string, moduleCode: HotelModuleCode) {
  const manifest = getHotelModuleManifest(moduleCode);
  // Tanda L2 (L2-04): PropertyModule row from Prisma (module by unique code), never the mirror.
  const moduleRow = await prisma.module.findUnique({ where: { code: moduleCode }, select: { id: true } });
  const propertyModule = moduleRow
    ? await prisma.propertyModule.findUnique({ where: { propertyId_moduleId: { propertyId, moduleId: moduleRow.id } }, select: { configurationJson: true } })
    : null;
  return {
    module: manifest,
    configurationJson: propertyModule ? jsonRecord(propertyModule.configurationJson) : {},
    setupRequirements: getModuleSetupRequirements(moduleCode).map(({ validator: _validator, ...requirement }) => requirement)
  };
}

/** @deprecated L2: sin ruta (L2-02 retira GET …/modules/:moduleCode/health; la salud viaja en GET …/modules). */
export async function getModuleHealth(propertyId: string, moduleCode: HotelModuleCode) {
  return listModuleHealthChecks(propertyId, moduleCode);
}

export async function recalculateModuleHealth(input: BackOfficeMutationInput & { moduleCode: HotelModuleCode }) {
  requirePermissions(input.context, ["modules.configure"]);
  await requireOrganizationProperty(input.propertyId, input.context);
  getHotelModuleManifest(input.moduleCode);
  const requirements = getModuleSetupRequirements(input.moduleCode);
  const checks: ModuleHealthCheckInput[] = [];
  for (const requirement of requirements) {
    checks.push({
      checkCode: requirement.code,
      status: (await requirement.validator(input.propertyId)) ? "ok" : "needs_configuration",
      severity: requirement.blocking ? "blocking" : "warning",
      message: requirement.description,
      metadataJson: {}
    });
  }
  const health = await replaceModuleHealthChecks(input.propertyId, input.moduleCode, checks);
  audit({ ...input, action: "ModuleHealthRecalculated", entityType: "module", entityId: input.moduleCode, afterJson: health });
  return health;
}

type ModuleSetupRequirement = {
  code: string;
  label: string;
  description: string;
  required: boolean;
  blocking: boolean;
  /** Tanda L2 (L2-04): validators read Prisma (rooms, document templates, AI settings), never the in-memory mirrors. */
  validator: (propertyId: string) => Promise<boolean>;
};

function getModuleSetupRequirements(moduleCode: HotelModuleCode): ModuleSetupRequirement[] {
  return [
    {
      code: "room_inventory_exists",
      label: "Inventario de habitaciones",
      description: "Debe existir al menos una habitación activa y vendible.",
      required: true,
      blocking: true,
      validator: async (propertyId: string) => (await prisma.room.count({ where: { propertyId, active: true, sellable: true } })) > 0
    },
    {
      code: "signature_template_configured",
      label: "Plantilla de firma configurada",
      description: "Hay que configurar la plantilla de firma del registro de viajeros.",
      required: moduleCode === "checkin_online",
      blocking: moduleCode === "checkin_online",
      validator: async (propertyId: string) =>
        (await prisma.documentTemplate.count({ where: { propertyId, templateCode: "guest_register_signature_form" } })) > 0
    },
    {
      code: "ocr_provider_configured",
      label: "Proveedor de OCR configurado",
      description: "Hay que configurar el proveedor de OCR antes del escaneo asistido de documentos.",
      required: moduleCode === "checkin_online",
      blocking: moduleCode === "checkin_online",
      validator: async (propertyId: string) => {
        const settings = await prisma.propertyAiSetting.findUnique({ where: { propertyId }, select: { configurationJson: true } });
        return jsonRecord(settings?.configurationJson).ocrProviderConfigured === true;
      }
    }
  ];
}

export async function listDepartments(propertyId: string) {
  // Persistencia tanda 2: Prisma primero, merge con los registros solo-seed.
  const rows = await prisma.department.findMany({ where: { propertyId } });
  const mapped = rows.map(mapDepartmentRow);
  for (const department of mapped) mirrorRecord(demoStore.departments, department);
  return mergeById(mapped, demoStore.departments.filter((department) => department.propertyId === propertyId));
}

export async function createDepartment(input: BackOfficeMutationInput & { department: Pick<DepartmentRecord, "name" | "code"> & Partial<DepartmentRecord> }) {
  requirePermissions(input.context, ["property.configure"]);
  const duplicateInPrisma = await prisma.department.findUnique({
    where: { propertyId_code: { propertyId: input.propertyId, code: input.department.code } },
    select: { id: true }
  });
  if (duplicateInPrisma || demoStore.departments.some((department) => department.propertyId === input.propertyId && department.code === input.department.code)) {
    throw new ConflictError("El código del departamento debe ser único por propiedad.");
  }
  const record: DepartmentRecord = {
    id: createId("dep"),
    propertyId: input.propertyId,
    name: input.department.name,
    code: input.department.code,
    description: input.department.description,
    active: input.department.active ?? true
  };
  // Persistencia tanda 2: Prisma primero (mismo id), después espejo.
  await prisma.department.create({ data: departmentToDbRow(record) });
  demoStore.departments.push(record);
  audit({ ...input, action: "DepartmentCreated", entityType: "department", entityId: record.id, afterJson: record });
  return record;
}

export async function getHousekeepingConfiguration(propertyId: string) {
  // Persistencia tanda 2: Prisma primero (secciones, reglas y asignaciones),
  // merge con los registros solo-seed y refresco del espejo.
  const [sectionRows, ruleRows] = await Promise.all([
    prisma.housekeepingSection.findMany({ where: { propertyId } }),
    prisma.housekeepingRule.findMany({ where: { propertyId } })
  ]);
  for (const row of sectionRows) mirrorRecord(demoStore.housekeepingSections, mapHousekeepingSectionRow(row));
  for (const row of ruleRows) {
    mirrorRecord(demoStore.housekeepingRules, mapConfigRuleRow(row), (candidate) => candidate.propertyId === row.propertyId && candidate.ruleCode === row.ruleCode);
  }
  const sections = demoStore.housekeepingSections.filter((section) => section.propertyId === propertyId);
  const assignmentRows = sections.length > 0
    ? await prisma.housekeepingSectionRoom.findMany({ where: { housekeepingSectionId: { in: sections.map((section) => section.id) } } })
    : [];
  for (const row of assignmentRows) {
    mirrorRecord(
      demoStore.housekeepingSectionRooms,
      { id: row.id, housekeepingSectionId: row.housekeepingSectionId, roomId: row.roomId },
      (candidate) => candidate.housekeepingSectionId === row.housekeepingSectionId && candidate.roomId === row.roomId
    );
  }
  const sectionIds = new Set(sections.map((section) => section.id));
  const assignments = demoStore.housekeepingSectionRooms.filter((assignment) => sectionIds.has(assignment.housekeepingSectionId));
  const roomsById = await resolveRoomsById(propertyId, assignments.map((assignment) => assignment.roomId));
  return {
    sections: sections.map((section) => ({
      ...section,
      rooms: assignments
        .filter((assignment) => assignment.housekeepingSectionId === section.id)
        .map((assignment) => roomsById.get(assignment.roomId))
        .filter((room): room is RoomRecord => Boolean(room))
    })),
    rules: demoStore.housekeepingRules.filter((rule) => rule.propertyId === propertyId)
  };
}

export async function createHousekeepingSection(input: BackOfficeMutationInput & {
  section: Pick<HousekeepingSectionRecord, "name"> & Partial<HousekeepingSectionRecord>;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const section: HousekeepingSectionRecord = {
    id: createId("hk"),
    propertyId: input.propertyId,
    name: input.section.name,
    code: input.section.code,
    description: input.section.description,
    active: input.section.active ?? true
  };
  // Persistencia tanda 2: Prisma primero (mismo id), después espejo.
  await prisma.housekeepingSection.create({ data: housekeepingSectionToDbRow(section) });
  demoStore.housekeepingSections.push(section);
  audit({ ...input, action: "HousekeepingSectionCreated", entityType: "housekeeping_section", entityId: section.id, afterJson: section });
  return section;
}

export async function assignRoomsToHousekeepingSection(input: BackOfficeMutationInput & {
  sectionId: string;
  roomIds: string[];
}) {
  requirePermissions(input.context, ["property.configure"]);
  const section = await requireHousekeepingSection(input.propertyId, input.sectionId);
  await assertRoomsBelongToProperty(input.propertyId, input.roomIds);
  // Persistencia tanda 2: Prisma primero; el unique (sectionId, roomId) hace la
  // asignación idempotente. Después se sincroniza el espejo desde la BD.
  if (input.roomIds.length > 0) {
    await prisma.housekeepingSectionRoom.createMany({
      data: input.roomIds.map((roomId) => ({ id: createId("hksr"), housekeepingSectionId: section.id, roomId })),
      skipDuplicates: true
    });
  }
  const assignmentRows = await prisma.housekeepingSectionRoom.findMany({ where: { housekeepingSectionId: section.id } });
  for (const row of assignmentRows) {
    mirrorRecord(
      demoStore.housekeepingSectionRooms,
      { id: row.id, housekeepingSectionId: row.housekeepingSectionId, roomId: row.roomId },
      (candidate) => candidate.housekeepingSectionId === row.housekeepingSectionId && candidate.roomId === row.roomId
    );
  }
  const assignments = demoStore.housekeepingSectionRooms.filter((assignment) => assignment.housekeepingSectionId === section.id);
  audit({ ...input, action: "HousekeepingSectionRoomsAssigned", entityType: "housekeeping_section", entityId: section.id, afterJson: assignments });
  return { section, assignments };
}

export async function upsertHousekeepingRule(input: BackOfficeMutationInput & {
  ruleCode: string;
  configurationJson: Record<string, unknown>;
  active?: boolean;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const existing = demoStore.housekeepingRules.find((candidate) => candidate.propertyId === input.propertyId && candidate.ruleCode === input.ruleCode);
  const before = existing ? { ...existing } : undefined;
  // Persistencia tanda 2: upsert por (propertyId, ruleCode) — Prisma primero,
  // conservando el id del registro seed si la fila aún no existía en la BD.
  const row = await prisma.housekeepingRule.upsert({
    where: { propertyId_ruleCode: { propertyId: input.propertyId, ruleCode: input.ruleCode } },
    update: {
      configurationJson: asJson(input.configurationJson),
      ...(input.active !== undefined ? { active: input.active } : {})
    },
    create: {
      id: existing?.id ?? createId("hkr"),
      propertyId: input.propertyId,
      ruleCode: input.ruleCode,
      configurationJson: asJson(input.configurationJson),
      active: input.active ?? existing?.active ?? true
    }
  });
  const rule = mirrorRecord(
    demoStore.housekeepingRules,
    mapConfigRuleRow(row),
    (candidate) => candidate.propertyId === input.propertyId && candidate.ruleCode === input.ruleCode
  );
  audit({ ...input, action: "HousekeepingRuleUpdated", entityType: "housekeeping_rule", entityId: rule.id, beforeJson: before, afterJson: rule });
  return rule;
}

export async function getMaintenanceConfiguration(propertyId: string) {
  // Persistencia tanda 2: Prisma primero (áreas, reglas y asignaciones),
  // merge con los registros solo-seed y refresco del espejo.
  const [areaRows, ruleRows] = await Promise.all([
    prisma.maintenanceArea.findMany({ where: { propertyId } }),
    prisma.maintenanceRule.findMany({ where: { propertyId } })
  ]);
  for (const row of areaRows) mirrorRecord(demoStore.maintenanceAreas, mapMaintenanceAreaRow(row));
  for (const row of ruleRows) {
    mirrorRecord(demoStore.maintenanceRules, mapConfigRuleRow(row), (candidate) => candidate.propertyId === row.propertyId && candidate.ruleCode === row.ruleCode);
  }
  const areas = demoStore.maintenanceAreas.filter((area) => area.propertyId === propertyId);
  const assignmentRows = areas.length > 0
    ? await prisma.maintenanceAreaRoom.findMany({ where: { maintenanceAreaId: { in: areas.map((area) => area.id) } } })
    : [];
  for (const row of assignmentRows) {
    mirrorRecord(
      demoStore.maintenanceAreaRooms,
      { id: row.id, maintenanceAreaId: row.maintenanceAreaId, roomId: row.roomId },
      (candidate) => candidate.maintenanceAreaId === row.maintenanceAreaId && candidate.roomId === row.roomId
    );
  }
  const areaIds = new Set(areas.map((area) => area.id));
  const assignments = demoStore.maintenanceAreaRooms.filter((assignment) => areaIds.has(assignment.maintenanceAreaId));
  const roomsById = await resolveRoomsById(propertyId, assignments.map((assignment) => assignment.roomId));
  return {
    areas: areas.map((area) => ({
      ...area,
      rooms: assignments
        .filter((assignment) => assignment.maintenanceAreaId === area.id)
        .map((assignment) => roomsById.get(assignment.roomId))
        .filter((room): room is RoomRecord => Boolean(room))
    })),
    rules: demoStore.maintenanceRules.filter((rule) => rule.propertyId === propertyId)
  };
}

export async function createMaintenanceArea(input: BackOfficeMutationInput & {
  area: Pick<MaintenanceAreaRecord, "name"> & Partial<MaintenanceAreaRecord>;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const area: MaintenanceAreaRecord = {
    id: createId("ma"),
    propertyId: input.propertyId,
    name: input.area.name,
    code: input.area.code,
    description: input.area.description,
    active: input.area.active ?? true
  };
  // Persistencia tanda 2: Prisma primero (mismo id), después espejo.
  await prisma.maintenanceArea.create({ data: maintenanceAreaToDbRow(area) });
  demoStore.maintenanceAreas.push(area);
  audit({ ...input, action: "MaintenanceAreaCreated", entityType: "maintenance_area", entityId: area.id, afterJson: area });
  return area;
}

export async function assignRoomsToMaintenanceArea(input: BackOfficeMutationInput & {
  areaId: string;
  roomIds: string[];
}) {
  requirePermissions(input.context, ["property.configure"]);
  const area = await requireMaintenanceArea(input.propertyId, input.areaId);
  await assertRoomsBelongToProperty(input.propertyId, input.roomIds);
  // Persistencia tanda 2: Prisma primero; el unique (areaId, roomId) hace la
  // asignación idempotente. Después se sincroniza el espejo desde la BD.
  if (input.roomIds.length > 0) {
    await prisma.maintenanceAreaRoom.createMany({
      data: input.roomIds.map((roomId) => ({ id: createId("mar"), maintenanceAreaId: area.id, roomId })),
      skipDuplicates: true
    });
  }
  const assignmentRows = await prisma.maintenanceAreaRoom.findMany({ where: { maintenanceAreaId: area.id } });
  for (const row of assignmentRows) {
    mirrorRecord(
      demoStore.maintenanceAreaRooms,
      { id: row.id, maintenanceAreaId: row.maintenanceAreaId, roomId: row.roomId },
      (candidate) => candidate.maintenanceAreaId === row.maintenanceAreaId && candidate.roomId === row.roomId
    );
  }
  const assignments = demoStore.maintenanceAreaRooms.filter((assignment) => assignment.maintenanceAreaId === area.id);
  audit({ ...input, action: "MaintenanceAreaRoomsAssigned", entityType: "maintenance_area", entityId: area.id, afterJson: assignments });
  return { area, assignments };
}

export async function upsertMaintenanceRule(input: BackOfficeMutationInput & {
  ruleCode: string;
  configurationJson: Record<string, unknown>;
  active?: boolean;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const existing = demoStore.maintenanceRules.find((candidate) => candidate.propertyId === input.propertyId && candidate.ruleCode === input.ruleCode);
  const before = existing ? { ...existing } : undefined;
  // Persistencia tanda 2: upsert por (propertyId, ruleCode) — Prisma primero,
  // conservando el id del registro seed si la fila aún no existía en la BD.
  const row = await prisma.maintenanceRule.upsert({
    where: { propertyId_ruleCode: { propertyId: input.propertyId, ruleCode: input.ruleCode } },
    update: {
      configurationJson: asJson(input.configurationJson),
      ...(input.active !== undefined ? { active: input.active } : {})
    },
    create: {
      id: existing?.id ?? createId("mr"),
      propertyId: input.propertyId,
      ruleCode: input.ruleCode,
      configurationJson: asJson(input.configurationJson),
      active: input.active ?? existing?.active ?? true
    }
  });
  const rule = mirrorRecord(
    demoStore.maintenanceRules,
    mapConfigRuleRow(row),
    (candidate) => candidate.propertyId === input.propertyId && candidate.ruleCode === input.ruleCode
  );
  audit({ ...input, action: "MaintenanceRuleUpdated", entityType: "maintenance_rule", entityId: rule.id, beforeJson: before, afterJson: rule });
  return rule;
}

/**
 * Membership of a user in a department of the property (org chart). Tanda 8a:
 * `roleLabel` is ONLY the free-text label of the person inside the department
 * («jefe de turno», «camarera de pisos»…) shown on the org chart; it grants
 * nothing. The RBAC role (template × scope) lives in user_role_assignments and
 * is changed through POST / DELETE /rbac/assignments (modules/rbac), never
 * here. Audit: USER_DEPARTMENT_ASSIGNED (was the camelCase
 * `UserDepartmentAssigned` before Tanda 8a, design §6.6).
 */
export async function assignUserToDepartment(input: BackOfficeMutationInput & {
  departmentId: string;
  userId: string;
  roleLabel?: string;
}) {
  requirePermissions(input.context, ["users.invite"]);
  const department = await requireDepartment(input.propertyId, input.departmentId);
  const property = await resolveProperty(input.propertyId);
  if (!property) {
    throw new NotFoundError("Property was not found.");
  }
  const userRow = await prisma.user.findFirst({ where: { id: input.userId, organizationId: property.organizationId } });
  const user = userRow
    ? mirrorRecord(demoStore.users, mapUserRow(userRow))
    : demoStore.users.find((candidate) => candidate.id === input.userId && candidate.organizationId === property.organizationId);
  if (!user) {
    throw new NotFoundError("User was not found.");
  }
  const existing = demoStore.userDepartments.find(
    (candidate) => candidate.departmentId === department.id && candidate.userId === user.id
  );
  const before = existing ? { ...existing } : undefined;
  // Persistencia tanda 2: upsert por (userId, departmentId) — Prisma primero,
  // conservando el id del registro seed si la fila aún no existía en la BD.
  const row = await prisma.userDepartment.upsert({
    where: { userId_departmentId: { userId: user.id, departmentId: department.id } },
    update: {
      active: true,
      ...(input.roleLabel !== undefined ? { roleLabel: input.roleLabel } : {})
    },
    create: {
      id: existing?.id ?? createId("ud"),
      userId: user.id,
      departmentId: department.id,
      roleLabel: input.roleLabel ?? existing?.roleLabel ?? null,
      active: true
    }
  });
  const assignment = mirrorRecord(
    demoStore.userDepartments,
    mapUserDepartmentRow(row),
    (candidate) => candidate.userId === user.id && candidate.departmentId === department.id
  );
  audit({ ...input, action: "USER_DEPARTMENT_ASSIGNED", entityType: "user_department", entityId: assignment.id, beforeJson: before, afterJson: assignment });
  return assignment;
}

/** One live RBAC assignment of a user that covers the listed property (Tanda 8a). */
export type BackOfficeUserRoleView = {
  /** user_role_assignments.id, or `legacy:<user_property_roles.id>` for a row of the old table (dual-read until the cut of L6). */
  assignmentId: string;
  roleId: string;
  roleName: string;
  templateKey: RoleKey | null;
  level: RoleLevel | null;
  scopeType: ScopeType;
  /** Id of the property / group / legal entity / organisation the assignment points at. */
  scopeRef: string;
  source: "assignment" | "legacy";
};

function toTemplateKey(value: string | null | undefined): RoleKey | null {
  if (!value) return null;
  return (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value) ? (value as RoleKey) : null;
}

function levelOfAssignment(assignment: Pick<ScopeAssignment, "templateKey" | "level">): RoleLevel | null {
  return assignment.templateKey ? ROLE_TEMPLATE_LEVEL[assignment.templateKey] : assignment.level;
}

function userRoleView(assignment: ScopeAssignment): BackOfficeUserRoleView {
  return {
    assignmentId: assignment.id,
    roleId: assignment.roleId,
    roleName: assignment.roleName,
    templateKey: assignment.templateKey,
    level: levelOfAssignment(assignment),
    scopeType: assignment.scopeType,
    scopeRef: assignment.ref,
    source: assignment.source
  };
}

/**
 * Users with a PENDING invitation whose scope covers the property (property =
 * this one; group containing it; the property's legal entity; the organisation).
 * They may hold no live assignment yet (invitations issued before Tanda 8a
 * wrote the grant only on acceptance), so the list must still show them.
 */
async function usersInvitedForProperty(organizationId: string, propertyId: string): Promise<Set<string>> {
  const [propertyRow, groupRows] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { legalEntityId: true } }),
    prisma.propertyGroupMember.findMany({ where: { propertyId }, select: { propertyGroupId: true } })
  ]);
  const groupIds = groupRows.map((row) => row.propertyGroupId);
  const rows = await prisma.userInvitation.findMany({
    where: {
      organizationId,
      usedAt: null,
      revokedAt: null,
      OR: [
        { propertyId },
        { scopeType: "property", scopeRef: propertyId },
        { scopeType: "organization" },
        ...(propertyRow?.legalEntityId ? [{ scopeType: "legal_entity" as const, scopeRef: propertyRow.legalEntityId }] : []),
        ...(groupIds.length > 0 ? [{ scopeType: "property_group" as const, scopeRef: { in: groupIds } }] : [])
      ]
    },
    select: { userId: true }
  });
  return new Set(rows.map((row) => row.userId));
}

/**
 * Users of THIS property (Tanda 8a · C11; before it the list returned every
 * user of the organisation): a user appears when a live assignment covers the
 * property — legacy user_property_roles row or user_role_assignments row of
 * any scope, groups / sociedad / organisation expanded by the single reader
 * of lib/rbac-scope.ts — or when a pending invitation targets it. Each row
 * carries `roles[]` (the REAL RBAC assignments covering the property:
 * template, level, scope) — the department `roleLabel` is a label, never a
 * role. Emergency accounts (break glass, §4.8) are never listed.
 */
export async function listBackOfficeUsers(propertyId: string) {
  const property = await requireProperty(propertyId);
  const organizationId = property.organizationId;
  // Persistencia tanda 2: Prisma primero (usuarios, departamentos y
  // asignaciones), merge con los registros solo-seed y refresco del espejo.
  const [userRows, departmentRows] = await Promise.all([
    prisma.user.findMany({ where: { organizationId, status: { not: "emergency" } }, orderBy: { createdAt: "asc" } }),
    prisma.department.findMany({ where: { propertyId } })
  ]);
  for (const row of userRows) mirrorRecord(demoStore.users, mapUserRow(row));
  for (const row of departmentRows) mirrorRecord(demoStore.departments, mapDepartmentRow(row));
  const candidates = demoStore.users.filter((user) => user.organizationId === organizationId && (user.status as string) !== "emergency");

  const rolesByUser = new Map<string, BackOfficeUserRoleView[]>();
  for (const candidate of candidates) {
    const scope = await loadUserScope(candidate.id, organizationId);
    const covering = scope.assignments.filter((assignment) => assignment.propertyIds.includes(propertyId) && assignment.templateKey !== "break_glass");
    if (covering.length > 0) rolesByUser.set(candidate.id, covering.map(userRoleView));
  }
  const invited = await usersInvitedForProperty(organizationId, propertyId);
  const users = candidates.filter((user) => rolesByUser.has(user.id) || invited.has(user.id));

  const assignmentRows = users.length > 0
    ? await prisma.userDepartment.findMany({ where: { userId: { in: users.map((user) => user.id) } } })
    : [];
  for (const row of assignmentRows) {
    mirrorRecord(
      demoStore.userDepartments,
      mapUserDepartmentRow(row),
      (candidate) => candidate.userId === row.userId && candidate.departmentId === row.departmentId
    );
  }
  // Invited users carry the state of their latest pending invitation (expiry, how the
  // email went out, whether it already expired) so the list can offer "Reenviar". The
  // token never travels here: inviteUrl is always null (reissue mints a fresh link).
  const invitedIds = users.filter((user) => user.status === "invited").map((user) => user.id);
  const pendingByUser = await getPendingInvitations(invitedIds);
  return users.map((user) => {
    const pendingInvitation = pendingInvitationView(user.status === "invited" ? pendingByUser.get(user.id) : undefined);
    return {
      ...user,
      pendingInvitation,
      roles: rolesByUser.get(user.id) ?? [],
      departments: demoStore.userDepartments
        .filter((assignment) => assignment.userId === user.id && assignment.active && assignment.departmentId && demoStore.departments.some((department) => department.id === assignment.departmentId && department.propertyId === propertyId))
        .map((assignment) => ({
          ...assignment,
          department: demoStore.departments.find((department) => department.id === assignment.departmentId)
        }))
    };
  });
}

/** Pending-invitation summary of an `invited` user in the users list; never carries the token. */
export type BackOfficePendingInvitationView = {
  expiresAt: string;
  deliveryStatus: string | null;
  /** true when expiresAt is in the past: the admin must reissue before the invitee can accept. */
  expired: boolean;
  /** Always null in the list (the single-use link is only returned by invite/reissue). */
  inviteUrl: null;
};

/**
 * Pure projection of getPendingInvitations() for the users list: only the expiry,
 * the delivery state and the expired flag survive; the token (or anything derived
 * from it) never does — `inviteUrl` is a literal null so the client renders
 * "Reenviar" instead of a link. Null for a user without a pending (unused,
 * unrevoked) invitation. Unit-tested in __tests__/backoffice-users.test.mts.
 */
export function pendingInvitationView(pending: PendingInvitationInfo | null | undefined): BackOfficePendingInvitationView | null {
  if (!pending) return null;
  return {
    expiresAt: pending.expiresAt,
    deliveryStatus: pending.deliveryStatus ?? null,
    expired: pending.expired === true,
    inviteUrl: null
  };
}

export type PropertyRoleView = {
  id: string;
  name: string;
  /** Shared template the role follows ('owner' | 'manager' | ...); null = custom role. */
  templateKey: string | null;
  permissionsCount: number;
  /** Tanda 8a: level N1-N7 of the role (template level, else the custom role's own; null for an untyped custom role). */
  level: RoleLevel | null;
  department: string | null;
  /** Version of ROLE_PERMISSION_MAP the role was last converged to (0 = before versioning). */
  templateVersion: number;
  managed: boolean;
};

/**
 * Roles of the property's organization that a back-office invite may assign
 * (Prisma; platform-scoped roles — admin.* / platform.* keys — are excluded:
 * a hotel user is never a platform admin; the emergency role `break_glass`
 * is never offered either, §4.8). Feeds the role select of the invite
 * drawer: `templateKey` says which template the role follows, `level` /
 * `templateVersion` what the invitee gets, and `permissionsCount === 0` flags
 * a role that would leave the invitee with no access (requireAssignableRole
 * applies its template or answers 409).
 */
export async function listPropertyRoles(propertyId: string): Promise<PropertyRoleView[]> {
  const property = await requireProperty(propertyId);
  const roles = (
    await prisma.role.findMany({
      where: { organizationId: property.organizationId },
      select: { id: true, name: true, templateKey: true, level: true, department: true, templateVersion: true, managed: true },
      orderBy: { name: "asc" }
    })
  ).filter((role) => role.templateKey !== "break_glass");
  if (roles.length === 0) return [];
  const grants = await prisma.rolePermission.findMany({
    where: { roleId: { in: roles.map((role) => role.id) } },
    select: { roleId: true, permissionId: true }
  });
  const permissionIds = Array.from(new Set(grants.map((grant) => grant.permissionId)));
  const permissions = permissionIds.length > 0
    ? await prisma.permission.findMany({ where: { id: { in: permissionIds } }, select: { id: true, key: true } })
    : [];
  const keyById = new Map(permissions.map((permission) => [permission.id, permission.key]));
  const summary = new Map<string, { count: number; platformScoped: boolean }>();
  for (const grant of grants) {
    const entry = summary.get(grant.roleId) ?? { count: 0, platformScoped: false };
    entry.count += 1;
    const key = keyById.get(grant.permissionId);
    if (key && isPlatformPermission(key)) entry.platformScoped = true;
    summary.set(grant.roleId, entry);
  }
  return roles
    .filter((role) => !(summary.get(role.id)?.platformScoped ?? false))
    .map((role) => ({
      id: role.id,
      name: role.name,
      templateKey: role.templateKey,
      permissionsCount: summary.get(role.id)?.count ?? 0,
      level: toTemplateKey(role.templateKey) ? ROLE_TEMPLATE_LEVEL[toTemplateKey(role.templateKey)!] : role.level,
      department: role.department,
      templateVersion: role.templateVersion,
      managed: role.managed
    }));
}

/**
 * Role of the property's organization, safe to hand to a hotel user (opaque
 * 404 cross-org and for the emergency template, 403 platform scope). Tanda 4
 * (contract B): a role with ZERO grants gets its template applied on the spot
 * (Role.templateKey or the name-resolved template); when none can be
 * determined the invite answers 409 ROLE_WITHOUT_PERMISSIONS — the invitee
 * would be 403 everywhere in production otherwise.
 */
async function requireAssignableRole(
  organizationId: string,
  roleId: string,
  context: UserContext,
  /** Tanda 8a: runs between the lookup and ensureRoleHasPermissions (a write on an empty role) — the scope / level 403s must fire before any write. */
  authorize?: (role: { id: string; name: string; templateKey: string | null; level: RoleLevel | null }) => Promise<void>
): Promise<{ id: string; name: string; templateKey: string | null; level: RoleLevel | null; permissionsCount: number }> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, name: true, organizationId: true, templateKey: true, level: true } });
  if (!role || role.organizationId !== organizationId || role.templateKey === "break_glass") {
    throw new NotFoundError("Rol no encontrado.");
  }
  if (authorize) await authorize(role);
  if (!context.isPlatformAdmin) {
    const grants = await prisma.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionId: true } });
    if (grants.length > 0) {
      const permissions = await prisma.permission.findMany({
        where: { id: { in: grants.map((grant) => grant.permissionId) } },
        select: { key: true }
      });
      if (permissions.some((permission) => isPlatformPermission(permission.key))) {
        throw new ForbiddenError("Solo un administrador de plataforma puede asignar este rol.");
      }
    }
  }
  const ensured = await ensureRoleHasPermissions(role.id);
  return { id: role.id, name: role.name, templateKey: ensured.templateKey, level: role.level, permissionsCount: ensured.permissionsCount };
}

/** Target scope of an invitation, resolved inside the property's organisation (Tanda 8a). */
type InviteScopeTarget = {
  scopeType: ScopeType;
  scopeRef: string;
  /** Properties the scope expands to ([] for an unknown group / legal entity: the scope check fails before any 404). */
  propertyIds: string[];
  exists: boolean;
};

async function resolveInviteScope(organizationId: string, property: PropertyRecord, scopeType: ScopeType | undefined, scopeRef: string | undefined): Promise<InviteScopeTarget> {
  const type: ScopeType = scopeType ?? "property";
  switch (type) {
    case "property": {
      const ref = scopeRef ?? property.id;
      if (ref === property.id) return { scopeType: type, scopeRef: ref, propertyIds: [ref], exists: true };
      const sister = await prisma.property.findFirst({ where: { id: ref, organizationId }, select: { id: true } });
      return { scopeType: type, scopeRef: ref, propertyIds: [ref], exists: sister !== null };
    }
    case "property_group": {
      if (!scopeRef) throw new BadRequestError("El ámbito property_group exige scopeRef (id del grupo de propiedades).");
      const group = await prisma.propertyGroup.findFirst({ where: { id: scopeRef, organizationId }, select: { id: true } });
      const members = group ? await prisma.propertyGroupMember.findMany({ where: { propertyGroupId: group.id }, select: { propertyId: true } }) : [];
      return { scopeType: type, scopeRef, propertyIds: members.map((member) => member.propertyId), exists: group !== null };
    }
    case "legal_entity": {
      if (!scopeRef) throw new BadRequestError("El ámbito legal_entity exige scopeRef (id de la sociedad).");
      const entity = await prisma.legalEntity.findFirst({ where: { id: scopeRef, organizationId }, select: { id: true } });
      const members = entity ? await prisma.property.findMany({ where: { organizationId, legalEntityId: entity.id }, select: { id: true } }) : [];
      return { scopeType: type, scopeRef, propertyIds: members.map((row) => row.id), exists: entity !== null };
    }
    case "organization": {
      const members = await prisma.property.findMany({ where: { organizationId }, select: { id: true } });
      return { scopeType: type, scopeRef: organizationId, propertyIds: members.map((row) => row.id), exists: true };
    }
    default:
      throw new BadRequestError("Ámbito no válido.");
  }
}

/**
 * The inviter may only grant inside its own scope and up to its own level
 * (design §5.5, §6.3; same rules as modules/rbac createAssignment): target
 * scope ⊆ inviter scope → else 403 RBAC_SCOPE_EXCEEDED (evaluated BEFORE any
 * existence check, so a foreign or unknown ref never becomes an oracle);
 * ROLE_LEVEL_RANK[template] ≤ maxRankOf(inviter in the target scope) → else
 * 403 RBAC_LEVEL_EXCEEDED. Platform admins are exempt; a caller whose scope
 * the database does not know holds nothing (fail-secure).
 */
async function assertInviterMayGrant(
  context: UserContext,
  organizationId: string,
  target: InviteScopeTarget,
  role: { templateKey: string | null; level: RoleLevel | null }
): Promise<void> {
  if (context.isPlatformAdmin === true) return;
  const callerScope = await loadUserScope(context.userId, organizationId);
  const wide = target.scopeType === "legal_entity" || target.scopeType === "organization";
  const covers = wide
    ? callerScope.orgScope
    : callerScope.orgScope || (target.propertyIds.length > 0 && target.propertyIds.every((propertyId) => coversProperty(callerScope, propertyId)));
  if (!covers) {
    throw new RbacForbiddenError("No puedes invitar fuera de tu ámbito.", "RBAC_SCOPE_EXCEEDED");
  }
  const targetRank = rankOfAssignment({ templateKey: toTemplateKey(role.templateKey), level: role.level });
  const callerRank = wide || target.propertyIds.length === 0 ? maxRankOf(callerScope, null) : Math.min(...target.propertyIds.map((propertyId) => maxRankOf(callerScope, propertyId)));
  if (targetRank > callerRank) {
    throw new RbacForbiddenError("No puedes invitar con un rol de nivel superior al tuyo.", "RBAC_LEVEL_EXCEEDED", { targetRank, callerRank });
  }
}

export type InvitationDeliveryView = {
  status: "sent" | "simulated" | "failed" | "disabled";
  provider?: string;
  errorMessage?: string;
};

export type BackOfficeInvitationView = {
  /** Single-use accept-invite link (carries the token): shown when the email is simulated/failed so the admin can hand it over. */
  inviteUrl: string | null;
  expiresAt: string | null;
  delivery: InvitationDeliveryView;
  /** Set only when the invitation itself could not be created (the user exists; use "reissue"). */
  error?: string;
};

/**
 * MFA requirement of a new invitee: strictly `mfaRequired === true`. Absent, false,
 * null, "true" or 1 all mean false — an invitee has no second factor enrolled yet,
 * so anything short of an explicit boolean opt-in must not lock them out on first
 * login. Unit-tested in __tests__/backoffice-users.test.mts.
 */
export function inviteMfaEnabled(mfaRequired: unknown): boolean {
  return mfaRequired === true;
}

/**
 * Tanda 3 (CFG-P1-6): a real invitation. Creates the user as `invited` (no
 * password: they choose it on accept), assigns the role in the same transaction
 * and mints a persisted single-use token (contract G). The email is best-effort:
 * its delivery status travels in the response, never as an exception — the user
 * and role exist regardless.
 *
 * `mfaRequired` is opt-in: `mfaEnabled` is true only when the body says
 * `mfaRequired: true`; absent or false → false. An invitee has no second factor
 * enrolled yet, so defaulting to "required" would lock them out on first login.
 * (Tanda 8a · D8: createInvitation additionally marks templates of level N2+
 * for 2FA enrolment.)
 *
 * Tanda 8a (§5.5): the invitation carries a scope — `scopeType` / `scopeRef`
 * (property of the URL by default; a sister property, a property group, the
 * legal entity or the organisation) — that must be ⊆ the inviter's own scope,
 * and a template whose level the inviter holds there (403 RBAC_SCOPE_EXCEEDED
 * / RBAC_LEVEL_EXCEEDED); the emergency role is never assignable (404). The
 * grant is written in BOTH tables (writeRoleAssignment: user_property_roles
 * for scope property + user_role_assignments) and audited as ROLE_ASSIGNED;
 * a break-glass session cannot invite (403 RBAC_BREAK_GLASS_FORBIDDEN).
 */
export async function inviteBackOfficeUser(input: BackOfficeMutationInput & {
  email: string;
  fullName: string;
  phone?: string;
  /** Require MFA for this user (default false). */
  mfaRequired?: boolean;
  roleId?: string;
  /** Tanda 8a: scope of the assignment (default property / the property of the URL). */
  scopeType?: ScopeType;
  scopeRef?: string;
}): Promise<{ user: UserRecord & { roleId: string; roleName: string; scopeType: ScopeType; scopeRef: string; assignmentId: string }; invitation: BackOfficeInvitationView }> {
  requirePermissions(input.context, ["users.invite"]);
  assertNotBreakGlass(input.context);
  const property = await requireProperty(input.propertyId);
  const email = (input.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new BadRequestError("El email del usuario invitado es obligatorio y debe ser válido.");
  }
  const fullName = (input.fullName ?? "").trim();
  if (!fullName) {
    throw new BadRequestError("El nombre completo del usuario invitado es obligatorio.");
  }
  if (!hasText(input.roleId)) {
    // Without a role the invitee would get 403 on every route in production (no demo permission union).
    throw new BadRequestError("El rol es obligatorio: elige uno de los roles de la organización (GET /backoffice/properties/:propertyId/roles).");
  }
  // Scope ⊆ inviter scope and level ≤ inviter level, BEFORE the existence of
  // the ref is revealed (an unknown group answers 403 like a foreign one) and
  // BEFORE ensureRoleHasPermissions may write a template onto an empty role.
  const target = await resolveInviteScope(property.organizationId, property, input.scopeType, input.scopeRef);
  const role = await requireAssignableRole(property.organizationId, input.roleId.trim(), input.context, (candidate) =>
    assertInviterMayGrant(input.context, property.organizationId, target, candidate)
  );
  if (!target.exists) {
    throw new NotFoundError(
      target.scopeType === "property" ? "Propiedad no encontrada." : target.scopeType === "property_group" ? "Grupo de propiedades no encontrado." : "Sociedad no encontrada."
    );
  }
  // User.email es unique en la BD: 409 explícito en vez de un P2002 opaco.
  const duplicateInPrisma = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (duplicateInPrisma || demoStore.users.some((user) => user.email.toLowerCase() === email)) {
    throw withDetails(new ConflictError("Ya existe un usuario con ese email."), { code: "USER_EMAIL_TAKEN", email });
  }
  const user: UserRecord = {
    id: createId("usr"),
    organizationId: property.organizationId,
    email,
    phone: input.phone?.trim() || undefined,
    fullName,
    status: "invited",
    // Opt-in only (see the docblock and inviteMfaEnabled): absent/false → false.
    mfaEnabled: inviteMfaEnabled(input.mfaRequired)
  };
  // Prisma first (same id, no passwordHash — set by acceptInvitation), user + role
  // assignment (both tables) atomically, then the in-memory mirror.
  const assignment = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { ...userToDbRow(user), passwordHash: null, mustChangePassword: false } });
    return writeRoleAssignment(tx, {
      userId: user.id,
      organizationId: property.organizationId,
      roleId: role.id,
      scopeType: target.scopeType,
      scopeRef: target.scopeRef,
      grantedByUserId: input.context.userId,
      reason: "invitación"
    });
  });
  demoStore.users.push(user);
  recordRoleAssigned(assignment, { actorUserId: input.context.userId, correlationId: input.correlationId, deviceId: input.context.deviceId });

  let invitation: BackOfficeInvitationView;
  try {
    const created = await createInvitation({
      userId: user.id,
      organizationId: property.organizationId,
      propertyId: target.scopeType === "property" ? target.scopeRef : property.id,
      roleId: role.id,
      scopeType: target.scopeType,
      scopeRef: target.scopeRef,
      invitedByUserId: input.context.userId,
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
    invitation = { inviteUrl: created.inviteUrl, expiresAt: created.expiresAt, delivery: created.delivery };
  } catch (err) {
    // The user and role are persisted: report the failure (never a fake "sent") and let
    // the admin reissue from the user list.
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[backoffice.inviteBackOfficeUser] createInvitation failed", {
      userId: user.id,
      propertyId: property.id,
      correlationId: input.correlationId,
      error: message
    });
    invitation = { inviteUrl: null, expiresAt: null, delivery: { status: "failed", errorMessage: message }, error: message };
  }

  audit({
    ...input,
    action: "UserInvited",
    entityType: "user",
    entityId: user.id,
    // Never the invite URL (it carries the token): status + expiry only.
    afterJson: {
      ...user,
      roleId: role.id,
      roleName: role.name,
      templateKey: role.templateKey,
      scopeType: target.scopeType,
      scopeRef: target.scopeRef,
      assignmentId: assignment.assignmentId,
      invitation: { expiresAt: invitation.expiresAt, delivery: invitation.delivery, error: invitation.error }
    }
  });
  return { user: { ...user, roleId: role.id, roleName: role.name, scopeType: target.scopeType, scopeRef: target.scopeRef, assignmentId: assignment.assignmentId }, invitation };
}

/**
 * Disable a user ENTIRELY (Tanda 8a · §5.4: «Desactivar usuario (todo)» —
 * retiring someone from ONE hotel is DELETE /rbac/assignments/:id instead).
 * In one transaction: status disabled, every live user_role_assignments row
 * revoked (validTo / revokedAt / revokedByUserId), every active session
 * revoked (same as acceptInvitation) and every pending invitation revoked;
 * then organizations.rbac_version is bumped so nothing stale survives. The
 * caller may not disable someone of a higher level than its own in the
 * property (403 RBAC_LEVEL_EXCEEDED; platform admins exempt) nor act from a
 * break-glass session. Audit: USER_DISABLED (was the camelCase `UserDisabled`
 * before Tanda 8a, design §6.6); the legacy user_property_roles rows are left
 * in place (a disabled user cannot authenticate; the cut of L6 removes them).
 */
export async function disableBackOfficeUser(input: BackOfficeMutationInput & { userId: string }) {
  requirePermissions(input.context, ["users.disable"]);
  assertNotBreakGlass(input.context);
  const property = await resolveProperty(input.propertyId);
  if (!property) {
    throw new NotFoundError("Property was not found.");
  }
  const { user, persisted } = await requireBackOfficeUser(property.organizationId, input.userId);
  const before = { ...user };
  const now = new Date();
  let revoked = { assignments: 0, sessions: 0, invitations: 0, assignmentIds: [] as string[] };
  if (persisted) {
    // Level rule: nobody disables a user who holds a higher level than the caller in this property.
    if (input.context.isPlatformAdmin !== true) {
      const [callerScope, targetScope] = await Promise.all([loadUserScope(input.context.userId, property.organizationId), loadUserScope(user.id, property.organizationId)]);
      const targetRank = targetScope.assignments.length === 0 ? 0 : Math.max(...targetScope.assignments.map(rankOfAssignment));
      const callerRank = maxRankOf(callerScope, property.id);
      if (targetRank > callerRank) {
        throw new RbacForbiddenError("No puedes desactivar a un usuario de nivel superior al tuyo.", "RBAC_LEVEL_EXCEEDED", { targetRank, callerRank });
      }
    }
    // Persistencia tanda 2: Prisma primero, después espejo.
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: user.id }, data: { status: "disabled" } });
      const live = await tx.userRoleAssignment.findMany({ where: { userId: user.id, organizationId: property.organizationId, revokedAt: null }, select: { id: true } });
      const assignments = await tx.userRoleAssignment.updateMany({
        where: { userId: user.id, organizationId: property.organizationId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: input.context.userId, validTo: now, reason: "usuario desactivado" }
      });
      const sessions = await tx.session.updateMany({ where: { userId: user.id, status: "active" }, data: { status: "revoked", revokedAt: now } });
      const invitations = await tx.userInvitation.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await bumpRbacVersion(property.organizationId, tx);
      revoked = { assignments: assignments.count, sessions: sessions.count, invitations: invitations.count, assignmentIds: live.map((candidate) => candidate.id) };
      return updated;
    });
    Object.assign(user, mapUserRow(row));
  } else {
    // Usuario seed cuyo email ya pertenece a otra fila en la BD: solo espejo.
    user.status = "disabled";
  }
  audit({
    ...input,
    action: "USER_DISABLED",
    entityType: "user",
    entityId: user.id,
    beforeJson: { ...before, liveAssignmentIds: revoked.assignmentIds },
    afterJson: { ...user, revokedAssignments: revoked.assignments, revokedSessions: revoked.sessions, revokedInvitations: revoked.invitations, revokedAt: now.toISOString() }
  });
  return user;
}

/**
 * Static catalogue of the 22 organisation templates (ORGANIZATION_TEMPLATE_ROLE_KEYS,
 * Tanda 8a: never `admin` — platform token — nor `break_glass`) with their
 * Spanish label, level, default scope and keys. `GET /backoffice/roles`.
 */
export function listRoleCatalog() {
  return ORGANIZATION_TEMPLATE_ROLE_KEYS.map((role) => ({
    role,
    label: ROLE_TEMPLATE_LABELS_ES[role],
    description: ROLE_TEMPLATE_DESCRIPTIONS_ES[role],
    level: ROLE_TEMPLATE_LEVEL[role],
    defaultScope: ROLE_TEMPLATE_DEFAULT_SCOPE[role],
    templateVersion: ROLE_TEMPLATE_VERSION,
    permissions: ROLE_PERMISSION_MAP[role]
  }));
}

export function listPermissionCatalog() {
  return Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description }));
}

/**
 * CFG-P1-4: Prisma-first compliance settings. Hotels without a row get explicit
 * defaults derived from the property (flagged `provisioned: false`); the row is
 * only created by the first PATCH. The demoStore record is a mirror.
 */
/**
 * Tanda 3 columns that live only in Prisma (the in-memory PropertyComplianceSettingsRecord
 * predates them). The nullable text fields are ALWAYS present in the GET/PATCH body
 * (`null` when empty, never omitted) so a client can tell "not set" from "unknown key"
 * and send `null` back to clear them. taxRegion keeps the record's `undefined` convention.
 */
type ComplianceFiscalExtras = {
  /** Canonical region resolved from Property (input → legacy spelling → province); undefined when unknown. */
  taxRegion?: string;
  /** Raw Property.taxRegion as stored (diagnostics for legacy values). */
  taxRegionRaw?: string;
  fiscalTerritory: string | null;
  postalCode: string | null;
  ineMunicipalityCode: string | null;
  sesRegistryNumber: string | null;
  touristTaxTreatment: string | null;
  ipsiOrdinanceConfirmed: boolean;
  ipsiOrdinanceConfirmedAt: string | null;
};

async function complianceFiscalExtras(propertyId: string): Promise<ComplianceFiscalExtras> {
  const [fiscal, row] = await Promise.all([
    propertyFiscalColumns(propertyId),
    prisma.propertyComplianceSetting.findUnique({
      where: { propertyId },
      select: { sesRegistryNumber: true, touristTaxTreatment: true, ipsiOrdinanceConfirmedAt: true }
    })
  ]);
  const taxRegion = normalizeTaxRegion(fiscal.taxRegion, fiscal.province);
  return {
    taxRegion: taxRegion ?? undefined,
    taxRegionRaw: fiscal.taxRegion ?? undefined,
    fiscalTerritory: normalizeFiscalTerritory(fiscal.fiscalTerritory),
    postalCode: fiscal.postalCode ?? null,
    ineMunicipalityCode: fiscal.ineMunicipalityCode ?? null,
    sesRegistryNumber: row?.sesRegistryNumber ?? null,
    touristTaxTreatment: row?.touristTaxTreatment ?? null,
    ipsiOrdinanceConfirmed: Boolean(row?.ipsiOrdinanceConfirmedAt),
    ipsiOrdinanceConfirmedAt: row?.ipsiOrdinanceConfirmedAt?.toISOString() ?? null
  };
}

export async function getComplianceSettings(propertyId: string) {
  const { settings, provisioned } = await resolveComplianceSettings(propertyId);
  const extras = await complianceFiscalExtras(propertyId);
  // `taxRegion` exposed is the CANONICAL region (Property is the resolver's source); the
  // compliance row only mirrors it.
  return { ...settings, provisioned, ...extras };
}

/**
 * PATCH body. The four nullable text fields are three-state: key absent (`undefined`)
 * → unchanged; `null` or "" → cleared; text → validated and stored. `taxRegion` stays
 * non-destructive (null/"" keeps the current/derived region).
 */
export type CompliancePatch = Partial<PropertyComplianceSettingsRecord> & {
  fiscalTerritory?: string | null;
  postalCode?: string | null;
  ineMunicipalityCode?: string | null;
  sesRegistryNumber?: string | null;
  touristTaxTreatment?: string | null;
  /** true → ipsiOrdinanceConfirmedAt = now; false → cleared. */
  ipsiOrdinanceConfirmed?: boolean;
};

export async function patchComplianceSettings(input: BackOfficeMutationInput & { patch: CompliancePatch }) {
  requirePermissions(input.context, ["compliance.configure"]);
  const property = await requireProperty(input.propertyId);
  const { settings: current, provisioned } = await resolveComplianceSettings(input.propertyId);
  const currentFiscal = await propertyFiscalColumns(input.propertyId);
  const before = { ...current, ...currentFiscal };
  // Identity fields are never patchable; the Tanda 3 fiscal fields are validated and
  // persisted on Property / the new compliance columns; everything else merges over the
  // current values.
  const {
    id: _id,
    propertyId: _propertyId,
    updatedAt: _updatedAt,
    taxRegion: taxRegionInput,
    fiscalTerritory: rawFiscalTerritory,
    postalCode: rawPostalCode,
    ineMunicipalityCode: rawIne,
    sesRegistryNumber: rawSesRegistry,
    touristTaxTreatment: touristTaxTreatmentInput,
    ipsiOrdinanceConfirmed,
    tourismTaxRegion: tourismTaxRegionInput,
    ...patch
  } = input.patch;

  // undefined → unchanged · null / "" → clear · text → validate. The INE municipality
  // code must belong to the same province as the postal code (resolveFiscalLocation
  // rejects the pair with POSTAL_INE_PROVINCE_MISMATCH otherwise).
  const postalCodeInput = normalizeClearablePatchField(rawPostalCode, "postalCode");
  const ineInput = normalizeClearablePatchField(rawIne, "ineMunicipalityCode");
  const fiscalTerritoryInput = normalizeClearablePatchField(rawFiscalTerritory, "fiscalTerritory");
  const sesRegistryInput = normalizeClearablePatchField(rawSesRegistry, "sesRegistryNumber");

  const fiscal = resolveFiscalLocation({
    current: currentFiscal,
    patch: { taxRegion: taxRegionInput, postalCode: postalCodeInput, ineMunicipalityCode: ineInput, fiscalTerritory: fiscalTerritoryInput },
    province: currentFiscal.province ?? property.province ?? null,
    clearOnNull: true
  });
  const tourismTaxRegion = hasText(tourismTaxRegionInput) ? normalizeTourismTaxRegion(tourismTaxRegionInput) : undefined;
  if (hasText(tourismTaxRegionInput) && !tourismTaxRegion) {
    throw new BadRequestError(
      `Región de tasa turística no reconocida («${tourismTaxRegionInput.trim()}»). Valores admitidos: ${TOURISM_TAX_REGION_OPTIONS.map((option) => option.value).join(", ")}.`
    );
  }
  const touristTaxTreatment = hasText(touristTaxTreatmentInput) ? normalizeTouristTaxTreatment(touristTaxTreatmentInput) : undefined;
  if (hasText(touristTaxTreatmentInput) && !touristTaxTreatment) {
    throw new BadRequestError(
      `Tratamiento de la tasa turística no reconocido («${touristTaxTreatmentInput.trim()}»). Valores admitidos: ${TOURIST_TAX_TREATMENTS.join(", ")}.`
    );
  }
  if (ipsiOrdinanceConfirmed !== undefined && typeof ipsiOrdinanceConfirmed !== "boolean") {
    throw new BadRequestError("ipsiOrdinanceConfirmed debe ser un booleano.");
  }
  // sesRegistryNumber: undefined → unchanged, null → cleared, text → 3..64 [A-Za-z0-9-].
  const sesRegistryNumber = sesRegistryInput === undefined || sesRegistryInput === null ? sesRegistryInput : validateSesRegistryNumber(sesRegistryInput);

  const next: PropertyComplianceSettingsRecord = {
    ...current,
    ...patch,
    id: current.id,
    propertyId: input.propertyId,
    // Mirror of the canonical Property.taxRegion; never "".
    taxRegion: fiscal.taxRegionToPersist ?? undefined,
    tourismTaxRegion:
      tourismTaxRegion === undefined
        ? current.tourismTaxRegion || undefined
        : tourismTaxRegion === "none" || tourismTaxRegion === null
          ? undefined
          : tourismTaxRegion,
    updatedAt: nowIso()
  };

  // Prisma first: Property fiscal columns (only when the property row exists; seed-only
  // properties keep the mirror), then the compliance row (upsert by propertyId: creates the
  // row with defaults + patch when missing) and its Tanda 3 columns, then mirrors.
  const regionChanged = (currentFiscal.taxRegion ?? null) !== fiscal.taxRegionToPersist;
  const propertyRow = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { id: true } });
  if (propertyRow) {
    await prisma.property.update({
      where: { id: input.propertyId },
      data: {
        taxRegion: fiscal.taxRegionToPersist,
        fiscalTerritory: fiscal.fiscalTerritory,
        postalCode: fiscal.postalCode,
        ineMunicipalityCode: fiscal.ineMunicipalityCode
      }
    });
  }
  property.taxRegion = fiscal.taxRegionToPersist ?? undefined;
  const persisted = await persistComplianceSettings(next);
  const extrasData: Prisma.PropertyComplianceSettingUncheckedUpdateInput = {};
  if (sesRegistryNumber !== undefined) extrasData.sesRegistryNumber = sesRegistryNumber;
  if (touristTaxTreatment !== undefined) extrasData.touristTaxTreatment = touristTaxTreatment;
  if (ipsiOrdinanceConfirmed !== undefined) extrasData.ipsiOrdinanceConfirmedAt = ipsiOrdinanceConfirmed ? new Date() : null;
  if (Object.keys(extrasData).length > 0) {
    await prisma.propertyComplianceSetting.update({ where: { propertyId: input.propertyId }, data: extrasData });
  }
  const settings = mirrorRecord(demoStore.propertyComplianceSettings, persisted, byPropertyId(input.propertyId));

  // Region / rates are cached by the tax resolver: invalidate, then (re)provision the
  // statutory catalogue for the region (idempotent — existing rows are kept; a hotel
  // whose region was set without rows gets them here). Failure reported, not hidden.
  invalidateTaxCache(input.propertyId);
  let taxProvisioning: { ok: boolean; taxRegion: string | null; regionChanged: boolean; provisioned?: number; skipped?: number; error?: string };
  if (propertyRow) {
    try {
      const result = await ensurePropertyTaxes({ propertyId: input.propertyId, organizationId: property.organizationId, taxRegion: fiscal.taxRegionToPersist });
      taxProvisioning = { ok: true, taxRegion: result.taxRegion, regionChanged, provisioned: result.provisioned, skipped: result.skipped };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[backoffice.patchComplianceSettings] ensurePropertyTaxes failed", {
        propertyId: input.propertyId,
        correlationId: input.correlationId,
        taxRegion: fiscal.taxRegionToPersist,
        error: message
      });
      taxProvisioning = { ok: false, taxRegion: fiscal.taxRegion, regionChanged, error: message };
    }
  } else {
    // Seed-only property (no Prisma row): nothing to provision against.
    taxProvisioning = { ok: false, taxRegion: fiscal.taxRegion, regionChanged, error: "La propiedad no existe en la base de datos; no se provisionan impuestos." };
  }

  const extras = await complianceFiscalExtras(input.propertyId);
  audit({
    ...input,
    action: provisioned ? "TaxSettingsUpdated" : "TaxSettingsProvisioned",
    entityType: "property_compliance_settings",
    entityId: settings.id,
    beforeJson: before,
    afterJson: { ...settings, ...extras, taxProvisioning }
  });
  return { ...settings, provisioned: true, ...extras, taxProvisioning };
}

/** Invoice numbers already allocated under a series prefix (issued, cancelled and rectified all count: their numbers are taken). */
async function issuedNumbersForPrefix(propertyId: string, prefix: string): Promise<{ count: number; maxNumber: number | null }> {
  if (!prefix) return { count: 0, maxNumber: null };
  const rows = await prisma.invoice.findMany({
    where: { propertyId, invoiceNumber: { startsWith: prefix } },
    select: { invoiceNumber: true }
  });
  const numbers = rows.map((row) => row.invoiceNumber);
  return { count: numbers.filter((number) => number?.startsWith(prefix)).length, maxNumber: maxIssuedNumber(numbers, prefix) };
}

export type InvoiceSequenceView = InvoiceSequenceRecord & {
  /** Fiscal year of the series (FISC-09); null only for legacy rows not yet backfilled. */
  year: number | null;
  /** Invoice numbers already allocated under the prefix — when > 0 prefix/padding are locked and nextNumber has a floor. */
  issuedCount: number;
  maxIssuedNumber: number | null;
  locked: boolean;
};

export async function getBillingSettings(propertyId: string) {
  // Persistencia tanda 2: Prisma primero, merge con los registros solo-seed.
  const rows = await prisma.invoiceSequence.findMany({ where: { propertyId }, orderBy: [{ sequenceCode: "asc" }, { year: "desc" }] });
  const mapped = rows.map(mapInvoiceSequenceRow);
  for (const sequence of mapped) mirrorRecord(demoStore.invoiceSequences, sequence);
  const yearById = new Map(rows.map((row) => [row.id, row.year]));
  const prefixById = new Map(rows.map((row) => [row.id, row.prefix]));
  const merged = mergeById(mapped, demoStore.invoiceSequences.filter((sequence) => sequence.propertyId === propertyId));
  const invoiceSequences: InvoiceSequenceView[] = [];
  for (const sequence of merged) {
    const prefix = prefixById.get(sequence.id) ?? sequence.prefix ?? "";
    const issued = await issuedNumbersForPrefix(propertyId, prefix);
    invoiceSequences.push({
      ...sequence,
      year: yearById.get(sequence.id) ?? sequenceYearFromPrefix(prefix),
      issuedCount: issued.count,
      maxIssuedNumber: issued.maxNumber,
      locked: issued.count > 0
    });
  }
  return {
    invoiceSequences,
    currentYear: madridYear(),
    complianceBilling: getModuleConfiguration(propertyId, "compliance_billing")
  };
}

export type InvoiceSequencePatch = Partial<Omit<InvoiceSequenceRecord, "invoiceType">> & {
  /** Wizard value (full · simplified · rectifying · credit_note) or AEAT code (F1 · F2 · F3 · R · R1–R5). */
  invoiceType?: string;
  /** Fiscal year of the series; defaults to the year in the prefix, then the current Madrid year. */
  year?: number | null;
};

/**
 * Pure (Tanda 6b · R3): the prefix that patchBillingSettings must check against the
 * sister centres of the same legal entity, or null when this patch cannot open a
 * clash. Only three writes can put two ACTIVE series of the same NIF on one prefix:
 *   (a) creating an active series,
 *   (b) setting or changing the prefix of an active series,
 *   (c) re-activating a closed series (active false → true) — closed series never
 *       clash (a prefix is closed, never renumbered), so a sister centre may have
 *       taken the prefix meanwhile and the re-opening must be checked as if new.
 * A patch that leaves the series closed, or that touches neither the prefix nor
 * the activation of an already-active series, needs no check.
 */
export function seriesPrefixToCheck(input: {
  existing: { prefix: string | null; active: boolean } | null;
  /** Prefix the patch writes (undefined = untouched on an existing row). */
  effectivePrefix: string | undefined;
  patchActive: boolean | undefined;
}): string | null {
  const willBeActive = input.patchActive ?? input.existing?.active ?? true;
  if (!willBeActive) return null;
  const prefix = input.effectivePrefix ?? input.existing?.prefix ?? null;
  if (!prefix) return null;
  if (!input.existing) return prefix;
  const reactivating = input.patchActive === true && !input.existing.active;
  const prefixChanged = input.effectivePrefix !== undefined && input.effectivePrefix !== input.existing.prefix;
  return reactivating || prefixChanged ? prefix : null;
}

/**
 * Tanda 3 (FISC-09): series are keyed by (propertyId, sequenceCode, year). Editing a
 * series that already has invoices cannot change prefix/padding nor lower nextNumber
 * below the highest issued number (409 SERIES_* with details); invoiceType is stored
 * as the AEAT family (F1 / F2 / R) and must agree with the canonical series code.
 */
export async function patchBillingSettings(input: BackOfficeMutationInput & { invoiceSequence?: InvoiceSequencePatch }) {
  requirePermissions(input.context, ["billing.configure"]);
  await requireProperty(input.propertyId);
  const patch = input.invoiceSequence;
  if (!hasText(patch?.sequenceCode) || !hasText(patch?.invoiceType)) {
    throw new BadRequestError("El código de la serie de facturación y el tipo de factura son obligatorios.");
  }
  const sequenceCode = patch.sequenceCode.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,12}$/.test(sequenceCode)) {
    throw new BadRequestError(`Código de serie no válido («${patch.sequenceCode}»): usa hasta 12 caracteres alfanuméricos (p.ej. FAC, SIM, REC).`);
  }
  const invoiceType = seriesInvoiceType(patch.invoiceType);
  assertSeriesCodeMatchesType(sequenceCode, invoiceType);
  if (patch.nextNumber !== undefined && (!Number.isInteger(patch.nextNumber) || patch.nextNumber < 1)) {
    throw new BadRequestError("El siguiente número de la serie debe ser un entero mayor o igual que 1.");
  }
  if (patch.padding !== undefined && (!Number.isInteger(patch.padding) || patch.padding < 1 || patch.padding > 10)) {
    throw new BadRequestError("El número de dígitos de la serie debe estar entre 1 y 10.");
  }
  const prefixInput = patch.prefix === undefined ? undefined : hasText(patch.prefix) ? patch.prefix.trim() : null;
  const year = resolveSequenceYear({ year: patch.year, prefix: prefixInput ?? undefined });
  if (prefixInput && sequenceYearFromPrefix(prefixInput) !== null && sequenceYearFromPrefix(prefixInput) !== year) {
    throw new BadRequestError(`El prefijo «${prefixInput}» lleva el año ${sequenceYearFromPrefix(prefixInput)} pero la serie es del ejercicio ${year}.`);
  }

  // Legacy rows (year NULL, pre-backfill) whose prefix carries this year are adopted in
  // place so the compound unique (propertyId, sequenceCode, year) finds them.
  const legacy = await prisma.invoiceSequence.findFirst({ where: { propertyId: input.propertyId, sequenceCode, year: null } });
  if (legacy && (sequenceYearFromPrefix(legacy.prefix) ?? year) === year) {
    await prisma.invoiceSequence.update({ where: { id: legacy.id }, data: { year } });
  }
  const where = { propertyId_sequenceCode_year: { propertyId: input.propertyId, sequenceCode, year } };
  const existingRow = await prisma.invoiceSequence.findUnique({ where });
  const before = existingRow ? mapInvoiceSequenceRow(existingRow) : undefined;

  // Tanda 6b (L2, design §5.2 R3): the prefix is never NULL. An omitted prefix on a
  // new series — or an explicit reset (`prefix: null`) — takes the R3 default:
  // `${serie}-${año}-` when the legal entity has ONE billing centre (single hotels and
  // new tenants keep FAC-2026-) and `${serie}-${código}-${año}-` when it has several.
  // A prefix that is set or changed is checked against the sister centres of the
  // same legal entity (409 SERIES_PREFIX_CLASH { conflictingPropertyId }): two hotels
  // under one NIF must never both open FAC-2026-.
  const structureRow = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { legalEntityId: true, code: true, kind: true, organizationId: true } });
  const siblingRows = structureRow
    ? await prisma.property.findMany({
        where: {
          id: { not: input.propertyId },
          ...(structureRow.legalEntityId
            ? { OR: [{ legalEntityId: structureRow.legalEntityId }, { legalEntityId: null, organizationId: structureRow.organizationId }] }
            : { organizationId: structureRow.organizationId })
        },
        select: { id: true, kind: true }
      })
    : [];
  const siblingsWithSeries = new Set(
    siblingRows.length === 0
      ? []
      : (await prisma.invoiceSequence.findMany({ where: { propertyId: { in: siblingRows.map((row) => row.id) }, active: true }, select: { propertyId: true } })).map((row) => row.propertyId)
  );
  // An office counts as a billing centre only once it bills (has an active series).
  const billingCentres = 1 + siblingRows.filter((row) => row.kind !== "office" || siblingsWithSeries.has(row.id)).length;
  const defaultPrefix = defaultSeriesPrefix({ series: sequenceCode, year, propertyCode: structureRow?.code ?? null, billingCentres });
  const effectivePrefix: string | undefined =
    prefixInput === null ? defaultPrefix : prefixInput !== undefined ? prefixInput : existingRow ? undefined : defaultPrefix;

  if (existingRow) {
    const issued = await issuedNumbersForPrefix(input.propertyId, existingRow.prefix ?? "");
    const violations = invoiceSequencePatchViolations({
      existing: { prefix: existingRow.prefix, padding: existingRow.padding, nextNumber: existingRow.nextNumber },
      patch: { prefix: effectivePrefix, padding: patch.padding, nextNumber: patch.nextNumber },
      issued
    });
    if (violations.length > 0) {
      throw withDetails(new ConflictError(violations.map((violation) => violation.message).join(" ")), {
        code: violations[0]!.code,
        violations,
        issuedCount: issued.count,
        maxIssuedNumber: issued.maxNumber
      });
    }
  }
  // R3: a closed series never clashes, so RE-OPENING one (active false → true)
  // is checked like a brand-new prefix — a sister centre may have taken it while
  // it was closed (t6b#3).
  const prefixToCheck = seriesPrefixToCheck({
    existing: existingRow ? { prefix: existingRow.prefix, active: existingRow.active } : null,
    effectivePrefix,
    patchActive: patch.active
  });
  const update: Prisma.InvoiceSequenceUncheckedUpdateInput = { invoiceType };
  if (effectivePrefix !== undefined) update.prefix = effectivePrefix;
  if (patch.nextNumber !== undefined) update.nextNumber = patch.nextNumber;
  if (patch.padding !== undefined) update.padding = patch.padding;
  if (patch.active !== undefined) update.active = patch.active;
  if (existingRow && existingRow.legalEntityId === null && structureRow?.legalEntityId) update.legalEntityId = structureRow.legalEntityId;
  const seedOnly = demoStore.invoiceSequences.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.sequenceCode === sequenceCode
  );
  // t6b#1: the sister check and the upsert run under the SAME advisory lock the
  // allocator takes when it opens a series row (`lockSeriesOpening`, keyed by
  // sociedad + year), so two centres of one NIF cannot both open the same prefix
  // from the backoffice under READ COMMITTED; the check itself reads through the
  // transaction client so it sees what the previous holder committed.
  const row = await prisma.$transaction(async (tx) => {
    if (structureRow) await lockSeriesOpening(tx, { legalEntityId: structureRow.legalEntityId, organizationId: structureRow.organizationId }, year);
    if (prefixToCheck !== null) {
      await assertSeriesPrefixFree({ propertyId: input.propertyId, prefix: prefixToCheck, year, excludeSequenceId: existingRow?.id }, tx);
    }
    return tx.invoiceSequence.upsert({
      where,
      update,
      create: {
        id: existingRow?.id ?? seedOnly?.id ?? createId("seq"),
        propertyId: input.propertyId,
        legalEntityId: structureRow?.legalEntityId ?? null,
        sequenceCode,
        prefix: effectivePrefix ?? defaultPrefix,
        nextNumber: patch.nextNumber ?? 1,
        padding: patch.padding ?? 6,
        invoiceType,
        active: patch.active ?? true,
        year
      }
    });
  });
  const sequence = mirrorRecord(demoStore.invoiceSequences, mapInvoiceSequenceRow(row), (candidate) => candidate.id === row.id);
  audit({
    ...input,
    action: before ? "InvoiceSequenceUpdated" : "InvoiceSequenceCreated",
    entityType: "invoice_sequence",
    entityId: sequence.id,
    beforeJson: before,
    afterJson: { ...sequence, year: row.year }
  });
  return getBillingSettings(input.propertyId);
}

export async function getAccountingSettings(propertyId: string) {
  // Persistencia tanda 2: Prisma primero, fallback al registro solo-seed.
  const row = await prisma.accountingSetting.findFirst({ where: { propertyId } });
  const settings = row
    ? mirrorRecord(demoStore.accountingSettings, mapAccountingRow(row), (candidate) => candidate.propertyId === row.propertyId)
    : demoStore.accountingSettings.find((candidate) => candidate.propertyId === propertyId);
  return {
    settings,
    costCenters: demoStore.costCenters.filter((costCenter) => costCenter.propertyId === propertyId)
  };
}

export async function patchAccountingSettings(input: BackOfficeMutationInput & { patch: Partial<AccountingSettingsRecord> }) {
  requirePermissions(input.context, ["accounting.configure"]);
  const settings = await requireAccountingSettings(input.propertyId);
  const before = { ...settings };
  // Persistencia tanda 2: Prisma primero (id/organizationId/propertyId no son
  // parcheables), después espejo con la fila mapeada.
  const data: Prisma.AccountingSettingUncheckedUpdateInput = {};
  if (input.patch.chartTemplate !== undefined) data.chartTemplate = input.patch.chartTemplate;
  if (input.patch.fiscalYearStartMonth !== undefined) data.fiscalYearStartMonth = input.patch.fiscalYearStartMonth;
  if (input.patch.configurationJson !== undefined) data.configurationJson = asJson(input.patch.configurationJson);
  const row = await prisma.accountingSetting.update({ where: { id: settings.id }, data });
  Object.assign(settings, mapAccountingRow(row));
  audit({ ...input, action: "AccountingSettingsUpdated", entityType: "accounting_settings", entityId: settings.id, beforeJson: before, afterJson: settings });
  return settings;
}

/**
 * CFG-P1-4: Prisma-first AI settings. Hotels without a PropertyAiSetting row get
 * explicit defaults (`provisioned: false`, `settings` is always present); the row
 * is created by the first PATCH. toolSettings stay in memory (out of scope).
 */
export async function getAiSettings(propertyId: string) {
  const { settings, provisioned } = await resolveAiSettings(propertyId);
  return {
    settings,
    provisioned,
    toolSettings: demoStore.propertyAiToolSettings.filter((tool) => tool.propertyId === propertyId)
  };
}

export async function patchAiSettings(input: BackOfficeMutationInput & { patch: Partial<PropertyAiSettingsRecord> }) {
  requirePermissions(input.context, ["ai.configure"]);
  if (input.patch.configurationJson?.documentImageRetentionPolicy === "store_by_default") {
    throw new BadRequestError("La configuración de IA no puede permitir por defecto el almacenamiento de imágenes de documentos de identidad.");
  }
  const { settings: current, provisioned } = await resolveAiSettings(input.propertyId);
  const before = { ...current };
  // Prisma first: upsert by propertyId so a missing row is created from the current
  // values (defaults or seed record) merged with the patch; then mirror the mapped row.
  const data: Prisma.PropertyAiSettingUncheckedUpdateInput = {};
  if (input.patch.aiEnabled !== undefined) data.aiEnabled = input.patch.aiEnabled;
  if (input.patch.defaultAutomationLevel !== undefined) data.defaultAutomationLevel = input.patch.defaultAutomationLevel;
  if (input.patch.guestFacingDisclosure !== undefined) data.guestFacingDisclosure = input.patch.guestFacingDisclosure;
  if (input.patch.voiceLocales !== undefined) data.voiceLocales = input.patch.voiceLocales;
  if (input.patch.configurationJson !== undefined) data.configurationJson = asJson(input.patch.configurationJson);
  const row = await prisma.propertyAiSetting.upsert({
    where: { propertyId: input.propertyId },
    update: data,
    create: {
      id: current.id,
      propertyId: input.propertyId,
      aiEnabled: input.patch.aiEnabled ?? current.aiEnabled,
      defaultAutomationLevel: input.patch.defaultAutomationLevel ?? current.defaultAutomationLevel,
      guestFacingDisclosure: input.patch.guestFacingDisclosure !== undefined ? input.patch.guestFacingDisclosure : current.guestFacingDisclosure ?? null,
      voiceLocales: input.patch.voiceLocales ?? current.voiceLocales,
      configurationJson: asJson(input.patch.configurationJson ?? current.configurationJson)
    }
  });
  const settings = mirrorRecord(demoStore.propertyAiSettings, mapAiSettingsRow(row), byPropertyId(input.propertyId));
  audit({
    ...input,
    action: provisioned ? "AISettingsUpdated" : "AISettingsProvisioned",
    entityType: "property_ai_settings",
    entityId: settings.id,
    beforeJson: before,
    afterJson: settings
  });
  return settings;
}

export async function listDocumentTemplates(propertyId: string) {
  // Persistencia tanda 2: Prisma primero, merge con los registros solo-seed
  // (p.ej. tpl_welcome_es) y refresco del espejo.
  const rows = await prisma.documentTemplate.findMany({ where: { propertyId } });
  const mapped = rows.map(mapDocumentTemplateRow);
  for (const template of mapped) mirrorRecord(demoStore.documentTemplates, template);
  return mergeById(mapped, demoStore.documentTemplates.filter((template) => template.propertyId === propertyId));
}

export async function createDocumentTemplate(input: BackOfficeMutationInput & {
  template: Pick<DocumentTemplateRecord, "templateCode" | "name" | "channel" | "language" | "body"> & Partial<DocumentTemplateRecord>;
}) {
  requirePermissions(input.context, ["templates.manage"]);
  const duplicateInPrisma = await prisma.documentTemplate.findUnique({
    where: {
      propertyId_templateCode_language: {
        propertyId: input.propertyId,
        templateCode: input.template.templateCode,
        language: input.template.language
      }
    },
    select: { id: true }
  });
  if (
    duplicateInPrisma ||
    demoStore.documentTemplates.some(
      (template) =>
        template.propertyId === input.propertyId &&
        template.templateCode === input.template.templateCode &&
        template.language === input.template.language
    )
  ) {
    throw new ConflictError("El código y el idioma de la plantilla deben ser únicos por propiedad.");
  }
  const record: DocumentTemplateRecord = {
    id: createId("tpl"),
    propertyId: input.propertyId,
    templateCode: input.template.templateCode,
    name: input.template.name,
    channel: input.template.channel,
    language: input.template.language,
    subject: input.template.subject,
    body: input.template.body,
    variablesJson: input.template.variablesJson ?? {},
    active: input.template.active ?? true,
    updatedAt: nowIso()
  };
  // Persistencia tanda 2: Prisma primero (mismo id), después espejo (updatedAt
  // de la fila para no divergir del @updatedAt de la BD).
  const row = await prisma.documentTemplate.create({ data: documentTemplateToDbRow(record) });
  Object.assign(record, mapDocumentTemplateRow(row));
  demoStore.documentTemplates.push(record);
  audit({ ...input, action: "TemplateCreated", entityType: "document_template", entityId: record.id, afterJson: record });
  return record;
}

export async function updateDocumentTemplate(input: BackOfficeMutationInput & {
  templateId: string;
  patch: { subject?: string; body?: string; active?: boolean };
}) {
  requirePermissions(input.context, ["templates.manage"]);
  const template = await requireDocumentTemplate(input.propertyId, input.templateId);
  const before = { ...template };
  // Persistencia tanda 2: Prisma primero, después espejo con la fila mapeada.
  const data: Prisma.DocumentTemplateUncheckedUpdateInput = {};
  if (input.patch.subject !== undefined) data.subject = input.patch.subject;
  if (input.patch.body !== undefined) data.body = input.patch.body;
  if (input.patch.active !== undefined) data.active = input.patch.active;
  const row = await prisma.documentTemplate.update({ where: { id: template.id }, data });
  Object.assign(template, mapDocumentTemplateRow(row));
  audit({ ...input, action: "TemplateUpdated", entityType: "document_template", entityId: template.id, beforeJson: before, afterJson: template });
  return template;
}

export function generateQrCode(input: BackOfficeMutationInput & Omit<QrCodeRecord, "id" | "propertyId" | "active" | "createdAt">) {
  requirePermissions(input.context, ["property.map.manage"]);
  let code = demoStore.qrCodes.find(
    (candidate) =>
      candidate.propertyId === input.propertyId &&
      candidate.entityType === input.entityType &&
      candidate.entityId === input.entityId &&
      candidate.purpose === input.purpose
  );
  if (!code) {
    code = {
      id: createId("qr"),
      propertyId: input.propertyId,
      entityType: input.entityType,
      entityId: input.entityId,
      qrValue: input.qrValue,
      purpose: input.purpose,
      active: true,
      createdAt: nowIso()
    };
    demoStore.qrCodes.push(code);
  }
  audit({ ...input, action: "QRCodeGenerated", entityType: "qr_code", entityId: code.id, afterJson: code });
  return code;
}

/** @deprecated L2: sin ruta (L2-02 retira GET …/qr-codes). */
export function listQrCodes(propertyId: string) {
  return demoStore.qrCodes.filter((code) => code.propertyId === propertyId);
}

export function generateBulkQrCodes(input: BackOfficeMutationInput & {
  items: Array<Omit<QrCodeRecord, "id" | "propertyId" | "active" | "createdAt">>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const codes = input.items.map((item) =>
    generateQrCode({
      context: input.context,
      propertyId: input.propertyId,
      correlationId: input.correlationId,
      ...item
    })
  );
  audit({
    ...input,
    action: "QRCodeBulkGenerated",
    entityType: "qr_code",
    afterJson: { generatedCount: codes.length, codes }
  });
  return { status: "generated" as const, generatedCount: codes.length, codes };
}

function parseRoomRangeFromPrompt(prompt: string) {
  const match = prompt.match(/(\d{3,4})\s*(?:to|-|through|a)\s*(\d{3,4})/i);
  if (!match) {
    return undefined;
  }
  return { roomRangeStart: match[1], roomRangeEnd: match[2] };
}

function makeBackOfficeProposal(prompt: string): Record<string, unknown> {
  const lower = prompt.toLowerCase();
  const roomRange = parseRoomRangeFromPrompt(prompt);
  if (roomRange) {
    const start = Number(roomRange.roomRangeStart);
    const end = Number(roomRange.roomRangeEnd);
    const count = Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start + 1);
    return {
      action: "create_room_range",
      ...roomRange,
      roomTypeId: "rt_double",
      buildingId: "bld_main",
      floorId: lower.includes("floor 4") || lower.includes("planta 4") ? "floor_4" : "floor_1",
      zoneId: lower.includes("floor 4") || lower.includes("planta 4") ? "zone_f4_east" : "zone_lobby",
      preview: `Will create up to ${count} rooms after confirmation. Existing room numbers will be skipped.`
    };
  }
  if (lower.includes("housekeeping") || lower.includes("limpieza")) {
    return {
      action: "create_housekeeping_sections_by_floor",
      preview: "Will create one housekeeping section per active floor and assign rooms by floor after confirmation."
    };
  }
  if (lower.includes("bienvenida") || lower.includes("welcome")) {
    return {
      action: "create_template",
      templateCode: "welcome_message_ai_draft",
      preview: "Will create a welcome-message template draft in Spanish and English after confirmation."
    };
  }
  return {
    action: "review_readiness",
    preview: "Will review setup readiness, module health and blocking go-live checks."
  };
}

/** @deprecated L2: sin ruta (L2-02 retira GET …/ai/suggestions). */
export function listBackOfficeAiSuggestions(propertyId: string) {
  return demoStore.backOfficeAiSuggestions.filter((suggestion) => suggestion.propertyId === propertyId).slice().reverse();
}

export function createBackOfficeAiSuggestion(input: BackOfficeMutationInput & { prompt: string }) {
  requirePermissions(input.context, ["ai.configure"]);
  const suggestion: BackOfficeAiSuggestionRecord = {
    id: createId("boai"),
    propertyId: input.propertyId,
    userId: input.context.userId,
    prompt: input.prompt,
    status: "previewed",
    proposedChangesJson: makeBackOfficeProposal(input.prompt),
    requiresConfirmation: true,
    createdAt: nowIso()
  };
  demoStore.backOfficeAiSuggestions.push(suggestion);
  audit({
    ...input,
    action: "BackOfficeAiSuggestionCreated",
    entityType: "backoffice_ai_suggestion",
    entityId: suggestion.id,
    afterJson: suggestion
  });
  return suggestion;
}

export async function applyBackOfficeAiSuggestion(input: BackOfficeMutationInput & { suggestionId: string }) {
  requirePermissions(input.context, ["ai.configure"]);
  const suggestion = demoStore.backOfficeAiSuggestions.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.id === input.suggestionId
  );
  if (!suggestion) {
    throw new NotFoundError("Sugerencia de IA de Back Office no encontrada.");
  }
  if (suggestion.status !== "previewed" || !suggestion.requiresConfirmation) {
    throw new ConflictError("La IA no puede aplicar cambios de Back Office sin previsualización y confirmación.");
  }

  const before = { ...suggestion };
  let result: unknown;
  const action = suggestion.proposedChangesJson.action;
  if (action === "create_room_range") {
    const start = suggestion.proposedChangesJson.roomRangeStart as string;
    const end = suggestion.proposedChangesJson.roomRangeEnd as string;
    const roomNumbers = Array.from({ length: Number(end) - Number(start) + 1 }, (_, index) => roomNumberFromRange(start, index)).filter(
      (number) => !demoStore.rooms.some((room) => room.propertyId === input.propertyId && room.number === number)
    );
    result =
      roomNumbers.length === 0
        ? { status: "skipped", reason: "All room numbers already exist." }
        : await bulkCreateRooms({
            context: input.context,
            propertyId: input.propertyId,
            correlationId: input.correlationId,
            roomTypeId: suggestion.proposedChangesJson.roomTypeId as string,
            roomNumbers,
            buildingId: suggestion.proposedChangesJson.buildingId as string,
            floorId: suggestion.proposedChangesJson.floorId as string,
            zoneId: suggestion.proposedChangesJson.zoneId as string,
            sellable: true,
            active: true
          });
  } else if (action === "create_housekeeping_sections_by_floor") {
    const floors = demoStore.floors
      .filter((floor) => floor.propertyId === input.propertyId && floor.active)
      .filter((floor) => !demoStore.housekeepingSections.some((section) => section.propertyId === input.propertyId && section.code === `HK_${floor.code ?? floor.id}`));
    const created: HousekeepingSectionRecord[] = [];
    for (const floor of floors) {
      created.push(
        await createHousekeepingSection({
          context: input.context,
          propertyId: input.propertyId,
          correlationId: input.correlationId,
          section: { name: `${floor.name} housekeeping`, code: `HK_${floor.code ?? floor.id}`, active: true }
        })
      );
    }
    result = { status: "created", createdCount: created.length, sections: created };
  } else if (action === "create_template") {
    result = await createDocumentTemplate({
      context: input.context,
      propertyId: input.propertyId,
      correlationId: input.correlationId,
      template: {
        templateCode: suggestion.proposedChangesJson.templateCode as string,
        name: "AI drafted welcome message",
        channel: "email",
        language: "es",
        subject: "Bienvenida a Hotel Demo Madrid Centro",
        body: "Hola {{guest_name}}, soy el asistente AI del hotel. Recepcion puede ayudarte en cualquier momento.",
        variablesJson: { guest_name: "Guest name" },
        active: false
      }
    });
  } else {
    result = await getReadiness(input.propertyId);
  }

  suggestion.status = "applied";
  suggestion.appliedAt = nowIso();
  audit({
    ...input,
    action: "BackOfficeAiSuggestionApplied",
    entityType: "backoffice_ai_suggestion",
    entityId: suggestion.id,
    beforeJson: before,
    afterJson: { suggestion, result }
  });
  return { suggestion, result };
}

export function listBackOfficeAudit(propertyId: string) {
  return demoStore.auditEvents.filter((event) => event.propertyId === propertyId).slice(-50).reverse();
}
