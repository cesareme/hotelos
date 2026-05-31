# Back Office Addendum

HotelOS Back Office is an incremental administration layer. It does not replace the mobile app, API, worker, AI Gateway, database package, product module registry, compliance package, integration registry, or existing operational modules.

The Back Office lives mainly in `apps/admin-web` with API support under `/backoffice`. The mobile app keeps a compact setup summary under More and Settings, but daily operations still belong to the mobile-first HotelOS suite.

## Purpose

The Back Office is the configuration and control center for:

- Organization and property setup.
- Physical property mapping.
- Buildings, floors, zones, rooms, spaces, outlets and assets.
- Room types, inventory, features and bed setups.
- Departments, users, roles and permissions.
- Module activation, configuration and health.
- Integration setup and connection logs.
- Tax, compliance, billing, accounting, payment and AI settings.
- Document templates, QR codes, imports, readiness and go-live.
- Audit review for every important administrative change.

## Admin Web Shell

`apps/admin-web` uses a sidebar organized into:

- Dashboard.
- Hotel Setup.
- Modules.
- Operations Config.
- Finance and Compliance.
- Integrations.
- AI.
- System.

Required screens are scaffolded as first-class modules:

- `BackOfficeDashboard`.
- `PropertySetupWizard`.
- `GoLiveChecklist`.
- `OrganizationSettings`.
- `PropertySettings`.
- `PropertyMapper`.
- `RoomTypeManager`.
- `RoomInventoryManager`.
- `DepartmentManager`.
- `UserRoleManager`.
- `ModuleManager`.
- `ModuleConfigurationCenter`.
- `ModuleHealthCenter`.
- `IntegrationManager`.
- `TaxComplianceSettings`.
- `BillingSettings`.
- `AccountingSettings`.
- `PaymentSettings`.
- `AISettings`.
- `DocumentTemplateManager`.
- `AuditLogViewer`.

## Property Mapper

The Property Mapper supports three views:

- Tree view for `Property -> Building -> Floor -> Zone -> Room / Space / Asset`.
- Grid view for spreadsheet-style room editing.
- Visual map view with manually placed rooms on a floor-plan canvas.

The MVP supports:

- Buildings.
- Floors.
- Property zones.
- Non-room spaces.
- Room feature and bed configuration contracts.
- Bulk room creation.
- CSV/XLSX import preview and commit contracts.
- Map position storage for room, space, zone and asset placement.
- QR code generation contracts for room, asset, space and guest service use cases.
- Bulk QR generation for room, asset, space, maintenance and guest service rollouts.

## AI Setup Assistant

Back Office AI is configuration-assistive, not autonomous administration. It can create previews for setup changes such as room ranges, housekeeping sections, template drafts and go-live readiness reviews. Applying a suggestion requires an explicit confirmation route and writes `BackOfficeAiSuggestionCreated` and `BackOfficeAiSuggestionApplied` audit events.

Rules:

- AI suggestions are stored as preview records.
- Bulk changes require preview before apply.
- AI cannot apply Back Office changes without preview and confirmation.
- Tax, billing, AI and invoice-sequence changes remain permission protected.
- ID image storage by default is still forbidden.

## Back Office API

The namespace is `/backoffice`:

- `GET /backoffice/properties/:propertyId/dashboard`.
- `GET /backoffice/properties/:propertyId/setup`.
- `PATCH /backoffice/properties/:propertyId/setup/:stepCode`.
- `GET /backoffice/properties/:propertyId/readiness`.
- `POST /backoffice/properties/:propertyId/readiness/recalculate`.
- `POST /backoffice/properties/:propertyId/go-live`.
- `GET /backoffice/properties/:propertyId/map`.
- `POST /backoffice/properties/:propertyId/buildings`.
- `POST /backoffice/properties/:propertyId/floors`.
- `POST /backoffice/properties/:propertyId/zones`.
- `POST /backoffice/properties/:propertyId/spaces`.
- `POST /backoffice/properties/:propertyId/map-positions`.
- `POST /backoffice/properties/:propertyId/rooms/bulk`.
- `PATCH /backoffice/properties/:propertyId/rooms/bulk`.
- `GET /backoffice/properties/:propertyId/property-map/export`.
- `GET /backoffice/properties/:propertyId/room-types`.
- `POST /backoffice/properties/:propertyId/room-types`.
- `PATCH /backoffice/properties/:propertyId/room-types/:roomTypeId`.
- `POST /backoffice/properties/:propertyId/room-types/:roomTypeId/deactivate`.
- `POST /backoffice/properties/:propertyId/room-types/:roomTypeId/merge`.
- `GET /backoffice/room-types/:roomTypeId/rooms`.
- `GET /backoffice/properties/:propertyId/room-features`.
- `POST /backoffice/properties/:propertyId/room-features`.
- `GET /backoffice/properties/:propertyId/bed-types`.
- `POST /backoffice/properties/:propertyId/bed-types`.
- `POST /backoffice/properties/:propertyId/imports/property-map/preview`.
- `POST /backoffice/properties/:propertyId/imports/property-map/commit`.
- `GET /backoffice/properties/:propertyId/imports/:importId`.
- `GET /backoffice/properties/:propertyId/modules`.
- `PATCH /backoffice/properties/:propertyId/modules/:moduleCode`.
- `GET /backoffice/properties/:propertyId/modules/:moduleCode/configuration`.
- `PATCH /backoffice/properties/:propertyId/modules/:moduleCode/configuration`.
- `GET /backoffice/properties/:propertyId/modules/:moduleCode/health`.
- `POST /backoffice/properties/:propertyId/modules/:moduleCode/recalculate-health`.
- `GET /backoffice/properties/:propertyId/departments`.
- `POST /backoffice/properties/:propertyId/departments`.
- `POST /backoffice/properties/:propertyId/departments/:departmentId/users`.
- `GET /backoffice/properties/:propertyId/housekeeping-settings`.
- `POST /backoffice/properties/:propertyId/housekeeping-sections`.
- `POST /backoffice/properties/:propertyId/housekeeping-sections/:sectionId/rooms`.
- `PATCH /backoffice/properties/:propertyId/housekeeping-rules/:ruleCode`.
- `GET /backoffice/properties/:propertyId/maintenance-settings`.
- `POST /backoffice/properties/:propertyId/maintenance-areas`.
- `POST /backoffice/properties/:propertyId/maintenance-areas/:areaId/rooms`.
- `PATCH /backoffice/properties/:propertyId/maintenance-rules/:ruleCode`.
- `GET /backoffice/properties/:propertyId/users`.
- `POST /backoffice/properties/:propertyId/users/invite`.
- `POST /backoffice/properties/:propertyId/users/:userId/disable`.
- `GET /backoffice/roles`.
- `GET /backoffice/permissions`.
- `GET /backoffice/properties/:propertyId/integrations`.
- `POST /backoffice/properties/:propertyId/integrations/:providerCode/connect`.
- `GET /backoffice/properties/:propertyId/compliance-settings`.
- `PATCH /backoffice/properties/:propertyId/compliance-settings`.
- `GET /backoffice/properties/:propertyId/billing-settings`.
- `PATCH /backoffice/properties/:propertyId/billing-settings`.
- `GET /backoffice/properties/:propertyId/accounting-settings`.
- `PATCH /backoffice/properties/:propertyId/accounting-settings`.
- `GET /backoffice/properties/:propertyId/ai-settings`.
- `PATCH /backoffice/properties/:propertyId/ai-settings`.
- `GET /backoffice/properties/:propertyId/ai/suggestions`.
- `POST /backoffice/properties/:propertyId/ai/suggestions`.
- `POST /backoffice/properties/:propertyId/ai/suggestions/:suggestionId/apply`.
- `GET /backoffice/properties/:propertyId/templates`.
- `POST /backoffice/properties/:propertyId/templates`.
- `PATCH /backoffice/properties/:propertyId/templates/:templateId`.
- `POST /backoffice/properties/:propertyId/qr-codes`.
- `GET /backoffice/properties/:propertyId/qr-codes`.
- `POST /backoffice/properties/:propertyId/qr-codes/bulk`.
- `GET /backoffice/properties/:propertyId/audit`.

Every mutating route is listed in the route permission manifest.

## Safety Rules

- Every Back Office change writes an audit event.
- Critical configuration changes require strong permissions.
- Bulk imports create preview records before commit.
- Go-live is blocked while readiness checks with blocking severity fail.
- Room numbers must be unique per property.
- Sellable rooms must have a room type.
- Module dependencies are validated by the product module service.
- Core modules cannot be disabled.
- Integration credentials remain secret references, not plaintext configuration.
- AI settings cannot allow default ID image storage.
- Disabled modules are hidden from mobile and admin navigation by module and permission filters.

## Data Contracts

The Prisma schema now includes contracts for:

- `Building`, `Floor`, `PropertyZone`, `PropertySpace`, `PropertyMapPosition`.
- Room extensions for building, floor, zone, display name, occupancy, bed configuration, features, accessibility, view and active state.
- `RoomFeature`, `RoomFeatureAssignment`, `BedType`, `RoomBed`.
- `PropertySetupStep`, `PropertyReadinessCheck`, `ModuleHealthCheck`.
- `Department`, `UserDepartment`.
- `HousekeepingSection`, `HousekeepingSectionRoom`, `HousekeepingRule`.
- `MaintenanceArea`, `MaintenanceAreaRoom`, `MaintenanceRule`.
- Asset extensions for building, floor, zone, space, asset code, manufacturer, model, installation, cost, useful life and QR value.
- `PropertyComplianceSetting`, `InvoiceSequence`, `AccountingSetting`, `CostCenter`.
- `PropertyAiSetting`, `PropertyAiToolSetting`.
- `DocumentTemplate`, `QrCode`, `PropertyImport`, `BackOfficeAiSuggestion`.
