/**
 * Tanda L6a · lote 4 · integración (Postgres): llamadores honestos SIN clave de
 * proveedor. app.inject sobre una organización AISLADA (helpers/l2-tenant.mts),
 * auth real y RBAC_STRICT; Faranda y org_123 solo se leen (invariantes).
 *
 *   · POST /ai/commands/scan-id-document → configured:false, source manual,
 *     mensaje «introduzca los datos manualmente», fila scan_id_document `skipped`
 *     (válido con el handler actual de server.ts y con scanIdDocumentCommand);
 *   · POST /conversations/:id/ai-draft → source rules; fila guest_message_reply
 *     registrada por el runner con model null y cost_eur 0; auditoría actor_type ai;
 *     conversación con aiEnabled=false → rules sin fila nueva;
 *   · GET /compliance/properties/:id/assistant → narrativeSource rules, provider none;
 *   · POST /properties/:id/reservations/ai-parse → source rules | none;
 *   · POST /properties/:id/mapper/extract → source none | rules;
 *   · POST /ai-operations/governance/evaluations/:id/run → skipped con motivo;
 *   · GET /ai-operations/property/readiness → check provider `warn` y budget;
 *   · POST /assistant/chat → mode deterministic y fila answerAnalyticsQuestion;
 *   · GET /ai-operations/pipeline/dashboard → costMtdEur 0; GET …/governance/cost →
 *     hasRealCost false y projectedMonthlyEur null.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l6a-llamadores-honestos.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { isLlmConfigured } = await import("../../apps/api/src/lib/llm.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `l6a${newRunId()}`;
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let app: ApiApp;
let A: IsolatedTenant;
let owner: Session;
/** Plantilla «Administración de sistema» (T8a): ai_evals.manage para crear y lanzar evaluaciones. */
let systems: Session;
let reception: Session;

/** La telemetría del asistente se inserta sin await (patrón messaging L2): espera a la fila. */
async function waitForRows(where: Parameters<typeof prisma.aiToolCall.findMany>[0] extends { where?: infer W } ? W : never, minimum: number, timeoutMs = 3_000): Promise<Awaited<ReturnType<typeof prisma.aiToolCall.findMany>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.aiToolCall.findMany({ where });
    if (rows.length >= minimum || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
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
  return { status: res.statusCode, body, raw: res.body };
}

before(async () => {
  assert.equal(isLlmConfigured(), false, "esta suite exige que NO haya clave de proveedor en el .env (fallback honesto)");
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  // ai_concierge no está en DEFAULT_ENABLED_MODULE_CODES: sin activarlo el runner
  // denegaría answerGuestQuestion por módulo (también honesto, pero aquí se prueba
  // el camino «sin modelo configurado» → fila completed sin coste).
  await enableModules(A.propertyA, ["ai_concierge"]);
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, A.users.owner.email, A.password, "l6a-honest-owner");
    systems = await loginOrThrow(app, A.users.systems.email, A.password, "l6a-honest-systems");
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l6a-honest-reception");
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
  } finally {
    await app?.close();
  }
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  assert.equal(await prisma.organization.count({ where: { id: A.organizationId } }), 0, "sin organización residual de esta suite");
});

describe("L6a-4 · comandos de IA sin proveedor: respuesta por reglas con la misma forma y telemetría honesta", () => {
  it("POST /ai/commands/scan-id-document → configured:false, source manual, mensaje en español y fila scan_id_document `skipped`", async () => {
    const scanned = await call("POST", "/ai/commands/scan-id-document", reception, { propertyId: A.propertyA, payload: { imageDataUrl: TINY_PNG } });
    assert.equal(scanned.status, 200, scanned.raw.slice(0, 300));
    assert.equal(scanned.body.configured, false);
    assert.equal(scanned.body.source, "manual");
    assert.deepEqual(scanned.body.fields, {});
    assert.match(String(scanned.body.message), /introduzca los datos manualmente/i);
    const rows = await prisma.aiToolCall.findMany({ where: { organizationId: A.organizationId, toolName: "scan_id_document" } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "skipped");
    assert.equal(rows[0]!.propertyId, A.propertyA);
    assert.equal(rows[0]!.userId, reception.userId);
    assert.equal(rows[0]!.model, null);
    assert.ok(!JSON.stringify(rows[0]!.inputJson).includes("base64,"), "la imagen nunca se persiste");
  });

  it("POST /conversations/:id/ai-draft → source rules; fila guest_message_reply del runner (model null, cost_eur 0) y auditoría actor_type ai; conversación con IA apagada → rules sin fila", async () => {
    const conversation = await prisma.conversation.create({ data: { propertyId: A.propertyA, channel: "web_chat", status: "open", aiEnabled: true }, select: { id: true } });
    const reply = await call("POST", `/conversations/${conversation.id}/ai-draft`, reception, { propertyId: A.propertyA, payload: { guestQuestion: "¿Tienen parking en el hotel?", language: "es" } });
    assert.equal(reply.status, 200, reply.raw.slice(0, 300));
    assert.deepEqual(Object.keys(reply.body).sort(), ["disclosure", "draft", "requiresHumanReview", "source"]);
    assert.equal(reply.body.source, "rules");
    assert.equal(reply.body.requiresHumanReview, false);
    assert.match(String(reply.body.draft), /parking/i);
    assert.ok(String(reply.body.draft).startsWith(reply.body.disclosure));

    const rows = await prisma.aiToolCall.findMany({ where: { organizationId: A.organizationId, toolName: "guest_message_reply" } });
    assert.equal(rows.length, 1, "el runner registra la fila una sola vez");
    const row = rows[0]!;
    assert.equal(row.status, "completed", "vocabulario legado: sin modelo → completed");
    assert.equal(row.model, null);
    assert.equal(Number(row.costEur), 0);
    assert.equal(row.tokensInput, 0);
    assert.equal(row.conversationId, conversation.id);
    assert.equal(row.userId, reception.userId);
    assert.equal(row.errorMessage, "not_configured");

    await flushAuditQueues();
    const audits = await prisma.auditEvent.findMany({ where: { organizationId: A.organizationId, actorType: "ai" }, select: { action: true, entityType: true, entityId: true } });
    assert.ok(audits.some((event) => event.action === "AI_GUEST_REPLY_DRAFTED" && event.entityId === conversation.id), "AI_GUEST_REPLY_DRAFTED con actor ai");
    assert.ok(audits.some((event) => event.action === "AI_TOOL_EXECUTED" && event.entityType === "ai_tool_call" && event.entityId === row.id), "AI_TOOL_EXECUTED del runner con actor ai");

    const muted = await prisma.conversation.create({ data: { propertyId: A.propertyA, channel: "web_chat", status: "open", aiEnabled: false }, select: { id: true } });
    const mutedReply = await call("POST", `/conversations/${muted.id}/ai-draft`, reception, { propertyId: A.propertyA, payload: { guestQuestion: "¿A qué hora es el desayuno?" } });
    assert.equal(mutedReply.status, 200, mutedReply.raw.slice(0, 300));
    assert.equal(mutedReply.body.source, "rules");
    assert.equal(await prisma.aiToolCall.count({ where: { organizationId: A.organizationId, toolName: "guest_message_reply" } }), 1, "IA apagada en la conversación: ni modelo ni fila");

    const complaint = await call("POST", `/conversations/${conversation.id}/ai-draft`, reception, { propertyId: A.propertyA, payload: { guestQuestion: "Quiero un reembolso, es urgente." } });
    assert.equal(complaint.status, 200, complaint.raw.slice(0, 300));
    assert.equal(complaint.body.requiresHumanReview, true, "la regex de traspaso a una persona se conserva");
  });

  it("GET /compliance/properties/:id/assistant → narrativeSource rules y provider none", async () => {
    const compliance = await call("GET", `/compliance/properties/${A.propertyA}/assistant`, reception);
    assert.equal(compliance.status, 200, compliance.raw.slice(0, 300));
    assert.equal(compliance.body.propertyId, A.propertyA);
    assert.equal(compliance.body.narrativeSource, "rules");
    assert.equal(compliance.body.provider, "none");
    assert.equal(typeof compliance.body.narrative, "string");
    assert.ok(Array.isArray(compliance.body.suggestions));
  });

  it("POST /properties/:id/reservations/ai-parse → source rules | none; POST /properties/:id/mapper/extract → source none | rules con mensaje honesto", async () => {
    const parsed = await call("POST", `/properties/${A.propertyA}/reservations/ai-parse`, reception, { propertyId: A.propertyA, payload: { text: "habitación doble para 2 adultos, 3 noches desde el viernes, a nombre de Prueba Ensayo" } });
    assert.equal(parsed.status, 200, parsed.raw.slice(0, 300));
    assert.ok(["rules", "none"].includes(parsed.body.source), parsed.raw.slice(0, 200));
    assert.notEqual(parsed.body.modelVersion, undefined);
    assert.ok(!String(parsed.body.modelVersion).startsWith("ai-"));

    const mapped = await call("POST", `/properties/${A.propertyA}/mapper/extract`, reception, { propertyId: A.propertyA, payload: { files: [{ name: "plano.txt", mimeType: "text/plain", text: "El hotel tiene recepción, un spa y varias plantas con vistas." }] } });
    assert.equal(mapped.status, 200, mapped.raw.slice(0, 300));
    assert.ok(["none", "rules"].includes(mapped.body.source), mapped.raw.slice(0, 200));
    if (mapped.body.source === "none") assert.match(String(mapped.body.message), /Configure an AI provider|No room data|configured AI vision provider/);
    assert.equal(await prisma.aiToolCall.count({ where: { organizationId: A.organizationId, toolName: { in: ["parseReservationRequest", "extractPropertyMap"] } } }), 0, "sin clave no se pasa por el runner: ninguna fila");
  });

  it("POST /ai-operations/governance/evaluations/:id/run → skipped con el motivo «No hay proveedor de IA configurado»", async () => {
    const created = await call("POST", "/ai-operations/governance/evaluations", systems, { propertyId: A.propertyA, payload: { evaluationName: `Seguridad ${RUN}`, evaluationType: "safety", promptCode: "guest_message_reply" } });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    assert.equal(created.body.status, "pending");
    const ran = await call("POST", `/ai-operations/governance/evaluations/${created.body.id}/run`, systems, { propertyId: A.propertyA });
    assert.equal(ran.status, 200, ran.raw.slice(0, 300));
    assert.equal(ran.body.status, "skipped");
    assert.equal(ran.body.results.ran, false);
    assert.match(String(ran.body.results.reason), /No hay proveedor de IA configurado/);
    assert.equal(ran.body.score, undefined);
  });

  it("GET /ai-operations/property/readiness → seis checks; provider `warn` sin clave y budget `ok` con el presupuesto por defecto", async () => {
    const readiness = await call("GET", `/ai-operations/property/readiness?propertyId=${A.propertyA}`, owner, { propertyId: A.propertyA });
    assert.equal(readiness.status, 200, readiness.raw.slice(0, 300));
    assert.equal(readiness.body.propertyId, A.propertyA);
    const keys = readiness.body.checks.map((check: { key: string }) => check.key);
    assert.deepEqual(keys, ["enabled", "disclosure", "voice_locales", "automation_level", "provider", "budget"]);
    const provider = readiness.body.checks.find((check: { key: string }) => check.key === "provider");
    assert.equal(provider.status, "warn");
    assert.match(provider.detail, /Sin modelo configurado/);
    const budget = readiness.body.checks.find((check: { key: string }) => check.key === "budget");
    assert.equal(budget.status, "ok");
    assert.match(budget.detail, /^Presupuesto mensual: .+ € \(gastado 0,00 €\)\.$/);
    assert.equal(readiness.body.ready, false, "sin modelo la propiedad no está lista para IA con modelo");
  });

  it("POST /assistant/chat → mode deterministic y fila answerAnalyticsQuestion", async () => {
    const chat = await call("POST", "/assistant/chat", reception, { propertyId: A.propertyA, payload: { question: "¿cuántas llegadas tengo hoy?" } });
    assert.equal(chat.status, 200, chat.raw.slice(0, 300));
    assert.equal(chat.body.mode, "deterministic");
    assert.equal(typeof chat.body.answer, "string");
    const rows = await waitForRows({ organizationId: A.organizationId, toolName: "answerAnalyticsQuestion" }, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.propertyId, A.propertyA);
    assert.equal(rows[0]!.status, "succeeded");
  });

  it("GET /ai-operations/pipeline/dashboard → costMtdEur 0; GET /ai-operations/governance/cost → hasRealCost false, projectedMonthlyEur null y budgetDefaultEur", async () => {
    const pipeline = await call("GET", `/ai-operations/pipeline/dashboard?propertyId=${A.propertyA}`, owner, { propertyId: A.propertyA });
    assert.equal(pipeline.status, 200, pipeline.raw.slice(0, 300));
    assert.equal(pipeline.body.kpis.costMtdEur, 0);
    assert.ok(pipeline.body.kpis.callsTotal >= 3, "scan + borrador + asistente");
    assert.ok(pipeline.body.recentCalls.every((row: { costEur: number | null }) => row.costEur === 0 || row.costEur === null), "ningún coste fabricado");

    const cost = await call("GET", "/ai-operations/governance/cost", owner, { propertyId: A.propertyA });
    assert.equal(cost.status, 200, cost.raw.slice(0, 300));
    assert.equal(cost.body.hasRealCost, false);
    assert.equal(cost.body.projectedMonthlyEur, null, "sin coste real no hay proyección");
    assert.equal(cost.body.totalCostEur, 0);
    assert.equal(typeof cost.body.budgetDefaultEur, "number");
    assert.ok(cost.body.budgetDefaultEur >= 0);
  });
});
