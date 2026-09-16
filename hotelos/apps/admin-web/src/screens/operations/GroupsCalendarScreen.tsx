// GroupsCalendarScreen — horizontal timeline (Gantt) of the active groups.
//
// Cocoa 22 (ola 3 · lote 3-B, archetype «calendario»): CocoaPage with
// `density="compact"`, a content toolbar (window 30 / 90 / 180 days as a
// segmented control, type and status filters), a KPI strip and the timeline
// inside a CocoaScrollArea: the date header sticks to the top
// (`data-sticky-head`, no blur) and the group column to the left
// (`data-sticky-column`); the scroll lives in the area, never in the page.
// One row per group, a bar from arrival to departure tinted by status, a
// dashed danger line at the cut-off date and a solid accent line for today.
// Clicking (or Enter/Space on) a bar opens GroupDetailDialog.
//
// Endpoint: GET /properties/:propertyId/groups/pickup-summary?windowDays=N
// (polled every two minutes). Hosted inside GruposEventosTabs the container
// paints the eyebrow and the H1; the page keeps its actions row.

import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { GROUPS_INSTRUCTIONS } from "../../content/screen-instructions/groups";
import { GroupDetailDialog } from "./GroupDetailDialog";
import { useTabHost } from "../tabs/TabHost";
import { navigateTo } from "../../lib/navigate";
import { date as formatDate, dateRange, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaScrollArea,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaToolbar,
  toneBg,
  toneBorder,
  toneInk,
  type CocoaKpiStatus,
  type CocoaTone
} from "../../components/cocoa";

// ───────────────────────────────────────────────────────── API types

type GroupPickupSummary = {
  groupBookingId: string;
  code: string;
  name: string;
  groupType: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  cutOffDate: string | null;
  totalBlocked: number;
  totalPickedUp: number;
  totalRemaining: number;
  pickupPct: number;
  attritionThresholdPct: number;
  daysToCutOff: number | null;
  daysToArrival: number;
  belowAttritionThreshold: boolean;
  days: Array<{ date: string; blocked: number; pickedUp: number; remaining: number }>;
};

type PickupResponse = {
  generatedAt: string;
  window: { from: string; to: string };
  groups: GroupPickupSummary[];
};

// ───────────────────────────────────────────────────────── Geometry

const DAY_CELL_WIDTH = 24; // px per day (header and tracks)
const NAME_COL_WIDTH = 200; // px of the sticky group column
const ROW_HEIGHT = 36; // px per group row
const HEAD_ROW_HEIGHT = 24; // px per header row (months · days)

const STATUS_META: Record<string, { tone: CocoaTone; label: string }> = {
  inquiry: { tone: "neutral", label: "Consulta" },
  tentative: { tone: "warning", label: "Provisional" },
  definite: { tone: "success", label: "Confirmado" },
  in_house: { tone: "accent", label: "En casa" },
  cancelled: { tone: "danger", label: "Cancelado" }
};

function statusMeta(status: string): { tone: CocoaTone; label: string } {
  return STATUS_META[status.toLowerCase()] ?? { tone: "info", label: status };
}

const TYPE_LABEL: Record<string, string> = {
  corporate: "Corporativo",
  mice: "MICE",
  smerf: "SMERF",
  leisure: "Ocio",
  wedding: "Boda",
  sports: "Deportivo",
  wholesale: "Mayorista"
};

const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "Todos los tipos" },
  ...Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))
];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "Todos los estados" },
  { value: "inquiry", label: "Consulta" },
  { value: "tentative", label: "Provisional" },
  { value: "definite", label: "Confirmado" }
];

const WINDOW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "30", label: "30 días" },
  { value: "90", label: "90 días" },
  { value: "180", label: "180 días" }
];

// ───────────────────────────────────────────────────────── Date helpers

function toUtcStartOfDay(d: Date): number {
  // Milliseconds at the start of the day (UTC), so zones never drift a day.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysBetween(a: Date, b: Date): number {
  const ms = toUtcStartOfDay(b) - toUtcStartOfDay(a);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function pickupStatus(pct: number): CocoaKpiStatus {
  return pct >= 80 ? "ok" : pct >= 40 ? "warning" : "critical";
}

// ───────────────────────────────────────────────────────── Timeline styles
// Every identity value comes from the system (tokens or tone helpers); the
// geometry (widths, offsets) is computed from the window.

const HEAD_NAME_STYLE: CSSProperties = {
  width: NAME_COL_WIDTH,
  minWidth: NAME_COL_WIDTH,
  display: "flex",
  alignItems: "center",
  padding: "0 var(--cocoa-space-3)",
  borderRight: "1px solid var(--cocoa-separator)",
  borderBottom: "1px solid var(--cocoa-separator)",
  boxSizing: "border-box"
};

function monthCellStyle(days: number): CSSProperties {
  return {
    width: days * DAY_CELL_WIDTH,
    minWidth: days * DAY_CELL_WIDTH,
    height: HEAD_ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
    padding: "0 var(--cocoa-space-2)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    color: "var(--cocoa-label)",
    borderRight: "1px solid var(--cocoa-separator)",
    borderBottom: "1px solid var(--cocoa-separator)",
    boxSizing: "border-box"
  };
}

function dayCellStyle(weekend: boolean, monthStart: boolean): CSSProperties {
  return {
    width: DAY_CELL_WIDTH,
    minWidth: DAY_CELL_WIDTH,
    height: HEAD_ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: (monthStart ? "var(--cocoa-fw-bold)" : "var(--cocoa-fw-regular)") as CSSProperties["fontWeight"],
    color: monthStart ? "var(--cocoa-label)" : "var(--cocoa-label-secondary)",
    background: weekend ? "var(--cocoa-background-window)" : "var(--cocoa-background-sidebar)",
    borderRight: "1px solid var(--cocoa-separator)",
    borderBottom: "1px solid var(--cocoa-separator)",
    boxSizing: "border-box"
  };
}

const NAME_CELL_STYLE: CSSProperties = {
  width: NAME_COL_WIDTH,
  minWidth: NAME_COL_WIDTH,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 2,
  padding: "var(--cocoa-space-1) var(--cocoa-space-3)",
  overflow: "hidden",
  borderRight: "1px solid var(--cocoa-separator)",
  borderBottom: "1px solid var(--cocoa-separator)",
  boxSizing: "border-box"
};

const CODE_STYLE: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

function trackStyle(width: number): CSSProperties {
  return {
    position: "relative",
    width,
    minWidth: width,
    height: ROW_HEIGHT,
    flex: "0 0 auto",
    borderBottom: "1px solid var(--cocoa-separator)",
    boxSizing: "border-box"
  };
}

function barStyle(tone: CocoaTone, left: number, width: number): CSSProperties {
  return {
    position: "absolute",
    left,
    width,
    top: 6,
    height: ROW_HEIGHT - 12,
    display: "flex",
    alignItems: "center",
    padding: "0 var(--cocoa-space-2)",
    borderRadius: "var(--cocoa-radius-sm)",
    background: toneBg(tone),
    border: `1px solid ${toneBorder(tone)}`,
    color: toneInk(tone),
    fontSize: "var(--cocoa-fs-footnote)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    cursor: "pointer",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    boxSizing: "border-box"
  };
}

function cutOffMarkerStyle(left: number): CSSProperties {
  return {
    position: "absolute",
    left,
    top: 2,
    bottom: 2,
    width: 0,
    borderLeft: "2px dashed var(--cocoa-tone-danger)",
    pointerEvents: "none"
  };
}

function todayMarkerStyle(left: number): CSSProperties {
  return {
    position: "absolute",
    left,
    top: 0,
    bottom: 0,
    width: 2,
    background: "var(--cocoa-tone-accent)",
    pointerEvents: "none"
  };
}

// ───────────────────────────────────────────────────────── Screen

function CalendarSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="chart" height={320} />
    </div>
  );
}

export function GroupsCalendarScreen() {
  const hosted = useTabHost() !== null;
  const propertyId = getActivePropertyId();

  const [windowDays, setWindowDays] = useState<number>(180);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const state = useApiData<PickupResponse>(
    `/properties/${propertyId}/groups/pickup-summary?windowDays=${windowDays}`,
    { pollIntervalMs: 120000 }
  );

  // Window: the API's when present, else built from today.
  const windowRange = useMemo(() => {
    if (state.data?.window?.from && state.data?.window?.to) {
      const from = new Date(state.data.window.from);
      const to = new Date(state.data.window.to);
      const total = Math.max(1, daysBetween(from, to) + 1);
      return { from, to, total };
    }
    const from = new Date();
    const to = new Date(from.getTime() + windowDays * 24 * 60 * 60 * 1000);
    return { from, to, total: windowDays };
  }, [state.data?.window?.from, state.data?.window?.to, windowDays]);

  // Filters + sort by arrival.
  const filteredGroups = useMemo(() => {
    const all = toArray<GroupPickupSummary>(state.data?.groups);
    return all
      .filter((g) => typeFilter === "all" || g.groupType.toLowerCase() === typeFilter)
      .filter((g) => statusFilter === "all" || g.status.toLowerCase() === statusFilter)
      .slice()
      .sort((a, b) => new Date(a.arrivalDate).getTime() - new Date(b.arrivalDate).getTime());
  }, [state.data?.groups, typeFilter, statusFilter]);

  // Derived KPIs.
  const kpis = useMemo(() => {
    const totalGroups = filteredGroups.length;
    const totalBlocked = filteredGroups.reduce((s, g) => s + (g.totalBlocked ?? 0), 0);
    const totalPickedUp = filteredGroups.reduce((s, g) => s + (g.totalPickedUp ?? 0), 0);
    const pickupPct = totalBlocked > 0 ? Math.round((totalPickedUp / totalBlocked) * 100) : 0;
    const upcomingCutoffs = filteredGroups.filter((g) => g.daysToCutOff != null && g.daysToCutOff >= 0 && g.daysToCutOff < 14).length;
    return { totalGroups, totalBlocked, pickupPct, upcomingCutoffs };
  }, [filteredGroups]);

  // Day cells and the month groups of the header.
  const dayHeader = useMemo(() => {
    const days: Array<{ date: Date; iso: string }> = [];
    for (let i = 0; i < windowRange.total; i++) {
      const d = new Date(windowRange.from.getTime() + i * 24 * 60 * 60 * 1000);
      days.push({ date: d, iso: d.toISOString().slice(0, 10) });
    }
    type MonthGroup = { key: string; label: string; count: number };
    const months: MonthGroup[] = [];
    for (const { date } of days) {
      const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      const label = formatDate(date, "monthYear");
      const last = months[months.length - 1];
      if (last && last.key === key) {
        last.count += 1;
      } else {
        months.push({ key, label, count: 1 });
      }
    }
    return { days, months };
  }, [windowRange.from, windowRange.total]);

  const trackWidth = windowRange.total * DAY_CELL_WIDTH;

  // Today → vertical marker.
  const todayLeft = (() => {
    const diff = daysBetween(windowRange.from, new Date());
    if (diff < 0 || diff > windowRange.total) return null;
    return diff * DAY_CELL_WIDTH;
  })();

  function handleNuevoGrupo() {
    // The board opens its «Nuevo grupo» drawer from the deep-link hash.
    navigateTo("GroupsEventsDashboard", "nuevo-grupo");
  }

  function handleBarKey(event: KeyboardEvent<HTMLDivElement>, groupId: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedGroupId(groupId);
    }
  }

  const periodLabel = `${dateRange(windowRange.from, windowRange.to)} · ${plural(windowRange.total, "día", "días")}`;

  // ─────────────────────────────────────────────────────── Render

  return (
    <CocoaPage
      eyebrow={`Recepción · ${getActiveProperty().propertyName}`}
      title="Calendario de grupos"
      subtitle={
        hosted
          ? undefined
          : "Todos los grupos activos en la ventana elegida (30, 90 o 180 días): cada barra cubre de la llegada a la salida y su color es el estado del bloque; la línea discontinua marca la fecha límite contractual. Pulsa una barra para abrir el grupo."
      }
      density="compact"
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => state.refresh()}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon size={14} />} onClick={handleNuevoGrupo}>
            Nuevo grupo
          </CocoaButton>
        </>
      }
      state={state.loading && !state.data ? "loading" : state.error && !state.data ? "error" : "ready"}
      skeleton={<CalendarSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: state.error ?? undefined, onRetry: () => state.refresh() }}
      commands={[
        { id: "groups-calendar-refresh", label: "Actualizar el calendario de grupos", run: () => state.refresh() },
        { id: "groups-calendar-new-group", label: "Nuevo grupo", run: handleNuevoGrupo }
      ]}
    >
      <CocoaScreenInstructionsCard
        title="Gestión de grupos y eventos"
        description={GROUPS_INSTRUCTIONS.whatIsThis}
        steps={[...GROUPS_INSTRUCTIONS.howToUse]}
        tip={GROUPS_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="groups"
      />

      <CocoaToolbar
        variant="content"
        aria-label="Ventana de tiempo y filtros del calendario"
        leftSlot={
          <CocoaSegmentedControl
            value={String(windowDays)}
            onChange={(value) => setWindowDays(Number(value))}
            options={WINDOW_OPTIONS}
            size="small"
            aria-label="Ventana de tiempo"
          />
        }
        rightSlot={
          <div className="cocoa-row" data-gap="2">
            <CocoaSelect value={typeFilter} onChange={setTypeFilter} options={TYPE_OPTIONS} size="small" aria-label="Tipo de grupo" />
            <CocoaSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} size="small" aria-label="Estado del grupo" />
            <CocoaBadge tone="neutral">{plural(filteredGroups.length, "grupo visible", "grupos visibles")}</CocoaBadge>
          </div>
        }
      />

      <CocoaKpiStrip stagger aria-label="Indicadores del periodo">
        <CocoaKpi label="Grupos en el periodo" value={number(kpis.totalGroups)} polarity="neutral" />
        <CocoaKpi label="Habitaciones bloqueadas" value={number(kpis.totalBlocked)} polarity="neutral" />
        <CocoaKpi label="Pickup global" value={percent(kpis.pickupPct)} caption="vendidas sobre bloqueadas" status={pickupStatus(kpis.pickupPct)} />
        <CocoaKpi label="Fechas límite en menos de 14 días" value={number(kpis.upcomingCutoffs)} polarity="neutral" status={kpis.upcomingCutoffs > 0 ? "critical" : "ok"} />
      </CocoaKpiStrip>

      <CocoaSection title="Calendario" meta={periodLabel}>
        {filteredGroups.length === 0 ? (
          <CocoaState
            kind="empty"
            title="No hay grupos en el periodo seleccionado"
            message="Ajusta los filtros o la ventana de tiempo, o crea un nuevo grupo."
            primaryAction={{ label: "Nuevo grupo", onClick: handleNuevoGrupo }}
          />
        ) : (
          <>
            <CocoaScrollArea axis="both" maxHeight="min(60vh, 640px)" aria-label="Calendario de grupos" role="group">
              <div style={{ minWidth: "max-content" }}>
                <div data-sticky-head style={{ display: "flex" }}>
                  <div data-sticky-column style={HEAD_NAME_STYLE}>
                    <span className="cocoa-caption">Grupo</span>
                  </div>
                  <div>
                    <div style={{ display: "flex", width: trackWidth }}>
                      {dayHeader.months.map((m) => (
                        <div key={m.key} style={monthCellStyle(m.count)}>
                          {m.label}
                        </div>
                      ))}
                    </div>
                    <div className="cocoa-tabular" style={{ display: "flex", width: trackWidth }}>
                      {dayHeader.days.map((d) => {
                        const day = d.date.getUTCDate();
                        const weekday = d.date.getUTCDay();
                        return (
                          <div key={d.iso} style={dayCellStyle(weekday === 0 || weekday === 6, day === 1)} title={formatDate(d.iso, "weekdayShort")}>
                            {day}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {filteredGroups.map((g) => {
                  const arrival = new Date(g.arrivalDate);
                  const departure = new Date(g.departureDate);
                  const offsetDays = daysBetween(windowRange.from, arrival);
                  const lengthDays = Math.max(1, daysBetween(arrival, departure) + 1);
                  // Clamp to the visible window.
                  const startDay = Math.max(0, offsetDays);
                  const endDay = Math.min(windowRange.total, offsetDays + lengthDays);
                  const visibleLength = Math.max(0, endDay - startDay);
                  const left = startDay * DAY_CELL_WIDTH;
                  const width = Math.max(0, visibleLength * DAY_CELL_WIDTH - 2);
                  const meta = statusMeta(g.status);

                  // Cut-off marker only inside the group's span and the window.
                  let cutOffLeft: number | null = null;
                  if (g.cutOffDate) {
                    const coOffset = daysBetween(windowRange.from, new Date(g.cutOffDate));
                    if (coOffset >= startDay && coOffset <= endDay && coOffset >= 0 && coOffset <= windowRange.total) {
                      cutOffLeft = coOffset * DAY_CELL_WIDTH;
                    }
                  }

                  const tooltip = [
                    g.name,
                    `Fechas: ${dateRange(g.arrivalDate, g.departureDate)}`,
                    `Bloqueadas: ${number(g.totalBlocked)} · Vendidas: ${number(g.totalPickedUp)}`,
                    `Pickup: ${percent(g.pickupPct)}`,
                    g.daysToCutOff != null ? `Días hasta la fecha límite: ${number(g.daysToCutOff)}` : "Sin fecha límite"
                  ].join("\n");

                  return (
                    <div key={g.groupBookingId} style={{ display: "flex", alignItems: "stretch", minHeight: ROW_HEIGHT }}>
                      <div data-sticky-column style={NAME_CELL_STYLE}>
                        <strong className="cocoa-truncate">{g.name}</strong>
                        <span className="cocoa-truncate" style={CODE_STYLE}>
                          {g.code} · {TYPE_LABEL[g.groupType.toLowerCase()] ?? g.groupType}
                        </span>
                      </div>
                      <div style={trackStyle(trackWidth)}>
                        {todayLeft != null ? <div style={todayMarkerStyle(todayLeft)} aria-hidden="true" /> : null}

                        {visibleLength > 0 ? (
                          <div
                            role="button"
                            tabIndex={0}
                            className="cocoa-focus-ring cocoa-tabular"
                            style={barStyle(meta.tone, left, width)}
                            title={tooltip}
                            aria-label={`${g.name} · ${meta.label} · ${dateRange(g.arrivalDate, g.departureDate)}`}
                            onClick={() => setSelectedGroupId(g.groupBookingId)}
                            onKeyDown={(event) => handleBarKey(event, g.groupBookingId)}
                          >
                            {g.name} · {number(g.totalBlocked)} hab. · {percent(g.pickupPct)}
                          </div>
                        ) : null}

                        {cutOffLeft != null ? (
                          <div style={cutOffMarkerStyle(cutOffLeft)} title={g.cutOffDate ? `Fecha límite: ${formatDate(g.cutOffDate, "dayMonth")}` : undefined} aria-hidden="true" />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CocoaScrollArea>

            <div className="cocoa-cluster" aria-label="Leyenda del calendario">
              <span className="cocoa-caption">Estados</span>
              {Object.entries(STATUS_META).map(([key, meta]) => (
                <CocoaBadge key={key} tone={meta.tone} variant="dot">
                  {meta.label}
                </CocoaBadge>
              ))}
              <CocoaBadge tone="danger">Fecha límite (línea discontinua)</CocoaBadge>
              <CocoaBadge tone="accent">Hoy (línea continua)</CocoaBadge>
            </div>
          </>
        )}
      </CocoaSection>

      {selectedGroupId ? (
        <GroupDetailDialog groupBookingId={selectedGroupId} onClose={() => setSelectedGroupId(null)} />
      ) : null}
    </CocoaPage>
  );
}

export default GroupsCalendarScreen;
