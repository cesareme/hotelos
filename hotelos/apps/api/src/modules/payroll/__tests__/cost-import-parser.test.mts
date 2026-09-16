// Unit tests · Tanda 6c · L1 — parser CSV/JSON del coste de personal importado,
// hash de contenido y mapeo (centros, departamentos, grupos). Sin base de datos;
// cifras sintéticas (nunca datos reales ni por persona). Desde apps/api:
//   node --import tsx --test src/modules/payroll/__tests__/cost-import-parser.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DEPARTMENT_MAP,
  aggregateRows,
  applyPayrollCostMapping,
  canonicalGroup,
  defaultDepartmentFor,
  isAmbiguousThousands,
  normalizeLabel,
  parseAmount,
  parseLabel,
  parseMonth,
  parsePayrollCostContent,
  parseRoomsInventory,
  payrollCostContentHash,
  suggestCentres,
  type NormalizedRow
} from "../cost-import.parser.js";

const HEADER = "centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados";
const HEADER_FULL = `${HEADER};ventas_sin_iva;hab_disponibles;usali`;

const PROPERTIES = [
  { id: "prop_hd", code: "HD", name: "Hotel Demo", tradeName: null, kind: "hotel" as const },
  { id: "prop_hb", code: "HB", name: "Hotel Bahía", tradeName: "Casa Rural Bahía", kind: "hotel" as const },
  { id: "prop_oc", code: "OC", name: "Oficina central", tradeName: null, kind: "office" as const }
];

function csv(...lines: string[]): string {
  return lines.join("\r\n") + "\r\n";
}

describe("normalizeLabel · parseAmount · parseMonth", () => {
  it("normalizeLabel: trim, espacios colapsados, mayúsculas, acentos conservados", () => {
    assert.equal(normalizeLabel("  reg.   coruña "), "REG. CORUÑA");
    assert.equal(normalizeLabel("\uFEFFOficina\tAsturias"), "OFICINA ASTURIAS");
    assert.equal(normalizeLabel(null), "");
  });

  it("parseAmount acepta «1.234,56», «1234.56», «1234,56», «1,234.56» y números; redondea a 2 decimales", () => {
    assert.equal(parseAmount("1.234,56").toFixed(2), "1234.56");
    assert.equal(parseAmount("1234.56").toFixed(2), "1234.56");
    assert.equal(parseAmount("1234,56").toFixed(2), "1234.56");
    assert.equal(parseAmount("1,234.56").toFixed(2), "1234.56");
    assert.equal(parseAmount("1.234.567").toFixed(2), "1234567.00");
    assert.equal(parseAmount(1234.565).toFixed(2), "1234.57");
    assert.equal(parseAmount("12.345 €").toFixed(2), "12.35", "un solo punto es decimal");
    assert.equal(parseAmount("0").toFixed(2), "0.00");
  });

  it("parseAmount rechaza negativos, vacíos y texto", () => {
    assert.throws(() => parseAmount("-5,00", "salario_bruto"), /salario_bruto negativo/);
    assert.throws(() => parseAmount("", "coste_ss"), /coste_ss vacío/);
    assert.throws(() => parseAmount("abc"), /no numérico/);
    assert.throws(() => parseAmount("1,2,3"), /no numérico/);
    assert.throws(() => parseAmount(Number.NaN), /no numérico/);
  });

  it("topes de almacenamiento (SEC-6C-02): importes < 10^12, empleados < 10^6, inventario ≤ 2^31-1, etiquetas ≤ 200 sin caracteres de control", () => {
    assert.equal(parseAmount("999999999999,99").toFixed(2), "999999999999.99");
    assert.throws(() => parseAmount("1000000000000", "salario_bruto"), /salario_bruto supera el máximo admitido \(999999999999\.99\)/);
    assert.equal(parseAmount("999999,99", "empleados", "999999.99").toFixed(2), "999999.99");
    assert.throws(() => parseAmount("10000000", "empleados", "999999.99"), /empleados supera el máximo admitido \(999999\.99\)/);
    assert.equal(parseRoomsInventory("2147483647"), 2147483647);
    assert.throws(() => parseRoomsInventory("2147483648"), /hab_disponibles supera el máximo admitido/);
    assert.equal(parseLabel("  6   pisos ", "departamento"), "6 PISOS");
    assert.equal(parseLabel("x".repeat(200), "centro").length, 200);
    assert.throws(() => parseLabel("x".repeat(201), "centro"), /centro supera 200 caracteres \(201\)/);
    assert.throws(() => parseLabel("6 PI\u0000SOS", "departamento"), /departamento contiene caracteres de control/);
    assert.throws(() => parseLabel("   ", "grupo"), /grupo vacío/);
    // El CSV traduce cada tope a un error con nº de línea (400 PAYROLL_IMPORT_INVALID) en vez de un 500 de Prisma.
    const parsed = parsePayrollCostContent({
      format: "csv",
      content: csv(HEADER_FULL, `HOTEL DEMO;2026-05;operaciones;6 PISOS;1000,00;300,00;;10000000;;;`, `HOTEL DEMO;2026-06;operaciones;${"d".repeat(300)};1000,00;300,00;;3;;;rooms`, `HOTEL DEMO;2026-07;operaciones;6 PI\u0000SOS;1000,00;300,00;;3;;;rooms`, `HOTEL DEMO;2026-08;operaciones;6 PISOS;1000,00;300,00;;3;;2147483648;`, `HOTEL DEMO;2026-09;operaciones;6 PISOS;1000,00;300,00;;3;;;`)
    });
    assert.deepEqual(parsed.errors.map((e) => e.line), [2, 3, 4, 5]);
    assert.match(parsed.errors[0]!.message, /empleados supera el máximo admitido/);
    assert.match(parsed.errors[1]!.message, /departamento supera 200 caracteres/);
    assert.match(parsed.errors[2]!.message, /departamento contiene caracteres de control/);
    assert.match(parsed.errors[3]!.message, /hab_disponibles supera el máximo admitido/);
    assert.equal(parsed.rows.length, 1, "la fila válida se conserva");
    const json = parsePayrollCostContent({ format: "json", content: JSON.stringify({ lineas: [{ centro: "HD", mes: "2026-01", grupo: "operaciones", departamento: "6 PISOS", salarioBruto: 100, costeSs: 30, empleados: 1000000 }], referencia: [{ centroCode: "HD", mes: "2026-01", empleadosInforme: 1000000 }] }) });
    assert.equal(json.errors.length, 2);
    assert.match(json.errors[0]!.message, /lineas\[0\]: empleados supera el máximo admitido/);
    assert.match(json.errors[1]!.message, /referencia\[0\]: empleadosInforme supera el máximo admitido/);
  });

  it("«1.234» (un punto y tres cifras) se lee como 1,23 y el fichero lo AVISA una sola vez (contable-6C-07)", () => {
    assert.equal(isAmbiguousThousands("1.234"), true);
    assert.equal(isAmbiguousThousands(" 12.500 € "), true);
    assert.equal(isAmbiguousThousands("1.234,00"), false);
    assert.equal(isAmbiguousThousands("1234"), false);
    assert.equal(isAmbiguousThousands("1.2345"), false);
    assert.equal(isAmbiguousThousands("1.234.567"), false);
    assert.equal(isAmbiguousThousands(1.234), false, "los números del JSON no son ambiguos");
    const parsed = parsePayrollCostContent({ format: "csv", content: csv(HEADER, "HOTEL DEMO;2026-01;operaciones;6 PISOS;1.234;300,00;;2", "HOTEL DEMO;2026-01;operaciones;5 COCINA;2.500;1.100;;2") });
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows[0]?.gross.toFixed(2), "1.23", "se lee con punto decimal (regla documentada)");
    const ambiguous = parsed.warnings.filter((w) => /importe\(s\) con un solo punto/.test(w));
    assert.equal(ambiguous.length, 1, "un único aviso por fichero");
    assert.match(ambiguous[0]!, /3 importe\(s\)[^\n]*línea 2 \(salario_bruto «1\.234»\), línea 3 \(salario_bruto «2\.500»\), línea 3 \(coste_ss «1\.100»\)/);
    assert.match(ambiguous[0]!, /«1\.234» → 1,23/);
    const clean = parsePayrollCostContent({ format: "csv", content: csv(HEADER, "HOTEL DEMO;2026-01;operaciones;6 PISOS;1.234,00;300,00;;2") });
    assert.equal(clean.warnings.filter((w) => /importe\(s\) con un solo punto/.test(w)).length, 0);
  });

  it("parseMonth admite YYYY-MM y MM/YYYY y rechaza el resto", () => {
    assert.equal(parseMonth("2026-02"), "2026-02");
    assert.equal(parseMonth("02/2026"), "2026-02");
    assert.equal(parseMonth("2/2026"), "2026-02");
    assert.equal(parseMonth(" 2026-12 "), "2026-12");
    assert.throws(() => parseMonth("2026-13"), /no válido/);
    assert.throws(() => parseMonth("202602"), /YYYY-MM o MM\/YYYY/);
    assert.throws(() => parseMonth("2026-02-28"), /no válido/);
  });

  it("canonicalGroup reconoce los cinco grupos con espacios o guiones", () => {
    assert.equal(canonicalGroup("OPERACIONES"), "operaciones");
    assert.equal(canonicalGroup("Mantenimiento obra"), "mantenimiento_obra");
    assert.equal(canonicalGroup("mant-obra"), null);
    assert.equal(canonicalGroup("familia"), "familia");
  });
});

describe("parsePayrollCostContent · CSV", () => {
  it("lee «;» con coma decimal, quita el BOM, ignora líneas vacías y numera las líneas 1-based", () => {
    const content = "\uFEFF" + csv(HEADER, "Hotel Demo;2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3", "", "hotel demo;02/2026;operaciones;6 PISOS;4.000,00;1.200,00;5.200,00;4");
    const parsed = parsePayrollCostContent({ format: "csv", content });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.source, "csv");
    assert.equal(parsed.rows.length, 2);
    const [first, second] = parsed.rows as [NormalizedRow, NormalizedRow];
    assert.equal(first.line, 2);
    assert.equal(second.line, 4, "las líneas vacías cuentan en la numeración del fichero");
    assert.equal(first.workCenterLabel, "HOTEL DEMO");
    assert.equal(second.workCenterLabel, "HOTEL DEMO");
    assert.equal(second.periodCode, "2026-02", "MM/YYYY se normaliza");
    assert.equal(first.gross.toFixed(2), "6000.00");
    assert.equal(first.employerSs.toFixed(2), "1800.00");
    assert.equal(first.totalCost.toFixed(2), "7800.00");
    assert.equal(first.reportedTotalCost?.toFixed(2), "7800.00");
    assert.equal(first.headcount.toFixed(2), "3.00");
    assert.equal(first.centreCodeHint, null);
    assert.equal(first.usaliDepartmentHint, null);
  });

  it("cabecera inválida → error en la línea 1 y ninguna fila", () => {
    const parsed = parsePayrollCostContent({ format: "csv", content: csv("centro;mes;importe", "HD;2026-01;5") });
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0]?.line, 1);
    assert.match(parsed.errors[0]!.message, /faltan las columnas «grupo», «departamento», «salario_bruto», «coste_ss», «coste_total», «empleados»/);
    const empty = parsePayrollCostContent({ format: "csv", content: "   \n" });
    assert.equal(empty.errors.length, 1);
    assert.equal(empty.errors[0]?.line, null);
  });

  it("columnas desconocidas → aviso; cabecera con mayúsculas y acentos → válida", () => {
    const parsed = parsePayrollCostContent({ format: "csv", content: csv("Centro;MES;Grupo;Departamento;Salario_Bruto;Coste_SS;Coste_Total;Empleados;Observación", "HD;2026-01;operaciones;6 PISOS;1000;300;1300;1;nada") });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows.length, 1);
    assert.ok(parsed.warnings.some((w) => w.includes("columna desconocida «observacion»")));
  });

  it("fila con importe negativo → error con nº de línea y el resto se conserva", () => {
    const parsed = parsePayrollCostContent({ format: "csv", content: csv(HEADER, "HD;2026-01;operaciones;6 PISOS;1000;300;1300;1", "HD;2026-01;operaciones;5 COCINA;-10;3;;1", "HD;2026-01;operaciones;3 RECEPCIO;abc;3;;1") });
    assert.equal(parsed.rows.length, 1);
    assert.deepEqual(parsed.errors.map((e) => e.line), [3, 4]);
    assert.match(parsed.errors[0]!.message, /salario_bruto negativo/);
    assert.match(parsed.errors[1]!.message, /salario_bruto no numérico/);
  });

  it("filas repetidas se fusionan sumando importes y empleados con aviso «filas N y M fusionadas»", () => {
    const parsed = parsePayrollCostContent({ format: "csv", content: csv(HEADER, "HD;2026-01;operaciones;6 PISOS;1000,00;300,00;1300,00;1", "HD;2026-01;operaciones;6 PISOS;500,00;150,00;650,00;0,5") });
    assert.equal(parsed.rows.length, 1);
    const row = parsed.rows[0]!;
    assert.equal(row.line, 0, "la fila fusionada lleva línea 0");
    assert.equal(row.gross.toFixed(2), "1500.00");
    assert.equal(row.employerSs.toFixed(2), "450.00");
    assert.equal(row.totalCost.toFixed(2), "1950.00");
    assert.equal(row.reportedTotalCost?.toFixed(2), "1950.00");
    assert.equal(row.headcount.toFixed(2), "1.50");
    assert.ok(parsed.warnings.some((w) => w.startsWith("filas 2 y 3 fusionadas")), parsed.warnings.join(" | "));
  });

  it("coste_total ≠ bruto + SS → AVISO (nunca error) y se contabiliza bruto + SS", () => {
    const parsed = parsePayrollCostContent({ format: "csv", content: csv(HEADER, "HD;2026-04;extras;4 CAF/REST;1.200,00;379,67;1.047,75;1") });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows[0]?.totalCost.toFixed(2), "1579.67");
    assert.equal(parsed.rows[0]?.reportedTotalCost?.toFixed(2), "1047.75");
    assert.ok(parsed.warnings.includes("línea 2: coste_total 1047.75 ≠ bruto + SS 1579.67; se contabiliza bruto + SS"), parsed.warnings.join(" | "));
    const exact = parsePayrollCostContent({ format: "csv", content: csv(HEADER, "HD;2026-04;extras;4 CAF/REST;1.200,00;379,67;1579,68;1") });
    assert.deepEqual(exact.warnings, [], "una diferencia de 0,01 no avisa");
    const missing = parsePayrollCostContent({ format: "csv", content: csv(HEADER, "HD;2026-04;extras;4 CAF/REST;1.200,00;379,67;;1") });
    assert.equal(missing.rows[0]?.reportedTotalCost, null);
  });

  it("las columnas opcionales alimentan las referencias por (centro, mes) y la columna usali fija el departamento", () => {
    const parsed = parsePayrollCostContent({
      format: "csv",
      content: csv(HEADER_FULL, "HOTEL DEMO;2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3;42.000,00;40;rooms", "HOTEL DEMO;2026-02;operaciones;5 COCINA;5.000,00;1.500,00;6.500,00;2;42.000,00;40;fnb", "OFICINA DEMO;02/2026;estructura;ADMINISTRACION;3.500,00;1.050,00;4.550,00;2;;;admin_general")
    });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.rows[0]?.usaliDepartmentHint, "rooms");
    assert.equal(parsed.rows[2]?.usaliDepartmentHint, "admin_general");
    assert.equal(parsed.references.length, 1, "la oficina no trae referencia");
    assert.equal(parsed.references[0]?.workCenterLabel, "HOTEL DEMO");
    assert.equal(parsed.references[0]?.netSalesReported?.toFixed(2), "42000.00");
    assert.equal(parsed.references[0]?.roomsAvailableReported, 40);
    assert.equal(parsed.references[0]?.employeesReported, null);
    const conflicting = parsePayrollCostContent({ format: "csv", content: csv(HEADER_FULL, "HD;2026-02;operaciones;6 PISOS;1;1;;1;100;10;rooms", "HD;2026-02;operaciones;5 COCINA;1;1;;1;200;10;fnb") });
    assert.ok(conflicting.warnings.some((w) => /ventas_sin_iva 200.00 distinta/.test(w)));
    assert.equal(conflicting.references[0]?.netSalesReported?.toFixed(2), "100.00", "se conserva la primera");
  });

  it("separador «,» cuando no hay «;»", () => {
    const parsed = parsePayrollCostContent({ format: "csv", content: csv(HEADER.replace(/;/g, ","), 'HD,2026-01,operaciones,6 PISOS,"1,000.50",300,,1') });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows[0]?.gross.toFixed(2), "1000.50");
  });
});

describe("parsePayrollCostContent · JSON", () => {
  const informe = {
    fuente: "Informe RRHH (agregado sintético)",
    organizationId: "org_demo",
    periodo: { desde: "2026-02", hasta: "2026-02" },
    mapping: { centros: { "HOTEL DEMO": "HD", "OFICINA DEMO": "OC" }, grupos: { "mant-obra": "mantenimiento_obra", "raro": "no_existe" } },
    lineas: [
      { centro: "Hotel Demo", centroCode: "HD", mes: "2026-02", grupo: "operaciones", departamento: "3 RECEPCIO", usaliDepartment: "rooms", salarioBruto: 6000, costeSs: 1800, costeTotal: 7800, empleados: 3 },
      { centro: "Hotel Demo", centroCode: "HD", mes: "2026-02", grupo: "operaciones", departamento: "5 COCINA", usaliDepartment: "fnb", salarioBruto: "5000.00", costeSs: "1500.00", costeTotal: "6500.00", empleados: 2 },
      { centro: "Oficina Demo", centroCode: "OC", mes: "2026-02", grupo: "mant-obra", departamento: "7 MANTENIM", usaliDepartment: "pom", salarioBruto: 3500, costeSs: 1050, costeTotal: 4000, empleados: 2 }
    ],
    referencia: [{ centroCode: "HD", mes: "2026-02", empleadosInforme: 9, habitacionesDisponibles: 40, ventasSinIva: 42000 }]
  };

  it("el JSON del informe → filas sintéticas + referencia + hints + organizationId + fuente informe_rrhh", () => {
    const parsed = parsePayrollCostContent({ format: "json", content: JSON.stringify(informe) });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.source, "informe_rrhh");
    assert.equal(parsed.sourceOrganizationId, "org_demo");
    assert.equal(parsed.rows.length, 3);
    assert.deepEqual(parsed.rows.map((r) => r.line), [1, 2, 3]);
    assert.equal(parsed.rows[0]?.workCenterLabel, "HOTEL DEMO");
    assert.equal(parsed.rows[0]?.centreCodeHint, "HD");
    assert.equal(parsed.rows[0]?.usaliDepartmentHint, "rooms");
    assert.equal(parsed.rows[2]?.costGroup, "MANT-OBRA");
    assert.equal(parsed.rows[2]?.reportedTotalCost?.toFixed(2), "4000.00");
    assert.equal(parsed.rows[2]?.totalCost.toFixed(2), "4550.00");
    assert.ok(parsed.warnings.includes("línea 3: coste_total 4000.00 ≠ bruto + SS 4550.00; se contabiliza bruto + SS"));
    assert.ok(parsed.warnings.some((w) => w.includes("mapping.grupos: «raro»")));
    assert.deepEqual(parsed.hints.centreCodes, { "HOTEL DEMO": "HD", "OFICINA DEMO": "OC" });
    assert.deepEqual(parsed.hints.groups, { "MANT-OBRA": "mantenimiento_obra" });
    assert.equal(parsed.references.length, 1);
    assert.equal(parsed.references[0]?.centreCodeHint, "HD");
    assert.equal(parsed.references[0]?.workCenterLabel, "HOTEL DEMO", "un solo centro por código → etiqueta resuelta");
    assert.equal(parsed.references[0]?.employeesReported?.toFixed(2), "9.00");
    assert.equal(parsed.references[0]?.roomsAvailableReported, 40);
    assert.equal(parsed.references[0]?.netSalesReported?.toFixed(2), "42000.00");
  });

  it("{ rows: PayrollCostRowDto[] } también se acepta y JSON inválido → error sin línea", () => {
    const parsed = parsePayrollCostContent({ format: "json", content: JSON.stringify({ rows: [{ workCenterLabel: "Hotel Demo", workCenterCode: "HD", periodCode: "02/2026", costGroup: "operaciones", departmentLabel: "6 PISOS", usaliDepartment: "rooms", gross: "1000.00", employerSs: "300.00", headcount: "1.00", netSalesReported: "500.00", roomsAvailableReported: 10, employeesReported: "4.00" }] }) });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.source, "json");
    assert.equal(parsed.rows[0]?.periodCode, "2026-02");
    assert.equal(parsed.rows[0]?.reportedTotalCost, null);
    assert.equal(parsed.references[0]?.employeesReported?.toFixed(2), "4.00");
    const bad = parsePayrollCostContent({ format: "json", content: "{ nope" });
    assert.equal(bad.errors.length, 1);
    assert.equal(bad.errors[0]?.line, null);
    const neither = parsePayrollCostContent({ format: "json", content: "{}" });
    assert.match(neither.errors[0]!.message, /«lineas».*«rows»/);
    const negative = parsePayrollCostContent({ format: "json", content: JSON.stringify({ lineas: [{ centro: "X", mes: "2026-01", grupo: "operaciones", departamento: "6 PISOS", salarioBruto: -1, costeSs: 0, empleados: 1 }] }) });
    assert.equal(negative.errors[0]?.line, 1);
    assert.match(negative.errors[0]!.message, /salarioBruto negativo/);
  });

  it("el hash es el mismo para un CSV y un JSON equivalentes, e independiente de espacios, BOM y orden", () => {
    const csvContent = csv(HEADER_FULL, "HOTEL DEMO;2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3;42.000,00;40;rooms", "Hotel   Demo ;02/2026;operaciones;5 COCINA;5000.00;1500.00;6500.00;2;42000;40;fnb");
    const jsonContent = JSON.stringify({
      rows: [
        { workCenterLabel: "hotel demo", periodCode: "2026-02", costGroup: "OPERACIONES", departmentLabel: "5 cocina", usaliDepartment: "fnb", gross: 5000, employerSs: 1500, reportedTotalCost: 6500, headcount: 2, netSalesReported: 42000, roomsAvailableReported: 40 },
        { workCenterLabel: "HOTEL DEMO", periodCode: "02/2026", costGroup: "operaciones", departmentLabel: "3 RECEPCIO", usaliDepartment: "rooms", gross: "6000", employerSs: "1800", reportedTotalCost: "7800", headcount: "3" }
      ]
    });
    const a = payrollCostContentHash(parsePayrollCostContent({ format: "csv", content: csvContent }));
    const b = payrollCostContentHash(parsePayrollCostContent({ format: "csv", content: "\uFEFF" + csvContent.replace(/\r\n/g, "\n") }));
    const c = payrollCostContentHash(parsePayrollCostContent({ format: "json", content: jsonContent }));
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b);
    assert.equal(a, c);
    const d = payrollCostContentHash(parsePayrollCostContent({ format: "csv", content: csvContent.replace("6.000,00", "6.000,01") }));
    assert.notEqual(a, d);
  });
});

describe("aggregateRows", () => {
  it("fusiona por (centro, mes, grupo, departamento) y conserva el orden de primera aparición", () => {
    const base = { centreCodeHint: null, usaliDepartmentHint: null, reportedTotalCost: null, netSalesReported: null, roomsAvailableReported: null };
    const D = (v: string) => parseAmount(v);
    const rows: NormalizedRow[] = [
      { ...base, line: 2, workCenterLabel: "A", periodCode: "2026-01", costGroup: "OPERACIONES", departmentLabel: "X", gross: D("10"), employerSs: D("1"), totalCost: D("11"), headcount: D("1") },
      { ...base, line: 3, workCenterLabel: "B", periodCode: "2026-01", costGroup: "OPERACIONES", departmentLabel: "X", gross: D("20"), employerSs: D("2"), totalCost: D("22"), headcount: D("1") },
      { ...base, line: 4, workCenterLabel: "A", periodCode: "2026-01", costGroup: "OPERACIONES", departmentLabel: "X", gross: D("5"), employerSs: D("0.5"), totalCost: D("5.5"), headcount: D("0.5") }
    ];
    const warnings: string[] = [];
    const merged = aggregateRows(rows, warnings);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.workCenterLabel, "A");
    assert.equal(merged[0]?.totalCost.toFixed(2), "16.50");
    assert.equal(merged[0]?.reportedTotalCost, null);
    assert.equal(merged[1]?.line, 3);
    assert.deepEqual(warnings, ["filas 2 y 4 fusionadas (misma clave A · 2026-01 · OPERACIONES · X)"]);
  });
});

describe("DEFAULT_DEPARTMENT_MAP · las 14 etiquetas del informe", () => {
  it("resuelve cada etiqueta del informe de RRHH a su departamento USALI", () => {
    const expected: Array<[string, string | null]> = [
      ["3 RECEPCIO", "rooms"],
      ["RECEPCIÓN", "rooms"],
      ["6 PISOS", "rooms"],
      ["SIN DEPARTAMENTO", "rooms"],
      ["4 CAF/REST", "fnb"],
      ["RESTAURANTE", "fnb"],
      ["5 COCINA", "fnb"],
      ["7 MANTENIM", "pom"],
      ["MANTENIMIENTO", "pom"],
      ["1 DIRECCIO", "admin_general"],
      ["DIRECCION", "admin_general"],
      ["ADMINISTRACION", "admin_general"],
      ["PROPIEDAD", "admin_general"],
      ["COMERCIAL", "sales_marketing"]
    ];
    assert.equal(expected.length, 14);
    for (const [label, department] of expected) assert.equal(defaultDepartmentFor(label), department, label);
    assert.equal(defaultDepartmentFor("SPA"), null);
    assert.equal(defaultDepartmentFor("2 ADMINISTRACIÓN"), "admin_general", "prefijo numérico y acento");
    assert.equal(DEFAULT_DEPARTMENT_MAP.length, 11);
  });
});

describe("applyPayrollCostMapping", () => {
  it("personal de una oficina enrutado a rooms / fnb → aviso por (centro, departamento), sin alterar el dato (contable-6C-06)", () => {
    const parsed = parsePayrollCostContent({
      format: "csv",
      content: csv(HEADER_FULL, "OFICINA CENTRAL;2026-01;estructura;RECEPCION;1000,00;300,00;;1;;;rooms", "OFICINA CENTRAL;2026-02;estructura;RECEPCION;1000,00;300,00;;1;;;rooms", "OFICINA CENTRAL;2026-01;estructura;ADMINISTRACION;1000,00;300,00;;1;;;", "HOTEL DEMO;2026-01;operaciones;3 RECEPCIO;1000,00;300,00;;1;;;")
    });
    const plan = applyPayrollCostMapping(parsed, { properties: PROPERTIES });
    assert.equal(plan.complete, true);
    assert.equal(plan.rows.find((r) => r.workCenterLabel === "OFICINA CENTRAL" && r.departmentLabel === "RECEPCION")?.usaliDepartment, "rooms", "el dato explícito se respeta");
    const office = plan.warnings.filter((w) => /es una oficina/.test(w));
    assert.equal(office.length, 1, "un aviso por (centro, departamento), no por mes");
    assert.match(office[0]!, /centro «OFICINA CENTRAL» es una oficina y su departamento «RECEPCION» va al departamento USALI operativo rooms/);
    assert.doesNotMatch(plan.warnings.join("\n"), /HOTEL DEMO/, "un hotel con recepción en rooms es lo normal");
  });

  it("prioridad de centros: mapping.centres → centroCode ≡ Property.code → etiqueta ≡ code / name / tradeName → sin mapear con sugerencias", () => {
    const parsed = parsePayrollCostContent({
      format: "json",
      content: JSON.stringify({
        lineas: [
          { centro: "Sede", centroCode: "ZZ", mes: "2026-01", grupo: "estructura", departamento: "ADMINISTRACION", salarioBruto: 100, costeSs: 30, empleados: 1 },
          { centro: "Playa", centroCode: "HB", mes: "2026-01", grupo: "operaciones", departamento: "6 PISOS", salarioBruto: 100, costeSs: 30, empleados: 1 },
          { centro: "hotel demo", mes: "2026-01", grupo: "operaciones", departamento: "6 PISOS", salarioBruto: 100, costeSs: 30, empleados: 1 },
          { centro: "OC", mes: "2026-01", grupo: "estructura", departamento: "DIRECCION", salarioBruto: 100, costeSs: 30, empleados: 1 },
          { centro: "Casa Rural", mes: "2026-01", grupo: "operaciones", departamento: "6 PISOS", salarioBruto: 100, costeSs: 30, empleados: 1 },
          { centro: "Desconocido", mes: "2026-01", grupo: "operaciones", departamento: "6 PISOS", salarioBruto: 100, costeSs: 30, empleados: 1 }
        ]
      })
    });
    const plan = applyPayrollCostMapping(parsed, { mapping: { centres: { sede: "prop_oc" } }, properties: PROPERTIES });
    const centreOf = (label: string) => plan.rows.find((r) => r.workCenterLabel === label)?.propertyId;
    assert.equal(centreOf("SEDE"), "prop_oc", "mapping explícito gana al centroCode");
    assert.equal(centreOf("PLAYA"), "prop_hb", "centroCode ≡ Property.code");
    assert.equal(centreOf("HOTEL DEMO"), "prop_hd", "etiqueta ≡ name");
    assert.equal(centreOf("OC"), "prop_oc", "etiqueta ≡ code");
    assert.equal(centreOf("CASA RURAL"), null);
    assert.equal(centreOf("DESCONOCIDO"), null);
    assert.deepEqual(plan.unmappedCentres.map((c) => [c.label, c.rows]), [["CASA RURAL", 1], ["DESCONOCIDO", 1]]);
    assert.deepEqual(plan.unmappedCentres[0]?.suggestions.map((s) => s.propertyId), ["prop_hb"], "«CASA RURAL» ⊂ tradeName «Casa Rural Bahía»");
    assert.deepEqual(plan.unmappedCentres[1]?.suggestions, []);
    assert.equal(plan.complete, false);
    assert.deepEqual(plan.mapping.centres, { SEDE: "prop_oc", PLAYA: "prop_hb", "HOTEL DEMO": "prop_hd", OC: "prop_oc" });
    assert.equal(plan.cells.length, 3, "solo las filas completamente mapeadas forman celdas");
    assert.deepEqual(plan.propertyIds, ["prop_oc", "prop_hb", "prop_hd"]);
    assert.equal(plan.periodFrom, "2026-01");
    assert.equal(plan.periodTo, "2026-01");
  });

  it("prioridad de departamentos: mapping.departments → columna usali → diccionario → sin mapear; no admitido → USALI_LINE_NOT_ADMITTED", () => {
    const parsed = parsePayrollCostContent({
      format: "csv",
      content: csv(HEADER_FULL, "HD;2026-01;operaciones;6 PISOS;100;30;;1;;;fnb", "HD;2026-01;operaciones;SPA;100;30;;1;;;", "HD;2026-01;operaciones;3 RECEPCIO;100;30;;1;;;", "HD;2026-01;operaciones;ENERGIA;100;30;;1;;;utilities", "HD;2026-01;operaciones;EVENTOS;100;30;;1;;;", "HD;2026-01;operaciones;LIMPIEZA;100;30;;1;;;desconocido")
    });
    const plan = applyPayrollCostMapping(parsed, { mapping: { departments: { "6 pisos": "rooms", eventos: "other_operated" } }, properties: PROPERTIES });
    const dept = (label: string) => plan.rows.find((r) => r.departmentLabel === label)?.usaliDepartment;
    assert.equal(dept("6 PISOS"), "rooms", "mapping explícito gana a la columna usali");
    assert.equal(dept("SPA"), null);
    assert.equal(dept("3 RECEPCIO"), "rooms", "diccionario");
    assert.equal(dept("EVENTOS"), "other_operated");
    assert.equal(dept("ENERGIA"), null);
    assert.equal(dept("LIMPIEZA"), null);
    assert.deepEqual(plan.unmappedDepartments.map((d) => d.label), ["LIMPIEZA", "SPA"]);
    assert.deepEqual(plan.notAdmitted, [{ department: "utilities", labels: ["ENERGIA"] }]);
    assert.ok(plan.warnings.some((w) => w.includes("«LIMPIEZA»: «desconocido» no es un departamento USALI")));
    assert.equal(plan.complete, false);
    assert.deepEqual(plan.mapping.departments, { "6 PISOS": "rooms", "3 RECEPCIO": "rooms", EVENTOS: "other_operated" });
  });

  it("prioridad de grupos: mapping.groups → mapping.grupos del JSON → canónico → sin mapear; etiquetas del mismo canónico se fusionan", () => {
    const parsed = parsePayrollCostContent({
      format: "json",
      content: JSON.stringify({
        mapping: { grupos: { "mant-obra": "mantenimiento_obra" } },
        lineas: [
          { centro: "HD", mes: "2026-01", grupo: "mant-obra", departamento: "7 MANTENIM", salarioBruto: 100, costeSs: 30, empleados: 1 },
          { centro: "HD", mes: "2026-01", grupo: "Mantenimiento obra", departamento: "7 MANTENIM", salarioBruto: 50, costeSs: 15, empleados: 1 },
          { centro: "HD", mes: "2026-01", grupo: "refuerzos", departamento: "6 PISOS", salarioBruto: 10, costeSs: 3, empleados: 1 },
          { centro: "HD", mes: "2026-01", grupo: "inventado", departamento: "6 PISOS", salarioBruto: 10, costeSs: 3, empleados: 1 }
        ]
      })
    });
    const plan = applyPayrollCostMapping(parsed, { mapping: { groups: { refuerzos: "extras" } }, properties: PROPERTIES });
    const maintenance = plan.rows.filter((r) => r.costGroup === "mantenimiento_obra");
    assert.equal(maintenance.length, 1, "las dos etiquetas del mismo canónico se fusionan (clave única de la línea)");
    assert.equal(maintenance[0]?.totalCost.toFixed(2), "195.00");
    assert.equal(maintenance[0]?.line, 0);
    assert.ok(plan.warnings.some((w) => w.startsWith("filas 1 y 2 fusionadas (mismo grupo canónico mantenimiento_obra")));
    assert.equal(plan.rows.find((r) => r.costGroupLabel === "REFUERZOS")?.costGroup, "extras");
    assert.deepEqual(plan.unmappedGroups.map((g) => g.label), ["INVENTADO"]);
    assert.deepEqual(plan.mapping.groups, { "MANT-OBRA": "mantenimiento_obra", "MANTENIMIENTO OBRA": "mantenimiento_obra", REFUERZOS: "extras" });
  });

  it("plan completo: celdas (centro, mes) con parejas por departamento, referencias por centro y varias etiquetas del mismo centro sumadas", () => {
    const parsed = parsePayrollCostContent({
      format: "csv",
      content: csv(
        HEADER_FULL,
        "HOTEL DEMO;2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3;42.000,00;40;",
        "HOTEL DEMO;2026-02;operaciones;6 PISOS;4.000,00;1.200,00;5.200,00;4;42.000,00;40;",
        "HOTEL DEMO;2026-02;extras;5 COCINA;5.000,00;1.500,00;6.500,00;2;42.000,00;40;",
        "OFICINA ASTURIAS;2026-02;estructura;ADMINISTRACION;3.500,00;1.050,00;4.550,00;2;1.000,00;;",
        "OFICINA MADRID;2026-02;estructura;DIRECCION;1.000,00;300,00;1.300,00;1;500,00;;"
      )
    });
    const plan = applyPayrollCostMapping(parsed, { mapping: { centres: { "OFICINA ASTURIAS": "prop_oc", "OFICINA MADRID": "prop_oc" } }, properties: PROPERTIES });
    assert.equal(plan.complete, true);
    assert.equal(plan.cells.length, 2);
    const hotel = plan.cells.find((c) => c.propertyId === "prop_hd")!;
    assert.deepEqual(hotel.departments.map((d) => [d.usaliDepartment, d.gross.toFixed(2), d.employerSs.toFixed(2)]), [["fnb", "5000.00", "1500.00"], ["rooms", "10000.00", "3000.00"]]);
    const office = plan.cells.find((c) => c.propertyId === "prop_oc")!;
    assert.deepEqual(office.workCenterLabels, ["OFICINA ASTURIAS", "OFICINA MADRID"]);
    assert.deepEqual(office.departments.map((d) => [d.usaliDepartment, d.gross.toFixed(2)]), [["admin_general", "4500.00"]]);
    assert.equal(plan.references.length, 2);
    const officeRef = plan.references.find((r) => r.propertyId === "prop_oc")!;
    assert.equal(officeRef.netSalesReported?.toFixed(2), "1500.00", "las referencias de dos etiquetas del mismo centro se suman");
    assert.equal(officeRef.workCenterLabel, null);
    assert.ok(plan.warnings.some((w) => w.startsWith("referencias de OFICINA ASTURIAS + OFICINA MADRID sumadas")));
    const hotelRef = plan.references.find((r) => r.propertyId === "prop_hd")!;
    assert.equal(hotelRef.roomsAvailableReported, 40);
    assert.equal(hotelRef.netSalesReported?.toFixed(2), "42000.00");
  });

  it("suggestCentres puntúa inclusión de texto por encima de tokens comunes y omite palabras vacías", () => {
    const suggestions = suggestCentres("HOTEL BAHIA", PROPERTIES);
    assert.deepEqual(suggestions.map((s) => s.propertyId), ["prop_hb"], "«hotel» es palabra vacía; «bahia» coincide sin acento");
    assert.deepEqual(suggestCentres("HOTEL", PROPERTIES), []);
    assert.deepEqual(suggestCentres("", PROPERTIES), []);
  });
});
