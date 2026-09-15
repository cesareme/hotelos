// Finanzas (2026-09-16, fix t6#11 · integrador): the strict zod bodies of
// POST /payroll/contracts and POST /commissions/rules. From apps/api:
//   node --import tsx --test src/schemas/__tests__/payroll-commissions.schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMISSION_APPLIES_TO,
  CreateCommissionRuleSchema,
  CreatePayrollContractSchema,
  PAYROLL_CONTRACT_TYPES,
  PayrollListQuerySchema,
  decimalInputToNumber
} from "../payroll-commissions.schemas.js";

function messagesOf(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

/** What PayrollScreen.tsx sends today. */
const FRONT_CONTRACT = { staffProfileId: "sp_1", propertyId: "prop_123", contractType: "indefinido", startDate: "2026-01-01", grossSalary: 1800 };
/** What CommissionsScreen.tsx sends today. */
const FRONT_RULE = { propertyId: "prop_123", channelCode: "booking", ratePct: 15, appliesTo: "net_revenue" };

describe("CreatePayrollContractSchema", () => {
  it("accepts the front payload and the numeric-string variants (\"1800,50\", irpfRatePct \"15\")", () => {
    const parsed = CreatePayrollContractSchema.parse(FRONT_CONTRACT);
    assert.equal(parsed.grossSalary, 1800);
    assert.equal(parsed.irpfRatePct, undefined);
    const withStrings = CreatePayrollContractSchema.parse({ ...FRONT_CONTRACT, grossSalary: "1800,50", irpfRatePct: "15", endDate: "2026-12-31", payCount: 14 });
    assert.equal(decimalInputToNumber(withStrings.grossSalary), 1800.5);
    assert.equal(decimalInputToNumber(withStrings.irpfRatePct!), 15);
    for (const contractType of PAYROLL_CONTRACT_TYPES) assert.ok(CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, contractType }).success, contractType);
  });

  it("garbage money is a typed 400 in Spanish, never a 500: grossSalary \"abc\", NaN, negative", () => {
    for (const grossSalary of ["abc", Number.NaN, -1, "1.234", {}, null]) {
      const result = CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, grossSalary });
      assert.equal(result.success, false, `grossSalary ${String(grossSalary)}`);
      assert.match(messagesOf(result).join(" | "), /^grossSalary: grossSalary debe ser/);
    }
  });

  it("the t6#11 probe {staffProfileId:\"nope\", contractType:\"x\", startDate, grossSalary:1, foo:1} is refused (unknown key + contractType)", () => {
    const result = CreatePayrollContractSchema.safeParse({ staffProfileId: "nope", contractType: "x", startDate: "2026-01-01", grossSalary: 1, foo: 1 });
    assert.equal(result.success, false);
    const messages = messagesOf(result);
    assert.ok(messages.some((m) => m.includes("Campo no admitido en el cuerpo de la petición.")), messages.join(" | "));
    assert.ok(messages.some((m) => m.startsWith("contractType: contractType debe ser uno de: indefinido")), messages.join(" | "));
  });

  it("dates: YYYY-MM-DD only, endDate on or after startDate; payCount 12-16; irpfRatePct 0-100", () => {
    assert.match(messagesOf(CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, startDate: "01/01/2026" })).join(), /startDate debe ser una fecha YYYY-MM-DD/);
    assert.match(messagesOf(CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, startDate: "2026-13-40" })).join(), /startDate no es una fecha válida/);
    assert.match(messagesOf(CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, endDate: "2025-12-31" })).join(), /endDate debe ser igual o posterior a startDate/);
    assert.match(messagesOf(CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, payCount: 11 })).join(), /payCount debe ser un entero entre 12 y 16/);
    assert.match(messagesOf(CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, payCount: 14.5 })).join(), /payCount debe ser un entero/);
    assert.match(messagesOf(CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, irpfRatePct: 101 })).join(), /irpfRatePct debe estar entre 0 y 100/);
    assert.match(messagesOf(CreatePayrollContractSchema.safeParse({ ...FRONT_CONTRACT, staffProfileId: "" })).join(), /staffProfileId es obligatorio/);
    assert.match(messagesOf(CreatePayrollContractSchema.safeParse({ contractType: "indefinido", startDate: "2026-01-01", grossSalary: 1 })).join(), /staffProfileId es obligatorio/);
  });

  it("PayrollListQuerySchema keeps the tenant filters and ignores unknown query keys", () => {
    assert.deepEqual(PayrollListQuerySchema.parse({ organizationId: "org_1", propertyId: "prop_1", _: "123" }), { organizationId: "org_1", propertyId: "prop_1" });
    assert.deepEqual(PayrollListQuerySchema.parse({}), {});
    assert.equal(PayrollListQuerySchema.safeParse({ organizationId: "" }).success, false);
  });
});

describe("CreateCommissionRuleSchema", () => {
  it("accepts the front payload, lower-cases channelCode and keeps ratePct as received (\"15,5\" included)", () => {
    const parsed = CreateCommissionRuleSchema.parse({ ...FRONT_RULE, channelCode: "Booking" });
    assert.equal(parsed.channelCode, "booking");
    assert.equal(parsed.ratePct, 15);
    assert.equal(CreateCommissionRuleSchema.parse({ ...FRONT_RULE, ratePct: "15,5" }).ratePct, "15,5");
    for (const appliesTo of COMMISSION_APPLIES_TO) assert.ok(CreateCommissionRuleSchema.safeParse({ ...FRONT_RULE, appliesTo }).success, appliesTo);
    assert.ok(CreateCommissionRuleSchema.safeParse({ propertyId: "prop_123", channelId: "ch_1", ratePct: 12, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31T23:59:59Z", ledgerAccountCode: "629.1" }).success);
  });

  it("the t6#11 probe {propertyId, ratePct:\"abc\"} is a 400 in Spanish, never decimal.js in a 500; a rule without channel is refused too", () => {
    const result = CreateCommissionRuleSchema.safeParse({ propertyId: "prop_123", ratePct: "abc" });
    assert.equal(result.success, false);
    assert.deepEqual(messagesOf(result), ["ratePct: ratePct debe ser un número con hasta dos decimales."]);
    // zod runs the object-level refinement only once every field parses: the
    // channel rule surfaces as soon as ratePct is a number.
    assert.deepEqual(messagesOf(CreateCommissionRuleSchema.safeParse({ propertyId: "prop_123", ratePct: 10 })), ["channelCode: Indica channelId o channelCode."]);
  });

  it("ratePct outside (0, 100], bad appliesTo, bad account code, inverted window and unknown keys are refused", () => {
    assert.match(messagesOf(CreateCommissionRuleSchema.safeParse({ ...FRONT_RULE, ratePct: 0 })).join(), /ratePct debe estar entre 0 y 100/);
    assert.match(messagesOf(CreateCommissionRuleSchema.safeParse({ ...FRONT_RULE, ratePct: 100.01 })).join(), /ratePct debe estar entre 0 y 100/);
    assert.match(messagesOf(CreateCommissionRuleSchema.safeParse({ ...FRONT_RULE, appliesTo: "all" })).join(), /appliesTo debe ser gross_revenue, net_revenue o total/);
    assert.match(messagesOf(CreateCommissionRuleSchema.safeParse({ ...FRONT_RULE, ledgerAccountCode: "abc" })).join(), /ledgerAccountCode debe ser un código de cuenta PGC/);
    assert.match(messagesOf(CreateCommissionRuleSchema.safeParse({ ...FRONT_RULE, effectiveFrom: "2026-06-01", effectiveTo: "2026-01-01" })).join(), /effectiveTo debe ser igual o posterior a effectiveFrom/);
    assert.match(messagesOf(CreateCommissionRuleSchema.safeParse({ ...FRONT_RULE, channelCode: "book ing" })).join(), /channelCode solo admite/);
    assert.match(messagesOf(CreateCommissionRuleSchema.safeParse({ ...FRONT_RULE, extra: true })).join(), /Campo no admitido en el cuerpo de la petición/);
    assert.match(messagesOf(CreateCommissionRuleSchema.safeParse({ channelCode: "booking", ratePct: 10 })).join(), /propertyId es obligatorio/);
  });
});
