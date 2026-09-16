// Unit tests puros del CLI payroll:import-cost (Tanda 6c · L3). Sin base de
// datos: flags (dry-run por defecto, --apply exige --confirm igual a
// --organization), USAGE, decodificación UTF-8 / latin1 / BOM, detección de
// formato, tablas de presentación con cifras SINTÉTICAS (nunca datos reales ni
// por persona), código de salida del dry-run y constantes del usuario de
// sistema. Desde apps/api:
//   node --import tsx --test src/scripts/__tests__/import-payroll-cost.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PayrollCostCentreMonthDto, PayrollCostGroupTotals, PayrollCostImportPreview } from "@hotelos/shared";
import {
  CLI_PERMISSIONS,
  CORRELATION_ID,
  CREATED_BY,
  SYSTEM_USER_ID,
  USAGE,
  assertConfirmMatches,
  decodeInput,
  detectFormat,
  dryRunExitCode,
  formatCentreMonthTable,
  formatEs,
  formatGroupTable,
  parseFlags,
  systemContext
} from "../import-payroll-cost.js";

const ORG = "org_sintetica_demo";
const BASE = ["--file", "coste.csv", "--organization", ORG];

describe("parseFlags", () => {
  it("dry-run por defecto; --replace y --json opcionales; --file y --organization obligatorios", () => {
    assert.deepEqual(parseFlags(BASE), { file: "coste.csv", organization: ORG, apply: false, confirm: null, replace: false, json: false, help: false });
    assert.deepEqual(parseFlags([...BASE, "--dry-run", "--replace", "--json"]), { file: "coste.csv", organization: ORG, apply: false, confirm: null, replace: true, json: true, help: false });
    assert.throws(() => parseFlags(["--organization", ORG]), /--file/);
    assert.throws(() => parseFlags(["--file", "coste.csv"]), /--organization/);
    assert.throws(() => parseFlags(["--file"]), /necesita un valor/);
    assert.throws(() => parseFlags([...BASE, "--file", "otro.csv"]), /solo puede indicarse una vez/);
  });

  it("--help / -h cortocircuitan y USAGE nombra todos los flags y las constantes del usuario de sistema", () => {
    assert.equal(parseFlags(["--help"]).help, true);
    assert.equal(parseFlags(["--apply", "-h"]).help, true);
    for (const flag of ["--file", "--organization", "--dry-run", "--apply", "--confirm", "--replace", "--json", "--help"]) assert.ok(USAGE.includes(flag), `USAGE menciona ${flag}`);
    assert.ok(USAGE.includes(SYSTEM_USER_ID));
    assert.ok(USAGE.includes(CREATED_BY));
    assert.ok(USAGE.includes(CORRELATION_ID));
    assert.match(USAGE, /payroll:import-cost/);
    assert.match(USAGE, /Nunca datos por persona/);
  });

  it("--apply exige --confirm; --confirm sin --apply, --dry-run + --apply y flags desconocidos se rechazan (salida 2)", () => {
    assert.throws(() => parseFlags([...BASE, "--apply"]), /--apply exige --confirm/);
    assert.throws(() => parseFlags([...BASE, "--confirm", ORG]), /--confirm solo tiene sentido con --apply/);
    assert.throws(() => parseFlags([...BASE, "--dry-run", "--apply", "--confirm", ORG]), /excluyentes/);
    assert.throws(() => parseFlags([...BASE, "--force"]), /Flag desconocido "--force"/);
    const apply = parseFlags([...BASE, "--apply", "--confirm", ORG, "--replace"]);
    assert.equal(apply.apply, true);
    assert.equal(apply.confirm, ORG);
    assert.equal(apply.replace, true);
  });
});

describe("assertConfirmMatches", () => {
  it("sin --apply no comprueba nada; con --apply el confirm debe ser exactamente la organización", () => {
    assert.doesNotThrow(() => assertConfirmMatches({ apply: false, confirm: null, organization: ORG }));
    assert.doesNotThrow(() => assertConfirmMatches({ apply: true, confirm: ORG, organization: ORG }));
    assert.throws(() => assertConfirmMatches({ apply: true, confirm: "org_otra", organization: ORG }), /no coincide con --organization/);
    assert.throws(() => assertConfirmMatches({ apply: true, confirm: null, organization: ORG }), /Nada escrito/);
  });
});

describe("decodeInput · detectFormat", () => {
  it("UTF-8 con BOM: quita el BOM y conserva la eñe; latin1 cuando los bytes no son UTF-8 válido", () => {
    const utf8 = decodeInput(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("centro;mes\nREG. CORUÑA;2026-01\n", "utf8")]));
    assert.equal(utf8.encoding, "utf-8");
    assert.equal(utf8.bom, true);
    assert.equal(utf8.content, "centro;mes\nREG. CORUÑA;2026-01\n");
    const latin1 = decodeInput(Buffer.from("centro;mes\nREG. CORUÑA;2026-01\n", "latin1"));
    assert.equal(latin1.encoding, "latin1");
    assert.equal(latin1.bom, false);
    assert.equal(latin1.content, "centro;mes\nREG. CORUÑA;2026-01\n");
    assert.deepEqual(decodeInput(new Uint8Array()), { content: "", encoding: "utf-8", bom: false });
  });

  it("formato por extensión y, sin extensión conocida, por el primer carácter", () => {
    assert.equal(detectFormat("nomina.JSON", "x"), "json");
    assert.equal(detectFormat("nomina.csv", "{"), "csv");
    assert.equal(detectFormat("nomina.txt", "{"), "csv");
    assert.equal(detectFormat("nomina", '  {"rows": []}'), "json");
    assert.equal(detectFormat("nomina", "[]"), "json");
    assert.equal(detectFormat("nomina.dat", "centro;mes"), "csv");
  });
});

/** Celdas de una fila `| a | b |` sin los espacios de alineación. */
function cells(row: string): string[] {
  return row.split("|").slice(1, -1).map((value) => value.trim());
}

function cell(overrides: Partial<PayrollCostCentreMonthDto>): PayrollCostCentreMonthDto {
  return {
    lines: 3,
    gross: "15000.00",
    employerSs: "4500.00",
    totalCost: "19500.00",
    reportedTotalCost: "19500.00",
    headcount: "9.00",
    propertyId: "prop_hd",
    propertyCode: "HD",
    propertyName: "Hotel Demo",
    workCenterLabels: ["HOTEL DEMO"],
    periodCode: "2026-02",
    employeesReported: "8.00",
    departments: ["fnb", "rooms"],
    byGroup: [],
    byDepartment: [],
    ...overrides
  };
}

describe("formatEs · formatCentreMonthTable · formatGroupTable", () => {
  it("formatEs agrupa miles con punto y decimales con coma sin depender de ICU", () => {
    assert.equal(formatEs("1234567.5"), "1.234.567,50");
    assert.equal(formatEs(1234), "1.234,00");
    assert.equal(formatEs("-531.92"), "-531,92");
    assert.equal(formatEs(103456, 0), "103.456");
    assert.equal(formatEs(null), "—");
    assert.equal(formatEs("abc"), "abc");
  });

  it("la tabla centro × mes ordena por mes y código, une varias etiquetas del informe y alinea importes a la derecha", () => {
    const rows = formatCentreMonthTable([
      cell({ propertyId: "prop_oc", propertyCode: "OC", propertyName: "Oficina", periodCode: "2026-02", workCenterLabels: ["OFICINA NORTE", "OFICINA SUR"], departments: ["admin_general"], lines: 2, gross: "3500.00", employerSs: "1050.00", totalCost: "4550.00", headcount: "2.00", employeesReported: null }),
      cell({ periodCode: "2026-03" }),
      cell({})
    ]);
    assert.equal(rows.length, 5, "cabecera + separador + 3 filas");
    assert.deepEqual(cells(rows[0]!), ["Centro", "Mes", "Etiquetas del informe", "Líneas", "Bruto", "SS empresa", "Total", "Empleados", "Empl. informe", "Departamentos USALI"]);
    assert.match(rows[1]!, /^\|(-+\|)+$/);
    assert.deepEqual(cells(rows[2]!), ["HD", "2026-02", "HOTEL DEMO", "3", "15.000,00", "4.500,00", "19.500,00", "9,00", "8,00", "fnb, rooms"]);
    assert.deepEqual(cells(rows[3]!), ["OC", "2026-02", "OFICINA NORTE + OFICINA SUR", "2", "3.500,00", "1.050,00", "4.550,00", "2,00", "—", "admin_general"]);
    assert.deepEqual(cells(rows[4]!).slice(0, 2), ["HD", "2026-03"]);
    assert.ok(rows[3]!.includes("|  3.500,00 |"), `importes alineados a la derecha: ${rows[3]}`);
    assert.ok(rows[2]!.includes("| HOTEL DEMO                  |"), `texto alineado a la izquierda: ${rows[2]}`);
    assert.deepEqual(formatCentreMonthTable([]).length, 2, "sin celdas: cabecera y separador");
  });

  it("la tabla por grupo usa las etiquetas en español y muestra «—» cuando el informe no trae coste total", () => {
    const groups: PayrollCostGroupTotals[] = [
      { costGroup: "operaciones", lines: 10, gross: "100000.00", employerSs: "30000.00", totalCost: "130000.00", reportedTotalCost: "129468.08", headcount: "40.00" },
      { costGroup: "mantenimiento_obra", lines: 2, gross: "8000.00", employerSs: "2400.00", totalCost: "10400.00", reportedTotalCost: null, headcount: "3.00" }
    ];
    const rows = formatGroupTable(groups);
    assert.deepEqual(cells(rows[0]!), ["Grupo", "Líneas", "Bruto", "SS empresa", "Total", "Coste total informe", "Empleados"]);
    assert.deepEqual(cells(rows[2]!), ["Operaciones", "10", "100.000,00", "30.000,00", "130.000,00", "129.468,08", "40,00"]);
    assert.deepEqual(cells(rows[3]!), ["Mantenimiento y obra", "2", "8.000,00", "2.400,00", "10.400,00", "—", "3,00"]);
  });
});

describe("dryRunExitCode", () => {
  const ok: Pick<PayrollCostImportPreview, "errors" | "unmappedCentres" | "unmappedDepartments" | "unmappedGroups" | "duplicateOf" | "overlaps" | "canPost"> = {
    errors: [],
    unmappedCentres: [],
    unmappedDepartments: [],
    unmappedGroups: [],
    duplicateOf: null,
    overlaps: [],
    canPost: true
  };
  const duplicate = { importId: "imp_1", status: "posted" as const, fileName: "a.csv", postedAt: null, periodFrom: "2026-01", periodTo: "2026-08" };

  it("0 solo con canPost; 1 con errores, etiquetas sin mapear o duplicado / solape sin --replace; con --replace pasa", () => {
    assert.equal(dryRunExitCode(ok, false), 0);
    assert.equal(dryRunExitCode({ ...ok, errors: [{ line: 3, message: "importe no numérico" }], canPost: false }, false), 1);
    assert.equal(dryRunExitCode({ ...ok, unmappedCentres: [{ label: "CASA RURAL", rows: 1, suggestions: [] }], canPost: false }, false), 1);
    assert.equal(dryRunExitCode({ ...ok, unmappedDepartments: [{ label: "LAVANDERIA", rows: 2, suggestions: [] }], canPost: false }, true), 1);
    assert.equal(dryRunExitCode({ ...ok, duplicateOf: duplicate, canPost: false }, false), 1);
    assert.equal(dryRunExitCode({ ...ok, duplicateOf: duplicate, canPost: true }, true), 0, "con --replace el duplicado se sustituye");
    assert.equal(dryRunExitCode({ ...ok, overlaps: [{ importId: "imp_1", fileName: null, periodFrom: "2026-01", periodTo: "2026-08", propertyId: "prop_hd", periodCode: "2026-02" }], canPost: false }, false), 1);
    assert.equal(dryRunExitCode({ ...ok, canPost: false }, false), 1, "canPost false por cualquier otra causa → 1");
  });
});

describe("usuario de sistema", () => {
  it("constantes del diseño §7 y contexto con las claves del servicio y ámbito de toda la sociedad (sin assignedPropertyIds)", () => {
    assert.equal(SYSTEM_USER_ID, "usr_system_payroll_cost_import");
    assert.equal(CREATED_BY, "cli:import-payroll-cost");
    assert.equal(CORRELATION_ID, "corr_payroll_cost_import");
    const context = systemContext(ORG, "prop_hd");
    assert.equal(context.userId, SYSTEM_USER_ID);
    assert.equal(context.deviceId, CREATED_BY);
    assert.equal(context.organizationId, ORG);
    assert.equal(context.propertyId, "prop_hd");
    assert.equal(context.isPlatformAdmin, false);
    assert.equal(context.assignedPropertyIds, undefined);
    for (const key of ["payroll.manage", "payroll.read", "accounting.journal.post", "accounting.read", "accounting.entity.read"]) assert.ok(context.permissions.includes(key as never), key);
    assert.deepEqual([...CLI_PERMISSIONS].sort(), [...context.permissions].sort());
  });
});
