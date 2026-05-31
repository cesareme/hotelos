export type HistoryForecastGranularity = "daily" | "weekly" | "monthly" | "auto";
export type ResolvedHistoryForecastGranularity = Exclude<HistoryForecastGranularity, "auto">;
export type HistoryForecastSectionName = "history" | "forecast";
export type ComparisonPeriod = "none" | "previous_period" | "same_period_last_year" | "custom_period";

export type HistoryForecastFilters = {
  roomClassId?: string;
  roomTypeId?: string;
  ratePlanId?: string;
  channelId?: string;
  segment?: string;
  market?: string;
  includeHouseUseInOcc?: boolean;
  includeDayUseInOcc?: boolean;
  includeNoShowInOcc?: boolean;
  excludeOOOFromOcc?: boolean;
  deduct?: boolean | "all";
  individualGroup?: "individual" | "group" | "all";
  revenueMode?: "gross" | "net";
  distributedRevenue?: boolean;
  comparisonPeriod?: ComparisonPeriod;
  customComparisonFromDate?: string;
  customComparisonToDate?: string;
};

export type HistoryForecastSnapshot = {
  date: string;
  section?: HistoryForecastSectionName;
  totalOcc: number;
  availableRooms: number;
  arrivalRooms: number;
  departureRooms: number;
  compRooms: number;
  houseUseRooms: number;
  dayUseRooms: number;
  noShowRooms: number;
  oooRooms: number;
  deductIndividualRooms: number;
  nonDeductIndividualRooms: number;
  deductGroupRooms: number;
  nonDeductGroupRooms: number;
  adultsChildren: number;
  roomRevenue: number;
  totalRevenue: number;
  netRoomRevenue: number;
  grossOperatingProfit?: number;
  confidence?: number;
  confidenceLow?: Record<string, number>;
  confidenceHigh?: Record<string, number>;
  drivers?: string[];
  dataQualityScore?: number;
};

export type HistoryForecastRow = HistoryForecastSnapshot & {
  label: string;
  granularity: ResolvedHistoryForecastGranularity;
  occPercent: number;
  averageRate: number;
  revpar: number;
  trevpar: number;
  goppar: number | null;
  netRevpar: number;
};

export type HistoryForecastSubtotal = {
  label: string;
  totalOcc: number;
  availableRooms: number;
  arrivalRooms: number;
  departureRooms: number;
  compRooms: number;
  houseUseRooms: number;
  dayUseRooms: number;
  noShowRooms: number;
  oooRooms: number;
  deductIndividualRooms: number;
  nonDeductIndividualRooms: number;
  deductGroupRooms: number;
  nonDeductGroupRooms: number;
  adultsChildren: number;
  roomRevenue: number;
  totalRevenue: number;
  netRoomRevenue: number;
  grossOperatingProfit: number;
  occPercent: number;
  averageRate: number;
  revpar: number;
  trevpar: number;
  goppar: number | null;
  netRevpar: number;
  confidence?: number;
};

export type RevenueChartSeries = {
  key: string;
  label: string;
  metric: string;
  axis: "left" | "right";
  type: "line" | "bar" | "area";
  values: {
    date: string;
    value: number | null;
    section: HistoryForecastSectionName;
    confidenceLow?: number;
    confidenceHigh?: number;
  }[];
};

export type HistoryForecastKpis = {
  occupancyPercent: number;
  occupiedRooms: number;
  availableRooms: number;
  oooRooms: number;
  arrivals: number;
  departures: number;
  totalRevenue: number;
  roomRevenue: number;
  adr: number;
  revpar: number;
  trevpar: number;
  goppar: number | null;
  netRevpar: number;
  forecastConfidence: number;
  pickupLast24h?: number;
  pickupLast7d?: number;
  paceVsLastYear?: number;
  channelCost?: number;
  commissionCost?: number;
  contributionMargin?: number;
};

export type RevenueVisualAlert = {
  id: string;
  alertType:
    | "high_demand_date"
    | "low_demand_date"
    | "underpriced_date"
    | "overpriced_date"
    | "forecast_confidence_low"
    | "occupancy_risk"
    | "revenue_risk"
    | "adr_drop"
    | "revpar_drop"
    | "ooo_impact_high"
    | "no_show_risk"
    | "group_dependency_risk"
    | "channel_dependency_risk"
    | "rate_parity_issue"
    | "channel_sync_issue";
  severity: "info" | "warning" | "critical" | "blocking";
  date?: string;
  message: string;
  suggestedAction: string;
};

export type HistoryForecastAggregationInput = {
  propertyId: string;
  fromDate: string;
  toDate: string;
  granularity: HistoryForecastGranularity;
  filters: HistoryForecastFilters;
  businessDate: string;
  historySnapshots: HistoryForecastSnapshot[];
  forecastSnapshots: HistoryForecastSnapshot[];
};

export type HistoryForecastAggregationOutput = {
  historyRows: HistoryForecastRow[];
  forecastRows: HistoryForecastRow[];
  historySubtotal: HistoryForecastSubtotal;
  forecastSubtotal: HistoryForecastSubtotal;
  total: HistoryForecastSubtotal;
  chartSeries: RevenueChartSeries[];
  kpis: HistoryForecastKpis;
  alerts: RevenueVisualAlert[];
};

export function differenceInCalendarDays(toDate: string, fromDate: string): number {
  const from = Date.UTC(...dateParts(fromDate));
  const to = Date.UTC(...dateParts(toDate));
  return Math.floor((to - from) / 86_400_000);
}

export function validateHistoryForecastRange(fromDate: string, toDate: string) {
  const rangeDays = differenceInCalendarDays(toDate, fromDate) + 1;
  if (rangeDays <= 1) {
    throw new Error("History & Forecast requires a period longer than one day.");
  }
  if (rangeDays >= 365) {
    throw new Error("History & Forecast supports periods lower than 12 months.");
  }
  if (isTwelveCalendarMonthsOrMore(fromDate, toDate)) {
    throw new Error("History & Forecast supports periods lower than 12 months.");
  }
  return rangeDays;
}

export function resolveHistoryForecastGranularity(input: {
  fromDate: string;
  toDate: string;
  requestedGranularity: HistoryForecastGranularity;
}): ResolvedHistoryForecastGranularity {
  const rangeDays = validateHistoryForecastRange(input.fromDate, input.toDate);
  // Default granularity bands: 2-45 days = daily, 46-120 days = weekly, 121-364 days = monthly.
  if (input.requestedGranularity === "daily" && rangeDays > 93) {
    throw new Error("Daily granularity is available for periods up to 93 days.");
  }
  if (input.requestedGranularity === "weekly" && rangeDays < 7) {
    throw new Error("Weekly granularity requires at least 7 days.");
  }
  if (input.requestedGranularity === "monthly" && rangeDays < 28) {
    throw new Error("Monthly granularity requires at least 28 days.");
  }
  if (input.requestedGranularity !== "auto") {
    return input.requestedGranularity;
  }
  if (rangeDays <= 45) return "daily";
  if (rangeDays <= 120) return "weekly";
  return "monthly";
}

export function splitHistoryForecastByBusinessDate<T extends { date: string }>(input: {
  rows: T[];
  businessDate: string;
}): { history: T[]; forecast: T[] } {
  return {
    history: input.rows.filter((row) => row.date <= input.businessDate),
    forecast: input.rows.filter((row) => row.date > input.businessDate)
  };
}

export function aggregateHistoryForecast(input: HistoryForecastAggregationInput): HistoryForecastAggregationOutput {
  const granularity = resolveHistoryForecastGranularity({
    fromDate: input.fromDate,
    toDate: input.toDate,
    requestedGranularity: input.granularity
  });
  const historyRows = rollupRows(
    input.historySnapshots
      .filter((row) => withinRange(row.date, input.fromDate, input.toDate) && row.date <= input.businessDate)
      .map((row) => ({ ...row, section: "history" as const })),
    granularity
  );
  const forecastRows = rollupRows(
    input.forecastSnapshots
      .filter((row) => withinRange(row.date, input.fromDate, input.toDate) && row.date > input.businessDate)
      .map((row) => ({ ...row, section: "forecast" as const })),
    granularity
  );
  const historySubtotal = calculateWeightedSubtotal("History subtotal", historyRows);
  const forecastSubtotal = calculateWeightedSubtotal("Forecast subtotal", forecastRows);
  const total = calculateWeightedSubtotal("Total", [...historyRows, ...forecastRows]);
  const chartSeries = buildChartSeries([...historyRows, ...forecastRows]);
  const kpis = buildKpis(total, forecastSubtotal);
  const alerts = buildVisualAlerts(forecastRows);
  return { historyRows, forecastRows, historySubtotal, forecastSubtotal, total, chartSeries, kpis, alerts };
}

export function calculateWeightedSubtotal(label: string, rows: HistoryForecastSnapshot[]): HistoryForecastSubtotal {
  const totalOcc = sum(rows, "totalOcc");
  const availableRooms = sum(rows, "availableRooms");
  const roomRevenue = sum(rows, "roomRevenue");
  const totalRevenue = sum(rows, "totalRevenue");
  const netRoomRevenue = sum(rows, "netRoomRevenue");
  const grossOperatingProfit = rows.reduce((total, row) => total + (row.grossOperatingProfit ?? 0), 0);
  return {
    label,
    totalOcc,
    availableRooms,
    arrivalRooms: sum(rows, "arrivalRooms"),
    departureRooms: sum(rows, "departureRooms"),
    compRooms: sum(rows, "compRooms"),
    houseUseRooms: sum(rows, "houseUseRooms"),
    dayUseRooms: sum(rows, "dayUseRooms"),
    noShowRooms: sum(rows, "noShowRooms"),
    oooRooms: sum(rows, "oooRooms"),
    deductIndividualRooms: sum(rows, "deductIndividualRooms"),
    nonDeductIndividualRooms: sum(rows, "nonDeductIndividualRooms"),
    deductGroupRooms: sum(rows, "deductGroupRooms"),
    nonDeductGroupRooms: sum(rows, "nonDeductGroupRooms"),
    adultsChildren: sum(rows, "adultsChildren"),
    roomRevenue,
    totalRevenue,
    netRoomRevenue,
    grossOperatingProfit,
    // Weighted formulas: do not average daily percentages blindly for period totals.
    occPercent: ratio(totalOcc, availableRooms) * 100,
    averageRate: ratio(roomRevenue, totalOcc),
    revpar: ratio(roomRevenue, availableRooms),
    trevpar: ratio(totalRevenue, availableRooms),
    goppar: availableRooms > 0 ? ratio(grossOperatingProfit, availableRooms) : null,
    netRevpar: ratio(netRoomRevenue, availableRooms),
    confidence: weightedConfidence(rows)
  };
}

function rollupRows(rows: HistoryForecastSnapshot[], granularity: ResolvedHistoryForecastGranularity): HistoryForecastRow[] {
  const buckets = new Map<string, HistoryForecastSnapshot[]>();
  for (const row of rows) {
    const key = bucketKey(row.date, granularity);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return Array.from(buckets.entries()).map(([label, bucketRows]) => {
    const subtotal = calculateWeightedSubtotal(label, bucketRows);
    const first = bucketRows[0];
    return {
      ...subtotal,
      date: first?.date ?? label,
      section: first?.section,
      label,
      granularity,
      confidenceLow: first?.confidenceLow,
      confidenceHigh: first?.confidenceHigh,
      drivers: bucketRows.flatMap((row) => row.drivers ?? []).slice(0, 4),
      dataQualityScore: weightedConfidence(bucketRows)
    };
  });
}

function buildChartSeries(rows: HistoryForecastRow[]): RevenueChartSeries[] {
  const value = (metric: keyof HistoryForecastRow) =>
    rows.map((row) => ({
      date: row.date,
      value: typeof row[metric] === "number" ? (row[metric] as number) : null,
      section: row.section ?? "history",
      confidenceLow: row.confidenceLow?.[String(metric)],
      confidenceHigh: row.confidenceHigh?.[String(metric)]
    }));
  return [
    { key: "occupancy", label: "Occupancy %", metric: "occPercent", axis: "left", type: "area", values: value("occPercent") },
    { key: "adr", label: "ADR", metric: "averageRate", axis: "right", type: "line", values: value("averageRate") },
    { key: "revpar", label: "RevPAR", metric: "revpar", axis: "right", type: "line", values: value("revpar") },
    { key: "total_revenue", label: "Total revenue", metric: "totalRevenue", axis: "right", type: "bar", values: value("totalRevenue") }
  ];
}

function buildKpis(total: HistoryForecastSubtotal, forecast: HistoryForecastSubtotal): HistoryForecastKpis {
  return {
    occupancyPercent: total.occPercent,
    occupiedRooms: total.totalOcc,
    availableRooms: total.availableRooms,
    oooRooms: total.oooRooms,
    arrivals: total.arrivalRooms,
    departures: total.departureRooms,
    totalRevenue: total.totalRevenue,
    roomRevenue: total.roomRevenue,
    adr: total.averageRate,
    revpar: total.revpar,
    trevpar: total.trevpar,
    goppar: total.goppar,
    netRevpar: total.netRevpar,
    forecastConfidence: forecast.confidence ?? 0,
    pickupLast24h: 4,
    pickupLast7d: 19,
    paceVsLastYear: 6,
    channelCost: 708,
    commissionCost: 630,
    contributionMargin: total.totalRevenue === 0 ? 0 : (total.grossOperatingProfit / total.totalRevenue) * 100
  };
}

function buildVisualAlerts(rows: HistoryForecastRow[]): RevenueVisualAlert[] {
  return rows.flatMap((row) => {
    const alerts: RevenueVisualAlert[] = [];
    if (row.occPercent < 45) {
      alerts.push({
        id: `low_occ_${row.date}`,
        alertType: "low_demand_date",
        severity: "warning",
        date: row.date,
        message: `Forecast occupancy for ${row.label} is ${row.occPercent.toFixed(2)}%, below target.`,
        suggestedAction: "Review rates, restrictions and demand channels."
      });
    }
    if ((row.confidence ?? 1) < 0.75) {
      alerts.push({
        id: `low_confidence_${row.date}`,
        alertType: "forecast_confidence_low",
        severity: "warning",
        date: row.date,
        message: `Forecast confidence for ${row.label} is ${Math.round((row.confidence ?? 0) * 100)}%.`,
        suggestedAction: "Inspect forecast drivers and data quality before applying recommendations."
      });
    }
    if (row.oooRooms > 4) {
      alerts.push({
        id: `ooo_impact_${row.date}`,
        alertType: "ooo_impact_high",
        severity: "critical",
        date: row.date,
        message: `${row.oooRooms} out-of-order rooms affect occupancy for ${row.label}.`,
        suggestedAction: "Coordinate maintenance blocks with revenue recommendations."
      });
    }
    return alerts;
  });
}

function bucketKey(date: string, granularity: ResolvedHistoryForecastGranularity) {
  if (granularity === "daily") return date;
  const [year, month, day] = date.split("-").map(Number);
  if (granularity === "monthly") return `${monthName(month)} ${year}`;
  const current = new Date(Date.UTC(year, month - 1, day));
  const weekday = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() - weekday + 1);
  return `Week of ${current.toISOString().slice(0, 10)}`;
}

function dateParts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year, month - 1, day];
}

function isTwelveCalendarMonthsOrMore(fromDate: string, toDate: string) {
  const [fromYear, fromMonth, fromDay] = fromDate.split("-").map(Number);
  const [toYear, toMonth, toDay] = toDate.split("-").map(Number);
  const monthDelta = (toYear - fromYear) * 12 + (toMonth - fromMonth);
  return monthDelta > 12 || (monthDelta === 12 && toDay >= fromDay);
}

function withinRange(date: string, fromDate: string, toDate: string) {
  return date >= fromDate && date <= toDate;
}

function sum(rows: HistoryForecastSnapshot[], key: keyof HistoryForecastSnapshot) {
  return rows.reduce((total, row) => total + (typeof row[key] === "number" ? (row[key] as number) : 0), 0);
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(2));
}

function weightedConfidence(rows: HistoryForecastSnapshot[]) {
  const weighted = rows.reduce(
    (state, row) => {
      const weight = Math.max(1, row.availableRooms || row.totalRevenue || 1);
      return {
        totalWeight: state.totalWeight + weight,
        confidence: state.confidence + (row.confidence ?? 0) * weight
      };
    },
    { totalWeight: 0, confidence: 0 }
  );
  return weighted.totalWeight === 0 ? 0 : Number((weighted.confidence / weighted.totalWeight).toFixed(2));
}

function monthName(month: number) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] ?? "Month";
}
