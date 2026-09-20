import type { PermissionKey } from "@hotelos/shared";
import { assertPermissions } from "@hotelos/shared";
import { ForbiddenError } from "../lib/http-error.js";
import { rateGridRoutePermissions } from "../modules/rate-manager/route-permissions.partial.js";
import { CHANNEL_MANAGER_ROUTE_PERMISSIONS } from "../modules/channel-manager/route-permissions.partial.js";
import { recommendationsRoutePermissions } from "../modules/revenue/route-permissions.partial.js";
// Finanzas (2026-09-16, integración): one partial per finance module (the
// contract test reads every `*route-permissions.partial.ts` under modules/).
import { ledgerRoutePermissions as ledgerRoutePermissionsAsWritten } from "../modules/accounting/route-permissions.partial.js";
import { fiscalRoutePermissions as fiscalRoutePermissionsAsWritten } from "../modules/accounting/fiscal-route-permissions.partial.js";
import { invoicingRoutePermissions } from "../modules/invoicing/route-permissions.partial.js";
import { paymentsRoutePermissions } from "../modules/payments/route-permissions.partial.js";
import { posRoutePermissions } from "../modules/pos/route-permissions.partial.js";
import { nightAuditRoutePermissions } from "../modules/night-audit/route-permissions.partial.js";
import { payablesRoutePermissions as payablesRoutePermissionsAsWritten } from "../modules/payables/route-permissions.partial.js";
import { fixedAssetsRoutePermissions as fixedAssetsRoutePermissionsAsWritten } from "../modules/fixed-assets/route-permissions.partial.js";
import { treasuryRoutePermissions } from "../modules/treasury/route-permissions.partial.js";
import { FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS as FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS_AS_WRITTEN } from "../modules/financial-statements/route-permissions.partial.js";
// Estructura societaria (Tanda 6b · L2, integración): sociedad + centros
// (modules/structure/structure.routes.ts). Its GET entries carry
// `accounting.read` ON PURPOSE (design §5.4: structure is configuration, not
// amounts) so they stay out of the accounting.reports.read remap below.
import { structureRoutePermissions } from "../modules/structure/route-permissions.partial.js";
// Coste de personal importado (Tanda 6c · L3): /payroll/cost-imports* y
// /payroll/cost-report (modules/payroll/cost-import.routes.ts). payroll.read /
// payroll.manage only (never accounting.read), so the remap below is a no-op.
import { payrollRoutePermissions } from "../modules/payroll/route-permissions.partial.js";
// RRHH · plantilla, convenio, estándares, plantilla máxima, previsión, KPIs,
// alertas y ausencias (Tanda RRHH · RRHH-6): /hr/* (modules/hr/hr.routes.ts).
// Claves hr.employee.read / hr.employee.manage / hr.config.manage /
// hr.standards.manage / hr.staffing.approve del catálogo v5 (RRHH-1) más
// workforce.read / workforce.schedule.manage / workforce.labor_cost.view ya
// existentes; nunca accounting.read (el remap de abajo no las toca).
import { hrRoutePermissions } from "../modules/hr/route-permissions.partial.js";
// Importación masiva de reservas (Tanda 7 · L3): /properties/:propertyId/
// reservations/imports* (modules/pms/reservation-import.routes.ts). Claves
// pms.reservation.read / create / modify ya existentes (sin rbac:sync); el
// remap de accounting.reports.read no las toca.
import { reservationImportRoutePermissions } from "../modules/pms/route-permissions.partial.js";
// OPERA Cloud modo sombra (Tanda 7b · L3): POST /integrations/pms-shadow/ingest
// (pública, clave de API de DeveloperApp verificada en el handler) y
// /properties/:propertyId/pms-shadow/* (modules/pms-shadow/pms-shadow.routes.ts).
// Claves integrations.read / connect y accounting.read / journal.post ya
// existentes (sin rbac:sync).
import { pmsShadowRoutePermissions as pmsShadowRoutePermissionsAsWritten } from "../modules/pms-shadow/route-permissions.partial.js";
// Importación contable desde Sage 200 (Tanda 7c · L3): /accounting/ledger-imports*
// y /accounting/ledger-imports/reconciliation* (modules/accounting/
// ledger-import.routes.ts; partial propio a profundidad 1 del módulo, como
// fiscal-route-permissions.partial.ts). Claves accounting.read / configure /
// journal.post y ai.high_risk.confirm ya existentes (sin rbac:sync).
import { ledgerImportRoutePermissions as ledgerImportRoutePermissionsAsWritten } from "../modules/accounting/ledger-import-route-permissions.partial.js";
// RBAC por departamento (Tanda 8a · L1): /rbac/* y /approvals* (modules/rbac/
// rbac.routes.ts). Claves users.read / users.assign / roles.manage /
// permissions.manage / organization.structure.manage / accounting.read /
// accounting.configure / ai.high_risk.confirm / security.break_glass /
// audit.read del catálogo v2 (L0); las rutas con `permissions: []` de riesgo
// high / critical (aprobaciones, PIN, autorizaciones de supervisor) exigen su
// clave DINÁMICA en el servicio (DYNAMIC_KEY_ROUTES del contract test).
import { rbacRoutePermissions } from "../modules/rbac/route-permissions.partial.js";
import { reputationRoutePermissions } from "../modules/reputation/route-permissions.partial.js";
// Documentos y digitalización con IA (Tanda T9): captura, registro, descarga y
// archivo (modules/documents/route-permissions.partial.ts · lote T9-05a) y
// pipeline de clasificación/extracción/cotejo (modules/documents/
// pipeline-route-permissions.partial.ts · lote T9-06a). Claves documents.capture /
// documents.review / documents.archive.read / documents.admin del catálogo v4 (T9-02).
import { documentsRoutePermissions } from "../modules/documents/route-permissions.partial.js";
import { documentPipelineRoutePermissions } from "../modules/documents/pipeline-route-permissions.partial.js";
// Flujo de la oficina, dividir / unir, tareas y valija (modules/documents/
// workflow-route-permissions.partial.ts · lote T9-08): documents.review (high) en
// assign / review / approve / reject / archive; la clave extra de la acción al
// aprobar la exige el servicio.
import { documentWorkflowRoutePermissions } from "../modules/documents/workflow-route-permissions.partial.js";
// Archivo, KPIs, ajustes por organización y retención (modules/documents/
// archive-route-permissions.partial.ts · lote T9-13): documents.archive.read /
// documents.review (medium, + R11 en el servicio) y documents.admin (high en
// ajustes; critical en block / unblock / purge).
import { documentArchiveRoutePermissions } from "../modules/documents/archive-route-permissions.partial.js";
// Check-in automatizado (Tanda CHK · W2-A): /guest-portal/check-in* (token opaco del
// huésped, riskLevel public) y /properties/:propertyId/check-in/* · /kiosks* (modules/
// checkin/checkin.routes.ts). Claves existentes; sin rbac:sync.
import { checkinRoutePermissions } from "../modules/checkin/route-permissions.partial.js";
// Asignación explicable (Tanda CHK · W3-B): sugerencias por reserva, confirmación,
// lote manual, bloqueos y comunicadas (modules/pms/room-assignment.routes.ts;
// segundo partial del módulo pms). Claves existentes; sin rbac:sync.
import { roomAssignmentRoutePermissions } from "../modules/pms/room-assignment-route-permissions.partial.js";

// Audit 2026-06 · #3: dedupe log of GET routes hitting the fail-open path, so
// manifest gaps are auditable in the logs. Logged once per path to avoid spam.
const loggedUnmappedGets = new Set<string>();

export type ApiRoutePermission = {
  // Tanda 3 (server-rutas): PUT added for the idempotent tax-rate override
  // (`PUT /backoffice/properties/:propertyId/taxes/rates`). The contract test
  // extractor and `assertRoutePermission` compare the upper-cased verb, so a
  // PUT registration without an entry fails closed like any other mutation.
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  permissions: PermissionKey[];
  riskLevel: "public" | "authenticated" | "low" | "medium" | "high" | "critical";
};

// Finanzas (2026-09-16, fix t6#9 · integrador): `accounting.read` is the
// CALENDAR key of Tanda 5 (L1c) — "fiscal years, fiscal periods and exchange
// rates", held by the Recepción template so the compliance inbox can warn
// about a closing period. The finance partials (ledger, fiscal, payables,
// fixed assets, financial statements) reused it for every read that shows
// amounts, which opened the diario, the mayor, the CSV export, the Modelo
// 303, the libros de IVA, the cuentas anuales and the USALI PyG to reception
// under strict RBAC. The runtime manifest gates those reads with
// `accounting.reports.read` instead (manager / accountant / compliance /
// owner hold it; reception does not), leaving `accounting.read` only on the
// calendar routes of this file. The boot top-up never revokes a grant, so a
// NARROWER key — not a removal from the Recepción template — is what closes
// the leak for the roles that already exist (Faranda, org_123).
//
// The remap is applied at the import boundary so the spread lines below stay
// textually intact for the contract tests that parse this file
// (`...<partial>,`). Partial owners may switch their entries to
// `accounting.reports.read` directly; the remap is then a no-op.
export const ACCOUNTING_CALENDAR_KEY: PermissionKey = "accounting.read";
export const ACCOUNTING_REPORTS_KEY: PermissionKey = "accounting.reports.read";

/** `accounting.read` → `accounting.reports.read` on every entry of a finance partial (other keys untouched). */
export function requireAccountingReportsKey(entries: readonly ApiRoutePermission[]): ApiRoutePermission[] {
  return entries.map((entry) =>
    entry.permissions.includes(ACCOUNTING_CALENDAR_KEY)
      ? {
          ...entry,
          permissions: entry.permissions.map((key) => (key === ACCOUNTING_CALENDAR_KEY ? ACCOUNTING_REPORTS_KEY : key))
        }
      : entry
  );
}

const ledgerRoutePermissions = requireAccountingReportsKey(ledgerRoutePermissionsAsWritten);
const fiscalRoutePermissions = requireAccountingReportsKey(fiscalRoutePermissionsAsWritten);
const payablesRoutePermissions = requireAccountingReportsKey(payablesRoutePermissionsAsWritten);
const fixedAssetsRoutePermissions = requireAccountingReportsKey(fixedAssetsRoutePermissionsAsWritten);
const FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS = requireAccountingReportsKey(FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS_AS_WRITTEN);
// OPERA Cloud modo sombra (Tanda 7b · L3): la reconciliación y los lotes de
// ingresos muestran importes → misma remap que las finanzas (accounting.read del
// partial → accounting.reports.read en el manifiesto en vigor; el resto intacto).
const pmsShadowRoutePermissions = requireAccountingReportsKey(pmsShadowRoutePermissionsAsWritten);
// Importación contable desde Sage 200 (Tanda 7c · L3): lotes, mapas, plantilla y
// reconciliaciones muestran importes → misma remap (accounting.read del partial →
// accounting.reports.read en el manifiesto en vigor, plantilla incluida; el resto
// intacto). Pinado por security/__tests__/finance-report-keys.test.mts.
const ledgerImportRoutePermissions = requireAccountingReportsKey(ledgerImportRoutePermissionsAsWritten);

/**
 * Calendar reads that legitimately keep `accounting.read` (no amounts):
 * fiscal years and their status, fiscal periods, exchange rates. Every other
 * GET carrying the key is a finance read and is pinned by
 * security/__tests__/finance-report-keys.test.mts.
 */
export const ACCOUNTING_CALENDAR_GET_PATHS: readonly string[] = [
  "/accounting/fiscal-years",
  "/accounting/fiscal-years/:id/status",
  "/accounting/fiscal-periods",
  "/finance/exchange-rates",
  // Tanda 6b (L2): the structure is configuration (códigos, tipo de centro,
  // modo), never amounts — design §5.4 gates it with accounting.read ∨
  // organization.structure.manage. Fix t6b#9: with the calendar key alone the
  // service answers a REDACTED view (assigned centres only; no series,
  // installations, VAT settings or fiscal data of the sociedad), and the full
  // DTO of GET /legal-entities/:id moved to accounting.entity.read.
  "/organizations/me/structure",
  // Tanda 8a (RBAC · L1): the approval thresholds of the organisation are
  // configuration (limits per action and tier, never ledger amounts) — read
  // with the calendar key like the structure; written with accounting.configure
  // + ai.high_risk.confirm (PUT, critical).
  "/rbac/thresholds"
];

export const routePermissionManifest: ApiRoutePermission[] = [
  // Rate grid v2 (2026-09-14): entries contributed by the modules that own the routes.
  ...rateGridRoutePermissions,
  ...CHANNEL_MANAGER_ROUTE_PERMISSIONS,
  ...recommendationsRoutePermissions,
  // Finanzas (2026-09-16): ledger, fiscal (IVA/AEAT), invoicing PDF, payments
  // (PSP), TPV/arqueo, night audit, payables, fixed assets, treasury and
  // financial statements. The legacy POS / night-audit entries moved into
  // their partials with the routes.
  ...ledgerRoutePermissions,
  ...fiscalRoutePermissions,
  ...invoicingRoutePermissions,
  ...paymentsRoutePermissions,
  ...posRoutePermissions,
  ...nightAuditRoutePermissions,
  ...payablesRoutePermissions,
  ...fixedAssetsRoutePermissions,
  ...treasuryRoutePermissions,
  ...FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS,
  // Estructura societaria (Tanda 6b · L2): 9 entries, see modules/structure/route-permissions.partial.ts.
  ...structureRoutePermissions,
  // Coste de personal importado (Tanda 6c): 7 entries, see modules/payroll/route-permissions.partial.ts.
  ...payrollRoutePermissions,
  // RRHH · plantilla y previsión (Tanda RRHH · RRHH-6): 21 entradas, ver modules/hr/route-permissions.partial.ts.
  ...hrRoutePermissions,
  // Importación masiva de reservas (Tanda 7): 6 entradas, ver modules/pms/route-permissions.partial.ts.
  ...reservationImportRoutePermissions,
  // OPERA Cloud modo sombra (Tanda 7b): 15 entradas, ver modules/pms-shadow/route-permissions.partial.ts.
  ...pmsShadowRoutePermissions,
  // Importación contable desde Sage 200 (Tanda 7c): 15 entradas, ver modules/accounting/ledger-import-route-permissions.partial.ts
  ...ledgerImportRoutePermissions,
  // RBAC por departamento (Tanda 8a · L1): 24 entradas, ver modules/rbac/route-permissions.partial.ts.
  ...rbacRoutePermissions,
  // Reputación y reseñas (Tanda T8): 12 entradas, ver modules/reputation/route-permissions.partial.ts.
  ...reputationRoutePermissions,
  // Documentos y digitalización (Tanda T9): ver modules/documents/route-permissions.partial.ts
  // (captura/registro/descarga/archivo) y modules/documents/pipeline-route-permissions.partial.ts (pipeline).
  ...documentsRoutePermissions,
  ...documentPipelineRoutePermissions,
  ...documentWorkflowRoutePermissions,
  ...documentArchiveRoutePermissions,
  // Check-in automatizado (Tanda CHK): 18 entradas, ver modules/checkin/route-permissions.partial.ts.
  ...checkinRoutePermissions,
  // Asignación explicable (Tanda CHK · W3-B): 10 entradas, ver modules/pms/room-assignment-route-permissions.partial.ts.
  ...roomAssignmentRoutePermissions,
  { method: "GET", path: "/health", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/metrics", permissions: ["audit.read"], riskLevel: "low" },
  { method: "POST", path: "/auth/login", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/auth/forgot-password", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/auth/reset-password", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/auth/change-password", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/auth/password-policy", permissions: [], riskLevel: "public" },
  // Tanda 3 (CFG-P1-6) · staff invitations: the token IS the credential. Both
  // routes are public here AND in PUBLIC_PREFIXES (lib/auth-context.ts) —
  // without the second half they answer 401 as soon as HOTELOS_ALLOW_DEMO_AUTH
  // is off. GET answers a generic 404 for unknown/expired/used tokens; POST is
  // rate-limited 5/min like /auth/reset-password.
  { method: "GET", path: "/auth/invitations/:token", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/auth/accept-invite", permissions: [], riskLevel: "public" },
  // Bootstrap del piloto: público (gated por BOOTSTRAP_TOKEN + first-run check)
  { method: "GET", path: "/onboarding/bootstrap/status", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/onboarding/bootstrap", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/users", permissions: ["users.invite"], riskLevel: "high" },
  { method: "POST", path: "/auth/register-device", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/auth/sessions", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/auth/sessions/:id/revoke", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/auth/mfa/challenge", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/auth/mfa/verify", permissions: [], riskLevel: "authenticated" },
  // Tanda 5 (L1a · rbac): current user + template per property, for the
  // role-token navigation (apps/admin-web/src/navigation/role-tokens.ts).
  { method: "GET", path: "/users/me", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/users/me/properties", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/users/me/preferences", permissions: [], riskLevel: "authenticated" },
  { method: "PATCH", path: "/users/me/preferences", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/properties", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/search", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/webhooks/event-types", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/webhooks/subscriptions", permissions: ["developer.manage_webhooks"], riskLevel: "medium" },
  { method: "POST", path: "/webhooks/subscriptions", permissions: ["developer.manage_webhooks"], riskLevel: "high" },
  { method: "PATCH", path: "/webhooks/subscriptions/:id", permissions: ["developer.manage_webhooks"], riskLevel: "high" },
  { method: "DELETE", path: "/webhooks/subscriptions/:id", permissions: ["developer.manage_webhooks"], riskLevel: "high" },
  { method: "GET", path: "/webhooks/subscriptions/:id/deliveries", permissions: ["developer.manage_webhooks"], riskLevel: "medium" },
  { method: "POST", path: "/webhooks/subscriptions/:id/test", permissions: ["developer.manage_webhooks"], riskLevel: "medium" },
  // WhatsApp Cloud API · webhook de entrada (Tanda CHK · W4-D, routes/webhooks-whatsapp.routes.ts):
  // Meta no lleva JWT; GET responde el hub.challenge con WHATSAPP_VERIFY_TOKEN y POST verifica
  // la firma X-Hub-Signature-256 (WHATSAPP_APP_SECRET) sobre el cuerpo crudo. Prefijo en PUBLIC_PREFIXES.
  { method: "GET", path: "/webhooks/whatsapp", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/webhooks/whatsapp", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/assistant/tools", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/assistant/chat", permissions: [], riskLevel: "authenticated" },
  // Tanda 5 (L1b · api-side): GET routes carry READ keys (folio.read, pos.read,
  // tourist_tax.read, billing.compliance.view, guest_register.read); the write
  // keys they used to require stay on the mutations only.
  { method: "GET", path: "/tourist-tax/rates", permissions: ["tourist_tax.read"], riskLevel: "low" },
  { method: "POST", path: "/tourist-tax/rates", permissions: ["compliance.configure"], riskLevel: "high" },
  { method: "POST", path: "/tourist-tax/seed", permissions: ["compliance.configure"], riskLevel: "medium" },
  { method: "POST", path: "/tourist-tax/compute", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/tourist-tax/apply", permissions: ["folio.charge.post"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/tourist-tax/applications", permissions: ["tourist_tax.read"], riskLevel: "medium" },
  { method: "POST", path: "/reservations/:id/wallet-pass", permissions: ["pms.checkin.execute"], riskLevel: "high" },
  { method: "POST", path: "/mobile-keys/:serial/verify", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/mobile-keys/:serial/revoke", permissions: ["pms.checkin.execute"], riskLevel: "high" },
  { method: "GET", path: "/tbai/territories", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/invoices/:id/tbai/submit", permissions: ["compliance.configure"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/tbai/chain/:territory/verify", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/tbai/submissions", permissions: ["billing.compliance.view"], riskLevel: "medium" },
  // Finanzas (2026-09-16, FIN-17): bank imports and SEPA remittances are the
  // reconciler's work (banking.reconcile: manager/accountant); the services
  // accept banking.reconcile OR accounting.journal.post.
  { method: "POST", path: "/properties/:propertyId/banking/csb43/import", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "POST", path: "/banking/sepa/remittances", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "POST", path: "/banking/iban/validate", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/esrs/catalog", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/organizations/:orgId/esrs/:year/indicators", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "POST", path: "/esrs/indicators", permissions: ["compliance.configure"], riskLevel: "high" },
  { method: "POST", path: "/organizations/:orgId/esrs/:year/generate", permissions: ["compliance.configure"], riskLevel: "high" },
  { method: "GET", path: "/organizations/:orgId/esrs/:year/report", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "GET", path: "/marketplace/categories", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/marketplace/listings", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/marketplace/listings/:appId", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/marketplace/listings", permissions: ["developer.manage_webhooks"], riskLevel: "high" },
  { method: "POST", path: "/marketplace/listings/:appId/install", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/marketplace/listings/:appId/uninstall", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/marketplace/installations", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/developer/apps", permissions: ["developer.manage_webhooks"], riskLevel: "medium" },
  { method: "POST", path: "/developer/apps", permissions: ["developer.manage_webhooks"], riskLevel: "high" },
  { method: "POST", path: "/developer/apps/:appId/rotate-secret", permissions: ["developer.manage_webhooks"], riskLevel: "high" },
  { method: "GET", path: "/oauth/scopes", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/oauth/authorize", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/oauth/token", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/notifications", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/notifications/:id/read", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/settings/security", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/onboarding/projects", permissions: ["onboarding.create"], riskLevel: "high" },
  { method: "GET", path: "/onboarding/projects", permissions: ["onboarding.read"], riskLevel: "medium" },
  { method: "GET", path: "/onboarding/projects/:projectId", permissions: ["onboarding.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/onboarding/projects/:projectId", permissions: ["onboarding.create"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/projects/:projectId/source-connections", permissions: ["onboarding.connect_source"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/source-connections/:connectionId/test", permissions: ["onboarding.connect_source"], riskLevel: "medium" },
  { method: "POST", path: "/onboarding/source-connections/:connectionId/sync", permissions: ["onboarding.connect_source"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/projects/:projectId/files", permissions: ["onboarding.upload"], riskLevel: "high" },
  { method: "GET", path: "/onboarding/projects/:projectId/files", permissions: ["onboarding.read"], riskLevel: "medium" },
  { method: "POST", path: "/onboarding/files/:fileId/classify", permissions: ["onboarding.ai_extract"], riskLevel: "medium" },
  { method: "POST", path: "/onboarding/files/:fileId/extract", permissions: ["onboarding.ai_extract"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/projects/:projectId/ai/analyze", permissions: ["onboarding.ai_extract"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/projects/:projectId/ai/generate-blueprint", permissions: ["onboarding.ai_map"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/projects/:projectId/ai/generate-mappings", permissions: ["onboarding.ai_map"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/projects/:projectId/room-walk/parse", permissions: ["onboarding.ai_map"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/files/:fileId/floor-plan/map", permissions: ["onboarding.ai_map"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/projects/:projectId/ai/data-quality", permissions: ["onboarding.review"], riskLevel: "high" },
  { method: "GET", path: "/onboarding/projects/:projectId/extracted-entities", permissions: ["onboarding.read"], riskLevel: "medium" },
  { method: "GET", path: "/onboarding/projects/:projectId/mapping-suggestions", permissions: ["onboarding.read"], riskLevel: "medium" },
  { method: "GET", path: "/onboarding/projects/:projectId/human-review-queue", permissions: ["onboarding.review"], riskLevel: "high" },
  { method: "PATCH", path: "/onboarding/mapping-suggestions/:suggestionId/approve", permissions: ["onboarding.review"], riskLevel: "high" },
  { method: "PATCH", path: "/onboarding/mapping-suggestions/:suggestionId/reject", permissions: ["onboarding.review"], riskLevel: "medium" },
  { method: "PATCH", path: "/onboarding/mapping-suggestions/:suggestionId/edit", permissions: ["onboarding.review"], riskLevel: "high" },
  { method: "POST", path: "/onboarding/projects/:projectId/dry-run", permissions: ["onboarding.apply"], riskLevel: "high" },
  { method: "GET", path: "/onboarding/projects/:projectId/dry-run-result", permissions: ["onboarding.read"], riskLevel: "medium" },
  { method: "POST", path: "/onboarding/projects/:projectId/apply", permissions: ["onboarding.apply"], riskLevel: "critical" },
  { method: "POST", path: "/onboarding/projects/:projectId/rollback", permissions: ["onboarding.rollback"], riskLevel: "critical" },
  { method: "GET", path: "/onboarding/projects/:projectId/readiness", permissions: ["onboarding.read"], riskLevel: "medium" },
  { method: "GET", path: "/onboarding/projects/:projectId/cutover-plan", permissions: ["onboarding.read"], riskLevel: "medium" },
  { method: "POST", path: "/onboarding/projects/:projectId/cutover/delta-import/dry-run", permissions: ["onboarding.manage_cutover"], riskLevel: "critical" },
  { method: "POST", path: "/onboarding/projects/:projectId/go-live", permissions: ["onboarding.go_live"], riskLevel: "critical" },
  { method: "GET", path: "/revenue/properties/:propertyId/history-forecast", permissions: ["revenue.history_forecast.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/history-forecast/report", permissions: ["revenue.history_forecast.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/history-forecast/charts", permissions: ["revenue.history_forecast.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/history-forecast/kpis", permissions: ["revenue.history_forecast.read"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/history-forecast/export", permissions: ["revenue.history_forecast.export"], riskLevel: "high" },
  // H&F board + Export Center (contract 2026-07-15).
  { method: "GET", path: "/revenue/properties/:propertyId/history-forecast/board", permissions: ["revenue.history_forecast.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/export-center/catalog", permissions: ["revenue.history_forecast.read"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/export-center/generate", permissions: ["revenue.history_forecast.export"], riskLevel: "high" },
  { method: "GET", path: "/revenue/properties/:propertyId/pickup", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/pace", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/pace/capture", permissions: ["revenue.recommend"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/forecast", permissions: ["revenue.forecast.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/forecasts", permissions: ["revenue.forecast.read"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/forecasts/generate", permissions: ["revenue.recommend"], riskLevel: "high" },
  { method: "GET", path: "/revenue/properties/:propertyId/forecasts/by-segment", permissions: ["revenue.forecast.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/forecasts/:date", permissions: ["revenue.forecast.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/forecast-accuracy", permissions: ["revenue.forecast.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/recommendations", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/recommendations/generate", permissions: ["revenue.recommend"], riskLevel: "high" },
  { method: "POST", path: "/revenue/properties/:propertyId/recommendations/:id/approve", permissions: ["revenue.apply_recommendations"], riskLevel: "critical" },
  { method: "POST", path: "/revenue/properties/:propertyId/recommendations/:id/apply", permissions: ["revenue.apply_recommendations"], riskLevel: "critical" },
  { method: "POST", path: "/revenue/properties/:propertyId/recommendations/:id/reject", permissions: ["revenue.apply_recommendations"], riskLevel: "high" },
  { method: "POST", path: "/revenue/properties/:propertyId/pricing-rules", permissions: ["revenue.configure"], riskLevel: "high" },
  { method: "PATCH", path: "/revenue/pricing-rules/:id", permissions: ["revenue.configure"], riskLevel: "high" },
  { method: "POST", path: "/revenue/properties/:propertyId/bar-levels", permissions: ["revenue.configure"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/budget", permissions: ["revenue.configure"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/market-segments", permissions: ["revenue.configure"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/market-segments/seed", permissions: ["revenue.configure"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/displacement", permissions: ["revenue.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/email/connections", permissions: ["integrations.connect"], riskLevel: "high" },
  { method: "DELETE", path: "/email/connections/:id", permissions: ["integrations.disconnect"], riskLevel: "medium" },
  { method: "POST", path: "/email/connections/:id/poll", permissions: ["integrations.connect"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/email/ingest", permissions: ["integrations.connect"], riskLevel: "medium" },
  { method: "POST", path: "/email/inbound/:id/approve", permissions: ["pms.reservation.create"], riskLevel: "high" },
  { method: "POST", path: "/email/inbound/:id/reject", permissions: ["integrations.connect"], riskLevel: "low" },
  { method: "GET", path: "/channel-manager/channels/:channelId/room-mappings", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/channels/:channelId/room-mappings", permissions: ["channel_manager.mappings.manage"], riskLevel: "high" },
  { method: "GET", path: "/channel-manager/channels/:channelId/rate-mappings", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/channels/:channelId/rate-mappings", permissions: ["channel_manager.mappings.manage"], riskLevel: "high" },
  // SiteMinder-style OTA aggregator (Sprint 28 — channel manager aggregator)
  { method: "GET", path: "/channel-manager/channels", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/channels/:channelId/ingest", permissions: ["channel_manager.sync"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/push-rates", permissions: ["channel_manager.sync"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/push-availability", permissions: ["channel_manager.sync"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/push-restrictions", permissions: ["channel_manager.sync"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/ingest-all", permissions: ["channel_manager.sync"], riskLevel: "medium" },
  { method: "GET", path: "/channel-manager/sync-jobs", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/parity/check", permissions: ["channel_manager.sync"], riskLevel: "medium" },
  { method: "GET", path: "/channel-manager/parity/alerts", permissions: ["channel_manager.parity.read"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/parity/alerts/:id/resolve", permissions: ["channel_manager.manage"], riskLevel: "medium" },
  // Mapping management, readiness checklist + sandbox round-trip (Sprint 44)
  { method: "DELETE", path: "/channel-manager/room-mappings/:id", permissions: ["channel_manager.mappings.manage"], riskLevel: "high" },
  { method: "DELETE", path: "/channel-manager/rate-mappings/:id", permissions: ["channel_manager.mappings.manage"], riskLevel: "high" },
  { method: "GET", path: "/channel-manager/channels/:channelId/mapping-coverage", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "GET", path: "/channel-manager/channels/:channelId/readiness", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "GET", path: "/rate-shopper/properties/:propertyId/competitors", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/rate-shopper/properties/:propertyId/competitors", permissions: ["revenue.configure"], riskLevel: "high" },
  { method: "GET", path: "/rate-shopper/properties/:propertyId/rates", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/rate-shopper/properties/:propertyId/shop", permissions: ["revenue.recommend"], riskLevel: "high" },
  { method: "GET", path: "/rate-shopper/properties/:propertyId/parity-alerts", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/crm/segments", permissions: ["crm.manage_profiles"], riskLevel: "medium" },
  { method: "PATCH", path: "/crm/segments/:id", permissions: ["crm.manage_profiles"], riskLevel: "medium" },
  { method: "POST", path: "/crm/campaigns", permissions: ["crm.manage_campaigns"], riskLevel: "high" },
  { method: "PATCH", path: "/crm/campaigns/:id", permissions: ["crm.manage_campaigns"], riskLevel: "high" },
  { method: "POST", path: "/crm/loyalty/programs", permissions: ["crm.manage_loyalty"], riskLevel: "high" },
  { method: "PATCH", path: "/crm/loyalty/memberships/:id", permissions: ["crm.manage_loyalty"], riskLevel: "high" },
  { method: "POST", path: "/sales/accounts", permissions: ["sales.pipeline.manage"], riskLevel: "medium" },
  { method: "POST", path: "/sales/opportunities", permissions: ["sales.pipeline.manage"], riskLevel: "medium" },
  { method: "PATCH", path: "/sales/opportunities/:id", permissions: ["sales.pipeline.manage"], riskLevel: "medium" },
  { method: "POST", path: "/groups/properties/:propertyId", permissions: ["groups.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/groups/:id", permissions: ["groups.manage"], riskLevel: "high" },
  { method: "POST", path: "/groups/:id/room-blocks", permissions: ["groups.block_inventory"], riskLevel: "critical" },
  { method: "POST", path: "/groups/:id/room-blocks/bulk", permissions: ["groups.manage"], riskLevel: "low" },
  { method: "POST", path: "/groups/:id/events", permissions: ["events.manage"], riskLevel: "high" },
  { method: "POST", path: "/groups/:id/rooming-list/import", permissions: ["groups.manage"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/event-spaces", permissions: ["events.read"], riskLevel: "low" },
  { method: "POST", path: "/groups/:id/release-unsold", permissions: ["groups.block_inventory"], riskLevel: "critical" },
  { method: "POST", path: "/groups/:id/master-folio", permissions: ["groups.manage"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/groups/release-expired", permissions: ["groups.manage"], riskLevel: "medium" },
  { method: "POST", path: "/events/properties/:propertyId/spaces", permissions: ["events.manage_spaces"], riskLevel: "high" },
  { method: "POST", path: "/events/properties/:propertyId/events", permissions: ["events.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/events/:id", permissions: ["events.manage"], riskLevel: "high" },
  { method: "POST", path: "/events/:id/generate-beo", permissions: ["events.manage"], riskLevel: "high" },
  { method: "POST", path: "/workforce/properties/:propertyId/shifts", permissions: ["workforce.schedule.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/workforce/shifts/:id", permissions: ["workforce.schedule.manage"], riskLevel: "high" },
  { method: "POST", path: "/workforce/time-clock/clock-in", permissions: ["workforce.timeclock.use"], riskLevel: "medium" },
  { method: "POST", path: "/workforce/time-clock/clock-out", permissions: ["workforce.timeclock.use"], riskLevel: "medium" },
  { method: "POST", path: "/workforce/absences", permissions: ["workforce.schedule.manage"], riskLevel: "medium" },
  { method: "PATCH", path: "/workforce/absences/:id", permissions: ["workforce.schedule.manage"], riskLevel: "high" },
  { method: "POST", path: "/procurement/properties/:propertyId/purchase-orders", permissions: ["purchase_orders.create"], riskLevel: "high" },
  { method: "POST", path: "/procurement/purchase-orders/:id/approve", permissions: ["purchase_orders.approve"], riskLevel: "critical" },
  { method: "POST", path: "/procurement/purchase-orders/:id/receive", permissions: ["purchase_orders.receive"], riskLevel: "high" },
  { method: "POST", path: "/guest-portal/session/:token/pay", permissions: ["guest_self_service.manage"], riskLevel: "critical" },
  // Guest portal real auth + pre-check-in + service requests (Sprint 40).
  // These are GUEST-scoped, not staff-permission-gated: the guest token IS the
  // auth. Registered as "public" with empty permissions (like /auth/login) so
  // the staff permission preHandler passes; each handler calls verifyGuestToken
  // itself and returns 401 when the token is invalid/expired.
  { method: "POST", path: "/guest-portal/sign-in", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/sign-out", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/guest-portal/reservation", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/pre-check-in", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/service-request", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/reputation/reviews/:id/respond", permissions: ["reputation.respond"], riskLevel: "high" },
  { method: "POST", path: "/quality/properties/:propertyId/cases", permissions: ["quality_cases.manage"], riskLevel: "medium" },
  { method: "PATCH", path: "/quality/cases/:id", permissions: ["quality_cases.manage"], riskLevel: "medium" },
  { method: "POST", path: "/surveys/properties/:propertyId", permissions: ["surveys.manage"], riskLevel: "medium" },
  { method: "POST", path: "/surveys/:id/responses", permissions: ["surveys.manage"], riskLevel: "medium" },
  { method: "POST", path: "/energy/properties/:propertyId/meters", permissions: ["energy.manage"], riskLevel: "medium" },
  { method: "POST", path: "/energy/properties/:propertyId/readings", permissions: ["energy.manage"], riskLevel: "medium" },
  { method: "POST", path: "/sustainability/properties/:propertyId/actions", permissions: ["sustainability.report"], riskLevel: "medium" },
  { method: "POST", path: "/safety/properties/:propertyId/incidents", permissions: ["incidents.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/safety/incidents/:id", permissions: ["incidents.manage"], riskLevel: "high" },
  { method: "POST", path: "/safety/incidents/:id/evidence", permissions: ["incidents.manage"], riskLevel: "high" },
  { method: "POST", path: "/safety/properties/:propertyId/checks", permissions: ["safety_checks.manage"], riskLevel: "high" },
  { method: "POST", path: "/safety/checks/:id/results", permissions: ["safety_checks.manage"], riskLevel: "medium" },
  { method: "POST", path: "/analytics/metrics", permissions: ["metrics.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/analytics/anomalies/:id", permissions: ["analytics.configure"], riskLevel: "medium" },
  { method: "POST", path: "/analytics/properties/:propertyId/reports", permissions: ["analytics.configure"], riskLevel: "medium" },
  // POST /developer/apps and POST /developer/apps/:appId/rotate-secret are
  // declared once, above (developer.manage_webhooks): findRoutePermission is an
  // exact first-wins match, so the second /developer/apps entry and the
  // `:id`-named rotate-secret variant here were dead code. PATCH
  // /developer/apps/:id is not registered anywhere (audit 2026-09-13).
  // AI Operations — pipeline status (Sprint 48, tool-call telemetry)
  { method: "GET", path: "/ai-operations/pipeline/dashboard", permissions: ["ai_governance.read"], riskLevel: "low" },
  { method: "GET", path: "/ai-operations/pipeline/calls/:id", permissions: ["ai_governance.read"], riskLevel: "low" },
  // AI Operations — Tool Registry (Sprint 47): catalog + per-property enablement.
  // Reads: ai_governance.read; writes: ai_tool_registry.manage (closest existing key to ai_governance.manage).
  { method: "POST", path: "/ai-operations/tools/sync", permissions: ["ai_tool_registry.manage"], riskLevel: "high" },
  { method: "GET", path: "/ai-operations/tools", permissions: ["ai_governance.read"], riskLevel: "low" },
  { method: "GET", path: "/ai-operations/tools/stats", permissions: ["ai_governance.read"], riskLevel: "low" },
  { method: "GET", path: "/ai-operations/tools/property-settings", permissions: ["ai_governance.read"], riskLevel: "low" },
  { method: "POST", path: "/ai-operations/tools/property-settings", permissions: ["ai_tool_registry.manage"], riskLevel: "high" },
  { method: "GET", path: "/ai-operations/tools/:toolName", permissions: ["ai_governance.read"], riskLevel: "low" },
  // AI Operations — per-property AI settings (Sprint 51): master switch + defaults.
  // Reads: ai_governance.read; writes: ai.high_risk.confirm (no ai_governance.manage perm exists).
  { method: "GET", path: "/ai-operations/property/settings", permissions: ["ai_governance.read"], riskLevel: "low" },
  { method: "POST", path: "/ai-operations/property/settings", permissions: ["ai.high_risk.confirm"], riskLevel: "high" },
  { method: "GET", path: "/ai-operations/property/readiness", permissions: ["ai_governance.read"], riskLevel: "low" },
  { method: "GET", path: "/ai-operations/property/configured", permissions: ["ai_governance.read"], riskLevel: "low" },
  // AI Operations — Governance center (Sprint 49): policies, prompts, evals, incidents, cost.
  // Reads: ai_governance.read / analytics.read; writes: ai_governance.configure; higher-risk
  // operations (publish prompt, run/create eval, incident mutations) use the dedicated perms.
  { method: "GET", path: "/ai-operations/governance/policies", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "POST", path: "/ai-operations/governance/policies", permissions: ["ai_governance.configure"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/governance/policies/:id/active", permissions: ["ai_governance.configure"], riskLevel: "high" },
  { method: "GET", path: "/ai-operations/governance/prompts", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "GET", path: "/ai-operations/governance/prompts/:promptCode/versions", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "GET", path: "/ai-operations/governance/prompts/diff", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "POST", path: "/ai-operations/governance/prompts/versions", permissions: ["ai_prompts.manage"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/governance/prompts/versions/:id/publish", permissions: ["ai_prompts.manage"], riskLevel: "critical" },
  { method: "POST", path: "/ai-operations/governance/prompts/versions/:id/archive", permissions: ["ai_prompts.manage"], riskLevel: "high" },
  { method: "GET", path: "/ai-operations/governance/evaluations", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "POST", path: "/ai-operations/governance/evaluations", permissions: ["ai_evals.manage"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/governance/evaluations/:id/run", permissions: ["ai_evals.manage"], riskLevel: "high" },
  { method: "GET", path: "/ai-operations/governance/incidents", permissions: ["ai_incidents.read"], riskLevel: "medium" },
  { method: "POST", path: "/ai-operations/governance/incidents", permissions: ["ai_incidents.manage"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/governance/incidents/:id/assign", permissions: ["ai_incidents.manage"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/governance/incidents/:id/resolve", permissions: ["ai_incidents.manage"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/governance/incidents/:id/reopen", permissions: ["ai_incidents.manage"], riskLevel: "high" },
  { method: "GET", path: "/ai-operations/governance/cost", permissions: ["analytics.read"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/dashboard", permissions: ["backoffice.access"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/configuration", permissions: ["configuration.read"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/configuration/categories", permissions: ["categories.read"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode", permissions: ["categories.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/options", permissions: ["categories.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/configuration/category-options/:optionId", permissions: ["categories.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/category-options/:optionId/deactivate", permissions: ["categories.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/category-options/:optionId/reactivate", permissions: ["categories.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/reorder", permissions: ["categories.manage"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/properties/:propertyId/configuration/custom-fields", permissions: ["custom_fields.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/custom-fields", permissions: ["custom_fields.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/configuration/custom-fields/:fieldId", permissions: ["custom_fields.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/custom-fields/:fieldId/deactivate", permissions: ["custom_fields.manage"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/properties/:propertyId/configuration/entity/:entityType/:entityId/custom-fields", permissions: ["custom_fields.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/configuration/entity/:entityType/:entityId/custom-fields", permissions: ["custom_fields.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/categories/seed-defaults", permissions: ["categories.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/categories/import", permissions: ["categories.import"], riskLevel: "critical" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/categories/export", permissions: ["categories.export"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/configuration/category-templates", permissions: ["categories.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/category-templates/:templateCode/apply-preview", permissions: ["categories.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/category-templates/:templateCode/apply", permissions: ["categories.manage"], riskLevel: "critical" },
  { method: "POST", path: "/backoffice/properties/:propertyId/configuration/ai/suggest-categories", permissions: ["ai_category_setup.use"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/properties/:propertyId/setup", permissions: ["backoffice.access"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/manual-setup/options", permissions: ["configuration.read"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/manual-setup/:optionCode", permissions: ["configuration.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/manual-setup/:optionCode", permissions: ["configuration.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/manual-setup/:optionCode", permissions: ["configuration.manage"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/properties/:propertyId/property-setup/forms", permissions: ["configuration.read"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/property-setup/forms/:formCode", permissions: ["configuration.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/property-setup/forms/:formCode", permissions: ["property.configure"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/property-setup/forms/:formCode", permissions: ["property.configure"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/setup/:stepCode", permissions: ["property.configure"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/properties/:propertyId/readiness", permissions: ["backoffice.access"], riskLevel: "medium" },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/readiness/recalculate",
    permissions: ["property.configure"],
    riskLevel: "high"
  },
  { method: "POST", path: "/backoffice/properties/:propertyId/go-live", permissions: ["property.go_live"], riskLevel: "critical" },
  { method: "GET", path: "/backoffice/properties/:propertyId/map", permissions: ["property.map.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/buildings", permissions: ["property.map.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/floors", permissions: ["property.map.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/zones", permissions: ["property.map.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/spaces", permissions: ["property.map.manage"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/rooms/bulk", permissions: ["property.map.manage"], riskLevel: "critical" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/rooms/bulk", permissions: ["property.map.manage"], riskLevel: "critical" },
  { method: "GET", path: "/backoffice/properties/:propertyId/room-types", permissions: ["property.map.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/room-types", permissions: ["property.map.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/room-types/:roomTypeId", permissions: ["property.map.manage"], riskLevel: "high" },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/room-types/:roomTypeId/deactivate",
    permissions: ["property.map.manage"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/room-types/:roomTypeId/merge",
    permissions: ["property.map.manage"],
    riskLevel: "critical"
  },
  { method: "GET", path: "/backoffice/room-types/:roomTypeId/rooms", permissions: ["property.map.read"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/room-features", permissions: ["property.map.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/room-features", permissions: ["property.map.manage"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/properties/:propertyId/bed-types", permissions: ["property.map.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/bed-types", permissions: ["property.map.manage"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/properties/:propertyId/imports/:importId", permissions: ["property.import"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/modules", permissions: ["modules.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/modules/:moduleCode", permissions: ["modules.configure"], riskLevel: "high" },
  {
    method: "GET",
    path: "/backoffice/properties/:propertyId/modules/:moduleCode/configuration",
    permissions: ["modules.read"],
    riskLevel: "medium"
  },
  {
    method: "PATCH",
    path: "/backoffice/properties/:propertyId/modules/:moduleCode/configuration",
    permissions: ["modules.configure"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/modules/:moduleCode/recalculate-health",
    permissions: ["modules.configure"],
    riskLevel: "high"
  },
  { method: "GET", path: "/backoffice/properties/:propertyId/departments", permissions: ["property.configure"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/departments", permissions: ["property.configure"], riskLevel: "high" },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/departments/:departmentId/users",
    permissions: ["users.invite"],
    riskLevel: "high"
  },
  { method: "GET", path: "/backoffice/properties/:propertyId/housekeeping-settings", permissions: ["property.configure"], riskLevel: "medium" },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/housekeeping-sections",
    permissions: ["property.configure"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/housekeeping-sections/:sectionId/rooms",
    permissions: ["property.configure"],
    riskLevel: "high"
  },
  {
    method: "PATCH",
    path: "/backoffice/properties/:propertyId/housekeeping-rules/:ruleCode",
    permissions: ["property.configure"],
    riskLevel: "high"
  },
  { method: "GET", path: "/backoffice/properties/:propertyId/maintenance-settings", permissions: ["property.configure"], riskLevel: "medium" },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/maintenance-areas",
    permissions: ["property.configure"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/maintenance-areas/:areaId/rooms",
    permissions: ["property.configure"],
    riskLevel: "high"
  },
  {
    method: "PATCH",
    path: "/backoffice/properties/:propertyId/maintenance-rules/:ruleCode",
    permissions: ["property.configure"],
    riskLevel: "high"
  },
  { method: "GET", path: "/backoffice/properties/:propertyId/users", permissions: ["users.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/users/invite", permissions: ["users.invite"], riskLevel: "high" },
  // Tanda 3 (CFG-P1-6): roles of the property's organization for the invite
  // role selector, and re-issue of a pending invitation (revokes the previous
  // tokens, sends a new email / returns a copyable link).
  { method: "GET", path: "/backoffice/properties/:propertyId/roles", permissions: ["users.invite"], riskLevel: "medium" },
  // Tanda 4 (rutas-cors): creating a role from a template grants permissions
  // to whoever is later invited with it — roles.manage, high (no demo fallback).
  { method: "POST", path: "/backoffice/properties/:propertyId/roles", permissions: ["roles.manage"], riskLevel: "high" },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/users/:userId/reissue-invite",
    permissions: ["users.invite"],
    riskLevel: "high"
  },
  { method: "POST", path: "/backoffice/properties/:propertyId/users/:userId/disable", permissions: ["users.disable"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/roles", permissions: ["roles.manage"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/permissions", permissions: ["permissions.manage"], riskLevel: "medium" },
  { method: "GET", path: "/backoffice/properties/:propertyId/integrations", permissions: ["integrations.read"], riskLevel: "medium" },
  {
    method: "POST",
    path: "/backoffice/properties/:propertyId/integrations/:providerCode/connect",
    permissions: ["integrations.connect", "integrations.manage_credentials"],
    riskLevel: "high"
  },
  {
    method: "GET",
    path: "/backoffice/properties/:propertyId/compliance-settings",
    permissions: ["compliance.read"],
    riskLevel: "high"
  },
  {
    method: "PATCH",
    path: "/backoffice/properties/:propertyId/compliance-settings",
    permissions: ["compliance.configure"],
    riskLevel: "critical"
  },
  { method: "GET", path: "/backoffice/properties/:propertyId/billing-settings", permissions: ["configuration.read"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/billing-settings", permissions: ["billing.configure"], riskLevel: "critical" },
  // Tanda 3 (iva-catalogo) · indirect-tax profile per property. The read shares
  // the compliance-settings read gate (compliance.configure) — the same screen
  // group (Cumplimiento › Fiscal) and the same data owner; the override and the
  // re-provision change what every future invoice charges, hence high.
  { method: "GET", path: "/backoffice/properties/:propertyId/taxes", permissions: ["compliance.configure"], riskLevel: "medium" },
  { method: "PUT", path: "/backoffice/properties/:propertyId/taxes/rates", permissions: ["compliance.configure"], riskLevel: "high" },
  { method: "POST", path: "/backoffice/properties/:propertyId/taxes/provision", permissions: ["compliance.configure"], riskLevel: "high" },
  {
    method: "GET",
    path: "/backoffice/properties/:propertyId/accounting-settings",
    permissions: ["configuration.read"],
    riskLevel: "high"
  },
  {
    method: "PATCH",
    path: "/backoffice/properties/:propertyId/accounting-settings",
    permissions: ["accounting.configure"],
    riskLevel: "critical"
  },
  { method: "GET", path: "/backoffice/properties/:propertyId/ai-settings", permissions: ["ai.configure"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/ai-settings", permissions: ["ai.configure"], riskLevel: "critical" },
  { method: "GET", path: "/backoffice/properties/:propertyId/templates", permissions: ["templates.read"], riskLevel: "medium" },
  { method: "POST", path: "/backoffice/properties/:propertyId/templates", permissions: ["templates.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/backoffice/properties/:propertyId/templates/:templateId", permissions: ["templates.manage"], riskLevel: "high" },
  { method: "GET", path: "/backoffice/properties/:propertyId/audit", permissions: ["audit.read"], riskLevel: "high" },
  { method: "GET", path: "/modules/catalog", permissions: ["modules.read"], riskLevel: "low" },
  { method: "GET", path: "/modules/:moduleCode/dependencies", permissions: ["modules.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/modules", permissions: ["modules.read"], riskLevel: "low" },
  { method: "PATCH", path: "/properties/:propertyId/modules/:moduleCode/enable", permissions: ["modules.enable"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/modules/:moduleCode/disable", permissions: ["modules.disable"], riskLevel: "high" },
  { method: "GET", path: "/integrations/categories", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "GET", path: "/integrations/providers", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/integrations", permissions: ["integrations.read"], riskLevel: "low" },
  {
    method: "POST",
    path: "/properties/:propertyId/integrations/:providerCode/connect",
    permissions: ["integrations.connect", "integrations.manage_credentials"],
    riskLevel: "high"
  },
  { method: "PATCH", path: "/properties/:propertyId/integrations/:connectionId", permissions: ["integrations.connect"], riskLevel: "medium" },
  {
    method: "DELETE",
    path: "/properties/:propertyId/integrations/:connectionId",
    permissions: ["integrations.disconnect"],
    riskLevel: "high"
  },
  { method: "POST", path: "/properties/:propertyId/integrations/:connectionId/test", permissions: ["integrations.test"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/integrations/:connectionId/events", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "POST", path: "/offline/sync", permissions: ["ai.tool.execute"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/offline-sync-records", permissions: ["ai.tool.execute"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/dashboard", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/rooms", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/rooms", permissions: ["pms.reservation.modify"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/room-types", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/reservations", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/availability/quote", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/reservations", permissions: ["pms.reservation.create"], riskLevel: "medium" },
  { method: "GET", path: "/reservations/:id", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "PATCH", path: "/reservations/:id", permissions: ["pms.reservation.modify"], riskLevel: "medium" },
  { method: "POST", path: "/reservations/:id/assign-room", permissions: ["pms.reservation.modify"], riskLevel: "high" },
  { method: "POST", path: "/reservations/:id/check-in", permissions: ["pms.checkin.execute"], riskLevel: "high" },
  { method: "POST", path: "/reservations/:id/check-out", permissions: ["pms.checkout.execute"], riskLevel: "high" },
  { method: "POST", path: "/reservations/:id/cancel", permissions: ["pms.reservation.modify"], riskLevel: "high" },
  { method: "POST", path: "/reservations/:id/no-show", permissions: ["pms.reservation.modify"], riskLevel: "high" },
  { method: "GET", path: "/reservations/:id/folio", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/folios/:id/lines", permissions: ["folio.charge.post"], riskLevel: "medium" },
  { method: "POST", path: "/folios/:id/payments", permissions: ["payment.capture"], riskLevel: "high" },
  { method: "POST", path: "/payments/:id/refund", permissions: ["payment.refund"], riskLevel: "critical" },
  { method: "POST", path: "/folios/:id/close", permissions: ["folio.charge.post"], riskLevel: "medium" },
  // Tanda 5 (L1c · api): invoice GETs carry invoice.read (were invoice.issue,
  // a write key: reception opened Facturación y cobros and got 403).
  { method: "GET", path: "/properties/:propertyId/invoices", permissions: ["invoice.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/invoice-branding", permissions: ["billing.compliance.view"], riskLevel: "low" },
  { method: "PATCH", path: "/properties/:propertyId/invoice-branding", permissions: ["property.configure"], riskLevel: "high" },
  { method: "POST", path: "/invoices/drafts", permissions: ["invoice.issue"], riskLevel: "high" },
  // PATCH /invoices/:id is not registered (issued invoices are immutable; drafts
  // go through /invoices/drafts). Orphan entry removed, audit 2026-09-13.
  { method: "POST", path: "/invoices/:id/issue", permissions: ["invoice.issue"], riskLevel: "critical" },
  { method: "POST", path: "/invoices/:id/cancel", permissions: ["invoice.cancel"], riskLevel: "critical" },
  { method: "POST", path: "/invoices/:id/rectify", permissions: ["invoice.issue"], riskLevel: "high" },
  { method: "GET", path: "/invoices/:id/rectifications", permissions: ["invoice.read"], riskLevel: "low" },
  // Folio/Billing advanced (Sprint 40). All medium risk: they mutate folios
  // and invoices but stay idempotent and reversible (split/move can be undone
  // by another move; mark-paid is mirrored by refundPayment).
  // Same keys the folio.service guards enforce (billing.* keys are not in the
  // runtime permission catalog).
  { method: "POST", path: "/folios/:id/split", permissions: ["folio.charge.post"], riskLevel: "medium" },
  { method: "POST", path: "/folios/:sourceId/move-charges", permissions: ["folio.charge.post"], riskLevel: "medium" },
  { method: "POST", path: "/invoices/:id/mark-paid", permissions: ["payment.capture"], riskLevel: "medium" },
  { method: "POST", path: "/invoices/:id/send-email", permissions: ["invoice.issue"], riskLevel: "medium" },
  { method: "GET", path: "/reports/properties/:propertyId/catalog", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/reports/properties/:propertyId/reservations", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/reports/properties/:propertyId/billing", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "POST", path: "/reports/properties/:propertyId/export", permissions: ["analytics.export"], riskLevel: "high" },
  // Corrector FIX-1 (SEC-06): high like the POST that generates it — the demo fallback without token never serves the file.
  { method: "GET", path: "/reports/exports/:exportId/download", permissions: ["analytics.export"], riskLevel: "high" },
  { method: "GET", path: "/organizations/:organizationId/accounts", permissions: ["accounting.journal.post"], riskLevel: "medium" },
  { method: "GET", path: "/organizations/:organizationId/journal-entries", permissions: ["accounting.journal.post"], riskLevel: "medium" },
  { method: "POST", path: "/journal-entries/drafts", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/journal-entries/:id/post", permissions: ["accounting.journal.post", "ai.high_risk.confirm"], riskLevel: "critical" },
  // Tanda T9 (T9-15): las entradas heredadas GET /properties/:propertyId/supplier-bills y POST /supplier-bills/drafts
  // se retiraron con sus rutas (canónicas en modules/payables/route-permissions.partial.ts).
  // Tanda 5 (L1c · api): bank data is accounting, not a dashboard — banking.read
  // (owner/manager/accountant) instead of analytics.read (every template).
  { method: "GET", path: "/banking/accounts", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "POST", path: "/banking/accounts", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "GET", path: "/banking/accounts/:id/balance", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "GET", path: "/banking/accounts/:id/statements", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "POST", path: "/banking/accounts/:id/statements/import-csv", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "GET", path: "/banking/accounts/:id/reconciliation-status", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "GET", path: "/banking/statements/:id", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "POST", path: "/banking/statements/:id/auto-match", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "POST", path: "/banking/lines/:bankLineId/match", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "DELETE", path: "/banking/lines/:bankLineId/match", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/housekeeping/board", permissions: ["housekeeping.read"], riskLevel: "low" },
  { method: "POST", path: "/housekeeping/tasks", permissions: ["housekeeping.task.manage"], riskLevel: "low" },
  { method: "PATCH", path: "/housekeeping/tasks/:id", permissions: ["housekeeping.task.manage"], riskLevel: "low" },
  { method: "POST", path: "/housekeeping/tasks/:id/photo", permissions: ["housekeeping.task.manage"], riskLevel: "low" },
  { method: "POST", path: "/rooms/:id/mark-clean", permissions: ["housekeeping.task.manage"], riskLevel: "medium" },
  { method: "POST", path: "/rooms/:id/mark-inspected", permissions: ["housekeeping.task.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/work-orders", permissions: ["maintenance.read"], riskLevel: "low" },
  { method: "POST", path: "/work-orders", permissions: ["maintenance.workorder.create"], riskLevel: "low" },
  { method: "PATCH", path: "/work-orders/:id", permissions: ["maintenance.workorder.manage"], riskLevel: "low" },
  { method: "POST", path: "/work-orders/:id/media", permissions: ["maintenance.workorder.manage"], riskLevel: "low" },
  {
    method: "POST",
    path: "/work-orders/:id/block-room",
    permissions: ["maintenance.workorder.manage", "ai.high_risk.confirm"],
    riskLevel: "critical"
  },
  { method: "POST", path: "/work-orders/:id/resolve", permissions: ["maintenance.workorder.manage"], riskLevel: "medium" },
  // PILOT-D4 · Salud de las integraciones ES (sin propertyId — vista global)
  { method: "GET", path: "/compliance/health", permissions: ["billing.compliance.view"], riskLevel: "low" },
  { method: "PATCH", path: "/compliance/properties/:propertyId/items/:requirementCode", permissions: ["compliance.configure"], riskLevel: "medium" },
  { method: "PATCH", path: "/compliance/properties/:propertyId/profile", permissions: ["compliance.configure"], riskLevel: "medium" },
  { method: "POST", path: "/compliance/properties/:propertyId/tasks", permissions: ["compliance.configure"], riskLevel: "low" },
  { method: "PATCH", path: "/compliance/tasks/:id", permissions: ["compliance.configure"], riskLevel: "low" },
  { method: "DELETE", path: "/compliance/tasks/:id", permissions: ["compliance.configure"], riskLevel: "low" },
  { method: "POST", path: "/compliance/properties/:propertyId/documents", permissions: ["compliance.configure"], riskLevel: "low" },
  { method: "POST", path: "/compliance/ocr/extract-dates", permissions: ["compliance.configure"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/cancellation-policies", permissions: ["pms.reservation.modify"], riskLevel: "low" },
  { method: "PATCH", path: "/cancellation-policies/:id", permissions: ["pms.reservation.modify"], riskLevel: "low" },
  { method: "DELETE", path: "/cancellation-policies/:id", permissions: ["pms.reservation.modify"], riskLevel: "low" },
  { method: "POST", path: "/reservations/:id/apply-cancellation-fee", permissions: ["folio.charge.post", "pms.reservation.modify"], riskLevel: "medium" },
  { method: "POST", path: "/reservations/:id/apply-no-show-fee", permissions: ["folio.charge.post", "pms.reservation.modify"], riskLevel: "medium" },
  { method: "POST", path: "/organizations/:organizationId/tour-operators", permissions: ["channel_manager.manage"], riskLevel: "low" },
  { method: "PATCH", path: "/tour-operators/:id", permissions: ["channel_manager.manage"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/allotments", permissions: ["channel_manager.manage"], riskLevel: "low" },
  { method: "PATCH", path: "/allotments/:id", permissions: ["channel_manager.manage"], riskLevel: "low" },
  { method: "DELETE", path: "/allotments/:id", permissions: ["channel_manager.manage"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/allotments/release-expired", permissions: ["channel_manager.manage"], riskLevel: "medium" },
  { method: "POST", path: "/reservations/:id/folios", permissions: ["folio.charge.post"], riskLevel: "low" },
  { method: "POST", path: "/reservations/:id/routing-rules", permissions: ["folio.charge.post"], riskLevel: "low" },
  { method: "PATCH", path: "/routing-rules/:id", permissions: ["folio.charge.post"], riskLevel: "low" },
  { method: "DELETE", path: "/routing-rules/:id", permissions: ["folio.charge.post"], riskLevel: "low" },
  { method: "POST", path: "/folio-lines/:lineId/transfer", permissions: ["folio.charge.post"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/stock-locations", permissions: ["inventory.manage"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/inventory-items", permissions: ["inventory.manage"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/stock-movements", permissions: ["inventory.manage"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/menu-items", permissions: ["inventory.manage"], riskLevel: "low" },
  { method: "POST", path: "/menu-items/:id/recipes", permissions: ["inventory.manage"], riskLevel: "low" },
  { method: "DELETE", path: "/menu-recipes/:id", permissions: ["inventory.manage"], riskLevel: "low" },
  { method: "DELETE", path: "/compliance/documents/:id", permissions: ["compliance.configure"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/capex", permissions: ["capex.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/assets", permissions: ["assets.read"], riskLevel: "low" },
  { method: "POST", path: "/assets", permissions: ["maintenance.workorder.manage"], riskLevel: "medium" },
  { method: "PATCH", path: "/assets/:id", permissions: ["maintenance.workorder.manage"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/fixed-assets", permissions: ["accounting.journal.post"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/room-profitability", permissions: ["pms.reservation.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/owner-dashboard", permissions: ["pms.reservation.read"], riskLevel: "medium" },
  { method: "POST", path: "/capex-projects", permissions: ["capex.create"], riskLevel: "high" },
  { method: "PATCH", path: "/capex-projects/:id", permissions: ["capex.create"], riskLevel: "high" },
  { method: "POST", path: "/capex-projects/:id/items", permissions: ["capex.create"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/conversations", permissions: ["ai.tool.execute"], riskLevel: "low" },
  { method: "GET", path: "/conversations/:id/messages", permissions: ["ai.tool.execute"], riskLevel: "low" },
  { method: "POST", path: "/conversations/:id/messages", permissions: ["ai.tool.execute"], riskLevel: "medium" },
  { method: "POST", path: "/conversations/:id/ai-draft", permissions: ["ai.tool.execute"], riskLevel: "low" },
  { method: "POST", path: "/service-requests", permissions: ["ai.tool.execute"], riskLevel: "low" },
  { method: "PATCH", path: "/service-requests/:id", permissions: ["ai.tool.execute"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/compliance/inbox", permissions: ["guest_register.read"], riskLevel: "medium" },
  // Tanda 5 (L1c · api): the SES settings tab is visible to reception; reading
  // the settings is guest_register.read, configuring stays guest_register.configure.
  {
    method: "GET",
    path: "/compliance/spain/properties/:propertyId/guest-register/settings",
    permissions: ["guest_register.read"],
    riskLevel: "medium"
  },
  {
    method: "PATCH",
    path: "/compliance/spain/properties/:propertyId/guest-register/settings",
    permissions: ["guest_register.configure", "compliance.ses.configure"],
    riskLevel: "high"
  },
  {
    method: "GET",
    path: "/compliance/spain/reservations/:reservationId/guest-register",
    permissions: ["guest_register.read"],
    riskLevel: "medium"
  },
  {
    method: "POST",
    path: "/compliance/spain/reservations/:reservationId/guest-register",
    permissions: ["guest_register.create"],
    riskLevel: "high"
  },
  { method: "PATCH", path: "/compliance/spain/guest-register/:recordId", permissions: ["guest_register.edit"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/ses/submissions", permissions: ["compliance.ses.submit"], riskLevel: "high" },
  {
    method: "POST",
    path: "/compliance/spain/guest-register/:recordId/validate",
    permissions: ["guest_register.read"],
    riskLevel: "medium"
  },
  {
    method: "POST",
    path: "/compliance/spain/guest-register/:recordId/sign",
    permissions: ["guest_register.sign", "pms.checkin.execute"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/spain/guest-register/:recordId/mark-identity-verified",
    permissions: ["guest_register.edit"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/spain/guest-register/:recordId/queue-submission",
    permissions: ["guest_register.submit", "compliance.ses.submit"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/spain/guest-register/:recordId/correct",
    permissions: ["guest_register.correct"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/spain/guest-register/:recordId/annul",
    permissions: ["guest_register.annul"],
    riskLevel: "critical"
  },
  {
    method: "POST",
    path: "/compliance/spain/identity-document/temporary-scan",
    permissions: ["guest_register.create"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/spain/identity-document/discard-event",
    permissions: ["guest_register.create"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/ses-hospedajes/properties/:propertyId/batches/generate",
    permissions: ["guest_register.export", "compliance.ses.export"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/submit",
    permissions: ["guest_register.submit", "compliance.ses.submit"],
    riskLevel: "critical"
  },
  {
    method: "GET",
    path: "/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/download",
    permissions: ["guest_register.export", "compliance.ses.export"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/mark-manually-uploaded",
    permissions: ["guest_register.submit", "compliance.ses.submit"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/compliance/ses-hospedajes/properties/:propertyId/test-connection",
    permissions: ["compliance.ses.configure"],
    riskLevel: "medium"
  },
  // AI Booking Agent — natural-language reservation parsing (read-only, no writes).
  { method: "POST", path: "/properties/:propertyId/reservations/ai-parse", permissions: ["pms.reservation.read"], riskLevel: "low" },
  // Guest journey activity feed (chat + housekeeping + maintenance + service requests).
  { method: "GET", path: "/reservations/:id/activity", permissions: ["pms.reservation.read"], riskLevel: "low" },
  // Property Mapper — AI document → property structure (extract is read-only analysis; apply writes rooms).
  { method: "POST", path: "/properties/:propertyId/mapper/extract", permissions: ["property.map.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/mapper/apply", permissions: ["rooms.manage"], riskLevel: "high" },
  // Guest profiles (organization-scoped CRUD).
  { method: "GET", path: "/guests", permissions: ["guests.read"], riskLevel: "medium" },
  { method: "GET", path: "/guests/:id", permissions: ["guests.read"], riskLevel: "medium" },
  { method: "POST", path: "/guests", permissions: ["guests.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/guests/:id", permissions: ["guests.manage"], riskLevel: "high" },
  // GDPR DSAR + Right-to-erasure (Sprint 31). Guarded by compliance.gdpr.manage.
  { method: "POST", path: "/gdpr/requests", permissions: ["compliance.gdpr.manage"], riskLevel: "critical" },
  { method: "GET", path: "/gdpr/requests", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "GET", path: "/gdpr/requests/:id", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "POST", path: "/gdpr/requests/:id/acknowledge", permissions: ["compliance.gdpr.manage"], riskLevel: "high" },
  { method: "POST", path: "/gdpr/requests/:id/fulfill-dsar", permissions: ["compliance.gdpr.manage"], riskLevel: "critical" },
  { method: "POST", path: "/gdpr/requests/:id/execute-erasure", permissions: ["compliance.gdpr.manage"], riskLevel: "critical" },
  { method: "POST", path: "/gdpr/requests/:id/reject", permissions: ["compliance.gdpr.manage"], riskLevel: "high" },
  // Sprint 35 — PII backfill job. Guarded by compliance.gdpr.manage (same
  // sensitive perm as the GDPR DSAR endpoints above). Touches every PII row,
  // hence critical risk.
  { method: "POST", path: "/admin/jobs/pii-backfill", permissions: ["compliance.gdpr.manage"], riskLevel: "critical" },
  { method: "GET", path: "/properties/:propertyId/guest-register-records", permissions: ["guest_register.read"], riskLevel: "medium" },
  { method: "POST", path: "/guest-register-records/:id/sign", permissions: ["pms.checkin.execute"], riskLevel: "high" },
  { method: "PATCH", path: "/guest-register-records/:id/correct", permissions: ["compliance.ses.submit"], riskLevel: "high" },
  { method: "POST", path: "/guest-register-records/:id/queue-ses", permissions: ["compliance.ses.submit"], riskLevel: "high" },
  {
    method: "POST",
    path: "/ai/commands/check-in-from-scan",
    permissions: ["ai.tool.execute", "pms.checkin.execute"],
    riskLevel: "high"
  },
  {
    method: "POST",
    path: "/ai/commands/scan-id-document",
    permissions: ["ai.tool.execute"],
    riskLevel: "medium"
  },
  {
    method: "POST",
    path: "/onboarding/ai/suggest-mapping",
    permissions: ["onboarding.ai_map"],
    riskLevel: "low"
  },
  {
    method: "POST",
    path: "/ai/confirmations/:confirmationId/execute",
    permissions: ["ai.tool.execute", "pms.checkin.execute"],
    riskLevel: "critical"
  },
  { method: "GET", path: "/audit-events", permissions: ["audit.read"], riskLevel: "high" },
  { method: "GET", path: "/audit-events/facets", permissions: ["audit.read"], riskLevel: "high" },
  { method: "GET", path: "/audit-events/integrity", permissions: ["audit.read"], riskLevel: "high" },
  { method: "GET", path: "/events", permissions: ["audit.read"], riskLevel: "high" },
  { method: "GET", path: "/events/integrity", permissions: ["audit.read"], riskLevel: "high" },
  { method: "GET", path: "/ai/tool-calls", permissions: ["audit.read"], riskLevel: "high" },
  { method: "POST", path: "/ai/tool-calls/:id/confirm", permissions: ["ai.tool.execute"], riskLevel: "high" },
  { method: "POST", path: "/accounting/fiscal-periods", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/accounting/fiscal-periods/:id/close", permissions: ["accounting.period.close"], riskLevel: "high" },
  { method: "POST", path: "/accounting/fiscal-periods/:id/reopen", permissions: ["accounting.journal.post", "ai.high_risk.confirm"], riskLevel: "high" },
  // Sprint 25 — Year-end close (Spanish PGC).
  // Tanda 5 (L1c · api): the fiscal calendar is accounting reference data —
  // accounting.read (manager/accountant/compliance) instead of analytics.read.
  { method: "GET", path: "/accounting/fiscal-years", permissions: ["accounting.read"], riskLevel: "low" },
  { method: "POST", path: "/accounting/fiscal-years", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/accounting/fiscal-years/:id/status", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/accounting/fiscal-years/:id/close", permissions: ["accounting.period.close", "ai.high_risk.confirm"], riskLevel: "critical" },
  { method: "POST", path: "/accounting/fiscal-years/:id/reopen", permissions: ["accounting.journal.post", "ai.high_risk.confirm"], riskLevel: "critical" },
  { method: "POST", path: "/folios/:id/invoice", permissions: ["invoice.issue"], riskLevel: "medium" },
  { method: "POST", path: "/verifactu/submissions/:id/retry", permissions: ["compliance.ses.submit"], riskLevel: "medium" },
  { method: "POST", path: "/tbai/submissions/:id/retry", permissions: ["compliance.ses.submit"], riskLevel: "medium" },
  { method: "POST", path: "/igic/submissions/:id/retry", permissions: ["compliance.ses.submit"], riskLevel: "medium" },
  { method: "POST", path: "/ses/submissions/:id/retry", permissions: ["compliance.ses.submit"], riskLevel: "medium" },
  // Finanzas (2026-09-16, fix t6#9): the legacy accounting reports show
  // amounts (sumas y saldos, balance, flujos, PyG, retenciones 111/115/180) —
  // accounting.reports.read (finanzas + direccion) instead of analytics.read,
  // which every template holds for «Mi día». The modelo services still check
  // analytics.read themselves; the edge gate is the narrower one.
  { method: "GET", path: "/accounting/reports/trial-balance", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/reports/balance-sheet", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/reports/cash-flow", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/reports/pnl", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/reports/modelo-111", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/reports/modelo-115", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/reports/modelo-180", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  // Tanda 5 (L1c · api): commissions.read (finanzas, comercial, direccion) instead of analytics.read.
  { method: "GET", path: "/commissions/rules", permissions: ["commissions.read"], riskLevel: "medium" },
  { method: "POST", path: "/commissions/rules", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/commissions/rules/:id/deactivate", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/commissions/accruals", permissions: ["commissions.read"], riskLevel: "medium" },
  { method: "GET", path: "/commissions/summary", permissions: ["commissions.read"], riskLevel: "medium" },
  { method: "GET", path: "/dashboards/housekeeping", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/front-desk", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/front-desk-queue", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/room-rack", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/housekeeping-mobile", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/maintenance-mobile", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/shift-manager", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/general-manager", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/general-manager/pace", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/operations-director", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/developer/api-reference", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/rooms/:id/housekeeping-status", permissions: ["housekeeping.task.manage"], riskLevel: "low" },
  { method: "POST", path: "/rooms/:id/sellable", permissions: ["housekeeping.task.manage"], riskLevel: "low" },
  { method: "GET", path: "/copilot/presets", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/copilot/ask", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/guests/:id/timeline", permissions: ["guests.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/maintenance", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/finance-position", permissions: ["analytics.read"], riskLevel: "medium" },
  { method: "GET", path: "/dashboards/concierge", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/reputation", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/sales-pipeline", permissions: ["analytics.read"], riskLevel: "medium" },
  { method: "GET", path: "/dashboards/workforce", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/crm", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/loyalty", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/upsells", permissions: ["analytics.read"], riskLevel: "low" },
  // Tanda 3 (CF-02) · staff catalogue of upsell offers over Prisma UpsellOffer
  // (the only source the dashboard above reads). The former front paths under
  // /guest-self-service/upsell_offers never existed (404). PATCH is by entity
  // id → tenant guard through the `upsellOffer` resolver in lib/tenancy.ts.
  { method: "GET", path: "/properties/:propertyId/upsell-offers", permissions: ["guest_self_service.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/upsell-offers", permissions: ["guest_self_service.manage"], riskLevel: "medium" },
  { method: "PATCH", path: "/upsell-offers/:id", permissions: ["guest_self_service.manage"], riskLevel: "medium" },
  { method: "GET", path: "/dashboards/surveys", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/quality", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/safety", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/inventory", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/procurement", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/groups-events", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/pos", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/channel-performance", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/energy", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/sustainability", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/assets", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/room-profitability", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/analytics-center", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/dashboards/portfolio", permissions: ["analytics.read"], riskLevel: "medium" },
  { method: "GET", path: "/dashboards/property-overview", permissions: ["analytics.read"], riskLevel: "low" },
  // Payroll bridge to gestoría (Sprint 23 — Track 5)
  // Tanda 5 (L1c · api): payroll is employee data — payroll.read (owner/manager/
  // accountant) instead of analytics.read (every template could list contracts).
  { method: "GET", path: "/payroll/contracts", permissions: ["payroll.read"], riskLevel: "medium" },
  { method: "POST", path: "/payroll/contracts", permissions: ["payroll.manage"], riskLevel: "high" },
  { method: "POST", path: "/payroll/contracts/:id/deactivate", permissions: ["payroll.manage"], riskLevel: "high" },
  { method: "GET", path: "/payroll/periods", permissions: ["payroll.read"], riskLevel: "medium" },
  { method: "POST", path: "/payroll/periods", permissions: ["payroll.manage"], riskLevel: "high" },
  { method: "POST", path: "/payroll/periods/:id/calculate", permissions: ["payroll.manage"], riskLevel: "high" },
  { method: "GET", path: "/payroll/periods/:id/slips", permissions: ["payroll.read"], riskLevel: "medium" },
  { method: "GET", path: "/payroll/periods/:id/export", permissions: ["payroll.read"], riskLevel: "medium" },
  // Multi-currency exchange rates (Sprint 24)
  { method: "GET", path: "/finance/exchange-rates", permissions: ["accounting.read"], riskLevel: "low" },
  { method: "POST", path: "/finance/exchange-rates", permissions: ["accounting.journal.post"], riskLevel: "high" },
  // Notification engine (Sprint 26)
  { method: "GET", path: "/notifications/templates", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/notifications/templates", permissions: ["notifications.manage"], riskLevel: "medium" },
  { method: "POST", path: "/notifications/templates/:id/deactivate", permissions: ["notifications.manage"], riskLevel: "medium" },
  { method: "GET", path: "/notifications/deliveries", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/notifications/deliveries/:id/retry", permissions: ["notifications.manage"], riskLevel: "medium" },
  { method: "POST", path: "/notifications/dispatch", permissions: ["notifications.manage"], riskLevel: "high" },
  { method: "GET", path: "/notifications/template-stats", permissions: [], riskLevel: "authenticated" },
  // Tanda 3 (CFG-P1-6): whether outbound email is real, simulated or disabled,
  // so invitation screens show a copyable link instead of a fake "sent".
  // Gated like the invitation itself (users.invite): it reveals provider config.
  { method: "GET", path: "/notifications/email-status", permissions: ["users.invite"], riskLevel: "low" },
  // Sprint 50 — AI Human Review Queue (HITL). Reads gated by AI governance read;
  // decisions require the high-risk confirmation permission.
  { method: "GET", path: "/ai-operations/review/queue", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "GET", path: "/ai-operations/review/stats", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "GET", path: "/ai-operations/review/:id", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "POST", path: "/ai-operations/review/:id/assign", permissions: ["ai_governance.read"], riskLevel: "medium" },
  { method: "POST", path: "/ai-operations/review/:id/approve", permissions: ["ai.high_risk.confirm"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/review/:id/reject", permissions: ["ai.high_risk.confirm"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/review/:id/escalate", permissions: ["ai.high_risk.confirm"], riskLevel: "high" },
  { method: "POST", path: "/ai-operations/review/enqueue", permissions: ["ai.high_risk.confirm"], riskLevel: "high" },
  // Stored card tokens — high-risk because the tokenRef can be replayed against
  // the PSP to charge the cardholder. Restricted to staff who can post folio charges.
  { method: "POST", path: "/payment-tokens", permissions: ["folio.charge.post"], riskLevel: "high" },

  // ------------------------------------------------------------------------
  // Sensitive read-only endpoints — manifest gap fill.
  //
  // assertRoutePermission() returns early for GETs that have no manifest entry,
  // which leaves read access to financial submissions, PII profiles, allotment
  // inventory and guest-portal session data effectively ungated by RBAC. The
  // entries below register the minimum permission expected for each module.
  // ------------------------------------------------------------------------

  // Financial / fiscal submissions — submission detail rows contain customer
  // tax data and authority correlation IDs. Read access piggybacks on the
  // existing compliance.ses.submit perm (same scope as the POST/retry routes).
  { method: "GET", path: "/properties/:propertyId/verifactu/submissions", permissions: ["billing.compliance.view"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/igic/submissions", permissions: ["billing.compliance.view"], riskLevel: "medium" },
  { method: "GET", path: "/verifactu/submissions/:id", permissions: ["billing.compliance.view"], riskLevel: "medium" },
  { method: "GET", path: "/tbai/submissions/:id", permissions: ["billing.compliance.view"], riskLevel: "medium" },
  { method: "GET", path: "/igic/submissions/:id", permissions: ["billing.compliance.view"], riskLevel: "medium" },
  { method: "GET", path: "/ses/submissions/:id", permissions: ["guest_register.read"], riskLevel: "medium" },

  // Folio + invoice reads — financial PII.
  { method: "GET", path: "/folios/:id/balance", permissions: ["folio.read"], riskLevel: "low" },
  { method: "GET", path: "/invoices/:id", permissions: ["invoice.read"], riskLevel: "medium" },
  { method: "GET", path: "/invoices/:id/verifactu", permissions: ["billing.compliance.view"], riskLevel: "medium" },

  // Reservation child reads — folios, routing rules and cancellation charge
  // expose monetary state belonging to the reservation.
  { method: "GET", path: "/reservations/:id/folios", permissions: ["folio.read"], riskLevel: "low" },
  { method: "GET", path: "/reservations/:id/routing-rules", permissions: ["folio.read"], riskLevel: "low" },
  { method: "GET", path: "/reservations/:id/cancellation-charge", permissions: ["pms.reservation.read"], riskLevel: "low" },

  // Allotments / tour-operators — block inventory readable only by channel mgr.
  { method: "GET", path: "/properties/:propertyId/allotments", permissions: ["channel_manager.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/allotments/remaining-for-day", permissions: ["channel_manager.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/allotments/pickup-summary", permissions: ["channel_manager.read"], riskLevel: "low" },
  { method: "GET", path: "/allotments/:id", permissions: ["channel_manager.read"], riskLevel: "low" },
  { method: "GET", path: "/allotments/:id/remaining", permissions: ["channel_manager.read"], riskLevel: "low" },
  { method: "GET", path: "/organizations/:organizationId/tour-operators", permissions: ["channel_manager.read"], riskLevel: "low" },
  { method: "GET", path: "/tour-operators/:id", permissions: ["channel_manager.read"], riskLevel: "low" },

  // Cancellation policies — read-only catalog tied to pms.reservation perms.
  { method: "GET", path: "/properties/:propertyId/cancellation-policies", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "GET", path: "/cancellation-policies/:id", permissions: ["pms.reservation.read"], riskLevel: "low" },

  // CRM reads — segments, campaigns and loyalty are PII (profiles / duplicates:
  // memory-only legs retired in Tanda L2 · L2-02).
  { method: "GET", path: "/crm/segments", permissions: ["crm.read"], riskLevel: "medium" },
  { method: "GET", path: "/crm/campaigns", permissions: ["crm.read"], riskLevel: "medium" },
  { method: "GET", path: "/crm/loyalty", permissions: ["crm.read"], riskLevel: "medium" },

  // Sales / Groups — pipeline reads.
  { method: "GET", path: "/sales/accounts", permissions: ["sales.pipeline.read"], riskLevel: "medium" },
  { method: "GET", path: "/sales/opportunities", permissions: ["sales.pipeline.read"], riskLevel: "medium" },
  { method: "GET", path: "/groups/:id", permissions: ["groups.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/groups/pickup-summary", permissions: ["groups.read"], riskLevel: "low" },

  // Guest portal sessions — token-scoped reads (the guest token is the auth;
  // the staff permission preHandler must still find a manifest entry).
  { method: "GET", path: "/guest-portal/session/:token", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/guest-portal/session/:token/folio", permissions: [], riskLevel: "public" },

  // Auto-generated OpenAPI spec — public so external tooling can fetch the schema.
  { method: "GET", path: "/developer/openapi.yaml", permissions: [], riskLevel: "public" },

  // audit 2026-06 R2 · #5: compliance center GET routes. The rest of that block
  // (guests, folio balance, invoices, compliance/health, guest-register and SES
  // authority reads) duplicated entries declared earlier in this array; since
  // findRoutePermission is first-wins they never applied at runtime and were
  // removed in the 2026-09-13 audit (0 duplicates is now enforced by CI, see
  // tests/api-route-permissions-contract.test.mjs).
  { method: "GET", path: "/compliance/properties/:propertyId/center", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "GET", path: "/compliance/properties/:propertyId/tasks", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "GET", path: "/compliance/properties/:propertyId/documents", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "GET", path: "/compliance/properties/:propertyId/alerts", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "GET", path: "/compliance/properties/:propertyId/inspection-folder", permissions: ["compliance.read"], riskLevel: "medium" },
  { method: "GET", path: "/compliance/properties/:propertyId/assistant", permissions: ["compliance.read"], riskLevel: "medium" },

  // Fase 0: Rate Plan CRUD. Mutations are FAIL-CLOSED without a manifest entry
  // (they throw 500), so these are required for the endpoints to work at all.
  { method: "GET", path: "/properties/:propertyId/rate-plans", permissions: ["revenue.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/rate-plans", permissions: ["revenue.manage_rates"], riskLevel: "medium" },
  { method: "PATCH", path: "/rate-plans/:id", permissions: ["revenue.manage_rates"], riskLevel: "medium" },
  { method: "DELETE", path: "/rate-plans/:id", permissions: ["revenue.manage_rates"], riskLevel: "medium" },

  // ── Auditoría 2026-07: mutaciones que EXISTÍAN sin entrada => fail-closed
  // => 500 en cada uso. Consola Tenant-Admin (onboarding de clientes) y Rate
  // Grid V2 (editor de tarifas). El gate real de tenants es admin.tenants.manage
  // (admin-console/tenant-admin.service.ts:27, cast igual que allí porque aún no
  // está en la unión canónica de PermissionKey).
  { method: "GET", path: "/admin/tenants", permissions: ["admin.tenants.manage" as PermissionKey], riskLevel: "high" },
  { method: "GET", path: "/admin/tenants/:orgId", permissions: ["admin.tenants.manage" as PermissionKey], riskLevel: "high" },
  { method: "GET", path: "/admin/tenants/:orgId/audit-log", permissions: ["admin.tenants.manage" as PermissionKey], riskLevel: "high" },
  // Tanda L2 (L2-02): ejecuciones durables del worker (worker_job_runs) para la
  // consola de plataforma; el handler exige además requirePlatformAdmin.
  { method: "GET", path: "/admin/worker/job-runs", permissions: ["admin.tenants.manage" as PermissionKey], riskLevel: "high" },
  { method: "POST", path: "/admin/tenants", permissions: ["admin.tenants.manage" as PermissionKey], riskLevel: "critical" },
  { method: "POST", path: "/admin/tenants/:orgId/users/:userId/reset-password", permissions: ["admin.tenants.manage" as PermissionKey], riskLevel: "critical" },
  // Tanda 3 (CFG-P1-6): replaces the clear-text temp password with a persisted
  // invitation (user_invitations) the owner accepts through /auth/accept-invite.
  { method: "POST", path: "/admin/tenants/:orgId/users/:userId/reissue-invite", permissions: ["admin.tenants.manage" as PermissionKey], riskLevel: "critical" },
  { method: "PATCH", path: "/admin/tenants/:orgId/modules/:moduleCode", permissions: ["admin.tenants.manage" as PermissionKey], riskLevel: "critical" },

  // ── AUTH-03 (auditoría 360 · 2026-09-13): the 62 GET routes that were
  // registered without a manifest entry and therefore ran fail-open. Keys reuse
  // existing PermissionKey values, aligned with the sibling entries of each
  // family (the POST/PATCH of the same resource, or the equivalent read route).
  // Revenue strategy reads.
  { method: "GET", path: "/revenue/properties/:propertyId/period-metrics", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/pricing-rules", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/bar-levels", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/budget", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/budget/variance", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/market-segments", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/revenue/properties/:propertyId/meeting-pack", permissions: ["revenue.read"], riskLevel: "medium" },
  // Email connectors. The OAuth callback is the browser redirect coming back
  // from Google/Microsoft: it carries no bearer token, its CSRF protection is
  // the `state` parameter consumed by handleEmailOAuthCallback. It is public
  // here AND listed in PUBLIC_PREFIXES (lib/auth-context.ts) so the staff auth
  // hook lets it through.
  { method: "GET", path: "/integrations/email/providers", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/email/connections", permissions: ["integrations.read"], riskLevel: "medium" },
  { method: "GET", path: "/email/connections/:id/authorize-url", permissions: ["integrations.connect"], riskLevel: "medium" },
  { method: "GET", path: "/integrations/email/oauth/callback", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/properties/:propertyId/email/inbound", permissions: ["pms.reservation.read"], riskLevel: "medium" },
  // Groups & events.
  { method: "GET", path: "/groups/properties/:propertyId", permissions: ["groups.read"], riskLevel: "medium" },
  { method: "GET", path: "/events/properties/:propertyId/calendar", permissions: ["events.read"], riskLevel: "low" },
  // Workforce (labor costs are payroll data: dedicated key).
  { method: "GET", path: "/workforce/properties/:propertyId/schedule", permissions: ["workforce.read"], riskLevel: "medium" },
  { method: "GET", path: "/workforce/properties/:propertyId/time-clock", permissions: ["workforce.read"], riskLevel: "medium" },
  // Procurement & inventory (advanced modules).
  { method: "GET", path: "/procurement/properties/:propertyId/purchase-orders", permissions: ["procurement.read"], riskLevel: "medium" },
  // Guest self-service, reputation, quality, surveys.
  { method: "GET", path: "/reputation/properties/:propertyId/reviews", permissions: ["reputation.read"], riskLevel: "medium" },
  { method: "GET", path: "/quality/properties/:propertyId/cases", permissions: ["quality_cases.read"], riskLevel: "medium" },
  { method: "GET", path: "/surveys/properties/:propertyId", permissions: ["surveys.read"], riskLevel: "low" },
  // Energy, sustainability, safety.
  { method: "GET", path: "/energy/properties/:propertyId/meters", permissions: ["energy.read"], riskLevel: "low" },
  { method: "GET", path: "/safety/properties/:propertyId/incidents", permissions: ["incidents.read"], riskLevel: "medium" },
  { method: "GET", path: "/safety/properties/:propertyId/checks", permissions: ["safety_checks.read"], riskLevel: "low" },
  // Analytics.
  { method: "GET", path: "/analytics/properties/:propertyId/metrics", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/analytics/properties/:propertyId/anomalies", permissions: ["analytics.read"], riskLevel: "medium" },
  { method: "GET", path: "/analytics/properties/:propertyId/reports", permissions: ["analytics.read"], riskLevel: "medium" },
  // Reservation sub-resources.
  { method: "GET", path: "/reservations/:id/audit-events", permissions: ["pms.reservation.read"], riskLevel: "medium" },
  { method: "GET", path: "/reservations/:id/documents", permissions: ["pms.reservation.read"], riskLevel: "low" },
  // F&B stock, menu engineering and POS.
  { method: "GET", path: "/properties/:propertyId/stock-locations", permissions: ["inventory.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/inventory-items", permissions: ["inventory.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/stock-balances", permissions: ["inventory.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/stock-balances/low-stock", permissions: ["inventory.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/menu-items", permissions: ["inventory.read"], riskLevel: "low" },
  { method: "GET", path: "/menu-items/:id", permissions: ["inventory.read"], riskLevel: "low" },
  // Accounting & fiscal reports (modelo-303/390 also enforce analytics.read in
  // their service; the entry makes the edge gate explicit and uniform).
  // Finanzas (2026-09-16, fix t6#9): the IVA models carry amounts →
  // accounting.reports.read; the fiscal-periods calendar keeps accounting.read.
  { method: "GET", path: "/accounting/journal-entries/recent", permissions: ["accounting.journal.post"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/fiscal-periods", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/reports/modelo-303", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/reports/modelo-390", permissions: ["accounting.reports.read"], riskLevel: "medium" },
  // SES submissions (Prisma pipeline, Tanda 3 · QC-01/FISC-08). Reads share the
  // guest-register read key: the history of what was sent to the MIR is the
  // same audience as the traveller records themselves (compliance role +
  // reception), while queueing/retrying keeps compliance.ses.submit. The
  // establishment view reports which fiscal-address fields are still missing
  // (the POST answers 409 SES_ESTABLISHMENT_INCOMPLETE with the same list).
  { method: "GET", path: "/properties/:propertyId/ses/submissions", permissions: ["guest_register.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/ses/establishment", permissions: ["guest_register.read"], riskLevel: "medium" }
];

export function findRoutePermission(method: string, path: string): ApiRoutePermission | undefined {
  return routePermissionManifest.find((route) => route.method === method.toUpperCase() && route.path === path);
}

export type RiskLevel = ApiRoutePermission["riskLevel"];

/**
 * H1 (Tanda 3 · cierre): risk level of a registered route, or `null` when the
 * route has no manifest entry (unknown paths, which the preHandler skips via
 * `request.is404` anyway). server.ts uses it to refuse the token-less demo
 * fallback (HOTELOS_ALLOW_DEMO_AUTH → `request.isAuthenticated === false`) on
 * `high` / `critical` routes with a 401: the fallback only stands in for reads
 * and low/medium writes; cancelling an invoice, refunding, sending to AEAT/MIR
 * or going live needs a real session even in demo mode.
 */
export function routeRiskLevel(method: string, path: string): RiskLevel | null {
  return findRoutePermission(method, path)?.riskLevel ?? null;
}

// AUTH-03: strict mode means a GET without a manifest entry is refused (403)
// instead of falling through as public. Resolution order:
//   1. RBAC_STRICT set (non-empty) → "true" enables, anything else disables.
//   2. Otherwise NODE_ENV=production → strict. Production is fail-closed by
//      default; RBAC_STRICT=false is an explicit, auditable opt-out.
//   3. Otherwise (dev/test/demo) → fail-open, with a deduplicated warning.
// The value is resolved once, lazily on the first check, and memoized — not
// re-read per request. Lazy rather than at module load because server.ts
// loads .env at import time and ESM import hoisting evaluates this module
// before that loader runs, so an eager read would miss a RBAC_STRICT from .env.
let rbacStrictMode: boolean | null = null;

function resolveRbacStrictMode(): boolean {
  const explicit = process.env.RBAC_STRICT?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit === "true";
  }
  return process.env.NODE_ENV === "production";
}

export function isRbacStrictMode(): boolean {
  if (rbacStrictMode === null) {
    rbacStrictMode = resolveRbacStrictMode();
  }
  return rbacStrictMode;
}

/**
 * Test-only: forget the memoized mode so the next check re-reads the env.
 * Lets integration tests flip RBAC_STRICT / NODE_ENV with `withEnv` on a
 * server that is already booted.
 */
export function resetRbacStrictModeForTests(): void {
  rbacStrictMode = null;
}

function unmappedRouteError(method: string, path: string): ForbiddenError {
  return new ForbiddenError(
    `Acción no permitida: la ruta ${method} ${path} no está registrada en el manifiesto de permisos.`
  );
}

export function assertRoutePermission(input: { method: string; path: string; userPermissions: PermissionKey[] }): void {
  const method = input.method.toUpperCase();
  const route = findRoutePermission(method, input.path);
  if (!route) {
    if (method === "GET") {
      if (isRbacStrictMode()) {
        throw unmappedRouteError(method, input.path);
      }
      // Fail-open only outside strict mode (dev/test/demo). Every gap is logged
      // once so it can be mapped; CI (contract test) rejects unmapped routes.
      if (!loggedUnmappedGets.has(input.path)) {
        loggedUnmappedGets.add(input.path);
        console.warn(
          `[rbac] unmapped GET ${input.path} — add it to routePermissionManifest ` +
            `(fail-open in this environment; NODE_ENV=production or RBAC_STRICT=true enforce 403)`
        );
      }
      return;
    }
    throw unmappedRouteError(method, input.path);
  }

  assertPermissions(input.userPermissions, route.permissions);
}
