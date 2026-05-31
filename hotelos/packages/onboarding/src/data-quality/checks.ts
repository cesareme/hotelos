export type OnboardingDataQualitySeverity = "blocking" | "warning" | "info";

export type OnboardingDataQualityIssue = {
  code: string;
  severity: OnboardingDataQualitySeverity;
  title: string;
  detail: string;
  suggestedAction: string;
  affectedEntityType?: string;
  affectedCount?: number;
};

export type OnboardingDataQualityInput = {
  roomsWithoutRoomType?: number;
  duplicateRoomNumbers?: number;
  roomTypesWithoutRooms?: number;
  ratePlansWithoutRateDays?: number;
  rateDaysOutsideMinMax?: number;
  futureReservationsWithoutGuest?: number;
  futureReservationsWithoutRoomType?: number;
  futureReservationsMissingDates?: number;
  reservationsAssignedToNonexistentRoom?: number;
  channelMappingsMissing?: number;
  duplicateChannelMappings?: number;
  probableDuplicateGuests?: number;
  missingLegalPropertyProfile?: boolean;
  missingTaxRegion?: boolean;
  missingInvoiceSequence?: boolean;
  missingSesHospedajesConfiguration?: boolean;
  missingPaymentProvider?: boolean;
  revenueReportDateGaps?: number;
  forecastDataMissing?: boolean;
  oooRoomsNotMapped?: number;
  historyForecastTotalsMismatch?: boolean;
};

export const ONBOARDING_DATA_QUALITY_CHECKS = [
  "rooms_without_room_type",
  "duplicate_room_numbers",
  "room_type_without_rooms",
  "rate_plan_without_rate_days",
  "rate_day_outside_min_max",
  "future_reservation_without_guest",
  "future_reservation_without_room_type",
  "future_reservation_missing_arrival_departure",
  "reservation_assigned_to_nonexistent_room",
  "channel_mapping_missing",
  "duplicate_channel_mapping",
  "guest_duplicate_probable",
  "missing_legal_property_profile",
  "missing_tax_region",
  "missing_invoice_sequence",
  "missing_ses_hospedajes_configuration",
  "missing_payment_provider",
  "revenue_report_date_gaps",
  "forecast_data_missing",
  "ooo_rooms_not_mapped",
  "history_forecast_totals_mismatch"
] as const;

function countIssue(input: {
  code: string;
  severity: OnboardingDataQualitySeverity;
  title: string;
  detail: string;
  suggestedAction: string;
  affectedEntityType: string;
  affectedCount?: number;
}): OnboardingDataQualityIssue[] {
  if (!input.affectedCount || input.affectedCount <= 0) {
    return [];
  }
  return [
    {
      code: input.code,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      suggestedAction: input.suggestedAction,
      affectedEntityType: input.affectedEntityType,
      affectedCount: input.affectedCount
    }
  ];
}

function flagIssue(input: {
  enabled?: boolean;
  code: string;
  severity: OnboardingDataQualitySeverity;
  title: string;
  detail: string;
  suggestedAction: string;
}): OnboardingDataQualityIssue[] {
  if (!input.enabled) {
    return [];
  }
  return [
    {
      code: input.code,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      suggestedAction: input.suggestedAction
    }
  ];
}

export function runOnboardingDataQualityChecks(input: OnboardingDataQualityInput): {
  issues: OnboardingDataQualityIssue[];
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  goLiveBlocked: boolean;
} {
  const issues = [
    ...countIssue({
      code: "rooms_without_room_type",
      severity: "blocking",
      title: "Rooms without room type",
      detail: "Every imported room must map to a HotelOS room type before reservations, rates or channels can be applied.",
      suggestedAction: "Map each source room to a reviewed room type.",
      affectedEntityType: "room",
      affectedCount: input.roomsWithoutRoomType
    }),
    ...countIssue({
      code: "duplicate_room_numbers",
      severity: "blocking",
      title: "Duplicate room numbers",
      detail: "Duplicate room numbers can create assignment conflicts and overbooking risk.",
      suggestedAction: "Resolve duplicate room numbers before dry-run apply.",
      affectedEntityType: "room",
      affectedCount: input.duplicateRoomNumbers
    }),
    ...countIssue({
      code: "rate_plan_without_rate_days",
      severity: "warning",
      title: "Rate plans without rate days",
      detail: "Rate plans exist but have no future prices.",
      suggestedAction: "Create rate days or mark the rate plan inactive before go-live.",
      affectedEntityType: "rate_plan",
      affectedCount: input.ratePlansWithoutRateDays
    }),
    ...countIssue({
      code: "future_reservation_without_guest",
      severity: "blocking",
      title: "Future reservation without guest",
      detail: "Live reservations cannot be imported without a guest or company owner.",
      suggestedAction: "Map the guest, company or holding account before import.",
      affectedEntityType: "reservation",
      affectedCount: input.futureReservationsWithoutGuest
    }),
    ...countIssue({
      code: "channel_mapping_missing",
      severity: "blocking",
      title: "Missing channel mappings",
      detail: "ARI sync must not run while channel room or rate mappings are missing.",
      suggestedAction: "Complete room and rate mappings for each connected channel.",
      affectedEntityType: "channel_mapping",
      affectedCount: input.channelMappingsMissing
    }),
    ...countIssue({
      code: "guest_duplicate_probable",
      severity: "warning",
      title: "Probable duplicate guests",
      detail: "Guest import found likely duplicates.",
      suggestedAction: "Review suggested guest merges before importing CRM history.",
      affectedEntityType: "guest",
      affectedCount: input.probableDuplicateGuests
    }),
    ...countIssue({
      code: "revenue_report_date_gaps",
      severity: "warning",
      title: "Revenue report date gaps",
      detail: "Imported History & Forecast data has missing dates.",
      suggestedAction: "Upload the missing report period or exclude the affected dates from analytics import.",
      affectedEntityType: "revenue_snapshot",
      affectedCount: input.revenueReportDateGaps
    }),
    ...flagIssue({
      enabled: input.missingLegalPropertyProfile,
      code: "missing_legal_property_profile",
      severity: "blocking",
      title: "Missing legal property profile",
      detail: "The property legal profile is required before compliance and invoice setup.",
      suggestedAction: "Complete the property legal profile in Setup Center."
    }),
    ...flagIssue({
      enabled: input.missingInvoiceSequence,
      code: "missing_invoice_sequence",
      severity: "blocking",
      title: "Missing invoice sequence",
      detail: "Billing cannot go live without invoice sequence configuration.",
      suggestedAction: "Configure invoice sequences before go-live approval."
    }),
    ...flagIssue({
      enabled: input.missingSesHospedajesConfiguration,
      code: "missing_ses_hospedajes_configuration",
      severity: "blocking",
      title: "Missing SES.HOSPEDAJES configuration",
      detail: "Spain guest register communications cannot be submitted until authority settings are configured.",
      suggestedAction: "Configure authority routing and SES.HOSPEDAJES export/service-web settings."
    }),
    ...flagIssue({
      enabled: input.missingPaymentProvider,
      code: "missing_payment_provider",
      severity: "warning",
      title: "Missing payment provider",
      detail: "Open balances and payment links cannot be fully validated without a PSP connection.",
      suggestedAction: "Connect a payment provider or mark payment migration as manual."
    }),
    ...flagIssue({
      enabled: input.forecastDataMissing,
      code: "forecast_data_missing",
      severity: "warning",
      title: "Forecast data missing",
      detail: "Revenue history can be imported, but forward forecast snapshots are missing.",
      suggestedAction: "Generate forecast snapshots after room inventory and rate plans are approved."
    }),
    ...flagIssue({
      enabled: input.historyForecastTotalsMismatch,
      code: "history_forecast_totals_mismatch",
      severity: "blocking",
      title: "History & Forecast totals mismatch",
      detail: "The extracted report rows do not match the report subtotal or total row.",
      suggestedAction: "Review extraction, correct mappings or upload a cleaner source report."
    })
  ];

  const blockingCount = issues.filter((issue) => issue.severity === "blocking").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const infoCount = issues.filter((issue) => issue.severity === "info").length;

  return {
    issues,
    blockingCount,
    warningCount,
    infoCount,
    goLiveBlocked: blockingCount > 0
  };
}
