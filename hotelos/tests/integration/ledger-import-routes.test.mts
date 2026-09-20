/**
 * Importación contable desde Sage 200 · Tanda 7c · L3 — rutas HTTP REALES con app.inject
 * (buildApiServer en proceso, sin listen) contra el Postgres compartido. Organización
 * AISLADA `org_lr_<run>` (sociedad + hoteles HA / HB + oficina OC, plan PGC Pymes hotelero
 * provisionado), una segunda organización `org_lr2_<run>` con un lote propio (404 opacos), un
 * usuario REAL con rol [accounting.read, accounting.reports.read, accounting.journal.post,
 * accounting.configure, accounting.entity.read, ai.high_risk.confirm] y otro SIN
 * ai.high_risk.confirm, ambos por /auth/login. Todo creado aquí y borrado en `after`;
 * ficheros canónicos SINTÉTICOS construidos inline (empresa Sage ficticia «1», CIF sintéticos
 * con control válido, ningún NIF real).
 *   · POST preview con una cuenta Sage bloqueable → 200 con unmappedAccounts y canPost false; nada escrito;
 *   · clave extra / options.allowClosed / content + contentBase64 / kind fuera del catálogo → 400 VALIDATION_ERROR en español;
 *   · GET list → 200 array; GET template → CSV con BOM y Content-Disposition;
 *   · PUT account-map → 200 y GET lo devuelve; PUT analytics-map → 200 y GET lo devuelve;
 *   · POST create plan → 201 posted; GET /:id → 200; lote de otra organización / inexistente → 404 opaco sin eco del id;
 *   · POST create journal → 201 con asientos; POST reconciliation con balance sintético → 200 `ok`; GET reconciliation, /:id y /:id/csv;
 *   · reverse sin ai.high_risk.confirm → 403; con permisos → 200 e idempotente (segunda llamada alreadyReversed);
 *   · sin token → 401 en preview / create / reverse (RBAC estricto);
 *   · contentBase64 de 29 MiB (< bodyLimit 30 MiB) → 400 VALIDATION_ERROR por el máximo de 28 MiB del esquema; cuerpo de 31 MiB → 413.
 *   · FIX-1 · F11: lote third_parties sintético → GET /third-parties 200 con lote por fila, orden (rol, código), nombre retenido en 465 / «EMPLEADO»,
 *     paginación por cursor, q por NIF / cuenta, 400 de validación; usuario sin accounting.read → 403; sin token → 401.
 * Faranda y org_123 NUNCA se escriben (recuentos idénticos antes y después). Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/ledger-import-routes.test.mts"
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
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
delete process.env.STRUCTURE_ENABLED;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushAccountingProjection } = await import("../../apps/api/src/modules/accounting/projection.js");
const { flushExtraProjections } = await import("../../apps/api/src/modules/accounting/posting-rules/index.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type ErrorBody = { message?: string; details?: { code?: string; issues?: Array<{ path: string; message: string }> } };
type Response<T> = { status: number; body: T | null; text: string; headers: Record<string, string | string[] | undefined> };
type PreviewBody = { format: string; contentHash: string; rowCount: number; entryCount: number; unmappedAccounts: Array<{ sourceAccount: string; suggestion: unknown }>; unmappedAnalytics: unknown[]; canPost: boolean; blockers: string[] };
type ImportRecord = { id: string; kind: string; status: string; journalEntryIds: string[]; reversalJournalEntryIds: string[]; fileName: string | null };
type CreateResult = { import: ImportRecord; entries: Array<{ status: string; entryNumber: number | null; sourceEntryNumber: string }>; created: number; skipped: number; warnings: string[]; reconciliation: unknown };
type ReverseResult = ImportRecord & { alreadyReversed: boolean };
type AccountMap = { system: string; entries: Array<{ sourceAccount: string; action: string; accountCode: string | null; carryCounterparty: boolean }> };
type AnalyticsMap = { system: string; centreDimension: string; costCentreDimension: string | null; unassignedPolicy: string; entries: Array<{ dimension: string; sourceCode: string; propertyId: string | null; costCentreCode: string | null }> };
type Reconciliation = { id: string; importId: string | null; status: string; accountsCompared: number; differenceCount: number; rows: Array<{ accountCode: string; ok: boolean }>; summary: { nativeOnly: number; missingInLedger: number; amountDiff: number } };

const RUN = Date.now().toString(36);
const ORG = `org_lr_${RUN}`;
const ORG2 = `org_lr2_${RUN}`;
const ENTITY = `le_lr_${RUN}`;
const HA = `prop_lr_ha_${RUN}`;
const HB = `prop_lr_hb_${RUN}`;
const OC = `prop_lr_oc_${RUN}`;
const P2 = `prop_lr2_${RUN}`;
const FULL_EMAIL = `contable.lr.${RUN}@example.com`;
const LIMITED_EMAIL = `contable.lr.limitado.${RUN}@example.com`;
const PASSWORD = `Lr-${RUN}-Secreta-123`;
const FARANDA = "cmrhw9jy30002fyvb6tsdiugt";
const STRICT_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production" };
const FULL_KEYS = ["accounting.read", "accounting.reports.read", "accounting.journal.post", "accounting.configure", "accounting.entity.read", "ai.high_risk.confirm"] as const;
const LIMITED_KEYS = ["accounting.read", "accounting.reports.read", "accounting.journal.post", "accounting.configure", "accounting.entity.read"] as const;
const BASE = "/accounting/ledger-imports";
const MIB = 1024 * 1024;

/** CIF sintético «A» + 7 dígitos + control válido (misma regla que las suites hermanas y los fixtures de L1). */
function syntheticCif(seed: number): string {
  const digits = String(seed % 10_000_000).padStart(7, "0");
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = Number(digits[i]);
    if (i % 2 === 0) {
      const doubled = digit * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else sum += digit;
  }
  return `A${digits}${(10 - (sum % 10)) % 10}`;
}
const TAX_ID = syntheticCif(Date.now());
const NIF_SUMINISTROS = syntheticCif(1234567); // A12345674
const NIF_LAVANDERIA = syntheticCif(3456789); // A34567891
const NIF_VIAJES = syntheticCif(2345678); // A23456783

/** «250,00» (decimal con coma, como exporta Sage). */
function es(value: string | number): string {
  return Number(value).toFixed(2).replace(".", ",");
}
function csv(header: string, rows: readonly string[][]): string {
  return `\uFEFF${[header, ...rows.map((row) => row.join(";"))].join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Ficheros canónicos sintéticos (empresa Sage «1»)
// ---------------------------------------------------------------------------

const PLAN_CSV = csv("cuenta;titulo;nif;pais;longitud", [
  ["6280001", "Electricidad", "", "", "7"],
  ["6290002", "Lavandería externa", "", "", "7"],
  ["4000000042", "Suministros Eléctricos del Noroeste SL", NIF_SUMINISTROS, "ES", "10"],
  ["4100000007", "Lavandería Industrial del Cantábrico SL", NIF_LAVANDERIA, "ES", "10"],
  ["4300000123", "Viajes Cantábrico SL", NIF_VIAJES, "ES", "10"],
  ["4720021", "IVA soportado 21", "", "", "7"],
  ["5720000", "Bancos", "", "", "7"],
  ["9990000001", "Cuenta rara", "", "", "10"]
]);

const JOURNAL_HEADER = "empresa;ejercicio;asiento;fecha;periodo;cuenta;debe;haber;concepto;documento;canal;delegacion;departamento;seccion;proyecto;serie;factura;fecha_factura;nif;nombre;base_iva;tipo_iva;cuota_iva;tipo_factura";
type J = { asiento: string; fecha: string; cuenta: string; debe?: string; haber?: string; concepto: string; documento?: string; delegacion?: string; departamento?: string; serie?: string; factura?: string; fechaFactura?: string; nif?: string; nombre?: string; baseIva?: string; tipoIva?: string; cuotaIva?: string; tipoFactura?: string };
function journalRow(line: J): string[] {
  return ["1", "2026", line.asiento, line.fecha, String(Number(line.fecha.slice(5, 7))), line.cuenta, line.debe ? es(line.debe) : "", line.haber ? es(line.haber) : "", line.concepto, line.documento ?? "", "", line.delegacion ?? "", line.departamento ?? "", "", "", line.serie ?? "", line.factura ?? "", line.fechaFactura ?? "", line.nif ?? "", line.nombre ?? "", line.baseIva ? es(line.baseIva) : "", line.tipoIva ?? "", line.cuotaIva ? es(line.cuotaIva) : "", line.tipoFactura ?? ""];
}
/** Diario de septiembre 2026: 4 asientos (1503 repartido entre HA y HB); Σ D = Σ H = 1.289,00. */
const SEPT_LINES: J[] = [
  { asiento: "1501", fecha: "2026-09-03", cuenta: "6280001", debe: "250", concepto: "Electricidad septiembre", documento: "F-778", delegacion: "HA", departamento: "MANT" },
  { asiento: "1501", fecha: "2026-09-03", cuenta: "4720021", debe: "52.5", concepto: "IVA soportado 21 %", documento: "F-778", delegacion: "HA", baseIva: "250", tipoIva: "21", cuotaIva: "52.5", tipoFactura: "R" },
  { asiento: "1501", fecha: "2026-09-03", cuenta: "4000000042", haber: "302.5", concepto: "Suministros Eléctricos del Noroeste SL", documento: "F-778", delegacion: "HA", serie: "F", factura: "778", fechaFactura: "2026-09-03", nif: NIF_SUMINISTROS, nombre: "SUMINISTROS ELECTRICOS DEL NOROESTE SL", tipoFactura: "R" },
  { asiento: "1503", fecha: "2026-09-05", cuenta: "6290002", debe: "300", concepto: "Lavandería agosto HA", documento: "L-2026-91", delegacion: "HA", departamento: "ADM" },
  { asiento: "1503", fecha: "2026-09-05", cuenta: "6290002", debe: "100", concepto: "Lavandería agosto HB", documento: "L-2026-91", delegacion: "HB", departamento: "ADM" },
  { asiento: "1503", fecha: "2026-09-05", cuenta: "4720021", debe: "84", concepto: "IVA soportado 21 %", documento: "L-2026-91", baseIva: "400", tipoIva: "21", cuotaIva: "84", tipoFactura: "R" },
  { asiento: "1503", fecha: "2026-09-05", cuenta: "4100000007", haber: "484", concepto: "Lavandería Industrial del Cantábrico SL", documento: "L-2026-91", serie: "L", factura: "91", nif: NIF_LAVANDERIA, nombre: "LAVANDERIA INDUSTRIAL DEL CANTABRICO SL", tipoFactura: "R" },
  { asiento: "1504", fecha: "2026-09-06", cuenta: "6280001", debe: "200", concepto: "Electricidad oficina", delegacion: "OC", departamento: "ADM" },
  { asiento: "1504", fecha: "2026-09-06", cuenta: "5720000", haber: "200", concepto: "Electricidad oficina", delegacion: "OC" },
  { asiento: "1505", fecha: "2026-09-07", cuenta: "4000000042", debe: "302.5", concepto: "Pago F-778", delegacion: "HA" },
  { asiento: "1505", fecha: "2026-09-07", cuenta: "5720000", haber: "302.5", concepto: "Pago F-778", delegacion: "HA" }
];
const JOURNAL_SEPT_CSV = csv(JOURNAL_HEADER, SEPT_LINES.map(journalRow));
/** El mismo diario más un apunte sobre una cuenta Sage bloqueable (regla 7 del mapa → unmappedAccounts). */
const JOURNAL_UNMAPPED_CSV = csv(JOURNAL_HEADER, [
  ...SEPT_LINES.map(journalRow),
  journalRow({ asiento: "1506", fecha: "2026-09-08", cuenta: "9990000001", debe: "5", concepto: "Cuenta rara", delegacion: "HA" }),
  journalRow({ asiento: "1506", fecha: "2026-09-08", cuenta: "5720000", haber: "5", concepto: "Cuenta rara", delegacion: "HA" })
]);

const BALANCES_HEADER = "empresa;ejercicio;periodo;cuenta;titulo;delegacion;apertura_debe;apertura_haber;debe;haber;saldo_deudor;saldo_acreedor";
type B = { cuenta: string; titulo: string; debe?: string; haber?: string; deudor?: string; acreedor?: string };
function balanceRow(row: B): string[] {
  return ["1", "2026", "2026-09", row.cuenta, row.titulo, "", es(0), es(0), es(row.debe ?? 0), es(row.haber ?? 0), es(row.deudor ?? 0), es(row.acreedor ?? 0)];
}
/** Sumas y saldos de septiembre 2026 (nivel 0) coherente con el diario contabilizado. */
const BALANCE_SEPT_CSV = csv(BALANCES_HEADER, [
  balanceRow({ cuenta: "6280001", titulo: "Electricidad", debe: "450", deudor: "450" }),
  balanceRow({ cuenta: "4720021", titulo: "IVA soportado 21", debe: "136.5", deudor: "136.5" }),
  balanceRow({ cuenta: "4000000042", titulo: "Suministros Eléctricos", debe: "302.5", haber: "302.5" }),
  balanceRow({ cuenta: "6290002", titulo: "Lavandería externa", debe: "400", deudor: "400" }),
  balanceRow({ cuenta: "4100000007", titulo: "Lavandería Industrial", haber: "484", acreedor: "484" }),
  balanceRow({ cuenta: "5720000", titulo: "Bancos", haber: "502.5", acreedor: "502.5" })
]);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function applyEnv(entries: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  applyEnv(overrides);
  return run().finally(() => applyEnv(previous));
}

let app: ApiApp;
let session: Headers | null = null;
let limitedSession: Headers | null = null;
const roleIds: string[] = [];
const userIds: string[] = [];

async function request<T>(method: "GET" | "POST" | "PUT", url: string, headers: Headers, payload?: unknown): Promise<Response<T>> {
  const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  let body: T | null = null;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, text: res.body, headers: res.headers as Record<string, string | string[] | undefined> };
}

async function login(email: string): Promise<Headers | null> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD, deviceId: "integration-ledger-import-routes" } });
  if (res.statusCode !== 200) return null;
  return { authorization: `Bearer ${(JSON.parse(res.body) as { token: string }).token}` };
}

async function createUser(email: string, fullName: string, keys: readonly string[]): Promise<Headers | null> {
  const permissions = await prisma.permission.findMany({ where: { key: { in: [...keys] } }, select: { id: true, key: true } });
  if (permissions.length !== keys.length) return null;
  const role = await prisma.role.create({ data: { organizationId: ORG, name: `${fullName} ${RUN}`, templateKey: null }, select: { id: true } });
  roleIds.push(role.id);
  await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })) });
  const user = await prisma.user.create({ data: { organizationId: ORG, email, fullName, status: "active", passwordHash: hashPassword(PASSWORD), passwordChangedAt: new Date(), mustChangePassword: false }, select: { id: true } });
  userIds.push(user.id);
  await prisma.userPropertyRole.createMany({ data: [HA, HB, OC].map((propertyId) => ({ userId: user.id, propertyId, roleId: role.id })) });
  return login(email);
}

type Invariants = { entries: number; imports: number; reconciliations: number; org123Entries: number };
/**
 * Invariantes de OTRAS organizaciones. Faranda: recuentos totales (solo lectura en toda
 * la suite). org_123: SOLO los asientos que este importador podría escribir
 * (`source_type` sage200_*) — las suites hermanas de `test:integration` (billing-money,
 * fiscal-models, structure-*) emiten y anulan facturas en org_123 en paralelo, así que
 * el recuento total de asientos de org_123 oscila durante la pasada completa (corrector
 * L3 · Puerta 9: 63 vs 57) sin que este fichero haya escrito nada allí.
 */
async function invariants(): Promise<Invariants> {
  const [row] = await prisma.$queryRaw<Array<Record<string, bigint>>>`
    SELECT
      (SELECT count(*) FROM journal_entries WHERE organization_id = ${FARANDA}) AS entries,
      (SELECT count(*) FROM ledger_imports WHERE organization_id = ${FARANDA}) AS imports,
      (SELECT count(*) FROM ledger_reconciliations WHERE organization_id = ${FARANDA}) AS reconciliations,
      (SELECT count(*) FROM journal_entries WHERE organization_id = 'org_123' AND source_type LIKE 'sage200%') AS org123_entries`;
  return { entries: Number(row!.entries), imports: Number(row!.imports), reconciliations: Number(row!.reconciliations), org123Entries: Number(row!.org123_entries) };
}

async function cleanup(): Promise<void> {
  for (const organizationId of [ORG, ORG2]) {
    await prisma.ledgerReconciliation.deleteMany({ where: { organizationId } });
    await prisma.ledgerImportBalance.deleteMany({ where: { organizationId } });
    await prisma.ledgerImportEntry.deleteMany({ where: { organizationId } });
    await prisma.ledgerImport.deleteMany({ where: { organizationId } });
    await prisma.ledgerAccountMap.deleteMany({ where: { organizationId } });
    await prisma.ledgerAnalyticsMap.deleteMany({ where: { organizationId } });
    await prisma.ledgerThirdParty.deleteMany({ where: { organizationId } });
  }
  await prisma.costCenter.deleteMany({ where: { propertyId: { in: [HA, HB, OC] } } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (entries.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((entry) => entry.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  if (userIds.length) {
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.device.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userPropertyRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (roleIds.length) {
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
  }
  await prisma.property.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG2] } } });
}

let invariantsBefore: Invariants;
let foreignImportId = "";

before(async () => {
  invariantsBefore = await invariants();
  await prisma.organization.create({ data: { id: ORG, name: "LR Sociedad Test", country: "ES" } });
  await prisma.organization.create({ data: { id: ORG2, name: "LR Otra Sociedad Test", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: ENTITY, organizationId: ORG, code: "LRT", legalName: "Hoteles del Cantábrico Norte Rutas Test SA", taxId: TAX_ID, legalForm: "sa", fiscalAddress: "Calle Prueba 8", fiscalMunicipality: "Gijón", fiscalProvince: "Asturias", isDefault: true, status: "active" } });
  await prisma.property.create({ data: { id: HA, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "HA", name: "Hotel Alfa Rutas", createdAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.property.create({ data: { id: HB, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "HB", name: "Hotel Beta Rutas", createdAt: new Date("2026-01-02T00:00:00Z") } });
  await prisma.property.create({ data: { id: OC, organizationId: ORG, legalEntityId: ENTITY, kind: "office", code: "OC", name: "Oficina central LR", createdAt: new Date("2026-01-03T00:00:00Z") } });
  await prisma.property.create({ data: { id: P2, organizationId: ORG2, kind: "hotel", code: "P2", name: "Otra Sociedad Rutas" } });
  await provisionOrganizationChart(ORG);
  // Lote de OTRA organización (fila mínima): GET /:id desde ORG debe responder el 404 opaco de tenencia.
  const foreign = await prisma.ledgerImport.create({ data: { organizationId: ORG2, system: "sage200", kind: "plan", format: "canonical_csv", fileName: "plan-otra.csv", contentHash: "f".repeat(64), status: "draft" }, select: { id: true } });
  foreignImportId = foreign.id;

  app = await buildApiServer();
  await app.ready();
  session = await createUser(FULL_EMAIL, "Contable LR", FULL_KEYS);
  limitedSession = await createUser(LIMITED_EMAIL, "Contable LR limitado", LIMITED_KEYS);
});

after(async () => {
  try {
    await flushAuditQueues();
    await flushAccountingProjection();
    await flushExtraProjections();
    await cleanup();
    assert.deepEqual(await invariants(), invariantsBefore, "Faranda y org_123 no cambian");
  } finally {
    await app?.close();
    await prisma.$disconnect();
  }
});

const NO_SESSION = "no se pudo crear la sesión real del usuario aislado (catálogo de permisos incompleto o login fallido): caso no ejercitado";
function needsSession(t: { skip: (reason: string) => void }): Headers | null {
  if (!session) {
    t.skip(NO_SESSION);
    return null;
  }
  return session;
}

let importPlan = "";
let importJournal = "";
let reconciliationId = "";

describe("L3 · POST /accounting/ledger-imports/preview (nunca escribe) y validación .strict()", () => {
  it("diario con una cuenta Sage bloqueable → 200 con unmappedAccounts[0].sourceAccount 9990000001 y canPost false; nada escrito", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const res = await request<PreviewBody>("POST", `${BASE}/preview`, s, { kind: "journal", fileName: "diario-2026-09.csv", content: JOURNAL_UNMAPPED_CSV });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    assert.ok(res.body);
    assert.equal(res.body.format, "canonical_csv");
    assert.match(res.body.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(res.body.rowCount, 13);
    assert.deepEqual(res.body.unmappedAccounts.map((row) => row.sourceAccount), ["9990000001"]);
    assert.equal(res.body.canPost, false);
    assert.ok(res.body.blockers.length > 0);
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG } }), 0, "la preview nunca escribe");
  });

  it("clave extra, options.allowClosed (solo CLI), content + contentBase64 y kind fuera del catálogo → 400 VALIDATION_ERROR en español", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const extra = await request<ErrorBody>("POST", `${BASE}/preview`, s, { kind: "journal", content: JOURNAL_SEPT_CSV, fichero: "x.csv" });
    assert.equal(extra.status, 400, extra.text.slice(0, 300));
    assert.equal(extra.body?.details?.code, "VALIDATION_ERROR");
    assert.match(extra.body?.message ?? "", /^body no válido: clave no admitida: 'fichero'$/);
    const allowClosed = await request<ErrorBody>("POST", `${BASE}/preview`, s, { kind: "journal", content: JOURNAL_SEPT_CSV, options: { allowClosed: true } });
    assert.equal(allowClosed.status, 400, allowClosed.text.slice(0, 300));
    assert.equal(allowClosed.body?.details?.code, "VALIDATION_ERROR");
    assert.match(allowClosed.body?.message ?? "", /'allowClosed'/);
    const both = await request<ErrorBody>("POST", `${BASE}/preview`, s, { kind: "journal", content: JOURNAL_SEPT_CSV, contentBase64: Buffer.from(JOURNAL_SEPT_CSV, "utf8").toString("base64") });
    assert.equal(both.status, 400);
    assert.match(both.body?.message ?? "", /Indica content \(texto\) o contentBase64 \(fichero\), no ambos/);
    const badKind = await request<ErrorBody>("POST", `${BASE}/preview`, s, { kind: "diario", content: JOURNAL_SEPT_CSV });
    assert.equal(badKind.status, 400);
    assert.match(badKind.body?.message ?? "", /^body no válido: kind: valor no admitido 'diario'; valores válidos: plan \| fiscal_years \| journal \| vat_books \| third_parties \| balances$/);
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG } }), 0);
  });
});

describe("L3 · listado, plantilla y mapas", () => {
  it("GET /accounting/ledger-imports → 200 array vacío; limit=0 → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const res = await request<unknown[]>("GET", BASE, s);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(res.body, []);
    const badLimit = await request<ErrorBody>("GET", `${BASE}?limit=0`, s);
    assert.equal(badLimit.status, 400);
    assert.match(badLimit.body?.message ?? "", /limit debe ser un entero entre 1 y 200/);
  });

  it("GET /accounting/ledger-imports/template?kind=journal → CSV con BOM, «;», Content-Disposition plantilla-sage200-journal.csv y no-store", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const res = await request<never>("GET", `${BASE}/template?kind=journal&format=csv`, s);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.match(String(res.headers["content-type"]), /^text\/csv; charset=utf-8/);
    assert.equal(res.headers["content-disposition"], 'attachment; filename="plantilla-sage200-journal.csv"');
    assert.equal(res.headers["cache-control"], "no-store");
    assert.ok(res.text.startsWith("\uFEFF"), "BOM UTF-8");
    assert.match(res.text.split("\r\n")[0] ?? "", /^\uFEFFempresa;ejercicio;asiento;fecha;periodo;cuenta;debe;haber/);
    const balances = await request<never>("GET", `${BASE}/template?kind=balances`, s);
    assert.equal(balances.status, 200);
    assert.equal(balances.headers["content-disposition"], 'attachment; filename="plantilla-sage200-balances.csv"');
    const badFormat = await request<ErrorBody>("GET", `${BASE}/template?kind=journal&format=xlsx`, s);
    assert.equal(badFormat.status, 400);
    assert.match(badFormat.body?.message ?? "", /^query no válido: format: valor no admitido; se esperaba "csv"$/);
  });

  it("PUT /accounting/ledger-imports/account-map → 200 con las filas normalizadas; GET las devuelve; fila inválida → 400 LEDGER_IMPORT_MAP_INVALID", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const entries = [
      { sourceAccount: "6280001", sourceName: "Electricidad", action: "map", accountCode: "628.1" },
      { sourceAccount: "4300000123", sourceName: "Viajes Cantábrico SL", action: "collapse", accountCode: "4300", carryCounterparty: true },
      { sourceAccount: "9990000001", sourceName: "Cuenta rara", action: "block", accountCode: null }
    ];
    const put = await request<AccountMap>("PUT", `${BASE}/account-map`, s, { entries });
    assert.equal(put.status, 200, put.text.slice(0, 400));
    assert.equal(put.body?.system, "sage200");
    const bySource = new Map(put.body!.entries.map((entry) => [entry.sourceAccount, entry]));
    assert.deepEqual([bySource.get("6280001")?.action, bySource.get("6280001")?.accountCode, bySource.get("6280001")?.carryCounterparty], ["map", "628.1", false]);
    assert.deepEqual([bySource.get("4300000123")?.action, bySource.get("4300000123")?.accountCode, bySource.get("4300000123")?.carryCounterparty], ["collapse", "4300", true]);
    assert.deepEqual([bySource.get("9990000001")?.action, bySource.get("9990000001")?.accountCode], ["block", null]);
    const get = await request<AccountMap>("GET", `${BASE}/account-map`, s);
    assert.equal(get.status, 200, get.text.slice(0, 300));
    assert.deepEqual(get.body, put.body);
    const invalid = await request<ErrorBody>("PUT", `${BASE}/account-map`, s, { entries: [{ sourceAccount: "6280001", action: "map", accountCode: "999999" }] });
    assert.equal(invalid.status, 400, invalid.text.slice(0, 300));
    assert.equal(invalid.body?.details?.code, "LEDGER_IMPORT_MAP_INVALID");
    const badPattern = await request<ErrorBody>("PUT", `${BASE}/account-map`, s, { entries: [{ sourceAccount: "6280001", action: "map", accountCode: "0628" }] });
    assert.equal(badPattern.status, 400);
    assert.equal(badPattern.body?.details?.code, "VALIDATION_ERROR");
    assert.match(badPattern.body?.message ?? "", /accountCode debe ser una cuenta PGC/);
  });

  it("PUT /accounting/ledger-imports/analytics-map → 200 (delegación → centro, departamento → centro de coste USALI); GET lo devuelve; centro ajeno → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const body = {
      centreDimension: "delegacion",
      costCentreDimension: "departamento",
      unassignedPolicy: "block",
      entries: [
        { dimension: "delegacion", sourceCode: "HA", sourceName: "Hotel Alfa", propertyId: HA, costCentreCode: null },
        { dimension: "delegacion", sourceCode: "HB", sourceName: "Hotel Beta", propertyId: HB, costCentreCode: null },
        { dimension: "delegacion", sourceCode: "OC", sourceName: "Oficina", propertyId: OC, costCentreCode: null },
        { dimension: "departamento", sourceCode: "HAB", propertyId: null, costCentreCode: "ROOMS" },
        { dimension: "departamento", sourceCode: "ADM", propertyId: null, costCentreCode: "ADMIN_GENERAL" },
        { dimension: "departamento", sourceCode: "MANT", propertyId: null, costCentreCode: "POM" }
      ]
    };
    const put = await request<AnalyticsMap>("PUT", `${BASE}/analytics-map`, s, body);
    assert.equal(put.status, 200, put.text.slice(0, 400));
    assert.deepEqual([put.body?.system, put.body?.centreDimension, put.body?.costCentreDimension, put.body?.unassignedPolicy, put.body?.entries.length], ["sage200", "delegacion", "departamento", "block", 6]);
    const get = await request<AnalyticsMap>("GET", `${BASE}/analytics-map`, s);
    assert.equal(get.status, 200, get.text.slice(0, 300));
    assert.deepEqual(get.body, put.body);
    const foreign = await request<ErrorBody>("PUT", `${BASE}/analytics-map`, s, { ...body, entries: [{ dimension: "delegacion", sourceCode: "ZZ", propertyId: P2, costCentreCode: null }] });
    assert.equal(foreign.status, 400, foreign.text.slice(0, 300));
    assert.equal(foreign.body?.details?.code, "LEDGER_IMPORT_MAP_INVALID");
    const badPolicy = await request<ErrorBody>("PUT", `${BASE}/analytics-map`, s, { ...body, unassignedPolicy: "manual" });
    assert.equal(badPolicy.status, 400);
    assert.match(badPolicy.body?.message ?? "", /unassignedPolicy debe ser block, office o property:<propertyId>/);
  });
});

describe("L3 · lotes: crear, detalle, 404 opacos", () => {
  it("POST /accounting/ledger-imports (plan sintético) → 201 posted; GET /:id → 200 con el mismo lote y su mapeo", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const res = await request<CreateResult>("POST", BASE, s, { kind: "plan", fileName: "plan-cuentas.csv", content: PLAN_CSV, notes: "plan de prueba" });
    assert.equal(res.status, 201, res.text.slice(0, 500));
    assert.ok(res.body);
    assert.equal(res.body.import.kind, "plan");
    assert.equal(res.body.import.status, "posted");
    assert.equal(res.body.import.fileName, "plan-cuentas.csv");
    importPlan = res.body.import.id;
    const row = await prisma.ledgerImport.findUniqueOrThrow({ where: { id: importPlan } });
    assert.equal(row.organizationId, ORG);
    assert.equal(row.legalEntityId, ENTITY);
    assert.equal(row.status, "posted");
    const detail = await request<{ import: ImportRecord; entries: unknown[]; entryTotal: number; mapping: unknown }>("GET", `${BASE}/${importPlan}`, s);
    assert.equal(detail.status, 200, detail.text.slice(0, 300));
    assert.equal(detail.body?.import.id, importPlan);
    assert.ok(Array.isArray(detail.body?.entries));
    const list = await request<ImportRecord[]>("GET", `${BASE}?kind=plan&status=posted`, s);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body?.map((row) => row.id), [importPlan]);
  });

  it("GET /:id de un lote de otra organización y de un id inexistente → 404 opaco (mismo mensaje, sin eco del id); POST /:id/post y /:id/reverse igual", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const foreign = await request<ErrorBody>("GET", `${BASE}/${foreignImportId}`, s);
    assert.equal(foreign.status, 404, foreign.text.slice(0, 300));
    assert.equal(foreign.body?.message, "Importación contable no encontrada.");
    assert.ok(!foreign.text.includes(foreignImportId), "el 404 nunca repite el id");
    assert.ok(!foreign.text.includes(ORG2), "ni la organización");
    const missing = await request<ErrorBody>("GET", `${BASE}/no-existe-${RUN}`, s);
    assert.equal(missing.status, 404);
    assert.equal(missing.body?.message, foreign.body?.message, "existente en otra organización e inexistente comparten el mensaje neutro");
    const post = await request<ErrorBody>("POST", `${BASE}/${foreignImportId}/post`, s, {});
    assert.equal(post.status, 404);
    assert.equal(post.body?.message, foreign.body?.message);
    const reverse = await request<ErrorBody>("POST", `${BASE}/${foreignImportId}/reverse`, s, { reason: "prueba de integración (otra organización)" });
    assert.equal(reverse.status, 404);
    assert.equal(reverse.body?.message, foreign.body?.message);
    assert.equal((await prisma.ledgerImport.findUniqueOrThrow({ where: { id: foreignImportId } })).status, "draft", "nada escrito en la otra organización");
  });
});

describe("L3 · diario, reconciliación y reverso", () => {
  it("POST /accounting/ledger-imports (journal sintético) → 201 posted con 5 asientos (1503 repartido entre HA y HB) y Σ exacta", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const preview = await request<PreviewBody>("POST", `${BASE}/preview`, s, { kind: "journal", fileName: "diario-2026-09.csv", content: JOURNAL_SEPT_CSV });
    assert.equal(preview.status, 200, preview.text.slice(0, 500));
    assert.deepEqual(preview.body?.unmappedAccounts, []);
    assert.deepEqual(preview.body?.unmappedAnalytics, []);
    assert.equal(preview.body?.canPost, true, preview.text.slice(0, 800));
    const res = await request<CreateResult>("POST", BASE, s, { kind: "journal", fileName: "diario-2026-09.csv", content: JOURNAL_SEPT_CSV, notes: "septiembre" });
    assert.equal(res.status, 201, res.text.slice(0, 800));
    assert.ok(res.body);
    importJournal = res.body.import.id;
    assert.equal(res.body.import.status, "posted");
    assert.equal(res.body.import.journalEntryIds.length, 5, "1501 · 1503 HA · 1503 HB · 1504 · 1505");
    assert.equal(res.body.created, 5);
    assert.equal(res.body.reconciliation, null);
    const entries = await prisma.journalEntry.findMany({ where: { id: { in: res.body.import.journalEntryIds } } });
    assert.equal(entries.length, 5);
    for (const entry of entries) {
      assert.equal(entry.organizationId, ORG);
      assert.equal(entry.sourceType, "sage200_journal");
      assert.equal(entry.status, "posted");
      assert.match(entry.reference ?? "", /Sage 200/);
    }
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: { in: res.body.import.journalEntryIds } }, select: { debit: true, credit: true } });
    const debit = lines.reduce((sum, line) => sum + Number(line.debit), 0);
    const credit = lines.reduce((sum, line) => sum + Number(line.credit), 0);
    assert.equal(debit.toFixed(2), "1289.00");
    assert.equal(credit.toFixed(2), "1289.00");
  });

  it("POST /accounting/ledger-imports/reconciliation con el balance sintético del mismo mes → 200 `ok`; GET lista, /:id y /:id/csv (CSV con BOM)", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const res = await request<Reconciliation>("POST", `${BASE}/reconciliation`, s, { from: "2026-09-01", to: "2026-09-30", content: BALANCE_SEPT_CSV, importId: importJournal });
    assert.equal(res.status, 200, res.text.slice(0, 800));
    assert.ok(res.body);
    reconciliationId = res.body.id;
    assert.equal(res.body.importId, importJournal);
    assert.equal(res.body.status, "ok", JSON.stringify(res.body.rows.filter((row) => !row.ok)).slice(0, 800));
    assert.equal(res.body.differenceCount, 0);
    assert.ok(res.body.accountsCompared >= 6, `cuentas comparadas: ${res.body.accountsCompared}`);
    assert.equal(await prisma.ledgerReconciliation.count({ where: { organizationId: ORG } }), 1);
    const list = await request<Reconciliation[]>("GET", `${BASE}/reconciliation?from=2026-09-01&to=2026-09-30`, s);
    assert.equal(list.status, 200, list.text.slice(0, 300));
    assert.deepEqual(list.body?.map((row) => row.id), [reconciliationId]);
    const detail = await request<Reconciliation>("GET", `${BASE}/reconciliation/${reconciliationId}`, s);
    assert.equal(detail.status, 200, detail.text.slice(0, 300));
    assert.equal(detail.body?.id, reconciliationId);
    const file = await request<never>("GET", `${BASE}/reconciliation/${reconciliationId}/csv`, s);
    assert.equal(file.status, 200, file.text.slice(0, 300));
    assert.match(String(file.headers["content-type"]), /^text\/csv; charset=utf-8/);
    assert.match(String(file.headers["content-disposition"]), /^attachment; filename="reconciliacion-sage200-.*\.csv"$/);
    assert.ok(file.text.startsWith("\uFEFF"), "BOM UTF-8");
    assert.match(file.text.split("\r\n")[0] ?? "", /^\uFEFFcuenta;nombre;cuentas_sage;debe_sage;haber_sage/);
    const missing = await request<ErrorBody>("GET", `${BASE}/reconciliation/no-existe-${RUN}`, s);
    assert.equal(missing.status, 404);
    assert.equal(missing.body?.message, "Reconciliación contable no encontrada.");
    const inverted = await request<ErrorBody>("POST", `${BASE}/reconciliation`, s, { from: "2026-09-30", to: "2026-09-01", content: BALANCE_SEPT_CSV });
    assert.equal(inverted.status, 400);
    assert.match(inverted.body?.message ?? "", /to debe ser igual o posterior a from/);
  });

  it("POST /:id/reverse sin ai.high_risk.confirm → 403 (RBAC estricto: en dev la sesión real se une a la base demo) y el lote sigue posted", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    if (!limitedSession) return t.skip(NO_SESSION);
    await withEnv(STRICT_ENV, async () => {
      const res = await request<ErrorBody>("POST", `${BASE}/${importJournal}/reverse`, limitedSession!, { reason: "intento sin la clave de alto riesgo" });
      assert.equal(res.status, 403, res.text.slice(0, 300));
      const allowed = await request<{ id: string }>("GET", `${BASE}/${importJournal}`, limitedSession!);
      assert.equal(allowed.status, 200, "sin la clave de alto riesgo sigue leyendo el lote");
    });
    assert.equal((await prisma.ledgerImport.findUniqueOrThrow({ where: { id: importJournal } })).status, "posted");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), 5, "ningún reverso escrito");
  });

  it("POST /:id/reverse con permisos → 200 reversed (5 reversos marcados); segunda llamada → 200 alreadyReversed sin escribir; reason corto → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const short = await request<ErrorBody>("POST", `${BASE}/${importJournal}/reverse`, s, { reason: "no" });
    assert.equal(short.status, 400);
    assert.match(short.body?.message ?? "", /reason debe tener al menos 3 caracteres/);
    const res = await request<ReverseResult>("POST", `${BASE}/${importJournal}/reverse`, s, { reason: "diario de septiembre erróneo (prueba de integración)" });
    assert.equal(res.status, 200, res.text.slice(0, 500));
    assert.equal(res.body?.status, "reversed");
    assert.equal(res.body?.alreadyReversed, false);
    assert.equal(res.body?.reversalJournalEntryIds.length, 5);
    const reversals = await prisma.journalEntry.count({ where: { id: { in: res.body!.reversalJournalEntryIds }, organizationId: ORG, entryKind: "reversal" } });
    assert.equal(reversals, 5, "un reverso marcado por asiento del lote");
    const again = await request<ReverseResult>("POST", `${BASE}/${importJournal}/reverse`, s, { reason: "otra vez" });
    assert.equal(again.status, 200, again.text.slice(0, 300));
    assert.equal(again.body?.alreadyReversed, true);
    assert.deepEqual(again.body?.reversalJournalEntryIds, res.body?.reversalJournalEntryIds, "idempotente: los mismos reversos");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), 10, "5 asientos + 5 reversos, nada más");
  });
});

describe("L3 · RBAC estricto y límites de cuerpo", () => {
  it("sin token → 401 en preview, create y reverse (RBAC estricto, sin fallback demo)", async () => {
    await withEnv(STRICT_ENV, async () => {
      const cases: Array<["POST", string, unknown]> = [
        ["POST", `${BASE}/preview`, { kind: "journal", content: JOURNAL_SEPT_CSV }],
        ["POST", BASE, { kind: "journal", content: JOURNAL_SEPT_CSV }],
        ["POST", `${BASE}/${importJournal || "x"}/reverse`, { reason: "sin token" }]
      ];
      for (const [method, url, payload] of cases) {
        const res = await request<ErrorBody>(method, url, {}, payload);
        assert.equal(res.status, 401, `${method} ${url}: ${res.text.slice(0, 200)}`);
      }
    });
  });

  it("contentBase64 de 29 MiB (< bodyLimit 30 MiB) → 400 VALIDATION_ERROR por el máximo de 28 MiB del esquema; cuerpo de 31 MiB → 413", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const tooLongForSchema = await request<ErrorBody>("POST", `${BASE}/preview`, s, { kind: "journal", contentBase64: "A".repeat(29 * MIB) });
    assert.equal(tooLongForSchema.status, 400, tooLongForSchema.text.slice(0, 300));
    assert.equal(tooLongForSchema.body?.details?.code, "VALIDATION_ERROR");
    assert.match(tooLongForSchema.body?.message ?? "", /contentBase64 no puede superar 29\.360\.128 caracteres/);
    const tooLargeForFastify = await request<ErrorBody>("POST", `${BASE}/preview`, s, { kind: "journal", contentBase64: "A".repeat(31 * MIB) });
    assert.equal(tooLargeForFastify.status, 413, tooLargeForFastify.text.slice(0, 300));
    const createTooLarge = await request<ErrorBody>("POST", BASE, s, { kind: "journal", contentBase64: "A".repeat(31 * MIB) });
    assert.equal(createTooLarge.status, 413, createTooLarge.text.slice(0, 300));
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG } }), 2, "solo los dos lotes de la suite");
  });
});

// ---------------------------------------------------------------------------
// FIX-1 · F11 (E-05): directorio de solo lectura de los terceros importados
// ---------------------------------------------------------------------------

type ThirdPartyRow = { id: string; sourceCode: string; role: string; sourceAccount: string | null; taxId: string | null; countryCode: string; name: string | null; supplierId: string | null; updatedAt: string; lote: { importId: string; fileName: string | null; createdAt: string } | null };
type ThirdPartyPage = { rows: ThirdPartyRow[]; total: number; nextCursor: string | null };

const TP = `${BASE}/third-parties`;
const NO_READ_EMAIL = `contable.lr.sinlectura.${RUN}@example.com`;
/** Nombres INVENTADOS: dos sociedades, un cliente, una subcuenta 465 (personal) y un «EMPLEADO nnnn»; el directorio nunca devuelve estos dos últimos nombres. */
const PERSONAL_NAME = "Nombre Inventado De Persona";
const MASKED_NAME = "EMPLEADO 0000901";
const THIRD_PARTIES_CSV = csv("codigo;rol;cuenta;nif;pais;nombre", [
  ["42", "supplier", "4000000042", NIF_SUMINISTROS, "ES", "Suministros Eléctricos del Noroeste SL"],
  ["7", "supplier", "4100000007", NIF_LAVANDERIA, "ES", "Lavandería Industrial del Cantábrico SL"],
  ["123", "customer", "4300000123", NIF_VIAJES, "ES", "Viajes Cantábrico SL"],
  ["900", "supplier", "4650000900", "", "ES", PERSONAL_NAME],
  ["901", "supplier", "4100000901", "", "ES", MASKED_NAME]
]);
let importThirdParties = "";

/** Lo que había antes del lote de terceros (el lote `plan` de la suite ya dio de alta los terceros con NIF de las cuentas 400 / 410 / 430, sin entrada `third_parties` → `lote: null`). */
let baseline = { total: 0, customers: 0, lots: 0 };
const OWN_CODES = ["42", "7", "123", "900", "901"];

describe("L3 · FIX-1 · F11 · GET /accounting/ledger-imports/third-parties (terceros importados)", () => {
  it("POST lote third_parties sintético → 201 posted (5 terceros, 0 suppliers); GET third-parties → 200 total +5 en orden (rol, código), lote en las filas del lote (null en las del plan) y nombre retenido en 465 / «EMPLEADO»", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const before = await request<ThirdPartyPage>("GET", TP, s);
    assert.equal(before.status, 200, before.text.slice(0, 500));
    baseline = { total: before.body!.total, customers: before.body!.rows.filter((row) => row.role === "customer").length, lots: await prisma.ledgerImport.count({ where: { organizationId: ORG } }) };
    assert.equal(baseline.total, await prisma.ledgerThirdParty.count({ where: { organizationId: ORG } }));
    assert.ok(before.body!.rows.every((row) => row.lote === null), "los terceros del lote plan no tienen entrada third_parties");
    for (const code of OWN_CODES) assert.ok(!before.body!.rows.some((row) => row.sourceCode === code), `código ${code} aún no existe`);

    const created = await request<CreateResult>("POST", BASE, s, { kind: "third_parties", fileName: "terceros-lr.csv", content: THIRD_PARTIES_CSV });
    assert.equal(created.status, 201, created.text.slice(0, 500));
    assert.equal(created.body?.import.kind, "third_parties");
    assert.equal(created.body?.import.status, "posted");
    assert.equal(created.body?.created, 5);
    importThirdParties = created.body!.import.id;
    assert.equal(await prisma.ledgerThirdParty.count({ where: { organizationId: ORG } }), baseline.total + 5);
    assert.equal(await prisma.supplier.count({ where: { organizationId: ORG } }), 0, "sin createSuppliers no se crean proveedores");

    const res = await request<ThirdPartyPage>("GET", TP, s);
    assert.equal(res.status, 200, res.text.slice(0, 500));
    assert.equal(res.body?.total, baseline.total + 5);
    assert.equal(res.headers["x-total-count"], String(baseline.total + 5));
    assert.equal(res.headers["x-next-cursor"], undefined, "una sola página");
    assert.equal(res.body?.nextCursor, null);
    assert.equal(res.body?.rows.length, baseline.total + 5);
    const keys = res.body!.rows.map((row) => [row.role, row.sourceCode] as const);
    for (let i = 1; i < keys.length; i++) {
      const [prevRole, prevCode] = keys[i - 1]!;
      const [role, code] = keys[i]!;
      assert.ok(prevRole < role || (prevRole === role && prevCode < code), `orden (rol, código) en ${prevRole}:${prevCode} → ${role}:${code}`);
    }
    const own = res.body!.rows.filter((row) => OWN_CODES.includes(row.sourceCode));
    assert.equal(own.length, 5);
    for (const row of own) {
      assert.ok(row.lote, `lote de ${row.sourceCode}`);
      assert.equal(row.lote?.importId, importThirdParties);
      assert.equal(row.lote?.fileName, "terceros-lr.csv");
      assert.match(row.lote?.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.match(row.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(row.countryCode, "ES");
      assert.equal(row.supplierId, null);
    }
    assert.ok(res.body!.rows.filter((row) => !OWN_CODES.includes(row.sourceCode)).every((row) => row.lote === null), "las filas del plan siguen sin lote");
    const byCode = new Map(own.map((row) => [row.sourceCode, row]));
    assert.equal(byCode.get("42")?.role, "supplier");
    assert.equal(byCode.get("42")?.name, "Suministros Eléctricos del Noroeste SL");
    assert.equal(byCode.get("42")?.taxId, NIF_SUMINISTROS);
    assert.equal(byCode.get("42")?.sourceAccount, "4000000042");
    assert.equal(byCode.get("123")?.role, "customer");
    assert.equal(byCode.get("123")?.name, "Viajes Cantábrico SL");
    assert.equal(byCode.get("900")?.name, null, "subcuenta 465: sin nombre");
    assert.equal(byCode.get("901")?.name, null, "«EMPLEADO nnnn»: sin nombre");
    assert.ok(!res.text.includes(PERSONAL_NAME) && !res.text.includes(MASKED_NAME), "la respuesta no lleva los nombres retenidos");
  });

  it("paginación por cursor: limit=2 → 2 filas y X-Next-Cursor; las páginas siguientes no repiten y cubren el total; cursor inválido, limit=0, role fuera del catálogo y clave extra → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const total = baseline.total + 5;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = cursor ? `${TP}?limit=2&cursor=${encodeURIComponent(cursor)}` : `${TP}?limit=2`;
      const res: Response<ThirdPartyPage> = await request<ThirdPartyPage>("GET", url, s);
      assert.equal(res.status, 200, res.text.slice(0, 400));
      assert.equal(res.body?.total, total, "total del filtro en cada página");
      assert.ok((res.body?.rows.length ?? 0) <= 2);
      seen.push(...res.body!.rows.map((row) => row.id));
      cursor = res.body?.nextCursor ?? null;
      if (cursor) assert.equal(res.headers["x-next-cursor"], cursor);
      pages += 1;
    } while (cursor && pages < 50);
    assert.equal(pages, Math.ceil(total / 2), "páginas de 2");
    assert.equal(new Set(seen).size, total, "sin repeticiones");
    assert.equal(seen.length, total);
    const bad = await request<ErrorBody>("GET", `${TP}?cursor=no-es-un-cursor`, s);
    assert.equal(bad.status, 400, bad.text.slice(0, 300));
    assert.match(bad.body?.message ?? "", /cursor de paginación no es válido/);
    const zero = await request<ErrorBody>("GET", `${TP}?limit=0`, s);
    assert.equal(zero.status, 400, zero.text.slice(0, 300));
    const role = await request<ErrorBody>("GET", `${TP}?role=proveedor`, s);
    assert.equal(role.status, 400, role.text.slice(0, 300));
    assert.equal(role.body?.details?.code, "VALIDATION_ERROR");
    assert.match(role.body?.message ?? "", /^query no válido: role: valor no admitido 'proveedor'; valores válidos: customer \| supplier$/);
    const extra = await request<ErrorBody>("GET", `${TP}?nombre=x`, s);
    assert.equal(extra.status, 400, extra.text.slice(0, 300));
  });

  it("q por NIF en minúsculas + role=supplier → solo filas con ese NIF (incluida la 42); q por cuenta «43» → solo clientes de la 43 (incluida la 123); role=customer → clientes +1; q sin coincidencias → total 0; q de 81 caracteres → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const byNif = await request<ThirdPartyPage>("GET", `${TP}?q=${encodeURIComponent(NIF_SUMINISTROS.toLowerCase())}&role=supplier`, s);
    assert.equal(byNif.status, 200, byNif.text.slice(0, 400));
    assert.ok((byNif.body?.total ?? 0) >= 1);
    assert.equal(byNif.headers["x-total-count"], String(byNif.body?.total));
    assert.ok(byNif.body!.rows.every((row) => row.taxId === NIF_SUMINISTROS && row.role === "supplier"), "solo el NIF buscado, solo proveedores");
    assert.ok(byNif.body!.rows.some((row) => row.sourceCode === "42"));
    const byAccount = await request<ThirdPartyPage>("GET", `${TP}?q=43`, s);
    assert.equal(byAccount.status, 200);
    assert.ok(byAccount.body!.rows.every((row) => row.role === "customer" && (row.sourceAccount ?? "").startsWith("43")), "cuenta 43…: clientes");
    assert.ok(byAccount.body!.rows.some((row) => row.sourceCode === "123"));
    const byRole = await request<ThirdPartyPage>("GET", `${TP}?role=customer`, s);
    assert.equal(byRole.body?.total, baseline.customers + 1);
    assert.ok(byRole.body!.rows.every((row) => row.role === "customer"));
    const none = await request<ThirdPartyPage>("GET", `${TP}?q=zzz-sin-coincidencia`, s);
    assert.equal(none.status, 200);
    assert.equal(none.body?.total, 0);
    assert.deepEqual(none.body?.rows, []);
    const tooLong = await request<ErrorBody>("GET", `${TP}?q=${"a".repeat(81)}`, s);
    assert.equal(tooLong.status, 400, tooLong.text.slice(0, 300));
    assert.match(tooLong.body?.message ?? "", /q no puede superar 80 caracteres/);
  });

  it("usuario sin accounting.read → 403; sin token en RBAC estricto → 401", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const noRead = await createUser(NO_READ_EMAIL, "Contable LR sin lectura", ["accounting.journal.post"]);
    if (!noRead) {
      t.skip(NO_SESSION);
      return;
    }
    const forbidden = await request<ErrorBody>("GET", TP, noRead);
    assert.equal(forbidden.status, 403, forbidden.text.slice(0, 300));
    await withEnv(STRICT_ENV, async () => {
      const anonymous = await request<ErrorBody>("GET", TP, {});
      assert.equal(anonymous.status, 401, anonymous.text.slice(0, 200));
    });
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG } }), baseline.lots + 1, "los lotes anteriores y el de terceros");
  });

  it("(R11 · CIERRE-1) usuario de centro sin accounting.entity.read → 404 ENTITY_SCOPE_REQUIRED en GET third-parties; con accounting.entity.read → 200", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    // Rol custom con las claves del gate y del servicio (reports.read + accounting.read) pero SIN
    // accounting.entity.read, asignado por centro (user_property_roles en HA / HB / OC →
    // assignedPropertyIds definido, orgScope false): el residuo SEC-03 del dosier FIX-1 listaba
    // los terceros de toda la sociedad a este perfil (manager / admin_clerk de un solo centro).
    const centreOnly = await createUser(`contable.lr.centro.${RUN}@example.com`, "Contable LR centro", ["accounting.read", "accounting.reports.read"]);
    if (!centreOnly) {
      t.skip(NO_SESSION);
      return;
    }
    const scoped = await request<ErrorBody>("GET", TP, centreOnly);
    assert.equal(scoped.status, 404, scoped.text.slice(0, 300));
    assert.equal(scoped.body?.details?.code, "ENTITY_SCOPE_REQUIRED", scoped.text.slice(0, 300));
    assert.equal((scoped.body?.details as { requiredPermission?: string } | undefined)?.requiredPermission, "accounting.entity.read");
    assert.doesNotMatch(scoped.text, /"rows"/, "sin ámbito de sociedad no viaja ninguna fila");
    // Corrector CIERRE-1 (FUN-01): mensaje propio del directorio — la ruta no admite `propertyId` (400 abajo), así que el
    // 404 no puede pedir «indica el centro de trabajo asignado (propertyId)» como libros / 347 / diario.
    assert.match(String(scoped.body?.message), /toda la sociedad/, scoped.text.slice(0, 300));
    assert.match(String(scoped.body?.message), /accounting\.entity\.read/);
    assert.doesNotMatch(String(scoped.body?.message), /propertyId|indica el centro/, "nunca un remedio que la ruta no ofrece");
    const withProperty = await request<ErrorBody>("GET", `${TP}?propertyId=${HA}&limit=1`, centreOnly);
    assert.equal(withProperty.status, 400, "la ruta no tiene dimensión de centro: propertyId es una clave no admitida");
    assert.equal(withProperty.body?.details?.code, "VALIDATION_ERROR");
    const scopedFiltered = await request<ErrorBody>("GET", `${TP}?role=supplier&limit=1`, centreOnly);
    assert.equal(scopedFiltered.status, 404, "tampoco con filtros: el guard va antes de la consulta");
    assert.equal(scopedFiltered.body?.details?.code, "ENTITY_SCOPE_REQUIRED");
    // Mismo ámbito de centro (HA / HB / OC) pero con accounting.entity.read (LIMITED_KEYS): 200 con el directorio completo.
    if (!limitedSession) return t.skip(NO_SESSION);
    const entity = await request<ThirdPartyPage>("GET", TP, limitedSession);
    assert.equal(entity.status, 200, entity.text.slice(0, 300));
    assert.equal(entity.body?.total, baseline.total + 5);
    assert.equal(entity.headers["x-total-count"], String(baseline.total + 5));
  });
});
