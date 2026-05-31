export const HISTORY_FORECAST_REPORT_SECTIONS = ["History", "History subtotal", "Forecast", "Forecast subtotal", "Total"] as const;

export const HISTORY_FORECAST_REQUIRED_COLUMNS = [
  "Date",
  "Total Occ.",
  "Arr. Rooms",
  "Comp. Rooms",
  "House Use",
  "Deduct Indiv.",
  "Non-Ded. Indiv.",
  "Deduct Group",
  "Non-Ded. Group",
  "Occ. %",
  "Total Revenue",
  "Average Rate",
  "Dep. Rooms",
  "Day Use Rooms",
  "No Show Rooms",
  "OOO Rooms",
  "Adl. & Chl."
] as const;

export type HistoryForecastImportRow = {
  section: "history" | "forecast";
  date: string;
  totalOcc: number;
  arrivalRooms: number;
  compRooms: number;
  houseUseRooms: number;
  deductIndividualRooms: number;
  nonDeductIndividualRooms: number;
  deductGroupRooms: number;
  nonDeductGroupRooms: number;
  occupancyPercent: number;
  totalRevenue: number;
  averageRate: number;
  departureRooms: number;
  dayUseRooms: number;
  noShowRooms: number;
  oooRooms: number;
  adultsChildren: number;
};

export type HistoryForecastImportPreview = {
  documentType: "revenue_history_forecast_report";
  dateRange: { fromDate: string | null; toDate: string | null };
  filters: Record<string, unknown>;
  sectionsDetected: string[];
  rows: HistoryForecastImportRow[];
  totalsValidation: {
    rowRevenueTotal: number;
    reportedRevenueTotal: number | null;
    totalsMatch: boolean | null;
    mismatchAmount: number | null;
  };
  blockers: string[];
  warnings: string[];
};

export function validateHistoryForecastColumns(columns: string[]) {
  const missingColumns = HISTORY_FORECAST_REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
  return {
    valid: missingColumns.length === 0,
    missingColumns
  };
}

export function buildHistoryForecastImportPreview(input: {
  fromDate?: string | null;
  toDate?: string | null;
  filters?: Record<string, unknown>;
  columns: string[];
  rows: HistoryForecastImportRow[];
  reportedRevenueTotal?: number | null;
  sectionsDetected?: string[];
}): HistoryForecastImportPreview {
  const columnValidation = validateHistoryForecastColumns(input.columns);
  const rowRevenueTotal = Number(input.rows.reduce((sum, row) => sum + row.totalRevenue, 0).toFixed(2));
  const reportedRevenueTotal = input.reportedRevenueTotal ?? null;
  const mismatchAmount = reportedRevenueTotal === null ? null : Number((rowRevenueTotal - reportedRevenueTotal).toFixed(2));
  const totalsMatch = reportedRevenueTotal === null ? null : Math.abs(mismatchAmount ?? 0) < 0.01;
  const sectionsDetected = input.sectionsDetected ?? Array.from(new Set(input.rows.map((row) => (row.section === "history" ? "History" : "Forecast"))));
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!columnValidation.valid) {
    blockers.push(`Missing required columns: ${columnValidation.missingColumns.join(", ")}`);
  }
  if (input.rows.length === 0) {
    blockers.push("No daily rows were extracted from the History & Forecast report.");
  }
  if (totalsMatch === false) {
    blockers.push("Extracted daily rows do not match the report total row.");
  }
  if (!sectionsDetected.includes("History") || !sectionsDetected.includes("Forecast")) {
    warnings.push("History and Forecast sections were not both detected.");
  }
  if (reportedRevenueTotal === null) {
    warnings.push("Reported total row was not found; human review is required before applying revenue snapshots.");
  }

  return {
    documentType: "revenue_history_forecast_report",
    dateRange: { fromDate: input.fromDate ?? null, toDate: input.toDate ?? null },
    filters: input.filters ?? {},
    sectionsDetected,
    rows: input.rows,
    totalsValidation: {
      rowRevenueTotal,
      reportedRevenueTotal,
      totalsMatch,
      mismatchAmount
    },
    blockers,
    warnings
  };
}
