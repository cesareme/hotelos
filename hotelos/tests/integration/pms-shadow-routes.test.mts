/**
 * OPERA Cloud · modo sombra · Tanda 7b · L3 — rutas HTTP REALES con app.inject
 * (buildApiServer en proceso, sin listen) contra el Postgres compartido. Organización
 * AISLADA `org_pl_<run>` (sociedad + hotel RA con perfil RIAS + hotel LT sin perfil),
 * una segunda organización `org_pl2_<run>` con su propia DeveloperApp, tres apps de
 * desarrollador (con scope, sin scope, de la otra organización) y un usuario REAL con
 * rol (integrations.*, accounting.*, pms.*) que inicia sesión por /auth/login. Todo
 * creado aquí y borrado en `after`; ficheros SINTÉTICOS con las columnas literales de
 * Oracle y huéspedes ficticios.
 *   · ingest sin cabecera / clave mal formada / app sin scope → 401 PMS_SHADOW_INGEST_UNAUTHORIZED;
 *     app de otra organización sobre RA → 404 opaco; cuerpo con clave desconocida → 400;
 *   · clave válida + Responsys sintético → 202 { runId, status done }, PmsShadowRun con
 *     reservationImportId y contadores, 2 PmsShadowLink; el mismo fichero y business date → 409
 *     PMS_SHADOW_RUN_DUPLICATE; XML de ingresos → 202 y JournalEntry pms_shadow_revenue;
 *     fichero irreconocible → 202 status failed + alerta OPERA_FEED_UNRECOGNIZED;
 *   · GET overview / profile / runs / runs/:id / alerts / reconciliation con sesión → 200; run de
 *     otra propiedad → 404 opaco; POST alerts/:id/resolve → resolvedAt + auditoría; segundo
 *     resolve → 409; PUT profile → 200; cuerpo con clave desconocida → 400;
 *   · RBAC estricto sin token → 401 en las rutas high / critical.
 * Faranda y org_123 nunca se escriben. Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/pms-shadow-routes.test.mts"
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { localDay } from "./helpers/local-day.mts";

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
const { OPERA_CLOUD_RESPONSYS_HEADER, PMS_SHADOW_INGEST_HEADER, PMS_SHADOW_INGEST_SCOPE, PMS_SHADOW_RECON_TOLERANCES, pmsShadowIngestScopeFor } = await import("@hotelos/shared");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushAccountingProjection } = await import("../../apps/api/src/modules/accounting/projection.js");
const { flushExtraProjections } = await import("../../apps/api/src/modules/accounting/posting-rules/index.js");
const { flushNotificationHooks } = await import("../../apps/api/src/modules/notifications/event-hooks.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type ErrorBody = { message?: string; details?: { code?: string; runId?: string; issues?: Array<{ path: string; message: string }> } };
type Response<T> = { status: number; body: T | null; text: string };
type IngestBody = { runId: string; status: string; counts: Record<string, number>; alerts: Array<{ code: string; message: string }> };

const RUN = Date.now().toString(36);
const ORG = `org_pl_${RUN}`;
const ORG2 = `org_pl2_${RUN}`;
const ENTITY = `le_pl_${RUN}`;
const RA = `prop_pl_ra_${RUN}`;
const LT = `prop_pl_lt_${RUN}`;
const P2 = `prop_pl2_${RUN}`;
const USER_EMAIL = `manager.pl.${RUN}@example.com`;
const USER_PASSWORD = `Pl-${RUN}-Secreta-123`;
const HOTEL_CODE = "RIAS";
const TIMEZONE = "Europe/Madrid";
const STRICT_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production" };
const ROLE_KEYS = ["integrations.read", "integrations.connect", "accounting.read", "accounting.reports.read", "accounting.journal.post", "pms.reservation.read", "pms.reservation.create", "pms.reservation.modify", "pms.checkin.execute", "pms.checkout.execute"] as const;

/** CIF sintético «A» + 7 dígitos + control válido, distinto por ejecución. */
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

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const APP_OK = { clientId: `cli_pl_${RUN}_ok_key`, secret: `sec_pl_${RUN}_okokokokokok` };
const APP_NO_SCOPE = { clientId: `cli_pl_${RUN}_no_scope`, secret: `sec_pl_${RUN}_noscopenoscope` };
const APP_OTHER = { clientId: `cli_pl_${RUN}_other_org`, secret: `sec_pl_${RUN}_otherotherother` };
/** SEC-04: app de la organización ligada SOLO a Los Tilos (`pms.shadow.ingest:<LT>`). */
const APP_BOUND_LT = { clientId: `cli_pl_${RUN}_bound_lt`, secret: `sec_pl_${RUN}_boundboundbound` };
const keyOf = (app: { clientId: string; secret: string }): string => `${app.clientId}.${app.secret}`;

/** Hoy + n días en la ZONA DEL HOTEL: el servidor ancla el corte al día local de la propiedad (`localDateTime`, pms-shadow.service), no a UTC (flake 00:00-02:00 CEST · CIERRE-1 C4a). */
function day(offset: number): string {
  return localDay(offset, TIMEZONE);
}
const ymd = (offset: number): string => day(offset).replace(/-/g, "");
const TODAY = day(0);

type RespColumn = (typeof OPERA_CLOUD_RESPONSYS_HEADER)[number];
type RespRow = Partial<Record<RespColumn, string>>;
function responsys(rows: readonly RespRow[]): string {
  return [OPERA_CLOUD_RESPONSYS_HEADER.join(","), ...rows.map((row) => OPERA_CLOUD_RESPONSYS_HEADER.map((column) => row[column] ?? "").join(","))].join("\r\n") + "\r\n";
}
const ROW_A: RespRow = { RESERVATION_ID: `PL-${RUN}-1001`, GUEST_LAST_NAME: "Ferreiro Castro", GUEST_FIRST_NAME: "Lucía", BOOKING_SOURCE: "BDC", PROPERTY_NAME: "Hotel Rías Test", ARRIVAL_DATE: ymd(5), DEPARTURE_DATE: ymd(7), NUM_NIGHTS: "2", NUM_ADULTS: "2", NUM_CHILDREN: "0", NUM_ROOMS: "1", ROOM_TYPE: "DLX", RATE: "120.00", PAYMENT_TYPE: "VI", NAME_ON_CARD: "LUCIA FERREIRO", RATE_CODE: "BAR", RESERVATION_STATUS: "Reserved" };
const ROW_B: RespRow = { RESERVATION_ID: `PL-${RUN}-1002`, GUEST_LAST_NAME: "Nowak", GUEST_FIRST_NAME: "Marek", BOOKING_SOURCE: "WEB", ARRIVAL_DATE: ymd(6), DEPARTURE_DATE: ymd(8), NUM_NIGHTS: "2", NUM_ADULTS: "1", NUM_CHILDREN: "0", NUM_ROOMS: "1", ROOM_TYPE: "DBL", RATE: "100.00", PAYMENT_TYPE: "CA", RATE_CODE: "BAR", RESERVATION_STATUS: "Reserved" };
const CSV_ARRIVALS = responsys([ROW_A, ROW_B]);
const CSV_ARRIVALS_B64 = Buffer.from(CSV_ARRIVALS, "utf8").toString("base64");

type Code = { code: string; description: string; type: string; amount: string };
const CODES: Code[] = [
  { code: "1000", description: "Lodging", type: "REVENUE", amount: "1234.50" },
  { code: "2000", description: "F&B Restaurant", type: "REVENUE", amount: "310.00" },
  { code: "8100", description: "IVA 10%", type: "REVENUE", amount: "154.45" },
  { code: "9000", description: "Cash", type: "PAYMENT", amount: "-900.00" },
  { code: "9500", description: "Paid Out", type: "PAID OUT", amount: "40.00" }
];
const REVENUE_DAY = "2026-09-15";
function xmlFor(date: string, codes: readonly Code[]): string {
  const totals = codes
    .map((c) => `  <transaction_total transaction_type="${c.type}">\n    <transaction_code>${c.code}</transaction_code>\n    <description>${c.description.replace(/&/g, "&amp;")}</description>\n    <total_amount>${c.amount}</total_amount>\n    <total_guest_ledger>${c.amount}</total_guest_ledger>\n    <total_package_ledger>0.00</total_package_ledger>\n    <total_ar_ledger>0.00</total_ar_ledger>\n    <total_deposit_ledger>0.00</total_deposit_ledger>\n  </transaction_total>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<revenue hotel_code="${HOTEL_CODE}" date="${date}">\n${totals}\n</revenue>\n`;
}
const XML_REVENUE_B64 = Buffer.from(xmlFor(REVENUE_DAY, CODES), "utf8").toString("base64");
const MAPPING = [
  { code: "1000", description: "Lodging", kind: "revenue", accountCode: "705.1", usaliDepartment: "rooms" },
  { code: "2000", kind: "revenue", accountCode: "705.2", usaliDepartment: "fnb" },
  { code: "8100", kind: "tax", accountCode: "477.10", taxRateCode: "10" },
  { code: "9000", kind: "payment", accountCode: "570" },
  { code: "9500", kind: "ignore" }
];
const PII = ["Ferreiro", "Lucía", "Nowak", "Marek", "LUCIA FERREIRO"];

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
let roleId: string | null = null;
let userId: string | null = null;
const BASE = `/properties/${RA}/pms-shadow`;
const INGEST = "/integrations/pms-shadow/ingest";

async function request<T>(method: "GET" | "POST" | "PUT", url: string, headers: Headers, payload?: unknown): Promise<Response<T>> {
  const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  let body: T | null = null;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, text: res.body };
}

function ingest<T = IngestBody>(apiKey: string | null, payload: unknown): Promise<Response<T>> {
  return request<T>("POST", INGEST, apiKey === null ? {} : { [PMS_SHADOW_INGEST_HEADER]: apiKey }, payload);
}

function assertNoPii(text: string, where: string): void {
  for (const token of PII) assert.ok(!text.includes(token), `${where} cita un dato personal (${token})`);
}

async function cleanup(): Promise<void> {
  await prisma.pmsShadowAlert.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await prisma.pmsShadowRun.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await prisma.pmsShadowLink.deleteMany({ where: { organizationId: ORG } });
  await prisma.reservationImportRow.deleteMany({ where: { organizationId: ORG } });
  await prisma.reservationImport.deleteMany({ where: { organizationId: ORG } });
  const reservations = await prisma.reservation.findMany({ where: { propertyId: { in: [RA, LT] } }, select: { id: true } });
  const ids = reservations.map((row) => row.id);
  if (ids.length) {
    await prisma.stay.deleteMany({ where: { reservationId: { in: ids } } });
    await prisma.folio.deleteMany({ where: { reservationId: { in: ids } } });
    await prisma.reservationGuest.deleteMany({ where: { reservationId: { in: ids } } });
  }
  await prisma.reservation.deleteMany({ where: { propertyId: { in: [RA, LT] } } });
  await prisma.guest.deleteMany({ where: { organizationId: ORG } });
  await prisma.pmsShadowRevenueImport.deleteMany({ where: { organizationId: ORG } });
  await prisma.costCenter.deleteMany({ where: { propertyId: { in: [RA, LT] } } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (entries.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  await prisma.pmsShadowProfile.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await prisma.developerApp.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  if (userId) {
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.device.deleteMany({ where: { userId } });
    await prisma.userPropertyRole.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  if (roleId) {
    await prisma.rolePermission.deleteMany({ where: { roleId } });
    await prisma.role.deleteMany({ where: { id: roleId } });
  }
  const rooms = await prisma.room.findMany({ where: { propertyId: RA }, select: { id: true } });
  if (rooms.length) await prisma.housekeepingTask.deleteMany({ where: { roomId: { in: rooms.map((room) => room.id) } } });
  await prisma.rateDay.deleteMany({ where: { propertyId: RA } });
  await prisma.ratePlan.deleteMany({ where: { propertyId: RA } });
  await prisma.room.deleteMany({ where: { propertyId: RA } });
  await prisma.roomType.deleteMany({ where: { propertyId: RA } });
  await prisma.businessDate.deleteMany({ where: { propertyId: { in: [RA, LT, P2] } } });
  await prisma.notificationDelivery.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG2] } } });
}

before(async () => {
  await prisma.organization.create({ data: { id: ORG, name: "PL Hoteles Test", country: "ES" } });
  await prisma.organization.create({ data: { id: ORG2, name: "PL Otra Cadena Test", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: ENTITY, organizationId: ORG, code: "PLT", legalName: "PL Hoteles Test SA", taxId: syntheticCif(Date.now()), legalForm: "sa", fiscalAddress: "Calle Prueba 9", fiscalMunicipality: "A Coruña", fiscalProvince: "A Coruña", isDefault: true, status: "active" } });
  await prisma.property.create({ data: { id: RA, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "RA", name: "Rías Altas Test", timezone: TIMEZONE, currency: "EUR", createdAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.property.create({ data: { id: LT, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "LT", name: "Los Tilos Test", timezone: TIMEZONE, currency: "EUR", createdAt: new Date("2026-01-02T00:00:00Z") } });
  await prisma.property.create({ data: { id: P2, organizationId: ORG2, kind: "hotel", code: "P2", name: "Otra Cadena Test", timezone: TIMEZONE, currency: "EUR" } });
  await prisma.fiscalYear.create({ data: { organizationId: ORG, propertyId: null, code: "2026", startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z"), status: "open" } });
  const dbl = await prisma.roomType.create({ data: { propertyId: RA, code: "DBL", name: "Doble", maxOccupancy: 2, baseCapacity: 2, active: true }, select: { id: true } });
  for (const number of ["201", "202", "203"]) await prisma.room.create({ data: { propertyId: RA, roomTypeId: dbl.id, number, sellable: true, maintenanceStatus: "ok" } });
  const bar = await prisma.ratePlan.create({ data: { propertyId: RA, code: "BAR", name: "Best Available Rate", ratePlanType: "bar", active: true }, select: { id: true } });
  for (const offset of [5, 6, 7, 8]) {
    await prisma.rateDay.create({ data: { propertyId: RA, ratePlanId: bar.id, roomTypeId: dbl.id, date: new Date(`${day(offset)}T00:00:00.000Z`), price: "100.00", currency: "EUR", source: "manual" } });
  }
  await prisma.businessDate.create({ data: { propertyId: RA, currentDate: new Date(`${TODAY}T00:00:00.000Z`) } });
  await prisma.pmsShadowProfile.create({
    data: { organizationId: ORG, propertyId: RA, system: "opera_cloud", operaHotelCode: HOTEL_CODE, status: "active", mappingJson: { roomTypes: { DLX: "DBL" } }, trxMappingJson: MAPPING, scheduleJson: { feeds: [{ feed: "arrivals", expectedTime: "06:30", businessDateOffset: 0, required: true }, { feed: "revenue", expectedTime: "07:00", businessDateOffset: -1, required: true }] } }
  });
  await prisma.developerApp.create({ data: { organizationId: ORG, name: `Agente SFTP ${RUN}`, appType: "integration", status: "active", clientId: APP_OK.clientId, clientSecretHash: sha256(APP_OK.secret), scopes: [PMS_SHADOW_INGEST_SCOPE] } });
  await prisma.developerApp.create({ data: { organizationId: ORG, name: `App sin scope ${RUN}`, appType: "integration", status: "active", clientId: APP_NO_SCOPE.clientId, clientSecretHash: sha256(APP_NO_SCOPE.secret), scopes: ["reservations.read"] } });
  await prisma.developerApp.create({ data: { organizationId: ORG2, name: `Agente otra cadena ${RUN}`, appType: "integration", status: "active", clientId: APP_OTHER.clientId, clientSecretHash: sha256(APP_OTHER.secret), scopes: [PMS_SHADOW_INGEST_SCOPE] } });
  await prisma.developerApp.create({ data: { organizationId: ORG, name: `Agente SFTP Los Tilos ${RUN}`, appType: "integration", status: "active", clientId: APP_BOUND_LT.clientId, clientSecretHash: sha256(APP_BOUND_LT.secret), scopes: [pmsShadowIngestScopeFor(LT)] } });

  app = await buildApiServer();
  await app.ready();

  const keys = await prisma.permission.findMany({ where: { key: { in: [...ROLE_KEYS] } }, select: { id: true, key: true } });
  if (keys.length === ROLE_KEYS.length) {
    const role = await prisma.role.create({ data: { organizationId: ORG, name: `Dirección PL ${RUN}`, templateKey: null }, select: { id: true } });
    roleId = role.id;
    await prisma.rolePermission.createMany({ data: keys.map((k) => ({ roleId: role.id, permissionId: k.id })) });
    const user = await prisma.user.create({ data: { organizationId: ORG, email: USER_EMAIL, fullName: "Dirección PL", status: "active", passwordHash: hashPassword(USER_PASSWORD), passwordChangedAt: new Date(), mustChangePassword: false }, select: { id: true } });
    userId = user.id;
    // Rol en los dos hoteles de la organización: LT sirve para probar los 404 opacos del servicio (sin perfil, run de otra propiedad).
    await prisma.userPropertyRole.createMany({ data: [RA, LT].map((propertyId) => ({ userId: user.id, propertyId, roleId: role.id })) });
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: USER_EMAIL, password: USER_PASSWORD, deviceId: "integration-pms-shadow-routes" } });
    if (res.statusCode === 200) session = { authorization: `Bearer ${(JSON.parse(res.body) as { token: string }).token}` };
  }
});

after(async () => {
  try {
    await flushAuditQueues();
    await flushNotificationHooks();
    await flushAccountingProjection();
    await flushExtraProjections();
    await cleanup();
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

let runArrivals = "";
let runRevenue = "";
let runFailed = "";
/** Run `partial` del caso SC-02/SC-05 (crea PL-<RUN>-9102: tercera reserva enlazada; cuarto run; último run de `arrivals`). */
let runSc05 = "";
let alertId = "";

describe("L3 · POST /integrations/pms-shadow/ingest · clave de API (401 único, 404 opaco, 400 strict)", () => {
  it("sin cabecera → 401 PMS_SHADOW_INGEST_UNAUTHORIZED «Clave de API no autorizada.»", async () => {
    const res = await ingest<ErrorBody>(null, { propertyId: RA, fileName: "RESPONSYS_RESV_AUTO.csv", contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(res.status, 401, res.text.slice(0, 300));
    assert.equal(res.body?.details?.code, "PMS_SHADOW_INGEST_UNAUTHORIZED");
    assert.equal(res.body?.message, "Clave de API no autorizada.");
  });

  it("clave mal formada (sin punto), secreto incorrecto y app sin el scope → el MISMO 401", async () => {
    for (const key of ["sinpunto", `${APP_OK.clientId}.secreto-incorrecto`, keyOf(APP_NO_SCOPE)]) {
      const res = await ingest<ErrorBody>(key, { propertyId: RA, fileName: "RESPONSYS_RESV_AUTO.csv", contentBase64: CSV_ARRIVALS_B64 });
      assert.equal(res.status, 401, `${key}: ${res.text.slice(0, 200)}`);
      assert.equal(res.body?.details?.code, "PMS_SHADOW_INGEST_UNAUTHORIZED", key);
      assert.equal(res.body?.message, "Clave de API no autorizada.", key);
    }
  });

  it("app de otra organización sobre la propiedad → 404 opaco «Propiedad no encontrada.»; propiedad de la organización sin perfil → 404 PMS_SHADOW_PROFILE_NOT_FOUND", async () => {
    const other = await ingest<ErrorBody>(keyOf(APP_OTHER), { propertyId: RA, fileName: "RESPONSYS_RESV_AUTO.csv", contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(other.status, 404, other.text.slice(0, 300));
    assert.equal(other.body?.message, "Propiedad no encontrada.");
    assert.ok(!other.text.includes(RA), "no hace eco del id");
    const noProfile = await ingest<ErrorBody>(keyOf(APP_OK), { propertyId: LT, fileName: "RESPONSYS_RESV_AUTO.csv", contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(noProfile.status, 404, noProfile.text.slice(0, 300));
    assert.equal(noProfile.body?.details?.code, "PMS_SHADOW_PROFILE_NOT_FOUND");
  });

  it("SEC-04 · clave ligada a Los Tilos (pms.shadow.ingest:<LT>) sobre Rías Altas → el MISMO 401 (antes de mirar la propiedad); sobre Los Tilos pasa la clave (404 PMS_SHADOW_PROFILE_NOT_FOUND: sin perfil)", async () => {
    const otherCentre = await ingest<ErrorBody>(keyOf(APP_BOUND_LT), { propertyId: RA, fileName: "RESPONSYS_RESV_AUTO.csv", contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(otherCentre.status, 401, otherCentre.text.slice(0, 300));
    assert.equal(otherCentre.body?.details?.code, "PMS_SHADOW_INGEST_UNAUTHORIZED");
    assert.equal(otherCentre.body?.message, "Clave de API no autorizada.");
    assert.equal(await prisma.pmsShadowRun.count({ where: { propertyId: RA, createdBy: `developer_app:${APP_BOUND_LT.clientId}` } }), 0, "ningún run de Rías Altas con esa clave");
    const ownCentre = await ingest<ErrorBody>(keyOf(APP_BOUND_LT), { propertyId: LT, fileName: "RESPONSYS_RESV_AUTO.csv", contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(ownCentre.status, 404, ownCentre.text.slice(0, 300));
    assert.equal(ownCentre.body?.details?.code, "PMS_SHADOW_PROFILE_NOT_FOUND");
  });

  it("clave válida pero cuerpo con clave desconocida, feed fuera del catálogo o sin fileName → 400 VALIDATION_ERROR en español", async () => {
    const extra = await ingest<ErrorBody>(keyOf(APP_OK), { propertyId: RA, fileName: "x.csv", contentBase64: CSV_ARRIVALS_B64, fichero: "x" });
    assert.equal(extra.status, 400, extra.text.slice(0, 300));
    assert.equal(extra.body?.details?.code, "VALIDATION_ERROR");
    assert.match(extra.body?.message ?? "", /'fichero'/);
    const badFeed = await ingest<ErrorBody>(keyOf(APP_OK), { propertyId: RA, feed: "perfiles", fileName: "x.csv", contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(badFeed.status, 400);
    assert.match(badFeed.body?.message ?? "", /^body no válido: feed: .*perfiles/);
    const noName = await ingest<ErrorBody>(keyOf(APP_OK), { propertyId: RA, contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(noName.status, 400);
    assert.match(noName.body?.message ?? "", /fileName/);
  });
});

describe("L3 · ingest con clave válida · Responsys, ingresos XML y fichero irreconocible", () => {
  it("Responsys sintético (feed auto) → 202 { runId, status done, counts.created 2 }, run con reservationImportId, 2 PmsShadowLink, sin PII en la respuesta", async () => {
    const res = await ingest(keyOf(APP_OK), { propertyId: RA, feed: "auto", businessDate: TODAY, fileName: `RESPONSYS_RESV_AUTO_${RUN}.csv`, contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(res.status, 202, res.text.slice(0, 500));
    assert.ok(res.body?.runId);
    assert.equal(res.body?.status, "done", res.text.slice(0, 500));
    assert.equal(res.body?.counts.created, 2);
    assert.equal(res.body?.counts.error, 0);
    assert.deepEqual(res.body?.alerts, []);
    assertNoPii(res.text, "202 del ingest");
    runArrivals = res.body!.runId;
    const run = await prisma.pmsShadowRun.findUniqueOrThrow({ where: { id: runArrivals } });
    assert.equal(run.organizationId, ORG);
    assert.equal(run.propertyId, RA);
    assert.equal(run.feed, "arrivals");
    assert.equal(run.source, "api_key");
    assert.equal(run.status, "done");
    assert.equal(run.createdCount, 2);
    assert.equal(run.errorCount, 0);
    assert.equal(run.createdBy, `developer_app:${APP_OK.clientId}`);
    assert.ok(run.reservationImportId, "enlaza al lote de reservas");
    assert.ok(run.finishedAt);
    const lote = await prisma.reservationImport.findUniqueOrThrow({ where: { id: run.reservationImportId! } });
    assert.equal((lote.optionsJson as { shadowRunId?: string }).shadowRunId, runArrivals);
    assert.equal((lote.optionsJson as { source?: string }).source, "api_key");
    assert.equal(await prisma.pmsShadowLink.count({ where: { organizationId: ORG, propertyId: RA } }), 2);
    assert.equal(await prisma.reservation.count({ where: { propertyId: RA, status: "confirmed" } }), 2);
  });

  it("el mismo fichero para el mismo feed y business date → 409 PMS_SHADOW_RUN_DUPLICATE { runId }", async () => {
    const res = await ingest<ErrorBody>(keyOf(APP_OK), { propertyId: RA, feed: "arrivals", businessDate: TODAY, fileName: `RESPONSYS_RESV_AUTO_${RUN}.csv`, contentBase64: CSV_ARRIVALS_B64 });
    assert.equal(res.status, 409, res.text.slice(0, 300));
    assert.equal(res.body?.details?.code, "PMS_SHADOW_RUN_DUPLICATE");
    assert.equal(res.body?.details?.runId, runArrivals);
    assert.equal(await prisma.pmsShadowRun.count({ where: { organizationId: ORG, propertyId: RA, feed: "arrivals" } }), 1);
  });

  it("XML GEN_XMLBO_REVENUE → 202 done, run con revenueImportId, JournalEntry pms_shadow_revenue contabilizado y reconciliación registrada", async () => {
    const res = await ingest(keyOf(APP_OK), { propertyId: RA, fileName: `GEN_XMLBO_REVENUE_${RUN}.xml`, contentBase64: XML_REVENUE_B64 });
    assert.equal(res.status, 202, res.text.slice(0, 500));
    assert.equal(res.body?.status, "done", res.text.slice(0, 500));
    runRevenue = res.body!.runId;
    const run = await prisma.pmsShadowRun.findUniqueOrThrow({ where: { id: runRevenue } });
    assert.equal(run.feed, "revenue");
    assert.equal(run.businessDate?.toISOString().slice(0, 10), REVENUE_DAY, "la fecha del XML manda cuando no se indica businessDate");
    assert.ok(run.revenueImportId, "enlaza al lote de ingresos");
    const lote = await prisma.pmsShadowRevenueImport.findUniqueOrThrow({ where: { id: run.revenueImportId! } });
    assert.equal(lote.status, "posted");
    assert.equal(lote.journalEntryIds.length, 1);
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: lote.journalEntryIds[0]! } });
    assert.equal(entry.organizationId, ORG);
    assert.equal(entry.sourceType, "pms_shadow_revenue");
    assert.equal(entry.status, "posted");
    const result = run.resultJson as { reconciliation?: { ok?: boolean | null } };
    assert.ok(result.reconciliation, "reconciliación al recibir revenue");
    assert.equal(typeof result.reconciliation?.ok, "boolean");
  });

  it("fichero irreconocible (feed auto) → 202 status failed + alerta OPERA_FEED_UNRECOGNIZED persistida", async () => {
    const res = await ingest(keyOf(APP_OK), { propertyId: RA, fileName: `notas_${RUN}.txt`, contentBase64: Buffer.from("hola mundo\nsin cabecera conocida\n", "utf8").toString("base64") });
    assert.equal(res.status, 202, res.text.slice(0, 300));
    assert.equal(res.body?.status, "failed");
    assert.deepEqual(res.body?.alerts.map((alert) => alert.code), ["OPERA_FEED_UNRECOGNIZED"]);
    runFailed = res.body!.runId;
    const run = await prisma.pmsShadowRun.findUniqueOrThrow({ where: { id: runFailed } });
    assert.equal(run.status, "failed");
    assert.equal(run.feed, "unknown");
    assert.match(run.errorMessage ?? "", /No se reconoce el tipo de corte/);
    const alert = await prisma.pmsShadowAlert.findFirst({ where: { organizationId: ORG, propertyId: RA, code: "OPERA_FEED_UNRECOGNIZED", runId: runFailed } });
    assert.ok(alert, "alerta persistida");
    assert.equal(alert?.resolvedAt, null);
    alertId = alert!.id;
    const again = await ingest(keyOf(APP_OK), { propertyId: RA, fileName: `notas_${RUN}.txt`, contentBase64: Buffer.from("hola mundo\nsin cabecera conocida\n", "utf8").toString("base64") });
    assert.equal(again.status, 202, "un run failed se reutiliza (no es un 409)");
    assert.equal(again.body?.runId, runFailed);
    assert.equal(await prisma.pmsShadowAlert.count({ where: { organizationId: ORG, propertyId: RA, code: "OPERA_FEED_UNRECOGNIZED", runId: runFailed, resolvedAt: null } }), 1, "una alerta abierta por hecho");
  });

  it("corrector 7b · SC-02 sin businessDate el corte se ancla a hoy (no al business date estancado) · SC-05 una fila inválida omitida cuenta como error → run partial + OPERA_ROOM_TYPE_UNMAPPED", async () => {
    // Modo sombra: business_dates.current_date no avanza (night audit en OPERA). Se simula un business date 4 días atrás.
    await prisma.businessDate.update({ where: { propertyId: RA }, data: { currentDate: new Date(`${day(-4)}T00:00:00.000Z`) } });
    try {
      const invalid = responsys([{ ...ROW_A, RESERVATION_ID: `PL-${RUN}-9101`, ROOM_TYPE: "XYZ" }, { ...ROW_B, RESERVATION_ID: `PL-${RUN}-9102` }]);
      const res = await ingest(keyOf(APP_OK), { propertyId: RA, feed: "arrivals", fileName: `RESPONSYS_RESV_AUTO_${RUN}_sc05.csv`, contentBase64: Buffer.from(invalid, "utf8").toString("base64") });
      assert.equal(res.status, 202, res.text.slice(0, 300));
      assert.equal(res.body?.status, "partial", "SC-05: la fila inválida omitida es un error del corte, no una omisión");
      assert.equal(res.body?.counts.error, 1);
      assert.equal(res.body?.counts.skipped, 0);
      assert.equal(res.body?.counts.created, 1);
      assert.ok(res.body?.alerts.some((alert) => alert.code === "OPERA_ROOM_TYPE_UNMAPPED"), "SC-03: alerta con el room type sin mapear");
      runSc05 = res.body!.runId;
      const run = await prisma.pmsShadowRun.findUniqueOrThrow({ where: { id: res.body!.runId } });
      assert.equal(run.businessDate?.toISOString().slice(0, 10), TODAY, "SC-02: hoy en la zona del hotel + offset 0, no el business date estancado");
      assert.equal(run.status, "partial");
      assert.equal(run.errorCount, 1);
      assert.match(run.errorMessage ?? "", /RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN ×1/);
      for (const value of PII) assert.ok(!(run.errorMessage ?? "").includes(value), `errorMessage sin PII (${value})`);
    } finally {
      await prisma.businessDate.update({ where: { propertyId: RA }, data: { currentDate: new Date(`${TODAY}T00:00:00.000Z`) } });
    }
  });
});

describe("L3 · rutas con sesión: panel, perfil, cortes, alertas, reconciliación (200 y 404 opaco)", () => {
  it("GET overview → KPIs: 3 reservas enlazadas (2 del corte + 1 del caso SC-05), alertas abiertas ≥ 1, feeds de la programación con su último run", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const res = await request<{ propertyId: string; profile: { operaHotelCode: string } | null; lastRunAt: string | null; linkedReservations: number; openAlerts: number; feeds: Array<{ feed: string; state: string; required: boolean; lastRun: { id: string } | null }> }>("GET", `${BASE}/overview`, s);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body?.propertyId, RA);
    assert.equal(res.body?.profile?.operaHotelCode, HOTEL_CODE);
    assert.equal(res.body?.linkedReservations, 3);
    assert.ok((res.body?.openAlerts ?? 0) >= 1);
    assert.ok(res.body?.lastRunAt);
    const arrivals = res.body?.feeds.find((feed) => feed.feed === "arrivals");
    assert.ok(arrivals?.required);
    assert.equal(arrivals?.lastRun?.id, runSc05, "el último run de arrivals es el partial del caso SC-05 (por createdAt)");
    assert.ok(["ok", "late"].includes(arrivals?.state ?? ""), `un run partial no es "failed": ${arrivals?.state}`);
    assertNoPii(res.text, "overview");
  });

  it("GET profile → 200 (RIAS); PUT profile → 200 con inboxEmail y auditoría; GET profile de LT → 404 PMS_SHADOW_PROFILE_NOT_FOUND", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const get = await request<{ operaHotelCode: string; status: string; trxMapping: unknown[] }>("GET", `${BASE}/profile`, s);
    assert.equal(get.status, 200, get.text.slice(0, 300));
    assert.equal(get.body?.operaHotelCode, HOTEL_CODE);
    assert.equal(get.body?.trxMapping.length, MAPPING.length);
    const put = await request<{ inboxEmail: string | null; status: string; operaHotelCode: string }>("PUT", `${BASE}/profile`, s, { operaHotelCode: HOTEL_CODE, inboxEmail: `opera-ra-${RUN}@example.com` });
    assert.equal(put.status, 200, put.text.slice(0, 300));
    assert.equal(put.body?.inboxEmail, `opera-ra-${RUN}@example.com`);
    assert.equal(put.body?.status, "active");
    const bad = await request<ErrorBody>("PUT", `${BASE}/profile`, s, { operaHotelCode: HOTEL_CODE, otra: 1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body?.details?.code, "VALIDATION_ERROR");
    const none = await request<ErrorBody>("GET", `/properties/${LT}/pms-shadow/profile`, s);
    assert.equal(none.status, 404);
    assert.equal(none.body?.details?.code, "PMS_SHADOW_PROFILE_NOT_FOUND");
  });

  it("GET runs (4, filtros y limit), GET runs/:id → 200; run de otra propiedad → 404 opaco; limit inválido → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const list = await request<Array<{ id: string; feed: string; status: string }>>("GET", `${BASE}/runs`, s);
    assert.equal(list.status, 200, list.text.slice(0, 300));
    assert.equal(list.body?.length, 4);
    assert.deepEqual(new Set(list.body?.map((run) => run.id)), new Set([runArrivals, runRevenue, runFailed, runSc05]));
    const partial = await request<Array<{ id: string }>>("GET", `${BASE}/runs?status=partial&limit=5`, s);
    assert.deepEqual(partial.body?.map((run) => run.id), [runSc05]);
    const failed = await request<Array<{ id: string }>>("GET", `${BASE}/runs?status=failed&limit=5`, s);
    assert.deepEqual(failed.body?.map((run) => run.id), [runFailed]);
    const one = await request<{ id: string; feed: string; reservationImportId: string | null; alerts: unknown[] }>("GET", `${BASE}/runs/${runArrivals}`, s);
    assert.equal(one.status, 200, one.text.slice(0, 300));
    assert.equal(one.body?.feed, "arrivals");
    assert.ok(one.body?.reservationImportId);
    const foreign = await prisma.pmsShadowRun.create({ data: { organizationId: ORG, propertyId: LT, feed: "arrivals", source: "manual", businessDate: new Date(`${TODAY}T00:00:00.000Z`), contentHash: `lt-${RUN}`, status: "failed" } });
    const other = await request<ErrorBody>("GET", `${BASE}/runs/${foreign.id}`, s);
    assert.equal(other.status, 404, other.text.slice(0, 300));
    assert.equal(other.body?.message, "Corte OPERA no encontrado.");
    const missing = await request<ErrorBody>("GET", `${BASE}/runs/no-existe`, s);
    assert.equal(missing.status, 404);
    const badLimit = await request<ErrorBody>("GET", `${BASE}/runs?limit=0`, s);
    assert.equal(badLimit.status, 400);
  });

  it("GET alerts (abiertas por defecto, filtro por código) → 200 con OPERA_FEED_UNRECOGNIZED; ?open=x → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const res = await request<Array<{ id: string; code: string; resolvedAt: string | null; message: string }>>("GET", `${BASE}/alerts?code=OPERA_FEED_UNRECOGNIZED`, s);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(res.body?.some((alert) => alert.id === alertId));
    for (const alert of res.body ?? []) assert.equal(alert.resolvedAt, null);
    const bad = await request<ErrorBody>("GET", `${BASE}/alerts?open=x`, s);
    assert.equal(bad.status, 400);
  });

  it("GET reconciliation?businessDate= → 200 con 13 filas y tolerancias de §5.4; sin businessDate → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const res = await request<{ businessDate: string; rows: Array<{ metric: string; status: string; opera: string | null; anfitorio: string }>; ok: boolean; sources: { revenueImportId: string | null } }>("GET", `${BASE}/reconciliation?businessDate=${REVENUE_DAY}`, s);
    assert.equal(res.status, 200, res.text.slice(0, 500));
    assert.equal(res.body?.businessDate, REVENUE_DAY);
    assert.equal(res.body?.rows.length, 13);
    assert.ok(res.body?.sources.revenueImportId, "el lote de ingresos del día alimenta las métricas de importe");
    const total = res.body?.rows.find((row) => row.metric === "revenue_total");
    assert.equal(total?.anfitorio, "1544.50", "Σ 705.x del asiento (1234.50 + 310.00)");
    assert.equal(total?.status, "missing", "OPERA no declaró totales: falta un lado");
    assert.equal(PMS_SHADOW_RECON_TOLERANCES.revenueTotal, "1.00");
    const bad = await request<ErrorBody>("GET", `${BASE}/reconciliation`, s);
    assert.equal(bad.status, 400);
  });

  it("POST alerts/:id/resolve { note } → resolvedAt + auditoría PMS_SHADOW_ALERT_RESOLVED; segundo resolve → 409; sin note → 400", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const noNote = await request<ErrorBody>("POST", `${BASE}/alerts/${alertId}/resolve`, s, {});
    assert.equal(noNote.status, 400);
    const res = await request<{ id: string; resolvedAt: string | null; resolvedBy: string | null; resolutionNote: string | null }>("POST", `${BASE}/alerts/${alertId}/resolve`, s, { note: "Fichero de prueba sin corte: descartado." });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(res.body?.resolvedAt);
    assert.equal(res.body?.resolvedBy, userId);
    assert.equal(res.body?.resolutionNote, "Fichero de prueba sin corte: descartado.");
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "PMS_SHADOW_ALERT_RESOLVED", entityId: alertId } });
    assert.ok(audit, "auditoría de la resolución");
    assert.equal(audit?.entityType, "pms_shadow_alert");
    const again = await request<ErrorBody>("POST", `${BASE}/alerts/${alertId}/resolve`, s, { note: "otra vez" });
    assert.equal(again.status, 409);
    assert.equal(again.body?.details?.code, "PMS_SHADOW_ALERT_ALREADY_RESOLVED");
    const foreign = await request<ErrorBody>("POST", `${BASE}/alerts/no-existe/resolve`, s, { note: "x" });
    assert.equal(foreign.status, 404);
  });

  it("POST runs (subida manual) con clave desconocida → 400; GET revenue → lista con el lote contabilizado; GET revenue/:id → 200", async (t) => {
    const s = needsSession(t);
    if (!s) return;
    const bad = await request<ErrorBody>("POST", `${BASE}/runs`, s, { fileName: "x.csv", contentBase64: CSV_ARRIVALS_B64, fichero: "x" });
    assert.equal(bad.status, 400, bad.text.slice(0, 300));
    assert.equal(bad.body?.details?.code, "VALIDATION_ERROR");
    const list = await request<Array<{ id: string; status: string; businessDate: string }>>("GET", `${BASE}/revenue?businessDate=${REVENUE_DAY}`, s);
    assert.equal(list.status, 200, list.text.slice(0, 300));
    assert.equal(list.body?.length, 1);
    assert.equal(list.body?.[0]?.status, "posted");
    const one = await request<{ id: string; lines: unknown[] }>("GET", `${BASE}/revenue/${list.body![0]!.id}`, s);
    assert.equal(one.status, 200, one.text.slice(0, 300));
    assert.equal(one.body?.lines.length, CODES.length);
  });
});

describe("L3 · RBAC estricto sin token → 401 en las rutas high / critical; el ingest público sigue respondiendo con su propia clave", () => {
  it("PUT profile, POST runs, POST alerts/:id/resolve, POST revenue, POST revenue/:id/reverse → 401 sin token", async () => {
    await withEnv(STRICT_ENV, async () => {
      const cases: Array<["PUT" | "POST", string]> = [
        ["PUT", `${BASE}/profile`],
        ["POST", `${BASE}/runs`],
        ["POST", `${BASE}/alerts/${alertId || "x"}/resolve`],
        ["POST", `${BASE}/revenue`],
        ["POST", `${BASE}/revenue/x/reverse`]
      ];
      for (const [method, url] of cases) {
        const res = await request<ErrorBody>(method, url, {}, {});
        assert.equal(res.status, 401, `${method} ${url}: ${res.text.slice(0, 200)}`);
      }
      const publicRoute = await ingest<ErrorBody>(null, {});
      assert.equal(publicRoute.status, 401, "pública pero sin clave: 401 de la clave, no del JWT");
      assert.equal(publicRoute.body?.details?.code, "PMS_SHADOW_INGEST_UNAUTHORIZED");
    });
  });
});

describe("integrador 7b · la reconciliación que dispara un run stats usa las métricas de ESE run (aún processing), no solo las de los runs ya cerrados", () => {
  it("stats con arrivalRooms 99 → el propio run registra el mismatch y abre OPERA_RECON_COUNT_MISMATCH; el corregido cuadra y la cierra sola", async () => {
    const wrong = Buffer.from(JSON.stringify({ arrivalRooms: 99, departureRooms: 0 }), "utf8").toString("base64");
    const res = await ingest(keyOf(APP_OK), { propertyId: RA, feed: "stats", businessDate: REVENUE_DAY, fileName: `manager_report_${RUN}.json`, contentBase64: wrong });
    assert.equal(res.status, 202, res.text.slice(0, 300));
    assert.equal(res.body?.status, "done", res.text.slice(0, 300));
    const run = await prisma.pmsShadowRun.findUniqueOrThrow({ where: { id: res.body!.runId } });
    const result = run.resultJson as { reconciliation?: { ok?: boolean; mismatches?: { count: number; revenue: number } } };
    assert.equal(result.reconciliation?.ok, false, "la desviación del propio fichero cuenta en la reconciliación que dispara");
    assert.equal(result.reconciliation?.mismatches?.count, 1);
    const alert = await prisma.pmsShadowAlert.findFirst({ where: { organizationId: ORG, propertyId: RA, code: "OPERA_RECON_COUNT_MISMATCH", resolvedAt: null } });
    assert.ok(alert, "alerta abierta");
    assert.equal(alert?.runId, run.id, "la alerta cita el run que la produjo");
    const fixed = Buffer.from(JSON.stringify({ arrivalRooms: 0, departureRooms: 0 }), "utf8").toString("base64");
    const again = await ingest(keyOf(APP_OK), { propertyId: RA, feed: "stats", businessDate: REVENUE_DAY, fileName: `manager_report_${RUN}_v2.json`, contentBase64: fixed });
    assert.equal(again.status, 202, again.text.slice(0, 300));
    const run2 = await prisma.pmsShadowRun.findUniqueOrThrow({ where: { id: again.body!.runId } });
    assert.equal((run2.resultJson as { reconciliation?: { ok?: boolean } }).reconciliation?.ok, true, "el fichero corregido manda sobre el anterior del mismo día");
    const closed = await prisma.pmsShadowAlert.findUniqueOrThrow({ where: { id: alert!.id } });
    assert.ok(closed.resolvedAt, "cierre automático al volver a cuadrar");
  });
});
