import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type Kpis = {
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  unassignedRooms: number;
  overdueDepartures: number;
  pendingBalanceEur: number;
};

type FrontDeskDashboardData = { kpis: Kpis };

function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(value);
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 6 && h < 13) return "Buenos días";
  if (h >= 13 && h < 20) return "Buenas tardes";
  return "Buenas noches";
}

function todayLabel(): string {
  const label = new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function navigateTo(screen: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

const BOARDS: { title: string; detail: string; screen: string; chip: string }[] = [
  { title: "Limpieza (housekeeping)", detail: "Estado de habitaciones y reparto de tareas del equipo de piso.", screen: "HousekeepingDashboard", chip: "pisos" },
  { title: "Mantenimiento", detail: "Incidencias y órdenes de trabajo abiertas.", screen: "MaintenanceDashboard", chip: "averías" },
  { title: "Personal y turnos", detail: "Plantilla del día, presencias y cobertura.", screen: "WorkforceDashboard", chip: "equipo" },
  { title: "Seguridad e incidentes", detail: "Registro y seguimiento de incidentes.", screen: "SafetyDashboard", chip: "seguridad" },
  { title: "Puntos de venta (TPV)", detail: "Restaurante, bar y consumos a la habitación.", screen: "PosDashboard", chip: "F&B" },
  { title: "Compras e inventario", detail: "Pedidos, stock y costes de aprovisionamiento.", screen: "ProcurementDashboard", chip: "costes" }
];

/** Operations manager home: the day's operational pulse + a hub to every board. */
export function OperationsHomeScreen() {
  const { data, loading, error, refresh } = useApiData<FrontDeskDashboardData>(
    `/dashboards/front-desk?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 30000 }
  );

  const kpis: Kpis = data?.kpis ?? {
    arrivalsToday: 0,
    departuresToday: 0,
    inHouseNow: 0,
    unassignedRooms: 0,
    overdueDepartures: 0,
    pendingBalanceEur: 0
  };
  const unassignedKind = kpis.unassignedRooms > 0 ? "warn" : "ok";
  const overdueKind = kpis.overdueDepartures > 0 ? "error" : "ok";
  const propertyName = getActiveProperty().propertyName;

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operaciones · {todayLabel()}</div>
          <h1 className="bo-page-title">{greeting()}, {propertyName}</h1>
          <p className="bo-page-subtitle">
            La foto operativa del día y acceso directo a todos los tableros de tus equipos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          {loading ? <span className="bo-status info">cargando</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻ Actualizar</button>
          <button type="button" onClick={() => navigateTo("LiveTimelineWorkspace")}>Live Timeline</button>
          <button type="button" className="primary" onClick={() => navigateTo("HousekeepingDashboard")}>Tablero de pisos</button>
        </div>
      </div>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Llegadas hoy</span><span className="bo-status info">hoy</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.arrivalsToday)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Salidas hoy</span><span className="bo-status info">hoy</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.departuresToday)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">En el hotel</span><span className="bo-status ok">ocupadas</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.inHouseNow)}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${unassignedKind === "ok" ? "ok" : "warn"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Sin habitación</span><span className={`bo-status ${unassignedKind}`}>{unassignedKind === "ok" ? "al día" : "pendiente"}</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.unassignedRooms)}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${overdueKind === "ok" ? "ok" : "error"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Salidas con retraso</span><span className={`bo-status ${overdueKind}`}>{overdueKind === "ok" ? "a tiempo" : "con retraso"}</span></div>
          <div className="rev-kpi-value">{fmtNumber(kpis.overdueDepartures)}</div>
        </article>
      </div>

      <section className="bo-section">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Tableros operativos</p>
            <h2 style={{ fontSize: 20 }}>Tus equipos, de un vistazo</h2>
          </div>
        </div>
        <div className="bo-grid">
          {BOARDS.map((board) => (
            <article
              key={board.screen}
              className="bo-card"
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              onClick={() => navigateTo(board.screen)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigateTo(board.screen); } }}
            >
              <div className="bo-card-head">
                <h3>{board.title}</h3>
                <span className="bo-chip">{board.chip}</span>
              </div>
              <p>{board.detail}</p>
              <div style={{ marginTop: 12 }}>
                <button type="button" className="ghost" style={{ padding: "4px 0", color: "var(--accent-strong)" }} onClick={(e) => { e.stopPropagation(); navigateTo(board.screen); }}>Abrir →</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
