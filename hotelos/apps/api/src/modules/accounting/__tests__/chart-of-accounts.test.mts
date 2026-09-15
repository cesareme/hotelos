// Unit tests for the «PGC Pymes hotelero» template and the idempotent chart
// provisioner (Finanzas · lote schema). No database: the provisioner runs on an
// in-memory ChartStore. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/chart-of-accounts.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANONICAL_RULE_ACCOUNT_CODES,
  CHART_TEMPLATE_CODE,
  PGC_PYMES_HOTEL_TEMPLATE,
  USALI_DEPARTMENTS,
  USALI_DEPARTMENT_LINES,
  USALI_LINES,
  accountGroup,
  accountLevel,
  isPostableCode,
  isUsaliRef,
  kindFromLegacyType,
  legacyAccountType,
  parentCandidates,
  planOrganizationChart,
  provisionOrganizationChart,
  resolveParentCode,
  templateAccount,
  templateToRow,
  templateUsaliFor,
  validateChartTemplate,
  type ChartAccountRow,
  type ChartStore,
  type NewChartAccountRow
} from "../chart-of-accounts.service.js";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

type MemoryStore = ChartStore & {
  organizations: Set<string>;
  accounts: Array<ChartAccountRow & { organizationId: string }>;
  settings: Array<{ id: string; organizationId: string; chartTemplate: string | null }>;
  writes: number;
};

function memoryStore(seed: { organizations?: string[]; accounts?: Array<ChartAccountRow & { organizationId: string }>; settings?: MemoryStore["settings"] } = {}): MemoryStore {
  let nextId = 1;
  const store: MemoryStore = {
    organizations: new Set(seed.organizations ?? []),
    accounts: [...(seed.accounts ?? [])],
    settings: [...(seed.settings ?? [])],
    writes: 0,
    async organizationExists(organizationId) {
      return store.organizations.has(organizationId);
    },
    async listAccounts(organizationId) {
      return store.accounts.filter((row) => row.organizationId === organizationId).map((row) => ({ ...row }));
    },
    async createAccounts(rows: NewChartAccountRow[]) {
      let created = 0;
      for (const row of rows) {
        if (store.accounts.some((a) => a.organizationId === row.organizationId && a.code === row.code)) continue;
        store.accounts.push({ id: `acc_${nextId++}`, parentId: null, ...row });
        created += 1;
        store.writes += 1;
      }
      return created;
    },
    async updateAccount(id, patch) {
      const row = store.accounts.find((a) => a.id === id);
      if (!row) throw new Error(`unknown account ${id}`);
      Object.assign(row, patch);
      store.writes += 1;
    },
    async findChartSetting(organizationId) {
      const row = store.settings.find((s) => s.organizationId === organizationId);
      return row ? { id: row.id, chartTemplate: row.chartTemplate } : null;
    },
    async createChartSetting(organizationId, chartTemplate) {
      store.settings.push({ id: `set_${nextId++}`, organizationId, chartTemplate });
      store.writes += 1;
    },
    async updateChartSetting(id, chartTemplate) {
      const row = store.settings.find((s) => s.id === id);
      if (!row) throw new Error(`unknown setting ${id}`);
      row.chartTemplate = chartTemplate;
      store.writes += 1;
    }
  };
  return store;
}

/** A legacy chart like the one prisma/seed.ts gave org_123: names differ, no parents, no USALI, `revenue` type. */
function legacyRow(organizationId: string, code: string, name: string, accountType: string, id = `legacy_${code}`): ChartAccountRow & { organizationId: string } {
  return {
    id,
    organizationId,
    code,
    name,
    accountType,
    parentId: null,
    kind: kindFromLegacyType(accountType),
    group: accountGroup(code),
    level: accountLevel(code),
    isPostable: isPostableCode(code),
    usaliDepartment: null,
    usaliLine: null
  };
}

const ORG = "org_test";

// ---------------------------------------------------------------------------
// Code helpers
// ---------------------------------------------------------------------------

describe("code helpers", () => {
  it("group, level and postability follow the PGC code shape", () => {
    assert.equal(accountGroup("4300"), 4);
    assert.equal(accountGroup("705.1"), 7);
    assert.equal(accountGroup("x"), 0);
    assert.equal(accountLevel("4"), 1);
    assert.equal(accountLevel("43"), 2);
    assert.equal(accountLevel("430"), 3);
    assert.equal(accountLevel("4300"), 4);
    assert.equal(accountLevel("477.21"), 4);
    assert.equal(accountLevel("43000001"), 4);
    assert.equal(isPostableCode("43"), false);
    assert.equal(isPostableCode("430"), true);
    assert.equal(isPostableCode("705.1"), true);
  });
  it("parentCandidates lists proper prefixes longest first (dotted and plain)", () => {
    assert.deepEqual(parentCandidates("477.21"), ["477.2", "477", "47", "4"]);
    assert.deepEqual(parentCandidates("4300"), ["430", "43", "4"]);
    assert.deepEqual(parentCandidates("7"), []);
    assert.deepEqual(parentCandidates("43000001"), ["4300000", "430000", "43000", "4300", "430", "43", "4"]);
    assert.equal(resolveParentCode("4300", new Set(["43", "4"])), "43");
    assert.equal(resolveParentCode("4300", new Set(["430", "43"])), "430");
    assert.equal(resolveParentCode("7", new Set(["7"])), null);
  });
  it("kind ↔ legacy accountType round-trips (revenue == income)", () => {
    assert.equal(legacyAccountType("income"), "revenue");
    assert.equal(legacyAccountType("asset"), "asset");
    assert.equal(kindFromLegacyType("revenue"), "income");
    assert.equal(kindFromLegacyType("income"), "income");
    assert.equal(kindFromLegacyType("liability"), "liability");
    assert.equal(kindFromLegacyType("weird"), "expense");
  });
  it("isUsaliRef only accepts department.line pairs the USALI schedules admit", () => {
    assert.equal(isUsaliRef("rooms.revenue"), true);
    assert.equal(isUsaliRef("fnb.cost_of_sales"), true);
    assert.equal(isUsaliRef("rooms.cost_of_sales"), false, "Rooms has no cost of sales");
    assert.equal(isUsaliRef("utilities.labor"), false);
    assert.equal(isUsaliRef("nope.revenue"), false);
    assert.equal(isUsaliRef("rooms"), false);
    for (const department of Object.keys(USALI_DEPARTMENTS)) {
      assert.ok((USALI_DEPARTMENT_LINES as Record<string, readonly string[]>)[department]?.length, `${department} has lines`);
    }
    for (const lines of Object.values(USALI_DEPARTMENT_LINES)) for (const line of lines) assert.ok(line in USALI_LINES);
  });
});

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

describe("PGC Pymes hotelero template", () => {
  it("is valid: unique codes, kinds by group, headers in place, USALI on every P&L account, canonical accounts present", () => {
    assert.deepEqual(validateChartTemplate(), []);
    assert.ok(PGC_PYMES_HOTEL_TEMPLATE.length >= 200, `template has ${PGC_PYMES_HOTEL_TEMPLATE.length} accounts`);
    assert.equal(CHART_TEMPLATE_CODE, "pgc_pymes_hotelero_v1");
  });
  it("validateChartTemplate detects duplicates, wrong kinds, orphan codes, invalid or missing USALI", () => {
    const base = [
      { code: "6", name: "Compras y gastos", kind: "expense" as const },
      { code: "62", name: "Servicios exteriores", kind: "expense" as const },
      { code: "621", name: "Arrendamientos", kind: "expense" as const, usali: "non_operating.rent" as const }
    ];
    assert.ok(validateChartTemplate([...base, { code: "621", name: "dup", kind: "expense", usali: "non_operating.rent" }]).some((i) => /duplicado/.test(i)));
    assert.ok(validateChartTemplate([...base, { code: "622", name: "x", kind: "income", usali: "pom.other_expense" }]).some((i) => /grupo 6 debe ser expense/.test(i)));
    assert.ok(validateChartTemplate([...base, { code: "705", name: "x", kind: "income", usali: "rooms.revenue" }]).some((i) => /sin cabecera/.test(i)));
    assert.ok(validateChartTemplate([...base, { code: "623", name: "x", kind: "expense" }]).some((i) => /sin mapeo USALI/.test(i)));
    assert.ok(validateChartTemplate([...base, { code: "623", name: "x", kind: "expense", usali: "rooms.cost_of_sales" as never }]).some((i) => /no válido/.test(i)));
    assert.ok(validateChartTemplate([...base, { code: "62", name: "x", kind: "expense", usali: "pom.other_expense" }]).some((i) => /duplicado|Cabecera/.test(i)));
    assert.ok(validateChartTemplate(base).some((i) => /canónica .* ausente/.test(i)), "a tiny template misses the canonical accounts");
  });
  it("contains every account of the canonical posting rules with the right nature", () => {
    const expectations: Array<[string, "asset" | "liability" | "equity" | "income" | "expense"]> = [
      ["430", "asset"], ["4300", "asset"], ["400", "liability"], ["410", "liability"], ["4700", "asset"], ["4709", "asset"],
      ["472.21", "asset"], ["472.10", "asset"], ["472.04", "asset"], ["4751", "liability"], ["4752", "liability"], ["4759", "liability"],
      ["476", "liability"], ["477.21", "liability"], ["477.10", "liability"], ["477.04", "liability"], ["465", "liability"],
      ["570", "asset"], ["572", "asset"], ["5721", "asset"], ["5722", "asset"], ["600", "expense"], ["607", "expense"], ["621", "expense"],
      ["622", "expense"], ["623", "expense"], ["624", "expense"], ["625", "expense"], ["626", "expense"], ["627", "expense"], ["628", "expense"],
      ["629", "expense"], ["629.1", "expense"], ["631", "expense"], ["640", "expense"], ["642", "expense"], ["662", "expense"], ["681", "expense"],
      ["680", "expense"], ["700", "income"], ["705", "income"], ["705.1", "income"], ["705.2", "income"], ["705.3", "income"], ["705.4", "income"],
      ["708", "income"], ["769", "income"], ["762", "income"], ["630", "expense"], ["129", "equity"], ["100", "equity"], ["281", "asset"], ["2816", "asset"]
    ];
    for (const [code, kind] of expectations) {
      const account = templateAccount(code);
      assert.ok(account, `${code} present`);
      assert.equal(account.kind, kind, `${code} is ${kind}`);
      assert.match(account.name, /[A-Za-zÁÉÍÓÚáéíóúñ]/, `${code} has a Spanish name`);
    }
    for (const code of CANONICAL_RULE_ACCOUNT_CODES) assert.ok(templateAccount(code), `canonical ${code} present`);
  });
  it("maps hotel P&L accounts to the expected USALI departments", () => {
    assert.deepEqual(templateUsaliFor("705.1"), { usaliDepartment: "rooms", usaliLine: "revenue" });
    assert.deepEqual(templateUsaliFor("705.2"), { usaliDepartment: "fnb", usaliLine: "revenue" });
    assert.deepEqual(templateUsaliFor("705.4"), { usaliDepartment: "fnb", usaliLine: "revenue" });
    assert.deepEqual(templateUsaliFor("629.1"), { usaliDepartment: "rooms", usaliLine: "other_expense" }, "OTA commissions live in Rooms · Other expenses (USALI 11th)");
    assert.deepEqual(templateUsaliFor("628.4"), { usaliDepartment: "it", usaliLine: "other_expense" });
    assert.deepEqual(templateUsaliFor("621"), { usaliDepartment: "non_operating", usaliLine: "rent" });
    assert.deepEqual(templateUsaliFor("631"), { usaliDepartment: "non_operating", usaliLine: "property_taxes" });
    assert.deepEqual(templateUsaliFor("625"), { usaliDepartment: "non_operating", usaliLine: "insurance" });
    assert.deepEqual(templateUsaliFor("623.1"), { usaliDepartment: "management_fees", usaliLine: "management_fee" });
    assert.deepEqual(templateUsaliFor("681"), { usaliDepartment: "below_ebitda", usaliLine: "depreciation_amortization" });
    assert.deepEqual(templateUsaliFor("630"), { usaliDepartment: "below_ebitda", usaliLine: "income_tax" });
    assert.deepEqual(templateUsaliFor("662"), { usaliDepartment: "below_ebitda", usaliLine: "interest" });
    assert.deepEqual(templateUsaliFor("640.1"), { usaliDepartment: "rooms", usaliLine: "labor" });
    assert.deepEqual(templateUsaliFor("640.7"), { usaliDepartment: "admin_general", usaliLine: "labor" }, "unknown sub-account falls back to its parent");
    assert.deepEqual(templateUsaliFor("7050"), { usaliDepartment: "rooms", usaliLine: "revenue" }, "legacy 7050 falls back to 705");
    assert.equal(templateUsaliFor("4300"), null, "balance accounts have no USALI line");
    assert.equal(templateUsaliFor("62"), null, "headers have no USALI line");
  });
  it("templateToRow derives the persisted metadata (legacy accountType included)", () => {
    const row = templateToRow(ORG, templateAccount("705.2")!);
    assert.deepEqual(row, {
      organizationId: ORG,
      code: "705.2",
      name: "Prestaciones de servicios: restauración",
      accountType: "revenue",
      kind: "income",
      group: 7,
      level: 4,
      isPostable: true,
      usaliDepartment: "fnb",
      usaliLine: "revenue"
    });
    const header = templateToRow(ORG, templateAccount("47")!);
    assert.equal(header.isPostable, false);
    assert.equal(header.level, 2);
    assert.equal(header.usaliDepartment, null);
  });
});

// ---------------------------------------------------------------------------
// Provisioner
// ---------------------------------------------------------------------------

describe("provisionOrganizationChart", () => {
  it("rejects an unknown organisation", async () => {
    const store = memoryStore();
    await assert.rejects(provisionOrganizationChart("nope", { store }), /no existe/);
    assert.equal(store.writes, 0);
  });

  it("dry-run computes the plan and writes nothing", async () => {
    const store = memoryStore({ organizations: [ORG] });
    const result = await provisionOrganizationChart(ORG, { store, dryRun: true });
    assert.equal(result.applied, false);
    assert.equal(result.created, 0);
    assert.equal(result.plan.toCreate.length, PGC_PYMES_HOTEL_TEMPLATE.length);
    assert.equal(result.plan.setting, "create");
    assert.deepEqual(result.plan.missingCanonical, []);
    assert.equal(store.writes, 0);
    assert.equal(store.accounts.length, 0);
  });

  it("provisions a fresh organisation: every template account, parents linked, template recorded; second run is a no-op", async () => {
    const store = memoryStore({ organizations: [ORG] });
    const first = await provisionOrganizationChart(ORG, { store });
    assert.equal(first.applied, true);
    assert.equal(first.created, PGC_PYMES_HOTEL_TEMPLATE.length);
    assert.equal(first.totalAfter, PGC_PYMES_HOTEL_TEMPLATE.length);
    assert.equal(first.settingWritten, true);
    assert.equal(first.linked, PGC_PYMES_HOTEL_TEMPLATE.length - 7, "every account except the 7 group headers gets a parent");
    assert.deepEqual(store.settings.map((s) => [s.organizationId, s.chartTemplate]), [[ORG, CHART_TEMPLATE_CODE]]);

    const byCode = new Map(store.accounts.map((a) => [a.code, a]));
    assert.equal(byCode.get("477.21")!.parentId, byCode.get("477")!.id);
    assert.equal(byCode.get("4300")!.parentId, byCode.get("430")!.id);
    assert.equal(byCode.get("430")!.parentId, byCode.get("43")!.id);
    assert.equal(byCode.get("43")!.parentId, byCode.get("4")!.id);
    assert.equal(byCode.get("4")!.parentId, null);
    assert.equal(byCode.get("705.1")!.usaliDepartment, "rooms");
    assert.equal(byCode.get("705.1")!.accountType, "revenue");
    assert.equal(byCode.get("62")!.isPostable, false);

    const writesAfterFirst = store.writes;
    const second = await provisionOrganizationChart(ORG, { store });
    assert.equal(second.created, 0);
    assert.equal(second.linked, 0);
    assert.equal(second.usaliFilled, 0);
    assert.equal(second.settingWritten, false);
    assert.equal(second.plan.setting, "keep");
    assert.equal(second.totalAfter, PGC_PYMES_HOTEL_TEMPLATE.length);
    assert.equal(store.writes, writesAfterFirst, "second run performs no write");
  });

  it("converges a legacy chart (seed.ts style): keeps names and ids, adds what is missing, links parents, fills USALI, never deletes", async () => {
    const legacy = [
      legacyRow(ORG, "4300", "Clientes (s)", "asset"),
      legacyRow(ORG, "705", "Prestaciones de servicios (alojamiento)", "revenue"),
      legacyRow(ORG, "7050", "Otros servicios (Parking, Spa)", "revenue"),
      legacyRow(ORG, "477", "H.P. IVA repercutido", "liability"),
      legacyRow(ORG, "6230", "Comisiones (OTAs / agencias)", "expense"),
      legacyRow(ORG, "570", "Caja, euros", "asset")
    ];
    const store = memoryStore({
      organizations: [ORG],
      accounts: legacy,
      settings: [{ id: "set_legacy", organizationId: ORG, chartTemplate: null }]
    });
    const plan = await planOrganizationChart(ORG, store);
    assert.equal(plan.existing, 6);
    assert.equal(plan.toCreate.length, PGC_PYMES_HOTEL_TEMPLATE.length - 5, "7050 is not in the template; the other 5 legacy codes are");
    assert.ok(!plan.toCreate.includes("4300") && !plan.toCreate.includes("705"));
    assert.deepEqual(plan.toFillUsali.map((f) => f.code).sort(), ["6230", "705", "7050"]);
    assert.deepEqual(plan.nameDiffers.map((d) => d.code).sort(), ["4300", "477", "6230", "705"], "570 already carries the template name");
    assert.equal(plan.setting, "update");
    assert.deepEqual(plan.missingCanonical, []);

    const result = await provisionOrganizationChart(ORG, { store });
    assert.equal(result.created, PGC_PYMES_HOTEL_TEMPLATE.length - 5);
    assert.equal(result.usaliFilled, 3);
    assert.equal(result.settingWritten, true);
    assert.equal(result.totalAfter, PGC_PYMES_HOTEL_TEMPLATE.length + 1, "legacy 7050 survives");

    const byCode = new Map(store.accounts.map((a) => [a.code, a]));
    assert.equal(byCode.get("705")!.id, "legacy_705", "existing row kept");
    assert.equal(byCode.get("705")!.name, "Prestaciones de servicios (alojamiento)", "never renamed");
    assert.equal(byCode.get("4300")!.name, "Clientes (s)");
    assert.deepEqual([byCode.get("705")!.usaliDepartment, byCode.get("705")!.usaliLine], ["rooms", "revenue"]);
    assert.deepEqual([byCode.get("7050")!.usaliDepartment, byCode.get("7050")!.usaliLine], ["rooms", "revenue"], "legacy sub-account inherits 705");
    assert.deepEqual([byCode.get("6230")!.usaliDepartment, byCode.get("6230")!.usaliLine], ["rooms", "other_expense"]);
    assert.equal(byCode.get("7050")!.parentId, byCode.get("705")!.id, "legacy rows get linked too");
    assert.equal(byCode.get("4300")!.parentId, byCode.get("430")!.id);
    assert.equal(store.settings[0]!.chartTemplate, CHART_TEMPLATE_CODE);

    const again = await provisionOrganizationChart(ORG, { store });
    assert.equal(again.created + again.linked + again.usaliFilled, 0);
    assert.equal(again.settingWritten, false);
    assert.equal(store.accounts.length, PGC_PYMES_HOTEL_TEMPLATE.length + 1);
  });

  it("never overwrites an existing USALI mapping", async () => {
    const custom = { ...legacyRow(ORG, "705", "Prestaciones de servicios", "revenue"), usaliDepartment: "other_operated", usaliLine: "revenue" };
    const store = memoryStore({ organizations: [ORG], accounts: [custom] });
    const result = await provisionOrganizationChart(ORG, { store });
    assert.equal(result.usaliFilled, 0);
    const row = store.accounts.find((a) => a.code === "705")!;
    assert.deepEqual([row.usaliDepartment, row.usaliLine], ["other_operated", "revenue"]);
  });
});
