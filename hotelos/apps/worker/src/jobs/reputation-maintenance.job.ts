// Mantenimiento diario de reputación (Tanda T8 · lote T8-F; cola pg-boss
// `reputation.maintenance`, un WorkerJobRun por tick vía withJobRun).
//
// Qué hace, por cada propiedad con filas en `review_sources`:
//   1. Purga honesta del texto: reseñas con receivedAt anterior a la retención
//      de su fuente (Google: 30 días como máximo, caché de contenido de Google
//      Business Profile; resto: configJson.retentionDays o 730) y sin
//      topicsJson.bodyPurgedAt → title/body/responseBody a null,
//      topicsJson.bodyPurgedAt = ahora y, por columnas (T8-L0b fase 1),
//      body_purged_at = ahora, author_display_name/summary a NULL y
//      review_category_mentions.snippet a NULL. Se conservan rating, score10,
//      categories, contentHash y el resto de la meta; se retiran los
//      fragmentos literales de la reseña (categories[].snippet y
//      analysis.summary) y el nombre del autor (topicsJson.authorDisplayName),
//      porque una purga que dejara texto o el nombre del reseñador no sería
//      purga (paridad con purgeExpiredBodies del API, review-meta.store.ts;
//      corrección ronda 1, HP-02). authorCountry se conserva en ambos:
//      código de país, no identifica a nadie y alimenta el desglose por
//      nacionalidad.
//   2. Plazo de respuesta: reseñas abiertas (topicsJson.status new|assigned|
//      drafted) con topicsJson.slaTargetAt ya vencido → topicsJson.overdue =
//      true (idempotente: una reseña ya marcada no se vuelve a escribir).
//   3. Historial de ejecuciones por fuente: configJson.runs se recorta a las
//      20 más recientes.
//
// Reglas:
//   · el worker solo importa @hotelos/database (package.json): la forma de
//     GuestReview.topicsJson (ReviewMeta v1) y de ReviewSource.configJson
//     (ReviewSourceConfig v1) se lee con los lectores mínimos de más abajo,
//     espejo tolerante de readReviewMeta / readSourceConfig en
//     modules/reputation/reputation-types.ts del API; si cambian allí,
//     cambian aquí (vocabularios y umbrales copiados en [espejo]);
//   · cada escritura es un `update` con `where: { id }` (nunca deleteMany ni
//     updateMany): el job deja rastro fila a fila y jamás borra reseñas;
//   · sin variables de entorno: la cron y el cliente de base de datos se
//     inyectan (por defecto REPUTATION_MAINTENANCE_CRON y el singleton prisma);
//   · la fuente de una reseña se resuelve por topicsJson.sourceId y, si no,
//     por proveedor (GuestReview.source, sufijo `_demo` ignorado); una reseña
//     sin fuente registrada usa la retención por defecto de su proveedor;
//   · NO está cableado en scheduler.ts ni en JOB_QUEUES: lo añade el
//     orquestador al fusionar (unión JobQueueName, JOB_QUEUES, llamada a
//     registerReputationMaintenanceQueue tras las cuatro colas, catálogo y
//     contratos, docs/deployment.md, cabecera de index.ts).
//
// Test: apps/worker/src/jobs/__tests__/reputation-maintenance.job.test.ts

import type PgBoss from "pg-boss";
import { prisma, type Prisma } from "@hotelos/database";
import { toJsonValue, withJobRun } from "./job-runs.js";

export const REPUTATION_MAINTENANCE_QUEUE = "reputation.maintenance";
/** Diario a las 04:15 (Europe/Madrid): tras la ingesta nocturna y antes del primer turno. */
export const REPUTATION_MAINTENANCE_CRON = "15 4 * * *";

// ---------------------------------------------------------------------------
// [espejo] Vocabularios y umbrales copiados de reputation-types.ts (API)
// ---------------------------------------------------------------------------

/** Retención por defecto del texto de la reseña, en días. */
export const RETENTION_DAYS_DEFAULT = 730;
/** Google Business Profile: caché de contenido como máximo 30 días. */
export const RETENTION_DAYS_GOOGLE = 30;
/** Ejecuciones conservadas por fuente en `configJson.runs`. */
export const RUN_HISTORY_LIMIT = 20;
export const REVIEW_STATUSES = Object.freeze(["new", "assigned", "drafted", "responded", "closed", "ignored"] as const);
/** Estados de la bandeja que todavía cuentan para el plazo de respuesta. */
export const REVIEW_OPEN_STATUSES = Object.freeze(["new", "assigned", "drafted"] as const);

const DAY_MS = 24 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Cliente mínimo: lo único que el job lee y escribe (el singleton prisma lo cumple)
// ---------------------------------------------------------------------------

export type SourceRow = { id: string; propertyId: string; provider: string; configJson: unknown };
export type ReviewRow = { id: string; source: string; receivedAt: Date | null; topicsJson: unknown };

export type ReviewUpdateData = {
  topicsJson: Prisma.InputJsonValue;
  title?: null;
  body?: null;
  responseBody?: null;
  // Purga también por columnas (T8-L0b fase 1: mismo conjunto que purgeExpiredBodies
  // del API, review-meta.store.ts). Sin bodyPurgedAt en columna la purga del API
  // saltaría la fila por el JSON y las columnas quedarían con PII para siempre.
  bodyPurgedAt?: Date;
  authorDisplayName?: null;
  summary?: null;
};

const SOURCE_SELECT = { id: true, propertyId: true, provider: true, configJson: true } as const;
const REVIEW_SELECT = { id: true, source: true, receivedAt: true, topicsJson: true } as const;

export type ReputationMaintenanceDb = {
  reviewSource: {
    findMany(args: { select: typeof SOURCE_SELECT; orderBy: { createdAt: "asc" } }): Promise<SourceRow[]>;
    update(args: { where: { id: string }; data: { configJson: Prisma.InputJsonValue } }): Promise<unknown>;
  };
  guestReview: {
    findMany(args: {
      where: { propertyId: string; receivedAt?: { lt: Date }; respondedAt?: null };
      select: typeof REVIEW_SELECT;
      orderBy: { createdAt: "asc" };
    }): Promise<ReviewRow[]>;
    update(args: { where: { id: string }; data: ReviewUpdateData }): Promise<unknown>;
  };
  /** Fragmentos literales materializados (review_category_mentions); opcional: los stubs no lo tienen. */
  reviewCategoryMention?: {
    updateMany(args: { where: { reviewId: string }; data: { snippet: null } }): Promise<unknown>;
  };
};

export type ReputationMaintenanceResult = {
  /** Propiedades con al menos una fuente registrada. */
  properties: number;
  /** Reseñas cuyo texto se ha retirado en este tick. */
  purged: number;
  /** Reseñas marcadas fuera de plazo en este tick (las ya marcadas no cuentan). */
  overdue: number;
  /** Fuentes cuyo historial de ejecuciones se ha recortado. */
  trimmed: number;
};

export type RunReputationMaintenanceInput = {
  db?: ReputationMaintenanceDb;
  now?: Date;
};

// --- lectura tolerante (espejo de reputation-types.ts) -----------------------

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Marca de tiempo en ms de una fecha ISO o Date; null si no es válida. */
function asTimestamp(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function omitKey(record: JsonRecord, key: string): JsonRecord {
  const out: JsonRecord = {};
  for (const [entryKey, entry] of Object.entries(record)) {
    if (entryKey !== key) out[entryKey] = entry;
  }
  return out;
}

/** Proveedor base de un código de fuente o reseña (`google_demo` → `google`). */
export function baseProvider(provider: string): string {
  return provider.trim().toLowerCase().replace(/_demo$/, "");
}

/**
 * Retención del texto para una fuente: Google nunca supera 30 días; el resto
 * usa configJson.retentionDays (≥ 1) o 730. Espejo de readSourceConfig.
 */
export function sourceRetentionDays(provider: string, configJson: unknown): number {
  const google = baseProvider(provider) === "google";
  const fallback = google ? RETENTION_DAYS_GOOGLE : RETENTION_DAYS_DEFAULT;
  const raw = asNumber(asRecord(configJson)?.retentionDays);
  const days = raw === null || raw < 1 ? fallback : Math.floor(raw);
  return google ? Math.min(days, RETENTION_DAYS_GOOGLE) : days;
}

type RetentionIndex = {
  bySourceId: Map<string, number>;
  byProvider: Map<string, number>;
  /** Retención mínima aplicable en la propiedad: acota la consulta de candidatas. */
  min: number;
};

function buildRetentionIndex(sources: readonly SourceRow[]): RetentionIndex {
  const bySourceId = new Map<string, number>();
  const byProvider = new Map<string, number>();
  // Una reseña de Google sin fuente registrada también caduca a los 30 días.
  let min = RETENTION_DAYS_GOOGLE;
  for (const source of sources) {
    const days = sourceRetentionDays(source.provider, source.configJson);
    bySourceId.set(source.id, days);
    const provider = baseProvider(source.provider);
    const current = byProvider.get(provider);
    // Dos fuentes del mismo proveedor con retenciones distintas: gana la más corta.
    byProvider.set(provider, current === undefined ? days : Math.min(current, days));
    min = Math.min(min, days);
  }
  return { bySourceId, byProvider, min };
}

function retentionDaysFor(row: ReviewRow, meta: JsonRecord, index: RetentionIndex): number {
  const sourceId = asText(meta.sourceId);
  if (sourceId !== undefined) {
    const bySource = index.bySourceId.get(sourceId);
    if (bySource !== undefined) return bySource;
  }
  const provider = baseProvider(row.source);
  return index.byProvider.get(provider) ?? (provider === "google" ? RETENTION_DAYS_GOOGLE : RETENTION_DAYS_DEFAULT);
}

/** Meta tras la purga: bodyPurgedAt, sin fragmentos literales (snippet, summary) y sin el nombre del autor. */
function purgeMeta(meta: JsonRecord, now: Date): JsonRecord {
  const next: JsonRecord = { ...omitKey(meta, "authorDisplayName"), bodyPurgedAt: now.toISOString() };
  if (Array.isArray(meta.categories)) {
    next.categories = meta.categories.map((entry) => {
      const mention = asRecord(entry);
      return mention ? omitKey(mention, "snippet") : entry;
    });
  }
  const analysis = asRecord(meta.analysis);
  if (analysis && "summary" in analysis) next.analysis = omitKey(analysis, "summary");
  return next;
}

export type ReviewChange = { data: ReviewUpdateData; purged: boolean; overdue: boolean };

/**
 * Decide qué escribir en una reseña (o nada): purga si su texto ha superado la
 * retención de su fuente y aún no está purgado; fuera de plazo si sigue
 * abierta, tiene slaTargetAt vencido y no estaba marcada. Ambos cambios van en
 * un único update. Función pura.
 */
export function planReviewChange(row: ReviewRow, retention: RetentionIndex, now: Date): ReviewChange | null {
  const meta = asRecord(row.topicsJson) ?? {};
  let next: JsonRecord | null = null;
  let purged = false;
  let overdue = false;

  if (row.receivedAt !== null && asTimestamp(meta.bodyPurgedAt) === null) {
    const days = retentionDaysFor(row, meta, retention);
    if (row.receivedAt.getTime() < now.getTime() - days * DAY_MS) {
      next = purgeMeta(meta, now);
      purged = true;
    }
  }

  const statusRaw = meta.status;
  const status = typeof statusRaw === "string" && (REVIEW_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : "new";
  if ((REVIEW_OPEN_STATUSES as readonly string[]).includes(status) && meta.overdue !== true) {
    const target = asTimestamp(meta.slaTargetAt);
    if (target !== null && target < now.getTime()) {
      next = { ...(next ?? meta), overdue: true };
      overdue = true;
    }
  }

  if (next === null) return null;
  const data: ReviewUpdateData = { topicsJson: toJsonValue(next) };
  if (purged) {
    data.title = null;
    data.body = null;
    data.responseBody = null;
    data.bodyPurgedAt = now;
    data.authorDisplayName = null;
    data.summary = null;
  }
  return { data, purged, overdue };
}

/**
 * configJson con `runs` recortado a las RUN_HISTORY_LIMIT más recientes
 * (por startedAt descendente, como readSourceConfig); null si no hay nada que
 * recortar. Conserva el resto de claves tal cual. Función pura.
 */
export function trimRunHistory(configJson: unknown): Prisma.InputJsonValue | null {
  const config = asRecord(configJson);
  if (!config || !Array.isArray(config.runs) || config.runs.length <= RUN_HISTORY_LIMIT) return null;
  const startedAt = (run: unknown): number => asTimestamp(asRecord(run)?.startedAt) ?? 0;
  const runs = [...config.runs].sort((a, b) => startedAt(b) - startedAt(a)).slice(0, RUN_HISTORY_LIMIT);
  return toJsonValue({ ...config, runs });
}

async function maintainProperty(
  db: ReputationMaintenanceDb,
  propertyId: string,
  sources: readonly SourceRow[],
  now: Date
): Promise<Omit<ReputationMaintenanceResult, "properties">> {
  const retention = buildRetentionIndex(sources);
  const purgeCutoff = new Date(now.getTime() - retention.min * DAY_MS);
  const [purgeCandidates, openCandidates] = await Promise.all([
    db.guestReview.findMany({ where: { propertyId, receivedAt: { lt: purgeCutoff } }, select: REVIEW_SELECT, orderBy: { createdAt: "asc" } }),
    db.guestReview.findMany({ where: { propertyId, respondedAt: null }, select: REVIEW_SELECT, orderBy: { createdAt: "asc" } })
  ]);

  // Una reseña puede ser candidata a las dos cosas: se decide y escribe una sola vez.
  const rows = new Map<string, ReviewRow>();
  for (const row of purgeCandidates) rows.set(row.id, row);
  for (const row of openCandidates) rows.set(row.id, row);

  let purged = 0;
  let overdue = 0;
  for (const row of rows.values()) {
    const change = planReviewChange(row, retention, now);
    if (change === null) continue;
    await db.guestReview.update({ where: { id: row.id }, data: change.data });
    if (change.purged) {
      // Los fragmentos literales de review_category_mentions siguen la retención del cuerpo.
      await db.reviewCategoryMention?.updateMany({ where: { reviewId: row.id }, data: { snippet: null } });
      purged += 1;
    }
    if (change.overdue) overdue += 1;
  }

  let trimmed = 0;
  for (const source of sources) {
    const configJson = trimRunHistory(source.configJson);
    if (configJson === null) continue;
    await db.reviewSource.update({ where: { id: source.id }, data: { configJson } });
    trimmed += 1;
  }

  return { purged, overdue, trimmed };
}

/**
 * Un barrido completo: todas las propiedades con fuentes registradas, en
 * orden de alta de la fuente. Devuelve cifras para resultJson del run.
 */
export async function runReputationMaintenance(input: RunReputationMaintenanceInput = {}): Promise<ReputationMaintenanceResult> {
  const db = input.db ?? prisma;
  const now = input.now ?? new Date();

  const sources = await db.reviewSource.findMany({ select: SOURCE_SELECT, orderBy: { createdAt: "asc" } });
  const byProperty = new Map<string, SourceRow[]>();
  for (const source of sources) {
    const list = byProperty.get(source.propertyId);
    if (list) list.push(source);
    else byProperty.set(source.propertyId, [source]);
  }

  const result: ReputationMaintenanceResult = { properties: byProperty.size, purged: 0, overdue: 0, trimmed: 0 };
  for (const [propertyId, propertySources] of byProperty) {
    const outcome = await maintainProperty(db, propertyId, propertySources, now);
    result.purged += outcome.purged;
    result.overdue += outcome.overdue;
    result.trimmed += outcome.trimmed;
  }
  return result;
}

export type RegisterReputationMaintenanceOptions = {
  /** Cron de pg-boss (Europe/Madrid); por defecto REPUTATION_MAINTENANCE_CRON. */
  cron?: string;
  /** Cliente de base de datos del barrido; por defecto el singleton prisma. */
  db?: ReputationMaintenanceDb;
};

/**
 * Registra la cola en pg-boss con la misma forma que scheduler.ts: createQueue
 * (idempotente: ON CONFLICT DO NOTHING), boss.work con batchSize 1 (un tick =
 * un job = un WorkerJobRun vía withJobRun; el error se registra y se relanza
 * para que pg-boss marque el job) y boss.schedule (upsert por nombre). El
 * barrido es global (todas las organizaciones): el run se escribe con
 * organizationId = null y propertyId = null.
 */
export async function registerReputationMaintenanceQueue(boss: PgBoss, options: RegisterReputationMaintenanceOptions = {}): Promise<void> {
  const queue = REPUTATION_MAINTENANCE_QUEUE;
  await boss.createQueue(queue);
  await boss.work(queue, { batchSize: 1 }, async (jobs: PgBoss.Job<object>[]) => {
    for (const job of jobs) {
      try {
        const summary = await withJobRun({ jobName: queue, queueName: queue, payload: job.data ?? {}, correlationId: job.id }, () =>
          runReputationMaintenance({ db: options.db })
        );
        console.log(
          `[${queue}] properties=${summary.properties} purged=${summary.purged} overdue=${summary.overdue} trimmed=${summary.trimmed}`
        );
      } catch (error) {
        console.error(`[${queue}]`, error);
        throw error;
      }
    }
  });
  await boss.schedule(queue, options.cron ?? REPUTATION_MAINTENANCE_CRON, {}, { tz: "Europe/Madrid" });
}
