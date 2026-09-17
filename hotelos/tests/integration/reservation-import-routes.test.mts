/**
 * Importación masiva de reservas · Tanda 7 · L3 — rutas HTTP REALES con app.inject
 * (buildApiServer en proceso, sin listen) contra el Postgres compartido y la
 * sesión demo (INTEGRATION_LOGIN_EMAIL / _PASSWORD, por defecto
 * reception@example.com; la propiedad es la activa de esa sesión). SOLO LECTURAS
 * Y PREVISUALIZACIÓN: la preview nunca escribe y ninguna ruta de escritura se
 * ejecuta sobre un lote real (el undo solo se llama sobre un id inexistente, que
 * responde 404 antes de tocar el servicio). Huéspedes FICTICIOS @example.com.
 *   · POST …/imports/preview sin content → 400 VALIDATION_ERROR (XOR en español);
 *     clave desconocida → 400 que la nombra; content + contentBase64 → 400; format pdf → 400;
 *   · GET …/imports/template → CSV con BOM, «;», 33 cabeceras y content-disposition;
 *     ?format=xlsx → firma PK y legible con xlsx-lite (hoja «Reservas», 33 cabeceras);
 *   · GET …/imports → 200 array de la propiedad; limit / status inválidos → 400;
 *   · GET …/imports/no-existe → 404 opaco; POST …/imports/no-existe/undo → 404 opaco;
 *   · preview de un CSV ficticio de 2 filas en contentBase64 → 200 con header, mapping,
 *     summary, contentHash, catálogo y sin datos personales en los mensajes; el mismo
 *     CSV como `content` texto → mismo contentHash; sampleSize 1 → normalized solo en la 1.ª;
 *   · cuerpo de ~2 MB → 200 (bodyLimit de 8 MiB por ruta);
 *   · sin token con RBAC estricto → 401 en import y undo (riesgo high) y en preview;
 *   · sesión de F&B (si existe) → 403 en la plantilla.
 * Sin credenciales válidas los casos se saltan con aviso. Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/reservation-import-routes.test.mts"
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

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { readXlsxTable } = await import("../../apps/api/src/lib/xlsx-lite.js");
const { RESERVATION_IMPORT_FIELDS, RESERVATION_IMPORT_ROW_STATUSES, RESERVATION_IMPORT_STATUSES, RESERVATION_IMPORT_TEMPLATE_FILE_NAMES } = await import("../../packages/shared/src/reservation-import-types.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type Session = { token: string; headers: Headers };
type Profile = { organizationId: string; activePropertyId: string; isPlatformAdmin: boolean; grantedPermissions: string[] };
type ErrorBody = { message?: string; details?: { code?: string; issues?: Array<{ path: string; message: string }> } };
type Response<T> = { status: number; body: T | null; text: string };
type PreviewRow = { rowNumber: number; line: number; status: string; issues: Array<{ code: string; message: string; column?: string }>; resolved?: Record<string, unknown>; normalized?: { guest: { firstName: string; surname1: string; email?: string } } };
type Preview = {
  propertyId: string;
  format: string;
  fileName: string | null;
  contentHash: string;
  encoding: string;
  delimiter?: string;
  header: string[];
  mapping: Record<string, string | null>;
  mappingSource: Record<string, string>;
  unmappedColumns: string[];
  missingRequired: string[];
  splitName: boolean;
  catalog: { roomTypes: Array<{ code: string; totalRooms: number }>; ratePlans: unknown[]; defaultRatePlanCode: string | null; currency: string };
  businessDate: string;
  rowCount: number;
  summary: { valid: number; warning: number; error: number; skipped: number; historical: number; toCreate: number };
  rows: PreviewRow[];
  sampleSize: number;
  availability: { byRoomType: unknown[]; overbookingRows: number[] };
  duplicates: { byReferenceRows: number[]; inFileRows: number[]; possibleRows: number[]; ofImport: unknown };
  totals: { fromFile: string; quoted: string; currency: string };
  options: Record<string, boolean>;
  canImport: boolean;
  blockers: Array<{ code: string; message: string }>;
  warnings: string[];
};

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
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, deviceId: "integration-reservation-import-routes" } });
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

async function download(app: ApiApp, url: string, headers: Headers): Promise<{ status: number; headers: Record<string, unknown>; bytes: Buffer; text: string }> {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, headers: res.headers as Record<string, unknown>, bytes: Buffer.from(res.rawPayload), text: res.body };
}

/** "YYYY-MM-DD" de hoy + n días (UTC): las filas ficticias siempre llegan en el futuro. */
function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** CSV ficticio de 2 filas (huéspedes inventados @example.com) con cabeceras canónicas y «;». */
const HEADER = "referencia_externa;llegada;salida;tipo_habitacion;tarifa;adultos;ninos;regimen;canal;estado;nombre;apellidos;email;telefono;nacionalidad;documento_tipo;documento_numero;importe_total;moneda";
const CSV_2 = [
  HEADER,
  `IMP-T7-L3-001;${isoPlusDays(40)};${isoPlusDays(42)};DBL;BAR;2;0;BB;directo;confirmada;Lucía;Ferreiro Castro;lucia.ferreiro@example.com;+34 600 111 001;ES;DNI;11111111H;250,00;EUR`,
  `IMP-T7-L3-002;${isoPlusDays(41)};${isoPlusDays(43)};DBL;BAR;1;0;RO;booking;confirmada;Marek;Nowak;marek.nowak@example.com;+48 600 111 002;PL;PAS;AB1234567;180,00;EUR`
].join("\r\n") + "\r\n";
const CSV_2_BASE64 = Buffer.from(CSV_2, "utf8").toString("base64");
const PII = ["lucia.ferreiro@example.com", "marek.nowak@example.com", "Ferreiro", "Nowak", "11111111H", "AB1234567", "600 111 001"];

/** CSV de ~2,3 MB: 1.150 filas ficticias con una nota de 1.900 caracteres (≤ 2.000 por celda) → ejercita el bodyLimit de 8 MiB. */
function buildLargeCsv(rows: number): string {
  const note = "x".repeat(1900);
  const lines = ["referencia_externa;llegada;salida;tipo_habitacion;adultos;nombre;apellidos;notas"];
  for (let i = 1; i <= rows; i++) {
    const offset = 60 + (i % 200);
    lines.push(`IMP-T7-L3-BIG-${String(i).padStart(4, "0")};${isoPlusDays(offset)};${isoPlusDays(offset + 2)};DBL;1;Prueba;Ficticia ${i};${note}`);
  }
  return lines.join("\n") + "\n";
}

let app: ApiApp;
let session: Session | null = null;
let profile: Profile | null = null;
let fnbSession: Session | null = null;
let BASE = "";

before(async () => {
  app = await buildApiServer();
  await app.ready();
  session = await login(app, process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo");
  if (session) {
    profile = (await request<Profile>(app, "GET", "/users/me", session.headers)).body;
    if (profile) BASE = `/properties/${encodeURIComponent(profile.activePropertyId)}/reservations/imports`;
  }
  fnbSession = await login(app, process.env.INTEGRATION_FNB_EMAIL ?? "fnb@example.com", process.env.INTEGRATION_FNB_PASSWORD ?? "hotelos-demo");
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

function assertNoPii(text: string, where: string): void {
  for (const value of PII) assert.ok(!text.includes(value), `${where} cita un dato personal (${value})`);
}

describe("L3 · POST …/reservations/imports/preview · validación del cuerpo (400 en español, nunca escribe)", () => {
  it("sin content ni contentBase64 → 400 VALIDATION_ERROR con el mensaje del XOR", async (t) => {
    const s = needs(t, "pms.reservation.create");
    if (!s) return;
    const res = await request<ErrorBody>(app, "POST", `${BASE}/preview`, s.headers, { fileName: "reservas.csv" });
    assert.equal(res.status, 400, res.text.slice(0, 300));
    assert.equal(res.body?.details?.code, "VALIDATION_ERROR");
    assert.equal(res.body?.message, "body no válido: content: Indica content (texto) o contentBase64 (fichero), no ambos.");
    const empty = await request<ErrorBody>(app, "POST", `${BASE}/preview`, s.headers, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body?.details?.code, "VALIDATION_ERROR");
  });

  it("clave desconocida → 400 VALIDATION_ERROR que nombra la clave; content + contentBase64 → 400 XOR; format pdf → 400", async (t) => {
    const s = needs(t, "pms.reservation.create");
    if (!s) return;
    const extra = await request<ErrorBody>(app, "POST", `${BASE}/preview`, s.headers, { content: CSV_2, fichero: "x.csv" });
    assert.equal(extra.status, 400, extra.text.slice(0, 300));
    assert.equal(extra.body?.details?.code, "VALIDATION_ERROR");
    assert.match(extra.body?.message ?? "", /^body no válido: clave no admitida: 'fichero'$/);
    assert.ok(extra.body?.details?.issues?.some((issue) => issue.message.includes("'fichero'")), extra.text.slice(0, 300));
    const both = await request<ErrorBody>(app, "POST", `${BASE}/preview`, s.headers, { content: CSV_2, contentBase64: CSV_2_BASE64 });
    assert.equal(both.status, 400, both.text.slice(0, 300));
    assert.equal(both.body?.details?.code, "VALIDATION_ERROR");
    assert.match(both.body?.message ?? "", /Indica content \(texto\) o contentBase64 \(fichero\), no ambos\./);
    const badFormat = await request<ErrorBody>(app, "POST", `${BASE}/preview`, s.headers, { contentBase64: CSV_2_BASE64, format: "pdf" });
    assert.equal(badFormat.status, 400);
    assert.match(badFormat.body?.message ?? "", /^body no válido: format: valor no admitido 'pdf'; valores válidos: csv \| xlsx$/);
    const badSample = await request<ErrorBody>(app, "POST", `${BASE}/preview`, s.headers, { contentBase64: CSV_2_BASE64, sampleSize: 0 });
    assert.equal(badSample.status, 400);
    assert.match(badSample.body?.message ?? "", /sampleSize/);
  });
});

describe("L3 · GET …/reservations/imports/template", () => {
  it("csv por defecto: BOM UTF-8, «;», CRLF, 33 cabeceras canónicas, content-disposition attachment y cache-control no-store", async (t) => {
    const s = needs(t, "pms.reservation.read");
    if (!s) return;
    const res = await download(app, `${BASE}/template`, s.headers);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.match(String(res.headers["content-type"]), /^text\/csv/);
    assert.equal(res.headers["content-disposition"], `attachment; filename="${RESERVATION_IMPORT_TEMPLATE_FILE_NAMES.csv}"`);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual([...res.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM UTF-8");
    const text = res.bytes.subarray(3).toString("utf8");
    const lines = text.split("\r\n").filter((line) => line.length > 0);
    assert.equal(lines[0], RESERVATION_IMPORT_FIELDS.join(";"));
    assert.equal(lines[0]!.split(";").length, 33);
    assert.equal(lines.length, 3, "cabecera + 2 filas de ejemplo");
    assert.match(text, /@example\.com/, "huéspedes ficticios");
  });

  it("?format=xlsx: firma PK, content-type de hoja de cálculo y legible con xlsx-lite (hoja «Reservas», 33 cabeceras, hoja «Instrucciones»)", async (t) => {
    const s = needs(t, "pms.reservation.read");
    if (!s) return;
    const res = await download(app, `${BASE}/template?format=xlsx`, s.headers);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(res.headers["content-disposition"], `attachment; filename="${RESERVATION_IMPORT_TEMPLATE_FILE_NAMES.xlsx}"`);
    assert.equal(res.bytes.subarray(0, 2).toString("latin1"), "PK");
    const table = readXlsxTable(res.bytes);
    assert.equal(table.sheetName, "Reservas");
    assert.equal(table.rows.length, 3);
    assert.deepEqual(table.rows[0]!.cells.map((cell) => cell.raw), [...RESERVATION_IMPORT_FIELDS]);
    const help = readXlsxTable(res.bytes, { sheetName: "Instrucciones" });
    assert.equal(help.sheetName, "Instrucciones");
    assert.ok(help.rows.length >= 34);
  });

  it("?format=pdf → 400 VALIDATION_ERROR; clave de consulta desconocida → 400", async (t) => {
    const s = needs(t, "pms.reservation.read");
    if (!s) return;
    const pdf = await request<ErrorBody>(app, "GET", `${BASE}/template?format=pdf`, s.headers);
    assert.equal(pdf.status, 400, pdf.text.slice(0, 300));
    assert.equal(pdf.body?.details?.code, "VALIDATION_ERROR");
    assert.match(pdf.body?.message ?? "", /^query no válido: format: valor no admitido 'pdf'; valores válidos: csv \| xlsx$/);
    const extra = await request<ErrorBody>(app, "GET", `${BASE}/template?formato=csv`, s.headers);
    assert.equal(extra.status, 400);
    assert.match(extra.body?.message ?? "", /^query no válido: clave no admitida: 'formato'$/);
  });
});

describe("L3 · lotes: listado, detalle y 404 opacos", () => {
  it("GET …/imports → 200 array de la propiedad (createdAt desc); limit 0 / 500 y status desconocido → 400", async (t) => {
    const s = needs(t, "pms.reservation.read");
    if (!s) return;
    const res = await request<Array<{ id: string; propertyId: string; organizationId: string; status: string; createdAt: string }>>(app, "GET", BASE, s.headers);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(Array.isArray(res.body));
    for (const row of res.body ?? []) {
      assert.equal(row.propertyId, profile!.activePropertyId);
      assert.equal(row.organizationId, profile!.organizationId);
      assert.ok((RESERVATION_IMPORT_STATUSES as readonly string[]).includes(row.status), row.status);
    }
    for (let i = 1; i < (res.body ?? []).length; i++) assert.ok(res.body![i - 1]!.createdAt >= res.body![i]!.createdAt, "orden createdAt desc");
    const zero = await request<ErrorBody>(app, "GET", `${BASE}?limit=0`, s.headers);
    assert.equal(zero.status, 400);
    assert.match(zero.body?.message ?? "", /limit debe ser un entero entre 1 y 200/);
    const big = await request<ErrorBody>(app, "GET", `${BASE}?limit=500`, s.headers);
    assert.equal(big.status, 400);
    const status = await request<ErrorBody>(app, "GET", `${BASE}?status=done`, s.headers);
    assert.equal(status.status, 400);
    assert.match(status.body?.message ?? "", /status: valor no admitido 'done'; valores válidos: processing \| imported \| partial \| failed \| undone/);
    const filtered = await request<unknown[]>(app, "GET", `${BASE}?status=undone&limit=5`, s.headers);
    assert.equal(filtered.status, 200);
    assert.ok(Array.isArray(filtered.body) && filtered.body.length <= 5);
  });

  it("GET …/imports/no-existe → 404 opaco «Importación de reservas no encontrada.» sin eco del id", async (t) => {
    const s = needs(t, "pms.reservation.read");
    if (!s) return;
    const res = await request<ErrorBody>(app, "GET", `${BASE}/no-existe`, s.headers);
    assert.equal(res.status, 404, res.text.slice(0, 300));
    assert.equal(res.body?.message, "Importación de reservas no encontrada.");
    assert.ok(!res.text.includes("no-existe"), "el 404 nunca repite el id");
  });

  it("POST …/imports/no-existe/undo → 404 opaco (mismo mensaje; nada escrito)", async (t) => {
    const s = needs(t, "pms.reservation.modify");
    if (!s) return;
    const res = await request<ErrorBody>(app, "POST", `${BASE}/no-existe/undo`, s.headers, { reason: "prueba de integración (no existe)" });
    assert.equal(res.status, 404, res.text.slice(0, 300));
    assert.equal(res.body?.message, "Importación de reservas no encontrada.");
    assert.ok(!res.text.includes("no-existe"));
  });
});

describe("L3 · POST …/reservations/imports/preview · CSV ficticio (nunca escribe)", () => {
  it("2 filas en contentBase64 → 200 con header, mapping, summary, contentHash, catálogo y mensajes sin datos personales", async (t) => {
    const s = needs(t, "pms.reservation.create");
    if (!s) return;
    const res = await request<Preview>(app, "POST", `${BASE}/preview`, s.headers, { fileName: "reservas-ficticias.csv", contentBase64: CSV_2_BASE64 });
    assert.equal(res.status, 200, res.text.slice(0, 500));
    const p = res.body!;
    assert.equal(p.propertyId, profile!.activePropertyId);
    assert.equal(p.format, "csv");
    assert.equal(p.fileName, "reservas-ficticias.csv");
    assert.equal(p.encoding, "utf-8");
    assert.equal(p.delimiter, ";");
    assert.match(p.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.header, HEADER.split(";"));
    for (const column of p.header) {
      assert.equal(p.mapping[column], column, `columna canónica ${column} mapeada a sí misma`);
      assert.ok(["explicit", "synonym", "fuzzy", "none"].includes(p.mappingSource[column] ?? ""), `mappingSource de ${column}`);
    }
    assert.deepEqual(p.unmappedColumns, []);
    assert.deepEqual(p.missingRequired, []);
    assert.equal(p.splitName, false);
    assert.equal(p.rowCount, 2);
    assert.equal(p.rows.length, 2);
    assert.deepEqual(p.rows.map((row) => row.rowNumber), [1, 2]);
    assert.deepEqual(p.rows.map((row) => row.line), [2, 3], "línea física del fichero (cabecera = 1)");
    for (const row of p.rows) {
      assert.ok((RESERVATION_IMPORT_ROW_STATUSES as readonly string[]).includes(row.status), row.status);
      assert.ok(Array.isArray(row.issues));
      for (const issue of row.issues) {
        assert.match(issue.code, /^RESERVATION_IMPORT_ROW_/);
        assertNoPii(issue.message, `fila ${row.rowNumber} · ${issue.code}`);
      }
    }
    const sum = p.summary.valid + p.summary.warning + p.summary.error + p.summary.skipped;
    assert.equal(sum, 2, JSON.stringify(p.summary));
    assert.ok(p.summary.toCreate >= 0 && p.summary.toCreate <= 2);
    assert.equal(p.sampleSize, 2, "sampleSize devuelto = filas con normalized (min(200 pedidas, 2 filas))");
    assert.ok(p.rows.every((row) => row.normalized !== undefined), "las 2 filas caben en la muestra");
    assert.equal(p.rows[0]!.normalized?.guest.email, "lucia.ferreiro@example.com");
    assert.ok(Array.isArray(p.catalog.roomTypes));
    assert.ok(Array.isArray(p.catalog.ratePlans));
    assert.match(p.catalog.currency, /^[A-Z]{3}$/);
    assert.match(p.businessDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(p.availability.byRoomType));
    assert.deepEqual(p.duplicates.inFileRows, []);
    assert.equal(p.duplicates.ofImport, null, "el CSV ficticio nunca se ha importado");
    assert.match(p.totals.fromFile, /^\d+\.\d{2}$/);
    assert.deepEqual(p.options, { omitirInvalidas: false, permitirOverbooking: false, historico: false, force: false });
    assert.equal(typeof p.canImport, "boolean");
    assert.ok(Array.isArray(p.blockers) && Array.isArray(p.warnings));
    assertNoPii(JSON.stringify(p.blockers), "blockers");
    assertNoPii(JSON.stringify(p.warnings), "warnings");
    assertNoPii(JSON.stringify(p.rows.map((row) => row.resolved ?? null)), "resolved");
  });

  it("el mismo CSV como `content` (texto) → mismo contentHash; sampleSize 1 → normalized solo en la primera fila; mapping explícito null ignora la columna", async (t) => {
    const s = needs(t, "pms.reservation.create");
    if (!s) return;
    const fromBase64 = await request<Preview>(app, "POST", `${BASE}/preview`, s.headers, { contentBase64: CSV_2_BASE64 });
    const fromText = await request<Preview>(app, "POST", `${BASE}/preview`, s.headers, { content: CSV_2, sampleSize: 1 });
    assert.equal(fromBase64.status, 200, fromBase64.text.slice(0, 300));
    assert.equal(fromText.status, 200, fromText.text.slice(0, 300));
    assert.equal(fromText.body!.contentHash, fromBase64.body!.contentHash);
    assert.equal(fromText.body!.sampleSize, 1);
    assert.ok(fromText.body!.rows[0]!.normalized !== undefined);
    assert.equal(fromText.body!.rows[1]!.normalized, undefined, "fuera de la muestra no viajan datos del huésped");
    assert.ok(fromText.body!.rows[1]!.resolved !== undefined || fromText.body!.rows[1]!.status === "error", "resolved sin PII sí está");
    const ignored = await request<Preview>(app, "POST", `${BASE}/preview`, s.headers, { content: CSV_2, mapping: { email: null } });
    assert.equal(ignored.status, 200, ignored.text.slice(0, 300));
    assert.equal(ignored.body!.mapping.email, null);
    assert.equal(ignored.body!.mappingSource.email, "explicit");
    assert.equal(ignored.body!.rows[0]!.normalized?.guest.email, undefined, "columna ignorada: sin e-mail");
  });

  it("cuerpo de ~2 MB (1.150 filas ficticias) → 200 gracias al bodyLimit de 8 MiB de la ruta", async (t) => {
    const s = needs(t, "pms.reservation.create");
    if (!s) return;
    const content = buildLargeCsv(1150);
    const payload = { fileName: "reservas-grandes.csv", content };
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    assert.ok(bytes > 2 * 1024 * 1024, `cuerpo de ${bytes} bytes (esperado > 2 MiB, por encima del bodyLimit por defecto de Fastify)`);
    const res = await request<Preview>(app, "POST", `${BASE}/preview`, s.headers, payload);
    assert.equal(res.status, 200, res.text.slice(0, 500));
    assert.equal(res.body!.rowCount, 1150);
    assert.equal(res.body!.rows.length, 1150);
    assert.equal(res.body!.rows.filter((row) => row.normalized !== undefined).length, Math.min(200, res.body!.summary.valid + res.body!.summary.warning + res.body!.summary.error + res.body!.summary.skipped), "normalized solo en la muestra de 200");
  });
});

describe("L3 · RBAC: sin token con RBAC estricto y sesión sin permiso de reservas", () => {
  it("sin token → 401 en import y undo (riesgo high) y en preview", async () => {
    await withEnv(STRICT_ENV, async () => {
      const property = profile?.activePropertyId ?? "prop_123";
      const base = `/properties/${encodeURIComponent(property)}/reservations/imports`;
      const commit = await request<ErrorBody>(app, "POST", base, {}, { contentBase64: CSV_2_BASE64, commit: true });
      assert.equal(commit.status, 401, commit.text.slice(0, 200));
      const undo = await request<ErrorBody>(app, "POST", `${base}/no-existe/undo`, {}, {});
      assert.equal(undo.status, 401, undo.text.slice(0, 200));
      const preview = await request<ErrorBody>(app, "POST", `${base}/preview`, {}, { contentBase64: CSV_2_BASE64 });
      assert.equal(preview.status, 401, preview.text.slice(0, 200));
    });
  });

  it("sesión de F&B (sin pms.reservation.read) → 403 en la plantilla", async (t) => {
    if (!fnbSession || !profile) return t.skip("no existe una sesión de F&B (INTEGRATION_FNB_EMAIL / _PASSWORD): caso no ejercitado");
    const me = (await request<Profile>(app, "GET", "/users/me", fnbSession.headers)).body;
    if (!me || me.isPlatformAdmin || me.grantedPermissions.includes("pms.reservation.read")) return t.skip("la sesión de F&B tiene pms.reservation.read: caso no ejercitado");
    const res = await withEnv(STRICT_ENV, () => request<ErrorBody>(app, "GET", `/properties/${encodeURIComponent(me.activePropertyId)}/reservations/imports/template`, fnbSession!.headers));
    assert.equal(res.status, 403, res.text.slice(0, 200));
  });
});
