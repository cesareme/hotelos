import { existsSync, readFileSync } from "node:fs";
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
      process.env[key] = value;
    }
    console.log(`[env] loaded ${candidate} (override mode)`);
    break;
  }
}
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import type { ChatAttachmentDraft, CheckInFromScanRequest, GuestIdentityFields, RateGridBulkUpdateRequest, RateGridPushRequest } from "@hotelos/shared";
import type { HotelModuleCode } from "@hotelos/product";
import type { HotelOsToolName } from "@hotelos/ai-tools";
import { buildHealthResponse, OBSERVABILITY_HEADERS, SERVICE_NAMES } from "@hotelos/config";
import { createId } from "./lib/ids.js";
import { demoStore, type UserContext } from "./lib/demo-store.js";
import { registerAuthContext } from "./lib/auth-context.js";
import { isSchedulerLeader } from "./lib/scheduler-leader.js";
import { BadRequestError, NotFoundError, statusCodeForError } from "./lib/http-error.js";
import { isLlmConfigured, llmComplete, llmExtractDocument } from "./lib/llm.js";
import { recordToolCall } from "./modules/ai-operations/pipeline.service.js";
import { MAPPING_CATALOGS } from "@hotelos/ai-tools";
import {
  getRateGrid,
  applyRateUpdates,
  applyRestrictionUpdates,
  applyInventoryUpdates
} from "./modules/revenue/rate-grid.service.js";
// Rate Manager v2 service (separate module — SiteMinder-style bulk editor +
// per-channel overrides + audit journal). The legacy `getRateGrid` above only
// supports a flat read; this v2 service adds filters, bulk-update, push and
// journal. Aliased to avoid clobbering the legacy export.
import {
  getRateGrid as getRateGridV2,
  bulkUpdateRateGrid,
  pushRateGrid,
  getRateJournal
} from "./modules/rate-manager/rate-grid.service.js";
import { listRatePlans, createRatePlan, updateRatePlan, deleteRatePlan } from "./modules/rate-manager/rate-plan.service.js";
import { listForecasts, generateForecasts, getForecastBySegment, getForecastAccuracy, getLiveHistoryForecastReport } from "./modules/revenue/forecast.service.js";
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
import { assertRoutePermission } from "./security/route-permissions.js";
import { requestSignIn as guestPortalRequestSignIn, signOut as guestPortalSignOut } from "./modules/guest-portal/guest-portal-auth.service.js";
import {
  GuestPortalAuthError,
  getGuestReservationView,
  submitPreCheckIn as guestPortalSubmitPreCheckIn,
  submitServiceRequest as guestPortalSubmitServiceRequest
} from "./modules/guest-portal/guest-portal.service.js";
import { hydrateAuditChainFromPostgres, verifyAuditIntegrity, verifyDomainEventIntegrity } from "./modules/audit/audit.service.js";
import { getCurrentBusinessDate, listNightAuditRuns, runNightAudit } from "./modules/night-audit/night-audit.service.js";
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
import { getVerifactuSubmission, getVerifactuSubmissionById, listVerifactuSubmissions, retryVerifactuSubmission } from "./modules/invoicing/verifactu-submission.service.js";
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
import {
  exportPeriodA3Format,
  exportPeriodSageFormat
} from "./modules/payroll/export.service.js";
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
import { getSesSubmission, listSesSubmissions, retrySesSubmission, runDueSesSubmissions } from "./modules/compliance/ses-submission.service.js";
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
  createMfaChallenge,
  getSecuritySettings,
  listNotifications,
  listPropertiesForUser,
  listSessions,
  loginWithEmailPassword,
  markNotificationRead,
  registerDevice,
  revokeSession,
  verifyMfaChallenge
} from "./modules/auth/auth.service.js";
import { createCheckInFromScanConfirmation, executeConfirmation } from "./modules/ai/check-in.command.js";
import {
  annulAuthorityCommunication,
  createSpainGuestRegisterRecord,
  ensureReservationGuestRegisterRecords,
  correctGuestRegisterRecord,
  correctSpainGuestRegisterRecord,
  downloadSesHospedajesBatch,
  generateSesHospedajesBatch,
  getAuthorityInbox,
  getAuthoritySubmission,
  getComplianceInbox,
  getSpainGuestRegisterSettings,
  listGuestRegisterRecords,
  listAuthoritySubmissions,
  listReservationGuestRegisterRecords,
  listSesHospedajesSubmissions,
  markGuestRegisterIdentityVerified,
  markGuestRegisterSigned,
  markSesBatchManuallyUploaded,
  patchSpainGuestRegisterRecord,
  patchSpainGuestRegisterSettings,
  queueGuestAuthoritySubmission,
  queueSesHospedajesSubmission,
  recordIdentityDiscardEvent,
  recordTemporaryIdentityScan,
  retryAuthoritySubmission,
  submitSesHospedajesBatch,
  testSesHospedajesConnection,
  updateSesHospedajesSubmissionStatus,
  validateSpainGuestRegisterRecordApi
} from "./modules/compliance/compliance.service.js";
import {
  assertPropertyInOrg,
  assignRoom,
  assignRoomByNumber,
  checkInReservation,
  checkOutReservation,
  createReservation,
  createRoom,
  getReservation,
  listReservations,
  listRoomTypes,
  listRooms,
  patchReservation,
  quoteAvailability,
  transitionReservation
} from "./modules/pms/pms.service.js";
import { listGuests, getGuest, createGuest, updateGuest } from "./modules/guests/guests.service.js";
import { extractPropertyMap, applyPropertyMap, type MapperFile, type PropertyMapProposal } from "./modules/mapper/property-mapper.service.js";
import { parseReservationRequest } from "./modules/pms/reservation-agent.service.js";
import { getGuestActivity } from "./modules/pms/guest-activity.service.js";
import {
  closeFolio,
  getFolioBalance,
  getReservationFolio,
  postFolioLine,
  postPayment,
  refundPayment,
  splitFolio,
  moveChargesBetweenFolios,
  markInvoicePaid,
  sendInvoiceByEmail
} from "./modules/folio/folio.service.js";
import { addPosLine, closePosTicket, listPosOutlets, listPosTickets, openPosTicket } from "./modules/pos/pos.service.js";
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
import {
  LoginSchema,
  ChangePasswordSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  CreateUserSchema,
  CreateReservationSchema,
  UpdateReservationSchema,
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
  CreateGuestSchema,
  UpdateGuestSchema,
  RectifyInvoiceSchema,
  CreateFiscalYearSchema,
  CloseFiscalYearSchema,
  ReopenFiscalYearSchema,
  CreateGdprRequestSchema,
  ExecuteErasureSchema,
  RejectGdprRequestSchema
} from "./schemas/index.js";
import { globalSearch, type SearchHit } from "./modules/search/search.service.js";
import { webhooksRoutes } from "./routes/webhooks.routes.js";
import { assistantRoutes } from "./routes/assistant.routes.js";
import { touristTaxRoutes } from "./routes/tourist-tax.routes.js";
import { answerQuestion as assistantAnswer, getAvailableTools as assistantTools } from "./modules/assistant/assistant.service.js";
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
  createSupplierBillDraft,
  listAccounts,
  listJournalEntries,
  listSupplierBills,
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
import {
  exportOperationalReport,
  getBillingReport,
  getReportCatalog,
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
  applyBackOfficeAiSuggestion,
  applyCategoryImport,
  applyCategoryTemplate,
  assignRoomsToHousekeepingSection,
  assignRoomsToMaintenanceArea,
  bulkCreateRooms,
  bulkUpdateRooms,
  commitPropertyMapImport,
  configureModule,
  createBackOfficeAiSuggestion,
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
  exportPropertyMap,
  generateQrCode,
  generateBulkQrCodes,
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
  getModuleHealth,
  getPropertyImport,
  getPropertyMap,
  getPropertySetupForm,
  getReadiness,
  getSetupProgress,
  listCategoryTemplates,
  inviteBackOfficeUser,
  listBackOfficeAudit,
  listBackOfficeAiSuggestions,
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
  listQrCodes,
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
  previewPropertyMapImport,
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
  upsertMaintenanceRule,
  upsertMapPosition
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
  exportHistoryForecastReport,
  getAdvancedModuleDashboard,
  getAdvancedModuleHealth,
  getAdvancedRecord,
  getHistoryForecastCharts,
  getHistoryForecastKpis,
  getHistoryForecastReport,
  listAdvancedRecords,
  transitionAdvancedRecord,
  validateAdvancedAiTool
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

export function buildApiServer() {
  // Init Sentry sync (fire-and-forget). El error handler de Fastify lo
  // recoge antes incluso de que Sentry esté listo (Sentry buffera).
  void initSentry();

  const app = Fastify({ logger: true });

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
    const exposeMessage =
      statusCode < 500 && error instanceof Error ? error.message : "Internal Server Error";
    reply.code(statusCode).send({
      statusCode,
      error: statusCode < 500 ? "Bad Request" : "Internal Server Error",
      message: exposeMessage,
      ...(correlationId ? { correlationId } : {})
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      statusCode: 404,
      error: "Not Found",
      message: `Route ${request.method} ${request.url} not found`
    });
  });

  app.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin)) return cb(null, true);
      // Permite el dominio configurado (PILOT_PUBLIC_ORIGIN, e.g. https://app.tudominio.com)
      const allowed = process.env.PILOT_PUBLIC_ORIGIN;
      if (allowed && origin === allowed) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-correlation-id"]
  });

  // PILOT-D1: rate limit global moderado + restricción dura en /auth/*.
  // Anti-bruteforce + protección contra abuso. Usa memoria local (suficiente
  // para single-node piloto); en cluster usaríamos Redis.
  app.register(fastifyRateLimit, {
    // SECURITY (audit 2026-06 · H3): default-on. Every route gets a baseline
    // limit; auth/critical routes harden it further via `config.rateLimit`.
    global: true,
    max: 200,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      // Only trust x-forwarded-for behind a known proxy (TRUST_PROXY=1, e.g.
      // Caddy in prod). Otherwise the header is client-spoofable and lets an
      // attacker dodge the limit by rotating it — fall back to the socket IP.
      if (process.env.TRUST_PROXY === "1") {
        const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
        if (xff) return xff;
      }
      return req.ip;
    },
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Demasiadas peticiones. Reintenta en unos segundos."
    })
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

  app.addHook("preHandler", async (request) => {
    assertRoutePermission({
      method: request.method,
      path: request.routeOptions.url ?? request.url.split("?")[0],
      // SECURITY (audit 2026-06 · NUEVO-2): default-deny. If no userContext is
      // present, evaluate against an EMPTY permission set — never the demoStore
      // super-user (which holds every permission). Defense in depth behind the
      // auth-context production gate.
      userPermissions: request.userContext?.permissions ?? []
    });
  });

  // ── Tenant-scope guards (audit 2026-06 · IDOR cross-tenant) ────────────────
  // Read-by-:id routes fetch rows by primary key. Without these, an authenticated
  // user of one hotel could read another hotel's reservation, invoice, folio,
  // guest PII (DNI) or SES register. Each resolves the row's owning property/org
  // and throws 404 (not 403) on mismatch so we never leak another tenant's
  // existence. Single-org demo (org_123) is unaffected — every row matches.
  async function assertReservationInOrg(reservationId: string, organizationId: string) {
    const { prisma: db } = await import("@hotelos/database");
    const row = await db.reservation.findUnique({
      where: { id: reservationId },
      select: { propertyId: true }
    });
    if (!row) throw new NotFoundError(`Reservation ${reservationId} not found.`);
    await assertPropertyInOrg(row.propertyId, organizationId);
  }
  async function assertInvoiceInOrg(invoiceId: string, organizationId: string) {
    const { prisma: db } = await import("@hotelos/database");
    const row = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { propertyId: true }
    });
    if (!row) throw new NotFoundError(`Invoice ${invoiceId} not found.`);
    await assertPropertyInOrg(row.propertyId, organizationId);
  }
  async function assertFolioInOrg(folioId: string, organizationId: string) {
    const { prisma: db } = await import("@hotelos/database");
    const row = await db.folio.findUnique({
      where: { id: folioId },
      select: { reservation: { select: { propertyId: true } } }
    });
    if (!row) throw new NotFoundError(`Folio ${folioId} not found.`);
    await assertPropertyInOrg(row.reservation.propertyId, organizationId);
  }
  async function assertGuestInOrg(guestId: string, organizationId: string) {
    const { prisma: db } = await import("@hotelos/database");
    const row = await db.guest.findUnique({
      where: { id: guestId },
      select: { organizationId: true }
    });
    if (!row || row.organizationId !== organizationId) {
      throw new NotFoundError(`Guest ${guestId} not found.`);
    }
  }
  // GDPR requests carry PII dossiers and trigger destructive erasure — scope
  // every read/action to the caller's org (the list route additionally must
  // never trust an organizationId from the query string).
  async function assertGdprRequestInOrg(requestId: string, organizationId: string) {
    const found = await gdprGetRequest(requestId);
    if (!found || (found as { organizationId?: string }).organizationId !== organizationId) {
      throw new NotFoundError(`GDPR request ${requestId} not found.`);
    }
    return found;
  }

  app.get("/health", async () => {
    // Production-grade health: ejecuta sub-checks reales y combina su estado.
    // Mantenemos el shape antiguo (`buildHealthResponse`) además del nuevo
    // para no romper consumidores existentes (smoke tests, dashboards…).
    type SubCheck = { ok: boolean; latencyMs?: number; message?: string };
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

    // verifactu: reporta el modo configurado (sandbox por defecto)
    checks.verifactu = {
      ok: true,
      message: `mode=${process.env.VERIFACTU_MODE ?? "sandbox"}`
    };

    // sesHospedajes: reporta el modo configurado (sandbox por defecto)
    checks.sesHospedajes = {
      ok: true,
      message: `mode=${process.env.SES_HOSPEDAJES_MODE ?? "sandbox"}`
    };

    const allOk = Object.values(checks).every((check) => check.ok);
    const status: "healthy" | "degraded" = allOk ? "healthy" : "degraded";

    // Construimos también la respuesta legacy para los consumidores actuales.
    const legacy = buildHealthResponse({
      service: SERVICE_NAMES.api,
      dependencies: {
        postgres: checks.database.ok ? "ok" : "degraded",
        redis: checks.redis.message === "configured" ? "ok" : "unconfigured",
        objectStorage: "unconfigured"
      }
    });

    return {
      ...legacy,
      ok: allOk,
      status,
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION ?? "dev",
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
      deviceId: body.deviceId ?? "unknown_device"
    });
    return {
      token: result.token,
      sessionId: result.sessionId,
      user: result.user,
      property: demoStore.property
    };
  });

  // PILOT-D1 · Crear usuario (onboarding inicial del cliente)
  app.post("/users", async (request) => {
    const body = parse(CreateUserSchema, request.body);
    const { createUser } = await import("./modules/auth/auth-pilot.service.js");
    return createUser({
      ...body,
      createdByUserId: request.userContext?.userId
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
      ...(result && process.env.NODE_ENV !== "production" ? { _testToken: result.resetTokenForTesting } : {})
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
          taxId: z.string().max(40).optional(),
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

  async function listSwitchableProperties(userContext: UserContext) {
    const { prisma } = await import("@hotelos/database");
    const [properties, organizations] = await Promise.all([
      prisma.property.findMany({
        select: { id: true, name: true, organizationId: true, municipality: true, province: true, status: true },
        orderBy: { name: "asc" }
      }),
      prisma.organization.findMany({ select: { id: true, name: true } })
    ]);
    const orgName = new Map(organizations.map((org) => [org.id, org.name]));
    if (properties.length === 0) {
      // Fallback to in-memory demo store if the database has not been seeded.
      return listPropertiesForUser(userContext).map((property) => ({
        id: property.id,
        name: property.name,
        organizationId: property.organizationId,
        organizationName: orgName.get(property.organizationId) ?? property.organizationId,
        municipality: null as string | null,
        province: null as string | null,
        status: "open"
      }));
    }
    return properties.map((property) => ({
      ...property,
      organizationName: orgName.get(property.organizationId) ?? property.organizationId
    }));
  }

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
  // Cada plugin agrupa los handlers de un dominio en su propio fichero. Fastify
  // `register` se ejecuta perezosamente al hacer `app.ready()`/`listen()`, no
  // hace falta await.
  app.register(webhooksRoutes);
  app.register(assistantRoutes);
  app.register(touristTaxRoutes);
  // --- Mobile keys / Wallet passes (P1-5) ----------------------------------
  app.post("/reservations/:id/wallet-pass", async (request) => {
    return issueWalletPass({
      context: request.userContext,
      reservationId: (request.params as { id: string }).id
    });
  });
  app.post("/mobile-keys/:serial/verify", async (request) => {
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
    const body = (request.body ?? {}) as { content: string };
    return importCsb43({ context: request.userContext, propertyId: params.propertyId, content: body.content });
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
    const params = request.params as { orgId: string; year: string };
    return { items: await esrsList({ context: request.userContext, organizationId: params.orgId, fiscalYear: params.year }) };
  });
  app.post("/esrs/indicators", async (request) => {
    return esrsUpsert({ context: request.userContext, payload: request.body as never });
  });
  app.post("/organizations/:orgId/esrs/:year/generate", async (request) => {
    const params = request.params as { orgId: string; year: string };
    return esrsGenerate({ context: request.userContext, organizationId: params.orgId, fiscalYear: params.year });
  });
  app.get("/organizations/:orgId/esrs/:year/report", async (request) => {
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
    return revokeWalletPass({
      context: request.userContext,
      serialNumber: (request.params as { serial: string }).serial
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
  app.get("/onboarding/projects", async (request) => listOnboardingProjects(request.userContext));
  app.get("/onboarding/projects/:projectId", async (request) =>
    getOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId })
  );
  app.patch("/onboarding/projects/:projectId", async (request) =>
    patchOnboardingProject({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );
  app.post("/onboarding/projects/:projectId/source-connections", async (request) =>
    createSourceConnection({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );
  app.post("/onboarding/source-connections/:connectionId/test", async (request) =>
    testSourceConnection({ context: request.userContext, connectionId: (request.params as { connectionId: string }).connectionId })
  );
  app.post("/onboarding/source-connections/:connectionId/sync", async (request) =>
    syncSourceConnection({ context: request.userContext, connectionId: (request.params as { connectionId: string }).connectionId })
  );
  app.post("/onboarding/projects/:projectId/files", async (request) =>
    uploadOnboardingFile({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );
  app.get("/onboarding/projects/:projectId/files", async (request) =>
    listOnboardingFiles({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId })
  );
  app.post("/onboarding/files/:fileId/classify", async (request) =>
    classifyOnboardingFileApi({ context: request.userContext, fileId: (request.params as { fileId: string }).fileId })
  );
  app.post("/onboarding/files/:fileId/extract", async (request) =>
    extractOnboardingFileApi({ context: request.userContext, fileId: (request.params as { fileId: string }).fileId })
  );
  app.post("/onboarding/projects/:projectId/ai/analyze", async (request) =>
    analyzeOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId, mode: "analyze" })
  );
  app.post("/onboarding/projects/:projectId/ai/generate-blueprint", async (request) =>
    analyzeOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId, mode: "generate_blueprint" })
  );
  app.post("/onboarding/projects/:projectId/ai/generate-mappings", async (request) =>
    analyzeOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId, mode: "generate_mappings" })
  );
  app.post("/onboarding/projects/:projectId/room-walk/parse", async (request) =>
    parseRoomWalkSetup({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );
  app.post("/onboarding/files/:fileId/floor-plan/map", async (request) =>
    mapFloorPlanFile({
      context: request.userContext,
      fileId: (request.params as { fileId: string }).fileId,
      payload: request.body as never
    })
  );
  app.post("/onboarding/projects/:projectId/ai/data-quality", async (request) =>
    analyzeOnboardingProject({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId, mode: "data_quality" })
  );
  app.get("/onboarding/projects/:projectId/extracted-entities", async (request) =>
    listExtractedEntities({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId })
  );
  app.get("/onboarding/projects/:projectId/mapping-suggestions", async (request) =>
    listMappingSuggestions({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId })
  );
  app.get("/onboarding/projects/:projectId/human-review-queue", async (request) =>
    getHumanReviewQueue({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId })
  );
  app.patch("/onboarding/mapping-suggestions/:suggestionId/approve", async (request) =>
    reviewMappingSuggestion({
      context: request.userContext,
      suggestionId: (request.params as { suggestionId: string }).suggestionId,
      decision: "approved",
      payload: request.body as never
    })
  );
  app.patch("/onboarding/mapping-suggestions/:suggestionId/reject", async (request) =>
    reviewMappingSuggestion({
      context: request.userContext,
      suggestionId: (request.params as { suggestionId: string }).suggestionId,
      decision: "rejected",
      payload: request.body as never
    })
  );
  app.patch("/onboarding/mapping-suggestions/:suggestionId/edit", async (request) =>
    reviewMappingSuggestion({
      context: request.userContext,
      suggestionId: (request.params as { suggestionId: string }).suggestionId,
      decision: "edited",
      payload: request.body as never
    })
  );
  app.post("/onboarding/projects/:projectId/dry-run", async (request) =>
    runMigrationDryRun({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );
  app.get("/onboarding/projects/:projectId/dry-run-result", async (request) =>
    getDryRunResult({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId })
  );
  app.post("/onboarding/projects/:projectId/apply", async (request) =>
    applyMigration({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );
  app.post("/onboarding/projects/:projectId/rollback", async (request) =>
    rollbackMigration({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );
  app.get("/onboarding/projects/:projectId/readiness", async (request) =>
    getGoLiveReadiness({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId })
  );
  app.get("/onboarding/projects/:projectId/cutover-plan", async (request) =>
    getCutoverPlan({ context: request.userContext, projectId: (request.params as { projectId: string }).projectId })
  );
  app.post("/onboarding/projects/:projectId/cutover/delta-import/dry-run", async (request) =>
    runCutoverDeltaImportDryRun({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );
  app.post("/onboarding/projects/:projectId/go-live", async (request) =>
    approveOnboardingGoLive({
      context: request.userContext,
      projectId: (request.params as { projectId: string }).projectId,
      payload: request.body as never
    })
  );

  app.get("/advanced/properties/:propertyId/modules/:moduleCode/health", async (request) => {
    const params = request.params as { propertyId: string; moduleCode: HotelModuleCode };
    return getAdvancedModuleHealth(params.propertyId, params.moduleCode);
  });

  app.get("/revenue/properties/:propertyId/dashboard", async (request) => {
    const params = request.params as { propertyId: string };
    return getAdvancedModuleDashboard(params.propertyId, "revenue_profit_engine");
  });
  app.get("/revenue/properties/:propertyId/metrics", async (request) => {
    const params = request.params as { propertyId: string };
    return getAdvancedModuleDashboard(params.propertyId, "revenue_profit_engine");
  });
  app.get("/revenue/properties/:propertyId/history-forecast", async (request) => {
    const params = request.params as { propertyId: string };
    return getHistoryForecastReport(params.propertyId, request.query as never);
  });
  app.get("/revenue/properties/:propertyId/history-forecast/charts", async (request) => {
    const params = request.params as { propertyId: string };
    return getHistoryForecastCharts(params.propertyId, request.query as never);
  });
  app.get("/revenue/properties/:propertyId/history-forecast/kpis", async (request) => {
    const params = request.params as { propertyId: string };
    return getHistoryForecastKpis(params.propertyId, request.query as never);
  });
  app.post("/revenue/properties/:propertyId/history-forecast/export", async (request) => {
    const params = request.params as { propertyId: string };
    return exportHistoryForecastReport({
      context: request.userContext,
      propertyId: params.propertyId,
      payload: request.body as never,
      correlationId: createId("corr")
    });
  });
  app.post("/revenue/properties/:propertyId/history-forecast/saved-views", async (request) => {
    const params = request.params as { propertyId: string };
    return createAdvancedRecord({ context: request.userContext, propertyId: params.propertyId, moduleCode: "revenue_profit_engine", entityType: "revenue_report_view", auditAction: "RevenueReportViewCreated", requiredPermissions: ["revenue.history_forecast.saved_views.manage"], payload: request.body as never, correlationId: createId("corr") });
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
    const q = request.query as { from?: string; to?: string };
    return getLiveHistoryForecastReport({ propertyId: params.propertyId, from: q.from, to: q.to });
  });
  app.get("/revenue/properties/:propertyId/period-metrics", async (request) => {
    const params = request.params as { propertyId: string };
    const q = request.query as { from?: string; to?: string };
    const today = new Date();
    const toDefault = today.toISOString().slice(0, 10);
    const fromDefault = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    return getPeriodMetrics({ propertyId: params.propertyId, from: q.from ?? fromDefault, to: q.to ?? toDefault });
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
    const params = request.params as { propertyId: string; id: string };
    return decideRecommendation({ context: request.userContext, id: params.id, decision: "approved", correlationId: createId("corr") });
  });
  app.post("/revenue/properties/:propertyId/recommendations/:id/apply", async (request) => {
    const params = request.params as { propertyId: string; id: string };
    return decideRecommendation({ context: request.userContext, id: params.id, decision: "applied", correlationId: createId("corr") });
  });
  app.post("/revenue/properties/:propertyId/recommendations/:id/reject", async (request) => {
    const params = request.params as { propertyId: string; id: string };
    return decideRecommendation({ context: request.userContext, id: params.id, decision: "rejected", correlationId: createId("corr") });
  });
  app.post("/revenue/recommendations/:recommendationId/approve", async (request) => {
    const params = request.params as { recommendationId: string };
    return decideRecommendation({ context: request.userContext, id: params.recommendationId, decision: "approved", correlationId: createId("corr") });
  });
  app.post("/revenue/recommendations/:recommendationId/apply", async (request) => {
    const params = request.params as { recommendationId: string };
    return decideRecommendation({ context: request.userContext, id: params.recommendationId, decision: "applied", correlationId: createId("corr") });
  });
  app.post("/revenue/recommendations/:recommendationId/reject", async (request) => {
    const params = request.params as { recommendationId: string };
    return decideRecommendation({ context: request.userContext, id: params.recommendationId, decision: "rejected", correlationId: createId("corr") });
  });
  // Pricing rules + BAR levels (Fase C2)
  app.get("/revenue/properties/:propertyId/pricing-rules", async (request) => listPricingRules((request.params as { propertyId: string }).propertyId));
  app.post("/revenue/properties/:propertyId/pricing-rules", async (request) => createPricingRule({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/revenue/pricing-rules/:id", async (request) => updatePricingRule({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/revenue/properties/:propertyId/bar-levels", async (request) => listBarLevels((request.params as { propertyId: string }).propertyId));
  app.post("/revenue/properties/:propertyId/bar-levels", async (request) => createBarLevel({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  // Strategy (Fase D): budget, market segments, displacement, meeting pack
  app.get("/revenue/properties/:propertyId/budget", async (request) => listBudgets((request.params as { propertyId: string }).propertyId));
  app.post("/revenue/properties/:propertyId/budget", async (request) => upsertBudget({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/revenue/properties/:propertyId/budget/variance", async (request) => getBudgetVariance({ propertyId: (request.params as { propertyId: string }).propertyId, month: (request.query as { month?: string }).month }));
  app.get("/revenue/properties/:propertyId/market-segments", async (request) => listMarketSegments((request.params as { propertyId: string }).propertyId));
  app.post("/revenue/properties/:propertyId/market-segments", async (request) => createMarketSegment({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/revenue/properties/:propertyId/market-segments/seed", async (request) => seedMarketSegments({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, correlationId: createId("corr") }));
  app.post("/revenue/properties/:propertyId/displacement", async (request) => {
    const params = request.params as { propertyId: string };
    const b = (request.body ?? {}) as { arrivalDate?: string; departureDate?: string; roomsPerNight?: number; groupRate?: number };
    return analyzeDisplacement({ propertyId: params.propertyId, arrivalDate: String(b.arrivalDate), departureDate: String(b.departureDate), roomsPerNight: Number(b.roomsPerNight), groupRate: Number(b.groupRate) });
  });
  app.get("/revenue/properties/:propertyId/meeting-pack", async (request) => getMeetingPack((request.params as { propertyId: string }).propertyId));

  // ---- Email connectors → AI → reservation (HITL) ----
  app.get("/integrations/email/providers", async () => emailProvidersStatus());
  app.get("/properties/:propertyId/email/connections", async (request) => listEmailConnections((request.params as { propertyId: string }).propertyId));
  app.post("/properties/:propertyId/email/connections", async (request) => createEmailConnection({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.delete("/email/connections/:id", async (request) => disconnectEmailConnection({ context: request.userContext, connectionId: (request.params as { id: string }).id, correlationId: createId("corr") }));
  app.get("/email/connections/:id/authorize-url", async (request) => {
    const id = (request.params as { id: string }).id;
    const conn = (await listEmailConnections(request.userContext.propertyId)).find((c) => c.id === id);
    if (!conn) throw new BadRequestError("Conexión no encontrada.");
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
      return `<html><body style="font-family:sans-serif;padding:40px"><h2>✅ Buzón conectado</h2><p>${r.emailAddress ?? r.provider}. Ya puedes cerrar esta pestaña y volver a HotelOS.</p></body></html>`;
    } catch (err) {
      reply.type("text/html");
      return `<html><body style="font-family:sans-serif;padding:40px"><h2>Error al conectar</h2><p>${err instanceof Error ? err.message : "Error"}</p></body></html>`;
    }
  });
  app.post("/email/connections/:id/poll", async (request) => pollEmailConnection({ context: request.userContext, connectionId: (request.params as { id: string }).id, correlationId: createId("corr") }));
  app.post("/properties/:propertyId/email/ingest", async (request) => {
    const b = (request.body ?? {}) as { connectionId?: string; from?: string; subject?: string; body?: string };
    return ingestManualEmail({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, connectionId: b.connectionId, from: b.from, subject: b.subject, body: String(b.body ?? ""), correlationId: createId("corr") });
  });
  app.get("/properties/:propertyId/email/inbound", async (request) => listInboundEmails((request.params as { propertyId: string }).propertyId, (request.query as { status?: string }).status));
  app.post("/email/inbound/:id/approve", async (request) => approveEmailReservation({ context: request.userContext, inboundEmailId: (request.params as { id: string }).id, overrides: (request.body ?? {}) as never, correlationId: createId("corr") }));
  app.post("/email/inbound/:id/reject", async (request) => rejectEmailReservation({ context: request.userContext, inboundEmailId: (request.params as { id: string }).id, reason: ((request.body ?? {}) as { reason?: string }).reason, correlationId: createId("corr") }));
  app.get("/revenue/properties/:propertyId/channel-profitability", async (request) => {
    const params = request.params as { propertyId: string };
    return listAdvancedRecords(params.propertyId, "revenue_profit_engine", "channel_profitability");
  });
  // Rate Plan CRUD (Fase 0) — backs the admin RatePlansScreen with persisted
  // data (the screen previously fell back to demo data with a "no implementado"
  // banner). Tenant scoping + permissions enforced inside the service.
  app.get("/properties/:propertyId/rate-plans", async (request) =>
    listRatePlans({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId }));
  app.post("/properties/:propertyId/rate-plans", async (request) =>
    createRatePlan({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never }));
  app.patch("/rate-plans/:id", async (request) =>
    updateRatePlan({ context: request.userContext, id: (request.params as { id: string }).id, patch: request.body as never }));
  app.delete("/rate-plans/:id", async (request) =>
    deleteRatePlan({ context: request.userContext, id: (request.params as { id: string }).id }));

  app.get("/revenue/properties/:propertyId/rate-grid", async (request) => {
    const params = request.params as { propertyId: string };
    const q = request.query as { from?: string; to?: string };
    return getRateGrid({ propertyId: params.propertyId, from: q.from, to: q.to });
  });
  app.patch("/revenue/properties/:propertyId/rate-grid/rates", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as { updates?: Parameters<typeof applyRateUpdates>[0]["updates"] };
    return applyRateUpdates({ context: request.userContext, propertyId: params.propertyId, updates: body.updates ?? [], correlationId: createId("corr") });
  });
  app.patch("/revenue/properties/:propertyId/rate-grid/restrictions", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as { updates?: Parameters<typeof applyRestrictionUpdates>[0]["updates"] };
    return applyRestrictionUpdates({ context: request.userContext, propertyId: params.propertyId, updates: body.updates ?? [], correlationId: createId("corr") });
  });
  app.patch("/revenue/properties/:propertyId/rate-grid/inventory", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as { updates?: Parameters<typeof applyInventoryUpdates>[0]["updates"] };
    return applyInventoryUpdates({ context: request.userContext, propertyId: params.propertyId, updates: body.updates ?? [], correlationId: createId("corr") });
  });
  app.post("/revenue/properties/:propertyId/rate-grid/bulk-update", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as {
      rates?: Parameters<typeof applyRateUpdates>[0]["updates"];
      restrictions?: Parameters<typeof applyRestrictionUpdates>[0]["updates"];
      inventory?: Parameters<typeof applyInventoryUpdates>[0]["updates"];
    };
    const ctx = request.userContext;
    const corr = createId("corr");
    const out: Record<string, number> = {};
    if (body.rates?.length) out.rates = (await applyRateUpdates({ context: ctx, propertyId: params.propertyId, updates: body.rates, correlationId: corr })).applied;
    if (body.restrictions?.length) out.restrictions = (await applyRestrictionUpdates({ context: ctx, propertyId: params.propertyId, updates: body.restrictions, correlationId: corr })).applied;
    if (body.inventory?.length) out.inventory = (await applyInventoryUpdates({ context: ctx, propertyId: params.propertyId, updates: body.inventory, correlationId: corr })).applied;
    return out;
  });
  app.get('/properties/:propertyId/rate-grid', async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { from?: string; to?: string; roomTypeIds?: string; channelId?: string };
    return getRateGridV2({
      propertyId: params.propertyId,
      from: query.from!,
      to: query.to!,
      roomTypeIds: query.roomTypeIds?.split(','),
      channelId: query.channelId
    });
  });

  app.post('/properties/:propertyId/rate-grid/bulk-update', async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as RateGridBulkUpdateRequest;
    // Resolve the property's default BAR rate plan once so each cell that
    // arrives without an explicit `ratePlanId` lands on the right BAR row.
    // The UI sends nested `restrictions` (shared DTO shape); the service
    // expects flat fields — translate here at the wire boundary.
    const { prisma: db } = await import("@hotelos/database");
    const defaultPlan = await db.ratePlan.findFirst({
      where: { propertyId: params.propertyId, code: { equals: "BAR" } },
      select: { id: true }
    });
    if (!defaultPlan) {
      throw Object.assign(new Error("Default BAR rate plan not configured for this property."), { statusCode: 400 });
    }
    return bulkUpdateRateGrid({
      propertyId: params.propertyId,
      context: request.userContext,
      cells: body.cells.map((c) => ({
        roomTypeId: c.roomTypeId,
        ratePlanId: defaultPlan.id,
        date: c.date,
        channelId: c.channelId,
        price: c.price,
        minStay: c.restrictions?.minLos,
        maxStay: c.restrictions?.maxLos,
        closedToArrival: c.restrictions?.cta,
        closedToDeparture: c.restrictions?.ctd,
        stopSell: c.restrictions?.stopSell ?? c.restrictions?.closed
      })),
      reason: body.reason
    });
  });

  app.post('/properties/:propertyId/rate-grid/push', async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as RateGridPushRequest;
    return pushRateGrid({ propertyId: params.propertyId, context: request.userContext, ...body });
  });

  app.get('/properties/:propertyId/rate-journal', async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { limit?: string };
    return getRateJournal({ propertyId: params.propertyId, limit: query.limit ? Number(query.limit) : 50 });
  });
  app.get("/revenue/properties/:propertyId/demand-calendar", async (request) => {
    const params = request.params as { propertyId: string };
    return listAdvancedRecords(params.propertyId, "revenue_profit_engine", "demand_calendar");
  });
  app.post("/revenue/properties/:propertyId/demand-calendar", async (request) => {
    const params = request.params as { propertyId: string };
    return createAdvancedRecord({ context: request.userContext, propertyId: params.propertyId, moduleCode: "revenue_profit_engine", entityType: "demand_calendar_event", auditAction: "DemandCalendarEventCreated", requiredPermissions: ["revenue.recommend"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.patch("/revenue/demand-calendar/:eventId", async (request) => {
    const params = request.params as { eventId: string };
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "demand_calendar_event", entityId: params.eventId, status: "updated", auditAction: "DemandCalendarEventCreated", requiredPermissions: ["revenue.recommend"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.delete("/revenue/demand-calendar/:eventId", async (request) => {
    const params = request.params as { eventId: string };
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "demand_calendar_event", entityId: params.eventId, status: "deleted", auditAction: "DemandCalendarEventCreated", requiredPermissions: ["revenue.recommend"], payload: {}, correlationId: createId("corr") });
  });
  app.post("/revenue/properties/:propertyId/scenarios/simulate", async (request) => {
    const params = request.params as { propertyId: string };
    return createAdvancedRecord({ context: request.userContext, propertyId: params.propertyId, moduleCode: "revenue_profit_engine", entityType: "revenue_scenario", auditAction: "RevenueScenarioSimulated", requiredPermissions: ["revenue.recommend"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/revenue/properties/:propertyId/scenarios", async (request) => {
    const params = request.params as { propertyId: string };
    return listAdvancedRecords(params.propertyId, "revenue_profit_engine", "revenue_scenarios");
  });
  app.get("/revenue/scenarios/:scenarioId", async (request) =>
    getAdvancedRecord(request.userContext.propertyId, "revenue_profit_engine", "revenue_scenarios", (request.params as { scenarioId: string }).scenarioId)
  );
  app.get("/revenue/properties/:propertyId/automation-rules", async (request) => {
    const params = request.params as { propertyId: string };
    return listAdvancedRecords(params.propertyId, "revenue_profit_engine", "automation_rules");
  });
  app.post("/revenue/properties/:propertyId/automation-rules", async (request) => {
    const params = request.params as { propertyId: string };
    return createAdvancedRecord({ context: request.userContext, propertyId: params.propertyId, moduleCode: "revenue_profit_engine", entityType: "revenue_automation_rule", auditAction: "RevenueAutomationRuleCreated", requiredPermissions: ["revenue.automation.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.patch("/revenue/automation-rules/:ruleId", async (request) => {
    const params = request.params as { ruleId: string };
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "revenue_automation_rule", entityId: params.ruleId, status: "updated", auditAction: "RevenueAutomationRuleUpdated", requiredPermissions: ["revenue.automation.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/revenue/automation-rules/:ruleId/enable", async (request) => {
    const params = request.params as { ruleId: string };
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "revenue_automation_rule", entityId: params.ruleId, status: "enabled", auditAction: "RevenueAutomationRuleUpdated", requiredPermissions: ["revenue.automation.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.post("/revenue/automation-rules/:ruleId/disable", async (request) => {
    const params = request.params as { ruleId: string };
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "revenue_automation_rule", entityId: params.ruleId, status: "disabled", auditAction: "RevenueAutomationRuleUpdated", requiredPermissions: ["revenue.automation.manage"], payload: request.body as never, correlationId: createId("corr") });
  });

  app.get("/channel-manager/properties/:propertyId/channels", async (request) => {
    const params = request.params as { propertyId: string };
    return listAdvancedRecords(params.propertyId, "revenue_profit_engine", "channels");
  });
  app.post("/channel-manager/properties/:propertyId/channels", async (request) => {
    const params = request.params as { propertyId: string };
    return createAdvancedRecord({ context: request.userContext, propertyId: params.propertyId, moduleCode: "revenue_profit_engine", entityType: "channel", auditAction: "ChannelConnected", requiredPermissions: ["channel_manager.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.patch("/channel-manager/channels/:channelId", async (request) => {
    const params = request.params as { channelId: string };
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "channel", entityId: params.channelId, status: "updated", auditAction: "ChannelConnected", requiredPermissions: ["channel_manager.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  // Stub /test removed — superseded by the Prisma-backed aggregator route below (~line 3903) that calls real OTA adapters.
  // Sprint 44: room/rate mapping CRUD rewired off the demoStore stub onto the
  // real Prisma-backed mapping.service so mappings written here are visible to
  // the aggregator's push paths (which read ChannelRoomMapping / ChannelRateMapping).
  app.get("/channel-manager/channels/:channelId/room-mappings", async (request) => {
    const params = request.params as { channelId: string };
    return { mappings: await listChannelRoomMappings(params.channelId) };
  });
  app.post("/channel-manager/channels/:channelId/room-mappings", async (request) => {
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
    const params = request.params as { id: string };
    return deleteChannelRoomMapping(params.id);
  });
  app.get("/channel-manager/channels/:channelId/rate-mappings", async (request) => {
    const params = request.params as { channelId: string };
    return { mappings: await listChannelRateMappings(params.channelId) };
  });
  app.post("/channel-manager/channels/:channelId/rate-mappings", async (request) => {
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
    const params = request.params as { id: string };
    return deleteChannelRateMapping(params.id);
  });
  app.get("/channel-manager/channels/:channelId/mapping-coverage", async (request) => {
    const params = request.params as { channelId: string };
    return channelMappingCoverage(params.channelId);
  });
  app.get("/channel-manager/channels/:channelId/readiness", async (request) => {
    const params = request.params as { channelId: string };
    return channelReadinessChecklist(params.channelId);
  });
  const CHANNEL_SYNC_ROUTE_TEMPLATES = [
    "/channel-manager/channels/:channelId/sync/availability",
    "/channel-manager/channels/:channelId/sync/rates",
    "/channel-manager/channels/:channelId/sync/restrictions",
    "/channel-manager/channels/:channelId/sync/full"
  ] as const;
  for (const routeTemplate of CHANNEL_SYNC_ROUTE_TEMPLATES) {
    app.post(routeTemplate, async (request) => {
      const params = request.params as { channelId: string };
      const syncType = routeTemplate.split("/").pop() as "availability" | "rates" | "restrictions" | "full";
      return createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "channel_sync_job", auditAction: "ChannelSyncStarted", requiredPermissions: ["channel_manager.sync"], payload: { channelId: params.channelId, syncType, ...(request.body as Record<string, unknown>) }, correlationId: createId("corr") });
    });
  }
  app.get("/channel-manager/channels/:channelId/sync-jobs", async (request) => {
    const params = request.params as { channelId: string };
    return (listAdvancedRecords(request.userContext.propertyId, "revenue_profit_engine", "channel_sync_jobs").items as Array<Record<string, unknown>>).filter((record) => record.channelId === params.channelId);
  });
  app.get("/channel-manager/properties/:propertyId/sync-health", async (request) => {
    const params = request.params as { propertyId: string };
    return listAdvancedRecords(params.propertyId, "revenue_profit_engine", "sync_health");
  });
  app.post("/channel-manager/channels/:channelId/reservations/import", async (request) => {
    const params = request.params as { channelId: string };
    return createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "external_reservation", auditAction: "ExternalReservationImported", requiredPermissions: ["channel_manager.sync"], payload: { channelId: params.channelId, ...(request.body as Record<string, unknown>) }, correlationId: createId("corr") });
  });
  app.post("/channel-manager/channels/:channelId/webhook", async (request) => {
    const params = request.params as { channelId: string };
    return createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "revenue_profit_engine", entityType: "external_reservation", auditAction: "ExternalReservationImported", requiredPermissions: ["channel_manager.sync"], payload: { channelId: params.channelId, payload: request.body }, correlationId: createId("corr") });
  });
  app.get("/channel-manager/properties/:propertyId/external-reservations", async (request) => {
    const params = request.params as { propertyId: string };
    return listAdvancedRecords(params.propertyId, "revenue_profit_engine", "external_reservations");
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

  app.get("/crm/profiles", async (request) => listAdvancedRecords(request.userContext.propertyId, "guest_data_crm_loyalty", "guest_profiles"));
  app.get("/crm/profiles/:id", async (request) =>
    getAdvancedRecord(request.userContext.propertyId, "guest_data_crm_loyalty", "guest_profiles", (request.params as { id: string }).id)
  );
  app.post("/crm/profiles/:id/merge", async (request) => {
    const params = request.params as { id: string };
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "guest_profile", entityId: params.id, status: "merged", auditAction: "GuestProfileMerged", requiredPermissions: ["crm.manage_profiles"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/crm/duplicates", async (request) => listAdvancedRecords(request.userContext.propertyId, "guest_data_crm_loyalty", "duplicate_guests"));
  app.get("/crm/segments", async (request) => listAdvancedRecords(request.userContext.propertyId, "guest_data_crm_loyalty", "crm_segments"));
  app.post("/crm/segments", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "crm_segment", auditAction: "GuestSegmentCreated", requiredPermissions: ["crm.manage_profiles"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/crm/segments/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "crm_segment", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "GuestSegmentCreated", requiredPermissions: ["crm.manage_profiles"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/crm/campaigns", async (request) => listAdvancedRecords(request.userContext.propertyId, "guest_data_crm_loyalty", "crm_campaigns"));
  app.post("/crm/campaigns", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "crm_campaign", auditAction: "CampaignCreated", requiredPermissions: ["crm.manage_campaigns"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/crm/campaigns/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "crm_campaign", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "CampaignCreated", requiredPermissions: ["crm.manage_campaigns"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/crm/loyalty", async (request) => listAdvancedRecords(request.userContext.propertyId, "guest_data_crm_loyalty", "loyalty"));
  app.post("/crm/loyalty/programs", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "loyalty_program", auditAction: "LoyaltyMembershipCreated", requiredPermissions: ["crm.manage_loyalty"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/crm/loyalty/memberships/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_data_crm_loyalty", entityType: "loyalty_membership", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "LoyaltyMembershipCreated", requiredPermissions: ["crm.manage_loyalty"], payload: request.body as never, correlationId: createId("corr") }));

  app.get("/sales/accounts", async (request) => listSalesAccounts(request.userContext.organizationId));
  app.post("/sales/accounts", async (request) => createSalesAccount({ context: request.userContext, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/sales/opportunities", async (request) => listSalesOpportunities(request.userContext.propertyId));
  app.post("/sales/opportunities", async (request) => createSalesOpportunity({ context: request.userContext, propertyId: request.userContext.propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/sales/opportunities/:id", async (request) => updateSalesOpportunity({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/groups/properties/:propertyId", async (request) => listGroupBookings((request.params as { propertyId: string }).propertyId));
  app.post("/groups/properties/:propertyId", async (request) => createGroupBooking({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/groups/:id", async (request) => getGroupBooking((request.params as { id: string }).id));
  app.patch("/groups/:id", async (request) => updateGroupBooking({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/groups/:id/room-blocks", async (request) => createGroupRoomBlock({ context: request.userContext, groupId: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/groups/:id/room-blocks/bulk", async (request) => bulkCreateGroupRoomBlocks({ context: request.userContext, groupId: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/groups/:id/events", async (request) => createGroupEvent({ context: request.userContext, groupId: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/groups/:id/rooming-list/import", async (request) => importRoomingList({ context: request.userContext, groupId: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") }));
  app.get("/properties/:propertyId/event-spaces", async (request) => listPropertyEventSpaces((request.params as { propertyId: string }).propertyId));
  app.post("/groups/:id/release-unsold", async (request) => releaseGroupUnsold({ context: request.userContext, groupId: (request.params as { id: string }).id, correlationId: createId("corr") }));
  app.post("/groups/:id/master-folio", async (request) => createGroupMasterFolio({ context: request.userContext, groupId: (request.params as { id: string }).id, correlationId: createId("corr") }));
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
  app.post("/groups/:id/create-reservations", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "groups_events_sales", entityType: "group_reservation_batch", auditAction: "GroupBookingCreated", requiredPermissions: ["groups.manage"], payload: { groupId: (request.params as { id: string }).id, ...(request.body as Record<string, unknown>) }, correlationId: createId("corr") }));
  app.get("/events/properties/:propertyId/calendar", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "groups_events_sales", "events_calendar"));
  app.post("/events/properties/:propertyId/spaces", async (request) => createEventSpace({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/events/properties/:propertyId/events", async (request) => createEvent({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/events/:id", async (request) => updateEvent({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never, correlationId: createId("corr") }));
  app.post("/events/:id/generate-beo", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "groups_events_sales", entityType: "event_order", auditAction: "BEOCreated", requiredPermissions: ["events.manage"], payload: { eventId: (request.params as { id: string }).id, ...(request.body as Record<string, unknown>) }, correlationId: createId("corr") }));

  app.get("/workforce/properties/:propertyId/schedule", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "workforce_labor", "schedule"));
  app.post("/workforce/properties/:propertyId/shifts", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "workforce_labor", entityType: "shift", auditAction: "ShiftCreated", requiredPermissions: ["workforce.schedule.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/workforce/shifts/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "workforce_labor", entityType: "shift", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "ShiftUpdated", requiredPermissions: ["workforce.schedule.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/workforce/time-clock/clock-in", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "workforce_labor", entityType: "time_clock_entry", auditAction: "StaffClockedIn", requiredPermissions: ["workforce.timeclock.use"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/workforce/time-clock/clock-out", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "workforce_labor", entityType: "time_clock_entry", auditAction: "StaffClockedOut", requiredPermissions: ["workforce.timeclock.use"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/workforce/properties/:propertyId/time-clock", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "workforce_labor", "time_clock_entries"));
  app.post("/workforce/absences", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "workforce_labor", entityType: "absence_request", auditAction: "AbsenceRequested", requiredPermissions: ["workforce.schedule.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/workforce/absences/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "workforce_labor", entityType: "absence_request", entityId: (request.params as { id: string }).id, status: "approved", auditAction: "AbsenceApproved", requiredPermissions: ["workforce.schedule.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/workforce/properties/:propertyId/labor-forecast", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "workforce_labor", "labor_forecast"));
  app.get("/workforce/properties/:propertyId/labor-costs", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "workforce_labor", "labor_costs"));

  app.get("/procurement/suppliers", async (request) => listAdvancedRecords(request.userContext.propertyId, "procurement_inventory", "suppliers"));
  app.post("/procurement/suppliers", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "procurement_inventory", entityType: "supplier", auditAction: "SupplierCreated", requiredPermissions: ["procurement.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/inventory/properties/:propertyId/items", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "procurement_inventory", "inventory_items"));
  app.post("/inventory/properties/:propertyId/items", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "procurement_inventory", entityType: "inventory_item", auditAction: "StockMovementCreated", requiredPermissions: ["inventory.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/inventory/properties/:propertyId/stock", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "procurement_inventory", "stock"));
  app.post("/inventory/properties/:propertyId/stock-movements", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "procurement_inventory", entityType: "stock_movement", auditAction: "StockMovementCreated", requiredPermissions: ["inventory.adjust"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/inventory/properties/:propertyId/stock-counts", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "procurement_inventory", entityType: "stock_count", auditAction: "StockCountCompleted", requiredPermissions: ["inventory.stock_count"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/procurement/properties/:propertyId/purchase-orders", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "procurement_inventory", "purchase_orders"));
  app.post("/procurement/properties/:propertyId/purchase-orders", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "procurement_inventory", entityType: "purchase_order", auditAction: "PurchaseOrderCreated", requiredPermissions: ["purchase_orders.create"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/procurement/purchase-orders/:id/approve", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "procurement_inventory", entityType: "purchase_order", entityId: (request.params as { id: string }).id, status: "approved", auditAction: "PurchaseOrderApproved", requiredPermissions: ["purchase_orders.approve"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/procurement/purchase-orders/:id/receive", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "procurement_inventory", entityType: "purchase_order", entityId: (request.params as { id: string }).id, status: "received", auditAction: "PurchaseOrderReceived", requiredPermissions: ["purchase_orders.receive"], payload: request.body as never, correlationId: createId("corr") }));

  app.get("/guest-portal/session/:token", async (request) => ({ token: (request.params as { token: string }).token, status: "active" }));
  app.post("/guest-portal/session/:token/check-in", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_self_service", entityType: "guest_portal_action", auditAction: "GuestOnlineCheckInCompleted", requiredPermissions: ["guest_self_service.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/guest-portal/session/:token/check-out", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_self_service", entityType: "guest_portal_action", auditAction: "GuestMobileCheckoutCompleted", requiredPermissions: ["guest_self_service.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/guest-portal/session/:token/folio", async (request) => ({ status: "ready_for_review", balanceDue: 0 }));
  app.post("/guest-portal/session/:token/pay", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_self_service", entityType: "guest_portal_payment", auditAction: "GuestMobileCheckoutCompleted", requiredPermissions: ["guest_self_service.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/guest-portal/session/:token/invoice-request", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_self_service", entityType: "guest_portal_invoice_request", auditAction: "GuestMobileCheckoutCompleted", requiredPermissions: ["guest_self_service.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/guest-portal/session/:token/upsells", async (request) => listAdvancedRecords(request.userContext.propertyId, "guest_self_service", "upsell_offers"));
  app.post("/guest-portal/session/:token/upsells/:offerId/purchase", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "guest_self_service", entityType: "guest_upsell_purchase", auditAction: "GuestUpsellPurchased", requiredPermissions: ["guest_self_service.manage"], payload: request.body as never, correlationId: createId("corr") }));
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

  app.get("/guest-self-service/properties/:propertyId/settings", async (request) => getAdvancedModuleDashboard((request.params as { propertyId: string }).propertyId, "guest_self_service"));
  app.patch("/guest-self-service/properties/:propertyId/settings", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "guest_self_service", entityType: "guest_self_service_settings", entityId: "settings", status: "updated", auditAction: "GuestPortalSessionCreated", requiredPermissions: ["guest_portal.configure"], payload: request.body as never, correlationId: createId("corr") }));

  app.get("/reputation/properties/:propertyId/dashboard", async (request) => getAdvancedModuleDashboard((request.params as { propertyId: string }).propertyId, "reputation_quality"));
  app.get("/reputation/properties/:propertyId/reviews", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "reputation_quality", "guest_reviews"));
  app.post("/reputation/reviews/:id/ai-draft-response", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "reputation_quality", entityType: "review_response_draft", auditAction: "ReviewResponseDrafted", requiredPermissions: ["reputation.respond"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/reputation/reviews/:id/respond", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "reputation_quality", entityType: "guest_review", entityId: (request.params as { id: string }).id, status: "responded", auditAction: "ReviewResponseSent", requiredPermissions: ["reputation.respond"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/quality/properties/:propertyId/cases", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "reputation_quality", "quality_cases"));
  app.post("/quality/properties/:propertyId/cases", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "reputation_quality", entityType: "quality_case", auditAction: "QualityCaseCreated", requiredPermissions: ["quality_cases.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/quality/cases/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "reputation_quality", entityType: "quality_case", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "QualityCaseResolved", requiredPermissions: ["quality_cases.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/surveys/properties/:propertyId", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "reputation_quality", "surveys"));
  app.post("/surveys/properties/:propertyId", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "reputation_quality", entityType: "survey", auditAction: "SurveyCreated", requiredPermissions: ["surveys.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/surveys/:id/responses", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "reputation_quality", entityType: "survey_response", auditAction: "SurveyResponseReceived", requiredPermissions: ["surveys.read"], payload: request.body as never, correlationId: createId("corr") }));

  app.get("/energy/properties/:propertyId/dashboard", async (request) => getAdvancedModuleDashboard((request.params as { propertyId: string }).propertyId, "energy_sustainability"));
  app.get("/energy/properties/:propertyId/meters", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "energy_sustainability", "utility_meters"));
  app.post("/energy/properties/:propertyId/meters", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "energy_sustainability", entityType: "utility_meter", auditAction: "UtilityMeterCreated", requiredPermissions: ["energy.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/energy/properties/:propertyId/readings", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "energy_sustainability", entityType: "utility_reading", auditAction: "UtilityReadingCreated", requiredPermissions: ["energy.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/sustainability/properties/:propertyId/dashboard", async (request) => getAdvancedModuleDashboard((request.params as { propertyId: string }).propertyId, "energy_sustainability"));
  app.post("/sustainability/properties/:propertyId/actions", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "energy_sustainability", entityType: "sustainability_action", auditAction: "SustainabilityActionCreated", requiredPermissions: ["sustainability.report"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/sustainability/properties/:propertyId/report", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "energy_sustainability", "sustainability_report"));

  app.get("/safety/properties/:propertyId/incidents", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "safety_incident_management", "safety_incidents"));
  app.post("/safety/properties/:propertyId/incidents", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "safety_incident_management", entityType: "safety_incident", auditAction: "SafetyIncidentCreated", requiredPermissions: ["incidents.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/safety/incidents/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "safety_incident_management", entityType: "safety_incident", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "SafetyIncidentUpdated", requiredPermissions: ["incidents.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/safety/incidents/:id/evidence", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "safety_incident_management", entityType: "incident_evidence", auditAction: "IncidentEvidenceAdded", requiredPermissions: ["incidents.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/safety/properties/:propertyId/checks", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "safety_incident_management", "safety_checks"));
  app.post("/safety/properties/:propertyId/checks", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "safety_incident_management", entityType: "safety_check", auditAction: "SafetyCheckCreated", requiredPermissions: ["safety_checks.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/safety/checks/:id/results", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "safety_incident_management", entityType: "safety_check_result", auditAction: "SafetyCheckCompleted", requiredPermissions: ["safety_checks.manage"], payload: request.body as never, correlationId: createId("corr") }));

  app.get("/analytics/properties/:propertyId/dashboard", async (request) => getAdvancedModuleDashboard((request.params as { propertyId: string }).propertyId, "hotel_intelligence_platform"));
  app.get("/analytics/properties/:propertyId/metrics", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "hotel_intelligence_platform", "metrics"));
  app.post("/analytics/metrics", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "hotel_intelligence_platform", entityType: "metric_definition", auditAction: "MetricDefinitionCreated", requiredPermissions: ["metrics.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/analytics/properties/:propertyId/anomalies", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "hotel_intelligence_platform", "anomalies"));
  app.patch("/analytics/anomalies/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "hotel_intelligence_platform", entityType: "anomaly_event", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "AnomalyDetected", requiredPermissions: ["analytics.configure"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/analytics/properties/:propertyId/reports", async (request) => listAdvancedRecords((request.params as { propertyId: string }).propertyId, "hotel_intelligence_platform", "scheduled_reports"));
  app.post("/analytics/properties/:propertyId/reports", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: (request.params as { propertyId: string }).propertyId, moduleCode: "hotel_intelligence_platform", entityType: "scheduled_report", auditAction: "ScheduledReportGenerated", requiredPermissions: ["analytics.configure"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/analytics/query", async (request) => ({ status: "answered_from_approved_metrics", input: request.body, moduleCode: "hotel_intelligence_platform" }));

  // /developer/apps + rotate-secret movidos a marketplace.service en P2-1.
  // Legacy usage logs siguen aquí hasta que se migren.
  app.get("/developer/apps/:id/usage", async (request) => listAdvancedRecords(request.userContext.propertyId, "developer_platform", "api_usage_logs"));
  app.get("/developer/webhooks", async (request) => listAdvancedRecords(request.userContext.propertyId, "developer_platform", "webhooks"));
  app.post("/developer/webhooks", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "developer_platform", entityType: "webhook_subscription", auditAction: "WebhookSubscriptionCreated", requiredPermissions: ["developer.manage_webhooks"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/developer/webhooks/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "developer_platform", entityType: "webhook_subscription", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "WebhookSubscriptionCreated", requiredPermissions: ["developer.manage_webhooks"], payload: request.body as never, correlationId: createId("corr") }));
  app.post("/developer/webhooks/:id/test", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "developer_platform", entityType: "webhook_delivery", auditAction: "WebhookDeliveryFailed", requiredPermissions: ["developer.manage_webhooks"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/developer/webhooks/:id/deliveries", async (request) => listAdvancedRecords(request.userContext.propertyId, "developer_platform", "webhook_deliveries"));

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

  app.get("/ai-governance/policies", async (request) => listAdvancedRecords(request.userContext.propertyId, "ai_governance", "ai_policies"));
  app.post("/ai-governance/policies", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_policy", auditAction: "AIPolicyUpdated", requiredPermissions: ["ai_governance.configure"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/ai-governance/policies/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_policy", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "AIPolicyUpdated", requiredPermissions: ["ai_governance.configure"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/ai-governance/tools", async (request) => listAdvancedRecords(request.userContext.propertyId, "ai_governance", "ai_tool_registry"));
  app.patch("/ai-governance/tools/:toolName", async (request) => {
    const params = request.params as { toolName: string };
    const validation = validateAdvancedAiTool({ propertyId: request.userContext.propertyId, toolName: params.toolName as HotelOsToolName, userPermissions: request.userContext.permissions });
    return transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_tool_registry", entityId: params.toolName, status: validation.allowed ? "updated" : "blocked", auditAction: validation.allowed ? "AIToolEnabled" : "AIToolDisabled", requiredPermissions: ["ai_tool_registry.manage"], payload: request.body as never, correlationId: createId("corr") });
  });
  app.get("/ai-governance/prompts", async (request) => listAdvancedRecords(request.userContext.propertyId, "ai_governance", "ai_prompt_versions"));
  app.post("/ai-governance/prompts", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_prompt_version", auditAction: "AIPromptVersionCreated", requiredPermissions: ["ai_prompts.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/ai-governance/prompts/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_prompt_version", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "AIPromptVersionCreated", requiredPermissions: ["ai_prompts.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/ai-governance/evaluations", async (request) => listAdvancedRecords(request.userContext.propertyId, "ai_governance", "ai_evaluations"));
  app.post("/ai-governance/evaluations/:id/run", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_evaluation", entityId: (request.params as { id: string }).id, status: "run", auditAction: "AIEvaluationRun", requiredPermissions: ["ai_evals.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/ai-governance/incidents", async (request) => listAdvancedRecords(request.userContext.propertyId, "ai_governance", "ai_incidents"));
  app.post("/ai-governance/incidents", async (request) => createAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_incident", auditAction: "AIIncidentCreated", requiredPermissions: ["ai_incidents.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.patch("/ai-governance/incidents/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_incident", entityId: (request.params as { id: string }).id, status: "resolved", auditAction: "AIIncidentCreated", requiredPermissions: ["ai_incidents.manage"], payload: request.body as never, correlationId: createId("corr") }));
  app.get("/ai-governance/human-review", async (request) => listAdvancedRecords(request.userContext.propertyId, "ai_governance", "ai_human_review"));
  app.patch("/ai-governance/human-review/:id", async (request) => transitionAdvancedRecord({ context: request.userContext, propertyId: request.userContext.propertyId, moduleCode: "ai_governance", entityType: "ai_human_review_item", entityId: (request.params as { id: string }).id, status: "resolved", auditAction: "AIHumanReviewResolved", requiredPermissions: ["ai_governance.configure"], payload: request.body as never, correlationId: createId("corr") }));

  // AI Operations — pipeline status (Sprint 48, tool-call telemetry)
  app.get("/ai-operations/pipeline/dashboard", async (request) => {
    const q = request.query as { organizationId?: string; propertyId?: string; days?: string };
    const organizationId = q.organizationId ?? request.userContext?.organizationId ?? "org_123";
    return buildPipelineDashboard({
      organizationId,
      propertyId: q.propertyId,
      days: q.days ? Number(q.days) : undefined
    });
  });
  app.get("/ai-operations/pipeline/calls/:id", async (request) => {
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
    const propertyId = q.propertyId ?? request.userContext?.propertyId ?? "prop_123";
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
    const propertyId = body.propertyId ?? request.userContext?.propertyId ?? "prop_123";
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
    const propertyId = q.propertyId ?? request.userContext?.propertyId ?? "prop_123";
    return aiReadiness(propertyId);
  });
  app.get("/ai-operations/property/configured", async (request) => {
    const q = request.query as { organizationId?: string };
    const organizationId = q.organizationId ?? request.userContext?.organizationId ?? "org_123";
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

  app.post("/backoffice/properties/:propertyId/map-positions", async (request) => {
    const params = request.params as { propertyId: string };
    return upsertMapPosition({
      context: request.userContext,
      propertyId: params.propertyId,
      position: request.body as Parameters<typeof upsertMapPosition>[0]["position"],
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

  app.get("/backoffice/properties/:propertyId/property-map/export", async (request) => {
    const params = request.params as { propertyId: string };
    return exportPropertyMap(params.propertyId);
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
    const params = request.params as { propertyId: string; roomTypeId: string };
    return deactivateBackOfficeRoomType({
      context: request.userContext,
      propertyId: params.propertyId,
      roomTypeId: params.roomTypeId,
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/room-types/:roomTypeId/merge", async (request) => {
    const params = request.params as { propertyId: string; roomTypeId: string };
    const body = request.body as { targetRoomTypeId: string };
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
    return listRoomsForRoomType(params.roomTypeId);
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

  app.post("/backoffice/properties/:propertyId/imports/property-map/preview", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { rows: Parameters<typeof previewPropertyMapImport>[0]["rows"] };
    return previewPropertyMapImport({
      context: request.userContext,
      propertyId: params.propertyId,
      rows: body.rows,
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/imports/property-map/commit", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { importId: string; createUnknownReferences?: boolean };
    return commitPropertyMapImport({
      context: request.userContext,
      propertyId: params.propertyId,
      importId: body.importId,
      createUnknownReferences: body.createUnknownReferences,
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
    const body = request.body as { action?: "enable" | "disable"; configurationJson?: Record<string, unknown> };
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

  app.get("/backoffice/properties/:propertyId/modules/:moduleCode/health", async (request) => {
    const params = request.params as { propertyId: string; moduleCode: HotelModuleCode };
    return getModuleHealth(params.propertyId, params.moduleCode);
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

  app.post("/backoffice/properties/:propertyId/users/invite", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as Omit<Parameters<typeof inviteBackOfficeUser>[0], "context" | "propertyId" | "correlationId">;
    return inviteBackOfficeUser({
      context: request.userContext,
      propertyId: params.propertyId,
      ...body,
      correlationId: createId("corr")
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

  app.get("/backoffice/properties/:propertyId/ai/suggestions", async (request) => {
    const params = request.params as { propertyId: string };
    return listBackOfficeAiSuggestions(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/ai/suggestions", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { prompt: string };
    return createBackOfficeAiSuggestion({
      context: request.userContext,
      propertyId: params.propertyId,
      prompt: body.prompt,
      correlationId: createId("corr")
    });
  });

  app.post("/backoffice/properties/:propertyId/ai/suggestions/:suggestionId/apply", async (request) => {
    const params = request.params as { propertyId: string; suggestionId: string };
    return applyBackOfficeAiSuggestion({
      context: request.userContext,
      propertyId: params.propertyId,
      suggestionId: params.suggestionId,
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

  app.post("/backoffice/properties/:propertyId/qr-codes", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as Omit<Parameters<typeof generateQrCode>[0], "context" | "propertyId" | "correlationId">;
    return generateQrCode({
      context: request.userContext,
      propertyId: params.propertyId,
      ...body,
      correlationId: createId("corr")
    });
  });

  app.get("/backoffice/properties/:propertyId/qr-codes", async (request) => {
    const params = request.params as { propertyId: string };
    return listQrCodes(params.propertyId);
  });

  app.post("/backoffice/properties/:propertyId/qr-codes/bulk", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as { items: Parameters<typeof generateBulkQrCodes>[0]["items"] };
    return generateBulkQrCodes({
      context: request.userContext,
      propertyId: params.propertyId,
      items: body.items,
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
    const body = request.body as { configurationJson?: Record<string, unknown> };
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
    const body = request.body as { status?: "connected" | "disconnected" | "error" };
    const connection = demoStore.integrationConnections.find(
      (candidate) => candidate.propertyId === params.propertyId && candidate.id === params.connectionId
    );
    if (!connection) {
      throw new Error("Integration connection was not found.");
    }
    connection.status = body.status ?? connection.status;
    return connection;
  });

  app.delete("/properties/:propertyId/integrations/:connectionId", async (request) => {
    const params = request.params as { propertyId: string; connectionId: string };
    return disconnectIntegration({
      context: request.userContext,
      propertyId: params.propertyId,
      connectionId: params.connectionId,
      correlationId: createId("corr")
    });
  });

  app.post("/properties/:propertyId/integrations/:connectionId/test", async (request) => {
    const params = request.params as { propertyId: string; connectionId: string };
    return testIntegrationConnection({
      context: request.userContext,
      propertyId: params.propertyId,
      connectionId: params.connectionId,
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/integrations/:connectionId/events", async (request) => {
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
    const [arrivalsToday, departuresToday, todayRevenueAgg, unpaidAgg] = await Promise.all([
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
      })
    ]);
    const unpaidBalances = unpaidAgg.reduce((sum: number, f: { lines: Array<{ total: unknown }>; payments: Array<{ amount: unknown }> }) => {
      const charges = f.lines.reduce((s: number, l) => s + Number(l.total), 0);
      const paid = f.payments.reduce((s: number, p) => s + Number(p.amount), 0);
      return sum + Math.max(0, charges - paid);
    }, 0);
    const todayRevenue = Number(todayRevenueAgg._sum.total ?? 0);
    return {
      arrivalsToday,
      departuresToday,
      roomsDirty: demoStore.rooms.filter((room) => room.housekeepingStatus === "dirty").length,
      roomsCleanInspected: demoStore.rooms.filter((room) => room.housekeepingStatus === "inspected").length,
      roomsOutOfOrder: demoStore.rooms.filter((room) => room.status === "out_of_order").length,
      openMaintenanceTasks: await (await import("@hotelos/database")).prisma.workOrder.count({ where: { propertyId: params.propertyId, status: { notIn: ["resolved", "closed"] } } }),
      guestMessages: 0,
      unpaidBalances: Math.round(unpaidBalances * 100) / 100,
      failedComplianceRecords: getComplianceInbox(params.propertyId).length,
      todayRevenue: Math.round(todayRevenue * 100) / 100,
      aiDailyBriefing:
        arrivalsToday > 0
          ? `Hoy llegan ${arrivalsToday} reservas y se marchan ${departuresToday}. Ingresos del día: €${Math.round(todayRevenue)}.`
          : "Día tranquilo: sin llegadas previstas. Buen momento para tareas pendientes de housekeeping."
    };
  });

  app.get("/properties/:propertyId/rooms", async (request) => {
    const params = request.params as { propertyId: string };
    const query = request.query as { limit?: string };
    const limit = query?.limit ? Number(query.limit) : undefined;
    return listRooms(params.propertyId, { limit });
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

  app.get("/properties/:propertyId/reservations", async (request) => {
    const params = request.params as { propertyId: string };
    await assertPropertyInOrg(params.propertyId, request.userContext.organizationId);
    const query = request.query as { limit?: string };
    const limit = query?.limit ? Number(query.limit) : undefined;
    return listReservations(params.propertyId, { limit });
  });

  app.post("/properties/:propertyId/availability/quote", async (request) => {
    const params = request.params as { propertyId: string };
    const body = request.body as {
      arrivalDate: string;
      departureDate: string;
      adults?: number;
      children?: number;
    };
    return quoteAvailability({
      propertyId: params.propertyId,
      arrivalDate: body.arrivalDate,
      departureDate: body.departureDate,
      adults: body.adults ?? 1,
      children: body.children ?? 0
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
    };

    return createReservation({
      context: request.userContext,
      propertyId: params.propertyId,
      channel: body.channel,
      arrivalDate: body.arrivalDate,
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
      correlationId: createId("corr")
    });
  });

  app.get("/reservations/:id", async (request) => {
    const params = request.params as { id: string };
    await assertReservationInOrg(params.id, request.userContext.organizationId);
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
    parse(UpdateReservationSchema, request.body);
    return patchReservation({
      context: request.userContext,
      reservationId: params.id,
      patch: request.body as Parameters<typeof patchReservation>[0]["patch"],
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
    const params = request.params as { id: string };
    const { prisma: db } = await import("@hotelos/database");
    const events = await db.auditEvent.findMany({
      where: { entityType: "reservation", entityId: params.id },
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
    const _params = request.params as { id: string };
    void _params;
    return { documents: [] as unknown[] };
  });

  app.post("/reservations/:id/assign-room", async (request) => {
    const params = request.params as { id: string };
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
    const params = request.params as { id: string };
    const body = parse(CheckInSchema, request.body);
    const reservation = await checkInReservation({
      context: request.userContext,
      reservationId: params.id,
      roomId: body.roomId,
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
    return { ...reservation, guestRegister };
  });

  app.post("/reservations/:id/check-out", async (request) => {
    const params = request.params as { id: string };
    parse(CheckOutSchema, request.body ?? {});
    const reservation = await checkOutReservation({
      context: request.userContext,
      reservationId: params.id,
      correlationId: createId("corr")
    });
    const departureTask = reservation.assignedRoomId
      ? await createDepartureCleaningTask({
          context: request.userContext,
          propertyId: reservation.propertyId,
          roomId: reservation.assignedRoomId,
          correlationId: createId("corr")
        })
      : undefined;
    const balance = await getReservationFolio(params.id);
    const folio = balance.balanceDue === 0
      ? await closeFolio({
          context: request.userContext,
          folioId: balance.folio.id,
          correlationId: createId("corr")
        })
      : balance.folio;

    return { reservation, folio, departureTask };
  });

  app.post("/reservations/:id/cancel", async (request) => {
    const params = request.params as { id: string };
    const body = parse(CancelReservationSchema, request.body ?? {});
    return transitionReservation({
      context: request.userContext,
      reservationId: params.id,
      status: "cancelled",
      reason: body.reason,
      correlationId: createId("corr")
    });
  });

  app.post("/reservations/:id/no-show", async (request) => {
    const params = request.params as { id: string };
    const body = parse(NoShowReservationSchema, request.body ?? {});
    return transitionReservation({
      context: request.userContext,
      reservationId: params.id,
      status: "no_show",
      reason: body.reason,
      correlationId: createId("corr")
    });
  });

  app.get("/reservations/:id/folio", async (request) => {
    const params = request.params as { id: string };
    return getReservationFolio(params.id);
  });

  // Guest journey activity feed — chat + housekeeping + maintenance + requests.
  app.get("/reservations/:id/activity", async (request) => {
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
  app.get("/guests", async (request) => {
    const query = (request.query ?? {}) as { search?: string; limit?: string };
    return listGuests({
      context: request.userContext,
      search: query.search,
      limit: query.limit ? Number(query.limit) : undefined
    });
  });

  app.get("/guests/:id", async (request) => {
    const params = request.params as { id: string };
    return getGuest({ context: request.userContext, id: params.id });
  });

  app.get("/guests/:id/timeline", async (request) => {
    const params = request.params as { id: string };
    await assertGuestInOrg(params.id, request.userContext.organizationId);
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
    await assertFolioInOrg(folioId, request.userContext.organizationId);
    return getFolioBalance(folioId);
  });
  app.post("/folios/:id/lines", async (request) => {
    const params = request.params as { id: string };
    const body = parse(CreateFolioLineSchema, request.body);
    return postFolioLine({
      context: request.userContext,
      folioId: params.id,
      type: body.type as Parameters<typeof postFolioLine>[0]["type"],
      description: body.description,
      quantity: body.quantity,
      unitPrice: body.unitPrice,
      taxCode: body.taxCode,
      correlationId: createId("corr")
    });
  });

  app.post("/folios/:id/payments", async (request) => {
    const params = request.params as { id: string };
    const body = parse(ApplyPaymentSchema, request.body);
    return postPayment({
      context: request.userContext,
      folioId: params.id,
      amount: body.amount,
      currency: body.currency,
      method: body.method as Parameters<typeof postPayment>[0]["method"],
      pspReference: body.pspReference,
      correlationId: createId("corr")
    });
  });

  app.post("/payments/:id/refund", async (request) => {
    const params = request.params as { id: string };
    const body = parse(RefundPaymentSchema, request.body ?? {});
    return refundPayment({
      context: request.userContext,
      paymentId: params.id,
      reason: body.reason ?? "Manual refund",
      correlationId: createId("corr")
    });
  });

  app.post("/folios/:id/close", async (request) => {
    const params = request.params as { id: string };
    return closeFolio({
      context: request.userContext,
      folioId: params.id,
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/invoices", async (request) => {
    const params = request.params as { propertyId: string };
    return listInvoices(params.propertyId);
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
    await assertInvoiceInOrg(params.id, request.userContext.organizationId);
    return getInvoice(params.id);
  });

  app.post("/folios/:id/invoice", async (request) => {
    const params = request.params as { id: string };
    const body = parse(IssueInvoiceSchema, request.body ?? {});
    return createInvoiceFromFolio({
      context: request.userContext,
      folioId: params.id,
      customerType: body.customerType,
      customerTaxId: body.customerTaxId,
      invoiceType: body.invoiceType,
      currencyCode: body.currencyCode,
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/:id/issue", async (request) => {
    const params = request.params as { id: string };
    return issueInvoice({
      context: request.userContext,
      invoiceId: params.id,
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/:id/cancel", async (request) => {
    const params = request.params as { id: string };
    const body = parse(CancelInvoiceSchema, request.body ?? {});
    return cancelInvoice({
      context: request.userContext,
      invoiceId: params.id,
      reason: body.reason ?? "Manual cancellation",
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/:id/rectify", async (request) => {
    const params = request.params as { id: string };
    const body = parse(RectifyInvoiceSchema, request.body ?? {});
    return createRectifyingInvoice({
      context: request.userContext,
      originalInvoiceId: params.id,
      reasonCode: body.reasonCode as RectifyingReasonCode,
      lineAdjustments: body.lineAdjustments as unknown as RectifyingLineAdjustment[] | undefined,
      fullReversal: body.fullReversal,
      correlationId: createId("corr")
    });
  });

  app.get("/invoices/:id/rectifications", async (request) => {
    const params = request.params as { id: string };
    return listRectifyingInvoices(params.id);
  });

  // --- Folio/Billing advanced (Sprint 40 — folio split, charge moves,
  //     invoice mark-paid, send-by-email). Idempotent endpoints suitable for
  //     AI-agent retries; payloads are validated inline rather than via Zod
  //     to keep the surface area minimal until the schemas land.
  app.post("/folios/:id/split", async (request) => {
    const params = request.params as { id: string };
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
    if (!body.targetFolioId) throw new BadRequestError("targetFolioId es obligatorio.");
    return moveChargesBetweenFolios({
      context: request.userContext,
      sourceFolioId: params.sourceId,
      targetFolioId: body.targetFolioId,
      chargeIds: Array.isArray(body.chargeIds) ? body.chargeIds : [],
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/:id/mark-paid", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as {
      method?: Parameters<typeof markInvoicePaid>[0]["method"];
      pspReference?: string;
      amount?: number;
    };
    return markInvoicePaid({
      context: request.userContext,
      invoiceId: params.id,
      method: body.method,
      pspReference: body.pspReference,
      amount: body.amount,
      correlationId: createId("corr")
    });
  });

  app.post("/invoices/:id/send-email", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as {
      recipient?: string;
      subject?: string;
      message?: string;
    };
    if (!body.recipient) throw new BadRequestError("recipient es obligatorio.");
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

  app.get("/organizations/:organizationId/accounts", async (request) => {
    // Serve the real seeded chart of accounts (Sprint 36 — 77 PGC accounts) for
    // this org. Fall back to the static template when the org has no rows yet so
    // the chart-of-accounts picker still renders during fresh setup.
    const { organizationId } = request.params as { organizationId: string };
    const { prisma } = await import("@hotelos/database");
    const rows = await prisma.account.findMany({
      where: { organizationId },
      select: { code: true, name: true, accountType: true },
      orderBy: { code: "asc" }
    });
    return rows.length > 0 ? rows : listAccounts();
  });

  app.get("/organizations/:organizationId/journal-entries", async (request) => {
    const params = request.params as { organizationId: string };
    return listJournalEntries(params.organizationId);
  });

  app.post("/journal-entries/drafts", async (request) => {
    const body = request.body as Omit<Parameters<typeof createJournalEntryDraft>[0], "organizationId"> & {
      organizationId?: string;
    };
    return createJournalEntryDraft({
      organizationId: body.organizationId ?? demoStore.organization.id,
      propertyId: body.propertyId ?? demoStore.property.id,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      lines: body.lines
    });
  });

  app.post("/journal-entries/:id/post", async (request) => {
    const params = request.params as { id: string };
    return postJournalEntry({
      context: request.userContext,
      journalEntryId: params.id,
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/supplier-bills", async (request) => {
    const params = request.params as { propertyId: string };
    return listSupplierBills(params.propertyId);
  });

  app.post("/supplier-bills/drafts", async (request) => {
    const body = request.body as Omit<Parameters<typeof createSupplierBillDraft>[0], "context" | "correlationId">;
    return createSupplierBillDraft({
      context: request.userContext,
      supplierName: body.supplierName,
      supplierTaxId: body.supplierTaxId,
      invoiceNumber: body.invoiceNumber,
      issueDate: body.issueDate,
      dueDate: body.dueDate,
      total: body.total,
      taxTotal: body.taxTotal,
      documentObjectKey: body.documentObjectKey,
      suggestedAccountCode: body.suggestedAccountCode,
      roomId: body.roomId,
      retentionRate: body.retentionRate,
      retentionAmount: body.retentionAmount,
      rowCode: body.rowCode,
      paymentDate: body.paymentDate,
      correlationId: createId("corr")
    });
  });

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
    const params = request.params as { id: string };
    const query = request.query as { asOf?: string };
    return getBankAccountBalance(params.id, query.asOf);
  });

  app.get("/banking/accounts/:id/statements", async (request) => {
    const params = request.params as { id: string };
    return listStatements(params.id);
  });

  app.post("/banking/accounts/:id/statements/import-csv", async (request) => {
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
    const params = request.params as { id: string };
    return getStatement(params.id);
  });

  app.post("/banking/statements/:id/auto-match", async (request) => {
    const params = request.params as { id: string };
    return autoMatchStatement(params.id);
  });

  app.post("/banking/lines/:bankLineId/match", async (request) => {
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
    const params = request.params as { bankLineId: string };
    return unmatch(params.bankLineId);
  });

  app.get("/banking/accounts/:id/reconciliation-status", async (request) => {
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
      propertyId: body.propertyId ?? demoStore.property.id,
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
    const body = request.body as {
      status?: Parameters<typeof updateHousekeepingTask>[0]["patch"]["status"];
      priority?: Parameters<typeof updateHousekeepingTask>[0]["patch"]["priority"];
      assignedTo?: string;
      dueAt?: string;
      note?: string;
    };

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
  app.post("/rooms/:id/housekeeping-status", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: string };
    const status = (body.status ?? "").toLowerCase();
    if (!status) throw new BadRequestError("status is required");
    const { prisma: db } = await import("@hotelos/database");
    // Mapeamos a RoomStatus si encaja, además de housekeepingStatus libre.
    const isClean = status === "clean" || status === "inspected" || status === "ready";
    const isDirty = status === "dirty" || status === "stayover";
    const updated = await db.room.update({
      where: { id: params.id },
      data: {
        housekeepingStatus: status,
        ...(isClean ? { status: "clean" as never } : isDirty ? { status: "dirty" as never } : {})
      }
    });
    return updated;
  });

  app.post("/rooms/:id/sellable", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { sellable?: boolean };
    if (typeof body.sellable !== "boolean") throw new BadRequestError("sellable boolean is required");
    const { prisma: db } = await import("@hotelos/database");
    return db.room.update({
      where: { id: params.id },
      data: { sellable: body.sellable }
    });
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
    const body = request.body as Parameters<typeof updateWorkOrder>[0]["patch"];
    return updateWorkOrder({
      context: request.userContext,
      workOrderId: params.id,
      patch: body,
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
  app.get("/compliance/health", async () => {
    const { getComplianceHealth } = await import("./modules/compliance/compliance-health.service.js");
    return getComplianceHealth();
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
    return updateComplianceTask({ context: request.userContext, taskId: (request.params as { id: string }).id, patch: request.body as never });
  });
  app.delete("/compliance/tasks/:id", async (request) => {
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
    return getComplianceAssistant((request.params as { propertyId: string }).propertyId);
  });
  app.post("/compliance/ocr/extract-dates", async (request) => {
    const body = request.body as { imageDataUrl?: string };
    if (!body.imageDataUrl) throw new BadRequestError("Falta la imagen del documento.");
    return extractComplianceDocumentDates(body.imageDataUrl);
  });

  // --- Cancellation policies + auto-charge engine ---
  app.get("/properties/:propertyId/cancellation-policies", async (request) => {
    return { items: await listCancellationPolicies((request.params as { propertyId: string }).propertyId) };
  });
  app.get("/cancellation-policies/:id", async (request) => {
    return getCancellationPolicy((request.params as { id: string }).id);
  });
  app.post("/properties/:propertyId/cancellation-policies", async (request) => {
    const params = request.params as { propertyId: string };
    return createCancellationPolicy({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never });
  });
  app.patch("/cancellation-policies/:id", async (request) => {
    return updateCancellationPolicy({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never });
  });
  app.delete("/cancellation-policies/:id", async (request) => {
    return deleteCancellationPolicy((request.params as { id: string }).id);
  });
  app.get("/reservations/:id/cancellation-charge", async (request) => {
    return computeCancellationCharge({ reservationId: (request.params as { id: string }).id });
  });
  app.post("/reservations/:id/apply-cancellation-fee", async (request) => {
    const id = (request.params as { id: string }).id;
    return applyCancellationFee({ context: request.userContext, reservationId: id, correlationId: createId("corr") });
  });
  app.post("/reservations/:id/apply-no-show-fee", async (request) => {
    const id = (request.params as { id: string }).id;
    return applyNoShowFee({ context: request.userContext, reservationId: id, correlationId: createId("corr") });
  });

  // --- Tour operators (B2B partners) + Allotments (contracted room blocks) ---
  app.get("/organizations/:organizationId/tour-operators", async (request) => {
    return { items: await listTourOperators((request.params as { organizationId: string }).organizationId) };
  });
  app.get("/tour-operators/:id", async (request) => {
    return getTourOperator((request.params as { id: string }).id);
  });
  app.post("/organizations/:organizationId/tour-operators", async (request) => {
    const params = request.params as { organizationId: string };
    return createTourOperator({ context: request.userContext, organizationId: params.organizationId, payload: request.body as never });
  });
  app.patch("/tour-operators/:id", async (request) => {
    return updateTourOperator({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never });
  });
  app.get("/properties/:propertyId/allotments", async (request) => {
    return { items: await listAllotments((request.params as { propertyId: string }).propertyId) };
  });
  app.get("/allotments/:id", async (request) => {
    return getAllotment((request.params as { id: string }).id);
  });
  app.get("/allotments/:id/remaining", async (request) => {
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
    return updateAllotment({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never });
  });
  app.delete("/allotments/:id", async (request) => {
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
    return { items: await listReservationFolios((request.params as { id: string }).id) };
  });
  app.post("/reservations/:id/folios", async (request) => {
    const id = (request.params as { id: string }).id;
    return createSecondaryFolio({ context: request.userContext, reservationId: id, payload: request.body as never });
  });
  app.get("/reservations/:id/routing-rules", async (request) => {
    return { items: await listRoutingRules((request.params as { id: string }).id) };
  });
  app.post("/reservations/:id/routing-rules", async (request) => {
    const id = (request.params as { id: string }).id;
    return createRoutingRule({ context: request.userContext, reservationId: id, payload: request.body as never });
  });
  app.patch("/routing-rules/:id", async (request) => {
    return updateRoutingRule({ context: request.userContext, id: (request.params as { id: string }).id, payload: request.body as never });
  });
  app.delete("/routing-rules/:id", async (request) => {
    return deleteRoutingRule((request.params as { id: string }).id);
  });
  app.post("/folio-lines/:lineId/transfer", async (request) => {
    const lineId = (request.params as { lineId: string }).lineId;
    const body = request.body as { targetFolioId?: string };
    if (!body.targetFolioId) throw new BadRequestError("targetFolioId es obligatorio.");
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
    return getMenuItemWithRecipe((request.params as { id: string }).id);
  });
  app.post("/properties/:propertyId/menu-items", async (request) => {
    const params = request.params as { propertyId: string };
    return createMenuItem({ context: request.userContext, propertyId: params.propertyId, payload: request.body as never });
  });
  app.post("/menu-items/:id/recipes", async (request) => {
    const id = (request.params as { id: string }).id;
    return addMenuRecipe({ context: request.userContext, menuItemId: id, payload: request.body as never });
  });
  app.delete("/menu-recipes/:id", async (request) => {
    return deleteMenuRecipe((request.params as { id: string }).id);
  });

  // --- Point of sale (TPV) ---
  app.get("/properties/:propertyId/pos/outlets", async (request) => {
    return listPosOutlets((request.params as { propertyId: string }).propertyId);
  });
  app.get("/properties/:propertyId/pos/tickets", async (request) => {
    return listPosTickets((request.params as { propertyId: string }).propertyId);
  });
  app.post("/pos/tickets", async (request) => {
    const body = request.body as { propertyId?: string; outletId: string; roomNumber?: string };
    return openPosTicket({ propertyId: body.propertyId ?? demoStore.property.id, outletId: body.outletId, roomNumber: body.roomNumber });
  });
  app.post("/pos/tickets/:id/lines", async (request) => {
    const body = request.body as { name: string; quantity?: number; unitPrice: number };
    return addPosLine({ ticketId: (request.params as { id: string }).id, name: body.name, quantity: body.quantity ?? 1, unitPrice: body.unitPrice });
  });
  app.post("/pos/tickets/:id/close", async (request) => {
    const body = request.body as { settlement: "room" | "cash" | "card" };
    return closePosTicket({ context: request.userContext, ticketId: (request.params as { id: string }).id, settlement: body.settlement, correlationId: createId("corr") });
  });

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
      propertyId: body.propertyId ?? demoStore.property.id,
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
      propertyId: body.propertyId ?? demoStore.property.id,
      name: body.name,
      description: body.description,
      budget: body.budget,
      startDate: body.startDate,
      targetEndDate: body.targetEndDate,
      correlationId: createId("corr")
    });
  });

  app.patch("/capex-projects/:id", async (request) => {
    const params = request.params as { id: string };
    return updateCapexProject({
      context: request.userContext,
      capexProjectId: params.id,
      patch: request.body as Parameters<typeof updateCapexProject>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/capex-projects/:id/items", async (request) => {
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
    const params = request.params as { id: string };
    return listMessages(params.id);
  });

  app.post("/conversations/:id/messages", async (request) => {
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
      propertyId: body.propertyId ?? demoStore.property.id,
      reservationId: body.reservationId,
      guestId: body.guestId,
      requestType: body.requestType,
      assignedDepartment: body.assignedDepartment,
      correlationId: createId("corr")
    });
  });

  app.patch("/service-requests/:id", async (request) => {
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
    await assertReservationInOrg(params.reservationId, request.userContext.organizationId);
    return listReservationGuestRegisterRecords(params.reservationId);
  });

  app.post("/compliance/spain/reservations/:reservationId/guest-register", async (request) => {
    const params = request.params as { reservationId: string };
    const body = request.body as Parameters<typeof createSpainGuestRegisterRecord>[0]["payload"] & { propertyId?: string };
    return createSpainGuestRegisterRecord({
      context: request.userContext,
      propertyId: body.propertyId ?? request.userContext.propertyId,
      reservationId: params.reservationId,
      payload: body,
      correlationId: createId("corr")
    });
  });

  app.patch("/compliance/spain/guest-register/:recordId", async (request) => {
    const params = request.params as { recordId: string };
    return patchSpainGuestRegisterRecord({
      context: request.userContext,
      recordId: params.recordId,
      patch: request.body as Parameters<typeof patchSpainGuestRegisterRecord>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/guest-register/:recordId/validate", async (request) => {
    const params = request.params as { recordId: string };
    return validateSpainGuestRegisterRecordApi({ context: request.userContext, recordId: params.recordId, correlationId: createId("corr") });
  });

  app.post("/compliance/spain/guest-register/:recordId/sign", async (request) => {
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
    const params = request.params as { recordId: string };
    return correctSpainGuestRegisterRecord({
      context: request.userContext,
      recordId: params.recordId,
      patch: request.body as Parameters<typeof correctSpainGuestRegisterRecord>[0]["patch"],
      correlationId: createId("corr")
    });
  });

  app.post("/compliance/spain/guest-register/:recordId/annul", async (request) => {
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

  app.get("/compliance/authority/properties/:propertyId/inbox", async (request) => {
    const params = request.params as { propertyId: string };
    return getAuthorityInbox(params.propertyId);
  });

  app.get("/compliance/authority/properties/:propertyId/submissions", async (request) => {
    const params = request.params as { propertyId: string };
    return listAuthoritySubmissions(params.propertyId);
  });

  app.get("/compliance/authority/submissions/:submissionId", async (request) => {
    const params = request.params as { submissionId: string };
    return getAuthoritySubmission({ context: request.userContext, submissionId: params.submissionId, correlationId: createId("corr") });
  });

  app.post("/compliance/authority/submissions/:submissionId/retry", async (request) => {
    const params = request.params as { submissionId: string };
    return retryAuthoritySubmission({ context: request.userContext, submissionId: params.submissionId, correlationId: createId("corr") });
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
    const params = request.params as { id: string };
    return correctGuestRegisterRecord({
      context: request.userContext,
      guestRegisterRecordId: params.id,
      fields: request.body as CheckInFromScanRequest["documentExtractedFields"],
      correlationId: createId("corr")
    });
  });

  app.post("/guest-register-records/:id/queue-ses", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { submissionType?: "reservation" | "checkin" | "cancellation" };
    return queueSesHospedajesSubmission({
      context: request.userContext,
      guestRegisterRecordId: params.id,
      submissionType: body.submissionType ?? "checkin",
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/ses-hospedajes/submissions", async (request) => {
    const params = request.params as { propertyId: string };
    return listSesHospedajesSubmissions(params.propertyId);
  });

  app.patch("/ses-hospedajes/submissions/:id/status", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as {
      status: Parameters<typeof updateSesHospedajesSubmissionStatus>[0]["status"];
      responsePayloadJson?: Record<string, unknown>;
      errorMessage?: string;
    };
    return updateSesHospedajesSubmissionStatus({
      context: request.userContext,
      submissionId: params.id,
      status: body.status,
      responsePayloadJson: body.responsePayloadJson,
      errorMessage: body.errorMessage,
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
    const found = await assertGdprRequestInOrg(params.id, request.userContext.organizationId);
    return found;
  });

  app.post("/gdpr/requests/:id/acknowledge", async (request) => {
    const params = request.params as { id: string };
    await assertGdprRequestInOrg(params.id, request.userContext.organizationId);
    return gdprAcknowledgeRequest(params.id, request.userContext.userId);
  });

  app.post("/gdpr/requests/:id/fulfill-dsar", async (request) => {
    const params = request.params as { id: string };
    await assertGdprRequestInOrg(params.id, request.userContext.organizationId);
    return gdprFulfillDsar(params.id, request.userContext.userId);
  });

  app.post("/gdpr/requests/:id/execute-erasure", async (request) => {
    const params = request.params as { id: string };
    await assertGdprRequestInOrg(params.id, request.userContext.organizationId);
    const body = parse(ExecuteErasureSchema, request.body ?? {});
    return gdprExecuteErasure(params.id, request.userContext.userId, {
      confirmRetentionOverride: Boolean(body.confirmRetentionOverride)
    });
  });

  app.post("/gdpr/requests/:id/reject", async (request) => {
    const params = request.params as { id: string };
    await assertGdprRequestInOrg(params.id, request.userContext.organizationId);
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
      property?: { name?: string; type?: string; municipality?: string; province?: string };
      ownerUser?: { email?: string; fullName?: string; phone?: string };
      modulesEnabled?: string[];
    };
    const ownerEmail = body.ownerUser?.email ?? body.ownerEmail ?? "";
    return createTenant({
      context: request.userContext,
      organizationName: body.organizationName ?? body.name ?? "",
      organizationCountry: body.organizationCountry ?? body.country ?? "ES",
      property: {
        name: body.property?.name ?? body.propertyName ?? body.name ?? "",
        type: body.property?.type ?? body.propertyType ?? "hotel",
        // el wizard (NewTenantWizardDialog) envía municipality/province PLANOS
        municipality: body.property?.municipality ?? body.municipality,
        province: body.property?.province ?? body.province
      },
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
  app.post('/admin/tenants/:orgId/users/:userId/reset-password', async (request) => regenerateTempPassword({ context: request.userContext, userId: (request.params as any).userId }));
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
    const ctx = request.userContext;
    const startedAt = Date.now();
    let docResult: Awaited<ReturnType<typeof llmExtractDocument>>;
    let errorMessage: string | undefined;
    try {
      docResult = await llmExtractDocument(body.imageDataUrl);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      docResult = { configured: false, reason: errorMessage };
    }
    await recordToolCall({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      userId: ctx.userId,
      toolName: "scan_id_document",
      status: errorMessage ? "failed" : docResult.configured ? "completed" : "skipped",
      inputJson: { hasImage: true },
      outputJson: docResult.configured ? { fields: docResult.fields } : { configured: false },
      model: docResult.configured ? docResult.model : undefined,
      latencyMs: Date.now() - startedAt,
      tokensInput: docResult.configured ? docResult.tokensInput : undefined,
      tokensOutput: docResult.configured ? docResult.tokensOutput : undefined,
      errorMessage,
      automationLevel: "suggest_and_confirm",
      requiredConfirmation: true
    }).catch(() => undefined);

    if (!docResult.configured) {
      return {
        configured: false,
        fields: {},
        source: "manual",
        message: errorMessage
          ? "El escaneo con IA no está disponible ahora; introduzca los datos manualmente."
          : "OCR no configurado. Introduzca los datos manualmente o configure un proveedor de IA."
      };
    }
    return { configured: true, fields: docResult.fields, source: "ai" };
  });

  // LLM-assisted mapping suggestion for the onboarding mapping review (P2). The
  // deterministic mapping engine remains the source of truth; this only proposes
  // a canonical target for a LOW-CONFIDENCE source value, which a human must
  // still approve. When no AI provider is configured it returns configured:false.
  app.post("/onboarding/ai/suggest-mapping", async (request) => {
    const body = (request.body ?? {}) as { sourceValue?: string; targetType?: string };
    if (!body.sourceValue || !body.targetType) {
      throw new BadRequestError("sourceValue and targetType are required.");
    }
    const catalogByType: Record<string, Array<{ target: string; aliases: string[] }>> = {
      room_type: MAPPING_CATALOGS.ROOM_TYPE_CATALOG,
      rate_plan: MAPPING_CATALOGS.RATE_CODE_CATALOG,
      channel: MAPPING_CATALOGS.CHANNEL_CATALOG
    };
    const catalog = catalogByType[body.targetType];
    if (!catalog) {
      return { configured: false, message: `No hay catálogo de destinos para "${body.targetType}".` };
    }
    if (!isLlmConfigured()) {
      return { configured: false, message: "IA no configurada. Edita el destino a mano o configura un proveedor de IA." };
    }
    const candidates = catalog.map((c) => c.target);
    const ctx = request.userContext;
    const startedAt = Date.now();
    let suggestion: { target: string; confidence: number; rationale: string } | undefined;
    let errorMessage: string | undefined;
    let model: string | undefined;
    let tokensInput: number | undefined;
    let tokensOutput: number | undefined;
    try {
      const r = await llmComplete({
        system:
          "Eres un experto en mapeo de datos para un PMS hotelero. Dado un VALOR DE ORIGEN y una lista de DESTINOS " +
          "canónicos, elige el destino que mejor corresponde. Devuelve EXCLUSIVAMENTE un JSON " +
          '{"target": string, "confidence": number entre 0 y 1, "rationale": string breve en español}. ' +
          "El target DEBE ser exactamente uno de los destinos de la lista; si ninguno encaja, devuelve target vacío.",
        prompt: `VALOR DE ORIGEN: ${body.sourceValue}\nDESTINOS DISPONIBLES: ${candidates.join(", ")}`,
        maxTokens: 150
      });
      if (r.configured) {
        model = r.model;
        tokensInput = r.tokensInput;
        tokensOutput = r.tokensOutput;
        const start = r.text.indexOf("{");
        const end = r.text.lastIndexOf("}");
        if (start !== -1 && end > start) {
          const obj = JSON.parse(r.text.slice(start, end + 1)) as {
            target?: unknown;
            confidence?: unknown;
            rationale?: unknown;
          };
          const target = typeof obj.target === "string" ? obj.target.trim() : "";
          const valid = candidates.find((c) => c.toLowerCase() === target.toLowerCase()) ?? "";
          const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
          const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
          suggestion = { target: valid, confidence: valid ? confidence : 0, rationale };
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    await recordToolCall({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      userId: ctx.userId,
      toolName: "onboarding_mapping_suggest",
      status: errorMessage ? "failed" : suggestion ? "completed" : "skipped",
      inputJson: { sourceValue: body.sourceValue, targetType: body.targetType },
      outputJson: suggestion ? { suggestion } : { suggestion: null },
      confidence: suggestion?.confidence,
      model,
      latencyMs: Date.now() - startedAt,
      tokensInput,
      tokensOutput,
      errorMessage,
      automationLevel: "suggest_and_confirm",
      requiredConfirmation: true
    }).catch(() => undefined);

    if (!suggestion || !suggestion.target) {
      return { configured: true, suggestion: null, message: errorMessage ?? "La IA no encontró un destino claro." };
    }
    return { configured: true, suggestion };
  });

  app.post("/ai/confirmations/:confirmationId/execute", async (request) => {
    const params = request.params as { confirmationId: string };
    const body = request.body as { signatureObjectKey?: string };
    return executeConfirmation({
      context: request.userContext,
      confirmationId: params.confirmationId,
      signatureObjectKey: body.signatureObjectKey ?? "sig_demo_guest",
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/night-audit/business-date", async (request) => {
    const params = request.params as { propertyId: string };
    const current = await getCurrentBusinessDate(params.propertyId);
    return { propertyId: params.propertyId, currentDate: current };
  });

  app.get("/properties/:propertyId/night-audit/runs", async (request) => {
    const params = request.params as { propertyId: string };
    return listNightAuditRuns(params.propertyId);
  });

  app.post("/properties/:propertyId/night-audit/run", async (request) => {
    const params = request.params as { propertyId: string };
    return runNightAudit({
      context: request.userContext,
      propertyId: params.propertyId,
      correlationId: createId("corr")
    });
  });

  app.get("/properties/:propertyId/night-audit/preflight", async (request) => {
    const params = request.params as { propertyId: string };
    const { buildPreflight } = await import("./modules/night-audit/night-audit-preflight.service.js");
    return buildPreflight({ propertyId: params.propertyId });
  });

  app.get("/accounting/journal-entries/recent", async (request) => {
    const params = (request.query as { propertyId?: string; limit?: string }) ?? {};
    const limit = Math.min(Number(params.limit ?? 50), 200);
    const entries = await (await import("@hotelos/database")).prisma.journalEntry.findMany({
      where: params.propertyId ? { propertyId: params.propertyId } : undefined,
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
    const params = request.params as { id: string };
    return getFiscalYearStatus({ context: request.userContext, id: params.id });
  });

  app.post("/accounting/fiscal-years/:id/close", async (request) => {
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

  app.get("/properties/:propertyId/verifactu/submissions", async (request) => {
    const params = request.params as { propertyId: string };
    return listVerifactuSubmissions(params.propertyId);
  });

  app.get("/invoices/:id/verifactu", async (request) => {
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

  app.get("/properties/:propertyId/ses/submissions", async (request) => {
    const params = request.params as { propertyId: string };
    return listSesSubmissions(params.propertyId);
  });

  // Parte de viajeros SES.HOSPEDAJES: encola el envío del registro de una reserva
  // por el pipeline real (persiste en Prisma `SesHospedajesSubmission`). Antes esta
  // ruta NO existía — el check-in (QuickCheckInDrawer) hacía POST aquí y recibía un
  // 404 tragado en silencio, con UI de éxito falsa (auditoría 2026-06 · crítico SES).
  // Encola los registros ya creados de la reserva; si aún no hay ninguno, devuelve
  // estado claro en vez de fallar. El envío real al MIR requiere además
  // SES_HOSPEDAJES_MODE=production + certificado (hoy stub sandbox).
  app.post("/properties/:propertyId/ses/submissions", async (request) => {
    const params = request.params as { propertyId: string };
    const body = (request.body ?? {}) as { reservationId?: string };
    await assertPropertyInOrg(params.propertyId, request.userContext.organizationId);
    if (!body.reservationId) {
      throw new BadRequestError("reservationId es obligatorio para el parte de viajeros.");
    }
    await assertReservationInOrg(body.reservationId, request.userContext.organizationId);
    const records = listReservationGuestRegisterRecords(body.reservationId);
    const submissions = records.map((record) =>
      queueSesHospedajesSubmission({
        context: request.userContext,
        guestRegisterRecordId: record.id,
        submissionType: "checkin",
        correlationId: createId("corr")
      })
    );
    return {
      status: submissions.length > 0 ? "queued" : "no_records",
      queued: submissions.length,
      submissions
    };
  });

  // Single-submission detail endpoints (full XML + response ACK + history)
  app.get("/verifactu/submissions/:id", async (request) => {
    const params = request.params as { id: string };
    const sub = await getVerifactuSubmissionById(params.id);
    if (!sub) return { status: "not_found" };
    return sub;
  });

  app.get("/tbai/submissions/:id", async (request) => {
    const params = request.params as { id: string };
    const sub = await getTbaiSubmission(params.id);
    if (!sub) return { status: "not_found" };
    return sub;
  });

  app.get("/igic/submissions/:id", async (request) => {
    const params = request.params as { id: string };
    const sub = await getIgicSubmission(params.id);
    if (!sub) return { status: "not_found" };
    return sub;
  });

  app.get("/ses/submissions/:id", async (request) => {
    const params = request.params as { id: string };
    const sub = await getSesSubmission(params.id);
    if (!sub) return { status: "not_found" };
    return sub;
  });

  // Manual retry endpoints (also picked up automatically by pg-boss cron)
  app.post("/verifactu/submissions/:id/retry", async (request) => {
    const params = request.params as { id: string };
    await retryVerifactuSubmission(params.id);
    return { status: "queued" };
  });

  app.post("/tbai/submissions/:id/retry", async (request) => {
    const params = request.params as { id: string };
    await retryTbaiSubmission(params.id);
    return { status: "queued" };
  });

  app.post("/igic/submissions/:id/retry", async (request) => {
    const params = request.params as { id: string };
    await retryIgicSubmission(params.id);
    return { status: "queued" };
  });

  app.post("/ses/submissions/:id/retry", async (request) => {
    const params = request.params as { id: string };
    await retrySesSubmission(params.id, request.userContext);
    return { status: "queued" };
  });

  app.get("/accounting/reports/modelo-303", async (request) => {
    const query = request.query as { propertyId?: string; fromDate: string; toDate: string; periodType?: "monthly" | "quarterly" };
    return buildModelo303({
      context: request.userContext,
      propertyId: query.propertyId,
      fromDate: query.fromDate,
      toDate: query.toDate,
      periodType: query.periodType
    });
  });

  app.get("/accounting/reports/modelo-111", async (request) => {
    const query = request.query as { propertyId?: string; fromDate: string; toDate: string; periodType?: "monthly" | "quarterly" };
    return buildModelo111({
      context: request.userContext,
      propertyId: query.propertyId,
      fromDate: query.fromDate,
      toDate: query.toDate,
      periodType: query.periodType
    });
  });

  app.get("/accounting/reports/modelo-115", async (request) => {
    const query = request.query as { propertyId?: string; fromDate: string; toDate: string; periodType?: "monthly" | "quarterly" };
    return buildModelo115({
      context: request.userContext,
      propertyId: query.propertyId,
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
    const propertyId = query.propertyId ?? "prop_123";
    return listCommissionRules(propertyId);
  });

  app.post("/commissions/rules", async (request) => {
    const body = request.body as {
      propertyId: string;
      channelId?: string | null;
      channelCode?: string | null;
      ratePct: number | string;
      appliesTo?: "gross_revenue" | "net_revenue" | "total";
      ledgerAccountCode?: string;
      effectiveFrom?: string;
      effectiveTo?: string;
    };
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
    const propertyId = query.propertyId ?? "prop_123";
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
    const propertyId = query.propertyId ?? "prop_123";
    return commissionSummary(propertyId, query.from, query.to);
  });

  // Payroll bridge to gestoría (Sprint 23 — Track 5)
  app.get("/payroll/contracts", async (request) => {
    const query = request.query as { organizationId?: string; propertyId?: string };
    const organizationId = query.organizationId ?? request.userContext.organizationId;
    return listPayrollContracts(organizationId, query.propertyId);
  });

  app.post("/payroll/contracts", async (request) => {
    const body = request.body as {
      staffProfileId: string;
      propertyId?: string;
      contractType: string;
      startDate: string;
      endDate?: string;
      grossSalary: number;
      payFrequency?: string;
      payCount?: number;
      irpfRatePct?: number;
      socialSecurityCategory?: string;
      costCenterId?: string;
    };
    return createPayrollContract({
      context: request.userContext,
      staffProfileId: body.staffProfileId,
      propertyId: body.propertyId,
      contractType: body.contractType,
      startDate: body.startDate,
      endDate: body.endDate,
      grossSalary: Number(body.grossSalary),
      payFrequency: body.payFrequency,
      payCount: body.payCount,
      irpfRatePct: body.irpfRatePct === undefined ? undefined : Number(body.irpfRatePct),
      socialSecurityCategory: body.socialSecurityCategory,
      costCenterId: body.costCenterId,
      correlationId: createId("corr")
    });
  });

  app.post("/payroll/contracts/:id/deactivate", async (request) => {
    const params = request.params as { id: string };
    return deactivatePayrollContract({
      context: request.userContext,
      contractId: params.id,
      correlationId: createId("corr")
    });
  });

  app.get("/payroll/periods", async (request) => {
    const query = request.query as { organizationId?: string };
    const organizationId = query.organizationId ?? request.userContext.organizationId;
    return listPayrollPeriods(organizationId);
  });

  app.post("/payroll/periods", async (request) => {
    const body = request.body as { organizationId?: string; propertyId?: string; periodCode: string };
    const organizationId = body.organizationId ?? request.userContext.organizationId;
    return createPayrollPeriod({
      context: request.userContext,
      organizationId,
      propertyId: body.propertyId,
      periodCode: body.periodCode,
      correlationId: createId("corr")
    });
  });

  app.post("/payroll/periods/:id/calculate", async (request) => {
    const params = request.params as { id: string };
    return calculatePayrollPeriod({
      context: request.userContext,
      periodId: params.id,
      correlationId: createId("corr")
    });
  });

  app.get("/payroll/periods/:id/slips", async (request) => {
    const params = request.params as { id: string };
    return listPayrollSlipsForPeriod(params.id);
  });

  app.get("/payroll/periods/:id/export", async (request) => {
    const params = request.params as { id: string };
    const query = request.query as { format?: "a3" | "sage" };
    const format = query.format === "sage" ? "sage" : "a3";
    const result =
      format === "sage"
        ? await exportPeriodSageFormat({
            context: request.userContext,
            periodId: params.id,
            correlationId: createId("corr")
          })
        : await exportPeriodA3Format({
            context: request.userContext,
            periodId: params.id,
            correlationId: createId("corr")
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
    const orgFilter = q.organizationId === "global" || q.organizationId === "null"
      ? null
      : q.organizationId && q.organizationId.length > 0
        ? q.organizationId
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
      : body.organizationId ?? request.userContext.organizationId;
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
    return buildHousekeepingDashboard({ propertyId: q.propertyId ?? "prop_123", date: q.date });
  });
  app.get("/dashboards/front-desk", async (request) => {
    const q = request.query as { propertyId?: string; date?: string };
    return buildFrontDeskDashboard({ propertyId: q.propertyId ?? "prop_123", date: q.date });
  });
  app.get("/dashboards/front-desk-queue", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildFrontDeskQueue({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/dashboards/room-rack", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildRoomRack({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/dashboards/housekeeping-mobile", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildHousekeepingMobile({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/dashboards/maintenance-mobile", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildMaintenanceMobile({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/dashboards/shift-manager", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildShiftManager({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/dashboards/general-manager", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildGmDashboard({ propertyId: q.propertyId ?? "prop_123" });
  });
  // Pace de los próximos N días (default 30): OTB vs forecast vs LY por stay date.
  app.get("/general-manager/pace", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    const days = q.days ? Number.parseInt(q.days, 10) : 30;
    return buildGmPace({
      propertyId: q.propertyId ?? "prop_123",
      days: Number.isFinite(days) ? days : 30
    });
  });
  app.get("/dashboards/operations-director", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildOperationsDirector({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/developer/api-reference", async () => buildApiReference());
  app.get("/developer/keyboard-shortcuts", async () => ({
    categories: [
      {
        category: "Global",
        shortcuts: [
          { keys: "Cmd+K", action: "Open command palette" },
          { keys: "Cmd+/", action: "Toggle help" },
          { keys: "Cmd+,", action: "Open preferences" },
          { keys: "Cmd+Shift+P", action: "Quick switcher" },
          { keys: "Esc", action: "Close dialog/popover" }
        ]
      },
      {
        category: "Navigation",
        shortcuts: [
          { keys: "Cmd+1", action: "Go to Dashboard" },
          { keys: "Cmd+2", action: "Go to Reservations" },
          { keys: "Cmd+3", action: "Go to Front Desk" },
          { keys: "Cmd+4", action: "Go to Housekeeping" },
          { keys: "Cmd+5", action: "Go to Reports" },
          { keys: "Cmd+[", action: "Back" },
          { keys: "Cmd+]", action: "Forward" }
        ]
      },
      {
        category: "Reservations",
        shortcuts: [
          { keys: "Cmd+N", action: "New reservation" },
          { keys: "Cmd+F", action: "Find reservation" },
          { keys: "Cmd+E", action: "Edit selected reservation" },
          { keys: "Cmd+Shift+C", action: "Check-in selected reservation" },
          { keys: "Cmd+Shift+O", action: "Check-out selected reservation" },
          { keys: "Cmd+D", action: "Duplicate reservation" },
          { keys: "Cmd+Backspace", action: "Cancel reservation" }
        ]
      },
      {
        category: "Groups",
        shortcuts: [
          { keys: "Cmd+Shift+G", action: "New group block" },
          { keys: "Cmd+Shift+R", action: "Add rooming list entry" },
          { keys: "Cmd+Shift+B", action: "Open block manager" },
          { keys: "Cmd+Shift+I", action: "Import rooming list" },
          { keys: "Cmd+Shift+E", action: "Export rooming list" }
        ]
      }
    ]
  }));
  app.get("/copilot/presets", async () => ({ items: COPILOT_PRESET_QUESTIONS }));
  app.post("/copilot/ask", async (request) => {
    const body = (request.body ?? {}) as { propertyId?: string; question?: string };
    return answerCopilot({
      propertyId: body.propertyId ?? "prop_123",
      question: (body.question ?? "").trim()
    });
  });
  app.get("/dashboards/maintenance", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildMaintenanceDashboard({ propertyId: q.propertyId ?? "prop_123", from: q.from, to: q.to });
  });
  app.get("/dashboards/finance-position", async (request) => {
    const q = request.query as { propertyId?: string; asOf?: string };
    return buildFinancePositionDashboard({ propertyId: q.propertyId ?? "prop_123", asOf: q.asOf ? new Date(q.asOf) : undefined });
  });
  app.get("/dashboards/concierge", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildConciergeDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/reputation", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildReputationDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/sales-pipeline", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildSalesPipelineDashboard({ propertyId: q.propertyId ?? "prop_123", from: q.from, to: q.to });
  });

  // Operational dashboards (Sprint 15 — P1.a)
  app.get("/dashboards/workforce", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildWorkforceDashboard({ propertyId: q.propertyId ?? "prop_123", from: q.from, to: q.to });
  });
  app.get("/dashboards/crm", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildCrmDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/loyalty", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildLoyaltyDashboard({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/dashboards/upsells", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildUpsellsDashboard({ propertyId: q.propertyId ?? "prop_123", from: q.from, to: q.to });
  });
  app.get("/dashboards/surveys", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildSurveysDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/quality", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildQualityDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });

  // Operational dashboards (Sprint 16 — P1.b + P2.a)
  app.get("/dashboards/safety", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildSafetyDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/inventory", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildInventoryDashboard({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/dashboards/procurement", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildProcurementDashboard({ propertyId: q.propertyId ?? "prop_123", from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined });
  });
  app.get("/dashboards/groups-events", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildGroupsEventsDashboard({ propertyId: q.propertyId ?? "prop_123", from: q.from, to: q.to });
  });
  app.get("/dashboards/pos", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildPosDashboard({ propertyId: q.propertyId ?? "prop_123", from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined });
  });
  app.get("/dashboards/channel-performance", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildChannelPerformanceDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });

  // SiteMinder-style channel manager / OTA aggregator (Sprint 28)
  app.get("/channel-manager/channels", async (request) => {
    const q = request.query as { propertyId?: string; active?: string };
    return {
      channels: await listChannelManagerChannels({
        propertyId: q.propertyId ?? "prop_123",
        active: q.active === undefined ? undefined : q.active === "true"
      })
    };
  });
  app.post("/channel-manager/channels", async (request) => {
    const body = (request.body ?? {}) as {
      propertyId?: string;
      providerCode: string;
      displayName: string;
      credentialsJson?: Record<string, unknown> | null;
    };
    if (!body.providerCode || !body.displayName) {
      throw new BadRequestError("providerCode and displayName are required.");
    }
    return createChannelManagerChannel({
      propertyId: body.propertyId ?? "prop_123",
      providerCode: body.providerCode,
      displayName: body.displayName,
      credentialsJson: body.credentialsJson ?? null
    });
  });
  app.post("/channel-manager/channels/:channelId/test", async (request) => {
    const params = request.params as { channelId: string };
    return testChannelManagerChannel(params.channelId);
  });
  app.post("/channel-manager/channels/:channelId/ingest", async (request) => {
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
      propertyId: body.propertyId ?? "prop_123",
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
      propertyId: body.propertyId ?? "prop_123",
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
      propertyId: body.propertyId ?? "prop_123",
      dateRange: { from: body.from, to: body.to },
      channelIds: body.channelIds
    });
  });
  app.post("/channel-manager/ingest-all", async (request) => {
    const body = (request.body ?? {}) as { propertyId?: string; since?: string };
    return ingestAllChannelReservations({
      propertyId: body.propertyId ?? "prop_123",
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
        propertyId: q.propertyId ?? "prop_123",
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
      propertyId: body.propertyId ?? "prop_123",
      dateRange: { from: body.from, to: body.to },
      thresholdPercent: body.thresholdPercent
    });
  });
  app.get("/channel-manager/parity/alerts", async (request) => {
    const q = request.query as { propertyId?: string; status?: string; severity?: string };
    return {
      alerts: await listChannelParityAlerts({
        propertyId: q.propertyId ?? "prop_123",
        status: q.status,
        severity: q.severity
      })
    };
  });
  app.post("/channel-manager/parity/alerts/:id/resolve", async (request) => {
    const params = request.params as { id: string };
    return resolveChannelParityAlert(params.id, request.userContext?.userId ?? "user_demo");
  });

  // Sprint 44: local "sandbox" mock OTA endpoint. Registered as a public (loopback
  // test) target so a channel adapter in sandbox mode can do a REAL HTTP
  // round-trip — proving the network path works — without external credentials.
  // Accepts whatever XML/JSON body the adapter sends and echoes a realistic
  // success envelope. Counts the items in the body so the confirmation looks live.
  app.post("/channel-manager/_sandbox/:provider", async (request) => {
    const params = request.params as { provider: string };
    const raw = request.body;
    let bodyText = "";
    if (typeof raw === "string") {
      bodyText = raw;
    } else if (raw && typeof raw === "object") {
      try { bodyText = JSON.stringify(raw); } catch { bodyText = ""; }
    }
    // Rough item count: number of self-closing leaf nodes in the XML payload
    // (rate / room / restriction), falling back to 1 so a non-empty probe still
    // confirms. Empty probe bodies (e.g. a credentials test) confirm with 0.
    const leafMatches = bodyText.match(/<(?:rate|room|restriction)\b[^>]*\/>/gi);
    const itemCount = leafMatches ? leafMatches.length : 0;
    const confirmations = Array.from({ length: itemCount }, (_, i) => ({
      index: i,
      confirmationId: `${params.provider}-sbx-${createId("conf")}`,
      accepted: true
    }));
    return {
      status: "ok",
      provider: params.provider,
      receivedBytes: bodyText.length,
      confirmations
    };
  });

  // Operational dashboards (Sprint 17 — P2.b)
  app.get("/dashboards/energy", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildEnergyDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/sustainability", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildSustainabilityDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });
  app.get("/dashboards/assets", async (request) => {
    const q = request.query as { propertyId?: string };
    return buildAssetsDashboard({ propertyId: q.propertyId ?? "prop_123" });
  });
  app.get("/dashboards/room-profitability", async (request) => {
    const q = request.query as { propertyId?: string; from?: string; to?: string };
    return buildRoomProfitabilityDashboard({ propertyId: q.propertyId ?? "prop_123", from: q.from, to: q.to });
  });
  app.get("/dashboards/analytics-center", async (request) => {
    const q = request.query as { propertyId?: string; days?: string };
    return buildAnalyticsCenterDashboard({ propertyId: q.propertyId ?? "prop_123", days: q.days ? Number(q.days) : undefined });
  });

  // Portfolio dashboard (Sprint 38 — multi-property org-level consolidation)
  app.get("/dashboards/portfolio", async (request) => {
    const q = request.query as { organizationId?: string; asOf?: string };
    const organizationId = q.organizationId ?? request.userContext.organizationId ?? "org_123";
    return buildPortfolioDashboard({ organizationId, asOf: q.asOf });
  });

  // Property overview drill-down (Sprint 41 — single-property detail screen)
  app.get("/dashboards/property-overview", async (request) => {
    const q = request.query as { propertyId?: string; asOf?: string };
    return buildPropertyOverview({ propertyId: q.propertyId ?? "prop_123", asOf: q.asOf });
  });

  // Notification engine (Sprint 26 — Track: Notifications + document templates)
  app.get("/notifications/templates", async (request) => {
    const q = request.query as { organizationId?: string; propertyId?: string; channel?: string };
    const organizationId = q.organizationId ?? request.userContext.organizationId;
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
      organizationId: body.organizationId ?? request.userContext.organizationId,
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
    const organizationId = q.organizationId ?? request.userContext.organizationId;
    return listNotificationDeliveries({
      organizationId,
      propertyId: q.propertyId,
      status: q.status,
      channel: q.channel,
      days: q.days ? Number(q.days) : undefined,
      limit: q.limit ? Number(q.limit) : undefined
    });
  });

  app.post("/notifications/deliveries/:id/retry", async (request) => {
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
      organizationId: body.organizationId ?? request.userContext.organizationId,
      propertyId: body.propertyId,
      templateCode: body.templateCode,
      channel: body.channel,
      recipient: body.recipient,
      variables: body.variables ?? {},
      scheduledFor: body.scheduledFor,
      language: body.language
    });
  });

  app.get("/notifications/template-stats", async (request) => {
    const q = request.query as { organizationId?: string; propertyId?: string; days?: string };
    const organizationId = q.organizationId ?? request.userContext.organizationId;
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
      organizationId: q.organizationId ?? request.userContext.organizationId,
      status: q.status as HumanReviewStatus | undefined,
      reviewType: q.reviewType,
      assignedTo: q.assignedTo
    });
  });

  app.get("/ai-operations/review/stats", async (request) => {
    const q = request.query as { organizationId?: string };
    return humanReviewQueueStats({
      organizationId: q.organizationId ?? request.userContext.organizationId
    });
  });

  app.get("/ai-operations/review/:id", async (request) => {
    const params = request.params as { id: string };
    return getHumanReviewItem(params.id);
  });

  app.post("/ai-operations/review/:id/assign", async (request) => {
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
      organizationId: body.organizationId ?? request.userContext.organizationId,
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
      organizationId: q.organizationId ?? request.userContext.organizationId,
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
      organizationId: body.organizationId ?? request.userContext.organizationId,
      propertyId: body.propertyId,
      policyCode: body.policyCode,
      name: body.name,
      configuration: body.configuration,
      active: body.active
    });
  });

  app.post("/ai-operations/governance/policies/:id/active", async (request) => {
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

  app.post("/ai-operations/governance/prompts/versions/:id/publish", async (request) => {
    const params = request.params as { id: string };
    return govPublishPromptVersion(params.id);
  });

  app.post("/ai-operations/governance/prompts/versions/:id/archive", async (request) => {
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
      organizationId: q.organizationId ?? request.userContext.organizationId,
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
      organizationId: body.organizationId ?? request.userContext.organizationId,
      propertyId: body.propertyId,
      evaluationName: body.evaluationName,
      evaluationType: body.evaluationType,
      promptCode: body.promptCode
    });
  });

  app.post("/ai-operations/governance/evaluations/:id/run", async (request) => {
    const params = request.params as { id: string };
    return govRunEvaluation(params.id);
  });

  // Incidents
  app.get("/ai-operations/governance/incidents", async (request) => {
    const q = request.query as { organizationId?: string; status?: string; severity?: string };
    return govListIncidents({
      organizationId: q.organizationId ?? request.userContext.organizationId,
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
      organizationId: body.organizationId ?? request.userContext.organizationId,
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
    const params = request.params as { id: string };
    const body = request.body as { userId?: string };
    return govAssignIncident(params.id, body.userId ?? request.userContext.userId);
  });

  app.post("/ai-operations/governance/incidents/:id/resolve", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { rootCause?: string; resolutionNotes?: string };
    return govResolveIncident(params.id, body.rootCause ?? "", body.resolutionNotes ?? "");
  });

  app.post("/ai-operations/governance/incidents/:id/reopen", async (request) => {
    const params = request.params as { id: string };
    return govReopenIncident(params.id);
  });

  // Cost
  app.get("/ai-operations/governance/cost", async (request) => {
    const q = request.query as { organizationId?: string; days?: string };
    return govCostDashboard({
      organizationId: q.organizationId ?? request.userContext.organizationId,
      days: q.days ? Number(q.days) : undefined
    });
  });

  // Tokenization endpoint for stored cards. The Prisma client extension
  // encrypts `tokenRef` at rest via PII_FIELDS — see crypto-fields.ts. In
  // sandbox we synthesize a deterministic tokenRef so tests can assert
  // exact values; production should call adapter.tokenize() after the
  // frontend has collected card data through a PCI-compliant SDK (Stripe
  // Elements / Redsys SIS iframe).
  app.post("/payment-tokens", async (request) => {
    const body = parse(
      z.object({
        guestId: z.string().optional(),
        provider: z.enum(["redsys", "stripe", "adyen"]),
        cardData: z.object({ pan: z.string().optional(), token: z.string().optional() }).optional()
      }),
      request.body
    );
    // En sandbox: tokeniza determinísticamente y persiste.
    const tokenRef = "tok_" + body.provider + "_" + (body.cardData?.token ?? "sandbox").slice(0, 16);
    const last4 = body.cardData?.pan?.slice(-4) ?? "4242";
    const { prisma } = await import("@hotelos/database");
    const created = await prisma.paymentToken.create({
      data: {
        organizationId: request.userContext.organizationId,
        guestId: body.guestId,
        provider: body.provider,
        tokenRef,
        last4,
        brand: "demo",
        isDefault: false
      }
    });
    return { id: created.id, last4: created.last4, brand: created.brand };
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
  app.get("/events", async (request) => demoStore.events);
  app.get("/events/integrity", async (request) => verifyDomainEventIntegrity());
  app.get("/ai/tool-calls", async (request) => demoStore.aiToolCalls);

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
  const tips = await hydrateAuditChainFromPostgres();
  console.log(`[audit] hydrated chain tips: audit=${tips.auditTail?.slice(0, 12) ?? "<empty>"} event=${tips.eventTail?.slice(0, 12) ?? "<empty>"}`);
  const app = buildApiServer();
  await app.listen({ port, host });

  // HA gate (audit 2026-06 · #13): the five schedulers below must run on EXACTLY
  // one instance, or >1 replica would duplicate SES/VeriFactu submissions to the
  // AEAT (sanctionable). Single switch RUN_SCHEDULERS=false disables them on
  // non-leader replicas; default true keeps single-node behaviour unchanged.
  const schedulerLeader = isSchedulerLeader(app.log);

  // SES Hospedajes scheduler (RD 933/2021 24h deadline): poll "retrying"
  // submissions whose nextRetryAt elapsed and report overdue ones. In-process
  // for reliability without the separate worker; for multi-instance deployments
  // move this to the pg-boss worker. Disable with SES_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.SES_SCHEDULER_DISABLED !== "true") {
    const intervalMs = Number(process.env.SES_SCHEDULER_INTERVAL_MS ?? 5 * 60 * 1000);
    const timer = setInterval(() => {
      void runDueSesSubmissions(demoStore.userContext)
        .then((r) => {
          if (r.retried > 0 || r.overdue > 0) app.log.info({ ses: r }, "[ses.scheduler] tick");
        })
        .catch((error) => app.log.error({ err: error }, "[ses.scheduler] failed"));
    }, intervalMs);
    timer.unref();
    app.log.info(`[ses.scheduler] enabled (every ${Math.round(intervalMs / 1000)}s)`);
  }

  // Revenue pace scheduler: capture a daily OTB snapshot per property so PACE has
  // an exact historical baseline over time (live pace already reconstructs from
  // booking dates). Runs once at boot, then daily. Disable with
  // PACE_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.PACE_SCHEDULER_DISABLED !== "true") {
    const dayMs = 24 * 60 * 60 * 1000;
    const runCapture = () =>
      void capturePaceSnapshotsForAllProperties()
        .then((r) => app.log.info({ pace: r }, "[pace.scheduler] tick"))
        .catch((error) => app.log.error({ err: error }, "[pace.scheduler] failed"));
    runCapture();
    const paceTimer = setInterval(runCapture, dayMs);
    paceTimer.unref();
    app.log.info("[pace.scheduler] enabled (daily)");
  }

  // Allotment release scheduler · industry-standard End-of-Day routine.
  // Para cada propiedad activa, ejecuta releaseExpired() que devuelve al pool
  // general las habitaciones cuyo release period haya vencido sin venderse.
  // Idempotente (sólo libera días con releasedRooms = 0 y dentro del threshold).
  // Disable con ALLOTMENT_RELEASE_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.ALLOTMENT_RELEASE_SCHEDULER_DISABLED !== "true") {
    const dayMs = 24 * 60 * 60 * 1000;
    const runRelease = async () => {
      try {
        const { prisma: prismaClient } = await import("@hotelos/database");
        const properties = await prismaClient.property.findMany({
          where: { status: { not: "archived" } },
          select: { id: true }
        });
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
    app.log.info("[allotment.release.scheduler] enabled (daily · auto-release cupos B2B)");
  }

  // Group cut-off scheduler · daily routine that auto-releases group blocks past
  // their cutOffDate. Mirrors the allotment release pattern but flips group
  // status to "released" instead of touching day-level inventory. Idempotent.
  // Disable with GROUP_CUTOFF_SCHEDULER_DISABLED=true.
  if (schedulerLeader && process.env.GROUP_CUTOFF_SCHEDULER_DISABLED !== "true") {
    const dayMs = 24 * 60 * 60 * 1000;
    const runCutoff = async () => {
      try {
        const { prisma: prismaClient } = await import("@hotelos/database");
        const properties = await prismaClient.property.findMany({ where: { status: { not: "archived" } }, select: { id: true } });
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
    app.log.info("[group.cutoff.scheduler] enabled (daily · auto-release grupos vencidos)");
  }

  // Mailbox poller: read connected Gmail/Microsoft mailboxes, AI-extract bookings
  // and enqueue them for human review. Manual connector is excluded (push-only).
  // Disable with MAILBOX_POLL_DISABLED=true.
  if (schedulerLeader && process.env.MAILBOX_POLL_DISABLED !== "true") {
    const intervalMs = Number(process.env.MAILBOX_POLL_INTERVAL_MS ?? 5 * 60 * 1000);
    const mailboxTimer = setInterval(() => {
      void pollAllEmailConnections(demoStore.userContext)
        .then((r) => { if (r.processed > 0) app.log.info({ mailbox: r }, "[mailbox.poll] tick"); })
        .catch((error) => app.log.error({ err: error }, "[mailbox.poll] failed"));
    }, intervalMs);
    mailboxTimer.unref();
    app.log.info(`[mailbox.poll] enabled (every ${Math.round(intervalMs / 1000)}s)`);
  }
}
