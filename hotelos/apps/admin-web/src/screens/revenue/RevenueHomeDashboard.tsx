// Panel de revenue — /revenue (Tanda 5).
//
// Only real data (plan §2.1): the live signals computed from reservations
// (pace, pickup, forecast accuracy), the pending recommendations of the pricing
// engine and the tools of the revenue module read from the product manifest.
// The sample KPIs, alerts and setup checks that used to sit here under a
// sample-data badge are gone (browser-roles#8).
//
// Cocoa 22 (ola 5 · lote 5-B): standalone dashboard (DashboardStandalone).
// Instructions card → «Señales en vivo» section with a KPI strip → 6/6 row
// (pending recommendations · configuration) → tool cards in a 3-column grid.
// Each block loads on its own (the header refresh bumps a nonce), so the
// states live inside the sections. Same endpoints, same actions.

import { useCallback, useEffect, useState } from "react";
import { getModuleRouteItems } from "@hotelos/product";
import { DEV_MODE_STORAGE_KEY, isDevModeEnabled, urlForScreen } from "../../navigation/nav-tree";
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
import { getActiveProperty } from "../../services/activeProperty";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { REVENUE_INSTRUCTIONS } from "../../content/screen-instructions/revenue";
import { ACTIONS } from "../../content/actions";
import { money, number, percent, plural } from "../../lib/format";
import { shellNavigate, treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";

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

function signedInt(n: number): string {
  return number(n, { maximumFractionDigits: 0, signDisplay: "exceptZero" });
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
    <CocoaSection title="Señales en vivo" meta="calculadas desde las reservas" headingLevel={2}>
      {loading ? (
        <div aria-hidden="true">
          <CocoaSkeleton.Strip count={4} min={200} />
        </div>
      ) : error ? (
        <CocoaState kind="error" inline title="No se pudieron cargar las señales en vivo." message={error} />
      ) : (
        <CocoaKpiStrip min={200} stagger aria-label="Señales en vivo">
          <CocoaKpi label="Reservado a 30 días" value={h30 ? number(h30.otbRooms) : "—"} unit={h30 ? "noches" : undefined} caption={h30 ? money(h30.otbRevenue) : undefined} polarity="neutral" status="ok" />
          <CocoaKpi label="Ritmo a 90 días" value={h90 ? signedInt(h90.paceRooms) : "—"} unit={h90 ? "noches" : undefined} caption={pace?.comparison.label} polarity="positive-good" status={(h90?.paceRooms ?? 0) >= 0 ? "ok" : "warning"} />
          <CocoaKpi label="Captación 7 días" value={pk7 ? number(pk7.roomNights) : "—"} unit={pk7 ? "noches" : undefined} caption={pk7 ? `${plural(pk7.reservations, "reserva", "reservas")} · ${money(pk7.revenue)}` : undefined} polarity="neutral" status="ok" />
          <CocoaKpi
            label="Precisión de la previsión (ocupación)"
            value={occAcc?.accuracy != null ? percent(occAcc.accuracy) : "—"}
            caption={occAcc?.samples ? `${plural(occAcc.samples, "día", "días")} de contraste` : "sin histórico"}
            polarity="neutral"
            status={(occAcc?.accuracy ?? 0) >= 80 ? "ok" : "warning"}
          />
        </CocoaKpiStrip>
      )}
    </CocoaSection>
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
  const openRules = () => (rulesUrl ? openTabPath(rulesUrl) : shellNavigate("RevenueRules"));

  return (
    <CocoaSection
      title="Recomendaciones de precio"
      meta={recs ? <CocoaBadge tone={pending > 0 ? "warning" : "success"}>{plural(pending, "pendiente", "pendientes")}</CocoaBadge> : undefined}
      footer={
        <CocoaButton variant="filled" tone="accent" size="small" onClick={openRules}>
          Abrir reglas y recomendaciones
        </CocoaButton>
      }
    >
      {error ? (
        <CocoaState kind="error" inline title="No se pudieron cargar las recomendaciones." message={error} />
      ) : recs === null ? (
        <CocoaSkeleton variant="text" lines={2} />
      ) : (
        <p>
          {pending > 0
            ? `${plural(pending, "recomendación espera", "recomendaciones esperan")} aprobación antes de aplicarse a la parrilla de tarifas.`
            : "No hay recomendaciones pendientes de aprobar. Genera nuevas desde Reglas y recomendaciones."}
        </p>
      )}
    </CocoaSection>
  );
}

const ROUTE_STATUS: Record<string, { label: string; tone: CocoaTone }> = {
  ready: { label: "listo", tone: "success" },
  coming_soon: { label: "no disponible", tone: "neutral" }
};
function routeStatus(status: string | undefined): { label: string; tone: CocoaTone } {
  return (status && ROUTE_STATUS[status]) || { label: "requiere configuración", tone: "warning" };
}

export function RevenueHomeDashboard() {
  const adminRoutes = getModuleRouteItems("revenue_profit_engine", "admin").filter((route) => !route.devOnly || devModeOn());
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${getActiveProperty().propertyName}`}
      title={HEADER.title}
      subtitle="Ritmo, captación y precisión de la previsión calculados desde las reservas, recomendaciones de precio pendientes y acceso directo a las herramientas de revenue."
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      commands={[{ id: "panel-revenue-refresh", label: "Actualizar el panel de revenue", run: refresh }]}
    >
      <CocoaScreenInstructionsCard
        title={HEADER.title}
        description={REVENUE_INSTRUCTIONS.whatIsThis}
        steps={REVENUE_INSTRUCTIONS.howToUse}
        tip={REVENUE_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="revenue"
      />

      <LiveRevenueSignals nonce={nonce} />

      <CocoaGrid aria-label="Recomendaciones y configuración" align="start">
        <CocoaSpan cols={6} min={320}>
          <PendingRecommendations nonce={nonce} />
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Configuración de revenue"
            footer={
              <span className="cocoa-cluster">
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => shellNavigate("RevenueCategorySetupForm")}>
                  Configurar revenue
                </CocoaButton>
                <CocoaButton variant="filled" tone="accent" size="small" onClick={() => shellNavigate("SetupCenterScreen")}>
                  Abrir puesta en marcha
                </CocoaButton>
              </span>
            }
          >
            <p>Categorías de revenue, planes de tarifa y umbrales de automatización se configuran en Contabilidad y fiscal y en la puesta en marcha de la propiedad.</p>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection variant="plain" padding="none" title="Abrir una herramienta" meta={`${plural(adminRoutes.length, "herramienta", "herramientas")} · según permisos`} headingLevel={2}>
        {adminRoutes.length === 0 ? (
          <CocoaState kind="empty" inline title="No hay herramientas de revenue disponibles con tus permisos." />
        ) : (
          <CocoaGrid aria-label="Herramientas de revenue" align="start">
            {adminRoutes.map((route) => {
              const status = routeStatus(route.status);
              const unavailable = route.status === "coming_soon";
              return (
                <CocoaSpan key={route.label} cols={4} min={240}>
                  <CocoaSection
                    title={route.label}
                    meta={<CocoaBadge tone={status.tone}>{status.label}</CocoaBadge>}
                    footer={
                      <CocoaButton variant="filled" tone="accent" size="small" disabled={unavailable} title={unavailable ? "No disponible en esta propiedad" : undefined} onClick={() => route.url && openTabPath(route.url)}>
                        Abrir
                      </CocoaButton>
                    }
                  >
                    <p>{route.description}</p>
                  </CocoaSection>
                </CocoaSpan>
              );
            })}
          </CocoaGrid>
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
