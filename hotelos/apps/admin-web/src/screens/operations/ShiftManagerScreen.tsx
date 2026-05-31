// Shift Manager Screen — vista del Jefe de Recepción.
//
// Directriz HotelOS (Nov 2026):
//   "Jefe de recepción: turno, productividad, incidencias críticas, caja,
//    no-shows, upgrades, conflictos."

import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";

type Kpis = {
  checkInsToday: number;
  checkOutsToday: number;
  pendingArrivals: number;
  pendingDepartures: number;
  noShowsToday: number;
  cancellationsToday: number;
  cashCapturedEur: number;
  cashRefundedEur: number;
  unpaidBalanceEur: number;
  unassignedArrivals: number;
  overbookingCount: number;
  emergencyIncidents: number;
  blockedRooms: number;
};

type ShiftEvent = {
  id: string;
  timestamp: string;
  type: string;
  title: string;
  detail?: string;
  amount?: number;
  importance: "info" | "highlight" | "alert";
};

type Flag = { id: string; status: "critical" | "warning" | "ok"; title: string; detail: string };

type Data = {
  generatedAt: string;
  propertyId: string;
  kpis: Kpis;
  events: ShiftEvent[];
  flags: Flag[];
};

const EVENT_ICON: Record<string, string> = {
  check_in: "🔑",
  check_out: "👋",
  no_show: "⛔",
  cancellation: "❌",
  incident: "🛎",
  payment: "💳",
  guest_request: "💬"
};

function fmtEur(value: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

export function ShiftManagerScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { data, loading, error, refresh } = useApiData<Data>(
    `/dashboards/shift-manager?propertyId=${propertyId}`,
    { pollIntervalMs: 30000 }
  );

  const k = data?.kpis;
  const completedRatio = k && (k.checkInsToday + k.pendingArrivals) > 0
    ? Math.round((k.checkInsToday / (k.checkInsToday + k.pendingArrivals)) * 100)
    : 0;
  const checkOutRatio = k && (k.checkOutsToday + k.pendingDepartures) > 0
    ? Math.round((k.checkOutsToday / (k.checkOutsToday + k.pendingDepartures)) * 100)
    : 0;
  const cashNet = k ? k.cashCapturedEur - k.cashRefundedEur : 0;

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Supervisión · Jefe de Recepción</div>
          <h1 className="bo-page-title">Turno de hoy · {propertyName}</h1>
          <p className="bo-page-subtitle">
            Productividad del equipo, caja del día y bloqueos críticos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          {loading ? <span className="bo-status info">cargando</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻</button>
        </div>
      </div>

      {/* Productividad / KPIs principales */}
      {k ? (
        <>
          <article className="bo-card" style={{ background: "var(--surface)" }}>
            <div className="bo-card-head">
              <h3 style={{ color: "var(--ink)" }}>Productividad del turno</h3>
            </div>
            <div className="rev-kpi-grid">
              <article className="rev-kpi rev-kpi-ok">
                <div className="rev-kpi-head">
                  <span className="rev-kpi-label">Check-ins hechos</span>
                  <span className="bo-chip">{completedRatio}%</span>
                </div>
                <div className="rev-kpi-value">{k.checkInsToday}</div>
                <div className="bo-muted" style={{ fontSize: 11, marginTop: 2 }}>
                  {k.pendingArrivals} pendiente{k.pendingArrivals === 1 ? "" : "s"}
                </div>
              </article>
              <article className="rev-kpi rev-kpi-ok">
                <div className="rev-kpi-head">
                  <span className="rev-kpi-label">Check-outs hechos</span>
                  <span className="bo-chip">{checkOutRatio}%</span>
                </div>
                <div className="rev-kpi-value">{k.checkOutsToday}</div>
                <div className="bo-muted" style={{ fontSize: 11, marginTop: 2 }}>
                  {k.pendingDepartures} pendiente{k.pendingDepartures === 1 ? "" : "s"}
                </div>
              </article>
              <article className={`rev-kpi ${k.noShowsToday > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
                <div className="rev-kpi-head">
                  <span className="rev-kpi-label">No-shows</span>
                </div>
                <div className="rev-kpi-value">{k.noShowsToday}</div>
              </article>
              <article className={`rev-kpi ${k.cancellationsToday > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
                <div className="rev-kpi-head">
                  <span className="rev-kpi-label">Cancelaciones</span>
                </div>
                <div className="rev-kpi-value">{k.cancellationsToday}</div>
              </article>
            </div>
          </article>

          {/* Caja */}
          <article className="bo-card" style={{ background: "var(--surface)" }}>
            <div className="bo-card-head">
              <h3 style={{ color: "var(--ink)" }}>Caja del día</h3>
              <button type="button" className="ghost" onClick={() => navigateTo("FinancePositionDashboard")}>
                Ver detalle →
              </button>
            </div>
            <div className="rev-kpi-grid">
              <article className="rev-kpi rev-kpi-ok">
                <div className="rev-kpi-head"><span className="rev-kpi-label">Cobrado hoy</span></div>
                <div className="rev-kpi-value">{fmtEur(k.cashCapturedEur)}</div>
              </article>
              <article className={`rev-kpi ${k.cashRefundedEur > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
                <div className="rev-kpi-head"><span className="rev-kpi-label">Reembolsado</span></div>
                <div className="rev-kpi-value">{fmtEur(k.cashRefundedEur)}</div>
              </article>
              <article className="rev-kpi rev-kpi-ok">
                <div className="rev-kpi-head"><span className="rev-kpi-label">Neto</span></div>
                <div className="rev-kpi-value">{fmtEur(cashNet)}</div>
              </article>
              <article className={`rev-kpi ${k.unpaidBalanceEur > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
                <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo abierto</span></div>
                <div className="rev-kpi-value">{fmtEur(k.unpaidBalanceEur)}</div>
              </article>
            </div>
          </article>
        </>
      ) : null}

      {/* Flags / Conflictos */}
      {data?.flags && data.flags.length > 0 ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Estado operativo</h3>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
            {data.flags.map((f) => {
              const tone = f.status === "critical" ? "#d23b3b" : f.status === "warning" ? "#d29b00" : "#1f8a4c";
              const bg = f.status === "critical" ? "rgba(210, 59, 59, 0.08)" : f.status === "warning" ? "rgba(210, 155, 0, 0.08)" : "rgba(31, 138, 76, 0.08)";
              const icon = f.status === "critical" ? "✕" : f.status === "warning" ? "!" : "✓";
              return (
                <div key={f.id} style={{ border: `1px solid ${tone}`, borderLeftWidth: 4, borderRadius: 8, padding: 12, background: bg }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ width: 24, height: 24, borderRadius: "50%", background: tone, color: "white", fontSize: 13, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      {icon}
                    </span>
                    <strong style={{ fontSize: 13 }}>{f.title}</strong>
                  </div>
                  <div className="bo-muted" style={{ fontSize: 12, marginTop: 6 }}>{f.detail}</div>
                </div>
              );
            })}
          </div>
        </article>
      ) : null}

      {/* Timeline del turno */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Eventos del turno</h3>
          <span className="bo-muted" style={{ fontSize: 12 }}>{data?.events.length ?? 0} eventos</span>
        </div>
        {!data?.events.length ? (
          <p className="bo-muted">Sin actividad registrada hoy.</p>
        ) : (
          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {data.events.slice(0, 30).map((ev) => {
              const tone = ev.importance === "alert" ? "#d23b3b" : ev.importance === "highlight" ? "#6f3ad2" : "#888";
              return (
                <li key={ev.id} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ width: 28, fontSize: 18, textAlign: "center" }}>{EVENT_ICON[ev.type] ?? "•"}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13 }}>{ev.title}</strong>
                      {ev.amount !== undefined ? (
                        <span style={{ fontWeight: 600, color: ev.amount < 0 ? "var(--danger, #d23b3b)" : "var(--ink)" }}>
                          {fmtEur(ev.amount)}
                        </span>
                      ) : null}
                    </div>
                    {ev.detail ? <div className="bo-muted" style={{ fontSize: 12 }}>{ev.detail}</div> : null}
                  </div>
                  <div className="bo-muted" style={{ fontSize: 11, whiteSpace: "nowrap", color: tone }}>{fmtTime(ev.timestamp)}</div>
                </li>
              );
            })}
          </ol>
        )}
      </article>
    </>
  );
}
