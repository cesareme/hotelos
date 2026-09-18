// Acceso Prisma del gestor de categorías y campos personalizados del back office
// (Tanda L2 · L2-04): category_definitions (catálogo global sembrado desde el
// código en cada arranque), property_category_options (+ traducciones),
// property_custom_field_definitions y property_custom_field_values. Solo filas:
// el catálogo de definiciones (CATEGORY_DEFINITION_CATALOG), los esquemas zod y
// las funciones de servicio viven en backoffice.service.ts. Toda consulta
// filtra por propertyId; la organización se comprueba en el servicio a partir
// de la propiedad.

import { prisma, type Prisma } from "@hotelos/database";
import { ConflictError, describePrismaError } from "../../lib/http-error.js";

const LIST_TAKE = 500;

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

/** P2002 → 409 tipado en español (describePrismaError); cualquier otro error se propaga. */
function rethrowAsConflict(error: unknown, message: string): never {
  const described = describePrismaError(error);
  if (described?.statusCode === 409) {
    throw new ConflictError(message, described.details);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Tipos (misma forma que servía la versión en memoria, más traducciones y fechas)
// ---------------------------------------------------------------------------

export type CategoryMode = "system_controlled" | "property_editable" | "property_extendable" | "read_only";

export type CategoryGroup =
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

export type CategoryDefinitionRecord = {
  id: string;
  code: string;
  name: string;
  description?: string;
  categoryGroup: CategoryGroup;
  entityType?: string;
  mode: CategoryMode;
  valueSchemaJson: Record<string, unknown>;
  isCore: boolean;
  active: boolean;
  sortOrder: number;
};

export type PropertyCategoryOptionTranslationRecord = {
  language: string;
  label: string;
  description?: string;
};

export type PropertyCategoryOptionRecord = {
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
  /**
   * Registros vinculados. Ninguna tabla referencia hoy una opción de categoría
   * por id, así que el recuento real es 0 (la versión en memoria mostraba cifras
   * de demostración inventadas).
   */
  usageCount: number;
  translations: PropertyCategoryOptionTranslationRecord[];
  createdAt: string;
  updatedAt: string;
};

export type PropertyCustomFieldDefinitionRecord = {
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
  createdAt: string;
  updatedAt: string;
};

export type PropertyCustomFieldValueRecord = {
  id: string;
  propertyId: string;
  entityType: string;
  entityId: string;
  fieldDefinitionId: string;
  valueJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// category_definitions (catálogo global, code @unique)
// ---------------------------------------------------------------------------

type DefinitionRow = NonNullable<Awaited<ReturnType<typeof prisma.categoryDefinition.findUnique>>>;

function toDefinitionRecord(row: DefinitionRow): CategoryDefinitionRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: orUndefined(row.description),
    categoryGroup: row.categoryGroup as CategoryGroup,
    entityType: orUndefined(row.entityType),
    mode: row.mode as CategoryMode,
    valueSchemaJson: jsonRecord(row.valueSchemaJson),
    isCore: row.isCore,
    active: row.active,
    sortOrder: row.sortOrder
  };
}

let definitionsSeedPromise: Promise<void> | null = null;

/**
 * Siembra/actualiza el catálogo de definiciones una vez por proceso (las
 * llamadas siguientes reutilizan la promesa; se reintenta si falló):
 *   1. createMany + skipDuplicates → filas nuevas por `code` (ON CONFLICT DO
 *      NOTHING: seguro con dos procesos arrancando a la vez);
 *   2. updateMany por `code` → el catálogo de código manda sobre nombre, grupo,
 *      modo, esquema y orden; el id de una fila existente se conserva.
 */
export function ensureCategoryDefinitions(catalog: readonly CategoryDefinitionRecord[]): Promise<void> {
  if (!definitionsSeedPromise) {
    definitionsSeedPromise = (async () => {
      await prisma.categoryDefinition.createMany({
        data: catalog.map((entry) => ({
          id: entry.id,
          code: entry.code,
          name: entry.name,
          description: entry.description ?? null,
          categoryGroup: entry.categoryGroup,
          entityType: entry.entityType ?? null,
          mode: entry.mode,
          valueSchemaJson: asJson(entry.valueSchemaJson),
          isCore: entry.isCore,
          active: entry.active,
          sortOrder: entry.sortOrder
        })),
        skipDuplicates: true
      });
      await prisma.$transaction(
        catalog.map((entry) =>
          prisma.categoryDefinition.updateMany({
            where: { code: entry.code },
            data: {
              name: entry.name,
              description: entry.description ?? null,
              categoryGroup: entry.categoryGroup,
              entityType: entry.entityType ?? null,
              mode: entry.mode,
              valueSchemaJson: asJson(entry.valueSchemaJson),
              isCore: entry.isCore,
              active: entry.active,
              sortOrder: entry.sortOrder
            }
          })
        )
      );
    })().catch((error: unknown) => {
      definitionsSeedPromise = null;
      throw error;
    });
  }
  return definitionsSeedPromise;
}

/** Solo para tests: descarta la memoización de la siembra. */
export function resetCategoryDefinitionsSeedForTests(): void {
  definitionsSeedPromise = null;
}

export async function listCategoryDefinitions(): Promise<CategoryDefinitionRecord[]> {
  const rows = await prisma.categoryDefinition.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }], take: LIST_TAKE });
  return rows.map(toDefinitionRecord);
}

export async function findCategoryDefinitionByCode(code: string): Promise<CategoryDefinitionRecord | null> {
  const row = await prisma.categoryDefinition.findUnique({ where: { code } });
  return row && row.active ? toDefinitionRecord(row) : null;
}

export async function findCategoryDefinitionById(id: string): Promise<CategoryDefinitionRecord | null> {
  const row = await prisma.categoryDefinition.findUnique({ where: { id } });
  return row ? toDefinitionRecord(row) : null;
}

// ---------------------------------------------------------------------------
// property_category_options (+ property_category_option_translations)
// ---------------------------------------------------------------------------

type OptionRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyCategoryOption.findUnique>>>;
type TranslationRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyCategoryOptionTranslation.findUnique>>>;

function toOptionRecord(row: OptionRow, translations: TranslationRow[]): PropertyCategoryOptionRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    categoryDefinitionId: row.categoryDefinitionId,
    code: row.code,
    label: row.label,
    description: orUndefined(row.description),
    colorToken: orUndefined(row.colorToken),
    iconName: orUndefined(row.iconName),
    parentOptionId: orUndefined(row.parentOptionId),
    metadataJson: jsonRecord(row.metadataJson),
    isSystemDefault: row.isSystemDefault,
    active: row.active,
    sortOrder: row.sortOrder,
    createdBy: orUndefined(row.createdBy),
    updatedBy: orUndefined(row.updatedBy),
    usageCount: 0,
    translations: translations
      .filter((translation) => translation.categoryOptionId === row.id)
      .sort((a, b) => a.language.localeCompare(b.language))
      .map((translation) => ({ language: translation.language, label: translation.label, description: orUndefined(translation.description) })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

async function translationsFor(optionIds: string[]): Promise<TranslationRow[]> {
  if (optionIds.length === 0) return [];
  return prisma.propertyCategoryOptionTranslation.findMany({ where: { categoryOptionId: { in: optionIds } }, take: 5000 });
}

export type CategoryOptionTranslationWrite = {
  language: string;
  label: string;
  description?: string | null;
};

export type CategoryOptionWrite = {
  code: string;
  label: string;
  description?: string | null;
  colorToken?: string | null;
  iconName?: string | null;
  parentOptionId?: string | null;
  metadataJson?: Record<string, unknown>;
  isSystemDefault?: boolean;
  active?: boolean;
  sortOrder?: number;
  translations?: CategoryOptionTranslationWrite[];
};

/** Opciones de la propiedad (opcionalmente de una categoría) con sus traducciones: dos consultas. */
export async function listPropertyCategoryOptions(
  propertyId: string,
  filter: { categoryDefinitionId?: string; active?: boolean } = {}
): Promise<PropertyCategoryOptionRecord[]> {
  const rows = await prisma.propertyCategoryOption.findMany({
    where: {
      propertyId,
      ...(filter.categoryDefinitionId ? { categoryDefinitionId: filter.categoryDefinitionId } : {}),
      ...(filter.active !== undefined ? { active: filter.active } : {})
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: 2000
  });
  const translations = await translationsFor(rows.map((row) => row.id));
  return rows.map((row) => toOptionRecord(row, translations));
}

export async function countPropertyCategoryOptions(propertyId: string, filter: { categoryDefinitionId?: string; active?: boolean } = {}): Promise<number> {
  return prisma.propertyCategoryOption.count({
    where: {
      propertyId,
      ...(filter.categoryDefinitionId ? { categoryDefinitionId: filter.categoryDefinitionId } : {}),
      ...(filter.active !== undefined ? { active: filter.active } : {})
    }
  });
}

export async function findPropertyCategoryOption(propertyId: string, optionId: string): Promise<PropertyCategoryOptionRecord | null> {
  const row = await prisma.propertyCategoryOption.findFirst({ where: { id: optionId, propertyId } });
  if (!row) return null;
  return toOptionRecord(row, await translationsFor([row.id]));
}

export async function findPropertyCategoryOptionByCode(propertyId: string, categoryDefinitionId: string, code: string): Promise<PropertyCategoryOptionRecord | null> {
  const row = await prisma.propertyCategoryOption.findUnique({
    where: { propertyId_categoryDefinitionId_code: { propertyId, categoryDefinitionId, code } }
  });
  if (!row) return null;
  return toOptionRecord(row, await translationsFor([row.id]));
}

export const CATEGORY_OPTION_CODE_CONFLICT = "El código de la opción debe ser único por propiedad y categoría.";

/** Crea la opción y sus traducciones en una transacción; código duplicado → 409. */
export async function createPropertyCategoryOption(input: {
  propertyId: string;
  categoryDefinitionId: string;
  userId: string;
  option: CategoryOptionWrite;
}): Promise<PropertyCategoryOptionRecord> {
  const { option } = input;
  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.propertyCategoryOption.create({
        data: {
          propertyId: input.propertyId,
          categoryDefinitionId: input.categoryDefinitionId,
          code: option.code,
          label: option.label,
          description: option.description ?? null,
          colorToken: option.colorToken ?? null,
          iconName: option.iconName ?? null,
          parentOptionId: option.parentOptionId ?? null,
          metadataJson: asJson(option.metadataJson ?? {}),
          isSystemDefault: option.isSystemDefault ?? false,
          active: option.active ?? true,
          sortOrder: option.sortOrder ?? 0,
          createdBy: input.userId,
          updatedBy: input.userId
        }
      });
      if (option.translations && option.translations.length > 0) {
        await tx.propertyCategoryOptionTranslation.createMany({
          data: option.translations.map((translation) => ({
            categoryOptionId: created.id,
            language: translation.language,
            label: translation.label,
            description: translation.description ?? null
          }))
        });
      }
      return created;
    });
    return toOptionRecord(row, await translationsFor([row.id]));
  } catch (error) {
    return rethrowAsConflict(error, CATEGORY_OPTION_CODE_CONFLICT);
  }
}

/** Actualiza los campos presentes en `patch`; `translations` (si viene) sustituye el conjunto completo. */
export async function updatePropertyCategoryOption(input: {
  propertyId: string;
  optionId: string;
  userId: string;
  patch: Partial<CategoryOptionWrite>;
}): Promise<PropertyCategoryOptionRecord> {
  const { patch } = input;
  const data: Prisma.PropertyCategoryOptionUncheckedUpdateInput = { updatedBy: input.userId };
  if (patch.code !== undefined) data.code = patch.code;
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.colorToken !== undefined) data.colorToken = patch.colorToken;
  if (patch.iconName !== undefined) data.iconName = patch.iconName;
  if (patch.parentOptionId !== undefined) data.parentOptionId = patch.parentOptionId;
  if (patch.metadataJson !== undefined) data.metadataJson = asJson(patch.metadataJson);
  if (patch.isSystemDefault !== undefined) data.isSystemDefault = patch.isSystemDefault;
  if (patch.active !== undefined) data.active = patch.active;
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  try {
    const row = await prisma.$transaction(async (tx) => {
      // updateMany + propertyId: nunca toca una opción de otra propiedad (0 filas → 404 en el servicio).
      const result = await tx.propertyCategoryOption.updateMany({ where: { id: input.optionId, propertyId: input.propertyId }, data });
      if (result.count === 0) return null;
      if (patch.translations !== undefined) {
        await tx.propertyCategoryOptionTranslation.deleteMany({ where: { categoryOptionId: input.optionId } });
        if (patch.translations.length > 0) {
          await tx.propertyCategoryOptionTranslation.createMany({
            data: patch.translations.map((translation) => ({
              categoryOptionId: input.optionId,
              language: translation.language,
              label: translation.label,
              description: translation.description ?? null
            }))
          });
        }
      }
      return tx.propertyCategoryOption.findUniqueOrThrow({ where: { id: input.optionId } });
    });
    if (!row) throw new ConflictError("La opción de categoría ya no existe.");
    return toOptionRecord(row, await translationsFor([row.id]));
  } catch (error) {
    return rethrowAsConflict(error, CATEGORY_OPTION_CODE_CONFLICT);
  }
}

/** Nuevo orden de las opciones indicadas (todas de la misma propiedad), en una transacción. */
export async function updateCategoryOptionOrder(propertyId: string, userId: string, entries: ReadonlyArray<{ id: string; sortOrder: number }>): Promise<void> {
  await prisma.$transaction(
    entries.map((entry) =>
      prisma.propertyCategoryOption.updateMany({ where: { id: entry.id, propertyId }, data: { sortOrder: entry.sortOrder, updatedBy: userId } })
    )
  );
}

// ---------------------------------------------------------------------------
// property_custom_field_definitions / property_custom_field_values
// ---------------------------------------------------------------------------

type FieldRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyCustomFieldDefinition.findUnique>>>;
type ValueRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyCustomFieldValue.findUnique>>>;

function toFieldRecord(row: FieldRow): PropertyCustomFieldDefinitionRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    entityType: row.entityType,
    fieldKey: row.fieldKey,
    label: row.label,
    description: orUndefined(row.description),
    dataType: row.dataType as PropertyCustomFieldDefinitionRecord["dataType"],
    required: row.required,
    searchable: row.searchable,
    visibleInList: row.visibleInList,
    visibleInDetail: row.visibleInDetail,
    optionsCategoryDefinitionId: orUndefined(row.optionsCategoryDefinitionId),
    validationJson: jsonRecord(row.validationJson),
    visibilityRulesJson: jsonRecord(row.visibilityRulesJson),
    defaultValueJson: jsonRecord(row.defaultValueJson),
    active: row.active,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toValueRecord(row: ValueRow): PropertyCustomFieldValueRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    entityType: row.entityType,
    entityId: row.entityId,
    fieldDefinitionId: row.fieldDefinitionId,
    valueJson: jsonRecord(row.valueJson),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export type CustomFieldWrite = {
  entityType: string;
  fieldKey: string;
  label: string;
  description?: string | null;
  dataType: PropertyCustomFieldDefinitionRecord["dataType"];
  required?: boolean;
  searchable?: boolean;
  visibleInList?: boolean;
  visibleInDetail?: boolean;
  optionsCategoryDefinitionId?: string | null;
  validationJson?: Record<string, unknown>;
  visibilityRulesJson?: Record<string, unknown>;
  defaultValueJson?: Record<string, unknown>;
  active?: boolean;
  sortOrder?: number;
};

export async function listCustomFieldDefinitions(
  propertyId: string,
  filter: { entityType?: string; active?: boolean } = {}
): Promise<PropertyCustomFieldDefinitionRecord[]> {
  const rows = await prisma.propertyCustomFieldDefinition.findMany({
    where: {
      propertyId,
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.active !== undefined ? { active: filter.active } : {})
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: LIST_TAKE
  });
  return rows.map(toFieldRecord);
}

export async function countCustomFieldDefinitions(propertyId: string, filter: { active?: boolean } = {}): Promise<number> {
  return prisma.propertyCustomFieldDefinition.count({ where: { propertyId, ...(filter.active !== undefined ? { active: filter.active } : {}) } });
}

export async function findCustomFieldDefinition(propertyId: string, fieldId: string): Promise<PropertyCustomFieldDefinitionRecord | null> {
  const row = await prisma.propertyCustomFieldDefinition.findFirst({ where: { id: fieldId, propertyId } });
  return row ? toFieldRecord(row) : null;
}

export const CUSTOM_FIELD_KEY_CONFLICT = "La clave del campo personalizado debe ser única por propiedad y tipo de entidad.";

export async function createCustomFieldDefinition(input: { propertyId: string; field: CustomFieldWrite }): Promise<PropertyCustomFieldDefinitionRecord> {
  const { field } = input;
  try {
    const row = await prisma.propertyCustomFieldDefinition.create({
      data: {
        propertyId: input.propertyId,
        entityType: field.entityType,
        fieldKey: field.fieldKey,
        label: field.label,
        description: field.description ?? null,
        dataType: field.dataType,
        required: field.required ?? false,
        searchable: field.searchable ?? false,
        visibleInList: field.visibleInList ?? false,
        visibleInDetail: field.visibleInDetail ?? true,
        optionsCategoryDefinitionId: field.optionsCategoryDefinitionId ?? null,
        validationJson: asJson(field.validationJson ?? {}),
        visibilityRulesJson: asJson(field.visibilityRulesJson ?? {}),
        defaultValueJson: asJson(field.defaultValueJson ?? {}),
        active: field.active ?? true,
        sortOrder: field.sortOrder ?? 0
      }
    });
    return toFieldRecord(row);
  } catch (error) {
    return rethrowAsConflict(error, CUSTOM_FIELD_KEY_CONFLICT);
  }
}

export async function updateCustomFieldDefinition(input: {
  propertyId: string;
  fieldId: string;
  patch: Partial<CustomFieldWrite>;
}): Promise<PropertyCustomFieldDefinitionRecord | null> {
  const { patch } = input;
  const data: Prisma.PropertyCustomFieldDefinitionUncheckedUpdateInput = {};
  if (patch.entityType !== undefined) data.entityType = patch.entityType;
  if (patch.fieldKey !== undefined) data.fieldKey = patch.fieldKey;
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.dataType !== undefined) data.dataType = patch.dataType;
  if (patch.required !== undefined) data.required = patch.required;
  if (patch.searchable !== undefined) data.searchable = patch.searchable;
  if (patch.visibleInList !== undefined) data.visibleInList = patch.visibleInList;
  if (patch.visibleInDetail !== undefined) data.visibleInDetail = patch.visibleInDetail;
  if (patch.optionsCategoryDefinitionId !== undefined) data.optionsCategoryDefinitionId = patch.optionsCategoryDefinitionId;
  if (patch.validationJson !== undefined) data.validationJson = asJson(patch.validationJson);
  if (patch.visibilityRulesJson !== undefined) data.visibilityRulesJson = asJson(patch.visibilityRulesJson);
  if (patch.defaultValueJson !== undefined) data.defaultValueJson = asJson(patch.defaultValueJson);
  if (patch.active !== undefined) data.active = patch.active;
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  try {
    const result = await prisma.propertyCustomFieldDefinition.updateMany({ where: { id: input.fieldId, propertyId: input.propertyId }, data });
    if (result.count === 0) return null;
    const row = await prisma.propertyCustomFieldDefinition.findUniqueOrThrow({ where: { id: input.fieldId } });
    return toFieldRecord(row);
  } catch (error) {
    return rethrowAsConflict(error, CUSTOM_FIELD_KEY_CONFLICT);
  }
}

export async function listCustomFieldValues(propertyId: string, entityType: string, entityId: string): Promise<PropertyCustomFieldValueRecord[]> {
  const rows = await prisma.propertyCustomFieldValue.findMany({ where: { propertyId, entityType, entityId }, orderBy: { createdAt: "asc" }, take: LIST_TAKE });
  return rows.map(toValueRecord);
}

export async function upsertCustomFieldValue(input: {
  propertyId: string;
  entityType: string;
  entityId: string;
  fieldDefinitionId: string;
  valueJson: Record<string, unknown>;
}): Promise<PropertyCustomFieldValueRecord> {
  const row = await prisma.propertyCustomFieldValue.upsert({
    where: { entityType_entityId_fieldDefinitionId: { entityType: input.entityType, entityId: input.entityId, fieldDefinitionId: input.fieldDefinitionId } },
    create: {
      propertyId: input.propertyId,
      entityType: input.entityType,
      entityId: input.entityId,
      fieldDefinitionId: input.fieldDefinitionId,
      valueJson: asJson(input.valueJson)
    },
    update: { valueJson: asJson(input.valueJson) }
  });
  return toValueRecord(row);
}
