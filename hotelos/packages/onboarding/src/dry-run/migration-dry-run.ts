import type { OnboardingDataQualityIssue } from "../data-quality/checks.js";

export type OnboardingMigrationOperation = "create" | "update" | "link" | "skip";

export type OnboardingMigrationBatchType =
  | "property_blueprint"
  | "rooms"
  | "spaces"
  | "inventory_resources"
  | "rates"
  | "restrictions"
  | "reservations"
  | "guests"
  | "companies"
  | "channels"
  | "channel_mappings"
  | "revenue_history"
  | "compliance_settings"
  | "users_roles";

export type MigrationDryRunInput = {
  projectId: string;
  approvedSuggestionCounts: Partial<Record<OnboardingMigrationBatchType, number>>;
  pendingSuggestionCounts?: Partial<Record<OnboardingMigrationBatchType, number>>;
  dataQualityIssues: OnboardingDataQualityIssue[];
  confirmationProvided?: boolean;
};

export type MigrationDryRunBatch = {
  batchType: OnboardingMigrationBatchType;
  operation: OnboardingMigrationOperation;
  recordsToCreate: number;
  recordsToUpdate: number;
  recordsToLink: number;
  recordsToSkip: number;
  status: "ready" | "blocked" | "review_required";
  blockers: string[];
  warnings: string[];
};

export const ONBOARDING_IMPORT_APPLICATION_ORDER: OnboardingMigrationBatchType[] = [
  "property_blueprint",
  "compliance_settings",
  "rooms",
  "spaces",
  "inventory_resources",
  "rates",
  "restrictions",
  "channels",
  "channel_mappings",
  "guests",
  "companies",
  "reservations",
  "revenue_history",
  "users_roles"
];

export const LIVE_ACCOUNTING_IMPORT_RULE =
  "Historical invoices and revenue reports are imported as read-only history or analytics snapshots unless explicitly approved as accounting ledger migration.";

function blockersForBatch(batchType: OnboardingMigrationBatchType, issues: OnboardingDataQualityIssue[]): string[] {
  const blockingCodes = issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.code);
  const blockers: string[] = [];

  if (batchType === "rooms" || batchType === "inventory_resources") {
    if (blockingCodes.includes("rooms_without_room_type")) blockers.push("rooms_without_room_type");
    if (blockingCodes.includes("duplicate_room_numbers")) blockers.push("duplicate_room_numbers");
  }

  if (batchType === "channel_mappings" || batchType === "channels") {
    if (blockingCodes.includes("channel_mapping_missing")) blockers.push("channel_mapping_missing");
  }

  if (batchType === "reservations") {
    if (blockingCodes.includes("future_reservation_without_guest")) blockers.push("future_reservation_without_guest");
    if (blockingCodes.includes("rooms_without_room_type")) blockers.push("rooms_without_room_type");
  }

  if (batchType === "revenue_history") {
    if (blockingCodes.includes("history_forecast_totals_mismatch")) blockers.push("history_forecast_totals_mismatch");
  }

  if (batchType === "compliance_settings") {
    if (blockingCodes.includes("missing_legal_property_profile")) blockers.push("missing_legal_property_profile");
    if (blockingCodes.includes("missing_ses_hospedajes_configuration")) blockers.push("missing_ses_hospedajes_configuration");
  }

  return blockers;
}

export function generateMigrationDryRun(input: MigrationDryRunInput): {
  projectId: string;
  dryRunRequired: true;
  confirmationRequiredBeforeApply: true;
  canApply: boolean;
  batches: MigrationDryRunBatch[];
  summary: {
    recordsToCreate: number;
    recordsToUpdate: number;
    recordsToLink: number;
    recordsToSkip: number;
    blockedBatches: number;
    reviewRequiredBatches: number;
  };
  importApplicationOrder: OnboardingMigrationBatchType[];
  accountingRule: string;
} {
  const batches = ONBOARDING_IMPORT_APPLICATION_ORDER.map((batchType) => {
    const approved = input.approvedSuggestionCounts[batchType] ?? 0;
    const pending = input.pendingSuggestionCounts?.[batchType] ?? 0;
    const blockers = blockersForBatch(batchType, input.dataQualityIssues);
    const status = blockers.length > 0 ? "blocked" : pending > 0 ? "review_required" : "ready";

    return {
      batchType,
      operation: approved > 0 ? "create" : "skip",
      recordsToCreate: approved,
      recordsToUpdate: batchType === "rates" || batchType === "restrictions" ? Math.floor(approved / 2) : 0,
      recordsToLink: batchType === "channel_mappings" || batchType === "reservations" ? approved : 0,
      recordsToSkip: pending,
      status,
      blockers,
      warnings: pending > 0 ? [`${pending} suggestions still need human review.`] : []
    } satisfies MigrationDryRunBatch;
  });

  const summary = batches.reduce(
    (accumulator, batch) => ({
      recordsToCreate: accumulator.recordsToCreate + batch.recordsToCreate,
      recordsToUpdate: accumulator.recordsToUpdate + batch.recordsToUpdate,
      recordsToLink: accumulator.recordsToLink + batch.recordsToLink,
      recordsToSkip: accumulator.recordsToSkip + batch.recordsToSkip,
      blockedBatches: accumulator.blockedBatches + (batch.status === "blocked" ? 1 : 0),
      reviewRequiredBatches: accumulator.reviewRequiredBatches + (batch.status === "review_required" ? 1 : 0)
    }),
    { recordsToCreate: 0, recordsToUpdate: 0, recordsToLink: 0, recordsToSkip: 0, blockedBatches: 0, reviewRequiredBatches: 0 }
  );

  return {
    projectId: input.projectId,
    dryRunRequired: true,
    confirmationRequiredBeforeApply: true,
    canApply: input.confirmationProvided === true && summary.blockedBatches === 0 && summary.reviewRequiredBatches === 0,
    batches,
    summary,
    importApplicationOrder: ONBOARDING_IMPORT_APPLICATION_ORDER,
    accountingRule: LIVE_ACCOUNTING_IMPORT_RULE
  };
}

export function assertMigrationCanApply(input: {
  dryRunCompleted: boolean;
  confirmationProvided: boolean;
  blockingIssues: OnboardingDataQualityIssue[];
  pendingReviewCount: number;
}) {
  if (!input.dryRunCompleted) {
    throw new Error("Migration cannot be applied before a completed dry-run.");
  }
  if (!input.confirmationProvided) {
    throw new Error("Migration apply requires explicit human confirmation.");
  }
  if (input.blockingIssues.some((issue) => issue.severity === "blocking")) {
    throw new Error("Migration apply is blocked by unresolved data quality issues.");
  }
  if (input.pendingReviewCount > 0) {
    throw new Error("Migration apply is blocked while mapping suggestions require human review.");
  }
}

export function isRollbackAllowed(input: { batchLockedByLiveActivity: boolean; batchType: OnboardingMigrationBatchType }) {
  if (input.batchLockedByLiveActivity) {
    return {
      allowed: false,
      reason: "This batch is already used by live operations and cannot be deleted automatically."
    };
  }

  if (input.batchType === "reservations" || input.batchType === "revenue_history") {
    return {
      allowed: false,
      reason: "Reservation and revenue history rollback requires manual review and audit evidence."
    };
  }

  return { allowed: true, reason: "Rollback can be prepared for human confirmation." };
}
