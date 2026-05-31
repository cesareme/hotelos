import { getActiveOrganizationId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { DataPreview } from "../../components/forms/FormComponents";
import { LoadingBlock } from "../../components/States";

// ---- Sprint 48 — AI Pipeline Status (tool-call telemetry) ----
// Read-only operations dashboard over /ai-operations/pipeline/dashboard.
// Aurora v2 styling (rev-kpi / bo-card / cm-table / cm-pill), consistent with
// the operations dashboards. Polls every 30s. Drill-down fetches the full
// AiToolCall (input/output JSON) on demand from /calls/:id.

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
    costMtdEur: number;
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

const EMPTY: PipelineDashboard = {
  kpis: {
    callsTotal: 0,
    calls24h: 0,
    successRatePct: 0,
    avgLatencyMs: 0,
    avgConfidence: 0,
    awaitingConfirmation: 0,
    failed24h: 0,
    costMtdEur: 0,
    tokensMtd: 0
  },
  byTool: [],
  byModule: [],
  byStatus: [],
  confidenceBuckets: [],
  latencyTrend: [],
  recentCalls: [],
  anomalies: []
};

type ToolSortKey = "calls" | "successRatePct" | "avgLatencyMs" | "avgConfidence" | "costEur";

function statusPill(status: string) {
  const s = status.toLowerCase();
  const cls =
    s === "succeeded"
      ? "cm-pill-ok"
      : s === "failed" || s === "rejected"
        ? "cm-pill-error"
        : "cm-pill-warn";
  return <span className={`cm-pill ${cls}`}>{status}</span>;
}

function severityPill(severity: string) {
  const s = severity.toLowerCase();
  const cls = s === "critical" || s === "high" ? "cm-pill-error" : s === "medium" ? "cm-pill-warn" : "cm-pill-ok";
  return <span className={`cm-pill ${cls}`}>{severity}</span>;
}

function fmtNumber(n: number | null | undefined, fractionDigits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: fractionDigits });
}

function fmtConfidence(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function fmtEur(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `€${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMs(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString()} ms`;
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtDayShort(iso: string): string {
  // iso is YYYY-MM-DD
  const parts = iso.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : iso;
}

function Bar(props: { fraction: number; label: string; danger?: boolean }) {
  const pct = Math.max(0, Math.min(100, props.fraction * 100));
  return (
    <div
      aria-label={props.label}
      title={props.label}
      style={{ width: "100%", height: 10, background: "var(--surface-2, #eee)", borderRadius: 4, overflow: "hidden" }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: props.danger ? "var(--danger-ink, #c0392b)" : "var(--accent-ink, #2a7)"
        }}
      />
    </div>
  );
}

export function AiPipelineStatusScreen() {
  const state = useApiData<PipelineDashboard>("/ai-operations/pipeline/dashboard", {
    pollIntervalMs: 30000,
    query: { organizationId: ORGANIZATION_ID }
  });

  const [sortKey, setSortKey] = useState<ToolSortKey>("calls");
  const [sortDesc, setSortDesc] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ToolCallDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const data = state.data ?? EMPTY;
  const { kpis } = data;

  const sortedTools = useMemo(() => {
    const rows = [...data.byTool];
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === "string" ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number);
      return sortDesc ? -cmp : cmp;
    });
    return rows;
  }, [data.byTool, sortKey, sortDesc]);

  const maxToolCalls = useMemo(
    () => Math.max(1, ...data.latencyTrend.map((d) => d.avgLatencyMs)),
    [data.latencyTrend]
  );
  const maxConfBucket = useMemo(
    () => Math.max(1, ...data.confidenceBuckets.map((b) => b.count)),
    [data.confidenceBuckets]
  );

  function toggleSort(key: ToolSortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  function sortIndicator(key: ToolSortKey): string {
    if (key !== sortKey) return "";
    return sortDesc ? " ↓" : " ↑";
  }

  async function openDetail(id: string) {
    if (selectedId === id) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
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

  const successStatus =
    kpis.callsTotal === 0
      ? "rev-kpi-ok"
      : kpis.successRatePct >= 90
        ? "rev-kpi-ok"
        : kpis.successRatePct >= 70
          ? "rev-kpi-warn"
          : "rev-kpi-error";
  const failedStatus = kpis.failed24h > 0 ? "rev-kpi-error" : "rev-kpi-ok";
  const awaitingStatus = kpis.awaitingConfirmation > 0 ? "rev-kpi-warn" : "rev-kpi-ok";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">IA · Actividad</div>
          <h1 className="bo-page-title">Estado de la IA</h1>
          <p className="bo-page-subtitle">
            Actividad de la IA (solo lectura): volumen, tasa de éxito, tiempo de respuesta,
            confianza, gasto en tokens (uso del modelo) y anomalías. Se actualiza solo cada 30 segundos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => state.refresh()}>↻ Actualizar</button>
        </div>
      </div>

      {state.error ? (
        <section className="bo-card">
          <p style={{ color: "var(--danger-ink)" }}>No se ha podido cargar esta vista ahora mismo. Pulsa Actualizar para reintentar.</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Acciones totales</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.callsTotal)}</div>
          <div className="rev-kpi-delta">en el periodo seleccionado</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Acciones (24h)</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.calls24h)}</div>
          <div className="rev-kpi-delta">últimas 24 horas</div>
        </article>
        <article className={`rev-kpi ${successStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tasa de éxito</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.successRatePct, 1)}%</div>
          <div className="rev-kpi-delta">completadas / total</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tiempo de respuesta medio</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.avgLatencyMs)} ms</div>
          <div className="rev-kpi-delta">media de los valores disponibles</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Confianza media</span></div>
          <div className="rev-kpi-value">{fmtConfidence(kpis.avgConfidence)}</div>
          <div className="rev-kpi-delta">confianza del modelo</div>
        </article>
        <article className={`rev-kpi ${awaitingStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pendientes de confirmar</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.awaitingConfirmation)}</div>
          <div className="rev-kpi-delta">a la espera de confirmación de una persona</div>
        </article>
        <article className={`rev-kpi ${failedStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Fallidas (24h)</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.failed24h)}</div>
          <div className="rev-kpi-delta">fallos en las últimas 24h</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Coste (mes en curso)</span></div>
          <div className="rev-kpi-value">{fmtEur(kpis.costMtdEur)}</div>
          <div className="rev-kpi-delta">mes natural actual</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tokens (uso del modelo, mes en curso)</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.tokensMtd)}</div>
          <div className="rev-kpi-delta">entrada + salida</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Por herramienta</h3>
          <span className="bo-chip">{data.byTool.length} herramientas · top 20</span>
        </div>
        {data.byTool.length === 0 ? (
          <p className="bo-muted">No se han registrado acciones de la IA en el periodo seleccionado.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Herramienta</th>
                <th style={{ textAlign: "right", cursor: "pointer" }} onClick={() => toggleSort("calls")}>
                  Acciones{sortIndicator("calls")}
                </th>
                <th style={{ textAlign: "right", cursor: "pointer" }} onClick={() => toggleSort("successRatePct")}>
                  % éxito{sortIndicator("successRatePct")}
                </th>
                <th style={{ textAlign: "right", cursor: "pointer" }} onClick={() => toggleSort("avgLatencyMs")}>
                  Tiempo medio{sortIndicator("avgLatencyMs")}
                </th>
                <th style={{ textAlign: "right", cursor: "pointer" }} onClick={() => toggleSort("avgConfidence")}>
                  Confianza media{sortIndicator("avgConfidence")}
                </th>
                <th style={{ textAlign: "right", cursor: "pointer" }} onClick={() => toggleSort("costEur")}>
                  Coste{sortIndicator("costEur")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedTools.map((row) => (
                <tr key={row.toolName}>
                  <td><strong>{row.toolName}</strong></td>
                  <td style={{ textAlign: "right" }}>{fmtNumber(row.calls)}</td>
                  <td style={{ textAlign: "right" }}>{fmtNumber(row.successRatePct, 1)}%</td>
                  <td style={{ textAlign: "right" }}>{fmtMs(row.avgLatencyMs)}</td>
                  <td style={{ textAlign: "right" }}>{fmtConfidence(row.avgConfidence)}</td>
                  <td style={{ textAlign: "right" }}>{fmtEur(row.costEur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Por módulo</h3>
            <span className="bo-chip">{data.byModule.length}</span>
          </div>
          {data.byModule.length === 0 ? (
            <p className="bo-muted">No hay actividad por módulo en el periodo seleccionado.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Módulo</th>
                  <th style={{ textAlign: "right" }}>Acciones</th>
                  <th style={{ textAlign: "right" }}>% éxito</th>
                </tr>
              </thead>
              <tbody>
                {data.byModule.map((row) => (
                  <tr key={row.moduleCode}>
                    <td><strong>{row.moduleCode}</strong></td>
                    <td style={{ textAlign: "right" }}>{fmtNumber(row.calls)}</td>
                    <td style={{ textAlign: "right" }}>{fmtNumber(row.successRatePct, 1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Desglose por estado</h3>
            <span className="bo-chip">{data.byStatus.reduce((s, r) => s + r.count, 0)} acciones</span>
          </div>
          {data.byStatus.length === 0 ? (
            <p className="bo-muted">No hay acciones que desglosar.</p>
          ) : (
            <ul className="bo-list">
              {data.byStatus.map((row) => (
                <li key={row.status} style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {statusPill(row.status)}
                  </span>
                  <strong>{fmtNumber(row.count)}</strong>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Distribución de la confianza</h3>
            <span className="bo-chip">{data.confidenceBuckets.reduce((s, b) => s + b.count, 0)} con confianza</span>
          </div>
          {data.confidenceBuckets.length === 0 || data.confidenceBuckets.every((b) => b.count === 0) ? (
            <p className="bo-muted">No hay acciones con confianza registrada en el periodo.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {data.confidenceBuckets.map((b) => (
                <div key={b.bucket} style={{ display: "grid", gridTemplateColumns: "72px 1fr 40px", alignItems: "center", gap: 8 }}>
                  <span className="bo-muted" style={{ fontVariantNumeric: "tabular-nums" }}>{b.bucket}</span>
                  <Bar fraction={b.count / maxConfBucket} label={`${b.bucket}: ${b.count}`} />
                  <span style={{ textAlign: "right" }}>{b.count}</span>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Evolución del tiempo de respuesta (14 días)</h3>
            <span className="bo-chip">ms medios / día</span>
          </div>
          {data.latencyTrend.length === 0 ? (
            <p className="bo-muted">No hay datos de tiempo de respuesta.</p>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
              {data.latencyTrend.map((d) => (
                <div
                  key={d.date}
                  style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}
                  title={`${d.date}: ${d.avgLatencyMs} ms de media sobre ${d.calls} acción(es)`}
                >
                  <div
                    style={{
                      width: "100%",
                      height: `${Math.max(2, (d.avgLatencyMs / maxToolCalls) * 100)}%`,
                      background: d.calls === 0 ? "var(--surface-2, #ddd)" : "var(--accent-ink, #2a7)",
                      borderRadius: "3px 3px 0 0",
                      opacity: d.calls === 0 ? 0.4 : 1
                    }}
                  />
                  <span className="bo-muted" style={{ fontSize: 10, transform: "rotate(-45deg)", whiteSpace: "nowrap" }}>
                    {fmtDayShort(d.date)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Acciones recientes</h3>
          <span className="bo-chip">{data.recentCalls.length} · últimas 25</span>
        </div>
        {data.recentCalls.length === 0 ? (
          <p className="bo-muted">No hay acciones de la IA recientes.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Herramienta</th>
                <th>Estado</th>
                <th style={{ textAlign: "right" }}>Confianza</th>
                <th style={{ textAlign: "right" }}>Tiempo</th>
                <th style={{ textAlign: "right" }}>Coste</th>
                <th>Automatización</th>
                <th>Creada</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.recentCalls.map((c) => (
                <tr key={c.id} style={c.hasError ? { background: "var(--danger-bg, rgba(192,57,43,0.06))" } : undefined}>
                  <td><strong>{c.toolName}</strong></td>
                  <td>{statusPill(c.status)}</td>
                  <td style={{ textAlign: "right" }}>{fmtConfidence(c.confidence)}</td>
                  <td style={{ textAlign: "right" }}>{fmtMs(c.latencyMs)}</td>
                  <td style={{ textAlign: "right" }}>{fmtEur(c.costEur)}</td>
                  <td>{c.automationLevel ?? "—"}</td>
                  <td>{fmtDateTime(c.createdAt)}</td>
                  <td>
                    <button type="button" className="ghost" onClick={() => openDetail(c.id)}>
                      {selectedId === c.id ? "cerrar" : "ver"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedId ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Detalle de la acción de la IA</h3>
            <button type="button" className="ghost" onClick={() => { setSelectedId(null); setDetail(null); }}>Cerrar</button>
          </div>
          {detailLoading ? (
            <LoadingBlock />
          ) : detailError ? (
            <p style={{ color: "var(--danger-ink)" }}>{detailError}</p>
          ) : detail ? (
            <div className="bo-grid two">
              <div>
                <h4>Información</h4>
                <div className="dp-table">
                  <div className="dp-row"><span className="dp-key">id</span><span className="dp-val mono">{detail.id}</span></div>
                  <div className="dp-row"><span className="dp-key">herramienta</span><span className="dp-val">{detail.toolName}</span></div>
                  <div className="dp-row"><span className="dp-key">estado</span><span className="dp-val">{statusPill(detail.status)}</span></div>
                  <div className="dp-row"><span className="dp-key">modelo</span><span className="dp-val">{detail.model ?? "—"}</span></div>
                  <div className="dp-row"><span className="dp-key">confianza</span><span className="dp-val">{fmtConfidence(detail.confidence)}</span></div>
                  <div className="dp-row"><span className="dp-key">tiempo de respuesta</span><span className="dp-val">{fmtMs(detail.latencyMs)}</span></div>
                  <div className="dp-row"><span className="dp-key">tokens (uso del modelo)</span><span className="dp-val">{fmtNumber(detail.tokensInput)} entrada / {fmtNumber(detail.tokensOutput)} salida</span></div>
                  <div className="dp-row"><span className="dp-key">coste</span><span className="dp-val">{fmtEur(detail.costEur)}</span></div>
                  <div className="dp-row"><span className="dp-key">automatización</span><span className="dp-val">{detail.automationLevel ?? "—"}</span></div>
                  <div className="dp-row"><span className="dp-key">confirmación</span><span className="dp-val">{detail.requiredConfirmation ? `obligatoria${detail.confirmedBy ? ` · por ${detail.confirmedBy}` : ""}` : "no obligatoria"}</span></div>
                  <div className="dp-row"><span className="dp-key">fecha de creación</span><span className="dp-val">{fmtDateTime(detail.createdAt)}</span></div>
                  {detail.errorMessage ? (
                    <div className="dp-row"><span className="dp-key">error</span><span className="dp-val" style={{ color: "var(--danger-ink)" }}>{detail.errorMessage}</span></div>
                  ) : null}
                </div>
              </div>
              <div>
                <h4>Entrada</h4>
                <DataPreview data={detail.inputJson} emptyMessage="Sin datos de entrada." />
                <h4 style={{ marginTop: 12 }}>Salida</h4>
                <DataPreview data={detail.outputJson} emptyMessage="Sin datos de salida." />
              </div>
            </div>
          ) : (
            <p className="bo-muted">No hay detalle disponible.</p>
          )}
        </section>
      ) : null}

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Anomalías</h3>
          <span className="bo-chip">{data.anomalies.length}</span>
        </div>
        {data.anomalies.length === 0 ? (
          <p className="bo-muted">No se han detectado anomalías.</p>
        ) : (
          <ul className="bo-list">
            {data.anomalies.map((a) => (
              <li key={a.id} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {severityPill(a.severity)}
                  <strong>{a.type}</strong>
                  <span className="cm-pill cm-pill-warn">{a.status}</span>
                </div>
                <span>{a.description}</span>
                <small className="bo-muted">detectada el {fmtDateTime(a.detectedAt)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
