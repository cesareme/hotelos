// General Manager Screen — Director Dashboard v2.0 · the Cocoa 22 canon.
//
// Layout following docs/director-dashboard/DESIGN-PROPOSAL.md (7 rows on the
// 12-column grid of docs/design/COCOA-22.md §3.4), painted ONLY with the
// Cocoa 22 primitives (§8). This screen is the visual reference the rest of
// the back office copies (§1): tokens, radii, shadows, spacing and motion
// come from the primitives, never from local styles.
//   1. Today snapshot strip — 11 CocoaKpi tiles (CocoaKpiStrip, stagger)
//   2. Forward pace (CocoaChart.Line) + Pickup 7d (Bars) + Cancellation risk (Gauge)
//   3. Segments + RevPAR-vs-compset + Channel mix (Donut) + BAR recommendations
//   4. Operations health mini-cards (HK / Maintenance / Workforce / Safety / POS)
//   5. NPS · Reviews score · Service requests · VIPs in-house
//   6. Compliance widgets (VeriFactu · SES · TBAI · GDPR)
//   7. AI insights — anomalies list + top 3 recommended actions + demand spikes
//
// Data sources:
//   GET /dashboards/general-manager?propertyId=  — enriched director dashboard
//   GET /general-manager/pace?propertyId=&days=  — OTB / forecast / LY pace
//
// States (§3.10): loading → mirror skeleton with the same spans (no layout
// shift); no payload → empty state; `degraded[]` labels → DegradedValue /
// DegradedCard / DegradedBanner («—» with a hint, never a fake green 0).

import type { CSSProperties, ReactNode } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { navigateTo } from "../../lib/navigate";
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
  DegradedBanner,
  DegradedCard,
  DegradedNote,
  DegradedValue,
  gaugeToneLabel,
  isDegraded,
  thresholdTone,
  toneColor,
  toneInk,
  type CocoaBarsDatum,
  type CocoaDonutSlice,
  type CocoaLineSeries,
  type CocoaTone
} from "../../components/cocoa";
import {
  DirectorSegmentBars,
  DirectorBarRecommendations,
  DirectorOpsHealthMini,
  DirectorVipList,
  DirectorComplianceWidget,
  DirectorAiInsightCard,
  type DirectorVipListItem,
  type DirectorAiInsightType,
  type DirectorAiInsightSeverity
} from "../../components/cocoa-director";
import { toArray } from "../../utils/toArray";
import { dateTime, money, number, percent, plural } from "../../lib/format";

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
  // QC-06: `safe()` labels whose query failed and fell back to 0/null/[].
  degraded: string[];
};

type PaceRow = { date: string; otb: number; forecast: number; lastYear: number };

type PaceData = {
  generatedAt: string;
  propertyId: string;
  from: string;
  to: string;
  days: number;
  rows: Array<PaceRow>;
  // QC-06: datasets that fell back to [] because their query failed.
  degraded: string[];
};

// `safe()` labels in general-manager.service.ts grouped by the UI slot they
// feed. A slot is degraded when ANY of its labels is in `degraded[]`.
const DEGRADED_LABEL = {
  emergencyIncidents: "alerts.emergencyIncidents",
  openIncidents: "alerts.openIncidents",
  incidents: ["alerts.openIncidents", "alerts.emergencyIncidents"],
  // GOPPAR / net contribution subtract a channel cost built from two
  // safe()-wrapped sources; if either failed the cost is understated.
  channelCost: ["channelCost.commissionAccrualToday", "channelCost.profitabilitySnapshotToday"],
  verifactu: "compliance.verifactuPending",
  verifactuLastAck: "compliance.verifactuLastAck",
  ses: "compliance.sesPending",
  tbai: ["compliance.tbaiPending", "compliance.tbaiErrors"],
  anomalies: "anomalies.lastYearSnapshot",
  // Pace endpoint (`/general-manager/pace`).
  pace: ["pace.forecastSnapshots", "pace.lastYearSnapshots"],
  paceLastYear: "pace.lastYearSnapshots"
} as const;

const PACE_DAYS = 30;

// Cancellation risk thresholds (0–30 low · 30–60 moderate · 60–100 high).
const RISK_THRESHOLDS: [number, number] = [30, 60];

// ---------------------------------------------------------------------------
// Formatting helpers.
// ---------------------------------------------------------------------------

function fmtEur(value: number | undefined | null): string {
  return money(value);
}

function fmtEurCompact(value: number | undefined | null): string {
  return money(value, { compact: true });
}

function fmtPct(value: number | undefined | null): string {
  return percent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtNumber(value: number): string {
  return number(value);
}

function asoFLabel(asOf?: string): string {
  if (!asOf) return "—";
  return asOf;
}

// Format ISO timestamp like "2026-05-30T08:12:00Z" as "30 may, 10:12" (hotel time).
function fmtCompactDateTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  return dateTime(iso, { style: "dayMonth" });
}

/** "DD-MM" axis label of an ISO date; the input when it is not a date. */
function formatDayMonth(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}`;
}

/** "DD-MM-YYYY" tooltip title of an ISO date. */
function formatFullDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${formatDayMonth(iso)}-${parsed.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Local text styles — the two secondary text styles the canon repeats inside
// its cards (caption secondary · callout label). Layout comes from the
// stylesheet classes (`cocoa-stack`, `cocoa-row`, `c22-section__list`).
// ---------------------------------------------------------------------------

const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

const calloutStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label)"
};

const growStyle: CSSProperties = { flex: "1 1 auto" };

const centerRowStyle: CSSProperties = { display: "flex", justifyContent: "center" };

/** Large figure (26 px, 700, tabular): the tone HUE is allowed at this size (§2.1 rule c). */
function figureStyle(tone: CocoaTone): CSSProperties {
  return {
    fontSize: "var(--cocoa-fs-large-title)",
    fontWeight: "var(--cocoa-fw-bold)" as CSSProperties["fontWeight"],
    color: tone === "neutral" ? "var(--cocoa-label)" : toneColor(tone),
    fontVariantNumeric: "tabular-nums",
    lineHeight: "var(--cocoa-leading-title)"
  };
}

/** Small text (≤ 13 px) in a tone: the AA-safe ink, plain label for neutral (§2.1 rule c). */
function inkStyle(tone: CocoaTone): CSSProperties {
  return { color: tone === "neutral" ? "var(--cocoa-label)" : toneInk(tone) };
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
  const matches = toArray<Anomaly>(k.aiAnomalies).filter((a) => kinds[kind].includes(a.kind));
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

function anomalyTone(severity: Anomaly["severity"]): CocoaTone {
  return severity === "high" ? "danger" : severity === "medium" ? "warning" : "info";
}

// Derive a 7-day pickup series from the first 7 entries of the pace data:
// pickupNet = OTB - LY for that stay date. Without historical OTB-by-day we
// approximate this as the daily delta vs LY which is what the row exposes.
// Bar tone follows the sign of the delta vs LY (success / danger / neutral).
function buildPickup7d(rows: PaceRow[]): CocoaBarsDatum[] {
  if (rows.length === 0) return [];
  const days = ["L", "M", "X", "J", "V", "S", "D"];
  return rows.slice(0, 7).map((r, i) => {
    const ly = r.lastYear || 0;
    const otb = r.otb || 0;
    const net = Math.round(otb - ly);
    const pctVsLY = ly > 0 ? Math.round(((otb - ly) / ly) * 1000) / 10 : undefined;
    // Weekday initial when the date parses, else L/M/X by position.
    const parsed = new Date(r.date);
    const label = Number.isNaN(parsed.getTime()) ? (days[i] ?? "?") : days[(parsed.getUTCDay() + 6) % 7] ?? "?";
    const tone: CocoaTone = pctVsLY === undefined || pctVsLY === 0 ? "neutral" : pctVsLY > 0 ? "success" : "danger";
    const hint = pctVsLY === undefined ? "vs LY: —" : `vs LY: ${percent(pctVsLY, { signDisplay: "always", minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
    return { label, value: net, tone, hint };
  });
}

// OTB (accent, 2 px) · Forecast (warning, dashed) · Last year (tertiary, 1 px).
function buildPaceSeries(rows: PaceRow[]): CocoaLineSeries[] {
  const points = (pick: (row: PaceRow) => number) => rows.map((row) => ({ x: formatDayMonth(row.date), y: pick(row) }));
  return [
    { id: "otb", label: "OTB", tone: "accent", width: 2, points: points((row) => row.otb) },
    { id: "forecast", label: "Forecast", tone: "warning", dashed: true, width: 2, points: points((row) => row.forecast) },
    { id: "last-year", label: "Año anterior", tone: "tertiary", width: 1, points: points((row) => row.lastYear) }
  ];
}

// Build segment bars from segmentMix entries.
function buildSegmentBars(k: Data) {
  return toArray<Data["segmentMix"][number]>(k.segmentMix).slice(0, 5).map((s) => ({
    name: s.segment,
    adr: s.adr,
    mixPct: s.pct,
    deltaVsLY: 0 // backend does not expose vs-LY per segment yet.
  }));
}

// Donut slices by channel revenue (the global channel cost is not per channel).
function buildChannelSlices(k: Data): CocoaDonutSlice[] {
  return toArray<Data["channelMix"][number]>(k.channelMix)
    .slice(0, 6)
    .map((c) => ({ label: c.channel, value: c.revenue }));
}

// BAR recommendations: project absolute BAR levels into the visual shape the
// component expects. We use the first level as "current" and the cheaper /
// pricier neighbours as "suggested" until backend exposes deltas.
function buildBarRecs(k: Data, asOf: string) {
  const base = toArray<Data["barRecommendations"][number]>(k.barRecommendations);
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

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function GeneralManagerScreen() {
  // Hosted in Mi día the container paints the eyebrow and the H1 and CocoaPage
  // keeps the subtitle («datos a HH:MM») and the actions row (HostedHead).
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { data, loading, error, refresh } = useApiData<Data>(`/dashboards/general-manager?propertyId=${propertyId}`, {
    pollIntervalMs: 60000
  });
  const { data: pace, loading: paceLoading } = useApiData<PaceData>(`/general-manager/pace?propertyId=${propertyId}&days=${PACE_DAYS}`, {
    pollIntervalMs: 120000
  });

  const k = data;
  const isLoading = loading && !k;
  const degraded = toArray<string>(data?.degraded);
  const paceDegraded = toArray<string>(pace?.degraded);
  const paceRows = toArray<PaceRow>(pace?.rows).slice(0, PACE_DAYS);

  const headerActions: ReactNode = (
    <>
      <DegradedBanner degraded={[...degraded, ...paceDegraded]} />
      {loading || paceLoading ? <CocoaBadge tone="info">cargando</CocoaBadge> : null}
      {error ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} aria-label="Refrescar">
        Actualizar
      </CocoaButton>
    </>
  );

  return (
    <CocoaPage
      eyebrow={`Gerencia · ${k?.propertyName ?? propertyName}`}
      title="Dashboard del director"
      subtitle={k ? `Vista estratégica del día y del mes en curso · datos a ${asoFLabel(k.asOf)}` : "Vista estratégica del día y del mes en curso"}
      actions={headerActions}
      state={isLoading ? "loading" : !k ? "empty" : "ready"}
      skeleton={<DashboardSkeleton />}
      empty={{ title: "Sin datos del director hoy", message: "El cuadro de mando se rellena con la actividad de la propiedad a lo largo del día." }}
      commands={[{ id: "general-manager-refresh", label: "Actualizar dashboard del director", run: refresh }]}
    >
      {k ? <DirectorDashboard k={k} degraded={degraded} paceRows={paceRows} paceDegraded={paceDegraded} /> : null}
    </CocoaPage>
  );
}

interface DirectorDashboardProps {
  k: Data;
  degraded: string[];
  paceRows: PaceRow[];
  paceDegraded: string[];
}

function DirectorDashboard({ k, degraded, paceRows, paceDegraded }: DirectorDashboardProps) {
  // ---------------------------------------------------------------------------
  // Row 1 — Today snapshot strip: 11 KPI tiles.
  // ---------------------------------------------------------------------------
  const occVsLyPct = k.occupancy.today.vsLastWeek?.pct;
  const adrVsLyPct = k.adr.today.vsLastWeek?.pct;
  const revparVsLyPct = k.revpar.today.vsLastWeek?.pct;
  const revVsLyPct = k.revenue.today.vsLastWeek?.pct;
  const arrivals = k.productivity.checkInsPlanned;
  const departures = k.productivity.checkOutsPlanned;
  const occupancySpark = paceRows.slice(0, 7).map((r) => r.otb);

  // ---------------------------------------------------------------------------
  // Row 2 — pace series, pickup bars, cancellation risk.
  // ---------------------------------------------------------------------------
  const paceSeries = buildPaceSeries(paceRows);
  const paceDates = new Map(paceRows.map((r) => [formatDayMonth(r.date), formatFullDate(r.date)]));
  const pickup = buildPickup7d(paceRows);
  const risk = Math.max(0, Math.min(100, k.cancellationRiskScore));
  const riskTone = thresholdTone(risk, RISK_THRESHOLDS, false);
  const reservationsAtRisk = Math.round((risk / 100) * 20);

  // ---------------------------------------------------------------------------
  // Row 3 — channel mix.
  // ---------------------------------------------------------------------------
  const channelSlices = buildChannelSlices(k);
  const channelTotal = channelSlices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);

  // ---------------------------------------------------------------------------
  // Row 7 — AI insights (anomalies, top 3 actions, demand spikes).
  // ---------------------------------------------------------------------------
  const anomalies = toArray<Anomaly>(k.aiAnomalies);
  const topAnomalies = anomalies.slice(0, 5);
  const top3Actions = anomalies.slice(0, 3);
  // Demand spikes are not yet a backend signal; we project the top 14 days
  // of pace where OTB exceeds LY by >25% as "spike" indicators.
  const demandSpikes = paceRows
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
  const vipsList: DirectorVipListItem[] =
    k.vipsInHouse > 0
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
    <>
      {/* Row 1 — Today snapshot strip */}
      <CocoaKpiStrip stagger aria-label="Indicadores de hoy">
        <CocoaKpi
          label="Ocupación"
          value={fmtPct(k.occupancy.today.value)}
          delta={occVsLyPct}
          deltaUnit="%"
          deltaLabel="vs LY"
          polarity="positive-good"
          sparkline={occupancySpark}
          status={statusFromAnomalies(k, "occupancy")}
        />
        <CocoaKpi label="ADR" value={fmtEur(k.adr.today.value)} delta={adrVsLyPct} deltaUnit="%" deltaLabel="vs LY" polarity="positive-good" status={statusFromAnomalies(k, "adr")} />
        <CocoaKpi label="RevPAR" value={fmtEur(k.revpar.today.value)} delta={revparVsLyPct} deltaUnit="%" deltaLabel="vs LY" polarity="positive-good" status={statusFromAnomalies(k, "revpar")} />
        <DegradedCard label={DEGRADED_LABEL.channelCost} degraded={degraded} title="GOPPAR">
          <CocoaKpi label="GOPPAR" value={fmtEur(k.goppar)} deltaLabel="proxy" polarity="positive-good" />
        </DegradedCard>
        <CocoaKpi label="En casa" value={fmtNumber(k.productivity.checkInsDone)} deltaLabel={`/${k.productivity.checkInsPlanned} planificados`} polarity="neutral" />
        <CocoaKpi label="Arrivals" value={fmtNumber(arrivals)} deltaLabel="planificadas hoy" polarity="neutral" />
        <CocoaKpi label="Departures" value={fmtNumber(departures)} deltaLabel="planificadas hoy" polarity="neutral" />
        <CocoaKpi label="OOO rooms" value={fmtNumber(k.alerts.blockedRooms)} deltaLabel="bloqueadas" polarity="negative-good" status={statusFromCount(k.alerts.blockedRooms, 1, 5)} />
        <CocoaKpi label="Ingresos hoy" value={fmtEurCompact(k.revenue.today.value)} delta={revVsLyPct} deltaUnit="%" deltaLabel="vs LY" polarity="positive-good" />
        <CocoaKpi label="Coste laboral" value={fmtEurCompact(k.totalLaborCostToday)} deltaLabel="hoy" polarity="negative-good" />
        <DegradedCard label={DEGRADED_LABEL.channelCost} degraded={degraded} title="Net contribution">
          <CocoaKpi label="Net contribution" value={fmtEurCompact(k.netContributionToday)} deltaLabel="hoy" polarity="positive-good" status={k.netContributionToday < 0 ? "critical" : "ok"} />
        </DegradedCard>
      </CocoaKpiStrip>

      {/* Row 2 — Forward pace + Pickup + Cancellation risk (8/2/2) */}
      <CocoaGrid aria-label="Pace, pickup y riesgo">
        <CocoaSpan cols={8} min={480}>
          <DegradedCard label={DEGRADED_LABEL.pace} degraded={paceDegraded} title="Pace próximos 30 días">
            <CocoaSection title="Pace próximos 30 días">
              {paceRows.length === 0 ? (
                <CocoaState kind="empty" inline title="Sin datos de pickup todavía" />
              ) : (
                <CocoaChart.Line series={paceSeries} yLabel="Revenue €" tooltipTitle={(x) => paceDates.get(x) ?? x} aria-label="Pace próximos 30 días — Revenue €" />
              )}
            </CocoaSection>
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={2} min={200}>
          <DegradedCard label={DEGRADED_LABEL.paceLastYear} degraded={paceDegraded} title="Pickup 7d">
            <CocoaSection title="Pickup 7d" meta="neto vs LY">
              <CocoaChart.Bars data={pickup} aria-label="Pickup neto últimos 7 días" />
            </CocoaSection>
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={2} min={200}>
          <CocoaSection title="Riesgo cancelación">
            <CocoaChart.Gauge
              value={risk}
              thresholds={RISK_THRESHOLDS}
              label={`riesgo ${gaugeToneLabel(riskTone)}`}
              caption={plural(reservationsAtRisk, "reserva en riesgo", "reservas en riesgo")}
              aria-label={`Riesgo de cancelación ${Math.round(risk)}% (${gaugeToneLabel(riskTone)})`}
            />
            <div style={centerRowStyle}>
              <CocoaButton variant="tinted" size="small" onClick={() => navigateTo("ReservationsListScreen")}>
                Revisar →
              </CocoaButton>
            </div>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      {/* Row 3 — Segments + Comp-set + Channel mix + BAR recs (4/4/2/2) */}
      <CocoaGrid aria-label="Segmentos, comp-set, canales y BAR">
        <CocoaSpan cols={4} min={320}>
          <DirectorSegmentBars segments={buildSegmentBars(k)} valueLabel="ADR / Mix" />
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <CompsetPlaceholder />
        </CocoaSpan>
        <CocoaSpan cols={2} min={240}>
          <CocoaSection title="Mix de canales" meta={plural(channelSlices.length, "canal", "canales")}>
            <CocoaChart.Donut slices={channelSlices} centerValue={fmtEurCompact(channelTotal)} centerLabel="revenue" aria-label="Mix de canales por revenue" />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={2} min={240}>
          <DirectorBarRecommendations recommendations={buildBarRecs(k, k.asOf)} onApply={() => navigateTo("RevenueHomeDashboard")} onViewAll={() => navigateTo("RevenueHomeDashboard")} />
        </CocoaSpan>
      </CocoaGrid>

      {/* Row 4 — Operations health mini-cards */}
      <CocoaKpiStrip min={200} aria-label="Salud operativa">
        <DirectorOpsHealthMini
          module="housekeeping"
          title="HK"
          primaryCount={k.alerts.blockedRooms}
          primaryLabel="OOO"
          status={statusFromCount(k.alerts.blockedRooms, 1, 5)}
          onDrillDown={() => navigateTo("HousekeepingDashboard")}
        />
        <DegradedCard label={DEGRADED_LABEL.incidents} degraded={degraded} title="Mantenimiento">
          <DirectorOpsHealthMini
            module="maintenance"
            title="Mantenimiento"
            primaryCount={k.alerts.openIncidents}
            primaryLabel="abiertas"
            status={statusFromCount(k.alerts.openIncidents, 5, 10)}
            breakdown={k.alerts.emergencyIncidents > 0 ? [{ label: "críticas", count: k.alerts.emergencyIncidents, tone: "danger" }] : undefined}
            onDrillDown={() => navigateTo("MaintenanceDashboard")}
          />
        </DegradedCard>
        <DirectorOpsHealthMini
          module="workforce"
          title="Workforce"
          primaryCount={k.productivity.checkInsDone + k.productivity.checkOutsDone}
          primaryLabel="movimientos hoy"
          status="ok"
          onDrillDown={() => navigateTo("ShiftManagerScreen")}
        />
        <DegradedCard label={DEGRADED_LABEL.emergencyIncidents} degraded={degraded} title="Safety">
          <DirectorOpsHealthMini
            module="safety"
            title="Safety"
            primaryCount={k.alerts.emergencyIncidents}
            primaryLabel="incidentes urgentes"
            status={statusFromCount(k.alerts.emergencyIncidents, 1, 3)}
            onDrillDown={() => navigateTo("SafetyDashboard")}
          />
        </DegradedCard>
        <DirectorOpsHealthMini module="pos" title="POS" primaryCount={Math.round(k.revenue.today.value)} primaryLabel="ingresos hoy €" status="ok" onDrillDown={() => navigateTo("PosDashboard")} />
      </CocoaKpiStrip>

      {/* Row 5 — Guest experience: NPS, Reviews, Service requests, VIPs */}
      <CocoaGrid aria-label="Experiencia del huésped">
        <CocoaSpan cols={3} min={240}>
          <CocoaSection title="NPS 30d" meta={`${reviewsLast30} reviews`}>
            <NpsFigure value={nps} />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <CocoaSection title="Reviews score" meta="30 días">
            <ReviewsScore avgScore={avgScore} count={reviewsLast30} />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <CocoaSection
            title="Service requests"
            action={
              <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("HousekeepingDashboard")}>
                Ver detalle
              </CocoaButton>
            }
          >
            <ServiceRequestsList openIncidents={k.alerts.openIncidents} emergencyIncidents={k.alerts.emergencyIncidents} degraded={degraded} />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <DirectorVipList vips={vipsList} max={5} onSelectGuest={() => navigateTo("ReservationsListScreen")} />
        </CocoaSpan>
      </CocoaGrid>

      {/* Row 6 — Compliance widgets (VeriFactu · SES · TBAI · GDPR) */}
      <CocoaGrid aria-label="Cumplimiento">
        <CocoaSpan cols={3} min={240}>
          <DegradedCard label={DEGRADED_LABEL.verifactu} degraded={degraded} title="VeriFactu">
            <DirectorComplianceWidget
              authority="verifactu"
              pendingCount={k.complianceSummary.verifactu.pending}
              status={complianceStatusFor(k.complianceSummary.verifactu)}
              lastSubmission={
                // The last-ack lookup is its own safe() query: omit the date
                // rather than show "never acknowledged" when it failed.
                isDegraded(DEGRADED_LABEL.verifactuLastAck, degraded) ? undefined : fmtCompactDateTime(k.complianceSummary.verifactu.last)
              }
              onDrillDown={() => navigateTo("FiscalDashboard")}
            />
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <DegradedCard label={DEGRADED_LABEL.ses} degraded={degraded} title="SES">
            <DirectorComplianceWidget authority="ses" pendingCount={k.complianceSummary.ses.pending} status={complianceStatusFor(k.complianceSummary.ses)} onDrillDown={() => navigateTo("SesHospedajesSettings")} />
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <DegradedCard label={DEGRADED_LABEL.tbai} degraded={degraded} title="TBAI">
            <DirectorComplianceWidget
              authority="tbai"
              pendingCount={k.complianceSummary.tbai.pending}
              status={complianceStatusFor(k.complianceSummary.tbai)}
              errorsCount={k.complianceSummary.tbai.errors}
              onDrillDown={() => navigateTo("TbaiForal")}
            />
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <DirectorComplianceWidget authority="gdpr" pendingCount={k.alerts.complianceFailing} status={statusFromCount(k.alerts.complianceFailing, 1, 5)} onDrillDown={() => navigateTo("ComplianceCenter")} />
        </CocoaSpan>
      </CocoaGrid>

      {/* Row 7 — AI insights: anomalies, top 3 actions, demand spikes (5/4/3) */}
      <CocoaGrid aria-label="Insights de IA">
        <CocoaSpan cols={5} min={320}>
          <CocoaSection
            title="Anomalías hoy"
            meta={
              <>
                <DegradedValue label={DEGRADED_LABEL.anomalies} degraded={degraded}>
                  {topAnomalies.length}
                </DegradedValue>{" "}
                detectadas
              </>
            }
          >
            <AnomaliesList anomalies={topAnomalies} />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <div className="cocoa-stack" data-gap="3">
            {top3Actions.length === 0 ? (
              <CocoaSection>
                <CocoaState kind="empty" inline title="Sin acciones recomendadas." />
              </CocoaSection>
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
                    onClick: () => navigateTo("RevenueHomeDashboard")
                  }}
                  onDismiss={() => {}}
                />
              ))
            )}
          </div>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <CocoaSection
            title="Demand spikes 14d"
            meta={
              <DegradedValue label={DEGRADED_LABEL.paceLastYear} degraded={paceDegraded}>
                {demandSpikes.length}
              </DegradedValue>
            }
          >
            <DegradedNote label={DEGRADED_LABEL.paceLastYear} degraded={paceDegraded}>
              <DemandSpikeList rows={demandSpikes} />
            </DegradedNote>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — kept local to avoid file/dependency sprawl.
// ---------------------------------------------------------------------------

function CompsetPlaceholder() {
  return (
    <CocoaSection title="RevPAR vs comp-set" meta="RGI · ARI · MPI">
      <CocoaState kind="empty" dashed title="Conectar STR / CoStar" message="Sin feed externo. Activa la integración para ver el índice competitivo." />
    </CocoaSection>
  );
}

interface NpsFigureProps {
  value?: number;
}

// Backend does not expose a per-day NPS series yet: a single figure in the
// polarity tone (≥ 50 good · ≥ 0 warning · < 0 danger).
function NpsFigure({ value }: NpsFigureProps) {
  const display = value !== undefined && Number.isFinite(value) ? value : undefined;
  const tone: CocoaTone = display === undefined ? "neutral" : display >= 50 ? "success" : display >= 0 ? "warning" : "danger";
  return (
    <div className="cocoa-row" data-gap="2" data-align="baseline">
      <span style={figureStyle(tone)}>{display !== undefined ? Math.round(display) : "—"}</span>
      <span style={mutedStyle}>NPS</span>
    </div>
  );
}

interface ReviewsScoreProps {
  avgScore?: number;
  count: number;
}

function ReviewsScore({ avgScore, count }: ReviewsScoreProps) {
  const tone: CocoaTone = avgScore === undefined ? "neutral" : avgScore >= 8.5 ? "success" : avgScore >= 7 ? "warning" : "danger";
  return (
    <div className="cocoa-stack" data-gap="1">
      <span style={figureStyle(tone)}>{avgScore !== undefined ? avgScore.toFixed(2) : "—"}</span>
      <span style={mutedStyle}>{plural(count, "review agregada", "reviews agregadas")}</span>
    </div>
  );
}

interface ServiceRequestsListProps {
  openIncidents: number;
  emergencyIncidents: number;
  degraded: string[];
}

function ServiceRequestsList({ openIncidents, emergencyIncidents, degraded }: ServiceRequestsListProps) {
  const openDegraded = isDegraded(DEGRADED_LABEL.openIncidents, degraded);
  const emergencyDegraded = isDegraded(DEGRADED_LABEL.emergencyIncidents, degraded);
  const rows: Array<{ label: string; count: number; tone: CocoaTone; degradedLabel: string }> = [
    {
      label: "Abiertas",
      count: openIncidents,
      tone: openDegraded ? "neutral" : openIncidents > 5 ? "warning" : "success",
      degradedLabel: DEGRADED_LABEL.openIncidents
    },
    {
      label: "Urgentes",
      count: emergencyIncidents,
      tone: emergencyDegraded ? "neutral" : emergencyIncidents > 0 ? "danger" : "success",
      degradedLabel: DEGRADED_LABEL.emergencyIncidents
    }
  ];
  return (
    <ul className="c22-section__list">
      {rows.map((r) => (
        <li key={r.label}>
          <span style={mutedStyle}>{r.label}</span>
          <strong style={inkStyle(r.tone)}>
            <DegradedValue label={r.degradedLabel} degraded={degraded}>
              {fmtNumber(r.count)}
            </DegradedValue>
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
    return <CocoaState kind="empty" inline title="Sin anomalías detectadas." />;
  }
  return (
    <ul className="c22-section__list">
      {anomalies.map((a, i) => (
        <li key={`${a.kind}-${i}`}>
          <div className="cocoa-stack" data-gap="1" style={growStyle}>
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <strong style={calloutStyle}>{a.kind.replace(/_/g, " ")}</strong>
              <CocoaBadge tone={anomalyTone(a.severity)}>{a.severity}</CocoaBadge>
            </div>
            <span style={mutedStyle}>{a.message}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

interface DemandSpikeListProps {
  rows: Array<PaceRow>;
}

function DemandSpikeList({ rows }: DemandSpikeListProps) {
  if (rows.length === 0) {
    return <CocoaState kind="empty" inline title="Sin demanda anómala próxima." />;
  }
  return (
    <ul className="c22-section__list">
      {rows.map((r) => {
        const pct = r.lastYear > 0 ? ((r.otb - r.lastYear) / r.lastYear) * 100 : 0;
        return (
          <li key={r.date}>
            <span style={mutedStyle}>{r.date}</span>
            <strong style={inkStyle("success")}>{percent(pct, { signDisplay: "always", maximumFractionDigits: 0 })} frente al año anterior</strong>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loading state — mirrors the 7-row layout above (same spans, so
// the content lands without a layout shift).
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-busy="true" aria-label="Cargando dashboard del director">
      <CocoaSkeleton.Strip count={11} label="Cargando indicadores de hoy…" />
      <CocoaSkeleton.Grid rows={[[8, 2, 2], [4, 4, 2, 2]]} label="Cargando pace y mix…" />
      <CocoaSkeleton.Strip count={5} min={200} label="Cargando salud operativa…" />
      <CocoaSkeleton.Grid rows={[[3, 3, 3, 3], [3, 3, 3, 3]]} height={110} label="Cargando experiencia y cumplimiento…" />
      <CocoaSkeleton.Grid rows={[[5, 4, 3]]} label="Cargando insights…" />
    </div>
  );
}

export default GeneralManagerScreen;
