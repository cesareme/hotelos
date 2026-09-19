// Reputación · Tanda T8 · lote T8-D — superficie HTTP del módulo de reseñas
// (apps/api/src/modules/reputation/reputation.routes.ts).
//
// Registro: `registerReputationRoutes(app, options?)` desde server.ts tras
// registerLedgerImportRoutes(app) (mergeLine del integrador; hasta la fusión el
// test de integración l8-reputation-routes.test.mts lo llama sobre
// buildApiServer()). Permisos: route-permissions.partial.ts de este módulo (12
// entradas, una por ruta; el spread en security/route-permissions.ts es otra
// mergeLine). Ninguna de las 8 rutas vivas del motor genérico (reviews,
// respond, casos, encuestas: server.ts:3246-3277) se repite aquí; la
// publicación de la respuesta sigue siendo POST /reputation/reviews/:id/respond.
//
// Reglas comunes:
//   · gate de módulo en el handler (mismo texto que advanced-modules.service.ts
//     :426-431): 403 «El módulo reputation_quality no está activado en esta
//     propiedad.»; el preHandler global de server.ts ya ha resuelto `:propertyId`
//     con 404 opaco y las rutas de `:id` de reseña pasan por
//     assertPropertyEntityAccess(guestReview) (lib/tenancy.ts:1018) → actúan en
//     la propiedad de la fila;
//   · las rutas de `:id` de fuente filtran {id, propertyId} en el servicio →
//     404 opaco «Fuente de reseñas no encontrada.»;
//   · todo cuerpo y consulta pasa por un esquema zod `.strict()` de
//     schemas/reputation.schemas.ts con parseOr400 → 400 VALIDATION_ERROR;
//   · correlationId createId("corr") en cada escritura; auditoría en los
//     servicios (ReviewUpdated, ReviewResponseDrafted, ReviewSource*,
//     ReviewReceived) y aquí (QualityCaseCreated, ReviewsImported,
//     ReviewSourceSynced);
//   · orden de registro: literales antes que `:id`;
//   · concurrencia (corrección ronda 1, BD-04): la sincronización manual y la
//     importación corren bajo pg_try_advisory_xact_lock('reputation.sync:<propertyId>')
//     (reputation-lock.ts), el mismo lock por propiedad que toma el tick diario;
//     ocupado → 409 REPUTATION_SYNC_BUSY (dos importaciones simultáneas del
//     mismo fichero o una manual durante la vuelta diaria ya no duplican filas:
//     el upsert es findFirst+create sin @@unique hasta T8-L0);
//   · GET …/inbox sigue la regla de compatibilidad de lib/pagination.ts: array
//     plano salvo `?envelope=1` o `?cursor=` (siempre con X-Total-Count /
//     X-Next-Cursor); el cliente del front pide `envelope=1`;
//   · sin lib/llm ni ai-tools: la IA entra por ReputationAiPort (por defecto el
//     respaldo por reglas); ninguna lectura de entorno: los ids OAuth de Google
//     llegan en `options.collectorOptions` desde server.ts.
//
// Decisión documentada: no existe la clave reputation.manage, así que la
// escritura de fuentes (alta, cambio, baja, sincronización, importación) usa
// reputation.respond (alternativa integrations.connect: §6 de las mergeLines).

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "@hotelos/database";
import { createId } from "../../lib/ids.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/http-error.js";
import { pageBody, pageHeaders, parsePageQuery } from "../../lib/pagination.js";
import { assertPropertyEntityAccess } from "../../lib/tenancy.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  DraftSchema,
  ImportSchema,
  InboxQuerySchema,
  QualityCaseFromReviewSchema,
  ReviewPatchSchema,
  RunsQuerySchema,
  SourceCreateSchema,
  SourceUpdateSchema,
  SourcesQuerySchema,
  type DraftTone,
  type ImportRowInput
} from "../../schemas/reputation.schemas.js";
import type { CollectorOptions } from "./collectors/types.js";
import { REPUTATION_MODULE_CODE } from "./reputation-context.js";
import { getReputationAiPort, type ReputationAiPort, type ResponseTone } from "./reputation-ai.port.js";
import { REPUTATION_PROPERTY_LOCK_TIMEOUT_MS, reputationPropertyLockKey, withAdvisoryLock } from "./reputation-lock.js";
import { invalidateReputationCache } from "./reputation-score.service.js";
import { analyzePendingReviews, raiseReviewAlerts, runReputationSync, sourceCodeFor, type ReputationSyncLogger } from "./reputation-sync.service.js";
import {
  INBOX_LIMIT_DEFAULT,
  INBOX_LIMIT_MAX,
  REPUTATION_ERROR_MESSAGES_ES,
  REVIEW_PROVIDER_LABELS_ES,
  hasCredentialKeys,
  type ImportResult,
  type ReviewSourceDto,
  type ReviewSourceRunDto,
  type ReviewSourceRunSummary
} from "./reputation-types.js";
import { createCaseFromReview, defaultOwnerFromConfiguration } from "./review-alerts.service.js";
import { CSV_CANONICAL_HEADERS, ReviewCsvParseError, parseReviewCsv } from "./review-csv.parser.js";
import { createReviewDraft } from "./review-draft.service.js";
import { getReview, listInbox, patchReview, type InboxQuery } from "./review-inbox.service.js";
import { saveSourceRun, upsertReviewFromNormalized } from "./review-meta.store.js";
import { createReviewSource, disableReviewSource, getReviewSource, listReviewSources, providerCodeFor, updateReviewSource } from "./review-sources.service.js";

type PropertyParams = { propertyId: string };
type EntityParams = { propertyId: string; id: string };
type IdParams = { id: string };

/** Subida de CSV: cuerpo de hasta 4 MiB (≈ 2 MiB decodificados) y 10 peticiones por minuto (@fastify/rate-limit, server.ts:1253). */
const IMPORT_OPTIONS = { bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

/** Reseñas analizadas en la propia importación; el resto las analiza el tick diario. */
export const IMPORT_MAX_ANALYSIS = 200;

/** Tono del cable → tono del puerto de IA (`breve` no existe en el puerto: cae en `formal`, la plantilla ya limita a 120 palabras). */
export const DRAFT_TONE_TO_PORT: Readonly<Record<DraftTone, ResponseTone>> = Object.freeze({ cordial: "cercano", formal: "formal", breve: "formal" });

export type ReputationRouteOptions = {
  /** Ids de cliente OAuth de Google (server.ts los lee del contrato de entorno). */
  collectorOptions?: CollectorOptions;
  /** Puerto de IA (tests); por defecto getReputationAiPort(). */
  ai?: ReputationAiPort;
};

/** Gate de módulo síncrono sobre el espejo hidratado (mismo texto que advanced-modules.service.ts:426-431). */
function requireReputationModule(propertyId: string): void {
  if (!getEnabledModuleCodes(propertyId).includes(REPUTATION_MODULE_CODE)) {
    throw new ForbiddenError("El módulo reputation_quality no está activado en esta propiedad.");
  }
}

function actorOf(request: FastifyRequest, correlationId: string): { organizationId: string; userId: string; correlationId: string } {
  return { organizationId: request.userContext.organizationId, userId: request.userContext.userId, correlationId };
}

/** Adaptador pino → ReputationSyncLogger (la firma del tick es (obj, msg)). */
function syncLogger(log: FastifyBaseLogger): ReputationSyncLogger {
  return {
    info: (obj, msg) => log.info(obj as object, msg),
    warn: (obj, msg) => log.warn(obj as object, msg),
    error: (obj, msg) => log.error(obj as object, msg)
  };
}

/** Ejecuta `run` bajo el lock por propiedad; ocupado (tick diario, otra importación o sincronización) → 409 REPUTATION_SYNC_BUSY. */
async function underPropertyLock<T>(propertyId: string, log: ReputationSyncLogger, run: () => Promise<T>): Promise<T> {
  const outcome = await withAdvisoryLock({ db: prisma, key: reputationPropertyLockKey(propertyId), timeoutMs: REPUTATION_PROPERTY_LOCK_TIMEOUT_MS, log, run });
  if (!outcome.locked) throw new ConflictError(REPUTATION_ERROR_MESSAGES_ES.REPUTATION_SYNC_BUSY, { code: "REPUTATION_SYNC_BUSY", propertyId });
  return outcome.result;
}

/** `PropertyModule.configurationJson.reputation.defaultOwnerUserId` del módulo en la propiedad, o null. */
async function defaultOwnerFor(propertyId: string): Promise<string | null> {
  const module = await prisma.module.findFirst({ where: { code: REPUTATION_MODULE_CODE }, select: { id: true } });
  if (!module) return null;
  const row = await prisma.propertyModule.findFirst({ where: { propertyId, moduleId: module.id }, select: { configurationJson: true } });
  return row ? defaultOwnerFromConfiguration(row.configurationJson) : null;
}

/** Filas JSON → CSV canónico (mismo parser y las mismas validaciones que el fichero). */
export function importRowsToCsv(rows: ReadonlyArray<ImportRowInput>): string {
  const quote = (value: unknown): string => {
    if (value === undefined || value === null) return "";
    const text = typeof value === "number" ? String(value) : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [CSV_CANONICAL_HEADERS.join(",")];
  for (const row of rows) {
    lines.push([row.externalId, row.date, row.rating, row.scaleMax, row.title, row.body, row.language, row.author, row.country, row.url].map(quote).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function importInvalid(reason: string, code: string): BadRequestError {
  const error = new BadRequestError(`${REPUTATION_ERROR_MESSAGES_ES.REVIEW_IMPORT_INVALID} ${reason}`.trim());
  error.details = { code: "REVIEW_IMPORT_INVALID", reason: code };
  return error;
}

export function registerReputationRoutes(app: FastifyInstance, options: ReputationRouteOptions = {}): void {
  const ai = (): ReputationAiPort => options.ai ?? getReputationAiPort();

  // Bandeja: filtros en memoria + paginación por cursor; array plano salvo ?envelope=1 / ?cursor= (regla de L2) y cabeceras X-Total-Count / X-Next-Cursor.
  app.get("/reputation/properties/:propertyId/inbox", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    requireReputationModule(propertyId);
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const query = parseOr400(InboxQuerySchema, raw, "query");
    const page = parsePageQuery(raw, { limit: INBOX_LIMIT_DEFAULT, max: INBOX_LIMIT_MAX });
    const filters: InboxQuery = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
      ...(query.maxScore !== undefined ? { maxScore: query.maxScore } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.language ? { language: query.language } : {}),
      ...(query.sentiment ? { sentiment: query.sentiment } : {}),
      ...(query.responded !== undefined ? { responded: query.responded } : {}),
      ...(query.overdue !== undefined ? { overdue: query.overdue } : {}),
      ...(query.assignedUserId ? { assignedUserId: query.assignedUserId } : {})
    };
    const result = await listInbox({ propertyId, query: filters, page });
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });

  // Fuentes: lista (sin las desactivadas salvo ?includeDisabled=1) y alta (estado honesto del colector; nunca credenciales en configJson).
  app.get("/reputation/properties/:propertyId/sources", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    requireReputationModule(propertyId);
    const query = parseOr400(SourcesQuerySchema, request.query ?? {}, "query");
    return listReviewSources({ propertyId, includeDisabled: query.includeDisabled === true });
  });

  app.post("/reputation/properties/:propertyId/sources", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    requireReputationModule(propertyId);
    const leaked = hasCredentialKeys(request.body);
    if (leaked.length > 0) {
      const error = new BadRequestError(`Las credenciales no viajan en la configuración de la fuente (${leaked.join(", ")}): autoriza el portal desde su flujo OAuth.`);
      error.details = { code: "REVIEW_SOURCE_CREDENTIALS_IN_CONFIG", keys: leaked };
      throw error;
    }
    const body = parseOr400(SourceCreateSchema, request.body ?? {}, "body");
    const source = await createReviewSource({
      propertyId,
      input: body,
      actor: actorOf(request, createId("corr")),
      ...(options.collectorOptions ? { options: options.collectorOptions } : {})
    });
    return reply.code(201).send(source);
  });

  // Ejecuciones: ring buffers de todas las fuentes (desactivadas incluidas), las más recientes primero.
  app.get("/reputation/properties/:propertyId/runs", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    requireReputationModule(propertyId);
    const query = parseOr400(RunsQuerySchema, request.query ?? {}, "query");
    const sources = await listReviewSources({ propertyId, includeDisabled: true });
    const runs: ReviewSourceRunDto[] = sources
      .filter((source) => !query.sourceId || source.id === query.sourceId)
      .flatMap((source) => source.runs)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    return runs.slice(0, query.limit);
  });

  // Importación CSV (o filas JSON): parser → upsert idempotente → análisis acotado → alertas → ejecución en la fuente → caché. 201 ImportResult.
  app.post("/reputation/properties/:propertyId/imports", IMPORT_OPTIONS, async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    requireReputationModule(propertyId);
    const body = parseOr400(ImportSchema, request.body ?? {}, "body");
    const now = new Date();
    const startedAt = now.toISOString();
    const correlationId = createId("corr");
    const organizationId = request.userContext.organizationId;
    const log = syncLogger(request.log);

    const text = body.contentBase64 !== undefined ? Buffer.from(body.contentBase64, "base64").toString("utf8") : importRowsToCsv(body.rows ?? []);
    let parsed: ReturnType<typeof parseReviewCsv>;
    try {
      parsed = parseReviewCsv(text, { source: body.source, ...(body.scaleMax !== undefined ? { scaleMax: body.scaleMax } : {}), now });
    } catch (error) {
      if (error instanceof ReviewCsvParseError) throw importInvalid(error.message, error.code);
      throw error;
    }

    // Todo lo que escribe va bajo el lock por propiedad (409 si el tick o otra importación lo tienen).
    const result = await underPropertyLock(propertyId, log, async (): Promise<ImportResult> => {
      // Fuente destino: la indicada (404 opaco si no es de la propiedad) o la fuente CSV del portal (se crea si falta).
      let source: ReviewSourceDto;
      if (body.sourceId) {
        source = await getReviewSource({ id: body.sourceId, propertyId });
        if (source.status === "disabled") throw new ConflictError("La fuente de reseñas está desactivada.", { code: "REVIEW_SOURCE_DISABLED", sourceId: source.id });
      } else {
        const providerCode = providerCodeFor(body.source, false);
        const existing = (await listReviewSources({ propertyId })).find((candidate) => candidate.provider === providerCode && candidate.mode === "csv");
        source =
          existing ??
          (await createReviewSource({
            propertyId,
            input: { provider: body.source, mode: "csv", displayName: body.source === "csv" ? REVIEW_PROVIDER_LABELS_ES.csv : `${REVIEW_PROVIDER_LABELS_ES[body.source]} · CSV` },
            actor: actorOf(request, correlationId),
            ...(options.collectorOptions ? { options: options.collectorOptions } : {})
          }));
      }

      let created = 0;
      let updated = 0;
      let unchanged = 0;
      for (const item of parsed.rows) {
        const outcome = await upsertReviewFromNormalized({
          propertyId,
          source: sourceCodeFor(item, body.source, source.isDemo),
          sourceId: source.id,
          sourceMode: "csv",
          item,
          now,
          ...(source.isDemo ? { isDemo: true } : {})
        });
        if (outcome.outcome === "created") created += 1;
        else if (outcome.outcome === "updated") updated += 1;
        else unchanged += 1;
      }

      const analyzed = await analyzePendingReviews({ db: prisma, propertyId, ai: ai(), budget: Math.min(parsed.rows.length, IMPORT_MAX_ANALYSIS), now, log, correlationId, organizationId });
      const casesOpened = await raiseReviewAlerts({ db: prisma, organizationId, propertyId, now, correlationId, defaultOwnerUserId: await defaultOwnerFor(propertyId), log });

      const invalid = parsed.invalid.length;
      const run: ReviewSourceRunSummary = {
        id: createId("run"),
        trigger: "import",
        status: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        fetched: parsed.rows.length,
        created,
        updated,
        unchanged,
        purged: 0,
        ...(invalid > 0 ? { error: `${invalid} filas descartadas por datos inválidos.` } : {}),
        correlationId
      };
      await saveSourceRun({ sourceId: source.id, run, status: source.status });
      invalidateReputationCache(propertyId);

      const duplicates = unchanged + parsed.duplicates.length;
      recordAuditEvent({
        organizationId,
        propertyId,
        actorUserId: request.userContext.userId,
        actorType: "user",
        action: "ReviewsImported",
        entityType: "review_source",
        entityId: source.id,
        afterJson: { provider: body.source, fileName: body.fileName ?? null, total: parsed.total, created, updated, duplicates, invalid, analyzed, casesOpened },
        correlationId
      });

      return { created, updated, duplicates, invalid: parsed.invalid, total: parsed.total, sourceId: source.id, correlationId };
    });
    return reply.code(201).send(result);
  });

  // Fuente concreta: cambio (estado recalculado por el colector), baja (status disabled, nunca delete físico) y sincronización manual.
  app.patch("/reputation/properties/:propertyId/sources/:id", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    requireReputationModule(propertyId);
    const body = parseOr400(SourceUpdateSchema, request.body ?? {}, "body");
    return updateReviewSource({
      id,
      propertyId,
      input: body,
      actor: actorOf(request, createId("corr")),
      ...(options.collectorOptions ? { options: options.collectorOptions } : {})
    });
  });

  app.delete("/reputation/properties/:propertyId/sources/:id", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    requireReputationModule(propertyId);
    return disableReviewSource({ id, propertyId, actor: actorOf(request, createId("corr")) });
  });

  app.post("/reputation/properties/:propertyId/sources/:id/sync", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    requireReputationModule(propertyId);
    const source = await getReviewSource({ id, propertyId });
    if (source.status === "disabled") throw new ConflictError("La fuente de reseñas está desactivada.", { code: "REVIEW_SOURCE_DISABLED", sourceId: source.id });
    const correlationId = createId("corr");
    const log = syncLogger(request.log);
    const summary = await underPropertyLock(propertyId, log, () =>
      runReputationSync({
        propertyIds: [propertyId],
        sourceIds: [id],
        trigger: "manual",
        ai: ai(),
        log,
        ...(options.collectorOptions ? { collectorOptions: options.collectorOptions } : {})
      })
    );
    const perProperty = summary.byProperty.find((entry) => entry.propertyId === propertyId) ?? null;
    if (!perProperty) throw new NotFoundError("Fuente de reseñas no encontrada.");
    const run = perProperty.runs.find((entry) => entry.sourceId === id) ?? null;
    if (!run) throw new NotFoundError("Fuente de reseñas no encontrada.");
    recordAuditEvent({
      organizationId: request.userContext.organizationId,
      propertyId,
      actorUserId: request.userContext.userId,
      actorType: "user",
      action: "ReviewSourceSynced",
      entityType: "review_source",
      entityId: id,
      afterJson: { runId: run.id, status: run.status, fetched: run.fetched, created: run.created, updated: run.updated, unchanged: run.unchanged, ...(run.error ? { error: run.error } : {}), tickCorrelationId: summary.correlationId },
      correlationId
    });
    return { run, summary: perProperty };
  });

  // Reseña: detalle, cambio de estado/responsable/plazo (nunca responseBody), borrador con revisión humana y caso de calidad.
  app.get("/reputation/reviews/:id", async (request) => {
    const { id } = request.params as IdParams;
    const propertyId = await assertPropertyEntityAccess(request, { entity: "guestReview", id });
    requireReputationModule(propertyId);
    return getReview({ id, propertyId });
  });

  app.patch("/reputation/reviews/:id", async (request) => {
    const { id } = request.params as IdParams;
    const propertyId = await assertPropertyEntityAccess(request, { entity: "guestReview", id });
    requireReputationModule(propertyId);
    const body = parseOr400(ReviewPatchSchema, request.body ?? {}, "body");
    if (body.assignedUserId) {
      const assignee = await prisma.user.findFirst({ where: { id: body.assignedUserId, organizationId: request.userContext.organizationId }, select: { id: true } });
      if (!assignee) throw new BadRequestError("assignedUserId no corresponde a un usuario de la organización.");
    }
    return patchReview({ id, propertyId, patch: body, actor: actorOf(request, createId("corr")) });
  });

  app.post("/reputation/reviews/:id/draft", async (request, reply) => {
    const { id } = request.params as IdParams;
    const propertyId = await assertPropertyEntityAccess(request, { entity: "guestReview", id });
    requireReputationModule(propertyId);
    const body = parseOr400(DraftSchema, request.body ?? {}, "body");
    const result = await createReviewDraft({
      context: request.userContext,
      reviewId: id,
      propertyId,
      ...(body.tone ? { tone: DRAFT_TONE_TO_PORT[body.tone] } : {}),
      ...(body.language ? { language: body.language } : {}),
      correlationId: createId("corr"),
      ai: ai()
    });
    return reply.code(201).send(result);
  });

  app.post("/reputation/reviews/:id/quality-case", async (request, reply) => {
    const { id } = request.params as IdParams;
    const propertyId = await assertPropertyEntityAccess(request, { entity: "guestReview", id });
    requireReputationModule(propertyId);
    const body = parseOr400(QualityCaseFromReviewSchema, request.body ?? {}, "body");
    const organizationId = request.userContext.organizationId;
    const correlationId = createId("corr");
    const now = new Date();
    const review = await prisma.guestReview.findFirst({ where: { id, propertyId } });
    if (!review) throw new NotFoundError("Reseña no encontrada.");
    if (body.ownerUserId) {
      const owner = await prisma.user.findFirst({ where: { id: body.ownerUserId, organizationId }, select: { id: true } });
      if (!owner) throw new BadRequestError("ownerUserId no corresponde a un usuario de la organización.");
    }
    const outcome = await createCaseFromReview({
      organizationId,
      propertyId,
      review,
      now,
      correlationId,
      defaultOwnerUserId: body.ownerUserId ?? (await defaultOwnerFor(propertyId)),
      actor: { type: "user", userId: request.userContext.userId },
      force: true
    });
    if (!outcome.created || !outcome.caseId) {
      throw new ConflictError("La reseña ya tiene un caso de calidad.", { code: "QUALITY_CASE_ALREADY_LINKED", caseId: outcome.caseId });
    }
    const overrides = {
      ...(body.priority ? { priority: body.priority } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.slaTargetAt ? { slaTargetAt: new Date(body.slaTargetAt) } : {})
    };
    const qualityCase = Object.keys(overrides).length > 0 ? await prisma.qualityCase.update({ where: { id: outcome.caseId }, data: overrides }) : await prisma.qualityCase.findUniqueOrThrow({ where: { id: outcome.caseId } });
    recordAuditEvent({
      organizationId,
      propertyId,
      actorUserId: request.userContext.userId,
      actorType: "user",
      action: "QualityCaseCreated",
      entityType: "quality_case",
      entityId: qualityCase.id,
      afterJson: { reviewId: review.id, caseType: qualityCase.caseType, priority: qualityCase.priority, title: qualityCase.title, ownerUserId: qualityCase.ownerUserId, slaTargetAt: qualityCase.slaTargetAt?.toISOString() ?? null },
      correlationId
    });
    return reply.code(201).send({ ...qualityCase, reviewId: review.id });
  });
}
