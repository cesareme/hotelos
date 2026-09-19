// Reputación · Tanda T8 · lote T8-C — tick de sincronización de reseñas
// (apps/api/src/modules/reputation/reputation-sync.service.ts).
//
// Un tick recorre las propiedades con el módulo `reputation_quality` activo
// (Module + PropertyModule, schema.prisma:710-735; sin relación Prisma entre
// ambas: dos consultas) y, por cada fuente no desactivada:
//   1. colector por (provider, mode) → describeState SIN red: si no está
//      `connected` la fuente queda en `skipped` con su motivo honesto y NO se
//      llama a fetchImpl;
//   2. modo `email`: lee InboundEmail (schema.prisma:1298-1320) de la
//      propiedad con status ignored | review | review_notification desde
//      `since`, aplica classifyInboundEmail + parseReviewNotification y usa
//      `email:<messageId>` como referencia externa; NUNCA modifica InboundEmail;
//      resto de modos: collector.fetchSince con fetchImpl inyectado;
//   3. upsert idempotente por (propertyId, source, externalReference) +
//      contentHash (review-meta.store.ts); si el colector devolvió ítems pero
//      NO terminó (`status` degraded/error: cuota, 5xx a mitad de paginación,
//      tope de páginas) la ejecución queda `partial`: lo leído se guarda,
//      lastSuccessAt NO avanza (la siguiente vuelta repite la misma ventana),
//      lastError conserva el motivo y cuenta como error de fuente en el tick;
//   4. análisis acotado (maxAnalysisPerTick por PROPIEDAD y tick, no global:
//      con varios centros ninguno agota el cupo de los demás): reseñas con
//      meta.analysis.status `pending` → ai.analyzeReview con el texto
//      enmascarado (maskReviewForLlm) y `context.organizationId` (ai-core lo
//      exige; reputation-ai.core-adapter.ts); etiqueta honesta:
//      RulesReputationAi devuelve `dictionary`;
//   5. alertas: score10 < 6 sin caso → createCaseFromReview
//      (review-alerts.service.ts) + ReviewReceived;
//   6. saveSourceRun con contadores (ring buffer ≤ 20 en configJson.runs);
//   7. reconciliación de respondidas: filas con respondedAt (POST …/respond
//      del motor genérico, que no escribe topicsJson) cuya meta sigue abierta
//      pasan a `responded` y su ítem HITL review_response pendiente se cierra
//      (review-inbox.service.ts / review-draft.service.ts);
//   8. purgeExpiredBodies por propiedad; invalida la caché del índice.
// Concurrencia: el llamador puede inyectar `withPropertyLock` (job) para que
// cada propiedad corra bajo pg_try_advisory_xact_lock('reputation.sync:<id>');
// si otro proceso (sincronización manual, importación) lo tiene, la propiedad
// se salta con skipReason `lock`. Este servicio NUNCA abre transacciones: cada
// escritura se confirma por sí sola (reputation-lock.ts explica por qué).
// Un error en una fuente no tumba el tick: queda en `errors`, la fuente pasa
// a `error` con lastError, y se sigue con las demás. NUNCA autopublica
// respuestas.
//
// Reglas: `db` inyectable (el cliente normal; ya no un `tx`); sin variables de entorno
// (interruptores, intervalos e ids de cliente llegan por opciones); sin red
// sin fetchImpl; auditoría y evento inyectables (deps) para los tests.

import { prisma } from "@hotelos/database";
import { createId } from "../../lib/ids.js";
import { collectorFor as registryCollectorFor, type CollectorContext, type CollectorOptions, type CollectorSource, type FetchLike, type InboundEmailLike, type NormalizedReview, type ReviewCollector } from "./collectors/index.js";
import { maskReviewForLlm } from "./mask-pii.js";
import { getReputationAiPort, type ReputationAiPort } from "./reputation-ai.port.js";
import { REPUTATION_MODULE_CODE } from "./reputation-context.js";
import { invalidateReputationCache } from "./reputation-score.service.js";
import { baseProvider, type ReviewProvider, type ReviewSourceMode, type ReviewSourceRunDto, type ReviewSourceRunSummary, type ReviewSourceRunTrigger, type ReviewSourceStatus, type ReputationSyncSummary } from "./reputation-types.js";
import { createCaseFromReview, defaultOwnerFromConfiguration, shouldAlert, type ReviewAlertDeps } from "./review-alerts.service.js";
import { classifyInboundEmailDetailed, parseReviewNotification } from "./review-email.parser.js";
import { reconcileRespondedReviews } from "./review-inbox.service.js";
import type { WithLockResult } from "./reputation-lock.js";
import { getReviewMeta, listSourceConfigs, patchReviewMeta, purgeExpiredBodies, saveSourceRun, scoreOfRow, upsertReviewFromNormalized, type ReputationDb, type SourceConfigEntry } from "./review-meta.store.js";

const MS_PER_DAY = 86_400_000;
/** Primera sincronización de una fuente: 30 días hacia atrás. */
export const REPUTATION_SYNC_INITIAL_WINDOW_DAYS = 30;
/** Solape con la última ejecución correcta (reseñas editadas en el portal). */
export const REPUTATION_SYNC_OVERLAP_MS = 2 * MS_PER_DAY;
export const REPUTATION_SYNC_DEFAULT_MAX_ANALYSIS = 50;
/** Tope de correos leídos por fuente y tick. */
export const REPUTATION_SYNC_EMAIL_LIMIT = 500;
/** Tope de reseñas negativas revisadas por propiedad y tick para abrir casos. */
export const REPUTATION_SYNC_ALERT_SCAN_LIMIT = 500;
/** Estados de InboundEmail que el colector de correo puede leer (`review_notification` lo fijará el hook de T8-L5). */
export const REPUTATION_SYNC_EMAIL_STATUSES: readonly string[] = Object.freeze(["ignored", "review", "review_notification"]);

export type ReputationSyncLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const LOG = "[reputation.sync]";
export const silentReputationLog: ReputationSyncLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export type ReputationSyncDeps = ReviewAlertDeps & {
  invalidateCache?: (propertyId: string) => void;
};

export type RunReputationSyncOptions = {
  db?: ReputationDb;
  now?: Date;
  trigger?: ReviewSourceRunTrigger;
  /** Limita el tick a estas propiedades (ruta manual, tests). */
  propertyIds?: readonly string[];
  /** Limita el tick a estas fuentes. */
  sourceIds?: readonly string[];
  ai?: ReputationAiPort;
  fetchImpl?: FetchLike;
  log?: ReputationSyncLogger;
  /** Tope de reseñas analizadas por PROPIEDAD y tick (50 por defecto). */
  maxAnalysisPerTick?: number;
  /**
   * Lock por propiedad (job): ejecuta `run` bajo pg_try_advisory_xact_lock(reputation.sync:<propertyId>);
   * `{ locked: false }` → la propiedad se salta con skipReason `lock`. Sin él, sin lock.
   */
  withPropertyLock?: <T>(propertyId: string, run: () => Promise<T>) => Promise<WithLockResult<T>>;
  /** Ids de cliente OAuth (desde el contrato de entorno, en server.ts). */
  collectorOptions?: CollectorOptions;
  /** Registro de colectores (tests: colector ficticio). Por defecto collectors/index.ts. */
  collectorFor?: (provider: string, mode: ReviewSourceMode) => ReviewCollector | null;
  deps?: ReputationSyncDeps;
};

/**
 * Totales del tick (la forma por propiedad para el cable es
 * `ReputationSyncSummary` de reputation-types.ts, en `byProperty`).
 */
export type ReputationSyncTickSummary = {
  correlationId: string;
  trigger: ReviewSourceRunTrigger;
  startedAt: string;
  finishedAt: string;
  properties: number;
  sources: number;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  analyzed: number;
  alerts: number;
  /** Reseñas respondidas fuera de la bandeja cuya meta se ha puesto al día (y su ítem HITL cerrado). */
  reconciled: number;
  purged: number;
  skipped: Array<{ sourceId: string; propertyId: string; reason: string }>;
  errors: Array<{ sourceId: string; propertyId: string; message: string }>;
  byProperty: ReputationSyncSummary[];
};

type SourceOutcome = {
  run: ReviewSourceRunDto;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped?: string;
  error?: string;
};

type Collected = { item: NormalizedReview; externalReference?: string };

/** Desde cuándo pedir reseñas: última ejecución correcta − solape, o 30 días. */
export function sinceFor(config: { lastSuccessAt?: string }, now: Date): Date {
  const last = config.lastSuccessAt ? Date.parse(config.lastSuccessAt) : Number.NaN;
  if (Number.isFinite(last)) return new Date(Math.min(last - REPUTATION_SYNC_OVERLAP_MS, now.getTime()));
  return new Date(now.getTime() - REPUTATION_SYNC_INITIAL_WINDOW_DAYS * MS_PER_DAY);
}

/** Código que se guarda en GuestReview.source: portal real de la reseña (+ `_demo` en fuentes demo). */
export function sourceCodeFor(item: NormalizedReview, provider: ReviewProvider, isDemo: boolean): string {
  const portal = item.portalProvider ?? provider;
  return isDemo && portal !== "demo" ? `${portal}_demo` : portal;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Correos ya leídos → reseñas normalizadas del portal de la fuente (`email` = cualquiera); sin tocar InboundEmail. */
export function collectFromInboundEmails(emails: ReadonlyArray<InboundEmailLike>, provider: ReviewProvider, since: Date, now: Date): { items: Collected[]; skipped: number } {
  const items: Collected[] = [];
  let skipped = 0;
  for (const email of emails) {
    const classification = classifyInboundEmailDetailed(email);
    if (classification.kind !== "review_notification" || !classification.provider) {
      skipped += 1;
      continue;
    }
    if (provider !== "email" && classification.provider !== provider) {
      skipped += 1;
      continue;
    }
    const receivedAt = email.receivedAt instanceof Date ? email.receivedAt.getTime() : typeof email.receivedAt === "string" ? Date.parse(email.receivedAt) : Number.NaN;
    if (Number.isFinite(receivedAt) && receivedAt < since.getTime()) {
      skipped += 1;
      continue;
    }
    const item = parseReviewNotification(email, classification.provider, { now });
    if (!item) {
      skipped += 1;
      continue;
    }
    const messageId = email.messageId?.trim();
    items.push({ item, ...(messageId ? { externalReference: `email:${messageId}` } : {}) });
  }
  return { items, skipped };
}

async function syncSource(input: {
  db: ReputationDb;
  entry: SourceConfigEntry;
  propertyId: string;
  now: Date;
  trigger: ReviewSourceRunTrigger;
  correlationId: string;
  fetchImpl?: FetchLike;
  collectorOptions?: CollectorOptions;
  collectorFor: (provider: string, mode: ReviewSourceMode) => ReviewCollector | null;
  log: ReputationSyncLogger;
}): Promise<SourceOutcome> {
  const { db, entry, propertyId, now, trigger, correlationId, log } = input;
  const row = entry.row;
  const config = entry.config;
  const startedAt = new Date();
  const runId = createId("run");
  const baseRun = (): ReviewSourceRunSummary => ({
    id: runId,
    trigger,
    status: "completed",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    purged: 0,
    correlationId
  });
  const asDto = (run: ReviewSourceRunSummary): ReviewSourceRunDto => ({ ...run, sourceId: row.id, provider: row.provider });

  const skip = async (reason: string, status: ReviewSourceStatus): Promise<SourceOutcome> => {
    const run: ReviewSourceRunSummary = { ...baseRun(), status: "skipped", error: reason };
    await saveSourceRun({ db, sourceId: row.id, run, status });
    return { run: asDto(run), fetched: 0, created: 0, updated: 0, unchanged: 0, skipped: reason };
  };

  const base = baseProvider(row.provider);
  if (!base) return skip(`Proveedor desconocido: ${row.provider}.`, "unavailable");
  const collector = input.collectorFor(base, config.mode);
  if (!collector) return skip(`No existe colector para ${base} en modo ${config.mode}.`, "unavailable");

  const source: CollectorSource = {
    propertyId,
    sourceId: row.id,
    provider: base,
    config,
    credentials: null,
    ...(input.collectorOptions ? { options: input.collectorOptions } : {})
  };
  const state = collector.describeState(source);
  if (state.status !== "connected") return skip(state.reason ?? `Fuente en estado ${state.status}.`, state.status);

  const since = sinceFor(config, now);
  const isDemo = config.isDemo === true;
  let collected: Collected[] = [];
  let resultStatus: ReviewSourceStatus = "connected";
  let resultError: string | undefined;
  let cursor: Record<string, unknown> | undefined;
  try {
    if (config.mode === "email") {
      const emails = await db.inboundEmail.findMany({
        where: { propertyId, status: { in: [...REPUTATION_SYNC_EMAIL_STATUSES] }, createdAt: { gte: since } },
        select: { messageId: true, fromAddress: true, subject: true, snippet: true, receivedAt: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: REPUTATION_SYNC_EMAIL_LIMIT
      });
      const emailInputs: InboundEmailLike[] = emails.map((email) => ({
        messageId: email.messageId,
        fromAddress: email.fromAddress,
        subject: email.subject,
        snippet: email.snippet,
        receivedAt: email.receivedAt ?? email.createdAt
      }));
      const fromEmails = collectFromInboundEmails(emailInputs, base, since, now);
      collected = fromEmails.items;
      cursor = { lastCheckedAt: now.toISOString(), processed: emails.length, skipped: fromEmails.skipped };
    } else {
      const ctx: CollectorContext = {
        now,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        log: (level, message, meta) => log[level === "error" ? "error" : level === "warn" ? "warn" : "info"](meta ?? {}, `${LOG} ${message}`)
      };
      const result = await collector.fetchSince({ source, since, ctx });
      collected = result.items.map((item) => ({ item }));
      resultStatus = result.status;
      resultError = result.error;
      cursor = result.cursor;
    }
  } catch (error) {
    const message = errorMessage(error);
    const run: ReviewSourceRunSummary = { ...baseRun(), status: "failed", error: message };
    await saveSourceRun({ db, sourceId: row.id, run, status: "error" });
    log.error({ sourceId: row.id, propertyId, correlationId, err: message }, `${LOG} fuente con error`);
    return { run: asDto(run), fetched: 0, created: 0, updated: 0, unchanged: 0, error: message };
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let invalid = 0;
  for (const { item, externalReference } of collected) {
    try {
      const outcome = await upsertReviewFromNormalized({
        db,
        propertyId,
        source: sourceCodeFor(item, base, isDemo),
        sourceId: row.id,
        sourceMode: config.mode,
        item,
        now,
        ...(externalReference ? { externalReference } : {}),
        ...(isDemo ? { isDemo: true } : {})
      });
      if (outcome.outcome === "created") created += 1;
      else if (outcome.outcome === "updated") updated += 1;
      else unchanged += 1;
    } catch (error) {
      // QC-06: una fila mala no tumba la fuente; queda contada y en el log con correlación.
      invalid += 1;
      log.warn({ sourceId: row.id, propertyId, correlationId, err: errorMessage(error) }, `${LOG} reseña descartada`);
    }
  }
  // Lectura incompleta (el colector devolvió lo leído + estado degraded/error): `partial`,
  // lastSuccessAt no avanza y el motivo queda en lastError y en los errores del tick.
  const partial = resultStatus !== "connected";
  const partialError = partial ? (resultError ?? `Lectura parcial: la fuente quedó en estado ${resultStatus}.`) : undefined;
  const run: ReviewSourceRunSummary = {
    ...baseRun(),
    status: partial ? "partial" : "completed",
    fetched: collected.length,
    created,
    updated,
    unchanged,
    ...(partialError ? { error: partialError } : invalid > 0 ? { error: `${invalid} reseñas descartadas por datos inválidos.` } : {})
  };
  await saveSourceRun({ db, sourceId: row.id, run, status: resultStatus, ...(cursor ? { cursor } : {}) });
  if (partialError) log.warn({ sourceId: row.id, propertyId, correlationId, status: resultStatus, err: partialError }, `${LOG} fuente con lectura parcial`);
  return { run: asDto(run), fetched: collected.length, created, updated, unchanged, ...(partialError ? { error: partialError } : {}) };
}

/** Análisis acotado de las reseñas pendientes de una propiedad; devuelve cuántas se analizaron. Con `organizationId` el puerto recibe el contexto que ai-core exige. */
export async function analyzePendingReviews(input: { db: ReputationDb; propertyId: string; ai: ReputationAiPort; budget: number; now: Date; log: ReputationSyncLogger; correlationId: string; organizationId?: string }): Promise<number> {
  if (input.budget <= 0) return 0;
  const rows = await input.db.guestReview.findMany({
    where: { propertyId: input.propertyId, topicsJson: { path: ["analysis", "status"], equals: "pending" } },
    orderBy: { receivedAt: "desc" },
    take: input.budget
  });
  let analyzed = 0;
  for (const row of rows) {
    const meta = getReviewMeta(row);
    if (meta.analysis.status !== "pending") continue;
    try {
      const extraNames = meta.authorDisplayName ? [meta.authorDisplayName] : [];
      const output = await input.ai.analyzeReview({
        text: maskReviewForLlm(row.body ?? "", { extraNames }).masked,
        ...(row.title ? { title: maskReviewForLlm(row.title, { extraNames }).masked } : {}),
        ...(row.language ? { language: row.language } : {}),
        score10: scoreOfRow(row, meta),
        ...(input.organizationId ? { context: { organizationId: input.organizationId, propertyId: input.propertyId, correlationId: input.correlationId } } : {})
      });
      const patched = await patchReviewMeta({
        db: input.db,
        id: row.id,
        patch: {
          categories: output.categories,
          analysis: { status: "done", source: output.source, analyzedAt: input.now, ...(output.note ? { note: output.note } : {}), ...(output.summary ? { summary: output.summary } : {}) }
        },
        columns: { language: output.language, sentiment: output.sentiment }
      });
      // T8-L0b fase 1: menciones materializadas en review_category_mentions a partir de la meta
      // ya normalizada (la lectura sigue por topicsJson.categories); los stubs no tienen el delegado.
      await input.db.reviewCategoryMention?.deleteMany({ where: { reviewId: row.id } });
      if (patched.meta.categories.length > 0) {
        await input.db.reviewCategoryMention?.createMany({
          data: patched.meta.categories.map((mention) => ({
            reviewId: row.id,
            propertyId: input.propertyId,
            category: mention.category,
            sentiment: mention.sentiment,
            confidence: mention.confidence,
            snippet: mention.snippet ?? null,
            analysisSource: mention.source
          })),
          skipDuplicates: true
        });
      }
      analyzed += 1;
    } catch (error) {
      const message = errorMessage(error);
      input.log.warn({ reviewId: row.id, propertyId: input.propertyId, correlationId: input.correlationId, err: message }, `${LOG} análisis fallido`);
      await patchReviewMeta({ db: input.db, id: row.id, patch: { analysis: { status: "failed", source: meta.analysis.source, analyzedAt: input.now, note: message.slice(0, 200) } } }).catch(() => undefined);
    }
  }
  return analyzed;
}

/** Abre casos para las reseñas negativas sin caso de una propiedad; devuelve cuántos creó. */
export async function raiseReviewAlerts(input: {
  db: ReputationDb;
  organizationId: string;
  propertyId: string;
  now: Date;
  correlationId: string;
  defaultOwnerUserId: string | null;
  deps?: ReviewAlertDeps;
  log: ReputationSyncLogger;
}): Promise<number> {
  const rows = await input.db.guestReview.findMany({
    where: { propertyId: input.propertyId, sentiment: "negative" },
    orderBy: { receivedAt: "desc" },
    take: REPUTATION_SYNC_ALERT_SCAN_LIMIT
  });
  let alerts = 0;
  for (const row of rows) {
    if (!shouldAlert(row)) continue;
    try {
      const result = await createCaseFromReview({
        db: input.db,
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        review: row,
        now: input.now,
        correlationId: input.correlationId,
        defaultOwnerUserId: input.defaultOwnerUserId,
        actor: { type: "system" },
        ...(input.deps ? { deps: input.deps } : {})
      });
      if (result.created) alerts += 1;
    } catch (error) {
      input.log.error({ reviewId: row.id, propertyId: input.propertyId, correlationId: input.correlationId, err: errorMessage(error) }, `${LOG} alerta fallida`);
    }
  }
  return alerts;
}

/** Un tick completo (ver cabecera). Nunca lanza por una fuente o propiedad concreta. */
export async function runReputationSync(options: RunReputationSyncOptions = {}): Promise<ReputationSyncTickSummary> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? "scheduler";
  const ai = options.ai ?? getReputationAiPort();
  const log = options.log ?? silentReputationLog;
  const collectorLookup = options.collectorFor ?? registryCollectorFor;
  const invalidate = options.deps?.invalidateCache ?? invalidateReputationCache;
  const alertDeps: ReviewAlertDeps | undefined = options.deps ? { ...(options.deps.audit ? { audit: options.deps.audit } : {}), ...(options.deps.domainEvent ? { domainEvent: options.deps.domainEvent } : {}) } : undefined;
  const correlationId = createId("corr");
  const startedAt = new Date();
  const summary: ReputationSyncTickSummary = {
    correlationId,
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    properties: 0,
    sources: 0,
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    analyzed: 0,
    alerts: 0,
    reconciled: 0,
    purged: 0,
    skipped: [],
    errors: [],
    byProperty: []
  };

  const module = await db.module.findFirst({ where: { code: REPUTATION_MODULE_CODE }, select: { id: true } });
  if (!module) {
    log.warn({ correlationId }, `${LOG} módulo ${REPUTATION_MODULE_CODE} sin fila en modules: tick vacío`);
    summary.finishedAt = new Date().toISOString();
    return summary;
  }
  const propertyModules = await db.propertyModule.findMany({
    where: {
      moduleId: module.id,
      status: "enabled",
      ...(options.propertyIds && options.propertyIds.length > 0 ? { propertyId: { in: [...options.propertyIds] } } : {})
    },
    select: { propertyId: true, configurationJson: true }
  });
  const propertyIds = [...new Set(propertyModules.map((row) => row.propertyId))].sort();
  const properties = propertyIds.length > 0 ? await db.property.findMany({ where: { id: { in: propertyIds } }, select: { id: true, organizationId: true, name: true } }) : [];
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const ownerByProperty = new Map(propertyModules.map((row) => [row.propertyId, defaultOwnerFromConfiguration(row.configurationJson)]));

  // Cupo por propiedad y tick (no global): con varios centros ninguno agota el de los demás.
  const analysisBudget = options.maxAnalysisPerTick ?? REPUTATION_SYNC_DEFAULT_MAX_ANALYSIS;

  for (const propertyId of propertyIds) {
    const property = propertyById.get(propertyId);
    if (!property) continue;
    summary.properties += 1;
    const propertyStartedAt = new Date();
    const perProperty: ReputationSyncSummary = {
      propertyId,
      correlationId,
      startedAt: propertyStartedAt.toISOString(),
      finishedAt: propertyStartedAt.toISOString(),
      skipped: false,
      sources: 0,
      runs: [],
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      purged: 0,
      analyzed: 0,
      failed: 0,
      casesOpened: 0,
      indexRecomputed: false
    };
    const runProperty = async (): Promise<void> => {
      const entries = await listSourceConfigs({ db, propertyId, ...(options.sourceIds ? { sourceIds: options.sourceIds } : {}) });
      perProperty.sources = entries.length;
      summary.sources += entries.length;
      if (entries.length === 0) {
        perProperty.skipped = true;
        perProperty.skipReason = "no_sources";
      }
      for (const entry of entries) {
        const outcome = await syncSource({
          db,
          entry,
          propertyId,
          now,
          trigger,
          correlationId,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.collectorOptions ? { collectorOptions: options.collectorOptions } : {}),
          collectorFor: collectorLookup,
          log
        });
        perProperty.runs.push(outcome.run);
        perProperty.fetched += outcome.fetched;
        perProperty.created += outcome.created;
        perProperty.updated += outcome.updated;
        perProperty.unchanged += outcome.unchanged;
        summary.fetched += outcome.fetched;
        summary.created += outcome.created;
        summary.updated += outcome.updated;
        summary.unchanged += outcome.unchanged;
        if (outcome.skipped) summary.skipped.push({ sourceId: entry.row.id, propertyId, reason: outcome.skipped });
        if (outcome.error) {
          perProperty.failed += 1;
          summary.errors.push({ sourceId: entry.row.id, propertyId, message: outcome.error });
        }
      }

      const analyzed = await analyzePendingReviews({ db, propertyId, ai, budget: analysisBudget, now, log, correlationId, organizationId: property.organizationId });
      perProperty.analyzed = analyzed;
      summary.analyzed += analyzed;

      const alerts = await raiseReviewAlerts({
        db,
        organizationId: property.organizationId,
        propertyId,
        now,
        correlationId,
        defaultOwnerUserId: ownerByProperty.get(propertyId) ?? null,
        ...(alertDeps ? { deps: alertDeps } : {}),
        log
      });
      perProperty.casesOpened = alerts;
      summary.alerts += alerts;

      const reconciled = await reconcileRespondedReviews({ db, organizationId: property.organizationId, propertyId, now, correlationId, log });
      summary.reconciled += reconciled;

      const purge = await purgeExpiredBodies({ db, propertyId, now });
      perProperty.purged = purge.purged;
      summary.purged += purge.purged;

      invalidate(propertyId);
      perProperty.indexRecomputed = true;
    };
    try {
      if (options.withPropertyLock) {
        const locked = await options.withPropertyLock(propertyId, runProperty);
        if (!locked.locked) {
          perProperty.skipped = true;
          perProperty.skipReason = "lock";
          summary.skipped.push({ sourceId: "", propertyId, reason: "lock" });
          log.info({ propertyId, correlationId }, `${LOG} propiedad saltada: otra sincronización o importación tiene el lock`);
        }
      } else {
        await runProperty();
      }
    } catch (error) {
      const message = errorMessage(error);
      perProperty.failed += 1;
      summary.errors.push({ sourceId: "", propertyId, message });
      log.error({ propertyId, correlationId, err: message }, `${LOG} propiedad con error`);
    }
    perProperty.finishedAt = new Date().toISOString();
    summary.byProperty.push(perProperty);
  }

  summary.finishedAt = new Date().toISOString();
  log.info(
    { correlationId, properties: summary.properties, sources: summary.sources, created: summary.created, updated: summary.updated, unchanged: summary.unchanged, analyzed: summary.analyzed, alerts: summary.alerts, reconciled: summary.reconciled, purged: summary.purged, skipped: summary.skipped.length, errors: summary.errors.length },
    `${LOG} tick`
  );
  return summary;
}
