/**
 * Tanda RRHH · PANEL-A — GET /payroll/labor-cost-panel por HTTP (app.inject, Postgres
 * real, tenant AISLADO de helpers/l2-tenant.mts; modo estricto de RBAC sin fallback
 * demo). Dos organizaciones `org_l2_<run>` con usuarios ficticios y cifras sintéticas
 * (nunca personas); en Faranda no se escribe nada; al terminar se borran.
 *
 * Datos del tenant A (hotel A):
 *   · 2025-05: diario Sage-like 64x SIN centro (640 3.000 + 642 900) + 70x 20.000 + 30
 *     cierres `night_audit` (2 habitaciones/noche) y 1 snapshot `demo` (50 habitaciones,
 *     nunca cuenta) → sin_desglose, ventas ledger, RN 60 (mes incompleto);
 *   · 2025-06: lote de coste de personal `posted` (rooms 2.400 · 4 personas, fnb 1.200 ·
 *     2) con referencia (7 empleados, ventas 15.000) y su asiento en el diario
 *     (source_type payroll_cost_import, 640 con centro ROOMS): el diario NO lo cuenta;
 *   · 2025-07: nada → sin datos.
 *   Hotel B: sin nada.
 *
 * Qué prueba:
 *   · 401 sin token; 403 sin payroll.read (recepción); 400 VALIDATION_ERROR (from
 *     ausente, parámetro extra, to < from, mes mal formado);
 *   · sociedad (dirección general): un centro por hotel, mayo por el diario sin
 *     desglose, junio por el lote con departamentos y referencia, julio degradado,
 *     totales = Σ centros, ranking, sources y degraded[];
 *   · centro (manager asignado al hotel A): ámbito property, un solo centro;
 *   · 404 OPACO: el hotel B (fuera del ámbito del manager), un centro de la
 *     organización B y un id inexistente responden lo mismo (estado, mensaje y código);
 *   · sociedad sin accounting.entity.read (manager) → 404 ENTITY_SCOPE_REQUIRED;
 *   · payroll.read sin accounting.read (rol a medida) → 200 sin ingreso por
 *     departamento y con LABOR_PANEL_USALI_FORBIDDEN.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/labor-cost-panel-routes.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Sin .env → valores de CI.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
const configuredKey = process.env.HOTELOS_FIELD_KEY ?? process.env.ENCRYPTION_KEY ?? "";
if (Buffer.from(configuredKey, "base64").length !== 32) process.env.HOTELOS_FIELD_KEY = Buffer.alloc(32, 7).toString("base64");

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { templateRoleMetadata } = await import("../../apps/api/src/lib/rbac-catalog.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { PAYROLL_COST_SOURCE_TYPE } = await import("../../apps/api/src/modules/payroll/cost-import.posting.js");
const { LABOR_PANEL_DEGRADED_CODES } = await import("../../apps/api/src/modules/payroll/labor-cost-panel.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type Reply = { status: number; body: Json; raw: string };
type Line = { code: string; debit?: string; credit?: string; costCenterId?: string | null };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);
const MARK = "[labor-cost-panel test]";
const dayUtc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

async function call(app: ApiApp, url: string, session: Session | null): Promise<Reply> {
  const res = await app.inject({ method: "GET", url, headers: { ...(session?.headers ?? {}) } });
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, raw: res.body };
}

const detailsCode = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;
/** Cuerpo de error sin el `correlationId` (único por petición): lo que debe coincidir entre un id ajeno y uno inexistente. */
const opaque = (reply: Reply): Json => {
  const { correlationId: _corr, ...rest } = reply.body;
  void _corr;
  return rest;
};
const ok = (reply: Reply, label: string): Json => {
  assert.equal(reply.status, 200, `${label}: ${reply.status} ${reply.raw.slice(0, 400)}`);
  return reply.body;
};

type Panel = {
  scope: string;
  legalEntityId: string | null;
  centres: Array<{ propertyId: string; propertyCode: string | null; months: Array<Json & { periodCode: string; departments: Json[] }>; totals: Json }>;
  totals: Json & { byDepartment: Json[] };
  ranking: Array<{ propertyId: string; pctOfSales: string | null }>;
  sources: { ledger: { entries: number; accounts: string[] }; imports: Array<{ importId: string }>; roomNights: Array<{ propertyId: string; source: string }> };
  degraded: Array<{ code: string; propertyId: string | null; periodCode: string | null; message: string }>;
};
const panelOf = (reply: Reply, label: string): Panel => ok(reply, label) as unknown as Panel;
const centreOf = (panel: Panel, propertyId: string) => panel.centres.find((centre) => centre.propertyId === propertyId)!;
const monthOf = (panel: Panel, propertyId: string, periodCode: string) => centreOf(panel, propertyId).months.find((month) => month.periodCode === periodCode)!;

/** Asiento contabilizado directamente en el libro (fixture; el motor de asientos no es el objeto de esta suite). */
async function postEntry(organizationId: string, propertyId: string, date: string, description: string, lines: Line[], sourceType = "manual"): Promise<string> {
  const codes = Array.from(new Set(lines.map((line) => line.code)));
  const accounts = await prisma.account.findMany({ where: { organizationId, code: { in: codes } }, select: { id: true, code: true } });
  const idByCode = new Map(accounts.map((account) => [account.code, account.id]));
  for (const code of codes) assert.ok(idByCode.has(code), `cuenta ${code} ausente en ${organizationId}`);
  const entry = await prisma.journalEntry.create({
    data: {
      organizationId,
      propertyId,
      sourceType,
      sourceId: `lcp-test:${organizationId}:${date}:${description}`,
      status: "posted",
      postedAt: dayUtc(date),
      entryDate: dayUtc(date),
      entryKind: "normal",
      fiscalYearCode: date.slice(0, 4),
      description: `${description} ${MARK}`
    },
    select: { id: true }
  });
  await prisma.journalLine.createMany({
    data: lines.map((line) => ({ journalEntryId: entry.id, accountId: idByCode.get(line.code)!, accountCode: line.code, debit: line.debit ?? "0", credit: line.credit ?? "0", currency: "EUR", costCenterId: line.costCenterId ?? null }))
  });
  return entry.id;
}

/** Usuario extra con una plantilla o con un rol a medida; cuelga de la organización → cleanupTenant lo barre. */
async function addUser(tenant: IsolatedTenant, local: string, spec: { templateKey: string } | { customKeys: string[] }, scope: { scopeType: "organization" | "property"; propertyId?: string }): Promise<{ id: string; email: string }> {
  const id = `usr_lcp_${local}_${tenant.run}`;
  const email = `${local}.lcp.${tenant.run}@faranda.test`;
  await prisma.user.create({ data: { id, organizationId: tenant.organizationId, email, fullName: `LCP ${local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() } });
  let roleId: string;
  if ("templateKey" in spec) {
    roleId = tenant.roles[spec.templateKey]!;
    assert.ok(roleId, `Sin rol de plantilla «${spec.templateKey}» en ${tenant.organizationId}.`);
  } else {
    const role = await prisma.role.create({ data: { organizationId: tenant.organizationId, name: `LCP a medida ${local}`, ...templateRoleMetadata("payroll_hr"), templateKey: null }, select: { id: true } });
    roleId = role.id;
    const permissions = await prisma.permission.findMany({ where: { key: { in: spec.customKeys } }, select: { id: true, key: true } });
    assert.equal(permissions.length, spec.customKeys.length, `claves sin fila en permissions: ${spec.customKeys.filter((k) => !permissions.some((p) => p.key === k)).join(", ")}`);
    await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permissionId: permission.id })), skipDuplicates: true });
  }
  await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: scope.scopeType, propertyId: scope.propertyId ?? null, organizationId: tenant.organizationId, reason: `labor-cost-panel ${local}` } });
  resetRbacScopeCacheForTests();
  return { id, email };
}

describe("PANEL-A · GET /payroll/labor-cost-panel por HTTP", () => {
  let app: ApiApp;
  let A: IsolatedTenant;
  let B: IsolatedTenant;
  let direccion: Session; // general_manager de A (organización: payroll.read + accounting.read + accounting.entity.read)
  let recepcion: Session; // receptionist de A: sin payroll.read
  let gestor: Session; // manager en A.propertyA: payroll.read + accounting.read, sin accounting.entity.read
  let soloNomina: Session; // rol a medida payroll.read (organización): sin accounting.read
  let importId = "";
  let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
  const RANGE = "from=2025-05&to=2025-07";

  before(async () => {
    invariantsBefore = await farandaInvariants();
    app = await buildApiServer();
    A = await createIsolatedTenant(`lcpa${newRunId()}`);
    B = await createIsolatedTenant(`lcpb${newRunId()}`);
    const gestorUser = await addUser(A, "gestor", { templateKey: "manager" }, { scopeType: "property", propertyId: A.propertyA });
    const nominaUser = await addUser(A, "nomina", { customKeys: ["payroll.read"] }, { scopeType: "organization" });
    await strict(async () => {
      direccion = await loginOrThrow(app, A.users.generalManager.email, A.password);
      recepcion = await loginOrThrow(app, A.users.receptionist.email, A.password);
      gestor = await loginOrThrow(app, gestorUser.email, A.password);
      soloNomina = await loginOrThrow(app, nominaUser.email, A.password);
    });

    // Centros de coste USALI del hotel A.
    const ccRooms = (await prisma.costCenter.create({ data: { propertyId: A.propertyA, code: "ROOMS", name: "Habitaciones", type: "usali" }, select: { id: true } })).id;
    const ccFnb = (await prisma.costCenter.create({ data: { propertyId: A.propertyA, code: "FNB", name: "Alimentos y bebidas", type: "usali" }, select: { id: true } })).id;

    // 2025-05 · diario sin centro (Sage-like) + ventas 70x.
    await postEntry(A.organizationId, A.propertyA, "2025-05-31", "Nómina mayo (sin departamento)", [
      { code: "640", debit: "3000.00" },
      { code: "642", debit: "900.00" },
      { code: "465", credit: "3000.00" },
      { code: "476", credit: "900.00" }
    ]);
    await postEntry(A.organizationId, A.propertyA, "2025-05-15", "Ventas alojamiento mayo", [{ code: "4300", debit: "22000.00" }, { code: "705.1", credit: "20000.00" }, { code: "477.10", credit: "2000.00" }], "invoice");
    // Un asiento en borrador y una pareja de reverso NO cuentan.
    const draft = await prisma.journalEntry.create({ data: { organizationId: A.organizationId, propertyId: A.propertyA, sourceType: "manual", sourceId: `lcp-test:draft:${A.run}`, status: "draft", entryDate: dayUtc("2025-05-20"), entryKind: "normal", fiscalYearCode: "2025", description: `Borrador ${MARK}` }, select: { id: true } });
    const account640 = await prisma.account.findFirst({ where: { organizationId: A.organizationId, code: "640" }, select: { id: true } });
    await prisma.journalLine.create({ data: { journalEntryId: draft.id, accountId: account640!.id, accountCode: "640", debit: "99999.00", credit: "0", currency: "EUR" } });
    const original = await postEntry(A.organizationId, A.propertyA, "2025-05-21", "Nómina duplicada (revertida)", [{ code: "640", debit: "77777.00" }, { code: "465", credit: "77777.00" }]);
    const reversal = await postEntry(A.organizationId, A.propertyA, "2025-05-22", "Reverso de la nómina duplicada", [{ code: "640", credit: "77777.00" }, { code: "465", debit: "77777.00" }], "reversal");
    await prisma.journalEntry.update({ where: { id: original }, data: { reversedById: reversal } });
    await prisma.journalEntry.update({ where: { id: reversal }, data: { reversalOfId: original } });

    // 2025-05 · 30 cierres reales (2 habitaciones/noche) + 1 snapshot demo (excluido).
    for (let day = 1; day <= 30; day += 1) {
      await prisma.revenueDailySnapshot.create({ data: { propertyId: A.propertyA, snapshotDate: dayUtc(`2025-05-${String(day).padStart(2, "0")}`), totalOcc: 2, roomRevenue: "200.00", totalRevenue: "200.00", dataSource: "night_audit" } });
    }
    await prisma.revenueDailySnapshot.create({ data: { propertyId: A.propertyA, snapshotDate: dayUtc("2025-05-31"), totalOcc: 50, roomRevenue: "5000.00", totalRevenue: "5000.00", dataSource: "demo" } });

    // 2025-06 · lote de coste de personal contabilizado + su asiento en el diario (source_type payroll_cost_import).
    const imp = await prisma.payrollCostImport.create({
      data: { organizationId: A.organizationId, legalEntityId: A.legalEntityId, source: "json", fileName: "nomina-2025-06.json", contentHash: `lcp-${A.run}`, periodFrom: "2025-06", periodTo: "2025-06", status: "posted", rowCount: 2, totalGross: "2700.00", totalEmployerSs: "900.00", totalCost: "3600.00", postedAt: new Date("2025-07-05T10:00:00Z") },
      select: { id: true }
    });
    importId = imp.id;
    await prisma.payrollCostLine.createMany({
      data: [
        { importId, organizationId: A.organizationId, propertyId: A.propertyA, workCenterLabel: "Hotel A", costGroup: "operaciones", departmentLabel: "Pisos", usaliDepartment: "rooms", costCenterId: ccRooms, periodCode: "2025-06", gross: "1800.00", employerSs: "600.00", totalCost: "2400.00", headcount: "4.00" },
        { importId, organizationId: A.organizationId, propertyId: A.propertyA, workCenterLabel: "Hotel A", costGroup: "operaciones", departmentLabel: "Cocina", usaliDepartment: "fnb", costCenterId: ccFnb, periodCode: "2025-06", gross: "900.00", employerSs: "300.00", totalCost: "1200.00", headcount: "2.00" }
      ]
    });
    await prisma.payrollCostReference.create({ data: { importId, organizationId: A.organizationId, propertyId: A.propertyA, workCenterLabel: "Hotel A", periodCode: "2025-06", employeesReported: "7.00", roomsAvailableReported: 3, netSalesReported: "15000.00" } });
    await postEntry(
      A.organizationId,
      A.propertyA,
      "2025-06-30",
      "Coste de personal 06/2025 · Hotel A (importado)",
      [
        { code: "640", debit: "1800.00", costCenterId: ccRooms },
        { code: "640", debit: "900.00", costCenterId: ccFnb },
        { code: "642", debit: "600.00", costCenterId: ccRooms },
        { code: "642", debit: "300.00", costCenterId: ccFnb },
        { code: "465", credit: "2700.00" },
        { code: "476", credit: "900.00" }
      ],
      PAYROLL_COST_SOURCE_TYPE
    );
  });

  after(async () => {
    try {
      await flushAuditQueues();
      if (A) await cleanupTenant(A.organizationId);
      if (B) await cleanupTenant(B.organizationId);
    } finally {
      await app?.close();
    }
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
    assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organización residual de esta suite");
  });

  it("401 sin token; 403 sin payroll.read (recepción); 400 VALIDATION_ERROR con from ausente, parámetro extra, to < from y mes mal formado", async () =>
    strict(async () => {
      assert.equal((await call(app, `/payroll/labor-cost-panel?${RANGE}`, null)).status, 401);
      assert.equal((await call(app, `/payroll/labor-cost-panel?${RANGE}`, recepcion)).status, 403);
      const missing = await call(app, "/payroll/labor-cost-panel?to=2025-07", direccion);
      assert.equal(missing.status, 400, missing.raw);
      assert.equal(detailsCode(missing), "VALIDATION_ERROR");
      const extra = await call(app, `/payroll/labor-cost-panel?${RANGE}&group=extras`, direccion);
      assert.equal(extra.status, 400);
      assert.equal(detailsCode(extra), "VALIDATION_ERROR");
      const inverted = await call(app, "/payroll/labor-cost-panel?from=2025-07&to=2025-05", direccion);
      assert.equal(inverted.status, 400);
      assert.equal(detailsCode(inverted), "VALIDATION_ERROR");
      const malformed = await call(app, "/payroll/labor-cost-panel?from=2025-5&to=2025-07", direccion);
      assert.equal(malformed.status, 400);
      assert.equal(detailsCode(malformed), "VALIDATION_ERROR");
    }));

  it("sociedad (dirección general): mayo por el diario sin desglose, junio por el lote con departamentos, julio sin datos; totales, ranking, sources y degraded", async () =>
    strict(async () => {
      const panel = panelOf(await call(app, `/payroll/labor-cost-panel?${RANGE}`, direccion), "sociedad");
      assert.equal(panel.scope, "entity");
      assert.equal(panel.legalEntityId, A.legalEntityId);
      assert.deepEqual(panel.centres.map((centre) => centre.propertyId).sort(), [A.propertyA, A.propertyB].sort());
      assert.equal(panel.centres.every((centre) => centre.months.length === 3), true);

      const may = monthOf(panel, A.propertyA, "2025-05");
      assert.equal(may.laborCost, "3900.00", "borrador y pareja de reverso excluidos");
      assert.equal(may.source, "ledger");
      assert.equal(may.noBreakdown, true);
      assert.equal(may.overlap, false);
      assert.deepEqual(may.departments.map((d) => [d.usaliDepartment, d.laborCost, d.revenue]), [["sin_desglose", "3900.00", null]]);
      assert.deepEqual([may.sales, may.salesSource, may.pctOfSales], ["20000.00", "ledger", "19.50"]);
      assert.deepEqual([may.roomNights, may.laborCostPerOccupiedRoom], [60, "65.00"], "30 cierres × 2; el snapshot demo del 31 no cuenta");
      assert.deepEqual([may.headcount, may.costPerEmployee], [null, null]);

      const june = monthOf(panel, A.propertyA, "2025-06");
      assert.equal(june.source, "import");
      assert.equal(june.laborCost, "3600.00", "solo el lote: su asiento en el diario no se suma");
      assert.equal(june.overlap, false);
      assert.equal(june.noBreakdown, false);
      assert.deepEqual(
        june.departments.map((d) => [d.usaliDepartment, d.laborCost, d.headcount, d.costPerEmployee, d.revenue, d.pctOfSales, d.source]),
        [
          ["rooms", "2400.00", "4.00", "600.00", null, null, "import"],
          ["fnb", "1200.00", "2.00", "600.00", null, null, "import"]
        ],
        "junio no tiene cuentas de ingreso en el diario: revenue null, nunca 0,00"
      );
      assert.deepEqual([june.sales, june.salesSource, june.pctOfSales], ["15000.00", "reference", "24.00"]);
      assert.deepEqual([june.headcount, june.costPerEmployee], ["7.00", "514.29"]);
      assert.deepEqual([june.roomNights, june.laborCostPerOccupiedRoom], [null, null]);

      const july = monthOf(panel, A.propertyA, "2025-07");
      assert.deepEqual([july.source, july.laborCost, july.departments.length, july.sales, july.pctOfSales], [null, "0.00", 0, null, null]);

      const hotelA = centreOf(panel, A.propertyA);
      assert.equal(hotelA.totals.laborCost, "7500.00");
      assert.equal(hotelA.totals.sales, "35000.00");
      assert.equal(hotelA.totals.pctOfSales, "21.43");
      assert.equal(hotelA.totals.roomNights, 60);
      assert.equal(hotelA.totals.laborCostPerOccupiedRoom, "65.00");
      assert.equal(hotelA.totals.headcount, "7.00");
      const hotelB = centreOf(panel, A.propertyB);
      assert.deepEqual([hotelB.totals.laborCost, hotelB.totals.sales, hotelB.totals.pctOfSales, hotelB.totals.roomNights], ["0.00", null, null, null]);
      assert.equal(hotelB.months.every((month) => month.source === null), true);

      assert.equal(panel.totals.laborCost, "7500.00", "sociedad = Σ centros");
      assert.equal(panel.totals.pctOfSales, "21.43");
      assert.deepEqual(
        panel.totals.byDepartment.map((d) => [d.usaliDepartment, d.laborCost]),
        [
          ["rooms", "2400.00"],
          ["fnb", "1200.00"],
          ["sin_desglose", "3900.00"]
        ]
      );
      assert.deepEqual(
        panel.ranking.map((row) => [row.propertyId, row.pctOfSales]),
        [
          [A.propertyA, "21.43"],
          [A.propertyB, null]
        ]
      );
      assert.deepEqual(panel.sources.ledger.accounts, ["640", "642", "705.1"]);
      assert.equal(panel.sources.ledger.entries, 3, "nómina de mayo, ventas de mayo y asiento del lote de junio (sin borrador ni pareja de reverso)");
      assert.deepEqual(panel.sources.imports.map((row) => row.importId), [importId]);
      assert.deepEqual(panel.sources.roomNights.find((row) => row.propertyId === A.propertyA), { propertyId: A.propertyA, source: "night_audit" });
      assert.deepEqual(panel.sources.roomNights.find((row) => row.propertyId === A.propertyB), { propertyId: A.propertyB, source: "degraded" });

      const codes = (code: string, propertyId: string) => panel.degraded.filter((entry) => entry.code === code && entry.propertyId === propertyId);
      assert.equal(codes(LABOR_PANEL_DEGRADED_CODES.costMissing, A.propertyA).length, 1);
      assert.equal(codes(LABOR_PANEL_DEGRADED_CODES.costMissing, A.propertyA)[0]!.periodCode, "2025-07");
      assert.equal(codes(LABOR_PANEL_DEGRADED_CODES.costMissing, A.propertyB).length, 1);
      assert.equal(codes(LABOR_PANEL_DEGRADED_CODES.rnPartial, A.propertyA).length, 1, "mayo: 30 cierres de 31 días");
      assert.equal(codes(LABOR_PANEL_DEGRADED_CODES.rnMissing, A.propertyA).length, 1, "junio sin cierres");
      assert.equal(codes(LABOR_PANEL_DEGRADED_CODES.headcountMissing, A.propertyA).length, 1, "mayo sin lote");
      assert.equal(panel.degraded.some((entry) => entry.code === LABOR_PANEL_DEGRADED_CODES.overlap), false);
      assert.equal(panel.degraded.some((entry) => entry.code === LABOR_PANEL_DEGRADED_CODES.usaliForbidden), false, "dirección general tiene accounting.read");
      assert.doesNotMatch(JSON.stringify(panel), /99999|77777/, "ni el borrador ni la pareja de reverso aparecen");
    }));

  it("centro (manager del hotel A): ámbito property con un solo centro y sin ranking", async () =>
    strict(async () => {
      const panel = panelOf(await call(app, `/payroll/labor-cost-panel?${RANGE}&propertyId=${A.propertyA}`, gestor), "centro");
      assert.equal(panel.scope, "property");
      assert.deepEqual(panel.centres.map((centre) => centre.propertyId), [A.propertyA]);
      assert.equal(panel.ranking.length, 0);
      assert.equal(panel.totals.laborCost, "7500.00");
      assert.equal(monthOf(panel, A.propertyA, "2025-05").laborCost, "3900.00");
    }));

  it("404 opaco: el hotel B (fuera del ámbito del manager), un centro de otra organización y un id inexistente responden igual", async () =>
    strict(async () => {
      const sister = await call(app, `/payroll/labor-cost-panel?${RANGE}&propertyId=${A.propertyB}`, gestor);
      const foreign = await call(app, `/payroll/labor-cost-panel?${RANGE}&propertyId=${B.propertyA}`, gestor);
      const missing = await call(app, `/payroll/labor-cost-panel?${RANGE}&propertyId=prop_no_existe`, gestor);
      assert.equal(sister.status, 404, sister.raw);
      assert.equal(foreign.status, 404, foreign.raw);
      assert.equal(missing.status, 404, missing.raw);
      assert.deepEqual(opaque(sister), opaque(missing));
      assert.deepEqual(opaque(foreign), opaque(missing));
      assert.doesNotMatch(sister.raw, new RegExp(A.propertyB), "la respuesta no revela el id pedido");
      // Dirección general (toda la sociedad): un centro de otra organización sigue siendo opaco.
      const foreignGm = await call(app, `/payroll/labor-cost-panel?${RANGE}&propertyId=${B.propertyA}`, direccion);
      const missingGm = await call(app, `/payroll/labor-cost-panel?${RANGE}&propertyId=prop_no_existe`, direccion);
      assert.equal(foreignGm.status, 404);
      assert.deepEqual(opaque(foreignGm), opaque(missingGm));
      assert.doesNotMatch(foreignGm.raw, new RegExp(B.propertyA));
    }));

  it("sociedad sin accounting.entity.read (manager de un centro) → 404 ENTITY_SCOPE_REQUIRED", async () =>
    strict(async () => {
      const reply = await call(app, `/payroll/labor-cost-panel?${RANGE}`, gestor);
      assert.equal(reply.status, 404, reply.raw);
      assert.equal(detailsCode(reply), "ENTITY_SCOPE_REQUIRED");
    }));

  it("payroll.read sin accounting.read: 200 sin ingreso por departamento y con LABOR_PANEL_USALI_FORBIDDEN", async () =>
    strict(async () => {
      const panel = panelOf(await call(app, `/payroll/labor-cost-panel?${RANGE}`, soloNomina), "solo nómina");
      assert.equal(panel.scope, "entity");
      const june = monthOf(panel, A.propertyA, "2025-06");
      assert.deepEqual(june.departments.map((d) => [d.usaliDepartment, d.revenue, d.pctOfSales]), [
        ["rooms", null, null],
        ["fnb", null, null]
      ]);
      assert.equal(june.laborCost, "3600.00");
      const forbidden = panel.degraded.filter((entry) => entry.code === LABOR_PANEL_DEGRADED_CODES.usaliForbidden);
      assert.equal(forbidden.length, 1);
      assert.equal(forbidden[0]!.propertyId, null);
    }));
});
