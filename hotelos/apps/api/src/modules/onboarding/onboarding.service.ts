import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { BRAND } from "../../lib/brand.js";
import { requirePermissions } from "../auth/auth.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { demoStore, type UserContext } from "../../lib/demo-store.js";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { normalizeTaxId, spanishTaxIdValidationMessage } from "@hotelos/compliance";
import { PROPERTY_KINDS, type PermissionKey, type PropertyKind } from "@hotelos/shared";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { ensurePropertyTaxes } from "../../lib/tenant-hydration.js";
import { invalidateTaxCache } from "../accounting/tax-rate.service.js";
import { approveGoLive as approvePropertyGoLive, resolveFiscalLocation } from "../backoffice/backoffice.service.js";
// Tanda L5 (lote A): la importación de habitaciones escribe housekeeping / maintenance
// explícitos con el vocabulario cerrado del estado unificado.
import { isHousekeepingStatus, isMaintenanceStatus, normalizeHousekeepingInput } from "../housekeeping/room-state.service.js";
// Tanda 6b (fix t6b#7): the go-live materialises the implicit sociedad and a
// coded work centre exactly like bootstrap / createTenant (design §5.1 R10, §5.4).
import { codeInUse, createImplicitLegalEntity, ensureDefaultLegalEntity, planPropertyCode } from "../structure/legal-entity.service.js";
import {
  buildHistoryForecastImportPreview,
  buildHumanReviewQueue,
  createFloorPlanMappingReview,
  generateCutoverAssistantPlan,
  generateCutoverDeltaImportDryRun,
  generateMigrationDryRun,
  inspectOnboardingPayloadForSensitiveData,
  isRollbackAllowed,
  maskOnboardingPreview,
  parseRoomWalkTranscript,
  runOnboardingDataQualityChecks,
  type OnboardingDataQualityInput
} from "@hotelos/onboarding";
import type { ExtractedEntity, MappingSuggestion } from "@hotelos/ai-tools";
import { classifyDocumentDualMode, extractEntitiesDualMode } from "./ai-engine/extraction-engine.js";
import { generateMappingsDualMode } from "./ai-engine/mapping-engine.js";

// Cap how much raw uploaded text we retain on the file metadata so a parsed
// file always has something to extract from without unbounded memory growth.
const MAX_STORED_CONTENT_BYTES = 1_000_000;

type ProjectStatus =
  | "draft"
  | "collecting_data"
  | "extracting"
  | "mapping"
  | "review_required"
  | "dry_run_ready"
  | "dry_run_completed"
  | "applying"
  | "applied"
  | "completed"
  | "failed"
  | "cancelled";

type DemoOnboardingProject = {
  id: string;
  organizationId: string;
  propertyId?: string;
  name: string;
  sourceSystem: string;
  status: ProjectStatus;
  targetGoLiveDate: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  progress: number;
  confidence: number;
  blockingIssues: number;
};

type DemoOnboardingFile = {
  id: string;
  onboardingProjectId: string;
  fileName: string;
  fileType: string;
  objectKey: string;
  detectedDocumentType: string;
  status: string;
  extractionStatus: string;
  confidence: number;
  metadataJson: Record<string, unknown>;
  createdAt: string;
};

type DemoSourceConnection = {
  id: string;
  onboardingProjectId: string;
  providerCode: string;
  status: "pending" | "connected" | "error";
  credentialsSecretRef: unknown;
  configJson: Record<string, unknown>;
  lastTestedAt: string | null;
  lastSyncAt: string | null;
  errorMessage: string | null;
  createdAt: string;
};

type DemoExtractedEntity = {
  id: string;
  onboardingProjectId: string;
  onboardingFileId?: string;
  sourceType: string;
  entityType: string;
  sourceIdentifier: string;
  rawJson: Record<string, unknown>;
  normalizedJson: Record<string, unknown>;
  confidence: number;
  status: string;
  createdAt: string;
};

type DemoMappingSuggestion = {
  id: string;
  onboardingProjectId: string;
  sourceEntityId?: string;
  targetEntityType: string;
  suggestedTargetJson: Record<string, unknown>;
  confidence: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  reasonJson: string[];
  warningsJson: string[];
  missingDataJson: string[];
  status: "pending" | "approved" | "rejected" | "edited" | "applied";
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
};

type DemoMigrationBatch = {
  id: string;
  onboardingProjectId: string;
  batchType: string;
  status: "draft" | "dry_run_completed" | "applied" | "failed" | "rolled_back";
  dryRunResultJson: Record<string, unknown>;
  appliedResultJson: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  appliedAt?: string;
};

const demoProjectId = "onb_demo_project";
const demoFileId = "onb_file_revenue_history";
const demoEntityId = "onb_entity_room_432";
const demoSuggestionId = "onb_suggestion_room_432";
const demoBatchId = "onb_batch_rooms";

const demoProjects: DemoOnboardingProject[] = [
  {
    id: demoProjectId,
    organizationId: "org_123",
    propertyId: "prop_123",
    name: "Proyecto de onboarding de demo",
    sourceSystem: "generic_csv",
    status: "review_required",
    targetGoLiveDate: "2026-06-01",
    createdBy: "usr_123",
    createdAt: "2026-05-17T08:00:00.000Z",
    updatedAt: "2026-05-17T10:30:00.000Z",
    progress: 62,
    confidence: 0.84,
    blockingIssues: 2
  }
];

const demoSourceConnections: DemoSourceConnection[] = [
  {
    id: "onb_conn_generic_csv",
    onboardingProjectId: demoProjectId,
    providerCode: "generic_csv",
    status: "connected",
    credentialsSecretRef: "secret://onboarding/demo/generic-csv",
    configJson: { importMode: "uploaded_exports", dryRunRequired: true },
    lastTestedAt: "2026-05-17T09:00:00.000Z",
    lastSyncAt: "2026-05-17T09:12:00.000Z",
    errorMessage: null,
    createdAt: "2026-05-17T08:10:00.000Z"
  }
];

const demoFiles: DemoOnboardingFile[] = [
  {
    id: demoFileId,
    onboardingProjectId: demoProjectId,
    fileName: "history_forecast_may_2026.xlsx",
    fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    objectKey: "onboarding/demo/history_forecast_may_2026.xlsx",
    detectedDocumentType: "revenue_history_forecast_report",
    status: "classified",
    extractionStatus: "completed",
    confidence: 0.91,
    metadataJson: {
      sectionsDetected: ["History", "History subtotal", "Forecast", "Forecast subtotal", "Total"],
      rawFileRetentionDays: 30,
      encrypted: true
    },
    createdAt: "2026-05-17T08:30:00.000Z"
  },
  {
    id: "onb_file_room_list",
    onboardingProjectId: demoProjectId,
    fileName: "room_list.csv",
    fileType: "text/csv",
    objectKey: "onboarding/demo/room_list.csv",
    detectedDocumentType: "room_list",
    status: "classified",
    extractionStatus: "completed",
    confidence: 0.88,
    metadataJson: { rooms: 70, floors: 4, encrypted: true },
    createdAt: "2026-05-17T08:20:00.000Z"
  }
];

const demoExtractedEntities: DemoExtractedEntity[] = [
  {
    id: demoEntityId,
    onboardingProjectId: demoProjectId,
    onboardingFileId: "onb_file_room_list",
    sourceType: "file_upload",
    entityType: "room",
    sourceIdentifier: "room_list.csv#432",
    rawJson: { roomNumber: "432", floor: "4", type: "Double Standard", zone: "East Wing" },
    normalizedJson: { number: "432", floorCode: "4", roomTypeCode: "DBL_STD", zoneName: "East Wing", resourceType: "room" },
    confidence: 0.93,
    status: "extracted",
    createdAt: "2026-05-17T08:45:00.000Z"
  },
  {
    id: "onb_entity_revenue_2026_05_17",
    onboardingProjectId: demoProjectId,
    onboardingFileId: demoFileId,
    sourceType: "file_upload",
    entityType: "revenue_snapshot",
    sourceIdentifier: "history_forecast_may_2026.xlsx#2026-05-17",
    rawJson: { totalOcc: 52, arrivals: 18, totalRevenue: 10582, averageRate: 142.5, oooRooms: 2 },
    normalizedJson: { snapshotDate: "2026-05-17", totalOcc: 52, arrivalRooms: 18, totalRevenue: 10582, adr: 142.5, oooRooms: 2 },
    confidence: 0.87,
    status: "extracted",
    createdAt: "2026-05-17T08:55:00.000Z"
  }
];

const demoMappingSuggestions: DemoMappingSuggestion[] = [
  {
    id: demoSuggestionId,
    onboardingProjectId: demoProjectId,
    sourceEntityId: demoEntityId,
    targetEntityType: "inventory_resource",
    suggestedTargetJson: {
      name: "Room 432",
      resourceType: "room",
      roomType: "Double Standard",
      floor: "4",
      zone: "East Wing",
      bookable: true,
      sellable: true
    },
    confidence: 0.93,
    riskLevel: "low",
    reasonJson: [`Room number and room type matched existing ${BRAND.name} naming rules.`, "Floor and zone were explicit in source file."],
    warningsJson: [],
    missingDataJson: [],
    status: "pending",
    createdAt: "2026-05-17T09:10:00.000Z"
  },
  {
    id: "onb_suggestion_revenue_snapshot",
    onboardingProjectId: demoProjectId,
    sourceEntityId: "onb_entity_revenue_2026_05_17",
    targetEntityType: "revenue_daily_snapshot",
    suggestedTargetJson: {
      snapshotDate: "2026-05-17",
      totalOcc: 52,
      arrivalRooms: 18,
      totalRevenue: 10582,
      adr: 142.5,
      dataSource: "migration_import"
    },
    confidence: 0.87,
    riskLevel: "medium",
    reasonJson: ["History section and daily row were detected.", "Totals need human review before analytics import."],
    warningsJson: ["Report total validation is pending."],
    missingDataJson: ["channelId", "segment"],
    status: "pending",
    createdAt: "2026-05-17T09:15:00.000Z"
  }
];

// Sprint 52 — real engine output, stored in the CONTRACT shape that the
// Sprint 53 UI consumes. Keyed alongside the legacy demo stores so the
// human-review queue / project summaries (which read the Demo* shape) keep
// working while the list endpoints can return real engine entities.
type EngineExtractedEntityRecord = ExtractedEntity & {
  onboardingProjectId: string;
  onboardingFileId?: string;
};
type EngineMappingSuggestionRecord = Omit<MappingSuggestion, "status"> & {
  onboardingProjectId: string;
  // Widened beyond the generation-time "pending" so review decisions persist.
  status: "pending" | "approved" | "rejected" | "edited";
};

const engineExtractedEntities: EngineExtractedEntityRecord[] = [];
const engineMappingSuggestions: EngineMappingSuggestionRecord[] = [];

// Adapt a legacy seed entity (Demo* shape) into the engine CONTRACT shape so
// existing demo data still appears via the contract-stable list endpoints.
function demoEntityToContract(entity: DemoExtractedEntity): ExtractedEntity {
  return {
    id: entity.id,
    entityType: entity.entityType,
    sourceRef: entity.sourceIdentifier,
    confidence: entity.confidence,
    fields: { ...entity.rawJson, ...entity.normalizedJson },
    warnings: []
  };
}

function demoSuggestionToContract(suggestion: DemoMappingSuggestion): MappingSuggestion {
  const target = suggestion.suggestedTargetJson as Record<string, unknown>;
  const mappingType: MappingSuggestion["mappingType"] =
    suggestion.targetEntityType === "inventory_resource"
      ? "room_type"
      : suggestion.targetEntityType === "revenue_daily_snapshot"
        ? "reservation_field"
        : "rate_plan";
  return {
    id: suggestion.id,
    mappingType,
    sourceValue: String(target.roomType ?? target.name ?? suggestion.sourceEntityId ?? ""),
    targetValue: String(target.name ?? target.roomType ?? ""),
    confidence: suggestion.confidence,
    status: "pending",
    rationale: (suggestion.reasonJson ?? []).join(" ")
  };
}

// Mirror an engine suggestion into the legacy Demo* store so the human-review
// queue and project mapping summary stay consistent with what was generated.
function engineSuggestionToDemo(
  suggestion: EngineMappingSuggestionRecord
): DemoMappingSuggestion {
  return {
    id: suggestion.id,
    onboardingProjectId: suggestion.onboardingProjectId,
    targetEntityType:
      suggestion.mappingType === "room_type"
        ? "inventory_resource"
        : suggestion.mappingType === "channel"
          ? "channel_mapping"
          : suggestion.mappingType === "rate_plan"
            ? "rate_plan"
            : "reservation",
    suggestedTargetJson: { sourceValue: suggestion.sourceValue, targetValue: suggestion.targetValue },
    confidence: suggestion.confidence,
    riskLevel: suggestion.confidence < 0.5 ? "high" : suggestion.confidence < 0.8 ? "medium" : "low",
    reasonJson: [suggestion.rationale],
    warningsJson: suggestion.targetValue ? [] : ["No catalog match; needs human mapping."],
    missingDataJson: suggestion.targetValue ? [] : ["targetValue"],
    status: "pending",
    createdAt: nowIso()
  };
}

const demoMigrationBatches: DemoMigrationBatch[] = [
  {
    id: demoBatchId,
    onboardingProjectId: demoProjectId,
    batchType: "rooms",
    status: "dry_run_completed",
    dryRunResultJson: {
      willCreate: { properties: 0, buildings: 1, floors: 4, rooms: 70, inventoryResources: 73 },
      willUpdate: { roomTypes: 4 },
      willSkip: { duplicates: 0 },
      warnings: ["2 rooms are marked out of order and require maintenance confirmation."]
    },
    appliedResultJson: {},
    createdAt: "2026-05-17T10:05:00.000Z"
  }
];

const goLiveReadiness = {
  projectId: demoProjectId,
  readinessScore: 78,
  status: "blocked",
  blockingIssues: [
    { code: "missing_ses_hospedajes_configuration", severity: "blocking", detail: "SES.HOSPEDAJES credentials and authority routing must be configured." },
    { code: "history_forecast_totals_unverified", severity: "blocking", detail: "Imported revenue report totals need human validation before analytics import." }
  ],
  warnings: [
    { code: "guest_email_missing", severity: "warning", detail: "14 future reservations are missing guest email." },
    { code: "duplicate_guest_probable", severity: "warning", detail: "3 guest profiles look like duplicates." }
  ],
  checklist: [
    { stage: "T-14 days", item: "Test import completed", status: "completed" },
    { stage: "T-7 days", item: "Staff review and training", status: "in_progress" },
    { stage: "T-1 day", item: "Freeze source PMS configuration", status: "pending" },
    { stage: "Go-live day", item: "Import delta and validate arrivals/balances/channels", status: "pending" }
  ]
};

const demoDataQualityInput: OnboardingDataQualityInput = {
  roomsWithoutRoomType: 0,
  duplicateRoomNumbers: 0,
  ratePlansWithoutRateDays: 2,
  futureReservationsWithoutGuest: 0,
  channelMappingsMissing: 0,
  probableDuplicateGuests: 3,
  missingLegalPropertyProfile: false,
  missingInvoiceSequence: false,
  missingSesHospedajesConfiguration: true,
  missingPaymentProvider: false,
  revenueReportDateGaps: 0,
  forecastDataMissing: false,
  historyForecastTotalsMismatch: true
};

function getDemoDataQuality() {
  return runOnboardingDataQualityChecks(demoDataQualityInput);
}

function getApprovedSuggestionCounts() {
  return {
    property_blueprint: 1,
    compliance_settings: 1,
    rooms: 70,
    spaces: 3,
    inventory_resources: 73,
    rates: 93,
    restrictions: 31,
    channels: 3,
    channel_mappings: 21,
    guests: 408,
    companies: 12,
    reservations: 426,
    revenue_history: 31,
    users_roles: 8
  };
}

function getPendingSuggestionCounts() {
  return {
    revenue_history: 1,
    guests: 3,
    rates: 2
  };
}

function canViewSensitive(context: UserContext) {
  return context.permissions.includes("onboarding.view_sensitive");
}

function audit(context: UserContext, action: string, entityType: string, entityId: string, afterJson?: unknown) {
  recordAuditEvent({
    organizationId: context.organizationId,
    propertyId: context.propertyId,
    actorUserId: context.userId,
    actorType: "user",
    action,
    entityType,
    entityId,
    afterJson,
    correlationId: createId("corr")
  });
  recordDomainEvent({
    organizationId: context.organizationId,
    propertyId: context.propertyId,
    entityType,
    entityId,
    eventType: action,
    payload: { action, afterJson },
    actorType: "user",
    actorUserId: context.userId,
    correlationId: createId("corr")
  });
}

function requireProject(projectId: string) {
  const project = demoProjects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(`Onboarding project not found: ${projectId}`);
  }
  return project;
}

export function listOnboardingProjects(context: UserContext) {
  requirePermissions(context, ["onboarding.read"]);
  return {
    items: demoProjects,
    summary: {
      visibleEntry: "AI Setup Wizard",
      dryRunMandatory: true,
      humanReviewMandatory: true,
      aiCannotApplyMigration: true
    }
  };
}

export function createOnboardingProject(input: { context: UserContext; payload: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.create"]);
  const project: DemoOnboardingProject = {
    id: createId("onb"),
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    name: String(input.payload.name ?? "New AI onboarding project"),
    sourceSystem: String(input.payload.sourceSystem ?? "manual"),
    status: "draft",
    targetGoLiveDate: String(input.payload.targetGoLiveDate ?? "2026-06-01"),
    createdBy: input.context.userId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    progress: 0,
    confidence: 0,
    blockingIssues: 0
  };
  demoProjects.push(project);
  audit(input.context, "OnboardingProjectCreated", "onboarding_project", project.id, project);
  return project;
}

export function getOnboardingProject(input: { context: UserContext; projectId: string }) {
  requirePermissions(input.context, ["onboarding.read"]);
  const project = requireProject(input.projectId);
  return {
    ...project,
    sourceConnections: demoSourceConnections.filter((connection) => connection.onboardingProjectId === project.id),
    files: demoFiles.filter((file) => file.onboardingProjectId === project.id),
    mappingSummary: {
      pending: demoMappingSuggestions.filter((suggestion) => suggestion.onboardingProjectId === project.id && suggestion.status === "pending").length,
      approved: demoMappingSuggestions.filter((suggestion) => suggestion.onboardingProjectId === project.id && suggestion.status === "approved").length,
      lowConfidence: demoMappingSuggestions.filter((suggestion) => suggestion.onboardingProjectId === project.id && suggestion.confidence < 0.8).length
    },
    humanReviewQueue: buildHumanReviewQueue(demoMappingSuggestions.filter((suggestion) => suggestion.onboardingProjectId === project.id)),
    roomWalkPreview: parseRoomWalkTranscript(
      "Floor 2, east wing, rooms 201 to 216 are double standard. Rooms 217 and 218 are superior. 219 is storage. 220 is out of order."
    ),
    nextAction: "Review revenue report totals, approve room mappings, then run dry-run before applying."
  };
}

export function patchOnboardingProject(input: { context: UserContext; projectId: string; payload: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.create"]);
  const project = requireProject(input.projectId);
  Object.assign(project, input.payload, { updatedAt: nowIso() });
  audit(input.context, "OnboardingProjectCreated", "onboarding_project", project.id, project);
  return project;
}

export function createSourceConnection(input: { context: UserContext; projectId: string; payload: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.connect_source"]);
  requireProject(input.projectId);
  const connection: DemoSourceConnection = {
    id: createId("onb_conn"),
    onboardingProjectId: input.projectId,
    providerCode: String(input.payload.providerCode ?? "generic_csv"),
    status: "pending",
    credentialsSecretRef: input.payload.credentialsSecretRef ?? "secret://onboarding/pending",
    configJson: (input.payload.configJson as Record<string, unknown>) ?? {},
    lastTestedAt: null,
    lastSyncAt: null,
    errorMessage: null,
    createdAt: nowIso()
  };
  demoSourceConnections.push(connection);
  audit(input.context, "OnboardingSourceConnected", "onboarding_source_connection", connection.id, connection);
  return connection;
}

export function testSourceConnection(input: { context: UserContext; connectionId: string }) {
  requirePermissions(input.context, ["onboarding.connect_source"]);
  const connection = demoSourceConnections.find((candidate) => candidate.id === input.connectionId);
  if (!connection) throw new Error(`Onboarding source connection not found: ${input.connectionId}`);
  connection.status = "connected";
  connection.lastTestedAt = nowIso();
  audit(input.context, "OnboardingSourceConnectionTested", "onboarding_source_connection", connection.id, connection);
  return { connectionId: connection.id, status: "connected", providerCode: connection.providerCode, dryRunRequired: true };
}

export function syncSourceConnection(input: { context: UserContext; connectionId: string }) {
  requirePermissions(input.context, ["onboarding.connect_source"]);
  const connection = demoSourceConnections.find((candidate) => candidate.id === input.connectionId);
  if (!connection) throw new Error(`Onboarding source connection not found: ${input.connectionId}`);
  connection.lastSyncAt = nowIso();
  audit(input.context, "OnboardingSourceConnected", "onboarding_source_connection", connection.id, connection);
  return { connectionId: connection.id, status: "sync_completed", pulledEntities: { rooms: 70, ratePlans: 3, reservations: 426, guests: 408 } };
}

export function uploadOnboardingFile(input: { context: UserContext; projectId: string; payload: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.upload"]);
  requireProject(input.projectId);
  const payloadSafety = inspectOnboardingPayloadForSensitiveData(input.payload);
  if (!payloadSafety.allowed) {
    audit(input.context, "OnboardingFileUploaded", "onboarding_file", "blocked_sensitive_upload", { blocked: true, issues: payloadSafety.issues });
    return {
      status: "blocked",
      reason: "Upload payload contains sensitive data that cannot be imported.",
      issues: payloadSafety.issues
    };
  }
  // Retain the raw uploaded text so extraction has something real to parse.
  // Cap the stored size to keep the in-memory demo store bounded.
  const rawContent = typeof input.payload.content === "string" ? input.payload.content : undefined;
  const storedContent =
    rawContent !== undefined ? rawContent.slice(0, MAX_STORED_CONTENT_BYTES) : undefined;
  const contentTruncated = rawContent !== undefined && rawContent.length > MAX_STORED_CONTENT_BYTES;

  const file: DemoOnboardingFile = {
    id: createId("onb_file"),
    onboardingProjectId: input.projectId,
    fileName: String(input.payload.fileName ?? "uploaded-export.csv"),
    fileType: String(input.payload.fileType ?? "text/csv"),
    objectKey: String(input.payload.objectKey ?? `onboarding/${input.projectId}/uploaded-export.csv`),
    detectedDocumentType: "pending_classification",
    status: "uploaded",
    extractionStatus: "not_started",
    confidence: 0,
    metadataJson: {
      encrypted: true,
      rawFileRetentionDays: 30,
      aiWillNotApplyWithoutApproval: true,
      ...(storedContent !== undefined ? { content: storedContent, contentBytes: storedContent.length, contentTruncated } : {})
    },
    createdAt: nowIso()
  };
  demoFiles.push(file);
  audit(input.context, "OnboardingFileUploaded", "onboarding_file", file.id, file);
  return file;
}

export function listOnboardingFiles(input: { context: UserContext; projectId: string }) {
  requirePermissions(input.context, ["onboarding.read"]);
  requireProject(input.projectId);
  return { items: demoFiles.filter((file) => file.onboardingProjectId === input.projectId) };
}

export async function classifyOnboardingFileApi(input: { context: UserContext; fileId: string }) {
  requirePermissions(input.context, ["onboarding.ai_extract"]);
  const file = demoFiles.find((candidate) => candidate.id === input.fileId);
  if (!file) throw new Error(`Onboarding file not found: ${input.fileId}`);
  const content = typeof file.metadataJson.content === "string" ? file.metadataJson.content : "";
  const classification = await classifyDocumentDualMode({
    fileName: file.fileName,
    fileType: file.fileType,
    content
  });
  file.detectedDocumentType = classification.detectedDocumentType;
  file.status = "classified";
  file.confidence = classification.confidence;
  file.metadataJson = {
    ...file.metadataJson,
    classificationSignals: classification.signals,
    classificationWarnings: classification.warnings
  };
  audit(input.context, "OnboardingFileClassified", "onboarding_file", file.id, file);
  return file;
}

export async function extractOnboardingFileApi(input: { context: UserContext; fileId: string }) {
  requirePermissions(input.context, ["onboarding.ai_extract"]);
  const file = demoFiles.find((candidate) => candidate.id === input.fileId);
  if (!file) throw new Error(`Onboarding file not found: ${input.fileId}`);
  file.extractionStatus = "completed";

  // Real extraction: parse the stored raw content into typed entities and
  // persist them (replacing any prior extraction for this file).
  const content = typeof file.metadataJson.content === "string" ? file.metadataJson.content : "";
  const extraction = await extractEntitiesDualMode({
    fileName: file.fileName,
    fileType: file.fileType,
    content,
    detectedDocumentType: file.detectedDocumentType
  });
  // Drop previous engine entities for this file, then persist the fresh set.
  for (let i = engineExtractedEntities.length - 1; i >= 0; i -= 1) {
    if (engineExtractedEntities[i]!.onboardingFileId === file.id) {
      engineExtractedEntities.splice(i, 1);
    }
  }
  for (const entity of extraction.entities) {
    engineExtractedEntities.push({
      ...entity,
      onboardingProjectId: file.onboardingProjectId,
      onboardingFileId: file.id
    });
  }

  audit(input.context, "OnboardingFileExtracted", "onboarding_file", file.id, {
    fileId: file.id,
    summary: extraction.summary
  });
  const historyForecastPreview =
    file.detectedDocumentType === "revenue_history_forecast_report"
      ? buildHistoryForecastImportPreview({
          fromDate: "2026-05-01",
          toDate: "2026-05-31",
          filters: { roomClass: "all", roomType: "all", includeHouseUse: true },
          columns: [
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
          ],
          rows: [
            {
              section: "history",
              date: "2026-05-17",
              totalOcc: 52,
              arrivalRooms: 18,
              compRooms: 1,
              houseUseRooms: 1,
              deductIndividualRooms: 40,
              nonDeductIndividualRooms: 4,
              deductGroupRooms: 8,
              nonDeductGroupRooms: 0,
              occupancyPercent: 82.54,
              totalRevenue: 10582,
              averageRate: 142.5,
              departureRooms: 16,
              dayUseRooms: 1,
              noShowRooms: 0,
              oooRooms: 2,
              adultsChildren: 96
            }
          ],
          reportedRevenueTotal: 10582,
          sectionsDetected: ["History", "History subtotal", "Forecast", "Forecast subtotal", "Total"]
        })
      : undefined;
  const floorPlanPreview =
    file.detectedDocumentType === "floor_plan" || file.fileName.includes("floor")
      ? createFloorPlanMappingReview({
          fileName: file.fileName,
          detectedText: "Floor 2 rooms 201 202 203 204 meeting room storage emergency exit",
          detectedRoomLabels: ["201", "202", "203", "204"],
          detectedSpaceLabels: ["meeting room", "storage"]
        })
      : undefined;

  const extractedEntities: ExtractedEntity[] = engineExtractedEntities
    .filter((entity) => entity.onboardingFileId === file.id)
    .map(({ onboardingProjectId: _projectId, onboardingFileId: _fileId, ...entity }) =>
      maskOnboardingPreview(entity, canViewSensitive(input.context))
    );

  return {
    file,
    extractedEntities,
    summary: extraction.summary,
    historyForecastPreview,
    floorPlanPreview,
    rules: {
      aiCannotInventMissingValues: true,
      lowConfidenceRequiresHumanReview: true,
      rawPaymentCardsRejected: true
    }
  };
}

export async function analyzeOnboardingProject(input: { context: UserContext; projectId: string; mode: "analyze" | "generate_blueprint" | "generate_mappings" | "data_quality" }) {
  const requiredPermission: PermissionKey =
    input.mode === "data_quality" ? "onboarding.review" : input.mode === "generate_blueprint" || input.mode === "generate_mappings" ? "onboarding.ai_map" : "onboarding.ai_extract";
  requirePermissions(input.context, [requiredPermission]);
  const project = requireProject(input.projectId);
  project.status = input.mode === "data_quality" ? "review_required" : "mapping";
  project.updatedAt = nowIso();

  // Real mapping generation: gather the project's extracted entities, run the
  // mapping engine, persist suggestions (contract shape + Demo* mirror for the
  // review queue), and return the contract { suggestions, summary }.
  if (input.mode === "generate_mappings") {
    const projectEntities: ExtractedEntity[] = engineExtractedEntities
      .filter((entity) => entity.onboardingProjectId === project.id)
      .map(({ onboardingProjectId: _projectId, onboardingFileId: _fileId, ...entity }) => entity);
    const { suggestions, summary } = await generateMappingsDualMode({ entities: projectEntities, target: "auto" });

    // Replace prior engine suggestions for this project.
    for (let i = engineMappingSuggestions.length - 1; i >= 0; i -= 1) {
      if (engineMappingSuggestions[i]!.onboardingProjectId === project.id) {
        engineMappingSuggestions.splice(i, 1);
      }
    }
    // Drop the legacy Demo* mirrors we previously generated for this project,
    // but keep any human-reviewed or seed suggestions intact.
    for (let i = demoMappingSuggestions.length - 1; i >= 0; i -= 1) {
      const candidate = demoMappingSuggestions[i]!;
      if (candidate.onboardingProjectId === project.id && candidate.id.startsWith("map_") && candidate.status === "pending") {
        demoMappingSuggestions.splice(i, 1);
      }
    }
    for (const suggestion of suggestions) {
      const record: EngineMappingSuggestionRecord = { ...suggestion, onboardingProjectId: project.id };
      engineMappingSuggestions.push(record);
      demoMappingSuggestions.push(engineSuggestionToDemo(record));
    }

    const masked = maskOnboardingPreview(suggestions, canViewSensitive(input.context));
    audit(input.context, "OnboardingMappingSuggested", "onboarding_project", project.id, { summary });
    return { suggestions: masked, summary, projectId: project.id, mode: input.mode };
  }

  // `generate_mappings` is handled by the early return above.
  const actionByMode = {
    analyze: "OnboardingAIAnalysisCompleted",
    generate_blueprint: "OnboardingBlueprintGenerated",
    data_quality: "OnboardingAIAnalysisCompleted"
  } satisfies Record<typeof input.mode, string>;
  const dataQuality = getDemoDataQuality();
  const output = {
    projectId: project.id,
    mode: input.mode,
    confidence: 0.84,
    missingData: ["SES.HOSPEDAJES credentials", "2 room type cancellation policies"],
    warnings: ["AI suggestions are pending review.", "Dry-run is mandatory before apply."],
    dataQuality,
    roomWalkPreview: parseRoomWalkTranscript(
      "Floor 2, east wing, rooms 201 to 216 are double standard. Rooms 217 and 218 are superior. 219 is storage. 220 is out of order."
    ),
    propertyBlueprint: {
      organization: demoStore.organization.name,
      property: demoStore.property.name,
      buildings: 1,
      floors: 4,
      rooms: 70,
      spaces: ["restaurant", "parking", "meeting room", "rooftop"],
      inventoryResources: 73
    }
  };
  audit(input.context, actionByMode[input.mode], "onboarding_project", project.id, output);
  return output;
}

export function parseRoomWalkSetup(input: { context: UserContext; projectId: string; payload?: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.ai_map"]);
  requireProject(input.projectId);
  const transcript = String(
    input.payload?.transcript ??
      "Floor 2, east wing, rooms 201 to 216 are double standard. Rooms 217 and 218 are superior. 219 is storage. 220 is out of order."
  );
  const preview = parseRoomWalkTranscript(transcript);
  audit(input.context, "OnboardingBlueprintGenerated", "onboarding_project", input.projectId, preview);
  return preview;
}

export function mapFloorPlanFile(input: { context: UserContext; fileId: string; payload?: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.ai_map"]);
  const file = demoFiles.find((candidate) => candidate.id === input.fileId);
  if (!file) throw new Error(`Onboarding file not found: ${input.fileId}`);
  const preview = createFloorPlanMappingReview({
    fileName: file.fileName,
    detectedText: String(input.payload?.detectedText ?? "Floor 2 rooms 201 202 203 204 meeting room storage emergency exit"),
    detectedRoomLabels: Array.isArray(input.payload?.detectedRoomLabels) ? (input.payload.detectedRoomLabels as string[]) : undefined,
    detectedSpaceLabels: Array.isArray(input.payload?.detectedSpaceLabels) ? (input.payload.detectedSpaceLabels as string[]) : undefined
  });
  audit(input.context, "OnboardingMappingSuggested", "onboarding_file", file.id, preview);
  return preview;
}

export function listExtractedEntities(input: { context: UserContext; projectId: string }) {
  requirePermissions(input.context, ["onboarding.read"]);
  requireProject(input.projectId);
  // Real engine entities for this project, plus any seed demo entities adapted
  // into the stable contract shape. Engine entities take precedence by id.
  const engineForProject = engineExtractedEntities
    .filter((entity) => entity.onboardingProjectId === input.projectId)
    .map(({ onboardingProjectId: _projectId, onboardingFileId: _fileId, ...entity }) => entity);
  const engineIds = new Set(engineForProject.map((entity) => entity.id));
  const seedForProject = demoExtractedEntities
    .filter((entity) => entity.onboardingProjectId === input.projectId)
    .map(demoEntityToContract)
    .filter((entity) => !engineIds.has(entity.id));
  const items: ExtractedEntity[] = [...engineForProject, ...seedForProject];
  return {
    items: maskOnboardingPreview(items, canViewSensitive(input.context)),
    piiMasked: !canViewSensitive(input.context)
  };
}

export function listMappingSuggestions(input: { context: UserContext; projectId: string }) {
  requirePermissions(input.context, ["onboarding.read"]);
  requireProject(input.projectId);
  const engineForProject = engineMappingSuggestions
    .filter((suggestion) => suggestion.onboardingProjectId === input.projectId)
    .map(({ onboardingProjectId: _projectId, ...suggestion }) => suggestion);
  const engineIds = new Set(engineForProject.map((suggestion) => suggestion.id));
  const seedForProject = demoMappingSuggestions
    .filter((suggestion) => suggestion.onboardingProjectId === input.projectId)
    .map(demoSuggestionToContract)
    .filter((suggestion) => !engineIds.has(suggestion.id));
  // Contract shape, but status may reflect a review decision (approved/rejected
  // /edited) after reviewMappingSuggestion has run.
  const items: Array<Omit<MappingSuggestion, "status"> & { status: MappingSuggestion["status"] | "approved" | "rejected" | "edited" }> = [
    ...engineForProject,
    ...seedForProject
  ];
  return {
    items: maskOnboardingPreview(items, canViewSensitive(input.context)),
    piiMasked: !canViewSensitive(input.context)
  };
}

export function getHumanReviewQueue(input: { context: UserContext; projectId: string }) {
  requirePermissions(input.context, ["onboarding.review"]);
  requireProject(input.projectId);
  const queue = buildHumanReviewQueue(demoMappingSuggestions.filter((suggestion) => suggestion.onboardingProjectId === input.projectId));
  audit(input.context, "SensitiveOnboardingDataViewed", "onboarding_project", input.projectId, {
    queueViewed: true,
    piiMasked: !canViewSensitive(input.context),
    pending: queue.summary.pending
  });
  return {
    ...queue,
    piiMasked: !canViewSensitive(input.context)
  };
}

export function reviewMappingSuggestion(input: {
  context: UserContext;
  suggestionId: string;
  decision: "approved" | "rejected" | "edited";
  payload?: Record<string, unknown>;
}) {
  requirePermissions(input.context, ["onboarding.review"]);
  // The suggestion may live in the legacy demo store, the engine store, or both
  // (engine-generated suggestions only exist in the engine store). Accept either.
  const suggestion = demoMappingSuggestions.find((candidate) => candidate.id === input.suggestionId);
  const engineRecord = engineMappingSuggestions.find((candidate) => candidate.id === input.suggestionId);
  if (!suggestion && !engineRecord) {
    throw new Error(`Onboarding mapping suggestion not found: ${input.suggestionId}`);
  }
  if (suggestion) {
    suggestion.status = input.decision;
    suggestion.reviewedBy = input.context.userId;
    suggestion.reviewedAt = nowIso();
    if (input.decision === "edited" && input.payload?.suggestedTargetJson) {
      suggestion.suggestedTargetJson = input.payload.suggestedTargetJson as Record<string, unknown>;
    }
  }
  // Keep the contract-shape engine record in sync so the list endpoint reflects
  // the review decision (and an edited targetValue, if provided).
  if (engineRecord) {
    engineRecord.status = input.decision;
    if (input.decision === "edited" && typeof input.payload?.targetValue === "string") {
      engineRecord.targetValue = input.payload.targetValue;
    }
  }
  const reviewed = suggestion ?? engineRecord;
  const auditAction =
    input.decision === "approved" ? "OnboardingMappingApproved" : input.decision === "rejected" ? "OnboardingMappingRejected" : "OnboardingMappingEdited";
  audit(input.context, auditAction, "onboarding_mapping_suggestion", (reviewed as { id: string }).id, reviewed as Record<string, unknown>);
  return reviewed;
}

export function runMigrationDryRun(input: { context: UserContext; projectId: string; payload?: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.apply"]);
  requireProject(input.projectId);
  // Each project owns its own dry-run batch. Create one on first dry-run instead
  // of mutating a shared/fallback batch (which would leave apply unable to find it).
  let batch = demoMigrationBatches.find((candidate) => candidate.onboardingProjectId === input.projectId);
  if (!batch) {
    batch = {
      id: createId("onb_batch"),
      onboardingProjectId: input.projectId,
      batchType: "full_migration",
      status: "draft",
      dryRunResultJson: {},
      appliedResultJson: {},
      createdAt: nowIso()
    };
    demoMigrationBatches.push(batch);
  }
  const dataQuality = getDemoDataQuality();
  const generatedDryRun = generateMigrationDryRun({
    projectId: input.projectId,
    approvedSuggestionCounts: getApprovedSuggestionCounts(),
    pendingSuggestionCounts: getPendingSuggestionCounts(),
    dataQualityIssues: dataQuality.issues,
    confirmationProvided: Boolean(input.payload?.confirmationProvided)
  });
  batch.status = "dry_run_completed";
  batch.dryRunResultJson = generatedDryRun as unknown as Record<string, unknown>;
  audit(input.context, "OnboardingDryRunCompleted", "onboarding_migration_batch", batch.id, batch);
  return generatedDryRun;
}

export function getDryRunResult(input: { context: UserContext; projectId: string }) {
  requirePermissions(input.context, ["onboarding.read"]);
  requireProject(input.projectId);
  return { items: demoMigrationBatches.filter((batch) => batch.onboardingProjectId === input.projectId) };
}

export async function applyMigration(input: { context: UserContext; projectId: string; payload?: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.apply"]);
  const project = requireProject(input.projectId);
  const hasDryRun = demoMigrationBatches.some((batch) => batch.onboardingProjectId === project.id && batch.status === "dry_run_completed");
  if (!hasDryRun) {
    throw new Error("Migration cannot be applied before a completed dry-run.");
  }
  const pendingReviewCount = engineMappingSuggestions.filter((s) => s.onboardingProjectId === project.id && s.status === "pending").length
    + demoMappingSuggestions.filter((suggestion) => suggestion.onboardingProjectId === project.id && suggestion.status === "pending").length;
  if (!input.payload?.confirmationProvided) {
    return {
      projectId: project.id,
      status: "confirmation_required",
      message: "Migration apply requires explicit human confirmation after dry-run review.",
      pendingReviewCount,
      aiAppliedWithoutApproval: false
    };
  }
  if (pendingReviewCount > 0) {
    return {
      projectId: project.id,
      status: "blocked",
      message: "Migration apply is blocked while mapping suggestions remain pending human review.",
      pendingReviewCount,
      aiAppliedWithoutApproval: false
    };
  }

  // Real Prisma persistence path: provide payload.targetProperty to materialise
  // the onboarding project into a live Property + RoomTypes + Rooms + spaces.
  const targetProperty = input.payload?.targetProperty as Record<string, unknown> | undefined;
  if (!targetProperty) {
    project.status = "applying";
    const result = {
      projectId: project.id,
      status: "approval_required",
      message: "Migration apply is prepared but requires a targetProperty payload to materialise live records.",
      aiAppliedWithoutApproval: false
    };
    audit(input.context, "OnboardingMigrationBatchApplied", "onboarding_project", project.id, result);
    return result;
  }

  const applied = await materialiseOnboardingProject(project.id, input.context, targetProperty, input.payload?.spaces as Array<Record<string, unknown>> | undefined);
  project.status = "applied";
  // Corrector L5 (L5F-04): el proyecto recuerda la propiedad materializada — el
  // go-live del onboarding delega en la aprobación real de esa propiedad.
  project.propertyId = applied.propertyId;
  audit(input.context, "OnboardingMigrationBatchApplied", "onboarding_project", project.id, applied);
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: applied.propertyId,
    eventType: "OnboardingMigrationApplied",
    entityType: "property",
    entityId: applied.propertyId,
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: createId("corr"),
    payload: { projectId: project.id, ...applied.counts }
  });
  return { projectId: project.id, status: "applied", aiAppliedWithoutApproval: false, ...applied };
}

// ---------------------------------------------------------------------------
// Go-live · sociedad + centro de trabajo (Tanda 6b · fix t6b#7)
// ---------------------------------------------------------------------------

/** Property columns the import fills; identity / structure columns are decided here, not by the payload. */
type OnboardingPropertyColumns = Omit<
  Prisma.PropertyUncheckedCreateInput,
  "id" | "organizationId" | "legalEntityId" | "kind" | "code" | "tradeName" | "legalName" | "status"
> & { name: string };

export type OnboardingStructureInput = {
  organizationId: string;
  organizationName: string;
  /** Razón social of the implicit sociedad when the organization is created here; an existing organization keeps its own. */
  organizationLegalName: string | null;
  /** Normalised, checksum-valid NIF (validated by the caller) or null («NIF pendiente»); ignored for an existing organization. */
  organizationTaxId: string | null;
  propertyId: string;
  kind: PropertyKind;
  /** Explicit Property.code or null → initials of the name without the brand tokens (planPropertyCode). */
  requestedCode: string | null;
  /** Nombre comercial of the centre (legacy `targetProperty.legalName`); stored only when it differs from the razón social. */
  tradeName: string | null;
  property: OnboardingPropertyColumns;
};

export type OnboardingStructureResult = {
  organizationId: string;
  organizationCreated: boolean;
  legalEntity: { id: string; code: string; legalName: string; taxId: string | null; created: boolean };
  property: { id: string; code: string; kind: PropertyKind; legalEntityId: string; created: boolean };
};

/**
 * Organization + implicit sociedad + coded work centre in ONE transaction, the
 * same shape bootstrap.service.ts and createTenant produce (design §5.1 R10):
 *   · a new organization is created with its name only — the deprecated
 *     Organization.legalName / taxId columns are never written (R2); the razón
 *     social and the NIF live in the LegalEntity (400 TAX_ID_INVALID / 409
 *     TAX_ID_IN_USE from createImplicitLegalEntity);
 *   · an existing organization keeps its sociedad and NIF; a tenant created
 *     before the backfill gets its implicit sociedad from the deprecated
 *     columns exactly as the backfill would (ensureDefaultLegalEntity);
 *   · the property is created with legalEntityId, kind and a code unique in the
 *     sociedad (409 CODE_IN_USE for an explicit clash); Property.legalName is
 *     never written — the payload's `legalName` is the hotel's trade name and
 *     lands in tradeName only when it differs from the razón social;
 *   · re-running for the same ids converges (no second sociedad, code kept,
 *     legalEntityId filled when it was null); a property id that belongs to
 *     another organization is an opaque 404 (never adopted or rewritten, R10.5).
 * Exported for the integration test (tests/integration/integrador-fix-t6b.test.mts).
 */
export async function materialiseOnboardingStructure(input: OnboardingStructureInput): Promise<OnboardingStructureResult> {
  return prisma.$transaction(async (tx) => {
    const existingOrganization = await tx.organization.findUnique({ where: { id: input.organizationId }, select: { id: true, name: true } });
    let legalEntity: Awaited<ReturnType<typeof createImplicitLegalEntity>>;
    let legalEntityCreated: boolean;
    if (!existingOrganization) {
      await tx.organization.create({ data: { id: input.organizationId, name: input.organizationName } });
      legalEntity = await createImplicitLegalEntity(tx, {
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        legalName: input.organizationLegalName,
        taxId: input.organizationTaxId
      });
      legalEntityCreated = true;
    } else {
      const ensured = await ensureDefaultLegalEntity(tx, existingOrganization.id);
      legalEntity = ensured.entity;
      legalEntityCreated = ensured.created;
    }
    const organizationName = existingOrganization?.name ?? input.organizationName;

    const existingProperty = await tx.property.findUnique({
      where: { id: input.propertyId },
      select: { id: true, organizationId: true, legalEntityId: true, code: true, kind: true }
    });
    if (existingProperty && existingProperty.organizationId !== input.organizationId) {
      throw new NotFoundError("Propiedad no encontrada.");
    }

    const siblings = await tx.property.findMany({ where: { legalEntityId: legalEntity.id, NOT: { id: input.propertyId } }, select: { code: true } });
    const taken = new Set(siblings.map((row) => row.code).filter((value): value is string => value !== null));
    let code = existingProperty?.code ?? null;
    if (!code) {
      code = planPropertyCode(input.property.name, { name: organizationName, legalName: legalEntity.legalName }, taken, input.requestedCode);
      if (taken.has(code)) throw codeInUse("property", code);
    }
    const tradeName = input.tradeName && input.tradeName !== legalEntity.legalName ? input.tradeName : null;
    const columns = { ...input.property, tradeName, status: "open" as const };
    // The timezone is fixed at creation (legacy contract of the import): a re-import never moves it.
    const { timezone: _createOnlyTimezone, ...updateColumns } = columns;
    const select = { id: true, code: true, kind: true, legalEntityId: true } as const;
    const row = existingProperty
      ? await tx.property.update({
          where: { id: input.propertyId },
          data: { ...updateColumns, legalEntityId: existingProperty.legalEntityId ?? legalEntity.id, code },
          select
        })
      : await tx.property.create({
          data: { id: input.propertyId, organizationId: input.organizationId, legalEntityId: legalEntity.id, kind: input.kind, code, ...columns },
          select
        });

    return {
      organizationId: input.organizationId,
      organizationCreated: !existingOrganization,
      legalEntity: { id: legalEntity.id, code: legalEntity.code, legalName: legalEntity.legalName, taxId: legalEntity.taxId ?? null, created: legalEntityCreated },
      property: { id: row.id, code: row.code ?? code, kind: row.kind, legalEntityId: row.legalEntityId ?? legalEntity.id, created: !existingProperty }
    };
  });
}

async function materialiseOnboardingProject(
  projectId: string,
  context: UserContext,
  targetProperty: Record<string, unknown>,
  spaces?: Array<Record<string, unknown>>
) {
  const organizationId = String(targetProperty.organizationId ?? context.organizationId);
  // Tanda 6b (R2): the NIF is the sociedad's (LegalEntity.taxId), never
  // Organization.taxId. Same rule as bootstrap / createTenant: a given value
  // must be a checksum-valid DNI / NIE / CIF (400 TAX_ID_INVALID otherwise) and
  // is stored normalised; an empty value leaves the NIF pending. Validated
  // before any write so a bad NIF leaves nothing half-materialised.
  const rawOrganizationTaxId = targetProperty.organizationTaxId ? String(targetProperty.organizationTaxId).trim() : "";
  const taxIdProblem = rawOrganizationTaxId ? spanishTaxIdValidationMessage(rawOrganizationTaxId) : null;
  if (taxIdProblem) {
    const error = new BadRequestError(`targetProperty.organizationTaxId no es un NIF/CIF válido («${rawOrganizationTaxId}»): ${taxIdProblem}`);
    error.details = { code: "TAX_ID_INVALID", taxId: rawOrganizationTaxId, reason: taxIdProblem };
    throw error;
  }
  const organizationTaxId = rawOrganizationTaxId ? normalizeTaxId(rawOrganizationTaxId) : null;
  const propertyId = String(targetProperty.id ?? `prop_${projectId}`);
  // Work-centre kind (hotel by default; office / other never get rooms, R6) and explicit code.
  const rawKind = targetProperty.kind === undefined || targetProperty.kind === null || targetProperty.kind === "" ? "hotel" : String(targetProperty.kind).trim().toLowerCase();
  if (!(PROPERTY_KINDS as readonly string[]).includes(rawKind)) {
    const error = new BadRequestError(`targetProperty.kind no válido («${rawKind}»): usa hotel, office u other.`);
    error.details = { code: "VALIDATION_ERROR", issues: [{ path: "targetProperty.kind", message: `valor no admitido: ${rawKind}` }] };
    throw error;
  }
  const propertyKind = rawKind as PropertyKind;
  const requestedCode = targetProperty.code ? String(targetProperty.code).trim() : null;
  const propertyTradeName = targetProperty.tradeName
    ? String(targetProperty.tradeName).trim()
    : targetProperty.legalName
      ? String(targetProperty.legalName).trim()
      : null;
  // Tanda 3: fiscal location validated BEFORE any write and merged non-destructively over
  // the existing property (an import that omits the region keeps / canonicalises the current
  // one, or derives it from the province); free-text regions are a 400, never persisted.
  const existingProperty = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { taxRegion: true, province: true, postalCode: true, ineMunicipalityCode: true, fiscalTerritory: true }
  });
  const province = targetProperty.province ? String(targetProperty.province).trim() : existingProperty?.province ?? null;
  const fiscal = resolveFiscalLocation({
    current: existingProperty ?? {},
    patch: {
      taxRegion: targetProperty.taxRegion ? String(targetProperty.taxRegion) : null,
      postalCode: targetProperty.postalCode ? String(targetProperty.postalCode) : null,
      ineMunicipalityCode: targetProperty.ineMunicipalityCode ? String(targetProperty.ineMunicipalityCode) : null,
      fiscalTerritory: targetProperty.fiscalTerritory ? String(targetProperty.fiscalTerritory) : null
    },
    province: province || null
  });
  // Organization (name only) + implicit sociedad + coded centre, one transaction
  // (fix t6b#7): an existing organization keeps its own sociedad and NIF.
  const structure = await materialiseOnboardingStructure({
    organizationId,
    organizationName: String(targetProperty.organizationName ?? "Grupo Hotelero Demo"),
    organizationLegalName: targetProperty.organizationLegalName ? String(targetProperty.organizationLegalName).trim() : null,
    organizationTaxId,
    propertyId,
    kind: propertyKind,
    requestedCode,
    tradeName: propertyTradeName,
    property: {
      name: String(targetProperty.name ?? "Imported property"),
      address: targetProperty.address ? String(targetProperty.address) : null,
      municipality: targetProperty.municipality ? String(targetProperty.municipality) : null,
      province: province || null,
      country: String(targetProperty.country ?? "ES"),
      taxRegion: fiscal.taxRegionToPersist,
      postalCode: fiscal.postalCode,
      ineMunicipalityCode: fiscal.ineMunicipalityCode,
      fiscalTerritory: fiscal.fiscalTerritory,
      timezone: String(targetProperty.timezone ?? "Europe/Madrid")
    }
  });
  // The tax resolver caches region/rates per property: drop them and (re)provision the
  // statutory catalogue for the imported region (contract C, idempotent). A provisioning
  // failure is reported in the result — the import itself succeeded — never swallowed.
  invalidateTaxCache(propertyId);
  let taxProvisioning: { ok: boolean; taxRegion: string | null; provisioned?: number; skipped?: number; error?: string };
  try {
    const provisioned = await ensurePropertyTaxes({ propertyId, organizationId, taxRegion: fiscal.taxRegionToPersist });
    taxProvisioning = { ok: true, ...provisioned };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[onboarding.materialise] ensurePropertyTaxes failed", {
      projectId,
      propertyId,
      taxRegion: fiscal.taxRegionToPersist,
      error: message
    });
    taxProvisioning = { ok: false, taxRegion: fiscal.taxRegion, error: message };
  }

  // Approved room_type mappings: sourceCode -> target room type name.
  const approvedRoomTypeMappings = engineMappingSuggestions.filter(
    (s) => s.onboardingProjectId === projectId && s.status === "approved" && (s.mappingType ?? "") === "room_type"
  );
  // Build a source-code -> RoomType.id map, creating/upserting room types.
  const roomTypeIdBySourceCode = new Map<string, string>();
  for (const mapping of approvedRoomTypeMappings) {
    const sourceCode = String(mapping.sourceValue).toUpperCase();
    const name = String(mapping.targetValue ?? sourceCode);
    const isSingle = /SGL|SINGLE|INDIVIDUAL/i.test(sourceCode) || /single/i.test(name);
    const rt = await prisma.roomType.upsert({
      where: { id: `rt_${propertyId}_${sourceCode}` },
      update: { name, code: sourceCode, propertyId },
      create: {
        id: `rt_${propertyId}_${sourceCode}`,
        propertyId,
        name,
        code: sourceCode,
        maxOccupancy: isSingle ? 1 : 2,
        baseCapacity: isSingle ? 1 : 2,
        sellable: true
      }
    });
    roomTypeIdBySourceCode.set(sourceCode, rt.id);
  }

  // Fallback room type if a room references an unmapped code.
  let fallbackRoomTypeId: string | null = null;
  async function ensureFallbackRoomType() {
    if (fallbackRoomTypeId) return fallbackRoomTypeId;
    const rt = await prisma.roomType.upsert({
      where: { id: `rt_${propertyId}_UNMAPPED` },
      update: { propertyId },
      create: { id: `rt_${propertyId}_UNMAPPED`, propertyId, name: "Unmapped Room", code: "UNMAPPED", maxOccupancy: 2, baseCapacity: 2, sellable: false }
    });
    fallbackRoomTypeId = rt.id;
    return rt.id;
  }

  // Rooms from extracted entities. Replace any prior rooms for this property (idempotent demo).
  const roomEntities = engineExtractedEntities.filter((e) => e.onboardingProjectId === projectId && e.entityType === "room");
  await prisma.room.deleteMany({ where: { propertyId } });
  let roomsCreated = 0;
  const importWarnings: string[] = [];
  const validStatuses = new Set(["clean", "dirty", "inspected", "out_of_order", "out_of_service"]);
  for (const entity of roomEntities) {
    const fields = (entity.fields ?? {}) as Record<string, unknown>;
    const number = String(fields.roomNumber ?? fields.number ?? fields.room ?? "").trim();
    if (!number) continue;
    const sourceCode = String(fields.roomType ?? fields.type ?? "").toUpperCase();
    const roomTypeId = roomTypeIdBySourceCode.get(sourceCode) ?? (await ensureFallbackRoomType());
    const rawStatus = String(fields.status ?? "clean").toLowerCase();
    const status = validStatuses.has(rawStatus) ? rawStatus : "clean";
    // Tanda L5 (estado unificado): limpieza y mantenimiento del fichero validados
    // contra el vocabulario cerrado (alias ready/stayover/cleaning/in_progress
    // normalizados, nunca almacenados). Si `status` es una limpieza, el hk manda y
    // `status` la refleja; una out_of_order / out_of_service se conserva y el hk
    // viene del fichero o queda en clean.
    const rawHk = fields.housekeepingStatus ?? fields.housekeeping_status ?? fields.housekeeping;
    const hkFromFile = typeof rawHk === "string" ? normalizeHousekeepingInput(rawHk) : null;
    const housekeepingStatus = hkFromFile ?? (isHousekeepingStatus(status) ? status : "clean");
    const roomStatus = isHousekeepingStatus(status) ? housekeepingStatus : status;
    const rawMnt = String(fields.maintenanceStatus ?? fields.maintenance_status ?? "ok").toLowerCase();
    // Corrector L5 (OP-07): `blocked` solo lo escribe una orden de trabajo (es lo
    // único que puede liberarlo); del fichero se degrada a needs_attention y se
    // anota. (OP-02): una out_of_order / out_of_service importada no es vendible —
    // «Desbloquear habitación» del Room Rack la devuelve al inventario.
    const maintenanceStatus = rawMnt === "blocked" ? "needs_attention" : isMaintenanceStatus(rawMnt) ? rawMnt : "ok";
    if (rawMnt === "blocked") importWarnings.push(`Habitación ${number}: maintenanceStatus «blocked» importado como «needs_attention» (el bloqueo lo pone una orden de trabajo).`);
    const outOfInventory = roomStatus === "out_of_order" || roomStatus === "out_of_service";
    await prisma.room.create({
      data: {
        propertyId,
        roomTypeId,
        number,
        floor: fields.floor != null ? String(fields.floor) : null,
        status: roomStatus as never,
        housekeepingStatus,
        maintenanceStatus,
        sellable: !outOfInventory,
        active: true
      }
    });
    roomsCreated += 1;
  }

  // Non-room spaces (salón, comedor, cafetería, convention rooms, etc.).
  let spacesCreated = 0;
  if (spaces?.length) {
    await prisma.propertySpace.deleteMany({ where: { propertyId } });
    for (const space of spaces) {
      const created = await prisma.propertySpace.create({
        data: {
          propertyId,
          name: String(space.name ?? "Space"),
          code: space.code ? String(space.code) : null,
          spaceType: String(space.spaceType ?? "common_area"),
          description: space.description ? String(space.description) : null,
          active: true
        }
      });
      if (space.bookable) {
        await prisma.inventoryResource.create({
          data: {
            propertyId,
            resourceType: "space",
            spaceId: created.id,
            name: created.name,
            capacity: space.capacity != null ? Number(space.capacity) : null,
            bookable: true,
            sellable: true,
            dailyBookable: true,
            hourlyBookable: true,
            status: "available"
          }
        });
      }
      spacesCreated += 1;
    }
  }

  return {
    propertyId,
    organizationId,
    // Tanda 6b: who invoices (sociedad) and how the centre is coded (fix t6b#7).
    structure: {
      legalEntityId: structure.legalEntity.id,
      legalEntityCode: structure.legalEntity.code,
      legalEntityCreated: structure.legalEntity.created,
      propertyCode: structure.property.code,
      kind: structure.property.kind
    },
    fiscal: {
      taxRegion: fiscal.taxRegion,
      taxRegionSource: fiscal.taxRegionSource,
      fiscalTerritory: fiscal.fiscalTerritory,
      postalCode: fiscal.postalCode,
      ineMunicipalityCode: fiscal.ineMunicipalityCode
    },
    taxProvisioning,
    counts: {
      roomTypes: roomTypeIdBySourceCode.size,
      rooms: roomsCreated,
      spaces: spacesCreated
    },
    /** Corrector L5 (OP-07): valores del fichero degradados al importar (p. ej. maintenanceStatus «blocked»). */
    warnings: importWarnings
  };
}

export function rollbackMigration(input: { context: UserContext; projectId: string; payload?: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.rollback"]);
  const project = requireProject(input.projectId);
  const rollback = isRollbackAllowed({
    batchLockedByLiveActivity: Boolean(input.payload?.batchLockedByLiveActivity),
    batchType: String(input.payload?.batchType ?? "rooms") as Parameters<typeof isRollbackAllowed>[0]["batchType"]
  });
  const result = {
    projectId: project.id,
    status: rollback.allowed ? "rollback_review_required" : "rollback_blocked",
    safeRollbackOnly: rollback.allowed,
    message: rollback.reason,
    payload: input.payload ?? {}
  };
  audit(input.context, "OnboardingMigrationBatchRolledBack", "onboarding_project", project.id, result);
  return result;
}

export function getGoLiveReadiness(input: { context: UserContext; projectId: string }) {
  requirePermissions(input.context, ["onboarding.read"]);
  requireProject(input.projectId);
  const dataQuality = getDemoDataQuality();
  const cutoverPlan = generateCutoverAssistantPlan({
    projectId: input.projectId,
    blockingIssues: dataQuality.issues,
    staffReviewCompleted: false,
    testImportCompleted: true
  });
  const readiness = {
    ...goLiveReadiness,
    blockingIssues: dataQuality.issues.filter((issue) => issue.severity === "blocking"),
    warnings: dataQuality.issues.filter((issue) => issue.severity === "warning"),
    status: dataQuality.goLiveBlocked ? "blocked" : "ready",
    dataQuality,
    cutoverPlan
  };
  audit(input.context, "OnboardingGoLiveReadinessGenerated", "onboarding_project", input.projectId, readiness);
  return readiness;
}

export function getCutoverPlan(input: { context: UserContext; projectId: string }) {
  requirePermissions(input.context, ["onboarding.read"]);
  requireProject(input.projectId);
  const dataQuality = getDemoDataQuality();
  const plan = generateCutoverAssistantPlan({
    projectId: input.projectId,
    blockingIssues: dataQuality.issues,
    staffReviewCompleted: false,
    testImportCompleted: true
  });
  audit(input.context, "OnboardingGoLiveReadinessGenerated", "onboarding_project", input.projectId, plan);
  return plan;
}

export function runCutoverDeltaImportDryRun(input: { context: UserContext; projectId: string; payload?: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.manage_cutover"]);
  requireProject(input.projectId);
  const dataQuality = getDemoDataQuality();
  const plan = generateCutoverDeltaImportDryRun({
    projectId: input.projectId,
    sourceWatermark: String(input.payload?.sourceWatermark ?? "2026-05-31T23:00:00.000Z"),
    targetWindowStart: String(input.payload?.targetWindowStart ?? "2026-06-01T00:00:00.000Z"),
    targetWindowEnd: String(input.payload?.targetWindowEnd ?? "2026-06-01T08:00:00.000Z"),
    counts: {
      reservations: { create: 12, update: 31, conflicts: 2 },
      guests: { create: 18, update: 27, conflicts: 3 },
      folios: { create: 0, update: 19, conflicts: 4 },
      balances: { create: 0, update: 19, conflicts: 4 },
      housekeeping_status: { create: 0, update: 70, conflicts: 0 },
      maintenance_status: { create: 0, update: 6, conflicts: 1 },
      channel_reservations: { create: 4, update: 8, conflicts: 1 }
    },
    blockingIssues: dataQuality.issues
  });
  audit(input.context, "OnboardingDryRunCompleted", "onboarding_project", input.projectId, plan);
  return plan;
}

/**
 * Corrector L5 (L5F-04): UN solo go-live. POST /onboarding/projects/:id/go-live ya
 * no «aprueba» nada por su cuenta (antes devolvía approved:true sin cambiar
 * estado ni paso): delega en la aprobación REAL de la propiedad materializada
 * (backoffice approveGoLive → readiness recalculada, properties.go_live_at, paso
 * `go_live` de la puesta en marcha, auditoría PropertyGoLiveApproved; exige
 * property.go_live además de onboarding.go_live). Un proyecto sin propiedad
 * aplicada responde 409 ONBOARDING_NOT_APPLIED.
 */
export async function approveGoLive(input: { context: UserContext; projectId: string; payload?: Record<string, unknown> }) {
  requirePermissions(input.context, ["onboarding.go_live"]);
  const project = requireProject(input.projectId);
  const propertyId = project.propertyId ?? null;
  const applied = project.status === "applied" || project.status === "completed";
  if (!propertyId || !applied) {
    const error = new ConflictError("El proyecto de onboarding aún no se ha aplicado a una propiedad: la salida en vivo se aprueba en Configuración › Puesta en marcha una vez materializada.");
    error.details = { code: "ONBOARDING_NOT_APPLIED", projectId: project.id, status: project.status, propertyId };
    throw error;
  }
  const approval = await approvePropertyGoLive({ context: input.context, propertyId, correlationId: createId("corr") });
  const result = {
    projectId: input.projectId,
    propertyId,
    approved: approval.status === "approved",
    blocked: approval.status === "blocked",
    blockingIssues: approval.status === "blocked" ? approval.blockers : [],
    goLiveAt: approval.goLiveAt,
    payload: input.payload ?? {}
  };
  audit(input.context, "OnboardingGoLiveApproved", "onboarding_project", input.projectId, result);
  return result;
}
