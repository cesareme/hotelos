/**
 * Coste de personal importado · Tanda 6c · L1 — integración (Postgres, en
 * proceso, sin HTTP). Una organización AISLADA `org_pc_<run>` (una sociedad, dos
 * hoteles HA / HB y una oficina central OC) creada aquí y borrada en `after`
 * recorre el servicio con un CSV SINTÉTICO (2 centros × 2 meses × 3 filas + una
 * etiqueta desconocida «CASA RURAL»):
 *   · preview → `unmappedCentres` con sugerencias, nada escrito;
 *   · create sin mapeo → 400 PAYROLL_IMPORT_CENTRE_UNMAPPED; con mapeo → 4 asientos
 *     `created`, sourceId `<importId>:<propertyId>:<YYYY-MM>`, fecha = último día del
 *     mes, líneas 640 / 642 con `costCenterId` → `cost_centers.type = 'usali'`
 *     (ROOMS / ADMIN_GENERAL del centro), Σ640 + Σ642 = totalCost = Σ465 + Σ476,
 *     líneas y referencias del lote con organizationId y costCenterId;
 *   · nómina real ya contabilizada en HA · 2026-03 → aviso en la preview Y en el resultado de
 *     create (`warnings`, contable-6C-08);
 *   · informe con una venta manual 705.1 → laborPctLedger y netSalesReported;
 *   · mismo contenido → 409 PAYROLL_IMPORT_DUPLICATE; otro contenido en el mismo mes →
 *     409 PAYROLL_IMPORT_OVERLAP; `replace: true` → lote anterior revertido ENTERO;
 *   · `post: false` → borrador sin asientos y `postPayrollCostImport` → posted;
 *   · reverso idempotente; listado y detalle;
 *   · centro de otra organización en el mapeo → 404 PROPERTY_NOT_FOUND;
 *   · contexto asignado solo a HA y lote con HB → 404; el listado lo oculta; `replace`
 *     desde ese contexto NO revierte un lote HA+HB (404, SEC-6C-01) y la preview
 *     enmascara fichero y fecha del lote ajeno (SEC-6C-04);
 *   · `replace: true` + `post: false` → 400 (contable-6C-01);
 *   · reverso con el asiento original en un mes cerrado → 409 aunque `entryDate` sea
 *     abierta; tras reabrir el mes → 200 (contable-6C-02);
 *   · periodo cerrado → 409 FISCAL_PERIOD_CLOSED y NINGUNA fila del lote (rollback).
 * Faranda y org_123 nunca se escriben. Desde el repo:
 *   cd apps/api && node --import tsx --test "../../tests/integration/payroll-cost-import.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
delete process.env.STRUCTURE_ENABLED;

const { prisma } = await import("@hotelos/database");
const accounting = await import("../../apps/api/src/modules/accounting/accounting.service.js");
const fiscalPeriods = await import("../../apps/api/src/modules/accounting/fiscal-period.service.js");
const costImport = await import("../../apps/api/src/modules/payroll/cost-import.service.js");
const costReport = await import("../../apps/api/src/modules/payroll/cost-report.service.js");
const periods = await import("../../apps/api/src/modules/payroll/periods.service.js");
const { HttpError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushAccountingProjection } = await import("../../apps/api/src/modules/accounting/projection.js");
const { flushExtraProjections } = await import("../../apps/api/src/modules/accounting/posting-rules/index.js");

const RUN = Date.now().toString(36);
const ORG = `org_pc_${RUN}`;
const ENTITY = `le_pc_${RUN}`;
const HA = `prop_pc_ha_${RUN}`;
const HB = `prop_pc_hb_${RUN}`;
const OC = `prop_pc_oc_${RUN}`;
const USER = `usr_pc_${RUN}`;
const CORR = `corr_pc_${RUN}`;
/** CIF sintético con dígito de control válido (A87654323) que ningún tenant usa. */
const TAX_ID = "A87654323";

const context = {
  organizationId: ORG,
  propertyId: HA,
  userId: USER,
  fullName: "Dirección PC",
  deviceId: "pc-test",
  permissions: ["payroll.manage", "accounting.read", "accounting.entity.read"]
} as unknown as UserContext;
// Tanda 8a (design §4.6): the period close is accounting.period.close (dirección financiera); this context stands for contabilidad + dirección financiera of the test.
const accountant = { ...context, permissions: ["accounting.journal.post", "accounting.period.close", "accounting.read", "accounting.entity.read"] } as unknown as UserContext;
const assignedToHa = { ...context, assignedPropertyIds: [HA] } as unknown as UserContext;

type Details = Record<string, unknown>;

async function expectCode<T>(promise: Promise<T>, statusCode: number, code: string): Promise<Details> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    assert.equal(error.statusCode, statusCode, `status of ${code}: ${error.message}`);
    const details = (error.details ?? {}) as Details;
    assert.equal(details.code, code, `details.code (${error.message})`);
    return details;
  }
  assert.fail(`expected ${statusCode} ${code}`);
}

const D = (value: string | number) => accounting.money(value);
/** «6.000,00» (formato español del informe). */
function es(value: string | number): string {
  const [int, frac = "00"] = D(value).toFixed(2).split(".");
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${frac}`;
}

type SyntheticRow = { centre: string; month: string; group: string; dept: string; gross: string; ss: string; head: string; sales?: string; rooms?: string };
const HEADER = "centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados;ventas_sin_iva;hab_disponibles;usali";

function renderCsv(rows: readonly SyntheticRow[]): string {
  const lines = rows.map((r) => [r.centre, r.month, r.group, r.dept, es(r.gross), es(r.ss), es(D(r.gross).plus(r.ss).toFixed(2)), r.head, r.sales ? es(r.sales) : "", r.rooms ?? "", ""].join(";"));
  return "\uFEFF" + [HEADER, ...lines].join("\r\n") + "\r\n";
}

function centreMonth(centre: string, month: string, sales: string, rooms: string, factor: number): SyntheticRow[] {
  const f = (base: number) => D(base).mul(factor).toFixed(2);
  return [
    { centre, month, group: "operaciones", dept: "3 RECEPCIO", gross: f(6000), ss: f(1800), head: "3", sales, rooms },
    { centre, month, group: "operaciones", dept: "6 PISOS", gross: f(4000), ss: f(1200), head: "4", sales, rooms },
    { centre, month, group: "estructura", dept: "ADMINISTRACION", gross: f(2000), ss: f(600), head: "1", sales, rooms }
  ];
}

// Contenido A: 2 centros × 2 meses × 3 filas + «CASA RURAL» (13 filas).
const ROWS_A: SyntheticRow[] = [
  ...centreMonth("HOTEL ALFA", "2026-03", "40000", "20", 1),
  ...centreMonth("HOTEL ALFA", "2026-04", "41000", "20", 1.02),
  ...centreMonth("HOTEL BETA", "2026-03", "20000", "10", 0.5),
  ...centreMonth("HOTEL BETA", "2026-04", "21000", "10", 0.52),
  { centre: "CASA RURAL", month: "2026-03", group: "operaciones", dept: "6 PISOS", gross: "1000.00", ss: "300.00", head: "1" }
];
const CSV_A = renderCsv(ROWS_A);
// Contenido B: solo HA, mismos meses, otros importes (solape con A).
const CSV_B = renderCsv([...centreMonth("HOTEL ALFA", "2026-03", "40000", "20", 1.1), ...centreMonth("HOTEL ALFA", "2026-04", "41000", "20", 1.1)]);
// Contenido C: HB en mayo (sin solape).
const CSV_C = renderCsv(centreMonth("HOTEL BETA", "2026-05", "22000", "10", 0.55));
// Contenido D: HB en julio (ámbito) · E: HA en junio (periodo cerrado) · F: solo la etiqueta desconocida (centro ajeno).
const CSV_D = renderCsv(centreMonth("HOTEL BETA", "2026-07", "23000", "10", 0.6));
const CSV_E = renderCsv(centreMonth("HOTEL ALFA", "2026-06", "45000", "20", 1.05));
const CSV_F = renderCsv([{ centre: "CASA RURAL", month: "2026-08", group: "operaciones", dept: "6 PISOS", gross: "1000.00", ss: "300.00", head: "1" }]);
// Contenido G: HA + HB en agosto (lote de dos centros) · G': solo HA en agosto (solapa con G) · H: HB en octubre (mes que se cierra a posteriori).
const CSV_G = renderCsv([...centreMonth("HOTEL ALFA", "2026-08", "42000", "20", 1.03), ...centreMonth("HOTEL BETA", "2026-08", "21500", "10", 0.53)]);
const CSV_G_HA = renderCsv(centreMonth("HOTEL ALFA", "2026-08", "42000", "20", 1.07));
const CSV_H = renderCsv(centreMonth("HOTEL BETA", "2026-10", "23500", "10", 0.58));

const MAPPING_A = { centres: { "CASA RURAL": HB } };

/** Σ por celda del contenido A tras mapear «CASA RURAL» → HB. */
function expectedCell(propertyId: string, month: string): { gross: string; ss: string; total: string } {
  const label = propertyId === HA ? "HOTEL ALFA" : "HOTEL BETA";
  let gross = D(0);
  let ss = D(0);
  for (const row of ROWS_A) {
    const rowProperty = row.centre === "CASA RURAL" ? HB : row.centre === label ? propertyId : null;
    if (rowProperty !== propertyId || row.month !== month) continue;
    gross = gross.plus(row.gross);
    ss = ss.plus(row.ss);
  }
  return { gross: gross.toFixed(2), ss: ss.toFixed(2), total: gross.plus(ss).toFixed(2) };
}

async function cleanup(): Promise<void> {
  await prisma.payrollCostReference.deleteMany({ where: { organizationId: ORG } });
  await prisma.payrollCostLine.deleteMany({ where: { organizationId: ORG } });
  await prisma.payrollCostImport.deleteMany({ where: { organizationId: ORG } });
  await prisma.costCenter.deleteMany({ where: { propertyId: { in: [HA, HB, OC] } } });
  await prisma.payrollPeriod.deleteMany({ where: { organizationId: ORG } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (entries.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  await prisma.organization.create({ data: { id: ORG, name: "PC Sociedad Test", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: ENTITY, organizationId: ORG, code: "PCT", legalName: "PC Hoteles Test SA", taxId: TAX_ID, legalForm: "sa", fiscalAddress: "Calle Prueba 2", fiscalMunicipality: "Gijón", fiscalProvince: "Asturias", isDefault: true, status: "active" } });
  await prisma.property.create({ data: { id: HA, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "HA", name: "Hotel Alfa", createdAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.property.create({ data: { id: HB, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "HB", name: "Hotel Beta", tradeName: "Casa Rural Beta", createdAt: new Date("2026-01-02T00:00:00Z") } });
  await prisma.property.create({ data: { id: OC, organizationId: ORG, legalEntityId: ENTITY, kind: "office", code: "OC", name: "Oficina central PC", createdAt: new Date("2026-01-03T00:00:00Z") } });
  // Nómina real ya contabilizada en HA · 2026-03 (solo aviso en la preview).
  await prisma.payrollPeriod.create({ data: { organizationId: ORG, propertyId: HA, periodCode: "2026-03", startDate: new Date("2026-03-01T00:00:00Z"), endDate: new Date("2026-03-31T00:00:00Z"), status: "calculated", journalEntryIds: [`je_fake_${RUN}`] } });
});

after(async () => {
  try {
    await flushAuditQueues();
    await flushAccountingProjection();
    await flushExtraProjections();
    await cleanup();
  } finally {
    await prisma.$disconnect();
  }
});

describe("coste de personal importado · organización aislada (sociedad + HA + HB + OC)", () => {
  let importA = "";
  let importB = "";
  let importC = "";
  let entriesA: string[] = [];
  let hashA = "";

  it("preview: centros sin mapear con sugerencias, celdas mapeadas, aviso de nómina real y nada escrito", async () => {
    const preview = await costImport.previewPayrollCostImport({ context, body: { format: "csv", content: CSV_A } });
    hashA = preview.contentHash;
    assert.match(hashA, /^[0-9a-f]{64}$/);
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.rowCount, 13);
    assert.equal(preview.periodFrom, "2026-03");
    assert.equal(preview.periodTo, "2026-04");
    assert.equal(preview.unmappedCentres.length, 1);
    assert.equal(preview.unmappedCentres[0]?.label, "CASA RURAL");
    assert.equal(preview.unmappedCentres[0]?.rows, 1);
    assert.deepEqual(preview.unmappedCentres[0]?.suggestions.map((s) => [s.propertyId, s.code, s.kind]), [[HB, "HB", "hotel"]], "«CASA RURAL» ⊂ tradeName «Casa Rural Beta»");
    assert.deepEqual(preview.unmappedDepartments, []);
    assert.deepEqual(preview.unmappedGroups, []);
    assert.deepEqual(preview.mapping.centres, { "HOTEL ALFA": HA, "HOTEL BETA": HB });
    assert.deepEqual(preview.mapping.departments, { "3 RECEPCIO": "rooms", "6 PISOS": "rooms", ADMINISTRACION: "admin_general" });
    assert.equal(preview.byCentreMonth.length, 4, "solo las filas mapeadas forman celdas");
    assert.equal(preview.totals.lines, 13);
    assert.equal(preview.totals.totalCost, D(expectedCell(HA, "2026-03").total).plus(expectedCell(HA, "2026-04").total).plus(expectedCell(HB, "2026-03").total).plus(expectedCell(HB, "2026-04").total).toFixed(2));
    assert.equal(preview.duplicateOf, null);
    assert.deepEqual(preview.overlaps, []);
    assert.deepEqual(preview.payrollPeriodsPosted.map((p) => [p.propertyId, p.periodCode]), [[HA, "2026-03"]]);
    assert.ok(preview.warnings.some((w) => w.includes("nómina real")));
    assert.equal(preview.canPost, false);
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), 0, "la preview nunca escribe");

    const mapped = await costImport.previewPayrollCostImport({ context, body: { format: "csv", content: CSV_A, mapping: MAPPING_A } });
    assert.equal(mapped.contentHash, hashA, "el mapeo no cambia el hash del contenido");
    assert.deepEqual(mapped.unmappedCentres, []);
    assert.equal(mapped.canPost, true);
    assert.equal(mapped.byCentreMonth.find((c) => c.propertyId === HB && c.periodCode === "2026-03")?.workCenterLabels.join("+"), "HOTEL BETA+CASA RURAL");
    assert.equal(mapped.totals.headcountAverage, "16.50", "(8 + 9) y (8 + 8) → media 16,5");
  });

  it("create sin mapeo → 400 PAYROLL_IMPORT_CENTRE_UNMAPPED; organizationId ajeno en el JSON → 400 PAYROLL_IMPORT_ORGANIZATION_MISMATCH", async () => {
    const details = await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_A, fileName: "a.csv" }, correlationId: CORR }), 400, "PAYROLL_IMPORT_CENTRE_UNMAPPED");
    assert.deepEqual(details.labels, ["CASA RURAL"]);
    assert.equal(details.rows, 1);
    await expectCode(costImport.createPayrollCostImport({ context, body: { format: "json", content: JSON.stringify({ organizationId: "org_123", lineas: [{ centro: "HOTEL ALFA", mes: "2026-03", grupo: "operaciones", departamento: "6 PISOS", salarioBruto: 1, costeSs: 1, empleados: 1 }] }) }, correlationId: CORR }), 400, "PAYROLL_IMPORT_ORGANIZATION_MISMATCH");
    await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: "centro;mes\nx;y\n" }, correlationId: CORR }), 400, "PAYROLL_IMPORT_INVALID");
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), 0);
  });

  it("create con mapeo → 4 asientos contabilizados: sourceId, fecha, centros de coste usali, cuadre 640 + 642 = 465 + 476, líneas y referencias", async () => {
    const result = await costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_A, mapping: MAPPING_A, fileName: "coste-sintetico-a.csv", notes: "lote A" }, correlationId: CORR });
    importA = result.id;
    entriesA = result.journalEntryIds;
    assert.equal(result.status, "posted");
    assert.equal(result.organizationId, ORG);
    assert.equal(result.legalEntityId, ENTITY, "la sociedad sale de resolveLedgerScope");
    assert.equal(result.source, "csv");
    assert.equal(result.fileName, "coste-sintetico-a.csv");
    assert.equal(result.contentHash, hashA);
    assert.equal(result.rowCount, 13);
    assert.equal(result.centreMonths, 4);
    assert.deepEqual([...result.propertyIds].sort(), [HA, HB].sort());
    assert.deepEqual(result.replacedImportIds, []);
    assert.equal(result.entries.length, 4);
    assert.equal(result.journalEntryIds.length, 4);
    assert.deepEqual(result.reversalJournalEntryIds, []);
    assert.ok(result.postedAt);
    assert.equal(result.createdBy, USER);
    assert.equal(result.headcountAverage, "16.50");
    assert.ok(result.warnings.some((w) => w.includes("nómina real") && w.includes("HA · 2026-03")), "el aviso de nómina real llega también al resultado de create (contable-6C-08)");
    assert.deepEqual(result.mapping.centres, { "HOTEL ALFA": HA, "HOTEL BETA": HB, "CASA RURAL": HB });
    assert.ok(result.warnings.every((w) => !w.includes("coste_total")), "el CSV trae coste_total = bruto + SS");

    const expectedTotalGross = D(expectedCell(HA, "2026-03").gross).plus(expectedCell(HA, "2026-04").gross).plus(expectedCell(HB, "2026-03").gross).plus(expectedCell(HB, "2026-04").gross);
    const expectedTotalSs = D(expectedCell(HA, "2026-03").ss).plus(expectedCell(HA, "2026-04").ss).plus(expectedCell(HB, "2026-03").ss).plus(expectedCell(HB, "2026-04").ss);
    assert.equal(result.totalGross, expectedTotalGross.toFixed(2));
    assert.equal(result.totalEmployerSs, expectedTotalSs.toFixed(2));
    assert.equal(result.totalCost, expectedTotalGross.plus(expectedTotalSs).toFixed(2));
    assert.equal(result.reportedTotalCost, result.totalCost);

    for (const entry of result.entries) {
      assert.equal(entry.kind, "entry");
      assert.equal(entry.created, true);
      assert.equal(entry.status, "posted");
      assert.equal(entry.sourceId, `${importA}:${entry.propertyId}:${entry.periodCode}`);
      assert.equal(entry.entryDate, entry.periodCode === "2026-03" ? "2026-03-31" : "2026-04-30");
      assert.equal(entry.fiscalYearCode, "2026");
      assert.ok(entry.entryNumber && entry.entryNumber >= 1);
      assert.equal(entry.propertyCode, entry.propertyId === HA ? "HA" : "HB");
      assert.match(entry.description ?? "", /^Coste de personal 0[34]\/2026 · H[AB] \(importado\)$/);
      const cell = expectedCell(entry.propertyId, entry.periodCode);
      assert.equal(entry.totalDebit, cell.total);

      const view = (await accounting.loadJournalEntry(prisma, entry.id))!;
      assert.equal(view.sourceType, "payroll_cost_import");
      assert.equal(view.propertyId, entry.propertyId);
      assert.equal(view.reference, entry.periodCode);
      assert.equal(view.totalDebit, view.totalCredit);
      let d640 = D(0);
      let d642 = D(0);
      let c465 = D(0);
      let c476 = D(0);
      for (const line of view.lines) {
        if (line.accountCode === "640" || line.accountCode === "642") {
          assert.ok(line.costCenterId, `${line.accountCode} lleva centro de coste`);
          const centre = await prisma.costCenter.findUnique({ where: { id: line.costCenterId! } });
          assert.equal(centre?.type, "usali");
          assert.equal(centre?.propertyId, entry.propertyId);
          assert.ok(["ROOMS", "ADMIN_GENERAL"].includes(centre!.code), centre!.code);
          assert.equal(centre?.active, true);
          if (line.accountCode === "640") d640 = d640.plus(line.debit);
          else d642 = d642.plus(line.debit);
        } else if (line.accountCode === "465") {
          assert.equal(line.costCenterId, null);
          c465 = c465.plus(line.credit);
        } else if (line.accountCode === "476") {
          c476 = c476.plus(line.credit);
        } else {
          assert.fail(`cuenta inesperada ${line.accountCode}`);
        }
      }
      assert.equal(d640.toFixed(2), cell.gross);
      assert.equal(d642.toFixed(2), cell.ss);
      assert.equal(c465.toFixed(2), cell.gross);
      assert.equal(c476.toFixed(2), cell.ss);
      assert.equal(d640.plus(d642).toFixed(2), cell.total, "Σ640 + Σ642 = totalCost");
      assert.equal(c465.plus(c476).toFixed(2), cell.total, "= Σ465 + Σ476");
      assert.equal(view.lines.filter((l) => l.accountCode === "640").length, 2, "una pareja 640 por departamento (rooms, admin_general)");
    }
    const centres = await prisma.costCenter.findMany({ where: { propertyId: { in: [HA, HB] } }, orderBy: [{ propertyId: "asc" }, { code: "asc" }] });
    assert.equal(centres.length, 4, "ROOMS + ADMIN_GENERAL por hotel; la oficina no participa");
    assert.ok(centres.every((c) => c.type === "usali" && c.name.length > 0));

    const lines = await prisma.payrollCostLine.findMany({ where: { importId: importA } });
    assert.equal(lines.length, 13);
    assert.ok(lines.every((l) => l.organizationId === ORG && l.costCenterId !== null && [HA, HB].includes(l.propertyId)));
    const casaRural = lines.find((l) => l.workCenterLabel === "CASA RURAL")!;
    assert.equal(casaRural.propertyId, HB);
    assert.equal(casaRural.usaliDepartment, "rooms");
    assert.equal(casaRural.costGroup, "operaciones");
    const references = await prisma.payrollCostReference.findMany({ where: { importId: importA }, orderBy: [{ periodCode: "asc" }, { propertyId: "asc" }] });
    assert.equal(references.length, 4);
    const haMarch = references.find((r) => r.propertyId === HA && r.periodCode === "2026-03")!;
    assert.equal(haMarch.organizationId, ORG);
    assert.equal(haMarch.netSalesReported?.toFixed(2), "40000.00");
    assert.equal(haMarch.roomsAvailableReported, 20);
    assert.equal(haMarch.employeesReported, null);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, sourceType: "payroll_cost_import" } }), 4);
  });

  it("informe: venta manual 705.1 en HA → laborPctLedger; netSalesReported y habitaciones de las columnas extra", async () => {
    const sale = await accounting.postJournalEntry({ organizationId: ORG, propertyId: HA, entryDate: "2026-03-15", sourceType: "manual", sourceId: `pc-sale-${RUN}`, description: "Venta de alojamiento (sintética)", createdBy: USER, lines: [{ accountCode: "4300", debit: "5000.00" }, { accountCode: "705.1", credit: "5000.00" }] });
    assert.equal(sale.created, true);
    const report = await costReport.buildPayrollCostReport({ context, from: "2026-03", to: "2026-04" });
    assert.equal(report.organizationId, ORG);
    assert.equal(report.legalEntityId, ENTITY);
    assert.deepEqual(report.months, ["2026-03", "2026-04"]);
    assert.deepEqual(report.centres.map((c) => c.code), ["HA", "HB", "OC"], "hoteles primero, la oficina al final");
    assert.deepEqual(report.imports.map((i) => i.importId), [importA]);
    const ha = report.centres.find((c) => c.propertyId === HA)!;
    const march = ha.cells[0]!;
    const expected = expectedCell(HA, "2026-03");
    assert.equal(march.periodCode, "2026-03");
    assert.equal(march.totalCost, expected.total);
    assert.equal(march.ledgerNetSales, "5000.00");
    assert.equal(march.laborPctLedger, D(expected.total).mul(100).div(5000).toDecimalPlaces(2).toFixed(2));
    assert.equal(march.netSalesReported, "40000.00");
    assert.equal(march.laborPctReference, D(expected.total).mul(100).div(40000).toDecimalPlaces(2).toFixed(2));
    assert.equal(march.roomsInventoryReported, 20);
    assert.equal(march.roomsInventory, 0, "sin habitaciones en el ERP");
    assert.equal(march.roomsAvailable, 20 * 31);
    assert.equal(march.headcountEffective, "8.00");
    assert.equal(march.headcountSource, "lines");
    assert.equal(march.costPerEmployee, D(expected.total).div(8).toDecimalPlaces(2).toFixed(2));
    assert.deepEqual(march.importIds, [importA]);
    assert.deepEqual(march.byDepartment.map((d) => d.usaliDepartment), ["admin_general", "rooms"]);
    const april = ha.cells[1]!;
    assert.equal(april.ledgerNetSales, "0.00");
    assert.equal(april.laborPctLedger, null);
    // contable-6C-03: 5.000 € en el libro frente a 60.000 de referencia (HA + HB) no cubren marzo → la fuente principal es la referencia.
    assert.equal(march.salesSource, "reference");
    assert.equal(report.byMonth[0]?.salesSource, "reference");
    assert.equal(report.byMonth[1]?.salesSource, "reference");
    const ledgerOnly = await costReport.buildPayrollCostReport({ context, from: "2026-03", to: "2026-03", propertyId: HA, group: "estructura" });
    assert.equal(ledgerOnly.centres[0]?.cells[0]?.salesSource, "reference", "la referencia (40.000) sigue cubriendo más que los 5.000 del libro");
    const oc = report.centres.find((c) => c.propertyId === OC)!;
    assert.equal(oc.totals.totalCost, "0.00");
    assert.equal(oc.totals.headcountEffective, null);
    assert.equal(report.totals.totalCost, D(expectedCell(HA, "2026-03").total).plus(expectedCell(HA, "2026-04").total).plus(expectedCell(HB, "2026-03").total).plus(expectedCell(HB, "2026-04").total).toFixed(2));
    assert.equal(report.totals.headcountAverage, "16.50");
    const onlyHb = await costReport.buildPayrollCostReport({ context, from: "2026-03", to: "2026-04", propertyId: HB, group: "operaciones" });
    assert.deepEqual(onlyHb.centres.map((c) => c.propertyId), [HB]);
    assert.equal(onlyHb.centres[0]?.cells[0]?.lines, 3, "2 filas de HOTEL BETA + 1 de CASA RURAL en operaciones");
    assert.equal(onlyHb.centres[0]?.cells[0]?.netSalesReported, "20000.00", "el filtro de grupo no filtra la referencia");
    await expectCode(costReport.buildPayrollCostReport({ context, from: "2026-03", to: "2026-04", propertyId: "prop_123" }), 404, "PROPERTY_NOT_FOUND");
    await expectCode(costReport.buildPayrollCostReport({ context, from: "2026-05", to: "2026-04" }), 400, "VALIDATION_ERROR");
  });

  it("mismo contenido → 409 PAYROLL_IMPORT_DUPLICATE; otro contenido en el mismo mes → 409 PAYROLL_IMPORT_OVERLAP; nada escrito", async () => {
    const before = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    const duplicate = await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_A, mapping: MAPPING_A }, correlationId: CORR }), 409, "PAYROLL_IMPORT_DUPLICATE");
    assert.equal(duplicate.importId, importA);
    assert.equal(duplicate.status, "posted");
    const overlap = await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_B }, correlationId: CORR }), 409, "PAYROLL_IMPORT_OVERLAP");
    const overlaps = overlap.overlaps as Array<{ importId: string; propertyId: string; periodCode: string }>;
    assert.equal(overlaps.length, 2);
    assert.ok(overlaps.every((o) => o.importId === importA && o.propertyId === HA));
    assert.deepEqual(overlaps.map((o) => o.periodCode), ["2026-03", "2026-04"]);
    const preview = await costImport.previewPayrollCostImport({ context, body: { format: "csv", content: CSV_B, replace: true } });
    assert.equal(preview.overlaps.length, 2);
    assert.deepEqual(preview.replacedImportIds, [importA]);
    assert.equal(preview.canPost, true, "con replace la preview autoriza");
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), 1);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), before);
  });

  it("replace: true → el lote anterior se revierte ENTERO (4 reversos) y el nuevo queda contabilizado con replacedImportIds", async () => {
    const result = await costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_B, fileName: "coste-sintetico-b.csv", replace: true }, correlationId: CORR });
    importB = result.id;
    assert.equal(result.status, "posted");
    assert.deepEqual(result.replacedImportIds, [importA]);
    assert.equal(result.entries.length, 2);
    assert.deepEqual(result.propertyIds, [HA]);
    const previous = (await prisma.payrollCostImport.findUnique({ where: { id: importA } }))!;
    assert.equal(previous.status, "reversed");
    assert.equal(previous.reversalJournalEntryIds.length, 4, "los 4 asientos de A, no solo los de HA");
    assert.equal(previous.reversalReason, `sustituido por ${importB}`);
    assert.equal(previous.reversedBy, USER);
    assert.ok(previous.reversedAt);
    for (const id of entriesA) {
      const original = (await prisma.journalEntry.findUnique({ where: { id }, select: { status: true, reversedById: true } }))!;
      assert.equal(original.status, "reversed");
      assert.ok(original.reversedById && previous.reversalJournalEntryIds.includes(original.reversedById));
      const reversal = (await accounting.loadJournalEntry(prisma, original.reversedById!))!;
      assert.equal(reversal.entryKind, "reversal");
      assert.equal(reversal.reversalOfId, id);
      assert.match(reversal.description ?? "", /^Reverso coste de personal 0[34]\/2026 · H[AB] — sustituido por /);
      assert.ok(reversal.lines.filter((l) => l.accountCode === "640").every((l) => l.costCenterId !== null), "el reverso conserva el centro de coste");
    }
    // Los asientos previos ajenos al lote (la venta manual) no se tocan.
    assert.equal((await prisma.journalEntry.findFirst({ where: { organizationId: ORG, sourceType: "manual" }, select: { status: true } }))?.status, "posted");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, status: "posted", sourceType: "payroll_cost_import" } }), 2);
    // El informe ya solo lee el lote B (A está revertido).
    const report = await costReport.buildPayrollCostReport({ context, from: "2026-03", to: "2026-04" });
    assert.deepEqual(report.imports.map((i) => i.importId), [importB]);
    assert.equal(report.centres.find((c) => c.propertyId === HB)?.totals.totalCost, "0.00");
  });

  it("post: false → borrador sin asientos; postPayrollCostImport → contabilizado; duplicado del borrador excluye al propio lote", async () => {
    // contable-6C-01: con replace el borrador revertiría los lotes anteriores y dejaría el diario sin el coste → 400 sin escribir nada.
    const importsBefore = await prisma.payrollCostImport.count({ where: { organizationId: ORG } });
    const postedBefore = await prisma.payrollCostImport.count({ where: { organizationId: ORG, status: "posted" } });
    await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_C, post: false, replace: true }, correlationId: CORR }), 400, "VALIDATION_ERROR");
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), importsBefore, "nada creado");
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG, status: "posted" } }), postedBefore, "nada revertido");
    const draft = await costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_C, fileName: "coste-sintetico-c.csv", post: false }, correlationId: CORR });
    importC = draft.id;
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.entries, []);
    assert.deepEqual(draft.journalEntryIds, []);
    assert.equal(draft.postedAt, null);
    assert.equal(draft.rowCount, 3);
    assert.equal(await prisma.payrollCostLine.count({ where: { importId: importC, costCenterId: null } }), 3, "sin centro de coste hasta contabilizar");
    await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_C } }), 409, "PAYROLL_IMPORT_DUPLICATE");
    // Corrector RRHH · RF-10 (diseño §7.1 (3)): una nómina calculada APROBADA en la celda (HB, 2026-05) bloquea la contabilización
    // del lote (409 PAYROLL_MODE_CONFLICT, nada escrito); una `calculated` sin aprobar solo avisa.
    const approvedPeriod = await prisma.payrollPeriod.create({ data: { organizationId: ORG, propertyId: HB, periodCode: "2026-05", startDate: new Date("2026-05-01T00:00:00Z"), endDate: new Date("2026-05-31T00:00:00Z"), status: "approved", approvedByUserId: `usr_pc_dg_${RUN}`, approvedAt: new Date(), journalEntryIds: [`je_pc_fake_${RUN}`], mode: "calculated" }, select: { id: true } });
    const conflict = await expectCode(costImport.postPayrollCostImport({ context, importId: importC, correlationId: CORR }), 409, "PAYROLL_MODE_CONFLICT");
    assert.equal(conflict.mode, "calculated");
    assert.equal((await prisma.payrollCostImport.findUnique({ where: { id: importC }, select: { status: true } }))?.status, "draft", "el lote sigue en borrador");
    await prisma.payrollPeriod.update({ where: { id: approvedPeriod.id }, data: { status: "calculated", approvedByUserId: null, approvedAt: null } });
    const previewWarned = await costImport.previewPayrollCostImport({ context, body: { format: "csv", content: CSV_C } });
    assert.ok(previewWarned.warnings.some((warning) => /nómina real ya contabilizado/.test(warning)), "sin aprobar: solo aviso");
    await prisma.payrollPeriod.delete({ where: { id: approvedPeriod.id } });
    const posted = await costImport.postPayrollCostImport({ context, importId: importC, correlationId: CORR });
    assert.equal(posted.status, "posted");
    assert.equal(posted.entries.length, 1);
    assert.equal(posted.entries[0]?.sourceId, `${importC}:${HB}:2026-05`);
    assert.equal(posted.entries[0]?.entryDate, "2026-05-31");
    assert.equal(posted.entries[0]?.created, true);
    assert.equal(await prisma.payrollCostLine.count({ where: { importId: importC, costCenterId: null } }), 0);
    await expectCode(costImport.postPayrollCostImport({ context, importId: importC, correlationId: CORR }), 409, "PAYROLL_IMPORT_ALREADY_POSTED");
    // Espejo de RF-10: con el lote contabilizado en (HB, 2026-05), calcular una nómina en esa celda es 409 PAYROLL_MODE_CONFLICT.
    const openPeriod = await prisma.payrollPeriod.create({ data: { organizationId: ORG, propertyId: HB, periodCode: "2026-05", startDate: new Date("2026-05-01T00:00:00Z"), endDate: new Date("2026-05-31T00:00:00Z"), status: "open" }, select: { id: true } });
    const modeConflict = await expectCode(periods.calculatePeriod({ context, periodId: openPeriod.id, correlationId: CORR }), 409, "PAYROLL_MODE_CONFLICT");
    assert.equal(modeConflict.mode, "external");
    assert.deepEqual((modeConflict.imports as Array<{ importId: string; propertyId: string }>).map((row) => [row.importId, row.propertyId]), [[importC, HB]]);
    assert.equal((await prisma.payrollPeriod.findUnique({ where: { id: openPeriod.id }, select: { status: true } }))?.status, "open");
    await prisma.payrollPeriod.delete({ where: { id: openPeriod.id } });
    await expectCode(costImport.postPayrollCostImport({ context, importId: importA, correlationId: CORR }), 409, "PAYROLL_IMPORT_REVERSED");
    await expectCode(costImport.postPayrollCostImport({ context, importId: `imp_missing_${RUN}`, correlationId: CORR }), 404, "PAYROLL_IMPORT_NOT_FOUND");
  });

  it("reverso: motivo obligatorio, asientos revertidos, idempotente (alreadyReversed) y sin tocar otros asientos", async () => {
    await expectCode(costImport.reversePayrollCostImport({ context, importId: importC, body: { reason: "   " }, correlationId: CORR }), 400, "JOURNAL_REVERSAL_REASON_REQUIRED");
    const before = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    const reversed = await costImport.reversePayrollCostImport({ context, importId: importC, body: { reason: "error en el informe" }, correlationId: CORR });
    assert.equal(reversed.status, "reversed");
    assert.equal(reversed.alreadyReversed, false);
    assert.equal(reversed.reversalJournalEntryIds.length, 1);
    assert.equal(reversed.reversalReason, "error en el informe");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), before + 1);
    const again = await costImport.reversePayrollCostImport({ context, importId: importC, body: { reason: "otra vez" }, correlationId: CORR });
    assert.equal(again.alreadyReversed, true);
    assert.deepEqual(again.reversalJournalEntryIds, reversed.reversalJournalEntryIds);
    assert.equal(again.reversalReason, "error en el informe", "el segundo reverso no escribe");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), before + 1);
    const reversal = (await accounting.loadJournalEntry(prisma, reversed.reversalJournalEntryIds[0]!))!;
    assert.equal(reversal.description, "Reverso coste de personal 05/2026 · HB — error en el informe");
    assert.equal(reversal.reference, "2026-05");
    assert.equal((await prisma.journalEntry.findFirst({ where: { organizationId: ORG, sourceType: "manual" }, select: { status: true } }))?.status, "posted");
  });

  it("listado (más reciente primero, filtros) y detalle (líneas con centro de coste, asientos y reversos)", async () => {
    const all = await costImport.listPayrollCostImports({ context });
    assert.deepEqual(all.map((r) => r.id), [importC, importB, importA]);
    assert.deepEqual(all.map((r) => r.status), ["reversed", "posted", "reversed"]);
    assert.deepEqual(all.map((r) => r.centreMonths), [1, 2, 4]);
    const posted = await costImport.listPayrollCostImports({ context, query: { status: "posted" } });
    assert.deepEqual(posted.map((r) => r.id), [importB]);
    const may = await costImport.listPayrollCostImports({ context, query: { from: "2026-05", to: "2026-05" } });
    assert.deepEqual(may.map((r) => r.id), [importC]);
    const detail = await costImport.getPayrollCostImport({ context, importId: importB });
    assert.equal(detail.lines.length, 6);
    assert.ok(detail.lines.every((l) => l.costCenterId && ["ROOMS", "ADMIN_GENERAL"].includes(l.costCenterCode ?? "") && l.propertyCode === "HA"));
    assert.equal(detail.references.length, 2);
    assert.equal(detail.byCentreMonth.length, 2);
    assert.equal(detail.entries.length, 2);
    assert.deepEqual(detail.reversals, []);
    assert.ok(detail.entries.every((e) => e.kind === "entry" && e.status === "posted" && e.propertyCode === "HA"));
    const detailA = await costImport.getPayrollCostImport({ context, importId: importA });
    assert.equal(detailA.entries.length, 4);
    assert.ok(detailA.entries.every((e) => e.status === "reversed" && e.reversedById));
    assert.equal(detailA.reversals.length, 4);
    assert.ok(detailA.reversals.every((r) => r.kind === "reversal" && r.reversalOfId && r.sourceId.startsWith("reversal:")));
    await expectCode(costImport.getPayrollCostImport({ context: { ...context, organizationId: "org_123", propertyId: "prop_123" } as UserContext, importId: importB }), 404, "PAYROLL_IMPORT_NOT_FOUND");
  });

  it("centro de otra organización en el mapeo → 404 PROPERTY_NOT_FOUND (create y preview) sin escribir", async () => {
    const before = await prisma.payrollCostImport.count({ where: { organizationId: ORG } });
    await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_F, mapping: { centres: { "CASA RURAL": "prop_123" } } }, correlationId: CORR }), 404, "PROPERTY_NOT_FOUND");
    await expectCode(costImport.previewPayrollCostImport({ context, body: { format: "csv", content: CSV_F, mapping: { centres: { "CASA RURAL": "prop_123" } } } }), 404, "PROPERTY_NOT_FOUND");
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), before);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, propertyId: "prop_123" } }), 0, "org_123 nunca se escribe");
  });

  it("ámbito R11: contexto asignado solo a HA → 404 con un lote de HB; el listado oculta los lotes fuera de ámbito", async () => {
    const before = await prisma.payrollCostImport.count({ where: { organizationId: ORG } });
    await expectStatus(costImport.createPayrollCostImport({ context: assignedToHa, body: { format: "csv", content: CSV_D }, correlationId: CORR }), 404);
    await expectStatus(costImport.previewPayrollCostImport({ context: assignedToHa, body: { format: "csv", content: CSV_D } }), 404);
    await expectStatus(costImport.getPayrollCostImport({ context: assignedToHa, importId: importC }), 404);
    await expectStatus(costImport.reversePayrollCostImport({ context: assignedToHa, importId: importA, body: { reason: "fuera de ámbito" }, correlationId: CORR }), 404);
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), before);
    const visible = await costImport.listPayrollCostImports({ context: assignedToHa });
    assert.deepEqual(visible.map((r) => r.id), [importB], "solo el lote cuyos centros están todos en ámbito");
    const report = await costReport.buildPayrollCostReport({ context: assignedToHa, from: "2026-03", to: "2026-04" });
    assert.deepEqual(report.centres.map((c) => c.propertyId), [HA], "el informe filtra los centros por ámbito");
  });

  it("ámbito R11 · replace: un CSV solo de HA no revierte un lote HA+HB (404 opaco, SEC-6C-01) y la preview enmascara el lote ajeno (SEC-6C-04)", async () => {
    const lotG = await costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_G, fileName: "coste-sintetico-g.csv" }, correlationId: CORR });
    assert.equal(lotG.status, "posted");
    assert.deepEqual(lotG.propertyIds.sort(), [HA, HB].sort());
    const hbEntry = (await prisma.journalEntry.findFirst({ where: { organizationId: ORG, propertyId: HB, sourceType: "payroll_cost_import", reversalOfId: null, reference: "2026-08" }, select: { id: true } }))!;
    // Preview desde el contexto solo-HA: el solape existe pero el lote ajeno llega sin fichero, y con replace no autoriza.
    const preview = await costImport.previewPayrollCostImport({ context: assignedToHa, body: { format: "csv", content: CSV_G_HA, replace: true } });
    assert.equal(preview.overlaps.length, 1);
    assert.equal(preview.overlaps[0]?.importId, lotG.id);
    assert.equal(preview.overlaps[0]?.fileName, null, "el fichero del lote fuera de ámbito no se revela");
    assert.equal(preview.canPost, false, "replace no puede revertir un lote con centros fuera del ámbito");
    assert.ok(preview.warnings.some((w) => /fuera de tu ámbito/.test(w)));
    const orgWide = await costImport.previewPayrollCostImport({ context, body: { format: "csv", content: CSV_G_HA, replace: true } });
    assert.equal(orgWide.overlaps[0]?.fileName, "coste-sintetico-g.csv", "con todos los centros en ámbito se ve el fichero");
    assert.equal(orgWide.canPost, true);
    // Create con replace desde el contexto solo-HA → 404 opaco (como el reverso directo) y NADA revertido.
    const importsBefore = await prisma.payrollCostImport.count({ where: { organizationId: ORG } });
    await expectStatus(costImport.createPayrollCostImport({ context: assignedToHa, body: { format: "csv", content: CSV_G_HA, replace: true }, correlationId: CORR }), 404);
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), importsBefore, "el lote nuevo hizo rollback");
    assert.equal((await prisma.payrollCostImport.findUnique({ where: { id: lotG.id } }))?.status, "posted", "el lote HA+HB sigue contabilizado");
    assert.equal((await prisma.journalEntry.findUnique({ where: { id: hbEntry.id }, select: { status: true, reversedById: true } }))?.status, "posted", "el asiento de HB no se tocó");
    // Sin replace, el 409 desde el contexto solo-HA tampoco revela el fichero.
    const overlap = await expectCode(costImport.createPayrollCostImport({ context: assignedToHa, body: { format: "csv", content: CSV_G_HA }, correlationId: CORR }), 409, "PAYROLL_IMPORT_OVERLAP");
    assert.equal((overlap.overlaps as Array<{ fileName: string | null }>)[0]?.fileName, null);
  });

  it("reverso con el asiento original en un mes cerrado → 409 FISCAL_PERIOD_CLOSED aunque entryDate sea abierta; reabrir el mes lo permite (contable-6C-02)", async () => {
    const lotH = await costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_H, fileName: "coste-sintetico-h.csv" }, correlationId: CORR });
    assert.equal(lotH.status, "posted");
    assert.equal(lotH.journalEntryIds.length, 1);
    const period = await fiscalPeriods.openFiscalPeriod({ context: accountant, periodCode: "2026-10", periodType: "month", startDate: "2026-10-01", endDate: "2026-10-31", correlationId: CORR });
    await fiscalPeriods.closeFiscalPeriod({ context: accountant, periodId: period.id, correlationId: CORR });
    const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    await expectCode(costImport.reversePayrollCostImport({ context, importId: lotH.id, body: { reason: "mes cerrado" }, correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    const details = await expectCode(costImport.reversePayrollCostImport({ context, importId: lotH.id, body: { reason: "mes cerrado", entryDate: "2026-11-30" }, correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    assert.equal(details.periodCode, "2026-10");
    assert.equal(details.journalEntryId, lotH.journalEntryIds[0]);
    assert.equal((await prisma.payrollCostImport.findUnique({ where: { id: lotH.id } }))?.status, "posted", "nada revertido");
    assert.equal((await prisma.journalEntry.findUnique({ where: { id: lotH.journalEntryIds[0]! }, select: { status: true } }))?.status, "posted", "el original sigue vivo en el mes cerrado");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), entriesBefore, "ningún reverso fechado en noviembre");
    // replace sobre ese mes falla igual (el reemplazo reversa lotes enteros): el camino es reabrir el periodo.
    await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: renderCsv(centreMonth("HOTEL BETA", "2026-10", "23500", "10", 0.6)), replace: true }, correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    await fiscalPeriods.reopenFiscalPeriod({ context: { ...accountant, permissions: [...(accountant.permissions as string[]), "ai.high_risk.confirm"] } as UserContext, periodId: period.id, reason: "corrección del coste de personal", correlationId: CORR });
    const reversed = await costImport.reversePayrollCostImport({ context, importId: lotH.id, body: { reason: "mes reabierto" }, correlationId: CORR });
    assert.equal(reversed.status, "reversed");
    assert.equal(reversed.reversalJournalEntryIds.length, 1);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), entriesBefore + 1);
  });

  it("periodo cerrado → 409 FISCAL_PERIOD_CLOSED y NINGUNA fila del lote (rollback completo)", async () => {
    const period = await fiscalPeriods.openFiscalPeriod({ context: accountant, periodCode: "2026-06", periodType: "month", startDate: "2026-06-01", endDate: "2026-06-30", correlationId: CORR });
    await fiscalPeriods.closeFiscalPeriod({ context: accountant, periodId: period.id, correlationId: CORR });
    const preview = await costImport.previewPayrollCostImport({ context, body: { format: "csv", content: CSV_E } });
    assert.equal(preview.canPost, true);
    const importsBefore = await prisma.payrollCostImport.count({ where: { organizationId: ORG } });
    const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    await expectCode(costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_E, fileName: "coste-sintetico-e.csv" }, correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), importsBefore, "el lote no existe");
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG, contentHash: preview.contentHash } }), 0);
    assert.equal(await prisma.payrollCostLine.count({ where: { organizationId: ORG, periodCode: "2026-06" } }), 0);
    assert.equal(await prisma.payrollCostReference.count({ where: { organizationId: ORG, periodCode: "2026-06" } }), 0);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), entriesBefore, "ningún asiento");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, entryDate: accounting.dateOnlyUtc("2026-06-30") } }), 0);
    // Un borrador sí se crea (no toca el diario) y su contabilización posterior falla igual sin dejar nada a medias.
    const draft = await costImport.createPayrollCostImport({ context, body: { format: "csv", content: CSV_E, post: false }, correlationId: CORR });
    assert.equal(draft.status, "draft");
    await expectCode(costImport.postPayrollCostImport({ context, importId: draft.id, correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    const still = (await prisma.payrollCostImport.findUnique({ where: { id: draft.id } }))!;
    assert.equal(still.status, "draft");
    assert.deepEqual(still.journalEntryIds, []);
    assert.equal(await prisma.payrollCostLine.count({ where: { importId: draft.id, costCenterId: null } }), 3, "las líneas siguen sin centro de coste");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), entriesBefore);
  });
});

async function expectStatus<T>(promise: Promise<T>, statusCode: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    assert.equal(status, statusCode, `expected ${statusCode}, got ${String(error)}`);
    return;
  }
  assert.fail(`expected ${statusCode}`);
}
