import type { PermissionKey, RoleKey } from "./types.js";

export const PERMISSIONS: Record<PermissionKey, string> = {
  "pms.reservation.read": "Read reservations and arrivals",
  "pms.reservation.create": "Create reservations",
  "pms.reservation.modify": "Modify reservations",
  "pms.checkin.execute": "Execute guest check-in",
  "pms.checkout.execute": "Execute guest check-out",
  "folio.charge.post": "Post folio charges",
  "folio.read": "Read folios, folio balances and routing rules",
  "payment.capture": "Capture payments",
  "payment.refund": "Refund payments",
  "invoice.issue": "Issue invoices",
  "invoice.cancel": "Cancel or rectify invoices",
  "invoice.read": "Read invoices, invoice lists and rectification history",
  "housekeeping.task.manage": "Manage housekeeping tasks",
  "maintenance.workorder.manage": "Manage maintenance work orders",
  "asset.capex.approve": "Approve capex",
  "accounting.journal.post": "Post accounting journals",
  "compliance.ses.submit": "Submit SES.HOSPEDAJES records",
  "compliance.ses.export": "Export SES.HOSPEDAJES batch files for manual upload",
  "compliance.ses.configure": "Configure SES.HOSPEDAJES credentials, schema templates and submission mode",
  "compliance.gdpr.manage": "Manage GDPR data subject requests, DSAR fulfillment, erasure and PII backfill",
  "guest_register.read": "Read Spain guest register records",
  "guest_register.create": "Create Spain guest register records",
  "guest_register.edit": "Edit Spain guest register records",
  "guest_register.sign": "Capture guest register signatures",
  "guest_register.submit": "Queue guest register records for authority submission",
  "guest_register.export": "Export guest register batches and evidence",
  "guest_register.annul": "Annul authority communications",
  "guest_register.correct": "Correct rejected guest register records",
  "guest_register.view_sensitive": "View sensitive guest register fields with audit logging",
  "guest_register.configure": "Configure guest register field, routing and retention settings",
  "ai.tool.execute": "Execute AI-backed tools",
  "ai.high_risk.confirm": "Confirm high-risk AI actions",
  "modules.read": "Read module catalog and enabled property modules",
  "modules.enable": "Enable property modules",
  "modules.disable": "Disable property modules",
  "integrations.read": "Read integration catalog and connections",
  "integrations.connect": "Connect integration providers",
  "integrations.disconnect": "Disconnect integration providers",
  "integrations.test": "Test integration connections",
  "integrations.manage_credentials": "Manage integration credential references",
  "distribution.read": "Read distribution hub data",
  "distribution.manage_rates": "Manage rates",
  "distribution.manage_inventory": "Manage inventory restrictions",
  "distribution.sync": "Run channel sync jobs",
  "distribution.ai_recommend": "View AI revenue recommendations",
  "payments.create_link": "Create payment links",
  "payments.capture": "Capture payments through payment vault",
  "payments.refund_request": "Request payment refunds",
  "payments.refund_approve": "Approve payment refunds",
  "billing.invoice.issue": "Issue compliance billing invoices",
  "billing.invoice.cancel": "Cancel compliance billing invoices",
  "billing.invoice.rectify": "Create rectifying invoices",
  "billing.compliance.view": "View invoice compliance status",
  "pos.order.create": "Create POS orders",
  "pos.order.charge_to_room": "Charge POS orders to rooms",
  "pos.order.pay": "Pay POS orders directly",
  "pos.product.manage": "Manage POS products",
  "pos.read": "Read POS outlets, tickets and cash summaries",
  "tourist_tax.read": "Read tourist tax rates and applications",
  "guest_experience.inbox.read": "Read guest experience inbox",
  "guest_experience.message.send": "Send guest messages",
  "guest_experience.ai_reply": "Draft AI guest replies",
  "guest_experience.handoff": "Hand guest conversations to staff",
  "owner.dashboard.read": "Read owner dashboard",
  "owner.ai_ask": "Ask owner dashboard AI questions",
  "assets.read": "Read asset intelligence",
  "assets.manage": "Manage asset intelligence records",
  "capex.read": "Read capex projects",
  "capex.create": "Create capex projects",
  "capex.approve": "Approve capex projects",
  "backoffice.access": "Access the Back Office control panel",
  "property.configure": "Configure organization and property settings",
  "configuration.read": "Read property configuration center, categories and setup forms",
  "configuration.manage": "Manage property configuration center settings",
  "categories.read": "Read property category definitions and options",
  "categories.manage": "Create, edit, deactivate, reactivate and reorder category options",
  "categories.import": "Import category options from CSV, XLSX or JSON with preview",
  "categories.export": "Export property category options",
  "custom_fields.read": "Read custom field definitions and values",
  "custom_fields.manage": "Create, edit and deactivate custom fields",
  "property_profile.edit": "Edit property profile and business-date settings",
  "room_types.manage": "Manage room types and room type defaults",
  "rooms.manage": "Manage rooms and room setup forms",
  "spaces.manage": "Manage spaces and bookable resources",
  "departments.manage": "Manage departments",
  "operations_setup.manage": "Manage housekeeping, maintenance and operations setup categories",
  "revenue_setup.manage": "Manage revenue setup categories and segment taxonomies",
  "compliance_setup.manage": "Manage compliance setup categories and controlled legal values",
  "ai_category_setup.use": "Use AI setup assistant for category suggestions",
  "property.map.read": "Read property map, rooms, spaces, and assets",
  "property.map.manage": "Manage buildings, floors, zones, rooms, spaces, and map positions",
  "property.import": "Import property map data from CSV or XLSX",
  "property.go_live": "Approve property go-live",
  "modules.configure": "Configure enabled property modules",
  "integrations.configure": "Configure integration connections",
  "integrations.view_logs": "View integration event logs",
  "users.read": "Read staff and user assignments",
  "users.invite": "Invite users",
  "users.disable": "Disable users",
  "roles.manage": "Manage roles",
  "permissions.manage": "Manage permissions",
  "tax.configure": "Configure tax settings",
  "compliance.configure": "Configure compliance settings",
  "billing.configure": "Configure billing and invoice sequences",
  "accounting.configure": "Configure accounting settings",
  "payments.configure": "Configure payment providers and payment policy",
  "ai.configure": "Configure AI settings and tool automation",
  "templates.read": "Read document templates",
  "templates.manage": "Manage document templates",
  "revenue.read": "Read revenue and profit engine dashboards",
  "revenue.forecast.read": "Read revenue forecasts and forecast accuracy",
  "revenue.recommend": "Generate revenue recommendations",
  "revenue.manage_rates": "Manage revenue rates and restrictions",
  "revenue.manage_restrictions": "Manage revenue restrictions, stop sell, CTA, CTD and length-of-stay controls",
  "revenue.apply_recommendations": "Apply approved revenue recommendations",
  "revenue.automation.manage": "Manage revenue automation rules and safe auto-apply constraints",
  "revenue.configure": "Configure revenue engine rules",
  "revenue.history_forecast.read": "Read Revenue History & Forecast visual dashboards and report tables",
  "revenue.history_forecast.export": "Export Revenue History & Forecast reports to PDF, CSV, XLSX or JSON",
  "revenue.history_forecast.configure": "Configure Revenue History & Forecast defaults, visible KPIs and alert thresholds",
  "revenue.history_forecast.saved_views.manage": "Create and manage saved Revenue History & Forecast report views",
  "revenue.forecast_confidence.read": "Read forecast confidence bands, drivers and data quality signals",
  "revenue.comparison.read": "Compare revenue periods against previous period, last year or custom ranges",
  "revenue.visual_alerts.read": "Read visual revenue alerts for low demand, confidence, parity and sync risks",
  "revenue.scheduled_reports.manage": "Manage scheduled Revenue History & Forecast owner reports",
  "channel_manager.read": "Read channel manager dashboards, sync health and mapping status",
  "channel_manager.manage": "Manage channel connections",
  "channel_manager.sync": "Run channel manager ARI sync jobs",
  "channel_manager.mappings.manage": "Manage channel room and rate mappings",
  "channel_manager.parity.read": "Read channel rate parity alerts and parity monitoring",
  "guests.read": "Read guest profiles and stay history",
  "guests.manage": "Create and edit guest profiles",
  "crm.read": "Read CRM guest profiles",
  "crm.manage_profiles": "Manage CRM guest profiles",
  "crm.manage_campaigns": "Manage CRM campaigns",
  "crm.manage_loyalty": "Manage loyalty programs",
  "crm.export": "Export CRM profile and campaign data",
  "groups.read": "Read group bookings",
  "groups.manage": "Manage group bookings",
  "groups.block_inventory": "Block inventory for groups",
  "groups.manage_billing": "Manage group billing",
  "events.read": "Read events and function diary",
  "events.manage": "Manage events",
  "events.manage_spaces": "Manage event spaces",
  "sales.pipeline.read": "Read sales pipeline",
  "sales.pipeline.manage": "Manage sales pipeline",
  "workforce.read": "Read workforce schedules",
  "workforce.schedule.manage": "Manage staff schedules",
  "workforce.timeclock.use": "Use staff time clock",
  "workforce.timeclock.manage": "Manage time clock records",
  "workforce.labor_cost.view": "View labor cost dashboards",
  "workforce.payroll_export": "Export payroll data",
  "payroll.manage": "Manage payroll contracts, periods and payroll calculation runs",
  "banking.reconcile": "Manage bank accounts, statement imports and reconciliation matching",
  "payroll.read": "Read payroll contracts, periods, payslips and exports",
  // Tanda RRHH (2026-09-20, docs/design/RRHH-PLANTILLA-NOMINA.md §9): expediente, convenio, estándares y plantilla máxima.
  "hr.employee.read": "Read the employee files (expedientes): list without PII, detail with the decrypted fields the scope allows",
  "hr.employee.manage": "Create, update and terminate employee files (expedientes) and their contracts",
  "hr.config.manage": "Manage collective agreements and their rules (jornada anual, pagas, topes, preavisos)",
  "hr.standards.manage": "Manage the staffing standards of a work centre per USALI department and driver",
  "hr.staffing.approve": "Approve the maximum staffing plan (FTE per department and season) of a work centre",
  "banking.read": "Read bank accounts, balances, statements and reconciliation status",
  "commissions.read": "Read commission rules, accruals and summaries",
  "accounting.read": "Read fiscal years, fiscal periods and exchange rates",
  "accounting.reports.read":
    "Read the accounting books and reports with amounts: journal, ledger, VAT books, AEAT models, annual accounts, USALI, supplier bills and depreciation runs",
  "notifications.manage": "Manage notification templates, dispatch and delivery retries",
  "procurement.read": "Read procurement records",
  "procurement.manage": "Manage procurement records",
  "purchase_orders.create": "Create purchase orders",
  "purchase_orders.approve": "Approve purchase orders",
  "purchase_orders.receive": "Receive purchase orders",
  "inventory.read": "Read inventory stock",
  "inventory.manage": "Manage inventory items and locations",
  "inventory.stock_count": "Perform stock counts",
  "inventory.adjust": "Adjust inventory stock",
  "guest_portal.configure": "Configure guest portal",
  "guest_self_service.read": "Read guest self-service status",
  "guest_self_service.manage": "Manage guest self-service actions",
  "kiosk.configure": "Configure kiosk flows",
  "digital_key.configure": "Configure digital key adapters",
  "reputation.read": "Read reputation dashboards",
  "reputation.respond": "Respond to guest reviews",
  "surveys.read": "Read surveys and responses",
  "surveys.manage": "Manage surveys",
  "quality_cases.read": "Read quality cases",
  "quality_cases.manage": "Manage quality cases",
  "energy.read": "Read energy dashboards",
  "energy.manage": "Manage utility meters and readings",
  "sustainability.read": "Read sustainability dashboards",
  "sustainability.report": "Generate sustainability reports",
  "iot.manage": "Manage IoT and smart meter integrations",
  "incidents.read": "Read safety incidents",
  "incidents.manage": "Manage safety incidents",
  "safety_checks.read": "Read safety checks",
  "safety_checks.manage": "Manage safety checks",
  "insurance_cases.manage": "Manage insurance cases",
  "analytics.read": "Read analytics dashboards",
  "analytics.configure": "Configure analytics platform",
  "analytics.export": "Export analytics data",
  "analytics.ai_ask": "Ask analytics AI questions",
  "metrics.manage": "Manage semantic metrics",
  "developer.read": "Read developer platform",
  "developer.manage_apps": "Manage developer apps",
  "developer.manage_webhooks": "Manage webhooks",
  "developer.view_api_logs": "View API usage logs",
  "developer.manage_sandbox": "Manage developer sandbox",
  "ai_governance.read": "Read AI governance center",
  "ai_governance.configure": "Configure AI governance policies",
  "ai_evals.manage": "Manage AI evaluations",
  "ai_incidents.read": "Read AI incidents",
  "ai_incidents.manage": "Manage AI incidents",
  "ai_prompts.manage": "Manage AI prompt versions",
  "ai_tool_registry.manage": "Manage AI tool registry",
  "onboarding.read": "Read AI onboarding and migration projects",
  "onboarding.create": "Create AI onboarding projects",
  "onboarding.upload": "Upload onboarding source files and exports",
  "onboarding.connect_source": "Connect source PMS systems for migration",
  "onboarding.ai_extract": "Run AI document extraction for onboarding",
  "onboarding.ai_map": "Run AI schema mapping for onboarding",
  "onboarding.review": "Review, approve, edit or reject onboarding mappings",
  "onboarding.apply": "Apply approved migration batches",
  "onboarding.rollback": "Rollback eligible migration batches",
  "onboarding.go_live": "Approve onboarding go-live readiness",
  "onboarding.view_sensitive": "View sensitive onboarding previews and source records",
  "onboarding.manage_cutover": "Manage cutover plan, freeze window and delta import",
  "audit.read": "Read audit logs",
  // Tanda 6b (L1 · estructura societaria, 2026-09-16): whole-entity finance
  // reads (every work centre of the sociedad, not only the assigned properties)
  // and the management of the legal entity and its centres (NIF, razón social,
  // series, establishments — riskLevel "high" on its routes, L2).
  "accounting.entity.read": "Read the finances of the whole legal entity (every work centre, not only the assigned properties)",
  "organization.structure.manage": "Manage the legal entity and its work centres (NIF, razón social, series, establishments)",
  // Tanda 8a (L0 · RBAC por departamento y nivel, 2026-09-18): the 27 keys of
  // docs/design/RBAC-DEPARTAMENTOS.md §4.6. Routes and services that gate on
  // them are wired by L1/L2 (rbac module, payables, night-audit, POS, payroll,
  // rate changes, real estate); until then they are catalog + template data.
  "pms.reservation.discount": "Apply a reservation discount within the operative threshold with a reason code",
  "pms.reservation.override": "Override rates, restrictions, overbooking and occupancy limits on a reservation",
  "folio.adjust": "Post folio adjustments and rebates within the operative threshold with a reason code",
  "folio.adjust_approve": "Approve folio adjustments and rebates above the operative threshold",
  "invoice.cancel_request": "Request the cancellation of an issued invoice",
  "invoice.cancel_approve": "Approve the cancellation of an issued invoice (issuer never approves)",
  "night_audit.run": "Run the night audit (end of day) of a property",
  "night_audit.review": "Review the night audit pack the morning after (income audit)",
  "night_audit.reopen": "Reopen a closed business day with a reason code",
  "housekeeping.read": "Read housekeeping boards, room status and task lists",
  "maintenance.read": "Read maintenance work orders, assets and preventive plans",
  "maintenance.workorder.create": "Open a maintenance work order (any employee)",
  "pos.order.void": "Void a POS ticket of the day with a reason code",
  "payables.read": "Read supplier bills, expenses and payables aging",
  "payables.create": "Register supplier bills and expenses",
  "payables.approve": "Approve supplier bills up to the role threshold",
  "payables.pay": "Order supplier payments and SEPA remittances",
  // Tanda T9 (documentos y digitalización con IA, docs/design/DOCUMENTOS-DIGITALIZACION.md §6.2)
  "documents.capture": "Capture incoming documents at the work centre (upload, photo, dispatch bag) and send them to the office",
  "documents.review": "Review digitised documents at the office: assign, correct the extracted fields, approve the proposed action or reject",
  "documents.archive.read": "Search and read the document archive (originals, metadata, retention)",
  "documents.admin": "Administer the document module: retention, legal hold, block and purge, AI extraction settings of the organisation",
  "accounting.period.close": "Close fiscal periods and fiscal years",
  "payroll.approve": "Approve the monthly payroll register and salary changes",
  "revenue.rates.approve": "Approve bulk or out-of-band rate changes",
  "real_estate.read": "Read the real-estate file of the property (title, encumbrances, contracts, insurance, inspections)",
  "real_estate.manage": "Maintain the real-estate file of the property",
  "real_estate.documents.manage": "Upload and manage real-estate documents (deeds, plans, licences, inspection reports)",
  "property_tax.manage": "Manage property taxes and municipal levies (IBI, IAE, tasas)",
  "users.assign": "Assign and revoke role assignments within the own scope and level",
  "compliance.read": "Read compliance centre, settings, obligations and data-protection requests",
  "security.break_glass": "Open an audited emergency (break glass) session",
  "admin.tenants.manage": "Manage platform tenants (ehotelOS staff console; never granted to hotel roles)"
};

// ---------------------------------------------------------------------------
// Platform vs organization scope
// ---------------------------------------------------------------------------
// Platform keys authorise HotelOS staff surfaces (tenant console). They live in
// the catalog so the DB converges to a single source, but they must never be
// part of an organization role template: `isPlatformAdmin` is derived from the
// REAL grant of these keys, so leaking one into "owner" would turn every hotel
// owner into a platform admin. Any future `admin.*` / `platform.*` key is
// treated as platform scope automatically.

export const PLATFORM_PERMISSION_KEYS: readonly PermissionKey[] = ["admin.tenants.manage"];

export function isPlatformPermission(key: string): boolean {
  return (
    (PLATFORM_PERMISSION_KEYS as readonly string[]).includes(key) ||
    key.startsWith("admin.") ||
    key.startsWith("platform.")
  );
}

/** Every catalog key an organization role may hold: keys(PERMISSIONS) minus the platform scope. */
export const ORG_PERMISSION_KEYS: readonly PermissionKey[] = (Object.keys(PERMISSIONS) as PermissionKey[]).filter(
  (key) => !isPlatformPermission(key)
);

// ---------------------------------------------------------------------------
// Role templates
// ---------------------------------------------------------------------------
// Applied to Role rows by name (see apps/api/src/lib/rbac-catalog.ts): "owner"
// is what createTenant / bootstrapPilot grant to the first user of a tenant and
// what the boot-time backfill applies to template-named roles that still have
// zero permissions. Templates are ORG scope only (structurally for owner/admin,
// by construction for the hand-picked ones).
//
// Tanda 5 (L1a · rbac, 2026-09-15): the navigation tree of
// pilots/tanda5-nav-tree.md §3 maps every menu token to templates
// (direccion = owner+manager, recepcion = receptionist, pisos = housekeeper,
// mantenimiento = maintenance, revenue = revenue, finanzas = accountant+
// compliance, comercial = sales, fnb = fnb, admin = admin). §10 crossed the
// main API route of every item/tab (apps/api/src/security/route-permissions.ts)
// with these templates and found them too narrow: no template but owner/admin
// could open a single /dashboards/* screen (analytics.read), i.e. "Mi día".
// The deltas applied here follow least privilege:
//   - READ keys of the item's domain are granted (analytics.read first).
//   - A nominally-write key is granted only when it is the ONLY gate of the
//     GET that opens a screen the template owns: folio.charge.post for
//     accountant (posting to folios is billing work) and fnb (charge to room),
//     compliance.ses.submit for receptionist (§11 task 12: reception signs and
//     sends the SES traveller parts), compliance.gdpr.manage for manager and
//     compliance (data-protection requests).
//   - Tanda 5 (L1b · api-side, 2026-09-15): the GET routes that had no read
//     key are now gated by folio.read (folios, balances, routing rules),
//     pos.read (outlets, tickets, cash summary), tourist_tax.read (rates and
//     applications), billing.compliance.view (VeriFactu / TicketBAI / IGIC
//     submissions and the compliance inbox) and guest_register.read (guest
//     register records, SES submissions). Every template whose token sees the
//     screen holds the read key; the write keys above stay where they were
//     (the boot top-up is additive: nothing is ever removed from a role).
//   - Rejected (documented in tests/rbac-nav-contract.test.mjs JUSTIFIED_GAPS):
//     accounting.journal.post for manager/compliance (only a POST needs it),
//     folio.charge.post / billing.configure for compliance and
//     compliance.configure / compliance.gdpr.manage / compliance.ses.submit
//     for accountant (the sibling template of the same `finanzas` token holds
//     them — assign both roles to one person when the hotel has no split),
//     backoffice.access for receptionist (wrong attribution in the inventory),
//     inventory.read for receptionist (moved to fnb, as §10 foresaw).
//   - Tanda 5 (L1c · api, 2026-09-15): (1) modules.read in EVERY template —
//     GET /backoffice/properties/:id/modules feeds the menu (modulesAny) and
//     a 403 there hid every module-gated entry (Punto de venta, Cartas,
//     Canales…) for the 8 templates without it; (2) invoice.read on the
//     invoice GETs (were invoice.issue), payroll.read / banking.read /
//     commissions.read / accounting.read on the finance GETs that were
//     open to every template through analytics.read; (3) the read keys of
//     the secondary GETs of visible screens (incidents.read +
//     safety_checks.read, workforce.read, events.read, revenue.read for
//     sales, ai_incidents.read for manager, pms.reservation.read for
//     maintenance; accounting.read for receptionist: the compliance inbox
//     warns about closing fiscal periods). Payroll and banking stay out of
//     compliance (sister accountant of the finanzas token holds them:
//     employee data, money).
// The boot-time top-up (Role.templateKey, lib/rbac-catalog.ts) delivers every
// key added here to the existing template roles; custom roles are never
// touched.
//
// Tanda 8a (L0 · RBAC por departamento y nivel, 2026-09-18) — TEMPLATE
// VERSION 2 (docs/design/RBAC-DEPARTAMENTOS.md §4.2-§4.7, §6.5). The 24
// templates below are the cells of the matrices §4.4 (hotel scope) and §4.5
// (central scope) expanded with the module → keys dictionary of §4.3
// (V ver · C crear/ejecutar · E editar/configurar · S solicitar · A aprobar ·
// X anular/reembolsar/reabrir · P exportar), plus the explicit L0 rules noted
// per template. Rules of the version:
//   - A change that ADDS keys to a template stays additive: the boot top-up
//     (applyRoleTemplate / backfillTemplateRoles) delivers it to every
//     managed role on the next start, as before.
//   - A change that REMOVES keys from a template is a NEW VERSION: bump
//     ROLE_TEMPLATE_VERSION and list the removed keys in
//     ROLE_TEMPLATE_REVOCATIONS[template]. The boot top-up NEVER revokes; the
//     revocations are applied only by `rbac:sync --upgrade-templates`
//     (upgradeRoleTemplate: managed roles with templateVersion < current lose
//     exactly those keys, gain the missing ones, get the version stamped and
//     an audit event ROLE_TEMPLATE_UPGRADED). Roles with managed = false are
//     never touched. tests/rbac-sod-contract.test.mjs pins that a revocation
//     is never also in the template and that every template respects the
//     static separation-of-duties pairs (SOD_STATIC_PAIRS, rbac-types.ts).
//   - `break_glass` is the whole org scope by construction (§4.8) and is never
//     provisioned by default (ORGANIZATION_TEMPLATE_ROLE_KEYS excludes it and
//     `admin`); `owner` is read + approvals, `admin` is system administration
//     without financial or operational keys (token `sistemas`, H11).

export const ROLE_PERMISSION_MAP: Record<RoleKey, PermissionKey[]> = {
  // Recepción (N1 · property · token recepcion)
  receptionist: [
    // M1 Reservas y recepción · V C E S
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    "pms.reservation.create",
    "pms.checkin.execute",
    "pms.checkout.execute",
    "guest_experience.message.send",
    "pms.reservation.modify",
    "guests.manage",
    "guest_experience.ai_reply",
    "guest_experience.handoff",
    "pms.reservation.discount",
    // M2 Folios y cobros · V C E S
    "folio.read",
    "folio.charge.post",
    "payment.capture",
    "payments.capture",
    "payments.create_link",
    "folio.adjust",
    "payments.refund_request",
    // M3 Facturación · V C S
    "invoice.read",
    "billing.compliance.view",
    "invoice.issue",
    "billing.invoice.issue",
    "invoice.cancel_request",
    // M4 Cierre del día · V
    "analytics.read",
    // M5 Pisos · V
    "housekeeping.read",
    // M6 Mantenimiento, energía y seguridad · V C
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    "maintenance.workorder.create",
    // M7 TPV y A&B · V C
    "pos.read",
    "pos.order.create",
    "pos.order.charge_to_room",
    "pos.order.pay",
    // M10 Contabilidad · V3
    "accounting.read",
    // M12 Nóminas y personal · C
    "workforce.timeclock.use",
    // M15 Cumplimiento y registro de viajeros · V C E
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    "guest_register.create",
    "guest_register.sign",
    "guest_register.submit",
    "compliance.ses.submit",
    "guest_register.edit",
    "guest_register.correct",
    "compliance.ses.export",
    // M16 Revenue y distribución · V
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    // M17 Comercial, grupos y CRM · V C
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · V C
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    // Documentos y digitalización (Tanda T9) · C
    "documents.capture"
  ],
  // Auditoría nocturna (N1 · property · token recepcion)
  night_auditor: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V C E
    "folio.read",
    "folio.charge.post",
    "payment.capture",
    "payments.capture",
    "payments.create_link",
    "folio.adjust",
    // M3 Facturación · V C
    "invoice.read",
    "billing.compliance.view",
    "invoice.issue",
    "billing.invoice.issue",
    // M4 Cierre del día · V C
    "analytics.read",
    "night_audit.run",
    // M5 Pisos · V
    "housekeeping.read",
    // M6 Mantenimiento, energía y seguridad · V C
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    "maintenance.workorder.create",
    // M7 TPV y A&B · V
    "pos.read",
    // M10 Contabilidad · V3
    "accounting.read",
    // M12 Nóminas y personal · C
    "workforce.timeclock.use",
    // M15 Cumplimiento y registro de viajeros · V C
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    "guest_register.create",
    "guest_register.sign",
    "guest_register.submit",
    "compliance.ses.submit",
    // M16 Revenue y distribución · V
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · V C
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute"
  ],
  // Jefatura de recepción (N2 · property · token recepcion)
  front_office_manager: [
    // M1 Reservas y recepción · V C E S A
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    "pms.reservation.create",
    "pms.checkin.execute",
    "pms.checkout.execute",
    "guest_experience.message.send",
    "pms.reservation.modify",
    "guests.manage",
    "guest_experience.ai_reply",
    "guest_experience.handoff",
    "pms.reservation.discount",
    "pms.reservation.override",
    // M2 Folios y cobros · V C2 E S A
    "folio.read",
    "folio.charge.post",
    "payments.create_link",
    "folio.adjust",
    "payments.refund_request",
    "folio.adjust_approve",
    "payments.refund_approve",
    // M3 Facturación · V C E S
    "invoice.read",
    "billing.compliance.view",
    "invoice.issue",
    "billing.invoice.issue",
    "billing.invoice.rectify",
    "invoice.cancel_request",
    // M4 Cierre del día · V C
    "analytics.read",
    "night_audit.run",
    // M5 Pisos · V
    "housekeeping.read",
    // M6 Mantenimiento, energía y seguridad · V C
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    "maintenance.workorder.create",
    // M7 TPV y A&B · V
    "pos.read",
    // M8 Compras e inventario · V S
    "procurement.read",
    "inventory.read",
    "purchase_orders.create",
    // M10 Contabilidad · V3
    "accounting.read",
    // M12 Nóminas y personal · V C E4
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "workforce.timeclock.use",
    "workforce.schedule.manage",
    "workforce.timeclock.manage",
    // M15 Cumplimiento y registro de viajeros · V C E X
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    "guest_register.create",
    "guest_register.sign",
    "guest_register.submit",
    "compliance.ses.submit",
    "guest_register.edit",
    "guest_register.correct",
    "compliance.ses.export",
    "guest_register.annul",
    // M16 Revenue y distribución · V
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    // M17 Comercial, grupos y CRM · V E
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    "crm.manage_profiles",
    "crm.manage_campaigns",
    "crm.manage_loyalty",
    "groups.manage",
    "groups.block_inventory",
    "groups.manage_billing",
    "events.manage",
    "events.manage_spaces",
    "sales.pipeline.manage",
    "reputation.respond",
    "surveys.manage",
    "quality_cases.manage",
    "guest_self_service.manage",
    "guest_portal.configure",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M21 Usuarios, roles y auditoría · V
    "users.read",
    "audit.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · V C A
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // Documentos y digitalización (Tanda T9) · C
    "documents.capture"
  ],
  // Pisos (N1 · property · token pisos)
  housekeeper: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M5 Pisos · V E
    "housekeeping.read",
    "housekeeping.task.manage",
    "rooms.manage",
    // M6 Mantenimiento, energía y seguridad · C
    "maintenance.workorder.create",
    // M12 Nóminas y personal · V6 C
    "workforce.read",
    "workforce.timeclock.use",
    // M18 Informes y analítica · V
    "analytics.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C
    "ai.tool.execute"
  ],
  // Gobernanta (N2 · property · token pisos)
  housekeeping_manager: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M5 Pisos · V E
    "housekeeping.read",
    "housekeeping.task.manage",
    "rooms.manage",
    // M6 Mantenimiento, energía y seguridad · V C
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    "maintenance.workorder.create",
    // M8 Compras e inventario · V S C
    "procurement.read",
    "inventory.read",
    "purchase_orders.create",
    "purchase_orders.receive",
    "inventory.stock_count",
    // M12 Nóminas y personal · V C E4
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "workforce.timeclock.use",
    "workforce.schedule.manage",
    "workforce.timeclock.manage",
    // M18 Informes y analítica · V
    "analytics.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M21 Usuarios, roles y auditoría · V
    "users.read",
    "audit.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C A
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // Documentos y digitalización (Tanda T9) · C
    "documents.capture"
  ],
  // Mantenimiento (N1 · property · token mantenimiento)
  maintenance: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M5 Pisos · V
    "housekeeping.read",
    // M6 Mantenimiento, energía y seguridad · V C E
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    "maintenance.workorder.create",
    "maintenance.workorder.manage",
    "incidents.manage",
    "safety_checks.manage",
    "energy.manage",
    "iot.manage",
    "insurance_cases.manage",
    "sustainability.report",
    // M8 Compras e inventario · V S
    "procurement.read",
    "inventory.read",
    "purchase_orders.create",
    // M12 Nóminas y personal · V6 C
    "workforce.read",
    "workforce.timeclock.use",
    // M18 Informes y analítica · V
    "analytics.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C
    "ai.tool.execute"
  ],
  // Encargado de mantenimiento (N2 · property · token mantenimiento)
  maintenance_manager: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M5 Pisos · V E
    "housekeeping.read",
    "housekeeping.task.manage",
    "rooms.manage",
    // M6 Mantenimiento, energía y seguridad · V C E
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    "maintenance.workorder.create",
    "maintenance.workorder.manage",
    "incidents.manage",
    "safety_checks.manage",
    "energy.manage",
    "iot.manage",
    "insurance_cases.manage",
    "sustainability.report",
    // M8 Compras e inventario · V S C
    "procurement.read",
    "inventory.read",
    "purchase_orders.create",
    "purchase_orders.receive",
    "inventory.stock_count",
    // M9 Facturas de proveedor y pagos · V
    "payables.read",
    // M12 Nóminas y personal · V C E4
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "workforce.timeclock.use",
    "workforce.schedule.manage",
    "workforce.timeclock.manage",
    // M13 Inmovilizado y CAPEX · V S
    "assets.read",
    "capex.read",
    "capex.create",
    // M14 Gestión del activo · V C
    "real_estate.read",
    "real_estate.documents.manage",
    // M18 Informes y analítica · V
    "analytics.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M21 Usuarios, roles y auditoría · V
    "users.read",
    "audit.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C A
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // Documentos y digitalización (Tanda T9) · C
    "documents.capture"
  ],
  // Punto de venta (N1 · property · token fnb)
  fnb: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · C
    "folio.charge.post",
    "payment.capture",
    "payments.capture",
    "payments.create_link",
    // M6 Mantenimiento, energía y seguridad · C
    "maintenance.workorder.create",
    // M7 TPV y A&B · V C
    "pos.read",
    "pos.order.create",
    "pos.order.charge_to_room",
    "pos.order.pay",
    // M8 Compras e inventario · V S C
    "procurement.read",
    "inventory.read",
    "purchase_orders.create",
    "purchase_orders.receive",
    "inventory.stock_count",
    // M12 Nóminas y personal · V6 C
    "workforce.read",
    "workforce.timeclock.use",
    // M18 Informes y analítica · V
    "analytics.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C
    "ai.tool.execute"
  ],
  // Jefatura de A&B (N2 · property · token fnb)
  fnb_manager: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V C
    "folio.read",
    "folio.charge.post",
    "payment.capture",
    "payments.capture",
    "payments.create_link",
    // M3 Facturación · V
    "invoice.read",
    "billing.compliance.view",
    // M6 Mantenimiento, energía y seguridad · V C
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    "maintenance.workorder.create",
    // M7 TPV y A&B · V C E X
    "pos.read",
    "pos.order.create",
    "pos.order.charge_to_room",
    "pos.order.pay",
    "pos.product.manage",
    "pos.order.void",
    // M8 Compras e inventario · V S C E
    "procurement.read",
    "inventory.read",
    "purchase_orders.create",
    "purchase_orders.receive",
    "inventory.stock_count",
    "procurement.manage",
    "inventory.manage",
    "inventory.adjust",
    // M9 Facturas de proveedor y pagos · V
    "payables.read",
    // M12 Nóminas y personal · V C E4
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "workforce.timeclock.use",
    "workforce.schedule.manage",
    "workforce.timeclock.manage",
    // M18 Informes y analítica · V
    "analytics.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M21 Usuarios, roles y auditoría · V
    "users.read",
    "audit.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C A
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // Documentos y digitalización (Tanda T9) · C
    "documents.capture"
  ],
  // Comercial (N1 · property / group · token comercial)
  sales: [
    // M1 Reservas y recepción · V C5 E
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    "pms.reservation.create",
    "guest_experience.message.send",
    "pms.reservation.modify",
    "guests.manage",
    "guest_experience.ai_reply",
    "guest_experience.handoff",
    // M12 Nóminas y personal · C
    "workforce.timeclock.use",
    // M16 Revenue y distribución · V
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    // M17 Comercial, grupos y CRM · V C E P
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    "commissions.read",
    "crm.manage_profiles",
    "crm.manage_campaigns",
    "crm.manage_loyalty",
    "groups.manage",
    "groups.block_inventory",
    "groups.manage_billing",
    "events.manage",
    "events.manage_spaces",
    "sales.pipeline.manage",
    "reputation.respond",
    "surveys.manage",
    "quality_cases.manage",
    "guest_self_service.manage",
    "guest_portal.configure",
    "crm.export",
    // M18 Informes y analítica · V
    "analytics.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C
    "ai.tool.execute"
  ],
  // Administración de hotel (N1 · property · token administracion)
  admin_clerk: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V X
    "folio.read",
    "payment.refund",
    // M3 Facturación · V C E S
    "invoice.read",
    "billing.compliance.view",
    "invoice.issue",
    "billing.invoice.issue",
    "billing.invoice.rectify",
    "invoice.cancel_request",
    // M4 Cierre del día · V A
    "analytics.read",
    "night_audit.review",
    // M6 Mantenimiento, energía y seguridad · V
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    // M7 TPV y A&B · V
    "pos.read",
    // M8 Compras e inventario · V C E
    "procurement.read",
    "inventory.read",
    "purchase_orders.receive",
    "inventory.stock_count",
    "procurement.manage",
    "inventory.manage",
    "inventory.adjust",
    // M9 Facturas de proveedor y pagos · V C
    "payables.read",
    "payables.create",
    // M10 Contabilidad · V
    "accounting.read",
    "accounting.reports.read",
    // M11 Tesorería y bancos · V E
    "banking.read",
    "banking.reconcile",
    // M12 Nóminas y personal · V C
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "workforce.timeclock.use",
    // M13 Inmovilizado y CAPEX · V
    "assets.read",
    "capex.read",
    // M14 Gestión del activo · V C
    "real_estate.read",
    "real_estate.documents.manage",
    // M15 Cumplimiento y registro de viajeros · V
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C
    "ai.tool.execute",
    // Documentos y digitalización (Tanda T9) · V C A
    "documents.capture",
    "documents.review",
    "documents.archive.read"
  ],
  // Dirección de hotel (N3 · property · token direccion)
  manager: [
    // M1 Reservas y recepción · V C E S A
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    "pms.reservation.create",
    "pms.checkin.execute",
    "pms.checkout.execute",
    "guest_experience.message.send",
    "pms.reservation.modify",
    "guests.manage",
    "guest_experience.ai_reply",
    "guest_experience.handoff",
    "pms.reservation.discount",
    "pms.reservation.override",
    // M2 Folios y cobros · V C2 E S A
    "folio.read",
    "folio.charge.post",
    "payments.create_link",
    "folio.adjust",
    "payments.refund_request",
    "folio.adjust_approve",
    "payments.refund_approve",
    // M3 Facturación · V A X
    "invoice.read",
    "billing.compliance.view",
    "invoice.cancel_approve",
    "invoice.cancel",
    "billing.invoice.cancel",
    // M4 Cierre del día · V A X
    "analytics.read",
    "night_audit.review",
    "night_audit.reopen",
    // M5 Pisos · V E
    "housekeeping.read",
    "housekeeping.task.manage",
    "rooms.manage",
    // M6 Mantenimiento, energía y seguridad · V C E
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    "maintenance.workorder.create",
    "maintenance.workorder.manage",
    "incidents.manage",
    "safety_checks.manage",
    "energy.manage",
    "iot.manage",
    "insurance_cases.manage",
    "sustainability.report",
    // M7 TPV y A&B · V C E X
    "pos.read",
    "pos.order.create",
    "pos.order.charge_to_room",
    "pos.order.pay",
    "pos.product.manage",
    "pos.order.void",
    // M8 Compras e inventario · V A
    "procurement.read",
    "inventory.read",
    "purchase_orders.approve",
    // M9 Facturas de proveedor y pagos · V A
    "payables.read",
    "payables.approve",
    // M10 Contabilidad · V
    "accounting.read",
    "accounting.reports.read",
    // M11 Tesorería y bancos · V
    "banking.read",
    // M12 Nóminas y personal · V C E4 A
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "workforce.timeclock.use",
    "workforce.schedule.manage",
    "workforce.timeclock.manage",
    "payroll.approve",
    // Tanda RRHH (2026-09-20) · expediente · V (listado sin PII de su centro)
    "hr.employee.read",
    // M13 Inmovilizado y CAPEX · V S
    "assets.read",
    "capex.read",
    "capex.create",
    // M14 Gestión del activo · V C
    "real_estate.read",
    "real_estate.documents.manage",
    // M15 Cumplimiento y registro de viajeros · V C E X
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    "guest_register.create",
    "guest_register.sign",
    "guest_register.submit",
    "compliance.ses.submit",
    "guest_register.edit",
    "guest_register.correct",
    "compliance.ses.export",
    "guest_register.annul",
    // M15b Configuración de cumplimiento y fiscal · E
    "compliance.configure",
    "compliance.ses.configure",
    "compliance.gdpr.manage",
    "guest_register.configure",
    "tax.configure",
    "compliance_setup.manage",
    // M16 Revenue y distribución · V E
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    "revenue.manage_rates",
    "revenue.manage_restrictions",
    "revenue.apply_recommendations",
    "revenue.automation.manage",
    "revenue.configure",
    "revenue.history_forecast.configure",
    "revenue.scheduled_reports.manage",
    "revenue_setup.manage",
    "channel_manager.manage",
    "channel_manager.sync",
    "channel_manager.mappings.manage",
    "distribution.manage_rates",
    "distribution.manage_inventory",
    "distribution.sync",
    // M17 Comercial, grupos y CRM · V E
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    "commissions.read",
    "crm.manage_profiles",
    "crm.manage_campaigns",
    "crm.manage_loyalty",
    "groups.manage",
    "groups.block_inventory",
    "groups.manage_billing",
    "events.manage",
    "events.manage_spaces",
    "sales.pipeline.manage",
    "reputation.respond",
    "surveys.manage",
    "quality_cases.manage",
    "guest_self_service.manage",
    "guest_portal.configure",
    // M18 Informes y analítica · V C
    "analytics.ai_ask",
    "analytics.export",
    "analytics.configure",
    "metrics.manage",
    // M18b Cuadro del propietario · V C
    "owner.dashboard.read",
    "owner.ai_ask",
    // M19 Configuración de la propiedad · V E
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    "property.configure",
    "property.map.manage",
    "property.import",
    "property.go_live",
    "configuration.manage",
    "categories.manage",
    "categories.import",
    "custom_fields.manage",
    "property_profile.edit",
    "room_types.manage",
    "spaces.manage",
    "departments.manage",
    "operations_setup.manage",
    "ai_category_setup.use",
    "templates.manage",
    "notifications.manage",
    "kiosk.configure",
    "digital_key.configure",
    "categories.export",
    // M21 Usuarios, roles y auditoría · V C X
    "users.read",
    "audit.read",
    "users.invite",
    "users.assign",
    "users.disable",
    // M22 Módulos · V E
    "modules.read",
    "modules.enable",
    "modules.disable",
    "modules.configure",
    // M22b Integraciones y desarrollo · V C E
    "integrations.read",
    "integrations.view_logs",
    "developer.read",
    "developer.view_api_logs",
    "integrations.test",
    "integrations.connect",
    "integrations.disconnect",
    "integrations.manage_credentials",
    "integrations.configure",
    "developer.manage_apps",
    "developer.manage_webhooks",
    "developer.manage_sandbox",
    // M23 IA · V C A E
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    "ai.configure",
    "ai_governance.configure",
    "ai_evals.manage",
    "ai_incidents.manage",
    "ai_prompts.manage",
    "ai_tool_registry.manage",
    // M24 Puesta en marcha y migración · V C E
    "onboarding.read",
    "onboarding.view_sensitive",
    "onboarding.create",
    "onboarding.upload",
    "onboarding.connect_source",
    "onboarding.ai_extract",
    "onboarding.ai_map",
    "onboarding.review",
    "onboarding.apply",
    "onboarding.manage_cutover",
    // Documentos y digitalización (Tanda T9) · V C
    "documents.capture",
    "documents.archive.read"
  ],
  // Dirección de operaciones (N4 · property_group / organization · token direccion)
  operations_director: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V
    "folio.read",
    // M3 Facturación · V
    "invoice.read",
    "billing.compliance.view",
    // M4 Cierre del día · V
    "analytics.read",
    // M5 Pisos · V
    "housekeeping.read",
    // M6 Mantenimiento, energía y seguridad · V
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    // M7 TPV y A&B · V
    "pos.read",
    // M8 Compras e inventario · V A
    "procurement.read",
    "inventory.read",
    "purchase_orders.approve",
    // M9 Facturas de proveedor y pagos · V A
    "payables.read",
    "payables.approve",
    // M10 Contabilidad · V
    "accounting.read",
    "accounting.reports.read",
    // M11 Tesorería y bancos · V
    "banking.read",
    // M12 Nóminas y personal · V A
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "payroll.approve",
    // Tanda RRHH (2026-09-20) · expediente · V
    "hr.employee.read",
    // M13 Inmovilizado y CAPEX · V S
    "assets.read",
    "capex.read",
    "capex.create",
    // M14 Gestión del activo · V
    "real_estate.read",
    // M15 Cumplimiento y registro de viajeros · V
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    // M16 Revenue y distribución · V A
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    "revenue.rates.approve",
    // M17 Comercial, grupos y CRM · V
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    "commissions.read",
    // M18 Informes y analítica · V C P
    "analytics.ai_ask",
    "analytics.export",
    "analytics.configure",
    "metrics.manage",
    // M18b Cuadro del propietario · V C
    "owner.dashboard.read",
    "owner.ai_ask",
    // M19 Configuración de la propiedad · V E
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    "property.configure",
    "property.map.manage",
    "property.import",
    "property.go_live",
    "configuration.manage",
    "categories.manage",
    "categories.import",
    "custom_fields.manage",
    "property_profile.edit",
    "room_types.manage",
    "spaces.manage",
    "departments.manage",
    "operations_setup.manage",
    "ai_category_setup.use",
    "templates.manage",
    "notifications.manage",
    "kiosk.configure",
    "digital_key.configure",
    "categories.export",
    // M20 Estructura societaria y fiscal · V
    "accounting.entity.read",
    "backoffice.access",
    // M21 Usuarios, roles y auditoría · V C X
    "users.read",
    "audit.read",
    "users.invite",
    "users.assign",
    "users.disable",
    // M22 Módulos · V
    "modules.read",
    // M22b Integraciones y desarrollo · V
    "integrations.read",
    "integrations.view_logs",
    "developer.read",
    "developer.view_api_logs",
    // M23 IA · V C A
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // M24 Puesta en marcha y migración · V C E A
    "onboarding.read",
    "onboarding.view_sensitive",
    "onboarding.create",
    "onboarding.upload",
    "onboarding.connect_source",
    "onboarding.ai_extract",
    "onboarding.ai_map",
    "onboarding.review",
    "onboarding.apply",
    "onboarding.manage_cutover",
    "onboarding.go_live",
    // Documentos y digitalización (Tanda T9) · V C
    "documents.capture",
    "documents.archive.read"
  ],
  // Revenue corporativo (N4 · organization · token revenue)
  revenue: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M12 Nóminas y personal · C
    "workforce.timeclock.use",
    // M16 Revenue y distribución · V C E A P
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    "revenue.recommend",
    "revenue.history_forecast.saved_views.manage",
    "distribution.ai_recommend",
    "revenue.manage_rates",
    "revenue.manage_restrictions",
    "revenue.apply_recommendations",
    "revenue.automation.manage",
    "revenue.configure",
    "revenue.history_forecast.configure",
    "revenue.scheduled_reports.manage",
    "revenue_setup.manage",
    "channel_manager.manage",
    "channel_manager.sync",
    "channel_manager.mappings.manage",
    "distribution.manage_rates",
    "distribution.manage_inventory",
    "distribution.sync",
    "revenue.rates.approve",
    "revenue.history_forecast.export",
    // M17 Comercial, grupos y CRM · V
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    // M18 Informes y analítica · V C P
    "analytics.read",
    "analytics.ai_ask",
    "analytics.export",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · V C A
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    "ai.high_risk.confirm"
  ],
  // Contabilidad (N7 · legal_entity · token finanzas)
  accountant: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V
    "folio.read",
    // M3 Facturación · V C E S
    "invoice.read",
    "billing.compliance.view",
    "invoice.issue",
    "billing.invoice.issue",
    "billing.invoice.rectify",
    "invoice.cancel_request",
    // M4 Cierre del día · V A
    "analytics.read",
    "night_audit.review",
    // M6 Mantenimiento, energía y seguridad · regla L0
    "maintenance.read",
    // M7 TPV y A&B · V
    "pos.read",
    // M8 Compras e inventario · V C E
    "procurement.read",
    "inventory.read",
    "purchase_orders.receive",
    "inventory.stock_count",
    "procurement.manage",
    "inventory.manage",
    "inventory.adjust",
    // M9 Facturas de proveedor y pagos · V C
    "payables.read",
    "payables.create",
    // M10 Contabilidad · V C E P
    "accounting.read",
    "accounting.reports.read",
    "accounting.journal.post",
    "accounting.configure",
    "analytics.export",
    // M11 Tesorería y bancos · V E
    "banking.read",
    "banking.reconcile",
    // M12 Nóminas y personal · V
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    // M13 Inmovilizado y CAPEX · V E
    "assets.read",
    "capex.read",
    "assets.manage",
    // M14 Gestión del activo · V
    "real_estate.read",
    // M15 Cumplimiento y registro de viajeros · V
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M20 Estructura societaria y fiscal · V
    "accounting.entity.read",
    "backoffice.access",
    // M22 Módulos · V
    "modules.read",
    // M22b Integraciones y desarrollo · V
    "integrations.read",
    "integrations.view_logs",
    "developer.read",
    "developer.view_api_logs",
    // M23 IA · V C A
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // Documentos y digitalización (Tanda T9) · V A
    "documents.review",
    "documents.archive.read"
  ],
  // Dirección financiera (N5 · legal_entity · token finanzas)
  controller: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V A X
    "folio.read",
    "folio.adjust_approve",
    "payments.refund_approve",
    "payment.refund",
    // M3 Facturación · V A X
    "invoice.read",
    "billing.compliance.view",
    "invoice.cancel_approve",
    "invoice.cancel",
    "billing.invoice.cancel",
    // M4 Cierre del día · V A X
    "analytics.read",
    "night_audit.review",
    "night_audit.reopen",
    // M6 Mantenimiento, energía y seguridad · regla L0
    "maintenance.read",
    // M7 TPV y A&B · V
    "pos.read",
    // M8 Compras e inventario · V A
    "procurement.read",
    "inventory.read",
    "purchase_orders.approve",
    // M9 Facturas de proveedor y pagos · V A X
    "payables.read",
    "payables.approve",
    "payables.pay",
    // M10 Contabilidad · V A
    "accounting.read",
    "accounting.reports.read",
    "accounting.period.close",
    // M11 Tesorería y bancos · V
    "banking.read",
    // M12 Nóminas y personal · V
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    // M13 Inmovilizado y CAPEX · V A
    "assets.read",
    "capex.read",
    "asset.capex.approve",
    // M14 Gestión del activo · V E
    "real_estate.read",
    "real_estate.manage",
    "property_tax.manage",
    // M15 Cumplimiento y registro de viajeros · V
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    // M16 Revenue y distribución · V
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    // M17 Comercial, grupos y CRM · V
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    "commissions.read",
    // M18 Informes y analítica · V C P
    "analytics.ai_ask",
    "analytics.export",
    // M18b Cuadro del propietario · V
    "owner.dashboard.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M20 Estructura societaria y fiscal · V E
    "accounting.entity.read",
    "backoffice.access",
    "organization.structure.manage",
    "billing.configure",
    "payments.configure",
    // M22 Módulos · V
    "modules.read",
    // M22b Integraciones y desarrollo · V
    "integrations.read",
    "integrations.view_logs",
    "developer.read",
    "developer.view_api_logs",
    // M23 IA · V C A
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // Documentos y digitalización (Tanda T9) · V A E
    "documents.review",
    "documents.archive.read",
    "documents.admin"
  ],
  // RRHH y nóminas (N7 · legal_entity · token rrhh)
  payroll_hr: [
    // M1 Reservas y recepción · V (solo lectura; fusión TL 2026-09-19 · versión 3: Hoy › Live Timeline para todos los perfiles)
    "pms.reservation.read",
    "guests.read",
    // M12 Nóminas y personal · V E P
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "payroll.manage",
    "workforce.schedule.manage",
    "workforce.timeclock.manage",
    "workforce.payroll_export",
    // Tanda RRHH (2026-09-20) · expediente, convenio y estándares · V E (sin hr.staffing.approve: aprueba
    // dirección general, SoD con payroll.manage; users.read la aporta CIERRE-1, ver M21 más abajo)
    "hr.employee.read",
    "hr.employee.manage",
    "hr.config.manage",
    "hr.standards.manage",
    // M17 Cumplimiento · V (Tanda RRHH: resumen de cumplimiento laboral y umbral de 50 personas)
    "compliance.read",
    // M18 Informes y analítica · V
    "analytics.read",
    // M21 Usuarios, roles y auditoría · V (CIERRE-1: selector «Persona» de la ficha de personal → GET /rbac/users)
    "users.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C A
    "ai.tool.execute",
    "ai.high_risk.confirm"
  ],
  // Cumplimiento (N7 · legal_entity · token finanzas)
  compliance: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V
    "folio.read",
    // M3 Facturación · V
    "invoice.read",
    "billing.compliance.view",
    // M6 Mantenimiento, energía y seguridad · V
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    // M10 Contabilidad · V
    "accounting.read",
    "accounting.reports.read",
    // M14 Gestión del activo · V E
    "real_estate.read",
    "real_estate.manage",
    "property_tax.manage",
    // M15 Cumplimiento y registro de viajeros · V C E X P
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    "guest_register.create",
    "guest_register.sign",
    "guest_register.submit",
    "compliance.ses.submit",
    "guest_register.edit",
    "guest_register.correct",
    "compliance.ses.export",
    "guest_register.annul",
    "guest_register.export",
    // M15b Configuración de cumplimiento y fiscal · E
    "compliance.configure",
    "compliance.ses.configure",
    "compliance.gdpr.manage",
    "guest_register.configure",
    "tax.configure",
    "compliance_setup.manage",
    // M18 Informes y analítica · V
    "analytics.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M20 Estructura societaria y fiscal · V
    "accounting.entity.read",
    "backoffice.access",
    // M22 Módulos · V
    "modules.read",
    // M22b Integraciones y desarrollo · V
    "integrations.read",
    "integrations.view_logs",
    "developer.read",
    "developer.view_api_logs",
    // M23 IA · V C A E
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    "ai.configure",
    "ai_governance.configure",
    "ai_evals.manage",
    "ai_incidents.manage",
    "ai_prompts.manage",
    "ai_tool_registry.manage",
    // Documentos y digitalización (Tanda T9) · V
    "documents.archive.read"
  ],
  // Gestión del activo (N7 · legal_entity / organization · token activos)
  asset_manager: [
    // M1 Reservas y recepción · V (solo lectura; fusión TL 2026-09-19 · versión 3: Hoy › Live Timeline para todos los perfiles)
    "pms.reservation.read",
    "guests.read",
    // M6 Mantenimiento, energía y seguridad · V
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    // M10 Contabilidad · V
    "accounting.read",
    "accounting.reports.read",
    // M13 Inmovilizado y CAPEX · V S E
    "assets.read",
    "capex.read",
    "capex.create",
    "assets.manage",
    // M14 Gestión del activo · V C E P
    "real_estate.read",
    "real_estate.documents.manage",
    "real_estate.manage",
    "property_tax.manage",
    // M15 Cumplimiento y registro de viajeros · V
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    // M18 Informes y analítica · V C
    "analytics.read",
    "analytics.ai_ask",
    // M18b Cuadro del propietario · V
    "owner.dashboard.read",
    // M20 Estructura societaria y fiscal · V
    "accounting.entity.read",
    "backoffice.access",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C A
    "ai.tool.execute",
    "ai.high_risk.confirm"
  ],
  // Dirección general (N5 · organization · token direccion)
  general_manager: [
    // M1 Reservas y recepción · V A (§4.7: discounts above T4 are approved by general management —
    // the checker key of the `discount` kind; corrector 8a · FSOD-07)
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    "pms.reservation.override",
    // M2 Folios y cobros · V A
    "folio.read",
    "folio.adjust_approve",
    "payments.refund_approve",
    // M3 Facturación · V A (§4.7: invoice cancellations above T4 are approved by general management —
    // never an issuer: general_manager holds no invoice.issue; corrector 8a · FSOD-07)
    "invoice.read",
    "billing.compliance.view",
    "invoice.cancel_approve",
    // M4 Cierre del día · V
    "analytics.read",
    // M5 Pisos · V
    "housekeeping.read",
    // M6 Mantenimiento, energía y seguridad · V
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    // M7 TPV y A&B · V
    "pos.read",
    // M8 Compras e inventario · V A
    "procurement.read",
    "inventory.read",
    "purchase_orders.approve",
    // M9 Facturas de proveedor y pagos · V A
    "payables.read",
    "payables.approve",
    // M10 Contabilidad · V
    "accounting.read",
    "accounting.reports.read",
    // M11 Tesorería y bancos · V
    "banking.read",
    // M12 Nóminas y personal · V A
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    "payroll.approve",
    // Tanda RRHH (2026-09-20) · expediente · V y plantilla máxima · A (SoD estática con payroll.manage)
    "hr.employee.read",
    "hr.staffing.approve",
    // M13 Inmovilizado y CAPEX · V A
    "assets.read",
    "capex.read",
    "asset.capex.approve",
    // M14 Gestión del activo · V
    "real_estate.read",
    // M15 Cumplimiento y registro de viajeros · V
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    // M16 Revenue y distribución · V A
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    "revenue.rates.approve",
    // M17 Comercial, grupos y CRM · V
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    "commissions.read",
    // M18 Informes y analítica · V C P
    "analytics.ai_ask",
    "analytics.export",
    "analytics.configure",
    "metrics.manage",
    // M18b Cuadro del propietario · V C
    "owner.dashboard.read",
    "owner.ai_ask",
    // M19 Configuración de la propiedad · V E
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    "property.configure",
    "property.map.manage",
    "property.import",
    "property.go_live",
    "configuration.manage",
    "categories.manage",
    "categories.import",
    "custom_fields.manage",
    "property_profile.edit",
    "room_types.manage",
    "spaces.manage",
    "departments.manage",
    "operations_setup.manage",
    "ai_category_setup.use",
    "templates.manage",
    "notifications.manage",
    "kiosk.configure",
    "digital_key.configure",
    "categories.export",
    // M20 Estructura societaria y fiscal · V E
    "accounting.entity.read",
    "backoffice.access",
    "organization.structure.manage",
    "billing.configure",
    "payments.configure",
    // M21 Usuarios, roles y auditoría · V C X
    "users.read",
    "audit.read",
    "users.invite",
    "users.assign",
    "users.disable",
    // M22 Módulos · V E
    "modules.read",
    "modules.enable",
    "modules.disable",
    "modules.configure",
    // M22b Integraciones y desarrollo · V
    "integrations.read",
    "integrations.view_logs",
    "developer.read",
    "developer.view_api_logs",
    // M23 IA · V C A E
    "ai_governance.read",
    "ai_incidents.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    "ai.configure",
    "ai_governance.configure",
    "ai_evals.manage",
    "ai_incidents.manage",
    "ai_prompts.manage",
    "ai_tool_registry.manage",
    // M24 Puesta en marcha y migración · V A
    "onboarding.read",
    "onboarding.view_sensitive",
    "onboarding.go_live",
    // Emergencia · §4.8 / regla L0
    "security.break_glass",
    // Documentos y digitalización (Tanda T9) · V C A E
    "documents.capture",
    "documents.review",
    "documents.archive.read",
    "documents.admin"
  ],
  // Propiedad (N6 · organization · token propiedad)
  owner: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V
    "folio.read",
    // M3 Facturación · V
    "invoice.read",
    "billing.compliance.view",
    // M6 Mantenimiento, energía y seguridad · V
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    // M7 TPV y A&B · V
    "pos.read",
    // M8 Compras e inventario · V
    "procurement.read",
    "inventory.read",
    // M9 Facturas de proveedor y pagos · V A
    "payables.read",
    "payables.approve",
    // M10 Contabilidad · V
    "accounting.read",
    "accounting.reports.read",
    // M11 Tesorería y bancos · V
    "banking.read",
    // M12 Nóminas y personal · V
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    // Tanda RRHH (2026-09-20) · expediente · V
    "hr.employee.read",
    // M13 Inmovilizado y CAPEX · V A
    "assets.read",
    "capex.read",
    "asset.capex.approve",
    // M14 Gestión del activo · V
    "real_estate.read",
    // M15 Cumplimiento y registro de viajeros · V
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    // M16 Revenue y distribución · V
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    // M17 Comercial, grupos y CRM · V
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    "commissions.read",
    // M18 Informes y analítica · V C
    "analytics.read",
    "analytics.ai_ask",
    // M18b Cuadro del propietario · V C
    "owner.dashboard.read",
    "owner.ai_ask",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M20 Estructura societaria y fiscal · V
    "accounting.entity.read",
    "backoffice.access",
    // M21 Usuarios, roles y auditoría · V
    "users.read",
    "audit.read",
    // M22 Módulos · V
    "modules.read",
    // M23 IA · C
    "ai.tool.execute",
    "ai_governance.read",
    "ai_incidents.read",
    // Documentos y digitalización (Tanda T9) · V A E
    "documents.review",
    "documents.archive.read",
    "documents.admin"
  ],
  // Auditoría interna (N7 · organization · token auditoria · solo lectura)
  auditor: [
    // M1 Reservas y recepción · V
    "pms.reservation.read",
    "guests.read",
    "guest_experience.inbox.read",
    // M2 Folios y cobros · V
    "folio.read",
    // M3 Facturación · V
    "invoice.read",
    "billing.compliance.view",
    // M4 Cierre del día · V
    "analytics.read",
    // M5 Pisos · V
    "housekeeping.read",
    // M6 Mantenimiento, energía y seguridad · V
    "maintenance.read",
    "incidents.read",
    "safety_checks.read",
    "energy.read",
    "sustainability.read",
    // M7 TPV y A&B · V
    "pos.read",
    // M8 Compras e inventario · V
    "procurement.read",
    "inventory.read",
    // M9 Facturas de proveedor y pagos · V
    "payables.read",
    // M10 Contabilidad · V
    "accounting.read",
    "accounting.reports.read",
    // M11 Tesorería y bancos · V
    "banking.read",
    // M12 Nóminas y personal · V
    "payroll.read",
    "workforce.read",
    "workforce.labor_cost.view",
    // M13 Inmovilizado y CAPEX · V
    "assets.read",
    "capex.read",
    // M14 Gestión del activo · V
    "real_estate.read",
    // M15 Cumplimiento y registro de viajeros · V
    "compliance.read",
    "guest_register.read",
    "guest_register.view_sensitive",
    "tourist_tax.read",
    // M16 Revenue y distribución · V
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "revenue.forecast_confidence.read",
    "revenue.comparison.read",
    "revenue.visual_alerts.read",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    // M17 Comercial, grupos y CRM · V
    "crm.read",
    "groups.read",
    "events.read",
    "sales.pipeline.read",
    "reputation.read",
    "surveys.read",
    "quality_cases.read",
    "guest_self_service.read",
    "commissions.read",
    // M18 Informes y analítica · V P
    "analytics.export",
    // M18b Cuadro del propietario · V
    "owner.dashboard.read",
    // M19 Configuración de la propiedad · V
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    // M20 Estructura societaria y fiscal · V
    "accounting.entity.read",
    "backoffice.access",
    // M21 Usuarios, roles y auditoría · V
    "users.read",
    "audit.read",
    // M22 Módulos · V
    "modules.read",
    // M22b Integraciones y desarrollo · V
    "integrations.read",
    "integrations.view_logs",
    "developer.read",
    "developer.view_api_logs",
    // M23 IA · V
    "ai_governance.read",
    "ai_incidents.read",
    // M24 Puesta en marcha y migración · V
    "onboarding.read",
    "onboarding.view_sensitive",
    // Documentos y digitalización (Tanda T9) · V
    "documents.archive.read"
  ],
  // Administración de sistema (N7 · organization · token sistemas · sin claves financieras ni operativas)
  admin: [
    // M1 Reservas y recepción · V (solo lectura; fusión TL 2026-09-19 · versión 3: Hoy › Live Timeline para todos los perfiles)
    "pms.reservation.read",
    "guests.read",
    // M18 Informes y analítica · V
    "analytics.read",
    // M19 Configuración de la propiedad · V E
    "configuration.read",
    "categories.read",
    "custom_fields.read",
    "property.map.read",
    "templates.read",
    "property.configure",
    "property.map.manage",
    "property.import",
    "property.go_live",
    "configuration.manage",
    "categories.manage",
    "categories.import",
    "custom_fields.manage",
    "property_profile.edit",
    "room_types.manage",
    "spaces.manage",
    "departments.manage",
    "operations_setup.manage",
    "ai_category_setup.use",
    "templates.manage",
    "notifications.manage",
    "kiosk.configure",
    "digital_key.configure",
    "categories.export",
    // M20 Estructura societaria y fiscal · E (solo organization.structure.manage)
    "organization.structure.manage",
    // M21 Usuarios, roles y auditoría · V C E X
    "users.read",
    "audit.read",
    "users.invite",
    "users.assign",
    "roles.manage",
    "permissions.manage",
    "users.disable",
    // M22 Módulos · V E
    "modules.read",
    "modules.enable",
    "modules.disable",
    "modules.configure",
    // M22b Integraciones y desarrollo · V C E
    "integrations.read",
    "integrations.view_logs",
    "developer.read",
    "developer.view_api_logs",
    "integrations.test",
    "integrations.connect",
    "integrations.disconnect",
    "integrations.manage_credentials",
    "integrations.configure",
    "developer.manage_apps",
    "developer.manage_webhooks",
    "developer.manage_sandbox",
    // M23 IA · C A E
    "ai.tool.execute",
    "ai.high_risk.confirm",
    "ai.configure",
    "ai_governance.configure",
    "ai_evals.manage",
    "ai_incidents.manage",
    "ai_prompts.manage",
    "ai_tool_registry.manage",
    // M24 Puesta en marcha y migración · V C E A X
    "onboarding.read",
    "onboarding.view_sensitive",
    "onboarding.create",
    "onboarding.upload",
    "onboarding.connect_source",
    "onboarding.ai_extract",
    "onboarding.ai_map",
    "onboarding.review",
    "onboarding.apply",
    "onboarding.manage_cutover",
    "onboarding.go_live",
    "onboarding.rollback",
    // Emergencia · §4.8 / regla L0
    "security.break_glass",
    // Documentos y digitalización (Tanda T9) · V C A E
    "documents.capture",
    "documents.review",
    "documents.archive.read",
    "documents.admin"
  ],
  // Emergencia (break glass, §4.8)
  break_glass: [...ORG_PERMISSION_KEYS],
};

/**
 * Template keys, in the order the backfill tries name matches (most specific
 * first): the 13 templates of Tanda 8a go BEFORE `manager` and `accountant`
 * so that «Director general», «Dirección financiera», «Jefe de recepción» or
 * «Gestión del activo» never fall through to the generic aliases of those two
 * (docs/design/RBAC-DEPARTAMENTOS.md §4.2).
 */
export const ROLE_TEMPLATE_KEYS: readonly RoleKey[] = [
  "general_manager",
  "operations_director",
  "front_office_manager",
  "housekeeping_manager",
  "maintenance_manager",
  "fnb_manager",
  "night_auditor",
  "admin_clerk",
  "controller",
  "payroll_hr",
  "asset_manager",
  "auditor",
  "break_glass",
  "owner",
  "admin",
  "manager",
  "receptionist",
  "housekeeper",
  "maintenance",
  "accountant",
  "compliance",
  "revenue",
  "sales",
  "fnb"
];

/**
 * Spanish role names for the template roles a hotel gets (Tanda 5 · L1a):
 * what the invite selector, the user list and the role badge show, and the
 * name `apps/api/src/scripts/reseed-property-roles.ts` gives to a template
 * role it has to create. Every name resolves back to its template through
 * the aliases of apps/api/src/lib/rbac-catalog.ts (resolveTemplateKeyForRoleName).
 */
export const ROLE_TEMPLATE_LABELS_ES: Record<RoleKey, string> = {
  receptionist: "Recepción",
  night_auditor: "Auditoría nocturna",
  front_office_manager: "Jefatura de recepción",
  housekeeper: "Pisos",
  housekeeping_manager: "Gobernanta",
  maintenance: "Mantenimiento",
  maintenance_manager: "Encargado de mantenimiento",
  fnb: "Punto de venta",
  fnb_manager: "Jefatura de A&B",
  sales: "Comercial",
  admin_clerk: "Administración de hotel",
  manager: "Dirección de hotel",
  operations_director: "Dirección de operaciones",
  revenue: "Revenue corporativo",
  accountant: "Contabilidad",
  controller: "Dirección financiera",
  payroll_hr: "RRHH y nóminas",
  compliance: "Cumplimiento",
  asset_manager: "Gestión del activo",
  general_manager: "Dirección general",
  owner: "Propiedad",
  auditor: "Auditoría interna",
  admin: "Administración de sistema",
  break_glass: "Emergencia"
};

/** One-line Spanish description per template (role selector help text). */
export const ROLE_TEMPLATE_DESCRIPTIONS_ES: Record<RoleKey, string> = {
  receptionist: "Recepción: reservas, llegadas y salidas, folios, cobros, huéspedes, partes de viajeros, descuentos y ajustes hasta el umbral operativo.",
  night_auditor: "Auditoría nocturna: lo de recepción más el cierre del día, los ajustes de auditoría y la factura del día.",
  front_office_manager: "Jefatura de recepción: todo recepción, aprobación de descuentos, ajustes y reembolsos hasta su umbral, override de tarifas y turnos.",
  housekeeper: "Pisos: estado de habitaciones, tareas de limpieza, partes de avería y fichaje.",
  housekeeping_manager: "Gobernanta: pisos completo, inspecciones, bloqueos de habitaciones, pedidos a economato y turnos de pisos.",
  maintenance: "Mantenimiento: partes de avería, órdenes de trabajo, energía y seguridad.",
  maintenance_manager: "Encargado de mantenimiento: mantenimiento completo, preventivo, compras y recepciones, propuestas de CAPEX y expediente técnico del activo.",
  fnb: "Punto de venta: tickets, cargos a habitación, cobros, recuentos y solicitudes de compra.",
  fnb_manager: "Jefatura de A&B: punto de venta completo, anulación de tickets, cartas y precios, compras, inventario y turnos.",
  sales: "Comercial: ventas a empresas y grupos, clientes y fidelización, reputación, ventas adicionales y exportación de CRM.",
  admin_clerk: "Administración de hotel: facturas de proveedor, caja y conciliación del hotel, reembolsos aprobados, revisión del cierre y recibos del inmueble.",
  manager: "Dirección de hotel: operativa completa del hotel, aprobaciones hasta su umbral, cierre y reapertura del día, anulación de facturas y usuarios de su hotel.",
  operations_director: "Dirección de operaciones: consolidado de sus hoteles, aprobación de presupuestos, facturas y tarifas fuera de banda, usuarios de sus hoteles.",
  revenue: "Revenue corporativo: tarifas, restricciones, canales, previsión y aprobación de cambios de tarifa.",
  accountant: "Contabilidad: asientos, facturas recibidas, conciliación bancaria, inmovilizado, informes fiscales y exportación a la gestoría.",
  controller: "Dirección financiera: aprobación de facturas, pagos y remesas, cierre de periodos, reembolsos y anulaciones por encima de dirección de hotel.",
  payroll_hr: "RRHH y nóminas: contratos, jornada, preparación de nóminas y exportación a la gestoría laboral.",
  compliance: "Cumplimiento: registro de viajeros, envíos a autoridades, impuestos, protección de datos y obligaciones del inmueble.",
  asset_manager: "Gestión del activo: expediente del inmueble, documentación, calendario de vencimientos, IBI y tasas, propuestas de CAPEX.",
  general_manager: "Dirección general: todo en lectura, aprobaciones estratégicas (facturas, nóminas, CAPEX, tarifas fuera de banda) y acceso de emergencia.",
  owner: "Propiedad: lectura de resultados, cuadro del propietario, documentación del inmueble y aprobación de CAPEX y facturas relevantes.",
  auditor: "Auditoría interna: todo en lectura, registros de auditoría e informe de roles y claves configurados.",
  admin: "Administración de sistema: usuarios, roles, módulos, integraciones y webhooks; sin tareas financieras ni operativas.",
  break_glass: "Emergencia: sesión de cuatro horas con todas las claves del hotel, motivo obligatorio, alerta y revisión en 24 horas."
};

/**
 * Templates that `reseed-property-roles` and `provisionDefaultTemplateRoles`
 * materialise in every organisation (one Role row per template, org scoped,
 * assignable in every scope). Same order as ROLE_TEMPLATE_KEYS. `admin` is
 * deliberately absent (the organisation «Administración de sistema» template
 * is created on demand; the `admin` token of the tree is the PLATFORM
 * administrator) and so is `break_glass` (§4.8: only ensureBreakGlassRole
 * creates the emergency role, never the tenant provisioning nor the invite
 * selector).
 */
export const ORGANIZATION_TEMPLATE_ROLE_KEYS: readonly RoleKey[] = [
  "general_manager",
  "operations_director",
  "front_office_manager",
  "housekeeping_manager",
  "maintenance_manager",
  "fnb_manager",
  "night_auditor",
  "admin_clerk",
  "controller",
  "payroll_hr",
  "asset_manager",
  "auditor",
  "owner",
  "manager",
  "receptionist",
  "housekeeper",
  "maintenance",
  "accountant",
  "compliance",
  "revenue",
  "sales",
  "fnb"
];

/**
 * Version of ROLE_PERMISSION_MAP (Tanda 8a · L0). Bumped whenever a template
 * LOSES a key; Role.templateVersion records the version a managed role was
 * last converged to, and `rbac:sync --upgrade-templates` applies
 * ROLE_TEMPLATE_REVOCATIONS to roles behind it (the boot top-up never does).
 * Version 3 (fusión TL, 2026-09-19): additive only — payroll_hr, asset_manager
 * and admin gain `pms.reservation.read` + `guests.read` (see the note above
 * ROLE_TEMPLATE_REVOCATIONS); no template loses a key.
 * Version 4 (Tanda T9 · documentos y digitalización, 2026-09-19): aditiva —
 * las cuatro claves `documents.*` (capture, review, archive.read, admin) se
 * reparten entre 15 plantillas según el diseño §6.2; ninguna plantilla pierde
 * claves y ROLE_TEMPLATE_REVOCATIONS no cambia.
 * CIERRE-1 (2026-09-20): payroll_hr + users.read (selector «Persona» de la ficha
 * de personal → GET /rbac/users), aditiva, sin bump: la entrega el top-up de
 * rbac:sync / arranque (la versión solo sube cuando una plantilla pierde claves).
 * Version 5 (Tanda RRHH · plantilla y nómina, 2026-09-20): aditiva — las cinco
 * claves `hr.*` (employee.read, employee.manage, config.manage, standards.manage,
 * staffing.approve) van a payroll_hr (todas menos staffing.approve, más
 * compliance.read), general_manager (employee.read + staffing.approve) y
 * manager / operations_director / owner (employee.read); ninguna plantilla
 * pierde claves y ROLE_TEMPLATE_REVOCATIONS no cambia.
 */
export const ROLE_TEMPLATE_VERSION = 5;

/**
 * Keys that version 2 REMOVES from each template with respect to version 1
 * (the HEAD templates before Tanda 8a), computed template by template:
 * manager −16 (cashier ≠ refund approver, issuer ≠ canceller, no configuration
 * of billing/accounting/payments, no payroll processing, no bank
 * reconciliation; the sociedad scope moves to the assignment), accountant −6
 * (no invoice cancellation, no folio postings, no payroll, no audit log, no
 * commissions, no billing configuration), compliance −4 (audit log, inventory,
 * POS and commissions), sales −1 (analytics export), fnb −1 (menus and prices
 * go to fnb_manager), owner (everything operational and configurational:
 * read + approvals remain) and admin (everything financial and operational:
 * system administration remains). The other templates lose nothing; the 13
 * new ones have no previous version. Every entry is disjoint from
 * ROLE_PERMISSION_MAP[template] (tests/rbac-sod-contract.test.mjs).
 *
 * Version 3 (fusión TL · Live Timeline, 2026-09-19) removes nothing: it ADDS
 * `pms.reservation.read` + `guests.read` (read-only) to payroll_hr, asset_manager
 * and admin so Hoy › Live Timeline paints reservations and guest names for every
 * profile, and takes those two keys out of ROLE_TEMPLATE_REVOCATIONS.admin (a
 * revocation is never also in the template). The bump lets
 * `rbac:sync --upgrade-templates` stamp v3 and deliver the two keys in one
 * audited run (ROLE_TEMPLATE_UPGRADED with revoked = []).
 *
 * Version 4 (Tanda T9 · documentos y digitalización, 2026-09-19) removes nothing
 * either: it ADDS documents.capture / documents.review / documents.archive.read /
 * documents.admin to 15 templates (design §6.2); this record is unchanged.
 *
 * Version 5 (Tanda RRHH · plantilla y nómina, 2026-09-20) removes nothing either:
 * it ADDS the five hr.* keys to six templates (see ROLE_TEMPLATE_VERSION); this
 * record is unchanged.
 */
export const ROLE_TEMPLATE_REVOCATIONS: Record<RoleKey, PermissionKey[]> = {
  receptionist: [],
  night_auditor: [],
  front_office_manager: [],
  housekeeper: [],
  housekeeping_manager: [],
  maintenance: [],
  maintenance_manager: [],
  fnb: [
    "pos.product.manage"
  ],
  fnb_manager: [],
  sales: [
    "analytics.export"
  ],
  admin_clerk: [],
  manager: [
    "payment.capture",
    "payment.refund",
    "invoice.issue",
    "guest_register.export",
    "payments.capture",
    "billing.invoice.issue",
    "billing.invoice.rectify",
    "assets.manage",
    "backoffice.access",
    "roles.manage",
    "billing.configure",
    "accounting.configure",
    "payments.configure",
    "payroll.manage",
    "banking.reconcile",
    "accounting.entity.read"
  ],
  operations_director: [],
  revenue: [],
  accountant: [
    "invoice.cancel",
    "billing.configure",
    "audit.read",
    "folio.charge.post",
    "commissions.read",
    "payroll.manage"
  ],
  controller: [],
  payroll_hr: [],
  compliance: [
    "audit.read",
    "inventory.read",
    "pos.read",
    "commissions.read"
  ],
  asset_manager: [],
  general_manager: [],
  owner: [
    "pms.reservation.create",
    "pms.reservation.modify",
    "pms.checkin.execute",
    "pms.checkout.execute",
    "folio.charge.post",
    "payment.capture",
    "payment.refund",
    "invoice.issue",
    "invoice.cancel",
    "housekeeping.task.manage",
    "maintenance.workorder.manage",
    "accounting.journal.post",
    "compliance.ses.submit",
    "compliance.ses.export",
    "compliance.ses.configure",
    "compliance.gdpr.manage",
    "guest_register.create",
    "guest_register.edit",
    "guest_register.sign",
    "guest_register.submit",
    "guest_register.export",
    "guest_register.annul",
    "guest_register.correct",
    "guest_register.configure",
    "ai.high_risk.confirm",
    "modules.enable",
    "modules.disable",
    "integrations.read",
    "integrations.connect",
    "integrations.disconnect",
    "integrations.test",
    "integrations.manage_credentials",
    "distribution.manage_rates",
    "distribution.manage_inventory",
    "distribution.sync",
    "distribution.ai_recommend",
    "payments.create_link",
    "payments.capture",
    "payments.refund_request",
    "payments.refund_approve",
    "billing.invoice.issue",
    "billing.invoice.cancel",
    "billing.invoice.rectify",
    "pos.order.create",
    "pos.order.charge_to_room",
    "pos.order.pay",
    "pos.product.manage",
    "guest_experience.message.send",
    "guest_experience.ai_reply",
    "guest_experience.handoff",
    "assets.manage",
    "capex.create",
    "capex.approve",
    "property.configure",
    "configuration.manage",
    "categories.manage",
    "categories.import",
    "categories.export",
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
    "property.map.manage",
    "property.import",
    "property.go_live",
    "modules.configure",
    "integrations.configure",
    "integrations.view_logs",
    "users.invite",
    "users.disable",
    "roles.manage",
    "permissions.manage",
    "tax.configure",
    "compliance.configure",
    "billing.configure",
    "accounting.configure",
    "payments.configure",
    "ai.configure",
    "templates.manage",
    "revenue.recommend",
    "revenue.manage_rates",
    "revenue.manage_restrictions",
    "revenue.apply_recommendations",
    "revenue.automation.manage",
    "revenue.configure",
    "revenue.history_forecast.export",
    "revenue.history_forecast.configure",
    "revenue.history_forecast.saved_views.manage",
    "revenue.scheduled_reports.manage",
    "channel_manager.manage",
    "channel_manager.sync",
    "channel_manager.mappings.manage",
    "guests.manage",
    "crm.manage_profiles",
    "crm.manage_campaigns",
    "crm.manage_loyalty",
    "crm.export",
    "groups.manage",
    "groups.block_inventory",
    "groups.manage_billing",
    "events.manage",
    "events.manage_spaces",
    "sales.pipeline.manage",
    "workforce.schedule.manage",
    "workforce.timeclock.use",
    "workforce.timeclock.manage",
    "workforce.payroll_export",
    "payroll.manage",
    "banking.reconcile",
    "notifications.manage",
    "procurement.manage",
    "purchase_orders.create",
    "purchase_orders.approve",
    "purchase_orders.receive",
    "inventory.manage",
    "inventory.stock_count",
    "inventory.adjust",
    "guest_portal.configure",
    "guest_self_service.manage",
    "kiosk.configure",
    "digital_key.configure",
    "reputation.respond",
    "surveys.manage",
    "quality_cases.manage",
    "energy.manage",
    "sustainability.report",
    "iot.manage",
    "incidents.manage",
    "safety_checks.manage",
    "insurance_cases.manage",
    "analytics.configure",
    "analytics.export",
    "metrics.manage",
    "developer.read",
    "developer.manage_apps",
    "developer.manage_webhooks",
    "developer.view_api_logs",
    "developer.manage_sandbox",
    "ai_governance.configure",
    "ai_evals.manage",
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
    "organization.structure.manage"
  ],
  auditor: [],
  admin: [
    "pms.reservation.create",
    "pms.reservation.modify",
    "pms.checkin.execute",
    "pms.checkout.execute",
    "folio.charge.post",
    "folio.read",
    "payment.capture",
    "payment.refund",
    "invoice.issue",
    "invoice.cancel",
    "invoice.read",
    "housekeeping.task.manage",
    "maintenance.workorder.manage",
    "asset.capex.approve",
    "accounting.journal.post",
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
    "distribution.read",
    "distribution.manage_rates",
    "distribution.manage_inventory",
    "distribution.sync",
    "distribution.ai_recommend",
    "payments.create_link",
    "payments.capture",
    "payments.refund_request",
    "payments.refund_approve",
    "billing.invoice.issue",
    "billing.invoice.cancel",
    "billing.invoice.rectify",
    "billing.compliance.view",
    "pos.order.create",
    "pos.order.charge_to_room",
    "pos.order.pay",
    "pos.product.manage",
    "pos.read",
    "tourist_tax.read",
    "guest_experience.inbox.read",
    "guest_experience.message.send",
    "guest_experience.ai_reply",
    "guest_experience.handoff",
    "owner.dashboard.read",
    "owner.ai_ask",
    "assets.read",
    "assets.manage",
    "capex.read",
    "capex.create",
    "capex.approve",
    "backoffice.access",
    "rooms.manage",
    "revenue_setup.manage",
    "compliance_setup.manage",
    "tax.configure",
    "compliance.configure",
    "billing.configure",
    "accounting.configure",
    "payments.configure",
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
    "guests.manage",
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
    "payroll.read",
    "banking.read",
    "commissions.read",
    "accounting.read",
    "accounting.reports.read",
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
    "analytics.configure",
    "analytics.export",
    "analytics.ai_ask",
    "metrics.manage",
    "ai_governance.read",
    "ai_incidents.read",
    "accounting.entity.read"
  ],
  break_glass: []
};

export function hasPermission(userPermissions: PermissionKey[], permission: PermissionKey): boolean {
  return userPermissions.includes(permission);
}

export function missingPermissions(userPermissions: PermissionKey[], required: PermissionKey[]): PermissionKey[] {
  return required.filter((permission) => !hasPermission(userPermissions, permission));
}

// Carries `statusCode` so HTTP layers that map errors by status (the API's
// global error handler) answer 403 instead of 500. The message is user-facing
// (Spanish); the full `missing` list stays on the error object for logs.
export class PermissionDeniedError extends Error {
  readonly statusCode = 403;
  readonly missing: PermissionKey[];
  constructor(missing: PermissionKey[]) {
    super(`No tienes permiso para realizar esta acción (requiere: ${missing.join(", ")}).`);
    this.name = "PermissionDeniedError";
    this.missing = missing;
  }
}

export function assertPermissions(userPermissions: PermissionKey[], required: PermissionKey[]): void {
  const missing = missingPermissions(userPermissions, required);
  if (missing.length > 0) {
    throw new PermissionDeniedError(missing);
  }
}
