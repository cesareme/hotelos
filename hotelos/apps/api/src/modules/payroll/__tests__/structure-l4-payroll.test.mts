// Unit tests · Tanda 6b · L4 — payroll work centre and the employer block of
// the gestoría export (sociedad identity + CCC). No database. Run from apps/api with
//   node --import tsx --test src/modules/payroll/__tests__/structure-l4-payroll.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import { PAYROLL_CSV_HEADER, PAYROLL_SAGE_HEADER, buildPayrollEmployer, employerWarnings, renderPayrollExport, type PayrollEmployer } from "../export.service.js";
import { resolvePayrollWorkCenter } from "../periods.service.js";

const D = (value: string) => new Prisma.Decimal(value);

const identity = {
  legalEntityId: "le_l4",
  legalName: "L4 Hoteles Test SA",
  taxId: "A76543214",
  taxIdValid: true,
  source: "legal_entity" as const,
  cccPrincipal: "33/0001234-56"
};

const slips = [
  { id: "slip_1", staffProfileId: "sp_1", grossSalary: D("2000.00"), irpfRetention: D("300.00"), ssEmployee: D("127.00"), ssEmployer: D("610.00"), netSalary: D("1573.00"), daysWorked: 31 },
  { id: "slip_2", staffProfileId: "sp_2", grossSalary: "1234.56", irpfRetention: "51.44", ssEmployee: "26.13", ssEmployer: "125.51", netSalary: "333.95", daysWorked: 10 }
];
const employees = new Map([
  ["sp_1", { code: "OC-001", name: "Empleada; Oficina", nif: "" }],
  ["sp_2", { code: "HT-002", name: "Recepcionista", nif: "" }]
]);

describe("resolvePayrollWorkCenter · period > contract > profile, never silent", () => {
  it("prefers the period's centre, then the contract's, then the employee profile's", () => {
    assert.equal(resolvePayrollWorkCenter({ periodPropertyId: "prop_office", contractPropertyId: "prop_hotel", profilePropertyId: "prop_other" }), "prop_office");
    assert.equal(resolvePayrollWorkCenter({ periodPropertyId: null, contractPropertyId: "prop_hotel", profilePropertyId: "prop_other" }), "prop_hotel");
    assert.equal(resolvePayrollWorkCenter({ periodPropertyId: null, contractPropertyId: null, profilePropertyId: "prop_other" }), "prop_other");
  });

  it("returns null when no centre exists at all (the caller answers 409 WORK_CENTER_REQUIRED)", () => {
    assert.equal(resolvePayrollWorkCenter({ periodPropertyId: null, contractPropertyId: null, profilePropertyId: undefined }), null);
    assert.equal(resolvePayrollWorkCenter({}), null);
    assert.equal(resolvePayrollWorkCenter({ periodPropertyId: "", contractPropertyId: "" }), null, "empty strings are no centre");
  });
});

describe("buildPayrollEmployer · sociedad identity + CCC of the centre or the principal one", () => {
  it("uses the centre's provincial CCC when the period runs on a centre that has one", () => {
    const employer = buildPayrollEmployer(identity, "prop_office", "28/7654321-00");
    assert.equal(employer.legalEntityId, "le_l4");
    assert.equal(employer.legalName, "L4 Hoteles Test SA");
    assert.equal(employer.taxId, "A76543214");
    assert.equal(employer.taxIdValid, true);
    assert.equal(employer.identitySource, "legal_entity");
    assert.equal(employer.workCenterId, "prop_office");
    assert.equal(employer.ccc, "28/7654321-00");
    assert.equal(employer.cccSource, "work_center");
  });

  it("falls back to LegalEntity.cccPrincipal for an organisation-wide period or a centre without CCC", () => {
    assert.deepEqual([buildPayrollEmployer(identity, null, null).ccc, buildPayrollEmployer(identity, null, null).cccSource], ["33/0001234-56", "legal_entity"]);
    assert.deepEqual([buildPayrollEmployer(identity, "prop_hotel", "   ").ccc, buildPayrollEmployer(identity, "prop_hotel", "   ").cccSource], ["33/0001234-56", "legal_entity"]);
    const none = buildPayrollEmployer({ ...identity, cccPrincipal: null }, null, null);
    assert.equal(none.ccc, null);
    assert.equal(none.cccSource, null);
  });

  it("warns (in Spanish) about a missing NIF, an invalid NIF, a pending sociedad and a missing CCC", () => {
    assert.deepEqual(employerWarnings(buildPayrollEmployer(identity, null, null)), []);
    const pending = employerWarnings(buildPayrollEmployer({ ...identity, legalEntityId: null, taxId: null, taxIdValid: false, source: "organization_fallback", cccPrincipal: null }, null, null));
    assert.equal(pending.length, 3);
    assert.match(pending[0]!, /no tiene NIF.*Estructura societaria/);
    assert.match(pending[1]!, /backfill pendiente/);
    assert.match(pending[2]!, /CCC/);
    const invalid = employerWarnings(buildPayrollEmployer({ ...identity, taxId: "B12345678", taxIdValid: false }, null, null));
    assert.equal(invalid.length, 1);
    assert.match(invalid[0]!, /B12345678.*dígito de control/);
  });
});

describe("renderPayrollExport · the employer travels with every layout", () => {
  const employer: PayrollEmployer = buildPayrollEmployer(identity, null, null);
  const irpfPctBySlip = new Map([["slip_1", "15"], ["slip_2", "12.5"]]);

  it("CSV universal: header ends with nif_empresa;ccc, rows carry the sociedad NIF and the CCC, names with «;» are quoted", () => {
    const csv = renderPayrollExport({ periodCode: "2026-08", format: "csv", slips, employees, employer, irpfPctBySlip });
    assert.equal(csv.filename, "nominas-2026-08.csv");
    assert.equal(csv.contentType, "text/csv");
    const lines = csv.text.replace(/^﻿/, "").trimEnd().split("\n");
    assert.equal(lines[0], PAYROLL_CSV_HEADER);
    assert.ok(PAYROLL_CSV_HEADER.startsWith("periodo;empleado;codigo_empleado;"), "the leading columns of the lote tesoreria-banca are untouched");
    assert.ok(PAYROLL_CSV_HEADER.endsWith(";nif_empresa;ccc"));
    assert.equal(lines[1], '2026-08;"Empleada; Oficina";OC-001;;31;2000,00;15;300,00;127,00;610,00;1573,00;A76543214;33/0001234-56');
    assert.equal(lines[2], "2026-08;Recepcionista;HT-002;;10;1234,56;12,5;51,44;26,13;125,51;333,95;A76543214;33/0001234-56");
    assert.equal(lines.length, 3);
  });

  it("A3-compatible: the first column is the sociedad NIF (empty when pending)", () => {
    const a3 = renderPayrollExport({ periodCode: "2026-08", format: "a3", slips, employees, employer });
    assert.equal(a3.filename, "nominas-2026-08-a3.txt");
    assert.equal(a3.text, "A76543214|OC-001|Empleada; Oficina|2026-08|2000.00|300.00|127.00|610.00|1573.00\nA76543214|HT-002|Recepcionista|2026-08|1234.56|51.44|26.13|125.51|333.95\n");
    const pending = renderPayrollExport({ periodCode: "2026-08", format: "a3", slips: slips.slice(0, 1), employees, employer: { ...employer, taxId: null } });
    assert.ok(pending.text.startsWith("|OC-001|"));
    assert.equal(renderPayrollExport({ periodCode: "2026-08", format: "a3", slips: [], employees, employer }).text, "");
  });

  it("Sage-compatible layout is unchanged (the integration test of the lote tesoreria-banca pins it)", () => {
    const sage = renderPayrollExport({ periodCode: "2026-08", format: "sage", slips: slips.slice(0, 1), employees, employer });
    assert.equal(sage.text, `${PAYROLL_SAGE_HEADER}\nOC-001,2026-08,2000.00,300.00,127.00,610.00,1573.00\n`);
    assert.equal(PAYROLL_SAGE_HEADER, "Employee,Period,Gross,IRPF,SSEmployee,SSEmployer,Net");
  });

  it("an unknown employee falls back to its profile id (never a crash)", () => {
    const csv = renderPayrollExport({ periodCode: "2026-08", format: "csv", slips: [{ ...slips[0]!, staffProfileId: "sp_ghost" }], employees, employer });
    assert.match(csv.text, /2026-08;sp_ghost;sp_ghost;;31;/);
  });
});
