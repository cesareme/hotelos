// Panel de revenue — /revenue (Tanda 5).
//
// Only real data (plan §2.1): the live signals computed from reservations
// (pace, pickup, forecast accuracy), the pending recommendations of the pricing
// engine and the tools of the revenue module read from the product manifest.
// The sample KPIs, alerts and setup checks that used to sit here under a
// sample-data badge are gone (browser-roles#8).

import { useCallback, useEffect, useState } from "react";
import { getModuleRouteItems } from "@hotelos/product";
import { DEV_MODE_STORAGE_KEY, isDevModeEnabled, urlForScreen } from "../../navigation/nav-tree";
import { openTabPath } from "../../components/cocoa/CocoaRouteTabs";
import {
  fetchPace,
  fetchPickup,
  fetchForecastAccuracy,
  fetchRecommendations,
  type PaceResult,
  type PickupResult,
  type ForecastAccuracyResult,
  type Recommendation
} from "../../services/revenueApi";
import { Spinner } from "../../components/States";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { REVENUE_INSTRUCTIONS } from "../../content/screen-instructions/revenue";
import { ACTIONS } from "../../content/actions";
import { money, plural } from "../../lib/format";
import { shellNavigate, treeHeaderFor } from "../tabs/tab-helpers";

// Menu labels of the tree (Revenue › Panel de revenue), never retyped here.
const HEADER = treeHeaderFor("RevenueHomeDashboard", { eyebrow: "Revenue", title: "Panel de revenue" });

function readDevStorage(): string | null {
  try {
    return window.localStorage.getItem(DEV_MODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Dev-only tools (/desarrollo/*) only show up with `?dev=1` or localStorage anfitorio.dev=1 (Tanda 5 §4.3). */
function devModeOn(): boolean {
  return typeof window !== "undefined" && isDevModeEnabled({ search: window.location.search, storageValue: readDevStorage() });
}

// Real, live signals computed from reservations (Fase B backend): pace, pickup
// and forecast accuracy.
function LiveRevenueSignals({ nonce }: { nonce: number }) {
  const [pace, setPace] = useState<PaceResult | null>(null);
  const [pickup, setPickup] = useState<PickupResult | null>(null);
  const [accuracy, setAccuracy] = useState<ForecastAccuracyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    setLoading(true);
    setError(null);
    Promise.all([fetchPace(), fetchPickup(), fetchForecastAccuracy(undefined, 30)])
      .then(([p, pk, a]) => {
        if (!on) return;
        setPace(p);
        setPickup(pk);
        setAccuracy(a);
      })
      .catch((e) => on && setError(e instanceof Error ? e.message : "No se pudieron cargar las señales."))
      .finally(() => on && setLoading(false));
    return () => {
      on = false;
    };
  }, [nonce]);

  const h90 = pace?.horizons.find((h) => h.horizonDays === 90);
  const h30 = pace?.horizons.find((h) => h.horizonDays === 30);
  const pk7 = pickup?.windows.find((w) => w.windowDays === 7);
  const occAcc = accuracy?.metrics.find((m) => m.metric === "occupancy");

  return (
    <article className="bo-card">
      <div className="bo-card-head">
        <h3>Señales en vivo</h3>
        <span className="bo-chip">calculadas desde las reservas</span>
      </div>
      {loading ? (
        <p className="bo-muted" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Spinner size="sm" /> Cargando señales…</p>
      ) : error ? (
        <p className="bo-muted" style={{ textTransform: "none" }}>No se pudieron cargar las señales en vivo. {error}</p>
      ) : (
        <div className="rev-kpi-grid">
          <article className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head"><span className="rev-kpi-label">Reservado a 30 días</span></div>
            <div className="rev-kpi-value">{h30 ? plural(h30.otbRooms, "noche", "noches", { withCount: true }) : "—"}</div>
            <div className="rev-kpi-delta">{h30 ? money(h30.otbRevenue) : ""}</div>
          </article>
          <article className={`rev-kpi rev-kpi-${(h90?.paceRooms ?? 0) >= 0 ? "ok" : "warn"}`}>
            <div className="rev-kpi-head"><span className="rev-kpi-label">Ritmo a 90 días</span></div>
            <div className="rev-kpi-value">{h90 ? `${h90.paceRooms >= 0 ? "+" : ""}${plural(h90.paceRooms, "noche", "noches", { withCount: true })}` : "—"}</div>
            <div className="rev-kpi-delta">{pace?.comparison.label}</div>
          </article>
          <article className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head"><span className="rev-kpi-label">Captación 7 días</span></div>
            <div className="rev-kpi-value">{pk7 ? plural(pk7.roomNights, "noche", "noches", { withCount: true }) : "—"}</div>
            <div className="rev-kpi-delta">{pk7 ? `${plural(pk7.reservations, "reserva", "reservas", { withCount: true })} · ${money(pk7.revenue)}` : ""}</div>
          </article>
          <article className={`rev-kpi rev-kpi-${(occAcc?.accuracy ?? 0) >= 80 ? "ok" : "warn"}`}>
            <div className="rev-kpi-head"><span className="rev-kpi-label">Precisión de la previsión (ocupación)</span></div>
            <div className="rev-kpi-value">{occAcc?.accuracy != null ? `${occAcc.accuracy}%` : "—"}</div>
            <div className="rev-kpi-delta">{occAcc?.samples ? `${plural(occAcc.samples, "día", "días", { withCount: true })} de contraste` : "sin histórico"}</div>
          </article>
        </div>
      )}
    </article>
  );
}

// Pending recommendations of the pricing engine (real rows of the API), with the
// shortcut to Revenue › Reglas y recomendaciones where they are approved.
function PendingRecommendations({ nonce }: { nonce: number }) {
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    setError(null);
    fetchRecommendations()
      .then((rows) => on && setRecs(rows))
      .catch((e) => on && setError(e instanceof Error ? e.message : "No se pudieron cargar las recomendaciones."));
    return () => {
      on = false;
    };
  }, [nonce]);

  const pending = (recs ?? []).filter((r) => r.status === "pending").length;
  const rulesUrl = urlForScreen("RevenueRules");

  return (
    <article className="bo-card">
      <div className="bo-card-head">
        <h3>Recomendaciones de precio</h3>
        {recs ? <span className={`cm-pill ${pending > 0 ? "cm-pill-warn" : "cm-pill-ok"}`}>{plural(pending, "pendiente", "pendientes", { withCount: true })}</span> : null}
      </div>
      {error ? (
        <p className="bo-muted" style={{ textTransform: "none" }}>{error}</p>
      ) : recs === null ? (
        <p className="bo-muted" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Spinner size="sm" /> Cargando recomendaciones…</p>
      ) : (
        <p>
          {pending > 0
            ? `${plural(pending, "recomendación espera", "recomendaciones esperan", { withCount: true })} aprobación antes de aplicarse a la parrilla de tarifas.`
            : "No hay recomendaciones pendientes de aprobar. Genera nuevas desde Reglas y recomendaciones."}
        </p>
      )}
      <div className="cm-actions">
        <button type="button" className="primary" onClick={() => (rulesUrl ? openTabPath(rulesUrl) : shellNavigate("RevenueRules"))}>
          Abrir reglas y recomendaciones
        </button>
      </div>
    </article>
  );
}

export function RevenueHomeDashboard() {
  const adminRoutes = getModuleRouteItems("revenue_profit_engine", "admin").filter((route) => !route.devOnly || devModeOn());
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <section className="bo-card">
      <CocoaPageHeader
        eyebrow={HEADER.eyebrow}
        title={HEADER.title}
        subtitle="Ritmo, captación y precisión de la previsión calculados desde las reservas, recomendaciones de precio pendientes y acceso directo a las herramientas de revenue."
        actions={
          <button type="button" onClick={refresh}>
            ↻ {ACTIONS.refresh}
          </button>
        }
      />

      <CocoaScreenInstructionsCard
        title={HEADER.title}
        description={REVENUE_INSTRUCTIONS.whatIsThis}
        steps={REVENUE_INSTRUCTIONS.howToUse}
        tip={REVENUE_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="revenue"
      />

      <LiveRevenueSignals nonce={nonce} />

      <div className="bo-grid two">
        <PendingRecommendations nonce={nonce} />

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Configuración de revenue</h3>
          </div>
          <p>Categorías de revenue, planes de tarifa y umbrales de automatización se configuran en Contabilidad y fiscal y en la puesta en marcha de la propiedad.</p>
          <div className="cm-actions">
            <button type="button" onClick={() => shellNavigate("RevenueCategorySetupForm")}>Configurar revenue</button>
            <button type="button" className="primary" onClick={() => shellNavigate("SetupCenterScreen")}>Abrir puesta en marcha</button>
          </div>
        </article>
      </div>

      <article className="bo-card">
        <div className="bo-card-head">
          <h3>Abrir una herramienta</h3>
          <span className="bo-chip">{plural(adminRoutes.length, "herramienta", "herramientas", { withCount: true })} · según permisos</span>
        </div>
        <div className="rev-home-grid">
          {adminRoutes.map((route) => (
            <article key={route.label} className="rev-home-card">
              <div className="bo-card-head">
                <h3>{route.label}</h3>
                <span className={`cm-pill ${route.status === "ready" ? "cm-pill-ok" : "cm-pill-warn"}`}>
                  {route.status === "ready" ? "listo" : route.status === "coming_soon" ? "no disponible" : "requiere configuración"}
                </span>
              </div>
              <p>{route.description}</p>
              <div className="rev-home-foot">
                <button
                  type="button"
                  className="primary"
                  disabled={route.status === "coming_soon"}
                  style={route.status === "coming_soon" ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                  title={route.status === "coming_soon" ? "No disponible en esta propiedad" : undefined}
                  onClick={() => route.url && openTabPath(route.url)}
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
