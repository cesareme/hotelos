// Unit tests · Tanda RRHH · RRHH-6 — incidencias del mes para la gestoría
// (payroll/incidences.service.ts). Sin base de datos: fakes en memoria por `deps`;
// nombres y números INVENTADOS, ningún NIF entra al fake (la fila del expediente
// del servicio no lo selecciona). Desde apps/api:
//   node --import tsx --test src/modules/payroll/__tests__/incidences.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAYROLL_INCIDENCE_KINDS, PermissionDeniedError } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import {
  PAYROLL_INCIDENCES_AUDIT_ACTION,
  PAYROLL_INCIDENCES_CSV_HEADER,
  buildIncidenceRows,
  buildPayrollIncidences,
  incidencesFilename,
  overlapDays,
  parseIncidencePeriod,
  renderIncidencesCsv,
  type IncidenceAbsenceRow,
  type IncidenceContractRow,
  type IncidenceDeps,
  type IncidenceEmployeeRow,
  type IncidenceProfileRow,
  type IncidencePropertyRow
} from "../incidences.service.js";

const ORG = "org_inc_test";
const HA = "prop_inc_a";
const HB = "prop_inc_b";
const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const NIF_LIKE = /\b\d{8}[A-Z]\b/;

const properties: IncidencePropertyRow[] = [
  { id: HA, code: "HA", name: "Hotel A", organizationId: ORG },
  { id: HB, code: "HB", name: "Hotel B", organizationId: ORG }
];
const employees: IncidenceEmployeeRow[] = [
  // Alta en el mes, contrato temporal desde el mismo día.
  { id: "emp_1", organizationId: ORG, employeeNumber: "0001", firstName: "Alta", lastName: "Septiembre", primaryPropertyId: HA, status: "active", hiredAt: d("2026-09-07"), terminatedAt: null, terminationReason: null },
  // Baja en el mes (contratada hace años).
  { id: "emp_2", organizationId: ORG, employeeNumber: "0002", firstName: "Baja", lastName: "Renuncia", primaryPropertyId: HA, status: "inactive", hiredAt: d("2020-01-15"), terminatedAt: d("2026-09-20"), terminationReason: "resignation" },
  // Cambio de contrato en el mes (temporal → indefinido) con jornada parcial.
  { id: "emp_3", organizationId: ORG, employeeNumber: "0003", firstName: "Cambio", lastName: "Contrato", primaryPropertyId: HA, status: "active", hiredAt: d("2025-03-01"), terminatedAt: null, terminationReason: null },
  // Sin novedad en el mes salvo una ausencia aprobada que solapa (agosto-septiembre).
  { id: "emp_4", organizationId: ORG, employeeNumber: "0004", firstName: "Ausencia", lastName: "Solapada", primaryPropertyId: HA, status: "active", hiredAt: d("2024-06-01"), terminatedAt: null, terminationReason: null },
  // Otro centro: solo cuenta sin `propertyId` (sociedad).
  { id: "emp_5", organizationId: ORG, employeeNumber: "0005", firstName: "Otro", lastName: "Centro", primaryPropertyId: HB, status: "active", hiredAt: d("2026-09-15"), terminatedAt: null, terminationReason: null },
  // Fuera del mes: no aparece.
  { id: "emp_6", organizationId: ORG, employeeNumber: "0006", firstName: "Sin", lastName: "Novedad", primaryPropertyId: HA, status: "active", hiredAt: d("2026-08-31"), terminatedAt: null, terminationReason: null }
];
const profiles: IncidenceProfileRow[] = [
  { id: "sp_1", employeeId: "emp_1", propertyId: HA, employeeCode: "0001" },
  { id: "sp_2", employeeId: "emp_2", propertyId: HA, employeeCode: "0002" },
  { id: "sp_3", employeeId: "emp_3", propertyId: HA, employeeCode: "0003" },
  { id: "sp_4", employeeId: "emp_4", propertyId: HA, employeeCode: "0004" },
  { id: "sp_5", employeeId: "emp_5", propertyId: HB, employeeCode: "0005" },
  // Ficha sin expediente: su ausencia aprobada no se puede atribuir (aviso).
  { id: "sp_x", employeeId: null, propertyId: HA, employeeCode: "X-1" }
];
const contracts: IncidenceContractRow[] = [
  { id: "c_1", staffProfileId: "sp_1", propertyId: HA, contractType: "temporal", startDate: d("2026-09-07"), endDate: d("2026-12-31"), endReason: null, active: true, weeklyHours: "40.00", partTimePct: "100.00", fixedDiscontinuous: false },
  { id: "c_2", staffProfileId: "sp_2", propertyId: HA, contractType: "indefinido", startDate: d("2020-01-15"), endDate: d("2026-09-20"), endReason: "resignation", active: false, weeklyHours: null, partTimePct: null, fixedDiscontinuous: false },
  { id: "c_3a", staffProfileId: "sp_3", propertyId: HA, contractType: "temporal", startDate: d("2025-03-01"), endDate: d("2026-09-14"), endReason: "end_of_term", active: false, weeklyHours: "40.00", partTimePct: "100.00", fixedDiscontinuous: false },
  { id: "c_3b", staffProfileId: "sp_3", propertyId: HA, contractType: "indefinido", startDate: d("2026-09-15"), endDate: null, endReason: null, active: true, weeklyHours: "20.00", partTimePct: "50.00", fixedDiscontinuous: false },
  { id: "c_4", staffProfileId: "sp_4", propertyId: HA, contractType: "fijo_discontinuo", startDate: d("2024-06-01"), endDate: null, endReason: null, active: true, weeklyHours: "40.00", partTimePct: "100.00", fixedDiscontinuous: true },
  { id: "c_5", staffProfileId: "sp_5", propertyId: HB, contractType: "indefinido", startDate: d("2026-09-15"), endDate: null, endReason: null, active: true, weeklyHours: "40.00", partTimePct: "100.00", fixedDiscontinuous: false }
];
const absences: IncidenceAbsenceRow[] = [
  { id: "abs_1", propertyId: HA, staffProfileId: "sp_4", absenceType: "vacation", startDate: d("2026-08-28"), endDate: d("2026-09-03"), status: "approved" },
  { id: "abs_2", propertyId: HA, staffProfileId: "sp_4", absenceType: "it_common", startDate: d("2026-09-10"), endDate: d("2026-09-12"), status: "approved" },
  // Pendiente: no cuenta.
  { id: "abs_3", propertyId: HA, staffProfileId: "sp_3", absenceType: "permit_paid", startDate: d("2026-09-20"), endDate: d("2026-09-20"), status: "pending" },
  // Ficha sin expediente.
  { id: "abs_4", propertyId: HA, staffProfileId: "sp_x", absenceType: "vacation", startDate: d("2026-09-01"), endDate: d("2026-09-02"), status: "approved" }
];

function fakeDeps(): { deps: IncidenceDeps; audits: Array<Record<string, unknown>> } {
  const audits: Array<Record<string, unknown>> = [];
  const deps: IncidenceDeps = {
    db: {
      property: { findMany: async (args) => properties.filter((p) => p.organizationId === args.where.organizationId && (!args.where.id || p.id === args.where.id)) },
      employee: { findMany: async (args) => employees.filter((e) => e.organizationId === args.where.organizationId) },
      staffProfile: { findMany: async (args) => profiles.filter((p) => args.where.propertyId.in.includes(p.propertyId)) },
      employmentContract: { findMany: async (args) => contracts.filter((c) => args.where.staffProfileId.in.includes(c.staffProfileId)) },
      absenceRequest: {
        findMany: async (args) =>
          absences.filter((a) => args.where.propertyId.in.includes(a.propertyId) && a.status === args.where.status && a.startDate.getTime() <= args.where.startDate.lte.getTime() && a.endDate.getTime() >= args.where.endDate.gte.getTime())
      }
    },
    audit: (input) => {
      audits.push(input as unknown as Record<string, unknown>);
      return undefined as never;
    },
    now: () => d("2026-10-01")
  };
  return { deps, audits };
}

const exporter = { organizationId: ORG, propertyId: HA, userId: "usr_rrhh", fullName: "RRHH Test", deviceId: "inc-test", permissions: ["workforce.payroll_export", "payroll.read"], orgScope: true } as unknown as UserContext;
const hotelAOnly = { ...exporter, assignedPropertyIds: [HA], orgScope: false } as unknown as UserContext;
const nobody = { ...exporter, permissions: ["payroll.read"] } as unknown as UserContext;

async function expectStatus<T>(promise: Promise<T>, statusCode: number, code?: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const typed = error as { statusCode?: number; details?: { code?: string }; message?: string };
    assert.ok(error instanceof HttpError || error instanceof PermissionDeniedError, `expected a typed error, got ${String(error)}`);
    assert.equal(typed.statusCode, statusCode, typed.message);
    if (code) assert.equal(typed.details?.code, code);
    return;
  }
  assert.fail(`expected ${statusCode}`);
}

describe("incidences · utilidades puras", () => {
  it("parseIncidencePeriod: mes UTC completo; formato distinto de YYYY-MM → 400 VALIDATION_ERROR", async () => {
    const { start, end } = parseIncidencePeriod("2026-02");
    assert.equal(start.toISOString(), "2026-02-01T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-02-28T00:00:00.000Z");
    for (const bad of ["2026-13", "2026-9", "septiembre", 202609, null]) await expectStatus(Promise.resolve().then(() => parseIncidencePeriod(bad)), 400, "VALIDATION_ERROR");
  });

  it("overlapDays cuenta días naturales inclusive dentro del mes", () => {
    const { start, end } = parseIncidencePeriod("2026-09");
    assert.equal(overlapDays(d("2026-08-28"), d("2026-09-03"), start, end), 3);
    assert.equal(overlapDays(d("2026-09-10"), d("2026-09-12"), start, end), 3);
    assert.equal(overlapDays(d("2026-09-29"), d("2026-10-05"), start, end), 2);
    assert.equal(overlapDays(d("2026-10-01"), d("2026-10-02"), start, end), 0);
  });

  it("incidencesFilename: periodo y centro en minúsculas sin símbolos", () => {
    assert.equal(incidencesFilename("2026-09", null), "incidencias-2026-09.csv");
    assert.equal(incidencesFilename("2026-09", "RA-1"), "incidencias-2026-09-ra1.csv");
  });
});

describe("incidences · buildIncidenceRows (puro)", () => {
  const { start, end } = parseIncidencePeriod("2026-09");
  const { rows, warnings } = buildIncidenceRows({ start, end, properties, employees, profiles, contracts, absences });

  it("genera alta, baja, cambio de contrato y ausencias del mes, ordenadas por tipo y número", () => {
    assert.deepEqual(
      rows.map((row) => [row.kind, row.employeeNumber, row.code, row.from, row.to, row.days]),
      [
        ["hire", "0001", "temporal", "2026-09-07", "2026-12-31", null],
        ["hire", "0005", "indefinido", "2026-09-15", null, null],
        ["termination", "0002", "resignation", "2026-09-20", null, null],
        ["contract_change", "0003", "fin_end_of_term", "2026-09-14", null, null],
        ["contract_change", "0003", "indefinido", "2026-09-15", null, null],
        ["absence", "0004", "vacation", "2026-09-01", "2026-09-03", 3],
        ["absence", "0004", "it_common", "2026-09-10", "2026-09-12", 3]
      ]
    );
    // La baja del 0002 NO duplica un «fin de contrato»; la alta del 0001 no es un «cambio».
    assert.equal(rows.filter((row) => row.employeeNumber === "0002").length, 1);
    assert.equal(rows.filter((row) => row.employeeNumber === "0001").length, 1);
    // Sin horas extra: no hay WorkdayRecord en la tanda (nunca un 0 inventado).
    assert.equal(rows.some((row) => row.kind === "overtime"), false);
    assert.ok(rows.every((row) => (PAYROLL_INCIDENCE_KINDS as readonly string[]).includes(row.kind)));
  });

  it("detalle de jornada en altas y cambios; centro y nombre por fila; ausencias de fichas sin expediente → aviso", () => {
    const hire = rows.find((row) => row.kind === "hire" && row.employeeNumber === "0001")!;
    assert.equal(hire.hours, "40.00");
    assert.equal(hire.detail, "40,00 h/sem");
    assert.equal(hire.propertyCode, "HA");
    assert.equal(hire.employeeName, "Alta Septiembre");
    const change = rows.find((row) => row.kind === "contract_change" && row.code === "indefinido")!;
    assert.equal(change.detail, "20,00 h/sem · 50,00 % jornada");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /1 ausencia\(s\) aprobada\(s\) de fichas sin expediente/);
  });

  it("ninguna fila lleva NIF, NAF, correo, teléfono ni IBAN (ni como clave ni como valor)", () => {
    for (const row of rows) {
      for (const key of ["taxId", "socialSecurityNumber", "email", "phone", "iban", "taxIdLookupHash"]) assert.equal(key in row, false, `${key} en la fila`);
      assert.doesNotMatch(JSON.stringify(row), NIF_LIKE);
    }
  });
});

describe("incidences · renderIncidencesCsv", () => {
  it("CSV `;` con BOM, cabecera fija, decimales con coma y valores saneados; sin NIF", () => {
    const { start, end } = parseIncidencePeriod("2026-09");
    const { rows } = buildIncidenceRows({ start, end, properties, employees: [{ ...employees[0]!, lastName: 'Con; "comillas"' }], profiles, contracts, absences: [] });
    const csv = renderIncidencesCsv(rows);
    assert.ok(csv.startsWith("﻿"));
    const lines = csv.trimEnd().split("\n");
    assert.equal(lines[0], `﻿${PAYROLL_INCIDENCES_CSV_HEADER}`);
    assert.equal(lines.length, 2);
    // Solo se entrecomilla lo que lleva `;` o comillas; la coma decimal no exige comillas con separador `;`.
    assert.equal(lines[1], 'HA;0001;"Alta Con; ""comillas""";hire;temporal;2026-09-07;2026-12-31;;40,00;40,00 h/sem');
    assert.doesNotMatch(csv, NIF_LIKE);
    assert.equal(renderIncidencesCsv([]), `﻿${PAYROLL_INCIDENCES_CSV_HEADER}\n`);
  });
});

describe("incidences · buildPayrollIncidences (servicio con deps falsas)", () => {
  it("sin workforce.payroll_export → 403 PermissionDeniedError", async () => {
    const { deps } = fakeDeps();
    await expectStatus(buildPayrollIncidences({ context: nobody, periodCode: "2026-09" }, deps), 403);
  });

  it("por centro: solo las filas del centro; audita recuentos sin datos personales", async () => {
    const { deps, audits } = fakeDeps();
    const out = await buildPayrollIncidences({ context: exporter, periodCode: "2026-09", propertyId: HA, correlationId: "corr_inc" }, deps);
    assert.equal(out.periodCode, "2026-09");
    assert.equal(out.propertyId, HA);
    assert.equal(out.propertyCode, "HA");
    assert.equal(out.generatedAt, "2026-10-01T00:00:00.000Z");
    assert.deepEqual(out.rows.map((row) => row.employeeNumber), ["0001", "0002", "0003", "0003", "0004", "0004"]);
    assert.equal(out.rows.some((row) => row.propertyId === HB), false);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, PAYROLL_INCIDENCES_AUDIT_ACTION);
    assert.equal(audits[0]!.entityId, `2026-09:${HA}`);
    const after = audits[0]!.afterJson as { rows: number; byKind: Record<string, number>; properties: number };
    assert.equal(after.rows, 6);
    assert.equal(after.properties, 1);
    assert.deepEqual(after.byKind, { hire: 1, termination: 1, contract_change: 2, absence: 2, overtime: 0 });
    assert.doesNotMatch(JSON.stringify(audits[0]), /Septiembre|Renuncia|0001|0002/);
  });

  it("toda la sociedad: ámbito de organización suma ambos centros; sin ámbito → 404 ENTITY_SCOPE_REQUIRED", async () => {
    const { deps } = fakeDeps();
    const out = await buildPayrollIncidences({ context: exporter, periodCode: "2026-09" }, deps);
    assert.equal(out.propertyId, null);
    assert.equal(out.propertyCode, null);
    assert.equal(out.rows.length, 7);
    assert.ok(out.rows.some((row) => row.employeeNumber === "0005" && row.propertyCode === "HB"));
    await expectStatus(buildPayrollIncidences({ context: hotelAOnly, periodCode: "2026-09" }, deps), 404, "ENTITY_SCOPE_REQUIRED");
  });

  it("centro fuera del ámbito o de otra organización → 404 opaco PROPERTY_NOT_FOUND", async () => {
    const { deps } = fakeDeps();
    await expectStatus(buildPayrollIncidences({ context: hotelAOnly, periodCode: "2026-09", propertyId: HB }, deps), 404);
    await expectStatus(buildPayrollIncidences({ context: exporter, periodCode: "2026-09", propertyId: "prop_ajena" }, deps), 404, "PROPERTY_NOT_FOUND");
  });

  it("un mes sin novedades devuelve rows: [] (nunca filas inventadas)", async () => {
    const { deps } = fakeDeps();
    const out = await buildPayrollIncidences({ context: exporter, periodCode: "2026-11", propertyId: HA }, deps);
    assert.deepEqual(out.rows, []);
    assert.deepEqual(out.warnings, []);
  });
});
