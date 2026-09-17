// Unit tests · Tanda 7c · L1 — mapa de cuentas Sage → PGC Pymes hotelero (7 reglas del
// diseño §4.4), mapa analítico (§4.5) y clave de documento nativo (§5.1). Puros, sin
// base de datos. Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/ledger-import-mapping.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CUSTOMER_ACCOUNT_CODE, type LedgerAccountMapDto } from "@hotelos/shared";
import { PGC_PYMES_HOTEL_TEMPLATE, isPostableCode, splitUsaliRef, templateUsaliFor } from "../../chart-of-accounts.service.js";
import { CREDITOR_ACCOUNT, SUPPLIER_ACCOUNT, vatInputAccount, vatOutputAccount } from "../../posting-rules.js";
import {
  LEDGER_ACCOUNT_CODE_PATTERN,
  THIRD_PARTY_PREFIX_TARGETS,
  accountForRate,
  costCentreCodeFor,
  documentKeysInText,
  matchProperty,
  nativeInvoiceKey,
  normalizeNativeDocumentKey,
  resolveAccountMapping,
  suggestAnalyticsMapping,
  trailingZeroCandidates,
  type ChartLookup
} from "../ledger-import.mapping.js";
import { PROPERTIES } from "./fixtures/sage200-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Plan PGC Pymes hotelero de la plantilla como lookup del mapeador. */
function templateChart(extra: string[] = []): ChartLookup {
  const chart = new Map<string, { isPostable: boolean; kind: string; usaliDepartment: string | null; usaliLine: string | null; name?: string | null }>();
  for (const account of PGC_PYMES_HOTEL_TEMPLATE) {
    const usali = splitUsaliRef(account.usali);
    chart.set(account.code, { isPostable: isPostableCode(account.code), kind: account.kind, usaliDepartment: usali?.usaliDepartment ?? null, usaliLine: usali?.usaliLine ?? null, name: account.name });
  }
  for (const code of extra) chart.set(code, { isPostable: true, kind: "expense", usaliDepartment: null, usaliLine: null });
  return chart;
}

const chart = templateChart();

function resolve(source: string, options: { porIva?: number | string | null; explicit?: LedgerAccountMapDto[]; sourceName?: string } = {}) {
  return resolveAccountMapping(source, { explicit: new Map((options.explicit ?? []).map((entry) => [entry.sourceAccount, entry])), chart, porIva: options.porIva ?? null, sourceName: options.sourceName ?? null });
}

describe("LEDGER_ACCOUNT_CODE_PATTERN", () => {
  it("es idéntico, carácter a carácter, al literal ACCOUNT_CODE_PATTERN de accounting.service.ts", () => {
    const source = readFileSync(join(HERE, "..", "..", "accounting.service.ts"), "utf8");
    const match = /const ACCOUNT_CODE_PATTERN = (\/.+\/);/.exec(source);
    assert.ok(match, "accounting.service.ts declara const ACCOUNT_CODE_PATTERN = /…/");
    assert.equal(LEDGER_ACCOUNT_CODE_PATTERN.toString(), match[1]);
    assert.equal(LEDGER_ACCOUNT_CODE_PATTERN.toString(), "/^[1-9][0-9]{0,7}(\\.[0-9]{1,3})?$/");
  });

  it("admite las cuentas del plan y rechaza las subcuentas de 9-12 dígitos de Sage", () => {
    for (const code of ["4300", "477.21", "629.1", "623.2", "12345678", "1.999"]) assert.ok(LEDGER_ACCOUNT_CODE_PATTERN.test(code), code);
    for (const code of ["4300000123", "0430", "477.2100", "477.", "abc"]) assert.ok(!LEDGER_ACCOUNT_CODE_PATTERN.test(code), code);
  });
});

describe("resolveAccountMapping · reglas 1-7 de §4.4", () => {
  it("regla 1 · la entrada explícita gana sobre cualquier otra", () => {
    const explicit: LedgerAccountMapDto = { sourceAccount: "4770000", action: "map", accountCode: "477.21", carryCounterparty: false };
    const result = resolve("4770000", { explicit: [explicit], porIva: 10 });
    assert.equal(result.rule, 1);
    assert.equal(result.action, "map");
    assert.equal(result.accountCode, "477.21");
    assert.equal(result.suggested, false);
  });

  it("regla 2 · sin ceros finales ≡ cuenta postable (6400000 → 640, 5720000 → 572, 4300000 → 4300, 5721000 → 5721)", () => {
    assert.deepEqual([resolve("6400000").accountCode, resolve("6400000").rule], ["640", 2]);
    assert.deepEqual([resolve("5720000").accountCode, resolve("5720000").rule], ["572", 2]);
    assert.deepEqual([resolve("5721000").accountCode, resolve("5721000").rule], ["5721", 2]);
    assert.deepEqual([resolve("4300000").accountCode, resolve("4300000").action], [CUSTOMER_ACCOUNT_CODE, "map"]);
    // Los prefijos de tercero sin serial van a la colectiva de los escritores nativos (400 / 410), no a «4000» / «4100».
    assert.deepEqual([resolve("4000000").accountCode, resolve("4000000").rule], [SUPPLIER_ACCOUNT, 2]);
    assert.deepEqual([resolve("4100000").accountCode, resolve("4100000").rule], [CREDITOR_ACCOUNT, 2]);
    assert.deepEqual(trailingZeroCandidates("6400000"), ["6400000", "640000", "64000", "6400", "640"]);
    assert.deepEqual(trailingZeroCandidates("4300000123"), ["4300000123"]);
  });

  it("regla 3 · prefijo + serial ≤ 999 existente (4770021 → 477.21, 4720010 → 472.10, 7050001 → 705.1, 6290001 → 629.1, 6280004 → 628.4)", () => {
    for (const [source, target] of [["4770021", "477.21"], ["4720010", "472.10"], ["7050001", "705.1"], ["6290001", "629.1"], ["6280004", "628.4"], ["4720004", "472.04"]] as const) {
      const result = resolve(source);
      assert.equal(result.action, "map", source);
      assert.equal(result.accountCode, target, source);
      assert.equal(result.rule, 3, source);
      assert.equal(result.suggested, true);
    }
    assert.equal(resolve("4770021").accountCode, vatOutputAccount(21));
    assert.equal(resolve("4720010").accountCode, vatInputAccount(10));
  });

  it("regla 4 · tercero con serial > 0 → collapse a 4300 / 400 / 410 con carryCounterparty", () => {
    const customer = resolve("4300000123");
    assert.deepEqual([customer.action, customer.accountCode, customer.carryCounterparty, customer.rule], ["collapse", CUSTOMER_ACCOUNT_CODE, true, 4]);
    const supplier = resolve("4000000042");
    assert.deepEqual([supplier.action, supplier.accountCode, supplier.rule], ["collapse", SUPPLIER_ACCOUNT, 4]);
    const creditor = resolve("4100000007");
    assert.deepEqual([creditor.action, creditor.accountCode, creditor.rule], ["collapse", CREDITOR_ACCOUNT, 4]);
    assert.equal(resolve("4310000005").accountCode, CUSTOMER_ACCOUNT_CODE);
    assert.equal(resolve("4010000005").accountCode, SUPPLIER_ACCOUNT);
    assert.equal(resolve("4110000009").accountCode, CREDITOR_ACCOUNT);
    assert.equal(THIRD_PARTY_PREFIX_TARGETS["435"], CUSTOMER_ACCOUNT_CODE);
  });

  it("regla 5 · 472 / 477 sin serial con PorIva → map_by_rate con el prefijo; sin bloque IVA → block (regla 7)", () => {
    const byRate = resolve("4770000", { porIva: 10 });
    assert.deepEqual([byRate.action, byRate.accountCode, byRate.rule], ["map_by_rate", "477", 5]);
    assert.equal(accountForRate(byRate.accountCode!, 10), "477.10");
    assert.equal(accountForRate("477", 10), vatOutputAccount(10));
    assert.equal(accountForRate("472", "21"), vatInputAccount(21));
    const input = resolve("4720000", { porIva: "21" });
    assert.deepEqual([input.action, input.accountCode], ["map_by_rate", "472"]);
    const blocked = resolve("4770000");
    assert.deepEqual([blocked.action, blocked.accountCode, blocked.rule], ["block", null, 7]);
  });

  it("regla 6 · prefijo válido sin destino → create prefijo.serial con USALI propuesto por la plantilla (6230002 → 623.2)", () => {
    const created = resolve("6230002", { sourceName: "Asesoría laboral" });
    assert.deepEqual([created.action, created.accountCode, created.rule, created.sourceName], ["create", "623.2", 6, "Asesoría laboral"]);
    const expected = templateUsaliFor("623");
    assert.ok(expected);
    assert.equal(created.usaliDepartment, expected.usaliDepartment);
    assert.equal(created.usaliLine, expected.usaliLine);
    assert.equal(created.usaliDepartment, "admin_general");
    // Balance: sin USALI.
    const balance = resolve("5740003");
    assert.deepEqual([balance.action, balance.accountCode, balance.usaliDepartment ?? null], ["create", "574.3", null]);
  });

  it("regla 7 · resto → block (9990000001, serial > 999, prefijo inexistente)", () => {
    assert.deepEqual([resolve("9990000001").action, resolve("9990000001").rule], ["block", 7]);
    assert.equal(resolve("6281234").action, "block", "serial 1234 > 999");
    assert.equal(resolve("8880001").action, "block", "prefijo 888 no existe en el plan");
    assert.equal(resolve("ABC").action, "block");
  });

  it("nunca mapea el IVA a la cabecera genérica 472 / 477 por la regla 2", () => {
    assert.notEqual(resolve("4770000", { porIva: null }).accountCode, "477");
    assert.notEqual(resolve("4720000").accountCode, "472");
  });
});

describe("mapa analítico", () => {
  const properties = PROPERTIES.map((property) => ({ id: property.id, code: property.code, name: property.name, tradeName: property.tradeName }));

  it("suggestAnalyticsMapping casa el centro por código, nombre o nombre comercial plegados", () => {
    const suggestions = suggestAnalyticsMapping([{ code: "RA" }, { code: "lt" }, { code: "Rías Altas" }, { code: "MARSOL" }, { code: "ZZ", name: "Hotel inexistente" }], properties, "delegacion");
    assert.deepEqual(suggestions.map((s) => [s.sourceCode, s.propertyId, s.suggested]), [["RA", "prop_ra", true], ["lt", "prop_lt", true], ["Rías Altas", "prop_ra", true], ["MARSOL", "prop_mc", true], ["ZZ", null, false]]);
    assert.ok(suggestions.every((s) => s.dimension === "delegacion"));
    assert.equal(matchProperty({ code: "hotel-los-tilos" }, properties)?.id, "prop_lt");
  });

  it("costCentreCodeFor reconoce HAB / REST / MANT / ADM / COM / IT / OTROS y sus variantes", () => {
    assert.equal(costCentreCodeFor("HAB"), "ROOMS");
    assert.equal(costCentreCodeFor("Habitaciones"), "ROOMS");
    assert.equal(costCentreCodeFor("REST"), "FNB");
    assert.equal(costCentreCodeFor("F&B"), "FNB");
    assert.equal(costCentreCodeFor("MANT"), "POM");
    assert.equal(costCentreCodeFor("ADM"), "ADMIN_GENERAL");
    assert.equal(costCentreCodeFor("Administración"), "ADMIN_GENERAL");
    assert.equal(costCentreCodeFor("COM"), "SALES_MARKETING");
    assert.equal(costCentreCodeFor("IT"), "IT");
    assert.equal(costCentreCodeFor("Sistemas"), "IT");
    assert.equal(costCentreCodeFor("OTROS"), "OTHER_OPERATED");
    assert.equal(costCentreCodeFor("SPA"), "OTHER_OPERATED");
    assert.equal(costCentreCodeFor("XX", "Mantenimiento"), "POM", "el nombre desempata");
    assert.equal(costCentreCodeFor("XX"), null);
    const departments = suggestAnalyticsMapping([{ code: "HAB" }, { code: "REST" }, { code: "MANT" }, { code: "ADM" }, { code: "COM" }], properties, "departamento");
    assert.deepEqual(departments.map((d) => d.costCentreCode), ["ROOMS", "FNB", "POM", "ADMIN_GENERAL", "SALES_MARKETING"]);
    assert.ok(departments.every((d) => d.propertyId === null && d.suggested));
  });
});

describe("clave de documento nativo (§5.1)", () => {
  it("normaliza mayúsculas, guiones y ceros a la izquierda: FAC-2026-000001 ≡ Serie FAC-2026 + Factura 1", () => {
    const full = normalizeNativeDocumentKey("FAC-2026-000001", null);
    assert.equal(full, "FAC2026:1");
    assert.equal(normalizeNativeDocumentKey("FAC-2026", "1"), full);
    assert.equal(normalizeNativeDocumentKey("fac-2026", "000001"), full);
    assert.equal(normalizeNativeDocumentKey("FAC 2026", "0001"), full);
    assert.equal(nativeInvoiceKey("FAC-2026-000001"), full);
    assert.equal(normalizeNativeDocumentKey("FAC000015", null), "FAC:15");
    assert.equal(normalizeNativeDocumentKey(null, "000123"), ":123");
    assert.equal(normalizeNativeDocumentKey("", ""), null);
    assert.notEqual(normalizeNativeDocumentKey("REC-2026-000001", null), full);
  });

  it("documentKeysInText extrae los números de documento de un concepto libre", () => {
    const keys = documentKeysInText("Cobro FAC-2026-000015 y rec-2026-3 por transferencia");
    assert.deepEqual(keys, ["FAC2026:15", "REC2026:3"]);
    assert.deepEqual(documentKeysInText(null), []);
    assert.deepEqual(documentKeysInText("Nómina septiembre"), []);
  });
});
