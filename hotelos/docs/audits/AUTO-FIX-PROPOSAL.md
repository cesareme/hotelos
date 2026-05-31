# AUTO-FIX-PROPOSAL · Sidebar & Navigation Gap Closure

**Scope:** apps/admin-web · sidebar (`components/cocoa-sidebar-v2`) + routes (`App.tsx`) + screens (`src/screens/*`)
**Goal:** Eliminar screens huerfanos, eliminar items dead-end, reforzar discoverability via CTAs y subgrupos.
**Tipo:** propuesta deterministica, aplicable por agente sin decisiones de producto adicionales.

---

## 1. Sidebar items a anadir

Screens implementados, sin entry point en sidebar y con valor operativo. Cada uno debe insertarse en el subgrupo target indicado, manteniendo el orden alfabetico interno.

| Screen | Subgrupo target | Label | Roles | Razon |
|---|---|---|---|---|
| `screens/quality/QualityDashboardScreen` | Operations > Quality | Quality dashboard | manager, ops_lead | Existe screen completo; hoy solo se accede por deep-link desde reports. |
| `screens/quality/IncidentDetailScreen` | Operations > Quality | Incidents | manager, ops_lead, housekeeping_lead | Lista incidentes accionables; huerfano del sidebar. |
| `screens/esrs/EsrsDashboardScreen` | Compliance > ESG | ESRS reporting | director, finance_lead, compliance_officer | Mandatorio EU 2026; debe ser top-level dentro de Compliance. |
| `screens/esrs/EsrsEvidenceScreen` | Compliance > ESG | ESRS evidence | compliance_officer | Hoy solo accesible desde el dashboard ESRS; debe tener entry directo. |
| `screens/energy/EnergyOverviewScreen` | Operations > Sustainability | Energy & utilities | manager, ops_lead, sustainability_lead | Screen activo sin link; sustainability no tiene subgrupo. |
| `screens/payroll/PayrollRunScreen` | Finance > HR | Payroll runs | finance_lead, hr_admin | Implementado; hoy accedido solo desde HR list. |
| `screens/payroll/PayrollHistoryScreen` | Finance > HR | Payroll history | finance_lead, hr_admin | Idem; cierra journey de payroll. |
| `screens/fiscal/FiscalReportsScreen` | Finance > Fiscal | Fiscal reports | finance_lead, accountant | Reemplaza accesos manuales por URL. |
| `screens/fiscal/VeriFactuStatusScreen` | Compliance > Fiscal | VeriFactu status | finance_lead, compliance_officer | Espana-only; importante post-cumplimiento. |
| `screens/banking/BankReconciliationScreen` | Finance > Treasury | Bank reconciliation | finance_lead, accountant | Existente; nunca enlazado. |
| `screens/banking/PayoutsScreen` | Finance > Treasury | Payouts | finance_lead | Idem. |
| `screens/commissions/CommissionsLedgerScreen` | Finance > Commissions | Commissions ledger | finance_lead, sales_lead | Solo accesible desde detalle de OTA. |
| `screens/loyalty/LoyaltyDashboardScreen` | Guest > Loyalty | Loyalty dashboard | crm_lead, marketing_lead | Solo accesible via deep link desde guest profile. |
| `screens/loyalty/TiersScreen` | Guest > Loyalty | Loyalty tiers | crm_lead | Idem. |
| `screens/surveys/SurveyBuilderScreen` | Guest > Surveys | Survey builder | crm_lead, ops_lead | Subgrupo Surveys vacio en sidebar actual. |
| `screens/surveys/SurveyResultsScreen` | Guest > Surveys | Survey results | crm_lead, manager | Idem. |
| `screens/upsells/UpsellsCatalogScreen` | Revenue > Upsells | Upsell catalog | revenue_manager, sales_lead | Catalogo activo; no enlazado. |
| `screens/upsells/UpsellsPerformanceScreen` | Revenue > Upsells | Upsell performance | revenue_manager | Idem. |
| `screens/marketplace/MarketplaceBrowseScreen` | Integrations > Marketplace | Marketplace | admin, owner | Existente, accesible solo desde onboarding. |
| `screens/kiosk/KioskConfigScreen` | Property > Devices | Kiosk config | manager, ops_lead | Sin entry point. |
| `screens/timeline/TimelineScreen` | Operations > Activity | Timeline | manager, ops_lead | Stream de eventos; util como pin top. |
| `screens/notifications/NotificationsCenterScreen` | top-level (header) | Notifications | all | Mover de huerfano a icono header; no sidebar item separado. |
| `screens/developer/ApiKeysScreen` | Settings > Developer | API keys | admin, developer | Solo accesible escribiendo URL. |
| `screens/developer/WebhooksScreen` | Settings > Developer | Webhooks | admin, developer | Idem. |
| `screens/developer/AuditLogScreen` | Settings > Security | Audit log | admin, security_officer | Compliance / forensics. |
| `screens/messaging/InboxScreen` | Guest > Messaging | Inbox | front_desk, crm_lead | Hoy embebido en CRM; merece entry propio. |
| `screens/messaging/TemplatesScreen` | Guest > Messaging | Templates | crm_lead, marketing_lead | Idem. |
| `screens/aiOperations/AiAgentsScreen` | AI > Operations | AI agents | admin, ops_lead | Subgrupo AI nuevo (ver seccion 4). |
| `screens/aiOperations/AiAuditScreen` | AI > Operations | AI audit | compliance_officer, admin | Idem. |
| `screens/aiOperations/AiCostsScreen` | AI > Operations | AI costs | finance_lead, admin | Idem. |

**Total:** 28 items netos a anadir al sidebar (excluyendo detalles y rutas runtime).

---

## 2. Sidebar items a quitar

Items presentes en el sidebar actual que rompen UX por ser placeholders, dead-ends o duplicados.

| Item actual (path o key) | Motivo | Accion |
|---|---|---|
| `sidebar > Reports > "Coming soon"` | Placeholder sin screen detras. | Eliminar entry. |
| `sidebar > Marketing > "Campaigns (beta)"` | Apunta a `/marketing/campaigns` que retorna 404 en build actual. | Eliminar hasta que `MarketingCampaignsScreen` exista. |
| `sidebar > Finance > "Reports"` (duplicado) | Duplica `Finance > Fiscal > Fiscal reports`. | Eliminar el item generico; mantener el especifico. |
| `sidebar > Settings > "General"` | Wrapper que solo redirige a `Settings > Property`. | Eliminar; el redirect confunde la breadcrumb. |
| `sidebar > Settings > "Preferences"` | Vacio en `SettingsPreferencesScreen`; sin items reales. | Eliminar hasta que tenga toggles funcionales. |
| `sidebar > Guests > "Segments (legacy)"` | Reemplazado por `CRM > Segments`. | Eliminar. |
| `sidebar > Operations > "Cleaning v1"` | Sustituido por `Housekeeping`. | Eliminar; mantener `Housekeeping`. |
| `sidebar > Property > "Photos"` | Apunta a screen vacia (`PropertyPhotosScreen` solo skeleton). | Eliminar hasta que tenga upload. |
| `sidebar > AI > "Insights"` (duplicado) | Mismo destino que `Dashboards > AI insights`. | Eliminar la version dentro de AI. |
| `sidebar > Compliance > "GDPR (old)"` | Reemplazado por `Compliance > Data subject requests`. | Eliminar. |

**Total:** 10 items a remover.

---

## 3. CTAs a anadir en screens

Screens que ya existen pero cuyo journey siguiente no tiene CTA explicito, obligando al usuario a navegar manualmente por el sidebar.

| Screen padre | CTA a anadir | Posicion | Dialog target |
|---|---|---|---|
| `ReservationsListScreen` | "New reservation" | header (primary) | `NewReservationDialog` |
| `ReservationsListScreen` | "Import bookings" | header (secondary) | `ImportBookingsDialog` |
| `ReservationDetailScreen` | "Add charge" | inline (toolbar) | `AddChargeDialog` |
| `ReservationDetailScreen` | "Send pre-arrival message" | inline (CRM panel) | `SendTemplateDialog` |
| `GuestProfileScreen` | "Open conversation" | header (secondary) | linkea a `messaging/InboxScreen?guest=:id` |
| `GuestProfileScreen` | "Add to segment" | inline | `AddToSegmentDialog` |
| `HousekeepingBoardScreen` | "Assign rooms" | header (primary) | `AssignRoomsDialog` |
| `HousekeepingBoardScreen` | "Report incident" | header (secondary) | `IncidentCreateDialog` (links a quality) |
| `IncidentDetailScreen` | "Escalate" | header | `EscalateIncidentDialog` |
| `RevenueDashboardScreen` | "Run forecast" | header (primary) | `RunForecastDialog` |
| `RevenueDashboardScreen` | "Adjust strategy" | inline | `AdjustStrategyDialog` |
| `FinanceDashboardScreen` | "Close period" | header | `ClosePeriodDialog` |
| `FinanceDashboardScreen` | "New invoice" | header (secondary) | `NewInvoiceDialog` |
| `InvoiceListScreen` | "New invoice" | header (primary) | `NewInvoiceDialog` |
| `InvoiceDetailScreen` | "Send to VeriFactu" | header (primary, ES) | `VeriFactuSubmitDialog` |
| `OnboardingChecklistScreen` | "Open marketplace" | inline | linkea a `marketplace/MarketplaceBrowseScreen` |
| `PropertySetupScreen` | "Import from PMS" | header (secondary) | `ImportFromPmsDialog` |
| `ChannelManagerScreen` | "Connect channel" | header (primary) | `ConnectChannelDialog` |
| `ChannelManagerScreen` | "Sync now" | header (secondary) | `SyncChannelDialog` |
| `CRMDashboardScreen` | "New campaign" | header (primary) | `NewCampaignDialog` |
| `CRMDashboardScreen` | "Open inbox" | header (secondary) | linkea a `messaging/InboxScreen` |
| `LoyaltyDashboardScreen` | "Award points" | header | `AwardPointsDialog` |
| `EnergyOverviewScreen` | "Connect meter" | header | `ConnectMeterDialog` |
| `EsrsDashboardScreen` | "Upload evidence" | header (primary) | `UploadEvidenceDialog` |
| `EsrsDashboardScreen` | "Generate report" | header (secondary) | `GenerateEsrsReportDialog` |
| `PayrollHistoryScreen` | "Run payroll" | header | linkea a `PayrollRunScreen` |
| `BankReconciliationScreen` | "Import statement" | header | `ImportStatementDialog` |
| `SurveyResultsScreen` | "New survey" | header | linkea a `SurveyBuilderScreen` |
| `UpsellsPerformanceScreen` | "Edit catalog" | header | linkea a `UpsellsCatalogScreen` |
| `AiAgentsScreen` | "New agent" | header (primary) | `NewAgentDialog` |
| `AiAgentsScreen` | "View costs" | header (secondary) | linkea a `AiCostsScreen` |
| `WebhooksScreen` | "New webhook" | header (primary) | `NewWebhookDialog` |
| `ApiKeysScreen` | "Generate key" | header (primary) | `GenerateApiKeyDialog` |
| `KioskConfigScreen` | "Preview kiosk" | header (secondary) | abre `KioskSessionScreen` en nueva tab |
| `BillingScreen` | "Manage subscription" | header | `ManageSubscriptionDialog` |

**Total:** 35 CTAs a anadir distribuidos en 23 screens padre.

---

## 4. Subgrupos nuevos recomendados

Subgrupos que no existen en la IA actual del sidebar y que son necesarios para acomodar items huerfanos y mejorar la mental model.

| Subgrupo | Razon | Items a incluir |
|---|---|---|
| `Operations > Quality` | Hoy quality vive disperso en operations. Subgrupo dedicado evita confundirlo con housekeeping. | Quality dashboard, Incidents, SLA targets |
| `Operations > Sustainability` | Energy, agua, residuos no tienen home. ESG es transversal pero la operativa diaria es de Ops. | Energy & utilities, Waste tracking (futuro), Water tracking (futuro) |
| `Operations > Activity` | Timeline / event stream necesita un hogar. | Timeline, Audit feed (resumen) |
| `Compliance > ESG` | ESRS reporting es regulatorio EU; separa de fiscal. | ESRS reporting, ESRS evidence, Taxonomy disclosure |
| `Compliance > Fiscal` | VeriFactu + AEAT submissions justifican subgrupo propio. | VeriFactu status, AEAT submissions, Tax calendar |
| `Compliance > Security` | Audit log + access reviews + DSR. | Audit log, Access reviews, Data subject requests |
| `Finance > HR` | Payroll necesita home; "HR" plano se confunde con CRM staff. | Payroll runs, Payroll history, Pay slips |
| `Finance > Treasury` | Bank rec + payouts forman una funcion treasury distinta de fiscal. | Bank reconciliation, Payouts, Cash positions |
| `Finance > Commissions` | OTA/sales commissions tienen logica propia. | Commissions ledger, Commission rules |
| `Guest > Loyalty` | Loyalty es vertical separado de CRM general. | Loyalty dashboard, Loyalty tiers, Rewards catalog |
| `Guest > Messaging` | Mensajeria multicanal merece nivel propio. | Inbox, Templates, Channels config |
| `Guest > Surveys` | Surveys != reviews; deben separarse. | Survey builder, Survey results |
| `Revenue > Upsells` | Upsells != pricing; encajan bajo revenue pero con scope propio. | Upsell catalog, Upsell performance |
| `Integrations > Marketplace` | Marketplace no tiene home actualmente. | Marketplace, Installed apps |
| `AI > Operations` | Agentes IA, audit y costos requieren subgrupo. | AI agents, AI audit, AI costs |
| `Settings > Developer` | API keys, webhooks deben separarse de "General". | API keys, Webhooks, SDK tokens |
| `Property > Devices` | Kiosk + future tablets / locks. | Kiosk config, Door locks (futuro) |

**Total:** 17 subgrupos nuevos. 11 son neutros respecto a roles; 6 dependen de feature flag por rol.

---

## 5. Tests de regresion

Tres tests deterministicos que deben anadirse a CI antes de mergear cualquier cambio en sidebar/routes/screens.

### 5.1 Script: screens-vs-sidebar coverage

Path: `apps/admin-web/scripts/audit-sidebar-coverage.ts`

Logica:

1. Glob `src/screens/**/*Screen.tsx` y `src/screens/**/*Page.tsx`.
2. Parsear items del sidebar (`src/components/cocoa-sidebar-v2/items.ts`).
3. Cargar whitelist `docs/audits/sidebar-whitelist.json` (detalles, dialogs, runtime kiosks, error pages).
4. Cada screen debe estar en sidebar o en whitelist. Si no, fallo.

Comando: `pnpm --filter @hotelos/admin-web audit:sidebar-coverage`.
CI: bloqueante en PRs que toquen `src/screens/**` o sidebar.

### 5.2 Script: sidebar-items-vs-routes

Path: `apps/admin-web/scripts/audit-sidebar-routes.ts`

Logica:

1. Parsear `App.tsx` y extraer `<Route path=...>`.
2. Verificar que cada sidebar item apunta a route existente y a screen existente.
3. Fallo si hay items con rutas o screens inexistentes.

Comando: `pnpm --filter @hotelos/admin-web audit:sidebar-routes`. CI bloqueante.

### 5.3 Visual regression del sidebar

Tool: Playwright (`apps/admin-web/e2e/sidebar.visual.spec.ts`).

Casos: sidebar colapsado/expandido (rol admin), snapshot por rol (admin, owner, manager, front_desk, finance_lead, housekeeping_lead, marketing_lead), responsive a 1024px/1440px, active state en 5 screens representativos. Threshold `maxDiffPixelRatio: 0.01`. CI bloqueante.

---

## Resumen ejecutivo

- **28** items netos a anadir al sidebar (screens huerfanos hoy implementados).
- **10** items a remover (placeholders, duplicados, dead-ends).
- **35** CTAs nuevos distribuidos en **23** screens padre.
- **17** subgrupos nuevos para reorganizar la IA.
- **3** tests de regresion bloqueantes en CI (coverage, routes, visual).

Aplicacion sugerida en 3 PRs separados: (1) tests de regresion (rojos inicialmente), (2) sidebar IA refactor + items add/remove + subgrupos, (3) CTAs en screens.
