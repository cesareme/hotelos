// Reputación · Tanda T8 · lote T8-C — persistencia sobre las tablas EXISTENTES
// (apps/api/src/modules/reputation/review-meta.store.ts).
//
// La fuente de verdad de lectura siguen siendo los JSON existentes con la forma
// tipada de reputation-types.ts: GuestReview.topicsJson = ReviewMeta v1 y
// ReviewSource.configJson = ReviewSourceConfig v1 (score10, contentHash, estado
// de bandeja, categorías, borrador, historial de ejecuciones…).
//
// Parche T8-L0 APLICADO (migración 20260919124000_reputacion, 2026-09-19) y
// activación T8-L0b FASE 1 = doble escritura: cada escritura de este fichero
// materializa además las columnas nuevas de guest_reviews / review_sources y la
// tabla review_source_runs; la lectura (bandeja, índice, listSourceConfigs,
// purga del worker) sigue por los JSON hasta la fase 2. Los stubs de los tests
// no tienen `reviewSourceRun` ni `reviewCategoryMention`: siempre con `?.`.
//
// Reglas del fichero:
//   · `db` inyectable (ReputationDb; por defecto el prisma de @hotelos/database)
//     para probar con stubs; sin variables de entorno; sin red;
//   · CARRERA CERRADA: el upsert sigue siendo findFirst + create, pero el índice
//     único `@@unique([propertyId, source, externalReference])` de T8-L0 hace
//     que el segundo escritor concurrente reciba P2002 en el create; en ese caso
//     se relee la fila y se sigue por la rama de actualización (nunca dos filas).
//     Además el tick del job es un solo líder por advisory lock
//     (reputation-sync.job.ts) y la importación CSV corre dentro de una petición;
//   · patchReviewMeta es lee-modifica-escribe sobre topicsJson (carrera teórica
//     entre dos PATCH simultáneos); las columnas equivalentes al parche se
//     escriben en el mismo update;
//   · la purga NUNCA borra filas: vacía title/body/authorDisplayName/responseBody,
//     retira los fragmentos literales (snippets y resumen) y conserva nota,
//     categorías, referencia externa y contentHash.

import { prisma, type Prisma } from "@hotelos/database";
import type { NormalizedReview } from "./collectors/types.js";
import {
  RETENTION_DAYS_DEFAULT,
  RETENTION_DAYS_GOOGLE,
  appendSourceRun,
  baseProvider,
  readReviewMeta,
  readSourceConfig,
  sentimentBucket,
  slaTargetFor,
  writeReviewMeta,
  writeSourceConfig,
  type ReviewMeta,
  type ReviewMetaInput,
  type ReviewSourceConfig,
  type ReviewSourceMode,
  type ReviewSourceRunSummary,
  type ReviewSourceStatus
} from "./reputation-types.js";
import { contentHash, externalReferenceFor, minimizeAuthorName, normalizeRatingOrNull, score5ToScore10 } from "./review-normalize.js";

/**
 * Cliente de base de datos que necesitan los servicios de reputación. Acepta el
 * singleton `prisma` y también el `tx` de una transacción (que no expone
 * `$transaction`, de ahí el Partial).
 */
export type ReputationDb = Pick<typeof prisma, "guestReview" | "reviewSource" | "qualityCase" | "propertyModule" | "module" | "inboundEmail" | "property" | "$queryRaw"> &
  Partial<Pick<typeof prisma, "$transaction" | "aiHumanReviewItem" | "reviewSourceRun" | "reviewCategoryMention">>;

export type GuestReviewRow = NonNullable<Awaited<ReturnType<typeof prisma.guestReview.findFirst>>>;
export type ReviewSourceRow = NonNullable<Awaited<ReturnType<typeof prisma.reviewSource.findFirst>>>;

export type UpsertOutcome = "created" | "updated" | "unchanged";

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** Convierte Decimal de Prisma (o número/cadena en los stubs) a número; `null` si no aplica. */
export function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object" && value !== null && "toNumber" in value && typeof (value as { toNumber: unknown }).toNumber === "function") {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** ReviewMeta v1 de una fila (tolerante: `{}` o basura devuelven defaults). */
export function getReviewMeta(row: Pick<GuestReviewRow, "topicsJson">): ReviewMeta {
  return readReviewMeta(row.topicsJson);
}

/** Nota sobre 10 de una fila: la meta manda; si falta, se deriva de `rating` (sobre 5). */
export function scoreOfRow(row: Pick<GuestReviewRow, "rating" | "topicsJson">, meta: ReviewMeta = getReviewMeta(row)): number | null {
  if (typeof meta.score10 === "number") return meta.score10;
  return score5ToScore10(decimalToNumber(row.rating));
}

function toDate(value: string | Date | null | undefined, fallback: Date): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return fallback;
}

function asJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Upsert idempotente por (propertyId, source, externalReference) + contentHash
// ---------------------------------------------------------------------------

export type UpsertReviewInput = {
  db?: ReputationDb;
  propertyId: string;
  /** Código de proveedor que se guarda en GuestReview.source (`google`, `csv`, `booking_demo`…). */
  source: string;
  sourceId?: string;
  sourceMode: ReviewSourceMode;
  item: NormalizedReview;
  now: Date;
  /** Fuerza la referencia externa (p. ej. `email:<messageId>`); por defecto externalReferenceFor(item). */
  externalReference?: string;
  isDemo?: boolean;
};

export type UpsertReviewResult = {
  outcome: UpsertOutcome;
  id: string;
  externalReference: string;
  contentHash: string;
  score10: number | null;
  meta: ReviewMeta;
};

/**
 * Crea o actualiza una reseña normalizada. Idempotente: misma referencia y
 * mismo contentHash → `unchanged`; referencia conocida con contenido distinto
 * → `updated` (title/body/rating/idioma/meta.contentHash; el análisis vuelve a
 * `pending` con la nota `content_changed`). Nunca escribe responseBody salvo la
 * respuesta que ya publicó el portal (`item.portalReply`).
 */
export async function upsertReviewFromNormalized(input: UpsertReviewInput): Promise<UpsertReviewResult> {
  const db = input.db ?? prisma;
  const { propertyId, source, item, now } = input;
  // Identidad del hash: id del portal o, si el llamador fuerza la referencia (seed `demo:<seed>:<n>`,
  // correo `email:<messageId>`), esa referencia; solo sin ninguna de las dos entra autor+fecha
  // (así el seed no cambia de hash cada día por desplazarse receivedAt).
  const hashInput = {
    source,
    externalId: item.externalId ?? input.externalReference?.trim() ?? null,
    authorDisplayName: item.authorDisplayName ?? null,
    receivedAt: item.receivedAt,
    title: item.title ?? null,
    body: item.body ?? null,
    ratingRaw: item.ratingRaw
  };
  const externalReference = input.externalReference?.trim() || externalReferenceFor({ ...hashInput, externalId: item.externalId ?? null });
  const hash = contentHash(hashInput);
  const normalized = normalizeRatingOrNull({ rating: item.ratingRaw, scaleMax: item.ratingScaleMax });
  const score10 = normalized?.score10 ?? null;
  const receivedAt = toDate(item.receivedAt, now);
  const sentiment = sentimentBucket(score10);
  const author = minimizeAuthorName(item.authorDisplayName);
  const language = item.language?.trim() || undefined;

  const updatedAtSource = item.updatedAtSource ? toDate(item.updatedAtSource, now) : null;

  // findFirst + create: la carrera la cierra el índice único de T8-L0 (P2002 → releer y actualizar).
  let existing = await db.guestReview.findFirst({ where: { propertyId, source, externalReference } });

  if (!existing) {
    const responded = item.portalReply?.body ? toDate(item.portalReply.repliedAt, now) : null;
    const slaTargetAt = slaTargetFor(receivedAt, score10);
    const metaInput: ReviewMetaInput = {
      score10,
      ratingRaw: item.ratingRaw,
      ratingScaleMax: item.ratingScaleMax,
      contentHash: hash,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      sourceMode: input.sourceMode,
      ...(author ? { authorDisplayName: author } : {}),
      ...(item.authorCountry ? { authorCountry: item.authorCountry } : {}),
      ...(item.portalUrl ? { portalUrl: item.portalUrl } : {}),
      bodyComplete: item.bodyComplete,
      status: responded ? "responded" : "new",
      slaTargetAt,
      replyCapability: item.replyCapability,
      categories: [],
      analysis: { status: "pending", source: "none" },
      ...(responded ? { response: { source: "api" as const } } : {}),
      ...(input.isDemo ? { isDemo: true } : {})
    };
    try {
      const created = await db.guestReview.create({
        data: {
          propertyId,
          source,
          rating: normalized ? normalized.score5 : null,
          title: item.title ?? null,
          body: item.body ?? null,
          language: language ?? null,
          sentiment,
          topicsJson: asJson(writeReviewMeta(metaInput)),
          externalReference,
          receivedAt,
          respondedAt: responded,
          responseBody: responded ? (item.portalReply?.body ?? null) : null,
          // T8-L0b fase 1: columnas en doble escritura con la meta (la lectura sigue por topicsJson).
          score10,
          ratingScaleMax: item.ratingScaleMax,
          sourceId: input.sourceId ?? null,
          sourceMode: input.sourceMode,
          authorDisplayName: author ?? null,
          authorCountry: item.authorCountry ?? null,
          portalUrl: item.portalUrl ?? null,
          bodyComplete: item.bodyComplete,
          contentHash: hash,
          status: responded ? "responded" : "new",
          slaTargetAt: slaTargetAt ? new Date(slaTargetAt) : null,
          replyCapability: item.replyCapability,
          analysisStatus: "pending",
          analysisSource: "none",
          responseSource: responded ? "api" : null,
          updatedAtSource
        }
      });
      const meta = readReviewMeta(created.topicsJson);
      return { outcome: "created", id: created.id, externalReference, contentHash: hash, score10, meta };
    } catch (error) {
      // Otro escritor creó la misma referencia entre el findFirst y el create (índice único de T8-L0):
      // se relee la fila y se sigue por la rama de actualización.
      if ((error as { code?: string }).code !== "P2002") throw error;
      existing = await db.guestReview.findFirst({ where: { propertyId, source, externalReference } });
      if (!existing) throw error;
    }
  }

  const currentMeta = readReviewMeta(existing.topicsJson);
  if (currentMeta.contentHash === hash) {
    return { outcome: "unchanged", id: existing.id, externalReference, contentHash: hash, score10: currentMeta.score10 ?? score10, meta: currentMeta };
  }

  const nextMeta: ReviewMetaInput = {
    ...currentMeta,
    score10,
    ratingRaw: item.ratingRaw,
    ratingScaleMax: item.ratingScaleMax,
    contentHash: hash,
    ...(author ? { authorDisplayName: author } : {}),
    bodyComplete: item.bodyComplete,
    // El contenido cambió: se vuelve a analizar en el siguiente tick.
    analysis: { status: "pending", source: currentMeta.analysis.source, note: "content_changed" }
  };
  const updated = await db.guestReview.update({
    where: { id: existing.id },
    data: {
      title: item.title ?? null,
      body: item.body ?? null,
      rating: normalized ? normalized.score5 : null,
      ...(language ? { language } : {}),
      ...(sentiment ? { sentiment } : {}),
      topicsJson: asJson(writeReviewMeta(nextMeta)),
      // T8-L0b fase 1: columnas en doble escritura con la meta.
      score10,
      ratingScaleMax: item.ratingScaleMax,
      ...(author ? { authorDisplayName: author } : {}),
      bodyComplete: item.bodyComplete,
      contentHash: hash,
      analysisStatus: "pending",
      ...(updatedAtSource ? { updatedAtSource } : {})
    }
  });
  const meta = readReviewMeta(updated.topicsJson);
  return { outcome: "updated", id: updated.id, externalReference, contentHash: hash, score10, meta };
}

// ---------------------------------------------------------------------------
// patchReviewMeta: lee-modifica-escribe topicsJson (+ columnas opcionales)
// ---------------------------------------------------------------------------

export type ReviewColumnPatch = {
  language?: string | null;
  sentiment?: string | null;
  respondedAt?: Date | null;
  responseBody?: string | null;
};

export type PatchReviewMetaInput = {
  db?: ReputationDb;
  id: string;
  /** Parcial de ReviewMeta o función que recibe la meta actual y devuelve el parcial. */
  patch: ReviewMetaInput | ((current: ReviewMeta) => ReviewMetaInput);
  /** Columnas reales de GuestReview que acompañan al parche (idioma, sentimiento…). */
  columns?: ReviewColumnPatch;
};

export type PatchReviewMetaResult = { row: GuestReviewRow; meta: ReviewMeta };

function isoToDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null;
}

/**
 * Columnas de GuestReview equivalentes a las claves presentes en el parche de
 * meta (T8-L0b fase 1, doble escritura): se derivan de la meta ya fusionada para
 * que columna y JSON coincidan; las claves ausentes del parche no se tocan.
 */
function mirroredColumns(partial: ReviewMetaInput, merged: ReviewMeta) {
  const has = (key: keyof ReviewMetaInput): boolean => Object.prototype.hasOwnProperty.call(partial, key);
  return {
    ...(has("status") ? { status: merged.status } : {}),
    ...(has("assignedUserId") ? { assignedUserId: merged.assignedUserId ?? null } : {}),
    ...(has("slaTargetAt") ? { slaTargetAt: isoToDate(merged.slaTargetAt) } : {}),
    ...(has("draft")
      ? { draftBody: merged.draft?.body ?? null, draftSource: merged.draft?.source ?? null, draftModel: merged.draft?.model ?? null, draftedAt: isoToDate(merged.draft?.draftedAt) }
      : {}),
    ...(has("response") ? { responseSource: merged.response?.source ?? null, responseExternalState: merged.response?.externalState ?? null } : {}),
    ...(has("analysis")
      ? { analysisStatus: merged.analysis.status, analysisSource: merged.analysis.source, analyzedAt: isoToDate(merged.analysis.analyzedAt), summary: merged.analysis.summary ?? null }
      : {}),
    ...(has("bodyPurgedAt") ? { bodyPurgedAt: isoToDate(merged.bodyPurgedAt) } : {})
  };
}

/** Fusiona el parche sobre la meta actual y escribe topicsJson + columnas equivalentes (404 si la fila no existe). */
export async function patchReviewMeta(input: PatchReviewMetaInput): Promise<PatchReviewMetaResult> {
  const db = input.db ?? prisma;
  const current = await db.guestReview.findFirst({ where: { id: input.id } });
  if (!current) throw new Error(`Reseña ${input.id} no encontrada.`);
  const currentMeta = readReviewMeta(current.topicsJson);
  const partial = typeof input.patch === "function" ? input.patch(currentMeta) : input.patch;
  const nextMeta = writeReviewMeta({ ...currentMeta, ...partial });
  const row = await db.guestReview.update({
    where: { id: current.id },
    data: {
      topicsJson: asJson(nextMeta),
      ...mirroredColumns(partial, readReviewMeta(nextMeta)),
      ...(input.columns?.language !== undefined ? { language: input.columns.language } : {}),
      ...(input.columns?.sentiment !== undefined ? { sentiment: input.columns.sentiment } : {}),
      ...(input.columns?.respondedAt !== undefined ? { respondedAt: input.columns.respondedAt } : {}),
      ...(input.columns?.responseBody !== undefined ? { responseBody: input.columns.responseBody } : {})
    }
  });
  return { row, meta: readReviewMeta(row.topicsJson) };
}

// ---------------------------------------------------------------------------
// Fuentes: configuración leída y historial de ejecuciones
// ---------------------------------------------------------------------------

export type SourceConfigEntry = {
  row: ReviewSourceRow;
  config: ReviewSourceConfig;
  status: ReviewSourceStatus;
};

function statusOfRow(row: Pick<ReviewSourceRow, "status">): ReviewSourceStatus {
  const value = row.status;
  return value === "pending" || value === "connected" || value === "degraded" || value === "error" || value === "disabled" || value === "unavailable" ? value : "connected";
}

/** Fuentes de la propiedad con su configuración leída (sin las `disabled` salvo `includeDisabled`). */
export async function listSourceConfigs(input: { db?: ReputationDb; propertyId: string; includeDisabled?: boolean; sourceIds?: readonly string[] }): Promise<SourceConfigEntry[]> {
  const db = input.db ?? prisma;
  const rows = await db.reviewSource.findMany({
    where: {
      propertyId: input.propertyId,
      ...(input.includeDisabled ? {} : { status: { not: "disabled" } }),
      ...(input.sourceIds && input.sourceIds.length > 0 ? { id: { in: [...input.sourceIds] } } : {})
    },
    orderBy: { createdAt: "asc" }
  });
  return rows.map((row) => ({ row, config: readSourceConfig(row.configJson, row.provider), status: statusOfRow(row) }));
}

export type SaveSourceRunInput = {
  db?: ReputationDb;
  sourceId: string;
  run: ReviewSourceRunSummary;
  /** Estado de la fuente tras la ejecución; por defecto `error` si la ejecución falló y, si no, se conserva. */
  status?: ReviewSourceStatus;
  /** Cursor del colector a persistir (nunca tokens: readCursor descarta claves de credenciales). */
  cursor?: Record<string, unknown>;
};

/**
 * Empuja la ejecución al ring buffer `configJson.runs` (≤ RUN_HISTORY_LIMIT, la
 * más reciente primero) y actualiza lastRunAt/lastSuccessAt/lastError y el
 * status de la fila. Devuelve la configuración resultante. T8-L0b fase 1: las
 * columnas de la fuente se escriben en el mismo update y la ejecución se inserta
 * además en review_source_runs (la lectura de `GET …/runs` sigue por configJson).
 */
export async function saveSourceRun(input: SaveSourceRunInput): Promise<{ row: ReviewSourceRow; config: ReviewSourceConfig }> {
  const db = input.db ?? prisma;
  const current = await db.reviewSource.findFirst({ where: { id: input.sourceId } });
  if (!current) throw new Error(`Fuente ${input.sourceId} no encontrada.`);
  const currentConfig = readSourceConfig(current.configJson, current.provider);
  let next = appendSourceRun(currentConfig, input.run);
  if (input.cursor) next = { ...next, cursor: input.cursor };
  const status: ReviewSourceStatus = input.status ?? (input.run.status === "failed" ? "error" : statusOfRow(current));
  if (input.run.status === "skipped" && input.run.error) next = { ...next, lastError: input.run.error.slice(0, 500) };
  const configJson = writeSourceConfig(next, current.provider);
  // Columnas desde la configuración ya saneada (readCursor descarta claves de credenciales): nunca tokens en cursor_json.
  const persisted = readSourceConfig(configJson, current.provider);
  const row = await db.reviewSource.update({
    where: { id: current.id },
    data: {
      status,
      configJson: asJson(configJson),
      // T8-L0b fase 1: columnas en doble escritura con la configuración.
      mode: persisted.mode,
      displayName: persisted.displayName,
      retentionDays: persisted.retentionDays,
      weight: persisted.weight,
      lastRunAt: isoToDate(persisted.lastRunAt),
      lastSuccessAt: isoToDate(persisted.lastSuccessAt),
      lastError: persisted.lastError ?? null,
      cursorJson: asJson(persisted.cursor ?? {})
    }
  });
  await db.reviewSourceRun?.create({
    data: {
      id: input.run.id,
      propertyId: current.propertyId,
      sourceId: current.id,
      provider: current.provider,
      trigger: input.run.trigger,
      status: input.run.status,
      startedAt: toDate(input.run.startedAt, new Date()),
      finishedAt: toDate(input.run.finishedAt, new Date()),
      fetched: input.run.fetched,
      created: input.run.created,
      updated: input.run.updated,
      unchanged: input.run.unchanged,
      purged: input.run.purged,
      lastError: input.run.error ?? null,
      correlationId: input.run.correlationId,
      resultJson: asJson({ ...input.run })
    }
  });
  return { row, config: readSourceConfig(row.configJson, row.provider) };
}

// ---------------------------------------------------------------------------
// Supresión RGPD (art. 17): lo que gdpr.service.ts debe retirar de topicsJson
// ---------------------------------------------------------------------------

/**
 * Meta sin datos personales ni fragmentos literales para una supresión RGPD:
 * retira autor (nombre y país), fragmentos de categorías, resumen del análisis
 * y borrador de respuesta; conserva nota, categorías, estado, referencia y
 * contentHash. Pura. La usa gdpr.service.ts (que además vacía title/body).
 */
export function scrubReviewMetaForErasure(topicsJson: unknown, now: Date): Prisma.InputJsonValue {
  const meta = readReviewMeta(topicsJson);
  const next: ReviewMetaInput = {
    ...meta,
    authorDisplayName: undefined,
    authorCountry: undefined,
    draft: null,
    bodyPurgedAt: meta.bodyPurgedAt ?? now,
    categories: meta.categories.map(({ snippet: _snippet, ...mention }) => mention),
    analysis: { ...meta.analysis, summary: undefined }
  };
  return asJson(writeReviewMeta(next));
}

// ---------------------------------------------------------------------------
// Purga de texto por retención
// ---------------------------------------------------------------------------

/** Retención (días) por defecto de un proveedor: Google 30, resto 730. */
export function defaultRetentionDays(provider: string): number {
  return baseProvider(provider) === "google" ? RETENTION_DAYS_GOOGLE : RETENTION_DAYS_DEFAULT;
}

export type PurgeExpiredBodiesInput = { db?: ReputationDb; propertyId: string; now: Date };
export type PurgeExpiredBodiesResult = { scanned: number; purged: number };

/**
 * Vacía title/body/authorDisplayName/responseBody de las reseñas cuya recepción
 * es anterior a la retención de su fuente (por `meta.sourceId`; si no, por
 * proveedor: Google 30 días, resto `configJson.retentionDays` o 730) y fija
 * `meta.bodyPurgedAt`. Conserva nota, categorías (sin snippet), referencia y
 * contentHash; en review_category_mentions deja `snippet` a NULL (misma
 * retención que el cuerpo). Idempotente: una reseña ya purgada no se reescribe.
 */
export async function purgeExpiredBodies(input: PurgeExpiredBodiesInput): Promise<PurgeExpiredBodiesResult> {
  const db = input.db ?? prisma;
  const sources = await listSourceConfigs({ db, propertyId: input.propertyId, includeDisabled: true });
  const retentionBySourceId = new Map<string, number>();
  const retentionByProvider = new Map<string, number>();
  let minRetention = RETENTION_DAYS_DEFAULT;
  for (const entry of sources) {
    retentionBySourceId.set(entry.row.id, entry.config.retentionDays);
    const base = baseProvider(entry.row.provider) ?? entry.row.provider;
    retentionByProvider.set(base, Math.min(retentionByProvider.get(base) ?? Number.POSITIVE_INFINITY, entry.config.retentionDays));
    minRetention = Math.min(minRetention, entry.config.retentionDays);
  }
  minRetention = Math.min(minRetention, RETENTION_DAYS_GOOGLE);
  const cutoff = new Date(input.now.getTime() - minRetention * MS_PER_DAY);

  const rows = await db.guestReview.findMany({
    where: {
      propertyId: input.propertyId,
      OR: [{ receivedAt: { lt: cutoff } }, { receivedAt: null, createdAt: { lt: cutoff } }]
    },
    orderBy: { receivedAt: "asc" },
    take: 1_000
  });

  let purged = 0;
  for (const row of rows) {
    const meta = readReviewMeta(row.topicsJson);
    if (meta.bodyPurgedAt) continue;
    const base = baseProvider(row.source) ?? row.source;
    const retention = (meta.sourceId ? retentionBySourceId.get(meta.sourceId) : undefined) ?? retentionByProvider.get(base) ?? defaultRetentionDays(row.source);
    const receivedAt = row.receivedAt ?? row.createdAt;
    if (receivedAt.getTime() >= input.now.getTime() - retention * MS_PER_DAY) continue;
    const nextMeta: ReviewMetaInput = {
      ...meta,
      authorDisplayName: undefined,
      bodyPurgedAt: input.now,
      categories: meta.categories.map(({ snippet: _snippet, ...mention }) => mention),
      analysis: { ...meta.analysis, summary: undefined }
    };
    await db.guestReview.update({
      where: { id: row.id },
      // T8-L0b fase 1: bodyPurgedAt/authorDisplayName/summary también como columnas.
      data: { title: null, body: null, responseBody: null, topicsJson: asJson(writeReviewMeta(nextMeta)), bodyPurgedAt: input.now, authorDisplayName: null, summary: null }
    });
    // Los fragmentos literales materializados en review_category_mentions siguen la misma retención.
    await db.reviewCategoryMention?.updateMany({ where: { reviewId: row.id }, data: { snippet: null } });
    purged += 1;
  }
  return { scanned: rows.length, purged };
}
