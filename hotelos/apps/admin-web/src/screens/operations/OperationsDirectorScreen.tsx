// Operations Director Screen — vista consolidada cross-departamento.
//
// Para el director de operaciones (un nivel por encima de jefes de
// recepción/HK/mantenimiento). Muestra el estado de cada departamento en una
// sola pantalla con drilldown a cada tablero específico.
//
// Cocoa migration (07-Management): repaint visual con CocoaPageHeader,
// CocoaCard wrappers, CocoaSegmentedControl para alternar entre la foto general
// y el detalle de alertas. Mismos endpoints, polling y navegación.
//
// Layout v2 (mayo 2026):
//   Row 1 — Mini cards (DirectorOpsHealthMini): HK, Maintenance, Workforce,
//           Safety, POS. Consume miniCards[] del endpoint enriquecido.
//   Row 2 — Detail tables: tareas HK, work orders, turnos, incidentes safety.
//   Row 3 — Trends charts (7d): HK cleaned vs scheduled, MTTR mantenimiento,
//           coverage workforce.

import { useState, type CSSProperties, type ReactNode } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import {
  DirectorOpsHealthMini,
  type DirectorOpsHealthMiniProps,
  type DirectorOpsHealthStatus
} from "../../components/cocoa-director/DirectorOpsHealthMini";
import {
  SEVERITY_TONE,
  toneToColorToken,
  type ManagementTone
} from "./managementBadges";

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
};

type OpsTab = "overview" | "alertas";
type DetailTab = "hk" | "wo" | "shifts" | "incidents";

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

// ---------------------------------------------------------------------------
// Local style helpers (token-based; no px/hex literals).
// ---------------------------------------------------------------------------

const sectionStackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-4)"
};

const summaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
  gap: "var(--cocoa-space-3)"
};

const miniCardsRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))",
  gap: "var(--cocoa-space-3)"
};

const trendsRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))",
  gap: "var(--cocoa-space-3)"
};

const cardHeadStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  marginBottom: "var(--cocoa-space-3)",
  flexWrap: "wrap"
};

const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-title-3)",
  fontWeight: 600,
  color: "var(--cocoa-label)"
};

function badgeStyle(tone: ManagementTone): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px var(--cocoa-space-2)",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    letterSpacing: "var(--cocoa-tracking-wide)",
    textTransform: "uppercase",
    color: toneToColorToken(tone),
    background: "transparent",
    border: `1px solid ${toneToColorToken(tone)}`,
    borderRadius: "var(--cocoa-radius-sm)",
    lineHeight: 1.4
  };
}

function summaryTileStyle(tone: ManagementTone): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-1)",
    padding: "var(--cocoa-space-3)",
    borderLeft: `3px solid ${toneToColorToken(tone)}`
  };
}

const summaryLabelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "var(--cocoa-tracking-wide)",
  fontWeight: 600
};

const summaryValueStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-large-title)",
  fontWeight: 700,
  color: "var(--cocoa-label)",
  lineHeight: 1.1
};

const alertItemStyle = (tone: ManagementTone, clickable: boolean): CSSProperties => ({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  padding: "var(--cocoa-space-3)",
  borderRadius: "var(--cocoa-radius-md)",
  border: `1px solid ${toneToColorToken(tone)}`,
  borderLeftWidth: "4px",
  background: "var(--cocoa-background-content)",
  cursor: clickable ? "pointer" : "default"
});

// Table styles for the row 2 detail tables.
const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label)"
};

const theadStyle: CSSProperties = {
  textAlign: "left",
  fontSize: "var(--cocoa-fs-caption)",
  textTransform: "uppercase",
  letterSpacing: "var(--cocoa-tracking-wide)",
  color: "var(--cocoa-label-secondary)",
  borderBottom: "1px solid var(--cocoa-separator)"
};

const thStyle: CSSProperties = {
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  fontWeight: 600
};

const tdStyle: CSSProperties = {
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  borderBottom: "1px solid var(--cocoa-separator)",
  verticalAlign: "top"
};

const detailTabsStyle: CSSProperties = {
  display: "inline-flex",
  gap: "var(--cocoa-space-1)",
  marginBottom: "var(--cocoa-space-3)",
  flexWrap: "wrap"
};

function detailTabButtonStyle(active: boolean): CSSProperties {
  return {
    padding: "var(--cocoa-space-1) var(--cocoa-space-3)",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    letterSpacing: "var(--cocoa-tracking-wide)",
    textTransform: "uppercase",
    color: active ? "var(--cocoa-label)" : "var(--cocoa-label-secondary)",
    background: active ? "var(--cocoa-background-control)" : "transparent",
    border: `1px solid ${active ? "var(--cocoa-separator)" : "transparent"}`,
    borderRadius: "var(--cocoa-radius-sm)",
    cursor: "pointer",
    lineHeight: 1.4
  };
}

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

function buildHkMiniProps(mc: MiniCards["housekeeping"]): DirectorOpsHealthMiniProps {
  return {
    module: "housekeeping",
    title: "Housekeeping",
    primaryCount: mc.clean,
    primaryLabel: "limpias",
    breakdown: [
      { label: "sucias", count: mc.dirty, color: "var(--cocoa-warning)" },
      { label: "insp.", count: mc.inspected, color: "var(--cocoa-success)" },
      { label: "OOO", count: mc.ooo, color: "var(--cocoa-danger)" }
    ],
    status: hkStatus(mc),
    deltaVsYesterday: mc.deltaVsYesterday,
    onDrillDown: () => navigateTo("HousekeepingMobileScreen")
  };
}

function buildMaintenanceMiniProps(mc: MiniCards["maintenance"]): DirectorOpsHealthMiniProps {
  return {
    module: "maintenance",
    title: "Mantenimiento",
    primaryCount: mc.open + mc.inProgress,
    primaryLabel: "activas",
    breakdown: [
      { label: "abiertas", count: mc.open },
      { label: "en curso", count: mc.inProgress, color: "var(--cocoa-info)" },
      { label: "crítica", count: mc.critical, color: "var(--cocoa-danger)" }
    ],
    status: maintenanceStatus(mc),
    deltaVsYesterday: mc.deltaVsYesterday,
    onDrillDown: () => navigateTo("MaintenanceMobileScreen")
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
        color:
          mc.coveragePct >= 90
            ? "var(--cocoa-success)"
            : mc.coveragePct >= 70
            ? "var(--cocoa-warning)"
            : "var(--cocoa-danger)"
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
    breakdown: [
      { label: "críticos", count: mc.criticalCount, color: "var(--cocoa-danger)" }
    ],
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

  const alerts = data?.alerts ?? [];
  const summary = data?.summary ?? { departmentsOk: 0, departmentsWarn: 0, departmentsError: 0, criticalAlerts: 0 };
  const miniCards = data?.miniCards;
  const details = data?.details;
  const trends = data?.trends;

  const headerActions: ReactNode = (
    <>
      {loading ? <span style={badgeStyle("info")}>cargando</span> : null}
      {error ? <span style={badgeStyle("danger")}>{error}</span> : null}
      <CocoaButton
        variant="bordered"
        tone="neutral"
        size="small"
        onClick={refresh}
        aria-label="Refrescar"
      >
        Actualizar
      </CocoaButton>
    </>
  );

  return (
    <div style={sectionStackStyle}>
      <CocoaPageHeader
        eyebrow="Operaciones · Director"
        title={`Estado operativo · ${data?.propertyName ?? propertyName}`}
        subtitle="Foto cross-departamento. Cada bloque te lleva al tablero específico."
        actions={headerActions}
        tabs={[
          { value: "overview", label: "Vista general" },
          { value: "alertas", label: `Alertas (${alerts.length})` }
        ]}
        activeTab={activeTab}
        onTabChange={(value) => setActiveTab(value as OpsTab)}
      />

      {/* Summary tiles (siempre visibles, son el resumen ejecutivo). */}
      <CocoaCard variant="bordered" padding="md">
        <div style={cardHeadStyle}>
          <h3 style={cardTitleStyle}>Resumen operativo</h3>
        </div>
        <div style={summaryGridStyle}>
          <div style={summaryTileStyle("success")}>
            <span style={summaryLabelStyle}>Departamentos OK</span>
            <span style={summaryValueStyle}>{summary.departmentsOk}</span>
          </div>
          <div style={summaryTileStyle("warning")}>
            <span style={summaryLabelStyle}>Atención</span>
            <span style={summaryValueStyle}>{summary.departmentsWarn}</span>
          </div>
          <div style={summaryTileStyle(summary.departmentsError > 0 ? "danger" : "success")}>
            <span style={summaryLabelStyle}>Críticos</span>
            <span style={summaryValueStyle}>{summary.departmentsError}</span>
          </div>
          <div style={summaryTileStyle(summary.criticalAlerts > 0 ? "danger" : "success")}>
            <span style={summaryLabelStyle}>Alertas críticas</span>
            <span style={summaryValueStyle}>{summary.criticalAlerts}</span>
          </div>
        </div>
      </CocoaCard>

      {/* Tab: Vista general. */}
      {activeTab === "overview" ? (
        <>
          {/* Row 1 — mini-health cards. */}
          <CocoaCard variant="bordered" padding="md">
            <div style={cardHeadStyle}>
              <h3 style={cardTitleStyle}>Salud operativa</h3>
              <span
                style={{
                  fontSize: "var(--cocoa-fs-caption)",
                  color: "var(--cocoa-label-secondary)"
                }}
              >
                5 módulos
              </span>
            </div>
            {miniCards ? (
              <div style={miniCardsRowStyle}>
                <DirectorOpsHealthMini {...buildHkMiniProps(miniCards.housekeeping)} />
                <DirectorOpsHealthMini {...buildMaintenanceMiniProps(miniCards.maintenance)} />
                <DirectorOpsHealthMini {...buildWorkforceMiniProps(miniCards.workforce)} />
                <DirectorOpsHealthMini {...buildSafetyMiniProps(miniCards.safety)} />
                <DirectorOpsHealthMini {...buildPosMiniProps(miniCards.posRevenueToday)} />
              </div>
            ) : (
              <p
                style={{
                  fontSize: "var(--cocoa-fs-callout)",
                  color: "var(--cocoa-label-secondary)"
                }}
              >
                Sin datos para mostrar.
              </p>
            )}
          </CocoaCard>

          {/* Row 2 — detail tables (HK / WO / shifts / incidents). */}
          <CocoaCard variant="bordered" padding="md">
            <div style={cardHeadStyle}>
              <h3 style={cardTitleStyle}>Detalle operativo</h3>
            </div>
            <div style={detailTabsStyle} role="tablist" aria-label="Detalle">
              <button
                type="button"
                role="tab"
                aria-selected={activeDetail === "hk"}
                style={detailTabButtonStyle(activeDetail === "hk")}
                onClick={() => setActiveDetail("hk")}
              >
                Tareas HK ({details?.hkTasks.length ?? 0})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeDetail === "wo"}
                style={detailTabButtonStyle(activeDetail === "wo")}
                onClick={() => setActiveDetail("wo")}
              >
                Work orders ({details?.workOrders.length ?? 0})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeDetail === "shifts"}
                style={detailTabButtonStyle(activeDetail === "shifts")}
                onClick={() => setActiveDetail("shifts")}
              >
                Turnos ({details?.shifts.length ?? 0})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeDetail === "incidents"}
                style={detailTabButtonStyle(activeDetail === "incidents")}
                onClick={() => setActiveDetail("incidents")}
              >
                Incidentes ({details?.safetyIncidents.length ?? 0})
              </button>
            </div>
            <DetailTable detail={activeDetail} details={details} />
          </CocoaCard>

          {/* Row 3 — trend charts (7d). */}
          <div style={trendsRowStyle}>
            <TrendCard
              title="HK · habitaciones (7 días)"
              subtitle="Limpiadas vs programadas"
            >
              <PairTrendChart
                data={trends?.housekeepingCleanedVsScheduled ?? []}
                actualLabel="limpiadas"
                targetLabel="programadas"
              />
            </TrendCard>
            <TrendCard
              title="Mantenimiento · MTTR (7 días)"
              subtitle="Horas promedio de resolución"
            >
              <SingleTrendChart
                data={trends?.maintenanceMttrHours ?? []}
                suffix="h"
                color="var(--cocoa-warning)"
              />
            </TrendCard>
            <TrendCard
              title="Personal · cobertura (7 días)"
              subtitle="% de turnos con asignación"
            >
              <SingleTrendChart
                data={trends?.workforceCoveragePct ?? []}
                suffix="%"
                color="var(--cocoa-info)"
              />
            </TrendCard>
          </div>
        </>
      ) : null}

      {/* Tab: Alertas críticas. */}
      {activeTab === "alertas" ? (
        <CocoaCard variant="bordered" padding="md">
          <div style={cardHeadStyle}>
            <h3 style={cardTitleStyle}>Atender ahora</h3>
            <span style={badgeStyle(alerts.length > 0 ? "danger" : "success")}>
              {alerts.length}
            </span>
          </div>
          {alerts.length === 0 ? (
            <p
              style={{
                fontSize: "var(--cocoa-fs-callout)",
                color: "var(--cocoa-label-secondary)"
              }}
            >
              Sin alertas
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: "var(--cocoa-space-2)"
              }}
            >
              {alerts.map((a) => {
                const tone = SEVERITY_TONE[a.severity];
                return (
                  <li key={a.id} style={alertItemStyle(tone, false)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          gap: "var(--cocoa-space-2)",
                          alignItems: "center",
                          flexWrap: "wrap"
                        }}
                      >
                        <strong
                          style={{
                            fontSize: "var(--cocoa-fs-body)",
                            color: "var(--cocoa-label)"
                          }}
                        >
                          {a.title}
                        </strong>
                        <span style={badgeStyle(tone)}>{a.department}</span>
                      </div>
                      {a.detail ? (
                        <div
                          style={{
                            fontSize: "var(--cocoa-fs-caption)",
                            color: "var(--cocoa-label-secondary)",
                            marginTop: "var(--cocoa-space-1)"
                          }}
                        >
                          {a.detail}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CocoaCard>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: detail tables
// ---------------------------------------------------------------------------

function DetailTable({
  detail,
  details
}: {
  detail: DetailTab;
  details: Details | undefined;
}) {
  if (!details) {
    return (
      <p
        style={{
          fontSize: "var(--cocoa-fs-callout)",
          color: "var(--cocoa-label-secondary)"
        }}
      >
        Sin datos para mostrar.
      </p>
    );
  }

  if (detail === "hk") return <HkTasksTable items={details.hkTasks} />;
  if (detail === "wo") return <WorkOrdersTable items={details.workOrders} />;
  if (detail === "shifts") return <ShiftsTable items={details.shifts} />;
  return <IncidentsTable items={details.safetyIncidents} />;
}

function EmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ ...tdStyle, color: "var(--cocoa-label-secondary)" }}>
        Sin elementos.
      </td>
    </tr>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function priorityBadge(priority: string): ReactNode {
  const tone: ManagementTone =
    priority === "emergency" || priority === "critical" || priority === "high"
      ? "danger"
      : priority === "normal"
      ? "info"
      : "neutral";
  return <span style={badgeStyle(tone)}>{priority}</span>;
}

function severityBadge(severity: string): ReactNode {
  const tone: ManagementTone =
    severity === "critical" ? "danger" : severity === "warning" || severity === "high" ? "warning" : "info";
  return <span style={badgeStyle(tone)}>{severity}</span>;
}

function statusBadge(status: string): ReactNode {
  const tone: ManagementTone =
    status === "done" || status === "resolved" || status === "closed" || status === "completed"
      ? "success"
      : status === "in_progress" || status === "investigating"
      ? "info"
      : "neutral";
  return <span style={badgeStyle(tone)}>{status}</span>;
}

function HkTasksTable({ items }: { items: DetailHkTask[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead style={theadStyle}>
          <tr>
            <th style={thStyle}>Habitación</th>
            <th style={thStyle}>Tarea</th>
            <th style={thStyle}>Prioridad</th>
            <th style={thStyle}>Estado</th>
            <th style={thStyle}>Asignado</th>
            <th style={thStyle}>Vence</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={6} />
          ) : (
            items.map((t) => (
              <tr key={t.id}>
                <td style={tdStyle}>{t.roomId}</td>
                <td style={tdStyle}>{t.taskType}</td>
                <td style={tdStyle}>{priorityBadge(t.priority)}</td>
                <td style={tdStyle}>{statusBadge(t.status)}</td>
                <td style={tdStyle}>{t.assignedTo ?? "—"}</td>
                <td style={tdStyle}>{fmtDate(t.dueAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function WorkOrdersTable({ items }: { items: DetailWorkOrder[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead style={theadStyle}>
          <tr>
            <th style={thStyle}>Título</th>
            <th style={thStyle}>Prioridad</th>
            <th style={thStyle}>Estado</th>
            <th style={thStyle}>Habitación</th>
            <th style={thStyle}>Asignado</th>
            <th style={thStyle}>Vence</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={6} />
          ) : (
            items.map((wo) => (
              <tr key={wo.id}>
                <td style={tdStyle}>{wo.title}</td>
                <td style={tdStyle}>{priorityBadge(wo.priority)}</td>
                <td style={tdStyle}>{statusBadge(wo.status)}</td>
                <td style={tdStyle}>{wo.roomId ?? "—"}</td>
                <td style={tdStyle}>{wo.assignedTo ?? "—"}</td>
                <td style={tdStyle}>{fmtDate(wo.dueDate)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ShiftsTable({ items }: { items: DetailShift[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead style={theadStyle}>
          <tr>
            <th style={thStyle}>Inicio</th>
            <th style={thStyle}>Fin</th>
            <th style={thStyle}>Rol</th>
            <th style={thStyle}>Estado</th>
            <th style={thStyle}>Asignación</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={5} />
          ) : (
            items.map((s) => (
              <tr key={s.id}>
                <td style={tdStyle}>{fmtTime(s.startAt)}</td>
                <td style={tdStyle}>{fmtTime(s.endAt)}</td>
                <td style={tdStyle}>{s.roleLabel ?? "—"}</td>
                <td style={tdStyle}>{statusBadge(s.status)}</td>
                <td style={tdStyle}>
                  {s.staffProfileId ? (
                    s.staffProfileId
                  ) : (
                    <span style={{ color: "var(--cocoa-warning)" }}>Sin asignar</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function IncidentsTable({ items }: { items: DetailSafetyIncident[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead style={theadStyle}>
          <tr>
            <th style={thStyle}>Título</th>
            <th style={thStyle}>Tipo</th>
            <th style={thStyle}>Severidad</th>
            <th style={thStyle}>Estado</th>
            <th style={thStyle}>Ocurrió</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={5} />
          ) : (
            items.map((i) => (
              <tr key={i.id}>
                <td style={tdStyle}>{i.title}</td>
                <td style={tdStyle}>{i.incidentType}</td>
                <td style={tdStyle}>{severityBadge(i.severity)}</td>
                <td style={tdStyle}>{statusBadge(i.status)}</td>
                <td style={tdStyle}>{fmtDate(i.occurredAt ?? i.createdAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: trend charts (lightweight SVG, no deps)
// ---------------------------------------------------------------------------

function TrendCard({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <CocoaCard variant="bordered" padding="md">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--cocoa-space-1)",
          marginBottom: "var(--cocoa-space-3)"
        }}
      >
        <h4
          style={{
            margin: 0,
            fontSize: "var(--cocoa-fs-headline)",
            fontWeight: 600,
            color: "var(--cocoa-label)"
          }}
        >
          {title}
        </h4>
        <span
          style={{
            fontSize: "var(--cocoa-fs-caption)",
            color: "var(--cocoa-label-secondary)"
          }}
        >
          {subtitle}
        </span>
      </div>
      {children}
    </CocoaCard>
  );
}

const CHART_W = 320;
const CHART_H = 120;
const CHART_PAD_X = 8;
const CHART_PAD_Y = 12;

function dayLabel(iso: string): string {
  // "YYYY-MM-DD" → "DD/MM"
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}`;
}

function buildScales(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 1 };
  const filtered = values.filter((v) => Number.isFinite(v));
  if (filtered.length === 0) return { min: 0, max: 1 };
  const max = Math.max(...filtered, 1);
  return { min: 0, max };
}

function PairTrendChart({
  data,
  actualLabel,
  targetLabel
}: {
  data: TrendPair[];
  actualLabel: string;
  targetLabel: string;
}) {
  if (data.length === 0) {
    return (
      <p
        style={{
          fontSize: "var(--cocoa-fs-callout)",
          color: "var(--cocoa-label-secondary)"
        }}
      >
        Sin datos de tendencia.
      </p>
    );
  }
  const all = data.flatMap((p) => [p.actual, p.target]);
  const { max } = buildScales(all);
  const innerW = CHART_W - CHART_PAD_X * 2;
  const innerH = CHART_H - CHART_PAD_Y * 2;
  const step = data.length > 1 ? innerW / (data.length - 1) : 0;

  function pointFor(value: number, index: number): { x: number; y: number } {
    const x = CHART_PAD_X + step * index;
    const y = CHART_PAD_Y + innerH - (value / max) * innerH;
    return { x, y };
  }

  const actualPath = data
    .map((p, i) => {
      const { x, y } = pointFor(p.actual, i);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const targetPath = data
    .map((p, i) => {
      const { x, y } = pointFor(p.target, i);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)" }}>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        height={CHART_H}
        role="img"
        aria-label={`${actualLabel} vs ${targetLabel}`}
        style={{ display: "block" }}
      >
        <path
          d={targetPath}
          fill="none"
          stroke="var(--cocoa-label-tertiary)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={actualPath}
          fill="none"
          stroke="var(--cocoa-success)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {data.map((p, i) => {
          const { x, y } = pointFor(p.actual, i);
          return <circle key={`a-${p.date}`} cx={x} cy={y} r={2.5} fill="var(--cocoa-success)" />;
        })}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "var(--cocoa-fs-caption)",
          color: "var(--cocoa-label-secondary)"
        }}
      >
        {data.map((p) => (
          <span key={p.date}>{dayLabel(p.date)}</span>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          gap: "var(--cocoa-space-3)",
          fontSize: "var(--cocoa-fs-caption)",
          color: "var(--cocoa-label-secondary)"
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--cocoa-space-1)" }}>
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 2,
              background: "var(--cocoa-success)"
            }}
          />
          {actualLabel}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--cocoa-space-1)" }}>
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 2,
              background: "var(--cocoa-label-tertiary)"
            }}
          />
          {targetLabel}
        </span>
      </div>
    </div>
  );
}

function SingleTrendChart({
  data,
  suffix,
  color
}: {
  data: TrendPoint[];
  suffix: string;
  color: string;
}) {
  if (data.length === 0) {
    return (
      <p
        style={{
          fontSize: "var(--cocoa-fs-callout)",
          color: "var(--cocoa-label-secondary)"
        }}
      >
        Sin datos de tendencia.
      </p>
    );
  }
  const { max } = buildScales(data.map((p) => p.value));
  const innerW = CHART_W - CHART_PAD_X * 2;
  const innerH = CHART_H - CHART_PAD_Y * 2;
  const step = data.length > 1 ? innerW / (data.length - 1) : 0;

  function pointFor(value: number, index: number): { x: number; y: number } {
    const x = CHART_PAD_X + step * index;
    const y = CHART_PAD_Y + innerH - (value / max) * innerH;
    return { x, y };
  }

  const linePath = data
    .map((p, i) => {
      const { x, y } = pointFor(p.value, i);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const latest = data[data.length - 1]?.value ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--cocoa-space-2)"
        }}
      >
        <strong
          style={{
            fontSize: "var(--cocoa-fs-title-1)",
            fontWeight: 700,
            color,
            lineHeight: 1
          }}
        >
          {latest}
          {suffix}
        </strong>
        <span
          style={{
            fontSize: "var(--cocoa-fs-caption)",
            color: "var(--cocoa-label-secondary)"
          }}
        >
          último día
        </span>
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        height={CHART_H}
        role="img"
        aria-label="Tendencia"
        style={{ display: "block" }}
      >
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {data.map((p, i) => {
          const { x, y } = pointFor(p.value, i);
          return <circle key={p.date} cx={x} cy={y} r={2.5} fill={color} />;
        })}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "var(--cocoa-fs-caption)",
          color: "var(--cocoa-label-secondary)"
        }}
      >
        {data.map((p) => (
          <span key={p.date}>{dayLabel(p.date)}</span>
        ))}
      </div>
    </div>
  );
}
