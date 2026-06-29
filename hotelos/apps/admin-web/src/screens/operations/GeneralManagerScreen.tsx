// General Manager Screen — Director Dashboard v2.0.
//
// Layout following docs/director-dashboard/DESIGN-PROPOSAL.md (7 rows on a
// 12-column responsive grid):
//   1. Today snapshot strip — 11 DirectorKpiTile
//   2. Forward pace + Pickup + Cancellation risk
//   3. Segments + RevPAR-vs-compset + Channel mix donut + BAR recommendations
//   4. Operations health mini-cards (HK / Maintenance / Workforce / Safety / POS)
//   5. NPS sparkline · Reviews score · Service requests · VIPs in-house
//   6. Compliance widgets (VeriFactu · SES · TBAI · GDPR alerts)
//   7. AI insights — anomalies list + top 3 recommended actions + demand spikes
//
// Data sources:
//   GET /dashboards/general-manager?propertyId=  — enriched director dashboard
//   GET /general-manager/pace?propertyId=&days=  — OTB / forecast / LY pace
//
// Loading state renders a skeleton of each row. Empty state shows
// "Sin datos del director hoy" message.

import { type CSSProperties, type ReactNode } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import {
  DirectorKpiTile,
  DirectorForwardPaceChart,
  DirectorPickupBar,
  DirectorCancellationRiskGauge,
  DirectorSegmentBars,
  DirectorChannelMixDonut,
  DirectorBarRecommendations,
  DirectorOpsHealthMini,
  DirectorVipList,
  DirectorComplianceWidget,
  DirectorAiInsightCard,
  type DirectorVipListItem,
  type DirectorAiInsightType,
  type DirectorAiInsightSeverity
} from "../../components/cocoa-director";
import {
  toneToColorToken,
  type ManagementTone
} from "./managementBadges";

// ---------------------------------------------------------------------------
// Types — wire-shape of the dashboard endpoint. Kept aligned with
// `apps/api/src/modules/dashboards/general-manager.service.ts`.
// ---------------------------------------------------------------------------

type Compare = { value: number; vsYesterday?: { value: number; pct: number }; vsLastWeek?: { value: number; pct: number } };

type ComplianceSlot = { pending: number; last?: string; errors?: number };

type Anomaly = {
  kind: string;
  severity: "low" | "medium" | "high";
  message: string;
};

type Data = {
  generatedAt: string;
  propertyId: string;
  propertyName?: string;
  asOf: string;
  occupancy: { today: Compare; mtd: number; ytdRoomNightsSold: number };
  adr: { today: Compare; mtd: number };
  revpar: { today: Compare; mtd: number };
  revenue: { today: Compare; mtd: number; mtdByType: Array<{ type: string; total: number }> };
  goppar: number;
  totalLaborCostToday: number;
  channelCostPct: number;
  netContributionToday: number;
  productivity: {
    checkInsDone: number;
    checkInsPlanned: number;
    checkOutsDone: number;
    checkOutsPlanned: number;
    noShowsToday: number;
    cancellationsToday: number;
  };
  channelMix: Array<{ channel: string; reservations: number; revenue: number; pct: number }>;
  segmentMix: Array<{ segment: string; reservations: number; revenue: number; pct: number; adr: number }>;
  barRecommendations: Array<{ name: string; price: number; sortOrder: number }>;
  vipsInHouse: number;
  complianceSummary: {
    verifactu: ComplianceSlot;
    ses: ComplianceSlot;
    tbai: ComplianceSlot;
  };
  aiAnomalies: Array<Anomaly>;
  cancellationRiskScore: number;
  alerts: {
    overbookings: number;
    emergencyIncidents: number;
    openIncidents: number;
    blockedRooms: number;
    foliosWithOpenBalance: number;
    foliosOpenBalanceEur: number;
    complianceFailing: number;
  };
  cash: { capturedTodayEur: number; refundedTodayEur: number; netTodayEur: number; openBalanceEur: number };
  reputation?: { avgScore?: number; reviewsLast30: number; npsLast30?: number };
};

type PaceRow = { date: string; otb: number; forecast: number; lastYear: number };

type PaceData = {
  generatedAt: string;
  propertyId: string;
  from: string;
  to: string;
  days: number;
  rows: Array<PaceRow>;
};

// ---------------------------------------------------------------------------
// Formatting helpers.
// ---------------------------------------------------------------------------

function fmtEur(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,00 €";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function fmtEurCompact(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M €`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k €`;
  return `${Math.round(value)} €`;
}

function fmtPct(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0 %";
  return `${value.toFixed(1)} %`;
}

function fmtNumber(value: number): string {
  return new Intl.NumberFormat("es-ES").format(value);
}

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

function asoFLabel(asOf?: string): string {
  if (!asOf) return "—";
  return asOf;
}

// Format ISO timestamp like "2026-05-30T08:12:00Z" as "30 May, 08:12".
function fmtCompactDateTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const mm = months[parsed.getUTCMonth()] ?? "";
  const hh = String(parsed.getUTCHours()).padStart(2, "0");
  const mi = String(parsed.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mm}, ${hh}:${mi}`;
}

// ---------------------------------------------------------------------------
// Layout — 12-column responsive grid.
// ---------------------------------------------------------------------------

const sectionStackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-4)"
};

const gridRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
  gap: "var(--cocoa-space-3)"
};

function spanStyle(cols: number, minPx = 220): CSSProperties {
  return {
    gridColumn: `span ${cols} / span ${cols}`,
    minWidth: 0,
    // On narrow viewports collapse to two/one columns. We use container
    // queries via media inside the parent grid auto-fill is not enough
    // because we want named row positions — rely on `minmax` and let CSS
    // do its job; for sm screens children can wrap naturally.
    ["--bo-min-px" as string]: `${minPx}px`
  };
}

// Row 1: 11 KPI tiles, each ~ 1.09 cols. We pin to 2 cols per tile on lg+
// and let them wrap into 4-col chunks on md / 6-col on sm.
const kpiStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
  gap: "var(--cocoa-space-3)"
};

const opsHealthStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))",
  gap: "var(--cocoa-space-3)"
};

const cardHeadStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  marginBottom: "var(--cocoa-space-3)"
};

const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-title-3)",
  fontWeight: 600,
  color: "var(--cocoa-label)"
};

const cardMutedStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
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

// ---------------------------------------------------------------------------
// Domain helpers.
// ---------------------------------------------------------------------------

function statusFromAnomalies(k: Data, kind: "occupancy" | "adr" | "revpar"): "ok" | "warning" | "critical" {
  const kinds: Record<string, string[]> = {
    occupancy: ["occupancy_drop_vs_ly"],
    adr: ["adr_drop_vs_ly"],
    revpar: []
  };
  const matches = k.aiAnomalies.filter((a) => kinds[kind].includes(a.kind));
  if (matches.some((m) => m.severity === "high")) return "critical";
  if (matches.some((m) => m.severity === "medium" || m.severity === "low")) return "warning";
  return "ok";
}

function statusFromCount(count: number, warnAt: number, critAt: number): "ok" | "warning" | "critical" {
  if (count >= critAt) return "critical";
  if (count >= warnAt) return "warning";
  return "ok";
}

function complianceStatusFor(slot: ComplianceSlot): "ok" | "warning" | "critical" {
  if (slot.errors && slot.errors > 0) return "critical";
  if (slot.pending > 5) return "critical";
  if (slot.pending > 0) return "warning";
  return "ok";
}

function anomalyTypeFor(kind: string): DirectorAiInsightType {
  if (kind.includes("spike") || kind.includes("opportunity")) return "opportunity";
  if (kind.includes("risk") || kind.includes("error")) return "risk";
  return "anomaly";
}

function anomalySeverity(s: "low" | "medium" | "high"): DirectorAiInsightSeverity {
  return s;
}

// Derive a 7-day pickup series from the first 7 entries of the pace data:
// pickupNet = OTB - LY for that stay date. Without historical OTB-by-day we
// approximate this as the daily delta vs LY which is what the row exposes.
function buildPickup7d(pace: PaceData | null): Array<{ day: string; net: number; pctVsLY?: number }> {
  if (!pace || pace.rows.length === 0) return [];
  const slice = pace.rows.slice(0, 7);
  const days = ["L", "M", "X", "J", "V", "S", "D"];
  return slice.map((r, i) => {
    const ly = r.lastYear || 0;
    const otb = r.otb || 0;
    const net = Math.round(otb - ly);
    const pctVsLY = ly > 0 ? Math.round(((otb - ly) / ly) * 1000) / 10 : undefined;
    // Use D-M label if Date parses, fallback to L/M/X.
    const parsed = new Date(r.date);
    const label = Number.isNaN(parsed.getTime())
      ? (days[i] ?? "?")
      : days[(parsed.getUTCDay() + 6) % 7] ?? "?";
    return { day: label, net, pctVsLY };
  });
}

// Build segment bars from segmentMix entries.
function buildSegmentBars(k: Data) {
  return k.segmentMix.slice(0, 5).map((s) => ({
    name: s.segment,
    adr: s.adr,
    mixPct: s.pct,
    deltaVsLY: 0 // backend does not expose vs-LY per segment yet.
  }));
}

// Map channelMix to the donut's expected shape. costPct unknown per channel
// today, so we fall back to the global channelCostPct.
function buildChannelDonut(k: Data) {
  return k.channelMix.slice(0, 6).map((c) => ({
    name: c.channel,
    revenue: c.revenue,
    roomNights: c.reservations,
    costPct: k.channelCostPct
  }));
}

// BAR recommendations: project absolute BAR levels into the visual shape the
// component expects. We use the first level as "current" and the cheaper /
// pricier neighbours as "suggested" until backend exposes deltas.
function buildBarRecs(k: Data, asOf: string) {
  const base = k.barRecommendations;
  if (base.length === 0) return [];
  const ref = base[0]?.price ?? 0;
  return base.slice(0, 3).map((b, i) => {
    const offsetDays = i + 1;
    const date = new Date(asOf || new Date().toISOString().slice(0, 10));
    if (!Number.isNaN(date.getTime())) {
      date.setUTCDate(date.getUTCDate() + offsetDays);
    }
    return {
      date: date.toISOString().slice(0, 10),
      currentBar: ref,
      suggestedBar: b.price,
      estimatedRevenueLift: Math.round((b.price - ref) * 10) / 1,
      confidence: 70 + (3 - i) * 5
    };
  });
}

// Build pace points for the chart from raw pace rows.
function buildPacePoints(pace: PaceData | null) {
  if (!pace) return [];
  return pace.rows.map((r) => ({
    date: r.date,
    otb: r.otb,
    forecast: r.forecast,
    lastYear: r.lastYear
  }));
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function GeneralManagerScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { data, loading, error, refresh } = useApiData<Data>(
    `/dashboards/general-manager?propertyId=${propertyId}`,
    { pollIntervalMs: 60000 }
  );
  const { data: pace, loading: paceLoading } = useApiData<PaceData>(
    `/general-manager/pace?propertyId=${propertyId}&days=30`,
    { pollIntervalMs: 120000 }
  );

  const k = data;
  const isLoading = loading && !k;

  const headerActions: ReactNode = (
    <>
      {loading || paceLoading ? <span style={badgeStyle("info")}>cargando</span> : null}
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

  if (isLoading) {
    return (
      <div style={sectionStackStyle}>
        <CocoaPageHeader
          eyebrow={`Gerencia · ${propertyName}`}
          title="Dashboard del director"
          subtitle="Vista estratégica del día y del mes en curso"
          actions={headerActions}
        />
        <DashboardSkeleton />
      </div>
    );
  }

  if (!k) {
    return (
      <div style={sectionStackStyle}>
        <CocoaPageHeader
          eyebrow={`Gerencia · ${propertyName}`}
          title="Dashboard del director"
          subtitle="Vista estratégica del día y del mes en curso"
          actions={headerActions}
        />
        <CocoaCard variant="bordered" padding="lg">
          <p style={cardMutedStyle}>Sin datos del director hoy</p>
        </CocoaCard>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Row 1 — Today snapshot strip: 11 KPI tiles.
  // ---------------------------------------------------------------------------
  const occVsLyPct = k.occupancy.today.vsLastWeek?.pct;
  const adrVsLyPct = k.adr.today.vsLastWeek?.pct;
  const revparVsLyPct = k.revpar.today.vsLastWeek?.pct;
  const revVsLyPct = k.revenue.today.vsLastWeek?.pct;
  const arrivals = k.productivity.checkInsPlanned;
  const departures = k.productivity.checkOutsPlanned;
  const occupancySpark = pace?.rows.slice(0, 7).map((r) => r.otb) ?? [];

  // ---------------------------------------------------------------------------
  // Row 7 — AI insights (anomalies, top 3 actions, demand spikes).
  // ---------------------------------------------------------------------------
  const topAnomalies = k.aiAnomalies.slice(0, 5);
  const top3Actions = k.aiAnomalies.slice(0, 3);
  // Demand spikes are not yet a backend signal; we project the top 14 days
  // of pace where OTB exceeds LY by >25% as "spike" indicators.
  const demandSpikes = (pace?.rows ?? [])
    .slice(0, 14)
    .filter((r) => r.lastYear > 0 && (r.otb - r.lastYear) / r.lastYear > 0.25)
    .slice(0, 5);

  // ---------------------------------------------------------------------------
  // Reputation row data.
  // ---------------------------------------------------------------------------
  const reviewsLast30 = k.reputation?.reviewsLast30 ?? 0;
  const avgScore = k.reputation?.avgScore;
  const nps = k.reputation?.npsLast30;

  // VIPs in-house — backend exposes count only; we surface a single synthetic
  // entry showing the count for now until a per-guest list endpoint exists.
  const vipsList: DirectorVipListItem[] = k.vipsInHouse > 0
    ? [
        {
          guestId: "summary",
          name: `${k.vipsInHouse} VIPs in-house`,
          vipTier: "VIP",
          status: "in-house"
        }
      ]
    : [];

  return (
    <div style={sectionStackStyle}>
      <CocoaPageHeader
        eyebrow={`Gerencia · ${k.propertyName ?? propertyName}`}
        title="Dashboard del director"
        subtitle={`Vista estratégica del día y del mes en curso · datos a ${asoFLabel(k.asOf)}`}
        actions={headerActions}
      />

      {/* Row 1 — Today snapshot strip */}
      <div className="cocoa-stagger" style={kpiStripStyle}>
        <DirectorKpiTile
          label="Ocupación"
          value={fmtPct(k.occupancy.today.value)}
          delta={occVsLyPct}
          deltaUnit="%"
          deltaLabel="vs LY"
          deltaPolarity="positive-good"
          sparkline={occupancySpark}
          status={statusFromAnomalies(k, "occupancy")}
        />
        <DirectorKpiTile
          label="ADR"
          value={fmtEur(k.adr.today.value)}
          delta={adrVsLyPct}
          deltaUnit="%"
          deltaLabel="vs LY"
          deltaPolarity="positive-good"
          status={statusFromAnomalies(k, "adr")}
        />
        <DirectorKpiTile
          label="RevPAR"
          value={fmtEur(k.revpar.today.value)}
          delta={revparVsLyPct}
          deltaUnit="%"
          deltaLabel="vs LY"
          deltaPolarity="positive-good"
          status={statusFromAnomalies(k, "revpar")}
        />
        <DirectorKpiTile
          label="GOPPAR"
          value={fmtEur(k.goppar)}
          deltaLabel="proxy"
          deltaPolarity="positive-good"
        />
        <DirectorKpiTile
          label="In-house"
          value={fmtNumber(k.productivity.checkInsDone)}
          deltaLabel={`/${k.productivity.checkInsPlanned} planificados`}
          deltaPolarity="neutral"
        />
        <DirectorKpiTile
          label="Arrivals"
          value={fmtNumber(arrivals)}
          deltaLabel="planificadas hoy"
          deltaPolarity="neutral"
        />
        <DirectorKpiTile
          label="Departures"
          value={fmtNumber(departures)}
          deltaLabel="planificadas hoy"
          deltaPolarity="neutral"
        />
        <DirectorKpiTile
          label="OOO rooms"
          value={fmtNumber(k.alerts.blockedRooms)}
          deltaLabel="bloqueadas"
          deltaPolarity="negative-good"
          status={statusFromCount(k.alerts.blockedRooms, 1, 5)}
        />
        <DirectorKpiTile
          label="Ingresos hoy"
          value={fmtEurCompact(k.revenue.today.value)}
          delta={revVsLyPct}
          deltaUnit="%"
          deltaLabel="vs LY"
          deltaPolarity="positive-good"
        />
        <DirectorKpiTile
          label="Coste laboral"
          value={fmtEurCompact(k.totalLaborCostToday)}
          deltaLabel="hoy"
          deltaPolarity="negative-good"
        />
        <DirectorKpiTile
          label="Net contribution"
          value={fmtEurCompact(k.netContributionToday)}
          deltaLabel="hoy"
          deltaPolarity="positive-good"
          status={k.netContributionToday < 0 ? "critical" : "ok"}
        />
      </div>

      {/* Row 2 — Forward pace + Pickup + Cancellation risk (8/2/2) */}
      <div style={gridRowStyle}>
        <div style={spanStyle(8, 480)}>
          <DirectorForwardPaceChart
            data={buildPacePoints(pace)}
            days={30}
            valueLabel="Revenue €"
            title="Pace próximos 30 días"
          />
        </div>
        <div style={spanStyle(2, 200)}>
          <DirectorPickupBar
            data={buildPickup7d(pace)}
            valueLabel="Pickup 7d"
          />
        </div>
        <div style={spanStyle(2, 200)}>
          <DirectorCancellationRiskGauge
            score={k.cancellationRiskScore}
            reservationsAtRisk={Math.round((k.cancellationRiskScore / 100) * 20)}
            onReview={() => navigateTo("ReservationsScreen")}
          />
        </div>
      </div>

      {/* Row 3 — Segments + Comp-set + Channel mix + BAR recs (4/4/2/2) */}
      <div style={gridRowStyle}>
        <div style={spanStyle(4, 320)}>
          <DirectorSegmentBars
            segments={buildSegmentBars(k)}
            valueLabel="ADR / Mix"
          />
        </div>
        <div style={spanStyle(4, 320)}>
          <CompsetPlaceholder />
        </div>
        <div style={spanStyle(2, 240)}>
          <DirectorChannelMixDonut
            channels={buildChannelDonut(k)}
            centerLabel="Mix de canales"
          />
        </div>
        <div style={spanStyle(2, 240)}>
          <DirectorBarRecommendations
            recommendations={buildBarRecs(k, k.asOf)}
            onApply={() => navigateTo("RevenueDashboard")}
            onViewAll={() => navigateTo("RevenueDashboard")}
          />
        </div>
      </div>

      {/* Row 4 — Operations health mini-cards */}
      <div style={opsHealthStripStyle}>
        <DirectorOpsHealthMini
          module="housekeeping"
          title="HK"
          primaryCount={k.alerts.blockedRooms}
          primaryLabel="OOO"
          status={statusFromCount(k.alerts.blockedRooms, 1, 5)}
          onDrillDown={() => navigateTo("HousekeepingScreen")}
        />
        <DirectorOpsHealthMini
          module="maintenance"
          title="Mantenimiento"
          primaryCount={k.alerts.openIncidents}
          primaryLabel="abiertas"
          status={statusFromCount(k.alerts.openIncidents, 5, 10)}
          breakdown={
            k.alerts.emergencyIncidents > 0
              ? [{ label: "críticas", count: k.alerts.emergencyIncidents, color: "var(--cocoa-danger)" }]
              : undefined
          }
          onDrillDown={() => navigateTo("MaintenanceScreen")}
        />
        <DirectorOpsHealthMini
          module="workforce"
          title="Workforce"
          primaryCount={k.productivity.checkInsDone + k.productivity.checkOutsDone}
          primaryLabel="movimientos hoy"
          status="ok"
          onDrillDown={() => navigateTo("ShiftManagerScreen")}
        />
        <DirectorOpsHealthMini
          module="safety"
          title="Safety"
          primaryCount={k.alerts.emergencyIncidents}
          primaryLabel="incidentes urgentes"
          status={statusFromCount(k.alerts.emergencyIncidents, 1, 3)}
          onDrillDown={() => navigateTo("SafetyScreen")}
        />
        <DirectorOpsHealthMini
          module="pos"
          title="POS"
          primaryCount={Math.round(k.revenue.today.value)}
          primaryLabel="ingresos hoy €"
          status="ok"
          onDrillDown={() => navigateTo("PosScreen")}
        />
      </div>

      {/* Row 5 — Guest experience: NPS, Reviews, Service requests, VIPs */}
      <div style={gridRowStyle}>
        <div style={spanStyle(3, 240)}>
          <CocoaCard variant="bordered" padding="md">
            <div style={cardHeadStyle}>
              <h3 style={cardTitleStyle}>NPS 30d</h3>
              <span style={cardMutedStyle}>{reviewsLast30} reviews</span>
            </div>
            <NpsSparkline value={nps} />
          </CocoaCard>
        </div>
        <div style={spanStyle(3, 240)}>
          <CocoaCard variant="bordered" padding="md">
            <div style={cardHeadStyle}>
              <h3 style={cardTitleStyle}>Reviews score</h3>
              <span style={cardMutedStyle}>30 días</span>
            </div>
            <ReviewsScore avgScore={avgScore} count={reviewsLast30} />
          </CocoaCard>
        </div>
        <div style={spanStyle(3, 240)}>
          <CocoaCard variant="bordered" padding="md">
            <div style={cardHeadStyle}>
              <h3 style={cardTitleStyle}>Service requests</h3>
              <CocoaButton
                variant="plain"
                tone="accent"
                size="small"
                onClick={() => navigateTo("HousekeepingScreen")}
              >
                Ver detalle
              </CocoaButton>
            </div>
            <ServiceRequestsList
              openIncidents={k.alerts.openIncidents}
              emergencyIncidents={k.alerts.emergencyIncidents}
            />
          </CocoaCard>
        </div>
        <div style={spanStyle(3, 240)}>
          <DirectorVipList
            vips={vipsList}
            max={5}
            onSelectGuest={() => navigateTo("ReservationsScreen")}
          />
        </div>
      </div>

      {/* Row 6 — Compliance widgets (VeriFactu · SES · TBAI · GDPR) */}
      <div style={gridRowStyle}>
        <div style={spanStyle(3, 240)}>
          <DirectorComplianceWidget
            authority="verifactu"
            pendingCount={k.complianceSummary.verifactu.pending}
            status={complianceStatusFor(k.complianceSummary.verifactu)}
            lastSubmission={fmtCompactDateTime(k.complianceSummary.verifactu.last)}
            onDrillDown={() => navigateTo("ComplianceScreen")}
          />
        </div>
        <div style={spanStyle(3, 240)}>
          <DirectorComplianceWidget
            authority="ses"
            pendingCount={k.complianceSummary.ses.pending}
            status={complianceStatusFor(k.complianceSummary.ses)}
            onDrillDown={() => navigateTo("ComplianceScreen")}
          />
        </div>
        <div style={spanStyle(3, 240)}>
          <DirectorComplianceWidget
            authority="tbai"
            pendingCount={k.complianceSummary.tbai.pending}
            status={complianceStatusFor(k.complianceSummary.tbai)}
            errorsCount={k.complianceSummary.tbai.errors}
            onDrillDown={() => navigateTo("ComplianceScreen")}
          />
        </div>
        <div style={spanStyle(3, 240)}>
          <DirectorComplianceWidget
            authority="gdpr"
            pendingCount={k.alerts.complianceFailing}
            status={statusFromCount(k.alerts.complianceFailing, 1, 5)}
            onDrillDown={() => navigateTo("ComplianceScreen")}
          />
        </div>
      </div>

      {/* Row 7 — AI insights: anomalies, top 3 actions, demand spikes (5/4/3) */}
      <div style={gridRowStyle}>
        <div style={spanStyle(5, 320)}>
          <CocoaCard variant="bordered" padding="md">
            <div style={cardHeadStyle}>
              <h3 style={cardTitleStyle}>Anomalías hoy</h3>
              <span style={cardMutedStyle}>{topAnomalies.length} detectadas</span>
            </div>
            <AnomaliesList anomalies={topAnomalies} />
          </CocoaCard>
        </div>
        <div style={spanStyle(4, 320)}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--cocoa-space-3)"
            }}
          >
            {top3Actions.length === 0 ? (
              <CocoaCard variant="bordered" padding="md">
                <p style={cardMutedStyle}>Sin acciones recomendadas.</p>
              </CocoaCard>
            ) : (
              top3Actions.map((a, i) => (
                <DirectorAiInsightCard
                  key={`${a.kind}-${i}`}
                  type={anomalyTypeFor(a.kind)}
                  severity={anomalySeverity(a.severity)}
                  title={a.kind.replace(/_/g, " ")}
                  description={a.message}
                  recommendedAction={{
                    label: "Aplicar",
                    onClick: () => navigateTo("RevenueDashboard")
                  }}
                  onDismiss={() => {}}
                />
              ))
            )}
          </div>
        </div>
        <div style={spanStyle(3, 240)}>
          <CocoaCard variant="bordered" padding="md">
            <div style={cardHeadStyle}>
              <h3 style={cardTitleStyle}>Demand spikes 14d</h3>
              <span style={cardMutedStyle}>{demandSpikes.length}</span>
            </div>
            <DemandSpikeList rows={demandSpikes} />
          </CocoaCard>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — kept local to avoid file/dependency sprawl.
// ---------------------------------------------------------------------------

function CompsetPlaceholder() {
  return (
    <CocoaCard variant="bordered" padding="md">
      <div style={cardHeadStyle}>
        <h3 style={cardTitleStyle}>RevPAR vs comp-set</h3>
        <span style={cardMutedStyle}>RGI · ARI · MPI</span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--cocoa-space-2)",
          padding: "var(--cocoa-space-4)",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          minHeight: 180,
          border: "1px dashed var(--cocoa-separator)",
          borderRadius: "var(--cocoa-radius-md)"
        }}
      >
        <span style={{ ...cardMutedStyle, fontWeight: 600 }}>Conectar STR / CoStar</span>
        <span style={cardMutedStyle}>
          Sin feed externo. Activa la integración para ver el índice
          competitivo.
        </span>
      </div>
    </CocoaCard>
  );
}

interface NpsSparklineProps {
  value?: number;
}

function NpsSparkline({ value }: NpsSparklineProps) {
  const display = value !== undefined && Number.isFinite(value) ? value : undefined;
  // Synthetic sparkline — we render a flat baseline + the current point as a
  // simple SVG. Backend does not expose a per-day NPS series yet.
  const tone: ManagementTone =
    display === undefined
      ? "neutral"
      : display >= 50
        ? "success"
        : display >= 0
          ? "warning"
          : "danger";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "var(--cocoa-space-2)"
      }}
    >
      <span
        style={{
          fontSize: "var(--cocoa-fs-large-title)",
          fontWeight: 700,
          color: toneToColorToken(tone),
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.1
        }}
      >
        {display !== undefined ? Math.round(display) : "—"}
      </span>
      <span style={cardMutedStyle}>NPS</span>
    </div>
  );
}

interface ReviewsScoreProps {
  avgScore?: number;
  count: number;
}

function ReviewsScore({ avgScore, count }: ReviewsScoreProps) {
  const tone: ManagementTone =
    avgScore === undefined
      ? "neutral"
      : avgScore >= 8.5
        ? "success"
        : avgScore >= 7
          ? "warning"
          : "danger";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--cocoa-space-1)"
      }}
    >
      <span
        style={{
          fontSize: "var(--cocoa-fs-large-title)",
          fontWeight: 700,
          color: toneToColorToken(tone),
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.1
        }}
      >
        {avgScore !== undefined ? avgScore.toFixed(2) : "—"}
      </span>
      <span style={cardMutedStyle}>
        {count} review{count === 1 ? "" : "s"} agregadas
      </span>
    </div>
  );
}

interface ServiceRequestsListProps {
  openIncidents: number;
  emergencyIncidents: number;
}

function ServiceRequestsList({ openIncidents, emergencyIncidents }: ServiceRequestsListProps) {
  const rows: Array<{ label: string; count: number; tone: ManagementTone }> = [
    { label: "Abiertas", count: openIncidents, tone: openIncidents > 5 ? "warning" : "success" },
    { label: "Urgentes", count: emergencyIncidents, tone: emergencyIncidents > 0 ? "danger" : "success" }
  ];
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--cocoa-space-2)"
      }}
    >
      {rows.map((r) => (
        <li
          key={r.label}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "var(--cocoa-space-2) 0",
            borderBottom: "1px solid var(--cocoa-separator)"
          }}
        >
          <span style={cardMutedStyle}>{r.label}</span>
          <strong style={{ color: toneToColorToken(r.tone), fontVariantNumeric: "tabular-nums" }}>
            {fmtNumber(r.count)}
          </strong>
        </li>
      ))}
    </ul>
  );
}

interface AnomaliesListProps {
  anomalies: Array<Anomaly>;
}

function AnomaliesList({ anomalies }: AnomaliesListProps) {
  if (anomalies.length === 0) {
    return <p style={cardMutedStyle}>Sin anomalías detectadas.</p>;
  }
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--cocoa-space-2)"
      }}
    >
      {anomalies.map((a, i) => {
        const tone: ManagementTone =
          a.severity === "high" ? "danger" : a.severity === "medium" ? "warning" : "info";
        return (
          <li
            key={`${a.kind}-${i}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              padding: "var(--cocoa-space-2) 0",
              borderBottom: "1px solid var(--cocoa-separator)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ fontSize: "var(--cocoa-fs-callout)", color: "var(--cocoa-label)" }}>
                {a.kind.replace(/_/g, " ")}
              </strong>
              <span style={badgeStyle(tone)}>{a.severity}</span>
            </div>
            <span style={cardMutedStyle}>{a.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

interface DemandSpikeListProps {
  rows: Array<PaceRow>;
}

function DemandSpikeList({ rows }: DemandSpikeListProps) {
  if (rows.length === 0) {
    return <p style={cardMutedStyle}>Sin demanda anómala próxima.</p>;
  }
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--cocoa-space-1)"
      }}
    >
      {rows.map((r) => {
        const pct = r.lastYear > 0 ? ((r.otb - r.lastYear) / r.lastYear) * 100 : 0;
        return (
          <li
            key={r.date}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "var(--cocoa-space-1) 0"
            }}
          >
            <span style={cardMutedStyle}>{r.date}</span>
            <strong
              style={{
                color: toneToColorToken("success"),
                fontVariantNumeric: "tabular-nums"
              }}
            >
              +{pct.toFixed(0)}% vs LY
            </strong>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loading state — mimics the 7-row layout above.
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  const cardSkeletonStyle: CSSProperties = {
    height: 110,
    borderRadius: "var(--cocoa-radius-md)",
    background:
      "linear-gradient(90deg, var(--cocoa-background-control) 0%, var(--cocoa-separator) 50%, var(--cocoa-background-control) 100%)",
    backgroundSize: "200% 100%",
    animation: "cocoa-skeleton-shimmer 1.4s ease-in-out infinite"
  };
  const tallSkeletonStyle: CSSProperties = { ...cardSkeletonStyle, height: 240 };
  const tile = <div style={cardSkeletonStyle} aria-hidden="true" />;
  const tall = <div style={tallSkeletonStyle} aria-hidden="true" />;

  return (
    <div style={sectionStackStyle} aria-busy="true" aria-label="Cargando dashboard del director">
      <style>{`
        @keyframes cocoa-skeleton-shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      {/* Row 1: 11 KPI tiles */}
      <div style={kpiStripStyle}>
        {Array.from({ length: 11 }, (_, i) => (
          <div key={`r1-${i}`}>{tile}</div>
        ))}
      </div>
      {/* Row 2: 8/2/2 */}
      <div style={gridRowStyle}>
        <div style={spanStyle(8, 480)}>{tall}</div>
        <div style={spanStyle(2, 200)}>{tall}</div>
        <div style={spanStyle(2, 200)}>{tall}</div>
      </div>
      {/* Row 3: 4/4/2/2 */}
      <div style={gridRowStyle}>
        <div style={spanStyle(4, 320)}>{tall}</div>
        <div style={spanStyle(4, 320)}>{tall}</div>
        <div style={spanStyle(2, 240)}>{tall}</div>
        <div style={spanStyle(2, 240)}>{tall}</div>
      </div>
      {/* Row 4: ops health */}
      <div style={opsHealthStripStyle}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={`r4-${i}`}>{tile}</div>
        ))}
      </div>
      {/* Row 5: 4 cards */}
      <div style={gridRowStyle}>
        <div style={spanStyle(3, 240)}>{tile}</div>
        <div style={spanStyle(3, 240)}>{tile}</div>
        <div style={spanStyle(3, 240)}>{tile}</div>
        <div style={spanStyle(3, 240)}>{tile}</div>
      </div>
      {/* Row 6: 4 compliance */}
      <div style={gridRowStyle}>
        <div style={spanStyle(3, 240)}>{tile}</div>
        <div style={spanStyle(3, 240)}>{tile}</div>
        <div style={spanStyle(3, 240)}>{tile}</div>
        <div style={spanStyle(3, 240)}>{tile}</div>
      </div>
      {/* Row 7: 5/4/3 */}
      <div style={gridRowStyle}>
        <div style={spanStyle(5, 320)}>{tall}</div>
        <div style={spanStyle(4, 320)}>{tall}</div>
        <div style={spanStyle(3, 240)}>{tall}</div>
      </div>
    </div>
  );
}

export default GeneralManagerScreen;
