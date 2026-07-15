import type { HotelModuleCode } from "@hotelos/product";
import { getHotelModuleManifest, getManualSetupOption, HOTEL_MODULES, MANUAL_SETUP_COVERAGE_SUMMARY, MANUAL_SETUP_OPTIONS } from "@hotelos/product";
import { PERMISSIONS, ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { ensurePropertyModulePersisted } from "../product-modules/product-modules.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { ConflictError } from "../../lib/http-error.js";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
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
  housekeepingStatus: string | null;
  maintenanceStatus: string | null;
  sellable: boolean;
  active: boolean;
  sortOrder: number;
}): RoomRecord {
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
    housekeepingStatus: (row.housekeepingStatus ?? "clean") as RoomRecord["housekeepingStatus"],
    maintenanceStatus: (row.maintenanceStatus ?? "ok") as RoomRecord["maintenanceStatus"],
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

async function resolveOrganization(organizationId: string): Promise<OrganizationRecord> {
  const memory = demoStore.organization;
  const row: OrganizationRow | null = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!row) return memory;
  return { id: row.id, name: row.name, legalName: row.legalName ?? memory.legalName, taxId: row.taxId ?? memory.taxId };
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
    throw new Error("Department was not found.");
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
    throw new Error("Housekeeping section was not found.");
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
    throw new Error("Maintenance area was not found.");
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
      throw new Error("All assigned rooms must belong to the property.");
    }
  }
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
 * Usuario para mutaciones: Prisma primero; un usuario solo-seed se materializa
 * (skipDuplicates protege contra el unique de email). `persisted` indica si la
 * fila existe en la BD tras el intento — si no, se muta solo el espejo.
 */
async function requireBackOfficeUser(userId: string): Promise<{ user: UserRecord; persisted: boolean }> {
  const row = await prisma.user.findUnique({ where: { id: userId } });
  if (row) return { user: mirrorRecord(demoStore.users, mapUserRow(row)), persisted: true };
  const legacy = demoStore.users.find((candidate) => candidate.id === userId);
  if (!legacy) {
    throw new Error("User was not found.");
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
    throw new Error("Accounting settings were not found.");
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

async function requireAiSettings(propertyId: string): Promise<PropertyAiSettingsRecord> {
  const row = await prisma.propertyAiSetting.findUnique({ where: { propertyId } });
  if (row) {
    return mirrorRecord(demoStore.propertyAiSettings, mapAiSettingsRow(row), (candidate) => candidate.propertyId === row.propertyId);
  }
  const legacy = demoStore.propertyAiSettings.find((candidate) => candidate.propertyId === propertyId);
  if (!legacy) {
    throw new Error("AI settings were not found.");
  }
  await prisma.propertyAiSetting.createMany({
    data: [
      {
        id: legacy.id,
        propertyId: legacy.propertyId,
        aiEnabled: legacy.aiEnabled,
        defaultAutomationLevel: legacy.defaultAutomationLevel,
        guestFacingDisclosure: legacy.guestFacingDisclosure ?? null,
        voiceLocales: legacy.voiceLocales,
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
    throw new Error("Template was not found.");
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

type CategoryMode = "system_controlled" | "property_editable" | "property_extendable" | "read_only";

type CategoryDefinitionRecord = {
  id: string;
  code: string;
  name: string;
  description?: string;
  categoryGroup:
    | "Property"
    | "Rooms"
    | "Spaces & Resources"
    | "Operations"
    | "Maintenance"
    | "Housekeeping"
    | "Revenue"
    | "Distribution"
    | "Guest Experience"
    | "Finance"
    | "Compliance"
    | "POS"
    | "Assets"
    | "Safety"
    | "Reservations"
    | "AI";
  entityType?: string;
  mode: CategoryMode;
  valueSchemaJson: Record<string, unknown>;
  isCore: boolean;
  active: boolean;
  sortOrder: number;
};

type PropertyCategoryOptionRecord = {
  id: string;
  propertyId: string;
  categoryDefinitionId: string;
  code: string;
  label: string;
  description?: string;
  colorToken?: string;
  iconName?: string;
  parentOptionId?: string;
  metadataJson: Record<string, unknown>;
  isSystemDefault: boolean;
  active: boolean;
  sortOrder: number;
  createdBy?: string;
  updatedBy?: string;
  usageCount: number;
};

type PropertyCustomFieldDefinitionRecord = {
  id: string;
  propertyId: string;
  entityType: string;
  fieldKey: string;
  label: string;
  description?: string;
  dataType: "text" | "number" | "boolean" | "date" | "datetime" | "select" | "multi_select" | "money" | "percentage" | "json";
  required: boolean;
  searchable: boolean;
  visibleInList: boolean;
  visibleInDetail: boolean;
  optionsCategoryDefinitionId?: string;
  validationJson: Record<string, unknown>;
  visibilityRulesJson: Record<string, unknown>;
  defaultValueJson: Record<string, unknown>;
  active: boolean;
  sortOrder: number;
};

type PropertyCustomFieldValueRecord = {
  id: string;
  propertyId: string;
  entityType: string;
  entityId: string;
  fieldDefinitionId: string;
  valueJson: Record<string, unknown>;
};

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
  options?: string[];
  mapsTo?: string;
};

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

const categoryDefinitions: CategoryDefinitionRecord[] = [
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

const propertyCategoryOptions: PropertyCategoryOptionRecord[] = [
  { id: "catopt_standard_room_type", propertyId: "prop_123", categoryDefinitionId: "catdef_room_type_categories", code: "standard", label: "Standard", colorToken: "color.surface.raised", iconName: "Hotel", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 5, usageCount: 30 },
  { id: "catopt_balcony", propertyId: "prop_123", categoryDefinitionId: "catdef_room_features", code: "balcony", label: "Balcony", colorToken: "color.status.info", iconName: "Building2", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 12 },
  { id: "catopt_sea_view", propertyId: "prop_123", categoryDefinitionId: "catdef_room_features", code: "sea_view", label: "Sea view", colorToken: "color.brand.electricBlue", iconName: "Waves", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 8 },
  { id: "catopt_king", propertyId: "prop_123", categoryDefinitionId: "catdef_bed_types", code: "king_bed", label: "King bed", colorToken: "color.brand.deepIndigo", iconName: "BedDouble", metadataJson: { capacity: 2 }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 18 },
  { id: "catopt_parking", propertyId: "prop_123", categoryDefinitionId: "catdef_space_types", code: "parking_space", label: "Parking space", colorToken: "color.semantic.success", iconName: "SquareParking", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 20 },
  { id: "catopt_direct", propertyId: "prop_123", categoryDefinitionId: "catdef_channel_categories", code: "direct", label: "Direct", colorToken: "color.semantic.success", iconName: "Globe", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 240 },
  { id: "catopt_ota", propertyId: "prop_123", categoryDefinitionId: "catdef_channel_categories", code: "ota", label: "OTA", colorToken: "color.semantic.warning", iconName: "Share2", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 380 },
  { id: "catopt_history", propertyId: "prop_123", categoryDefinitionId: "catdef_revenue_report_fields", code: "history", label: "History", colorToken: "color.brand.nightBlue", iconName: "History", metadataJson: { legacyReportSection: "History" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 31 },
  { id: "catopt_forecast", propertyId: "prop_123", categoryDefinitionId: "catdef_revenue_report_fields", code: "forecast", label: "Forecast", colorToken: "color.brand.violet", iconName: "TrendingUp", metadataJson: { legacyReportSection: "Forecast" }, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 31 },
  { id: "catopt_source_direct_web", propertyId: "prop_123", categoryDefinitionId: "catdef_reservation_source_codes", code: "direct_web", label: "Direct web", colorToken: "color.semantic.success", iconName: "Globe", metadataJson: { channel: "direct" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 28 },
  { id: "catopt_source_phone", propertyId: "prop_123", categoryDefinitionId: "catdef_reservation_source_codes", code: "phone", label: "Phone", colorToken: "color.brand.nightBlue", iconName: "Phone", metadataJson: { channel: "direct" }, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 12 },
  { id: "catopt_res_confirmed", propertyId: "prop_123", categoryDefinitionId: "catdef_reservation_statuses", code: "confirmed", label: "Confirmed", colorToken: "color.semantic.success", iconName: "CircleCheck", metadataJson: { internalStatus: "confirmed" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 36 },
  { id: "catopt_res_cancelled", propertyId: "prop_123", categoryDefinitionId: "catdef_reservation_statuses", code: "cancelled", label: "Cancelled", colorToken: "color.semantic.danger", iconName: "CircleX", metadataJson: { internalStatus: "cancelled" }, isSystemDefault: true, active: true, sortOrder: 50, usageCount: 4 },
  { id: "catopt_guarantee_card", propertyId: "prop_123", categoryDefinitionId: "catdef_guarantee_policies", code: "card_guarantee", label: "Card guarantee", colorToken: "color.semantic.warning", iconName: "CreditCard", metadataJson: { requiresPaymentToken: true }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 30 },
  { id: "catopt_cancel_flexible", propertyId: "prop_123", categoryDefinitionId: "catdef_cancellation_policies", code: "flexible_18", label: "Flexible until 18:00 previous day", colorToken: "color.semantic.success", iconName: "Undo2", metadataJson: { cutoff: "18:00_previous_day" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 44 },
  { id: "catopt_billing_guest", propertyId: "prop_123", categoryDefinitionId: "catdef_billing_instruction_types", code: "guest_pays_checkout", label: "Guest pays at checkout", colorToken: "color.brand.electricBlue", iconName: "Receipt", metadataJson: { invoiceCustomerType: "guest" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 24 },
  { id: "catopt_billing_company", propertyId: "prop_123", categoryDefinitionId: "catdef_billing_instruction_types", code: "company_invoice", label: "Company invoice", colorToken: "color.brand.deepIndigo", iconName: "Building2", metadataJson: { invoiceCustomerType: "company" }, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 8 },
  { id: "catopt_dni", propertyId: "prop_123", categoryDefinitionId: "catdef_document_types", code: "DNI", label: "DNI", colorToken: "color.semantic.warning", iconName: "IdCard", metadataJson: { officialCode: true }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 42 }
];

const customFieldDefinitions: PropertyCustomFieldDefinitionRecord[] = [
  { id: "cf_room_internal_notes", propertyId: "prop_123", entityType: "room", fieldKey: "internal_notes", label: "Internal notes", dataType: "text", required: false, searchable: true, visibleInList: false, visibleInDetail: true, validationJson: {}, visibilityRulesJson: {}, defaultValueJson: {}, active: true, sortOrder: 10 },
  { id: "cf_guest_vip_reason", propertyId: "prop_123", entityType: "guest", fieldKey: "vip_reason", label: "VIP reason", dataType: "select", required: false, searchable: true, visibleInList: true, visibleInDetail: true, optionsCategoryDefinitionId: "catdef_market_segments", validationJson: {}, visibilityRulesJson: {}, defaultValueJson: {}, active: true, sortOrder: 20 }
];

const customFieldValues: PropertyCustomFieldValueRecord[] = [
  { id: "cfv_room_432_notes", propertyId: "prop_123", entityType: "room", entityId: "room_432", fieldDefinitionId: "cf_room_internal_notes", valueJson: { value: "Quiet high-floor guest preference." } }
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
      { key: "legalName", label: "Legal name", inputType: "text", required: true, mapsTo: "properties.legal_name" },
      { key: "taxId", label: "Tax ID", inputType: "text", required: true, mapsTo: "organizations.tax_id" },
      { key: "address", label: "Address", inputType: "textarea", required: true, mapsTo: "properties.address" },
      { key: "country", label: "Country", inputType: "select", required: true, options: ["ES", "PT", "FR", "IT"], mapsTo: "properties.country" },
      { key: "region", label: "Region", inputType: "text", mapsTo: "properties.tax_region" },
      { key: "province", label: "Province", inputType: "text", mapsTo: "properties.province" },
      { key: "city", label: "City", inputType: "text", required: true, mapsTo: "properties.municipality" },
      { key: "postalCode", label: "Postal code", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.postalCode" },
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
      { key: "taxRegion", label: "Tax region", inputType: "select", options: ["Mainland Spain", "Canary Islands", "Ceuta", "Melilla"], mapsTo: "properties.tax_region" },
      { key: "tourismTaxRegion", label: "Tourism tax region", inputType: "select", options: ["None", "Catalonia", "Balearic Islands"], mapsTo: "property_compliance_settings.tourism_tax_region" },
      { key: "businessDateRules", label: "Business date rules", inputType: "textarea", mapsTo: "property_setup_form_submissions.payload_json.businessDateRules" }
    ],
    dataQualityChecks: ["legal_profile_complete", "timezone_configured", "tax_region_configured"]
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
      { key: "taxRegion", label: "Tax region", inputType: "text", required: true, mapsTo: "property_compliance_settings.tax_region" },
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

function requireProperty(propertyId: string) {
  const property = demoStore.properties.find((candidate) => candidate.id === propertyId);
  if (!property) {
    throw new Error("Property was not found.");
  }
  return property;
}

function requireCategoryDefinition(categoryCode: string) {
  const definition = categoryDefinitions.find((candidate) => candidate.code === categoryCode && candidate.active);
  if (!definition) {
    throw new Error(`Category definition was not found: ${categoryCode}`);
  }
  return definition;
}

function requireCategoryOption(propertyId: string, optionId: string) {
  const option = propertyCategoryOptions.find((candidate) => candidate.id === optionId && candidate.propertyId === propertyId);
  if (!option) {
    throw new Error(`Category option was not found: ${optionId}`);
  }
  return option;
}

function categoryOptionUsage(optionId: string) {
  return propertyCategoryOptions.find((option) => option.id === optionId)?.usageCount ?? 0;
}

function assertCategoryModeAllowsEdit(definition: CategoryDefinitionRecord, patch?: Record<string, unknown>) {
  if (definition.mode === "read_only") {
    throw new Error("Read-only categories cannot be edited.");
  }
  if (definition.mode === "system_controlled" && (patch?.code !== undefined || patch?.label !== undefined)) {
    throw new Error("System-controlled legal category codes and labels cannot be renamed.");
  }
}

function categoryWithOptions(propertyId: string, definition: CategoryDefinitionRecord) {
  const options = propertyCategoryOptions
    .filter((option) => option.propertyId === propertyId && option.categoryDefinitionId === definition.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((option) => ({
      ...option,
      canDelete: option.usageCount === 0 && !option.isSystemDefault,
      canDeactivate: true,
      linkedRecordsUrl: `/backoffice/properties/${propertyId}/configuration/categories/${definition.code}?option=${option.id}`
    }));
  return {
    ...definition,
    options,
    activeOptions: options.filter((option) => option.active).length,
    inactiveOptions: options.filter((option) => !option.active).length
  };
}

function configurationDataQuality(propertyId: string) {
  const rooms = demoStore.rooms.filter((room) => room.propertyId === propertyId);
  const roomTypes = demoStore.roomTypes.filter((roomType) => roomType.propertyId === propertyId);
  return [
    {
      code: "rooms_without_room_type",
      severity: rooms.some((room) => room.sellable && !room.roomTypeId) ? "blocking" : "info",
      message: "Sellable rooms must have an active room type."
    },
    {
      code: "rooms_without_building_floor_zone",
      severity: rooms.some((room) => !room.buildingId || !room.floorId || !room.zoneId) ? "warning" : "info",
      message: "Rooms should be mapped to building, floor and zone."
    },
    {
      code: "room_type_without_rooms",
      severity: roomTypes.some((roomType) => !rooms.some((room) => room.roomTypeId === roomType.id)) ? "warning" : "info",
      message: "Room types without rooms should be reviewed."
    },
    {
      code: "inactive_category_still_used_by_active_records",
      severity: propertyCategoryOptions.some((option) => option.propertyId === propertyId && !option.active && option.usageCount > 0) ? "warning" : "info",
      message: "Inactive category options remain visible in historical records and should be reviewed."
    },
    {
      code: "duplicate_option_codes",
      severity: "info",
      message: "Property/category option codes are unique by database constraint."
    }
  ];
}

function propertySetupFormDefinition(formCode: string) {
  const definition = PROPERTY_SETUP_FORM_DEFINITIONS.find((candidate) => candidate.code === formCode);
  if (!definition) {
    throw new Error(`Property setup form was not found: ${formCode}`);
  }
  return definition;
}

function manualSetupOptionDefinition(optionCode: string) {
  const option = getManualSetupOption(optionCode);
  if (!option) {
    throw new Error(`Manual setup option was not found: ${optionCode}`);
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
    .map((input) => `${input} is required for ${option.label}.`);
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

function completePropertySetupStep(input: BackOfficeMutationInput, stepCode: string, metadataJson: Record<string, unknown>) {
  let step = demoStore.propertySetupSteps.find((candidate) => candidate.propertyId === input.propertyId && candidate.stepCode === stepCode);
  if (!step) {
    step = {
      id: createId("setup"),
      propertyId: input.propertyId,
      stepCode,
      status: "completed",
      completedAt: nowIso(),
      completedBy: input.context.userId,
      metadataJson
    };
    demoStore.propertySetupSteps.push(step);
  } else {
    step.status = "completed";
    step.completedAt = nowIso();
    step.completedBy = input.context.userId;
    step.metadataJson = { ...step.metadataJson, ...metadataJson };
  }
  return step;
}

function createCategoryOptionFromSetup(input: BackOfficeMutationInput, categoryCode: string, label: string) {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) return undefined;
  const definition = requireCategoryDefinition(categoryCode);
  const code = trimmedLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const existing = propertyCategoryOptions.find(
    (option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id && option.code === code
  );
  if (existing) return existing;
  const record: PropertyCategoryOptionRecord = {
    id: createId("catopt"),
    propertyId: input.propertyId,
    categoryDefinitionId: definition.id,
    code,
    label: trimmedLabel,
    metadataJson: { createdFrom: "property_setup_form" },
    isSystemDefault: false,
    active: true,
    sortOrder: propertyCategoryOptions.length + 1,
    createdBy: input.context.userId,
    usageCount: 0
  };
  propertyCategoryOptions.push(record);
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
    .map((field) => `${field.label} is required.`);
}

async function formExistingData(propertyId: string, formCode: string) {
  switch (formCode) {
    case "property_profile": {
      // Persistencia tanda 2: la vista de "datos existentes" confirma el guardado →
      // lee Prisma (fallback in-memory) para que sobreviva al reinicio.
      requireProperty(propertyId);
      const property = await resolveProperty(propertyId);
      return {
        property,
        organization: await resolveOrganization(property?.organizationId ?? demoStore.organization.id),
        compliance: await getComplianceSettings(propertyId)
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
      const property = requireProperty(input.propertyId);
      const before = { property: { ...property }, organization: { ...demoStore.organization } };
      // Persistencia tanda 2: Prisma primero (Property + Organization), después espejo.
      const nextProperty: PropertyRecord = {
        ...property,
        name: payloadText(payload, "name", property.name),
        legalName: payloadText(payload, "legalName", property.legalName ?? property.name),
        address: payloadText(payload, "address", property.address ?? ""),
        country: payloadText(payload, "country", property.country),
        municipality: payloadText(payload, "city", property.municipality ?? ""),
        province: payloadText(payload, "province", property.province ?? ""),
        timezone: payloadText(payload, "timezone", property.timezone),
        taxRegion: payloadText(payload, "taxRegion", payloadText(payload, "region", property.taxRegion ?? ""))
      };
      const nextOrganization: OrganizationRecord = {
        ...demoStore.organization,
        legalName: payloadText(payload, "legalName", demoStore.organization.legalName),
        taxId: payloadText(payload, "taxId", demoStore.organization.taxId)
      };
      const propertyData = {
        name: nextProperty.name,
        legalName: nextProperty.legalName ?? null,
        address: nextProperty.address ?? null,
        municipality: nextProperty.municipality ?? null,
        province: nextProperty.province ?? null,
        country: nextProperty.country,
        taxRegion: nextProperty.taxRegion ?? null,
        timezone: nextProperty.timezone
      };
      // upsert: tolera properties que solo existen en el seed in-memory (p.ej. prop_456).
      await prisma.property.upsert({
        where: { id: property.id },
        update: propertyData,
        create: {
          id: property.id,
          organizationId: property.organizationId,
          ...propertyData,
          sesHospedajesEnabled: property.sesHospedajesEnabled,
          verifactuEnabled: property.verifactuEnabled
        }
      });
      await prisma.organization.upsert({
        where: { id: nextOrganization.id },
        update: { legalName: nextOrganization.legalName, taxId: nextOrganization.taxId },
        create: { id: nextOrganization.id, name: nextOrganization.name, legalName: nextOrganization.legalName, taxId: nextOrganization.taxId }
      });
      Object.assign(property, nextProperty);
      if (demoStore.property.id === property.id) Object.assign(demoStore.property, property);
      Object.assign(demoStore.organization, nextOrganization);
      const compliance = demoStore.propertyComplianceSettings.find((candidate) => candidate.propertyId === input.propertyId);
      if (compliance) {
        const nextCompliance: PropertyComplianceSettingsRecord = {
          ...compliance,
          taxRegion: payloadText(payload, "taxRegion", compliance.taxRegion ?? ""),
          tourismTaxRegion: payloadText(payload, "tourismTaxRegion", compliance.tourismTaxRegion ?? ""),
          updatedAt: nowIso()
        };
        const persisted = await persistComplianceSettings(nextCompliance);
        Object.assign(compliance, persisted);
      }
      audit({ ...input, action: "PropertyProfileUpdated", entityType: "property", entityId: property.id, beforeJson: before, afterJson: { property, organization: demoStore.organization, compliance } });
      return { targetEntityType: "property", targetEntityId: property.id, result: property };
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
        createCategoryOptionFromSetup(input, "market_segments", payloadText(payload, "marketSegmentLabel")),
        createCategoryOptionFromSetup(input, "channel_categories", payloadText(payload, "channelCategoryLabel")),
        createCategoryOptionFromSetup(input, "revenue_report_fields", payloadText(payload, "rateCategoryLabel"))
      ].filter(Boolean);
      return { targetEntityType: "revenue_category_setup", result: { createdOptions, payload } };
    }
    case "finance_compliance_setup": {
      const compliance = await patchComplianceSettings({
        ...input,
        patch: {
          taxRegion: payloadText(payload, "taxRegion"),
          configurationJson: {
            authorityType: payloadText(payload, "authorityType"),
            retentionRule: payloadText(payload, "retentionRule"),
            submissionMode: payloadText(payload, "submissionMode")
          }
        }
      });
      const billing = await patchBillingSettings({
        ...input,
        invoiceSequence: {
          sequenceCode: payloadText(payload, "invoiceSequenceCode"),
          invoiceType: payloadText(payload, "invoiceType", "full") as InvoiceSequenceRecord["invoiceType"],
          prefix: payloadText(payload, "invoicePrefix"),
          active: true
        }
      });
      createCategoryOptionFromSetup(input, "payment_method_categories", payloadText(payload, "paymentMethodCategory"));
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
      const field = createCustomField({
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

export function listPropertySetupForms(propertyId: string) {
  requireProperty(propertyId);
  return {
    propertyId,
    forms: PROPERTY_SETUP_FORM_DEFINITIONS.map((definition) => {
      const step = demoStore.propertySetupSteps.find((candidate) => candidate.propertyId === propertyId && candidate.stepCode === definition.setupStepCode);
      const latestSubmission = demoStore.propertySetupFormSubmissions
        .filter((submission) => submission.propertyId === propertyId && submission.formCode === definition.code)
        .at(-1);
      return {
        ...definition,
        status: latestSubmission?.status ?? step?.status ?? "not_started",
        latestSubmission
      };
    })
  };
}

export function listManualSetupOptions(propertyId: string) {
  requireProperty(propertyId);
  const enabledModules = new Set(
    demoStore.propertyModules
      .filter((propertyModule) => propertyModule.propertyId === propertyId && propertyModule.status !== "disabled")
      .map((propertyModule) => propertyModule.moduleId)
  );
  const options = MANUAL_SETUP_OPTIONS.map((option) => {
    const submissions = demoStore.manualSetupSubmissions.filter(
      (submission) => submission.propertyId === propertyId && submission.optionCode === option.code
    );
    const latestSubmission = submissions.at(-1);
    return {
      ...option,
      setupState: latestSubmission?.status ?? "not_started",
      latestSubmission,
      moduleEnabled: !option.moduleCode || option.moduleCode === "backoffice" || enabledModules.has(option.moduleCode),
      localDemoReason:
        option.moduleCode && option.moduleCode !== "backoffice" && !enabledModules.has(option.moduleCode)
          ? `Hidden because module ${option.moduleCode} is disabled`
          : "Visible in local demo"
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

export function getManualSetupOptionDetail(propertyId: string, optionCode: string) {
  requireProperty(propertyId);
  const option = manualSetupOptionDefinition(optionCode);
  const submissions = demoStore.manualSetupSubmissions.filter(
    (submission) => submission.propertyId === propertyId && submission.optionCode === option.code
  );
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

export function saveManualSetupOption(input: BackOfficeMutationInput & {
  optionCode: string;
  payload: Record<string, unknown>;
}) {
  const option = manualSetupOptionDefinition(input.optionCode);
  requireProperty(input.propertyId);
  requirePermissions(input.context, [option.permission as PermissionKey]);
  const validationErrors = validateManualSetupPayload(option, input.payload);
  const submission: ManualSetupSubmissionRecord = {
    id: createId("msetup"),
    propertyId: input.propertyId,
    optionCode: option.code,
    status: validationErrors.length > 0 ? "failed" : "saved",
    payloadJson: input.payload,
    validationErrorsJson: validationErrors,
    targetTables: option.targetTables,
    inputCategories: option.inputCategories,
    completionChecksJson: option.completionChecks.map((check) => ({ ...check })),
    createdBy: input.context.userId,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  demoStore.manualSetupSubmissions.push(submission);

  if (validationErrors.length > 0) {
    audit({
      ...input,
      action: "ManualSetupValidationFailed",
      entityType: "manual_setup_submission",
      entityId: submission.id,
      afterJson: { submission, option }
    });
    throw new Error(validationErrors.join(" "));
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
  requireProperty(propertyId);
  const definition = propertySetupFormDefinition(formCode);
  return {
    ...definition,
    propertyId,
    existingData: await formExistingData(propertyId, formCode),
    categoryOptions: definition.fields
      .filter((field) => field.categoryCode)
      .map((field) => ({
        fieldKey: field.key,
        categoryCode: field.categoryCode,
        options: field.categoryCode ? categoryWithOptions(propertyId, requireCategoryDefinition(field.categoryCode)).options : []
      })),
    dataQuality: configurationDataQuality(propertyId),
    submissions: demoStore.propertySetupFormSubmissions.filter(
      (submission) => submission.propertyId === propertyId && submission.formCode === formCode
    )
  };
}

export async function savePropertySetupForm(input: BackOfficeMutationInput & {
  formCode: string;
  payload: Record<string, unknown>;
}) {
  const definition = propertySetupFormDefinition(input.formCode);
  requirePermissions(input.context, [definition.permission]);
  const validationErrors = validatePropertySetupPayload(definition, input.payload);
  if (validationErrors.length > 0) {
    const failed: PropertySetupFormSubmissionRecord = {
      id: createId("psfs"),
      propertyId: input.propertyId,
      formCode: definition.code,
      status: "failed",
      payloadJson: input.payload,
      validationErrorsJson: validationErrors,
      targetEntityType: definition.targetEntityType,
      createdBy: input.context.userId,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    demoStore.propertySetupFormSubmissions.push(failed);
    audit({ ...input, action: "PropertySetupFormValidationFailed", entityType: "property_setup_form_submission", entityId: failed.id, afterJson: failed });
    throw new Error(validationErrors.join(" "));
  }

  const target = await applyPropertySetupForm(input, definition, input.payload);
  const submission: PropertySetupFormSubmissionRecord = {
    id: createId("psfs"),
    propertyId: input.propertyId,
    formCode: definition.code,
    status: "saved",
    payloadJson: input.payload,
    validationErrorsJson: [],
    targetEntityType: target.targetEntityType,
    targetEntityId: target.targetEntityId,
    createdBy: input.context.userId,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  demoStore.propertySetupFormSubmissions.push(submission);
  const step = completePropertySetupStep(input, definition.setupStepCode, { lastFormCode: definition.code, lastSubmissionId: submission.id });
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

function upsertReadinessCheck(
  propertyId: string,
  check: Omit<PropertyReadinessCheckRecord, "id" | "propertyId" | "createdAt" | "updatedAt">
): PropertyReadinessCheckRecord {
  const existing = demoStore.propertyReadinessChecks.find(
    (candidate) => candidate.propertyId === propertyId && candidate.checkCode === check.checkCode
  );
  const timestamp = nowIso();
  if (existing) {
    Object.assign(existing, check, { updatedAt: timestamp });
    return existing;
  }

  const record: PropertyReadinessCheckRecord = {
    id: createId("ready"),
    propertyId,
    ...check,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  demoStore.propertyReadinessChecks.push(record);
  return record;
}

export function getBackOfficeDashboard(propertyId: string) {
  requireProperty(propertyId);
  const setup = getSetupProgress(propertyId);
  const readiness = getReadiness(propertyId);
  const modules = listBackOfficeModules(propertyId);
  const integrationErrors = demoStore.integrationConnections.filter(
    (connection) => connection.propertyId === propertyId && connection.status === "error"
  );
  const failedIntegrationEvents = demoStore.integrationEvents.filter((event) => event.status === "failed");
  const rooms = demoStore.rooms.filter((room) => room.propertyId === propertyId);
  const mappedRooms = rooms.filter((room) => room.buildingId || room.floorId || room.zoneId);
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
    usersPendingInvitation: demoStore.users.filter((user) => user.status === "invited").length,
    roomsMapped: mappedRooms.length,
    roomTypesConfigured: demoStore.roomTypes.filter((roomType) => roomType.propertyId === propertyId && roomType.active !== false).length,
    invoiceSequenceStatus: demoStore.invoiceSequences.some((sequence) => sequence.propertyId === propertyId && sequence.active)
      ? "configured"
      : "missing",
    paymentProviderStatus: paymentProviderConnected ? "connected" : "missing",
    aiStatus: demoStore.propertyAiSettings.find((settings) => settings.propertyId === propertyId)?.aiEnabled ? "enabled" : "disabled",
    recommendedNextAction: blockingIssues[0]?.message ?? "Review go-live checklist.",
    recentAuditEvents: demoStore.auditEvents.slice(-8).reverse()
  };
}

export function getConfigurationCenter(propertyId: string) {
  requireProperty(propertyId);
  return {
    propertyId,
    title: "Configuration Center",
    description: "Manage categories, custom fields, room types, spaces, departments, revenue segments, housekeeping rules and maintenance categories.",
    categoryGroups: Array.from(new Set(categoryDefinitions.map((definition) => definition.categoryGroup))),
    categoryCount: categoryDefinitions.length,
    optionCount: propertyCategoryOptions.filter((option) => option.propertyId === propertyId).length,
    customFieldCount: customFieldDefinitions.filter((field) => field.propertyId === propertyId && field.active).length,
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
    dataQuality: configurationDataQuality(propertyId),
    primaryActions: ["Open Category Manager", "Open Custom Fields", "Apply template", "Import categories", "Ask AI Setup Assistant"]
  };
}

export function listConfigurationCategories(propertyId: string) {
  requirePermissions(demoStore.userContext, ["categories.read"]);
  requireProperty(propertyId);
  return {
    propertyId,
    groups: Array.from(new Set(categoryDefinitions.map((definition) => definition.categoryGroup))).map((group) => ({
      group,
      categories: categoryDefinitions
        .filter((definition) => definition.categoryGroup === group)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((definition) => categoryWithOptions(propertyId, definition))
    }))
  };
}

export function getConfigurationCategory(propertyId: string, categoryCode: string) {
  requirePermissions(demoStore.userContext, ["categories.read"]);
  requireProperty(propertyId);
  return categoryWithOptions(propertyId, requireCategoryDefinition(categoryCode));
}

export function createCategoryOption(input: BackOfficeMutationInput & {
  categoryCode: string;
  option: Pick<PropertyCategoryOptionRecord, "code" | "label"> & Partial<PropertyCategoryOptionRecord>;
}) {
  requirePermissions(input.context, ["categories.manage"]);
  const definition = requireCategoryDefinition(input.categoryCode);
  assertCategoryModeAllowsEdit(definition);
  if (definition.mode === "system_controlled" && !input.option.isSystemDefault) {
    throw new Error("System-controlled legal categories can only be extended through controlled defaults.");
  }
  if (propertyCategoryOptions.some((option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id && option.code === input.option.code)) {
    throw new Error("Category option code must be unique per property and category.");
  }
  const record: PropertyCategoryOptionRecord = {
    id: createId("catopt"),
    propertyId: input.propertyId,
    categoryDefinitionId: definition.id,
    code: input.option.code,
    label: input.option.label,
    description: input.option.description,
    colorToken: input.option.colorToken,
    iconName: input.option.iconName,
    parentOptionId: input.option.parentOptionId,
    metadataJson: input.option.metadataJson ?? {},
    isSystemDefault: input.option.isSystemDefault ?? false,
    active: input.option.active ?? true,
    sortOrder: input.option.sortOrder ?? propertyCategoryOptions.length + 1,
    createdBy: input.context.userId,
    updatedBy: input.context.userId,
    usageCount: 0
  };
  propertyCategoryOptions.push(record);
  audit({ ...input, action: "CategoryOptionCreated", entityType: "property_category_option", entityId: record.id, afterJson: record });
  return record;
}

export function patchCategoryOption(input: BackOfficeMutationInput & {
  optionId: string;
  patch: Partial<PropertyCategoryOptionRecord>;
}) {
  requirePermissions(input.context, ["categories.manage"]);
  const option = requireCategoryOption(input.propertyId, input.optionId);
  const definition = categoryDefinitions.find((candidate) => candidate.id === option.categoryDefinitionId)!;
  assertCategoryModeAllowsEdit(definition, input.patch as Record<string, unknown>);
  const before = { ...option };
  Object.assign(option, input.patch, { updatedBy: input.context.userId });
  audit({ ...input, action: "CategoryOptionUpdated", entityType: "property_category_option", entityId: option.id, beforeJson: before, afterJson: option });
  return option;
}

export function setCategoryOptionActive(input: BackOfficeMutationInput & { optionId: string; active: boolean }) {
  requirePermissions(input.context, ["categories.manage"]);
  const option = requireCategoryOption(input.propertyId, input.optionId);
  const before = { ...option };
  option.active = input.active;
  option.updatedBy = input.context.userId;
  audit({
    ...input,
    action: input.active ? "CategoryOptionReactivated" : "CategoryOptionDeactivated",
    entityType: "property_category_option",
    entityId: option.id,
    beforeJson: before,
    afterJson: { ...option, linkedRecordsRemainVisible: categoryOptionUsage(option.id) > 0 }
  });
  return option;
}

export function reorderCategoryOptions(input: BackOfficeMutationInput & { categoryCode: string; optionIds: string[] }) {
  requirePermissions(input.context, ["categories.manage"]);
  const definition = requireCategoryDefinition(input.categoryCode);
  assertCategoryModeAllowsEdit(definition);
  input.optionIds.forEach((optionId, index) => {
    const option = requireCategoryOption(input.propertyId, optionId);
    if (option.categoryDefinitionId !== definition.id) {
      throw new Error("Cannot reorder options outside the selected category.");
    }
    option.sortOrder = index + 1;
    option.updatedBy = input.context.userId;
  });
  const options = propertyCategoryOptions.filter((option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id);
  audit({ ...input, action: "CategoryOptionsReordered", entityType: "category_definition", entityId: definition.id, afterJson: { optionIds: input.optionIds } });
  return { status: "reordered" as const, options };
}

export function listCustomFields(propertyId: string) {
  requirePermissions(demoStore.userContext, ["custom_fields.read"]);
  requireProperty(propertyId);
  return { items: customFieldDefinitions.filter((field) => field.propertyId === propertyId) };
}

export function createCustomField(input: BackOfficeMutationInput & {
  field: Pick<PropertyCustomFieldDefinitionRecord, "entityType" | "fieldKey" | "label" | "dataType"> & Partial<PropertyCustomFieldDefinitionRecord>;
}) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  if (customFieldDefinitions.some((field) => field.propertyId === input.propertyId && field.entityType === input.field.entityType && field.fieldKey === input.field.fieldKey)) {
    throw new Error("Custom field key must be unique per property and entity type.");
  }
  const record: PropertyCustomFieldDefinitionRecord = {
    id: createId("cf"),
    propertyId: input.propertyId,
    entityType: input.field.entityType,
    fieldKey: input.field.fieldKey,
    label: input.field.label,
    description: input.field.description,
    dataType: input.field.dataType,
    required: input.field.required ?? false,
    searchable: input.field.searchable ?? false,
    visibleInList: input.field.visibleInList ?? false,
    visibleInDetail: input.field.visibleInDetail ?? true,
    optionsCategoryDefinitionId: input.field.optionsCategoryDefinitionId,
    validationJson: input.field.validationJson ?? {},
    visibilityRulesJson: input.field.visibilityRulesJson ?? {},
    defaultValueJson: input.field.defaultValueJson ?? {},
    active: input.field.active ?? true,
    sortOrder: input.field.sortOrder ?? customFieldDefinitions.length + 1
  };
  customFieldDefinitions.push(record);
  audit({ ...input, action: "CustomFieldCreated", entityType: "property_custom_field_definition", entityId: record.id, afterJson: record });
  return record;
}

export function patchCustomField(input: BackOfficeMutationInput & { fieldId: string; patch: Partial<PropertyCustomFieldDefinitionRecord> }) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  const field = customFieldDefinitions.find((candidate) => candidate.id === input.fieldId && candidate.propertyId === input.propertyId);
  if (!field) throw new Error("Custom field was not found.");
  const before = { ...field };
  Object.assign(field, input.patch);
  audit({ ...input, action: input.patch.active === false ? "CustomFieldDeactivated" : "CustomFieldUpdated", entityType: "property_custom_field_definition", entityId: field.id, beforeJson: before, afterJson: field });
  return field;
}

export function getEntityCustomFields(propertyId: string, entityType: string, entityId: string) {
  requirePermissions(demoStore.userContext, ["custom_fields.read"]);
  return {
    definitions: customFieldDefinitions.filter((field) => field.propertyId === propertyId && field.entityType === entityType && field.active),
    values: customFieldValues.filter((value) => value.propertyId === propertyId && value.entityType === entityType && value.entityId === entityId)
  };
}

export function patchEntityCustomFields(input: BackOfficeMutationInput & {
  entityType: string;
  entityId: string;
  values: Array<{ fieldDefinitionId: string; valueJson: Record<string, unknown> }>;
}) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  const updated = input.values.map((value) => {
    let record = customFieldValues.find((candidate) => candidate.entityType === input.entityType && candidate.entityId === input.entityId && candidate.fieldDefinitionId === value.fieldDefinitionId);
    if (!record) {
      record = { id: createId("cfv"), propertyId: input.propertyId, entityType: input.entityType, entityId: input.entityId, fieldDefinitionId: value.fieldDefinitionId, valueJson: value.valueJson };
      customFieldValues.push(record);
    } else {
      record.valueJson = value.valueJson;
    }
    return record;
  });
  audit({ ...input, action: "CustomFieldUpdated", entityType: input.entityType, entityId: input.entityId, afterJson: updated });
  return { status: "updated" as const, values: updated };
}

export function seedDefaultCategories(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["categories.manage"]);
  const created = categoryDefinitions
    .filter((definition) => !propertyCategoryOptions.some((option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id))
    .map((definition) =>
      createCategoryOption({
        ...input,
        categoryCode: definition.code,
        option: { code: "default", label: "Default", isSystemDefault: true, metadataJson: { seededFromDefinition: definition.code } }
      })
    );
  return { status: "seeded" as const, createdCount: created.length, created };
}

export function previewCategoryImport(input: BackOfficeMutationInput & { rows: Array<Record<string, unknown>> }) {
  requirePermissions(input.context, ["categories.import"]);
  const requiredColumns = ["category_code", "option_code", "label"];
  const errors: string[] = [];
  const create = input.rows.filter((row) => {
    for (const column of requiredColumns) {
      if (!row[column]) errors.push(`Missing ${column}`);
    }
    const definition = categoryDefinitions.find((candidate) => candidate.code === row.category_code);
    return Boolean(definition && !propertyCategoryOptions.some((option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id && option.code === row.option_code));
  }).length;
  const update = input.rows.length - create;
  const preview = { status: errors.length ? "blocked" : "ready", create, update, skip: errors.length, errors, requiredColumns };
  audit({ ...input, action: "CategoryImportPreviewed", entityType: "category_import", afterJson: preview });
  return preview;
}

export function applyCategoryImport(input: BackOfficeMutationInput & { rows: Array<Record<string, unknown>>; confirmationProvided?: boolean }) {
  requirePermissions(input.context, ["categories.import"]);
  if (!input.confirmationProvided) {
    return { status: "confirmation_required" as const, message: "Category import requires preview and confirmation before apply." };
  }
  const created = input.rows.map((row) =>
    createCategoryOption({
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
  audit({ ...input, action: "CategoryImportApplied", entityType: "category_import", afterJson: { createdCount: created.length } });
  return { status: "applied" as const, createdCount: created.length, created };
}

export function exportCategories(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["categories.export"]);
  const rows = propertyCategoryOptions
    .filter((option) => option.propertyId === input.propertyId)
    .map((option) => ({
      category_code: categoryDefinitions.find((definition) => definition.id === option.categoryDefinitionId)?.code,
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

export function listCategoryTemplates() {
  requirePermissions(demoStore.userContext, ["categories.read"]);
  return { items: categoryTemplates };
}

export function previewCategoryTemplate(input: BackOfficeMutationInput & { templateCode: string }) {
  requirePermissions(input.context, ["categories.manage"]);
  const template = categoryTemplates.find((candidate) => candidate.code === input.templateCode);
  if (!template) throw new Error("Category template was not found.");
  const preview = {
    template,
    willCreate: template.creates,
    willUpdate: [],
    willSkip: template.creates.filter((label) =>
      propertyCategoryOptions.some((option) => option.propertyId === input.propertyId && option.label.toLowerCase() === label.toLowerCase())
    ),
    requiresConfirmation: true
  };
  audit({ ...input, action: "CategoryTemplatePreviewed", entityType: "category_template", entityId: template.code, afterJson: preview });
  return preview;
}

export function applyCategoryTemplate(input: BackOfficeMutationInput & { templateCode: string; confirmationProvided?: boolean }) {
  requirePermissions(input.context, ["categories.manage"]);
  if (!input.confirmationProvided) {
    return { status: "confirmation_required" as const, message: "Category template application requires preview and confirmation." };
  }
  const preview = previewCategoryTemplate(input);
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

export function getSetupProgress(propertyId: string) {
  requireProperty(propertyId);
  const steps = SETUP_STEPS.map((stepCode) => {
    const existing = demoStore.propertySetupSteps.find((step) => step.propertyId === propertyId && step.stepCode === stepCode);
    return (
      existing ?? {
        id: `virtual_${stepCode}`,
        propertyId,
        stepCode,
        status: "not_started",
        metadataJson: {}
      }
    );
  }) as PropertySetupStepRecord[];
  const completed = steps.filter((step) => step.status === "completed").length;
  return {
    propertyId,
    steps,
    completed,
    total: steps.length,
    progressPercent: Math.round((completed / steps.length) * 100)
  };
}

export function updateSetupStep(input: BackOfficeMutationInput & {
  stepCode: string;
  status: PropertySetupStepRecord["status"];
  metadataJson?: Record<string, unknown>;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const existing = demoStore.propertySetupSteps.find(
    (step) => step.propertyId === input.propertyId && step.stepCode === input.stepCode
  );
  const before = existing ? { ...existing } : undefined;
  const completedAt = input.status === "completed" ? nowIso() : existing?.completedAt;
  const record =
    existing ??
    ({
      id: createId("setup"),
      propertyId: input.propertyId,
      stepCode: input.stepCode,
      status: input.status,
      metadataJson: {}
    } as PropertySetupStepRecord);

  record.status = input.status;
  record.completedAt = completedAt;
  record.completedBy = input.status === "completed" ? input.context.userId : record.completedBy;
  record.metadataJson = input.metadataJson ?? record.metadataJson;
  if (!existing) {
    demoStore.propertySetupSteps.push(record);
  }

  audit({ ...input, action: "PropertySetupStepUpdated", entityType: "property_setup_step", entityId: record.id, beforeJson: before, afterJson: record });
  return record;
}

export function getReadiness(propertyId: string) {
  requireProperty(propertyId);
  const checks = demoStore.propertyReadinessChecks.filter((check) => check.propertyId === propertyId);
  const blocking = checks.filter((check) => check.severity === "blocking" && check.status !== "pass");
  return {
    propertyId,
    status: blocking.length === 0 ? "ready" : "blocked",
    blockingCount: blocking.length,
    checks
  };
}

export async function recalculateReadiness(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["property.configure"]);
  const property = requireProperty(input.propertyId);
  const modules = enabledModuleCodes(input.propertyId);
  const roomTypes = demoStore.roomTypes.filter((roomType) => roomType.propertyId === input.propertyId && roomType.active !== false);
  const activeSellableRooms = demoStore.rooms.filter(
    (room) => room.propertyId === input.propertyId && room.active !== false && room.sellable && room.roomTypeId
  );
  // Fase 0 (Opción A): el check default_building_exists lee de Prisma (fuente de verdad).
  const hasActiveBuilding = (await prisma.building.count({ where: { propertyId: input.propertyId, active: true } })) > 0;
  const complianceSettings = demoStore.propertyComplianceSettings.find((settings) => settings.propertyId === input.propertyId);
  const hasAdminUser = demoStore.users.some((user) => user.organizationId === property.organizationId && user.status === "active");
  const hasInvoiceSequence = demoStore.invoiceSequences.some((sequence) => sequence.propertyId === input.propertyId && sequence.active);
  const paymentProviderConnected = demoStore.integrationConnections.some((connection) => {
    const provider = demoStore.integrationProviders.find((candidate) => candidate.id === connection.providerId);
    return connection.propertyId === input.propertyId && connection.status === "connected" && provider?.code.includes("payments");
  });

  const checks = [
    {
      checkCode: "legal_profile_complete",
      status: property.legalName && property.taxRegion && property.timezone ? "pass" : "fail",
      severity: "blocking",
      message: "Property legal name, tax ID, address and timezone must be configured."
    },
    {
      checkCode: "default_building_exists",
      status: hasActiveBuilding ? "pass" : "fail",
      severity: "blocking",
      message: "At least one building or default building is required."
    },
    {
      checkCode: "room_type_exists",
      status: roomTypes.length > 0 ? "pass" : "fail",
      severity: "blocking",
      message: "At least one active room type is required."
    },
    {
      checkCode: "sellable_room_exists",
      status: activeSellableRooms.length > 0 ? "pass" : "fail",
      severity: "blocking",
      message: "At least one active sellable room with a room type is required."
    },
    {
      checkCode: "admin_user_exists",
      status: hasAdminUser ? "pass" : "fail",
      severity: "blocking",
      message: "At least one active admin or manager user is required."
    },
    {
      checkCode: "invoice_sequence_configured",
      status: !modules.includes("compliance_billing") || hasInvoiceSequence ? "pass" : "fail",
      severity: "blocking",
      message: "Invoice sequence is required when Compliance Billing is enabled."
    },
    {
      checkCode: "payment_provider_connected",
      status: !modules.includes("payment_vault") || paymentProviderConnected ? "pass" : "fail",
      severity: "blocking",
      message: "Payment provider is required when Payment Vault is enabled."
    },
    {
      checkCode: "ses_hospedajes_credentials",
      status:
        !complianceSettings?.sesHospedajesEnabled || complianceSettings.configurationJson.sesCredentialsConfigured === true
          ? "pass"
          : "fail",
      severity: "blocking",
      message: "SES.HOSPEDAJES configuration must be completed when Spain compliance is enabled."
    }
  ] as const;

  const records = checks.map((check) => upsertReadinessCheck(input.propertyId, check));
  audit({ ...input, action: "PropertyReadinessRecalculated", entityType: "property", entityId: input.propertyId, afterJson: records });
  return getReadiness(input.propertyId);
}

export function approveGoLive(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["property.go_live"]);
  const readiness = getReadiness(input.propertyId);
  if (readiness.blockingCount > 0) {
    return {
      status: "blocked" as const,
      blockers: readiness.checks.filter((check) => check.severity === "blocking" && check.status !== "pass")
    };
  }

  audit({ ...input, action: "PropertyGoLiveApproved", entityType: "property", entityId: input.propertyId });
  domain({ ...input, eventType: "PropertyGoLiveApproved", entityType: "property", entityId: input.propertyId });
  return { status: "approved" as const, propertyId: input.propertyId, approvedAt: nowIso() };
}

export async function getPropertyMap(propertyId: string) {
  requireProperty(propertyId);
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
    throw new Error("roomRangeStart must be numeric for range creation.");
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
    throw new Error("Sellable rooms must have a room type.");
  }
  // Fase 0 (Opción A): Room.roomTypeId es NOT NULL en Prisma. Las rooms no vendibles
  // del demo igualmente traen roomTypeId; si faltara, fallaría el create. No lo
  // inventamos: lo validamos explícito para dar un error claro en vez de un 500 de Prisma.
  if (!input.roomTypeId) {
    throw new Error("A room type is required to create rooms.");
  }

  const roomNumbers =
    input.roomNumbers ??
    (input.roomRangeStart && input.roomRangeEnd
      ? Array.from({ length: Number(input.roomRangeEnd) - Number(input.roomRangeStart) + 1 }, (_, index) =>
          roomNumberFromRange(input.roomRangeStart!, index)
        )
      : []);

  if (roomNumbers.length === 0) {
    throw new Error("At least one room number is required.");
  }

  // Unicidad por (propertyId, number) contra Prisma (fuente de verdad).
  const existingRows = await prisma.room.findMany({
    where: { propertyId: input.propertyId, number: { in: roomNumbers } },
    select: { number: true }
  });
  const duplicates = existingRows.map((row) => row.number);
  if (duplicates.length > 0) {
    throw new Error(`Room number must be unique per property: ${duplicates.join(", ")}`);
  }

  const floorName = input.floorId
    ? (await prisma.floor.findUnique({ where: { id: input.floorId }, select: { name: true } }))?.name ?? ""
    : "";

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
    throw new Error("All selected rooms must belong to the property.");
  }
  const before = existingRows.map(mapRoomRow);
  if (input.patch.sellable === true && !input.patch.roomTypeId && before.some((room) => !room.roomTypeId)) {
    throw new Error("Room cannot be marked sellable if no room type is assigned.");
  }
  if (input.patch.buildingId) {
    const building = await prisma.building.findFirst({ where: { id: input.patch.buildingId, propertyId: input.propertyId } });
    if (!building?.active) {
      throw new Error("Room cannot be assigned to disabled floor/building.");
    }
  }
  if (input.patch.floorId) {
    const floor = await prisma.floor.findFirst({ where: { id: input.patch.floorId, propertyId: input.propertyId } });
    if (!floor?.active) {
      throw new Error("Room cannot be assigned to disabled floor/building.");
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
    housekeepingStatus: input.patch.housekeepingStatus,
    maintenanceStatus: input.patch.maintenanceStatus
  };

  const rooms: RoomRecord[] = [];
  for (const id of input.roomIds) {
    const updatedRow = await prisma.room.update({ where: { id }, data });
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
    throw new Error("Room type code must be unique per property.");
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
async function requireRoomType(roomTypeId: string): Promise<RoomTypeRecord> {
  const row = await prisma.roomType.findUnique({ where: { id: roomTypeId } });
  if (row) return mirrorRecord(demoStore.roomTypes, mapRoomTypeRow(row));
  const roomType = demoStore.roomTypes.find((candidate) => candidate.id === roomTypeId);
  if (!roomType) {
    throw new Error("Room type was not found.");
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
  const roomType = await requireRoomType(input.roomTypeId);
  if (roomType.propertyId !== input.propertyId) {
    throw new Error("Room type does not belong to the property.");
  }
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
      throw new Error("Changing max occupancy must validate future reservations.");
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
  const roomType = await requireRoomType(input.roomTypeId);
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
  const source = await requireRoomType(input.sourceRoomTypeId);
  const target = await requireRoomType(input.targetRoomTypeId);
  if (source.propertyId !== input.propertyId || target.propertyId !== input.propertyId) {
    throw new Error("Both room types must belong to the property.");
  }
  if (source.id === target.id) {
    throw new Error("Source and target room types must be different.");
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

export async function listRoomsForRoomType(roomTypeId: string) {
  // Persistencia tanda 2: rooms viven en Prisma (Fase 0); la lista confirma merges/altas.
  const rows = await prisma.room.findMany({ where: { roomTypeId } });
  const mapped = rows.map(mapRoomRow);
  return mergeById(mapped, demoStore.rooms.filter((room) => room.roomTypeId === roomTypeId));
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
    throw new Error("Room feature code must be unique per property.");
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
    throw new Error("Bed type code must be unique per property.");
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

export async function commitPropertyMapImport(input: BackOfficeMutationInput & { importId: string; createUnknownReferences?: boolean }) {
  requirePermissions(input.context, ["property.import"]);
  const importRecord = demoStore.propertyImports.find((candidate) => candidate.id === input.importId && candidate.propertyId === input.propertyId);
  if (!importRecord) {
    throw new Error("Import was not found.");
  }
  if (importRecord.status !== "previewed") {
    throw new Error("Only previewed imports can be committed.");
  }

  const rows = (importRecord.previewJson.rows ?? []) as PropertyMapImportRow[];
  const roomTypeByCode = new Map(demoStore.roomTypes.filter((roomType) => roomType.propertyId === input.propertyId).map((roomType) => [roomType.code, roomType]));
  const createdRooms: RoomRecord[] = [];
  for (const row of rows) {
    if (!row.roomNumber) {
      throw new Error("Import contains a row without room number.");
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
      throw new Error(`Unknown room type ${row.roomType ?? "missing"}.`);
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

export function getPropertyImport(propertyId: string, importId: string) {
  return demoStore.propertyImports.find((candidate) => candidate.propertyId === propertyId && candidate.id === importId);
}

export function listBackOfficeModules(propertyId: string) {
  const propertyModules = demoStore.propertyModules.filter((propertyModule) => propertyModule.propertyId === propertyId);
  return HOTEL_MODULES.map((manifest) => {
    const moduleRecord = demoStore.modules.find((module) => module.code === manifest.code);
    const propertyModule = propertyModules.find((candidate) => candidate.moduleId === moduleRecord?.id);
    const health = demoStore.moduleHealthChecks.filter((check) => check.propertyId === propertyId && check.moduleCode === manifest.code);
    const healthStatus = health.some((check) => check.status === "error")
      ? "error"
      : health.some((check) => check.status === "needs_configuration")
        ? "needs_configuration"
        : "ok";
    return {
      ...manifest,
      status: propertyModule?.status ?? (manifest.isCore ? "enabled" : "available"),
      configurationJson: propertyModule?.configurationJson ?? {},
      healthStatus,
      healthChecks: health,
      recommendedNextAction: health.find((check) => check.status !== "ok")?.message ?? "No action required."
    };
  });
}

export async function configureModule(input: BackOfficeMutationInput & { moduleCode: HotelModuleCode; configurationJson: Record<string, unknown> }) {
  requirePermissions(input.context, ["modules.configure"]);
  const moduleRecord = demoStore.modules.find((module) => module.code === input.moduleCode);
  if (!moduleRecord) {
    throw new Error("Module was not found.");
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

export function getModuleConfiguration(propertyId: string, moduleCode: HotelModuleCode) {
  const moduleRecord = demoStore.modules.find((module) => module.code === moduleCode);
  const propertyModule = demoStore.propertyModules.find((candidate) => candidate.propertyId === propertyId && candidate.moduleId === moduleRecord?.id);
  return {
    module: getHotelModuleManifest(moduleCode),
    configurationJson: propertyModule?.configurationJson ?? {},
    setupRequirements: getModuleSetupRequirements(moduleCode)
  };
}

export function getModuleHealth(propertyId: string, moduleCode: HotelModuleCode) {
  return demoStore.moduleHealthChecks.filter((check) => check.propertyId === propertyId && check.moduleCode === moduleCode);
}

export function recalculateModuleHealth(input: BackOfficeMutationInput & { moduleCode: HotelModuleCode }) {
  requirePermissions(input.context, ["modules.configure"]);
  const requirements = getModuleSetupRequirements(input.moduleCode);
  const health = requirements.map((requirement) => ({
    id: createId("mh"),
    propertyId: input.propertyId,
    moduleCode: input.moduleCode,
    checkCode: requirement.code,
    status: requirement.validator(input.propertyId) ? "ok" : "needs_configuration",
    severity: requirement.blocking ? "blocking" : "warning",
    message: requirement.description,
    metadataJson: {},
    updatedAt: nowIso()
  })) as typeof demoStore.moduleHealthChecks;
  demoStore.moduleHealthChecks = demoStore.moduleHealthChecks.filter(
    (check) => !(check.propertyId === input.propertyId && check.moduleCode === input.moduleCode)
  );
  demoStore.moduleHealthChecks.push(...health);
  audit({ ...input, action: "ModuleHealthRecalculated", entityType: "module", entityId: input.moduleCode, afterJson: health });
  return health;
}

function getModuleSetupRequirements(moduleCode: HotelModuleCode) {
  return [
    {
      code: "room_inventory_exists",
      label: "Room inventory exists",
      description: "At least one active sellable room must exist.",
      required: true,
      blocking: true,
      validator: (propertyId: string) => demoStore.rooms.some((room) => room.propertyId === propertyId && room.active !== false && room.sellable)
    },
    {
      code: "signature_template_configured",
      label: "Signature template configured",
      description: "Guest register signature template must be configured.",
      required: moduleCode === "checkin_online",
      blocking: moduleCode === "checkin_online",
      validator: (propertyId: string) =>
        demoStore.documentTemplates.some((template) => template.propertyId === propertyId && template.templateCode === "guest_register_signature_form")
    },
    {
      code: "ocr_provider_configured",
      label: "OCR provider configured",
      description: "OCR provider must be configured before assisted ID scan.",
      required: moduleCode === "checkin_online",
      blocking: moduleCode === "checkin_online",
      validator: (propertyId: string) =>
        demoStore.propertyAiSettings.some((settings) => settings.propertyId === propertyId && settings.configurationJson.ocrProviderConfigured === true)
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
    throw new Error("Department code must be unique per property.");
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
  return {
    sections: sections.map((section) => ({
      ...section,
      rooms: demoStore.housekeepingSectionRooms
        .filter((assignment) => assignment.housekeepingSectionId === section.id)
        .map((assignment) => demoStore.rooms.find((room) => room.id === assignment.roomId))
        .filter(Boolean)
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
  return {
    areas: areas.map((area) => ({
      ...area,
      rooms: demoStore.maintenanceAreaRooms
        .filter((assignment) => assignment.maintenanceAreaId === area.id)
        .map((assignment) => demoStore.rooms.find((room) => room.id === assignment.roomId))
        .filter(Boolean)
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

export async function assignUserToDepartment(input: BackOfficeMutationInput & {
  departmentId: string;
  userId: string;
  roleLabel?: string;
}) {
  requirePermissions(input.context, ["users.invite"]);
  const department = await requireDepartment(input.propertyId, input.departmentId);
  const userRow = await prisma.user.findUnique({ where: { id: input.userId } });
  const user = userRow
    ? mirrorRecord(demoStore.users, mapUserRow(userRow))
    : demoStore.users.find((candidate) => candidate.id === input.userId);
  if (!user) {
    throw new Error("User was not found.");
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
  audit({ ...input, action: "UserDepartmentAssigned", entityType: "user_department", entityId: assignment.id, beforeJson: before, afterJson: assignment });
  return assignment;
}

export async function listBackOfficeUsers(propertyId: string) {
  const property = requireProperty(propertyId);
  // Persistencia tanda 2: Prisma primero (usuarios, departamentos y
  // asignaciones), merge con los registros solo-seed y refresco del espejo.
  const [userRows, departmentRows] = await Promise.all([
    prisma.user.findMany({ where: { organizationId: property.organizationId }, orderBy: { createdAt: "asc" } }),
    prisma.department.findMany({ where: { propertyId } })
  ]);
  for (const row of userRows) mirrorRecord(demoStore.users, mapUserRow(row));
  for (const row of departmentRows) mirrorRecord(demoStore.departments, mapDepartmentRow(row));
  const users = demoStore.users.filter((user) => user.organizationId === property.organizationId);
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
  return users.map((user) => ({
    ...user,
    departments: demoStore.userDepartments
      .filter((assignment) => assignment.userId === user.id && assignment.active)
      .map((assignment) => ({
        ...assignment,
        department: demoStore.departments.find((department) => department.id === assignment.departmentId)
      }))
  }));
}

export async function inviteBackOfficeUser(input: BackOfficeMutationInput & {
  email: string;
  fullName: string;
  phone?: string;
  mfaRequired?: boolean;
}) {
  requirePermissions(input.context, ["users.invite"]);
  const property = requireProperty(input.propertyId);
  // User.email es unique en la BD: 409 explícito en vez de un P2002 opaco.
  const duplicateInPrisma = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (duplicateInPrisma || demoStore.users.some((user) => user.email === input.email)) {
    throw new ConflictError("User email must be unique.");
  }
  const user: UserRecord = {
    id: createId("usr"),
    organizationId: property.organizationId,
    email: input.email,
    phone: input.phone,
    fullName: input.fullName,
    status: "invited",
    mfaEnabled: input.mfaRequired ?? true
  };
  // Persistencia tanda 2: Prisma primero (mismo id, sin passwordHash — se fija
  // al aceptar la invitación), después espejo.
  await prisma.user.create({ data: userToDbRow(user) });
  demoStore.users.push(user);
  audit({ ...input, action: "UserInvited", entityType: "user", entityId: user.id, afterJson: user });
  return user;
}

export async function disableBackOfficeUser(input: BackOfficeMutationInput & { userId: string }) {
  requirePermissions(input.context, ["users.disable"]);
  const { user, persisted } = await requireBackOfficeUser(input.userId);
  const before = { ...user };
  if (persisted) {
    // Persistencia tanda 2: Prisma primero, después espejo.
    const row = await prisma.user.update({ where: { id: user.id }, data: { status: "disabled" } });
    Object.assign(user, mapUserRow(row));
  } else {
    // Usuario seed cuyo email ya pertenece a otra fila en la BD: solo espejo.
    user.status = "disabled";
  }
  audit({ ...input, action: "UserDisabled", entityType: "user", entityId: user.id, beforeJson: before, afterJson: user });
  return user;
}

export function listRoleCatalog() {
  return Object.entries(ROLE_PERMISSION_MAP).map(([role, rolePermissions]) => ({
    role,
    permissions: rolePermissions
  }));
}

export function listPermissionCatalog() {
  return Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description }));
}

export function getComplianceSettings(propertyId: string) {
  return demoStore.propertyComplianceSettings.find((settings) => settings.propertyId === propertyId);
}

export function patchComplianceSettings(input: BackOfficeMutationInput & { patch: Partial<PropertyComplianceSettingsRecord> }) {
  requirePermissions(input.context, ["compliance.configure"]);
  const settings = demoStore.propertyComplianceSettings.find((candidate) => candidate.propertyId === input.propertyId);
  if (!settings) {
    throw new Error("Compliance settings were not found.");
  }
  const before = { ...settings };
  Object.assign(settings, input.patch, { updatedAt: nowIso() });
  audit({ ...input, action: "TaxSettingsUpdated", entityType: "property_compliance_settings", entityId: settings.id, beforeJson: before, afterJson: settings });
  return settings;
}

export async function getBillingSettings(propertyId: string) {
  // Persistencia tanda 2: Prisma primero, merge con los registros solo-seed.
  const rows = await prisma.invoiceSequence.findMany({ where: { propertyId } });
  const mapped = rows.map(mapInvoiceSequenceRow);
  for (const sequence of mapped) mirrorRecord(demoStore.invoiceSequences, sequence);
  return {
    invoiceSequences: mergeById(mapped, demoStore.invoiceSequences.filter((sequence) => sequence.propertyId === propertyId)),
    complianceBilling: getModuleConfiguration(propertyId, "compliance_billing")
  };
}

export async function patchBillingSettings(input: BackOfficeMutationInput & { invoiceSequence?: Partial<InvoiceSequenceRecord> }) {
  requirePermissions(input.context, ["billing.configure"]);
  if (!input.invoiceSequence?.sequenceCode || !input.invoiceSequence.invoiceType) {
    throw new Error("Invoice sequence code and invoice type are required.");
  }
  const patch = input.invoiceSequence;
  const existing = demoStore.invoiceSequences.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.sequenceCode === patch.sequenceCode
  );
  const before = existing ? { ...existing } : undefined;
  // Persistencia tanda 2: upsert por (propertyId, sequenceCode) — Prisma
  // primero, conservando el id del registro seed si la fila no existía en la BD.
  const update: Prisma.InvoiceSequenceUncheckedUpdateInput = {};
  if (patch.prefix !== undefined) update.prefix = patch.prefix;
  if (patch.nextNumber !== undefined) update.nextNumber = patch.nextNumber;
  if (patch.padding !== undefined) update.padding = patch.padding;
  if (patch.invoiceType !== undefined) update.invoiceType = patch.invoiceType;
  if (patch.active !== undefined) update.active = patch.active;
  const row = await prisma.invoiceSequence.upsert({
    where: { propertyId_sequenceCode: { propertyId: input.propertyId, sequenceCode: patch.sequenceCode! } },
    update,
    create: {
      id: existing?.id ?? createId("seq"),
      propertyId: input.propertyId,
      sequenceCode: patch.sequenceCode!,
      prefix: patch.prefix ?? null,
      nextNumber: patch.nextNumber ?? 1,
      padding: patch.padding ?? 6,
      invoiceType: patch.invoiceType!,
      active: patch.active ?? true
    }
  });
  const sequence = mirrorRecord(
    demoStore.invoiceSequences,
    mapInvoiceSequenceRow(row),
    (candidate) => candidate.propertyId === input.propertyId && candidate.sequenceCode === patch.sequenceCode
  );
  audit({ ...input, action: before ? "InvoiceSequenceUpdated" : "InvoiceSequenceCreated", entityType: "invoice_sequence", entityId: sequence.id, beforeJson: before, afterJson: sequence });
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

export async function getAiSettings(propertyId: string) {
  // Persistencia tanda 2: Prisma primero, fallback al registro solo-seed.
  // Los toolSettings siguen en memoria (fuera del alcance de esta tanda).
  const row = await prisma.propertyAiSetting.findUnique({ where: { propertyId } });
  const settings = row
    ? mirrorRecord(demoStore.propertyAiSettings, mapAiSettingsRow(row), (candidate) => candidate.propertyId === row.propertyId)
    : demoStore.propertyAiSettings.find((candidate) => candidate.propertyId === propertyId);
  return {
    settings,
    toolSettings: demoStore.propertyAiToolSettings.filter((tool) => tool.propertyId === propertyId)
  };
}

export async function patchAiSettings(input: BackOfficeMutationInput & { patch: Partial<PropertyAiSettingsRecord> }) {
  requirePermissions(input.context, ["ai.configure"]);
  if (input.patch.configurationJson?.documentImageRetentionPolicy === "store_by_default") {
    throw new Error("AI settings cannot allow ID image storage by default.");
  }
  const settings = await requireAiSettings(input.propertyId);
  const before = { ...settings };
  // Persistencia tanda 2: Prisma primero, después espejo con la fila mapeada.
  const data: Prisma.PropertyAiSettingUncheckedUpdateInput = {};
  if (input.patch.aiEnabled !== undefined) data.aiEnabled = input.patch.aiEnabled;
  if (input.patch.defaultAutomationLevel !== undefined) data.defaultAutomationLevel = input.patch.defaultAutomationLevel;
  if (input.patch.guestFacingDisclosure !== undefined) data.guestFacingDisclosure = input.patch.guestFacingDisclosure;
  if (input.patch.voiceLocales !== undefined) data.voiceLocales = input.patch.voiceLocales;
  if (input.patch.configurationJson !== undefined) data.configurationJson = asJson(input.patch.configurationJson);
  const row = await prisma.propertyAiSetting.update({ where: { id: settings.id }, data });
  Object.assign(settings, mapAiSettingsRow(row));
  audit({ ...input, action: "AISettingsUpdated", entityType: "property_ai_settings", entityId: settings.id, beforeJson: before, afterJson: settings });
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
    throw new Error("Template code and language must be unique per property.");
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
    throw new Error("Back Office AI suggestion was not found.");
  }
  if (suggestion.status !== "previewed" || !suggestion.requiresConfirmation) {
    throw new Error("AI cannot apply Back Office changes without preview and confirmation.");
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
        subject: "Bienvenida a Anfitorio Madrid Centro",
        body: "Hola {{guest_name}}, soy el asistente AI del hotel. Recepcion puede ayudarte en cualquier momento.",
        variablesJson: { guest_name: "Guest name" },
        active: false
      }
    });
  } else {
    result = getReadiness(input.propertyId);
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
