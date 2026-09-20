// Finanzas · ámbito único (Tanda 6b · L7, design §5.3): ONE «Ámbito» selector
// for every money screen — Sociedad (the whole legal entity) · Centro (a hotel
// or the oficina central) — kept APART from the operational property switcher
// (services/activeProperty.ts): changing the active hotel never changes the
// finance scope, and vice versa.
//
//   · Truth of the structure: GET /organizations/me/structure (`mode`,
//     `scope`, the sociedad and its centres); when the route is off
//     (STRUCTURE_ENABLED=false → 404) the centres come from
//     GET /users/me/properties (`kind`, `code`, `legalEntityName`).
//   · Matrix forced / default / filter (design §5.3, FINANCE_SCOPE_POLICIES):
//       entity_forced   — Plan, Ajustes, Cierre, Exportar a gestoría, Balance,
//                         Flujos, Cuentas anuales, Modelos AEAT, Libros IVA,
//                         Liquidación: always the sociedad (declarante = NIF).
//       entity_default  — Diario, Mayor, Sumas y saldos, PyG, USALI,
//                         Tesorería, Nóminas: the sociedad by default, a centre
//                         as filter (`propertyId`).
//       centre_default  — Facturación, TPV / cierre de caja, Proveedores,
//                         Gastos, Inmovilizado, Conciliación, Comisiones: the
//                         document hangs from a centre (the API routes are
//                         /properties/:propertyId/…); default = the active
//                         hotel; the oficina central is offered where finance
//                         rows may live there (never for billing / POS).
//   · Persistence: localStorage["hotelos-finance-scope"] (design §5.3) as
//     `{ organizationId, kind, id, label }` — reset when the organization
//     changes or the session changes; mirrored in `?ambito=` (`sociedad` or a
//     property id), which wins over storage when present.
//   · Derivation for the readers: `propertyId` (a centre) or nothing (the
//     sociedad); the treasury routes take `scope=entity` instead.
//   · A user without `accounting.entity.read` (structure `scope:
//     "assigned_properties"`) never sees the «Sociedad» option; a single-hotel
//     tenant (`mode: single_hotel`) sees no selector at all.
//
// No static import of api-client / activeProperty (import.meta.env): the pure
// part runs under `node --test` (services/__tests__/finance-scope.test.mts);
// the loader imports them lazily.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FinanceScope, LegalEntityDto, PgcVariant, PropertyKind, StructureMode } from "@hotelos/shared";
import type { CocoaSelectOption } from "../components/cocoa/CocoaSelect";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FINANCE_SCOPE_STORAGE_KEY = "hotelos-finance-scope";
export const FINANCE_SCOPE_QUERY_PARAM = "ambito";
/** Option value (and `?ambito=` value) of the whole sociedad. */
export const FINANCE_SCOPE_ENTITY_VALUE = "sociedad";
export const FINANCE_SCOPE_EVENT = "hotelos-finance-scope-changed";

// Mirrors of PROPERTY_KEY / ORG_KEY / NAME_KEY of services/activeProperty.ts
// (pinned by finance-scope.test.mts): read here so this module stays loadable
// without api-client.
const ACTIVE_PROPERTY_KEY = "hotelos-active-property";
const ACTIVE_ORG_KEY = "hotelos-active-org";
const ACTIVE_PROPERTY_NAME_KEY = "hotelos-active-property-name";

/** Fixed vocabulary (design §5.3): Sociedad · Centro de trabajo (Hotel / Oficina / Otro). */
export const PROPERTY_KIND_LABELS: Readonly<Record<PropertyKind, string>> = Object.freeze({ hotel: "Hotel", office: "Oficina", other: "Otro" });

/** Column and block labels of the «Por centro» views (design §5.2 R4/R5). */
export const CORPORATE_COLUMN_LABEL = "Oficina central";
export const UNASSIGNED_COLUMN_LABEL = "Sin asignar";
export const SOCIETY_NO_CENTRE_LABEL = "Sociedad (sin centro)";
export const ENTITY_TOTAL_LABEL = "Total sociedad";
/** Footer of every per-centre statement (R4). */
export const ENTITY_TOTAL_FOOTNOTE = "Total sociedad = suma de centros + asientos de sociedad (sin centro).";
/** Label of the informative allocation row (contract constant of CorporateAllocationResult.label). */
export const ALLOCATION_ROW_LABEL = "Reparto corporativo (informativo · no contabilizado)";

export type FinanceScopePolicy = "entity_forced" | "entity_default" | "centre_default";

/** Screen key → policy (design §5.3 table). Screens not listed are `entity_default`. */
export const FINANCE_SCOPE_POLICIES: Readonly<Record<string, FinanceScopePolicy>> = Object.freeze({
  // Contabilidad
  JournalScreen: "entity_default",
  LedgerScreen: "entity_default",
  ChartOfAccountsScreen: "entity_forced",
  AccountingSettingsScreen: "entity_forced",
  YearEndCloseScreen: "entity_forced",
  GestoriaExportScreen: "entity_forced",
  // Tanda 7c: the Sage 200 import is a lot of the sociedad, but the reconciliation and the per-centre view read the centre of the ONE selector (`finance.propertyId`, undefined = consolidado).
  Sage200ImportScreen: "entity_default",
  // Estados contables
  TrialBalanceScreen: "entity_default",
  BalanceSheetScreen: "entity_forced",
  ProfitAndLossScreen: "entity_default",
  CashFlowScreen: "entity_forced",
  AnnualAccountsScreen: "entity_forced",
  UsaliScreen: "entity_default",
  // Tesorería y banca
  FinancePositionDashboard: "entity_default",
  BankReconciliationScreen: "centre_default",
  BankingSpainScreen: "centre_default",
  // Proveedores, gastos, inmovilizado, nóminas, comisiones
  SupplierBillsScreen: "centre_default",
  ExpensesScreen: "centre_default",
  FixedAssetsScreen: "centre_default",
  SuppliersScreen: "entity_forced",
  PayrollScreen: "entity_default",
  // Tanda RRHH (RRHH-11): the three tabs of RRHH y nóminas read the sociedad by default (the employer) and a centre on demand;
  // Previsión and Panel exclude the oficina central themselves (`excludeOffice`) because the forecast is per hotel.
  HrEmployeesScreen: "entity_default",
  HrForecastScreen: "entity_default",
  HrOverviewScreen: "entity_default",
  // Tanda RRHH (PANEL-B): Hoy › Mi día › Costes de personal reads the sociedad by default (ranking of centres, oficina central
  // included: its personnel is A&G) and one centre on demand (GET /payroll/labor-cost-panel with propertyId).
  DirectorLaborCostsScreen: "entity_default",
  CommissionsScreen: "centre_default",
  // Facturación y TPV (emitir es operativo: siempre un centro hotel / otro)
  BillingCenterScreen: "centre_default",
  CashClosureScreen: "centre_default",
  // Cumplimiento (declarante = NIF)
  Modelo303Screen: "entity_forced",
  Modelo390Screen: "entity_forced",
  Modelo347Screen: "entity_forced",
  Modelo111Screen: "entity_forced",
  Modelo115Screen: "entity_forced",
  Modelo180Screen: "entity_forced",
  FiscalModelReport: "entity_forced",
  VatBooksScreen: "entity_forced",
  VatSettlementScreen: "entity_forced"
});

/** Screens whose centre options never include the oficina central (emission / POS / bank accounts hang from a hotel). */
export const OPERATIONAL_CENTRE_SCREENS: ReadonlySet<string> = new Set(["BillingCenterScreen", "CashClosureScreen", "BankReconciliationScreen", "BankingSpainScreen", "CommissionsScreen"]);

export function financeScopePolicy(screenKey: string): FinanceScopePolicy {
  return FINANCE_SCOPE_POLICIES[screenKey] ?? "entity_default";
}

// ---------------------------------------------------------------------------
// Structure (what the selector offers)
// ---------------------------------------------------------------------------

export type FinanceCentre = {
  id: string;
  code: string | null;
  name: string;
  kind: PropertyKind;
  legalEntityId: string | null;
};

export type FinanceEntitySummary = {
  id: string | null;
  code: string | null;
  legalName: string;
  /** Null while pending — or redacted for a centre-scoped reader. */
  taxId: string | null;
  taxIdValid: boolean;
  siiEnabled: boolean;
  largeCompany: boolean;
  pgcVariant: PgcVariant | null;
};

export type FinanceStructure = {
  organizationId: string;
  organizationName: string;
  mode: StructureMode;
  entity: FinanceEntitySummary | null;
  /** Hotels first, then offices and other centres (as the API lists them). */
  centres: FinanceCentre[];
  /** False when the caller only holds centre roles (no `accounting.entity.read`): «Sociedad» is not offered. */
  entityReadable: boolean;
  source: "structure" | "properties";
};

/** Row of GET /organizations/me/structure (subset the front needs; see apps/api/src/modules/structure/legal-entity.service.ts OrganizationStructure). */
export type StructureResponse = {
  organization: { id: string; name: string; country?: string };
  legalEntity:
    | (Partial<LegalEntityDto> & {
        id: string;
        legalName: string;
        properties: Array<{ id: string; code: string | null; name: string; tradeName?: string | null; kind: PropertyKind; legalEntityId?: string | null }>;
      })
    | null;
  mode: StructureMode;
  scope: "entity" | "assigned_properties";
};

/** Row of GET /users/me/properties with the Tanda 6b additive columns (kind · code · legalEntityId · legalEntityName). */
export type StructuredPropertyRow = {
  id: string;
  name: string;
  organizationId: string;
  organizationName?: string;
  municipality?: string | null;
  province?: string | null;
  status?: string | null;
  kind?: PropertyKind;
  code?: string | null;
  legalEntityId?: string | null;
  legalEntityName?: string | null;
};

/** Pure: the finance structure from the structure route. */
export function structureFromResponse(response: StructureResponse): FinanceStructure {
  const entity = response.legalEntity;
  return {
    organizationId: response.organization.id,
    organizationName: response.organization.name,
    mode: response.mode,
    entity: entity
      ? {
          id: entity.id,
          code: entity.code ?? null,
          legalName: entity.legalName,
          taxId: entity.taxId ?? null,
          taxIdValid: entity.taxIdValid ?? false,
          siiEnabled: entity.siiEnabled ?? false,
          largeCompany: entity.largeCompany ?? false,
          pgcVariant: entity.pgcVariant ?? null
        }
      : null,
    centres: sortCentres((entity?.properties ?? []).map((row) => ({ id: row.id, code: row.code ?? null, name: row.name, kind: row.kind ?? "hotel", legalEntityId: row.legalEntityId ?? entity?.id ?? null }))),
    entityReadable: response.scope === "entity",
    source: "structure"
  };
}

/** Pure: the finance structure from the switcher rows when the structure route is not available (STRUCTURE_ENABLED=false). */
export function structureFromProperties(rows: readonly StructuredPropertyRow[], organizationId: string): FinanceStructure {
  const own = rows.filter((row) => row.organizationId === organizationId);
  const named = own.find((row) => row.legalEntityName);
  const centres = sortCentres(own.map((row) => ({ id: row.id, code: row.code ?? null, name: row.name, kind: row.kind ?? "hotel", legalEntityId: row.legalEntityId ?? null })));
  return {
    organizationId,
    organizationName: own.find((row) => row.organizationName)?.organizationName ?? "Organización",
    mode: centres.length > 1 ? "multi_center" : "single_hotel",
    entity: named ? { id: named.legalEntityId ?? null, code: null, legalName: named.legalEntityName as string, taxId: null, taxIdValid: false, siiEnabled: false, largeCompany: false, pgcVariant: null } : null,
    centres,
    // Without the structure route the grants are unknown: the option is offered and the API answers 404 ENTITY_SCOPE_REQUIRED if it must.
    entityReadable: true,
    source: "properties"
  };
}

/** Hotels first (by name), then the oficina central and other centres. */
export function sortCentres(centres: readonly FinanceCentre[]): FinanceCentre[] {
  const rank: Record<PropertyKind, number> = { hotel: 0, office: 1, other: 2 };
  return [...centres].sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name, "es"));
}

/** Razón social of the sociedad, or the honest fallback while it is pending. */
export function entityDisplayName(structure: FinanceStructure | null): string {
  if (!structure) return "Sociedad";
  return structure.entity?.legalName ?? structure.organizationName ?? "Sociedad";
}

/** «Hotel Faranda Rías Altas (RA)» · «Oficina central (OC)». */
export function centreDisplayName(centre: Pick<FinanceCentre, "name" | "code">): string {
  return centre.code ? `${centre.name} (${centre.code})` : centre.name;
}

/** Option label of a centre: «Centro · Hotel Faranda Rías Altas (RA)». */
export function centreOptionLabel(centre: Pick<FinanceCentre, "name" | "code">): string {
  return `Centro · ${centreDisplayName(centre)}`;
}

/** Option label of the sociedad: «Sociedad · CELUISMA S.A. (todo)». */
export function entityOptionLabel(structure: FinanceStructure | null): string {
  return `Sociedad · ${entityDisplayName(structure)} (todo)`;
}

// ---------------------------------------------------------------------------
// Scope resolution (pure)
// ---------------------------------------------------------------------------

export type ActiveCentre = { propertyId: string; propertyName: string };

export function entityScope(structure: FinanceStructure | null): FinanceScope {
  return { kind: "entity", id: structure?.entity?.id ?? structure?.organizationId ?? "", label: entityDisplayName(structure) };
}

export function centreScope(centre: Pick<FinanceCentre, "id" | "name" | "code">): FinanceScope {
  return { kind: "property", id: centre.id, label: centreDisplayName(centre) };
}

/** Centres a policy offers: every centre, or only the operational ones (hotel / other) for the emission-bound screens. */
export function eligibleCentres(structure: FinanceStructure | null, active: ActiveCentre, options: { excludeOffice?: boolean } = {}): FinanceCentre[] {
  const centres = structure?.centres.length ? structure.centres : [{ id: active.propertyId, code: null, name: active.propertyName, kind: "hotel" as PropertyKind, legalEntityId: null }];
  return options.excludeOffice ? centres.filter((centre) => centre.kind !== "office") : centres;
}

export type ResolveScopeInput = {
  policy: FinanceScopePolicy;
  stored: FinanceScope | null;
  structure: FinanceStructure | null;
  active: ActiveCentre;
  excludeOffice?: boolean;
};

/**
 * The effective scope of a screen (design §5.3 matrix):
 *   entity_forced  → the sociedad (a centre-scoped reader falls back to its active centre);
 *   entity_default → the stored choice when still valid, else the sociedad (or the active centre when not readable);
 *   centre_default → the stored centre when eligible, else the active property, else the first eligible centre.
 */
export function resolveFinanceScope(input: ResolveScopeInput): FinanceScope {
  const { policy, stored, structure, active } = input;
  const entityAllowed = structure ? structure.entityReadable : true;
  const centres = eligibleCentres(structure, active, { excludeOffice: input.excludeOffice });
  const byId = (id: string) => centres.find((centre) => centre.id === id) ?? null;
  const activeCentre = byId(active.propertyId) ?? centres[0] ?? { id: active.propertyId, code: null, name: active.propertyName, kind: "hotel" as PropertyKind, legalEntityId: null };

  if (policy === "entity_forced") return entityAllowed ? entityScope(structure) : centreScope(activeCentre);

  if (policy === "centre_default") {
    const storedCentre = stored?.kind === "property" ? byId(stored.id) : null;
    return centreScope(storedCentre ?? activeCentre);
  }

  if (stored?.kind === "property") {
    const storedCentre = byId(stored.id);
    if (storedCentre) return centreScope(storedCentre);
  }
  if (stored?.kind === "entity" && entityAllowed) return entityScope(structure);
  return entityAllowed ? entityScope(structure) : centreScope(activeCentre);
}

/** Options of the «Ámbito» select for a policy: «Sociedad · … (todo)» first (when readable and not centre-bound), then one per eligible centre. */
export function financeScopeOptions(input: Omit<ResolveScopeInput, "stored">): CocoaSelectOption[] {
  const { policy, structure, active } = input;
  const entityAllowed = structure ? structure.entityReadable : true;
  const centres = eligibleCentres(structure, active, { excludeOffice: input.excludeOffice });
  if (policy === "entity_forced") return entityAllowed ? [{ value: FINANCE_SCOPE_ENTITY_VALUE, label: entityOptionLabel(structure) }] : centres.filter((centre) => centre.id === active.propertyId).map((centre) => ({ value: centre.id, label: centreOptionLabel(centre) }));
  const options: CocoaSelectOption[] = [];
  if (policy === "entity_default" && entityAllowed) options.push({ value: FINANCE_SCOPE_ENTITY_VALUE, label: entityOptionLabel(structure) });
  for (const centre of centres) options.push({ value: centre.id, label: centreOptionLabel(centre) });
  return options;
}

/** Whether the selector renders: never for a single hotel; otherwise when there is a choice (or the forced cue in a multi-centre sociedad). */
export function financeScopeVisible(policy: FinanceScopePolicy, structure: FinanceStructure | null, options: readonly CocoaSelectOption[]): boolean {
  if (!structure || structure.mode === "single_hotel") return false;
  return options.length > 1 || policy === "entity_forced";
}

/** Option value of a scope (`sociedad` or the property id). */
export function financeScopeValue(scope: FinanceScope): string {
  return scope.kind === "entity" ? FINANCE_SCOPE_ENTITY_VALUE : scope.id;
}

/** The scope a select value or `?ambito=` names, or null when it names nothing the structure knows. */
export function scopeFromValue(value: string | null | undefined, structure: FinanceStructure | null, active: ActiveCentre): FinanceScope | null {
  if (!value) return null;
  if (value === FINANCE_SCOPE_ENTITY_VALUE) return entityScope(structure);
  const centre = eligibleCentres(structure, active).find((row) => row.id === value);
  return centre ? centreScope(centre) : null;
}

export type FinanceScopeQuery = { propertyId?: string; scope?: "entity" };

/**
 * Query of a finance reader for a scope: a centre → `propertyId`; the sociedad →
 * nothing (the ledger routes resolve the sociedad themselves) or `scope=entity`
 * for the treasury routes (`GET /treasury/*?scope=entity`).
 */
export function financeScopeQuery(scope: FinanceScope, options: { treasury?: boolean } = {}): FinanceScopeQuery {
  if (scope.kind === "property") return { propertyId: scope.id };
  return options.treasury ? { scope: "entity" } : {};
}

/** «Finanzas · CELUISMA S.A.» · «Cumplimiento · Hotel Faranda Rías Altas (RA)». */
export function financeEyebrow(section: string, scope: FinanceScope): string {
  return `${section} · ${scope.label}`;
}

/** Display name of a centre by id — «Sociedad (sin centro)» for null (R4 label), the raw id when the structure does not know it. */
export function centreNameFor(structure: FinanceStructure | null, propertyId: string | null | undefined, fallback?: string): string {
  if (!propertyId) return SOCIETY_NO_CENTRE_LABEL;
  const centre = structure?.centres.find((row) => row.id === propertyId);
  if (centre) return centreDisplayName(centre);
  return fallback ?? propertyId;
}

/**
 * Options of a «Centro» picker inside a form (manual entry, export, replay):
 * «Sociedad (sin centro)» first when the form admits society-level rows, then
 * every centre (the oficina central included unless `excludeOffice`).
 */
export function centreSelectOptions(structure: FinanceStructure | null, active: ActiveCentre, options: { societyLevel?: boolean; societyLabel?: string; excludeOffice?: boolean } = {}): CocoaSelectOption[] {
  const out: CocoaSelectOption[] = [];
  if (options.societyLevel) out.push({ value: "", label: options.societyLabel ?? SOCIETY_NO_CENTRE_LABEL });
  for (const centre of eligibleCentres(structure, active, { excludeOffice: options.excludeOffice })) out.push({ value: centre.id, label: `${centreDisplayName(centre)} · ${PROPERTY_KIND_LABELS[centre.kind]}` });
  return out;
}

// ---------------------------------------------------------------------------
// Storage and URL (pure parsers; the browser access lives in the hook)
// ---------------------------------------------------------------------------

type StoredScope = FinanceScope & { organizationId: string };

/** Parses localStorage["hotelos-finance-scope"]; null when malformed or written for another organization. */
export function parseStoredFinanceScope(raw: string | null | undefined, organizationId: string): FinanceScope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredScope> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.organizationId !== organizationId) return null;
    if (parsed.kind !== "entity" && parsed.kind !== "property" && parsed.kind !== "group") return null;
    if (typeof parsed.id !== "string" || typeof parsed.label !== "string") return null;
    return { kind: parsed.kind, id: parsed.id, label: parsed.label };
  } catch {
    return null;
  }
}

export function serializeFinanceScope(scope: FinanceScope, organizationId: string): string {
  const stored: StoredScope = { organizationId, kind: scope.kind, id: scope.id, label: scope.label };
  return JSON.stringify(stored);
}

/** `?ambito=` value of a scope. */
export function financeScopeQueryValue(scope: FinanceScope): string {
  return financeScopeValue(scope);
}

/** The `search` string with `?ambito=` set (or removed when `value` is null); other parameters untouched. */
export function withFinanceScopeParam(search: string, value: string | null): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (value) params.set(FINANCE_SCOPE_QUERY_PARAM, value);
  else params.delete(FINANCE_SCOPE_QUERY_PARAM);
  const next = params.toString();
  return next ? `?${next}` : "";
}

// ---------------------------------------------------------------------------
// Declarante · régimen (labels shared by the fiscal screens)
// ---------------------------------------------------------------------------

export type DeclaranteLike = { legalName: string; taxId: string | null; taxIdValid?: boolean; source?: "legal_entity" | "organization_fallback" };

/** «Declarante: CELUISMA S.A. · A33615980» · «Declarante: Faranda Hotels & Resorts · NIF pendiente». */
export function declaranteLabel(badge: DeclaranteLike): string {
  return `Declarante: ${badge.legalName} · ${badge.taxId ?? "NIF pendiente"}`;
}

/** True when the badge must warn: NIF pending / invalid or a tenant whose sociedad is not backfilled yet («Sociedad pendiente»). */
export function declaranteNeedsAttention(badge: DeclaranteLike): boolean {
  return !badge.taxId || badge.taxIdValid === false || badge.source === "organization_fallback";
}

export type RegimeLike = { siiEnabled: boolean; largeCompany: boolean; periodicityForcedBy?: "sii" | "large_company" | null; modelosNoPresentados?: readonly string[]; verifactu?: { aplica: boolean; motivo: string | null } };

/** Spanish notice of the SII / gran empresa regime, or null when the general regime applies (design §5.3 · R8). */
export function regimeNotice(regimen: RegimeLike | null | undefined): string | null {
  if (!regimen) return null;
  if (regimen.siiEnabled) {
    const models = regimen.modelosNoPresentados && regimen.modelosNoPresentados.length > 0 ? regimen.modelosNoPresentados.join(" y ") : "347 y 390";
    return `Sociedad en SII: los modelos ${models} no se presentan; los modelos 303, 111 y 115 son mensuales y VeriFactu no aplica.`;
  }
  if (regimen.largeCompany) return "Sociedad marcada como gran empresa: los modelos 303, 111 y 115 se presentan cada mes.";
  return null;
}

// ---------------------------------------------------------------------------
// Loader (browser only: api-client and activeProperty are imported lazily)
// ---------------------------------------------------------------------------

let structurePromise: Promise<FinanceStructure> | null = null;
let structureOrganization: string | null = null;
let structureCache: FinanceStructure | null = null;
let authHooked = false;

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota: the choice lives for this render only */
  }
}

/** Active operational centre (the switcher's), read from its storage keys. */
export function readActiveCentre(): ActiveCentre & { organizationId: string } {
  return {
    propertyId: readStorage(ACTIVE_PROPERTY_KEY) ?? "prop_123",
    propertyName: readStorage(ACTIVE_PROPERTY_NAME_KEY) ?? "Hotel Demo Madrid Centro",
    organizationId: readStorage(ACTIVE_ORG_KEY) ?? "org_123"
  };
}

/** Drop the memoized structure (next loadFinanceStructure() refetches). */
export function invalidateFinanceStructure(): void {
  structurePromise = null;
  structureCache = null;
  structureOrganization = null;
}

/** Last structure loaded (synchronous read for the shell banner); null before the first load. */
export function peekFinanceStructure(): FinanceStructure | null {
  return structureCache;
}

/** Keys that open GET /organizations/me/structure (modules/structure/route-permissions.partial.ts: accounting.read, the calendar key). */
export const FINANCE_STRUCTURE_READ_KEYS: readonly string[] = ["accounting.read", "accounting.reports.read"];

/** RF-17: with the grants of the active property known and none of the structure keys among them, the route would only answer 403. */
export function canReadFinanceStructure(grantedPermissions: readonly string[] | null | undefined, isPlatformAdmin = false): boolean {
  if (isPlatformAdmin || grantedPermissions === null || grantedPermissions === undefined) return true;
  return grantedPermissions.some((key) => FINANCE_STRUCTURE_READ_KEYS.includes(key));
}

async function fetchFinanceStructure(organizationId: string): Promise<FinanceStructure> {
  // The typed client of L6 (services/structureApi.ts) is the ONE reader of the structure route; imported lazily
  // (it reaches api-client and import.meta.env) so this module stays loadable under node --test.
  const [{ getOrganizationStructure }, { loadSwitchableProperties }, { getSessionRoleSnapshot }] = await Promise.all([import("./structureApi"), import("./activeProperty"), import("./usersApi")]);
  const snapshot = getSessionRoleSnapshot();
  if (!canReadFinanceStructure(snapshot.grantedPermissions, snapshot.isPlatformAdmin)) {
    // payroll_hr and the other templates without accounting.read: straight to the switcher rows, no 403 in the console.
    const rows = (await loadSwitchableProperties()) as StructuredPropertyRow[];
    return structureFromProperties(rows, organizationId);
  }
  try {
    const response = await getOrganizationStructure();
    return structureFromResponse(response);
  } catch (err) {
    // 404 STRUCTURE_DISABLED (or a permission the session lacks): the switcher rows still know kind, code and sociedad.
    const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
    if (status !== 404 && status !== 403) throw err;
    const rows = (await loadSwitchableProperties()) as StructuredPropertyRow[];
    return structureFromProperties(rows, organizationId);
  }
}

/**
 * GET /organizations/me/structure, memoized per organization and session so
 * every finance screen and the shell share one request. Failures are never
 * memoized: the next caller retries.
 */
export function loadFinanceStructure(options: { refresh?: boolean } = {}): Promise<FinanceStructure> {
  const organizationId = readActiveCentre().organizationId;
  if (!authHooked && typeof window !== "undefined") {
    authHooked = true;
    void import("./auth-storage").then(({ onAuthChange }) => {
      onAuthChange(() => {
        invalidateFinanceStructure();
        writeStorage(FINANCE_SCOPE_STORAGE_KEY, null);
      });
    });
  }
  if (options.refresh || structureOrganization !== organizationId) invalidateFinanceStructure();
  if (!structurePromise) {
    structureOrganization = organizationId;
    const request = fetchFinanceStructure(organizationId).then((structure) => {
      structureCache = structure;
      return structure;
    });
    request.catch(() => {
      if (structurePromise === request) invalidateFinanceStructure();
    });
    structurePromise = request;
  }
  return structurePromise;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type FinanceScopeState = {
  /** Effective scope of the screen (policy applied). */
  scope: FinanceScope;
  /** Select value (`sociedad` or a property id). */
  value: string;
  /** Change from a select value; persists, mirrors `?ambito=` and notifies the other hooks of the page. */
  setScope: (value: string) => void;
  options: CocoaSelectOption[];
  structure: FinanceStructure | null;
  /** Structure still unknown (first load of the session): a reader keyed on `propertyId` waits for it — until then the scope is the active property, even an oficina central the screen excludes (fix:L7 qa#11). */
  loading: boolean;
  /** Policy is `entity_forced`: the select is painted disabled with the sociedad. */
  forced: boolean;
  /** Whether the selector renders at all (never for a single hotel). */
  visible: boolean;
  /** Centre id for the readers (`undefined` = the whole sociedad). */
  propertyId: string | undefined;
  /** Query of the ledger / fiscal readers (`propertyId` or nothing). */
  query: FinanceScopeQuery;
  /** Query of the treasury readers (`propertyId` or `scope=entity`). */
  treasuryQuery: FinanceScopeQuery;
  /** The centre when the scope is one; null for the sociedad. */
  centre: FinanceCentre | null;
  /** Razón social (or the honest fallback). */
  entityName: string;
  /** «Finanzas · <sociedad>» / «Finanzas · <centro>». */
  eyebrow: (section: string) => string;
  /** The finance scope differs from the operational active property (a shell cue, design §8.2). */
  divergesFromActive: boolean;
  /** Active operational centre (the switcher's), for the centre pickers of the forms. */
  active: ActiveCentre;
};

function readQueryScopeValue(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(FINANCE_SCOPE_QUERY_PARAM);
  return value && value.trim() ? value.trim() : null;
}

function readStoredScope(organizationId: string): FinanceScope | null {
  return parseStoredFinanceScope(readStorage(FINANCE_SCOPE_STORAGE_KEY), organizationId);
}

/**
 * The «Ámbito» of a money screen. `policy` comes from FINANCE_SCOPE_POLICIES
 * (pass the screen key through `financeScopePolicy`). Several hooks on one page
 * stay in sync through FINANCE_SCOPE_EVENT.
 */
export function useFinanceScope(policy: FinanceScopePolicy, options: { excludeOffice?: boolean } = {}): FinanceScopeState {
  const active = useMemo(() => readActiveCentre(), []);
  const excludeOffice = options.excludeOffice ?? false;
  const [structure, setStructure] = useState<FinanceStructure | null>(() => peekFinanceStructure());
  const [loading, setLoading] = useState<boolean>(() => peekFinanceStructure() === null);
  const [stored, setStored] = useState<FinanceScope | null>(() => readStoredScope(active.organizationId));
  const [urlValue] = useState<string | null>(() => readQueryScopeValue());

  useEffect(() => {
    let alive = true;
    loadFinanceStructure()
      .then((value) => {
        if (!alive) return;
        setStructure(value);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Another hook of the page (or the shell) changed the scope: re-read storage.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const sync = () => setStored(readStoredScope(active.organizationId));
    window.addEventListener(FINANCE_SCOPE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(FINANCE_SCOPE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [active.organizationId]);

  // `?ambito=` wins over storage the first time the structure is known.
  const [urlApplied, setUrlApplied] = useState(false);
  useEffect(() => {
    if (urlApplied || !structure || !urlValue) return;
    const fromUrl = scopeFromValue(urlValue, structure, active);
    if (fromUrl) {
      writeStorage(FINANCE_SCOPE_STORAGE_KEY, serializeFinanceScope(fromUrl, active.organizationId));
      setStored(fromUrl);
    }
    setUrlApplied(true);
  }, [urlApplied, structure, urlValue, active]);

  const scope = useMemo(() => resolveFinanceScope({ policy, stored, structure, active, excludeOffice }), [policy, stored, structure, active, excludeOffice]);
  const scopeOptions = useMemo(() => financeScopeOptions({ policy, structure, active, excludeOffice }), [policy, structure, active, excludeOffice]);
  const value = financeScopeValue(scope);
  // A stored centre a forced screen cannot use (or an office on an emission screen) still resolves to something the select lists.
  const selectValue = scopeOptions.some((option) => option.value === value) ? value : scopeOptions[0]?.value ?? value;

  const setScope = useCallback(
    (next: string) => {
      const chosen = scopeFromValue(next, structure, active);
      if (!chosen) return;
      writeStorage(FINANCE_SCOPE_STORAGE_KEY, serializeFinanceScope(chosen, active.organizationId));
      setStored(chosen);
      if (typeof window !== "undefined") {
        const search = withFinanceScopeParam(window.location.search, financeScopeQueryValue(chosen));
        try {
          window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
        } catch {
          /* history unavailable: storage already carries the choice */
        }
        window.dispatchEvent(new CustomEvent<FinanceScope>(FINANCE_SCOPE_EVENT, { detail: chosen }));
      }
    },
    [structure, active]
  );

  const centre = scope.kind === "property" ? structure?.centres.find((row) => row.id === scope.id) ?? { id: scope.id, code: null, name: scope.label, kind: "hotel" as PropertyKind, legalEntityId: null } : null;
  const entityName = entityDisplayName(structure);

  return {
    scope,
    value: selectValue,
    setScope,
    options: scopeOptions,
    structure,
    loading,
    forced: policy === "entity_forced",
    visible: financeScopeVisible(policy, structure, scopeOptions),
    propertyId: scope.kind === "property" ? scope.id : undefined,
    query: financeScopeQuery(scope),
    treasuryQuery: financeScopeQuery(scope, { treasury: true }),
    centre,
    entityName,
    // While the structure is still unknown the eyebrow is the bare section: «Finanzas · Sociedad» would
    // flash before the razón social arrives (and the container would paint that placeholder, qa#12).
    eyebrow: (section: string) => (loading && !structure ? section : financeEyebrow(section, scope)),
    divergesFromActive: scope.kind === "entity" ? Boolean(structure && structure.mode !== "single_hotel") : scope.id !== active.propertyId,
    active
  };
}
