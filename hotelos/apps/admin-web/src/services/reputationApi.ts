// Reputación y reseñas (Tanda T8 · lote T8-G). Cliente tipado de
// apps/api/src/modules/reputation/reputation.routes.ts (las 12 rutas nuevas
// de T8-D) y de las rutas del motor genérico que las pantallas ya usaban,
// sobre los contratos de services/reputation-contracts.ts (bloque compartido
// con la API; patrón de services/pmsShadowApi.ts). Toda petición pasa por
// apiRequest (services/api-client.ts): JWT, cabecera x-property-id de la
// propiedad activa (activePropertyHeader) y el 401 compartido.
//
//   GET    /dashboards/reputation?propertyId=&days=                fetchReputationDashboard        analytics.read
//   GET    /reputation/properties/:propertyId/inbox?envelope=1     listReviewInbox                 reputation.read
//   GET    /reputation/reviews/:id                                 getReviewDetail                 reputation.read
//   PATCH  /reputation/reviews/:id                                 patchReview                     reputation.respond
//   POST   /reputation/reviews/:id/draft                           draftReviewResponse (201)       reputation.respond
//   POST   /reputation/reviews/:id/quality-case                    createQualityCaseFromReview (201) quality_cases.manage
//   POST   /reputation/reviews/:id/respond {responseBody}          respondReview                   reputation.respond (motor genérico, server.ts)
//   GET    /reputation/properties/:propertyId/sources              listReviewSources               reputation.read
//   POST   /reputation/properties/:propertyId/sources              createReviewSource (201)        reputation.respond
//   PATCH  /reputation/properties/:propertyId/sources/:id          updateReviewSource              reputation.respond
//   DELETE /reputation/properties/:propertyId/sources/:id          disableReviewSource (baja lógica) reputation.respond
//   POST   /reputation/properties/:propertyId/sources/:id/sync     syncReviewSource                reputation.respond
//   GET    /reputation/properties/:propertyId/runs                 listReviewSourceRuns            reputation.read
//   POST   /reputation/properties/:propertyId/imports              importReviews (201)             reputation.respond
//   GET    /quality/properties/:propertyId/cases?envelope=1        listQualityCases                quality_cases.read (motor genérico)
//   POST   /quality/properties/:propertyId/cases                   createQualityCase               quality_cases.manage (motor genérico)
//   PATCH  /quality/cases/:id                                      updateQualityCase               quality_cases.manage (motor genérico)
//   GET    /surveys/properties/:propertyId?envelope=1              listSurveys                     surveys.read (motor genérico)
//   POST   /surveys/properties/:propertyId                         createSurvey                    surveys.manage (motor genérico)
//   POST   /surveys/:id/responses                                  createSurveyResponse            surveys.read (motor genérico; surveyId lo inyecta el handler)
//
// El fichero CSV viaja SIEMPRE como `contentBase64` (la API decodifica y
// parsea). Las consultas espejan los esquemas zod `.strict()` de
// schemas/reputation.schemas.ts: booleanos "1"/"0", limit 1-100 (bandeja) /
// 1-50 (ejecuciones). Los errores llegan como details.code (REVIEW_* /
// REPUTATION_*) y se leen con reputationErrorMessage; nunca se envían
// credenciales en la configuración de una fuente (la API responde 400
// REVIEW_SOURCE_CREDENTIALS_IN_CONFIG).

import { getActivePropertyId } from "./activeProperty";
import { apiRequest } from "./api-client";
import {
  compactReputationQuery,
  reputationDashboardQuery,
  reputationErrorCode,
  reputationErrorDetails,
  reputationErrorMessage,
  reputationErrorStatus,
  runsQuery,
  type ImportResult,
  type ReputationDashboardDto,
  type ReputationQuery,
  type ReviewCategory,
  type ReviewDetail,
  type ReviewDraftResult,
  type ReviewInboxItem,
  type ReviewProvider,
  type ReviewSourceDto,
  type ReviewSourceMode,
  type ReviewSourceRunDto,
  type ReviewStatus,
  type Sentiment
} from "./reputation-contracts";

export { reputationErrorCode, reputationErrorDetails, reputationErrorMessage, reputationErrorStatus };
export type { ImportResult, ReputationDashboardDto, ReviewDetail, ReviewDraftResult, ReviewInboxItem, ReviewSourceDto, ReviewSourceRunDto } from "./reputation-contracts";

const enc = encodeURIComponent;

/** Base de las rutas por propiedad. */
export function reputationPropertyPath(propertyId: string = getActivePropertyId()): string {
  return `/reputation/properties/${enc(propertyId)}`;
}

// ---------------------------------------------------------------------------
// Envelope de paginación (lib/pagination.ts: `?envelope=1` → { items, nextCursor, total })
// ---------------------------------------------------------------------------

export type ReputationPage<T> = { items: T[]; nextCursor: string | null; total: number };

/** Fila del motor genérico (advanced-record-store.ts · BoardItem): casos de calidad, encuestas y respuestas. */
export type AdvancedRecordItem<Payload extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  propertyId: string;
  moduleCode: string;
  entityType: string;
  status: string;
  payload: Payload;
  createdAt: string;
  updatedAt: string;
};

export type QualityCasePayload = {
  title?: string;
  caseType?: string;
  priority?: string;
  description?: string;
  ownerUserId?: string;
  slaTargetAt?: string;
  rootCause?: string;
  reservationId?: string;
  guestId?: string;
  roomId?: string;
  resolvedAt?: string;
};
export type QualityCaseItem = AdvancedRecordItem<QualityCasePayload>;

export type SurveyPayload = { name?: string; surveyType?: string; questions?: unknown[]; active?: boolean };
export type SurveyItem = AdvancedRecordItem<SurveyPayload>;

export type SurveyResponsePayload = { surveyId?: string; reservationId?: string; guestId?: string; answers?: Record<string, unknown>; score?: number };
export type SurveyResponseItem = AdvancedRecordItem<SurveyResponsePayload>;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** `GET /dashboards/reputation` (propiedad activa por defecto; `days` 1-365). */
export function fetchReputationDashboard(input: { propertyId?: string | null; days?: number | null } = {}): Promise<ReputationDashboardDto> {
  return apiRequest<ReputationDashboardDto>("/dashboards/reputation", { query: reputationDashboardQuery(input) });
}

// ---------------------------------------------------------------------------
// Bandeja y reseña
// ---------------------------------------------------------------------------

/** Filtros de `GET …/inbox` (InboxQuerySchema): vacíos fuera, booleanos "1"/"0". */
export type ReviewInboxQuery = {
  status?: ReviewStatus | "";
  source?: string;
  minScore?: number;
  maxScore?: number;
  category?: ReviewCategory | "";
  language?: string;
  sentiment?: Sentiment | "";
  responded?: boolean | "1" | "0";
  overdue?: boolean | "1" | "0";
  assignedUserId?: string;
  limit?: number;
  cursor?: string | null;
};

function flag(value: boolean | "1" | "0" | undefined): "1" | "0" | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value === "0") return value;
  return value ? "1" : "0";
}

/** Query serializada de la bandeja (espejo del esquema de la ruta). */
export function reviewInboxQuery(input: ReviewInboxQuery = {}): ReputationQuery {
  return compactReputationQuery({
    status: input.status,
    source: input.source,
    minScore: input.minScore,
    maxScore: input.maxScore,
    category: input.category,
    language: input.language,
    sentiment: input.sentiment,
    responded: flag(input.responded),
    overdue: flag(input.overdue),
    assignedUserId: input.assignedUserId,
    limit: typeof input.limit === "number" ? Math.min(100, Math.max(1, Math.round(input.limit))) : undefined,
    cursor: input.cursor ?? undefined
  });
}

/** `GET /reputation/properties/:propertyId/inbox?envelope=1` → envelope { items, nextCursor, total } (sin `envelope=1` la ruta devuelve el array plano: regla de compatibilidad de L2). */
export function listReviewInbox(input: ReviewInboxQuery = {}, propertyId: string = getActivePropertyId()): Promise<ReputationPage<ReviewInboxItem>> {
  return apiRequest<ReputationPage<ReviewInboxItem>>(`${reputationPropertyPath(propertyId)}/inbox`, { query: { ...reviewInboxQuery(input), envelope: "1" } });
}

/** `GET /reputation/reviews/:id` (la API resuelve la propiedad de la fila; 404 opaco fuera del ámbito). */
export function getReviewDetail(reviewId: string): Promise<ReviewDetail> {
  return apiRequest<ReviewDetail>(`/reputation/reviews/${enc(reviewId)}`);
}

/** Cuerpo de `PATCH /reputation/reviews/:id` (ReviewPatchSchema): estado / responsable / plazo / metadatos; nunca responseBody. */
export type ReviewPatchBody = {
  status?: ReviewStatus;
  assignedUserId?: string | null;
  slaTargetAt?: string | null;
  responseSource?: "api" | "manual";
  responseExternalState?: string;
  publish?: boolean;
};

export function patchReview(reviewId: string, body: ReviewPatchBody): Promise<ReviewDetail> {
  return apiRequest<ReviewDetail>(`/reputation/reviews/${enc(reviewId)}`, { method: "PATCH", body });
}

/** Cuerpo de `POST …/draft` (DraftSchema). */
export type ReviewDraftBody = { tone?: "cordial" | "formal" | "breve"; language?: string };

/** `POST /reputation/reviews/:id/draft` (201): borrador con revisión humana; aprobar en HITL nunca publica. */
export function draftReviewResponse(reviewId: string, body: ReviewDraftBody = {}): Promise<ReviewDraftResult> {
  return apiRequest<ReviewDraftResult>(`/reputation/reviews/${enc(reviewId)}/draft`, { method: "POST", body });
}

/** Cuerpo de `POST …/quality-case` (QualityCaseFromReviewSchema). */
export type QualityCaseFromReviewBody = { priority?: "low" | "normal" | "high" | "urgent"; ownerUserId?: string; slaTargetAt?: string; title?: string };

/** Respuesta de `POST …/quality-case`: la fila QualityCase con `reviewId`. */
export type QualityCaseRecord = {
  id: string;
  propertyId: string;
  reviewId: string;
  caseType: string;
  priority: string | null;
  status: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  slaTargetAt: string | null;
  rootCause: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

/** `POST /reputation/reviews/:id/quality-case` (201; 409 QUALITY_CASE_ALREADY_LINKED si ya tiene caso). */
export function createQualityCaseFromReview(reviewId: string, body: QualityCaseFromReviewBody = {}): Promise<QualityCaseRecord> {
  return apiRequest<QualityCaseRecord>(`/reputation/reviews/${enc(reviewId)}/quality-case`, { method: "POST", body });
}

/** Fila que devuelve el motor genérico al publicar (advanced-record-store.ts · reviewItem). */
export type RespondedReviewRecord = {
  id: string;
  propertyId: string;
  status: "responded" | "pending";
  responseBody: string | null;
  respondedAt: string | null;
};

/** `POST /reputation/reviews/:id/respond {responseBody}` (motor genérico): una sola vez; 409 «La reseña ya tiene respuesta.». */
export function respondReview(reviewId: string, responseBody: string): Promise<RespondedReviewRecord> {
  return apiRequest<RespondedReviewRecord>(`/reputation/reviews/${enc(reviewId)}/respond`, { method: "POST", body: { responseBody } });
}

// ---------------------------------------------------------------------------
// Fuentes, ejecuciones e importación
// ---------------------------------------------------------------------------

/** `GET …/sources` (sin las desactivadas salvo includeDisabled). */
export function listReviewSources(input: { includeDisabled?: boolean } = {}, propertyId: string = getActivePropertyId()): Promise<ReviewSourceDto[]> {
  return apiRequest<ReviewSourceDto[]>(`${reputationPropertyPath(propertyId)}/sources`, {
    query: compactReputationQuery({ includeDisabled: input.includeDisabled ? "1" : undefined })
  });
}

/** Cuerpo de `POST …/sources` (SourceCreateSchema): nunca credenciales. */
export type ReviewSourceCreateBody = {
  provider: ReviewProvider;
  mode?: ReviewSourceMode;
  displayName?: string;
  weight?: number;
  retentionDays?: number;
  externalLocationId?: string;
  externalAccountId?: string;
  isDemo?: boolean;
};

export function createReviewSource(body: ReviewSourceCreateBody, propertyId: string = getActivePropertyId()): Promise<ReviewSourceDto> {
  return apiRequest<ReviewSourceDto>(`${reputationPropertyPath(propertyId)}/sources`, { method: "POST", body });
}

/** Cuerpo de `PATCH …/sources/:id` (SourceUpdateSchema). */
export type ReviewSourceUpdateBody = {
  mode?: ReviewSourceMode;
  displayName?: string;
  weight?: number;
  retentionDays?: number;
  externalLocationId?: string | null;
  externalAccountId?: string | null;
  enabled?: boolean;
};

export function updateReviewSource(sourceId: string, body: ReviewSourceUpdateBody, propertyId: string = getActivePropertyId()): Promise<ReviewSourceDto> {
  return apiRequest<ReviewSourceDto>(`${reputationPropertyPath(propertyId)}/sources/${enc(sourceId)}`, { method: "PATCH", body });
}

/** `DELETE …/sources/:id`: baja lógica (status `disabled`), nunca borra filas. */
export function disableReviewSource(sourceId: string, propertyId: string = getActivePropertyId()): Promise<ReviewSourceDto> {
  return apiRequest<ReviewSourceDto>(`${reputationPropertyPath(propertyId)}/sources/${enc(sourceId)}`, { method: "DELETE" });
}

/** Respuesta de `POST …/sources/:id/sync`. */
export type ReviewSourceSyncResult = {
  run: ReviewSourceRunDto;
  summary: { propertyId: string; correlationId: string; skipped: boolean; skipReason?: string; fetched: number; created: number; updated: number; unchanged: number; purged: number; analyzed: number; failed: number; casesOpened: number };
};

export function syncReviewSource(sourceId: string, propertyId: string = getActivePropertyId()): Promise<ReviewSourceSyncResult> {
  return apiRequest<ReviewSourceSyncResult>(`${reputationPropertyPath(propertyId)}/sources/${enc(sourceId)}/sync`, { method: "POST" });
}

/** `GET …/runs?limit=&sourceId=` (1-50, las más recientes primero). */
export function listReviewSourceRuns(input: { limit?: number | null; sourceId?: string | null } = {}, propertyId: string = getActivePropertyId()): Promise<ReviewSourceRunDto[]> {
  return apiRequest<ReviewSourceRunDto[]>(`${reputationPropertyPath(propertyId)}/runs`, { query: runsQuery(input) });
}

/** Cuerpo de `POST …/imports` (ImportSchema): el CSV en base64 O filas JSON, nunca ambos. */
export type ReviewImportBody = {
  source: ReviewProvider;
  scaleMax?: number;
  sourceId?: string;
  fileName?: string;
  contentBase64?: string;
  rows?: Array<Record<string, unknown>>;
};

/** `POST /reputation/properties/:propertyId/imports` (201 ImportResult; 400 REVIEW_IMPORT_INVALID con `reason`). */
export function importReviews(body: ReviewImportBody, propertyId: string = getActivePropertyId()): Promise<ImportResult> {
  return apiRequest<ImportResult>(`${reputationPropertyPath(propertyId)}/imports`, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Casos de calidad y encuestas (motor genérico, server.ts)
// ---------------------------------------------------------------------------

const ENVELOPE_QUERY: ReputationQuery = { envelope: "1", limit: 100 };

/** `GET /quality/properties/:propertyId/cases?envelope=1`. */
export function listQualityCases(propertyId: string = getActivePropertyId()): Promise<ReputationPage<QualityCaseItem>> {
  return apiRequest<ReputationPage<QualityCaseItem>>(`/quality/properties/${enc(propertyId)}/cases`, { query: ENVELOPE_QUERY });
}

/** Cuerpo de `POST /quality/properties/:propertyId/cases` (QualityCaseCreateSchema). */
export type QualityCaseCreateBody = {
  title: string;
  caseType?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  description?: string;
  reservationId?: string;
  guestId?: string;
  roomId?: string;
  ownerUserId?: string;
  slaTargetAt?: string;
  rootCause?: string;
};

export function createQualityCase(body: QualityCaseCreateBody, propertyId: string = getActivePropertyId()): Promise<QualityCaseItem> {
  return apiRequest<QualityCaseItem>(`/quality/properties/${enc(propertyId)}/cases`, { method: "POST", body });
}

/** Cuerpo de `PATCH /quality/cases/:id` (QualityCaseUpdateSchema): transición y campos editables. */
export type QualityCaseUpdateBody = {
  status?: "open" | "in_progress" | "resolved" | "closed";
  priority?: "low" | "normal" | "high" | "urgent";
  title?: string;
  description?: string;
  rootCause?: string;
  ownerUserId?: string;
  resolvedAt?: string;
};

export function updateQualityCase(caseId: string, body: QualityCaseUpdateBody): Promise<QualityCaseItem> {
  return apiRequest<QualityCaseItem>(`/quality/cases/${enc(caseId)}`, { method: "PATCH", body });
}

/** `GET /surveys/properties/:propertyId?envelope=1`. */
export function listSurveys(propertyId: string = getActivePropertyId()): Promise<ReputationPage<SurveyItem>> {
  return apiRequest<ReputationPage<SurveyItem>>(`/surveys/properties/${enc(propertyId)}`, { query: ENVELOPE_QUERY });
}

/** Cuerpo de `POST /surveys/properties/:propertyId` (SurveyCreateSchema). */
export type SurveyCreateBody = {
  name: string;
  surveyType?: "post_stay" | "in_stay" | "pre_arrival" | "event" | "other";
  questions?: Array<Record<string, unknown>>;
  active?: boolean;
};

export function createSurvey(body: SurveyCreateBody, propertyId: string = getActivePropertyId()): Promise<SurveyItem> {
  return apiRequest<SurveyItem>(`/surveys/properties/${enc(propertyId)}`, { method: "POST", body });
}

/** Cuerpo de `POST /surveys/:id/responses` (SurveyResponseCreateSchema sin `surveyId`: lo inyecta el handler desde el path). */
export type SurveyResponseCreateBody = {
  reservationId?: string;
  guestId?: string;
  score?: number;
  answers?: Record<string, unknown>;
};

export function createSurveyResponse(surveyId: string, body: SurveyResponseCreateBody): Promise<SurveyResponseItem> {
  return apiRequest<SurveyResponseItem>(`/surveys/${enc(surveyId)}/responses`, { method: "POST", body });
}
