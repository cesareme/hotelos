import { useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { createIncident, updateIncident, type IncidentSeverity } from "../../services/safetyApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { SidePanel, DetailRow } from "../../components/SidePanel";

const PROPERTY_ID = getActivePropertyId();

type IncidentRow = { id: string; title: string; severity?: string; status: string; occurredAt?: string; reportedAt?: string; incidentType?: string; description?: string; location?: string; assignedTo?: string; resolvedAt?: string };
type SafetyDashboardData = {
  kpis: { incidents30d: number; criticalIncidents30d: number; safetyChecksCompletedPct: number; nextInspections: number; openIncidents: number };
  incidentsBySeverity: Array<{ severity: string; count: number }>;
  recentIncidents: IncidentRow[];
  upcomingChecks: Array<{ id: string; name: string; dueAt?: string; assignedTo?: string }>;
};
const INCIDENT_TYPE_LABEL: Record<string, string> = { slip_fall: "Resbalón / caída", fire_safety: "Seguridad contra incendios", theft: "Robo / sustracción", medical: "Médico", other: "Otro" };

type Kind = "ok" | "warn" | "error" | "info";
const SEV_LABEL: Record<string, string> = { low: "baja", medium: "media", high: "alta", critical: "crítica" };
const SEV_KIND: Record<string, Kind> = { low: "info", medium: "warn", high: "warn", critical: "error" };
const SEVERITIES: IncidentSeverity[] = ["low", "medium", "high", "critical"];

function fmtNum(v: number | undefined): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(v ?? 0);
}
function fmtDate(v?: string): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

export function SafetyDashboard() {
  const { data, loading, error, refresh } = useApiData<SafetyDashboardData>(
    `/dashboards/safety?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 30000 }
  );
  // Read incidents from the LIVE advanced-records endpoint (same source the
  // "Registrar incidente" action writes to) so new incidents appear instantly.
  const liveIncidents = useApiData<{ items: Array<{ id: string; status?: string; createdAt?: string; payload?: Record<string, unknown> }> }>(
    `/safety/properties/${PROPERTY_ID}/incidents`,
    { pollIntervalMs: 30000 }
  );

  const kpis = data?.kpis ?? { incidents30d: 0, criticalIncidents30d: 0, safetyChecksCompletedPct: 0, nextInspections: 0, openIncidents: 0 };
  const live = liveIncidents.data?.items ?? [];
  const incidents: IncidentRow[] = live.length > 0
    ? live
        .map((r) => ({
          id: r.id,
          title: String(r.payload?.title ?? "Incidente"),
          severity: r.payload?.severity ? String(r.payload.severity) : undefined,
          status: String(r.status ?? "open"),
          incidentType: r.payload?.incidentType ? String(r.payload.incidentType) : undefined,
          description: r.payload?.description ? String(r.payload.description) : undefined,
          location: r.payload?.location ? String(r.payload.location) : undefined,
          occurredAt: String(r.payload?.occurredAt ?? r.createdAt ?? ""),
          reportedAt: r.createdAt ? String(r.createdAt) : undefined
        }))
        .sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""))
    : (data?.recentIncidents ?? []);
  const checks = data?.upcomingChecks ?? [];

  function refreshAll() {
    refresh();
    liveIncidents.refresh();
  }

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = incidents.find((i) => i.id === selectedId) ?? null;
  const [show, setShow] = useState(false);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("medium");
  const [location, setLocation] = useState("");
  const [desc, setDesc] = useState("");

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      refreshAll();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  const handled = (s: string) => s === "resolved" || s === "closed" || s === "updated";

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Operaciones · Seguridad</p>
          <h2 style={{ color: "var(--ink)" }}>Tablero de seguridad e incidentes</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Registra incidentes en vivo, haz seguimiento y revisa las inspecciones de seguridad pendientes.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={refreshAll} disabled={loading}>↻ Actualizar</button>
          <button type="button" className="primary" onClick={() => { setShow((v) => !v); setMsg(null); }}>{show ? "Cancelar" : "+ Registrar incidente"}</button>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {show ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head"><h3>Nuevo incidente</h3></div>
          <div className="bo-grid two">
            <label className="bo-form-field"><span>Título *</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej.: Suelo mojado en recepción" disabled={busy} /></label>
            <label className="bo-form-field"><span>Ubicación</span><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Ej.: Vestíbulo planta 0" disabled={busy} /></label>
          </div>
          <div className="bo-row" style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label className="bo-form-field" style={{ margin: 0 }}><span>Gravedad</span>
              <select value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)} disabled={busy}>
                {SEVERITIES.map((s) => <option key={s} value={s}>{SEV_LABEL[s]}</option>)}
              </select>
            </label>
            <label className="bo-form-field" style={{ flex: 1, minWidth: 200, margin: 0 }}><span>Descripción</span><input value={desc} onChange={(e) => setDesc(e.target.value)} disabled={busy} /></label>
          </div>
          <div className="bo-actions" style={{ marginTop: 8 }}>
            <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => run(async () => {
              await createIncident({ title: title.trim(), severity, location: location || undefined, description: desc || undefined });
              setTitle(""); setLocation(""); setDesc(""); setSeverity("medium"); setShow(false);
            }, "Incidente registrado.")}>Registrar incidente</button>
          </div>
        </article>
      ) : null}

      {loading && !data ? (
        <LoadingBlock label="Cargando seguridad…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={refreshAll} />
      ) : (
        <>
          <div className="rev-kpi-grid">
            <article className={`rev-kpi rev-kpi-${kpis.openIncidents > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Incidentes abiertos</span><span className={`bo-status ${kpis.openIncidents > 0 ? "warn" : "ok"}`}>{kpis.openIncidents > 0 ? "gestionar" : "al día"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.openIncidents)}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.criticalIncidents30d > 0 ? "error" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Críticos (30 d)</span><span className={`bo-status ${kpis.criticalIncidents30d > 0 ? "error" : "ok"}`}>{kpis.criticalIncidents30d > 0 ? "atención" : "ninguno"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.criticalIncidents30d)}</div></article>
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Incidentes (30 d)</span><span className="bo-status info">total</span></div><div className="rev-kpi-value">{fmtNum(kpis.incidents30d)}</div></article>
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Checks completados</span><span className="bo-status ok">%</span></div><div className="rev-kpi-value">{fmtNum(kpis.safetyChecksCompletedPct)}%</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.nextInspections > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Inspecciones próximas</span><span className={`bo-status ${kpis.nextInspections > 0 ? "warn" : "ok"}`}>{kpis.nextInspections > 0 ? "pendientes" : "ninguna"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.nextInspections)}</div></article>
          </div>

          <div className="bo-grid two">
            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Incidentes recientes</h3><span className="bo-chip">{incidents.length}</span></div>
              {incidents.length === 0 ? (
                <p className="bo-muted">Sin incidentes registrados.</p>
              ) : (
                <div className="bo-stack" style={{ gap: 6 }}>
                  {incidents.slice(0, 12).map((i) => (
                    <div key={i.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", borderBottom: "1px solid var(--line-soft)", paddingBottom: 6 }}>
                      <span style={{ minWidth: 0, cursor: "pointer", flex: 1 }} onClick={() => setSelectedId(i.id)} title="Ver ficha">
                        {i.severity ? <span className={`bo-status ${SEV_KIND[i.severity] ?? "info"}`} style={{ fontSize: 10 }}>{SEV_LABEL[i.severity] ?? i.severity}</span> : null}{" "}
                        <strong>{i.title}</strong>{" "}
                        <span className="bo-muted" style={{ fontSize: 12 }}>{fmtDate(i.occurredAt ?? i.reportedAt)}</span>
                      </span>
                      {!handled(i.status) ? (
                        <button type="button" disabled={busy} style={{ minHeight: 30, padding: "2px 10px", fontSize: 12 }} onClick={() => run(() => updateIncident(i.id, { status: "resolved", handledAt: new Date().toISOString() }), "Incidente marcado como gestionado.")}>Marcar gestionado</button>
                      ) : <span className="bo-status ok" style={{ fontSize: 10 }}>gestionado</span>}
                    </div>
                  ))}
                </div>
              )}
            </article>

            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Inspecciones próximas</h3><span className="bo-chip">{checks.length}</span></div>
              {checks.length === 0 ? (
                <EmptyState
                  title="No hay inspecciones de seguridad pendientes"
                  message="Programa una nueva inspección cuando toque revisar extintores, salidas de emergencia u otros chequeos."
                />
              ) : (
                <div className="bo-stack" style={{ gap: 6 }}>
                  {checks.slice(0, 12).map((c) => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, borderBottom: "1px solid var(--line-soft)", paddingBottom: 6 }}>
                      <span><strong>{c.name}</strong>{c.assignedTo ? <span className="bo-muted" style={{ fontSize: 12 }}> · {c.assignedTo}</span> : null}</span>
                      <span className="bo-muted" style={{ fontSize: 12 }}>{fmtDate(c.dueAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </div>
        </>
      )}

      <SidePanel
        open={!!selected}
        title={selected?.title ?? ""}
        subtitle={selected ? `${SEV_LABEL[selected.severity ?? ""] ? "Gravedad " + SEV_LABEL[selected.severity ?? ""] : ""}` : undefined}
        onClose={() => setSelectedId(null)}
        footer={selected && !handled(selected.status) ? (
          <button type="button" className="primary" disabled={busy} onClick={() => run(async () => { await updateIncident(selected.id, { status: "resolved", handledAt: new Date().toISOString() }); setSelectedId(null); }, "Incidente marcado como gestionado.")}>Marcar gestionado</button>
        ) : undefined}
      >
        {selected ? (
          <>
            <DetailRow label="Gravedad">{selected.severity ? <span className={`bo-status ${SEV_KIND[selected.severity] ?? "info"}`}>{SEV_LABEL[selected.severity] ?? selected.severity}</span> : "—"}</DetailRow>
            <DetailRow label="Estado">{handled(selected.status) ? <span className="bo-status ok">gestionado</span> : <span className="bo-status warn">abierto</span>}</DetailRow>
            {selected.incidentType ? <DetailRow label="Tipo">{INCIDENT_TYPE_LABEL[selected.incidentType] ?? selected.incidentType}</DetailRow> : null}
            {selected.location ? <DetailRow label="Ubicación">{selected.location}</DetailRow> : null}
            {selected.assignedTo ? <DetailRow label="Asignado a">{selected.assignedTo}</DetailRow> : null}
            <DetailRow label="Ocurrido">{fmtDate(selected.occurredAt ?? selected.reportedAt)}</DetailRow>
            {selected.resolvedAt ? <DetailRow label="Resuelto">{fmtDate(selected.resolvedAt)}</DetailRow> : null}
            {selected.description ? (
              <div style={{ marginTop: 6 }}>
                <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", marginBottom: 4 }}>Descripción</p>
                <p style={{ margin: 0, color: "var(--ink)", fontSize: 13.5, lineHeight: 1.5 }}>{selected.description}</p>
              </div>
            ) : null}
          </>
        ) : null}
      </SidePanel>
    </section>
  );
}
