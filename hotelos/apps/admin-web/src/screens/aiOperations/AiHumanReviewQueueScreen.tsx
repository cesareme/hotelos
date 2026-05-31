import { getActiveOrganizationId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { DataPreview } from "../../components/forms/FormComponents";
import { useToast } from "../../components/Toast";

// ---- Sprint 50 — AI Human Review Queue (HITL) ----
// Triage screen for high-risk / low-confidence AI actions awaiting a human
// decision. Read-only polling every 20s; decisions hit the
// /ai-operations/review/* endpoints. Aurora v2 styling (rev-kpi / bo-card /
// cm-table / cm-pill), consistent with the operations dashboards.

const ORG_ID = getActiveOrganizationId();
const CURRENT_USER_ID = "usr_123";

type ReviewItem = {
  id: string;
  organizationId: string;
  propertyId?: string;
  reviewType: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  payloadJson: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "escalated";
  assignedTo?: string;
  createdAt: string;
  ageMinutes: number;
  slaBreached: boolean;
};

type ReviewStats = {
  pending: number;
  approved24h: number;
  rejected24h: number;
  escalated: number;
  slaBreached: number;
  avgResolutionMinutes: number;
  byReviewType: Array<{ reviewType: string; pending: number }>;
};

const STATUS_FILTERS = ["pending", "approved", "rejected", "escalated"] as const;

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  escalated: "Escalada"
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function fmtReviewType(value: string): string {
  return value
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtDateTime(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function statusPill(status: ReviewItem["status"]) {
  const cls =
    status === "approved"
      ? "cm-pill-ok"
      : status === "rejected"
        ? "cm-pill-error"
        : status === "escalated"
          ? "cm-pill-warn"
          : "cm-pill-warn";
  return <span className={`cm-pill ${cls}`}>{statusLabel(status)}</span>;
}

export function AiHumanReviewQueueScreen() {
  const { showToast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [reviewTypeFilter, setReviewTypeFilter] = useState<string>("");
  const [assignedToMe, setAssignedToMe] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [escalateRole, setEscalateRole] = useState("");
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      organizationId: ORG_ID,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(reviewTypeFilter ? { reviewType: reviewTypeFilter } : {}),
      ...(assignedToMe ? { assignedTo: CURRENT_USER_ID } : {})
    }),
    [statusFilter, reviewTypeFilter, assignedToMe]
  );

  const {
    data: queueData,
    loading,
    error,
    refresh: refreshQueue
  } = useApiData<ReviewItem[]>("/ai-operations/review/queue", {
    pollIntervalMs: 20000,
    query
  });

  const { data: statsData, refresh: refreshStats } = useApiData<ReviewStats>(
    "/ai-operations/review/stats",
    { pollIntervalMs: 20000, query: { organizationId: ORG_ID } }
  );

  const items = queueData ?? [];
  const stats = statsData;
  const reviewTypeOptions = useMemo(() => {
    const set = new Set<string>(items.map((i) => i.reviewType));
    for (const r of stats?.byReviewType ?? []) set.add(r.reviewType);
    return [...set].sort();
  }, [items, stats]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  function refreshAll() {
    refreshQueue();
    refreshStats();
  }

  async function runAction(path: string, body: unknown, key: string) {
    setRunningAction(key);
    setActionError(null);
    setActionMessage(null);
    try {
      await apiRequest(path, { method: "POST", body });
      setActionMessage("Hecho.");
      setNotes("");
      setReason("");
      setEscalateRole("");
      refreshAll();
      const label = key.startsWith("approve")
        ? "Revisión aprobada"
        : key.startsWith("reject")
          ? "Revisión rechazada"
          : key.startsWith("escalate")
            ? "Revisión escalada"
            : key.startsWith("assign")
              ? "Revisión asignada"
              : "Acción aplicada";
      showToast(label, { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      showToast(message, { variant: "error" });
    } finally {
      setRunningAction(null);
    }
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">IA · Revisión humana</div>
          <h1 className="bo-page-title">Cola de revisión humana</h1>
          <p className="bo-page-subtitle">
            Las acciones de IA que una persona debe aprobar antes de ejecutarse: acciones de alto
            riesgo o baja confianza que esperan tu decisión. Ordenadas por antigüedad (plazo). Se actualiza cada 20 s.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={refreshAll}>↻ Actualizar</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }}>
          No se ha podido cargar la cola de revisión ahora mismo. Actualiza para reintentar.
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi rev-kpi-${stats && stats.pending > 0 ? "warn" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pendientes</span></div>
          <div className="rev-kpi-value">{loading && !stats ? "…" : (stats?.pending ?? 0)}</div>
          <div className="rev-kpi-delta">Esperando decisión</div>
        </article>
        <article className={`rev-kpi rev-kpi-${stats && stats.slaBreached > 0 ? "error" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Fuera de plazo</span></div>
          <div className="rev-kpi-value">{loading && !stats ? "…" : (stats?.slaBreached ?? 0)}</div>
          <div className="rev-kpi-delta">Pendiente &gt; 60 min</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Aprobadas (24h)</span></div>
          <div className="rev-kpi-value">{loading && !stats ? "…" : (stats?.approved24h ?? 0)}</div>
          <div className="rev-kpi-delta">Últimas 24 h</div>
        </article>
        <article className={`rev-kpi rev-kpi-${stats && stats.rejected24h > 0 ? "warn" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Rechazadas (24h)</span></div>
          <div className="rev-kpi-value">{loading && !stats ? "…" : (stats?.rejected24h ?? 0)}</div>
          <div className="rev-kpi-delta">Últimas 24 h</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Resolución media</span></div>
          <div className="rev-kpi-value">{loading && !stats ? "…" : `${stats?.avgResolutionMinutes ?? 0}m`}</div>
          <div className="rev-kpi-delta">Tiempo medio de decisión</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Filtros</p>
            <h3>Cola</h3>
          </div>
          <span className="bo-chip">{items.length} elementos</span>
        </div>

        <div className="bo-toolbar" style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
          <label>
            <span className="bo-muted" style={{ marginRight: "0.4rem" }}>Estado</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Todos</option>
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>{statusLabel(s)}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="bo-muted" style={{ marginRight: "0.4rem" }}>Tipo de revisión</span>
            <select value={reviewTypeFilter} onChange={(e) => setReviewTypeFilter(e.target.value)}>
              <option value="">Todos</option>
              {reviewTypeOptions.map((t) => (
                <option key={t} value={t}>{fmtReviewType(t)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            <input
              type="checkbox"
              checked={assignedToMe}
              onChange={(e) => setAssignedToMe(e.target.checked)}
            />
            <span>Asignadas a mí</span>
          </label>
        </div>

        {items.length === 0 ? (
          <p className="bo-muted">Ningún elemento de revisión coincide con estos filtros.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Tipo de revisión</th>
                  <th>Entidad relacionada</th>
                  <th style={{ textAlign: "right" }}>Antigüedad</th>
                  <th>Revisor</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const decided = item.status !== "pending" && item.status !== "escalated";
                  const isRunning = (key: string) => runningAction === `${key}-${item.id}`;
                  return (
                    <tr
                      key={item.id}
                      className={item.slaBreached ? "cm-row-error" : undefined}
                      onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <td><strong>{fmtReviewType(item.reviewType)}</strong></td>
                      <td>
                        {item.relatedEntityType ? (
                          <span>
                            {item.relatedEntityType}
                            {item.relatedEntityId ? <span className="bo-muted"> · {item.relatedEntityId}</span> : null}
                          </span>
                        ) : (
                          <span className="bo-muted">—</span>
                        )}
                      </td>
                      <td
                        style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                      >
                        <span style={item.slaBreached ? { color: "var(--danger-ink)", fontWeight: 600 } : undefined}>
                          {fmtAge(item.ageMinutes)}
                        </span>
                      </td>
                      <td>{item.assignedTo ?? <span className="bo-muted">sin asignar</span>}</td>
                      <td>{statusPill(item.status)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="ghost"
                            disabled={isRunning("assign")}
                            onClick={() =>
                              runAction(
                                `/ai-operations/review/${item.id}/assign`,
                                { userId: CURRENT_USER_ID },
                                `assign-${item.id}`
                              )
                            }
                          >
                            Asignar
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={decided || isRunning("approve")}
                            onClick={() =>
                              runAction(
                                `/ai-operations/review/${item.id}/approve`,
                                {},
                                `approve-${item.id}`
                              )
                            }
                          >
                            Aprobar
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={decided || isRunning("reject")}
                            onClick={() => {
                              setSelectedId(item.id);
                              setActionError("Introduce un motivo en el panel inferior y luego rechaza.");
                            }}
                          >
                            Rechazar
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={decided || isRunning("escalate")}
                            onClick={() =>
                              runAction(
                                `/ai-operations/review/${item.id}/escalate`,
                                { toRole: escalateRole || undefined },
                                `escalate-${item.id}`
                              )
                            }
                          >
                            Escalar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {actionError ? <p style={{ color: "var(--danger-ink)" }}>{actionError}</p> : null}
        {actionMessage ? <p className="bo-muted">{actionMessage}</p> : null}
      </section>

      {selected ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Detalle</p>
              <h3>{fmtReviewType(selected.reviewType)}</h3>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              {statusPill(selected.status)}
              <button type="button" className="ghost" onClick={() => setSelectedId(null)}>Cerrar</button>
            </div>
          </div>

          <div className="bo-grid two">
            <div>
              <p className="bo-muted">Datos</p>
              <div className="dp-table">
                <div className="dp-row"><span className="dp-key">id</span><span className="dp-val">{selected.id}</span></div>
                <div className="dp-row"><span className="dp-key">relacionada</span><span className="dp-val">{selected.relatedEntityType ?? "—"} · {selected.relatedEntityId ?? "—"}</span></div>
                <div className="dp-row"><span className="dp-key">asignada a</span><span className="dp-val">{selected.assignedTo ?? "sin asignar"}</span></div>
                <div className="dp-row"><span className="dp-key">creada</span><span className="dp-val">{fmtDateTime(selected.createdAt)}</span></div>
                <div className="dp-row"><span className="dp-key">antigüedad</span><span className="dp-val">{fmtAge(selected.ageMinutes)}{selected.slaBreached ? " (fuera de plazo)" : ""}</span></div>
              </div>

              <p className="bo-muted" style={{ marginTop: "1rem" }}>Contenido</p>
              <DataPreview data={selected.payloadJson} emptyMessage="Sin contenido." />
            </div>

            <div>
              <p className="bo-muted">Decisión</p>
              <label style={{ display: "block", marginBottom: "0.75rem" }}>
                <span className="bo-muted">Notas de aprobación (opcional)</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  style={{ width: "100%" }}
                  placeholder="Notas adjuntas a la aprobación…"
                />
              </label>
              <label style={{ display: "block", marginBottom: "0.75rem" }}>
                <span className="bo-muted">Motivo del rechazo (obligatorio para rechazar)</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  style={{ width: "100%" }}
                  placeholder="Por qué se rechaza…"
                />
              </label>
              <label style={{ display: "block", marginBottom: "0.75rem" }}>
                <span className="bo-muted">Escalar a rol (opcional)</span>
                <input
                  type="text"
                  value={escalateRole}
                  onChange={(e) => setEscalateRole(e.target.value)}
                  style={{ width: "100%" }}
                  placeholder="p. ej. revenue_manager"
                />
              </label>

              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="ghost"
                  disabled={runningAction === `assign-${selected.id}`}
                  onClick={() =>
                    runAction(`/ai-operations/review/${selected.id}/assign`, { userId: CURRENT_USER_ID }, `assign-${selected.id}`)
                  }
                >
                  Asignar a mí
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={
                    (selected.status !== "pending" && selected.status !== "escalated") ||
                    runningAction === `approve-${selected.id}`
                  }
                  onClick={() =>
                    runAction(
                      `/ai-operations/review/${selected.id}/approve`,
                      { notes: notes || undefined },
                      `approve-${selected.id}`
                    )
                  }
                >
                  Aprobar
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={
                    (selected.status !== "pending" && selected.status !== "escalated") ||
                    !reason.trim() ||
                    runningAction === `reject-${selected.id}`
                  }
                  onClick={() =>
                    runAction(`/ai-operations/review/${selected.id}/reject`, { reason }, `reject-${selected.id}`)
                  }
                >
                  Rechazar
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={
                    (selected.status !== "pending" && selected.status !== "escalated") ||
                    runningAction === `escalate-${selected.id}`
                  }
                  onClick={() =>
                    runAction(
                      `/ai-operations/review/${selected.id}/escalate`,
                      { toRole: escalateRole || undefined },
                      `escalate-${selected.id}`
                    )
                  }
                >
                  Escalar
                </button>
              </div>

              {actionError ? <p style={{ color: "var(--danger-ink)" }}>{actionError}</p> : null}
              {actionMessage ? <p className="bo-muted">{actionMessage}</p> : null}
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
