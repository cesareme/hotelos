// Unit tests · Tanda 7b · L2 — regla contable de los ingresos diarios de OPERA
// (apps/api/src/modules/pms-shadow/revenue-import.posting.ts). Sin base de datos.
// Desde apps/api:
//   node --import tsx --test src/modules/pms-shadow/__tests__/revenue-import-posting.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PMS_SHADOW_RECON_TOLERANCES, type PmsShadowTrxCodeMapping } from "@hotelos/shared";
import { HttpError } from "../../../lib/http-error.js";
import { type PmsShadowRevenueParsedLine } from "../revenue-import.parser.js";
import {
  PMS_SHADOW_COST_CENTRE_TYPE,
  PMS_SHADOW_REVENUE_ACCOUNT_BY_DEPARTMENT,
  PMS_SHADOW_REVENUE_SOURCE_TYPE,
  buildPmsShadowRevenueEntry,
  checkTrialBalance,
  pmsShadowCostCentreCode,
  pmsShadowCostCentreName,
  resolveTrxMapping,
  sumRevenueTotals
} from "../revenue-import.posting.js";

type Details = Record<string, unknown>;

function expectCode(fn: () => unknown, statusCode: number, code: string): Details {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HttpError, `esperaba HttpError, llegó ${String(error)}`);
    assert.equal(error.statusCode, statusCode, `status de ${code}: ${error.message}`);
    const details = (error.details ?? {}) as Details;
    assert.equal(details.code, code, `details.code (${error.message})`);
    return details;
  }
  assert.fail(`esperaba ${statusCode} ${code}`);
}

/** Las 7 líneas del XML sintético RIAS (revenue-import-parser.test.mts). */
const LINES: PmsShadowRevenueParsedLine[] = [
  { code: "1000", description: "Lodging", transactionType: "REVENUE", amount: "1234.50", ledgers: { guest: "1000.00", package: "0.00", ar: "234.50", deposit: "0.00" } },
  { code: "2000", description: "F&B Restaurant", transactionType: "REVENUE", amount: "310.00" },
  { code: "3000", description: "Minibar", transactionType: "REVENUE", amount: "25.00" },
  { code: "8100", description: "IVA 10%", transactionType: "REVENUE", amount: "154.45" },
  { code: "8200", description: "IVA 21%", transactionType: "REVENUE", amount: "5.25" },
  { code: "9000", description: "Cash", transactionType: "PAYMENT", amount: "-900.00" },
  { code: "9500", description: "Paid Out", transactionType: "PAID OUT", amount: "40.00" }
];

/** Mapeo completo del perfil RIAS. */
export const MAPPING: PmsShadowTrxCodeMapping[] = [
  { code: "1000", description: "Lodging", transactionType: "Lodging", kind: "revenue", accountCode: "705.1", usaliDepartment: "rooms" },
  { code: "2000", kind: "revenue", accountCode: "705.2", usaliDepartment: "fnb" },
  { code: "3000", kind: "revenue", usaliDepartment: "other_operated" },
  { code: "8100", kind: "tax", accountCode: "477.10", taxRateCode: "10" },
  { code: "8200", kind: "tax", taxRateCode: "21" },
  { code: "9000", kind: "payment", accountCode: "570" },
  { code: "9500", kind: "ignore" }
];

const COST_CENTRES = new Map<string, string>([
  ["rooms", "cc_rooms"],
  ["fnb", "cc_fnb"],
  ["other_operated", "cc_other"]
]);

function sum(lines: ReadonlyArray<{ debit: string; credit: string }>): { debit: string; credit: string } {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += Number(line.debit);
    credit += Number(line.credit);
  }
  return { debit: debit.toFixed(2), credit: credit.toFixed(2) };
}

describe("resolveTrxMapping", () => {
  it("mapeo completo: kind, cuenta (explícita o por defecto) y departamento; PAID OUT mapeado como ignore", () => {
    const { resolved, unmapped, warnings } = resolveTrxMapping(LINES, MAPPING);
    assert.equal(unmapped.length, 0);
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      resolved.map((line) => [line.code, line.kind, line.accountCode, line.usaliDepartment, line.mapped]),
      [
        ["1000", "revenue", "705.1", "rooms", true],
        ["2000", "revenue", "705.2", "fnb", true],
        ["3000", "revenue", "705.3", "other_operated", true],
        ["8100", "tax", "477.10", null, true],
        ["8200", "tax", "477.21", null, true],
        ["9000", "payment", "570", null, true],
        ["9500", "ignore", null, null, true]
      ]
    );
    assert.deepEqual(resolved[0]!.ledgers, LINES[0]!.ledgers, "los ledgers viajan con la línea");
    assert.equal(PMS_SHADOW_REVENUE_ACCOUNT_BY_DEPARTMENT.other_operated, "705.3");
    assert.equal(PMS_SHADOW_REVENUE_ACCOUNT_BY_DEPARTMENT.rooms, "705.1");
    assert.equal(PMS_SHADOW_REVENUE_ACCOUNT_BY_DEPARTMENT.fnb, "705.2");
  });

  it("código REVENUE con importe ≠ 0 sin mapeo → unmapped; REVENUE a 0 sin mapeo → ignore; código plegado", () => {
    const partial = MAPPING.filter((entry) => entry.code !== "2000");
    const { resolved, unmapped } = resolveTrxMapping([...LINES, { code: "2500", description: "Zero", transactionType: "REVENUE", amount: "0.00" }], partial);
    assert.deepEqual(unmapped.map((line) => [line.code, line.mapped]), [["2000", false]]);
    assert.equal(resolved.find((line) => line.code === "2500")?.kind, "ignore");
    const folded = resolveTrxMapping([{ code: " 1000 ", description: "x", transactionType: "REVENUE", amount: "1.00" }], [{ code: "1000", kind: "revenue", usaliDepartment: "rooms" }]);
    assert.equal(folded.unmapped.length, 0);
    assert.equal(folded.resolved[0]!.accountCode, "705.1");
  });

  it("NON REVENUE / PAID OUT / PACKAGE / INTERNAL / PAYMENT sin mapeo → ignore con aviso; tipo vacío (findeptcodes) bloquea", () => {
    const lines: PmsShadowRevenueParsedLine[] = [
      { code: "7000", description: "Deposit", transactionType: "NON REVENUE", amount: "50.00" },
      { code: "9500", description: "Paid Out", transactionType: "PAID OUT", amount: "40.00" },
      { code: "7500", description: "Pack", transactionType: "PACKAGE", amount: "10.00" },
      { code: "7600", description: "Int", transactionType: "INTERNAL", amount: "1.00" },
      { code: "9100", description: "Visa", transactionType: "PAYMENT", amount: "-100.00" },
      { code: "1000", description: "Lodging", transactionType: "", amount: "100.00" }
    ];
    const { resolved, unmapped, warnings } = resolveTrxMapping(lines, []);
    assert.deepEqual(unmapped.map((line) => line.code), ["1000"]);
    assert.deepEqual(resolved.slice(0, 5).map((line) => line.kind), ["ignore", "ignore", "ignore", "ignore", "ignore"]);
    assert.equal(warnings.length, 5);
    assert.ok(warnings[0]!.includes("7000") && warnings[0]!.includes("NON REVENUE") && warnings[0]!.includes("se ignora"));
  });

  it("mapeos incompletos: revenue sin departamento → other_operated con aviso; tax sin cuenta ni tipo → unmapped; payment sin cuenta → 570 con aviso", () => {
    const { resolved, unmapped, warnings } = resolveTrxMapping(
      [
        { code: "A", description: "a", transactionType: "REVENUE", amount: "1.00" },
        { code: "B", description: "b", transactionType: "REVENUE", amount: "1.00" },
        { code: "C", description: "c", transactionType: "PAYMENT", amount: "-1.00" }
      ],
      [
        { code: "A", kind: "revenue" },
        { code: "B", kind: "tax" },
        { code: "C", kind: "payment" }
      ]
    );
    assert.deepEqual(resolved.map((line) => [line.kind, line.accountCode, line.usaliDepartment, line.mapped]), [
      ["revenue", "705.3", "other_operated", true],
      ["tax", null, null, false],
      ["payment", "570", null, true]
    ]);
    assert.deepEqual(unmapped.map((line) => line.code), ["B"]);
    assert.equal(warnings.length, 3);
  });
});

describe("buildPmsShadowRevenueEntry", () => {
  it("mapeo completo → asiento cuadrado H 705.1 / 705.2 / 705.3 con centro, H 477.10 / 477.21, D 4300 1.729,20", () => {
    const { resolved } = resolveTrxMapping(LINES, MAPPING);
    const entry = buildPmsShadowRevenueEntry({ propertyId: "prop_ra", hotelLabel: "RA", businessDate: "2026-09-15", lines: resolved, costCentreIds: COST_CENTRES });
    assert.equal(entry.sourceType, PMS_SHADOW_REVENUE_SOURCE_TYPE);
    assert.equal(entry.sourceType, "pms_shadow_revenue");
    assert.equal(entry.sourceId, "prop_ra:2026-09-15");
    assert.equal(entry.entryDate, "2026-09-15");
    assert.equal(entry.reference, "2026-09-15");
    assert.equal(entry.description, "Ingresos OPERA · RA · 2026-09-15");
    assert.equal(entry.entryKind, "normal");
    assert.equal(entry.propertyId, "prop_ra");
    assert.deepEqual(entry.warnings, []);
    assert.deepEqual(
      entry.lines.map((line) => [line.accountCode, line.debit, line.credit, line.costCenterId, line.taxRateCode, line.description]),
      [
        ["705.1", "0.00", "1234.50", "cc_rooms", null, "1000 · Lodging"],
        ["705.2", "0.00", "310.00", "cc_fnb", null, "2000 · F&B Restaurant"],
        ["705.3", "0.00", "25.00", "cc_other", null, "3000 · Minibar"],
        ["477.10", "0.00", "154.45", null, "10", "8100 · IVA 10%"],
        ["477.21", "0.00", "5.25", null, "21", "8200 · IVA 21%"],
        ["4300", "1729.20", "0.00", null, null, "Clientes · ingresos OPERA del día 2026-09-15"]
      ]
    );
    assert.deepEqual(sum(entry.lines), { debit: "1729.20", credit: "1729.20" });
    assert.deepEqual(entry.totals, { revenue: "1569.50", tax: "159.70", payments: "900.00", other: "40.00" });
  });

  it("includePayments → además D 570 900,00 / H 4300 900,00 (8 líneas cuadradas)", () => {
    const { resolved } = resolveTrxMapping(LINES, MAPPING);
    const entry = buildPmsShadowRevenueEntry({ propertyId: "prop_ra", hotelLabel: "RA", businessDate: "2026-09-15", lines: resolved, includePayments: true, costCentreIds: COST_CENTRES });
    assert.equal(entry.lines.length, 8);
    assert.deepEqual(entry.lines.slice(6).map((line) => [line.accountCode, line.debit, line.credit]), [
      ["570", "900.00", "0.00"],
      ["4300", "0.00", "900.00"]
    ]);
    assert.deepEqual(sum(entry.lines), { debit: "2629.20", credit: "2629.20" });
    assert.equal(entry.totals.payments, "900.00");
  });

  it("código REVENUE sin mapeo → 400 OPERA_TRX_CODE_UNMAPPED con codes [{ code, description, amount }]", () => {
    const { resolved } = resolveTrxMapping(LINES, MAPPING.filter((entry) => entry.code !== "2000" && entry.code !== "3000"));
    const details = expectCode(() => buildPmsShadowRevenueEntry({ propertyId: "prop_ra", hotelLabel: "RA", businessDate: "2026-09-15", lines: resolved, costCentreIds: COST_CENTRES }), 400, "OPERA_TRX_CODE_UNMAPPED");
    assert.deepEqual(details.codes, [
      { code: "2000", description: "F&B Restaurant", amount: "310.00" },
      { code: "3000", description: "Minibar", amount: "25.00" }
    ]);
  });

  it("NON REVENUE sin mapeo se ignora con aviso y no genera línea; sin líneas con importe → PMS_SHADOW_REVENUE_EMPTY", () => {
    const { resolved, warnings } = resolveTrxMapping([{ code: "7000", description: "Deposit", transactionType: "NON REVENUE", amount: "50.00" }, ...LINES.slice(0, 1)], MAPPING);
    assert.equal(warnings.length, 1);
    const entry = buildPmsShadowRevenueEntry({ propertyId: "prop_ra", hotelLabel: "RA", businessDate: "2026-09-15", lines: resolved, costCentreIds: COST_CENTRES });
    assert.equal(entry.lines.length, 2);
    assert.equal(entry.totals.other, "50.00");
    const onlyIgnored = resolveTrxMapping([{ code: "7000", description: "Deposit", transactionType: "NON REVENUE", amount: "50.00" }], []);
    expectCode(() => buildPmsShadowRevenueEntry({ propertyId: "prop_ra", hotelLabel: "RA", businessDate: "2026-09-15", lines: onlyIgnored.resolved, costCentreIds: COST_CENTRES }), 400, "PMS_SHADOW_REVENUE_EMPTY");
    const onlyPayments = resolveTrxMapping([LINES[5]!], MAPPING);
    expectCode(() => buildPmsShadowRevenueEntry({ propertyId: "prop_ra", hotelLabel: "RA", businessDate: "2026-09-15", lines: onlyPayments.resolved, includePayments: false, costCentreIds: COST_CENTRES }), 400, "PMS_SHADOW_REVENUE_EMPTY");
  });

  it("importe negativo cambia de lado (corrección de OPERA): D 705.1 y H 4300; cobro positivo (devolución) → H 570 / D 4300", () => {
    const { resolved } = resolveTrxMapping(
      [
        { code: "1000", description: "Lodging", transactionType: "REVENUE", amount: "-100.00" },
        { code: "2000", description: "F&B", transactionType: "REVENUE", amount: "250.00" },
        { code: "9000", description: "Cash refund", transactionType: "PAYMENT", amount: "30.00" }
      ],
      MAPPING
    );
    const entry = buildPmsShadowRevenueEntry({ propertyId: "prop_ra", hotelLabel: "RA", businessDate: "2026-09-15", lines: resolved, includePayments: true, costCentreIds: COST_CENTRES });
    assert.deepEqual(entry.lines.map((line) => [line.accountCode, line.debit, line.credit]), [
      ["705.1", "100.00", "0.00"],
      ["705.2", "0.00", "250.00"],
      ["4300", "150.00", "0.00"],
      ["570", "0.00", "30.00"],
      ["4300", "30.00", "0.00"]
    ]);
    assert.deepEqual(sum(entry.lines), { debit: "280.00", credit: "280.00" });
    assert.equal(entry.totals.revenue, "150.00");
    assert.equal(entry.totals.payments, "-30.00");
  });

  it("centro de coste ausente → línea sin centro y aviso", () => {
    const { resolved } = resolveTrxMapping(LINES.slice(0, 1), MAPPING);
    const entry = buildPmsShadowRevenueEntry({ propertyId: "prop_ra", hotelLabel: "RA", businessDate: "2026-09-15", lines: resolved, costCentreIds: new Map() });
    assert.equal(entry.lines[0]!.costCenterId, null);
    assert.equal(entry.warnings.length, 1);
    assert.ok(entry.warnings[0]!.includes("rooms"));
  });
});

describe("totales, centros y cuadre", () => {
  it("sumRevenueTotals: revenue, tax, payments en positivo, other = ignore + sin mapear", () => {
    const { resolved } = resolveTrxMapping(LINES, MAPPING.filter((entry) => entry.code !== "3000"));
    assert.deepEqual(sumRevenueTotals(resolved), { revenue: "1544.50", tax: "159.70", payments: "900.00", other: "65.00" });
  });

  it("pmsShadowCostCentreCode / Name y tipo usali", () => {
    assert.equal(pmsShadowCostCentreCode("rooms"), "ROOMS");
    assert.equal(pmsShadowCostCentreCode("other_operated"), "OTHER_OPERATED");
    assert.equal(pmsShadowCostCentreName("fnb"), "Alimentos y bebidas");
    assert.equal(pmsShadowCostCentreName("misc_income"), "Ingresos varios");
    assert.equal(PMS_SHADOW_COST_CENTRE_TYPE, "usali");
  });

  it("checkTrialBalance: ok dentro de la tolerancia, mismatch fuera, sin declarado → ok", () => {
    assert.deepEqual(checkTrialBalance("869.20", "869.20"), { transactionTotalToday: "869.20", sumTotalAmount: "869.20", delta: "0.00", ok: true });
    assert.deepEqual(checkTrialBalance("869.20", "868.50"), { transactionTotalToday: "868.50", sumTotalAmount: "869.20", delta: "0.70", ok: true });
    const mismatch = checkTrialBalance("869.20", "900.00");
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.delta, "-30.80");
    assert.equal(checkTrialBalance("100.00", "101.01").ok, false, `tolerancia ${PMS_SHADOW_RECON_TOLERANCES.revenueTotal}`);
    assert.equal(checkTrialBalance("100.00", "101.00").ok, true);
    assert.deepEqual(checkTrialBalance("869.20"), { sumTotalAmount: "869.20", delta: "0.00", ok: true });
    assert.deepEqual(checkTrialBalance("869.20", null), { sumTotalAmount: "869.20", delta: "0.00", ok: true });
  });
});
