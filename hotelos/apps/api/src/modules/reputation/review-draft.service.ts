// Reputación · Tanda T8 · lote T8-C — borrador de respuesta con revisión
// humana (apps/api/src/modules/reputation/review-draft.service.ts).
//
// Patrón de messaging.service.ts:285-384 (createAiReplyDraft) SIN importar
// lib/llm.ts: la IA entra por ReputationAiPort (reputation-ai.port.ts; por
// defecto RulesReputationAi = plantillas con etiqueta honesta `rules`, y L6a
// engancha ai-core con setReputationAiPort). El texto de la reseña pasa por
// maskReviewForLlm antes de llegar al puerto.
//
// Flujo: requirePermissions(reputation.respond) [+ ai.tool.execute solo si el
// puerto está configurado] → borrador → meta.draft {body, source, model,
// draftedAt} + status `drafted` → enqueueReview(review_response) → meta.draft.
// reviewItemId → recordToolCall best-effort (pipeline.service.ts:36-56) →
// recordAuditEvent ReviewResponseDrafted (actorType `ai` si el borrador es de
// IA, `user` si es de reglas).
//
// APROBAR EN HITL NUNCA PUBLICA: approveReview (human-review.service.ts:236)
// solo cambia el estado del ítem; `GuestReview.responseBody` lo escribe
// únicamente POST /reputation/reviews/:id/respond (server.ts:3252), iniciado
// por un usuario con reputation.respond. review-draft.test.mts lo pina: este
// servicio no escribe responseBody ni respondedAt.
//
// Circuito HITL cerrado (corrección ronda 1, HP-01):
//   · un solo ítem pendiente por reseña: si `meta.draft.reviewItemId` sigue
//     pending/escalated al generar otro borrador, se rechaza con motivo
//     «Sustituido por un nuevo borrador» antes de encolar el nuevo;
//   · al publicar (PATCH → responded, o reconciliación del tick) el ítem
//     pendiente se aprueba con nota (resolveReviewDraftItem): la cola no
//     acumula pendientes eternos ni SLA incumplidos ficticios;
//   · un ítem rechazado bloquea publicar ESE texto: assertDraftPublishable
//     (mergeLine para el handler de POST …/respond en server.ts) y el detalle
//     expone `draftReviewStatus` (readDraftReviewStatus) para que el cajón
//     lo avise; el texto del autor se enmascara además como nombre conocido.

import { prisma } from "@hotelos/database";
import { approveReview, enqueueReview, getReviewItem, rejectReview } from "../ai-operations/human-review.service.js";
import { recordToolCall } from "../ai-operations/pipeline.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import { containsMaskPlaceholder, maskReviewForLlm } from "./mask-pii.js";
import { getReputationAiPort, type DraftResponseOutput, type ReputationAiPort, type ResponseTone } from "./reputation-ai.port.js";
import { buildRulesDraft } from "./reputation-ai.rules.js";
import { reputationSystemContext } from "./reputation-context.js";
import { REPUTATION_ERROR_MESSAGES_ES, REVIEW_DRAFT_REVIEW_STATUSES, REVIEW_PROVIDER_LABELS_ES, baseProvider, sentimentBucket, type ReviewDraftResult, type ReviewDraftReviewStatus, type ReviewMeta, type ReviewStatus, type Sentiment } from "./reputation-types.js";
import { getReviewMeta, patchReviewMeta, scoreOfRow, type ReputationDb } from "./review-meta.store.js";

export const REVIEW_DRAFT_TOOL_NAME = "draftReviewResponse";
export const REVIEW_DRAFT_REVIEW_TYPE = "review_response";
/** Estados desde los que ya no tiene sentido redactar. */
export const REVIEW_DRAFT_CLOSED_STATUSES: readonly ReviewStatus[] = Object.freeze(["responded", "closed", "ignored"]);

export type ReviewDraftDeps = {
  enqueue?: typeof enqueueReview;
  toolCall?: typeof recordToolCall;
  audit?: typeof recordAuditEvent;
  /** Lectura/decisión sobre el ítem HITL anterior (dedupe y cierre); inyectables en los tests. */
  getItem?: typeof getReviewItem;
  reject?: typeof rejectReview;
  approve?: typeof approveReview;
};

const defaultDeps: Required<ReviewDraftDeps> = { enqueue: enqueueReview, toolCall: recordToolCall, audit: recordAuditEvent, getItem: getReviewItem, reject: rejectReview, approve: approveReview };

export const REVIEW_DRAFT_SUPERSEDED_REASON = "Sustituido por un nuevo borrador de la misma reseña.";

function isDraftReviewStatus(value: unknown): value is ReviewDraftReviewStatus {
  return typeof value === "string" && (REVIEW_DRAFT_REVIEW_STATUSES as readonly string[]).includes(value);
}

/** Texto comparable de un borrador / respuesta (espacios colapsados, minúsculas). */
function canonicalBody(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Estado vivo del ítem HITL del borrador (`null` sin borrador, sin ítem o si el
 * cliente no expone `aiHumanReviewItem`, p. ej. un stub). Nunca lanza.
 */
export async function readDraftReviewStatus(input: { db?: ReputationDb; meta: Pick<ReviewMeta, "draft"> }): Promise<ReviewDraftReviewStatus | null> {
  const db = input.db ?? prisma;
  const id = input.meta.draft?.reviewItemId;
  if (!id || !db.aiHumanReviewItem) return null;
  try {
    const row = await db.aiHumanReviewItem.findFirst({ where: { id }, select: { status: true } });
    return row && isDraftReviewStatus(row.status) ? row.status : null;
  } catch {
    return null;
  }
}

export type ResolveReviewDraftItemInput = {
  db?: ReputationDb;
  meta: Pick<ReviewMeta, "draft">;
  reviewId: string;
  organizationId: string;
  propertyId: string;
  /** Persona que decide; sin ella, el bot de reputación (actor de sistema). */
  userId?: string;
  decision: "approved" | "rejected";
  notes?: string;
  correlationId?: string;
  deps?: ReviewDraftDeps;
};

/**
 * Cierra el ítem HITL pendiente/escalado del borrador de una reseña (aprobado al
 * publicar, rechazado al sustituirlo). Ítem inexistente, ya decidido o error del
 * servicio de revisión → `null` sin lanzar (la publicación nunca depende de esto).
 */
export async function resolveReviewDraftItem(input: ResolveReviewDraftItemInput): Promise<ReviewDraftReviewStatus | null> {
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const id = input.meta.draft?.reviewItemId;
  if (!id) return null;
  try {
    const item = await deps.getItem(id);
    if (item.status !== "pending" && item.status !== "escalated") return isDraftReviewStatus(item.status) ? item.status : null;
    const context = { ...reputationSystemContext(input.organizationId, input.propertyId), ...(input.userId ? { userId: input.userId } : {}) };
    const correlationId = input.correlationId ?? `corr_review_${id}`;
    const decided =
      input.decision === "approved"
        ? await deps.approve({ context, id, ...(input.notes ? { notes: input.notes } : {}), correlationId })
        : await deps.reject({ context, id, reason: input.notes ?? REVIEW_DRAFT_SUPERSEDED_REASON, correlationId });
    return isDraftReviewStatus(decided.status) ? decided.status : null;
  } catch (error) {
    console.warn("[reputation.draft] no se pudo cerrar el ítem HITL", { reviewId: input.reviewId, reviewItemId: id, decision: input.decision, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * 409 REVIEW_DRAFT_REJECTED si el texto que se va a publicar es el borrador cuyo
 * ítem HITL fue rechazado (texto distinto → pasa: la persona lo editó). Pensado
 * para el handler de POST /reputation/reviews/:id/respond (server.ts, mergeLine).
 */
export async function assertDraftPublishable(input: { db?: ReputationDb; reviewId: string; responseBody: string | null | undefined }): Promise<void> {
  const db = input.db ?? prisma;
  const row = await db.guestReview.findFirst({ where: { id: input.reviewId }, select: { topicsJson: true } });
  if (!row) return;
  const meta = getReviewMeta(row);
  if (!meta.draft?.reviewItemId || !meta.draft.body) return;
  const status = await readDraftReviewStatus({ db, meta });
  if (status !== "rejected") return;
  if (canonicalBody(input.responseBody) !== canonicalBody(meta.draft.body)) return;
  throw new ConflictError(REPUTATION_ERROR_MESSAGES_ES.REVIEW_DRAFT_REJECTED, { code: "REVIEW_DRAFT_REJECTED", reviewItemId: meta.draft.reviewItemId });
}

export type CreateReviewDraftInput = {
  db?: ReputationDb;
  context: UserContext;
  reviewId: string;
  propertyId: string;
  tone?: ResponseTone;
  /** Idioma del borrador; por defecto el de la reseña (`und` → español). */
  language?: string;
  correlationId: string;
  ai?: ReputationAiPort;
  now?: Date;
  deps?: ReviewDraftDeps;
};

function sentimentOf(value: string | null | undefined, score10: number | null): Sentiment {
  const fromScore = sentimentBucket(score10);
  if (fromScore) return fromScore;
  return value === "positive" || value === "negative" || value === "neutral" ? value : "neutral";
}

/**
 * Genera el borrador, lo guarda en la meta, lo encola en revisión humana y
 * registra telemetría y auditoría. Devuelve ReviewDraftResult
 * (`requiresHumanReview: true` siempre).
 */
export async function createReviewDraft(input: CreateReviewDraftInput): Promise<ReviewDraftResult> {
  const db = input.db ?? prisma;
  const ai = input.ai ?? getReputationAiPort();
  const now = input.now ?? new Date();
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const description = ai.describe();

  requirePermissions(input.context, ["reputation.respond"]);
  if (description.configured) requirePermissions(input.context, ["ai.tool.execute"]);

  const row = await db.guestReview.findFirst({ where: { id: input.reviewId, propertyId: input.propertyId } });
  if (!row) throw new NotFoundError("Reseña no encontrada.");
  const meta = getReviewMeta(row);
  if (REVIEW_DRAFT_CLOSED_STATUSES.includes(meta.status)) {
    throw new ConflictError("Transición no permitida.", { code: "INVALID_TRANSITION", from: meta.status, to: "drafted" });
  }
  const property = await db.property.findFirst({ where: { id: input.propertyId }, select: { name: true } });
  const hotelName = property?.name?.trim() || "nuestro hotel";
  const score10 = scoreOfRow(row, meta);
  const sentiment = sentimentOf(row.sentiment, score10);
  const language = input.language?.trim() || row.language || "und";
  const extraNames = meta.authorDisplayName ? [meta.authorDisplayName] : [];
  const draftInput = {
    score10,
    sentiment,
    language,
    categories: meta.categories,
    ...(row.title ? { title: maskReviewForLlm(row.title, { extraNames }).masked } : {}),
    ...(row.body ? { body: maskReviewForLlm(row.body, { extraNames }).masked } : {}),
    hotelName,
    ...(input.tone ? { tone: input.tone } : {})
  };

  const startedAt = Date.now();
  let output: DraftResponseOutput;
  let errorMessage: string | undefined;
  try {
    output = await ai.draftResponse(draftInput);
    if (containsMaskPlaceholder(output.body)) {
      // Un marcador de máscara jamás llega al portal: se cae a la plantilla.
      errorMessage = "mask_placeholder_in_draft";
      output = buildRulesDraft(draftInput);
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    output = buildRulesDraft(draftInput);
  }

  const providerLabel = (() => {
    const base = baseProvider(row.source);
    return base ? REVIEW_PROVIDER_LABELS_ES[base] : row.source;
  })();

  // Un solo ítem pendiente por reseña: el anterior (si sigue abierto) se rechaza como sustituido.
  if (meta.draft?.reviewItemId) {
    await resolveReviewDraftItem({ db, meta, reviewId: row.id, organizationId: input.context.organizationId, propertyId: input.propertyId, userId: input.context.userId, decision: "rejected", notes: REVIEW_DRAFT_SUPERSEDED_REASON, correlationId: input.correlationId, deps });
  }

  const reviewItem = await deps.enqueue({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    reviewType: REVIEW_DRAFT_REVIEW_TYPE,
    relatedEntityType: "guest_review",
    relatedEntityId: row.id,
    payloadJson: {
      draft: output.body,
      source: output.source,
      score10,
      sourceName: providerLabel,
      language: output.language,
      ...(output.model ? { model: output.model } : {}),
      hotelName
    },
    correlationId: input.correlationId,
    actorUserId: input.context.userId
  });

  await patchReviewMeta({
    db,
    id: row.id,
    patch: (current) => ({
      draft: { body: output.body, source: output.source, ...(output.model ? { model: output.model } : {}), draftedAt: now, reviewItemId: reviewItem.id },
      ...(current.status === "new" || current.status === "assigned" ? { status: "drafted" as const } : {})
    })
  });

  await deps
    .toolCall({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      userId: input.context.userId,
      toolName: REVIEW_DRAFT_TOOL_NAME,
      status: errorMessage ? "failed" : "completed",
      requiredConfirmation: true,
      automationLevel: "suggest_and_confirm",
      inputJson: { reviewId: row.id, tone: input.tone ?? null, language },
      outputJson: { source: output.source, reviewItemId: reviewItem.id },
      ...(output.model ? { model: output.model } : {}),
      latencyMs: Date.now() - startedAt,
      ...(errorMessage ? { errorMessage } : {})
    })
    .catch((err: unknown) =>
      console.warn("[ai.telemetry] insert failed", {
        toolName: REVIEW_DRAFT_TOOL_NAME,
        reviewId: row.id,
        correlationId: input.correlationId,
        error: err instanceof Error ? err.message : String(err)
      })
    );

  deps.audit({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: output.source === "ai" ? "ai" : "user",
    action: "ReviewResponseDrafted",
    entityType: "guest_review",
    entityId: row.id,
    afterJson: { source: output.source, language: output.language, reviewItemId: reviewItem.id, ...(output.model ? { model: output.model } : {}) },
    correlationId: input.correlationId
  });

  return {
    draft: output.body,
    source: output.source,
    provider: description.provider,
    requiresHumanReview: true,
    reviewItemId: reviewItem.id,
    ...(output.model ? { model: output.model } : {}),
    language: output.language
  };
}
