// Operations Director Screen — vista consolidada cross-departamento.
//
// Para el director de operaciones (un nivel por encima de jefes de
// recepción/HK/mantenimiento). Muestra el estado de cada departamento en una
// sola pantalla con drilldown a cada tablero específico.
//
// Layout v2 (mayo 2026):
//   Row 0 — Summary KPIs (departamentos OK / atención / críticos / alertas).
//   Row 1 — Mini cards (DirectorOpsHealthMini): HK, Maintenance, Workforce,
//           Safety, POS. Consume miniCards[] del endpoint enriquecido.
//   Row 2 — Detail tables: tareas HK, work orders, turnos, incidentes safety.
//   Row 3 — Trends charts (7d): HK cleaned vs scheduled, MTTR mantenimiento,
//           coverage workforce.
//
// Cocoa 22 (ola 2 · lote 2-A): `CocoaPage` with internal views as `tabs`
// (hosted in Mi día the container paints the H1 and the page keeps subtitle,
// actions and the segmented views), `CocoaKpiStrip` of `CocoaKpi` for the
// summary, `DirectorOpsHealthMini` inside a strip, `CocoaTable` per detail
// list, `CocoaChart.Line` for the 7-day trends, `CocoaBadge` everywhere,
// `CocoaState` / `Degraded*` for the honest empty and degraded states and a
// mirror skeleton. Same endpoint and polling.
//
// Tanda UX-2 · lote D8 (docs/design/UX-DIRECCION-FEEL.md §1 P2/P5, F-D11):
// the housekeeping and maintenance drill-downs go to the BOARDS
// (HousekeepingDashboard · MaintenanceDashboard) with a fine pointer and only
// on a phone with a coarse pointer (`mobileDrillDown`: useCoarsePointer + tier
// of cocoa-viewport.ts) to the mobile «Mi turno» / «Mis averías» screens; the
// detail tables are `comfortable` (a director's panel, not an operational
// list); ⌘K adds «Ver alertas», «Ir a pisos» and «Ir a mantenimiento».

import { useState, type CSSProperties, type ReactNode } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { navigateTo, type ScreenKey } from "../../lib/navigate";
import { useCoarsePointer } from "../../lib/useCoarsePointer";
import { toArray } from "../../utils/toArray";
import { date, dateTime, number, percent, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { SEVERITY_TONE, type ManagementTone } from "./managementBadges";
import { departmentLabel, hkTaskStatusLabel, hkTaskTypeLabel, priorityLabel, roomLabel, shiftStatusLabel, woStatusLabel } from "./operations-director-labels";
import { DirectorOpsHealthMini, type DirectorOpsHealthMiniProps, type DirectorOpsHealthStatus } from "../../components/cocoa-director";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaTable,
  DegradedBanner,
  DegradedCard,
  DegradedNote,
  DegradedValue,
  isDegraded,
  useViewportTier,
  type CocoaKpiStatus,
  type CocoaLineSeries,
  type CocoaTableColumn,
  type CocoaTone,
  type CocoaViewportTier
} from "../../components/cocoa";

type Kpi = { label: string; value: number | string; tone: "ok" | "warn" | "error" | "info"; detail?: string };

type Department = {
  id: string;
  name: string;
  health: "ok" | "warn" | "error";
  headline: string;
  kpis: Kpi[];
  primaryAction?: { label: string; screen: string };
};

type Alert = {
  id: string;
  severity: "critical" | "warning";
  department: string;
  title: string;
  detail?: string;
};

type MiniCards = {
  housekeeping: {
    clean: number;
    dirty: number;
    inspected: number;
    ooo: number;
    deltaVsYesterday: number;
  };
  maintenance: {
    open: number;
    inProgress: number;
    critical: number;
    deltaVsYesterday: number;
  };
  workforce: {
    shiftsStaffed: number;
    shiftsNeeded: number;
    coveragePct: number;
  };
  safety: {
    incidentsOpen: number;
    criticalCount: number;
  };
  posRevenueToday: {
    total: number;
    breakdown: {
      restaurant: number;
      bar: number;
      spa: number;
      room_service: number;
    };
  };
};

type DetailHkTask = {
  id: string;
  roomId: string;
  /** Número de la habitación resuelto por el API (FIX-1 · F9); la tabla pinta `roomNumber ?? roomId`. */
  roomNumber?: string | null;
  taskType: string;
  priority: string;
  status: string;
  assignedTo: string | null;
  dueAt: string | null;
  createdAt: string;
};

type DetailWorkOrder = {
  id: string;
  title: string;
  priority: string;
  status: string;
  roomId: string | null;
  roomNumber?: string | null;
  assignedTo: string | null;
  dueDate: string | null;
  createdAt: string;
};

type DetailShift = {
  id: string;
  staffProfileId: string | null;
  departmentId: string | null;
  roleLabel: string | null;
  status: string;
  startAt: string;
  endAt: string;
};

type DetailSafetyIncident = {
  id: string;
  incidentType: string;
  severity: string;
  status: string;
  title: string;
  occurredAt: string | null;
  createdAt: string;
};

type Details = {
  hkTasks: DetailHkTask[];
  workOrders: DetailWorkOrder[];
  shifts: DetailShift[];
  safetyIncidents: DetailSafetyIncident[];
};

type TrendPoint = { date: string; value: number };
type TrendPair = { date: string; actual: number; target: number };

type Trends = {
  housekeepingCleanedVsScheduled: TrendPair[];
  maintenanceMttrHours: TrendPoint[];
  workforceCoveragePct: TrendPoint[];
};

type Data = {
  generatedAt: string;
  propertyId: string;
  propertyName?: string;
  departments: Department[];
  alerts: Alert[];
  miniCards: MiniCards;
  details: Details;
  trends: Trends;
  summary: {
    departmentsOk: number;
    departmentsWarn: number;
    departmentsError: number;
    criticalAlerts: number;
  };
  // QC-06: `safe()` labels whose query failed and fell back to 0/[]. Mirrors
  // `apps/api/src/modules/dashboards/operations-director.service.ts`.
  degraded: string[];
};

type OpsTab = "overview" | "alertas";
type DetailTab = "hk" | "wo" | "shifts" | "incidents";

// `safe()` labels in operations-director.service.ts grouped by the UI slot
// they feed. A slot is degraded when ANY of its labels is in `degraded[]`.
const DEGRADED_LABEL = {
  // Department health / alerts roll-up (summary tiles, alerts badge).
  summary: [
    "maintenance.openWorkOrders",
    "maintenance.inProgressWorkOrders",
    "maintenance.emergencyWorkOrders",
    "workforce.absencesToday",
    "safety.incidentsActive",
    "pos.openTickets"
  ],
  hkDelta: "housekeeping.cleanRoomsYesterdayProxy",
  maintenance: [
    "maintenance.openWorkOrders",
    "maintenance.inProgressWorkOrders",
    "maintenance.emergencyWorkOrders"
  ],
  maintenanceDelta: "maintenance.workOrdersActiveYesterdayProxy",
  workforce: ["workforce.shiftsToday", "workforce.shiftsStaffedToday"],
  safety: ["safety.incidentsActive", "safety.incidentsCritical"],
  pos: ["pos.ordersToday", "pos.outlets"],
  details: {
    hk: "details.hkTasks",
    wo: "details.workOrders",
    shifts: "details.shifts",
    incidents: "details.safetyIncidents"
  },
  trends: {
    hk: "trends.hkTasksLast7d",
    mttr: "trends.workOrdersResolvedLast7d",
    coverage: "trends.shiftsLast7d"
  }
} as const;

// ---------------------------------------------------------------------------
// Local text styles (tokens only); layout comes from the utilities.
// ---------------------------------------------------------------------------

const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

const calloutStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)"
};

const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

// ---------------------------------------------------------------------------
// Mini-card mappers (data → DirectorOpsHealthMini props)
// ---------------------------------------------------------------------------

function hkStatus(mc: MiniCards["housekeeping"]): DirectorOpsHealthStatus {
  if (mc.dirty > mc.clean) return "warning";
  if (mc.ooo > 5) return "critical";
  return "ok";
}

function maintenanceStatus(mc: MiniCards["maintenance"]): DirectorOpsHealthStatus {
  if (mc.critical > 0) return "critical";
  if (mc.open + mc.inProgress > 5) return "warning";
  return "ok";
}

function workforceStatus(mc: MiniCards["workforce"]): DirectorOpsHealthStatus {
  if (mc.coveragePct < 70) return "critical";
  if (mc.coveragePct < 90) return "warning";
  return "ok";
}

function safetyStatus(mc: MiniCards["safety"]): DirectorOpsHealthStatus {
  if (mc.criticalCount > 0) return "critical";
  if (mc.incidentsOpen > 0) return "warning";
  return "ok";
}

function posStatus(mc: MiniCards["posRevenueToday"]): DirectorOpsHealthStatus {
  // Revenue can't be "critical" purely from a count; surface info-style status.
  if (mc.total === 0) return "warning";
  return "ok";
}

// ---------------------------------------------------------------------------
// Drill-down targets by device (UX-2 · D8). Pure: a phone (viewportTier
// «phone») handled with a finger (`pointer: coarse`) is the only case where
// the mobile «Mi turno» / «Mis averías» screens are the right landing; a
// director with a mouse, a trackpad or a tablet wants the boards.
// ---------------------------------------------------------------------------

export function mobileDrillDown(tier: CocoaViewportTier, coarse: boolean): boolean {
  return tier === "phone" && coarse;
}

export const DRILL_DOWN_SCREENS = {
  housekeeping: { board: "HousekeepingDashboard", mobile: "HousekeepingMobileScreen" },
  maintenance: { board: "MaintenanceDashboard", mobile: "MaintenanceMobileScreen" }
} as const satisfies Record<string, { board: ScreenKey; mobile: ScreenKey }>;

export function drillDownScreen(module: keyof typeof DRILL_DOWN_SCREENS, mobile: boolean): ScreenKey {
  return mobile ? DRILL_DOWN_SCREENS[module].mobile : DRILL_DOWN_SCREENS[module].board;
}

// `deltaDegraded`: the yesterday baseline is a safe()-wrapped query; when it
// failed the API returns a delta computed against 0, so omit the delta rather
// than show a fake "+N". `mobile`: `mobileDrillDown(tier, coarse)` of the screen.
function buildHkMiniProps(mc: MiniCards["housekeeping"], deltaDegraded: boolean, mobile: boolean): DirectorOpsHealthMiniProps {
  return {
    module: "housekeeping",
    title: "Housekeeping",
    primaryCount: mc.clean,
    primaryLabel: "limpias",
    breakdown: [
      { label: "sucias", count: mc.dirty, tone: "warning" },
      { label: "insp.", count: mc.inspected, tone: "success" },
      { label: "OOO", count: mc.ooo, tone: "danger" }
    ],
    status: hkStatus(mc),
    deltaVsYesterday: deltaDegraded ? undefined : mc.deltaVsYesterday,
    onDrillDown: () => navigateTo(drillDownScreen("housekeeping", mobile))
  };
}

function buildMaintenanceMiniProps(mc: MiniCards["maintenance"], deltaDegraded: boolean, mobile: boolean): DirectorOpsHealthMiniProps {
  return {
    module: "maintenance",
    title: "Mantenimiento",
    primaryCount: mc.open + mc.inProgress,
    primaryLabel: "activas",
    breakdown: [
      { label: "abiertas", count: mc.open },
      { label: "en curso", count: mc.inProgress, tone: "info" },
      { label: "crítica", count: mc.critical, tone: "danger" }
    ],
    status: maintenanceStatus(mc),
    deltaVsYesterday: deltaDegraded ? undefined : mc.deltaVsYesterday,
    onDrillDown: () => navigateTo(drillDownScreen("maintenance", mobile))
  };
}

function buildWorkforceMiniProps(mc: MiniCards["workforce"]): DirectorOpsHealthMiniProps {
  return {
    module: "workforce",
    title: "Personal",
    primaryCount: mc.shiftsStaffed,
    primaryLabel: `de ${mc.shiftsNeeded} turnos`,
    breakdown: [
      {
        label: "cobertura",
        count: Math.round(mc.coveragePct),
        tone: mc.coveragePct >= 90 ? "success" : mc.coveragePct >= 70 ? "warning" : "danger"
      }
    ],
    status: workforceStatus(mc),
    onDrillDown: () => navigateTo("WorkforceDashboard")
  };
}

function buildSafetyMiniProps(mc: MiniCards["safety"]): DirectorOpsHealthMiniProps {
  return {
    module: "safety",
    title: "Seguridad",
    primaryCount: mc.incidentsOpen,
    primaryLabel: "incidentes",
    breakdown: [{ label: "críticos", count: mc.criticalCount, tone: "danger" }],
    status: safetyStatus(mc),
    onDrillDown: () => navigateTo("SafetyDashboard")
  };
}

function buildPosMiniProps(mc: MiniCards["posRevenueToday"]): DirectorOpsHealthMiniProps {
  return {
    module: "pos",
    title: "F&B / TPV hoy",
    primaryCount: Math.round(mc.total),
    primaryLabel: "ingresos",
    breakdown: [
      { label: "rest.", count: Math.round(mc.breakdown.restaurant) },
      { label: "bar", count: Math.round(mc.breakdown.bar) },
      { label: "spa", count: Math.round(mc.breakdown.spa) },
      { label: "RS", count: Math.round(mc.breakdown.room_service) }
    ],
    status: posStatus(mc),
    onDrillDown: () => navigateTo("PosDashboard")
  };
}

// ---------------------------------------------------------------------------
// Badges and table columns (outside the component, rule A5).
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  return dateTime(iso, { style: "dayMonth" });
}

function priorityTone(priority: string): ManagementTone {
  return priority === "emergency" || priority === "critical" || priority === "high" ? "danger" : priority === "normal" ? "info" : "neutral";
}

function severityTone(severity: string): ManagementTone {
  return severity === "critical" ? "danger" : severity === "warning" || severity === "high" ? "warning" : "info";
}

function statusTone(status: string): ManagementTone {
  return status === "done" || status === "resolved" || status === "closed" || status === "completed"
    ? "success"
    : status === "in_progress" || status === "investigating"
    ? "info"
    : "neutral";
}

function badge(tone: CocoaTone, text: string): ReactNode {
  return (
    <CocoaBadge tone={tone} size="small">
      {text}
    </CocoaBadge>
  );
}

// FIX-1 · F9: número de habitación (roomNumber, resuelto por el API) y etiquetas
// en español (operations-director-labels) en vez de los ids y enums crudos.
const HK_COLUMNS: CocoaTableColumn<DetailHkTask>[] = [
  { key: "room", label: "Habitación", render: (t) => roomLabel(t) },
  { key: "taskType", label: "Tarea", render: (t) => hkTaskTypeLabel(t.taskType) },
  { key: "priority", label: "Prioridad", render: (t) => badge(priorityTone(t.priority), priorityLabel(t.priority)) },
  { key: "status", label: "Estado", render: (t) => badge(statusTone(t.status), hkTaskStatusLabel(t.status)) },
  { key: "assignedTo", label: "Asignado", render: (t) => t.assignedTo ?? "—", hideOnNarrow: true },
  { key: "dueAt", label: "Vence", render: (t) => fmtDate(t.dueAt), hideOnNarrow: true }
];

const WO_COLUMNS: CocoaTableColumn<DetailWorkOrder>[] = [
  { key: "title", label: "Título" },
  { key: "priority", label: "Prioridad", render: (wo) => badge(priorityTone(wo.priority), priorityLabel(wo.priority)) },
  { key: "status", label: "Estado", render: (wo) => badge(statusTone(wo.status), woStatusLabel(wo.status)) },
  { key: "room", label: "Habitación", render: (wo) => roomLabel(wo), hideOnNarrow: true },
  { key: "assignedTo", label: "Asignado", render: (wo) => wo.assignedTo ?? "—", hideOnNarrow: true },
  { key: "dueDate", label: "Vence", render: (wo) => fmtDate(wo.dueDate), hideOnNarrow: true }
];

const SHIFT_COLUMNS: CocoaTableColumn<DetailShift>[] = [
  { key: "startAt", label: "Inicio", render: (s) => time(s.startAt) },
  { key: "endAt", label: "Fin", render: (s) => time(s.endAt) },
  { key: "roleLabel", label: "Rol", render: (s) => s.roleLabel ?? "—" },
  { key: "status", label: "Estado", render: (s) => badge(statusTone(s.status), shiftStatusLabel(s.status)) },
  { key: "assignment", label: "Asignación", render: (s) => (s.staffProfileId ? badge("success", "Asignado") : badge("warning", "Sin asignar")), hideOnNarrow: true }
];

const INCIDENT_COLUMNS: CocoaTableColumn<DetailSafetyIncident>[] = [
  { key: "title", label: "Título" },
  { key: "incidentType", label: "Tipo", hideOnNarrow: true },
  { key: "severity", label: "Severidad", render: (i) => badge(severityTone(i.severity), i.severity) },
  { key: "status", label: "Estado", render: (i) => badge(statusTone(i.status), i.status) },
  { key: "occurredAt", label: "Ocurrió", render: (i) => fmtDate(i.occurredAt ?? i.createdAt), hideOnNarrow: true }
];

const DETAIL_CAPTION: Record<DetailTab, string> = {
  hk: "Tareas de housekeeping de hoy",
  wo: "Órdenes de trabajo de mantenimiento",
  shifts: "Turnos de hoy",
  incidents: "Incidentes de seguridad"
};

const DETAIL_TABS: readonly DetailTab[] = ["hk", "wo", "shifts", "incidents"];

// Segment labels: full + count from 600 px; short and count-less on phones,
// where the four labels with counts measured 420 px in a 324 px column at
// 390 (fix:2-A qa#5) — there the active count moves to the section meta.
const DETAIL_TAB_LABEL: Record<DetailTab, { full: string; short: string }> = {
  hk: { full: "Tareas HK", short: "HK" },
  wo: { full: "Órdenes de trabajo", short: "Órdenes" },
  shifts: { full: "Turnos", short: "Turnos" },
  incidents: { full: "Incidentes", short: "Incidentes" }
};

// ---------------------------------------------------------------------------
// Skeleton — mirrors the rows above (strip, strip, table card, 3 trend cards).
// ---------------------------------------------------------------------------

function OpsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} label="Cargando resumen operativo…" />
      <CocoaSkeleton.Strip count={5} min={200} label="Cargando salud operativa…" />
      <CocoaSkeleton variant="card" height={260} />
      <CocoaSkeleton.Grid rows={[[4, 4, 4]]} height={220} label="Cargando tendencias…" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function OperationsDirectorScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { data, loading, error, refresh } = useApiData<Data>(
    `/dashboards/operations-director?propertyId=${propertyId}`,
    { pollIntervalMs: 30000 }
  );

  const [activeTab, setActiveTab] = useState<OpsTab>("overview");
  const [activeDetail, setActiveDetail] = useState<DetailTab>("hk");
  const tier = useViewportTier();
  const coarse = useCoarsePointer();
  const compactDetailTabs = tier === "phone";
  // Drill-down by device (D8): boards with a fine pointer, the mobile screens only on a touch phone.
  const mobile = mobileDrillDown(tier, coarse);

  const alerts = toArray<Alert>(data?.alerts);
  const degraded = toArray<string>(data?.degraded);
  const summary = data?.summary ?? { departmentsOk: 0, departmentsWarn: 0, departmentsError: 0, criticalAlerts: 0 };
  const miniCards = data?.miniCards;
  const details = data?.details;
  const trends = data?.trends;

  const summaryDegraded = isDegraded(DEGRADED_LABEL.summary, degraded);
  // A degraded roll-up paints «—» without a confident green/red bar.
  const kpiStatus = (status: CocoaKpiStatus): CocoaKpiStatus | undefined => (summaryDegraded ? undefined : status);

  const headerActions: ReactNode = (
    <>
      <DegradedBanner degraded={degraded} />
      {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
      {error ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
        {ACTIONS.refresh}
      </CocoaButton>
    </>
  );

  const detailCount = (rows: unknown, label: string): string => (isDegraded(label, degraded) ? "—" : number(toArray(rows).length));
  const detailCounts: Record<DetailTab, string> = {
    hk: detailCount(details?.hkTasks, DEGRADED_LABEL.details.hk),
    wo: detailCount(details?.workOrders, DEGRADED_LABEL.details.wo),
    shifts: detailCount(details?.shifts, DEGRADED_LABEL.details.shifts),
    incidents: detailCount(details?.safetyIncidents, DEGRADED_LABEL.details.incidents)
  };

  return (
    <CocoaPage
      eyebrow="Operaciones · Director"
      title={`Estado operativo · ${data?.propertyName ?? propertyName}`}
      subtitle={
        data
          ? `Foto cross-departamento. Cada bloque te lleva al tablero específico · datos a ${time(data.generatedAt)}`
          : "Foto cross-departamento. Cada bloque te lleva al tablero específico."
      }
      actions={headerActions}
      tabs={[
        { value: "overview", label: "Vista general" },
        { value: "alertas", label: `Alertas (${number(alerts.length)})` }
      ]}
      activeTab={activeTab}
      onTabChange={(value) => setActiveTab(value as OpsTab)}
      state={loading && !data ? "loading" : error && !data ? "error" : !data ? "empty" : "ready"}
      skeleton={<OpsSkeleton />}
      empty={{ title: "Sin datos operativos hoy", message: "El estado operativo se rellena con la actividad de los departamentos a lo largo del día." }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "operations-director-refresh", label: "Actualizar estado operativo", run: refresh },
        // UX-2 · D8 (F-D11): the panel's tasks are page commands, not only «Actualizar».
        { id: "operations-director-alertas", label: "Ver alertas", run: () => setActiveTab("alertas") },
        { id: "operations-director-pisos", label: "Ir a pisos", run: () => navigateTo(drillDownScreen("housekeeping", mobile)) },
        { id: "operations-director-mantenimiento", label: "Ir a mantenimiento", run: () => navigateTo(drillDownScreen("maintenance", mobile)) }
      ]}
    >
      {/* Summary tiles (siempre visibles, son el resumen ejecutivo). The
          roll-up is computed from safe()-wrapped department counters: a
          failed query would otherwise surface as "0 críticos" in green. */}
      <CocoaSection title="Resumen operativo" meta={plural(summary.departmentsOk + summary.departmentsWarn + summary.departmentsError, "departamento", "departamentos")}>
        <CocoaKpiStrip aria-label="Resumen operativo">
          <CocoaKpi label="Departamentos OK" value={number(summary.departmentsOk)} status={kpiStatus("ok")} polarity="neutral" degraded={summaryDegraded} />
          <CocoaKpi label="Atención" value={number(summary.departmentsWarn)} status={kpiStatus(summary.departmentsWarn > 0 ? "warning" : "ok")} polarity="neutral" degraded={summaryDegraded} />
          <CocoaKpi label="Críticos" value={number(summary.departmentsError)} status={kpiStatus(summary.departmentsError > 0 ? "critical" : "ok")} polarity="neutral" degraded={summaryDegraded} />
          <CocoaKpi label="Alertas críticas" value={number(summary.criticalAlerts)} status={kpiStatus(summary.criticalAlerts > 0 ? "critical" : "ok")} polarity="neutral" degraded={summaryDegraded} />
        </CocoaKpiStrip>
      </CocoaSection>

      {/* Tab: Vista general. */}
      {activeTab === "overview" ? (
        <>
          {/* Row 1 — mini-health cards. */}
          <CocoaSection title="Salud operativa" meta="5 módulos">
            {miniCards ? (
              <CocoaKpiStrip min={200} aria-label="Salud operativa">
                <DirectorOpsHealthMini {...buildHkMiniProps(miniCards.housekeeping, isDegraded(DEGRADED_LABEL.hkDelta, degraded), mobile)} />
                <DegradedCard label={DEGRADED_LABEL.maintenance} degraded={degraded} title="Mantenimiento">
                  <DirectorOpsHealthMini {...buildMaintenanceMiniProps(miniCards.maintenance, isDegraded(DEGRADED_LABEL.maintenanceDelta, degraded), mobile)} />
                </DegradedCard>
                <DegradedCard label={DEGRADED_LABEL.workforce} degraded={degraded} title="Personal">
                  <DirectorOpsHealthMini {...buildWorkforceMiniProps(miniCards.workforce)} />
                </DegradedCard>
                <DegradedCard label={DEGRADED_LABEL.safety} degraded={degraded} title="Seguridad">
                  <DirectorOpsHealthMini {...buildSafetyMiniProps(miniCards.safety)} />
                </DegradedCard>
                <DegradedCard label={DEGRADED_LABEL.pos} degraded={degraded} title="F&B / TPV hoy">
                  <DirectorOpsHealthMini {...buildPosMiniProps(miniCards.posRevenueToday)} />
                </DegradedCard>
              </CocoaKpiStrip>
            ) : (
              <CocoaState kind="empty" inline title="Sin datos para mostrar." />
            )}
          </CocoaSection>

          {/* Row 2 — detail tables (HK / WO / shifts / incidents). */}
          <CocoaSection title="Detalle operativo" meta={compactDetailTabs ? `${DETAIL_TAB_LABEL[activeDetail].full} · ${detailCounts[activeDetail]}` : undefined}>
            <div className="cocoa-stack" data-gap="3">
              <CocoaSegmentedControl
                size="small"
                aria-label="Detalle"
                value={activeDetail}
                onChange={(value) => setActiveDetail(value as DetailTab)}
                options={DETAIL_TABS.map((tab) => ({
                  value: tab,
                  label: compactDetailTabs ? DETAIL_TAB_LABEL[tab].short : `${DETAIL_TAB_LABEL[tab].full} (${detailCounts[tab]})`
                }))}
              />
              <DetailTable detail={activeDetail} details={details} degraded={degraded} />
            </div>
          </CocoaSection>

          {/* Row 3 — trend charts (7d). */}
          <CocoaGrid aria-label="Tendencias de siete días">
            <CocoaSpan cols={4} min={240}>
              <CocoaSection title="HK · habitaciones (7 días)" meta="Limpiadas vs programadas">
                <DegradedNote label={DEGRADED_LABEL.trends.hk} degraded={degraded}>
                  <PairTrendChart data={toArray<TrendPair>(trends?.housekeepingCleanedVsScheduled)} actualLabel="limpiadas" targetLabel="programadas" />
                </DegradedNote>
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={4} min={240}>
              <CocoaSection title="Mantenimiento · MTTR (7 días)" meta="Horas promedio de resolución">
                <DegradedNote label={DEGRADED_LABEL.trends.mttr} degraded={degraded}>
                  <SingleTrendChart
                    data={toArray<TrendPoint>(trends?.maintenanceMttrHours)}
                    label="MTTR"
                    tone="warning"
                    format={(v) => number(v, { maximumFractionDigits: 1 })}
                    suffix=" h"
                  />
                </DegradedNote>
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={4} min={240}>
              <CocoaSection title="Personal · cobertura (7 días)" meta="% de turnos con asignación">
                <DegradedNote label={DEGRADED_LABEL.trends.coverage} degraded={degraded}>
                  <SingleTrendChart
                    data={toArray<TrendPoint>(trends?.workforceCoveragePct)}
                    label="Cobertura"
                    tone="info"
                    format={(v) => percent(v, { maximumFractionDigits: 0 })}
                  />
                </DegradedNote>
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>
        </>
      ) : null}

      {/* Tab: Alertas críticas. */}
      {activeTab === "alertas" ? (
        <CocoaSection
          title="Atender ahora"
          meta={
            <CocoaBadge tone={summaryDegraded ? "neutral" : alerts.length > 0 ? "danger" : "success"} size="small">
              <DegradedValue label={DEGRADED_LABEL.summary} degraded={degraded}>
                {number(alerts.length)}
              </DegradedValue>
            </CocoaBadge>
          }
        >
          {alerts.length === 0 ? (
            <DegradedNote label={DEGRADED_LABEL.summary} degraded={degraded}>
              <CocoaState kind="empty" inline title="Sin alertas" />
            </DegradedNote>
          ) : (
            <ul className="c22-section__list" aria-label="Alertas críticas">
              {alerts.map((a) => (
                <li key={a.id}>
                  <div className="cocoa-stack" data-gap="1" style={growStyle}>
                    <div className="cocoa-row" data-gap="2">
                      <strong style={calloutStyle}>{a.title}</strong>
                      <CocoaBadge tone={SEVERITY_TONE[a.severity]} size="small">
                        {departmentLabel(a.department)}
                      </CocoaBadge>
                    </div>
                    {a.detail ? <span style={mutedStyle}>{a.detail}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CocoaSection>
      ) : null}
    </CocoaPage>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: detail tables
// ---------------------------------------------------------------------------

function DetailTable({ detail, details, degraded }: { detail: DetailTab; details: Details | undefined; degraded: string[] }) {
  if (!details) {
    return <CocoaState kind="empty" inline title="Sin datos para mostrar." />;
  }

  const emptyState = <CocoaState kind="empty" inline title="Sin elementos." />;
  const caption = DETAIL_CAPTION[detail];

  // Each detail list is a safe()-wrapped query: when it failed the API sends
  // [] and "Sin elementos." would read as a clean board.
  if (detail === "hk") {
    return (
      <DegradedNote label={DEGRADED_LABEL.details.hk} degraded={degraded}>
        <CocoaTable columns={HK_COLUMNS} rows={toArray<DetailHkTask>(details.hkTasks)} rowKey="id" density="comfortable" caption={caption} emptyState={emptyState} />
      </DegradedNote>
    );
  }
  if (detail === "wo") {
    return (
      <DegradedNote label={DEGRADED_LABEL.details.wo} degraded={degraded}>
        <CocoaTable columns={WO_COLUMNS} rows={toArray<DetailWorkOrder>(details.workOrders)} rowKey="id" density="comfortable" caption={caption} emptyState={emptyState} />
      </DegradedNote>
    );
  }
  if (detail === "shifts") {
    return (
      <DegradedNote label={DEGRADED_LABEL.details.shifts} degraded={degraded}>
        <CocoaTable columns={SHIFT_COLUMNS} rows={toArray<DetailShift>(details.shifts)} rowKey="id" density="comfortable" caption={caption} emptyState={emptyState} />
      </DegradedNote>
    );
  }
  return (
    <DegradedNote label={DEGRADED_LABEL.details.incidents} degraded={degraded}>
      <CocoaTable columns={INCIDENT_COLUMNS} rows={toArray<DetailSafetyIncident>(details.safetyIncidents)} rowKey="id" density="comfortable" caption={caption} emptyState={emptyState} />
    </DegradedNote>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: trend charts (CocoaChart.Line, geometry from cocoa-chart-math)
// ---------------------------------------------------------------------------

const TREND_HEIGHT = 140;

function PairTrendChart({ data, actualLabel, targetLabel }: { data: TrendPair[]; actualLabel: string; targetLabel: string }) {
  if (data.length === 0) {
    return <CocoaState kind="empty" inline title="Sin datos de tendencia." />;
  }
  const series: CocoaLineSeries[] = [
    { id: "target", label: targetLabel, tone: "tertiary", dashed: true, width: 1, points: data.map((p) => ({ x: date(p.date, "dayMonth"), y: p.target })) },
    { id: "actual", label: actualLabel, tone: "success", width: 2, points: data.map((p) => ({ x: date(p.date, "dayMonth"), y: p.actual })) }
  ];
  return <CocoaChart.Line series={series} height={TREND_HEIGHT} ticks={3} aria-label={`${actualLabel} frente a ${targetLabel}, últimos 7 días`} />;
}

function SingleTrendChart({
  data,
  label,
  tone,
  format,
  suffix
}: {
  data: TrendPoint[];
  label: string;
  tone: CocoaTone;
  format: (value: number) => string;
  suffix?: string;
}) {
  if (data.length === 0) {
    return <CocoaState kind="empty" inline title="Sin datos de tendencia." />;
  }
  const latest = data[data.length - 1]?.value ?? 0;
  const series: CocoaLineSeries[] = [{ id: "value", label, tone, width: 2, points: data.map((p) => ({ x: date(p.date, "dayMonth"), y: p.value })) }];
  return (
    <div className="cocoa-stack" data-gap="2">
      <CocoaStat label="último día" value={format(latest)} suffix={suffix} tone={tone} size="large" />
      <CocoaChart.Line series={series} height={TREND_HEIGHT} ticks={3} legend={false} valueFormat={format} aria-label={`${label}, últimos 7 días`} />
    </div>
  );
}
