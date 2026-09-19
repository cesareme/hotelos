// Acceso Prisma de las tablas de puesta en marcha del back office (Tanda L2 · L2-04):
// module_health_checks, property_setup_steps, manual_setup_submissions y
// property_setup_form_submissions. Este fichero solo lee y escribe filas; los
// catálogos (pasos, formularios, opciones manuales) y las funciones de servicio
// que consumen las rutas siguen en backoffice.service.ts.

import { prisma, type Prisma } from "@hotelos/database";
import type { HotelModuleCode } from "@hotelos/product";
import type {
  ManualSetupSubmissionRecord,
  ModuleHealthCheckRecord,
  PropertySetupFormSubmissionRecord,
  PropertySetupStepRecord
} from "../../lib/demo-store.js";

const LIST_TAKE = 200;

/**
 * Tanda L5 (lote C): las escrituras de pasos aceptan un cliente de transacción
 * para que el go-live escriba `properties.go_live_at` y complete el paso
 * `go_live` de forma atómica (backoffice.service.ts approveGoLive).
 */
export type SetupStoreDb = Prisma.TransactionClient | typeof prisma;

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function jsonRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(jsonRecord) : [];
}

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

// ---------------------------------------------------------------------------
// module_health_checks (unique [propertyId, moduleCode, checkCode])
// ---------------------------------------------------------------------------

type ModuleHealthRow = NonNullable<Awaited<ReturnType<typeof prisma.moduleHealthCheck.findUnique>>>;

export type ModuleHealthCheckInput = {
  checkCode: string;
  status: ModuleHealthCheckRecord["status"];
  severity: ModuleHealthCheckRecord["severity"];
  message: string;
  metadataJson?: Record<string, unknown>;
};

function toModuleHealthRecord(row: ModuleHealthRow): ModuleHealthCheckRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    moduleCode: row.moduleCode as HotelModuleCode,
    checkCode: row.checkCode,
    status: row.status as ModuleHealthCheckRecord["status"],
    severity: row.severity as ModuleHealthCheckRecord["severity"],
    message: row.message,
    metadataJson: jsonRecord(row.metadataJson),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Todos los checks de la propiedad (o solo los de un módulo) en UNA consulta. */
export async function listModuleHealthChecks(propertyId: string, moduleCode?: HotelModuleCode): Promise<ModuleHealthCheckRecord[]> {
  const rows = await prisma.moduleHealthCheck.findMany({
    where: { propertyId, ...(moduleCode ? { moduleCode } : {}) },
    orderBy: [{ moduleCode: "asc" }, { checkCode: "asc" }],
    take: 1000
  });
  return rows.map(toModuleHealthRecord);
}

/** Upsert de cada check del módulo y borrado de los códigos que ya no calcula el catálogo (transacción). */
export async function replaceModuleHealthChecks(
  propertyId: string,
  moduleCode: HotelModuleCode,
  checks: readonly ModuleHealthCheckInput[]
): Promise<ModuleHealthCheckRecord[]> {
  const rows = await prisma.$transaction(async (tx) => {
    const upserted: ModuleHealthRow[] = [];
    for (const check of checks) {
      const data = {
        status: check.status,
        severity: check.severity,
        message: check.message,
        metadataJson: asJson(check.metadataJson ?? {})
      };
      upserted.push(
        await tx.moduleHealthCheck.upsert({
          where: { propertyId_moduleCode_checkCode: { propertyId, moduleCode, checkCode: check.checkCode } },
          create: { propertyId, moduleCode, checkCode: check.checkCode, ...data },
          update: data
        })
      );
    }
    await tx.moduleHealthCheck.deleteMany({
      where: { propertyId, moduleCode, checkCode: { notIn: checks.map((check) => check.checkCode) } }
    });
    return upserted;
  });
  return rows.map(toModuleHealthRecord);
}

// ---------------------------------------------------------------------------
// property_setup_steps (unique [propertyId, stepCode])
// ---------------------------------------------------------------------------

type SetupStepRow = NonNullable<Awaited<ReturnType<typeof prisma.propertySetupStep.findUnique>>>;

function toSetupStepRecord(row: SetupStepRow): PropertySetupStepRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    stepCode: row.stepCode,
    status: row.status as PropertySetupStepRecord["status"],
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
    completedBy: orUndefined(row.completedBy),
    metadataJson: jsonRecord(row.metadataJson)
  };
}

/** Estado inicial `not_started` de cada paso del catálogo (idempotente: createMany + skipDuplicates). */
export async function ensureSetupSteps(propertyId: string, stepCodes: readonly string[], db: SetupStoreDb = prisma): Promise<void> {
  if (stepCodes.length === 0) return;
  await db.propertySetupStep.createMany({
    data: stepCodes.map((stepCode) => ({ propertyId, stepCode, status: "not_started", metadataJson: {} })),
    skipDuplicates: true
  });
}

/** Pasos de la propiedad en el orden del catálogo (los códigos fuera del catálogo van al final). */
export async function listSetupSteps(propertyId: string, stepCodes: readonly string[]): Promise<PropertySetupStepRecord[]> {
  const rows = await prisma.propertySetupStep.findMany({ where: { propertyId }, take: 500 });
  const order = new Map(stepCodes.map((code, index) => [code, index]));
  const rank = (code: string) => order.get(code) ?? stepCodes.length;
  return rows
    .map(toSetupStepRecord)
    .sort((a, b) => rank(a.stepCode) - rank(b.stepCode) || a.stepCode.localeCompare(b.stepCode));
}

export async function findSetupStep(propertyId: string, stepCode: string): Promise<PropertySetupStepRecord | null> {
  const row = await prisma.propertySetupStep.findUnique({ where: { propertyId_stepCode: { propertyId, stepCode } } });
  return row ? toSetupStepRecord(row) : null;
}

export async function upsertSetupStep(
  propertyId: string,
  stepCode: string,
  data: { status: PropertySetupStepRecord["status"]; completedAt: Date | null; completedBy: string | null; metadataJson: Record<string, unknown> },
  db: SetupStoreDb = prisma
): Promise<PropertySetupStepRecord> {
  const payload = { status: data.status, completedAt: data.completedAt, completedBy: data.completedBy, metadataJson: asJson(data.metadataJson) };
  const row = await db.propertySetupStep.upsert({
    where: { propertyId_stepCode: { propertyId, stepCode } },
    create: { propertyId, stepCode, ...payload },
    update: payload
  });
  return toSetupStepRecord(row);
}

// ---------------------------------------------------------------------------
// manual_setup_submissions
// ---------------------------------------------------------------------------

type ManualSetupRow = NonNullable<Awaited<ReturnType<typeof prisma.manualSetupSubmission.findUnique>>>;

function toManualSetupRecord(row: ManualSetupRow): ManualSetupSubmissionRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    optionCode: row.optionCode,
    status: row.status as ManualSetupSubmissionRecord["status"],
    payloadJson: jsonRecord(row.payloadJson),
    validationErrorsJson: jsonStringArray(row.validationErrorsJson),
    targetTables: jsonStringArray(row.targetTablesJson),
    inputCategories: jsonStringArray(row.inputCategoriesJson),
    completionChecksJson: jsonRecordArray(row.completionChecksJson),
    createdBy: orUndefined(row.createdBy),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Envíos de la propiedad (opcionalmente de una opción) del más antiguo al más reciente, máximo 200. */
export async function listManualSetupSubmissions(propertyId: string, optionCode?: string): Promise<ManualSetupSubmissionRecord[]> {
  const rows = await prisma.manualSetupSubmission.findMany({
    where: { propertyId, ...(optionCode ? { optionCode } : {}) },
    orderBy: { createdAt: "asc" },
    take: LIST_TAKE
  });
  return rows.map(toManualSetupRecord);
}

/** Último envío por opción en UNA consulta (distinct sobre optionCode, orden descendente). */
export async function latestManualSetupSubmissionsByOption(propertyId: string): Promise<Map<string, ManualSetupSubmissionRecord>> {
  const rows = await prisma.manualSetupSubmission.findMany({
    where: { propertyId },
    orderBy: [{ optionCode: "asc" }, { createdAt: "desc" }],
    distinct: ["optionCode"],
    take: LIST_TAKE
  });
  return new Map(rows.map((row) => [row.optionCode, toManualSetupRecord(row)]));
}

export async function createManualSetupSubmission(
  input: Omit<ManualSetupSubmissionRecord, "id" | "createdAt" | "updatedAt">
): Promise<ManualSetupSubmissionRecord> {
  const row = await prisma.manualSetupSubmission.create({
    data: {
      propertyId: input.propertyId,
      optionCode: input.optionCode,
      status: input.status,
      payloadJson: asJson(input.payloadJson),
      validationErrorsJson: asJson(input.validationErrorsJson),
      targetTablesJson: asJson(input.targetTables),
      inputCategoriesJson: asJson(input.inputCategories),
      completionChecksJson: asJson(input.completionChecksJson),
      createdBy: input.createdBy ?? null
    }
  });
  return toManualSetupRecord(row);
}

// ---------------------------------------------------------------------------
// property_setup_form_submissions
// ---------------------------------------------------------------------------

type SetupFormRow = NonNullable<Awaited<ReturnType<typeof prisma.propertySetupFormSubmission.findUnique>>>;

function toSetupFormRecord(row: SetupFormRow): PropertySetupFormSubmissionRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    formCode: row.formCode,
    status: row.status as PropertySetupFormSubmissionRecord["status"],
    payloadJson: jsonRecord(row.payloadJson),
    validationErrorsJson: jsonStringArray(row.validationErrorsJson),
    targetEntityType: orUndefined(row.targetEntityType),
    targetEntityId: orUndefined(row.targetEntityId),
    createdBy: orUndefined(row.createdBy),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export async function listSetupFormSubmissions(propertyId: string, formCode?: string): Promise<PropertySetupFormSubmissionRecord[]> {
  const rows = await prisma.propertySetupFormSubmission.findMany({
    where: { propertyId, ...(formCode ? { formCode } : {}) },
    orderBy: { createdAt: "asc" },
    take: LIST_TAKE
  });
  return rows.map(toSetupFormRecord);
}

/** Último envío por formulario en UNA consulta. */
export async function latestSetupFormSubmissionsByForm(propertyId: string): Promise<Map<string, PropertySetupFormSubmissionRecord>> {
  const rows = await prisma.propertySetupFormSubmission.findMany({
    where: { propertyId },
    orderBy: [{ formCode: "asc" }, { createdAt: "desc" }],
    distinct: ["formCode"],
    take: LIST_TAKE
  });
  return new Map(rows.map((row) => [row.formCode, toSetupFormRecord(row)]));
}

export async function createSetupFormSubmission(
  input: Omit<PropertySetupFormSubmissionRecord, "id" | "createdAt" | "updatedAt">
): Promise<PropertySetupFormSubmissionRecord> {
  const row = await prisma.propertySetupFormSubmission.create({
    data: {
      propertyId: input.propertyId,
      formCode: input.formCode,
      status: input.status,
      payloadJson: asJson(input.payloadJson),
      validationErrorsJson: asJson(input.validationErrorsJson),
      targetEntityType: input.targetEntityType ?? null,
      targetEntityId: input.targetEntityId ?? null,
      createdBy: input.createdBy ?? null
    }
  });
  return toSetupFormRecord(row);
}
