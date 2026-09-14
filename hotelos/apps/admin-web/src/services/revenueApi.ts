// Frontend client for the REAL revenue endpoints (Fase B/C backend).
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

// All calls go through apiRequest (JWT + 401 handling + API error message).
// The previous raw `fetch` helpers sent no Authorization header, which only
// worked on the demo instance (fail-open) and returned 401 in production.
function get<T>(path: string): Promise<T> {
  return apiRequest<T>(path);
}
function post<T>(path: string, body?: unknown): Promise<T> {
  // apiRequest only sets Content-Type when a body is present; POST actions
  // without payload send `{}` so the server's `request.body ?? {}` stays valid.
  return apiRequest<T>(path, { method: "POST", body: body ?? {} });
}

// ---- Pace & pickup --------------------------------------------------------
export type PaceHorizon = { horizonDays: number; otbRooms: number; otbRevenue: number; priorOtbRooms: number; priorOtbRevenue: number; paceRooms: number; paceRevenue: number };
export type PaceResult = { propertyId: string; asOf: string; comparison: { label: string; priorAsOf: string }; horizons: PaceHorizon[]; source: string };
export type PickupWindow = { windowDays: number; reservations: number; roomNights: number; revenue: number };
export type PickupResult = { propertyId: string; asOf: string; windows: PickupWindow[]; source: string };

export function fetchPace(propertyId = getActivePropertyId()) {
  return get<PaceResult>(`/revenue/properties/${propertyId}/pace`);
}
export function fetchPickup(propertyId = getActivePropertyId()) {
  return get<PickupResult>(`/revenue/properties/${propertyId}/pickup`);
}

// ---- Forecast accuracy + by segment --------------------------------------
export type ForecastAccuracyMetric = { metric: string; mape: number | null; accuracy: number | null; samples: number };
export type ForecastAccuracyResult = { propertyId: string; days: number; totalRooms: number; metrics: ForecastAccuracyMetric[]; source: string };
export type ForecastSegmentRow = { forecastDate: string; segment: string; expectedRoomsSold: number; expectedRoomRevenue: number; expectedAdr: number; sharePercent: number };
export type ForecastBySegmentResult = { propertyId: string; segments: string[]; rows: ForecastSegmentRow[]; source: string };

export function fetchForecastAccuracy(propertyId = getActivePropertyId(), days = 30) {
  return get<ForecastAccuracyResult>(`/revenue/properties/${propertyId}/forecast-accuracy?days=${days}`);
}
export function fetchForecastBySegment(propertyId = getActivePropertyId()) {
  return get<ForecastBySegmentResult>(`/revenue/properties/${propertyId}/forecasts/by-segment`);
}
export function generateForecasts(propertyId = getActivePropertyId()) {
  return post<{ generated: number }>(`/revenue/properties/${propertyId}/forecasts/generate`, {});
}

// ---- Rate shopper ---------------------------------------------------------
export type Competitor = { id: string; name: string; category?: string | null; starRating?: string | null; comparableScore?: string | null; active: boolean };
export type CompetitorRate = { id: string; competitorHotelId: string | null; sourceChannel: string | null; shopDate: string; stayDate: string; price: number; currency: string | null; availabilityStatus: string | null };
export type ParityAlert = { id: string; alertType: string; severity: string; stayDate: string; sourceChannel: string | null; directRate: number; channelRate: number; currency: string | null; message: string; status: string };

export function fetchCompetitors(propertyId = getActivePropertyId()) {
  return get<Competitor[]>(`/rate-shopper/properties/${propertyId}/competitors`);
}
export function createCompetitor(payload: { name: string; category?: string; comparableScore?: number }, propertyId = getActivePropertyId()) {
  return post<Competitor>(`/rate-shopper/properties/${propertyId}/competitors`, payload);
}
export function fetchCompetitorRates(propertyId = getActivePropertyId()) {
  return get<CompetitorRate[]>(`/rate-shopper/properties/${propertyId}/rates`);
}
export function runRateShop(daysAhead = 14, propertyId = getActivePropertyId()) {
  return post<{ jobId: string; competitors: number; snapshots: number; daysAhead: number; shopDate: string; source: string }>(
    `/rate-shopper/properties/${propertyId}/shop`,
    { daysAhead }
  );
}
export function fetchParityAlerts(propertyId = getActivePropertyId()) {
  return get<ParityAlert[]>(`/rate-shopper/properties/${propertyId}/parity-alerts`);
}

// ---- Recommendations + pricing rules (Fase C2) ----------------------------
// Tanda 2 · REV-04: `current.bar` is null when no BAR is published in the rate
// grid for that date (`barSource: "none"`); the UI must render "—", never a
// fallback price.
export type RecommendationBarSource = "rate_grid" | "none";
export type Recommendation = {
  id: string;
  recommendationType: string;
  targetDate: string;
  current: { bar?: number | null; barSource?: RecommendationBarSource; occupancyPct?: number; compsetMedian?: number | null };
  recommended: { bar?: number | null };
  expectedImpact: { direction?: string; deltaPct?: number | null };
  reasons: Array<{ driver: string; value: unknown }>;
  confidence: number;
  riskLevel: string;
  status: string;
  appliedAt: string | null;
};
export type PricingRule = { id: string; name: string; priority: number; minOccupancy?: string | null; maxOccupancy?: string | null; adjustType: string; adjustValue: string; active: boolean };

export function fetchRecommendations(propertyId = getActivePropertyId()) {
  return get<Recommendation[]>(`/revenue/properties/${propertyId}/recommendations`);
}
export function generateRecommendations(propertyId = getActivePropertyId()) {
  return post<{ generated: number }>(`/revenue/properties/${propertyId}/recommendations/generate`, {});
}
export function decideRecommendation(id: string, decision: "approve" | "apply" | "reject") {
  return post<Recommendation>(`/revenue/recommendations/${id}/${decision}`);
}
export function fetchPricingRules(propertyId = getActivePropertyId()) {
  return get<PricingRule[]>(`/revenue/properties/${propertyId}/pricing-rules`);
}
export function createPricingRule(payload: { name: string; priority?: number; minOccupancy?: number; maxOccupancy?: number; adjustType?: "percent" | "amount"; adjustValue?: number }, propertyId = getActivePropertyId()) {
  return post<PricingRule>(`/revenue/properties/${propertyId}/pricing-rules`, payload);
}

// ---- Strategy: meeting pack + displacement (Fase D) -----------------------
export type BudgetVarianceBlock = { roomsSold: number; roomRevenue: number; adr: number; occupancyPct: number };
// Tanda 2 · REV-03: `actual` comes from RevenueDailySnapshot first and falls
// back to reservations per day; `forecast` only sums RevenueForecast from
// max(from, today) and is null for a closed month. `sources` says which.
export type BudgetVarianceSources = {
  /** "snapshots" | "snapshots+reservas" | "reservas" */
  actual: string;
  /** Forecast model version, or null when no forecast applies (closed month). */
  forecast: string | null;
};
export type BudgetVariance = {
  month: string;
  totalRooms: number;
  budget: { roomsSold: number | null; roomRevenue: number; adr: number; occupancyPct: number } | null;
  forecast: BudgetVarianceBlock | null;
  actual: BudgetVarianceBlock;
  sources?: BudgetVarianceSources;
  /** Past days of the month covered by a night-audit snapshot. */
  snapshotDays?: number;
  /** Past days computed from reservations because no snapshot exists. */
  fallbackDays?: number;
};
export type MeetingPack = {
  propertyId: string;
  generatedAt: string;
  pace: PaceResult;
  pickup: PickupResult;
  forecastAccuracy: ForecastAccuracyMetric[];
  compSet: { samples: number; median: number | null; min: number | null; max: number | null };
  budgetVariance: BudgetVariance;
  topRecommendations: Recommendation[];
};
export type Displacement = {
  arrivalDate: string;
  departureDate: string;
  roomsPerNight: number;
  groupRate: number;
  groupRevenue: number;
  displacedRevenue: number;
  netBenefit: number;
  recommendation: string;
  // transientAdr is null when neither a forecast nor a published BAR exists for
  // the night (the API flags it via adrSource instead of inventing a rate).
  nights: Array<{ date: string; available: number; displacedRooms: number; transientAdr: number | null; adrSource?: string; displacedRevenue: number; groupRevenue: number }>;
};

export function fetchMeetingPack(propertyId = getActivePropertyId()) {
  return get<MeetingPack>(`/revenue/properties/${propertyId}/meeting-pack`);
}
export function analyzeDisplacement(payload: { arrivalDate: string; departureDate: string; roomsPerNight: number; groupRate: number }, propertyId = getActivePropertyId()) {
  return post<Displacement>(`/revenue/properties/${propertyId}/displacement`, payload);
}

// ---- Live history/forecast detailed report --------------------------------
export type ReportRow = {
  rowType: "section" | "data" | "subtotal" | "total";
  label?: string;
  date?: string;
  totalOcc?: number;
  arrivalRooms?: number;
  departureRooms?: number;
  noShowRooms?: number;
  occPercent?: number;
  totalRevenue?: number;
  averageRate?: number;
  adultsChildren?: number;
};
export type HistoryForecastReport = { propertyId: string; from: string; to: string; businessDate: string; totalRooms: number; rows: ReportRow[]; source: string };

export function fetchHistoryForecastReport(from: string, to: string, propertyId = getActivePropertyId()) {
  return get<HistoryForecastReport>(`/revenue/properties/${propertyId}/history-forecast/report?from=${from}&to=${to}`);
}

// ---- period comparison ----------------------------------------------------
export type PeriodMetrics = {
  from: string;
  to: string;
  days: number;
  roomsSold: number;
  occupancyPct: number;
  adr: number;
  revpar: number;
  goppar: number;
  roomRevenue: number;
  totalRevenue: number;
  hasData: boolean;
};

export function fetchPeriodMetrics(from: string, to: string, propertyId = getActivePropertyId()) {
  return get<PeriodMetrics>(`/revenue/properties/${propertyId}/period-metrics?from=${from}&to=${to}`);
}

// ---- History & Forecast BOARD (contract frozen 2026-07-15) ----------------
// Canonical Opera-style board computed server-side from Prisma (reservations +
// RevenueDailySnapshot + RevenueForecast + Budget + RevenuePaceSnapshot).
// Uses apiRequest (JWT-attached) because the board is permission-gated.
export type BoardRowType = "data" | "weekSubtotal" | "monthSubtotal" | "total";
export type BoardRow = {
  rowType: BoardRowType;
  label?: string;
  date?: string;
  dow?: string;
  isPast?: boolean;
  isToday?: boolean;
  // Actual (past, audited) / OTB (today+future) block
  roomsSold: number;
  occPct: number;
  adr: number | null;
  revpar: number | null;
  roomRevenue: number;
  arrivals: number;
  departures: number;
  noShows: number;
  ooo: number;
  // Forecast block (future only; null in the past)
  fcRooms: number | null;
  fcOccPct: number | null;
  fcAdr: number | null;
  fcRevenue: number | null;
  fcConfidence: number | null;
  // STLY block (audited close of date−364)
  stlyRooms: number | null;
  stlyOccPct: number | null;
  stlyAdr: number | null;
  stlyRevenue: number | null;
  deltaRoomsVsStly: number | null;
  deltaRevVsStly: number | null;
  // Budget (monthly figure prorated per day)
  budgetRevenue: number | null;
  deltaRevVsBudget: number | null;
  // Pickup (Δ rooms OTB; future dates only)
  pickup1: number | null;
  pickup7: number | null;
  pickup28: number | null;
  pickupAdr7: number | null;
};
export type MonthOutlook = {
  month: string;
  label: string;
  daysElapsed: number;
  daysTotal: number;
  actualRevenue: number;
  otbRevenue: number;
  forecastRevenue: number | null;
  projectedRevenue: number;
  projectedOccPct: number | null;
  projectedAdr: number | null;
  budgetRevenue: number | null;
  gapToBudget: number | null;
  gapPct: number | null;
  status: "ok" | "warn" | "risk" | "no_budget";
  lyRevenue: number | null;
  lyOccPct: number | null;
  lyAdr: number | null;
};
export type CriticalDate = {
  date: string;
  dow: string;
  daysOut: number;
  severity: "high" | "medium";
  reason: string;
  occPct: number;
  fcOccPct: number | null;
  stlyOccPct: number | null;
  pickup7: number | null;
  recommendation: string | null;
  compsetMedian: number | null;
};
export type BoardKpiBlock = { roomsSold: number; occPct: number; adr: number | null; revenue: number };
export type BoardKpis = {
  next7: BoardKpiBlock & { pickup7: number | null };
  next30: BoardKpiBlock & { pickup7: number | null };
  mtd: BoardKpiBlock & { vsStlyRevenuePct: number | null };
  forecastConfidenceAvg: number | null;
};
export type HistoryForecastBoard = {
  propertyId: string;
  propertyName: string;
  businessDate: string;
  generatedAt: string;
  from: string;
  to: string;
  totalRooms: number;
  forecastMissing: boolean;
  budgetMissing: boolean;
  metricNotes: string[];
  sources: Record<string, string>;
  rows: BoardRow[];
  months: MonthOutlook[];
  criticalDates: CriticalDate[];
  kpis: BoardKpis;
};

export function fetchHistoryForecastBoard(
  opts: { from?: string; to?: string } = {},
  propertyId = getActivePropertyId()
) {
  return apiRequest<HistoryForecastBoard>(`/revenue/properties/${propertyId}/history-forecast/board`, {
    query: { from: opts.from, to: opts.to }
  });
}

// ---- shared format helper -------------------------------------------------
export function money(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, useGrouping: true }).format(n);
}
