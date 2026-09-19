// Reputación · Tanda T8 · lote T8-C — bandeja de reseñas sobre las tablas
// existentes (apps/api/src/modules/reputation/review-inbox.service.ts).
//
// Lista, detalle y PATCH de estado de GuestReview con la forma ReviewMeta v1
// en topicsJson. COSTE DOCUMENTADO: hasta el índice `[propertyId, status,
// slaTargetAt]` y las columnas del parche T8-L0, los filtros de bandeja
// (status, category, score…) viven en JSON: se cargan hasta INBOX_SCAN_LIMIT
// (500) filas de la propiedad ordenadas por receivedAt desc y se filtran y
// paginan en memoria con lib/pagination.ts (parsePageQuery/buildPage/
// pageHeaders). Una propiedad con más de 500 reseñas solo ve las 500 más
// recientes en la bandeja hasta aplicar el parche.
//
// Reglas:
//   · zod en toda entrada (`.strict()` en el PATCH);
//   · máquina de estados new → assigned → drafted → responded → closed
//     (+ ignored desde new/assigned); transición no permitida → 409
//     ConflictError('Transición no permitida.', { code: 'INVALID_TRANSITION' });
//   · `publish: true` sobre una reseña sin replyCapability → 409
//     REVIEW_NOT_REPLYABLE; este servicio NUNCA escribe responseBody: la
//     respuesta solo la publica POST /reputation/reviews/:id/respond
//     (server.ts:3252);
//   · 404 opaco (Reseña no encontrada.) si la fila no es de la propiedad;
//   · ESTADO EFECTIVO: POST /reputation/reviews/:id/respond (motor genérico,
//     advanced-record-store.ts:841-852) escribe responseBody/respondedAt pero
//     no topicsJson, así que una fila con respondedAt y meta abierta
//     (new/assigned/drafted) se lee como `responded` (effectiveReviewStatus) en
//     la bandeja y el detalle; patchReview la reconcilia al persistir y el tick
//     diario hace lo mismo (reconcileRespondedReviews), cerrando además el ítem
//     HITL review_response pendiente del borrador (review-draft.service.ts);
//   · el detalle expone `draftReviewStatus` (estado vivo del ítem HITL) para
//     que el cajón no publique un borrador rechazado;
//   · `db` inyectable; auditoría inyectable.

import { prisma } from "@hotelos/database";
import { z } from "zod";
import { recordAuditEvent } from "../audit/audit.service.js";
import { ConflictError, NotFoundError, BadRequestError } from "../../lib/http-error.js";
import { buildPage, decodeCursor, type Page, type PageQuery } from "../../lib/pagination.js";
import {
  REPUTATION_ERROR_MESSAGES_ES,
  REVIEW_CATEGORIES,
  REVIEW_OPEN_STATUSES,
  REVIEW_STATUSES,
  SENTIMENTS,
  isReviewOverdue,
  type ReviewDetail,
  type ReviewDraftReviewStatus,
  type ReviewInboxItem,
  type ReviewMeta,
  type ReviewMetaInput,
  type ReviewStatus,
  type Sentiment
} from "./reputation-types.js";
import { getReviewMeta, patchReviewMeta, scoreOfRow, type GuestReviewRow, type ReputationDb } from "./review-meta.store.js";
import { readDraftReviewStatus, resolveReviewDraftItem } from "./review-draft.service.js";

export const INBOX_SCAN_LIMIT = 500;
export const EXCERPT_LENGTH = 160;

// ---------------------------------------------------------------------------
// Máquina de estados
// ---------------------------------------------------------------------------

export const REVIEW_TRANSITIONS: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> = Object.freeze({
  new: Object.freeze(["assigned", "drafted", "ignored"] as const),
  assigned: Object.freeze(["drafted", "responded", "ignored"] as const),
  drafted: Object.freeze(["assigned", "responded"] as const),
  responded: Object.freeze(["closed"] as const),
  closed: Object.freeze([] as const),
  ignored: Object.freeze([] as const)
});

export function canTransition(from: ReviewStatus, to: ReviewStatus): boolean {
  return from === to || REVIEW_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ReviewStatus, to: ReviewStatus): void {
  if (!canTransition(from, to)) throw new ConflictError("Transición no permitida.", { code: "INVALID_TRANSITION", from, to });
}

/**
 * Estado de bandeja honesto: una fila con `respondedAt` (respuesta publicada por
 * POST …/respond, que no escribe topicsJson) cuenta como `responded` aunque la
 * meta siga en new/assigned/drafted; `closed`/`ignored` se respetan.
 */
export function effectiveReviewStatus(row: Pick<GuestReviewRow, "respondedAt">, meta: Pick<ReviewMeta, "status">): ReviewStatus {
  if (row.respondedAt && (REVIEW_OPEN_STATUSES as readonly string[]).includes(meta.status)) return "responded";
  return meta.status;
}

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

const boolFromQuery = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

/** Filtros de `GET /reputation/properties/:propertyId/reviews` (las claves de paginación se ignoran aquí). */
export const INBOX_QUERY_SCHEMA = z.object({
  status: z.enum(REVIEW_STATUSES).optional(),
  /** Código de proveedor (`google`, `booking_demo`…). */
  source: z.string().trim().min(1).max(60).optional(),
  minScore: z.coerce.number().min(0).max(10).optional(),
  maxScore: z.coerce.number().min(0).max(10).optional(),
  category: z.enum(REVIEW_CATEGORIES).optional(),
  language: z.string().trim().min(2).max(8).optional(),
  sentiment: z.enum(SENTIMENTS).optional(),
  responded: boolFromQuery.optional(),
  overdue: boolFromQuery.optional(),
  assignedUserId: z.string().trim().min(1).max(100).optional()
});
export type InboxQuery = z.infer<typeof INBOX_QUERY_SCHEMA>;

export const REVIEW_PATCH_SCHEMA = z
  .object({
    status: z.enum(REVIEW_STATUSES).optional(),
    assignedUserId: z.string().trim().min(1).max(100).nullable().optional(),
    slaTargetAt: z.string().datetime({ offset: true }).nullable().optional(),
    responseSource: z.enum(["api", "manual"]).optional(),
    responseExternalState: z.string().trim().min(1).max(100).optional(),
    /** Solo valida que la reseña admita respuesta por API (la publicación es de POST …/respond). */
    publish: z.boolean().optional()
  })
  .strict();
export type ReviewPatchInput = z.infer<typeof REVIEW_PATCH_SCHEMA>;

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new BadRequestError(`${what} no válido. ${path}${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

export function parseInboxQuery(query: unknown): InboxQuery {
  return parseOrThrow(INBOX_QUERY_SCHEMA, query, "Filtro de la bandeja");
}

// ---------------------------------------------------------------------------
// Mapeo fila → DTO
// ---------------------------------------------------------------------------

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sentimentOf(row: Pick<GuestReviewRow, "sentiment">): Sentiment | null {
  return row.sentiment && (SENTIMENTS as readonly string[]).includes(row.sentiment) ? (row.sentiment as Sentiment) : null;
}

/** Fila → ítem de bandeja (extracto ≤ 160 caracteres; `overdue` vivo; estado efectivo). */
export function toInboxItem(row: GuestReviewRow, now: Date, meta: ReviewMeta = getReviewMeta(row)): ReviewInboxItem {
  const body = row.body?.trim() ?? "";
  const status = effectiveReviewStatus(row, meta);
  return {
    id: row.id,
    propertyId: row.propertyId,
    provider: row.source,
    sourceId: meta.sourceId ?? null,
    sourceMode: meta.sourceMode,
    score10: scoreOfRow(row, meta),
    ratingRaw: meta.ratingRaw,
    ratingScaleMax: meta.ratingScaleMax,
    sentiment: sentimentOf(row),
    title: row.title ?? null,
    excerpt: body ? (body.length > EXCERPT_LENGTH ? `${body.slice(0, EXCERPT_LENGTH - 1)}…` : body) : null,
    bodyComplete: meta.bodyComplete,
    bodyPurged: Boolean(meta.bodyPurgedAt),
    language: row.language ?? null,
    authorDisplayName: meta.authorDisplayName ?? null,
    authorCountry: meta.authorCountry ?? null,
    portalUrl: meta.portalUrl ?? null,
    receivedAt: iso(row.receivedAt),
    respondedAt: iso(row.respondedAt),
    createdAt: iso(row.createdAt) ?? now.toISOString(),
    status,
    assignedUserId: meta.assignedUserId ?? null,
    slaTargetAt: meta.slaTargetAt ?? null,
    overdue: isReviewOverdue({ status, slaTargetAt: meta.slaTargetAt ?? null }, now),
    replyCapability: meta.replyCapability,
    categories: meta.categories,
    analysisStatus: meta.analysis.status,
    analysisSource: meta.analysis.source,
    hasDraft: Boolean(meta.draft),
    qualityCaseId: meta.qualityCaseId ?? null,
    isDemo: meta.isDemo === true
  };
}

/** Fila → detalle (cuerpo completo, respuesta, análisis, borrador; `draftReviewStatus` lo aporta el llamador que consulta el ítem HITL). */
export function toReviewDetail(row: GuestReviewRow, now: Date, meta: ReviewMeta = getReviewMeta(row), draftReviewStatus: ReviewDraftReviewStatus | null = null): ReviewDetail {
  return {
    ...toInboxItem(row, now, meta),
    body: row.body ?? null,
    responseBody: row.responseBody ?? null,
    summary: meta.analysis.summary ?? null,
    analysis: meta.analysis,
    draft: meta.draft ?? null,
    draftReviewStatus,
    response: meta.response ?? null,
    reservationId: row.reservationId ?? null,
    guestId: row.guestId ?? null,
    contentHash: meta.contentHash,
    bodyPurgedAt: meta.bodyPurgedAt ?? null
  };
}

// ---------------------------------------------------------------------------
// Filtros en memoria y paginación
// ---------------------------------------------------------------------------

export function matchesInboxQuery(item: ReviewInboxItem, query: InboxQuery): boolean {
  if (query.status && item.status !== query.status) return false;
  if (query.source && item.provider !== query.source) return false;
  if (query.minScore !== undefined && (item.score10 === null || item.score10 < query.minScore)) return false;
  if (query.maxScore !== undefined && (item.score10 === null || item.score10 > query.maxScore)) return false;
  if (query.category && !item.categories.some((mention) => mention.category === query.category)) return false;
  if (query.language && (item.language ?? "").toLowerCase() !== query.language.toLowerCase()) return false;
  if (query.sentiment && item.sentiment !== query.sentiment) return false;
  if (query.responded !== undefined && Boolean(item.respondedAt) !== query.responded) return false;
  if (query.overdue !== undefined && item.overdue !== query.overdue) return false;
  if (query.assignedUserId && item.assignedUserId !== query.assignedUserId) return false;
  return true;
}

/** Clave de orden del cursor: receivedAt (o createdAt) ISO, desc. */
export function inboxSortKey(item: Pick<ReviewInboxItem, "receivedAt" | "createdAt">): string {
  return item.receivedAt ?? item.createdAt;
}

export type ListInboxInput = {
  db?: ReputationDb;
  propertyId: string;
  query?: InboxQuery;
  page: PageQuery;
  now?: Date;
};

/**
 * Bandeja paginada. `page` viene de parsePageQuery(request.query, { limit: 25,
 * max: 100 }); la ruta añade pageHeaders(page) y devuelve pageBody(page, query).
 */
export async function listInbox(input: ListInboxInput): Promise<Page<ReviewInboxItem>> {
  const db = input.db ?? prisma;
  const now = input.now ?? new Date();
  const query = input.query ?? {};
  const rows = await db.guestReview.findMany({
    where: { propertyId: input.propertyId },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: INBOX_SCAN_LIMIT
  });
  const items = rows.map((row) => toInboxItem(row, now)).filter((item) => matchesInboxQuery(item, query));
  items.sort((a, b) => inboxSortKey(b).localeCompare(inboxSortKey(a)) || b.id.localeCompare(a.id));
  const cursor = decodeCursor(input.page.cursor);
  let start = 0;
  if (cursor) {
    // Orden desc por (clave, id): se salta todo lo que está en o antes del cursor.
    start = items.findIndex((item) => {
      const key = inboxSortKey(item);
      return key < cursor.k || (key === cursor.k && item.id < cursor.id);
    });
    if (start < 0) start = items.length;
  }
  const slice = items.slice(start, start + input.page.limit + 1);
  return buildPage(slice, input.page.limit, items.length, inboxSortKey);
}

// ---------------------------------------------------------------------------
// Detalle y PATCH
// ---------------------------------------------------------------------------

async function loadRow(db: ReputationDb, id: string, propertyId: string): Promise<GuestReviewRow> {
  const row = await db.guestReview.findFirst({ where: { id, propertyId } });
  if (!row) throw new NotFoundError("Reseña no encontrada.");
  return row;
}

export async function getReview(input: { db?: ReputationDb; id: string; propertyId: string; now?: Date }): Promise<ReviewDetail> {
  const db = input.db ?? prisma;
  const row = await loadRow(db, input.id, input.propertyId);
  const meta = getReviewMeta(row);
  const draftReviewStatus = await readDraftReviewStatus({ db, meta });
  return toReviewDetail(row, input.now ?? new Date(), meta, draftReviewStatus);
}

export type ReviewActor = { organizationId: string; userId?: string; correlationId?: string };
export type ReviewInboxDeps = { audit?: typeof recordAuditEvent };
const defaultDeps: Required<ReviewInboxDeps> = { audit: recordAuditEvent };

export type PatchReviewInput = {
  db?: ReputationDb;
  id: string;
  propertyId: string;
  patch: unknown;
  actor: ReviewActor;
  now?: Date;
  deps?: ReviewInboxDeps;
};

/**
 * Cambia estado / responsable / plazo / metadatos de la respuesta. Nunca
 * escribe responseBody (ver cabecera). `status: responded` por PATCH documenta
 * una respuesta publicada a mano en el portal (responseSource `manual`).
 */
export async function patchReview(input: PatchReviewInput): Promise<ReviewDetail> {
  const db = input.db ?? prisma;
  const now = input.now ?? new Date();
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const patch = parseOrThrow(REVIEW_PATCH_SCHEMA, input.patch, "Cambio de la reseña");
  const row = await loadRow(db, input.id, input.propertyId);
  const meta = getReviewMeta(row);
  // Reconciliación: respondida fuera de la bandeja (POST …/respond) → la meta se pone al día aquí mismo.
  const currentStatus = effectiveReviewStatus(row, meta);
  const before = { status: currentStatus, assignedUserId: meta.assignedUserId ?? null, slaTargetAt: meta.slaTargetAt ?? null };

  if (patch.publish === true && !meta.replyCapability) {
    throw new ConflictError(REPUTATION_ERROR_MESSAGES_ES.REVIEW_NOT_REPLYABLE, { code: "REVIEW_NOT_REPLYABLE" });
  }

  let nextStatus: ReviewStatus = currentStatus;
  if (patch.status) {
    assertTransition(currentStatus, patch.status);
    nextStatus = patch.status;
  } else if (patch.assignedUserId && currentStatus === "new") {
    nextStatus = "assigned";
  }

  // `assignedUserId: null` retira el responsable: la fusión {...meta, ...patch}
  // deja la clave en undefined y readReviewMeta la omite al reescribir.
  const metaPatch: ReviewMetaInput = { status: nextStatus };
  if (patch.assignedUserId !== undefined) metaPatch.assignedUserId = patch.assignedUserId ?? undefined;
  if (patch.slaTargetAt !== undefined) metaPatch.slaTargetAt = patch.slaTargetAt;
  if (patch.responseSource || patch.responseExternalState) {
    metaPatch.response = {
      source: patch.responseSource ?? meta.response?.source ?? "manual",
      ...(patch.responseExternalState ? { externalState: patch.responseExternalState } : meta.response?.externalState ? { externalState: meta.response.externalState } : {})
    };
  }
  const columns = nextStatus === "responded" && !row.respondedAt ? { respondedAt: now } : undefined;
  const result = await patchReviewMeta({ db, id: row.id, patch: metaPatch, ...(columns ? { columns } : {}) });
  // Publicada (ahora o antes, fuera de la bandeja): el ítem HITL del borrador se cierra como aprobado (nunca publica: ya está publicada).
  if (nextStatus === "responded" && meta.status !== "responded") {
    await resolveReviewDraftItem({ db, meta: result.meta, reviewId: row.id, organizationId: input.actor.organizationId, propertyId: input.propertyId, ...(input.actor.userId ? { userId: input.actor.userId } : {}), decision: "approved", notes: "Respuesta publicada desde la bandeja de reseñas.", ...(input.actor.correlationId ? { correlationId: input.actor.correlationId } : {}) });
  }
  const draftReviewStatus = await readDraftReviewStatus({ db, meta: result.meta });
  const detail = toReviewDetail(result.row, now, result.meta, draftReviewStatus);
  deps.audit({
    organizationId: input.actor.organizationId,
    propertyId: input.propertyId,
    ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
    actorType: input.actor.userId ? "user" : "system",
    action: "ReviewUpdated",
    entityType: "guest_review",
    entityId: row.id,
    beforeJson: before,
    afterJson: { status: detail.status, assignedUserId: detail.assignedUserId, slaTargetAt: detail.slaTargetAt },
    ...(input.actor.correlationId ? { correlationId: input.actor.correlationId } : {})
  });
  return detail;
}

// ---------------------------------------------------------------------------
// Reconciliación de respondidas (tick diario)
// ---------------------------------------------------------------------------

export const RECONCILE_SCAN_LIMIT = 200;

/**
 * Filas con `respondedAt` (respuesta publicada por POST …/respond, curl, móvil…)
 * cuya meta sigue abierta pasan a `responded` y su ítem HITL pendiente se cierra
 * como aprobado (actor de sistema). Devuelve cuántas se han puesto al día.
 * Acotado a las RECONCILE_SCAN_LIMIT más recientes por vuelta. Nunca lanza.
 */
export async function reconcileRespondedReviews(input: {
  db?: ReputationDb;
  organizationId: string;
  propertyId: string;
  now: Date;
  correlationId: string;
  log?: { warn: (obj: unknown, msg?: string) => void };
}): Promise<number> {
  const db = input.db ?? prisma;
  const rows = await db.guestReview.findMany({
    where: { propertyId: input.propertyId, respondedAt: { not: null } },
    orderBy: { respondedAt: "desc" },
    take: RECONCILE_SCAN_LIMIT
  });
  let reconciled = 0;
  for (const row of rows) {
    if (!row.respondedAt) continue;
    const meta = getReviewMeta(row);
    if (effectiveReviewStatus(row, meta) === meta.status) continue;
    try {
      const result = await patchReviewMeta({ db, id: row.id, patch: { status: "responded" } });
      await resolveReviewDraftItem({ db, meta: result.meta, reviewId: row.id, organizationId: input.organizationId, propertyId: input.propertyId, decision: "approved", notes: "Respuesta publicada fuera de la bandeja (reconciliada por el tick).", correlationId: input.correlationId });
      reconciled += 1;
    } catch (error) {
      input.log?.warn({ reviewId: row.id, propertyId: input.propertyId, correlationId: input.correlationId, err: error instanceof Error ? error.message : String(error) }, "[reputation.sync] reconciliación fallida");
    }
  }
  return reconciled;
}
