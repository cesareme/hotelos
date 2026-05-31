// Frontend client for the REAL revenue endpoints (Fase B/C backend).
import { getActivePropertyId } from "./activeProperty";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    let m = t;
    try { m = (JSON.parse(t) as { message?: string }).message ?? t; } catch { /* keep */ }
    throw new Error(m || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
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
export type Recommendation = {
  id: string;
  recommendationType: string;
  targetDate: string;
  current: { bar?: number; occupancyPct?: number; compsetMedian?: number | null };
  recommended: { bar?: number };
  expectedImpact: { direction?: string; deltaPct?: number };
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
export type BudgetVariance = {
  month: string;
  totalRooms: number;
  budget: { roomsSold: number | null; roomRevenue: number; adr: number; occupancyPct: number } | null;
  forecast: { roomsSold: number; roomRevenue: number; adr: number; occupancyPct: number };
  actual: { roomsSold: number; roomRevenue: number; adr: number; occupancyPct: number };
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
  nights: Array<{ date: string; available: number; displacedRooms: number; transientAdr: number; displacedRevenue: number; groupRevenue: number }>;
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

// ---- shared format helper -------------------------------------------------
export function money(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, useGrouping: true }).format(n);
}
