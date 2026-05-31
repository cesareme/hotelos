import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type RevenueSnapshotMappingTarget = {
  reportType: "history" | "forecast" | "history_forecast" | null;
  snapshotDate: string | null;
  totalOcc?: number | null;
  arrivalRooms?: number | null;
  departureRooms?: number | null;
  compRooms?: number | null;
  houseUseRooms?: number | null;
  dayUseRooms?: number | null;
  noShowRooms?: number | null;
  oooRooms?: number | null;
  roomRevenue?: number | null;
  totalRevenue?: number | null;
  averageRate?: number | null;
  occupancyPercent?: number | null;
  totalsMatchReport?: boolean | null;
};

export type RevenueSnapshotMappingSuggestion = OnboardingStructuredSuggestion<RevenueSnapshotMappingTarget>;
