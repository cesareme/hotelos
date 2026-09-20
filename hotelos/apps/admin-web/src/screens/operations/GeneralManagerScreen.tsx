// General Manager Screen — Director Dashboard v2.0 · the Cocoa 22 canon.
//
// Layout following docs/director-dashboard/DESIGN-PROPOSAL.md (7 rows on the
// 12-column grid of docs/design/COCOA-22.md §3.4), painted ONLY with the
// Cocoa 22 primitives (§8). This screen is the visual reference the rest of
// the back office copies (§1): tokens, radii, shadows, spacing and motion
// come from the primitives, never from local styles.
//   1. Today snapshot strip — 11 CocoaKpi tiles (CocoaKpiStrip, stagger)
//   1b. «Riesgos de hoy» (Tanda UX-2 · lote D3 · F-D1/F-D2): un solo bloque
//      con los bloqueos del cierre (preflight), los pendientes de aprobación y
//      de la IA (solo con la clave), el riesgo de cancelación y las anomalías,
//      cada fila con su acción (CocoaButton → pantalla); comandos ⌘K de tarea
//   2. Forward pace (CocoaChart.Line) + Captación 7 días (Bars) + Riesgo cancelación (Gauge)
//   3. Segments + RevPAR-vs-compset + Channel mix (Donut) + BAR recommendations
//   4. Operations health mini-cards (Pisos / Mantenimiento / Personal / Seguridad / TPV)
//   5. NPS · Índice de reputación (30 d) · Peticiones de servicio · VIP alojados
//      (Tanda T8 · lote T8-G: el índice 0-100 llega en `reputationIndex` con un
//      estado honesto — ok · insufficient · no_reviews · no_sources · module_off —
//      y se pinta con ReputationFigure (CocoaStat + CocoaBadge, sin estilos en
//      línea) dentro de DegradedCard; la antigua media sobre 10 se retira)
//   6. Compliance widgets (VeriFactu · SES · TBAI · GDPR)
//   7. Acciones recomendadas (top 3) + Caja de hoy + Picos de demanda 14 días
//
// Data sources:
//   GET /dashboards/general-manager?propertyId=  — enriched director dashboard
//     (UX-2: ventana = fecha de negocio de la propiedad; `businessDate` +
//     `businessDateSource` dicen cuál; el subtítulo la pinta)
//   GET /general-manager/pace?propertyId=&days=  — OTB / forecast / LY pace
//   GET /properties/:id/night-audit/preflight     — bloqueos del cierre (60 s)
//   GET /approvals?status=pending (listPendingApprovals) + pendingForViewer — solo con clave *_approve
//   GET /ai-operations/review/stats                — pendientes de la IA, solo con ai_governance.read
//
// States (§3.10): loading → mirror skeleton with the same spans (no layout
// shift); no payload → empty state; `degraded[]` labels → DegradedValue /
// DegradedCard / DegradedBanner («—» with a hint, never a fake green 0).

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveOrganizationId, getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useNavGate } from "../../navigation/useEnabledModules";
import { navigateTo } from "../../lib/navigate";
import type { GmReputationIndex } from "../../services/reputation-contracts";
import { listPendingApprovals } from "../../services/approvalsApi";
import { getUser } from "../../services/auth-storage";
import { useCurrentUserProfile } from "../../services/usersApi";
import { hasApprovalKeys, pendingForViewer, viewerFromProfile } from "../approvals/approvals-helpers";
import { canRespond, reputationFigureActionLabel, reputationFigureModel, trendTone } from "./reputation/reputation-helpers";
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
  CocoaStat,
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
import { dateTime, money, number, percent, plural, time } from "../../lib/format";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { DIRECCION_PANEL_INSTRUCTIONS } from "../../content/screen-instructions/direccion";

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
  // Tanda UX-2 (D3): ventana «hoy» = fecha de negocio de la propiedad (o día UTC sin fila).
  businessDate?: string;
  businessDateSource?: "business_date" | "utc_day";
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
  // Tanda T8 (T8-E): índice de reputación a 30 días con estado honesto (siempre presente en la API de T8; opcional aquí por compatibilidad).
  reputationIndex?: GmReputationIndex;
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

// Preflight del cierre (night-audit-preflight.service.ts): solo lo que el bloque
// «Riesgos de hoy» lee (bloqueos + mensaje); la pantalla del cierre pinta el resto.
type PreflightSummary = {
  businessDate?: string;
  canClose: boolean;
  blockingMessage?: string;
  summary: { ok: number; warning: number; blocker: number };
};

// GET /ai-operations/review/stats (humanReviewQueueStats): solo `pending` aquí.
type ReviewStats = { pending: number };

/** Lo que el bloque «Riesgos de hoy» necesita más allá del panel (null = sin dato todavía o sin clave). */
type RiskInputs = {
  preflight: PreflightSummary | null;
  preflightError: string | null;
  /** null sin clave de aprobación; undefined mientras carga. */
  pendingApprovals: number | null | undefined;
  /** null sin `ai_governance.read`; undefined mientras carga. */
  pendingAi: number | null | undefined;
};

const AI_REVIEW_KEY = "ai_governance.read";

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
  // Tanda T8: the reputation index (snapshot + connected sources) and the 30-day NPS of the surveys.
  reputation: ["reputation.index30", "reputation.sources"],
  nps: "reputation.nps30",
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

/** «DD/MM» de una fecha ISO (`YYYY-MM-DD`); «—» si no parsea. */
function ddmm(iso?: string): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : "—";
}

/**
 * Subtítulo honesto de la ventana (P7): «Datos de la fecha de negocio 19/09 ·
 * actualizado 08:12»; sin fila de business_dates el API cae al día UTC y se dice.
 */
function windowSubtitle(k: Pick<Data, "asOf" | "businessDate" | "businessDateSource" | "generatedAt">): string {
  const day = ddmm(k.businessDate ?? k.asOf);
  const window = k.businessDateSource === "utc_day" ? `Datos del día UTC ${day} (la propiedad no tiene fecha de negocio)` : `Datos de la fecha de negocio ${day}`;
  return `${window} · actualizado ${time(k.generatedAt)}`;
}

/** Delta vs hace 7 días solo cuando hay base (LY/semana = 0 ⇒ «▲100 %» sería mentira): undefined oculta el chip. */
function deltaVsWeek(compare: Compare): number | undefined {
  const base = compare.vsLastWeek;
  if (!base || !(base.value > 0)) return undefined;
  return base.pct;
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
    const hint = pctVsLY === undefined ? "frente al año anterior: —" : `frente al año anterior: ${percent(pctVsLY, { signDisplay: "always", minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
    return { label, value: net, tone, hint };
  });
}

// OTB (accent, 2 px) · Forecast (warning, dashed) · Last year (tertiary, 1 px).
function buildPaceSeries(rows: PaceRow[]): CocoaLineSeries[] {
  const points = (pick: (row: PaceRow) => number) => rows.map((row) => ({ x: formatDayMonth(row.date), y: pick(row) }));
  return [
    { id: "otb", label: "OTB", tone: "accent", width: 2, points: points((row) => row.otb) },
    { id: "forecast", label: "Previsión", tone: "warning", dashed: true, width: 2, points: points((row) => row.forecast) },
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
  // keeps the subtitle («datos de la fecha de negocio DD/MM · actualizado HH:MM»)
  // and the actions row (HostedHead).
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const organizationId = getActiveOrganizationId();
  const gate = useNavGate();
  const { profile } = useCurrentUserProfile();
  const { data, loading, error, refresh } = useApiData<Data>(`/dashboards/general-manager?propertyId=${propertyId}`, {
    pollIntervalMs: 60000
  });
  const { data: pace, loading: paceLoading } = useApiData<PaceData>(`/general-manager/pace?propertyId=${propertyId}&days=${PACE_DAYS}`, {
    pollIntervalMs: 120000
  });
  // Riesgos de hoy (UX-2 · D3): bloqueos del cierre (misma fuente que la pantalla
  // del cierre, 60 s) y pendientes de la IA solo con la clave del manifiesto.
  const { data: preflight, error: preflightError } = useApiData<PreflightSummary>(`/properties/${propertyId}/night-audit/preflight`, {
    pollIntervalMs: 60000
  });
  const canReadAi = (gate.grantedPermissions ?? []).includes(AI_REVIEW_KEY);
  const { data: aiStats } = useApiData<ReviewStats>("/ai-operations/review/stats", {
    query: { organizationId },
    pollIntervalMs: 60000,
    enabled: canReadAi
  });
  // Pendientes de aprobación que el usuario puede DECIDIR (mismo criterio que la
  // tarjeta de Mi día y el badge de la bandeja: corrector 8a · FX-09).
  const approver = hasApprovalKeys(gate.grantedPermissions);
  const [pendingApprovals, setPendingApprovals] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!approver) return undefined;
    let alive = true;
    const viewer = viewerFromProfile({ userId: getUser()?.userId ?? null, isPlatformAdmin: gate.isPlatformAdmin, grantedPermissions: gate.grantedPermissions, properties: profile?.properties ?? null });
    listPendingApprovals()
      .then((rows) => pendingForViewer(rows, viewer).length)
      .then((value) => {
        if (alive) setPendingApprovals(value);
      })
      .catch(() => {
        // La bandeja explica el fallo; la fila sigue llevando a ella.
        if (alive) setPendingApprovals(undefined);
      });
    return () => {
      alive = false;
    };
  }, [approver, gate.isPlatformAdmin, gate.grantedPermissions, profile]);

  const k = data;
  const isLoading = loading && !k;
  const degraded = toArray<string>(data?.degraded);
  const paceDegraded = toArray<string>(pace?.degraded);
  const paceRows = toArray<PaceRow>(pace?.rows).slice(0, PACE_DAYS);
  const risks: RiskInputs = {
    preflight: preflight ?? null,
    preflightError: preflightError ?? null,
    pendingApprovals: approver ? pendingApprovals : null,
    pendingAi: canReadAi ? aiStats?.pending : null
  };

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
      subtitle={k ? windowSubtitle(k) : "Vista estratégica del día y del mes en curso"}
      actions={headerActions}
      density="comfortable"
      state={isLoading ? "loading" : !k ? "empty" : "ready"}
      skeleton={<DashboardSkeleton />}
      empty={{ title: "Sin datos del director hoy", message: "El cuadro de mando se rellena con la actividad de la propiedad a lo largo del día." }}
      commands={[
        { id: "general-manager-refresh", label: "Actualizar dashboard del director", run: refresh },
        // Tanda UX-2 (F-D11): las tareas de dirección son comandos de página, no solo «Actualizar».
        { id: "general-manager-pendientes", label: "Ir a los pendientes de aprobación", run: () => navigateTo("ApprovalsInbox") },
        { id: "general-manager-cierre", label: "Revisar el cierre del día", run: () => navigateTo("NightAuditScreen") },
        { id: "general-manager-cartera", label: "Abrir la cartera de hoteles", run: () => navigateTo("PortfolioDashboard") },
        { id: "general-manager-exportar", label: "Exportar un informe", run: () => navigateTo("ReportingCenter") }
      ]}
    >
      {k ? <DirectorDashboard k={k} degraded={degraded} paceRows={paceRows} paceDegraded={paceDegraded} risks={risks} /> : null}

      {/* Ayuda contextual honesta (UX-2 · D8): solo lo que existe en esta pantalla; se descarta una vez. */}
      <CocoaScreenInstructionsCard {...DIRECCION_PANEL_INSTRUCTIONS} dismissible persistKey="direccion-panel" />
    </CocoaPage>
  );
}

interface DirectorDashboardProps {
  k: Data;
  degraded: string[];
  paceRows: PaceRow[];
  paceDegraded: string[];
  risks: RiskInputs;
}

function DirectorDashboard({ k, degraded, paceRows, paceDegraded, risks }: DirectorDashboardProps) {
  // ---------------------------------------------------------------------------
  // Row 1 — Today snapshot strip: 11 KPI tiles. Deltas vs hace 7 días solo con
  // base > 0 (UX-2 · P7: nunca «▲100 %» sobre un cero).
  // ---------------------------------------------------------------------------
  const occVsWeekPct = deltaVsWeek(k.occupancy.today);
  const adrVsWeekPct = deltaVsWeek(k.adr.today);
  const revparVsWeekPct = deltaVsWeek(k.revpar.today);
  const revVsWeekPct = deltaVsWeek(k.revenue.today);
  const arrivals = k.productivity.checkInsPlanned;
  const departures = k.productivity.checkOutsPlanned;
  const occupancySpark = paceRows.slice(0, 7).map((r) => r.otb);
  const businessDay = ddmm(k.businessDate ?? k.asOf);

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
  // Riesgos de hoy (anomalías) y Row 7 — top 3 actions, caja, demand spikes.
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
  // Reputation row data (Tanda T8: `reputationIndex` first, legacy `reputation` as fallback).
  // ---------------------------------------------------------------------------
  const reputationIndex = k.reputationIndex;
  const reviewsLast30 = reputationIndex?.reviewCount30 ?? k.reputation?.reviewsLast30 ?? 0;
  const nps = reputationIndex?.npsLast30 ?? k.reputation?.npsLast30;

  // VIP alojados — backend exposes count only; we surface a single synthetic
  // entry showing the count for now until a per-guest list endpoint exists.
  const vipsList: DirectorVipListItem[] =
    k.vipsInHouse > 0
      ? [
          {
            guestId: "summary",
            name: `${k.vipsInHouse} VIP alojados`,
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
          delta={occVsWeekPct}
          deltaUnit="%"
          deltaLabel={occVsWeekPct === undefined ? "sin base de comparación" : "vs hace 7 días"}
          polarity="positive-good"
          sparkline={occupancySpark}
          status={statusFromAnomalies(k, "occupancy")}
        />
        <CocoaKpi label="ADR" value={fmtEur(k.adr.today.value)} delta={adrVsWeekPct} deltaUnit="%" deltaLabel={adrVsWeekPct === undefined ? "sin base de comparación" : "vs hace 7 días"} polarity="positive-good" status={statusFromAnomalies(k, "adr")} />
        <CocoaKpi label="RevPAR" value={fmtEur(k.revpar.today.value)} delta={revparVsWeekPct} deltaUnit="%" deltaLabel={revparVsWeekPct === undefined ? "sin base de comparación" : "vs hace 7 días"} polarity="positive-good" status={statusFromAnomalies(k, "revpar")} />
        <DegradedCard label={DEGRADED_LABEL.channelCost} degraded={degraded} title="GOPPAR">
          <CocoaKpi label="GOPPAR" value={fmtEur(k.goppar)} deltaLabel="aproximado" polarity="positive-good" />
        </DegradedCard>
        <CocoaKpi label="En casa" value={fmtNumber(k.productivity.checkInsDone)} deltaLabel="check-ins del día" polarity="neutral" />
        <CocoaKpi label="Llegadas" value={fmtNumber(arrivals)} deltaLabel="pendientes de llegar" polarity="neutral" />
        <CocoaKpi label="Salidas" value={fmtNumber(departures)} deltaLabel="pendientes de salir" polarity="neutral" />
        <CocoaKpi label="Bloqueadas" value={fmtNumber(k.alerts.blockedRooms)} deltaLabel="habitaciones fuera de venta" polarity="negative-good" status={statusFromCount(k.alerts.blockedRooms, 1, 5)} />
        <CocoaKpi label="Ingresos hoy" value={fmtEurCompact(k.revenue.today.value)} delta={revVsWeekPct} deltaUnit="%" deltaLabel={revVsWeekPct === undefined ? "sin base de comparación" : "vs hace 7 días"} polarity="positive-good" />
        <CocoaKpi label="Coste laboral" value={fmtEurCompact(k.totalLaborCostToday)} deltaLabel="hoy" polarity="negative-good" />
        <DegradedCard label={DEGRADED_LABEL.channelCost} degraded={degraded} title="Contribución neta">
          <CocoaKpi label="Contribución neta" value={fmtEurCompact(k.netContributionToday)} deltaLabel="hoy" polarity="positive-good" status={k.netContributionToday < 0 ? "critical" : "ok"} />
        </DegradedCard>
      </CocoaKpiStrip>

      {/* Row 1b — Riesgos de hoy: una lista, una acción por fila (UX-2 · D3) */}
      <CocoaSection
        title="Riesgos de hoy"
        meta={`fecha de negocio ${businessDay}`}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("NightAuditScreen")}>
            Abrir el cierre
          </CocoaButton>
        }
        aria-label="Riesgos de hoy"
      >
        <RisksList risks={risks} riskScore={risk} riskTone={riskTone} reservationsAtRisk={reservationsAtRisk} anomalies={topAnomalies} degraded={degraded} />
      </CocoaSection>

      {/* Row 2 — Forward pace + Pickup + Cancellation risk (8/2/2) */}
      <CocoaGrid aria-label="Pace, pickup y riesgo">
        <CocoaSpan cols={8} min={480}>
          <DegradedCard label={DEGRADED_LABEL.pace} degraded={paceDegraded} title="Ritmo 30 días">
            <CocoaSection title="Ritmo 30 días" meta="OTB · previsión · año anterior">
              {paceRows.length === 0 ? (
                <CocoaState kind="empty" inline role="none" title="Sin datos de ritmo todavía" />
              ) : (
                <CocoaChart.Line series={paceSeries} yLabel="Ingresos €" tooltipTitle={(x) => paceDates.get(x) ?? x} aria-label="Ritmo 30 días — Ingresos €" />
              )}
            </CocoaSection>
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={2} min={200}>
          <DegradedCard label={DEGRADED_LABEL.paceLastYear} degraded={paceDegraded} title="Captación 7 días">
            <CocoaSection title="Captación 7 días" meta="neto frente al año anterior">
              <CocoaChart.Bars data={pickup} aria-label="Captación neta de los últimos 7 días" />
            </CocoaSection>
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={2} min={200}>
          <CocoaSection title="Riesgo cancelación" meta="próximos 14 días">
            <CocoaChart.Gauge
              value={risk}
              thresholds={RISK_THRESHOLDS}
              label={`riesgo ${gaugeToneLabel(riskTone)}`}
              caption={plural(reservationsAtRisk, "reserva en riesgo", "reservas en riesgo")}
              aria-label={`Riesgo de cancelación ${Math.round(risk)}% (${gaugeToneLabel(riskTone)})`}
            />
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      {/* Row 3 — Segmentos + comp-set + mix de canales + recomendaciones BAR (4/4/2/2); rótulos en español (UX2-REV-05) */}
      <CocoaGrid aria-label="Segmentos, comp-set, canales y BAR">
        <CocoaSpan cols={4} min={320}>
          <DirectorSegmentBars title="Segmentos" segments={buildSegmentBars(k)} valueLabel="ADR / Mix" />
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <CompsetPlaceholder />
        </CocoaSpan>
        <CocoaSpan cols={2} min={240}>
          <CocoaSection title="Mix de canales" meta={plural(channelSlices.length, "canal", "canales")}>
            <CocoaChart.Donut slices={channelSlices} centerValue={fmtEurCompact(channelTotal)} centerLabel="ingresos" aria-label="Mix de canales por ingresos" />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={2} min={240}>
          <DirectorBarRecommendations title="Recomendaciones BAR de la IA" recommendations={buildBarRecs(k, k.asOf)} onApply={() => navigateTo("RevenueHomeDashboard")} onViewAll={() => navigateTo("RevenueHomeDashboard")} />
        </CocoaSpan>
      </CocoaGrid>

      {/* Row 4 — Operations health mini-cards */}
      <CocoaKpiStrip min={200} aria-label="Salud operativa">
        <DirectorOpsHealthMini
          module="housekeeping"
          title="Pisos"
          primaryCount={k.alerts.blockedRooms}
          primaryLabel="bloqueadas"
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
          title="Personal"
          primaryCount={k.productivity.checkInsDone + k.productivity.checkOutsDone}
          primaryLabel="movimientos hoy"
          status="ok"
          onDrillDown={() => navigateTo("ShiftManagerScreen")}
        />
        <DegradedCard label={DEGRADED_LABEL.emergencyIncidents} degraded={degraded} title="Seguridad">
          <DirectorOpsHealthMini
            module="safety"
            title="Seguridad"
            primaryCount={k.alerts.emergencyIncidents}
            primaryLabel="incidentes urgentes"
            status={statusFromCount(k.alerts.emergencyIncidents, 1, 3)}
            onDrillDown={() => navigateTo("SafetyDashboard")}
          />
        </DegradedCard>
        <DirectorOpsHealthMini module="pos" title="TPV" primaryCount={Math.round(k.revenue.today.value)} primaryLabel="ingresos hoy €" status="ok" onDrillDown={() => navigateTo("PosDashboard")} />
      </CocoaKpiStrip>

      {/* Row 5 — Guest experience: NPS, reputation index, service requests, VIPs */}
      <CocoaGrid aria-label="Experiencia del huésped">
        <CocoaSpan cols={3} min={240}>
          <DegradedCard label={DEGRADED_LABEL.nps} degraded={degraded} title="NPS 30d">
            <CocoaSection title="NPS 30d" meta={plural(reviewsLast30, "reseña", "reseñas")}>
              <NpsFigure value={nps} />
            </CocoaSection>
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <DegradedCard label={DEGRADED_LABEL.reputation} degraded={degraded} title="Índice de reputación (30 d)">
            <CocoaSection title="Índice de reputación (30 d)" meta={reputationIndex ? "sobre 100" : "sin datos"}>
              <ReputationFigure
                status={reputationIndex?.status ?? (k.reputation ? "insufficient" : "no_sources")}
                index30={reputationIndex?.index30}
                trendDelta={reputationIndex?.trendDelta}
                reviewCount30={reviewsLast30}
                sourcesConnected={reputationIndex?.sourcesConnected ?? 0}
                staleDays={reputationIndex?.staleDays}
              />
            </CocoaSection>
          </DegradedCard>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <CocoaSection
            title="Peticiones de servicio"
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
          <DirectorVipList title="VIP alojados" vips={vipsList} max={5} onSelectGuest={() => navigateTo("ReservationsListScreen")} />
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

      {/* Row 7 — Acciones recomendadas, caja de hoy y picos de demanda (5/4/3) */}
      <CocoaGrid aria-label="Acciones, caja y demanda">
        <CocoaSpan cols={5} min={320}>
          <div className="cocoa-stack" data-gap="3">
            {top3Actions.length === 0 ? (
              <CocoaSection>
                <CocoaState kind="empty" inline role="none" title="Sin acciones recomendadas." />
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
        <CocoaSpan cols={4} min={240}>
          <CocoaSection title="Caja de hoy" meta={`fecha de negocio ${businessDay}`}>
            <CashList cash={k.cash} />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={3} min={240}>
          <CocoaSection
            title="Picos de demanda 14 días"
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
      <CocoaState kind="empty" dashed role="none" title="Conectar STR / CoStar" message="Sin feed externo. Activa la integración para ver el índice competitivo." />
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

type ReputationFigureProps = {
  status: GmReputationIndex["status"];
  index30?: number;
  trendDelta?: number;
  reviewCount30: number;
  sourcesConnected: number;
  staleDays?: number;
};

// Tanda T8 · lote T8-G: the 0-100 reputation index with its honest state. The
// figure is a CocoaStat (tone ink ≥ 85 success · ≥ 70 warning · danger), the
// trend a CocoaBadge; without a figure the copy says why (no sources → «Configurar»
// only for users who can write sources (reputation.respond, what ReputationDashboard
// requires for «Configurar fuentes»); module off → «Activar módulo» only for users
// who may enable modules; N reseñas · insuficiente (mínimo 10)). No local styles.
function ReputationFigure({ status, index30, trendDelta, reviewCount30, sourcesConnected, staleDays }: ReputationFigureProps) {
  const gate = useNavGate();
  const model = reputationFigureModel({ status, index30, trendDelta, reviewCount30, sourcesConnected, staleDays });
  const actionLabel = reputationFigureActionLabel(model.action, { canConfigure: canRespond(gate.grantedPermissions), canEnableModules: gate.canEnableModules });
  const onAction = model.action === "configure_sources" ? () => navigateTo("ReputationDashboard") : model.action === "enable_module" ? () => navigateTo("ModuleManager", "modulo=reputation_quality") : undefined;
  return (
    <div className="cocoa-stack" data-gap="2">
      <div className="cocoa-row" data-gap="3" data-align="end" data-wrap="true">
        <CocoaStat label="Índice" value={model.value} tone={model.tone === "neutral" ? undefined : model.tone} size="large" hint={model.hint} />
        {model.trend ? (
          <CocoaBadge tone={trendTone(trendDelta) === "neutral" ? "neutral" : trendTone(trendDelta)} variant="tinted" size="small" uppercase={false}>
            {model.trend}
          </CocoaBadge>
        ) : (
          <CocoaBadge tone={model.action ? "warning" : "neutral"} variant="tinted" size="small" uppercase={false}>
            {model.statusLabel}
          </CocoaBadge>
        )}
      </div>
      {actionLabel && onAction ? (
        <span className="cocoa-cluster">
          <CocoaButton variant="tinted" tone="accent" size="small" onClick={onAction}>
            {actionLabel}
          </CocoaButton>
        </span>
      ) : null}
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

/** Tono del gauge de riesgo (thresholdTone): success · warning · danger. */
type GaugeTone = Parameters<typeof gaugeToneLabel>[0];

type RiskRowModel = {
  key: string;
  title: string;
  detail: string;
  tone: CocoaTone;
  badge: string;
  action?: { label: string; onClick: () => void };
};

/**
 * Filas del bloque «Riesgos de hoy» (pura): bloqueos del cierre, pendientes de
 * aprobación y de la IA (solo con clave), riesgo de cancelación y anomalías. Sin
 * dato todavía → «comprobando…» en tono neutro; sin clave → la fila no existe.
 */
function buildRiskRows(input: { risks: RiskInputs; riskScore: number; riskTone: GaugeTone; reservationsAtRisk: number; anomalies: Anomaly[]; anomaliesDegraded: boolean }): RiskRowModel[] {
  const { risks, anomalies } = input;
  const rows: RiskRowModel[] = [];

  const preflight = risks.preflight;
  const blockers = preflight?.summary.blocker ?? 0;
  rows.push({
    key: "cierre",
    title: "Cierre del día",
    detail: risks.preflightError
      ? "No se ha podido comprobar el cierre: ábrelo para ver el detalle."
      : !preflight
        ? "Comprobando el cierre…"
        : blockers > 0
          ? (preflight.blockingMessage ?? plural(blockers, "bloqueo pendiente", "bloqueos pendientes"))
          : preflight.summary.warning > 0
            ? `${plural(preflight.summary.warning, "aviso", "avisos")} · nada bloquea el cierre.`
            : "Todas las comprobaciones críticas en verde.",
    tone: risks.preflightError || !preflight ? "neutral" : blockers > 0 ? "danger" : preflight.summary.warning > 0 ? "warning" : "success",
    badge: risks.preflightError || !preflight ? "—" : blockers > 0 ? plural(blockers, "bloqueo", "bloqueos") : "sin bloqueos",
    action: { label: "Revisar el cierre", onClick: () => navigateTo("NightAuditScreen") }
  });

  if (risks.pendingApprovals !== null) {
    const n = risks.pendingApprovals;
    rows.push({
      key: "aprobaciones",
      title: "Pendientes de aprobación",
      detail: n === undefined ? "Contando las solicitudes que puedes decidir…" : n > 0 ? `${plural(n, "solicitud espera", "solicitudes esperan")} tu decisión.` : "Ninguna solicitud espera tu decisión.",
      tone: n === undefined ? "neutral" : n > 0 ? "warning" : "success",
      badge: n === undefined ? "—" : String(n),
      action: { label: "Ir a aprobaciones", onClick: () => navigateTo("ApprovalsInbox") }
    });
  }

  if (risks.pendingAi !== null) {
    const n = risks.pendingAi;
    rows.push({
      key: "ia",
      title: "Pendientes de la IA",
      detail: n === undefined ? "Contando los ítems en revisión humana…" : n > 0 ? `${plural(n, "ítem espera", "ítems esperan")} revisión humana.` : "La cola de revisión humana está vacía.",
      tone: n === undefined ? "neutral" : n > 0 ? "warning" : "success",
      badge: n === undefined ? "—" : String(n),
      action: { label: "Revisar la cola", onClick: () => navigateTo("AiHumanReviewQueueScreen") }
    });
  }

  rows.push({
    key: "cancelacion",
    title: "Riesgo de cancelación",
    detail: `${plural(input.reservationsAtRisk, "reserva en riesgo", "reservas en riesgo")} en los próximos 14 días (riesgo ${gaugeToneLabel(input.riskTone)}).`,
    tone: input.riskTone,
    badge: percent(input.riskScore, { maximumFractionDigits: 0 }),
    action: { label: "Revisar reservas", onClick: () => navigateTo("ReservationsListScreen") }
  });

  if (anomalies.length === 0) {
    rows.push({
      key: "anomalias",
      title: "Anomalías",
      detail: input.anomaliesDegraded ? "No se ha podido comparar con el año anterior." : "Sin anomalías detectadas frente al año anterior.",
      tone: input.anomaliesDegraded ? "neutral" : "success",
      badge: input.anomaliesDegraded ? "—" : "0"
    });
  }
  anomalies.forEach((a, i) => {
    rows.push({
      key: `anomalia-${a.kind}-${i}`,
      title: `Anomalía · ${a.kind.replace(/_/g, " ")}`,
      detail: a.message,
      tone: anomalyTone(a.severity),
      badge: a.severity === "high" ? "alta" : a.severity === "medium" ? "media" : "baja",
      action: { label: "Ver ingresos", onClick: () => navigateTo("RevenueHomeDashboard") }
    });
  });
  return rows;
}

interface RisksListProps {
  risks: RiskInputs;
  riskScore: number;
  riskTone: GaugeTone;
  reservationsAtRisk: number;
  anomalies: Anomaly[];
  degraded: string[];
}

// «Riesgos de hoy»: c22-section__list + CocoaBadge + CocoaButton, sin estilos locales.
function RisksList({ risks, riskScore, riskTone, reservationsAtRisk, anomalies, degraded }: RisksListProps) {
  const rows = buildRiskRows({ risks, riskScore, riskTone, reservationsAtRisk, anomalies, anomaliesDegraded: isDegraded(DEGRADED_LABEL.anomalies, degraded) });
  return (
    <ul className="c22-section__list">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="cocoa-stack" data-gap="1">
            <div className="cocoa-row" data-gap="2" data-align="center" data-wrap="true">
              <strong>{row.title}</strong>
              <CocoaBadge tone={row.tone} variant="tinted" size="small" uppercase={false}>
                {row.badge}
              </CocoaBadge>
            </div>
            <span className="cocoa-note">{row.detail}</span>
          </div>
          {row.action ? (
            <CocoaButton variant="tinted" tone="accent" size="small" onClick={row.action.onClick}>
              {row.action.label}
            </CocoaButton>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface CashListProps {
  cash: Data["cash"];
}

// Caja de la fecha de negocio (cobros capturados, devoluciones, neto y saldo abierto de los folios).
function CashList({ cash }: CashListProps) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Cobrado", value: fmtEur(cash.capturedTodayEur) },
    { label: "Devuelto", value: fmtEur(cash.refundedTodayEur) },
    { label: "Neto", value: fmtEur(cash.netTodayEur) },
    { label: "Saldo abierto en folios", value: fmtEur(cash.openBalanceEur) }
  ];
  return (
    <ul className="c22-section__list">
      {rows.map((r) => (
        <li key={r.label}>
          <span>{r.label}</span>
          <strong>{r.value}</strong>
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
    return <CocoaState kind="empty" inline role="none" title="Sin demanda anómala próxima." />;
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
      <CocoaSkeleton.Grid rows={[[12]]} height={200} label="Cargando riesgos de hoy…" />
      <CocoaSkeleton.Grid rows={[[8, 2, 2], [4, 4, 2, 2]]} label="Cargando pace y mix…" />
      <CocoaSkeleton.Strip count={5} min={200} label="Cargando salud operativa…" />
      <CocoaSkeleton.Grid rows={[[3, 3, 3, 3], [3, 3, 3, 3]]} height={110} label="Cargando experiencia y cumplimiento…" />
      <CocoaSkeleton.Grid rows={[[5, 4, 3]]} label="Cargando insights…" />
    </div>
  );
}

export default GeneralManagerScreen;
