export type ID = string;
export type ActorType = "user" | "ai" | "system";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type AiSource = "voice" | "text" | "image" | "chat" | "system";
export type RoomStatus = "clean" | "dirty" | "inspected" | "occupied" | "out_of_order" | "out_of_service";
export type ReservationStatus = "draft" | "confirmed" | "checked_in" | "checked_out" | "cancelled" | "no_show";
export type AiIntentName = "CHECK_IN_GUEST" | "CHECK_OUT_GUEST" | "ASSIGN_ROOM" | "MOVE_ROOM" | "POST_CHARGE" | "CREATE_MAINTENANCE_WORK_ORDER" | "UPDATE_HOUSEKEEPING_STATUS" | "SEND_GUEST_MESSAGE" | "CREATE_RESERVATION" | "QUOTE_AVAILABILITY" | "ISSUE_INVOICE" | "CREATE_SUPPLIER_BILL" | "CREATE_CAPEX_ITEM" | "ASK_DASHBOARD_QUESTION";
export type PermissionKey = "pms.reservation.read" | "pms.reservation.create" | "pms.reservation.modify" | "pms.checkin.execute" | "pms.checkout.execute" | "folio.charge.post" | "payment.capture" | "payment.refund" | "invoice.issue" | "invoice.cancel" | "housekeeping.task.manage" | "maintenance.workorder.manage" | "asset.capex.approve" | "accounting.journal.post" | "compliance.ses.submit" | "compliance.ses.export" | "compliance.ses.configure" | "compliance.gdpr.manage" | "guest_register.read" | "guest_register.create" | "guest_register.edit" | "guest_register.sign" | "guest_register.submit" | "guest_register.export" | "guest_register.annul" | "guest_register.correct" | "guest_register.view_sensitive" | "guest_register.configure" | "ai.tool.execute" | "ai.high_risk.confirm" | "modules.read" | "modules.enable" | "modules.disable" | "integrations.read" | "integrations.connect" | "integrations.disconnect" | "integrations.test" | "integrations.manage_credentials" | "distribution.read" | "distribution.manage_rates" | "distribution.manage_inventory" | "distribution.sync" | "distribution.ai_recommend" | "payments.create_link" | "payments.capture" | "payments.refund_request" | "payments.refund_approve" | "billing.invoice.issue" | "billing.invoice.cancel" | "billing.invoice.rectify" | "billing.compliance.view" | "pos.order.create" | "pos.order.charge_to_room" | "pos.order.pay" | "pos.product.manage" | "guest_experience.inbox.read" | "guest_experience.message.send" | "guest_experience.ai_reply" | "guest_experience.handoff" | "owner.dashboard.read" | "owner.ai_ask" | "assets.read" | "assets.manage" | "capex.read" | "capex.create" | "capex.approve" | "backoffice.access" | "property.configure" | "configuration.read" | "configuration.manage" | "categories.read" | "categories.manage" | "categories.import" | "categories.export" | "custom_fields.read" | "custom_fields.manage" | "property_profile.edit" | "room_types.manage" | "rooms.manage" | "spaces.manage" | "departments.manage" | "operations_setup.manage" | "revenue_setup.manage" | "compliance_setup.manage" | "ai_category_setup.use" | "property.map.read" | "property.map.manage" | "property.import" | "property.go_live" | "modules.configure" | "integrations.configure" | "integrations.view_logs" | "users.read" | "users.invite" | "users.disable" | "roles.manage" | "permissions.manage" | "tax.configure" | "compliance.configure" | "billing.configure" | "accounting.configure" | "payments.configure" | "ai.configure" | "templates.read" | "templates.manage" | "revenue.read" | "revenue.forecast.read" | "revenue.recommend" | "revenue.manage_rates" | "revenue.manage_restrictions" | "revenue.apply_recommendations" | "revenue.automation.manage" | "revenue.configure" | "revenue.history_forecast.read" | "revenue.history_forecast.export" | "revenue.history_forecast.configure" | "revenue.history_forecast.saved_views.manage" | "revenue.forecast_confidence.read" | "revenue.comparison.read" | "revenue.visual_alerts.read" | "revenue.scheduled_reports.manage" | "channel_manager.read" | "channel_manager.manage" | "channel_manager.sync" | "channel_manager.mappings.manage" | "channel_manager.parity.read" | "crm.read" | "crm.manage_profiles" | "crm.manage_campaigns" | "crm.manage_loyalty" | "crm.export" | "groups.read" | "groups.manage" | "groups.block_inventory" | "groups.manage_billing" | "events.read" | "events.manage" | "events.manage_spaces" | "sales.pipeline.read" | "sales.pipeline.manage" | "workforce.read" | "workforce.schedule.manage" | "workforce.timeclock.use" | "workforce.timeclock.manage" | "workforce.labor_cost.view" | "workforce.payroll_export" | "payroll.manage" | "banking.reconcile" | "notifications.manage" | "procurement.read" | "procurement.manage" | "purchase_orders.create" | "purchase_orders.approve" | "purchase_orders.receive" | "inventory.read" | "inventory.manage" | "inventory.stock_count" | "inventory.adjust" | "guest_portal.configure" | "guest_self_service.read" | "guest_self_service.manage" | "kiosk.configure" | "digital_key.configure" | "reputation.read" | "reputation.respond" | "surveys.read" | "surveys.manage" | "quality_cases.read" | "quality_cases.manage" | "energy.read" | "energy.manage" | "sustainability.read" | "sustainability.report" | "iot.manage" | "incidents.read" | "incidents.manage" | "safety_checks.read" | "safety_checks.manage" | "insurance_cases.manage" | "analytics.read" | "analytics.configure" | "analytics.export" | "analytics.ai_ask" | "metrics.manage" | "developer.read" | "developer.manage_apps" | "developer.manage_webhooks" | "developer.view_api_logs" | "developer.manage_sandbox" | "ai_governance.read" | "ai_governance.configure" | "ai_evals.manage" | "ai_incidents.read" | "ai_incidents.manage" | "ai_prompts.manage" | "ai_tool_registry.manage" | "onboarding.read" | "onboarding.create" | "onboarding.upload" | "onboarding.connect_source" | "onboarding.ai_extract" | "onboarding.ai_map" | "onboarding.review" | "onboarding.apply" | "onboarding.rollback" | "onboarding.go_live" | "onboarding.view_sensitive" | "onboarding.manage_cutover" | "audit.read";
export type RoleKey = "owner" | "manager" | "receptionist" | "housekeeper" | "maintenance" | "accountant" | "compliance" | "admin";
export type ToolContext = {
    organizationId: ID;
    propertyId: ID;
    userId: ID;
    deviceId?: string;
    locale: string;
    source: AiSource;
    auditCorrelationId: string;
    permissions: PermissionKey[];
};
export type AiIntent = {
    intent: AiIntentName;
    propertyId: ID;
    userId: ID;
    extractedEntities: Record<string, unknown>;
    confidence: number;
    requiredTools: string[];
    requiresConfirmation: boolean;
    riskLevel: RiskLevel;
};
export type GuestIdentityFields = {
    title?: string;
    firstName?: string;
    middleName?: string;
    surname1?: string;
    surname2?: string;
    documentType?: string;
    documentNumber?: string;
    documentSupportNumber?: string;
    documentIssueCountry?: string;
    documentExpiryDate?: string;
    nationality?: string;
    dateOfBirth?: string;
    sex?: string;
    languagePreference?: string;
    residenceAddress?: string;
    residenceLocality?: string;
    residenceProvince?: string;
    residencePostalCode?: string;
    residenceCountry?: string;
    phone?: string;
    mobilePhone?: string;
    email?: string;
    company?: string;
    vipCode?: string;
    loyaltyProgram?: string;
    loyaltyNumber?: string;
    loyaltyTier?: string;
    emergencyContactName?: string;
    emergencyContactPhone?: string;
    marketingConsent?: boolean;
    preferences?: string[];
    notes?: string;
};
export type VoiceTranscript = {
    transcript: string;
    confidence?: number;
    locale: string;
    durationMs: number;
};
export type DocumentExtractionResult = {
    fields: GuestIdentityFields;
    confidence: Record<string, number>;
    imageStored: false;
    imageDiscarded: true;
};
export type PhotoUploadDraft = {
    localUri: string;
    mediaType: "image" | "video";
    privacyReviewRequired: boolean;
    objectKey?: string;
};
export type ChatAttachmentType = "photo" | "camera_photo" | "file" | "voice_note";
export type ChatAttachment = {
    id: ID;
    attachmentType: ChatAttachmentType;
    objectKey: string;
    fileName?: string;
    mimeType: string;
    sizeBytes?: number;
    durationMs?: number;
    width?: number;
    height?: number;
    privacyReviewRequired: boolean;
    createdAt: string;
};
export type ChatAttachmentDraft = Omit<ChatAttachment, "id" | "createdAt"> & {
    localUri?: string;
};
export type VoiceNoteDraft = ChatAttachmentDraft & {
    attachmentType: "voice_note";
    durationMs: number;
};
export type OfflineAction = {
    id: ID;
    type: string;
    payload: unknown;
    createdAt: string;
    status: "pending" | "syncing" | "synced" | "failed";
};
export type OfflineSyncResult = {
    actionId: ID;
    type: string;
    status: "synced" | "rejected" | "conflict";
    reason?: string;
    serverEntityId?: ID;
};
export type OfflineSyncRequest = {
    propertyId: ID;
    deviceId: ID;
    actions: OfflineAction[];
};
export type OfflineSyncResponse = {
    accepted: number;
    rejected: number;
    conflicts: number;
    results: OfflineSyncResult[];
};
export type CheckInFromScanRequest = {
    propertyId: ID;
    transcript: string;
    roomNumber: string;
    documentExtractedFields: GuestIdentityFields;
    documentImageStored: false;
    idImageDiscarded: true;
};
export type ConfirmationCard = {
    title: string;
    summary: string;
    reservation: {
        code: string;
        arrival: string;
        departure: string;
        balanceDue: number;
    };
    room: {
        number: string;
        status: "clean_inspected" | "clean" | "dirty" | "occupied" | "blocked";
        maintenanceBlock: boolean;
    };
    guestRegister: {
        missingFields: string[];
        signatureRequired: boolean;
    };
    warnings: string[];
    actions: string[];
};
export type CheckInFromScanResponse = {
    status: "confirmation_required" | "rejected";
    confirmationId?: ID;
    card?: ConfirmationCard;
    errors?: string[];
};
export type AuditEvent = {
    id: ID;
    organizationId: ID;
    propertyId?: ID;
    actorUserId?: ID;
    actorType: ActorType;
    action: string;
    entityType: string;
    entityId?: ID;
    beforeJson?: unknown;
    afterJson?: unknown;
    ipAddress?: string;
    deviceId?: string;
    correlationId?: string;
    hashAlgorithm: "sha256";
    previousHash?: string;
    currentHash: string;
    createdAt: string;
};
export type EventEnvelope = {
    eventId: ID;
    organizationId: ID;
    propertyId: ID;
    entityType: string;
    entityId: ID;
    eventType: string;
    payload: Record<string, unknown>;
    actorType: ActorType;
    actorUserId?: ID;
    correlationId: string;
    hashAlgorithm: "sha256";
    previousHash?: string;
    currentHash: string;
    createdAt: string;
};
export type DashboardSnapshot = {
    arrivalsToday: number;
    departuresToday: number;
    roomsDirty: number;
    roomsCleanInspected: number;
    roomsOutOfOrder: number;
    openMaintenanceTasks: number;
    guestMessages: number;
    unpaidBalances: number;
    failedComplianceRecords: number;
    todayRevenue: number;
    aiDailyBriefing: string;
};
