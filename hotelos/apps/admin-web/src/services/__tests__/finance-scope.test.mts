import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CORPORATE_COLUMN_LABEL,
  FINANCE_SCOPE_ENTITY_VALUE,
  FINANCE_SCOPE_POLICIES,
  FINANCE_SCOPE_QUERY_PARAM,
  FINANCE_SCOPE_STORAGE_KEY,
  OPERATIONAL_CENTRE_SCREENS,
  SOCIETY_NO_CENTRE_LABEL,
  UNASSIGNED_COLUMN_LABEL,
  centreOptionLabel,
  declaranteLabel,
  declaranteNeedsAttention,
  entityOptionLabel,
  financeEyebrow,
  canReadFinanceStructure,
  FINANCE_STRUCTURE_READ_KEYS,
  financeScopeOptions,
  financeScopePolicy,
  financeScopeQuery,
  financeScopeValue,
  financeScopeVisible,
  parseStoredFinanceScope,
  regimeNotice,
  resolveFinanceScope,
  scopeFromValue,
  serializeFinanceScope,
  structureFromProperties,
  structureFromResponse,
  withFinanceScopeParam,
  type FinanceStructure,
  type StructureResponse
} from "../financeScope.ts";
import { FINANCE_ERROR_MESSAGES, financeErrorMessage, isEntityScopeRequired, treasuryScopeQuery, verifactuExclusionText, withStructureDetails } from "../finance-contracts.ts";

// Pure tests: no network, no api-client (import.meta.env is not available
// under node --test), no DOM. The Faranda fixture mirrors GET
// /organizations/me/structure of the local demo (sociedad FAR, centres RA · LT)
// plus an oficina central the design adds in L8.

const repo = (file: string) => readFileSync(new URL(`../../../../../${file}`, import.meta.url), "utf8");
const src = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const RA = "cmrhw9jy40003fyvbuu2ec2w7";
const LT = "cmu1mifcp0000fyo1wzvq7txo";
const OC = "prop_oficina";
const ORG = "cmrhw9jy30002fyvb6tsdiugt";
const ACTIVE = { propertyId: RA, propertyName: "Hotel Faranda Rías Altas by Ascend Collection" };

const response: StructureResponse = {
  organization: { id: ORG, name: "Faranda Hotels & Resorts", country: "ES" },
  legalEntity: {
    id: "le_5a1bd74b",
    code: "FAR",
    legalName: "CELUISMA S.A.",
    taxId: "B99999997",
    taxIdValid: true,
    siiEnabled: false,
    largeCompany: false,
    pgcVariant: "pymes",
    properties: [
      { id: OC, code: "OC", name: "Oficina central", kind: "office" },
      { id: RA, code: "RA", name: "Hotel Faranda Rías Altas by Ascend Collection", kind: "hotel" },
      { id: LT, code: "LT", name: "Faranda Los Tilos, Ascend Hotel Collection", kind: "hotel" }
    ]
  },
  mode: "multi_center",
  scope: "entity"
};

const faranda: FinanceStructure = structureFromResponse(response);
const centreOnly: FinanceStructure = { ...faranda, entityReadable: false };
const single: FinanceStructure = { ...faranda, mode: "single_hotel", centres: faranda.centres.filter((c) => c.id === RA) };

describe("financeScope · estructura", () => {
  it("maps the structure route: sociedad, hotels first then the oficina, entity readable from `scope`", () => {
    assert.equal(faranda.entity?.legalName, "CELUISMA S.A.");
    assert.equal(faranda.entity?.taxId, "B99999997");
    assert.deepEqual(
      faranda.centres.map((c) => c.code),
      ["LT", "RA", "OC"],
      "hotels by name, then the office"
    );
    assert.equal(faranda.entityReadable, true);
    assert.equal(structureFromResponse({ ...response, scope: "assigned_properties" }).entityReadable, false);
    assert.equal(structureFromResponse({ ...response, legalEntity: null }).entity, null);
  });

  it("falls back to the switcher rows when the structure route is off (STRUCTURE_ENABLED=false)", () => {
    const rows = [
      { id: RA, name: "Rías Altas", organizationId: ORG, organizationName: "Faranda", kind: "hotel" as const, code: "RA", legalEntityId: "le", legalEntityName: "Faranda Hotels & Resorts" },
      { id: LT, name: "Los Tilos", organizationId: ORG, kind: "hotel" as const, code: "LT", legalEntityId: "le", legalEntityName: "Faranda Hotels & Resorts" },
      { id: "prop_123", name: "Otra org", organizationId: "org_123" }
    ];
    const structure = structureFromProperties(rows, ORG);
    assert.equal(structure.mode, "multi_center");
    assert.equal(structure.entity?.legalName, "Faranda Hotels & Resorts");
    assert.deepEqual(structure.centres.map((c) => c.id), [LT, RA]);
    assert.equal(structure.entityReadable, true, "grants unknown → the API decides");
    assert.equal(structureFromProperties(rows.slice(0, 1), ORG).mode, "single_hotel");
  });
});

describe("financeScope · quién pide GET /organizations/me/structure (corrector RRHH · RF-17)", () => {
  it("con los permisos del centro conocidos y sin accounting.read / accounting.reports.read no se pide la ruta (payroll_hr sin 403 en consola); desconocidos o plataforma → se pide", () => {
    assert.deepEqual([...FINANCE_STRUCTURE_READ_KEYS], ["accounting.read", "accounting.reports.read"]);
    assert.equal(canReadFinanceStructure(["hr.employee.read", "payroll.read", "workforce.read"]), false);
    assert.equal(canReadFinanceStructure([]), false);
    assert.equal(canReadFinanceStructure(["accounting.read"]), true);
    assert.equal(canReadFinanceStructure(["accounting.reports.read"]), true);
    assert.equal(canReadFinanceStructure(null), true, "sin lista de permisos se intenta (el 403 se degrada a las filas del selector)");
    assert.equal(canReadFinanceStructure(undefined), true);
    assert.equal(canReadFinanceStructure([], true), true, "plataforma");
  });
});

describe("financeScope · matriz forzado / defecto / filtro (diseño §5.3)", () => {
  it("names the policy of every money screen and the emission-bound ones", () => {
    for (const forced of ["ChartOfAccountsScreen", "AccountingSettingsScreen", "YearEndCloseScreen", "GestoriaExportScreen", "BalanceSheetScreen", "CashFlowScreen", "AnnualAccountsScreen", "Modelo303Screen", "Modelo390Screen", "Modelo347Screen", "Modelo111Screen", "Modelo115Screen", "Modelo180Screen", "VatBooksScreen", "VatSettlementScreen"]) {
      assert.equal(FINANCE_SCOPE_POLICIES[forced], "entity_forced", forced);
    }
    for (const filtered of ["JournalScreen", "LedgerScreen", "TrialBalanceScreen", "ProfitAndLossScreen", "UsaliScreen", "FinancePositionDashboard", "PayrollScreen"]) {
      assert.equal(FINANCE_SCOPE_POLICIES[filtered], "entity_default", filtered);
    }
    for (const centre of ["BillingCenterScreen", "CashClosureScreen", "SupplierBillsScreen", "ExpensesScreen", "FixedAssetsScreen", "CommissionsScreen", "BankReconciliationScreen"]) {
      assert.equal(FINANCE_SCOPE_POLICIES[centre], "centre_default", centre);
    }
    assert.equal(financeScopePolicy("UnknownScreen"), "entity_default");
    assert.ok(OPERATIONAL_CENTRE_SCREENS.has("BillingCenterScreen") && OPERATIONAL_CENTRE_SCREENS.has("CashClosureScreen"));
    assert.ok(!OPERATIONAL_CENTRE_SCREENS.has("SupplierBillsScreen"), "the oficina central receives supplier bills");
  });

  it("entity_forced → the sociedad; a centre-scoped reader falls back to its active centre", () => {
    const scope = resolveFinanceScope({ policy: "entity_forced", stored: { kind: "property", id: LT, label: "x" }, structure: faranda, active: ACTIVE });
    assert.deepEqual(scope, { kind: "entity", id: "le_5a1bd74b", label: "CELUISMA S.A." });
    const limited = resolveFinanceScope({ policy: "entity_forced", stored: null, structure: centreOnly, active: ACTIVE });
    assert.equal(limited.kind, "property");
    assert.equal(limited.id, RA);
  });

  it("entity_default → the stored centre when still valid, else the sociedad", () => {
    assert.equal(resolveFinanceScope({ policy: "entity_default", stored: null, structure: faranda, active: ACTIVE }).kind, "entity");
    const stored = resolveFinanceScope({ policy: "entity_default", stored: { kind: "property", id: OC, label: "old" }, structure: faranda, active: ACTIVE });
    assert.equal(stored.id, OC);
    assert.equal(stored.label, "Oficina central (OC)", "label is rebuilt from the structure, never trusted from storage");
    const gone = resolveFinanceScope({ policy: "entity_default", stored: { kind: "property", id: "prop_deleted", label: "x" }, structure: faranda, active: ACTIVE });
    assert.equal(gone.kind, "entity");
    const noEntity = resolveFinanceScope({ policy: "entity_default", stored: { kind: "entity", id: "", label: "" }, structure: centreOnly, active: ACTIVE });
    assert.equal(noEntity.kind, "property", "without accounting.entity.read the sociedad is never resolved");
  });

  it("centre_default → the stored centre, else the active hotel; never the sociedad; the office only where allowed", () => {
    const active = resolveFinanceScope({ policy: "centre_default", stored: { kind: "entity", id: "", label: "" }, structure: faranda, active: ACTIVE });
    assert.deepEqual(active, { kind: "property", id: RA, label: "Hotel Faranda Rías Altas by Ascend Collection (RA)" });
    const office = resolveFinanceScope({ policy: "centre_default", stored: { kind: "property", id: OC, label: "" }, structure: faranda, active: ACTIVE });
    assert.equal(office.id, OC, "payables may live in the oficina central");
    const billing = resolveFinanceScope({ policy: "centre_default", stored: { kind: "property", id: OC, label: "" }, structure: faranda, active: ACTIVE, excludeOffice: true });
    assert.equal(billing.id, RA, "emission never happens in the office: back to the active hotel");
    const noStructure = resolveFinanceScope({ policy: "centre_default", stored: null, structure: null, active: ACTIVE });
    assert.equal(noStructure.id, RA);
  });

  it("builds the flat options with the design prefixes and hides the selector for a single hotel", () => {
    const options = financeScopeOptions({ policy: "entity_default", structure: faranda, active: ACTIVE });
    assert.deepEqual(
      options.map((o) => o.label),
      ["Sociedad · CELUISMA S.A. (todo)", "Centro · Faranda Los Tilos, Ascend Hotel Collection (LT)", "Centro · Hotel Faranda Rías Altas by Ascend Collection (RA)", "Centro · Oficina central (OC)"]
    );
    assert.equal(options[0].value, FINANCE_SCOPE_ENTITY_VALUE);
    assert.equal(entityOptionLabel(faranda), "Sociedad · CELUISMA S.A. (todo)");
    assert.equal(centreOptionLabel({ name: "Oficina central", code: "OC" }), "Centro · Oficina central (OC)");
    assert.equal(centreOptionLabel({ name: "Sin código", code: null }), "Centro · Sin código");

    const forced = financeScopeOptions({ policy: "entity_forced", structure: faranda, active: ACTIVE });
    assert.deepEqual(forced.map((o) => o.value), [FINANCE_SCOPE_ENTITY_VALUE]);
    const centreBound = financeScopeOptions({ policy: "centre_default", structure: faranda, active: ACTIVE, excludeOffice: true });
    assert.deepEqual(centreBound.map((o) => o.value), [LT, RA], "no sociedad, no office");
    const limited = financeScopeOptions({ policy: "entity_default", structure: centreOnly, active: ACTIVE });
    assert.ok(!limited.some((o) => o.value === FINANCE_SCOPE_ENTITY_VALUE), "no «Sociedad» without accounting.entity.read");

    assert.equal(financeScopeVisible("entity_default", faranda, options), true);
    assert.equal(financeScopeVisible("entity_forced", faranda, forced), true, "forced screens paint the disabled cue in a multi-centre sociedad");
    assert.equal(financeScopeVisible("entity_default", single, financeScopeOptions({ policy: "entity_default", structure: single, active: ACTIVE })), false);
    assert.equal(financeScopeVisible("entity_default", null, options), false, "nothing before the structure is known");
  });

  it("derives the reader query: propertyId for a centre, nothing (or scope=entity for treasury) for the sociedad", () => {
    const entity = { kind: "entity" as const, id: "le", label: "CELUISMA S.A." };
    const centre = { kind: "property" as const, id: RA, label: "RA" };
    assert.deepEqual(financeScopeQuery(entity), {});
    assert.deepEqual(financeScopeQuery(entity, { treasury: true }), { scope: "entity" });
    assert.deepEqual(financeScopeQuery(centre), { propertyId: RA });
    assert.deepEqual(financeScopeQuery(centre, { treasury: true }), { propertyId: RA });
    assert.deepEqual(treasuryScopeQuery({ scope: "entity", asOf: "2026-09-16" }), { scope: "entity", asOf: "2026-09-16" });
    assert.deepEqual(treasuryScopeQuery({ scope: "entity", propertyId: RA }), { scope: "entity" }, "the sociedad never travels with a propertyId");
    assert.equal(financeScopeValue(entity), FINANCE_SCOPE_ENTITY_VALUE);
    assert.equal(financeScopeValue(centre), RA);
    assert.equal(financeEyebrow("Finanzas", entity), "Finanzas · CELUISMA S.A.");
    assert.equal(financeEyebrow("Cumplimiento", centre), "Cumplimiento · RA");
  });

  it("reads a select / ?ambito= value against the structure", () => {
    assert.equal(scopeFromValue(FINANCE_SCOPE_ENTITY_VALUE, faranda, ACTIVE)?.kind, "entity");
    assert.equal(scopeFromValue(LT, faranda, ACTIVE)?.id, LT);
    assert.equal(scopeFromValue("prop_desconocida", faranda, ACTIVE), null);
    assert.equal(scopeFromValue("", faranda, ACTIVE), null);
  });
});

describe("financeScope · persistencia por sesión y URL", () => {
  it("stores under hotelos-finance-scope, apart from the active property, and forgets another organization", () => {
    assert.equal(FINANCE_SCOPE_STORAGE_KEY, "hotelos-finance-scope");
    assert.equal(FINANCE_SCOPE_QUERY_PARAM, "ambito");
    const raw = serializeFinanceScope({ kind: "property", id: LT, label: "Los Tilos" }, ORG);
    assert.deepEqual(parseStoredFinanceScope(raw, ORG), { kind: "property", id: LT, label: "Los Tilos" });
    assert.equal(parseStoredFinanceScope(raw, "org_123"), null, "the scope of Faranda never leaks into org_123");
    assert.equal(parseStoredFinanceScope("{not json", ORG), null);
    assert.equal(parseStoredFinanceScope(JSON.stringify({ organizationId: ORG, kind: "planet", id: "x", label: "y" }), ORG), null);
    assert.equal(parseStoredFinanceScope(null, ORG), null);
  });

  it("mirrors ?ambito= without touching the other parameters", () => {
    assert.equal(withFinanceScopeParam("?desde=2026-01-01", "sociedad"), "?desde=2026-01-01&ambito=sociedad");
    assert.equal(withFinanceScopeParam("?ambito=sociedad&desde=2026-01-01", LT), `?ambito=${LT}&desde=2026-01-01`);
    assert.equal(withFinanceScopeParam("?ambito=sociedad", null), "");
    assert.equal(withFinanceScopeParam("", null), "");
  });

  it("reads the switcher's storage keys as activeProperty.ts writes them", () => {
    const activeProperty = src("activeProperty.ts");
    const scopeSource = src("financeScope.ts");
    for (const key of ["hotelos-active-property", "hotelos-active-org", "hotelos-active-property-name"]) {
      assert.match(activeProperty, new RegExp(`"${key}"`), `${key} in activeProperty.ts`);
      assert.match(scopeSource, new RegExp(`"${key}"`), `${key} mirrored in financeScope.ts`);
    }
    assert.doesNotMatch(scopeSource.replace(/^\s*\/\/.*$/gm, ""), /^import .* from "\.\/api-client"/m, "no static import of api-client (import.meta.env): the module stays node-loadable");
    assert.doesNotMatch(scopeSource.replace(/^\s*\/\/.*$/gm, ""), /^import .* from "\.\/activeProperty"/m);
  });
});

describe("financeScope · declarante, régimen y etiquetas por centro", () => {
  it("badge «Declarante: razón social · NIF» with the pending states", () => {
    assert.equal(declaranteLabel({ legalName: "CELUISMA S.A.", taxId: "A33615980" }), "Declarante: CELUISMA S.A. · A33615980");
    assert.equal(declaranteLabel({ legalName: "Faranda", taxId: null }), "Declarante: Faranda · NIF pendiente");
    assert.equal(declaranteNeedsAttention({ legalName: "x", taxId: "B99999997", taxIdValid: true, source: "legal_entity" }), false);
    assert.equal(declaranteNeedsAttention({ legalName: "x", taxId: null }), true);
    assert.equal(declaranteNeedsAttention({ legalName: "x", taxId: "B1", taxIdValid: false }), true);
    assert.equal(declaranteNeedsAttention({ legalName: "x", taxId: "B99999997", taxIdValid: true, source: "organization_fallback" }), true);
  });

  it("SII notice names the models that are not filed and the VeriFactu exclusion; silent under the general regime", () => {
    assert.equal(regimeNotice({ siiEnabled: false, largeCompany: false }), null);
    assert.match(regimeNotice({ siiEnabled: true, largeCompany: true, modelosNoPresentados: ["347", "390"] }) ?? "", /347 y 390 no se presentan/);
    assert.match(regimeNotice({ siiEnabled: true, largeCompany: false }) ?? "", /VeriFactu no aplica/);
    assert.match(regimeNotice({ siiEnabled: false, largeCompany: true }) ?? "", /cada mes/);
    assert.equal(regimeNotice(null), null);
  });

  it("fixes the column vocabulary of the «Por centro» views", () => {
    assert.equal(CORPORATE_COLUMN_LABEL, "Oficina central");
    assert.equal(UNASSIGNED_COLUMN_LABEL, "Sin asignar");
    assert.equal(SOCIETY_NO_CENTRE_LABEL, "Sociedad (sin centro)");
  });
});

describe("finance-contracts · códigos de la estructura societaria (Tanda 6b)", () => {
  it("covers every LegalStructureErrorCode of the shared contract plus the codes outside the union", () => {
    const shared = repo("packages/shared/src/legal-structure-types.ts");
    // The union is annotated with JSDoc (semicolons inside): cut at the next exported type.
    const start = shared.indexOf("export type LegalStructureErrorCode");
    const end = shared.indexOf("export type SeriesPrefixClashDetails", start);
    assert.ok(start >= 0 && end > start, "LegalStructureErrorCode not found");
    const block = shared.slice(start, end).replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const codes = [...block.matchAll(/\|\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    assert.ok(codes.length >= 20, `parsed ${codes.length} codes`);
    const missing = codes.filter((code) => !FINANCE_ERROR_MESSAGES[code]);
    assert.deepEqual(missing, []);
    for (const code of ["ENTITY_SCOPE_REQUIRED", "PROPERTY_NOT_FOUND", "JOURNAL_ENTRY_NOT_FOUND", "PERIODICITY_FORCED_BY_REGIME", "ALLOCATION_WEIGHTS_REQUIRED", "ALLOCATION_DUPLICATE_PROPERTY", "ALLOCATION_UNKNOWN_PROPERTY", "ALLOCATION_TARGET_NOT_HOTEL", "ALLOCATION_WEIGHT_INVALID", "ALLOCATION_WEIGHTS_SUM", "ALLOCATION_WEIGHTS_NOT_ALLOWED", "ISSUER_TAX_ID_SERIES_MISMATCH"]) {
      assert.ok(FINANCE_ERROR_MESSAGES[code], `${code} without a Spanish message`);
    }
  });

  it("appends the datum of the details: prefix, screens, fields, motivo", () => {
    const base = FINANCE_ERROR_MESSAGES.SERIES_PREFIX_CLASH;
    assert.equal(financeErrorMessage({ status: 409, details: { code: "SERIES_PREFIX_CLASH", prefix: "FAC-RA-2026-", conflictingPropertyId: LT } }), `${base} Prefijo en conflicto: FAC-RA-2026-.`);
    assert.equal(financeErrorMessage({ status: 409, details: { code: "SERIES_PREFIX_CLASH" } }), base);
    const mismatch = financeErrorMessage({ status: 409, details: { code: "ISSUER_TAX_ID_SERIES_MISMATCH", prefix: "FAC-2026-", legalIdentityScreen: "Configuración › Estructura societaria › Datos fiscales", seriesScreen: "Configuración › Estructura societaria › Series y VeriFactu" } });
    assert.match(mismatch, /Serie afectada: FAC-2026-\./);
    assert.match(mismatch, /Series: Configuración › Estructura societaria › Series y VeriFactu\./);
    assert.match(mismatch, /Datos fiscales: Configuración › Estructura societaria › Datos fiscales\./);
    assert.equal(withStructureDetails("WORK_CENTER_CODE_REQUIRED", "Base.", { screen: "Estructura societaria › Centros" }), "Base. Pantalla: Estructura societaria › Centros.");
    assert.equal(withStructureDetails("HIGH_RISK_CONFIRMATION_REQUIRED", "Base.", { fields: ["taxId", "legalName"] }), "Base. Campos: taxId, legalName.");
    assert.equal(withStructureDetails("VERIFACTU_EXCLUDED_BY_SII", "Base.", { motivo: "Sociedad acogida al SII." }), "Base. Sociedad acogida al SII.");
    assert.equal(withStructureDetails("ENTITY_SCOPE_REQUIRED", "Base.", { requiredPermission: "accounting.entity.read" }), "Base. Permiso: accounting.entity.read.");
    assert.equal(withStructureDetails("LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY", "Base.", { route: "/configuracion/estructura" }), "Base. Ruta: /configuracion/estructura.");
    assert.equal(withStructureDetails("ANY_OTHER", "Base.", { prefix: "x" }), "Base.");
    assert.ok(isEntityScopeRequired({ status: 404, details: { code: "ENTITY_SCOPE_REQUIRED" } }));
    assert.ok(!isEntityScopeRequired({ status: 404, message: "Propiedad no encontrada." }));
  });

  it("finds the SII exclusion of an issued document in its warnings or issuer block", () => {
    assert.equal(verifactuExclusionText({ warnings: ["VERIFACTU_EXCLUDED_BY_SII: La sociedad está en el SII."] }), "La sociedad está en el SII.");
    assert.equal(verifactuExclusionText({ warnings: ["VERIFACTU_EXCLUDED_BY_SII:"] }), FINANCE_ERROR_MESSAGES.VERIFACTU_EXCLUDED_BY_SII);
    assert.equal(verifactuExclusionText({ verifactuExclusion: { motivo: "Motivo del emisor." }, warnings: [] }), "Motivo del emisor.");
    assert.equal(verifactuExclusionText({ warnings: ["Otro aviso"] }), null);
    assert.equal(verifactuExclusionText(null), null);
  });
});
