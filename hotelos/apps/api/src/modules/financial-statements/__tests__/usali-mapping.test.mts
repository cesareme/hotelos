// USALI mapping resolution (runbook §4 order), coverage and the editor's
// admitted-combination guard. No database. Run from apps/api with
//   node --import tsx --test src/modules/financial-statements/__tests__/usali-mapping.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USALI_DEPARTMENTS, USALI_DEPARTMENT_LINES, USALI_LINES } from "../../accounting/chart-of-accounts.service.js";
import type { UsaliMappingSourceRow } from "../source.js";
import { assertAdmittedCombinations, buildCoverage, isAdmittedUsali, prefixMatches, resolveUsaliForCode, usaliVocabulary } from "../usali-mapping.service.js";
import { referenceLedger } from "./memory-source.mts";

const mapping = (accountPrefix: string, usaliDepartment: string, usaliLine: string, extra: Partial<UsaliMappingSourceRow> = {}): UsaliMappingSourceRow => ({
  id: `m_${accountPrefix}_${extra.priority ?? 0}`,
  organizationId: "org_t",
  accountPrefix,
  usaliDepartment,
  usaliLine,
  priority: 0,
  active: true,
  createdAt: new Date("2026-09-15T00:00:00Z"),
  updatedAt: new Date("2026-09-15T00:00:00Z"),
  ...extra
});

describe("USALI mapping resolution", () => {
  it("matches an exact code or a prefix, never a sibling", () => {
    assert.equal(prefixMatches("62", "629.1"), true);
    assert.equal(prefixMatches("705", "7050"), true);
    assert.equal(prefixMatches("705.1", "705.1"), true);
    assert.equal(prefixMatches("705.1", "705.2"), false);
    assert.equal(prefixMatches("6291", "629.1"), false);
  });

  it("falls back mapping → account → template → none, in that order", () => {
    const account = { usaliDepartment: "fnb", usaliLine: "other_expense" };
    const rows = [mapping("629.1", "sales_marketing", "other_expense")];
    assert.deepEqual(resolveUsaliForCode("629.1", account, rows), { usaliDepartment: "sales_marketing", usaliLine: "other_expense", source: "mapping", mappingId: rows[0]!.id, issue: null });
    assert.equal(resolveUsaliForCode("629.1", account, []).source, "account");
    assert.equal(resolveUsaliForCode("629.1", account, []).usaliDepartment, "fnb");
    const template = resolveUsaliForCode("629.1", null, []);
    assert.equal(template.source, "template");
    assert.equal(template.usaliDepartment, "rooms");
    assert.equal(template.usaliLine, "other_expense");
    const none = resolveUsaliForCode("645", { usaliDepartment: null, usaliLine: null }, []);
    assert.equal(none.source, "none");
    assert.equal(none.usaliDepartment, null);
    assert.match(none.issue ?? "", /Sin asignar/);
  });

  it("prefers the highest priority, then the longest prefix", () => {
    const rows = [mapping("62", "admin_general", "other_expense"), mapping("629", "pom", "other_expense"), mapping("629.1", "rooms", "other_expense")];
    assert.equal(resolveUsaliForCode("629.1", null, rows).mappingId, "m_629.1_0");
    assert.equal(resolveUsaliForCode("629.2", null, rows).mappingId, "m_629_0");
    assert.equal(resolveUsaliForCode("622", null, rows).mappingId, "m_62_0");
    const withPriority = [...rows, mapping("62", "it", "other_expense", { priority: 10, id: "m_62_10" })];
    assert.equal(resolveUsaliForCode("629.1", null, withPriority).mappingId, "m_62_10");
  });

  it("ignores inactive rows and combinations the schedules do not admit, reporting the issue", () => {
    const inactive = [mapping("705.1", "fnb", "revenue", { active: false })];
    assert.equal(resolveUsaliForCode("705.1", null, inactive).source, "template");
    const bad = [mapping("705.1", "rooms", "cost_of_sales")]; // rooms has no cost of sales
    const resolved = resolveUsaliForCode("705.1", null, bad);
    assert.equal(resolved.source, "template");
    assert.match(resolved.issue ?? "", /no admitida/);
    const badAccount = resolveUsaliForCode("645", { usaliDepartment: "utilities", usaliLine: "labor" }, []);
    assert.equal(badAccount.source, "none");
    assert.match(badAccount.issue ?? "", /combinación no admitida/);
  });

  it("isAdmittedUsali follows USALI_DEPARTMENT_LINES", () => {
    for (const [department, lines] of Object.entries(USALI_DEPARTMENT_LINES)) {
      for (const line of Object.keys(USALI_LINES)) {
        assert.equal(isAdmittedUsali(department, line), lines.includes(line as never), `${department}.${line}`);
      }
    }
    assert.equal(isAdmittedUsali(null, "revenue"), false);
    assert.equal(isAdmittedUsali("rooms", null), false);
  });

  it("assertAdmittedCombinations answers 400 USALI_LINE_NOT_ADMITTED with the offending prefixes", () => {
    assert.doesNotThrow(() => assertAdmittedCombinations([{ accountPrefix: "705.1", usaliDepartment: "rooms", usaliLine: "revenue" }]));
    try {
      assertAdmittedCombinations([{ accountPrefix: "705.1", usaliDepartment: "rooms", usaliLine: "cost_of_sales" }]);
      assert.fail("expected a 400");
    } catch (error) {
      const http = error as { statusCode: number; details: { code: string; issues: Array<{ path: string }> } };
      assert.equal(http.statusCode, 400);
      assert.equal(http.details.code, "USALI_LINE_NOT_ADMITTED");
      assert.equal(http.details.issues[0]!.path, "705.1");
    }
  });

  it("the vocabulary exposes every department with its admitted lines", () => {
    const vocabulary = usaliVocabulary();
    assert.equal(vocabulary.departments.length, Object.keys(USALI_DEPARTMENTS).length);
    assert.equal(vocabulary.lines.length, Object.keys(USALI_LINES).length);
    assert.deepEqual(vocabulary.departments.find((d) => d.key === "rooms")?.lines, ["revenue", "labor", "other_expense"]);
  });
});

describe("USALI coverage", () => {
  it("counts sources and lists unmapped accounts, including those with movements in the period", async () => {
    const source = referenceLedger();
    const accounts = await source.plAccounts();
    const movements = await source.accountBalances({ organizationId: "org_t", mode: "movements", from: "2027-01-01", to: "2027-12-31", groups: [6, 7] });
    const coverage = buildCoverage({ organizationId: "org_t", accounts, mappings: [], period: { from: "2027-01-01", to: "2027-12-31" }, movements });
    assert.equal(coverage.totalAccounts, accounts.length);
    assert.equal(coverage.unmapped, 1);
    assert.deepEqual(coverage.unmappedAccounts.map((a) => a.code), ["645"]);
    assert.equal(coverage.bySource.account, accounts.length - 1); // template defaults are stored on the account rows of the fixture
    assert.equal(coverage.unmappedWithMovements.length, 1);
    assert.equal(coverage.unmappedWithMovements[0]!.debit, "7.00");
    // A mapping for the unmapped code closes the gap.
    const fixed = buildCoverage({ organizationId: "org_t", accounts, mappings: [mapping("645", "admin_general", "labor")], movements });
    assert.equal(fixed.unmapped, 0);
    assert.equal(fixed.bySource.mapping, 1);
    assert.equal(fixed.unmappedWithMovements.length, 0);
  });
});
