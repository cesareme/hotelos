// Reputación · Tanda T8 · lote T8-G — helpers PUROS de las pantallas de
// reputación (apps/admin-web/src/screens/operations/reputation/reputation-helpers.ts).
//
// Sin React, sin api-client, sin `import.meta`: solo los contratos de
// services/reputation-contracts.ts (bloque compartido con la API). Los copys
// que pintan ReputationDashboard, los drawers de reputación y la fila del
// índice del director (GeneralManagerScreen) viven aquí para que
// operations/__tests__/reputation-helpers.test.mts los pine con node --test
// (mismo patrón que pos-dashboard-summary.test.mts con posSummaryView.ts).
//
// Reglas honestas que fijan estos helpers:
//   · una fuente `unavailable`/`error` se lee «Sin conexión: <motivo>», nunca
//     un verde por defecto; `connected` dice cuándo corrió por última vez;
//   · el análisis dice de dónde sale: «IA», «Diccionario · IA no configurada»
//     o «Subpuntuaciones del portal»;
//   · el índice sin cifra explica por qué (sin fuentes, sin reseñas, mínimo 10,
//     módulo apagado) con el copy compartido indexStatusCopy;
//   · la publicación en el portal la hace una persona: el botón se llama
//     «Copiar y abrir portal» y la confirmación «Ya la he publicado en el portal»;
//   · la máquina de estados de la reseña y del caso se ESPEJA aquí solo para
//     ofrecer transiciones; la API sigue siendo quien valida (409 INVALID_TRANSITION).

import {
  INDEX_MIN_REVIEWS,
  REVIEW_PROVIDERS,
  REVIEW_SOURCE_MODES,
  REVIEW_STATUSES,
  analysisSourceLabel,
  formatIndex,
  formatTrendDelta,
  indexStatusCopy as sharedIndexStatusCopy,
  indexTone,
  isReviewStatus,
  providerLabel,
  reviewCountText,
  sourceModeLabel,
  sourceStatusLabel,
  staleCopy,
  trendDirectionFor,
  type ImportResult,
  type ReputationIndexStatus,
  type ReputationTone,
  type ReviewProvider,
  type ReviewSourceMode,
  type ReviewSourceStatus,
  type ReviewStatus
} from "../../../services/reputation-contracts";

export type { ReputationIndexStatus, ReviewStatus } from "../../../services/reputation-contracts";

// ---------------------------------------------------------------------------
// Permisos (useNavGate().grantedPermissions de navigation/useEnabledModules.ts)
// ---------------------------------------------------------------------------

export const REPUTATION_READ_PERMISSION = "reputation.read";
export const REPUTATION_RESPOND_PERMISSION = "reputation.respond";
export const QUALITY_CASES_MANAGE_PERMISSION = "quality_cases.manage";
export const SURVEYS_MANAGE_PERMISSION = "surveys.manage";
export const REPUTATION_MODULE_CODE = "reputation_quality";

function holds(grantedPermissions: readonly string[] | null | undefined, key: string): boolean {
  return Array.isArray(grantedPermissions) && grantedPermissions.includes(key);
}

/** La sesión puede escribir sobre reseñas y fuentes (PATCH, borrador, alta de fuentes, importación, publicación). */
export function canRespond(grantedPermissions: readonly string[] | null | undefined): boolean {
  return holds(grantedPermissions, REPUTATION_RESPOND_PERMISSION);
}

/** La sesión puede leer la reputación (bandeja, fuentes, detalle). */
export function canReadReputation(grantedPermissions: readonly string[] | null | undefined): boolean {
  return holds(grantedPermissions, REPUTATION_READ_PERMISSION) || canRespond(grantedPermissions);
}

export function canManageQualityCases(grantedPermissions: readonly string[] | null | undefined): boolean {
  return holds(grantedPermissions, QUALITY_CASES_MANAGE_PERMISSION);
}

export function canManageSurveys(grantedPermissions: readonly string[] | null | undefined): boolean {
  return holds(grantedPermissions, SURVEYS_MANAGE_PERMISSION);
}

// ---------------------------------------------------------------------------
// Índice
// ---------------------------------------------------------------------------

/** Copy del índice sin cifra (delegado al bloque compartido); `null` con `ok`. */
export function indexStatusCopy(input: { status: ReputationIndexStatus; reviewCount?: number | null }): string | null {
  return sharedIndexStatusCopy(input);
}

export type KpiStatus = "ok" | "warning" | "critical";

/** Tono de reputación → estado de un CocoaKpi. */
export function kpiStatusFromTone(tone: ReputationTone | "neutral"): KpiStatus {
  if (tone === "success") return "ok";
  if (tone === "warning") return "warning";
  if (tone === "danger") return "critical";
  return "ok";
}

/** «Mejora +2,3 frente a hace 30 días» · «Estable» · «Empeora −1,4 …»; «Sin tendencia» sin dato. */
export function trendCaption(delta: number | null | undefined, windowDays = 30): string {
  const direction = trendDirectionFor(delta);
  if (!direction) return "Sin tendencia";
  if (direction === "flat") return `Estable frente a hace ${windowDays} días`;
  const verb = direction === "up" ? "Mejora" : "Empeora";
  return `${verb} ${formatTrendDelta(delta)} frente a hace ${windowDays} días`;
}

/** Tono del badge de tendencia. */
export function trendTone(delta: number | null | undefined): ReputationTone | "neutral" {
  const direction = trendDirectionFor(delta);
  if (direction === "up") return "success";
  if (direction === "down") return "danger";
  return "neutral";
}

export type ReputationFigureInput = {
  status: ReputationIndexStatus;
  index30?: number | null;
  trendDelta?: number | null;
  reviewCount30: number;
  sourcesConnected: number;
  staleDays?: number | null;
};

export type ReputationFigureAction = "configure_sources" | "enable_module" | null;

export type ReputationFigureModel = {
  /** «87,5» o «—». */
  value: string;
  tone: ReputationTone | "neutral";
  /** Estado en una frase corta (badge). */
  statusLabel: string;
  /** Línea secundaria («12 reseñas · 2 fuentes conectadas · datos de ayer»). */
  hint: string;
  /** Tendencia solo con cifra. */
  trend: string | null;
  action: ReputationFigureAction;
};

/** Modelo de la figura «Índice de reputación (30 d)» del director: cifra, tono, copy honesto y acción sugerida. */
export function reputationFigureModel(input: ReputationFigureInput): ReputationFigureModel {
  const sources = `${input.sourcesConnected} ${input.sourcesConnected === 1 ? "fuente conectada" : "fuentes conectadas"}`;
  const stale = staleCopy(input.staleDays);
  switch (input.status) {
    case "ok": {
      const index = typeof input.index30 === "number" ? input.index30 : null;
      const parts = [reviewCountText(input.reviewCount30), sources];
      if (stale) parts.push(stale);
      return {
        value: formatIndex(index),
        tone: index === null ? "neutral" : indexTone(index),
        statusLabel: "Índice sobre 100",
        hint: parts.join(" · "),
        trend: trendCaption(input.trendDelta),
        action: null
      };
    }
    case "insufficient":
      return {
        value: "—",
        tone: "neutral",
        statusLabel: "Insuficiente",
        hint: `${reviewCountText(input.reviewCount30)} · insuficiente (mínimo ${INDEX_MIN_REVIEWS}) · ${sources}`,
        trend: null,
        action: null
      };
    case "no_reviews":
      return { value: "—", tone: "neutral", statusLabel: "Sin reseñas", hint: `Sin reseñas en la ventana · ${sources}`, trend: null, action: null };
    case "no_sources":
      return { value: "—", tone: "neutral", statusLabel: "Sin fuentes", hint: "Sin fuentes configuradas: conecta un portal o importa un CSV.", trend: null, action: "configure_sources" };
    case "module_off":
    default:
      return { value: "—", tone: "neutral", statusLabel: "Módulo no activado", hint: "El módulo reputation_quality no está activo en esta propiedad.", trend: null, action: "enable_module" };
  }
}

/**
 * Etiqueta del botón de la figura del director, o `null` si no procede.
 * «Configurar» solo para quien puede escribir fuentes (reputation.respond: es lo
 * que ReputationDashboard exige para «Configurar fuentes»); un lector con solo
 * reputation.read aterrizaría en un estado vacío sin acción (T8F-01).
 */
export function reputationFigureActionLabel(action: ReputationFigureAction, permissions: { canConfigure: boolean; canEnableModules: boolean }): string | null {
  if (action === "configure_sources") return permissions.canConfigure ? "Configurar" : null;
  if (action === "enable_module") return permissions.canEnableModules ? "Activar módulo" : null;
  return null;
}

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;

/** «hace 3 h» · «hace 2 d» · «hace unos minutos»; `null` sin fecha válida. */
export function agoCopy(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const hours = Math.max(0, Math.floor((now.getTime() - then) / MS_PER_HOUR));
  if (hours < 1) return "hace unos minutos";
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/**
 * Estado honesto de una fuente en una frase: «Sin conexión: <motivo>» para
 * unavailable/error, «Conectada · última ejecución hace N h» (o «sin
 * ejecuciones»), «Pendiente de autorizar», «Degradada: <motivo>», «Desactivada».
 */
export function sourceStateCopy(status: ReviewSourceStatus | string, lastError?: string | null, lastRunAt?: string | null, now: Date = new Date()): string {
  const reason = lastError && lastError.trim() ? lastError.trim() : null;
  switch (status) {
    case "unavailable":
      return `Sin conexión: ${reason ?? "el portal no ofrece acceso oficial o la conexión no está configurada"}`;
    case "error":
      return `Sin conexión: ${reason ?? "la última ejecución falló"}`;
    case "connected": {
      const ago = agoCopy(lastRunAt, now);
      return ago ? `Conectada · última ejecución ${ago}` : "Conectada · sin ejecuciones todavía";
    }
    case "pending":
      return reason ? `Pendiente de autorizar: ${reason}` : "Pendiente de autorizar";
    case "degraded":
      return reason ? `Degradada: ${reason}` : "Degradada";
    case "disabled":
      return "Desactivada";
    default:
      return sourceStatusLabel(status);
  }
}

/** Tono del badge de estado de una fuente (verde solo si está conectada). */
export function sourceStateTone(status: ReviewSourceStatus | string): ReputationTone | "neutral" | "info" {
  switch (status) {
    case "connected":
      return "success";
    case "pending":
    case "degraded":
      return "warning";
    case "error":
    case "unavailable":
      return "danger";
    case "disabled":
    default:
      return "neutral";
  }
}

export type SelectOption = { value: string; label: string };

/** Opciones de proveedor para el drawer de fuentes (etiquetas en español). */
export function providerOptions(): SelectOption[] {
  return REVIEW_PROVIDERS.map((provider) => ({ value: provider, label: providerLabel(provider) }));
}

/** Opciones de modo de una fuente. */
export function sourceModeOptions(): SelectOption[] {
  return REVIEW_SOURCE_MODES.map((mode) => ({ value: mode, label: sourceModeLabel(mode) }));
}

/** Modo por defecto de un proveedor: portales con API oficial → api; correo → email; csv → csv; demo → demo. */
export function defaultModeFor(provider: ReviewProvider | string): ReviewSourceMode {
  switch (provider) {
    case "google":
    case "booking":
    case "expedia":
      return "api";
    case "tripadvisor":
    case "holidaycheck":
    case "email":
      return "email";
    case "demo":
      return "demo";
    case "csv":
    default:
      return "csv";
  }
}

/** Nombre por defecto de una fuente («Google», «Booking.com · CSV»). */
export function defaultSourceName(provider: ReviewProvider | string, mode: ReviewSourceMode | string): string {
  const base = providerLabel(provider);
  if (mode === "csv" && provider !== "csv") return `${base} · CSV`;
  if (mode === "email" && provider !== "email") return `${base} · correo`;
  return base;
}

/** Peso 0,1-2 con coma o punto; `null` fuera de rango o vacío. */
export function parseWeight(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(value) || value < 0.1 || value > 2) return null;
  return Math.round(value * 100) / 100;
}

/** Retención en días 1-3650, entero; `null` fuera de rango. */
export function parseRetentionDays(text: string): number | null {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < 1 || value > 3650) return null;
  return value;
}

/** Capacidades declaradas → etiquetas en español (solo las verdaderas). */
export function capabilityLabels(capabilities: { fetch: boolean; reply: boolean; fullText: boolean; categories: boolean } | null | undefined): string[] {
  if (!capabilities) return [];
  const out: string[] = [];
  if (capabilities.fetch) out.push("Lee reseñas");
  if (capabilities.reply) out.push("Publica respuestas");
  if (capabilities.fullText) out.push("Texto completo");
  if (capabilities.categories) out.push("Subpuntuaciones");
  return out;
}

// ---------------------------------------------------------------------------
// Análisis, plazo y bandeja
// ---------------------------------------------------------------------------

export type AnalysisBadge = "IA" | "Diccionario · IA no configurada" | "Subpuntuaciones del portal" | "Sin análisis";

/** Etiqueta corta del origen del análisis semántico de una reseña. */
export function analysisBadge(source: string | null | undefined): AnalysisBadge {
  switch (source) {
    case "llm":
      return "IA";
    case "dictionary":
      return "Diccionario · IA no configurada";
    case "portal_subscore":
      return "Subpuntuaciones del portal";
    default:
      return "Sin análisis";
  }
}

/** Frase larga del origen del análisis (tooltip). */
export function analysisTitle(source: string | null | undefined): string {
  return source ? analysisSourceLabel(source) : analysisSourceLabel("none");
}

/** Copy del plazo de respuesta: «Fuera de plazo desde hace N h», «Vence en N h», «Respondida», «Sin plazo». */
export function slaCopy(input: { status: ReviewStatus | string; slaTargetAt?: string | null; overdue?: boolean; respondedAt?: string | null }, now: Date = new Date()): string {
  if (input.status === "responded" || input.respondedAt) return "Respondida";
  if (input.status === "closed") return "Cerrada";
  if (input.status === "ignored") return "Ignorada";
  if (!input.slaTargetAt) return "Sin plazo";
  const target = Date.parse(input.slaTargetAt);
  if (!Number.isFinite(target)) return "Sin plazo";
  const diffHours = Math.round((target - now.getTime()) / MS_PER_HOUR);
  if (input.overdue || diffHours < 0) {
    const late = Math.abs(diffHours);
    return late >= 48 ? `Fuera de plazo desde hace ${Math.floor(late / 24)} d` : `Fuera de plazo desde hace ${late} h`;
  }
  if (diffHours === 0) return "Vence ahora";
  return diffHours >= 48 ? `Vence en ${Math.floor(diffHours / 24)} d` : `Vence en ${diffHours} h`;
}

/** Tono del plazo: fuera de plazo danger · < 12 h warning · resto neutral · respondida success. */
export function slaTone(input: { status: ReviewStatus | string; slaTargetAt?: string | null; overdue?: boolean; respondedAt?: string | null }, now: Date = new Date()): ReputationTone | "neutral" {
  if (input.status === "responded" || input.respondedAt) return "success";
  if (input.status === "closed" || input.status === "ignored") return "neutral";
  if (!input.slaTargetAt) return "neutral";
  const target = Date.parse(input.slaTargetAt);
  if (!Number.isFinite(target)) return "neutral";
  const diffHours = (target - now.getTime()) / MS_PER_HOUR;
  if (input.overdue || diffHours < 0) return "danger";
  if (diffHours < 12) return "warning";
  return "neutral";
}

export const INBOX_FILTERS = Object.freeze(["open", "overdue", "responded", "all"] as const);
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const INBOX_FILTER_LABELS_ES: Readonly<Record<InboxFilter, string>> = Object.freeze({
  open: "Abiertas",
  overdue: "Fuera de plazo",
  responded: "Respondidas",
  all: "Todas"
});

/** Opciones del CocoaSegmentedControl de la bandeja (≤ 4). */
export function inboxFilterOptions(): SelectOption[] {
  return INBOX_FILTERS.map((value) => ({ value, label: INBOX_FILTER_LABELS_ES[value] }));
}

export function isInboxFilter(value: unknown): value is InboxFilter {
  return typeof value === "string" && (INBOX_FILTERS as readonly string[]).includes(value);
}

export type InboxFilterQuery = { responded?: "1" | "0"; overdue?: "1"; source?: string; limit?: number };

/** Query de `GET …/inbox` para un filtro y una fuente («» = todas): booleanos "1"/"0" como el esquema de la ruta. */
export function inboxFilters(filter: InboxFilter, source: string = "", limit?: number): InboxFilterQuery {
  const out: InboxFilterQuery = {};
  if (filter === "open") out.responded = "0";
  else if (filter === "responded") out.responded = "1";
  else if (filter === "overdue") out.overdue = "1";
  const code = source.trim();
  if (code) out.source = code;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) out.limit = Math.min(100, Math.floor(limit));
  return out;
}

/** Espejo de REVIEW_TRANSITIONS (review-inbox.service.ts): la API valida; aquí solo se ofrecen. */
export const REVIEW_TRANSITIONS_MIRROR: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> = Object.freeze({
  new: Object.freeze(["assigned", "drafted", "ignored"] as const),
  assigned: Object.freeze(["drafted", "responded", "ignored"] as const),
  drafted: Object.freeze(["assigned", "responded"] as const),
  responded: Object.freeze(["closed"] as const),
  closed: Object.freeze([] as const),
  ignored: Object.freeze([] as const)
});

/** Estados a los que puede pasar una reseña desde `status` (vacío para códigos desconocidos). */
export function reviewTransitions(status: string): readonly ReviewStatus[] {
  return isReviewStatus(status) ? REVIEW_TRANSITIONS_MIRROR[status] : [];
}

/** Todos los estados de la bandeja como opciones (para un filtro exhaustivo). */
export function reviewStatusOptions(): SelectOption[] {
  return REVIEW_STATUSES.map((status) => ({ value: status, label: reviewStatusLabelEs(status) }));
}

function reviewStatusLabelEs(status: ReviewStatus): string {
  switch (status) {
    case "new":
      return "Nueva";
    case "assigned":
      return "Asignada";
    case "drafted":
      return "Con borrador";
    case "responded":
      return "Respondida";
    case "closed":
      return "Cerrada";
    case "ignored":
      return "Ignorada";
  }
}

/** Tono del badge de estado de una reseña. */
export function reviewStatusTone(status: string): ReputationTone | "neutral" | "info" {
  switch (status) {
    case "new":
      return "warning";
    case "assigned":
    case "drafted":
      return "info";
    case "responded":
      return "success";
    case "closed":
    case "ignored":
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Respuesta y publicación
// ---------------------------------------------------------------------------

export const RESPONSE_MAX_CHARS = 4000;

/** Etiqueta de la acción principal del área de respuesta según la capacidad de la fuente. */
export function buildPortalActionLabel(item: { replyCapability: boolean; portalUrl?: string | null }): string {
  if (item.replyCapability) return "Responder";
  return item.portalUrl ? "Copiar y abrir portal" : "Copiar respuesta";
}

export const MANUAL_PUBLICATION_CONFIRM_LABEL = "Ya la he publicado en el portal";
export const DRAFT_REVIEW_NOTICE = "Se ha enviado a revisión humana; aprobar no publica.";

/** Badge del origen del borrador: «IA» o «Plantilla». */
export function draftSourceBadge(source: "ai" | "rules" | string): "IA" | "Plantilla" {
  return source === "ai" ? "IA" : "Plantilla";
}

export type ReviewPatchBodyLike = { status?: ReviewStatus; assignedUserId?: string | null; responseSource?: "api" | "manual" };

/**
 * PATCH que deja la reseña en `responded` después de POST …/respond: UNO solo
 * (`{ status: "responded", responseSource }`, con el responsable si se conoce y
 * la reseña estaba sin asignar). La API ya lee una fila con `respondedAt` como
 * `responded` (estado efectivo) y reconcilia la meta en ese PATCH, cerrando el
 * ítem HITL del borrador; si el PATCH falla, la bandeja sigue siendo honesta
 * (T8F-02). Si ya está respondida/cerrada/ignorada, ninguno.
 */
export function publicationPatches(status: string, source: "api" | "manual", assignedUserId?: string | null): ReviewPatchBodyLike[] {
  if (status !== "new" && status !== "assigned" && status !== "drafted") return [];
  const final: ReviewPatchBodyLike = { status: "responded", responseSource: source };
  if (status === "new" && assignedUserId) final.assignedUserId = assignedUserId;
  return [final];
}

/** Texto de la respuesta válido para publicar (no vacío, ≤ 4000). */
export function responseTextError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Escribe la respuesta antes de publicarla.";
  if (trimmed.length > RESPONSE_MAX_CHARS) return `La respuesta no puede superar ${RESPONSE_MAX_CHARS} caracteres.`;
  return null;
}

/** «Reseña sin puntuación» · «8,7 sobre 10 (4,5 / 5 en Google)». */
export function scoreCaption(input: { score10: number | null; ratingRaw: number | null; ratingScaleMax: number | null; provider: string }): string {
  if (input.score10 === null) return "Sin puntuación";
  const base = `${input.score10.toFixed(1).replace(".", ",")} sobre 10`;
  if (input.ratingRaw !== null && input.ratingScaleMax !== null) {
    return `${base} (${input.ratingRaw.toString().replace(".", ",")} / ${input.ratingScaleMax} en ${providerLabel(input.provider)})`;
  }
  return base;
}

export const PURGED_BODY_COPY = "Contenido purgado por retención";

// ---------------------------------------------------------------------------
// Importación CSV
// ---------------------------------------------------------------------------

/** Texto UTF-8 → base64 (el navegador manda el fichero como `contentBase64`; la API decide). */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** «3 creadas · 1 actualizada · 2 duplicadas · 1 inválida» (siempre las cuatro cifras). */
export function importSummaryCopy(result: Pick<ImportResult, "created" | "updated" | "duplicates" | "invalid">): string {
  const word = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [word(result.created, "creada", "creadas"), word(result.updated, "actualizada", "actualizadas"), word(result.duplicates, "duplicada", "duplicadas"), word(result.invalid.length, "inválida", "inválidas")].join(" · ");
}

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_ACCEPT = ".csv,text/csv,text/plain";

// ---------------------------------------------------------------------------
// Casos de calidad y encuestas
// ---------------------------------------------------------------------------

/** Espejo de OPERATIONAL_CASE (advanced-record-schemas.ts): la API valida; aquí solo se ofrecen. */
export const QUALITY_CASE_TRANSITIONS_MIRROR: Readonly<Record<string, readonly string[]>> = Object.freeze({
  open: Object.freeze(["in_progress", "resolved", "closed"]),
  in_progress: Object.freeze(["resolved", "closed", "open"]),
  resolved: Object.freeze(["closed", "open"]),
  closed: Object.freeze([])
});

export function qualityCaseTransitions(status: string): readonly string[] {
  return QUALITY_CASE_TRANSITIONS_MIRROR[status] ?? [];
}

export const QUALITY_CASE_STATUS_LABELS_ES: Readonly<Record<string, string>> = Object.freeze({
  open: "Abierto",
  in_progress: "En curso",
  resolved: "Resuelto",
  closed: "Cerrado"
});

export function qualityCaseStatusLabel(status: string): string {
  return QUALITY_CASE_STATUS_LABELS_ES[status] ?? status;
}

export const QUALITY_CASE_PRIORITIES = Object.freeze(["low", "normal", "high", "urgent"] as const);
export type QualityCasePriority = (typeof QUALITY_CASE_PRIORITIES)[number];
export const QUALITY_CASE_PRIORITY_LABELS_ES: Readonly<Record<QualityCasePriority, string>> = Object.freeze({
  low: "Baja",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente"
});

export function qualityCasePriorityOptions(): SelectOption[] {
  return QUALITY_CASE_PRIORITIES.map((value) => ({ value, label: QUALITY_CASE_PRIORITY_LABELS_ES[value] }));
}

/** Prioridad sugerida de un caso abierto desde una reseña: < 4 urgente · < 6 alta · resto normal. */
export function suggestedCasePriority(score10: number | null): QualityCasePriority {
  if (score10 === null) return "normal";
  if (score10 < 4) return "urgent";
  if (score10 < 6) return "high";
  return "normal";
}

/**
 * Caption del KPI «SLA incumplido» de Calidad con el cálculo real: porcentaje
 * sobre los casos con objetivo de SLA y, si los hay, los abiertos por reseñas.
 */
export function qualitySlaCaption(kpis: { slaBreachedPct: number; fromReviews?: number | null; openCases: number }): string {
  const base = kpis.slaBreachedPct > 0 ? "de los casos con objetivo de SLA" : kpis.openCases > 0 ? "sin incumplimientos entre los casos con SLA" : "sin casos en el periodo";
  const fromReviews = kpis.fromReviews ?? 0;
  return fromReviews > 0 ? `${base} · ${fromReviews} ${fromReviews === 1 ? "abierto por reseña" : "abiertos por reseñas"}` : base;
}

export const SURVEY_TYPES = Object.freeze(["post_stay", "in_stay", "pre_arrival", "event", "other"] as const);
export type SurveyType = (typeof SURVEY_TYPES)[number];
export const SURVEY_TYPE_LABELS_ES: Readonly<Record<SurveyType, string>> = Object.freeze({
  post_stay: "Tras la estancia",
  in_stay: "Durante la estancia",
  pre_arrival: "Antes de la llegada",
  event: "Evento",
  other: "Otra"
});

export function surveyTypeOptions(): SelectOption[] {
  return SURVEY_TYPES.map((value) => ({ value, label: SURVEY_TYPE_LABELS_ES[value] }));
}

export function surveyTypeLabel(type: string | null | undefined): string {
  return type && (SURVEY_TYPES as readonly string[]).includes(type) ? SURVEY_TYPE_LABELS_ES[type as SurveyType] : (type ?? "Otra");
}

/** Una pregunta por línea → objetos `{ id, text }` (líneas vacías fuera, ≤ 100). */
export function questionsFromLines(text: string): Array<{ id: string; text: string }> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((line, index) => ({ id: `q${index + 1}`, text: line }));
}

/** Puntuación 0-10 con coma o punto; `null` fuera de rango o vacía. */
export function parseSurveyScore(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value) || value < 0 || value > 10) return null;
  return Math.round(value * 10) / 10;
}

/** Fecha local del <input type=datetime-local> («2026-09-20T10:00») → ISO 8601 con zona; `null` si no es válida. */
export function localDateTimeToIso(local: string): string | null {
  if (!local.trim()) return null;
  const parsed = new Date(local);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
