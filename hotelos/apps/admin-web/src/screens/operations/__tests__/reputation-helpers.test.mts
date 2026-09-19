// Unit tests · Tanda T8 · lote T8-G — helpers puros de las pantallas de
// reputación (screens/operations/reputation/reputation-helpers.ts): copys
// honestos, tonos, filtros de la bandeja, máquinas de estado espejadas y
// parseos de formulario. Sin red, sin React, datos ficticios.
// Desde apps/api:
//   TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test ../admin-web/src/screens/operations/__tests__/reputation-helpers.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DRAFT_REVIEW_NOTICE,
  INBOX_FILTERS,
  MANUAL_PUBLICATION_CONFIRM_LABEL,
  PURGED_BODY_COPY,
  QUALITY_CASE_TRANSITIONS_MIRROR,
  REVIEW_TRANSITIONS_MIRROR,
  agoCopy,
  analysisBadge,
  buildPortalActionLabel,
  canManageQualityCases,
  canManageSurveys,
  canReadReputation,
  canRespond,
  capabilityLabels,
  defaultModeFor,
  defaultSourceName,
  draftSourceBadge,
  encodeBase64Utf8,
  importSummaryCopy,
  inboxFilterOptions,
  inboxFilters,
  indexStatusCopy,
  isInboxFilter,
  kpiStatusFromTone,
  localDateTimeToIso,
  parseRetentionDays,
  parseSurveyScore,
  parseWeight,
  publicationPatches,
  qualityCaseTransitions,
  qualitySlaCaption,
  questionsFromLines,
  reputationFigureActionLabel,
  reputationFigureModel,
  responseTextError,
  reviewStatusTone,
  reviewTransitions,
  scoreCaption,
  slaCopy,
  slaTone,
  sourceStateCopy,
  sourceStateTone,
  suggestedCasePriority,
  trendCaption,
  trendTone
} from "../reputation/reputation-helpers.ts";

const NOW = new Date("2026-09-19T12:00:00Z");
const H = 3_600_000;

describe("reputation-helpers · permisos", () => {
  it("lee reputation.respond / reputation.read / quality_cases.manage / surveys.manage de grantedPermissions", () => {
    assert.equal(canRespond(["reputation.respond"]), true);
    assert.equal(canRespond(["reputation.read"]), false);
    assert.equal(canRespond(null), false);
    assert.equal(canReadReputation(["reputation.read"]), true);
    assert.equal(canReadReputation(["reputation.respond"]), true, "responder implica leer");
    assert.equal(canReadReputation([]), false);
    assert.equal(canManageQualityCases(["quality_cases.manage"]), true);
    assert.equal(canManageQualityCases(["quality_cases.read"]), false);
    assert.equal(canManageSurveys(["surveys.manage"]), true);
    assert.equal(canManageSurveys(undefined), false);
  });
});

describe("reputation-helpers · índice", () => {
  it("indexStatusCopy explica cada estado sin cifra y calla con ok", () => {
    assert.equal(indexStatusCopy({ status: "ok" }), null);
    assert.equal(indexStatusCopy({ status: "no_sources" }), "Sin fuentes configuradas");
    assert.equal(indexStatusCopy({ status: "no_reviews" }), "Sin reseñas en la ventana");
    assert.equal(indexStatusCopy({ status: "insufficient", reviewCount: 4 }), "4 reseñas · insuficiente (mínimo 10)");
    assert.equal(indexStatusCopy({ status: "insufficient", reviewCount: 1 }), "1 reseña · insuficiente (mínimo 10)");
    assert.equal(indexStatusCopy({ status: "module_off" }), "Módulo no activado");
  });

  it("kpiStatusFromTone mapea success/warning/danger a ok/warning/critical", () => {
    assert.equal(kpiStatusFromTone("success"), "ok");
    assert.equal(kpiStatusFromTone("warning"), "warning");
    assert.equal(kpiStatusFromTone("danger"), "critical");
    assert.equal(kpiStatusFromTone("neutral"), "ok");
  });

  it("trendCaption y trendTone respetan la banda ±1,0", () => {
    assert.equal(trendCaption(2.3), "Mejora +2,3 frente a hace 30 días");
    assert.equal(trendCaption(-1.4), "Empeora −1,4 frente a hace 30 días");
    assert.equal(trendCaption(0.4), "Estable frente a hace 30 días");
    assert.equal(trendCaption(undefined), "Sin tendencia");
    assert.equal(trendTone(2.3), "success");
    assert.equal(trendTone(-2), "danger");
    assert.equal(trendTone(0.9), "neutral");
    assert.equal(trendTone(null), "neutral");
  });

  it("reputationFigureModel pinta la cifra con tono 85/70 y copys honestos en el resto", () => {
    const ok = reputationFigureModel({ status: "ok", index30: 87.5, trendDelta: 1.5, reviewCount30: 12, sourcesConnected: 2 });
    assert.equal(ok.value, "87,5");
    assert.equal(ok.tone, "success");
    assert.equal(ok.hint, "12 reseñas · 2 fuentes conectadas");
    assert.equal(ok.trend, "Mejora +1,5 frente a hace 30 días");
    assert.equal(ok.action, null);
    assert.equal(reputationFigureModel({ status: "ok", index30: 72, reviewCount30: 10, sourcesConnected: 1, staleDays: 1 }).tone, "warning");
    assert.equal(reputationFigureModel({ status: "ok", index30: 72, reviewCount30: 10, sourcesConnected: 1, staleDays: 1 }).hint, "10 reseñas · 1 fuente conectada · datos de ayer");
    assert.equal(reputationFigureModel({ status: "ok", index30: 61.2, reviewCount30: 10, sourcesConnected: 1 }).tone, "danger");

    const insufficient = reputationFigureModel({ status: "insufficient", reviewCount30: 3, sourcesConnected: 1 });
    assert.equal(insufficient.value, "—");
    assert.equal(insufficient.statusLabel, "Insuficiente");
    assert.match(insufficient.hint, /^3 reseñas · insuficiente \(mínimo 10\)/);
    assert.equal(insufficient.action, null);

    const noSources = reputationFigureModel({ status: "no_sources", reviewCount30: 0, sourcesConnected: 0 });
    assert.equal(noSources.statusLabel, "Sin fuentes");
    assert.equal(noSources.action, "configure_sources");

    const off = reputationFigureModel({ status: "module_off", reviewCount30: 0, sourcesConnected: 0 });
    assert.equal(off.statusLabel, "Módulo no activado");
    assert.equal(off.action, "enable_module");
    assert.equal(reputationFigureModel({ status: "no_reviews", reviewCount30: 0, sourcesConnected: 2 }).statusLabel, "Sin reseñas");
  });

  it("reputationFigureActionLabel solo ofrece «Configurar» a quien puede escribir fuentes (reputation.respond) y «Activar módulo» a quien puede activar módulos", () => {
    assert.equal(reputationFigureActionLabel("configure_sources", { canConfigure: true, canEnableModules: false }), "Configurar");
    // T8F-01: un lector (solo reputation.read) no recibe un CTA que aterriza en una pantalla sin acción.
    assert.equal(reputationFigureActionLabel("configure_sources", { canConfigure: false, canEnableModules: true }), null);
    assert.equal(reputationFigureActionLabel("enable_module", { canConfigure: true, canEnableModules: true }), "Activar módulo");
    assert.equal(reputationFigureActionLabel("enable_module", { canConfigure: true, canEnableModules: false }), null);
    assert.equal(reputationFigureActionLabel(null, { canConfigure: true, canEnableModules: true }), null);
  });
});

describe("reputation-helpers · fuentes", () => {
  it("sourceStateCopy dice «Sin conexión: <motivo>» y cuándo corrió una fuente conectada", () => {
    assert.equal(sourceStateCopy("unavailable", "Booking exige un partner certificado"), "Sin conexión: Booking exige un partner certificado");
    assert.equal(sourceStateCopy("error", null), "Sin conexión: la última ejecución falló");
    assert.equal(sourceStateCopy("error", "HTTP 500 del portal"), "Sin conexión: HTTP 500 del portal");
    assert.equal(sourceStateCopy("connected", null, new Date(NOW.getTime() - 3 * H).toISOString(), NOW), "Conectada · última ejecución hace 3 h");
    assert.equal(sourceStateCopy("connected", null, null, NOW), "Conectada · sin ejecuciones todavía");
    assert.equal(sourceStateCopy("pending", null), "Pendiente de autorizar");
    assert.equal(sourceStateCopy("degraded", "cuota agotada"), "Degradada: cuota agotada");
    assert.equal(sourceStateCopy("disabled", null), "Desactivada");
  });

  it("agoCopy redondea a horas y días", () => {
    assert.equal(agoCopy(new Date(NOW.getTime() - 20 * 60_000).toISOString(), NOW), "hace unos minutos");
    assert.equal(agoCopy(new Date(NOW.getTime() - 5 * H).toISOString(), NOW), "hace 5 h");
    assert.equal(agoCopy(new Date(NOW.getTime() - 72 * H).toISOString(), NOW), "hace 3 d");
    assert.equal(agoCopy(null, NOW), null);
    assert.equal(agoCopy("no-es-fecha", NOW), null);
  });

  it("sourceStateTone solo es verde con connected", () => {
    assert.equal(sourceStateTone("connected"), "success");
    assert.equal(sourceStateTone("pending"), "warning");
    assert.equal(sourceStateTone("degraded"), "warning");
    assert.equal(sourceStateTone("error"), "danger");
    assert.equal(sourceStateTone("unavailable"), "danger");
    assert.equal(sourceStateTone("disabled"), "neutral");
  });

  it("defaultModeFor / defaultSourceName / capabilityLabels", () => {
    assert.equal(defaultModeFor("google"), "api");
    assert.equal(defaultModeFor("tripadvisor"), "email");
    assert.equal(defaultModeFor("csv"), "csv");
    assert.equal(defaultModeFor("demo"), "demo");
    assert.equal(defaultSourceName("booking", "csv"), "Booking.com · CSV");
    assert.equal(defaultSourceName("csv", "csv"), "Importación CSV");
    assert.equal(defaultSourceName("holidaycheck", "email"), "HolidayCheck · correo");
    assert.deepEqual(capabilityLabels({ fetch: true, reply: false, fullText: true, categories: false }), ["Lee reseñas", "Texto completo"]);
    assert.deepEqual(capabilityLabels(null), []);
  });

  it("parseWeight y parseRetentionDays aceptan coma decimal y rechazan fuera de rango", () => {
    assert.equal(parseWeight("1,5"), 1.5);
    assert.equal(parseWeight("0.1"), 0.1);
    assert.equal(parseWeight("2"), 2);
    assert.equal(parseWeight("2,5"), null);
    assert.equal(parseWeight(""), null);
    assert.equal(parseRetentionDays("730"), 730);
    assert.equal(parseRetentionDays("0"), null);
    assert.equal(parseRetentionDays("30.5"), null);
    assert.equal(parseRetentionDays("3651"), null);
  });
});

describe("reputation-helpers · análisis, plazo y bandeja", () => {
  it("analysisBadge nombra el origen del análisis", () => {
    assert.equal(analysisBadge("llm"), "IA");
    assert.equal(analysisBadge("dictionary"), "Diccionario · IA no configurada");
    assert.equal(analysisBadge("portal_subscore"), "Subpuntuaciones del portal");
    assert.equal(analysisBadge("none"), "Sin análisis");
    assert.equal(analysisBadge(undefined), "Sin análisis");
  });

  it("slaCopy / slaTone según el plazo y el estado", () => {
    const soon = new Date(NOW.getTime() + 6 * H).toISOString();
    const later = new Date(NOW.getTime() + 60 * H).toISOString();
    const late = new Date(NOW.getTime() - 5 * H).toISOString();
    const veryLate = new Date(NOW.getTime() - 72 * H).toISOString();
    assert.equal(slaCopy({ status: "new", slaTargetAt: soon }, NOW), "Vence en 6 h");
    assert.equal(slaTone({ status: "new", slaTargetAt: soon }, NOW), "warning");
    assert.equal(slaCopy({ status: "assigned", slaTargetAt: later }, NOW), "Vence en 2 d");
    assert.equal(slaTone({ status: "assigned", slaTargetAt: later }, NOW), "neutral");
    assert.equal(slaCopy({ status: "new", slaTargetAt: late, overdue: true }, NOW), "Fuera de plazo desde hace 5 h");
    assert.equal(slaTone({ status: "new", slaTargetAt: late, overdue: true }, NOW), "danger");
    assert.equal(slaCopy({ status: "drafted", slaTargetAt: veryLate }, NOW), "Fuera de plazo desde hace 3 d");
    assert.equal(slaCopy({ status: "responded", slaTargetAt: late }, NOW), "Respondida");
    assert.equal(slaTone({ status: "responded", slaTargetAt: late }, NOW), "success");
    assert.equal(slaCopy({ status: "new", slaTargetAt: null }, NOW), "Sin plazo");
    assert.equal(slaCopy({ status: "closed" }, NOW), "Cerrada");
    assert.equal(slaCopy({ status: "ignored" }, NOW), "Ignorada");
  });

  it("inboxFilters traduce el filtro a la query de la ruta (responded/overdue como 1/0)", () => {
    assert.deepEqual([...INBOX_FILTERS], ["open", "overdue", "responded", "all"]);
    assert.deepEqual(inboxFilterOptions().map((o) => o.label), ["Abiertas", "Fuera de plazo", "Respondidas", "Todas"]);
    assert.deepEqual(inboxFilters("open"), { responded: "0" });
    assert.deepEqual(inboxFilters("responded", "google"), { responded: "1", source: "google" });
    assert.deepEqual(inboxFilters("overdue", " ", 25), { overdue: "1", limit: 25 });
    assert.deepEqual(inboxFilters("all", "booking_demo", 500), { source: "booking_demo", limit: 100 });
    assert.equal(isInboxFilter("open"), true);
    assert.equal(isInboxFilter("nuevo"), false);
  });

  it("reviewTransitions espeja la máquina de estados de la API", () => {
    assert.deepEqual([...reviewTransitions("new")], ["assigned", "drafted", "ignored"]);
    assert.deepEqual([...reviewTransitions("assigned")], ["drafted", "responded", "ignored"]);
    assert.deepEqual([...reviewTransitions("drafted")], ["assigned", "responded"]);
    assert.deepEqual([...reviewTransitions("responded")], ["closed"]);
    assert.deepEqual([...reviewTransitions("closed")], []);
    assert.deepEqual([...reviewTransitions("otro")], []);
    assert.deepEqual(Object.keys(REVIEW_TRANSITIONS_MIRROR), ["new", "assigned", "drafted", "responded", "closed", "ignored"]);
    assert.equal(reviewStatusTone("new"), "warning");
    assert.equal(reviewStatusTone("responded"), "success");
    assert.equal(reviewStatusTone("closed"), "neutral");
  });
});

describe("reputation-helpers · respuesta y publicación", () => {
  it("buildPortalActionLabel: «Responder» con capacidad, «Copiar y abrir portal» con URL, «Copiar respuesta» sin ella", () => {
    assert.equal(buildPortalActionLabel({ replyCapability: true, portalUrl: "https://portal.example/r/1" }), "Responder");
    assert.equal(buildPortalActionLabel({ replyCapability: false, portalUrl: "https://portal.example/r/1" }), "Copiar y abrir portal");
    assert.equal(buildPortalActionLabel({ replyCapability: false, portalUrl: null }), "Copiar respuesta");
    assert.equal(MANUAL_PUBLICATION_CONFIRM_LABEL, "Ya la he publicado en el portal");
    assert.equal(DRAFT_REVIEW_NOTICE, "Se ha enviado a revisión humana; aprobar no publica.");
    assert.equal(draftSourceBadge("ai"), "IA");
    assert.equal(draftSourceBadge("rules"), "Plantilla");
    assert.equal(PURGED_BODY_COPY, "Contenido purgado por retención");
  });

  it("publicationPatches: UN solo PATCH a responded tras POST …/respond (la API reconcilia el estado efectivo); el resto nada (T8F-02)", () => {
    assert.deepEqual(publicationPatches("new", "manual", "usr_1"), [{ status: "responded", responseSource: "manual", assignedUserId: "usr_1" }]);
    assert.deepEqual(publicationPatches("new", "api", null), [{ status: "responded", responseSource: "api" }]);
    assert.deepEqual(publicationPatches("assigned", "manual"), [{ status: "responded", responseSource: "manual" }]);
    assert.deepEqual(publicationPatches("drafted", "api"), [{ status: "responded", responseSource: "api" }]);
    assert.deepEqual(publicationPatches("responded", "manual"), []);
    assert.deepEqual(publicationPatches("closed", "manual"), []);
    assert.deepEqual(publicationPatches("ignored", "manual"), []);
  });

  it("responseTextError y scoreCaption", () => {
    assert.equal(responseTextError("   "), "Escribe la respuesta antes de publicarla.");
    assert.equal(responseTextError("Gracias por su visita."), null);
    assert.match(responseTextError("x".repeat(4001)) ?? "", /4000/);
    assert.equal(scoreCaption({ score10: 8.7, ratingRaw: 4.5, ratingScaleMax: 5, provider: "google" }), "8,7 sobre 10 (4,5 / 5 en Google)");
    assert.equal(scoreCaption({ score10: 6, ratingRaw: null, ratingScaleMax: null, provider: "csv" }), "6,0 sobre 10");
    assert.equal(scoreCaption({ score10: null, ratingRaw: null, ratingScaleMax: null, provider: "csv" }), "Sin puntuación");
  });
});

describe("reputation-helpers · importación", () => {
  it("encodeBase64Utf8 conserva acentos y importSummaryCopy pinta las cuatro cifras", () => {
    const encoded = encodeBase64Utf8("external_id,date,rating\n1,2026-09-01,4,5 · señor");
    assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "external_id,date,rating\n1,2026-09-01,4,5 · señor");
    assert.equal(importSummaryCopy({ created: 3, updated: 1, duplicates: 2, invalid: [{ row: 5, reason: "sin nota" }] }), "3 creadas · 1 actualizada · 2 duplicadas · 1 inválida");
    assert.equal(importSummaryCopy({ created: 0, updated: 0, duplicates: 0, invalid: [] }), "0 creadas · 0 actualizadas · 0 duplicadas · 0 inválidas");
  });
});

describe("reputation-helpers · calidad y encuestas", () => {
  it("qualityCaseTransitions espeja OPERATIONAL_CASE", () => {
    assert.deepEqual([...qualityCaseTransitions("open")], ["in_progress", "resolved", "closed"]);
    assert.deepEqual([...qualityCaseTransitions("in_progress")], ["resolved", "closed", "open"]);
    assert.deepEqual([...qualityCaseTransitions("resolved")], ["closed", "open"]);
    assert.deepEqual([...qualityCaseTransitions("closed")], []);
    assert.deepEqual([...qualityCaseTransitions("desconocido")], []);
    assert.deepEqual(Object.keys(QUALITY_CASE_TRANSITIONS_MIRROR), ["open", "in_progress", "resolved", "closed"]);
  });

  it("suggestedCasePriority por nota y qualitySlaCaption con el cálculo real", () => {
    assert.equal(suggestedCasePriority(3.5), "urgent");
    assert.equal(suggestedCasePriority(5.9), "high");
    assert.equal(suggestedCasePriority(7), "normal");
    assert.equal(suggestedCasePriority(null), "normal");
    assert.equal(qualitySlaCaption({ slaBreachedPct: 12.5, fromReviews: 2, openCases: 4 }), "de los casos con objetivo de SLA · 2 abiertos por reseñas");
    assert.equal(qualitySlaCaption({ slaBreachedPct: 0, fromReviews: 1, openCases: 3 }), "sin incumplimientos entre los casos con SLA · 1 abierto por reseña");
    assert.equal(qualitySlaCaption({ slaBreachedPct: 0, fromReviews: 0, openCases: 0 }), "sin casos en el periodo");
    assert.equal(qualitySlaCaption({ slaBreachedPct: 0, openCases: 2 }), "sin incumplimientos entre los casos con SLA");
  });

  it("questionsFromLines, parseSurveyScore y localDateTimeToIso", () => {
    assert.deepEqual(questionsFromLines("¿Limpieza?\n\n  ¿Recomendarías?  \n"), [
      { id: "q1", text: "¿Limpieza?" },
      { id: "q2", text: "¿Recomendarías?" }
    ]);
    assert.equal(questionsFromLines("").length, 0);
    assert.equal(parseSurveyScore("9"), 9);
    assert.equal(parseSurveyScore("7,5"), 7.5);
    assert.equal(parseSurveyScore("11"), null);
    assert.equal(parseSurveyScore(""), null);
    assert.equal(localDateTimeToIso(""), null);
    assert.equal(localDateTimeToIso("no"), null);
    assert.match(localDateTimeToIso("2026-09-20T10:00") ?? "", /^2026-09-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  });
});
