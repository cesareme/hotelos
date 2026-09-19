// Reputación · Tanda T8 · lote T8-A — contratos de reseñas para el navegador
// (apps/admin-web/src/services/reputation-contracts.ts).
//
// Espejo de apps/api/src/modules/reputation/reputation-types.ts para las
// pantallas y reputationApi.ts, con el patrón de finance-contracts.ts: sin red,
// sin React, sin `meta` de Vite, y AUTOCONTENIDO (cero dependencias: los tipos
// viven en apps/api, no en @hotelos/shared). El bloque SHARED-BEGIN…SHARED-END
// es byte a byte idéntico al del fichero de la API y lo pina
// apps/api/src/modules/reputation/__tests__/reputation-types.test.mts; la
// parte [F] (mensajes de error, builders de query, etiquetas y copys) la pina
// services/__tests__/reputation-contracts.test.mts.
//
// Test (desde apps/api, con TSX_TSCONFIG_PATH=../admin-web/tsconfig.json y el cargador tsx): node --test ../admin-web/src/services/__tests__/reputation-contracts.test.mts

// ===== SHARED-BEGIN (bloque idéntico en apps/api reputation-types.ts y apps/admin-web reputation-contracts.ts; lo pina reputation-types.test.mts) =====

// ---------------------------------------------------------------------------
// [A] Vocabularios cerrados y etiquetas en español
// ---------------------------------------------------------------------------

/** Versión de la forma tipada guardada en GuestReview.topicsJson y ReviewSource.configJson. */
export const REPUTATION_META_VERSION = 1 as const;

/** Las 12 categorías fijas del análisis semántico (docs/design/REPUTACION-REVIEWS.md §4.5). */
export const REVIEW_CATEGORIES = Object.freeze([
  "limpieza",
  "habitacion",
  "personal",
  "desayuno",
  "restauracion",
  "ubicacion",
  "precio_valor",
  "instalaciones",
  "ruido",
  "wifi",
  "recepcion_checkin",
  "mantenimiento"
] as const);
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export const REVIEW_CATEGORY_LABELS_ES: Readonly<Record<ReviewCategory, string>> = Object.freeze({
  limpieza: "Limpieza",
  habitacion: "Habitación",
  personal: "Personal",
  desayuno: "Desayuno",
  restauracion: "Restauración",
  ubicacion: "Ubicación",
  precio_valor: "Relación calidad-precio",
  instalaciones: "Instalaciones",
  ruido: "Ruido",
  wifi: "Wifi",
  recepcion_checkin: "Recepción y llegada",
  mantenimiento: "Mantenimiento"
});

/** Proveedores de reseñas: portales con vía oficial, vías sin credenciales (csv, email) y demo ficticia. */
export const REVIEW_PROVIDERS = Object.freeze([
  "google",
  "booking",
  "expedia",
  "tripadvisor",
  "holidaycheck",
  "csv",
  "email",
  "demo"
] as const);
export type ReviewProvider = (typeof REVIEW_PROVIDERS)[number];

export const REVIEW_PROVIDER_LABELS_ES: Readonly<Record<ReviewProvider, string>> = Object.freeze({
  google: "Google",
  booking: "Booking.com",
  expedia: "Expedia",
  tripadvisor: "Tripadvisor",
  holidaycheck: "HolidayCheck",
  csv: "Importación CSV",
  email: "Correo de notificación",
  demo: "Demo (datos ficticios)"
});

/**
 * Escala máxima de la nota que publica cada portal. `null` = la escala viaja
 * en cada fila (`ratingScaleMax`): el CSV la declara por columna y el correo
 * o la demo la fijan al normalizar.
 */
export const REVIEW_PROVIDER_SCALES: Readonly<Record<ReviewProvider, number | null>> = Object.freeze({
  google: 5,
  tripadvisor: 5,
  expedia: 5,
  booking: 10,
  holidaycheck: 6,
  csv: null,
  email: null,
  demo: null
});

export const REVIEW_SOURCE_MODES = Object.freeze(["api", "email", "csv", "manual", "demo"] as const);
export type ReviewSourceMode = (typeof REVIEW_SOURCE_MODES)[number];
export const REVIEW_SOURCE_MODE_LABELS_ES: Readonly<Record<ReviewSourceMode, string>> = Object.freeze({
  api: "API oficial",
  email: "Correo de notificación",
  csv: "Importación CSV",
  manual: "Manual",
  demo: "Demo"
});

export const REVIEW_SOURCE_STATUSES = Object.freeze(["pending", "connected", "degraded", "error", "disabled", "unavailable"] as const);
export type ReviewSourceStatus = (typeof REVIEW_SOURCE_STATUSES)[number];
export const REVIEW_SOURCE_STATUS_LABELS_ES: Readonly<Record<ReviewSourceStatus, string>> = Object.freeze({
  pending: "Pendiente de autorizar",
  connected: "Conectada",
  degraded: "Degradada",
  error: "Con error",
  disabled: "Desactivada",
  unavailable: "Sin conexión disponible"
});

export const REVIEW_STATUSES = Object.freeze(["new", "assigned", "drafted", "responded", "closed", "ignored"] as const);
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_LABELS_ES: Readonly<Record<ReviewStatus, string>> = Object.freeze({
  new: "Nueva",
  assigned: "Asignada",
  drafted: "Con borrador",
  responded: "Respondida",
  closed: "Cerrada",
  ignored: "Ignorada"
});

/** Estados de la bandeja que todavía cuentan para el plazo de respuesta. */
export const REVIEW_OPEN_STATUSES = Object.freeze(["new", "assigned", "drafted"] as const);

export const SENTIMENTS = Object.freeze(["positive", "neutral", "negative"] as const);
export type Sentiment = (typeof SENTIMENTS)[number];
export const SENTIMENT_LABELS_ES: Readonly<Record<Sentiment, string>> = Object.freeze({
  positive: "Positiva",
  neutral: "Neutra",
  negative: "Negativa"
});

export const ANALYSIS_SOURCES = Object.freeze(["llm", "dictionary", "portal_subscore", "none"] as const);
export type AnalysisSource = (typeof ANALYSIS_SOURCES)[number];
export const ANALYSIS_SOURCE_LABELS_ES: Readonly<Record<AnalysisSource, string>> = Object.freeze({
  llm: "Análisis con IA",
  dictionary: "Análisis por diccionario · IA no configurada",
  portal_subscore: "Subpuntuaciones del portal",
  none: "Sin análisis"
});

export const ANALYSIS_STATUSES = Object.freeze(["pending", "done", "failed"] as const);
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const REPUTATION_INDEX_STATUSES = Object.freeze(["ok", "insufficient", "no_reviews", "no_sources", "module_off"] as const);
export type ReputationIndexStatus = (typeof REPUTATION_INDEX_STATUSES)[number];

export const TREND_DIRECTIONS = Object.freeze(["up", "flat", "down"] as const);
export type TrendDirection = (typeof TREND_DIRECTIONS)[number];
export const TREND_DIRECTION_LABELS_ES: Readonly<Record<TrendDirection, string>> = Object.freeze({
  up: "Mejora",
  flat: "Estable",
  down: "Empeora"
});

export const REVIEW_SOURCE_RUN_TRIGGERS = Object.freeze(["scheduler", "manual", "import"] as const);
export type ReviewSourceRunTrigger = (typeof REVIEW_SOURCE_RUN_TRIGGERS)[number];
/**
 * `partial`: el colector devolvió ítems pero cortó antes de terminar (cuota, 5xx a
 * mitad de paginación, tope de páginas): lo leído se guarda, lastSuccessAt NO
 * avanza y lastError conserva el motivo (la siguiente vuelta repite la ventana).
 */
export const REVIEW_SOURCE_RUN_STATUSES = Object.freeze(["completed", "partial", "failed", "skipped"] as const);
export type ReviewSourceRunStatus = (typeof REVIEW_SOURCE_RUN_STATUSES)[number];

export const REPUTATION_TONES = Object.freeze(["success", "warning", "danger"] as const);
export type ReputationTone = (typeof REPUTATION_TONES)[number];

// ---------------------------------------------------------------------------
// [A2] Umbrales (recon T8 §6 #6: semáforo 8,5/6,0 sobre 10 y 85/70 sobre 100)
// ---------------------------------------------------------------------------

/** score10 ≥ 8,5 → positiva. */
export const SCORE10_POSITIVE = 8.5;
/** score10 < 6,0 → negativa (entre ambos, neutra). */
export const SCORE10_NEGATIVE = 6.0;
/** Índice (0-100) ≥ 85 → success. */
export const INDEX_GOOD = 85;
/** Índice (0-100) ≥ 70 → warning; por debajo, danger. */
export const INDEX_WARN = 70;
/** Reseñas mínimas en la ventana para calcular el índice; si no, `insufficient`. */
export const INDEX_MIN_REVIEWS = 10;
/** Ventanas del índice en días. */
export const INDEX_WINDOWS = Object.freeze([30, 90, 365] as const);
export type ReputationIndexWindow = (typeof INDEX_WINDOWS)[number];
/** Tope de peso de un solo portal sobre el total (60 %). */
export const SOURCE_WEIGHT_CAP = 0.6;
/** Banda ±1,0 puntos dentro de la cual la tendencia es `flat`. */
export const TREND_BAND = 1.0;
/** Plazo de respuesta por tramo de sentimiento, en horas. */
export const SLA_HOURS: Readonly<Record<Sentiment, number>> = Object.freeze({ negative: 48, neutral: 72, positive: 96 });
/** Retención por defecto del texto de la reseña, en días. */
export const RETENTION_DAYS_DEFAULT = 730;
/** Google Business Profile: caché de contenido como máximo 30 días. */
export const RETENTION_DAYS_GOOGLE = 30;
/** Ejecuciones conservadas por fuente en `ReviewSourceConfig.runs`. */
export const RUN_HISTORY_LIMIT = 20;
/** Peso editable por fuente (0,1-2; 1 por defecto). */
export const SOURCE_WEIGHT_MIN = 0.1;
export const SOURCE_WEIGHT_MAX = 2;
export const SOURCE_WEIGHT_DEFAULT = 1;
/** Paginación de la bandeja. */
export const INBOX_LIMIT_DEFAULT = 25;
export const INBOX_LIMIT_MAX = 100;
/** Ejecuciones listadas por `GET …/runs`. */
export const RUNS_LIMIT_MAX = 50;

/** Todos los umbrales en un solo objeto (paridad API ↔ front en los tests). */
export const REPUTATION_THRESHOLDS = Object.freeze({
  SCORE10_POSITIVE,
  SCORE10_NEGATIVE,
  INDEX_GOOD,
  INDEX_WARN,
  INDEX_MIN_REVIEWS,
  INDEX_WINDOWS,
  SOURCE_WEIGHT_CAP,
  TREND_BAND,
  SLA_HOURS,
  RETENTION_DAYS_DEFAULT,
  RETENTION_DAYS_GOOGLE,
  RUN_HISTORY_LIMIT,
  SOURCE_WEIGHT_MIN,
  SOURCE_WEIGHT_MAX,
  SOURCE_WEIGHT_DEFAULT,
  INBOX_LIMIT_DEFAULT,
  INBOX_LIMIT_MAX,
  RUNS_LIMIT_MAX
});

// ---------------------------------------------------------------------------
// [B] Tipos de dominio compartidos y DTOs de la API (todo serializable: fechas ISO)
// ---------------------------------------------------------------------------

/** Mención de una categoría dentro de una reseña. */
export type CategoryMention = {
  category: ReviewCategory;
  /** −1 negativa · 0 neutra · +1 positiva. */
  sentiment: -1 | 0 | 1;
  /** Confianza 0-1. */
  confidence: number;
  /** Fragmento ≤ 160 caracteres que justifica la mención. */
  snippet?: string;
  source: AnalysisSource;
};

/** Estado del análisis semántico de una reseña. */
export type ReviewAnalysis = {
  status: AnalysisStatus;
  source: AnalysisSource;
  analyzedAt?: string;
  /** Nota honesta (p. ej. `llm_invalid_json`, `llm_not_configured`). */
  note?: string;
  /** Resumen ≤ 200 caracteres. */
  summary?: string;
};

/** Borrador de respuesta pendiente de revisión humana. */
export type ReviewDraft = {
  body: string;
  source: "ai" | "rules";
  model?: string;
  draftedAt: string;
  /** Ítem HITL `review_response` asociado. */
  reviewItemId?: string;
};

/** Estado del ítem HITL `review_response` asociado al borrador (ai_human_review_items.status). */
export const REVIEW_DRAFT_REVIEW_STATUSES = Object.freeze(["pending", "approved", "rejected", "escalated"] as const);
export type ReviewDraftReviewStatus = (typeof REVIEW_DRAFT_REVIEW_STATUSES)[number];

/** Cómo se publicó la respuesta. */
export type ReviewResponseMeta = {
  source: "api" | "manual";
  /** Estado devuelto por el portal (p. ej. `published`, `pending_moderation`). */
  externalState?: string;
};

/** Capacidades declaradas por el adaptador de una fuente (no su estado de conexión). */
export type ReviewSourceCapabilities = {
  fetch: boolean;
  reply: boolean;
  fullText: boolean;
  categories: boolean;
};

/** Resumen de una ejecución del colector (≤ RUN_HISTORY_LIMIT por fuente, la más reciente primero). */
export type ReviewSourceRunSummary = {
  id: string;
  trigger: ReviewSourceRunTrigger;
  status: ReviewSourceRunStatus;
  startedAt: string;
  finishedAt: string;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  purged: number;
  error?: string;
  correlationId: string;
};

/** Fila de la bandeja (`GET /reputation/properties/:propertyId/reviews`). */
export type ReviewInboxItem = {
  id: string;
  propertyId: string;
  /** `GuestReview.source`: código del proveedor (sufijo `_demo` en la demo). */
  provider: string;
  sourceId: string | null;
  sourceMode: ReviewSourceMode;
  score10: number | null;
  ratingRaw: number | null;
  ratingScaleMax: number | null;
  sentiment: Sentiment | null;
  title: string | null;
  /** Primeros ≤ 160 caracteres del cuerpo. */
  excerpt: string | null;
  bodyComplete: boolean;
  bodyPurged: boolean;
  language: string | null;
  authorDisplayName: string | null;
  authorCountry: string | null;
  portalUrl: string | null;
  receivedAt: string | null;
  respondedAt: string | null;
  createdAt: string;
  status: ReviewStatus;
  assignedUserId: string | null;
  slaTargetAt: string | null;
  overdue: boolean;
  replyCapability: boolean;
  categories: CategoryMention[];
  analysisStatus: AnalysisStatus;
  analysisSource: AnalysisSource;
  hasDraft: boolean;
  qualityCaseId: string | null;
  isDemo: boolean;
};

/** Detalle (`GET /reputation/reviews/:id`). */
export type ReviewDetail = ReviewInboxItem & {
  body: string | null;
  responseBody: string | null;
  summary: string | null;
  analysis: ReviewAnalysis;
  draft: ReviewDraft | null;
  /** Estado vivo del ítem HITL del borrador (`null` sin borrador o sin ítem); `rejected` bloquea publicar ese texto. */
  draftReviewStatus: ReviewDraftReviewStatus | null;
  response: ReviewResponseMeta | null;
  reservationId: string | null;
  guestId: string | null;
  contentHash: string;
  bodyPurgedAt: string | null;
};

/** Ejecución de una fuente en el cable. */
export type ReviewSourceRunDto = ReviewSourceRunSummary & {
  sourceId: string;
  provider: string;
};

/** Fuente de reseñas en el cable: NUNCA lleva credenciales, solo `hasCredentials`. */
export type ReviewSourceDto = {
  id: string;
  propertyId: string;
  provider: string;
  mode: ReviewSourceMode;
  status: ReviewSourceStatus;
  displayName: string;
  weight: number;
  retentionDays: number;
  externalLocationId: string | null;
  externalAccountId: string | null;
  capabilities: ReviewSourceCapabilities;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  hasCredentials: boolean;
  runs: ReviewSourceRunDto[];
  isDemo: boolean;
  createdAt: string;
};

export type ReputationIndexBySource = {
  provider: string;
  count: number;
  /** Media simple de score10 de la fuente (sin recencia ni tope). */
  avg10: number | null;
  /** Σw de la fuente / Σw total después del tope del 60 %. */
  weightShare: number;
};

export type ReputationCategoryImpact = {
  category: ReviewCategory;
  mentions: number;
  negativeMentions: number;
  /** Puntos de índice que resta la categoría (≥ 0). */
  impact: number;
};

/** Resultado del índice de reputación para una ventana. */
export type ReputationIndexResult = {
  status: ReputationIndexStatus;
  windowDays: number;
  /** 0-100 con 1 decimal; solo con `status: "ok"`. */
  index?: number;
  reviewCount: number;
  trendDelta?: number;
  trendDirection?: TrendDirection;
  bySource: ReputationIndexBySource[];
  categoryImpact: ReputationCategoryImpact[];
  /** Respondidas / respondibles en la ventana (0-100). */
  responseRatePct?: number;
  medianResponseHours?: number;
  computedAt?: string;
  /** Días desde la última materialización disponible (0 = hoy). */
  staleDays?: number;
};

/** Contrato vigente de `/dashboards/reputation` (dashboards/reputation.service.ts:3-22), conservado íntegro. */
export type ReputationDashboardLegacy = {
  kpis: {
    avgRating: number;
    reviewsLast7d: number;
    reviewsLast30d: number;
    pendingResponses: number;
    sentimentScore: number;
  };
  ratingDistribution: { star1: number; star2: number; star3: number; star4: number; star5: number };
  reviewsBySource: Array<{ sourceName: string; count: number; avgRating: number }>;
  recentReviews: Array<{
    id: string;
    sourceName: string;
    ratingValue?: number;
    title?: string;
    body?: string;
    createdAt: string;
    respondedAt?: string;
  }>;
};

/** Distribución de score10 en cinco tramos (0-2 · 2-4 · 4-6 · 6-8 · 8-10). */
export type ReputationScoreDistribution = { b0_2: number; b2_4: number; b4_6: number; b6_8: number; b8_10: number };

/** `/dashboards/reputation` ampliado de forma aditiva. */
export type ReputationDashboardDto = ReputationDashboardLegacy & {
  status: ReputationIndexStatus;
  /** Índice a 30 días. */
  index: ReputationIndexResult;
  /** Un resultado por ventana de INDEX_WINDOWS. */
  indexByWindow: ReputationIndexResult[];
  scoreDistribution: ReputationScoreDistribution;
  sources: ReviewSourceDto[];
  categories: ReputationCategoryImpact[];
  inbox: { open: number; overdue: number; drafted: number; unassigned: number };
  /** KPI que cayeron a su valor por defecto en esta respuesta. */
  degraded: string[];
};

/** Bloque `reputationIndex` del panel del director (aditivo sobre `reputation`). */
export type GmReputationIndex = {
  status: ReputationIndexStatus;
  index30?: number;
  trendDelta?: number;
  reviewCount30: number;
  responseRatePct?: number;
  npsLast30?: number;
  sourcesConnected: number;
  staleDays?: number;
};

/** Respuesta de `POST /reputation/reviews/:id/draft`: siempre pasa por revisión humana. */
export type ReviewDraftResult = {
  draft: string;
  source: "ai" | "rules";
  /** Nombre del proveedor de IA o `none`. */
  provider: string;
  requiresHumanReview: true;
  reviewItemId?: string;
  model?: string;
  language?: string;
};

/** Resultado de `POST /reputation/properties/:propertyId/imports`. */
export type ImportResult = {
  created: number;
  updated: number;
  duplicates: number;
  invalid: Array<{ row: number; reason: string }>;
  total: number;
  sourceId?: string;
  correlationId?: string;
};

/** Resumen de un tick de sincronización por propiedad. */
export type ReputationSyncSummary = {
  propertyId: string;
  correlationId: string;
  startedAt: string;
  finishedAt: string;
  skipped: boolean;
  skipReason?: "lock" | "module_off" | "no_sources" | "disabled";
  sources: number;
  runs: ReviewSourceRunDto[];
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  purged: number;
  analyzed: number;
  failed: number;
  casesOpened: number;
  indexRecomputed: boolean;
};

// ---------------------------------------------------------------------------
// [C] Errores tipados (details.code) y frases en español
// ---------------------------------------------------------------------------

export const REPUTATION_ERROR_CODES = Object.freeze([
  "REVIEW_SOURCE_UNAVAILABLE",
  "REVIEW_SOURCE_NOT_AUTHORIZED",
  "REVIEW_NOT_REPLYABLE",
  "REVIEW_IMPORT_INVALID",
  "REVIEW_IMPORT_DUPLICATE",
  "REPUTATION_INSUFFICIENT_DATA",
  "REVIEW_ALREADY_RESPONDED",
  "INVALID_TRANSITION",
  "REPUTATION_SYNC_BUSY",
  "REVIEW_DRAFT_REJECTED"
] as const);
export type ReputationErrorCode = (typeof REPUTATION_ERROR_CODES)[number];

export const REPUTATION_ERROR_MESSAGES_ES: Readonly<Record<ReputationErrorCode, string>> = Object.freeze({
  REVIEW_SOURCE_UNAVAILABLE: "La fuente de reseñas no está disponible: el portal no ofrece acceso oficial o la conexión no está configurada.",
  REVIEW_SOURCE_NOT_AUTHORIZED: "La fuente de reseñas no está autorizada: vuelve a autorizar el acceso al portal.",
  REVIEW_NOT_REPLYABLE: "Esta reseña no admite respuesta desde aquí: copia el texto y publícalo en el portal.",
  REVIEW_IMPORT_INVALID: "El fichero de importación no es válido: comprueba las columnas y las filas marcadas.",
  REVIEW_IMPORT_DUPLICATE: "Todas las reseñas del fichero ya existían: no se ha importado ninguna.",
  REPUTATION_INSUFFICIENT_DATA: "No hay reseñas suficientes en la ventana para calcular el índice (mínimo 10).",
  REVIEW_ALREADY_RESPONDED: "La reseña ya tiene respuesta.",
  INVALID_TRANSITION: "El cambio de estado no está permitido desde el estado actual.",
  REPUTATION_SYNC_BUSY: "Hay una sincronización o importación de reseñas en curso en esta propiedad: inténtalo de nuevo en unos minutos.",
  REVIEW_DRAFT_REJECTED: "El borrador fue rechazado en revisión humana: edita el texto antes de publicarlo."
});

export const REPUTATION_ERROR_FALLBACK_ES = "No se pudo completar la operación de reputación.";

// ---------------------------------------------------------------------------
// [D] Helpers puros: tramos, plazos, tonos, guardas de tipo
// ---------------------------------------------------------------------------

export function isReviewCategory(value: unknown): value is ReviewCategory {
  return typeof value === "string" && (REVIEW_CATEGORIES as readonly string[]).includes(value);
}

export function isReviewProvider(value: unknown): value is ReviewProvider {
  return typeof value === "string" && (REVIEW_PROVIDERS as readonly string[]).includes(value);
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && (REVIEW_STATUSES as readonly string[]).includes(value);
}

export function isReviewSourceStatus(value: unknown): value is ReviewSourceStatus {
  return typeof value === "string" && (REVIEW_SOURCE_STATUSES as readonly string[]).includes(value);
}

export function isReputationErrorCode(value: unknown): value is ReputationErrorCode {
  return typeof value === "string" && (REPUTATION_ERROR_CODES as readonly string[]).includes(value);
}

/** Escala máxima que publica el proveedor, o `null` si viaja por fila. */
export function providerScaleMax(provider: string): number | null {
  return isReviewProvider(provider) ? REVIEW_PROVIDER_SCALES[provider] : null;
}

/** Tramo de sentimiento por nota sobre 10; `null` sin nota. */
export function sentimentBucket(score10: number | null | undefined): Sentiment | null {
  if (typeof score10 !== "number" || !Number.isFinite(score10)) return null;
  if (score10 >= SCORE10_POSITIVE) return "positive";
  if (score10 < SCORE10_NEGATIVE) return "negative";
  return "neutral";
}

/** Horas de plazo para responder según el tramo (sin tramo → neutro, 72 h). */
export function slaHoursFor(bucket: Sentiment | null | undefined): number {
  return bucket ? SLA_HOURS[bucket] : SLA_HOURS.neutral;
}

/** Fecha límite ISO de respuesta a partir de la recepción y la nota; `null` si la fecha no es válida. */
export function slaTargetFor(receivedAt: string | Date, score10: number | null | undefined): string | null {
  const start = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt);
  if (!Number.isFinite(start)) return null;
  return new Date(start + slaHoursFor(sentimentBucket(score10)) * 3_600_000).toISOString();
}

/** Una reseña está fuera de plazo si sigue abierta y su `slaTargetAt` ya pasó. */
export function isReviewOverdue(input: { status: ReviewStatus; slaTargetAt?: string | null }, now: Date = new Date()): boolean {
  if (!(REVIEW_OPEN_STATUSES as readonly string[]).includes(input.status)) return false;
  if (!input.slaTargetAt) return false;
  const target = Date.parse(input.slaTargetAt);
  return Number.isFinite(target) && target < now.getTime();
}

/** Tono del índice 0-100: ≥ 85 success · ≥ 70 warning · < 70 danger. */
export function indexTone(index: number): ReputationTone {
  if (index >= INDEX_GOOD) return "success";
  if (index >= INDEX_WARN) return "warning";
  return "danger";
}

/** Tono de una nota sobre 10: ≥ 8,5 success · ≥ 6,0 warning · < 6,0 danger. */
export function scoreTone(score10: number): ReputationTone {
  if (score10 >= SCORE10_POSITIVE) return "success";
  if (score10 >= SCORE10_NEGATIVE) return "warning";
  return "danger";
}

/** Dirección de la tendencia con banda ±TREND_BAND; `null` sin dato. */
export function trendDirectionFor(delta: number | null | undefined): TrendDirection | null {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return null;
  if (delta > TREND_BAND) return "up";
  if (delta < -TREND_BAND) return "down";
  return "flat";
}

// ===== SHARED-END =====

// ---------------------------------------------------------------------------
// [F] Navegador: errores, query builders, etiquetas y copys
// ---------------------------------------------------------------------------

/** Forma de query aceptada por apiRequest. */
export type ReputationQuery = Record<string, string | number | undefined>;

type ErrorLike = { message?: unknown; details?: unknown; status?: unknown };

function asErrorLike(error: unknown): ErrorLike | null {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : null;
}

/** `details` de un 4xx tipado (ApiError o cualquier `{ details: { code } }`), o null. */
export function reputationErrorDetails(error: unknown): Record<string, unknown> | null {
  const details = asErrorLike(error)?.details;
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : null;
}

/** `details.code` de un 4xx tipado, o null. */
export function reputationErrorCode(error: unknown): string | null {
  const code = reputationErrorDetails(error)?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export function hasReputationErrorCode(error: unknown, code: ReputationErrorCode): boolean {
  return reputationErrorCode(error) === code;
}

/** HTTP status de un error tipo ApiError, o null. */
export function reputationErrorStatus(error: unknown): number | null {
  const status = asErrorLike(error)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Frase en español de un error de reputación: primero `details.code`
 * (REPUTATION_INSUFFICIENT_DATA añade el recuento si la API lo manda), luego
 * el `message` de la API, y si no, el fallback.
 */
export function reputationErrorMessage(error: unknown, fallback: string = REPUTATION_ERROR_FALLBACK_ES): string {
  const code = reputationErrorCode(error);
  if (code && isReputationErrorCode(code)) {
    const base = REPUTATION_ERROR_MESSAGES_ES[code];
    if (code === "REPUTATION_INSUFFICIENT_DATA") {
      const count = reputationErrorDetails(error)?.reviewCount;
      return typeof count === "number" && Number.isFinite(count) ? `${base} Hay ${reviewCountText(count)} en la ventana.` : base;
    }
    return base;
  }
  const message = asErrorLike(error)?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

// --- query builders (espejan los esquemas zod de reputation.routes.ts) ----------

/** Quita vacíos/null/undefined y serializa booleanos como "1"/"0". */
export function compactReputationQuery(input: Record<string, string | number | boolean | null | undefined>): ReputationQuery {
  const out: ReputationQuery = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = typeof value === "boolean" ? (value ? "1" : "0") : typeof value === "string" ? value.trim() : value;
  }
  return out;
}

function clampInt(value: number | null | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampScore(value: number | string | null | undefined): number | undefined {
  const parsed = typeof value === "string" ? (value.trim() === "" ? Number.NaN : Number(value.replace(",", "."))) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return undefined;
  return Math.min(10, Math.max(0, parsed));
}

export type InboxQueryInput = {
  status?: ReviewStatus | "";
  source?: string;
  minScore?: number | string | null;
  maxScore?: number | string | null;
  category?: ReviewCategory | "";
  language?: string;
  responded?: boolean | null;
  cursor?: string | null;
  limit?: number | null;
};

/** `GET /reputation/properties/:propertyId/reviews?…` — vacíos fuera, booleanos "1"/"0", limit 1-100. */
export function inboxQuery(input: InboxQueryInput = {}): ReputationQuery {
  return compactReputationQuery({
    status: input.status,
    source: input.source,
    minScore: clampScore(input.minScore),
    maxScore: clampScore(input.maxScore),
    category: input.category,
    language: input.language ? input.language.trim().toLowerCase() : undefined,
    responded: typeof input.responded === "boolean" ? input.responded : undefined,
    cursor: input.cursor ?? undefined,
    limit: clampInt(input.limit, 1, INBOX_LIMIT_MAX)
  });
}

/** `GET /reputation/properties/:propertyId/runs?limit=` (1-50). */
export function runsQuery(input: { limit?: number | null; sourceId?: string | null } = {}): ReputationQuery {
  return compactReputationQuery({ limit: clampInt(input.limit, 1, RUNS_LIMIT_MAX), sourceId: input.sourceId ?? undefined });
}

/** `GET /reputation/properties/:propertyId/scores?windowDays=&from=&to=` (ventana 30/90/365). */
export function scoresQuery(input: { windowDays?: number | null; from?: string | null; to?: string | null } = {}): ReputationQuery {
  const windowDays = (INDEX_WINDOWS as readonly number[]).includes(input.windowDays ?? Number.NaN) ? input.windowDays ?? undefined : undefined;
  return compactReputationQuery({ windowDays, from: input.from ?? undefined, to: input.to ?? undefined });
}

/** `GET /dashboards/reputation?propertyId=&days=`. */
export function reputationDashboardQuery(input: { propertyId?: string | null; days?: number | null } = {}): ReputationQuery {
  return compactReputationQuery({ propertyId: input.propertyId ?? undefined, days: clampInt(input.days, 1, 365) });
}

// --- etiquetas y copys en español -----------------------------------------------

function labelOf(dictionary: Readonly<Record<string, string>>, code: string): string {
  return dictionary[code] ?? code;
}

/** Etiqueta del estado de bandeja (código desconocido → se devuelve tal cual). */
export function statusLabel(status: string): string {
  return labelOf(REVIEW_STATUS_LABELS_ES, status);
}

/** Etiqueta del proveedor; `google_demo` → «Google · demo». */
export function providerLabel(provider: string): string {
  const code = provider.trim().toLowerCase();
  if (code.endsWith("_demo")) {
    const base = code.slice(0, -"_demo".length);
    return `${labelOf(REVIEW_PROVIDER_LABELS_ES, base)} · demo`;
  }
  return labelOf(REVIEW_PROVIDER_LABELS_ES, code);
}

export function categoryLabel(category: string): string {
  return labelOf(REVIEW_CATEGORY_LABELS_ES, category);
}

export function sourceStatusLabel(status: string): string {
  return labelOf(REVIEW_SOURCE_STATUS_LABELS_ES, status);
}

export function sourceModeLabel(mode: string): string {
  return labelOf(REVIEW_SOURCE_MODE_LABELS_ES, mode);
}

export function sentimentLabel(sentiment: string | null | undefined): string {
  return sentiment ? labelOf(SENTIMENT_LABELS_ES, sentiment) : "Sin nota";
}

export function analysisSourceLabel(source: string): string {
  return labelOf(ANALYSIS_SOURCE_LABELS_ES, source);
}

export function trendLabel(direction: string | null | undefined): string {
  return direction ? labelOf(TREND_DIRECTION_LABELS_ES, direction) : "Sin tendencia";
}

/** «1 reseña» · «12 reseñas». */
export function reviewCountText(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return `${n} ${n === 1 ? "reseña" : "reseñas"}`;
}

/**
 * Copy del índice cuando no hay cifra que pintar; `null` con `status: "ok"`
 * (la pantalla pinta la figura).
 */
export function indexStatusCopy(input: { status: ReputationIndexStatus; reviewCount?: number | null }): string | null {
  switch (input.status) {
    case "no_sources":
      return "Sin fuentes configuradas";
    case "no_reviews":
      return "Sin reseñas en la ventana";
    case "insufficient":
      return `${reviewCountText(input.reviewCount ?? 0)} · insuficiente (mínimo ${INDEX_MIN_REVIEWS})`;
    case "module_off":
      return "Módulo no activado";
    default:
      return null;
  }
}

/** «datos de hace N días» a partir de `staleDays` (> 0); `null` si es de hoy. */
export function staleCopy(staleDays: number | null | undefined): string | null {
  if (typeof staleDays !== "number" || !Number.isFinite(staleDays) || staleDays <= 0) return null;
  const n = Math.floor(staleDays);
  return n === 1 ? "datos de ayer" : `datos de hace ${n} días`;
}

/** Nota sobre 10 con una decimal y coma («8,7»); «—» sin nota. */
export function formatScore10(score10: number | null | undefined): string {
  if (typeof score10 !== "number" || !Number.isFinite(score10)) return "—";
  return score10.toFixed(1).replace(".", ",");
}

/** Índice 0-100 con una decimal y coma («87,5»); «—» sin dato. */
export function formatIndex(index: number | null | undefined): string {
  if (typeof index !== "number" || !Number.isFinite(index)) return "—";
  return index.toFixed(1).replace(".", ",");
}

/** Delta de tendencia con signo («+2,3», «−1,0», «0,0»); «—» sin dato. */
export function formatTrendDelta(delta: number | null | undefined): string {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return "—";
  const text = Math.abs(delta).toFixed(1).replace(".", ",");
  return delta > 0 ? `+${text}` : delta < 0 ? `−${text}` : text;
}

/** Tono del tramo de sentimiento (para chips de la bandeja). */
export function sentimentTone(sentiment: Sentiment | null | undefined): ReputationTone | "neutral" {
  if (sentiment === "positive") return "success";
  if (sentiment === "negative") return "danger";
  if (sentiment === "neutral") return "warning";
  return "neutral";
}

/** Tono del estado de una fuente. */
export function sourceStatusTone(status: string): ReputationTone | "neutral" {
  switch (status) {
    case "connected":
      return "success";
    case "degraded":
    case "pending":
      return "warning";
    case "error":
    case "unavailable":
      return "danger";
    default:
      return "neutral";
  }
}
