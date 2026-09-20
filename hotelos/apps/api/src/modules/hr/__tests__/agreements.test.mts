// Unit tests · Tanda RRHH · RRHH-2 — convenios y reglas (hr/agreements.service.ts).
// Sin base de datos: fakes en memoria por `deps`. Desde apps/api:
//   node --import tsx --test src/modules/hr/__tests__/agreements.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HR_AGREEMENT_DEFAULTS, HR_AGREEMENT_RULE_KEYS, PermissionDeniedError } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import { hrErrorCodeOf } from "../hr-errors.js";
import {
  assignAgreementToProperty,
  createAgreement,
  effectiveRuleValues,
  getAgreement,
  isValidAgreementRuleValue,
  listAgreementRules,
  listAgreements,
  payCountFromRules,
  putAgreementRules,
  resolveAgreementForProperty,
  seedAgreementCatalog,
  updateAgreement,
  type AgreementDeps,
  type AgreementRow,
  type AgreementRuleRow
} from "../agreements.service.js";

type AuditCall = Parameters<AgreementDeps["audit"]>[0];

const ORG = "org_ag_test";
const OTHER_ORG = "org_ag_other";
const HA = "prop_ag_ha";
const HB = "prop_ag_hb";
const FOREIGN = "prop_ag_foreign";

const admin = { organizationId: ORG, propertyId: HA, userId: "usr_ag_rrhh", fullName: "RRHH Test", deviceId: "ag-test", permissions: ["hr.config.manage", "hr.employee.read"], orgScope: true } as unknown as UserContext;
const reader = { ...admin, permissions: ["hr.employee.read"] } as unknown as UserContext;
const nobody = { ...admin, permissions: ["payroll.read"] } as unknown as UserContext;
const haOnly = { ...admin, assignedPropertyIds: [HA], orgScope: false } as unknown as UserContext;

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Property = { id: string; organizationId: string; agreementId: string | null };

function fakeDeps(seed: { agreements?: AgreementRow[]; rules?: AgreementRuleRow[]; properties?: Property[] } = {}) {
  const agreements: AgreementRow[] = [...(seed.agreements ?? [])];
  const rules: AgreementRuleRow[] = [...(seed.rules ?? [])];
  const properties: Property[] = seed.properties ?? [
    { id: HA, organizationId: ORG, agreementId: null },
    { id: HB, organizationId: ORG, agreementId: null },
    { id: FOREIGN, organizationId: OTHER_ORG, agreementId: null }
  ];
  const audits: AuditCall[] = [];
  let seq = 0;
  const now = new Date("2026-09-20T10:00:00Z");
  const deps: AgreementDeps = {
    db: {
      collectiveAgreement: {
        findMany: async ({ where }) => agreements.filter((row) => row.organizationId === where.organizationId && (where.id === undefined || where.id.in.includes(row.id))).map((row) => ({ ...row })),
        findFirst: async ({ where }) => {
          const row = agreements.find((candidate) => candidate.organizationId === where.organizationId && (where.id === undefined || candidate.id === where.id) && (where.code === undefined || candidate.code === where.code));
          return row ? { ...row } : null;
        },
        create: async ({ data }) => {
          const row: AgreementRow = { id: `agr_${++seq}`, createdAt: now, updatedAt: now, ...data };
          agreements.push(row);
          return { ...row };
        },
        update: async ({ where, data }) => {
          const row = agreements.find((candidate) => candidate.id === where.id)!;
          Object.assign(row, data);
          return { ...row };
        }
      },
      agreementRule: {
        findMany: async ({ where }) => rules.filter((row) => (typeof where.agreementId === "string" ? row.agreementId === where.agreementId : where.agreementId.in.includes(row.agreementId))).map((row) => ({ ...row })),
        upsert: async ({ where, create, update }) => {
          const key = where.agreementId_key_validFrom;
          const existing = rules.find((row) => row.agreementId === key.agreementId && row.key === key.key && row.validFrom.getTime() === key.validFrom.getTime());
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          const row: AgreementRuleRow = { id: `rule_${++seq}`, createdAt: now, ...create };
          rules.push(row);
          return { ...row };
        }
      },
      property: {
        findMany: async ({ where }) => properties.filter((row) => row.organizationId === where.organizationId && (where.agreementId === undefined || row.agreementId !== null)).map((row) => ({ ...row })),
        findFirst: async ({ where }) => {
          const row = properties.find((candidate) => candidate.id === where.id && candidate.organizationId === where.organizationId);
          return row ? { ...row } : null;
        },
        update: async ({ where, data }) => {
          const row = properties.find((candidate) => candidate.id === where.id)!;
          row.agreementId = data.agreementId;
          return { ...row };
        }
      }
    },
    audit: (input) => {
      audits.push(input);
      return input as never;
    },
    now: () => now
  };
  return { deps, agreements, rules, properties, audits };
}

async function rejects(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `HttpError esperado, llegó ${String(error)}`);
    return error;
  }
  throw new Error("no lanzó");
}

describe("reglas puras", () => {
  it("payCountFromRules = 12 + extra_pay_count; sin convenio, 14", () => {
    assert.equal(payCountFromRules({ extra_pay_count: 3 }), 15);
    assert.equal(payCountFromRules({ extra_pay_count: 2 }), 14);
    assert.equal(payCountFromRules({ extra_pay_count: 0 }), 12);
    assert.equal(payCountFromRules({}), 14);
    assert.equal(payCountFromRules(null), 14);
  });

  it("isValidAgreementRuleValue exige la forma de cada clave", () => {
    assert.equal(isValidAgreementRuleValue("annual_hours", 1792), true);
    assert.equal(isValidAgreementRuleValue("annual_hours", "1792"), false);
    assert.equal(isValidAgreementRuleValue("annual_hours", -1), false);
    assert.equal(isValidAgreementRuleValue("overtime_max_day", null), true);
    assert.equal(isValidAgreementRuleValue("break_counts_as_work", true), true);
    assert.equal(isValidAgreementRuleValue("break_counts_as_work", "yes"), false);
    assert.equal(isValidAgreementRuleValue("night_from", "22:00"), true);
    assert.equal(isValidAgreementRuleValue("night_from", "25:00"), false);
    assert.equal(isValidAgreementRuleValue("extra_pay_months", [7, 7, 12]), true);
    assert.equal(isValidAgreementRuleValue("extra_pay_months", [13]), false);
    assert.equal(isValidAgreementRuleValue("night_pct_bands", [{ from: "22:00", to: "06:00", pct: 25 }]), true);
    assert.equal(isValidAgreementRuleValue("night_pct_bands", [{ from: "22:00", pct: 25 }]), false);
    assert.equal(isValidAgreementRuleValue("it_complement_rules", [{ absenceType: "it_common", pct: 100, fromDay: 1, firstLeaveOnly: true }]), true);
    assert.equal(isValidAgreementRuleValue("it_complement_rules", [{ absenceType: "vacation", pct: 100, fromDay: 1 }]), false);
    // Los valores por defecto de los cuatro convenios pasan todos su validación.
    for (const template of Object.values(HR_AGREEMENT_DEFAULTS)) {
      for (const key of HR_AGREEMENT_RULE_KEYS) assert.equal(isValidAgreementRuleValue(key, template.rules[key]), true, `${template.code}.${key}`);
    }
  });

  it("effectiveRuleValues elige por clave la versión de mayor validFrom ≤ asOf no caducada", () => {
    const rules: AgreementRuleRow[] = [
      { id: "r1", agreementId: "a", key: "annual_hours", valueJson: 1792, validFrom: day("2019-01-01"), validTo: null, createdAt: day("2026-01-01") },
      { id: "r2", agreementId: "a", key: "annual_hours", valueJson: 1780, validFrom: day("2027-01-01"), validTo: null, createdAt: day("2026-01-01") },
      { id: "r3", agreementId: "a", key: "max_daily_hours", valueJson: 8, validFrom: day("2026-01-01"), validTo: day("2026-12-31"), createdAt: day("2026-01-01") },
      { id: "r4", agreementId: "a", key: "max_daily_hours", valueJson: 9, validFrom: day("2019-01-01"), validTo: null, createdAt: day("2026-01-01") },
      { id: "r5", agreementId: "a", key: "not_a_key", valueJson: 1, validFrom: day("2019-01-01"), validTo: null, createdAt: day("2026-01-01") }
    ];
    assert.deepEqual(effectiveRuleValues(rules, day("2026-06-01")), { annual_hours: 1792, max_daily_hours: 8 });
    assert.deepEqual(effectiveRuleValues(rules, day("2027-03-01")), { annual_hours: 1780, max_daily_hours: 9 });
    assert.deepEqual(effectiveRuleValues(rules, day("2018-06-01")), {});
  });
});

describe("seedAgreementCatalog + resolveAgreementForProperty", () => {
  it("siembra los cuatro convenios con sus 21 reglas, es idempotente y audita como sistema", async () => {
    const { deps, agreements, rules, audits } = fakeDeps();
    const first = await seedAgreementCatalog({ organizationId: ORG }, deps);
    assert.deepEqual(first.created.map((row) => row.code), ["ES-15-HOST", "ES-33-HOST", "ES-39-HOST", "ES-28-HOSP"]);
    assert.deepEqual(first.skipped, []);
    assert.equal(agreements.length, 4);
    assert.equal(rules.length, 4 * HR_AGREEMENT_RULE_KEYS.length);
    assert.equal(audits.length, 4);
    assert.equal(audits[0]!.actorType, "system");
    assert.equal(audits[0]!.action, "HR_AGREEMENT_CHANGED");
    const second = await seedAgreementCatalog({ organizationId: ORG, actorUserId: "usr_ag_rrhh" }, deps);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.skipped, ["ES-15-HOST", "ES-33-HOST", "ES-39-HOST", "ES-28-HOSP"]);
    assert.equal(agreements.length, 4);
    const partial = await seedAgreementCatalog({ organizationId: OTHER_ORG, codes: ["ES-33-HOST"] }, deps);
    assert.deepEqual(partial.created.map((row) => row.code), ["ES-33-HOST"]);
    const listed = await listAgreements({ context: admin }, deps);
    assert.deepEqual(listed.map((row) => [row.code, row.rulesCount, row.propertyIds]), [
      ["ES-15-HOST", 21, []],
      ["ES-28-HOSP", 21, []],
      ["ES-33-HOST", 21, []],
      ["ES-39-HOST", 21, []]
    ]);
    assert.equal(listed[0]!.validFrom, "2019-01-01");
    assert.equal(listed[0]!.ultraactivity, true);
    await assert.rejects(listAgreements({ context: nobody }, deps), PermissionDeniedError);
  });

  it("resolución contrato > centro > null con los valores vigentes en la fecha", async () => {
    const { deps, agreements } = fakeDeps();
    await seedAgreementCatalog({ organizationId: ORG }, deps);
    await seedAgreementCatalog({ organizationId: OTHER_ORG, codes: ["ES-28-HOSP"] }, deps);
    const byCode = (code: string, org = ORG) => agreements.find((row) => row.code === code && row.organizationId === org)!.id;
    await assignAgreementToProperty({ context: admin, propertyId: HA, agreementId: byCode("ES-33-HOST"), correlationId: "a" }, deps);

    const byContract = await resolveAgreementForProperty({ organizationId: ORG, propertyId: HA, contractAgreementId: byCode("ES-15-HOST"), asOf: "2026-08-01" }, deps);
    assert.equal(byContract.source, "contract");
    assert.equal(byContract.agreement?.code, "ES-15-HOST");
    assert.equal(byContract.rules.extra_pay_count, 3);
    assert.equal(byContract.rules.annual_hours, 1792);
    assert.equal(payCountFromRules(byContract.rules), 15);

    const byProperty = await resolveAgreementForProperty({ organizationId: ORG, propertyId: HA }, deps);
    assert.equal(byProperty.source, "property");
    assert.equal(byProperty.agreement?.code, "ES-33-HOST");
    assert.equal(byProperty.rules.annual_hours, 1782);
    assert.equal(byProperty.rules.max_daily_hours, 8);

    const none = await resolveAgreementForProperty({ organizationId: ORG, propertyId: HB }, deps);
    assert.deepEqual(none, { agreement: null, rules: {}, source: null });
    assert.equal(payCountFromRules(none.rules), 14);

    // Un convenio de otra organización en el contrato no cuenta: cae al centro.
    const foreign = await resolveAgreementForProperty({ organizationId: ORG, propertyId: HA, contractAgreementId: byCode("ES-28-HOSP", OTHER_ORG) }, deps);
    assert.equal(foreign.source, "property");
    assert.equal(foreign.agreement?.code, "ES-33-HOST");
    // Antes de la vigencia del convenio no hay valores.
    const early = await resolveAgreementForProperty({ organizationId: ORG, propertyId: HA, asOf: "2020-01-01" }, deps);
    assert.equal(early.source, "property");
    assert.deepEqual(early.rules, {});

    const listed = await getAgreement({ context: reader, agreementId: byCode("ES-33-HOST") }, deps);
    assert.deepEqual(listed.propertyIds, [HA]);
  });

  it("assignAgreementToProperty: centro de otra organización o fuera del ámbito → 404 opaco; convenio ajeno → 404; null desasigna", async () => {
    const { deps, properties, audits } = fakeDeps();
    await seedAgreementCatalog({ organizationId: ORG, codes: ["ES-15-HOST"] }, deps);
    const agreementId = (await listAgreements({ context: admin }, deps))[0]!.id;
    assert.equal(hrErrorCodeOf(await rejects(assignAgreementToProperty({ context: admin, propertyId: FOREIGN, agreementId, correlationId: "a" }, deps))), "PROPERTY_NOT_FOUND");
    assert.equal(hrErrorCodeOf(await rejects(assignAgreementToProperty({ context: haOnly, propertyId: HB, agreementId, correlationId: "a" }, deps))), "PROPERTY_NOT_FOUND");
    assert.equal(hrErrorCodeOf(await rejects(assignAgreementToProperty({ context: admin, propertyId: HA, agreementId: "agr_zzz", correlationId: "a" }, deps))), "HR_AGREEMENT_NOT_FOUND");
    await assert.rejects(assignAgreementToProperty({ context: reader, propertyId: HA, agreementId, correlationId: "a" }, deps), PermissionDeniedError);
    const assigned = await assignAgreementToProperty({ context: haOnly, propertyId: HA, agreementId, correlationId: "a" }, deps);
    assert.deepEqual(assigned, { propertyId: HA, agreementId });
    assert.equal(properties.find((row) => row.id === HA)!.agreementId, agreementId);
    assert.equal(audits.at(-1)!.entityType, "property");
    const cleared = await assignAgreementToProperty({ context: admin, propertyId: HA, agreementId: null, correlationId: "a" }, deps);
    assert.equal(cleared.agreementId, null);
  });
});

describe("createAgreement / updateAgreement / putAgreementRules · versiones por validFrom", () => {
  it("crea con reglas iniciales, rechaza el código repetido y valida fechas", async () => {
    const { deps, rules, audits } = fakeDeps();
    const created = await createAgreement({ context: admin, body: { code: "es-empresa-1", name: "Convenio de empresa", validFrom: "2026-01-01", validTo: "2028-12-31", rules: { annual_hours: 1760, extra_pay_count: 2 } }, correlationId: "c" }, deps);
    assert.equal(created.code, "ES-EMPRESA-1");
    assert.equal(created.rulesCount, 2);
    assert.equal(created.validTo, "2028-12-31");
    assert.equal(rules.length, 2);
    assert.equal(audits[0]!.action, "HR_AGREEMENT_CHANGED");
    const duplicate = await rejects(createAgreement({ context: admin, body: { code: "ES-EMPRESA-1", name: "Otro", validFrom: "2026-01-01" }, correlationId: "c" }, deps));
    assert.equal(duplicate.statusCode, 409);
    assert.equal(hrErrorCodeOf(duplicate), "HR_AGREEMENT_CODE_DUPLICATE");
    assert.equal(hrErrorCodeOf(await rejects(createAgreement({ context: admin, body: { code: "X", name: "x", validFrom: "2026-01-01", validTo: "2025-01-01" }, correlationId: "c" }, deps))), "VALIDATION_ERROR");
    assert.equal(hrErrorCodeOf(await rejects(createAgreement({ context: admin, body: { code: "X", name: "x", validFrom: "2026-01-01", rules: { annual_hours: "mil" as never } }, correlationId: "c" }, deps))), "HR_AGREEMENT_RULE_INVALID");
    assert.equal(hrErrorCodeOf(await rejects(createAgreement({ context: admin, body: { code: "", name: "x", validFrom: "2026-01-01" }, correlationId: "c" }, deps))), "VALIDATION_ERROR");
    await assert.rejects(createAgreement({ context: reader, body: { code: "Y", name: "y", validFrom: "2026-01-01" }, correlationId: "c" }, deps), PermissionDeniedError);

    const updated = await updateAgreement({ context: admin, agreementId: created.id, body: { name: "Convenio de empresa 2026", ultraactivity: true }, correlationId: "u" }, deps);
    assert.equal(updated.name, "Convenio de empresa 2026");
    assert.equal(updated.ultraactivity, true);
    assert.equal(hrErrorCodeOf(await rejects(updateAgreement({ context: admin, agreementId: "agr_zzz", body: { name: "x" }, correlationId: "u" }, deps))), "HR_AGREEMENT_NOT_FOUND");
  });

  it("putAgreementRules versiona por (clave, validFrom): la nueva vigencia no borra la anterior y listAgreementRules(asOf) devuelve una por clave", async () => {
    const { deps, rules } = fakeDeps();
    await seedAgreementCatalog({ organizationId: ORG, codes: ["ES-15-HOST"] }, deps);
    const agreementId = (await listAgreements({ context: admin }, deps))[0]!.id;
    const written = await putAgreementRules({ context: admin, agreementId, rules: [{ key: "annual_hours", value: 1780, validFrom: "2027-01-01" }, { key: "max_daily_hours", value: 8, validFrom: "2026-01-01", validTo: "2026-12-31" }], correlationId: "r" }, deps);
    assert.equal(written.length, 2);
    assert.equal(rules.length, HR_AGREEMENT_RULE_KEYS.length + 2);

    const all = await listAgreementRules({ context: reader, agreementId }, deps);
    assert.equal(all.filter((row) => row.key === "annual_hours").length, 2);
    const in2026 = await listAgreementRules({ context: reader, agreementId, asOf: "2026-06-01" }, deps);
    assert.equal(in2026.length, HR_AGREEMENT_RULE_KEYS.length);
    assert.equal(in2026.find((row) => row.key === "annual_hours")!.value, 1792);
    assert.equal(in2026.find((row) => row.key === "max_daily_hours")!.value, 8);
    const in2027 = await listAgreementRules({ context: reader, agreementId, asOf: "2027-03-01" }, deps);
    assert.equal(in2027.find((row) => row.key === "annual_hours")!.value, 1780);
    assert.equal(in2027.find((row) => row.key === "max_daily_hours")!.value, 9, "la versión caducada cae a la base");

    const resolved2027 = await resolveAgreementForProperty({ organizationId: ORG, contractAgreementId: agreementId, asOf: "2027-03-01" }, deps);
    assert.equal(resolved2027.rules.annual_hours, 1780);

    // Misma (clave, validFrom) → sustituye el valor.
    await putAgreementRules({ context: admin, agreementId, rules: [{ key: "annual_hours", value: 1776, validFrom: "2027-01-01" }], correlationId: "r" }, deps);
    assert.equal(rules.length, HR_AGREEMENT_RULE_KEYS.length + 2);
    assert.equal((await listAgreementRules({ context: reader, agreementId, asOf: "2027-03-01" }, deps)).find((row) => row.key === "annual_hours")!.value, 1776);

    assert.equal(hrErrorCodeOf(await rejects(putAgreementRules({ context: admin, agreementId, rules: [{ key: "bonus", value: 1, validFrom: "2026-01-01" }], correlationId: "r" }, deps))), "HR_AGREEMENT_RULE_INVALID");
    assert.equal(hrErrorCodeOf(await rejects(putAgreementRules({ context: admin, agreementId, rules: [{ key: "annual_hours", value: "x", validFrom: "2026-01-01" }], correlationId: "r" }, deps))), "HR_AGREEMENT_RULE_INVALID");
    assert.equal(hrErrorCodeOf(await rejects(putAgreementRules({ context: admin, agreementId, rules: [], correlationId: "r" }, deps))), "HR_AGREEMENT_RULE_INVALID");
    assert.equal(hrErrorCodeOf(await rejects(putAgreementRules({ context: admin, agreementId, rules: [{ key: "annual_hours", value: 1, validFrom: "2026-01-01", validTo: "2025-01-01" }], correlationId: "r" }, deps))), "VALIDATION_ERROR");
    assert.equal(hrErrorCodeOf(await rejects(putAgreementRules({ context: { ...admin, organizationId: OTHER_ORG } as unknown as UserContext, agreementId, rules: [{ key: "annual_hours", value: 1, validFrom: "2026-01-01" }], correlationId: "r" }, deps))), "HR_AGREEMENT_NOT_FOUND");
    await assert.rejects(putAgreementRules({ context: reader, agreementId, rules: [{ key: "annual_hours", value: 1, validFrom: "2026-01-01" }], correlationId: "r" }, deps), PermissionDeniedError);
  });
});
