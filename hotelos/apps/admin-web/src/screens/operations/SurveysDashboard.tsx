// Encuestas — Comercial › Reputación y calidad › Encuestas
// (/comercial/reputacion/encuestas, hosted inside ReputacionTabs).
//
// Cocoa 22 · ola 7 · lote 7-B (docs/design/COCOA-22.md §4, archetype
// «dashboard alojado»): CocoaPage → CocoaKpiStrip (NPS, response rate,
// responses, detractors) → CocoaGrid 6/6 (promoters · passives · detractors
// as CocoaChart.Progress rows · 0–10 score distribution as CocoaChart.Bars)
// → CocoaGrid 6/6 (recent responses as a section list · top themes as a
// CocoaTable).
//
// Tanda T8 · lote T8-G: acciones de página «Nueva encuesta» (surveys.manage)
// y «Registrar respuesta» (surveys.manage; la ruta del motor exige surveys.read hasta
// la mergeLine §1.5 de T8-MERGE-LINES.md) que abren reputation/SurveyEditorDrawer
// (POST /surveys/properties/:id · POST /surveys/:id/responses); al guardar se
// refresca el panel. Los permisos salen de useNavGate().grantedPermissions.
//
// Data: GET /dashboards/surveys, polled every 5 minutes — only once the
// reputation_quality module is known to be enabled (qa#14): while the module
// list loads the page keeps its skeleton, and with the module off it paints
// «Módulo no activado» (+ «Activar módulo» for users with modules.enable).

import { useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useNavGate } from "../../navigation/useEnabledModules";
import { canManageSurveys } from "./reputation/reputation-helpers";
import { SurveyEditorDrawer, type SurveyEditorMode } from "./reputation/SurveyEditorDrawer";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { dateTime, number, percent, plural } from "../../lib/format";
import { moduleDisabledCopy } from "./module-gate";
import { useScreenModuleGate } from "./useScreenModuleGate";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaBarsDatum,
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// Menu labels of the tree (Comercial › Reputación y calidad › Encuestas), never retyped here.
const HEADER = treeHeaderFor("SurveysDashboard", { eyebrow: "Comercial · Reputación y calidad", title: "Encuestas" });

type SurveyResponse = {
  id: string;
  surveyName: string;
  score?: number;
  sentiment?: string;
  comment?: string;
  submittedAt: string;
};
type ScoreBucket = { score: number; count: number };
type Theme = { theme: string; count: number };
type Kpis = {
  nps90d: number;
  responseRatePct: number;
  totalResponses90d: number;
  promoters: number;
  passives: number;
  detractors: number;
};
type SurveysDashboardData = {
  kpis: Kpis;
  scoreDistribution: ScoreBucket[];
  recentResponses: SurveyResponse[];
  topThemes: Theme[];
};

const EMPTY_KPIS: Kpis = { nps90d: 0, responseRatePct: 0, totalResponses90d: 0, promoters: 0, passives: 0, detractors: 0 };
const MAX_ROWS = 12;

function npsStatus(nps: number): CocoaKpiStatus {
  if (nps >= 50) return "ok";
  if (nps >= 0) return "warning";
  return "critical";
}

function responseRateStatus(pct: number): CocoaKpiStatus {
  if (pct >= 25) return "ok";
  if (pct >= 10) return "warning";
  return "critical";
}

/** Promoters (9–10) success · passives (7–8) neutral · detractors (0–6) danger. */
function scoreTone(score: number): CocoaTone {
  if (score >= 9) return "success";
  if (score >= 7) return "neutral";
  return "danger";
}

function sentimentLabel(sentiment: string): { label: string; tone: CocoaTone } {
  const s = sentiment.toLowerCase();
  if (s.includes("pos") || s.includes("happy")) return { label: "positivo", tone: "success" };
  if (s.includes("neg") || s.includes("angry")) return { label: "negativo", tone: "danger" };
  if (s.includes("mix") || s.includes("warn")) return { label: "mixto", tone: "warning" };
  if (s.includes("neu")) return { label: "neutro", tone: "neutral" };
  return { label: sentiment, tone: "neutral" };
}

function fmtScore(score: number): string {
  return number(score, { maximumFractionDigits: 1 });
}

function fmtPct(pct: number): string {
  return percent(pct, { maximumFractionDigits: 0 });
}

// Footnote text (date of a response) in the secondary ink; outside a literal `style={{…}}` (rule 6).
const footnoteStyle: CSSProperties = { fontSize: "var(--cocoa-fs-footnote)", color: "var(--cocoa-label-secondary)" };
const bodyStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-body)", lineHeight: "var(--cocoa-lh-body)", color: "var(--cocoa-label)" };

const THEME_COLUMNS: CocoaTableColumn<Theme>[] = [
  { key: "theme", label: "Tema", render: (row) => <strong>{row.theme}</strong> },
  { key: "count", label: "Menciones", align: "right", fit: true, render: (row) => number(row.count) }
];

// Mirror skeleton: the KPI strip and the two 6/6 rows.
function SurveysSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[6, 6], [6, 6]]} height={220} />
    </div>
  );
}

export function SurveysDashboard() {
  // Hosted inside ReputacionTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  // Module gate (qa#14): no request (and no 5-minute poll) until reputation_quality is known to be enabled.
  const moduleGate = useScreenModuleGate("SurveysDashboard");
  const { data, loading, error, refresh } = useApiData<SurveysDashboardData>(moduleGate.ready ? "/dashboards/surveys" : null, { pollIntervalMs: 300000 });
  // Tanda T8: «Nueva encuesta» y «Registrar respuesta» exigen surveys.manage en la UI (T8F-04: un lector no registra
  // respuestas; la ruta POST /surveys/:id/responses pasa a surveys.manage con la mergeLine §1.5).
  const navGate = useNavGate(getActivePropertyId());
  const canManage = canManageSurveys(navGate.grantedPermissions);
  const [editor, setEditor] = useState<SurveyEditorMode | null>(null);

  const kpis = data?.kpis ?? EMPTY_KPIS;
  const scoreDistribution = toArray<ScoreBucket>(data?.scoreDistribution);
  const recentResponses = toArray<SurveyResponse>(data?.recentResponses);
  const topThemes = toArray<Theme>(data?.topThemes);

  const totalScored = kpis.promoters + kpis.passives + kpis.detractors;
  const promoterPct = totalScored > 0 ? Math.round((kpis.promoters / totalScored) * 100) : 0;
  const passivePct = totalScored > 0 ? Math.round((kpis.passives / totalScored) * 100) : 0;
  const detractorPct = totalScored > 0 ? Math.max(0, 100 - promoterPct - passivePct) : 0;
  const breakdown: Array<{ key: string; label: string; count: number; pct: number; tone: CocoaTone }> = [
    { key: "promoters", label: "Promotores (9–10)", count: kpis.promoters, pct: promoterPct, tone: "success" },
    { key: "passives", label: "Pasivos (7–8)", count: kpis.passives, pct: passivePct, tone: "warning" },
    { key: "detractors", label: "Detractores (0–6)", count: kpis.detractors, pct: detractorPct, tone: "danger" }
  ];

  const distributionTotal = scoreDistribution.reduce((total, row) => total + row.count, 0);
  const distributionPeak = scoreDistribution.reduce((max, row) => Math.max(max, row.count), 0);
  const distributionBars: CocoaBarsDatum[] = scoreDistribution.map((row) => ({
    label: String(row.score),
    value: row.count,
    tone: scoreTone(row.score),
    hint: plural(row.count, "respuesta", "respuestas")
  }));

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <>
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Encuestas tras la estancia: NPS de los últimos 90 días, tasa de respuesta, distribución de puntuaciones, comentarios recientes y temas más mencionados. Se actualiza cada 5 minutos."
      actions={
        moduleGate.ready ? (
          <>
            {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
            {error && data ? (
              <CocoaBadge tone="danger" title={error}>
                {STATUS_LABELS.loadError}
              </CocoaBadge>
            ) : null}
            {canManage ? (
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setEditor("response")}>
                Registrar respuesta
              </CocoaButton>
            ) : null}
            {canManage ? (
              <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => setEditor("create")}>
                Nueva encuesta
              </CocoaButton>
            ) : null}
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
              {ACTIONS.refresh}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<SurveysSkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: "No se pudieron cargar las encuestas", message: error ?? undefined, onRetry: refresh }}
      commands={
        moduleGate.ready
          ? [
              { id: "surveys-refresh", label: "Actualizar encuestas", run: refresh },
              ...(canManage
                ? [
                    { id: "surveys-response", label: "Registrar respuesta de encuesta", run: () => setEditor("response") },
                    { id: "surveys-create", label: "Nueva encuesta", run: () => setEditor("create") }
                  ]
                : [])
            ]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "surveys-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de encuestas">
        <CocoaKpi label="NPS · 90 días" value={fmtScore(kpis.nps90d)} caption="promotores menos detractores" polarity="neutral" status={npsStatus(kpis.nps90d)} />
        <CocoaKpi
          label="Tasa de respuesta"
          value={percent(kpis.responseRatePct, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          caption="respuestas entre salidas del periodo"
          polarity="neutral"
          status={responseRateStatus(kpis.responseRatePct)}
        />
        <CocoaKpi label="Respuestas · 90 días" value={number(kpis.totalResponses90d)} caption="recibidas en el periodo" polarity="neutral" status="ok" />
        <CocoaKpi
          label="Detractores"
          value={number(kpis.detractors)}
          caption="puntuación de 6 o menos · requieren seguimiento"
          polarity="neutral"
          status={kpis.detractors > kpis.promoters ? "critical" : "ok"}
        />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Reparto y distribución de puntuaciones">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Promotores, pasivos y detractores" meta={`${number(totalScored)} con puntuación`}>
            {totalScored === 0 ? (
              <CocoaState kind="empty" inline title="Sin respuestas con puntuación en el periodo." />
            ) : (
              <div className="cocoa-stack" data-gap="3">
                {breakdown.map((row) => (
                  <CocoaChart.Progress
                    key={row.key}
                    value={row.pct}
                    tone={row.tone}
                    label={row.label}
                    valueLabel={`${number(row.count)} · ${fmtPct(row.pct)}`}
                    aria-label={`${row.label}: ${plural(row.count, "respuesta", "respuestas")} (${fmtPct(row.pct)})`}
                  />
                ))}
              </div>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Distribución de puntuaciones" meta={distributionPeak > 0 ? `pico de ${number(distributionPeak)} · escala de 0 a 10` : "escala de 0 a 10"}>
            {distributionTotal === 0 ? (
              <CocoaState kind="empty" inline title="Sin puntuaciones que representar." />
            ) : (
              <CocoaChart.Bars data={distributionBars} height={160} valueFormat={(value) => number(value)} aria-label="Número de respuestas por puntuación de 0 a 10" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid align="start" aria-label="Comentarios y temas">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Respuestas recientes" meta={plural(recentResponses.length, "comentario", "comentarios")}>
            {recentResponses.length === 0 ? (
              <CocoaState
                kind="empty"
                title="No hay respuestas recientes"
                message="Cuando los huéspedes contesten las encuestas, sus comentarios aparecerán aquí con puntuación y sentimiento."
              />
            ) : (
              <ul className="c22-section__list" aria-label="Respuestas recientes">
                {recentResponses.slice(0, MAX_ROWS).map((response) => {
                  const sentiment = response.sentiment ? sentimentLabel(response.sentiment) : null;
                  return (
                    <li key={response.id}>
                      <div className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto", minWidth: 0 }}>
                        <div className="cocoa-row" data-gap="2" data-justify="between">
                          <strong>{response.surveyName}</strong>
                          <span className="cocoa-cluster">
                            {sentiment ? (
                              <CocoaBadge tone={sentiment.tone} variant="tinted" size="small">
                                {sentiment.label}
                              </CocoaBadge>
                            ) : null}
                            {response.score !== undefined ? (
                              <CocoaBadge tone={scoreTone(response.score)} size="small" uppercase={false}>
                                {fmtScore(response.score)} / 10
                              </CocoaBadge>
                            ) : (
                              <CocoaBadge tone="neutral" size="small">
                                sin puntuación
                              </CocoaBadge>
                            )}
                          </span>
                        </div>
                        {response.comment ? <p style={bodyStyle}>{response.comment}</p> : null}
                        <span style={footnoteStyle}>{dateTime(response.submittedAt)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Temas más mencionados"
            meta={plural(topThemes.length, "tema", "temas")}
            padding={topThemes.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {topThemes.length === 0 ? (
              <CocoaState
                kind="empty"
                title="No hay temas categorizados"
                message="Cuando haya respuestas con texto suficiente, la IA agrupará los temas y los mostrará aquí ordenados por menciones."
              />
            ) : (
              <CocoaTable columns={THEME_COLUMNS} rows={topThemes.slice(0, MAX_ROWS)} rowKey="theme" caption="Temas más mencionados" aria-label="Temas más mencionados" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
    <SurveyEditorDrawer open={editor !== null} mode={editor ?? "response"} onClose={() => setEditor(null)} onSaved={refresh} />
    </>
  );
}
