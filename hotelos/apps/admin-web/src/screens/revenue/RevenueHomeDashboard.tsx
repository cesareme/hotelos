import { useEffect, useState } from "react";
import { getModuleRouteItems } from "@hotelos/product";
import {
  fetchPace,
  fetchPickup,
  fetchForecastAccuracy,
  money,
  type PaceResult,
  type PickupResult,
  type ForecastAccuracyResult
} from "../../services/revenueApi";
import { Spinner } from "../../components/States";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { REVENUE_INSTRUCTIONS } from "../../content/screen-instructions/revenue";

type Status = "ok" | "warn" | "error";

type RevenueKpi = {
  label: string;
  value: string;
  delta?: string;
  status: Status;
  forecast?: boolean;
};

type RevenueAlert = {
  title: string;
  detail: string;
  status: Status;
  action: string;
  target: string;
};

const kpis: RevenueKpi[] = [
  { label: "Ocupación (mes en curso)", value: "73,3%", delta: "+6,0 pts vs. año anterior", status: "ok" },
  { label: "ADR (mes en curso)", value: "137,52 €", delta: "-3,20 € vs. año anterior", status: "warn" },
  { label: "RevPAR (mes en curso)", value: "94,33 €", delta: "+7,40 € vs. año anterior", status: "ok" },
  { label: "Previsión 30 días", value: "312k €", forecast: true, status: "ok" },
  { label: "Pickup 7 días", value: "+34 noches", forecast: true, status: "ok" },
  { label: "Recomendaciones pendientes", value: "8", status: "warn" },
  { label: "Confianza de la previsión", value: "76%", forecast: true, status: "warn" },
  { label: "Calidad de datos", value: "82%", status: "warn" }
];

const alertTargetToScreen: Record<string, string> = {
  "rate-grid": "RevenueRules",
  "channel-manager": "ChannelAggregatorHub",
  "channel-manager/mappings": "ChannelMappings",
  "recommendations": "RevenueRules"
};

function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

function navigateToPath(path: string) {
  if (path && window.location.pathname !== path) {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

const alerts: RevenueAlert[] = [
  { title: "Fecha de baja demanda · 29/05", detail: "Ocupación prevista 36%. Revisa tarifa, restricciones y marketing.", status: "warn", action: "Abrir parrilla de tarifas", target: "rate-grid" },
  { title: "Alerta de paridad de canal", detail: "Expedia está por debajo del precio directo en 12 € el 29/05.", status: "error", action: "Abrir Channel Manager", target: "channel-manager" },
  { title: "Falta mapeo de plan de tarifa", detail: "La tarifa móvil no está mapeada en Booking.com — envíos bloqueados.", status: "error", action: "Abrir mapeos", target: "channel-manager/mappings" },
  { title: "Recomendación de IA pendiente de revisión", detail: "8 acciones de precio esperan aprobación antes de que la automatización las aplique.", status: "warn", action: "Abrir recomendaciones", target: "recommendations" }
];

const setupChecks = [
  { label: "Snapshots de previsión", status: "ok" as Status, detail: "El snapshot diario se ejecutó a las 03:12 UTC." },
  { label: "Mapeos de canal", status: "warn" as Status, detail: "Falta 1 mapeo de plan de tarifa." },
  { label: "Planes de tarifa", status: "ok" as Status, detail: "5 planes de tarifa activos con restricciones configuradas." },
  { label: "Generadores de demanda", status: "ok" as Status, detail: "12 eventos en el calendario de demanda este trimestre." },
  { label: "Umbrales de automatización", status: "warn" as Status, detail: "Automatización de precios en pausa — un error de credenciales bloquea Expedia." }
];

function pill(status: Status) {
  if (status === "ok") return <span className="cm-pill cm-pill-ok">ok</span>;
  if (status === "warn") return <span className="cm-pill cm-pill-warn">atención</span>;
  return <span className="cm-pill cm-pill-error">acción</span>;
}

// Real, live signals computed from reservations (Fase B backend): pace, pickup
// and forecast accuracy. Distinct from the sample KPIs above.
function LiveRevenueSignals() {
  const [pace, setPace] = useState<PaceResult | null>(null);
  const [pickup, setPickup] = useState<PickupResult | null>(null);
  const [accuracy, setAccuracy] = useState<ForecastAccuracyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    setLoading(true);
    Promise.all([fetchPace(), fetchPickup(), fetchForecastAccuracy(undefined, 30)])
      .then(([p, pk, a]) => {
        if (!on) return;
        setPace(p);
        setPickup(pk);
        setAccuracy(a);
      })
      .catch((e) => on && setError(e instanceof Error ? e.message : "Error"))
      .finally(() => on && setLoading(false));
    return () => {
      on = false;
    };
  }, []);

  const h90 = pace?.horizons.find((h) => h.horizonDays === 90);
  const h30 = pace?.horizons.find((h) => h.horizonDays === 30);
  const pk7 = pickup?.windows.find((w) => w.windowDays === 7);
  const occAcc = accuracy?.metrics.find((m) => m.metric === "occupancy");

  return (
    <article className="bo-card">
      <div className="bo-card-head">
        <h3>Señales en vivo</h3>
        <span className="bo-status ok" style={{ textTransform: "none" }}>Datos reales</span>
      </div>
      {loading ? (
        <p className="bo-muted" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Spinner size="sm" /> Cargando señales reales…</p>
      ) : error ? (
        <p className="bo-muted">No se pudieron cargar las señales en vivo.</p>
      ) : (
        <div className="rev-kpi-grid">
          <article className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head"><span className="rev-kpi-label">OTB próximos 30 días</span></div>
            <div className="rev-kpi-value">{h30 ? `${h30.otbRooms} noches` : "—"}</div>
            <div className="rev-kpi-delta">{h30 ? money(h30.otbRevenue) : ""}</div>
          </article>
          <article className={`rev-kpi rev-kpi-${(h90?.paceRooms ?? 0) >= 0 ? "ok" : "warn"}`}>
            <div className="rev-kpi-head"><span className="rev-kpi-label">Pace 90 días</span></div>
            <div className="rev-kpi-value">{h90 ? `${h90.paceRooms >= 0 ? "+" : ""}${h90.paceRooms} noches` : "—"}</div>
            <div className="rev-kpi-delta">{pace?.comparison.label}</div>
          </article>
          <article className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head"><span className="rev-kpi-label">Pickup 7 días</span></div>
            <div className="rev-kpi-value">{pk7 ? `${pk7.roomNights} noches` : "—"}</div>
            <div className="rev-kpi-delta">{pk7 ? `${pk7.reservations} reservas · ${money(pk7.revenue)}` : ""}</div>
          </article>
          <article className={`rev-kpi rev-kpi-${(occAcc?.accuracy ?? 0) >= 80 ? "ok" : "warn"}`}>
            <div className="rev-kpi-head"><span className="rev-kpi-label">Precisión previsión (ocup.)</span></div>
            <div className="rev-kpi-value">{occAcc?.accuracy != null ? `${occAcc.accuracy}%` : "—"}</div>
            <div className="rev-kpi-delta">{occAcc?.samples ? `${occAcc.samples} días · backtest` : "sin histórico"}</div>
          </article>
        </div>
      )}
    </article>
  );
}

export function RevenueHomeDashboard() {
  const adminRoutes = getModuleRouteItems("revenue_profit_engine", "admin");
  const errors = alerts.filter((a) => a.status === "error").length;
  const warnings = alerts.filter((a) => a.status === "warn").length;

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Comercial</p>
          <h2>Gestión de revenue</h2>
        </div>
        <div className="bo-pill-row">
          <span className="bo-status info" style={{ textTransform: "none" }}>Datos de ejemplo</span>
          <span className="bo-chip">{errors} requieren acción · {warnings} atención</span>
        </div>
      </div>
      <p>Punto único para Histórico y Previsión, Parrilla de tarifas, Explorador de previsión, Recomendaciones, Channel Manager, Rate Shopper, Calendario de demanda, Simulador de escenarios y la configuración de revenue. Todas las subrutas se registran aquí y respetan los permisos.</p>

      <CocoaScreenInstructionsCard
        title="Gestión de revenue"
        description={REVENUE_INSTRUCTIONS.whatIsThis}
        steps={REVENUE_INSTRUCTIONS.howToUse}
        tip={REVENUE_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="revenue"
      />

      <LiveRevenueSignals />

      <div className="rev-kpi-grid">
        {kpis.map((kpi) => (
          <article key={kpi.label} className={`rev-kpi rev-kpi-${kpi.status}`}>
            <div className="rev-kpi-head">
              <span className="rev-kpi-label">{kpi.label}</span>
              {kpi.forecast ? <span className="rev-kpi-tag">previsión</span> : null}
            </div>
            <div className="rev-kpi-value">{kpi.value}</div>
            {kpi.delta ? <div className="rev-kpi-delta">{kpi.delta}</div> : null}
          </article>
        ))}
      </div>

      <div className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Alertas activas</h3>
            <span className="bo-chip">{alerts.length} alertas</span>
          </div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Estado</th>
                  <th>Alerta</th>
                  <th>Detalle</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={alert.title} className={alert.status === "error" ? "cm-row-error" : alert.status === "warn" ? "cm-row-warn" : undefined}>
                    <td>{pill(alert.status)}</td>
                    <td><strong>{alert.title}</strong></td>
                    <td>{alert.detail}</td>
                    <td><button type="button" onClick={() => navigateTo(alertTargetToScreen[alert.target] ?? "RevenueHomeDashboard")}>{alert.action}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Configuración de revenue</h3>
            <span className="bo-chip">Calidad de datos 82%</span>
          </div>
          <p>Estado: hay que completar la configuración antes de que la automatización pueda aplicar recomendaciones. Ejecuta los pasos siguientes o abre la checklist de configuración.</p>
          <ul className="bo-list">
            {setupChecks.map((check) => (
              <li key={check.label}>
                {pill(check.status)} <strong>{check.label}.</strong> {check.detail}
              </li>
            ))}
          </ul>
          <div className="cm-actions">
            <button type="button" onClick={() => navigateTo("RevenueCategorySetupForm")}>Configurar revenue</button>
            <button type="button" className="primary" onClick={() => navigateTo("PropertySetupWizard")}>Abrir checklist de configuración</button>
          </div>
        </article>
      </div>

      <article className="bo-card">
        <div className="bo-card-head">
          <h3>Abrir una herramienta</h3>
          <span className="bo-chip">{adminRoutes.length} herramientas · respeta permisos</span>
        </div>
        <div className="rev-home-grid">
          {adminRoutes.map((route) => (
            <article key={route.label} className="rev-home-card">
              <div className="bo-card-head">
                <h3>{route.label}</h3>
                <span className={`cm-pill ${route.status === "ready" ? "cm-pill-ok" : "cm-pill-warn"}`}>
                  {route.status === "ready" ? "listo" : route.status === "coming_soon" ? "próximamente" : "requiere configuración"}
                </span>
              </div>
              <p>{route.description}</p>
              <div className="rev-home-foot">
                <button
                  type="button"
                  className="primary"
                  disabled={route.status === "coming_soon"}
                  style={route.status === "coming_soon" ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                  title={route.status === "coming_soon" ? "Próximamente" : undefined}
                  onClick={() => route.path && navigateToPath(route.path)}
                >
                  Abrir
                </button>
              </div>
            </article>
          ))}
        </div>
      </article>
    </section>
  );
}
