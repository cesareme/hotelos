/**
 * Finanzas · USALI por centro de coste y headcount importado (Tanda 6c · L2) ·
 * integration (in-process services over Postgres; no HTTP).
 *
 * An ISOLATED organisation `org_ucc_<run>` created and deleted by the suite:
 * chart provisioned with provisionOrganizationChart, one hotel centre and one
 * office centre, two `usali` cost centres (ROOMS, ADMIN_GENERAL) plus an
 * `operating` one, journal entries posted straight into the ledger with
 * `cost_center_id` on their lines (synthetic figures, never people), and —
 * later in the suite — one posted payroll-cost import with lines and
 * references (aggregates only).
 *
 * What it proves:
 *   · `accountBalances` without the flag keeps its plain SQL (one row per
 *     account, no `costCentre` key); with `byCostCentre: true` the SQL reader
 *     partitions by (cost centre type, code), orders `a.code, cost_centre_code
 *     NULLS FIRST` and every partition adds up to the plain balance;
 *   · `buildUsaliPnl` routes labor / other_expense to the department of the
 *     `usali` cost centre (rooms.labor 1.300, admin_general.labor 820 incl.
 *     the `operating` centre and the line without centre, rooms.otherExpense
 *     80) with GOP and PGC reconciliation identical to the unrouted statement;
 *   · `compareUsaliProperties` with `includeCorporate` keeps the rollup;
 *   · headcount: null / [] without payslips or imports (never 0); a draft
 *     import never counts; a posted import gives, per centre and month, the
 *     `employeesReported` of the reference (wins over Σ cell headcount) or Σ
 *     cell headcount, averaged over the months with data (2 decimals);
 *     `headcount()` = Σ averages rounded half-up; a reversed import stops
 *     counting; `statistics.headcount`, `headcountSource` and
 *     `ratios.laborPerEmployee` reach the USALI statement.
 *
 * Everything the suite writes is removed by `cleanup()` (verified by the last
 * test and repeated in `after`). Faranda, org_123 and prop_123 are never
 * touched.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/usali-cost-centre.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

const { prisma } = await import("@hotelos/database");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { prismaFinancialStatementsSource } = await import("../../apps/api/src/modules/financial-statements/source.js");
const { buildUsaliPnl, compareUsaliProperties, computeUsaliPnl } = await import("../../apps/api/src/modules/financial-statements/usali.service.js");

type Line = { code: string; debit?: string; credit?: string; costCenterId?: string | null };

const RUN = Date.now().toString(36);
const ORG = `org_ucc_${RUN}`;
const HOTEL = `prop_ucc_hd_${RUN}`;
const OFFICE = `prop_ucc_oc_${RUN}`;
const MARK = "[usali-cost-centre test]";
const FEB = { from: "2029-02-01", to: "2029-02-28" };
const JAN_FEB = { from: "2029-01-01", to: "2029-02-28" };
const Q1 = { from: "2029-01-01", to: "2029-03-31" };
const APRIL = { from: "2029-04-01", to: "2029-04-30" };

const dayUtc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

const context = () => ({
  organizationId: ORG,
  propertyId: HOTEL,
  userId: "ucc-test-user",
  fullName: "UCC Test",
  deviceId: "ucc-test",
  permissions: ["accounting.read", "accounting.entity.read"] as never
});

let entrySeq = 0;

/** Posts a balanced entry straight into the ledger (fixture; the accounting engine is not this suite's subject). */
async function postEntry(propertyId: string, date: string, description: string, lines: Line[], sourceType = "manual"): Promise<string> {
  const codes = Array.from(new Set(lines.map((l) => l.code)));
  const accounts = await prisma.account.findMany({ where: { organizationId: ORG, code: { in: codes } }, select: { id: true, code: true } });
  const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
  for (const code of codes) assert.ok(idByCode.has(code), `account ${code} missing in ${ORG}`);
  entrySeq += 1;
  const entry = await prisma.journalEntry.create({
    data: {
      organizationId: ORG,
      propertyId,
      sourceType,
      sourceId: `ucc-test:${RUN}:${entrySeq}`,
      status: "posted",
      postedAt: dayUtc(date),
      entryDate: dayUtc(date),
      entryKind: "normal",
      fiscalYearCode: date.slice(0, 4),
      entryNumber: entrySeq,
      description: `${description} ${MARK}`
    }
  });
  await prisma.journalLine.createMany({
    data: lines.map((line) => ({
      journalEntryId: entry.id,
      accountId: idByCode.get(line.code)!,
      accountCode: line.code,
      debit: line.debit ?? "0",
      credit: line.credit ?? "0",
      currency: "EUR",
      costCenterId: line.costCenterId ?? null
    }))
  });
  return entry.id;
}

async function cleanup(): Promise<void> {
  const entryIds = (await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((e) => e.id);
  if (entryIds.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entryIds } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.payrollCostImport.deleteMany({ where: { organizationId: ORG } }); // lines + references cascade
  await prisma.costCenter.deleteMany({ where: { propertyId: { in: [HOTEL, OFFICE] } } });
  await prisma.usaliMapping.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

const dept = <T extends { department: string }>(list: T[], key: string): T => list.find((d) => d.department === key)!;

describe("USALI por centro de coste y headcount importado (org aislada)", () => {
  let ccRooms = "";
  let ccAdmin = "";
  let ccOperating = "";
  let postedImportId = "";

  before(async () => {
    await prisma.organization.create({ data: { id: ORG, name: `USALI CC ${RUN}`, legalName: `USALI CC ${RUN} SL`, taxId: "B12345674" } });
    await prisma.property.create({ data: { id: HOTEL, organizationId: ORG, name: "Hotel Demo", code: "HD", kind: "hotel", address: "Calle Real 1", municipality: "A Coruña", province: "A Coruña" } });
    await prisma.property.create({ data: { id: OFFICE, organizationId: ORG, name: "Oficina central", code: "OC", kind: "office", address: "Calle Real 2", municipality: "A Coruña", province: "A Coruña" } });
    await provisionOrganizationChart(ORG);
    ccRooms = (await prisma.costCenter.create({ data: { propertyId: HOTEL, code: "ROOMS", name: "Habitaciones", type: "usali" } })).id;
    ccAdmin = (await prisma.costCenter.create({ data: { propertyId: HOTEL, code: "ADMIN_GENERAL", name: "Administración y general", type: "usali" } })).id;
    // An `operating` centre with a USALI-looking code (unique per property → it lives under the office): the type guard must ignore it.
    ccOperating = (await prisma.costCenter.create({ data: { propertyId: OFFICE, code: "ROOMS", name: "Habitaciones (operativo)", type: "operating" } })).id;

    // February 2029 · one payroll-cost entry per centre and month: D 640 / D 642 per USALI cost centre, H 465 / H 476.
    await postEntry(
      HOTEL,
      "2029-02-28",
      "Coste de personal 02/2029 · HD (importado)",
      [
        { code: "640", debit: "1000.00", costCenterId: ccRooms },
        { code: "642", debit: "300.00", costCenterId: ccRooms },
        { code: "640", debit: "500.00", costCenterId: ccAdmin },
        { code: "642", debit: "150.00", costCenterId: ccAdmin },
        { code: "465", credit: "1500.00" },
        { code: "476", credit: "450.00" }
      ],
      "payroll_cost_import"
    );
    await postEntry(HOTEL, "2029-02-28", "Gratificación sin centro de coste", [{ code: "640", debit: "150.00" }, { code: "465", credit: "150.00" }]);
    await postEntry(HOTEL, "2029-02-20", "Horas extra (centro operativo)", [{ code: "640", debit: "20.00", costCenterId: ccOperating }, { code: "465", credit: "20.00" }]);
    await postEntry(HOTEL, "2029-02-10", "Factura alojamiento", [{ code: "4300", debit: "2200.00" }, { code: "705.1", credit: "2000.00", costCenterId: ccAdmin }, { code: "477.10", credit: "200.00" }], "invoice");
    await postEntry(HOTEL, "2029-02-15", "Electricidad", [{ code: "628.1", debit: "80.00", costCenterId: ccRooms }, { code: "410", credit: "80.00" }]);
    await postEntry(OFFICE, "2029-02-28", "Nómina oficina", [{ code: "640", debit: "900.00" }, { code: "465", credit: "900.00" }]);
  });

  after(async () => {
    await cleanup();
  });

  // ---- Lector -------------------------------------------------------------------

  it("sin flag el lector agrupa solo por cuenta y las filas no llevan costCentre", async () => {
    const rows = await prismaFinancialStatementsSource.accountBalances({ organizationId: ORG, propertyId: HOTEL, mode: "movements", ...FEB, groups: [6, 7] });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => !("costCentre" in r)));
    assert.equal(rows.filter((r) => r.code === "640").length, 1);
    assert.equal(rows.find((r) => r.code === "640")!.debit.toFixed(2), "1670.00"); // 1.000 + 500 + 150 + 20
    assert.equal(rows.find((r) => r.code === "705.1")!.credit.toFixed(2), "2000.00");
  });

  it("con flag parte cada cuenta por (tipo, código) del centro, ordena por cuenta y código NULLS FIRST, y la partición suma el saldo", async () => {
    const query = { organizationId: ORG, propertyId: HOTEL, mode: "movements" as const, ...FEB, groups: [6, 7] };
    const plain = await prismaFinancialStatementsSource.accountBalances(query);
    const split = await prismaFinancialStatementsSource.accountBalances({ ...query, byCostCentre: true });
    assert.ok(split.every((r) => "costCentre" in r));
    const c640 = split.filter((r) => r.code === "640");
    assert.equal(c640.length, 4);
    assert.deepEqual([c640[0]!.costCentre, c640[0]!.debit.toFixed(2)], [null, "150.00"]);
    assert.deepEqual([c640[1]!.costCentre, c640[1]!.debit.toFixed(2)], [{ type: "usali", code: "ADMIN_GENERAL" }, "500.00"]);
    assert.deepEqual(
      c640
        .slice(2)
        .map((r) => [r.costCentre!.type, r.costCentre!.code, r.debit.toFixed(2)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["operating", "ROOMS", "20.00"],
        ["usali", "ROOMS", "1000.00"]
      ]
    );
    assert.deepEqual(split.find((r) => r.code === "705.1")!.costCentre, { type: "usali", code: "ADMIN_GENERAL" });
    assert.deepEqual(split.find((r) => r.code === "628.1")!.costCentre, { type: "usali", code: "ROOMS" });
    for (const row of plain) {
      const partition = split.filter((r) => r.code === row.code);
      assert.ok(partition.length >= 1, row.code);
      assert.equal(partition.reduce((sum, r) => sum + Number(r.debit.toFixed(2)), 0).toFixed(2), row.debit.toFixed(2), `debe ${row.code}`);
      assert.equal(partition.reduce((sum, r) => sum + Number(r.credit.toFixed(2)), 0).toFixed(2), row.credit.toFixed(2), `haber ${row.code}`);
    }
    assert.deepEqual(split.map((r) => r.code), [...split.map((r) => r.code)].sort((a, b) => a.localeCompare(b)));
  });

  // ---- USALI --------------------------------------------------------------------

  it("buildUsaliPnl enruta labor / other_expense por el centro de coste con GOP y conciliación intactos", async () => {
    const pnl = await buildUsaliPnl({ context: context() as never, propertyId: HOTEL, ...FEB });
    const rooms = dept(pnl.operatingDepartments, "rooms");
    assert.equal(rooms.revenue, "2000.00"); // 705.1 con centro ADMIN_GENERAL: la línea revenue nunca se mueve
    assert.equal(rooms.labor, "1300.00");
    assert.equal(rooms.otherExpense, "80.00"); // 628.1 (utilities.other_expense) imputado a ROOMS
    assert.equal(dept(pnl.undistributed, "admin_general").labor, "820.00"); // 500 + 150 con centro + 150 sin centro + 20 centro operativo
    assert.equal(dept(pnl.undistributed, "utilities").otherExpense, "0.00");
    assert.equal(pnl.gop, "-200.00");
    assert.equal(pnl.netIncome, "-200.00");
    assert.equal(pnl.reconciliation.pgcRevenue, "2000.00");
    assert.equal(pnl.reconciliation.pgcExpense, "2200.00");
    assert.equal(pnl.reconciliation.ok, true);
    assert.deepEqual(
      rooms.accounts.filter((a) => a.line !== "revenue").map((a) => [a.code, a.line, a.amount, a.source]),
      [
        ["628.1", "other_expense", "80.00", "cost_center"],
        ["640", "labor", "1000.00", "cost_center"],
        ["642", "labor", "300.00", "cost_center"]
      ]
    );
    const ag = dept(pnl.undistributed, "admin_general").accounts;
    assert.deepEqual(ag.map((a) => [a.code, a.amount]), [["640", "670.00"], ["642", "150.00"]]); // una fila por cuenta y línea
    assert.ok(ag.every((a) => a.source !== "cost_center"));
    // The unrouted statement over the plain rows gives the same GOP, EBITDA and net income.
    const plainRows = await prismaFinancialStatementsSource.accountBalances({ organizationId: ORG, propertyId: HOTEL, mode: "movements", ...FEB, groups: [6, 7] });
    const unrouted = computeUsaliPnl({ organizationId: ORG, propertyId: HOTEL, propertyName: "Hotel Demo", period: FEB, currency: "EUR", rows: plainRows, mappings: [], occupancy: { roomsInventory: 0, roomsOccupied: 0 } });
    assert.equal(dept(unrouted.operatingDepartments, "rooms").labor, "0.00");
    assert.equal(dept(unrouted.undistributed, "admin_general").labor, "2120.00");
    assert.equal(unrouted.gop, pnl.gop);
    assert.equal(unrouted.ebitda, pnl.ebitda);
    assert.equal(unrouted.netIncome, pnl.netIncome);
    assert.deepEqual(unrouted.reconciliation, pnl.reconciliation);
  });

  it("compareUsaliProperties con includeCorporate: hotel enrutado, oficina en corporate, consolidado fundido y rollup cuadrado", async () => {
    const comparison = await compareUsaliProperties({ context: context() as never, ...FEB, includeCorporate: true });
    assert.deepEqual(comparison.properties.map((p) => p.propertyId), [HOTEL]);
    assert.equal(dept(comparison.properties[0]!.pnl.operatingDepartments, "rooms").labor, "1300.00");
    assert.equal(dept(comparison.corporate!.pnl.undistributed, "admin_general").labor, "900.00");
    assert.equal(dept(comparison.consolidated.operatingDepartments, "rooms").labor, "1300.00");
    assert.equal(dept(comparison.consolidated.undistributed, "admin_general").labor, "1720.00");
    assert.equal(comparison.consolidated.gop, "-1100.00");
    assert.equal(comparison.consolidated.reconciliation.ok, true);
    assert.ok(comparison.rollup!.every((line) => line.ok), comparison.rollup!.map((l) => `${l.metric}:${l.ok}`).join(" "));
  });

  // ---- Headcount ----------------------------------------------------------------

  it("sin recibos de nómina ni lotes contabilizados: headcount null, headcountByProperty [] y el USALI sin headcount (nunca 0)", async () => {
    assert.equal(await prismaFinancialStatementsSource.headcount(ORG, Q1.from, Q1.to), null);
    assert.deepEqual(await prismaFinancialStatementsSource.headcountByProperty(ORG, Q1.from, Q1.to), []);
    const pnl = await buildUsaliPnl({ context: context() as never, propertyId: HOTEL, ...FEB });
    assert.equal(pnl.statistics.headcount, null);
    assert.equal(pnl.statistics.headcountSource, null);
    assert.equal(pnl.ratios.laborPerEmployee, null);
  });

  it("un lote en borrador nunca cuenta", async () => {
    await prisma.payrollCostImport.create({
      data: {
        organizationId: ORG,
        source: "json",
        fileName: "borrador.json",
        contentHash: `ucc-draft-${RUN}`,
        periodFrom: "2029-01",
        periodTo: "2029-03",
        status: "draft",
        rowCount: 1,
        lines: {
          create: [{ organizationId: ORG, propertyId: HOTEL, workCenterLabel: "HOTEL DEMO", costGroup: "operaciones", departmentLabel: "6 PISOS", usaliDepartment: "rooms", periodCode: "2029-02", gross: "100.00", employerSs: "30.00", totalCost: "130.00", headcount: "99.00" }]
        },
        references: { create: [{ organizationId: ORG, propertyId: HOTEL, periodCode: "2029-02", employeesReported: "99.00" }] }
      }
    });
    assert.equal(await prismaFinancialStatementsSource.headcount(ORG, Q1.from, Q1.to), null);
    assert.deepEqual(await prismaFinancialStatementsSource.headcountByProperty(ORG, Q1.from, Q1.to), []);
  });

  it("un lote contabilizado: la referencia prima sobre Σ headcount de las celdas y se promedian los meses con dato", async () => {
    const posted = await prisma.payrollCostImport.create({
      data: {
        organizationId: ORG,
        source: "informe_rrhh",
        fileName: "nomina-2029-ene-mar.json",
        contentHash: `ucc-posted-${RUN}`,
        periodFrom: "2029-01",
        periodTo: "2029-03",
        status: "posted",
        postedAt: new Date(),
        rowCount: 5,
        lines: {
          create: [
            // 2029-01 · Σ celdas 10 (una persona en dos grupos) · referencia 8 → gana la referencia
            { organizationId: ORG, propertyId: HOTEL, workCenterLabel: "HOTEL DEMO", costGroup: "operaciones", departmentLabel: "6 PISOS", usaliDepartment: "rooms", periodCode: "2029-01", gross: "600.00", employerSs: "180.00", totalCost: "780.00", headcount: "6.00" },
            { organizationId: ORG, propertyId: HOTEL, workCenterLabel: "HOTEL DEMO", costGroup: "estructura", departmentLabel: "ADMINISTRACION", usaliDepartment: "admin_general", periodCode: "2029-01", gross: "400.00", employerSs: "120.00", totalCost: "520.00", headcount: "4.00" },
            // 2029-02 · Σ celdas 12 · la referencia del mes no trae empleados → Σ celdas
            { organizationId: ORG, propertyId: HOTEL, workCenterLabel: "HOTEL DEMO", costGroup: "operaciones", departmentLabel: "6 PISOS", usaliDepartment: "rooms", periodCode: "2029-02", gross: "700.00", employerSs: "210.00", totalCost: "910.00", headcount: "7.00" },
            { organizationId: ORG, propertyId: HOTEL, workCenterLabel: "HOTEL DEMO", costGroup: "estructura", departmentLabel: "ADMINISTRACION", usaliDepartment: "admin_general", periodCode: "2029-02", gross: "500.00", employerSs: "150.00", totalCost: "650.00", headcount: "5.00" },
            // 2029-03 · Σ celdas 4 · referencia 4
            { organizationId: ORG, propertyId: HOTEL, workCenterLabel: "HOTEL DEMO", costGroup: "operaciones", departmentLabel: "6 PISOS", usaliDepartment: "rooms", periodCode: "2029-03", gross: "400.00", employerSs: "120.00", totalCost: "520.00", headcount: "4.00" }
          ]
        },
        references: {
          create: [
            { organizationId: ORG, propertyId: HOTEL, periodCode: "2029-01", employeesReported: "8.00", roomsAvailableReported: 20, netSalesReported: "5000.00" },
            { organizationId: ORG, propertyId: HOTEL, periodCode: "2029-02", employeesReported: null, roomsAvailableReported: 20, netSalesReported: "6000.00" },
            { organizationId: ORG, propertyId: HOTEL, periodCode: "2029-03", employeesReported: "4.00", roomsAvailableReported: 20, netSalesReported: "4000.00" },
            // The office only reports people (no cost cells): the reference alone gives its month.
            { organizationId: ORG, propertyId: OFFICE, periodCode: "2029-02", employeesReported: "2.50" }
          ]
        }
      }
    });
    postedImportId = posted.id;
    // Q1: hotel (8 + 12 + 4) / 3 = 8 · office 2,5 → Σ 10,5 → 11 (half-up)
    assert.deepEqual(await prismaFinancialStatementsSource.headcountByProperty(ORG, Q1.from, Q1.to), [
      { propertyId: HOTEL, headcount: 8, source: "payroll_cost_import" },
      { propertyId: OFFICE, headcount: 2.5, source: "payroll_cost_import" }
    ]);
    assert.equal(await prismaFinancialStatementsSource.headcount(ORG, Q1.from, Q1.to), 11);
    // January–February: hotel (8 + 12) / 2 = 10 · office 2,5 → 12,5 → 13
    assert.deepEqual(await prismaFinancialStatementsSource.headcountByProperty(ORG, JAN_FEB.from, JAN_FEB.to), [
      { propertyId: HOTEL, headcount: 10, source: "payroll_cost_import" },
      { propertyId: OFFICE, headcount: 2.5, source: "payroll_cost_import" }
    ]);
    assert.equal(await prismaFinancialStatementsSource.headcount(ORG, JAN_FEB.from, JAN_FEB.to), 13);
    // March only: hotel 4 (reference), no office → 4
    assert.deepEqual(await prismaFinancialStatementsSource.headcountByProperty(ORG, "2029-03-01", "2029-03-31"), [{ propertyId: HOTEL, headcount: 4, source: "payroll_cost_import" }]);
    assert.equal(await prismaFinancialStatementsSource.headcount(ORG, "2029-03-01", "2029-03-31"), 4);
    // A window the lot does not cover: nothing (never 0).
    assert.deepEqual(await prismaFinancialStatementsSource.headcountByProperty(ORG, APRIL.from, APRIL.to), []);
    assert.equal(await prismaFinancialStatementsSource.headcount(ORG, APRIL.from, APRIL.to), null);
  });

  it("el USALI publica el headcount importado y el coste de personal por empleado", async () => {
    const hotel = await buildUsaliPnl({ context: context() as never, propertyId: HOTEL, ...JAN_FEB });
    assert.equal(hotel.statistics.headcount, 10);
    assert.equal(hotel.statistics.headcountSource, "payroll_cost_import");
    assert.equal(hotel.ratios.laborPerEmployee, "212.00"); // (1.300 + 820) / 10
    const society = await buildUsaliPnl({ context: context() as never, propertyId: null, ...JAN_FEB });
    assert.equal(society.statistics.headcount, 13); // 10 + 2,5 → 13
    assert.equal(society.statistics.headcountSource, "payroll_cost_import");
    assert.equal(society.ratios.laborPerEmployee, "232.31"); // (2.120 + 900) / 13
    const comparison = await compareUsaliProperties({ context: context() as never, ...JAN_FEB, includeCorporate: true, allocation: "headcount" });
    assert.equal(comparison.properties[0]!.pnl.statistics.headcount, 10);
    assert.equal(comparison.corporate!.pnl.statistics.headcount, 3); // 2,5 → 3
    assert.equal(comparison.consolidated.statistics.headcount, 13);
    assert.equal(comparison.allocation!.method, "headcount");
    assert.equal(comparison.allocation!.applied, true);
    assert.deepEqual(comparison.allocation!.shares.map((s) => [s.propertyId, s.amount]), [[HOTEL, "900.00"]]); // the only hotel takes the whole corporate cost
  });

  it("un lote revertido deja de contar", async () => {
    await prisma.payrollCostImport.update({ where: { id: postedImportId }, data: { status: "reversed", reversedAt: new Date(), reversalReason: "prueba" } });
    assert.deepEqual(await prismaFinancialStatementsSource.headcountByProperty(ORG, Q1.from, Q1.to), []);
    assert.equal(await prismaFinancialStatementsSource.headcount(ORG, Q1.from, Q1.to), null);
    const pnl = await buildUsaliPnl({ context: context() as never, propertyId: HOTEL, ...JAN_FEB });
    assert.equal(pnl.statistics.headcount, null);
    assert.equal(pnl.ratios.laborPerEmployee, null);
  });

  // ---- Limpieza ---------------------------------------------------------------------

  it("la limpieza no deja rastro de la organización de prueba", async () => {
    await cleanup();
    assert.equal(await prisma.organization.count({ where: { id: ORG } }), 0);
    assert.equal(await prisma.property.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.account.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.costCenter.count({ where: { propertyId: { in: [HOTEL, OFFICE] } } }), 0);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.payrollCostImport.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.payrollCostLine.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.payrollCostReference.count({ where: { organizationId: ORG } }), 0);
  });
});
