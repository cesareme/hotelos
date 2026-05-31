// GroupsCalendarScreen — Vista Gantt horizontal de grupos activos.
//
// Pantalla full-page (NO modal) que muestra todos los grupos activos del
// periodo en formato Gantt: una fila por grupo con barra coloreada de
// arrival → departure. El marker de cut-off date aparece como línea
// vertical roja punteada dentro de la barra.
//
// Endpoint: GET /properties/:propertyId/groups/pickup-summary?windowDays=N
//
// Controles UX:
//   - Selector de rango: 30 / 90 / 180 días.
//   - Filtros: tipo (all / corporate / mice / smerf / leisure / wedding /
//     sports / wholesale) y status (all / inquiry / tentative / definite).
//   - Click en barra → abre GroupDetailDialog.
//   - Tooltip onMouseEnter con info detallada.
//
// KPIs encima del Gantt:
//   - Total grupos en periodo
//   - Total habitaciones bloqueadas
//   - Pickup% global
//   - Próximos cut-offs (grupos con cutOffDate < 14d)
//
// Empty state si no hay grupos coincidentes con filtros.

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { LoadingBlock, ErrorState, EmptyState } from "../../components/States";
import { getActivePropertyId } from "../../services/activeProperty";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { GROUPS_INSTRUCTIONS } from "../../content/screen-instructions/groups";
import { GroupDetailDialog } from "./GroupDetailDialog";

// ───────────────────────────────────────────────────────── Tipos del API

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

// ───────────────────────────────────────────────────────── Configuración visual

const DAY_CELL_WIDTH = 24; // px por día (header + filas)
const NAME_COL_WIDTH = 200; // px de la columna fija con el nombre
const ROW_HEIGHT = 36; // px por fila

const STATUS_COLOR: Record<string, { bg: string; ink: string; label: string }> = {
  inquiry: { bg: "#cfd2d6", ink: "#3a3f47", label: "Inquiry" },
  tentative: { bg: "#f0b429", ink: "#5b3700", label: "Tentative" },
  definite: { bg: "#2f9e44", ink: "#ffffff", label: "Definite" },
  in_house: { bg: "#0d6e2d", ink: "#ffffff", label: "In house" },
  cancelled: { bg: "#dc2626", ink: "#ffffff", label: "Cancelled" }
};

function statusTone(status: string) {
  return STATUS_COLOR[status.toLowerCase()] ?? { bg: "#94a3b8", ink: "#ffffff", label: status };
}

const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "Todos los tipos" },
  { value: "corporate", label: "Corporate" },
  { value: "mice", label: "MICE" },
  { value: "smerf", label: "SMERF" },
  { value: "leisure", label: "Leisure" },
  { value: "wedding", label: "Wedding" },
  { value: "sports", label: "Sports" },
  { value: "wholesale", label: "Wholesale" }
];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "Todos los estados" },
  { value: "inquiry", label: "Inquiry" },
  { value: "tentative", label: "Tentative" },
  { value: "definite", label: "Definite" }
];

const WINDOW_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 30, label: "Próximos 30 días" },
  { days: 90, label: "Próximos 90 días" },
  { days: 180, label: "Próximos 180 días" }
];

// ───────────────────────────────────────────────────────── Helpers de fechas

function toUtcStartOfDay(d: Date): number {
  // Normaliza a milisegundos del inicio del día (UTC) para evitar drift de zonas.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysBetween(a: Date, b: Date): number {
  const ms = toUtcStartOfDay(b) - toUtcStartOfDay(a);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function formatShort(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

function formatLong(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

// ───────────────────────────────────────────────────────── Estilos internos

const styles: Record<string, CSSProperties> = {
  controlsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "center",
    marginTop: 12
  },
  controlGroup: {
    display: "flex",
    gap: 6,
    alignItems: "center"
  },
  kpiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
    marginTop: 16
  },
  kpiCard: {
    padding: 12,
    borderRadius: 6,
    background: "var(--surface-2, rgba(0,0,0,0.03))",
    border: "1px solid var(--border, rgba(0,0,0,0.06))",
    display: "flex",
    flexDirection: "column",
    gap: 4
  },
  kpiLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--muted, #6b7280)"
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: 700,
    fontFeatureSettings: '"tnum"',
    color: "var(--ink)"
  },
  ganttWrap: {
    marginTop: 16,
    border: "1px solid var(--border, rgba(0,0,0,0.08))",
    borderRadius: 6,
    overflow: "auto",
    background: "var(--surface)",
    maxHeight: "calc(100vh - 380px)"
  },
  ganttHeader: {
    display: "grid",
    position: "sticky",
    top: 0,
    background: "var(--surface)",
    zIndex: 2,
    borderBottom: "2px solid var(--border, rgba(0,0,0,0.12))"
  },
  ganttHeaderName: {
    width: NAME_COL_WIDTH,
    minWidth: NAME_COL_WIDTH,
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--muted, #6b7280)",
    background: "var(--surface)",
    borderRight: "1px solid var(--border, rgba(0,0,0,0.08))",
    position: "sticky",
    left: 0,
    zIndex: 3
  },
  ganttHeaderDayCell: {
    width: DAY_CELL_WIDTH,
    fontSize: 10,
    textAlign: "center",
    padding: "4px 0",
    color: "var(--muted, #6b7280)",
    borderRight: "1px solid var(--border, rgba(0,0,0,0.05))",
    fontFeatureSettings: '"tnum"',
    boxSizing: "border-box"
  },
  ganttHeaderMonthCell: {
    fontSize: 11,
    fontWeight: 600,
    padding: "4px 6px",
    textAlign: "left",
    color: "var(--ink)",
    background: "var(--surface-1, rgba(0,0,0,0.02))",
    borderRight: "1px solid var(--border, rgba(0,0,0,0.08))",
    borderBottom: "1px solid var(--border, rgba(0,0,0,0.05))",
    boxSizing: "border-box"
  },
  ganttRow: {
    display: "flex",
    alignItems: "stretch",
    borderBottom: "1px solid var(--border, rgba(0,0,0,0.05))",
    minHeight: ROW_HEIGHT
  },
  ganttRowName: {
    width: NAME_COL_WIDTH,
    minWidth: NAME_COL_WIDTH,
    padding: "6px 10px",
    fontSize: 12,
    color: "var(--ink)",
    background: "var(--surface)",
    borderRight: "1px solid var(--border, rgba(0,0,0,0.08))",
    position: "sticky",
    left: 0,
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    justifyContent: "center"
  },
  ganttRowTrack: {
    position: "relative",
    height: ROW_HEIGHT,
    flex: "1 0 auto"
  },
  ganttBar: {
    position: "absolute",
    top: 6,
    height: ROW_HEIGHT - 12,
    borderRadius: 4,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    padding: "0 6px",
    fontSize: 11,
    fontWeight: 600,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    border: "1px solid rgba(0,0,0,0.08)",
    transition: "transform 80ms ease, box-shadow 80ms ease"
  },
  cutOffMarker: {
    position: "absolute",
    top: 2,
    bottom: 2,
    width: 2,
    borderLeft: "2px dashed #dc2626",
    pointerEvents: "none"
  },
  todayMarker: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    background: "rgba(13, 138, 95, 0.55)",
    pointerEvents: "none",
    zIndex: 0
  },
  legendRow: {
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
    fontSize: 12,
    marginTop: 10,
    alignItems: "center"
  },
  legendDot: {
    display: "inline-block",
    width: 12,
    height: 12,
    borderRadius: 3,
    marginRight: 6,
    verticalAlign: "middle"
  }
};

// ───────────────────────────────────────────────────────── Componente principal

export function GroupsCalendarScreen() {
  const propertyId = getActivePropertyId();

  const [windowDays, setWindowDays] = useState<number>(180);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [hoverGroupId, setHoverGroupId] = useState<string | null>(null);

  const state = useApiData<PickupResponse>(
    `/properties/${propertyId}/groups/pickup-summary?windowDays=${windowDays}`,
    { pollIntervalMs: 120000 }
  );

  // Ventana de fechas: usa la del API si está, si no construye a partir de hoy.
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

  // Aplica filtros + ordena por arrivalDate ascendente.
  const filteredGroups = useMemo(() => {
    const all = state.data?.groups ?? [];
    return all
      .filter((g) => typeFilter === "all" || g.groupType.toLowerCase() === typeFilter)
      .filter((g) => statusFilter === "all" || g.status.toLowerCase() === statusFilter)
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.arrivalDate).getTime();
        const tb = new Date(b.arrivalDate).getTime();
        return ta - tb;
      });
  }, [state.data?.groups, typeFilter, statusFilter]);

  // KPIs derivados
  const kpis = useMemo(() => {
    const totalGroups = filteredGroups.length;
    const totalBlocked = filteredGroups.reduce((s, g) => s + (g.totalBlocked ?? 0), 0);
    const totalPickedUp = filteredGroups.reduce((s, g) => s + (g.totalPickedUp ?? 0), 0);
    const pickupPct = totalBlocked > 0 ? Math.round((totalPickedUp / totalBlocked) * 100) : 0;
    const upcomingCutoffs = filteredGroups.filter(
      (g) => g.daysToCutOff != null && g.daysToCutOff >= 0 && g.daysToCutOff < 14
    ).length;
    return { totalGroups, totalBlocked, pickupPct, upcomingCutoffs };
  }, [filteredGroups]);

  // Genera array de días + cabecera por meses agrupados.
  const dayHeader = useMemo(() => {
    const days: Array<{ date: Date; iso: string }> = [];
    for (let i = 0; i < windowRange.total; i++) {
      const d = new Date(windowRange.from.getTime() + i * 24 * 60 * 60 * 1000);
      days.push({ date: d, iso: d.toISOString().slice(0, 10) });
    }
    // Agrupa por mes para la fila superior
    type MonthGroup = { key: string; label: string; count: number };
    const months: MonthGroup[] = [];
    for (const { date } of days) {
      const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      const label = date.toLocaleDateString("es-ES", { month: "short", year: "2-digit" });
      const last = months[months.length - 1];
      if (last && last.key === key) {
        last.count += 1;
      } else {
        months.push({ key, label, count: 1 });
      }
    }
    return { days, months };
  }, [windowRange.from, windowRange.total]);

  const gridTemplateColumns = `repeat(${windowRange.total}, ${DAY_CELL_WIDTH}px)`;
  const trackWidth = windowRange.total * DAY_CELL_WIDTH;
  const monthsGridTemplate = dayHeader.months.map((m) => `${m.count * DAY_CELL_WIDTH}px`).join(" ");

  // Día de hoy → marker vertical
  const todayLeft = (() => {
    const now = new Date();
    const diff = daysBetween(windowRange.from, now);
    if (diff < 0 || diff > windowRange.total) return null;
    return diff * DAY_CELL_WIDTH;
  })();

  function handleNuevoGrupo() {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "GroupsEventsDashboard" }));
  }

  // ─────────────────────────────────────────────────────── Render

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Commercial · Groups & Events</div>
          <h1 className="bo-page-title">Calendario de grupos</h1>
          <p className="bo-page-subtitle">
            Vista Gantt horizontal de todos los grupos activos en la ventana seleccionada
            (próximos 30 / 90 / 180 días). Cada barra cubre arrival → departure y el color
            refleja el estado del bloque. La línea vertical roja punteada marca el cut-off
            date contractual. Click sobre una barra para abrir el detalle 360º del grupo.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="primary" onClick={handleNuevoGrupo}>
            + Nuevo grupo
          </button>
          <button type="button" className="ghost" onClick={() => state.refresh()}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <CocoaScreenInstructionsCard
        title="Gestion de grupos y eventos"
        description={GROUPS_INSTRUCTIONS.whatIsThis}
        steps={[...GROUPS_INSTRUCTIONS.howToUse]}
        tip={GROUPS_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="groups"
      />

      <section className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <div>
            <h3 style={{ color: "var(--ink)", margin: 0 }}>Controles</h3>
            <p className="bo-muted" style={{ margin: "4px 0 0 0", fontSize: 12, textTransform: "none" }}>
              Ajusta la ventana de tiempo y filtra por tipo y estado de grupo.
            </p>
          </div>
          <span className="bo-chip">{filteredGroups.length} grupos visibles</span>
        </div>

        <div style={styles.controlsRow}>
          <div style={styles.controlGroup} role="group" aria-label="Ventana de tiempo">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                className={windowDays === opt.days ? "primary" : "ghost"}
                onClick={() => setWindowDays(opt.days)}
                style={{ padding: "6px 12px", fontSize: 12 }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div style={styles.controlGroup}>
            <label className="bo-muted" style={{ fontSize: 12 }} htmlFor="gc-type">Tipo:</label>
            <select
              id="gc-type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={{ padding: "6px 8px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4 }}
            >
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div style={styles.controlGroup}>
            <label className="bo-muted" style={{ fontSize: 12 }} htmlFor="gc-status">Estado:</label>
            <select
              id="gc-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ padding: "6px 8px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4 }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* KPIs */}
        <div style={styles.kpiGrid}>
          <div style={styles.kpiCard}>
            <span style={styles.kpiLabel}>Grupos en periodo</span>
            <span style={styles.kpiValue}>{kpis.totalGroups}</span>
          </div>
          <div style={styles.kpiCard}>
            <span style={styles.kpiLabel}>Habs bloqueadas</span>
            <span style={styles.kpiValue}>{kpis.totalBlocked}</span>
          </div>
          <div style={styles.kpiCard}>
            <span style={styles.kpiLabel}>Pickup global</span>
            <span style={{
              ...styles.kpiValue,
              color: kpis.pickupPct >= 80 ? "var(--ok, #0d8a5f)" :
                kpis.pickupPct >= 40 ? "var(--warn, #d97706)" :
                "var(--danger, #dc2626)"
            }}>{kpis.pickupPct}%</span>
          </div>
          <div style={styles.kpiCard}>
            <span style={styles.kpiLabel}>Cut-offs &lt; 14 días</span>
            <span style={{
              ...styles.kpiValue,
              color: kpis.upcomingCutoffs > 0 ? "var(--danger, #dc2626)" : "var(--ink)"
            }}>{kpis.upcomingCutoffs}</span>
          </div>
        </div>
      </section>

      {/* Gantt */}
      <section className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <div>
            <h3 style={{ color: "var(--ink)", margin: 0 }}>Gantt de grupos</h3>
            <p className="bo-muted" style={{ margin: "4px 0 0 0", fontSize: 12, textTransform: "none" }}>
              Periodo {formatLong(windowRange.from.toISOString())} → {formatLong(windowRange.to.toISOString())}
              {" · "}{windowRange.total} días.
            </p>
          </div>
        </div>

        {state.loading && !state.data ? (
          <LoadingBlock label="Cargando calendario de grupos…" />
        ) : state.error ? (
          <ErrorState
            title="No se pudo cargar el calendario"
            message={state.error}
            onRetry={() => state.refresh()}
          />
        ) : filteredGroups.length === 0 ? (
          <EmptyState
            title="No hay grupos en el periodo seleccionado"
            message="Ajusta los filtros o la ventana de tiempo, o crea un nuevo grupo."
            actions={
              <button type="button" className="primary" onClick={handleNuevoGrupo}>
                + Nuevo grupo
              </button>
            }
          />
        ) : (
          <>
            <div style={styles.ganttWrap}>
              {/* Header sticky con meses + días */}
              <div style={styles.ganttHeader}>
                {/* fila de meses */}
                <div style={{ display: "flex" }}>
                  <div style={{ ...styles.ganttHeaderName, borderBottom: "1px solid var(--border, rgba(0,0,0,0.05))" }}>
                    Grupo
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: monthsGridTemplate, width: trackWidth }}>
                    {dayHeader.months.map((m) => (
                      <div key={m.key} style={styles.ganttHeaderMonthCell}>{m.label}</div>
                    ))}
                  </div>
                </div>
                {/* fila de días */}
                <div style={{ display: "flex" }}>
                  <div style={{ ...styles.ganttHeaderName, fontSize: 10 }}>
                    Arrival → Departure
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns, width: trackWidth }}>
                    {dayHeader.days.map((d) => {
                      const day = d.date.getUTCDate();
                      const isMonthStart = day === 1;
                      const isWeekend = d.date.getUTCDay() === 0 || d.date.getUTCDay() === 6;
                      return (
                        <div
                          key={d.iso}
                          style={{
                            ...styles.ganttHeaderDayCell,
                            background: isWeekend ? "rgba(0,0,0,0.025)" : undefined,
                            fontWeight: isMonthStart ? 700 : undefined,
                            color: isMonthStart ? "var(--ink)" : styles.ganttHeaderDayCell.color
                          }}
                        >
                          {day}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Filas de grupos */}
              <div>
                {filteredGroups.map((g) => {
                  const arrival = new Date(g.arrivalDate);
                  const departure = new Date(g.departureDate);
                  const offsetDays = daysBetween(windowRange.from, arrival);
                  const lengthDays = Math.max(1, daysBetween(arrival, departure) + 1);
                  // clamp dentro de la ventana visible
                  const startDay = Math.max(0, offsetDays);
                  const endDay = Math.min(windowRange.total, offsetDays + lengthDays);
                  const visibleLength = Math.max(0, endDay - startDay);
                  const left = startDay * DAY_CELL_WIDTH;
                  const width = Math.max(0, visibleLength * DAY_CELL_WIDTH - 2);

                  const tone = statusTone(g.status);
                  const isHover = hoverGroupId === g.groupBookingId;

                  // cut-off marker (sólo si está dentro del periodo del grupo Y dentro de la ventana)
                  let cutOffLeft: number | null = null;
                  if (g.cutOffDate) {
                    const co = new Date(g.cutOffDate);
                    const coOffset = daysBetween(windowRange.from, co);
                    if (coOffset >= startDay && coOffset <= endDay && coOffset >= 0 && coOffset <= windowRange.total) {
                      cutOffLeft = coOffset * DAY_CELL_WIDTH;
                    }
                  }

                  const tooltipText = [
                    g.name,
                    `Fechas: ${formatShort(g.arrivalDate)} → ${formatShort(g.departureDate)}`,
                    `Bloqueado: ${g.totalBlocked} · Picked up: ${g.totalPickedUp}`,
                    `Pickup: ${g.pickupPct}%`,
                    g.daysToCutOff != null ? `Días al cut-off: ${g.daysToCutOff}` : "Sin cut-off"
                  ].join("\n");

                  return (
                    <div key={g.groupBookingId} style={styles.ganttRow}>
                      <div style={styles.ganttRowName}>
                        <strong style={{ fontSize: 12, color: "var(--ink)" }}>{g.name}</strong>
                        <span style={{ fontSize: 10, color: "var(--muted, #6b7280)", fontFamily: "var(--font-mono, monospace)" }}>
                          {g.code} · {g.groupType}
                        </span>
                      </div>
                      <div style={{ ...styles.ganttRowTrack, width: trackWidth }}>
                        {/* today marker dentro del track */}
                        {todayLeft != null ? (
                          <div style={{ ...styles.todayMarker, left: todayLeft }} aria-hidden />
                        ) : null}

                        {/* Barra clickable */}
                        {visibleLength > 0 ? (
                          <button
                            type="button"
                            title={tooltipText}
                            onClick={() => setSelectedGroupId(g.groupBookingId)}
                            onMouseEnter={() => setHoverGroupId(g.groupBookingId)}
                            onMouseLeave={() => setHoverGroupId(null)}
                            style={{
                              ...styles.ganttBar,
                              left,
                              width,
                              background: tone.bg,
                              color: tone.ink,
                              transform: isHover ? "translateY(-1px)" : undefined,
                              boxShadow: isHover ? "0 2px 6px rgba(0,0,0,0.18)" : undefined
                            }}
                            aria-label={`${g.name} · ${tone.label} · ${formatShort(g.arrivalDate)} → ${formatShort(g.departureDate)}`}
                          >
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                              {g.name} · {g.totalBlocked}h · {g.pickupPct}%
                            </span>
                          </button>
                        ) : null}

                        {/* Cut-off marker */}
                        {cutOffLeft != null ? (
                          <div
                            style={{ ...styles.cutOffMarker, left: cutOffLeft }}
                            title={g.cutOffDate ? `Cut-off: ${formatShort(g.cutOffDate)}` : undefined}
                            aria-hidden
                          />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Leyenda */}
            <div style={styles.legendRow}>
              <span className="bo-muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Estados:
              </span>
              {Object.entries(STATUS_COLOR).map(([key, tone]) => (
                <span key={key} style={{ display: "inline-flex", alignItems: "center" }}>
                  <span style={{ ...styles.legendDot, background: tone.bg }} />
                  <span className="bo-muted">{tone.label}</span>
                </span>
              ))}
              <span style={{ display: "inline-flex", alignItems: "center", marginLeft: 12 }}>
                <span style={{ ...styles.legendDot, background: "transparent", borderLeft: "2px dashed #dc2626", borderRadius: 0, width: 6 }} />
                <span className="bo-muted">Cut-off date</span>
              </span>
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                <span style={{ ...styles.legendDot, background: "rgba(13, 138, 95, 0.55)", borderRadius: 0, width: 2 }} />
                <span className="bo-muted">Hoy</span>
              </span>
            </div>
          </>
        )}
      </section>

      {selectedGroupId ? (
        <GroupDetailDialog
          groupBookingId={selectedGroupId}
          onClose={() => setSelectedGroupId(null)}
        />
      ) : null}
    </>
  );
}

export default GroupsCalendarScreen;
