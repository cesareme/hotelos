export const AI_ONBOARDING_AGENT_NAMES = [
  "OnboardingOrchestratorAgent",
  "SourceSystemAgent",
  "DocumentClassifierAgent",
  "SpreadsheetParserAgent",
  "PropertyMapperAgent",
  "RatePlanMapperAgent",
  "ReservationImportAgent",
  "GuestImportAgent",
  "ChannelMappingAgent",
  "RevenueHistoryAgent",
  "ComplianceSetupAgent",
  "DataQualityAgent",
  "GoLiveReadinessAgent",
  "HumanReviewAgent"
] as const;

export type AiOnboardingAgentName = (typeof AI_ONBOARDING_AGENT_NAMES)[number];

export type AiOnboardingAgentDefinition = {
  name: AiOnboardingAgentName;
  responsibility: string;
  canApplyMigration: false;
  requiresHumanReview: true;
  writesDatabaseDirectly: false;
};

export const AI_ONBOARDING_AGENTS: AiOnboardingAgentDefinition[] = [
  { name: "OnboardingOrchestratorAgent", responsibility: "Coordinates source connection, extraction, mapping, review, dry-run and readiness steps.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "SourceSystemAgent", responsibility: "Pulls data from old PMS APIs through typed source connectors.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "DocumentClassifierAgent", responsibility: "Classifies uploads as room lists, rate sheets, reservation exports, revenue reports, channel mappings or floor plans.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "SpreadsheetParserAgent", responsibility: "Parses CSV/XLSX files and detects columns before semantic mapping.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "PropertyMapperAgent", responsibility: "Suggests buildings, floors, zones, rooms, spaces and inventory resources.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "RatePlanMapperAgent", responsibility: "Maps source rate plans to HotelOS rates, restrictions and derivations.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "ReservationImportAgent", responsibility: "Maps future reservations, dates, resources, deposits and balances.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "GuestImportAgent", responsibility: "Maps guest profiles and flags probable duplicates and sensitive fields.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "ChannelMappingAgent", responsibility: "Maps room and rate codes to channel manager mappings and detects missing ARI links.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "RevenueHistoryAgent", responsibility: "Converts old PMS History & Forecast reports into revenue snapshot suggestions.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "ComplianceSetupAgent", responsibility: "Suggests Spain guest register, SES.HOSPEDAJES and retention readiness settings.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "DataQualityAgent", responsibility: "Finds blocking, warning and info issues before dry-run or go-live.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "GoLiveReadinessAgent", responsibility: "Builds readiness score and blocks go-live on unresolved blocking issues.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false },
  { name: "HumanReviewAgent", responsibility: "Creates review queues and prevents risky changes until approved.", canApplyMigration: false, requiresHumanReview: true, writesDatabaseDirectly: false }
];
