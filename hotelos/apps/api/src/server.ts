import { existsSync, readFileSync } from "node:fs";
import { BRAND } from "./lib/brand.js";
import { resolve as resolvePath2 } from "node:path";
{
  const candidates = [
    resolvePath2(process.cwd(), ".env"),
    resolvePath2(process.cwd(), "../../.env"),
    resolvePath2(process.cwd(), "../api/.env")
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, "utf-8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Never override what the process was started with: an orchestrator
      // (compose, systemd, CI) must always win over a stray .env on disk.
      if (process.env[key] === undefined) process.env[key] = value;
    }
    console.log(`[env] loaded ${candidate} (defaults only; process env wins)`);
    break;
  }
}
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import type { ChatAttachmentDraft, CheckInFromScanRequest, GuestIdentityFields, RateGridBulkUpdateRequest, RateGridPushRequest } from "@hotelos/shared";
import type { HotelModuleCode } from "@hotelos/product";
import { isValidSpanishTaxId, resolveVerifactuSoftware, type TaxCategory } from "@hotelos/compliance";
import type { Prisma } from "@hotelos/database";
import { buildHealthResponse, OBSERVABILITY_HEADERS, SERVICE_NAMES } from "@hotelos/config";
import { createId } from "./lib/ids.js";
import { demoStore, type PropertyRecord, type UserContext } from "./lib/demo-store.js";
import { isPasswordChangeAllowedRoute, isPublicRoute, passwordChangeRequiredError, registerAuthContext } from "./lib/auth-context.js";
// Tanda 4 (rutas-cors): env contract (assertEnv/validateEnv/resolveCorsOrigins,
// lote env-typecheck) and role provisioning from a template (lote rbac-templates).
import { assertEnv, resolveCorsOrigins, validateEnv } from "./lib/env.js";
import { createRoleFromTemplate } from "./lib/rbac-catalog.js";
import { ROLE_TEMPLATE_KEYS, type RoleKey } from "@hotelos/shared";
// Tanda 6b (L2, integración): enums of the sociedad layer for the POST /admin/tenants bridge.
import { LEGAL_FORMS, PROPERTY_KINDS, type LegalForm, type PropertyKind } from "@hotelos/shared";
import { describeSchedulerLease, holdsSchedulerLease, isSchedulerLeader } from "./lib/scheduler-leader.js";
import { BadRequestError, ConflictError, ForbiddenError, HttpError, NotFoundError, UnauthorizedError, statusCodeForError, describePrismaError, describeFastifyContentTypeError } from "./lib/http-error.js";
import { buildPage, decodeCursor, pageBody, pageHeaders, parsePageQuery } from "./lib/pagination.js";
import {
  assertEntityAccess,
  assertPropertyEntityAccess,
  grantPropertyAccess,
  isPropertyAssigned,
  listOperationalProperties,
  resolveOrganizationScope
} from "./lib/tenancy.js";
// Rate grid v2 (2026-09-14): ONE canonical backend (modules/rate-manager) whose
// routes live in rate-grid.routes.ts; the old /revenue/…/rate-grid family and the
// flat v1 routes were retired. Publishing goes through the channel-manager
// outbox (delivery.service) and its drain job below.
import { registerRateGridRoutes } from "./modules/rate-manager/rate-grid.routes.js";
import { registerChannelManagerRoutes } from "./modules/channel-manager/channel-manager.routes.js";
import { drainChannelDeliveries } from "./modules/channel-manager/drain.service.js";
import { readChannelEnv } from "./modules/channel-manager/env.partial.js";
import { enqueueRateGridPush, getCellSyncMap as getCellSyncMapFromOutbox } from "./modules/channel-manager/delivery.service.js";
import { registerRecommendationRoutes } from "./modules/revenue/recommendations.routes.js";
// Finanzas (2026-09-16, integración): every finance module owns its routes in
// <modulo>.routes.ts + route-permissions.partial.ts (convention of rate grid
// v2). Registered below, right after registerChannelManagerRoutes(app); the
// legacy POS / night-audit handlers that lived here were retired (same paths).
import { registerLedgerRoutes } from "./modules/accounting/ledger.routes.js";
import { registerFiscalRoutes } from "./modules/accounting/fiscal.routes.js";
import { canonicalLedgerEngine } from "./modules/accounting/vat-settlement.service.js";
import { registerInvoicingRoutes } from "./modules/invoicing/invoicing.routes.js";
import { registerPaymentsRoutes } from "./modules/payments/payments.routes.js";
import { registerPosRoutes } from "./modules/pos/pos.routes.js";
import { registerNightAuditRoutes } from "./modules/night-audit/night-audit.routes.js";
import { registerPayablesRoutes } from "./modules/payables/payables.routes.js";
import { registerFixedAssetsRoutes } from "./modules/fixed-assets/fixed-assets.routes.js";
import { registerTreasuryRoutes } from "./modules/treasury/treasury.routes.js";
import { registerFinancialStatementsRoutes } from "./modules/financial-statements/financial-statements.routes.js";
// Estructura societaria (Tanda 6b · L2, integración): sociedad + centros. The
// routes live in modules/structure/structure.routes.ts (permissions in its
// route-permissions.partial.ts); `listSwitchableProperties` moved there too so
// GET /users/me/properties and GET /properties gain kind / code / legalEntityId
// / legalEntityName (design §5.4) with the same fallback to the demo store.
import { registerStructureRoutes } from "./modules/structure/structure.routes.js";
import { listSwitchableProperties } from "./modules/structure/legal-entity.service.js";
// Coste de personal importado (Tanda 6c · L3): /payroll/cost-imports* y
// /payroll/cost-report (modules/payroll/cost-import.routes.ts; permisos en su
// route-permissions.partial.ts).
import { registerPayrollCostRoutes } from "./modules/payroll/cost-import.routes.js";
// Fichas de personal (FIX-1 · F10): GET/POST /payroll/staff-profiles
// (modules/payroll/staff-profiles.routes.ts; permisos en el mismo partial).
import { registerStaffProfileRoutes } from "./modules/payroll/staff-profiles.routes.js";
// Importación masiva de reservas (Tanda 7 · L3): /properties/:propertyId/
// reservations/imports* (modules/pms/reservation-import.routes.ts; permisos en
// modules/pms/route-permissions.partial.ts).
import { registerReservationImportRoutes } from "./modules/pms/reservation-import.routes.js";
// OPERA Cloud · modo sombra (Tanda 7b · L3): POST /integrations/pms-shadow/ingest
// (pública, clave de API) y /properties/:propertyId/pms-shadow/*
// (modules/pms-shadow/pms-shadow.routes.ts; permisos en
// modules/pms-shadow/route-permissions.partial.ts); job del líder
// (modules/pms-shadow/pms-shadow.job.ts) en el bloque de schedulers.
import { registerPmsShadowRoutes } from "./modules/pms-shadow/pms-shadow.routes.js";
import { registerLedgerImportRoutes } from "./modules/accounting/ledger-import.routes.js";
import { startPmsShadowJob } from "./modules/pms-shadow/pms-shadow.job.js";
// Reputación y reseñas (Tanda T8): /reputation/properties/:propertyId/{inbox,sources,runs,imports,
// sources/:id,sources/:id/sync} y /reputation/reviews/:id{,/draft,/quality-case}
// (modules/reputation/reputation.routes.ts; permisos en modules/reputation/route-permissions.partial.ts);
// job diario del líder (modules/reputation/reputation-sync.job.ts) en el bloque de schedulers.
import { registerReputationRoutes } from "./modules/reputation/reputation.routes.js";
import { registerCheckinRoutes } from "./modules/checkin/checkin.routes.js";
import { registerRoomAssignmentRoutes } from "./modules/pms/room-assignment.routes.js";
// Check-in automatizado (Tanda CHK · W3-C/W4-D): jobs del líder (invitación J-3, recordatorio J-1, lote de asignación, purga).
import { readCheckInConfig } from "./modules/checkin/checkin-config.js";
import { shouldStartCheckinJobs, startCheckinJobs } from "./modules/checkin/checkin-jobs.js";
import { paymentLinkServiceContext } from "./modules/checkin/service-context.js";
import { reputationSyncIntervalMs, startReputationSyncJob } from "./modules/reputation/reputation-sync.job.js";
import { assertDraftPublishable } from "./modules/reputation/review-draft.service.js";
import { setReputationAiPort } from "./modules/reputation/reputation-ai.port.js";
import { createAiCoreReputationPort } from "./modules/reputation/reputation-ai.core-adapter.js";
// Documentos y digitalización con IA (Tanda T9): captura/registro/descarga/archivo
// (modules/documents/documents.routes.ts; permisos en modules/documents/route-permissions.partial.ts),
// pipeline de clasificación/extracción/cotejo (modules/documents/pipeline.routes.ts +
// pipeline.service.ts; permisos en pipeline-route-permissions.partial.ts) y puerto de IA
// sobre ai-core (documents-ai.port.ts / documents-ai.core-adapter.ts). La configuración
// del almacén (DOCUMENT_*) se resuelve UNA vez en modules/documents/documents.config.ts.
import { registerDocumentsRoutes } from "./modules/documents/documents.routes.js";
import { registerDocumentPipelineRoutes } from "./modules/documents/pipeline.routes.js";
import { registerDocumentWorkflowRoutes } from "./modules/documents/workflow.routes.js";
import { registerDocumentArchiveRoutes } from "./modules/documents/archive.routes.js";
import { startDocumentsRetentionJob } from "./modules/documents/documents-retention.job.js";
import { runDocumentPipeline } from "./modules/documents/pipeline.service.js";
import { describeDocumentStorageHealth, getDocumentsUploadBodyLimit } from "./modules/documents/documents.config.js";
import { setDocumentsAiPort } from "./modules/documents/documents-ai.port.js";
import { createAiCoreDocumentsPort } from "./modules/documents/documents-ai.core-adapter.js";
import { isLlmConfigured } from "./lib/llm.js";
import { createShutdownController } from "./lib/shutdown.js";
import { CreateEmailConnectionSchema } from "./schemas/email-connections.schemas.js";
import { parseOr400 } from "./modules/rate-manager/rate-grid.schemas.js";
import { listRatePlans, createRatePlan, updateRatePlan, deleteRatePlan } from "./modules/rate-manager/rate-plan.service.js";
import { listForecasts, generateForecasts, getForecastBySegment, getForecastAccuracy, getLiveHistoryForecastReport, parseReportWindow } from "./modules/revenue/forecast.service.js";
import { getHistoryForecastBoard, parseBoardWindow, writeYesterdayDailySnapshotsForAllProperties } from "./modules/revenue/hf-board.service.js";
import { parseRevenueWindow } from "./modules/revenue/actuals.js";
import { getExportCatalog, generateExport } from "./modules/revenue/export-center.service.js";
import { getPeriodMetrics } from "./modules/revenue/comparison.service.js";
import { getPace, getPickup, capturePaceSnapshot, capturePaceSnapshotsForAllProperties } from "./modules/revenue/pace.service.js";
import { listCompetitors, createCompetitor, listCompetitorRates, runRateShop, listParityAlerts } from "./modules/revenue/rate-shop.service.js";
import {
  listPricingRules,
  createPricingRule,
  updatePricingRule,
  listBarLevels,
  createBarLevel,
  generateRecommendations,
  listRecommendations,
  decideRecommendation
} from "./modules/revenue/pricing.service.js";
import {
  listBudgets,
  upsertBudget,
  getBudgetVariance,
  listMarketSegments,
  createMarketSegment,
  seedMarketSegments,
  analyzeDisplacement,
  getMeetingPack
} from "./modules/revenue/strategy.service.js";
import {
  emailProvidersStatus,
  getAuthorizeUrl as getEmailAuthorizeUrl,
  handleOAuthCallback as handleEmailOAuthCallback,
  pollConnection as pollEmailConnection,
  pollAllConnections as pollAllEmailConnections,
  ingestManualEmail,
  listConnections as listEmailConnections,
  createConnection as createEmailConnection,
  disconnectConnection as disconnectEmailConnection,
  listInbound as listInboundEmails,
  approveEmailReservation,
  rejectEmailReservation
} from "./modules/integrations/email/email-reservation.service.js";
import {
  listSalesAccounts,
  createSalesAccount,
  listSalesOpportunities,
  createSalesOpportunity,
  updateSalesOpportunity,
  listGroupBookings,
  getGroupBooking,
  createGroupBooking,
  updateGroupBooking,
  createGroupRoomBlock,
  bulkCreateGroupRoomBlocks,
  releaseGroupUnsold,
  createGroupMasterFolio,
  createEventSpace,
  createEvent,
  createGroupEvent,
  listPropertyEventSpaces,
  importRoomingList,
  updateEvent,
  getGroupsPickupSummary,
  releaseExpiredGroupBlocks
} from "./modules/sales/commercial-sales.service.js";
import { assertRoutePermission, routeRiskLevel } from "./security/route-permissions.js";
import { requestSignIn as guestPortalRequestSignIn, signOut as guestPortalSignOut } from "./modules/guest-portal/guest-portal-auth.service.js";
import {
  GuestPortalAuthError,
  getGuestReservationView,
  submitPreCheckIn as guestPortalSubmitPreCheckIn,
  submitServiceRequest as guestPortalSubmitServiceRequest
} from "./modules/guest-portal/guest-portal.service.js";
import { flushAuditQueues, getAuditPersistStats, hydrateAuditChainFromPostgres, recordAuditEvent, setAuditLogger, verifyAuditIntegrity, verifyDomainEventIntegrity } from "./modules/audit/audit.service.js";
import { closeFiscalPeriod, listFiscalPeriods, openFiscalPeriod, reopenFiscalPeriod } from "./modules/accounting/fiscal-period.service.js";
import {
  closeFiscalYear,
  createFiscalYear,
  getFiscalYearStatus,
  listFiscalYears,
  reopenFiscalYear
} from "./modules/accounting/fiscal-year.service.js";
import { getBalanceSheet, getProfitAndLoss } from "./modules/accounting/reporting.service.js";
import { buildTrialBalance } from "./modules/accounting/trial-balance.service.js";
import { buildBalanceSheet as buildFormalBalanceSheet } from "./modules/accounting/balance-sheet.service.js";
import { buildCashFlow } from "./modules/accounting/cash-flow.service.js";
import { getVerifactuSubmission, getVerifactuSubmissionById, listVerifactuSubmissions, retryVerifactuSubmission, runDueVerifactuRetries } from "./modules/invoicing/verifactu-submission.service.js";
import { getTbaiSubmission, listTbaiSubmissions, retryTbaiSubmission } from "./modules/invoicing/tbai-submission.service.js";
import { getIgicSubmission, listIgicSubmissions, retryIgicSubmission } from "./modules/invoicing/igic-submission.service.js";
import { buildModelo303 } from "./modules/accounting/modelo-303.service.js";
import { buildModelo390 } from "./modules/accounting/modelo-390.service.js";
import { buildModelo111 } from "./modules/accounting/modelo-111.service.js";
import { buildModelo115 } from "./modules/accounting/modelo-115.service.js";
import { buildModelo180 } from "./modules/accounting/modelo-180.service.js";
import {
  createContract as createPayrollContract,
  deactivateContract as deactivatePayrollContract,
  listContracts as listPayrollContracts
} from "./modules/payroll/contracts.service.js";
import {
  calculatePeriod as calculatePayrollPeriod,
  createPeriod as createPayrollPeriod,
  listPeriods as listPayrollPeriods,
  listSlipsForPeriod as listPayrollSlipsForPeriod
} from "./modules/payroll/periods.service.js";
import { exportPeriod, normalisePayrollExportFormat } from "./modules/payroll/export.service.js";
import {
  listRates as listExchangeRates,
  upsertRate as upsertExchangeRate
} from "./modules/accounting/currency.service.js";
import {
  createRule as createCommissionRule,
  deactivateRule as deactivateCommissionRule,
  listRules as listCommissionRules
} from "./modules/commissions/commission-rules.service.js";
import {
  listAccruals as listCommissionAccruals,
  summary as commissionSummary
} from "./modules/commissions/commission-accrual.service.js";
import { buildFrontDeskDashboard } from "./modules/dashboards/front-desk.service.js";
import { buildFrontDeskQueue } from "./modules/dashboards/front-desk-queue.service.js";
import { buildRoomRack } from "./modules/dashboards/room-rack.service.js";
import { buildHousekeepingMobile } from "./modules/dashboards/housekeeping-mobile.service.js";
import { answerCopilot, COPILOT_PRESET_QUESTIONS } from "./modules/copilot/copilot.service.js";
import { buildMaintenanceMobile } from "./modules/dashboards/maintenance-mobile.service.js";
import { buildShiftManager } from "./modules/dashboards/shift-manager.service.js";
import { buildGmDashboard, buildGmPace } from "./modules/dashboards/general-manager.service.js";
import { buildOperationsDirector } from "./modules/dashboards/operations-director.service.js";
import { buildApiReference } from "./modules/developer/api-reference.service.js";
import { buildHousekeepingDashboard } from "./modules/dashboards/housekeeping.service.js";
import { buildMaintenanceDashboard } from "./modules/dashboards/maintenance.service.js";
import { buildFinancePositionDashboard } from "./modules/dashboards/finance-position.service.js";
import { buildConciergeDashboard } from "./modules/dashboards/concierge.service.js";
import { buildReputationDashboard } from "./modules/dashboards/reputation.service.js";
import { buildSalesPipelineDashboard } from "./modules/dashboards/sales-pipeline.service.js";
import { buildWorkforceDashboard } from "./modules/dashboards/workforce.service.js";
import { buildCrmDashboard } from "./modules/dashboards/crm.service.js";
import { buildLoyaltyDashboard } from "./modules/dashboards/loyalty.service.js";
import { buildUpsellsDashboard } from "./modules/dashboards/upsells.service.js";
import { buildSurveysDashboard } from "./modules/dashboards/surveys.service.js";
import { buildQualityDashboard } from "./modules/dashboards/quality.service.js";
import { buildSafetyDashboard } from "./modules/dashboards/safety.service.js";
import { buildInventoryDashboard } from "./modules/dashboards/inventory.service.js";
import { buildProcurementDashboard } from "./modules/dashboards/procurement.service.js";
import { buildGroupsEventsDashboard } from "./modules/dashboards/groups-events.service.js";
import { buildPosDashboard } from "./modules/dashboards/pos.service.js";
import { buildChannelPerformanceDashboard } from "./modules/dashboards/channel-performance.service.js";
import {
  createChannel as createChannelManagerChannel,
  ingestAllReservations as ingestAllChannelReservations,
  ingestReservations as ingestChannelReservations,
  listChannels as listChannelManagerChannels,
  listSyncJobs as listChannelSyncJobs,
  pushAvailability as channelPushAvailability,
  pushRates as channelPushRates,
  pushRestrictions as channelPushRestrictions,
  testChannel as testChannelManagerChannel
} from "./modules/channel-manager/aggregator.service.js";
import {
  listAlerts as listChannelParityAlerts,
  monitorParity as runChannelParityMonitor,
  resolveAlert as resolveChannelParityAlert
} from "./modules/channel-manager/parity-monitor.service.js";
import {
  deleteRateMapping as deleteChannelRateMapping,
  deleteRoomMapping as deleteChannelRoomMapping,
  listRateMappings as listChannelRateMappings,
  listRoomMappings as listChannelRoomMappings,
  mappingCoverage as channelMappingCoverage,
  upsertRateMapping as upsertChannelRateMapping,
  upsertRoomMapping as upsertChannelRoomMapping
} from "./modules/channel-manager/mapping.service.js";
import { channelReadiness as channelReadinessChecklist } from "./modules/channel-manager/readiness.service.js";
import { buildEnergyDashboard } from "./modules/dashboards/energy.service.js";
import { buildSustainabilityDashboard } from "./modules/dashboards/sustainability.service.js";
import { buildAssetsDashboard } from "./modules/dashboards/assets.service.js";
import { buildRoomProfitabilityDashboard } from "./modules/dashboards/room-profitability.service.js";
import { buildAnalyticsCenterDashboard } from "./modules/dashboards/analytics-center.service.js";
import { buildPortfolioDashboard } from "./modules/dashboards/portfolio.service.js";
import { buildPropertyOverview } from "./modules/dashboards/property-overview.service.js";
import { buildPipelineDashboard, getToolCall } from "./modules/ai-operations/pipeline.service.js";
import {
  syncToolRegistry,
  listTools as listAiTools,
  getTool as getAiTool,
  toolRegistryStats as aiToolRegistryStats,
  listPropertyToolSettings as listAiPropertyToolSettings,
  setPropertyToolSetting as setAiPropertyToolSetting,
  type AutomationLevel as AiAutomationLevel
} from "./modules/ai-operations/tool-registry.service.js";
import {
  getPropertyAiSettings,
  updatePropertyAiSettings,
  aiReadiness,
  listConfiguredProperties,
  type AutomationLevel
} from "./modules/ai-operations/property-ai.service.js";
import {
  listTemplates as listNotificationTemplates,
  createTemplate as createNotificationTemplate,
  deactivateTemplate as deactivateNotificationTemplate
} from "./modules/notifications/templates.service.js";
import {
  dispatch as dispatchNotification,
  listDeliveries as listNotificationDeliveries,
  retryDelivery as retryNotificationDelivery,
  templateStats as notificationTemplateStats
} from "./modules/notifications/dispatcher.service.js";
import { getSesSubmission, listSesSubmissions, resolveSesEstablishment, retrySesSubmission, runDueSesSubmissions } from "./modules/compliance/ses-submission.service.js";
// Tanda 3 (server-rutas): contracts of the parallel lots — indirect-tax
// profile (iva-catalogo), tax provisioning (tenant-hydration) and persisted
// staff invitations (invitaciones-api).
import { getPropertyTaxProfile, upsertPropertyTaxRate } from "./modules/accounting/tax-rate.service.js";
import { ensurePropertyTaxes } from "./lib/tenant-hydration.js";
import { acceptInvitation, emailStatus, getInvitationByToken, reissueInvitation } from "./modules/auth/invitations.service.js";
import {
  acknowledgeRequest as gdprAcknowledgeRequest,
  createGdprRequest,
  executeErasure as gdprExecuteErasure,
  fulfillDsar as gdprFulfillDsar,
  getRequest as gdprGetRequest,
  listRequests as gdprListRequests,
  rejectRequest as gdprRejectRequest
} from "./modules/gdpr/gdpr.service.js";
import {
  getCurrentUserProfile,
  createMfaChallenge,
  getSecuritySettings,
  listNotifications,
  isPlatformAdmin,
  listSessions,
  loginWithEmailPassword,
  markNotificationRead,
  registerDevice,
  requirePermissions,
  revokeSession,
  unionPermissions,
  verifyMfaChallenge
} from "./modules/auth/auth.service.js";
// RBAC por departamento (Tanda 8a · L1): ámbito por petición (lib/rbac-scope.ts),
// decisión pura para la auditoría de denegaciones (security/access-decision.ts)
// y las rutas /rbac + /approvals (modules/rbac/rbac.routes.ts; permisos en
// modules/rbac/route-permissions.partial.ts).
import { coversProperty, loadUserScope, permissionsFor } from "./lib/rbac-scope.js";
import { accessDecision } from "./security/access-decision.js";
import { registerRbacRoutes } from "./modules/rbac/rbac.routes.js";
import { PermissionDeniedError } from "@hotelos/shared";
import { createCheckInFromScanConfirmation, executeConfirmation } from "./modules/ai/check-in.command.js";
import { describeAiHealthCheck } from "./lib/ai-config.js";
import { confirmToolCall } from "./modules/ai-operations/tool-runner.service.js";
import { scanIdDocumentCommand } from "./modules/ai/scan-id-document.command.js";
import { suggestMappingCommand } from "./modules/onboarding/suggest-mapping.command.js";
import {
  annulAuthorityCommunication,
  createSpainGuestRegisterRecord,
  ensureReservationGuestRegisterRecords,
  correctGuestRegisterRecord,
  correctSpainGuestRegisterRecord,
  downloadSesHospedajesBatch,
  generateSesHospedajesBatch,
  getComplianceInbox,
  getSpainGuestRegisterSettings,
  listGuestRegisterRecords,
  listReservationGuestRegisterRecords,
  markGuestRegisterIdentityVerified,
  markGuestRegisterSigned,
  markSesBatchManuallyUploaded,
  patchSpainGuestRegisterRecord,
  patchSpainGuestRegisterSettings,
  queueGuestAuthoritySubmission,
  queueSesHospedajesSubmission,
  recordIdentityDiscardEvent,
  recordTemporaryIdentityScan,
  submitSesHospedajesBatch,
  testSesHospedajesConnection,
  validateSpainGuestRegisterRecordApi
} from "./modules/compliance/compliance.service.js";
import {
  assertPropertyInOrg,
  assignRoom,
  assignRoomByNumber,
  checkInReservation,
  checkOutReservationDetailed,
  createReservation,
  createRoom,
  getReservation,
  listReservations,
  listRoomTypes,
  listRooms,
  patchReservation,
  quoteAvailability
} from "./modules/pms/pms.service.js";
import { listGuests, getGuest, createGuest, updateGuest } from "./modules/guests/guests.service.js";
import { extractPropertyMap, applyPropertyMap, type MapperFile, type PropertyMapProposal } from "./modules/mapper/property-mapper.service.js";
import { parseReservationRequest } from "./modules/pms/reservation-agent.service.js";
import { getGuestActivity } from "./modules/pms/guest-activity.service.js";
import {
  closeFolio,
  ensurePrimaryFolio,
  findReservationFolio,
  getFolioBalance,
  getReservationFolio,
  postFolioLine,
  splitFolio,
  moveChargesBetweenFolios,
  markInvoicePaid,
  getReservationBalance
} from "./modules/folio/folio.service.js";
// Finanzas (2026-09-15) · lote facturación-cobros: idempotent captures /
// refunds with journal entry and PSP gate, real invoice email with PDF.
import { createPaymentLink, postFolioPayment, refundFolioPayment } from "./modules/payments/payments.service.js";
import { pspStatusFor } from "./modules/payments/psp/index.js";
import { sendInvoiceByEmail } from "./modules/invoicing/invoice-email.service.js";
import { verifyGuestToken } from "./modules/guest-portal/guest-portal-auth.service.js";
import { getComplianceCenter, updateComplianceItem, updateComplianceProfile, listComplianceTasks, createComplianceTask, updateComplianceTask, deleteComplianceTask, listComplianceDocuments, createComplianceDocument, deleteComplianceDocument, getComplianceAlerts } from "./modules/compliance/compliance-center.service.js";
import { exportInspectionFolder } from "./modules/compliance/compliance-inspection.service.js";
import {
  listCancellationPolicies,
  getCancellationPolicy,
  createCancellationPolicy,
  updateCancellationPolicy,
  deleteCancellationPolicy,
  computeCancellationCharge,
  applyCancellationFee,
  applyNoShowFee
} from "./modules/cancellation-policy/cancellation-policy.service.js";
// Tanda L3 (lote B): cancel / no-show with policy (penalty line, folio closed at
// balance 0, SoD before writing). Separate file: see its header (import cycle).
import { cancelReservationWithPolicy, markNoShowWithPolicy } from "./modules/cancellation-policy/reservation-lifecycle.service.js";
import {
  listTourOperators, getTourOperator, createTourOperator, updateTourOperator,
  listAllotments, getAllotment, createAllotment, updateAllotment, deleteAllotment,
  getRemainingForRange, getRemainingForDay, releaseExpired, getPickupSummary
} from "./modules/allotment/allotment.service.js";
import {
  listReservationFolios, createSecondaryFolio,
  listRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule,
  transferFolioLine
} from "./modules/folio/folio-routing.service.js";
import { z } from "zod";
import { parse } from "./lib/validate.js";

// ---- Handler-level query schemas (Tanda 2) ---------------------------------
// Values are validated here (400 on malformed), unknown params are ignored.
const isoDateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha esperado: YYYY-MM-DD");
const isoDateOrDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2})?)?$/, "Formato esperado: YYYY-MM-DD o ISO-8601");
const RESERVATION_STATUSES = ["draft", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"] as const;
type ReservationStatusValue = (typeof RESERVATION_STATUSES)[number];
const splitCsv = (raw: string): string[] => raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
const isReservationStatus = (v: string): v is ReservationStatusValue =>
  (RESERVATION_STATUSES as readonly string[]).includes(v);
// NOTE: `parse()` takes ZodSchema<T> (input === output), so no transform/default
// here — the csv is validated as a string and split by the handler.
// Tanda L3 (lote B): GET /reservations/:id/cancellation-charge?mode=cancellation|no_show.
const CancellationChargeQuerySchema = z.object({
  mode: z.enum(["cancellation", "no_show"], { errorMap: () => ({ message: "modo no válido; valores: cancellation, no_show" }) }).optional()
});
// ---- Tanda 3 (server-rutas) body/query schemas -----------------------------
// Fiscal categories of packages/compliance indirect-tax.ts (contract A). Typed
// against the package so a catalogue change fails the typecheck here instead of
// silently accepting a category the resolver does not know.
const TAX_CATEGORIES = [
  "accommodation",
  "food_beverage",
  "general_services",
  "transport",
  "tourist_tax",
  "not_subject"
] as const satisfies readonly TaxCategory[];
const twoDecimals = (value: number): boolean => Math.round(value * 100) / 100 === value;
const UpsertTaxRateSchema = z.object({
  category: z.enum(TAX_CATEGORIES),
  ratePercent: z.number().min(0).max(100).refine(twoDecimals, { message: "ratePercent admite como máximo 2 decimales" }),
  calificacion: z.enum(["S1", "N1"]).optional(),
  validFrom: isoDateOnly.optional()
});
const InviteBackOfficeUserSchema = z.object({
  email: z.string().trim().email().max(200),
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).optional(),
  // A staff user without a role holds zero permissions in production (AUTH-07):
  // the role is part of the invitation, not an afterthought.
  roleId: z.string().trim().min(1).max(80),
  mfaRequired: z.boolean().optional(),
  // Tanda 8a (RBAC · L1, design §5.5): an invitation may carry the scope of
  // the assignment it creates on acceptance (property / property_group /
  // legal_entity / organization + the id). Forwarded to the service; the
  // backoffice service of L3 persists it — until then it is ignored.
  scopeType: z.enum(["property", "property_group", "legal_entity", "organization"]).optional(),
  scopeRef: z.string().trim().min(1).max(64).optional()
});
// Tanda 4 (rutas-cors): POST /backoffice/properties/:propertyId/roles. The
// template must be one of the shared ROLE_TEMPLATE_KEYS (packages/shared):
// rejected here with the list of valid keys (400) rather than deep in the
// service, and typed as RoleKey so the call site needs no cast.
const CreateRoleFromTemplateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  templateKey: z
    .string()
    .trim()
    .refine((value): value is RoleKey => (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value), {
      message: `debe ser una plantilla conocida: ${ROLE_TEMPLATE_KEYS.join(", ")}`
    })
});
const InvitationTokenParamsSchema = z.object({ token: z.string().trim().min(16).max(512) });
const AcceptInviteSchema = z.object({
  token: z.string().trim().min(16).max(512),
  // The password policy (length, classes, common list) is enforced by the
  // service with its own 400 message; zod only guards the shape.
  password: z.string().min(1).max(200),
  deviceId: z.string().trim().min(1).max(120).optional()
});
const SesSubmissionListQuerySchema = z.object({
  status: z.string().trim().min(1).max(40).optional(),
  // Corrector L5 (CS-04): with status=failed the discarded rows (SES_DISCARDED, closed history) only come with includeDiscarded=true.
  includeDiscarded: z.enum(["true", "false", "1", "0"]).optional()
});
// Tanda 3 (cierre · server-rutas): filters of GET /properties/:propertyId/verifactu/submissions.
// `limit` / `cursor` / `envelope` are parsed by parsePageQuery, not here.
const VerifactuSubmissionListQuerySchema = z.object({
  status: z.string().trim().min(1).max(40).optional(),
  registroType: z.enum(["alta", "anulacion"]).optional()
});
const UPSELL_CHANNELS = ["pre_stay", "in_stay", "checkout", "kiosk"] as const;
const UpsellOfferFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  offerType: z.string().trim().min(1).max(60),
  price: z.number().min(0).max(999999.99).refine(twoDecimals, { message: "price admite como máximo 2 decimales" }).nullable(),
  taxCategory: z.enum(TAX_CATEGORIES).nullable(),
  code: z.string().trim().min(1).max(60).nullable(),
  description: z.string().trim().max(2000).nullable(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "currency debe ser un código ISO 4217 (p. ej. EUR)"),
  channel: z.enum(UPSELL_CHANNELS).nullable(),
  imageUrl: z.string().trim().url().max(2048).nullable(),
  active: z.boolean(),
  availabilityRulesJson: z.record(z.unknown())
});
const CreateUpsellOfferSchema = UpsellOfferFieldsSchema.partial().required({ name: true, offerType: true });
const PatchUpsellOfferSchema = UpsellOfferFieldsSchema.partial();
type UpsellOfferRow = {
  id: string;
  propertyId: string;
  name: string;
  offerType: string;
  price: { toString(): string } | null;
  taxCode: string | null;
  taxCategory: string | null;
  code: string | null;
  description: string | null;
  currency: string;
  channel: string | null;
  imageUrl: string | null;
  availabilityRulesJson: unknown;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};
/** API shape of an upsell offer: Decimal → number, dates → ISO. */
function upsellOfferView(row: UpsellOfferRow) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    offerType: row.offerType,
    price: row.price === null ? null : Number(row.price.toString()),
    currency: row.currency,
    taxCategory: row.taxCategory,
    taxCode: row.taxCode,
    code: row.code,
    description: row.description,
    channel: row.channel,
    imageUrl: row.imageUrl,
    active: row.active,
    availabilityRulesJson: row.availabilityRulesJson ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

const ReservationListQuerySchema = z.object({
  // csv of ReservationStatus, e.g. status=confirmed,checked_in
  status: z
    .string()
    .refine((raw) => splitCsv(raw).length > 0 && splitCsv(raw).every(isReservationStatus), {
      message: `status debe ser una lista separada por comas de: ${RESERVATION_STATUSES.join(", ")}`
    })
    .optional(),
  // stay overlap window: arrivalDate < to && departureDate > from
  from: isoDateOnly.optional(),
  to: isoDateOnly.optional(),
  // arrivals window (inclusive)
  arrivalFrom: isoDateOnly.optional(),
  arrivalTo: isoDateOnly.optional(),
  // free text over code / bookerName / primary guest
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["arrival_desc", "arrival_asc"]).optional()
});
// FISC-05.c: `date=YYYY-MM-DD` is an alias for the whole property-local
// business day; `from`/`to` remain the explicit window. Unknown keys are
// rejected (a typo such as `outlet=` would otherwise silently widen the
// closure to every outlet). The window itself is resolved by
// `resolveCashSummaryWindow` (pos-cash-closure.service). Finanzas 2026-09-16:
// the POS query/body schemas moved to modules/pos/pos.schemas.ts with the routes.
// NEW-REV-A: a calendar month. `2024-13` used to reach the services and blow
// up in Date arithmetic (500); now it is a 400 at the handler boundary.
const isoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month debe tener formato YYYY-MM");
const MeetingPackQuerySchema = z.object({
  month: isoMonth.optional()
});
// Tanda 3 (cierre): optional recipient name when issuing a draft that carries a NIF (VeriFactu F1 Destinatarios).
const IssueInvoiceBodySchema = z.object({ customerName: z.string().trim().min(1).max(500).optional() });
const BudgetVarianceQuerySchema = z.object({
  month: isoMonth.optional()
});
/** Longest window GET /revenue/properties/:id/period-metrics serves per call (one leap year). */
const PERIOD_METRICS_MAX_DAYS = 366;
// NEW-REV-C: the legacy history-forecast export only produces csv/xls. A
// `format` outside that set (e.g. "pdf") is a 400, never a silent csv.
const HistoryForecastExportBodySchema = z.object({
  format: z
    .enum(["csv", "xls", "xlsx"], { errorMap: () => ({ message: "Formato no disponible: usa csv o xls." }) })
    .optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  fromDate: z.string().max(40).optional(),
  toDate: z.string().max(40).optional()
});
// REC-07: list filters used to be read straight from `request.query`; a
// repeated parameter (`?search=a&search=b`) arrives as an array and `.trim()`
// threw a TypeError (500). Both schemas `passthrough()` so the pagination
// keys read by `parsePageQuery` (limit / cursor / envelope) are untouched.
const GuestListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    // Consumed by the global tenant guard (pickPropertyId); the list itself is
    // organization-scoped.
    propertyId: z.string().optional()
  })
  .passthrough();
const InvoiceListQuerySchema = z
  .object({
    // csv of InvoiceStatus; the service validates the individual values.
    status: z.string().max(100).optional(),
    from: isoDateOnly.optional(),
    to: isoDateOnly.optional(),
    q: z.string().trim().max(100).optional()
  })
  .passthrough()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "El parámetro to debe ser posterior o igual a from."
  });
import {
  LoginSchema,
  ChangePasswordSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  CreateUserSchema,
  CreateReservationSchema,
  UpdateReservationBodySchema,
  CheckInSchema,
  CheckOutSchema,
  CancelReservationSchema,
  NoShowReservationSchema,
  AssignRoomSchema,
  CreateFolioLineSchema,
  ApplyPaymentSchema,
  IssueInvoiceSchema,
  RefundPaymentSchema,
  CancelInvoiceSchema,
  MarkInvoicePaidSchema,
  SendInvoiceEmailSchema,
  PaymentTokenSchema,
  CreateGuestSchema,
  UpdateGuestSchema,
  RectifyInvoiceSchema,
  CreateFiscalYearSchema,
  CloseFiscalYearSchema,
  ReopenFiscalYearSchema,
  CreateGdprRequestSchema,
  ExecuteErasureSchema,
  RejectGdprRequestSchema,
  QuoteAvailabilitySchema,
  CreatePayrollContractSchema,
  PayrollListQuerySchema,
  CreateCommissionRuleSchema,
  decimalInputToNumber
} from "./schemas/index.js";
import { globalSearch, type SearchHit } from "./modules/search/search.service.js";
import { webhooksRoutes } from "./routes/webhooks.routes.js";
import { assistantRoutes } from "./routes/assistant.routes.js";
import { touristTaxRoutes } from "./routes/tourist-tax.routes.js";
import { registerWhatsappWebhookRoutes } from "./routes/webhooks-whatsapp.routes.js";
import { answerQuestion as assistantAnswer } from "./modules/assistant/assistant.service.js";
import { ASSISTANT_RETENTION_DAYS, purgeAssistantConversations } from "./modules/assistant/assistant-memory.service.js";
import {
  computeTouristTax,
  applyTouristTaxToFolio,
  listApplicationsForPeriod as listTouristTaxApps,
  listRates as listTouristTaxRates,
  createRate as createTouristTaxRate
} from "./modules/tourist-tax/tourist-tax.service.js";
import { seedTouristTaxRates } from "./modules/tourist-tax/tourist-tax.seed.js";
import { issueWalletPass, verifyUnlock as verifyWalletUnlock, revokeWalletPass } from "./modules/mobile-keys/wallet-pass.service.js";
import { importCsb43, generateRemittance as generateSepaRemittanceSvc, validateIban as validateIbanSvc } from "./modules/banking-spain/banking.service.js";
import {
  getCatalog as esrsCatalog,
  listIndicators as esrsList,
  upsertIndicator as esrsUpsert,
  generateReport as esrsGenerate,
  getReport as esrsGet
} from "./modules/esrs/esrs.service.js";
import {
  issueAuthorizationCode,
  exchangeCodeForToken,
  clientCredentialsToken,
  refreshAccessToken,
  OAUTH_SCOPES
} from "./modules/marketplace/oauth.service.js";
import {
  listPublishedListings,
  getListing,
  publishListing,
  installApp,
  uninstallApp,
  listInstallations,
  createDeveloperApp,
  rotateClientSecret,
  listDeveloperApps,
  MARKETPLACE_CATEGORIES
} from "./modules/marketplace/marketplace.service.js";
import {
  submitInvoiceToTbai,
  verifyTbaiChain,
  listSubmissions as listTbaiSubmissionsForal,
  getTerritoryConfig as getTbaiTerritories,
  FORAL_TERRITORIES,
  type ForalTerritory
} from "./modules/tbai/tbai.service.js";
import {
  listStockLocations, createStockLocation,
  listInventoryItems, createInventoryItem, recordStockMovement,
  listStockBalances, lowStockReport,
  listMenuItems, getMenuItemWithRecipe, createMenuItem, addMenuRecipe, deleteMenuRecipe
} from "./modules/fnb-inventory/fnb-inventory.service.js";
import { getComplianceAssistant, extractComplianceDocumentDates } from "./modules/compliance/compliance-assistant.service.js";
import {
  createJournalEntryDraft,
  listJournalEntries,
  postJournalEntry
} from "./modules/accounting/accounting.service.js";
import {
  createBankAccount,
  getBankAccountBalance,
  listBankAccounts
} from "./modules/banking/bank-account.service.js";
import {
  getStatement,
  importStatementFromCsv,
  listStatements
} from "./modules/banking/bank-statement.service.js";
import {
  autoMatchStatement,
  manualMatch,
  reconciliationStatus,
  unmatch
} from "./modules/banking/reconciliation.service.js";
import {
  cancelInvoice,
  createInvoiceFromFolio,
  createRectifyingInvoice,
  getInvoice,
  getInvoiceBranding,
  updateInvoiceBranding,
  issueInvoice,
  listInvoices,
  listRectifyingInvoices,
  type RectifyingLineAdjustment,
  type RectifyingReasonCode
} from "./modules/invoicing/invoice.service.js";
import { createInvoiceDraft, CreateInvoiceDraftSchema } from "./modules/invoicing/invoicing.service.js";
import {
  exportOperationalReport,
  getBillingReport,
  getReportCatalog,
  getReportExportFile,
  getReservationReport
} from "./modules/reporting/reporting.service.js";
import {
  addHousekeepingPhoto,
  createDepartureCleaningTask,
  createHousekeepingTask,
  getHousekeepingBoard,
  markRoomClean,
  markRoomInspected,
  updateHousekeepingTask
} from "./modules/housekeeping/housekeeping.service.js";
// Tanda L5 (lote A): estado de habitación unificado — la ruta libre de limpieza
// pasa por la transición auditada y los KPIs de habitaciones se pliegan con el
// helper único (mismas cifras que /dashboards/housekeeping y operations-director).
import { applyRoomTransition, foldRoomStateCounts, normalizeHousekeepingInput } from "./modules/housekeeping/room-state.service.js";
import {
  attachWorkOrderMedia,
  blockRoomForMaintenance,
  createWorkOrder,
  listWorkOrders,
  resolveWorkOrder,
  updateWorkOrder
} from "./modules/maintenance/maintenance.service.js";
import {
  createAiReplyDraft,
  createServiceRequest,
  listConversations,
  listMessages,
  sendConversationMessage,
  updateServiceRequest
} from "./modules/messaging/messaging.service.js";
import {
  calculateRoomProfitability,
  createAsset,
  createCapexItem,
  createCapexProject,
  getOwnerDashboard,
  listAssets,
  listCapexProjects,
  listFixedAssets,
  updateAsset,
  updateCapexProject
} from "./modules/assets/assets.service.js";
import { listOfflineSyncRecords, syncOfflineActions } from "./modules/offline/offline.service.js";
import {
  disablePropertyModule,
  enablePropertyModule,
  getModuleDependencies,
  listModuleCatalog,
  listPropertyModules
} from "./modules/product-modules/product-modules.service.js";
import {
  connectIntegration,
  disconnectIntegration,
  listIntegrationCategories,
  listIntegrationEvents,
  listIntegrationProviders,
  listPropertyIntegrations,
  testIntegrationConnection
} from "./modules/integrations/integrations.service.js";
import {
  approveGoLive,
  applyCategoryImport,
  applyCategoryTemplate,
  assignRoomsToHousekeepingSection,
  assignRoomsToMaintenanceArea,
  bulkCreateRooms,
  bulkUpdateRooms,
  configureModule,
  createBackOfficeRoomType,
  createBedType,
  createBuilding,
  createCategoryOption,
  createCustomField,
  createDepartment,
  createDocumentTemplate,
  createFloor,
  createHousekeepingSection,
  createMaintenanceArea,
  createRoomFeature,
  createSpace,
  createZone,
  deactivateBackOfficeRoomType,
  disableBackOfficeUser,
  assignUserToDepartment,
  exportCategories,
  getAccountingSettings,
  getAiSettings,
  getBackOfficeDashboard,
  getBillingSettings,
  getComplianceSettings,
  getConfigurationCategory,
  getConfigurationCenter,
  getEntityCustomFields,
  getHousekeepingConfiguration,
  getMaintenanceConfiguration,
  getModuleConfiguration,
  getPropertyImport,
  getPropertyMap,
  getPropertySetupForm,
  getReadiness,
  getSetupProgress,
  listCategoryTemplates,
  inviteBackOfficeUser,
  listPropertyRoles,
  listBackOfficeAudit,
  listBackOfficeModules,
  listBackOfficeRoomTypes,
  listBackOfficeUsers,
  listBedTypes,
  listConfigurationCategories,
  listCustomFields,
  listDepartments,
  listDocumentTemplates,
  listPermissionCatalog,
  listManualSetupOptions,
  listPropertySetupForms,
  getManualSetupOptionDetail,
  listRoleCatalog,
  listRoomFeatures,
  listRoomsForRoomType,
  mergeBackOfficeRoomTypes,
  patchAccountingSettings,
  patchAiSettings,
  patchBackOfficeRoomType,
  patchBillingSettings,
  patchCategoryOption,
  patchCustomField,
  patchEntityCustomFields,
  patchComplianceSettings,
  previewCategoryImport,
  previewCategoryTemplate,
  recalculateModuleHealth,
  recalculateReadiness,
  updateDocumentTemplate,
  updateSetupStep,
  reorderCategoryOptions,
  seedDefaultCategories,
  saveManualSetupOption,
  savePropertySetupForm,
  setCategoryOptionActive,
  suggestPropertyCategories,
  upsertHousekeepingRule,
  upsertMaintenanceRule
} from "./modules/backoffice/backoffice.service.js";
import {
  listTenants,
  getTenantDetail,
  createTenant,
  regenerateTempPassword,
  toggleTenantModule,
  getTenantAuditLog
} from "./modules/admin-console/tenant-admin.service.js";
import {
  createAdvancedRecord,
  listAdvancedRecords,
  transitionAdvancedRecord
} from "./modules/advanced/advanced-modules.service.js";
import {
  analyzeOnboardingProject,
  applyMigration,
  approveGoLive as approveOnboardingGoLive,
  classifyOnboardingFileApi,
  createOnboardingProject,
  createSourceConnection,
  extractOnboardingFileApi,
  getCutoverPlan,
  getDryRunResult,
  getGoLiveReadiness,
  getHumanReviewQueue,
  getOnboardingProject,
  listExtractedEntities,
  listMappingSuggestions,
  listOnboardingFiles,
  listOnboardingProjects,
  mapFloorPlanFile,
  patchOnboardingProject,
  parseRoomWalkSetup,
  reviewMappingSuggestion,
  rollbackMigration,
  runCutoverDeltaImportDryRun,
  runMigrationDryRun,
  syncSourceConnection,
  testSourceConnection,
  uploadOnboardingFile
} from "./modules/onboarding/onboarding.service.js";
import {
  approveReview as approveHumanReview,
  assignReview as assignHumanReview,
  enqueueReview as enqueueHumanReview,
  escalateReview as escalateHumanReview,
  getReviewItem as getHumanReviewItem,
  listReviewQueue as listHumanReviewQueue,
  rejectReview as rejectHumanReview,
  reviewQueueStats as humanReviewQueueStats,
  type ReviewStatus as HumanReviewStatus
} from "./modules/ai-operations/human-review.service.js";
import {
  archivePromptVersion as govArchivePromptVersion,
  assignIncident as govAssignIncident,
  costDashboard as govCostDashboard,
  createEvaluation as govCreateEvaluation,
  createIncident as govCreateIncident,
  createPromptVersion as govCreatePromptVersion,
  diffPromptVersions as govDiffPromptVersions,
  getPromptVersions as govGetPromptVersions,
  listEvaluations as govListEvaluations,
  listIncidents as govListIncidents,
  listPolicies as govListPolicies,
  listPrompts as govListPrompts,
  publishPromptVersion as govPublishPromptVersion,
  reopenIncident as govReopenIncident,
  resolveIncident as govResolveIncident,
  runEvaluation as govRunEvaluation,
  setPolicyActive as govSetPolicyActive,
  upsertPolicy as govUpsertPolicy
} from "./modules/ai-operations/governance.service.js";

// PILOT-D2 · Sentry init (carga lazy para no romper si SENTRY_DSN no está).
// Llamamos a esto desde buildApiServer al inicio para que la traza de errores
// no perdidos del setup hooks ya esté activa.
let sentryInitialized = false;
async function initSentry() {
  if (sentryInitialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || dsn === "change-me" || dsn === "") {
    console.log("[sentry] disabled (SENTRY_DSN no configurado)");
    sentryInitialized = true;
    return;
  }
  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? "development",
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
      // No queremos PII en Sentry — el cliente firmó GDPR estricto.
      sendDefaultPii: false,
      beforeSend(event) {
        // Saca campos comunes que pueden tener PII.
        if (event.request?.headers) {
          delete event.request.headers["authorization"];
          delete event.request.headers["cookie"];
        }
        if (event.request?.data) {
          // No logueamos cuerpos de request para evitar PII (passwords, DNIs…).
          event.request.data = "[redacted]";
        }
        return event;
      }
    });
    sentryInitialized = true;
    console.log(`[sentry] initialized · env=${process.env.NODE_ENV ?? "development"}`);
  } catch (err) {
    console.error("[sentry] init failed", err);
  }
}

// AUTH-05 (audit 2026-09-14): async on purpose. @fastify/rate-limit does not
// add a global onRequest hook — it attaches a per-route limiter through an
// `onRoute` hook, which only exists once the plugin has LOADED. Without the
// `await` below, avvio (autostart:false) deferred the plugin body to
// app.ready()/listen(), i.e. AFTER the ~780 inline routes were declared, so no
// route ever got a limiter (no x-ratelimit-* headers, no 429 — login included).
// Callers: start() below and tests/integration (`await buildApiServer()`).

/**
 * Corrector Tanda CHK (SEC-6): URL de la petición para el log con cualquier
 * `token=…` (enlace del portal del huésped) sustituido por `token=<redacted>`.
 * Pura; exportada para tests/cors-contract.test.mjs.
 */
export function redactTokenInUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") return url;
  return url.replace(/([?&]token=)[^&#]*/gi, "$1<redacted>");
}

export async function buildApiServer() {
  // Tanda 4 (rutas-cors) · env contract (lib/env.ts) before anything else
  // reads the environment: with NODE_ENV=production assertEnv throws one
  // Error carrying the whole list of violations (the top-level await in the
  // entry guard below then exits 1 with that message); in dev/test it only
  // console.warns, so app.inject in the integration suite keeps booting.
  // Deliberately ahead of Sentry and of registerAuthContext (AUTH-04): a
  // misconfigured process must not initialise anything.
  assertEnv();

  // Tanda 4 · cierre: embedders that never go through start() (the
  // integration suite's `await buildApiServer()`, ad-hoc scripts) still seal
  // audit events, and each of them used to start a fresh genesis row in the
  // shared audit_events table. Idempotent: a no-op when start() already
  // hydrated the ring.
  await hydrateAuditChainFromPostgres();

  // Init Sentry sync (fire-and-forget). El error handler de Fastify lo
  // recoge antes incluso de que Sentry esté listo (Sentry buffera).
  void initSentry();

  // Corrector Tanda CHK (SEC-6): el serializador de `req` redacta cualquier `token=` de la URL
  // (el enlace del portal del huésped abre GET /guest-portal/check-in?token=…; un token en claro
  // en los logs equivale a la sesión del huésped). Resto de campos como el serializador por defecto.
  const app = Fastify({
    logger: {
      serializers: {
        req: (request) => ({
          method: request.method,
          url: redactTokenInUrl(request.url),
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort
        })
      }
    }
  });
  // E1: el fallo de persistencia de auditoría (P2002…) sale por pino, no por console.error.
  setAuditLogger(app.log.child({ module: "audit" }));

  // Global error handler: map known errors to the right status code and a
  // clean JSON body. Previously service-level `throw new Error(...)` surfaced
  // as HTTP 500 with a leaked stack; now validation/typed errors return 4xx
  // and unknown errors return a generic 500 without leaking internals.
  app.setErrorHandler((error, request, reply) => {
    const statusCode = statusCodeForError(error);
    const correlationId =
      (request.headers[OBSERVABILITY_HEADERS.correlationId] as string | undefined) ?? undefined;
    if (statusCode >= 500) {
      request.log.error({ err: error, correlationId }, "request failed");
      // PILOT-D2: reportar a Sentry (lazy import — no bloquea si no configurado)
      if (sentryInitialized) {
        void import("@sentry/node").then((Sentry) => {
          Sentry.withScope((scope) => {
            scope.setTag("correlationId", correlationId ?? "unknown");
            scope.setTag("url", request.url);
            scope.setTag("method", request.method);
            if (request.userContext?.userId) {
              scope.setUser({ id: request.userContext.userId });
            }
            Sentry.captureException(error);
          });
        }).catch(() => undefined);
      }
    } else {
      request.log.warn({ err: error, correlationId, statusCode }, "request rejected");
    }
    // AUTH-05: expose the message of any 4xx that carries one — typed
    // HttpErrors, but also plain `{ statusCode, message }` objects thrown by
    // plugins (e.g. @fastify/rate-limit throws whatever errorResponseBuilder
    // returns). A 429 used to surface as "Internal Server Error" because the
    // thrown value was not an `Error` instance.
    const thrownMessage = (error as { message?: unknown } | null | undefined)?.message;
    // Tanda 4 · cierre: a Prisma known-request error that reaches this handler
    // untranslated (P2002 unique violation, P2025 not found, P2003 FK, P2000
    // too long) used to leak the whole invocation text — and, in development,
    // file paths and line numbers — into the 4xx body. describePrismaError
    // turns it into a short Spanish message plus machine-readable details
    // ({ code: "UNIQUE_VIOLATION", target }); the original error is still in
    // the log line above with its full text.
    const prismaDescription = describePrismaError(error);
    // Tanda 5 (L1c · api): Fastify's body/content-type errors (FST_ERR_CTP_*:
    // empty or invalid JSON body, unsupported media type, body too large) are
    // 4xx with an English message — translated here like the Prisma ones.
    const contentTypeDescription = describeFastifyContentTypeError(error);
    const exposeMessage = prismaDescription
      ? prismaDescription.message
      : contentTypeDescription
        ? contentTypeDescription.message
        : statusCode < 500 && typeof thrownMessage === "string"
          ? thrownMessage
          : "Internal Server Error";
    const errorLabels: Record<number, string> = {
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      409: "Conflict",
      413: "Payload Too Large",
      415: "Unsupported Media Type",
      429: "Too Many Requests"
    };
    // Typed 4xx errors may carry machine-readable `details` (e.g. the check-out
    // 409 exposes { code: "BALANCE_DUE", balanceDue }) so clients can branch on
    // a code instead of parsing the Spanish message. Never forwarded on 5xx.
    const details = prismaDescription
      ? prismaDescription.details
      : statusCode < 500 && error && typeof error === "object" && "details" in error
        ? (error as { details?: unknown }).details
        : undefined;
    reply.code(statusCode).send({
      statusCode,
      error: statusCode < 500 ? (errorLabels[statusCode] ?? "Bad Request") : "Internal Server Error",
      message: exposeMessage,
      ...(correlationId ? { correlationId } : {}),
      ...(details !== undefined ? { details } : {})
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      statusCode: 404,
      error: "Not Found",
      message: `Route ${request.method} ${request.url} not found`
    });
  });

  // AUTH-08 (Tanda 4 · rutas-cors) · allow-list CORS. The list comes from
  // CORS_ALLOWED_ORIGINS (comma-separated origins, normalised by
  // resolveCorsOrigins in lib/env.ts, which also folds in the deprecated
  // PILOT_PUBLIC_ORIGIN alias). Decision per request:
  //   · no Origin header (curl, same-origin behind Caddy, server-to-server)
  //     → allowed (nothing to reflect);
  //   · Origin in the list → allowed (exact match, case-insensitive);
  //   · outside production (`devFallback` from the contract, AND-ed with
  //     NODE_ENV so the fallback can never open in production) → also
  //     http(s)://localhost, 127.0.0.1 and 192.168.x.x with an optional port,
  //     so `pnpm dev:web` (:5173) and a tablet on the hotel LAN work without
  //     configuration;
  //   · anything else → refused: no Access-Control-Allow-Origin header, the
  //     browser blocks the read (the handler still runs: Bearer auth, not the
  //     CORS layer, is the access control), and the origin is logged ONCE so a
  //     misconfigured deployment shows up in the logs without turning the
  //     Origin header into a log-flood vector.
  // `credentials: false` on purpose: the SPA authenticates with
  // `Authorization: Bearer` (localStorage) and the API sets no cookies (no
  // @fastify/cookie), so reflecting Access-Control-Allow-Credentials was pure
  // attack surface next to the old 192.168.x.x reflection (CWE-942). If a
  // cookie-based client ever appears, turn it on ONLY together with an
  // explicit list — never with a wildcard or a regex.
  const DEV_CORS_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/;
  const MAX_LOGGED_CORS_REJECTIONS = 500;
  const corsRejectedOrigins = new Set<string>();
  // Resolved lazily and re-resolved only when the governing env changes
  // (the integration suite flips NODE_ENV / CORS_ALLOWED_ORIGINS with
  // withEnv on an already booted app); steady state is one string compare.
  let corsPolicyCache: { key: string; allowed: Set<string>; devFallback: boolean } | null = null;
  const corsPolicy = () => {
    const nodeEnv = process.env.NODE_ENV ?? "";
    const key = `${nodeEnv}|${process.env.CORS_ALLOWED_ORIGINS ?? ""}|${process.env.PILOT_PUBLIC_ORIGIN ?? ""}`;
    if (!corsPolicyCache || corsPolicyCache.key !== key) {
      const resolved = resolveCorsOrigins();
      corsPolicyCache = {
        key,
        allowed: new Set(resolved.allowed.map((entry: string) => entry.trim().toLowerCase())),
        devFallback: resolved.devFallback && nodeEnv !== "production"
      };
    }
    return corsPolicyCache;
  };
  const isCorsOriginAllowed = (origin: string): boolean => {
    const policy = corsPolicy();
    const normalized = origin.trim().toLowerCase();
    if (policy.allowed.has(normalized)) return true;
    if (policy.devFallback && DEV_CORS_ORIGIN.test(normalized)) return true;
    if (!corsRejectedOrigins.has(normalized) && corsRejectedOrigins.size < MAX_LOGGED_CORS_REJECTIONS) {
      corsRejectedOrigins.add(normalized);
      app.log.warn(
        { origin: normalized, allowed: policy.allowed.size, devFallback: policy.devFallback },
        "[cors] origen no permitido — añádelo a CORS_ALLOWED_ORIGINS si es legítimo"
      );
    }
    return false;
  };
  {
    const policy = corsPolicy();
    app.log.info(
      { allowed: [...policy.allowed], devFallback: policy.devFallback, credentials: false },
      policy.allowed.size === 0 && !policy.devFallback
        ? "[cors] sin CORS_ALLOWED_ORIGINS: solo peticiones same-origin (Caddy) o sin cabecera Origin"
        : "[cors] política cargada"
    );
  }
  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, isCorsOriginAllowed(origin));
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Tanda CHK (corrector REV3-04): el portal del huésped y el kiosco autentican por cabecera
    // (`x-guest-token` / `x-kiosk-token`, apps/guest-web/src/api/client.ts) desde otro origen en dev (:5189 → :3919).
    allowedHeaders: ["Content-Type", "Authorization", "x-correlation-id", "x-property-id", "x-guest-token", "x-kiosk-token"],
    // Headers the SPA is allowed to READ on a cross-origin response (dev:
    // :5173 → :3000): pagination (lib/pagination.ts), correlation id and the
    // rate-limit budget. Same-origin (production behind Caddy) never needs it.
    exposedHeaders: ["x-correlation-id", "X-Total-Count", "X-Next-Cursor", "x-ratelimit-limit", "x-ratelimit-remaining", "retry-after"],
    // Cache the preflight for 10 minutes: one OPTIONS per route per browser
    // instead of one per request.
    maxAge: 600
  });

  // PILOT-D1: rate limit global moderado + restricción dura en /auth/*.
  // Anti-bruteforce + protección contra abuso. Usa memoria local (suficiente
  // para single-node piloto); en cluster usaríamos Redis.
  // AUTH-05: MUST be awaited before the first inline route (see the note on
  // buildApiServer) — the limiter is attached per route via `onRoute`.
  await app.register(fastifyRateLimit, {
    // SECURITY (audit 2026-06 · H3): default-on. Every route gets a baseline
    // limit; auth/critical routes harden it further via `config.rateLimit`.
    global: true,
    // RATE_LIMIT_MAX: requests per minute per bucket (see keyGenerator).
    // Default 600 — a front desk sharing one staff login (several PCs, one
    // userId) used to exhaust the old 200/min bucket in a busy check-in wave
    // and lock the whole reception out; the bucket is now user+IP so every
    // PC gets its own 600/min. Lower it per deployment if needed.
    max: Number(process.env.RATE_LIMIT_MAX ?? 600),
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      // Only trust x-forwarded-for behind a known proxy (TRUST_PROXY=1, e.g.
      // Caddy in prod). Otherwise the header is client-spoofable and lets an
      // attacker dodge the limit by rotating it — fall back to the socket IP.
      let clientIp = req.ip;
      if (process.env.TRUST_PROXY === "1") {
        const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
        if (xff) clientIp = xff;
      }
      // Bucket per AUTHENTICATED user AND client IP: a whole front desk behind
      // one NAT router would otherwise share a single bucket by IP, and a
      // front desk sharing one login would share a single bucket by userId —
      // either way locking each other out. The route-level limiter runs after
      // the app-level auth hook (registerAuthContext), so userContext is
      // populated here. Public routes (login, password reset, health…) and the
      // demo fallback context (isAuthenticated=false, not a real session) are
      // keyed by client IP only.
      if (req.isAuthenticated && req.userContext?.userId) {
        return `user:${req.userContext.userId}:${clientIp}`;
      }
      return `ip:${clientIp}`;
    },
    // The plugin THROWS whatever this returns, so it must be a real Error:
    // a plain object reached setErrorHandler without `message` being
    // exposed and the 429 body read "Internal Server Error" (AUTH-05).
    errorResponseBuilder: () => {
      const err = new Error("Demasiadas peticiones. Reintenta en unos segundos.");
      Object.assign(err, { statusCode: 429 });
      return err;
    }
  });

  // Sprint 44: the sandbox channel-manager mock receives text/xml bodies from
  // the Booking adapter's http wrapper. Fastify only parses application/json out
  // of the box, so register a raw-string parser for XML content types; the mock
  // handler reads the body as a string and does not need it structured.
  for (const contentType of ["text/xml", "application/xml"]) {
    app.addContentTypeParser(contentType, { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    const incomingCorrelationId = request.headers[OBSERVABILITY_HEADERS.correlationId];
    const correlationId =
      typeof incomingCorrelationId === "string"
        ? incomingCorrelationId
        : Array.isArray(incomingCorrelationId)
          ? incomingCorrelationId[0]
          : createId("corr");
    request.headers[OBSERVABILITY_HEADERS.correlationId] = correlationId;
    reply.header(OBSERVABILITY_HEADERS.correlationId, correlationId);
    reply.header(OBSERVABILITY_HEADERS.serviceName, SERVICE_NAMES.api);
  });

  registerAuthContext(app);

  // Tanda 3 (CFG-P1-6) · forced password rotation. A user whose session was
  // opened with a temporary password (User.mustChangePassword, carried in the
  // context by loadUserContext) may only reach the routes needed to rotate it
  // (PASSWORD_CHANGE_ALLOWLIST in lib/auth-context.ts: change-password,
  // password-policy, /users/me/*, sessions…, prefix-matched like
  // PUBLIC_PREFIXES). Everything else answers the 403 built next to the
  // allowlist (details.code = PASSWORD_CHANGE_REQUIRED) so the front redirects
  // to the change-password screen instead of showing a permissions error. Only
  // real sessions are gated (the demo fallback is never a temp-password login);
  // public routes and unknown paths (404) are left alone. Mounted BEFORE the
  // permission gate: a user who must rotate first gets that answer, not a 403
  // about permissions they may also lack.
  // Tanda 8a (RBAC · L1): the property id of a request is picked ONCE
  // (path param, then query string, then the exact `propertyId` body key) and
  // shared by the scope hook below and the tenant guard further down.
  function pickPropertyId(request: { params: unknown; query: unknown; body: unknown }): string | null {
    for (const source of [request.params, request.query, request.body]) {
      const candidate = (source as { propertyId?: unknown } | null | undefined)?.propertyId;
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
    return null;
  }

  app.addHook("preHandler", async (request) => {
    if (request.is404) return;
    if (!request.isAuthenticated || !request.userContext?.mustChangePassword) return;
    const routePath = request.routeOptions.url ?? request.url.split("?")[0];
    if (isPublicRoute(routePath) || isPasswordChangeAllowedRoute(routePath)) return;
    throw passwordChangeRequiredError();
  });

  // ── Tanda 8a (RBAC · L1) · ámbito por petición (design §6.2, H1) ────────────
  // ONE access decision per request = template × scope × module, computed for
  // the property the request acts on, not for the user's first assignment:
  //   1. `:propertyId` param / query / body (`pickPropertyId`) — not validated
  //      here for platform admins (the tenant guard behind the gate still does
  //      existence, organisation and re-pointing); a NON-platform user whose
  //      scope does not cover it gets the same opaque 404 the tenant guard
  //      answers, but BEFORE the permission gate (with an empty key set the
  //      gate would answer 403 and leak that the property exists);
  //   2. the `x-property-id` header the front sends for routes without a
  //      property (≤ 64 chars, [A-Za-z0-9_-]): out of scope → audit
  //      ACCESS_DENIED { reason: "out_of_scope" } (1/min per user and route)
  //      and opaque 404; platform admins go through grantPropertyAccess (the
  //      property must exist; organizationId is re-pointed);
  //   3. nothing → `null` = organisation route: union of the legal_entity /
  //      organization assignments, or the intersection of the property ones
  //      (lib/rbac-scope.ts permissionsFor).
  // The resolved keys are written into `request.userContext.permissions` (the
  // gate below keeps reading `userContext?.permissions ?? []`, pinned by
  // tests/api-route-permissions-contract.test.mjs) and the property into
  // `request.rbacScope`; lib/tenancy.ts assertEntityAccess re-resolves both when
  // an entity hangs from another property (the entity always wins). Switching
  // the active property is audited once per (session, property). Inside a
  // break-glass session every request carries `bg_<sessionId>_<corr>` as
  // correlation id (§4.8). The token-less demo fallback is left untouched.
  const PROPERTY_HEADER = "x-property-id";
  const PROPERTY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  const ACCESS_DENIED_DEDUPE_MS = 60_000;
  const accessDeniedSeen = new Map<string, number>();
  const propertySwitchSeen = new Set<string>();
  /** True once per minute per (user, key): the audit trail records one ACCESS_DENIED per user, route and minute. */
  function shouldAuditDenial(userId: string, key: string): boolean {
    const now = Date.now();
    if (accessDeniedSeen.size > 10_000) {
      for (const [seenKey, at] of accessDeniedSeen) if (at + ACCESS_DENIED_DEDUPE_MS < now) accessDeniedSeen.delete(seenKey);
    }
    const dedupeKey = `${userId}|${key}`;
    const last = accessDeniedSeen.get(dedupeKey);
    if (last !== undefined && last + ACCESS_DENIED_DEDUPE_MS > now) return false;
    accessDeniedSeen.set(dedupeKey, now);
    return true;
  }
  function requestCorrelationId(request: { headers: Record<string, unknown> }): string | undefined {
    const value = request.headers[OBSERVABILITY_HEADERS.correlationId];
    return typeof value === "string" ? value : undefined;
  }
  function headerPropertyId(request: { headers: Record<string, unknown> }): string | null {
    const raw = request.headers[PROPERTY_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && PROPERTY_ID_PATTERN.test(value) ? value : null;
  }

  app.addHook("preHandler", async (request, reply) => {
    if (request.is404) return;
    if (!request.isAuthenticated) return;
    const routePath = request.routeOptions.url ?? request.url.split("?")[0];
    if (isPublicRoute(routePath)) return;
    const context = request.userContext;
    if (!context?.assignments) return; // contexts assembled outside loadUserContext keep their permissions
    if (context.breakGlassSessionId) {
      const correlationId = requestCorrelationId(request) ?? createId("corr");
      const tagged = correlationId.startsWith("bg_") ? correlationId : `bg_${context.breakGlassSessionId}_${correlationId}`;
      request.headers[OBSERVABILITY_HEADERS.correlationId] = tagged;
      reply.header(OBSERVABILITY_HEADERS.correlationId, tagged);
    }
    let propertyId = pickPropertyId(request);
    let resolvedFrom: "param" | "header" | "none" = propertyId ? "param" : "none";
    if (!propertyId) {
      propertyId = headerPropertyId(request);
      if (propertyId) resolvedFrom = "header";
    }
    const scope = await loadUserScope(context.userId, context.organizationId);
    const platformAdmin = context.isPlatformAdmin === true;
    if (propertyId && !platformAdmin && !coversProperty(scope, propertyId)) {
      if (shouldAuditDenial(context.userId, `scope:${request.method} ${routePath}`)) {
        recordAuditEvent({
          organizationId: context.organizationId,
          actorUserId: context.userId,
          actorType: "user",
          action: "ACCESS_DENIED",
          entityType: "route",
          entityId: `${request.method} ${routePath}`,
          afterJson: { reason: "out_of_scope", resolvedFrom, riskLevel: routeRiskLevel(request.method, routePath) },
          ipAddress: request.ip,
          deviceId: context.deviceId,
          correlationId: requestCorrelationId(request)
        });
      }
      throw new NotFoundError("Propiedad no encontrada.");
    }
    if (propertyId && resolvedFrom === "header" && platformAdmin) {
      // The property must exist; organizationId is re-pointed like the tenant guard does.
      await grantPropertyAccess(request, propertyId);
    }
    request.rbacScope = { propertyId, resolvedFrom };
    const resolved = propertyId && platformAdmin && !coversProperty(scope, propertyId) ? permissionsFor(scope, null) : permissionsFor(scope, propertyId);
    context.permissions = unionPermissions(resolved);
    if (propertyId && propertyId !== context.propertyId) {
      const previous = context.propertyId;
      context.propertyId = propertyId;
      const switchKey = `${context.sessionId ?? context.userId}|${propertyId}`;
      if (!propertySwitchSeen.has(switchKey)) {
        if (propertySwitchSeen.size > 10_000) propertySwitchSeen.clear();
        propertySwitchSeen.add(switchKey);
        recordAuditEvent({
          organizationId: context.organizationId,
          propertyId,
          actorUserId: context.userId,
          actorType: "user",
          action: "PROPERTY_SWITCHED",
          entityType: "property",
          entityId: propertyId,
          beforeJson: { propertyId: previous },
          afterJson: { propertyId, resolvedFrom },
          ipAddress: request.ip,
          deviceId: context.deviceId,
          correlationId: requestCorrelationId(request)
        });
      }
    }
  });

  app.addHook("preHandler", async (request) => {
    // P6: Fastify runs app-level hooks for the not-found route too. An
    // unknown path has no manifest entry, so strict RBAC turned every typo
    // into a 403; let it reach setNotFoundHandler (404) instead.
    if (request.is404) return;
    const routePath = request.routeOptions.url ?? request.url.split("?")[0];
    // H1 (Tanda 3 · cierre): the token-less demo fallback (HOTELOS_ALLOW_DEMO_AUTH
    // → isAuthenticated=false with the demoStore super-user) only stands in for
    // reads and low/medium writes. A `high` / `critical` route — cancel an
    // invoice, refund, send to AEAT/MIR, go-live, rotate secrets… — needs a real
    // session even in demo mode: a verifier cancelled a real Faranda invoice
    // without any token (irreversible). Public routes carry riskLevel "public"
    // and are never gated here; without the demo flag the auth hook already
    // answered 401 before this point, so this only bites the demo fallback.
    if (!request.isAuthenticated) {
      const risk = routeRiskLevel(request.method, routePath);
      if (risk === "high" || risk === "critical") {
        throw new UnauthorizedError("Authentication required.");
      }
    }
    try {
      assertRoutePermission({
        method: request.method,
        path: routePath,
        // SECURITY (audit 2026-06 · NUEVO-2): default-deny. If no userContext is
        // present, evaluate against an EMPTY permission set — never the demoStore
        // super-user (which holds every permission). Defense in depth behind the
        // auth-context production gate.
        userPermissions: request.userContext?.permissions ?? []
      });
    } catch (error) {
      // Tanda 8a (RBAC · L1, design §6.6): every refusal of the gate leaves an
      // ACCESS_DENIED audit row — route, missing keys, scope and risk — at most
      // one per user, route and minute. The decision itself is recomputed with
      // the pure `accessDecision` (security/access-decision.ts); the error is
      // re-thrown untouched so the 403 body stays the same.
      if ((error instanceof PermissionDeniedError || error instanceof ForbiddenError) && request.isAuthenticated && request.userContext) {
        const context = request.userContext;
        if (shouldAuditDenial(context.userId, `${request.method} ${routePath}`)) {
          const scopeType = request.rbacScope?.propertyId ? "property" : context.orgScope ? "organization" : null;
          const decision = accessDecision({
            method: request.method,
            path: routePath,
            permissions: context.permissions ?? [],
            authenticated: request.isAuthenticated,
            propertyId: request.rbacScope?.propertyId ?? null,
            scopeType
          });
          recordAuditEvent({
            organizationId: context.organizationId,
            propertyId: request.rbacScope?.propertyId ?? undefined,
            actorUserId: context.userId,
            actorType: "user",
            action: "ACCESS_DENIED",
            entityType: "route",
            entityId: `${request.method} ${routePath}`,
            afterJson: {
              missing: error instanceof PermissionDeniedError ? error.missing : decision.missing,
              scopeType,
              riskLevel: decision.riskLevel,
              reason: decision.reason ?? "missing_permission"
            },
            ipAddress: request.ip,
            deviceId: context.deviceId,
            correlationId: requestCorrelationId(request)
          });
        }
      }
      throw error;
    }
  });

  // ── Global tenant guard for property-scoped routes (CFG-P0-2 / SEC-1) ──────
  // Every staff-authenticated route carrying a propertyId (path param, then
  // query string, then the exact `propertyId` body key) goes through a single
  // hook that enforces that the property belongs to the caller's organization
  // before any handler runs. Public, guest-authenticated routes (isPublicRoute:
  // guest-portal sign-in takes a propertyId itself) are skipped — their staff
  // context is at most the demo fallback and must not gate a guest.
  // Everyone else pays one indexed `property.findUnique`:
  //   · unknown property → 404 for ALL callers, platform admins included (no
  //     more 200-empty responses for phantom ids);
  //   · property of the caller's org → pass;
  //   · property of another org → 404 unless the caller is a platform admin
  //     (admin.tenants.manage granted through REAL DB roles, carried as
  //     `userContext.isPlatformAdmin`), in which case the request's
  //     organizationId is RE-POINTED to the property's org: platform admins act
  //     inside the target organization for this request so every downstream
  //     org check stays consistent. The explicit `assertPropertyInOrg` calls in
  //     handlers/services therefore pass for the same reason instead of each
  //     needing its own escape hatch.
  // Mismatch → 404 (never 403) so we don't leak other tenants' property ids.
  // By design, demoStore-only properties (e.g. prop_456) are NOT reachable
  // through this guard: they don't exist in Prisma and the UI never lists them.
  // `pickPropertyId` is declared above the password guard (Tanda 8a: shared
  // with the scope hook).

  // `grantPropertyAccess` (lib/tenancy.ts) resolves the property and grants
  // access or throws the opaque 404; platform admins get organizationId
  // re-pointed to the property's org (see the hook comment above). Routes
  // addressed by an ENTITY id (no propertyId anywhere) go through
  // `assertEntityAccess` from the same module with identical semantics.
  app.addHook("preHandler", async (request) => {
    // Same P6 short-circuit as the permission hook: no property lookup for a
    // path that is about to 404 anyway.
    if (request.is404) return;
    if (!request.userContext || isPublicRoute(request.url)) return;
    const propertyId = pickPropertyId(request);
    if (!propertyId) return;
    // Errors thrown here flow to the global setErrorHandler → 404 JSON body.
    await grantPropertyAccess(request, propertyId);
  });

  // Body of PATCH /backoffice/properties/:propertyId/modules/:moduleCode (L1c):
  // strict — unknown keys are a 400 — with Spanish issue messages.
  const ModuleStatePatchSchema = z
    .object({
      action: z.enum(["enable", "disable"], { message: "action debe ser enable o disable." }).optional(),
      configurationJson: z.record(z.string(), z.unknown(), { message: "configurationJson debe ser un objeto." }).optional()
    })
    .strict({ message: "Campo no admitido en el cuerpo de la petición." });

  /** 400 (not a TypeError → 500) when a JSON body is missing or not an object. */
  function requireObjectBody<T extends object>(body: unknown): T {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestError("El cuerpo de la petición debe ser un objeto JSON.");
    }
    return body as T;
  }

  // ── Tenant-scope guards (audit 2026-06 · IDOR cross-tenant / Tanda 1) ──────
  // Read-by-:id routes fetch rows by primary key. Without a guard, an
  // authenticated user of one hotel could read another hotel's reservation,
  // invoice, folio, guest PII (DNI) or SES register. Every by-id route now goes
  // through `assertEntityAccess` (lib/tenancy.ts): the row's owning property or
  // organization is resolved through a per-entity table, missing and foreign
  // rows are one opaque 404, and platform admins get the same re-pointing
  // escape as the global propertyId hook. The former per-entity helpers
  // (assertReservationInOrg, assertInvoiceInOrg, assertFolioInOrg,
  // assertGuestInOrg, assertGdprRequestInOrg, assertRoomInCallerOrg,
  // assertPropertyInOrgOpaque) were inlined into those calls; only the billing
  // alias below survives because it is used from a dozen folio/invoice routes.
  //
  // Billing actions are addressed by invoice/folio/payment id, so the global
  // tenant guard never sees a propertyId for them (FISC-02: a receptionist of
  // another org could issue/cancel/rectify invoices by id).
  async function assertBillingAccess(
    request: { userContext: UserContext },
    kind: "invoice" | "folio" | "payment",
    id: string
  ): Promise<void> {
    await assertEntityAccess(request, { entity: kind, id });
  }

  app.get("/health", async () => {
    // Production-grade health: ejecuta sub-checks reales y combina su estado.
    // Mantenemos el shape antiguo (`buildHealthResponse`) además del nuevo
    // para no romper consumidores existentes (smoke tests, dashboards…).
    type SubCheck = {
      ok: boolean;
      latencyMs?: number;
      message?: string;
      /** VeriFactu SistemaInformatico block (Tanda 3): valid or the list of config errors. */
      software?: { ok: boolean; errors: string[] };
      /** Env contract (Tanda 4): number of soft findings (never their text — this route is public). */
      warnings?: number;
    };
    const checks: Record<string, SubCheck> = {};

    // database: SELECT 1 + latencyMs medido con performance.now()
    try {
      const { prisma } = await import("@hotelos/database");
      const startedAt = performance.now();
      await prisma.$queryRaw`SELECT 1`;
      const latencyMs = Math.round(performance.now() - startedAt);
      checks.database = { ok: true, latencyMs };
    } catch (err) {
      checks.database = {
        ok: false,
        message: err instanceof Error ? err.message : "database check failed"
      };
    }

    // redis: si REDIS_URL está configurada (y no es placeholder), reportamos OK
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl && redisUrl !== "change-me" && redisUrl !== "") {
      checks.redis = { ok: true, message: "configured" };
    } else {
      checks.redis = { ok: true, message: "not configured (optional)" };
    }

    // sentry: configured/disabled según SENTRY_DSN
    const sentryDsn = process.env.SENTRY_DSN;
    if (sentryDsn && sentryDsn !== "change-me" && sentryDsn !== "") {
      checks.sentry = { ok: true, message: "configured" };
    } else {
      checks.sentry = { ok: true, message: "disabled" };
    }

    // verifactu: modo configurado (sandbox por defecto) + validez del bloque
    // SistemaInformatico (NIF del productor, IdSistemaInformatico, versión,
    // número de instalación…). Fuera de sandbox un bloque inválido impide el
    // arranque (ver start() abajo); aquí se expone para el readiness fiscal.
    const verifactuMode = process.env.VERIFACTU_MODE ?? "sandbox";
    const verifactuSoftware = resolveVerifactuSoftware();
    checks.verifactu = {
      ok: verifactuSoftware.ok || verifactuMode === "sandbox",
      message: `mode=${verifactuMode}`,
      software: { ok: verifactuSoftware.ok, errors: verifactuSoftware.errors }
    };

    // sesHospedajes: reporta el modo configurado (sandbox por defecto)
    checks.sesHospedajes = {
      ok: true,
      message: `mode=${process.env.SES_HOSPEDAJES_MODE ?? "sandbox"}`
    };

    // Tanda L6a: proveedor de IA, modelos, presupuesto por defecto y rate limit (nunca la clave).
    checks.ai = describeAiHealthCheck();

    // P7: whether THIS instance runs the in-process schedulers (RUN_SCHEDULERS,
    // lib/scheduler-leader). Lets ops verify at runtime that exactly one
    // replica is the leader. No logger passed → no side effects.
    // Tanda L2 (L2-02): the env switch is only the first gate — every tick also
    // needs the `scheduler_leases` lease, so the response carries who holds it
    // (`schedulers.leader` = "lease" with a live row, "env" without one; the
    // legacy `schedulerLeader` key stays). Read-only: /health never acquires.
    const schedulerLeader = isSchedulerLeader();
    const schedulerLease = await describeSchedulerLease();
    checks.schedulers = {
      ok: true,
      message: schedulerLeader
        ? schedulerLease.holder
          ? `leader (RUN_SCHEDULERS · lease held by ${schedulerLease.thisInstance ? "this instance" : "another instance"})`
          : "leader (RUN_SCHEDULERS · no live lease)"
        : "disabled on this instance (RUN_SCHEDULERS=false)"
    };
    // Reputación (Tanda T8): el job diario corre solo en el líder; REPUTATION_SYNC_DISABLED lo apaga.
    checks.reputationSync = {
      ok: true,
      message: !schedulerLeader
        ? "disabled on this instance (RUN_SCHEDULERS=false)"
        : process.env.REPUTATION_SYNC_DISABLED === "true"
          ? "disabled (REPUTATION_SYNC_DISABLED=true)"
          : `enabled (every ${Math.round(reputationSyncIntervalMs(Number(process.env.REPUTATION_SYNC_INTERVAL_MS ?? 86_400_000)) / 3_600_000)} h · lease + advisory lock)`
    };

    // Check-in automatizado (Tanda CHK · W3-C/W4-D): jobs del líder; CHECKIN_INVITATION_DISABLED los apaga.
    const checkinJobsConfig = readCheckInConfig();
    checks.checkinJobs = {
      ok: true,
      message: !schedulerLeader
        ? "disabled on this instance (RUN_SCHEDULERS=false)"
        : checkinJobsConfig.invitationDisabled
          ? "disabled (CHECKIN_INVITATION_DISABLED=true)"
          : `enabled (every ${Math.round(checkinJobsConfig.invitationIntervalMs / 60_000)} min · invitación J-3, recordatorio J-1, lote de asignación a las ${checkinJobsConfig.assignmentRunAt}, purga · lease)`
    };

    // env (Tanda 4 · rutas-cors): the same contract assertEnv enforced at boot
    // (lib/env.ts). `ok === false` can only happen outside production (there
    // the boot already aborted), i.e. a dev/test box running with an env that
    // production would refuse — worth a "degraded" so it is noticed before the
    // deploy. Only COUNTS are exposed: /health is public and the messages
    // name variables and their formats.
    const envReport = validateEnv(process.env, { production: process.env.NODE_ENV === "production" });
    const envCheck = { ok: envReport.errors.length === 0, warnings: envReport.warnings.length };
    checks.env = {
      ...envCheck,
      message: envCheck.ok
        ? `ok (${envCheck.warnings} avisos)`
        : `${envReport.errors.length} errores de configuración (${envCheck.warnings} avisos)`
    };
    // Auditoría (fusión T8 · E1): fallos de persistencia de audit_events/event_stream desde el arranque (colisiones P2002 de ids cortos, BD caída…): ok=false → degraded.
    const auditStats = getAuditPersistStats();
    checks.audit = {
      ok: auditStats.failures === 0,
      message: auditStats.failures === 0 ? "ok (0 fallos de persistencia desde el arranque)" : `${auditStats.failures} eventos sin persistir desde el arranque (último: ${auditStats.lastError?.code ?? "?"} · ${auditStats.lastError?.action ?? "?"})`
    };

    const allOk = Object.values(checks).every((check) => check.ok);
    const status: "healthy" | "degraded" = allOk ? "healthy" : "degraded";

    // Documentos (Tanda T9): tipo del almacén que sirve el API — inline (sin
    // configurar nada), disk o s3 — o "unconfigured" si la configuración no
    // permite construir el adaptador. Fuera de `checks`: no degrada `status`;
    // /health es público, así que nunca lleva rutas, endpoints ni buckets
    // (modules/documents/documents.config.ts). DependencyStatus de
    // packages/config solo admite ok|degraded|unconfigured: el builder legacy
    // recibe ok/unconfigured y la respuesta expone el tipo real.
    const objectStorage = describeDocumentStorageHealth();

    // Construimos también la respuesta legacy para los consumidores actuales.
    const legacy = buildHealthResponse({
      service: SERVICE_NAMES.api,
      dependencies: {
        postgres: checks.database.ok ? "ok" : "degraded",
        redis: checks.redis.message === "configured" ? "ok" : "unconfigured",
        objectStorage: objectStorage === "unconfigured" ? "unconfigured" : "ok"
      }
    });

    return {
      ...legacy,
      dependencies: { ...legacy.dependencies, objectStorage },
      ok: allOk,
      status,
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION ?? "dev",
      schedulerLeader,
      // SEC-L2-06 (corrector): /health is public — the lease holder id is
      // `hostname:pid` of the leader and is not exposed; `held` says whether a
      // live lease exists and `thisInstance` whether this process holds it.
      schedulers: { leader: schedulerLease.leader, held: schedulerLease.holder !== null, thisInstance: schedulerLease.thisInstance, expiresAt: schedulerLease.expiresAt },
      // Contract (C) of Tanda 4: `env: { ok, warnings }` at the top level as
      // well as inside `checks` (the latter drives `status`).
      env: envCheck,
      checks
    };
  });

  app.get("/metrics", async () => {
    // Métricas operativas básicas: conteos de las últimas 24h + memoria + uptime.
    // Diseñado para dashboards internos y observabilidad, no para Prometheus
    // (existe un endpoint /metrics scrapeable aparte si se integra Prometheus).
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { prisma } = await import("@hotelos/database");

    const safeCount = async (fn: () => Promise<number>): Promise<number> => {
      try {
        return await fn();
      } catch {
        return -1;
      }
    };

    const [reservations_last_24h, invoices_last_24h, ses_submissions_last_24h, audit_errors_last_24h] =
      await Promise.all([
        safeCount(() => prisma.reservation.count({ where: { createdAt: { gte: since } } })),
        safeCount(() => prisma.invoice.count({ where: { createdAt: { gte: since } } })),
        safeCount(() => prisma.sesHospedajesSubmission.count({ where: { createdAt: { gte: since } } })),
        safeCount(() =>
          prisma.auditEvent.count({
            where: {
              createdAt: { gte: since },
              action: { contains: "error" }
            }
          })
        )
      ]);

    const mem = process.memoryUsage();
    const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 100) / 100;

    return {
      timestamp: new Date().toISOString(),
      counters: {
        reservations_last_24h,
        invoices_last_24h,
        ses_submissions_last_24h,
        audit_errors_last_24h
      },
      memory: {
        rssMb: toMb(mem.rss),
        heapUsedMb: toMb(mem.heapUsed)
      },
      uptime_seconds: Math.round(process.uptime())
    };
  });

  app.post("/auth/login", {
    config: {
      rateLimit: { max: 10, timeWindow: "1 minute" }   // PILOT-D1 anti-bruteforce
    }
  }, async (request) => {
    const body = parse(LoginSchema, request.body);
    const result = await loginWithEmailPassword({
      email: body.email,
      password: body.password,
      deviceId: body.deviceId ?? "unknown_device",
      ipAddress: request.ip
    });
    return {
      token: result.token,
      sessionId: result.sessionId,
      user: result.user,
      property: await resolveSessionProperty(result.user.propertyId)
    };
  });

  /**
   * The property the new session acts in (the login service resolves it from
   * the user's property assignment): the Prisma row first, then the in-memory
   * mirror for demo-only properties — never the hard-coded demo property.
   */
  async function resolveSessionProperty(propertyId: string): Promise<PropertyRecord> {
    const { prisma } = await import("@hotelos/database");
    const row = await prisma.property.findUnique({ where: { id: propertyId } });
    if (row) {
      return {
        id: row.id,
        organizationId: row.organizationId,
        name: row.name,
        legalName: row.legalName ?? undefined,
        address: row.address ?? undefined,
        municipality: row.municipality ?? undefined,
        province: row.province ?? undefined,
        timezone: row.timezone,
        country: row.country,
        taxRegion: row.taxRegion ?? undefined,
        sesHospedajesEnabled: row.sesHospedajesEnabled,
        verifactuEnabled: row.verifactuEnabled
      };
    }
    const mirror = demoStore.properties.find((candidate) => candidate.id === propertyId);
    if (!mirror) throw new NotFoundError("Propiedad no encontrada.");
    return mirror;
  }

  // PILOT-D1 · Crear usuario (onboarding inicial del cliente)
  app.post("/users", async (request) => {
    const body = parse(CreateUserSchema, request.body);
    const { createUser } = await import("./modules/auth/auth-pilot.service.js");
    return createUser({
      ...body,
      createdByUserId: request.userContext?.userId,
      actorContext: request.userContext
    });
  });

  // PILOT-D1 · Forgot password (público — no requiere auth)
  app.post("/auth/forgot-password", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => {
    const body = parse(ForgotPasswordSchema, request.body);
    const { requestPasswordReset } = await import("./modules/auth/auth-pilot.service.js");
    const result = await requestPasswordReset({ email: body.email });
    // Anti-enumeración: siempre respondemos OK aunque el email no exista.
    return {
      message: "Si existe una cuenta con ese email, recibirás un enlace de recuperación.",
      // Explicit test-only opt-in; never keyed on NODE_ENV (a mis-set env
      // would leak account-takeover tokens).
      ...(result && process.env.AUTH_EXPOSE_RESET_TOKEN === "true" ? { _testToken: result.resetTokenForTesting } : {})
    };
  });

  // PILOT-D1 · Reset password (público — token único)
  app.post("/auth/reset-password", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => {
    const body = parse(ResetPasswordSchema, request.body);
    const { resetPassword } = await import("./modules/auth/auth-pilot.service.js");
    return resetPassword(body);
  });

  // Tanda 3 (CFG-P1-6) · Staff invitation, public leg. The token in the URL is
  // the only credential: unknown, expired, used and revoked tokens all get the
  // same generic 404 (no enumeration oracle), and the lookup is rate-limited.
  app.get("/auth/invitations/:token", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request) => {
    const params = parse(InvitationTokenParamsSchema, request.params, "params");
    const invitation = await getInvitationByToken(params.token);
    if (!invitation) throw new NotFoundError("La invitación no es válida o ha caducado.");
    return invitation;
  });

  // Tanda 3 (CFG-P1-6) · Accept the invitation: sets the password (policy →
  // 400 from the service), activates the user, consumes the token and opens a
  // session. Same response shape as POST /auth/login so the front can call
  // setSession() directly. Hard limit like /auth/reset-password.
  app.post("/auth/accept-invite", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => {
    const body = parse(AcceptInviteSchema, request.body);
    const result = await acceptInvitation({ token: body.token, password: body.password, deviceId: body.deviceId });
    return {
      token: result.token,
      sessionId: result.sessionId,
      user: result.user,
      property: await resolveSessionProperty(result.user.propertyId)
    };
  });

  // PILOT-D1 · Cambio de contraseña del usuario logueado
  app.post("/auth/change-password", async (request) => {
    const body = parse(ChangePasswordSchema, request.body);
    const { changeOwnPassword } = await import("./modules/auth/auth-pilot.service.js");
    await changeOwnPassword({
      userId: request.userContext.userId,
      ...body
    });
    return { message: "Contraseña actualizada." };
  });

  // PILOT-D1 · Política de contraseñas (público — útil para la UI en register)
  app.get("/auth/password-policy", async () => {
    const { AUTH_PILOT_CONFIG } = await import("./modules/auth/auth-pilot.service.js");
    return {
      minLength: AUTH_PILOT_CONFIG.PASSWORD_MIN_LENGTH,
      requireUppercase: true,
      requireDigit: true,
      requireSpecial: true,
      maxFailedAttempts: AUTH_PILOT_CONFIG.MAX_FAILED_ATTEMPTS,
      lockoutMinutes: AUTH_PILOT_CONFIG.LOCKOUT_MINUTES
    };
  });

  // PILOT-D3 · Estado del bootstrap (público — la UI lo usa para mostrar el
  // wizard de "primer arranque"). Nunca devuelve el token, solo si está abierto.
  app.get("/onboarding/bootstrap/status", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async () => {
    const { isBootstrapAllowed } = await import("./modules/onboarding/bootstrap.service.js");
    const status = await isBootstrapAllowed();
    return {
      bootstrapAllowed: status.allowed,
      reason: status.reason
    };
  });

  // PILOT-D3 · Bootstrap del piloto (público, rate-limited y con doble cerrojo:
  // token + count() === 0). Crea Org + Property + Admin + Owner role + perms.
  app.post("/onboarding/bootstrap", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => {
    const body = parse(
      z.object({
        bootstrapToken: z.string().min(8),
        organization: z.object({
          name: z.string().min(1).max(200),
          legalName: z.string().max(200).optional(),
          taxId: z.string().max(40).optional().refine((v) => !v || isValidSpanishTaxId(v), { message: "NIF/CIF no válido" }),
          country: z.string().length(2).optional()
        }),
        property: z.object({
          name: z.string().min(1).max(200),
          legalName: z.string().max(200).optional(),
          address: z.string().max(300).optional(),
          municipality: z.string().max(100).optional(),
          province: z.string().max(100).optional(),
          country: z.string().length(2).optional(),
          taxRegion: z.string().max(40).optional(),
          postalCode: z.string().regex(/^\d{5}$/).optional(),
          ineMunicipalityCode: z.string().regex(/^\d{5}$/).optional(),
          fiscalTerritory: z.enum(["common", "bizkaia", "gipuzkoa", "araba", "navarra"]).optional(),
          timezone: z.string().max(60).optional(),
          sesHospedajesEnabled: z.boolean().optional(),
          verifactuEnabled: z.boolean().optional()
        }),
        adminUser: z.object({
          email: z.string().email(),
          password: z.string().min(8),
          fullName: z.string().min(1).max(120),
          phone: z.string().max(40).optional()
        })
      }),
      request.body
    );
    const { bootstrapPilot } = await import("./modules/onboarding/bootstrap.service.js");
    return bootstrapPilot(body);
  });

  app.post("/auth/register-device", async (request) => {
    const body = request.body as {
      deviceName: string;
      platform?: "ios" | "android" | "web" | "unknown";
      pushToken?: string;
    };
    return registerDevice({
      context: request.userContext,
      deviceName: body.deviceName,
      platform: body.platform ?? "unknown",
      pushToken: body.pushToken
    });
  });

  app.get("/auth/sessions", async (request) => listSessions(request.userContext));

  app.post("/auth/sessions/:id/revoke", async (request) => {
    const params = request.params as { id: string };
    return revokeSession({
      context: request.userContext,
      sessionId: params.id
    });
  });

  app.post("/auth/mfa/challenge", async (request) => {
    const body = request.body as {
      purpose?: "login" | "high_risk_action";
      deliveryChannel?: "email" | "sms" | "authenticator";
    };
    const challenge = await createMfaChallenge({
      context: request.userContext,
      purpose: body.purpose ?? "login",
      deliveryChannel: body.deliveryChannel
    });

    return {
      id: challenge.id,
      purpose: challenge.purpose,
      deliveryChannel: challenge.deliveryChannel,
      expiresAt: challenge.expiresAt,
      status: challenge.status
    };
  });

  app.post("/auth/mfa/verify", async (request) => {
    const body = request.body as { challengeId: string; code: string };
    return verifyMfaChallenge({
      context: request.userContext,
      challengeId: body.challengeId,
      code: body.code
    });
  });

  // Tanda 6b (L2, integración): `listSwitchableProperties` lives in
  // modules/structure/legal-entity.service.ts (tenant isolation unchanged: only
  // the platform admin switches across organizations; demo-store fallback kept).

  // Tanda 5 (L1a · rbac): the signed-in user with the template key of every
  // role they hold, per property — the navigation derives its role tokens
  // from it (apps/admin-web/src/navigation/role-tokens.ts). Self-service: no
  // permission, served while the password rotation guard is active
  // (PASSWORD_CHANGE_ALLOWLIST already covers /users/me).
  app.get("/users/me", async (request) => getCurrentUserProfile(request.userContext));

  app.get("/users/me/properties", async (request) => listSwitchableProperties(request.userContext));

  app.get("/properties", async (request) => listSwitchableProperties(request.userContext));

  // --- User theme preferences (self-service) -------------------------------
  // Cada usuario gestiona sus propias preferencias visuales: permisos vacíos,
  // riskLevel low. Lectura/escritura siempre ligada al userId del contexto.
  app.get("/users/me/preferences", async (request) => {
    const { prisma } = await import("@hotelos/database");
    const user = await prisma.user.findUnique({
      where: { id: request.userContext.userId },
      select: {
        themePreference: true,
        accentColor: true,
        reducedMotion: true,
        highContrast: true
      }
    });
    return {
      themePreference: user?.themePreference ?? "auto",
      accentColor: user?.accentColor ?? "#007aff",
      reducedMotion: user?.reducedMotion ?? false,
      highContrast: user?.highContrast ?? false
    };
  });

  app.patch("/users/me/preferences", async (request) => {
    const body = (request.body ?? {}) as {
      themePreference?: string;
      accentColor?: string;
      reducedMotion?: boolean;
      highContrast?: boolean;
    };
    const data: {
      themePreference?: string;
      accentColor?: string;
      reducedMotion?: boolean;
      highContrast?: boolean;
    } = {};
    if (typeof body.themePreference === "string") data.themePreference = body.themePreference;
    if (typeof body.accentColor === "string") data.accentColor = body.accentColor;
    if (typeof body.reducedMotion === "boolean") data.reducedMotion = body.reducedMotion;
    if (typeof body.highContrast === "boolean") data.highContrast = body.highContrast;
    const { prisma } = await import("@hotelos/database");
    const user = await prisma.user.update({
      where: { id: request.userContext.userId },
      data,
      select: {
        themePreference: true,
        accentColor: true,
        reducedMotion: true,
        highContrast: true
      }
    });
    return user;
  });

  // --- Bounded contexts extraídos (P1-9 + P1-16) ---------------------------
  // Cada plugin agrupa los handlers de un dominio en su propio fichero. These
  // plugins only ADD routes, so loading them lazily at app.ready()/listen() is
  // fine. Do NOT generalise that to infrastructure plugins: anything that
  // hooks route registration (@fastify/rate-limit via `onRoute`) must be
  // `await`ed before the first inline route — see AUTH-05 in buildApiServer.
  app.register(webhooksRoutes);
  app.register(assistantRoutes);
  app.register(touristTaxRoutes);
  registerWhatsappWebhookRoutes(app); // WhatsApp Cloud API · entrada del bot del huésped (Tanda CHK · W4-D)
  // --- Mobile keys / Wallet passes (P1-5) ----------------------------------
  app.post("/reservations/:id/wallet-pass", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    return issueWalletPass({
      context: request.userContext,
      reservationId: (request.params as { id: string }).id
    });
  });
  app.post("/mobile-keys/:serial/verify", async (request) => {
    await assertEntityAccess(request, { entity: "mobileKey", id: (request.params as { serial: string }).serial });
    const body = (request.body ?? {}) as { signature: string; timestamp: number };
    return verifyWalletUnlock({
      context: request.userContext,
      serialNumber: (request.params as { serial: string }).serial,
      signature: body.signature,
      timestamp: body.timestamp
    });
  });
  // --- TicketBAI multi-jurisdicción (P1-8) --------------------------------
  app.get("/tbai/territories", async () => ({ items: FORAL_TERRITORIES, config: getTbaiTerritories() }));
  app.post("/invoices/:id/tbai/submit", async (request) => {
    const body = (request.body ?? {}) as { mode?: "stub" | "sandbox" | "production" };
    await assertBillingAccess(request, "invoice", (request.params as { id: string }).id);
    return submitInvoiceToTbai({
      context: request.userContext,
      invoiceId: (request.params as { id: string }).id,
      mode: body.mode
    });
  });
  app.get("/properties/:propertyId/tbai/chain/:territory/verify", async (request) => {
    const params = request.params as { propertyId: string; territory: string };
    if (!(FORAL_TERRITORIES as readonly string[]).includes(params.territory)) {
      return { valid: false, inspected: 0, error: "unknown_territory" };
    }
    return verifyTbaiChain({
      context: request.userContext,
      propertyId: params.propertyId,
      territory: params.territory as ForalTerritory
    });
  });
  app.get("/properties/:propertyId/tbai/submissions", async (request) => {
    const params = request.params as { propertyId: string };
    const q = (request.query ?? {}) as { territory?: ForalTerritory };
    return { items: await listTbaiSubmissionsForal({ context: request.userContext, propertyId: params.propertyId, territory: q.territory }) };
  });

  // --- Banking España: CSB-43 + SEPA Norma 19 (P2-3) ----------------------
  app.post("/properties/:propertyId/banking/csb43/import", async (request) => {
    const params = request.params as { propertyId: string };
    // Finanzas (2026-09-16): the import persists the statement; the body may
    // pin the bank account, skip auto-matching or refuse to create an unknown
    // account (banking-spain/banking.service importCsb43).
    const body = (request.body ?? {}) as { content: string; bankAccountId?: string | null; autoMatch?: boolean; createMissingAccount?: boolean };
    return importCsb43({
      context: request.userContext,
      propertyId: params.propertyId,
      content: body.content,
      bankAccountId: body.bankAccountId ?? null,
      autoMatch: body.autoMatch,
      createMissingAccount: body.createMissingAccount
    });
  });
  app.post("/banking/sepa/remittances", async (request) => {
    return generateSepaRemittanceSvc({ context: request.userContext, remittance: request.body as never });
  });
  app.post("/banking/iban/validate", async (request) => {
    const body = (request.body ?? {}) as { iban: string };
    return { valid: validateIbanSvc(body.iban), iban: body.iban };
  });

  // --- CSRD / ESRS reporting (P2-2) ---------------------------------------
  app.get("/esrs/catalog", async () => ({ items: await esrsCatalog() }));
  app.get("/organizations/:orgId/esrs/:year/indicators", async (request) => {
    await assertEntityAccess(request, { entity: "organization", id: (request.params as { orgId: string }).orgId });
    const params = request.params as { orgId: string; year: string };
    return { items: await esrsList({ context: request.userContext, organizationId: params.orgId, fiscalYear: params.year }) };
  });
  app.post("/esrs/indicators", async (request) => {
    return esrsUpsert({ context: request.userContext, payload: request.body as never });
  });
  app.post("/organizations/:orgId/esrs/:year/generate", async (request) => {
    await assertEntityAccess(request, { entity: "organization", id: (request.params as { orgId: string }).orgId });
    const params = request.params as { orgId: string; year: string };
    return esrsGenerate({ context: request.userContext, organizationId: params.orgId, fiscalYear: params.year });
  });
  app.get("/organizations/:orgId/esrs/:year/report", async (request) => {
    await assertEntityAccess(request, { entity: "organization", id: (request.params as { orgId: string }).orgId });
    const params = request.params as { orgId: string; year: string };
    return esrsGet({ context: request.userContext, organizationId: params.orgId, fiscalYear: params.year });
  });

  // --- Marketplace + OAuth2 (P2-1) ---------------------------------------
  app.get("/marketplace/categories", async () => ({ items: MARKETPLACE_CATEGORIES }));
  app.get("/marketplace/listings", async (request) => {
    const q = (request.query ?? {}) as { category?: string };
    return { items: await listPublishedListings({ category: q.category }) };
  });
  app.get("/marketplace/listings/:appId", async (request) => {
    return getListing((request.params as { appId: string }).appId);
  });
  app.post("/marketplace/listings", async (request) => {
    return publishListing({ context: request.userContext, payload: request.body as never });
  });
  app.post("/marketplace/listings/:appId/install", async (request) => {
    const params = request.params as { appId: string };
    const body = (request.body ?? {}) as { propertyId?: string; grantedScopes: string[] };
    return installApp({
      context: request.userContext,
      appId: params.appId,
      propertyId: body.propertyId,
      grantedScopes: body.grantedScopes ?? []
    });
  });
  app.post("/marketplace/listings/:appId/uninstall", async (request) => {
    const params = request.params as { appId: string };
    const body = (request.body ?? {}) as { propertyId?: string };
    return uninstallApp({
      context: request.userContext,
      appId: params.appId,
      propertyId: body.propertyId
    });
  });
  app.get("/marketplace/installations", async (request) => {
    const q = (request.query ?? {}) as { propertyId?: string };
    return { items: await listInstallations({ context: request.userContext, propertyId: q.propertyId }) };
  });

  // Developer Apps management
  app.get("/developer/apps", async (request) => ({ items: await listDeveloperApps({ context: request.userContext }) }));
  app.post("/developer/apps", async (request) => {
    return createDeveloperApp({ context: request.userContext, payload: request.body as never });
  });
  app.post("/developer/apps/:appId/rotate-secret", async (request) => {
    await assertEntityAccess(request, { entity: "developerApp", id: (request.params as { appId: string }).appId });
    return rotateClientSecret({ context: request.userContext, appId: (request.params as { appId: string }).appId });
  });

  // OAuth2 endpoints (public — token validation has its own gates)
  app.get("/oauth/scopes", async () => ({ items: OAUTH_SCOPES }));
  app.post("/oauth/authorize", async (request) => {
    const body = (request.body ?? {}) as {
      appId: string;
      redirectUri: string;
      scopes: string[];
      codeChallenge?: string;
      codeChallengeMethod?: "S256" | "plain";
    };
    return issueAuthorizationCode({
      appId: body.appId,
      organizationId: request.userContext.organizationId,
      propertyId: request.userContext.propertyId,
      userId: request.userContext.userId,
      redirectUri: body.redirectUri,
      scopes: body.scopes,
      codeChallenge: body.codeChallenge,
      codeChallengeMethod: body.codeChallengeMethod
    });
  });
  app.post("/oauth/token", async (request) => {
    const body = (request.body ?? {}) as {
      grant_type: "authorization_code" | "client_credentials" | "refresh_token";
      code?: string;
      client_id: string;
      client_secret?: string;
      redirect_uri?: string;
      code_verifier?: string;
      refresh_token?: string;
      scope?: string;
    };
    if (body.grant_type === "authorization_code") {
      return exchangeCodeForToken({
        code: body.code ?? "",
        clientId: body.client_id,
        clientSecret: body.client_secret,
        redirectUri: body.redirect_uri ?? "",
        codeVerifier: body.code_verifier
      });
    }
    if (body.grant_type === "client_credentials") {
      return clientCredentialsToken({
        clientId: body.client_id,
        clientSecret: body.client_secret ?? "",
        scopes: body.scope?.split(" ").filter(Boolean)
      });
    }
    if (body.grant_type === "refresh_token") {
      return refreshAccessToken({
        refreshToken: body.refresh_token ?? "",
        clientId: body.client_id
      });
    }
    return { error: "unsupported_grant_type" };
  });

  app.post("/mobile-keys/:serial/revoke", async (request) => {
    // Tanda L2 (corrector): the key's property (guest_portal_actions row) wins
    // over the header; the service filters the revocation by it.
    const propertyId = await assertPropertyEntityAccess(request, { entity: "mobileKey", id: (request.params as { serial: string }).serial });
    return revokeWalletPass({
      context: request.userContext,
      serialNumber: (request.params as { serial: string }).serial,
      propertyId
    });
  });

  // /properties/:propertyId/tourist-tax/applications movido a touristTaxRoutes (P1-16).

  // Global cross-entity search — powers the cmd+K palette in admin-web.
  // Query params:
  //   q           required, the text query
  //   propertyId  optional, defaults to the active property in the session
  //   types       optional CSV of kinds to restrict the search
  //                 (reservation,guest,room,folio,invoice,property,rate_plan)
  //   limit       optional per-kind cap
  app.get("/search", async (request) => {
    const q = (request.query ?? {}) as { q?: string; propertyId?: string; types?: string; limit?: string };
    const types = q.types
      ? (q.types.split(",").map((t) => t.trim()).filter(Boolean) as SearchHit["kind"][])
      : undefined;
    const limit = q.limit ? Math.max(1, Math.min(15, Number.parseInt(q.limit, 10) || 8)) : undefined;
    return globalSearch({
      organizationId: request.userContext.organizationId,
      propertyId: q.propertyId ?? request.userContext.propertyId ?? null,
      query: q.q ?? "",
      types,
      limit
    });
  });

  app.get("/notifications", async (request) => listNotifications(request.userContext));

  app.post("/notifications/:id/read", async (request) => {
    const params = request.params as { id: string };
    return markNotificationRead({
      context: request.userContext,
      notificationId: params.id
    });
  });

  app.get("/settings/security", async (request) => await getSecuritySettings(request.userContext));

  app.post("/onboarding/projects", async (request) =>
    createOnboardingProject({ context: request.userContext, payload: request.body as never })
  );
  app.get("/onboarding/projects", async (request) => {
    // Tenant scope: the in-memory service holds every organization's projects.
    const result = listOnboardingProjects(request.userContext);
    return {
      ...result,
      items: result.items.filter((project) => project.organizationId === request.userContext.organizationId)
    };
  });
  app.get("/onboarding/projects/:projectId", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return getOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId });
  });
  app.patch("/onboarding/projects/:projectId", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return patchOnboardingProject({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });
  app.post("/onboarding/projects/:projectId/source-connections", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return createSourceConnection({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });
  app.post("/onboarding/source-connections/:connectionId/test", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingSourceConnection", id: (request.params as { connectionId: string }).connectionId });
    return testSourceConnection({ context: request.userContext, connectionId: (request.params as { connectionId: string }).connectionId });
  });
  app.post("/onboarding/source-connections/:connectionId/sync", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingSourceConnection", id: (request.params as { connectionId: string }).connectionId });
    return syncSourceConnection({ context: request.userContext, connectionId: (request.params as { connectionId: string }).connectionId });
  });
  app.post("/onboarding/projects/:projectId/files", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return uploadOnboardingFile({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });
  app.get("/onboarding/projects/:projectId/files", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return listOnboardingFiles({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId });
  });
  app.post("/onboarding/files/:fileId/classify", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingFile", id: (request.params as { fileId: string }).fileId });
    return classifyOnboardingFileApi({ context: request.userContext, fileId: (request.params as { fileId: string }).fileId });
  });
  app.post("/onboarding/files/:fileId/extract", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingFile", id: (request.params as { fileId: string }).fileId });
    return extractOnboardingFileApi({ context: request.userContext, fileId: (request.params as { fileId: string }).fileId });
  });
  app.post("/onboarding/projects/:projectId/ai/analyze", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return analyzeOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId, mode: "analyze" });
  });
  app.post("/onboarding/projects/:projectId/ai/generate-blueprint", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return analyzeOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId, mode: "generate_blueprint" });
  });
  app.post("/onboarding/projects/:projectId/ai/generate-mappings", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return analyzeOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId, mode: "generate_mappings" });
  });
  app.post("/onboarding/projects/:projectId/room-walk/parse", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return parseRoomWalkSetup({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });
  app.post("/onboarding/files/:fileId/floor-plan/map", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingFile", id: (request.params as { fileId: string }).fileId });
    return mapFloorPlanFile({
      context: request.userContext,
      fileId: (request.params as { fileId: string }).fileId,
      payload: request.body as never
    });
  });
  app.post("/onboarding/projects/:projectId/ai/data-quality", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return analyzeOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId, mode: "data_quality" });
  });
  app.get("/onboarding/projects/:projectId/extracted-entities", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return listExtractedEntities({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId });
  });
  app.get("/onboarding/projects/:projectId/mapping-suggestions", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return listMappingSuggestions({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId });
  });
  app.get("/onboarding/projects/:projectId/human-review-queue", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return getHumanReviewQueue({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId });
  });
  app.patch("/onboarding/mapping-suggestions/:suggestionId/approve", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingMappingSuggestion", id: (request.params as { suggestionId: string }).suggestionId });
    return reviewMappingSuggestion({
      context: request.userContext,
      suggestionId: (request.params as { suggestionId: string }).suggestionId,
      decision: "approved",
      payload: request.body as never
    });
  });
  app.patch("/onboarding/mapping-suggestions/:suggestionId/reject", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingMappingSuggestion", id: (request.params as { suggestionId: string }).suggestionId });
    return reviewMappingSuggestion({
      context: request.userContext,
      suggestionId: (request.params as { suggestionId: string }).suggestionId,
      decision: "rejected",
      payload: request.body as never
    });
  });
  app.patch("/onboarding/mapping-suggestions/:suggestionId/edit", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingMappingSuggestion", id: (request.params as { suggestionId: string }).suggestionId });
    return reviewMappingSuggestion({
      context: request.userContext,
      suggestionId: (request.params as { suggestionId: string }).suggestionId,
      decision: "edited",
      payload: request.body as never
    });
  });
  app.post("/onboarding/projects/:projectId/dry-run", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return runMigrationDryRun({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });
  app.get("/onboarding/projects/:projectId/dry-run-result", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return getDryRunResult({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId });
  });
  app.post("/onboarding/projects/:projectId/apply", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return applyMigration({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });
  app.post("/onboarding/projects/:projectId/rollback", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return rollbackMigration({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });
  app.get("/onboarding/projects/:projectId/readiness", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return getGoLiveReadiness({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId });
  });
  app.get("/onboarding/projects/:projectId/cutover-plan", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return getCutoverPlan({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId });
  });
  app.post("/onboarding/projects/:projectId/cutover/delta-import/dry-run", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return runCutoverDeltaImportDryRun({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });
  app.post("/onboarding/projects/:projectId/go-live", async (request) => {
    await assertEntityAccess(request, { entity: "onboardingProject", id: (request.params as { projectId: string }).projectId });
    return approveOnboardingGoLive({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    });
  });

  // History & Forecast BOARD (contract 2026-07-15): canonical Opera-style board
  // computed from Prisma (reservations + RevenueDailySnapshot + RevenueForecast
  // + Budget + RevenuePaceSnapshot).
  // Pilot verification R1: `from=2026-13-99` used to build an Invalid Date and
  // surface as a Prisma 500; the window is now validated at the boundary
  // (real calendar day, from ≤ to, ≤ BOARD_MAX_DAYS) → typed 400 in Spanish.
  const boardWindow = (request: { query: unknown }) => {
    const q = (request.query ?? {}) as { from?: unknown; to?: unknown };
    return parseBoardWindow({ from: q.from, to: q.to });
  };
  app.get("/revenue/properties/:propertyId/history-forecast/board", async (request) => {
    const params = request.params as { propertyId: string };
    return getHistoryForecastBoard(params.propertyId, boardWindow(request));
  });
  // Legacy alias: these three used to read the in-memory demoStore (prop_123
  // only; 500 for real properties). They now serve the same real board.
  app.get("/revenue/properties/:propertyId/history-forecast", async (request) => {
    const params = request.params as { propertyId: string };
    return getHistoryForecastBoard(params.propertyId, boardWindow(request));
  });
  app.get("/revenue/properties/:propertyId/history-forecast/charts", async (request) => {
    const params = request.params as { propertyId: string };
    return getHistoryForecastBoard(params.propertyId, boardWindow(request));
  });
  app.get("/revenue/properties/:propertyId/history-forecast/kpis", async (request) => {
    const params = request.params as { propertyId: string };
    return getHistoryForecastBoard(params.propertyId, boardWindow(request));
  });
  // Legacy alias: repointed to the Export Center generator (hf_daily) — the old
  // demoStore export read `report.rows` (key was `report.table`) → empty CSV.
  // Same path + permission; keeps its historical audit action.
  app.post("/revenue/properties/:propertyId/history-forecast/export", async (request) => {
    const params = request.params as { propertyId: string };
    // NEW-REV-C: format is validated (csv | xls | xlsx → xls); "pdf" is a 400
    // instead of a silently downgraded csv. Missing format keeps csv.
    const b = parse(HistoryForecastExportBodySchema, request.body ?? {});
    return generateExport({
      context: request.userContext,
      propertyId: params.propertyId,
      exportCode: "hf_daily",
      format: b.format === "xls" || b.format === "xlsx" ? "xls" : "csv",
      from: b.from ?? b.fromDate,
      to: b.to ?? b.toDate,
      auditAction: "RevenueHistoryForecastExported",
      correlationId: createId("corr")
    });
  });
  // Export Center (contract 2026-07-15): catalog + generator.
  app.get("/revenue/properties/:propertyId/export-center/catalog", async (request) => {
    const params = request.params as { propertyId: string };
    return getExportCatalog(params.propertyId);
  });
  app.post("/revenue/properties/:propertyId/export-center/generate", async (request) => {
    const params = request.params as { propertyId: string };
    const body = parse(
      z.object({
        exportCode: z.enum(["hf_daily", "pickup_daily", "flash_direccion", "pace_segmento", "meeting_pack", "cierre_mensual"]),
        format: z.enum(["csv", "xls", "pdf"]),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        month: isoMonth.optional()
      }),
      request.body
    );
    return generateExport({
      context: request.userContext,
      propertyId: params.propertyId,
      exportCode: body.exportCode,
      format: body.format,
      from: body.from,
      to: body.to,
      month: body.month,
      correlationId: createId("corr")
    });
  });
  app.get("/revenue/properties/:propertyId/pickup", async (request) => {
    const params = request.params as { propertyId: string };
    return getPickup(params.propertyId);
  });
  app.get("/revenue/properties/:propertyId/pace", async (request) => {
    const params = request.params as { propertyId: string };
    return getPace(params.propertyId);
  });
  app.post("/revenue/properties/:propertyId/pace/capture", async (request) => {
    const params = request.params as { propertyId: string };
    return capturePaceSnapshot(params.propertyId);
  });
  app.get("/revenue/properties/:propertyId/forecast", async (request) => {
    const params = request.params as { propertyId: string };
    const q = request.query as { from?: string; to?: string };
    return listForecasts({ propertyId: params.propertyId, from: q.from, to: q.to });
  });
  app.get("/revenue/properties/:propertyId/forecasts", async (request) => {
    const params = request.params as { propertyId: string };
    const q = request.query as { from?: string; to?: string };
    return listForecasts({ propertyId: params.propertyId, from: q.from, to: q.to });
  });
  app.post("/revenue/properties/:propertyId/forecasts/generate", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as { from?: string; to?: string };
    return generateForecasts({ context: request.userContext, propertyId: params.propertyId, from: body.from, to: body.to, correlationId: createId("corr") });
  });
  app.get("/revenue/properties/:propertyId/history-forecast/report", async (request) => {
    const params = request.params as { propertyId: string };
    const q = (request.query ?? {}) as { from?: unknown; to?: unknown };
    // Pilot verification R2: a window over REPORT_MAX_DAYS is a 400 naming the
    // limit (it used to be truncated to 120 rows while echoing the request).
    const win = parseReportWindow({ from: q.from, to: q.to });
    return getLiveHistoryForecastReport({ propertyId: params.propertyId, from: win.from, to: win.to });
  });
  app.get("/revenue/properties/:propertyId/period-metrics", async (request) => {
    const params = request.params as { propertyId: string };
    const q = (request.query ?? {}) as { from?: unknown; to?: unknown };
    const today = new Date();
    const toDefault = today.toISOString().slice(0, 10);
    const fromDefault = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    // Pilot verification R1: malformed dates → 400, not a Prisma 500. A
    // comparison window is at most one year (366 days) per call.
    const win = parseRevenueWindow({ from: q.from, to: q.to, maxDays: PERIOD_METRICS_MAX_DAYS, defaultFrom: fromDefault, defaultTo: toDefault, scope: "de period-metrics" });
    return getPeriodMetrics({ propertyId: params.propertyId, from: win.from, to: win.to });
  });
  app.get("/revenue/properties/:propertyId/forecasts/by-segment", async (request) => {
    const params = request.params as { propertyId: string };
    const q = request.query as { from?: string; to?: string };
    return getForecastBySegment({ propertyId: params.propertyId, from: q.from, to: q.to });
  });
  app.get("/revenue/properties/:propertyId/forecasts/:date", async (request) => {
    const params = request.params as { propertyId: string; date: string };
    return listForecasts({ propertyId: params.propertyId, from: params.date, to: params.date });
  });
  app.get("/revenue/properties/:propertyId/forecast-accuracy", async (request) => {
    const params = request.params as { propertyId: string };
    const q = request.query as { days?: string };
    return getForecastAccuracy({ propertyId: params.propertyId, days: q.days ? Number(q.days) : undefined });
  });
  app.get("/revenue/properties/:propertyId/recommendations", async (request) => {
    const params = request.params as { propertyId: string };
    return listRecommendations(params.propertyId);
  });
  app.post("/revenue/properties/:propertyId/recommendations/generate", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as { from?: string; to?: string };
    return generateRecommendations({ context: request.userContext, propertyId: params.propertyId, from: body.from, to: body.to, correlationId: createId("corr") });
  });
  app.post("/revenue/properties/:propertyId/recommendations/:id/approve", async (request) => {
    await assertEntityAccess(request, { entity: "revenueRecommendation", id: (request.params as { id: string }).id, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { propertyId: string; id: string };
    return decideRecommendation({ context: request.userContext, id: params.id, decision: "approved", correlationId: createId("corr") });
  });
  app.post("/revenue/properties/:propertyId/recommendations/:id/apply", async (request) => {
    await assertEntityAccess(request, { entity: "revenueRecommendation", id: (request.params as { id: string }).id, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { propertyId: string; id: string };
    return decideRecommendation({ context: request.userContext, id: params.id, decision: "applied", correlationId: createId("corr") });
  });
  app.post("/revenue/properties/:propertyId/recommendations/:id/reject", async (request) => {
    await assertEntityAccess(request, { entity: "revenueRecommendation", id: (request.params as { id: string }).id, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { propertyId: string; id: string };
    return decideRecommendation({ context: request.userContext, id: params.id, decision: "rejected", correlationId: createId("corr") });
  });
  // Pricing rules + BAR levels (Fase C2)
  app.get("/revenue/properties/:propertyId/pricing-rules", async (request) => listPricingRules((request.params as { propertyId: string }).propertyId));
  app.post("/revenue/properties/:propertyId/pricing-rules", async (request) => createPricingRule({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/revenue/pricing-rules/:id", async (request) => {
    await assertEntityAccess(request, { entity: "pricingRule", id: (request.params as { id: string }).id });
    return updatePricingRule({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/revenue/properties/:propertyId/bar-levels", async (request) => listBarLevels((request.params as { propertyId: string }).propertyId));
  app.post("/revenue/properties/:propertyId/bar-levels", async (request) => createBarLevel({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  // Strategy (Fase D): budget, market segments, displacement, meeting pack
  app.get("/revenue/properties/:propertyId/budget", async (request) => listBudgets((request.params as { propertyId: string }).propertyId));
  app.post("/revenue/properties/:propertyId/budget", async (request) => upsertBudget({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/revenue/properties/:propertyId/budget/variance", async (request) => {
    // NEW-REV-A: month=2024-13 is a 400 here, not a 500 in date arithmetic.
    const q = parse(BudgetVarianceQuerySchema, request.query ?? {}, "query");
    return getBudgetVariance({ propertyId: (request.params as { propertyId: string }).propertyId, month: q.month });
  });
  app.get("/revenue/properties/:propertyId/market-segments", async (request) => listMarketSegments((request.params as { propertyId: string }).propertyId));
  app.post("/revenue/properties/:propertyId/market-segments", async (request) => createMarketSegment({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/revenue/properties/:propertyId/market-segments/seed", async (request) => seedMarketSegments({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, correlationId: createId("corr") }));
  app.post("/revenue/properties/:propertyId/displacement", async (request) => {
    const params = request.params as { propertyId: string };
    const b = (request.body ?? {}) as { arrivalDate?: string; departureDate?: string; roomsPerNight?: number; groupRate?: number };
    return analyzeDisplacement({ propertyId: params.propertyId, arrivalDate: String(b.arrivalDate), departureDate: String(b.departureDate), roomsPerNight: Number(b.roomsPerNight), groupRate: Number(b.groupRate) });
  });
  app.get("/revenue/properties/:propertyId/meeting-pack", async (request) => {
    // REV-03c: the pack's budget/variance block is month-addressable; without
    // ?month the service keeps its current-month default.
    const q = parse(MeetingPackQuerySchema, request.query ?? {}, "query");
    return getMeetingPack((request.params as { propertyId: string }).propertyId, { month: q.month });
  });

  // ---- Email connectors → AI → reservation (HITL) ----
  app.get("/integrations/email/providers", async () => emailProvidersStatus());
  app.get("/properties/:propertyId/email/connections", async (request) => listEmailConnections((request.params as { propertyId: string }).propertyId));
  // Tanda 7b (L3): cuerpo `.strict()` con `purpose` (reservation_ai | pms_shadow), `fromDomain` y `subjectContains`
  // (schemas/email-connections.schemas.ts); el payload de EmailConnectorsScreen ({ provider } / imap) sigue válido.
  app.post("/properties/:propertyId/email/connections", async (request) =>
    createEmailConnection({
      context: request.userContext,
      propertyId: (request.params as { propertyId: string }).propertyId,
      payload: parseOr400(CreateEmailConnectionSchema, request.body ?? {}, "body"),
      correlationId: createId("corr")
    })
  );
  app.delete("/email/connections/:id", async (request) => {
    await assertEntityAccess(request, { entity: "emailConnection", id: (request.params as { id: string }).id });
    return disconnectEmailConnection({ context: request.userContext, connectionId: (request.params as { id: string }).id, correlationId: createId("corr") });
  });
  app.get("/email/connections/:id/authorize-url", async (request) => {
    const id = (request.params as { id: string }).id;
    // Same guard as DELETE/poll; the connection is looked up in ITS property
    // (not the caller's active one) so unknown/foreign ids are an opaque 404.
    const propertyId = await assertPropertyEntityAccess(request, { entity: "emailConnection", id });
    const conn = (await listEmailConnections(propertyId)).find((c) => c.id === id);
    if (!conn) throw new NotFoundError("Conexión de correo no encontrada.");
    return { url: getEmailAuthorizeUrl(conn.provider as "gmail" | "microsoft", id) };
  });
  app.get("/integrations/email/oauth/callback", async (request, reply) => {
    const q = request.query as { state?: string; code?: string; error?: string };
    if (q.error || !q.state || !q.code) {
      reply.type("text/html");
      return `<html><body style="font-family:sans-serif;padding:40px"><h2>No se pudo conectar el correo</h2><p>${q.error ?? "Faltan parámetros."}</p></body></html>`;
    }
    try {
      const r = await handleEmailOAuthCallback(q.state, q.code);
      reply.type("text/html");
      return `<html><body style="font-family:sans-serif;padding:40px"><h2>✅ Buzón conectado</h2><p>${r.emailAddress ?? r.provider}. Ya puedes cerrar esta pestaña y volver a ${BRAND.name}.</p></body></html>`;
    } catch (err) {
      reply.type("text/html");
      return `<html><body style="font-family:sans-serif;padding:40px"><h2>Error al conectar</h2><p>${err instanceof Error ? err.message : "Error"}</p></body></html>`;
    }
  });
  app.post("/email/connections/:id/poll", async (request) => {
    await assertEntityAccess(request, { entity: "emailConnection", id: (request.params as { id: string }).id });
    return pollEmailConnection({ context: request.userContext, connectionId: (request.params as { id: string }).id, correlationId: createId("corr") });
  });
  // Tanda T9 (corrector RV-09): la ingesta manual reenvía `attachments` (única vía HTTP del buzón
  // `documents`: cada adjunto PDF / imagen / XML crea un documento del centro) con el bodyLimit de
  // las subidas de documentos (DOCUMENT_UPLOAD_BODY_LIMIT), como documents.routes.ts.
  app.post("/properties/:propertyId/email/ingest", { bodyLimit: getDocumentsUploadBodyLimit() }, async (request) => {
    const b = (request.body ?? {}) as { connectionId?: string; from?: string; subject?: string; body?: string; attachments?: Array<{ fileName: string; mimeType?: string; base64: string }> };
    const attachments = Array.isArray(b.attachments) ? b.attachments.filter((attachment) => attachment && typeof attachment === "object" && typeof attachment.fileName === "string" && typeof attachment.base64 === "string") : undefined;
    return ingestManualEmail({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, connectionId: b.connectionId, from: b.from, subject: b.subject, body: String(b.body ?? ""), ...(attachments && attachments.length > 0 ? { attachments } : {}), correlationId: createId("corr") });
  });
  app.get("/properties/:propertyId/email/inbound", async (request) => listInboundEmails((request.params as { propertyId: string }).propertyId, (request.query as { status?: string }).status));
  app.post("/email/inbound/:id/approve", async (request) => {
    await assertEntityAccess(request, { entity: "inboundEmail", id: (request.params as { id: string }).id });
    return approveEmailReservation({ context: request.userContext, inboundEmailId: (request.params as { id: string }).id, overrides: (request.body ?? {}) as never, correlationId: createId("corr") });
  });
  app.post("/email/inbound/:id/reject", async (request) => {
    await assertEntityAccess(request, { entity: "inboundEmail", id: (request.params as { id: string }).id });
    return rejectEmailReservation({ context: request.userContext, inboundEmailId: (request.params as { id: string }).id, reason: ((request.body ?? {}) as { reason?: string }).reason, correlationId: createId("corr") });
  });
  // Rate Plan CRUD (Fase 0) — backs the admin RatePlansScreen with persisted
  // data (the screen previously fell back to demo data with a "no implementado"
  // banner). Tenant scoping + permissions enforced inside the service.
  app.get("/properties/:propertyId/rate-plans", async (request) =>
    listRatePlans({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId }));
  app.post("/properties/:propertyId/rate-plans", async (request) =>
    createRatePlan({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never }));
  // By-id legs: the service's assertPropertyInOrg is strict (no platform-admin
  // escape), so the tenant guard runs first — foreign/missing → one opaque
  // 404, platform admins get re-pointed and the service check then passes.
  app.patch("/rate-plans/:id", async (request) => {
    await assertEntityAccess(request, { entity: "ratePlan", id: (request.params as { id: string }).id });
    return updateRatePlan({ context: request.userContext, id: (request.params as { id: string }).id, patch: request.body as never });
  });
  app.delete("/rate-plans/:id", async (request) => {
    await assertEntityAccess(request, { entity: "ratePlan", id: (request.params as { id: string }).id });
    return deleteRatePlan({ context: request.userContext, id: (request.params as { id: string }).id });
  });

  // Rate grid v2 · rate-manager routes (grid, bulk-update, push, sync-status,
  // journal, revert, rederive) and the per-day recommendations + demand
  // calendar (Prisma) of the revenue module. The outbox adapter turns the
  // delivery service's Map into the bridge's Record.
  registerRateGridRoutes(app, {
    outbox: {
      enqueueRateGridPush,
      getCellSyncMap: async (propertyId, from, to) => Object.fromEntries(await getCellSyncMapFromOutbox(propertyId, from, to))
    }
  });
  registerRecommendationRoutes(app);

  // Rate grid v2 · channel manager routes (channels, credentials, product
  // mappings, deliveries, drain, webhooks). The demoStore legs that lived here
  // (channels/sync/sync-health/reservations import/webhook/external
  // reservations) were retired: everything is Prisma + outbox now.
  registerChannelManagerRoutes(app);
  // Finanzas (2026-09-16, integración): the finance modules. Same tenant guard
  // as the inline billing routes (assertBillingAccess, defined above) for the
  // invoice PDF and the payment links; the fiscal routes post the VAT
  // settlement through the canonical ledger engine (accounting.service) instead
  // of their interim engine, so every asiento is numbered under one lock.
  registerLedgerRoutes(app);
  registerFiscalRoutes(app, { ledger: canonicalLedgerEngine });
  registerInvoicingRoutes(app, { assertInvoiceAccess: (request, id) => assertBillingAccess(request as never, "invoice", id) });
  registerPaymentsRoutes(app, { assertFolioAccess: (request, id) => assertBillingAccess(request as never, "folio", id) });
  registerPosRoutes(app);
  registerNightAuditRoutes(app);
  registerPayablesRoutes(app);
  registerFixedAssetsRoutes(app);
  registerTreasuryRoutes(app);
  registerFinancialStatementsRoutes(app);
  // Estructura societaria (Tanda 6b · L2): GET /organizations/me/structure,
  // /legal-entities/**, PATCH /properties/:propertyId/establishment and the
  // console route /admin/legal-entities/:legalEntityId/verifactu-scope.
  registerStructureRoutes(app);
  // RBAC por departamento (Tanda 8a · L1): asignaciones, roles, grupos de
  // propiedades, umbrales, bandeja de aprobaciones, PIN de supervisor, break
  // glass, informe y registro de accesos (/rbac/*, /approvals*).
  registerRbacRoutes(app);
  // Coste de personal importado (Tanda 6c · L3): previsualizar, importar y
  // contabilizar el informe de RRHH agregado, revertir lotes e informe
  // centros × meses (GET /payroll/cost-report).
  registerPayrollCostRoutes(app);
  // Fichas de personal (FIX-1 · F10): listar y dar de alta las fichas que
  // exige POST /payroll/contracts (antes no había alta y el cajón «Nuevo
  // contrato» acababa en 404 «Perfil de empleado no encontrado.»).
  registerStaffProfileRoutes(app);
  // Importación masiva de reservas (Tanda 7 · L3): previsualizar, importar,
  // listar, ver un lote, descargar la plantilla y deshacer
  // (/properties/:propertyId/reservations/imports*).
  registerReservationImportRoutes(app); // Importación masiva de reservas (Tanda 7 · L3)
  // OPERA Cloud · modo sombra (Tanda 7b · L3): ingest público por clave de API,
  // panel, perfil, cortes, alertas, reconciliación e ingresos diarios
  // (/integrations/pms-shadow/ingest y /properties/:propertyId/pms-shadow/*).
  registerPmsShadowRoutes(app);
  // Importación contable desde Sage 200 (Tanda 7c · L3): previsualizar, crear y
  // contabilizar lotes (plan, ejercicios, diario, IVA, terceros, saldos), mapas de
  // cuentas y analítico, plantilla canónica, reconciliación y reverso
  // (/accounting/ledger-imports* y /accounting/ledger-imports/reconciliation*).
  registerLedgerImportRoutes(app);
  // Documentos y digitalización con IA (Tanda T9): captura (subida/foto/valija),
  // registro, descarga, acciones y archivo (/properties/:propertyId/documents*,
  // /documents/:id*) con el bodyLimit del contrato (DOCUMENT_UPLOAD_BODY_LIMIT; con
  // una configuración inválida el API arranca igual, /health dice «unconfigured»
  // y las subidas responden 500 tipado: en producción el contrato ya aborta antes);
  // cada captura lanza el pipeline (clasificación, extracción con IA o reglas,
  // cotejo y propuesta) en segundo plano con la correlación de la petición; el
  // pipeline persiste su propio fallo (extraction_failed), aquí solo se registra.
  registerDocumentsRoutes(app, {
    uploadBodyLimit: getDocumentsUploadBodyLimit(),
    onCaptured: (documentId: string, correlationId: string) =>
      runDocumentPipeline(documentId, { trigger: "capture", correlationId }).catch((error: unknown) => {
        app.log.error({ err: error, documentId, correlationId }, "[documents] el pipeline tras la captura falló");
      })
  });
  registerDocumentPipelineRoutes(app);
  // Flujo de la oficina (Tanda T9 · T9-08): asignar, revisar, aprobar (factura /
  // gasto / recepción / tarea / archivo), rechazar, archivar, dividir / unir,
  // tareas con plazo y valija con hoja de remesa (modules/documents/workflow.routes.ts;
  // permisos en workflow-route-permissions.partial.ts).
  registerDocumentWorkflowRoutes(app);
  // Archivo, KPIs, ajustes por organización y retención (Tanda T9 · T9-13):
  // /organizations/:organizationId/documents/{archive,kpis,settings,:id/block|unblock|purge}
  // (modules/documents/archive.routes.ts; permisos en archive-route-permissions.partial.ts).
  registerDocumentArchiveRoutes(app);
  // Reputación y reseñas (Tanda T8 · T8-D): bandeja, detalle/PATCH/borrador/caso de
  // una reseña, fuentes, sincronización manual, ejecuciones e importación CSV
  // (/reputation/properties/:propertyId/* y /reputation/reviews/:id/*).
  registerReputationRoutes(app, {
    collectorOptions: {
      ...(process.env.GOOGLE_BUSINESS_CLIENT_ID ? { googleClientId: process.env.GOOGLE_BUSINESS_CLIENT_ID } : {}),
      ...(process.env.GOOGLE_BUSINESS_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET } : {}),
      ...(process.env.GOOGLE_BUSINESS_REDIRECT_URI ? { googleRedirectUri: process.env.GOOGLE_BUSINESS_REDIRECT_URI } : {})
    }
  }); // Reputación y reseñas (Tanda T8)
  // Check-in automatizado (Tanda CHK · W2-A): sesión de pre-llegada del huésped
  // (/guest-portal/check-in*, token opaco), llegadas, invitaciones, política y
  // kioscos del personal (/properties/:propertyId/check-in/* y /kiosks*).
  registerCheckinRoutes(app);
  registerRoomAssignmentRoutes(app); // Asignación explicable (Tanda CHK · W3-B): sugerencias, confirmación, lote, bloqueos y comunicadas
  // Stub /test removed — superseded by the Prisma-backed aggregator route below (~line 3903) that calls real OTA adapters.
  // Sprint 44: room/rate mapping CRUD rewired off the demoStore stub onto the
  // real Prisma-backed mapping.service so mappings written here are visible to
  // the aggregator's push paths (which read ChannelRoomMapping / ChannelRateMapping).
  app.get("/channel-manager/channels/:channelId/room-mappings", async (request) => {
    await assertEntityAccess(request, { entity: "channel", id: (request.params as { channelId: string }).channelId });
    const params = request.params as { channelId: string };
    return { mappings: await listChannelRoomMappings(params.channelId) };
  });
  app.post("/channel-manager/channels/:channelId/room-mappings", async (request) => {
    await assertEntityAccess(request, { entity: "channel", id: (request.params as { channelId: string }).channelId });
    const params = request.params as { channelId: string };
    const body = (request.body ?? {}) as { roomTypeId?: string; externalRoomId?: string | null; externalRoomCode?: string };
    if (!body.roomTypeId) throw new BadRequestError("roomTypeId is required.");
    if (!body.externalRoomCode) throw new BadRequestError("externalRoomCode is required.");
    return upsertChannelRoomMapping({
      channelId: params.channelId,
      roomTypeId: body.roomTypeId,
      externalRoomId: body.externalRoomId ?? null,
      externalRoomCode: body.externalRoomCode
    });
  });
  app.delete("/channel-manager/room-mappings/:id", async (request) => {
    await assertEntityAccess(request, { entity: "channelRoomMapping", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return deleteChannelRoomMapping(params.id);
  });
  app.get("/channel-manager/channels/:channelId/rate-mappings", async (request) => {
    await assertEntityAccess(request, { entity: "channel", id: (request.params as { channelId: string }).channelId });
    const params = request.params as { channelId: string };
    return { mappings: await listChannelRateMappings(params.channelId) };
  });
  app.post("/channel-manager/channels/:channelId/rate-mappings", async (request) => {
    await assertEntityAccess(request, { entity: "channel", id: (request.params as { channelId: string }).channelId });
    const params = request.params as { channelId: string };
    const body = (request.body ?? {}) as { ratePlanId?: string; externalRateId?: string | null; externalRateCode?: string };
    if (!body.ratePlanId) throw new BadRequestError("ratePlanId is required.");
    if (!body.externalRateCode) throw new BadRequestError("externalRateCode is required.");
    return upsertChannelRateMapping({
      channelId: params.channelId,
      ratePlanId: body.ratePlanId,
      externalRateId: body.externalRateId ?? null,
      externalRateCode: body.externalRateCode
    });
  });
  app.delete("/channel-manager/rate-mappings/:id", async (request) => {
    await assertEntityAccess(request, { entity: "channelRateMapping", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return deleteChannelRateMapping(params.id);
  });
  app.get("/channel-manager/channels/:channelId/mapping-coverage", async (request) => {
    await assertEntityAccess(request, { entity: "channel", id: (request.params as { channelId: string }).channelId });
    const params = request.params as { channelId: string };
    return channelMappingCoverage(params.channelId);
  });
  app.get("/channel-manager/channels/:channelId/readiness", async (request) => {
    await assertEntityAccess(request, { entity: "channel", id: (request.params as { channelId: string }).channelId });
    const params = request.params as { channelId: string };
    return channelReadinessChecklist(params.channelId);
  });
  app.get("/rate-shopper/properties/:propertyId/competitors", async (request) => {
    const params = request.params as { propertyId: string };
    return listCompetitors(params.propertyId);
  });
  app.post("/rate-shopper/properties/:propertyId/competitors", async (request) => {
    const params = request.params as { propertyId: string };
    return createCompetitor({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/rate-shopper/properties/:propertyId/rates", async (request) => {
    const params = request.params as { propertyId: string };
    const q = request.query as { from?: string; to?: string };
    return listCompetitorRates({ propertyId: params.propertyId, from: q.from, to: q.to });
  });
  app.post("/rate-shopper/properties/:propertyId/shop", async (request) => {
    const params = request.params as { propertyId: string };
    return runRateShop({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/rate-shopper/properties/:propertyId/parity-alerts", async (request) => {
    const params = request.params as { propertyId: string };
    return listParityAlerts(params.propertyId);
  });

  app.get("/crm/segments", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords(request.userContext.propertyId, "guest_data_crm_loyalty", "crm_segments", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/crm/segments", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "crm_segment", auditAction: "GuestSegmentCreated", requiredPermissions: ["crm.manage_profiles"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/crm/segments/:id", async (request) => {
    await assertEntityAccess(request, { entity: "crmSegment", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "crm_segment", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "GuestSegmentCreated", requiredPermissions: ["crm.manage_profiles"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/crm/campaigns", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords(request.userContext.propertyId, "guest_data_crm_loyalty", "crm_campaigns", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/crm/campaigns", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "crm_campaign", auditAction: "CampaignCreated", requiredPermissions: ["crm.manage_campaigns"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/crm/campaigns/:id", async (request) => {
    await assertEntityAccess(request, { entity: "crmCampaign", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "crm_campaign", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "CampaignCreated", requiredPermissions: ["crm.manage_campaigns"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/crm/loyalty", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords(request.userContext.propertyId, "guest_data_crm_loyalty", "loyalty", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/crm/loyalty/programs", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "loyalty_program", auditAction: "LoyaltyMembershipCreated", requiredPermissions: ["crm.manage_loyalty"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/crm/loyalty/memberships/:id", async (request) => {
    await assertEntityAccess(request, { entity: "loyaltyMembership", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "loyalty_membership", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "LoyaltyMembershipCreated", requiredPermissions: ["crm.manage_loyalty"], payload: request.body as never, correlationId: createId("corr") });
  });

  app.get("/sales/accounts", async (request) => listSalesAccounts(request.userContext.organizationId));
  app.post("/sales/accounts", async (request) => createSalesAccount({ context: request.userContext, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/sales/opportunities", async (request) => listSalesOpportunities(request.userContext.propertyId));
  app.post("/sales/opportunities", async (request) => createSalesOpportunity({ context: request.userContext, propertyId: request.userContext.propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/sales/opportunities/:id", async (request) => {
    await assertEntityAccess(request, { entity: "salesOpportunity", id: (request.params as { id: string }).id });
    return updateSalesOpportunity({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/groups/properties/:propertyId", async (request) => listGroupBookings((request.params as { propertyId: string }).propertyId));
  app.post("/groups/properties/:propertyId", async (request) => createGroupBooking({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/groups/:id", async (request) => {
    await assertEntityAccess(request, { entity: "groupBooking", id: (request.params as { id: string }).id });
    return getGroupBooking((request.params as { id: string }).id);
  });
  app.patch("/groups/:id", async (request) => {
    await assertEntityAccess(request, { entity: "groupBooking", id: (request.params as { id: string }).id });
    return updateGroupBooking({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/groups/:id/room-blocks", async (request) => {
    await assertEntityAccess(request, { entity: "groupBooking", id: (request.params as { id: string }).id });
    return createGroupRoomBlock({ context: request.userContext, groupId: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/groups/:id/room-blocks/bulk", async (request) => {
    await assertEntityAccess(request, { entity: "groupBooking", id: (request.params as { id: string }).id });
    return bulkCreateGroupRoomBlocks({ context: request.userContext, groupId: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/groups/:id/events", async (request) => {
    await assertEntityAccess(request, { entity: "groupBooking", id: (request.params as { id: string }).id });
    return createGroupEvent({ context: request.userContext, groupId: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/groups/:id/rooming-list/import", async (request) => {
    await assertEntityAccess(request, { entity: "groupBooking", id: (request.params as { id: string }).id });
    return importRoomingList({ context: request.userContext, groupId: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/properties/:propertyId/event-spaces", async (request) => listPropertyEventSpaces((request.params as { propertyId: string }).propertyId));
  app.post("/groups/:id/release-unsold", async (request) => {
    await assertEntityAccess(request, { entity: "groupBooking", id: (request.params as { id: string }).id });
    return releaseGroupUnsold({ context: request.userContext, groupId: (request.params as { id: string }).id, correlationId: createId("corr") });
  });
  app.post("/groups/:id/master-folio", async (request) => {
    await assertEntityAccess(request, { entity: "groupBooking", id: (request.params as { id: string }).id });
    return createGroupMasterFolio({ context: request.userContext, groupId: (request.params as { id: string }).id, correlationId: createId("corr") });
  });
  // Pickup summary del bloque grupal (next N días) para el dashboard de grupos.
  app.get("/properties/:propertyId/groups/pickup-summary", async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { windowDays?: string };
    return getGroupsPickupSummary({
      propertyId: params.propertyId,
      windowDays: query.windowDays ? Number(query.windowDays) : undefined
    });
  });
  // Cut-off enforcement: libera grupos vencidos (cutOffDate <= today) que sigan
  // en tentative/definite. Idempotente — equivalente al release diario de cupos.
  app.post("/properties/:propertyId/groups/release-expired", async (request) => {
    const params = request.params as { propertyId: string };
    return releaseExpiredGroupBlocks(params.propertyId);
  });
  app.get("/events/properties/:propertyId/calendar", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "groups_events_sales", "events_calendar", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/events/properties/:propertyId/spaces", async (request) => createEventSpace({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/events/properties/:propertyId/events", async (request) => createEvent({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/events/:id", async (request) => {
    await assertEntityAccess(request, { entity: "event", id: (request.params as { id: string }).id });
    return updateEvent({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") });
  });
  // By-id legs of the engine (Tanda L2 · corrector, SEC-L2-03/04): the row's
  // property returned by assertPropertyEntityAccess is the one the transition
  // or the child row runs in («la propiedad de la entidad siempre gana», T8a),
  // never the header's; and the parent id of a child row is the one of the
  // path (the guarded one), never a different id smuggled in the body.
  app.post("/events/:id/generate-beo", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "event", id: (request.params as { id: string }).id });
    return createAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "groups_events_sales", entityType: "event_order", auditAction: "BEOCreated", requiredPermissions: ["events.manage"], payload: { ...(request.body as Record<string, unknown>), eventId: (request.params as { id: string }).id }, correlationId: createId("corr") });
  });

  app.get("/workforce/properties/:propertyId/schedule", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "workforce_labor", "schedule", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/workforce/properties/:propertyId/shifts", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "workforce_labor", entityType: "shift", auditAction: "ShiftCreated", requiredPermissions: ["workforce.schedule.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/workforce/shifts/:id", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "shift", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "workforce_labor", entityType: "shift", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "ShiftUpdated", requiredPermissions: ["workforce.schedule.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/workforce/time-clock/clock-in", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "workforce_labor", entityType: "time_clock_entry", auditAction: "StaffClockedIn", requiredPermissions: ["workforce.timeclock.use"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/workforce/time-clock/clock-out", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "workforce_labor", entityType: "time_clock_entry", auditAction: "StaffClockedOut", requiredPermissions: ["workforce.timeclock.use"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/workforce/properties/:propertyId/time-clock", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "workforce_labor", "time_clock_entries", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/workforce/absences", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "workforce_labor", entityType: "absence_request", auditAction: "AbsenceRequested", requiredPermissions: ["workforce.schedule.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/workforce/absences/:id", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "absenceRequest", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "workforce_labor", entityType: "absence_request", entityId: (request.params as { id: string }).id, status: "approved", auditAction: "AbsenceApproved", requiredPermissions: ["workforce.schedule.manage"], payload: request.body as never, correlationId: createId("corr") });
  });

  app.get("/procurement/properties/:propertyId/purchase-orders", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "procurement_inventory", "purchase_orders", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/procurement/properties/:propertyId/purchase-orders", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "procurement_inventory", entityType: "purchase_order", auditAction: "PurchaseOrderCreated", requiredPermissions: ["purchase_orders.create"], payload: request.body as never, correlationId: createId("corr") }));
  // By-id legs of the engine (Tanda L2 · L2-02): the tenant guard resolves the
  // CONCRETE Prisma table (purchase_orders here; anomaly_events / guest_reviews
  // below) — an unknown or foreign id is one opaque 404 instead of a phantom
  // 200 + audit event, and the transition runs in the row's property.
  app.post("/procurement/purchase-orders/:id/approve", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "purchaseOrder", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "procurement_inventory", entityType: "purchase_order", entityId: (request.params as { id: string }).id, status: "approved", auditAction: "PurchaseOrderApproved", requiredPermissions: ["purchase_orders.approve"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/procurement/purchase-orders/:id/receive", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "purchaseOrder", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "procurement_inventory", entityType: "purchase_order", entityId: (request.params as { id: string }).id, status: "received", auditAction: "PurchaseOrderReceived", requiredPermissions: ["purchase_orders.receive"], payload: request.body as never, correlationId: createId("corr") });
  });

  app.get("/guest-portal/session/:token", async (request) => ({ token: (request.params as { token: string }).token, status: "active" }));
  // Finanzas (2026-09-15): the guest sees the REAL balance of the primary
  // folio of the reservation the token belongs to (never a literal 0), and
  // «pagar» creates a PSP payment link — or answers 409 PSP_NOT_CONFIGURED
  // honestly. No payment is ever recorded here.
  app.get("/guest-portal/session/:token/folio", async (request, reply) => {
    const session = await verifyGuestToken((request.params as { token: string }).token);
    if (!session) {
      reply.code(401);
      return { message: "Sesión del portal del huésped no válida o caducada." };
    }
    const folio = await findReservationFolio(session.reservationId);
    if (!folio) return { status: "no_folio", balanceDue: 0, currency: null, charges: [], payments: [] };
    return {
      status: folio.balanceDue > 0.005 ? "balance_due" : "settled",
      folioId: folio.folio.id,
      currency: folio.folio.currency,
      chargesTotal: folio.chargesTotal,
      paymentsTotal: folio.paymentsTotal,
      balanceDue: folio.balanceDue,
      reservationBalanceDue: folio.reservationBalanceDue,
      charges: folio.lines.map((line) => ({ description: line.description, quantity: line.quantity, total: line.total, postedAt: line.postedAt })),
      payments: folio.payments.map((payment) => ({ amount: payment.amount, method: payment.methodCode ?? payment.method, status: payment.status, createdAt: payment.createdAt }))
    };
  });
  app.post("/guest-portal/session/:token/pay", async (request, reply) => {
    const session = await verifyGuestToken((request.params as { token: string }).token);
    if (!session) {
      reply.code(401);
      return { message: "Sesión del portal del huésped no válida o caducada." };
    }
    const folio = await findReservationFolio(session.reservationId);
    if (!folio) throw new ConflictError("La reserva no tiene folio: no hay nada que pagar.");
    if (folio.balanceDue <= 0.005) throw new ConflictError("El folio no tiene saldo pendiente.");
    const body = (request.body ?? {}) as { returnUrl?: string; clientRequestId?: string };
    // Tanda CHK (W2-A, diseño R17): el enlace de pago del huésped se crea con el
    // contexto de servicio de SOLO payment.capture (modules/checkin/service-context.ts),
    // no con request.userContext (hasta ahora el super-usuario demo). El id del
    // actor es la reserva de la sesión verificada (VerifiedGuestSession no expone
    // el id de la fila y el token en claro nunca debe llegar a la auditoría).
    const result = await createPaymentLink({
      context: await paymentLinkServiceContext(session.propertyId, session.reservationId),
      folioId: folio.folio.id,
      amount: folio.balanceDue,
      methodCode: "payment_link",
      clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId : `guest-portal:${session.reservationId}:${folio.balanceDue.toFixed(2)}`,
      returnUrl: typeof body.returnUrl === "string" ? body.returnUrl : null,
      correlationId: createId("corr")
    });
    reply.code(result.idempotent ? 200 : 202);
    return result;
  });
  // ---- Guest portal real auth + pre-check-in + service requests (Sprint 40) ----
  // These routes are public in the staff-permission manifest (empty perms) so
  // the preHandler passes; the guest token IS the auth and is verified inside
  // each handler. A GuestPortalAuthError (statusCode 401) maps to a 401 reply.
  const guestTokenFrom = (request: { headers: Record<string, unknown>; query?: unknown }): string => {
    const header = request.headers["x-guest-token"];
    if (typeof header === "string" && header.trim() !== "") return header.trim();
    if (Array.isArray(header) && typeof header[0] === "string") return header[0].trim();
    const query = (request.query ?? {}) as { token?: unknown };
    if (typeof query.token === "string") return query.token.trim();
    return "";
  };

  app.post("/guest-portal/sign-in", async (request) => {
    const body = (request.body ?? {}) as { reservationCode?: string; email?: string; propertyId?: string };
    const query = (request.query ?? {}) as { propertyId?: string };
    // propertyId scopes the lookup to a tenant — without it Reservation.code
    // collisions would leak sessions cross-property. Accept it from the body
    // first, then from the query string as a fallback.
    const propertyId = String(body.propertyId ?? query.propertyId ?? "");
    return guestPortalRequestSignIn({
      reservationCode: String(body.reservationCode ?? ""),
      email: String(body.email ?? ""),
      propertyId
    });
  });

  app.post("/guest-portal/sign-out", async (request) => {
    const body = (request.body ?? {}) as { token?: string };
    const token = body.token ?? guestTokenFrom(request);
    return guestPortalSignOut(token);
  });

  app.get("/guest-portal/reservation", async (request, reply) => {
    try {
      return await getGuestReservationView(guestTokenFrom(request));
    } catch (error) {
      if (error instanceof GuestPortalAuthError) {
        reply.code(error.statusCode);
        return { message: error.message };
      }
      throw error;
    }
  });

  app.post("/guest-portal/pre-check-in", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    try {
      return await guestPortalSubmitPreCheckIn({
        token: guestTokenFrom(request),
        documentType: body.documentType,
        documentNumber: body.documentNumber,
        residenceAddress: body.residenceAddress,
        country: body.country,
        arrivalEta: body.arrivalEta,
        specialRequests: body.specialRequests
      });
    } catch (error) {
      if (error instanceof GuestPortalAuthError) {
        reply.code(error.statusCode);
        return { message: error.message };
      }
      throw error;
    }
  });

  app.post("/guest-portal/service-request", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    try {
      return await guestPortalSubmitServiceRequest({
        token: guestTokenFrom(request),
        category: String(body.category ?? ""),
        description: body.description,
        preferredTime: body.preferredTime
      });
    } catch (error) {
      if (error instanceof GuestPortalAuthError) {
        reply.code(error.statusCode);
        return { message: error.message };
      }
      throw error;
    }
  });

  app.get("/reputation/properties/:propertyId/reviews", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "reputation_quality", "guest_reviews", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/reputation/reviews/:id/respond", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "guestReview", id: (request.params as { id: string }).id });
    // Reputación (Tanda T8): 409 REVIEW_DRAFT_REJECTED si el texto es el borrador cuyo ítem HITL fue rechazado (texto editado → pasa).
    await assertDraftPublishable({ reviewId: (request.params as { id: string }).id, responseBody: (request.body as { responseBody?: string; body?: string } | null)?.responseBody ?? (request.body as { body?: string } | null)?.body });
    return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "reputation_quality", entityType: "guest_review", entityId: (request.params as { id: string }).id, status: "responded", auditAction: "ReviewResponseSent", requiredPermissions: ["reputation.respond"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/quality/properties/:propertyId/cases", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "reputation_quality", "quality_cases", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/quality/properties/:propertyId/cases", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "reputation_quality", entityType: "quality_case", auditAction: "QualityCaseCreated", requiredPermissions: ["quality_cases.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/quality/cases/:id", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "qualityCase", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "reputation_quality", entityType: "quality_case", entityId: (request.params as { id: string }).id, status: "updated", auditAction: ["resolved", "closed"].includes(String((request.body as { status?: string } | null)?.status ?? "")) ? "QualityCaseResolved" : "QualityCaseUpdated", requiredPermissions: ["quality_cases.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/surveys/properties/:propertyId", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "reputation_quality", "surveys", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/surveys/properties/:propertyId", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "reputation_quality", entityType: "survey", auditAction: "SurveyCreated", requiredPermissions: ["surveys.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/surveys/:id/responses", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "survey", id: (request.params as { id: string }).id });
    return createAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "reputation_quality", entityType: "survey_response", auditAction: "SurveyResponseReceived", requiredPermissions: ["surveys.manage"], payload: { ...requireObjectBody(request.body), surveyId: (request.params as { id: string }).id }, correlationId: createId("corr") });
  });

  app.get("/energy/properties/:propertyId/meters", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "energy_sustainability", "utility_meters", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/energy/properties/:propertyId/meters", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "energy_sustainability", entityType: "utility_meter", auditAction: "UtilityMeterCreated", requiredPermissions: ["energy.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/energy/properties/:propertyId/readings", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "energy_sustainability", entityType: "utility_reading", auditAction: "UtilityReadingCreated", requiredPermissions: ["energy.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/sustainability/properties/:propertyId/actions", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "energy_sustainability", entityType: "sustainability_action", auditAction: "SustainabilityActionCreated", requiredPermissions: ["sustainability.report"], payload: request.body as never, correlationId: createId("corr") }));

  app.get("/safety/properties/:propertyId/incidents", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "safety_incident_management", "safety_incidents", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/safety/properties/:propertyId/incidents", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "safety_incident_management", entityType: "safety_incident", auditAction: "SafetyIncidentCreated", requiredPermissions: ["incidents.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/safety/incidents/:id", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "safetyIncident", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "safety_incident_management", entityType: "safety_incident", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "SafetyIncidentUpdated", requiredPermissions: ["incidents.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/safety/incidents/:id/evidence", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "safetyIncident", id: (request.params as { id: string }).id });
    return createAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "safety_incident_management", entityType: "incident_evidence", auditAction: "IncidentEvidenceAdded", requiredPermissions: ["incidents.manage"], payload: { ...requireObjectBody(request.body), incidentId: (request.params as { id: string }).id }, correlationId: createId("corr") });
  });
  app.get("/safety/properties/:propertyId/checks", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "safety_incident_management", "safety_checks", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/safety/properties/:propertyId/checks", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "safety_incident_management", entityType: "safety_check", auditAction: "SafetyCheckCreated", requiredPermissions: ["safety_checks.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/safety/checks/:id/results", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "safetyCheck", id: (request.params as { id: string }).id });
    return createAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "safety_incident_management", entityType: "safety_check_result", auditAction: "SafetyCheckCompleted", requiredPermissions: ["safety_checks.manage"], payload: { ...requireObjectBody(request.body), safetyCheckId: (request.params as { id: string }).id }, correlationId: createId("corr") });
  });

  app.get("/analytics/properties/:propertyId/metrics", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "hotel_intelligence_platform", "metrics", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/analytics/metrics", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "hotel_intelligence_platform", entityType: "metric_definition", auditAction: "MetricDefinitionCreated", requiredPermissions: ["metrics.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/analytics/properties/:propertyId/anomalies", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "hotel_intelligence_platform", "anomalies", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.patch("/analytics/anomalies/:id", async (request) => {
    const propertyId = await assertPropertyEntityAccess(request, { entity: "anomalyEvent", id: (request.params as { id: string }).id });
    return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "hotel_intelligence_platform", entityType: "anomaly_event", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "AnomalyDetected", requiredPermissions: ["analytics.configure"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/analytics/properties/:propertyId/reports", async (request, reply) => {
    const query = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const page = await listAdvancedRecords((request.params as { propertyId: string }).propertyId, "hotel_intelligence_platform", "scheduled_reports", query);
    reply.headers(pageHeaders(page));
    return page;
  });
  app.post("/analytics/properties/:propertyId/reports", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "hotel_intelligence_platform", entityType: "scheduled_report", auditAction: "ScheduledReportGenerated", requiredPermissions: ["analytics.configure"], payload: request.body as never, correlationId: createId("corr") }));


  // Auto-generated OpenAPI spec served from apps/api/docs/openapi.yaml.
  // Regenerate via `node apps/api/scripts/generate-openapi.mjs`.
  app.get("/developer/openapi.yaml", async (_request, reply) => {
    const candidates = [
      resolvePath2(process.cwd(), "docs/openapi.yaml"),
      resolvePath2(process.cwd(), "apps/api/docs/openapi.yaml"),
      resolvePath2(process.cwd(), "../../apps/api/docs/openapi.yaml")
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const yaml = readFileSync(candidate, "utf-8");
      reply.header("content-type", "text/yaml; charset=utf-8");
      return reply.send(yaml);
    }
    reply.code(404);
    return { error: "openapi.yaml not found — run apps/api/scripts/generate-openapi.mjs to generate it" };
  });

  // AI Operations — pipeline status (Sprint 48, tool-call telemetry)
  app.get("/ai-operations/pipeline/dashboard", async (request) => {
    const q = request.query as { organizationId?: string; propertyId?: string; days?: string };
    const organizationId = await resolveOrganizationScope(request, q.organizationId);
    return buildPipelineDashboard({
      organizationId,
      propertyId: q.propertyId,
      days: q.days ? Number(q.days) : undefined
    });
  });
  app.get("/ai-operations/pipeline/calls/:id", async (request) => {
    await assertEntityAccess(request, { entity: "aiToolCall", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const call = await getToolCall(params.id);
    if (!call) {
      return { status: "not_found" };
    }
    return call;
  });

  // AI Operations — Tool Registry (Sprint 47, catalog + per-property enablement)
  app.post("/ai-operations/tools/sync", async (request) => {
    const context = request.userContext;
    return syncToolRegistry(context);
  });
  app.get("/ai-operations/tools", async (request) => {
    const q = request.query as { moduleCode?: string; riskLevel?: string; search?: string };
    return listAiTools({
      context: request.userContext,
      moduleCode: q.moduleCode,
      riskLevel: q.riskLevel,
      search: q.search
    });
  });
  app.get("/ai-operations/tools/stats", async (request) => {
    return aiToolRegistryStats(request.userContext);
  });
  app.get("/ai-operations/tools/property-settings", async (request) => {
    const q = request.query as { propertyId?: string };
    const context = request.userContext;
    return listAiPropertyToolSettings({
      context,
      propertyId: q.propertyId ?? context.propertyId
    });
  });
  app.post("/ai-operations/tools/property-settings", async (request) => {
    const body = request.body as {
      propertyId?: string;
      toolName: string;
      enabled?: boolean;
      automationLevel?: AiAutomationLevel;
      requiresConfirmation?: boolean;
      requiresApprovalRole?: string | null;
      configurationJson?: Record<string, unknown>;
    };
    const context = request.userContext;
    return setAiPropertyToolSetting({
      context,
      propertyId: body.propertyId ?? context.propertyId,
      toolName: body.toolName,
      enabled: body.enabled,
      automationLevel: body.automationLevel,
      requiresConfirmation: body.requiresConfirmation,
      requiresApprovalRole: body.requiresApprovalRole,
      configurationJson: body.configurationJson
    });
  });
  app.get("/ai-operations/tools/:toolName", async (request) => {
    const params = request.params as { toolName: string };
    return getAiTool({
      context: request.userContext,
      toolName: params.toolName
    });
  });

  // AI Operations — per-property AI settings (Sprint 51)
  app.get("/ai-operations/property/settings", async (request) => {
    const q = request.query as { propertyId?: string };
    const propertyId = q.propertyId ?? request.userContext.propertyId;
    return getPropertyAiSettings(propertyId);
  });
  app.post("/ai-operations/property/settings", async (request) => {
    const body = (request.body ?? {}) as {
      propertyId?: string;
      aiEnabled?: boolean;
      defaultAutomationLevel?: AutomationLevel;
      guestFacingDisclosure?: string | null;
      voiceLocales?: string[];
      configurationJson?: Record<string, unknown>;
    };
    const propertyId = body.propertyId ?? request.userContext.propertyId;
    return updatePropertyAiSettings({
      propertyId,
      aiEnabled: body.aiEnabled,
      defaultAutomationLevel: body.defaultAutomationLevel,
      guestFacingDisclosure: body.guestFacingDisclosure,
      voiceLocales: body.voiceLocales,
      configurationJson: body.configurationJson,
      organizationId: request.userContext?.organizationId,
      actorUserId: request.userContext?.userId
    });
  });
  app.get("/ai-operations/property/readiness", async (request) => {
    const q = request.query as { propertyId?: string };
    const propertyId = q.propertyId ?? request.userContext.propertyId;
    return aiReadiness(propertyId);
  });
  app.get("/ai-operations/property/configured", async (request) => {
    const q = request.query as { organizationId?: string };
    const organizationId = await resolveOrganizationScope(request, q.organizationId);
    return listConfiguredProperties(organizationId);
  });

  app.get("/backoffice/properties/:propertyId/dashboard", async (request) => {
    const params = request.params as { propertyId: string };
    return getBackOfficeDashboard(params.propertyId);
  });

  app.get("/backoffice/properties/:propertyId/configuration", async (request) => {
    const params = request.params as { propertyId: string };
    return getConfigurationCenter(params.propertyId);
  });

  app.get("/backoffice/properties/:propertyId/configuration/categories", async (request) => {
    const params = request.params as { propertyId: string };
    return listConfigurationCategories(params.propertyId);
  });

  app.get("/backoffice/properties/:propertyId/configuration/categories/:categoryCode", async (request) => {
    const params = request.params as { propertyId: string; categoryCode: string };
    return getConfigurationCategory(params.propertyId, params.categoryCode);
  });

  app.post("/backoffice/properties/:propertyId/configuration/categories/:categoryCode/options", async (request) => {
    const params = request.params as { propertyId: string; categoryCode: string };
    return createCategoryOption({
      context: request.userContext,
      propertyId: params.propertyId,
      categoryCode: params.categoryCode,
      option: request.body as Parameters<typeof createCategoryOption>[0]["option"],
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/configuration/category-options/:optionId", async (request) => {
    const params = request.params as { propertyId: string; optionId: string };
    return patchCategoryOption({
      context: request.userContext,
      propertyId: params.propertyId,
      optionId: params.optionId,
      patch: request.body as Parameters<typeof patchCategoryOption>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/configuration/category-options/:optionId/deactivate", async (request) => {
    const params = request.params as { propertyId: string; optionId: string };
    return setCategoryOptionActive({
      context: request.userContext,
      propertyId: params.propertyId,
      optionId: params.optionId,
      active: false,
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/configuration/category-options/:optionId/reactivate", async (request) => {
    const params = request.params as { propertyId: string; optionId: string };
    return setCategoryOptionActive({
      context: request.userContext,
      propertyId: params.propertyId,
      optionId: params.optionId,
      active: true,
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/configuration/categories/:categoryCode/reorder", async (request) => {
    const params = request.params as { propertyId: string; categoryCode: string };
    const body = request.body as { optionIds: string[] };
    return reorderCategoryOptions({
      context: request.userContext,
      propertyId: params.propertyId,
      categoryCode: params.categoryCode,
      optionIds: body.optionIds ?? [],
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/configuration/custom-fields", async (request) => {
    const params = request.params as { propertyId: string };
    return listCustomFields(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/configuration/custom-fields", async (request) => {
    const params = request.params as { propertyId: string };
    return createCustomField({
      context: request.userContext,
      propertyId: params.propertyId,
      field: request.body as Parameters<typeof createCustomField>[0]["field"],
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/configuration/custom-fields/:fieldId", async (request) => {
    const params = request.params as { propertyId: string; fieldId: string };
    return patchCustomField({
      context: request.userContext,
      propertyId: params.propertyId,
      fieldId: params.fieldId,
      patch: request.body as Parameters<typeof patchCustomField>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/configuration/custom-fields/:fieldId/deactivate", async (request) => {
    const params = request.params as { propertyId: string; fieldId: string };
    return patchCustomField({
      context: request.userContext,
      propertyId: params.propertyId,
      fieldId: params.fieldId,
      patch: { active: false },
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/configuration/entity/:entityType/:entityId/custom-fields", async (request) => {
    const params = request.params as { propertyId: string; entityType: string; entityId: string };
    return getEntityCustomFields(params.propertyId, params.entityType, params.entityId);
  });

  app.patch("/backoffice/properties/:propertyId/configuration/entity/:entityType/:entityId/custom-fields", async (request) => {
    const params = request.params as { propertyId: string; entityType: string; entityId: string };
    const body = request.body as { values: Parameters<typeof patchEntityCustomFields>[0]["values"] };
    return patchEntityCustomFields({
      context: request.userContext,
      propertyId: params.propertyId,
      entityType: params.entityType,
      entityId: params.entityId,
      values: body.values ?? [],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/configuration/categories/seed-defaults", async (request) => {
    const params = request.params as { propertyId: string };
    return seedDefaultCategories({ context: request.userContext, propertyId: params.propertyId, correlationId: createId("corr") });
  });

  app.post("/backoffice/properties/:propertyId/configuration/categories/import", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { rows?: Array<Record<string, unknown>>; confirmationProvided?: boolean };
    return body.confirmationProvided
      ? applyCategoryImport({ context: request.userContext, propertyId: params.propertyId, rows: body.rows ?? [], confirmationProvided: true, correlationId: createId("corr") })
      : previewCategoryImport({ context: request.userContext, propertyId: params.propertyId, rows: body.rows ?? [], correlationId: createId("corr") });
  });

  app.post("/backoffice/properties/:propertyId/configuration/categories/export", async (request) => {
    const params = request.params as { propertyId: string };
    return exportCategories({ context: request.userContext, propertyId: params.propertyId, correlationId: createId("corr") });
  });

  app.get("/backoffice/configuration/category-templates", async (request) => listCategoryTemplates());

  app.post("/backoffice/properties/:propertyId/configuration/category-templates/:templateCode/apply-preview", async (request) => {
    const params = request.params as { propertyId: string; templateCode: string };
    return previewCategoryTemplate({ context: request.userContext, propertyId: params.propertyId, templateCode: params.templateCode, correlationId: createId("corr") });
  });

  app.post("/backoffice/properties/:propertyId/configuration/category-templates/:templateCode/apply", async (request) => {
    const params = request.params as { propertyId: string; templateCode: string };
    const body = request.body as { confirmationProvided?: boolean };
    return applyCategoryTemplate({
      context: request.userContext,
      propertyId: params.propertyId,
      templateCode: params.templateCode,
      confirmationProvided: body.confirmationProvided,
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/configuration/ai/suggest-categories", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { prompt?: string };
    return suggestPropertyCategories({
      context: request.userContext,
      propertyId: params.propertyId,
      prompt: body.prompt ?? "Create room features for a boutique beach hotel.",
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/setup", async (request) => {
    const params = request.params as { propertyId: string };
    return getSetupProgress(params.propertyId);
  });

  app.get("/backoffice/properties/:propertyId/manual-setup/options", async (request) => {
    const params = request.params as { propertyId: string };
    return listManualSetupOptions(params.propertyId);
  });

  app.get("/backoffice/properties/:propertyId/manual-setup/:optionCode", async (request) => {
    const params = request.params as { propertyId: string; optionCode: string };
    return getManualSetupOptionDetail(params.propertyId, params.optionCode);
  });

  app.post("/backoffice/properties/:propertyId/manual-setup/:optionCode", async (request) => {
    const params = request.params as { propertyId: string; optionCode: string };
    return saveManualSetupOption({
      context: request.userContext,
      propertyId: params.propertyId,
      optionCode: params.optionCode,
      payload: request.body as never,
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/manual-setup/:optionCode", async (request) => {
    const params = request.params as { propertyId: string; optionCode: string };
    return saveManualSetupOption({
      context: request.userContext,
      propertyId: params.propertyId,
      optionCode: params.optionCode,
      payload: request.body as never,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/property-setup/forms", async (request) => {
    const params = request.params as { propertyId: string };
    return listPropertySetupForms(params.propertyId);
  });

  app.get("/backoffice/properties/:propertyId/property-setup/forms/:formCode", async (request) => {
    const params = request.params as { propertyId: string; formCode: string };
    return getPropertySetupForm(params.propertyId, params.formCode);
  });

  app.post("/backoffice/properties/:propertyId/property-setup/forms/:formCode", async (request) => {
    const params = request.params as { propertyId: string; formCode: string };
    return savePropertySetupForm({
      context: request.userContext,
      propertyId: params.propertyId,
      formCode: params.formCode,
      payload: request.body as never,
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/property-setup/forms/:formCode", async (request) => {
    const params = request.params as { propertyId: string; formCode: string };
    return savePropertySetupForm({
      context: request.userContext,
      propertyId: params.propertyId,
      formCode: params.formCode,
      payload: request.body as never,
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/setup/:stepCode", async (request) => {
    const params = request.params as { propertyId: string; stepCode: string };
    const body = request.body as { status: Parameters<typeof updateSetupStep>[0]["status"]; metadataJson?: Record<string, unknown> };
    return updateSetupStep({
      context: request.userContext,
      propertyId: params.propertyId,
      stepCode: params.stepCode,
      status: body.status,
      metadataJson: body.metadataJson,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/readiness", async (request) => {
    const params = request.params as { propertyId: string };
    return getReadiness(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/readiness/recalculate", async (request) => {
    const params = request.params as { propertyId: string };
    return recalculateReadiness({
      context: request.userContext,
      propertyId: params.propertyId,
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/go-live", async (request) => {
    const params = request.params as { propertyId: string };
    return approveGoLive({
      context: request.userContext,
      propertyId: params.propertyId,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/map", async (request) => {
    const params = request.params as { propertyId: string };
    return getPropertyMap(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/buildings", async (request) => {
    const params = request.params as { propertyId: string };
    return createBuilding({
      context: request.userContext,
      propertyId: params.propertyId,
      building: request.body as Parameters<typeof createBuilding>[0]["building"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/floors", async (request) => {
    const params = request.params as { propertyId: string };
    return createFloor({
      context: request.userContext,
      propertyId: params.propertyId,
      floor: request.body as Parameters<typeof createFloor>[0]["floor"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/zones", async (request) => {
    const params = request.params as { propertyId: string };
    return createZone({
      context: request.userContext,
      propertyId: params.propertyId,
      zone: request.body as Parameters<typeof createZone>[0]["zone"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/spaces", async (request) => {
    const params = request.params as { propertyId: string };
    return createSpace({
      context: request.userContext,
      propertyId: params.propertyId,
      space: request.body as Parameters<typeof createSpace>[0]["space"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/rooms/bulk", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as Omit<Parameters<typeof bulkCreateRooms>[0], "context" | "propertyId" | "correlationId">;
    return bulkCreateRooms({
      context: request.userContext,
      propertyId: params.propertyId,
      ...body,
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/rooms/bulk", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as Omit<Parameters<typeof bulkUpdateRooms>[0], "context" | "propertyId" | "correlationId">;
    return bulkUpdateRooms({
      context: request.userContext,
      propertyId: params.propertyId,
      ...body,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/room-types", async (request) => {
    const params = request.params as { propertyId: string };
    return listBackOfficeRoomTypes(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/room-types", async (request) => {
    const params = request.params as { propertyId: string };
    return createBackOfficeRoomType({
      context: request.userContext,
      propertyId: params.propertyId,
      roomType: request.body as Parameters<typeof createBackOfficeRoomType>[0]["roomType"],
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/room-types/:roomTypeId", async (request) => {
    await assertEntityAccess(request, { entity: "roomType", id: (request.params as { roomTypeId: string }).roomTypeId, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { propertyId: string; roomTypeId: string };
    return patchBackOfficeRoomType({
      context: request.userContext,
      propertyId: params.propertyId,
      roomTypeId: params.roomTypeId,
      patch: request.body as Parameters<typeof patchBackOfficeRoomType>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/room-types/:roomTypeId/deactivate", async (request) => {
    await assertEntityAccess(request, { entity: "roomType", id: (request.params as { roomTypeId: string }).roomTypeId, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { propertyId: string; roomTypeId: string };
    return deactivateBackOfficeRoomType({
      context: request.userContext,
      propertyId: params.propertyId,
      roomTypeId: params.roomTypeId,
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/room-types/:roomTypeId/merge", async (request) => {
    await assertEntityAccess(request, { entity: "roomType", id: (request.params as { roomTypeId: string }).roomTypeId, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { propertyId: string; roomTypeId: string };
    const body = request.body as { targetRoomTypeId: string };
    // Both room types must hang from the path property (confused-deputy check).
    if (typeof body.targetRoomTypeId === "string" && body.targetRoomTypeId.length > 0) {
      await assertEntityAccess(request, { entity: "roomType", id: body.targetRoomTypeId, propertyId: params.propertyId });
    }
    return mergeBackOfficeRoomTypes({
      context: request.userContext,
      propertyId: params.propertyId,
      sourceRoomTypeId: params.roomTypeId,
      targetRoomTypeId: body.targetRoomTypeId,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/room-types/:roomTypeId/rooms", async (request) => {
    const params = request.params as { roomTypeId: string };
    const { prisma } = await import("@hotelos/database");
    // The path carries no propertyId: resolve it from the room type and make
    // sure it belongs to the caller's organization before listing rooms.
    const roomType =
      (await prisma.roomType.findUnique({ where: { id: params.roomTypeId }, select: { propertyId: true } })) ??
      demoStore.roomTypes.find((candidate) => candidate.id === params.roomTypeId) ??
      null;
    if (!roomType) throw new NotFoundError("Tipo de habitación no encontrado.");
    // Same rule as the global tenant guard: unknown/foreign property → 404 with
    // the SAME message as an unknown room type (no oracle); a platform admin
    // gets organizationId re-pointed to the property's org instead.
    await grantPropertyAccess(request, roomType.propertyId, "Tipo de habitación no encontrado.");
    return listRoomsForRoomType(roomType.propertyId, params.roomTypeId);
  });

  app.get("/backoffice/properties/:propertyId/room-features", async (request) => {
    const params = request.params as { propertyId: string };
    return listRoomFeatures(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/room-features", async (request) => {
    const params = request.params as { propertyId: string };
    return createRoomFeature({
      context: request.userContext,
      propertyId: params.propertyId,
      feature: request.body as Parameters<typeof createRoomFeature>[0]["feature"],
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/bed-types", async (request) => {
    const params = request.params as { propertyId: string };
    return listBedTypes(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/bed-types", async (request) => {
    const params = request.params as { propertyId: string };
    return createBedType({
      context: request.userContext,
      propertyId: params.propertyId,
      bedType: request.body as Parameters<typeof createBedType>[0]["bedType"],
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/imports/:importId", async (request) => {
    const params = request.params as { propertyId: string; importId: string };
    return getPropertyImport(params.propertyId, params.importId);
  });

  app.get("/backoffice/properties/:propertyId/modules", async (request) => {
    const params = request.params as { propertyId: string };
    return listBackOfficeModules(params.propertyId);
  });

  app.patch("/backoffice/properties/:propertyId/modules/:moduleCode", async (request) => {
    const params = request.params as { propertyId: string; moduleCode: HotelModuleCode };
    // Missing/non-object body → 400 in Spanish (was a TypeError → 500); the
    // shape is strict (L1c) and an empty object is a 400 instead of a silent
    // no-op that re-saved the module unchanged with a 200.
    const body = parse(ModuleStatePatchSchema, requireObjectBody(request.body));
    if (body.action === undefined && body.configurationJson === undefined) {
      throw new BadRequestError("Sin cambios que aplicar: indica action (enable | disable) o configurationJson.");
    }
    if (body.action === "enable") {
      return enablePropertyModule({
        context: request.userContext,
        propertyId: params.propertyId,
        moduleCode: params.moduleCode,
        configurationJson: body.configurationJson,
        correlationId: createId("corr")
      });
    }
    if (body.action === "disable") {
      return disablePropertyModule({
        context: request.userContext,
        propertyId: params.propertyId,
        moduleCode: params.moduleCode,
        correlationId: createId("corr")
      });
    }
    return configureModule({
      context: request.userContext,
      propertyId: params.propertyId,
      moduleCode: params.moduleCode,
      configurationJson: body.configurationJson ?? {},
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/modules/:moduleCode/configuration", async (request) => {
    const params = request.params as { propertyId: string; moduleCode: HotelModuleCode };
    return getModuleConfiguration(params.propertyId, params.moduleCode);
  });

  app.patch("/backoffice/properties/:propertyId/modules/:moduleCode/configuration", async (request) => {
    const params = request.params as { propertyId: string; moduleCode: HotelModuleCode };
    const body = request.body as { configurationJson?: Record<string, unknown> };
    return configureModule({
      context: request.userContext,
      propertyId: params.propertyId,
      moduleCode: params.moduleCode,
      configurationJson: body.configurationJson ?? {},
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/modules/:moduleCode/recalculate-health", async (request) => {
    const params = request.params as { propertyId: string; moduleCode: HotelModuleCode };
    return recalculateModuleHealth({
      context: request.userContext,
      propertyId: params.propertyId,
      moduleCode: params.moduleCode,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/departments", async (request) => {
    const params = request.params as { propertyId: string };
    return listDepartments(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/departments", async (request) => {
    const params = request.params as { propertyId: string };
    return createDepartment({
      context: request.userContext,
      propertyId: params.propertyId,
      department: request.body as Parameters<typeof createDepartment>[0]["department"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/departments/:departmentId/users", async (request) => {
    const params = request.params as { propertyId: string; departmentId: string };
    const body = request.body as { userId: string; roleLabel?: string };
    return assignUserToDepartment({
      context: request.userContext,
      propertyId: params.propertyId,
      departmentId: params.departmentId,
      userId: body.userId,
      roleLabel: body.roleLabel,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/housekeeping-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return getHousekeepingConfiguration(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/housekeeping-sections", async (request) => {
    const params = request.params as { propertyId: string };
    return createHousekeepingSection({
      context: request.userContext,
      propertyId: params.propertyId,
      section: request.body as Parameters<typeof createHousekeepingSection>[0]["section"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/housekeeping-sections/:sectionId/rooms", async (request) => {
    const params = request.params as { propertyId: string; sectionId: string };
    const body = request.body as { roomIds: string[] };
    return assignRoomsToHousekeepingSection({
      context: request.userContext,
      propertyId: params.propertyId,
      sectionId: params.sectionId,
      roomIds: body.roomIds,
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/housekeeping-rules/:ruleCode", async (request) => {
    const params = request.params as { propertyId: string; ruleCode: string };
    const body = request.body as { configurationJson?: Record<string, unknown>; active?: boolean };
    return upsertHousekeepingRule({
      context: request.userContext,
      propertyId: params.propertyId,
      ruleCode: params.ruleCode,
      configurationJson: body.configurationJson ?? {},
      active: body.active,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/maintenance-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return getMaintenanceConfiguration(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/maintenance-areas", async (request) => {
    const params = request.params as { propertyId: string };
    return createMaintenanceArea({
      context: request.userContext,
      propertyId: params.propertyId,
      area: request.body as Parameters<typeof createMaintenanceArea>[0]["area"],
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/maintenance-areas/:areaId/rooms", async (request) => {
    const params = request.params as { propertyId: string; areaId: string };
    const body = request.body as { roomIds: string[] };
    return assignRoomsToMaintenanceArea({
      context: request.userContext,
      propertyId: params.propertyId,
      areaId: params.areaId,
      roomIds: body.roomIds,
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/maintenance-rules/:ruleCode", async (request) => {
    const params = request.params as { propertyId: string; ruleCode: string };
    const body = request.body as { configurationJson?: Record<string, unknown>; active?: boolean };
    return upsertMaintenanceRule({
      context: request.userContext,
      propertyId: params.propertyId,
      ruleCode: params.ruleCode,
      configurationJson: body.configurationJson ?? {},
      active: body.active,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/users", async (request) => {
    const params = request.params as { propertyId: string };
    return listBackOfficeUsers(params.propertyId);
  });

  // Tanda 3 (CFG-P1-6): the invitation now carries the role and produces a
  // persisted token + email delivery state (see inviteBackOfficeUser). The
  // body is validated here (400) instead of trusting the client shape.
  app.post("/backoffice/properties/:propertyId/users/invite", async (request) => {
    const params = request.params as { propertyId: string };
    const body = parse(InviteBackOfficeUserSchema, request.body);
    return inviteBackOfficeUser({
      context: request.userContext,
      propertyId: params.propertyId,
      ...body,
      correlationId: createId("corr")
    });
  });

  // Roles of the property's organization (Prisma `Role`), for the invite role
  // selector. `GET /backoffice/roles` below is the static template catalogue.
  app.get("/backoffice/properties/:propertyId/roles", async (request) => {
    const params = request.params as { propertyId: string };
    return listPropertyRoles(params.propertyId);
  });

  // Tanda 4 (rutas-cors) · create an organisation role from a shared template
  // (roles.manage, riskLevel high: the token-less demo fallback is refused).
  // Until now a hotel could only hand out "Owner": no route created roles, so
  // the invite selector's "crea uno antes de invitar" had nothing to point
  // at (recon rbac-roles). The property → organisation hop goes through the
  // tenant guard (grantPropertyAccess: opaque 404 for a foreign property,
  // platform admins re-pointed to the property's org), so the role always
  // lands in the organisation that owns the property in the URL — never in
  // the caller's org by default. createRoleFromTemplate (lib/rbac-catalog)
  // answers 409 on a duplicate name within the org and 400 on an unknown
  // template, and grants the template's keys in the same transaction.
  app.post("/backoffice/properties/:propertyId/roles", async (request, reply) => {
    const params = request.params as { propertyId: string };
    const body = parse(CreateRoleFromTemplateSchema, request.body);
    const organizationId = await grantPropertyAccess(request, params.propertyId);
    const role = await createRoleFromTemplate({
      organizationId,
      name: body.name,
      templateKey: body.templateKey,
      actorUserId: request.userContext.userId ?? null
    });
    reply.code(201);
    return role;
  });

  // Re-issue a pending invitation: revokes the previous tokens, creates a new
  // one and re-sends the email (or returns the copyable link when email is
  // simulated/failed). The user must hang from THIS property's organization
  // (confused-deputy check through the `user` resolver, opaque 404).
  app.post("/backoffice/properties/:propertyId/users/:userId/reissue-invite", async (request) => {
    const params = request.params as { propertyId: string; userId: string };
    const owner = await assertEntityAccess(request, { entity: "user", id: params.userId, propertyId: params.propertyId });
    return reissueInvitation({
      userId: params.userId,
      organizationId: owner.organizationId,
      actorUserId: request.userContext.userId ?? null
    });
  });

  app.post("/backoffice/properties/:propertyId/users/:userId/disable", async (request) => {
    const params = request.params as { propertyId: string; userId: string };
    return disableBackOfficeUser({
      context: request.userContext,
      propertyId: params.propertyId,
      userId: params.userId,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/roles", async (request) => listRoleCatalog());

  app.get("/backoffice/permissions", async (request) => listPermissionCatalog());

  app.get("/backoffice/properties/:propertyId/integrations", async (request) => {
    const params = request.params as { propertyId: string };
    return listPropertyIntegrations(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/integrations/:providerCode/connect", async (request) => {
    const params = request.params as { propertyId: string; providerCode: string };
    const body = request.body as { credentialsSecretRef?: string; configJson?: Record<string, unknown> };
    return connectIntegration({
      context: request.userContext,
      propertyId: params.propertyId,
      providerCode: params.providerCode,
      credentialsSecretRef: body.credentialsSecretRef,
      configJson: body.configJson,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/compliance-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return getComplianceSettings(params.propertyId);
  });

  app.patch("/backoffice/properties/:propertyId/compliance-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return patchComplianceSettings({
      context: request.userContext,
      propertyId: params.propertyId,
      patch: request.body as Parameters<typeof patchComplianceSettings>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/billing-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return getBillingSettings(params.propertyId);
  });

  app.patch("/backoffice/properties/:propertyId/billing-settings", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { invoiceSequence?: Parameters<typeof patchBillingSettings>[0]["invoiceSequence"] };
    return patchBillingSettings({
      context: request.userContext,
      propertyId: params.propertyId,
      invoiceSequence: body.invoiceSequence,
      correlationId: createId("corr")
    });
  });

  // Tanda 3 (iva-catalogo) · Indirect-tax profile of the property: canonical
  // region (IVA/IGIC/IPSI), statutory or overridden rate per fiscal category
  // with its source and legal basis, tourist-tax treatment and warnings.
  app.get("/backoffice/properties/:propertyId/taxes", async (request) => {
    const params = request.params as { propertyId: string };
    return getPropertyTaxProfile(params.propertyId);
  });

  // Override of one category's rate for the property (idempotent PUT: the
  // service upserts the TaxRate row for (org, region, category, validFrom)).
  // Returns the refreshed profile so the screen re-renders from one source.
  app.put("/backoffice/properties/:propertyId/taxes/rates", async (request) => {
    const params = request.params as { propertyId: string };
    const body = parse(UpsertTaxRateSchema, request.body);
    await upsertPropertyTaxRate({
      propertyId: params.propertyId,
      category: body.category,
      ratePercent: body.ratePercent,
      calificacion: body.calificacion,
      validFrom: body.validFrom,
      actorUserId: request.userContext.userId
    });
    return getPropertyTaxProfile(params.propertyId);
  });

  // (Re)provision the statutory catalogue for the property's region. Idempotent:
  // existing rows are kept (`skipped`), missing ones are created (`provisioned`).
  app.post("/backoffice/properties/:propertyId/taxes/provision", async (request) => {
    const params = request.params as { propertyId: string };
    const result = await ensurePropertyTaxes({ propertyId: params.propertyId });
    return { ...result, profile: await getPropertyTaxProfile(params.propertyId) };
  });

  app.get("/backoffice/properties/:propertyId/accounting-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return getAccountingSettings(params.propertyId);
  });

  app.patch("/backoffice/properties/:propertyId/accounting-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return patchAccountingSettings({
      context: request.userContext,
      propertyId: params.propertyId,
      patch: request.body as Parameters<typeof patchAccountingSettings>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/ai-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return getAiSettings(params.propertyId);
  });

  app.patch("/backoffice/properties/:propertyId/ai-settings", async (request) => {
    const params = request.params as { propertyId: string };
    return patchAiSettings({
      context: request.userContext,
      propertyId: params.propertyId,
      patch: request.body as Parameters<typeof patchAiSettings>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/templates", async (request) => {
    const params = request.params as { propertyId: string };
    return listDocumentTemplates(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/templates", async (request) => {
    const params = request.params as { propertyId: string };
    return createDocumentTemplate({
      context: request.userContext,
      propertyId: params.propertyId,
      template: request.body as Parameters<typeof createDocumentTemplate>[0]["template"],
      correlationId: createId("corr")
    });
  });

  app.patch("/backoffice/properties/:propertyId/templates/:templateId", async (request) => {
    const params = request.params as { propertyId: string; templateId: string };
    return updateDocumentTemplate({
      context: request.userContext,
      propertyId: params.propertyId,
      templateId: params.templateId,
      patch: request.body as Parameters<typeof updateDocumentTemplate>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/audit", async (request) => {
    const params = request.params as { propertyId: string };
    return listBackOfficeAudit(params.propertyId);
  });

  app.get("/modules/catalog", async (request) => listModuleCatalog());

  app.get("/modules/:moduleCode/dependencies", async (request) => {
    const params = request.params as { moduleCode: HotelModuleCode };
    return getModuleDependencies(params.moduleCode);
  });

  app.get("/properties/:propertyId/modules", async (request) => {
    const params = request.params as { propertyId: string };
    return listPropertyModules(params.propertyId);
  });

  app.patch("/properties/:propertyId/modules/:moduleCode/enable", async (request) => {
    const params = request.params as { propertyId: string; moduleCode: HotelModuleCode };
    // Optional body; a non-object one is a 400 in Spanish (L1c), never a TypeError.
    const body = request.body === undefined || request.body === null ? {} : requireObjectBody<{ configurationJson?: Record<string, unknown> }>(request.body);
    return enablePropertyModule({
      context: request.userContext,
      propertyId: params.propertyId,
      moduleCode: params.moduleCode,
      configurationJson: body.configurationJson,
      correlationId: createId("corr")
    });
  });

  app.patch("/properties/:propertyId/modules/:moduleCode/disable", async (request) => {
    const params = request.params as { propertyId: string; moduleCode: HotelModuleCode };
    return disablePropertyModule({
      context: request.userContext,
      propertyId: params.propertyId,
      moduleCode: params.moduleCode,
      correlationId: createId("corr")
    });
  });

  app.get("/integrations/categories", async (request) => listIntegrationCategories());

  app.get("/integrations/providers", async (request) => listIntegrationProviders());

  app.get("/properties/:propertyId/integrations", async (request) => {
    const params = request.params as { propertyId: string };
    return listPropertyIntegrations(params.propertyId);
  });

  app.post("/properties/:propertyId/integrations/:providerCode/connect", async (request) => {
    const params = request.params as { propertyId: string; providerCode: string };
    const body = request.body as { credentialsSecretRef?: string; configJson?: Record<string, unknown> };
    return connectIntegration({
      context: request.userContext,
      propertyId: params.propertyId,
      providerCode: params.providerCode,
      credentialsSecretRef: body.credentialsSecretRef,
      configJson: body.configJson,
      correlationId: createId("corr")
    });
  });

  app.patch("/properties/:propertyId/integrations/:connectionId", async (request) => {
    const params = request.params as { propertyId: string; connectionId: string };
    // Same confused-deputy guard as the sibling routes (connection must hang
    // from the path property); the mirror miss below is a 404, never a 500.
    await assertEntityAccess(request, { entity: "integrationConnection", id: params.connectionId, propertyId: params.propertyId });
    const body = (request.body ?? {}) as { status?: "connected" | "disconnected" | "error" };
    const connection = demoStore.integrationConnections.find(
      (candidate) => candidate.propertyId === params.propertyId && candidate.id === params.connectionId
    );
    if (!connection) {
      throw new NotFoundError("Integración no encontrada.");
    }
    connection.status = body.status ?? connection.status;
    return connection;
  });

  app.delete("/properties/:propertyId/integrations/:connectionId", async (request) => {
    await assertEntityAccess(request, { entity: "integrationConnection", id: (request.params as { connectionId: string }).connectionId, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { propertyId: string; connectionId: string };
    return disconnectIntegration({
      context: request.userContext,
      propertyId: params.propertyId,
      connectionId: params.connectionId,
      correlationId: createId("corr")
    });
  });

  app.post("/properties/:propertyId/integrations/:connectionId/test", async (request) => {
    await assertEntityAccess(request, { entity: "integrationConnection", id: (request.params as { connectionId: string }).connectionId, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { propertyId: string; connectionId: string };
    return testIntegrationConnection({
      context: request.userContext,
      propertyId: params.propertyId,
      connectionId: params.connectionId,
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/integrations/:connectionId/events", async (request) => {
    await assertEntityAccess(request, { entity: "integrationConnection", id: (request.params as { connectionId: string }).connectionId, propertyId: (request.params as { propertyId: string }).propertyId });
    const params = request.params as { connectionId: string };
    return listIntegrationEvents(params.connectionId);
  });

  app.post("/offline/sync", async (request) => {
    return syncOfflineActions({
      context: request.userContext,
      request: request.body as Parameters<typeof syncOfflineActions>[0]["request"],
      finalOfflineCheckInAllowed: false
    });
  });

  app.get("/properties/:propertyId/offline-sync-records", async (request) => {
    const params = request.params as { propertyId: string };
    return listOfflineSyncRecords(params.propertyId);
  });

  app.get("/properties/:propertyId/dashboard", async (request) => {
    const params = request.params as { propertyId: string };
    // KPIs reales por propiedad — leen reservas/folios/pagos de Prisma.
    const { prisma } = await import("@hotelos/database");
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const [arrivalsToday, departuresToday, todayRevenueAgg, unpaidAgg, roomStateGroups] = await Promise.all([
      prisma.reservation.count({
        where: { propertyId: params.propertyId, status: { in: ["confirmed", "checked_in"] }, arrivalDate: { gte: today, lt: tomorrow } }
      }),
      prisma.reservation.count({
        where: { propertyId: params.propertyId, status: { in: ["checked_in", "checked_out"] }, departureDate: { gte: today, lt: tomorrow } }
      }),
      prisma.folioLine.aggregate({
        where: {
          folio: { reservation: { propertyId: params.propertyId } },
          postedAt: { gte: today, lt: tomorrow }
        },
        _sum: { total: true }
      }),
      prisma.folio.findMany({
        where: { reservation: { propertyId: params.propertyId, status: { in: ["checked_in", "confirmed"] } }, status: "open" },
        include: { lines: true, payments: { where: { status: "captured" } } }
      }),
      // Tanda L5: un solo groupBy (status × limpieza) plegado con el helper único:
      // sucias / inspeccionadas por housekeepingStatus (NOT NULL, sin fallback) en
      // todas las ocupaciones; fuera de servicio = out_of_order | out_of_service.
      // Integrador L5 (INT-L5-07): solo habitaciones activas, el mismo conjunto que
      // el Room Rack, /dashboards/housekeeping y operations-director.
      prisma.room.groupBy({
        by: ["status", "housekeepingStatus"],
        where: { propertyId: params.propertyId, active: true },
        _count: { _all: true }
      })
    ]);
    const roomCounts = foldRoomStateCounts(
      roomStateGroups.map((row) => ({ status: String(row.status), housekeepingStatus: row.housekeepingStatus, count: row._count._all }))
    );
    const roomsDirty = roomCounts.dirty;
    const roomsCleanInspected = roomCounts.inspected;
    const roomsOutOfOrder = roomCounts.outOfOrder;
    const unpaidBalances = unpaidAgg.reduce((sum: number, f: { lines: Array<{ total: unknown }>; payments: Array<{ amount: unknown }> }) => {
      const charges = f.lines.reduce((s: number, l) => s + Number(l.total), 0);
      const paid = f.payments.reduce((s: number, p) => s + Number(p.amount), 0);
      return sum + Math.max(0, charges - paid);
    }, 0);
    const todayRevenue = Number(todayRevenueAgg._sum.total ?? 0);
    return {
      arrivalsToday,
      departuresToday,
      roomsDirty,
      roomsCleanInspected,
      roomsOutOfOrder,
      openMaintenanceTasks: await (await import("@hotelos/database")).prisma.workOrder.count({ where: { propertyId: params.propertyId, status: { notIn: ["resolved", "closed"] } } }),
      guestMessages: 0,
      unpaidBalances: Math.round(unpaidBalances * 100) / 100,
      failedComplianceRecords: (await getComplianceInbox(params.propertyId)).length,
      todayRevenue: Math.round(todayRevenue * 100) / 100,
      aiDailyBriefing:
        arrivalsToday > 0
          ? `Hoy llegan ${arrivalsToday} reservas y se marchan ${departuresToday}. Ingresos del día: €${Math.round(todayRevenue)}.`
          : "Día tranquilo: sin llegadas previstas. Buen momento para tareas pendientes de housekeeping."
    };
  });

  app.get("/properties/:propertyId/rooms", async (request, reply) => {
    const params = request.params as { propertyId: string };
    // REC-05/QC-04: cursor pagination (number, id). Default 500: inventory is
    // bounded and the old default of 100 silently dropped 21 of Faranda's 121
    // rooms for every consumer (check-in/out drawers, timeline, room mapper).
    const page = parsePageQuery(request.query as Record<string, unknown>, { limit: 500, max: 500 });
    const result = await listRooms(params.propertyId, { limit: page.limit, cursor: page.cursor });
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });

  app.post("/properties/:propertyId/rooms", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { roomTypeId: string; number: string; floor?: string };
    return createRoom({
      context: request.userContext,
      propertyId: params.propertyId,
      roomTypeId: body.roomTypeId,
      number: body.number,
      floor: body.floor,
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/room-types", async (request) => {
    const params = request.params as { propertyId: string };
    return listRoomTypes(params.propertyId);
  });

  app.get("/properties/:propertyId/reservations", async (request, reply) => {
    const params = request.params as { propertyId: string };
    await assertPropertyInOrg(params.propertyId, request.userContext.organizationId);
    // REC-05/QC-04: server-side filters + cursor pagination. Malformed values
    // → 400 (zod); unknown params are ignored (no client sends any today).
    const page = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const filters = parse(ReservationListQuerySchema, request.query ?? {}, "query");
    const result = await listReservations(params.propertyId, {
      limit: page.limit,
      cursor: page.cursor,
      status: filters.status ? splitCsv(filters.status).filter(isReservationStatus) : undefined,
      from: filters.from,
      to: filters.to,
      arrivalFrom: filters.arrivalFrom,
      arrivalTo: filters.arrivalTo,
      q: filters.q,
      sort: filters.sort ?? "arrival_desc"
    });
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });

  app.post("/properties/:propertyId/availability/quote", async (request) => {
    const params = request.params as { propertyId: string };
    // A missing/malformed body used to reach the service and 500 on
    // `undefined >= undefined`; the schema makes it a 400.
    const body = parse(QuoteAvailabilitySchema, request.body ?? {});
    return quoteAvailability({
      propertyId: params.propertyId,
      arrivalDate: body.arrivalDate,
      departureDate: body.departureDate,
      // The schema defaults adults=1 / children=0 at runtime; `parse<T>` is
      // typed on the schema INPUT (fields optional), hence the fallbacks.
      adults: body.adults ?? 1,
      children: body.children ?? 0,
      roomTypeId: body.roomTypeId,
      ratePlanId: body.ratePlanId
    });
  });

  app.post("/properties/:propertyId/reservations", async (request) => {
    const params = request.params as { propertyId: string };
    // Validate the critical fields via the centralised schema. Legacy free-form
    // fields are allowed through `.passthrough()` until the service layer is
    // fully typed.
    parse(CreateReservationSchema, request.body);
    const body = request.body as {
      channel?: string;
      arrivalDate: string;
      departureDate: string;
      adults?: number;
      children?: number;
      infants?: number;
      childrenAges?: number[];
      roomsCount?: number;
      eta?: string;
      etd?: string;
      roomTypeId: string;
      assignedRoomId?: string;
      ratePlanId?: string;
      boardType?: string;
      marketSegment?: string;
      sourceCode?: string;
      purposeOfStay?: string;
      guaranteeType?: string;
      depositAmount?: number;
      cancellationPolicyCode?: string;
      billingInstruction?: string;
      companyName?: string;
      travelAgentName?: string;
      groupCode?: string;
      externalReference?: string;
      bookerName?: string;
      bookerEmail?: string;
      specialRequests?: string;
      notes?: string;
      totalAmount?: number;
      currency?: string;
      primaryGuest?: GuestIdentityFields;
      discountReasonCode?: string;
      supervisorAuthorizationId?: string | null;
      allowPastArrival?: boolean;
    };

    return createReservation({
      context: request.userContext,
      propertyId: params.propertyId,
      channel: body.channel,
      arrivalDate: body.arrivalDate,
      // UX-1 (corrector L-02): una llegada pasada solo se admite confirmada Y con permiso de modificar reservas.
      allowPastArrival: body.allowPastArrival === true && request.userContext.permissions.includes("pms.reservation.modify"),
      departureDate: body.departureDate,
      adults: body.adults,
      children: body.children,
      infants: body.infants,
      childrenAges: body.childrenAges,
      roomsCount: body.roomsCount,
      eta: body.eta,
      etd: body.etd,
      roomTypeId: body.roomTypeId,
      assignedRoomId: body.assignedRoomId,
      ratePlanId: body.ratePlanId,
      boardType: body.boardType,
      marketSegment: body.marketSegment,
      sourceCode: body.sourceCode,
      purposeOfStay: body.purposeOfStay,
      guaranteeType: body.guaranteeType,
      depositAmount: body.depositAmount,
      cancellationPolicyCode: body.cancellationPolicyCode,
      billingInstruction: body.billingInstruction,
      companyName: body.companyName,
      travelAgentName: body.travelAgentName,
      groupCode: body.groupCode,
      externalReference: body.externalReference,
      bookerName: body.bookerName,
      bookerEmail: body.bookerEmail,
      specialRequests: body.specialRequests,
      notes: body.notes,
      totalAmount: body.totalAmount,
      currency: body.currency,
      primaryGuest: body.primaryGuest,
      // Tanda 8a (corrector · FSOD-06): the discount reason code and the supervisor PIN reach the service.
      discountReasonCode: body.discountReasonCode,
      supervisorAuthorizationId: body.supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
  });

  app.get("/reservations/:id", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    const reservation = await getReservation(params.id);
    // Enriquecemos con el huésped principal — sin pasar por el endpoint público
    // /guests/:id que aplica scope por organizationId del context (la cadena
    // demo usa varias orgs). Aquí basta el join nativo: si puedes ver la
    // reserva, puedes ver su huésped principal en modo lectura.
    const { prisma: db } = await import("@hotelos/database");
    const primaryGuestId = (reservation as { primaryGuestId?: string }).primaryGuestId;
    let primaryGuest: unknown = null;
    if (primaryGuestId) {
      primaryGuest = await db.guest.findUnique({
        where: { id: primaryGuestId },
        select: {
          id: true,
          firstName: true,
          surname1: true,
          surname2: true,
          documentType: true,
          documentNumber: true,
          email: true,
          phone: true,
          nationality: true,
          vipCode: true,
          loyaltyProgram: true,
          loyaltyTier: true,
          loyaltyNumber: true
        }
      });
    }
    return { ...reservation, primaryGuest };
  });

  app.patch("/reservations/:id", async (request) => {
    const params = request.params as { id: string };
    // Guard first: the service's assertPropertyInOrg answered 'Propiedad no
    // encontrada.' for a foreign reservation vs 'Reserva no encontrada.' for a
    // missing one (existence oracle) and had no platform-admin escape.
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    // REC-01: the service receives the VALIDATED allowlist (the raw body used
    // to pass through untouched, so unknown keys like `status` reached Prisma).
    const parsed = parse(UpdateReservationBodySchema, request.body);
    // Tanda 8a (corrector · FSOD-06): the two non-column fields travel beside the patch, never inside it.
    const { discountReasonCode, supervisorAuthorizationId, ...patch } = parsed;
    return patchReservation({
      context: request.userContext,
      reservationId: params.id,
      patch,
      discountReasonCode,
      supervisorAuthorizationId: supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
  });

  // Audit log for a reservation. Returns the hash-chained AuditEvent rows
  // tied to this reservation (entityType = "reservation"), newest first, so the
  // UI can render a "what changed and by whom" timeline.
  //
  // Endpoint renamed from `/reservations/:id/activity` → `/audit-events` to
  // avoid colliding with the guest-journey "/activity" handler registered
  // further down. The two endpoints serve different feeds (system changelog
  // vs. guest journey) and the frontend currently consumes the guest one.
  app.get("/reservations/:id/audit-events", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const { prisma: db } = await import("@hotelos/database");
    const events = await db.auditEvent.findMany({
      where: { organizationId: request.userContext.organizationId, entityType: "reservation", entityId: params.id },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    return { events };
  });

  // Document reservations placeholder. Real implementation will pull from
  // the documents service (signed registration cards, ID scans, invoices,
  // contracts). For now we return an empty list with a stable shape so the
  // front-end can wire its loading / empty states.
  app.get("/reservations/:id/documents", async (request) => {
    // Still a stub, but scoped like every other reservation leg (unknown or
    // foreign id → 404, not an empty 200).
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    return { documents: [] as unknown[] };
  });

  app.post("/reservations/:id/assign-room", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "reservation", id: params.id });
    const body = parse(AssignRoomSchema, request.body);
    if (body.roomId) {
      return assignRoom({
        context: request.userContext,
        reservationId: params.id,
        roomId: body.roomId,
        correlationId: createId("corr")
      });
    }

    if (body.roomNumber) {
      return assignRoomByNumber({
        context: request.userContext,
        reservationId: params.id,
        roomNumber: body.roomNumber,
        correlationId: createId("corr")
      });
    }

    throw new BadRequestError("roomId or roomNumber is required.");
  });

  app.post("/reservations/:id/check-in", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = parse(CheckInSchema, request.body);
    // Tanda 4: every in-house reservation must have a primary folio. POST
    // /properties/:id/reservations opens one inside createReservation's
    // transaction, but rooming-list imports (group bookings) and older creation
    // paths do not, and the check-out route then had nothing to close and
    // answered 404 AFTER the check-out had committed. Open it BEFORE the
    // check-in transaction so a folio-less reservation can never reach the
    // checked_in state: if this fails, nothing has been mutated yet and the
    // error is an honest pre-check-in failure. A folio left on a reservation
    // whose check-in is then refused (wrong state, room mismatch) is harmless:
    // it is the same folio createReservation would have opened at birth.
    // Permission: covered by pms.checkin.execute (route manifest + service);
    // see ensurePrimaryFolio for why no billing permission is added here.
    const primaryFolio = await ensurePrimaryFolio({
      context: request.userContext,
      reservationId: params.id,
      correlationId: createId("corr")
    });
    const reservation = await checkInReservation({
      context: request.userContext,
      reservationId: params.id,
      roomId: body.roomId,
      allowEarlyCheckIn: body.allowEarlyCheckIn,
      overrideReason: body.overrideReason,
      signatureObjectKey: body.signatureObjectKey ?? "sig_manual_checkin",
      correlationId: createId("corr")
    });
    // Punto 1 (informe SES): al hacer check-in, crear el parte de viajeros de
    // cada huésped con sus datos, para que el envío SES tenga registros reales
    // que encolar. Best-effort: si falla, el check-in se completa igualmente y se
    // reporta el motivo (no se rompe la operación de recepción ni se finge éxito).
    let guestRegister: { created: number; existing: number; error?: string };
    try {
      const outcome = await ensureReservationGuestRegisterRecords({
        context: request.userContext,
        reservationId: params.id,
        correlationId: createId("corr")
      });
      guestRegister = { created: outcome.created.length, existing: outcome.existing };
    } catch (error) {
      guestRegister = {
        created: 0,
        existing: 0,
        error: error instanceof Error ? error.message : "No se pudo crear el parte de viajeros (SES)."
      };
    }
    return { ...reservation, guestRegister, folio: { id: primaryFolio.folio.id, created: primaryFolio.created } };
  });

  app.post("/reservations/:id/check-out", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = parse(CheckOutSchema, request.body ?? {});
    const acknowledgeBalance = (body as { acknowledgeBalance?: boolean }).acknowledgeBalance === true;
    // REC-08 (permissions): the balance pre-check below discloses the folio
    // balance in the 409 body, so the same permission checkOutReservation
    // enforces must be satisfied BEFORE any folio read — otherwise a user
    // without pms.checkout.execute could probe balances through this route.
    requirePermissions(request.userContext, ["pms.checkout.execute"]);
    // REC-08: read the folio BEFORE mutating anything. A guest leaving with an
    // unpaid balance is a money-path decision, not a side effect: 409 with a
    // machine-readable code unless the caller explicitly acknowledged it
    // (the front-desk drawer asks for confirmation and retries, or collects).
    // The balance is the sum over EVERY folio of the reservation (secondary
    // folios included), and the 409 lists them so the drawer can point at the
    // one that still owes.
    // State first: a reservation that is not in house cannot be checked out,
    // and saying "balance due" about it would mislead the drawer.
    const current = await getReservation(params.id);
    if (current.status !== "checked_in") {
      throw new ConflictError(
        `La reserva ${current.code} no está alojada (estado ${current.status}); solo se puede hacer check-out de una reserva con check-in hecho.`
      );
    }
    const balanceBefore = await getReservationBalance(params.id);
    if (balanceBefore.balanceDue > 0 && !acknowledgeBalance) {
      throw Object.assign(
        new ConflictError(
          `Saldo pendiente de ${balanceBefore.balanceDue.toFixed(2)} €: cobra antes del check-out o confírmalo con saldo pendiente.`
        ),
        { details: { code: "BALANCE_DUE", balanceDue: balanceBefore.balanceDue, folios: balanceBefore.folios } }
      );
    }
    // Tanda 4: read the primary folio BEFORE mutating anything, tolerating a
    // reservation without one (rooming-list imports and legacy rows; check-in
    // now opens the folio, but reservations checked in before that fix are
    // still in house). Reading it after the transaction turned a committed
    // check-out into a 404 "Folio was not found." and the retry into a 409
    // "no está alojada" — the guest was out, the drawer said failure.
    // checkOutReservationDetailed never posts to or closes the primary folio,
    // so this pre-read balance is the one the close below must honour.
    const primaryBefore = await findReservationFolio(params.id);
    // Detailed outcome: the aggregated balance, the per-folio decisions and
    // the non-blocking warnings (e.g. a secondary folio left open with a
    // balance the caller acknowledged) reach the front-desk drawer verbatim.
    const outcome = await checkOutReservationDetailed({
      context: request.userContext,
      reservationId: params.id,
      acknowledgeBalance,
      correlationId: createId("corr")
    });
    const reservation = outcome.reservation;
    const warnings: string[] = [
      ...(outcome.balanceDue > 0 ? ["balance_due"] : []),
      ...outcome.warnings
    ];

    // From here on the check-out is COMMITTED (reservation checked_out, stay
    // closed, room dirty). Nothing below may turn it into a 4xx/5xx: the
    // departure cleaning task and the folio close are best-effort follow-ups
    // that are logged with the reservation + correlation id and surfaced as
    // machine-readable warnings so the drawer can say what still needs a hand.
    let departureTask: Awaited<ReturnType<typeof createDepartureCleaningTask>> | undefined;
    if (reservation.assignedRoomId) {
      const correlationId = createId("corr");
      try {
        departureTask = await createDepartureCleaningTask({
          context: request.userContext,
          propertyId: reservation.propertyId,
          roomId: reservation.assignedRoomId,
          correlationId
        });
      } catch (error) {
        request.log.error(
          { err: error, reservationId: params.id, roomId: reservation.assignedRoomId, correlationId },
          "check-out committed but the departure cleaning task could not be created"
        );
        warnings.push("departure_task_failed");
      }
    }

    // Close the primary folio only when it exists and is settled (same
    // sub-cent tolerance closeFolio applies). A folio-less reservation
    // answers folio: null; an unsettled one stays open so the acknowledged
    // debt remains collectable.
    let folio = primaryBefore?.folio ?? null;
    if (primaryBefore && Math.abs(primaryBefore.balanceDue) < 0.005) {
      const correlationId = createId("corr");
      try {
        folio = await closeFolio({
          context: request.userContext,
          folioId: primaryBefore.folio.id,
          correlationId
        });
      } catch (error) {
        request.log.error(
          { err: error, reservationId: params.id, folioId: primaryBefore.folio.id, correlationId },
          "check-out committed but the primary folio could not be closed"
        );
        warnings.push("folio_close_failed");
      }
    }

    return {
      reservation,
      folio,
      departureTask,
      balanceDue: outcome.balanceDue,
      balanceAcknowledged: outcome.balanceAcknowledged,
      // The primary folio is closed by this route AFTER the service built
      // folios[], so reflect its final status instead of the pre-close one.
      folios: outcome.folios.map((f) => (folio && f.id === folio.id ? { ...f, status: folio.status } : f)),
      warnings
    };
  });

  app.post("/reservations/:id/cancel", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = parse(CancelReservationSchema, request.body ?? {});
    // Tanda L3 (lote B): policy applied by default (penalty line + folio closed at 0);
    // `applyPolicy: false` waives it (pms.reservation.discount + reason). Response = record + `cancellation`.
    return cancelReservationWithPolicy({
      context: request.userContext,
      reservationId: params.id,
      reason: body.reason,
      applyPolicy: body.applyPolicy ?? true,
      supervisorAuthorizationId: body.supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
  });

  app.post("/reservations/:id/no-show", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = parse(NoShowReservationSchema, request.body ?? {});
    return markNoShowWithPolicy({
      context: request.userContext,
      reservationId: params.id,
      reason: body.reason,
      applyPolicy: body.applyPolicy ?? true,
      supervisorAuthorizationId: body.supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
  });

  app.get("/reservations/:id/folio", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return getReservationFolio(params.id);
  });

  // Guest journey activity feed — chat + housekeeping + maintenance + requests.
  app.get("/reservations/:id/activity", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return getGuestActivity({ context: request.userContext, reservationId: params.id });
  });

  // ===== AI Booking Agent (natural language → reservation draft) =====
  app.post("/properties/:propertyId/reservations/ai-parse", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { text?: string };
    return parseReservationRequest({
      context: request.userContext,
      propertyId: params.propertyId,
      text: body.text ?? ""
    });
  });

  // ===== Property Mapper (AI document → property structure) =====
  app.post("/properties/:propertyId/mapper/extract", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { files?: MapperFile[] };
    return extractPropertyMap({
      context: request.userContext,
      propertyId: params.propertyId,
      files: body.files ?? []
    });
  });

  app.post("/properties/:propertyId/mapper/apply", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { proposal: PropertyMapProposal };
    return applyPropertyMap({
      context: request.userContext,
      propertyId: params.propertyId,
      proposal: body.proposal,
      correlationId: createId("corr")
    });
  });

  // ===== Guest profiles (organization-scoped) =====
  app.get("/guests", async (request, reply) => {
    // REC-07: validated (a repeated `search` param is an array → 400, not a
    // TypeError on `.trim()`).
    const query = parse(GuestListQuerySchema, request.query ?? {}, "query");
    // REC-05/QC-04: cursor pagination (createdAt, id); with `search` the
    // service merges three lookups and returns nextCursor null (documented).
    const page = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 200 });
    const result = await listGuests(request.userContext.organizationId, { search: query.search, limit: page.limit, cursor: page.cursor });
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });

  app.get("/guests/:id", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "guest", id: params.id });
    return getGuest({ context: request.userContext, id: params.id });
  });

  app.get("/guests/:id/timeline", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "guest", id: params.id });
    const { buildGuestTimeline } = await import("./modules/guests/guest-timeline.service.js");
    return buildGuestTimeline({ guestId: params.id });
  });

  app.post("/guests", async (request) => {
    // Accept either { guest: {...} } or the bare guest fields at the top level.
    // Validate the critical PII fields no matter which shape arrived.
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const candidate = (raw.guest as Record<string, unknown> | undefined) ?? raw;
    parse(CreateGuestSchema, candidate);
    const body = request.body as { guest: GuestIdentityFields };
    return createGuest({
      context: request.userContext,
      guest: body.guest ?? (body as unknown as GuestIdentityFields),
      correlationId: createId("corr")
    });
  });

  app.patch("/guests/:id", async (request) => {
    const params = request.params as { id: string };
    // loadGuestRow in the service is strict (no platform-admin escape).
    await assertEntityAccess(request, { entity: "guest", id: params.id });
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const candidate = (raw.guest as Record<string, unknown> | undefined) ?? raw;
    parse(UpdateGuestSchema, candidate);
    const body = request.body as { guest: GuestIdentityFields };
    return updateGuest({
      context: request.userContext,
      id: params.id,
      guest: body.guest ?? (body as unknown as GuestIdentityFields),
      correlationId: createId("corr")
    });
  });

  app.get("/folios/:id/balance", async (request) => {
    const folioId = (request.params as { id: string }).id;
    await assertEntityAccess(request, { entity: "folio", id: folioId });
    return getFolioBalance(folioId);
  });
  app.post("/folios/:id/lines", async (request) => {
    const params = request.params as { id: string };
    const body = parse(CreateFolioLineSchema, request.body);
    await assertBillingAccess(request, "folio", params.id);
    return postFolioLine({
      context: request.userContext,
      folioId: params.id,
      type: body.type as Parameters<typeof postFolioLine>[0]["type"],
      description: body.description,
      quantity: body.quantity,
      unitPrice: body.unitPrice,
      taxCode: body.taxCode,
      // Tanda 3 (cierre · H2): the fiscal-category override was validated by the
      // schema and then dropped here, so every line fell back to the type map.
      taxCategory: body.taxCategory,
      correlationId: createId("corr")
    });
  });

  // Finanzas (2026-09-15): idempotent by clientRequestId (same request → same
  // payment, 200; different body with the same key → 409 IDEMPOTENCY_CONFLICT),
  // transactional, PaymentMethod enum, journal entry in the same transaction.
  // card_online / payment_link never capture here: 202 with a PaymentIntent +
  // hosted-page redirect when a PSP is configured, 409 PSP_NOT_CONFIGURED otherwise.
  app.post("/folios/:id/payments", async (request, reply) => {
    const params = request.params as { id: string };
    const body = parse(ApplyPaymentSchema, request.body);
    await assertBillingAccess(request, "folio", params.id);
    const result = await postFolioPayment({
      context: request.userContext,
      folioId: params.id,
      amount: body.amount,
      currency: body.currency,
      method: body.method,
      reference: body.reference ?? body.pspReference ?? null,
      clientRequestId: body.clientRequestId ?? null,
      invoiceId: body.invoiceId ?? null,
      returnUrl: body.returnUrl ?? null,
      correlationId: createId("corr")
    });
    if (result.kind === "payment_intent" && !result.idempotent) reply.code(202);
    else reply.code(result.idempotent ? 200 : 201);
    return result;
  });

  // Finanzas (2026-09-15): idempotent by clientRequestId; reversal Payment row
  // + PaymentRefund ledger + inverse entry; online money goes back through
  // the PSP (or as a manual transfer when refundMethod says so).
  app.post("/payments/:id/refund", async (request) => {
    const params = request.params as { id: string };
    const body = parse(RefundPaymentSchema, request.body ?? {});
    await assertBillingAccess(request, "payment", params.id);
    return refundFolioPayment({
      context: request.userContext,
      paymentId: params.id,
      reason: body.reason ?? "Devolución manual",
      amount: body.amount,
      clientRequestId: body.clientRequestId ?? null,
      refundMethod: body.refundMethod ?? null,
      supervisorAuthorizationId: body.supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
  });

  app.post("/folios/:id/close", async (request) => {
    const params = request.params as { id: string };
    await assertBillingAccess(request, "folio", params.id);
    // Corrector L3 (FC-2): a settled folio with charges no invoice documents
    // answers 409 FOLIO_UNINVOICED_LINES (issue the F1/F2 first).
    return closeFolio({
      context: request.userContext,
      folioId: params.id,
      correlationId: createId("corr"),
      requireInvoiced: true
    });
  });

  app.get("/properties/:propertyId/invoices", async (request, reply) => {
    const params = request.params as { propertyId: string };
    // QC-03/QC-04: cursor pagination (createdAt, id); every item carries
    // paidTotal/balanceDue/paymentStatus and the envelope adds `summary`.
    const page = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    // REC-07: validated (repeated params → 400; from/to as YYYY-MM-DD with
    // from <= to) instead of `.trim()` on an array → 500.
    const q = parse(InvoiceListQuerySchema, request.query ?? {}, "query");
    const result = await listInvoices(params.propertyId, { status: q.status, from: q.from, to: q.to, q: q.q, limit: page.limit, cursor: page.cursor });
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });

  app.get("/properties/:propertyId/invoice-branding", async (request) => {
    const params = request.params as { propertyId: string };
    return getInvoiceBranding(params.propertyId);
  });

  app.patch("/properties/:propertyId/invoice-branding", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as { logoUrl?: string | null; legalFooter?: string | null };
    return updateInvoiceBranding({
      context: request.userContext,
      propertyId: params.propertyId,
      logoUrl: body.logoUrl,
      legalFooter: body.legalFooter,
      correlationId: createId("corr")
    });
  });

  app.get("/invoices/:id", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "invoice", id: params.id });
    return getInvoice(params.id);
  });

  app.post("/folios/:id/invoice", async (request) => {
    const params = request.params as { id: string };
    const body = parse(IssueInvoiceSchema, request.body ?? {});
    await assertBillingAccess(request, "folio", params.id);
    return createInvoiceFromFolio({
      context: request.userContext,
      folioId: params.id,
      customerType: body.customerType,
      customerTaxId: body.customerTaxId,
      customerName: body.customerName,
      invoiceType: body.invoiceType,
      // The schema accepts both spellings; forwarding only one let `currency`
      // silently fall back to EUR and skip the FX validation.
      currencyCode: body.currencyCode ?? (body as { currency?: string }).currency,
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/drafts", async (request) => {
    const body = parse(CreateInvoiceDraftSchema, request.body ?? {});
    return createInvoiceDraft({
      ...body,
      context: request.userContext,
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/:id/issue", async (request) => {
    const params = request.params as { id: string };
    await assertBillingAccess(request, "invoice", params.id);
    const issueBody = parse(IssueInvoiceBodySchema, request.body ?? {});
    return issueInvoice({
      context: request.userContext,
      customerName: issueBody.customerName,
      invoiceId: params.id,
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/:id/cancel", async (request) => {
    const params = request.params as { id: string };
    await assertBillingAccess(request, "invoice", params.id);
    const body = parse(CancelInvoiceSchema, request.body ?? {});
    // Finanzas (2026-09-15): the linked payments are unlinked (they stay on the
    // folio, visible in its balance) and refunded when refundPayments is true.
    return cancelInvoice({
      context: request.userContext,
      invoiceId: params.id,
      reason: body.reason ?? "Anulación manual",
      refundPayments: body.refundPayments ?? false,
      supervisorAuthorizationId: body.supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/:id/rectify", async (request) => {
    const params = request.params as { id: string };
    await assertBillingAccess(request, "invoice", params.id);
    const body = parse(RectifyInvoiceSchema, request.body ?? {});
    return createRectifyingInvoice({
      context: request.userContext,
      originalInvoiceId: params.id,
      reasonCode: body.reasonCode as RectifyingReasonCode,
      lineAdjustments: body.lineAdjustments as unknown as RectifyingLineAdjustment[] | undefined,
      fullReversal: body.fullReversal,
      rectificationType: body.rectificationType,
      substituteLines: body.substituteLines,
      correlationId: createId("corr")
    });
  });

  app.get("/invoices/:id/rectifications", async (request) => {
    await assertEntityAccess(request, { entity: "invoice", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return listRectifyingInvoices(params.id);
  });

  // --- Folio/Billing advanced (Sprint 40 — folio split, charge moves,
  //     invoice mark-paid, send-by-email). Idempotent endpoints suitable for
  //     AI-agent retries; payloads are validated inline rather than via Zod
  //     to keep the surface area minimal until the schemas land.
  app.post("/folios/:id/split", async (request) => {
    const params = request.params as { id: string };
    await assertBillingAccess(request, "folio", params.id);
    const body = (request.body ?? {}) as {
      newFolio?: { label?: string; guestId?: string | null; currency?: string };
      moveChargeIds?: string[];
      keepInOriginal?: boolean;
    };
    return splitFolio({
      context: request.userContext,
      sourceFolioId: params.id,
      newFolio: {
        label: body.newFolio?.label ?? "",
        guestId: body.newFolio?.guestId ?? null,
        currency: body.newFolio?.currency
      },
      moveChargeIds: Array.isArray(body.moveChargeIds) ? body.moveChargeIds : [],
      keepInOriginal: body.keepInOriginal,
      correlationId: createId("corr")
    });
  });

  app.post("/folios/:sourceId/move-charges", async (request) => {
    const params = request.params as { sourceId: string };
    const body = (request.body ?? {}) as { targetFolioId?: string; chargeIds?: string[] };
    if (!body.targetFolioId || typeof body.targetFolioId !== "string") {
      throw new BadRequestError("targetFolioId es obligatorio.");
    }
    await assertBillingAccess(request, "folio", params.sourceId);
    await assertBillingAccess(request, "folio", body.targetFolioId);
    return moveChargesBetweenFolios({
      context: request.userContext,
      sourceFolioId: params.sourceId,
      targetFolioId: body.targetFolioId,
      chargeIds: Array.isArray(body.chargeIds) ? body.chargeIds : [],
      correlationId: createId("corr")
    });
  });

  // Finanzas (2026-09-15): «Marcar pagada» only with method (enum) + reference;
  // idempotent by (invoice, reference); journal entry in the same transaction.
  app.post("/invoices/:id/mark-paid", async (request) => {
    const params = request.params as { id: string };
    await assertBillingAccess(request, "invoice", params.id);
    const body = parse(MarkInvoicePaidSchema, request.body ?? {});
    return markInvoicePaid({
      context: request.userContext,
      invoiceId: params.id,
      method: body.method,
      reference: body.reference ?? body.pspReference ?? "",
      amount: body.amount,
      correlationId: createId("corr")
    });
  });

  // Finanzas (2026-09-15): real email with the PDF attached through the
  // configured provider; {simulated:true} and an audit «SIMULADO» when none.
  app.post("/invoices/:id/send-email", async (request) => {
    const params = request.params as { id: string };
    await assertBillingAccess(request, "invoice", params.id);
    const body = parse(SendInvoiceEmailSchema, request.body ?? {});
    return sendInvoiceByEmail({
      context: request.userContext,
      invoiceId: params.id,
      recipient: body.recipient,
      subject: body.subject,
      message: body.message,
      correlationId: createId("corr")
    });
  });

  app.get("/reports/properties/:propertyId/catalog", async (request) => {
    const params = request.params as { propertyId: string };
    return getReportCatalog(params.propertyId);
  });

  app.get("/reports/properties/:propertyId/reservations", async (request) => {
    const params = request.params as { propertyId: string };
    return getReservationReport(params.propertyId, request.query as never);
  });

  app.get("/reports/properties/:propertyId/billing", async (request) => {
    const params = request.params as { propertyId: string };
    return getBillingReport(params.propertyId, request.query as never);
  });

  app.post("/reports/properties/:propertyId/export", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as {
      reportType?: "reservation" | "billing" | "revenue" | "owner";
      format?: "pdf" | "csv" | "xlsx" | "json";
      query?: Record<string, unknown>;
    };
    return exportOperationalReport({
      context: request.userContext,
      propertyId: params.propertyId,
      reportType: body.reportType ?? "reservation",
      format: body.format ?? "pdf",
      query: body.query,
      correlationId: createId("corr")
    });
  });

  // FIX-1 · F5: authenticated download of a finished export (in-memory store,
  // 15 min TTL) — the front links here instead of an absent object-storage URL.
  app.get("/reports/exports/:exportId/download", async (request, reply) => {
    const params = request.params as { exportId: string };
    const file = getReportExportFile({ context: request.userContext, exportId: params.exportId });
    return reply
      .header("content-type", file.contentType)
      .header("content-disposition", `attachment; filename="${file.filename}"`)
      .send(file.content);
  });

  app.get("/organizations/:organizationId/accounts", async (request) => {
    await assertEntityAccess(request, { entity: "organization", id: (request.params as { organizationId: string }).organizationId });
    // Finanzas (2026-09-16): the organisation's own chart (PGC Pymes hotelero,
    // provisioned by chart-of-accounts.service). No rows → 409
    // CHART_NOT_PROVISIONED instead of the old static 7-account fallback: the
    // picker must never offer accounts that do not exist in the ledger. The
    // hierarchy fields let the front hide headers (isPostable=false).
    const { organizationId } = request.params as { organizationId: string };
    const { prisma } = await import("@hotelos/database");
    const rows = await prisma.account.findMany({
      where: { organizationId },
      select: { id: true, code: true, name: true, accountType: true, kind: true, group: true, level: true, isPostable: true, parentId: true, usaliDepartment: true, usaliLine: true },
      orderBy: { code: "asc" }
    });
    if (rows.length === 0) {
      throw new ConflictError("La organización no tiene plan contable provisionado: ejecuta accounting:provision-chart (plantilla «PGC Pymes hotelero»).", {
        code: "CHART_NOT_PROVISIONED",
        organizationId
      });
    }
    return rows;
  });

  app.get("/organizations/:organizationId/journal-entries", async (request) => {
    await assertEntityAccess(request, { entity: "organization", id: (request.params as { organizationId: string }).organizationId });
    const params = request.params as { organizationId: string };
    return listJournalEntries(params.organizationId);
  });

  app.post("/journal-entries/drafts", async (request) => {
    const body = request.body as Omit<Parameters<typeof createJournalEntryDraft>[0], "organizationId"> & {
      organizationId?: string;
    };
    return createJournalEntryDraft({
      organizationId: await resolveOrganizationScope(request, body.organizationId),
      propertyId: body.propertyId ?? request.userContext.propertyId,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      lines: body.lines
    });
  });

  app.post("/journal-entries/:id/post", async (request) => {
    await assertEntityAccess(request, { entity: "journalEntry", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return postJournalEntry({
      context: request.userContext,
      journalEntryId: params.id,
      correlationId: createId("corr")
    });
  });

  // Tanda T9 (documentos · lote T9-15, dosier §3.4): las dos rutas heredadas de facturas de
  // proveedor de este bloque (lista por propiedad y alta de borrador sin líneas) se retiraron
  // del API y del manifiesto; responden 404. Canónicas: GET|POST /properties/:propertyId/payables/
  // supplier-bills (modules/payables/payables.routes.ts, payables.read / payables.create) y la
  // factura digitalizada nace de POST /properties/:propertyId/documents/:id/approve
  // (modules/documents/workflow.routes.ts, action create_supplier_bill).

  // ---- Bank reconciliation (Sprint 21 · Track 1) ----
  app.get("/banking/accounts", async (request) => {
    const query = request.query as { propertyId?: string };
    const propertyId = query.propertyId ?? request.userContext.propertyId;
    return listBankAccounts(propertyId);
  });

  app.post("/banking/accounts", async (request) => {
    const body = request.body as {
      propertyId?: string;
      organizationId?: string;
      name: string;
      bankName?: string;
      iban?: string;
      bic?: string;
      currencyCode?: string;
      ledgerAccountCode?: string;
      openingBalance?: number;
    };
    return createBankAccount({ context: request.userContext, ...body });
  });

  app.get("/banking/accounts/:id/balance", async (request) => {
    await assertEntityAccess(request, { entity: "bankAccount", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const query = request.query as { asOf?: string };
    return getBankAccountBalance(params.id, query.asOf);
  });

  app.get("/banking/accounts/:id/statements", async (request) => {
    await assertEntityAccess(request, { entity: "bankAccount", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return listStatements(params.id);
  });

  app.post("/banking/accounts/:id/statements/import-csv", async (request) => {
    await assertEntityAccess(request, { entity: "bankAccount", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as { csv: string; source?: string };
    if (!body?.csv) throw new BadRequestError("`csv` is required.");
    return importStatementFromCsv({
      bankAccountId: params.id,
      csv: body.csv,
      source: body.source ?? "csv"
    });
  });

  app.get("/banking/statements/:id", async (request) => {
    await assertEntityAccess(request, { entity: "bankStatement", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return getStatement(params.id);
  });

  app.post("/banking/statements/:id/auto-match", async (request) => {
    await assertEntityAccess(request, { entity: "bankStatement", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return autoMatchStatement(params.id);
  });

  app.post("/banking/lines/:bankLineId/match", async (request) => {
    await assertEntityAccess(request, { entity: "bankStatementLine", id: (request.params as { bankLineId: string }).bankLineId });
    const params = request.params as { bankLineId: string };
    const body = request.body as {
      matchType: "payment" | "supplier_bill" | "manual";
      matchedEntityId: string;
      notes?: string;
    };
    if (!body?.matchType || !body?.matchedEntityId) {
      throw new BadRequestError("`matchType` and `matchedEntityId` are required.");
    }
    return manualMatch({
      bankLineId: params.bankLineId,
      matchType: body.matchType,
      matchedEntityId: body.matchedEntityId,
      userId: request.userContext.userId,
      notes: body.notes
    });
  });

  app.delete("/banking/lines/:bankLineId/match", async (request) => {
    await assertEntityAccess(request, { entity: "bankStatementLine", id: (request.params as { bankLineId: string }).bankLineId });
    const params = request.params as { bankLineId: string };
    return unmatch(params.bankLineId);
  });

  app.get("/banking/accounts/:id/reconciliation-status", async (request) => {
    await assertEntityAccess(request, { entity: "bankAccount", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return reconciliationStatus(params.id);
  });

  app.get("/properties/:propertyId/housekeeping/board", async (request) => {
    const params = request.params as { propertyId: string };
    return getHousekeepingBoard(params.propertyId);
  });

  app.post("/housekeeping/tasks", async (request) => {
    const body = request.body as {
      propertyId?: string;
      roomId: string;
      taskType: Parameters<typeof createHousekeepingTask>[0]["taskType"];
      priority?: Parameters<typeof createHousekeepingTask>[0]["priority"];
      assignedTo?: string;
      dueAt?: string;
    };

    return createHousekeepingTask({
      context: request.userContext,
      propertyId: body.propertyId ?? request.userContext.propertyId,
      roomId: body.roomId,
      taskType: body.taskType,
      priority: body.priority,
      assignedTo: body.assignedTo,
      dueAt: body.dueAt,
      correlationId: createId("corr")
    });
  });

  app.patch("/housekeeping/tasks/:id", async (request) => {
    const params = request.params as { id: string };
    const body = requireObjectBody<{
      status?: Parameters<typeof updateHousekeepingTask>[0]["patch"]["status"];
      priority?: Parameters<typeof updateHousekeepingTask>[0]["patch"]["priority"];
      assignedTo?: string;
      dueAt?: string;
      note?: string;
    }>(request.body);

    return updateHousekeepingTask({
      context: request.userContext,
      taskId: params.id,
      patch: {
        status: body.status,
        priority: body.priority,
        assignedTo: body.assignedTo,
        dueAt: body.dueAt
      },
      note: body.note,
      correlationId: createId("corr")
    });
  });

  app.post("/housekeeping/tasks/:id/photo", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { objectKey: string; note?: string };
    return addHousekeepingPhoto({
      context: request.userContext,
      taskId: params.id,
      objectKey: body.objectKey,
      note: body.note,
      correlationId: createId("corr")
    });
  });

  app.post("/rooms/:id/mark-clean", async (request) => {
    const params = request.params as { id: string };
    return markRoomClean({
      context: request.userContext,
      roomId: params.id,
      correlationId: createId("corr")
    });
  });

  app.post("/rooms/:id/mark-inspected", async (request) => {
    const params = request.params as { id: string };
    return markRoomInspected({
      context: request.userContext,
      roomId: params.id,
      correlationId: createId("corr")
    });
  });

  // Room Rack actions — endpoints genéricos para tablero de habitaciones.
  // (Sin permisos finos: la operación de recepción los necesita rápido).
  // Rooms are addressed by id only, so the global tenant hook cannot see them:
  // resolve the owning property and apply the same rule (platform admins get
  // organizationId re-pointed to the room's org; everyone else — and any
  // unknown room/property — gets the same opaque 404).
  // (Implemented by `assertEntityAccess(request, { entity: "room", id })` below.)

  app.post("/rooms/:id/housekeeping-status", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: unknown };
    if (typeof body.status !== "string") throw new BadRequestError("status is required");
    // Tanda L5 (lote A): vocabulario cerrado. Los alias (ready → clean; stayover |
    // cleaning | in_progress → dirty) se aceptan pero NUNCA se almacenan; cualquier
    // otro texto es un 400. La escritura pasa por la transición unificada: auditada
    // (ROOM_STATE_CHANGED), idempotente y respetuosa con la ocupación / OOO en
    // `status` (una ocupada marcada limpia sigue ocupada). Los tres botones del
    // Room Rack y la pantalla móvil de pisos entran por aquí.
    const housekeeping = normalizeHousekeepingInput(body.status);
    if (!housekeeping) throw new BadRequestError("Estado de limpieza no válido: usa clean, dirty o inspected.");
    await assertEntityAccess(request, { entity: "room", id: params.id });
    const event = housekeeping === "clean" ? "mark_clean" : housekeeping === "dirty" ? "mark_dirty" : "mark_inspected";
    const outcome = await applyRoomTransition({
      roomId: params.id,
      event,
      context: request.userContext,
      correlationId: createId("corr"),
      reason: `housekeeping-status ${String(body.status).toLowerCase()}`
    });
    return outcome.room;
  });

  app.post("/rooms/:id/sellable", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { sellable?: boolean };
    if (typeof body.sellable !== "boolean") throw new BadRequestError("sellable boolean is required");
    await assertEntityAccess(request, { entity: "room", id: params.id });
    // Corrector L5 (OP-05): «Bloquear / Desbloquear habitación» del Room Rack pasa
    // por la transición unificada (auditada ROOM_STATE_CHANGED, idempotente):
    // no vendible → out_of_service si está libre; vendible de nuevo → vuelve al
    // inventario con su limpieza. Una bloqueada por orden de trabajo NO se libera
    // aquí (409 ROOM_MAINTENANCE_BLOCKED): invariante blocked ⇒ sellable=false.
    const outcome = await applyRoomTransition({
      roomId: params.id,
      event: body.sellable ? "mark_sellable" : "mark_unsellable",
      context: request.userContext,
      correlationId: createId("corr"),
      reason: body.sellable ? "room-rack: desbloquear habitación" : "room-rack: bloquear habitación"
    });
    return outcome.room;
  });

  app.get("/properties/:propertyId/work-orders", async (request) => {
    const params = request.params as { propertyId: string };
    const query = (request.query ?? {}) as { limit?: string; offset?: string };
    return listWorkOrders(params.propertyId, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined
    });
  });

  app.post("/work-orders", async (request) => {
    const body = request.body as {
      roomNumber?: string;
      title: string;
      description?: string;
      priority?: "emergency" | "urgent" | "normal" | "preventive";
      blocksRoom?: boolean;
    };

    return createWorkOrder({
      context: request.userContext,
      roomNumber: body.roomNumber,
      title: body.title,
      description: body.description,
      priority: body.priority ?? "normal",
      blocksRoom: body.blocksRoom ?? false,
      correlationId: createId("corr")
    });
  });

  app.patch("/work-orders/:id", async (request) => {
    const params = request.params as { id: string };
    const patch = requireObjectBody<Parameters<typeof updateWorkOrder>[0]["patch"]>(request.body);
    return updateWorkOrder({
      context: request.userContext,
      workOrderId: params.id,
      patch,
      correlationId: createId("corr")
    });
  });

  app.post("/work-orders/:id/media", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { objectKey: string; mediaType?: "photo" | "video" };
    return attachWorkOrderMedia({
      context: request.userContext,
      workOrderId: params.id,
      objectKey: body.objectKey,
      mediaType: body.mediaType ?? "photo",
      correlationId: createId("corr")
    });
  });

  app.post("/work-orders/:id/block-room", async (request) => {
    const params = request.params as { id: string };
    return blockRoomForMaintenance({
      context: request.userContext,
      workOrderId: params.id,
      correlationId: createId("corr")
    });
  });

  app.post("/work-orders/:id/resolve", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { resolutionNote?: string; releaseRoom?: boolean };
    return resolveWorkOrder({
      context: request.userContext,
      workOrderId: params.id,
      resolutionNote: body.resolutionNote,
      releaseRoom: body.releaseRoom,
      correlationId: createId("corr")
    });
  });

  // --- Compliance Center ---

  // PILOT-D4 · Salud agregada de las integraciones ES (VeriFactu/SES/TBAI/IGIC).
  // Devuelve modo (sandbox/preprod/prod), estado de certificados y stats 24h.
  // Útil para que el cliente piloto verifique su entorno antes de go-live.
  app.get("/compliance/health", async (request) => {
    const { getComplianceHealth } = await import("./modules/compliance/compliance-health.service.js");
    return getComplianceHealth(request.userContext.organizationId);
  });

  app.get("/compliance/properties/:propertyId/center", async (request) => {
    return getComplianceCenter((request.params as { propertyId: string }).propertyId);
  });
  app.patch("/compliance/properties/:propertyId/items/:requirementCode", async (request) => {
    const params = request.params as { propertyId: string; requirementCode: string };
    return updateComplianceItem({ context: request.userContext, propertyId: params.propertyId, requirementCode: params.requirementCode, patch: request.body as never });
  });
  app.patch("/compliance/properties/:propertyId/profile", async (request) => {
    const params = request.params as { propertyId: string };
    return updateComplianceProfile({ context: request.userContext, propertyId: params.propertyId, patch: request.body as never });
  });
  app.get("/compliance/properties/:propertyId/tasks", async (request) => {
    return listComplianceTasks((request.params as { propertyId: string }).propertyId);
  });
  app.post("/compliance/properties/:propertyId/tasks", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { requirementCode?: string; title: string; description?: string; assignedToName?: string; priority?: string; dueDate?: string };
    return createComplianceTask({ context: request.userContext, propertyId: params.propertyId, ...body });
  });
  app.patch("/compliance/tasks/:id", async (request) => {
    await assertEntityAccess(request, { entity: "complianceTask", id: (request.params as { id: string }).id });
    return updateComplianceTask({ context: request.userContext, taskId: (request.params as { id: string }).id, patch: request.body as never });
  });
  app.delete("/compliance/tasks/:id", async (request) => {
    await assertEntityAccess(request, { entity: "complianceTask", id: (request.params as { id: string }).id });
    return deleteComplianceTask({ context: request.userContext, taskId: (request.params as { id: string }).id });
  });
  app.get("/compliance/properties/:propertyId/documents", async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { requirementCode?: string };
    return { items: await listComplianceDocuments(params.propertyId, query.requirementCode) };
  });
  app.post("/compliance/properties/:propertyId/documents", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as Record<string, unknown>;
    return createComplianceDocument({ context: request.userContext, propertyId: params.propertyId, ...body } as Parameters<typeof createComplianceDocument>[0]);
  });
  app.delete("/compliance/documents/:id", async (request) => {
    await assertEntityAccess(request, { entity: "complianceDocument", id: (request.params as { id: string }).id });
    return deleteComplianceDocument({ context: request.userContext, documentId: (request.params as { id: string }).id });
  });
  app.get("/compliance/properties/:propertyId/alerts", async (request) => {
    return getComplianceAlerts((request.params as { propertyId: string }).propertyId);
  });
  app.get("/compliance/properties/:propertyId/inspection-folder", async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { preparedBy?: string };
    return exportInspectionFolder({ propertyId: params.propertyId, preparedBy: query.preparedBy });
  });
  app.get("/compliance/properties/:propertyId/assistant", async (request) => {
    return getComplianceAssistant((request.params as { propertyId: string }).propertyId, { context: request.userContext, correlationId: createId("corr") });
  });
  app.post("/compliance/ocr/extract-dates", async (request) => {
    const body = request.body as { imageDataUrl?: string };
    if (!body.imageDataUrl) throw new BadRequestError("Falta la imagen del documento.");
    return extractComplianceDocumentDates(body.imageDataUrl, { context: request.userContext, correlationId: createId("corr") });
  });

  // --- Cancellation policies + auto-charge engine ---
  app.get("/properties/:propertyId/cancellation-policies", async (request) => {
    return { items: await listCancellationPolicies((request.params as { propertyId: string }).propertyId) };
  });
  app.get("/cancellation-policies/:id", async (request) => {
    await assertEntityAccess(request, { entity: "cancellationPolicy", id: (request.params as { id: string }).id });
    return getCancellationPolicy((request.params as { id: string }).id);
  });
  app.post("/properties/:propertyId/cancellation-policies", async (request) => {
    const params = request.params as { propertyId: string };
    return createCancellationPolicy({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never });
  });
  app.patch("/cancellation-policies/:id", async (request) => {
    await assertEntityAccess(request, { entity: "cancellationPolicy", id: (request.params as { id: string }).id });
    return updateCancellationPolicy({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never });
  });
  app.delete("/cancellation-policies/:id", async (request) => {
    await assertEntityAccess(request, { entity: "cancellationPolicy", id: (request.params as { id: string }).id });
    return deleteCancellationPolicy((request.params as { id: string }).id);
  });
  app.get("/reservations/:id/cancellation-charge", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const query = parse(CancellationChargeQuerySchema, request.query ?? {}, "query");
    return computeCancellationCharge({ reservationId: (request.params as { id: string }).id, mode: query.mode ?? "cancellation" });
  });
  app.post("/reservations/:id/apply-cancellation-fee", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const id = (request.params as { id: string }).id;
    return applyCancellationFee({ context: request.userContext, reservationId: id, correlationId: createId("corr") });
  });
  app.post("/reservations/:id/apply-no-show-fee", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const id = (request.params as { id: string }).id;
    return applyNoShowFee({ context: request.userContext, reservationId: id, correlationId: createId("corr") });
  });

  // --- Tour operators (B2B partners) + Allotments (contracted room blocks) ---
  app.get("/organizations/:organizationId/tour-operators", async (request) => {
    await assertEntityAccess(request, { entity: "organization", id: (request.params as { organizationId: string }).organizationId });
    return { items: await listTourOperators((request.params as { organizationId: string }).organizationId) };
  });
  app.get("/tour-operators/:id", async (request) => {
    await assertEntityAccess(request, { entity: "tourOperator", id: (request.params as { id: string }).id });
    return getTourOperator((request.params as { id: string }).id);
  });
  app.post("/organizations/:organizationId/tour-operators", async (request) => {
    await assertEntityAccess(request, { entity: "organization", id: (request.params as { organizationId: string }).organizationId });
    const params = request.params as { organizationId: string };
    return createTourOperator({ context: request.userContext, organizationId: params.organizationId, payload: request.body as never });
  });
  app.patch("/tour-operators/:id", async (request) => {
    await assertEntityAccess(request, { entity: "tourOperator", id: (request.params as { id: string }).id });
    return updateTourOperator({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never });
  });
  app.get("/properties/:propertyId/allotments", async (request) => {
    return { items: await listAllotments((request.params as { propertyId: string }).propertyId) };
  });
  app.get("/allotments/:id", async (request) => {
    await assertEntityAccess(request, { entity: "allotment", id: (request.params as { id: string }).id });
    return getAllotment((request.params as { id: string }).id);
  });
  app.get("/allotments/:id/remaining", async (request) => {
    await assertEntityAccess(request, { entity: "allotment", id: (request.params as { id: string }).id });
    const id = (request.params as { id: string }).id;
    const query = request.query as { from?: string; to?: string };
    if (!query.from || !query.to) throw new BadRequestError("from y to son obligatorios (YYYY-MM-DD).");
    return { items: await getRemainingForRange(id, query.from, query.to) };
  });
  app.get("/properties/:propertyId/allotments/remaining-for-day", async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { roomTypeId?: string; date?: string };
    if (!query.roomTypeId || !query.date) throw new BadRequestError("roomTypeId y date son obligatorios.");
    return getRemainingForDay(params.propertyId, query.roomTypeId, query.date);
  });
  app.post("/properties/:propertyId/allotments", async (request) => {
    const params = request.params as { propertyId: string };
    return createAllotment({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never });
  });
  app.patch("/allotments/:id", async (request) => {
    await assertEntityAccess(request, { entity: "allotment", id: (request.params as { id: string }).id });
    return updateAllotment({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never });
  });
  app.delete("/allotments/:id", async (request) => {
    await assertEntityAccess(request, { entity: "allotment", id: (request.params as { id: string }).id });
    return deleteAllotment((request.params as { id: string }).id);
  });
  app.post("/properties/:propertyId/allotments/release-expired", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { asOfDate?: string };
    return releaseExpired({ propertyId: params.propertyId, asOfDate: body?.asOfDate });
  });

  // PILOT · Pickup summary del cupo (next N days) para el dashboard B2B.
  app.get("/properties/:propertyId/allotments/pickup-summary", async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { from?: string; windowDays?: string };
    return getPickupSummary({
      propertyId: params.propertyId,
      fromDate: query.from,
      windowDays: query.windowDays ? Number(query.windowDays) : undefined
    });
  });

  // --- Folio routing / split folios ---
  app.get("/reservations/:id/folios", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    return { items: await listReservationFolios((request.params as { id: string }).id) };
  });
  app.post("/reservations/:id/folios", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const id = (request.params as { id: string }).id;
    return createSecondaryFolio({ context: request.userContext, reservationId: id, payload: request.body as never });
  });
  app.get("/reservations/:id/routing-rules", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    return { items: await listRoutingRules((request.params as { id: string }).id) };
  });
  app.post("/reservations/:id/routing-rules", async (request) => {
    await assertEntityAccess(request, { entity: "reservation", id: (request.params as { id: string }).id });
    const id = (request.params as { id: string }).id;
    return createRoutingRule({ context: request.userContext, reservationId: id, payload: request.body as never });
  });
  app.patch("/routing-rules/:id", async (request) => {
    await assertEntityAccess(request, { entity: "folioRoutingRule", id: (request.params as { id: string }).id });
    return updateRoutingRule({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never });
  });
  app.delete("/routing-rules/:id", async (request) => {
    await assertEntityAccess(request, { entity: "folioRoutingRule", id: (request.params as { id: string }).id });
    return deleteRoutingRule((request.params as { id: string }).id);
  });
  app.post("/folio-lines/:lineId/transfer", async (request) => {
    await assertEntityAccess(request, { entity: "folioLine", id: (request.params as { lineId: string }).lineId });
    const lineId = (request.params as { lineId: string }).lineId;
    const body = request.body as { targetFolioId?: string };
    if (!body.targetFolioId) throw new BadRequestError("targetFolioId es obligatorio.");
    await assertEntityAccess(request, { entity: "folio", id: body.targetFolioId });
    return transferFolioLine({ context: request.userContext, lineId, targetFolioId: body.targetFolioId });
  });

  // --- F&B inventory (stock + menu + recipes + consumption) ---
  app.get("/properties/:propertyId/stock-locations", async (request) => {
    return { items: await listStockLocations((request.params as { propertyId: string }).propertyId) };
  });
  app.post("/properties/:propertyId/stock-locations", async (request) => {
    const params = request.params as { propertyId: string };
    return createStockLocation({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never });
  });
  app.get("/properties/:propertyId/inventory-items", async (request) => {
    return { items: await listInventoryItems((request.params as { propertyId: string }).propertyId) };
  });
  app.post("/properties/:propertyId/inventory-items", async (request) => {
    const params = request.params as { propertyId: string };
    return createInventoryItem({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never });
  });
  app.post("/properties/:propertyId/stock-movements", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as Parameters<typeof recordStockMovement>[0];
    return recordStockMovement({ ...body, propertyId: params.propertyId });
  });
  app.get("/properties/:propertyId/stock-balances", async (request) => {
    return { items: await listStockBalances((request.params as { propertyId: string }).propertyId) };
  });
  app.get("/properties/:propertyId/stock-balances/low-stock", async (request) => {
    return lowStockReport((request.params as { propertyId: string }).propertyId);
  });
  app.get("/properties/:propertyId/menu-items", async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { outletId?: string };
    return { items: await listMenuItems(params.propertyId, query.outletId) };
  });
  app.get("/menu-items/:id", async (request) => {
    await assertEntityAccess(request, { entity: "menuItem", id: (request.params as { id: string }).id });
    return getMenuItemWithRecipe((request.params as { id: string }).id);
  });
  app.post("/properties/:propertyId/menu-items", async (request) => {
    const params = request.params as { propertyId: string };
    return createMenuItem({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never });
  });
  app.post("/menu-items/:id/recipes", async (request) => {
    await assertEntityAccess(request, { entity: "menuItem", id: (request.params as { id: string }).id });
    const id = (request.params as { id: string }).id;
    return addMenuRecipe({ context: request.userContext, menuItemId: id, payload: request.body as never });
  });
  app.delete("/menu-recipes/:id", async (request) => {
    await assertEntityAccess(request, { entity: "menuRecipe", id: (request.params as { id: string }).id });
    return deleteMenuRecipe((request.params as { id: string }).id);
  });

  // --- Point of sale (TPV) --- Finanzas 2026-09-16: outlets, tickets, close,
  // cash-summary and the new cash closures live in modules/pos/pos.routes.ts
  // (registerPosRoutes, mounted next to registerChannelManagerRoutes).

  app.get("/properties/:propertyId/capex", async (request) => {
    const params = request.params as { propertyId: string };
    return listCapexProjects(params.propertyId);
  });

  app.get("/properties/:propertyId/assets", async (request) => {
    const params = request.params as { propertyId: string };
    return listAssets(params.propertyId);
  });

  app.post("/assets", async (request) => {
    const body = request.body as {
      propertyId?: string;
      roomId?: string;
      assetType: Parameters<typeof createAsset>[0]["assetType"];
      name: string;
      serialNumber?: string;
      warrantyUntil?: string;
      supplierId?: string;
    };
    return createAsset({
      context: request.userContext,
      propertyId: body.propertyId ?? request.userContext.propertyId,
      roomId: body.roomId,
      assetType: body.assetType,
      name: body.name,
      serialNumber: body.serialNumber,
      warrantyUntil: body.warrantyUntil,
      supplierId: body.supplierId,
      correlationId: createId("corr")
    });
  });

  app.patch("/assets/:id", async (request) => {
    await assertEntityAccess(request, { entity: "asset", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return updateAsset({
      context: request.userContext,
      assetId: params.id,
      patch: request.body as Parameters<typeof updateAsset>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/fixed-assets", async (request) => {
    const params = request.params as { propertyId: string };
    return listFixedAssets(params.propertyId);
  });

  app.get("/properties/:propertyId/room-profitability", async (request) => {
    const params = request.params as { propertyId: string };
    return calculateRoomProfitability(params.propertyId);
  });

  app.get("/properties/:propertyId/owner-dashboard", async (request) => {
    const params = request.params as { propertyId: string };
    return getOwnerDashboard(params.propertyId);
  });

  app.post("/capex-projects", async (request) => {
    const body = request.body as {
      propertyId?: string;
      name: string;
      description?: string;
      budget: number;
      startDate?: string;
      targetEndDate?: string;
    };
    return createCapexProject({
      context: request.userContext,
      propertyId: body.propertyId ?? request.userContext.propertyId,
      name: body.name,
      description: body.description,
      budget: body.budget,
      startDate: body.startDate,
      targetEndDate: body.targetEndDate,
      correlationId: createId("corr")
    });
  });

  app.patch("/capex-projects/:id", async (request) => {
    await assertEntityAccess(request, { entity: "capexProject", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return updateCapexProject({
      context: request.userContext,
      capexProjectId: params.id,
      patch: request.body as Parameters<typeof updateCapexProject>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/capex-projects/:id/items", async (request) => {
    await assertEntityAccess(request, { entity: "capexProject", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as {
      roomId?: string;
      assetId?: string;
      description: string;
      estimatedCost: number;
      actualCost?: number;
    };
    return createCapexItem({
      context: request.userContext,
      capexProjectId: params.id,
      roomId: body.roomId,
      assetId: body.assetId,
      description: body.description,
      estimatedCost: body.estimatedCost,
      actualCost: body.actualCost,
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/conversations", async (request) => {
    const params = request.params as { propertyId: string };
    return listConversations(params.propertyId);
  });

  app.get("/conversations/:id/messages", async (request) => {
    await assertEntityAccess(request, { entity: "conversation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return listMessages(params.id);
  });

  app.post("/conversations/:id/messages", async (request) => {
    await assertEntityAccess(request, { entity: "conversation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as {
      body?: string;
      senderType?: "guest" | "staff" | "ai";
      language?: string;
      attachments?: ChatAttachmentDraft[];
    };
    return sendConversationMessage({
      context: request.userContext,
      conversationId: params.id,
      senderType: body.senderType ?? "staff",
      body: body.body ?? "",
      language: body.language,
      attachments: body.attachments,
      correlationId: createId("corr")
    });
  });

  app.post("/conversations/:id/ai-draft", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "conversation", id: params.id });
    const body = request.body as { guestQuestion: string; tone?: string; language?: string };
    return createAiReplyDraft({
      context: request.userContext,
      conversationId: params.id,
      guestQuestion: body.guestQuestion,
      tone: body.tone,
      language: body.language,
      correlationId: createId("corr")
    });
  });

  app.post("/service-requests", async (request) => {
    const body = request.body as {
      propertyId?: string;
      reservationId?: string;
      guestId?: string;
      requestType: Parameters<typeof createServiceRequest>[0]["requestType"];
      assignedDepartment?: Parameters<typeof createServiceRequest>[0]["assignedDepartment"];
    };
    return createServiceRequest({
      context: request.userContext,
      propertyId: body.propertyId ?? request.userContext.propertyId,
      reservationId: body.reservationId,
      guestId: body.guestId,
      requestType: body.requestType,
      assignedDepartment: body.assignedDepartment,
      correlationId: createId("corr")
    });
  });

  app.patch("/service-requests/:id", async (request) => {
    await assertEntityAccess(request, { entity: "serviceRequest", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as Parameters<typeof updateServiceRequest>[0]["patch"];
    return updateServiceRequest({
      context: request.userContext,
      serviceRequestId: params.id,
      patch: body,
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/compliance/inbox", async (request) => {
    const params = request.params as { propertyId: string };
    return getComplianceInbox(params.propertyId);
  });

  app.get("/compliance/spain/properties/:propertyId/guest-register/settings", async (request) => {
    const params = request.params as { propertyId: string };
    return getSpainGuestRegisterSettings(params.propertyId);
  });

  app.patch("/compliance/spain/properties/:propertyId/guest-register/settings", async (request) => {
    const params = request.params as { propertyId: string };
    return patchSpainGuestRegisterSettings({
      context: request.userContext,
      propertyId: params.propertyId,
      patch: request.body as never,
      correlationId: createId("corr")
    });
  });

  app.get("/compliance/spain/reservations/:reservationId/guest-register", async (request) => {
    const params = request.params as { reservationId: string };
    await assertEntityAccess(request, { entity: "reservation", id: params.reservationId });
    return listReservationGuestRegisterRecords(params.reservationId);
  });

  app.post("/compliance/spain/reservations/:reservationId/guest-register", async (request) => {
    const params = request.params as { reservationId: string };
    const body = request.body as Parameters<typeof createSpainGuestRegisterRecord>[0]["payload"] & { propertyId?: string };
    const propertyId = body.propertyId ?? request.userContext.propertyId;
    // The register hangs from the reservation, which must belong to that
    // property (a body propertyId is already validated by the global hook).
    await assertEntityAccess(request, { entity: "reservation", id: params.reservationId, propertyId });
    return createSpainGuestRegisterRecord({
      context: request.userContext,
      propertyId,
      reservationId: params.reservationId,
      payload: body,
      correlationId: createId("corr")
    });
  });

  app.patch("/compliance/spain/guest-register/:recordId", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { recordId: string }).recordId });
    const params = request.params as { recordId: string };
    return patchSpainGuestRegisterRecord({
      context: request.userContext,
      recordId: params.recordId,
      patch: request.body as Parameters<typeof patchSpainGuestRegisterRecord>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/guest-register/:recordId/validate", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { recordId: string }).recordId });
    const params = request.params as { recordId: string };
    return validateSpainGuestRegisterRecordApi({ context: request.userContext, recordId: params.recordId, correlationId: createId("corr") });
  });

  app.post("/compliance/spain/guest-register/:recordId/sign", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { recordId: string }).recordId });
    const params = request.params as { recordId: string };
    const body = request.body as { signatureObjectKey?: string };
    return markGuestRegisterSigned({
      context: request.userContext,
      guestRegisterRecordId: params.recordId,
      signatureObjectKey: body.signatureObjectKey ?? `signatures/${params.recordId}.svg`,
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/guest-register/:recordId/mark-identity-verified", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { recordId: string }).recordId });
    const params = request.params as { recordId: string };
    const body = request.body as { method?: string };
    return markGuestRegisterIdentityVerified({
      context: request.userContext,
      recordId: params.recordId,
      method: body.method ?? "visual_document_check",
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/guest-register/:recordId/queue-submission", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { recordId: string }).recordId });
    const params = request.params as { recordId: string };
    const body = request.body as { submissionType?: Parameters<typeof queueGuestAuthoritySubmission>[0]["submissionType"] };
    return queueGuestAuthoritySubmission({
      context: request.userContext,
      recordId: params.recordId,
      submissionType: body.submissionType ?? "checkin",
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/guest-register/:recordId/correct", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { recordId: string }).recordId });
    const params = request.params as { recordId: string };
    return correctSpainGuestRegisterRecord({
      context: request.userContext,
      recordId: params.recordId,
      patch: request.body as Parameters<typeof correctSpainGuestRegisterRecord>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/guest-register/:recordId/annul", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { recordId: string }).recordId });
    const params = request.params as { recordId: string };
    const body = request.body as { reason?: string };
    return annulAuthorityCommunication({
      context: request.userContext,
      recordId: params.recordId,
      reason: body.reason ?? "Manual annulment requested by compliance user.",
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/identity-document/temporary-scan", async (request) => {
    const body = request.body as Parameters<typeof recordTemporaryIdentityScan>[0];
    return recordTemporaryIdentityScan({
      ...body,
      context: request.userContext,
      propertyId: body.propertyId ?? request.userContext.propertyId,
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/identity-document/discard-event", async (request) => {
    const body = request.body as Parameters<typeof recordIdentityDiscardEvent>[0];
    return recordIdentityDiscardEvent({
      ...body,
      context: request.userContext,
      propertyId: body.propertyId ?? request.userContext.propertyId,
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/ses-hospedajes/properties/:propertyId/batches/generate", async (request) => {
    const params = request.params as { propertyId: string };
    return generateSesHospedajesBatch({ context: request.userContext, propertyId: params.propertyId, correlationId: createId("corr") });
  });

  app.post("/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/submit", async (request) => {
    const params = request.params as { propertyId: string; batchId: string };
    return submitSesHospedajesBatch({ context: request.userContext, propertyId: params.propertyId, batchId: params.batchId, correlationId: createId("corr") });
  });

  app.get("/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/download", async (request) => {
    const params = request.params as { propertyId: string; batchId: string };
    return downloadSesHospedajesBatch({ context: request.userContext, propertyId: params.propertyId, batchId: params.batchId, correlationId: createId("corr") });
  });

  app.post("/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/mark-manually-uploaded", async (request) => {
    const params = request.params as { propertyId: string; batchId: string };
    const body = request.body as { receiptReference?: string };
    return markSesBatchManuallyUploaded({
      context: request.userContext,
      propertyId: params.propertyId,
      batchId: params.batchId,
      receiptReference: body.receiptReference,
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/ses-hospedajes/properties/:propertyId/test-connection", async (request) => {
    const params = request.params as { propertyId: string };
    return testSesHospedajesConnection({ context: request.userContext, propertyId: params.propertyId, correlationId: createId("corr") });
  });

  app.get("/properties/:propertyId/guest-register-records", async (request) => {
    const params = request.params as { propertyId: string };
    await assertPropertyInOrg(params.propertyId, request.userContext.organizationId);
    return listGuestRegisterRecords(params.propertyId);
  });

  app.post("/guest-register-records/:id/sign", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as { signatureObjectKey: string };
    return markGuestRegisterSigned({
      context: request.userContext,
      guestRegisterRecordId: params.id,
      signatureObjectKey: body.signatureObjectKey,
      correlationId: createId("corr")
    });
  });

  app.patch("/guest-register-records/:id/correct", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return correctGuestRegisterRecord({
      context: request.userContext,
      guestRegisterRecordId: params.id,
      fields: request.body as CheckInFromScanRequest["documentExtractedFields"],
      correlationId: createId("corr")
    });
  });

  app.post("/guest-register-records/:id/queue-ses", async (request) => {
    await assertEntityAccess(request, { entity: "guestRegisterRecord", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as { submissionType?: "reservation" | "checkin" | "cancellation" };
    return queueSesHospedajesSubmission({
      context: request.userContext,
      guestRegisterRecordId: params.id,
      submissionType: body.submissionType ?? "checkin",
      correlationId: createId("corr")
    });
  });

  // ---------- GDPR DSAR / Right-to-erasure (Sprint 31) ----------
  app.post("/gdpr/requests", async (request) => {
    const body = parse(CreateGdprRequestSchema, request.body);
    return createGdprRequest({
      organizationId: request.userContext.organizationId,
      propertyId: body.propertyId,
      subjectEmail: body.subjectEmail,
      subjectId: body.subjectId,
      requestType: body.requestType,
      requestorEmail: body.requestorEmail,
      payloadJson: body.payloadJson,
      context: request.userContext,
      correlationId: createId("corr")
    });
  });

  app.get("/gdpr/requests", async (request) => {
    const query = (request.query ?? {}) as { status?: string; requestType?: string };
    // SECURITY (audit 2026-06 · IDOR): the org is ALWAYS the caller's — never a
    // query param, which previously let one tenant list another's DSAR requests.
    return gdprListRequests({
      organizationId: request.userContext.organizationId,
      status: query.status,
      requestType: query.requestType
    });
  });

  app.get("/gdpr/requests/:id", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "gdprRequest", id: params.id });
    return gdprGetRequest(params.id);
  });

  app.post("/gdpr/requests/:id/acknowledge", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "gdprRequest", id: params.id });
    return gdprAcknowledgeRequest(params.id, request.userContext.userId);
  });

  app.post("/gdpr/requests/:id/fulfill-dsar", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "gdprRequest", id: params.id });
    return gdprFulfillDsar(params.id, request.userContext.userId);
  });

  app.post("/gdpr/requests/:id/execute-erasure", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "gdprRequest", id: params.id });
    const body = parse(ExecuteErasureSchema, request.body ?? {});
    return gdprExecuteErasure(params.id, request.userContext.userId, {
      confirmRetentionOverride: Boolean(body.confirmRetentionOverride)
    });
  });

  app.post("/gdpr/requests/:id/reject", async (request) => {
    const params = request.params as { id: string };
    await assertEntityAccess(request, { entity: "gdprRequest", id: params.id });
    const body = parse(RejectGdprRequestSchema, request.body ?? {});
    return gdprRejectRequest(params.id, body.reason, request.userContext.userId);
  });

  // Sprint 35 — PII backfill. Streams every Guest + GuestRegisterRecord
  // row, encrypts any plaintext PII columns, and populates the new
  // *LookupHash sibling columns. Runs inline (sync); the returned body
  // is the JSON summary.
  app.post("/admin/jobs/pii-backfill", async (request) => {
    const { runPiiBackfill } = await import("./jobs/pii-backfill.js");
    return runPiiBackfill();
  });

  // Tenant Admin — superadmin / multi-tenant ops powering the admin-web
  // tenant management screens. Routes mirror the apiClient signatures in
  // apps/admin-web/src/services/tenantAdminApi.ts.
  app.get('/admin/tenants', async (request) => listTenants({ context: request.userContext }));
  app.get('/admin/tenants/:orgId', async (request) => getTenantDetail({ context: request.userContext, orgId: (request.params as any).orgId }));
  app.post('/admin/tenants', async (request) => {
    // Auditoría 2026-07: el front (tenantAdminApi.CreateTenantPayload) envía el
    // payload PLANO { name, country, plan, ownerEmail, ownerFullName, propertyName };
    // el servicio espera el DTO anidado (CreateTenantInput). Sin este puente el
    // alta fallaba con "organizationName is required" aunque RBAC estuviera bien.
    // Se aceptan AMBAS formas (anidada tiene prioridad) para no romper API clients.
    const body = (request.body ?? {}) as {
      name?: string; country?: string; plan?: string;
      ownerEmail?: string; ownerFullName?: string; ownerPhone?: string;
      propertyName?: string; propertyType?: string;
      municipality?: string; province?: string;
      organizationName?: string; organizationCountry?: string;
      property?: { name?: string; type?: string; municipality?: string; province?: string; taxRegion?: string; postalCode?: string; ineMunicipalityCode?: string; fiscalTerritory?: string; kind?: string; code?: string };
      ownerUser?: { email?: string; fullName?: string; phone?: string };
      modulesEnabled?: string[];
      // Tanda 6b (L2): the implicit sociedad of the new tenant. Everything
      // optional (NIF pendiente when omitted); the service validates the NIF
      // (400 TAX_ID_INVALID · 409 TAX_ID_IN_USE) and the code.
      legalEntity?: { legalName?: string; taxId?: string; code?: string; legalForm?: string };
    };
    const ownerEmail = body.ownerUser?.email ?? body.ownerEmail ?? "";
    const propertyKind = body.property?.kind;
    const legalForm = body.legalEntity?.legalForm;
    return createTenant({
      context: request.userContext,
      organizationName: body.organizationName ?? body.name ?? "",
      organizationCountry: body.organizationCountry ?? body.country ?? "ES",
      property: {
        name: body.property?.name ?? body.propertyName ?? body.name ?? "",
        type: body.property?.type ?? body.propertyType ?? "hotel",
        // el wizard (NewTenantWizardDialog) envía municipality/province PLANOS
        municipality: body.property?.municipality ?? body.municipality,
        province: body.property?.province ?? body.province,
        taxRegion: body.property?.taxRegion,
        postalCode: body.property?.postalCode,
        ineMunicipalityCode: body.property?.ineMunicipalityCode,
        fiscalTerritory: body.property?.fiscalTerritory,
        // Tanda 6b (L2): work-centre kind / code of the first centre (values
        // outside the enum fall back to the service defaults: hotel, derived code).
        kind: PROPERTY_KINDS.includes(propertyKind as PropertyKind) ? (propertyKind as PropertyKind) : undefined,
        code: body.property?.code
      },
      legalEntity: body.legalEntity
        ? {
            legalName: body.legalEntity.legalName,
            taxId: body.legalEntity.taxId,
            code: body.legalEntity.code,
            legalForm: LEGAL_FORMS.includes(legalForm as LegalForm) ? (legalForm as LegalForm) : undefined
          }
        : undefined,
      ownerUser: {
        email: ownerEmail,
        // fallback: si no llega nombre, usar el local-part del email (mejor que romper el alta)
        fullName: body.ownerUser?.fullName ?? body.ownerFullName ?? ownerEmail.split("@")[0] ?? "",
        phone: body.ownerUser?.phone ?? body.ownerPhone
      },
      modulesEnabled: body.modulesEnabled ?? [],
      plan: body.plan === "pro" || body.plan === "enterprise" ? body.plan : "starter"
    });
  });
  app.post('/admin/tenants/:orgId/users/:userId/reset-password', async (request) => regenerateTempPassword({ context: request.userContext, userId: (request.params as { userId: string; orgId: string }).userId, orgId: (request.params as { userId: string; orgId: string }).orgId }));
  // Tanda 3 (CFG-P1-6): re-issue the owner/user invitation of a tenant from the
  // platform console (replaces the clear-text temp password flow). The service
  // checks user.organizationId === orgId; the org itself is granted first.
  app.post('/admin/tenants/:orgId/users/:userId/reissue-invite', async (request) => {
    const params = request.params as { orgId: string; userId: string };
    await assertEntityAccess(request, { entity: "organization", id: params.orgId });
    return reissueInvitation({
      userId: params.userId,
      organizationId: params.orgId,
      actorUserId: request.userContext.userId ?? null
    });
  });
  app.patch('/admin/tenants/:orgId/modules/:moduleCode', async (request) => toggleTenantModule({ context: request.userContext, orgId: (request.params as any).orgId, moduleCode: (request.params as any).moduleCode, enabled: ((request.body as any).enabled === true) }));
  app.get('/admin/tenants/:orgId/audit-log', async (request) => getTenantAuditLog({ context: request.userContext, orgId: (request.params as any).orgId, limit: Number((request.query as any).limit ?? 50) }));

  app.post("/ai/commands/check-in-from-scan", async (request) => {
    return createCheckInFromScanConfirmation({
      context: request.userContext,
      request: request.body as CheckInFromScanRequest,
      correlationId: createId("corr")
    });
  });

  // Real OCR of an ID document via a vision model (P2). Accepts an image data
  // URL; when an AI provider is configured it returns extracted identity fields,
  // otherwise it returns configured:false so the UI asks for manual entry.
  // The result is ALWAYS reviewed by staff before use — never auto-applied.
  app.post("/ai/commands/scan-id-document", async (request) => {
    const body = (request.body ?? {}) as { imageDataUrl?: string };
    if (!body.imageDataUrl) throw new BadRequestError("imageDataUrl is required.");
    return scanIdDocumentCommand({ context: request.userContext, imageDataUrl: body.imageDataUrl, correlationId: createId("corr") });
  });

  // LLM-assisted mapping suggestion for the onboarding mapping review (P2). The
  // deterministic mapping engine remains the source of truth; this only proposes
  // a canonical target for a LOW-CONFIDENCE source value, which a human must
  // still approve. When no AI provider is configured it returns configured:false.
  app.post("/onboarding/ai/suggest-mapping", async (request) => {
    const body = (request.body ?? {}) as { sourceValue?: string; targetType?: string };
    if (!body.sourceValue || !body.targetType) throw new BadRequestError("sourceValue and targetType are required.");
    return suggestMappingCommand({ context: request.userContext, sourceValue: body.sourceValue, targetType: body.targetType, correlationId: createId("corr") });
  });

  app.post("/ai/confirmations/:confirmationId/execute", async (request) => {
    await assertEntityAccess(request, { entity: "pendingConfirmation", id: (request.params as { confirmationId: string }).confirmationId });
    const params = request.params as { confirmationId: string };
    const body = request.body as { signatureObjectKey?: string };
    return executeConfirmation({
      context: request.userContext,
      confirmationId: params.confirmationId,
      signatureObjectKey: body.signatureObjectKey ?? "sig_demo_guest",
      correlationId: createId("corr")
    });
  });

  // Night audit (business-date, runs, run, preflight, run report): Finanzas
  // 2026-09-16 → modules/night-audit/night-audit.routes.ts (registerNightAuditRoutes).

  app.get("/accounting/journal-entries/recent", async (request) => {
    const params = (request.query as { propertyId?: string; limit?: string }) ?? {};
    const limit = Math.min(Number(params.limit ?? 50), 200);
    const entries = await (await import("@hotelos/database")).prisma.journalEntry.findMany({
      // Tenant scope: without ?propertyId this listed every organization's
      // journal (AUTH-03); a propertyId in the query is validated by the hook.
      where: {
        organizationId: request.userContext.organizationId,
        ...(params.propertyId ? { propertyId: params.propertyId } : {})
      },
      orderBy: { postedAt: "desc" },
      take: limit
    });
    const ids = entries.map((e) => e.id);
    const lines = ids.length
      ? await (await import("@hotelos/database")).prisma.journalLine.findMany({ where: { journalEntryId: { in: ids } } })
      : [];
    const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
    const accounts = accountIds.length
      ? await (await import("@hotelos/database")).prisma.account.findMany({ where: { id: { in: accountIds } } })
      : [];
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    return entries.map((entry) => ({
      id: entry.id,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      status: entry.status,
      postedAt: entry.postedAt?.toISOString(),
      lines: lines
        .filter((l) => l.journalEntryId === entry.id)
        .map((l) => ({
          accountCode: accountById.get(l.accountId)?.code ?? l.accountId,
          accountName: accountById.get(l.accountId)?.name ?? "?",
          debit: Number(l.debit),
          credit: Number(l.credit),
          description: l.description
        }))
    }));
  });

  app.get("/accounting/fiscal-periods", async (request) => {
    const query = request.query as { propertyId?: string };
    return listFiscalPeriods({ context: request.userContext, propertyId: query.propertyId });
  });

  app.post("/accounting/fiscal-periods", async (request) => {
    const body = request.body as {
      propertyId?: string;
      periodCode: string;
      periodType: "month" | "quarter" | "year";
      startDate: string;
      endDate: string;
    };
    return openFiscalPeriod({
      context: request.userContext,
      propertyId: body.propertyId,
      periodCode: body.periodCode,
      periodType: body.periodType,
      startDate: body.startDate,
      endDate: body.endDate,
      correlationId: createId("corr")
    });
  });

  app.post("/accounting/fiscal-periods/:id/close", async (request) => {
    await assertEntityAccess(request, { entity: "fiscalPeriod", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { closingNotes?: string };
    return closeFiscalPeriod({
      context: request.userContext,
      periodId: params.id,
      closingNotes: body.closingNotes,
      correlationId: createId("corr")
    });
  });

  app.post("/accounting/fiscal-periods/:id/reopen", async (request) => {
    await assertEntityAccess(request, { entity: "fiscalPeriod", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as { reason: string };
    return reopenFiscalPeriod({
      context: request.userContext,
      periodId: params.id,
      reason: body.reason,
      correlationId: createId("corr")
    });
  });

  // ---------------- Sprint 25 — Year-end close (Spanish PGC) ----------------

  app.get("/accounting/fiscal-years", async (request) => {
    const query = request.query as { organizationId?: string; propertyId?: string };
    // organizationId is taken from the auth context; the query-string variant
    // is accepted only as a no-op compatibility hook for clients that want to
    // be explicit. We never trust it to override the authenticated org.
    void query.organizationId;
    return listFiscalYears({ context: request.userContext, propertyId: query.propertyId });
  });

  app.post("/accounting/fiscal-years", async (request) => {
    const body = parse(CreateFiscalYearSchema, request.body);
    return createFiscalYear({
      context: request.userContext,
      propertyId: body.propertyId,
      code: body.code,
      startDate: body.startDate,
      endDate: body.endDate,
      correlationId: createId("corr")
    });
  });

  app.get("/accounting/fiscal-years/:id/status", async (request) => {
    await assertEntityAccess(request, { entity: "fiscalYear", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return getFiscalYearStatus({ context: request.userContext, id: params.id });
  });

  app.post("/accounting/fiscal-years/:id/close", async (request) => {
    await assertEntityAccess(request, { entity: "fiscalYear", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = parse(CloseFiscalYearSchema, request.body ?? {});
    return closeFiscalYear({
      context: request.userContext,
      id: params.id,
      createNextYear: body.createNextYear,
      correlationId: createId("corr")
    });
  });

  app.post("/accounting/fiscal-years/:id/reopen", async (request) => {
    await assertEntityAccess(request, { entity: "fiscalYear", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = parse(ReopenFiscalYearSchema, request.body ?? {});
    return reopenFiscalYear({
      context: request.userContext,
      id: params.id,
      reason: body.reason ?? "manual reopen",
      correlationId: createId("corr")
    });
  });

  app.get("/accounting/reports/pnl", async (request) => {
    const query = request.query as { propertyId?: string; fromDate: string; toDate: string };
    return getProfitAndLoss({
      context: request.userContext,
      propertyId: query.propertyId,
      fromDate: query.fromDate,
      toDate: query.toDate
    });
  });

  app.get("/accounting/reports/balance-sheet", async (request) => {
    const query = request.query as { propertyId?: string; asOf: string };
    // If the query contains only `asOf` and `propertyId`, return the formal Balance Sheet (Sprint 21
    // Track 2). Other callers may continue to use the legacy raw report by appending ?legacy=1.
    if ((query as { legacy?: string }).legacy === "1") {
      return getBalanceSheet({
        context: request.userContext,
        propertyId: query.propertyId,
        asOf: query.asOf
      });
    }
    return buildFormalBalanceSheet({
      context: request.userContext,
      propertyId: query.propertyId,
      asOf: query.asOf
    });
  });

  app.get("/accounting/reports/trial-balance", async (request) => {
    const query = request.query as {
      propertyId?: string;
      asOf: string;
      fromDate?: string;
      toDate?: string;
    };
    return buildTrialBalance({
      context: request.userContext,
      propertyId: query.propertyId,
      asOf: query.asOf,
      fromDate: query.fromDate,
      toDate: query.toDate
    });
  });

  app.get("/accounting/reports/cash-flow", async (request) => {
    const query = request.query as { propertyId?: string; fromDate: string; toDate: string };
    return buildCashFlow({
      context: request.userContext,
      propertyId: query.propertyId,
      fromDate: query.fromDate,
      toDate: query.toDate
    });
  });

  // Tanda 3 (cierre · server-rutas): shared pagination contract (lib/pagination.ts)
  // on the VeriFactu history — bare array by default, `{ items, nextCursor, total }`
  // with ?cursor= / ?envelope=1, X-Total-Count always and X-Next-Cursor while
  // more rows exist, optional ?status= / ?registroType=. listVerifactuSubmissions
  // already returns a `Page` (createdAt desc, id desc; `total` over the filtered
  // set) and decodes the opaque cursor itself, so a malformed one is the
  // contract's 400 — the handler only parses the query and shapes the answer.
  app.get("/properties/:propertyId/verifactu/submissions", async (request, reply) => {
    const params = request.params as { propertyId: string };
    const page = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const filters = parse(VerifactuSubmissionListQuerySchema, request.query ?? {}, "query");
    const result = await listVerifactuSubmissions(params.propertyId, {
      limit: page.limit,
      cursor: page.cursor,
      registroType: filters.registroType,
      status: filters.status
    });
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });

  app.get("/invoices/:id/verifactu", async (request) => {
    await assertEntityAccess(request, { entity: "invoice", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const submission = await getVerifactuSubmission(params.id);
    if (!submission) return { status: "not_submitted" };
    return submission;
  });

  // /properties/:propertyId/tbai/submissions movido al nuevo servicio foral en P1-8.
  // El servicio legacy (single-territory) sigue disponible internamente vía
  // listTbaiSubmissions() para los jobs de retry del worker.

  app.get("/properties/:propertyId/igic/submissions", async (request) => {
    const params = request.params as { propertyId: string };
    return listIgicSubmissions(params.propertyId);
  });

  // Tanda 3 (QC-01): SES history from Prisma with the shared cursor pagination
  // (bare array by default, `{ items, nextCursor, total }` with ?cursor=/?envelope=1,
  // X-Total-Count / X-Next-Cursor always). Optional ?status= filter.
  app.get("/properties/:propertyId/ses/submissions", async (request, reply) => {
    const params = request.params as { propertyId: string };
    const page = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const filters = parse(SesSubmissionListQuerySchema, request.query ?? {}, "query");
    const result = await listSesSubmissions(params.propertyId, {
      limit: page.limit,
      // Contract (F) types the cursor as `string | undefined`; parsePageQuery yields null for "no cursor".
      cursor: page.cursor ?? undefined,
      status: filters.status,
      includeDiscarded: filters.includeDiscarded === "true" || filters.includeDiscarded === "1"
    });
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });

  // Tanda 3 (FISC-08): the establishment block the SES XML would carry (NIF,
  // legal name, registry number, address, INE municipality, postal code…) and
  // the list of missing fields. The POST below answers 409 with
  // details.code = SES_ESTABLISHMENT_INCOMPLETE and the same `missing` list.
  app.get("/properties/:propertyId/ses/establishment", async (request) => {
    const params = request.params as { propertyId: string };
    return resolveSesEstablishment(params.propertyId);
  });

  // Parte de viajeros SES.HOSPEDAJES: encola el envío del registro de una reserva
  // por el pipeline real (persiste en Prisma `SesHospedajesSubmission`). Antes esta
  // ruta NO existía — el check-in (QuickCheckInDrawer) hacía POST aquí y recibía un
  // 404 tragado en silencio, con UI de éxito falsa (auditoría 2026-06 · crítico SES).
  // Encola los registros ya creados de la reserva. El envío real al MIR requiere
  // además SES_HOSPEDAJES_MODE=production + certificado (hoy stub sandbox).
  //
  // Tanda 3 (cierre · CRÍTICO): the previous version mapped the partes to
  // `queueSesHospedajesSubmission(...)` WITHOUT awaiting: the body carried empty
  // promises and every rejection (409 SES_ESTABLISHMENT_INCOMPLETE on Faranda)
  // became an unhandledRejection that took the :3000 process down. Each parte is
  // now awaited under its own try/catch (honest catch, QC-06): typed HTTP errors
  // are per-parte outcomes reported in `failed[]`; anything else (DB down, bug)
  // aborts the request with a 500 and its trace. Response:
  //   { status: "queued" | "partial", queued, submissions[{ id, guestRegisterRecordId,
  //     submissionType, status }], failed[{ guestRegisterRecordId, code, message,
  //     missing, submissionId }] }
  //   · no partes → 409 SES_NO_GUEST_REGISTER_RECORDS
  //   · every parte failed with the SAME code → 409 with that code and the same
  //     details the single-record route raises (missing[], submissionId…) plus the
  //     summary (status "failed", queued 0, failed[]), so QuickCheckInDrawer keeps
  //     branching on details.code;
  //   · every parte failed with MIXED codes → 409 SES_QUEUE_FAILED with failed[].
  //   A total failure is never a 200 with status "failed": callers that only check
  //   `res.ok` would repeat the silent-success bug this route was created to fix.
  app.post("/properties/:propertyId/ses/submissions", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as { reservationId?: string };
    await assertPropertyInOrg(params.propertyId, request.userContext.organizationId);
    if (!body.reservationId) {
      throw new BadRequestError("reservationId es obligatorio para el parte de viajeros.");
    }
    await assertEntityAccess(request, { entity: "reservation", id: body.reservationId });
    const records = await listReservationGuestRegisterRecords(body.reservationId);
    if (records.length === 0) {
      const noRecords = new ConflictError("La reserva no tiene partes de viajeros que comunicar a SES.HOSPEDAJES.");
      noRecords.details = { code: "SES_NO_GUEST_REGISTER_RECORDS", reservationId: body.reservationId, propertyId: params.propertyId };
      throw noRecords;
    }
    type QueuedParte = { id: string; guestRegisterRecordId: string; submissionType: string; status: string };
    type FailedParte = { guestRegisterRecordId: string; code: string; message: string; missing: string[]; submissionId: string | null };
    const submissions: QueuedParte[] = [];
    const failed: FailedParte[] = [];
    for (const record of records) {
      const correlationId = createId("corr");
      try {
        const view = await queueSesHospedajesSubmission({
          context: request.userContext,
          guestRegisterRecordId: record.id,
          submissionType: "checkin",
          correlationId
        });
        submissions.push({
          id: view.id,
          guestRegisterRecordId: view.guestRegisterRecordId,
          submissionType: view.submissionType,
          status: view.status
        });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        const details = (error.details && typeof error.details === "object" ? error.details : {}) as {
          code?: unknown;
          missing?: unknown;
          submissionId?: unknown;
        };
        const entry: FailedParte = {
          guestRegisterRecordId: record.id,
          code: typeof details.code === "string" ? details.code : `HTTP_${error.statusCode}`,
          message: error.message,
          missing: Array.isArray(details.missing) ? details.missing.map(String) : [],
          submissionId: typeof details.submissionId === "string" ? details.submissionId : null
        };
        failed.push(entry);
        request.log.warn(
          { err: error, reservationId: body.reservationId, guestRegisterRecordId: record.id, code: entry.code, correlationId },
          "[ses] parte de viajeros could not be queued"
        );
      }
    }
    if (submissions.length === 0) {
      const first = failed[0];
      const sameCause = first !== undefined && failed.every((entry) => entry.code === first.code);
      const summary = { status: "failed" as const, queued: 0, submissions, failed };
      const conflict = new ConflictError(sameCause ? first.message : "Ningún parte de viajeros se pudo encolar.");
      conflict.details = sameCause
        ? {
            code: first.code,
            missing: first.missing,
            submissionId: first.submissionId,
            propertyId: params.propertyId,
            reservationId: body.reservationId,
            ...summary
          }
        : { code: "SES_QUEUE_FAILED", propertyId: params.propertyId, reservationId: body.reservationId, ...summary };
      throw conflict;
    }
    return {
      status: failed.length === 0 ? ("queued" as const) : ("partial" as const),
      queued: submissions.length,
      submissions,
      failed
    };
  });

  // Single-submission detail endpoints (full XML + response ACK + history)
  app.get("/verifactu/submissions/:id", async (request) => {
    await assertEntityAccess(request, { entity: "verifactuSubmission", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const sub = await getVerifactuSubmissionById(params.id);
    if (!sub) return { status: "not_found" };
    return sub;
  });

  app.get("/tbai/submissions/:id", async (request) => {
    await assertEntityAccess(request, { entity: "tbaiSubmission", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const sub = await getTbaiSubmission(params.id);
    if (!sub) return { status: "not_found" };
    return sub;
  });

  app.get("/igic/submissions/:id", async (request) => {
    await assertEntityAccess(request, { entity: "igicSubmission", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const sub = await getIgicSubmission(params.id);
    if (!sub) return { status: "not_found" };
    return sub;
  });

  app.get("/ses/submissions/:id", async (request) => {
    await assertEntityAccess(request, { entity: "sesHospedajesSubmission", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const sub = await getSesSubmission(params.id);
    if (!sub) return { status: "not_found" };
    return sub;
  });

  // Manual retry endpoints (also picked up automatically by pg-boss cron)
  app.post("/verifactu/submissions/:id/retry", async (request) => {
    await assertEntityAccess(request, { entity: "verifactuSubmission", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    await retryVerifactuSubmission(params.id);
    return { status: "queued" };
  });

  app.post("/tbai/submissions/:id/retry", async (request) => {
    await assertEntityAccess(request, { entity: "tbaiSubmission", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    await retryTbaiSubmission(params.id);
    return { status: "queued" };
  });

  app.post("/igic/submissions/:id/retry", async (request) => {
    await assertEntityAccess(request, { entity: "igicSubmission", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    await retryIgicSubmission(params.id);
    return { status: "queued" };
  });

  app.post("/ses/submissions/:id/retry", async (request) => {
    await assertEntityAccess(request, { entity: "sesHospedajesSubmission", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    await retrySesSubmission(params.id, request.userContext);
    return { status: "queued" };
  });

  // Finanzas (2026-09-16): legacy report routes kept for the front until it
  // moves to GET /fiscal/models/:modelo; they accept `period=2026-Q3|2026-09`
  // as well as the old fromDate/toDate window and return the FiscalModelReport.
  app.get("/accounting/reports/modelo-303", async (request) => {
    const query = request.query as { propertyId?: string; period?: string; fromDate?: string; toDate?: string; periodType?: "monthly" | "quarterly" };
    return buildModelo303({
      context: request.userContext,
      propertyId: query.propertyId,
      period: query.period,
      fromDate: query.fromDate,
      toDate: query.toDate,
      periodType: query.periodType
    });
  });

  app.get("/accounting/reports/modelo-111", async (request) => {
    const query = request.query as { propertyId?: string; period?: string; fromDate?: string; toDate?: string; periodType?: "monthly" | "quarterly" };
    return buildModelo111({
      context: request.userContext,
      propertyId: query.propertyId,
      period: query.period,
      fromDate: query.fromDate,
      toDate: query.toDate,
      periodType: query.periodType
    });
  });

  app.get("/accounting/reports/modelo-115", async (request) => {
    const query = request.query as { propertyId?: string; period?: string; fromDate?: string; toDate?: string; periodType?: "monthly" | "quarterly" };
    return buildModelo115({
      context: request.userContext,
      propertyId: query.propertyId,
      period: query.period,
      fromDate: query.fromDate,
      toDate: query.toDate,
      periodType: query.periodType
    });
  });

  app.get("/accounting/reports/modelo-180", async (request) => {
    const query = request.query as { propertyId?: string; year: string };
    return buildModelo180({
      context: request.userContext,
      propertyId: query.propertyId,
      year: Number(query.year)
    });
  });

  app.get("/accounting/reports/modelo-390", async (request) => {
    const query = request.query as { propertyId?: string; year: string };
    return buildModelo390({
      context: request.userContext,
      propertyId: query.propertyId,
      year: Number(query.year)
    });
  });

  // Commission engine OTA (Sprint 22 — Track 4)
  app.get("/commissions/rules", async (request) => {
    const query = request.query as { propertyId?: string };
    const propertyId = query.propertyId ?? request.userContext.propertyId;
    return listCommissionRules(propertyId);
  });

  app.post("/commissions/rules", async (request) => {
    // Finanzas (2026-09-16, fix t6#11): strict zod body (Spanish messages) —
    // `{ ratePct: "abc" }` used to reach decimal.js and answer 500. The
    // property is granted by the global hook (body.propertyId); a channelId
    // must belong to THAT property (opaque 404 otherwise, no existence oracle).
    const body = parse(CreateCommissionRuleSchema, requireObjectBody(request.body ?? {}), "body");
    if (body.channelId) {
      const { prisma } = await import("@hotelos/database");
      const channel = await prisma.channel.findUnique({ where: { id: body.channelId }, select: { propertyId: true } });
      if (!channel || channel.propertyId !== body.propertyId) throw new NotFoundError("Canal no encontrado.");
    }
    return createCommissionRule({
      propertyId: body.propertyId,
      channelId: body.channelId ?? null,
      channelCode: body.channelCode ?? null,
      ratePct: body.ratePct,
      appliesTo: body.appliesTo,
      ledgerAccountCode: body.ledgerAccountCode,
      effectiveFrom: body.effectiveFrom ?? null,
      effectiveTo: body.effectiveTo ?? null
    });
  });

  app.post("/commissions/rules/:id/deactivate", async (request) => {
    await assertEntityAccess(request, { entity: "commissionRule", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return deactivateCommissionRule(params.id);
  });

  app.get("/commissions/accruals", async (request) => {
    const query = request.query as {
      propertyId?: string;
      from?: string;
      to?: string;
      status?: string;
      channelId?: string;
    };
    const propertyId = query.propertyId ?? request.userContext.propertyId;
    return listCommissionAccruals({
      propertyId,
      from: query.from,
      to: query.to,
      status: query.status,
      channelId: query.channelId
    });
  });

  app.get("/commissions/summary", async (request) => {
    const query = request.query as { propertyId?: string; from?: string; to?: string };
    const propertyId = query.propertyId ?? request.userContext.propertyId;
    return commissionSummary(propertyId, query.from, query.to);
  });

  // Payroll bridge to gestoría (Sprint 23 — Track 5)
  // Finanzas (2026-09-16, fix t6#6): `?organizationId=<other org>` was taken
  // at face value on the two payroll lists (listContracts / listPeriods carry
  // no tenant context and the global hook only guards propertyId), so any
  // payroll.read holder read the salaries, IRPF rates and contracts of another
  // organization. resolveOrganizationScope answers the opaque 404 of
  // assertEntityAccess for a foreign organization and always returns the
  // caller's scope (a platform admin is re-pointed to the requested one); the
  // propertyId filter is granted by the global grantPropertyAccess hook like
  // every other route that reads `query.propertyId`.
  app.get("/payroll/contracts", async (request) => {
    const query = parse(PayrollListQuerySchema, request.query ?? {}, "query");
    const organizationId = await resolveOrganizationScope(request, query.organizationId);
    return listPayrollContracts(organizationId, query.propertyId);
  });

  const STAFF_PROFILE_NOT_FOUND = "Perfil de empleado no encontrado.";

  app.post("/payroll/contracts", async (request) => {
    // Finanzas (2026-09-16, fix t6#11): strict zod body (Spanish messages) —
    // `{ grossSalary: "abc" }` answered 500 and `{ staffProfileId: "nope" }`
    // stored an orphan contract. The employee profile must exist and hang
    // from a property the caller may act on (same opaque 404 for a missing
    // id, another organization or an unassigned property); when the body
    // names a propertyId it has to be the profile's own.
    const body = parse(CreatePayrollContractSchema, requireObjectBody(request.body ?? {}), "body");
    const { prisma } = await import("@hotelos/database");
    const staffProfile = await prisma.staffProfile.findUnique({
      where: { id: body.staffProfileId },
      select: { id: true, propertyId: true }
    });
    if (!staffProfile) throw new NotFoundError(STAFF_PROFILE_NOT_FOUND);
    await grantPropertyAccess(request, staffProfile.propertyId, STAFF_PROFILE_NOT_FOUND);
    if (body.propertyId !== undefined && body.propertyId !== staffProfile.propertyId) {
      const mismatch = new BadRequestError("propertyId no coincide con la propiedad del perfil de empleado.");
      mismatch.details = { code: "STAFF_PROFILE_PROPERTY_MISMATCH" };
      throw mismatch;
    }
    return createPayrollContract({
      context: request.userContext,
      staffProfileId: staffProfile.id,
      propertyId: body.propertyId ?? staffProfile.propertyId,
      contractType: body.contractType,
      startDate: body.startDate,
      endDate: body.endDate,
      grossSalary: decimalInputToNumber(body.grossSalary),
      payFrequency: body.payFrequency,
      payCount: body.payCount,
      irpfRatePct: body.irpfRatePct === undefined ? undefined : decimalInputToNumber(body.irpfRatePct),
      socialSecurityCategory: body.socialSecurityCategory,
      costCenterId: body.costCenterId,
      correlationId: createId("corr")
    });
  });

  app.post("/payroll/contracts/:id/deactivate", async (request) => {
    await assertEntityAccess(request, { entity: "employmentContract", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return deactivatePayrollContract({
      context: request.userContext,
      contractId: params.id,
      correlationId: createId("corr")
    });
  });

  app.get("/payroll/periods", async (request) => {
    // Finanzas (2026-09-16, fix t6#6): same tenant scope as GET /payroll/contracts.
    const query = parse(PayrollListQuerySchema, request.query ?? {}, "query");
    const organizationId = await resolveOrganizationScope(request, query.organizationId);
    return listPayrollPeriods(organizationId);
  });

  app.post("/payroll/periods", async (request) => {
    const body = request.body as { organizationId?: string; propertyId?: string; periodCode: string };
    const organizationId = await resolveOrganizationScope(request, body.organizationId);
    return createPayrollPeriod({
      context: request.userContext,
      organizationId,
      propertyId: body.propertyId,
      periodCode: body.periodCode,
      correlationId: createId("corr")
    });
  });

  app.post("/payroll/periods/:id/calculate", async (request) => {
    await assertEntityAccess(request, { entity: "payrollPeriod", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return calculatePayrollPeriod({
      context: request.userContext,
      periodId: params.id,
      correlationId: createId("corr")
    });
  });

  app.get("/payroll/periods/:id/slips", async (request) => {
    await assertEntityAccess(request, { entity: "payrollPeriod", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return listPayrollSlipsForPeriod(params.id);
  });

  app.get("/payroll/periods/:id/export", async (request) => {
    await assertEntityAccess(request, { entity: "payrollPeriod", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const query = request.query as { format?: string };
    // Finanzas (2026-09-16): read-only preview (markExported:false) of the a3 /
    // sage / csv export; POST /payroll/periods/:id/export (treasury.routes.ts)
    // is the audited export that stamps exportedAt.
    const result = await exportPeriod({
      context: request.userContext,
      periodId: params.id,
      format: normalisePayrollExportFormat(query.format),
      correlationId: createId("corr"),
      markExported: false
    });
    // The browser side downloads the text via Blob/URL.createObjectURL after
    // unwrapping `text`; we keep the HTTP body JSON so apiRequest works
    // unchanged across the codebase.
    return result;
  });

  // Exchange rates (Sprint 24 — Multi-currency)
  app.get("/finance/exchange-rates", async (request) => {
    const q = request.query as {
      base?: string;
      quote?: string;
      asOf?: string;
      organizationId?: string;
    };
    // `organizationId` is optional and may be the literal string "null"/"global"
    // when the caller wants to filter to platform-wide rows; treat anything
    // truthy as a tenant filter and an empty value as "no filter".
    // A specific organization must be the caller's own (or a platform admin's
    // re-pointed target): a query-string org can never widen a tenant's view.
    const orgFilter = q.organizationId === "global" || q.organizationId === "null"
      ? null
      : q.organizationId && q.organizationId.length > 0
        ? await resolveOrganizationScope(request, q.organizationId)
        : undefined;
    return listExchangeRates({
      base: q.base,
      quote: q.quote,
      asOf: q.asOf,
      organizationId: orgFilter
    });
  });

  app.post("/finance/exchange-rates", async (request) => {
    const body = (request.body ?? {}) as {
      baseCurrency: string;
      quoteCurrency: string;
      rate: number | string;
      effectiveDate: string;
      source?: string;
      organizationId?: string | null;
    };
    if (!body.baseCurrency || !body.quoteCurrency || body.rate === undefined || !body.effectiveDate) {
      throw new BadRequestError("baseCurrency, quoteCurrency, rate and effectiveDate are required.");
    }
    // Default scope to the caller's tenant unless they explicitly opt into
    // a platform-wide (organizationId=null) row.
    const orgScope = body.organizationId === null
      ? null
      : await resolveOrganizationScope(request, body.organizationId);
    return upsertExchangeRate({
      baseCurrency: body.baseCurrency,
      quoteCurrency: body.quoteCurrency,
      rate: body.rate,
      effectiveDate: body.effectiveDate,
      source: body.source ?? null,
      organizationId: orgScope
    });
  });

  // Operational dashboards (Sprint 14 — P0)
  app.get("/dashboards/housekeeping", async (request) => {
    const q = request.query as { propertyId?: string; date?: string };
    return buildHousekeepingDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, date: q.date });
  });
  app.get("/dashboards/front-desk", async (request) => {
    const q = request.query as { propertyId?: string; date?: string };
    return buildFrontDeskDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, date: q.date });
  });
  app.get("/dashboards/front-desk-queue", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildFrontDeskQueue({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/dashboards/room-rack", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildRoomRack({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/dashboards/housekeeping-mobile", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildHousekeepingMobile({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/dashboards/maintenance-mobile", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildMaintenanceMobile({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/dashboards/shift-manager", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildShiftManager({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/dashboards/general-manager", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildGmDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  // Pace de los próximos N días (default 30): OTB vs forecast vs LY por stay date.
  app.get("/general-manager/pace", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    const days = q.days ? Number.parseInt(q.days, 10) : 30;
    return buildGmPace({
      propertyId: q.propertyId ?? request.userContext.propertyId,
      days: Number.isFinite(days) ? days : 30
    });
  });
  app.get("/dashboards/operations-director", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildOperationsDirector({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/developer/api-reference", async () => buildApiReference());
  // Tanda 5 (L1b · api-side): GET /developer/keyboard-shortcuts retired — the
  // catalogue it served did not match the front (⌘/ reads the local list in
  // apps/admin-web/src/content/help-articles/keyboard-shortcuts.ts).
  app.get("/copilot/presets", async () => ({ items: COPILOT_PRESET_QUESTIONS }));
  app.post("/copilot/ask", async (request) => {
    const body = (request.body ?? {}) as { propertyId?: string; question?: string };
    // Corrector L6b (L6B-REV-04): el alias corre con el contexto REAL del usuario (sus claves y su memoria), no con
    // el actor sintético de lectura; el núcleo filtra el catálogo por RBAC como en POST /assistant/chat.
    return answerCopilot({
      propertyId: body.propertyId ?? request.userContext.propertyId,
      question: (body.question ?? "").trim(),
      context: request.userContext
    });
  });
  app.get("/dashboards/maintenance", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildMaintenanceDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, from: q.from, to: q.to });
  });
  app.get("/dashboards/finance-position", async (request) => {
    const q = request.query as { propertyId?: string; asOf?: string };
    return buildFinancePositionDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, asOf: q.asOf ? new Date(q.asOf) : undefined });
  });
  app.get("/dashboards/concierge", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildConciergeDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/reputation", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildReputationDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/sales-pipeline", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildSalesPipelineDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, from: q.from, to: q.to });
  });

  // Operational dashboards (Sprint 15 — P1.a)
  app.get("/dashboards/workforce", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildWorkforceDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, from: q.from, to: q.to });
  });
  app.get("/dashboards/crm", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildCrmDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/loyalty", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildLoyaltyDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/dashboards/upsells", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildUpsellsDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, from: q.from, to: q.to });
  });

  // Tanda 3 (CF-02) · Staff catalogue of upsell offers over Prisma UpsellOffer —
  // the same table the dashboard above aggregates. No advanced-module gate: the
  // catalogue is property data, the guest-facing purchase leg keeps its own.
  app.get("/properties/:propertyId/upsell-offers", async (request) => {
    const params = request.params as { propertyId: string };
    const { prisma } = await import("@hotelos/database");
    const rows = await prisma.upsellOffer.findMany({
      where: { propertyId: params.propertyId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    return rows.map(upsellOfferView);
  });

  app.post("/properties/:propertyId/upsell-offers", async (request, reply) => {
    const params = request.params as { propertyId: string };
    const body = parse(CreateUpsellOfferSchema, request.body);
    const { prisma } = await import("@hotelos/database");
    const row = await prisma.upsellOffer.create({
      data: {
        propertyId: params.propertyId,
        name: body.name,
        offerType: body.offerType,
        price: body.price ?? null,
        taxCategory: body.taxCategory ?? null,
        code: body.code ?? null,
        description: body.description ?? null,
        currency: body.currency ?? "EUR",
        channel: body.channel ?? null,
        imageUrl: body.imageUrl ?? null,
        active: body.active ?? true,
        availabilityRulesJson: (body.availabilityRulesJson ?? {}) as Prisma.InputJsonObject
      }
    });
    const view = upsellOfferView(row);
    recordAuditEvent({
      organizationId: request.userContext.organizationId,
      propertyId: params.propertyId,
      actorUserId: request.userContext.userId,
      actorType: "user",
      action: "UpsellOfferCreated",
      entityType: "upsell_offer",
      entityId: row.id,
      afterJson: view,
      correlationId: createId("corr")
    });
    // Tanda 3 (cierre): a created resource answers 201, like the other POST
    // catalogues; the body stays the same UpsellOfferRecord.
    reply.code(201);
    return view;
  });

  app.patch("/upsell-offers/:id", async (request) => {
    const params = request.params as { id: string };
    const propertyId = await assertPropertyEntityAccess(request, { entity: "upsellOffer", id: params.id });
    const body = parse(PatchUpsellOfferSchema, request.body);
    if (Object.keys(body).length === 0) {
      throw new BadRequestError("No hay cambios que aplicar a la oferta.");
    }
    const { prisma } = await import("@hotelos/database");
    const before = await prisma.upsellOffer.findUnique({ where: { id: params.id } });
    if (!before) throw new NotFoundError("Oferta de upsell no encontrada.");
    const row = await prisma.upsellOffer.update({
      where: { id: params.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.offerType !== undefined ? { offerType: body.offerType } : {}),
        ...(body.price !== undefined ? { price: body.price } : {}),
        ...(body.taxCategory !== undefined ? { taxCategory: body.taxCategory } : {}),
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        ...(body.channel !== undefined ? { channel: body.channel } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.availabilityRulesJson !== undefined
          ? { availabilityRulesJson: body.availabilityRulesJson as Prisma.InputJsonObject }
          : {})
      }
    });
    const view = upsellOfferView(row);
    recordAuditEvent({
      organizationId: request.userContext.organizationId,
      propertyId,
      actorUserId: request.userContext.userId,
      actorType: "user",
      action: "UpsellOfferUpdated",
      entityType: "upsell_offer",
      entityId: row.id,
      beforeJson: upsellOfferView(before),
      afterJson: view,
      correlationId: createId("corr")
    });
    return view;
  });
  app.get("/dashboards/surveys", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildSurveysDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/quality", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildQualityDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });

  // Operational dashboards (Sprint 16 — P1.b + P2.a)
  app.get("/dashboards/safety", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildSafetyDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/inventory", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildInventoryDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/dashboards/procurement", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildProcurementDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined });
  });
  app.get("/dashboards/groups-events", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildGroupsEventsDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, from: q.from, to: q.to });
  });
  app.get("/dashboards/pos", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildPosDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined });
  });
  app.get("/dashboards/channel-performance", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildChannelPerformanceDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });

  // SiteMinder-style channel manager / OTA aggregator (Sprint 28)
  app.get("/channel-manager/channels", async (request) => {
    const q = request.query as { propertyId?: string; active?: string };
    return {
      channels: await listChannelManagerChannels({
        propertyId: q.propertyId ?? request.userContext.propertyId,
        active: q.active === undefined ? undefined : q.active === "true"
      })
    };
  });
  app.post("/channel-manager/channels/:channelId/ingest", async (request) => {
    await assertEntityAccess(request, { entity: "channel", id: (request.params as { channelId: string }).channelId });
    const params = request.params as { channelId: string };
    const body = (request.body ?? {}) as { since?: string };
    return ingestChannelReservations({
      channelId: params.channelId,
      since: body.since ? new Date(body.since) : undefined
    });
  });
  app.post("/channel-manager/push-rates", async (request) => {
    const body = (request.body ?? {}) as {
      propertyId?: string;
      from: string;
      to: string;
      ratePlanIds?: string[];
      channelIds?: string[];
    };
    if (!body.from || !body.to) throw new BadRequestError("from and to are required.");
    return channelPushRates({
      propertyId: body.propertyId ?? request.userContext.propertyId,
      dateRange: { from: body.from, to: body.to },
      ratePlanIds: body.ratePlanIds,
      channelIds: body.channelIds
    });
  });
  app.post("/channel-manager/push-availability", async (request) => {
    const body = (request.body ?? {}) as {
      propertyId?: string;
      from: string;
      to: string;
      roomTypeIds?: string[];
      channelIds?: string[];
    };
    if (!body.from || !body.to) throw new BadRequestError("from and to are required.");
    return channelPushAvailability({
      propertyId: body.propertyId ?? request.userContext.propertyId,
      dateRange: { from: body.from, to: body.to },
      roomTypeIds: body.roomTypeIds,
      channelIds: body.channelIds
    });
  });
  app.post("/channel-manager/push-restrictions", async (request) => {
    const body = (request.body ?? {}) as {
      propertyId?: string;
      from: string;
      to: string;
      channelIds?: string[];
    };
    if (!body.from || !body.to) throw new BadRequestError("from and to are required.");
    return channelPushRestrictions({
      propertyId: body.propertyId ?? request.userContext.propertyId,
      dateRange: { from: body.from, to: body.to },
      channelIds: body.channelIds
    });
  });
  app.post("/channel-manager/ingest-all", async (request) => {
    const body = (request.body ?? {}) as { propertyId?: string; since?: string };
    return ingestAllChannelReservations({
      propertyId: body.propertyId ?? request.userContext.propertyId,
      since: body.since ? new Date(body.since) : undefined
    });
  });
  app.get("/channel-manager/sync-jobs", async (request) => {
    const q = request.query as {
      propertyId?: string;
      channelId?: string;
      jobType?: string;
      since?: string;
    };
    return {
      jobs: await listChannelSyncJobs({
        propertyId: q.propertyId ?? request.userContext.propertyId,
        channelId: q.channelId,
        jobType: q.jobType,
        since: q.since ? new Date(q.since) : undefined
      })
    };
  });
  app.post("/channel-manager/parity/check", async (request) => {
    const body = (request.body ?? {}) as {
      propertyId?: string;
      from: string;
      to: string;
      thresholdPercent?: number;
    };
    if (!body.from || !body.to) throw new BadRequestError("from and to are required.");
    return runChannelParityMonitor({
      propertyId: body.propertyId ?? request.userContext.propertyId,
      dateRange: { from: body.from, to: body.to },
      thresholdPercent: body.thresholdPercent
    });
  });
  app.get("/channel-manager/parity/alerts", async (request) => {
    const q = request.query as { propertyId?: string; status?: string; severity?: string };
    return {
      alerts: await listChannelParityAlerts({
        propertyId: q.propertyId ?? request.userContext.propertyId,
        status: q.status,
        severity: q.severity
      })
    };
  });
  app.post("/channel-manager/parity/alerts/:id/resolve", async (request) => {
    await assertEntityAccess(request, { entity: "rateParityAlert", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return resolveChannelParityAlert(params.id, request.userContext?.userId ?? "user_demo");
  });

  // Operational dashboards (Sprint 17 — P2.b)
  app.get("/dashboards/energy", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildEnergyDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/sustainability", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildSustainabilityDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/assets", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildAssetsDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId });
  });
  app.get("/dashboards/room-profitability", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildRoomProfitabilityDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, from: q.from, to: q.to });
  });
  app.get("/dashboards/analytics-center", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildAnalyticsCenterDashboard({ propertyId: q.propertyId ?? request.userContext.propertyId, days: q.days ? Number(q.days) : undefined });
  });

  // Portfolio dashboard (Sprint 38 — multi-property org-level consolidation)
  app.get("/dashboards/portfolio", async (request) => {
    const q = request.query as { organizationId?: string; asOf?: string };
    const organizationId = await resolveOrganizationScope(request, q.organizationId);
    return buildPortfolioDashboard({ organizationId, asOf: q.asOf });
  });

  // Property overview drill-down (Sprint 41 — single-property detail screen)
  app.get("/dashboards/property-overview", async (request) => {
    const q = request.query as { propertyId?: string; asOf?: string };
    return buildPropertyOverview({ propertyId: q.propertyId ?? request.userContext.propertyId, asOf: q.asOf });
  });

  // Notification engine (Sprint 26 — Track: Notifications + document templates)
  app.get("/notifications/templates", async (request) => {
    const q = request.query as { organizationId?: string; propertyId?: string; channel?: string };
    const organizationId = await resolveOrganizationScope(request, q.organizationId);
    return listNotificationTemplates(organizationId, q.propertyId, q.channel);
  });

  app.post("/notifications/templates", async (request) => {
    const body = (request.body ?? {}) as {
      organizationId?: string;
      propertyId?: string | null;
      code: string;
      channel: string;
      language?: string;
      subject?: string | null;
      body: string;
      variablesJson?: unknown;
      active?: boolean;
    };
    if (!body.code || !body.channel || !body.body) {
      throw new BadRequestError("code, channel and body are required.");
    }
    return createNotificationTemplate({
      organizationId: await resolveOrganizationScope(request, body.organizationId),
      propertyId: body.propertyId,
      code: body.code,
      channel: body.channel,
      language: body.language,
      subject: body.subject,
      body: body.body,
      variablesJson: body.variablesJson,
      active: body.active
    });
  });

  app.post("/notifications/templates/:id/deactivate", async (request) => {
    await assertEntityAccess(request, { entity: "notificationTemplate", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return deactivateNotificationTemplate(params.id);
  });

  app.get("/notifications/deliveries", async (request) => {
    const q = request.query as {
      organizationId?: string;
      propertyId?: string;
      status?: string;
      channel?: string;
      days?: string;
      limit?: string;
    };
    const organizationId = await resolveOrganizationScope(request, q.organizationId);
    const rows = await listNotificationDeliveries({
      organizationId,
      propertyId: q.propertyId,
      status: q.status,
      channel: q.channel,
      days: q.days ? Number(q.days) : undefined,
      limit: q.limit ? Number(q.limit) : undefined
    });
    // Corrector Tanda CHK (SEC-1): el cuerpo renderizado y las variables solo para quien gestiona
    // notificaciones; el resto de usuarios autenticados ve la lista sin payloadJson ni bodyRendered.
    if (request.userContext.permissions.includes("notifications.manage") || request.userContext.isPlatformAdmin === true) return rows;
    return rows.map((row) => ({ ...row, bodyRendered: null, payloadJson: null }));
  });

  app.post("/notifications/deliveries/:id/retry", async (request) => {
    await assertEntityAccess(request, { entity: "notificationDelivery", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return retryNotificationDelivery(params.id);
  });

  app.post("/notifications/dispatch", async (request) => {
    const body = (request.body ?? {}) as {
      organizationId?: string;
      propertyId?: string;
      templateCode: string;
      channel: string;
      recipient: string;
      variables?: Record<string, unknown>;
      scheduledFor?: string;
      language?: string;
    };
    if (!body.templateCode || !body.channel || !body.recipient) {
      throw new BadRequestError("templateCode, channel and recipient are required.");
    }
    return dispatchNotification({
      organizationId: await resolveOrganizationScope(request, body.organizationId),
      propertyId: body.propertyId,
      templateCode: body.templateCode,
      channel: body.channel,
      recipient: body.recipient,
      variables: body.variables ?? {},
      scheduledFor: body.scheduledFor,
      language: body.language
    });
  });

  // Tanda 3 (CFG-P1-6): outbound email mode (real / simulated / disabled) so the
  // invitation screens can show a copyable link instead of a fake "sent".
  app.get("/notifications/email-status", async () => emailStatus());

  app.get("/notifications/template-stats", async (request) => {
    const q = request.query as { organizationId?: string; propertyId?: string; days?: string };
    const organizationId = await resolveOrganizationScope(request, q.organizationId);
    return notificationTemplateStats({
      organizationId,
      propertyId: q.propertyId,
      days: q.days ? Number(q.days) : undefined
    });
  });

  // ---- Sprint 50 — AI Human Review Queue (HITL) ----
  app.get("/ai-operations/review/queue", async (request) => {
    const q = request.query as {
      organizationId?: string;
      status?: string;
      reviewType?: string;
      assignedTo?: string;
    };
    return listHumanReviewQueue({
      organizationId: await resolveOrganizationScope(request, q.organizationId),
      status: q.status as HumanReviewStatus | undefined,
      reviewType: q.reviewType,
      assignedTo: q.assignedTo
    });
  });

  app.get("/ai-operations/review/stats", async (request) => {
    const q = request.query as { organizationId?: string };
    return humanReviewQueueStats({
      organizationId: await resolveOrganizationScope(request, q.organizationId)
    });
  });

  app.get("/ai-operations/review/:id", async (request) => {
    await assertEntityAccess(request, { entity: "aiHumanReviewItem", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return getHumanReviewItem(params.id);
  });

  app.post("/ai-operations/review/:id/assign", async (request) => {
    await assertEntityAccess(request, { entity: "aiHumanReviewItem", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { userId?: string };
    if (!body.userId) throw new BadRequestError("userId is required.");
    return assignHumanReview({
      context: request.userContext,
      id: params.id,
      userId: body.userId,
      correlationId: request.headers[OBSERVABILITY_HEADERS.correlationId] as string | undefined
    });
  });

  app.post("/ai-operations/review/:id/approve", async (request) => {
    await assertEntityAccess(request, { entity: "aiHumanReviewItem", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { notes?: string };
    return approveHumanReview({
      context: request.userContext,
      id: params.id,
      notes: body.notes,
      correlationId: request.headers[OBSERVABILITY_HEADERS.correlationId] as string | undefined
    });
  });

  app.post("/ai-operations/review/:id/reject", async (request) => {
    await assertEntityAccess(request, { entity: "aiHumanReviewItem", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string };
    if (!body.reason) throw new BadRequestError("reason is required.");
    return rejectHumanReview({
      context: request.userContext,
      id: params.id,
      reason: body.reason,
      correlationId: request.headers[OBSERVABILITY_HEADERS.correlationId] as string | undefined
    });
  });

  app.post("/ai-operations/review/:id/escalate", async (request) => {
    await assertEntityAccess(request, { entity: "aiHumanReviewItem", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { toRole?: string };
    return escalateHumanReview({
      context: request.userContext,
      id: params.id,
      toRole: body.toRole,
      correlationId: request.headers[OBSERVABILITY_HEADERS.correlationId] as string | undefined
    });
  });

  app.post("/ai-operations/review/enqueue", async (request) => {
    const body = (request.body ?? {}) as {
      organizationId?: string;
      propertyId?: string;
      reviewType?: string;
      relatedEntityType?: string;
      relatedEntityId?: string;
      payloadJson?: Record<string, unknown>;
    };
    if (!body.reviewType) throw new BadRequestError("reviewType is required.");
    return enqueueHumanReview({
      organizationId: await resolveOrganizationScope(request, body.organizationId),
      propertyId: body.propertyId,
      reviewType: body.reviewType,
      relatedEntityType: body.relatedEntityType,
      relatedEntityId: body.relatedEntityId,
      payloadJson: body.payloadJson,
      actorUserId: request.userContext.userId,
      correlationId: request.headers[OBSERVABILITY_HEADERS.correlationId] as string | undefined
    });
  });

  // ===================================================================================
  // Sprint 49 — AI Governance (prefix: /ai-operations/governance)
  // Policies + prompt versioning + evaluations + incidents + cost dashboard.
  // ===================================================================================

  // Policies
  app.get("/ai-operations/governance/policies", async (request) => {
    const q = request.query as { organizationId?: string; propertyId?: string };
    return govListPolicies({
      organizationId: await resolveOrganizationScope(request, q.organizationId),
      propertyId: q.propertyId
    });
  });

  app.post("/ai-operations/governance/policies", async (request) => {
    const body = request.body as {
      organizationId?: string;
      propertyId?: string;
      policyCode: string;
      name?: string;
      configuration?: Record<string, unknown>;
      active?: boolean;
    };
    return govUpsertPolicy({
      organizationId: await resolveOrganizationScope(request, body.organizationId),
      propertyId: body.propertyId,
      policyCode: body.policyCode,
      name: body.name,
      configuration: body.configuration,
      active: body.active
    });
  });

  app.post("/ai-operations/governance/policies/:id/active", async (request) => {
    await assertEntityAccess(request, { entity: "aiPolicy", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as { active?: boolean };
    return govSetPolicyActive(params.id, body.active ?? true);
  });

  // Prompts
  app.get("/ai-operations/governance/prompts", async (request) => govListPrompts());

  app.get("/ai-operations/governance/prompts/:promptCode/versions", async (request) => {
    const params = request.params as { promptCode: string };
    return govGetPromptVersions(params.promptCode);
  });

  app.post("/ai-operations/governance/prompts/versions", async (request) => {
    const body = request.body as { promptCode: string; content: string; notes?: string; createdBy?: string };
    return govCreatePromptVersion({
      promptCode: body.promptCode,
      content: body.content,
      notes: body.notes,
      createdBy: body.createdBy ?? request.userContext.userId
    });
  });

  // Prompt versions are PLATFORM-GLOBAL rows: `ai_prompt_versions` carries no
  // organization/property column, so publishing or archiving one changes the
  // prompt EVERY tenant runs. There is no tenant to scope to; instead the two
  // mutations are gated to platform admins (real `admin.tenants.manage` role,
  // carried as `userContext.isPlatformAdmin`) — a tenant user with
  // `ai_prompts.manage` may still list, diff and propose versions.
  async function requirePlatformAdmin(
    request: { userContext: UserContext },
    message = "Solo un administrador de plataforma puede publicar o archivar versiones de prompt."
  ): Promise<void> {
    if (!(await isPlatformAdmin(request.userContext))) {
      throw new ForbiddenError(message);
    }
  }

  app.post("/ai-operations/governance/prompts/versions/:id/publish", async (request) => {
    await requirePlatformAdmin(request);
    const params = request.params as { id: string };
    return govPublishPromptVersion(params.id);
  });

  app.post("/ai-operations/governance/prompts/versions/:id/archive", async (request) => {
    await requirePlatformAdmin(request);
    const params = request.params as { id: string };
    return govArchivePromptVersion(params.id);
  });

  app.get("/ai-operations/governance/prompts/diff", async (request) => {
    const q = request.query as { a?: string; b?: string };
    if (!q.a || !q.b) throw new BadRequestError("Query params a and b are required.");
    return govDiffPromptVersions(q.a, q.b);
  });

  // Evaluations
  app.get("/ai-operations/governance/evaluations", async (request) => {
    const q = request.query as { organizationId?: string; status?: string };
    return govListEvaluations({
      organizationId: await resolveOrganizationScope(request, q.organizationId),
      status: q.status
    });
  });

  app.post("/ai-operations/governance/evaluations", async (request) => {
    const body = request.body as {
      organizationId?: string;
      propertyId?: string;
      evaluationName: string;
      evaluationType: string;
      promptCode?: string;
    };
    return govCreateEvaluation({
      organizationId: await resolveOrganizationScope(request, body.organizationId),
      propertyId: body.propertyId,
      evaluationName: body.evaluationName,
      evaluationType: body.evaluationType,
      promptCode: body.promptCode
    });
  });

  app.post("/ai-operations/governance/evaluations/:id/run", async (request) => {
    await assertEntityAccess(request, { entity: "aiEvaluation", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return govRunEvaluation(params.id);
  });

  // Incidents
  app.get("/ai-operations/governance/incidents", async (request) => {
    const q = request.query as { organizationId?: string; status?: string; severity?: string };
    return govListIncidents({
      organizationId: await resolveOrganizationScope(request, q.organizationId),
      status: q.status,
      severity: q.severity
    });
  });

  app.post("/ai-operations/governance/incidents", async (request) => {
    const body = request.body as {
      organizationId?: string;
      propertyId?: string;
      incidentType: string;
      severity: string;
      title: string;
      description?: string;
      relatedAiToolCallId?: string;
      assignedTo?: string;
    };
    return govCreateIncident({
      organizationId: await resolveOrganizationScope(request, body.organizationId),
      propertyId: body.propertyId,
      incidentType: body.incidentType,
      severity: body.severity,
      title: body.title,
      description: body.description,
      relatedAiToolCallId: body.relatedAiToolCallId,
      assignedTo: body.assignedTo
    });
  });

  app.post("/ai-operations/governance/incidents/:id/assign", async (request) => {
    await assertEntityAccess(request, { entity: "aiIncident", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as { userId?: string };
    return govAssignIncident(params.id, body.userId ?? request.userContext.userId);
  });

  app.post("/ai-operations/governance/incidents/:id/resolve", async (request) => {
    await assertEntityAccess(request, { entity: "aiIncident", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    const body = request.body as { rootCause?: string; resolutionNotes?: string };
    return govResolveIncident(params.id, body.rootCause ?? "", body.resolutionNotes ?? "");
  });

  app.post("/ai-operations/governance/incidents/:id/reopen", async (request) => {
    await assertEntityAccess(request, { entity: "aiIncident", id: (request.params as { id: string }).id });
    const params = request.params as { id: string };
    return govReopenIncident(params.id);
  });

  // Cost
  app.get("/ai-operations/governance/cost", async (request) => {
    const q = request.query as { organizationId?: string; days?: string };
    return govCostDashboard({
      organizationId: await resolveOrganizationScope(request, q.organizationId),
      days: q.days ? Number(q.days) : undefined
    });
  });

  // Stored cards (finanzas 2026-09-15): this endpoint ONLY stores a token
  // issued by the PSP's PCI-compliant front-end SDK (Stripe Elements pm_… /
  // Redsys DS_MERCHANT_IDENTIFIER). A PAN — in any field — is refused with 400
  // PAN_NOT_ACCEPTED: card numbers never reach this API. Nothing is
  // synthesised: without a configured PSP the token cannot be validated and
  // the request answers 409 PSP_NOT_CONFIGURED. The Prisma client extension
  // encrypts `tokenRef` at rest via PII_FIELDS — see crypto-fields.ts.
  app.post("/payment-tokens", async (request, reply) => {
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const looksLikePan = (value: unknown): boolean => typeof value === "string" && /^[0-9 -]{12,23}$/.test(value.trim()) && value.replace(/\D/g, "").length >= 12;
    const cardData = (raw.cardData ?? {}) as Record<string, unknown>;
    if (looksLikePan(raw.pan) || looksLikePan(cardData.pan) || looksLikePan(raw.token) || looksLikePan(cardData.token)) {
      const error = new BadRequestError("Este API no acepta números de tarjeta (PAN): tokeniza la tarjeta en el navegador con el SDK del PSP (Stripe Elements / Redsys) y envía solo el token.");
      error.details = { code: "PAN_NOT_ACCEPTED" };
      throw error;
    }
    if (raw.cardData && typeof raw.cardData === "object" && !("token" in raw)) {
      throw new BadRequestError("Envía { provider, token, last4?, brand? }: cardData ya no se admite (solo tokens emitidos por el PSP).");
    }
    const body = parse(PaymentTokenSchema, raw);
    const propertyId = request.userContext.propertyId;
    const psp = await pspStatusFor(propertyId);
    if (!psp.configured || psp.provider !== body.provider) {
      const error = new ConflictError(`No se puede guardar un token de ${body.provider}: ${psp.message}`);
      error.details = { code: "PSP_NOT_CONFIGURED", provider: body.provider, psp };
      throw error;
    }
    if (body.provider === "stripe" && !/^pm_[A-Za-z0-9]+$/.test(body.token)) {
      throw new BadRequestError("Para Stripe el token debe ser un PaymentMethod (pm_…) emitido por Stripe Elements.");
    }
    const { prisma } = await import("@hotelos/database");
    const created = await prisma.paymentToken.create({
      data: {
        organizationId: request.userContext.organizationId,
        guestId: body.guestId,
        provider: body.provider,
        tokenRef: body.token,
        last4: body.last4 ?? null,
        brand: body.brand ?? null,
        expiryMonth: body.expiryMonth ?? null,
        expiryYear: body.expiryYear ?? null,
        isDefault: body.isDefault ?? false
      }
    });
    reply.code(201);
    return { id: created.id, provider: created.provider, last4: created.last4, brand: created.brand, expiryMonth: created.expiryMonth, expiryYear: created.expiryYear };
  });

  // List sealed audit events for the current organization, with server-side
  // filters and pagination. Reads from Postgres (the durable mirror of the
  // in-memory chain) so callers can page through long histories without
  // shipping the entire chain on the wire.
  //
  // Query params (all optional):
  //   - from, to          ISO date (YYYY-MM-DD) — inclusive range on createdAt
  //   - actor             actorUserId equality filter
  //   - action            action equality filter
  //   - entityType        entityType equality filter
  //   - q                 free-text contains match over entityId/correlationId
  //   - limit, offset     pagination (limit clamped to 1..500, default 100)
  //
  // Response: { items, total, limit, offset }. The chain-tip sentinel inserted
  // by hydrateAuditChainFromPostgres lives in the in-memory ring only — the
  // Postgres mirror never stores it, so callers see real events only.
  app.get("/audit-events", async (request) => {
    const query = (request.query ?? {}) as {
      from?: string;
      to?: string;
      actor?: string;
      action?: string;
      entityType?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(500, Math.max(1, query.limit ? Number(query.limit) : 100));
    const offset = Math.max(0, query.offset ? Number(query.offset) : 0);

    const where: Record<string, unknown> = {
      organizationId: request.userContext.organizationId
    };
    if (query.action) where.action = query.action;
    if (query.entityType) where.entityType = query.entityType;
    if (query.actor) where.actorUserId = query.actor;

    if (query.from || query.to) {
      const range: { gte?: Date; lte?: Date } = {};
      if (query.from) {
        const d = new Date(`${query.from}T00:00:00.000Z`);
        if (!Number.isNaN(d.getTime())) range.gte = d;
      }
      if (query.to) {
        const d = new Date(`${query.to}T23:59:59.999Z`);
        if (!Number.isNaN(d.getTime())) range.lte = d;
      }
      if (range.gte || range.lte) where.createdAt = range;
    }

    if (query.q && query.q.trim()) {
      const term = query.q.trim();
      where.OR = [
        { entityId: { contains: term, mode: "insensitive" } },
        { correlationId: { contains: term, mode: "insensitive" } }
      ];
    }

    const { prisma: db } = await import("@hotelos/database");
    const [rows, total] = await Promise.all([
      db.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit
      }),
      db.auditEvent.count({ where })
    ]);

    // Project Prisma rows back to the shared AuditEvent shape (ISO date string,
    // optional fields normalised to undefined).
    const items = rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      propertyId: row.propertyId ?? undefined,
      actorUserId: row.actorUserId ?? undefined,
      actorType: row.actorType,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId ?? undefined,
      beforeJson: row.beforeJson ?? undefined,
      afterJson: row.afterJson ?? undefined,
      ipAddress: row.ipAddress ?? undefined,
      deviceId: row.deviceId ?? undefined,
      correlationId: row.correlationId ?? undefined,
      hashAlgorithm: row.hashAlgorithm as "sha256",
      previousHash: row.previousHash ?? undefined,
      currentHash: row.currentHash,
      createdAt: row.createdAt.toISOString()
    }));

    return { items, total, limit, offset };
  });

  // Distinct values for filter dropdowns. Cheap because the AuditEvent table
  // has covering indexes on (organizationId, propertyId, createdAt) and
  // (entityType, entityId, createdAt) — the groupBy planner can satisfy these
  // index-only.
  app.get("/audit-events/facets", async (request) => {
    const { prisma: db } = await import("@hotelos/database");
    const orgId = request.userContext.organizationId;
    const [actionRows, entityRows, actorRows] = await Promise.all([
      db.auditEvent.groupBy({ by: ["action"], where: { organizationId: orgId }, orderBy: { action: "asc" } }),
      db.auditEvent.groupBy({ by: ["entityType"], where: { organizationId: orgId }, orderBy: { entityType: "asc" } }),
      db.auditEvent.groupBy({
        by: ["actorUserId"],
        where: { organizationId: orgId, actorUserId: { not: null } },
        orderBy: { actorUserId: "asc" }
      })
    ]);
    return {
      actions: actionRows.map((r) => r.action),
      entityTypes: entityRows.map((r) => r.entityType),
      actors: actorRows.map((r) => r.actorUserId).filter((v): v is string => Boolean(v))
    };
  });

  app.get("/audit-events/integrity", async (request) => verifyAuditIntegrity());

  // Tanda L2 (L2-02): the event and AI tool-call feeds read the Prisma tables
  // (event_stream, ai_tool_calls) instead of the in-memory mirrors, with the
  // shared cursor pagination (bare array by default, `{ items, nextCursor,
  // total }` with ?cursor= / ?envelope=1, X-Total-Count / X-Next-Cursor
  // always; keyset createdAt desc + id). Scope: the caller's organization and,
  // with ?propertyId=, that property after the tenant guard (foreign / out of
  // scope → opaque 404); without it, the properties the caller is assigned to
  // (organization-wide assignments and platform admins see every property).
  // The integrity checks stay global by design — they verify the whole chain.
  type MirrorScope = { organizationId: string; propertyId: string | null; propertyIds: string[] | null };
  const mirrorScope = async (request: { userContext: UserContext; query?: unknown }): Promise<MirrorScope> => {
    const query = (request.query ?? {}) as { propertyId?: unknown };
    if (query.propertyId !== undefined && (typeof query.propertyId !== "string" || query.propertyId.length === 0)) {
      throw new BadRequestError("El parámetro propertyId no es válido.");
    }
    if (typeof query.propertyId === "string") {
      await grantPropertyAccess(request, query.propertyId);
      return { organizationId: request.userContext.organizationId, propertyId: query.propertyId, propertyIds: null };
    }
    const context = request.userContext;
    const organizationWide = context.assignedPropertyIds === undefined || context.orgScope === true || (await isPlatformAdmin(context));
    if (organizationWide) return { organizationId: context.organizationId, propertyId: null, propertyIds: null };
    const propertyIds = (context.assignedPropertyIds ?? []).filter((propertyId) => isPropertyAssigned(context, propertyId));
    return { organizationId: context.organizationId, propertyId: null, propertyIds };
  };
  const cursorDate = (cursor: { k: string; id: string } | null): Date | null => {
    if (!cursor) return null;
    const value = new Date(cursor.k);
    if (Number.isNaN(value.getTime())) throw new BadRequestError("El cursor de paginación no es válido.");
    return value;
  };

  app.get("/events", async (request, reply) => {
    const page = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const scope = await mirrorScope(request);
    const cursor = decodeCursor(page.cursor);
    const after = cursorDate(cursor);
    const { prisma } = await import("@hotelos/database");
    const where: Prisma.EventStreamWhereInput = {
      organizationId: scope.organizationId,
      ...(scope.propertyId ? { propertyId: scope.propertyId } : scope.propertyIds ? { propertyId: { in: scope.propertyIds } } : {})
    };
    const [rows, total] = await Promise.all([
      prisma.eventStream.findMany({
        where: { ...where, ...(after && cursor ? { OR: [{ createdAt: { lt: after } }, { createdAt: after, eventId: { lt: cursor.id } }] } : {}) },
        orderBy: [{ createdAt: "desc" }, { eventId: "desc" }],
        take: page.limit + 1
      }),
      prisma.eventStream.count({ where })
    ]);
    // EventStream keys on `eventId`; `id` is exposed as an alias so generic
    // consumers (and buildPage) can treat the feed like every other list.
    const result = buildPage(rows.map((row) => ({ id: row.eventId, ...row })), page.limit, total, (row) => row.createdAt.toISOString());
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });
  app.get("/events/integrity", async (request) => verifyDomainEventIntegrity());
  app.get("/ai/tool-calls", async (request, reply) => {
    const page = parsePageQuery(request.query as Record<string, unknown>, { limit: 100, max: 500 });
    const scope = await mirrorScope(request);
    const cursor = decodeCursor(page.cursor);
    const after = cursorDate(cursor);
    const { prisma } = await import("@hotelos/database");
    const where: Prisma.AiToolCallWhereInput = {
      organizationId: scope.organizationId,
      ...(scope.propertyId ? { propertyId: scope.propertyId } : scope.propertyIds ? { propertyId: { in: scope.propertyIds } } : {})
    };
    const [rows, total] = await Promise.all([
      prisma.aiToolCall.findMany({
        where: { ...where, ...(after && cursor ? { OR: [{ createdAt: { lt: after } }, { createdAt: after, id: { lt: cursor.id } }] } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: page.limit + 1
      }),
      prisma.aiToolCall.count({ where })
    ]);
    const result = buildPage(rows, page.limit, total, (row) => row.createdAt.toISOString());
    reply.headers(pageHeaders(result));
    return pageBody(result, page);
  });

  // Tanda L6a: decisión humana sobre una llamada de herramienta awaiting_confirmation (tool runner).
  app.post("/ai/tool-calls/:id/confirm", async (request) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "aiToolCallConfirmation", id });
    const body = (request.body ?? {}) as { decision?: "approve" | "reject"; notes?: string };
    if (body.decision !== "approve" && body.decision !== "reject") throw new BadRequestError("decision debe ser approve | reject.");
    return confirmToolCall({ context: request.userContext, toolCallId: id, decision: body.decision, ...(body.notes !== undefined ? { notes: body.notes } : {}), correlationId: createId("corr") });
  });

  // Tanda L2 (L2-02): durable worker runs (worker_job_runs · L2-01 / L2-07) as
  // the source of the future jobs screen of the platform console. Platform
  // only: `admin.tenants.manage` in the manifest AND requirePlatformAdmin (the
  // rows span every tenant, so a tenant admin never lists them). Optional
  // jobName / status filters, newest first, limit ≤ 200 (strict query).
  const WorkerJobRunsQuerySchema = z
    .object({
      jobName: z.string().trim().min(1).max(200).optional(),
      status: z.string().trim().min(1).max(50).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional()
    })
    .strict();
  app.get("/admin/worker/job-runs", async (request, reply) => {
    await requirePlatformAdmin(request, "Solo un administrador de plataforma puede consultar las ejecuciones del worker.");
    const query = parse(WorkerJobRunsQuerySchema, request.query ?? {}, "query");
    const { prisma } = await import("@hotelos/database");
    const where: Prisma.WorkerJobRunWhereInput = {
      ...(query.jobName ? { jobName: query.jobName } : {}),
      ...(query.status ? { status: query.status } : {})
    };
    const limit = query.limit ?? 50;
    const [items, total] = await Promise.all([
      prisma.workerJobRun.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
      prisma.workerJobRun.count({ where })
    ]);
    reply.headers(pageHeaders({ items, total, nextCursor: null }));
    return { items, total, limit };
  });

  return app;
}

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  // SECURITY (audit 2026-06): abort boot in production if the PII encryption key
  // is missing/invalid — never run with guest DNIs stored in plaintext.
  const { assertEncryptionKeyForProduction } = await import("@hotelos/database");
  assertEncryptionKeyForProduction();
  // Tanda 1 · fail-closed tenant bootstrap: the permission catalog must match
  // PERMISSIONS, template-named roles must carry their grants and the in-memory
  // tenant mirrors must hold every Prisma property BEFORE the first request. A
  // failure here aborts the boot (a half-provisioned tenant would answer 403 or
  // 500 to real users). TENANT_BOOTSTRAP_SKIP=true bypasses it (tests only).
  // Tanda 4 · cierre: hydrate the audit/event chain tips BEFORE the tenant
  // bootstrap. syncPermissionCatalog / backfillTemplateRoles record audit
  // events, and sealing them on an empty in-memory ring started a NEW genesis
  // row on every boot (9 genesis rows in the demo after a day of restarts);
  // hydrateAuditChainFromPostgres is a no-op once the ring holds anything, so
  // it has to be the first writer-adjacent step of the process.
  const tips = await hydrateAuditChainFromPostgres();
  console.log(`[audit] hydrated chain tips: audit=${tips.auditTail?.slice(0, 12) ?? "<empty>"} event=${tips.eventTail?.slice(0, 12) ?? "<empty>"}`);
  if (process.env.TENANT_BOOTSTRAP_SKIP === "true") {
    console.warn("[tenants] bootstrap skipped (TENANT_BOOTSTRAP_SKIP=true)");
  } else {
    try {
      const { syncPermissionCatalog, backfillTemplateRoles } = await import("./lib/rbac-catalog.js");
      const { hydrateTenantMirrors } = await import("./lib/tenant-hydration.js");
      const catalog = await syncPermissionCatalog();
      console.log(
        `[rbac] permission catalog synced: created=${catalog.created} updated=${catalog.updated} stale=${catalog.stale.length}`
      );
      const backfill = await backfillTemplateRoles();
      console.log(
        `[rbac] template roles backfilled: ${backfill.rolesFilled}${backfill.roles.length > 0 ? ` (${backfill.roles.join(", ")})` : ""}`
      );
      const mirrors = await hydrateTenantMirrors();
      console.log(
        `[tenants] mirrors hydrated: properties=${mirrors.properties} organizations=${mirrors.organizations} modules=${mirrors.modules}`
      );
    } catch (error) {
      console.error(
        "[tenants] bootstrap failed — aborting start (fail-closed; TENANT_BOOTSTRAP_SKIP=true only for tests):",
        error
      );
      process.exit(1);
    }
  }
  const app = await buildApiServer();
  // IA de reputación (Tanda T8 · §13): con proveedor configurado el puerto pasa por ai-core (redactPii/restorePii y presupuesto por organización); sin clave sigue RulesReputationAi con etiquetas honestas dictionary/rules. Solo en el proceso que escucha: los tests que usan buildApiServer no lo activan.
  if (isLlmConfigured()) setReputationAiPort(createAiCoreReputationPort());
  // IA de documentos (Tanda T9 · §5): con proveedor configurado el puerto pasa por ai-core (extractFromDocument/classify con PII enmascarada y presupuesto por hotel); sin clave sigue el fallback por reglas (regex + diccionario de proveedores). Solo en el proceso que escucha, como el de reputación.
  if (isLlmConfigured()) setDocumentsAiPort(createAiCoreDocumentsPort());

  // Tanda 3 (cierre · CRÍTICO SES): a rejected promise nobody awaited (the old
  // `records.map(queueSesHospedajesSubmission…)` in POST /ses/submissions) took
  // the whole process down — Node treats an unhandled rejection as an uncaught
  // exception. A leaked rejection is logged with its trace (and reported to
  // Sentry when configured) and the process KEEPS serving: the request that
  // leaked it already got its answer, and exiting would punish every other
  // client. An uncaughtException is different — the process state is unknown —
  // so we still exit(1), but only after the trace is out and Sentry flushed
  // (deferred fail-fast) instead of the silent crash the verifier saw. Only the
  // listen path installs these hooks: tests booting buildApiServer keep the
  // runner's own handlers.
  const reportProcessErrorToSentry = async (error: unknown): Promise<void> => {
    if (!sentryInitialized) return;
    try {
      const Sentry = await import("@sentry/node");
      Sentry.captureException(error);
      await Sentry.flush(2000);
    } catch (sentryError) {
      // Sentry failing must never mask the original error already logged above.
      app.log.warn({ err: sentryError }, "[process] could not report to Sentry");
    }
  };
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "[process] unhandledRejection (process kept alive; fix the missing await)");
    void reportProcessErrorToSentry(reason);
  });
  process.on("uncaughtException", (error) => {
    app.log.fatal({ err: error }, "[process] uncaughtException — exiting with code 1 once the trace is flushed");
    const exit = () => process.exit(1);
    // Hard deadline so a hung Sentry transport cannot keep a broken process alive.
    const deadline = setTimeout(exit, 3000);
    void reportProcessErrorToSentry(error).finally(() => {
      clearTimeout(deadline);
      setTimeout(exit, 250);
    });
  });

  // Tanda 3 (verifactu) · fail fast like AUTH-04: outside sandbox an invalid
  // SistemaInformatico block (producer NIF, IdSistemaInformatico, version,
  // installation number…) would put unacceptable registros on the AEAT chain,
  // so the API refuses to boot. In sandbox the stub accepts anything: warn only.
  {
    const verifactuMode = process.env.VERIFACTU_MODE ?? "sandbox";
    const software = resolveVerifactuSoftware();
    if (!software.ok) {
      if (verifactuMode !== "sandbox") {
        app.log.error(
          { verifactuMode, errors: software.errors },
          "[verifactu] bloque SistemaInformatico inválido — abortando arranque (VERIFACTU_MODE != sandbox)"
        );
        process.exit(1);
      }
      app.log.warn(
        { verifactuMode, errors: software.errors },
        "[verifactu] bloque SistemaInformatico incompleto (solo aviso en sandbox)"
      );
    }
  }
  await app.listen({ port, host });

  // Apagado ordenado (fusión T8 · E2): un único coordinador para SIGTERM/SIGINT
  // (lib/shutdown.ts). Antes cada scheduler registraba su propio `process.once`
  // que solo paraba su temporizador y no terminaba el proceso; al existir un
  // manejador Node retira la salida por defecto y el API ignoraba SIGTERM (el
  // 2026-09-19 hubo que matarlo con SIGKILL). Los pasos se ejecutan en orden
  // inverso al registro: los schedulers (registrados más abajo) se detienen
  // antes de cerrar Fastify, vaciar las colas de persistencia de auditoría
  // (audit_events/event_stream sellados por las últimas peticiones: la cola es
  // fire-and-forget y $disconnect sin flush los perdería) y desconectar Prisma
  // (server.ts no tiene onClose que lo haga). Plazo SHUTDOWN_TIMEOUT_MS (10 000 ms) → warn + exit 1; segunda
  // señal → exit 1 inmediato. RUN_SCHEDULERS no cambia. `process.on`, no `once`:
  // la segunda señal la resuelve el coordinador.
  const shutdown = createShutdownController({ timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000), exit: (code) => process.exit(code), log: app.log });
  shutdown.register("prisma", async () => {
    const { prisma } = await import("@hotelos/database");
    await prisma.$disconnect();
  });
  shutdown.register("audit.flush", () => flushAuditQueues());
  shutdown.register("fastify", () => app.close());
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown.trigger(signal));

  // HA gate (audit 2026-06 · #13): the eight schedulers below must run on EXACTLY
  // one instance, or >1 replica would duplicate SES/VeriFactu submissions to the
  // AEAT (sanctionable). Single switch RUN_SCHEDULERS=false disables them on
  // non-leader replicas; default true keeps single-node behaviour unchanged.
  // Tanda L2 (L2-02): on top of the switch, EVERY tick acquires or renews the
  // `scheduler_leases` lease (lib/scheduler-leader · holdsSchedulerLease) and
  // returns without working when another live instance holds it — so two
  // replicas with RUN_SCHEDULERS=true never run a tick at the same time and a
  // restarted process takes over when the lease expires. A lease failure
  // (database down) is logged and the tick is skipped: never fail open.
  const schedulerLeader = isSchedulerLeader(app.log);

  // SES Hospedajes scheduler (RD 933/2021 24h deadline): poll "retrying"
  // submissions whose nextRetryAt elapsed and report overdue ones. In-process
  // for reliability without the separate worker; for multi-instance deployments
  // move this to the pg-boss worker. Disable with SES_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.SES_SCHEDULER_DISABLED !== "true") {
    const intervalMs = Number(process.env.SES_SCHEDULER_INTERVAL_MS ?? 5 * 60 * 1000);
    const sesTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      const r = await runDueSesSubmissions(demoStore.userContext);
      if (r.retried > 0 || r.overdue > 0) app.log.info({ ses: r }, "[ses.scheduler] tick");
    };
    const timer = setInterval(() => {
      void sesTick().catch((error) => app.log.error({ err: error }, "[ses.scheduler] failed"));
    }, intervalMs);
    timer.unref();
    app.log.info(`[ses.scheduler] enabled (every ${Math.round(intervalMs / 1000)}s · lease-gated)`);
  }

  // VeriFactu retry scheduler: re-submit registros in "retrying" once their
  // nextRetryAt elapsed and recover rows orphaned mid-send. Same in-process
  // pattern as SES (the pg-boss worker is not part of this deployment).
  // Disable with VERIFACTU_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.VERIFACTU_SCHEDULER_DISABLED !== "true") {
    const intervalMs = Number(process.env.VERIFACTU_SCHEDULER_INTERVAL_MS ?? 2 * 60 * 1000);
    const verifactuTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      const r = await runDueVerifactuRetries();
      if (r.due > 0 || r.reconciled > 0) app.log.info({ verifactu: r }, "[verifactu.scheduler] tick");
    };
    const verifactuTimer = setInterval(() => {
      void verifactuTick().catch((error) => app.log.error({ err: error }, "[verifactu.scheduler] failed"));
    }, intervalMs);
    verifactuTimer.unref();
    app.log.info(`[verifactu.scheduler] enabled (every ${Math.round(intervalMs / 1000)}s · lease-gated)`);
  }

  // Rate grid v2 · channel delivery drain: batches queued ChannelDelivery rows
  // per channel, calls the adapter (simulator in stub/sandbox) with retries and
  // backoff, and marks sent/confirmed/rejected so the editor shows the state per
  // cell. Disable with CHANNEL_DRAIN_DISABLED=true. Tanda L2 (L2-02): the tick
  // runs here (drainChannelDeliveries, same anti-overlap as the module's
  // starter) so the lease gate precedes every drain like the other schedulers.
  if (schedulerLeader && process.env.CHANNEL_DRAIN_DISABLED !== "true") {
    const drainIntervalMs = readChannelEnv().drainIntervalMs;
    let draining = false;
    const drainTick = async () => {
      if (draining) return;
      if (!(await holdsSchedulerLease())) return;
      draining = true;
      try {
        await drainChannelDeliveries({}, { log: app.log });
      } finally {
        draining = false;
      }
    };
    const drainTimer = setInterval(() => {
      void drainTick().catch((error) => app.log.error({ err: error }, "[channel.drain] failed"));
    }, drainIntervalMs);
    drainTimer.unref();
    // Se detiene por el coordinador de apagado (E2), no por process.once.
    shutdown.register("channel.drain", () => clearInterval(drainTimer));
    app.log.info({ intervalMs: drainIntervalMs }, "[channel.drain] enabled (lease-gated)");
  }

  // Asistente unificado (Tanda L6b · corrector L6B-REV-07): purga por retención de la memoria del
  // asistente (assistant_conversations con last_message_at anterior a ASSISTANT_MEMORY_RETENTION_DAYS,
  // defecto 90; los mensajes caen por la FK en cascada). Mismo patrón lease-gated que SES/VeriFactu.
  // Disable with ASSISTANT_MEMORY_PURGE_DISABLED=true.
  if (schedulerLeader && process.env.ASSISTANT_MEMORY_PURGE_DISABLED !== "true") {
    const purgeIntervalMs = Number(process.env.ASSISTANT_MEMORY_PURGE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
    const retentionDays = Number(process.env.ASSISTANT_MEMORY_RETENTION_DAYS ?? ASSISTANT_RETENTION_DAYS);
    const purgeTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      const r = await purgeAssistantConversations({ retentionDays });
      if (r.deleted > 0) app.log.info({ assistantMemory: r }, "[assistant.purge] tick");
    };
    const purgeTimer = setInterval(() => {
      void purgeTick().catch((error) => app.log.error({ err: error }, "[assistant.purge] failed"));
    }, purgeIntervalMs);
    purgeTimer.unref();
    shutdown.register("assistant.purge", () => clearInterval(purgeTimer));
    app.log.info(`[assistant.purge] enabled (every ${Math.round(purgeIntervalMs / 1000)}s · retención ${retentionDays} días · lease-gated)`);
  }

  // Revenue pace scheduler: capture a daily OTB snapshot per property so PACE has
  // an exact historical baseline over time (live pace already reconstructs from
  // booking dates). Runs once at boot, then daily. Disable with
  // PACE_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.PACE_SCHEDULER_DISABLED !== "true") {
    const dayMs = 24 * 60 * 60 * 1000;
    const paceTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      const r = await capturePaceSnapshotsForAllProperties();
      // QC-06: per-property failures are no longer swallowed inside the
      // loop; the service reports them and the tick escalates to warn.
      if (r.failed.length > 0) app.log.warn({ pace: r }, "[pace.scheduler] tick with failed properties");
      else app.log.info({ pace: r }, "[pace.scheduler] tick");
      // Night-audit writer (H&F contract §5): after the OTB capture, upsert
      // yesterday's top-level RevenueDailySnapshot per property from real
      // reservations (dataSource "night_audit") so the audited history feeds
      // itself without the seed. Idempotent per (property, date).
      const s = await writeYesterdayDailySnapshotsForAllProperties();
      app.log.info({ nightAudit: s }, "[pace.scheduler] daily snapshot upsert");
    };
    const runCapture = () => void paceTick().catch((error) => app.log.error({ err: error }, "[pace.scheduler] failed"));
    runCapture();
    const paceTimer = setInterval(runCapture, dayMs);
    paceTimer.unref();
    app.log.info("[pace.scheduler] enabled (daily · pace + night-audit snapshot · lease-gated)");
  }

  // Tanda 6b (R6, fix t6b#13): the End-of-Day schedulers below run over HOTELS
  // only — an office or another non-lodging centre has no allotments or group
  // blocks. listOperationalProperties (lib/finance-scope via lib/tenancy) is the
  // single `kind = hotel` filter; archived centres are skipped as before and
  // closed ones keep releasing (unchanged behaviour of the legacy query).
  const listSchedulerHotels = async (): Promise<Array<{ id: string }>> => {
    const { prisma: prismaClient } = await import("@hotelos/database");
    const organizations = await prismaClient.organization.findMany({ select: { id: true } });
    const perOrganization = await Promise.all(organizations.map((organization) => listOperationalProperties(organization.id, prismaClient, { includeClosed: true })));
    return perOrganization.flat().filter((property) => property.status !== "archived").map((property) => ({ id: property.id }));
  };

  // Allotment release scheduler · industry-standard End-of-Day routine.
  // Para cada hotel activo, ejecuta releaseExpired() que devuelve al pool
  // general las habitaciones cuyo release period haya vencido sin venderse.
  // Idempotente (sólo libera días con releasedRooms = 0 y dentro del threshold).
  // Disable con ALLOTMENT_RELEASE_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.ALLOTMENT_RELEASE_SCHEDULER_DISABLED !== "true") {
    const dayMs = 24 * 60 * 60 * 1000;
    const runRelease = async () => {
      try {
        if (!(await holdsSchedulerLease())) return;
        const properties = await listSchedulerHotels();
        let totalReleasedDays = 0;
        let totalReleasedRooms = 0;
        for (const p of properties) {
          try {
            const r = await releaseExpired({ propertyId: p.id });
            totalReleasedDays += r.releasedDays;
            totalReleasedRooms += r.releasedRooms;
          } catch (err) {
            app.log.warn({ err, propertyId: p.id }, "[allotment.release.scheduler] property failed");
          }
        }
        app.log.info(
          { properties: properties.length, totalReleasedDays, totalReleasedRooms },
          "[allotment.release.scheduler] tick"
        );
      } catch (error) {
        app.log.error({ err: error }, "[allotment.release.scheduler] failed");
      }
    };
    void runRelease();
    const releaseTimer = setInterval(() => void runRelease(), dayMs);
    releaseTimer.unref();
    app.log.info("[allotment.release.scheduler] enabled (daily · auto-release cupos B2B · lease-gated)");
  }

  // Group cut-off scheduler · daily routine that auto-releases group blocks past
  // their cutOffDate. Mirrors the allotment release pattern but flips group
  // status to "released" instead of touching day-level inventory. Idempotent.
  // Disable with GROUP_CUTOFF_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.GROUP_CUTOFF_SCHEDULER_DISABLED !== "true") {
    const dayMs = 24 * 60 * 60 * 1000;
    const runCutoff = async () => {
      try {
        if (!(await holdsSchedulerLease())) return;
        const properties = await listSchedulerHotels();
        let total = 0;
        for (const p of properties) {
          try {
            const r = await releaseExpiredGroupBlocks(p.id);
            total += r.released;
          } catch (err) { app.log.warn({ err, propertyId: p.id }, "[group.cutoff.scheduler] property failed"); }
        }
        app.log.info({ properties: properties.length, releasedGroups: total }, "[group.cutoff.scheduler] tick");
      } catch (error) { app.log.error({ err: error }, "[group.cutoff.scheduler] failed"); }
    };
    void runCutoff();
    const timer = setInterval(() => void runCutoff(), dayMs);
    timer.unref();
    app.log.info("[group.cutoff.scheduler] enabled (daily · auto-release grupos vencidos · lease-gated)");
  }

  // Mailbox poller: read connected Gmail/Microsoft mailboxes, AI-extract bookings
  // and enqueue them for human review. Manual connector is excluded (push-only).
  // Disable with MAILBOX_POLL_DISABLED=true.
  if (schedulerLeader && process.env.MAILBOX_POLL_DISABLED !== "true") {
    const intervalMs = Number(process.env.MAILBOX_POLL_INTERVAL_MS ?? 5 * 60 * 1000);
    const mailboxTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      const r = await pollAllEmailConnections(demoStore.userContext);
      // QC-06: a mailbox that fails to poll (expired token, provider down)
      // is reported by id; lastError is already persisted on the connection.
      if (r.failed.length > 0) app.log.warn({ mailbox: r }, "[mailbox.poll] tick with failed connections");
      else if (r.processed > 0) app.log.info({ mailbox: r }, "[mailbox.poll] tick");
    };
    const mailboxTimer = setInterval(() => {
      void mailboxTick().catch((error) => app.log.error({ err: error }, "[mailbox.poll] failed"));
    }, intervalMs);
    mailboxTimer.unref();
    app.log.info(`[mailbox.poll] enabled (every ${Math.round(intervalMs / 1000)}s · lease-gated)`);
  }

  // OPERA Cloud · modo sombra (Tanda 7b · L3): job del líder — OPERA_FEED_LATE por
  // feed programado sin fichero y cierre de runs `processing` interrumpidos; cada
  // vuelta bajo pg_try_advisory_xact_lock('pms_shadow.job'). Vive aquí porque
  // apps/worker no depende de @hotelos/api. Disable with PMS_SHADOW_JOB_DISABLED=true.
  // Tanda L2 (L2-02): el arranque del módulo (anti-solape + log + runNow, fijado
  // por pms-shadow-routes.test.mts) conserva la cadencia, pero su temporizador
  // propio se detiene y lo sustituye uno que exige el lease en cada vuelta.
  if (schedulerLeader && process.env.PMS_SHADOW_JOB_DISABLED !== "true") {
    const pmsShadowIntervalMs = Number(process.env.PMS_SHADOW_JOB_INTERVAL_MS ?? 15 * 60 * 1000);
    const pmsShadow = startPmsShadowJob({ log: app.log, intervalMs: Number(process.env.PMS_SHADOW_JOB_INTERVAL_MS ?? 15 * 60 * 1000) });
    pmsShadow.stop();
    const pmsShadowTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      await pmsShadow.runNow();
    };
    const pmsShadowTimer = setInterval(() => {
      void pmsShadowTick().catch((error) => app.log.error({ err: error }, "[pms-shadow.job] failed"));
    }, pmsShadowIntervalMs);
    pmsShadowTimer.unref();
    const job = { stop: () => clearInterval(pmsShadowTimer) };
    shutdown.register("pms-shadow.job", job.stop);
  }

  // Reputación y reseñas (Tanda T8 · T8-C): job diario del líder — sincroniza las
  // fuentes de reseñas de las propiedades con reputation_quality, analiza (diccionario
  // o IA por ReputationAiPort), abre casos review_negative (score10 < 6) y purga por
  // retención; cada vuelta bajo pg_try_advisory_xact_lock(hashtext('reputation.sync'))
  // (modules/reputation/reputation-sync.job.ts). Vive aquí porque apps/worker no
  // depende de @hotelos/api. Disable with REPUTATION_SYNC_DISABLED=true. Como el modo
  // sombra: el arranque del módulo (runAtBoot + log) conserva la cadencia, pero su
  // temporizador propio se detiene y lo sustituye uno que exige el lease en cada vuelta.
  if (schedulerLeader && process.env.REPUTATION_SYNC_DISABLED !== "true") {
    const reputationIntervalMs = reputationSyncIntervalMs(Number(process.env.REPUTATION_SYNC_INTERVAL_MS ?? 86_400_000));
    const reputationSync = startReputationSyncJob({
      log: app.log,
      intervalMs: reputationIntervalMs,
      runAtBoot: process.env.REPUTATION_SYNC_RUN_AT_BOOT !== "false",
      collectorOptions: {
        ...(process.env.GOOGLE_BUSINESS_CLIENT_ID ? { googleClientId: process.env.GOOGLE_BUSINESS_CLIENT_ID } : {}),
        ...(process.env.GOOGLE_BUSINESS_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET } : {}),
        ...(process.env.GOOGLE_BUSINESS_REDIRECT_URI ? { googleRedirectUri: process.env.GOOGLE_BUSINESS_REDIRECT_URI } : {})
      }
    });
    reputationSync.stop();
    const reputationTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      await reputationSync.runNow();
    };
    const reputationTimer = setInterval(() => {
      void reputationTick().catch((error) => app.log.error({ err: error }, "[reputation.sync.job] failed"));
    }, reputationIntervalMs);
    reputationTimer.unref();
    const reputationJob = { stop: () => clearInterval(reputationTimer) };
    shutdown.register("reputation.sync.job", reputationJob.stop);
  }

  // Documentos (Tanda T9 · T9-13): job diario de retención del líder — bloquea los
  // documentos con retentionUntil vencido, purga los bloqueados hace 12 meses (fichero
  // fuera del almacén, searchText y campos pseudonimizados, deletedAt) salvo legalHold,
  // relanza la extracción atascada (> 10 min pending) y aplica la decisión autónoma;
  // cada vuelta bajo pg_try_advisory_xact_lock(hashtext('documents.retention'))
  // (modules/documents/documents-retention.job.ts). Vive aquí porque apps/worker no
  // depende de @hotelos/api. Disable with DOCUMENT_RETENTION_JOB_DISABLED=true. Como
  // reputación: el arranque del módulo (runAtBoot + log) conserva la cadencia, pero su
  // temporizador propio se detiene y lo sustituye uno que exige el lease en cada vuelta.
  if (schedulerLeader && process.env.DOCUMENT_RETENTION_JOB_DISABLED !== "true") {
    const retentionIntervalMs = 86_400_000;
    const documentsRetention = startDocumentsRetentionJob({ log: app.log, intervalMs: retentionIntervalMs, runAtBoot: true });
    documentsRetention.stop();
    const retentionTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      await documentsRetention.runNow();
    };
    const retentionTimer = setInterval(() => {
      void retentionTick().catch((error) => app.log.error({ err: error }, "[documents.retention.job] failed"));
    }, retentionIntervalMs);
    retentionTimer.unref();
    shutdown.register("documents.retention.job", () => clearInterval(retentionTimer));
  }

  // Check-in automatizado (Tanda CHK · W3-C, cableado en W4-D): invitación J-3,
  // recordatorio J-1, lote de sugerencias de habitación (CHECKIN_ASSIGNMENT_RUN_AT)
  // y purga de sesiones caducadas, solo en las propiedades con selfCheckInEnabled
  // (modules/checkin/checkin-jobs.ts). Cada vuelta exige el lease del líder
  // (holdsSchedulerLease dentro de startCheckinJobs) y un advisory lock propio;
  // CHECKIN_INVITATION_DISABLED=true lo apaga y CHECKIN_INVITATION_INTERVAL_MS
  // fija la cadencia (1 h por defecto). Vive aquí porque apps/worker no depende de @hotelos/api.
  const checkinConfig = readCheckInConfig();
  if (shouldStartCheckinJobs({ runSchedulers: schedulerLeader, disabled: checkinConfig.invitationDisabled })) {
    const checkinJobs = startCheckinJobs({ log: app.log, intervalMs: checkinConfig.invitationIntervalMs });
    shutdown.register("checkin.jobs", checkinJobs.stop);
  }
}
