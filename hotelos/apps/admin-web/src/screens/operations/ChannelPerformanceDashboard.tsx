// Channel performance — Informes › Rendimiento de canales (/informes/canales).
//
// Cocoa 22 (ola 9 · lote 9-A): standalone dashboard (DashboardStandalone):
// KPI strip → 8/4 row (channel mix table + share donut) → 6/6 row
// (profitability table + sync status list) → parity alerts table. Read only;
// polls every two minutes.

import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { dateTime, money, number, percent, plural } from "../../lib/format";
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
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type ChannelMixRow = { channelName: string; reservations: number; revenueEur: number; sharePct: number };
type ProfitableRow = { channelName: string; netRevenueEur: number; commissionEur: number; marginPct: number };
type ParityAlert = { id: string; channelName?: string; severity?: string; detectedAt: string; resolvedAt?: string; description?: string };
type SyncJobStatus = { status: string; count: number };

type ChannelPerformanceData = {
  kpis: {
    activeChannels: number;
    openParityAlerts: number;
    avgCommissionPct: number;
    reservations30d: number;
    revenue30dEur: number;
  };
  channelMix: ChannelMixRow[];
  topProfitableChannels: ProfitableRow[];
  recentParityAlerts: ParityAlert[];
  syncJobsStatus: SyncJobStatus[];
};

// Share bars are scaled to the largest channel (as the legacy bars were); the
// row carries the mix so the cell can read the maximum.
type MixTableRow = ChannelMixRow & { maxSharePct: number };

function severityTone(severity?: string): CocoaTone {
  if (!severity) return "warning";
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high" || s === "error") return "danger";
  if (s === "medium" || s === "warning" || s === "warn") return "warning";
  return "success";
}

function syncTone(status: string): CocoaTone {
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "success" || s === "completed" || s === "done") return "success";
  if (s === "failed" || s === "error" || s === "cancelled") return "danger";
  return "warning";
}

const MIX_COLUMNS: CocoaTableColumn<MixTableRow>[] = [
  { key: "channelName", label: "Canal", render: (row) => <strong>{row.channelName}</strong> },
  { key: "reservations", label: "Reservas", align: "right", render: (row) => number(row.reservations) },
  { key: "revenueEur", label: "Ingresos", align: "right", render: (row) => money(row.revenueEur) },
  {
    key: "sharePct",
    label: "Cuota",
    minWidth: 160,
    render: (row) => (
      <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
        <span style={{ flex: "1 1 auto", minWidth: 72 }}>
          <CocoaChart.Progress value={row.maxSharePct > 0 ? Math.max(2, (row.sharePct / row.maxSharePct) * 100) : 0} showValue={false} aria-label={`Cuota de ${row.channelName}: ${percent(row.sharePct)}`} />
        </span>
        <span>{percent(row.sharePct)}</span>
      </div>
    )
  }
];

const PROFITABLE_COLUMNS: CocoaTableColumn<ProfitableRow>[] = [
  { key: "channelName", label: "Canal", render: (row) => <strong>{row.channelName}</strong> },
  { key: "netRevenueEur", label: "Ingreso neto", align: "right", render: (row) => money(row.netRevenueEur) },
  { key: "commissionEur", label: "Comisión", align: "right", render: (row) => money(row.commissionEur), hideOnNarrow: true },
  { key: "marginPct", label: "Margen", align: "right", render: (row) => percent(row.marginPct) }
];

const ALERT_COLUMNS: CocoaTableColumn<ParityAlert>[] = [
  { key: "severity", label: "Severidad", render: (row) => <CocoaBadge tone={severityTone(row.severity)}>{row.severity ?? "—"}</CocoaBadge> },
  { key: "channelName", label: "Canal", render: (row) => row.channelName ?? "—" },
  { key: "description", label: "Descripción", render: (row) => row.description ?? "—", hideOnNarrow: true },
  { key: "detectedAt", label: "Detectada", render: (row) => dateTime(row.detectedAt) },
  {
    key: "resolvedAt",
    label: "Resuelta",
    render: (row) =>
      row.resolvedAt ? (
        dateTime(row.resolvedAt)
      ) : (
        <CocoaBadge tone="warning" size="small">
          abierta
        </CocoaBadge>
      )
  }
];

function kpiStatus(status: "ok" | "warn" | "error"): CocoaKpiStatus {
  return status === "ok" ? "ok" : status === "warn" ? "warning" : "critical";
}

// Skeleton espejo: strip of 5 tiles, then 8/4 · 6/6 · 12.
function ChannelPerformanceSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[8, 4], [6, 6], [12]]} height={200} />
    </div>
  );
}

export function ChannelPerformanceDashboard() {
  const { data, loading, error, refresh } = useApiData<ChannelPerformanceData>("/dashboards/channel-performance", {
    pollIntervalMs: 120000,
    query: { propertyId: PROPERTY_ID }
  });

  const kpis = data?.kpis;
  const channelMix = toArray<ChannelMixRow>(data?.channelMix);
  const topProfitableChannels = toArray<ProfitableRow>(data?.topProfitableChannels);
  const recentParityAlerts = toArray<ParityAlert>(data?.recentParityAlerts);
  const syncJobsStatus = toArray<SyncJobStatus>(data?.syncJobsStatus);

  const parityStatus = !kpis ? "warn" : kpis.openParityAlerts === 0 ? "ok" : kpis.openParityAlerts <= 2 ? "warn" : "error";
  const activeStatus = !kpis ? "warn" : kpis.activeChannels === 0 ? "error" : kpis.activeChannels < 2 ? "warn" : "ok";
  const commissionStatus = !kpis ? "warn" : kpis.avgCommissionPct >= 20 ? "error" : kpis.avgCommissionPct >= 12 ? "warn" : "ok";

  const maxShare = channelMix.reduce((max, m) => (m.sharePct > max ? m.sharePct : max), 0);
  const mixRows: MixTableRow[] = channelMix.map((row) => ({ ...row, maxSharePct: maxShare }));
  const syncTotal = syncJobsStatus.reduce((s, j) => s + j.count, 0);
  const header = treeHeaderFor("ChannelPerformanceDashboard", { eyebrow: "Informes", title: "Rendimiento de canales" });

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActiveProperty().propertyName}`}
      title={header.title}
      subtitle="Reparto de ventas por canal, rentabilidad, alertas de paridad y estado de las sincronizaciones de los últimos 30 días. Solo lectura; se actualiza cada 2 minutos."
      actions={
        <>
          {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : !kpis ? "empty" : "ready"}
      skeleton={<ChannelPerformanceSkeleton />}
      empty={{ title: "Sin datos de canales", message: "El rendimiento aparece aquí cuando los canales conectados registren reservas." }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "canales-rendimiento-refresh", label: "Actualizar el rendimiento de canales", run: refresh }]}
    >
      {kpis ? (
        <>
          <CocoaKpiStrip stagger aria-label="Indicadores de canales">
            <CocoaKpi label="Canales activos" value={number(kpis.activeChannels)} deltaLabel="canales en estado «activo»" polarity="neutral" status={kpiStatus(activeStatus)} />
            <CocoaKpi label="Alertas de paridad abiertas" value={number(kpis.openParityAlerts)} deltaLabel="diferencias de precio sin resolver" polarity="negative-good" status={kpiStatus(parityStatus)} />
            <CocoaKpi label="Comisión media" value={percent(kpis.avgCommissionPct)} deltaLabel="entre canales con comisión definida" polarity="negative-good" status={kpiStatus(commissionStatus)} />
            <CocoaKpi label="Reservas · 30 días" value={number(kpis.reservations30d)} deltaLabel="reservas externas importadas" polarity="neutral" status="ok" />
            <CocoaKpi label="Ingresos · 30 días" value={money(kpis.revenue30dEur)} deltaLabel="ingresos brutos registrados" status="ok" />
          </CocoaKpiStrip>

          <CocoaGrid aria-label="Reparto por canal" align="start">
            <CocoaSpan cols={8} min={480}>
              <CocoaSection title="Reparto por canal" meta={plural(channelMix.length, "canal", "canales")} padding={channelMix.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {channelMix.length === 0 ? (
                  <CocoaState kind="empty" inline title="No hay actividad de canales." message="Cuando entren reservas a través de los canales conectados aparecerá aquí el reparto por canal." />
                ) : (
                  <CocoaTable columns={MIX_COLUMNS} rows={mixRows} caption="Reparto por canal" aria-label="Reparto por canal" />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={4} min={240}>
              <CocoaSection title="Cuota de ventas" meta="últimos 30 días">
                {channelMix.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin reparto que representar." />
                ) : (
                  <CocoaChart.Donut
                    slices={channelMix.map((row) => ({ label: row.channelName, value: row.sharePct }))}
                    centerLabel="canales"
                    centerValue={number(channelMix.length)}
                    valueFormat={(value) => percent(value)}
                    aria-label="Cuota de ventas por canal en los últimos 30 días"
                  />
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaGrid aria-label="Rentabilidad y sincronización" align="start">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Canales más rentables" meta={`${number(topProfitableChannels.length)} en cabeza`} padding={topProfitableChannels.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {topProfitableChannels.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin datos de rentabilidad." message="La rentabilidad neta por canal aparecerá aquí cuando el pipeline registre el primer snapshot del periodo." />
                ) : (
                  <CocoaTable columns={PROFITABLE_COLUMNS} rows={topProfitableChannels} caption="Canales más rentables" aria-label="Canales más rentables" />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Estado de las sincronizaciones" meta={plural(syncTotal, "tarea", "tareas")}>
                {syncJobsStatus.length === 0 ? (
                  <CocoaState kind="empty" inline title="No hay sincronizaciones en el periodo." />
                ) : (
                  <ul className="c22-section__list" aria-label="Sincronizaciones por estado">
                    {syncJobsStatus.map((row) => (
                      <li key={row.status}>
                        <CocoaBadge tone={syncTone(row.status)}>{row.status}</CocoaBadge>
                        <strong>{plural(row.count, "tarea", "tareas")}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaSection title="Alertas de paridad recientes" meta={plural(recentParityAlerts.length, "alerta", "alertas")} padding={recentParityAlerts.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {recentParityAlerts.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay alertas de paridad recientes." />
            ) : (
              <CocoaTable columns={ALERT_COLUMNS} rows={recentParityAlerts} rowKey="id" caption="Alertas de paridad recientes" aria-label="Alertas de paridad recientes" />
            )}
          </CocoaSection>
        </>
      ) : null}
    </CocoaPage>
  );
}
