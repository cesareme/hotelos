// Reputación · Tanda T8 · lote T8-C — fuentes de reseñas (ReviewSource)
// (apps/api/src/modules/reputation/review-sources.service.ts).
//
// CRUD honesto sobre la tabla existente (schema.prisma:1876-1886: id,
// propertyId, provider, status, configJson, createdAt). Lo que el parche T8-L0
// convertirá en columnas (mode, displayName, weight, retentionDays, ids
// externos, capacidades, lastRunAt/lastSuccessAt/lastError, cursor, runs) vive
// en configJson con la forma ReviewSourceConfig v1 de reputation-types.ts.
//
// Reglas:
//   · zod en toda entrada (`.strict()`: ninguna clave desconocida) y además
//     hasCredentialKeys(): las credenciales NUNCA entran en configJson
//     (integrations.service.ts:193-195); hasta T8-L0 no existe credentialsJson,
//     así que `hasCredentials` es siempre false en el DTO;
//   · el estado inicial lo fija el colector (describeState): google/booking/
//     expedia sin credenciales → `unavailable`/`pending` con lastError honesto;
//     csv/manual/demo → `connected`;
//   · desactivar = status `disabled`; nunca delete físico (las reseñas
//     importadas conservan su sourceId);
//   · nunca devuelve credenciales; `db` inyectable; auditoría inyectable.

import { prisma, type Prisma } from "@hotelos/database";
import { z } from "zod";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { collectorFor, type CollectorOptions, type CollectorSource } from "./collectors/index.js";
import {
  DEFAULT_SOURCE_MODE,
  REVIEW_PROVIDERS,
  REVIEW_SOURCE_MODES,
  SOURCE_WEIGHT_MAX,
  SOURCE_WEIGHT_MIN,
  baseProvider,
  hasCredentialKeys,
  isReviewSourceStatus,
  readSourceConfig,
  writeSourceConfig,
  type ReviewProvider,
  type ReviewSourceConfig,
  type ReviewSourceConfigInput,
  type ReviewSourceDto,
  type ReviewSourceRunDto,
  type ReviewSourceStatus
} from "./reputation-types.js";
import type { ReputationDb, ReviewSourceRow } from "./review-meta.store.js";

export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 3650;

const displayNameSchema = z.string().trim().min(1, "displayName no puede estar vacío.").max(120);
const externalIdSchema = z.string().trim().min(1).max(200);

export const REVIEW_SOURCE_CREATE_SCHEMA = z
  .object({
    provider: z.enum(REVIEW_PROVIDERS),
    mode: z.enum(REVIEW_SOURCE_MODES).optional(),
    displayName: displayNameSchema.optional(),
    weight: z.number().min(SOURCE_WEIGHT_MIN, `weight mínimo ${SOURCE_WEIGHT_MIN}.`).max(SOURCE_WEIGHT_MAX, `weight máximo ${SOURCE_WEIGHT_MAX}.`).optional(),
    retentionDays: z.number().int().min(RETENTION_DAYS_MIN).max(RETENTION_DAYS_MAX).optional(),
    externalLocationId: externalIdSchema.optional(),
    externalAccountId: externalIdSchema.optional(),
    isDemo: z.boolean().optional()
  })
  .strict();

export const REVIEW_SOURCE_UPDATE_SCHEMA = z
  .object({
    mode: z.enum(REVIEW_SOURCE_MODES).optional(),
    displayName: displayNameSchema.optional(),
    weight: z.number().min(SOURCE_WEIGHT_MIN).max(SOURCE_WEIGHT_MAX).optional(),
    retentionDays: z.number().int().min(RETENTION_DAYS_MIN).max(RETENTION_DAYS_MAX).optional(),
    externalLocationId: externalIdSchema.nullable().optional(),
    externalAccountId: externalIdSchema.nullable().optional(),
    /** Reactiva una fuente `disabled` (vuelve al estado que diga el colector). */
    enabled: z.boolean().optional()
  })
  .strict();

export type ReviewSourceCreateInput = z.infer<typeof REVIEW_SOURCE_CREATE_SCHEMA>;
export type ReviewSourceUpdateInput = z.infer<typeof REVIEW_SOURCE_UPDATE_SCHEMA>;

export type ReviewSourceActor = {
  organizationId: string;
  userId?: string;
  correlationId?: string;
};

export type ReviewSourceDeps = { audit?: typeof recordAuditEvent };
const defaultDeps: Required<ReviewSourceDeps> = { audit: recordAuditEvent };

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

function rowStatus(row: Pick<ReviewSourceRow, "status">): ReviewSourceStatus {
  return isReviewSourceStatus(row.status) ? row.status : "connected";
}

/** Fila → DTO de cable (sin credenciales; `hasCredentials` false hasta T8-L0). */
export function toReviewSourceDto(row: ReviewSourceRow): ReviewSourceDto {
  const config = readSourceConfig(row.configJson, row.provider);
  const runs: ReviewSourceRunDto[] = config.runs.map((run) => ({ ...run, sourceId: row.id, provider: row.provider }));
  return {
    id: row.id,
    propertyId: row.propertyId,
    provider: row.provider,
    mode: config.mode,
    status: rowStatus(row),
    displayName: config.displayName,
    weight: config.weight,
    retentionDays: config.retentionDays,
    externalLocationId: config.externalLocationId ?? null,
    externalAccountId: config.externalAccountId ?? null,
    capabilities: config.capabilities,
    lastRunAt: config.lastRunAt ?? null,
    lastSuccessAt: config.lastSuccessAt ?? null,
    lastError: config.lastError ?? null,
    hasCredentials: false,
    runs,
    isDemo: config.isDemo === true,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
  };
}

// ---------------------------------------------------------------------------
// Validación y estado inicial
// ---------------------------------------------------------------------------

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  if (input && typeof input === "object") {
    const leaked = hasCredentialKeys(input);
    if (leaked.length > 0) throw new BadRequestError(`Las credenciales no viajan en la configuración de la fuente (${leaked.join(", ")}): autoriza el portal desde su flujo OAuth.`);
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new BadRequestError(`${what} no válido. ${path}${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

/** Código guardado en ReviewSource.provider: `google`, o `google_demo` para fuentes de demostración. */
export function providerCodeFor(provider: ReviewProvider, isDemo: boolean | undefined): string {
  return isDemo && provider !== "demo" ? `${provider}_demo` : provider;
}

/** Estado honesto de una fuente según su colector (sin red). */
export function describeSourceStatus(input: { propertyId: string; sourceId?: string; providerCode: string; config: ReviewSourceConfig; options?: CollectorOptions }): {
  status: ReviewSourceStatus;
  reason?: string;
} {
  const base = baseProvider(input.providerCode);
  if (!base) return { status: "unavailable", reason: `Proveedor desconocido: ${input.providerCode}.` };
  const collector = collectorFor(base, input.config.mode);
  if (!collector) return { status: "unavailable", reason: `No existe colector para ${base} en modo ${input.config.mode}.` };
  const source: CollectorSource = {
    propertyId: input.propertyId,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    provider: base,
    config: input.config,
    credentials: null,
    ...(input.options ? { options: input.options } : {})
  };
  const state = collector.describeState(source);
  return { status: state.status, ...(state.reason ? { reason: state.reason } : {}) };
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export async function listReviewSources(input: { db?: ReputationDb; propertyId: string; includeDisabled?: boolean }): Promise<ReviewSourceDto[]> {
  const db = input.db ?? prisma;
  const rows = await db.reviewSource.findMany({
    where: { propertyId: input.propertyId, ...(input.includeDisabled ? {} : { status: { not: "disabled" } }) },
    orderBy: { createdAt: "asc" }
  });
  return rows.map(toReviewSourceDto);
}

async function loadRow(db: ReputationDb, id: string, propertyId: string): Promise<ReviewSourceRow> {
  const row = await db.reviewSource.findFirst({ where: { id, propertyId } });
  if (!row) throw new NotFoundError("Fuente de reseñas no encontrada.");
  return row;
}

export async function getReviewSource(input: { db?: ReputationDb; id: string; propertyId: string }): Promise<ReviewSourceDto> {
  return toReviewSourceDto(await loadRow(input.db ?? prisma, input.id, input.propertyId));
}

// ---------------------------------------------------------------------------
// Escritura (auditada)
// ---------------------------------------------------------------------------

export async function createReviewSource(input: {
  db?: ReputationDb;
  propertyId: string;
  input: unknown;
  actor: ReviewSourceActor;
  now?: Date;
  options?: CollectorOptions;
  deps?: ReviewSourceDeps;
}): Promise<ReviewSourceDto> {
  const db = input.db ?? prisma;
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const body = parseOrThrow(REVIEW_SOURCE_CREATE_SCHEMA, input.input, "Fuente de reseñas");
  const providerCode = providerCodeFor(body.provider, body.isDemo);
  const mode = body.mode ?? DEFAULT_SOURCE_MODE[body.provider];
  if (!collectorFor(body.provider, mode)) {
    throw new BadRequestError(`El proveedor ${body.provider} no admite el modo ${mode}.`);
  }
  const configInput: ReviewSourceConfigInput = {
    mode,
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.weight !== undefined ? { weight: body.weight } : {}),
    ...(body.retentionDays !== undefined ? { retentionDays: body.retentionDays } : {}),
    ...(body.externalLocationId ? { externalLocationId: body.externalLocationId } : {}),
    ...(body.externalAccountId ? { externalAccountId: body.externalAccountId } : {}),
    ...(body.isDemo ? { isDemo: true } : {}),
    runs: []
  };
  const config = readSourceConfig(configInput, providerCode);
  const state = describeSourceStatus({ propertyId: input.propertyId, providerCode, config, ...(input.options ? { options: input.options } : {}) });
  const finalConfig: ReviewSourceConfig = state.status === "connected" ? config : { ...config, ...(state.reason ? { lastError: state.reason } : {}) };
  const row = await db.reviewSource.create({
    data: {
      propertyId: input.propertyId,
      provider: providerCode,
      status: state.status,
      configJson: writeSourceConfig(finalConfig, providerCode) as Prisma.InputJsonValue
    }
  });
  const dto = toReviewSourceDto(row);
  deps.audit({
    organizationId: input.actor.organizationId,
    propertyId: input.propertyId,
    ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
    actorType: input.actor.userId ? "user" : "system",
    action: "ReviewSourceCreated",
    entityType: "review_source",
    entityId: row.id,
    afterJson: { provider: dto.provider, mode: dto.mode, status: dto.status, displayName: dto.displayName },
    ...(input.actor.correlationId ? { correlationId: input.actor.correlationId } : {})
  });
  return dto;
}

export async function updateReviewSource(input: {
  db?: ReputationDb;
  id: string;
  propertyId: string;
  input: unknown;
  actor: ReviewSourceActor;
  options?: CollectorOptions;
  deps?: ReviewSourceDeps;
}): Promise<ReviewSourceDto> {
  const db = input.db ?? prisma;
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const body = parseOrThrow(REVIEW_SOURCE_UPDATE_SCHEMA, input.input, "Fuente de reseñas");
  const row = await loadRow(db, input.id, input.propertyId);
  const before = toReviewSourceDto(row);
  const current = readSourceConfig(row.configJson, row.provider);
  const base = baseProvider(row.provider);
  const mode = body.mode ?? current.mode;
  if (base && !collectorFor(base, mode)) throw new BadRequestError(`El proveedor ${base} no admite el modo ${mode}.`);
  const next: ReviewSourceConfig = {
    ...current,
    mode,
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.weight !== undefined ? { weight: body.weight } : {}),
    ...(body.retentionDays !== undefined ? { retentionDays: body.retentionDays } : {})
  };
  if (body.externalLocationId !== undefined) {
    if (body.externalLocationId === null) delete next.externalLocationId;
    else next.externalLocationId = body.externalLocationId;
  }
  if (body.externalAccountId !== undefined) {
    if (body.externalAccountId === null) delete next.externalAccountId;
    else next.externalAccountId = body.externalAccountId;
  }
  // Estado: se recalcula con el colector cuando cambian modo/ids o al reactivar;
  // una fuente `error`/`degraded` conserva su estado hasta el siguiente tick.
  const wasDisabled = rowStatus(row) === "disabled";
  let status = rowStatus(row);
  const recompute = body.mode !== undefined || body.externalLocationId !== undefined || body.externalAccountId !== undefined || (wasDisabled && body.enabled === true);
  if (wasDisabled && body.enabled !== true) {
    status = "disabled";
  } else if (recompute) {
    const state = describeSourceStatus({ propertyId: row.propertyId, sourceId: row.id, providerCode: row.provider, config: next, ...(input.options ? { options: input.options } : {}) });
    status = state.status;
    if (state.status === "connected") delete next.lastError;
    else if (state.reason) next.lastError = state.reason;
  }
  const updated = await db.reviewSource.update({
    where: { id: row.id },
    data: { status, configJson: writeSourceConfig(next, row.provider) as Prisma.InputJsonValue }
  });
  const dto = toReviewSourceDto(updated);
  deps.audit({
    organizationId: input.actor.organizationId,
    propertyId: input.propertyId,
    ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
    actorType: input.actor.userId ? "user" : "system",
    action: "ReviewSourceUpdated",
    entityType: "review_source",
    entityId: row.id,
    beforeJson: { mode: before.mode, status: before.status, weight: before.weight, retentionDays: before.retentionDays, displayName: before.displayName },
    afterJson: { mode: dto.mode, status: dto.status, weight: dto.weight, retentionDays: dto.retentionDays, displayName: dto.displayName },
    ...(input.actor.correlationId ? { correlationId: input.actor.correlationId } : {})
  });
  return dto;
}

/** Desactiva la fuente (status `disabled`); nunca borra la fila. */
export async function disableReviewSource(input: { db?: ReputationDb; id: string; propertyId: string; actor: ReviewSourceActor; deps?: ReviewSourceDeps }): Promise<ReviewSourceDto> {
  const db = input.db ?? prisma;
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const row = await loadRow(db, input.id, input.propertyId);
  const previous = rowStatus(row);
  const updated = previous === "disabled" ? row : await db.reviewSource.update({ where: { id: row.id }, data: { status: "disabled" } });
  const dto = toReviewSourceDto(updated);
  if (previous !== "disabled") {
    deps.audit({
      organizationId: input.actor.organizationId,
      propertyId: input.propertyId,
      ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
      actorType: input.actor.userId ? "user" : "system",
      action: "ReviewSourceDisabled",
      entityType: "review_source",
      entityId: row.id,
      beforeJson: { status: previous },
      afterJson: { status: "disabled" },
      ...(input.actor.correlationId ? { correlationId: input.actor.correlationId } : {})
    });
  }
  return dto;
}
