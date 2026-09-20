/**
 * Tanda L2 · L2-05 · Listas acotadas y paginadas — integración (Postgres + app.inject).
 *
 * Organización AISLADA (helpers/l2-tenant.mts) con datos mínimos: plan PGC
 * provisionado (cuentas), un lote de coste de personal en borrador creado por
 * API (6 líneas), un lote Sage «balances» con 3 saldos, 2 filas del libro de
 * IVA emitidas, un perfil OPERA sombra con 3 runs y tres cuentas bancarias con
 * extracto, líneas y una conciliación. Comprueba, por cada ruta de (A):
 *   · el objeto de respuesta conserva sus claves y añade `total` / `nextCursor`
 *     (o `lineTotal` / `balanceTotal`) con X-Total-Count;
 *   · `?limit=1` encadena por cursor (u offset) hasta agotar el conjunto sin
 *     repetir ni perder filas;
 *   · `?cursor=no-valido` → 400 «El cursor de paginación no es válido.»;
 *   · 403 sin clave (recepcionista) y 404 opaco en la organización ajena.
 * Para (B)/(C): resultado idéntico al algoritmo anterior (reimplementado aquí
 * consulta a consulta) sobre datos reales de SOLO LECTURA (org_123, Faranda)
 * y sobre la organización aislada, y contador de consultas por petición
 * (DATABASE_LOG_LEVEL=query → «prisma:query» por stdout, contado aquí) ≤ umbral
 * fijo para la posición de tesorería, el panel OPERA sombra y el informe de
 * coste de personal. Invariantes de Faranda idénticas antes y después; 0
 * organizaciones residuales.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/l2-paginacion.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

// ── Contador de consultas ─────────────────────────────────────────────────────
// packages/database/src/client.ts construye el cliente con log ["query"] (stdout,
// vía console.log) cuando DATABASE_LOG_LEVEL=query: se fija ANTES de que el
// helper importe @hotelos/database. Las líneas «prisma:query» se cuentan y no se
// imprimen.
process.env.DATABASE_LOG_LEVEL = "query";
let queryCount = 0;
const nativeLog = console.log;
console.log = (...args: unknown[]): void => {
  if (typeof args[0] === "string" && args[0].includes("prisma:query")) {
    queryCount += 1;
    return;
  }
  nativeLog(...args);
};
async function countQueries<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const start = queryCount;
  const result = await run();
  return { result, queries: queryCount - start };
}

import type { IsolatedTenant, Session } from "./helpers/l2-tenant.mts";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

const helper = await import("./helpers/l2-tenant.mts");
const { prisma, hashPassword } = await import("@hotelos/database");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { treasuryPosition } = await import("../../apps/api/src/modules/treasury/treasury.service.js");
const { getOverview } = await import("../../apps/api/src/modules/pms-shadow/pms-shadow.service.js");
const { buildPayrollCostReport } = await import("../../apps/api/src/modules/payroll/cost-report.service.js");
const { buildPropertyOverview } = await import("../../apps/api/src/modules/dashboards/property-overview.service.js");
const { buildCrmDashboard } = await import("../../apps/api/src/modules/dashboards/crm.service.js");
const { buildGmDashboard } = await import("../../apps/api/src/modules/dashboards/general-manager.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Res = { status: number; body: Record<string, unknown>; headers: Record<string, string | string[] | number | undefined>; text: string };
type ErrorBody = { statusCode: number; message: string; details?: { code?: string } };

const CURSOR_MESSAGE = "El cursor de paginación no es válido.";
const DEMO_ORG = "org_123";
const DEMO_PROP = "prop_123";
const FARANDA_RA = "cmrhw9jy40003fyvbuu2ec2w7";

/** Umbrales fijos de consultas por petición (medidos tras L2-05; la versión anterior crecía con cuentas / feeds). */
const MAX_QUERIES_TREASURY_POSITION = 30;
const MAX_QUERIES_PMS_OVERVIEW = 12;
const MAX_QUERIES_COST_REPORT = 12;

const run = helper.newRunId();
let app: ApiApp;
let tenant: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof helper.farandaInvariants>>;
const sessions = {} as Record<"owner" | "receptionist" | "generalManager" | "accountant" | "payrollHr", Session>;
/** Plantilla «payroll_hr»: la única de T8a con payroll.manage (separación de funciones: manage ≠ approve, que tienen dirección y owner). */
const PAYROLL_HR_USER_ID = `usr_l2_payroll_hr_${run}`;
const PAYROLL_HR_EMAIL = `payroll_hr.l2.${run}@faranda.test`;
let payrollImportId = "";
let balancesImportId = "";
let bankAccountIds: string[] = [];
let arrivalsLatestRunId = "";
let revenueRunId = "";

function strict<T>(fn: () => Promise<T>): Promise<T> {
  return helper.withEnv(helper.STRICT_ENV, fn);
}

async function get(url: string, session: Session): Promise<Res> {
  const res = await app.inject({ method: "GET", url, headers: session.headers });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, headers: res.headers as Res["headers"], text: res.body };
}

function header(res: Res, name: string): string | undefined {
  const value = res.headers[name.toLowerCase()];
  return value === undefined ? undefined : String(value);
}

function syntheticContext(input: { organizationId: string; propertyId: string; permissions: string[] }): UserContext {
  return {
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    userId: `usr_l2_synthetic_${run}`,
    fullName: "L2-05 síntesis",
    deviceId: "l2-05",
    permissions: input.permissions
  } as unknown as UserContext;
}

const CSV_HEADER = "centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados;ventas_sin_iva;hab_disponibles;usali";
const CSV_ROWS: string[][] = [
  ["HOTEL ALFA", "2026-03", "operaciones", "3 RECEPCIO", "6.000,00", "1.800,00", "7.800,00", "3", "40.000,00", "20", ""],
  ["HOTEL ALFA", "2026-03", "operaciones", "6 PISOS", "4.000,00", "1.200,00", "5.200,00", "4", "40.000,00", "20", ""],
  ["HOTEL ALFA", "2026-03", "estructura", "ADMINISTRACION", "2.000,00", "600,00", "2.600,00", "1", "40.000,00", "20", ""],
  ["HOTEL BETA", "2026-03", "operaciones", "3 RECEPCIO", "3.000,00", "900,00", "3.900,00", "2", "20.000,00", "10", ""],
  ["HOTEL BETA", "2026-03", "operaciones", "6 PISOS", "2.000,00", "600,00", "2.600,00", "2", "20.000,00", "10", ""],
  ["HOTEL BETA", "2026-03", "estructura", "ADMINISTRACION", "1.000,00", "300,00", "1.300,00", "1", "20.000,00", "10", ""]
];
const CSV = "﻿" + [CSV_HEADER, ...CSV_ROWS.map((row) => row.join(";"))].join("\r\n") + "\r\n";

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

before(async () => {
  invariantsBefore = await helper.farandaInvariants();
  tenant = await helper.createIsolatedTenant(run);
  const organizationId = tenant.organizationId;
  const A = tenant.propertyA;

  // Usuario de nóminas (plantilla payroll_hr, ámbito organización) para crear el lote por la API.
  const payrollRoleId = tenant.roles.payroll_hr;
  assert.ok(payrollRoleId, "plantilla payroll_hr provisionada por el helper");
  await prisma.user.create({
    data: { id: PAYROLL_HR_USER_ID, organizationId, email: PAYROLL_HR_EMAIL, fullName: "Nóminas L2", status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  await prisma.userRoleAssignment.create({ data: { userId: PAYROLL_HR_USER_ID, roleId: payrollRoleId, scopeType: "organization", propertyId: null, organizationId, reason: `seed l2-05 ${run}` } });
  resetRbacScopeCacheForTests();

  // 2 filas del libro de IVA emitidas (2026-Q3) del hotel A.
  await prisma.vatBookEntry.createMany({
    data: [
      { organizationId, propertyId: A, book: "emitidas", date: day("2026-07-15"), series: "L2", number: "1", counterpartyNif: "12345678Z", counterpartyName: "Cliente uno", base: "100.00", rate: "10.00", quota: "10.00", total: "110.00", retention: "0", taxFigure: "IVA", sourceType: "invoice", sourceId: `l2-05-${run}-a`, period: "2026-Q3", deductible: true },
      { organizationId, propertyId: A, book: "emitidas", date: day("2026-08-20"), series: "L2", number: "2", counterpartyNif: "12345678Z", counterpartyName: "Cliente uno", base: "200.00", rate: "10.00", quota: "20.00", total: "220.00", retention: "0", taxFigure: "IVA", sourceType: "invoice", sourceId: `l2-05-${run}-b`, period: "2026-Q3", deductible: true }
    ]
  });

  // Lote Sage «balances» contabilizado con 3 saldos del hotel A (sin entradas: un lote de toda la sociedad).
  const balancesImport = await prisma.ledgerImport.create({
    data: { organizationId, legalEntityId: tenant.legalEntityId, system: "sage200", kind: "balances", format: "csv", fileName: "saldos-l2.csv", contentHash: `l2-05-${run}`, fiscalYearCode: "2026", periodFrom: "2026-01", periodTo: "2026-01", status: "posted", rowCount: 3, entryCount: 0, postedAt: new Date() },
    select: { id: true }
  });
  balancesImportId = balancesImport.id;
  await prisma.ledgerImportBalance.createMany({
    data: ["5720000", "4300000", "7050000"].map((sourceAccount, index) => ({
      importId: balancesImportId,
      organizationId,
      fiscalYearCode: "2026",
      periodCode: "2026-01",
      propertyId: A,
      propertyCode: "L2A",
      sourceAccount,
      sourceName: `Cuenta ${sourceAccount}`,
      accountCode: sourceAccount.slice(0, 3),
      openingDebit: `${(index + 1) * 100}.00`,
      openingCredit: "0.00",
      periodDebit: "10.00",
      periodCredit: "5.00",
      closingBalance: `${(index + 1) * 100 + 5}.00`
    }))
  });

  // Perfil OPERA sombra con dos feeds programados y 3 runs (arrivals ×2, revenue ×1).
  await prisma.pmsShadowProfile.create({
    data: {
      organizationId,
      propertyId: A,
      system: "opera_cloud",
      operaHotelCode: `L2${run.slice(-4).toUpperCase()}`,
      status: "active",
      mappingJson: { roomTypes: { DLX: "DBL" } },
      trxMappingJson: {},
      scheduleJson: { feeds: [{ feed: "arrivals", expectedTime: "06:30", businessDateOffset: 0, required: true }, { feed: "revenue", expectedTime: "07:00", businessDateOffset: -1, required: true }] }
    }
  });
  const now = Date.now();
  const older = await prisma.pmsShadowRun.create({
    data: { organizationId, propertyId: A, feed: "arrivals", source: "manual", businessDate: day("2026-09-16"), contentHash: `l2-05-${run}-arr-1`, status: "done", createdAt: new Date(now - 2 * 3_600_000) },
    select: { id: true }
  });
  const latest = await prisma.pmsShadowRun.create({
    data: { organizationId, propertyId: A, feed: "arrivals", source: "manual", businessDate: day("2026-09-17"), contentHash: `l2-05-${run}-arr-2`, status: "failed", createdAt: new Date(now - 3_600_000) },
    select: { id: true }
  });
  const revenue = await prisma.pmsShadowRun.create({
    data: { organizationId, propertyId: A, feed: "revenue", source: "manual", businessDate: day("2026-09-16"), contentHash: `l2-05-${run}-rev-1`, status: "done", createdAt: new Date(now - 90 * 60_000) },
    select: { id: true }
  });
  assert.notEqual(older.id, latest.id);
  arrivalsLatestRunId = latest.id;
  revenueRunId = revenue.id;

  // Tres cuentas bancarias del hotel A: la primera con extracto, 3 líneas y una conciliación; la segunda con extracto y una línea; la tercera vacía.
  bankAccountIds = [];
  for (const [index, name] of ["Banco L2 uno", "Banco L2 dos", "Banco L2 tres"].entries()) {
    const account = await prisma.bankAccount.create({
      data: { organizationId, propertyId: A, name, iban: `ES91210004184502000513${index + 10}`, ledgerAccountCode: `572.${index + 1}`, active: true },
      select: { id: true }
    });
    bankAccountIds.push(account.id);
    if (index === 2) continue;
    const statement = await prisma.bankStatement.create({
      data: { bankAccountId: account.id, propertyId: A, periodStart: day("2026-08-01"), periodEnd: day("2026-08-31"), openingBalance: "500.00", closingBalance: `${1000 + index}.00`, status: "pending" },
      select: { id: true }
    });
    // Un extracto anterior, para comprobar que se elige el último ≤ asOf.
    await prisma.bankStatement.create({
      data: { bankAccountId: account.id, propertyId: A, periodStart: day("2026-07-01"), periodEnd: day("2026-07-31"), openingBalance: "100.00", closingBalance: "500.00", status: "pending" }
    });
    const amounts = index === 0 ? ["120.50", "-30.00", "45.25"] : ["10.00"];
    const lines: string[] = [];
    for (const [lineIndex, amount] of amounts.entries()) {
      const line = await prisma.bankStatementLine.create({
        data: { statementId: statement.id, bankAccountId: account.id, txDate: day(`2026-08-${String(lineIndex + 2).padStart(2, "0")}`), amount },
        select: { id: true }
      });
      lines.push(line.id);
    }
    if (index === 0) {
      await prisma.reconciliationMatch.create({ data: { bankAccountId: account.id, bankLineId: lines[0]!, matchType: "manual", matchedEntityId: `l2-05-${run}`, amount: "120.50" } });
    }
  }

  app = await buildApiServer();
  await app.ready();
  await strict(async () => {
    for (const key of ["owner", "receptionist", "generalManager", "accountant"] as const) {
      sessions[key] = await helper.loginOrThrow(app, tenant.users[key].email, tenant.password);
    }
    sessions.payrollHr = await helper.loginOrThrow(app, PAYROLL_HR_EMAIL, tenant.password);
    // Lote de coste de personal en borrador (post: false) creado por la API: 2 centros × 3 filas.
    const created = await app.inject({
      method: "POST",
      url: "/payroll/cost-imports",
      headers: sessions.payrollHr.headers,
      payload: { format: "csv", content: CSV, fileName: "coste-l2-05.csv", post: false, mapping: { centres: { "HOTEL ALFA": tenant.propertyA, "HOTEL BETA": tenant.propertyB } } }
    });
    assert.equal(created.statusCode, 201, created.body);
    const lot = JSON.parse(created.body) as { id: string; rowCount: number; status: string };
    assert.equal(lot.rowCount, 6);
    payrollImportId = lot.id;
  });
});

after(async () => {
  await flushAuditQueues();
  if (app) await app.close();
  if (tenant) await helper.cleanupTenant(tenant.organizationId);
  assert.equal(await prisma.organization.count({ where: { id: tenant.organizationId } }), 0, "la organización aislada se ha borrado (sin residuos propios)");
  // Faranda: idéntica antes y después. Las suites hermanas (pms-shadow-*, structure-*) escriben y limpian Faranda en
  // paralelo dentro de `test:integration`: se espera (≤ 10 s) a que vuelvan a las cifras de partida antes de fallar.
  let current = await helper.farandaInvariants();
  for (let attempt = 0; attempt < 20 && JSON.stringify(current) !== JSON.stringify(invariantsBefore); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await helper.farandaInvariants();
  }
  assert.deepEqual(current, invariantsBefore, "Faranda no cambia");
});

// ── (A) GET /accounting/chart ────────────────────────────────────────────────
describe("A · GET /accounting/chart · keyset por código", () => {
  it("objeto intacto + total + X-Total-Count; postableOnly y q filtran en SQL; parentCode de un hijo se resuelve fuera de la página", async () => {
    await strict(async () => {
      const expectedTotal = await prisma.account.count({ where: { organizationId: tenant.organizationId } });
      const res = await get("/accounting/chart", sessions.owner);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(Object.keys(res.body).sort(), ["accounts", "chartTemplate", "nextCursor", "organizationId", "total"]);
      assert.equal(res.body.organizationId, tenant.organizationId);
      assert.equal(res.body.chartTemplate, "pgc_pymes_hotelero_v1");
      assert.equal(res.body.total, expectedTotal);
      assert.equal(header(res, "X-Total-Count"), String(expectedTotal));
      const accounts = res.body.accounts as Array<{ code: string; parentCode: string | null; isPostable: boolean; name: string }>;
      assert.equal(accounts.length, Math.min(expectedTotal, 500));
      assert.ok(accounts.length >= 200, "PGC provisionado");
      assert.equal(accounts.find((a) => a.code === "477.10")?.parentCode, "477");
      const ordered = accounts.map((a) => a.code);
      assert.deepEqual(ordered, [...ordered].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "orden por código (colación de texto)");

      const postable = await get("/accounting/chart?postableOnly=1&limit=2000", sessions.owner);
      assert.equal(postable.status, 200, postable.text);
      const postableAccounts = postable.body.accounts as Array<{ code: string; parentCode: string | null; isPostable: boolean }>;
      assert.ok(postableAccounts.every((a) => a.isPostable));
      assert.ok((postable.body.total as number) < expectedTotal);
      assert.equal(postableAccounts.length, postable.body.total);
      assert.equal(postableAccounts.find((a) => a.code === "477.10")?.parentCode, "477", "el padre (cabecera, fuera del filtro) sigue resuelto");

      const filtered = await get("/accounting/chart?q=572", sessions.owner);
      assert.equal(filtered.status, 200, filtered.text);
      const filteredAccounts = filtered.body.accounts as Array<{ code: string; name: string }>;
      assert.ok(filteredAccounts.length > 0);
      assert.ok(filteredAccounts.every((a) => a.code.startsWith("572") || a.name.toLowerCase().includes("572")));
      assert.equal(filtered.body.total, filteredAccounts.length);
    });
  });

  it("?limit=1 encadena por nextCursor (X-Next-Cursor) hasta agotar el plan sin repetir ni perder", async () => {
    await strict(async () => {
      const full = await get("/accounting/chart?limit=2000", sessions.owner);
      const allCodes = (full.body.accounts as Array<{ code: string }>).map((a) => a.code);
      const first = await get("/accounting/chart?limit=1", sessions.owner);
      assert.equal(first.status, 200, first.text);
      assert.equal((first.body.accounts as unknown[]).length, 1);
      assert.equal(typeof first.body.nextCursor, "string");
      assert.equal(header(res(first), "X-Next-Cursor"), first.body.nextCursor);
      const second = await get(`/accounting/chart?limit=1&cursor=${encodeURIComponent(first.body.nextCursor as string)}`, sessions.owner);
      assert.equal(second.status, 200, second.text);
      assert.equal((second.body.accounts as Array<{ code: string }>)[0]?.code, allCodes[1]);
      // Encadenado completo con páginas de 100.
      const collected: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page += 1) {
        const url = `/accounting/chart?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const step = await get(url, sessions.owner);
        assert.equal(step.status, 200, step.text);
        collected.push(...(step.body.accounts as Array<{ code: string }>).map((a) => a.code));
        cursor = step.body.nextCursor as string | null;
        if (!cursor) break;
      }
      assert.deepEqual(collected, allCodes);
      assert.equal(new Set(collected).size, allCodes.length);
    });
  });

  it("cursor inválido → 400 con el mensaje exacto; limit no válido → 400; recepcionista → 403", async () => {
    await strict(async () => {
      const bad = await get("/accounting/chart?cursor=no-valido", sessions.owner);
      assert.equal(bad.status, 400, bad.text);
      assert.equal((bad.body as ErrorBody).message, CURSOR_MESSAGE);
      const zero = await get("/accounting/chart?limit=0", sessions.owner);
      assert.equal(zero.status, 400);
      const unknown = await get("/accounting/chart?bogus=1", sessions.owner);
      assert.equal(unknown.status, 400);
      const forbidden = await get("/accounting/chart", sessions.receptionist);
      assert.equal(forbidden.status, 403, forbidden.text);
    });
  });
});

function res(value: Res): Res {
  return value;
}

// ── (A) GET /payroll/cost-imports/:id ────────────────────────────────────────
describe("A · GET /payroll/cost-imports/:id · líneas por offset", () => {
  it("detalle intacto (lines, references, byCentreMonth, entries, reversals) + lineTotal + X-Total-Count; offset/limit recorren las líneas", async () => {
    await strict(async () => {
      const full = await get(`/payroll/cost-imports/${payrollImportId}`, sessions.owner);
      assert.equal(full.status, 200, full.text);
      for (const key of ["lines", "references", "byCentreMonth", "entries", "reversals", "lineTotal", "lineOffset", "status", "rowCount"]) assert.ok(key in full.body, `clave ${key}`);
      const lines = full.body.lines as Array<Record<string, unknown>>;
      assert.equal(lines.length, 6);
      assert.equal(full.body.lineTotal, 6);
      assert.equal(full.body.lineOffset, 0);
      assert.equal(header(full, "X-Total-Count"), "6");
      assert.equal((full.body.byCentreMonth as unknown[]).length, 2, "una celda por centro × mes");

      const second = await get(`/payroll/cost-imports/${payrollImportId}?limit=1&offset=1`, sessions.owner);
      assert.equal(second.status, 200, second.text);
      assert.deepEqual(second.body.lines, [lines[1]]);
      assert.equal(second.body.lineTotal, 6);
      assert.equal(second.body.lineOffset, 1);
      assert.equal((second.body.byCentreMonth as unknown[]).length, 2, "las celdas agregan todas las líneas, no la página");

      // Encadenado por offset con páginas de 1.
      const collected: unknown[] = [];
      for (let offset = 0; offset < 6; offset += 1) {
        const step = await get(`/payroll/cost-imports/${payrollImportId}?limit=1&offset=${offset}`, sessions.owner);
        assert.equal(step.status, 200, step.text);
        collected.push(...(step.body.lines as unknown[]));
      }
      assert.deepEqual(collected, lines);
      const beyond = await get(`/payroll/cost-imports/${payrollImportId}?limit=5&offset=6`, sessions.owner);
      assert.equal(beyond.status, 200);
      assert.deepEqual(beyond.body.lines, []);
    });
  });

  it("cursor → 400 con el mensaje exacto; offset/limit no válidos → 400; recepcionista 403; lote de otra organización 404", async () => {
    await strict(async () => {
      const bad = await get(`/payroll/cost-imports/${payrollImportId}?cursor=no-valido`, sessions.owner);
      assert.equal(bad.status, 400, bad.text);
      assert.equal((bad.body as ErrorBody).message, CURSOR_MESSAGE);
      assert.equal((await get(`/payroll/cost-imports/${payrollImportId}?offset=-1`, sessions.owner)).status, 400);
      assert.equal((await get(`/payroll/cost-imports/${payrollImportId}?limit=2001`, sessions.owner)).status, 400);
      assert.equal((await get(`/payroll/cost-imports/${payrollImportId}?limit=abc`, sessions.owner)).status, 400);
      const forbidden = await get(`/payroll/cost-imports/${payrollImportId}`, sessions.receptionist);
      assert.equal(forbidden.status, 403, forbidden.text);
      const foreign = await prisma.payrollCostImport.findFirst({ where: { organizationId: helper.FARANDA_ORG }, select: { id: true } });
      const foreignId = foreign?.id ?? "lote-inexistente";
      const notFound = await get(`/payroll/cost-imports/${foreignId}`, sessions.owner);
      assert.equal(notFound.status, 404, notFound.text);
      assert.ok(!notFound.text.includes(foreignId), "404 opaco sin eco del id");
    });
  });
});

// ── (A) GET /payroll/cost-report ─────────────────────────────────────────────
describe("A · GET /payroll/cost-report · rango obligatorio y acotado", () => {
  it("from/to obligatorios y ≤ 24 meses (400 tipado); informe 200; recepcionista 403; centro ajeno 404", async () => {
    await strict(async () => {
      const ok = await get("/payroll/cost-report?from=2026-01&to=2026-03", sessions.owner);
      assert.equal(ok.status, 200, ok.text);
      assert.ok(Array.isArray(ok.body.centres));
      assert.ok("warnings" in ok.body);
      const missing = await get("/payroll/cost-report?to=2026-03", sessions.owner);
      assert.equal(missing.status, 400, missing.text);
      assert.equal((missing.body as ErrorBody).details?.code, "VALIDATION_ERROR");
      const tooLong = await get("/payroll/cost-report?from=2024-01&to=2026-03", sessions.owner);
      assert.equal(tooLong.status, 400, tooLong.text);
      assert.match((tooLong.body as ErrorBody).message, /24 meses/);
      const forbidden = await get("/payroll/cost-report?from=2026-01&to=2026-03", sessions.receptionist);
      assert.equal(forbidden.status, 403, forbidden.text);
      const foreign = await get(`/payroll/cost-report?from=2026-01&to=2026-03&propertyId=${FARANDA_RA}`, sessions.owner);
      assert.equal(foreign.status, 404, foreign.text);
    });
  });

  it(`el informe usa un número fijo de consultas (≤ ${MAX_QUERIES_COST_REPORT}) independientemente del rango`, async () => {
    const context = syntheticContext({ organizationId: tenant.organizationId, propertyId: tenant.propertyA, permissions: ["payroll.read", "accounting.read", "accounting.entity.read"] });
    const short = await countQueries(() => buildPayrollCostReport({ context, from: "2026-03", to: "2026-03" }));
    const long = await countQueries(() => buildPayrollCostReport({ context, from: "2025-01", to: "2026-12" }));
    nativeLog(`[l2-05] consultas cost-report: 1 mes ${short.queries} · 24 meses ${long.queries} (umbral ${MAX_QUERIES_COST_REPORT})`);
    assert.ok(short.queries <= MAX_QUERIES_COST_REPORT, `consultas (1 mes): ${short.queries}`);
    assert.ok(long.queries <= MAX_QUERIES_COST_REPORT, `consultas (24 meses): ${long.queries}`);
    assert.equal(long.result.centres.length, short.result.centres.length);
  });
});

// ── (A) GET /accounting/ledger-imports/:id ───────────────────────────────────
describe("A · GET /accounting/ledger-imports/:id · saldos por offset", () => {
  it("detalle intacto (import, entries, entryTotal, mapping, balances) + balanceTotal + X-Balance-Total; offset/limit recorren los saldos", async () => {
    await strict(async () => {
      const full = await get(`/accounting/ledger-imports/${balancesImportId}`, sessions.owner);
      assert.equal(full.status, 200, full.text);
      assert.deepEqual(Object.keys(full.body).sort(), ["balanceOffset", "balanceTotal", "balances", "entries", "entryOffset", "entryTotal", "import", "mapping"]);
      const balances = full.body.balances as Array<Record<string, unknown>>;
      assert.equal(balances.length, 3);
      assert.equal(full.body.balanceTotal, 3);
      assert.equal(full.body.balanceOffset, 0);
      assert.equal(full.body.entryTotal, 0);
      assert.equal(header(full, "X-Total-Count"), "0");
      assert.equal(header(full, "X-Balance-Total"), "3");
      assert.deepEqual(balances.map((b) => b.sourceAccount), ["4300000", "5720000", "7050000"], "orden por periodo, centro y cuenta Sage");

      const second = await get(`/accounting/ledger-imports/${balancesImportId}?limit=1&offset=1`, sessions.owner);
      assert.equal(second.status, 200, second.text);
      assert.deepEqual(second.body.balances, [balances[1]]);
      assert.equal(second.body.balanceOffset, 1);
      assert.equal(second.body.balanceTotal, 3);
      const collected: unknown[] = [];
      for (let offset = 0; offset < 3; offset += 1) {
        const step = await get(`/accounting/ledger-imports/${balancesImportId}?limit=1&offset=${offset}`, sessions.owner);
        collected.push(...(step.body.balances as unknown[]));
      }
      assert.deepEqual(collected, balances);
    });
  });

  it("cursor → 400 con el mensaje exacto; recepcionista 403; lote de otra organización 404", async () => {
    await strict(async () => {
      const bad = await get(`/accounting/ledger-imports/${balancesImportId}?cursor=no-valido`, sessions.owner);
      assert.equal(bad.status, 400, bad.text);
      assert.equal((bad.body as ErrorBody).message, CURSOR_MESSAGE);
      const forbidden = await get(`/accounting/ledger-imports/${balancesImportId}`, sessions.receptionist);
      assert.equal(forbidden.status, 403, forbidden.text);
      const foreign = await prisma.ledgerImport.findFirst({ where: { organizationId: helper.FARANDA_ORG, kind: "balances" }, select: { id: true } });
      const foreignId = foreign?.id ?? "lote-inexistente";
      const notFound = await get(`/accounting/ledger-imports/${foreignId}`, sessions.owner);
      assert.equal(notFound.status, 404, notFound.text);
      assert.ok(!notFound.text.includes(foreignId), "404 opaco sin eco del id");
    });
  });
});

// ── (A) GET /fiscal/vat-books ────────────────────────────────────────────────
describe("A · GET /fiscal/vat-books · keyset por (fecha, id) y totales por tipo agregados", () => {
  it("objeto intacto (rows, resumen, origen, avisos, periodo) + total + nextCursor; resumen por groupBy sobre todo el rango", async () => {
    await strict(async () => {
      const res = await get("/fiscal/vat-books?book=emitidas&period=2026-Q3", sessions.owner);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(Object.keys(res.body).sort(), ["avisos", "book", "nextCursor", "organizationId", "origen", "periodo", "propertyId", "resumen", "rows", "total"]);
      assert.equal(res.body.origen, "libros");
      assert.equal(res.body.total, 2);
      assert.equal(res.body.nextCursor, null);
      assert.equal(header(res, "X-Total-Count"), "2");
      const rows = res.body.rows as Array<{ date: string; base: number; sourceId: string }>;
      assert.deepEqual(rows.map((r) => r.date), ["2026-07-15", "2026-08-20"]);
      const resumen = res.body.resumen as { filas: number; base: number; cuota: number; total: number; retencion: number; porTipo: Array<{ rate: number; filas: number; base: number; cuota: number; total: number }> };
      assert.equal(resumen.filas, 2);
      assert.equal(resumen.base, 300);
      assert.equal(resumen.cuota, 30);
      assert.equal(resumen.total, 330);
      assert.deepEqual(resumen.porTipo.map((t) => [t.rate, t.filas, t.base, t.cuota, t.total]), [[10, 2, 300, 30, 330]]);
      const byCentre = await get(`/fiscal/vat-books?book=emitidas&period=2026-Q3&propertyId=${tenant.propertyA}`, sessions.owner);
      assert.equal(byCentre.status, 200, byCentre.text);
      assert.equal(byCentre.body.total, 2);
      const otherCentre = await get(`/fiscal/vat-books?book=emitidas&period=2026-Q3&propertyId=${tenant.propertyB}`, sessions.owner);
      assert.equal(otherCentre.status, 200, otherCentre.text);
      assert.equal(otherCentre.body.total, 0);
    });
  });

  it("?limit=1 → una fila + nextCursor; la segunda página trae la otra fila con el resumen completo; el resumen no depende de la página", async () => {
    await strict(async () => {
      const first = await get("/fiscal/vat-books?book=emitidas&period=2026-Q3&limit=1", sessions.owner);
      assert.equal(first.status, 200, first.text);
      const firstRows = first.body.rows as Array<{ date: string }>;
      assert.equal(firstRows.length, 1);
      assert.equal(firstRows[0]?.date, "2026-07-15");
      assert.equal(typeof first.body.nextCursor, "string");
      assert.equal(header(first, "X-Next-Cursor"), first.body.nextCursor);
      assert.equal(header(first, "X-Total-Count"), "2");
      assert.equal((first.body.resumen as { filas: number; base: number }).filas, 2);
      assert.equal((first.body.resumen as { filas: number; base: number }).base, 300);
      const second = await get(`/fiscal/vat-books?book=emitidas&period=2026-Q3&limit=1&cursor=${encodeURIComponent(first.body.nextCursor as string)}`, sessions.owner);
      assert.equal(second.status, 200, second.text);
      const secondRows = second.body.rows as Array<{ date: string }>;
      assert.deepEqual(secondRows.map((r) => r.date), ["2026-08-20"]);
      assert.equal(second.body.nextCursor, null);
      assert.equal(second.body.total, 2);
    });
  });

  it("cursor inválido → 400 exacto; sin period ni from/to → 400 tipado; recepcionista 403; centro de otra organización 404", async () => {
    await strict(async () => {
      const bad = await get("/fiscal/vat-books?book=emitidas&period=2026-Q3&cursor=no-valido", sessions.owner);
      assert.equal(bad.status, 400, bad.text);
      assert.equal((bad.body as ErrorBody).message, CURSOR_MESSAGE);
      const noPeriod = await get("/fiscal/vat-books?book=emitidas", sessions.owner);
      assert.equal(noPeriod.status, 400, noPeriod.text);
      assert.equal((noPeriod.body as ErrorBody).details?.code, "VALIDATION_ERROR");
      const halfRange = await get("/fiscal/vat-books?book=emitidas&from=2026-07-01", sessions.owner);
      assert.equal(halfRange.status, 400, halfRange.text);
      const forbidden = await get("/fiscal/vat-books?book=emitidas&period=2026-Q3", sessions.receptionist);
      assert.equal(forbidden.status, 403, forbidden.text);
      const foreign = await get(`/fiscal/vat-books?book=emitidas&period=2026-Q3&propertyId=${FARANDA_RA}`, sessions.owner);
      assert.equal(foreign.status, 404, foreign.text);
    });
  });
});

// ── (B)/(C) resultados idénticos y consultas acotadas ────────────────────────
describe("B/C · N+1 y acotación: resultado idéntico al algoritmo anterior, consultas por petición ≤ umbral", () => {
  it(`tesorería · posición: cuentas bancarias resueltas en bloque (≤ ${MAX_QUERIES_TREASURY_POSITION} consultas) e idénticas a la resolución por cuenta`, async () => {
    const asOf = day("2026-09-18");
    const { result: position, queries } = await countQueries(() => treasuryPosition({ propertyId: tenant.propertyA, asOf }));
    nativeLog(`[l2-05] consultas treasury position (3 cuentas bancarias): ${queries} (umbral ${MAX_QUERIES_TREASURY_POSITION})`);
    assert.ok(queries <= MAX_QUERIES_TREASURY_POSITION, `consultas: ${queries}`);
    assert.equal(position.banks.length, 3);
    // Algoritmo anterior (tres consultas por cuenta), reimplementado aquí.
    for (const bank of position.banks) {
      const statement = await prisma.bankStatement.findFirst({ where: { bankAccountId: bank.bankAccountId, periodEnd: { lte: new Date(asOf.getTime() + 86_400_000) } }, orderBy: { periodEnd: "desc" } });
      const lines = await prisma.bankStatementLine.findMany({ where: { bankAccountId: bank.bankAccountId }, select: { id: true, amount: true } });
      const matched = lines.length ? await prisma.reconciliationMatch.findMany({ where: { bankLineId: { in: lines.map((l) => l.id) } }, select: { bankLineId: true } }) : [];
      const matchedIds = new Set(matched.map((m) => m.bankLineId));
      const unmatched = lines.filter((l) => !matchedIds.has(l.id));
      assert.equal(bank.unmatchedLines, unmatched.length);
      assert.equal(Number(bank.unmatchedAmount), Number(unmatched.reduce((sum, l) => sum + Number(l.amount), 0).toFixed(2)));
      assert.equal(bank.statementClosing, statement ? Number(statement.closingBalance).toFixed(2) : null);
      assert.equal(bank.statementDate, statement ? statement.periodEnd.toISOString().slice(0, 10) : null);
    }
    // Orden de la posición: (centro, nombre) → «dos», «tres», «uno».
    const byName = new Map(position.banks.map((bank) => [bank.name, bank]));
    const one = byName.get("Banco L2 uno");
    const two = byName.get("Banco L2 dos");
    const three = byName.get("Banco L2 tres");
    assert.equal(one?.unmatchedLines, 2);
    assert.equal(one?.unmatchedAmount, "15.25");
    assert.equal(one?.statementClosing, "1000.00");
    assert.equal(one?.statementDate, "2026-08-31");
    assert.equal(two?.unmatchedLines, 1);
    assert.equal(two?.statementClosing, "1001.00");
    assert.equal(three?.unmatchedLines, 0);
    assert.equal(three?.statementClosing, null);
  });

  it(`OPERA sombra · panel: último run por feed con groupBy (≤ ${MAX_QUERIES_PMS_OVERVIEW} consultas) e idéntico al findFirst por feed`, async () => {
    const context = syntheticContext({ organizationId: tenant.organizationId, propertyId: tenant.propertyA, permissions: ["integrations.read"] });
    const { result: overview, queries } = await countQueries(() => getOverview({ context, propertyId: tenant.propertyA }));
    nativeLog(`[l2-05] consultas pms-shadow overview (2 feeds, 3 runs): ${queries} (umbral ${MAX_QUERIES_PMS_OVERVIEW})`);
    assert.ok(queries <= MAX_QUERIES_PMS_OVERVIEW, `consultas: ${queries}`);
    const byFeed = new Map(overview.feeds.map((feed) => [feed.feed, feed]));
    assert.equal(byFeed.get("arrivals")?.lastRun?.id, arrivalsLatestRunId, "el run más reciente, no el primero");
    // El último run de arrivals falló; según la hora del reloj la programación lo marca antes como «late».
    assert.ok(["failed", "late"].includes(byFeed.get("arrivals")?.state ?? ""), `estado ${byFeed.get("arrivals")?.state}`);
    assert.equal(byFeed.get("revenue")?.lastRun?.id, revenueRunId);
    for (const feed of overview.feeds) {
      const previous = await prisma.pmsShadowRun.findFirst({ where: { organizationId: tenant.organizationId, propertyId: tenant.propertyA, feed: feed.feed }, orderBy: [{ createdAt: "desc" }], select: { id: true } });
      assert.equal(feed.lastRun?.id ?? null, previous?.id ?? null, `feed ${feed.feed}`);
    }
    // Faranda Rías Altas (solo lectura): mismos últimos runs por feed.
    const farandaContext = syntheticContext({ organizationId: helper.FARANDA_ORG, propertyId: FARANDA_RA, permissions: ["integrations.read"] });
    const faranda = await countQueries(() => getOverview({ context: farandaContext, propertyId: FARANDA_RA }));
    nativeLog(`[l2-05] consultas pms-shadow overview Faranda RA (${faranda.result.feeds.length} feeds): ${faranda.queries} (umbral ${MAX_QUERIES_PMS_OVERVIEW})`);
    assert.ok(faranda.queries <= MAX_QUERIES_PMS_OVERVIEW, `consultas Faranda: ${faranda.queries}`);
    for (const feed of faranda.result.feeds) {
      const previous = await prisma.pmsShadowRun.findFirst({ where: { organizationId: helper.FARANDA_ORG, propertyId: FARANDA_RA, feed: feed.feed }, orderBy: [{ createdAt: "desc" }], select: { id: true } });
      assert.equal(feed.lastRun?.id ?? null, previous?.id ?? null, `Faranda feed ${feed.feed}`);
    }
  });

  it("panel de propiedad (org_123, lectura): ingresos MTD y reseñas agregados en SQL idénticos al recorrido anterior", async () => {
    const asOf = new Date();
    const overview = await buildPropertyOverview({ propertyId: DEMO_PROP, asOf });
    // Algoritmo anterior: todas las reservas → folios → groupBy de líneas del mes.
    // Corrector UX2-REV-02: el mes cuelga de la FECHA DE NEGOCIO de prop_123 (business_dates."current_date",
    // que va días por detrás del calendario en la copia), no del reloj: la respuesta la expone.
    assert.match(overview.businessDate, /^\d{4}-\d{2}-\d{2}$/);
    const anchor = new Date(`${overview.businessDate}T00:00:00.000Z`);
    const monthStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const reservations = await prisma.reservation.findMany({ where: { propertyId: DEMO_PROP }, select: { id: true } });
    const folios = await prisma.folio.findMany({ where: { reservationId: { in: reservations.map((r) => r.id) } }, select: { id: true } });
    const grouped = folios.length ? await prisma.folioLine.groupBy({ by: ["folioId"], where: { folioId: { in: folios.map((f) => f.id) }, postedAt: { gte: monthStart } }, _sum: { total: true } }) : [];
    const previousRevenue = Math.round(grouped.reduce((sum, row) => sum + Number(row._sum.total ?? 0), 0) * 100) / 100;
    assert.equal(overview.finance.revenueMtdEur, previousRevenue);
    const reviews = await prisma.guestReview.findMany({ where: { propertyId: DEMO_PROP }, select: { rating: true, respondedAt: true } });
    const ratings = reviews.map((r) => (r.rating === null ? null : Number(r.rating))).filter((r): r is number => r !== null && r > 0);
    const previousPending = reviews.filter((r) => r.rating !== null && Number(r.rating) > 0 && r.respondedAt === null).length;
    const previousAvg = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : 0;
    assert.equal(overview.guestExperience.avgReviewRating, previousAvg);
    assert.equal(overview.guestExperience.pendingReviews, previousPending);
  });

  it("CRM (org_123, lectura): contadores por SQL idénticos a las listas completas anteriores", async () => {
    const dashboard = await buildCrmDashboard({ propertyId: DEMO_PROP });
    const [guests, profiles] = await Promise.all([prisma.guest.count({ where: { organizationId: DEMO_ORG } }), prisma.guestProfile.findMany({ where: { organizationId: DEMO_ORG }, select: { vipLevel: true, lifetimeValue: true } })]);
    assert.equal(dashboard.kpis.totalGuests, guests);
    assert.equal(dashboard.kpis.activeProfiles, profiles.length);
    assert.equal(dashboard.kpis.vipCount, profiles.filter((p) => p.vipLevel && p.vipLevel.trim().length > 0).length);
    if (profiles.length > 0) {
      const total = profiles.reduce((acc, p) => acc + Number(p.lifetimeValue ?? 0), 0);
      assert.equal(dashboard.kpis.avgLifetimeValueEur, Math.round((total / profiles.length) * 100) / 100);
    }
  });

  it("dirección (org_123, lectura): reputación por aggregate idéntica al recorrido de reseñas y sin degradación", async () => {
    const dashboard = await buildGmDashboard({ propertyId: DEMO_PROP });
    // Corrector UX2-REV-02 (R-13): la ventana de 30 días del servicio cuelga de la fecha de negocio de prop_123
    // (2026-09-14 en la copia, no «hoy»): se ancla en `businessDate` en vez de en Date.now().
    assert.match(dashboard.businessDate, /^\d{4}-\d{2}-\d{2}$/);
    const since = new Date(new Date(`${dashboard.businessDate}T00:00:00.000Z`).getTime() - 30 * 86_400_000);
    const reviews30 = await prisma.guestReview.findMany({ where: { propertyId: DEMO_PROP, createdAt: { gte: since } }, select: { rating: true } });
    if (reviews30.length === 0) {
      assert.equal(dashboard.reputation, undefined);
    } else {
      const scores = reviews30.map((r) => Number(r.rating ?? NaN)).filter((n) => Number.isFinite(n));
      const avg = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : undefined;
      assert.equal(dashboard.reputation?.reviewsLast30, reviews30.length);
      assert.equal(dashboard.reputation?.avgScore, avg ? Math.round(avg * 100) / 100 : undefined);
    }
    assert.ok(!dashboard.degraded.includes("reputation.reviews30"), "la reputación no cayó al fallback");
  });
});
