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
  "admin.tenants.manage": "Manage platform tenants (HotelOS staff console; never granted to hotel roles)"
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
// touched. Keep any change additive.

export const ROLE_PERMISSION_MAP: Record<RoleKey, PermissionKey[]> = {
  // Full organization scope: the hotel owner/administrator can do everything a
  // hotel can do, and nothing a platform operator can do.
  owner: [...ORG_PERMISSION_KEYS],
  // Hotel director ("Dirección"): every operational surface plus the read side
  // of revenue, distribution, CRM, groups and inventory (Tanda 5 §10).
  manager: [
    "pms.reservation.read",
    "pms.reservation.create",
    "pms.reservation.modify",
    "pms.checkin.execute",
    "pms.checkout.execute",
    "folio.charge.post",
    "guests.read",
    "guests.manage",
    "payment.capture",
    "payment.refund",
    "invoice.issue",
    "invoice.cancel",
    "housekeeping.task.manage",
    "maintenance.workorder.manage",
    "compliance.ses.submit",
    "compliance.ses.export",
    "compliance.ses.configure",
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
    "distribution.read",
    "distribution.manage_rates",
    "distribution.manage_inventory",
    "distribution.sync",
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
    "guest_experience.inbox.read",
    "guest_experience.message.send",
    "guest_experience.ai_reply",
    "guest_experience.handoff",
    "assets.read",
    "assets.manage",
    "capex.read",
    "capex.create",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    "backoffice.access",
    "property.configure",
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
    "tax.configure",
    "compliance.configure",
    "billing.configure",
    "accounting.configure",
    "payments.configure",
    "ai.configure",
    "templates.read",
    "templates.manage",
    "channel_manager.parity.read",
    "payroll.manage",
    "banking.reconcile",
    "notifications.manage",
    "audit.read",
    // Tanda 5 §10 — read side of the tree the director sees (Mi día, Revenue,
    // Canales, Clientes, Grupos, Ventas adicionales, Existencias, IA).
    "analytics.read",
    "ai_governance.read",
    "revenue.read",
    "revenue.forecast.read",
    "revenue.history_forecast.read",
    "channel_manager.read",
    "crm.read",
    "groups.read",
    "guest_self_service.read",
    "inventory.read",
    // Protección de datos: the director is the data controller's delegate in a
    // small hotel and the only gate of GET /gdpr/requests is this key (§10.2
    // keeps the entry for direccion and removes it from recepcion).
    "compliance.gdpr.manage",
    // Tanda 5 (L1b · api-side): read keys of the GET routes that were gated by
    // write keys (folio.charge.post → folio.read / pos.read / tourist_tax.read;
    // compliance.ses.submit → billing.compliance.view / guest_register.read).
    "folio.read",
    "pos.read",
    "tourist_tax.read",
    // Tanda 5 (L1c · api): read keys of the GETs the director opens from
    // the tree (Facturación, Nóminas, Conciliación, Comisiones, Tesorería,
    // Seguridad, Personal, Nuevo evento, Gobernanza IA › Incidentes).
    "invoice.read",
    "payroll.read",
    "banking.read",
    "commissions.read",
    "accounting.read",
    // Finanzas (2026-09-16, fix t6#9): Dirección reads the books and the
    // fiscal reports (Estados contables, Modelos AEAT, USALI).
    "accounting.reports.read",
    "incidents.read",
    "safety_checks.read",
    "workforce.read",
    "events.read",
    "ai_incidents.read",
    // Tanda 6b (L1): Finanzas de toda la sociedad (design §5.2 R11: Owner, Dirección, Finanzas).
    "accounting.entity.read"
  ],
  receptionist: [
    "pms.reservation.read",
    "pms.reservation.create",
    "pms.reservation.modify",
    "pms.checkin.execute",
    "pms.checkout.execute",
    "folio.charge.post",
    "payment.capture",
    "payments.create_link",
    "guests.read",
    "guests.manage",
    "guest_register.read",
    "guest_register.create",
    "guest_register.edit",
    "guest_register.sign",
    "guest_register.submit",
    "guest_experience.inbox.read",
    "guest_experience.message.send",
    "ai.tool.execute",
    // Tanda 5 §10 — Mi día / Turno / Tablero (dashboards), Pendientes de la
    // IA, Grupos y eventos (calendar), Planes de tarifas (quote a price).
    "analytics.read",
    "ai_governance.read",
    "groups.read",
    "revenue.read",
    // Bandeja de cumplimiento: reception signs and sends the SES traveller
    // parts (§11 task 12) and the inbox GET is gated by this key.
    "compliance.ses.submit",
    // Tanda 5 (L1b · api-side): read keys of the GET routes that were gated by
    // write keys (folio.charge.post → folio.read / pos.read / tourist_tax.read;
    // compliance.ses.submit → billing.compliance.view / guest_register.read).
    // Reception opens Folios / Enrutamiento, the POS board, the tourist tax
    // tab and the compliance inbox (VeriFactu status) from the tree.
    "folio.read",
    "pos.read",
    "tourist_tax.read",
    "billing.compliance.view",
    // Tanda 5 (L1c · api): the menu needs the module list (modules.read);
    // Facturación y cobros / Rectificativas list and open invoices
    // (invoice.read); Seguridad e incidentes and «Nuevo evento» (salones)
    // are visible to reception and their GETs were 403; the compliance inbox
    // reads the fiscal periods to warn about a closing period
    // (accounting.read: fiscal calendar and exchange rates, no amounts).
    // Finanzas (2026-09-16, fix t6#9): every finance GET that shows amounts
    // (diario, mayor, IVA, modelos AEAT, cuentas anuales, USALI) is gated by
    // accounting.reports.read, which reception does NOT hold — the calendar
    // key stays here so existing Recepción roles keep the inbox warning
    // (the boot top-up never revokes; a narrower key closes the leak).
    "modules.read",
    "invoice.read",
    "incidents.read",
    "safety_checks.read",
    "events.read",
    "accounting.read"
  ],
  // Tanda 5 §10 — Mi día (Operaciones), Reservas › Cronograma/Tablero.
  // L1c: modules.read (menu), workforce.read (Personal y turnos).
  housekeeper: ["housekeeping.task.manage", "ai.tool.execute", "analytics.read", "pms.reservation.read", "modules.read", "workforce.read"],
  // Tanda 5 §10 — Mi día (Operaciones), Activos, Energía, Seguridad dashboards.
  // L1c: modules.read (menu), pms.reservation.read (room numbers of the work
  // orders: GET /properties/:p/rooms), incidents.read + safety_checks.read
  // (Seguridad e incidentes), workforce.read (Personal y turnos).
  maintenance: [
    "maintenance.workorder.manage",
    "ai.tool.execute",
    "analytics.read",
    "modules.read",
    "pms.reservation.read",
    "incidents.read",
    "safety_checks.read",
    "workforce.read"
  ],
  accountant: [
    "pms.reservation.read",
    "invoice.issue",
    "invoice.cancel",
    "accounting.journal.post",
    "accounting.configure",
    "billing.configure",
    "audit.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // Tanda 5 §10 — Mi día (Dirección), Modelos AEAT, Estados contables,
    // Tesorería, Conciliación (all /dashboards + /accounting/reports read),
    // Informe IA del día, Perfil inicial / Categorías de ingresos
    // (backoffice.access), Registro de viajeros (read), Existencias/Compras.
    "analytics.read",
    "ai_governance.read",
    "backoffice.access",
    "guest_register.read",
    "inventory.read",
    // Invoice compliance status (VeriFactu) is accounting's: read key held
    // ahead of the L2 manifest fix (verifactu/submissions is gated today by
    // compliance.ses.submit, which stays with the compliance template).
    "billing.compliance.view",
    // Posting charges/adjustments to folios is billing work (the template
    // already issues and cancels invoices); kept after L1b for that reason.
    "folio.charge.post",
    // Tanda 5 (L1b · api-side): read keys of the GET routes that were gated by
    // write keys (folio.charge.post → folio.read / pos.read / tourist_tax.read;
    // compliance.ses.submit → billing.compliance.view / guest_register.read).
    "folio.read",
    "pos.read",
    "tourist_tax.read",
    // Tanda 5 (L1c · api): menu (modules.read); Facturación, Nóminas,
    // Conciliación, Comisiones, Tesorería › Tipos de cambio, ejercicios y
    // periodos fiscales (read side of the accountant screens).
    "modules.read",
    "invoice.read",
    "payroll.read",
    "banking.read",
    "commissions.read",
    "accounting.read",
    // Finanzas (2026-09-16, FIN-17): the route gate of the bank imports,
    // reconciliation, SEPA remittances and payroll calculation/payment asks
    // banking.reconcile / payroll.manage; the services accept those OR
    // accounting.journal.post. Without the keys the accountant reached the
    // service check only through the owner template.
    "banking.reconcile",
    "payroll.manage",
    // Finanzas (2026-09-16, fix t6#9 / t6#10): the accounting read surface
    // (diario, mayor, IVA, modelos, cuentas anuales, USALI) moved from the
    // calendar key accounting.read to accounting.reports.read; and the
    // accountant of a pyme registers suppliers and received invoices
    // (procurement.*, payables partial), the fixed-asset register
    // (assets.*, fixed-assets partial) and exports the books to the
    // gestoría (analytics.export, financial-statements partial). Without
    // them the Contabilidad template answered 403 on POST suppliers /
    // supplier-bills / asset-register / gestoria-exports.
    "accounting.reports.read",
    "procurement.read",
    "procurement.manage",
    "assets.read",
    "assets.manage",
    "analytics.export",
    // Tanda 6b (L1): Finanzas de toda la sociedad (design §5.2 R11: Owner, Dirección, Finanzas).
    "accounting.entity.read"
  ],
  compliance: [
    "pms.reservation.read",
    "compliance.ses.submit",
    "compliance.ses.export",
    "compliance.ses.configure",
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
    "compliance.configure",
    "tax.configure",
    "audit.read",
    "ai.tool.execute",
    "ai.high_risk.confirm",
    // Tanda 5 §10 — Mi día (Dirección), Modelos AEAT and reports, Informe IA
    // del día, Perfil inicial / Categorías de ingresos, Existencias/Compras.
    "analytics.read",
    "ai_governance.read",
    "backoffice.access",
    "inventory.read",
    // Protección de datos (DSAR, erasure): core compliance duty.
    "compliance.gdpr.manage",
    // Tanda 5 (L1b · api-side): read keys of the GET routes that were gated by
    // write keys (folio.charge.post → folio.read / pos.read / tourist_tax.read;
    // compliance.ses.submit → billing.compliance.view / guest_register.read).
    // Finanzas token: Folios / Enrutamiento, POS board, Tasa turística and
    // the VeriFactu / TicketBAI / IGIC status views (read-only; no money).
    "folio.read",
    "pos.read",
    "tourist_tax.read",
    "billing.compliance.view",
    // Tanda 5 (L1c · api): menu (modules.read); Facturación y cobros
    // (invoice.read), Comisiones, Tipos de cambio and the fiscal calendar
    // (accounting.read). Nóminas and bank statements stay with accountant.
    "modules.read",
    "invoice.read",
    "commissions.read",
    "accounting.read",
    // Finanzas (2026-09-16, fix t6#9): Modelos AEAT, libros de IVA and the
    // fiscal reports are the finanzas token (sister of accountant); the
    // calendar key alone no longer opens them.
    "accounting.reports.read"
  ],
  // Revenue / distribution manager: pricing, restrictions, channels, forecasts.
  revenue: [
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
    "revenue_setup.manage",
    "distribution.read",
    "distribution.manage_rates",
    "distribution.manage_inventory",
    "distribution.sync",
    "distribution.ai_recommend",
    "channel_manager.read",
    "channel_manager.manage",
    "channel_manager.sync",
    "channel_manager.mappings.manage",
    "channel_manager.parity.read",
    "pms.reservation.read",
    "groups.read",
    "analytics.read",
    "analytics.export",
    "analytics.ai_ask",
    "ai.tool.execute",
    // Tanda 5 §10 — Informe IA del día.
    "ai_governance.read",
    // Tanda 5 (L1c · api): the menu needs the module list.
    "modules.read"
  ],
  // Tanda 5 (L1a · rbac) — Comercial/Ventas ("comercial" token, §3: 14 items in
  // 5 categories): reservations for companies and groups, guests, groups and
  // events, CRM/loyalty/campaigns, reputation and quality, upsells, sales
  // pipeline, channels (read), commissions and reports. No money, no setup.
  sales: [
    "pms.reservation.read",
    "pms.reservation.create",
    "pms.reservation.modify",
    "guests.read",
    "guests.manage",
    "groups.read",
    "groups.manage",
    "groups.block_inventory",
    "events.read",
    "events.manage",
    "sales.pipeline.read",
    "sales.pipeline.manage",
    "crm.read",
    "crm.manage_profiles",
    "crm.manage_campaigns",
    "crm.manage_loyalty",
    "crm.export",
    "reputation.read",
    "reputation.respond",
    "surveys.read",
    "surveys.manage",
    "quality_cases.read",
    "quality_cases.manage",
    "guest_self_service.read",
    "guest_self_service.manage",
    "channel_manager.read",
    "channel_manager.parity.read",
    "distribution.read",
    "analytics.read",
    "analytics.export",
    "ai.tool.execute",
    // Tanda 5 (L1c · api): menu (modules.read); Canales lists rate plans
    // (revenue.read, GET /properties/:p/rate-plans); Comisiones (read).
    "modules.read",
    "revenue.read",
    "commissions.read"
  ],
  // Tanda 5 (L1a · rbac) — Punto de venta / F&B ("fnb" token, §3: 5 items in 2
  // categories): POS orders, charge to room, menus, stock counts, purchase
  // requests, own shifts and time clock. folio.charge.post is the gate of
  // charging consumption to a folio (POS reads use pos.read since L1b).
  fnb: [
    "pos.read",
    "pos.order.create",
    "pos.order.charge_to_room",
    "pos.order.pay",
    "pos.product.manage",
    "folio.charge.post",
    "inventory.read",
    "inventory.stock_count",
    "procurement.read",
    "purchase_orders.create",
    "workforce.read",
    "workforce.timeclock.use",
    "analytics.read",
    "ai.tool.execute",
    // Tanda 5 (L1c · api): the menu needs the module list (TPV, Cartas, Existencias are module-gated).
    "modules.read"
  ],
  // Organization administrator: same scope as owner (platform keys excluded).
  admin: [...ORG_PERMISSION_KEYS]
};

/** Template keys, in the order the backfill tries name matches (most specific first). */
export const ROLE_TEMPLATE_KEYS: readonly RoleKey[] = [
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
  owner: "Propietario",
  admin: "Administrador",
  manager: "Dirección",
  receptionist: "Recepción",
  housekeeper: "Pisos",
  maintenance: "Mantenimiento",
  accountant: "Contabilidad",
  compliance: "Cumplimiento",
  revenue: "Revenue",
  sales: "Comercial",
  fnb: "Punto de venta"
};

/** One-line Spanish description per template (role selector help text). */
export const ROLE_TEMPLATE_DESCRIPTIONS_ES: Record<RoleKey, string> = {
  owner: "Todo el alcance del hotel: configuración, dinero, cumplimiento y usuarios.",
  admin: "Mismo alcance que el propietario; pensado para la administración delegada.",
  manager: "Dirección del hotel: operativa completa y lectura de revenue, canales, clientes y existencias.",
  receptionist: "Recepción: reservas, llegadas y salidas, folios, huéspedes, partes de viajeros y mensajes.",
  housekeeper: "Pisos: tareas de limpieza, estado de habitaciones y cronograma.",
  maintenance: "Mantenimiento: partes de avería, activos, energía y seguridad.",
  accountant: "Contabilidad: facturación, asientos, informes fiscales, tesorería y conciliación.",
  compliance: "Cumplimiento: registro de viajeros, envíos a autoridades, impuestos y protección de datos.",
  revenue: "Revenue: tarifas, restricciones, canales, previsión y recomendaciones.",
  sales: "Comercial: ventas a empresas y grupos, clientes y fidelización, reputación y ventas adicionales.",
  fnb: "Punto de venta y F&B: tickets, cargos a habitación, cartas, existencias y compras."
};

/**
 * Templates that `reseed-property-roles` materialises in every organisation
 * (one Role row per template, org scoped, assignable in every property).
 * `admin` is deliberately absent: the organisation administrator template is
 * full scope like owner, and §3 reserves the `admin` token for the platform
 * administrator — a hotel does not need a second full-scope role by default.
 */
export const ORGANIZATION_TEMPLATE_ROLE_KEYS: readonly RoleKey[] = [
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
