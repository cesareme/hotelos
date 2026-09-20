// Actividad de la IA — /configuracion/ia/actividad (hosted in
// InteligenciaArtificialTabs; Cocoa 22 · ola 10 · lote 10-B, plantilla
// DashboardAlojado).
//
// Read-only dashboard over /ai-operations/pipeline/dashboard (polled every
// 30 s): KPI strip, tool table with controlled sort, module table, status
// breakdown, confidence distribution (CocoaChart.Progress), latency trend
// (CocoaChart.Bars), recent actions and anomalies. The drill-down of an
// action (input / output JSON) is fetched on demand from /calls/:id and opens
// in a CocoaDrawer instead of the old inline card. Same endpoints and query.
// Tanda L6b · lote 04: a NULL cost (a model call without a computable euro
// amount) paints «—» with the reason as title, never «0,00 €» (costLabel).

import { getActiveOrganizationId } from "../../services/activeProperty";
import { callStatusLabel, callStatusTone, costLabel } from "./ai-operations-labels";
import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { toArray } from "../../utils/toArray";
import { date, dateTime, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaDrawer,
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
  type CocoaTableColumn,
  type CocoaTableSort,
  type CocoaTone
} from "../../components/cocoa";

const ORGANIZATION_ID = getActiveOrganizationId();

type PipelineDashboard = {
  kpis: {
    callsTotal: number;
    calls24h: number;
    successRatePct: number;
    avgLatencyMs: number;
    avgConfidence: number;
    awaitingConfirmation: number;
    failed24h: number;
    /** Sum of cost_eur of the month; null only if the API cannot compute it. */
    costMtdEur: number | null;
    tokensMtd: number;
  };
  byTool: Array<{
    toolName: string;
    calls: number;
    successRatePct: number;
    avgLatencyMs: number;
    avgConfidence: number;
    costEur: number;
  }>;
  byModule: Array<{ moduleCode: string; calls: number; successRatePct: number }>;
  byStatus: Array<{ status: string; count: number }>;
  confidenceBuckets: Array<{ bucket: string; count: number }>;
  latencyTrend: Array<{ date: string; avgLatencyMs: number; calls: number }>;
  recentCalls: Array<{
    id: string;
    toolName: string;
    status: string;
    confidence: number | null;
    latencyMs: number | null;
    costEur: number | null;
    automationLevel: string | null;
    createdAt: string;
    hasError: boolean;
  }>;
  anomalies: Array<{
    id: string;
    type: string;
    severity: string;
    description: string;
    detectedAt: string;
    status: string;
  }>;
};

type ToolCallDetail = {
  id: string;
  toolName: string;
  status: string;
  model: string | null;
  confidence: number | null;
  latencyMs: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costEur: number | null;
  automationLevel: string | null;
  requiredConfirmation: boolean;
  confirmedBy: string | null;
  errorMessage: string | null;
  createdAt: string;
  inputJson: Record<string, unknown> | null;
  outputJson: Record<string, unknown> | null;
};

type ToolRow = PipelineDashboard["byTool"][number];
type ModuleRow = PipelineDashboard["byModule"][number];
type RecentCall = PipelineDashboard["recentCalls"][number];
type ToolSortKey = "calls" | "successRatePct" | "avgLatencyMs" | "avgConfidence" | "costEur";

// ---- labels and tones (API values stay in English; the screen speaks Spanish) ----
// Tool-call statuses (label + tone) live in ./ai-operations-labels so the
// governance «completed» status renders like «succeeded» (qa#11).

const SEVERITY_LABEL: Record<string, string> = { low: "baja", medium: "media", high: "alta", critical: "crítica" };
const AUTOMATION_LABEL: Record<string, string> = { off: "Desactivado", suggest: "Sugerir", suggest_and_confirm: "Sugerir y confirmar", autonomous: "Autónomo" };

function statusBadge(status: string) {
  return (
    <CocoaBadge tone={callStatusTone(status)} variant="tinted" size="small">
      {callStatusLabel(status)}
    </CocoaBadge>
  );
}

function severityTone(severity: string): CocoaTone {
  const s = severity.toLowerCase();
  return s === "critical" || s === "high" ? "danger" : s === "medium" ? "warning" : "success";
}

function severityBadge(severity: string) {
  return (
    <CocoaBadge tone={severityTone(severity)} variant="tinted" size="small">
      {SEVERITY_LABEL[severity.toLowerCase()] ?? severity}
    </CocoaBadge>
  );
}

function fmtConfidence(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return number(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMs(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${number(n, { maximumFractionDigits: 0 })} ms`;
}

function fmtPct(n: number | null | undefined): string {
  return percent(n, { maximumFractionDigits: 1 });
}

function automationLabel(level: string | null | undefined): string {
  return level ? (AUTOMATION_LABEL[level] ?? level) : "—";
}

/** Cost cell: «—» with the reason as title when the API says null (never «0,00 €»); the real figure otherwise. */
function costCell(costEur: number | null | undefined) {
  const cost = costLabel(costEur);
  return cost.title ? <span title={cost.title}>{cost.text}</span> : cost.text;
}

// JSON of the action detail: tokens only (rule 6).
const codeStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "var(--cocoa-font-mono)",
  fontSize: "var(--cocoa-fs-caption)",
  lineHeight: "var(--cocoa-leading-text)",
  color: "var(--cocoa-label)",
  background: "var(--cocoa-fill-quaternary)",
  borderRadius: "var(--cocoa-radius-md)",
  padding: "var(--cocoa-space-3)",
  maxHeight: 320,
  overflow: "auto"
};

// ---- columns (outside the component, typed with the row) ----

const TOOL_COLUMNS: CocoaTableColumn<ToolRow>[] = [
  { key: "toolName", label: "Herramienta", minWidth: 180, render: (r) => <strong>{r.toolName}</strong> },
  { key: "calls", label: "Acciones", align: "right", fit: true, sortable: true, render: (r) => number(r.calls) },
  { key: "successRatePct", label: "% éxito", align: "right", fit: true, sortable: true, render: (r) => fmtPct(r.successRatePct) },
  { key: "avgLatencyMs", label: "Tiempo medio", align: "right", fit: true, sortable: true, hideOnNarrow: true, render: (r) => fmtMs(r.avgLatencyMs) },
  { key: "avgConfidence", label: "Confianza media", align: "right", fit: true, sortable: true, showFrom: "laptop", render: (r) => fmtConfidence(r.avgConfidence) },
  { key: "costEur", label: "Coste", align: "right", fit: true, sortable: true, render: (r) => costCell(r.costEur) }
];

const MODULE_COLUMNS: CocoaTableColumn<ModuleRow>[] = [
  { key: "moduleCode", label: "Módulo", minWidth: 140, render: (r) => <strong>{r.moduleCode}</strong> },
  { key: "calls", label: "Acciones", align: "right", fit: true, render: (r) => number(r.calls) },
  { key: "successRatePct", label: "% éxito", align: "right", fit: true, render: (r) => fmtPct(r.successRatePct) }
];

const RECENT_COLUMNS: CocoaTableColumn<RecentCall>[] = [
  { key: "toolName", label: "Herramienta", minWidth: 180, render: (c) => <strong>{c.toolName}</strong> },
  { key: "status", label: "Estado", fit: true, render: (c) => statusBadge(c.status) },
  { key: "confidence", label: "Confianza", align: "right", fit: true, hideOnNarrow: true, render: (c) => fmtConfidence(c.confidence) },
  { key: "latencyMs", label: "Tiempo", align: "right", fit: true, render: (c) => fmtMs(c.latencyMs) },
  { key: "costEur", label: "Coste", align: "right", fit: true, render: (c) => costCell(c.costEur) },
  { key: "automationLevel", label: "Automatización", fit: true, showFrom: "laptop", render: (c) => automationLabel(c.automationLevel) },
  { key: "createdAt", label: "Creada", fit: true, showFrom: "desktop", render: (c) => dateTime(c.createdAt) }
];

function PipelineSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={9} />
      <CocoaSkeleton.Grid rows={[[12], [6, 6], [6, 6]]} height={220} />
    </div>
  );
}

export function AiPipelineStatusScreen() {
  // Hosted (InteligenciaArtificialTabs): the container paints eyebrow + H1.
  const hosted = useTabHost() !== null;
  const state = useApiData<PipelineDashboard>("/ai-operations/pipeline/dashboard", {
    pollIntervalMs: 30000,
    query: { organizationId: ORGANIZATION_ID }
  });

  const [sort, setSort] = useState<CocoaTableSort>({ key: "calls", direction: "desc" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ToolCallDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const data = state.data;
  const kpis = data?.kpis;
  const byTool = useMemo(() => toArray<ToolRow>(data?.byTool), [data]);
  const byModule = useMemo(() => toArray<ModuleRow>(data?.byModule), [data]);
  const byStatus = useMemo(() => toArray<PipelineDashboard["byStatus"][number]>(data?.byStatus), [data]);
  const confidenceBuckets = useMemo(() => toArray<PipelineDashboard["confidenceBuckets"][number]>(data?.confidenceBuckets), [data]);
  const latencyTrend = useMemo(() => toArray<PipelineDashboard["latencyTrend"][number]>(data?.latencyTrend), [data]);
  const recentCalls = useMemo(() => toArray<RecentCall>(data?.recentCalls), [data]);
  const anomalies = useMemo(() => toArray<PipelineDashboard["anomalies"][number]>(data?.anomalies), [data]);

  // The table never sorts by itself: `sortBy` + `onSort` are controlled.
  const sortedTools = useMemo(() => {
    const key = sort.key as ToolSortKey;
    const rows = [...byTool];
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.direction === "desc" ? -cmp : cmp;
    });
    return rows;
  }, [byTool, sort]);

  const maxConfBucket = useMemo(() => Math.max(1, ...confidenceBuckets.map((b) => b.count)), [confidenceBuckets]);
  const latencyBars: CocoaBarsDatum[] = useMemo(
    () =>
      latencyTrend.map((d) => ({
        label: date(d.date, "dayMonth"),
        value: d.avgLatencyMs,
        tone: d.calls === 0 ? ("neutral" as const) : ("accent" as const),
        hint: plural(d.calls, "acción", "acciones")
      })),
    [latencyTrend]
  );
  const statusTotal = byStatus.reduce((s, r) => s + r.count, 0);
  const confidenceTotal = confidenceBuckets.reduce((s, b) => s + b.count, 0);

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const result = await apiRequest<ToolCallDetail | { status: "not_found" }>(`/ai-operations/pipeline/calls/${id}`);
      if (result && "status" in result && result.status === "not_found") {
        setDetailError("Esta acción de la IA ya no está disponible.");
      } else {
        setDetail(result as ToolCallDetail);
      }
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  }

  const successStatus = !kpis || kpis.callsTotal === 0 ? "ok" : kpis.successRatePct >= 90 ? "ok" : kpis.successRatePct >= 70 ? "warning" : "critical";
  const mtdCost = costLabel(kpis?.costMtdEur);

  return (
    <CocoaPage
      eyebrow="Configuración · Inteligencia artificial"
      title="Actividad de la IA"
      subtitle={
        hosted
          ? undefined
          : "Actividad de la IA (solo lectura): volumen, tasa de éxito, tiempo de respuesta, confianza, gasto en tokens (uso del modelo) y anomalías. Se actualiza sola cada 30 segundos."
      }
      actions={
        <>
          <CocoaBadge tone="neutral" variant="dot" size="small">
            se actualiza cada 30 s
          </CocoaBadge>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={state.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={state.loading && !data ? "loading" : state.error && !data ? "error" : "ready"}
      skeleton={<PipelineSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: state.error ?? undefined, onRetry: state.refresh }}
      commands={[{ id: "ia-actividad-refresh", label: "Actualizar la actividad de la IA", run: state.refresh }]}
    >
      {kpis ? (
        <CocoaKpiStrip stagger aria-label="Indicadores de la actividad de la IA">
          <CocoaKpi label="Acciones totales" value={number(kpis.callsTotal)} caption="en el periodo" polarity="neutral" status="ok" />
          <CocoaKpi label="Acciones (24 h)" value={number(kpis.calls24h)} caption="últimas 24 horas" polarity="neutral" status="ok" />
          <CocoaKpi label="Tasa de éxito" value={fmtPct(kpis.successRatePct)} caption="completadas / total" polarity="positive-good" status={successStatus} />
          <CocoaKpi label="Tiempo de respuesta medio" value={number(kpis.avgLatencyMs, { maximumFractionDigits: 0 })} unit="ms" caption="media de los valores disponibles" polarity="negative-good" status="ok" />
          <CocoaKpi label="Confianza media" value={fmtConfidence(kpis.avgConfidence)} caption="confianza del modelo" polarity="positive-good" status="ok" />
          <CocoaKpi label="Pendientes de confirmar" value={number(kpis.awaitingConfirmation)} caption="a la espera de una persona" polarity="negative-good" status={kpis.awaitingConfirmation > 0 ? "warning" : "ok"} />
          <CocoaKpi label="Fallidas (24 h)" value={number(kpis.failed24h)} caption="fallos en las últimas 24 h" polarity="negative-good" status={kpis.failed24h > 0 ? "critical" : "ok"} />
          <CocoaKpi label="Coste (mes en curso)" value={mtdCost.text} caption={mtdCost.title ?? "mes natural actual"} polarity="neutral" status="ok" />
          <CocoaKpi label="Tokens (mes en curso)" value={number(kpis.tokensMtd)} caption="uso del modelo · entrada + salida" polarity="neutral" status="ok" />
        </CocoaKpiStrip>
      ) : null}

      <CocoaSection title="Por herramienta" meta={`${plural(byTool.length, "herramienta", "herramientas")} · las 20 primeras`} padding={byTool.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {byTool.length === 0 ? (
          <CocoaState kind="empty" inline title="No se han registrado acciones de la IA en el periodo." />
        ) : (
          <CocoaTable columns={TOOL_COLUMNS} rows={sortedTools} rowKey="toolName" sortBy={sort} onSort={setSort} caption="Actividad por herramienta" aria-label="Actividad por herramienta" />
        )}
      </CocoaSection>

      <CocoaGrid align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Por módulo" meta={plural(byModule.length, "módulo", "módulos")} padding={byModule.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {byModule.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay actividad por módulo en el periodo." />
            ) : (
              <CocoaTable columns={MODULE_COLUMNS} rows={byModule} rowKey="moduleCode" caption="Actividad por módulo" aria-label="Actividad por módulo" />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Desglose por estado" meta={plural(statusTotal, "acción", "acciones")}>
            {byStatus.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay acciones que desglosar." />
            ) : (
              <ul className="c22-section__list" aria-label="Acciones por estado">
                {byStatus.map((row) => (
                  <li key={row.status}>
                    {statusBadge(row.status)}
                    <strong>{number(row.count)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Distribución de la confianza" meta={`${number(confidenceTotal)} con confianza`}>
            {confidenceBuckets.length === 0 || confidenceBuckets.every((b) => b.count === 0) ? (
              <CocoaState kind="empty" inline title="No hay acciones con confianza registrada en el periodo." />
            ) : (
              <div className="cocoa-stack" data-gap="2">
                {confidenceBuckets.map((b) => (
                  <CocoaChart.Progress key={b.bucket} label={b.bucket} value={b.count} max={maxConfBucket} valueLabel={number(b.count)} tone="accent" aria-label={`Confianza ${b.bucket}: ${plural(b.count, "acción", "acciones")}`} />
                ))}
              </div>
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Evolución del tiempo de respuesta" meta="14 días · ms medios por día">
            {latencyTrend.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay datos de tiempo de respuesta." />
            ) : (
              <CocoaChart.Bars data={latencyBars} height={120} valueFormat={fmtMs} aria-label="Tiempo de respuesta medio por día en los últimos 14 días" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection title="Acciones recientes" meta={`${plural(recentCalls.length, "acción", "acciones")} · las 25 últimas`} padding={recentCalls.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {recentCalls.length === 0 ? (
          <CocoaState kind="empty" inline title="No hay acciones de la IA recientes." />
        ) : (
          <CocoaTable
            columns={RECENT_COLUMNS}
            rows={recentCalls}
            rowKey="id"
            selectedKey={selectedId ?? undefined}
            onSelect={(c) => void openDetail(c.id)}
            rowTone={(c) => (c.hasError ? "danger" : undefined)}
            rowTitle={() => "Abrir el detalle de la acción"}
            rowActions={(c) => (
              <CocoaButton
                variant="plain"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  void openDetail(c.id);
                }}
              >
                {ACTIONS.view}
              </CocoaButton>
            )}
            caption="Acciones recientes de la IA"
            aria-label="Acciones recientes de la IA"
          />
        )}
      </CocoaSection>

      <CocoaSection title="Anomalías" meta={plural(anomalies.length, "anomalía", "anomalías")}>
        {anomalies.length === 0 ? (
          <CocoaState kind="empty" inline title="No se han detectado anomalías." />
        ) : (
          <ul className="c22-section__list" aria-label="Anomalías detectadas">
            {anomalies.map((a) => (
              <li key={a.id}>
                <div className="cocoa-stack" data-gap="1">
                  <div className="cocoa-cluster">
                    {severityBadge(a.severity)}
                    <strong>{a.type}</strong>
                    <CocoaBadge tone="warning" variant="outline" size="small">
                      {a.status}
                    </CocoaBadge>
                  </div>
                  <span>{a.description}</span>
                  <span className="cocoa-note">detectada el {dateTime(a.detectedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CocoaSection>

      <CocoaDrawer
        open={selectedId !== null}
        onClose={closeDetail}
        title="Detalle de la acción de la IA"
        subtitle={detail?.toolName}
        side="right"
        size="lg"
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={closeDetail}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {detailLoading ? (
          <CocoaSkeleton variant="text" lines={6} />
        ) : detailError ? (
          <CocoaState kind="error" title="No se pudo cargar el detalle" message={detailError} onRetry={selectedId ? () => void openDetail(selectedId) : undefined} />
        ) : detail ? (
          <div className="cocoa-stack" data-gap="4">
            <CocoaSection title="Información" padding="sm">
              <ul className="c22-section__list" aria-label="Datos de la acción">
                <li>
                  <span>Identificador</span>
                  <strong className="cocoa-mono">{detail.id}</strong>
                </li>
                <li>
                  <span>Herramienta</span>
                  <strong>{detail.toolName}</strong>
                </li>
                <li>
                  <span>Estado</span>
                  {statusBadge(detail.status)}
                </li>
                <li>
                  <span>Modelo</span>
                  <strong>{detail.model ?? "—"}</strong>
                </li>
                <li>
                  <span>Confianza</span>
                  <strong>{fmtConfidence(detail.confidence)}</strong>
                </li>
                <li>
                  <span>Tiempo de respuesta</span>
                  <strong>{fmtMs(detail.latencyMs)}</strong>
                </li>
                <li>
                  <span>Tokens (uso del modelo)</span>
                  <strong>
                    {number(detail.tokensInput)} entrada / {number(detail.tokensOutput)} salida
                  </strong>
                </li>
                <li>
                  <span>Coste</span>
                  <strong>{costCell(detail.costEur)}</strong>
                </li>
                <li>
                  <span>Automatización</span>
                  <strong>{automationLabel(detail.automationLevel)}</strong>
                </li>
                <li>
                  <span>Confirmación</span>
                  <strong>{detail.requiredConfirmation ? `obligatoria${detail.confirmedBy ? ` · por ${detail.confirmedBy}` : ""}` : "no obligatoria"}</strong>
                </li>
                <li>
                  <span>Fecha de creación</span>
                  <strong>{dateTime(detail.createdAt)}</strong>
                </li>
              </ul>
              {detail.errorMessage ? <CocoaState kind="error" inline title={detail.errorMessage} /> : null}
            </CocoaSection>
            <CocoaSection title="Entrada" padding="sm">
              {detail.inputJson ? <pre style={codeStyle}>{JSON.stringify(detail.inputJson, null, 2)}</pre> : <CocoaState kind="empty" inline title="Sin datos de entrada." />}
            </CocoaSection>
            <CocoaSection title="Salida" padding="sm">
              {detail.outputJson ? <pre style={codeStyle}>{JSON.stringify(detail.outputJson, null, 2)}</pre> : <CocoaState kind="empty" inline title="Sin datos de salida." />}
            </CocoaSection>
          </div>
        ) : (
          <CocoaState kind="empty" inline title="No hay detalle disponible." />
        )}
      </CocoaDrawer>
    </CocoaPage>
  );
}
