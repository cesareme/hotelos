/**
 * Tanda L8 · lote L8-08 · integración (Postgres): estado honesto de las
 * integraciones sobre una organización AISLADA (helpers/l2-tenant.mts), auth
 * real y RBAC_STRICT; Faranda y org_123 solo se leen (invariantes).
 *
 *   · GET /integrations/status → 401 sin token, 403 recepción (sin
 *     integrations.read), 403 owner (la plantilla lo revoca: solo lectura +
 *     aprobaciones), 200 dirección general y sistemas: 18 entradas en el orden
 *     de INTEGRATION_KEYS, cada modo ∈ {none, sandbox, real}, readyForReal ≡
 *     real && sin pendientes, none ⇒ sin actividad, sandbox nunca «enviado»,
 *     ninguna consulta degradada;
 *   · con withEnv (AI_PROVIDER=none, CHANNEL_MAX_MODE=stub, sin claves de PSP,
 *     REDIS_URL=redis://x) → ai y psp `none`, redis `none` configurado «sin
 *     consumidor», canales con tope «simulador sin credenciales», ninguna
 *     entrada real por red (la única `real` posible es la exportación manual a
 *     gestoría, transporte manual, que no cruza ninguna red);
 *   · GET /health → clave superior `integrations` con exactamente las 14
 *     claves sin propiedad (INTEGRATION_HEALTH_KEYS), solo modo + frase, sin
 *     «http», sin «://» ni rutas (la única barra admitida es el separador
 *     « / » de una frase y la mención literal a «/health»), fuera de `checks`;
 *   · POST /properties/:id/integrations/:connectionId/test sobre una conexión
 *     del catálogo de demostración → status `simulated`, evento
 *     IntegrationTestSimulated, nunca `ok` ni `accepted`, lastSyncAt intacto;
 *   · invariantes de Faranda idénticas antes y después; sin organización residual.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/integraciones-estado.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { INTEGRATION_KEYS, INTEGRATION_MODES, ROLE_PERMISSION_MAP } = await import("@hotelos/shared");
type IntegrationStatusDto = import("@hotelos/shared").IntegrationStatusDto;
type IntegrationsStatusResponse = import("@hotelos/shared").IntegrationsStatusResponse;
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetAiConfigForTests } = await import("../../apps/api/src/lib/ai-config.js");
const { INTEGRATION_HEALTH_KEYS } = await import("../../apps/api/src/modules/integrations/integrations-status.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST";
type Reply<T = any> = { status: number; body: T; raw: string };
type HealthBody = { status: string; ok: boolean; checks: Record<string, { ok: boolean }>; integrations?: Record<string, { mode: string; message: string }> };

const RUN = `l808${newRunId()}`;
const SAYS_SENT = /\benviad[oa]s?\b/i;
const URL_OR_ENDPOINT = /https?:|:\/\/|\bwww\./i;
const SECRET_VAR_NAME = /\b[A-Z][A-Z0-9]*_(SECRET|KEY|TOKEN|PASSPHRASE|PASSWORD|DSN|URL)\b/;
/** La única `real` admisible en un tenant recién creado: exportación manual (nada cruza por red). */
const MANUAL_REAL_KEYS = new Set(["gestoria_export"]);

let app: ApiApp;
let tenant: IsolatedTenant;
let owner: Session;
let direccion: Session;
let recepcion: Session;
let sistemas: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

async function call<T = any>(method: Method, url: string, session: Session | null, options: { payload?: Record<string, unknown>; propertyId?: string } = {}): Promise<Reply<T>> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), ...(options.propertyId ? { "x-property-id": options.propertyId } : {}) },
      ...(options.payload !== undefined ? { payload: options.payload } : {})
    })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

const statusUrl = (propertyId: string) => `/integrations/status?propertyId=${encodeURIComponent(propertyId)}`;

/** Invariantes del DTO (las mismas que fija el contrato L8-01 en el test unitario del servicio). */
function assertDto(dto: IntegrationStatusDto): void {
  assert.ok((INTEGRATION_MODES as readonly string[]).includes(dto.mode), `${dto.key}: modo ${dto.mode} fuera de none | sandbox | real`);
  assert.equal(dto.readyForReal, dto.mode === "real" && dto.missingForReal.length === 0, `${dto.key}: readyForReal ≡ real && sin pendientes`);
  if (dto.mode === "none") {
    assert.equal(dto.readyForReal, false, `${dto.key}: none nunca está listo`);
    assert.equal(dto.lastActivityAt, null, `${dto.key}: none sin actividad`);
  }
  if (dto.mode === "sandbox") {
    assert.doesNotMatch(dto.message, SAYS_SENT, `${dto.key}: sandbox nunca dice «enviado»`);
    assert.match(dto.message, /simul|prueba|ficticia|local/i, `${dto.key}: sandbox se declara como tal`);
  }
  assert.ok(dto.message.trim().length > 0, `${dto.key}: frase vacía`);
  for (const text of [dto.message, ...dto.missingForReal]) {
    assert.doesNotMatch(text, URL_OR_ENDPOINT, `${dto.key}: sin URLs ni endpoints`);
    assert.doesNotMatch(text, SECRET_VAR_NAME, `${dto.key}: sin nombres de variables secretas`);
  }
  if (dto.lastActivityAt !== null) assert.ok(!Number.isNaN(Date.parse(dto.lastActivityAt)), `${dto.key}: lastActivityAt ISO`);
}

function assertStatusResponse(body: IntegrationsStatusResponse, propertyId: string): void {
  assert.equal(body.propertyId, propertyId);
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
  assert.deepEqual(
    body.integrations.map((dto) => dto.key),
    [...INTEGRATION_KEYS],
    "una entrada por IntegrationKey, en el orden del contrato"
  );
  for (const dto of body.integrations) assertDto(dto);
  assert.deepEqual(body.degraded, [], "ninguna consulta degradada (con datos degradados los contadores no valen)");
}

function byKey(body: IntegrationsStatusResponse, key: string): IntegrationStatusDto {
  const dto = body.integrations.find((entry) => entry.key === key);
  assert.ok(dto, `sin entrada ${key}`);
  return dto;
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  tenant = await createIsolatedTenant(RUN);
  app = await buildApiServer();
  await app.ready();
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, tenant.users.owner.email, tenant.password, "l808-owner");
    direccion = await loginOrThrow(app, tenant.users.generalManager.email, tenant.password, "l808-direccion");
    recepcion = await loginOrThrow(app, tenant.users.receptionist.email, tenant.password, "l808-recepcion");
    sistemas = await loginOrThrow(app, tenant.users.systems.email, tenant.password, "l808-sistemas");
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    if (tenant) await cleanupTenant(tenant.organizationId);
  } finally {
    await app?.close();
  }
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  assert.equal(await prisma.organization.count({ where: { id: tenant.organizationId } }), 0, "sin organización residual de esta suite");
});

describe("L8-08 · GET /integrations/status: auth real, RBAC_STRICT y contrato del DTO", () => {
  it("sin token → 401", async () => {
    const res = await call("GET", statusUrl(tenant.propertyA), null);
    assert.equal(res.status, 401, res.raw);
  });

  it("recepción (sin integrations.read) → 403", async () => {
    const res = await call("GET", statusUrl(tenant.propertyA), recepcion, { propertyId: tenant.propertyA });
    assert.equal(res.status, 403, res.raw);
  });

  it("owner responde según su plantilla (hoy revocada integrations.read: 403), nunca 500 ni 401", async () => {
    const expected = ROLE_PERMISSION_MAP.owner.includes("integrations.read") ? 200 : 403;
    const res = await call("GET", statusUrl(tenant.propertyA), owner, { propertyId: tenant.propertyA });
    assert.equal(res.status, expected, res.raw);
  });

  it("dirección general (hotel A y B) → 200 con las 18 entradas, modos válidos y cero consultas degradadas", async () => {
    const res = await call<IntegrationsStatusResponse>("GET", statusUrl(tenant.propertyA), direccion, { propertyId: tenant.propertyA });
    assert.equal(res.status, 200, res.raw);
    assertStatusResponse(res.body, tenant.propertyA);
    const modes = new Set(res.body.integrations.map((dto) => dto.mode));
    for (const mode of modes) assert.ok((INTEGRATION_MODES as readonly string[]).includes(mode));
    // Tenant recién creado: sin perfil OPERA, sin lotes Sage 200, sin canales, sin fuentes de reseñas.
    for (const key of ["opera", "sage200", "channels", "gbp", "psp", "email_in"]) {
      const dto = byKey(res.body, key);
      assert.equal(dto.mode, "none", `${key} en un tenant vacío: ${dto.message}`);
      assert.equal(dto.lastActivityAt, null);
    }
    assert.equal(byKey(res.body, "igic").mode, "none", "IGIC no es una integración propia");
    // Hotel B también es suyo (ámbito hotel, dos filas).
    const resB = await call<IntegrationsStatusResponse>("GET", statusUrl(tenant.propertyB), direccion, { propertyId: tenant.propertyA });
    assert.equal(resB.status, 200, resB.raw);
    assert.equal(resB.body.propertyId, tenant.propertyB);
  });

  it("sistemas (plantilla admin, organización) → 200; propertyId vacío → 400; propiedad ajena → 404 opaco", async () => {
    const ok = await call<IntegrationsStatusResponse>("GET", statusUrl(tenant.propertyA), sistemas, { propertyId: tenant.propertyA });
    assert.equal(ok.status, 200, ok.raw);
    assertStatusResponse(ok.body, tenant.propertyA);
    const empty = await call("GET", "/integrations/status?propertyId=", sistemas, { propertyId: tenant.propertyA });
    assert.equal(empty.status, 400, empty.raw);
    const foreign = await call("GET", statusUrl("prop_uxday"), sistemas, { propertyId: tenant.propertyA });
    assert.equal(foreign.status, 404, foreign.raw);
    assert.equal(foreign.raw.includes("org_uxday"), false, "el 404 no revela la organización dueña");
  });

  it("recepción con la clave de otro usuario no la hereda: el permiso se evalúa por sesión (403 también por cabecera x-property-id)", async () => {
    const res = await call("GET", "/integrations/status", recepcion, { propertyId: tenant.propertyA });
    assert.equal(res.status, 403, res.raw);
  });
});

describe("L8-08 · modo ↔ entorno: none nunca simula un resultado real", () => {
  it("AI_PROVIDER=none, CHANNEL_MAX_MODE=stub, sin claves de PSP y REDIS_URL sin consumidor → ai/psp none, redis none «sin consumidor», ninguna entrada real por red", async () => {
    const overrides: Record<string, string | undefined> = {
      ...STRICT_ENV,
      AI_PROVIDER: "none",
      AI_PROVIDER_API_KEY: undefined,
      CHANNEL_MAX_MODE: "stub",
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      REDSYS_MERCHANT_CODE: undefined,
      REDSYS_TERMINAL: undefined,
      REDSYS_SECRET_KEY: undefined,
      PAYMENTS_PSP_PROVIDER: undefined,
      REDIS_URL: "redis://x"
    };
    let body: IntegrationsStatusResponse | null = null;
    try {
      body = await withEnv(overrides, async () => {
        // La configuración de IA se memoriza por proceso: se reconstruye desde el entorno sobrescrito (hook solo para tests).
        resetAiConfigForTests();
        const res = await app.inject({ method: "GET", url: statusUrl(tenant.propertyA), headers: { ...direccion.headers, "x-property-id": tenant.propertyA } });
        assert.equal(res.statusCode, 200, res.body);
        return JSON.parse(res.body) as IntegrationsStatusResponse;
      });
    } finally {
      resetAiConfigForTests();
    }
    assert.ok(body);
    assertStatusResponse(body, tenant.propertyA);

    const ai = byKey(body, "ai");
    assert.equal(ai.mode, "none");
    assert.equal(ai.configured, false);
    assert.equal(ai.readyForReal, false);
    assert.match(ai.message, /no inventan resultados/);

    const psp = byKey(body, "psp");
    assert.equal(psp.mode, "none");
    assert.equal(psp.configured, false);
    assert.match(psp.message, /Ningún PSP configurado/);
    assert.equal(psp.lastActivityAt, null);

    const redis = byKey(body, "redis");
    assert.equal(redis.mode, "none", "REDIS_URL con valor pero sin cliente en el API: none");
    assert.equal(redis.configured, true);
    assert.equal(redis.transport, "none");
    assert.match(redis.message, /ningún componente del API la usa/);
    assert.ok(redis.missingForReal.some((item) => /consumidor real/.test(item)), redis.missingForReal.join(" · "));

    const channels = byKey(body, "channels");
    assert.equal(channels.mode, "none", "sin canales dados de alta");
    assert.match(channels.message, /simulador sin credenciales/, "el tope stub se nombra como tal");

    const realByNetwork = body.integrations.filter((dto) => dto.mode === "real" && dto.transport === "http");
    assert.deepEqual(realByNetwork.map((dto) => dto.key), [], "nada cruza por red en un tenant sin credenciales");
    const real = body.integrations.filter((dto) => dto.mode === "real").map((dto) => dto.key);
    assert.ok(real.every((key) => MANUAL_REAL_KEYS.has(key)), `entradas real inesperadas: ${real.join(", ")}`);
    for (const dto of body.integrations) {
      if (dto.mode === "none") assert.equal(dto.lastActivityAt, null, `${dto.key}: none sin actividad`);
    }
  });
});

describe("L8-08 · GET /health: bloque `integrations` público y sin base de datos", () => {
  it("lleva exactamente las 14 claves sin propiedad, solo modo + frase, sin http ni rutas, y no es un check", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as HealthBody;
    assert.ok(body.integrations, "clave superior `integrations` ausente en /health");
    assert.deepEqual(Object.keys(body.integrations), [...INTEGRATION_HEALTH_KEYS]);
    assert.equal(Object.keys(body.integrations).length, 14);
    for (const key of ["opera", "sage200", "psp", "gbp"]) assert.equal(key in body.integrations, false, `${key} depende de la propiedad: fuera de /health`);
    for (const [key, entry] of Object.entries(body.integrations)) {
      assert.deepEqual(Object.keys(entry).sort(), ["message", "mode"], `${key}: solo modo y frase`);
      assert.ok((INTEGRATION_MODES as readonly string[]).includes(entry.mode), `${key}: modo ${entry.mode}`);
      assert.ok(entry.message.trim().length > 0 && entry.message.length <= 260, `${key}: frase vacía o demasiado larga`);
      if (entry.mode === "sandbox") assert.doesNotMatch(entry.message, SAYS_SENT, `${key}: sandbox nunca dice «enviado»`);
      assert.doesNotMatch(entry.message, SECRET_VAR_NAME, `${key}: sin variables secretas`);
    }
    const serialized = JSON.stringify(body.integrations);
    assert.doesNotMatch(serialized, /http/i, "sin «http» en el bloque público");
    assert.doesNotMatch(serialized, /:\/\//, "sin esquemas ni endpoints");
    // Barras admitidas: el separador « / » de una frase y la mención literal a la propia ruta /health.
    const withoutAllowed = serialized.replace(/ \/ /g, " ").replace(/\/health\b/g, "health");
    assert.doesNotMatch(withoutAllowed, /\//, `ruta o URL en el bloque integrations: ${serialized}`);
    assert.equal("integrations" in body.checks, false, "integrations no es un check: none/sandbox no degrada status");
    const checksOk = Object.values(body.checks).every((check) => check.ok);
    assert.equal(body.ok, checksOk);
    assert.equal(body.status, checksOk ? "healthy" : "degraded");
  });
});

describe("L8-08 · hub heredado: la prueba de conexión de un proveedor de demostración es «simulated»", () => {
  it("connect + test → status simulated, evento IntegrationTestSimulated, nunca ok/accepted, lastSyncAt intacto", async () => {
    const connect = await call<{ id: string; status: string; lastSyncAt?: string | null }>("POST", `/properties/${tenant.propertyA}/integrations/mock_payments/connect`, sistemas, {
      propertyId: tenant.propertyA,
      payload: { configJson: { note: `l808 ${RUN}` } }
    });
    assert.ok(connect.status === 200 || connect.status === 201, connect.raw);
    assert.ok(connect.body?.id, "sin id de conexión");
    assert.equal(connect.body.status, "connected");

    const test = await call<{ status: string; simulated: boolean; message: string; connectionId: string; event: { eventType: string; status: string } }>(
      "POST",
      `/properties/${tenant.propertyA}/integrations/${connect.body.id}/test`,
      sistemas,
      { propertyId: tenant.propertyA, payload: {} }
    );
    assert.equal(test.status, 200, test.raw);
    assert.equal(test.body.status, "simulated");
    assert.equal(test.body.simulated, true);
    assert.equal(test.body.connectionId, connect.body.id);
    assert.match(test.body.message, /Prueba simulada/);
    assert.match(test.body.message, /demostración/);
    assert.equal(test.body.event.eventType, "IntegrationTestSimulated");
    assert.equal(test.body.event.status, "simulated");
    assert.doesNotMatch(test.raw, /"status":"(ok|accepted)"/);

    const events = await call<Array<{ eventType: string; status: string }>>("GET", `/properties/${tenant.propertyA}/integrations/${connect.body.id}/events`, sistemas, { propertyId: tenant.propertyA });
    assert.equal(events.status, 200, events.raw);
    assert.ok(events.body.some((event) => event.eventType === "IntegrationTestSimulated" && event.status === "simulated"));
    assert.equal(events.body.some((event) => event.status === "accepted"), false, "ningún acuse accepted en una conexión de demostración");

    const row = await prisma.integrationConnection.findUnique({ where: { id: connect.body.id }, select: { lastSyncAt: true, propertyId: true } });
    assert.ok(row);
    assert.equal(row.propertyId, tenant.propertyA);
    assert.equal(row.lastSyncAt, null, "una prueba simulada no sincroniza nada");
    assert.equal(await prisma.integrationEvent.count({ where: { connectionId: connect.body.id, status: "simulated" } }), 1);
    assert.equal(await prisma.integrationEvent.count({ where: { connectionId: connect.body.id, status: "accepted" } }), 0);
  });

  it("recepción no puede probar la conexión (integrations.test) → 403", async () => {
    const list = await call<Array<{ id: string }>>("GET", `/properties/${tenant.propertyA}/integrations`, sistemas, { propertyId: tenant.propertyA });
    assert.equal(list.status, 200, list.raw);
    assert.ok(list.body.length >= 1);
    const res = await call("POST", `/properties/${tenant.propertyA}/integrations/${list.body[0]!.id}/test`, recepcion, { propertyId: tenant.propertyA, payload: {} });
    assert.equal(res.status, 403, res.raw);
  });
});
