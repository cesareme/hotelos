/**
 * Tanda L6b · L6b-06 · asistente unificado por HTTP. app.inject sobre Postgres real con dos
 * organizaciones AISLADAS `org_l2_l6b*` (helpers/l2-tenant.mts): A pregunta y recuerda; B (otra
 * organización) nunca ve nada. STRICT_ENV: auth real, sin unión de permisos de demo,
 * RBAC_STRICT=true. Sin proveedor de IA el núcleo responde por reglas; el camino con modelo usa
 * un ai-core con fetch SIMULADO inyectado en el núcleo (resetAssistantCoreForTests), nunca red.
 *
 *   (1) catálogo por RBAC y superficie: recepción ve N herramientas y contabilidad otras; las
 *       sugeridas solo nombran herramientas visibles; superficie desconocida 400; sin sesión 401;
 *   (2) chat por reglas con citas (herramienta + fuente) y fila answerAnalyticsQuestion con
 *       model NULL, cost_eur 0 y conversation_id de assistant_conversations;
 *   (3) memoria privada: dos usuarios de la MISMA propiedad no se ven las conversaciones (lista,
 *       detalle, borrado) y el segundo turno reutiliza la conversación (memoria por HTTP);
 *   (4) 404 opaco entre propiedades (recepción de A sobre el hotel B) y organizaciones (B sobre A;
 *       conversación de A por id desde B; conversationId ajeno en el chat);
 *   (5) HITL: el modelo (simulado) propone createWorkOrder → awaiting_confirmation sin escribir;
 *       GET /assistant/pending la lista solo a quien preguntó (403 sin ai.tool.execute);
 *       POST /ai/tool-calls/:id/confirm la ejecuta (work_orders +1) y sale de pendientes.
 *   farandaInvariants idénticas antes y después; cleanupTenant de las dos organizaciones.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l6b-asistente.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { ROLE_TEMPLATE_LABELS_ES } = await import("@hotelos/shared");
const { createAiCore, resolveAiConfig } = await import("@hotelos/ai-core");
type AiCore = import("@hotelos/ai-core").AiCore;
const { applyRoleTemplate, templateRoleMetadata } = await import("../../apps/api/src/lib/rbac-catalog.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { ASSISTANT_TURN_TOOL_NAME, resetAssistantCoreForTests } = await import("../../apps/api/src/modules/assistant/assistant-core.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "DELETE";
type Reply = { status: number; body: any; raw: string };
type Captured = { body: Record<string, unknown> };

const RUN = `l6b${newRunId()}`;
const OPAQUE_PROPERTY = "Propiedad no encontrada.";
const OPAQUE_CONVERSATION = "Conversación no encontrada.";
const QUESTION_ARRIVALS = "¿Cuántas llegadas tengo hoy?";
const QUESTION_OCCUPANCY = "¿Cuál es la ocupación ahora mismo?";
const MODEL = "claude-sonnet-5";

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
let reception: Session;
let accountant: Session;
let maintenance: Session;
let auditor: Session;
let ownerB: Session;
let receptionB: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
/** Conversación de recepción (backoffice) abierta en la escena 2 y reutilizada en la 3 y la 4. */
let receptionConversationId = "";

async function call(method: Method, url: string, session: Session | null, options: { payload?: unknown; propertyId?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), ...(options.propertyId ? { "x-property-id": options.propertyId } : {}), ...(options.headers ?? {}) },
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

function expect404(reply: Reply, message: string): void {
  assert.equal(reply.status, 404, reply.raw.slice(0, 300));
  assert.equal(reply.body?.message, message);
}

/** 403 en español del gate con la clave que falta; nunca el de «ruta sin manifiesto». */
function expect403(reply: Reply, key: string): void {
  assert.equal(reply.status, 403, reply.raw.slice(0, 300));
  const message = String(reply.body?.message ?? "");
  assert.match(message, /^No tienes permiso para realizar esta acción/, message);
  assert.ok(message.includes(key), `la clave que falta (${key}) viaja en el mensaje: ${message}`);
  assert.doesNotMatch(message, /manifiesto/);
}

async function addTenantUser(tenant: IsolatedTenant, spec: { local: string; templateKey: string; propertyId?: string }): Promise<{ id: string; email: string }> {
  let roleId = tenant.roles[spec.templateKey];
  if (!roleId) {
    roleId = (
      await prisma.role.create({
        data: { organizationId: tenant.organizationId, name: ROLE_TEMPLATE_LABELS_ES[spec.templateKey as keyof typeof ROLE_TEMPLATE_LABELS_ES], templateKey: spec.templateKey, ...templateRoleMetadata(spec.templateKey as never) },
        select: { id: true }
      })
    ).id;
    await applyRoleTemplate(roleId, spec.templateKey as never);
    tenant.roles[spec.templateKey] = roleId;
  }
  const id = `usr_l2_${spec.local}_${tenant.run}`;
  const email = `${spec.local}.l2.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L6b ${spec.local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  await prisma.userRoleAssignment.create({
    data: { userId: id, roleId, scopeType: spec.propertyId ? "property" : "organization", propertyId: spec.propertyId ?? null, organizationId: tenant.organizationId, reason: `l6b-06 ${spec.local}` }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

// --- ai-core simulado (mismo formato que assistant-core.test.mts) ----------------------------

function anthropicMessage(content: unknown[], stopReason = "end_turn") {
  return { id: `msg_${RUN}`, type: "message", role: "assistant", model: MODEL, content, stop_reason: stopReason, usage: { input_tokens: 120, output_tokens: 40 } };
}
const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });

function configuredCore(responders: unknown[], captured: Captured[]): AiCore {
  return createAiCore({
    config: resolveAiConfig({ provider: "anthropic", apiKey: "sk-test-not-a-real-key", usdEurRate: "0.9" }),
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const next = responders.shift();
      if (!next) throw new Error("sin respuesta simulada");
      return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    sleep: async () => undefined
  });
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  B = await createIsolatedTenant(`${RUN}b`);
  const maintenanceUser = await addTenantUser(A, { local: "maintenance", templateKey: "maintenance", propertyId: A.propertyA });
  const auditorUser = await addTenantUser(A, { local: "auditor", templateKey: "auditor" });
  // createWorkOrder es del módulo maintenance (no activado por defecto en un hotel nuevo).
  await enableModules(A.propertyA, ["maintenance"]);
  await withEnv(STRICT_ENV, async () => {
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l6b-06-reception");
    accountant = await loginOrThrow(app, A.users.accountant.email, A.password, "l6b-06-accountant");
    maintenance = await loginOrThrow(app, maintenanceUser.email, A.password, "l6b-06-maintenance");
    auditor = await loginOrThrow(app, auditorUser.email, A.password, "l6b-06-auditor");
    ownerB = await loginOrThrow(app, B.users.owner.email, B.password, "l6b-06-owner-b");
    receptionB = await loginOrThrow(app, B.users.receptionist.email, B.password, "l6b-06-reception-b");
  });
});

after(async () => {
  resetAssistantCoreForTests();
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
describe("1 · GET /assistant/tools: catálogo por RBAC y superficie", () => {
  it("recepción ve N herramientas y contabilidad otras (las claves reales mandan); las sugeridas solo nombran herramientas visibles; ?surface= cambia la superficie y una desconocida es 400", async () => {
    const receptionTools = await call("GET", "/assistant/tools", reception, { propertyId: A.propertyA });
    assert.equal(receptionTools.status, 200, receptionTools.raw.slice(0, 300));
    assert.equal(receptionTools.body.surface, "backoffice");
    const receptionNames: string[] = receptionTools.body.items.map((item: { name: string }) => item.name);
    assert.ok(receptionNames.length >= 5, `recepción ve ${receptionNames.length} herramientas`);
    assert.ok(receptionTools.body.items.every((item: Record<string, unknown>) => typeof item.name === "string" && typeof item.description === "string" && Array.isArray(item.keywords) && typeof item.riskLevel === "string"));
    for (const expected of ["get_arrivals_today", "get_housekeeping_status", "get_open_balance"]) assert.ok(receptionNames.includes(expected), `recepción ve ${expected}`);

    const accountantTools = await call("GET", "/assistant/tools", accountant, { propertyId: A.propertyA });
    assert.equal(accountantTools.status, 200, accountantTools.raw.slice(0, 300));
    const accountantNames: string[] = accountantTools.body.items.map((item: { name: string }) => item.name);
    assert.ok(accountantNames.includes("get_open_balance"), "contabilidad lee folios");
    assert.ok(!accountantNames.includes("get_housekeeping_status"), "contabilidad no tiene housekeeping.read");
    assert.notDeepEqual([...receptionNames].sort(), [...accountantNames].sort(), "catálogos distintos por plantilla");

    for (const reply of [receptionTools, accountantTools]) {
      const visible = new Set(reply.body.items.map((item: { name: string }) => item.name));
      assert.ok(Array.isArray(reply.body.suggestedQuestions) && reply.body.suggestedQuestions.length > 0);
      assert.ok(reply.body.suggestedQuestions.every((suggestion: { tool: string }) => visible.has(suggestion.tool)), "nunca se sugiere lo que no puede responder");
    }
    assert.ok(!accountantTools.body.suggestedQuestions.some((suggestion: { tool: string }) => suggestion.tool === "get_housekeeping_status"));

    const receptionSurface = await call("GET", "/assistant/tools?surface=reception", reception, { propertyId: A.propertyA });
    assert.equal(receptionSurface.status, 200, receptionSurface.raw.slice(0, 300));
    assert.equal(receptionSurface.body.surface, "reception");
    assert.ok(String(receptionSurface.body.suggestedQuestions[0]?.id).startsWith("copilot_"), "en recepción van primero los presets del copiloto");
    const unknown = await call("GET", "/assistant/tools?surface=cocina", reception, { propertyId: A.propertyA });
    assert.equal(unknown.status, 400, unknown.raw.slice(0, 300));
    assert.match(String(unknown.body.message), /Superficie desconocida/);
  });

  it("sin sesión → 401 en las cinco rutas (authenticated / ai.tool.execute, sin fallback demo en modo estricto)", async () => {
    for (const [method, url] of [["GET", "/assistant/tools"], ["POST", "/assistant/chat"], ["GET", "/assistant/conversations"], ["GET", "/assistant/conversations/conv_x"], ["GET", "/assistant/pending"]] as const) {
      const anonymous = await call(method, url, null, method === "POST" ? { payload: { question: "hola" } } : {});
      assert.equal(anonymous.status, 401, `${method} ${url}: ${anonymous.raw.slice(0, 200)}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("2 · POST /assistant/chat por reglas: citas y fila answerAnalyticsQuestion", () => {
  it("recepción pregunta por las llegadas → deterministic / rules, cita con herramienta y fuente, coste 0; fila answerAnalyticsQuestion succeeded con model NULL, cost_eur 0 y conversation_id; conversación y 2 mensajes en Prisma", async () => {
    const chat = await call("POST", "/assistant/chat", reception, { propertyId: A.propertyA, payload: { question: QUESTION_ARRIVALS } });
    assert.equal(chat.status, 200, chat.raw.slice(0, 300));
    const turn = chat.body;
    assert.equal(turn.mode, "deterministic");
    assert.equal(turn.routedBy, "rules");
    assert.equal(turn.surface, "backoffice", "superficie por defecto");
    assert.equal(typeof turn.conversationId, "string");
    assert.equal(typeof turn.answer, "string");
    assert.ok(!JSON.stringify(turn).includes('"llm"'), "nunca se anuncia un modelo sin proveedor");
    assert.equal(turn.citations.length, 1, JSON.stringify(turn.citations));
    assert.equal(turn.citations[0].tool, "get_arrivals_today");
    assert.ok(typeof turn.citations[0].source === "string" && turn.citations[0].source.length > 0, "la cita lleva la fuente");
    assert.equal(turn.citations[0].ok, true);
    assert.equal(turn.citations[0].costEur, 0);
    assert.deepEqual(turn.toolCalls.map((item: { name: string }) => item.name), ["get_arrivals_today"]);
    assert.deepEqual(turn.cost, { model: null, tokensInput: 0, tokensOutput: 0, eur: 0 });
    assert.deepEqual(turn.pendingToolCalls, []);
    receptionConversationId = turn.conversationId;

    const rows = await prisma.aiToolCall.findMany({ where: { organizationId: A.organizationId, toolName: ASSISTANT_TURN_TOOL_NAME } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "succeeded");
    assert.equal(rows[0]!.model, null, "sin modelo por reglas");
    assert.equal(Number(rows[0]!.costEur), 0, "AI-CORE §6: sin llamada → cost_eur 0");
    assert.equal(rows[0]!.tokensInput, 0);
    assert.equal(rows[0]!.conversationId, receptionConversationId, "ai_tool_calls.conversation_id = assistant_conversations.id");
    assert.equal(rows[0]!.userId, reception.userId);
    assert.equal(rows[0]!.propertyId, A.propertyA);

    const conversation = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: receptionConversationId } });
    assert.equal(conversation.organizationId, A.organizationId);
    assert.equal(conversation.propertyId, A.propertyA);
    assert.equal(conversation.userId, reception.userId);
    assert.equal(conversation.surface, "backoffice");
    assert.equal(conversation.title, QUESTION_ARRIVALS);
    assert.equal(await prisma.assistantMessage.count({ where: { conversationId: receptionConversationId } }), 2);
  });

  it("surface explícita (reception) y pregunta vacía: la primera abre otra conversación con esa superficie, la segunda es 400 sin fila", async () => {
    const before = await prisma.aiToolCall.count({ where: { organizationId: A.organizationId } });
    const chat = await call("POST", "/assistant/chat", reception, { propertyId: A.propertyA, payload: { question: QUESTION_OCCUPANCY, surface: "reception", screen: { screenKey: "FrontDesk", url: "/recepcion/mi-dia" } } });
    assert.equal(chat.status, 200, chat.raw.slice(0, 300));
    assert.equal(chat.body.surface, "reception");
    assert.notEqual(chat.body.conversationId, receptionConversationId);
    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.body.conversationId } });
    assert.equal(row.surface, "reception");
    assert.deepEqual(row.screenContextJson, { screenKey: "FrontDesk", url: "/recepcion/mi-dia" });

    const empty = await call("POST", "/assistant/chat", reception, { propertyId: A.propertyA, payload: { question: "   " } });
    assert.equal(empty.status, 400, empty.raw.slice(0, 300));
    assert.equal(empty.body.message, "La pregunta no puede estar vacía.");
    assert.equal(await prisma.aiToolCall.count({ where: { organizationId: A.organizationId } }), before + 1, "el 400 no escribe telemetría");
  });
});

// ---------------------------------------------------------------------------
describe("3 · memoria privada entre dos usuarios de la misma propiedad", () => {
  it("el segundo turno con conversationId reutiliza la conversación (4 mensajes); la lista y el detalle son del propio usuario; contabilidad (misma propiedad) no la lista, no la lee ni la borra (404 opaco)", async () => {
    const second = await call("POST", "/assistant/chat", reception, { propertyId: A.propertyA, payload: { question: QUESTION_OCCUPANCY, conversationId: receptionConversationId } });
    assert.equal(second.status, 200, second.raw.slice(0, 300));
    assert.equal(second.body.conversationId, receptionConversationId, "memoria por HTTP: misma conversación");
    assert.equal(second.body.citations[0]?.tool, "get_occupancy_today");
    assert.equal(await prisma.assistantMessage.count({ where: { conversationId: receptionConversationId } }), 4);

    const list = await call("GET", "/assistant/conversations", reception, { propertyId: A.propertyA });
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    const ids = list.body.items.map((item: { id: string }) => item.id);
    assert.ok(ids.includes(receptionConversationId), "la lista incluye la conversación del usuario");
    assert.equal(list.body.items.length, 2, "las dos de recepción (backoffice + reception)");
    const summary = list.body.items.find((item: { id: string }) => item.id === receptionConversationId);
    assert.equal(summary.title, QUESTION_ARRIVALS);
    assert.equal(summary.messageCount, 4);
    assert.equal(summary.surface, "backoffice");
    const onlyReception = await call("GET", "/assistant/conversations?surface=reception", reception, { propertyId: A.propertyA });
    assert.equal(onlyReception.body.items.length, 1);
    assert.equal(onlyReception.body.items[0].surface, "reception");

    const detail = await call("GET", `/assistant/conversations/${receptionConversationId}`, reception, { propertyId: A.propertyA });
    assert.equal(detail.status, 200, detail.raw.slice(0, 300));
    assert.equal(detail.body.id, receptionConversationId);
    assert.equal(detail.body.messages.length, 4);
    assert.deepEqual(detail.body.messages.map((message: { role: string }) => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(detail.body.messages[0].content, QUESTION_ARRIVALS);
    assert.equal(detail.body.messages[1].routedBy, "rules");
    assert.equal(detail.body.messages[1].toolCalls[0].tool, "get_arrivals_today");
    assert.equal(detail.body.messages[1].cost.eur, 0);
    assert.equal(detail.body.messages[1].cost.model, null);
    assert.equal(detail.body.messages[0].cost, null);

    const accountantList = await call("GET", "/assistant/conversations", accountant, { propertyId: A.propertyA });
    assert.equal(accountantList.status, 200, accountantList.raw.slice(0, 300));
    assert.deepEqual(accountantList.body.items, [], "contabilidad no ve las conversaciones de recepción");
    expect404(await call("GET", `/assistant/conversations/${receptionConversationId}`, accountant, { propertyId: A.propertyA }), OPAQUE_CONVERSATION);
    expect404(await call("DELETE", `/assistant/conversations/${receptionConversationId}`, accountant, { propertyId: A.propertyA }), OPAQUE_CONVERSATION);
    assert.equal(await prisma.assistantMessage.count({ where: { conversationId: receptionConversationId } }), 4, "el 404 no borra nada");
  });

  it("DELETE propio → 204 y los mensajes caen en cascada; después el detalle es 404 y la lista ya no la trae", async () => {
    const list = await call("GET", "/assistant/conversations?surface=reception", reception, { propertyId: A.propertyA });
    const receptionSurfaceId = list.body.items[0].id as string;
    assert.ok(await prisma.assistantMessage.count({ where: { conversationId: receptionSurfaceId } }) > 0);
    const deleted = await call("DELETE", `/assistant/conversations/${receptionSurfaceId}`, reception, { propertyId: A.propertyA });
    assert.equal(deleted.status, 204, deleted.raw.slice(0, 300));
    assert.equal(deleted.raw, "");
    assert.equal(await prisma.assistantConversation.count({ where: { id: receptionSurfaceId } }), 0);
    assert.equal(await prisma.assistantMessage.count({ where: { conversationId: receptionSurfaceId } }), 0, "FK ON DELETE CASCADE");
    expect404(await call("GET", `/assistant/conversations/${receptionSurfaceId}`, reception, { propertyId: A.propertyA }), OPAQUE_CONVERSATION);
    const after = await call("GET", "/assistant/conversations", reception, { propertyId: A.propertyA });
    assert.deepEqual(after.body.items.map((item: { id: string }) => item.id), [receptionConversationId]);
  });
});

// ---------------------------------------------------------------------------
describe("4 · 404 opaco entre propiedades y organizaciones", () => {
  it("recepción de A sobre el hotel B, organización B sobre A y conversación de A por id desde B: siempre el mismo 404 sin oráculo", async () => {
    expect404(await call("POST", "/assistant/chat", reception, { propertyId: A.propertyB, payload: { question: QUESTION_ARRIVALS } }), OPAQUE_PROPERTY);
    expect404(await call("GET", "/assistant/conversations", reception, { propertyId: A.propertyB }), OPAQUE_PROPERTY);
    expect404(await call("GET", "/assistant/pending", reception, { propertyId: A.propertyB }), OPAQUE_PROPERTY);
    expect404(await call("POST", "/assistant/chat", receptionB, { propertyId: A.propertyA, payload: { question: QUESTION_ARRIVALS } }), OPAQUE_PROPERTY);
    expect404(await call("GET", "/assistant/tools", ownerB, { propertyId: A.propertyA }), OPAQUE_PROPERTY);
    expect404(await call("GET", `/assistant/conversations/${receptionConversationId}`, ownerB, { propertyId: B.propertyA }), OPAQUE_CONVERSATION);
    expect404(await call("DELETE", `/assistant/conversations/${receptionConversationId}`, ownerB, { propertyId: B.propertyA }), OPAQUE_CONVERSATION);
    // conversationId ajeno en el chat: ni se abre ni se responde, ni desde B ni desde otro usuario de A.
    expect404(await call("POST", "/assistant/chat", ownerB, { propertyId: B.propertyA, payload: { question: QUESTION_ARRIVALS, conversationId: receptionConversationId } }), OPAQUE_CONVERSATION);
    expect404(await call("POST", "/assistant/chat", accountant, { propertyId: A.propertyA, payload: { question: QUESTION_ARRIVALS, conversationId: receptionConversationId } }), OPAQUE_CONVERSATION);
    expect404(await call("POST", "/assistant/chat", reception, { propertyId: A.propertyA, payload: { question: QUESTION_ARRIVALS, conversationId: `conv_no_existe_${RUN}` } }), OPAQUE_CONVERSATION);
    assert.equal(await prisma.assistantMessage.count({ where: { conversationId: receptionConversationId } }), 4, "nada se añadió a la conversación ajena");
    assert.equal(await prisma.assistantConversation.count({ where: { organizationId: B.organizationId } }), 0, "B no abrió ninguna conversación");
    assert.equal(await prisma.aiToolCall.count({ where: { organizationId: B.organizationId } }), 0, "B no escribió telemetría");
  });
});

// ---------------------------------------------------------------------------
describe("5 · HITL por HTTP: el modelo propone una escritura, pending la lista y confirm la ejecuta", () => {
  let pendingId = "";
  let maintenanceConversationId = "";
  let workOrdersBefore = 0;

  it("mantenimiento pregunta con el modelo (simulado) → createWorkOrder queda awaiting_confirmation sin escribir; el turno es llm / model con coste real y pendingToolCalls[0]", async () => {
    workOrdersBefore = await prisma.workOrder.count({ where: { propertyId: A.propertyA } });
    const captured: Captured[] = [];
    const title = `Grifo que gotea ${RUN}`;
    const core = configuredCore(
      [
        anthropicMessage([text("Abro un parte de mantenimiento."), toolUse("toolu_wo", "createWorkOrder", { title, roomNumber: "101", priority: "normal", blocksRoom: false })], "tool_use"),
        anthropicMessage([text("He dejado el parte propuesto; una persona debe confirmarlo.")])
      ],
      captured
    );
    resetAssistantCoreForTests({ getAiCore: () => core });
    let chat: Reply;
    try {
      chat = await call("POST", "/assistant/chat", maintenance, { propertyId: A.propertyA, payload: { question: "Abre un parte por el grifo que gotea de la 101" } });
    } finally {
      resetAssistantCoreForTests();
    }
    assert.equal(chat.status, 200, chat.raw.slice(0, 400));
    assert.equal(chat.body.mode, "llm");
    assert.equal(chat.body.routedBy, "model");
    assert.equal(chat.body.cost.model, MODEL);
    assert.ok(chat.body.cost.tokensInput > 0 && chat.body.cost.eur > 0, JSON.stringify(chat.body.cost));
    assert.equal(chat.body.pendingToolCalls.length, 1, JSON.stringify(chat.body.pendingToolCalls));
    const proposed = chat.body.pendingToolCalls[0];
    assert.equal(proposed.toolName, "createWorkOrder");
    assert.equal(proposed.riskLevel, "low");
    assert.equal(proposed.conversationId, chat.body.conversationId);
    assert.equal(proposed.input.title, title);
    assert.deepEqual(chat.body.citations, [], "una propuesta pendiente no es una cita");
    pendingId = proposed.id;
    maintenanceConversationId = chat.body.conversationId;
    assert.equal(captured.length, 2, "dos llamadas al modelo: tool_use y cierre");
    const offered = (captured[0]!.body.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(offered.includes("createWorkOrder"), `el modelo recibe la escritura que el usuario puede confirmar: ${offered.join(", ")}`);
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), workOrdersBefore, "nada se ejecuta sin confirmar");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: pendingId } });
    assert.equal(row.status, "awaiting_confirmation");
    assert.equal(row.confirmedBy, null);
    assert.equal(row.conversationId, maintenanceConversationId);
    assert.equal(row.userId, maintenance.userId);
    assert.equal(row.propertyId, A.propertyA);
    const turnRow = await prisma.aiToolCall.findFirstOrThrow({ where: { organizationId: A.organizationId, toolName: ASSISTANT_TURN_TOOL_NAME, userId: maintenance.userId } });
    assert.equal(turnRow.model, MODEL, "con modelo la fila answerAnalyticsQuestion lleva el modelo real");
    assert.ok(Number(turnRow.costEur) > 0);
  });

  it("GET /assistant/pending la lista solo a quien preguntó (recepción ve [], auditoría 403 ai.tool.execute), redactada y con conversationId", async () => {
    assert.ok(pendingId, "la escena anterior dejó una propuesta");
    const mine = await call("GET", "/assistant/pending", maintenance, { propertyId: A.propertyA });
    assert.equal(mine.status, 200, mine.raw.slice(0, 300));
    assert.equal(mine.body.items.length, 1, JSON.stringify(mine.body));
    const item = mine.body.items[0];
    assert.equal(item.id, pendingId);
    assert.equal(item.toolName, "createWorkOrder");
    assert.equal(item.riskLevel, "low");
    assert.match(String(item.summary), /parte de mantenimiento/i);
    assert.equal(item.conversationId, maintenanceConversationId);
    assert.equal(item.correlationId, null);
    assert.equal(typeof item.createdAt, "string");
    assert.equal(item.input.title, `Grifo que gotea ${RUN}`);
    assert.equal(item.input.priority, "normal");
    const other = await call("GET", "/assistant/pending", reception, { propertyId: A.propertyA });
    assert.equal(other.status, 200, other.raw.slice(0, 300));
    assert.deepEqual(other.body.items, [], "la propuesta no salió de una conversación de recepción");
    expect403(await call("GET", "/assistant/pending", auditor, { propertyId: A.propertyA }), "ai.tool.execute");
  });

  it("POST /ai/tool-calls/:id/confirm (approve) la ejecuta: work_orders +1, fila succeeded con confirmed_by; desaparece de pending; segunda confirmación → 404 opaco; la memoria guarda el turno con modelo", async () => {
    assert.ok(pendingId);
    const confirmed = await call("POST", `/ai/tool-calls/${pendingId}/confirm`, maintenance, { propertyId: A.propertyA, payload: { decision: "approve", notes: "Confirmado desde el asistente" } });
    assert.equal(confirmed.status, 200, confirmed.raw.slice(0, 400));
    assert.equal(confirmed.body.status, "succeeded", confirmed.raw.slice(0, 400));
    assert.equal(confirmed.body.toolCallId, pendingId);
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), workOrdersBefore + 1, "la confirmación ejecuta la escritura");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: pendingId } });
    assert.equal(row.status, "succeeded");
    assert.equal(row.confirmedBy, maintenance.userId);
    const after = await call("GET", "/assistant/pending", maintenance, { propertyId: A.propertyA });
    assert.deepEqual(after.body.items, []);
    expect404(await call("POST", `/ai/tool-calls/${pendingId}/confirm`, maintenance, { propertyId: A.propertyA, payload: { decision: "approve" } }), "Llamada de herramienta no encontrada.");

    const detail = await call("GET", `/assistant/conversations/${maintenanceConversationId}`, maintenance, { propertyId: A.propertyA });
    assert.equal(detail.status, 200, detail.raw.slice(0, 300));
    assert.equal(detail.body.messages.length, 2);
    assert.equal(detail.body.messages[1].routedBy, "model");
    assert.equal(detail.body.messages[1].cost.model, MODEL);
    assert.ok(detail.body.messages[1].cost.eur > 0);
  });
});
