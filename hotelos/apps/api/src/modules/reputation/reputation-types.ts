// Reputación · Tanda T8 · lote T8-A — tipos, constantes y funciones puras del
// módulo de reseñas (apps/api/src/modules/reputation/reputation-types.ts).
//
// Reglas del fichero:
//   · solo tipos, vocabularios cerrados, umbrales, DTOs de cable y helpers
//     puros: sin Prisma, sin variables de entorno, sin lib/*, sin red;
//   · el bloque SHARED-BEGIN…SHARED-END es byte a byte idéntico al de
//     apps/admin-web/src/services/reputation-contracts.ts (espejo del
//     navegador sin dependencias); reputation-types.test.mts lo pina;
//   · la forma tipada de GuestReview.topicsJson (ReviewMeta v1) y de
//     ReviewSource.configJson (ReviewSourceConfig v1) vive aquí hasta que el
//     parche T8-L0 (docs/design/olas/T8-SCHEMA-PATCH.md) añada las columnas;
//   · las credenciales NUNCA van en configJson (integrations.service.ts:193-195):
//     readSourceConfig/writeSourceConfig solo copian claves conocidas y
//     hasCredentialKeys() permite rechazarlas en la entrada.
//
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/reputation-types.test.mts

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
// [E] Servidor: forma tipada de los JSON existentes (GuestReview.topicsJson y
//     ReviewSource.configJson) con lectura tolerante y escritura plana
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;
type DateLike = string | Date;

/** ReviewMeta v1: lo que guarda `GuestReview.topicsJson` mientras no existan las columnas de T8-L0. */
export type ReviewMeta = {
  v: typeof REPUTATION_META_VERSION;
  score10: number | null;
  ratingRaw: number | null;
  ratingScaleMax: number | null;
  /** sha256 del contenido normalizado (idempotencia del colector). */
  contentHash: string;
  sourceId?: string;
  sourceMode: ReviewSourceMode;
  authorDisplayName?: string;
  authorCountry?: string;
  portalUrl?: string;
  bodyComplete: boolean;
  status: ReviewStatus;
  assignedUserId?: string;
  slaTargetAt?: string;
  replyCapability: boolean;
  categories: CategoryMention[];
  analysis: ReviewAnalysis;
  draft?: ReviewDraft;
  response?: ReviewResponseMeta;
  qualityCaseId?: string;
  bodyPurgedAt?: string;
  /** Materializado por el tick; el valor vivo lo da isReviewOverdue(). */
  overdue?: boolean;
  isDemo?: boolean;
};

/** Entrada laxa de writeReviewMeta: parcial, admite Date en las fechas. */
export type ReviewMetaInput = Partial<Omit<ReviewMeta, "slaTargetAt" | "bodyPurgedAt" | "categories" | "analysis" | "draft">> & {
  slaTargetAt?: DateLike | null;
  bodyPurgedAt?: DateLike | null;
  categories?: ReadonlyArray<Partial<CategoryMention>>;
  analysis?: Partial<Omit<ReviewAnalysis, "analyzedAt">> & { analyzedAt?: DateLike | null };
  draft?: (Partial<Omit<ReviewDraft, "draftedAt">> & { draftedAt?: DateLike | null }) | null;
};

/** ReviewSourceConfig v1: lo que guarda `ReviewSource.configJson` (sin credenciales). */
export type ReviewSourceConfig = {
  v: typeof REPUTATION_META_VERSION;
  mode: ReviewSourceMode;
  displayName: string;
  /** 0,1-2 (1 por defecto). */
  weight: number;
  retentionDays: number;
  externalLocationId?: string;
  externalAccountId?: string;
  capabilities: ReviewSourceCapabilities;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  /** Cursor del colector (pageToken, since…); nunca tokens de acceso. */
  cursor?: Record<string, unknown>;
  runs: ReviewSourceRunSummary[];
  isDemo?: boolean;
};

/** Entrada laxa de writeSourceConfig. */
export type ReviewSourceConfigInput = Partial<Omit<ReviewSourceConfig, "lastRunAt" | "lastSuccessAt" | "capabilities" | "runs">> & {
  lastRunAt?: DateLike | null;
  lastSuccessAt?: DateLike | null;
  capabilities?: Partial<ReviewSourceCapabilities>;
  runs?: ReadonlyArray<Partial<Omit<ReviewSourceRunSummary, "startedAt" | "finishedAt">> & { startedAt?: DateLike; finishedAt?: DateLike }>;
};

/** Modo por defecto de cada proveedor. */
export const DEFAULT_SOURCE_MODE: Readonly<Record<ReviewProvider, ReviewSourceMode>> = Object.freeze({
  google: "api",
  booking: "api",
  expedia: "api",
  tripadvisor: "email",
  holidaycheck: "email",
  csv: "csv",
  email: "email",
  demo: "demo"
});

/**
 * Capacidades declaradas por adaptador (lo que la vía oficial permite, no si
 * está conectada): Google responde por API; Booking/Expedia solo vía partner
 * de conectividad; Tripadvisor/HolidayCheck solo llegan por correo y no
 * traen el texto completo; CSV y demo traen texto completo sin respuesta.
 */
export const DEFAULT_SOURCE_CAPABILITIES: Readonly<Record<ReviewProvider, ReviewSourceCapabilities>> = Object.freeze({
  google: Object.freeze({ fetch: true, reply: true, fullText: true, categories: false }),
  booking: Object.freeze({ fetch: true, reply: true, fullText: true, categories: true }),
  expedia: Object.freeze({ fetch: true, reply: true, fullText: true, categories: false }),
  tripadvisor: Object.freeze({ fetch: false, reply: false, fullText: false, categories: false }),
  holidaycheck: Object.freeze({ fetch: false, reply: false, fullText: false, categories: false }),
  csv: Object.freeze({ fetch: false, reply: false, fullText: true, categories: false }),
  email: Object.freeze({ fetch: false, reply: false, fullText: false, categories: false }),
  demo: Object.freeze({ fetch: true, reply: false, fullText: true, categories: true })
});

const NO_CAPABILITIES: ReviewSourceCapabilities = Object.freeze({ fetch: false, reply: false, fullText: false, categories: false });

/** Claves que jamás pueden viajar en configJson (van a credentialsJson cifrado, parche T8-L0). */
export const REVIEW_SOURCE_FORBIDDEN_CONFIG_KEYS = Object.freeze([
  "credentials",
  "credentialsJson",
  "accessToken",
  "refreshToken",
  "apiKey",
  "clientSecret",
  "password",
  "secret",
  "token"
] as const);

const FORBIDDEN_KEY_PATTERN = /(credential|secret|password|apikey|api_key|access_?token|refresh_?token|id_?token|auth_?token|bearer|^token$)/i;

/** Claves de credenciales presentes en un JSON de configuración (primer nivel y `cursor`). */
export function hasCredentialKeys(json: unknown): string[] {
  const record = asRecord(json);
  if (!record) return [];
  const found: string[] = [];
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) found.push(key);
  }
  const cursor = asRecord(record.cursor);
  if (cursor) {
    for (const key of Object.keys(cursor)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) found.push(`cursor.${key}`);
    }
  }
  return found;
}

// --- lectura tolerante ------------------------------------------------------

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asIso(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "string" && value.trim()) return Number.isFinite(Date.parse(value)) ? value.trim() : undefined;
  return undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asCount(value: unknown): number {
  const parsed = asNumber(value);
  return parsed === null || parsed < 0 ? 0 : Math.floor(parsed);
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function readCategoryMention(value: unknown): CategoryMention | null {
  const record = asRecord(value);
  if (!record || !isReviewCategory(record.category)) return null;
  const sentimentRaw = asNumber(record.sentiment);
  const sentiment: -1 | 0 | 1 = sentimentRaw === null ? 0 : sentimentRaw > 0 ? 1 : sentimentRaw < 0 ? -1 : 0;
  const confidenceRaw = asNumber(record.confidence);
  const snippet = asText(record.snippet);
  return {
    category: record.category,
    sentiment,
    confidence: confidenceRaw === null ? 0 : clamp(confidenceRaw, 0, 1),
    ...(snippet ? { snippet: snippet.slice(0, 160) } : {}),
    source: oneOf(ANALYSIS_SOURCES, record.source, "none")
  };
}

function readAnalysis(value: unknown): ReviewAnalysis {
  const record = asRecord(value);
  if (!record) return { status: "pending", source: "none" };
  const analyzedAt = asIso(record.analyzedAt);
  const note = asText(record.note);
  const summary = asText(record.summary);
  return {
    status: oneOf(ANALYSIS_STATUSES, record.status, "pending"),
    source: oneOf(ANALYSIS_SOURCES, record.source, "none"),
    ...(analyzedAt ? { analyzedAt } : {}),
    ...(note ? { note } : {}),
    ...(summary ? { summary: summary.slice(0, 200) } : {})
  };
}

function readDraft(value: unknown): ReviewDraft | undefined {
  const record = asRecord(value);
  const body = record ? asText(record.body) : undefined;
  if (!record || !body) return undefined;
  const model = asText(record.model);
  const reviewItemId = asText(record.reviewItemId);
  return {
    body,
    source: record.source === "ai" ? "ai" : "rules",
    ...(model ? { model } : {}),
    draftedAt: asIso(record.draftedAt) ?? new Date(0).toISOString(),
    ...(reviewItemId ? { reviewItemId } : {})
  };
}

function readResponseMeta(value: unknown): ReviewResponseMeta | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const externalState = asText(record.externalState);
  return { source: record.source === "api" ? "api" : "manual", ...(externalState ? { externalState } : {}) };
}

/**
 * Lee `GuestReview.topicsJson` como ReviewMeta v1 rellenando defaults sin
 * lanzar nunca: `{}`, `null`, basura o versiones futuras devuelven una meta
 * válida (status `new`, categorías `[]`, análisis pendiente/none).
 */
export function readReviewMeta(json: unknown): ReviewMeta {
  const record = asRecord(json) ?? {};
  const score10 = asNumber(record.score10);
  const ratingScaleMax = asNumber(record.ratingScaleMax);
  const sourceId = asText(record.sourceId);
  const authorDisplayName = asText(record.authorDisplayName);
  const authorCountry = asText(record.authorCountry);
  const portalUrl = asText(record.portalUrl);
  const assignedUserId = asText(record.assignedUserId);
  const slaTargetAt = asIso(record.slaTargetAt);
  const qualityCaseId = asText(record.qualityCaseId);
  const bodyPurgedAt = asIso(record.bodyPurgedAt);
  const draft = readDraft(record.draft);
  const response = readResponseMeta(record.response);
  const categories = Array.isArray(record.categories)
    ? record.categories.map(readCategoryMention).filter((mention): mention is CategoryMention => mention !== null)
    : [];
  return {
    v: REPUTATION_META_VERSION,
    score10: score10 === null ? null : clamp(score10, 0, 10),
    ratingRaw: asNumber(record.ratingRaw),
    ratingScaleMax: ratingScaleMax !== null && ratingScaleMax > 0 ? ratingScaleMax : null,
    contentHash: asText(record.contentHash) ?? "",
    ...(sourceId ? { sourceId } : {}),
    sourceMode: oneOf(REVIEW_SOURCE_MODES, record.sourceMode, "manual"),
    ...(authorDisplayName ? { authorDisplayName } : {}),
    ...(authorCountry ? { authorCountry } : {}),
    ...(portalUrl ? { portalUrl } : {}),
    bodyComplete: asBool(record.bodyComplete, true),
    status: oneOf(REVIEW_STATUSES, record.status, "new"),
    ...(assignedUserId ? { assignedUserId } : {}),
    ...(slaTargetAt ? { slaTargetAt } : {}),
    replyCapability: asBool(record.replyCapability, false),
    categories,
    analysis: readAnalysis(record.analysis),
    ...(draft ? { draft } : {}),
    ...(response ? { response } : {}),
    ...(qualityCaseId ? { qualityCaseId } : {}),
    ...(bodyPurgedAt ? { bodyPurgedAt } : {}),
    ...(typeof record.overdue === "boolean" ? { overdue: record.overdue } : {}),
    ...(typeof record.isDemo === "boolean" ? { isDemo: record.isDemo } : {})
  };
}

function readRun(value: unknown): ReviewSourceRunSummary | null {
  const record = asRecord(value);
  const id = record ? asText(record.id) : undefined;
  const startedAt = record ? asIso(record.startedAt) : undefined;
  if (!record || !id || !startedAt) return null;
  const error = asText(record.error);
  return {
    id,
    trigger: oneOf(REVIEW_SOURCE_RUN_TRIGGERS, record.trigger, "manual"),
    status: oneOf(REVIEW_SOURCE_RUN_STATUSES, record.status, "completed"),
    startedAt,
    finishedAt: asIso(record.finishedAt) ?? startedAt,
    fetched: asCount(record.fetched),
    created: asCount(record.created),
    updated: asCount(record.updated),
    unchanged: asCount(record.unchanged),
    purged: asCount(record.purged),
    ...(error ? { error: error.slice(0, 500) } : {}),
    correlationId: asText(record.correlationId) ?? ""
  };
}

function readCapabilities(value: unknown, defaults: ReviewSourceCapabilities): ReviewSourceCapabilities {
  const record = asRecord(value);
  if (!record) return { ...defaults };
  return {
    fetch: asBool(record.fetch, defaults.fetch),
    reply: asBool(record.reply, defaults.reply),
    fullText: asBool(record.fullText, defaults.fullText),
    categories: asBool(record.categories, defaults.categories)
  };
}

function readCursor(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const cursor: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (FORBIDDEN_KEY_PATTERN.test(key) || entry === undefined) continue;
    cursor[key] = entry;
  }
  return Object.keys(cursor).length > 0 ? cursor : undefined;
}

/** Proveedor base de un código de fuente (`google_demo` → `google`). */
export function baseProvider(provider: string): ReviewProvider | null {
  const code = provider.trim().toLowerCase().replace(/_demo$/, "");
  return isReviewProvider(code) ? code : null;
}

/**
 * Lee `ReviewSource.configJson` como ReviewSourceConfig v1 rellenando los
 * defaults del proveedor (modo, nombre, capacidades, retención: 30 días en
 * Google y 730 en el resto) sin lanzar. Solo copia claves conocidas: cualquier
 * credencial que alguien hubiera colado desaparece al releer.
 */
export function readSourceConfig(json: unknown, provider: string): ReviewSourceConfig {
  const record = asRecord(json) ?? {};
  const base = baseProvider(provider);
  const defaultRetention = base === "google" ? RETENTION_DAYS_GOOGLE : RETENTION_DAYS_DEFAULT;
  const retentionRaw = asNumber(record.retentionDays);
  const retentionDays = retentionRaw === null || retentionRaw < 1 ? defaultRetention : Math.floor(retentionRaw);
  const weightRaw = asNumber(record.weight);
  const externalLocationId = asText(record.externalLocationId);
  const externalAccountId = asText(record.externalAccountId);
  const lastRunAt = asIso(record.lastRunAt);
  const lastSuccessAt = asIso(record.lastSuccessAt);
  const lastError = asText(record.lastError);
  const cursor = readCursor(record.cursor);
  const runs = (Array.isArray(record.runs) ? record.runs : [])
    .map(readRun)
    .filter((run): run is ReviewSourceRunSummary => run !== null)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, RUN_HISTORY_LIMIT);
  const isDemo = typeof record.isDemo === "boolean" ? record.isDemo : provider.trim().toLowerCase().endsWith("_demo") || base === "demo";
  return {
    v: REPUTATION_META_VERSION,
    mode: oneOf(REVIEW_SOURCE_MODES, record.mode, base ? DEFAULT_SOURCE_MODE[base] : "manual"),
    displayName: asText(record.displayName) ?? (base ? REVIEW_PROVIDER_LABELS_ES[base] : provider),
    weight: weightRaw === null ? SOURCE_WEIGHT_DEFAULT : clamp(weightRaw, SOURCE_WEIGHT_MIN, SOURCE_WEIGHT_MAX),
    retentionDays: base === "google" ? Math.min(retentionDays, RETENTION_DAYS_GOOGLE) : retentionDays,
    ...(externalLocationId ? { externalLocationId } : {}),
    ...(externalAccountId ? { externalAccountId } : {}),
    capabilities: readCapabilities(record.capabilities, base ? DEFAULT_SOURCE_CAPABILITIES[base] : NO_CAPABILITIES),
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(lastError ? { lastError: lastError.slice(0, 500) } : {}),
    ...(cursor ? { cursor } : {}),
    runs,
    ...(isDemo ? { isDemo: true } : {})
  };
}

// --- escritura plana ----------------------------------------------------------

/** Convierte a JSON plano: sin `undefined`, sin Date (ISO), sin NaN/Infinity (null). */
function toPlainJson(value: unknown): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map(toPlainJson).filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    const out: JsonRecord = {};
    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      const plain = toPlainJson(entry);
      if (plain !== undefined) out[key] = plain;
    }
    return out;
  }
  return value;
}

/** ReviewMeta → objeto JSON plano listo para `topicsJson` (defaults rellenos, fechas ISO, sin undefined). */
export function writeReviewMeta(meta: ReviewMetaInput | ReviewMeta): JsonRecord {
  return toPlainJson(readReviewMeta(meta)) as JsonRecord;
}

/** ReviewSourceConfig → objeto JSON plano listo para `configJson` (nunca con credenciales). */
export function writeSourceConfig(config: ReviewSourceConfigInput | ReviewSourceConfig, provider: string): JsonRecord {
  return toPlainJson(readSourceConfig(config, provider)) as JsonRecord;
}

/**
 * Añade una ejecución al historial (la más reciente primero, ≤ RUN_HISTORY_LIMIT)
 * y actualiza lastRunAt / lastSuccessAt / lastError. Función pura: no muta.
 * Solo `completed` avanza lastSuccessAt (y limpia lastError); `partial` y
 * `failed` conservan el lastSuccessAt anterior y guardan el motivo en lastError,
 * así la siguiente vuelta vuelve a pedir desde la última ejecución completa.
 */
export function appendSourceRun(config: ReviewSourceConfig, run: ReviewSourceRunSummary): ReviewSourceConfig {
  const runs = [run, ...config.runs.filter((existing) => existing.id !== run.id)].slice(0, RUN_HISTORY_LIMIT);
  const next: ReviewSourceConfig = { ...config, runs, lastRunAt: run.finishedAt };
  if (run.status === "completed") {
    next.lastSuccessAt = run.finishedAt;
    delete next.lastError;
  } else if (run.status === "failed" || run.status === "partial") {
    next.lastError = run.error ?? (run.status === "partial" ? "Lectura parcial de la fuente." : "Error desconocido");
  }
  return next;
}
