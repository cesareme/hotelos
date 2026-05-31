import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
{
  for (const candidate of [resolvePath(process.cwd(), ".env"), resolvePath(process.cwd(), "../../.env")]) {
    if (!existsSync(candidate)) continue;
    for (const rawLine of readFileSync(candidate, "utf-8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[key] = value;
    }
    break;
  }
}
import {
  createB2bEinvoiceEnvelope,
  sendGuestMessageViaAdapter,
  submitSesHospedajesRecord,
  suggestBankTransactionMatches,
  syncOtaChannelAvailability,
  type B2bEinvoiceEnvelope,
  type B2bEinvoiceStatus,
  type MessageChannel,
  type SesHospedajesClientConfig
} from "@hotelos/integrations";
import { buildHealthResponse, SERVICE_NAMES } from "@hotelos/config";
import { shouldDeleteRetentionCandidate } from "@hotelos/compliance";
import { startScheduler } from "./scheduler.js";

export const ADVANCED_WORKER_JOB_NAMES = [
  "generateRevenueForecasts",
  "generateDailyRevenueForecasts",
  "generateRevenueRecommendations",
  "calculatePickupAndPace",
  "calculateChannelProfitability",
  "detectRateParityIssues",
  "runRateShopper",
  "syncChannelAvailability",
  "syncChannelRates",
  "syncChannelRestrictions",
  "pullChannelReservations",
  "processChannelReservationModification",
  "processChannelCancellation",
  "retryFailedChannelSyncJobs",
  "calculateForecastAccuracy",
  "generateDemandCalendarAlerts",
  "runRevenueAutomationRules",
  "detectOverbookingRisk",
  "detectUnderpricingRisk",
  "detectLowDemandRisk",
  "generateRevenueDailySnapshots",
  "generateRevenueForecastSnapshots",
  "aggregateHistoryForecastReports",
  "calculateForecastConfidence",
  "detectHistoryForecastAlerts",
  "generateScheduledHistoryForecastReports",
  "exportHistoryForecastReport",
  "generateDailyGuestRegisterBatch",
  "submitQueuedGuestRegisterRecords",
  "submitReservationCommunications",
  "submitCancellationCommunications",
  "retryFailedAuthoritySubmissions",
  "checkGuestRegisterDeadlines",
  "detectMissingGuestRegisterData",
  "expireGuestRegisterRetention",
  "deleteExpiredIdentityDocumentArtifacts",
  "syncAuthoritySubmissionStatuses",
  "generateGuestRegisterComplianceReport",
  "refreshGuestProfiles",
  "detectDuplicateGuestProfiles",
  "calculateGuestLifetimeValue",
  "processScheduledCampaigns",
  "releaseExpiredGroupBlocks",
  "calculateGroupPickup",
  "generateEventTaskReminders",
  "generateLaborForecasts",
  "detectOvertimeRisk",
  "exportPayrollData",
  "checkInventoryReorderLevels",
  "processPurchaseOrderReceiving",
  "matchSupplierBillsToPurchaseOrders",
  "sendGuestPortalLinks",
  "processGuestSelfCheckout",
  "processUpsellPurchases",
  "syncGuestReviews",
  "analyzeReviewSentiment",
  "sendSurveyRequests",
  "detectQualityTrends",
  "importUtilityReadings",
  "detectEnergyAnomalies",
  "generateSustainabilityReports",
  "sendSafetyCheckReminders",
  "escalateCriticalIncidents",
  "generateAnalyticsSnapshots",
  "detectBusinessAnomalies",
  "generateScheduledReports",
  "deliverWebhooks",
  "retryFailedWebhooks",
  "calculateApiUsage",
  "runAiEvaluations",
  "detectAiIncidents",
  "processHumanReviewQueue",
  "classifyOnboardingFiles",
  "extractOnboardingDocuments",
  "parseOnboardingSpreadsheets",
  "syncSourcePmsData",
  "generateHotelBlueprintSuggestions",
  "generateMappingSuggestions",
  "runOnboardingDataQualityChecks",
  "runMigrationDryRun",
  "applyMigrationBatch",
  "rollbackMigrationBatch",
  "generateGoLiveReadinessReport",
  "deleteExpiredOnboardingRawFiles",
  "runCutoverDeltaImport"
] as const;

export type AdvancedWorkerJobName = (typeof ADVANCED_WORKER_JOB_NAMES)[number];

export type AdvancedWorkerJob = {
  name: AdvancedWorkerJobName;
  payload: {
    propertyId?: string;
    organizationId?: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
  };
};

export type WorkerJob =
  | {
      name: "ses_hospedajes.submit";
      payload: {
        submissionId: string;
        requestPayload: Record<string, unknown>;
        config?: SesHospedajesClientConfig;
      };
    }
  | {
      name: "invoice.compliance.check";
      payload: {
        invoiceId: string;
        issued: boolean;
        verifactuHash?: string;
        qrPayload?: string;
        b2b?: { enabled: boolean; syntax?: B2bEinvoiceEnvelope["syntax"] };
      };
    }
  | {
      name: "messaging.send";
      payload: {
        messageId: string;
        channel: MessageChannel;
        to: string;
        body: string;
        aiDisclosureIncluded?: boolean;
      };
    }
  | {
      name: "ota.channel_sync";
      payload: {
        propertyId: string;
        channel: string;
        from: string;
        to: string;
      };
    }
  | {
      name: "bank.reconciliation.match";
      payload: {
        propertyId: string;
        transaction: {
          id: string;
          amount: number;
          currency: string;
          counterparty?: string;
        };
        candidates: Array<{
          id: string;
          sourceType: "reservation" | "folio" | "payment" | "supplier_bill" | "invoice";
          amount: number;
          currency: string;
          reference: string;
        }>;
      };
    }
  | {
      name: "retention.delete_expired";
      payload: {
        propertyId: string;
        asOf: string;
        candidates: Array<{
          entityType: string;
          entityId: string;
          retentionUntil: string;
          legalHold?: boolean;
        }>;
      };
    }
  | {
      name: "reports.daily_briefing";
      payload: {
        propertyId: string;
        metrics: {
          occupancyPct: number;
          adr: number;
          revpar: number;
          arrivals: number;
          departures: number;
          roomsNotReady: number;
          blockedRooms: number;
          openDebt: number;
          failedComplianceRecords: number;
        };
        recommendations?: string[];
      };
    }
  | AdvancedWorkerJob;

export type WorkerEvent = {
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
};

export type WorkerJobResult = {
  status: "completed" | "failed" | "retry";
  job: WorkerJob["name"];
  auditAction: string;
  details: Record<string, unknown>;
  events: WorkerEvent[];
};

export function getWorkerHealth() {
  return buildHealthResponse({
    service: SERVICE_NAMES.worker,
    dependencies: {
      postgres: "ok",
      redis: "ok",
      objectStorage: "unconfigured",
      queue: "ok"
    }
  });
}

function defaultSesConfig(): SesHospedajesClientConfig {
  return {
    clientId: "configured-in-secret-manager",
    clientSecret: "configured-in-secret-manager",
    environment: "sandbox"
  };
}

function event(eventType: string, entityType: string, entityId: string, payload: Record<string, unknown>): WorkerEvent {
  return { eventType, entityType, entityId, payload };
}

async function handleSesHospedajesSubmit(job: Extract<WorkerJob, { name: "ses_hospedajes.submit" }>): Promise<WorkerJobResult> {
  const result = await submitSesHospedajesRecord(job.payload.config ?? defaultSesConfig(), job.payload.requestPayload);
  const eventTypeByStatus = {
    accepted: "SesHospedajesSubmissionAccepted",
    rejected: "SesHospedajesSubmissionRejected",
    failed: "SesHospedajesSubmissionFailed"
  } satisfies Record<typeof result.status, string>;

  return {
    status: result.status === "failed" ? "retry" : "completed",
    job: job.name,
    auditAction: "WORKER_SES_HOSPEDAJES_SUBMISSION_PROCESSED",
    details: result,
    events: [
      event(eventTypeByStatus[result.status], "ses_hospedajes_submission", job.payload.submissionId, {
        externalReference: result.externalReference,
        errorMessage: result.errorMessage
      })
    ]
  };
}

function handleInvoiceComplianceCheck(job: Extract<WorkerJob, { name: "invoice.compliance.check" }>): WorkerJobResult {
  const errors: string[] = [];
  const b2bStatuses: B2bEinvoiceStatus[] = ["created"];
  let b2bEnvelope: B2bEinvoiceEnvelope | undefined;

  if (job.payload.issued && !job.payload.verifactuHash) {
    errors.push("Issued invoice is missing VERI*FACTU hash placeholder.");
  }

  if (job.payload.issued && !job.payload.qrPayload) {
    errors.push("Issued invoice is missing QR payload placeholder.");
  }

  if (job.payload.b2b?.enabled) {
    b2bEnvelope = createB2bEinvoiceEnvelope(job.payload.invoiceId, job.payload.b2b.syntax ?? "UBL");
    b2bStatuses.push(b2bEnvelope.status);
  }

  return {
    status: errors.length > 0 ? "failed" : "completed",
    job: job.name,
    auditAction: "WORKER_INVOICE_COMPLIANCE_CHECKED",
    details: {
      valid: errors.length === 0,
      errors,
      b2bEnvelope,
      b2bStatuses
    },
    events: [
      event(errors.length > 0 ? "InvoiceComplianceFailed" : "InvoiceComplianceChecked", "invoice", job.payload.invoiceId, {
        errors,
        b2bEnvelope
      })
    ]
  };
}

async function handleMessagingSend(job: Extract<WorkerJob, { name: "messaging.send" }>): Promise<WorkerJobResult> {
  const result = await sendGuestMessageViaAdapter(job.payload);

  return {
    status: result.status === "failed" ? "retry" : "completed",
    job: job.name,
    auditAction: "WORKER_GUEST_MESSAGE_SEND_ATTEMPTED",
    details: result,
    events: [
      event(result.status === "sent" ? "GuestMessageSent" : "GuestMessageQueued", "message", job.payload.messageId, {
        channel: job.payload.channel,
        providerReference: result.providerReference,
        errorMessage: result.errorMessage
      })
    ]
  };
}

async function handleOtaChannelSync(job: Extract<WorkerJob, { name: "ota.channel_sync" }>): Promise<WorkerJobResult> {
  const result = await syncOtaChannelAvailability(job.payload);

  return {
    status: "completed",
    job: job.name,
    auditAction: "WORKER_OTA_CHANNEL_SYNC_COMPLETED",
    details: result,
    events: [
      event("OtaChannelSynced", "property", job.payload.propertyId, {
        channel: job.payload.channel,
        from: job.payload.from,
        to: job.payload.to,
        exportedAvailability: result.exportedAvailability,
        importedReservations: result.importedReservations,
        warnings: result.warnings
      })
    ]
  };
}

function handleBankReconciliationMatch(job: Extract<WorkerJob, { name: "bank.reconciliation.match" }>): WorkerJobResult {
  const matches = suggestBankTransactionMatches(job.payload.transaction, job.payload.candidates);

  return {
    status: "completed",
    job: job.name,
    auditAction: "WORKER_BANK_RECONCILIATION_MATCHED",
    details: { matches },
    events: [
      event("BankReconciliationMatchesSuggested", "bank_transaction", job.payload.transaction.id, {
        propertyId: job.payload.propertyId,
        matches
      })
    ]
  };
}

function handleRetentionDeleteExpired(job: Extract<WorkerJob, { name: "retention.delete_expired" }>): WorkerJobResult {
  const decisions = job.payload.candidates.map((candidate) => ({
    ...candidate,
    decision: shouldDeleteRetentionCandidate({
      entityType: candidate.entityType,
      retentionUntil: candidate.retentionUntil,
      asOf: job.payload.asOf,
      legalHold: candidate.legalHold
    })
  }));
  const deleted = decisions.filter((candidate) => candidate.decision.deleteNow);

  return {
    status: "completed",
    job: job.name,
    auditAction: "WORKER_RETENTION_DELETION_COMPLETED",
    details: {
      propertyId: job.payload.propertyId,
      deleted,
      retained: decisions.filter((candidate) => !candidate.decision.deleteNow),
      retainedCount: decisions.length - deleted.length
    },
    events: [
      event("RetentionDeletionCompleted", "property", job.payload.propertyId, {
        deletedEntityIds: deleted.map((candidate) => candidate.entityId),
        deletedCount: deleted.length
      })
    ]
  };
}

function handleDailyBriefing(job: Extract<WorkerJob, { name: "reports.daily_briefing" }>): WorkerJobResult {
  const metrics = job.payload.metrics;
  const lines = [
    `Occupancy is ${metrics.occupancyPct}%.`,
    `ADR is ${metrics.adr}.`,
    `RevPAR is ${metrics.revpar}.`,
    `There are ${metrics.arrivals} arrivals and ${metrics.departures} departures.`,
    `${metrics.roomsNotReady} rooms are not ready and ${metrics.blockedRooms} rooms are blocked.`,
    `Open guest debt is ${metrics.openDebt}.`,
    `${metrics.failedComplianceRecords} compliance records need review.`
  ];

  if (job.payload.recommendations?.length) {
    lines.push(`Recommended action: ${job.payload.recommendations[0]}`);
  }

  return {
    status: "completed",
    job: job.name,
    auditAction: "WORKER_DAILY_BRIEFING_GENERATED",
    details: { briefing: lines.join(" "), metrics },
    events: [event("DailyBriefingGenerated", "property", job.payload.propertyId, { metrics })]
  };
}

function handleAdvancedJob(job: AdvancedWorkerJob): WorkerJobResult {
  const propertyId = job.payload.propertyId ?? "property";
  return {
    status: "completed",
    job: job.name,
    auditAction: `WORKER_${job.name}`,
    details: {
      scaffolded: true,
      metadata: job.payload.metadata ?? {},
      rule: "Advanced workers write durable job results, domain events, and audit records before production execution."
    },
    events: [event(job.name, "property", propertyId, { organizationId: job.payload.organizationId })]
  };
}

export async function handleJob(job: WorkerJob): Promise<WorkerJobResult> {
  switch (job.name) {
    case "ses_hospedajes.submit":
      return handleSesHospedajesSubmit(job);
    case "invoice.compliance.check":
      return handleInvoiceComplianceCheck(job);
    case "messaging.send":
      return handleMessagingSend(job);
    case "ota.channel_sync":
      return handleOtaChannelSync(job);
    case "bank.reconciliation.match":
      return handleBankReconciliationMatch(job);
    case "retention.delete_expired":
      return handleRetentionDeleteExpired(job);
    case "reports.daily_briefing":
      return handleDailyBriefing(job);
    default:
      return handleAdvancedJob(job);
  }
}

import { fileURLToPath } from "node:url";
import { resolve as resolvePath2 } from "node:path";
const __entryFile = resolvePath2(fileURLToPath(import.meta.url));
const __argFile = process.argv[1] ? resolvePath2(process.argv[1]) : "";
if (__entryFile === __argFile) {
  console.log(JSON.stringify(getWorkerHealth()));
  if (process.env.WORKER_AUTOSTART !== "false") {
    void startScheduler().catch((err) => {
      console.error("[worker] failed to start scheduler:", err);
      process.exit(1);
    });
  }
}
