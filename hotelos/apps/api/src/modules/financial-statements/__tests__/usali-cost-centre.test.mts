// USALI por centro de coste y headcount importado (Tanda 6c · L2), sobre el
// origen en memoria: partición del lector por centro de coste
// (`byCostCentre`), enrutado de `labor` / `other_expense` al departamento del
// centro (`routeByCostCentre`), fusión de cuentas en el drawer, `mergeRows`
// con centro, invariantes GOP / EBITDA / conciliación con y sin flag, y el
// headcount importado (media mensual, estadísticas, coste de personal por
// empleado y clave de reparto). Cifras sintéticas; nunca datos por persona.
// Ejecutar desde apps/api:
//   node --import tsx --test src/modules/financial-statements/__tests__/usali-cost-centre.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import type { UserContext } from "../../../lib/demo-store.js";
import { averageMonthlyHeadcount, compareAccountBalanceRows, type AccountBalanceRow, type HeadcountByProperty } from "../source.js";
import type { ResolvedUsali } from "../usali-mapping.service.js";
import { buildUsaliPnl, compareUsaliProperties, computeUsaliPnl, mergeRows, routeByCostCentre, usaliHeadcountOf } from "../usali.service.js";
import { MemorySource, referenceLedger, testIdentity, testProperty } from "./memory-source.mts";

const HD = "prop_hd";
const PERIOD = { from: "2029-02-01", to: "2029-02-28" };
const D = (value: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(value);
const ctx: UserContext = {
  organizationId: "org_t",
  propertyId: HD,
  userId: "usr_t",
  fullName: "Directora",
  deviceId: "test",
  permissions: ["accounting.read", "accounting.entity.read"] as UserContext["permissions"]
};

/**
 * Un hotel con coste de personal importado: un asiento por centro y mes con
 * D 640 / D 642 por centro de coste USALI (ROOMS 1.000 + 300; ADMIN_GENERAL
 * 500 + 150), una gratificación sin centro (640 150 → mapeo de la cuenta),
 * una factura con centro de coste en la línea de ingresos (nunca se mueve) y
 * un suministro (628.1 → utilities.other_expense) imputado a ROOMS.
 * Esperado con flag: rooms.labor 1.300 · admin_general.labor 800 ·
 * rooms.otherExpense 80 · GOP −180 con o sin flag.
 */
function hotelWithCostCentres(): MemorySource {
  const s = new MemorySource("org_t");
  s.identity = testIdentity();
  s.props = [testProperty({ id: HD, name: "Hotel Demo", code: "HD" })];
  s.occupancyFacts = { roomsInventory: 20, roomsOccupied: 280 };
  s.costCentre("cc_rooms", { type: "usali", code: "ROOMS" });
  s.costCentre("cc_ag", { type: "usali", code: "ADMIN_GENERAL" });
  s.post({
    date: "2029-02-28",
    propertyId: HD,
    sourceType: "payroll_cost_import",
    sourceId: "imp_1:prop_hd:2029-02",
    description: "Coste de personal 02/2029 · HD (importado)",
    lines: [
      { code: "640", debit: "1000.00", costCenterId: "cc_rooms" },
      { code: "642", debit: "300.00", costCenterId: "cc_rooms" },
      { code: "640", debit: "500.00", costCenterId: "cc_ag" },
      { code: "642", debit: "150.00", costCenterId: "cc_ag" },
      { code: "465", credit: "1500.00" },
      { code: "476", credit: "450.00" }
    ]
  });
  s.post({ date: "2029-02-28", propertyId: HD, description: "Gratificación sin centro de coste", lines: [{ code: "640", debit: "150.00" }, { code: "465", credit: "150.00" }] });
  s.post({ date: "2029-02-10", propertyId: HD, sourceType: "invoice", description: "Factura alojamiento", lines: [{ code: "4300", debit: "2200.00" }, { code: "705.1", credit: "2000.00", costCenterId: "cc_ag" }, { code: "477.10", credit: "200.00" }] });
  s.post({ date: "2029-02-15", propertyId: HD, description: "Electricidad", lines: [{ code: "628.1", debit: "80.00", costCenterId: "cc_rooms" }, { code: "410", credit: "80.00" }] });
  return s;
}

async function hotelRows(s: MemorySource, byCostCentre: boolean): Promise<AccountBalanceRow[]> {
  return s.accountBalances({ organizationId: "org_t", propertyId: HD, mode: "movements", ...PERIOD, groups: [6, 7], byCostCentre });
}

function pnlOf(s: MemorySource, rows: AccountBalanceRow[]) {
  return computeUsaliPnl({ organizationId: "org_t", propertyId: HD, propertyName: "Hotel Demo", period: PERIOD, currency: "EUR", rows, mappings: [], occupancy: s.occupancyFacts });
}

const resolvedLabor: ResolvedUsali = { usaliDepartment: "admin_general", usaliLine: "labor", source: "template", mappingId: null, issue: null };

describe("routeByCostCentre (pura)", () => {
  it("mueve labor al departamento de un centro usali que la admite, con origen cost_center", () => {
    const routed = routeByCostCentre({ costCentre: { type: "usali", code: "ROOMS" } }, resolvedLabor);
    assert.equal(routed.usaliDepartment, "rooms");
    assert.equal(routed.usaliLine, "labor");
    assert.equal(routed.source, "cost_center");
    const other = routeByCostCentre({ costCentre: { type: "usali", code: "ROOMS" } }, { ...resolvedLabor, usaliDepartment: "utilities", usaliLine: "other_expense" });
    assert.equal(other.usaliDepartment, "rooms");
    assert.equal(other.source, "cost_center");
  });

  it("conserva el origen del mapeo cuando el centro coincide con el departamento resuelto", () => {
    const routed = routeByCostCentre({ costCentre: { type: "usali", code: "ADMIN_GENERAL" } }, resolvedLabor);
    assert.deepEqual(routed, resolvedLabor);
  });

  it("no mueve nada sin centro, con centro operating / cost, con código desconocido o con un departamento que no admite la línea", () => {
    assert.deepEqual(routeByCostCentre({ costCentre: null }, resolvedLabor), resolvedLabor);
    assert.deepEqual(routeByCostCentre({}, resolvedLabor), resolvedLabor);
    assert.deepEqual(routeByCostCentre({ costCentre: { type: "operating", code: "ROOMS" } }, resolvedLabor), resolvedLabor);
    assert.deepEqual(routeByCostCentre({ costCentre: { type: "cost", code: "FNB" } }, resolvedLabor), resolvedLabor);
    assert.deepEqual(routeByCostCentre({ costCentre: { type: "usali", code: "SPA" } }, resolvedLabor), resolvedLabor);
    assert.deepEqual(routeByCostCentre({ costCentre: { type: "usali", code: "constructor" } }, resolvedLabor), resolvedLabor);
    assert.deepEqual(routeByCostCentre({ costCentre: { type: "usali", code: "UTILITIES" } }, resolvedLabor), resolvedLabor); // utilities.labor no admitida
    assert.deepEqual(routeByCostCentre({ costCentre: { type: "usali", code: "MISC_INCOME" } }, resolvedLabor), resolvedLabor);
    assert.deepEqual(routeByCostCentre({ costCentre: { type: "usali", code: "MANAGEMENT_FEES" } }, resolvedLabor), resolvedLabor);
  });

  it("nunca mueve ingresos, coste de ventas, honorarios, no operativos ni bajo EBITDA, y una cuenta sin mapeo sigue «Sin asignar»", () => {
    const rooms = { costCentre: { type: "usali", code: "FNB" } };
    const revenue: ResolvedUsali = { ...resolvedLabor, usaliDepartment: "rooms", usaliLine: "revenue" };
    assert.deepEqual(routeByCostCentre(rooms, revenue), revenue);
    const cos: ResolvedUsali = { ...resolvedLabor, usaliDepartment: "fnb", usaliLine: "cost_of_sales" };
    assert.deepEqual(routeByCostCentre({ costCentre: { type: "usali", code: "ROOMS" } }, cos), cos);
    const fee: ResolvedUsali = { ...resolvedLabor, usaliDepartment: "management_fees", usaliLine: "management_fee" };
    assert.deepEqual(routeByCostCentre(rooms, fee), fee);
    const rent: ResolvedUsali = { ...resolvedLabor, usaliDepartment: "non_operating", usaliLine: "rent" };
    assert.deepEqual(routeByCostCentre(rooms, rent), rent);
    const interest: ResolvedUsali = { ...resolvedLabor, usaliDepartment: "below_ebitda", usaliLine: "interest" };
    assert.deepEqual(routeByCostCentre(rooms, interest), interest);
    const none: ResolvedUsali = { usaliDepartment: null, usaliLine: null, source: "none", mappingId: null, issue: "sin mapeo" };
    assert.deepEqual(routeByCostCentre(rooms, none), none);
  });
});

describe("lector por centro de coste (MemorySource)", () => {
  it("sin flag las filas no llevan costCentre y agrupan solo por cuenta; con flag se parten por (type, code) y suman lo mismo", async () => {
    const s = hotelWithCostCentres();
    const plain = await hotelRows(s, false);
    assert.ok(plain.every((row) => !("costCentre" in row)));
    assert.equal(plain.find((r) => r.code === "640")!.debit.toFixed(2), "1650.00");
    const split = await hotelRows(s, true);
    assert.ok(split.every((row) => "costCentre" in row));
    assert.deepEqual(split.filter((r) => r.code === "640").map((r) => r.costCentre?.code ?? null), [null, "ADMIN_GENERAL", "ROOMS"]); // NULLS FIRST, luego código
    assert.deepEqual(split.filter((r) => r.code === "640").map((r) => r.debit.toFixed(2)), ["150.00", "500.00", "1000.00"]);
    for (const row of plain) {
      const partition = split.filter((r) => r.code === row.code);
      assert.equal(partition.reduce((sum, r) => sum.plus(r.debit), D(0)).toFixed(2), row.debit.toFixed(2), `partición de ${row.code}`);
      assert.equal(partition.reduce((sum, r) => sum.plus(r.credit), D(0)).toFixed(2), row.credit.toFixed(2), `partición de ${row.code}`);
    }
    assert.deepEqual([...split].sort(compareAccountBalanceRows).map((r) => `${r.code}|${r.costCentre?.code ?? "-"}`), split.map((r) => `${r.code}|${r.costCentre?.code ?? "-"}`));
  });

  it("el libro de referencia da las mismas cifras con y sin flag (rooms.labor 1.300 por mapeo de 640.1 / 642.1, sin centros)", async () => {
    const s = referenceLedger();
    const query = { organizationId: "org_t", propertyId: "prop_t", mode: "movements" as const, from: "2027-01-01", to: "2027-03-31", groups: [6, 7] };
    const plain = await s.accountBalances(query);
    const split = await s.accountBalances({ ...query, byCostCentre: true });
    assert.equal(split.length, plain.length);
    assert.ok(split.every((row) => row.costCentre === null));
    const compute = (rows: AccountBalanceRow[]) => computeUsaliPnl({ organizationId: "org_t", propertyId: "prop_t", propertyName: "Hotel Test", period: { from: "2027-01-01", to: "2027-03-31" }, currency: "EUR", rows, mappings: [], occupancy: s.occupancyFacts });
    const a = compute(plain);
    const b = compute(split);
    assert.equal(b.operatingDepartments.find((d) => d.department === "rooms")!.labor, "1300.00");
    assert.deepEqual({ ...b, generatedAt: "" }, { ...a, generatedAt: "" });
  });
});

describe("computeUsaliPnl con centros de coste", () => {
  it("enruta labor / other_expense al departamento del centro: rooms.labor 1.300, admin_general.labor 800, rooms.otherExpense 80", async () => {
    const s = hotelWithCostCentres();
    const pnl = pnlOf(s, await hotelRows(s, true));
    const rooms = pnl.operatingDepartments.find((d) => d.department === "rooms")!;
    assert.equal(rooms.revenue, "2000.00"); // 705.1 con centro ADMIN_GENERAL: la línea revenue nunca se mueve
    assert.equal(rooms.labor, "1300.00");
    assert.equal(rooms.otherExpense, "80.00"); // 628.1 (utilities.other_expense) imputado a ROOMS: rooms admite other_expense
    assert.equal(rooms.departmentalProfit, "620.00");
    const ag = pnl.undistributed.find((d) => d.department === "admin_general")!;
    assert.equal(ag.labor, "800.00"); // 500 + 150 con centro ADMIN_GENERAL + 150 sin centro
    const utilities = pnl.undistributed.find((d) => d.department === "utilities")!;
    assert.equal(utilities.otherExpense, "0.00");
    assert.equal(pnl.gop, "-180.00");
    assert.equal(pnl.reconciliation.pgcExpense, "2180.00");
    assert.equal(pnl.reconciliation.ok, true);
  });

  it("el drawer muestra UNA fila por cuenta y línea, con origen cost_center solo en lo enrutado", async () => {
    const s = hotelWithCostCentres();
    const pnl = pnlOf(s, await hotelRows(s, true));
    const rooms = pnl.operatingDepartments.find((d) => d.department === "rooms")!;
    // La cuenta en memoria guarda el USALI de la plantilla → origen «account»; solo lo enrutado lleva «cost_center».
    assert.deepEqual(
      rooms.accounts.map((a) => [a.code, a.line, a.amount, a.source]),
      [
        ["628.1", "other_expense", "80.00", "cost_center"],
        ["640", "labor", "1000.00", "cost_center"],
        ["642", "labor", "300.00", "cost_center"],
        ["705.1", "revenue", "2000.00", "account"]
      ]
    );
    const ag = pnl.undistributed.find((d) => d.department === "admin_general")!;
    assert.deepEqual(
      ag.accounts.map((a) => [a.code, a.line, a.amount, a.source]),
      [
        ["640", "labor", "650.00", "account"],
        ["642", "labor", "150.00", "account"]
      ]
    );
    assert.equal(pnl.operatingDepartments.find((d) => d.department === "rooms")!.accounts.filter((a) => a.code === "640").length, 1);
  });

  it("GOP, EBITDA, resultado y conciliación son idénticos con y sin flag: solo cambia el reparto de labor entre departamentos", async () => {
    const s = hotelWithCostCentres();
    const withFlag = pnlOf(s, await hotelRows(s, true));
    const withoutFlag = pnlOf(s, await hotelRows(s, false));
    assert.equal(withoutFlag.operatingDepartments.find((d) => d.department === "rooms")!.labor, "0.00");
    assert.equal(withoutFlag.undistributed.find((d) => d.department === "admin_general")!.labor, "2100.00");
    assert.equal(withoutFlag.undistributed.find((d) => d.department === "utilities")!.otherExpense, "80.00");
    // Mover labor de A&G (no distribuido) a Habitaciones cambia el beneficio departamental y los no distribuidos en la misma cuantía: GOP, EBITDA y resultado no.
    for (const key of ["totalOperatingRevenue", "gop", "managementFees", "ebitda", "netIncome"] as const) {
      assert.equal(withFlag[key], withoutFlag[key], key);
    }
    assert.equal(withFlag.totalDepartmentalExpenses, "1380.00");
    assert.equal(withoutFlag.totalDepartmentalExpenses, "0.00");
    assert.equal(withFlag.totalUndistributed, "800.00");
    assert.equal(withoutFlag.totalUndistributed, "2180.00");
    assert.equal(withFlag.gop, "-180.00");
    assert.deepEqual(withFlag.reconciliation, withoutFlag.reconciliation);
    assert.deepEqual(withFlag.unassigned, withoutFlag.unassigned);
  });

  it("centros operating / cost y un usali que no admite la línea dejan el importe donde diga el mapeo; una cuenta sin mapeo con centro sigue «Sin asignar» una sola vez", async () => {
    const s = hotelWithCostCentres();
    s.costCentre("cc_op", { type: "operating", code: "ROOMS" });
    s.costCentre("cc_util", { type: "usali", code: "UTILITIES" });
    s.account("645", { name: "Retribuciones en especie", kind: "expense", usaliDepartment: null, usaliLine: null });
    s.post({ date: "2029-02-20", propertyId: HD, description: "Horas extra", lines: [{ code: "640", debit: "20.00", costCenterId: "cc_op" }, { code: "640", debit: "30.00", costCenterId: "cc_util" }, { code: "465", credit: "50.00" }] });
    s.post({ date: "2029-02-21", propertyId: HD, description: "Retribución en especie", lines: [{ code: "645", debit: "7.00", costCenterId: "cc_rooms" }, { code: "645", debit: "3.00" }, { code: "572", credit: "10.00" }] });
    const pnl = pnlOf(s, await hotelRows(s, true));
    assert.equal(pnl.operatingDepartments.find((d) => d.department === "rooms")!.labor, "1300.00");
    assert.equal(pnl.undistributed.find((d) => d.department === "admin_general")!.labor, "850.00");
    assert.deepEqual(pnl.unassigned.accounts.map((a) => [a.code, a.amount]), [["645", "10.00"]]);
    assert.equal(pnl.unassigned.expense, "10.00");
    assert.equal(pnl.reconciliation.ok, true);
  });
});

describe("mergeRows con centro de coste", () => {
  it("fusiona por code|type|code conservando costCentre, y las filas sin centro por cuenta", async () => {
    const ra: AccountBalanceRow[] = [
      { code: "640", name: "Sueldos", kind: "expense", isPostable: true, usaliDepartment: "admin_general", usaliLine: "labor", debit: D("300.00"), credit: D(0), costCentre: { type: "usali", code: "ROOMS" } },
      { code: "640", name: "Sueldos", kind: "expense", isPostable: true, usaliDepartment: "admin_general", usaliLine: "labor", debit: D("40.00"), credit: D(0), costCentre: null }
    ];
    const lt: AccountBalanceRow[] = [
      { code: "640", name: "Sueldos", kind: "expense", isPostable: true, usaliDepartment: "admin_general", usaliLine: "labor", debit: D("200.00"), credit: D(0), costCentre: { type: "usali", code: "ROOMS" } },
      { code: "640", name: "Sueldos", kind: "expense", isPostable: true, usaliDepartment: "admin_general", usaliLine: "labor", debit: D("10.00"), credit: D(0), costCentre: { type: "usali", code: "FNB" } }
    ];
    const merged = mergeRows([ra, lt]);
    assert.deepEqual(
      merged.map((r) => [r.code, r.costCentre?.code ?? null, r.debit.toFixed(2)]),
      [
        ["640", null, "40.00"],
        ["640", "FNB", "10.00"],
        ["640", "ROOMS", "500.00"]
      ]
    );
    // El consolidado de un subconjunto sigue enrutando por el centro conservado.
    const pnl = computeUsaliPnl({ organizationId: "org_t", propertyId: null, propertyName: "RA + LT", period: PERIOD, currency: "EUR", rows: merged, mappings: [], occupancy: { roomsInventory: 0, roomsOccupied: 0 } });
    assert.equal(pnl.operatingDepartments.find((d) => d.department === "rooms")!.labor, "500.00");
    assert.equal(pnl.operatingDepartments.find((d) => d.department === "fnb")!.labor, "10.00");
    assert.equal(pnl.undistributed.find((d) => d.department === "admin_general")!.labor, "40.00");
    // Sin centros, el comportamiento previo: una fila por cuenta.
    const s = referenceLedger();
    const rows = await s.accountBalances({ organizationId: "org_t", mode: "movements", from: "2027-01-01", to: "2027-03-31", groups: [6, 7] });
    assert.equal(mergeRows([rows, rows]).length, rows.length);
  });
});

describe("headcount importado", () => {
  it("averageMonthlyHeadcount: media de los meses con dato a dos decimales; null sin datos (nunca 0)", () => {
    assert.equal(averageMonthlyHeadcount([10, 12]), 11);
    assert.equal(averageMonthlyHeadcount([]), null);
    assert.equal(averageMonthlyHeadcount(["10.5", "12"]), 11.25);
    assert.equal(averageMonthlyHeadcount([10, 11, 11]), 10.67);
    assert.equal(averageMonthlyHeadcount([0, 0]), 0);
    assert.equal(averageMonthlyHeadcount(["16.00"]), 16);
  });

  it("usaliHeadcountOf: suma los centros seleccionados en personas enteras (medio arriba), null sin filas; null en la lista selecciona «sin centro»", () => {
    const rows: HeadcountByProperty = [
      { propertyId: "ra", headcount: 11.4, source: "payroll_cost_import" },
      { propertyId: "oc", headcount: 2.5, source: "payroll_cost_import" },
      { propertyId: null, headcount: 3, source: "payroll_slips" }
    ];
    assert.deepEqual(usaliHeadcountOf(rows, ["ra"]), { value: 11, source: "payroll_cost_import" });
    assert.deepEqual(usaliHeadcountOf(rows, ["ra", "oc"]), { value: 14, source: "payroll_cost_import" }); // 13,9 → 14
    assert.deepEqual(usaliHeadcountOf(rows, null), { value: 17, source: "payroll_slips" }); // 16,9 → 17; fuentes mixtas → recibos
    assert.deepEqual(usaliHeadcountOf(rows, [null]), { value: 3, source: "payroll_slips" });
    assert.equal(usaliHeadcountOf(rows, ["lt"]), null);
    assert.equal(usaliHeadcountOf([], null), null);
    assert.equal(usaliHeadcountOf([{ propertyId: "ra", headcount: 0.2, source: "payroll_cost_import" }], null), null); // redondea a 0 → sin datos
    assert.deepEqual(usaliHeadcountOf([{ propertyId: "ra", headcount: 4 }], ["ra"]), { value: 4, source: "payroll_slips" }); // filas pre-6c sin source
  });

  it("computeUsaliPnl publica statistics.headcount / headcountSource y ratios.laborPerEmployee = Σ labor / headcount", async () => {
    const s = hotelWithCostCentres();
    const rows = await hotelRows(s, true);
    const base = { organizationId: "org_t", propertyId: HD, propertyName: "Hotel Demo", period: PERIOD, currency: "EUR", rows, mappings: [], occupancy: s.occupancyFacts };
    const withHeadcount = computeUsaliPnl({ ...base, headcount: { value: 10, source: "payroll_cost_import" } });
    assert.equal(withHeadcount.statistics.headcount, 10);
    assert.equal(withHeadcount.statistics.headcountSource, "payroll_cost_import");
    assert.equal(withHeadcount.ratios.laborPerEmployee, "210.00"); // (1.300 + 800) / 10
    const without = computeUsaliPnl(base);
    assert.equal(without.statistics.headcount, null);
    assert.equal(without.statistics.headcountSource, null);
    assert.equal(without.ratios.laborPerEmployee, null);
    const explicitNull = computeUsaliPnl({ ...base, headcount: null });
    assert.equal(explicitNull.ratios.laborPerEmployee, null);
  });

  it("buildUsaliPnl lee headcountByProperty una vez y publica el headcount del centro (o de la sociedad)", async () => {
    const s = hotelWithCostCentres();
    s.peopleByProperty = [{ propertyId: HD, headcount: 11, source: "payroll_cost_import" }];
    const hotel = await buildUsaliPnl({ context: ctx, propertyId: HD, ...PERIOD, source: s });
    assert.equal(hotel.statistics.headcount, 11);
    assert.equal(hotel.statistics.headcountSource, "payroll_cost_import");
    assert.equal(hotel.ratios.laborPerEmployee, "190.91"); // 2.100 / 11
    assert.equal(hotel.operatingDepartments.find((d) => d.department === "rooms")!.labor, "1300.00");
    const society = await buildUsaliPnl({ context: ctx, propertyId: null, ...PERIOD, source: s });
    assert.equal(society.statistics.headcount, 11);
    s.peopleByProperty = [];
    const empty = await buildUsaliPnl({ context: ctx, propertyId: HD, ...PERIOD, source: s });
    assert.equal(empty.statistics.headcount, null);
    assert.equal(empty.ratios.laborPerEmployee, null);
  });
});

describe("compareUsaliProperties con centros de coste y headcount (una sola lectura)", () => {
  const RA = "prop_ra";
  const LT = "prop_lt";
  const OC = "prop_oc";
  const SOCIEDAD = { from: "2028-03-01", to: "2028-03-31" };
  const sociedadCtx: UserContext = { ...ctx, propertyId: RA };

  function sociedad(): MemorySource {
    const s = new MemorySource("org_t");
    s.identity = testIdentity({ code: "FAR", legalName: "Faranda Test SA", taxId: "A58818501", legalForm: "sa" });
    s.props = [
      testProperty({ id: OC, name: "Oficina central", code: "OC", kind: "office" }),
      testProperty({ id: RA, name: "Hotel Rías Altas", code: "RA" }),
      testProperty({ id: LT, name: "Hotel Los Tilos", code: "LT" })
    ];
    s.costCentre("cc_ra_rooms", { type: "usali", code: "ROOMS" });
    s.costCentre("cc_lt_rooms", { type: "usali", code: "ROOMS" });
    s.costCentre("cc_oc_ag", { type: "usali", code: "ADMIN_GENERAL" });
    s.peopleByProperty = [
      { propertyId: RA, headcount: 30, source: "payroll_cost_import" },
      { propertyId: LT, headcount: 20, source: "payroll_cost_import" },
      { propertyId: OC, headcount: 5.4, source: "payroll_cost_import" }
    ];
    s.post({ date: "2028-03-05", propertyId: RA, sourceType: "invoice", lines: [{ code: "4300", debit: "1100.00" }, { code: "705.1", credit: "1000.00" }, { code: "477.10", credit: "100.00" }] });
    s.post({ date: "2028-03-31", propertyId: RA, sourceType: "payroll_cost_import", lines: [{ code: "640", debit: "300.00", costCenterId: "cc_ra_rooms" }, { code: "465", credit: "300.00" }] });
    s.post({ date: "2028-03-06", propertyId: LT, sourceType: "invoice", lines: [{ code: "4300", debit: "550.00" }, { code: "705.1", credit: "500.00" }, { code: "477.10", credit: "50.00" }] });
    s.post({ date: "2028-03-31", propertyId: LT, sourceType: "payroll_cost_import", lines: [{ code: "640", debit: "200.00", costCenterId: "cc_lt_rooms" }, { code: "465", credit: "200.00" }] });
    s.post({ date: "2028-03-31", propertyId: OC, sourceType: "payroll_cost_import", lines: [{ code: "640", debit: "900.00", costCenterId: "cc_oc_ag" }, { code: "465", credit: "900.00" }] });
    s.post({ date: "2028-03-31", propertyId: null, description: "Intereses bancarios (sociedad)", lines: [{ code: "662", debit: "10.00" }, { code: "572", credit: "10.00" }] });
    return s;
  }

  it("cada centro enruta por su centro de coste y el consolidado funde RA/ROOMS y LT/ROOMS en una fila ROOMS", async () => {
    const comparison = await compareUsaliProperties({ context: sociedadCtx, ...SOCIEDAD, source: sociedad() });
    const ra = comparison.properties.find((p) => p.propertyId === RA)!.pnl;
    assert.equal(ra.operatingDepartments.find((d) => d.department === "rooms")!.labor, "300.00");
    assert.equal(ra.undistributed.find((d) => d.department === "admin_general")!.labor, "0.00");
    assert.equal(ra.gop, "700.00");
    assert.equal(ra.statistics.headcount, 30);
    assert.equal(ra.ratios.laborPerEmployee, "10.00");
    const lt = comparison.properties.find((p) => p.propertyId === LT)!.pnl;
    assert.equal(lt.operatingDepartments.find((d) => d.department === "rooms")!.labor, "200.00");
    assert.equal(lt.statistics.headcount, 20);
    const oc = comparison.properties.find((p) => p.propertyId === OC)!.pnl;
    assert.equal(oc.undistributed.find((d) => d.department === "admin_general")!.labor, "900.00");
    assert.equal(oc.statistics.headcount, 5);
    const rooms = comparison.consolidated.operatingDepartments.find((d) => d.department === "rooms")!;
    assert.equal(rooms.labor, "500.00");
    assert.deepEqual(rooms.accounts.map((a) => [a.code, a.amount, a.source]), [["640", "500.00", "cost_center"], ["705.1", "1500.00", "account"]]);
    assert.equal(comparison.consolidated.gop, "100.00"); // 700 + 300 − 900
    assert.equal(comparison.consolidated.netIncome, "90.00");
    assert.equal(comparison.consolidated.reconciliation.ok, true);
    assert.equal(comparison.consolidated.statistics.headcount, 55); // 30 + 20 + 5,4 = 55,4
    assert.equal(comparison.consolidated.statistics.headcountSource, "payroll_cost_import");
  });

  it("un subconjunto consolida por mergeRows conservando los centros de coste", async () => {
    const comparison = await compareUsaliProperties({ context: sociedadCtx, ...SOCIEDAD, propertyIds: [RA, LT], source: sociedad() });
    assert.equal(comparison.consolidated.operatingDepartments.find((d) => d.department === "rooms")!.labor, "500.00");
    assert.equal(comparison.consolidated.undistributed.find((d) => d.department === "admin_general")!.labor, "0.00");
    assert.equal(comparison.consolidated.gop, "1000.00");
    assert.equal(comparison.consolidated.statistics.headcount, 50);
  });

  it("con includeCorporate el reparto por headcount usa las mismas filas leídas una vez (RA 30 · LT 20 → 60 % / 40 % de 900)", async () => {
    const source = sociedad();
    let reads = 0;
    const original = source.headcountByProperty.bind(source);
    source.headcountByProperty = async () => {
      reads += 1;
      return original();
    };
    const comparison = await compareUsaliProperties({ context: sociedadCtx, ...SOCIEDAD, includeCorporate: true, allocation: "headcount", source });
    assert.equal(reads, 1);
    assert.equal(comparison.corporate?.pnl.statistics.headcount, 5);
    assert.equal(comparison.corporate?.pnl.undistributed.find((d) => d.department === "admin_general")!.labor, "900.00");
    assert.equal(comparison.unassigned?.statistics.headcount, null);
    assert.equal(comparison.allocation?.method, "headcount");
    assert.equal(comparison.allocation?.applied, true);
    assert.equal(comparison.allocation?.corporateCost, "900.00");
    assert.deepEqual(
      comparison.allocation?.shares.map((s) => [s.propertyId, s.amount]),
      [
        [LT, "360.00"],
        [RA, "540.00"]
      ]
    );
    assert.equal(comparison.properties.find((p) => p.propertyId === RA)!.allocation?.gopAfterAllocation, "160.00");
    assert.ok(comparison.rollup?.every((line) => line.ok), "rollup");
  });
});
