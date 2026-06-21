// Night Audit Screen — checklist guiada para el cierre del día.
//
// Directriz HotelOS (Nov 2026):
//   "La auditoría nocturna debe ser una checklist inteligente. El sistema debe
//    decir: 'No puedes cerrar todavía porque hay 3 folios con saldo pendiente
//    y 2 llegadas sin resolver.'"
//
// UI:
//   - Banner con can-close / blocking message
//   - Resumen ok/warning/blocker
//   - Lista de checks con icono color (verde/ámbar/rojo)
//   - Cada check expansible con items afectados + acción de fix
//   - CTA "Cerrar día" deshabilitado si canClose = false
//   - Historial de runs previos

import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { LoadingBlock, ErrorState } from "../../components/States";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type Status = "ok" | "warning" | "blocker";

type CheckItem = { ref: string; label: string; detail?: string };

type Check = {
  id: string;
  title: string;
  status: Status;
  count: number;
  detail: string;
  items?: CheckItem[];
};

type PreflightData = {
  propertyId: string;
  businessDate?: string;
  generatedAt: string;
  canClose: boolean;
  blockingMessage?: string;
  checks: Check[];
  summary: { ok: number; warning: number; blocker: number };
};

type RunRecord = {
  id: string;
  businessDate: string;
  status: string;
  completedAt?: string;
  stepResults?: Array<{ step: string; status: string; detail?: string }>;
};

const STATUS_TONE: Record<Status, { bg: string; border: string; ink: string; icon: string; label: string }> = {
  ok: { bg: "rgba(31, 138, 76, 0.10)", border: "#1f8a4c", ink: "#1f8a4c", icon: "✓", label: "OK" },
  warning: { bg: "rgba(210, 155, 0, 0.10)", border: "#d29b00", ink: "#a47600", icon: "!", label: "ATENCIÓN" },
  blocker: { bg: "rgba(210, 59, 59, 0.10)", border: "#d23b3b", ink: "#a52828", icon: "✕", label: "BLOQUEA" }
};

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

function navigateToWithGuest(screen: string, guestId?: string) {
  if (guestId && typeof window !== "undefined") {
    const url = new URL(window.location.href);
    url.searchParams.set("guestId", guestId);
    window.history.pushState({}, "", url);
  }
  navigateTo(screen);
}

function fixActionFor(checkId: string): { label: string; onClick: () => void } | null {
  switch (checkId) {
    case "arrivals_pending":
    case "unresolved_no_shows":
    case "open_folios_with_balance":
    case "departures_not_checked_out":
      return { label: "Abrir cola operativa", onClick: () => navigateTo("FrontDeskDashboard") };
    case "dirty_in_house_rooms":
      return { label: "Abrir Room Rack", onClick: () => navigateTo("RoomRackScreen") };
    case "unposted_room_charges":
      return { label: "Postear ahora", onClick: () => navigateTo("FrontDeskDashboard") };
    case "invoices_pending":
      return { label: "Ver facturas", onClick: () => navigateTo("FiscalSubmissionsCenter") };
    default:
      return null;
  }
}

export function NightAuditScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const { data: preflight, loading: ploading, error: perror, refresh } = useApiData<PreflightData>(
    `/properties/${propertyId}/night-audit/preflight`,
    { pollIntervalMs: 30000 }
  );
  const { data: runs } = useApiData<RunRecord[]>(`/properties/${propertyId}/night-audit/runs`);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runAudit() {
    if (!preflight?.canClose) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/properties/${propertyId}/night-audit/run`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
      setToast({ kind: "ok", text: "Night audit ejecutado. Día cerrado." });
      showToast("Night audit ejecutado. Día cerrado.", { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error";
      setToast({ kind: "error", text: message });
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
      refresh();
      setTimeout(() => setToast(null), 5000);
    }
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Cierre del día · {propertyName}</div>
          <h1 className="bo-page-title">Night audit guiado</h1>
          <p className="bo-page-subtitle">
            Checklist inteligente antes del cierre. Si algo bloquea, te dirá qué arreglar y dónde.
            {preflight?.businessDate ? ` Fecha de negocio actual: ${preflight.businessDate}.` : null}
          </p>
        </div>
        <div className="bo-page-head-actions">
          {ploading ? <span className="bo-status info">cargando</span> : null}
          {perror ? <span className="bo-status error">{perror}</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻</button>
        </div>
      </div>

      {/* Banner principal — audit 2026-06 · #10: mientras el primer fetch no
          tiene datos, mostramos loading/error en vez del banner rojo engañoso
          ("no puedes cerrar") que aparecía con la API aún cargando. */}
      {!preflight ? (
        perror ? (
          <ErrorState title="No se pudo cargar el cierre del día" message={perror} onRetry={refresh} />
        ) : (
          <LoadingBlock label="Cargando el checklist de cierre…" />
        )
      ) : (
      <article
        className="bo-card"
        style={{
          background: preflight?.canClose ? "rgba(31, 138, 76, 0.08)" : "rgba(210, 59, 59, 0.08)",
          border: `2px solid ${preflight?.canClose ? "#1f8a4c" : "#d23b3b"}`,
          display: "flex",
          gap: 12,
          alignItems: "center"
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: preflight?.canClose ? "#1f8a4c" : "#d23b3b",
            color: "white",
            fontSize: 28,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          {preflight?.canClose ? "✓" : "✕"}
        </div>
        <div style={{ flex: 1 }}>
          <strong style={{ fontSize: 18 }}>
            {preflight?.canClose
              ? "Puedes cerrar el día"
              : "No puedes cerrar todavía"}
          </strong>
          <div className="bo-muted" style={{ fontSize: 13, marginTop: 4 }}>
            {preflight?.blockingMessage ?? "Todos los chequeos críticos están en verde. Ejecuta el night audit cuando estés listo."}
          </div>
        </div>
        <button
          type="button"
          className="primary"
          disabled={!preflight?.canClose || busy}
          onClick={runAudit}
          style={{ minHeight: 48, fontSize: 14, fontWeight: 600, paddingLeft: 18, paddingRight: 18 }}
          title={preflight?.canClose ? "Ejecuta el night audit y avanza la fecha de negocio" : "Resuelve los bloqueos primero"}
        >
          {busy ? "Procesando…" : "Cerrar día →"}
        </button>
      </article>
      )}

      {/* Resumen */}
      {preflight ? (
        <div className="rev-kpi-grid">
          <article className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head">
              <span className="rev-kpi-label">Checks OK</span>
            </div>
            <div className="rev-kpi-value">{preflight.summary.ok}</div>
          </article>
          <article className="rev-kpi rev-kpi-warn">
            <div className="rev-kpi-head">
              <span className="rev-kpi-label">Avisos</span>
            </div>
            <div className="rev-kpi-value">{preflight.summary.warning}</div>
          </article>
          <article className={`rev-kpi ${preflight.summary.blocker > 0 ? "rev-kpi-error" : "rev-kpi-ok"}`}>
            <div className="rev-kpi-head">
              <span className="rev-kpi-label">Bloqueos</span>
            </div>
            <div className="rev-kpi-value">{preflight.summary.blocker}</div>
          </article>
        </div>
      ) : null}

      {/* Lista de checks */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Checklist pre-cierre</h3>
          <span className="bo-muted" style={{ fontSize: 12 }}>
            {preflight ? `${preflight.checks.length} chequeos` : ""}
          </span>
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {(preflight?.checks ?? []).map((check) => {
            const tone = STATUS_TONE[check.status];
            const isExpanded = expanded.has(check.id);
            const fix = fixActionFor(check.id);
            return (
              <li
                key={check.id}
                style={{
                  border: `1px solid ${tone.border}`,
                  borderLeftWidth: 4,
                  borderRadius: 8,
                  padding: 12,
                  background: tone.bg
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        background: tone.border,
                        color: "white",
                        fontSize: 14,
                        fontWeight: 700,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0
                      }}
                    >
                      {tone.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <strong style={{ fontSize: 14 }}>{check.title}</strong>
                        <span
                          className="bo-chip"
                          style={{ background: tone.border, color: "white", fontSize: 10, fontWeight: 700 }}
                        >
                          {tone.label} · {check.count}
                        </span>
                      </div>
                      <div className="bo-muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {check.detail}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {check.items && check.items.length > 0 ? (
                      <button type="button" className="ghost" onClick={() => toggle(check.id)} style={{ fontSize: 12 }}>
                        {isExpanded ? "Ocultar" : `Ver ${check.items.length}`}
                      </button>
                    ) : null}
                    {fix && check.status !== "ok" ? (
                      <button type="button" className="primary" onClick={fix.onClick} style={{ fontSize: 12 }}>
                        {fix.label}
                      </button>
                    ) : null}
                  </div>
                </div>
                {isExpanded && check.items && check.items.length > 0 ? (
                  <ul style={{ listStyle: "none", padding: "8px 0 0 38px", margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    {check.items.map((item) => (
                      <li key={item.ref} style={{ fontSize: 12, color: "var(--ink)" }}>
                        <strong>{item.label}</strong>
                        {item.detail ? <span className="bo-muted"> · {item.detail}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </article>

      {/* Historial */}
      {runs && runs.length > 0 ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Historial de cierres</h3>
            <span className="bo-muted" style={{ fontSize: 12 }}>Últimos {Math.min(runs.length, 30)}</span>
          </div>
          <table className="cm-table">
            <thead>
              <tr>
                <th>Fecha negocio</th>
                <th>Estado</th>
                <th>Pasos</th>
                <th>Completado</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.businessDate}</strong></td>
                  <td>
                    <span className={`bo-status ${r.status === "completed" ? "ok" : r.status === "failed" ? "error" : "info"}`}>
                      {r.status}
                    </span>
                  </td>
                  <td>{r.stepResults?.length ?? 0}</td>
                  <td className="bo-muted">{r.completedAt ? new Date(r.completedAt).toLocaleString("es-ES") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      ) : null}

      {toast ? (
        <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 70 }}>
          <span className={`bo-status ${toast.kind === "ok" ? "ok" : toast.kind === "warn" ? "warn" : "error"}`}>{toast.text}</span>
        </div>
      ) : null}
    </>
  );
}
