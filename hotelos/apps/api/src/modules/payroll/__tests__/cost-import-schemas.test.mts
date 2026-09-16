// Unit tests · Tanda 6c · L3 — esquemas zod de las rutas del coste de personal
// importado (schemas/payroll-cost.schemas.ts). Sin base de datos; cifras
// sintéticas. Desde apps/api:
//   node --import tsx --test src/modules/payroll/__tests__/cost-import-schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAYROLL_COST_GROUPS, PAYROLL_COST_IMPORT_MAX_CONTENT, PAYROLL_COST_REPORT_MAX_MONTHS } from "@hotelos/shared";
import {
  CreatePayrollCostImportSchema,
  PERIOD_CODE,
  PayrollCostImportListQuerySchema,
  PayrollCostMappingSchema,
  PayrollCostReportQuerySchema,
  PostPayrollCostImportSchema,
  PreviewPayrollCostImportSchema,
  ReversePayrollCostImportSchema,
  USALI_DEPARTMENT_KEYS,
  monthsInRange
} from "../../../schemas/payroll-cost.schemas.js";

type Issue = { path: PropertyKey[]; message: string; code?: string; keys?: string[] };
type ParseResult = { success: boolean; error?: { issues: Issue[] } };

/**
 * "ruta: mensaje"; una clave desconocida (`unrecognized_keys`) lleva la clave en
 * `issue.keys` con ruta vacía, así que se presenta como "clave: mensaje" (en HTTP,
 * parseOr400 la reescribe con zodErrorMapEs: «clave no admitida: 'x'»).
 */
function messagesOf(result: ParseResult): string[] {
  if (result.success) return [];
  return (result.error?.issues ?? []).map((issue) => `${issue.code === "unrecognized_keys" ? (issue.keys ?? []).join(",") : issue.path.join(".")}: ${issue.message}`);
}

const CSV = "centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados\nHOTEL DEMO;2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3\n";
const PREVIEW = { format: "csv", content: CSV };

describe("PreviewPayrollCostImportSchema", () => {
  it("acepta el cuerpo mínimo, el mapeo completo y replace", () => {
    const parsed = PreviewPayrollCostImportSchema.parse(PREVIEW);
    assert.equal(parsed.format, "csv");
    assert.equal(parsed.content, CSV);
    assert.equal(parsed.mapping, undefined);
    const withMapping = PreviewPayrollCostImportSchema.parse({
      ...PREVIEW,
      organizationId: " org_demo ",
      replace: true,
      mapping: { centres: { "CASA RURAL": "prop_hb" }, departments: { "4 CAF/REST": "fnb", PROPIEDAD: "admin_general" }, groups: { "mant-obra": "mantenimiento_obra" } }
    });
    assert.equal(withMapping.organizationId, "org_demo", "los ids se recortan");
    assert.equal(withMapping.replace, true);
    assert.deepEqual(withMapping.mapping?.centres, { "CASA RURAL": "prop_hb" });
    assert.deepEqual(withMapping.mapping?.groups, { "mant-obra": "mantenimiento_obra" });
  });

  it("clave desconocida → issue con el nombre de la clave y mensaje en español", () => {
    const result = PreviewPayrollCostImportSchema.safeParse({ ...PREVIEW, fichero: "x" });
    assert.equal(result.success, false);
    const issue = result.success ? undefined : result.error.issues.find((i) => i.code === "unrecognized_keys");
    assert.ok(issue, "issue unrecognized_keys");
    assert.deepEqual((issue as { keys?: string[] }).keys, ["fichero"], "la issue nombra la clave");
    assert.equal(issue.message, "Campo no admitido en el cuerpo de la petición.");
    const messages = messagesOf(result);
    assert.ok(messages.some((m) => m === "fichero: Campo no admitido en el cuerpo de la petición."), messages.join(" | "));
    const nested = PayrollCostMappingSchema.safeParse({ centros: {} });
    assert.ok(messagesOf(nested).some((m) => m.startsWith("centros: Campo no admitido")), messagesOf(nested).join(" | "));
  });

  it("formato inválido, content vacío o demasiado largo, replace no booleano", () => {
    assert.match(messagesOf(PreviewPayrollCostImportSchema.safeParse({ ...PREVIEW, format: "xlsx" })).join(), /format debe ser uno de: csv, json\./);
    assert.match(messagesOf(PreviewPayrollCostImportSchema.safeParse({ format: "csv" })).join(), /content es obligatorio/);
    assert.match(messagesOf(PreviewPayrollCostImportSchema.safeParse({ format: "csv", content: "" })).join(), /content no puede estar vacío/);
    assert.match(messagesOf(PreviewPayrollCostImportSchema.safeParse({ format: "csv", content: "x".repeat(PAYROLL_COST_IMPORT_MAX_CONTENT + 1) })).join(), /content no puede superar/);
    assert.match(messagesOf(PreviewPayrollCostImportSchema.safeParse({ ...PREVIEW, replace: "sí" })).join(), /replace debe ser true o false/);
  });

  it("mapeo: departamentos contra el catálogo USALI (no solo los que admiten labor) y grupos contra los cinco canónicos", () => {
    assert.ok(USALI_DEPARTMENT_KEYS.includes("utilities"), "el catálogo incluye departamentos sin línea labor (el servicio responde USALI_LINE_NOT_ADMITTED)");
    assert.ok(PayrollCostMappingSchema.safeParse({ departments: { X: "utilities" } }).success);
    assert.match(messagesOf(PayrollCostMappingSchema.safeParse({ departments: { X: "habitaciones" } })).join(), /departments: cada valor debe ser un departamento USALI/);
    assert.match(messagesOf(PayrollCostMappingSchema.safeParse({ groups: { X: "obra" } })).join(), /groups: cada valor debe ser un grupo de coste \(operaciones, extras, estructura, mantenimiento_obra, familia\)/);
    assert.match(messagesOf(PayrollCostMappingSchema.safeParse({ centres: { X: "" } })).join(), /centres: el id del centro no puede estar vacío/);
    assert.match(messagesOf(PayrollCostMappingSchema.safeParse({ centres: "RA" })).join(), /centres debe ser un objeto/);
    assert.equal(PAYROLL_COST_GROUPS.length, 5);
  });
});

describe("CreatePayrollCostImportSchema", () => {
  it("hereda la previsualización, post por defecto true, recorta fileName y notes", () => {
    const parsed = CreatePayrollCostImportSchema.parse({ ...PREVIEW, fileName: " coste-2026.csv ", notes: " lote de prueba " });
    assert.equal(parsed.post, true);
    assert.equal(parsed.fileName, "coste-2026.csv");
    assert.equal(parsed.notes, "lote de prueba");
    assert.equal(CreatePayrollCostImportSchema.parse({ ...PREVIEW, post: false, source: "informe_rrhh" }).post, false);
  });

  it("replace: true con post: false → 400 en replace (contable-6C-01: un borrador no sustituye lotes contabilizados)", () => {
    const result = CreatePayrollCostImportSchema.safeParse({ ...PREVIEW, replace: true, post: false });
    assert.equal(result.success, false);
    assert.match(messagesOf(result).join(), /^replace: replace exige post: true/);
    assert.equal(CreatePayrollCostImportSchema.safeParse({ ...PREVIEW, replace: true }).success, true, "replace con post por defecto (true) sigue admitido");
    assert.equal(CreatePayrollCostImportSchema.safeParse({ ...PREVIEW, replace: false, post: false }).success, true);
  });

  it("fileName > 200, notes > 2000, source desconocido y clave extra → 400 con nombre", () => {
    assert.match(messagesOf(CreatePayrollCostImportSchema.safeParse({ ...PREVIEW, fileName: "f".repeat(201) })).join(), /fileName no puede superar 200 caracteres/);
    assert.match(messagesOf(CreatePayrollCostImportSchema.safeParse({ ...PREVIEW, notes: "n".repeat(2001) })).join(), /notes no puede superar 2000 caracteres/);
    assert.match(messagesOf(CreatePayrollCostImportSchema.safeParse({ ...PREVIEW, source: "excel" })).join(), /source debe ser uno de: csv, json, informe_rrhh\./);
    assert.match(messagesOf(CreatePayrollCostImportSchema.safeParse({ ...PREVIEW, contabilizar: true })).join(), /^contabilizar: Campo no admitido/);
  });
});

describe("PostPayrollCostImportSchema · ReversePayrollCostImportSchema", () => {
  it("post: cuerpo vacío válido, replace opcional, clave extra rechazada", () => {
    assert.deepEqual(PostPayrollCostImportSchema.parse({}), {});
    assert.equal(PostPayrollCostImportSchema.parse({ replace: true }).replace, true);
    assert.match(messagesOf(PostPayrollCostImportSchema.safeParse({ reason: "x" })).join(), /^reason: Campo no admitido/);
  });

  it("reverse: reason 3..500 obligatorio, entryDate YYYY-MM-DD válida", () => {
    assert.deepEqual(ReversePayrollCostImportSchema.parse({ reason: "  Fichero corregido por RRHH " }), { reason: "Fichero corregido por RRHH" });
    assert.equal(ReversePayrollCostImportSchema.parse({ reason: "abc", entryDate: "2026-09-30" }).entryDate, "2026-09-30");
    assert.match(messagesOf(ReversePayrollCostImportSchema.safeParse({})).join(), /reason es obligatorio/);
    assert.match(messagesOf(ReversePayrollCostImportSchema.safeParse({ reason: "ab" })).join(), /reason debe tener al menos 3 caracteres/);
    assert.match(messagesOf(ReversePayrollCostImportSchema.safeParse({ reason: "r".repeat(501) })).join(), /reason no puede superar 500 caracteres/);
    assert.match(messagesOf(ReversePayrollCostImportSchema.safeParse({ reason: "abc", entryDate: "30/09/2026" })).join(), /entryDate debe ser una fecha YYYY-MM-DD/);
    assert.match(messagesOf(ReversePayrollCostImportSchema.safeParse({ reason: "abc", entryDate: "2026-13-40" })).join(), /entryDate no es una fecha válida/);
    assert.match(messagesOf(ReversePayrollCostImportSchema.safeParse({ reason: "abc", motivo: "x" })).join(), /^motivo: Campo no admitido/);
  });
});

describe("PayrollCostImportListQuerySchema", () => {
  it("query strings: limit se convierte a entero 1..200, status y meses validados, to ≥ from", () => {
    const parsed = PayrollCostImportListQuerySchema.parse({ status: "posted", from: "2026-01", to: "2026-08", limit: "50" });
    assert.equal(parsed.limit, 50);
    assert.equal(parsed.status, "posted");
    assert.deepEqual(PayrollCostImportListQuerySchema.parse({}), {});
    assert.match(messagesOf(PayrollCostImportListQuerySchema.safeParse({ limit: "0" })).join(), /limit debe ser un entero entre 1 y 200/);
    assert.match(messagesOf(PayrollCostImportListQuerySchema.safeParse({ limit: "201" })).join(), /limit debe ser un entero entre 1 y 200/);
    assert.match(messagesOf(PayrollCostImportListQuerySchema.safeParse({ limit: "abc" })).join(), /limit debe ser un entero entre 1 y 200/);
    assert.match(messagesOf(PayrollCostImportListQuerySchema.safeParse({ status: "pending" })).join(), /status debe ser uno de: draft, posted, reversed\./);
    assert.match(messagesOf(PayrollCostImportListQuerySchema.safeParse({ from: "2026-13" })).join(), /from debe ser un mes YYYY-MM/);
    assert.match(messagesOf(PayrollCostImportListQuerySchema.safeParse({ from: "2026-08", to: "2026-01" })).join(), /to debe ser igual o posterior a from/);
    assert.match(messagesOf(PayrollCostImportListQuerySchema.safeParse({ page: "2" })).join(), /^page: Campo no admitido/);
  });
});

describe("PayrollCostReportQuerySchema", () => {
  it("from y to obligatorios (YYYY-MM), propertyId y group opcionales", () => {
    const parsed = PayrollCostReportQuerySchema.parse({ from: "2026-01", to: "2026-08", propertyId: "prop_ra", group: "operaciones" });
    assert.deepEqual(parsed, { from: "2026-01", to: "2026-08", propertyId: "prop_ra", group: "operaciones" });
    assert.match(messagesOf(PayrollCostReportQuerySchema.safeParse({ to: "2026-08" })).join(), /from es obligatorio/);
    assert.match(messagesOf(PayrollCostReportQuerySchema.safeParse({ from: "2026-1", to: "2026-08" })).join(), /from debe ser un mes YYYY-MM/);
    assert.match(messagesOf(PayrollCostReportQuerySchema.safeParse({ from: "2026-01", to: "2026-08", group: "todos" })).join(), /group debe ser uno de/);
    assert.match(messagesOf(PayrollCostReportQuerySchema.safeParse({ from: "2026-01", to: "2026-08", format: "csv" })).join(), /^format: Campo no admitido/);
  });

  it("to < from → 400; rango > 24 meses → 400 con el nº de meses; 24 justos pasa", () => {
    assert.match(messagesOf(PayrollCostReportQuerySchema.safeParse({ from: "2026-03", to: "2026-01" })).join(), /to debe ser igual o posterior a from/);
    assert.match(messagesOf(PayrollCostReportQuerySchema.safeParse({ from: "2024-01", to: "2026-01" })).join(), /El rango no puede superar 24 meses \(25 solicitados\)/);
    assert.ok(PayrollCostReportQuerySchema.safeParse({ from: "2024-02", to: "2026-01" }).success, "24 meses justos");
    assert.equal(PAYROLL_COST_REPORT_MAX_MONTHS, 24);
  });

  it("monthsInRange y PERIOD_CODE", () => {
    assert.equal(monthsInRange("2026-01", "2026-01"), 1);
    assert.equal(monthsInRange("2026-01", "2026-08"), 8);
    assert.equal(monthsInRange("2025-11", "2026-02"), 4);
    assert.equal(monthsInRange("2026-03", "2026-01"), -1);
    assert.ok(PERIOD_CODE.test("2026-12"));
    assert.ok(!PERIOD_CODE.test("2026-00"));
    assert.ok(!PERIOD_CODE.test("2026-13"));
    assert.ok(!PERIOD_CODE.test("26-01"));
  });
});
