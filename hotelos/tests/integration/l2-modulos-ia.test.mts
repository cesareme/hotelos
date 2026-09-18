/**
 * Tanda L2 · L2-08 · tests de integración mínimos por módulo — IA
 * (ai, assistant, copilot). app.inject sobre Postgres real con dos
 * organizaciones AISLADAS (helpers/l2-tenant.mts): A escribe y lee; B (otra
 * organización) nunca ve nada. STRICT_ENV: auth real, sin unión de permisos de
 * demo, RBAC_STRICT=true. Sin proveedor de IA configurado el API degrada con
 * honestidad (`configured: false`, `mode: "deterministic"`) y persiste igual
 * la telemetría (`ai_tool_calls` con organizationId).
 *
 * Tres casos por módulo (criterio §4 del plan · fila L2 «tests por módulo»):
 *   (1) crear o leer con ámbito (fila en Prisma con organizationId / propertyId de A);
 *   (2) 403 sin clave (mensaje en español del gate o de requirePermissions,
 *       nunca el 403 de «ruta no registrada en el manifiesto»); en los módulos
 *       cuyas rutas son solo `authenticated` (assistant/tools, copilot) el
 *       caso negativo es el 401 sin sesión;
 *   (3) 404 opaco en propiedad ajena (recepción de A sobre el hotel B; usuario
 *       de la organización B sobre el hotel A o sobre una entidad de A) y 404
 *       tipado con id inexistente (POST /ai/confirmations/:id/execute).
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-modulos-ia.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string; headers: Record<string, unknown> };

const RUN = `i${newRunId()}`;
const OPAQUE_404 = "Propiedad no encontrada.";
/** PNG de 1×1 (base64) — basta para que el comando reciba una imagen; sin proveedor no se envía a ningún sitio. */
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
let owner: Session;
let reception: Session;
let accountant: Session;
let systems: Session;
let auditor: Session;
let ownerB: Session;
let receptionB: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

async function call(method: Method, url: string, session: Session | null, options: { payload?: unknown; propertyId?: string } = {}): Promise<Reply> {
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
  return { status: res.statusCode, body, raw: res.body, headers: res.headers as Record<string, unknown> };
}

function expect404(reply: Reply, message = OPAQUE_404): void {
  assert.equal(reply.status, 404, reply.raw.slice(0, 300));
  assert.equal(reply.body?.message, message);
}

/** 403 en español del gate o de requirePermissions, con la clave que falta; nunca el de «ruta sin manifiesto». */
function expect403(reply: Reply, key: string): void {
  assert.equal(reply.status, 403, reply.raw.slice(0, 300));
  const message = String(reply.body?.message ?? "");
  assert.match(message, /^No tienes permiso para realizar esta acción/, message);
  assert.ok(message.includes(key), `la clave que falta (${key}) viaja en el mensaje: ${message}`);
  assert.doesNotMatch(message, /manifiesto/, "no es el 403 de ruta sin entrada en el manifiesto");
}

async function addTenantUser(tenant: IsolatedTenant, spec: { local: string; templateKey: string; propertyId?: string }): Promise<{ id: string; email: string }> {
  const id = `usr_l2_${spec.local}_${tenant.run}`;
  const email = `${spec.local}.l2.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L2 ${spec.local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[spec.templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({
    data: { userId: id, roleId, scopeType: spec.propertyId ? "property" : "organization", propertyId: spec.propertyId ?? null, organizationId: tenant.organizationId, reason: `l2-08 ${spec.local}` }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  B = await createIsolatedTenant(`${RUN}b`);
  const auditorUser = await addTenantUser(A, { local: "auditor", templateKey: "auditor" });
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, A.users.owner.email, A.password, "l2-08-ia-owner");
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l2-08-ia-reception");
    accountant = await loginOrThrow(app, A.users.accountant.email, A.password, "l2-08-ia-accountant");
    systems = await loginOrThrow(app, A.users.systems.email, A.password, "l2-08-ia-systems");
    auditor = await loginOrThrow(app, auditorUser.email, A.password, "l2-08-ia-auditor");
    ownerB = await loginOrThrow(app, B.users.owner.email, B.password, "l2-08-ia-owner-b");
    receptionB = await loginOrThrow(app, B.users.receptionist.email, B.password, "l2-08-ia-reception-b");
  });
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
  assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
});

// ---------------------------------------------------------------------------
// ai (comandos, telemetría y confirmaciones HITL)
// ---------------------------------------------------------------------------

describe("L2-08 · ai: comandos con degradación honesta, telemetría en ai_tool_calls y confirmaciones HITL", () => {
  it("(1) POST /ai/commands/scan-id-document (recepción) responde tipado sin proveedor y persiste la llamada con organizationId de A; GET /ai/tool-calls (owner, audit.read) la pagina con envelope", async () => {
    const missingImage = await call("POST", "/ai/commands/scan-id-document", reception, { propertyId: A.propertyA, payload: {} });
    assert.equal(missingImage.status, 400, missingImage.raw.slice(0, 300));
    assert.ok(typeof missingImage.body.message === "string" && missingImage.body.message.length > 0);

    const scanned = await call("POST", "/ai/commands/scan-id-document", reception, { propertyId: A.propertyA, payload: { imageDataUrl: TINY_PNG } });
    assert.equal(scanned.status, 200, scanned.raw.slice(0, 300));
    assert.ok(["manual", "ai"].includes(scanned.body.source), scanned.raw.slice(0, 200));
    if (scanned.body.configured === false) assert.match(String(scanned.body.message), /introduzca los datos manualmente/i, "degradación honesta en español");
    const rows = await prisma.aiToolCall.findMany({ where: { organizationId: A.organizationId, toolName: "scan_id_document" } });
    assert.equal(rows.length, 1, "la telemetría se persiste aunque no haya proveedor");
    assert.equal(rows[0]!.propertyId, A.propertyA);
    assert.equal(rows[0]!.userId, reception.userId);
    assert.ok(["skipped", "failed", "completed"].includes(rows[0]!.status));

    const page = await call("GET", "/ai/tool-calls?envelope=1&limit=10", owner, { propertyId: A.propertyA });
    assert.equal(page.status, 200, page.raw.slice(0, 300));
    assert.ok(Array.isArray(page.body.items));
    assert.equal(page.body.total, 1);
    assert.equal(page.body.nextCursor, null);
    assert.equal(page.headers["x-total-count"], "1");
    assert.equal(page.body.items[0].id, rows[0]!.id);
    assert.equal(page.body.items[0].organizationId, A.organizationId);
  });

  it("(2) 403 sin clave: recepción no lee la telemetría (audit.read), auditor no lanza comandos (ai.tool.execute) y contabilidad no ejecuta confirmaciones (pms.checkin.execute)", async () => {
    expect403(await call("GET", "/ai/tool-calls", reception, { propertyId: A.propertyA }), "audit.read");
    expect403(await call("POST", "/ai/commands/scan-id-document", auditor, { propertyId: A.propertyA, payload: { imageDataUrl: TINY_PNG } }), "ai.tool.execute");
    expect403(await call("POST", `/ai/confirmations/conf_l2_${RUN}/execute`, accountant, { propertyId: A.propertyA, payload: { signatureObjectKey: "sig" } }), "pms.checkin.execute");
    assert.equal(await prisma.aiToolCall.count({ where: { organizationId: A.organizationId } }), 1, "el 403 no escribe telemetría");
  });

  it("(3) 404: confirmación inexistente (tipado), recepción de A sobre B, organización B sobre A; B no ve las llamadas de A", async () => {
    expect404(await call("POST", `/ai/confirmations/conf_l2_inexistente_${RUN}/execute`, reception, { propertyId: A.propertyA, payload: { signatureObjectKey: "sig" } }), "Confirmación no encontrada.");
    expect404(await call("POST", "/ai/commands/scan-id-document", reception, { propertyId: A.propertyB, payload: { imageDataUrl: TINY_PNG } }));
    expect404(await call("GET", "/ai/tool-calls", ownerB, { propertyId: A.propertyA }));
    const pageB = await call("GET", "/ai/tool-calls?envelope=1", ownerB, { propertyId: B.propertyA });
    assert.equal(pageB.status, 200, pageB.raw.slice(0, 300));
    assert.equal(pageB.body.total, 0, "la organización B no ve la telemetría de A");
    assert.equal(await prisma.aiToolCall.count({ where: { organizationId: A.organizationId } }), 1);
  });
});

// ---------------------------------------------------------------------------
// assistant (/assistant/tools · /assistant/chat · /compliance/properties/:id/assistant)
// ---------------------------------------------------------------------------

describe("L2-08 · assistant: herramientas, chat determinista y asistente de cumplimiento con ámbito", () => {
  it("(1) GET /assistant/tools y POST /assistant/chat responden a recepción; GET /compliance/properties/:id/assistant (compliance.read) devuelve sugerencias del hotel A", async () => {
    const tools = await call("GET", "/assistant/tools", reception);
    assert.equal(tools.status, 200, tools.raw.slice(0, 300));
    assert.ok(Array.isArray(tools.body.items) && tools.body.items.length > 0);
    assert.ok(tools.body.items.every((tool: { name: string; description: string }) => typeof tool.name === "string" && typeof tool.description === "string"));

    const chat = await call("POST", "/assistant/chat", reception, { propertyId: A.propertyA, payload: { question: "¿cuántas llegadas tengo hoy?" } });
    assert.equal(chat.status, 200, chat.raw.slice(0, 300));
    assert.equal(typeof chat.body.answer, "string");
    assert.ok(Array.isArray(chat.body.toolCalls));
    assert.ok(["deterministic", "llm"].includes(chat.body.mode));

    const compliance = await call("GET", `/compliance/properties/${A.propertyA}/assistant`, reception);
    assert.equal(compliance.status, 200, compliance.raw.slice(0, 300));
    assert.equal(compliance.body.propertyId, A.propertyA);
    assert.ok(Array.isArray(compliance.body.suggestions));
  });

  it("(2) 403 sin clave / 401 sin sesión: sistemas no abre el asistente de cumplimiento (compliance.read); sin sesión las herramientas responden 401", async () => {
    expect403(await call("GET", `/compliance/properties/${A.propertyA}/assistant`, systems), "compliance.read");
    const anonymous = await call("GET", "/assistant/tools", null);
    assert.equal(anonymous.status, 401, anonymous.raw.slice(0, 300));
    const anonymousChat = await call("POST", "/assistant/chat", null, { payload: { question: "hola" } });
    assert.equal(anonymousChat.status, 401, anonymousChat.raw.slice(0, 300));
  });

  it("(3) 404 opaco: recepción de A sobre el asistente de B (ruta y cabecera del chat) y organización B sobre A", async () => {
    expect404(await call("GET", `/compliance/properties/${A.propertyB}/assistant`, reception));
    expect404(await call("POST", "/assistant/chat", reception, { propertyId: A.propertyB, payload: { question: "¿cuántas llegadas tengo hoy?" } }));
    expect404(await call("GET", `/compliance/properties/${A.propertyA}/assistant`, ownerB));
    expect404(await call("POST", "/assistant/chat", receptionB, { propertyId: A.propertyA, payload: { question: "hola" } }));
  });
});

// ---------------------------------------------------------------------------
// copilot (/copilot/presets · POST /copilot/ask)
// ---------------------------------------------------------------------------

describe("L2-08 · copilot: preguntas predefinidas y consulta con ámbito", () => {
  it("(1) GET /copilot/presets lista las preguntas y POST /copilot/ask responde una consulta del hotel A con `degraded: []`", async () => {
    const presets = await call("GET", "/copilot/presets", reception);
    assert.equal(presets.status, 200, presets.raw.slice(0, 300));
    const preset = presets.body.items.find((item: { id: string }) => item.id === "arrivals_no_clean_room");
    assert.ok(preset, "la pregunta «Llegadas sin habitación lista» existe");

    const answer = await call("POST", "/copilot/ask", reception, { payload: { propertyId: A.propertyA, question: preset.question } });
    assert.equal(answer.status, 200, answer.raw.slice(0, 300));
    assert.equal(answer.body.intent, "arrivals_no_clean_room");
    assert.equal(typeof answer.body.answer, "string");
    assert.ok(Array.isArray(answer.body.items));
    assert.deepEqual(answer.body.degraded, [], "ninguna consulta degradada en un hotel recién sembrado");
    const unknown = await call("POST", "/copilot/ask", owner, { payload: { propertyId: A.propertyA, question: "¿qué tiempo hará mañana?" } });
    assert.equal(unknown.status, 200, unknown.raw.slice(0, 300));
    assert.equal(unknown.body.intent, "unknown", "una pregunta fuera de catálogo se reconoce como tal, no se inventa");
  });

  it("(2) sin sesión → 401 en presets y en la consulta (rutas `authenticated`, sin fallback demo en modo estricto)", async () => {
    const presets = await call("GET", "/copilot/presets", null);
    assert.equal(presets.status, 401, presets.raw.slice(0, 300));
    const ask = await call("POST", "/copilot/ask", null, { payload: { propertyId: A.propertyA, question: "Resume el turno actual" } });
    assert.equal(ask.status, 401, ask.raw.slice(0, 300));
  });

  it("(3) 404 opaco: recepción de A pregunta por el hotel B y la organización B por el hotel A (propertyId en el body y en la cabecera)", async () => {
    expect404(await call("POST", "/copilot/ask", reception, { payload: { propertyId: A.propertyB, question: "Resume el turno actual" } }));
    expect404(await call("POST", "/copilot/ask", ownerB, { payload: { propertyId: A.propertyA, question: "Resume el turno actual" } }));
    expect404(await call("POST", "/copilot/ask", receptionB, { propertyId: A.propertyA, payload: { question: "Resume el turno actual" } }));
  });
});
