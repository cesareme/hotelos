// Forecast explorer — /revenue/historico-prevision/explorador (hosted in
// HistoricoPrevisionTabs). Reads the canonical forecast rows of the property
// for the next 30/60/90 days; every figure comes from the server.
//
// Cocoa 22 (ola 5 · lote 5-B): hosted dashboard (DashboardAlojado). Horizon
// select in the actions row → KPI strip (days, confidence, occupancy, ADR,
// RevPAR, revenue) → daily table → honest source footer.
import { useTabHost } from "../tabs/TabHost";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { navigateTo } from "../../lib/navigate";
import { date, money, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaTable,
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// Live shape returned by GET /revenue/properties/:propertyId/forecast
// (see apps/api/src/modules/revenue/forecast.service.ts → mapForecast).
type ForecastRow = {
  id: string;
  propertyId: string;
  forecastDate: string;
  roomTypeId?: string;
  expectedOccupancy: number;
  expectedRoomsSold: number;
  expectedAdr: number;
  expectedRevpar: number;
  expectedRoomRevenue: number;
  expectedTotalRevenue: number;
  confidence: number;
  modelVersion?: string;
  drivers?: unknown;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function rangeFrom(days: number): { from: string; to: string } {
  const today = new Date();
  const to = new Date(today.getTime() + (days - 1) * 86_400_000);
  return { from: isoDate(today), to: isoDate(to) };
}
function fmtPct(value: number, fractionDigits = 1): string {
  // expectedOccupancy is stored as 0..1 in the canonical RevenueForecast table.
  const pct = value > 1.5 ? value : value * 100;
  return percent(pct, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}
function confidenceTone(c: number): CocoaTone {
  const pct = c > 1.5 ? c : c * 100;
  if (pct >= 75) return "success";
  if (pct >= 50) return "warning";
  return "danger";
}
function confidenceStatus(c: number): CocoaKpiStatus {
  const tone = confidenceTone(c);
  return tone === "success" ? "ok" : tone === "warning" ? "warning" : "critical";
}

// Horizon options. listForecasts (apps/api/src/modules/revenue/forecast.service.ts)
// returns up to 400 rows, so 90 top-level days fit comfortably. 30 stays the
// default; the longer windows exist so an imported PMS forecast (48 days for
// the pilot) is fully visible.
const HORIZON_OPTIONS = [30, 60, 90] as const;
type HorizonDays = (typeof HORIZON_OPTIONS)[number];
const HORIZON_SELECT_OPTIONS = HORIZON_OPTIONS.map((days) => ({ value: String(days), label: `Próximos ${days} días` }));

const COLUMNS: CocoaTableColumn<ForecastRow>[] = [
  { key: "forecastDate", label: "Fecha", fit: true, render: (row) => <strong>{date(row.forecastDate, "dayMonth")}</strong> },
  { key: "expectedOccupancy", label: "Ocup. prevista", align: "right", fit: true, render: (row) => fmtPct(Number(row.expectedOccupancy || 0), 1) },
  { key: "expectedRoomsSold", label: "Hab. vendidas", align: "right", fit: true, render: (row) => number(Math.round(Number(row.expectedRoomsSold || 0))), hideOnNarrow: true },
  { key: "expectedAdr", label: "ADR", align: "right", fit: true, render: (row) => money(Number(row.expectedAdr || 0)) },
  { key: "expectedRevpar", label: "RevPAR", align: "right", fit: true, render: (row) => money(Number(row.expectedRevpar || 0)), showFrom: "laptop" },
  { key: "expectedRoomRevenue", label: "Ingresos hab.", align: "right", fit: true, render: (row) => money(Number(row.expectedRoomRevenue || 0)) },
  {
    key: "confidence",
    label: "Confianza",
    align: "right",
    fit: true,
    render: (row) => {
      const c = Number(row.confidence || 0);
      return <CocoaBadge tone={confidenceTone(c)}>{fmtPct(c, 0)}</CocoaBadge>;
    }
  },
  { key: "modelVersion", label: "Modelo", fit: true, render: (row) => <code className="cocoa-mono">{row.modelVersion ?? "—"}</code>, showFrom: "laptop" }
];

// Skeleton espejo: strip of 6 KPI, then the table card.
function ExplorerSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton.Grid rows={[[12]]} height={360} />
    </div>
  );
}

export function RevenueForecastExplorer() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const header = treeHeaderFor("RevenueForecastExplorer", { eyebrow: "Revenue · Histórico y previsión", title: "Explorador de previsión" });
  const propertyId = getActivePropertyId();
  const [horizonDays, setHorizonDays] = useState<HorizonDays>(30);
  const { from, to } = useMemo(() => rangeFrom(horizonDays), [horizonDays]);

  const { data, loading, error, refresh } = useApiData<ForecastRow[]>(
    `/revenue/properties/${propertyId}/forecast`,
    { query: { from, to } }
  );
  const rows = useMemo(() => toArray<ForecastRow>(data), [data]);

  const summary = useMemo(() => {
    if (rows.length === 0) {
      return { days: 0, avgOcc: 0, avgAdr: 0, avgRevpar: 0, totalRevenue: 0, avgConfidence: 0 };
    }
    const sumOcc = rows.reduce((acc, r) => acc + Number(r.expectedOccupancy || 0), 0);
    const sumAdr = rows.reduce((acc, r) => acc + Number(r.expectedAdr || 0), 0);
    const sumRevpar = rows.reduce((acc, r) => acc + Number(r.expectedRevpar || 0), 0);
    const totalRevenue = rows.reduce((acc, r) => acc + Number(r.expectedRoomRevenue || 0), 0);
    const sumConfidence = rows.reduce((acc, r) => acc + Number(r.confidence || 0), 0);
    return {
      days: rows.length,
      avgOcc: sumOcc / rows.length,
      avgAdr: sumAdr / rows.length,
      avgRevpar: sumRevpar / rows.length,
      totalRevenue,
      avgConfidence: sumConfidence / rows.length
    };
  }, [rows]);

  const windowLabel = `Próximos ${horizonDays} días · ${date(from, "short")} → ${date(to, "short")}`;
  const openBoard = () => navigateTo("RevenueHistoryForecastDashboard");

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActiveProperty().propertyName}`}
      title={header.title}
      subtitle={hosted ? undefined : windowLabel}
      actions={
        <>
          <CocoaSelect value={String(horizonDays)} onChange={(v) => setHorizonDays(Number(v) as HorizonDays)} options={HORIZON_SELECT_OPTIONS} size="small" aria-label="Horizonte de previsión" />
          <CocoaBadge tone="success" variant="dot">
            En vivo
          </CocoaBadge>
          {loading && rows.length > 0 ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error && rows.length > 0 ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={loading} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={error && rows.length === 0 ? "error" : loading && rows.length === 0 ? "loading" : rows.length === 0 ? "empty" : "ready"}
      skeleton={<ExplorerSkeleton />}
      empty={{
        title: `No hay previsión generada para los próximos ${horizonDays} días`,
        message: "Genera la previsión desde el cuadro de histórico y previsión.",
        primaryAction: { label: "Abrir histórico y previsión", onClick: openBoard }
      }}
      error={{ title: "No se pudo cargar la previsión", message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "explorador-prevision-refresh", label: "Actualizar el explorador de previsión", run: refresh }]}
    >
      <CocoaKpiStrip stagger aria-label="Resumen de la previsión">
        <CocoaKpi label="Días con previsión" value={number(summary.days)} caption={windowLabel} polarity="neutral" status="ok" />
        <CocoaKpi label="Confianza media" value={fmtPct(summary.avgConfidence, 0)} caption="previsión" polarity="neutral" status={confidenceStatus(summary.avgConfidence)} />
        <CocoaKpi label="Ocupación media" value={fmtPct(summary.avgOcc, 1)} caption="previsión" polarity="neutral" status="ok" />
        <CocoaKpi label="ADR medio" value={money(summary.avgAdr)} caption="previsión" polarity="neutral" status="ok" />
        <CocoaKpi label="RevPAR medio" value={money(summary.avgRevpar)} caption="previsión" polarity="neutral" status="ok" />
        <CocoaKpi label={`Ingresos previstos (${horizonDays} d)`} value={money(summary.totalRevenue)} caption="previsión" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaSection
        title="Previsión por día"
        meta={plural(rows.length, "día", "días")}
        padding="none"
        style={{ overflow: "clip" }}
        footer={
          <span>
            Fuente: GET /revenue/properties/{propertyId}/forecast (range={horizonDays}d). La confianza, la ocupación y el ADR los calcula el servidor desde la tabla canónica RevenueForecast, sin invenciones del cliente.
          </span>
        }
      >
        <CocoaTable columns={COLUMNS} rows={rows} rowKey="id" density="compact" loading={loading && rows.length === 0} caption="Previsión por día" aria-label="Previsión por día" />
      </CocoaSection>
    </CocoaPage>
  );
}
