import type {
  AuditEvent,
  ChatAttachment,
  EventEnvelope,
  OfflineAction,
  OfflineSyncResult,
  PermissionKey
} from "@hotelos/shared";
import { HOTEL_MODULES, type HotelModuleCode } from "@hotelos/product";

export type OrganizationRecord = {
  id: string;
  name: string;
  legalName: string;
  taxId: string;
};

export type PropertyRecord = {
  id: string;
  organizationId: string;
  name: string;
  legalName?: string;
  address?: string;
  municipality?: string;
  province?: string;
  timezone: string;
  country: string;
  taxRegion?: string;
  sesHospedajesEnabled: boolean;
  verifactuEnabled: boolean;
};

export type UserRecord = {
  id: string;
  organizationId: string;
  email: string;
  phone?: string;
  fullName: string;
  status: "active" | "invited" | "disabled";
  mfaEnabled: boolean;
};

export type DeviceRecord = {
  id: string;
  userId: string;
  deviceName: string;
  platform: "ios" | "android" | "web" | "unknown";
  pushToken?: string;
  trusted: boolean;
  registeredAt: string;
  lastSeenAt: string;
};

export type SessionRecord = {
  id: string;
  userId: string;
  deviceId: string;
  status: "active" | "revoked";
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
};

export type MfaChallengeRecord = {
  id: string;
  userId: string;
  purpose: "login" | "high_risk_action";
  status: "pending" | "verified" | "expired";
  deliveryChannel: "email" | "sms" | "authenticator";
  expiresAt: string;
  createdAt: string;
};

export type NotificationRecord = {
  id: string;
  propertyId: string;
  userId: string;
  type: "compliance" | "maintenance" | "guest_message" | "payment" | "system";
  title: string;
  body: string;
  status: "unread" | "read";
  createdAt: string;
};

export type ModuleRecord = {
  id: string;
  code: HotelModuleCode;
  name: string;
  description?: string;
  category: string;
  isCore: boolean;
  createdAt: string;
};

export type PropertyModuleRecord = {
  id: string;
  propertyId: string;
  moduleId: string;
  status: "enabled" | "disabled";
  configurationJson: Record<string, unknown>;
  enabledAt?: string;
  disabledAt?: string;
  createdAt: string;
};

export type ModuleDependencyRecord = {
  id: string;
  moduleId: string;
  requiredModuleId: string;
};

export type IntegrationCategoryRecord = {
  id: string;
  code: string;
  name: string;
  description?: string;
};

export type IntegrationProviderRecord = {
  id: string;
  categoryId: string;
  code: string;
  name: string;
  authType: "api_key" | "oauth2" | "basic" | "certificate" | "webhook" | "manual";
  supportedRegions: string[];
  capabilitiesJson: Record<string, unknown>;
  createdAt: string;
};

export type IntegrationConnectionRecord = {
  id: string;
  propertyId: string;
  providerId: string;
  status: "connected" | "disconnected" | "error" | "testing";
  credentialsSecretRef?: string;
  configJson: Record<string, unknown>;
  lastSyncAt?: string;
  createdAt: string;
};

export type IntegrationEventRecord = {
  id: string;
  connectionId: string;
  direction: "inbound" | "outbound";
  eventType: string;
  payloadJson: Record<string, unknown>;
  status: "queued" | "sent" | "accepted" | "failed";
  errorMessage?: string;
  createdAt: string;
};

export type BuildingRecord = {
  id: string;
  propertyId: string;
  name: string;
  code?: string;
  description?: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FloorRecord = {
  id: string;
  propertyId: string;
  buildingId?: string;
  name: string;
  floorNumber?: number;
  code?: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PropertyZoneRecord = {
  id: string;
  propertyId: string;
  buildingId?: string;
  floorId?: string;
  name: string;
  code?: string;
  zoneType:
    | "guest_rooms"
    | "housekeeping"
    | "maintenance"
    | "public_area"
    | "back_of_house"
    | "outdoor"
    | "technical"
    | "food_beverage"
    | "wellness"
    | "parking"
    | "events";
  description?: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PropertySpaceRecord = {
  id: string;
  propertyId: string;
  buildingId?: string;
  floorId?: string;
  zoneId?: string;
  name: string;
  code?: string;
  spaceType:
    | "reception"
    | "lobby"
    | "restaurant"
    | "bar"
    | "kitchen"
    | "spa"
    | "gym"
    | "pool"
    | "parking"
    | "meeting_room"
    | "laundry"
    | "storage"
    | "technical_room"
    | "office"
    | "staff_room"
    | "terrace"
    | "garden"
    | "elevator"
    | "corridor"
    | "other";
  description?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PropertyMapPositionRecord = {
  id: string;
  propertyId: string;
  entityType: "room" | "space" | "asset" | "zone";
  entityId: string;
  floorId?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RoomFeatureRecord = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  category?: string;
  active: boolean;
};

export type RoomFeatureAssignmentRecord = {
  id: string;
  roomId: string;
  roomFeatureId: string;
};

export type BedTypeRecord = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  capacity: number;
  active: boolean;
};

export type RoomBedRecord = {
  id: string;
  roomId: string;
  bedTypeId: string;
  quantity: number;
};

export type PropertySetupStepRecord = {
  id: string;
  propertyId: string;
  stepCode: string;
  status: "not_started" | "in_progress" | "completed" | "blocked" | "needs_review";
  completedAt?: string;
  completedBy?: string;
  metadataJson: Record<string, unknown>;
};

export type PropertyReadinessCheckRecord = {
  id: string;
  propertyId: string;
  checkCode: string;
  status: "pass" | "fail" | "warning";
  severity: "info" | "warning" | "blocking";
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ModuleHealthCheckRecord = {
  id: string;
  propertyId: string;
  moduleCode: HotelModuleCode;
  checkCode: string;
  status: "ok" | "needs_configuration" | "error";
  severity: "info" | "warning" | "blocking";
  message: string;
  metadataJson: Record<string, unknown>;
  updatedAt: string;
};

export type DepartmentRecord = {
  id: string;
  propertyId: string;
  name: string;
  code: string;
  description?: string;
  active: boolean;
};

export type UserDepartmentRecord = {
  id: string;
  userId: string;
  departmentId: string;
  roleLabel?: string;
  active: boolean;
};

export type HousekeepingSectionRecord = {
  id: string;
  propertyId: string;
  name: string;
  code?: string;
  description?: string;
  active: boolean;
};

export type HousekeepingSectionRoomRecord = {
  id: string;
  housekeepingSectionId: string;
  roomId: string;
};

export type MaintenanceAreaRecord = {
  id: string;
  propertyId: string;
  name: string;
  code?: string;
  description?: string;
  active: boolean;
};

export type MaintenanceAreaRoomRecord = {
  id: string;
  maintenanceAreaId: string;
  roomId: string;
};

export type RuleRecord = {
  id: string;
  propertyId: string;
  ruleCode: string;
  configurationJson: Record<string, unknown>;
  active: boolean;
};

export type PropertyComplianceSettingsRecord = {
  id: string;
  propertyId: string;
  country: string;
  taxRegion?: string;
  vatRegime?: string;
  tourismTaxRegion?: string;
  sesHospedajesEnabled: boolean;
  verifactuEnabled: boolean;
  ticketbaiEnabled: boolean;
  siiEnabled: boolean;
  b2bEinvoiceEnabled: boolean;
  configurationJson: Record<string, unknown>;
  updatedAt: string;
};

export type InvoiceSequenceRecord = {
  id: string;
  propertyId: string;
  sequenceCode: string;
  prefix?: string;
  nextNumber: number;
  padding: number;
  invoiceType: "full" | "simplified" | "rectifying" | "credit_note";
  active: boolean;
};

export type AccountingSettingsRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  chartTemplate?: string;
  fiscalYearStartMonth: number;
  configurationJson: Record<string, unknown>;
  updatedAt: string;
};

export type CostCenterRecord = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
};

export type PropertyAiSettingsRecord = {
  id: string;
  propertyId: string;
  aiEnabled: boolean;
  defaultAutomationLevel: "off" | "draft_only" | "suggest_and_confirm" | "auto_low_risk" | "auto_within_rules";
  guestFacingDisclosure?: string;
  voiceLocales: string[];
  configurationJson: Record<string, unknown>;
  updatedAt: string;
};

export type PropertyAiToolSettingsRecord = {
  id: string;
  propertyId: string;
  toolName: string;
  enabled: boolean;
  automationLevel: PropertyAiSettingsRecord["defaultAutomationLevel"];
  requiresConfirmation: boolean;
  requiresApprovalRole?: string;
  configurationJson: Record<string, unknown>;
};

export type DocumentTemplateRecord = {
  id: string;
  propertyId: string;
  templateCode: string;
  name: string;
  channel: "email" | "sms" | "whatsapp" | "pdf" | "app";
  language: string;
  subject?: string;
  body: string;
  variablesJson: Record<string, unknown>;
  active: boolean;
  updatedAt: string;
};

export type QrCodeRecord = {
  id: string;
  propertyId: string;
  entityType: "room" | "asset" | "space" | "zone";
  entityId: string;
  qrValue: string;
  purpose: "staff_room" | "asset_maintenance" | "guest_service" | "space_service";
  active: boolean;
  createdAt: string;
};

export type PropertyImportRecord = {
  id: string;
  propertyId: string;
  importType: "property_map";
  status: "previewed" | "committed" | "failed";
  previewJson: Record<string, unknown>;
  errorJson: Record<string, unknown>;
  committedAt?: string;
  createdBy?: string;
  createdAt: string;
};

export type PropertySetupFormSubmissionRecord = {
  id: string;
  propertyId: string;
  formCode: string;
  status: "saved" | "failed";
  payloadJson: Record<string, unknown>;
  validationErrorsJson: string[];
  targetEntityType?: string;
  targetEntityId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type ManualSetupSubmissionRecord = {
  id: string;
  propertyId: string;
  optionCode: string;
  status: "saved" | "failed";
  payloadJson: Record<string, unknown>;
  validationErrorsJson: string[];
  targetTables: string[];
  inputCategories: string[];
  completionChecksJson: Record<string, unknown>[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type BackOfficeAiSuggestionRecord = {
  id: string;
  propertyId: string;
  userId: string;
  prompt: string;
  status: "previewed" | "applied" | "rejected";
  proposedChangesJson: Record<string, unknown>;
  requiresConfirmation: boolean;
  appliedAt?: string;
  createdAt: string;
};

export type OfflineSyncRecord = {
  id: string;
  propertyId: string;
  deviceId: string;
  action: OfflineAction;
  result: OfflineSyncResult;
  createdAt: string;
};

export type RoomRecord = {
  id: string;
  propertyId: string;
  roomTypeId: string;
  buildingId?: string;
  floorId?: string;
  zoneId?: string;
  number: string;
  floor: string;
  roomCode?: string;
  displayName?: string;
  maxOccupancy?: number;
  standardOccupancy?: number;
  bedConfigurationJson?: Record<string, unknown>;
  featuresJson?: Record<string, unknown>;
  accessibilityJson?: Record<string, unknown>;
  viewType?: string;
  orientation?: string;
  squareMeters?: number;
  status: "clean" | "dirty" | "inspected" | "occupied" | "out_of_order" | "out_of_service";
  housekeepingStatus: "dirty" | "clean" | "inspected";
  maintenanceStatus: "ok" | "blocked" | "needs_attention";
  sellable: boolean;
  active?: boolean;
  sortOrder?: number;
};

export type RoomTypeRecord = {
  id: string;
  propertyId: string;
  name: string;
  code: string;
  maxOccupancy: number;
  baseCapacity: number;
  description?: string;
  defaultBedConfigurationJson?: Record<string, unknown>;
  defaultAmenitiesJson?: Record<string, unknown>;
  defaultPhotosJson?: Record<string, unknown>;
  defaultRateCategory?: string;
  sellable?: boolean;
  displayOrder?: number;
  active?: boolean;
};

export type GuestRecord = {
  id: string;
  organizationId: string;
  title?: string;
  firstName: string;
  middleName?: string;
  surname1?: string;
  surname2?: string;
  documentType?: string;
  documentNumber?: string;
  documentSupportNumber?: string;
  documentIssueCountry?: string;
  documentExpiryDate?: string;
  nationality?: string;
  sex?: string;
  languagePreference?: string;
  dateOfBirth?: string;
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
  preferences?: string[];
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  marketingConsent?: boolean;
  notes?: string;
};

export type ReservationRecord = {
  id: string;
  propertyId: string;
  code: string;
  channel: string;
  status: "draft" | "confirmed" | "checked_in" | "checked_out" | "cancelled" | "no_show";
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
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
  totalAmount: number;
  currency: string;
  primaryGuestId?: string;
};

export type FolioRecord = {
  id: string;
  reservationId: string;
  guestId?: string;
  status: "open" | "closed";
  currency: string;
};

export type FolioLineRecord = {
  id: string;
  folioId: string;
  type: "room" | "tax" | "breakfast" | "parking" | "minibar" | "adjustment";
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode?: string;
  total: number;
  postedAt: string;
  postedBy?: string;
};

export type PaymentRecord = {
  id: string;
  propertyId: string;
  folioId: string;
  amount: number;
  currency: string;
  method: "cash" | "card" | "bank_transfer" | "payment_link" | "ota_virtual_card";
  pspReference?: string;
  status: "pending" | "captured" | "refunded" | "failed";
  createdAt: string;
};

export type HousekeepingTaskRecord = {
  id: string;
  propertyId: string;
  roomId: string;
  taskType: "departure_clean" | "stayover" | "inspection" | "deep_clean";
  priority: "low" | "normal" | "high";
  status: "pending" | "assigned" | "in_progress" | "done" | "rejected";
  assignedTo?: string;
  dueAt?: string;
  createdAt: string;
};

export type HousekeepingEventRecord = {
  id: string;
  taskId: string;
  eventType: "created" | "assigned" | "started" | "done" | "rejected" | "photo_added" | "minibar_note" | "lost_found";
  note?: string;
  photoObjectKey?: string;
  createdBy?: string;
  createdAt: string;
};

export type WorkOrderRecord = {
  id: string;
  propertyId: string;
  roomId?: string;
  assetId?: string;
  title: string;
  description?: string;
  priority: "emergency" | "urgent" | "normal" | "preventive";
  status: "open" | "assigned" | "in_progress" | "waiting_vendor" | "resolved" | "closed";
  blocksRoom: boolean;
  createdBy?: string;
  assignedTo?: string;
  createdAt: string;
  resolvedAt?: string;
};

export type WorkOrderMediaRecord = {
  id: string;
  workOrderId: string;
  objectKey: string;
  mediaType: "photo" | "video";
};

export type AssetRecord = {
  id: string;
  propertyId: string;
  buildingId?: string;
  floorId?: string;
  zoneId?: string;
  spaceId?: string;
  roomId?: string;
  assetType: "hvac" | "bed" | "tv" | "boiler" | "elevator" | "pool" | "kitchen_equipment";
  assetCode?: string;
  name: string;
  serialNumber?: string;
  manufacturer?: string;
  model?: string;
  installationDate?: string;
  warrantyUntil?: string;
  purchaseCost?: number;
  usefulLifeMonths?: number;
  qrCodeValue?: string;
  supplierId?: string;
  status: "active" | "needs_attention" | "retired";
};

export type CapexProjectRecord = {
  id: string;
  propertyId: string;
  name: string;
  description?: string;
  budget: number;
  status: "proposed" | "approved" | "in_progress" | "completed" | "cancelled";
  startDate?: string;
  targetEndDate?: string;
  ownerApprovedBy?: string;
};

export type CapexItemRecord = {
  id: string;
  capexProjectId: string;
  roomId?: string;
  assetId?: string;
  description: string;
  estimatedCost: number;
  actualCost: number;
  status: "proposed" | "approved" | "in_progress" | "completed" | "cancelled";
};

export type FixedAssetRecord = {
  id: string;
  propertyId: string;
  assetId?: string;
  name: string;
  acquisitionDate?: string;
  acquisitionCost: number;
  depreciationMethod?: "linear";
  usefulLifeMonths?: number;
  accumulatedDepreciation: number;
};

export type ConversationRecord = {
  id: string;
  propertyId: string;
  guestId?: string;
  reservationId?: string;
  channel: "whatsapp" | "email" | "webchat" | "sms" | "app";
  status: "open" | "closed" | "handoff";
  aiEnabled: boolean;
  createdAt: string;
};

export type MessageRecord = {
  id: string;
  conversationId: string;
  senderType: "guest" | "staff" | "ai";
  body: string;
  language?: string;
  sentAt: string;
  metadataJson?: Record<string, unknown>;
  attachments?: ChatAttachment[];
};

export type ServiceRequestRecord = {
  id: string;
  propertyId: string;
  reservationId?: string;
  guestId?: string;
  requestType: "towels" | "cleaning" | "maintenance" | "parking" | "breakfast" | "late_checkout";
  status: "open" | "assigned" | "done" | "cancelled";
  assignedDepartment?: "housekeeping" | "maintenance" | "reception" | "concierge";
  createdAt: string;
};

export type GuestRegisterRecord = {
  id: string;
  propertyId: string;
  reservationId?: string;
  guestId?: string;
  recordType?: "reservation" | "checkin" | "cancellation" | "correction" | "annulment";
  status:
    | "draft"
    | "missing_data"
    | "ready_to_sign"
    | "signed"
    | "ready_to_submit"
    | "queued"
    | "exported"
    | "submitted"
    | "accepted"
    | "rejected"
    | "failed"
    | "annulled"
    | "corrected"
    | "expired";
  isPrimaryGuest?: boolean;
  isMinor?: boolean;
  providedByAdultGuestId?: string;
  firstName?: string;
  surname1?: string;
  surname2?: string;
  sex?: string;
  nationality?: string;
  dateOfBirth?: string;
  documentType?: string;
  documentNumber?: string;
  documentSupportNumber?: string;
  residenceFullAddress?: string;
  residenceLocality?: string;
  residenceCountry?: string;
  phoneLandline?: string;
  phoneMobile?: string;
  email?: string;
  travellerCount?: number;
  kinshipRelationIfMinor?: string;
  contractReference?: string;
  contractDate?: string;
  checkinAt?: string;
  checkoutAt?: string;
  propertyFullAddress?: string;
  contractedRoomCount?: number;
  internetConnection?: boolean;
  paymentType?: string;
  paymentMethodIdentifier?: string;
  paymentHolder?: string;
  paymentDate?: string;
  paymentReference?: string;
  requiredPayloadJson: Record<string, unknown>;
  validationErrorsJson?: Array<Record<string, unknown>>;
  signatureRequired?: boolean;
  signatureObjectKey?: string;
  signedAt?: string;
  identityVerified?: boolean;
  identityVerifiedBy?: string;
  identityVerifiedAt?: string;
  identityVerificationMethod?: string;
  idImageStored?: boolean;
  idImageDiscarded?: boolean;
  idImageDiscardedAt?: string;
  retentionUntil: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt?: string;
};

export type SesSubmissionRecord = {
  id: string;
  propertyId: string;
  guestRegisterRecordId: string;
  submissionType: "reservation" | "checkin" | "cancellation";
  status: "queued" | "sent" | "accepted" | "rejected" | "failed";
  requestPayloadJson: Record<string, unknown>;
  responsePayloadJson?: Record<string, unknown>;
  errorMessage?: string;
  submittedAt?: string;
};

export type AuthorityReportingSettingRecord = {
  id: string;
  propertyId: string;
  country: "ES" | string;
  regionCode?: string;
  authorityType: "ses_hospedajes" | "mossos" | "ertzaintza" | "manual" | "other";
  enabled: boolean;
  professionalActivity: boolean;
  establishmentCode?: string;
  landlordCode?: string;
  webServiceEnabled: boolean;
  webServiceUsername?: string;
  webServiceSecretRef?: string;
  batchExportEnabled: boolean;
  automaticSubmissionEnabled: boolean;
  configurationJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type LodgingLegalProfileRecord = {
  id: string;
  propertyId: string;
  legalName: string;
  taxId: string;
  municipality?: string;
  province?: string;
  phone?: string;
  email?: string;
  website?: string;
  listingUrl?: string;
  establishmentType?: string;
  establishmentName?: string;
  fullAddress: string;
  postalCode?: string;
  locality?: string;
  establishmentProvince?: string;
  roomCount?: number;
  internetConnection?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AuthoritySubmissionBatchRecord = {
  id: string;
  propertyId: string;
  authorityType: "ses_hospedajes" | "mossos" | "ertzaintza" | "manual" | "other";
  batchType: "daily_batch" | "immediate_batch" | "manual_export" | "retry_batch";
  status: "draft" | "generated" | "queued" | "submitted" | "accepted" | "partially_accepted" | "rejected" | "failed" | "cancelled";
  periodFrom?: string;
  periodTo?: string;
  fileFormat?: "xml" | "txt" | "json" | "api";
  fileObjectKey?: string;
  recordCount: number;
  idempotencyKey?: string;
  generatedBy?: string;
  submittedBy?: string;
  generatedAt?: string;
  submittedAt?: string;
  responseReceivedAt?: string;
  responsePayloadJson: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type AuthoritySubmissionBatchRecordLink = {
  id: string;
  batchId: string;
  guestRegisterRecordId: string;
  status: "included" | "accepted" | "rejected" | "failed";
  responsePayloadJson: Record<string, unknown>;
  errorMessage?: string;
};

export type AuthoritySubmissionRecord = {
  id: string;
  propertyId: string;
  guestRegisterRecordId?: string;
  batchId?: string;
  authorityType: "ses_hospedajes" | "mossos" | "ertzaintza" | "manual" | "other";
  submissionType: "reservation" | "checkin" | "cancellation" | "correction" | "annulment";
  status: "queued" | "sent" | "accepted" | "rejected" | "failed" | "annulled";
  externalReference?: string;
  requestPayloadJson: Record<string, unknown>;
  responsePayloadJson: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  submittedAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type IdentityDocumentProcessingEventRecord = {
  id: string;
  propertyId: string;
  reservationId?: string;
  guestId?: string;
  eventType: "temporary_scan_started" | "ocr_completed" | "image_discarded" | "manual_verification_completed";
  processor: "on_device" | "trusted_ocr_provider" | "manual";
  fieldsExtractedJson: Record<string, unknown>;
  confidenceJson: Record<string, unknown>;
  imageStored: boolean;
  imageDiscarded: boolean;
  createdBy?: string;
  createdAt: string;
};

export type AuthorityRoutingRuleRecord = {
  id: string;
  propertyId?: string;
  country: string;
  regionCode?: string;
  authorityType: "ses_hospedajes" | "mossos" | "ertzaintza" | "manual" | "other";
  priority: number;
  active: boolean;
  configurationJson: Record<string, unknown>;
  createdAt: string;
};

export type AiToolCallRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  userId: string;
  toolName: string;
  inputJson: unknown;
  outputJson?: unknown;
  confidence?: number;
  requiredConfirmation: boolean;
  confirmedBy?: string;
  status: "pending_confirmation" | "executed" | "rejected" | "failed";
  createdAt: string;
};

export type PendingConfirmation = {
  id: string;
  type: "check_in_from_scan";
  propertyId: string;
  organizationId: string;
  userId: string;
  reservationId: string;
  roomId: string;
  guestId: string;
  guestRegisterRecordId: string;
  card: unknown;
  createdAt: string;
  requiredSignature: boolean;
};

export type RevenueForecastRecord = {
  id: string;
  propertyId: string;
  forecastDate: string;
  roomTypeId?: string;
  ratePlanId?: string;
  channelId?: string;
  segment?: string;
  channel?: string;
  expectedOccupancy: number;
  expectedRoomsSold?: number;
  expectedAdr?: number;
  expectedRevpar?: number;
  expectedTrevpar?: number;
  expectedGoppar?: number;
  expectedRoomRevenue: number;
  expectedTotalRevenue: number;
  expectedProfit: number;
  cancellationProbability?: number;
  noShowProbability?: number;
  confidence: number;
  driversJson?: string[];
  modelVersion: string;
  createdAt: string;
};

export type RevenueRecommendationRecord = {
  id: string;
  propertyId: string;
  recommendationType: "rate" | "restriction" | "stop_sell" | "min_stay";
  targetDate: string;
  roomTypeId?: string;
  ratePlanId?: string;
  channelId?: string;
  currentValueJson: Record<string, unknown>;
  recommendedValueJson: Record<string, unknown>;
  expectedImpactJson?: Record<string, unknown>;
  reason?: string;
  reasonJson?: string[];
  confidence: number;
  riskLevel?: "low" | "medium" | "high" | "critical";
  status: "pending" | "approved" | "applied" | "rejected";
  approvedBy?: string;
  rejectedBy?: string;
  appliedAt?: string;
  createdAt: string;
};

export type DemandCalendarEventRecord = {
  id: string;
  propertyId: string;
  name: string;
  eventType?: string;
  startDate: string;
  endDate: string;
  expectedImpact?: string;
  impactScore?: number;
  source?: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
};

export type RatePlanRecord = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  ratePlanType: "bar" | "derived" | "package" | "corporate" | "group";
  parentRatePlanId?: string;
  derivationJson: Record<string, unknown>;
  cancellationPolicyId?: string;
  mealPlan?: string;
  active: boolean;
  createdAt: string;
};

export type RateDayRecord = {
  id: string;
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  price: number;
  currency: string;
  minPrice?: number;
  maxPrice?: number;
  manuallyOverridden: boolean;
  syncStatus: "synced" | "pending" | "failed";
  updatedBy?: string;
  updatedAt: string;
};

export type InventoryDayRecord = {
  id: string;
  propertyId: string;
  roomTypeId: string;
  date: string;
  totalInventory: number;
  availableCount: number;
  outOfOrderCount: number;
  overbookingLimit: number;
  stopSell: boolean;
  updatedAt: string;
};

export type RestrictionDayRecord = {
  id: string;
  propertyId: string;
  roomTypeId: string;
  ratePlanId?: string;
  channelId?: string;
  date: string;
  minStay?: number;
  maxStay?: number;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
  restrictionSource: "manual" | "ai_recommendation" | "automation";
  updatedAt: string;
};

export type RevenueChannelRecord = {
  id: string;
  propertyId: string;
  providerCode: "booking_com_mock" | "expedia_mock" | "google_hotels_mock" | "direct_booking_engine" | "manual_channel";
  name: string;
  channelType: "ota" | "metasearch" | "direct" | "manual";
  status: "active" | "inactive" | "error";
  commissionPercent?: number;
  paymentCostPercent?: number;
  configurationJson: Record<string, unknown>;
  credentialsSecretRef?: string;
  lastSyncAt?: string;
  createdAt: string;
};

export type ChannelRoomMappingRecord = {
  id: string;
  channelId: string;
  roomTypeId: string;
  externalRoomCode: string;
  externalRoomName?: string;
  status: "active" | "missing" | "invalid";
};

export type ChannelRateMappingRecord = {
  id: string;
  channelId: string;
  ratePlanId: string;
  externalRateCode: string;
  externalRateName?: string;
  status: "active" | "missing" | "invalid";
};

export type ChannelSyncJobRecord = {
  id: string;
  propertyId: string;
  channelId?: string;
  syncType: "availability" | "rates" | "restrictions" | "full" | "reservation_import";
  status: "queued" | "running" | "succeeded" | "failed" | "blocked";
  dateRangeStart?: string;
  dateRangeEnd?: string;
  requestPayloadJson: Record<string, unknown>;
  responsePayloadJson: Record<string, unknown>;
  errorMessage?: string;
  idempotencyKey?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
};

export type CompetitorHotelRecord = {
  id: string;
  propertyId: string;
  name: string;
  locationJson: Record<string, unknown>;
  category?: string;
  starRating?: number;
  comparableScore?: number;
  active: boolean;
  createdAt: string;
};

export type CompetitorRateSnapshotRecord = {
  id: string;
  propertyId: string;
  competitorHotelId?: string;
  sourceChannel?: string;
  shopDate: string;
  stayDate: string;
  roomTypeLabel?: string;
  ratePlanLabel?: string;
  price?: number;
  currency?: string;
  availabilityStatus?: string;
  cancellationPolicyLabel?: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
};

export type RateParityAlertRecord = {
  id: string;
  propertyId: string;
  alertType: "ota_cheaper_than_direct" | "direct_missing" | "tax_fee_mismatch" | "currency_mismatch" | "package_mismatch";
  severity: "info" | "warning" | "critical" | "blocking";
  stayDate: string;
  sourceChannel?: string;
  directRate?: number;
  channelRate?: number;
  currency?: string;
  message: string;
  suggestedAction: string;
  status: "open" | "acknowledged" | "resolved";
  metadataJson: Record<string, unknown>;
  createdAt: string;
};

export type RevenueAutomationRuleRecord = {
  id: string;
  propertyId: string;
  name: string;
  automationLevel: "manual_only" | "recommend_only" | "approve_required" | "auto_apply_within_limits" | "auto_apply_low_risk";
  scopeJson: Record<string, unknown>;
  constraintsJson: Record<string, unknown>;
  active: boolean;
  createdBy?: string;
  createdAt: string;
};

export type RevenueScenarioRecord = {
  id: string;
  propertyId: string;
  name: string;
  scenarioType: "rate_change" | "restriction_change" | "channel_closeout" | "group_displacement";
  inputJson: Record<string, unknown>;
  outputJson: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
};

export type ExternalReservationRecord = {
  id: string;
  propertyId: string;
  channelId?: string;
  externalReservationId: string;
  status: "new" | "modified" | "cancelled" | "imported";
  guestName?: string;
  arrivalDate?: string;
  departureDate?: string;
  payloadJson: Record<string, unknown>;
  importedAt: string;
};

export type ChannelProfitabilitySnapshotRecord = {
  id: string;
  propertyId: string;
  date: string;
  channel: string;
  grossRevenue: number;
  commissionCost: number;
  paymentCost: number;
  operatingCost: number;
  netRevenue: number;
  profit: number;
  createdAt: string;
};

export type RevenueDailySnapshotRecord = {
  id: string;
  propertyId: string;
  snapshotDate: string;
  roomTypeId?: string;
  ratePlanId?: string;
  channelId?: string;
  segment?: string;
  market?: string;
  totalOcc: number;
  availableRooms: number;
  arrivalRooms: number;
  departureRooms: number;
  compRooms: number;
  houseUseRooms: number;
  dayUseRooms: number;
  noShowRooms: number;
  oooRooms: number;
  deductIndividualRooms: number;
  nonDeductIndividualRooms: number;
  deductGroupRooms: number;
  nonDeductGroupRooms: number;
  adultsChildren: number;
  roomRevenue: number;
  totalRevenue: number;
  netRoomRevenue: number;
  grossOperatingProfit?: number;
  adr?: number;
  revpar?: number;
  trevpar?: number;
  goppar?: number;
  occupancyPercent?: number;
  dataSource: "system" | "night_audit" | "import";
  createdAt: string;
  updatedAt: string;
};

export type RevenueForecastSnapshotRecord = {
  id: string;
  propertyId: string;
  forecastDate: string;
  roomTypeId?: string;
  ratePlanId?: string;
  channelId?: string;
  segment?: string;
  market?: string;
  expectedTotalOcc: number;
  availableRooms: number;
  expectedArrivalRooms: number;
  expectedDepartureRooms: number;
  expectedCompRooms: number;
  expectedHouseUseRooms: number;
  expectedDayUseRooms: number;
  expectedNoShowRooms: number;
  expectedOooRooms: number;
  expectedDeductIndividualRooms: number;
  expectedNonDeductIndividualRooms: number;
  expectedDeductGroupRooms: number;
  expectedNonDeductGroupRooms: number;
  expectedAdultsChildren: number;
  expectedRoomRevenue: number;
  expectedTotalRevenue: number;
  expectedNetRoomRevenue: number;
  expectedGrossOperatingProfit?: number;
  expectedAdr?: number;
  expectedRevpar?: number;
  expectedTrevpar?: number;
  expectedGoppar?: number;
  expectedOccupancyPercent?: number;
  confidence: number;
  confidenceLowJson: Record<string, number>;
  confidenceHighJson: Record<string, number>;
  driversJson: string[];
  dataQualityScore: number;
  modelVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type RevenueReportViewRecord = {
  id: string;
  propertyId: string;
  userId?: string;
  name: string;
  reportType: "history_forecast";
  filtersJson: Record<string, unknown>;
  layoutJson: Record<string, unknown>;
  isShared: boolean;
  createdAt: string;
};

export type GuestProfileRecord = {
  id: string;
  organizationId: string;
  primaryGuestId?: string;
  displayName: string;
  email?: string;
  phone?: string;
  preferredLanguage?: string;
  vipLevel?: string;
  lifetimeValue: number;
  totalStays: number;
  totalNights: number;
  totalSpend: number;
  preferencesJson: Record<string, unknown>;
  consentJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type GuestProfileLinkRecord = {
  id: string;
  guestProfileId: string;
  guestId: string;
  linkConfidence: number;
  linkReason: string;
  createdAt: string;
};

export type CrmSegmentRecord = {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  rulesJson: Record<string, unknown>;
  active: boolean;
  createdAt: string;
};

export type CrmCampaignRecord = {
  id: string;
  organizationId: string;
  name: string;
  campaignType: string;
  segmentId?: string;
  channel: string;
  status: "draft" | "scheduled" | "sent" | "paused";
  scheduleJson: Record<string, unknown>;
  contentJson: Record<string, unknown>;
  createdAt: string;
};

export type LoyaltyProgramRecord = {
  id: string;
  organizationId: string;
  name: string;
  configurationJson: Record<string, unknown>;
  active: boolean;
  createdAt: string;
};

export type LoyaltyMembershipRecord = {
  id: string;
  loyaltyProgramId: string;
  guestProfileId: string;
  tier?: string;
  pointsBalance: number;
  status: "active" | "paused" | "cancelled";
  joinedAt: string;
};

export type SalesAccountRecord = {
  id: string;
  organizationId: string;
  accountType: "company" | "agency" | "event_planner";
  name: string;
  taxId?: string;
  contactJson: Record<string, unknown>;
  billingJson: Record<string, unknown>;
  status: "active" | "inactive";
  createdAt: string;
};

export type SalesOpportunityRecord = {
  id: string;
  propertyId: string;
  accountId?: string;
  name: string;
  opportunityType: "group" | "event" | "corporate_rate";
  stage: "lead" | "qualified" | "proposal" | "contract" | "won" | "lost";
  estimatedValue: number;
  expectedCloseDate?: string;
  ownerUserId?: string;
  createdAt: string;
};

export type GroupBookingRecord = {
  id: string;
  propertyId: string;
  accountId?: string;
  opportunityId?: string;
  name: string;
  status: "draft" | "tentative" | "confirmed" | "released" | "cancelled";
  arrivalDate: string;
  departureDate: string;
  releaseDate?: string;
  masterFolioId?: string;
  billingRulesJson: Record<string, unknown>;
  createdAt: string;
};

export type GroupRoomBlockRecord = {
  id: string;
  groupBookingId: string;
  roomTypeId: string;
  date: string;
  blockedCount: number;
  pickedUpCount: number;
  rate: number;
  createdAt: string;
};

export type EventSpaceRecord = {
  id: string;
  propertyId: string;
  name: string;
  spaceId?: string;
  capacityJson: Record<string, unknown>;
  active: boolean;
  createdAt: string;
};

export type HotelEventRecord = {
  id: string;
  propertyId: string;
  groupBookingId?: string;
  eventSpaceId?: string;
  name: string;
  eventType?: string;
  startAt: string;
  endAt: string;
  status: "draft" | "confirmed" | "completed" | "cancelled";
  setupJson: Record<string, unknown>;
  cateringJson: Record<string, unknown>;
  createdAt: string;
};

export type EventOrderRecord = {
  id: string;
  eventId: string;
  orderType: "beo" | "proposal" | "contract";
  contentJson: Record<string, unknown>;
  status: "draft" | "sent" | "approved";
  createdAt: string;
};

export type UserContext = {
  organizationId: string;
  propertyId: string;
  userId: string;
  fullName: string;
  deviceId: string;
  permissions: PermissionKey[];
};

export type DemoStore = {
  organization: OrganizationRecord;
  property: PropertyRecord;
  properties: PropertyRecord[];
  users: UserRecord[];
  devices: DeviceRecord[];
  sessions: SessionRecord[];
  mfaChallenges: MfaChallengeRecord[];
  notifications: NotificationRecord[];
  modules: ModuleRecord[];
  propertyModules: PropertyModuleRecord[];
  moduleDependencies: ModuleDependencyRecord[];
  integrationCategories: IntegrationCategoryRecord[];
  integrationProviders: IntegrationProviderRecord[];
  integrationConnections: IntegrationConnectionRecord[];
  integrationEvents: IntegrationEventRecord[];
  buildings: BuildingRecord[];
  floors: FloorRecord[];
  propertyZones: PropertyZoneRecord[];
  propertySpaces: PropertySpaceRecord[];
  propertyMapPositions: PropertyMapPositionRecord[];
  roomFeatures: RoomFeatureRecord[];
  roomFeatureAssignments: RoomFeatureAssignmentRecord[];
  bedTypes: BedTypeRecord[];
  roomBeds: RoomBedRecord[];
  propertySetupSteps: PropertySetupStepRecord[];
  propertyReadinessChecks: PropertyReadinessCheckRecord[];
  moduleHealthChecks: ModuleHealthCheckRecord[];
  departments: DepartmentRecord[];
  userDepartments: UserDepartmentRecord[];
  housekeepingSections: HousekeepingSectionRecord[];
  housekeepingSectionRooms: HousekeepingSectionRoomRecord[];
  housekeepingRules: RuleRecord[];
  maintenanceAreas: MaintenanceAreaRecord[];
  maintenanceAreaRooms: MaintenanceAreaRoomRecord[];
  maintenanceRules: RuleRecord[];
  propertyComplianceSettings: PropertyComplianceSettingsRecord[];
  invoiceSequences: InvoiceSequenceRecord[];
  accountingSettings: AccountingSettingsRecord[];
  costCenters: CostCenterRecord[];
  propertyAiSettings: PropertyAiSettingsRecord[];
  propertyAiToolSettings: PropertyAiToolSettingsRecord[];
  documentTemplates: DocumentTemplateRecord[];
  qrCodes: QrCodeRecord[];
  propertyImports: PropertyImportRecord[];
  propertySetupFormSubmissions: PropertySetupFormSubmissionRecord[];
  manualSetupSubmissions: ManualSetupSubmissionRecord[];
  backOfficeAiSuggestions: BackOfficeAiSuggestionRecord[];
  offlineSyncRecords: OfflineSyncRecord[];
  userContext: UserContext;
  roomTypes: RoomTypeRecord[];
  rooms: RoomRecord[];
  guests: GuestRecord[];
  reservations: ReservationRecord[];
  folios: FolioRecord[];
  folioLines: FolioLineRecord[];
  payments: PaymentRecord[];
  ratePlans: RatePlanRecord[];
  rateDays: RateDayRecord[];
  inventoryDays: InventoryDayRecord[];
  restrictionDays: RestrictionDayRecord[];
  channels: RevenueChannelRecord[];
  channelRoomMappings: ChannelRoomMappingRecord[];
  channelRateMappings: ChannelRateMappingRecord[];
  channelSyncJobs: ChannelSyncJobRecord[];
  revenueForecasts: RevenueForecastRecord[];
  revenueRecommendations: RevenueRecommendationRecord[];
  demandCalendarEvents: DemandCalendarEventRecord[];
  channelProfitabilitySnapshots: ChannelProfitabilitySnapshotRecord[];
  revenueDailySnapshots: RevenueDailySnapshotRecord[];
  revenueForecastSnapshots: RevenueForecastSnapshotRecord[];
  revenueReportViews: RevenueReportViewRecord[];
  competitorHotels: CompetitorHotelRecord[];
  competitorRateSnapshots: CompetitorRateSnapshotRecord[];
  rateParityAlerts: RateParityAlertRecord[];
  revenueAutomationRules: RevenueAutomationRuleRecord[];
  revenueScenarios: RevenueScenarioRecord[];
  externalReservations: ExternalReservationRecord[];
  guestProfiles: GuestProfileRecord[];
  guestProfileLinks: GuestProfileLinkRecord[];
  crmSegments: CrmSegmentRecord[];
  crmCampaigns: CrmCampaignRecord[];
  loyaltyPrograms: LoyaltyProgramRecord[];
  loyaltyMemberships: LoyaltyMembershipRecord[];
  salesAccounts: SalesAccountRecord[];
  salesOpportunities: SalesOpportunityRecord[];
  groupBookings: GroupBookingRecord[];
  groupRoomBlocks: GroupRoomBlockRecord[];
  eventSpaces: EventSpaceRecord[];
  hotelEvents: HotelEventRecord[];
  eventOrders: EventOrderRecord[];
  housekeepingTasks: HousekeepingTaskRecord[];
  housekeepingEvents: HousekeepingEventRecord[];
  workOrders: WorkOrderRecord[];
  workOrderMedia: WorkOrderMediaRecord[];
  /**
   * Generic persisted records for the "advanced modules" CRUD (workforce shifts,
   * time-clock, absences, safety incidents/checks, etc.) so create/transition/list
   * actually round-trip and the boards are live. Keyed by propertyId+moduleCode+entityType.
   */
  advancedRecords: Array<{
    id: string;
    propertyId: string;
    moduleCode: string;
    entityType: string;
    status: string;
    payload: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }>;
  assets: AssetRecord[];
  capexProjects: CapexProjectRecord[];
  capexItems: CapexItemRecord[];
  fixedAssets: FixedAssetRecord[];
  conversations: ConversationRecord[];
  messages: MessageRecord[];
  serviceRequests: ServiceRequestRecord[];
  guestRegisterRecords: GuestRegisterRecord[];
  sesSubmissions: SesSubmissionRecord[];
  authorityReportingSettings: AuthorityReportingSettingRecord[];
  lodgingLegalProfiles: LodgingLegalProfileRecord[];
  authoritySubmissionBatches: AuthoritySubmissionBatchRecord[];
  authoritySubmissionBatchRecords: AuthoritySubmissionBatchRecordLink[];
  authoritySubmissions: AuthoritySubmissionRecord[];
  identityDocumentProcessingEvents: IdentityDocumentProcessingEventRecord[];
  authorityRoutingRules: AuthorityRoutingRuleRecord[];
  aiToolCalls: AiToolCallRecord[];
  auditEvents: AuditEvent[];
  events: EventEnvelope[];
  pendingConfirmations: PendingConfirmation[];
};

export const demoStore: DemoStore = {
  organization: {
    id: "org_123",
    name: "HotelOS Demo Group",
    legalName: "HotelOS Demo SL",
    taxId: "B12345678"
  },
  property: {
    id: "prop_123",
    organizationId: "org_123",
    name: "HotelOS Madrid Centro",
    legalName: "HotelOS Madrid Centro SL",
    address: "Calle Demo 12",
    municipality: "Madrid",
    province: "Madrid",
    timezone: "Europe/Madrid",
    country: "ES",
    taxRegion: "Madrid",
    sesHospedajesEnabled: true,
    verifactuEnabled: true
  },
  properties: [
    {
      id: "prop_123",
      organizationId: "org_123",
      name: "HotelOS Madrid Centro",
      legalName: "HotelOS Madrid Centro SL",
      address: "Calle Demo 12",
      municipality: "Madrid",
      province: "Madrid",
      timezone: "Europe/Madrid",
      country: "ES",
      taxRegion: "Madrid",
      sesHospedajesEnabled: true,
      verifactuEnabled: true
    },
    {
      id: "prop_456",
      organizationId: "org_123",
      name: "HotelOS Costa",
      legalName: "HotelOS Costa SL",
      address: "Avenida Demo 20",
      municipality: "Malaga",
      province: "Malaga",
      timezone: "Europe/Madrid",
      country: "ES",
      taxRegion: "Andalucia",
      sesHospedajesEnabled: true,
      verifactuEnabled: false
    }
  ],
  users: [
    {
      id: "usr_123",
      organizationId: "org_123",
      email: "reception@example.com",
      phone: "+34910000000",
      fullName: "Reception Demo",
      status: "active",
      mfaEnabled: true
    }
  ],
  devices: [
    {
      id: "dev_reception_1",
      userId: "usr_123",
      deviceName: "Reception iPhone",
      platform: "ios",
      trusted: true,
      registeredAt: "2026-05-14T08:00:00.000Z",
      lastSeenAt: "2026-05-14T09:00:00.000Z"
    }
  ],
  sessions: [
    {
      id: "sess_demo",
      userId: "usr_123",
      deviceId: "dev_reception_1",
      status: "active",
      createdAt: "2026-05-14T08:00:00.000Z",
      lastSeenAt: "2026-05-14T09:00:00.000Z"
    }
  ],
  mfaChallenges: [],
  notifications: [
    {
      id: "notif_compliance_phone",
      propertyId: "prop_123",
      userId: "usr_123",
      type: "compliance",
      title: "Missing guest phone",
      body: "Guest register for RES-18392 is missing a phone number.",
      status: "unread",
      createdAt: "2026-05-14T09:20:00.000Z"
    },
    {
      id: "notif_maintenance_108",
      propertyId: "prop_123",
      userId: "usr_123",
      type: "maintenance",
      title: "Room 108 blocked",
      body: "Bathroom leak work order is open and blocks inventory.",
      status: "unread",
      createdAt: "2026-05-14T08:30:00.000Z"
    }
  ],
  modules: HOTEL_MODULES.map((module) => ({
    id: `mod_${module.code}`,
    code: module.code,
    name: module.name,
    description: module.description,
    category: module.category,
    isCore: module.isCore,
    createdAt: "2026-05-14T08:00:00.000Z"
  })),
  propertyModules: HOTEL_MODULES.map((module) => {
    const enabledModules: HotelModuleCode[] = [
      "pms_core",
      "ai_front_desk",
      "housekeeping",
      "maintenance",
      "erp_accounting",
      "compliance_hub",
      "payment_vault",
      "guest_experience",
      "ai_concierge",
      "asset_intelligence",
      "module_marketplace",
      "integration_marketplace",
      "owner_mode",
      "distribution_hub",
      "compliance_billing",
      "capex_manager",
      "revenue_profit_engine",
      "guest_data_crm_loyalty",
      "groups_events_sales",
      "workforce_labor",
      "procurement_inventory",
      "guest_self_service",
      "reputation_quality",
      "energy_sustainability",
      "safety_incident_management",
      "hotel_intelligence_platform",
      "developer_platform",
      "ai_governance",
      "ai_onboarding_migration",
      "spain_guest_register_compliance"
    ];
    const enabled = module.isCore || enabledModules.includes(module.code);
    return {
      id: `pm_prop_123_${module.code}`,
      propertyId: "prop_123",
      moduleId: `mod_${module.code}`,
      status: enabled ? "enabled" : "disabled",
      configurationJson: {},
      enabledAt: enabled ? "2026-05-14T08:00:00.000Z" : undefined,
      disabledAt: enabled ? undefined : "2026-05-14T08:00:00.000Z",
      createdAt: "2026-05-14T08:00:00.000Z"
    };
  }),
  moduleDependencies: HOTEL_MODULES.flatMap((module) =>
    module.dependencies.map((dependency) => ({
      id: `mdep_${module.code}_${dependency}`,
      moduleId: `mod_${module.code}`,
      requiredModuleId: `mod_${dependency}`
    }))
  ),
  integrationCategories: [
    { id: "icat_otas", code: "otas", name: "OTAs", description: "Reservation demand channels." },
    { id: "icat_channel_managers", code: "channel_managers", name: "Channel Managers", description: "Rate and availability distribution." },
    { id: "icat_payment_gateways", code: "payment_gateways", name: "Payment Gateways", description: "Payment links, tokenization and capture." },
    { id: "icat_guest_messaging", code: "guest_messaging", name: "Guest Messaging", description: "WhatsApp, email, SMS and web chat." },
    { id: "icat_einvoicing", code: "einvoicing", name: "E-invoicing Providers", description: "Structured invoice delivery and status events." },
    { id: "icat_government_compliance", code: "government_compliance", name: "Government Compliance", description: "Authority submissions and compliance APIs." },
    { id: "icat_pos", code: "pos", name: "POS", description: "Restaurant, bar, spa and shop outlets." }
  ],
  integrationProviders: [
    {
      id: "ip_mock_ota",
      categoryId: "icat_otas",
      code: "mock_ota",
      name: "Demo OTA Adapter",
      authType: "api_key",
      supportedRegions: ["EU"],
      capabilitiesJson: { capabilities: ["pull_reservations"] },
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "ip_mock_payments",
      categoryId: "icat_payment_gateways",
      code: "mock_payments",
      name: "Demo Payment Gateway",
      authType: "api_key",
      supportedRegions: ["EU"],
      capabilitiesJson: { capabilities: ["send_payment_link", "capture_payment"] },
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "ip_mock_messaging",
      categoryId: "icat_guest_messaging",
      code: "mock_messaging",
      name: "Demo Guest Messaging",
      authType: "webhook",
      supportedRegions: ["EU"],
      capabilitiesJson: { capabilities: ["send_message"] },
      createdAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  integrationConnections: [
    {
      id: "iconn_mock_payments",
      propertyId: "prop_123",
      providerId: "ip_mock_payments",
      status: "connected",
      credentialsSecretRef: "secret://hotelos/prop_123/mock_payments",
      configJson: { settlementCurrency: "EUR" },
      lastSyncAt: "2026-05-14T09:00:00.000Z",
      createdAt: "2026-05-14T08:20:00.000Z"
    }
  ],
  integrationEvents: [
    {
      id: "ievt_mock_payment_test",
      connectionId: "iconn_mock_payments",
      direction: "outbound",
      eventType: "ConnectionTested",
      payloadJson: { providerCode: "mock_payments" },
      status: "accepted",
      createdAt: "2026-05-14T09:00:00.000Z"
    }
  ],
  buildings: [
    {
      id: "bld_main",
      propertyId: "prop_123",
      name: "Main Building",
      code: "MAIN",
      description: "Primary guest room building.",
      sortOrder: 1,
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  floors: [
    {
      id: "floor_4",
      propertyId: "prop_123",
      buildingId: "bld_main",
      name: "Floor 4",
      floorNumber: 4,
      code: "F4",
      sortOrder: 4,
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "floor_1",
      propertyId: "prop_123",
      buildingId: "bld_main",
      name: "Floor 1",
      floorNumber: 1,
      code: "F1",
      sortOrder: 1,
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  propertyZones: [
    {
      id: "zone_f4_east",
      propertyId: "prop_123",
      buildingId: "bld_main",
      floorId: "floor_4",
      name: "East Wing",
      code: "F4E",
      zoneType: "guest_rooms",
      sortOrder: 1,
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "zone_lobby",
      propertyId: "prop_123",
      buildingId: "bld_main",
      floorId: "floor_1",
      name: "Lobby",
      code: "LOB",
      zoneType: "public_area",
      sortOrder: 1,
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  propertySpaces: [
    {
      id: "space_reception",
      propertyId: "prop_123",
      buildingId: "bld_main",
      floorId: "floor_1",
      zoneId: "zone_lobby",
      name: "Reception",
      code: "REC",
      spaceType: "reception",
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  propertyMapPositions: [
    {
      id: "pos_room_432",
      propertyId: "prop_123",
      entityType: "room",
      entityId: "room_432",
      floorId: "floor_4",
      x: 42,
      y: 30,
      width: 14,
      height: 10,
      metadataJson: { label: "432" },
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  roomFeatures: [
    { id: "rf_city_view", propertyId: "prop_123", code: "city_view", name: "City view", category: "view", active: true },
    { id: "rf_minibar", propertyId: "prop_123", code: "minibar", name: "Minibar", category: "amenity", active: true }
  ],
  roomFeatureAssignments: [
    { id: "rfa_432_city_view", roomId: "room_432", roomFeatureId: "rf_city_view" },
    { id: "rfa_432_minibar", roomId: "room_432", roomFeatureId: "rf_minibar" }
  ],
  bedTypes: [{ id: "bed_queen", propertyId: "prop_123", code: "queen", name: "Queen bed", capacity: 2, active: true }],
  roomBeds: [{ id: "rb_432_queen", roomId: "room_432", bedTypeId: "bed_queen", quantity: 1 }],
  propertySetupSteps: [
    { id: "setup_org", propertyId: "prop_123", stepCode: "organization_details", status: "completed", completedAt: "2026-05-14T08:00:00.000Z", completedBy: "usr_123", metadataJson: {} },
    { id: "setup_property", propertyId: "prop_123", stepCode: "property_legal_details", status: "completed", completedAt: "2026-05-14T08:05:00.000Z", completedBy: "usr_123", metadataJson: {} },
    { id: "setup_map", propertyId: "prop_123", stepCode: "property_physical_map", status: "in_progress", metadataJson: { roomsMapped: 2 } },
    { id: "setup_modules", propertyId: "prop_123", stepCode: "modules", status: "completed", completedAt: "2026-05-14T08:20:00.000Z", completedBy: "usr_123", metadataJson: {} },
    { id: "setup_billing", propertyId: "prop_123", stepCode: "billing_and_invoice_sequences", status: "blocked", metadataJson: { missing: ["invoice_sequence"] } }
  ],
  propertyReadinessChecks: [
    {
      id: "ready_legal",
      propertyId: "prop_123",
      checkCode: "legal_profile_complete",
      status: "pass",
      severity: "info",
      message: "Property legal name, tax ID, address and timezone are configured.",
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "ready_invoice_sequence",
      propertyId: "prop_123",
      checkCode: "invoice_sequence_configured",
      status: "fail",
      severity: "blocking",
      message: "No invoice sequence configured for Compliance Billing.",
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "ready_ses_credentials",
      propertyId: "prop_123",
      checkCode: "ses_hospedajes_credentials",
      status: "fail",
      severity: "blocking",
      message: "SES.HOSPEDAJES credentials are missing.",
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "ready_room_inventory",
      propertyId: "prop_123",
      checkCode: "room_inventory_exists",
      status: "pass",
      severity: "info",
      message: "At least one active sellable room exists.",
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  moduleHealthChecks: [
    {
      id: "mh_checkin_ocr",
      propertyId: "prop_123",
      moduleCode: "checkin_online",
      checkCode: "ocr_provider_configured",
      status: "needs_configuration",
      severity: "blocking",
      message: "OCR provider must be configured before assisted ID scan.",
      metadataJson: {},
      updatedAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "mh_pms_rooms",
      propertyId: "prop_123",
      moduleCode: "pms_core",
      checkCode: "room_inventory_exists",
      status: "ok",
      severity: "info",
      message: "Room inventory exists.",
      metadataJson: {},
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  departments: [
    { id: "dep_reception", propertyId: "prop_123", name: "Reception", code: "reception", active: true },
    { id: "dep_housekeeping", propertyId: "prop_123", name: "Housekeeping", code: "housekeeping", active: true },
    { id: "dep_maintenance", propertyId: "prop_123", name: "Maintenance", code: "maintenance", active: true }
  ],
  userDepartments: [{ id: "ud_reception_demo", userId: "usr_123", departmentId: "dep_reception", roleLabel: "Reception Manager", active: true }],
  housekeepingSections: [{ id: "hk_f4", propertyId: "prop_123", name: "Fourth floor", code: "HK4", active: true }],
  housekeepingSectionRooms: [{ id: "hksr_432", housekeepingSectionId: "hk_f4", roomId: "room_432" }],
  housekeepingRules: [
    { id: "hkr_departure_clean", propertyId: "prop_123", ruleCode: "departure_cleaning_policy", configurationJson: { defaultDurationMinutes: 35 }, active: true }
  ],
  maintenanceAreas: [{ id: "ma_f4", propertyId: "prop_123", name: "Fourth floor maintenance", code: "M4", active: true }],
  maintenanceAreaRooms: [{ id: "mar_432", maintenanceAreaId: "ma_f4", roomId: "room_432" }],
  maintenanceRules: [
    { id: "mr_blocking", propertyId: "prop_123", ruleCode: "room_blocking_requires_confirmation", configurationJson: { managerApproval: true }, active: true }
  ],
  propertyComplianceSettings: [
    {
      id: "pcs_prop_123",
      propertyId: "prop_123",
      country: "ES",
      taxRegion: "Madrid",
      vatRegime: "general",
      tourismTaxRegion: "madrid",
      sesHospedajesEnabled: true,
      verifactuEnabled: true,
      ticketbaiEnabled: false,
      siiEnabled: false,
      b2bEinvoiceEnabled: true,
      configurationJson: { sesCredentialsConfigured: false, guestRegisterRetentionYears: 3 },
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  invoiceSequences: [],
  accountingSettings: [
    {
      id: "acct_prop_123",
      organizationId: "org_123",
      propertyId: "prop_123",
      chartTemplate: "spain_pgc_hospitality",
      fiscalYearStartMonth: 1,
      configurationJson: { monthEndChecklistEnabled: true, annualAccountsSupport: true },
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  costCenters: [
    { id: "cc_rooms", propertyId: "prop_123", code: "rooms", name: "Rooms", type: "operating", active: true },
    { id: "cc_maintenance", propertyId: "prop_123", code: "maintenance", name: "Maintenance", type: "cost", active: true }
  ],
  propertyAiSettings: [
    {
      id: "ai_prop_123",
      propertyId: "prop_123",
      aiEnabled: true,
      defaultAutomationLevel: "suggest_and_confirm",
      guestFacingDisclosure:
        "Hi, I am the hotel's AI assistant. I can help with availability, bookings, hotel information, and service requests. A staff member can take over whenever needed.",
      voiceLocales: ["es-ES", "en-US"],
      configurationJson: { documentImageRetentionPolicy: "discard_after_ocr" },
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  propertyAiToolSettings: [
    {
      id: "ait_checkin",
      propertyId: "prop_123",
      toolName: "checkInReservation",
      enabled: true,
      automationLevel: "suggest_and_confirm",
      requiresConfirmation: true,
      requiresApprovalRole: "manager",
      configurationJson: {}
    }
  ],
  documentTemplates: [
    {
      id: "tpl_welcome_es",
      propertyId: "prop_123",
      templateCode: "welcome_message",
      name: "Welcome message",
      channel: "whatsapp",
      language: "es",
      subject: "Bienvenido",
      body: "Bienvenido a HotelOS Madrid Centro. Recepcion esta disponible si necesita ayuda.",
      variablesJson: { variables: ["guest_name", "room_number"] },
      active: true,
      updatedAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  qrCodes: [
    {
      id: "qr_room_432_staff",
      propertyId: "prop_123",
      entityType: "room",
      entityId: "room_432",
      qrValue: "hotelos://prop_123/rooms/room_432",
      purpose: "staff_room",
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  propertyImports: [],
  propertySetupFormSubmissions: [],
  manualSetupSubmissions: [],
  backOfficeAiSuggestions: [
    {
      id: "boai_rooms_401_440",
      propertyId: "prop_123",
      userId: "usr_123",
      prompt: "Create rooms 401 to 440, floor 4, building Main, type Double.",
      status: "previewed",
      proposedChangesJson: {
        action: "create_room_range",
        roomRangeStart: "401",
        roomRangeEnd: "440",
        roomTypeId: "rt_double",
        buildingId: "bld_main",
        floorId: "floor_4",
        zoneId: "zone_f4_east",
        preview: "Will create 40 rooms after confirmation."
      },
      requiresConfirmation: true,
      createdAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  offlineSyncRecords: [],
  userContext: {
    organizationId: "org_123",
    propertyId: "prop_123",
    userId: "usr_123",
    fullName: "Reception Demo",
    deviceId: "dev_reception_1",
    permissions: [
      "pms.reservation.read",
      "pms.reservation.create",
      "pms.reservation.modify",
      "pms.checkin.execute",
      "pms.checkout.execute",
      "guests.read",
      "guests.manage",
      "folio.charge.post",
      "payment.capture",
      "payments.create_link",
      "payments.capture",
      "payments.refund_request",
      "housekeeping.task.manage",
      "maintenance.workorder.manage",
      "compliance.ses.submit",
      "compliance.ses.export",
      "compliance.ses.configure",
      "compliance.gdpr.manage",
      "guest_register.read",
      "guest_register.create",
      "guest_register.edit",
      "guest_register.sign",
      "guest_register.submit",
      "guest_register.export",
      "guest_register.annul",
      "guest_register.correct",
      "guest_register.view_sensitive",
      "guest_register.configure",
      "modules.read",
      "modules.enable",
      "modules.disable",
      "integrations.read",
      "integrations.connect",
      "integrations.disconnect",
      "integrations.test",
      "integrations.manage_credentials",
      "distribution.read",
      "distribution.manage_rates",
      "distribution.manage_inventory",
      "distribution.sync",
      "guest_experience.inbox.read",
      "guest_experience.message.send",
      "guest_experience.ai_reply",
      "guest_experience.handoff",
      "billing.compliance.view",
      "assets.read",
      "assets.manage",
      "owner.dashboard.read",
      "owner.ai_ask",
      "backoffice.access",
      "property.configure",
      "configuration.read",
      "configuration.manage",
      "categories.read",
      "categories.manage",
      "categories.import",
      "categories.export",
      "custom_fields.read",
      "custom_fields.manage",
      "property_profile.edit",
      "room_types.manage",
      "rooms.manage",
      "spaces.manage",
      "departments.manage",
      "operations_setup.manage",
      "revenue_setup.manage",
      "compliance_setup.manage",
      "ai_category_setup.use",
      "property.map.read",
      "property.map.manage",
      "property.import",
      "property.go_live",
      "modules.configure",
      "integrations.configure",
      "integrations.view_logs",
      "users.read",
      "users.invite",
      "users.disable",
      "roles.manage",
      "permissions.manage",
      "tax.configure",
      "compliance.configure",
      "billing.configure",
      "accounting.configure",
      "accounting.journal.post",
      "invoice.issue",
      "invoice.cancel",
      "payments.configure",
      "ai.configure",
      "templates.read",
      "templates.manage",
      "revenue.read",
      "revenue.forecast.read",
      "revenue.recommend",
      "revenue.manage_rates",
      "revenue.manage_restrictions",
      "revenue.apply_recommendations",
      "revenue.automation.manage",
      "revenue.configure",
      "revenue.history_forecast.read",
      "revenue.history_forecast.export",
      "revenue.history_forecast.configure",
      "revenue.history_forecast.saved_views.manage",
      "revenue.forecast_confidence.read",
      "revenue.comparison.read",
      "revenue.visual_alerts.read",
      "revenue.scheduled_reports.manage",
      "channel_manager.read",
      "channel_manager.manage",
      "channel_manager.sync",
      "channel_manager.mappings.manage",
      "channel_manager.parity.read",
      "crm.read",
      "crm.manage_profiles",
      "crm.manage_campaigns",
      "crm.manage_loyalty",
      "crm.export",
      "groups.read",
      "groups.manage",
      "groups.block_inventory",
      "groups.manage_billing",
      "events.read",
      "events.manage",
      "events.manage_spaces",
      "sales.pipeline.read",
      "sales.pipeline.manage",
      "workforce.read",
      "workforce.schedule.manage",
      "workforce.timeclock.use",
      "workforce.timeclock.manage",
      "workforce.labor_cost.view",
      "workforce.payroll_export",
      "payroll.manage",
      "banking.reconcile",
      "notifications.manage",
      "procurement.read",
      "procurement.manage",
      "purchase_orders.create",
      "purchase_orders.approve",
      "purchase_orders.receive",
      "inventory.read",
      "inventory.manage",
      "inventory.stock_count",
      "inventory.adjust",
      "guest_portal.configure",
      "guest_self_service.read",
      "guest_self_service.manage",
      "kiosk.configure",
      "digital_key.configure",
      "reputation.read",
      "reputation.respond",
      "surveys.read",
      "surveys.manage",
      "quality_cases.read",
      "quality_cases.manage",
      "energy.read",
      "energy.manage",
      "sustainability.read",
      "sustainability.report",
      "iot.manage",
      "incidents.read",
      "incidents.manage",
      "safety_checks.read",
      "safety_checks.manage",
      "insurance_cases.manage",
      "analytics.read",
      "analytics.configure",
      "analytics.export",
      "analytics.ai_ask",
      "metrics.manage",
      "developer.read",
      "developer.manage_apps",
      "developer.manage_webhooks",
      "developer.view_api_logs",
      "developer.manage_sandbox",
      "ai_governance.read",
      "ai_governance.configure",
      "ai_evals.manage",
      "ai_incidents.read",
      "ai_incidents.manage",
      "ai_prompts.manage",
      "ai_tool_registry.manage",
      "onboarding.read",
      "onboarding.create",
      "onboarding.upload",
      "onboarding.connect_source",
      "onboarding.ai_extract",
      "onboarding.ai_map",
      "onboarding.review",
      "onboarding.apply",
      "onboarding.rollback",
      "onboarding.go_live",
      "onboarding.view_sensitive",
      "onboarding.manage_cutover",
      "audit.read",
      "ai.tool.execute",
      "ai.high_risk.confirm"
    ]
  },
  roomTypes: [
    {
      id: "rt_double",
      propertyId: "prop_123",
      name: "Double",
      code: "DBL",
      maxOccupancy: 2,
      baseCapacity: 2,
      description: "Standard double room"
    }
  ],
  rooms: [
    {
      id: "room_432",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      buildingId: "bld_main",
      floorId: "floor_4",
      zoneId: "zone_f4_east",
      number: "432",
      floor: "4",
      roomCode: "RM432",
      displayName: "Room 432",
      maxOccupancy: 2,
      standardOccupancy: 2,
      bedConfigurationJson: { queen: 1 },
      featuresJson: { city_view: true, minibar: true },
      accessibilityJson: {},
      viewType: "city_view",
      squareMeters: 22,
      status: "inspected",
      housekeepingStatus: "inspected",
      maintenanceStatus: "ok",
      sellable: true,
      active: true,
      sortOrder: 432
    },
    {
      id: "room_108",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      buildingId: "bld_main",
      floorId: "floor_1",
      number: "108",
      floor: "1",
      roomCode: "RM108",
      displayName: "Room 108",
      maxOccupancy: 2,
      standardOccupancy: 2,
      bedConfigurationJson: { queen: 1 },
      featuresJson: {},
      accessibilityJson: {},
      status: "out_of_order",
      housekeepingStatus: "dirty",
      maintenanceStatus: "blocked",
      sellable: false,
      active: true,
      sortOrder: 108
    }
  ],
  guests: [
    {
      id: "guest_maria",
      organizationId: "org_123",
      firstName: "Maria",
      surname1: "Lopez",
      surname2: "Garcia",
      documentType: "DNI",
      documentNumber: "12345678X",
      nationality: "ES",
      dateOfBirth: "1986-04-18"
    }
  ],
  reservations: [
    {
      id: "res_18392",
      propertyId: "prop_123",
      code: "RES-18392",
      channel: "direct",
      status: "confirmed",
      arrivalDate: "2026-05-14",
      departureDate: "2026-05-16",
      adults: 1,
      children: 0,
      roomTypeId: "rt_double",
      assignedRoomId: "room_432",
      ratePlanId: "rp_flexible",
      marketSegment: "leisure",
      sourceCode: "direct_web",
      guaranteeType: "card_guarantee",
      cancellationPolicyCode: "flexible_18",
      billingInstruction: "guest_pays_checkout",
      bookerName: "Maria Lopez Garcia",
      bookerEmail: "maria@example.com",
      totalAmount: 272,
      currency: "EUR",
      primaryGuestId: "guest_maria"
    }
  ],
  folios: [
    {
      id: "folio_18392",
      reservationId: "res_18392",
      guestId: "guest_maria",
      status: "open",
      currency: "EUR"
    }
  ],
  folioLines: [
    {
      id: "fl_room_18392",
      folioId: "folio_18392",
      type: "room",
      description: "Room charge",
      quantity: 2,
      unitPrice: 136,
      taxCode: "ES_IVA_10",
      total: 272,
      postedAt: "2026-05-14T09:00:00.000Z",
      postedBy: "system"
    }
  ],
  payments: [
    {
      id: "pay_18392",
      propertyId: "prop_123",
      folioId: "folio_18392",
      amount: 272,
      currency: "EUR",
      method: "card",
      pspReference: "psp_demo_18392",
      status: "captured",
      createdAt: "2026-05-14T09:02:00.000Z"
    }
  ],
  ratePlans: [
    {
      id: "rp_flexible",
      propertyId: "prop_123",
      code: "BAR_FLEX",
      name: "Flexible BAR",
      ratePlanType: "bar",
      derivationJson: {},
      mealPlan: "room_only",
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "rp_nonref",
      propertyId: "prop_123",
      code: "BAR_NONREF",
      name: "Non-refundable",
      ratePlanType: "derived",
      parentRatePlanId: "rp_flexible",
      derivationJson: { type: "percent", value: -8 },
      mealPlan: "room_only",
      active: true,
      createdAt: "2026-05-14T08:05:00.000Z"
    }
  ],
  rateDays: [
    {
      id: "rateday_2026_06_12_dbl_flex",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      date: "2026-06-12",
      price: 138,
      currency: "EUR",
      minPrice: 112,
      maxPrice: 210,
      manuallyOverridden: false,
      syncStatus: "synced",
      updatedBy: "usr_123",
      updatedAt: "2026-05-14T09:10:00.000Z"
    },
    {
      id: "rateday_2026_06_13_dbl_flex",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      date: "2026-06-13",
      price: 154,
      currency: "EUR",
      minPrice: 112,
      maxPrice: 230,
      manuallyOverridden: false,
      syncStatus: "pending",
      updatedBy: "usr_123",
      updatedAt: "2026-05-14T09:12:00.000Z"
    }
  ],
  inventoryDays: [
    {
      id: "invday_2026_06_12_dbl",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      date: "2026-06-12",
      totalInventory: 52,
      availableCount: 6,
      outOfOrderCount: 2,
      overbookingLimit: 1,
      stopSell: false,
      updatedAt: "2026-05-14T09:12:00.000Z"
    },
    {
      id: "invday_2026_06_13_dbl",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      date: "2026-06-13",
      totalInventory: 52,
      availableCount: 3,
      outOfOrderCount: 2,
      overbookingLimit: 0,
      stopSell: false,
      updatedAt: "2026-05-14T09:12:00.000Z"
    }
  ],
  restrictionDays: [
    {
      id: "restr_2026_06_13_dbl_flex",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      date: "2026-06-13",
      minStay: 1,
      maxStay: 7,
      closedToArrival: false,
      closedToDeparture: false,
      stopSell: false,
      restrictionSource: "manual",
      updatedAt: "2026-05-14T09:12:00.000Z"
    }
  ],
  channels: [
    {
      id: "chan_direct",
      propertyId: "prop_123",
      providerCode: "direct_booking_engine",
      name: "Direct booking engine",
      channelType: "direct",
      status: "active",
      commissionPercent: 0,
      paymentCostPercent: 1.2,
      configurationJson: { pooledInventory: true, neverCloseDirect: true },
      lastSyncAt: "2026-05-14T09:18:00.000Z",
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "chan_booking",
      propertyId: "prop_123",
      providerCode: "booking_com_mock",
      name: "Booking.com mock",
      channelType: "ota",
      status: "active",
      commissionPercent: 15,
      paymentCostPercent: 1.8,
      configurationJson: { pooledInventory: true, reservationImport: true },
      credentialsSecretRef: "secret://demo/booking",
      lastSyncAt: "2026-05-14T09:05:00.000Z",
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "chan_expedia",
      propertyId: "prop_123",
      providerCode: "expedia_mock",
      name: "Expedia mock",
      channelType: "ota",
      status: "error",
      commissionPercent: 18,
      paymentCostPercent: 2.1,
      configurationJson: { pooledInventory: true },
      credentialsSecretRef: "secret://demo/expedia",
      lastSyncAt: "2026-05-14T08:42:00.000Z",
      createdAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  channelRoomMappings: [
    {
      id: "crm_booking_double",
      channelId: "chan_booking",
      roomTypeId: "rt_double",
      externalRoomCode: "EXT_DBL_STD",
      externalRoomName: "Double Standard",
      status: "active"
    },
    {
      id: "crm_expedia_double",
      channelId: "chan_expedia",
      roomTypeId: "rt_double",
      externalRoomCode: "EXP_DBL_STD",
      externalRoomName: "Double Room",
      status: "active"
    }
  ],
  channelRateMappings: [
    {
      id: "cratemap_booking_flex",
      channelId: "chan_booking",
      ratePlanId: "rp_flexible",
      externalRateCode: "EXT_BAR_FLEX",
      externalRateName: "Flexible",
      status: "active"
    },
    {
      id: "cratemap_expedia_flex",
      channelId: "chan_expedia",
      ratePlanId: "rp_flexible",
      externalRateCode: "EXP_BAR_FLEX",
      externalRateName: "Flexible",
      status: "active"
    }
  ],
  channelSyncJobs: [
    {
      id: "sync_booking_rates_1",
      propertyId: "prop_123",
      channelId: "chan_booking",
      syncType: "rates",
      status: "succeeded",
      dateRangeStart: "2026-06-12",
      dateRangeEnd: "2026-06-14",
      requestPayloadJson: { rateDays: 2, idempotencyKey: "prop_123:chan_booking:rates:2026-06-12:2026-06-14" },
      responsePayloadJson: { accepted: true },
      idempotencyKey: "prop_123:chan_booking:rates:2026-06-12:2026-06-14",
      startedAt: "2026-05-14T09:04:00.000Z",
      finishedAt: "2026-05-14T09:05:00.000Z",
      createdAt: "2026-05-14T09:04:00.000Z"
    },
    {
      id: "sync_expedia_restrictions_1",
      propertyId: "prop_123",
      channelId: "chan_expedia",
      syncType: "restrictions",
      status: "failed",
      dateRangeStart: "2026-06-12",
      dateRangeEnd: "2026-06-14",
      requestPayloadJson: { minStay: 2 },
      responsePayloadJson: {},
      errorMessage: "Credential expired before restrictions push.",
      idempotencyKey: "prop_123:chan_expedia:restrictions:2026-06-12:2026-06-14",
      startedAt: "2026-05-14T08:41:00.000Z",
      finishedAt: "2026-05-14T08:42:00.000Z",
      createdAt: "2026-05-14T08:41:00.000Z"
    }
  ],
  revenueForecasts: [
    {
      id: "revf_2026_05_15_dbl",
      propertyId: "prop_123",
      forecastDate: "2026-05-15",
      roomTypeId: "rt_double",
      segment: "transient",
      channel: "direct",
      expectedOccupancy: 87,
      expectedRoomRevenue: 11832,
      expectedTotalRevenue: 13690,
      expectedProfit: 6420,
      confidence: 0.82,
      modelVersion: "demo-revenue-v1",
      createdAt: "2026-05-14T09:15:00.000Z"
    },
    {
      id: "revf_2026_05_16_dbl",
      propertyId: "prop_123",
      forecastDate: "2026-05-16",
      roomTypeId: "rt_double",
      segment: "weekend",
      channel: "ota",
      expectedOccupancy: 91,
      expectedRoomRevenue: 13420,
      expectedTotalRevenue: 15980,
      expectedProfit: 7015,
      confidence: 0.78,
      modelVersion: "demo-revenue-v1",
      createdAt: "2026-05-14T09:15:00.000Z"
    }
  ],
  revenueRecommendations: [
    {
      id: "revrate_weekend_8",
      propertyId: "prop_123",
      recommendationType: "rate",
      targetDate: "2026-05-16",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      currentValueJson: { price: 136, currency: "EUR" },
      recommendedValueJson: { price: 147, currency: "EUR", changePercent: 8 },
      reason: "Weekend pickup is above pace and demand calendar impact is medium-high.",
      confidence: 0.84,
      status: "pending",
      createdAt: "2026-05-14T09:20:00.000Z"
    },
    {
      id: "revminstay_event",
      propertyId: "prop_123",
      recommendationType: "min_stay",
      targetDate: "2026-05-22",
      roomTypeId: "rt_double",
      currentValueJson: { minStay: 1 },
      recommendedValueJson: { minStay: 2 },
      reason: "City event compression suggests a two-night minimum for the double room type.",
      confidence: 0.76,
      status: "pending",
      createdAt: "2026-05-14T09:22:00.000Z"
    }
  ],
  demandCalendarEvents: [
    {
      id: "demand_madrid_congress",
      propertyId: "prop_123",
      name: "Madrid design congress",
      eventType: "city_event",
      startDate: "2026-05-22",
      endDate: "2026-05-24",
      expectedImpact: "high",
      source: "manual",
      metadataJson: { expectedCompression: "rooms" },
      createdAt: "2026-05-14T09:00:00.000Z"
    }
  ],
  channelProfitabilitySnapshots: [
    {
      id: "chprof_direct_2026_05_14",
      propertyId: "prop_123",
      date: "2026-05-14",
      channel: "direct",
      grossRevenue: 6420,
      commissionCost: 0,
      paymentCost: 112,
      operatingCost: 2140,
      netRevenue: 6308,
      profit: 4168,
      createdAt: "2026-05-14T09:25:00.000Z"
    },
    {
      id: "chprof_ota_2026_05_14",
      propertyId: "prop_123",
      date: "2026-05-14",
      channel: "ota",
      grossRevenue: 4200,
      commissionCost: 630,
      paymentCost: 78,
      operatingCost: 1540,
      netRevenue: 3492,
      profit: 1952,
      createdAt: "2026-05-14T09:25:00.000Z"
    }
  ],
  revenueDailySnapshots: [
    {
      id: "rhf_hist_2026_05_01",
      propertyId: "prop_123",
      snapshotDate: "2026-05-01",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      channelId: "chan_direct",
      segment: "transient",
      market: "leisure",
      totalOcc: 38,
      availableRooms: 50,
      arrivalRooms: 12,
      departureRooms: 10,
      compRooms: 1,
      houseUseRooms: 1,
      dayUseRooms: 0,
      noShowRooms: 1,
      oooRooms: 2,
      deductIndividualRooms: 31,
      nonDeductIndividualRooms: 2,
      deductGroupRooms: 4,
      nonDeductGroupRooms: 1,
      adultsChildren: 72,
      roomRevenue: 5168,
      totalRevenue: 6280,
      netRoomRevenue: 5080,
      grossOperatingProfit: 2940,
      adr: 136,
      revpar: 103.36,
      trevpar: 125.6,
      goppar: 58.8,
      occupancyPercent: 76,
      dataSource: "night_audit",
      createdAt: "2026-05-02T04:00:00.000Z",
      updatedAt: "2026-05-02T04:00:00.000Z"
    },
    {
      id: "rhf_hist_2026_05_14",
      propertyId: "prop_123",
      snapshotDate: "2026-05-14",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      channelId: "chan_booking",
      segment: "transient",
      market: "urban",
      totalOcc: 43,
      availableRooms: 50,
      arrivalRooms: 16,
      departureRooms: 13,
      compRooms: 0,
      houseUseRooms: 1,
      dayUseRooms: 1,
      noShowRooms: 0,
      oooRooms: 2,
      deductIndividualRooms: 35,
      nonDeductIndividualRooms: 3,
      deductGroupRooms: 4,
      nonDeductGroupRooms: 1,
      adultsChildren: 81,
      roomRevenue: 6063,
      totalRevenue: 7350,
      netRoomRevenue: 5520,
      grossOperatingProfit: 3380,
      adr: 141,
      revpar: 121.26,
      trevpar: 147,
      goppar: 67.6,
      occupancyPercent: 86,
      dataSource: "night_audit",
      createdAt: "2026-05-15T04:00:00.000Z",
      updatedAt: "2026-05-15T04:00:00.000Z"
    },
    {
      id: "rhf_hist_2026_05_15",
      propertyId: "prop_123",
      snapshotDate: "2026-05-15",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      channelId: "chan_direct",
      segment: "transient",
      market: "urban",
      totalOcc: 44,
      availableRooms: 50,
      arrivalRooms: 18,
      departureRooms: 14,
      compRooms: 0,
      houseUseRooms: 1,
      dayUseRooms: 1,
      noShowRooms: 1,
      oooRooms: 2,
      deductIndividualRooms: 36,
      nonDeductIndividualRooms: 2,
      deductGroupRooms: 5,
      nonDeductGroupRooms: 1,
      adultsChildren: 84,
      roomRevenue: 6292,
      totalRevenue: 7590,
      netRoomRevenue: 6170,
      grossOperatingProfit: 3580,
      adr: 143,
      revpar: 125.84,
      trevpar: 151.8,
      goppar: 71.6,
      occupancyPercent: 88,
      dataSource: "night_audit",
      createdAt: "2026-05-16T04:00:00.000Z",
      updatedAt: "2026-05-16T04:00:00.000Z"
    }
  ],
  revenueForecastSnapshots: [
    {
      id: "rhf_fore_2026_05_16",
      propertyId: "prop_123",
      forecastDate: "2026-05-16",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      channelId: "chan_booking",
      segment: "weekend",
      market: "urban",
      expectedTotalOcc: 46,
      availableRooms: 50,
      expectedArrivalRooms: 20,
      expectedDepartureRooms: 11,
      expectedCompRooms: 0,
      expectedHouseUseRooms: 1,
      expectedDayUseRooms: 1,
      expectedNoShowRooms: 1,
      expectedOooRooms: 2,
      expectedDeductIndividualRooms: 36,
      expectedNonDeductIndividualRooms: 3,
      expectedDeductGroupRooms: 6,
      expectedNonDeductGroupRooms: 1,
      expectedAdultsChildren: 89,
      expectedRoomRevenue: 6716,
      expectedTotalRevenue: 8120,
      expectedNetRoomRevenue: 5980,
      expectedGrossOperatingProfit: 3710,
      expectedAdr: 146,
      expectedRevpar: 134.32,
      expectedTrevpar: 162.4,
      expectedGoppar: 74.2,
      expectedOccupancyPercent: 92,
      confidence: 0.78,
      confidenceLowJson: { totalRevenue: 7600, occPercent: 86 },
      confidenceHighJson: { totalRevenue: 8580, occPercent: 95 },
      driversJson: ["Weekend pickup above normal", "Competitors 8% higher", "Low remaining availability"],
      dataQualityScore: 0.82,
      modelVersion: "demo-rhf-v1",
      createdAt: "2026-05-15T05:30:00.000Z",
      updatedAt: "2026-05-15T05:30:00.000Z"
    },
    {
      id: "rhf_fore_2026_05_29",
      propertyId: "prop_123",
      forecastDate: "2026-05-29",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      channelId: "chan_direct",
      segment: "transient",
      market: "urban",
      expectedTotalOcc: 18,
      availableRooms: 50,
      expectedArrivalRooms: 6,
      expectedDepartureRooms: 8,
      expectedCompRooms: 0,
      expectedHouseUseRooms: 1,
      expectedDayUseRooms: 0,
      expectedNoShowRooms: 1,
      expectedOooRooms: 5,
      expectedDeductIndividualRooms: 15,
      expectedNonDeductIndividualRooms: 1,
      expectedDeductGroupRooms: 2,
      expectedNonDeductGroupRooms: 0,
      expectedAdultsChildren: 34,
      expectedRoomRevenue: 2160,
      expectedTotalRevenue: 2660,
      expectedNetRoomRevenue: 2050,
      expectedGrossOperatingProfit: 880,
      expectedAdr: 120,
      expectedRevpar: 43.2,
      expectedTrevpar: 53.2,
      expectedGoppar: 17.6,
      expectedOccupancyPercent: 36,
      confidence: 0.71,
      confidenceLowJson: { totalRevenue: 1980, occPercent: 29 },
      confidenceHighJson: { totalRevenue: 3180, occPercent: 45 },
      driversJson: ["Slow pickup", "Five OOO rooms", "OTA sync issue limits demand"],
      dataQualityScore: 0.69,
      modelVersion: "demo-rhf-v1",
      createdAt: "2026-05-15T05:30:00.000Z",
      updatedAt: "2026-05-15T05:30:00.000Z"
    },
    {
      id: "rhf_fore_2026_05_31",
      propertyId: "prop_123",
      forecastDate: "2026-05-31",
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      channelId: "chan_booking",
      segment: "transient",
      market: "leisure",
      expectedTotalOcc: 31,
      availableRooms: 50,
      expectedArrivalRooms: 10,
      expectedDepartureRooms: 13,
      expectedCompRooms: 0,
      expectedHouseUseRooms: 1,
      expectedDayUseRooms: 0,
      expectedNoShowRooms: 1,
      expectedOooRooms: 2,
      expectedDeductIndividualRooms: 26,
      expectedNonDeductIndividualRooms: 2,
      expectedDeductGroupRooms: 3,
      expectedNonDeductGroupRooms: 0,
      expectedAdultsChildren: 59,
      expectedRoomRevenue: 3937,
      expectedTotalRevenue: 4680,
      expectedNetRoomRevenue: 3480,
      expectedGrossOperatingProfit: 1810,
      expectedAdr: 127,
      expectedRevpar: 78.74,
      expectedTrevpar: 93.6,
      expectedGoppar: 36.2,
      expectedOccupancyPercent: 62,
      confidence: 0.8,
      confidenceLowJson: { totalRevenue: 4210, occPercent: 55 },
      confidenceHighJson: { totalRevenue: 5120, occPercent: 68 },
      driversJson: ["Normal Sunday demand", "Direct pickup stable", "No major events detected"],
      dataQualityScore: 0.84,
      modelVersion: "demo-rhf-v1",
      createdAt: "2026-05-15T05:30:00.000Z",
      updatedAt: "2026-05-15T05:30:00.000Z"
    }
  ],
  revenueReportViews: [
    {
      id: "rhf_view_may_owner",
      propertyId: "prop_123",
      userId: "usr_123",
      name: "May owner forecast",
      reportType: "history_forecast",
      filtersJson: {
        fromDate: "2026-05-01",
        toDate: "2026-05-31",
        granularity: "daily",
        comparisonPeriod: "same_period_last_year",
        revenueMode: "net"
      },
      layoutJson: { charts: ["overview", "occupancy", "revenue", "channels", "confidence"], table: "classic_history_forecast" },
      isShared: true,
      createdAt: "2026-05-15T06:00:00.000Z"
    }
  ],
  competitorHotels: [
    {
      id: "comp_gran_via",
      propertyId: "prop_123",
      name: "Gran Via Boutique",
      locationJson: { distanceKm: 0.4, market: "Madrid Centro" },
      category: "urban boutique",
      starRating: 4,
      comparableScore: 0.88,
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "comp_centro_plaza",
      propertyId: "prop_123",
      name: "Centro Plaza Hotel",
      locationJson: { distanceKm: 0.7, market: "Madrid Centro" },
      category: "urban",
      starRating: 4,
      comparableScore: 0.81,
      active: true,
      createdAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  competitorRateSnapshots: [
    {
      id: "comp_rate_gran_via_2026_06_12",
      propertyId: "prop_123",
      competitorHotelId: "comp_gran_via",
      sourceChannel: "booking_com_mock",
      shopDate: "2026-05-14",
      stayDate: "2026-06-12",
      roomTypeLabel: "Double Standard",
      ratePlanLabel: "Flexible",
      price: 161,
      currency: "EUR",
      availabilityStatus: "available",
      cancellationPolicyLabel: "free_cancellation",
      metadataJson: { marketMedian: 161, position: "slightly_below_market" },
      createdAt: "2026-05-14T09:28:00.000Z"
    },
    {
      id: "comp_rate_centro_2026_06_12",
      propertyId: "prop_123",
      competitorHotelId: "comp_centro_plaza",
      sourceChannel: "expedia_mock",
      shopDate: "2026-05-14",
      stayDate: "2026-06-12",
      roomTypeLabel: "Double Standard",
      ratePlanLabel: "Flexible",
      price: 139,
      currency: "EUR",
      availabilityStatus: "available",
      cancellationPolicyLabel: "non_refundable",
      metadataJson: { lowestCompetitor: true },
      createdAt: "2026-05-14T09:28:00.000Z"
    }
  ],
  rateParityAlerts: [
    {
      id: "parity_booking_2026_06_12",
      propertyId: "prop_123",
      alertType: "ota_cheaper_than_direct",
      severity: "critical",
      stayDate: "2026-06-12",
      sourceChannel: "booking_com_mock",
      directRate: 154,
      channelRate: 140,
      currency: "EUR",
      message: "Booking.com cheaper than direct website by EUR 14 on 2026-06-12.",
      suggestedAction: "Check channel mapping and direct rate plan before next ARI sync.",
      status: "open",
      metadataJson: { ratePlanId: "rp_flexible", roomTypeId: "rt_double" },
      createdAt: "2026-05-14T09:30:00.000Z"
    }
  ],
  revenueAutomationRules: [
    {
      id: "rev_auto_low_risk",
      propertyId: "prop_123",
      name: "Auto-apply low-risk weekday changes",
      automationLevel: "auto_apply_low_risk",
      scopeJson: { roomTypeIds: ["rt_double"], ratePlanIds: ["rp_flexible"], weekdays: [1, 2, 3, 4] },
      constraintsJson: {
        minPrice: 112,
        maxPrice: 210,
        maxDailyChangePercent: 6,
        minimumConfidence: 0.82,
        neverCloseDirect: true,
        blockIfChannelSyncUnhealthy: true
      },
      active: true,
      createdBy: "usr_123",
      createdAt: "2026-05-14T09:35:00.000Z"
    }
  ],
  revenueScenarios: [
    {
      id: "scenario_raise_sat_8",
      propertyId: "prop_123",
      name: "Raise Saturday double rooms by 8%",
      scenarioType: "rate_change",
      inputJson: { date: "2026-06-13", roomTypeId: "rt_double", changePercent: 8 },
      outputJson: {
        expectedOccupancyChange: -0.02,
        expectedAdrChange: 12.3,
        expectedRevparChange: 8.8,
        expectedProfitChange: 710,
        channelMixChange: "direct share +2pp",
        riskLevel: "medium",
        confidence: 0.79
      },
      createdBy: "usr_123",
      createdAt: "2026-05-14T09:36:00.000Z"
    }
  ],
  externalReservations: [
    {
      id: "extres_booking_18392",
      propertyId: "prop_123",
      channelId: "chan_booking",
      externalReservationId: "booking_com_mock_demo_18392",
      status: "imported",
      guestName: "Maria Lopez Garcia",
      arrivalDate: "2026-06-12",
      departureDate: "2026-06-14",
      payloadJson: { roomTypeCode: "EXT_DBL_STD", ratePlanCode: "EXT_BAR_FLEX", grossAmount: 308, currency: "EUR" },
      importedAt: "2026-05-14T09:38:00.000Z"
    }
  ],
  guestProfiles: [
    {
      id: "gprof_maria",
      organizationId: "org_123",
      primaryGuestId: "guest_maria",
      displayName: "Maria Lopez Garcia",
      email: "maria@example.com",
      preferredLanguage: "es",
      vipLevel: "returning",
      lifetimeValue: 1840,
      totalStays: 5,
      totalNights: 12,
      totalSpend: 1840,
      preferencesJson: { roomPreference: "quiet upper floor", amenities: ["parking", "extra pillows"] },
      consentJson: { marketingEmail: true, transactionalWhatsApp: true },
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-14T09:30:00.000Z"
    },
    {
      id: "gprof_maria_duplicate",
      organizationId: "org_123",
      primaryGuestId: "guest_maria",
      displayName: "M. Lopez Garcia",
      email: "maria@example.com",
      preferredLanguage: "es",
      lifetimeValue: 272,
      totalStays: 1,
      totalNights: 2,
      totalSpend: 272,
      preferencesJson: {},
      consentJson: { marketingEmail: true },
      createdAt: "2026-05-14T08:45:00.000Z",
      updatedAt: "2026-05-14T08:45:00.000Z"
    }
  ],
  guestProfileLinks: [
    {
      id: "gplink_maria_guest",
      guestProfileId: "gprof_maria",
      guestId: "guest_maria",
      linkConfidence: 0.99,
      linkReason: "Primary PMS guest record.",
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "gplink_maria_duplicate",
      guestProfileId: "gprof_maria_duplicate",
      guestId: "guest_maria",
      linkConfidence: 0.91,
      linkReason: "Same email and matching surnames. Human confirmation required before merge.",
      createdAt: "2026-05-14T08:45:00.000Z"
    }
  ],
  crmSegments: [
    {
      id: "seg_returning_direct",
      organizationId: "org_123",
      name: "Returning direct guests",
      description: "Guests with previous direct stays and marketing consent.",
      rulesJson: { minStays: 2, channel: "direct", consent: "marketingEmail" },
      active: true,
      createdAt: "2026-05-14T09:10:00.000Z"
    }
  ],
  crmCampaigns: [
    {
      id: "camp_weekend_recovery",
      organizationId: "org_123",
      name: "Weekend direct booking recovery",
      campaignType: "email",
      segmentId: "seg_returning_direct",
      channel: "email",
      status: "draft",
      scheduleJson: { sendAfterCheckoutDays: 3 },
      contentJson: { subject: "Your next Madrid stay", consentRequired: true },
      createdAt: "2026-05-14T09:12:00.000Z"
    }
  ],
  loyaltyPrograms: [
    {
      id: "loyalty_demo",
      organizationId: "org_123",
      name: "HotelOS Direct Club",
      configurationJson: { pointsPerEuro: 1, tiers: ["member", "silver", "gold"] },
      active: true,
      createdAt: "2026-05-14T09:00:00.000Z"
    }
  ],
  loyaltyMemberships: [
    {
      id: "loym_maria",
      loyaltyProgramId: "loyalty_demo",
      guestProfileId: "gprof_maria",
      tier: "silver",
      pointsBalance: 1840,
      status: "active",
      joinedAt: "2026-02-01T09:00:00.000Z"
    }
  ],
  salesAccounts: [
    {
      id: "acct_design_co",
      organizationId: "org_123",
      accountType: "company",
      name: "Design Co Spain",
      taxId: "B87654321",
      contactJson: { contactName: "Laura Martin", email: "events@designco.example" },
      billingJson: { paymentTerms: "30_days" },
      status: "active",
      createdAt: "2026-05-14T09:00:00.000Z"
    }
  ],
  salesOpportunities: [
    {
      id: "opp_design_summit",
      propertyId: "prop_123",
      accountId: "acct_design_co",
      name: "Design Co leadership summit",
      opportunityType: "group",
      stage: "proposal",
      estimatedValue: 9600,
      expectedCloseDate: "2026-05-20",
      ownerUserId: "usr_123",
      createdAt: "2026-05-14T09:05:00.000Z"
    }
  ],
  groupBookings: [
    {
      id: "grp_design_summit",
      propertyId: "prop_123",
      accountId: "acct_design_co",
      opportunityId: "opp_design_summit",
      name: "Design Co summit",
      status: "tentative",
      arrivalDate: "2026-06-10",
      departureDate: "2026-06-13",
      releaseDate: "2026-05-25",
      masterFolioId: "folio_18392",
      billingRulesJson: { masterPaysRoomAndBreakfast: true, individualsPayExtras: true },
      createdAt: "2026-05-14T09:08:00.000Z"
    }
  ],
  groupRoomBlocks: [
    {
      id: "grb_design_2026_06_10",
      groupBookingId: "grp_design_summit",
      roomTypeId: "rt_double",
      date: "2026-06-10",
      blockedCount: 12,
      pickedUpCount: 4,
      rate: 128,
      createdAt: "2026-05-14T09:09:00.000Z"
    },
    {
      id: "grb_design_2026_06_11",
      groupBookingId: "grp_design_summit",
      roomTypeId: "rt_double",
      date: "2026-06-11",
      blockedCount: 12,
      pickedUpCount: 4,
      rate: 128,
      createdAt: "2026-05-14T09:09:00.000Z"
    }
  ],
  eventSpaces: [
    {
      id: "evspace_lobby_meeting",
      propertyId: "prop_123",
      name: "Lobby meeting room",
      spaceId: "space_reception",
      capacityJson: { theater: 35, boardroom: 18 },
      active: true,
      createdAt: "2026-05-14T09:00:00.000Z"
    }
  ],
  hotelEvents: [
    {
      id: "evt_design_welcome",
      propertyId: "prop_123",
      groupBookingId: "grp_design_summit",
      eventSpaceId: "evspace_lobby_meeting",
      name: "Design Co welcome reception",
      eventType: "welcome_reception",
      startAt: "2026-06-10T18:00:00.000Z",
      endAt: "2026-06-10T20:00:00.000Z",
      status: "draft",
      setupJson: { layout: "cocktail", av: true },
      cateringJson: { coffeeBreak: false, welcomeDrinks: true },
      createdAt: "2026-05-14T09:12:00.000Z"
    }
  ],
  eventOrders: [
    {
      id: "beo_design_welcome",
      eventId: "evt_design_welcome",
      orderType: "beo",
      contentJson: { sections: ["timeline", "setup", "catering", "billing"], requiresConfirmation: true },
      status: "draft",
      createdAt: "2026-05-14T09:13:00.000Z"
    }
  ],
  housekeepingTasks: [
    {
      id: "hkt_arrival_432",
      propertyId: "prop_123",
      roomId: "room_432",
      taskType: "inspection",
      priority: "normal",
      status: "done",
      assignedTo: "usr_housekeeping_demo",
      dueAt: "2026-05-14T12:00:00.000Z",
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "hkt_blocked_108",
      propertyId: "prop_123",
      roomId: "room_108",
      taskType: "deep_clean",
      priority: "high",
      status: "pending",
      dueAt: "2026-05-14T16:00:00.000Z",
      createdAt: "2026-05-14T08:15:00.000Z"
    }
  ],
  housekeepingEvents: [
    {
      id: "hke_arrival_432_done",
      taskId: "hkt_arrival_432",
      eventType: "done",
      note: "Supervisor inspection completed.",
      createdBy: "usr_housekeeping_demo",
      createdAt: "2026-05-14T10:10:00.000Z"
    }
  ],
  advancedRecords: [],
  workOrders: [
    {
      id: "wo_108_leak",
      propertyId: "prop_123",
      roomId: "room_108",
      title: "Bathroom leak",
      description: "Guest reported water under sink.",
      priority: "urgent",
      status: "open",
      blocksRoom: true,
      createdBy: "usr_123",
      createdAt: "2026-05-14T08:30:00.000Z"
    }
  ],
  workOrderMedia: [],
  assets: [
    {
      id: "asset_hvac_432",
      propertyId: "prop_123",
      buildingId: "bld_main",
      floorId: "floor_4",
      zoneId: "zone_f4_east",
      roomId: "room_432",
      assetType: "hvac",
      assetCode: "HVAC-432",
      name: "Room 432 HVAC",
      serialNumber: "HVAC-432-2022",
      manufacturer: "Demo Climate",
      model: "DC-22",
      installationDate: "2022-06-30",
      warrantyUntil: "2027-06-30",
      purchaseCost: 2400,
      usefulLifeMonths: 96,
      qrCodeValue: "hotelos://prop_123/assets/asset_hvac_432",
      status: "needs_attention"
    },
    {
      id: "asset_bed_432",
      propertyId: "prop_123",
      buildingId: "bld_main",
      floorId: "floor_4",
      zoneId: "zone_f4_east",
      roomId: "room_432",
      assetType: "bed",
      assetCode: "BED-432",
      name: "Room 432 double bed",
      warrantyUntil: "2028-01-15",
      qrCodeValue: "hotelos://prop_123/assets/asset_bed_432",
      status: "active"
    }
  ],
  capexProjects: [
    {
      id: "capex_renovation_432",
      propertyId: "prop_123",
      name: "Fourth floor refresh",
      description: "Soft renovation of rooms on the fourth floor.",
      budget: 18000,
      status: "proposed",
      startDate: "2026-06-01",
      targetEndDate: "2026-06-20"
    }
  ],
  capexItems: [
    {
      id: "capex_item_hvac_432",
      capexProjectId: "capex_renovation_432",
      roomId: "room_432",
      assetId: "asset_hvac_432",
      description: "Replace or overhaul HVAC unit in room 432",
      estimatedCost: 1200,
      actualCost: 0,
      status: "proposed"
    }
  ],
  fixedAssets: [
    {
      id: "fa_hvac_432",
      propertyId: "prop_123",
      assetId: "asset_hvac_432",
      name: "Room 432 HVAC",
      acquisitionDate: "2022-06-30",
      acquisitionCost: 2400,
      depreciationMethod: "linear",
      usefulLifeMonths: 96,
      accumulatedDepreciation: 1175
    }
  ],
  conversations: [
    {
      id: "conv_maria",
      propertyId: "prop_123",
      guestId: "guest_maria",
      reservationId: "res_18392",
      channel: "app",
      status: "open",
      aiEnabled: true,
      createdAt: "2026-05-14T09:30:00.000Z"
    }
  ],
  messages: [
    {
      id: "msg_maria_parking",
      conversationId: "conv_maria",
      senderType: "guest",
      body: "Do you have parking?",
      language: "en",
      sentAt: "2026-05-14T09:31:00.000Z",
      attachments: []
    }
  ],
  serviceRequests: [],
  guestRegisterRecords: [
    {
      id: "grr_maria_432",
      propertyId: "prop_123",
      reservationId: "res_18392",
      guestId: "guest_maria",
      recordType: "checkin",
      status: "ready_to_submit",
      isPrimaryGuest: true,
      isMinor: false,
      firstName: "Maria",
      surname1: "Lopez",
      surname2: "Garcia",
      sex: "F",
      nationality: "ES",
      dateOfBirth: "1989-04-18",
      documentType: "DNI",
      documentNumber: "12345678Z",
      documentSupportNumber: "ABC123456",
      residenceFullAddress: "Calle Mayor 8",
      residenceLocality: "Madrid",
      residenceCountry: "ES",
      phoneMobile: "+34600111222",
      email: "maria@example.com",
      travellerCount: 1,
      contractReference: "RES-18392",
      contractDate: "2026-05-15",
      checkinAt: "2026-05-16T16:35:00.000Z",
      checkoutAt: "2026-05-18T10:00:00.000Z",
      propertyFullAddress: "Calle Demo 12, Madrid",
      contractedRoomCount: 1,
      internetConnection: true,
      paymentType: "card",
      paymentMethodIdentifier: "psp_tok_visa_4242",
      paymentHolder: "Maria Lopez Garcia",
      paymentDate: "2026-05-15",
      paymentReference: "pay_demo_18392",
      requiredPayloadJson: {
        firstName: "Maria",
        surname1: "Lopez",
        surname2: "Garcia",
        documentType: "DNI",
        documentNumber: "12345678Z",
        documentSupportNumber: "ABC123456",
        nationality: "ES",
        dateOfBirth: "1989-04-18",
        residenceFullAddress: "Calle Mayor 8",
        residenceLocality: "Madrid",
        residenceCountry: "ES",
        phoneMobile: "+34600111222",
        contractReference: "RES-18392",
        checkinAt: "2026-05-16T16:35:00.000Z"
      },
      validationErrorsJson: [],
      signatureRequired: true,
      signatureObjectKey: "signatures/grr_maria_432.svg",
      signedAt: "2026-05-16T16:37:00.000Z",
      identityVerified: true,
      identityVerifiedBy: "usr_123",
      identityVerifiedAt: "2026-05-16T16:34:00.000Z",
      identityVerificationMethod: "visual_document_check",
      idImageStored: false,
      idImageDiscarded: true,
      idImageDiscardedAt: "2026-05-16T16:34:10.000Z",
      retentionUntil: "2029-05-18T10:00:00.000Z",
      createdBy: "usr_123",
      updatedBy: "usr_123",
      createdAt: "2026-05-16T16:33:00.000Z",
      updatedAt: "2026-05-16T16:37:00.000Z"
    },
    {
      id: "grr_minor_demo",
      propertyId: "prop_123",
      reservationId: "res_18392",
      guestId: "guest_child_demo",
      recordType: "checkin",
      status: "missing_data",
      isMinor: true,
      providedByAdultGuestId: "guest_maria",
      firstName: "Lucas",
      surname1: "Lopez",
      nationality: "ES",
      dateOfBirth: "2016-03-01",
      documentType: "DNI",
      documentNumber: "98765432A",
      travellerCount: 1,
      kinshipRelationIfMinor: "child",
      contractReference: "RES-18392",
      requiredPayloadJson: { firstName: "Lucas", providedByAdultGuestId: "guest_maria", kinshipRelationIfMinor: "child" },
      validationErrorsJson: [{ code: "missing_residenceFullAddress", severity: "blocking" }],
      signatureRequired: false,
      idImageStored: false,
      idImageDiscarded: true,
      idImageDiscardedAt: "2026-05-16T16:35:10.000Z",
      retentionUntil: "2029-05-18T10:00:00.000Z",
      createdBy: "usr_123",
      createdAt: "2026-05-16T16:35:00.000Z",
      updatedAt: "2026-05-16T16:35:00.000Z"
    }
  ],
  sesSubmissions: [
    {
      id: "ses_maria_queued",
      propertyId: "prop_123",
      guestRegisterRecordId: "grr_maria_432",
      submissionType: "checkin",
      status: "queued",
      requestPayloadJson: { recordId: "grr_maria_432", authorityType: "ses_hospedajes" }
    }
  ],
  authorityReportingSettings: [
    {
      id: "ars_prop_123",
      propertyId: "prop_123",
      country: "ES",
      regionCode: "MD",
      authorityType: "ses_hospedajes",
      enabled: true,
      professionalActivity: true,
      establishmentCode: "EST-DEMO-001",
      landlordCode: "ARR-DEMO-001",
      webServiceEnabled: false,
      webServiceUsername: "hotelos_demo",
      webServiceSecretRef: "secret://ses-hospedajes/prop_123",
      batchExportEnabled: true,
      automaticSubmissionEnabled: false,
      configurationJson: {
        defaultBatchTime: "06:00",
        alertBeforeDeadlineHours: 4,
        retentionYears: 3,
        storeIdImageDefault: false,
        officialSchemaConfigured: false
      },
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-16T08:00:00.000Z"
    }
  ],
  lodgingLegalProfiles: [
    {
      id: "llp_prop_123",
      propertyId: "prop_123",
      legalName: "HotelOS Madrid Centro SL",
      taxId: "B12345678",
      municipality: "Madrid",
      province: "Madrid",
      phone: "+34910000000",
      email: "compliance@hotelos.example",
      website: "https://hotelos.example",
      establishmentType: "hotel",
      establishmentName: "HotelOS Madrid Centro",
      fullAddress: "Calle Demo 12, Madrid",
      postalCode: "28013",
      locality: "Madrid",
      establishmentProvince: "Madrid",
      roomCount: 120,
      internetConnection: true,
      createdAt: "2026-05-14T08:00:00.000Z",
      updatedAt: "2026-05-16T08:00:00.000Z"
    }
  ],
  authoritySubmissionBatches: [
    {
      id: "asb_daily_20260516",
      propertyId: "prop_123",
      authorityType: "ses_hospedajes",
      batchType: "daily_batch",
      status: "generated",
      periodFrom: "2026-05-16T00:00:00.000Z",
      periodTo: "2026-05-16T23:59:59.000Z",
      fileFormat: "json",
      fileObjectKey: "authority-batches/asb_daily_20260516.json",
      recordCount: 1,
      idempotencyKey: "prop_123-2026-05-16-daily",
      generatedBy: "usr_123",
      generatedAt: "2026-05-16T06:00:00.000Z",
      responsePayloadJson: {},
      createdAt: "2026-05-16T06:00:00.000Z",
      updatedAt: "2026-05-16T06:00:00.000Z"
    }
  ],
  authoritySubmissionBatchRecords: [
    {
      id: "asbr_maria_432",
      batchId: "asb_daily_20260516",
      guestRegisterRecordId: "grr_maria_432",
      status: "included",
      responsePayloadJson: {}
    }
  ],
  authoritySubmissions: [
    {
      id: "authsub_maria_432",
      propertyId: "prop_123",
      guestRegisterRecordId: "grr_maria_432",
      batchId: "asb_daily_20260516",
      authorityType: "ses_hospedajes",
      submissionType: "checkin",
      status: "queued",
      requestPayloadJson: { recordId: "grr_maria_432", authorityType: "ses_hospedajes" },
      responsePayloadJson: {},
      createdAt: "2026-05-16T16:38:00.000Z",
      updatedAt: "2026-05-16T16:38:00.000Z"
    },
    {
      id: "authsub_rejected_support",
      propertyId: "prop_123",
      guestRegisterRecordId: "grr_minor_demo",
      authorityType: "ses_hospedajes",
      submissionType: "checkin",
      status: "rejected",
      requestPayloadJson: { recordId: "grr_minor_demo", authorityType: "ses_hospedajes" },
      responsePayloadJson: { code: "invalid_document_support_number" },
      errorCode: "invalid_document_support_number",
      errorMessage: "Submission rejected: invalid document support number.",
      submittedAt: "2026-05-16T16:40:00.000Z",
      rejectedAt: "2026-05-16T16:41:00.000Z",
      createdAt: "2026-05-16T16:39:00.000Z",
      updatedAt: "2026-05-16T16:41:00.000Z"
    }
  ],
  identityDocumentProcessingEvents: [
    {
      id: "idpe_maria_discarded",
      propertyId: "prop_123",
      reservationId: "res_18392",
      guestId: "guest_maria",
      eventType: "image_discarded",
      processor: "on_device",
      fieldsExtractedJson: { firstName: "Maria", surname1: "Lopez", documentType: "DNI" },
      confidenceJson: { firstName: 0.96, documentNumber: 0.93 },
      imageStored: false,
      imageDiscarded: true,
      createdBy: "usr_123",
      createdAt: "2026-05-16T16:34:10.000Z"
    }
  ],
  authorityRoutingRules: [
    {
      id: "arr_es_default",
      country: "ES",
      authorityType: "ses_hospedajes",
      priority: 100,
      active: true,
      configurationJson: { rule: "Default Spain authority route" },
      createdAt: "2026-05-14T08:00:00.000Z"
    },
    {
      id: "arr_es_ct_mossos",
      country: "ES",
      regionCode: "CT",
      authorityType: "mossos",
      priority: 10,
      active: true,
      configurationJson: { rule: "Catalonia/Mossos placeholder route, configurable in Back Office" },
      createdAt: "2026-05-14T08:00:00.000Z"
    }
  ],
  aiToolCalls: [],
  auditEvents: [],
  events: [],
  pendingConfirmations: []
};
