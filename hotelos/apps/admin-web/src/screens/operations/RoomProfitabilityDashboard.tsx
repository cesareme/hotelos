// Room profitability — Informes › Rentabilidad por habitación
// (/informes/rentabilidad-habitacion).
//
// Cocoa 22 (ola 9 · lote 9-A): standalone dashboard (DashboardStandalone):
// KPI strip → 8/4 row (by room type table + revenue bars) → 6/6 row (by
// channel table + top rooms table). Read only; polls every five minutes.

import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { money, number, percent, plural } from "../../lib/format";
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
  type CocoaBarsDatum,
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type RoomTypeRow = { roomTypeName: string; roomCount: number; occupancyPct: number; adrEur: number; revparEur: number; revenueEur: number };
type ChannelRow = { channelName: string; reservations: number; revenueEur: number; netRevenueEur: number; marginPct: number };
type TopRoomRow = { id: string; number: string; roomTypeName: string; revenue30dEur: number; nightsBooked: number };

type RoomProfitabilityData = {
  kpis: {
    totalRevenueEur: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
    goppar30dEur: number;
  };
  byRoomType: RoomTypeRow[];
  byChannel: ChannelRow[];
  topRooms: TopRoomRow[];
};

type Status = "ok" | "warn" | "error";

function occupancyStatus(value: number | undefined): Status {
  if (!Number.isFinite(value as number)) return "warn";
  const v = value as number;
  if (v >= 70) return "ok";
  if (v >= 45) return "warn";
  return "error";
}

function revparStatus(value: number | undefined, adr: number | undefined): Status {
  if (!Number.isFinite(value as number) || !Number.isFinite(adr as number)) return "warn";
  const v = value as number;
  const a = adr as number;
  if (a <= 0) return "warn";
  const ratio = v / a;
  if (ratio >= 0.7) return "ok";
  if (ratio >= 0.45) return "warn";
  return "error";
}

function marginStatus(value: number): Status {
  if (!Number.isFinite(value)) return "warn";
  if (value >= 70) return "ok";
  if (value >= 50) return "warn";
  return "error";
}

const STATUS_TONE: Record<Status, CocoaTone> = { ok: "success", warn: "warning", error: "danger" };

function kpiStatus(status: Status): CocoaKpiStatus {
  return status === "ok" ? "ok" : status === "warn" ? "warning" : "critical";
}

const ROOM_TYPE_COLUMNS: CocoaTableColumn<RoomTypeRow>[] = [
  { key: "roomTypeName", label: "Tipo", render: (row) => <strong>{row.roomTypeName}</strong> },
  { key: "roomCount", label: "Habitaciones", align: "right", render: (row) => number(row.roomCount), hideOnNarrow: true },
  { key: "occupancyPct", label: "Ocupación", align: "right", render: (row) => percent(row.occupancyPct) },
  { key: "adrEur", label: "ADR", align: "right", render: (row) => money(row.adrEur), hideOnNarrow: true },
  { key: "revparEur", label: "RevPAR", align: "right", render: (row) => money(row.revparEur) },
  { key: "revenueEur", label: "Ingresos", align: "right", render: (row) => money(row.revenueEur) }
];

const CHANNEL_COLUMNS: CocoaTableColumn<ChannelRow>[] = [
  { key: "channelName", label: "Canal", render: (row) => <strong>{row.channelName}</strong> },
  { key: "reservations", label: "Reservas", align: "right", render: (row) => number(row.reservations), hideOnNarrow: true },
  { key: "revenueEur", label: "Ingresos", align: "right", render: (row) => money(row.revenueEur) },
  { key: "netRevenueEur", label: "Ingreso neto", align: "right", render: (row) => money(row.netRevenueEur) },
  { key: "marginPct", label: "Margen", align: "right", render: (row) => <CocoaBadge tone={STATUS_TONE[marginStatus(row.marginPct)]}>{percent(row.marginPct)}</CocoaBadge> }
];

const TOP_ROOM_COLUMNS: CocoaTableColumn<TopRoomRow>[] = [
  { key: "number", label: "Habitación", render: (row) => <strong>{row.number}</strong> },
  { key: "roomTypeName", label: "Tipo" },
  { key: "nightsBooked", label: "Noches", align: "right", render: (row) => number(row.nightsBooked) },
  { key: "revenue30dEur", label: "Ingresos · 30 días", align: "right", render: (row) => money(row.revenue30dEur) }
];

// Skeleton espejo: strip of 5 tiles, then 8/4 · 6/6.
function RoomProfitabilitySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[8, 4], [6, 6]]} height={220} />
    </div>
  );
}

export function RoomProfitabilityDashboard() {
  const { data, loading, error, refresh } = useApiData<RoomProfitabilityData>("/dashboards/room-profitability", {
    pollIntervalMs: 300000,
    query: { propertyId: PROPERTY_ID }
  });

  const kpis = data?.kpis;
  const byRoomType = toArray<RoomTypeRow>(data?.byRoomType);
  const byChannel = toArray<ChannelRow>(data?.byChannel);
  const topRooms = toArray<TopRoomRow>(data?.topRooms);

  const occStatus = occupancyStatus(kpis?.occupancyPct);
  const revparKpiStatus = revparStatus(kpis?.revparEur, kpis?.adrEur);
  const gopparStatus: Status = !kpis ? "warn" : kpis.goppar30dEur > 0 ? "ok" : kpis.goppar30dEur === 0 ? "warn" : "error";

  const revenueByType: CocoaBarsDatum[] = byRoomType.map((row) => ({
    label: row.roomTypeName,
    value: row.revenueEur,
    hint: `RevPAR ${money(row.revparEur)} · ocupación ${percent(row.occupancyPct)}`
  }));
  const header = treeHeaderFor("RoomProfitabilityDashboard", { eyebrow: "Informes", title: "Rentabilidad por habitación" });

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActiveProperty().propertyName}`}
      title={header.title}
      subtitle="RevPAR, ADR, ocupación y GOPPAR por tipo de habitación y por canal en los últimos 30 días. Solo lectura; se actualiza cada 5 minutos."
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
      skeleton={<RoomProfitabilitySkeleton />}
      empty={{ title: "Sin datos de rentabilidad", message: "Las cifras aparecen aquí cuando la propiedad registre noches vendidas en los últimos 30 días." }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "rentabilidad-habitacion-refresh", label: "Actualizar la rentabilidad por habitación", run: refresh }]}
    >
      {kpis ? (
        <>
          <CocoaKpiStrip stagger aria-label="Indicadores de rentabilidad">
            {/* deltaLabel is nowrap in a tile that auto-fits down to 180 px: ≤ 22 characters (qa#9, see __tests__/room-profitability-kpi-foot). */}
            <CocoaKpi label="Ingresos totales" value={money(kpis.totalRevenueEur)} deltaLabel="últimos 30 días" status="ok" />
            <CocoaKpi label="Ocupación" value={percent(kpis.occupancyPct)} deltaLabel="vendidas / disponibles" status={kpiStatus(occStatus)} />
            <CocoaKpi label="ADR" value={money(kpis.adrEur)} deltaLabel="por noche vendida" status="ok" />
            <CocoaKpi label="RevPAR" value={money(kpis.revparEur)} deltaLabel="por noche disponible" status={kpiStatus(revparKpiStatus)} />
            <CocoaKpi label="GOPPAR · 30 días" value={money(kpis.goppar30dEur)} deltaLabel="GOP / hab. disponible" status={kpiStatus(gopparStatus)} />
          </CocoaKpiStrip>

          <CocoaGrid aria-label="Por tipo de habitación" align="start">
            <CocoaSpan cols={8} min={480}>
              <CocoaSection title="Por tipo de habitación" meta={plural(byRoomType.length, "tipo", "tipos")} padding={byRoomType.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {byRoomType.length === 0 ? (
                  <CocoaState kind="empty" inline title="No hay datos por tipo de habitación en el periodo." />
                ) : (
                  <CocoaTable columns={ROOM_TYPE_COLUMNS} rows={byRoomType} caption="Rentabilidad por tipo de habitación" aria-label="Rentabilidad por tipo de habitación" />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={4} min={240}>
              <CocoaSection title="Ingresos por tipo" meta="últimos 30 días">
                {revenueByType.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin ingresos que representar." />
                ) : (
                  <CocoaChart.Bars data={revenueByType} height={160} valueFormat={(value) => money(value)} aria-label="Ingresos de los últimos 30 días por tipo de habitación" />
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaGrid aria-label="Por canal y habitaciones más rentables" align="start">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Por canal" meta={plural(byChannel.length, "canal", "canales")} padding={byChannel.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {byChannel.length === 0 ? (
                  <CocoaState kind="empty" inline title="No hay actividad de canales en el periodo." />
                ) : (
                  <CocoaTable columns={CHANNEL_COLUMNS} rows={byChannel} caption="Rentabilidad por canal" aria-label="Rentabilidad por canal" />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Habitaciones más rentables" meta={`30 días · ${plural(topRooms.length, "habitación", "habitaciones")}`} padding={topRooms.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {topRooms.length === 0 ? (
                  <CocoaState kind="empty" inline title="No hay reservas asignadas a habitaciones en el periodo." />
                ) : (
                  <CocoaTable columns={TOP_ROOM_COLUMNS} rows={topRooms} rowKey="id" caption="Habitaciones más rentables en 30 días" aria-label="Habitaciones más rentables en 30 días" />
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>
        </>
      ) : null}
    </CocoaPage>
  );
}
