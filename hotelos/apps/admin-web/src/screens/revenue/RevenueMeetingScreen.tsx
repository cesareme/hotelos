// Revenue meeting pack — /revenue/reunion (standalone).
//
// Everything the weekly revenue meeting needs on one screen, read from
// GET /revenue/properties/:id/meeting-pack, plus the group displacement
// calculator (POST /revenue/properties/:id/displacement).
//
// Cocoa 22 (ola 5 · lote 5-B): standalone dashboard (DashboardStandalone).
// KPI strip (OTB, pace, pickup, forecast accuracy) → 6/6 row (comp-set stats
// + budget/forecast/actual table) → pending BAR recommendations table →
// displacement calculator (fields in a row, result strip + recommendation
// callout). Same endpoints, same actions.
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { fetchMeetingPack, analyzeDisplacement, type MeetingPack, type Displacement, type BudgetVarianceBlock } from "../../services/revenueApi";
import { getActiveProperty } from "../../services/activeProperty";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, money, number, percent, plural } from "../../lib/format";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// Human label for BudgetVariance.sources.actual (Tanda 2 · REV-03).
function actualSourceLabel(source: string | undefined): string {
  switch (source) {
    case "snapshots":
      return "Real: cierres nocturnos";
    case "snapshots+reservas":
      return "Real: cierres + reservas";
    case "reservas":
      return "Real: reservas (sin cierres)";
    case undefined:
      return "Real: fuente no indicada";
    default:
      return `Real: ${source}`;
  }
}

function fmtPct(value: number | null | undefined): string {
  return percent(value);
}
function signedInt(n: number): string {
  return number(n, { maximumFractionDigits: 0, signDisplay: "exceptZero" });
}

const RISK_LABEL: Record<string, string> = { high: "Alto", medium: "Medio", low: "Bajo" };
function riskTone(level: string): CocoaTone {
  return level === "high" ? "warning" : "success";
}

const RECOMMENDATION_LABEL: Record<string, { label: string; tone: CocoaTone }> = {
  accept: { label: "Aceptar", tone: "success" },
  accept_with_caution: { label: "Aceptar con cautela", tone: "warning" }
};
function recommendationMeta(value: string): { label: string; tone: CocoaTone } {
  return RECOMMENDATION_LABEL[value] ?? { label: "Negociar o declinar", tone: "danger" };
}

// Explanatory line (callout size, secondary label; rule 6 named object).
const noteStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-callout)", lineHeight: "var(--cocoa-leading-text)", color: "var(--cocoa-label-secondary)" };

// ---- budget vs forecast vs actual table --------------------------------------
type VarianceRow = { key: string; label: string; note?: string; block: BudgetVarianceBlock | { roomsSold: number | null; roomRevenue: number; adr: number; occupancyPct: number } | null };

const VARIANCE_COLUMNS: CocoaTableColumn<VarianceRow>[] = [
  {
    key: "label",
    label: "Concepto",
    render: (r) => (
      <>
        <strong>{r.label}</strong>
        {r.note ? <span style={noteStyle}> · {r.note}</span> : null}
      </>
    )
  },
  { key: "occupancyPct", label: "Ocup.", align: "right", fit: true, render: (r) => (r.block ? fmtPct(r.block.occupancyPct) : "—") },
  { key: "adr", label: "ADR", align: "right", fit: true, render: (r) => (r.block ? money(r.block.adr) : "—") },
  { key: "roomRevenue", label: "Ingresos hab.", align: "right", fit: true, render: (r) => (r.block ? money(r.block.roomRevenue) : "—") }
];

// ---- pending BAR recommendations ---------------------------------------------
type RecommendationRow = MeetingPack["topRecommendations"][number];

const RECOMMENDATION_COLUMNS: CocoaTableColumn<RecommendationRow>[] = [
  { key: "targetDate", label: "Fecha", fit: true, render: (r) => <strong>{date(r.targetDate, "medium")}</strong> },
  {
    key: "currentBar",
    label: "BAR actual",
    align: "right",
    fit: true,
    // REV-04: null BAR = nothing published in the rate grid; never a fallback price.
    render: (r) => (r.current?.bar != null ? money(r.current.bar) : <span title="Sin BAR publicado en la parrilla para esta fecha">—</span>)
  },
  { key: "recommendedBar", label: "BAR sugerido", align: "right", fit: true, render: (r) => <strong>{r.recommended?.bar != null ? money(r.recommended.bar) : "—"}</strong> },
  { key: "deltaPct", label: "Variación", align: "right", fit: true, render: (r) => (r.expectedImpact?.deltaPct == null ? "—" : percent(r.expectedImpact.deltaPct, { signDisplay: "exceptZero" })) },
  { key: "riskLevel", label: "Riesgo", fit: true, render: (r) => <CocoaBadge tone={riskTone(r.riskLevel)}>{RISK_LABEL[r.riskLevel] ?? r.riskLevel}</CocoaBadge> }
];

// Skeleton espejo: strip of 4 KPI, then 6/6 · 12 · 12.
function MeetingSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12], [12]]} height={200} />
    </div>
  );
}

export function RevenueMeetingScreen() {
  const header = treeHeaderFor("RevenueMeeting", { eyebrow: "Revenue", title: "Reunión de revenue" });
  const [pack, setPack] = useState<MeetingPack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Displacement calculator
  const [arrival, setArrival] = useState("2026-06-10");
  const [departure, setDeparture] = useState("2026-06-13");
  const [rooms, setRooms] = useState("10");
  const [rate, setRate] = useState("95");
  const [disp, setDisp] = useState<Displacement | null>(null);
  const [dispBusy, setDispBusy] = useState(false);
  const [dispError, setDispError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPack(await fetchMeetingPack());
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el pack de reunión.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runDisplacement() {
    setDispBusy(true);
    setDispError(null);
    try {
      setDisp(await analyzeDisplacement({ arrivalDate: arrival, departureDate: departure, roomsPerNight: Number(rooms), groupRate: Number(rate) }));
    } catch (e) {
      // QC-06: a failed analysis is shown, not rendered as "no result".
      setDisp(null);
      setDispError(e instanceof Error ? e.message : "No se pudo analizar el desplazamiento.");
    } finally {
      setDispBusy(false);
    }
  }

  const variance = pack?.budgetVariance ?? null;
  const varianceSources = variance?.sources;
  const sourceWarns = varianceSources?.actual === "reservas" || (variance?.fallbackDays ?? 0) > 0;
  const sourceTitle = varianceSources
    ? `Real: ${varianceSources.actual}${variance?.snapshotDays != null ? ` · ${variance.snapshotDays} días con cierre` : ""}${variance?.fallbackDays != null ? ` · ${variance.fallbackDays} días desde reservas` : ""} · Previsión: ${varianceSources.forecast ?? "no aplica"}`
    : "El API no ha indicado la fuente del dato";

  const h = (n: number) => pack?.pace.horizons.find((x) => x.horizonDays === n);
  const pk = (n: number) => pack?.pickup.windows.find((x) => x.windowDays === n);
  const occAcc = pack?.forecastAccuracy.find((m) => m.metric === "occupancy");
  const adrAcc = pack?.forecastAccuracy.find((m) => m.metric === "adr");
  const h30 = h(30);
  const h90 = h(90);
  const pk7 = pk(7);

  const varianceRows: VarianceRow[] = variance
    ? [
        { key: "budget", label: "Presupuesto", block: variance.budget },
        { key: "forecast", label: "Previsión", note: variance.forecast ? undefined : "Mes cerrado: sin previsión", block: variance.forecast },
        { key: "actual", label: "Real", block: variance.actual }
      ]
    : [];

  const recommendation = disp ? recommendationMeta(disp.recommendation) : null;

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActiveProperty().propertyName}`}
      title={header.title}
      subtitle="Todo lo que necesita la reunión semanal en una pantalla: ritmo de ventas, pickup, precisión de la previsión, competencia, presupuesto frente a previsión y real, recomendaciones pendientes y una calculadora de desplazamiento de grupos."
      actions={
        <>
          {error && pack ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} loading={loading} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !pack ? "loading" : !pack ? "error" : "ready"}
      skeleton={<MeetingSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? "Sin datos", onRetry: () => void load() }}
      commands={[
        { id: "reunion-revenue-refresh", label: "Actualizar el pack de reunión", run: () => void load() },
        { id: "reunion-revenue-displacement", label: "Analizar el desplazamiento del grupo", run: () => void runDisplacement() }
      ]}
    >
      {pack ? (
        <>
          <CocoaKpiStrip stagger aria-label="Ritmo, pickup y precisión">
            <CocoaKpi label="OTB 30 días" value={number(h30?.otbRooms ?? 0)} unit="noches" caption={money(h30?.otbRevenue ?? 0)} polarity="neutral" status="ok" />
            <CocoaKpi label="Pace 90 días" value={signedInt(h90?.paceRooms ?? 0)} unit="noches" caption={pack.pace.comparison.label} polarity="positive-good" status={(h90?.paceRooms ?? 0) >= 0 ? "ok" : "warning"} />
            <CocoaKpi label="Pickup 7 días" value={number(pk7?.roomNights ?? 0)} unit="noches" caption={`${plural(pk7?.reservations ?? 0, "reserva", "reservas")} · ${money(pk7?.revenue ?? 0)}`} polarity="neutral" status="ok" />
            <CocoaKpi
              label="Precisión de la previsión"
              value={occAcc?.accuracy != null ? percent(occAcc.accuracy) : "—"}
              caption={`ADR ${adrAcc?.accuracy != null ? percent(adrAcc.accuracy) : "—"}`}
              polarity="neutral"
              status={(occAcc?.accuracy ?? 0) >= 80 ? "ok" : "warning"}
            />
          </CocoaKpiStrip>

          <CocoaGrid aria-label="Competencia y presupuesto" align="start">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Comp-set (próximos 14 días)" meta={plural(pack.compSet.samples, "muestra", "muestras")}>
                {pack.compSet.median == null ? (
                  <CocoaState kind="empty" inline title="Sin tarifas de comp-set." message="Ejecuta un sondeo en Rate Shopper." />
                ) : (
                  <div className="cocoa-row" data-gap="4" data-align="start">
                    <CocoaStat label="Mínimo" value={money(pack.compSet.min ?? 0)} />
                    <CocoaStat label="Mediana" value={money(pack.compSet.median)} size="large" />
                    <CocoaStat label="Máximo" value={money(pack.compSet.max ?? 0)} />
                  </div>
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection
                title="Presupuesto, previsión y real"
                meta={
                  <span className="cocoa-cluster">
                    <CocoaBadge tone="neutral">{pack.budgetVariance.month}</CocoaBadge>
                    {/* Source badge (REV-03): says where «Real» comes from and how many past days lacked a night-audit snapshot. */}
                    <CocoaBadge tone={sourceWarns ? "warning" : "neutral"} title={sourceTitle}>
                      {actualSourceLabel(varianceSources?.actual)}
                      {variance?.fallbackDays ? ` · ${variance.fallbackDays} d sin cierre` : ""}
                    </CocoaBadge>
                  </span>
                }
                padding="none"
                style={{ overflow: "clip" }}
              >
                <CocoaTable columns={VARIANCE_COLUMNS} rows={varianceRows} rowKey="key" density="compact" caption="Presupuesto, previsión y real del mes" aria-label="Presupuesto, previsión y real del mes" />
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaSection title="Recomendaciones de BAR pendientes" meta={plural(pack.topRecommendations.length, "pendiente", "pendientes")} padding={pack.topRecommendations.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {pack.topRecommendations.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay recomendaciones pendientes." message="Genera nuevas en «Reglas y recomendaciones de BAR»." />
            ) : (
              <CocoaTable columns={RECOMMENDATION_COLUMNS} rows={pack.topRecommendations} rowKey="id" density="compact" caption="Recomendaciones de BAR pendientes" aria-label="Recomendaciones de BAR pendientes" />
            )}
          </CocoaSection>

          <CocoaSection title="Análisis de desplazamiento de grupos">
            <p style={noteStyle}>Evalúa si un grupo compensa frente al transitorio que desplazaría a la tarifa de previsión.</p>
            <div className="cocoa-row" data-gap="2" data-align="end">
              <CocoaField label="Entrada">
                <CocoaDatePicker value={arrival} onChange={setArrival} max={departure} size="small" />
              </CocoaField>
              <CocoaField label="Salida">
                <CocoaDatePicker value={departure} onChange={setDeparture} min={arrival} size="small" />
              </CocoaField>
              <CocoaField label="Habitaciones por noche">
                <CocoaInput value={rooms} onChange={setRooms} type="number" inputMode="numeric" min={1} size="small" style={{ width: 120 }} />
              </CocoaField>
              <CocoaField label="Tarifa del grupo (€)">
                <CocoaInput value={rate} onChange={setRate} type="number" inputMode="decimal" min={0} size="small" style={{ width: 120 }} />
              </CocoaField>
              <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void runDisplacement()} loading={dispBusy} disabled={dispBusy}>
                Analizar
              </CocoaButton>
            </div>
            {dispError ? (
              <CocoaCallout tone="danger" role="alert" title="No se pudo analizar el desplazamiento">
                {dispError}
              </CocoaCallout>
            ) : null}
            {disp && recommendation ? (
              <>
                <CocoaKpiStrip min={200} aria-label="Resultado del desplazamiento">
                  <CocoaKpi label="Ingresos del grupo" value={money(disp.groupRevenue)} polarity="neutral" status="ok" />
                  <CocoaKpi label="Transitorio desplazado" value={money(disp.displacedRevenue)} polarity="negative-good" status="warning" />
                  <CocoaKpi label="Beneficio neto" value={money(disp.netBenefit)} polarity="positive-good" status={disp.netBenefit >= 0 ? "ok" : "critical"} />
                </CocoaKpiStrip>
                <CocoaCallout tone={recommendation.tone} title={`Recomendación: ${recommendation.label}`} role="status">
                  {plural(disp.roomsPerNight, "habitación por noche", "habitaciones por noche")} a {money(disp.groupRate)} del {date(disp.arrivalDate, "medium")} al {date(disp.departureDate, "medium")}.
                </CocoaCallout>
              </>
            ) : null}
          </CocoaSection>
        </>
      ) : null}
    </CocoaPage>
  );
}
