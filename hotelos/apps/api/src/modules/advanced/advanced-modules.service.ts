// Motor genérico de módulos avanzados — Tanda L2 (L2-03): Prisma-only.
//
// Antes (HEAD dd662ee, 2.911 líneas) este fichero era la fuente de verdad en
// memoria de ≈120 rutas: el array advancedRecords del demoStore, 41 claves «phase2» con
// cifras inventadas, espejos tipados de revenue, cuadros agregados, salud
// derivada y 20 ramas muertas de createAdvancedRecord. Ahora:
//   · cada tipo de registro persiste en su TABLA PROPIA (criterio: modelo
//     Prisma existente + pantalla del menú o dashboard /dashboards/* que ya lo
//     lee) a través de advanced-record-store.ts; los tipos sin modelo o sin
//     consumidor ya no existen: 400 «Tipo de registro no soportado.» (L2-02
//     retira sus rutas);
//   · toda entrada pasa por un esquema zod `.strict()` por tipo
//     (advanced-record-schemas.ts) y toda transición por una máquina de
//     estados explícita (409 si no está permitida);
//   · aislamiento fail-secure: en alta/transición la organización es la del
//     contexto de la petición; en lista, la de la propiedad (Prisma), NUNCA el
//     contexto de demo global (bug de Carmen: /crm/* listaba la organización
//     del demoStore, no la del usuario);
//   · las listas devuelven SIEMPRE el envelope estable
//     `{ propertyId, moduleCode, recordType, items, total, nextCursor }` con
//     keyset por createdAt desc + id (límite 100, máximo 500);
//   · auditoría (recordAuditEvent + recordDomainEvent) en cada alta y
//     transición con la acción del catálogo ADVANCED_AUDIT_EVENTS.
//
// Superficie exportada que server.ts importa — conservada con los mismos
// nombres: createAdvancedRecord, getAdvancedRecord, listAdvancedRecords,
// transitionAdvancedRecord, validateAdvancedAiTool. Las funciones de cuadro y
// salud por módulo se retiraron con sus rutas (L2-02 / L2-03; /dashboards/* las
// sustituye). assertPurchaseOrderTransitionAuthorized y purchaseOrderAmountOf
// las importa payments/__tests__/refund-sod.test.mts.

import type { HotelModuleCode } from "@hotelos/product";
import { canExecuteToolForModules, type HotelOsToolName } from "@hotelos/ai-tools";
import type { PermissionKey } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import { flushAuditQueues, recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { createId } from "../../lib/ids.js";
import { BadRequestError, ForbiddenError, NotFoundError, RbacForbiddenError } from "../../lib/http-error.js";
import { demoStore, type UserContext } from "../../lib/demo-store.js";
import { assertApprovedOrAuthorized } from "../rbac/approvals.service.js";
import { defaultRbacDeps, type RbacDeps } from "../rbac/assignments.service.js";
import { getThresholds, maxTierFor, tierFor, tierWithin } from "../rbac/thresholds.service.js";
import { assertSeparationOfDuties, type SodRule } from "../treasury/permissions.js";
import { UNSUPPORTED_RECORD_TYPE_MESSAGE } from "./advanced-record-schemas.js";
import {
  createRecord,
  findPurchaseOrderAuthors,
  getPurchaseOrderForGate,
  getRecord,
  listRecords,
  normalizePage,
  supportsCreate,
  supportsList,
  supportsTransition,
  transitionRecord,
  type PageInput,
  type StoreScope
} from "./advanced-record-store.js";

// ---------------------------------------------------------------------------
// Tanda 8a (RBAC · L2, design §4.7 «Pedido de compra»): separación de
// funciones dinámica del pedido de compra. El solicitante es el actor que lo
// creó (sello createdByUserId: la fila de purchase_orders no tiene columna de
// autor, así que la fuente durable es el evento de auditoría
// PurchaseOrderCreated — findPurchaseOrderAuthors). approved → actor ≠
// solicitante y tramo(importe) dentro del tramo del actor, o la autorización
// purchase_order del motor L1 (403 RBAC_LEVEL_EXCEEDED si nada la autoriza);
// received → receptor ≠ solicitante. Un pedido sin autor conocido (legado)
// es «autor desconocido»: nunca bloquea, queda anotado.
// ---------------------------------------------------------------------------

const PURCHASE_ORDER_ENTITY = "purchase_order";
const PURCHASE_ORDER_AMOUNT_FIELDS = ["total", "totalAmount", "amount", "estimatedTotal", "estimatedAmount"] as const;

/** Money amount of a purchase-order payload (first known field that parses as a finite number ≥ 0), or null. Pure. */
export function purchaseOrderAmountOf(payload: Record<string, unknown> | undefined): number | null {
  if (!payload) return null;
  for (const field of PURCHASE_ORDER_AMOUNT_FIELDS) {
    const raw = payload[field];
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(",", ".")) : Number.NaN;
    if (Number.isFinite(value) && value >= 0) return Math.round(value * 100) / 100;
  }
  return null;
}

export type PurchaseOrderGate = {
  rule: SodRule;
  authorUserId: string | null;
  authorUnknown: boolean;
  privileged: "platform_admin" | "break_glass" | null;
  amount: number | null;
  tier: string | null;
  maxTier: string | null;
  authorization: { mode: string; requestId: string | null; supervisorAuthorizationId: string | null } | null;
};

/**
 * The transition gate of a purchase order, separated for the unit tests
 * (`existing` = the stored record, undefined for a legacy row).
 */
export async function assertPurchaseOrderTransitionAuthorized(
  input: { context: UserContext; propertyId: string; entityId: string; status: string; existingPayload: Record<string, unknown> | undefined; payload: Record<string, unknown> | undefined },
  deps: RbacDeps = defaultRbacDeps
): Promise<PurchaseOrderGate | null> {
  const createdBy = typeof input.existingPayload?.createdByUserId === "string" ? (input.existingPayload.createdByUserId as string) : null;
  if (input.status === "approved") {
    const sod = assertSeparationOfDuties(input.context, createdBy, "creator_ne_approver", { purchaseOrderId: input.entityId });
    const amount = purchaseOrderAmountOf(input.existingPayload) ?? purchaseOrderAmountOf(input.payload);
    const gate: PurchaseOrderGate = { rule: sod.rule, authorUserId: sod.authorUserId, authorUnknown: sod.authorUnknown, privileged: sod.privileged, amount, tier: null, maxTier: null, authorization: null };
    if (amount === null) return gate;
    const thresholds = await getThresholds(input.context.organizationId, deps);
    const tier = tierFor(amount, thresholds, "purchase_order");
    const maxTier = await maxTierFor(input.context, input.propertyId, deps);
    gate.tier = tier;
    gate.maxTier = maxTier;
    if (tierWithin(tier, maxTier) && tier !== "ABOVE_T4") return gate;
    try {
      const authorization = await assertApprovedOrAuthorized(
        {
          context: input.context,
          kind: "purchase_order",
          entityType: PURCHASE_ORDER_ENTITY,
          entityId: input.entityId,
          propertyId: input.propertyId,
          amount: amount.toFixed(2),
          baseAuthorUserId: createdBy,
          supervisorAuthorizationId: typeof input.payload?.supervisorAuthorizationId === "string" ? (input.payload.supervisorAuthorizationId as string) : null
        },
        deps
      );
      gate.authorization = { mode: authorization.mode, requestId: authorization.requestId ?? null, supervisorAuthorizationId: authorization.supervisorAuthorizationId ?? null };
      return gate;
    } catch (error) {
      const code = (error as { details?: { code?: string; requestId?: string } }).details?.code;
      if (code !== "APPROVAL_REQUIRED") throw error;
      throw new RbacForbiddenError("El importe del pedido supera el tramo que puedes aprobar.", "RBAC_LEVEL_EXCEEDED", { tier, maxTier, kind: "purchase_order" });
    }
  }
  if (input.status === "received") {
    const sod = assertSeparationOfDuties(input.context, createdBy, "requester_ne_receiver", { purchaseOrderId: input.entityId });
    return { rule: sod.rule, authorUserId: sod.authorUserId, authorUnknown: sod.authorUnknown, privileged: sod.privileged, amount: null, tier: null, maxTier: null, authorization: null };
  }
  return null;
}

export const ADVANCED_MODULE_HEALTH_CHECKS: Record<HotelModuleCode, string[]> = {
  pms_core: [],
  ai_front_desk: [],
  distribution_hub: [],
  ai_booking_engine: [],
  checkin_online: [],
  housekeeping: [],
  maintenance: [],
  erp_accounting: [],
  compliance_hub: [],
  compliance_billing: [],
  payment_vault: [],
  guest_experience: [],
  ai_concierge: [],
  asset_intelligence: [],
  capex_manager: [],
  outlet_pos: [],
  owner_mode: [],
  integration_marketplace: [],
  module_marketplace: [],
  revenue_profit_engine: [
    "pms_inventory_ready",
    "rate_plans_configured",
    "rates_configured",
    "inventory_days_generated",
    "restriction_rules_ready",
    "distribution_enabled",
    "channel_mappings_valid",
    "channel_sync_health_ok",
    "competitor_set_configured",
    "historical_booking_data_available",
    "accounting_cost_data_available",
    "forecast_data_quality_ready",
    "automation_rules_safe"
  ],
  guest_data_crm_loyalty: [
    "guest_profiles_available",
    "marketing_consent_configured",
    "email_provider_connected",
    "campaign_templates_configured",
    "loyalty_rules_configured"
  ],
  groups_events_sales: [
    "room_types_configured",
    "event_spaces_configured",
    "billing_rules_configured",
    "deposit_rules_configured",
    "group_inventory_rules_configured"
  ],
  workforce_labor: [
    "departments_configured",
    "staff_profiles_created",
    "shift_rules_configured",
    "time_clock_policy_configured",
    "labor_costs_configured"
  ],
  procurement_inventory: [
    "suppliers_created",
    "stock_locations_created",
    "inventory_items_created",
    "approval_rules_configured",
    "accounting_mapping_configured"
  ],
  guest_self_service: [
    "guest_portal_enabled",
    "payment_provider_connected",
    "checkin_rules_configured",
    "guest_templates_configured",
    "digital_key_optional_configured"
  ],
  reputation_quality: [
    "review_sources_connected",
    "survey_templates_created",
    "quality_workflows_configured",
    "guest_message_provider_connected"
  ],
  energy_sustainability: [
    "utility_meters_created",
    "occupancy_metrics_available",
    "sustainability_targets_configured",
    "capex_link_available"
  ],
  safety_incident_management: [
    "emergency_contacts_configured",
    "safety_checks_created",
    "incident_workflow_configured",
    "evidence_storage_configured"
  ],
  hotel_intelligence_platform: [
    "metric_definitions_created",
    "snapshot_worker_running",
    "data_quality_checks_enabled",
    "owner_reports_configured"
  ],
  developer_platform: [
    "api_scopes_configured",
    "webhook_worker_running",
    "sandbox_property_available",
    "developer_docs_available"
  ],
  ai_governance: [
    "ai_tool_registry_synced",
    "ai_policies_configured",
    "ai_evals_available",
    "guest_disclosure_configured",
    "human_review_queue_enabled"
  ],
  spain_guest_register_compliance: [
    "lodging_legal_profile_configured",
    "authority_reporting_configured",
    "ses_batch_export_enabled",
    "official_schema_or_manual_export_ready",
    "identity_image_storage_disabled",
    "guest_register_retention_configured",
    "authority_routing_rules_configured",
    "compliance_inbox_ready"
  ],
  ai_onboarding_migration: [
    "source_pms_connectors_available",
    "upload_storage_configured",
    "document_extraction_provider_configured",
    "ai_schema_mapping_enabled",
    "human_review_queue_ready",
    "migration_dry_run_required",
    "go_live_readiness_checks_enabled",
    "raw_file_retention_policy_configured"
  ]
};

export const ADVANCED_AUDIT_EVENTS = [
  "RevenueForecastGenerated",
  "RevenueRecommendationCreated",
  "RevenueRecommendationApproved",
  "RevenueRecommendationApplied",
  "RevenueRecommendationRejected",
  "RevenueRecommendationExpired",
  "RateDayUpdated",
  "RestrictionDayUpdated",
  "InventoryDayUpdated",
  "RateGridBulkUpdated",
  "ChannelConnected",
  "ChannelDisconnected",
  "ChannelMappingCreated",
  "ChannelMappingUpdated",
  "ChannelSyncStarted",
  "ChannelSyncSucceeded",
  "ChannelSyncFailed",
  "ExternalReservationImported",
  "ExternalReservationModified",
  "ExternalReservationCancelled",
  "RateParityAlertCreated",
  "CompetitorRateSnapshotCreated",
  "DemandCalendarEventCreated",
  "RevenueScenarioSimulated",
  "RevenueAutomationRuleCreated",
  "RevenueAutomationRuleUpdated",
  "RevenueAutomationRuleTriggered",
  "RevenueAutomationBlocked",
  "RevenueHistoryForecastExported",
  "RevenueReportViewCreated",
  "RevenueHistoryForecastAlertCreated",
  "GuestProfileMerged",
  "GuestSegmentCreated",
  "CampaignCreated",
  "CampaignSent",
  "LoyaltyMembershipCreated",
  "GroupBookingCreated",
  "GroupRoomBlockCreated",
  "GroupRoomBlockReleased",
  "EventCreated",
  "BEOCreated",
  "GroupProposalCreated",
  "ShiftCreated",
  "ShiftUpdated",
  "StaffClockedIn",
  "StaffClockedOut",
  "AbsenceRequested",
  "AbsenceApproved",
  "LaborForecastGenerated",
  "SupplierCreated",
  "PurchaseOrderCreated",
  "PurchaseOrderApproved",
  "PurchaseOrderReceived",
  "StockMovementCreated",
  "StockCountCompleted",
  "GuestPortalSessionCreated",
  "GuestOnlineCheckInCompleted",
  "GuestMobileCheckoutCompleted",
  "GuestUpsellPurchased",
  "DigitalKeyRequested",
  "ReviewReceived",
  "ReviewResponseDrafted",
  "ReviewResponseSent",
  "QualityCaseCreated",
  "QualityCaseResolved",
  "QualityCaseUpdated",
  "SurveyCreated",
  "SurveyResponseReceived",
  "UtilityMeterCreated",
  "UtilityReadingCreated",
  "EnergyAnomalyDetected",
  "SustainabilityActionCreated",
  "SafetyIncidentCreated",
  "SafetyIncidentUpdated",
  "IncidentEvidenceAdded",
  "SafetyCheckCreated",
  "SafetyCheckCompleted",
  "AnalyticsSnapshotGenerated",
  "AnomalyDetected",
  "ScheduledReportGenerated",
  "MetricDefinitionCreated",
  "DeveloperAppCreated",
  "DeveloperAppSecretRotated",
  "WebhookSubscriptionCreated",
  "WebhookDeliveryFailed",
  "AIPolicyUpdated",
  "AIToolDisabled",
  "AIToolEnabled",
  "AIPromptVersionCreated",
  "AIEvaluationRun",
  "AIIncidentCreated",
  "AIHumanReviewCreated",
  "AIHumanReviewResolved",
  "GuestRegisterRecordCreated",
  "GuestRegisterRecordValidated",
  "GuestRegisterRecordSigned",
  "GuestRegisterIdentityVerified",
  "TemporaryIdScanStarted",
  "TemporaryIdOcrCompleted",
  "IdImageDiscarded",
  "GuestRegisterQueued",
  "AuthorityBatchGenerated",
  "AuthorityBatchDownloaded",
  "AuthorityBatchSubmitted",
  "AuthoritySubmissionAccepted",
  "AuthoritySubmissionRejected",
  "AuthoritySubmissionFailed",
  "AuthoritySubmissionRetried",
  "AuthorityCommunicationAnnulled",
  "GuestRegisterCorrected",
  "GuestRegisterRetentionExpired",
  "GuestRegisterDataDeleted",
  "SensitiveGuestRegisterViewed",
  "OnboardingProjectCreated",
  "OnboardingSourceConnected",
  "OnboardingSourceConnectionTested",
  "OnboardingFileUploaded",
  "OnboardingFileClassified",
  "OnboardingFileExtracted",
  "OnboardingAIAnalysisStarted",
  "OnboardingAIAnalysisCompleted",
  "OnboardingBlueprintGenerated",
  "OnboardingMappingSuggested",
  "OnboardingMappingApproved",
  "OnboardingMappingRejected",
  "OnboardingMappingEdited",
  "OnboardingDryRunStarted",
  "OnboardingDryRunCompleted",
  "OnboardingMigrationBatchApplied",
  "OnboardingMigrationBatchFailed",
  "OnboardingMigrationBatchRolledBack",
  "OnboardingGoLiveReadinessGenerated",
  "OnboardingGoLiveApproved",
  "OnboardingRawFileDeleted",
  "SensitiveOnboardingDataViewed"
] as const;

type AdvancedMutationInput = {
  context: UserContext;
  propertyId: string;
  moduleCode: HotelModuleCode;
  entityType: string;
  auditAction: (typeof ADVANCED_AUDIT_EVENTS)[number];
  payload?: Record<string, unknown>;
  requiredPermissions: PermissionKey[];
  correlationId: string;
};

/** Gating síncrono sobre el espejo hidratado de módulos (getEnabledModuleCodes). */
function requireAdvancedModuleEnabled(propertyId: string, moduleCode: HotelModuleCode) {
  if (!getEnabledModuleCodes(propertyId).includes(moduleCode)) {
    // A property without the module is a business condition, not a crash.
    throw new ForbiddenError(`El módulo ${moduleCode} no está activado en esta propiedad.`);
  }
}

function audit(input: AdvancedMutationInput, entityId: string, afterJson: unknown, organizationId: string) {
  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: input.auditAction,
    entityType: input.entityType,
    entityId,
    afterJson,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId,
    propertyId: input.propertyId,
    entityType: input.entityType,
    entityId,
    eventType: input.auditAction,
    payload: input.payload ?? {},
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
}

function requirePropertyAccess(propertyId: string) {
  // The property mirror is hydrated from Prisma at boot and on tenant
  // creation (lib/tenant-hydration.ts); a miss here is a genuine unknown id.
  if (!demoStore.properties.some((property) => property.id === propertyId)) {
    throw new NotFoundError("Propiedad no encontrada.");
  }
}

/** Organización propietaria de la propiedad, leída de Prisma (nunca del contexto de demo). */
async function organizationOfProperty(propertyId: string): Promise<string> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return property.organizationId;
}

// Salud y cuadro por módulo (getAdvancedModuleHealth / getAdvancedModuleDashboard):
// retirados en L2-03 (cifras de espejos en memoria) y sus rutas borradas en L2-02;
// los cuadros /dashboards/* los sustituyen. El corrector eliminó los stubs muertos.

export type AdvancedRecordList = {
  propertyId: string;
  moduleCode: HotelModuleCode;
  recordType: string;
  items: unknown[];
  total: number;
  nextCursor: string | null;
};

/**
 * Lista paginada de un tipo de registro (contrato para L2-02): keyset por
 * createdAt desc + id, `take: limit + 1`, límite 100 por defecto y 500 como
 * máximo; sin `page` devuelve la primera página. La organización es la de la
 * propiedad (Prisma): un tipo desconocido es un 400, una propiedad
 * desconocida un 404 y un módulo no activado un 403.
 */
export async function listAdvancedRecords(propertyId: string, moduleCode: HotelModuleCode, recordType: string, page?: PageInput): Promise<AdvancedRecordList> {
  requirePropertyAccess(propertyId);
  requireAdvancedModuleEnabled(propertyId, moduleCode);
  const key = `${moduleCode}:${recordType}`;
  if (!supportsList(key)) throw new BadRequestError(UNSUPPORTED_RECORD_TYPE_MESSAGE);
  const normalized = normalizePage(page);
  const organizationId = await organizationOfProperty(propertyId);
  const scope: StoreScope = { organizationId, propertyId, moduleCode, userId: "" };
  const result = await listRecords(key, scope, normalized);
  return { propertyId, moduleCode, recordType, items: result.items, total: result.total, nextCursor: result.nextCursor };
}

/** Un registro por id dentro de la propiedad (404 opaco si no existe o cuelga de otro tenant). */
export async function getAdvancedRecord(propertyId: string, moduleCode: HotelModuleCode, recordType: string, recordId: string): Promise<unknown> {
  requirePropertyAccess(propertyId);
  requireAdvancedModuleEnabled(propertyId, moduleCode);
  const key = `${moduleCode}:${recordType}`;
  if (!supportsList(key)) throw new BadRequestError(UNSUPPORTED_RECORD_TYPE_MESSAGE);
  if (typeof recordId !== "string" || recordId.length === 0) throw new BadRequestError("Identificador inválido.");
  const organizationId = await organizationOfProperty(propertyId);
  return getRecord(key, { organizationId, propertyId, moduleCode, userId: "" }, recordId);
}

/**
 * Ámbito de una escritura. SEC-L2-05 (corrector): la organización es la de la
 * PROPIEDAD (Prisma), nunca la del contexto — un administrador de plataforma
 * que actúa sobre otro tenant crearía filas de organización (scheduled_reports)
 * huérfanas e invisibles para ese tenant. Una propiedad de otra organización
 * para un usuario sin plataforma es el 404 opaco habitual.
 */
async function scopeOf(input: AdvancedMutationInput): Promise<StoreScope> {
  const organizationId = await organizationOfProperty(input.propertyId);
  if (organizationId !== input.context.organizationId && input.context.isPlatformAdmin !== true) {
    throw new NotFoundError("Propiedad no encontrada.");
  }
  return {
    organizationId,
    propertyId: input.propertyId,
    moduleCode: input.moduleCode,
    userId: input.context.userId,
    deviceId: input.context.deviceId,
    auditAction: input.auditAction
  };
}

/**
 * Alta de un registro: permisos → módulo activado → tipo soportado →
 * validación zod estricta y persistencia en su tabla (advanced-record-store)
 * → auditoría. Devuelve la fila persistida. El sello de autoría
 * (createdByUserId = actor, nunca un valor del cliente) viaja en la auditoría
 * y, para el pedido de compra, es la base de la separación de funciones.
 */
export async function createAdvancedRecord(input: AdvancedMutationInput): Promise<unknown> {
  requirePermissions(input.context, input.requiredPermissions);
  requireAdvancedModuleEnabled(input.propertyId, input.moduleCode);
  const key = `${input.moduleCode}:${input.entityType}`;
  if (!supportsCreate(key)) throw new BadRequestError(UNSUPPORTED_RECORD_TYPE_MESSAGE);
  const id = createId(input.entityType);
  const scope = await scopeOf(input);
  const row = await createRecord(key, scope, input.payload ?? {}, id);
  const stamped = { ...input, payload: { ...(input.payload ?? {}), createdByUserId: input.context.userId } };
  audit(stamped, id, row, scope.organizationId);
  return row;
}

/**
 * Transición de un registro: permisos → módulo activado → tipo soportado →
 * (pedido de compra: puerta de SoD de Tanda 8a) → validación + máquina de
 * estados + fila por id y ámbito (404 opaco) → auditoría. Devuelve la fila.
 */
export async function transitionAdvancedRecord(input: AdvancedMutationInput & { entityId: string; status: string; rbac?: RbacDeps }): Promise<unknown> {
  requirePermissions(input.context, input.requiredPermissions);
  requireAdvancedModuleEnabled(input.propertyId, input.moduleCode);
  const key = `${input.moduleCode}:${input.entityType}`;
  if (!supportsTransition(key)) throw new BadRequestError(UNSUPPORTED_RECORD_TYPE_MESSAGE);
  if (typeof input.entityId !== "string" || input.entityId.length === 0) throw new BadRequestError("Identificador inválido.");
  const scope = await scopeOf(input);
  let payload: Record<string, unknown> = input.payload ?? {};
  let afterExtra: Record<string, unknown> = {};

  if (input.entityType === PURCHASE_ORDER_ENTITY && (input.status === "approved" || input.status === "received")) {
    // The audit write chain is drained first so the PurchaseOrderCreated event
    // of a pedido created a moment ago is visible to the author lookup: SoD
    // must never fail open because of a queued audit row.
    const order = await getPurchaseOrderForGate(scope, input.entityId);
    await flushAuditQueues();
    const author = (await findPurchaseOrderAuthors(scope, [order.id])).get(order.id) ?? null;
    const gate = await assertPurchaseOrderTransitionAuthorized(
      { context: input.context, propertyId: input.propertyId, entityId: order.id, status: input.status, existingPayload: { createdByUserId: author, total: order.total }, payload },
      input.rbac ?? defaultRbacDeps
    );
    const { supervisorAuthorizationId: _consumed, ...payloadWithoutPin } = payload;
    void _consumed;
    payload = payloadWithoutPin;
    afterExtra = { ...(input.status === "approved" ? { approvedByUserId: input.context.userId } : { receivedByUserId: input.context.userId }), sod: gate };
  }

  const row = await transitionRecord(key, scope, input.entityId, input.status, input.payload ?? {});
  audit({ ...input, payload }, input.entityId, Object.keys(afterExtra).length > 0 ? { ...(row as Record<string, unknown>), ...afterExtra } : row, scope.organizationId);
  return row;
}

export function validateAdvancedAiTool(input: {
  propertyId: string;
  toolName: HotelOsToolName;
  userPermissions: PermissionKey[];
}) {
  return canExecuteToolForModules({
    toolName: input.toolName,
    enabledModules: getEnabledModuleCodes(input.propertyId),
    userPermissions: input.userPermissions
  });
}
