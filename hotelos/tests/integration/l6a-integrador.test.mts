/**
 * Tanda L6a · integrador (2026-09-19) · verificación funcional SIN clave por app.inject: organización
 * AISLADA (helpers/l2-tenant.mts) con usuarios de las plantillas de T8a (owner, general_manager,
 * receptionist, admin y, añadidos aquí, manager y maintenance) autenticados por POST /auth/login real
 * con RBAC_STRICT=true y sin unión de permisos de demo; los permisos de cada contexto del runner son
 * los REALES de GET /users/me. Faranda y org_123 solo se leen. Complementa l6a-llamadores-honestos y
 * l6a-tool-runner con lo que el integrador necesitaba ver de una pieza:
 *
 *   1 · por HTTP: asistente (mode deterministic), copiloto (reglas, degraded[], sin marca de modelo),
 *       scan-id-document (skipped), check-in por escaneo (pending → completed; con aiEnabled=false →
 *       rejected «IA desactivada en esta propiedad»), gobernanza (prompts v2, coste sin coste real,
 *       readiness provider warn, evaluación skipped), Pendientes IA;
 *   2 · runner por servicio: lectura executed con cost_eur 0 y actor ai; recepción (workorder.create
 *       sin manage) denegada por la matriz al proponer createWorkOrder (decisión risk-matrix.ts:17);
 *       mantenimiento propone → recepción confirma; escritura high → cola de revisión: aprobar en la
 *       cola NO ejecuta, confirmToolCall sí; fallo de dominio al confirmar → fila failed + 400;
 *       GET /ai/tool-calls; presupuesto 403; rate limit 429; PII con marcadores y system prompt leído
 *       de ai_prompt_versions; ciclo borrador/publicado de un prompt;
 *   3 · cliente con fetch simulado: tool use, salida estructurada, documento PDF, reintentos 429/500
 *       (no 400) y coste desde usage con caché leída.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l6a-integrador.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const helpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, enableModules, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = helpers;
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { ROLE_TEMPLATE_LABELS_ES } = await import("@hotelos/shared");
const { applyRoleTemplate, templateRoleMetadata } = await import("../../apps/api/src/lib/rbac-catalog.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { runAiTool, confirmToolCall } = await import("../../apps/api/src/modules/ai-operations/tool-runner.service.js");
const { publishPromptVersion } = await import("../../apps/api/src/modules/ai-operations/governance.service.js");
const { getAiCore, resetAiCoreForTests } = await import("../../apps/api/src/lib/ai-client.js");
const { isLlmConfigured } = await import("../../apps/api/src/lib/llm.js");
const { ForbiddenError, NotFoundError, TooManyRequestsError } = await import("../../apps/api/src/lib/http-error.js");
const { isAiError, costFromUsage, PRICING_TABLE_DATE } = await import("@hotelos/ai-core");
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST";
type Reply = { status: number; body: any; raw: string };
type Captured = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

const RUN = `l6aint${newRunId()}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const CONFIGURED_ENV = { AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-ant-l6a-integrador", AI_USD_EUR_RATE: "0.9" } as const;
const PROMPT_CODE_DRAFT = `l6a_integrador_${RUN}_draft`;
const PROMPT_CODE_PUB = `l6a_integrador_${RUN}_pub`;

const findings: string[] = [];
function note(line: string): void {
  findings.push(line);
  console.log(`[integrador] ${line}`);
}

function todayInMadrid(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function anthropicMessage(content: unknown[], model: string, usage: Record<string, number> = { input_tokens: 100, output_tokens: 50 }, stopReason = "end_turn") {
  return { id: `msg_${RUN}`, type: "message", role: "assistant", model, content, stop_reason: stopReason, usage };
}
function anthropicText(text: string, model: string, usage?: Record<string, number>) {
  return anthropicMessage([{ type: "text", text }], model, usage);
}
/** fetch simulado: una cola de respuestas (función del cuerpo o Response) y captura de cada petición. */
function fakeFetch(captured: Captured[], queue: Array<((body: Record<string, unknown>) => Response) | Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.push({ url: String(input), body, headers: (init?.headers ?? {}) as Record<string, string> });
    const next = queue.shift();
    if (next === undefined) throw new Error("sin respuesta simulada");
    return typeof next === "function" ? next(body) : next;
  }) as typeof fetch;
}

let app: ApiApp;
let A: IsolatedTenant;
let owner: Session;
let generalManager: Session;
let receptionist: Session;
let systems: Session;
let manager: Session;
let maintenance: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let toolCallsGlobalBefore = 0;
let publishedGuestReplyPrompt = "";

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
  return { status: res.statusCode, body, raw: res.body };
}

/** UserContext con los permisos REALES de la sesión (GET /users/me con RBAC_STRICT, sin unión demo). */
async function contextFor(session: Session, propertyId: string): Promise<UserContext> {
  const me = await call("GET", "/users/me", session, { propertyId });
  assert.equal(me.status, 200, me.raw.slice(0, 200));
  const permissions = (me.body.permissions ?? []) as UserContext["permissions"];
  assert.ok(Array.isArray(permissions) && permissions.length > 0, `sin permisos en /users/me para ${session.email}`);
  return { organizationId: A.organizationId, propertyId, userId: session.userId, fullName: `T8a ${session.email}`, deviceId: `dev_${RUN}`, permissions };
}

async function addTemplateUser(local: string, templateKey: string, propertyId: string): Promise<{ id: string; email: string }> {
  const roleId =
    A.roles[templateKey] ??
    (
      await prisma.role.create({
        data: { organizationId: A.organizationId, name: ROLE_TEMPLATE_LABELS_ES[templateKey as keyof typeof ROLE_TEMPLATE_LABELS_ES], templateKey, ...templateRoleMetadata(templateKey as never) },
        select: { id: true }
      })
    ).id;
  if (!A.roles[templateKey]) await applyRoleTemplate(roleId, templateKey as never);
  const id = `usr_l2_${local}_${RUN}`;
  const email = `${local}.l2.${RUN}@faranda.test`;
  await prisma.user.create({ data: { id, organizationId: A.organizationId, email, fullName: `${templateKey} L6a`, status: "active", passwordHash: hashPassword(A.password), mustChangePassword: false, passwordChangedAt: new Date() } });
  await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId, organizationId: A.organizationId, reason: `l6a integrador ${RUN}` } });
  resetRbacScopeCacheForTests();
  return { id, email };
}

async function auditsFor(entityId: string): Promise<Array<{ action: string; actorType: string }>> {
  await flushAuditQueues();
  return prisma.auditEvent.findMany({ where: { organizationId: A.organizationId, entityType: "ai_tool_call", entityId }, select: { action: true, actorType: true }, orderBy: { createdAt: "asc" } });
}

async function createReservation(suffix: string, propertyId: string, roomTypeId: string, ratePlanId: string): Promise<{ reservationId: string; documentNumber: string; firstName: string; surname1: string }> {
  const documentNumber = `L6${RUN.slice(-5).toUpperCase()}${suffix}`;
  const firstName = `Prueba${suffix}${RUN}`;
  const surname1 = `Ensayo${RUN}`;
  const guest = await prisma.guest.create({
    data: { organizationId: A.organizationId, firstName, surname1, documentType: "DNI", documentNumber, nationality: "ESP", dateOfBirth: new Date("1985-04-12T00:00:00.000Z") },
    select: { id: true }
  });
  const reservation = await prisma.reservation.create({
    data: {
      propertyId,
      code: `L6A-${suffix}-${RUN}`,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date(`${todayInMadrid()}T00:00:00.000Z`),
      departureDate: new Date(`${todayInMadrid(2)}T00:00:00.000Z`),
      adults: 1,
      roomTypeId,
      ratePlanId,
      currency: "EUR",
      bookerName: `${firstName} ${surname1}`
    },
    select: { id: true }
  });
  await prisma.reservationGuest.create({ data: { reservationId: reservation.id, guestId: guest.id, isPrimary: true } });
  return { reservationId: reservation.id, documentNumber, firstName, surname1 };
}

before(async () => {
  assert.equal(isLlmConfigured(), false, "esta verificación exige que NO haya clave de proveedor en el .env del worktree");
  invariantsBefore = await farandaInvariants();
  toolCallsGlobalBefore = await prisma.aiToolCall.count();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["reputation_quality", "ai_concierge"]);
  // Fusión L5×L6a (mismo arreglo que l2-persistencia-plataforma, corrector L5): desde L5-B2 el
  // pipeline SES responde 409 SES_DISABLED con el interruptor apagado (CS-01: OR de
  // properties.ses_hospedajes_enabled y property_compliance_settings.ses_hospedajes_enabled), código
  // que executeConfirmation (modules/ai, L6a) no tolera todavía; el tenant aislado nace apagado, así
  // que se enciende aquí y el parte lleva teléfono y residencia (el validador va antes que el
  // establecimiento) para que el flujo llegue al 409 SES_ESTABLISHMENT_INCOMPLETE tolerado (aviso).
  await prisma.property.update({ where: { id: A.propertyA }, data: { sesHospedajesEnabled: true } });
  await prisma.propertyComplianceSetting.upsert({
    where: { propertyId: A.propertyA },
    create: { propertyId: A.propertyA, country: "ES", sesHospedajesEnabled: true },
    update: { sesHospedajesEnabled: true }
  });
  const managerUser = await addTemplateUser("manager", "manager", A.propertyA);
  const maintenanceUser = await addTemplateUser("maintenance", "maintenance", A.propertyA);
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, A.users.owner.email, A.password, "l6a-int-owner");
    generalManager = await loginOrThrow(app, A.users.generalManager.email, A.password, "l6a-int-gm");
    receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password, "l6a-int-reception");
    systems = await loginOrThrow(app, A.users.systems.email, A.password, "l6a-int-systems");
    manager = await loginOrThrow(app, managerUser.email, A.password, "l6a-int-manager");
    maintenance = await loginOrThrow(app, maintenanceUser.email, A.password, "l6a-int-maintenance");
  });
  const v2 = await prisma.aiPromptVersion.findFirst({ where: { promptCode: "guest_message_reply", status: "published" }, select: { content: true, version: true } });
  assert.ok(v2, "la BD debe tener guest_message_reply publicado (semilla v2)");
  publishedGuestReplyPrompt = v2.content;
  note(`organización aislada ${A.organizationId}; prompt publicado guest_message_reply ${v2.version} (${v2.content.length} caracteres)`);
});

after(async () => {
  resetAiCoreForTests();
  try {
    await flushAuditQueues();
    await prisma.aiPromptVersion.deleteMany({ where: { promptCode: { in: [PROMPT_CODE_DRAFT, PROMPT_CODE_PUB] } } });
    if (A) await cleanupTenant(A.organizationId);
  } finally {
    await app?.close();
  }
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  assert.equal(await prisma.organization.count({ where: { id: A.organizationId } }), 0, "sin organización residual");
  assert.equal(await prisma.aiToolCall.count({ where: { organizationId: A.organizationId } }), 0, "sin filas ai_tool_calls residuales");
  assert.equal(await prisma.aiPromptVersion.count({ where: { promptCode: { startsWith: "l6a_integrador_" } } }), 0, "sin versiones de prompt residuales");
  const toolCallsGlobalAfter = await prisma.aiToolCall.count();
  note(`ai_tool_calls globales antes ${toolCallsGlobalBefore} · después ${toolCallsGlobalAfter} (la diferencia, si la hay, es de otras sesiones sobre la BD compartida)`);
  console.log("\n[integrador] RESUMEN\n" + findings.map((line) => ` - ${line}`).join("\n"));
});

// ---------------------------------------------------------------------------
describe("1 · Sin clave, por HTTP, como usuarios de las plantillas T8a: etiquetas honestas y nada simulado", () => {
  it("asistente: GET /assistant/tools y POST /assistant/chat → mode deterministic (nunca llm) y fila answerAnalyticsQuestion", async () => {
    const tools = await call("GET", "/assistant/tools", receptionist, { propertyId: A.propertyA });
    assert.equal(tools.status, 200, tools.raw.slice(0, 200));
    assert.ok(Array.isArray(tools.body.items) && tools.body.items.length >= 5);
    const chat = await call("POST", "/assistant/chat", receptionist, { propertyId: A.propertyA, payload: { question: "¿cuántas llegadas tengo hoy?" } });
    assert.equal(chat.status, 200, chat.raw.slice(0, 300));
    assert.equal(chat.body.mode, "deterministic");
    assert.ok(!JSON.stringify(chat.body).includes('"llm"'));
    assert.equal(typeof chat.body.answer, "string");
    const deadline = Date.now() + 3000;
    let rows: Array<{ status: string; model: string | null; costEur: unknown }> = [];
    while (Date.now() < deadline) {
      rows = await prisma.aiToolCall.findMany({ where: { organizationId: A.organizationId, toolName: "answerAnalyticsQuestion" } });
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "succeeded");
    assert.equal(rows[0]!.model, null);
    note(`asistente: mode=${chat.body.mode}, ${tools.body.items.length} herramientas, fila answerAnalyticsQuestion succeeded sin modelo`);
  });

  it("copiloto: GET /copilot/presets (10) y POST /copilot/ask → respuesta por reglas con degraded[] y sin ninguna marca de modelo", async () => {
    const presets = await call("GET", "/copilot/presets", receptionist, { propertyId: A.propertyA });
    assert.equal(presets.status, 200);
    assert.equal(presets.body.items.length, 10);
    const ask = await call("POST", "/copilot/ask", receptionist, { propertyId: A.propertyA, payload: { propertyId: A.propertyA, question: "Resume el turno actual" } });
    assert.equal(ask.status, 200, ask.raw.slice(0, 300));
    assert.equal(ask.body.intent, "shift_summary");
    assert.ok(Array.isArray(ask.body.degraded));
    assert.ok(!("mode" in ask.body) && !("model" in ask.body), "el copiloto no anuncia ningún modelo");
    assert.ok(!/llm|modelo de lenguaje|claude/i.test(ask.raw), "sin marcas de modelo en la respuesta");
    const unknown = await call("POST", "/copilot/ask", receptionist, { propertyId: A.propertyA, payload: { question: "¿me escribes un poema?" } });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.intent, "unknown");
    assert.equal(unknown.body.source, "router");
    note(`copiloto: intent=${ask.body.intent} source=${ask.body.source} degraded=${JSON.stringify(ask.body.degraded)}; pregunta fuera de catálogo → intent unknown, source router`);
  });

  it("escaneo de DNI: POST /ai/commands/scan-id-document → configured:false, source manual, «introduzca los datos manualmente», fila skipped sin imagen", async () => {
    const scanned = await call("POST", "/ai/commands/scan-id-document", receptionist, { propertyId: A.propertyA, payload: { imageDataUrl: PNG } });
    assert.equal(scanned.status, 200, scanned.raw.slice(0, 300));
    assert.equal(scanned.body.configured, false);
    assert.equal(scanned.body.source, "manual");
    assert.match(String(scanned.body.message), /introduzca los datos manualmente/i);
    const row = await prisma.aiToolCall.findFirstOrThrow({ where: { organizationId: A.organizationId, toolName: "scan_id_document" } });
    assert.equal(row.status, "skipped");
    assert.equal(row.model, null);
    assert.ok(!JSON.stringify(row.inputJson).includes("base64"));
    note(`scan-id-document: configured=false, message «${scanned.body.message}», fila ${row.status}`);
  });

  it("comando de check-in por escaneo (recepción): confirmation_required → pending; execute → completed con auditoría AI_TOOL_EXECUTED (actor ai); con la IA apagada en la propiedad → rejected con la etiqueta «IA desactivada en esta propiedad»", async () => {
    const res1 = await createReservation("A", A.propertyA, A.roomTypeA, A.ratePlanA);
    const payload = (r: typeof res1) => ({
      propertyId: A.propertyA,
      transcript: "check-in en la 101",
      roomNumber: "101",
      documentExtractedFields: { firstName: r.firstName, surname1: r.surname1, documentType: "DNI", documentNumber: r.documentNumber, documentSupportNumber: "ABC123456", nationality: "ESP", dateOfBirth: "1985-04-12", sex: "F", mobilePhone: "+34600000001", residenceAddress: "Calle Real 1", residenceLocality: "A Coruña", residenceCountry: "ESP" },
      documentImageStored: false,
      idImageDiscarded: true
    });
    const created = await call("POST", "/ai/commands/check-in-from-scan", receptionist, { propertyId: A.propertyA, payload: payload(res1) });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    assert.equal(created.body.status, "confirmation_required", created.raw.slice(0, 300));
    const confirmationId = created.body.confirmationId as string;
    const pendingRow = await prisma.aiToolCall.findFirstOrThrow({ where: { organizationId: A.organizationId, toolName: "checkInReservation", outputJson: { path: ["confirmationId"], equals: confirmationId } } });
    assert.equal(pendingRow.status, "pending");
    assert.equal(pendingRow.requiredConfirmation, true);
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: res1.reservationId } })).status, "confirmed", "nada se ejecuta antes de confirmar");

    const executed = await call("POST", `/ai/confirmations/${confirmationId}/execute`, receptionist, { propertyId: A.propertyA, payload: { signatureObjectKey: `sig_${RUN}` } });
    assert.equal(executed.status, 200, executed.raw.slice(0, 300));
    assert.equal(executed.body.status, "executed");
    assert.ok((executed.body.warnings ?? []).some((line: string) => /Parte SES no enviado: faltan datos del establecimiento/.test(line)), `aviso SES esperado (establecimiento aislado sin perfil): ${executed.raw.slice(0, 300)}`);
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: res1.reservationId } })).status, "checked_in");
    const doneRow = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: pendingRow.id } });
    assert.equal(doneRow.status, "completed");
    assert.equal(doneRow.confirmedBy, receptionist.userId);
    const audits = await auditsFor(pendingRow.id);
    assert.ok(audits.some((event) => event.action === "AI_TOOL_EXECUTED" && event.actorType === "ai"), JSON.stringify(audits));

    // IA apagada en la propiedad → el comando se deniega ANTES de escribir nada (parte de viajeros incluido).
    await prisma.propertyAiSetting.upsert({ where: { propertyId: A.propertyA }, create: { propertyId: A.propertyA, aiEnabled: false, voiceLocales: ["es-ES"] }, update: { aiEnabled: false } });
    try {
      const res2 = await createReservation("B", A.propertyA, A.roomTypeA, A.ratePlanA);
      const registersBefore = await prisma.guestRegisterRecord.count({ where: { reservationId: res2.reservationId } });
      const denied = await call("POST", "/ai/commands/check-in-from-scan", receptionist, { propertyId: A.propertyA, payload: { ...payload(res2), roomNumber: "102" } });
      assert.equal(denied.status, 200, denied.raw.slice(0, 300));
      assert.equal(denied.body.status, "rejected");
      assert.match(String(denied.body.errors?.[0]), /IA desactivada en esta propiedad/);
      assert.equal(await prisma.guestRegisterRecord.count({ where: { reservationId: res2.reservationId } }), registersBefore, "sin parte de viajeros al denegar");
      const deniedRow = await prisma.aiToolCall.findFirstOrThrow({ where: { organizationId: A.organizationId, toolName: "checkInReservation", status: "rejected" } });
      assert.equal(deniedRow.errorMessage, "ai_disabled_for_property");
      const deniedAudits = await auditsFor(deniedRow.id);
      assert.deepEqual(deniedAudits, [{ action: "AI_TOOL_DENIED", actorType: "ai" }]);
      note(`check-in: pending → completed (executed ${executed.body.reservationId}); con aiEnabled=false → rejected «${denied.body.errors[0]}» + AI_TOOL_DENIED`);
    } finally {
      await prisma.propertyAiSetting.update({ where: { propertyId: A.propertyA }, data: { aiEnabled: true } });
    }
  });

  it("gobernanza: prompts (guest_message_reply v2 publicado), políticas, coste sin coste real, readiness provider «Sin modelo configurado», evaluación skipped, dashboard coste 0", async () => {
    const prompts = await call("GET", "/ai-operations/governance/prompts", generalManager, { propertyId: A.propertyA });
    assert.equal(prompts.status, 200, prompts.raw.slice(0, 200));
    const guestReply = (prompts.body as Array<{ promptCode: string; currentPublishedVersion?: string }>).find((group) => group.promptCode === "guest_message_reply");
    assert.equal(guestReply?.currentPublishedVersion, "v2");
    const policies = await call("GET", "/ai-operations/governance/policies", generalManager, { propertyId: A.propertyA });
    assert.equal(policies.status, 200, policies.raw.slice(0, 200));
    const cost = await call("GET", "/ai-operations/governance/cost", owner, { propertyId: A.propertyA });
    assert.equal(cost.status, 200, cost.raw.slice(0, 200));
    assert.equal(cost.body.hasRealCost, false);
    assert.equal(cost.body.projectedMonthlyEur, null);
    assert.equal(cost.body.totalCostEur, 0);
    const readiness = await call("GET", `/ai-operations/property/readiness?propertyId=${A.propertyA}`, owner, { propertyId: A.propertyA });
    assert.equal(readiness.status, 200, readiness.raw.slice(0, 200));
    const provider = readiness.body.checks.find((check: { key: string }) => check.key === "provider");
    assert.equal(provider.status, "warn");
    assert.match(provider.detail, /Sin modelo configurado/);
    assert.equal(readiness.body.ready, false);
    const evaluation = await call("POST", "/ai-operations/governance/evaluations", systems, { propertyId: A.propertyA, payload: { evaluationName: `Integrador ${RUN}`, evaluationType: "safety", promptCode: "guest_message_reply" } });
    assert.equal(evaluation.status, 200, evaluation.raw.slice(0, 200));
    const ran = await call("POST", `/ai-operations/governance/evaluations/${evaluation.body.id}/run`, systems, { propertyId: A.propertyA });
    assert.equal(ran.status, 200, ran.raw.slice(0, 300));
    assert.equal(ran.body.status, "skipped");
    assert.match(String(ran.body.results.reason), /No hay proveedor de IA configurado/);
    const dashboard = await call("GET", `/ai-operations/pipeline/dashboard?propertyId=${A.propertyA}`, owner, { propertyId: A.propertyA });
    assert.equal(dashboard.status, 200, dashboard.raw.slice(0, 200));
    assert.equal(dashboard.body.kpis.costMtdEur, 0);
    note(`gobernanza: prompts ${prompts.body.length} códigos (guest_message_reply → ${guestReply?.currentPublishedVersion}); cost hasRealCost=${cost.body.hasRealCost} projectedMonthlyEur=${cost.body.projectedMonthlyEur}; readiness provider=${provider.status} «${provider.detail}» ready=${readiness.body.ready}; evaluación ${ran.body.status} «${ran.body.results.reason}»; dashboard costMtdEur=${dashboard.body.kpis.costMtdEur}`);
  });

  it("pendientes IA: GET /ai-operations/review/queue y /stats responden (cola vacía al empezar)", async () => {
    const queue = await call("GET", "/ai-operations/review/queue", owner, { propertyId: A.propertyA });
    assert.equal(queue.status, 200, queue.raw.slice(0, 200));
    assert.ok(Array.isArray(queue.body));
    assert.equal(queue.body.length, 0);
    const stats = await call("GET", "/ai-operations/review/stats", owner, { propertyId: A.propertyA });
    assert.equal(stats.status, 200, stats.raw.slice(0, 200));
    note(`pendientes IA: cola ${queue.body.length} ítems; stats ${JSON.stringify(stats.body).slice(0, 120)}`);
  });
});

// ---------------------------------------------------------------------------
describe("2 · Tool runner por servicio y por HTTP (POST /ai/tool-calls/:id/confirm, cableada en la fusión)", () => {
  let receptionCtx: UserContext;
  let maintenanceCtx: UserContext;
  let managerCtx: UserContext;
  let workOrdersBefore = 0;
  let pendingWorkOrderCall = "";
  let blockCallId = "";
  let reviewItemId = "";

  before(async () => {
    receptionCtx = await contextFor(receptionist, A.propertyA);
    maintenanceCtx = await contextFor(maintenance, A.propertyA);
    managerCtx = await contextFor(manager, A.propertyA);
    workOrdersBefore = await prisma.workOrder.count({ where: { propertyId: A.propertyA } });
    note(`permisos reales: recepción ${receptionCtx.permissions.length} claves (workorder.create=${receptionCtx.permissions.includes("maintenance.workorder.create")}, manage=${receptionCtx.permissions.includes("maintenance.workorder.manage")}, high_risk=${receptionCtx.permissions.includes("ai.high_risk.confirm")}); mantenimiento ${maintenanceCtx.permissions.length}; dirección de hotel ${managerCtx.permissions.length} (high_risk=${managerCtx.permissions.includes("ai.high_risk.confirm")})`);
  });

  it("lectura (getHousekeepingBoard, findReservation) como recepción → executed al instante; fila succeeded con cost_eur 0, model null y auditoría AI_TOOL_EXECUTED actor ai", async () => {
    const board = await runAiTool({ context: receptionCtx, toolName: "getHousekeepingBoard", input: {}, correlationId: `corr_${RUN}_board` });
    assert.equal(board.status, "executed", JSON.stringify(board));
    if (board.status !== "executed") return;
    assert.equal(board.configured, true, "una lectura Prisma no depende del modelo: configured=true (la fila lleva model null y cost_eur 0)");
    assert.ok(Array.isArray(board.output));
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: board.toolCallId } });
    assert.equal(row.status, "succeeded");
    assert.equal(Number(row.costEur), 0);
    assert.equal(row.model, null);
    assert.equal(row.tokensInput, 0);
    assert.equal(row.userId, receptionist.userId);
    assert.deepEqual(await auditsFor(row.id), [{ action: "AI_TOOL_EXECUTED", actorType: "ai" }]);

    const found = await runAiTool({ context: receptionCtx, toolName: "findReservation", input: { code: `L6A-A-${RUN}` }, correlationId: `corr_${RUN}_find` });
    assert.equal(found.status, "executed", JSON.stringify(found));
    note(`lectura: getHousekeepingBoard executed (${(board.output as unknown[]).length} habitaciones), fila succeeded cost_eur=${row.costEur} model=${row.model}; findReservation executed`);
  });

  it("escritura (createWorkOrder) propuesta por recepción (workorder.create sin manage) → resultado de la matriz de riesgo (create_maintenance_task exige manage)", async () => {
    const result = await runAiTool({ context: receptionCtx, toolName: "createWorkOrder", input: { title: `Recepción propone ${RUN}`, priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_wo_rec` });
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), workOrdersBefore, "nunca se ejecuta sin confirmar");
    note(`createWorkOrder por recepción: status=${result.status}${result.status === "denied" ? ` reason=${result.reason} «${result.message}»` : ""} (decisión abierta risk-matrix.ts:17)`);
    assert.ok(["awaiting_confirmation", "denied"].includes(result.status));
  });

  it("escritura (createWorkOrder) propuesta por mantenimiento → awaiting_confirmation (nada escrito); recepción la confirma → work_orders +1, fila succeeded, auditorías ai/user/ai", async () => {
    const pending = await runAiTool({ context: maintenanceCtx, toolName: "createWorkOrder", input: { title: `Grifo que gotea ${RUN}`, roomNumber: "101", priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_wo` });
    assert.equal(pending.status, "awaiting_confirmation", JSON.stringify(pending));
    if (pending.status !== "awaiting_confirmation") return;
    pendingWorkOrderCall = pending.toolCallId;
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), workOrdersBefore, "nada se ejecuta antes de confirmar");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: pending.toolCallId } });
    assert.equal(row.status, "awaiting_confirmation");
    assert.equal(row.requiredConfirmation, true);
    assert.equal(Number(row.costEur), 0);
    assert.deepEqual(await auditsFor(row.id), [{ action: "AI_TOOL_CONFIRMATION_REQUESTED", actorType: "ai" }]);

    const confirmed = await confirmToolCall({ context: receptionCtx, toolCallId: pending.toolCallId, decision: "approve", notes: "Confirmado en recepción", correlationId: `corr_${RUN}_wo_ok` });
    assert.equal(confirmed.status, "succeeded", JSON.stringify(confirmed));
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), workOrdersBefore + 1);
    const done = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: pending.toolCallId } });
    assert.equal(done.status, "succeeded");
    assert.equal(done.confirmedBy, receptionist.userId);
    const audits = await auditsFor(pending.toolCallId);
    assert.deepEqual(audits.map((event) => `${event.action}:${event.actorType}`), ["AI_TOOL_CONFIRMATION_REQUESTED:ai", "AI_TOOL_CONFIRMATION_APPROVED:user", "AI_TOOL_EXECUTED:ai"]);
    await assert.rejects(confirmToolCall({ context: receptionCtx, toolCallId: pending.toolCallId, decision: "approve", correlationId: `corr_${RUN}_replay` }), (error: unknown) => error instanceof NotFoundError);
    note(`escritura: createWorkOrder awaiting_confirmation → confirm por recepción → succeeded (work_orders ${workOrdersBefore} → ${workOrdersBefore + 1}); segunda confirmación → 404 opaco`);
  });

  it("escritura high (blockRoomForMaintenance) por dirección → awaiting + revisión humana visible en GET /ai-operations/review/queue; recepción no puede confirmar (403 AI_TOOL_CONFIRM_FORBIDDEN); aprobar en la cola NO ejecuta; confirmToolCall sí", async () => {
    const order = await prisma.workOrder.findFirstOrThrow({ where: { propertyId: A.propertyA, title: `Grifo que gotea ${RUN}` }, select: { id: true } });
    const pending = await runAiTool({ context: managerCtx, toolName: "blockRoomForMaintenance", input: { workOrderId: order.id }, correlationId: `corr_${RUN}_block` });
    assert.equal(pending.status, "awaiting_confirmation", JSON.stringify(pending));
    if (pending.status !== "awaiting_confirmation") return;
    blockCallId = pending.toolCallId;

    const queue = await call("GET", "/ai-operations/review/queue?status=pending", owner, { propertyId: A.propertyA });
    assert.equal(queue.status, 200, queue.raw.slice(0, 200));
    const item = (queue.body as Array<{ id: string; relatedEntityId: string; relatedEntityType: string; status: string }>).find((entry) => entry.relatedEntityId === blockCallId);
    assert.ok(item, "la propuesta high aparece en Pendientes IA");
    assert.equal(item.relatedEntityType, "ai_tool_call");
    assert.equal(item.status, "pending");
    reviewItemId = item.id;

    await assert.rejects(confirmToolCall({ context: receptionCtx, toolCallId: blockCallId, decision: "approve", correlationId: `corr_${RUN}_block_rec` }), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError, String(error));
      assert.equal((error.details as { code: string }).code, "AI_TOOL_CONFIRM_FORBIDDEN");
      return true;
    });
    assert.equal((await prisma.aiToolCall.findUniqueOrThrow({ where: { id: blockCallId } })).status, "awaiting_confirmation");

    const approved = await call("POST", `/ai-operations/review/${reviewItemId}/approve`, generalManager, { propertyId: A.propertyA, payload: { notes: "Aprobado desde Pendientes IA" } });
    assert.equal(approved.status, 200, approved.raw.slice(0, 300));
    assert.equal((await prisma.aiToolCall.findUniqueOrThrow({ where: { id: blockCallId } })).status, "awaiting_confirmation", "aprobar en la cola no ejecuta la herramienta");
    assert.equal((await prisma.workOrder.findUniqueOrThrow({ where: { id: order.id } })).blocksRoom, false);

    const executed = await confirmToolCall({ context: managerCtx, toolCallId: blockCallId, decision: "approve", correlationId: `corr_${RUN}_block_ok` });
    assert.equal(executed.status, "succeeded", JSON.stringify(executed));
    assert.equal((await prisma.workOrder.findUniqueOrThrow({ where: { id: order.id } })).blocksRoom, true, "solo la confirmación ejecuta");
    assert.equal((await prisma.aiHumanReviewItem.findUniqueOrThrow({ where: { id: reviewItemId } })).status, "approved");
    const closed = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: blockCallId } });
    assert.equal(closed.status, "succeeded");
    assert.equal(closed.confirmedBy, manager.userId);
    note(`escritura high: blockRoomForMaintenance awaiting + revisión ${reviewItemId} en la cola; recepción → 403 AI_TOOL_CONFIRM_FORBIDDEN; approve en la cola deja la fila awaiting; confirmToolCall por dirección → succeeded (blocksRoom=true)`);
  });

  it("confirmación cuya ejecución falla en el dominio (bloquear un parte sin habitación) → la fila queda failed y el error de dominio (400) se propaga; nada se ejecuta", async () => {
    const noRoom = await runAiTool({ context: maintenanceCtx, toolName: "createWorkOrder", input: { title: `Sin habitación ${RUN}`, priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_wo_noroom` });
    assert.equal(noRoom.status, "awaiting_confirmation", JSON.stringify(noRoom));
    if (noRoom.status !== "awaiting_confirmation") return;
    const created = await confirmToolCall({ context: receptionCtx, toolCallId: noRoom.toolCallId, decision: "approve", correlationId: `corr_${RUN}_wo_noroom_ok` });
    assert.equal(created.status, "succeeded", JSON.stringify(created));
    const orderId = (created.status === "succeeded" ? (created.output as { id: string }).id : "");
    const block = await runAiTool({ context: managerCtx, toolName: "blockRoomForMaintenance", input: { workOrderId: orderId }, correlationId: `corr_${RUN}_block_noroom` });
    assert.equal(block.status, "awaiting_confirmation", JSON.stringify(block));
    if (block.status !== "awaiting_confirmation") return;
    await assert.rejects(confirmToolCall({ context: managerCtx, toolCallId: block.toolCallId, decision: "approve", correlationId: `corr_${RUN}_block_noroom_ok` }), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.match(String((error as Error).message), /no está vinculada a ninguna habitación/);
      return true;
    });
    const failed = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: block.toolCallId } });
    assert.equal(failed.status, "failed");
    assert.match(String(failed.errorMessage), /no está vinculada/);
    assert.ok((await auditsFor(block.toolCallId)).some((event) => event.action === "AI_TOOL_FAILED" && event.actorType === "ai"));
    note(`confirmación con fallo de dominio: fila ${failed.status} «${failed.errorMessage}», AI_TOOL_FAILED (actor ai), error 400 propagado al llamador`);
  });

  it("GET /ai/tool-calls (owner, audit.read) lista las filas del runner con envelope", async () => {
    const listed = await call("GET", "/ai/tool-calls?envelope=1&limit=50", owner, { propertyId: A.propertyA });
    assert.equal(listed.status, 200, listed.raw.slice(0, 200));
    const names = new Set((listed.body.items as Array<{ toolName: string; status: string }>).map((row) => `${row.toolName}:${row.status}`));
    for (const expected of ["getHousekeepingBoard:succeeded", "createWorkOrder:succeeded", "blockRoomForMaintenance:succeeded", "checkInReservation:completed", "scan_id_document:skipped"]) assert.ok(names.has(expected), `${expected} no aparece en ${[...names].join(", ")}`);
    note(`GET /ai/tool-calls: ${listed.body.total} filas de la organización (${[...names].join(", ")})`);
  });

  it("POST /ai/tool-calls/:id/confirm (ai.tool.execute, riesgo high): decisión inválida → 400 sin tocar la fila; approve por recepción → 200 succeeded y work_orders +1; la misma fila otra vez → 404 opaco; reject → 200 rejected sin escribir; id ajeno → 404", async () => {
    const before = await prisma.workOrder.count({ where: { propertyId: A.propertyA } });
    const proposed = await runAiTool({ context: maintenanceCtx, toolName: "createWorkOrder", input: { title: `Confirmación por HTTP ${RUN}`, roomNumber: "101", priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_wo_http` });
    assert.equal(proposed.status, "awaiting_confirmation", JSON.stringify(proposed));
    if (proposed.status !== "awaiting_confirmation") return;
    const path = `/ai/tool-calls/${proposed.toolCallId}/confirm`;

    const invalid = await call("POST", path, receptionist, { propertyId: A.propertyA, payload: { decision: "maybe" } });
    assert.equal(invalid.status, 400, invalid.raw.slice(0, 200));
    assert.equal((await prisma.aiToolCall.findUniqueOrThrow({ where: { id: proposed.toolCallId } })).status, "awaiting_confirmation");

    const approved = await call("POST", path, receptionist, { propertyId: A.propertyA, payload: { decision: "approve", notes: "Aprobado por HTTP" } });
    assert.equal(approved.status, 200, approved.raw.slice(0, 300));
    assert.equal(approved.body.status, "succeeded");
    assert.equal(approved.body.toolCallId, proposed.toolCallId);
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), before + 1);
    const done = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: proposed.toolCallId } });
    assert.equal(done.status, "succeeded");
    assert.equal(done.confirmedBy, receptionist.userId);

    const replay = await call("POST", path, receptionist, { propertyId: A.propertyA, payload: { decision: "approve" } });
    assert.equal(replay.status, 404, replay.raw.slice(0, 200));
    const unknown = await call("POST", `/ai/tool-calls/atc_no_existe_${RUN}/confirm`, receptionist, { propertyId: A.propertyA, payload: { decision: "approve" } });
    assert.equal(unknown.status, 404, unknown.raw.slice(0, 200));

    const declined = await runAiTool({ context: maintenanceCtx, toolName: "createWorkOrder", input: { title: `Rechazo por HTTP ${RUN}`, roomNumber: "101", priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_wo_http_no` });
    assert.equal(declined.status, "awaiting_confirmation", JSON.stringify(declined));
    if (declined.status !== "awaiting_confirmation") return;
    const rejected = await call("POST", `/ai/tool-calls/${declined.toolCallId}/confirm`, receptionist, { propertyId: A.propertyA, payload: { decision: "reject", notes: "No procede" } });
    assert.equal(rejected.status, 200, rejected.raw.slice(0, 300));
    assert.equal(rejected.body.status, "rejected");
    assert.equal((await prisma.aiToolCall.findUniqueOrThrow({ where: { id: declined.toolCallId } })).status, "rejected");
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), before + 1, "rechazar no escribe");
    note(`POST /ai/tool-calls/:id/confirm: decision inválida → ${invalid.status}; approve → ${approved.status} ${approved.body.status} (work_orders ${before} → ${before + 1}); repetición → ${replay.status}; id inexistente → ${unknown.status}; reject → ${rejected.status} ${rejected.body.status}`);
  });

  it("presupuesto agotado (monthlyBudgetEur 0,01 + gasto 0,02) → 403 AI_BUDGET_EXCEEDED sin ejecutar y con fila rejected", async () => {
    await prisma.propertyAiSetting.update({ where: { propertyId: A.propertyA }, data: { configurationJson: { monthlyBudgetEur: 0.01 } } });
    const seed = await prisma.aiToolCall.create({ data: { organizationId: A.organizationId, propertyId: A.propertyA, toolName: `l6a_budget_seed_${RUN}`, status: "succeeded", inputJson: {}, model: "claude-sonnet-5", costEur: 0.02 } });
    try {
      let executed = 0;
      await assert.rejects(runAiTool({ context: receptionCtx, toolName: "findReservation", input: { code: `L6A-A-${RUN}` }, execute: async () => (executed += 1), correlationId: `corr_${RUN}_budget` }), (error: unknown) => {
        assert.ok(error instanceof ForbiddenError, String(error));
        const details = error.details as { code: string; budgetEur: number; spentEur: number };
        assert.equal(details.code, "AI_BUDGET_EXCEEDED");
        assert.equal(details.budgetEur, 0.01);
        assert.equal(details.spentEur, 0.02);
        return true;
      });
      assert.equal(executed, 0);
      assert.ok(await prisma.aiToolCall.findFirst({ where: { organizationId: A.organizationId, toolName: "findReservation", status: "rejected", errorMessage: "budget_exceeded" } }));
      note("presupuesto: 403 AI_BUDGET_EXCEEDED { budgetEur 0.01, spentEur 0.02 }, execute no invocado, fila rejected budget_exceeded");
    } finally {
      await prisma.aiToolCall.delete({ where: { id: seed.id } });
      await prisma.propertyAiSetting.update({ where: { propertyId: A.propertyA }, data: { configurationJson: {} } });
    }
  });

  it("rate limit (AI_RATE_LIMIT_PER_MINUTE=1, fetch simulado): analyzeReviewSentiment por recepción → executed con coste real (Haiku); la segunda → 429 AI_RATE_LIMITED con retryAfterSeconds", async () => {
    const captured: Captured[] = [];
    const sentiment = JSON.stringify({ categories: [{ code: "ruido", sentiment: -1, confidence: 0.9, snippet: "ruido de la calle" }], language: "es", summary: "Queja por el ruido nocturno." });
    resetAiCoreForTests({ env: { ...CONFIGURED_ENV, AI_RATE_LIMIT_PER_MINUTE: "1" }, fetchImpl: fakeFetch(captured, [(body) => json(200, anthropicText(sentiment, String(body.model))), (body) => json(200, anthropicText(sentiment, String(body.model)))]) });
    const first = await runAiTool({ context: receptionCtx, toolName: "analyzeReviewSentiment", input: { text: "Mucho ruido de la calle por la noche." }, correlationId: `corr_${RUN}_rl1` });
    assert.equal(first.status, "executed", JSON.stringify(first));
    if (first.status !== "executed") return;
    assert.equal(captured[0]!.body.model, "claude-haiku-4-5-20251001");
    assert.deepEqual((captured[0]!.body.output_config as { format: { type: string } }).format.type, "json_schema", "clasificación con salida estructurada");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: first.toolCallId } });
    assert.equal(row.status, "succeeded");
    assert.equal(Number(row.costEur), 0.000315);
    await assert.rejects(runAiTool({ context: receptionCtx, toolName: "analyzeReviewSentiment", input: { text: "Segunda reseña." }, correlationId: `corr_${RUN}_rl2` }), (error: unknown) => {
      assert.ok(error instanceof TooManyRequestsError, String(error));
      assert.equal(error.statusCode, 429);
      const details = error.details as { code?: string; retryAfterSeconds?: number };
      assert.equal(details.code, "AI_RATE_LIMITED");
      assert.ok(typeof details.retryAfterSeconds === "number" && details.retryAfterSeconds >= 1, JSON.stringify(details));
      return true;
    });
    assert.equal(captured.length, 1, "el límite se aplica antes del segundo fetch");
    note(`rate limit: 1.ª analyzeReviewSentiment executed (claude-haiku-4-5-20251001, cost_eur ${row.costEur}); 2.ª → 429 AI_RATE_LIMITED, fetch no invocado`);
  });

  it("PII: answerGuestQuestion con un texto INVENTADO → el proveedor recibe marcadores ([NOMBRE_1], [DOC_1], [TEL_1], [EMAIL_1], [TARJETA_1]) y el system prompt es el publicado en ai_prompt_versions; la fila persiste redactada", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED_ENV, fetchImpl: fakeFetch(captured, [(body) => json(200, anthropicText("Hola [NOMBRE_1], recepción le confirmará el parking. Un saludo.", String(body.model)))]) });
    const question = "Hola, soy Ludmila Ferreiro Castiñeira, mi DNI es 12345678Z, mi teléfono 612 345 678 y mi correo ludmila.ferreiro@example.org; pagué con la tarjeta 4111 1111 1111 1111. ¿Tienen parking?";
    const result = await runAiTool({ context: receptionCtx, toolName: "answerGuestQuestion", input: { guestQuestion: question, language: "es" }, correlationId: `corr_${RUN}_pii` });
    assert.equal(result.status, "executed", JSON.stringify(result));
    if (result.status !== "executed") return;
    assert.equal(captured.length, 1);
    const sent = JSON.stringify(captured[0]!.body.messages);
    for (const marker of ["[NOMBRE_1]", "[DOC_1]", "[TEL_1]", "[EMAIL_1]", "[TARJETA_1]"]) assert.ok(sent.includes(marker), `falta ${marker} en ${sent}`);
    for (const secret of ["Ludmila", "Ferreiro", "12345678Z", "612 345 678", "ludmila.ferreiro", "4111"]) assert.ok(!sent.includes(secret), `${secret} llegó al proveedor`);
    const system = String(captured[0]!.body.system ?? JSON.stringify(captured[0]!.body.system));
    assert.ok(system.startsWith(publishedGuestReplyPrompt), "el system prompt empieza por la versión publicada (v2) de ai_prompt_versions");
    const output = result.output as { text: string; model: string };
    assert.match(output.text, /Ludmila Ferreiro Castiñeira/, "el marcador se restaura en la respuesta");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: result.toolCallId } });
    assert.equal(row.status, "succeeded");
    assert.equal(row.model, "claude-sonnet-5");
    assert.equal(Number(row.costEur), 0.00063);
    const persisted = JSON.stringify(row.inputJson) + JSON.stringify(row.outputJson);
    for (const secret of ["Ludmila", "12345678Z", "612 345 678", "ludmila.ferreiro", "4111"]) assert.ok(!persisted.includes(secret), `${secret} persistido en ai_tool_calls`);
    note(`PII: marcadores [NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/[TARJETA_1] en el cuerpo, valores ausentes; system = ai_prompt_versions guest_message_reply v2 (${publishedGuestReplyPrompt.length} car.); fila succeeded redactada, cost_eur ${row.costEur}`);
  });

  it("prompts publicados: un código en borrador no sustituye al texto en código; al publicarlo, promptFrom lo devuelve (ai_prompt_versions)", async () => {
    const draft = await call("POST", "/ai-operations/governance/prompts/versions", generalManager, { propertyId: A.propertyA, payload: { promptCode: PROMPT_CODE_DRAFT, content: `Borrador ${RUN}`, notes: "integrador" } });
    assert.equal(draft.status, 200, draft.raw.slice(0, 200));
    assert.equal(draft.body.status, "draft");
    assert.equal(await getAiCore().promptFrom(PROMPT_CODE_DRAFT, "TEXTO_EN_CODIGO"), "TEXTO_EN_CODIGO");
    const toPublish = await call("POST", "/ai-operations/governance/prompts/versions", generalManager, { propertyId: A.propertyA, payload: { promptCode: PROMPT_CODE_PUB, content: `Publicado ${RUN}`, notes: "integrador" } });
    assert.equal(toPublish.status, 200, toPublish.raw.slice(0, 200));
    const forbidden = await call("POST", `/ai-operations/governance/prompts/versions/${toPublish.body.id}/publish`, generalManager, { propertyId: A.propertyA });
    assert.equal(forbidden.status, 403, "publicar exige administrador de plataforma (tabla global)");
    await publishPromptVersion(toPublish.body.id);
    assert.equal(await getAiCore().promptFrom(PROMPT_CODE_PUB, "TEXTO_EN_CODIGO"), `Publicado ${RUN}`);
    const versions = await call("GET", `/ai-operations/governance/prompts/${PROMPT_CODE_PUB}/versions`, generalManager, { propertyId: A.propertyA });
    assert.equal(versions.status, 200);
    assert.equal(versions.body[0].status, "published");
    note(`prompts: borrador → texto en código; publicado (servicio; la ruta exige admin de plataforma → 403 para dirección general) → promptFrom devuelve el contenido de ai_prompt_versions`);
  });
});

// ---------------------------------------------------------------------------
describe("3 · Cliente Anthropic con fetch simulado: tool use, salida estructurada, documento, reintento 429, coste", () => {
  const CTX = { organizationId: "org_l6a_integrador", toolName: "integrador", purpose: "complete" as const };
  const TOOLS = [{ name: "lookup_reservation", description: "Busca una reserva.", input_schema: { type: "object", additionalProperties: false, required: ["guest"], properties: { guest: { type: "string" } } } }];
  const SCHEMA = { type: "object", additionalProperties: false, required: ["total"], properties: { total: { type: "string" } } };

  it("tool use: tools[] y tool_choice en el cuerpo; tool_use → toolUses con la PII restaurada", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED_ENV, fetchImpl: fakeFetch(captured, [json(200, anthropicMessage([{ type: "text", text: "Consulto." }, { type: "tool_use", id: "toolu_1", name: "lookup_reservation", input: { guest: "[NOMBRE_1]" } }], "claude-sonnet-5", { input_tokens: 30, output_tokens: 20 }, "tool_use"))]) });
    const result = await getAiCore().complete({ system: "Eres recepcionista.", prompt: "Busca la reserva de la Sra. Ludmila Ferreiro." }, CTX, { tools: TOOLS, toolChoice: "auto" });
    assert.equal(result.configured, true);
    if (!result.configured) return;
    assert.deepEqual(captured[0]!.body.tools, TOOLS);
    assert.deepEqual(captured[0]!.body.tool_choice, { type: "auto" });
    assert.ok(!JSON.stringify(captured[0]!.body.messages).includes("Ludmila"));
    assert.equal(result.stopReason, "tool_use");
    assert.deepEqual(result.toolUses, [{ id: "toolu_1", name: "lookup_reservation", input: { guest: "Ludmila Ferreiro" } }]);
    assert.equal(captured[0]!.headers["anthropic-version"], "2023-06-01");
    assert.equal(captured[0]!.url, "https://api.anthropic.com/v1/messages");
    note("cliente tool use: tools[]/tool_choice enviados, stop_reason tool_use, toolUses con PII restaurada, cabecera anthropic-version 2023-06-01");
  });

  it("salida estructurada: output_config.format json_schema en el cuerpo; JSON válido → data; JSON inválido → AiError invalid_output con telemetría facturada", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED_ENV, fetchImpl: fakeFetch(captured, [json(200, anthropicText('{"total":"120,00"}', "claude-sonnet-5")), json(200, anthropicText("sin json", "claude-sonnet-5", { input_tokens: 40, output_tokens: 7 }))]) });
    const ok = await getAiCore().structured<{ total: string }>({ prompt: "Total de la factura", schema: SCHEMA }, CTX);
    assert.equal(ok.configured, true);
    if (!ok.configured) return;
    assert.deepEqual(captured[0]!.body.output_config, { format: { type: "json_schema", schema: SCHEMA } });
    assert.deepEqual(captured[0]!.body.thinking, { type: "disabled" }, "Sonnet 5 sin effort → thinking disabled");
    assert.equal(captured[0]!.body.temperature, undefined, "temperature nunca a Sonnet 5");
    assert.deepEqual(ok.data, { total: "120,00" });
    await assert.rejects(getAiCore().structured({ prompt: "Total", schema: SCHEMA }, CTX), (error: unknown) => {
      assert.ok(isAiError(error), String(error));
      assert.equal(error.code, "invalid_output");
      assert.equal(error.telemetry?.tokensInput, 40);
      return true;
    });
    note("cliente structured: output_config.format json_schema, thinking disabled y sin temperature en Sonnet 5; JSON inválido → invalid_output con telemetría (40 tokens)");
  });

  it("documento (PDF base64): bloque document en messages, telemetría {pages, bytes, sha256} sin bytes, coste calculado", async () => {
    const captured: Captured[] = [];
    const pdf = Buffer.from("%PDF-1.4\n<< /Type /Page >>\n<< /Type /Page >>\n%%EOF", "latin1").toString("base64");
    resetAiCoreForTests({ env: CONFIGURED_ENV, fetchImpl: fakeFetch(captured, [json(200, anthropicText('{"total":"88,00"}', "claude-sonnet-5", { input_tokens: 2000, output_tokens: 100 }))]) });
    const result = await getAiCore().extractFromDocument<{ total: string }>({ pdfBase64: pdf, schema: SCHEMA, instruction: "Extrae el total." }, { ...CTX, purpose: "extract" });
    assert.equal(result.configured, true);
    if (!result.configured) return;
    const content = (captured[0]!.body.messages as Array<{ content: Array<{ type: string; source?: { media_type: string } }> }>)[0]!.content;
    assert.equal(content[0]!.type, "document");
    assert.equal(content[0]!.source?.media_type, "application/pdf");
    assert.equal(content[1]!.type, "text");
    assert.equal(result.document.pages, 2);
    assert.ok(result.document.bytes > 0 && /^[0-9a-f]{64}$/.test(result.document.sha256));
    assert.ok(!JSON.stringify(result.document).includes(pdf.slice(0, 20)));
    assert.deepEqual(result.data, { total: "88,00" });
    // sonnet-5: 2000 × 2 $/M + 100 × 10 $/M = 0,005 $ → × 0,9 = 0,0045 €
    assert.equal(result.costUsd, 0.005);
    assert.equal(result.costEur, 0.0045);
    note(`cliente document: bloque document application/pdf, telemetría pages=${result.document.pages} bytes=${result.document.bytes} sha256 (sin bytes), costUsd ${result.costUsd} / costEur ${result.costEur}`);
  });

  it("reintentos: 429 con retry-after 1 → segundo intento y éxito (2 fetch); 500 → reintento; 400 → sin reintento y error tipado no reintentable", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({
      env: CONFIGURED_ENV,
      fetchImpl: fakeFetch(captured, [
        json(429, { type: "error", error: { type: "rate_limit_error", message: "simulado 429" } }, { "retry-after": "1" }),
        json(200, anthropicText("tras el 429", "claude-sonnet-5")),
        json(500, { type: "error", error: { type: "api_error", message: "simulado 500" } }),
        json(200, anthropicText("tras el 500", "claude-sonnet-5")),
        json(400, { type: "error", error: { type: "invalid_request_error", message: "simulado 400" } })
      ])
    });
    const started = Date.now();
    const first = await getAiCore().complete({ prompt: "hola" }, CTX, { maxTokens: 20 });
    assert.equal(first.configured && first.text, "tras el 429");
    assert.equal(captured.length, 2);
    assert.ok(Date.now() - started >= 900, "respetó retry-after (1 s)");
    const second = await getAiCore().complete({ prompt: "hola" }, CTX, { maxTokens: 20 });
    assert.equal(second.configured && second.text, "tras el 500");
    assert.equal(captured.length, 4);
    await assert.rejects(getAiCore().complete({ prompt: "hola" }, CTX, { maxTokens: 20 }), (error: unknown) => {
      assert.ok(isAiError(error), String(error));
      assert.equal(error.retryable, false);
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(captured.length, 5, "400 no se reintenta");
    note(`cliente reintentos: 429+retry-after → 2 fetch (${Date.now() - started} ms), 500 → reintento, 400 → 1 fetch y AiError no reintentable`);
  });

  it(`coste desde usage con la tabla fechada ${PRICING_TABLE_DATE}: Sonnet 5 con caché leída y tipo de cambio 0,9; modelo desconocido → null (nunca 0)`, async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED_ENV, fetchImpl: fakeFetch(captured, [json(200, anthropicText("ok", "claude-sonnet-5", { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }))]) });
    const result = await getAiCore().complete({ prompt: "hola" }, CTX, { maxTokens: 20 });
    assert.equal(result.configured, true);
    if (!result.configured) return;
    // (1000 × 2 + 500 × 2 × 0,1 + 200 × 10) / 1e6 = 0,0041 $ → × 0,9 = 0,00369 €
    assert.equal(result.costUsd, 0.0041);
    assert.equal(result.costEur, 0.00369);
    assert.equal(result.usage.cacheReadTokens, 500);
    assert.deepEqual(costFromUsage({ tokensInput: 10, tokensOutput: 10 }, "modelo-desconocido", 0.9), { usd: null, eur: null });
    assert.deepEqual(costFromUsage({ tokensInput: 0, tokensOutput: 0 }, "claude-sonnet-5", 0.9), { usd: 0, eur: 0 });
    note(`cliente coste: 1000/200 tokens + 500 caché leída en Sonnet 5 → costUsd ${result.costUsd} · costEur ${result.costEur}; modelo desconocido → null; sin tokens → 0`);
  });
});
