// Cocoa 22 · contract test (docs/design/COCOA-22.md §9).
//
// Style: like tests/admin-web-no-raw-fetch.test.mjs — node:test, file reads,
// no build. Scope: apps/admin-web/src/screens/**/*.tsx (tests excluded) and
// components/cocoa/** for the token rule.
//
// The screens that are NOT migrated yet live in NOT_MIGRATED (explicit,
// relative to screens/). Every other screen file is «migrated» and must obey
// the fifteen rules below; the list can only SHRINK — an entry that no longer
// exists fails the test, and ALLOWLIST_CEILING must go down with each wave,
// never up (rules 13 and 15 also freeze the global debt through the
// inventory of scripts/cocoa-22-inventory.mjs).
//
// Rule 6 reads style objects with a small bracket-aware scanner (no parser):
// `style={{ … }}` literals may only carry layout props, and a named object
// (`style={name}` / `style={name(…)}`, resolved to its `const` initialiser or
// to the objects its function / arrow / useMemo factory returns) may carry
// colours, fonts, borders… only when the value comes from the design system
// (`var(--cocoa-*)`, a tone helper, a neutral keyword). Mutations proven to
// fail: `style={{ color: "red" }}` (leading space), `const x = { fontWeight:
// 700, textDecoration: "underline" }` + `style={x}`, `zIndex: "9999"`,
// `position: ("fixed" as const)`, `const X = "#fff"`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const adminSrc = join(repoRoot, "apps", "admin-web", "src");
const screensDir = join(adminSrc, "screens");
const stylesDir = join(adminSrc, "styles");
const inventoryScript = join(repoRoot, "scripts", "cocoa-22-inventory.mjs");
const inventoryJson = join(repoRoot, "docs", "design", "cocoa-22-inventory.json");

const toPosix = (p) => p.split(sep).join("/");

// ----------------------------------------------------------------- allowlist

/**
 * Screens NOT migrated to Cocoa 22 (relative to apps/admin-web/src/screens).
 * Migrating one = deleting its line here (and lowering ALLOWLIST_CEILING).
 * Pilot lot (2026-09-15): GeneralManagerScreen (canon), GuestsListScreen,
 * PropertySetupForms, ShiftManagerScreen and LoginScreen (shell lot) are out.
 */
export const ALLOWLIST_CEILING = 68;

export const NOT_MIGRATED = [
  "AccountingSettings.tsx",
  "AuditLogViewer.tsx",
  "BillingSettings.tsx",
  "GoLiveChecklist.tsx",
  "ModuleHealthCenter.tsx",
  "ModuleManager.tsx",
  "ModuleSettingsPlaceholder.tsx",
  "PaymentSettings.tsx",
  "PropertyMapper.tsx",
  "ScreenScaffold.tsx",
  "TaxComplianceSettings.tsx",
  "UserRoleManager.tsx",
  "admin/InviteUserDialog.tsx",
  "admin/NewTenantWizardDialog.tsx",
  "admin/ResetPasswordConfirmDialog.tsx",
  "admin/TenantAdminConsoleScreen.tsx",
  "admin/TenantDetailScreen.tsx",
  "admin/TouristTaxScreen.tsx",
  "aiOperations/AiGovernanceScreen.tsx",
  "aiOperations/AiPipelineStatusScreen.tsx",
  "aiOperations/AiToolRegistryScreen.tsx",
  "aiOperations/EmailConnectorsScreen.tsx",
  "aiOperations/PropertyAiScreen.tsx",
  "backoffice/SetupCenterScreen.tsx",
  "backoffice/categories/CategoryDetailScreen.tsx",
  "backoffice/categories/CategoryManagerScreen.tsx",
  "backoffice/categories/CategoryOptionForm.tsx",
  "compliance/AuthorityRoutingSettingsScreen.tsx",
  "compliance/ComplianceCenterScreen.tsx",
  "compliance/GdprRequestsScreen.tsx",
  "compliance/GuestRegisterRetentionSettingsScreen.tsx",
  "compliance/GuestRegisterSettingsScreen.tsx",
  "compliance/PropertyTaxesScreen.tsx",
  "compliance/SesHospedajesSettingsScreen.tsx",
  "dev/StyleGuideScreen.tsx",
  "developer/ApiReferenceScreen.tsx",
  "developer/CocoaShowcaseScreen.tsx",
  "developer/DeveloperAppsScreen.tsx",
  "developer/WebhooksAdminScreen.tsx",
  "esrs/EsrsReportScreen.tsx",
  "fiscal/ComplianceInbox.tsx",
  "fiscal/FiscalDashboard.tsx",
  "fiscal/FiscalSubmissionsCenter.tsx",
  "fiscal/TbaiForalScreen.tsx",
  "marketplace/MarketplaceCatalogScreen.tsx",
  "notifications/NotificationsScreen.tsx",
  "onboarding/CocoaOnboardingWizard.tsx",
  "onboarding/OnboardingInteractive.tsx",
  "onboarding/OnboardingScreens.tsx",
  "operations/SustainabilityDashboard.tsx",
  "preview/CocoaGalleryScreen.tsx",
  "tabs/NavItemTabs.tsx",
  "tabs/TabHost.tsx",
  "tabs/configuracion/ComunicacionesTabs.tsx",
  "tabs/configuracion/ContabilidadFiscalTabs.tsx",
  "tabs/configuracion/FacturacionPagosTabs.tsx",
  "tabs/configuracion/HabitacionesTabs.tsx",
  "tabs/configuracion/InteligenciaArtificialTabs.tsx",
  "tabs/configuracion/ModulosTabs.tsx",
  "tabs/configuracion/PropiedadTabs.tsx",
  "tabs/configuracion/PuestaEnMarchaTabs.tsx",
  "tabs/configuracion/SistemaTabs.tsx",
  "tabs/configuracion/tab-helpers.tsx",
  "tabs/cumplimiento/ImpuestosTabs.tsx",
  "tabs/cumplimiento/RegistroViajerosTabs.tsx",
  "tabs/cumplimiento/SostenibilidadTabs.tsx",
  "tabs/cumplimiento/VerifactuTabs.tsx",
  "tabs/tab-helpers.tsx"
];

/**
 * Rule 6 budgets of `style={` per migrated screen by archetype (§9):
 * 25 dashboard · 15 list/detail/form · 40 calendar/workspace. A migrated
 * screen without an entry gets the dashboard budget.
 */
const STYLE_BUDGET = {
  "operations/QuickCheckInDrawer.tsx": 15,
  "operations/QuickCheckOutDrawer.tsx": 15,
  "operations/FrontDeskActionQueue.tsx": 15,
  "operations/GeneralManagerScreen.tsx": 25,
  "operations/ShiftManagerScreen.tsx": 25,
  "guests/GuestsListScreen.tsx": 15,
  "propertySetup/PropertySetupForms.tsx": 15,
  "auth/LoginScreen.tsx": 15,
  // Cocoa 22 · ola 4 · lote 4-B (workspace)
  "operations/PosDashboard.tsx": 40,
  // Tanda 6 · lote 6-E (workspace: cierre de caja)
  "pos/CashClosureScreen.tsx": 40,
  // Cocoa 22 · ola 4 · lote 4-C (workspace)
  "operations/WorkforceDashboard.tsx": 40,
  "operations/SafetyDashboard.tsx": 40,
  // Cocoa 22 · ola 4 · lote 4-A (workspace)
  "operations/MaintenanceDashboard.tsx": 40,
  // Cocoa 22 · Tanda 6 · lote 6-E (Proveedores, gastos e inmovilizado · lista)
  "payables/SupplierBillsScreen.tsx": 15,
  "payables/ExpensesScreen.tsx": 15,
  "payables/SuppliersScreen.tsx": 15,
  "payables/FixedAssetsScreen.tsx": 15,
  // Cocoa 22 · Tanda 6 · lote 6-F (USALI y cuentas anuales · dashboard; nacen sin estilos en línea)
  "finance/AnnualAccountsScreen.tsx": 25,
  "finance/UsaliScreen.tsx": 25,
  // Cocoa 22 · Tanda 6 · lote 6-C (Contabilidad y estados contables: listas y formularios; PyG, Sumas y saldos y Cierre de ejercicio son dashboard, 25 por defecto)
  "accounting/JournalScreen.tsx": 15,
  "accounting/LedgerScreen.tsx": 15,
  "accounting/ChartOfAccountsScreen.tsx": 15,
  "accounting/AccountingSettingsScreen.tsx": 15,
  "accounting/GestoriaExportScreen.tsx": 15,
  "finance/BalanceSheetScreen.tsx": 15,
  "finance/ExchangeRatesScreen.tsx": 15,
  // Cocoa 22 · ola 8 · lote 8-B (Modelos AEAT: lista y formulario; los seis Modelo*Screen y FiscalModelReport son dashboard, 25 por defecto)
  "fiscal/ReportErrorCard.tsx": 15,
  "fiscal/VatBooksScreen.tsx": 15,
  "fiscal/VatSettlementScreen.tsx": 15,
  // Cocoa 22 · ola 6 · lote 6-A (Facturación y cobros: formulario · detalle · diálogo)
  "admin/FolioRoutingScreen.tsx": 15,
  "billing/FolioDetailScreen.tsx": 15,
  "invoicing/InvoiceRectifyDialog.tsx": 15,
  // Cocoa 22 · ola 5 · lote 5-C (Ajustes de revenue: Políticas de cancelación es formulario; Planes de tarifas, Competencia y Reglas son dashboard, 25 por defecto)
  "admin/CancellationPoliciesScreen.tsx": 15,
  // Cocoa 22 · ola 5 · lote 5-A (Parrilla y demanda: calendario 40; RateJournalScreen es «otro», 25 por defecto)
  "DemandCalendarAdminScreen.tsx": 40,
  "revenue/RateGridEditorScreen.tsx": 40,
  // Cocoa 22 · ola 7 · lote 7-C (Ventas adicionales y portal: catálogo = lista + drawer, portal = formulario; los dos dashboards quedan en 25 por defecto)
  "upsells/UpsellsSettingsScreen.tsx": 15,
  "guest-portal/GuestPortalSettingsScreen.tsx": 15,
  // Cocoa 22 · ola 5 · lote 5-B (Histórico y previsión: el informe diario es lista; cuadro, explorador, reunión, comparativa y panel son dashboard, 25 por defecto)
  "revenue/RevenueHistoryForecastReport.tsx": 15,
  // Cocoa 22 · ola 3 · lote 3-A (Reservas: cronograma calendario 40 · workspace de detalle 40 · agente de dictado formulario 15; tablero, lista y alta son 25 por defecto)
  "timeline/LiveTimelineWorkspace.tsx": 40,
  // Cocoa 22 · ola 3 · lote 3-C (Huéspedes, cupos y conserjería: recorrido, cronología y mensajes son workspace/calendario 40; Cupos y Ficha del huésped son dashboard, 25 por defecto)
  "guestJourney/GuestJourneyWorkspace.tsx": 40,
  "guests/GuestTimelineScreen.tsx": 40,
  "operations/ConciergeInboxDashboard.tsx": 40,
  // Cocoa 22 · ola 7 · lote 7-A (Canales: Correspondencias es lista; el hub de canales es dashboard, 25 por defecto)
  "ChannelMappingsScreen.tsx": 15,
  "reservations/ReservationWorkspaceScreen.tsx": 40,
  "reservations/ReservationAgentScreen.tsx": 15,
  // Cocoa 22 · ola 3 · lote 3-B (Grupos y eventos: diálogos y drawers 15 · calendario 40; GroupsPickupCard y GroupsEventsDashboard son dashboard, 25 por defecto)
  "operations/GroupDetailDialog.tsx": 15,
  "operations/NewGroupDialog.tsx": 15,
  "operations/RoomingListImportDialog.tsx": 15,
  "operations/RoomBlockGridDialog.tsx": 15,
  "operations/NewEventDialog.tsx": 15,
  "operations/GroupsCalendarScreen.tsx": 40,
  // Tanda 6b · L6 (Configuración › Estructura societaria: workspace split 40 for the five hosted tabs; drawers 15)
  "structure/StructureScreen.tsx": 40,
  "structure/PropertiesTable.tsx": 40,
  "structure/SeriesAndInstallationsTab.tsx": 40,
  "structure/VatAndFiscalYearTab.tsx": 40,
  "structure/AllocationTab.tsx": 40,
  "structure/PropertyDrawer.tsx": 15,
  "structure/AddPropertyDrawer.tsx": 15
};
const DEFAULT_STYLE_BUDGET = 25;

/** Rule 13 ceilings (§9) — lowered by every wave to the regenerated inventory (olas 1 · 2 · 4 · 9 integradas el 2026-09-15: 941/647/159/553/539/4607 → 762/488/121/491/419/3795; cierre de tanda A con las correcciones fix:*: inlineStyles 3795 → 3788; Tanda 6 Finanzas integrada el 2026-09-16, lotes 6-A/6-B/6-C/6-D/6-F/8-B/4-B: 762/488/121/491/419/3788 → 589/419/91/409/402/3223; olas 3 · 5 · 7 integradas el 2026-09-16, lotes 3-A/3-B/3-C/5-A/5-B/5-C/7-A/7-B/7-C: 589/419/91/409/402/3223 → 307/203/40/158/70/1833; cierre de la Tanda B con las correcciones fix:* del 2026-09-16: sin cambio, los seis techos igualan los totales regenerados; Tanda 6b · L6/L7 (Estructura societaria y ámbito único) integradas el 2026-09-16: inlineStyles 1833 → 1832, el resto sin cambio). */
const GLOBAL_CEILING = { boCard: 307, rawButtons: 203, rawTables: 40, rawInputs: 158, colourLiterals: 70, inlineStyles: 1832 };

// ----------------------------------------------------------------- helpers

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const count = (src, re) => (src.match(re) ?? []).length;

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function matchesWithLines(src, re) {
  const out = [];
  for (const m of src.matchAll(re)) out.push(`${lineOf(src, m.index)}: ${m[0].trim()}`);
  return out;
}

// Colour literals: hex / rgb() / hsl(); a hex only counts in a colour-ish
// context on its line (URL hashes and ids are not colours): a colour word, or
// the hex quoted on its own (`"#fff"`, `'#0d8a5f'`). A superset of the
// heuristic of scripts/cocoa-22-inventory.mjs (which needs a colour word, so
// a bare `const X = "#fff"` escapes the global count but not this rule).
const COLOUR_CONTEXT = /color|background|border|fill|stroke|shadow|gradient|accent|tone|palette|hex|["'`]#[0-9a-fA-F]{3,8}["'`]/i;

function colourLiteralLines(src) {
  const hits = [];
  const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
  const fn = /\b(?:rgba?|hsla?)\(/g;
  for (const re of [hex, fn]) {
    for (const m of src.matchAll(re)) {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const lineEnd = src.indexOf("\n", m.index);
      const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (re === hex && !COLOUR_CONTEXT.test(line)) continue;
      hits.push(`${lineOf(src, m.index)}: ${line.trim()}`);
    }
  }
  return hits;
}

// ----------------------------------------------------------------- rule 6 · style objects

// Props allowed inside a `style={{ … }}` literal, whatever the value (layout only, §9).
const LAYOUT_PROP = /^(display|grid[A-Z]\w*|flex[A-Z]?\w*|gap|rowGap|columnGap|align[A-Z]\w*|justify[A-Z]\w*|min[A-Z]\w*|max[A-Z]\w*|width|height|margin[A-Z]?\w*|padding[A-Z]?\w*|overflow[A-Z]?\w*|position|inset[A-Z]?\w*|top|right|bottom|left|order|place[A-Z]\w*|boxSizing|visibility|pointerEvents)$/;

// Text-flow props a NAMED style object may also carry with any value (they
// shape how a text flows, not its identity): truncation, wrapping, alignment,
// tabular figures, cursor. `textDecoration`, `textTransform`, `opacity`… are
// identity and stay under the value check below.
const TEXT_FLOW_PROP = /^(whiteSpace|textOverflow|textAlign|verticalAlign|wordBreak|overflowWrap|hyphens|fontVariantNumeric|fontFeatureSettings|cursor|userSelect|listStyle[A-Z]?\w*)$/;

// Every other prop of a named style object (colour, font, line-height,
// border, radius, shadow, opacity, decoration, transition…) takes its value
// from the design system: a `--cocoa-*` token, a tone helper of
// cocoa-tones.ts, or a neutral keyword. A number or a bare word is local
// identity and fails.
const SYSTEM_VALUE = /var\(\s*--cocoa-|\btone(?:Ink|Color|Bg|Border)\(/;
const NEUTRAL_VALUE = /^(?:["'`](?:inherit|currentColor|transparent|none|unset|initial)["'`]|0)$/;

/** Index of the quote closing the string that opens at `open` (template holes balanced); −1 when unterminated. */
function skipString(src, open) {
  const quote = src[open];
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
    if (quote === "`" && ch === "$" && src[i + 1] === "{") {
      const end = closeOf(src, i + 1);
      if (end === -1) return -1;
      i = end - 1;
      continue;
    }
    if (quote !== "`" && ch === "\n") return i; // unterminated single-line string: stop at the line end
  }
  return -1;
}

/** Index just past the bracket closing the one that opens at `open` (strings and comments skipped); −1 when unbalanced. */
function closeOf(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      if (i === -1) return -1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) return -1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** End of the initialiser starting at `from`: a `;` at depth 0, or a line break followed by a line not indented deeper than the declaration. */
function initialiserEnd(src, from, indent) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(src, i);
      if (end === -1) return src.length;
      i = end;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      if (end === -1) return src.length;
      i = end - 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return src.length;
      i = end + 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && ch === ";") return i;
    else if (depth === 0 && ch === "\n") {
      const following = /^(?:[ \t]*\n)*([ \t]*)\S/.exec(src.slice(i + 1));
      if (!following || following[1].length <= indent) return i;
    }
  }
  return src.length;
}

/** `key: value` entries of an object literal `{ … }` (spreads, computed keys and comments dropped; nested brackets and strings kept whole). */
function entriesOf(objectText) {
  const inner = objectText.slice(1, -1);
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(inner, i);
      if (end === -1) {
        current += inner.slice(i);
        break;
      }
      current += inner.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = inner.indexOf("\n", i);
      i = end === -1 ? inner.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = inner.indexOf("*/", i + 2);
      i = end === -1 ? inner.length : end + 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const entries = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text || text.startsWith("...")) continue;
    const m = /^(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*(?::\s*([\s\S]*))?$/.exec(text);
    if (!m) continue;
    entries.push({ key: m[1] ?? m[2], value: (m[3] ?? m[1] ?? "").trim() });
  }
  return entries;
}

/** Object literals `name` evaluates to when used as `style={name}` / `style={name(…)}`: its `const` initialiser, or the objects its function, arrow or useMemo factory returns. */
function styleObjectsOf(src, name) {
  const objects = [];
  const push = (open) => {
    const end = closeOf(src, open);
    if (end !== -1) objects.push({ index: open, text: src.slice(open, end) });
  };
  const escaped = name.replace(/\$/g, "\\$");
  for (const m of src.matchAll(new RegExp(`(?:^|\\n)([ \\t]*)(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b[^=\\n]*=\\s*`, "g"))) {
    const start = m.index + m[0].length;
    if (src[start] === "{") {
      push(start);
      continue;
    }
    const window = src.slice(start, initialiserEnd(src, start, m[1].length));
    for (const r of window.matchAll(/=>\s*\(\s*\{|\breturn\s*\(?\s*\{/g)) push(start + r.index + r[0].length - 1);
  }
  for (const m of src.matchAll(new RegExp(`(?:^|\\n)([ \\t]*)(?:export\\s+)?function\\s+${escaped}\\s*\\(`, "g"))) {
    const paramsEnd = closeOf(src, m.index + m[0].length - 1);
    if (paramsEnd === -1) continue;
    const bodyOpen = src.indexOf("{", paramsEnd);
    const bodyEnd = bodyOpen === -1 ? -1 : closeOf(src, bodyOpen);
    if (bodyEnd === -1) continue;
    for (const r of src.slice(bodyOpen, bodyEnd).matchAll(/\breturn\s*\(?\s*\{/g)) push(bodyOpen + r.index + r[0].length - 1);
  }
  return objects;
}

/** `style={{ … }}` literals: every key must be a layout prop (§9), whatever its value. */
function styleLiteralViolations(src) {
  const out = [];
  for (const m of src.matchAll(/\bstyle=\{\{/g)) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(src, open);
    if (end === -1) continue;
    for (const { key } of entriesOf(src.slice(open, end))) {
      if (!LAYOUT_PROP.test(key)) out.push(`${lineOf(src, m.index)}: ${key}`);
    }
  }
  return out;
}

/** Named style objects: layout and text-flow props are free; every other prop must take a system value (identifiers that resolve to nothing — props, imports — are not inspected). */
function namedStyleViolations(src) {
  const out = [];
  const seen = new Set();
  for (const m of src.matchAll(/\bstyle=\{\s*([A-Za-z_$][\w$]*)\s*[(}]/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    for (const object of styleObjectsOf(src, name)) {
      for (const { key, value } of entriesOf(object.text)) {
        if (key.startsWith("--") || LAYOUT_PROP.test(key) || TEXT_FLOW_PROP.test(key)) continue;
        if (SYSTEM_VALUE.test(value) || NEUTRAL_VALUE.test(value)) continue;
        out.push(`${lineOf(src, object.index)}: ${name} → ${key}: ${value.length > 48 ? `${value.slice(0, 48)}…` : value}`);
      }
    }
  }
  return out;
}

function tokensUsed(src) {
  const used = new Map();
  // A real usage ends the name with `)` or `,`; `var(--cocoa-tone-${tone})`
  // (cocoa-tones.ts) resolves at runtime and `var(--cocoa-tone-*)` in a comment
  // is prose — neither is a token to check.
  for (const m of src.matchAll(/var\(\s*(--cocoa-[\w-]+)\s*([,)])/g)) {
    const name = m[1];
    const withFallback = m[2] === ",";
    const prev = used.get(name);
    used.set(name, { fallback: prev ? prev.fallback && withFallback : withFallback });
  }
  return used;
}

function definedTokens() {
  const defined = new Set();
  const files = readdirSync(stylesDir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => join(stylesDir, f));
  files.push(join(adminSrc, "styles.css"));
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/(--cocoa-[\w-]+)\s*:/g)) defined.add(m[1]);
  }
  return defined;
}

// Sub-views without a head of their own (plan §2.3): FrontDeskActionQueue is painted inside /hoy;
// fiscal/ReportErrorCard is the error card the AEAT report screens paint inside their body (lote 8-B);
// operations/GroupsPickupCard is the pickup card GroupsEventsDashboard paints on /recepcion/grupos (lote 3-B).
const HEADER_EXEMPT = /^(tabs\/|.*(Dialog|Drawer)\.tsx$|ScreenScaffold\.tsx$|ModuleSettingsPlaceholder\.tsx$|operations\/FrontDeskActionQueue\.tsx$|fiscal\/ReportErrorCard\.tsx$|operations\/GroupsPickupCard\.tsx$)/;
const COLOUR_EXEMPT = /^(auth|preview|developer)\//;

// ----------------------------------------------------------------- data

const allScreens = walk(screensDir).map((full) => toPosix(relative(screensDir, full))).sort();
const notMigrated = new Set(NOT_MIGRATED);
const migrated = allScreens.filter((rel) => !notMigrated.has(rel));
const sources = new Map(migrated.map((rel) => [rel, readFileSync(join(screensDir, rel), "utf8")]));

function offenders(check) {
  const out = [];
  for (const [rel, src] of sources) {
    const hits = check(rel, src);
    if (hits.length > 0) out.push(`${rel}\n    ${hits.join("\n    ")}`);
  }
  return out;
}

// ----------------------------------------------------------------- allowlist integrity

describe("cocoa-22 · allowlist of non-migrated screens", () => {
  it("only lists screens that still exist (delete a line when its screen migrates or disappears)", () => {
    const stale = NOT_MIGRATED.filter((rel) => !existsSync(join(screensDir, rel)));
    assert.deepEqual(stale, [], `Entradas obsoletas en NOT_MIGRATED:\n  ${stale.join("\n  ")}`);
  });

  it("has no duplicates and never grows past the ceiling", () => {
    assert.equal(new Set(NOT_MIGRATED).size, NOT_MIGRATED.length, "NOT_MIGRATED tiene duplicados");
    assert.ok(NOT_MIGRATED.length <= ALLOWLIST_CEILING, `NOT_MIGRATED tiene ${NOT_MIGRATED.length} pantallas; el techo es ${ALLOWLIST_CEILING} y solo puede bajar`);
  });

  it("recognises the pilot screens as migrated", () => {
    for (const rel of ["operations/GeneralManagerScreen.tsx", "guests/GuestsListScreen.tsx", "propertySetup/PropertySetupForms.tsx", "operations/ShiftManagerScreen.tsx"]) {
      assert.ok(sources.has(rel), `${rel} debe existir y estar fuera de NOT_MIGRATED`);
    }
  });
});

// ----------------------------------------------------------------- rules 1–11 (migrated screens)

describe("cocoa-22 · migrated screens obey §9", () => {
  it("1 · no .bo-* classes", () => {
    assert.deepEqual(offenders((_, src) => matchesWithLines(src, /(?<!-)\bbo-[a-z0-9-]+/g)), []);
  });

  it("2 · no raw <button>", () => {
    assert.deepEqual(offenders((_, src) => matchesWithLines(src, /<button\b/g)), []);
  });

  it("3 · no raw <table> (only a grid wrapped in CocoaScrollArea with data-cocoa-grid-table)", () => {
    assert.deepEqual(
      offenders((_, src) => (/data-cocoa-grid-table/.test(src) && /<CocoaScrollArea\b/.test(src) ? [] : matchesWithLines(src, /<table\b/g))),
      []
    );
  });

  it("4 · no raw <input>/<select>/<textarea> (hidden and file inputs excepted)", () => {
    assert.deepEqual(
      offenders((_, src) => matchesWithLines(src, /<(?:input|select|textarea)\b[^>]*>/g).filter((hit) => !/type="(?:file|hidden)"/.test(hit))),
      []
    );
  });

  it("5 · no colour literals (auth/, preview/, developer/ excepted)", () => {
    assert.deepEqual(offenders((rel, src) => (COLOUR_EXEMPT.test(rel) ? [] : colourLiteralLines(src))), []);
  });

  it("6 · inline styles within budget; layout-only in style={{…}} literals; named style objects take colours and fonts from the system", () => {
    assert.deepEqual(
      offenders((rel, src) => {
        const budget = STYLE_BUDGET[rel] ?? DEFAULT_STYLE_BUDGET;
        const n = count(src, /\bstyle=\{/g);
        const hits = n > budget ? [`style={ ×${n} > presupuesto ${budget}`] : [];
        return hits
          .concat(styleLiteralViolations(src).map((v) => `prop no de layout en style={{…}} → ${v}`))
          .concat(namedStyleViolations(src).map((v) => `valor fuera del sistema en objeto de estilo → ${v}`));
      }),
      []
    );
  });

  it("7 · paints a Cocoa header (CocoaPage / CocoaPageHeader / pageHead / HostedHead / useTabHost)", () => {
    assert.deepEqual(
      offenders((rel, src) => (HEADER_EXEMPT.test(rel) || /<CocoaPage\b|<CocoaPageHeader\b|pageHead\(|<HostedHead\b|useTabHost\(/.test(src) ? [] : ["sin cabecera Cocoa"])),
      []
    );
  });

  it("8 · no raw <h1>", () => {
    assert.deepEqual(offenders((_, src) => matchesWithLines(src, /<h1\b/g)), []);
  });

  it("9 · no position: fixed nor numeric zIndex (quoted or parenthesised forms included)", () => {
    // `position: ("fixed" as const)` and `zIndex: "9999"` are the same escape.
    assert.deepEqual(offenders((_, src) => matchesWithLines(src, /position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/g)), []);
  });

  it("10 · no emoji in JSX", () => {
    assert.deepEqual(offenders((_, src) => matchesWithLines(src, /\p{Extended_Pictographic}/gu)), []);
  });

  it("11 · no transition: all nor infinite animations", () => {
    assert.deepEqual(offenders((_, src) => matchesWithLines(src, /transition:\s*["']all|animation:[^\n,]*\binfinite\b/g)), []);
  });
});

// ----------------------------------------------------------------- rule 12 (tokens)

describe("cocoa-22 · tokens", () => {
  it("12 · every --cocoa-* token used by migrated screens and by components/cocoa exists in the stylesheets", () => {
    const defined = definedTokens();
    assert.ok(defined.size > 100, `se esperaban >100 tokens --cocoa-*, hay ${defined.size}`);
    const files = [...sources.entries()].map(([rel, src]) => [`screens/${rel}`, src]);
    for (const full of walk(join(adminSrc, "components", "cocoa"))) files.push([toPosix(relative(adminSrc, full)), readFileSync(full, "utf8")]);
    for (const full of walk(join(adminSrc, "components", "cocoa-extras"))) files.push([toPosix(relative(adminSrc, full)), readFileSync(full, "utf8")]);
    const missing = [];
    for (const [rel, src] of files) {
      for (const [token, info] of tokensUsed(src)) {
        // A fallback keeps the paint alive, but the token should still exist (§7: fallbacks retire).
        if (!defined.has(token) && !info.fallback) missing.push(`${rel} → ${token}`);
      }
    }
    assert.deepEqual(missing, [], `Tokens sin definir en styles/*.css:\n  ${missing.join("\n  ")}`);
  });
});

// ----------------------------------------------------------------- rules 13 + 15 (inventory)

describe("cocoa-22 · inventory budget", () => {
  const current = JSON.parse(execFileSync(process.execPath, [inventoryScript, "--stdout"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const committed = JSON.parse(readFileSync(inventoryJson, "utf8"));

  it("13 · global debt never grows (ceilings of §9 and the committed inventory)", () => {
    const over = [];
    for (const [key, ceiling] of Object.entries(GLOBAL_CEILING)) {
      if (current.totals[key] > ceiling) over.push(`${key}: ${current.totals[key]} > ${ceiling} (techo §9)`);
      if (current.totals[key] > committed.totals[key]) over.push(`${key}: ${current.totals[key]} > ${committed.totals[key]} (inventario commiteado)`);
    }
    assert.deepEqual(over, [], `La deuda Cocoa 22 ha crecido:\n  ${over.join("\n  ")}`);
  });

  it("15 · docs/design/cocoa-22-inventory.json is up to date (node scripts/cocoa-22-inventory.mjs)", () => {
    assert.deepEqual(current.totals, committed.totals, "Regenera el inventario: node scripts/cocoa-22-inventory.mjs");
  });
});

// ----------------------------------------------------------------- rule 14 (accent)

describe("cocoa-22 · accent", () => {
  it("14 · nothing writes --cocoa-accent inline (single Esmeralda accent)", () => {
    const dirs = [join(adminSrc, "providers"), join(adminSrc, "components", "cocoa-global"), join(adminSrc, "screens", "onboarding")];
    const hits = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const full of readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => join(dir, f))) {
        const src = readFileSync(full, "utf8");
        for (const hit of matchesWithLines(src, /setProperty\(\s*["']--cocoa-accent/g)) hits.push(`${toPosix(relative(adminSrc, full))} ${hit}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
