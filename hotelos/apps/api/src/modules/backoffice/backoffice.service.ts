import type { HotelModuleCode } from "@hotelos/product";
import { getHotelModuleManifest, getManualSetupOption, HOTEL_MODULES, MANUAL_SETUP_COVERAGE_SUMMARY, MANUAL_SETUP_OPTIONS } from "@hotelos/product";
import { PERMISSIONS, ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import {
  demoStore,
  type AccountingSettingsRecord,
  type BackOfficeAiSuggestionRecord,
  type BuildingRecord,
  type DepartmentRecord,
  type FloorRecord,
  type InvoiceSequenceRecord,
  type BedTypeRecord,
  type DocumentTemplateRecord,
  type HousekeepingSectionRecord,
  type MaintenanceAreaRecord,
  type ManualSetupSubmissionRecord,
  type PropertyAiSettingsRecord,
  type PropertyComplianceSettingsRecord,
  type PropertyImportRecord,
  type PropertyMapPositionRecord,
  type PropertyReadinessCheckRecord,
  type PropertySetupFormSubmissionRecord,
  type PropertySpaceRecord,
  type PropertySetupStepRecord,
  type PropertyZoneRecord,
  type QrCodeRecord,
  type RoomFeatureRecord,
  type RoomRecord,
  type RoomTypeRecord,
  type UserDepartmentRecord,
  type UserRecord,
  type UserContext
} from "../../lib/demo-store.js";

type BackOfficeMutationInput = {
  context: UserContext;
  propertyId: string;
  correlationId: string;
};

type PropertyMapImportRow = {
  building?: string;
  floor?: string;
  zone?: string;
  roomNumber?: string;
  roomType?: string;
  maxOccupancy?: number;
  standardOccupancy?: number;
  beds?: string;
  features?: string;
  sellable?: boolean;
  active?: boolean;
  squareMeters?: number;
  viewType?: string;
  accessibility?: string;
};

const SETUP_STEPS = [
  "organization_details",
  "property_legal_details",
  "property_physical_map",
  "room_types",
  "rooms",
  "departments",
  "users_and_roles",
  "modules",
  "tax_and_compliance",
  "billing_and_invoice_sequences",
  "payments",
  "integrations",
  "ai_settings",
  "review",
  "go_live"
];

type CategoryMode = "system_controlled" | "property_editable" | "property_extendable" | "read_only";

type CategoryDefinitionRecord = {
  id: string;
  code: string;
  name: string;
  description?: string;
  categoryGroup:
    | "Property"
    | "Rooms"
    | "Spaces & Resources"
    | "Operations"
    | "Maintenance"
    | "Housekeeping"
    | "Revenue"
    | "Distribution"
    | "Guest Experience"
    | "Finance"
    | "Compliance"
    | "POS"
    | "Assets"
    | "Safety"
    | "Reservations"
    | "AI";
  entityType?: string;
  mode: CategoryMode;
  valueSchemaJson: Record<string, unknown>;
  isCore: boolean;
  active: boolean;
  sortOrder: number;
};

type PropertyCategoryOptionRecord = {
  id: string;
  propertyId: string;
  categoryDefinitionId: string;
  code: string;
  label: string;
  description?: string;
  colorToken?: string;
  iconName?: string;
  parentOptionId?: string;
  metadataJson: Record<string, unknown>;
  isSystemDefault: boolean;
  active: boolean;
  sortOrder: number;
  createdBy?: string;
  updatedBy?: string;
  usageCount: number;
};

type PropertyCustomFieldDefinitionRecord = {
  id: string;
  propertyId: string;
  entityType: string;
  fieldKey: string;
  label: string;
  description?: string;
  dataType: "text" | "number" | "boolean" | "date" | "datetime" | "select" | "multi_select" | "money" | "percentage" | "json";
  required: boolean;
  searchable: boolean;
  visibleInList: boolean;
  visibleInDetail: boolean;
  optionsCategoryDefinitionId?: string;
  validationJson: Record<string, unknown>;
  visibilityRulesJson: Record<string, unknown>;
  defaultValueJson: Record<string, unknown>;
  active: boolean;
  sortOrder: number;
};

type PropertyCustomFieldValueRecord = {
  id: string;
  propertyId: string;
  entityType: string;
  entityId: string;
  fieldDefinitionId: string;
  valueJson: Record<string, unknown>;
};

type PropertySetupFormField = {
  key: string;
  label: string;
  inputType:
    | "text"
    | "textarea"
    | "number"
    | "boolean"
    | "select"
    | "multi_select"
    | "money"
    | "date"
    | "json";
  required?: boolean;
  categoryCode?: string;
  options?: string[];
  mapsTo?: string;
};

type PropertySetupFormDefinition = {
  code: string;
  title: string;
  route: string;
  apiRoute: string;
  description: string;
  permission: PermissionKey;
  targetEntityType: string;
  setupStepCode: string;
  inputCategories: string[];
  fields: PropertySetupFormField[];
  dataQualityChecks: string[];
};

const categoryDefinitions: CategoryDefinitionRecord[] = [
  { id: "catdef_room_type_categories", code: "room_type_categories", name: "Room type categories", categoryGroup: "Rooms", entityType: "room_type", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 5 },
  { id: "catdef_room_features", code: "room_features", name: "Room features", categoryGroup: "Rooms", entityType: "room", mode: "property_editable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 10 },
  { id: "catdef_bed_types", code: "bed_types", name: "Bed types", categoryGroup: "Rooms", entityType: "room_type", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 20 },
  { id: "catdef_view_types", code: "view_types", name: "View types", categoryGroup: "Rooms", entityType: "room", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 30 },
  { id: "catdef_accessibility_features", code: "accessibility_features", name: "Accessibility features", categoryGroup: "Rooms", entityType: "room", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 40 },
  { id: "catdef_space_types", code: "space_types", name: "Space and resource types", categoryGroup: "Spaces & Resources", entityType: "inventory_resource", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 50 },
  { id: "catdef_housekeeping_task_types", code: "housekeeping_task_types", name: "Housekeeping task types", categoryGroup: "Housekeeping", entityType: "housekeeping_task", mode: "property_editable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 60 },
  { id: "catdef_maintenance_issue_types", code: "maintenance_issue_types", name: "Maintenance issue types", categoryGroup: "Maintenance", entityType: "work_order", mode: "property_editable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 70 },
  { id: "catdef_work_order_priorities", code: "work_order_priorities", name: "Work order priorities", categoryGroup: "Maintenance", entityType: "work_order", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 80 },
  { id: "catdef_market_segments", code: "market_segments", name: "Market segments", categoryGroup: "Revenue", entityType: "reservation", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 90 },
  { id: "catdef_reservation_source_codes", code: "reservation_source_codes", name: "Reservation source codes", categoryGroup: "Reservations", entityType: "reservation", mode: "property_extendable", valueSchemaJson: { usedBy: "manual_reservation_creation" }, isCore: true, active: true, sortOrder: 92 },
  { id: "catdef_reservation_statuses", code: "reservation_statuses", name: "Reservation statuses", categoryGroup: "Reservations", entityType: "reservation", mode: "read_only", valueSchemaJson: { internalState: true }, isCore: true, active: true, sortOrder: 94 },
  { id: "catdef_guarantee_policies", code: "guarantee_policies", name: "Guarantee policies", categoryGroup: "Reservations", entityType: "reservation", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 96 },
  { id: "catdef_cancellation_policies", code: "cancellation_policies", name: "Cancellation policies", categoryGroup: "Reservations", entityType: "reservation", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 98 },
  { id: "catdef_billing_instruction_types", code: "billing_instruction_types", name: "Billing instruction types", categoryGroup: "Finance", entityType: "reservation", mode: "property_extendable", valueSchemaJson: { usedBy: "reservation_billing" }, isCore: true, active: true, sortOrder: 99 },
  { id: "catdef_channel_categories", code: "channel_categories", name: "Channel categories", categoryGroup: "Distribution", entityType: "channel", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 100 },
  { id: "catdef_revenue_report_fields", code: "revenue_report_fields", name: "Revenue report fields", categoryGroup: "Revenue", entityType: "revenue_snapshot", mode: "property_extendable", valueSchemaJson: { supportsLegacyMapping: true }, isCore: true, active: true, sortOrder: 110 },
  { id: "catdef_payment_method_categories", code: "payment_method_categories", name: "Payment method categories", categoryGroup: "Finance", entityType: "payment", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 120 },
  { id: "catdef_invoice_sequence_types", code: "invoice_sequence_types", name: "Invoice sequence types", categoryGroup: "Compliance", entityType: "invoice", mode: "system_controlled", valueSchemaJson: { legalControlled: true }, isCore: true, active: true, sortOrder: 130 },
  { id: "catdef_document_types", code: "document_types", name: "Guest register document types", categoryGroup: "Compliance", entityType: "guest_register", mode: "system_controlled", valueSchemaJson: { legalControlled: true }, isCore: true, active: true, sortOrder: 140 },
  { id: "catdef_pos_product_categories", code: "pos_product_categories", name: "POS product categories", categoryGroup: "POS", entityType: "pos_product", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 150 },
  { id: "catdef_asset_categories", code: "asset_categories", name: "Asset categories", categoryGroup: "Assets", entityType: "asset", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 160 },
  { id: "catdef_safety_incident_categories", code: "safety_incident_categories", name: "Safety incident categories", categoryGroup: "Safety", entityType: "safety_incident", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 170 },
  { id: "catdef_ai_review_categories", code: "ai_review_categories", name: "AI review categories", categoryGroup: "AI", entityType: "ai_human_review", mode: "property_extendable", valueSchemaJson: {}, isCore: true, active: true, sortOrder: 180 }
];

const propertyCategoryOptions: PropertyCategoryOptionRecord[] = [
  { id: "catopt_standard_room_type", propertyId: "prop_123", categoryDefinitionId: "catdef_room_type_categories", code: "standard", label: "Standard", colorToken: "color.surface.raised", iconName: "Hotel", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 5, usageCount: 30 },
  { id: "catopt_balcony", propertyId: "prop_123", categoryDefinitionId: "catdef_room_features", code: "balcony", label: "Balcony", colorToken: "color.status.info", iconName: "Building2", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 12 },
  { id: "catopt_sea_view", propertyId: "prop_123", categoryDefinitionId: "catdef_room_features", code: "sea_view", label: "Sea view", colorToken: "color.brand.electricBlue", iconName: "Waves", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 8 },
  { id: "catopt_king", propertyId: "prop_123", categoryDefinitionId: "catdef_bed_types", code: "king_bed", label: "King bed", colorToken: "color.brand.deepIndigo", iconName: "BedDouble", metadataJson: { capacity: 2 }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 18 },
  { id: "catopt_parking", propertyId: "prop_123", categoryDefinitionId: "catdef_space_types", code: "parking_space", label: "Parking space", colorToken: "color.semantic.success", iconName: "SquareParking", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 20 },
  { id: "catopt_direct", propertyId: "prop_123", categoryDefinitionId: "catdef_channel_categories", code: "direct", label: "Direct", colorToken: "color.semantic.success", iconName: "Globe", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 240 },
  { id: "catopt_ota", propertyId: "prop_123", categoryDefinitionId: "catdef_channel_categories", code: "ota", label: "OTA", colorToken: "color.semantic.warning", iconName: "Share2", metadataJson: {}, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 380 },
  { id: "catopt_history", propertyId: "prop_123", categoryDefinitionId: "catdef_revenue_report_fields", code: "history", label: "History", colorToken: "color.brand.nightBlue", iconName: "History", metadataJson: { legacyReportSection: "History" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 31 },
  { id: "catopt_forecast", propertyId: "prop_123", categoryDefinitionId: "catdef_revenue_report_fields", code: "forecast", label: "Forecast", colorToken: "color.brand.violet", iconName: "TrendingUp", metadataJson: { legacyReportSection: "Forecast" }, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 31 },
  { id: "catopt_source_direct_web", propertyId: "prop_123", categoryDefinitionId: "catdef_reservation_source_codes", code: "direct_web", label: "Direct web", colorToken: "color.semantic.success", iconName: "Globe", metadataJson: { channel: "direct" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 28 },
  { id: "catopt_source_phone", propertyId: "prop_123", categoryDefinitionId: "catdef_reservation_source_codes", code: "phone", label: "Phone", colorToken: "color.brand.nightBlue", iconName: "Phone", metadataJson: { channel: "direct" }, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 12 },
  { id: "catopt_res_confirmed", propertyId: "prop_123", categoryDefinitionId: "catdef_reservation_statuses", code: "confirmed", label: "Confirmed", colorToken: "color.semantic.success", iconName: "CircleCheck", metadataJson: { internalStatus: "confirmed" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 36 },
  { id: "catopt_res_cancelled", propertyId: "prop_123", categoryDefinitionId: "catdef_reservation_statuses", code: "cancelled", label: "Cancelled", colorToken: "color.semantic.danger", iconName: "CircleX", metadataJson: { internalStatus: "cancelled" }, isSystemDefault: true, active: true, sortOrder: 50, usageCount: 4 },
  { id: "catopt_guarantee_card", propertyId: "prop_123", categoryDefinitionId: "catdef_guarantee_policies", code: "card_guarantee", label: "Card guarantee", colorToken: "color.semantic.warning", iconName: "CreditCard", metadataJson: { requiresPaymentToken: true }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 30 },
  { id: "catopt_cancel_flexible", propertyId: "prop_123", categoryDefinitionId: "catdef_cancellation_policies", code: "flexible_18", label: "Flexible until 18:00 previous day", colorToken: "color.semantic.success", iconName: "Undo2", metadataJson: { cutoff: "18:00_previous_day" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 44 },
  { id: "catopt_billing_guest", propertyId: "prop_123", categoryDefinitionId: "catdef_billing_instruction_types", code: "guest_pays_checkout", label: "Guest pays at checkout", colorToken: "color.brand.electricBlue", iconName: "Receipt", metadataJson: { invoiceCustomerType: "guest" }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 24 },
  { id: "catopt_billing_company", propertyId: "prop_123", categoryDefinitionId: "catdef_billing_instruction_types", code: "company_invoice", label: "Company invoice", colorToken: "color.brand.deepIndigo", iconName: "Building2", metadataJson: { invoiceCustomerType: "company" }, isSystemDefault: true, active: true, sortOrder: 20, usageCount: 8 },
  { id: "catopt_dni", propertyId: "prop_123", categoryDefinitionId: "catdef_document_types", code: "DNI", label: "DNI", colorToken: "color.semantic.warning", iconName: "IdCard", metadataJson: { officialCode: true }, isSystemDefault: true, active: true, sortOrder: 10, usageCount: 42 }
];

const customFieldDefinitions: PropertyCustomFieldDefinitionRecord[] = [
  { id: "cf_room_internal_notes", propertyId: "prop_123", entityType: "room", fieldKey: "internal_notes", label: "Internal notes", dataType: "text", required: false, searchable: true, visibleInList: false, visibleInDetail: true, validationJson: {}, visibilityRulesJson: {}, defaultValueJson: {}, active: true, sortOrder: 10 },
  { id: "cf_guest_vip_reason", propertyId: "prop_123", entityType: "guest", fieldKey: "vip_reason", label: "VIP reason", dataType: "select", required: false, searchable: true, visibleInList: true, visibleInDetail: true, optionsCategoryDefinitionId: "catdef_market_segments", validationJson: {}, visibilityRulesJson: {}, defaultValueJson: {}, active: true, sortOrder: 20 }
];

const customFieldValues: PropertyCustomFieldValueRecord[] = [
  { id: "cfv_room_432_notes", propertyId: "prop_123", entityType: "room", entityId: "room_432", fieldDefinitionId: "cf_room_internal_notes", valueJson: { value: "Quiet high-floor guest preference." } }
];

const categoryTemplates = [
  { code: "boutique_hotel", name: "Boutique hotel", creates: ["Sea view", "Balcony", "Signature suite", "Welcome amenity", "Concierge request"], groups: ["Rooms", "Guest Experience", "Revenue"] },
  { code: "urban_business_hotel", name: "Urban business hotel", creates: ["Corporate", "Business transient", "Meeting room", "Late checkout", "Airport transfer"], groups: ["Revenue", "Spaces & Resources", "Guest Experience"] },
  { code: "resort", name: "Resort", creates: ["Pool view", "Spa room", "Resort fee", "Family leisure", "Activities"], groups: ["Rooms", "Spaces & Resources", "POS"] },
  { code: "rural_hotel", name: "Rural hotel", creates: ["Nature view", "Pet friendly", "Fireplace", "Outdoor activity"], groups: ["Rooms", "Guest Experience"] },
  { code: "aparthotel", name: "Aparthotel", creates: ["Kitchenette", "Monthly stay", "Linen exchange", "Apartment cleaning"], groups: ["Rooms", "Housekeeping"] },
  { code: "hostel", name: "Hostel", creates: ["Dorm bed", "Shared bathroom", "Locker", "Group leisure"], groups: ["Rooms", "Revenue"] },
  { code: "luxury_hotel", name: "Luxury hotel", creates: ["Butler service", "Fine dining", "Spa suite", "VIP arrival"], groups: ["Guest Experience", "POS", "Spaces & Resources"] },
  { code: "small_independent_hotel", name: "Small independent hotel", creates: ["Direct", "Walk-in", "Maintenance basic", "Daily cleaning"], groups: ["Revenue", "Operations"] },
  { code: "multi_property_group", name: "Multi-property group", creates: ["Central sales", "Shared supplier", "Group reporting", "Portfolio segment"], groups: ["Revenue", "Finance"] }
];

export const PROPERTY_SETUP_FORM_DEFINITIONS: PropertySetupFormDefinition[] = [
  {
    code: "property_profile",
    title: "Property profile",
    route: "/backoffice/property-setup/property-profile",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/property_profile",
    description: "Legal and operational identity for the property.",
    permission: "property_profile.edit",
    targetEntityType: "property",
    setupStepCode: "property_legal_details",
    inputCategories: ["Property profile", "Legal profile", "Business date rules"],
    fields: [
      { key: "name", label: "Property name", inputType: "text", required: true, mapsTo: "properties.name" },
      { key: "legalName", label: "Legal name", inputType: "text", required: true, mapsTo: "properties.legal_name" },
      { key: "taxId", label: "Tax ID", inputType: "text", required: true, mapsTo: "organizations.tax_id" },
      { key: "address", label: "Address", inputType: "textarea", required: true, mapsTo: "properties.address" },
      { key: "country", label: "Country", inputType: "select", required: true, options: ["ES", "PT", "FR", "IT"], mapsTo: "properties.country" },
      { key: "region", label: "Region", inputType: "text", mapsTo: "properties.tax_region" },
      { key: "province", label: "Province", inputType: "text", mapsTo: "properties.province" },
      { key: "city", label: "City", inputType: "text", required: true, mapsTo: "properties.municipality" },
      { key: "postalCode", label: "Postal code", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.postalCode" },
      { key: "phone", label: "Contact phone", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.phone" },
      { key: "email", label: "Contact email", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.email" },
      { key: "website", label: "Website", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.website" },
      { key: "starRating", label: "Category / star rating", inputType: "select", options: ["1*", "2*", "3*", "4*", "5*", "5* GL"], mapsTo: "property_setup_form_submissions.payload_json.starRating" },
      { key: "totalRooms", label: "Total rooms", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.totalRooms" },
      { key: "checkInTime", label: "Default check-in time", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.checkInTime" },
      { key: "checkOutTime", label: "Default check-out time", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.checkOutTime" },
      { key: "timezone", label: "Timezone", inputType: "select", required: true, options: ["Europe/Madrid", "Europe/Lisbon", "Europe/Paris"], mapsTo: "properties.timezone" },
      { key: "currency", label: "Currency", inputType: "select", required: true, options: ["EUR", "GBP", "USD"], mapsTo: "property_setup_form_submissions.payload_json.currency" },
      { key: "language", label: "Language", inputType: "select", options: ["es", "en", "ca", "fr"], mapsTo: "property_setup_form_submissions.payload_json.language" },
      { key: "taxRegion", label: "Tax region", inputType: "select", options: ["Mainland Spain", "Canary Islands", "Ceuta", "Melilla"], mapsTo: "properties.tax_region" },
      { key: "tourismTaxRegion", label: "Tourism tax region", inputType: "select", options: ["None", "Catalonia", "Balearic Islands"], mapsTo: "property_compliance_settings.tourism_tax_region" },
      { key: "businessDateRules", label: "Business date rules", inputType: "textarea", mapsTo: "property_setup_form_submissions.payload_json.businessDateRules" }
    ],
    dataQualityChecks: ["legal_profile_complete", "timezone_configured", "tax_region_configured"]
  },
  {
    code: "building",
    title: "Building form",
    route: "/backoffice/property-setup/buildings",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/building",
    description: "Create a physical building used by rooms, floors, zones and spaces.",
    permission: "property.map.manage",
    targetEntityType: "building",
    setupStepCode: "property_physical_map",
    inputCategories: ["Buildings", "Property mapper"],
    fields: [
      { key: "name", label: "Building name", inputType: "text", required: true, mapsTo: "buildings.name" },
      { key: "code", label: "Building code", inputType: "text", required: true, mapsTo: "buildings.code" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "buildings.description" },
      { key: "sortOrder", label: "Sort order", inputType: "number", mapsTo: "buildings.sort_order" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "buildings.active" }
    ],
    dataQualityChecks: ["duplicate_building_code", "building_has_floors_or_spaces"]
  },
  {
    code: "floor",
    title: "Floor form",
    route: "/backoffice/property-setup/floors",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/floor",
    description: "Create a floor inside a building.",
    permission: "property.map.manage",
    targetEntityType: "floor",
    setupStepCode: "property_physical_map",
    inputCategories: ["Floors", "Buildings", "Property mapper"],
    fields: [
      { key: "buildingId", label: "Building", inputType: "select", required: true, mapsTo: "floors.building_id" },
      { key: "name", label: "Floor name", inputType: "text", required: true, mapsTo: "floors.name" },
      { key: "floorNumber", label: "Floor number", inputType: "number", mapsTo: "floors.floor_number" },
      { key: "code", label: "Floor code", inputType: "text", mapsTo: "floors.code" },
      { key: "sortOrder", label: "Sort order", inputType: "number", mapsTo: "floors.sort_order" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "floors.active" }
    ],
    dataQualityChecks: ["floor_has_building", "duplicate_floor_code"]
  },
  {
    code: "zone",
    title: "Zone form",
    route: "/backoffice/property-setup/zones",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/zone",
    description: "Create an operational zone for rooms, spaces, housekeeping and maintenance.",
    permission: "property.map.manage",
    targetEntityType: "property_zone",
    setupStepCode: "property_physical_map",
    inputCategories: ["Zones", "Housekeeping sections", "Maintenance areas", "Property mapper"],
    fields: [
      { key: "buildingId", label: "Building", inputType: "select", mapsTo: "property_zones.building_id" },
      { key: "floorId", label: "Floor", inputType: "select", mapsTo: "property_zones.floor_id" },
      { key: "name", label: "Zone name", inputType: "text", required: true, mapsTo: "property_zones.name" },
      { key: "zoneType", label: "Zone type", inputType: "select", required: true, options: ["guest_rooms", "public_area", "back_of_house", "technical", "food_beverage", "wellness", "parking", "events", "outdoor"], mapsTo: "property_zones.zone_type" },
      { key: "code", label: "Code", inputType: "text", mapsTo: "property_zones.code" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "property_zones.description" },
      { key: "housekeepingSectionId", label: "Housekeeping section", inputType: "select", categoryCode: "housekeeping_task_types", mapsTo: "housekeeping_section_rooms.housekeeping_section_id" },
      { key: "maintenanceAreaId", label: "Maintenance area", inputType: "select", categoryCode: "maintenance_issue_types", mapsTo: "maintenance_area_rooms.maintenance_area_id" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "property_zones.active" }
    ],
    dataQualityChecks: ["zone_has_floor", "zone_has_rooms_or_spaces"]
  },
  {
    code: "room_type",
    title: "Room type form",
    route: "/backoffice/property-setup/room-types",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/room_type",
    description: "Define a sellable room type and its operational defaults.",
    permission: "room_types.manage",
    targetEntityType: "room_type",
    setupStepCode: "room_types",
    inputCategories: ["Room types", "Room features", "Bed types", "View types", "Accessibility features"],
    fields: [
      { key: "name", label: "Name", inputType: "text", required: true, mapsTo: "room_types.name" },
      { key: "code", label: "Code", inputType: "text", required: true, mapsTo: "room_types.code" },
      { key: "category", label: "Category", inputType: "select", required: true, categoryCode: "room_type_categories", mapsTo: "room_types.default_rate_category" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "room_types.description" },
      { key: "baseOccupancy", label: "Base occupancy", inputType: "number", required: true, mapsTo: "room_types.base_capacity" },
      { key: "maxOccupancy", label: "Max occupancy", inputType: "number", required: true, mapsTo: "room_types.max_occupancy" },
      { key: "maxAdults", label: "Max adults", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.maxAdults" },
      { key: "maxChildren", label: "Max children", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.maxChildren" },
      { key: "extraBedCapacity", label: "Extra bed capacity", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.extraBedCapacity" },
      { key: "defaultBedSetup", label: "Default bed setup", inputType: "select", categoryCode: "bed_types", mapsTo: "room_types.default_bed_configuration_json" },
      { key: "defaultFeatures", label: "Default features", inputType: "multi_select", categoryCode: "room_features", mapsTo: "room_types.default_amenities_json" },
      { key: "defaultCleaningCategory", label: "Default cleaning category", inputType: "select", categoryCode: "housekeeping_task_types", mapsTo: "room_types.default_amenities_json.cleaningCategory" },
      { key: "smokingPolicy", label: "Smoking policy", inputType: "select", options: ["non_smoking", "smoking", "mixed"], mapsTo: "property_setup_form_submissions.payload_json.smokingPolicy" },
      { key: "baseRate", label: "Base rate (€)", inputType: "money", mapsTo: "property_setup_form_submissions.payload_json.baseRate" },
      { key: "sellable", label: "Sellable", inputType: "boolean", mapsTo: "room_types.sellable" },
      { key: "displayOrder", label: "Display order", inputType: "number", mapsTo: "room_types.display_order" }
    ],
    dataQualityChecks: ["room_type_has_rooms", "room_type_occupancy_valid"]
  },
  {
    code: "room",
    title: "Room form",
    route: "/backoffice/property-setup/rooms",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/room",
    description: "Create and map a physical room to type, building, floor, zone and operational ownership.",
    permission: "rooms.manage",
    targetEntityType: "room",
    setupStepCode: "rooms",
    inputCategories: ["Rooms", "Room types", "Buildings", "Floors", "Zones", "Housekeeping sections", "Maintenance areas"],
    fields: [
      { key: "roomNumber", label: "Room number", inputType: "text", required: true, mapsTo: "rooms.number" },
      { key: "displayName", label: "Display name", inputType: "text", mapsTo: "rooms.display_name" },
      { key: "roomTypeId", label: "Room type", inputType: "select", required: true, mapsTo: "rooms.room_type_id" },
      { key: "buildingId", label: "Building", inputType: "select", required: true, mapsTo: "rooms.building_id" },
      { key: "floorId", label: "Floor", inputType: "select", required: true, mapsTo: "rooms.floor_id" },
      { key: "zoneId", label: "Zone", inputType: "select", required: true, mapsTo: "rooms.zone_id" },
      { key: "maxOccupancy", label: "Max occupancy", inputType: "number", mapsTo: "rooms.max_occupancy" },
      { key: "standardOccupancy", label: "Standard occupancy", inputType: "number", mapsTo: "rooms.standard_occupancy" },
      { key: "beds", label: "Beds", inputType: "json", categoryCode: "bed_types", mapsTo: "rooms.bed_configuration_json" },
      { key: "features", label: "Features", inputType: "multi_select", categoryCode: "room_features", mapsTo: "rooms.features_json" },
      { key: "viewType", label: "View type", inputType: "select", categoryCode: "view_types", mapsTo: "rooms.view_type" },
      { key: "orientation", label: "Orientation", inputType: "text", mapsTo: "rooms.orientation" },
      { key: "squareMeters", label: "Square meters", inputType: "number", mapsTo: "rooms.square_meters" },
      { key: "accessibility", label: "Accessibility", inputType: "multi_select", categoryCode: "accessibility_features", mapsTo: "rooms.accessibility_json" },
      { key: "sellable", label: "Sellable", inputType: "boolean", mapsTo: "rooms.sellable" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "rooms.active" },
      { key: "status", label: "Status", inputType: "select", options: ["clean", "dirty", "inspected", "occupied", "out_of_order", "out_of_service"], mapsTo: "rooms.status" }
    ],
    dataQualityChecks: ["room_has_type", "room_has_building_floor_zone", "sellable_room_has_operational_ownership"]
  },
  {
    code: "space_resource",
    title: "Space and resource form",
    route: "/backoffice/property-setup/spaces-resources",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/space_resource",
    description: "Create bookable and non-bookable spaces such as parking, meeting rooms, outlets and technical areas.",
    permission: "spaces.manage",
    targetEntityType: "property_space",
    setupStepCode: "property_physical_map",
    inputCategories: ["Spaces", "Bookable resources", "Resource types", "Space types"],
    fields: [
      { key: "name", label: "Name", inputType: "text", required: true, mapsTo: "property_spaces.name" },
      { key: "code", label: "Code", inputType: "text", required: true, mapsTo: "property_spaces.code" },
      { key: "resourceType", label: "Resource type", inputType: "select", required: true, categoryCode: "space_types", options: ["parking_space", "meeting_room", "coworking_desk", "spa_room", "restaurant_table", "event_space", "equipment", "storage", "technical_room", "other"], mapsTo: "inventory_resources.resource_type" },
      { key: "spaceType", label: "Space type", inputType: "select", required: true, options: ["reception", "lobby", "restaurant", "bar", "kitchen", "spa", "gym", "pool", "parking", "meeting_room", "laundry", "storage", "technical_room", "office", "terrace", "garden", "other"], mapsTo: "property_spaces.space_type" },
      { key: "buildingId", label: "Building", inputType: "select", mapsTo: "property_spaces.building_id" },
      { key: "floorId", label: "Floor", inputType: "select", mapsTo: "property_spaces.floor_id" },
      { key: "zoneId", label: "Zone", inputType: "select", mapsTo: "property_spaces.zone_id" },
      { key: "capacity", label: "Capacity", inputType: "number", mapsTo: "property_setup_form_submissions.payload_json.capacity" },
      { key: "hourlyBookable", label: "Hourly bookable", inputType: "boolean", mapsTo: "property_setup_form_submissions.payload_json.hourlyBookable" },
      { key: "dailyBookable", label: "Daily bookable", inputType: "boolean", mapsTo: "property_setup_form_submissions.payload_json.dailyBookable" },
      { key: "monthlyBookable", label: "Monthly bookable", inputType: "boolean", mapsTo: "property_setup_form_submissions.payload_json.monthlyBookable" },
      { key: "sellable", label: "Sellable", inputType: "boolean", mapsTo: "property_setup_form_submissions.payload_json.sellable" },
      { key: "taxCode", label: "Tax code", inputType: "select", categoryCode: "payment_method_categories", mapsTo: "property_setup_form_submissions.payload_json.taxCode" },
      { key: "defaultRate", label: "Default rate", inputType: "money", mapsTo: "property_setup_form_submissions.payload_json.defaultRate" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "property_spaces.active" }
    ],
    dataQualityChecks: ["sellable_resource_has_tax_code", "bookable_resource_has_capacity"]
  },
  {
    code: "department",
    title: "Department form",
    route: "/backoffice/property-setup/departments",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/department",
    description: "Create operational departments and ownership for setup, tasks and approvals.",
    permission: "departments.manage",
    targetEntityType: "department",
    setupStepCode: "departments",
    inputCategories: ["Departments", "Users", "Roles"],
    fields: [
      { key: "name", label: "Name", inputType: "text", required: true, mapsTo: "departments.name" },
      { key: "code", label: "Code", inputType: "text", required: true, mapsTo: "departments.code" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "departments.description" },
      { key: "managerUserId", label: "Manager", inputType: "select", mapsTo: "user_departments.user_id" },
      { key: "userIds", label: "Users", inputType: "multi_select", mapsTo: "user_departments.user_id" },
      { key: "active", label: "Active", inputType: "boolean", mapsTo: "departments.active" }
    ],
    dataQualityChecks: ["department_code_unique", "department_has_manager"]
  },
  {
    code: "housekeeping_setup",
    title: "Housekeeping setup form",
    route: "/backoffice/property-setup/operations",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/housekeeping_setup",
    description: "Configure sections, task types, cleaning schemas and inspection rules.",
    permission: "operations_setup.manage",
    targetEntityType: "housekeeping_rule",
    setupStepCode: "departments",
    inputCategories: ["Housekeeping sections", "Housekeeping task types", "Cleaning schemas"],
    fields: [
      { key: "sectionName", label: "Housekeeping section", inputType: "text", required: true, mapsTo: "housekeeping_sections.name" },
      { key: "taskTypes", label: "Task types", inputType: "multi_select", categoryCode: "housekeeping_task_types", mapsTo: "property_category_options" },
      { key: "cleaningSchemas", label: "Cleaning schemas", inputType: "multi_select", mapsTo: "housekeeping_rules.configuration_json.cleaningSchemas" },
      { key: "defaultDurationMinutes", label: "Default duration", inputType: "number", mapsTo: "housekeeping_rules.configuration_json.defaultDurationMinutes" },
      { key: "inspectionRequired", label: "Inspection required", inputType: "boolean", mapsTo: "housekeeping_rules.configuration_json.inspectionRequired" },
      { key: "stayoverPolicy", label: "Stayover policy", inputType: "select", options: ["daily", "on_request", "every_two_days", "eco_opt_out"], mapsTo: "housekeeping_rules.configuration_json.stayoverPolicy" },
      { key: "departurePolicy", label: "Departure policy", inputType: "textarea", mapsTo: "housekeeping_rules.configuration_json.departurePolicy" },
      { key: "deepCleanFrequency", label: "Deep clean frequency", inputType: "text", mapsTo: "housekeeping_rules.configuration_json.deepCleanFrequency" },
      { key: "linenRules", label: "Linen rules", inputType: "textarea", mapsTo: "housekeeping_rules.configuration_json.linenRules" },
      { key: "minibarRules", label: "Minibar rules", inputType: "textarea", mapsTo: "housekeeping_rules.configuration_json.minibarRules" }
    ],
    dataQualityChecks: ["housekeeping_sections_cover_sellable_rooms", "inspection_policy_configured"]
  },
  {
    code: "maintenance_setup",
    title: "Maintenance setup form",
    route: "/backoffice/property-setup/maintenance",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/maintenance_setup",
    description: "Configure maintenance areas, issue types, priorities, SLA and room blocking rules.",
    permission: "operations_setup.manage",
    targetEntityType: "maintenance_rule",
    setupStepCode: "departments",
    inputCategories: ["Maintenance areas", "Maintenance issue types", "Work order priorities", "Asset categories"],
    fields: [
      { key: "areaName", label: "Maintenance area", inputType: "text", required: true, mapsTo: "maintenance_areas.name" },
      { key: "issueTypes", label: "Issue types", inputType: "multi_select", categoryCode: "maintenance_issue_types", mapsTo: "property_category_options" },
      { key: "priorityLevels", label: "Priority levels", inputType: "multi_select", categoryCode: "work_order_priorities", mapsTo: "property_category_options" },
      { key: "slaRules", label: "SLA rules", inputType: "textarea", mapsTo: "maintenance_rules.configuration_json.slaRules" },
      { key: "roomBlockingRules", label: "Room blocking rules", inputType: "textarea", mapsTo: "maintenance_rules.configuration_json.roomBlockingRules" },
      { key: "assetCategories", label: "Asset categories", inputType: "multi_select", categoryCode: "asset_categories", mapsTo: "property_category_options" },
      { key: "contractorCategories", label: "Contractor categories", inputType: "multi_select", mapsTo: "maintenance_rules.configuration_json.contractorCategories" },
      { key: "preventiveMaintenanceCategories", label: "Preventive maintenance categories", inputType: "multi_select", mapsTo: "maintenance_rules.configuration_json.preventiveMaintenanceCategories" }
    ],
    dataQualityChecks: ["maintenance_areas_cover_rooms", "blocking_rules_configured"]
  },
  {
    code: "revenue_setup",
    title: "Revenue category form",
    route: "/backoffice/property-setup/revenue",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/revenue_setup",
    description: "Configure commercial taxonomy used by rate plans, reports, segmentation and forecasts.",
    permission: "revenue_setup.manage",
    targetEntityType: "revenue_category_setup",
    setupStepCode: "modules",
    inputCategories: ["Market segments", "Source codes", "Channel categories", "Revenue categories", "Forecast driver categories"],
    fields: [
      { key: "marketSegmentLabel", label: "Market segment", inputType: "text", required: true, categoryCode: "market_segments", mapsTo: "property_category_options.market_segments" },
      { key: "sourceCodeLabel", label: "Source code", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.sourceCodeLabel" },
      { key: "channelCategoryLabel", label: "Channel category", inputType: "text", categoryCode: "channel_categories", mapsTo: "property_category_options.channel_categories" },
      { key: "rateCategoryLabel", label: "Rate category", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.rateCategoryLabel" },
      { key: "demandEventType", label: "Demand event type", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.demandEventType" },
      { key: "forecastDriverCategory", label: "Forecast driver category", inputType: "text", mapsTo: "property_setup_form_submissions.payload_json.forecastDriverCategory" }
    ],
    dataQualityChecks: ["rate_plans_have_category", "channels_have_category", "legacy_revenue_report_fields_mapped"]
  },
  {
    code: "finance_compliance_setup",
    title: "Finance and compliance setup form",
    route: "/backoffice/property-setup/finance-compliance",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/finance_compliance_setup",
    description: "Configure tax, invoice sequences, authority routing, payment methods and retention rules.",
    permission: "compliance_setup.manage",
    targetEntityType: "property_compliance_settings",
    setupStepCode: "tax_and_compliance",
    inputCategories: ["Tax codes", "Payment method categories", "Invoice sequences", "Compliance settings", "Retention rules"],
    fields: [
      { key: "taxRegion", label: "Tax region", inputType: "text", required: true, mapsTo: "property_compliance_settings.tax_region" },
      { key: "authorityType", label: "Authority type", inputType: "select", required: true, options: ["ses_hospedajes", "mossos", "ertzaintza", "manual", "other"], mapsTo: "property_compliance_settings.configuration_json.authorityType" },
      { key: "paymentMethodCategory", label: "Payment method category", inputType: "text", categoryCode: "payment_method_categories", mapsTo: "property_category_options.payment_method_categories" },
      { key: "invoiceSequenceCode", label: "Invoice sequence code", inputType: "text", required: true, mapsTo: "invoice_sequences.sequence_code" },
      { key: "invoiceType", label: "Invoice type", inputType: "select", required: true, options: ["full", "simplified", "rectifying", "credit_note"], mapsTo: "invoice_sequences.invoice_type" },
      { key: "retentionRule", label: "Retention rule", inputType: "text", mapsTo: "property_compliance_settings.configuration_json.retentionRule" },
      { key: "submissionMode", label: "Submission mode", inputType: "select", options: ["batch_export", "web_service", "manual"], mapsTo: "property_compliance_settings.configuration_json.submissionMode" }
    ],
    dataQualityChecks: ["invoice_sequence_configured", "ses_hospedajes_credentials", "retention_rule_configured"]
  },
  {
    code: "ai_setup",
    title: "AI setup form",
    route: "/backoffice/property-setup/ai",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/ai_setup",
    description: "Configure AI automation level, OCR privacy, locales and human review defaults.",
    permission: "ai.configure",
    targetEntityType: "property_ai_settings",
    setupStepCode: "ai_settings",
    inputCategories: ["AI settings", "AI governance", "OCR privacy"],
    fields: [
      { key: "aiEnabled", label: "AI enabled", inputType: "boolean", mapsTo: "property_ai_settings.ai_enabled" },
      { key: "defaultAutomationLevel", label: "Default automation level", inputType: "select", required: true, options: ["off", "draft_only", "suggest_and_confirm", "auto_low_risk", "auto_within_rules"], mapsTo: "property_ai_settings.default_automation_level" },
      { key: "guestFacingDisclosure", label: "Guest-facing disclosure", inputType: "textarea", mapsTo: "property_ai_settings.guest_facing_disclosure" },
      { key: "voiceLocales", label: "Voice locales", inputType: "multi_select", options: ["es-ES", "en-US", "ca-ES", "fr-FR"], mapsTo: "property_ai_settings.voice_locales" },
      { key: "documentImageRetentionPolicy", label: "Document image retention policy", inputType: "select", options: ["discard_after_ocr", "manual_exception_only"], mapsTo: "property_ai_settings.configuration_json.documentImageRetentionPolicy" },
      { key: "humanReviewDefault", label: "Human review default", inputType: "select", options: ["required_for_sensitive", "required_for_high_risk", "always"], mapsTo: "property_ai_settings.configuration_json.humanReviewDefault" }
    ],
    dataQualityChecks: ["document_image_storage_disabled", "high_risk_ai_requires_confirmation"]
  },
  {
    code: "custom_field",
    title: "Custom field form",
    route: "/backoffice/property-setup/custom-fields",
    apiRoute: "/backoffice/properties/:propertyId/property-setup/forms/custom_field",
    description: "Add custom fields to rooms, guests, reservations, assets or resources without code changes.",
    permission: "custom_fields.manage",
    targetEntityType: "property_custom_field_definition",
    setupStepCode: "property_physical_map",
    inputCategories: ["Custom fields", "Validation rules", "Visibility rules"],
    fields: [
      { key: "entityType", label: "Entity type", inputType: "select", required: true, options: ["room", "room_type", "guest", "reservation", "asset", "inventory_resource", "work_order"], mapsTo: "property_custom_field_definitions.entity_type" },
      { key: "fieldKey", label: "Field key", inputType: "text", required: true, mapsTo: "property_custom_field_definitions.field_key" },
      { key: "label", label: "Label", inputType: "text", required: true, mapsTo: "property_custom_field_definitions.label" },
      { key: "description", label: "Description", inputType: "textarea", mapsTo: "property_custom_field_definitions.description" },
      { key: "dataType", label: "Data type", inputType: "select", required: true, options: ["text", "number", "boolean", "date", "datetime", "select", "multi_select", "money", "percentage", "json"], mapsTo: "property_custom_field_definitions.data_type" },
      { key: "required", label: "Required", inputType: "boolean", mapsTo: "property_custom_field_definitions.required" },
      { key: "searchable", label: "Searchable", inputType: "boolean", mapsTo: "property_custom_field_definitions.searchable" },
      { key: "visibleInList", label: "Visible in list", inputType: "boolean", mapsTo: "property_custom_field_definitions.visible_in_list" },
      { key: "visibleInDetail", label: "Visible in detail", inputType: "boolean", mapsTo: "property_custom_field_definitions.visible_in_detail" },
      { key: "validationJson", label: "Validation JSON", inputType: "json", mapsTo: "property_custom_field_definitions.validation_json" }
    ],
    dataQualityChecks: ["custom_required_fields_have_defaults", "custom_field_keys_unique"]
  }
];

function audit(input: BackOfficeMutationInput & {
  action: string;
  entityType: string;
  entityId?: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}) {
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeJson: input.beforeJson,
    afterJson: input.afterJson,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
}

function domain(input: BackOfficeMutationInput & {
  eventType: string;
  entityType: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}) {
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: input.entityType,
    entityId: input.entityId ?? "",
    eventType: input.eventType,
    payload: input.payload ?? {},
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
}

function enabledModuleCodes(propertyId: string): HotelModuleCode[] {
  return demoStore.propertyModules
    .filter((propertyModule) => propertyModule.propertyId === propertyId && propertyModule.status === "enabled")
    .map((propertyModule) => demoStore.modules.find((module) => module.id === propertyModule.moduleId)?.code)
    .filter((code): code is HotelModuleCode => Boolean(code));
}

function requireProperty(propertyId: string) {
  const property = demoStore.properties.find((candidate) => candidate.id === propertyId);
  if (!property) {
    throw new Error("Property was not found.");
  }
  return property;
}

function requireCategoryDefinition(categoryCode: string) {
  const definition = categoryDefinitions.find((candidate) => candidate.code === categoryCode && candidate.active);
  if (!definition) {
    throw new Error(`Category definition was not found: ${categoryCode}`);
  }
  return definition;
}

function requireCategoryOption(propertyId: string, optionId: string) {
  const option = propertyCategoryOptions.find((candidate) => candidate.id === optionId && candidate.propertyId === propertyId);
  if (!option) {
    throw new Error(`Category option was not found: ${optionId}`);
  }
  return option;
}

function categoryOptionUsage(optionId: string) {
  return propertyCategoryOptions.find((option) => option.id === optionId)?.usageCount ?? 0;
}

function assertCategoryModeAllowsEdit(definition: CategoryDefinitionRecord, patch?: Record<string, unknown>) {
  if (definition.mode === "read_only") {
    throw new Error("Read-only categories cannot be edited.");
  }
  if (definition.mode === "system_controlled" && (patch?.code !== undefined || patch?.label !== undefined)) {
    throw new Error("System-controlled legal category codes and labels cannot be renamed.");
  }
}

function categoryWithOptions(propertyId: string, definition: CategoryDefinitionRecord) {
  const options = propertyCategoryOptions
    .filter((option) => option.propertyId === propertyId && option.categoryDefinitionId === definition.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((option) => ({
      ...option,
      canDelete: option.usageCount === 0 && !option.isSystemDefault,
      canDeactivate: true,
      linkedRecordsUrl: `/backoffice/properties/${propertyId}/configuration/categories/${definition.code}?option=${option.id}`
    }));
  return {
    ...definition,
    options,
    activeOptions: options.filter((option) => option.active).length,
    inactiveOptions: options.filter((option) => !option.active).length
  };
}

function configurationDataQuality(propertyId: string) {
  const rooms = demoStore.rooms.filter((room) => room.propertyId === propertyId);
  const roomTypes = demoStore.roomTypes.filter((roomType) => roomType.propertyId === propertyId);
  return [
    {
      code: "rooms_without_room_type",
      severity: rooms.some((room) => room.sellable && !room.roomTypeId) ? "blocking" : "info",
      message: "Sellable rooms must have an active room type."
    },
    {
      code: "rooms_without_building_floor_zone",
      severity: rooms.some((room) => !room.buildingId || !room.floorId || !room.zoneId) ? "warning" : "info",
      message: "Rooms should be mapped to building, floor and zone."
    },
    {
      code: "room_type_without_rooms",
      severity: roomTypes.some((roomType) => !rooms.some((room) => room.roomTypeId === roomType.id)) ? "warning" : "info",
      message: "Room types without rooms should be reviewed."
    },
    {
      code: "inactive_category_still_used_by_active_records",
      severity: propertyCategoryOptions.some((option) => option.propertyId === propertyId && !option.active && option.usageCount > 0) ? "warning" : "info",
      message: "Inactive category options remain visible in historical records and should be reviewed."
    },
    {
      code: "duplicate_option_codes",
      severity: "info",
      message: "Property/category option codes are unique by database constraint."
    }
  ];
}

function propertySetupFormDefinition(formCode: string) {
  const definition = PROPERTY_SETUP_FORM_DEFINITIONS.find((candidate) => candidate.code === formCode);
  if (!definition) {
    throw new Error(`Property setup form was not found: ${formCode}`);
  }
  return definition;
}

function manualSetupOptionDefinition(optionCode: string) {
  const option = getManualSetupOption(optionCode);
  if (!option) {
    throw new Error(`Manual setup option was not found: ${optionCode}`);
  }
  return option;
}

function manualSetupInputKey(label: string) {
  const words = label
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
}

function manualSetupPayloadValues(payload: Record<string, unknown>) {
  return typeof payload.values === "object" && payload.values !== null && !Array.isArray(payload.values)
    ? payload.values as Record<string, unknown>
    : payload;
}

function manualSetupPayloadHasValue(values: Record<string, unknown>, label: string) {
  const camelKey = manualSetupInputKey(label);
  const snakeKey = camelKey.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
  const candidateValues = [values[label], values[camelKey], values[snakeKey]];
  return candidateValues.some((value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

function validateManualSetupPayload(option: ReturnType<typeof manualSetupOptionDefinition>, payload: Record<string, unknown>) {
  const values = manualSetupPayloadValues(payload);
  return option.requiredInputs
    .filter((input) => !manualSetupPayloadHasValue(values, input))
    .map((input) => `${input} is required for ${option.label}.`);
}

function payloadText(payload: Record<string, unknown>, key: string, fallback?: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback ?? "";
}

function payloadNumber(payload: Record<string, unknown>, key: string, fallback?: number) {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return fallback;
}

function payloadBoolean(payload: Record<string, unknown>, key: string, fallback = true) {
  const value = payload[key];
  return typeof value === "boolean" ? value : fallback;
}

function payloadArray(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}

function completePropertySetupStep(input: BackOfficeMutationInput, stepCode: string, metadataJson: Record<string, unknown>) {
  let step = demoStore.propertySetupSteps.find((candidate) => candidate.propertyId === input.propertyId && candidate.stepCode === stepCode);
  if (!step) {
    step = {
      id: createId("setup"),
      propertyId: input.propertyId,
      stepCode,
      status: "completed",
      completedAt: nowIso(),
      completedBy: input.context.userId,
      metadataJson
    };
    demoStore.propertySetupSteps.push(step);
  } else {
    step.status = "completed";
    step.completedAt = nowIso();
    step.completedBy = input.context.userId;
    step.metadataJson = { ...step.metadataJson, ...metadataJson };
  }
  return step;
}

function createCategoryOptionFromSetup(input: BackOfficeMutationInput, categoryCode: string, label: string) {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) return undefined;
  const definition = requireCategoryDefinition(categoryCode);
  const code = trimmedLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const existing = propertyCategoryOptions.find(
    (option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id && option.code === code
  );
  if (existing) return existing;
  const record: PropertyCategoryOptionRecord = {
    id: createId("catopt"),
    propertyId: input.propertyId,
    categoryDefinitionId: definition.id,
    code,
    label: trimmedLabel,
    metadataJson: { createdFrom: "property_setup_form" },
    isSystemDefault: false,
    active: true,
    sortOrder: propertyCategoryOptions.length + 1,
    createdBy: input.context.userId,
    usageCount: 0
  };
  propertyCategoryOptions.push(record);
  audit({ ...input, action: "CategoryOptionCreated", entityType: "property_category_option", entityId: record.id, afterJson: record });
  return record;
}

function validatePropertySetupPayload(definition: PropertySetupFormDefinition, payload: Record<string, unknown>) {
  return definition.fields
    .filter((field) => field.required)
    .filter((field) => {
      const value = payload[field.key];
      return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    })
    .map((field) => `${field.label} is required.`);
}

function formExistingData(propertyId: string, formCode: string) {
  switch (formCode) {
    case "property_profile":
      return {
        property: requireProperty(propertyId),
        organization: demoStore.organization,
        compliance: getComplianceSettings(propertyId)
      };
    case "building":
      return demoStore.buildings.filter((building) => building.propertyId === propertyId);
    case "floor":
      return demoStore.floors.filter((floor) => floor.propertyId === propertyId);
    case "zone":
      return demoStore.propertyZones.filter((zone) => zone.propertyId === propertyId);
    case "room_type":
      return listBackOfficeRoomTypes(propertyId);
    case "room":
      return demoStore.rooms.filter((room) => room.propertyId === propertyId);
    case "space_resource":
      return demoStore.propertySpaces.filter((space) => space.propertyId === propertyId);
    case "department":
      return listDepartments(propertyId);
    case "housekeeping_setup":
      return getHousekeepingConfiguration(propertyId);
    case "maintenance_setup":
      return getMaintenanceConfiguration(propertyId);
    case "finance_compliance_setup":
      return { compliance: getComplianceSettings(propertyId), billing: getBillingSettings(propertyId) };
    case "ai_setup":
      return getAiSettings(propertyId);
    case "custom_field":
      return listCustomFields(propertyId);
    default:
      return {};
  }
}

type PropertySetupTarget = {
  targetEntityType: string;
  targetEntityId?: string;
  result: unknown;
};

function applyPropertySetupForm(input: BackOfficeMutationInput, definition: PropertySetupFormDefinition, payload: Record<string, unknown>): PropertySetupTarget {
  switch (definition.code) {
    case "property_profile": {
      const property = requireProperty(input.propertyId);
      const before = { property: { ...property }, organization: { ...demoStore.organization } };
      property.name = payloadText(payload, "name", property.name);
      property.legalName = payloadText(payload, "legalName", property.legalName ?? property.name);
      property.address = payloadText(payload, "address", property.address ?? "");
      property.country = payloadText(payload, "country", property.country);
      property.municipality = payloadText(payload, "city", property.municipality ?? "");
      property.province = payloadText(payload, "province", property.province ?? "");
      property.timezone = payloadText(payload, "timezone", property.timezone);
      property.taxRegion = payloadText(payload, "taxRegion", payloadText(payload, "region", property.taxRegion ?? ""));
      if (demoStore.property.id === property.id) Object.assign(demoStore.property, property);
      demoStore.organization.legalName = payloadText(payload, "legalName", demoStore.organization.legalName);
      demoStore.organization.taxId = payloadText(payload, "taxId", demoStore.organization.taxId);
      const compliance = getComplianceSettings(input.propertyId);
      if (compliance) {
        compliance.taxRegion = payloadText(payload, "taxRegion", compliance.taxRegion ?? "");
        compliance.tourismTaxRegion = payloadText(payload, "tourismTaxRegion", compliance.tourismTaxRegion ?? "");
        compliance.updatedAt = nowIso();
      }
      audit({ ...input, action: "PropertyProfileUpdated", entityType: "property", entityId: property.id, beforeJson: before, afterJson: { property, organization: demoStore.organization, compliance } });
      return { targetEntityType: "property", targetEntityId: property.id, result: property };
    }
    case "building": {
      const building = createBuilding({
        ...input,
        building: {
          name: payloadText(payload, "name"),
          code: payloadText(payload, "code"),
          description: payloadText(payload, "description"),
          sortOrder: payloadNumber(payload, "sortOrder"),
          active: payloadBoolean(payload, "active", true)
        }
      });
      return { targetEntityType: "building", targetEntityId: building.id, result: building };
    }
    case "floor": {
      const floor = createFloor({
        ...input,
        floor: {
          buildingId: payloadText(payload, "buildingId", demoStore.buildings.find((building) => building.propertyId === input.propertyId)?.id),
          name: payloadText(payload, "name"),
          floorNumber: payloadNumber(payload, "floorNumber"),
          code: payloadText(payload, "code"),
          sortOrder: payloadNumber(payload, "sortOrder"),
          active: payloadBoolean(payload, "active", true)
        }
      });
      return { targetEntityType: "floor", targetEntityId: floor.id, result: floor };
    }
    case "zone": {
      const zone = createZone({
        ...input,
        zone: {
          buildingId: payloadText(payload, "buildingId", demoStore.buildings.find((building) => building.propertyId === input.propertyId)?.id),
          floorId: payloadText(payload, "floorId", demoStore.floors.find((floor) => floor.propertyId === input.propertyId)?.id),
          name: payloadText(payload, "name"),
          zoneType: payloadText(payload, "zoneType", "guest_rooms") as PropertyZoneRecord["zoneType"],
          code: payloadText(payload, "code"),
          description: payloadText(payload, "description"),
          active: payloadBoolean(payload, "active", true)
        }
      });
      return { targetEntityType: "property_zone", targetEntityId: zone.id, result: zone };
    }
    case "room_type": {
      const roomType = createBackOfficeRoomType({
        ...input,
        roomType: {
          name: payloadText(payload, "name"),
          code: payloadText(payload, "code"),
          maxOccupancy: payloadNumber(payload, "maxOccupancy", 2)!,
          baseCapacity: payloadNumber(payload, "baseOccupancy", 2)!,
          description: payloadText(payload, "description"),
          defaultBedConfigurationJson: { defaultBedSetup: payloadText(payload, "defaultBedSetup") },
          defaultAmenitiesJson: {
            features: payloadArray(payload, "defaultFeatures"),
            cleaningCategory: payloadText(payload, "defaultCleaningCategory")
          },
          defaultRateCategory: payloadText(payload, "category"),
          sellable: payloadBoolean(payload, "sellable", true),
          displayOrder: payloadNumber(payload, "displayOrder")
        }
      });
      return { targetEntityType: "room_type", targetEntityId: roomType.id, result: roomType };
    }
    case "room": {
      const created = bulkCreateRooms({
        ...input,
        roomTypeId: payloadText(payload, "roomTypeId", demoStore.roomTypes.find((roomType) => roomType.propertyId === input.propertyId)?.id),
        roomNumbers: [payloadText(payload, "roomNumber")],
        buildingId: payloadText(payload, "buildingId", demoStore.buildings.find((building) => building.propertyId === input.propertyId)?.id),
        floorId: payloadText(payload, "floorId", demoStore.floors.find((floor) => floor.propertyId === input.propertyId)?.id),
        zoneId: payloadText(payload, "zoneId", demoStore.propertyZones.find((zone) => zone.propertyId === input.propertyId)?.id),
        sellable: payloadBoolean(payload, "sellable", true),
        active: payloadBoolean(payload, "active", true)
      });
      const room = created.rooms[0];
      Object.assign(room, {
        displayName: payloadText(payload, "displayName", room.displayName ?? `Room ${room.number}`),
        maxOccupancy: payloadNumber(payload, "maxOccupancy", room.maxOccupancy),
        standardOccupancy: payloadNumber(payload, "standardOccupancy", room.standardOccupancy),
        bedConfigurationJson: { beds: payload.beds ?? {} },
        featuresJson: { features: payloadArray(payload, "features") },
        viewType: payloadText(payload, "viewType", room.viewType ?? ""),
        orientation: payloadText(payload, "orientation", room.orientation ?? ""),
        squareMeters: payloadNumber(payload, "squareMeters", room.squareMeters),
        accessibilityJson: { accessibility: payloadArray(payload, "accessibility") },
        status: payloadText(payload, "status", room.status) as RoomRecord["status"]
      });
      return { targetEntityType: "room", targetEntityId: room.id, result: room };
    }
    case "space_resource": {
      const space = createSpace({
        ...input,
        space: {
          name: payloadText(payload, "name"),
          code: payloadText(payload, "code"),
          spaceType: payloadText(payload, "spaceType", "other") as PropertySpaceRecord["spaceType"],
          buildingId: payloadText(payload, "buildingId", demoStore.buildings.find((building) => building.propertyId === input.propertyId)?.id),
          floorId: payloadText(payload, "floorId", demoStore.floors.find((floor) => floor.propertyId === input.propertyId)?.id),
          zoneId: payloadText(payload, "zoneId", demoStore.propertyZones.find((zone) => zone.propertyId === input.propertyId)?.id),
          description: JSON.stringify({
            resourceType: payloadText(payload, "resourceType"),
            capacity: payloadNumber(payload, "capacity"),
            hourlyBookable: payloadBoolean(payload, "hourlyBookable", false),
            dailyBookable: payloadBoolean(payload, "dailyBookable", true),
            monthlyBookable: payloadBoolean(payload, "monthlyBookable", false),
            sellable: payloadBoolean(payload, "sellable", false),
            taxCode: payloadText(payload, "taxCode"),
            defaultRate: payloadNumber(payload, "defaultRate")
          }),
          active: payloadBoolean(payload, "active", true)
        }
      });
      return { targetEntityType: "property_space", targetEntityId: space.id, result: space };
    }
    case "department": {
      const department = createDepartment({
        ...input,
        department: {
          name: payloadText(payload, "name"),
          code: payloadText(payload, "code"),
          description: payloadText(payload, "description"),
          active: payloadBoolean(payload, "active", true)
        }
      });
      const managerUserId = payloadText(payload, "managerUserId");
      if (managerUserId) {
        assignUserToDepartment({ ...input, departmentId: department.id, userId: managerUserId, roleLabel: "Manager" });
      }
      return { targetEntityType: "department", targetEntityId: department.id, result: department };
    }
    case "housekeeping_setup": {
      const section = createHousekeepingSection({
        ...input,
        section: {
          name: payloadText(payload, "sectionName"),
          code: payloadText(payload, "sectionCode"),
          active: true
        }
      });
      const rule = upsertHousekeepingRule({
        ...input,
        ruleCode: "housekeeping_operating_policy",
        configurationJson: payload,
        active: true
      });
      return { targetEntityType: "housekeeping_rule", targetEntityId: rule.id, result: { section, rule } };
    }
    case "maintenance_setup": {
      const area = createMaintenanceArea({
        ...input,
        area: {
          name: payloadText(payload, "areaName"),
          code: payloadText(payload, "areaCode"),
          active: true
        }
      });
      const rule = upsertMaintenanceRule({
        ...input,
        ruleCode: "maintenance_operating_policy",
        configurationJson: payload,
        active: true
      });
      return { targetEntityType: "maintenance_rule", targetEntityId: rule.id, result: { area, rule } };
    }
    case "revenue_setup": {
      const createdOptions = [
        createCategoryOptionFromSetup(input, "market_segments", payloadText(payload, "marketSegmentLabel")),
        createCategoryOptionFromSetup(input, "channel_categories", payloadText(payload, "channelCategoryLabel")),
        createCategoryOptionFromSetup(input, "revenue_report_fields", payloadText(payload, "rateCategoryLabel"))
      ].filter(Boolean);
      return { targetEntityType: "revenue_category_setup", result: { createdOptions, payload } };
    }
    case "finance_compliance_setup": {
      const compliance = patchComplianceSettings({
        ...input,
        patch: {
          taxRegion: payloadText(payload, "taxRegion"),
          configurationJson: {
            authorityType: payloadText(payload, "authorityType"),
            retentionRule: payloadText(payload, "retentionRule"),
            submissionMode: payloadText(payload, "submissionMode")
          }
        }
      });
      const billing = patchBillingSettings({
        ...input,
        invoiceSequence: {
          sequenceCode: payloadText(payload, "invoiceSequenceCode"),
          invoiceType: payloadText(payload, "invoiceType", "full") as InvoiceSequenceRecord["invoiceType"],
          prefix: payloadText(payload, "invoicePrefix"),
          active: true
        }
      });
      createCategoryOptionFromSetup(input, "payment_method_categories", payloadText(payload, "paymentMethodCategory"));
      return { targetEntityType: "property_compliance_settings", targetEntityId: compliance.id, result: { compliance, billing } };
    }
    case "ai_setup": {
      const settings = patchAiSettings({
        ...input,
        patch: {
          aiEnabled: payloadBoolean(payload, "aiEnabled", true),
          defaultAutomationLevel: payloadText(payload, "defaultAutomationLevel", "suggest_and_confirm") as PropertyAiSettingsRecord["defaultAutomationLevel"],
          guestFacingDisclosure: payloadText(payload, "guestFacingDisclosure"),
          voiceLocales: payloadArray(payload, "voiceLocales").map(String),
          configurationJson: {
            documentImageRetentionPolicy: payloadText(payload, "documentImageRetentionPolicy", "discard_after_ocr"),
            humanReviewDefault: payloadText(payload, "humanReviewDefault", "required_for_sensitive")
          }
        }
      });
      return { targetEntityType: "property_ai_settings", targetEntityId: settings.id, result: settings };
    }
    case "custom_field": {
      const field = createCustomField({
        ...input,
        field: {
          entityType: payloadText(payload, "entityType"),
          fieldKey: payloadText(payload, "fieldKey"),
          label: payloadText(payload, "label"),
          description: payloadText(payload, "description"),
          dataType: payloadText(payload, "dataType", "text") as PropertyCustomFieldDefinitionRecord["dataType"],
          required: payloadBoolean(payload, "required", false),
          searchable: payloadBoolean(payload, "searchable", false),
          visibleInList: payloadBoolean(payload, "visibleInList", false),
          visibleInDetail: payloadBoolean(payload, "visibleInDetail", true),
          validationJson: typeof payload.validationJson === "object" && payload.validationJson !== null ? payload.validationJson as Record<string, unknown> : {}
        }
      });
      return { targetEntityType: "property_custom_field_definition", targetEntityId: field.id, result: field };
    }
    default:
      return { targetEntityType: definition.targetEntityType, result: payload };
  }
}

export function listPropertySetupForms(propertyId: string) {
  requireProperty(propertyId);
  return {
    propertyId,
    forms: PROPERTY_SETUP_FORM_DEFINITIONS.map((definition) => {
      const step = demoStore.propertySetupSteps.find((candidate) => candidate.propertyId === propertyId && candidate.stepCode === definition.setupStepCode);
      const latestSubmission = demoStore.propertySetupFormSubmissions
        .filter((submission) => submission.propertyId === propertyId && submission.formCode === definition.code)
        .at(-1);
      return {
        ...definition,
        status: latestSubmission?.status ?? step?.status ?? "not_started",
        latestSubmission
      };
    })
  };
}

export function listManualSetupOptions(propertyId: string) {
  requireProperty(propertyId);
  const enabledModules = new Set(
    demoStore.propertyModules
      .filter((propertyModule) => propertyModule.propertyId === propertyId && propertyModule.status !== "disabled")
      .map((propertyModule) => propertyModule.moduleId)
  );
  const options = MANUAL_SETUP_OPTIONS.map((option) => {
    const submissions = demoStore.manualSetupSubmissions.filter(
      (submission) => submission.propertyId === propertyId && submission.optionCode === option.code
    );
    const latestSubmission = submissions.at(-1);
    return {
      ...option,
      setupState: latestSubmission?.status ?? "not_started",
      latestSubmission,
      moduleEnabled: !option.moduleCode || option.moduleCode === "backoffice" || enabledModules.has(option.moduleCode),
      localDemoReason:
        option.moduleCode && option.moduleCode !== "backoffice" && !enabledModules.has(option.moduleCode)
          ? `Hidden because module ${option.moduleCode} is disabled`
          : "Visible in local demo"
    };
  });

  return {
    propertyId,
    coverage: MANUAL_SETUP_COVERAGE_SUMMARY,
    setupSummary: {
      totalOptions: options.length,
      savedOptions: options.filter((option) => option.setupState === "saved").length,
      failedOptions: options.filter((option) => option.setupState === "failed").length,
      notStartedOptions: options.filter((option) => option.setupState === "not_started").length
    },
    options
  };
}

export function getManualSetupOptionDetail(propertyId: string, optionCode: string) {
  requireProperty(propertyId);
  const option = manualSetupOptionDefinition(optionCode);
  const submissions = demoStore.manualSetupSubmissions.filter(
    (submission) => submission.propertyId === propertyId && submission.optionCode === option.code
  );
  return {
    propertyId,
    option,
    latestSubmission: submissions.at(-1),
    submissions,
    databaseBinding: {
      readEndpoint: option.apiEndpoint,
      saveEndpoint: option.saveEndpoint,
      targetTables: option.targetTables,
      inputCategories: option.inputCategories
    }
  };
}

export function saveManualSetupOption(input: BackOfficeMutationInput & {
  optionCode: string;
  payload: Record<string, unknown>;
}) {
  const option = manualSetupOptionDefinition(input.optionCode);
  requireProperty(input.propertyId);
  requirePermissions(input.context, [option.permission as PermissionKey]);
  const validationErrors = validateManualSetupPayload(option, input.payload);
  const submission: ManualSetupSubmissionRecord = {
    id: createId("msetup"),
    propertyId: input.propertyId,
    optionCode: option.code,
    status: validationErrors.length > 0 ? "failed" : "saved",
    payloadJson: input.payload,
    validationErrorsJson: validationErrors,
    targetTables: option.targetTables,
    inputCategories: option.inputCategories,
    completionChecksJson: option.completionChecks.map((check) => ({ ...check })),
    createdBy: input.context.userId,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  demoStore.manualSetupSubmissions.push(submission);

  if (validationErrors.length > 0) {
    audit({
      ...input,
      action: "ManualSetupValidationFailed",
      entityType: "manual_setup_submission",
      entityId: submission.id,
      afterJson: { submission, option }
    });
    throw new Error(validationErrors.join(" "));
  }

  audit({
    ...input,
    action: "ManualSetupOptionSaved",
    entityType: "manual_setup_submission",
    entityId: submission.id,
    afterJson: { submission, option }
  });
  domain({
    ...input,
    eventType: "ManualSetupOptionSaved",
    entityType: "manual_setup_submission",
    entityId: submission.id,
    payload: { optionCode: option.code, targetTables: option.targetTables }
  });

  return {
    option,
    submission,
    databaseBinding: {
      readEndpoint: option.apiEndpoint,
      saveEndpoint: option.saveEndpoint,
      targetTables: option.targetTables,
      inputCategories: option.inputCategories
    }
  };
}

export function getPropertySetupForm(propertyId: string, formCode: string) {
  requireProperty(propertyId);
  const definition = propertySetupFormDefinition(formCode);
  return {
    ...definition,
    propertyId,
    existingData: formExistingData(propertyId, formCode),
    categoryOptions: definition.fields
      .filter((field) => field.categoryCode)
      .map((field) => ({
        fieldKey: field.key,
        categoryCode: field.categoryCode,
        options: field.categoryCode ? categoryWithOptions(propertyId, requireCategoryDefinition(field.categoryCode)).options : []
      })),
    dataQuality: configurationDataQuality(propertyId),
    submissions: demoStore.propertySetupFormSubmissions.filter(
      (submission) => submission.propertyId === propertyId && submission.formCode === formCode
    )
  };
}

export function savePropertySetupForm(input: BackOfficeMutationInput & {
  formCode: string;
  payload: Record<string, unknown>;
}) {
  const definition = propertySetupFormDefinition(input.formCode);
  requirePermissions(input.context, [definition.permission]);
  const validationErrors = validatePropertySetupPayload(definition, input.payload);
  if (validationErrors.length > 0) {
    const failed: PropertySetupFormSubmissionRecord = {
      id: createId("psfs"),
      propertyId: input.propertyId,
      formCode: definition.code,
      status: "failed",
      payloadJson: input.payload,
      validationErrorsJson: validationErrors,
      targetEntityType: definition.targetEntityType,
      createdBy: input.context.userId,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    demoStore.propertySetupFormSubmissions.push(failed);
    audit({ ...input, action: "PropertySetupFormValidationFailed", entityType: "property_setup_form_submission", entityId: failed.id, afterJson: failed });
    throw new Error(validationErrors.join(" "));
  }

  const target = applyPropertySetupForm(input, definition, input.payload);
  const submission: PropertySetupFormSubmissionRecord = {
    id: createId("psfs"),
    propertyId: input.propertyId,
    formCode: definition.code,
    status: "saved",
    payloadJson: input.payload,
    validationErrorsJson: [],
    targetEntityType: target.targetEntityType,
    targetEntityId: target.targetEntityId,
    createdBy: input.context.userId,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  demoStore.propertySetupFormSubmissions.push(submission);
  const step = completePropertySetupStep(input, definition.setupStepCode, { lastFormCode: definition.code, lastSubmissionId: submission.id });
  audit({ ...input, action: "PropertySetupFormSaved", entityType: target.targetEntityType, entityId: target.targetEntityId, afterJson: { submission, target: target.result, step } });
  domain({
    ...input,
    eventType: "PropertySetupFormSaved",
    entityType: target.targetEntityType,
    entityId: target.targetEntityId,
    payload: { formCode: definition.code, submissionId: submission.id }
  });
  return {
    form: definition,
    submission,
    target,
    setupStep: step
  };
}

function upsertReadinessCheck(
  propertyId: string,
  check: Omit<PropertyReadinessCheckRecord, "id" | "propertyId" | "createdAt" | "updatedAt">
): PropertyReadinessCheckRecord {
  const existing = demoStore.propertyReadinessChecks.find(
    (candidate) => candidate.propertyId === propertyId && candidate.checkCode === check.checkCode
  );
  const timestamp = nowIso();
  if (existing) {
    Object.assign(existing, check, { updatedAt: timestamp });
    return existing;
  }

  const record: PropertyReadinessCheckRecord = {
    id: createId("ready"),
    propertyId,
    ...check,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  demoStore.propertyReadinessChecks.push(record);
  return record;
}

export function getBackOfficeDashboard(propertyId: string) {
  requireProperty(propertyId);
  const setup = getSetupProgress(propertyId);
  const readiness = getReadiness(propertyId);
  const modules = listBackOfficeModules(propertyId);
  const integrationErrors = demoStore.integrationConnections.filter(
    (connection) => connection.propertyId === propertyId && connection.status === "error"
  );
  const failedIntegrationEvents = demoStore.integrationEvents.filter((event) => event.status === "failed");
  const rooms = demoStore.rooms.filter((room) => room.propertyId === propertyId);
  const mappedRooms = rooms.filter((room) => room.buildingId || room.floorId || room.zoneId);
  const paymentProviderConnected = demoStore.integrationConnections.some((connection) => {
    const provider = demoStore.integrationProviders.find((candidate) => candidate.id === connection.providerId);
    return connection.propertyId === propertyId && connection.status === "connected" && provider?.code.includes("payments");
  });
  const blockingIssues = readiness.checks.filter((check) => check.severity === "blocking" && check.status !== "pass");

  return {
    propertyId,
    setupProgress: setup.progressPercent,
    goLiveReadiness: readiness.status,
    blockingIssues,
    activeModules: modules.filter((module) => module.status === "enabled").length,
    modulesNeedingConfiguration: modules.filter((module) => module.healthStatus !== "ok"),
    integrationErrors: integrationErrors.length + failedIntegrationEvents.length,
    complianceWarnings: readiness.checks.filter((check) => check.severity !== "info").length,
    usersPendingInvitation: demoStore.users.filter((user) => user.status === "invited").length,
    roomsMapped: mappedRooms.length,
    roomTypesConfigured: demoStore.roomTypes.filter((roomType) => roomType.propertyId === propertyId && roomType.active !== false).length,
    invoiceSequenceStatus: demoStore.invoiceSequences.some((sequence) => sequence.propertyId === propertyId && sequence.active)
      ? "configured"
      : "missing",
    paymentProviderStatus: paymentProviderConnected ? "connected" : "missing",
    aiStatus: demoStore.propertyAiSettings.find((settings) => settings.propertyId === propertyId)?.aiEnabled ? "enabled" : "disabled",
    recommendedNextAction: blockingIssues[0]?.message ?? "Review go-live checklist.",
    recentAuditEvents: demoStore.auditEvents.slice(-8).reverse()
  };
}

export function getConfigurationCenter(propertyId: string) {
  requireProperty(propertyId);
  return {
    propertyId,
    title: "Configuration Center",
    description: "Manage categories, custom fields, room types, spaces, departments, revenue segments, housekeeping rules and maintenance categories.",
    categoryGroups: Array.from(new Set(categoryDefinitions.map((definition) => definition.categoryGroup))),
    categoryCount: categoryDefinitions.length,
    optionCount: propertyCategoryOptions.filter((option) => option.propertyId === propertyId).length,
    customFieldCount: customFieldDefinitions.filter((field) => field.propertyId === propertyId && field.active).length,
    setupForms: [
      "PropertyProfileForm",
      "BuildingForm",
      "FloorForm",
      "ZoneForm",
      "RoomTypeForm",
      "RoomForm",
      "SpaceResourceForm",
      "DepartmentForm",
      "HousekeepingSetupForms",
      "MaintenanceSetupForms",
      "RevenueCategoryForms",
      "ComplianceCategoryForms"
    ],
    dataQuality: configurationDataQuality(propertyId),
    primaryActions: ["Open Category Manager", "Open Custom Fields", "Apply template", "Import categories", "Ask AI Setup Assistant"]
  };
}

export function listConfigurationCategories(propertyId: string) {
  requirePermissions(demoStore.userContext, ["categories.read"]);
  requireProperty(propertyId);
  return {
    propertyId,
    groups: Array.from(new Set(categoryDefinitions.map((definition) => definition.categoryGroup))).map((group) => ({
      group,
      categories: categoryDefinitions
        .filter((definition) => definition.categoryGroup === group)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((definition) => categoryWithOptions(propertyId, definition))
    }))
  };
}

export function getConfigurationCategory(propertyId: string, categoryCode: string) {
  requirePermissions(demoStore.userContext, ["categories.read"]);
  requireProperty(propertyId);
  return categoryWithOptions(propertyId, requireCategoryDefinition(categoryCode));
}

export function createCategoryOption(input: BackOfficeMutationInput & {
  categoryCode: string;
  option: Pick<PropertyCategoryOptionRecord, "code" | "label"> & Partial<PropertyCategoryOptionRecord>;
}) {
  requirePermissions(input.context, ["categories.manage"]);
  const definition = requireCategoryDefinition(input.categoryCode);
  assertCategoryModeAllowsEdit(definition);
  if (definition.mode === "system_controlled" && !input.option.isSystemDefault) {
    throw new Error("System-controlled legal categories can only be extended through controlled defaults.");
  }
  if (propertyCategoryOptions.some((option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id && option.code === input.option.code)) {
    throw new Error("Category option code must be unique per property and category.");
  }
  const record: PropertyCategoryOptionRecord = {
    id: createId("catopt"),
    propertyId: input.propertyId,
    categoryDefinitionId: definition.id,
    code: input.option.code,
    label: input.option.label,
    description: input.option.description,
    colorToken: input.option.colorToken,
    iconName: input.option.iconName,
    parentOptionId: input.option.parentOptionId,
    metadataJson: input.option.metadataJson ?? {},
    isSystemDefault: input.option.isSystemDefault ?? false,
    active: input.option.active ?? true,
    sortOrder: input.option.sortOrder ?? propertyCategoryOptions.length + 1,
    createdBy: input.context.userId,
    updatedBy: input.context.userId,
    usageCount: 0
  };
  propertyCategoryOptions.push(record);
  audit({ ...input, action: "CategoryOptionCreated", entityType: "property_category_option", entityId: record.id, afterJson: record });
  return record;
}

export function patchCategoryOption(input: BackOfficeMutationInput & {
  optionId: string;
  patch: Partial<PropertyCategoryOptionRecord>;
}) {
  requirePermissions(input.context, ["categories.manage"]);
  const option = requireCategoryOption(input.propertyId, input.optionId);
  const definition = categoryDefinitions.find((candidate) => candidate.id === option.categoryDefinitionId)!;
  assertCategoryModeAllowsEdit(definition, input.patch as Record<string, unknown>);
  const before = { ...option };
  Object.assign(option, input.patch, { updatedBy: input.context.userId });
  audit({ ...input, action: "CategoryOptionUpdated", entityType: "property_category_option", entityId: option.id, beforeJson: before, afterJson: option });
  return option;
}

export function setCategoryOptionActive(input: BackOfficeMutationInput & { optionId: string; active: boolean }) {
  requirePermissions(input.context, ["categories.manage"]);
  const option = requireCategoryOption(input.propertyId, input.optionId);
  const before = { ...option };
  option.active = input.active;
  option.updatedBy = input.context.userId;
  audit({
    ...input,
    action: input.active ? "CategoryOptionReactivated" : "CategoryOptionDeactivated",
    entityType: "property_category_option",
    entityId: option.id,
    beforeJson: before,
    afterJson: { ...option, linkedRecordsRemainVisible: categoryOptionUsage(option.id) > 0 }
  });
  return option;
}

export function reorderCategoryOptions(input: BackOfficeMutationInput & { categoryCode: string; optionIds: string[] }) {
  requirePermissions(input.context, ["categories.manage"]);
  const definition = requireCategoryDefinition(input.categoryCode);
  assertCategoryModeAllowsEdit(definition);
  input.optionIds.forEach((optionId, index) => {
    const option = requireCategoryOption(input.propertyId, optionId);
    if (option.categoryDefinitionId !== definition.id) {
      throw new Error("Cannot reorder options outside the selected category.");
    }
    option.sortOrder = index + 1;
    option.updatedBy = input.context.userId;
  });
  const options = propertyCategoryOptions.filter((option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id);
  audit({ ...input, action: "CategoryOptionsReordered", entityType: "category_definition", entityId: definition.id, afterJson: { optionIds: input.optionIds } });
  return { status: "reordered" as const, options };
}

export function listCustomFields(propertyId: string) {
  requirePermissions(demoStore.userContext, ["custom_fields.read"]);
  requireProperty(propertyId);
  return { items: customFieldDefinitions.filter((field) => field.propertyId === propertyId) };
}

export function createCustomField(input: BackOfficeMutationInput & {
  field: Pick<PropertyCustomFieldDefinitionRecord, "entityType" | "fieldKey" | "label" | "dataType"> & Partial<PropertyCustomFieldDefinitionRecord>;
}) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  if (customFieldDefinitions.some((field) => field.propertyId === input.propertyId && field.entityType === input.field.entityType && field.fieldKey === input.field.fieldKey)) {
    throw new Error("Custom field key must be unique per property and entity type.");
  }
  const record: PropertyCustomFieldDefinitionRecord = {
    id: createId("cf"),
    propertyId: input.propertyId,
    entityType: input.field.entityType,
    fieldKey: input.field.fieldKey,
    label: input.field.label,
    description: input.field.description,
    dataType: input.field.dataType,
    required: input.field.required ?? false,
    searchable: input.field.searchable ?? false,
    visibleInList: input.field.visibleInList ?? false,
    visibleInDetail: input.field.visibleInDetail ?? true,
    optionsCategoryDefinitionId: input.field.optionsCategoryDefinitionId,
    validationJson: input.field.validationJson ?? {},
    visibilityRulesJson: input.field.visibilityRulesJson ?? {},
    defaultValueJson: input.field.defaultValueJson ?? {},
    active: input.field.active ?? true,
    sortOrder: input.field.sortOrder ?? customFieldDefinitions.length + 1
  };
  customFieldDefinitions.push(record);
  audit({ ...input, action: "CustomFieldCreated", entityType: "property_custom_field_definition", entityId: record.id, afterJson: record });
  return record;
}

export function patchCustomField(input: BackOfficeMutationInput & { fieldId: string; patch: Partial<PropertyCustomFieldDefinitionRecord> }) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  const field = customFieldDefinitions.find((candidate) => candidate.id === input.fieldId && candidate.propertyId === input.propertyId);
  if (!field) throw new Error("Custom field was not found.");
  const before = { ...field };
  Object.assign(field, input.patch);
  audit({ ...input, action: input.patch.active === false ? "CustomFieldDeactivated" : "CustomFieldUpdated", entityType: "property_custom_field_definition", entityId: field.id, beforeJson: before, afterJson: field });
  return field;
}

export function getEntityCustomFields(propertyId: string, entityType: string, entityId: string) {
  requirePermissions(demoStore.userContext, ["custom_fields.read"]);
  return {
    definitions: customFieldDefinitions.filter((field) => field.propertyId === propertyId && field.entityType === entityType && field.active),
    values: customFieldValues.filter((value) => value.propertyId === propertyId && value.entityType === entityType && value.entityId === entityId)
  };
}

export function patchEntityCustomFields(input: BackOfficeMutationInput & {
  entityType: string;
  entityId: string;
  values: Array<{ fieldDefinitionId: string; valueJson: Record<string, unknown> }>;
}) {
  requirePermissions(input.context, ["custom_fields.manage"]);
  const updated = input.values.map((value) => {
    let record = customFieldValues.find((candidate) => candidate.entityType === input.entityType && candidate.entityId === input.entityId && candidate.fieldDefinitionId === value.fieldDefinitionId);
    if (!record) {
      record = { id: createId("cfv"), propertyId: input.propertyId, entityType: input.entityType, entityId: input.entityId, fieldDefinitionId: value.fieldDefinitionId, valueJson: value.valueJson };
      customFieldValues.push(record);
    } else {
      record.valueJson = value.valueJson;
    }
    return record;
  });
  audit({ ...input, action: "CustomFieldUpdated", entityType: input.entityType, entityId: input.entityId, afterJson: updated });
  return { status: "updated" as const, values: updated };
}

export function seedDefaultCategories(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["categories.manage"]);
  const created = categoryDefinitions
    .filter((definition) => !propertyCategoryOptions.some((option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id))
    .map((definition) =>
      createCategoryOption({
        ...input,
        categoryCode: definition.code,
        option: { code: "default", label: "Default", isSystemDefault: true, metadataJson: { seededFromDefinition: definition.code } }
      })
    );
  return { status: "seeded" as const, createdCount: created.length, created };
}

export function previewCategoryImport(input: BackOfficeMutationInput & { rows: Array<Record<string, unknown>> }) {
  requirePermissions(input.context, ["categories.import"]);
  const requiredColumns = ["category_code", "option_code", "label"];
  const errors: string[] = [];
  const create = input.rows.filter((row) => {
    for (const column of requiredColumns) {
      if (!row[column]) errors.push(`Missing ${column}`);
    }
    const definition = categoryDefinitions.find((candidate) => candidate.code === row.category_code);
    return Boolean(definition && !propertyCategoryOptions.some((option) => option.propertyId === input.propertyId && option.categoryDefinitionId === definition.id && option.code === row.option_code));
  }).length;
  const update = input.rows.length - create;
  const preview = { status: errors.length ? "blocked" : "ready", create, update, skip: errors.length, errors, requiredColumns };
  audit({ ...input, action: "CategoryImportPreviewed", entityType: "category_import", afterJson: preview });
  return preview;
}

export function applyCategoryImport(input: BackOfficeMutationInput & { rows: Array<Record<string, unknown>>; confirmationProvided?: boolean }) {
  requirePermissions(input.context, ["categories.import"]);
  if (!input.confirmationProvided) {
    return { status: "confirmation_required" as const, message: "Category import requires preview and confirmation before apply." };
  }
  const created = input.rows.map((row) =>
    createCategoryOption({
      ...input,
      categoryCode: String(row.category_code),
      option: {
        code: String(row.option_code),
        label: String(row.label),
        description: row.description ? String(row.description) : undefined,
        parentOptionId: row.parent_option_code ? String(row.parent_option_code) : undefined,
        colorToken: row.color_token ? String(row.color_token) : undefined,
        iconName: row.icon_name ? String(row.icon_name) : undefined,
        active: row.active !== false,
        sortOrder: row.sort_order ? Number(row.sort_order) : undefined
      }
    })
  );
  audit({ ...input, action: "CategoryImportApplied", entityType: "category_import", afterJson: { createdCount: created.length } });
  return { status: "applied" as const, createdCount: created.length, created };
}

export function exportCategories(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["categories.export"]);
  const rows = propertyCategoryOptions
    .filter((option) => option.propertyId === input.propertyId)
    .map((option) => ({
      category_code: categoryDefinitions.find((definition) => definition.id === option.categoryDefinitionId)?.code,
      option_code: option.code,
      label: option.label,
      description: option.description,
      parent_option_code: option.parentOptionId,
      color_token: option.colorToken,
      icon_name: option.iconName,
      active: option.active,
      sort_order: option.sortOrder
    }));
  audit({ ...input, action: "CategoryExported", entityType: "category_export", afterJson: { rowCount: rows.length } });
  return { format: "json", rows };
}

export function listCategoryTemplates() {
  requirePermissions(demoStore.userContext, ["categories.read"]);
  return { items: categoryTemplates };
}

export function previewCategoryTemplate(input: BackOfficeMutationInput & { templateCode: string }) {
  requirePermissions(input.context, ["categories.manage"]);
  const template = categoryTemplates.find((candidate) => candidate.code === input.templateCode);
  if (!template) throw new Error("Category template was not found.");
  const preview = {
    template,
    willCreate: template.creates,
    willUpdate: [],
    willSkip: template.creates.filter((label) =>
      propertyCategoryOptions.some((option) => option.propertyId === input.propertyId && option.label.toLowerCase() === label.toLowerCase())
    ),
    requiresConfirmation: true
  };
  audit({ ...input, action: "CategoryTemplatePreviewed", entityType: "category_template", entityId: template.code, afterJson: preview });
  return preview;
}

export function applyCategoryTemplate(input: BackOfficeMutationInput & { templateCode: string; confirmationProvided?: boolean }) {
  requirePermissions(input.context, ["categories.manage"]);
  if (!input.confirmationProvided) {
    return { status: "confirmation_required" as const, message: "Category template application requires preview and confirmation." };
  }
  const preview = previewCategoryTemplate(input);
  audit({ ...input, action: "CategoryTemplateApplied", entityType: "category_template", entityId: input.templateCode, afterJson: preview });
  return { status: "applied" as const, created: preview.willCreate, skipped: preview.willSkip };
}

export function suggestPropertyCategories(input: BackOfficeMutationInput & { prompt: string }) {
  requirePermissions(input.context, ["ai_category_setup.use"]);
  const suggestions = {
    prompt: input.prompt,
    confidence: 0.92,
    requiresReview: true,
    requiresConfirmation: true,
    willCreate: [
      { categoryCode: "room_features", label: "Sea view", code: "sea_view" },
      { categoryCode: "room_features", label: "Balcony", code: "balcony" },
      { categoryCode: "maintenance_issue_types", label: "HVAC", code: "hvac" },
      { categoryCode: "market_segments", label: "Leisure", code: "leisure" },
      { categoryCode: "pos_product_categories", label: "Minibar", code: "minibar" }
    ],
    rules: {
      aiCannotApplyWithoutConfirmation: true,
      systemControlledLegalCategoriesRequireReview: true,
      auditEventsOnApply: ["AIPropertyCategoriesSuggested", "AIPropertyCategoriesApplied"]
    }
  };
  audit({ ...input, action: "AIPropertyCategoriesSuggested", entityType: "category_ai_suggestion", afterJson: suggestions });
  return suggestions;
}

export function getSetupProgress(propertyId: string) {
  requireProperty(propertyId);
  const steps = SETUP_STEPS.map((stepCode) => {
    const existing = demoStore.propertySetupSteps.find((step) => step.propertyId === propertyId && step.stepCode === stepCode);
    return (
      existing ?? {
        id: `virtual_${stepCode}`,
        propertyId,
        stepCode,
        status: "not_started",
        metadataJson: {}
      }
    );
  }) as PropertySetupStepRecord[];
  const completed = steps.filter((step) => step.status === "completed").length;
  return {
    propertyId,
    steps,
    completed,
    total: steps.length,
    progressPercent: Math.round((completed / steps.length) * 100)
  };
}

export function updateSetupStep(input: BackOfficeMutationInput & {
  stepCode: string;
  status: PropertySetupStepRecord["status"];
  metadataJson?: Record<string, unknown>;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const existing = demoStore.propertySetupSteps.find(
    (step) => step.propertyId === input.propertyId && step.stepCode === input.stepCode
  );
  const before = existing ? { ...existing } : undefined;
  const completedAt = input.status === "completed" ? nowIso() : existing?.completedAt;
  const record =
    existing ??
    ({
      id: createId("setup"),
      propertyId: input.propertyId,
      stepCode: input.stepCode,
      status: input.status,
      metadataJson: {}
    } as PropertySetupStepRecord);

  record.status = input.status;
  record.completedAt = completedAt;
  record.completedBy = input.status === "completed" ? input.context.userId : record.completedBy;
  record.metadataJson = input.metadataJson ?? record.metadataJson;
  if (!existing) {
    demoStore.propertySetupSteps.push(record);
  }

  audit({ ...input, action: "PropertySetupStepUpdated", entityType: "property_setup_step", entityId: record.id, beforeJson: before, afterJson: record });
  return record;
}

export function getReadiness(propertyId: string) {
  requireProperty(propertyId);
  const checks = demoStore.propertyReadinessChecks.filter((check) => check.propertyId === propertyId);
  const blocking = checks.filter((check) => check.severity === "blocking" && check.status !== "pass");
  return {
    propertyId,
    status: blocking.length === 0 ? "ready" : "blocked",
    blockingCount: blocking.length,
    checks
  };
}

export function recalculateReadiness(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["property.configure"]);
  const property = requireProperty(input.propertyId);
  const modules = enabledModuleCodes(input.propertyId);
  const roomTypes = demoStore.roomTypes.filter((roomType) => roomType.propertyId === input.propertyId && roomType.active !== false);
  const activeSellableRooms = demoStore.rooms.filter(
    (room) => room.propertyId === input.propertyId && room.active !== false && room.sellable && room.roomTypeId
  );
  const complianceSettings = demoStore.propertyComplianceSettings.find((settings) => settings.propertyId === input.propertyId);
  const hasAdminUser = demoStore.users.some((user) => user.organizationId === property.organizationId && user.status === "active");
  const hasInvoiceSequence = demoStore.invoiceSequences.some((sequence) => sequence.propertyId === input.propertyId && sequence.active);
  const paymentProviderConnected = demoStore.integrationConnections.some((connection) => {
    const provider = demoStore.integrationProviders.find((candidate) => candidate.id === connection.providerId);
    return connection.propertyId === input.propertyId && connection.status === "connected" && provider?.code.includes("payments");
  });

  const checks = [
    {
      checkCode: "legal_profile_complete",
      status: property.legalName && property.taxRegion && property.timezone ? "pass" : "fail",
      severity: "blocking",
      message: "Property legal name, tax ID, address and timezone must be configured."
    },
    {
      checkCode: "default_building_exists",
      status: demoStore.buildings.some((building) => building.propertyId === input.propertyId && building.active) ? "pass" : "fail",
      severity: "blocking",
      message: "At least one building or default building is required."
    },
    {
      checkCode: "room_type_exists",
      status: roomTypes.length > 0 ? "pass" : "fail",
      severity: "blocking",
      message: "At least one active room type is required."
    },
    {
      checkCode: "sellable_room_exists",
      status: activeSellableRooms.length > 0 ? "pass" : "fail",
      severity: "blocking",
      message: "At least one active sellable room with a room type is required."
    },
    {
      checkCode: "admin_user_exists",
      status: hasAdminUser ? "pass" : "fail",
      severity: "blocking",
      message: "At least one active admin or manager user is required."
    },
    {
      checkCode: "invoice_sequence_configured",
      status: !modules.includes("compliance_billing") || hasInvoiceSequence ? "pass" : "fail",
      severity: "blocking",
      message: "Invoice sequence is required when Compliance Billing is enabled."
    },
    {
      checkCode: "payment_provider_connected",
      status: !modules.includes("payment_vault") || paymentProviderConnected ? "pass" : "fail",
      severity: "blocking",
      message: "Payment provider is required when Payment Vault is enabled."
    },
    {
      checkCode: "ses_hospedajes_credentials",
      status:
        !complianceSettings?.sesHospedajesEnabled || complianceSettings.configurationJson.sesCredentialsConfigured === true
          ? "pass"
          : "fail",
      severity: "blocking",
      message: "SES.HOSPEDAJES configuration must be completed when Spain compliance is enabled."
    }
  ] as const;

  const records = checks.map((check) => upsertReadinessCheck(input.propertyId, check));
  audit({ ...input, action: "PropertyReadinessRecalculated", entityType: "property", entityId: input.propertyId, afterJson: records });
  return getReadiness(input.propertyId);
}

export function approveGoLive(input: BackOfficeMutationInput) {
  requirePermissions(input.context, ["property.go_live"]);
  const readiness = getReadiness(input.propertyId);
  if (readiness.blockingCount > 0) {
    return {
      status: "blocked" as const,
      blockers: readiness.checks.filter((check) => check.severity === "blocking" && check.status !== "pass")
    };
  }

  audit({ ...input, action: "PropertyGoLiveApproved", entityType: "property", entityId: input.propertyId });
  domain({ ...input, eventType: "PropertyGoLiveApproved", entityType: "property", entityId: input.propertyId });
  return { status: "approved" as const, propertyId: input.propertyId, approvedAt: nowIso() };
}

export function getPropertyMap(propertyId: string) {
  requireProperty(propertyId);
  const rooms = demoStore.rooms.filter((room) => room.propertyId === propertyId);
  return {
    property: demoStore.properties.find((property) => property.id === propertyId),
    buildings: demoStore.buildings.filter((building) => building.propertyId === propertyId),
    floors: demoStore.floors.filter((floor) => floor.propertyId === propertyId),
    zones: demoStore.propertyZones.filter((zone) => zone.propertyId === propertyId),
    spaces: demoStore.propertySpaces.filter((space) => space.propertyId === propertyId),
    rooms,
    assets: demoStore.assets.filter((asset) => asset.propertyId === propertyId),
    mapPositions: demoStore.propertyMapPositions.filter((position) => position.propertyId === propertyId),
    tree: demoStore.buildings
      .filter((building) => building.propertyId === propertyId)
      .map((building) => ({
        ...building,
        floors: demoStore.floors
          .filter((floor) => floor.buildingId === building.id)
          .map((floor) => ({
            ...floor,
            zones: demoStore.propertyZones
              .filter((zone) => zone.floorId === floor.id)
              .map((zone) => ({
                ...zone,
                rooms: rooms.filter((room) => room.zoneId === zone.id),
                spaces: demoStore.propertySpaces.filter((space) => space.zoneId === zone.id)
              }))
          }))
      }))
  };
}

export function createBuilding(input: BackOfficeMutationInput & {
  building: Pick<BuildingRecord, "name"> & Partial<BuildingRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const timestamp = nowIso();
  const record: BuildingRecord = {
    id: createId("bld"),
    propertyId: input.propertyId,
    name: input.building.name,
    code: input.building.code,
    description: input.building.description,
    sortOrder: input.building.sortOrder ?? demoStore.buildings.length + 1,
    active: input.building.active ?? true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  demoStore.buildings.push(record);
  audit({ ...input, action: "BuildingCreated", entityType: "building", entityId: record.id, afterJson: record });
  return record;
}

export function createFloor(input: BackOfficeMutationInput & {
  floor: Pick<FloorRecord, "name"> & Partial<FloorRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const timestamp = nowIso();
  const record: FloorRecord = {
    id: createId("floor"),
    propertyId: input.propertyId,
    buildingId: input.floor.buildingId,
    name: input.floor.name,
    floorNumber: input.floor.floorNumber,
    code: input.floor.code,
    sortOrder: input.floor.sortOrder ?? input.floor.floorNumber ?? demoStore.floors.length + 1,
    active: input.floor.active ?? true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  demoStore.floors.push(record);
  audit({ ...input, action: "FloorCreated", entityType: "floor", entityId: record.id, afterJson: record });
  return record;
}

export function createZone(input: BackOfficeMutationInput & {
  zone: Pick<PropertyZoneRecord, "name" | "zoneType"> & Partial<PropertyZoneRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const timestamp = nowIso();
  const record: PropertyZoneRecord = {
    id: createId("zone"),
    propertyId: input.propertyId,
    buildingId: input.zone.buildingId,
    floorId: input.zone.floorId,
    name: input.zone.name,
    code: input.zone.code,
    zoneType: input.zone.zoneType,
    description: input.zone.description,
    sortOrder: input.zone.sortOrder ?? demoStore.propertyZones.length + 1,
    active: input.zone.active ?? true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  demoStore.propertyZones.push(record);
  audit({ ...input, action: "ZoneCreated", entityType: "property_zone", entityId: record.id, afterJson: record });
  return record;
}

export function createSpace(input: BackOfficeMutationInput & {
  space: Pick<PropertySpaceRecord, "name" | "spaceType"> & Partial<PropertySpaceRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const timestamp = nowIso();
  const record: PropertySpaceRecord = {
    id: createId("space"),
    propertyId: input.propertyId,
    buildingId: input.space.buildingId,
    floorId: input.space.floorId,
    zoneId: input.space.zoneId,
    name: input.space.name,
    code: input.space.code,
    spaceType: input.space.spaceType,
    description: input.space.description,
    active: input.space.active ?? true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  demoStore.propertySpaces.push(record);
  audit({ ...input, action: "SpaceCreated", entityType: "property_space", entityId: record.id, afterJson: record });
  return record;
}

export function upsertMapPosition(input: BackOfficeMutationInput & {
  position: Pick<PropertyMapPositionRecord, "entityType" | "entityId" | "x" | "y"> & Partial<PropertyMapPositionRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  let position = demoStore.propertyMapPositions.find(
    (candidate) =>
      candidate.propertyId === input.propertyId &&
      candidate.entityType === input.position.entityType &&
      candidate.entityId === input.position.entityId &&
      candidate.floorId === input.position.floorId
  );
  const before = position ? { ...position } : undefined;
  if (!position) {
    position = {
      id: createId("pos"),
      propertyId: input.propertyId,
      entityType: input.position.entityType,
      entityId: input.position.entityId,
      floorId: input.position.floorId,
      x: input.position.x,
      y: input.position.y,
      width: input.position.width,
      height: input.position.height,
      rotation: input.position.rotation,
      metadataJson: input.position.metadataJson ?? {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    demoStore.propertyMapPositions.push(position);
  } else {
    Object.assign(position, input.position, { updatedAt: nowIso() });
  }

  audit({
    ...input,
    action: before ? "PropertyMapPositionUpdated" : "PropertyMapPositionCreated",
    entityType: "property_map_position",
    entityId: position.id,
    beforeJson: before,
    afterJson: position
  });
  return position;
}

function roomNumberFromRange(start: string, offset: number): string {
  const startNumber = Number(start);
  if (Number.isNaN(startNumber)) {
    throw new Error("roomRangeStart must be numeric for range creation.");
  }
  return String(startNumber + offset);
}

export function bulkCreateRooms(input: BackOfficeMutationInput & {
  roomTypeId: string;
  roomRangeStart?: string;
  roomRangeEnd?: string;
  roomNumbers?: string[];
  buildingId?: string;
  floorId?: string;
  zoneId?: string;
  sellable?: boolean;
  active?: boolean;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const sellable = input.sellable ?? true;
  if (sellable && !input.roomTypeId) {
    throw new Error("Sellable rooms must have a room type.");
  }

  const roomNumbers =
    input.roomNumbers ??
    (input.roomRangeStart && input.roomRangeEnd
      ? Array.from({ length: Number(input.roomRangeEnd) - Number(input.roomRangeStart) + 1 }, (_, index) =>
          roomNumberFromRange(input.roomRangeStart!, index)
        )
      : []);

  if (roomNumbers.length === 0) {
    throw new Error("At least one room number is required.");
  }

  const duplicates = roomNumbers.filter((roomNumber) =>
    demoStore.rooms.some((room) => room.propertyId === input.propertyId && room.number === roomNumber)
  );
  if (duplicates.length > 0) {
    throw new Error(`Room number must be unique per property: ${duplicates.join(", ")}`);
  }

  const created = roomNumbers.map((number) => {
    const record: RoomRecord = {
      id: createId("room"),
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId,
      buildingId: input.buildingId,
      floorId: input.floorId,
      zoneId: input.zoneId,
      number,
      floor: demoStore.floors.find((floor) => floor.id === input.floorId)?.name ?? "",
      roomCode: `RM${number}`,
      displayName: `Room ${number}`,
      status: "clean",
      housekeepingStatus: "clean",
      maintenanceStatus: "ok",
      sellable,
      active: input.active ?? true,
      sortOrder: Number(number) || demoStore.rooms.length + 1
    };
    demoStore.rooms.push(record);
    return record;
  });

  audit({ ...input, action: "RoomBulkCreated", entityType: "room", afterJson: { createdCount: created.length, rooms: created } });
  return { status: "created" as const, createdCount: created.length, rooms: created };
}

export function bulkUpdateRooms(input: BackOfficeMutationInput & {
  roomIds: string[];
  patch: Partial<Pick<RoomRecord, "roomTypeId" | "buildingId" | "floorId" | "zoneId" | "sellable" | "active" | "featuresJson" | "bedConfigurationJson" | "housekeepingStatus" | "maintenanceStatus">>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const rooms = demoStore.rooms.filter((room) => room.propertyId === input.propertyId && input.roomIds.includes(room.id));
  if (rooms.length !== input.roomIds.length) {
    throw new Error("All selected rooms must belong to the property.");
  }
  if (input.patch.sellable === true && !input.patch.roomTypeId && rooms.some((room) => !room.roomTypeId)) {
    throw new Error("Room cannot be marked sellable if no room type is assigned.");
  }
  if (input.patch.buildingId) {
    const building = demoStore.buildings.find((candidate) => candidate.id === input.patch.buildingId && candidate.propertyId === input.propertyId);
    if (!building?.active) {
      throw new Error("Room cannot be assigned to disabled floor/building.");
    }
  }
  if (input.patch.floorId) {
    const floor = demoStore.floors.find((candidate) => candidate.id === input.patch.floorId && candidate.propertyId === input.propertyId);
    if (!floor?.active) {
      throw new Error("Room cannot be assigned to disabled floor/building.");
    }
  }

  const before = rooms.map((room) => ({ ...room }));
  for (const room of rooms) {
    Object.assign(room, input.patch);
  }

  audit({
    ...input,
    action: "RoomBulkUpdated",
    entityType: "room",
    beforeJson: before,
    afterJson: rooms
  });
  return { status: "updated" as const, updatedCount: rooms.length, rooms };
}

export function exportPropertyMap(propertyId: string) {
  return demoStore.rooms
    .filter((room) => room.propertyId === propertyId)
    .map((room) => ({
      building: demoStore.buildings.find((building) => building.id === room.buildingId)?.name,
      floor: demoStore.floors.find((floor) => floor.id === room.floorId)?.name ?? room.floor,
      zone: demoStore.propertyZones.find((zone) => zone.id === room.zoneId)?.name,
      room_number: room.number,
      room_type: demoStore.roomTypes.find((roomType) => roomType.id === room.roomTypeId)?.code,
      max_occupancy: room.maxOccupancy,
      standard_occupancy: room.standardOccupancy,
      beds: room.bedConfigurationJson,
      features: room.featuresJson,
      sellable: room.sellable,
      active: room.active !== false,
      housekeeping_status: room.housekeepingStatus,
      maintenance_status: room.maintenanceStatus,
      square_meters: room.squareMeters,
      view_type: room.viewType,
      accessibility: room.accessibilityJson
    }));
}

export function listBackOfficeRoomTypes(propertyId: string) {
  return demoStore.roomTypes
    .filter((roomType) => roomType.propertyId === propertyId)
    .map((roomType) => ({
      ...roomType,
      linkedRoomCount: demoStore.rooms.filter((room) => room.roomTypeId === roomType.id).length,
      futureReservationCount: demoStore.reservations.filter((reservation) => reservation.roomTypeId === roomType.id && reservation.status !== "cancelled").length
    }));
}

export function createBackOfficeRoomType(input: BackOfficeMutationInput & {
  roomType: Pick<RoomTypeRecord, "name" | "code" | "maxOccupancy" | "baseCapacity"> & Partial<RoomTypeRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  if (demoStore.roomTypes.some((roomType) => roomType.propertyId === input.propertyId && roomType.code === input.roomType.code)) {
    throw new Error("Room type code must be unique per property.");
  }
  const record: RoomTypeRecord = {
    id: createId("rt"),
    propertyId: input.propertyId,
    name: input.roomType.name,
    code: input.roomType.code,
    maxOccupancy: input.roomType.maxOccupancy,
    baseCapacity: input.roomType.baseCapacity,
    description: input.roomType.description,
    defaultBedConfigurationJson: input.roomType.defaultBedConfigurationJson ?? {},
    defaultAmenitiesJson: input.roomType.defaultAmenitiesJson ?? {},
    defaultPhotosJson: input.roomType.defaultPhotosJson ?? {},
    defaultRateCategory: input.roomType.defaultRateCategory,
    sellable: input.roomType.sellable ?? true,
    displayOrder: input.roomType.displayOrder ?? demoStore.roomTypes.length + 1,
    active: input.roomType.active ?? true
  };
  demoStore.roomTypes.push(record);
  audit({ ...input, action: "RoomTypeCreated", entityType: "room_type", entityId: record.id, afterJson: record });
  return record;
}

function requireRoomType(roomTypeId: string): RoomTypeRecord {
  const roomType = demoStore.roomTypes.find((candidate) => candidate.id === roomTypeId);
  if (!roomType) {
    throw new Error("Room type was not found.");
  }
  return roomType;
}

export function patchBackOfficeRoomType(input: BackOfficeMutationInput & {
  roomTypeId: string;
  patch: Partial<RoomTypeRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const roomType = requireRoomType(input.roomTypeId);
  if (roomType.propertyId !== input.propertyId) {
    throw new Error("Room type does not belong to the property.");
  }
  if (input.patch.maxOccupancy !== undefined) {
    const conflictingReservation = demoStore.reservations.find(
      (reservation) =>
        reservation.propertyId === input.propertyId &&
        reservation.roomTypeId === input.roomTypeId &&
        reservation.status !== "cancelled" &&
        reservation.adults + reservation.children > input.patch.maxOccupancy!
    );
    if (conflictingReservation) {
      throw new Error("Changing max occupancy must validate future reservations.");
    }
  }
  const before = { ...roomType };
  Object.assign(roomType, input.patch);
  audit({ ...input, action: "RoomTypeUpdated", entityType: "room_type", entityId: roomType.id, beforeJson: before, afterJson: roomType });
  return roomType;
}

export function deactivateBackOfficeRoomType(input: BackOfficeMutationInput & { roomTypeId: string }) {
  requirePermissions(input.context, ["property.map.manage"]);
  const roomType = requireRoomType(input.roomTypeId);
  const before = { ...roomType };
  roomType.active = false;
  audit({ ...input, action: "RoomTypeDeactivated", entityType: "room_type", entityId: roomType.id, beforeJson: before, afterJson: roomType });
  return roomType;
}

export function mergeBackOfficeRoomTypes(input: BackOfficeMutationInput & {
  sourceRoomTypeId: string;
  targetRoomTypeId: string;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const source = requireRoomType(input.sourceRoomTypeId);
  const target = requireRoomType(input.targetRoomTypeId);
  if (source.propertyId !== input.propertyId || target.propertyId !== input.propertyId) {
    throw new Error("Both room types must belong to the property.");
  }
  if (source.id === target.id) {
    throw new Error("Source and target room types must be different.");
  }
  const before = {
    source: { ...source },
    rooms: demoStore.rooms.filter((room) => room.roomTypeId === source.id).map((room) => ({ ...room })),
    reservations: demoStore.reservations.filter((reservation) => reservation.roomTypeId === source.id).map((reservation) => ({ ...reservation }))
  };
  for (const room of demoStore.rooms.filter((candidate) => candidate.roomTypeId === source.id)) {
    room.roomTypeId = target.id;
  }
  for (const reservation of demoStore.reservations.filter((candidate) => candidate.roomTypeId === source.id)) {
    reservation.roomTypeId = target.id;
  }
  source.active = false;
  audit({ ...input, action: "RoomTypeMerged", entityType: "room_type", entityId: source.id, beforeJson: before, afterJson: { source, target } });
  return { status: "merged" as const, source, target };
}

export function listRoomsForRoomType(roomTypeId: string) {
  return demoStore.rooms.filter((room) => room.roomTypeId === roomTypeId);
}

export function listRoomFeatures(propertyId: string) {
  return demoStore.roomFeatures.filter((feature) => feature.propertyId === propertyId);
}

export function createRoomFeature(input: BackOfficeMutationInput & {
  feature: Pick<RoomFeatureRecord, "code" | "name"> & Partial<RoomFeatureRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  if (demoStore.roomFeatures.some((feature) => feature.propertyId === input.propertyId && feature.code === input.feature.code)) {
    throw new Error("Room feature code must be unique per property.");
  }
  const record: RoomFeatureRecord = {
    id: createId("rf"),
    propertyId: input.propertyId,
    code: input.feature.code,
    name: input.feature.name,
    category: input.feature.category,
    active: input.feature.active ?? true
  };
  demoStore.roomFeatures.push(record);
  audit({ ...input, action: "RoomFeatureCreated", entityType: "room_feature", entityId: record.id, afterJson: record });
  return record;
}

export function listBedTypes(propertyId: string) {
  return demoStore.bedTypes.filter((bedType) => bedType.propertyId === propertyId);
}

export function createBedType(input: BackOfficeMutationInput & {
  bedType: Pick<BedTypeRecord, "code" | "name"> & Partial<BedTypeRecord>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  if (demoStore.bedTypes.some((bedType) => bedType.propertyId === input.propertyId && bedType.code === input.bedType.code)) {
    throw new Error("Bed type code must be unique per property.");
  }
  const record: BedTypeRecord = {
    id: createId("bed"),
    propertyId: input.propertyId,
    code: input.bedType.code,
    name: input.bedType.name,
    capacity: input.bedType.capacity ?? 1,
    active: input.bedType.active ?? true
  };
  demoStore.bedTypes.push(record);
  audit({ ...input, action: "BedTypeCreated", entityType: "bed_type", entityId: record.id, afterJson: record });
  return record;
}

export function previewPropertyMapImport(input: BackOfficeMutationInput & { rows: PropertyMapImportRow[] }) {
  requirePermissions(input.context, ["property.import"]);
  const errors: string[] = [];
  const warnings: string[] = [];
  const knownRoomTypes = new Set(demoStore.roomTypes.filter((roomType) => roomType.propertyId === input.propertyId).map((roomType) => roomType.code));
  const existingRoomNumbers = new Set(demoStore.rooms.filter((room) => room.propertyId === input.propertyId).map((room) => room.number));

  input.rows.forEach((row, index) => {
    if (!row.roomNumber) {
      errors.push(`Row ${index + 1}: room_number is required.`);
    }
    if (row.roomNumber && existingRoomNumbers.has(row.roomNumber)) {
      errors.push(`Row ${index + 1}: room ${row.roomNumber} already exists.`);
    }
    if (row.roomType && !knownRoomTypes.has(row.roomType)) {
      warnings.push(`Row ${index + 1}: room type ${row.roomType} will be created if confirmed.`);
    }
  });

  const importRecord: PropertyImportRecord = {
    id: createId("import"),
    propertyId: input.propertyId,
    importType: "property_map",
    status: errors.length > 0 ? "failed" : "previewed",
    previewJson: {
      rows: input.rows,
      createCount: input.rows.length,
      warnings
    },
    errorJson: { errors },
    createdBy: input.context.userId,
    createdAt: nowIso()
  };
  demoStore.propertyImports.push(importRecord);
  audit({ ...input, action: "PropertyImportPreviewed", entityType: "property_import", entityId: importRecord.id, afterJson: importRecord });
  return importRecord;
}

export function commitPropertyMapImport(input: BackOfficeMutationInput & { importId: string; createUnknownReferences?: boolean }) {
  requirePermissions(input.context, ["property.import"]);
  const importRecord = demoStore.propertyImports.find((candidate) => candidate.id === input.importId && candidate.propertyId === input.propertyId);
  if (!importRecord) {
    throw new Error("Import was not found.");
  }
  if (importRecord.status !== "previewed") {
    throw new Error("Only previewed imports can be committed.");
  }

  const rows = (importRecord.previewJson.rows ?? []) as PropertyMapImportRow[];
  const roomTypeByCode = new Map(demoStore.roomTypes.filter((roomType) => roomType.propertyId === input.propertyId).map((roomType) => [roomType.code, roomType]));
  const createdRooms: RoomRecord[] = [];
  for (const row of rows) {
    if (!row.roomNumber) {
      throw new Error("Import contains a row without room number.");
    }
    let roomType = row.roomType ? roomTypeByCode.get(row.roomType) : undefined;
    if (!roomType && row.roomType && input.createUnknownReferences) {
      roomType = {
        id: createId("rt"),
        propertyId: input.propertyId,
        name: row.roomType,
        code: row.roomType,
        maxOccupancy: row.maxOccupancy ?? 2,
        baseCapacity: row.standardOccupancy ?? 2,
        description: "Created from Back Office import",
        active: true,
        sellable: true
      };
      demoStore.roomTypes.push(roomType);
      roomTypeByCode.set(row.roomType, roomType);
    }
    if (!roomType) {
      throw new Error(`Unknown room type ${row.roomType ?? "missing"}.`);
    }
    const created = bulkCreateRooms({
      context: input.context,
      propertyId: input.propertyId,
      correlationId: input.correlationId,
      roomTypeId: roomType.id,
      roomNumbers: [row.roomNumber],
      sellable: row.sellable ?? true,
      active: row.active ?? true
    });
    createdRooms.push(...created.rooms);
  }

  const before = { ...importRecord };
  importRecord.status = "committed";
  importRecord.committedAt = nowIso();
  audit({ ...input, action: "PropertyImportCommitted", entityType: "property_import", entityId: importRecord.id, beforeJson: before, afterJson: importRecord });
  return { status: "committed" as const, import: importRecord, createdRooms };
}

export function getPropertyImport(propertyId: string, importId: string) {
  return demoStore.propertyImports.find((candidate) => candidate.propertyId === propertyId && candidate.id === importId);
}

export function listBackOfficeModules(propertyId: string) {
  const propertyModules = demoStore.propertyModules.filter((propertyModule) => propertyModule.propertyId === propertyId);
  return HOTEL_MODULES.map((manifest) => {
    const moduleRecord = demoStore.modules.find((module) => module.code === manifest.code);
    const propertyModule = propertyModules.find((candidate) => candidate.moduleId === moduleRecord?.id);
    const health = demoStore.moduleHealthChecks.filter((check) => check.propertyId === propertyId && check.moduleCode === manifest.code);
    const healthStatus = health.some((check) => check.status === "error")
      ? "error"
      : health.some((check) => check.status === "needs_configuration")
        ? "needs_configuration"
        : "ok";
    return {
      ...manifest,
      status: propertyModule?.status ?? (manifest.isCore ? "enabled" : "available"),
      configurationJson: propertyModule?.configurationJson ?? {},
      healthStatus,
      healthChecks: health,
      recommendedNextAction: health.find((check) => check.status !== "ok")?.message ?? "No action required."
    };
  });
}

export function configureModule(input: BackOfficeMutationInput & { moduleCode: HotelModuleCode; configurationJson: Record<string, unknown> }) {
  requirePermissions(input.context, ["modules.configure"]);
  const moduleRecord = demoStore.modules.find((module) => module.code === input.moduleCode);
  if (!moduleRecord) {
    throw new Error("Module was not found.");
  }
  let propertyModule = demoStore.propertyModules.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.moduleId === moduleRecord.id
  );
  if (!propertyModule) {
    propertyModule = {
      id: createId("pm"),
      propertyId: input.propertyId,
      moduleId: moduleRecord.id,
      status: moduleRecord.isCore ? "enabled" : "disabled",
      configurationJson: {},
      createdAt: nowIso()
    };
    demoStore.propertyModules.push(propertyModule);
  }
  const before = { ...propertyModule };
  propertyModule.configurationJson = { ...propertyModule.configurationJson, ...input.configurationJson };
  audit({ ...input, action: "ModuleConfigured", entityType: "property_module", entityId: propertyModule.id, beforeJson: before, afterJson: propertyModule });
  return { module: getHotelModuleManifest(input.moduleCode), propertyModule };
}

export function getModuleConfiguration(propertyId: string, moduleCode: HotelModuleCode) {
  const moduleRecord = demoStore.modules.find((module) => module.code === moduleCode);
  const propertyModule = demoStore.propertyModules.find((candidate) => candidate.propertyId === propertyId && candidate.moduleId === moduleRecord?.id);
  return {
    module: getHotelModuleManifest(moduleCode),
    configurationJson: propertyModule?.configurationJson ?? {},
    setupRequirements: getModuleSetupRequirements(moduleCode)
  };
}

export function getModuleHealth(propertyId: string, moduleCode: HotelModuleCode) {
  return demoStore.moduleHealthChecks.filter((check) => check.propertyId === propertyId && check.moduleCode === moduleCode);
}

export function recalculateModuleHealth(input: BackOfficeMutationInput & { moduleCode: HotelModuleCode }) {
  requirePermissions(input.context, ["modules.configure"]);
  const requirements = getModuleSetupRequirements(input.moduleCode);
  const health = requirements.map((requirement) => ({
    id: createId("mh"),
    propertyId: input.propertyId,
    moduleCode: input.moduleCode,
    checkCode: requirement.code,
    status: requirement.validator(input.propertyId) ? "ok" : "needs_configuration",
    severity: requirement.blocking ? "blocking" : "warning",
    message: requirement.description,
    metadataJson: {},
    updatedAt: nowIso()
  })) as typeof demoStore.moduleHealthChecks;
  demoStore.moduleHealthChecks = demoStore.moduleHealthChecks.filter(
    (check) => !(check.propertyId === input.propertyId && check.moduleCode === input.moduleCode)
  );
  demoStore.moduleHealthChecks.push(...health);
  audit({ ...input, action: "ModuleHealthRecalculated", entityType: "module", entityId: input.moduleCode, afterJson: health });
  return health;
}

function getModuleSetupRequirements(moduleCode: HotelModuleCode) {
  return [
    {
      code: "room_inventory_exists",
      label: "Room inventory exists",
      description: "At least one active sellable room must exist.",
      required: true,
      blocking: true,
      validator: (propertyId: string) => demoStore.rooms.some((room) => room.propertyId === propertyId && room.active !== false && room.sellable)
    },
    {
      code: "signature_template_configured",
      label: "Signature template configured",
      description: "Guest register signature template must be configured.",
      required: moduleCode === "checkin_online",
      blocking: moduleCode === "checkin_online",
      validator: (propertyId: string) =>
        demoStore.documentTemplates.some((template) => template.propertyId === propertyId && template.templateCode === "guest_register_signature_form")
    },
    {
      code: "ocr_provider_configured",
      label: "OCR provider configured",
      description: "OCR provider must be configured before assisted ID scan.",
      required: moduleCode === "checkin_online",
      blocking: moduleCode === "checkin_online",
      validator: (propertyId: string) =>
        demoStore.propertyAiSettings.some((settings) => settings.propertyId === propertyId && settings.configurationJson.ocrProviderConfigured === true)
    }
  ];
}

export function listDepartments(propertyId: string) {
  return demoStore.departments.filter((department) => department.propertyId === propertyId);
}

export function createDepartment(input: BackOfficeMutationInput & { department: Pick<DepartmentRecord, "name" | "code"> & Partial<DepartmentRecord> }) {
  requirePermissions(input.context, ["property.configure"]);
  if (demoStore.departments.some((department) => department.propertyId === input.propertyId && department.code === input.department.code)) {
    throw new Error("Department code must be unique per property.");
  }
  const record: DepartmentRecord = {
    id: createId("dep"),
    propertyId: input.propertyId,
    name: input.department.name,
    code: input.department.code,
    description: input.department.description,
    active: input.department.active ?? true
  };
  demoStore.departments.push(record);
  audit({ ...input, action: "DepartmentCreated", entityType: "department", entityId: record.id, afterJson: record });
  return record;
}

export function getHousekeepingConfiguration(propertyId: string) {
  return {
    sections: demoStore.housekeepingSections
      .filter((section) => section.propertyId === propertyId)
      .map((section) => ({
        ...section,
        rooms: demoStore.housekeepingSectionRooms
          .filter((assignment) => assignment.housekeepingSectionId === section.id)
          .map((assignment) => demoStore.rooms.find((room) => room.id === assignment.roomId))
          .filter(Boolean)
      })),
    rules: demoStore.housekeepingRules.filter((rule) => rule.propertyId === propertyId)
  };
}

export function createHousekeepingSection(input: BackOfficeMutationInput & {
  section: Pick<HousekeepingSectionRecord, "name"> & Partial<HousekeepingSectionRecord>;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const section: HousekeepingSectionRecord = {
    id: createId("hk"),
    propertyId: input.propertyId,
    name: input.section.name,
    code: input.section.code,
    description: input.section.description,
    active: input.section.active ?? true
  };
  demoStore.housekeepingSections.push(section);
  audit({ ...input, action: "HousekeepingSectionCreated", entityType: "housekeeping_section", entityId: section.id, afterJson: section });
  return section;
}

export function assignRoomsToHousekeepingSection(input: BackOfficeMutationInput & {
  sectionId: string;
  roomIds: string[];
}) {
  requirePermissions(input.context, ["property.configure"]);
  const section = demoStore.housekeepingSections.find(
    (candidate) => candidate.id === input.sectionId && candidate.propertyId === input.propertyId
  );
  if (!section) {
    throw new Error("Housekeeping section was not found.");
  }
  for (const roomId of input.roomIds) {
    const room = demoStore.rooms.find((candidate) => candidate.id === roomId && candidate.propertyId === input.propertyId);
    if (!room) {
      throw new Error("All assigned rooms must belong to the property.");
    }
    const exists = demoStore.housekeepingSectionRooms.some(
      (assignment) => assignment.housekeepingSectionId === section.id && assignment.roomId === room.id
    );
    if (!exists) {
      demoStore.housekeepingSectionRooms.push({
        id: createId("hksr"),
        housekeepingSectionId: section.id,
        roomId: room.id
      });
    }
  }
  const assignments = demoStore.housekeepingSectionRooms.filter((assignment) => assignment.housekeepingSectionId === section.id);
  audit({ ...input, action: "HousekeepingSectionRoomsAssigned", entityType: "housekeeping_section", entityId: section.id, afterJson: assignments });
  return { section, assignments };
}

export function upsertHousekeepingRule(input: BackOfficeMutationInput & {
  ruleCode: string;
  configurationJson: Record<string, unknown>;
  active?: boolean;
}) {
  requirePermissions(input.context, ["property.configure"]);
  let rule = demoStore.housekeepingRules.find((candidate) => candidate.propertyId === input.propertyId && candidate.ruleCode === input.ruleCode);
  const before = rule ? { ...rule } : undefined;
  if (!rule) {
    rule = {
      id: createId("hkr"),
      propertyId: input.propertyId,
      ruleCode: input.ruleCode,
      configurationJson: input.configurationJson,
      active: input.active ?? true
    };
    demoStore.housekeepingRules.push(rule);
  } else {
    rule.configurationJson = input.configurationJson;
    rule.active = input.active ?? rule.active;
  }
  audit({ ...input, action: "HousekeepingRuleUpdated", entityType: "housekeeping_rule", entityId: rule.id, beforeJson: before, afterJson: rule });
  return rule;
}

export function getMaintenanceConfiguration(propertyId: string) {
  return {
    areas: demoStore.maintenanceAreas
      .filter((area) => area.propertyId === propertyId)
      .map((area) => ({
        ...area,
        rooms: demoStore.maintenanceAreaRooms
          .filter((assignment) => assignment.maintenanceAreaId === area.id)
          .map((assignment) => demoStore.rooms.find((room) => room.id === assignment.roomId))
          .filter(Boolean)
      })),
    rules: demoStore.maintenanceRules.filter((rule) => rule.propertyId === propertyId)
  };
}

export function createMaintenanceArea(input: BackOfficeMutationInput & {
  area: Pick<MaintenanceAreaRecord, "name"> & Partial<MaintenanceAreaRecord>;
}) {
  requirePermissions(input.context, ["property.configure"]);
  const area: MaintenanceAreaRecord = {
    id: createId("ma"),
    propertyId: input.propertyId,
    name: input.area.name,
    code: input.area.code,
    description: input.area.description,
    active: input.area.active ?? true
  };
  demoStore.maintenanceAreas.push(area);
  audit({ ...input, action: "MaintenanceAreaCreated", entityType: "maintenance_area", entityId: area.id, afterJson: area });
  return area;
}

export function assignRoomsToMaintenanceArea(input: BackOfficeMutationInput & {
  areaId: string;
  roomIds: string[];
}) {
  requirePermissions(input.context, ["property.configure"]);
  const area = demoStore.maintenanceAreas.find((candidate) => candidate.id === input.areaId && candidate.propertyId === input.propertyId);
  if (!area) {
    throw new Error("Maintenance area was not found.");
  }
  for (const roomId of input.roomIds) {
    const room = demoStore.rooms.find((candidate) => candidate.id === roomId && candidate.propertyId === input.propertyId);
    if (!room) {
      throw new Error("All assigned rooms must belong to the property.");
    }
    const exists = demoStore.maintenanceAreaRooms.some(
      (assignment) => assignment.maintenanceAreaId === area.id && assignment.roomId === room.id
    );
    if (!exists) {
      demoStore.maintenanceAreaRooms.push({
        id: createId("mar"),
        maintenanceAreaId: area.id,
        roomId: room.id
      });
    }
  }
  const assignments = demoStore.maintenanceAreaRooms.filter((assignment) => assignment.maintenanceAreaId === area.id);
  audit({ ...input, action: "MaintenanceAreaRoomsAssigned", entityType: "maintenance_area", entityId: area.id, afterJson: assignments });
  return { area, assignments };
}

export function upsertMaintenanceRule(input: BackOfficeMutationInput & {
  ruleCode: string;
  configurationJson: Record<string, unknown>;
  active?: boolean;
}) {
  requirePermissions(input.context, ["property.configure"]);
  let rule = demoStore.maintenanceRules.find((candidate) => candidate.propertyId === input.propertyId && candidate.ruleCode === input.ruleCode);
  const before = rule ? { ...rule } : undefined;
  if (!rule) {
    rule = {
      id: createId("mr"),
      propertyId: input.propertyId,
      ruleCode: input.ruleCode,
      configurationJson: input.configurationJson,
      active: input.active ?? true
    };
    demoStore.maintenanceRules.push(rule);
  } else {
    rule.configurationJson = input.configurationJson;
    rule.active = input.active ?? rule.active;
  }
  audit({ ...input, action: "MaintenanceRuleUpdated", entityType: "maintenance_rule", entityId: rule.id, beforeJson: before, afterJson: rule });
  return rule;
}

export function assignUserToDepartment(input: BackOfficeMutationInput & {
  departmentId: string;
  userId: string;
  roleLabel?: string;
}) {
  requirePermissions(input.context, ["users.invite"]);
  const department = demoStore.departments.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.id === input.departmentId
  );
  if (!department) {
    throw new Error("Department was not found.");
  }
  const user = demoStore.users.find((candidate) => candidate.id === input.userId);
  if (!user) {
    throw new Error("User was not found.");
  }
  let assignment = demoStore.userDepartments.find(
    (candidate) => candidate.departmentId === department.id && candidate.userId === user.id
  );
  const before = assignment ? { ...assignment } : undefined;
  if (!assignment) {
    assignment = {
      id: createId("ud"),
      userId: user.id,
      departmentId: department.id,
      roleLabel: input.roleLabel,
      active: true
    };
    demoStore.userDepartments.push(assignment);
  } else {
    assignment.roleLabel = input.roleLabel ?? assignment.roleLabel;
    assignment.active = true;
  }
  audit({ ...input, action: "UserDepartmentAssigned", entityType: "user_department", entityId: assignment.id, beforeJson: before, afterJson: assignment });
  return assignment;
}

export function listBackOfficeUsers(propertyId: string) {
  const property = requireProperty(propertyId);
  return demoStore.users
    .filter((user) => user.organizationId === property.organizationId)
    .map((user) => ({
      ...user,
      departments: demoStore.userDepartments
        .filter((assignment) => assignment.userId === user.id && assignment.active)
        .map((assignment) => ({
          ...assignment,
          department: demoStore.departments.find((department) => department.id === assignment.departmentId)
        }))
    }));
}

export function inviteBackOfficeUser(input: BackOfficeMutationInput & {
  email: string;
  fullName: string;
  phone?: string;
  mfaRequired?: boolean;
}) {
  requirePermissions(input.context, ["users.invite"]);
  const property = requireProperty(input.propertyId);
  if (demoStore.users.some((user) => user.email === input.email)) {
    throw new Error("User email must be unique.");
  }
  const user: UserRecord = {
    id: createId("usr"),
    organizationId: property.organizationId,
    email: input.email,
    phone: input.phone,
    fullName: input.fullName,
    status: "invited",
    mfaEnabled: input.mfaRequired ?? true
  };
  demoStore.users.push(user);
  audit({ ...input, action: "UserInvited", entityType: "user", entityId: user.id, afterJson: user });
  return user;
}

export function disableBackOfficeUser(input: BackOfficeMutationInput & { userId: string }) {
  requirePermissions(input.context, ["users.disable"]);
  const user = demoStore.users.find((candidate) => candidate.id === input.userId);
  if (!user) {
    throw new Error("User was not found.");
  }
  const before = { ...user };
  user.status = "disabled";
  audit({ ...input, action: "UserDisabled", entityType: "user", entityId: user.id, beforeJson: before, afterJson: user });
  return user;
}

export function listRoleCatalog() {
  return Object.entries(ROLE_PERMISSION_MAP).map(([role, rolePermissions]) => ({
    role,
    permissions: rolePermissions
  }));
}

export function listPermissionCatalog() {
  return Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description }));
}

export function getComplianceSettings(propertyId: string) {
  return demoStore.propertyComplianceSettings.find((settings) => settings.propertyId === propertyId);
}

export function patchComplianceSettings(input: BackOfficeMutationInput & { patch: Partial<PropertyComplianceSettingsRecord> }) {
  requirePermissions(input.context, ["compliance.configure"]);
  const settings = demoStore.propertyComplianceSettings.find((candidate) => candidate.propertyId === input.propertyId);
  if (!settings) {
    throw new Error("Compliance settings were not found.");
  }
  const before = { ...settings };
  Object.assign(settings, input.patch, { updatedAt: nowIso() });
  audit({ ...input, action: "TaxSettingsUpdated", entityType: "property_compliance_settings", entityId: settings.id, beforeJson: before, afterJson: settings });
  return settings;
}

export function getBillingSettings(propertyId: string) {
  return {
    invoiceSequences: demoStore.invoiceSequences.filter((sequence) => sequence.propertyId === propertyId),
    complianceBilling: getModuleConfiguration(propertyId, "compliance_billing")
  };
}

export function patchBillingSettings(input: BackOfficeMutationInput & { invoiceSequence?: Partial<InvoiceSequenceRecord> }) {
  requirePermissions(input.context, ["billing.configure"]);
  if (!input.invoiceSequence?.sequenceCode || !input.invoiceSequence.invoiceType) {
    throw new Error("Invoice sequence code and invoice type are required.");
  }
  let sequence = demoStore.invoiceSequences.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.sequenceCode === input.invoiceSequence!.sequenceCode
  );
  const before = sequence ? { ...sequence } : undefined;
  if (!sequence) {
    sequence = {
      id: createId("seq"),
      propertyId: input.propertyId,
      sequenceCode: input.invoiceSequence.sequenceCode,
      prefix: input.invoiceSequence.prefix,
      nextNumber: input.invoiceSequence.nextNumber ?? 1,
      padding: input.invoiceSequence.padding ?? 6,
      invoiceType: input.invoiceSequence.invoiceType,
      active: input.invoiceSequence.active ?? true
    };
    demoStore.invoiceSequences.push(sequence);
  } else {
    Object.assign(sequence, input.invoiceSequence);
  }
  audit({ ...input, action: before ? "InvoiceSequenceUpdated" : "InvoiceSequenceCreated", entityType: "invoice_sequence", entityId: sequence.id, beforeJson: before, afterJson: sequence });
  return getBillingSettings(input.propertyId);
}

export function getAccountingSettings(propertyId: string) {
  return {
    settings: demoStore.accountingSettings.find((settings) => settings.propertyId === propertyId),
    costCenters: demoStore.costCenters.filter((costCenter) => costCenter.propertyId === propertyId)
  };
}

export function patchAccountingSettings(input: BackOfficeMutationInput & { patch: Partial<AccountingSettingsRecord> }) {
  requirePermissions(input.context, ["accounting.configure"]);
  const settings = demoStore.accountingSettings.find((candidate) => candidate.propertyId === input.propertyId);
  if (!settings) {
    throw new Error("Accounting settings were not found.");
  }
  const before = { ...settings };
  Object.assign(settings, input.patch, { updatedAt: nowIso() });
  audit({ ...input, action: "AccountingSettingsUpdated", entityType: "accounting_settings", entityId: settings.id, beforeJson: before, afterJson: settings });
  return settings;
}

export function getAiSettings(propertyId: string) {
  return {
    settings: demoStore.propertyAiSettings.find((settings) => settings.propertyId === propertyId),
    toolSettings: demoStore.propertyAiToolSettings.filter((tool) => tool.propertyId === propertyId)
  };
}

export function patchAiSettings(input: BackOfficeMutationInput & { patch: Partial<PropertyAiSettingsRecord> }) {
  requirePermissions(input.context, ["ai.configure"]);
  const settings = demoStore.propertyAiSettings.find((candidate) => candidate.propertyId === input.propertyId);
  if (!settings) {
    throw new Error("AI settings were not found.");
  }
  if (input.patch.configurationJson?.documentImageRetentionPolicy === "store_by_default") {
    throw new Error("AI settings cannot allow ID image storage by default.");
  }
  const before = { ...settings };
  Object.assign(settings, input.patch, { updatedAt: nowIso() });
  audit({ ...input, action: "AISettingsUpdated", entityType: "property_ai_settings", entityId: settings.id, beforeJson: before, afterJson: settings });
  return settings;
}

export function listDocumentTemplates(propertyId: string) {
  return demoStore.documentTemplates.filter((template) => template.propertyId === propertyId);
}

export function createDocumentTemplate(input: BackOfficeMutationInput & {
  template: Pick<DocumentTemplateRecord, "templateCode" | "name" | "channel" | "language" | "body"> & Partial<DocumentTemplateRecord>;
}) {
  requirePermissions(input.context, ["templates.manage"]);
  if (
    demoStore.documentTemplates.some(
      (template) =>
        template.propertyId === input.propertyId &&
        template.templateCode === input.template.templateCode &&
        template.language === input.template.language
    )
  ) {
    throw new Error("Template code and language must be unique per property.");
  }
  const record: DocumentTemplateRecord = {
    id: createId("tpl"),
    propertyId: input.propertyId,
    templateCode: input.template.templateCode,
    name: input.template.name,
    channel: input.template.channel,
    language: input.template.language,
    subject: input.template.subject,
    body: input.template.body,
    variablesJson: input.template.variablesJson ?? {},
    active: input.template.active ?? true,
    updatedAt: nowIso()
  };
  demoStore.documentTemplates.push(record);
  audit({ ...input, action: "TemplateCreated", entityType: "document_template", entityId: record.id, afterJson: record });
  return record;
}

export function updateDocumentTemplate(input: BackOfficeMutationInput & {
  templateId: string;
  patch: { subject?: string; body?: string; active?: boolean };
}) {
  requirePermissions(input.context, ["templates.manage"]);
  const template = demoStore.documentTemplates.find((candidate) => candidate.propertyId === input.propertyId && candidate.id === input.templateId);
  if (!template) {
    throw new Error("Template was not found.");
  }
  const before = { ...template };
  Object.assign(template, input.patch, { updatedAt: nowIso() });
  audit({ ...input, action: "TemplateUpdated", entityType: "document_template", entityId: template.id, beforeJson: before, afterJson: template });
  return template;
}

export function generateQrCode(input: BackOfficeMutationInput & Omit<QrCodeRecord, "id" | "propertyId" | "active" | "createdAt">) {
  requirePermissions(input.context, ["property.map.manage"]);
  let code = demoStore.qrCodes.find(
    (candidate) =>
      candidate.propertyId === input.propertyId &&
      candidate.entityType === input.entityType &&
      candidate.entityId === input.entityId &&
      candidate.purpose === input.purpose
  );
  if (!code) {
    code = {
      id: createId("qr"),
      propertyId: input.propertyId,
      entityType: input.entityType,
      entityId: input.entityId,
      qrValue: input.qrValue,
      purpose: input.purpose,
      active: true,
      createdAt: nowIso()
    };
    demoStore.qrCodes.push(code);
  }
  audit({ ...input, action: "QRCodeGenerated", entityType: "qr_code", entityId: code.id, afterJson: code });
  return code;
}

export function listQrCodes(propertyId: string) {
  return demoStore.qrCodes.filter((code) => code.propertyId === propertyId);
}

export function generateBulkQrCodes(input: BackOfficeMutationInput & {
  items: Array<Omit<QrCodeRecord, "id" | "propertyId" | "active" | "createdAt">>;
}) {
  requirePermissions(input.context, ["property.map.manage"]);
  const codes = input.items.map((item) =>
    generateQrCode({
      context: input.context,
      propertyId: input.propertyId,
      correlationId: input.correlationId,
      ...item
    })
  );
  audit({
    ...input,
    action: "QRCodeBulkGenerated",
    entityType: "qr_code",
    afterJson: { generatedCount: codes.length, codes }
  });
  return { status: "generated" as const, generatedCount: codes.length, codes };
}

function parseRoomRangeFromPrompt(prompt: string) {
  const match = prompt.match(/(\d{3,4})\s*(?:to|-|through|a)\s*(\d{3,4})/i);
  if (!match) {
    return undefined;
  }
  return { roomRangeStart: match[1], roomRangeEnd: match[2] };
}

function makeBackOfficeProposal(prompt: string): Record<string, unknown> {
  const lower = prompt.toLowerCase();
  const roomRange = parseRoomRangeFromPrompt(prompt);
  if (roomRange) {
    const start = Number(roomRange.roomRangeStart);
    const end = Number(roomRange.roomRangeEnd);
    const count = Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start + 1);
    return {
      action: "create_room_range",
      ...roomRange,
      roomTypeId: "rt_double",
      buildingId: "bld_main",
      floorId: lower.includes("floor 4") || lower.includes("planta 4") ? "floor_4" : "floor_1",
      zoneId: lower.includes("floor 4") || lower.includes("planta 4") ? "zone_f4_east" : "zone_lobby",
      preview: `Will create up to ${count} rooms after confirmation. Existing room numbers will be skipped.`
    };
  }
  if (lower.includes("housekeeping") || lower.includes("limpieza")) {
    return {
      action: "create_housekeeping_sections_by_floor",
      preview: "Will create one housekeeping section per active floor and assign rooms by floor after confirmation."
    };
  }
  if (lower.includes("bienvenida") || lower.includes("welcome")) {
    return {
      action: "create_template",
      templateCode: "welcome_message_ai_draft",
      preview: "Will create a welcome-message template draft in Spanish and English after confirmation."
    };
  }
  return {
    action: "review_readiness",
    preview: "Will review setup readiness, module health and blocking go-live checks."
  };
}

export function listBackOfficeAiSuggestions(propertyId: string) {
  return demoStore.backOfficeAiSuggestions.filter((suggestion) => suggestion.propertyId === propertyId).slice().reverse();
}

export function createBackOfficeAiSuggestion(input: BackOfficeMutationInput & { prompt: string }) {
  requirePermissions(input.context, ["ai.configure"]);
  const suggestion: BackOfficeAiSuggestionRecord = {
    id: createId("boai"),
    propertyId: input.propertyId,
    userId: input.context.userId,
    prompt: input.prompt,
    status: "previewed",
    proposedChangesJson: makeBackOfficeProposal(input.prompt),
    requiresConfirmation: true,
    createdAt: nowIso()
  };
  demoStore.backOfficeAiSuggestions.push(suggestion);
  audit({
    ...input,
    action: "BackOfficeAiSuggestionCreated",
    entityType: "backoffice_ai_suggestion",
    entityId: suggestion.id,
    afterJson: suggestion
  });
  return suggestion;
}

export function applyBackOfficeAiSuggestion(input: BackOfficeMutationInput & { suggestionId: string }) {
  requirePermissions(input.context, ["ai.configure"]);
  const suggestion = demoStore.backOfficeAiSuggestions.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.id === input.suggestionId
  );
  if (!suggestion) {
    throw new Error("Back Office AI suggestion was not found.");
  }
  if (suggestion.status !== "previewed" || !suggestion.requiresConfirmation) {
    throw new Error("AI cannot apply Back Office changes without preview and confirmation.");
  }

  const before = { ...suggestion };
  let result: unknown;
  const action = suggestion.proposedChangesJson.action;
  if (action === "create_room_range") {
    const start = suggestion.proposedChangesJson.roomRangeStart as string;
    const end = suggestion.proposedChangesJson.roomRangeEnd as string;
    const roomNumbers = Array.from({ length: Number(end) - Number(start) + 1 }, (_, index) => roomNumberFromRange(start, index)).filter(
      (number) => !demoStore.rooms.some((room) => room.propertyId === input.propertyId && room.number === number)
    );
    result =
      roomNumbers.length === 0
        ? { status: "skipped", reason: "All room numbers already exist." }
        : bulkCreateRooms({
            context: input.context,
            propertyId: input.propertyId,
            correlationId: input.correlationId,
            roomTypeId: suggestion.proposedChangesJson.roomTypeId as string,
            roomNumbers,
            buildingId: suggestion.proposedChangesJson.buildingId as string,
            floorId: suggestion.proposedChangesJson.floorId as string,
            zoneId: suggestion.proposedChangesJson.zoneId as string,
            sellable: true,
            active: true
          });
  } else if (action === "create_housekeeping_sections_by_floor") {
    const created = demoStore.floors
      .filter((floor) => floor.propertyId === input.propertyId && floor.active)
      .filter((floor) => !demoStore.housekeepingSections.some((section) => section.propertyId === input.propertyId && section.code === `HK_${floor.code ?? floor.id}`))
      .map((floor) =>
        createHousekeepingSection({
          context: input.context,
          propertyId: input.propertyId,
          correlationId: input.correlationId,
          section: { name: `${floor.name} housekeeping`, code: `HK_${floor.code ?? floor.id}`, active: true }
        })
      );
    result = { status: "created", createdCount: created.length, sections: created };
  } else if (action === "create_template") {
    result = createDocumentTemplate({
      context: input.context,
      propertyId: input.propertyId,
      correlationId: input.correlationId,
      template: {
        templateCode: suggestion.proposedChangesJson.templateCode as string,
        name: "AI drafted welcome message",
        channel: "email",
        language: "es",
        subject: "Bienvenida a HotelOS Madrid Centro",
        body: "Hola {{guest_name}}, soy el asistente AI del hotel. Recepcion puede ayudarte en cualquier momento.",
        variablesJson: { guest_name: "Guest name" },
        active: false
      }
    });
  } else {
    result = getReadiness(input.propertyId);
  }

  suggestion.status = "applied";
  suggestion.appliedAt = nowIso();
  audit({
    ...input,
    action: "BackOfficeAiSuggestionApplied",
    entityType: "backoffice_ai_suggestion",
    entityId: suggestion.id,
    beforeJson: before,
    afterJson: { suggestion, result }
  });
  return { suggestion, result };
}

export function listBackOfficeAudit(propertyId: string) {
  return demoStore.auditEvents.filter((event) => event.propertyId === propertyId).slice(-50).reverse();
}
