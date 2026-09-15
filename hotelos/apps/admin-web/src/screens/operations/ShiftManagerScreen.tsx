// Shift Manager Screen — vista del Jefe de Recepción.
//
// Directriz Anfitorio (Nov 2026):
//   "Jefe de recepción: turno, productividad, incidencias críticas, caja,
//    no-shows, upgrades, conflictos."

import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { money, time } from "../../lib/format";
import {
  DegradedBanner,
  DegradedNote,
  DegradedValue,
  isDegraded
} from "../../components/cocoa-extras/DegradedValue";

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
  // QC-06: `safe()` labels whose query failed and fell back to 0/[]. Mirrors
  // `apps/api/src/modules/dashboards/shift-manager.service.ts`.
  degraded: string[];
};

// `safe()` labels in shift-manager.service.ts mapped to the UI slot they feed.
const DEGRADED_LABEL = {
  emergencyFlag: "alerts.emergencyIncidents",
  events: "events.workOrders"
} as const;

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
  return money(value);
}

function fmtTime(iso: string): string {
  return time(iso);
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
  const events = toArray<ShiftEvent>(data?.events);
  const flags = toArray<Flag>(data?.flags);
  const degraded = toArray<string>(data?.degraded);
  const completedRatio = k && (k.checkInsToday + k.pendingArrivals) > 0
    ? Math.round((k.checkInsToday / (k.checkInsToday + k.pendingArrivals)) * 100)
    : 0;
  const checkOutRatio = k && (k.checkOutsToday + k.pendingDepartures) > 0
    ? Math.round((k.checkOutsToday / (k.checkOutsToday + k.pendingDepartures)) * 100)
    : 0;
  const cashNet = k ? k.cashCapturedEur - k.cashRefundedEur : 0;

  return (
    <>
      <CocoaPageHeader
        eyebrow={`Hoy · ${propertyName}`}
        title="Turno"
        subtitle="Productividad del equipo de recepción, caja del día y bloqueos críticos."
        actions={
          <>
            <DegradedBanner degraded={degraded} />
            {loading ? <span className="bo-status info">{STATUS_LABELS.loading}</span> : null}
            {error ? <span className="bo-status error">{error}</span> : null}
            <button type="button" className="ghost" onClick={refresh} aria-label={ACTIONS.refresh} title={ACTIONS.refresh}>↻ {ACTIONS.refresh}</button>
          </>
        }
      />

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
      {flags.length > 0 ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Estado operativo</h3>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
            {flags.map((f) => {
              // The "emergency" flag is computed from a safe()-wrapped counter:
              // when its query failed the API still says "ok · Sin emergencias",
              // so neutralise the tone and show "—" instead of a green tick.
              const flagDegraded = f.id === "emergency" && isDegraded(DEGRADED_LABEL.emergencyFlag, degraded);
              const tone = flagDegraded
                ? "var(--cocoa-label-tertiary)"
                : f.status === "critical" ? "#d23b3b" : f.status === "warning" ? "#d29b00" : "#1f8a4c";
              const bg = flagDegraded
                ? "transparent"
                : f.status === "critical" ? "rgba(210, 59, 59, 0.08)" : f.status === "warning" ? "rgba(210, 155, 0, 0.08)" : "rgba(31, 138, 76, 0.08)";
              const icon = flagDegraded ? "—" : f.status === "critical" ? "✕" : f.status === "warning" ? "!" : "✓";
              return (
                <div key={f.id} style={{ border: `1px solid ${tone}`, borderLeftWidth: 4, borderRadius: 8, padding: 12, background: bg }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ width: 24, height: 24, borderRadius: "50%", background: tone, color: "white", fontSize: 13, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      {icon}
                    </span>
                    <strong style={{ fontSize: 13 }}>{f.title}</strong>
                  </div>
                  <div className="bo-muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {flagDegraded ? (
                      <DegradedValue label={DEGRADED_LABEL.emergencyFlag} degraded={degraded}>{f.detail}</DegradedValue>
                    ) : f.detail}
                  </div>
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
          <span className="bo-muted" style={{ fontSize: 12 }}>
            <DegradedValue label={DEGRADED_LABEL.events} degraded={degraded}>{events.length}</DegradedValue> eventos
          </span>
        </div>
        {events.length === 0 ? (
          <DegradedNote label={DEGRADED_LABEL.events} degraded={degraded}>
            <p className="bo-muted">Sin actividad registrada hoy.</p>
          </DegradedNote>
        ) : (
          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {events.slice(0, 30).map((ev) => {
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
