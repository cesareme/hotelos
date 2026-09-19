// Reputación · Tanda T8 · lote T8-C — alertas por reseña negativa
// (apps/api/src/modules/reputation/review-alerts.service.ts).
//
// Una reseña con score10 < SCORE10_NEGATIVE (6,0) y sin `meta.qualityCaseId`
// abre UN caso de calidad `review_negative` (QualityCase, schema.prisma:1937-1957)
// y registra el evento de dominio `ReviewReceived` (audit.service.ts:293; el
// hook de notificaciones de event-hooks.service.ts:48-68 cae hoy en
// `default: return`, así que no hay template_not_found; el caso del hook es
// mergeLine del integrador) y la auditoría `ReviewReceived` (audit.service.ts:257,
// persiste por cola: flushAuditQueues). createCaseFromReview lo reutilizan el
// tick (reputation-sync.service.ts) y la ruta manual de T8-D.
//
// Reglas: `db` inyectable; auditoría y evento inyectables (deps) para los tests
// con stubs; sin variables de entorno; sin red; el texto que entra en el caso
// pasa por maskReviewForLlm (nunca e-mails, teléfonos ni nombres tras
// tratamiento en la descripción).

import { prisma } from "@hotelos/database";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { createId } from "../../lib/ids.js";
import { maskReviewForLlm } from "./mask-pii.js";
import { REVIEW_CATEGORY_LABELS_ES, REVIEW_PROVIDER_LABELS_ES, SCORE10_NEGATIVE, baseProvider, type ReviewMeta } from "./reputation-types.js";
import { getReviewMeta, patchReviewMeta, scoreOfRow, type GuestReviewRow, type ReputationDb } from "./review-meta.store.js";

export const REVIEW_ALERT_CASE_TYPE = "review_negative";
/** Por debajo de esta nota (sobre 10) la reseña abre un caso (= SCORE10_NEGATIVE). */
export const REVIEW_ALERT_SCORE_THRESHOLD = SCORE10_NEGATIVE;
/** Por debajo de esta nota el caso nace `urgent`; si no, `high`. */
export const REVIEW_ALERT_URGENT_THRESHOLD = 4;
/** Plazo del caso: 48 h desde su apertura. */
export const REVIEW_ALERT_SLA_HOURS = 48;
export const REVIEW_ALERT_DESCRIPTION_MAX = 300;

export type ReviewAlertDeps = {
  audit?: typeof recordAuditEvent;
  domainEvent?: typeof recordDomainEvent;
};

const defaultDeps: Required<ReviewAlertDeps> = { audit: recordAuditEvent, domainEvent: recordDomainEvent };

/** `true` si la reseña debe abrir un caso: nota conocida < 6 y sin caso previo (las ignoradas no alertan). */
export function shouldAlert(row: Pick<GuestReviewRow, "rating" | "topicsJson">, meta: ReviewMeta = getReviewMeta(row)): boolean {
  if (meta.qualityCaseId) return false;
  if (meta.status === "ignored") return false;
  const score10 = scoreOfRow(row, meta);
  return typeof score10 === "number" && score10 < REVIEW_ALERT_SCORE_THRESHOLD;
}

/** Etiqueta en español del proveedor (`booking_demo` → «Booking.com»). */
export function providerLabel(source: string): string {
  const base = baseProvider(source);
  return base ? REVIEW_PROVIDER_LABELS_ES[base] : source;
}

/** Título del caso: «Reseña negativa · Booking.com · 3,5/10». */
export function buildCaseTitle(source: string, score10: number): string {
  return `Reseña negativa · ${providerLabel(source)} · ${String(score10).replace(".", ",")}/10`;
}

/** Descripción: marcador `[reseña:<id>]` + resumen enmascarado (≤ 300 caracteres). */
export function buildCaseDescription(reviewId: string, meta: ReviewMeta, row: Pick<GuestReviewRow, "title" | "body">): string {
  const raw = meta.analysis.summary?.trim() || [row.title?.trim(), row.body?.trim()].filter((part): part is string => Boolean(part)).join(". ");
  const masked = maskReviewForLlm(raw).masked.replace(/\s+/g, " ").trim();
  const summary = masked.length > REVIEW_ALERT_DESCRIPTION_MAX ? `${masked.slice(0, REVIEW_ALERT_DESCRIPTION_MAX - 1)}…` : masked;
  return `[reseña:${reviewId}]\n${summary || "Sin texto disponible."}`;
}

/** Categoría negativa principal (mayor confianza) como causa raíz, o `null`. */
export function rootCauseOf(meta: ReviewMeta): string | null {
  const negative = meta.categories.filter((mention) => mention.sentiment < 0).sort((a, b) => b.confidence - a.confidence);
  const first = negative[0];
  return first ? REVIEW_CATEGORY_LABELS_ES[first.category] : null;
}

/** Lee `PropertyModule.configurationJson.reputation.defaultOwnerUserId` (schema.prisma:723-735). */
export function defaultOwnerFromConfiguration(configurationJson: unknown): string | null {
  if (!configurationJson || typeof configurationJson !== "object" || Array.isArray(configurationJson)) return null;
  const reputation = (configurationJson as Record<string, unknown>).reputation;
  if (!reputation || typeof reputation !== "object" || Array.isArray(reputation)) return null;
  const owner = (reputation as Record<string, unknown>).defaultOwnerUserId;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
}

export type CreateCaseFromReviewInput = {
  db?: ReputationDb;
  organizationId: string;
  propertyId: string;
  review: GuestReviewRow;
  now: Date;
  correlationId: string;
  /** Responsable por defecto (PropertyModule.configurationJson.reputation.defaultOwnerUserId). */
  defaultOwnerUserId?: string | null;
  /** Actor: el bot (`system`) o el usuario que fuerza la alerta desde la ruta. */
  actor?: { type: "system" | "user"; userId?: string };
  /** Fuerza la apertura aunque la nota no sea negativa (ruta manual de T8-D). */
  force?: boolean;
  deps?: ReviewAlertDeps;
};

export type CreateCaseFromReviewResult = {
  created: boolean;
  caseId: string | null;
  reason?: "already_linked" | "not_negative";
};

/**
 * Abre el caso `review_negative` de una reseña (una sola vez: `meta.qualityCaseId`
 * lo enlaza), lo asigna al responsable por defecto si lo hay (la reseña pasa a
 * `assigned`) y registra ReviewReceived (evento de dominio + auditoría).
 */
export async function createCaseFromReview(input: CreateCaseFromReviewInput): Promise<CreateCaseFromReviewResult> {
  const db = input.db ?? prisma;
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const row = input.review;
  const meta = getReviewMeta(row);
  if (meta.qualityCaseId) return { created: false, caseId: meta.qualityCaseId, reason: "already_linked" };
  const score10 = scoreOfRow(row, meta);
  if (!input.force && !shouldAlert(row, meta)) return { created: false, caseId: null, reason: "not_negative" };

  const effectiveScore = typeof score10 === "number" ? score10 : 0;
  const ownerUserId = input.defaultOwnerUserId ?? null;
  const qualityCase = await db.qualityCase.create({
    data: {
      propertyId: input.propertyId,
      ...(row.reservationId ? { reservationId: row.reservationId } : {}),
      ...(row.guestId ? { guestId: row.guestId } : {}),
      // T8-L0b fase 1: columna reviewId; el marcador `[reseña:<id>]` de la descripción se conserva.
      reviewId: row.id,
      caseType: REVIEW_ALERT_CASE_TYPE,
      priority: effectiveScore < REVIEW_ALERT_URGENT_THRESHOLD ? "urgent" : "high",
      status: "open",
      title: buildCaseTitle(row.source, effectiveScore),
      description: buildCaseDescription(row.id, meta, row),
      slaTargetAt: new Date(input.now.getTime() + REVIEW_ALERT_SLA_HOURS * 3_600_000),
      rootCause: rootCauseOf(meta),
      ownerUserId
    }
  });

  await patchReviewMeta({
    db,
    id: row.id,
    patch: (current) => ({
      qualityCaseId: qualityCase.id,
      ...(ownerUserId && current.status === "new" ? { status: "assigned", assignedUserId: ownerUserId } : {})
    })
  });

  const actorType = input.actor?.type ?? "system";
  deps.domainEvent({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    entityType: "guest_review",
    entityId: row.id,
    eventType: "ReviewReceived",
    payload: { score10: effectiveScore, source: row.source, negative: true, qualityCaseId: qualityCase.id },
    actorType,
    ...(input.actor?.userId ? { actorUserId: input.actor.userId } : {}),
    correlationId: input.correlationId
  });
  deps.audit({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    ...(input.actor?.userId ? { actorUserId: input.actor.userId } : {}),
    actorType,
    action: "ReviewReceived",
    entityType: "guest_review",
    entityId: row.id,
    afterJson: { score10: effectiveScore, source: row.source, negative: true, qualityCaseId: qualityCase.id, caseType: REVIEW_ALERT_CASE_TYPE },
    correlationId: input.correlationId
  });

  return { created: true, caseId: qualityCase.id };
}

/** Id de correlación de una tanda de alertas. */
export function newAlertCorrelationId(): string {
  return createId("corr");
}
