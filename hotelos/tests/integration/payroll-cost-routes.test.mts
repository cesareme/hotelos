/**
 * Coste de personal importado · Tanda 6c · L3 — rutas HTTP REALES con app.inject
 * (buildApiServer en proceso, sin listen) contra el Postgres compartido y la
 * sesión demo (INTEGRATION_LOGIN_EMAIL / _PASSWORD, por defecto
 * reception@example.com en org_123). SOLO LECTURAS Y PREVISUALIZACIÓN: la
 * preview nunca escribe y ninguna ruta de escritura se ejecuta sobre un lote
 * real; Faranda y org_123 no cambian. Cifras sintéticas.
 *   · POST /payroll/cost-imports/preview con un CSV sintético de etiqueta desconocida → 200 con `unmappedCentres[0].label`;
 *   · cuerpo con clave extra → 400 VALIDATION_ERROR en español (nombra la clave);
 *   · GET /payroll/cost-report?from=2026-01&to=2026-03 → 200 con `months` de 3 y `centres` no vacío;
 *   · GET /payroll/cost-imports → 200 array; GET /payroll/cost-imports/no-existe → 404;
 *   · POST /payroll/cost-imports/no-existe/reverse → 404 opaco (sin eco del id);
 *   · sin token → 401 en preview (RBAC estricto); rango > 24 meses → 400.
 * Sin credenciales válidas los casos se saltan con aviso. Desde el repo:
 *   cd apps/api && node --import tsx --test "../../tests/integration/payroll-cost-routes.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Sin .env → valores por defecto de CI.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
delete process.env.STRUCTURE_ENABLED;

const { buildApiServer } = await import("../../apps/api/src/server.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type Session = { token: string; headers: Headers };
type Profile = { organizationId: string; activePropertyId: string; isPlatformAdmin: boolean; grantedPermissions: string[] };
type ErrorBody = { message?: string; details?: { code?: string; issues?: Array<{ path: string; message: string }> } };
type Response<T> = { status: number; body: T | null; text: string };

const STRICT_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production" };

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

async function login(app: ApiApp, email: string, password: string): Promise<Session | null> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, deviceId: "integration-payroll-cost-routes" } });
  if (res.statusCode !== 200) return null;
  const token = (JSON.parse(res.body) as { token: string }).token;
  return { token, headers: { Authorization: `Bearer ${token}` } };
}

async function request<T>(app: ApiApp, method: "GET" | "POST", url: string, headers: Headers, payload?: unknown): Promise<Response<T>> {
  const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  let body: T | null = null;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, text: res.body };
}

/** CSV sintético (dos filas, un mes) con una etiqueta de centro que no existe en ningún tenant. */
const UNKNOWN_CENTRE = "CASA RURAL SINTETICA ZZ";
const CSV_UNKNOWN = [
  "centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados",
  `${UNKNOWN_CENTRE};2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3`,
  `${UNKNOWN_CENTRE};2026-02;operaciones;6 PISOS;4.000,00;1.200,00;5.200,00;4`
].join("\r\n") + "\r\n";

let app: ApiApp;
let session: Session | null = null;
let profile: Profile | null = null;

before(async () => {
  app = await buildApiServer();
  await app.ready();
  session = await login(app, process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo");
  if (session) profile = (await request<Profile>(app, "GET", "/users/me", session.headers)).body;
});

after(async () => {
  await app.close();
});

const NO_SESSION = "INTEGRATION_LOGIN_EMAIL / _PASSWORD no configurados o login fallido — casos con sesión no ejercitados";

function needs(t: { skip: (reason: string) => void }, permission: string): Session | null {
  if (!session || !profile) {
    t.skip(NO_SESSION);
    return null;
  }
  if (!profile.grantedPermissions.includes(permission) && !profile.isPlatformAdmin) {
    t.skip(`la sesión de integración no tiene ${permission}: caso no ejercitado`);
    return null;
  }
  return session;
}

describe("L3 · POST /payroll/cost-imports/preview (nunca escribe)", () => {
  it("CSV sintético con etiqueta de centro desconocida → 200 con unmappedCentres[0].label y canPost false", async (t) => {
    const s = needs(t, "payroll.manage");
    if (!s) return;
    const res = await request<{ unmappedCentres: Array<{ label: string; rows: number; suggestions: unknown[] }>; canPost: boolean; rowCount: number; errors: unknown[]; contentHash: string; byCentreMonth: unknown[] }>(app, "POST", "/payroll/cost-imports/preview", s.headers, { format: "csv", content: CSV_UNKNOWN });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(res.body);
    assert.deepEqual(res.body.errors, []);
    assert.equal(res.body.rowCount, 2);
    assert.match(res.body.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(res.body.unmappedCentres.length, 1);
    assert.equal(res.body.unmappedCentres[0]?.label, UNKNOWN_CENTRE);
    assert.equal(res.body.unmappedCentres[0]?.rows, 2);
    assert.ok(Array.isArray(res.body.unmappedCentres[0]?.suggestions));
    assert.deepEqual(res.body.byCentreMonth, [], "sin centro mapeado no hay celdas");
    assert.equal(res.body.canPost, false);
  });

  it("cuerpo con clave desconocida → 400 VALIDATION_ERROR en español que nombra la clave", async (t) => {
    const s = needs(t, "payroll.manage");
    if (!s) return;
    const res = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/preview", s.headers, { format: "csv", content: CSV_UNKNOWN, fichero: "x.csv" });
    assert.equal(res.status, 400, res.text.slice(0, 300));
    assert.equal(res.body?.details?.code, "VALIDATION_ERROR");
    // parseOr400 reescribe la issue `unrecognized_keys` con zodErrorMapEs: nombra la clave en español.
    assert.match(res.body?.message ?? "", /^body no válido: clave no admitida: 'fichero'$/);
    assert.ok(res.body?.details?.issues?.some((issue) => issue.message.includes("'fichero'")), res.text.slice(0, 300));
    const badFormat = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/preview", s.headers, { format: "xlsx", content: CSV_UNKNOWN });
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body?.details?.code, "VALIDATION_ERROR");
    assert.match(badFormat.body?.message ?? "", /^body no válido: format: valor no admitido 'xlsx'; valores válidos: csv \| json$/);
  });

  it("sin token → 401 con RBAC estricto (sin fallback demo)", async () => {
    await withEnv(STRICT_ENV, async () => {
      const res = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/preview", {}, { format: "csv", content: CSV_UNKNOWN });
      assert.equal(res.status, 401, res.text.slice(0, 200));
    });
  });
});

describe("L3 · GET /payroll/cost-report", () => {
  it("?from=2026-01&to=2026-03 → 200 con months de 3 y centres no vacío (celdas sin datos a cero, ratios null)", async (t) => {
    const s = needs(t, "payroll.read");
    if (!s) return;
    const res = await request<{ organizationId: string; period: { from: string; to: string }; months: string[]; centres: Array<{ propertyId: string; cells: Array<{ periodCode: string; totalCost: string; laborPctLedger: string | null }> }>; byMonth: unknown[]; totals: { totalCost: string; headcountAverage: string | null }; imports: unknown[] }>(app, "GET", "/payroll/cost-report?from=2026-01&to=2026-03", s.headers);
    if (res.status === 404 && res.text.includes("ENTITY_SCOPE_REQUIRED")) return t.skip("la sesión no tiene ámbito de toda la sociedad (accounting.entity.read): caso no ejercitado");
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(res.body);
    assert.equal(res.body.organizationId, profile!.organizationId);
    assert.deepEqual(res.body.months, ["2026-01", "2026-02", "2026-03"]);
    assert.deepEqual(res.body.period, { from: "2026-01", to: "2026-03" });
    assert.ok(res.body.centres.length > 0, "la organización de la sesión tiene centros");
    assert.equal(res.body.byMonth.length, 3);
    for (const centre of res.body.centres) {
      assert.deepEqual(centre.cells.map((cell) => cell.periodCode), res.body!.months, `una celda por mes en ${centre.propertyId}`);
      for (const cell of centre.cells) assert.match(cell.totalCost, /^-?\d+\.\d{2}$/);
    }
    assert.match(res.body.totals.totalCost, /^-?\d+\.\d{2}$/);
    assert.ok(Array.isArray(res.body.imports));
  });

  it("rango > 24 meses → 400 VALIDATION_ERROR; to < from → 400; mes inválido → 400", async (t) => {
    const s = needs(t, "payroll.read");
    if (!s) return;
    const tooLong = await request<ErrorBody>(app, "GET", "/payroll/cost-report?from=2024-01&to=2026-01", s.headers);
    assert.equal(tooLong.status, 400, tooLong.text.slice(0, 300));
    assert.equal(tooLong.body?.details?.code, "VALIDATION_ERROR");
    assert.match(tooLong.body?.message ?? "", /El rango no puede superar 24 meses \(25 solicitados\)/);
    const inverted = await request<ErrorBody>(app, "GET", "/payroll/cost-report?from=2026-03&to=2026-01", s.headers);
    assert.equal(inverted.status, 400);
    assert.match(inverted.body?.message ?? "", /to debe ser igual o posterior a from/);
    const badMonth = await request<ErrorBody>(app, "GET", "/payroll/cost-report?from=2026-13&to=2026-12", s.headers);
    assert.equal(badMonth.status, 400);
    assert.match(badMonth.body?.message ?? "", /from debe ser un mes YYYY-MM/);
    const extra = await request<ErrorBody>(app, "GET", "/payroll/cost-report?from=2026-01&to=2026-03&format=csv", s.headers);
    assert.equal(extra.status, 400);
    assert.match(extra.body?.message ?? "", /^query no válido: clave no admitida: 'format'$/);
  });
});

describe("L3 · lotes: listado y 404 opacos", () => {
  it("GET /payroll/cost-imports → 200 array (solo lotes de la organización con todos sus centros en ámbito)", async (t) => {
    const s = needs(t, "payroll.read");
    if (!s) return;
    const res = await request<Array<{ id: string; organizationId: string; status: string }>>(app, "GET", "/payroll/cost-imports", s.headers);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(Array.isArray(res.body));
    for (const row of res.body ?? []) {
      assert.equal(row.organizationId, profile!.organizationId);
      assert.ok(["draft", "posted", "reversed"].includes(row.status));
    }
    const badLimit = await request<ErrorBody>(app, "GET", "/payroll/cost-imports?limit=0", s.headers);
    assert.equal(badLimit.status, 400);
    assert.match(badLimit.body?.message ?? "", /limit debe ser un entero entre 1 y 200/);
  });

  it("GET /payroll/cost-imports/no-existe → 404 opaco", async (t) => {
    const s = needs(t, "payroll.read");
    if (!s) return;
    const res = await request<ErrorBody>(app, "GET", "/payroll/cost-imports/no-existe", s.headers);
    assert.equal(res.status, 404, res.text.slice(0, 300));
    assert.equal(res.body?.message, "Importación de coste de personal no encontrada.");
  });

  it("POST /payroll/cost-imports/no-existe/reverse → 404 opaco (mismo mensaje, sin eco del id, nada escrito)", async (t) => {
    const s = needs(t, "payroll.manage");
    if (!s) return;
    const res = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/no-existe/reverse", s.headers, { reason: "prueba de integración (no existe)" });
    assert.equal(res.status, 404, res.text.slice(0, 300));
    assert.equal(res.body?.message, "Importación de coste de personal no encontrada.");
    assert.ok(!res.text.includes("no-existe"), "el 404 nunca repite el id");
    const post = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/no-existe/post", s.headers, {});
    assert.equal(post.status, 404);
    assert.equal(post.body?.message, res.body?.message, "detalle, post y reverse comparten el mensaje neutro");
  });
});
