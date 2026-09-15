// Energy dashboard — Operaciones › Energía y agua (/operaciones/energia).
//
// Cocoa 22 (docs/design/COCOA-22.md §4 · ola 4 · lote 4-C): CocoaPage →
// CocoaKpiStrip → CocoaGrid 6/6 (consumption by meter as a CocoaTable · top
// consumers as a section list) → daily consumption as CocoaChart.Line. Read
// only; GET /dashboards/energy is consolidated every 5 minutes.
//
// Header: CocoaPage paints the page header with the eyebrow and title of
// treeHeaderFor (the menu labels of the tree, never retyped here).

import type { CSSProperties } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { date, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaLineSeries,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
const HEADER = treeHeaderFor("EnergyDashboard", { eyebrow: "Operaciones", title: "Energía y agua" });
const LOAD_ERROR = errorStateFor("el consumo de energía y agua");

type MeterRow = { meterName: string; meterType: string; kwh30d: number; trendPct: number };
type ConsumerRow = { meterName: string; locationName?: string; kwh: number };
type EnergyDashboardData = {
  kpis: {
    totalKwh30d: number;
    kwhPerOccupiedRoom: number;
    tendencyPct90d: number;
    activeMeters: number;
    abnormalReadingsCount: number;
  };
  consumptionByMeter: MeterRow[];
  dailyConsumption: Array<{ date: string; kwh: number }>;
  topConsumers: ConsumerRow[];
};

const EMPTY: EnergyDashboardData = {
  kpis: {
    totalKwh30d: 0,
    kwhPerOccupiedRoom: 0,
    tendencyPct90d: 0,
    activeMeters: 0,
    abnormalReadingsCount: 0
  },
  consumptionByMeter: [],
  dailyConsumption: [],
  topConsumers: []
};

function formatKwh(n: number): string {
  return `${number(n)} kWh`;
}

/** Signed percentage of a trend («+12 %», «−3 %»); zero paints «estable». */
function trendLabel(pct: number): string {
  return pct === 0 ? "estable" : percent(pct, { signDisplay: "exceptZero" });
}

/** Tone of a consumption trend: a rise of 15 % or more is danger, of 5 % or more warning. */
function trendTone(pct: number): CocoaTone {
  if (pct >= 15) return "danger";
  if (pct >= 5) return "warning";
  return "success";
}

function tendencyStatus(pct: number): "ok" | "warning" | "critical" {
  if (pct >= 15) return "critical";
  if (pct >= 5) return "warning";
  return "ok";
}

function abnormalStatus(count: number): "ok" | "warning" | "critical" {
  if (count === 0) return "ok";
  if (count >= 5) return "critical";
  return "warning";
}

// Secondary line under a list row: caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};
const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

const METER_COLUMNS: CocoaTableColumn<MeterRow>[] = [
  { key: "meterName", label: "Contador", render: (r) => <strong>{r.meterName}</strong> },
  { key: "meterType", label: "Tipo", hideOnNarrow: true, render: (r) => r.meterType },
  { key: "kwh30d", label: "kWh (30 d)", align: "right", render: (r) => number(r.kwh30d) },
  {
    key: "trendPct",
    label: "Tendencia",
    align: "right",
    render: (r) => (
      <CocoaBadge tone={trendTone(r.trendPct)} variant="tinted" size="small">
        {trendLabel(r.trendPct)}
      </CocoaBadge>
    )
  }
];

export function EnergyDashboard() {
  const propertyName = getActiveProperty().propertyName;
  const state = useApiData<EnergyDashboardData>(
    `/dashboards/energy?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 300000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, consumptionByMeter, dailyConsumption, topConsumers } = data;
  const pageState = state.loading && !state.data ? "loading" : state.error && !state.data ? "error" : "ready";

  const dailySeries: CocoaLineSeries[] = [
    {
      id: "kwh",
      label: "kWh",
      tone: "accent",
      width: 2,
      points: dailyConsumption.map((d) => ({ x: date(d.date, "dayMonth"), y: d.kwh }))
    }
  ];

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Consumo de los últimos 30 días: kWh totales, kWh por habitación ocupada, tendencia frente al periodo anterior, contadores activos y lecturas anómalas, por contador y por día. Solo lectura; se actualiza cada 5 minutos."
      actions={
        <>
          {state.error && state.data ? (
            <CocoaBadge tone="danger" title={state.error}>
              {STATUS_LABELS.loadError}
            </CocoaBadge>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => state.refresh()} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={<EnergySkeleton />}
      error={{ title: LOAD_ERROR.title, message: LOAD_ERROR.message, onRetry: () => state.refresh() }}
      commands={[{ id: "energy-refresh", label: "Actualizar energía y agua", run: () => state.refresh() }]}
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de energía y agua">
        <CocoaKpi label="Total kWh (30 d)" value={number(kpis.totalKwh30d)} deltaLabel="consumo en la ventana" polarity="neutral" status="ok" />
        <CocoaKpi
          label="kWh por habitación ocupada"
          value={number(kpis.kwhPerOccupiedRoom)}
          deltaLabel="kWh totales entre las noches ocupadas"
          polarity="neutral"
          status="ok"
        />
        <CocoaKpi
          label="Tendencia (90 días)"
          value={percent(kpis.tendencyPct90d, { signDisplay: "exceptZero" })}
          deltaLabel="últimos 30 días frente a los 30 anteriores"
          polarity="neutral"
          status={tendencyStatus(kpis.tendencyPct90d)}
        />
        <CocoaKpi
          label="Contadores activos"
          value={number(kpis.activeMeters)}
          deltaLabel="con lecturas recientes"
          polarity="neutral"
          status={kpis.activeMeters > 0 ? "ok" : "warning"}
        />
        <CocoaKpi
          label="Lecturas anómalas"
          value={number(kpis.abnormalReadingsCount)}
          deltaLabel="retrocesos o valores atípicos en la ventana"
          polarity="neutral"
          status={abnormalStatus(kpis.abnormalReadingsCount)}
        />
      </CocoaKpiStrip>

      <CocoaGrid align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Consumo por contador"
            meta={plural(consumptionByMeter.length, "contador", "contadores")}
            padding={consumptionByMeter.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {consumptionByMeter.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin contadores con lecturas en el periodo seleccionado." />
            ) : (
              <CocoaTable columns={METER_COLUMNS} rows={consumptionByMeter} rowKey="meterName" caption="Consumo por contador" aria-label="Consumo por contador" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Mayores consumidores" meta={plural(topConsumers.length, "contador", "contadores")}>
            {topConsumers.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin consumidores con consumo registrado." />
            ) : (
              <ul className="c22-section__list" aria-label="Mayores consumidores">
                {topConsumers.map((row) => (
                  <li key={row.meterName}>
                    <div className="cocoa-stack" data-gap="1" style={growStyle}>
                      <strong>{row.meterName}</strong>
                      {row.locationName ? <span style={subStyle}>{row.locationName}</span> : null}
                    </div>
                    <CocoaBadge tone="success" variant="tinted" size="small">
                      {formatKwh(row.kwh)}
                    </CocoaBadge>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={12} min={480}>
          <CocoaSection title="Consumo diario" meta={plural(dailyConsumption.length, "día", "días")}>
            {dailyConsumption.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin datos de consumo diario en el periodo." />
            ) : (
              <CocoaChart.Line series={dailySeries} yLabel="kWh" legend={false} valueFormat={formatKwh} aria-label="Consumo diario en kWh de los últimos 30 días" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}

// Mirror skeleton: the KPI strip, the 6/6 row and the full-width chart.
function EnergySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12]]} height={220} />
    </div>
  );
}

export default EnergyDashboard;
